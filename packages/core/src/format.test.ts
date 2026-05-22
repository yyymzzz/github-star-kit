import { describe, expect, it } from 'vitest';
import { GithubError, type GithubErrorKind } from './github/errors.js';
import {
  formatError,
  formatRelativeTime,
  formatSyncSummary,
  githubErrorMessage,
} from './format.js';

describe('githubErrorMessage', () => {
  it('maps every error kind to a distinct, non-empty user-facing string', () => {
    const kinds: GithubErrorKind[] = [
      'auth',
      'rate_limit',
      'not_found',
      'validation',
      'network',
      'timeout',
      'server',
      'parse',
      'unknown',
    ];
    const seen = new Set<string>();
    for (const kind of kinds) {
      const msg = githubErrorMessage(new GithubError(kind, 'raw'));
      expect(msg.length).toBeGreaterThan(0);
      seen.add(msg);
    }
    expect(seen.size).toBe(kinds.length);
  });

  it('includes the reset window for rate_limit when known', () => {
    const msg = githubErrorMessage(
      new GithubError('rate_limit', 'x', { rateLimitResetSeconds: 120 })
    );
    expect(msg).toMatch(/~2 min/);
  });

  it('falls back to a generic rate_limit message when reset is unknown', () => {
    const msg = githubErrorMessage(new GithubError('rate_limit', 'x'));
    expect(msg).toMatch(/again later/i);
  });
});

describe('formatError', () => {
  it('uses githubErrorMessage for a GithubError', () => {
    expect(formatError(new GithubError('auth', 'x'))).toBe(
      githubErrorMessage(new GithubError('auth', 'x'))
    );
  });

  it('uses .message for a plain Error', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(formatError('weird')).toBe('weird');
  });
});

describe('formatSyncSummary', () => {
  it('reports up-to-date on notModified', () => {
    expect(
      formatSyncSummary({
        notModified: true,
        inserted: 0,
        updated: 0,
        deleted: 0,
        knownCountAfter: 42,
      })
    ).toBe('Up to date · 42 stars.');
  });

  it('lists new/updated/removed parts with the total', () => {
    expect(
      formatSyncSummary({
        notModified: false,
        inserted: 2,
        updated: 1,
        deleted: 3,
        knownCountAfter: 50,
      })
    ).toBe('2 new · 1 updated · 3 removed · 50 total.');
  });

  it('reports a plain synced line when nothing changed', () => {
    expect(
      formatSyncSummary({
        notModified: false,
        inserted: 0,
        updated: 0,
        deleted: 0,
        knownCountAfter: 7,
      })
    ).toBe('Synced · 7 stars.');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-05-20T12:00:00Z');

  it('returns "just now" under a minute', () => {
    expect(formatRelativeTime('2026-05-20T11:59:30Z', now)).toBe('just now');
  });

  it('buckets minutes / hours / days', () => {
    expect(formatRelativeTime('2026-05-20T11:30:00Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-05-20T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-05-18T12:00:00Z', now)).toBe('2d ago');
  });

  it('falls back to an ISO date beyond 30 days', () => {
    expect(formatRelativeTime('2026-01-01T00:00:00Z', now)).toBe('2026-01-01');
  });

  it('passes an unparseable timestamp through unchanged', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date');
  });
});
