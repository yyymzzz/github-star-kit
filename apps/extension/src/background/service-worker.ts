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

async function ensureSyncAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: SYNC_INTERVAL_MIN,
  });
  console.info(
    `[starkit] alarm '${ALARM_NAME}' scheduled (every ${SYNC_INTERVAL_MIN} min)`
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[starkit] installed', details.reason);
  ensureSyncAlarm().catch((err: unknown) =>
    console.warn('[starkit] alarm setup failed:', err)
  );
});

chrome.runtime.onStartup.addListener(() => {
  console.info('[starkit] browser startup');
  ensureSyncAlarm().catch((err: unknown) =>
    console.warn('[starkit] alarm setup failed:', err)
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void (async () => {
    try {
      const outcome = await runScheduledSync();
      console.info('[starkit]', formatCronOutcome(outcome));
    } catch (err) {
      console.warn('[starkit] sync failed:', err);
    }
  })();
});

export {}; // Make this file a module.
