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
    // 1500 chars > 1200 cap (bumped from 600 in R17 蓝军)
    const essay = 'a'.repeat(1500);
    expect(parseTranslateResponse(essay)).toBeNull();
  });

  it('keeps a long-but-acceptable description (just under cap)', () => {
    const longButOk = 'b'.repeat(1000);
    expect(parseTranslateResponse(longButOk)).toBe(longButOk);
  });
});

describe('parseTranslateResponse — R17 蓝军 suffix-note tolerance', () => {
  it('strips a trailing parenthetical "kept X untranslated" note', () => {
    expect(
      parseTranslateResponse(
        '这是一个 Rust 异步运行时。(I kept "React" untranslated because it\'s a brand name.)'
      )
    ).toBe('这是一个 Rust 异步运行时。');
  });

  it('strips a Chinese suffix note about preservation (保留 / 因为)', () => {
    expect(
      parseTranslateResponse('用于构建用户界面的库。(保留 React 为原文)')
    ).toBe('用于构建用户界面的库。');
  });

  it('strips Chinese-style full-width parentheses（）', () => {
    expect(
      parseTranslateResponse('一个异步运行时。（kept React as in source）')
    ).toBe('一个异步运行时。');
  });

  it('keeps a parenthetical that is NOT a translator note (no trigger word)', () => {
    // Legit parenthetical without "kept"/"untranslated"/etc. should pass.
    expect(parseTranslateResponse('一个数据库 (PostgreSQL).')).toBe(
      '一个数据库 (PostgreSQL).'
    );
  });

  it('splits at \\n\\n and keeps only paragraph 1 (multi-para model output)', () => {
    expect(
      parseTranslateResponse(
        '这是一个 Rust 异步运行时。\n\nNote: I preserved "React" as the original brand name.'
      )
    ).toBe('这是一个 Rust 异步运行时。');
  });

  it('does NOT split on a single newline within the same paragraph', () => {
    // A single \n inside paragraph text is part of the translation, not a
    // section break. Be tolerant of model wrapping at column 80.
    expect(parseTranslateResponse('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('handles combined: Translation: prefix + trailing note', () => {
    expect(
      parseTranslateResponse(
        'Translation: 这是一个运行时。\n\n(Kept "Rust" as brand name)'
      )
    ).toBe('这是一个运行时。');
  });

  it('accepts realistic 800-char German translation (under 1200 cap)', () => {
    // Compound-word languages (de, ru) routinely 1.5-2x English source.
    // v1 600-char cap rejected these; new 1200 accommodates.
    const realisticGerman = 'Das ist eine '.repeat(50) + 'Bibliothek.';
    expect(realisticGerman.length).toBeGreaterThan(600);
    expect(realisticGerman.length).toBeLessThan(1200);
    expect(parseTranslateResponse(realisticGerman)).toBe(realisticGerman);
  });
});

describe('parseTranslateResponse — R20 蓝军 markdown stripping', () => {
  it('strips **bold** wrappers, keeps content', () => {
    expect(parseTranslateResponse('**Tokio** 是一个**异步**运行时')).toBe(
      'Tokio 是一个异步运行时'
    );
  });

  it('strips __bold__ wrappers', () => {
    expect(parseTranslateResponse('__Tokio__ 是异步运行时')).toBe(
      'Tokio 是异步运行时'
    );
  });

  it('strips *italic* wrappers (with word-boundary safety)', () => {
    expect(parseTranslateResponse('*async* 异步*运行时*。')).toBe(
      'async 异步运行时。'
    );
  });

  it('strips _italic_ wrappers', () => {
    expect(parseTranslateResponse('_async_ 运行时')).toBe('async 运行时');
  });

  it('strips inline `code` spans', () => {
    expect(parseTranslateResponse('使用 `tokio::main` 启动')).toBe(
      '使用 tokio::main 启动'
    );
  });

  it('strips [text](url) markdown links, keeps the text', () => {
    expect(
      parseTranslateResponse('[React](https://react.dev) 是 UI 库')
    ).toBe('React 是 UI 库');
  });

  it('handles mixed markdown in one translation', () => {
    expect(
      parseTranslateResponse(
        '**Tokio** 是 [Rust](https://rust-lang.org) 的*异步*运行时, 用 `cargo` 安装'
      )
    ).toBe('Tokio 是 Rust 的异步运行时, 用 cargo 安装');
  });

  it('does NOT touch asterisks used as content (no matching pair)', () => {
    // A single `*` in the middle of a description shouldn't be eaten by
    // the bold/italic regex because the alternation requires a paired
    // close. `5 * 3 = 15` is content, not formatting.
    expect(parseTranslateResponse('数学: 5 * 3 = 15')).toBe('数学: 5 * 3 = 15');
  });
});

describe('parseTranslateResponse — R20 蓝军 #4 double-prefix peeling', () => {
  it('strips both layers of "Sure, here is the translation: 翻译结果:" prefix', () => {
    expect(
      parseTranslateResponse(
        'Sure, here is the translation: 翻译结果: 这是一个运行时。'
      )
    ).toBe('这是一个运行时。');
  });

  it('strips "Here is the translation:" followed by "译文:"', () => {
    expect(
      parseTranslateResponse("Here's the translated text: 译文: 你好世界")
    ).toBe('你好世界');
  });
});


describe('parseTranslateResponse — R17 蓝军 B3 paired-quote fix', () => {
  it('does NOT strip leading quote when there is no matching trailing quote', () => {
    // "reliable" async runtime — outer first char is `"` but last is `e`,
    // no pair → keep as-is. v1 stripped leading `"` alone → corruption.
    expect(parseTranslateResponse('"reliable" async runtime')).toBe(
      '"reliable" async runtime'
    );
  });

  it('does NOT strip mismatched ascii + backtick combo', () => {
    // Leading `"`, trailing `` ` `` — not a pair, keep both.
    expect(parseTranslateResponse('"hello`')).toBe('"hello`');
  });

  it('STILL strips genuinely paired wrapping quotes', () => {
    expect(parseTranslateResponse('"hello world"')).toBe('hello world');
    expect(parseTranslateResponse("'hello'")).toBe('hello');
    expect(parseTranslateResponse('`hello`')).toBe('hello');
  });

  it('does NOT strip symmetric quote pair when interior contains the same quote', () => {
    // "she said "hi""  → not a clean outer pair (the interior `"` chars
    // means the outer aren't actually wrapping). v1 stripped both, leaving
    // unbalanced.
    expect(parseTranslateResponse('"she said "hi""')).toBe('"she said "hi""');
  });

  it('strips CJK paired quotes 「」 even when interior contains the same chars', () => {
    // Asymmetric pairs (open ≠ close) are unambiguous — interior content
    // can legitimately contain either char without breaking the wrap.
    expect(parseTranslateResponse('「你好」')).toBe('你好');
  });
});

describe('parseTranslateResponse — R17 蓝军 C1 verbose-preamble fix', () => {
  it('strips "Sure, here is the translation:" prefix', () => {
    expect(
      parseTranslateResponse("Sure, here's the translation: 你好世界")
    ).toBe('你好世界');
  });

  it('strips "Here is the translation:" variant', () => {
    expect(parseTranslateResponse('Here is the translation: hola mundo')).toBe(
      'hola mundo'
    );
  });

  it('strips Chinese "翻译结果:" / "译文:" verbose prefix', () => {
    expect(parseTranslateResponse('翻译结果: 你好世界')).toBe('你好世界');
    expect(parseTranslateResponse('译文: 你好世界')).toBe('你好世界');
    expect(parseTranslateResponse('翻译内容: 你好世界')).toBe('你好世界');
  });

  it('strips Traditional 翻譯結果 / 譯文', () => {
    expect(parseTranslateResponse('翻譯結果：你好')).toBe('你好');
    expect(parseTranslateResponse('譯文：你好')).toBe('你好');
  });

  it('compound case: "Sure, here is" prefix + paired quotes inside', () => {
    expect(
      parseTranslateResponse('Sure, here is the translation: "你好世界"')
    ).toBe('你好世界');
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
