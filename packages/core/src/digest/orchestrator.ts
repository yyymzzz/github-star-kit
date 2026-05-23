/**
 * Weekly-digest orchestrator — picks the N most relevant recently-pushed
 * starred repos for the current user.
 *
 * Pipeline:
 *   1. Pull every embedded vector (caller-supplied callback returns
 *      `{ starId, vector }[]`).
 *   2. Compute the interest-profile centroid.
 *   3. Filter starStore to candidates: pushed inside `windowDays`, NOT
 *      archived, NOT a fork (forks are usually noise in a digest).
 *   4. Score each candidate by `cosine(vector, profile) * 0.8 +
 *      recencyBoost * 0.2`.
 *   5. Sort desc, slice top-N.
 *
 * Zero new GitHub API calls — everything runs on data already in the
 * local stores. That's deliberate: the W4 demo gate runs every popup
 * open, so it must be cheap.
 *
 * Callback decoupling stays consistent with embed/tag orchestrators:
 * @starkit/core doesn't import @starkit/vector. The caller wires
 * `vectorStore.list()` → `{ starId, vector }[]` at the boundary.
 */
import type { StarredRepo } from '../schema.js';
import type { StarStore } from '../storage/types.js';
import {
  computeInterestProfile,
  digestCosine,
  recencyBoost,
} from './profile.js';

/** Caller-supplied loader for every embedded star's vector. */
export type ListVectorsFn = () => Promise<
  ReadonlyArray<{
    readonly starId: number;
    readonly vector: ReadonlyArray<number>;
  }>
>;

export interface GenerateDigestOptions {
  readonly starStore: StarStore;
  readonly listVectors: ListVectorsFn;
  /** Time window — only repos pushed within this many days count as candidates.
   *  Default 7. Aligned with the "Friday morning digest" cadence the parent
   *  plan calls out. */
  readonly windowDays?: number;
  /** Maximum entries in the digest. Default 10 per the W4 demo gate. */
  readonly limit?: number;
  /** Test/replay seam — defaults to Date.now(). */
  readonly now?: number;
}

export interface DigestEntry {
  readonly star: StarredRepo;
  /** Final composite score: relevance × 0.8 + recency × 0.2, in [0, 1]. */
  readonly score: number;
  /** Pure cosine vs the profile centroid, in [-1, 1]. Useful for debugging
   *  ranking choices that "feel wrong". */
  readonly relevance: number;
  /** Recency boost in [0, 1]. */
  readonly recency: number;
}

export interface DigestResult {
  readonly entries: ReadonlyArray<DigestEntry>;
  /** How many candidates matched the window/archived/fork filter — useful
   *  for a "showing 10 of N this week" UI string. */
  readonly candidateCount: number;
  /** True when the user has no embeddings yet (digest can't run). */
  readonly profileEmpty: boolean;
  /** UTC ISO timestamp the digest was generated at. */
  readonly generatedAt: string;
}

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 10;
/** Composite weights — relevance dominates, recency breaks ties. See
 *  profile.ts's docstring on `recencyBoost` for rationale. */
const RELEVANCE_WEIGHT = 0.8;
const RECENCY_WEIGHT = 0.2;

export async function generateDigest(
  opts: GenerateDigestOptions
): Promise<DigestResult> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (windowDays <= 0) {
    throw new Error(`generateDigest: windowDays must be > 0, got ${windowDays}`);
  }
  if (limit < 1) {
    throw new Error(`generateDigest: limit must be >= 1, got ${limit}`);
  }

  const nowMs = opts.now ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - windowMs;

  // Pull everything we need in parallel.
  const [allVectors, allStars] = await Promise.all([
    opts.listVectors(),
    opts.starStore.list(),
  ]);

  if (allVectors.length === 0) {
    return {
      entries: [],
      candidateCount: 0,
      profileEmpty: true,
      generatedAt,
    };
  }

  // Profile = centroid of every embedded vector.
  const profile = computeInterestProfile(allVectors.map((v) => v.vector));

  // Index vectors by starId for O(1) lookup during scoring.
  const vecByStarId = new Map<number, ReadonlyArray<number>>();
  for (const v of allVectors) vecByStarId.set(v.starId, v.vector);

  // Candidate filter: pushed in window, not archived, not a fork.
  // (Fork filtering is W4-specific opinion: a fork's last push is rarely a
  //  signal the user wants — they starred the upstream. Stars where isFork
  //  IS the upstream are extremely rare in practice.)
  const candidates: StarredRepo[] = [];
  for (const star of allStars) {
    if (star.archived) continue;
    if (star.isFork) continue;
    if (star.pushedAt === null) continue;
    const pushedMs = Date.parse(star.pushedAt);
    if (!Number.isFinite(pushedMs)) continue;
    if (pushedMs < cutoffMs) continue;
    candidates.push(star);
  }

  // Score every candidate against the centroid. Skip stars without an
  // embedded vector — they'll just rank zero anyway, but explicitly
  // dropping them keeps the entries' scores meaningful.
  const scored: DigestEntry[] = [];
  for (const star of candidates) {
    const vec = vecByStarId.get(star.id);
    if (!vec) continue;
    const pushedMs = Date.parse(star.pushedAt!);
    const relevance = digestCosine(profile, vec);
    const recency = recencyBoost(pushedMs, nowMs, windowMs);
    const score = relevance * RELEVANCE_WEIGHT + recency * RECENCY_WEIGHT;
    scored.push({ star, score, relevance, recency });
  }

  scored.sort((a, b) => b.score - a.score);
  const entries = scored.slice(0, limit);

  return {
    entries,
    candidateCount: scored.length,
    profileEmpty: false,
    generatedAt,
  };
}
