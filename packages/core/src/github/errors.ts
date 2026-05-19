/**
 * GitHub API error taxonomy.
 *
 * Parallel design to @starkit/ai's AIError — distinct from generic Error so
 * callers can branch on `kind` without string-matching messages. Preserves
 * underlying cause via `cause`.
 */

export type GithubErrorKind =
  | 'auth'        // 401, 403 (when not rate_limit) — invalid PAT / missing scope
  | 'rate_limit'  // 403 with x-ratelimit-remaining: 0, or 429
  | 'not_found'   // 404 — endpoint or resource missing
  | 'validation'  // 422 — request shape rejected by GitHub
  | 'network'     // fetch failed before response
  | 'timeout'     // AbortError
  | 'server'      // 5xx
  | 'parse'       // 2xx but body didn't match schema
  | 'unknown';

export interface GithubErrorContext {
  readonly endpoint?: string;
  readonly statusCode?: number;
  /** Seconds until rate-limit reset, when known. */
  readonly rateLimitResetSeconds?: number;
  /** Remaining rate-limit budget when failure occurred. */
  readonly rateLimitRemaining?: number;
}

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly context: GithubErrorContext;

  constructor(
    kind: GithubErrorKind,
    message: string,
    context: GithubErrorContext = {},
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'GithubError';
    this.kind = kind;
    this.context = context;
    Object.setPrototypeOf(this, GithubError.prototype);
  }

  /**
   * Build a GithubError from an octokit-style error or generic thrown value.
   * Reads optional rate-limit headers from `err.response?.headers`.
   */
  static fromUnknown(err: unknown, context: GithubErrorContext = {}): GithubError {
    if (err instanceof GithubError) return err;

    if (err instanceof DOMException && err.name === 'AbortError') {
      return new GithubError('timeout', 'Request aborted', context, err);
    }

    if (err instanceof TypeError) {
      return new GithubError(
        'network',
        err.message || 'Network error',
        context,
        err
      );
    }

    // Octokit's fetch-wrapper wraps EVERY thrown fetch error as a synthetic
    // RequestError(status:500, cause:<original>). So a DNS failure surfaces
    // as status=500 unless we peek at `.cause` first.
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return new GithubError('timeout', cause.message || 'Request aborted', context, cause);
    }
    if (cause instanceof TypeError) {
      return new GithubError(
        'network',
        cause.message || 'Network error',
        context,
        cause
      );
    }

    // Duck-type octokit RequestError shape: { status, response: { headers } }
    const maybeRequestErr = err as {
      status?: unknown;
      message?: unknown;
      response?: { headers?: Record<string, string> };
    };
    const status =
      typeof maybeRequestErr.status === 'number' ? maybeRequestErr.status : undefined;
    if (status !== undefined) {
      const headers = maybeRequestErr.response?.headers ?? {};
      const remainingRaw = headers['x-ratelimit-remaining'];
      const resetRaw = headers['x-ratelimit-reset'];
      const remaining =
        typeof remainingRaw === 'string'
          ? Number.parseInt(remainingRaw, 10)
          : undefined;
      const reset =
        typeof resetRaw === 'string' ? Number.parseInt(resetRaw, 10) : undefined;
      const resetSecondsFromNow =
        reset !== undefined && Number.isFinite(reset)
          ? Math.max(0, reset - Math.floor(Date.now() / 1000))
          : undefined;

      const message =
        typeof maybeRequestErr.message === 'string'
          ? maybeRequestErr.message
          : `HTTP ${status}`;

      const enrichedContext: GithubErrorContext = {
        ...context,
        statusCode: status,
        ...(remaining !== undefined && Number.isFinite(remaining)
          ? { rateLimitRemaining: remaining }
          : {}),
        ...(resetSecondsFromNow !== undefined
          ? { rateLimitResetSeconds: resetSecondsFromNow }
          : {}),
      };

      const kind = mapStatusToKind(status, remaining);
      return new GithubError(kind, message, enrichedContext, err);
    }

    const msg = err instanceof Error ? err.message : String(err);
    return new GithubError('unknown', msg, context, err);
  }
}

function mapStatusToKind(
  status: number,
  rateLimitRemaining: number | undefined
): GithubErrorKind {
  if (status === 401) return 'auth';
  // GitHub returns 403 for BOTH bad auth scope AND rate limit. Disambiguate
  // using x-ratelimit-remaining: 0.
  if (status === 403) {
    if (rateLimitRemaining === 0) return 'rate_limit';
    return 'auth';
  }
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}
