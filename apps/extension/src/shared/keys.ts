/**
 * Cross-context constants shared by popup + service worker.
 *
 * Anything that needs to be referenced from BOTH the popup bundle and the
 * service-worker bundle lives here — keeps the two surfaces from importing
 * each other (which would create circular type graphs and bloated bundles).
 */

/** Key under which the user's GitHub PAT lives in IndexedDBKVStore. */
export const KV_KEY_PAT = 'github.pat';

/** chrome.alarms name for the periodic sync schedule. */
export const ALARM_NAME = 'starkit-sync';

/**
 * Periodic sync interval, in minutes. 6h is a deliberate compromise:
 *   - long enough that 99% of users won't hit GitHub rate limits even with
 *     5000+ stars,
 *   - short enough that the W4 weekly-digest pipeline has fresh data when
 *     Monday morning rolls around.
 *
 * chrome.alarms enforces a 1-min minimum on Chrome 117+; 360 is well above.
 */
export const SYNC_INTERVAL_MIN = 360;
