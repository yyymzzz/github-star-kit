/**
 * GitHub `/user/starred` sync — the foundation under W2's "1000 stars
 * incremental sync, no data loss" demo gate.
 *
 * Strategy (Day 3):
 *   1. Send first page with `If-None-Match: <prevEtag>`.
 *   2. 304 → list unchanged; return `notModified: true` and no stars.
 *   3. 200 → record new ETag from page 1; manually paginate via Link header
 *      until exhausted (we keep paging in our hand so the ETag fast-path on
 *      page 1 can short-circuit before octokit.paginate would kick in).
 *   4. Map every raw `{starred_at, repo: {...}}` through StarredRepoSchema
 *      so the contract from packages/core/src/schema.ts is the only shape
 *      callers see — anything that fails validation is GithubError(parse).
 *
 * Out of scope (deferred to W2):
 *   - starred_at cursor short-circuit (early-exit when items < since)
 *   - persistent storage (IndexedDB / sqlite-vec)
 *   - cross-device merge
 */
import { z } from 'zod';
import { StarredRepoSchema, type StarredRepo } from '../schema.js';
import type { StarKitOctokitInstance } from './client.js';
import { GithubError } from './errors.js';

const STARRED_ACCEPT_HEADER = 'application/vnd.github.v3.star+json';
const DEFAULT_PER_PAGE = 100;

export interface SyncStarsOptions {
  /** Previous ETag for conditional GET. Pass null/undefined to force full fetch. */
  readonly etag?: string | null;
  /** Per-page count, max 100 per GitHub spec. */
  readonly perPage?: number;
  /** Cancel mid-sync. */
  readonly signal?: AbortSignal;
}

export interface SyncStarsResult {
  /** Empty when notModified=true. */
  readonly stars: ReadonlyArray<StarredRepo>;
  /** ETag to persist for next sync. Null if GitHub didn't send one. */
  readonly etag: string | null;
  /** True iff GitHub returned 304 on the first request. */
  readonly notModified: boolean;
  /** ISO timestamp of when the sync ran. Stamped on every fetched row. */
  readonly fetchedAt: string;
  /** How many HTTP pages we fetched. 0 when notModified=true. */
  readonly pageCount: number;
}

/**
 * Fetch all starred repos for the authenticated user. Honors ETag (304 fast
 * path) and paginates via Link headers.
 */
export async function syncStars(
  client: StarKitOctokitInstance,
  options: SyncStarsOptions = {}
): Promise<SyncStarsResult> {
  const fetchedAt = new Date().toISOString();
  // GitHub clamps per_page to [1, 100]; supplying 200 returns 422.
  // Defensive clamp so callers can pass whatever and we still negotiate
  // a valid request.
  const perPage = Math.min(Math.max(options.perPage ?? DEFAULT_PER_PAGE, 1), 100);
  const stars: StarredRepo[] = [];
  let etag: string | null = null;
  let page = 1;

  while (true) {
    try {
      const response = await client.request('GET /user/starred', {
        per_page: perPage,
        page,
        headers: {
          accept: STARRED_ACCEPT_HEADER,
          ...(page === 1 && options.etag ? { 'if-none-match': options.etag } : {}),
        },
        request: options.signal ? { signal: options.signal } : {},
      });

      if (page === 1) {
        const etagHeader = response.headers.etag;
        etag = typeof etagHeader === 'string' ? etagHeader : null;
      }

      const items = Array.isArray(response.data) ? response.data : [];
      for (const raw of items) {
        stars.push(transformStarred(raw, fetchedAt));
      }

      // Stop conditions: short page (< perPage means last) OR no `rel="next"`.
      if (items.length < perPage) break;
      const linkHeader = response.headers.link;
      if (typeof linkHeader !== 'string' || !/rel="next"/.test(linkHeader)) break;

      page += 1;
    } catch (err) {
      // Re-raise our own parse errors from transformStarred unchanged.
      if (err instanceof GithubError) throw err;

      const status = (err as { status?: number })?.status;
      // 304 surfaces as RequestError; treat as success-with-no-changes.
      if (page === 1 && status === 304) {
        return {
          stars: [],
          etag: options.etag ?? null,
          notModified: true,
          fetchedAt,
          pageCount: 0,
        };
      }
      throw GithubError.fromUnknown(err, { endpoint: 'GET /user/starred' });
    }
  }

  return { stars, etag, notModified: false, fetchedAt, pageCount: page };
}

/**
 * Map a `{starred_at, repo}` payload (from Accept: ...star+json) into our
 * StarredRepo schema. Validation errors are surfaced as GithubError(parse).
 */
export function transformStarred(raw: unknown, fetchedAt: string): StarredRepo {
  const r = raw as {
    starred_at?: unknown;
    repo?: {
      id?: unknown;
      full_name?: unknown;
      html_url?: unknown;
      owner?: { login?: unknown; avatar_url?: unknown };
      description?: unknown;
      topics?: unknown;
      language?: unknown;
      pushed_at?: unknown;
      stargazers_count?: unknown;
      default_branch?: unknown;
      archived?: unknown;
      fork?: unknown;
    };
  };
  if (!r.repo || typeof r.starred_at !== 'string') {
    throw new GithubError(
      'parse',
      'Starred item missing required {starred_at, repo} envelope',
      { endpoint: 'GET /user/starred' }
    );
  }
  const repo = r.repo;
  const candidate = {
    id: repo.id,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    ownerLogin: repo.owner?.login,
    ownerAvatarUrl: repo.owner?.avatar_url ?? null,
    description: repo.description ?? null,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    language: repo.language ?? null,
    starredAt: r.starred_at,
    pushedAt: repo.pushed_at,
    stargazersCount: repo.stargazers_count,
    defaultBranch: repo.default_branch ?? 'main',
    archived: repo.archived ?? false,
    isFork: repo.fork ?? false,
    lastSyncedAt: fetchedAt,
  };
  try {
    return StarredRepoSchema.parse(candidate);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new GithubError(
        'parse',
        `Starred item failed schema validation: ${err.issues
          .map((i) => `${i.path.join('.')}:${i.message}`)
          .join(', ')}`,
        { endpoint: 'GET /user/starred' },
        err
      );
    }
    throw err;
  }
}
