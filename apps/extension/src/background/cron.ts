/**
 * Background sync logic — the pure function the service worker wakes up to.
 *
 * Lives outside service-worker.ts so it can be unit-tested in plain Node
 * (no chrome.* dependency). The service worker is reduced to thin wiring:
 *   onInstalled / onStartup → chrome.alarms.create(ALARM_NAME, ...)
 *   onAlarm matches ALARM_NAME → runScheduledSync()
 *
 * MV3 constraint: the service worker may be evicted after ~30s idle, so we
 * never rely on module-level state surviving wake-ups. The dbPromise
 * singleton here is per-wake — every time the worker spins back up we
 * re-open the IndexedDB connection (cheap; idb returns the existing
 * connection if already open in this realm).
 */
import {
  GithubError,
  IndexedDBCursorStore,
  IndexedDBKVStore,
  IndexedDBStarStore,
  createGithubClient,
  openStarKitDb,
  syncStarsWithStore,
  type StarKitDB,
  type SyncWithStoreResult,
} from '@starkit/core';
import { KV_KEY_PAT } from '../shared/keys.js';

export type ScheduledSyncSkipReason = 'no_pat';

export interface ScheduledSyncResult {
  readonly skipped: boolean;
  /** Set when `skipped === true`. */
  readonly reason?: ScheduledSyncSkipReason;
  /** Set when `skipped === false`. */
  readonly result?: SyncWithStoreResult;
}

export interface RunScheduledSyncOptions {
  readonly signal?: AbortSignal;
}

let dbPromise: Promise<StarKitDB> | null = null;
let dbNameOverride: string | undefined;

/**
 * Test seam — resets the cached connection AND lets tests target a unique
 * DB name so concurrent tests don't fight over the same IndexedDB instance.
 * Pass `undefined` to revert to the default 'starkit' name.
 */
export function __resetDbPromiseForTest(name?: string): void {
  dbPromise = null;
  dbNameOverride = name;
}

async function getDb(): Promise<StarKitDB> {
  if (!dbPromise) {
    dbPromise = openStarKitDb(dbNameOverride);
  }
  return dbPromise;
}

/**
 * One scheduled sync cycle:
 *   1. Look up the PAT in IndexedDB. No PAT → skip silently.
 *   2. Build a fresh octokit client (cheap) + reuse the open DB.
 *   3. Run the orchestrator. Result bubbles back.
 *
 * Errors from syncStarsWithStore (GithubError) propagate unchanged — the
 * service worker logs and moves on. We never auto-disable the alarm on
 * error because most errors (rate_limit, network) are transient.
 */
export async function runScheduledSync(
  opts: RunScheduledSyncOptions = {}
): Promise<ScheduledSyncResult> {
  const db = await getDb();
  const kvStore = new IndexedDBKVStore(db);
  const pat = await kvStore.get<string>(KV_KEY_PAT);
  if (!pat || pat.length === 0) {
    return { skipped: true, reason: 'no_pat' };
  }

  const starStore = new IndexedDBStarStore(db);
  const cursorStore = new IndexedDBCursorStore(db);
  const client = createGithubClient({
    token: pat,
    userAgent: '@starkit/extension(cron)',
  });

  const syncOpts: { signal?: AbortSignal } = {};
  if (opts.signal !== undefined) syncOpts.signal = opts.signal;

  try {
    const result = await syncStarsWithStore(
      client,
      { starStore, cursorStore },
      syncOpts
    );
    return { skipped: false, result };
  } catch (err) {
    // Re-throw GithubError unchanged so the caller can inspect .kind;
    // wrap anything else for traceability.
    if (err instanceof GithubError) throw err;
    throw err instanceof Error
      ? err
      : new Error(`Unknown cron failure: ${String(err)}`);
  }
}

/**
 * Format a one-line summary suitable for `console.info` from the service
 * worker. Exposed so the service-worker.ts wiring stays declarative.
 */
export function formatCronOutcome(outcome: ScheduledSyncResult): string {
  if (outcome.skipped) {
    return `cron skipped (${outcome.reason ?? 'unknown'})`;
  }
  const r = outcome.result!;
  if (r.notModified) {
    return `cron 304 not modified · ${r.knownCountAfter} stars`;
  }
  return `cron synced · ${r.inserted} new / ${r.updated} updated / ${r.deleted} removed / ${r.knownCountAfter} total`;
}
