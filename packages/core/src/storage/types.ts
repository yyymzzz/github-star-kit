/**
 * Storage abstractions for the local-first store.
 *
 * Two backings ship in v1:
 *   - **memory**:  in-process Map. Used by tests and as the dev fallback.
 *   - **IndexedDB**: extension/web context. Ships in Day 4b (popup wire-up).
 *
 * Obsidian's sqlite-vec wrapping shares the StarStore interface so a single
 * codepath in @starkit/core can talk to either backing — the host app picks
 * the adapter at startup.
 *
 * Interface design notes:
 *   - All methods return Promises so IndexedDB and sqlite are both natural fits.
 *   - upsertMany is the only mutator on StarStore — there is no `insert`/
 *     `update` split because GitHub sync always re-fetches the full row, and
 *     having one mutator keeps the IndexedDB transaction story trivial.
 *   - All shape boundaries are schema-validated (StarredRepoSchema /
 *     SyncCursorSchema). Invalid input throws before persistence — clients
 *     should never see "half-written" rows.
 */
import type { StarredRepo, SyncCursor } from '../schema.js';

export interface KVStore {
  /** Returns null when the key is absent. Returned shape is whatever was set. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Replaces the value at `key` outright. */
  set<T = unknown>(key: string, value: T): Promise<void>;
  /** No-op if `key` is absent. */
  delete(key: string): Promise<void>;
  keys(): Promise<ReadonlyArray<string>>;
}

export interface StarStoreListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: 'starredAt' | 'pushedAt' | 'stargazersCount';
  readonly order?: 'asc' | 'desc';
}

export interface StarStoreUpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

export interface StarStore {
  /**
   * Insert or replace many stars in a single atomic operation. Returns counts
   * so callers can render "12 new, 3 updated" feedback after sync.
   */
  upsertMany(
    stars: ReadonlyArray<StarredRepo>
  ): Promise<StarStoreUpsertResult>;

  get(id: number): Promise<StarredRepo | null>;

  /**
   * Default: orderBy='starredAt', order='desc' (most-recently-starred first —
   * matches W1 demo gate's expected popup layout).
   */
  list(options?: StarStoreListOptions): Promise<ReadonlyArray<StarredRepo>>;

  count(): Promise<number>;

  delete(id: number): Promise<void>;

  /**
   * Delete many rows by id in a single atomic operation (one IndexedDB
   * transaction). Absent ids are ignored. Returns the number of rows actually
   * deleted. Used by the un-star cleanup pass so a mid-batch failure can't
   * leave the store partially reconciled with GitHub's list.
   */
  deleteMany(ids: ReadonlyArray<number>): Promise<number>;

  /** Drop ALL rows. For "log out" / "reset" flows. */
  clear(): Promise<void>;
}

export interface CursorStore {
  get(): Promise<SyncCursor | null>;
  set(cursor: SyncCursor): Promise<void>;
  clear(): Promise<void>;
}
