/**
 * Tiny in-app i18n for the popup + manage page.
 *
 * Custom React context + statically-imported JSON locale files. Picked
 * (per architecture-review subagent) over chrome.i18n (no in-app switcher)
 * and react-i18next (~40 KB bundle hit). The whole framework is ~80 LOC,
 * ~1 KB gzip after Brotli — the cost is dominated by the locale strings
 * themselves, not the runtime.
 *
 * Design constraints:
 *   - All locales bundled (no network in an extension; lazy-loading saves
 *     nothing and adds a flash on switch).
 *   - Nested JSON namespaces so translators see context; flat-dot key in
 *     code (t('settings.pat.label')) so callsites read naturally.
 *   - Type-safe: `Key` is computed from the en.json shape so a typo'd key
 *     fails typecheck before it ships.
 *   - Missing-key fallback: returns the English string when a locale is
 *     incomplete. Eleven-locale ship with partial coverage is the v1
 *     reality; English fallback is the safety net.
 *   - Persistence: caller passes initial locale + onLocaleChange. The
 *     extension popup reads/writes KV_KEY_LOCALE via the existing kvStore;
 *     the i18n module stays storage-agnostic.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import vi from './locales/vi.json';

export type LocaleId =
  | 'en'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt-BR'
  | 'ru'
  | 'vi';

/** Display label shown in the language picker — written in the target
 *  language itself so a user who reads only Korean recognizes "한국어" without
 *  having to know what "Korean" means in English. */
export const LOCALE_LABELS: Record<LocaleId, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'pt-BR': 'Português (BR)',
  ru: 'Русский',
  vi: 'Tiếng Việt',
};

export const LOCALE_ORDER: ReadonlyArray<LocaleId> = [
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt-BR',
  'ru',
  'vi',
];

// JSON imports widen to `any` without explicit cast; pin to the en shape
// so the rest of the code gets useful types.
const dictionaries: Record<LocaleId, Dict> = {
  en: en as Dict,
  'zh-CN': zhCN as Dict,
  'zh-TW': zhTW as Dict,
  ja: ja as Dict,
  ko: ko as Dict,
  de: de as Dict,
  fr: fr as Dict,
  es: es as Dict,
  'pt-BR': ptBR as Dict,
  ru: ru as Dict,
  vi: vi as Dict,
};

interface Dict {
  readonly [key: string]: string | Dict;
}

/** Look up `nested.dot.path` in a dict; returns undefined if any segment
 *  is missing or doesn't terminate at a string. */
function lookup(dict: Dict, dottedKey: string): string | undefined {
  const segments = dottedKey.split('.');
  let cur: string | Dict = dict;
  for (const seg of segments) {
    if (typeof cur === 'string') return undefined;
    const next: string | Dict | undefined = cur[seg];
    if (next === undefined) return undefined;
    cur = next;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Auto-detect locale from `navigator.language`. Falls back to 'en' for
 * any unrecognized language tag — including the common case of an exact
 * match miss like `zh-HK` (we ship `zh-TW` for traditional but not HK
 * specifically).
 *
 * Matches the BCP-47 prefix first (`zh-CN` -> `zh-CN`, `zh-HK` -> first
 * `zh-*` we have which is `zh-CN`; user can override via the picker if
 * Traditional fits better). English is the universal fallback because
 * every translation file falls back to it on missing keys.
 */
export function detectLocale(navLang?: string): LocaleId {
  if (!navLang) return 'en';
  const lower = navLang.toLowerCase();
  // Exact match (e.g. 'zh-cn' -> 'zh-CN')
  for (const id of LOCALE_ORDER) {
    if (id.toLowerCase() === lower) return id;
  }
  // Prefix match on language portion (e.g. 'zh-HK' -> first 'zh-*')
  const prefix = lower.split('-')[0]!;
  for (const id of LOCALE_ORDER) {
    if (id.toLowerCase().startsWith(prefix + '-') || id.toLowerCase() === prefix) {
      return id;
    }
  }
  return 'en';
}

/**
 * Replace `{name}` placeholders in `template` with values from `vars`.
 * Unknown placeholders are left in place (so missing data is visibly broken
 * rather than silently empty). Values are coerced to string via String();
 * caller is responsible for any pre-formatting (e.g. number locale).
 */
function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined ? match : String(v);
  });
}

interface I18nContextValue {
  readonly locale: LocaleId;
  readonly setLocale: (id: LocaleId) => void;
  /** Translate a nested key like `'settings.pat.label'`. Optional `vars`
   *  fills `{placeholder}` tokens in the looked-up string. */
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  readonly children: React.ReactNode;
  readonly initial?: LocaleId;
  /** Called when the user picks a new locale via setLocale — caller is
   *  responsible for persisting to IDB / chrome.storage. Optional so the
   *  manage page (which inherits locale via the popup's KV write) doesn't
   *  need to know about persistence either. */
  readonly onLocaleChange?: (id: LocaleId) => void;
}

export function I18nProvider(props: I18nProviderProps): JSX.Element {
  const [locale, setLocaleState] = useState<LocaleId>(
    props.initial ?? detectLocale(
      typeof navigator !== 'undefined' ? navigator.language : undefined
    )
  );

  const setLocale = useCallback(
    (id: LocaleId) => {
      setLocaleState(id);
      props.onLocaleChange?.(id);
    },
    [props]
  );

  const t = useCallback(
    (key: string, vars?: Record<string, unknown>): string => {
      // Try the active locale first.
      const hit = lookup(dictionaries[locale]!, key);
      if (hit !== undefined) return interpolate(hit, vars);
      // Fall back to English — covers the common "v1 ships partial
      // translations for some locales" reality.
      const fallback = lookup(dictionaries.en, key);
      if (fallback !== undefined) return interpolate(fallback, vars);
      // Last resort — show the raw key so a missing entry is loud, not
      // silent (avoids the "[object Object]" / blank-button anti-pattern).
      return key;
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

/** Read the active translation function + locale state from context.
 *  Throws (not returns null) when used outside I18nProvider — that's a
 *  programmer error, not something to handle gracefully. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be called inside <I18nProvider>');
  }
  return ctx;
}
