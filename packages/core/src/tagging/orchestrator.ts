/**
 * Tagging pipeline orchestrator — runs starred repos through a chat LLM to
 * generate 3-5 short tags per repo, persisted into `star.aiTags`.
 *
 * Same callback-based decoupling as embedStars: @starkit/core stays free of
 * @starkit/ai workspace dep, the caller adapts AIProvider.chat at the wiring
 * layer. Cost-per-repo is ~$0.00006 on gpt-4o-mini, so a 1000-star tagging
 * pass is ~$0.06 — under the W3 budget.
 *
 * Concurrency model: per-star calls fan out up to `concurrency` in flight,
 * which is the dial that trades wall-clock for rate-limit pressure. OpenAI
 * gpt-4o-mini sits at ~3500 RPM for a free-tier key; 5 concurrent calls is
 * a safe default that gets 1000 stars done in ~3 minutes without hitting
 * the per-minute cap.
 *
 * Failure model: a per-star chat error increments `failed` and skips that
 * star — others continue. Re-running the orchestrator re-tags only the
 * stars without aiTags (unless forceRetag=true), so a transient failure
 * is cheap to recover from.
 */
import type { StarredRepo } from '../schema.js';
import type { StarStore } from '../storage/types.js';
import { buildTagUserPrompt, parseTagResponse, TAG_SYSTEM_PROMPT } from './text.js';

/**
 * The "call provider.chat once" callback. Shape mirrors `AIProvider.chat`
 * minus the request envelope — the orchestrator passes system + user
 * positionally because every call uses the same fixed system prompt.
 *
 * Adapter at the wiring layer:
 *   const chat = (system, user, signal) =>
 *     provider.chat({ system, user, signal }).then(r => ({
 *       text: r.text,
 *       inputTokens: r.inputTokens,
 *       outputTokens: r.outputTokens,
 *       model: r.model,
 *     }));
 */
export type ChatBatchFn = (
  system: string,
  user: string,
  signal?: AbortSignal
) => Promise<{
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}>;

/**
 * Persist freshly-tagged aiTags onto the star row. The orchestrator calls
 * this once per successful tagging — the caller decides how (re-upsert via
 * starStore.upsertMany, write to a sidecar store, etc.).
 */
export type UpdateStarTagsFn = (
  id: number,
  aiTags: ReadonlyArray<string>
) => Promise<void>;

export interface TagStarsOptions {
  readonly starStore: StarStore;
  readonly chat: ChatBatchFn;
  readonly updateStar: UpdateStarTagsFn;
  /**
   * Max in-flight chat calls. Default 5. Tradeoff: higher = faster wall
   * clock, but more rate-limit pressure. OpenAI free-tier RPM caps for
   * gpt-4o-mini sit around 3500/min, so 5 in flight + ~1s/call leaves
   * headroom; on paid tiers (~10k RPM) bumping to 20+ is safe.
   */
  readonly concurrency?: number;
  /**
   * When false (default), stars whose `aiTags` is already non-empty are
   * skipped — re-runs only catch new / previously-failed rows. Set true
   * to forcibly re-tag everything (e.g. after switching models).
   */
  readonly forceRetag?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface TagStarsResult {
  readonly tagged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly model: string | null;
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Run the tagging pipeline over every star in the store.
 */
export async function tagStars(
  opts: TagStarsOptions
): Promise<TagStarsResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (concurrency < 1) {
    throw new Error(
      `tagStars: concurrency must be >= 1, got ${concurrency}`
    );
  }

  const allStars = await opts.starStore.list();
  const total = allStars.length;

  // Filter out already-tagged stars BEFORE the concurrent fan-out so the
  // skip count is accurate even if the pipeline is aborted partway.
  const toTag: StarredRepo[] = [];
  let skipped = 0;
  for (const star of allStars) {
    if (!opts.forceRetag && star.aiTags.length > 0) {
      skipped += 1;
      continue;
    }
    toTag.push(star);
  }

  let tagged = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model: string | null = null;
  let done = skipped; // skipped stars are "done" — they count toward progress

  opts.onProgress?.(done, total);

  // Bounded concurrency via a worker pool. Cleaner than throttle libs:
  // start `concurrency` workers, each pulls the next star and processes it,
  // exits when the queue is empty. The orchestrator awaits all workers.
  let cursor = 0;
  const next = (): StarredRepo | null => {
    if (opts.signal?.aborted) return null;
    if (cursor >= toTag.length) return null;
    const star = toTag[cursor]!;
    cursor += 1;
    return star;
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const star = next();
      if (!star) return;
      try {
        const chatResult = await opts.chat(
          TAG_SYSTEM_PROMPT,
          buildTagUserPrompt(star),
          opts.signal
        );
        // Same post-await abort safety as embedStars — if signal aborted
        // mid-call and the provider ignored it, we still bail before
        // persisting tags the user asked us to abandon.
        if (opts.signal?.aborted) return;

        const tags = parseTagResponse(chatResult.text);
        // Empty tag list = the model returned only sentence-length entries
        // or empty text. Don't persist [] — leaving aiTags as-is means a
        // future re-run will try again, which is the right behavior.
        if (tags.length > 0) {
          await opts.updateStar(star.id, tags);
          tagged += 1;
        } else {
          failed += 1;
        }
        totalInputTokens += chatResult.inputTokens;
        totalOutputTokens += chatResult.outputTokens;
        model = chatResult.model;
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError')
        ) {
          throw err;
        }
        failed += 1;
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, toTag.length || 1) }, () =>
    worker()
  );
  await Promise.all(workers);

  // Final abort check — if any worker exited early via aborted-signal,
  // surface the AbortError to the caller. Workers that returned without
  // throwing on abort look like "early completion" otherwise.
  if (opts.signal?.aborted) {
    throw new DOMException('tagStars aborted', 'AbortError');
  }

  return {
    tagged,
    skipped,
    failed,
    totalInputTokens,
    totalOutputTokens,
    model,
  };
}
