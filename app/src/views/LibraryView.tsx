import { useEffect, useMemo, useRef, useState } from "react";
import { library, type Entry } from "../lib/storage";
import { IS_WEB_BUILD, SYNC_URL } from "../config";
import { getSyncConfig, hasCustomSyncConfig, setSyncConfig, lastSyncAt, syncNow, scheduleSync, type SyncResult } from "../lib/sync";
import { parseLink } from "../lib/router";
import { nav } from "../lib/route";
import { EntryThumb, KindBadge } from "../components/bits";

function Card({ entry }: { entry: Entry }) {
  const first = entry.videos[0]?.url ?? "";
  const parsed = first ? parseLink(first) : null;
  return (
    <button
      data-focusable
      onClick={() => nav(`/play/${entry.id}`)}
      className="group relative aspect-video w-full overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.03] text-left"
    >
      <EntryThumb entry={entry} title={entry.title} />
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
    <section className="relative h-[56vh] min-h-[340px] overflow-hidden">
      <div className="absolute inset-0">
        <EntryThumb entry={entry} title={entry.title} />
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

function timeAgo(ts: number): string {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function SyncModal({ onClose, onSynced }: { onClose: () => void; onSynced: () => void }) {
  const cfg = getSyncConfig();
  const [url, setUrl] = useState(cfg?.url ?? SYNC_URL);
  const [key, setKey] = useState(cfg?.key ?? "");
  const [status, setStatus] = useState<string>(() =>
    hasCustomSyncConfig() ? "" : "Last synced " + timeAgo(lastSyncAt()) + ".");
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  // Web build ships without the baked key: ask once, store on this device only.
  const needsKey = IS_WEB_BUILD && !hasCustomSyncConfig();

  const describe = (r: SyncResult) =>
    r.ok ? `Synced - pushed ${r.pushed}, pulled ${r.pulled}.`
    : r.reason === "auth" ? "Wrong sync key." : "Could not reach the sync server.";

  const save = () => {
    setSyncConfig({ url: url.trim().replace(/\/+$/, ""), key: key.trim() });
    setStatus("Saved. Last synced " + timeAgo(lastSyncAt()) + ".");
  };
  const run = async () => {
    setBusy(true);
    setStatus("Syncing...");
    const r = await syncNow();
    setBusy(false);
    setStatus(describe(r));
    if (r.ok) onSynced();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-3xl border border-white/10 bg-[#141418] p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white">Cloud sync</h2>
        {needsKey ? (
          <>
            <p className="t-small text-slate-400">
              One-time setup on the web version: enter your sync key to link this browser to your shelf. It is stored only on this device, never sent anywhere except your own sync server.
            </p>
            <label className="t-eyebrow">Sync key</label>
            <input data-focusable value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your sync key"
              className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-white/40" />
          </>
        ) : !hasCustomSyncConfig() && !advanced ? (
          <p className="t-small text-slate-400">
            On automatically on every device with this app - TV, Mac, phone stay on the same shelf. Nothing to type, anywhere.
          </p>
        ) : null}
        {advanced && !needsKey && (
          <>
            <label className="t-eyebrow">Worker URL</label>
            <input data-focusable value={url} onChange={(e) => setUrl(e.target.value)}
              className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 font-mono text-xs text-slate-200 outline-none focus:border-white/40" />
            <label className="t-eyebrow">Sync key</label>
            <input data-focusable value={key} onChange={(e) => setKey(e.target.value)} placeholder="Custom sync key"
              className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-white/40" />
          </>
        )}
        {!needsKey && (
          <button data-focusable onClick={() => setAdvanced((a) => !a)} className="self-start text-xs text-slate-500 underline underline-offset-2">
            {advanced ? "Hide advanced" : "Advanced: custom worker / key"}
          </button>
        )}
        {status && <p className="t-small text-slate-300">{status}</p>}
        <div className="flex items-center gap-3">
          <button data-focusable onClick={save} className="rounded-xl border border-white/15 bg-white/[0.08] px-5 py-2.5 text-sm font-semibold text-white">Save</button>
          <button data-focusable disabled={busy} onClick={() => { save(); void run(); }}
            className="bright rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-black disabled:opacity-50">Sync now</button>
          <button data-focusable onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm text-slate-400">Close</button>
        </div>
      </div>
    </div>
  );
}

export default function LibraryView() {
  const [entries, setEntries] = useState<Entry[]>(() => library.list());
  const [query, setQuery] = useState("");
  const [syncOpen, setSyncOpen] = useState(() => IS_WEB_BUILD && !hasCustomSyncConfig());
  const synced = getSyncConfig() !== null;

  // Pull once per app open - the only automatic D1 read.
  useEffect(() => {
    if (!getSyncConfig()) return;
    void syncNow().then((r) => { if (r.ok) setEntries(library.list()); });
  }, []);
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
      scheduleSync();
    } catch {
      alert("Could not import: not a valid VidShelf backup.");
    }
  };

  return (
    <div className="flex min-h-full w-full flex-col">
      {/* Floating chrome */}
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:gap-3 sm:px-5 md:px-10">
        <div className="flex items-center gap-2.5">
          <img src="./icon.png" alt="VidShelf" className="h-9 w-9 rounded-xl" />
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
        <button data-focusable onClick={() => setSyncOpen(true)} title="Cloud sync"
          className={"rounded-2xl border px-3.5 py-2.5 text-sm backdrop-blur-md " + (synced ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300" : "border-white/10 bg-white/[0.06] text-slate-200")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0 0-9 6 6 0 0 0-11.5 1.5A4 4 0 0 0 7 19h10.5z"/></svg>
        </button>
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
          {(query || shelf.length > 0) && (
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
          )}
        </div>
      )}
      {syncOpen && <SyncModal onClose={() => setSyncOpen(false)} onSynced={() => setEntries(library.list())} />}
    </div>
  );
}
