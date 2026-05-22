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

  const upsertResult = await starStore.upsertMany(syncResult.stars);

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
    stars: syncResult.stars,
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
