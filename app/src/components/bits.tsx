import { useState } from "react";
import type { LinkKind } from "../lib/router";

const KIND_STYLES: Record<string, string> = {
  youtube: "bg-red-500/15 text-red-300 border-red-500/30",
  drive: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
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

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-slate-200 align-middle" />
  );
}
