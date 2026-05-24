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
import { IndexedDBVectorStore } from '@starkit/vector';

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
  /** Persistent vector index. Paired with a transient MemoryVectorStore at
   *  popup mount for hot search; both receive writes on embed (dual-upsert). */
  readonly vectorStore: IndexedDBVectorStore;
}

export async function getStores(): Promise<PopupStores> {
  const db = await getDb();
  return {
    db,
    starStore: new IndexedDBStarStore(db),
    cursorStore: new IndexedDBCursorStore(db),
    kvStore: new IndexedDBKVStore(db),
    vectorStore: new IndexedDBVectorStore(db),
  };
}

// PAT + AI provider config kv keys live in ../shared/keys.ts so the service
// worker can reference them without importing popup-specific React code.
// Re-exported here so existing popup imports keep working.
export {
  KV_KEY_PAT,
  KV_KEY_AI_KEY,
  KV_KEY_AI_PROVIDER,
  KV_KEY_LOCALE,
} from '../shared/keys.js';
