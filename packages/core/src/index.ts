/**
 * @starkit/core — GitHub star sync engine + zod schemas + local-first primitives.
 *
 * Day 1 status: scaffolding only. Real implementation lands W1 Day 3.
 * See docs/STRATEGY.md for the reference-and-rewrite contract with upstream.
 */

export const VERSION = '0.0.1';

export type { StarredRepo, SyncCursor, StarTag } from './schema.js';
export { StarredRepoSchema, SyncCursorSchema, StarTagSchema } from './schema.js';
