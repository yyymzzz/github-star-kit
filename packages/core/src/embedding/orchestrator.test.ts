import { describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { StarStoreMemory } from '../storage/memory.js';
import {
  embedStars,
  type EmbedBatchFn,
  type EmbeddingRow,
  type VectorLookupFn,
  type VectorUpsertFn,
} from './orchestrator.js';

/** Build a StarredRepo with sensible defaults. */
function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    id: 1,
    fullName: 'tokio-rs/tokio',
    htmlUrl: 'https://github.com/tokio-rs/tokio',
    ownerLogin: 'tokio-rs',
    ownerAvatarUrl: null,
    description: 'Async runtime for Rust.',
    topics: ['async', 'rust'],
    language: 'Rust',
    starredAt: '2024-01-01T00:00:00Z',
    pushedAt: '2024-06-01T00:00:00Z',
    stargazersCount: 26000,
    defaultBranch: 'master',
    archived: false,
    isFork: false,
    lastSyncedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

/**
 * Helper: build an in-memory "vector store" using a Map + the upsert/get
 * shapes the orchestrator needs. Used to mock the side of the world that
 * lives in @starkit/vector without dragging that package in.
 */
function makeFakeIndex() {
  const map = new Map<string, EmbeddingRow>();
  const upsert: VectorUpsertFn = async (rows) => {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      if (map.has(row.id)) updated += 1;
      else inserted += 1;
      map.set(row.id, row);
    }
    return { inserted, updated };
  };
  const get: VectorLookupFn = async (id) => map.get(id) ?? null;
  return { map, upsert, get };
}

/** Returns a fixed-dim deterministic vector for a string (good enough for tests). */
function fakeVectorFor(input: string, dim = 4): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < input.length; i += 1) {
    out[i % dim] = (out[i % dim] ?? 0) + input.charCodeAt(i);
  }
  return out;
}

const makeFakeEmbed = (
  opts: { model?: string; tokensPerInput?: number } = {}
): EmbedBatchFn => {
  const model = opts.model ?? 'fake-embed-v1';
  const tpi = opts.tokensPerInput ?? 5;
  return async (inputs) => ({
    vectors: inputs.map((s) => fakeVectorFor(s)),
    model,
    inputTokens: inputs.length * tpi,
  });
};

describe('embedStars — happy paths', () => {
  it('embeds every star when the index is empty', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b' }),
      makeStar({ id: 3, fullName: 'c/c' }),
    ]);
    const { upsert, get, map } = makeFakeIndex();

    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      getExisting: get,
      batchSize: 2,
    });

    expect(result.embedded).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.batches).toBe(2); // 3 stars / batch 2 = ceil(3/2) = 2
    expect(map.size).toBe(3);
    expect(map.has('star:1')).toBe(true);
    expect(map.has('star:2')).toBe(true);
    expect(map.has('star:3')).toBe(true);
  });

  it('reports total inputTokens summed across batches', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert } = makeFakeIndex();
    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed({ tokensPerInput: 10 }),
      upsert,
      batchSize: 2,
    });
    expect(result.totalInputTokens).toBe(40); // 4 stars × 10 tokens
    expect(result.model).toBe('fake-embed-v1');
  });

  it('handles an empty starStore as a no-op', async () => {
    const starStore = new StarStoreMemory();
    const { upsert } = makeFakeIndex();
    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
    });
    expect(result).toEqual({
      embedded: 0,
      skipped: 0,
      failed: 0,
      totalInputTokens: 0,
      model: null,
      batches: 0,
    });
  });

  it('handles batch size larger than star count (one batch, all in it)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    const { upsert } = makeFakeIndex();
    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      batchSize: 1000,
    });
    expect(result.embedded).toBe(2);
    expect(result.batches).toBe(1);
  });

  it('handles batch size of 1 (one batch per star)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    const { upsert } = makeFakeIndex();
    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      batchSize: 1,
    });
    expect(result.embedded).toBe(3);
    expect(result.batches).toBe(3);
  });

  it('stamps each row with the namespaced id "star:{id}"', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 42 })]);
    const { upsert, map } = makeFakeIndex();
    await embedStars({ starStore, embed: makeFakeEmbed(), upsert });
    expect([...map.keys()]).toEqual(['star:42']);
    const row = map.get('star:42')!;
    expect(row.metadata.starId).toBe(42);
    expect(row.metadata.model).toBe('fake-embed-v1');
    expect(row.metadata.embeddedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.metadata.contentHash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('embedStars — contentHash short-circuit', () => {
  it('skips rows whose contentHash matches the indexed row', async () => {
    const starStore = new StarStoreMemory();
    const stars = [
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b' }),
    ];
    await starStore.upsertMany(stars);
    const { upsert, get } = makeFakeIndex();

    // First pass: everything goes through.
    await embedStars({ starStore, embed: makeFakeEmbed(), upsert, getExisting: get });

    // Second pass with the SAME getExisting hooked up — every row should
    // short-circuit on contentHash.
    const embed = vi.fn(makeFakeEmbed());
    const result = await embedStars({
      starStore,
      embed,
      upsert,
      getExisting: get,
    });
    expect(result.skipped).toBe(2);
    expect(result.embedded).toBe(0);
    expect(result.batches).toBe(0); // No provider calls at all on the warm path
    expect(embed).not.toHaveBeenCalled();
  });

  it('re-embeds when description (a hash-relevant field) changed since last run', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'Original.' })]);
    const { upsert, get } = makeFakeIndex();

    await embedStars({ starStore, embed: makeFakeEmbed(), upsert, getExisting: get });

    // Mutate the star — same id, different description → hash changes.
    await starStore.upsertMany([makeStar({ id: 1, description: 'Rewritten.' })]);

    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      getExisting: get,
    });
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('does NOT short-circuit when getExisting is omitted (force re-embed semantics)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    const { upsert } = makeFakeIndex();

    // Two consecutive runs without getExisting → both pass through fully
    await embedStars({ starStore, embed: makeFakeEmbed(), upsert });
    const result = await embedStars({ starStore, embed: makeFakeEmbed(), upsert });
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);
  });
});

