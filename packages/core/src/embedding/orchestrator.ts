/**
 * Embedding pipeline orchestrator — turns starred repos into vector rows.
 *
 *   starStore → buildStarEmbeddingInput → embed(batch) → upsert(rows)
 *
 * Like syncStarsWithStore, this is storage- AND provider-agnostic by design.
 * The caller wires the actual provider.embed and vectorStore.upsertMany
 * functions in. That keeps @starkit/core free of @starkit/ai and
 * @starkit/vector dependencies (preventing a workspace dep cycle) while
 * still owning the "what is the right thing to embed and when" policy.
 *
 * Cost short-circuit: if the caller supplies `getExisting`, the orchestrator
 * skips rows whose contentHash matches what's already in the vector store.
 * For a typical post-sync run where 95% of stars have unchanged
 * description / language / topics, that's a 20× cost reduction.
 */
import { callWithRetry, createFailureRecorder } from '../ai-retry.js';
import type { StarredRepo } from '../schema.js';
import type { StarStore } from '../storage/types.js';
import { buildStarEmbeddingInput, contentHash } from './text.js';

/**
 * What the orchestrator writes into the vector store. The metadata block
 * carries everything search-time + cost-debug surfaces need: the GitHub id
 * for joining back to starStore, the contentHash for skip-detection on
 * subsequent runs, and the model for "this row's vector is from gpt-3 vs
 * voyage-3" disambiguation.
 */
export interface EmbeddingRow {
  /** Namespaced id; convention: `star:${githubId}`. */
  readonly id: string;
  readonly vector: ReadonlyArray<number>;
  readonly metadata: {
    readonly starId: number;
    readonly contentHash: string;
    readonly model: string;
    readonly embeddedAt: string;
  };
}

/**
 * The "call provider.embed once" callback.
 *
 * NOTE on shape vs `AIProvider.embed`: this callback is `(inputs, signal?) =>
 * Promise<...>` — positional args — while `AIProvider.embed` takes a single
 * `EmbedRequest` object. You CANNOT pass `provider.embed.bind(provider)`
 * directly; wrap with a one-liner at the call site:
 *
 *   embedStars({
 *     embed: (inputs, signal) => provider.embed({ inputs, signal }),
 *     ...
 *   });
 *
 * The return shape is a strict subset of `EmbedResponse` (omits `dim`); the
 * full `EmbedResponse` is structurally assignable here, so the adapter just
 * forwards the response unchanged. Keeping this callback storage-agnostic is
 * what lets @starkit/core stay free of an @starkit/ai workspace dep.
 */
export type EmbedBatchFn = (
  inputs: ReadonlyArray<string>,
  signal?: AbortSignal
) => Promise<{
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  readonly model: string;
  readonly inputTokens: number;
}>;

/**
 * VectorStore.upsertMany shape — narrowed to the minimum the orchestrator
 * needs so callers don't have to satisfy the entire VectorStore interface.
 *
 * Variance: parameter is contravariant — a function that accepts the wider
 * `ReadonlyArray<VectorRow>` (like `vec.upsertMany`) IS assignable to this
 * field because `EmbeddingRow` is structurally a `VectorRow` (`metadata`
 * being a `Record<string, unknown>` admits any keyed object including
 * EmbeddingRow's strict shape). The popup wires this directly as
 * `upsert: (rows) => vec.upsertMany(rows)` without an adapter.
 */
export type VectorUpsertFn = (
  rows: ReadonlyArray<EmbeddingRow>
) => Promise<{ inserted: number; updated: number }>;

/**
 * VectorStore.get shape — accepts the wider `Record<string, unknown>` metadata
 * so callers can pass `vectorStore.get` (which returns `VectorRow | null`)
 * directly without an adapter. The orchestrator narrows `metadata.contentHash`
 * with a `typeof` runtime check, so a non-string value (or a row written by an
 * older orchestrator version) safely fails the skip check instead of producing
 * a type-unsound comparison.
 *
 * Type-compat note: a narrower `{ contentHash?: string }` return type would
 * NOT accept `VectorStore.get`'s return — `Record<string, unknown>` is not
 * assignable to `{ contentHash?: string }` because the `unknown` value isn't
 * assignable to `string | undefined`. Loosening here is the only way the
 * popup wiring `getExisting: (id) => vec.get(id)` typechecks.
 */
export type VectorLookupFn = (
  id: string
) => Promise<{ metadata?: Record<string, unknown> } | null>;

