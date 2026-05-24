import { describe, expect, it } from 'vitest';
import {
  chunkBySemantic,
  chunkBySlidingWindow,
  chunkSource,
  languageFromPath,
  normalizeLanguage,
  type CodeChunk,
} from './chunk.js';

describe('normalizeLanguage', () => {
  it('returns canonical key for canonical names', () => {
    expect(normalizeLanguage('javascript')).toBe('javascript');
    expect(normalizeLanguage('TypeScript')).toBe('typescript'); // case-insensitive
    expect(normalizeLanguage('Python')).toBe('python');
    expect(normalizeLanguage('Rust')).toBe('rust');
    expect(normalizeLanguage('Go')).toBe('go');
    expect(normalizeLanguage('Java')).toBe('java');
  });

  it('maps common aliases', () => {
    expect(normalizeLanguage('js')).toBe('javascript');
    expect(normalizeLanguage('jsx')).toBe('javascript');
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('tsx')).toBe('typescript');
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('rs')).toBe('rust');
  });

  it('returns null for unknown languages', () => {
    expect(normalizeLanguage('cobol')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
  });
});

describe('languageFromPath', () => {
  it('extracts language from file extension', () => {
    expect(languageFromPath('src/index.ts')).toBe('typescript');
    expect(languageFromPath('main.py')).toBe('python');
    expect(languageFromPath('lib/utils.js')).toBe('javascript');
    expect(languageFromPath('Cargo.rs')).toBe('rust');
  });

  it('handles paths with multiple dots', () => {
    expect(languageFromPath('component.test.tsx')).toBe('typescript');
  });

  it('returns null for extensions without a known mapping', () => {
    expect(languageFromPath('README.md')).toBeNull();
    expect(languageFromPath('config.yaml')).toBeNull();
  });

  it('returns null for files with no extension', () => {
    expect(languageFromPath('Makefile')).toBeNull();
    expect(languageFromPath('LICENSE')).toBeNull();
  });
});

describe('chunkBySemantic — JavaScript / TypeScript', () => {
  it('splits a file with multiple top-level functions into one chunk each', () => {
    const src = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'function sub(a, b) {',
      '  return a - b;',
      '}',
      '',
      'function mul(a, b) {',
      '  return a * b;',
      '}',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'javascript');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.headerLine).toContain('function add');
    expect(chunks[1]!.headerLine).toContain('function sub');
    expect(chunks[2]!.headerLine).toContain('function mul');
    expect(chunks.every((c) => c.kind === 'function')).toBe(true);
  });

  it('captures arrow-function const declarations', () => {
    const src = [
      'export const debounce = (fn, ms) => {',
      '  let t;',
      '  return (...args) => {',
      '    clearTimeout(t);',
      '    t = setTimeout(() => fn(...args), ms);',
      '  };',
      '};',
      '',
      'export const throttle = (fn, ms) => { /* ... */ };',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'javascript');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.headerLine).toContain('debounce');
    expect(chunks[1]!.headerLine).toContain('throttle');
  });

  it('recognizes async functions', () => {
    const src = [
      'export async function loadUser(id) {',
      '  const r = await fetch(`/users/${id}`);',
      '  return r.json();',
      '}',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'javascript');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('function');
  });

  it('splits TS class with methods into class + per-method chunks', () => {
    const src = [
      'export class Counter {',
      '  private count = 0;',
      '',
      '  increment(): void {',
      '    this.count += 1;',
      '  }',
      '',
      '  decrement(): void {',
      '    this.count -= 1;',
      '  }',
      '}',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'typescript');
    // Expect at least: class header chunk + 2 method chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain('class');
    expect(kinds.filter((k) => k === 'method').length).toBeGreaterThanOrEqual(1);
  });

  it('preserves accurate line numbers for each chunk', () => {
    const src = [
      '// line 1',
      'function a() {',  // line 2
      '  return 1;',     // line 3
      '}',               // line 4
      '',                // line 5
      'function b() {',  // line 6
      '  return 2;',     // line 7
      '}',               // line 8
    ].join('\n');
    const chunks = chunkBySemantic(src, 'javascript');
    expect(chunks[0]!.startLine).toBe(2);
    // chunk a ends at line 5 (line before next header), b starts at 6
    expect(chunks[1]!.startLine).toBe(6);
  });
});

describe('chunkBySemantic — Python', () => {
  it('splits def + class', () => {
    const src = [
      'def add(a, b):',
      '    return a + b',
      '',
      'class Counter:',
      '    def __init__(self):',
      '        self.count = 0',
      '',
      '    def increment(self):',
      '        self.count += 1',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'python');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('class');
  });

  it('recognizes async def', () => {
    const src = [
      'async def load(url):',
      '    return await http.get(url)',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'python');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('function');
  });
});

