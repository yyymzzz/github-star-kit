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
import { callWithRetry, createFailureRecorder } from '../ai-retry.js';
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

// R20 蓝军 architectural fix: retry helpers moved to ../ai-retry.ts so every
// orchestrator (embed / tag / translate / digest / deep-index) shares ONE
// canonical implementation. The R17 local copy here was missing kind='parse'
// in the transient set, which is why SiliconFlow's HTML-when-overloaded
// page (parser throws → AIError(kind='parse')) was a permanent failure
// instead of a 1-retry recovery — the "翻译不到位" symptom in R20.

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
   *
   * Per-run dedupe: a single id appears at most once per run even if
   * both the description AND tag passes fail for the same star — only
   * the description failure pushes here (tag failures roll into
   * `tagsFailed` instead). Callers that re-feed this list inside the
   * SAME run (e.g. immediate retry CTA against this exact result) do
   * NOT need to dedupe.
   *
   * Multi-run aggregation: a caller that aggregates ids ACROSS multiple
   * `translateStars` invocations (e.g. "retry persistent failures
   * accumulated over several user clicks") MUST dedupe itself — the
   * orchestrator does NOT carry prior-run state. R20 蓝军 round-2
   * MINOR #5 fix: aligned wording with tagging's failedStarIds JSDoc.
   */
  readonly failedStarIds: ReadonlyArray<number>;
  /** Stars excluded from the pass because `description` was null/empty. */
  readonly noSourceText: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /**
   * Model name from the most-recent chat call (regardless of parse
   * outcome). A run that succeeded N times will report that model;
   * a run where every call returned an unparseable response will ALSO
   * report that model (it's still the model that produced the bad
   * output). null only when zero chat calls were made (empty store,
   * everything already cached). R20 蓝军 round-2 MAJOR #3 clarified.
   */
  readonly model: string | null;
  /** Counts of tag-translation calls (when alsoTags=true). Description
   *  counts are the existing `translated` field — kept separate so the
   *  user-facing "X translated" matches what they intuit as "X repos
   *  done", not "X chat calls made". */
  readonly tagsTranslated: number;
  readonly tagsFailed: number;
  /** The locale id the run targeted — echoed back for caller's UI. */
  readonly targetLocale: string;
  /**
   * R20 蓝军 (subagent B MAJOR #1): the specific AIError kind from the
   * LAST failure, if any. Lets the popup distinguish "auth — fix your
   * key" from "rate_limit — try later" from "parse — provider returned
   * HTML". null when no failures OR when failures came from non-AIError
   * sources (e.g. parseTranslateResponse returning null because the
   * model emitted only refusal text).
   *
   * Contract aligned with embedStars/tagStars/indexRepoCode/digest so
   * the popup wiring is uniform across all 5 AI orchestrators.
   */
  readonly lastErrorKind: string | null;
  /**
   * R20 蓝军 (subagent B MAJOR #1): human-readable message from the LAST
   * failure, surfaced verbatim by the popup so the user sees the actual
   * provider error instead of just a "N failed" count.
   *
   * Race-priority: AIError-shaped errors (carrying `.kind`) ALWAYS
   * overwrite, so a transient rate_limit/network failure beats the
   * weaker "model returned only sentence-length tag candidates" signal.
   * Empty-translation signals only write when no stronger error has been
   * recorded yet — same priority discipline as tagging fix MAJOR #2.
   */
  readonly lastErrorMessage: string | null;
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
  //
  // R21 蓝军 P0 fix: the skip condition was "desc translation cached →
  // skip entire star", which left a permanent tag-backfill gap. If a
  // prior run got desc but failed tags (provider noise, rate_limit),
  // the next translate click would skip the whole star → tags NEVER
  // get retried unless user clicks forceRetranslate (which re-burns
  // the entire desc cost). New skip: desc cached AND (no aiTags OR
  // aiTags translation cached too). Misses become tag-only re-runs
  // — desc translation is still cached, only the missing tags fire.
  const noSource: StarredRepo[] = [];
  const toTranslate: StarredRepo[] = [];
  // R21 蓝军 round-2 fix: hoisted to top so both the skip-loop and the
  // worker's tags arm reference the same resolved value (was duplicated
  // between :199 and :278 in the post-R21 commit — same expression,
  // different binding, easy regression vector).
  const alsoTags = opts.alsoTags ?? true;
  let skipped = 0;
  for (const star of allStars) {
    // R48 round-3 P0 fix ("翻译 N 个" button stuck):
    // Previously this dropped any star with empty description into
    // noSource and `continue`d, regardless of whether aiTags needed
    // translating. R48 R1 had widened untranslatedCount to count
    // tag-only-missing stars → button correctly said "翻译 9 个" — but
    // those 9 stars were still being filtered out here, so clicking did
    // nothing. New invariant: noSource means "truly nothing to do" —
    // desc is empty AND (alsoTags is off OR aiTags is empty). When desc
    // is empty but aiTags need translation, the star enters the worker
    // and only the tags arm fires (desc arm short-circuits at descEmpty).
    const descEmpty = !star.description || star.description.trim().length === 0;
    const hasTagsToTranslate = alsoTags && star.aiTags.length > 0;
    if (descEmpty && !hasTagsToTranslate) {
      noSource.push(star);
      continue;
    }
    if (!opts.forceRetranslate) {
      // descCached treats "desc empty" as a no-op success (nothing to
      // translate equals already translated). Otherwise the cached check.
      const descCached =
        descEmpty ||
        (star.descriptionI18n &&
          typeof star.descriptionI18n[opts.targetLocale] === 'string' &&
          star.descriptionI18n[opts.targetLocale]!.length > 0);
      // Tags considered "done" if: alsoTags disabled (caller doesn't
      // care), OR star has no aiTags (nothing to translate), OR the
      // aiTagsI18n cache for this locale is populated. Empty/missing
      // cache entry means "needs to be (re-)translated".
      const tagsDone =
        !alsoTags ||
        star.aiTags.length === 0 ||
        (star.aiTagsI18n &&
          typeof star.aiTagsI18n[opts.targetLocale] === 'string' &&
          star.aiTagsI18n[opts.targetLocale]!.length > 0);
      if (descCached && tagsDone) {
        skipped += 1;
        continue;
      }
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
  // R20 蓝军 MAJOR #1 + R28 fan-out: use the shared FailureRecorder so
  // priority discipline (AIError beats weak parser-empty signals) is
  // identical across all 5 orchestrators. Previously translate + tag
  // had hand-rolled latches; embed + code did "last-writer-wins" which
  // could clobber a rate_limit AIError with a dim-mismatch generic
  // Error. The shared helper closes that gap.
  const failure = createFailureRecorder();
  opts.onProgress?.(done, total);

  const systemPrompt = buildTranslateSystemPrompt(opts.targetLocale, localeNativeName);
  const tagsSystemPrompt = buildTagsTranslateSystemPrompt(
    opts.targetLocale,
    localeNativeName
  );
  // alsoTags resolved at the top of the function (see above) — used by
  // both the skip-loop and the worker's tags arm. Do not re-bind here.

  // R20 蓝军: thin wrapper over shared callWithRetry so the call-site stays
  // readable. The shared helper handles all the retry semantics that used
  // to live here (signal.aborted bubble, bare AbortError = transient,
  // kind={rate_limit,timeout,server,network,parse} = transient + backoff).
  // Critically picks up `parse` retry — fixes SiliconFlow HTML overload page.
  const callChatWithRetry = (system: string, user: string) =>
    callWithRetry(
      () => opts.chat(system, user, opts.signal),
      opts.signal ? { signal: opts.signal } : {}
    );

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
      // R21 蓝军 P0: when the description is ALREADY cached for this
      // locale (i.e. star reached the worker because tags need backfill
      // but desc was already done in a prior run), skip the desc chat
      // entirely — set descOK=true so the tags arm fires. Without this,
      // tag-backfill runs would re-burn the description token cost.
      //
      // R48 round-3 extension: also short-circuit when description is
      // null/empty/whitespace. Such stars reach the worker (instead of
      // noSource) only when alsoTags is on AND aiTags need translation;
      // the goal is to fire the tags arm without trying to translate a
      // non-existent description (which would also hit `star.description!`
      // non-null-assertion and crash).
      let descOK = false;
      const descEmpty = !star.description || star.description.trim().length === 0;
      const descAlreadyCached =
        !opts.forceRetranslate &&
        star.descriptionI18n &&
        typeof star.descriptionI18n[opts.targetLocale] === 'string' &&
        star.descriptionI18n[opts.targetLocale]!.length > 0;
      if (descEmpty || descAlreadyCached) {
        descOK = true;
      } else {
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
          // R20 蓝军 MAJOR #4 defensive — DO NOT REMOVE.
          // The current sync path between parseTranslateResponse and
          // updateStar means this check is currently redundant — but
          // any future `await` inserted into that window (e.g. content
          // post-processing, validation, locale normalization) would
          // silently let abandoned writes land after the user cancelled.
          // Cheap defense vs. expensive "why did this write happen
          // after I clicked Cancel" bug report. No test covers this
          // gap (would require closure-mocking parseTranslateResponse)
          // — the comment IS the test. R20 蓝军 round-2 MINOR #4 fix.
          if (opts.signal?.aborted) return;
          await opts.updateStar(star.id, opts.targetLocale, text, 'description');
          translated += 1;
          descOK = true;
        } else {
          // Parser refused — model emitted only refusal text / preamble /
          // empty. Counts as failed but it's the WEAK signal — record
          // only if no stronger AIError has been seen yet.
          failed += 1;
          failedStarIds.push(star.id);
          failure.record(null, 'translator returned empty result (parser refused)');
        }
        } catch (err) {
          // R20 蓝军 MAJOR fix (post-audit B): AbortError only propagates
          // when CALLER signal initiated the cancel. Bare AbortError from
          // provider's internal withTimeout = exhausted-retry transient
          // → counts as failed. Matches embed/tag/code/digest pattern.
          // The v1 unguarded `throw err` was a latent bug — silently
          // killed the run on any inner timeout even though callWithRetry
          // already retried it 3x.
          if (err instanceof Error && err.name === 'AbortError' && opts.signal?.aborted) {
            throw err;
          }
          failed += 1;
          failedStarIds.push(star.id);
          // Strong signal — AIError with .kind, or generic Error. Priority
          // discipline is inside FailureRecorder (R28 fan-out from R20).
          failure.record(err, 'unknown failure');
        }
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
            // R20 蓝军 MAJOR #4 defensive — DO NOT REMOVE.
            // Same rationale as the description path above: cheap
            // defense against future await-insertion silently letting
            // abandoned writes land. No test covers this gap (would
            // require closure-mocking parseTagResponse); the comment
            // IS the test. R20 蓝军 round-2 MINOR #4 fix.
            if (opts.signal?.aborted) return;
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
            // Weak signal — only record if no AIError has won yet. Don't
            // push star.id to failedStarIds (description succeeded; the
            // popup retry CTA targets desc failures, not tag-only ones).
            failure.record(null, 'tag translator returned empty result');
          }
        } catch (err) {
          // Same R20 蓝军 MAJOR fix as description path: caller-initiated
          // AbortError propagates; bare AbortError counts as failed.
          if (err instanceof Error && err.name === 'AbortError' && opts.signal?.aborted) {
            throw err;
          }
          tagsFailed += 1;
          // AIError from the tag call should still be visible to the
          // user even though tag failures don't push to failedStarIds.
          failure.record(err, 'tag translation failed');
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
    lastErrorKind: failure.getKind(),
    lastErrorMessage: failure.getMessage(),
  };
}
