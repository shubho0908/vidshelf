import { useMemo, useRef, useState } from "react";
import { library, type Entry } from "../lib/storage";
import { parseLink } from "../lib/router";
import { thumbnailForUrl } from "../lib/thumbnails";
import { nav } from "../lib/route";
import { KindBadge, Thumb } from "../components/bits";

function entryMeta(e: Entry) {
  const first = e.videos[0]?.url ?? "";
  const parsed = first ? parseLink(first) : null;
  return {
    thumb: first ? thumbnailForUrl(first) : null,
    parsed,
  };
}

function Card({ entry }: { entry: Entry }) {
  const { thumb, parsed } = entryMeta(entry);
  return (
    <button
      data-focusable
      onClick={() => nav(`/play/${entry.id}`)}
      className="group flex flex-col overflow-hidden rounded-2xl border border-white/5 bg-white/[0.03] text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-black/40">
        <Thumb src={thumb} title={entry.title} />
        {entry.type === "playlist" && (
          <span className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">
            {entry.videos.length} videos
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center gap-2">
          {entry.type === "playlist" ? (
            <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">Playlist</span>
          ) : (
            parsed && <KindBadge kind={parsed.kind} label={parsed.label} />
          )}
        </div>
        <div className="line-clamp-1 text-[15px] font-semibold text-slate-100">{entry.title}</div>
        {entry.description && <div className="line-clamp-1 text-[13px] text-slate-400">{entry.description}</div>}
      </div>
    </button>
  );
}

export default function LibraryView() {
  const [entries, setEntries] = useState<Entry[]>(() => library.list());
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => (e.title + " " + e.description).toLowerCase().includes(q));
  }, [entries, query]);

  const doExport = () => {
    const blob = new Blob([library.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vidshelf-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (f: File) => {
    try {
      library.importJson(await f.text());
      setEntries(library.list());
    } catch {
      alert("Could not import: not a valid VidShelf backup.");
    }
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-5 p-5 pt-0 md:p-8 md:pt-0">
      <header className="chrome sticky top-0 z-20 -mx-5 flex flex-wrap items-center gap-3 px-5 py-4 md:-mx-8 md:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
          </div>
          <h1 className="heading text-xl font-bold">VidShelf</h1>
        </div>
        <div className="flex-1" />
        <input
          data-focusable
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search library"
          className="w-44 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-blue-400/60 md:w-64"
        />
        <button data-focusable onClick={doExport} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08]">
          Export
        </button>
        <button data-focusable onClick={() => fileRef.current?.click()} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08]">
          Import
        </button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        <button
          data-focusable
          onClick={() => nav("/add")}
          className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400"
        >
          + Add
        </button>
      </header>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.04]">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" className="text-slate-500">
              <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 9.5v5l4.5-2.5L10 9.5z" fill="currentColor" />
            </svg>
          </div>
          <div className="text-lg font-semibold text-slate-200">{query ? "Nothing matches your search" : "Your shelf is empty"}</div>
          <p className="max-w-md text-sm text-slate-400">
            Add a YouTube or Google Drive link, or a direct video file. VidShelf embeds it - no uploads, no transcoding, no server.
          </p>
          <button data-focusable onClick={() => nav("/add")} className="rounded-xl bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-400">
            Add your first video
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filtered.map((e) => (
            <Card key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}