describe('chunkBySemantic — Rust', () => {
  it('splits fn + impl + struct', () => {
    const src = [
      'pub fn helper() -> u32 { 42 }',
      '',
      'pub struct Counter { count: u32 }',
      '',
      'impl Counter {',
      '    pub fn new() -> Self { Self { count: 0 } }',
      '    pub fn inc(&mut self) { self.count += 1; }',
      '}',
    ].join('\n');
    const chunks = chunkBySemantic(src, 'rust');
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('impl');
    expect(kinds).toContain('type'); // struct
  });
});

describe('chunkBySemantic — max-lines cap', () => {
  it('splits a long function body into multiple chunks at the cap', () => {
    const lines = ['function huge() {'];
    for (let i = 0; i < 200; i += 1) lines.push(`  // line ${i}`);
    lines.push('}');
    const chunks = chunkBySemantic(lines.join('\n'), 'javascript', { maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk owns the header line
    expect(chunks[0]!.headerLine).toContain('function huge');
    // Continuation chunks keep the kind but empty headerLine
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.kind).toBe('function');
      expect(chunks[i]!.headerLine).toBe('');
    }
  });
});

describe('chunkBySemantic — fallback to sliding window', () => {
  it('falls back to sliding window when zero headers match', () => {
    const src = ['just', 'some', 'plain', 'text', 'with no functions'].join('\n');
    const chunks = chunkBySemantic(src, 'javascript');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.kind).toBe('window');
  });

  it('falls back to sliding window for an unrecognized language passed in', () => {
    const src = 'whatever';
    const chunks = chunkBySemantic(src, 'cobol');
    expect(chunks[0]!.kind).toBe('window');
  });
});

describe('chunkBySlidingWindow', () => {
  it('produces a single window for source shorter than windowSize', () => {
    const src = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkBySlidingWindow(src, { windowSize: 40 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(10);
  });

  it('produces overlapping windows for longer source', () => {
    const src = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkBySlidingWindow(src, { windowSize: 40, windowOverlap: 10 });
    // 100 lines / (40 - 10 stride) = ceil(100/30) = 4 windows. But last
    // window may be short.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // First window covers 1..40
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(40);
    // Second window starts at 31 (stride 30 from first)
    expect(chunks[1]!.startLine).toBe(31);
    expect(chunks.every((c) => c.kind === 'window')).toBe(true);
  });

  it('returns [] for empty source', () => {
    expect(chunkBySlidingWindow('')).toEqual([]);
  });

  it('throws when overlap >= windowSize (would loop forever)', () => {
    expect(() => chunkBySlidingWindow('x\ny', { windowSize: 10, windowOverlap: 10 })).toThrow();
    expect(() => chunkBySlidingWindow('x\ny', { windowSize: 10, windowOverlap: 20 })).toThrow();
  });
});

describe('chunkSource — top-level dispatch', () => {
  it('uses semantic for known language', () => {
    const chunks = chunkSource('function a() {}', 'javascript');
    expect(chunks[0]!.kind).toBe('function');
  });

  it('uses sliding window when language is null', () => {
    const src = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkSource(src, null);
    expect(chunks[0]!.kind).toBe('window');
  });

  it('uses sliding window for unknown language', () => {
    const chunks = chunkSource('whatever', 'cobol');
    expect(chunks[0]!.kind).toBe('window');
  });
});

describe('chunkSource — invariants across all chunks', () => {
  const cases: Array<{ name: string; src: string; lang: string | null }> = [
    {
      name: 'JS classes + functions',
      src: [
        'class A { foo() {} bar() {} }',
        'function helper() { return 1; }',
      ].join('\n'),
      lang: 'javascript',
    },
    {
      name: 'Python module',
      src: 'def a(): pass\ndef b(): pass',
      lang: 'python',
    },
    {
      name: 'Plain text',
      src: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'),
      lang: null,
    },
  ];

  for (const c of cases) {
    it(`every chunk has startLine <= endLine — ${c.name}`, () => {
      const chunks = chunkSource(c.src, c.lang);
      for (const ch of chunks) {
        expect(ch.startLine).toBeGreaterThanOrEqual(1);
        expect(ch.endLine).toBeGreaterThanOrEqual(ch.startLine);
      }
    });

    it(`headerLine matches first line of text for semantic chunks — ${c.name}`, () => {
      const chunks = chunkSource(c.src, c.lang);
      for (const ch of chunks) {
        if (ch.kind === 'window') continue;
        if (ch.headerLine === '') continue; // continuation chunk
        const firstLine = ch.text.split('\n')[0]!.trim();
        expect(firstLine).toBe(ch.headerLine);
      }
    });
  }
});
