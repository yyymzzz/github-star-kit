import { describe, expect, it, beforeEach } from 'vitest';
import type { StarredRepo, SyncCursor } from '../schema.js';
import {
  CursorStoreMemory,
  KVStoreMemory,
  StarStoreMemory,
} from './memory.js';

/**
 * Build a valid StarredRepo with sane defaults so tests can override only
 * the fields they care about (id, starredAt, pushedAt for ordering tests).
 */
function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 1,
    fullName: overrides.fullName ?? 'rust-lang/rust',
    htmlUrl: overrides.htmlUrl ?? 'https://github.com/rust-lang/rust',
    ownerLogin: overrides.ownerLogin ?? 'rust-lang',
    ownerAvatarUrl: overrides.ownerAvatarUrl ?? null,
    description: overrides.description ?? 'desc',
    topics: overrides.topics ?? [],
    language: overrides.language ?? 'Rust',
    starredAt: overrides.starredAt ?? '2026-05-10T12:00:00Z',
    pushedAt: overrides.pushedAt ?? '2026-05-09T08:00:00Z',
    stargazersCount: overrides.stargazersCount ?? 100,
    defaultBranch: overrides.defaultBranch ?? 'main',
    archived: overrides.archived ?? false,
    isFork: overrides.isFork ?? false,
    subscribedToReleases: overrides.subscribedToReleases ?? false,
    deepIndexed: overrides.deepIndexed ?? false,
    aiTags: overrides.aiTags ?? [],
    aiSummary: overrides.aiSummary ?? null,
    userNote: overrides.userNote ?? null,
    lastEmbeddedAt: overrides.lastEmbeddedAt ?? null,
    lastSyncedAt: overrides.lastSyncedAt ?? '2026-05-19T10:00:00Z',
  };
}

// ─── KVStoreMemory ───────────────────────────────────────────────────

describe('KVStoreMemory', () => {
  let kv: KVStoreMemory;
  beforeEach(() => {
    kv = new KVStoreMemory();
  });

  it('get on missing key returns null', async () => {
    expect(await kv.get('absent')).toBeNull();
  });

  it('round-trips set → get', async () => {
    await kv.set('pat', { token: 'ghp_test', scope: 'public_repo' });
    const v = await kv.get<{ token: string; scope: string }>('pat');
    expect(v).toEqual({ token: 'ghp_test', scope: 'public_repo' });
  });

  it('set replaces the previous value (not merge)', async () => {
    await kv.set('cfg', { a: 1, b: 2 });
    await kv.set('cfg', { c: 3 });
    expect(await kv.get('cfg')).toEqual({ c: 3 });
  });

  it('delete removes the key; subsequent get returns null', async () => {
    await kv.set('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('delete on missing key is a no-op', async () => {
    await expect(kv.delete('never-set')).resolves.toBeUndefined();
  });

  it('keys() lists all current keys', async () => {
    await kv.set('a', 1);
    await kv.set('b', 2);
    expect(new Set(await kv.keys())).toEqual(new Set(['a', 'b']));
  });
});

// ─── StarStoreMemory ─────────────────────────────────────────────────

describe('StarStoreMemory.upsertMany', () => {
  it('counts all new ids as inserted on a cold store', async () => {
    const store = new StarStoreMemory();
    const result = await store.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    expect(result).toEqual({ inserted: 3, updated: 0 });
    expect(await store.count()).toBe(3);
  });

  it('counts existing ids as updated; replaces in place', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([makeStar({ id: 1, description: 'old' })]);
    const result = await store.upsertMany([
      makeStar({ id: 1, description: 'new' }),
      makeStar({ id: 2 }),
    ]);
    expect(result).toEqual({ inserted: 1, updated: 1 });
    expect((await store.get(1))?.description).toBe('new');
  });

  it('throws on input that violates StarredRepoSchema', async () => {
    const store = new StarStoreMemory();
    await expect(
      // @ts-expect-error — intentional bypass
      store.upsertMany([{ id: -1 } as StarredRepo])
    ).rejects.toThrow();
    expect(await store.count()).toBe(0);
  });
});

