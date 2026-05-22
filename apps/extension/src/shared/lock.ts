/**
 * Cross-context sync mutex (chrome.storage.local).
 *
 * Why: the popup and the service-worker can both invoke
 * syncStarsWithStore — the popup when the user clicks Sync, the SW when
 * its 6h chrome.alarms fires. Without a lock, both paths race for the
 * same GitHub quota and IndexedDB transaction window. The lock is
 * advisory (chrome.storage has no atomic compare-and-swap), so a tight
 * concurrent acquisition can in theory both succeed — but the chance
 * of two acquires lining up inside ~10ms is vanishingly small under
 * 6h cron + user-driven sync.
 *
 * Stale-lock recovery: any lock older than LOCK_TTL_MS is treated as
 * abandoned (e.g. service worker was evicted mid-sync) and the new
 * caller takes it.
 */

const LOCK_KEY = 'sync.lock';
/** Stale-lock threshold (ms). 2 minutes is well above worst-case sync
 *  duration (1000 stars ~3s; 10000 stars ~30s) but short enough to
 *  recover from a crashed-service-worker scenario quickly. */
const LOCK_TTL_MS = 2 * 60 * 1000;

export interface SyncLockRecord {
  /** ISO timestamp when lock was acquired. */
  readonly acquiredAt: string;
  /** Caller identifier — for diagnostics + ownership check on release. */
  readonly ownerId: string;
  /**
   * Per-acquisition random token. chrome.storage.local has no atomic
   * compare-and-swap, so an acquirer writes its record then re-reads: if its
   * nonce survived, its write was the last one and it owns the lock; if a
   * concurrent acquirer wrote after it, that nonce wins and this caller backs
   * off. Distinguishes two acquisitions even when they share an ownerId.
   */
  readonly nonce: string;
}

async function readLock(): Promise<SyncLockRecord | undefined> {
  const data = await chrome.storage.local.get(LOCK_KEY);
  return (data[LOCK_KEY] as SyncLockRecord | undefined) ?? undefined;
}

/**
 * Best-effort lock acquisition. Returns true when the caller now owns the
 * lock; false when another caller holds an active (non-stale) one.
 */
export async function tryAcquireSyncLock(ownerId: string): Promise<boolean> {
  const existing = await readLock();
  if (existing) {
    const age = Date.now() - Date.parse(existing.acquiredAt);
    // Only honor locks that look fresh AND well-formed (positive age).
    // Negative age (clock skew) is treated as stale.
    if (Number.isFinite(age) && age >= 0 && age < LOCK_TTL_MS) {
      return false;
    }
  }
  const record: SyncLockRecord = {
    acquiredAt: new Date().toISOString(),
    ownerId,
    nonce: crypto.randomUUID(),
  };
  await chrome.storage.local.set({ [LOCK_KEY]: record });

  // Compare-and-swap surrogate: re-read and confirm our write was the last
  // one. If a concurrent acquirer's write landed after ours, its nonce is
  // what we'll read back — we lost the race and must NOT proceed (the winner
  // owns the lock). chrome.storage serializes writes, so there is exactly one
  // last writer. This closes the common cron+popup correlated-timing race;
  // it is still best-effort (no true CAS exists for chrome.storage), but a
  // double-acquire now requires a far narrower interleaving than read-then-set.
  const confirmed = await readLock();
  return confirmed?.nonce === record.nonce;
}

/**
 * Drop the lock IF the caller is its current owner. No-op when the lock
 * is missing or owned by someone else — prevents a stale-take by caller A
 * from being clobbered when caller B (who failed to acquire) calls release
 * defensively.
 */
export async function releaseSyncLock(ownerId: string): Promise<void> {
  const existing = await readLock();
  if (!existing || existing.ownerId !== ownerId) return;
  await chrome.storage.local.remove(LOCK_KEY);
}

export interface WithSyncLockOutcome<T> {
  /** True if fn ran; false if the lock was already held by another owner. */
  readonly ran: boolean;
  /** Set when ran=true. */
  readonly result?: T;
}

/**
 * Acquire-run-release wrapper. Releases even when fn throws (rethrows
 * the error afterward). When the lock is unavailable, returns
 * `{ ran: false }` without calling fn.
 */
export async function withSyncLock<T>(
  ownerId: string,
  fn: () => Promise<T>
): Promise<WithSyncLockOutcome<T>> {
  const acquired = await tryAcquireSyncLock(ownerId);
  if (!acquired) return { ran: false };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await releaseSyncLock(ownerId);
  }
}

// Re-exported for tests that want to assert lock contents.
export const __LOCK_KEY_FOR_TEST = LOCK_KEY;
export const __LOCK_TTL_MS_FOR_TEST = LOCK_TTL_MS;
