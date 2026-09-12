import { parseLink } from "./router";

/** Best-effort thumbnail URL for a video link. null = show a placeholder. */
export function thumbnailForUrl(raw: string): string | null {
  const p = parseLink(raw);
  if (p.kind === "youtube" && p.videoId) return `https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`;
  if (p.kind === "drive" && p.fileId) return `https://drive.google.com/thumbnail?id=${p.fileId}&sz=w1000`;
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
