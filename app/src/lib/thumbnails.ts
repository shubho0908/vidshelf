import { parseLink, r2IdFrom } from "./router";
import { SYNC_URL } from "../config";

/** Best-effort thumbnail URL for a video link. null = show a placeholder. */
export function thumbnailForUrl(raw: string): string | null {
  const p = parseLink(raw);
  if (p.kind === "youtube" && p.videoId) return `https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`;
  const r2 = r2IdFrom(raw);
  if (r2) return `${SYNC_URL.replace(/\/+$/, "")}/media/thumb/${r2}`;
  return null;
}

/** Best-effort title fetch (YouTube via noembed, CORS-friendly). Never throws. */
export async function fetchRemoteTitle(raw: string, timeoutMs = 3500): Promise<string | null> {
  const p = parseLink(raw);
  if (p.kind !== "youtube") return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(raw.trim())}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = (await res.json()) as { title?: string };
    return data.title ?? null;
  } catch {
    return null;
  }
}
