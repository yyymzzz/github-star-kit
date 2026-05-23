/**
 * IndexedDBVectorStore — persistent VectorStore on top of @starkit/core's
 * StarKitDB. Used by the browser extension popup and (eventually) the Obsidian
 * plugin as the durable side of a two-tier index:
 *
 *   IndexedDBVectorStore  →  MemoryVectorStore
 *   (persistence, slow)      (hot search, fast)
 *
 * The popup's mount sequence reads `idb.list()` into a fresh MemoryVectorStore
 * so every query stays in-memory. Writes happen to BOTH (dual-upsert) so a
 * popup restart doesn't lose the index. `search()` IS implemented here for
 * correctness — it round-trips through memory as a one-shot — but callers
 * that care about latency should keep a long-lived MemoryVectorStore.
 *
 * Schema ownership: the `vectors` object store + DB_VERSION=2 live in
 * @starkit/core/storage/idb.ts (the only place that owns StarKitDBSchema).
 * This class just reads/writes that store.
 */
import type { IDBVectorRecord, StarKitDB } from '@starkit/core';
import { MemoryVectorStore } from './memory.js';
import type {
  VectorRow,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorUpsertResult,
} from './types.js';

export class IndexedDBVectorStore implements VectorStore {
  constructor(private readonly db: StarKitDB) {}

  async upsertMany(
    rows: ReadonlyArray<VectorRow>
  ): Promise<VectorUpsertResult> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    // Single readwrite transaction for the whole batch — same atomicity story
    // as IndexedDBStarStore.deleteMany: a mid-batch failure rolls back instead
    // of leaving the index half-written. The orchestrator caller already
    // groups by batchSize, so transaction lifetime stays bounded.
    const tx = this.db.transaction('vectors', 'readwrite');
    const store = tx.objectStore('vectors');
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const existing = await store.get(row.id);
      if (existing) updated += 1;
      else inserted += 1;
      // Coerce to the IDB record shape. ReadonlyArray<number> serializes
      // identically; the readonly is a TS-only attribute IDB doesn't see.
      const record: IDBVectorRecord = row.metadata !== undefined
        ? { id: row.id, vector: row.vector, metadata: row.metadata }
        : { id: row.id, vector: row.vector };
      await store.put(record);
    }
    await tx.done;
    return { inserted, updated };
  }

  async get(id: string): Promise<VectorRow | null> {
    const r = (await this.db.get('vectors', id)) ?? null;
    return r;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete('vectors', id);
  }

  async count(): Promise<number> {
    return this.db.count('vectors');
  }

  async clear(): Promise<void> {
    await this.db.clear('vectors');
  }

  async list(): Promise<ReadonlyArray<VectorRow>> {
    return this.db.getAll('vectors');
  }

  /**
   * Full-scan cosine search.
   *
   * Implementation is deliberately a single round-trip into a transient
   * MemoryVectorStore — reusing the cached-norm cosine + top-K + filter
   * + minScore semantics that already live there. v1 row counts (≤10k)
   * make this fine: load is O(n) on row count, search is O(n) on dim.
   * Anything bigger should pre-load into a long-lived MemoryVectorStore
   * at popup mount instead of calling this every query.
   */
  async search(
    query: ReadonlyArray<number>,
    options?: VectorSearchOptions
  ): Promise<ReadonlyArray<VectorSearchResult>> {
    const transient = new MemoryVectorStore();
    await transient.upsertMany(await this.list());
    return transient.search(query, options);
  }
}