describe('StarStoreMemory.list ordering + paging', () => {
  it('default order: starredAt DESC', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([
      makeStar({ id: 1, starredAt: '2026-01-01T00:00:00Z' }),
      makeStar({ id: 2, starredAt: '2026-05-01T00:00:00Z' }),
      makeStar({ id: 3, starredAt: '2026-03-01T00:00:00Z' }),
    ]);
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([2, 3, 1]);
  });

  it('orderBy: pushedAt with order: asc', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([
      makeStar({ id: 1, pushedAt: '2026-05-09T00:00:00Z' }),
      makeStar({ id: 2, pushedAt: '2025-01-01T00:00:00Z' }),
    ]);
    const list = await store.list({ orderBy: 'pushedAt', order: 'asc' });
    expect(list.map((s) => s.id)).toEqual([2, 1]);
  });

  it('orders a null pushedAt as the oldest (never-pushed repo sorts to the recent-end last)', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([
      makeStar({ id: 1, pushedAt: '2026-05-10T00:00:00Z' }),
      { ...makeStar({ id: 2 }), pushedAt: null }, // never-pushed (empty) repo
      makeStar({ id: 3, pushedAt: '2026-05-20T00:00:00Z' }),
    ]);
    // desc = most-recently-pushed first; null (no push ever) goes last.
    const desc = await store.list({ orderBy: 'pushedAt', order: 'desc' });
    expect(desc.map((s) => s.id)).toEqual([3, 1, 2]);
    // asc = oldest first; null leads.
    const asc = await store.list({ orderBy: 'pushedAt', order: 'asc' });
    expect(asc.map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it('orderBy: stargazersCount with order: desc', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([
      makeStar({ id: 1, stargazersCount: 50 }),
      makeStar({ id: 2, stargazersCount: 500 }),
      makeStar({ id: 3, stargazersCount: 5 }),
    ]);
    const list = await store.list({ orderBy: 'stargazersCount' });
    expect(list.map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it('limit + offset slice the post-sort window', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([
      makeStar({ id: 1, starredAt: '2026-01-01T00:00:00Z' }),
      makeStar({ id: 2, starredAt: '2026-02-01T00:00:00Z' }),
      makeStar({ id: 3, starredAt: '2026-03-01T00:00:00Z' }),
      makeStar({ id: 4, starredAt: '2026-04-01T00:00:00Z' }),
    ]);
    const page = await store.list({ limit: 2, offset: 1 });
    // DESC order is [4, 3, 2, 1]; offset 1 + limit 2 → [3, 2]
    expect(page.map((s) => s.id)).toEqual([3, 2]);
  });
});

describe('StarStoreMemory.get / delete / clear', () => {
  it('get on missing id returns null', async () => {
    const store = new StarStoreMemory();
    expect(await store.get(999)).toBeNull();
  });

  it('delete removes single row; count decrements', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    await store.delete(1);
    expect(await store.count()).toBe(1);
    expect(await store.get(1)).toBeNull();
    expect((await store.get(2))?.id).toBe(2);
  });

  it('clear drops all rows', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('deleteMany removes all listed ids and returns the count actually deleted', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 }), makeStar({ id: 3 })]);
    const deleted = await store.deleteMany([1, 3, 999]); // 999 is absent
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
    expect((await store.get(2))?.id).toBe(2);
  });

  it('deleteMany on an empty id list is a no-op', async () => {
    const store = new StarStoreMemory();
    await store.upsertMany([makeStar({ id: 1 })]);
    expect(await store.deleteMany([])).toBe(0);
    expect(await store.count()).toBe(1);
  });
});

// ─── CursorStoreMemory ───────────────────────────────────────────────

describe('CursorStoreMemory', () => {
  let cursor: CursorStoreMemory;
  beforeEach(() => {
    cursor = new CursorStoreMemory();
  });

  it('get returns null before any set', async () => {
    expect(await cursor.get()).toBeNull();
  });

  it('set then get round-trips', async () => {
    const c: SyncCursor = {
      etag: '"abc"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 42,
      updatedAt: '2026-05-19T10:00:00Z',
      lastFullSyncAt: '2026-05-19T09:00:00Z',
    };
    await cursor.set(c);
    expect(await cursor.get()).toEqual(c);
  });

  it('set replaces the previous cursor outright', async () => {
    await cursor.set({
      etag: '"old"',
      since: null,
      knownCount: 0,
      updatedAt: '2026-05-01T00:00:00Z',
    });
    await cursor.set({
      etag: '"new"',
      since: '2026-05-19T00:00:00Z',
      knownCount: 50,
      updatedAt: '2026-05-19T10:00:00Z',
    });
    expect((await cursor.get())?.etag).toBe('"new"');
  });

  it('clear reverts to null', async () => {
    await cursor.set({
      etag: null,
      since: null,
      knownCount: 0,
      updatedAt: '2026-05-19T10:00:00Z',
    });
    await cursor.clear();
    expect(await cursor.get()).toBeNull();
  });

  it('throws on input violating SyncCursorSchema', async () => {
    await expect(
      // @ts-expect-error — intentional bypass
      cursor.set({ knownCount: -1, updatedAt: '2026-05-19T00:00:00Z' })
    ).rejects.toThrow();
  });
});
