/**
 * User-facing presentation helpers shared by every host surface (extension
 * popup, Obsidian plugin). These previously lived as copy-pasted functions in
 * each app and had already drifted apart (e.g. "5m ago" vs "5 min ago",
 * "Endpoint not found." vs "Endpoint not found (GitHub may have changed)."),
 * so they live here as the single source of truth.
 *
 * Pure functions over core types — no DOM, no framework — so both React and
 * Obsidian's imperative API can use them identically.
 */
import { GithubError, type GithubErrorKind } from './github/errors.js';
import type { SyncWithStoreResult } from './github/orchestrator.js';

/** Map a GithubError to a short, user-facing message. */
export function githubErrorMessage(err: GithubError): string {
  const messages: Record<GithubErrorKind, string> = {
    auth: 'GitHub rejected the token — check the PAT and its scope.',
    rate_limit:
      err.context.rateLimitResetSeconds !== undefined
        ? `GitHub rate limit hit. Try again in ~${Math.ceil(
            err.context.rateLimitResetSeconds / 60
          )} min.`
        : 'GitHub rate limit hit. Try again later.',
    not_found: 'Endpoint not found (GitHub may have changed).',
    validation: 'GitHub rejected the request shape.',
    network: 'Network failure — check your connection.',
    timeout: 'The request timed out.',
    server: 'GitHub returned a server error. Try again in a moment.',
    parse: 'Could not parse the GitHub response.',
    unknown: `Unknown failure: ${err.message}`,
  };
  return messages[err.kind];
}

/**
 * Turn any thrown value into a user-facing string: a GithubError becomes its
 * friendly message, any other Error yields its `.message`, and everything else
 * is stringified.
 */
export function formatError(err: unknown): string {
  if (err instanceof GithubError) return githubErrorMessage(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Fields of a sync result needed to render a one-line status summary. */
export type SyncSummaryInput = Pick<
  SyncWithStoreResult,
  'notModified' | 'inserted' | 'updated' | 'deleted' | 'knownCountAfter'
>;

/** One-line summary of a sync result for status UIs. */
export function formatSyncSummary(result: SyncSummaryInput): string {
  if (result.notModified) {
    return `Up to date · ${result.knownCountAfter} stars.`;
  }
  const parts: string[] = [];
  if (result.inserted > 0) parts.push(`${result.inserted} new`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.deleted > 0) parts.push(`${result.deleted} removed`);
  if (parts.length === 0) return `Synced · ${result.knownCountAfter} stars.`;
  return `${parts.join(' · ')} · ${result.knownCountAfter} total.`;
}

/**
 * Compact relative time: "just now" / "5m ago" / "3h ago" / "2d ago", falling
 * back to an ISO date (YYYY-MM-DD) beyond 30 days. An unparseable input is
 * returned unchanged. `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
