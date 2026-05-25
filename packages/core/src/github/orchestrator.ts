/**
 * Sync orchestrator — glues syncStars + store + cursor into a single call.
 *
 * The popup / Obsidian command / chrome.alarms cron all want the same thing:
 *
 *   "Pull the latest stars, persist them, remember the etag for next time,
 *    tell me what changed."
 *
 * That's this function. Storage backings (IndexedDB or sqlite-vec or memory)
 * are passed in — orchestrator stays storage-agnostic.
 */
import type { SyncCursor, StarredRepo } from '../schema.js';
import type {
  CursorStore,
  StarStore,
} from '../storage/types.js';
import type { StarKitOctokitInstance } from './client.js';
import { syncStars, type SyncStarsResult } from './sync.js';

/**
 * How often we force a full sync — re-fetch the entire /user/starred list
 * AND run the un-star cleanup pass. Between full syncs we use the cursor's
 * `since` for an incremental short-circuit (cheap, but cannot detect
 * un-stars). Seven days is a tradeoff: stale un-starred rows linger up
 * to a week, but background traffic stays minimal.
 */
const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type SyncMode = 'full' | 'incremental';

export interface SyncWithStoreOptions {
  readonly perPage?: number;
  readonly signal?: AbortSignal;
  /**
   * Force a full sync (fetch the whole list + run un-star cleanup) even
   * when the last full sync was recent. Used by:
   *   - the "Refresh un-stars now" UX (let the user pull a manual full
   *     re-sync when they know they un-starred something),
   *   - tests that need deterministic full-mode behavior.
   */
  readonly forceFullSync?: boolean;
  /**
   * R33 蓝军 CRITICAL #1.2 fix: invoked with the list of starIds the sync
   * pass detected as un-starred (only on full-mode passes that ran the
   * cleanup branch). Callers wire this to delete the corresponding
   * vector rows (`star:N` + `code:N:path:idx`) — without this, the
   * vector store accumulates orphan rows that pollute search results
   * AND bloat IDB. @starkit/core stays free of @starkit/vector via this
   * callback-decoupled hook (no workspace dep cycle).
   *
   * Failures inside onUnstar are logged-and-swallowed by the orchestrator
   * — un-star cleanup of the starStore has ALREADY succeeded at this
   * point, and bubbling a vector-store error would abort the sync
   * unnecessarily. Caller can re-run sync to retry.
   *
   * Empty list (no un-stars detected) means onUnstar is NOT called.
   */
  readonly onUnstar?: (deletedIds: ReadonlyArray<number>) => Promise<void>;
}

export interface SyncWithStoreStores {
  readonly starStore: StarStore;
  readonly cursorStore: CursorStore;
}

export interface SyncWithStoreResult {
  /** New rows fetched this run. Empty when notModified=true. */
  readonly stars: ReadonlyArray<StarredRepo>;
  /** ETag persisted into the cursor (or preserved when notModified). */
  readonly etag: string | null;
  /** True iff GitHub returned 304. */
  readonly notModified: boolean;
  readonly fetchedAt: string;
  readonly pageCount: number;
  /** From StarStore.upsertMany. Zero on notModified. */
  readonly inserted: number;
  readonly updated: number;
  /**
   * Rows deleted because GitHub no longer lists them (un-starred). Only
   * non-zero on full syncs — incremental short-circuits cannot prove a row
   * was un-starred (the request never reached the page it would be on).
   */
  readonly deleted: number;
  /** Store count AFTER the upsert + cleanup. */
  readonly knownCountAfter: number;
  /**
   * 'full' = no since cursor was passed; we fetched the whole list and
   * ran the cleanup pass. 'incremental' = we used the prior cursor's
   * since to early-exit pagination and skipped cleanup. Always 'full' on
   * a cold sync (no prior cursor at all).
   */
  readonly syncMode: SyncMode;
}

/**
 * Run one sync cycle:
 *   1. Read prior cursor (etag, since)
 *   2. Fetch stars from GitHub (sends If-None-Match)
 *   3. If 304: bump cursor.updatedAt and bail (no row changes possible —
 *      GitHub asserts the list is byte-identical)
 *   4. Otherwise:
 *      a. upsert fetched rows into starStore
 *      b. delete rows in starStore whose id is NOT in the fetched set —
 *         GitHub returns the FULL starred list (we don't use a since
 *         cutoff yet), so any absent id means the user un-starred it.
 *         This keeps the store as a faithful mirror of GitHub state.
 *      c. persist a fresh cursor (etag + max starredAt + count + ts)
 *
 * Mirror semantics: when a user un-stars a repo locally enriched with
 * userNote / aiTags, those fields are lost. v1 trade-off — soft-delete +
 * `unstarredAt` filter is a W2 candidate if users complain.
 *
 * Errors from syncStars (GithubError) bubble unchanged. We don't catch them
 * here because the caller's UI is the right place to decide retry vs surface.
 */
