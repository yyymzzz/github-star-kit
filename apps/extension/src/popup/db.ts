/**
 * IDB connection singleton for the popup context.
 *
 * The popup runs in its own document; opening the database here is
 * independent of the service worker (which gets its own connection in
 * W2 when chrome.alarms wires up). Both contexts target the same
 * named DB so the same rows are visible to either side.
 *
 * We cache the open promise so React's StrictMode double-mount in dev
 * doesn't race two parallel opens.
 */
import {
  IndexedDBCursorStore,
  IndexedDBKVStore,
  IndexedDBStarStore,
  openStarKitDb,
  type StarKitDB,
} from '@starkit/core';

let dbPromise: Promise<StarKitDB> | null = null;

export function getDb(): Promise<StarKitDB> {
  if (!dbPromise) {
    dbPromise = openStarKitDb();
  }
  return dbPromise;
}

export interface PopupStores {
  readonly db: StarKitDB;
  readonly starStore: IndexedDBStarStore;
  readonly cursorStore: IndexedDBCursorStore;
  readonly kvStore: IndexedDBKVStore;
}

export async function getStores(): Promise<PopupStores> {
  const db = await getDb();
  return {
    db,
    starStore: new IndexedDBStarStore(db),
    cursorStore: new IndexedDBCursorStore(db),
    kvStore: new IndexedDBKVStore(db),
  };
}

// PAT kv key now lives in ../shared/keys.ts so the service worker can
// reference it without importing popup-specific React code. Re-export keeps
// existing popup imports working unchanged.
export { KV_KEY_PAT } from '../shared/keys.js';
