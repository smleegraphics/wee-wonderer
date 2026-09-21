// Load-once cache for the voxelized collision surface. Voxelizing a scan costs
// 100-500ms; we only want to pay it the first time a given scan (at given voxel
// params) is loaded. The surface arrays are stashed in IndexedDB — structured
// clone stores TypedArrays directly, and IndexedDB has no small size cap like
// localStorage. Cache misses / errors fall through to a fresh voxelization.

import type { VoxelSurface } from './voxelize';

const DB_NAME = 'wee-wonderer';
const STORE = 'voxel-surface';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Cache key: identity of the scan + everything that changes the surface. */
export function voxelCacheKey(file: string, voxelSize: number, minCount: number, targetRadius: number): string {
  return `${file}|v${voxelSize.toFixed(4)}|m${minCount}|r${targetRadius}`;
}

export async function voxelCacheGet(key: string): Promise<VoxelSurface | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as VoxelSurface) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // no IndexedDB (private mode, etc.) → always recompute
  }
}

export async function voxelCachePut(key: string, surface: VoxelSurface): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(surface, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* caching is best-effort; ignore write failures */
  }
}
