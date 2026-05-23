/**
 * Interest-profile + similarity primitives for the weekly digest.
 *
 * The profile is the **centroid** of every embedded star — i.e. a single
 * vector whose direction encodes "what this user tends to star." Scoring
 * a candidate update against the profile is just one cosine call.
 *
 * Why centroid (vs. average-of-top-K, median, weighted by recency)?
 *   Centroid is the simplest reasonable baseline. It assumes all stars
 *   weigh equally — which is wrong on the long tail (a user with 5 Rust
 *   stars and 500 JavaScript stars will see Rust signals dominated), but
 *   it's a known wrongness with a clear upgrade path: switch to a
 *   weighting scheme (e.g. inverse-popularity TF-IDF style) without
 *   changing the rest of the pipeline. W4 v1 ships centroid; W5+ can swap.
 *
 * Lives in @starkit/core because it consumes vectors but doesn't depend on
 * any particular vector store implementation — the caller pulls vectors
 * out of @starkit/vector and hands them in.
 */

/**
 * Compute the mean vector over a list of vectors. All vectors must share
 * a dimension; throws on mismatch — a silent dim coercion would mix two
 * embedding models and produce a meaningless centroid.
 *
 * Returns an empty array when `vectors` is empty: a digest with zero
 * embedded stars is a no-op the caller should short-circuit anyway, and
 * returning [] propagates that signal cleanly rather than NaN.
 */
export function computeInterestProfile(
  vectors: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<number> {
  if (vectors.length === 0) return [];
  const first = vectors[0]!;
  const dim = first.length;
  if (dim === 0) return [];

  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(
        `computeInterestProfile: dim mismatch — expected ${dim}, got ${v.length}`
      );
    }
    for (let i = 0; i < dim; i += 1) {
      sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  const inv = 1 / vectors.length;
  return sum.map((x) => x * inv);
}

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Inlined here (rather than imported from @starkit/vector) because
 * @starkit/core can't depend on @starkit/vector — vector already depends on
 * core, and any reverse edge would close the workspace cycle. Same algebra
 * as @starkit/vector's cosineSimilarity; both should give identical results
 * for the same inputs (the dim-mismatch throw is the only opinionated bit
 * and is intentional in both copies).
 */
export function digestCosine(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>
): number {
  if (a.length !== b.length) {
    throw new Error(`digestCosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;
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

/**
 * Recency boost factor in [0, 1]: 1.0 for a push that happened just now,
 * decaying linearly to 0 at `windowMs` ago. Anything older than windowMs
 * is 0 (i.e., out of the digest window — the orchestrator should have
 * filtered these out, but the function is defensive).
 *
 * The composite score in the orchestrator is
 *   relevance * 0.8 + recency * 0.2
 * — relevance dominates so the digest doesn't degenerate into "whatever was
 * pushed yesterday", but recency breaks ties between similarly-relevant
 * candidates by favoring fresher work.
 */
export function recencyBoost(
  pushedAtMs: number,
  nowMs: number,
  windowMs: number
): number {
  if (windowMs <= 0) return 0;
  const age = nowMs - pushedAtMs;
  if (age < 0) return 1; // future push (clock skew) — treat as "just now"
  if (age >= windowMs) return 0;
  return 1 - age / windowMs;
}
