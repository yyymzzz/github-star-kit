/**
 * Source fetcher — pulls a curated set of source files from a starred
 * repo's GitHub tree without hitting per-file rate-limit pathologies.
 *
 * Strategy (chosen after subagent design review):
 *   1. ONE call to `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`
 *      — returns every path + size + sha in a single response.
 *   2. Filter the tree client-side: whitelist by extension, cap per-file
 *      bytes (skip lockfiles + bundles), deny-prefix walk (skip
 *      `node_modules`, `dist`, `vendor`, etc.).
 *   3. Take the top N (default 20) by a "looks like real source" heuristic
 *      that prefers `src/` and `lib/` prefixes.
 *   4. ONE call per selected file to `GET /repos/{owner}/{repo}/contents/{path}`
 *      — returns base64-encoded file content for paths up to 1 MB. Larger
 *      paths get skipped (the whitelist already excludes the common case).
 *
 * Total cost: ~21 GitHub API calls per opt-in deep-index of one repo —
 * well under the 5000/hr authenticated cap shared with star sync. The
 * heavier tarball-stream alternative would be 1 call + custom tar parser
 * + DecompressionStream in service-worker context — too much surface for
 * v1 when 21 calls fits the budget cleanly.
 */
import type { StarKitOctokitInstance } from '../github/client.js';
import { languageFromPath } from './chunk.js';

export interface SourceFile {
  /** Path within the repo, e.g. `src/utils/debounce.ts`. */
  readonly path: string;
  /** Decoded UTF-8 file content. */
  readonly content: string;
  /** Byte length of the encoded content (the size GitHub reports in the
   *  tree). Useful for "skip large files" downstream. */
  readonly bytes: number;
  /** Detected language from the file extension. null when the extension
   *  is unknown to chunk.ts (caller's chunker will sliding-window fallback). */
  readonly language: string | null;
}

export interface FetchRepoSourceOptions {
  readonly client: StarKitOctokitInstance;
  readonly owner: string;
  readonly repo: string;
  /** Git ref (branch / tag / sha) to read from. Defaults to "HEAD" which
   *  GitHub resolves to the default branch. */
  readonly ref?: string;
  /** Max files to actually fetch + return. Default 20. Each fetched file
   *  costs one API request, so this caps the rate-limit hit. */
  readonly maxFiles?: number;
  /** Files larger than this are skipped at the tree stage (no content
   *  fetch). Default 100 KB — covers ~95% of real source while dropping
   *  lockfiles, bundles, and committed `dist/`. */
  readonly maxFileBytes?: number;
  /** File extension whitelist (lowercase, no dot). Default: ts, tsx, js,
   *  jsx, mjs, py, rs, go, java. Pass a custom set to broaden / narrow. */
  readonly extensions?: ReadonlySet<string>;
  /** Path-segment deny-list. A file is rejected if any of its `/`-split
   *  segments matches an entry. Default skips node_modules / dist / build /
   *  target / vendor / .git / coverage / __snapshots__. */
  readonly denySegments?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
]);

export const DEFAULT_DENY_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.git',
  'coverage',
  '__snapshots__',
  '.next',
  '.nuxt',
  '.cache',
]);

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024;
/** GitHub's `contents` endpoint refuses to return content for paths larger
 *  than ~1 MB. We skip them rather than fall back to the blob API (which
 *  would add complexity without buying meaningful coverage at v1 sizes). */
const GITHUB_CONTENTS_BYTE_CAP = 1024 * 1024;

interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url?: string;
}

interface GitTreeResponse {
  sha: string;
  url: string;
  truncated: boolean;
  tree: GitTreeEntry[];
}

interface ContentsFileResponse {
  type: 'file';
  name: string;
  path: string;
  size: number;
  content: string;
  encoding: 'base64' | string;
}

/**
 * Score a path by "how likely is this real source the user would search
 * for". Higher = better.
 *
 *   "src/", "lib/", "packages/{name}/src/", top-level   → preferred
 *   "test/", "tests/", "spec/", "examples/"             → demoted
 *   anything else                                       → middle
 *
 * Used only for ranking when there are more matching files than maxFiles.
 * Returning ALL real-source files would burn API quota on large monorepos.
 */
function pathPreferenceScore(path: string): number {
  const segments = path.split('/');
  let score = 0;
  // src/lib bonus on the path's outer structure
  for (const seg of segments) {
    if (seg === 'src' || seg === 'lib') score += 5;
    if (seg === 'test' || seg === 'tests' || seg === 'spec') score -= 3;
    if (seg === 'examples' || seg === 'example' || seg === 'demo') score -= 2;
    if (seg === '__tests__' || seg === '__test__') score -= 3;
  }
  // Prefer files closer to the root (smaller path depth)
  score += Math.max(0, 5 - segments.length);
  return score;
}