export async function syncStarsWithStore(
  client: StarKitOctokitInstance,
  stores: SyncWithStoreStores,
  options: SyncWithStoreOptions = {}
): Promise<SyncWithStoreResult> {
  const { starStore, cursorStore } = stores;
  const prevCursor = await cursorStore.get();

  // Pick full vs incremental mode based on lastFullSyncAt freshness;
  // the caller can also force full via opt.
  const lastFullMs = prevCursor?.lastFullSyncAt
    ? Date.parse(prevCursor.lastFullSyncAt)
    : Number.NaN;
  const needFullSync =
    options.forceFullSync === true ||
    !Number.isFinite(lastFullMs) ||
    Date.now() - lastFullMs > FULL_SYNC_INTERVAL_MS;
  const syncMode: SyncMode = needFullSync ? 'full' : 'incremental';

  const syncOpts: {
    etag?: string | null;
    perPage?: number;
    signal?: AbortSignal;
    since?: string | null;
  } = {};
  if (prevCursor?.etag) syncOpts.etag = prevCursor.etag;
  if (options.perPage !== undefined) syncOpts.perPage = options.perPage;
  if (options.signal !== undefined) syncOpts.signal = options.signal;
  if (!needFullSync && prevCursor?.since) {
    syncOpts.since = prevCursor.since;
  }

  const syncResult: SyncStarsResult = await syncStars(client, syncOpts);

  if (syncResult.notModified) {
    // ETag still valid — touch the cursor's updatedAt so the UI can show
    // "last checked X seconds ago" even when nothing changed.
    if (prevCursor) {
      const refreshed: SyncCursor = {
        ...prevCursor,
        updatedAt: syncResult.fetchedAt,
      };
      await cursorStore.set(refreshed);
    }
    return {
      stars: [],
      etag: syncResult.etag,
      notModified: true,
      fetchedAt: syncResult.fetchedAt,
      pageCount: syncResult.pageCount,
      inserted: 0,
      updated: 0,
      deleted: 0,
      knownCountAfter: await starStore.count(),
      syncMode,
    };
  }

  // R12 蓝军 #2-1 P0 fix: GitHub doesn't know our local-only fields
  // (aiTags / aiSummary / userNote / lastEmbeddedAt / subscribedToReleases /
  // deepIndexed). syncResult.stars came through transformStarred → zod parse,
  // so the missing fields were filled with their schema defaults ([] / null /
  // false). A bare upsertMany would clobber every locally-decorated row on the
  // next sync. Merge the existing local fields back in before persisting so
  // user notes, AI tags, and embed timestamps survive the round-trip.
  const merged = await mergeLocalFields(starStore, syncResult.stars);
  const upsertResult = await starStore.upsertMany(merged);

  // Cleanup ONLY in full mode — incremental short-circuit cannot prove a
  // row was un-starred (the request never reached the page it lives on).
  let deleted = 0;
  let nextLastFullSyncAt = prevCursor?.lastFullSyncAt ?? null;
  if (needFullSync) {
    const fetchedIds = new Set<number>(syncResult.stars.map((s) => s.id));
    const existing = await starStore.list({ limit: Number.POSITIVE_INFINITY });
    const toDelete = existing
      .filter((row) => !fetchedIds.has(row.id))
      .map((row) => row.id);
    // Single atomic batch — a mid-cleanup failure must not leave the store
    // partially reconciled (some un-stars applied, others not).
    deleted = await starStore.deleteMany(toDelete);
    // R33 蓝军 CRITICAL #1.2: notify caller so they can clean up orphan
    // vector rows (`star:N`, `code:N:path:idx`). Failures here are
    // logged-and-swallowed — the starStore cleanup already succeeded
    // and vector orphans are a softer corruption (search will skip
    // hits whose starId isn't in starStore anyway, see App.tsx:936
    // rehydrate-or-null pattern). Caller can retry by re-syncing.
    if (toDelete.length > 0 && options.onUnstar) {
      try {
        await options.onUnstar(toDelete);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[starkit] onUnstar vector cleanup failed (orphan rows may remain):',
          err
        );
      }
    }
    nextLastFullSyncAt = syncResult.fetchedAt;
  }
  const knownCountAfter = await starStore.count();

  // High-water mark for next incremental run
  const baseSince = prevCursor?.since ?? '';
  const maxStarredAt = syncResult.stars.reduce<string>(
    (max, s) => (s.starredAt > max ? s.starredAt : max),
    baseSince
  );

  const newCursor: SyncCursor = {
    etag: syncResult.etag,
    since: maxStarredAt.length > 0 ? maxStarredAt : null,
    knownCount: knownCountAfter,
    updatedAt: syncResult.fetchedAt,
    lastFullSyncAt: nextLastFullSyncAt,
  };
  await cursorStore.set(newCursor);

  return {
    stars: merged,
    etag: syncResult.etag,
    notModified: false,
    fetchedAt: syncResult.fetchedAt,
    pageCount: syncResult.pageCount,
    inserted: upsertResult.inserted,
    updated: upsertResult.updated,
    deleted,
    knownCountAfter,
    syncMode,
  };
}

