/**
 * IndexedDB implementations of KV / Star / Cursor stores.
 *
 * Targets the extension/web context. Obsidian (Node-with-sqlite) uses a
 * separate sqlite-vec backing (lands later when the vector index needs it).
 *
 * Schema (db name "starkit", v1):
 *   - object store "stars"   keyPath: 'id' (number)
 *       indexes: by-starredAt | by-pushedAt | by-stargazersCount
 *   - object store "kv"      out-of-line string keys, JSON-blob values
 *   - object store "cursor"  single row, key='default'
 *
 * Tests use `fake-indexeddb` to polyfill globalThis.indexedDB; production
 * relies on the browser's native implementation.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  StarredRepoSchema,
  SyncCursorSchema,
  type StarredRepo,
  type SyncCursor,
} from '../schema.js';
import type {
  CursorStore,
  KVStore,
  StarStore,
  StarStoreListOptions,
  StarStoreUpsertResult,
} from './types.js';

/**
 * Persistent shape of a vector row in IDB. Mirrors @starkit/vector's
 * VectorRow but typed concretely here so the schema can reason about it
 * without taking a runtime dependency on @starkit/vector. The vector
 * package's IndexedDBVectorStore wraps a StarKitDB and reads/writes
 * rows in this shape directly.
 */
export interface IDBVectorRecord {
  /** Namespaced id — convention: `star:${githubId}`. Also the keyPath. */
  readonly id: string;
  /** Embedding vector. Number[] (not ReadonlyArray) for IDB serialization
   *  symmetry — readonly is a TS-only attribute that IDB ignores. */
  readonly vector: ReadonlyArray<number>;
  readonly metadata?: Record<string, unknown>;
}

export interface StarKitDBSchema extends DBSchema {
  stars: {
    key: number;
    value: StarredRepo;
    indexes: {
      'by-starredAt': string;
      'by-pushedAt': string;
      'by-stargazersCount': number;
    };
  };
  kv: { key: string; value: unknown };
  cursor: { key: string; value: SyncCursor };
  /**
   * Persistent vector index. Single store keyed by namespaced id (`star:N`
   * for now; `code:N:chunk:K` will share this store in W5). No indexes —
   * search is a full-scan loaded into memory anyway, and adding indexes
   * would just slow writes without helping reads.
   *
   * Added in v2 (W3 D3). v1 → v2 migration creates this store from empty;
   * existing stars / kv / cursor data is preserved.
   */
  vectors: { key: string; value: IDBVectorRecord };
}

export type StarKitDB = IDBPDatabase<StarKitDBSchema>;

const DEFAULT_DB_NAME = 'starkit';
const DB_VERSION = 2;
const CURSOR_KEY = 'default';

/**
 * Open (or create) the StarKit IndexedDB database. Safe to call repeatedly —
 * idb's `openDB` returns the same connection for the same name.
 *
 * Migration story: the upgrade handler is additive only. Each `if (!contains)`
 * guard lets a fresh install and a v1-upgrading install share the same code
 * path. v1 → v2 introduced the `vectors` store; no existing data is touched.
 */
export async function openStarKitDb(name = DEFAULT_DB_NAME): Promise<StarKitDB> {
  return openDB<StarKitDBSchema>(name, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('stars')) {
        const stars = db.createObjectStore('stars', { keyPath: 'id' });
        stars.createIndex('by-starredAt', 'starredAt');
        stars.createIndex('by-pushedAt', 'pushedAt');
        stars.createIndex('by-stargazersCount', 'stargazersCount');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('cursor')) {
        db.createObjectStore('cursor');
      }
      // v2 — vector index. Keyed by namespaced id (keyPath: 'id').
      if (!db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'id' });
      }
    },
  });
}

// ─── StarStore ───────────────────────────────────────────────────────

export class IndexedDBStarStore implements StarStore {
  constructor(private readonly db: StarKitDB) {}

  async upsertMany(
    stars: ReadonlyArray<StarredRepo>
  ): Promise<StarStoreUpsertResult> {
    // Validate everything BEFORE touching the transaction so a bad row can't
    // partially commit.
    const validated = stars.map((s) => StarredRepoSchema.parse(s));

    const tx = this.db.transaction('stars', 'readwrite');
    const store = tx.objectStore('stars');
    let inserted = 0;
    let updated = 0;
    for (const star of validated) {
      const existing = await store.get(star.id);
      if (existing) {
        updated += 1;
      } else {
        inserted += 1;
      }
      await store.put(star);
    }
    await tx.done;
    return { inserted, updated };
  }

  async get(id: number): Promise<StarredRepo | null> {
    return (await this.db.get('stars', id)) ?? null;
  }

  async list(
    options: StarStoreListOptions = {}
  ): Promise<ReadonlyArray<StarredRepo>> {
    const orderBy = options.orderBy ?? 'starredAt';
    const order = options.order ?? 'desc';
    const offset = options.offset ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    const indexName =
      orderBy === 'pushedAt'
        ? 'by-pushedAt'
        : orderBy === 'stargazersCount'
          ? 'by-stargazersCount'
          : 'by-starredAt';

    // getAllFromIndex returns rows in index-order ASC. We slice after
    // optionally reversing — at v1 row counts (≤ a few thousand) this is
    // fine; future cursor-based listing can replace this when needed.
    const all = await this.db.getAllFromIndex('stars', indexName);
    if (order === 'desc') all.reverse();
    return all.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.db.count('stars');
  }

  async delete(id: number): Promise<void> {
    await this.db.delete('stars', id);
  }

  async deleteMany(ids: ReadonlyArray<number>): Promise<number> {
    if (ids.length === 0) return 0;
    // ONE readwrite transaction for the whole batch: either the un-star
    // reconciliation lands as a unit or (on error) rolls back, so the store
    // never sits half-reconciled with GitHub's list.
    const tx = this.db.transaction('stars', 'readwrite');
    const store = tx.objectStore('stars');
    let deleted = 0;
    for (const id of ids) {
      // Count only ids that actually existed so the caller's "N removed"
      // tally reflects reality rather than the input list length.
      if ((await store.get(id)) !== undefined) {
        await store.delete(id);
        deleted += 1;
      }
    }
    await tx.done;
    return deleted;
  }

  async clear(): Promise<void> {
    await this.db.clear('stars');
  }
}

// ─── KVStore ─────────────────────────────────────────────────────────

export class IndexedDBKVStore implements KVStore {
  constructor(private readonly db: StarKitDB) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const v = await this.db.get('kv', key);
    return (v ?? null) as T | null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.db.put('kv', value, key);
  }

  async delete(key: string): Promise<void> {
    await this.db.delete('kv', key);
  }

  async keys(): Promise<ReadonlyArray<string>> {
    const raw = await this.db.getAllKeys('kv');
    // All keys we write are strings; filter defensively in case a host
    // sneaks something else through. (Defensive — should not trigger.)
    return raw.filter((k): k is string => typeof k === 'string');
  }
}

// ─── CursorStore ─────────────────────────────────────────────────────

export class IndexedDBCursorStore implements CursorStore {
  constructor(private readonly db: StarKitDB) {}

  async get(): Promise<SyncCursor | null> {
    const v = await this.db.get('cursor', CURSOR_KEY);
    return v ?? null;
  }

  async set(cursor: SyncCursor): Promise<void> {
    const validated = SyncCursorSchema.parse(cursor);
    await this.db.put('cursor', validated, CURSOR_KEY);
  }

  async clear(): Promise<void> {
    await this.db.delete('cursor', CURSOR_KEY);
  }
}
