import { useMemo, useState } from "react";
import { library, type VideoItem } from "../lib/storage";
import { parseLink } from "../lib/router";
import { fetchRemoteTitle, thumbnailForUrl } from "../lib/thumbnails";
import { goBack } from "../lib/route";
import { KindBadge, Spinner, Thumb } from "../components/bits";

function LinkHint({ url }: { url: string }) {
  const parsed = useMemo(() => parseLink(url), [url]);
  if (!url.trim()) return null;
  const ok = parsed.kind === "youtube" || parsed.kind === "drive" || parsed.kind === "direct" || parsed.kind === "hls";
  const thumb = thumbnailForUrl(url);
  return (
    <div className={`flex items-center gap-3.5 rounded-2xl border p-3 ${ok ? "border-white/[0.07] bg-white/[0.03]" : "border-red-400/30 bg-red-500/[0.07]"}`}>
      {thumb && (
        <div className="h-12 w-[84px] shrink-0 overflow-hidden rounded-xl">
          <Thumb src={thumb} title="" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <KindBadge kind={parsed.kind} label={parsed.label} />
        {!ok && <div className="t-small mt-1.5 text-red-300">{parsed.blockReason}</div>}
        {ok && parsed.kind === "drive" && <div className="t-small mt-1.5 text-slate-400">Plays via Google Drive preview (max 1080p, file must be shared).</div>}
        {ok && parsed.kind === "youtube" && <div className="t-small mt-1.5 text-slate-400">Plays via the official YouTube player. Some videos disable embedding.</div>}
      </div>
    </div>
  );
}

export default function EntryFormView({ editId }: { editId?: string }) {
  const existing = editId ? library.get(editId) : null;
  const [type, setType] = useState<"video" | "playlist">(existing?.type ?? "video");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [videos, setVideos] = useState<VideoItem[]>(existing?.videos.length ? existing.videos : [library.makeVideo("")]);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  const setUrl = (i: number, url: string) => setVideos((v) => v.map((it, j) => (j === i ? { ...it, url } : it)));

  const fetchTitle = async () => {
    const url = videos[0]?.url ?? "";
    if (!url.trim()) return;
    setFetching(true);
    const t = await fetchRemoteTitle(url);
    setFetching(false);
    if (t && !title.trim()) setTitle(t);
  };

  const save = () => {
    const usable = videos.filter((v) => v.url.trim());
    if (!title.trim()) return setError("Give it a title.");
    if (usable.length === 0) return setError("Add at least one link.");
    for (const v of usable) {
      const p = parseLink(v.url);
      if (p.kind === "unknown" || p.kind === "ott") return setError(`"${v.url.slice(0, 60)}..." cannot be embedded: ${p.blockReason ?? p.label}`);
    }
    const finalVideos = type === "video" ? usable.slice(0, 1) : usable;
    if (existing) library.update(existing.id, { type, title: title.trim(), description: description.trim(), videos: finalVideos });
    else library.create({ type, title: title.trim(), description: description.trim(), videos: finalVideos });
    goBack("/");
  };

  const inputCls = "w-full rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-[15px] outline-none placeholder:text-slate-500 focus:border-white/40";

  return (
    <div className="flex min-h-full w-full flex-col">
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex items-center gap-3 px-5 py-4 md:px-10">
        <button data-focusable onClick={() => goBack("/")} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back
        </button>
        <h1 className="t-title">{existing ? "Edit entry" : "Add to shelf"}</h1>
      </header>

      <div className="tv-safe mx-auto flex w-full max-w-2xl flex-col gap-7 px-5 pb-16 pt-28 md:px-10">
        <div className="flex flex-col gap-2.5">
          <span className="t-eyebrow">What are you adding?</span>
          <div className="grid grid-cols-2 gap-4">
            {(["video", "playlist"] as const).map((t) => (
              <button
                key={t}
                data-focusable
                onClick={() => setType(t)}
                className={`flex flex-col gap-1.5 rounded-3xl border p-5 text-left transition-colors ${type === t ? "border-white/50 bg-white/[0.1]" : "border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06]"}`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.08]">
                  {t === "video" ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" /><path d="M10 9.5v5l4.5-2.5L10 9.5z" fill="currentColor" /></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 10h16M4 14h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M18 15.5v5l4-2.5-4-2.5z" fill="currentColor" /></svg>
                  )}
                </div>
                <div className="text-[16px] font-semibold">{t === "video" ? "Single video" : "Playlist"}</div>
                <div className="t-small text-slate-400">{t === "video" ? "One link: YouTube, Drive, or a video file" : "One entry holding multiple videos"}</div>
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-2.5">
          <span className="t-eyebrow">Title</span>
          <div className="flex gap-3">
            <input data-focusable value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Movie night: Interstellar" className={inputCls + " flex-1"} />
            <button data-focusable onClick={fetchTitle} disabled={fetching} className="shrink-0 rounded-2xl border border-white/10 bg-white/[0.05] px-5 text-sm font-medium text-slate-200 hover:bg-white/[0.1] disabled:opacity-50">
              {fetching ? <Spinner /> : "Fetch title"}
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-2.5">
          <span className="t-eyebrow">Description (optional)</span>
          <textarea data-focusable value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Anything worth remembering about it" className={inputCls} />
        </label>

        <div className="flex flex-col gap-3">
          <span className="t-eyebrow">{type === "video" ? "Link" : "Links"}</span>
          {videos.map((v, i) => (
            <div key={v.id} className="flex flex-col gap-2.5">
              <div className="flex gap-3">
                <input
                  data-focusable
                  value={v.url}
                  onChange={(e) => setUrl(i, e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=... or https://drive.google.com/file/d/..."
                  className={inputCls + " flex-1 font-mono !text-[13px]"}
                />
                {type === "playlist" && videos.length > 1 && (
                  <button data-focusable onClick={() => setVideos((arr) => arr.filter((_, j) => j !== i))} className="shrink-0 rounded-2xl border border-white/10 bg-white/[0.05] px-4 text-slate-400 hover:bg-white/[0.1]">
                    x
                  </button>
                )}
              </div>
              <LinkHint url={v.url} />
            </div>
          ))}
          {type === "playlist" && (
            <button data-focusable onClick={() => setVideos((arr) => [...arr, library.makeVideo("")])} className="self-start rounded-2xl border border-dashed border-white/20 px-5 py-3 text-sm font-medium text-slate-300 hover:bg-white/[0.05]">
              + Add another video
            </button>
          )}
        </div>

        {error && <div className="rounded-2xl border border-red-400/30 bg-red-500/[0.08] p-4 text-sm text-red-300">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button data-focusable onClick={save} className="bright rounded-2xl bg-white px-8 py-3.5 text-[15px] font-bold text-black">
            {existing ? "Save changes" : "Add to shelf"}
          </button>
          <button data-focusable onClick={() => goBack("/")} className="rounded-2xl border border-white/10 bg-white/[0.05] px-6 py-3.5 text-[15px] font-medium text-slate-200 hover:bg-white/[0.1]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
