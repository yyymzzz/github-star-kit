/**
 * @starkit/vector — VectorStore interface.
 *
 * Powers W3 README semantic search and W5 code-context search. The interface
 * is small on purpose:
 *   - upsertMany       — write path (sync from GitHub / re-embed pipeline)
 *   - search           — read path (popup query → top-N relevant ids)
 *   - get / delete / clear / count — utility
 *
 * Two backings ship eventually:
 *   - memory:      O(n) full-scan cosine; default everywhere; fine up to
 *                  ~10k rows on modern hardware (<10ms / query).
 *   - sqlite-vec:  Obsidian-side persistent index (W3+ when row counts go
 *                  high enough to matter).
 *
 * Vectors are stored as plain readonly number arrays — Float32Array was
 * tempting but it serializes badly through structured-clone (IDB) and JSON,
 * and the cosine math is bottlenecked by JS engine math primitives anyway,
 * not array element access cost.
 */

export interface VectorRow {
  /** Caller-assigned id. Convention: namespaced like `readme:12345` so a
   *  single store can hold readme + code chunks side-by-side. */
  readonly id: string;
  /** Embedding vector. All rows in one store SHOULD share the same dim;
   *  search() throws on dim mismatch with the query. */
  readonly vector: ReadonlyArray<number>;
  /** Arbitrary metadata. Search results carry it through unchanged so the
   *  caller can render repo names, urls, etc. without a second lookup. */
  readonly metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  /** Top-K to return. Defaults to 10. */
  readonly limit?: number;
  /** Predicate that runs against EVERY row BEFORE scoring — cheap pruning
   *  for "only repos I've starred recently" or "only language=Rust". */
  readonly filter?: (row: VectorRow) => boolean;
  /** Drop results whose cosine similarity is below this floor. Defaults to
   *  -Infinity (no floor). 0.5 is a useful starting point for "actually
   *  related" results from semantically-faithful embeddings. */
  readonly minScore?: number;
}

export interface VectorSearchResult {
  readonly id: string;
  /** Cosine similarity in [-1, 1]. Same-direction unit vectors score 1.0. */
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
}

export interface VectorUpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

export interface VectorStore {
  /** Insert or replace rows. Schema validation is the caller's job — the
   *  store assumes shapes already match VectorRow. */
  upsertMany(rows: ReadonlyArray<VectorRow>): Promise<VectorUpsertResult>;

  get(id: string): Promise<VectorRow | null>;

  delete(id: string): Promise<void>;

  /** Return top-K rows ranked by cosine similarity to `query`. */
  search(
    query: ReadonlyArray<number>,
    options?: VectorSearchOptions
  ): Promise<ReadonlyArray<VectorSearchResult>>;

  count(): Promise<number>;

  clear(): Promise<void>;
}

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Exposed because both the in-memory implementation and any test / debug
 * tooling want the same definition. Throws on dim mismatch — silent
 * truncation would mask real bugs (e.g. mixing two embedding models with
 * different output dims).
 */
export function cosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>
): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dim mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
