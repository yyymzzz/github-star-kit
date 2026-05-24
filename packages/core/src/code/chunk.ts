/**
 * Source-code chunking for W5 deep-indexed code search.
 *
 * v1 ships a layered chunker:
 *   1. `chunkBySemantic` — language-aware: a small regex menu finds function /
 *      class / impl headers, then carves each chunk from that header to the
 *      next sibling header (or EOF, or a max-line cap).
 *   2. `chunkBySlidingWindow` — language-agnostic fallback: fixed-size
 *      overlapping windows. Always works, even on unfamiliar languages.
 *
 * `chunkSource` picks (1) for languages it knows, (2) for everything else.
 * Bundling: this module is ~150 lines of pure JS, zero deps — keeps the
 * extension popup bundle small. tree-sitter / wasm bindings would add ~2MB,
 * deferred to a v2 quality upgrade if v1 chunks are bad enough to need it.
 *
 * Why not tree-sitter v1: it solves "perfect AST chunks" but v1 demo gate
 * only needs "code snippet that semantically matches the query" — fuzzy
 * boundaries are acceptable as long as the chunk is small enough that the
 * embedding can capture intent. A 40-line chunk with a stray closing brace
 * still embeds as "debounce hook"-shaped if the body is.
 */

export interface CodeChunk {
  /** Verbatim source text of the chunk. */
  readonly text: string;
  /** 1-indexed first line of the chunk in the original file. */
  readonly startLine: number;
  /** 1-indexed last line (inclusive). */
  readonly endLine: number;
  /**
   * What kind of semantic boundary the chunker detected. `'function'`,
   * `'class'`, `'method'`, etc. when chunkBySemantic matched a known header;
   * `'window'` when the sliding-window fallback produced this chunk. Lets
   * the search UI weight semantic matches over window matches if it wants.
   */
  readonly kind: ChunkKind;
  /**
   * The header line that triggered the semantic split (e.g.
   * `function debounce(fn, ms)`). Useful as a one-line preview when the UI
   * can't show the whole chunk. Empty for `'window'` kind.
   */
  readonly headerLine: string;
}

export type ChunkKind =
  | 'function'
  | 'class'
  | 'method'
  | 'impl'
  | 'type'
  | 'window';

export interface ChunkOptions {
  /** Max lines per chunk. Above this we cap and start a new chunk even mid-
   *  function. Default 80 — empirically holds most utility functions whole
   *  while keeping embed token cost bounded (~600 tokens / chunk). */
  readonly maxLines?: number;
  /**
   * For the sliding-window fallback: how many lines each window overlaps
   * with the previous one. Default 10 — half of the typical "small helper
   * fn" length, so a function split across a window boundary still appears
   * intact in one of the two windows.
   */
  readonly windowOverlap?: number;
  /**
   * For the sliding-window fallback: target lines per window. Default 40.
   * Smaller windows = more chunks but tighter per-chunk semantics; bigger
   * windows = fewer chunks but blurrier embeddings.
   */
  readonly windowSize?: number;
}

const DEFAULT_MAX_LINES = 80;
const DEFAULT_WINDOW_SIZE = 40;
const DEFAULT_WINDOW_OVERLAP = 10;

/**
 * Language identifier — accepted by `chunkSource`. The string is whatever
 * GitHub's `language` field on a repo / file returns; we lowercase + match.
 * Unknown → sliding-window fallback.
 */
export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | string;

interface HeaderPattern {
  readonly kind: ChunkKind;
  /** Regex matched against a trimmed line. */
  readonly re: RegExp;
}

/**
 * Per-language header regex menu. Order matters when multiple patterns
 * could match — first wins. Keep these intentionally simple; we don't need
 * to handle every syntactic edge case, just the common ones.
 */
