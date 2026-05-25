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
 * Maximum length of a returned translation.
 *
 * 1200 chars (R17 蓝军 fix from "翻译总有几个翻译不了"). v1 had 600
 * which was wrong on two axes:
 *   1. Russian / German / Vietnamese translations of a 300-char English
 *      source can compound up to ~500-600 chars on their own.
 *   2. Verbose models output a "Note: kept React untranslated" suffix
 *      AFTER the translation; the v1 parser only stripped PREFIX, so
 *      the trailing note inflated past 600 → parser returned null →
 *      orchestrator counted it as `failed`, user saw nothing.
 * The companion suffix-stripping logic in `parseTranslateResponse`
 * handles the trailing-note case; this cap is the belt-and-suspenders
 * "model wrote an essay" trap.
 */
const MAX_TRANSLATION_LENGTH = 1200;

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
 * R17 蓝军 fix: tags are translated separately from description because
 * (a) chip rendering needs the parsed array back, and (b) the prompt
 * shape that worked for the tagging pipeline (`parseTagResponse`)
 * already handles all the model-formatting hallucinations we care about.
 *
 * Returns a system prompt that ALSO uses the locale code + native name
 * the description path uses — model picks them up the same way.
 */
export function buildTagsTranslateSystemPrompt(
  localeCode: string,
  localeNativeName: string
): string {
  return [
    'You are a translator for GitHub repository tags.',
    `Translate the comma-separated tags below into ${localeNativeName} (${localeCode}).`,
    'Keep technical proper nouns (programming language names like "Rust",',
    '"TypeScript"; product names like "React", "Postgres") in their original form.',
    'Translate generic descriptors (e.g. "async runtime" → "异步运行时",',
    '"web framework" → "веб-фреймворк").',
    'Output ONLY the translated tags, comma-separated, in the same order',
    'as the input. No bullets, no quotes, no preamble like "Tags:".',
  ].join('\n');
}

/** Build the user-prompt for a tags translation call. Takes the English
 *  tags array and stitches into a single comma-separated input — same
 *  protocol the tagging orchestrator uses for output, so the reverse
 *  parser (parseTagResponse) can be reused unchanged. */
export function buildTagsTranslateUserPrompt(aiTags: ReadonlyArray<string>): string {
  return aiTags.join(', ');
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
  let cleaned = raw
    .trim()
    // R17 蓝军 fix C1: broaden the preamble regex. v1 only caught
    // "Translation:" / language-name colon prefixes. Real-world models
    // often emit "Sure, here is the translation:" / "翻译结果:" / "译文:"
    // which the v1 regex left intact, polluting the persisted text.
    // Order matters — strip the verbose phrases FIRST, then the
    // language-name singletons that might be a suffix to those phrases.
    .replace(/^/, ''); // anchor — actual loop runs below for double-prefix fix

  // R20 蓝军 #4 (subagent B): models emit DOUBLE prefixes like
  //   "Sure, here is the translation: 翻译结果: <text>"
  // — one verbose English phrase plus one language-name singleton. v1 ran
  // two sequential `.replace()` calls but each fired only ONCE, leaving
  // the second layer. Loop until fixed-point so both layers peel.
  const prefixRegex =
    /^(?:Sure[,]?\s*here(?:'s| is)\s*(?:the\s*)?(?:translation|translated\s*text)|Here(?:'s| is)\s*(?:the\s*)?(?:translation|translated\s*text)|Translation|Translated|Result|Output|翻译(?:结果|内容|后(?:的)?(?:内容|文本)?)?|翻譯(?:結果|內容)?|译文|譯文|翻訳(?:結果)?|Traduction|Übersetzung|Перевод|Traducción|번역|Bản dịch)\s*[:：]\s*/i;
  for (let i = 0; i < 4; i += 1) {
    const next = cleaned.replace(prefixRegex, '').trim();
    if (next === cleaned) break;
    cleaned = next;
  }

  // R17 蓝军 fix: many models emit `<translation>\n\n(Note: kept React
  // untranslated because it's a brand name.)` despite the "no commentary"
  // instruction. v1 only stripped prefixes, so the suffix note inflated
  // past MAX_TRANSLATION_LENGTH → parseTranslateResponse returned null →
  // user lost an otherwise-correct translation. Split on the first blank-
  // line boundary and keep paragraph 1 — that's the actual translation.
  // The suffix paragraph (if any) is the model's editorial note.
  const paragraphBreak = cleaned.search(/\n\s*\n/);
  if (paragraphBreak > 0) {
    cleaned = cleaned.slice(0, paragraphBreak);
  }

  // Same beat for inline parenthetical notes at the tail:
  //   "这是一个 Rust 异步运行时。(I kept "React" untranslated.)"
  // — strip the trailing parenthetical when it's the last token AND its
  // content is English (heuristic: contains "kept", "left", "preserved",
  // "untranslated", "brand", "as in source", "original", "因为", "保留").
  cleaned = cleaned.replace(
    /\s*[(（][^()（）]*(?:kept|left|preserved|untranslated|brand|as in source|original|protected|保留|因为|不译|原文)[^()（）]*[)）]\s*$/i,
    ''
  );

  // R20 蓝军 #2 (subagent B): strip markdown emphasis + inline links +
  // code spans. SiliconFlow / DashScope routinely emit `**Tokio** 是一个
  // **异步** 运行时` or `[React](https://react.dev) 是 UI 库` even when
  // the prompt says "no markdown" — the popup renders into a plain text
  // div, so raw ** / [text](url) / `code` chars become user-visible noise.
  // Strip the syntax but keep the content. Order matters: links FIRST
  // (their inner text may contain bold/italic), then bold, italic, code.
  cleaned = cleaned
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1') // **bold** → bold
    .replace(/__([^_\n]+)__/g, '$1') // __bold__ → bold
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1') // *italic* → italic
    .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1') // _italic_ → italic
    .replace(/`([^`\n]+)`/g, '$1'); // `code` → code

  // R17 蓝军 fix B3: only strip surrounding quotes when they PAIR
  // (matching open/close). v1 stripped leading AND trailing independently,
  // so a description like `"reliable" async runtime` lost its leading
  // quote but kept the dangling inner one → persisted as `reliable" async
  // runtime` (corrupt). Pair-aware stripping handles this.
  const stripped = stripMatchingOuterQuotes(cleaned).trim();

  if (stripped.length === 0) return null;
  if (stripped.length > MAX_TRANSLATION_LENGTH) return null;
  return stripped;
}

/**
 * Strip surrounding quote chars only when first and last form a matching
 * pair. Supports ascii (`"` `'` `` ` ``) and CJK / French paired forms
 * (`「」 『』 《》`). Asymmetric quotes survive — they're part of the
 * description text, not model wrapping.
 *
 * R17 蓝军 fix B3 — `"reliable" async runtime` no longer mangles.
 */
function stripMatchingOuterQuotes(s: string): string {
  if (s.length < 2) return s;
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['「', '」'],
    ['『', '』'],
    ['《', '》'],
  ];
  const first = s[0]!;
  const last = s[s.length - 1]!;
  for (const [open, close] of pairs) {
    if (first === open && last === close) {
      // Sanity check: don't strip if the interior has UNESCAPED matching
      // chars (means the outer pair isn't actually wrapping the whole thing).
      const interior = s.slice(1, -1);
      // For asymmetric pairs (CJK) the interior containing the same char
      // is fine. For symmetric (" ' `), the interior must NOT contain the
      // same unescaped char.
      if (open === close && interior.includes(open)) {
        return s;
      }
      return interior;
    }
  }
  return s;
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
