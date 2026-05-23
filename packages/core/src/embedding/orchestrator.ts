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
 * The "call provider.embed once" callback. Shape matches AIProvider.embed
 * minus the `dim` field (caller computes it from vectors[0].length if needed)
 * and minus `signal` (the orchestrator routes its own signal in).
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
 */
export type VectorUpsertFn = (
  rows: ReadonlyArray<EmbeddingRow>
) => Promise<{ inserted: number; updated: number }>;

/**
 * VectorStore.get shape — also narrowed. Only contentHash is consulted, so
 * callers can return a slimmer record than full VectorRow if they want.
 */
export type VectorLookupFn = (
  id: string
) => Promise<{ metadata?: { contentHash?: string } } | null>;

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
 * Abort model: an aborted signal interrupts BEFORE the next batch starts.
 * In-flight provider.embed calls receive the same signal and should reject
 * with AbortError, which propagates out of embedStars unchanged.
 */
export async function embedStars(
  opts: EmbedStarsOptions
): Promise<EmbedStarsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize < 1) {
    throw new Error(`embedStars: batchSize must be >= 1, got ${batchSize}`);
  }

  const allStars = await opts.starStore.list({
    limit: Number.POSITIVE_INFINITY,
  });
  const total = allStars.length;

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let model: string | null = null;
  let batches = 0;
  let done = 0;

  // Walk the star list in fixed-size batches. The "skip via contentHash"
  // filtering happens INSIDE each batch so a batch where every star is
  // already embedded becomes zero provider calls (instead of one wasted call
  // returning vectors we won't use).
  for (let i = 0; i < allStars.length; i += batchSize) {
    if (opts.signal?.aborted) {
      throw new DOMException('embedStars aborted', 'AbortError');
    }

    const batchStars = allStars.slice(i, i + batchSize);

    // Filter out rows whose contentHash matches what's stored.
    const toEmbed: Array<{
      readonly star: StarredRepo;
      readonly input: string;
      readonly hash: string;
    }> = [];
    for (const star of batchStars) {
      const hash = contentHash(star);
      if (opts.getExisting) {
        const existing = await opts.getExisting(`star:${star.id}`);
        if (existing?.metadata?.contentHash === hash) {
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
      const embedResult = await opts.embed(
        toEmbed.map((x) => x.input),
        opts.signal
      );

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
      // AbortError is the user-initiated cancel path — surface it instead
      // of swallowing as a failed batch.
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')
      ) {
        throw err;
      }
      // Any other error (network, provider 5xx, schema mismatch) costs us
      // this batch's rows in the `failed` tally. We continue so a single
      // bad batch doesn't strand the rest of the index.
      failed += toEmbed.length;
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
  };
}
