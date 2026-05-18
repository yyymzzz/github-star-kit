/**
 * MV3 background service worker — entry point.
 *
 * Day 1 status: scaffolding. Real responsibilities (sync cron, digest cron,
 * embedding pipeline) land W2-W4.
 *
 * Constraints under MV3:
 *  - Service worker is ephemeral (~30s idle timeout). NEVER store state in module
 *    globals — use chrome.storage.* or IndexedDB.
 *  - Use chrome.alarms for periodic work, NOT setInterval.
 */

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[starkit] installed', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.info('[starkit] browser startup');
});

// Placeholder alarm — actual cadences set up in W2 (sync) and W4 (digest).
chrome.alarms.onAlarm.addListener((alarm) => {
  console.info('[starkit] alarm fired', alarm.name);
});

export {}; // Make this file a module.
