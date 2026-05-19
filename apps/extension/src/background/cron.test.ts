/**
 * Contract tests for the W2 scheduled-sync cron logic.
 *
 * fake-indexeddb polyfills globalThis.indexedDB so we can drive the same
 * IndexedDB adapter the production service worker uses, in plain Node.
 * fetch is stubbed per-test so we exercise the full octokit pipeline
 * without ever talking to api.github.com.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedDBKVStore,
  openStarKitDb,
} from '@starkit/core';
import { KV_KEY_PAT } from '../shared/keys.js';
import {
  __resetDbPromiseForTest,
  formatCronOutcome,
  runScheduledSync,
} from './cron.js';

/**
 * Each test gets a fresh DB name to dodge cross-test fake-indexeddb state
 * + the deleteDatabase-blocked-on-open-connection hang. Cheaper than
 * driving onblocked correctly.
 */
let dbCounter = 0;
let currentDbName = 'starkit';

async function seedPat(value: string): Promise<void> {
  const db = await openStarKitDb(currentDbName);
  await new IndexedDBKVStore(db).set(KV_KEY_PAT, value);
  db.close();
}

beforeEach(() => {
  dbCounter += 1;
  currentDbName = `starkit-test-${dbCounter}-${Date.now()}`;
  __resetDbPromiseForTest(currentDbName);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Skip paths ───────────────────────────────────────────────────────

describe('runScheduledSync — skip paths', () => {
  it('skips with reason="no_pat" when PAT key is absent', async () => {
    const r = await runScheduledSync();
    expect(r).toEqual({ skipped: true, reason: 'no_pat' });
  });

  it('skips when PAT is the empty string', async () => {
    await seedPat('');
    __resetDbPromiseForTest(currentDbName);
    const r = await runScheduledSync();
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_pat');
  });
});

// ─── Happy + error paths ──────────────────────────────────────────────

function starJson(id: number): unknown {
  return {
    starred_at: `2026-05-${String(id).padStart(2, '0')}T00:00:00Z`,
    repo: {
      id,
      full_name: `o${id}/r${id}`,
      name: `r${id}`,
      html_url: `https://github.com/o${id}/r${id}`,
      owner: { login: `o${id}`, avatar_url: 'https://avatars.example/1' },
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

describe('runScheduledSync — happy path', () => {
  it('runs syncStarsWithStore when PAT present and returns the result', async () => {
    await seedPat('ghp_test');
    __resetDbPromiseForTest(currentDbName);

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([starJson(1), starJson(2)]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: '"e1"',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await runScheduledSync();
    expect(r.skipped).toBe(false);
    expect(r.result?.inserted).toBe(2);
    expect(r.result?.knownCountAfter).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Sanity: the request actually went to /user/starred with PAT auth.
    // octokit's auth-token plugin emits `Authorization: token <pat>` for
    // classic PATs (vs `bearer` for JWTs). Use Headers for case-insensitive
    // lookup since octokit's fetch wrapper passes a plain Record.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/user/starred');
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get('authorization')).toBe('token ghp_test');
  });
});

describe('runScheduledSync — error propagation', () => {
  it('propagates GithubError(auth) on 401', async () => {
    await seedPat('ghp_invalid');
    __resetDbPromiseForTest(currentDbName);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    await expect(runScheduledSync()).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ─── formatCronOutcome ────────────────────────────────────────────────

describe('formatCronOutcome', () => {
  it('formats skip with reason', () => {
    expect(formatCronOutcome({ skipped: true, reason: 'no_pat' })).toBe(
      'cron skipped (no_pat)'
    );
  });

  it('formats 304 not-modified outcome', () => {
    const s = formatCronOutcome({
      skipped: false,
      result: {
        stars: [],
        etag: '"x"',
        notModified: true,
        fetchedAt: 't',
        pageCount: 0,
        inserted: 0,
        updated: 0,
        deleted: 0,
        knownCountAfter: 42,
      },
    });
    expect(s).toContain('304');
    expect(s).toContain('42');
  });

  it('formats a normal sync outcome with counts', () => {
    const s = formatCronOutcome({
      skipped: false,
      result: {
        stars: [],
        etag: '"x"',
        notModified: false,
        fetchedAt: 't',
        pageCount: 1,
        inserted: 5,
        updated: 3,
        deleted: 1,
        knownCountAfter: 10,
      },
    });
    expect(s).toContain('5 new');
    expect(s).toContain('3 updated');
    expect(s).toContain('1 removed');
    expect(s).toContain('10 total');
  });
});
