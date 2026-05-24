/**
 * Prompt construction + response cleaning for the content-translation
 * pipeline.
 *
 * Translates a single repo's `description` string into the user's UI
 * locale, cached into `star.descriptionI18n[locale]`. Same provider-
 * agnostic comma-separated-or-newline protocol the auto-tag uses; works
 * on OpenAI / DeepSeek-via-SiliconFlow / Qwen / Ollama / anything that
 * implements the OpenAI-compatible chat shape.
 *
 * Phase 6 v1 ships description-only — `aiSummaryI18n` and `aiTagsI18n`
 * fields exist on the schema but no orchestrator path wires them yet.
 * Adding those later is symmetric with this file.
 */

/**
 * Maximum length of a returned translation. A model that ignores the
 * "no preamble" instruction may prepend a sentence — the parser trims
 * common prefixes but if the result is still suspiciously long we drop
 * it rather than persist garbage.
 *
 * 600 chars covers any reasonable repo description (GitHub itself caps
 * displayed descriptions around 350) while still flagging "the model
 * wrote me an essay" responses.
 */
const MAX_TRANSLATION_LENGTH = 600;

/**
 * System prompt — held constant across every call so providers with
 * prompt-caching amortize it. The target locale is interpolated at the
 * call site so the model knows which language to output in.
 *
 * Note on language naming: we use English BCP-47 codes (`zh-CN`) AND
 * the native-language name in the same line so the model gets two
 * signals — some Ollama-served small models trip on bare locale codes.
 */
export function buildTranslateSystemPrompt(
  localeCode: string,
  localeNativeName: string
): string {
  return [
    'You are a translator for GitHub repository descriptions.',
    `Translate the user message into ${localeNativeName} (${localeCode}).`,
    'Keep technical terms (programming languages, library names, protocol',
    'acronyms like REST/HTTP/gRPC, brand names) in their original form.',
    'Preserve the original meaning faithfully; do not summarize or expand.',
    'Output ONLY the translated text — no quotes, no preamble like',
    '"Translation:", no markdown, no commentary.',
  ].join('\n');
}

/** The user prompt is just the original text. Keeping it bare maximizes
 *  the chance that prompt-caching providers (Anthropic / OpenAI) only
 *  re-process the description, not the instruction block. */
export function buildTranslateUserPrompt(description: string): string {
  return description;
}

/**
 * Clean up a raw chat response into something we can persist.
 * Identical robustness shape as `parseTagResponse` but simpler — we want
 * a single string, not a list.
 *
 * Steps:
 *   1. Trim whitespace + strip a leading `Translation:` / `翻译:` /
 *      `翻譯:` / `翻訳:` prefix the model may have prepended.
 *   2. Strip surrounding quotes / backticks if the model wrapped the
 *      output in them.
 *   3. Length-cap: drop responses over MAX_TRANSLATION_LENGTH (likely
 *      an essay — the model ignored "no commentary").
 *   4. Return `null` rather than empty string for "no usable
 *      translation" so the caller can decide whether to skip vs retry.
 */
export function parseTranslateResponse(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw
    .trim()
    .replace(
      /^(?:Translation|Translated|翻译|翻譯|翻訳|Traduction|Übersetzung|Перевод|Traducción|번역|Bản dịch)\s*[:：]\s*/i,
      ''
    )
    .replace(/^["'`「」『』《》]+|["'`「」『』《》]+$/g, '')
    .trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TRANSLATION_LENGTH) return null;
  return trimmed;
}

/** Native-language labels for the locales the extension supports. Keeps
 *  the prompt prompt human-readable rather than slamming a bare BCP-47
 *  code at the model. Mirrors `LOCALE_LABELS` in
 *  `apps/extension/src/shared/i18n.ts` but lives here (in core) so the
 *  orchestrator + the test file don't have to reach across the workspace
 *  boundary. The two tables MUST agree — there's a Phase 6 contract test
 *  that checks every key in the extension's table is also here. */
export const TRANSLATE_LOCALE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'pt-BR': 'Português brasileiro',
  ru: 'Русский',
  vi: 'Tiếng Việt',
};
