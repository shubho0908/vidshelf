import { useEffect, useMemo, useRef, useState } from "react";
import { library, type Entry, type VideoItem } from "../lib/storage";
import { parseLink, type ParsedLink } from "../lib/router";
import { thumbnailForUrl } from "../lib/thumbnails";
import { goBack, nav } from "../lib/route";
import { KindBadge, Thumb } from "../components/bits";

function HlsVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }
    let destroy: (() => void) | undefined;
    import("hls.js").then(({ default: Hls }) => {
      if (Hls.isSupported() && ref.current) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(ref.current);
        destroy = () => hls.destroy();
      }
    });
    return () => destroy?.();
  }, [src]);
  return <video ref={ref} controls autoPlay className="h-full w-full bg-black" />;
}

function Player({ parsed }: { parsed: ParsedLink }) {
  if (parsed.kind === "youtube" || parsed.kind === "drive") {
    return (
      <iframe
        src={parsed.playUrl ?? undefined}
        title={parsed.label}
        className="h-full w-full border-0 bg-black"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
      />
    );
  }
  if (parsed.kind === "hls") return <HlsVideo src={parsed.playUrl!} />;
  if (parsed.kind === "direct") return <video src={parsed.playUrl!} controls autoPlay className="h-full w-full bg-black" />;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-gradient-to-br from-slate-900 to-black p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="text-red-400">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 6l12 12" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="max-w-lg text-[15px] font-medium text-slate-200">{parsed.blockReason}</div>
      <div className="max-w-lg break-all rounded-xl border border-white/10 bg-white/[0.04] p-3 font-mono text-xs text-slate-400">{parsed.originalUrl}</div>
    </div>
  );
}

export default function PlayerView({ id, index }: { id: string; index: number }) {
  const [entry] = useState<Entry | null>(() => library.get(id));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const video: VideoItem | null = entry?.videos[index] ?? entry?.videos[0] ?? null;
  const parsed = useMemo(() => (video ? parseLink(video.url) : null), [video]);

  if (!entry) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
        <div className="text-lg font-semibold text-slate-200">Entry not found</div>
        <button data-focusable onClick={() => nav("/")} className="rounded-xl bg-blue-500 px-5 py-2 text-sm font-semibold text-white">
          Back to library
        </button>
      </div>
    );
  }

  const doDelete = () => {
    library.remove(entry.id);
    nav("/");
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <button data-focusable onClick={() => goBack("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08]">
          Back
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">{entry.title}</h1>
        {parsed && <KindBadge kind={parsed.kind} label={parsed.label} />}
        <button data-focusable onClick={() => nav(`/edit/${entry.id}`)} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08]">
          Edit
        </button>
        <button
          data-focusable
          onClick={() => (confirmDelete ? doDelete() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          className={`rounded-xl border px-3.5 py-2 text-sm ${confirmDelete ? "border-red-500/60 bg-red-500/20 text-red-200" : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"}`}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </div>

      <div className="flex flex-col gap-5 xl:flex-row">
        <div className="min-w-0 flex-1">
          <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
            {parsed ? <Player parsed={parsed} /> : null}
          </div>
          {entry.description && <p className="mt-4 text-[15px] leading-relaxed text-slate-300">{entry.description}</p>}
          {video && entry.type === "playlist" && (
            <div className="mt-2 text-sm text-slate-400">
              Playing {index + 1} of {entry.videos.length}
            </div>
          )}
        </div>

        {entry.type === "playlist" && (
          <aside className="w-full shrink-0 xl:w-80">
            <div className="mb-2 text-sm font-semibold text-slate-300">Up next</div>
            <div className="flex max-h-[520px] flex-col gap-2 overflow-y-auto pr-1">
              {entry.videos.map((v, i) => {
                const p = parseLink(v.url);
                const active = i === index;
                return (
                  <button
                    key={v.id}
                    data-focusable
                    onClick={() => nav(`/play/${entry.id}/${i}`)}
                    className={`flex items-center gap-3 rounded-xl border p-2 text-left transition-colors ${active ? "border-blue-400/60 bg-blue-500/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}
                  >
                    <div className="h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-black/50">
                      <Thumb src={thumbnailForUrl(v.url)} title={v.title ?? ""} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-1 text-[13px] font-medium text-slate-200">{v.title || `${p.label} ${i + 1}`}</div>
                      <div className="text-[11px] text-slate-500">{p.label}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
