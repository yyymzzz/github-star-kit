/**
 * @starkit/core/github — barrel.
 */
export { createGithubClient } from './client.js';
export type {
  StarKitOctokitInstance,
  CreateGithubClientOptions,
} from './client.js';
export { syncStars, transformStarred } from './sync.js';
export type { SyncStarsOptions, SyncStarsResult } from './sync.js';
export { GithubError } from './errors.js';
export type { GithubErrorKind, GithubErrorContext } from './errors.js';
