import { describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { StarStoreMemory } from '../storage/memory.js';
import type {
  EmbedBatchFn,
  EmbeddingRow,
  VectorLookupFn,
  VectorUpsertFn,
} from '../embedding/orchestrator.js';
import { indexRepoCode } from './orchestrator.js';
import type { SourceFile } from './fetch.js';

function makeStar(id: number, overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id,
    fullName: `owner/repo-${id}`,
    htmlUrl: `https://github.com/owner/repo-${id}`,
    ownerLogin: 'owner',
    ownerAvatarUrl: null,
    description: null,
    topics: [],
    language: 'TypeScript',
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

function makeFakeEmbed(opts: { model?: string } = {}): EmbedBatchFn {
  const model = opts.model ?? 'fake-embed-v1';
  return async (inputs) => ({
    vectors: inputs.map((s) =>
      Array.from(s).slice(0, 4).map((c) => c.charCodeAt(0) / 128)
    ),
    model,
    inputTokens: inputs.reduce((a, s) => a + s.length, 0),
  });
}

function makeFakeIndex() {
  const map = new Map<string, EmbeddingRow>();
  const upsert: VectorUpsertFn = async (rows) => {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      if (map.has(r.id)) updated += 1;
      else inserted += 1;
      map.set(r.id, r);
    }
    return { inserted, updated };
  };
  const get: VectorLookupFn = async (id) => map.get(id) ?? null;
  return { map, upsert, get };
}

const SAMPLE_TS = [
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

describe('indexRepoCode — happy path', () => {
  it('chunks every fetched file, embeds each chunk, upserts with code: namespace', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(42, { fullName: 'tokio-rs/tokio' })]);
    const { upsert, map } = makeFakeIndex();

    const fetchSource = async () =>
      [
        { path: 'src/hooks.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
      ] as ReadonlyArray<SourceFile>;

    const result = await indexRepoCode({
      starStore,
      repoId: 42,
      fetchSource,
      embed: makeFakeEmbed(),
      upsert,
    });

    expect(result.failed).toBe(0);
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThanOrEqual(2); // debounce + throttle
    expect(result.indexed).toBe(result.chunks);
    expect(map.size).toBe(result.chunks);

    // Every key must follow the code:{repoId}:{path}:{chunkIndex} format
    for (const id of map.keys()) {
      expect(id).toMatch(/^code:42:src\/hooks\.ts:\d+$/);
    }
    // metadata.starId echoes the repo id; metadata.path + lines populated
    for (const row of map.values()) {
      expect(row.metadata.starId).toBe(42);
      expect(row.metadata['path']).toBe('src/hooks.ts');
      expect(typeof row.metadata['startLine']).toBe('number');
      expect(typeof row.metadata['endLine']).toBe('number');
    }
  });

  it('runs across multiple files, accumulating counts', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert, map } = makeFakeIndex();

    const fetchSource = async () =>
      [
        { path: 'a.ts', content: 'export function a() {}', bytes: 22, language: 'typescript' },
        { path: 'b.ts', content: 'export function b() {}', bytes: 22, language: 'typescript' },
        { path: 'c.js', content: 'export function c() {}', bytes: 22, language: 'javascript' },
      ] as ReadonlyArray<SourceFile>;

    const result = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed: makeFakeEmbed(),
      upsert,
    });

    expect(result.files).toBe(3);
    expect(result.chunks).toBe(3);
    expect(result.indexed).toBe(3);
    expect(map.size).toBe(3);
  });
});

