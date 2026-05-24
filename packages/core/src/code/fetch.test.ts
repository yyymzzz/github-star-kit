import { describe, expect, it } from 'vitest';
import {
  decodeBase64Content,
  DEFAULT_DENY_SEGMENTS,
  DEFAULT_EXTENSIONS,
  fetchRepoSource,
  filterTree,
  rankAndCap,
} from './fetch.js';

describe('filterTree', () => {
  const opts = {
    extensions: DEFAULT_EXTENSIONS,
    denySegments: DEFAULT_DENY_SEGMENTS,
    maxFileBytes: 100_000,
  };

  it('keeps source files with whitelisted extensions', () => {
    const out = filterTree(
      [
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'a', size: 500 },
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'b', size: 500 },
        { path: 'src/utils.js', mode: '100644', type: 'blob', sha: 'c', size: 500 },
      ],
      opts
    );
    expect(out.map((e) => e.path)).toEqual(['src/index.ts', 'src/utils.js']);
  });

  it('drops blobs in deny-listed directories at any depth', () => {
    const out = filterTree(
      [
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'a', size: 500 },
        { path: 'node_modules/foo/index.js', mode: '100644', type: 'blob', sha: 'b', size: 500 },
        { path: 'dist/bundle.js', mode: '100644', type: 'blob', sha: 'c', size: 500 },
        { path: 'apps/web/__snapshots__/x.snap', mode: '100644', type: 'blob', sha: 'd', size: 500 },
        { path: 'apps/web/src/main.ts', mode: '100644', type: 'blob', sha: 'e', size: 500 },
      ],
      opts
    );
    expect(out.map((e) => e.path).sort()).toEqual(['apps/web/src/main.ts', 'src/index.ts']);
  });

  it('drops files larger than maxFileBytes', () => {
    const out = filterTree(
      [
        { path: 'a.ts', mode: '100644', type: 'blob', sha: 'a', size: 500 },
        { path: 'b.ts', mode: '100644', type: 'blob', sha: 'b', size: 500_000 },
      ],
      opts
    );
    expect(out.map((e) => e.path)).toEqual(['a.ts']);
  });

  it('drops tree (directory) entries', () => {
    const out = filterTree(
      [
        { path: 'src', mode: '040000', type: 'tree', sha: 'a' },
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'b', size: 500 },
      ],
      opts
    );
    expect(out).toHaveLength(1);
  });

  it('drops entries with no size or zero size', () => {
    const out = filterTree(
      [
        { path: 'a.ts', mode: '100644', type: 'blob', sha: 'a' },
        { path: 'b.ts', mode: '100644', type: 'blob', sha: 'b', size: 0 },
        { path: 'c.ts', mode: '100644', type: 'blob', sha: 'c', size: 500 },
      ],
      opts
    );
    expect(out.map((e) => e.path)).toEqual(['c.ts']);
  });

  it('respects custom extension whitelist', () => {
    const out = filterTree(
      [
        { path: 'a.ts', mode: '100644', type: 'blob', sha: 'a', size: 500 },
        { path: 'b.md', mode: '100644', type: 'blob', sha: 'b', size: 500 },
      ],
      { ...opts, extensions: new Set(['md']) }
    );
    expect(out.map((e) => e.path)).toEqual(['b.md']);
  });
});

describe('rankAndCap', () => {
  it('prefers src/ + lib/ over top-level over test/', () => {
    const entries = [
      { path: 'test/foo.ts', mode: '100644', type: 'blob' as const, sha: 'a', size: 100 },
      { path: 'index.ts', mode: '100644', type: 'blob' as const, sha: 'b', size: 100 },
      { path: 'src/main.ts', mode: '100644', type: 'blob' as const, sha: 'c', size: 100 },
    ];
    const out = rankAndCap(entries, 10);
    expect(out[0]!.path).toBe('src/main.ts'); // src bonus wins
  });

  it('caps to maxFiles', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      path: `src/f${i}.ts`,
      mode: '100644',
      type: 'blob' as const,
      sha: String(i),
      size: 100,
    }));
    const out = rankAndCap(entries, 5);
    expect(out).toHaveLength(5);
  });

  it('is deterministic — same input always same order', () => {
    const entries = [
      { path: 'lib/b.ts', mode: '100644', type: 'blob' as const, sha: 'a', size: 100 },
      { path: 'src/a.ts', mode: '100644', type: 'blob' as const, sha: 'b', size: 100 },
      { path: 'lib/aa.ts', mode: '100644', type: 'blob' as const, sha: 'c', size: 100 },
    ];
    const out1 = rankAndCap(entries, 10);
    const out2 = rankAndCap(entries, 10);
    expect(out1.map((e) => e.path)).toEqual(out2.map((e) => e.path));
  });
});

