/**
 * In-memory implementations of KV / Star / Cursor stores.
 *
 * Use cases:
 *   - All unit + contract tests
 *   - Default backing in Node dev (e.g. a CLI that runs sync once and exits)
 *   - Reference impl: behavior here is what IndexedDB / sqlite-vec impls
 *     must match.
 *
 * Schema validation runs on every write so test data and prod data follow
 * the same contract.
 */
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

// ─── KVStore ─────────────────────────────────────────────────────────

export class KVStoreMemory implements KVStore {
  private readonly map = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.map.has(key) ? (this.map.get(key) as T) : null);
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<ReadonlyArray<string>> {
    return Array.from(this.map.keys());
  }
}

// ─── StarStore ───────────────────────────────────────────────────────

export class StarStoreMemory implements StarStore {
  private readonly byId = new Map<number, StarredRepo>();

  async upsertMany(
    stars: ReadonlyArray<StarredRepo>
  ): Promise<StarStoreUpsertResult> {
    let inserted = 0;
    let updated = 0;
    for (const raw of stars) {
      // Re-parse to catch any caller bypassing the schema (e.g. typed-any
      // intrusion). Memory store treats the schema as authoritative.
      const star = StarredRepoSchema.parse(raw);
      if (this.byId.has(star.id)) {
        updated += 1;
      } else {
        inserted += 1;
      }
      this.byId.set(star.id, star);
    }
    return { inserted, updated };
  }

  async get(id: number): Promise<StarredRepo | null> {
    return this.byId.get(id) ?? null;
  }

  async list(
    options: StarStoreListOptions = {}
  ): Promise<ReadonlyArray<StarredRepo>> {
    const orderBy = options.orderBy ?? 'starredAt';
    const order = options.order ?? 'desc';
    const offset = options.offset ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    const all = Array.from(this.byId.values());
    all.sort((a, b) => compareByField(a, b, orderBy, order));
    return all.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.byId.size;
  }

  async delete(id: number): Promise<void> {
    this.byId.delete(id);
  }

  async deleteMany(ids: ReadonlyArray<number>): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.byId.delete(id)) deleted += 1;
    }
    return deleted;
  }

  async clear(): Promise<void> {
    this.byId.clear();
  }
}

function compareByField(
  a: StarredRepo,
  b: StarredRepo,
  field: NonNullable<StarStoreListOptions['orderBy']>,
  order: 'asc' | 'desc'
): number {
  let cmp: number;
  if (field === 'stargazersCount') {
    cmp = a.stargazersCount - b.stargazersCount;
  } else {
    // starredAt / pushedAt are Z-normalized ISO-8601, so a lexicographic
    // compare orders them chronologically. pushedAt may be null (never-pushed
    // repo) — treat null as the oldest possible value so empty repos sort to
    // the "least recent" end (last in desc, first in asc).
    const av = a[field];
    const bv = b[field];
    if (av === bv) cmp = 0;
    else if (av === null) cmp = -1;
    else if (bv === null) cmp = 1;
    else cmp = av < bv ? -1 : 1;
  }
  return order === 'desc' ? -cmp : cmp;
}

// ─── CursorStore ─────────────────────────────────────────────────────

export class CursorStoreMemory implements CursorStore {
  private current: SyncCursor | null = null;

  async get(): Promise<SyncCursor | null> {
    return this.current;
  }

  async set(cursor: SyncCursor): Promise<void> {
    this.current = SyncCursorSchema.parse(cursor);
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}
