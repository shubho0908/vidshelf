// Home-server media catalog: the server-managed video shelf every install
// shows by default. Read-only for apps - there is no app-callable upload
// path anywhere. Fetch is one cheap GET per app open / manual refresh;
// localStorage cache keeps first paint instant and offline-safe.
import { withMediaToken } from "./medialock";
import { SYNC_URL } from "../config";
import { getSyncConfig } from "./sync";
import type { Entry } from "./storage";

export interface MediaItem {
  id: string;
  title: string;
  description: string;
  sizeBytes: number;
  contentType: string;
  durationSec: number | null;
  position: number;
  hasThumb: boolean;
  addedAt: number;
}

const CACHE_KEY = "vidshelf.media.catalog.v1";
export const MEDIA_ENTRY_PREFIX = "media_";

export function readCatalogCache(): MediaItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const data = raw ? (JSON.parse(raw) as MediaItem[]) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Pull the latest catalog from the worker. On any failure the last cached
 *  catalog wins - the home shelf must never vanish on a flaky network. */
export async function refreshCatalog(): Promise<MediaItem[]> {
  try {
    const res = await fetch(withMediaToken(SYNC_URL + "/media/catalog"));
    if (res.status === 401) {
      // Media token expired/revoked mid-session - drop it and bounce the app
      // back to the lock screen instead of silently degrading.
      localStorage.removeItem("vidshelf.media.lock.v1");
      location.reload();
      return readCatalogCache();
    }
    if (!res.ok) return readCatalogCache();
    const data = (await res.json()) as { videos?: MediaItem[] };
    const videos = Array.isArray(data.videos) ? data.videos : [];
    localStorage.setItem(CACHE_KEY, JSON.stringify(videos));
    return videos;
  } catch {
    return readCatalogCache();
  }
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Present a catalog item as a read-only library entry. The r2:// URL routes
 *  playback through parseLink -> worker /media/stream. */
export function mediaEntry(m: MediaItem): Entry {
  return {
    id: MEDIA_ENTRY_PREFIX + m.id,
    type: "video",
    title: m.title,
    description: m.description || fmtSize(m.sizeBytes),
    videos: [{ id: MEDIA_ENTRY_PREFIX + m.id, url: "r2://" + m.id, title: m.title }],
    createdAt: m.addedAt,
    updatedAt: m.addedAt,
  };
}

/** Remove one home-server video everywhere: worker deletes the D1 catalog
 *  row and the R2 object in one call (owner key required). Locally we drop
 *  it from the cached catalog - no refetch, no extra traffic. */
export async function deleteServerMedia(id: string): Promise<"deleted" | "forbidden" | "failed"> {
  const cfg = getSyncConfig();
  if (!cfg) return "forbidden";
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/media/${id}`, {
      method: "DELETE",
      headers: { "X-Sync-Key": cfg.key },
    });
    if (res.status === 403) return "forbidden";
    if (!res.ok) return "failed";
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const data = raw ? (JSON.parse(raw) as MediaItem[]) : [];
      localStorage.setItem(CACHE_KEY, JSON.stringify(data.filter((x) => x.id !== id)));
    } catch { /* cache is best-effort */ }
    return "deleted";
  } catch {
    return "failed";
  }
}

export function isMediaEntry(id: string): boolean {
  return id.startsWith(MEDIA_ENTRY_PREFIX);
}

/** Lookup for PlayerView: catalog entries never live in the local library. */
export function findMediaEntry(id: string): Entry | null {
  if (!isMediaEntry(id)) return null;
  const mid = id.slice(MEDIA_ENTRY_PREFIX.length);
  const m = readCatalogCache().find((x) => x.id === mid);
  return m ? mediaEntry(m) : null;
}
