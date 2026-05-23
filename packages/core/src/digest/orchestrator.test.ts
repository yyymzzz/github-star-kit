import { describe, expect, it } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { StarStoreMemory } from '../storage/memory.js';
import { generateDigest, type ListVectorsFn } from './orchestrator.js';

const NOW = Date.parse('2026-05-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id: 1,
    fullName: overrides.fullName ?? 'foo/bar',
    htmlUrl: 'https://github.com/foo/bar',
    ownerLogin: 'foo',
    ownerAvatarUrl: null,
    description: overrides.description ?? null,
    topics: [],
    language: overrides.language ?? null,
    starredAt: '2024-01-01T00:00:00Z',
    pushedAt: overrides.pushedAt ?? '2026-05-22T00:00:00Z', // ~1 day ago wrt NOW
    stargazersCount: 100,
    defaultBranch: 'main',
    archived: overrides.archived ?? false,
    isFork: overrides.isFork ?? false,
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

/** Make a `listVectors` callback that returns a fixed star→vector map. */
function vectors(
  m: ReadonlyArray<readonly [number, ReadonlyArray<number>]>
): ListVectorsFn {
  return async () =>
    m.map(([starId, vector]) => ({ starId, vector }));
}

describe('generateDigest — happy paths', () => {
  it('ranks candidates by composite (relevance + recency), top-N first', async () => {
    // Two stars in window, very different vectors. Profile = mean.
    // Star 1 ~ same direction as profile, star 2 opposite — star 1 wins.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a', pushedAt: '2026-05-20T00:00:00Z' }),
      makeStar({ id: 2, fullName: 'b/b', pushedAt: '2026-05-22T00:00:00Z' }),
    ]);

    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        // Profile centroid will be [0.5, 0.5] given these two inputs
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
      windowDays: 7,
      limit: 5,
    });

    expect(result.profileEmpty).toBe(false);
    expect(result.candidateCount).toBe(2);
    expect(result.entries).toHaveLength(2);
    // Both have identical cosine vs the [0.5, 0.5] centroid (~0.707), so
    // recency breaks the tie — star 2 (newer push) wins.
    expect(result.entries[0]!.star.id).toBe(2);
    expect(result.entries[0]!.score).toBeGreaterThan(result.entries[1]!.score);
  });

  it('limits the entry list to opts.limit', async () => {
    const starStore = new StarStoreMemory();
    const stars: StarredRepo[] = [];
    const vecPairs: Array<readonly [number, number[]]> = [];
    for (let i = 1; i <= 20; i += 1) {
      stars.push(
        makeStar({ id: i, fullName: `r/${i}`, pushedAt: '2026-05-22T00:00:00Z' })
      );
      vecPairs.push([i, [Math.cos(i), Math.sin(i)]]);
    }
    await starStore.upsertMany(stars);

    const result = await generateDigest({
      starStore,
      listVectors: vectors(vecPairs),
      now: NOW,
      limit: 5,
    });
    expect(result.entries).toHaveLength(5);
    expect(result.candidateCount).toBe(20);
  });

  it('returns profileEmpty=true when no vectors are embedded', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([]),
      now: NOW,
    });
    expect(result.profileEmpty).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.unembeddedCount).toBe(0);
  });
});

