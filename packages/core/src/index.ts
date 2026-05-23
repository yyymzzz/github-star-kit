/**
 * @starkit/core — GitHub star sync engine + zod schemas + local-first primitives.
 *
 * W1 Day 3 status: GitHub sync engine landed. Storage layer (IndexedDB on
 * extension side, sqlite-vec on Obsidian/Node side) is the next floor.
 * See docs/STRATEGY.md for the reference-and-rewrite contract with upstream.
 */

export const VERSION = '0.0.1';

export {
  githubErrorMessage,
  formatError,
  formatSyncSummary,
  formatRelativeTime,
} from './format.js';
export type { SyncSummaryInput } from './format.js';

export type { StarredRepo, SyncCursor, StarTag } from './schema.js';
export { StarredRepoSchema, SyncCursorSchema, StarTagSchema } from './schema.js';

export {
  createGithubClient,
  syncStars,
  syncStarsWithStore,
  transformStarred,
  GithubError,
} from './github/index.js';
export type {
  StarKitOctokitInstance,
  CreateGithubClientOptions,
  SyncStarsOptions,
  SyncStarsResult,
  SyncWithStoreOptions,
  SyncWithStoreResult,
  SyncWithStoreStores,
  GithubErrorKind,
  GithubErrorContext,
} from './github/index.js';

export {
  KVStoreMemory,
  StarStoreMemory,
  CursorStoreMemory,
  openStarKitDb,
  IndexedDBStarStore,
  IndexedDBKVStore,
  IndexedDBCursorStore,
} from './storage/index.js';
export type {
  KVStore,
  StarStore,
  StarStoreListOptions,
  StarStoreUpsertResult,
  CursorStore,
  StarKitDB,
  StarKitDBSchema,
  IDBVectorRecord,
} from './storage/index.js';

export {
  buildStarEmbeddingInput,
  contentHash,
  embedStars,
} from './embedding/index.js';
export type {
  EmbedBatchFn,
  EmbedStarsOptions,
  EmbedStarsResult,
  EmbeddingRow,
  VectorLookupFn,
  VectorUpsertFn,
} from './embedding/index.js';

export {
  buildTagUserPrompt,
  parseTagResponse,
  TAG_SYSTEM_PROMPT,
  tagStars,
} from './tagging/index.js';
export type {
  ChatBatchFn,
  TagStarsOptions,
  TagStarsResult,
  UpdateStarTagsFn,
} from './tagging/index.js';
