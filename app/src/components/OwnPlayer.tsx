import { useEffect, useRef, useState } from "react";

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * VidShelf's own player: full control bar (play/pause, seek, volume, speed,
 * fullscreen), D-pad friendly (every control is focusable, range inputs take
 * arrow keys natively), auto-hiding chrome. Used for Drive streams, direct
 * files and HLS - one player, one remote behavior, every platform.
 */
export default function OwnPlayer({
  src,
  hls = false,
  cors = false,
  onFatalError,
  onFullscreen,
  isFs,
}: {
  src: string;
  hls?: boolean;
  /** CORS-mode media load (worker sends ACAO:*). CORS responses are exempt
   *  from Chrome's Opaque Response Blocking, which kills no-cors media. */
  cors?: boolean;
  /** Drive fallback: fired when the stream URL errors or never produces metadata. */
  onFatalError?: () => void;
  onFullscreen: () => void;
  isFs: boolean;
}) {
  const vRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showUi, setShowUi] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);

  // Source attach (HLS via hls.js when the engine lacks native support).
  useEffect(() => {
    const video = vRef.current;
    if (!video) return;
    if (!hls || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }
    let destroy: (() => void) | undefined;
    import("hls.js").then(({ default: Hls }) => {
      if (Hls.isSupported() && vRef.current) {
        const h = new Hls({ enableWorker: true });
        h.loadSource(src);
        h.attachMedia(vRef.current);
        destroy = () => h.destroy();
      } else {
        onFatalError?.();
      }
    });
    return () => destroy?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, hls]);

  // Fatal detection for the Drive direct stream: element error, or no
  // metadata within 15s (Google served an interstitial instead of bytes).
  useEffect(() => {
    const v = vRef.current;
    if (!v || !onFatalError) return;
    const onErr = () => onFatalError();
    v.addEventListener("error", onErr);
    const t = window.setTimeout(() => {
      if (v.readyState === 0) onFatalError();
    }, 25000);
    return () => {
      v.removeEventListener("error", onErr);
      window.clearTimeout(t);
    };
  }, [onFatalError]);

  const poke = () => {
    setShowUi(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (vRef.current && !vRef.current.paused) setShowUi(false);
    }, 3000);
  };
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, []);

  const togglePlay = () => {
    const v = vRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const cycleSpeed = () => {
    const v = vRef.current;
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (v) v.playbackRate = next;
  };

  return (
    <div
      className="group relative h-full w-full bg-black"
      onMouseMove={poke}
      onTouchStart={poke}
      onFocusCapture={poke}
    >
      <video
        ref={vRef}
        autoPlay
        playsInline
        crossOrigin={cors ? "anonymous" : undefined}
        className="h-full w-full bg-black"
        onClick={togglePlay}
        onPlay={() => { setPlaying(true); poke(); }}
        onPause={() => { setPlaying(false); setShowUi(true); }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); setVol(e.currentTarget.volume); }}
        onVolumeChange={(e) => { setVol(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
      />

      <div
        className={`absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-3 pt-10 transition-opacity duration-200 sm:gap-3 sm:px-4 ${showUi ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <button data-focusable onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-black/50 text-white backdrop-blur-sm hover:bg-black/70">
          {playing ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
          )}
        </button>

        <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-300 sm:text-xs">{fmt(time)} / {fmt(dur)}</span>

        <input
          data-focusable
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(1, Math.floor(dur || 0))}
          value={Math.floor(time)}
          onChange={(e) => { const v = vRef.current; if (v) v.currentTime = Number(e.target.value); }}
          className="h-1.5 min-w-16 flex-1 cursor-pointer accent-white"
        />

        <button data-focusable onClick={() => { const v = vRef.current; if (v) v.muted = !v.muted; }} aria-label={muted || vol === 0 ? "Unmute" : "Mute"}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-black/50 text-white backdrop-blur-sm hover:bg-black/70">
          {muted || vol === 0 ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
          )}
        </button>
        <input
          data-focusable
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          value={muted ? 0 : Math.round(vol * 100)}
          onChange={(e) => { const v = vRef.current; if (v) { v.muted = false; v.volume = Number(e.target.value) / 100; } }}
          className="hidden h-1.5 w-20 cursor-pointer accent-white sm:block"
        />

        <button data-focusable onClick={cycleSpeed} aria-label="Playback speed"
          className="flex h-10 min-w-12 items-center justify-center rounded-xl border border-white/20 bg-black/50 px-2 font-mono text-xs font-semibold text-white backdrop-blur-sm hover:bg-black/70">
          {speed}x
        </button>

        <button data-focusable onClick={onFullscreen} aria-label="Fullscreen"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-black/50 text-white backdrop-blur-sm hover:bg-black/70">
          {isFs ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 4v4a1 1 0 0 1-1 1H4M20 15h-4a1 1 0 0 0-1 1v4M15 20v-4a1 1 0 0 1 1-1h4M4 9h4a1 1 0 0 0 1-1V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}
