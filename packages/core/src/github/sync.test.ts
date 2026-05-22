import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GithubError } from './errors.js';
import { createGithubClient } from './client.js';
import { syncStars, transformStarred } from './sync.js';
import {
  installFetchMock,
  nextJson,
  nextNetworkError,
  nextNotModified,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';

const TOKEN = 'ghp_test_token';

/**
 * Build a sample GitHub `{starred_at, repo}` envelope. Repo defaults match
 * what the API actually returns; tests override the fields they care about.
 */
function sampleStar(overrides: {
  id?: number;
  fullName?: string;
  starredAt?: string;
  ownerLogin?: string;
  topics?: string[];
  archived?: boolean;
  fork?: boolean;
} = {}): unknown {
  const fullName = overrides.fullName ?? 'rust-lang/rust';
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    starred_at: overrides.starredAt ?? '2026-05-10T12:00:00Z',
    repo: {
      id: overrides.id ?? 12345,
      full_name: fullName,
      name,
      html_url: `https://github.com/${fullName}`,
      owner: {
        login: overrides.ownerLogin ?? owner,
        avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`,
      },
      description: 'desc',
      topics: overrides.topics ?? ['systems', 'compilers'],
      language: 'Rust',
      pushed_at: '2026-05-09T08:00:00Z',
      stargazers_count: 100,
      default_branch: 'master',
      archived: overrides.archived ?? false,
      fork: overrides.fork ?? false,
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

// ─── transformStarred ─────────────────────────────────────────────────

describe('transformStarred', () => {
  it('maps a full {starred_at, repo} envelope into StarredRepo', () => {
    const fetchedAt = '2026-05-19T10:00:00Z';
    const result = transformStarred(sampleStar({ id: 1, fullName: 'a/b' }), fetchedAt);
    expect(result.id).toBe(1);
    expect(result.fullName).toBe('a/b');
    expect(result.ownerLogin).toBe('a');
    expect(result.htmlUrl).toBe('https://github.com/a/b');
    expect(result.defaultBranch).toBe('master');
    expect(result.lastSyncedAt).toBe(fetchedAt);
    expect(result.aiTags).toEqual([]); // schema default applied
    expect(result.schemaVersion).toBe(1);
  });

  it('throws GithubError(parse) when starred_at envelope is missing', () => {
    expect(() => transformStarred({ no_envelope: true }, '2026-05-19T10:00:00Z')).toThrow(
      GithubError
    );
  });

  it('throws GithubError(parse) when repo fails schema validation', () => {
    try {
      transformStarred(sampleStar({ id: -1 }), '2026-05-19T10:00:00Z');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubError);
      expect((err as GithubError).kind).toBe('parse');
    }
  });

  it('maps pushed_at:null (never-pushed repo) to pushedAt:null instead of throwing', () => {
    // GitHub returns `pushed_at: null` for a repo that has never received a
    // push (freshly created, empty). One such starred repo must NOT abort the
    // entire sync via a schema-parse throw.
    const raw = sampleStar({ id: 7 }) as { repo: { pushed_at: unknown } };
    raw.repo.pushed_at = null;
    const result = transformStarred(raw, '2026-05-19T10:00:00Z');
    expect(result.pushedAt).toBeNull();
  });
});

// ─── syncStars ────────────────────────────────────────────────────────

describe('syncStars happy paths', () => {
  it('fetches a single page and returns mapped stars + etag', async () => {
    nextJson(fm, [sampleStar({ id: 1 }), sampleStar({ id: 2 })], {
      headers: { etag: '"abc123"' },
    });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client);

    expect(result.notModified).toBe(false);
    expect(result.stars).toHaveLength(2);
    expect(result.stars[0]?.id).toBe(1);
    expect(result.etag).toBe('"abc123"');
    expect(result.pageCount).toBe(1);
  });

  it('sends Accept: application/vnd.github.v3.star+json on first call', async () => {
    nextJson(fm, [sampleStar()]);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStars(client);

    const headers = fm.lastCall()!.init.headers as Headers | Record<string, string>;
    const accept =
      headers instanceof Headers
        ? headers.get('accept')
        : (headers as Record<string, string>)['accept'];
    expect(accept).toContain('application/vnd.github.v3.star+json');
  });

  it('sends If-None-Match when caller supplies a prior etag', async () => {
    nextJson(fm, [sampleStar()]);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStars(client, { etag: '"prev-etag"' });

    const headers = fm.lastCall()!.init.headers as Headers | Record<string, string>;
    const ifNoneMatch =
      headers instanceof Headers
        ? headers.get('if-none-match')
        : (headers as Record<string, string>)['if-none-match'];
    expect(ifNoneMatch).toBe('"prev-etag"');
  });

  it('paginates while Link header advertises rel="next"', async () => {
    // Page 1: 100 items + nextLink
    const page1 = Array.from({ length: 100 }, (_, i) => sampleStar({ id: i + 1 }));
    nextJson(fm, page1, {
      headers: { etag: '"e1"' },
      nextLink: 'https://api.github.com/user/starred?page=2',
    });
    // Page 2: 30 items, no next link
    const page2 = Array.from({ length: 30 }, (_, i) => sampleStar({ id: i + 101 }));
    nextJson(fm, page2);

    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { perPage: 100 });

    expect(result.stars).toHaveLength(130);
    expect(result.pageCount).toBe(2);
    expect(result.etag).toBe('"e1"'); // etag from page 1, not page 2
    expect(fm.calls()).toHaveLength(2);
  });
});

describe('syncStars ETag fast path', () => {
  it('returns notModified=true on 304 without paginating further', async () => {
    nextNotModified(fm);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { etag: '"prev"' });

    expect(result.notModified).toBe(true);
    expect(result.stars).toHaveLength(0);
    expect(result.etag).toBe('"prev"'); // preserved
    expect(result.pageCount).toBe(0);
    expect(fm.calls()).toHaveLength(1); // no extra pagination
  });

  it('replaces etag on 200 even when one was supplied', async () => {
    nextJson(fm, [sampleStar()], { headers: { etag: '"new-etag"' } });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { etag: '"old-etag"' });

    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('"new-etag"');
  });
});

describe('syncStars error mapping', () => {
  it('401 → GithubError kind=auth', async () => {
    nextJson(fm, { message: 'Bad credentials' }, { status: 401 });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(syncStars(client)).rejects.toMatchObject({
      kind: 'auth',
      context: { statusCode: 401 },
    });
  });

  it('403 with x-ratelimit-remaining:0 → GithubError kind=rate_limit', async () => {
    const futureReset = Math.floor(Date.now() / 1000) + 600; // 10 min from now
    nextJson(
      fm,
      { message: 'API rate limit exceeded' },
      {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(futureReset),
        },
      }
    );
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    try {
      await syncStars(client);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubError);
      const ge = err as GithubError;
      expect(ge.kind).toBe('rate_limit');
      expect(ge.context.rateLimitRemaining).toBe(0);
      expect(ge.context.rateLimitResetSeconds).toBeGreaterThan(500);
    }
  });

  it('403 without rate-limit headers → GithubError kind=auth (missing scope)', async () => {
    nextJson(fm, { message: 'Resource not accessible by personal access token' }, {
      status: 403,
    });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(syncStars(client)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('404 → GithubError kind=not_found', async () => {
    nextJson(fm, { message: 'Not Found' }, { status: 404 });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(syncStars(client)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('500 → GithubError kind=server (with retries:0 to keep test fast)', async () => {
    nextJson(fm, { message: 'Server error' }, { status: 500 });
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(syncStars(client)).rejects.toMatchObject({ kind: 'server' });
  });

  it('network TypeError → GithubError kind=network', async () => {
    nextNetworkError(fm, 'getaddrinfo ENOTFOUND api.github.com');
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await expect(syncStars(client)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('createGithubClient', () => {
  it('throws when token is empty', () => {
    expect(() => createGithubClient({ token: '' })).toThrow();
  });
});

describe('syncStars since cursor short-circuit', () => {
  it('stops at the first item strictly older than since (mid-page)', async () => {
    nextJson(
      fm,
      [
        sampleStar({ id: 3, starredAt: '2026-05-19T00:00:00Z' }),
        sampleStar({ id: 2, starredAt: '2026-05-17T00:00:00Z' }),
        sampleStar({ id: 1, starredAt: '2026-05-10T00:00:00Z' }), // strictly < since
      ]
    );
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { since: '2026-05-15T00:00:00Z' });
    expect(result.stars).toHaveLength(2);
    expect(result.stars.map((s) => s.id)).toEqual([3, 2]);
  });

  it('does not fetch the next page once a strictly-older row is hit', async () => {
    nextJson(
      fm,
      [
        sampleStar({ id: 3, starredAt: '2026-05-19T00:00:00Z' }),
        sampleStar({ id: 2, starredAt: '2026-05-10T00:00:00Z' }), // strictly < since
      ],
      { nextLink: 'https://api.github.com/user/starred?page=2' }
    );
    // page 2 NOT queued — if we accidentally fetch it, mock returns undefined
    // and the test will fail loudly.
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { since: '2026-05-15T00:00:00Z' });
    expect(result.stars.map((s) => s.id)).toEqual([3]);
    expect(fm.calls()).toHaveLength(1);
  });

  it('fetches normally when since is older than everything', async () => {
    nextJson(fm, [sampleStar({ id: 1, starredAt: '2026-05-19T00:00:00Z' })]);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { since: '2026-01-01T00:00:00Z' });
    expect(result.stars).toHaveLength(1);
  });

  it('returns a row whose starred_at EQUALS since (same-second stars are not lost)', async () => {
    // A row at exactly `since` is NOT necessarily already known: the user may
    // have starred it in the same wall-clock second as the prior high-water
    // mark. syncStars returns it; the store's id-keyed upsert dedupes the one
    // boundary row we already hold. A `<=` short-circuit here would silently
    // drop new same-second stars until the next full sync.
    nextJson(fm, [sampleStar({ id: 5, starredAt: '2026-05-15T00:00:00Z' })]);
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const result = await syncStars(client, { since: '2026-05-15T00:00:00Z' });
    expect(result.stars.map((s) => s.id)).toEqual([5]);
  });
});

describe('syncStars cancellation + input hygiene', () => {
  it('AbortController aborts mid-sync → GithubError kind=timeout', async () => {
    fm.fetchMock.mockImplementationOnce(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (!sig) return;
          if (sig.aborted) {
            return reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
          }
          sig.addEventListener('abort', () =>
            reject(sig.reason ?? new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    const controller = new AbortController();
    const promise = syncStars(client, { signal: controller.signal });
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('clamps perPage > 100 down to 100 (GitHub spec ceiling)', async () => {
    nextJson(fm, [sampleStar()], {});
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStars(client, { perPage: 999 });

    const url = fm.lastCall()!.url;
    expect(url).toMatch(/per_page=100/);
    expect(url).not.toMatch(/per_page=999/);
  });

  it('clamps perPage < 1 up to 1', async () => {
    nextJson(fm, [sampleStar()], {});
    const client = createGithubClient({ token: TOKEN, retries: 0 });
    await syncStars(client, { perPage: 0 });

    expect(fm.lastCall()!.url).toMatch(/per_page=1/);
  });
});