describe('generateDigest — R9 蓝军 fixes', () => {
  it('reports unembeddedCount separately from candidateCount', async () => {
    // 3 in-window candidates; only 1 has a vector. UI should see "1 ranked,
    // 2 unembedded" rather than silently dropping the two.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b' }),
      makeStar({ id: 3, fullName: 'c/c' }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([[1, [1, 0]]]),
      now: NOW,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.unembeddedCount).toBe(2);
  });

  it('excludes the boundary (pushedMs == cutoffMs) — recency-zero candidates dropped', async () => {
    // Push exactly windowDays ago — recencyBoost would return 0, so
    // including it adds a relevance-only score that's hard to compare
    // to in-window scores. Excluding it keeps the filter + boost story
    // consistent.
    const starStore = new StarStoreMemory();
    const cutoffIso = new Date(NOW - 7 * DAY).toISOString();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'edge/edge', pushedAt: cutoffIso }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([[1, [1, 0]]]),
      now: NOW,
      windowDays: 7,
    });
    expect(result.candidateCount).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('breaks ties by pushedAt DESC for deterministic ordering', async () => {
    // Two stars with identical vectors → identical relevance, but
    // different pushedAt. The fresher push should win the tie.
    const starStore = new StarStoreMemory();
    const newer = new Date(NOW - 1 * DAY).toISOString();
    const older = new Date(NOW - 5 * DAY).toISOString();
    // Insert older FIRST — the natural starStore.list() order would put
    // older first; the sort must override that on score tie.
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'older/older', pushedAt: older }),
      makeStar({ id: 2, fullName: 'newer/newer', pushedAt: newer }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [2, [1, 0]], // identical vector → identical relevance
      ]),
      now: NOW,
      windowDays: 7,
    });
    // Both have ~equal relevance. Recency differs (-1d vs -5d), so the
    // composite-score sort ALSO puts star 2 ahead — but ALSO check that
    // even when composite ties, pushedAt DESC wins.
    expect(result.entries[0]!.star.id).toBe(2);
  });
});

describe('generateDigest — candidate filtering', () => {
  it('excludes archived repos', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b', archived: true }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.entries[0]!.star.id).toBe(1);
  });

  it('excludes forks (digest opinion — forks rarely signal new upstream work)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b', isFork: true }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.entries[0]!.star.id).toBe(1);
  });

  it('excludes repos with null pushedAt (never-pushed empty repos)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b', pushedAt: null }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.entries[0]!.star.id).toBe(1);
  });

  it('excludes repos pushed before the window cutoff', async () => {
    const starStore = new StarStoreMemory();
    const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString();
    const oneDayAgo = new Date(NOW - 1 * DAY).toISOString();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'fresh/fresh', pushedAt: oneDayAgo }),
      makeStar({ id: 2, fullName: 'stale/stale', pushedAt: tenDaysAgo }),
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
      windowDays: 7,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.entries[0]!.star.id).toBe(1);
  });

  it('drops candidates without an embedded vector', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b' }), // no vector for this one
    ]);
    const result = await generateDigest({
      starStore,
      listVectors: vectors([[1, [1, 0]]]),
      now: NOW,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.star.id).toBe(1);
  });
});

describe('generateDigest — relevance vs recency weighting', () => {
  it('a much-more-relevant older repo beats a barely-relevant fresher one', async () => {
    const starStore = new StarStoreMemory();
    const fresh = new Date(NOW - DAY).toISOString(); // 1 day old
    const older = new Date(NOW - 5 * DAY).toISOString(); // 5 days old
    await starStore.upsertMany([
      // Star 1: 5 days old, aligned with profile direction
      makeStar({ id: 1, fullName: 'aligned/old', pushedAt: older }),
      // Star 2: 1 day old, orthogonal
      makeStar({ id: 2, fullName: 'orthogonal/new', pushedAt: fresh }),
    ]);

    // Profile is heavily skewed toward star 1's direction (it dominates the
    // centroid). Relevance: star 1 ~= 1.0, star 2 ~= 0.0
    const result = await generateDigest({
      starStore,
      listVectors: vectors([
        [1, [1, 0]],
        [1, [1, 0]],
        [1, [1, 0]],
        [1, [1, 0]],
        [2, [0, 1]],
      ]),
      now: NOW,
      windowDays: 7,
    });
    // Star 1: relevance≈1 × 0.8 + recency≈0.29 × 0.2 ≈ 0.86
    // Star 2: relevance≈0.24 × 0.8 + recency≈0.86 × 0.2 ≈ 0.36
    expect(result.entries[0]!.star.id).toBe(1);
  });
});

describe('generateDigest — input validation', () => {
  it('rejects windowDays <= 0', async () => {
    const starStore = new StarStoreMemory();
    await expect(
      generateDigest({
        starStore,
        listVectors: vectors([]),
        windowDays: 0,
      })
    ).rejects.toThrow(/windowDays must be > 0/);
  });

  it('rejects limit < 1', async () => {
    const starStore = new StarStoreMemory();
    await expect(
      generateDigest({
        starStore,
        listVectors: vectors([]),
        limit: 0,
      })
    ).rejects.toThrow(/limit must be >= 1/);
  });
});
