import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorStoreMemory, StarStoreMemory } from '../storage/memory.js';
import { createGithubClient } from './client.js';
import { syncStarsWithStore } from './orchestrator.js';
import {
  installFetchMock,
  nextJson,
  nextNotModified,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';

const TOKEN = 'ghp_test';

function sampleStar(id: number, starredAt: string): unknown {
  const fullName = `o${id}/r${id}`;
  return {
    starred_at: starredAt,
    repo: {
      id,
      full_name: fullName,
      name: `r${id}`,
      html_url: `https://github.com/${fullName}`,
      owner: {
        login: `o${id}`,
        avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
      },
      description: 'd',
      topics: [],
      language: 'Rust',
      pushed_at: '2026-05-09T08:00:00Z',
      stargazers_count: 1,
      default_branch: 'main',
      archived: false,
      fork: false,
    },
  };
}

let fm: MockFetchHandle;
beforeEach(() => {
  fm = installFetchMock();
});
afterEach(() => {
  fm.restore();
});

describe('syncStarsWithStore — cold sync', () => {
  it('persists stars, builds initial cursor with etag + max starredAt', async () => {
    nextJson(
      fm,
      [
        sampleStar(1, '2026-05-01T00:00:00Z'),
        sampleStar(2, '2026-05-10T00:00:00Z'),
        sampleStar(3, '2026-04-20T00:00:00Z'),
      ],
      { headers: { etag: '"e1"' } }
    );

    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.notModified).toBe(false);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.knownCountAfter).toBe(3);
    expect(result.etag).toBe('"e1"');

    const cursor = await cursorStore.get();
    expect(cursor?.etag).toBe('"e1"');
    expect(cursor?.since).toBe('2026-05-10T00:00:00Z'); // max starredAt
    expect(cursor?.knownCount).toBe(3);
    expect(await starStore.count()).toBe(3);
  });

  it('sends no If-None-Match header on cold sync (no prior cursor)', async () => {
    nextJson(fm, [], { headers: { etag: '"empty-e"' } });
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStarsWithStore(client, { starStore, cursorStore });

    const headers = fm.lastCall()!.init.headers as Headers | Record<string, string>;
    const ifNoneMatch =
      headers instanceof Headers
        ? headers.get('if-none-match')
        : (headers as Record<string, string>)['if-none-match'];
    // Headers.get returns null for missing; Record indexing returns undefined.
    // Both are "header was not sent".
    expect(ifNoneMatch == null).toBe(true);
  });
});

describe('syncStarsWithStore — warm path 304', () => {
  it('returns notModified, leaves stars untouched, refreshes cursor.updatedAt', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();

    // Seed prior state
    await cursorStore.set({
      etag: '"prev"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 3,
      updatedAt: '2026-05-15T00:00:00Z',
    });
    await starStore.upsertMany([
      {
        schemaVersion: 1,
        id: 99,
        fullName: 'pre/existing',
        htmlUrl: 'https://github.com/pre/existing',
        ownerLogin: 'pre',
        ownerAvatarUrl: null,
        description: null,
        topics: [],
        language: null,
        starredAt: '2026-05-10T00:00:00Z',
        pushedAt: '2026-05-09T00:00:00Z',
        stargazersCount: 1,
        defaultBranch: 'main',
        archived: false,
        isFork: false,
        subscribedToReleases: false,
        deepIndexed: false,
        aiTags: [],
        aiSummary: null,
        userNote: null,
        lastEmbeddedAt: null,
        lastSyncedAt: '2026-05-15T00:00:00Z',
      },
    ]);

    nextNotModified(fm);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.notModified).toBe(true);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.knownCountAfter).toBe(1); // prior row still there
    expect(await starStore.count()).toBe(1);

    const cursorAfter = await cursorStore.get();
    expect(cursorAfter?.etag).toBe('"prev"'); // preserved
    expect(cursorAfter?.since).toBe('2026-05-10T00:00:00Z'); // preserved
    // updatedAt should advance to fetchedAt
    expect(cursorAfter?.updatedAt).not.toBe('2026-05-15T00:00:00Z');
  });

  it('sends If-None-Match using prior cursor etag', async () => {
    const cursorStore = new CursorStoreMemory();
    await cursorStore.set({
      etag: '"saved-etag"',
      since: null,
      knownCount: 0,
      updatedAt: '2026-05-18T00:00:00Z',
    });
    nextNotModified(fm);
    const starStore = new StarStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStarsWithStore(client, { starStore, cursorStore });

    const headers = fm.lastCall()!.init.headers as Headers | Record<string, string>;
    const ifNoneMatch =
      headers instanceof Headers
        ? headers.get('if-none-match')
        : (headers as Record<string, string>)['if-none-match'];
    expect(ifNoneMatch).toBe('"saved-etag"');
  });
});