describe('indexRepoCode — skip-cache', () => {
  it('skips chunks whose contentHash matches the existing index', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert, get } = makeFakeIndex();
    const fetchSource = async () =>
      [
        { path: 'a.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
      ] as ReadonlyArray<SourceFile>;

    // First pass populates the index
    await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed: makeFakeEmbed(),
      upsert,
      getExisting: get,
    });

    // Second pass on identical input — every chunk should skip via hash
    const embed = vi.fn(makeFakeEmbed());
    const second = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed,
      upsert,
      getExisting: get,
    });
    expect(second.skipped).toBe(second.chunks);
    expect(second.indexed).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('indexRepoCode — failure handling', () => {
  it('counts a batch embed error as failed and continues', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert } = makeFakeIndex();

    let call = 0;
    const flakyEmbed: EmbedBatchFn = async (inputs) => {
      call += 1;
      if (call === 1) throw new Error('boom — 503');
      return {
        vectors: inputs.map(() => [0.1, 0.2]),
        model: 'fake',
        inputTokens: inputs.length,
      };
    };

    const fetchSource = async () =>
      [
        { path: 'a.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
        { path: 'b.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
      ] as ReadonlyArray<SourceFile>;

    const result = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed: flakyEmbed,
      upsert,
      batchSize: 2, // force 2 batches across the chunks
    });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.indexed + result.failed).toBe(result.chunks);
  });

  it('propagates AbortError when caller signal is aborted', async () => {
    // R20 蓝军 semantics: AbortError WITH signal.aborted = user cancel
    // → propagate. AbortError WITHOUT signal.aborted = network-side
    // timeout → callWithRetry treats as transient and retries. The
    // test now reflects this contract: cancellation only propagates
    // when the CALLER initiated it.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert } = makeFakeIndex();
    const fetchSource = async () =>
      [{ path: 'a.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' }] as ReadonlyArray<SourceFile>;
    const controller = new AbortController();
    controller.abort();
    const abortingEmbed: EmbedBatchFn = async () => {
      throw new DOMException('Aborted', 'AbortError');
    };
    await expect(
      indexRepoCode({
        starStore,
        repoId: 1,
        fetchSource,
        embed: abortingEmbed,
        upsert,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats bare AbortError (no signal) as transient → retries then counts as failed', async () => {
    // R20 蓝军 fix: a DOMException AbortError thrown by the provider's
    // internal timeout (NOT the caller's signal) used to silently kill
    // the whole batch in v1. Now callWithRetry retries up to 3x, then
    // the orchestrator counts the chunks as failed via failedChunkIds.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert } = makeFakeIndex();
    const fetchSource = async () =>
      [{ path: 'a.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' }] as ReadonlyArray<SourceFile>;
    let calls = 0;
    const flakyEmbed: EmbedBatchFn = async () => {
      calls += 1;
      throw new DOMException('inner timeout', 'AbortError');
    };
    const result = await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed: flakyEmbed,
      upsert,
    });
    expect(result.indexed).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failedChunkIds.length).toBe(result.failed);
    expect(calls).toBeGreaterThan(1); // retried at least once
  });
});

describe('indexRepoCode — input validation', () => {
  it('rejects unknown repoId (no star in store)', async () => {
    const starStore = new StarStoreMemory();
    const { upsert } = makeFakeIndex();
    await expect(
      indexRepoCode({
        starStore,
        repoId: 999,
        fetchSource: async () => [],
        embed: makeFakeEmbed(),
        upsert,
      })
    ).rejects.toThrow(/no row for id=999/);
  });

  it('rejects malformed fullName', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1, { fullName: 'no-slash' })]);
    const { upsert } = makeFakeIndex();
    await expect(
      indexRepoCode({
        starStore,
        repoId: 1,
        fetchSource: async () => [],
        embed: makeFakeEmbed(),
        upsert,
      })
    ).rejects.toThrow(/malformed fullName/);
  });

  it('rejects batchSize < 1', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert } = makeFakeIndex();
    await expect(
      indexRepoCode({
        starStore,
        repoId: 1,
        fetchSource: async () => [],
        embed: makeFakeEmbed(),
        upsert,
        batchSize: 0,
      })
    ).rejects.toThrow(/batchSize must be >= 1/);
  });
});

describe('indexRepoCode — progress reporting', () => {
  it('fires onProgress with chunk-grain accumulation', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar(1)]);
    const { upsert } = makeFakeIndex();
    const progress: Array<[number, number]> = [];
    const fetchSource = async () =>
      [
        { path: 'a.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
        { path: 'b.ts', content: SAMPLE_TS, bytes: SAMPLE_TS.length, language: 'typescript' },
      ] as ReadonlyArray<SourceFile>;

    await indexRepoCode({
      starStore,
      repoId: 1,
      fetchSource,
      embed: makeFakeEmbed(),
      upsert,
      batchSize: 2,
      onProgress: (done, total) => progress.push([done, total]),
    });
    // First fire = 0/N baseline; last = N/N completion
    expect(progress[0]?.[0]).toBe(0);
    const last = progress[progress.length - 1]!;
    expect(last[0]).toBe(last[1]);
  });
});
