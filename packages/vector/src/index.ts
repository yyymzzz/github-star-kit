/**
 * @starkit/vector — Vector index wrapper + hybrid BM25-vector ranking.
 *
 * W3 D1 status: VectorStore interface + MemoryVectorStore. sqlite-vec
 * adapter and BM25 hybrid ranking arrive later in W3 once the full embed
 * pipeline is wired and we have a representative row count to tune
 * against. Browser context will keep using memory (W3 demo gate sizes:
 * 1000 stars × 1536-dim = ~12MB, fits in popup memory). Obsidian gets
 * sqlite-vec when persistence size justifies it.
 */

export const VERSION = '0.0.1';

export type {
  VectorRow,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorUpsertResult,
} from './types.js';
export { cosineSimilarity } from './types.js';

export { MemoryVectorStore } from './memory.js';
