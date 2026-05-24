/**
 * MV3 background service worker — entry point (W2 Day 1).
 *
 * Responsibilities:
 *  - On install / browser startup, create the periodic sync alarm.
 *  - When the alarm fires, delegate to runScheduledSync() and log outcome.
 *  - All real logic lives in ./cron.ts (testable in plain Node).
 *
 * MV3 constraints:
 *  - Service worker is ephemeral (~30s idle timeout). NEVER store state in
 *    module globals — use chrome.storage.* or IndexedDB.
 *  - Use chrome.alarms for periodic work, NOT setInterval.
 *
 * W4 will add a second alarm (digest schedule) wired the same way.
 */
import { ALARM_NAME, SYNC_INTERVAL_MIN } from '../shared/keys.js';
import { formatCronOutcome, runScheduledSync } from './cron.js';

/**
 * Gate informational logging on the Vite-injected `import.meta.env.DEV` flag.
 * Errors / warnings always print — they signal real problems users may need
 * to debug. Routine "alarm fired, sync 304" chatter only prints in dev so
 * production users don't see console noise. R10 蓝军 fix #12.
 */
const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) console.info(...args);
};

async function ensureSyncAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: SYNC_INTERVAL_MIN,
  });
  devLog(
    `[starkit] alarm '${ALARM_NAME}' scheduled (every ${SYNC_INTERVAL_MIN} min)`
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  devLog('[starkit] installed', details.reason);
  ensureSyncAlarm().catch((err: unknown) =>
    console.warn('[starkit] alarm setup failed:', err)
  );
});

chrome.runtime.onStartup.addListener(() => {
  devLog('[starkit] browser startup');
  ensureSyncAlarm().catch((err: unknown) =>
    console.warn('[starkit] alarm setup failed:', err)
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void (async () => {
    try {
      const outcome = await runScheduledSync();
      devLog('[starkit]', formatCronOutcome(outcome));
    } catch (err) {
      console.warn('[starkit] sync failed:', err);
    }
  })();
});

export {}; // Make this file a module.
