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
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-gradient-to-b from-[#101018] to-black p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-slate-300">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 6l12 12" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="t-title max-w-xl text-slate-100">This one can't be embedded</div>
      <div className="t-body max-w-xl text-slate-400">{parsed.blockReason}</div>
      <div className="t-small max-w-xl break-all rounded-2xl border border-white/10 bg-white/[0.04] p-3 font-mono text-slate-500">{parsed.originalUrl}</div>
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
      <div className="flex min-h-full flex-col items-center justify-center gap-5 p-8">
        <div className="t-title">Entry not found</div>
        <button data-focusable onClick={() => nav("/")} className="bright rounded-2xl bg-white px-6 py-3 text-sm font-bold text-black">
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
    <div className="flex min-h-full w-full flex-col">
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:gap-3 sm:px-5 md:px-10">
        <button data-focusable onClick={() => goBack("/")} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back
        </button>
        <h1 className="t-title min-w-0 flex-1 truncate">{entry.title}</h1>
        {parsed && <KindBadge kind={parsed.kind} label={parsed.label} />}
        <button data-focusable onClick={() => nav(`/edit/${entry.id}`)} className="rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          Edit
        </button>
        <button
          data-focusable
          onClick={() => (confirmDelete ? doDelete() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          className={`rounded-2xl border px-4 py-2.5 text-sm font-medium backdrop-blur-md ${confirmDelete ? "border-red-400/60 bg-red-500/20 text-red-100" : "border-white/10 bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]"}`}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </header>

      <div className="flex flex-col pt-[76px]">
        <div className="w-full bg-black" style={{ height: "min(62vh, 100vw * 9 / 16)" }}>
          {parsed ? <Player parsed={parsed} /> : null}
        </div>

        <div className="tv-safe flex flex-col gap-8 px-5 py-8 md:px-10 xl:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="t-display">{entry.title}</h2>
            {video && entry.type === "playlist" && (
              <div className="t-eyebrow mt-2">Playing {index + 1} of {entry.videos.length}{video.title ? ` - ${video.title}` : ""}</div>
            )}
            {entry.description && <p className="t-body mt-4 max-w-3xl leading-relaxed text-slate-300">{entry.description}</p>}
          </div>

          {entry.type === "playlist" && (
            <aside className="w-full shrink-0 xl:w-[380px]">
              <div className="t-eyebrow mb-3">Up next</div>
              <div className="flex max-h-[46vh] flex-col gap-2.5 overflow-y-auto pr-1">
                {entry.videos.map((v, i) => {
                  const p = parseLink(v.url);
                  const active = i === index;
                  return (
                    <button
                      key={v.id}
                      data-focusable
                      onClick={() => nav(`/play/${entry.id}/${i}`)}
                      className={`flex items-center gap-3.5 rounded-2xl border p-2.5 text-left transition-colors ${active ? "border-white/40 bg-white/[0.1]" : "border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.07]"}`}
                    >
                      <div className="h-14 w-24 shrink-0 overflow-hidden rounded-xl bg-black/60">
                        <Thumb src={thumbnailForUrl(v.url)} title={v.title ?? ""} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-[14px] font-semibold text-slate-100">{v.title || `${p.label} ${i + 1}`}</div>
                        <div className="t-small text-slate-500">{p.label}</div>
                      </div>
                      {active && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="mr-1 shrink-0 text-white"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
