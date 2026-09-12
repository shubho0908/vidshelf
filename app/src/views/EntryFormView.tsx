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
    <div className={`flex items-center gap-3 rounded-xl border p-2.5 text-[13px] ${ok ? "border-white/10 bg-white/[0.03]" : "border-red-500/30 bg-red-500/[0.06]"}`}>
      {thumb && (
        <div className="h-10 w-[72px] shrink-0 overflow-hidden rounded-lg">
          <Thumb src={thumb} title="" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <KindBadge kind={parsed.kind} label={parsed.label} />
        {!ok && <div className="mt-1 text-red-300">{parsed.blockReason}</div>}
        {ok && parsed.kind === "drive" && <div className="mt-1 text-slate-400">Plays via Google Drive preview (max 1080p, file must be shared).</div>}
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

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 p-5 md:p-10">
      <div className="flex items-center gap-3">
        <button data-focusable onClick={() => goBack("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08]">
          Back
        </button>
        <h1 className="heading text-xl font-bold">{existing ? "Edit entry" : "Add to shelf"}</h1>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {(["video", "playlist"] as const).map((t) => (
          <button
            key={t}
            data-focusable
            onClick={() => setType(t)}
            className={`rounded-2xl border p-4 text-left transition-colors ${type === t ? "border-blue-400/60 bg-blue-500/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}
          >
            <div className="text-[15px] font-semibold">{t === "video" ? "Single video" : "Playlist"}</div>
            <div className="mt-0.5 text-[13px] text-slate-400">{t === "video" ? "One link: YouTube, Drive, or a video file" : "One entry holding multiple videos"}</div>
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-slate-300">Title</span>
        <div className="flex gap-2">
          <input
            data-focusable
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Movie night: Interstellar"
            className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-blue-400/60"
          />
          <button data-focusable onClick={fetchTitle} disabled={fetching} className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.08] disabled:opacity-50">
            {fetching ? <Spinner /> : "Fetch title"}
          </button>
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-slate-300">Description <span className="text-slate-500">(optional)</span></span>
        <textarea
          data-focusable
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Anything worth remembering about it"
          className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-blue-400/60"
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-300">{type === "video" ? "Link" : "Links"}</span>
        {videos.map((v, i) => (
          <div key={v.id} className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                data-focusable
                value={v.url}
                onChange={(e) => setUrl(i, e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... or https://drive.google.com/file/d/..."
                className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-blue-400/60"
              />
              {type === "playlist" && videos.length > 1 && (
                <button data-focusable onClick={() => setVideos((arr) => arr.filter((_, j) => j !== i))} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 text-slate-400 hover:bg-white/[0.08]">
                  x
                </button>
              )}
            </div>
            <LinkHint url={v.url} />
          </div>
        ))}
        {type === "playlist" && (
          <button data-focusable onClick={() => setVideos((arr) => [...arr, library.makeVideo("")])} className="self-start rounded-xl border border-dashed border-white/15 bg-transparent px-4 py-2 text-sm text-slate-300 hover:bg-white/[0.05]">
            + Add another video
          </button>
        )}
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/[0.08] p-3 text-sm text-red-300">{error}</div>}

      <div className="flex gap-3 pb-8">
        <button data-focusable onClick={save} className="rounded-xl bg-blue-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-400">
          {existing ? "Save changes" : "Add to shelf"}
        </button>
        <button data-focusable onClick={() => goBack("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm text-slate-300 hover:bg-white/[0.08]">
          Cancel
        </button>
      </div>
    </div>
  );
}
