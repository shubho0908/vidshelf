// Local thumbnail store: IndexedDB on every platform (WKWebView, Android
// WebView, webOS Chromium). One record per thumbnail, keyed by thumbId.
// Writes are single-transaction puts -> atomic by construction; the entry
// metadata (thumbId) is only saved after the blob write resolves.
// Queues for cloud upload/delete live in localStorage and drain during sync.

const DB_NAME = "vidshelf-thumbs";
const STORE = "thumbs";
const DIRTY_KEY = "vidshelf.thumbs.dirty.v1"; // thumbIds pending cloud upload
const DEL_KEY = "vidshelf.thumbs.delete.v1"; // thumbIds pending cloud delete

export interface ThumbRec {
  id: string;
  blob: Blob;
  v: number;
  mime: string;
  /** LRU clock for cache eviction (ms epoch). */
  lastView: number;
}

/** Hard ceiling for the local thumbnail cache (~1500 thumbs at ~100KB).
 *  Only CUSTOM uploads live here; provider thumbnails (i.ytimg.com etc.)
 *  are never persisted - the webview HTTP cache owns those. R2 stays the
 *  durable copy, so evicted thumbs re-download on demand. */
export const CACHE_MAX_BYTES = 150 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error("IndexedDB unavailable"));
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error ?? new Error("idb error"));
        t.onerror = () => rej(t.error ?? new Error("idb tx error"));
      })
  );
}

export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function putThumb(rec: Omit<ThumbRec, "lastView"> & { lastView?: number }): Promise<void> {
  await tx("readwrite", (s) => s.put({ ...rec, lastView: rec.lastView ?? Date.now() }));
}

async function allThumbs(): Promise<ThumbRec[]> {
  return tx<ThumbRec[]>("readonly", (s) => s.getAll() as IDBRequest<ThumbRec[]>);
}

export async function getThumb(id: string): Promise<ThumbRec | null> {
  const r = await tx<ThumbRec | undefined>("readonly", (s) => s.get(id) as IDBRequest<ThumbRec | undefined>);
  return r ?? null;
}

export async function deleteThumb(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

export async function listThumbIds(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
  return keys.map(String);
}

// --- dirty / delete queues -------------------------------------------------

export function readThumbDirty(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DIRTY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function writeThumbDirty(ids: string[]): void {
  localStorage.setItem(DIRTY_KEY, JSON.stringify(ids));
}
export function markThumbDirty(id: string): void {
  const d = readThumbDirty();
  if (!d.includes(id)) {
    d.push(id);
    writeThumbDirty(d);
  }
}
export function clearThumbDirty(ids: string[]): void {
  writeThumbDirty(readThumbDirty().filter((x) => !ids.includes(x)));
}

export function readThumbDeletes(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEL_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function writeThumbDeletes(ids: string[]): void {
  localStorage.setItem(DEL_KEY, JSON.stringify(ids));
}
/** Enqueue a remote delete and purge locally right away. */
export async function retireThumb(id: string): Promise<void> {
  const d = readThumbDeletes();
  if (!d.includes(id)) {
    d.push(id);
    writeThumbDeletes(d);
  }
  clearThumbDirty([id]); // a deleted thumb should never upload
  await deleteThumb(id).catch(() => undefined);
}
export function clearThumbDeletes(ids: string[]): void {
  writeThumbDeletes(readThumbDeletes().filter((x) => !ids.includes(x)));
}

// --- object URLs + orphan sweep -------------------------------------------

const urlCache = new Map<string, string>();

/** Blob URL for a locally stored thumb, or null when absent. */
export async function thumbUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit) return hit;
  const rec = await getThumb(id).catch(() => null);
  if (!rec) return null;
  // Touch the LRU clock (hour granularity - avoids write churn per render).
  if (Date.now() - (rec.lastView ?? 0) > 3600_000) {
    void putThumb({ ...rec, lastView: Date.now() }).catch(() => undefined);
  }
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(id, url);
  return url;
}

/** Evict least-recently-viewed thumbs until the cache fits the ceiling.
 *  Referenced thumbs may be evicted too - they re-fetch from R2 lazily. */
export async function evictThumbCache(maxBytes = CACHE_MAX_BYTES): Promise<number> {
  const all = await allThumbs().catch(() => [] as ThumbRec[]);
  let total = 0;
  for (const r of all) total += r.blob?.size ?? 0;
  if (total <= maxBytes) return 0;
  all.sort((a, b) => (a.lastView ?? 0) - (b.lastView ?? 0));
  let evicted = 0;
  for (const r of all) {
    if (total <= maxBytes) break;
    await deleteThumb(r.id).catch(() => undefined);
    const u = urlCache.get(r.id);
    if (u) {
      URL.revokeObjectURL(u);
      urlCache.delete(r.id);
    }
    total -= r.blob?.size ?? 0;
    evicted++;
  }
  return evicted;
}

/** Delete any locally stored thumb no entry references anymore. */
export async function sweepLocalOrphans(referenced: Set<string>): Promise<number> {
  const ids = await listThumbIds().catch(() => [] as string[]);
  let n = 0;
  for (const id of ids) {
    if (!referenced.has(id)) {
      await deleteThumb(id).catch(() => undefined);
      const u = urlCache.get(id);
      if (u) {
        URL.revokeObjectURL(u);
        urlCache.delete(id);
      }
      n++;
    }
  }
  return n;
}

export function newThumbId(): string {
  return "t_" + (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
}
