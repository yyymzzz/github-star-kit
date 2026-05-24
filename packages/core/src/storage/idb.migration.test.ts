/**
 * IDB v1 → v2 migration regression test.
 *
 * R10 蓝军 找出来的 P0：production schema is currently at v2 (added the
 * `vectors` store for W3 D3). The upgrade handler at idb.ts:90-105 is
 * additive-only with `if (!contains)` guards, so it SHOULD be safe — but
 * "should be" without a test is how data-loss bugs ship. This file proves
 * that opening at v1, seeding real data, closing, and re-opening at v2:
 *   - Creates the new `vectors` store empty.
 *   - Leaves stars / kv / cursor data untouched.
 *
 * Uses fake-indexeddb so it runs in pure Node under vitest.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StarredRepo, SyncCursor } from '../schema.js';
import {
  openStarKitDb,
  type StarKitDB,
} from './idb.js';

let dbNameCounter = 0;
function freshDbName(): string {
  dbNameCounter += 1;
  return `starkit-migration-${Date.now()}-${dbNameCounter}`;
}

function makeStar(id: number): StarredRepo {
  return {
    schemaVersion: 1,
    id,
    fullName: `user/repo-${id}`,
    htmlUrl: `https://github.com/user/repo-${id}`,
    ownerLogin: 'user',
    ownerAvatarUrl: null,
    description: `Repo number ${id}`,
    topics: ['test'],
    language: 'TypeScript',
    starredAt: `2024-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z`,
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
  };
}

function makeCursor(): SyncCursor {
  return {
    etag: '"abc123"',
    since: '2024-01-01T00:00:00Z',
    knownCount: 3,
    updatedAt: '2026-05-23T00:00:00Z',
    lastFullSyncAt: '2026-05-23T00:00:00Z',
  };
}

/**
 * Open a DB explicitly at SCHEMA v1 — what users of the v0.0.1 release
 * had on disk. Mirrors the v1 upgrade handler from before W3 D3 added the
 * `vectors` store: only `stars`, `kv`, `cursor` existed. Used to seed
 * realistic legacy data so the migration test can then re-open via the
 * production `openStarKitDb` (which targets v2) and assert nothing
 * silently disappeared.
 */
async function openAsV1(name: string) {
  return openDB(name, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('stars')) {
        const stars = db.createObjectStore('stars', { keyPath: 'id' });
        stars.createIndex('by-starredAt', 'starredAt');
        stars.createIndex('by-pushedAt', 'pushedAt');
        stars.createIndex('by-stargazersCount', 'stargazersCount');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('cursor')) {
        db.createObjectStore('cursor');
      }
      // No `vectors` store — that's exactly the migration we're testing.
    },
  });
}

describe('StarKitDB v1 → v2 migration', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = freshDbName();
  });

  afterEach(() => {
    // No global cleanup needed — fake-indexeddb is per-test via fresh names.
  });

  it('preserves stars data across the v1 → v2 upgrade', async () => {
    // Seed v1 with 3 stars
    const v1 = await openAsV1(dbName);
    const tx = v1.transaction('stars', 'readwrite');
    await tx.objectStore('stars').put(makeStar(1));
    await tx.objectStore('stars').put(makeStar(2));
    await tx.objectStore('stars').put(makeStar(3));
    await tx.done;
    v1.close();

    // Re-open via production path (DB_VERSION = 2)
    const v2: StarKitDB = await openStarKitDb(dbName);

    // Stars data MUST be intact
    expect(await v2.count('stars')).toBe(3);
    const star2 = await v2.get('stars', 2);
    expect(star2).toBeDefined();
    expect(star2?.fullName).toBe('user/repo-2');

    // New vectors store MUST exist and be empty
    expect(v2.objectStoreNames.contains('vectors')).toBe(true);
    expect(await v2.count('vectors')).toBe(0);

    v2.close();
  });

  it('preserves cursor + kv data across the upgrade', async () => {
    const v1 = await openAsV1(dbName);
    // Seed the OOL kv store + the single-row cursor store
    await v1.put('kv', 'ghp_secret_token', 'github.pat');
    await v1.put('kv', { foo: 'bar' }, 'misc.config');
    await v1.put('cursor', makeCursor(), 'default');
    v1.close();

    const v2: StarKitDB = await openStarKitDb(dbName);
    expect(await v2.get('kv', 'github.pat')).toBe('ghp_secret_token');
    expect(await v2.get('kv', 'misc.config')).toEqual({ foo: 'bar' });
    const cur = await v2.get('cursor', 'default');
    expect(cur?.etag).toBe('"abc123"');
    expect(cur?.knownCount).toBe(3);
    v2.close();
  });

  it('is idempotent — opening at v2 twice doesn\'t corrupt existing v2 data', async () => {
    // Open at v2 fresh, seed
    const a = await openStarKitDb(dbName);
    await a.put('stars', makeStar(1));
    await a.put('vectors', {
      id: 'star:1',
      vector: [0.1, 0.2, 0.3],
      metadata: { contentHash: 'h1' },
    });
    a.close();

    // Re-open at v2 — upgrade handler should NOT fire (version unchanged),
    // and all data must persist.
    const b = await openStarKitDb(dbName);
    expect(await b.count('stars')).toBe(1);
    expect(await b.count('vectors')).toBe(1);
    const vec = await b.get('vectors', 'star:1');
    expect(vec?.vector).toEqual([0.1, 0.2, 0.3]);
    b.close();
  });

  it('survives the upgrade even when the v1 DB had ZERO data (fresh-install upgrade path)', async () => {
    // Some users will install v0.0.1, open the popup once (creating an
    // empty v1 DB), then never sync before upgrading. Make sure that
    // empty-but-existing v1 still upgrades cleanly.
    const v1 = await openAsV1(dbName);
    v1.close(); // No data, just the schema

    const v2 = await openStarKitDb(dbName);
    expect(v2.objectStoreNames.contains('vectors')).toBe(true);
    expect(await v2.count('stars')).toBe(0);
    expect(await v2.count('vectors')).toBe(0);
    v2.close();
  });
});
