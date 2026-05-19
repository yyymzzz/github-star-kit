/**
 * Contract tests for the IndexedDB storage adapter. Polyfills indexedDB via
 * fake-indexeddb so the suite runs in plain Node under vitest.
 *
 * Coverage strategy: re-run the most load-bearing memory.test.ts cases
 * against the IndexedDB impl to assert the two backings have identical
 * observable behavior. IDB-specific concerns (schema upgrade, persistence
 * across re-open) get their own describes.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { createGithubClient } from '../github/client.js';
import { syncStarsWithStore } from '../github/orchestrator.js';
import { installFetchMock, nextJson } from '../test-utils/fetch-mock.js';
import {
  IndexedDBCursorStore,
  IndexedDBKVStore,
  IndexedDBStarStore,
  openStarKitDb,
  type StarKitDB,
} from './idb.js';

let dbNameCounter = 0;
function freshDbName(): string {
  dbNameCounter += 1;
  return `starkit-test-${Date.now()}-${dbNameCounter}`;
}

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

let db: StarKitDB;
beforeEach(async () => {
  db = await openStarKitDb(freshDbName());
});
afterEach(() => {
  db.close();
});

describe('IndexedDBStarStore', () => {
  it('upsertMany classifies new vs existing ids', async () => {
    const store = new IndexedDBStarStore(db);
    expect(await store.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })])).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(
      await store.upsertMany([
        makeStar({ id: 1, description: 'new' }),
        makeStar({ id: 3 }),
      ])
    ).toEqual({ inserted: 1, updated: 1 });
    expect((await store.get(1))?.description).toBe('new');
    expect(await store.count()).toBe(3);
  });

  it('list default order: starredAt DESC', async () => {
    const store = new IndexedDBStarStore(db);
    await store.upsertMany([
      makeStar({ id: 1, starredAt: '2026-01-01T00:00:00Z' }),
      makeStar({ id: 2, starredAt: '2026-05-01T00:00:00Z' }),
      makeStar({ id: 3, starredAt: '2026-03-01T00:00:00Z' }),
    ]);
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([2, 3, 1]);
  });

  it('list orderBy pushedAt ASC', async () => {
    const store = new IndexedDBStarStore(db);
    await store.upsertMany([
      makeStar({ id: 1, pushedAt: '2026-05-09T00:00:00Z' }),
      makeStar({ id: 2, pushedAt: '2025-01-01T00:00:00Z' }),
    ]);
    expect(
      (await store.list({ orderBy: 'pushedAt', order: 'asc' })).map((s) => s.id)
    ).toEqual([2, 1]);
  });

  it('list limit + offset', async () => {
    const store = new IndexedDBStarStore(db);
    await store.upsertMany([
      makeStar({ id: 1, starredAt: '2026-01-01T00:00:00Z' }),
      makeStar({ id: 2, starredAt: '2026-02-01T00:00:00Z' }),
      makeStar({ id: 3, starredAt: '2026-03-01T00:00:00Z' }),
      makeStar({ id: 4, starredAt: '2026-04-01T00:00:00Z' }),
    ]);
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page.map((s) => s.id)).toEqual([3, 2]);
  });

  it('delete + clear', async () => {
    const store = new IndexedDBStarStore(db);
    await store.upsertMany([makeStar({ id: 1 }), makeStar({ id: 2 })]);
    await store.delete(1);
    expect(await store.count()).toBe(1);
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('rejects schema violations before transaction commit', async () => {
    const store = new IndexedDBStarStore(db);
    await expect(
      // @ts-expect-error — bypass
      store.upsertMany([{ id: -1 } as StarredRepo])
    ).rejects.toThrow();
    expect(await store.count()).toBe(0);
  });
});

describe('IndexedDBKVStore', () => {
  it('round-trips arbitrary JSON values', async () => {
    const kv = new IndexedDBKVStore(db);
    await kv.set('pat', { token: 'ghp_x', scope: 'public_repo' });
    expect(await kv.get('pat')).toEqual({ token: 'ghp_x', scope: 'public_repo' });
  });

  it('returns null for missing key', async () => {
    const kv = new IndexedDBKVStore(db);
    expect(await kv.get('never')).toBeNull();
  });

  it('delete + keys', async () => {
    const kv = new IndexedDBKVStore(db);
    await kv.set('a', 1);
    await kv.set('b', 2);
    await kv.delete('a');
    expect(new Set(await kv.keys())).toEqual(new Set(['b']));
  });
});

describe('IndexedDBCursorStore', () => {
  it('initial get returns null', async () => {
    const cursor = new IndexedDBCursorStore(db);
    expect(await cursor.get()).toBeNull();
  });

  it('set then get round-trips with schema validation', async () => {
    const cursor = new IndexedDBCursorStore(db);
    await cursor.set({
      etag: '"abc"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 5,
      updatedAt: '2026-05-19T10:00:00Z',
    });
    expect((await cursor.get())?.knownCount).toBe(5);
  });

  it('clear reverts to null', async () => {
    const cursor = new IndexedDBCursorStore(db);
    await cursor.set({
      etag: null,
      since: null,
      knownCount: 0,
      updatedAt: '2026-05-19T10:00:00Z',
    });
    await cursor.clear();
    expect(await cursor.get()).toBeNull();
  });
});

describe('openStarKitDb durability', () => {
  it('data persists across close + reopen with the same name', async () => {
    const name = freshDbName();
    const db1 = await openStarKitDb(name);
    await new IndexedDBStarStore(db1).upsertMany([makeStar({ id: 42 })]);
    db1.close();

    const db2 = await openStarKitDb(name);
    expect(await new IndexedDBStarStore(db2).count()).toBe(1);
    expect((await new IndexedDBStarStore(db2).get(42))?.id).toBe(42);
    db2.close();
  });
});

describe('syncStarsWithStore × IndexedDB end-to-end', () => {
  it('cold sync persists stars + cursor; reopen sees both', async () => {
    const fm = installFetchMock();
    try {
      const name = freshDbName();
      const db1 = await openStarKitDb(name);
      const starStore = new IndexedDBStarStore(db1);
      const cursorStore = new IndexedDBCursorStore(db1);

      nextJson(
        fm,
        [
          {
            starred_at: '2026-05-01T00:00:00Z',
            repo: {
              id: 7,
              full_name: 'o/r',
              name: 'r',
              html_url: 'https://github.com/o/r',
              owner: { login: 'o', avatar_url: 'https://avatars.example/u/1' },
              description: 'd',
              topics: [],
              language: 'Go',
              pushed_at: '2026-04-30T00:00:00Z',
              stargazers_count: 1,
              default_branch: 'main',
              archived: false,
              fork: false,
            },
          },
        ],
        { headers: { etag: '"end2end"' } }
      );

      const client = createGithubClient({ token: 'ghp_test', retries: 0 });
      const result = await syncStarsWithStore(client, { starStore, cursorStore });
      expect(result.inserted).toBe(1);

      db1.close();

      const db2 = await openStarKitDb(name);
      expect(await new IndexedDBStarStore(db2).count()).toBe(1);
      const persistedCursor = await new IndexedDBCursorStore(db2).get();
      expect(persistedCursor?.etag).toBe('"end2end"');
      expect(persistedCursor?.since).toBe('2026-05-01T00:00:00Z');
      db2.close();
    } finally {
      fm.restore();
      vi.unstubAllGlobals();
    }
  });
});