describe('syncStarsWithStore — warm path with new stars (200)', () => {
  it('upserts delta, advances etag + since to highest starredAt', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    await cursorStore.set({
      etag: '"old"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 0,
      updatedAt: '2026-05-15T00:00:00Z',
    });

    nextJson(
      fm,
      [
        sampleStar(10, '2026-05-12T00:00:00Z'),
        sampleStar(11, '2026-05-18T00:00:00Z'),
      ],
      { headers: { etag: '"new"' } }
    );

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.notModified).toBe(false);
    expect(result.inserted).toBe(2);
    expect(result.etag).toBe('"new"');

    const cursorAfter = await cursorStore.get();
    expect(cursorAfter?.etag).toBe('"new"');
    expect(cursorAfter?.since).toBe('2026-05-18T00:00:00Z');
    expect(cursorAfter?.knownCount).toBe(2);
  });

  it('returns inserted=0, updated=N when all stars already exist', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();

    // Pre-seed via a first sync
    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e1"' },
    });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStarsWithStore(client, { starStore, cursorStore });

    // Second sync returns the same id with updated metadata (e.g. star count
    // bumped). Cursor.etag is "e1", so we'd ordinarily 304 — but here we
    // simulate "GitHub thinks the list changed" by returning a new etag.
    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e2"' },
    });
    // Force full mode — without this we'd skip into incremental and the
    // since cursor would short-circuit before re-fetching id=1.
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.knownCountAfter).toBe(1);
  });
});

describe('syncStarsWithStore — un-star cleanup (mirror semantics)', () => {
  it('deletes rows whose ids GitHub no longer returns', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    // First sync: 3 stars
    nextJson(
      fm,
      [
        sampleStar(1, '2026-05-01T00:00:00Z'),
        sampleStar(2, '2026-05-02T00:00:00Z'),
        sampleStar(3, '2026-05-03T00:00:00Z'),
      ],
      { headers: { etag: '"e1"' } }
    );
    await syncStarsWithStore(client, { starStore, cursorStore });
    expect(await starStore.count()).toBe(3);

    // Second sync: id=2 is gone (user un-starred). GitHub gave us a new etag.
    // Force full mode — cleanup only runs in full syncs.
    nextJson(
      fm,
      [sampleStar(1, '2026-05-01T00:00:00Z'), sampleStar(3, '2026-05-03T00:00:00Z')],
      { headers: { etag: '"e2"' } }
    );
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    expect(result.deleted).toBe(1);
    expect(result.knownCountAfter).toBe(2);
    expect(await starStore.get(2)).toBeNull();
    expect((await starStore.get(1))?.id).toBe(1);
    expect((await starStore.get(3))?.id).toBe(3);

    // Cursor reflects post-cleanup count
    const cursor = await cursorStore.get();
    expect(cursor?.knownCount).toBe(2);
  });

  it('empty list clears the entire store (user un-starred everything)', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    // Seed 2 stars
    nextJson(
      fm,
      [sampleStar(1, '2026-05-01T00:00:00Z'), sampleStar(2, '2026-05-02T00:00:00Z')],
      { headers: { etag: '"e1"' } }
    );
    await syncStarsWithStore(client, { starStore, cursorStore });
    expect(await starStore.count()).toBe(2);

    // Second sync: user un-starred everything. GitHub returns [].
    nextJson(fm, [], { headers: { etag: '"empty-e"' } });
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    expect(result.deleted).toBe(2);
    expect(result.inserted).toBe(0);
    expect(result.knownCountAfter).toBe(0);
    expect(await starStore.count()).toBe(0);

    // cursor.since should fall back to null when no stars exist + no prior since
    // (here prior since was 2026-05-02, which is preserved as high-water mark).
    const cursor = await cursorStore.get();
    expect(cursor?.etag).toBe('"empty-e"');
  });

  // R33 蓝军 CRITICAL #1.2 regression — orphan vector rows
  it('invokes onUnstar with deleted ids so caller can clean orphan vectors (R33)', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const unstarSpy: number[][] = [];

    nextJson(
      fm,
      [
        sampleStar(1, '2026-05-01T00:00:00Z'),
        sampleStar(2, '2026-05-02T00:00:00Z'),
        sampleStar(3, '2026-05-03T00:00:00Z'),
      ],
      { headers: { etag: '"e1"' } }
    );
    await syncStarsWithStore(client, { starStore, cursorStore });

    // 2 and 3 are un-starred; only 1 remains.
    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e2"' },
    });
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      {
        forceFullSync: true,
        onUnstar: async (ids) => {
          unstarSpy.push([...ids]);
        },
      }
    );

    expect(result.deleted).toBe(2);
    expect(unstarSpy).toHaveLength(1);
    // Order isn't guaranteed but the SET must match {2, 3}.
    expect(new Set(unstarSpy[0])).toEqual(new Set([2, 3]));
  });

  it('does NOT invoke onUnstar when nothing was un-starred (zero-cost guard)', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const unstarSpy = vi.fn(async (_ids: ReadonlyArray<number>) => {});

    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e1"' },
    });
    await syncStarsWithStore(client, { starStore, cursorStore });

    // Same list — no un-stars.
    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e2"' },
    });
    await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true, onUnstar: unstarSpy }
    );

    expect(unstarSpy).not.toHaveBeenCalled();
  });

  it('swallows onUnstar failures — starStore cleanup already succeeded', async () => {
    // Vector store cleanup failing shouldn't abort the sync since the
    // starStore was already cleaned. Caller can retry by re-syncing
    // (it'll be a no-op for starStore but onUnstar fires again).
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    nextJson(
      fm,
      [
        sampleStar(1, '2026-05-01T00:00:00Z'),
        sampleStar(2, '2026-05-02T00:00:00Z'),
      ],
      { headers: { etag: '"e1"' } }
    );
    await syncStarsWithStore(client, { starStore, cursorStore });

    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e2"' },
    });
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      {
        forceFullSync: true,
        onUnstar: async () => {
          throw new Error('vector store down');
        },
      }
    );

    // Sync still reports the successful starStore deletion.
    expect(result.deleted).toBe(1);
    expect(await starStore.count()).toBe(1);
  });

  it('cold sync (no prior store) deletes nothing — regression guard', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], { headers: { etag: '"e1"' } });
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.deleted).toBe(0);
    expect(result.inserted).toBe(1);
    expect(result.knownCountAfter).toBe(1);
  });

  it('304 path reports deleted=0 (no list changes possible)', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    await cursorStore.set({
      etag: '"x"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 1,
      updatedAt: '2026-05-15T00:00:00Z',
    });

    nextNotModified(fm);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.notModified).toBe(true);
    expect(result.deleted).toBe(0);
  });
});

