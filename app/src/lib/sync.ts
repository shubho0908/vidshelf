// Local-first sync against the VidShelf Cloudflare Worker.
// Design goals: localStorage is ALWAYS the read path; D1 chatter stays tiny.
//  - push: only dirty entries + new tombstones, one POST
//  - pull: once per app open, or manual; one GET
//  - writes debounced (no per-keystroke traffic)
import { SYNC_KEY, SYNC_URL } from "../config";
import { allThumbIds, library, readDirty, readTombstones, writeDirty, type Entry } from "./storage";
import {
  clearThumbDeletes, clearThumbDirty, evictThumbCache, getThumb, putThumb,
  readThumbDeletes, readThumbDirty, sweepLocalOrphans,
} from "./thumbstore";

const CFG_KEY = "vidshelf.sync.cfg.v1";
const META_KEY = "vidshelf.sync.meta.v1";

export interface SyncConfig {
  url: string; // worker base URL, e.g. https://vidshelf-sync.<sub>.workers.dev
  key: string; // shared passphrase
}

export function getSyncConfig(): SyncConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) ?? "null") as SyncConfig | null;
    if (c && c.url && c.key) return c; // user override wins
  } catch { /* fall through to defaults */ }
  if (!SYNC_KEY) return null; // web build ships without a key - user enters it once
  return { url: SYNC_URL, key: SYNC_KEY };
}
export function hasCustomSyncConfig(): boolean {
  return localStorage.getItem(CFG_KEY) !== null;
}
export function setSyncConfig(c: SyncConfig | null): void {
  if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
  else localStorage.removeItem(CFG_KEY);
}
export function lastSyncAt(): number {
  try {
    return (JSON.parse(localStorage.getItem(META_KEY) ?? "{}") as { at?: number }).at ?? 0;
  } catch {
    return 0;
  }
}
function setLastSyncAt(at: number): void {
  localStorage.setItem(META_KEY, JSON.stringify({ at }));
}

export type SyncResult =
  | { ok: true; pushed: number; pulled: number; thumbs: number }
  | { ok: false; reason: "off" | "network" | "auth" };

// --- thumbnail blob sync (R2 via worker; metadata rides the entry JSON) ----

const THUMB_GRACE_MS = 24 * 60 * 60 * 1000; // protect other devices' in-flight uploads

async function pushThumbDeletions(cfg: SyncConfig): Promise<void> {
  const ids = readThumbDeletes();
  if (!ids.length) return;
  const res = await fetch(cfg.url + "/thumb-deletions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Key": cfg.key },
    body: JSON.stringify({ ids }),
  });
  if (res.ok) clearThumbDeletes(ids);
  else if (res.status !== 503) throw new Error("thumb delete failed"); // 503 = R2 not bound yet; retry next sync
}

async function pushDirtyThumbs(cfg: SyncConfig): Promise<number> {
  const done: string[] = [];
  for (const id of readThumbDirty()) {
    const rec = await getThumb(id).catch(() => null);
    if (!rec) { done.push(id); continue; } // gone locally (retired) - drop from queue
    const res = await fetch(cfg.url + "/thumb/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": rec.mime || "image/webp", "X-Sync-Key": cfg.key },
      body: rec.blob,
    });
    if (res.status === 503) break; // bucket not bound yet - keep queue, retry later
    if (!res.ok) throw new Error("thumb upload failed");
    done.push(id);
  }
  if (done.length) clearThumbDirty(done);
  return done.length;
}

/** Ensure a thumbnail blob is local at the given version; fetches from the
 *  worker when missing or stale. Returns true when local afterwards. */
export async function ensureThumbLocal(id: string, v: number): Promise<boolean> {
  const cfg = getSyncConfig();
  if (!cfg) return false;
  const rec = await getThumb(id).catch(() => null);
  if (rec && rec.v >= v) return true;
  try {
    const res = await fetch(cfg.url + "/thumb/" + encodeURIComponent(id), { headers: { "X-Sync-Key": cfg.key } });
    if (!res.ok) return false;
    const blob = await res.blob();
    await putThumb({ id, blob, v, mime: blob.type || "image/webp" });
    return true;
  } catch {
    return false;
  }
}

async function pullThumbs(): Promise<number> {
  let n = 0;
  for (const e of library.list()) {
    if (e.thumbId && (await ensureThumbLocal(e.thumbId, e.thumbV ?? 1))) n++;
    for (const v of e.videos) {
      if (v.thumbId && (await ensureThumbLocal(v.thumbId, v.thumbV ?? 1))) n++;
    }
  }
  return n;
}

/** Remote orphan sweep: delete R2 objects no entry references, older than the
 *  grace window. Local sweep: same rule against IndexedDB. */
async function sweepOrphans(cfg: SyncConfig): Promise<void> {
  const referenced = allThumbIds(library.list());
  await sweepLocalOrphans(referenced).catch(() => 0);
  await evictThumbCache().catch(() => 0);
  try {
    const res = await fetch(cfg.url + "/thumb-index", { headers: { "X-Sync-Key": cfg.key } });
    if (!res.ok) return;
    const idx = (await res.json()) as { thumbs: { id: string; uploaded: number }[] };
    const cutoff = Date.now() - THUMB_GRACE_MS;
    for (const t of idx.thumbs ?? []) {
      if (!referenced.has(t.id) && t.uploaded < cutoff) {
        await fetch(cfg.url + "/thumb/" + encodeURIComponent(t.id), { method: "DELETE", headers: { "X-Sync-Key": cfg.key } }).catch(() => undefined);
      }
    }
  } catch { /* sweep is best-effort */ }
}

