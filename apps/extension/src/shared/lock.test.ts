import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __LOCK_KEY_FOR_TEST,
  __LOCK_TTL_MS_FOR_TEST,
  releaseSyncLock,
  tryAcquireSyncLock,
  withSyncLock,
  type SyncLockRecord,
} from './lock.js';

/**
 * Lightweight chrome.storage.local mock — a Map with the get/set/remove
 * shape chrome provides. Sufficient for the lock semantics; full chrome
 * Storage Promise behavior (eventOnChanged etc) is not exercised here.
 */
class FakeStorage {
  private readonly map = new Map<string, unknown>();
  async get(key: string): Promise<Record<string, unknown>> {
    return this.map.has(key) ? { [key]: this.map.get(key) } : {};
  }
  async set(obj: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  raw(): Map<string, unknown> {
    return this.map;
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('chrome', { storage: { local: storage } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── tryAcquireSyncLock ──────────────────────────────────────────────

describe('tryAcquireSyncLock', () => {
  it('returns true and writes the record when no lock exists', async () => {
    expect(await tryAcquireSyncLock('owner-a')).toBe(true);
    const record = storage.raw().get(__LOCK_KEY_FOR_TEST) as SyncLockRecord;
    expect(record.ownerId).toBe('owner-a');
    expect(Date.parse(record.acquiredAt)).toBeGreaterThan(0);
  });

  it('returns false when a fresh lock is held by another owner', async () => {
    await tryAcquireSyncLock('owner-a');
    expect(await tryAcquireSyncLock('owner-b')).toBe(false);
    // owner-a's record must still be in place
    expect((storage.raw().get(__LOCK_KEY_FOR_TEST) as SyncLockRecord).ownerId).toBe('owner-a');
  });

  it('takes over a stale lock (older than TTL) and rewrites with new ownerId', async () => {
    // Seed a stale lock by writing one and then advancing time past TTL.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
    await tryAcquireSyncLock('owner-old');
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z').getTime() + __LOCK_TTL_MS_FOR_TEST + 1000);

    expect(await tryAcquireSyncLock('owner-new')).toBe(true);
    expect((storage.raw().get(__LOCK_KEY_FOR_TEST) as SyncLockRecord).ownerId).toBe('owner-new');
  });

  it('treats negative-age (clock skew) locks as stale and takes them', async () => {
    // Manually seed a record with a future acquiredAt
    const future = new Date(Date.now() + 60_000).toISOString();
    await storage.set({
      [__LOCK_KEY_FOR_TEST]: { acquiredAt: future, ownerId: 'owner-future' },
    });
    expect(await tryAcquireSyncLock('owner-now')).toBe(true);
  });

  it('lets only ONE of two concurrent acquirers win (TOCTOU race)', async () => {
    // The race: cron + popup both read "no lock" before either writes.
    // chrome.storage.local has no compare-and-swap, so each acquirer must
    // confirm its own write survived before claiming ownership. Exactly one
    // caller may end up running the sync.
    const [a, b] = await Promise.all([
      tryAcquireSyncLock('owner-a'),
      tryAcquireSyncLock('owner-b'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // The surviving lock record must belong to whichever caller won.
    const winner = a ? 'owner-a' : 'owner-b';
    expect(
      (storage.raw().get(__LOCK_KEY_FOR_TEST) as SyncLockRecord).ownerId
    ).toBe(winner);
  });
});

// ─── releaseSyncLock ─────────────────────────────────────────────────

describe('releaseSyncLock', () => {
  it('removes the record when caller owns the lock', async () => {
    await tryAcquireSyncLock('owner-a');
    await releaseSyncLock('owner-a');
    expect(storage.raw().has(__LOCK_KEY_FOR_TEST)).toBe(false);
  });

  it('is a no-op when called by a non-owner (prevents accidental clobber)', async () => {
    await tryAcquireSyncLock('owner-a');
    await releaseSyncLock('owner-b');
    expect((storage.raw().get(__LOCK_KEY_FOR_TEST) as SyncLockRecord).ownerId).toBe('owner-a');
  });

  it('is a no-op when no lock exists', async () => {
    await expect(releaseSyncLock('owner-a')).resolves.toBeUndefined();
  });
});

// ─── withSyncLock ────────────────────────────────────────────────────

describe('withSyncLock', () => {
  it('runs fn and returns {ran:true, result} when lock free', async () => {
    const r = await withSyncLock('owner-a', async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    // Lock released after
    expect(storage.raw().has(__LOCK_KEY_FOR_TEST)).toBe(false);
  });

  it('returns {ran:false} without calling fn when lock held', async () => {
    await tryAcquireSyncLock('owner-other');
    const spy = vi.fn(async () => 'should-not-run');
    const r = await withSyncLock('owner-a', spy);
    expect(r).toEqual({ ran: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('releases the lock even when fn throws, and rethrows', async () => {
    const promise = withSyncLock('owner-a', async () => {
      throw new Error('boom');
    });
    await expect(promise).rejects.toThrow('boom');
    expect(storage.raw().has(__LOCK_KEY_FOR_TEST)).toBe(false);
  });
});
