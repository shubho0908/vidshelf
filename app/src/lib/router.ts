import { SYNC_URL, YT_PLAYER_BASE } from "../config";

export type LinkKind = "youtube" | "r2" | "direct" | "hls" | "ott" | "unknown";

export interface ParsedLink {
  kind: LinkKind;
  originalUrl: string;
  /** iframe src for youtube/drive, media src for direct/hls, null for ott/unknown */
  playUrl: string | null;
  videoId?: string;
  fileId?: string;
  label: string;
  blockReason?: string;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

const OTT_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)netflix\.com$/i, "Netflix"],
  [/(^|\.)primevideo\.com$/i, "Prime Video"],
  [/(^|\.)hotstar\.com$/i, "Hotstar"],
  [/(^|\.)jiohotstar\.com$/i, "JioHotstar"],
  [/(^|\.)jiocinema\.com$/i, "JioCinema"],
  [/(^|\.)disneyplus\.com$/i, "Disney+"],
  [/(^|\.)hulu\.com$/i, "Hulu"],
  [/(^|\.)max\.com$/i, "Max"],
  [/(^|\.)zee5\.com$/i, "ZEE5"],
  [/(^|\.)sonyliv\.com$/i, "SonyLIV"],
  [/(^|\.)peacocktv\.com$/i, "Peacock"],
  [/(^|\.)paramountplus\.com$/i, "Paramount+"],
  [/(^|\.)crunchyroll\.com$/i, "Crunchyroll"],
  [/(^|\.)mubi\.com$/i, "MUBI"],
  [/(^|\.)appletv\.apple\.com$/i, "Apple TV+"],
];

function normalize(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function ytIdFrom(u: URL): string | null {
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return YT_ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v") ?? "";
      return YT_ID.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

/** Home-server media id from an r2:// URL. These entries come from the
 *  server-managed catalog (worker /media/catalog) and stream through the
 *  worker's rate-limited /media/stream route - the R2 bucket itself is
 *  private and never directly reachable. */
const R2_ID = /^[A-Za-z0-9_-]{16,64}$/;
export function r2IdFrom(raw: string): string | null {
  const m = /^r2:\/\/([A-Za-z0-9_-]{16,64})$/.exec(raw.trim());
  return m && R2_ID.test(m[1]) ? m[1] : null;
}
export function r2StreamUrl(id: string): string {
  return `${SYNC_URL.replace(/\/+$/, "")}/media/stream/${id}`;
}

function isDriveUrl(u: URL): boolean {
  const host = u.hostname.replace(/^www\./, "");
  return host === "drive.google.com" || host === "docs.google.com";
}

const HLS_EXT = /\.m3u8?($|\?)/i;
const DIRECT_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|mpg|mpeg|ogv)($|\?)/i;

export function parseLink(raw: string): ParsedLink {
  const r2 = r2IdFrom(raw);
  if (r2) {
    return { kind: "r2", originalUrl: raw, playUrl: r2StreamUrl(r2), label: "Home server" };
  }
  const u = normalize(raw);
  if (!u) {
    return { kind: "unknown", originalUrl: raw, playUrl: null, label: "Unknown link", blockReason: "This does not look like a valid URL." };
  }
  const host = u.hostname.toLowerCase();

  const yt = ytIdFrom(u);
  if (yt) {
    return { kind: "youtube", originalUrl: raw, playUrl: `${YT_PLAYER_BASE}?v=${yt}`, videoId: yt, label: "YouTube" };
  }

  if (isDriveUrl(u)) {
    return {
      kind: "unknown",
      originalUrl: raw,
      playUrl: null,
      label: "Google Drive",
      blockReason: "Google Drive links are no longer supported. Videos now stream from the home server - they appear in the library automatically.",
    };
  }

  for (const [re, name] of OTT_HOSTS) {
    if (re.test(host)) {
      return {
        kind: "ott",
        originalUrl: raw,
        playUrl: null,
        label: name,
        blockReason: `${name} cannot be embedded anywhere. It blocks iframes (X-Frame-Options) and its DRM only licenses its own apps. Open it in a browser instead.`,
      };
    }
  }

  if (HLS_EXT.test(u.pathname + u.search)) {
    return { kind: "hls", originalUrl: raw, playUrl: u.toString(), label: "HLS stream" };
  }
  if (DIRECT_EXT.test(u.pathname + u.search)) {
    return { kind: "direct", originalUrl: raw, playUrl: u.toString(), label: "Video file" };
  }

  return {
    kind: "unknown",
    originalUrl: raw,
    playUrl: null,
    label: "Unsupported link",
    blockReason: "Supported links: YouTube and direct video files (.mp4, .m3u8, .webm...). Streaming apps like Netflix or Prime Video cannot be embedded.",
  };
}
