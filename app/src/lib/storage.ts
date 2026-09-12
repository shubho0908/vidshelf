export interface VideoItem {
  id: string;
  url: string;
  title?: string;
}

export interface Entry {
  id: string;
  type: "video" | "playlist";
  title: string;
  description: string;
  videos: VideoItem[];
  createdAt: number;
  updatedAt: number;
}

const KEY = "vidshelf.library.v1";

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
    return entry;
  },
  update(id: string, patch: Partial<Omit<Entry, "id" | "createdAt">>): Entry | null {
    const all = readAll();
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, id, updatedAt: Date.now() };
    writeAll(all);
    return all[i];
  },
  remove(id: string): boolean {
    const all = readAll();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    writeAll(next);
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
    return fresh.length;
  },
  makeVideo(url: string, title?: string): VideoItem {
    return { id: uid(), url, title };
  },
};
