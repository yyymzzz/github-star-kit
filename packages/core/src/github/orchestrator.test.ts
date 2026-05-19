import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

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
    nextJson(
      fm,
      [sampleStar(1, '2026-05-01T00:00:00Z'), sampleStar(3, '2026-05-03T00:00:00Z')],
      { headers: { etag: '"e2"' } }
    );
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

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
    const result = await syncStarsWithStore(client, { starStore, cursorStore });

    expect(result.deleted).toBe(2);
    expect(result.inserted).toBe(0);
    expect(result.knownCountAfter).toBe(0);
    expect(await starStore.count()).toBe(0);

    // cursor.since should fall back to null when no stars exist + no prior since
    // (here prior since was 2026-05-02, which is preserved as high-water mark).
    const cursor = await cursorStore.get();
    expect(cursor?.etag).toBe('"empty-e"');
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
