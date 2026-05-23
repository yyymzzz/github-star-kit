/**
 * @starkit/core/embedding — pipeline that turns starred repos into vector
 * rows ready for VectorStore.upsertMany.
 *
 * Storage- and provider-agnostic by design: callers wire `provider.embed`
 * and `vectorStore.upsertMany` in via callbacks, keeping @starkit/core free
 * of @starkit/ai and @starkit/vector workspace dependencies.
 */
export { buildStarEmbeddingInput, contentHash } from './text.js';
export {
  embedStars,
  type EmbedBatchFn,
  type EmbedStarsOptions,
  type EmbedStarsResult,
  type EmbeddingRow,
  type VectorLookupFn,
  type VectorUpsertFn,
} from './orchestrator.js';
