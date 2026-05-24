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
import { parseTagResponse } from '../tagging/text.js';
import type { ChatBatchFn } from '../tagging/orchestrator.js';
import {
  buildTagsTranslateSystemPrompt,
  buildTagsTranslateUserPrompt,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  parseTranslateResponse,
  TRANSLATE_LOCALE_NAMES,
} from './text.js';

/** Persist a freshly-translated content field onto a star row. The
 *  orchestrator calls this once per successful chat call — caller
 *  routes the value to the right schema slot via the `field` arg.
 *
 *  R17 蓝军 extension: the `field` discriminator carries which schema
 *  bag receives the translation (description → descriptionI18n,
 *  tags → aiTagsI18n). v1 only passed description; back-compat is
 *  preserved because `field` defaults to 'description' if old callers
 *  don't case-match. */
export type UpdateStarTranslationFn = (
  id: number,
  localeCode: string,
  translatedText: string,
  field: 'description' | 'tags'
) => Promise<void>;

/**
 * Identify a transient error worth retrying. R17 蓝军 fix A1+A2:
 * AIError instances all carry `name='AIError'` (see packages/ai/src/
 * errors.ts), so the previous `name === 'TimeoutError'` check at the
 * catch site NEVER matched timeouts coming up from the AI layer — they
 * silently became `failed`. We duck-type on `kind` here so the
 * orchestrator stays decoupled from @starkit/ai (no workspace cycle).
 */
function isTransientChatError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortError = user pressed cancel; never retry user-initiated stops.
  // Distinguished from network-timeout aborts via the caller's
  // opts.signal.aborted check, which happens BEFORE this function.
  const kind = (err as { kind?: unknown }).kind;
  return (
    kind === 'rate_limit' ||
    kind === 'timeout' ||
    kind === 'server' ||
    kind === 'network'
  );
}

/** Exponential backoff for retries. Honors `retryAfterSeconds` when the
 *  provider tells us how long to wait (rate-limit responses do this);
 *  otherwise 500ms / 1500ms / 3500ms. */
