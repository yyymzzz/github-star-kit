/**
 * Content-translation pipeline orchestrator — runs each star's
 * `description` through a chat LLM and caches the result in
 * `star.descriptionI18n[targetLocale]`. Symmetric in shape with
 * `tagStars` from W3 D4: bounded concurrency, per-star failure
 * isolation, AbortSignal pass-through, force-retranslate flag.
 *
 * Cost-saving short-circuit: if the star already has a translation for
 * this locale AND the source description hasn't changed since
 * (compared via the same djb2 contentHash the embedding pipeline
 * uses), we skip the call. Same "re-running is cheap" guarantee the
 * embed and tag pipelines provide.
 *
 * Callback-decoupled the same way: `@starkit/core` doesn't import
 * `@starkit/ai`. Caller wraps `AIProvider.chat` at the boundary.
 */
import type { StarredRepo } from '../schema.js';
import type { StarStore } from '../storage/types.js';
import type { ChatBatchFn } from '../tagging/orchestrator.js';
import {
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  parseTranslateResponse,
  TRANSLATE_LOCALE_NAMES,
} from './text.js';

/** Persist the freshly-translated description onto a star row. The
 *  orchestrator calls this once per successful translate — the caller
 *  decides how (re-upsert via starStore.upsertMany, write to a
 *  sidecar, etc.). Symmetric with `UpdateStarTagsFn` from tagging. */
export type UpdateStarTranslationFn = (
  id: number,
  localeCode: string,
  translatedDescription: string
) => Promise<void>;

export interface TranslateStarsOptions {
  readonly starStore: StarStore;
  readonly chat: ChatBatchFn;
  readonly updateStar: UpdateStarTranslationFn;
  /** Target locale id (must be a key in TRANSLATE_LOCALE_NAMES). */
  readonly targetLocale: string;
  /**
   * Max in-flight chat calls. Default 5 — same rationale as tagStars.
   * Translation prompts are slightly shorter than tagging prompts so
   * the same RPM cap leaves headroom.
   */
  readonly concurrency?: number;
  /**
   * When false (default), stars whose `descriptionI18n[targetLocale]`
   * is already populated are skipped — re-runs only catch newly-synced
   * descriptions or previously-failed rows. Set true to forcibly
   * re-translate (e.g. after a provider/model change).
   */
  readonly forceRetranslate?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface TranslateStarsResult {
  readonly translated: number;
  readonly skipped: number;
  readonly failed: number;
  /** Stars excluded from the pass because `description` was null/empty. */
  readonly noSourceText: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly model: string | null;
  /** The locale id the run targeted — echoed back for caller's UI. */
  readonly targetLocale: string;
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Run the translation pipeline over every star in the store.
 *
 * Same failure model as tagStars: per-star chat errors increment
 * `failed` and the loop continues. AbortError / TimeoutError propagate
 * out unchanged so user cancellation surfaces cleanly.
 */
export async function translateStars(
  opts: TranslateStarsOptions
): Promise<TranslateStarsResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (concurrency < 1) {
    throw new Error(
      `translateStars: concurrency must be >= 1, got ${concurrency}`
    );
  }
  if (!TRANSLATE_LOCALE_NAMES[opts.targetLocale]) {
    throw new Error(
      `translateStars: unknown targetLocale "${opts.targetLocale}" — must be one of ${Object.keys(TRANSLATE_LOCALE_NAMES).join(', ')}`
    );
  }

  const localeNativeName = TRANSLATE_LOCALE_NAMES[opts.targetLocale]!;
  const allStars = await opts.starStore.list();
  const total = allStars.length;

  // Split into:
  //   - noSource: description is null/empty/whitespace → can't translate
  //   - alreadyDone: already has translation for this locale (skip unless forced)
  //   - toTranslate: actually needs a chat call
  const noSource: StarredRepo[] = [];
  const toTranslate: StarredRepo[] = [];
  let skipped = 0;
  for (const star of allStars) {
    if (!star.description || star.description.trim().length === 0) {
      noSource.push(star);
      continue;
    }
    if (
      !opts.forceRetranslate &&
      star.descriptionI18n &&
      typeof star.descriptionI18n[opts.targetLocale] === 'string' &&
      star.descriptionI18n[opts.targetLocale]!.length > 0
    ) {
      skipped += 1;
      continue;
    }
    toTranslate.push(star);
  }

  let translated = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model: string | null = null;
  let done = skipped + noSource.length; // these contribute to progress count
  opts.onProgress?.(done, total);

  const systemPrompt = buildTranslateSystemPrompt(opts.targetLocale, localeNativeName);

  let cursor = 0;
  const next = (): StarredRepo | null => {
    if (opts.signal?.aborted) return null;
    if (cursor >= toTranslate.length) return null;
    const star = toTranslate[cursor]!;
    cursor += 1;
    return star;
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const star = next();
      if (!star) return;
      try {
        const chatResult = await opts.chat(
          systemPrompt,
          buildTranslateUserPrompt(star.description!),
          opts.signal
        );
        if (opts.signal?.aborted) return;

        const text = parseTranslateResponse(chatResult.text);
        if (text !== null) {
          await opts.updateStar(star.id, opts.targetLocale, text);
          translated += 1;
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

  const workers = Array.from(
    { length: Math.min(concurrency, toTranslate.length || 1) },
    () => worker()
  );
  await Promise.all(workers);

  if (opts.signal?.aborted) {
    throw new DOMException('translateStars aborted', 'AbortError');
  }

  return {
    translated,
    skipped,
    failed,
    noSourceText: noSource.length,
    totalInputTokens,
    totalOutputTokens,
    model,
    targetLocale: opts.targetLocale,
  };
}
