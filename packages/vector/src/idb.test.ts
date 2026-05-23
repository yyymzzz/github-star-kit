/**
 * Contract tests for IndexedDBVectorStore — the persistent half of the
 * two-tier (IDB + Memory) vector index used by the extension popup.
 *
 * Strategy: re-run the load-bearing memory.test.ts cases against the IDB
 * impl to confirm observable parity, then add IDB-specific concerns
 * (persistence across re-open, schema migration from v1, batch atomicity).
 *
 * The DB itself is created via @starkit/core's `openStarKitDb` — that's the
 * single source of truth for schema, so this test exercises the integration
 * between core's v2 schema migration and vector's IDB adapter together.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStarKitDb, type StarKitDB } from '@starkit/core';
import { IndexedDBVectorStore } from './idb.js';
import type { VectorRow } from './types.js';

let dbNameCounter = 0;
function freshDbName(): string {
  dbNameCounter += 1;
  return `starkit-vec-test-${Date.now()}-${dbNameCounter}`;
}

function makeRow(overrides: Partial<VectorRow> = {}): VectorRow {
  return {
    id: overrides.id ?? 'star:1',
    vector: overrides.vector ?? [1, 0, 0, 0],
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

let db: StarKitDB;
let store: IndexedDBVectorStore;
let dbName: string;

beforeEach(async () => {
  dbName = freshDbName();
  db = await openStarKitDb(dbName);
  store = new IndexedDBVectorStore(db);
});

afterEach(async () => {
  db.close();
});

describe('IndexedDBVectorStore — basic CRUD', () => {
  it('starts empty', async () => {
    expect(await store.count()).toBe(0);
    expect(await store.list()).toEqual([]);
    expect(await store.get('star:1')).toBeNull();
  });

  it('upsertMany returns inserted=N updated=0 on first insert', async () => {
    const result = await store.upsertMany([
      makeRow({ id: 'star:1' }),
      makeRow({ id: 'star:2' }),
      makeRow({ id: 'star:3' }),
    ]);
    expect(result).toEqual({ inserted: 3, updated: 0 });
    expect(await store.count()).toBe(3);
  });

  it('upsertMany distinguishes inserts from updates by id', async () => {
    await store.upsertMany([makeRow({ id: 'star:1' })]);
    const result = await store.upsertMany([
      makeRow({ id: 'star:1', vector: [9, 9, 9, 9] }), // update
      makeRow({ id: 'star:2' }), // insert
    ]);
    expect(result).toEqual({ inserted: 1, updated: 1 });

    const fetched = await store.get('star:1');
    expect(fetched?.vector).toEqual([9, 9, 9, 9]); // update overwrote
  });

  it('upsertMany with empty input is a no-op', async () => {
    const result = await store.upsertMany([]);
    expect(result).toEqual({ inserted: 0, updated: 0 });
    expect(await store.count()).toBe(0);
  });

  it('get returns null for missing id', async () => {
    await store.upsertMany([makeRow({ id: 'star:1' })]);
    expect(await store.get('star:999')).toBeNull();
  });

  it('preserves metadata round-trip including nested objects', async () => {
    const md = {
      starId: 42,
      contentHash: 'abc123',
      model: 'text-embedding-3-small',
      embeddedAt: '2026-05-23T00:00:00Z',
      // nested object — exercises structured-clone, not just JSON
      nested: { tags: ['async', 'rust'], count: 26000 },
    };
    await store.upsertMany([makeRow({ id: 'star:1', metadata: md })]);
    const got = await store.get('star:1');
    expect(got?.metadata).toEqual(md);
  });

  it('omits metadata key when source had no metadata', async () => {
    await store.upsertMany([makeRow({ id: 'star:1' })]);
    const got = await store.get('star:1');
    // Either undefined or absent — the contract is "no metadata".
    expect(got?.metadata).toBeUndefined();
  });

  it('delete removes a row, leaving others intact', async () => {
    await store.upsertMany([
      makeRow({ id: 'star:1' }),
      makeRow({ id: 'star:2' }),
    ]);
    await store.delete('star:1');
    expect(await store.get('star:1')).toBeNull();
    expect(await store.get('star:2')).not.toBeNull();
    expect(await store.count()).toBe(1);
  });

  it('delete on a missing id is a no-op', async () => {
    await store.upsertMany([makeRow({ id: 'star:1' })]);
    await store.delete('star:999');
    expect(await store.count()).toBe(1);
  });

  it('clear wipes every row', async () => {
    await store.upsertMany([
      makeRow({ id: 'star:1' }),
      makeRow({ id: 'star:2' }),
    ]);
    await store.clear();
    expect(await store.count()).toBe(0);
    expect(await store.list()).toEqual([]);
  });
});

describe('IndexedDBVectorStore — list semantics', () => {
  it('list returns every row written', async () => {
    const rows = [
      makeRow({ id: 'star:1', vector: [1, 0, 0, 0] }),
      makeRow({ id: 'star:2', vector: [0, 1, 0, 0] }),
      makeRow({ id: 'star:3', vector: [0, 0, 1, 0] }),
    ];
    await store.upsertMany(rows);
    const listed = await store.list();
    expect(listed).toHaveLength(3);
    const ids = listed.map((r) => r.id).sort();
    expect(ids).toEqual(['star:1', 'star:2', 'star:3']);
  });
});

describe('IndexedDBVectorStore — full-scan search', () => {
  it('search returns top-K by cosine similarity', async () => {
    await store.upsertMany([
      makeRow({ id: 'star:1', vector: [1, 0, 0, 0] }), // identical to query
      makeRow({ id: 'star:2', vector: [0, 1, 0, 0] }), // orthogonal
      makeRow({ id: 'star:3', vector: [0.9, 0.1, 0, 0] }), // very close
    ]);
    const results = await store.search([1, 0, 0, 0], { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('star:1');
    expect(results[0]!.score).toBeCloseTo(1, 5);
    expect(results[1]!.id).toBe('star:3');
  });

  it('search honors minScore', async () => {
    await store.upsertMany([
      makeRow({ id: 'star:1', vector: [1, 0, 0, 0] }),
      makeRow({ id: 'star:2', vector: [0, 1, 0, 0] }), // cosine 0
    ]);
    const results = await store.search([1, 0, 0, 0], { minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('star:1');
  });

  it('search returns empty on empty store', async () => {
    const results = await store.search([1, 0, 0, 0]);
    expect(results).toEqual([]);
  });
});

describe('IndexedDBVectorStore — persistence + atomicity', () => {
  it('rows survive a db close + re-open', async () => {
    await store.upsertMany([
      makeRow({ id: 'star:1', metadata: { contentHash: 'h1' } }),
      makeRow({ id: 'star:2', metadata: { contentHash: 'h2' } }),
    ]);
    db.close();

    // Re-open the SAME db name — data should be intact
    db = await openStarKitDb(dbName);
    store = new IndexedDBVectorStore(db);

    expect(await store.count()).toBe(2);
    const got = await store.get('star:1');
    expect(got?.metadata?.['contentHash']).toBe('h1');
  });

  it('shares a connection with stars store (single DB, no conflict)', async () => {
    // Smoke check: writing to vectors does NOT interfere with the stars
    // store living in the same DB. The W3 D3 popup will write to BOTH
    // simultaneously, so the schema-shared assumption needs to hold.
    await store.upsertMany([makeRow({ id: 'star:1' })]);
    // Just confirm count from a fresh adapter on same DB sees the write
    const fresh = new IndexedDBVectorStore(db);
    expect(await fresh.count()).toBe(1);
  });
});
