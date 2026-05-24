/**
 * W5 demo-gate integration smoke.
 *
 * Wires the full deep-index → embed → search → permalink chain that the
 * popup runs at runtime, on fake-indexeddb + a mocked Octokit + a fake
 * deterministic embed function.
 *
 * Proves:
 *   1. The W5 D2 orchestrator (indexRepoCode) composes with the W3 D2
 *      embedStars-shaped callbacks (embed / upsert / getExisting) and the
 *      W3 D3 IndexedDBVectorStore without adapter glue beyond what App.tsx
 *      already writes.
 *   2. A query embedding searched against a vector store containing both
 *      star embeddings AND code chunk embeddings returns chunks that map
 *      back to the originating repo + path + line range. The popup's
 *      CodeSnippet renderer reads exactly these metadata fields, so a
 *      passing smoke here ≈ a working demo-gate UX.
 *   3. End-to-end runtime on a single-repo / single-file deep-index +
 *      search is well under the W5 budget (real-world budget dominated by
 *      OpenAI network latency for query embed; this smoke covers only
 *      the local hop).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  embedStars,
  indexRepoCode,
  openStarKitDb,
  IndexedDBStarStore,
  type EmbedBatchFn,
  type StarredRepo,
} from '@starkit/core';
import { IndexedDBVectorStore, MemoryVectorStore } from '@starkit/vector';

function makeStar(id: number, overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id,
    fullName: `lodash/${id === 1 ? 'lodash' : 'other'}`,
    htmlUrl: `https://github.com/lodash/${id === 1 ? 'lodash' : 'other'}`,
    ownerLogin: 'lodash',
    ownerAvatarUrl: null,
    description: 'JS utility library',
    topics: ['utility'],
    language: 'JavaScript',
    starredAt: '2024-01-01T00:00:00Z',
    pushedAt: '2024-06-01T00:00:00Z',
    stargazersCount: 100,
    defaultBranch: 'main',
    archived: false,
    isFork: false,
    subscribedToReleases: false,
    deepIndexed: false,
    aiTags: [],
    aiSummary: null,
    userNote: null,
    lastEmbeddedAt: null,
    lastSyncedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

const DEBOUNCE_SRC = [
  '// debounce: delay invocation until input stops',
  'export function debounce(fn, ms) {',
  '  let t;',
  '  return (...args) => {',
  '    clearTimeout(t);',
  '    t = setTimeout(() => fn(...args), ms);',
  '  };',
  '}',
  '',
  'export function throttle(fn, ms) {',
  '  let last = 0;',
  '  return (...args) => {',
  '    const now = Date.now();',
  '    if (now - last >= ms) {',
  '      last = now;',
  '      fn(...args);',
  '    }',
  '  };',
  '}',
].join('\n');

/**
 * Deterministic fake embedding — bag-of-character-codes. Queries and
 * source chunks sharing many of the same characters get high cosine
 * similarity, which is enough for "debounce hook" → debounce chunk to
 * rank higher than unrelated chunks. Real OpenAI embeddings do better,
 * but this is structurally sound for an integration smoke.
 */
function fakeEmbed(text: string, dim = 32): number[] {
  const out = new Array<number>(dim).fill(0);
  const t = text.toLowerCase();
  for (let i = 0; i < t.length; i += 1) {
    out[t.charCodeAt(i) % dim] = (out[t.charCodeAt(i) % dim] ?? 0) + 1;
  }
  let mag = 0;
  for (const x of out) mag += x * x;
  const norm = Math.sqrt(mag) || 1;
  return out.map((x) => x / norm);
}

const mockEmbedFn: EmbedBatchFn = async (inputs) => ({
  vectors: inputs.map((s) => fakeEmbed(s)),
  model: 'mock-embed-v1',
  inputTokens: inputs.reduce((acc, s) => acc + s.length, 0),
});

