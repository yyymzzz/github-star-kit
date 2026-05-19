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

export interface SyncWithStoreOptions {
  readonly perPage?: number;
  readonly signal?: AbortSignal;
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
   * Rows we deleted from starStore because GitHub no longer lists them
   * (user un-starred). Zero on notModified or cold sync. The UI can show
   * "removed N un-starred repos" alongside inserted/updated.
   */
  readonly deleted: number;
  /** Store count AFTER the upsert + cleanup. */
  readonly knownCountAfter: number;
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

  const syncOpts: { etag?: string | null; perPage?: number; signal?: AbortSignal } = {};
  if (prevCursor?.etag) syncOpts.etag = prevCursor.etag;
  if (options.perPage !== undefined) syncOpts.perPage = options.perPage;
  if (options.signal !== undefined) syncOpts.signal = options.signal;

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
    };
  }

  const upsertResult = await starStore.upsertMany(syncResult.stars);

  // Mirror cleanup: any row already in the store whose id is NOT in the
  // freshly-fetched set means the user un-starred it. Delete those rows
  // so the store stays a faithful mirror of GitHub.
  //
  // Performance note: we list() with no limit so we get the full ID set.
  // At v1 row counts (≤ a few thousand) this is fine. When ranges grow,
  // a `listIds()` shortcut on StarStore that doesn't materialize values
  // is the obvious optimization (deferred to W2 alongside the starred_at
  // cursor path which would also touch this codepath).
  const fetchedIds = new Set<number>(syncResult.stars.map((s) => s.id));
  const existing = await starStore.list({ limit: Number.POSITIVE_INFINITY });
  let deleted = 0;
  for (const row of existing) {
    if (!fetchedIds.has(row.id)) {
      await starStore.delete(row.id);
      deleted += 1;
    }
  }
  const knownCountAfter = await starStore.count();

  // Track the high-water mark of starred_at across this sync + prior cursor,
  // so the eventual W2 starred_at-cutoff path has a real value to compare.
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
  };
}
