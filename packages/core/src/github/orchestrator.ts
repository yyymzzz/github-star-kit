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
  /** Store count AFTER the upsert. Useful for the "you have N stars" UI. */
  readonly knownCountAfter: number;
}

/**
 * Run one sync cycle:
 *   1. Read prior cursor (etag, since)
 *   2. Fetch stars from GitHub (sends If-None-Match)
 *   3. If 304: bump cursor.updatedAt and bail
 *   4. Otherwise: upsert into starStore, then persist a fresh cursor with
 *      the newest etag and the max starredAt we've seen.
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
      knownCountAfter: await starStore.count(),
    };
  }

  const upsertResult = await starStore.upsertMany(syncResult.stars);
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
    knownCountAfter,
  };
}
