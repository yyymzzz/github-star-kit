import { describe, expect, it } from 'vitest';
import { MemoryVectorStore, cosineSimilarity } from './memory.js';
import type { VectorRow } from './types.js';

// Helpers ----------------------------------------------------------------

function v(...values: number[]): ReadonlyArray<number> {
  return values;
}

function row(
  id: string,
  vec: ReadonlyArray<number>,
  metadata?: Record<string, unknown>
): VectorRow {
  return metadata !== undefined
    ? { id, vector: vec, metadata }
    : { id, vector: vec };
}

// ─── cosineSimilarity ────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    expect(cosineSimilarity(v(1, 0), v(1, 0))).toBeCloseTo(1);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBeCloseTo(0);
  });

  it('returns -1.0 for opposite-direction vectors', () => {
    expect(cosineSimilarity(v(1, 0), v(-1, 0))).toBeCloseTo(-1);
  });

  it('is scale invariant', () => {
    expect(cosineSimilarity(v(2, 0), v(7, 0))).toBeCloseTo(1);
  });

  it('returns 0 when one operand is the zero vector', () => {
    expect(cosineSimilarity(v(0, 0), v(1, 1))).toBe(0);
  });

  it('throws on dim mismatch (no silent truncation)', () => {
    expect(() => cosineSimilarity(v(1, 0), v(1, 0, 0))).toThrow(/dim mismatch/i);
  });
});

// ─── MemoryVectorStore.upsertMany ────────────────────────────────────

describe('MemoryVectorStore.upsertMany', () => {
  it('counts cold rows as inserted', async () => {
    const store = new MemoryVectorStore();
    const r = await store.upsertMany([row('a', v(1, 0)), row('b', v(0, 1))]);
    expect(r).toEqual({ inserted: 2, updated: 0 });
    expect(await store.count()).toBe(2);
  });

  it('counts existing ids as updated; replaces vector + metadata', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0), { tag: 'old' })]);
    const r = await store.upsertMany([row('a', v(0, 1), { tag: 'new' })]);
    expect(r).toEqual({ inserted: 0, updated: 1 });
    const got = await store.get('a');
    expect(got?.vector).toEqual([0, 1]);
    expect(got?.metadata).toEqual({ tag: 'new' });
  });
});

// ─── MemoryVectorStore.search ────────────────────────────────────────

describe('MemoryVectorStore.search', () => {
  it('ranks rows by descending cosine similarity', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([
      row('north', v(1, 0)),
      row('east', v(0, 1)),
      row('northeast', v(1, 1)),
    ]);
    // query points strictly north → north > northeast > east
    const results = await store.search(v(1, 0));
    expect(results.map((r) => r.id)).toEqual(['north', 'northeast', 'east']);
    expect(results[0]!.score).toBeCloseTo(1);
    expect(results[1]!.score).toBeCloseTo(Math.SQRT1_2); // 1/sqrt(2)
    expect(results[2]!.score).toBeCloseTo(0);
  });

  it('honors limit (top-K)', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([
      row('a', v(1, 0)),
      row('b', v(1, 0.1)),
      row('c', v(1, 0.2)),
      row('d', v(0, 1)),
    ]);
    const results = await store.search(v(1, 0), { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('a');
  });

  it('honors minScore floor', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([
      row('north', v(1, 0)),
      row('east', v(0, 1)),
    ]);
    // query points north → north scores 1, east scores 0 → minScore 0.5
    // drops east.
    const results = await store.search(v(1, 0), { minScore: 0.5 });
    expect(results.map((r) => r.id)).toEqual(['north']);
  });

  it('runs the filter predicate before scoring', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([
      row('rust-1', v(1, 0), { language: 'Rust' }),
      row('go-1', v(1, 0), { language: 'Go' }),
      row('rust-2', v(0.9, 0.1), { language: 'Rust' }),
    ]);
    const results = await store.search(v(1, 0), {
      filter: (r) => r.metadata?.['language'] === 'Rust',
    });
    expect(results.every((r) => r.id.startsWith('rust-'))).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('returns metadata when the row carried any', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0), { url: 'https://x' })]);
    const [hit] = await store.search(v(1, 0));
    expect(hit?.metadata).toEqual({ url: 'https://x' });
  });

  it('returns empty array when query is the zero vector (no meaningful direction)', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0)), row('b', v(0, 1))]);
    expect(await store.search(v(0, 0))).toEqual([]);
  });

  it('throws on dim mismatch during search', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0, 0))]);
    await expect(store.search(v(1, 0))).rejects.toThrow(/dim mismatch/i);
  });
});

// ─── MemoryVectorStore.get / delete / clear ──────────────────────────

describe('MemoryVectorStore.get / delete / clear', () => {
  it('get returns null for missing id', async () => {
    expect(await new MemoryVectorStore().get('missing')).toBeNull();
  });

  it('delete removes single row; subsequent get returns null', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0))]);
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it('clear empties the store', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0)), row('b', v(0, 1))]);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});

describe('MemoryVectorStore.list', () => {
  it('returns empty array for empty store', async () => {
    const store = new MemoryVectorStore();
    expect(await store.list()).toEqual([]);
  });

  it('returns every row written, preserving metadata', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([
      row('a', v(1, 0), { tag: 'first' }),
      row('b', v(0, 1)),
      row('c', v(1, 1), { tag: 'third' }),
    ]);
    const listed = await store.list();
    expect(listed).toHaveLength(3);
    const byId = new Map(listed.map((r) => [r.id, r]));
    expect(byId.get('a')?.metadata?.['tag']).toBe('first');
    expect(byId.get('b')?.metadata).toBeUndefined();
    expect(byId.get('c')?.metadata?.['tag']).toBe('third');
  });

  it('reflects deletes', async () => {
    const store = new MemoryVectorStore();
    await store.upsertMany([row('a', v(1, 0)), row('b', v(0, 1))]);
    await store.delete('a');
    const listed = await store.list();
    expect(listed.map((r) => r.id)).toEqual(['b']);
  });
});

// ─── Realistic-scale smoke ────────────────────────────────────────────

describe('MemoryVectorStore — realistic-scale smoke', () => {
  it('1000 rows × 256-dim search returns top-10 in well under 100 ms', async () => {
    const store = new MemoryVectorStore();
    const dim = 256;
    const rows: VectorRow[] = [];
    // Deterministic pseudo-random — vitest doesn't seed Math.random, but
    // we don't need a true seed for a timing smoke. We do need to avoid
    // every row being collinear, otherwise the ranking has no signal.
    for (let i = 0; i < 1000; i += 1) {
      const vec: number[] = new Array(dim);
      for (let j = 0; j < dim; j += 1) {
        // Pseudo-random in [-1, 1] from a deterministic seed (i, j) so this
        // test is reproducible across runs and machines.
        vec[j] = Math.sin(i * 1.1 + j * 0.7);
      }
      rows.push({ id: `row-${i}`, vector: vec });
    }
    await store.upsertMany(rows);

    const query: number[] = new Array(dim);
    for (let j = 0; j < dim; j += 1) query[j] = Math.cos(j * 0.5);

    const t0 = performance.now();
    const results = await store.search(query, { limit: 10 });
    const dt = performance.now() - t0;

    expect(results).toHaveLength(10);
    // Sorted descending
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
    // Loose budget so we don't false-fail on slow CI; reality is 5–20ms.
    expect(dt).toBeLessThan(100);
  });
});
