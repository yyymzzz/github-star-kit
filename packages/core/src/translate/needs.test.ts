import { describe, expect, it } from 'vitest';
import type { StarredRepo } from '../schema.js';
import {
  descriptionNeedsTranslation,
  isLikelyInLocale,
  starNeedsTranslation,
  tagsNeedTranslation,
} from './needs.js';

/**
 * R50 contract test — the single source of truth for "needs translation"
 * that fixes the 5th-iteration "翻译 N 个 stuck" bug.
 *
 * If any of these assertions break, the UI counter / orchestrator skip-loop
 * will diverge again and the bug returns. Treat regressions here as P0.
 */

function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    id: 1,
    fullName: 'foo/bar',
    htmlUrl: 'https://github.com/foo/bar',
    description: 'A useful tool',
    starredAt: '2024-01-01T00:00:00Z',
    pushedAt: '2024-01-01T00:00:00Z',
    stargazersCount: 100,
    language: null,
    topics: [],
    archived: false,
    isFork: false,
    defaultBranch: 'main',
    aiTags: [],
    aiSummary: null,
    aiSummaryI18n: {},
    descriptionI18n: {},
    aiTagsI18n: {},
    lastEmbeddedAt: null,
    lastTranslatedAt: null,
    deepIndexed: false,
    lastDeepIndexedAt: null,
    subscribedToReleases: false,
    userNote: null,
    ...overrides,
  } as StarredRepo;
}

describe('isLikelyInLocale', () => {
  it('zh-CN detects CJK ideographs', () => {
    expect(isLikelyInLocale('金融分析', 'zh-CN')).toBe(true);
    expect(isLikelyInLocale('finance analysis', 'zh-CN')).toBe(false);
  });
  it('ja detects hiragana/katakana/kanji', () => {
    expect(isLikelyInLocale('ライブラリ', 'ja')).toBe(true); // katakana
    expect(isLikelyInLocale('こんにちは', 'ja')).toBe(true); // hiragana
    expect(isLikelyInLocale('金融分析', 'ja')).toBe(true); // kanji shared with zh
    expect(isLikelyInLocale('library', 'ja')).toBe(false);
  });
  it('ko detects Hangul', () => {
    expect(isLikelyInLocale('라이브러리', 'ko')).toBe(true);
    expect(isLikelyInLocale('library', 'ko')).toBe(false);
  });
  it('ru detects Cyrillic', () => {
    expect(isLikelyInLocale('библиотека', 'ru')).toBe(true);
    expect(isLikelyInLocale('library', 'ru')).toBe(false);
  });
  it('Latin-script locales (en/de/fr/es/pt-BR) intentionally return false', () => {
    // Can't distinguish languages within Latin script by codepoint; cache
    // logic alone determines need.
    expect(isLikelyInLocale('Bibliothèque', 'fr')).toBe(false);
    expect(isLikelyInLocale('Bibliothek', 'de')).toBe(false);
    expect(isLikelyInLocale('biblioteca', 'es')).toBe(false);
  });
  it('null/empty input → false', () => {
    expect(isLikelyInLocale('', 'zh-CN')).toBe(false);
    expect(isLikelyInLocale(null, 'zh-CN')).toBe(false);
    expect(isLikelyInLocale(undefined, 'zh-CN')).toBe(false);
  });
});

