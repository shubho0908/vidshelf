import { useEffect, useState } from "react";
import type { LinkKind } from "../lib/router";
import type { Entry, VideoItem } from "../lib/storage";
import { ensureThumbLocal } from "../lib/sync";
import { thumbUrl } from "../lib/thumbstore";
import { thumbnailForUrl } from "../lib/thumbnails";

const KIND_STYLES: Record<string, string> = {
  youtube: "bg-red-500/15 text-red-300 border-red-500/30",
  vimeo: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  dailymotion: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  embed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  r2: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  direct: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  hls: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  ott: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  unknown: "bg-zinc-500/15 text-zinc-400 border-zinc-600/30",
};

export function KindBadge({ kind, label }: { kind: LinkKind; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide ${KIND_STYLES[kind] ?? KIND_STYLES.unknown}`}>
      {label}
    </span>
  );
}

export function Thumb({ src, title }: { src: string | null; title: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-800 via-slate-900 to-indigo-950">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" className="text-slate-500">
          <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 9.5v5l4.5-2.5L10 9.5z" fill="currentColor" />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className="h-full w-full object-cover"
    />
  );
}

/** Blob URL for a custom thumbnail: local IDB first, cloud fetch on miss. */
export function useCustomThumb(thumbId?: string, thumbV?: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!thumbId) return;
    void (async () => {
      let u = await thumbUrl(thumbId).catch(() => null);
      if (!u) {
        const ok = await ensureThumbLocal(thumbId, thumbV ?? 1).catch(() => false);
        if (ok) u = await thumbUrl(thumbId).catch(() => null);
      }
      if (alive) setUrl(u);
    })();
    return () => {
      alive = false;
    };
  }, [thumbId, thumbV]);
  return url;
}

/** Entry thumbnail: custom upload wins, else auto-fetch from the first link. */
export function EntryThumb({ entry, title }: { entry: Entry; title: string }) {
  const custom = useCustomThumb(entry.thumbId, entry.thumbV);
  const auto = thumbnailForUrl(entry.videos[0]?.url ?? "");
  return <Thumb src={custom ?? auto} title={title} />;
}

/** Video-row thumbnail: custom upload wins, else auto-fetch from the link. */
export function VideoThumb({ video }: { video: VideoItem }) {
  const custom = useCustomThumb(video.thumbId, video.thumbV);
  return <Thumb src={custom ?? thumbnailForUrl(video.url)} title={video.title ?? ""} />;
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-slate-200 align-middle" />
  );
}
