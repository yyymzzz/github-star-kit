import { describe, expect, it } from 'vitest';
import {
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
  parseTranslateResponse,
  TRANSLATE_LOCALE_NAMES,
} from './text.js';

describe('buildTranslateSystemPrompt', () => {
  it('embeds the BCP-47 code + native-language name in the prompt', () => {
    const p = buildTranslateSystemPrompt('zh-CN', '简体中文');
    expect(p).toContain('zh-CN');
    expect(p).toContain('简体中文');
  });

  it('tells the model to preserve technical terms', () => {
    const p = buildTranslateSystemPrompt('ja', '日本語');
    expect(p.toLowerCase()).toContain('technical terms');
  });

  it('forbids preamble / quotes / markdown', () => {
    const p = buildTranslateSystemPrompt('ja', '日本語');
    expect(p.toLowerCase()).toContain('no preamble');
    expect(p.toLowerCase()).toContain('no quotes');
    expect(p.toLowerCase()).toContain('no markdown');
  });
});

describe('buildTranslateUserPrompt', () => {
  it('returns the raw description unchanged (maximizes prompt-cache hit)', () => {
    expect(buildTranslateUserPrompt('hello world')).toBe('hello world');
    expect(buildTranslateUserPrompt('')).toBe('');
  });
});

describe('parseTranslateResponse — happy paths', () => {
  it('returns clean text unchanged', () => {
    expect(parseTranslateResponse('这是一个 Rust 异步运行时')).toBe(
      '这是一个 Rust 异步运行时'
    );
  });

  it('trims leading/trailing whitespace', () => {
    expect(parseTranslateResponse('  你好  ')).toBe('你好');
  });
});

describe('parseTranslateResponse — robustness against hallucinated formatting', () => {
  it('strips "Translation:" prefix (English)', () => {
    expect(parseTranslateResponse('Translation: hello')).toBe('hello');
    expect(parseTranslateResponse('Translated: hello')).toBe('hello');
  });

  it('strips Chinese "翻译:" / Traditional "翻譯:" prefix', () => {
    expect(parseTranslateResponse('翻译: 你好')).toBe('你好');
    expect(parseTranslateResponse('翻譯: 你好')).toBe('你好');
  });

  it('strips Japanese "翻訳:" prefix', () => {
    expect(parseTranslateResponse('翻訳: こんにちは')).toBe('こんにちは');
  });

  it('strips French / German / Russian / Spanish / Korean / Vietnamese prefixes', () => {
    expect(parseTranslateResponse('Traduction: bonjour')).toBe('bonjour');
    expect(parseTranslateResponse('Übersetzung: hallo')).toBe('hallo');
    expect(parseTranslateResponse('Перевод: привет')).toBe('привет');
    expect(parseTranslateResponse('Traducción: hola')).toBe('hola');
    expect(parseTranslateResponse('번역: 안녕')).toBe('안녕');
    expect(parseTranslateResponse('Bản dịch: xin chào')).toBe('xin chào');
  });

  it('strips ascii surrounding quotes / backticks', () => {
    expect(parseTranslateResponse('"hello"')).toBe('hello');
    expect(parseTranslateResponse("'hello'")).toBe('hello');
    expect(parseTranslateResponse('`hello`')).toBe('hello');
  });

  it('strips CJK + French quote marks「」『』《》', () => {
    expect(parseTranslateResponse('「你好」')).toBe('你好');
    expect(parseTranslateResponse('『你好』')).toBe('你好');
    expect(parseTranslateResponse('《hello》')).toBe('hello');
  });

  it('handles "Translation:" + leading space + quotes (compound)', () => {
    expect(parseTranslateResponse('Translation: "hello world"')).toBe('hello world');
  });
});

describe('parseTranslateResponse — edge cases', () => {
  it('returns null on empty input', () => {
    expect(parseTranslateResponse('')).toBeNull();
    expect(parseTranslateResponse('   ')).toBeNull();
  });

  it('returns null on non-string input (defensive)', () => {
    expect(parseTranslateResponse(null as unknown as string)).toBeNull();
    expect(parseTranslateResponse(undefined as unknown as string)).toBeNull();
  });

  it('returns null when response exceeds MAX_TRANSLATION_LENGTH (essay protection)', () => {
    const essay = 'a'.repeat(800);
    expect(parseTranslateResponse(essay)).toBeNull();
  });

  it('keeps a long-but-acceptable description (just under cap)', () => {
    const longButOk = 'b'.repeat(500);
    expect(parseTranslateResponse(longButOk)).toBe(longButOk);
  });
});

describe('TRANSLATE_LOCALE_NAMES', () => {
  it('covers the 11 locales the extension ships', () => {
    const expected = [
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
    for (const code of expected) {
      expect(TRANSLATE_LOCALE_NAMES[code]).toBeDefined();
      expect(TRANSLATE_LOCALE_NAMES[code]!.length).toBeGreaterThan(0);
    }
  });

  it('uses native-language names (not English names)', () => {
    // If we ever drift to "Chinese" / "Japanese" we lose the prompt-quality
    // signal documented in text.ts. Pin the native-name guarantee here.
    expect(TRANSLATE_LOCALE_NAMES['zh-CN']).toBe('简体中文');
    expect(TRANSLATE_LOCALE_NAMES['ja']).toBe('日本語');
    expect(TRANSLATE_LOCALE_NAMES['ko']).toBe('한국어');
    expect(TRANSLATE_LOCALE_NAMES['ru']).toBe('Русский');
  });
});
