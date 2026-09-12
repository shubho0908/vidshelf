export interface VideoItem {
  id: string;
  url: string;
  title?: string;
  /** Custom thumbnail object id (t_<uuid>) - absent = auto-fetch from the link. */
  thumbId?: string;
  /** Bumped on each re-upload; sync freshness + cache-bust key. */
  thumbV?: number;
}

export interface Entry {
  id: string;
  type: "video" | "playlist";
  title: string;
  description: string;
  videos: VideoItem[];
  createdAt: number;
  updatedAt: number;
  /** Custom thumbnail object id (t_<uuid>) - absent = auto-fetch from first link. */
  thumbId?: string;
  /** Bumped on each re-upload; sync freshness + cache-bust key. */
  thumbV?: number;
}

/** Every thumbnail id an entry references (entry-level + per-video). */
export function entryThumbIds(e: Entry): string[] {
  const ids: string[] = [];
  if (e.thumbId) ids.push(e.thumbId);
  for (const v of e.videos) if (v.thumbId) ids.push(v.thumbId);
  return ids;
}

/** Every thumbnail id referenced across the whole library. */
export function allThumbIds(entries: Entry[]): Set<string> {
  const s = new Set<string>();
  for (const e of entries) for (const id of entryThumbIds(e)) s.add(id);
  return s;
}

const KEY = "vidshelf.library.v1";
const TOMB_KEY = "vidshelf.tombstones.v1";
const DIRTY_KEY = "vidshelf.dirty.v1";

// Tombstones (deleted entry id -> deletion time) and a dirty set (ids changed
// since last sync) keep sync deltas small: pushes only carry what changed.
export function readTombstones(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TOMB_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function writeTombstones(t: Record<string, number>): void {
  localStorage.setItem(TOMB_KEY, JSON.stringify(t));
}
export function readDirty(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DIRTY_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
export function writeDirty(d: Set<string>): void {
  localStorage.setItem(DIRTY_KEY, JSON.stringify([...d]));
}
function markDirty(id: string): void {
  const d = readDirty();
  d.add(id);
  writeDirty(d);
}

function uid(): string {
  return (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}

function readAll(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as Entry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(entries: Entry[]): void {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

export const library = {
  list(): Entry[] {
    return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): Entry | null {
    return readAll().find((e) => e.id === id) ?? null;
  },
  create(input: Omit<Entry, "id" | "createdAt" | "updatedAt">): Entry {
    const now = Date.now();
    const entry: Entry = { ...input, id: uid(), createdAt: now, updatedAt: now };
    writeAll([...readAll(), entry]);
    markDirty(entry.id);
    return entry;
  },
  update(id: string, patch: Partial<Omit<Entry, "id" | "createdAt">>): Entry | null {
    const all = readAll();
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, id, updatedAt: Date.now() };
    writeAll(all);
    markDirty(id);
    return all[i];
  },
  remove(id: string): boolean {
    const all = readAll();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    writeAll(next);
    const t = readTombstones();
    t[id] = Date.now();
    writeTombstones(t);
    markDirty(id);
    return true;
  },
  exportJson(): string {
    return JSON.stringify(readAll(), null, 2);
  },
  importJson(json: string): number {
    const data = JSON.parse(json) as Entry[];
    if (!Array.isArray(data)) throw new Error("Invalid backup file");
    const existing = new Set(readAll().map((e) => e.id));
    const fresh = data.filter((e) => e && e.id && Array.isArray(e.videos) && !existing.has(e.id));
    writeAll([...readAll(), ...fresh]);
    const d = readDirty();
    for (const e of fresh) d.add(e.id);
    writeDirty(d);
    return fresh.length;
  },
  makeVideo(url: string, title?: string): VideoItem {
    return { id: uid(), url, title };
  },
};
