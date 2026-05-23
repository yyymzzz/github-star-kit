/**
 * Per-entry LLM summary for the weekly digest.
 *
 * `generateDigest` produces relevance-ranked entries; this module adds the
 * "why this matters to you" hook on top by running each top-N entry through
 * a one-shot chat call. Kept separate from the orchestrator so callers who
 * don't want to spend LLM budget on summaries can skip it cleanly.
 *
 * Cost: ~150 input + ~40 output tokens per entry on gpt-4o-mini. A 10-entry
 * digest costs ~$0.0007 — well under any sane budget. Bounded concurrency
 * (default 3) keeps wall clock around 2-3 seconds total even on slower
 * providers.
 */
import type { StarredRepo } from '../schema.js';
import type { ChatBatchFn } from '../tagging/orchestrator.js';
import type { DigestEntry } from './orchestrator.js';

/**
 * System prompt — held constant so providers that support prompt caching
 * (Anthropic, OpenAI) can amortize it across the batch.
 */
export const DIGEST_SUMMARY_SYSTEM_PROMPT = [
  'You are a senior developer reviewing a starred GitHub repository that',
  'was recently updated. Write a 1-2 sentence "why this matters to you" hook',
  'focused on what kind of work the repo enables or what its recent activity',
  'likely signals. Stay specific to the repo\'s purpose — never generic',
  'praise like "This is a great repo!".',
  'No salutation, no markdown, no preamble. Just the hook.',
].join('\n');

/**
 * Compose the per-entry user prompt. Pulls in every signal the model could
 * use to make the hook specific: name, language, description, topics, the
 * AI tags from W3 D4 (so a "rust async runtime" tag gives the hook
 * something concrete to anchor to), and the relevance score (lets the model
 * calibrate confidence — a 90% relevance hook can be more assertive than
 * a 50% one).
 */
export function buildDigestSummaryPrompt(
  star: StarredRepo,
  score: number
): string {
  const lines: string[] = [`Repo: ${star.fullName}`];
  if (star.language !== null && star.language.length > 0) {
    lines.push(`Language: ${star.language}`);
  }
  if (star.description !== null && star.description.length > 0) {
    lines.push(`Description: ${star.description}`);
  }
  if (star.topics.length > 0) {
    lines.push(`GitHub topics: ${star.topics.join(', ')}`);
  }
  if (star.aiTags.length > 0) {
    lines.push(`Tags: ${star.aiTags.join(', ')}`);
  }
  lines.push(`Relevance to your interest profile: ${(score * 100).toFixed(0)}%`);
  return lines.join('\n');
}

export interface SummarizeOptions {
  /** Max in-flight chat calls. Default 3. Same rationale as tagStars:
   *  small enough to stay under typical RPM caps, large enough that 10
   *  entries finish in ~3s wall clock instead of ~10s. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

/**
 * Returns a copy of `entries` where each one has `summary` populated when
 * the chat call succeeded. Failed entries (provider error, empty response,
 * etc.) come back unchanged — the caller renders them without a hook.
 *
 * Concurrency model: same bounded-worker pool as tagStars. AbortError /
 * TimeoutError propagate out unchanged; any other per-entry error is
 * swallowed and that entry keeps its undefined summary.
 */
export async function summarizeDigestEntries(
  entries: ReadonlyArray<DigestEntry>,
  chat: ChatBatchFn,
  opts: SummarizeOptions = {}
): Promise<ReadonlyArray<DigestEntry>> {
  const concurrency = opts.concurrency ?? 3;
  if (concurrency < 1) {
    throw new Error(
      `summarizeDigestEntries: concurrency must be >= 1, got ${concurrency}`
    );
  }
  if (entries.length === 0) return [];

  // Collect summaries by index so we can rebuild the readonly entries
  // immutably at the end. Map (not Array) because we only write keys for
  // entries that actually produced a usable hook.
  const summaries = new Map<number, string>();

  let cursor = 0;
  const next = (): number | null => {
    if (opts.signal?.aborted) return null;
    if (cursor >= entries.length) return null;
    const i = cursor;
    cursor += 1;
    return i;
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next();
      if (idx === null) return;
      const entry = entries[idx]!;
      try {
        const result = await chat(
          DIGEST_SUMMARY_SYSTEM_PROMPT,
          buildDigestSummaryPrompt(entry.star, entry.score),
          opts.signal
        );
        if (opts.signal?.aborted) return;
        const text = result.text.trim();
        if (text.length > 0) summaries.set(idx, text);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError')
        ) {
          throw err;
        }
        // Swallow other errors — the entry keeps its undefined summary.
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, entries.length) },
    () => worker()
  );
  await Promise.all(workers);

  if (opts.signal?.aborted) {
    throw new DOMException('summarizeDigestEntries aborted', 'AbortError');
  }

  // Rebuild entries with summaries filled in. Entries without a summary
  // come through unchanged.
  return entries.map((e, i) => {
    const s = summaries.get(i);
    return s !== undefined ? { ...e, summary: s } : e;
  });
}