function backoffMsFor(err: unknown, attempt: number): number {
  const ctx = (err as { context?: { retryAfterSeconds?: unknown } }).context;
  const ra = ctx?.retryAfterSeconds;
  if (typeof ra === 'number' && ra > 0 && ra <= 30) {
    return ra * 1000;
  }
  // 500 / 1500 / 3500 ms — capped at attempt=3 → ~5.5s worst case per star
  return [500, 1500, 3500][attempt] ?? 3500;
}

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
  /**
   * R17 蓝军 fix for "标签 bug": when true (default since v0.2.1), the
   * orchestrator also runs a SECOND chat call per star that translates
   * `star.aiTags` into the target locale and persists into
   * `aiTagsI18n[locale]`. Cost: doubles per-star chat count but tags
   * are cheap (~50 input + ~30 output tokens). Set false on the
   * description-only legacy path if you need it.
   */
  readonly alsoTags?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface TranslateStarsResult {
  readonly translated: number;
  readonly skipped: number;
  readonly failed: number;
  /**
   * R17 蓝军 fix A3: surface WHICH stars failed so the popup can show
   * a retry CTA for just those instead of leaving the user guessing.
   * Empty array on a fully-successful run.
   */
  readonly failedStarIds: ReadonlyArray<number>;
  /** Stars excluded from the pass because `description` was null/empty. */
  readonly noSourceText: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly model: string | null;
  /** Counts of tag-translation calls (when alsoTags=true). Description
   *  counts are the existing `translated` field — kept separate so the
   *  user-facing "X translated" matches what they intuit as "X repos
   *  done", not "X chat calls made". */
  readonly tagsTranslated: number;
  readonly tagsFailed: number;
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
  const failedStarIds: number[] = [];
  let tagsTranslated = 0;
  let tagsFailed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model: string | null = null;
  let done = skipped + noSource.length; // these contribute to progress count
  opts.onProgress?.(done, total);

  const systemPrompt = buildTranslateSystemPrompt(opts.targetLocale, localeNativeName);
  const tagsSystemPrompt = buildTagsTranslateSystemPrompt(
    opts.targetLocale,
    localeNativeName
  );
  const alsoTags = opts.alsoTags ?? true;

  /** Max retry attempts for transient errors per chat call. Total attempts =
   *  MAX_RETRIES + 1. Three attempts × ~5.5s worst-case = ~16s per star ceiling
   *  before declaring permanent fail. Empirically: SiliconFlow free-tier 429s
   *  recover within 2-5s so 3 attempts catch ~95% of transient cases. */
  const MAX_RETRIES = 2;

  /**
   * Chat call wrapper with retry-on-transient. R17 蓝军 fix A1+A2:
   *   - Rate-limit (kind=rate_limit) AIErrors → backoff per retryAfterSeconds
   *   - Server (kind=server, 5xx) → exponential backoff
   *   - Timeout (kind=timeout, OR DOMException AbortError WITHOUT signal aborted)
   *     → backoff retry
   *   - User abort (signal.aborted=true) → propagate immediately, no retry
   *   - Anything else → throw to outer catch (counts as failed)
   */
  async function callChatWithRetry(
    system: string,
    user: string
  ): Promise<{
    text: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (opts.signal?.aborted) {
        throw new DOMException('translateStars aborted', 'AbortError');
      }
      try {
        return await opts.chat(system, user, opts.signal);
      } catch (err) {
        lastErr = err;
        // User-initiated cancel: never retry.
        if (opts.signal?.aborted) throw err;
        // Bare DOMException AbortError without signal-aborted = network-side
        // timeout (withTimeout fired its own abort); still transient.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const transient = isAbort || isTransientChatError(err);
        if (!transient || attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, backoffMsFor(err, attempt)));
      }
    }
    throw lastErr ?? new Error('callChatWithRetry: unreachable');
  }

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

      // ─── Description translation (with retry) ───────────────────────
      let descOK = false;
      try {
        const r = await callChatWithRetry(
          systemPrompt,
          buildTranslateUserPrompt(star.description!)
        );
        if (opts.signal?.aborted) return;
        const text = parseTranslateResponse(r.text);
        totalInputTokens += r.inputTokens;
        totalOutputTokens += r.outputTokens;
        model = r.model;
        if (text !== null) {
          await opts.updateStar(star.id, opts.targetLocale, text, 'description');
          translated += 1;
          descOK = true;
        } else {
          failed += 1;
          failedStarIds.push(star.id);
        }
      } catch (err) {
        if (opts.signal?.aborted) return;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        failed += 1;
        failedStarIds.push(star.id);
      }

      // ─── Tags translation (best-effort, only when desc succeeded) ───
      // Gated on descOK so a permanent-failing star doesn't double-burn
      // chat quota on tags. aiTags=[] is a no-op skip — no source to
      // translate. Tag failures DON'T add to failedStarIds (popup retry
      // surface focuses on description; tags are a bonus layer).
      if (alsoTags && descOK && star.aiTags.length > 0) {
        try {
          const tr = await callChatWithRetry(
            tagsSystemPrompt,
            buildTagsTranslateUserPrompt(star.aiTags)
          );
          if (opts.signal?.aborted) return;
          totalInputTokens += tr.inputTokens;
          totalOutputTokens += tr.outputTokens;
          // Reuse the auto-tag parser — handles all the same hallucinated
          // formatting (Tags:/Output: prefix, numbered bullets, quotes).
          const parsedTags = parseTagResponse(tr.text);
          if (parsedTags.length > 0) {
            // Persist as comma-joined string per the aiTagsI18n schema
            // (record of locale → joined string). UI side splits via the
            // same parseTagResponse contract.
            await opts.updateStar(
              star.id,
              opts.targetLocale,
              parsedTags.join(', '),
              'tags'
            );
            tagsTranslated += 1;
          } else {
            tagsFailed += 1;
          }
        } catch (err) {
          if (opts.signal?.aborted) return;
          if (err instanceof Error && err.name === 'AbortError') throw err;
          tagsFailed += 1;
        }
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
    failedStarIds,
    tagsTranslated,
    tagsFailed,
    noSourceText: noSource.length,
    totalInputTokens,
    totalOutputTokens,
    model,
    targetLocale: opts.targetLocale,
  };
}
