/**
 * In-memory VectorStore — O(n) cosine full-scan.
 *
 * Sizing: a 1536-dim OpenAI embedding × 1000 rows × 8 bytes = ~12 MB raw.
 * Full-scan per query at that size is ~5ms on modern V8. We cache a
 * pre-computed L2-norm per row so the cosine inner-loop becomes a single
 * dot-product + two cached scalars, which is what dominates the constant
 * factor for this many rows. Sub-50ms search on 5k rows × 1536 dim is the
 * design point. HNSW or sqlite-vec become worthwhile north of ~10k rows.
 */
import {
  cosineSimilarity,
  type VectorRow,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  type VectorUpsertResult,
} from './types.js';

interface InternalRow {
  readonly row: VectorRow;
  /** sqrt of sum of squared components. Cached so search is one division
   *  + dot product per candidate instead of three full passes. */
  readonly norm: number;
}

function l2Norm(v: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i]!;
    s += x * x;
  }
  return Math.sqrt(s);
}

export class MemoryVectorStore implements VectorStore {
  private readonly byId = new Map<string, InternalRow>();

  async upsertMany(
    rows: ReadonlyArray<VectorRow>
  ): Promise<VectorUpsertResult> {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      if (this.byId.has(row.id)) {
        updated += 1;
      } else {
        inserted += 1;
      }
      this.byId.set(row.id, { row, norm: l2Norm(row.vector) });
    }
    return { inserted, updated };
  }

  async get(id: string): Promise<VectorRow | null> {
    return this.byId.get(id)?.row ?? null;
  }

  async delete(id: string): Promise<void> {
    this.byId.delete(id);
  }

  async count(): Promise<number> {
    return this.byId.size;
  }

  async clear(): Promise<void> {
    this.byId.clear();
  }

  async list(): Promise<ReadonlyArray<VectorRow>> {
    // Map iteration is insertion order; callers that need a different order
    // sort downstream. Returning the cached row (not the InternalRow) so the
    // norm-cache implementation detail stays inside the class.
    const out: VectorRow[] = [];
    for (const entry of this.byId.values()) out.push(entry.row);
    return out;
  }

  /**
   * R51: contract-mirror of IndexedDBVectorStore.deleteByPrefix. Memory
   * implementation is O(N) on map size but in-memory and synchronous-ish;
   * still fine because the hot-path caller (popup onUnstar) maintains both
   * a memory + IDB store and the savings vs the old list+regex are mostly
   * IDB-side. Returns count of deleted rows.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    if (prefix.length === 0) {
      throw new Error('deleteByPrefix: prefix must be non-empty');
    }
    let deleted = 0;
    for (const id of this.byId.keys()) {
      if (id.startsWith(prefix)) {
        this.byId.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async search(
    query: ReadonlyArray<number>,
    options: VectorSearchOptions = {}
  ): Promise<ReadonlyArray<VectorSearchResult>> {
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
    const queryNorm = l2Norm(query);
    if (queryNorm === 0) {
      // Zero vector has no meaningful direction — return empty rather
      // than ranking everything tied at 0.
      return [];
    }

    const results: VectorSearchResult[] = [];
    for (const entry of this.byId.values()) {
      if (options.filter && !options.filter(entry.row)) continue;
      const score = cosineWithCachedNorm(query, queryNorm, entry.row.vector, entry.norm);
      if (score < minScore) continue;
      const result: VectorSearchResult = entry.row.metadata !== undefined
        ? { id: entry.row.id, score, metadata: entry.row.metadata }
        : { id: entry.row.id, score };
      results.push(result);
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

/**
 * Cosine where the L2-norm of one or both sides is already known.
 * Exported only via cosineSimilarity in types.ts for the public surface;
 * this helper stays module-private.
 */
function cosineWithCachedNorm(
  a: ReadonlyArray<number>,
  normA: number,
  b: ReadonlyArray<number>,
  normB: number
): number {
  if (a.length !== b.length) {
    // We could throw, but at query time a dim mismatch is more usefully
    // expressed as "this row scores 0" so a stale row from another model
    // doesn't blow up the whole search. We surface dim invariants at
    // upsert time instead — if the caller cared.
    // …actually no: keep search strict. Bad data should be loud.
    throw new Error(
      `Vector dim mismatch during search: query=${a.length} row=${b.length}`
    );
  }
  if (normA === 0 || normB === 0) return 0;
  // Inline the dot product so we avoid the third pass cosineSimilarity does.
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
  }
  return dot / (normA * normB);
}

// Re-export cosineSimilarity so callers wanting a one-shot compute don't
// have to reach into types.ts.
export { cosineSimilarity };
