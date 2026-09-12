import { useMemo, useRef, useState } from "react";
import { library, type Entry } from "../lib/storage";
import { parseLink } from "../lib/router";
import { thumbnailForUrl } from "../lib/thumbnails";
import { nav } from "../lib/route";
import { KindBadge, Thumb } from "../components/bits";

function entryThumb(e: Entry): string | null {
  const first = e.videos[0]?.url ?? "";
  return first ? thumbnailForUrl(first) : null;
}

function Card({ entry }: { entry: Entry }) {
  const first = entry.videos[0]?.url ?? "";
  const parsed = first ? parseLink(first) : null;
  return (
    <button
      data-focusable
      onClick={() => nav(`/play/${entry.id}`)}
      className="group relative aspect-video w-full overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.03] text-left"
    >
      <Thumb src={entryThumb(entry)} title={entry.title} />
      <div className="art-fade absolute inset-0" />
      <div className="absolute left-2.5 top-2.5">
        {entry.type === "playlist" ? (
          <span className="rounded-md border border-white/20 bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
            Playlist · {entry.videos.length}
          </span>
        ) : (
          parsed && (
            <span className="rounded-md border border-white/20 bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
              {parsed.label}
            </span>
          )
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 p-3">
        <div className="line-clamp-1 text-[15px] font-semibold text-white drop-shadow-md">{entry.title}</div>
        {entry.description && <div className="t-small line-clamp-1 text-slate-300/90">{entry.description}</div>}
      </div>
    </button>
  );
}

function Hero({ entry }: { entry: Entry }) {
  const first = entry.videos[0]?.url ?? "";
  const parsed = first ? parseLink(first) : null;
  return (
    <section className="relative -mx-5 -mt-5 h-[56vh] min-h-[340px] overflow-hidden md:-mx-10 md:-mt-10">
      <div className="absolute inset-0">
        <Thumb src={entryThumb(entry)} title={entry.title} />
      </div>
      <div className="hero-fade absolute inset-0" />
      <div className="tv-safe absolute inset-x-0 bottom-0 flex flex-col gap-4 px-5 pb-10 md:px-10">
        <div className="flex items-center gap-2.5">
          {parsed && <KindBadge kind={parsed.kind} label={parsed.label} />}
          {entry.type === "playlist" && (
            <span className="rounded-full border border-white/15 bg-white/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-slate-200 backdrop-blur-sm">
              Playlist · {entry.videos.length} videos
            </span>
          )}
        </div>
        <h2 className="t-display max-w-3xl text-white drop-shadow-lg">{entry.title}</h2>
        {entry.description && <p className="t-body max-w-2xl text-slate-200/90 line-clamp-2 drop-shadow">{entry.description}</p>}
        <div className="mt-1 flex items-center gap-3">
          <button
            data-focusable
            data-autofocus
            onClick={() => nav(`/play/${entry.id}`)}
            className="bright flex items-center gap-2.5 rounded-2xl bg-white px-7 py-3 text-[15px] font-bold text-black"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
            Play
          </button>
          <button
            data-focusable
            onClick={() => nav(`/edit/${entry.id}`)}
            className="rounded-2xl border border-white/15 bg-white/[0.08] px-6 py-3 text-[15px] font-semibold text-white backdrop-blur-md hover:bg-white/[0.14]"
          >
            Edit
          </button>
        </div>
      </div>
    </section>
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

  const hero = query ? null : filtered[0] ?? null;
  const shelf = query ? filtered : filtered.slice(1);

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
    <div className="flex min-h-full w-full flex-col">
      {/* Floating chrome */}
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex items-center gap-3 px-5 py-4 md:px-10">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="black"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
          </div>
          <h1 className="t-title hidden text-white min-[420px]:block">VidShelf</h1>
        </div>
        <div className="flex-1" />
        <input
          data-focusable
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm outline-none backdrop-blur-md placeholder:text-slate-500 focus:border-white/40 sm:w-36 sm:flex-none md:w-60"
        />
        <button data-focusable onClick={doExport} title="Export library" className="hidden rounded-2xl sm:block border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          Export
        </button>
        <button data-focusable onClick={() => fileRef.current?.click()} title="Import library" className="hidden rounded-2xl sm:block border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          Import
        </button>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        <button data-focusable onClick={() => nav("/add")} className="bright rounded-2xl bg-white px-5 py-2.5 text-sm font-bold text-black">
          + Add
        </button>
      </header>

      {entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-32 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-slate-400">
              <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 9.5v5l4.5-2.5L10 9.5z" fill="currentColor" />
            </svg>
          </div>
          <h2 className="t-display">Your shelf is empty</h2>
          <p className="t-body max-w-md text-slate-400">
            Paste a YouTube or Google Drive link, or a direct video file. VidShelf embeds it - no uploads, no transcoding, no server.
          </p>
          <button data-focusable onClick={() => nav("/add")} className="bright mt-2 rounded-2xl bg-white px-8 py-3.5 text-[15px] font-bold text-black">
            Add your first video
          </button>
        </div>
      ) : (
        <div className="flex flex-col">
          {hero && <Hero entry={hero} />}
          <div className="tv-safe flex flex-col gap-5 px-5 pb-16 pt-8 md:px-10">
            <div className="t-eyebrow">{query ? `Results for "${query}"` : "Library"}</div>
            {shelf.length === 0 ? (
              <p className="t-body py-10 text-slate-500">{query ? "Nothing matches." : "That's everything."}</p>
            ) : (
              <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shelf.map((e) => (
                  <Card key={e.id} entry={e} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