/**
 * Local-only fields — never sourced from GitHub. Preserved across re-sync by
 * copying from the existing row when present. Kept as a string-literal tuple
 * so a future schema addition trips a typescript error here if we forget to
 * decide whether the new field is GitHub-owned or local-owned.
 *
 * R21 蓝军 P0 fix (demo gate finding): the i18n translation caches
 * (`descriptionI18n`, `aiSummaryI18n`, `aiTagsI18n`, `lastTranslatedAt`)
 * are local-only — GitHub doesn't know about them. They were added to the
 * schema in Phase 6 but the LOCAL_ONLY_FIELDS list was never extended.
 * Result: every `Sync` click reset all translation caches to the schema
 * defaults (`{}` / null), so users had to re-translate after every sync.
 * That's what made "翻译完了依旧有标签和介绍没有翻译" reproducible — the
 * sync between translate clicks silently wiped the cache.
 *
 * Symmetric reasoning: if a user un-stars a repo and re-stars later,
 * those translation caches DO get lost (because no `existing` row to
 * overlay from). Same trade-off as aiTags / userNote — acceptable v1
 * behavior; soft-delete + unstarredAt is a W6 candidate if users care.
 */
const LOCAL_ONLY_FIELDS = [
  'aiTags',
  'aiSummary',
  'userNote',
  'lastEmbeddedAt',
  'subscribedToReleases',
  'deepIndexed',
  // R21 蓝军 P0 — DO NOT REMOVE without weighing translate cost.
  // Each entry below is a Record<locale, string> keyed by BCP-47 locale.
  // Re-translate is expensive (one LLM chat call per star per locale),
  // so preserving these across sync is a 10-100x cost reduction for
  // users with the cron sync enabled.
  'descriptionI18n',
  'aiSummaryI18n',
  'aiTagsI18n',
  'lastTranslatedAt',
  // R36 蓝军 MAJOR #1.6: deep-index completion timestamp. Preserved
  // across sync like deepIndexed (the bool already in this list).
  // Sync ALSO uses this field to detect staleness — see mergeLocalFields
  // below for the auto-reset-on-push branch.
  'lastDeepIndexedAt',
] as const satisfies ReadonlyArray<keyof StarredRepo>;

/**
 * For each incoming row, look up the existing row by id. If found, overlay
 * the LOCAL_ONLY_FIELDS from existing onto the incoming row. Otherwise pass
 * the incoming row through (zod defaults already applied — first-sync rows
 * start with empty aiTags, null userNote, etc., which is the correct cold
 * state).
 *
 * Race note: this is read-then-write; if another writer (auto-tag, popup
 * manual edit) lands between our read and upsert, that write may be lost
 * to ours. Acceptable trade-off in v1 because (a) the popup sync-lock
 * serializes the most likely concurrent path (cron vs popup sync), (b) tag
 * runs are explicitly user-initiated and don't overlap normal sync windows,
 * and (c) the failure mode under a true race is "this sync's local field
 * preservation reflects state from N ms ago" — strictly better than today's
 * "every sync clobbers everything." A fully atomic read-merge-write would
 * need a store-level transaction API change, left for W6.
 */
async function mergeLocalFields(
  starStore: StarStore,
  incoming: ReadonlyArray<StarredRepo>
): Promise<ReadonlyArray<StarredRepo>> {
  if (incoming.length === 0) return incoming;
  const merged: StarredRepo[] = new Array(incoming.length);
  for (let i = 0; i < incoming.length; i += 1) {
    const row = incoming[i]!;
    const existing = await starStore.get(row.id);
    if (!existing) {
      merged[i] = row;
      continue;
    }
    const next: StarredRepo = { ...row };
    for (const field of LOCAL_ONLY_FIELDS) {
      // R21 蓝军 round-2 MINOR (subagent A): use `?? row[field]` to defend
      // against legacy IDB rows missing a Phase-6+ field. The existing row
      // can be `undefined` at field positions like `descriptionI18n` if it
      // was written before the schema added that key. Zod's parse-on-write
      // self-heals via `.default({})` today, but a future code path that
      // skips zod parse would persist `undefined` and break facets. The
      // coalesce falls back to `row[field]` (which always has the zod
      // default applied since `row` came through transformStarred → zod
      // parse) when existing is missing the key entirely.
      (next as Record<string, unknown>)[field] =
        (existing as Record<string, unknown>)[field] ??
        (row as Record<string, unknown>)[field];
    }
    // R36 蓝军 MAJOR #1.6: invalidate deepIndexed if GitHub's pushedAt
    // is newer than our lastDeepIndexedAt. Triggers a re-deep-index on
    // next click — the user's vector search would otherwise return
    // hits against source code that no longer exists upstream. The
    // pushedAt check is the closest GitHub gives us to "any code may
    // have changed" — refs we don't track (PR branches, force-pushes)
    // are not a v1 concern.
    if (
      next.deepIndexed &&
      next.lastDeepIndexedAt !== null &&
      next.pushedAt !== null &&
      next.pushedAt > next.lastDeepIndexedAt
    ) {
      next.deepIndexed = false;
      // Keep lastDeepIndexedAt as-is so UI can show "last indexed X
      // days ago" if it wants — only the boolean trigger resets.
    }
    merged[i] = next;
  }
  return merged;
}