describe('tagsNeedTranslation', () => {
  it('R50 root case: Chinese aiTags + zh-CN locale + empty cache → false', () => {
    // The exact case in the user's screenshot: DashScope auto-tagged a repo
    // in zh-CN ("金融分析", "AI交易"), aiTagsI18n.zh-CN never populated.
    // PRE-FIX: untranslatedCount counted this, orchestrator ran Chinese-to-
    // Chinese chat that returned noise → tagsFailed → count unchanged →
    // "翻译 9 个" stuck. POST-FIX: helper returns false → no count, no chat.
    const star = makeStar({
      aiTags: ['金融分析', 'AI交易', '自动化'],
      aiTagsI18n: {}, // cache empty
    });
    expect(tagsNeedTranslation(star, 'zh-CN')).toBe(false);
    expect(tagsNeedTranslation(star, 'zh-TW')).toBe(false);
  });

  it('English aiTags + zh-CN locale + empty cache → true (genuine work)', () => {
    const star = makeStar({
      aiTags: ['cli', 'rust', 'static-site'],
      aiTagsI18n: {},
    });
    expect(tagsNeedTranslation(star, 'zh-CN')).toBe(true);
  });

  it('English aiTags + zh-CN locale + cached translation → false', () => {
    const star = makeStar({
      aiTags: ['cli', 'rust'],
      aiTagsI18n: { 'zh-CN': '命令行, Rust' },
    });
    expect(tagsNeedTranslation(star, 'zh-CN')).toBe(false);
  });

  it('Empty-string cache entry (legacy data) + aiTags in target locale → false (cache backfill candidate)', () => {
    // Old R17-era code wrote `''` on certain failure paths. Pure cache-only
    // logic counts this as "missing"; content-aware logic correctly skips.
    const star = makeStar({
      aiTags: ['金融分析', '自动化'],
      aiTagsI18n: { 'zh-CN': '' },
    });
    expect(tagsNeedTranslation(star, 'zh-CN')).toBe(false);
  });

  it('Empty aiTags → false (nothing to translate)', () => {
    expect(tagsNeedTranslation(makeStar({ aiTags: [] }), 'zh-CN')).toBe(false);
  });

  it('locale === en → false (no en target ever)', () => {
    expect(
      tagsNeedTranslation(makeStar({ aiTags: ['cli'] }), 'en')
    ).toBe(false);
  });

  it('Latin-script target (fr) + English aiTags + empty cache → true (genuine work)', () => {
    // No script-range heuristic for fr, so it falls back to strict cache
    // check — empty cache means "translate". Acceptable: French user clicks
    // translate, LLM produces French tags, cached, count drops.
    const star = makeStar({
      aiTags: ['library', 'json'],
      aiTagsI18n: {},
    });
    expect(tagsNeedTranslation(star, 'fr')).toBe(true);
  });
});

describe('descriptionNeedsTranslation', () => {
  it('Chinese description + zh-CN locale + empty cache → false (no LLM call needed)', () => {
    const star = makeStar({
      description: '一个用于AI金融分析的工具',
      descriptionI18n: {},
    });
    expect(descriptionNeedsTranslation(star, 'zh-CN')).toBe(false);
  });
  it('English description + zh-CN locale + empty cache → true', () => {
    expect(descriptionNeedsTranslation(makeStar(), 'zh-CN')).toBe(true);
  });
  it('Null description → false (nothing to translate)', () => {
    expect(
      descriptionNeedsTranslation(makeStar({ description: null }), 'zh-CN')
    ).toBe(false);
  });
  it('Whitespace-only description → false', () => {
    expect(
      descriptionNeedsTranslation(makeStar({ description: '   ' }), 'zh-CN')
    ).toBe(false);
  });
});

describe('starNeedsTranslation (top-level)', () => {
  it('R50 user scenario: desc in zh + tags in zh + zh-CN locale → false (no work)', () => {
    // 195 stars, "翻译 9 个" should drop to 0 after this fix because the
    // 9 stars likely have Chinese desc + Chinese tags but empty i18n cache.
    const star = makeStar({
      description: '一个 AI 工具',
      aiTags: ['AI', '工具'],
      descriptionI18n: {},
      aiTagsI18n: {},
    });
    expect(starNeedsTranslation(star, 'zh-CN')).toBe(false);
  });
  it('English desc + Chinese tags + zh-CN → true (desc still needs translation)', () => {
    // Mixed case: GitHub gave English description, user ran auto-tag in zh
    // model so tags are Chinese. Desc still needs translation, tags don't.
    const star = makeStar({
      description: 'A useful tool',
      aiTags: ['AI', '工具'],
    });
    expect(starNeedsTranslation(star, 'zh-CN')).toBe(true);
  });
});