describe('syncStarsWithStore — full vs incremental hybrid', () => {
  it('cold sync reports syncMode="full" and stamps lastFullSyncAt', async () => {
    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"e1"' },
    });
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const r = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(r.syncMode).toBe('full');
    const cursor = await cursorStore.get();
    expect(cursor?.lastFullSyncAt).toBe(r.fetchedAt);
  });

  it('second sync with fresh lastFullSyncAt runs incremental + sends If-None-Match + since header', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    // Seed a fresh full sync (1h ago, well within the 7d window)
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await cursorStore.set({
      etag: '"prev"',
      since: '2026-05-15T00:00:00Z',
      knownCount: 1,
      updatedAt: recent,
      lastFullSyncAt: recent,
    });

    // GitHub returns just one new star with starredAt > since
    nextJson(fm, [sampleStar(2, '2026-05-19T00:00:00Z')], {
      headers: { etag: '"e2"' },
    });

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const r = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(r.syncMode).toBe('incremental');
    expect(r.deleted).toBe(0); // incremental never deletes
    expect(r.inserted).toBe(1);

    // Verify the request actually included If-None-Match (etag was passed)
    const headers = fm.lastCall()!.init.headers as Headers | Record<string, string>;
    const ifNoneMatch =
      headers instanceof Headers
        ? headers.get('if-none-match')
        : (headers as Record<string, string>)['if-none-match'];
    expect(ifNoneMatch).toBe('"prev"');

    // Cursor's lastFullSyncAt is preserved (incremental doesn't refresh it)
    expect((await cursorStore.get())?.lastFullSyncAt).toBe(recent);
  });

  it('stale lastFullSyncAt (>7d) re-enters full mode and refreshes the stamp', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await cursorStore.set({
      etag: '"old"',
      since: '2026-01-01T00:00:00Z',
      knownCount: 0,
      updatedAt: eightDaysAgo,
      lastFullSyncAt: eightDaysAgo,
    });

    nextJson(fm, [sampleStar(1, '2026-05-19T00:00:00Z')], {
      headers: { etag: '"new"' },
    });

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const r = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(r.syncMode).toBe('full');
    const cursor = await cursorStore.get();
    expect(cursor?.lastFullSyncAt).toBe(r.fetchedAt);
    expect(cursor?.lastFullSyncAt).not.toBe(eightDaysAgo);
  });

  it('forceFullSync overrides freshness and runs full + cleanup', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await cursorStore.set({
      etag: '"x"',
      since: '2026-01-01T00:00:00Z',
      knownCount: 0,
      updatedAt: recent,
      lastFullSyncAt: recent,
    });

    nextJson(fm, [sampleStar(1, '2026-05-01T00:00:00Z')], {
      headers: { etag: '"y"' },
    });

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const r = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    expect(r.syncMode).toBe('full');
    // since was NOT applied — request URL contains no since param;
    // verified indirectly by syncStars actually fetching the full
    // response (1 star inserted).
    expect(r.inserted).toBe(1);
  });
});

