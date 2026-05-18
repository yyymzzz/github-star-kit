/**
 * @starkit/vector — Vector index wrapper + hybrid BM25-vector ranking.
 *
 * Day 1 status: scaffolding only. sqlite-vec wrapper lands W3 (semantic search).
 * Browser context uses IndexedDB-backed alternative (no native deps).
 */

export const VERSION = '0.0.1';

// Implementations land W3 — placeholder for now.
export type VectorRow = {
  readonly id: string;
  readonly vector: Float32Array;
  readonly metadata?: Record<string, unknown>;
};