const HEADER_PATTERNS: Record<string, HeaderPattern[]> = {
  javascript: [
    { kind: 'class', re: /^(?:export\s+)?(?:default\s+)?class\s+\w+/ },
    { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w+\s*\(/ },
    // const debounce = (fn, ms) => { ... }  OR  const debounce = function() {...}
    { kind: 'function', re: /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function|\()/ },
    // class methods: indented `methodName(args) {` or `async methodName(args) {`
    { kind: 'method', re: /^\s+(?:static\s+)?(?:async\s+)?#?\w+\s*\([^)]*\)\s*\{/ },
  ],
  typescript: [
    { kind: 'class', re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+/ },
    { kind: 'type', re: /^(?:export\s+)?(?:type|interface)\s+\w+/ },
    { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w+\s*[<(]/ },
    { kind: 'function', re: /^(?:export\s+)?(?:const|let|var)\s+\w+(?:\s*:[^=]+)?\s*=\s*(?:async\s*)?(?:function|\(|<)/ },
    { kind: 'method', re: /^\s+(?:public|private|protected|static|readonly|async|\s)*\w+\s*[<(]/ },
  ],
  python: [
    { kind: 'class', re: /^class\s+\w+/ },
    { kind: 'function', re: /^(?:async\s+)?def\s+\w+/ },
    { kind: 'method', re: /^\s+(?:@\w+(?:\([^)]*\))?\s*)*(?:async\s+)?def\s+\w+/ },
  ],
  rust: [
    { kind: 'impl', re: /^impl(?:\s*<[^>]*>)?\s+\w+/ },
    { kind: 'function', re: /^(?:pub\s+)?(?:async\s+)?fn\s+\w+/ },
    { kind: 'type', re: /^(?:pub\s+)?(?:struct|enum|trait|type)\s+\w+/ },
    { kind: 'method', re: /^\s+(?:pub\s+)?(?:async\s+)?fn\s+\w+/ },
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]+\)\s+)?\w+\s*\(/ },
    { kind: 'type', re: /^type\s+\w+\s+(?:struct|interface)/ },
  ],
  java: [
    { kind: 'class', re: /^(?:public|private|protected|abstract|final|\s)*class\s+\w+/ },
    { kind: 'method', re: /^\s+(?:public|private|protected|static|final|abstract|synchronized|\s)*\w+(?:<[^>]+>)?\s+\w+\s*\(/ },
  ],
};

/**
 * Map a free-form language label (GitHub's `language`, or a file extension)
 * to the canonical key in HEADER_PATTERNS. Returns `null` for unknowns —
 * caller falls back to sliding-window.
 */
export function normalizeLanguage(label: string): string | null {
  const lower = label.toLowerCase().trim();
  if (HEADER_PATTERNS[lower]) return lower;
  // Accept common aliases / extensions
  const aliases: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rs: 'rust',
  };
  return aliases[lower] ?? null;
}

/**
 * Map a filename to a language via its extension. Returns `null` for
 * extensions we don't recognize — caller should use sliding-window then.
 */
export function languageFromPath(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return null;
  return normalizeLanguage(m[1]!);
}

/**
 * Language-aware semantic chunker. Returns one chunk per detected header
 * (function / class / method / etc.). A long body that exceeds `maxLines`
 * gets split into multiple chunks of the same kind.
 *
 * Algorithm:
 *   1. Walk lines top-to-bottom, classifying each as either a header
 *      (matched a pattern) or body.
 *   2. Each header starts a new chunk. The chunk runs until the next header
 *      OR until we'd exceed maxLines (then split mid-body, retain the kind
 *      so the second chunk inherits the function's semantic context).
 *
 * Limitations (acceptable for v1 demo gate):
 *   - Doesn't track brace / indent depth, so a top-level function and its
 *     nested helper land in the same chunk. Acceptable — that's actually
 *     useful semantically (the helper is part of the parent's behavior).
 *   - Class methods get their own chunks because they match the `method`
 *     header regex even though they're inside a class. That's good — the
 *     embedding for a method should reflect just that method, not the
 *     surrounding class noise.
 */
export function chunkBySemantic(
  source: string,
  language: string,
  opts: ChunkOptions = {}
): ReadonlyArray<CodeChunk> {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const patterns = HEADER_PATTERNS[language];
  if (!patterns) {
    // Unknown language at the semantic layer — caller should have routed
    // to sliding-window; if they explicitly asked for semantic, return
    // a single window-shaped chunk covering the whole file.
    return chunkBySlidingWindow(source, opts);
  }

  const lines = source.split('\n');
  if (lines.length === 0) return [];

  const out: CodeChunk[] = [];
  let currentStart = -1;
  let currentKind: ChunkKind | null = null;
  let currentHeader = '';

  const flush = (endLineIdx: number) => {
    if (currentStart < 0 || currentKind === null) return;
    const text = lines.slice(currentStart, endLineIdx + 1).join('\n');
    out.push({
      text,
      startLine: currentStart + 1,
      endLine: endLineIdx + 1,
      kind: currentKind,
      headerLine: currentHeader,
    });
    currentStart = -1;
    currentKind = null;
    currentHeader = '';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const matched = matchHeader(line, patterns);

    if (matched) {
      // End the previous chunk (if any) at the line before this header.
      if (currentStart >= 0) flush(i - 1);
      currentStart = i;
      currentKind = matched.kind;
      currentHeader = line.trim();
    } else if (currentStart >= 0 && i - currentStart + 1 >= maxLines) {
      // Hit the size cap inside a chunk — split. flush() nulls currentKind
      // as part of its reset, so capture and restore it: the continuation
      // chunk keeps the same kind so search-time weighting still sees it
      // as semantic, not window. Without this restore, the continuation
      // grows with currentKind=null and flush silently drops it at EOF.
      const continuationKind = currentKind;
      flush(i);
      currentStart = i + 1;
      currentKind = continuationKind;
      currentHeader = '';
    }
  }
  if (currentStart >= 0) flush(lines.length - 1);

  // If the file had ZERO header matches, fall back to sliding-window so the
  // user still gets *something* indexed. Long config files / data files
  // with no function definitions otherwise produce zero chunks.
  if (out.length === 0) return chunkBySlidingWindow(source, opts);
  return out;
}

function matchHeader(line: string, patterns: ReadonlyArray<HeaderPattern>): HeaderPattern | null {
  for (const p of patterns) {
    if (p.re.test(line)) return p;
  }
  return null;
}

/**
 * Language-agnostic sliding-window chunker. Splits the source into windows
 * of `windowSize` lines with `windowOverlap` lines of overlap. The overlap
 * means a function split across a boundary still appears whole in at least
 * one window (assuming the function is shorter than `windowSize - overlap`).
 *
 * Edge cases:
 *   - Empty source → []
 *   - Source shorter than windowSize → 1 chunk covering the whole file
 *   - Overlap >= windowSize → invariant violation, throws (would loop forever)
 */
export function chunkBySlidingWindow(
  source: string,
  opts: ChunkOptions = {}
): ReadonlyArray<CodeChunk> {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  const overlap = opts.windowOverlap ?? DEFAULT_WINDOW_OVERLAP;
  if (overlap >= windowSize) {
    throw new Error(
      `chunkBySlidingWindow: windowOverlap (${overlap}) must be < windowSize (${windowSize})`
    );
  }

  const lines = source.split('\n');
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return [];

  const stride = windowSize - overlap;
  const out: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + windowSize, lines.length);
    out.push({
      text: lines.slice(start, end).join('\n'),
      startLine: start + 1,
      endLine: end,
      kind: 'window',
      headerLine: '',
    });
    if (end >= lines.length) break;
  }
  return out;
}

/**
 * Top-level dispatch. Use this from the embed pipeline / source fetcher —
 * it auto-picks semantic vs window based on language and falls back
 * gracefully on unknown languages.
 */
export function chunkSource(
  source: string,
  language: string | null,
  opts: ChunkOptions = {}
): ReadonlyArray<CodeChunk> {
  const normalized = language ? normalizeLanguage(language) : null;
  if (normalized) return chunkBySemantic(source, normalized, opts);
  return chunkBySlidingWindow(source, opts);
}