export interface EmbedStarsOptions {
  readonly starStore: StarStore;
  readonly embed: EmbedBatchFn;
  readonly upsert: VectorUpsertFn;
  /**
   * Optional. When supplied, the orchestrator looks each star up by
   * `star:${id}` and SKIPS the embed call if the stored contentHash matches
   * the freshly-computed one. This is the cost-savings short-circuit; omit
   * to force re-embedding (useful when changing models).
   */
  readonly getExisting?: VectorLookupFn;
  /**
   * Rows per provider.embed call. 32 is a defensible default:
   *   - OpenAI text-embedding-3-small accepts up to 2048 inputs / call;
   *     32 is well below that and keeps a single failure's blast radius
   *     small (worst case: 32 stars need a retry instead of all of them).
   *   - Voyage caps at 128.
   *   - Ollama processes inputs serially internally, so batch size matters
   *     less for it.
   */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  /**
   * Fires after each batch — both successful and skipped-because-cached.
   * `done` is rows processed so far (embedded + skipped + failed);
   * `total` is the count from starStore at the start of the run.
   */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface EmbedStarsResult {
  /** Rows actually sent through the provider and upserted. */
  readonly embedded: number;
  /** Rows skipped because their contentHash already existed in the index. */
  readonly skipped: number;
  /** Rows we tried to embed but a batch error swallowed. */
  readonly failed: number;
  /** Sum of inputTokens reported across all successful batches. */
  readonly totalInputTokens: number;
  /** Model name from the LAST successful batch — null if every batch failed. */
  readonly model: string | null;
  /** How many provider.embed calls were made (excludes skipped batches). */
  readonly batches: number;
  /**
   * R20 蓝军 fix: ids of stars whose batch FAILED to embed/upsert. UI can
   * show a "retry these N stars" CTA instead of leaving the user guessing.
   * Empty array on a fully-successful run. Mirrors translate's failedStarIds.
   *
   * Dedupe contract: each id appears at most once per run. A "retry
   * persistent failures" loop that re-feeds this list across runs must
   * dedupe itself — the orchestrator does NOT carry prior-run state.
   */
  readonly failedStarIds: ReadonlyArray<number>;
  /**
   * R20 蓝军 fix: the specific AIError kind from the LAST failure, if any.
   * Lets the caller distinguish "auth — fix your key" from "rate_limit —
   * try later" from "network — check connection". null when no failures
   * or when failures came from non-AIError sources (dim mismatch, etc).
   */
  readonly lastErrorKind: string | null;
  /**
   * R20 蓝军 fix: human-readable message from the LAST failure, surfaced
   * verbatim by the popup so the user sees the actual provider error
   * instead of just a "0 embedded" count.
   */
  readonly lastErrorMessage: string | null;
}

/** Default batch size — see EmbedStarsOptions.batchSize for rationale. */
const DEFAULT_BATCH_SIZE = 32;

/**
 * Run one full embed pass over the starStore.
 *
 * Failure model: a single batch failure increments `failed` by that batch's
 * size and the loop continues. We do NOT retry inside the orchestrator —
 * provider clients already wrap network calls in their own retry / timeout
 * policy (see packages/ai/src/utils/timeout.ts); piling retries on top would
 * compound the time budget. Callers that want a hard guarantee can re-invoke
 * embedStars after a failed run — already-embedded rows are skipped via
 * contentHash, so retries are cheap.
 *
 * Abort model: between-batch granularity. `opts.signal?.aborted` is checked
 * at the top of each batch iteration and AFTER each provider.embed returns,
 * so a signal that aborts during an in-flight embed call surfaces as soon as
 * that call resolves (the provider is also passed the signal and SHOULD
 * reject mid-flight with AbortError if it honors AbortController — but a
 * provider that ignores the signal can hang up to one batch). All embedded
 * rows that already landed via earlier batches' upsert calls remain — abort
 * is a stop, not a rollback.
 */
export async function embedStars(
  opts: EmbedStarsOptions
): Promise<EmbedStarsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize < 1) {
    throw new Error(`embedStars: batchSize must be >= 1, got ${batchSize}`);
  }

  // No options = default ordering (starredAt DESC) + no limit. We deliberately
  // do NOT pass `{ limit: Number.POSITIVE_INFINITY }` — that works on the
  // memory backend by accident (`array.slice(0, offset + Infinity)` is treated
  // as "to end") but the StarStoreListOptions contract does not promise this,
  // and a future sqlite-vec / IndexedDB cursor-paged backend could legitimately
  // round Infinity to 0 and return nothing. The orchestrator wants every row;
  // letting the default speak is the safer contract.
  const allStars = await opts.starStore.list();
  const total = allStars.length;

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let model: string | null = null;
  let batches = 0;
  let done = 0;
  const failedStarIds: number[] = [];
  // R28 蓝军 (R26 MAJOR #1 fan-out): shared priority-aware FailureRecorder.
  // v1's bare "last-writer-wins" let a dim-mismatch generic Error clobber
  // a concurrent rate_limit AIError — user saw the less actionable
  // message. The recorder enforces AIError > generic Error > weak fallback.
  const failure = createFailureRecorder();

  // Walk the star list in fixed-size batches. The "skip via contentHash"
  // filtering happens INSIDE each batch so a batch where every star is
  // already embedded becomes zero provider calls (instead of one wasted call
  // returning vectors we won't use).
  for (let i = 0; i < allStars.length; i += batchSize) {
    if (opts.signal?.aborted) {
      throw new DOMException('embedStars aborted', 'AbortError');
    }

    const batchStars = allStars.slice(i, i + batchSize);
    // Pre-compute hashes for every star in the batch — a sync, cheap op (djb2
    // over composed text), worth doing before the parallel I/O fan-out below.
    const hashes = batchStars.map((s) => contentHash(s));

    // Filter out rows whose contentHash matches what's stored.
    // R5 蓝军 fix: fan getExisting() out in parallel. Doing this serially
    // burned ~1.6s per batch on a 50ms-IDB latency (batchSize=32 × 50ms),
    // so at 1000 stars / 32 batches that was ~50s of pure wait. Promise.all
    // collapses to a single batch RTT.
    const existings = opts.getExisting
      ? await Promise.all(
          batchStars.map((s) => opts.getExisting!(`star:${s.id}`))
        )
      : null;

    const toEmbed: Array<{
      readonly star: StarredRepo;
      readonly input: string;
      readonly hash: string;
    }> = [];
    for (let j = 0; j < batchStars.length; j += 1) {
      const star = batchStars[j]!;
      const hash = hashes[j]!;
      if (existings) {
        const existing = existings[j];
        // Runtime-narrow `metadata.contentHash` from `unknown` (the type of
        // values in a `Record<string, unknown>` metadata) down to `string`.
        // A non-string contentHash is treated as "no hash" — we'd rather
        // re-embed once than skip on a corrupt comparison.
        const existingHash = existing?.metadata?.['contentHash'];
        if (typeof existingHash === 'string' && existingHash === hash) {
          skipped += 1;
          continue;
        }
      }
      toEmbed.push({
        star,
        input: buildStarEmbeddingInput(star),
        hash,
      });
    }

    if (toEmbed.length === 0) {
      done += batchStars.length;
      opts.onProgress?.(done, total);
      continue;
    }

    try {
      // R20 蓝军 fix: wrap embed in callWithRetry. The v1 catch only matched
      // err.name === 'AbortError' || 'TimeoutError' — but AIError sets
      // name='AIError' (packages/ai/src/errors.ts:32), so every transient
      // AIError (rate_limit/timeout/server/network/parse) silently turned
      // into `failed += toEmbed.length` with zero retry. The shared helper
      // duck-types on `err.kind` and retries up to 3x with exp-backoff.
      const embedResult = await callWithRetry(
        () => opts.embed(toEmbed.map((x) => x.input), opts.signal),
        opts.signal ? { signal: opts.signal } : {}
      );

      // Re-check abort RIGHT AFTER embed returns. If the signal aborted while
      // the call was in flight and the provider honored it, we already threw;
      // if the provider IGNORED the signal, we'd otherwise upsert a batch the
      // user asked us to abandon. This catches the lazy-provider case.
      if (opts.signal?.aborted) {
        throw new DOMException('embedStars aborted', 'AbortError');
      }

      // Provider contract sanity: vectors[i] corresponds to inputs[i]. A
      // length mismatch means the provider misaligned the response — we'd
      // upsert wrong vectors against wrong ids. Fail the batch loudly
      // rather than silently corrupt the index.
      if (embedResult.vectors.length !== toEmbed.length) {
        throw new Error(
          `embedStars: provider returned ${embedResult.vectors.length} vectors for ${toEmbed.length} inputs`
        );
      }

      const now = new Date().toISOString();
      const rows: EmbeddingRow[] = toEmbed.map((x, idx) => ({
        id: `star:${x.star.id}`,
        vector: embedResult.vectors[idx]!,
        metadata: {
          starId: x.star.id,
          contentHash: x.hash,
          model: embedResult.model,
          embeddedAt: now,
        },
      }));

      await opts.upsert(rows);

      embedded += toEmbed.length;
      totalInputTokens += embedResult.inputTokens;
      model = embedResult.model;
      batches += 1;
    } catch (err) {
      // R20 蓝军 fix: AbortError only propagates when CALLER initiated it.
      // Bare DOMException AbortError (from withTimeout's internal controller)
      // is exhausted-retry transient → counts as failed like other errors.
      // The shared callWithRetry already retried it up to maxRetries.
      if (err instanceof Error && err.name === 'AbortError' && opts.signal?.aborted) {
        throw err;
      }
      // R20 蓝军 fix: surface WHICH stars + the error context so the popup
      // can show a meaningful "X failed: <provider msg>" instead of silent
      // "0 embedded". The catch can fire for: callWithRetry exhausting
      // retries on a transient, a permanent AIError (auth/bad_request), a
      // dim-mismatch from the provider-contract sanity check, or an upsert
      // throw. All count as this batch failing.
      failed += toEmbed.length;
      for (const x of toEmbed) failedStarIds.push(x.star.id);
      // R28 fan-out: FailureRecorder handles all 3 tiers (AIError > Error
      // > weak fallback). Non-Error throws fall to fallback path.
      failure.record(err, String(err));
    }

    done += batchStars.length;
    opts.onProgress?.(done, total);
  }

  return {
    embedded,
    skipped,
    failed,
    totalInputTokens,
    model,
    batches,
    failedStarIds,
    lastErrorKind: failure.getKind(),
    lastErrorMessage: failure.getMessage(),
  };
}