function applyRemote(entries: Entry[], tombstones: Record<string, number>): number {
  const local = new Map(library.list().map((e) => [e.id, e]));
  const localTombs = readTombstones();
  let changed = 0;
  for (const [id, ts] of Object.entries(tombstones)) {
    const le = local.get(id);
    const lt = localTombs[id];
    if (le && le.updatedAt < ts) {
      local.delete(id);
      changed++;
    }
    if (!lt || lt < ts) localTombs[id] = ts;
  }
  for (const e of entries) {
    if (!e || !e.id || !Array.isArray(e.videos)) continue;
    const tomb = localTombs[e.id];
    if (tomb && tomb >= e.updatedAt) continue; // deleted wins
    const le = local.get(e.id);
    if (!le || le.updatedAt < e.updatedAt) {
      local.set(e.id, e);
      changed++;
    }
  }
  if (changed) {
    localStorage.setItem(
      "vidshelf.library.v1",
      JSON.stringify([...local.values()])
    );
  }
  localStorage.setItem("vidshelf.tombstones.v1", JSON.stringify(localTombs));
  return changed;
}

export async function syncNow(): Promise<SyncResult> {
  const cfg = getSyncConfig();
  if (!cfg) return { ok: false, reason: "off" };
  try {
    // 1) push deltas (dirty entries + all known tombstones; server dedupes)
    const dirty = readDirty();
    const all = library.list();
    const dirtyEntries = all.filter((e) => dirty.has(e.id));
    if (dirty.size) {
      const res = await fetch(cfg.url + "/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sync-Key": cfg.key },
        body: JSON.stringify({ entries: dirtyEntries, tombstones: readTombstones() }),
      });
      if (res.status === 401) return { ok: false, reason: "auth" };
      if (!res.ok) return { ok: false, reason: "network" };
      writeDirty(new Set()); // server accepted; clear dirty
    }
    // thumbnail blobs follow metadata: deletes first (frees storage), then uploads
    await pushThumbDeletions(cfg);
    const thumbsUp = await pushDirtyThumbs(cfg);
    // 2) pull full state (library is small - one cheap read query)
    const res = await fetch(cfg.url + "/pull", { headers: { "X-Sync-Key": cfg.key } });
    if (res.status === 401) return { ok: false, reason: "auth" };
    if (!res.ok) return { ok: false, reason: "network" };
    const data = (await res.json()) as { entries: Entry[]; tombstones: Record<string, number> };
    const pulled = applyRemote(data.entries ?? [], data.tombstones ?? {});
    const thumbsDown = await pullThumbs();
    await sweepOrphans(cfg);
    setLastSyncAt(Date.now());
    return { ok: true, pushed: dirtyEntries.length, pulled, thumbs: thumbsUp + thumbsDown };
  } catch {
    return { ok: false, reason: "network" };
  }
}

// Debounced sync after local mutations: one push per burst of edits.
let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSync(onDone?: (r: SyncResult) => void): void {
  if (!getSyncConfig()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow().then((r) => onDone?.(r));
  }, 2500);
}

// --- device pairing (6-char code flow) ---------------------------------------
export interface PairStart { code: string; token: string; expiresIn: number }

export async function pairStart(): Promise<PairStart | null> {
  try {
    const r = await fetch(SYNC_URL + "/pair/start", { method: "POST" });
    if (!r.ok) return null;
    const j = (await r.json()) as { code: string; token: string; expires_in: number };
    return { code: j.code, token: j.token, expiresIn: j.expires_in };
  } catch { return null; }
}

export type PairPollState = "pending" | "approved" | "expired" | "error";
export async function pairStatus(token: string): Promise<{ state: PairPollState; key?: string }> {
  try {
    const r = await fetch(SYNC_URL + "/pair/status?token=" + encodeURIComponent(token));
    if (!r.ok) return { state: "error" };
    const j = (await r.json()) as { status: string; key?: string };
    if (j.status === "approved" && j.key) return { state: "approved", key: j.key };
    return { state: j.status === "pending" ? "pending" : "expired" };
  } catch { return { state: "error" }; }
}

export async function pairApprove(code: string): Promise<"ok" | "invalid" | "locked" | "error"> {
  const cfg = getSyncConfig();
  if (!cfg) return "error";
  try {
    const r = await fetch(cfg.url + "/pair/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Key": cfg.key },
      body: JSON.stringify({ code }),
    });
    if (r.ok) return "ok";
    if (r.status === 429) return "locked";
    if (r.status === 404) return "invalid";
    return "error";
  } catch { return "error"; }
}

export async function rotateKey(newKey: string): Promise<boolean> {
  const cfg = getSyncConfig();
  if (!cfg) return false;
  try {
    const r = await fetch(cfg.url + "/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Key": cfg.key },
      body: JSON.stringify({ newKey }),
    });
    return r.ok;
  } catch { return false; }
}

export function mintKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
