/**
 * @starkit/core/storage — barrel.
 *
 * Default exports are the in-memory implementations so tests and CLIs that
 * import `@starkit/core` get a working store with no host-platform setup.
 * IndexedDB and sqlite-vec adapters import the interfaces from `./types`
 * and live in the host packages.
 */
export type {
  KVStore,
  StarStore,
  StarStoreListOptions,
  StarStoreUpsertResult,
  CursorStore,
} from './types.js';
export {
  KVStoreMemory,
  StarStoreMemory,
  CursorStoreMemory,
} from './memory.js';
export {
  openStarKitDb,
  IndexedDBStarStore,
  IndexedDBKVStore,
  IndexedDBCursorStore,
} from './idb.js';
export type { StarKitDB, StarKitDBSchema, IDBVectorRecord } from './idb.js';
