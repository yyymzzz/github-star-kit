/**
 * @starkit/core/digest — personalized AI weekly digest (W4 P0).
 *
 * Ranks recently-pushed starred repos by relevance to the user's interest
 * profile (computed as the centroid of every embedded star) with a small
 * recency tiebreak. Zero new GitHub calls — everything runs on data
 * already cached locally, so this is cheap enough to run on every popup
 * open and act as a "what should I look at this week" surface.
 */
export {
  computeInterestProfile,
  digestCosine,
  recencyBoost,
} from './profile.js';
export {
  generateDigest,
  type DigestEntry,
  type DigestResult,
  type GenerateDigestOptions,
  type ListVectorsFn,
} from './orchestrator.js';
