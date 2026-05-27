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
      // R20 蓝军: new failure-surfacing fields default to empty/null on a
      // fully-empty run — there were no batches so nothing could fail.
      failedStarIds: [],
      lastErrorKind: null,
      lastErrorMessage: null,
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

  it('throws (does not swallow) when CALLER signal is aborted', async () => {
    // R20 蓝军 semantics: AbortError propagates only when the CALLER's signal
    // is aborted (user pressed cancel). A bare AbortError without signal.aborted
    // is treated by callWithRetry as a network-side timeout (provider's internal
    // withTimeout) and retried — see the next test.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();
    const controller = new AbortController();
    controller.abort();

    const abortingEmbed: EmbedBatchFn = async () => {
      throw new DOMException('Aborted by user', 'AbortError');
    };

    await expect(
      embedStars({
        starStore,
        embed: abortingEmbed,
        upsert,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats bare AbortError (no signal) as transient → retries then counts as failed', async () => {
    // R20 蓝军 fix: a DOMException AbortError from the provider's internal
    // timeout (NOT the caller's signal) used to kill the whole embedStars run.
    // Now callWithRetry retries up to 3x; after exhaustion the batch counts
    // as failed via failedStarIds rather than throwing.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    const { upsert, map } = makeFakeIndex();

    let calls = 0;
    const flakyEmbed: EmbedBatchFn = async () => {
      calls += 1;
      throw new DOMException('inner timeout', 'AbortError');
    };

    const result = await embedStars({
      starStore,
      embed: flakyEmbed,
      upsert,
    });
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failedStarIds).toEqual([1, 2]);
    expect(calls).toBeGreaterThan(1); // retried at least once
    expect(map.size).toBe(0);
  });
});

describe('embedStars — signal + progress', () => {
  it('throws AbortError immediately after the in-flight batch returns when signal aborts', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert, map } = makeFakeIndex();

    const controller = new AbortController();
    let call = 0;
    const embed: EmbedBatchFn = async (inputs) => {
      call += 1;
      if (call === 1) controller.abort(); // abort during the first batch
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

    // The in-flight batch's upsert MUST NOT have run (the post-embed
    // throwIfAborted catches it before reaching upsert). This is the
    // contract that protects the index from "abort lied and the partial
    // batch leaked through" — R5 蓝军 fix #4.
    expect(map.size).toBe(0);
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

describe('embedStars — R52 adaptive batch split on bad_request (413)', () => {
  /**
   * User-reported regression: SiliconFlow returned HTTP 413 (Payload Too
   * Large) for batches of 32 stars → orchestrator counted all 32 as
   * failed and surfaced 0 embedded. Fix: when a batch fails with
   * AIError.kind === 'bad_request', recursively halve and retry until
   * either each half succeeds or a single-input batch still fails (true
   * permanent error).
   */
  function makeAIError(kind: string, message: string) {
    const e: Error & { kind: string } = Object.assign(
      new Error(message),
      { kind }
    );
    return e;
  }

  it('splits a 4-batch that 413s into 2+2 then succeeds → all 4 embedded', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert, map } = makeFakeIndex();

    // Embed fn fails on size-4 calls, succeeds on size-2 (and smaller).
    let calls = 0;
    const embed = async (inputs: ReadonlyArray<string>) => {
      calls += 1;
      if (inputs.length > 2) {
        throw makeAIError('bad_request', '413 Payload Too Large');
      }
      return {
        vectors: inputs.map(() => [0.1, 0.2, 0.3]),
        model: 'test-embed',
        inputTokens: inputs.length * 10,
      };
    };

    const result = await embedStars({
      starStore,
      embed,
      upsert,
      batchSize: 4,
    });

    expect(result.embedded).toBe(4);
    expect(result.failed).toBe(0);
    expect(map.size).toBe(4);
    // 1 attempt at size 4 (fails) + 2 attempts at size 2 (succeed) = 3 total
    expect(calls).toBe(3);
  });

  it('splits all the way to size 1 if needed, only fails the truly impossible', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    const { upsert, map } = makeFakeIndex();

    // Fails for size > 1, succeeds for size 1. Both stars should embed
    // individually.
    const embed = async (inputs: ReadonlyArray<string>) => {
      if (inputs.length > 1) {
        throw makeAIError('bad_request', '413');
      }
      return {
        vectors: inputs.map(() => [0.5]),
        model: 'test',
        inputTokens: 1,
      };
    };

    const result = await embedStars({
      starStore,
      embed,
      upsert,
      batchSize: 2,
    });
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(map.size).toBe(2);
  });

  it('permanent bad_request at size 1 → counts as failed (no infinite split)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();

    const embed = async () => {
      throw makeAIError('bad_request', 'input too long even at size 1');
    };

    const result = await embedStars({
      starStore,
      embed,
      upsert,
      batchSize: 1,
    });
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedStarIds).toEqual([1]);
    expect(result.lastErrorMessage).toContain('input too long');
  });

  it('non-bad_request errors do NOT trigger split (would compound retry waste)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
      makeStar({ id: 4 }),
    ]);
    const { upsert } = makeFakeIndex();

    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw makeAIError('auth', '401 Unauthorized');
    };

    const result = await embedStars({
      starStore,
      embed,
      upsert,
      batchSize: 4,
    });
    expect(result.failed).toBe(4);
    // Auth error should fail once per batch (1 call here, since all 4 in one
    // batch). NOT 7 (1 + 2 + 4 from splits) — split is bad_request-only.
    // callWithRetry may add its own retries but only for transient kinds;
    // auth is permanent so it fires exactly once per attempt.
    expect(calls).toBe(1);
  });
});

