/**
 * Cross-context constants shared by popup + service worker.
 *
 * Anything that needs to be referenced from BOTH the popup bundle and the
 * service-worker bundle lives here — keeps the two surfaces from importing
 * each other (which would create circular type graphs and bloated bundles).
 */

/** Key under which the user's GitHub PAT lives in IndexedDBKVStore. */
export const KV_KEY_PAT = 'github.pat';

/**
 * Key for the AI provider API key (chat + embed). The actual provider is
 * picked at runtime via `KV_KEY_AI_PROVIDER` — same key works for whichever
 * preset (SiliconFlow / DashScope / OpenAI) the user selects.
 *
 * Stored separately from the GitHub PAT so the user can configure or rotate
 * them independently; the popup UI gates "Build search index" / Auto-tag /
 * Digest / Deep-index on this being present.
 */
export const KV_KEY_AI_KEY = 'ai.apiKey';

/**
 * Key for the selected AI provider preset. Value is one of `AiPresetId`
 * (siliconflow / dashscope / openai). The popup reads this on every Build /
 * Search / Auto-tag / Digest invocation to look up the matching baseUrl +
 * chatModel + embedModel from `AI_PRESETS`.
 *
 * On first launch this is null; the dropdown defaults to `DEFAULT_AI_PRESET`
 * but doesn't persist until the user clicks Save.
 */
export const KV_KEY_AI_PROVIDER = 'ai.provider';

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