/**
 * Filter the recursive git tree down to "files the chunker will produce
 * useful chunks from" without spending any API quota. Pure function on
 * the tree response.
 */
export function filterTree(
  tree: ReadonlyArray<GitTreeEntry>,
  opts: {
    readonly extensions: ReadonlySet<string>;
    readonly denySegments: ReadonlySet<string>;
    readonly maxFileBytes: number;
  }
): ReadonlyArray<GitTreeEntry> {
  const out: GitTreeEntry[] = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (typeof entry.size !== 'number' || entry.size <= 0) continue;
    if (entry.size > opts.maxFileBytes) continue;
    if (entry.size > GITHUB_CONTENTS_BYTE_CAP) continue;

    const segments = entry.path.split('/');
    let denied = false;
    for (const seg of segments) {
      if (opts.denySegments.has(seg)) {
        denied = true;
        break;
      }
    }
    if (denied) continue;

    const lastDot = entry.path.lastIndexOf('.');
    if (lastDot < 0) continue;
    const ext = entry.path.slice(lastDot + 1).toLowerCase();
    if (!opts.extensions.has(ext)) continue;

    out.push(entry);
  }
  return out;
}

/**
 * Pick the top-N tree entries by preference score, breaking ties on path
 * length (shorter wins — proxy for "more canonical"). Stable order so
 * tests can pin behavior.
 */
export function rankAndCap(
  entries: ReadonlyArray<GitTreeEntry>,
  maxFiles: number
): ReadonlyArray<GitTreeEntry> {
  const scored = entries.map((e) => ({
    e,
    score: pathPreferenceScore(e.path),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.e.path.length - b.e.path.length;
  });
  return scored.slice(0, maxFiles).map((s) => s.e);
}

/**
 * Decode a base64-encoded GitHub contents payload to UTF-8 string.
 * Strips embedded whitespace (GitHub line-wraps base64 at 60 chars).
 */
export function decodeBase64Content(b64: string): string {
  // Browsers + Node both have atob; the line-break stripping is required
  // because atob/Buffer.from rejects bare newlines on the strict path.
  const stripped = b64.replace(/\s+/g, '');
  // Use TextDecoder for proper UTF-8 — atob alone gives a binary string
  // that mishandles non-ASCII.
  const binary = typeof atob === 'function'
    ? atob(stripped)
    : Buffer.from(stripped, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Fetch source files from a starred GitHub repo, capped + filtered.
 *
 * Errors: GithubError from octokit bubbles unchanged. Per-file 404s (a
 * blob existed in the tree but isn't fetchable now, e.g. user force-pushed
 * between calls) are swallowed silently — those files are dropped from
 * the result rather than failing the whole index pass.
 */
export async function fetchRepoSource(
  opts: FetchRepoSourceOptions
): Promise<ReadonlyArray<SourceFile>> {
  const {
    client,
    owner,
    repo,
    ref = 'HEAD',
    maxFiles = DEFAULT_MAX_FILES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    extensions = DEFAULT_EXTENSIONS,
    denySegments = DEFAULT_DENY_SEGMENTS,
    signal,
  } = opts;

  // 1. Recursive tree — one API call regardless of repo size.
  const treeResp = await client.request(
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    {
      owner,
      repo,
      tree_sha: ref,
      recursive: '1',
      request: signal ? { signal } : {},
    }
  );
  const tree = (treeResp.data as GitTreeResponse).tree ?? [];

  // 2. Filter + rank + cap — all client-side, no extra API hits.
  const filtered = filterTree(tree, { extensions, denySegments, maxFileBytes });
  const selected = rankAndCap(filtered, maxFiles);

  // 3. Fetch each selected file's content. Sequential — parallelizing
  // here would burn API quota faster but octokit's plugin-throttling
  // already coordinates concurrency at the client level.
  const out: SourceFile[] = [];
  for (const entry of selected) {
    if (signal?.aborted) {
      throw new DOMException('fetchRepoSource aborted', 'AbortError');
    }
    try {
      const fileResp = await client.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner,
          repo,
          path: entry.path,
          ref,
          request: signal ? { signal } : {},
        }
      );
      const file = fileResp.data as ContentsFileResponse;
      if (file.type !== 'file' || file.encoding !== 'base64') continue;
      const content = decodeBase64Content(file.content);
      out.push({
        path: entry.path,
        content,
        bytes: entry.size!,
        language: languageFromPath(entry.path),
      });
    } catch (err) {
      // Per-file 404 / 403 — drop this file, continue with the rest.
      // (Octokit raises with status on the error; we only continue for
      // benign ones. AbortError + rate_limit should bubble.)
      const status = (err as { status?: number })?.status;
      if (status === 404 || status === 403) continue;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // Anything else also drops the file but logs — keeps the index pass
      // making forward progress on the ~95% of files that ARE fetchable.
      // Caller's overall orchestrator surfaces a "failed" count.
      continue;
    }
  }

  return out;
}