describe('embedStars — failure handling', () => {
  it('counts a batch-level provider error as `failed` and continues with later batches', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert } = makeFakeIndex();

    let call = 0;
    const flakyEmbed: EmbedBatchFn = async (inputs) => {
      call += 1;
      if (call === 2) throw new Error('boom (provider 503)');
      return {
        vectors: inputs.map((s) => fakeVectorFor(s)),
        model: 'fake',
        inputTokens: inputs.length * 5,
      };
    };

    const result = await embedStars({
      starStore,
      embed: flakyEmbed,
      upsert,
      batchSize: 2,
    });
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.batches).toBe(1); // Only the first (successful) batch counts
  });

  it('fails the batch (does NOT upsert) when provider returns wrong number of vectors', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    const { upsert, map } = makeFakeIndex();

    const misalignedEmbed: EmbedBatchFn = async () => ({
      vectors: [[1, 2, 3]], // Only 1 vector for 2 inputs — misalignment
      model: 'broken',
      inputTokens: 10,
    });

    const result = await embedStars({
      starStore,
      embed: misalignedEmbed,
      upsert,
    });
    expect(result.failed).toBe(2);
    expect(result.embedded).toBe(0);
    expect(map.size).toBe(0); // No rows leaked into the index
  });

  it('throws (does not swallow) when the provider raises AbortError', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();

    const abortingEmbed: EmbedBatchFn = async () => {
      throw new DOMException('Aborted by user', 'AbortError');
    };

    await expect(
      embedStars({ starStore, embed: abortingEmbed, upsert })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('embedStars — signal + progress', () => {
  it('throws AbortError before the next batch when the signal aborts mid-run', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert } = makeFakeIndex();

    const controller = new AbortController();
    let call = 0;
    const embed: EmbedBatchFn = async (inputs) => {
      call += 1;
      if (call === 1) controller.abort(); // abort right after first batch starts
      return {
        vectors: inputs.map((s) => fakeVectorFor(s)),
        model: 'fake',
        inputTokens: inputs.length,
      };
    };

    await expect(
      embedStars({
        starStore,
        embed,
        upsert,
        batchSize: 2,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fires onProgress with (done, total) after each batch', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    const { upsert } = makeFakeIndex();
    const progress: Array<[number, number]> = [];

    await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      batchSize: 2,
      onProgress: (done, total) => progress.push([done, total]),
    });

    // Two batches of size 2 (effective: 2 + 1) → progress fires twice
    // with cumulative `done`.
    expect(progress).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('embedStars — input validation', () => {
  it('rejects batchSize < 1', async () => {
    const starStore = new StarStoreMemory();
    const { upsert } = makeFakeIndex();
    await expect(
      embedStars({ starStore, embed: makeFakeEmbed(), upsert, batchSize: 0 })
    ).rejects.toThrow(/batchSize must be >= 1/);
  });
});
