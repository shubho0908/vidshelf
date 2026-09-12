// Local-first sync against the VidShelf Cloudflare Worker.
// Design goals: localStorage is ALWAYS the read path; D1 chatter stays tiny.
//  - push: only dirty entries + new tombstones, one POST
//  - pull: once per app open, or manual; one GET
//  - writes debounced (no per-keystroke traffic)
import { SYNC_KEY, SYNC_URL } from "../config";
import { library, readDirty, readTombstones, writeDirty, type Entry } from "./storage";

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
  | { ok: true; pushed: number; pulled: number }
  | { ok: false; reason: "off" | "network" | "auth" };

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
    // 2) pull full state (library is small - one cheap read query)
    const res = await fetch(cfg.url + "/pull", { headers: { "X-Sync-Key": cfg.key } });
    if (res.status === 401) return { ok: false, reason: "auth" };
    if (!res.ok) return { ok: false, reason: "network" };
    const data = (await res.json()) as { entries: Entry[]; tombstones: Record<string, number> };
    const pulled = applyRemote(data.entries ?? [], data.tombstones ?? {});
    setLastSyncAt(Date.now());
    return { ok: true, pushed: dirtyEntries.length, pulled };
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