describe('W5 demo-gate smoke — code search end-to-end', () => {
  it('deep-index → search "debounce hook" → top code hit maps to the debounce chunk', async () => {
    const db = await openStarKitDb(`w5-gate-${Date.now()}`);
    const starStore = new IndexedDBStarStore(db);
    const vectorStore = new IndexedDBVectorStore(db);
    const memVec = new MemoryVectorStore();

    // Seed a single starred repo that has the debounce code.
    const star = makeStar(1, { fullName: 'lodash/lodash' });
    await starStore.upsertMany([star]);

    // First, do the W3 D2 star-level embed so the vector store has BOTH
    // a `star:1` row AND `code:1:...` rows after deep-index. Tests the
    // mixed-namespace search behavior the popup runs at runtime.
    await embedStars({
      starStore,
      embed: mockEmbedFn,
      upsert: async (rows) => {
        const [idbRes] = await Promise.all([
          vectorStore.upsertMany(rows),
          memVec.upsertMany(rows),
        ]);
        return idbRes;
      },
    });

    // Now W5 D2: index the source for this repo. Mock the source fetcher
    // so we don't hit the network — return our hand-crafted file.
    const fakeFetchSource = async () => [
      {
        path: 'src/debounce.ts',
        content: DEBOUNCE_SRC,
        bytes: DEBOUNCE_SRC.length,
        language: 'typescript',
      },
    ];

    const t0 = performance.now();
    const indexResult = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource: fakeFetchSource,
      embed: mockEmbedFn,
      upsert: async (rows) => {
        const [idbRes] = await Promise.all([
          vectorStore.upsertMany(rows),
          memVec.upsertMany(rows),
        ]);
        return idbRes;
      },
      getExisting: (id) => vectorStore.get(id),
    });
    const indexMs = performance.now() - t0;

    expect(indexResult.failed).toBe(0);
    expect(indexResult.files).toBe(1);
    // chunkSource on the sample TS finds at least debounce + throttle
    expect(indexResult.chunks).toBeGreaterThanOrEqual(2);
    expect(indexResult.indexed).toBe(indexResult.chunks);

    // The vector store should now hold star:1 + N code:1 rows
    const totalRows = await vectorStore.count();
    expect(totalRows).toBeGreaterThanOrEqual(indexResult.chunks + 1);

    // Search hop — mimics App.tsx onSearch.
    const t1 = performance.now();
    const queryVec = fakeEmbed('debounce hook');
    const hits = await memVec.search(queryVec, { limit: 8 });
    const searchMs = performance.now() - t1;

    // At least one code hit (id starts with `code:`)
    const codeHits = hits.filter((h) => h.id.startsWith('code:'));
    expect(codeHits.length).toBeGreaterThan(0);

    // The TOP code hit's chunk should be the debounce function — its
    // headerLine starts with `export function debounce`.
    const topCodeHit = codeHits[0]!;
    const headerLine = topCodeHit.metadata?.['headerLine'];
    expect(typeof headerLine).toBe('string');
    expect((headerLine as string).toLowerCase()).toContain('debounce');

    // Metadata necessary for the popup CodeSnippet render must all be present
    expect(typeof topCodeHit.metadata?.['path']).toBe('string');
    expect(typeof topCodeHit.metadata?.['startLine']).toBe('number');
    expect(typeof topCodeHit.metadata?.['endLine']).toBe('number');
    expect(typeof topCodeHit.metadata?.['snippet']).toBe('string');
    expect(topCodeHit.metadata?.['starId']).toBe(1);

    // Local hop budget — generous because fake-indexeddb is slower than
    // real Chrome IDB, but still well under demo-gate budget for hops we
    // can control.
    expect(indexMs).toBeLessThan(500);
    expect(searchMs).toBeLessThan(100);

    db.close();
  });

  it('skip-cache: re-running indexRepoCode on the same source costs zero embed calls', async () => {
    const db = await openStarKitDb(`w5-skip-${Date.now()}`);
    const starStore = new IndexedDBStarStore(db);
    const vectorStore = new IndexedDBVectorStore(db);

    await starStore.upsertMany([makeStar(1)]);
    const fakeFetchSource = async () => [
      {
        path: 'src/debounce.ts',
        content: DEBOUNCE_SRC,
        bytes: DEBOUNCE_SRC.length,
        language: 'typescript',
      },
    ];

    // First pass: actually embeds
    await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource: fakeFetchSource,
      embed: mockEmbedFn,
      upsert: (rows) => vectorStore.upsertMany(rows),
      getExisting: (id) => vectorStore.get(id),
    });

    // Second pass: skip-cache should hit on every chunk
    let calls = 0;
    const trackingEmbed: EmbedBatchFn = async (inputs) => {
      calls += 1;
      return mockEmbedFn(inputs);
    };
    const second = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource: fakeFetchSource,
      embed: trackingEmbed,
      upsert: (rows) => vectorStore.upsertMany(rows),
      getExisting: (id) => vectorStore.get(id),
    });

    expect(second.skipped).toBe(second.chunks);
    expect(second.indexed).toBe(0);
    expect(calls).toBe(0);
    db.close();
  });
});
