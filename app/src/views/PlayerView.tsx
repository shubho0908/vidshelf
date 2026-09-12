import { useEffect, useMemo, useRef, useState } from "react";
import { scheduleSync } from "../lib/sync";
import { entryThumbIds, library, type Entry, type VideoItem } from "../lib/storage";
import { parseLink, type ParsedLink } from "../lib/router";
import { retireThumb } from "../lib/thumbstore";
import { goBack, nav } from "../lib/route";
import { KindBadge, VideoThumb } from "../components/bits";

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
  const [isFs, setIsFs] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const video: VideoItem | null = entry?.videos[index] ?? entry?.videos[0] ?? null;
  const parsed0 = useMemo(() => (video ? parseLink(video.url) : null), [video]);

  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement || (document as { webkitFullscreenElement?: Element }).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs as EventListener);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    // Escape exits window-level fullscreen without triggering SPA "back"
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFsRef.current) {
        e.stopPropagation();
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyCapture, true);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs as EventListener);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onKeyCapture, true);
    };
  }, []);

  // TV remote on the OWN player (direct/HLS): focus the player box, then
  // OK toggles play/pause, left/right seek 10s. Header buttons keep spatial nav.
  const isNativePlayer = Boolean(parsed0?.kind === "direct" || parsed0?.kind === "hls");
  useEffect(() => {
    if (!isNativePlayer) return;
    const onKey = (e: KeyboardEvent) => {
      const box = boxRef.current;
      const v = box?.querySelector("video");
      if (!box || !v) return;
      const boxFocused = box.classList.contains("tv-focus") || document.activeElement === box;
      if (!boxFocused) return;
      if (e.key === "ArrowLeft") { v.currentTime = Math.max(0, v.currentTime - 10); }
      else if (e.key === "ArrowRight") { v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10); }
      else if (e.key === "Enter") { if (v.paused) void v.play(); else v.pause(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isNativePlayer]);

  const isFsRef = useRef(false);
  useEffect(() => { isFsRef.current = isFs; }, [isFs]);

  const winFsRef = useRef(false);

  const toggleFullscreen = async () => {
    const el = boxRef.current;
    const doc = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element };
    const inElementFs = Boolean(document.fullscreenElement || doc.webkitFullscreenElement);

    if (inElementFs || winFsRef.current) {
      if (inElementFs) {
        if (document.exitFullscreen) await document.exitFullscreen().catch(() => {});
        else doc.webkitExitFullscreen?.();
      } else {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setFullscreen(false);
        } catch { /* ignore */ }
        winFsRef.current = false;
        setIsFs(false);
      }
      return;
    }

    // Path 1: element fullscreen (works on Chromium/Android WebView, webOS, browsers).
    // WKWebView on macOS can hang the promise - race it with a timeout.
    if (el) {
      const req = el as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      try {
        const call = req.requestFullscreen ? req.requestFullscreen() : req.webkitRequestFullscreen?.();
        await Promise.race([
          Promise.resolve(call),
          new Promise((_, reject) => setTimeout(() => reject(new Error("fullscreen hang")), 900)),
        ]);
      } catch { /* fall through to window fullscreen */ }
      if (document.fullscreenElement || doc.webkitFullscreenElement) return; // fullscreenchange updates state
    }

    // Path 2: Tauri native window fullscreen (macOS WKWebView fallback).
    if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(true);
        winFsRef.current = true;
        setIsFs(true);
      } catch { /* leave inline */ }
    }
  };



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
    // Cascade: retire every custom thumbnail this entry references (local
    // purge now, remote delete drains on next sync).
    for (const id of entryThumbIds(entry)) void retireThumb(id);
    library.remove(entry.id);
    scheduleSync();
    nav("/");
  };

  return (
    <div className="flex min-h-full w-full flex-col">
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:gap-3 sm:px-5 md:px-10">
        <button data-focusable onClick={() => goBack("/")} className="flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-3 py-2.5 text-[13px] font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12] sm:px-4 sm:text-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back
        </button>
        <h1 className="t-title min-w-0 flex-1 truncate">{entry.title}</h1>
        {parsed0 && <span className="hidden sm:block"><KindBadge kind={parsed0.kind} label={parsed0.label} /></span>}
        <button data-focusable onClick={() => nav(`/edit/${entry.id}`)} className="shrink-0 rounded-2xl border border-white/10 bg-white/[0.06] px-3 py-2.5 text-[13px] font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12] sm:px-4 sm:text-sm">
          Edit
        </button>
        <button
          data-focusable
          onClick={() => (confirmDelete ? doDelete() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          className={`shrink-0 rounded-2xl border px-3 py-2.5 text-[13px] font-medium backdrop-blur-md sm:px-4 sm:text-sm ${confirmDelete ? "border-red-400/60 bg-red-500/20 text-red-100" : "border-white/10 bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]"}`}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </header>

      <div className="pt-chrome flex flex-col">
        <div
          ref={boxRef}
          {...(isNativePlayer ? { "data-focusable": true, tabIndex: -1 } : {})}
          className={isFs ? "fixed inset-0 z-50 bg-black" : "relative w-full bg-black"}
          style={isFs ? undefined : { height: "min(62vh, 100vw * 9 / 16)" }}
          onDoubleClick={toggleFullscreen}
        >
          {parsed0 ? <Player parsed={parsed0} /> : null}
          <button
            data-focusable
            onClick={toggleFullscreen}
            title="Fullscreen (f)"
            aria-label="Toggle fullscreen"
            className="absolute right-20 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-xl border border-white/20 bg-black/60 text-white backdrop-blur-md transition hover:bg-black/80"
          >
            {isFs ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 4v4a1 1 0 0 1-1 1H4M20 15h-4a1 1 0 0 0-1 1v4M15 20v-4a1 1 0 0 1 1-1h4M4 9h4a1 1 0 0 0 1-1V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
          </button>
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
                        <VideoThumb video={v} />
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
