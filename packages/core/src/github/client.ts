/**
 * Octokit client factory.
 *
 * Wraps @octokit/core with the three plugins we need:
 *   - paginateRest  — `.paginate()` helper for /user/starred and friends
 *   - retry         — auto-retry on transient 5xx/408/timeout
 *   - throttling    — back off on primary + secondary rate limits
 *
 * Callers receive a `StarKitOctokitInstance` typed against these plugins so
 * code in sync.ts knows `.paginate()` exists without re-augmenting types.
 */
import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

const StarKitOctokit = Octokit.plugin(paginateRest, retry, throttling);

export type StarKitOctokitInstance = InstanceType<typeof StarKitOctokit>;

export interface CreateGithubClientOptions {
  /** PAT (classic or fine-grained). Required — v1 is BYOK, no OAuth. */
  readonly token: string;
  /** UA string for GitHub's traffic dashboard. */
  readonly userAgent?: string;
  /** Override for GitHub Enterprise Server (e.g. https://github.acme.com/api/v3). */
  readonly baseUrl?: string;
  /**
   * Optional fetch override — primarily for tests, where we want octokit's
   * full retry/throttling pipeline but a controlled HTTP layer.
   */
  readonly fetch?: typeof fetch;
  /**
   * Number of automatic retries on transient errors. Defaults to octokit's
   * own default (3). Set to 0 to disable — useful in tests where you don't
   * want each 5xx case to take ~9s of backoff.
   */
  readonly retries?: number;
}

export function createGithubClient(
  opts: CreateGithubClientOptions
): StarKitOctokitInstance {
  if (!opts.token) {
    throw new Error('createGithubClient: token is required (BYOK)');
  }
  return new StarKitOctokit({
    auth: opts.token,
    userAgent: opts.userAgent ?? '@starkit/core',
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
    ...(opts.retries !== undefined ? { retry: { retries: opts.retries } } : {}),
    throttle: {
      onRateLimit: (_retryAfter, _options, _octokit, _retryCount) => {
        // Never auto-retry. The throttle plugin's "retry once" path waits
        // `x-ratelimit-reset - now` seconds before retrying — that can be
        // 10+ minutes and is the wrong UX. Bubble the error to the caller
        // so the popup/plugin can show a "rate limit hit, resets in N min"
        // banner with the retryAfter context that GithubError already carries.
        return false;
      },
      onSecondaryRateLimit: (_retryAfter, _options, _octokit) => {
        // Secondary (abuse) limit: never auto-retry either — same reasoning.
        return false;
      },
    },
  });
}
