/**
 * @starkit/core/translate — content translation pipeline. Runs each
 * starred repo's `description` through a chat LLM and caches the result
 * into `star.descriptionI18n[locale]` so the popup / manage page can
 * render the user's UI locale for free on subsequent loads.
 *
 * Pipeline shape mirrors @starkit/core/tagging — same callback-based
 * decoupling, same per-star failure isolation, same skip-cache for
 * idempotent re-runs.
 */
export {
  buildTagsTranslateSystemPrompt,
  buildTagsTranslateUserPrompt,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  parseTranslateResponse,
  TRANSLATE_LOCALE_NAMES,
} from './text.js';
export {
  translateStars,
  type TranslateStarsOptions,
  type TranslateStarsResult,
  type UpdateStarTranslationFn,
} from './orchestrator.js';