/**
 * Integration-shape regression — locks down the VectorLookupFn / VectorUpsertFn
 * type contract against the actual @starkit/vector `VectorRow` shape.
 *
 * R5 蓝军 finding: an earlier version typed VectorLookupFn's return as
 * `{ metadata?: { contentHash?: string } } | null` — this is too narrow for
 * `VectorStore.get` which returns `metadata?: Record<string, unknown>`. The
 * popup wiring `getExisting: (id) => vec.get(id)` would type-error. Loosening
 * to `Record<string, unknown>` + a `typeof === 'string'` narrowing in the
 * orchestrator is what made the wiring work. This block guards against a
 * future tightening that would silently re-introduce the bug.
 */
describe('embedStars — VectorRow shape compatibility (R5 regression)', () => {
  // Structurally mirrors @starkit/vector's VectorRow without importing it
  // (core can't depend on vector — would create a workspace cycle).
  interface VectorRowLike {
    readonly id: string;
    readonly vector: ReadonlyArray<number>;
    readonly metadata?: Record<string, unknown>;
  }

  it('accepts a getExisting that returns the full VectorRow shape', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();

    // Seed a "vector store" with the SAME hash the orchestrator will compute.
    // metadata is the wide Record<string, unknown> — not the narrow shape.
    const indexedRows = new Map<string, VectorRowLike>();
    // First run to discover the hash that contentHash() produces:
    let observedHash = '';
    await embedStars({
      starStore,
      embed: async (inputs) => ({
        vectors: inputs.map(() => [0]),
        model: 'probe',
        inputTokens: 0,
      }),
      upsert: async (rows) => {
        observedHash = rows[0]!.metadata.contentHash;
        return { inserted: rows.length, updated: 0 };
      },
    });
    indexedRows.set('star:1', {
      id: 'star:1',
      vector: [0],
      metadata: { contentHash: observedHash, model: 'probe' },
    });

    // Now run again, passing a getExisting whose return shape is VectorRow-like
    // (metadata is Record<string, unknown>) — the orchestrator must accept it
    // and skip the row because the hash matches.
    const embed = vi.fn(makeFakeEmbed());
    const result = await embedStars({
      starStore,
      embed,
      upsert,
      getExisting: async (id) => indexedRows.get(id) ?? null,
    });
    expect(result.skipped).toBe(1);
    expect(result.embedded).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('treats non-string contentHash as "no hash, re-embed" (safe runtime narrow)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();

    // Index has a row with contentHash that is NOT a string (e.g. older format
    // accidentally stored as a number). The runtime typeof check should treat
    // this as a miss and re-embed rather than throw or skip on a coerced compare.
    const indexedRows = new Map<string, { metadata?: Record<string, unknown> }>();
    indexedRows.set('star:1', {
      metadata: { contentHash: 12345 as unknown as string },
    });

    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      getExisting: async (id) => indexedRows.get(id) ?? null,
    });
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('treats missing metadata as "no hash, re-embed"', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { upsert } = makeFakeIndex();

    // Row exists but has no metadata field at all
    const indexedRows = new Map<string, { metadata?: Record<string, unknown> }>();
    indexedRows.set('star:1', {});

    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert,
      getExisting: async (id) => indexedRows.get(id) ?? null,
    });
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('accepts an upsert function shaped like VectorStore.upsertMany (wider input)', async () => {
    // Structurally mirrors `VectorStore.upsertMany(rows: ReadonlyArray<VectorRow>)`
    // — the parameter is the wider `VectorRow` type (metadata as
    // Record<string, unknown>), and we're passing EmbeddingRows in.
    // Contravariance: a function accepting wider input IS assignable to
    // a slot demanding narrower input. R5 蓝军 fix #2.
    interface VectorRowLike {
      readonly id: string;
      readonly vector: ReadonlyArray<number>;
      readonly metadata?: Record<string, unknown>;
    }
    const storeMap = new Map<string, VectorRowLike>();
    const upsertWide = async (
      rows: ReadonlyArray<VectorRowLike>
    ): Promise<{ inserted: number; updated: number }> => {
      let inserted = 0;
      let updated = 0;
      for (const r of rows) {
        if (storeMap.has(r.id)) updated += 1;
        else inserted += 1;
        storeMap.set(r.id, r);
      }
      return { inserted, updated };
    };

    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);

    // The key compile-time check: passing the wider-typed upsertWide directly
    // into embedStars must typecheck.
    const result = await embedStars({
      starStore,
      embed: makeFakeEmbed(),
      upsert: upsertWide,
    });
    expect(result.embedded).toBe(2);
    expect(storeMap.size).toBe(2);
  });
});

describe('embedStars — pathological provider', () => {
  it('returns model=null when every batch fails', async () => {
    // Locks down the "embedded=0, failed=N, model=null" signal the popup
    // uses to render an "everything failed, retry?" UX. Previously the
    // empty-starStore case was the only test that asserted model=null;
    // this exercises the "non-empty + total failure" path. R5 蓝军 fix #6.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    const { upsert, map } = makeFakeIndex();

    const alwaysFail: EmbedBatchFn = async () => {
      throw new Error('persistent provider 500');
    };

    const result = await embedStars({
      starStore,
      embed: alwaysFail,
      upsert,
      batchSize: 2,
    });
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.model).toBeNull();
    expect(result.batches).toBe(0);
    expect(result.totalInputTokens).toBe(0);
    expect(map.size).toBe(0); // No partial pollution
  });
});
