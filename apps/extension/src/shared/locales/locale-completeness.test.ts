import { describe, expect, it } from 'vitest';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import ja from './ja.json';
import ko from './ko.json';
import ptBR from './pt-BR.json';
import ru from './ru.json';
import vi from './vi.json';
import zhCN from './zh-CN.json';
import zhTW from './zh-TW.json';

/**
 * R48 R4 contract test (locale completeness).
 *
 * Background: agent #1 RCA found 8 of 11 locales were missing `common.cancel`
 * and `common.cancelled` keys added by R44/R45 cancel buttons. Result:
 * ja/ko/de/fr/es/pt-BR/ru/vi users saw English "Cancel" / "Cancelled" mid-
 * progress — the literal "翻译不到位" symptom they reported.
 *
 * This test guarantees every non-English locale bundle has the same nested
 * key set as `en.json`. CI will break immediately if a future commit adds a
 * key to `en` without translating it elsewhere — preventing the regression
 * from re-emerging silently.
 */

const ALL_LOCALES: Readonly<Record<string, unknown>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  'pt-BR': ptBR,
  ru,
  vi,
};

/** Recursively flatten a nested object to dotted key paths (leaf strings). */
function flattenKeys(obj: unknown, prefix = ''): ReadonlyArray<string> {
  if (obj === null || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe('locale completeness — every locale carries the en.json key set', () => {
  const enKeys = new Set(flattenKeys(en));

  for (const [name, bundle] of Object.entries(ALL_LOCALES)) {
    it(`${name}.json has no missing keys vs en.json`, () => {
      const localeKeys = new Set(flattenKeys(bundle));
      const missing = [...enKeys].filter((k) => !localeKeys.has(k));
      // Empty array on success; full list on failure makes the regression
      // obvious in CI output.
      expect(missing, `${name} missing keys: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('contract pins common.cancel + common.cancelled across all 11 locales', () => {
    // Defense-in-depth: even if flatten breaks, this catches the exact pair
    // that triggered R48 R4. If this assert ever fires, the R44/R45 cancel
    // button UI just regressed to showing English in non-English locales.
    for (const [name, bundle] of Object.entries({ en, ...ALL_LOCALES })) {
      const b = bundle as { common?: { cancel?: unknown; cancelled?: unknown } };
      expect(
        typeof b.common?.cancel === 'string' && (b.common!.cancel as string).length > 0,
        `${name}: common.cancel must be a non-empty string`
      ).toBe(true);
      expect(
        typeof b.common?.cancelled === 'string' &&
          (b.common!.cancelled as string).length > 0,
        `${name}: common.cancelled must be a non-empty string`
      ).toBe(true);
    }
  });
});