describe('decodeBase64Content', () => {
  it('decodes plain ASCII', () => {
    expect(decodeBase64Content('aGVsbG8=')).toBe('hello');
  });

  it('strips embedded newlines (GitHub wraps base64 at 60 chars)', () => {
    // 'hello world this is a longer piece of text to wrap...'
    const text = 'hello world this is a longer piece of text to wrap to 60 chars';
    // Manually inject \n every 60 chars to mimic GitHub's wrapping
    const b64 = Buffer.from(text).toString('base64');
    const wrapped = b64.match(/.{1,60}/g)!.join('\n') + '\n';
    expect(decodeBase64Content(wrapped)).toBe(text);
  });

  it('decodes UTF-8 multi-byte chars correctly', () => {
    const text = '汉字 + emoji 🚀';
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    expect(decodeBase64Content(b64)).toBe(text);
  });

  it('handles empty input', () => {
    expect(decodeBase64Content('')).toBe('');
  });
});

describe('fetchRepoSource — integration via mocked octokit', () => {
  function mockClient(handlers: {
    tree?: () => unknown;
    contents?: (path: string) => unknown;
  }) {
    return {
      request: async (
        endpoint: string,
        params: { path?: string }
      ) => {
        if (endpoint === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
          return { data: handlers.tree ? handlers.tree() : { tree: [] } };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/contents/{path}') {
          if (!handlers.contents) {
            throw Object.assign(new Error('no handler'), { status: 404 });
          }
          return { data: handlers.contents(params.path!) };
        }
        throw new Error(`unexpected endpoint: ${endpoint}`);
      },
    } as unknown as Parameters<typeof fetchRepoSource>[0]['client'];
  }

  it('fetches whitelisted source files and decodes their content', async () => {
    const client = mockClient({
      tree: () => ({
        tree: [
          { path: 'src/debounce.ts', mode: '100644', type: 'blob', sha: 'a', size: 200 },
          { path: 'README.md', mode: '100644', type: 'blob', sha: 'b', size: 1000 },
          { path: 'node_modules/x.js', mode: '100644', type: 'blob', sha: 'c', size: 50 },
        ],
      }),
      contents: (path: string) => ({
        type: 'file',
        name: path.split('/').pop()!,
        path,
        size: 200,
        content: Buffer.from(`// content of ${path}`).toString('base64'),
        encoding: 'base64',
      }),
    });

    const files = await fetchRepoSource({
      client,
      owner: 'foo',
      repo: 'bar',
    });

    // README dropped (not in extension whitelist); node_modules dropped (deny segment)
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/debounce.ts');
    expect(files[0]!.content).toBe('// content of src/debounce.ts');
    expect(files[0]!.language).toBe('typescript');
  });

  it('swallows per-file 404 and continues with remaining files', async () => {
    const client = mockClient({
      tree: () => ({
        tree: [
          { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'a', size: 100 },
          { path: 'src/b.ts', mode: '100644', type: 'blob', sha: 'b', size: 100 },
        ],
      }),
      contents: (path: string) => {
        if (path === 'src/a.ts') {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        return {
          type: 'file',
          name: 'b.ts',
          path,
          size: 100,
          content: Buffer.from(`// ${path}`).toString('base64'),
          encoding: 'base64',
        };
      },
    });

    const files = await fetchRepoSource({ client, owner: 'foo', repo: 'bar' });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/b.ts');
  });

  it('honors AbortSignal between content fetches', async () => {
    const controller = new AbortController();
    let count = 0;
    const client = mockClient({
      tree: () => ({
        tree: [
          { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'a', size: 100 },
          { path: 'src/b.ts', mode: '100644', type: 'blob', sha: 'b', size: 100 },
          { path: 'src/c.ts', mode: '100644', type: 'blob', sha: 'c', size: 100 },
        ],
      }),
      contents: (path: string) => {
        count += 1;
        if (count === 1) controller.abort();
        return {
          type: 'file',
          name: path,
          path,
          size: 100,
          content: Buffer.from('x').toString('base64'),
          encoding: 'base64',
        };
      },
    });

    await expect(
      fetchRepoSource({
        client,
        owner: 'foo',
        repo: 'bar',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('caps total fetches at maxFiles', async () => {
    let fetched = 0;
    const client = mockClient({
      tree: () => ({
        tree: Array.from({ length: 50 }, (_, i) => ({
          path: `src/f${i}.ts`,
          mode: '100644',
          type: 'blob' as const,
          sha: String(i),
          size: 100,
        })),
      }),
      contents: (path: string) => {
        fetched += 1;
        return {
          type: 'file',
          name: path,
          path,
          size: 100,
          content: Buffer.from('x').toString('base64'),
          encoding: 'base64',
        };
      },
    });

    const files = await fetchRepoSource({
      client,
      owner: 'foo',
      repo: 'bar',
      maxFiles: 3,
    });
    expect(files).toHaveLength(3);
    expect(fetched).toBe(3);
  });
});