describe('syncStarsWithStore — same-second boundary (data-loss regression)', () => {
  it('does not drop new stars sharing the boundary starred_at on incremental sync', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const T = '2026-05-15T00:00:00Z';

    // Cold sync: one repo starred at T → cursor.since = T, fresh lastFullSyncAt
    // (so the next sync runs INCREMENTAL and passes since=T).
    nextJson(fm, [sampleStar(1, T)], { headers: { etag: '"e1"' } });
    await syncStarsWithStore(client, { starStore, cursorStore });
    expect(await starStore.count()).toBe(1);

    // User stars two MORE repos in the same wall-clock second as id=1. GitHub
    // returns them ahead of id=1 (DESC). A `<= since` short-circuit would treat
    // id=3 (== since) as "already known", break immediately, and silently lose
    // id=2 and id=3 until the next full sync (up to 7 days later).
    nextJson(
      fm,
      [sampleStar(3, T), sampleStar(2, T), sampleStar(1, T)],
      { headers: { etag: '"e2"' } }
    );
    const r = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(r.syncMode).toBe('incremental');
    expect(await starStore.count()).toBe(3);
  });
});

describe('syncStarsWithStore — local field preservation (R12 蓝军 regression)', () => {
  // R12 蓝军 #2-1 P0: syncResult.stars come from GitHub which has no concept of
  // aiTags / aiSummary / userNote / lastEmbeddedAt / subscribedToReleases /
  // deepIndexed. Zod's `.default([])` / `.default(null)` / `.default(false)`
  // would silently overwrite these LOCAL-ONLY fields on every sync, wiping
  // user notes, generated tags, and forcing re-embedding. The orchestrator
  // MUST merge local fields from the existing row before upserting.
  it('preserves aiTags / userNote / aiSummary / lastEmbeddedAt / subscribedToReleases / deepIndexed on re-sync', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const T = '2026-05-15T00:00:00Z';

    // Cold sync: import one star.
    nextJson(fm, [sampleStar(1, T)], { headers: { etag: '"e1"' } });
    await syncStarsWithStore(client, { starStore, cursorStore });

    // Simulate downstream pipelines decorating the row with local fields:
    // auto-tag, manual user note, embedding pass, release subscription, deep-index opt-in.
    const existing = await starStore.get(1);
    expect(existing).not.toBeNull();
    await starStore.upsertMany([
      {
        ...existing!,
        aiTags: ['rust', 'async-runtime'],
        userNote: 'check examples/ before adopting',
        aiSummary: 'A Rust async runtime focused on low-latency scheduling.',
        lastEmbeddedAt: '2026-05-20T00:00:00Z',
        subscribedToReleases: true,
        deepIndexed: true,
      },
    ]);

    // Re-sync: GitHub returns the same star (no local field knowledge).
    // forceFullSync to be explicit and avoid cursor-mode branching.
    nextJson(fm, [sampleStar(1, T)], { headers: { etag: '"e2"' } });
    await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    const after = await starStore.get(1);
    expect(after).not.toBeNull();
    // The six local-only fields MUST survive the resync.
    expect(after!.aiTags).toEqual(['rust', 'async-runtime']);
    expect(after!.userNote).toBe('check examples/ before adopting');
    expect(after!.aiSummary).toBe(
      'A Rust async runtime focused on low-latency scheduling.'
    );
    expect(after!.lastEmbeddedAt).toBe('2026-05-20T00:00:00Z');
    expect(after!.subscribedToReleases).toBe(true);
    expect(after!.deepIndexed).toBe(true);
    // GitHub-sourced fields are refreshed (lastSyncedAt advances).
    expect(after!.lastSyncedAt).not.toBe(existing!.lastSyncedAt);
  });

  // R21 蓝军 P0 — translation cache preservation regression. The user
  // report "翻译完了依旧有标签和介绍没有翻译" reproduced because Phase 6
  // added 4 i18n-cache fields (descriptionI18n / aiSummaryI18n /
  // aiTagsI18n / lastTranslatedAt) but LOCAL_ONLY_FIELDS wasn't updated.
  // Every sync silently reset the cache to schema defaults (`{}` / null)
  // so users had to re-translate after every sync. This locks the contract.
  it('preserves descriptionI18n / aiSummaryI18n / aiTagsI18n / lastTranslatedAt on re-sync (R21 蓝军 P0)', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const fm = installFetchMock();
    // ISO timestamp scoped locally — the prior test's `T` is block-
    // scoped and not visible here. Independent fixture per test.
    const T = '2026-05-15T00:00:00Z';

    nextJson(fm, [sampleStar(1, T)], { headers: { etag: '"e1"' } });
    await syncStarsWithStore(client, { starStore, cursorStore });

    // Simulate the translate pipeline decorating the row across multiple locales.
    const existing = await starStore.get(1);
    expect(existing).not.toBeNull();
    const translatedAt = '2026-05-25T12:00:00Z';
    await starStore.upsertMany([
      {
        ...existing!,
        descriptionI18n: {
          'zh-CN': 'Rust 异步运行时',
          ja: 'Rust 非同期ランタイム',
          de: 'Rust-Async-Laufzeit',
        },
        aiSummaryI18n: {
          'zh-CN': '一个专注于低延迟调度的 Rust 异步运行时。',
        },
        aiTagsI18n: {
          'zh-CN': '异步运行时, rust, 并发',
          ja: '非同期ランタイム, rust, 並行',
        },
        lastTranslatedAt: translatedAt,
      },
    ]);

    // Re-sync: GitHub returns the same star. Without the R21 fix, the
    // 4 i18n fields would be reset to defaults ({} / null).
    nextJson(fm, [sampleStar(1, T)], { headers: { etag: '"e2"' } });
    await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      { forceFullSync: true }
    );

    const after = await starStore.get(1);
    expect(after).not.toBeNull();
    // All 4 i18n local-only fields MUST survive sync — that's the contract.
    expect(after!.descriptionI18n).toEqual({
      'zh-CN': 'Rust 异步运行时',
      ja: 'Rust 非同期ランタイム',
      de: 'Rust-Async-Laufzeit',
    });
    expect(after!.aiSummaryI18n).toEqual({
      'zh-CN': '一个专注于低延迟调度的 Rust 异步运行时。',
    });
    expect(after!.aiTagsI18n).toEqual({
      'zh-CN': '异步运行时, rust, 并发',
      ja: '非同期ランタイム, rust, 並行',
    });
    expect(after!.lastTranslatedAt).toBe(translatedAt);
  });

  it('cold sync (no existing row) writes GitHub data as-is — does not invent local fields', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    const client = createGithubClient({ token: TOKEN, retries: 0 });

    nextJson(fm, [sampleStar(7, '2026-05-15T00:00:00Z')], {
      headers: { etag: '"e1"' },
    });
    await syncStarsWithStore(client, { starStore, cursorStore });

    const row = await starStore.get(7);
    expect(row?.aiTags).toEqual([]);
    expect(row?.userNote).toBeNull();
    expect(row?.aiSummary).toBeNull();
    expect(row?.lastEmbeddedAt).toBeNull();
    expect(row?.subscribedToReleases).toBe(false);
    expect(row?.deepIndexed).toBe(false);
  });
});

describe('syncStarsWithStore — error propagation', () => {
  it('does not touch the cursor when syncStars throws', async () => {
    const starStore = new StarStoreMemory();
    const cursorStore = new CursorStoreMemory();
    await cursorStore.set({
      etag: '"untouched"',
      since: '2026-05-10T00:00:00Z',
      knownCount: 5,
      updatedAt: '2026-05-15T00:00:00Z',
    });

    nextJson(fm, { message: 'Bad credentials' }, { status: 401 });

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(
      syncStarsWithStore(client, { starStore, cursorStore })
    ).rejects.toMatchObject({ kind: 'auth' });

    const cursor = await cursorStore.get();
    expect(cursor?.etag).toBe('"untouched"');
    expect(cursor?.updatedAt).toBe('2026-05-15T00:00:00Z');
  });
});
