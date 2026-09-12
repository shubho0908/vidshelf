import { useMemo, useRef, useState } from "react";
import { scheduleSync } from "../lib/sync";
import { entryThumbIds, library, type VideoItem } from "../lib/storage";
import { parseLink } from "../lib/router";
import { fetchRemoteTitle, thumbnailForUrl } from "../lib/thumbnails";
import { canUploadThumbs, makeThumb } from "../lib/thumbmake";
import { markThumbDirty, newThumbId, putThumb, retireThumb } from "../lib/thumbstore";
import { goBack } from "../lib/route";
import { KindBadge, Spinner, Thumb, useCustomThumb } from "../components/bits";

interface ThumbSel {
  id: string;
  v: number;
}

/** 16:9 custom-thumbnail picker. Upload: strict-validate, encode, store
 *  locally (atomic), queue cloud upload. Replaced/removed ids are handed back
 *  via onReplace so the form can retire them on save (committed) or right away
 *  (staged this session). Hidden entirely on webOS (no TV file picker). */
function ThumbField({
  value,
  autoSrc,
  compact,
  onPick,
  onStage,
  onReplace,
}: {
  value: ThumbSel | null;
  autoSrc: string | null;
  compact?: boolean;
  onPick: (v: ThumbSel | null) => void;
  onStage: (id: string) => void;
  onReplace: (oldId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const custom = useCustomThumb(value?.id, value?.v);
  const shown = custom ?? autoSrc;

  const pick = async (f: File) => {
    setErr("");
    setBusy(true);
    try {
      const made = await makeThumb(f);
      const id = newThumbId();
      const v = (value?.v ?? 0) + 1;
      await putThumb({ id, blob: made.blob, v, mime: made.mime });
      markThumbDirty(id);
      onStage(id);
      if (value) onReplace(value.id);
      onPick({ id, v });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not use that image.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = () => {
    if (value) onReplace(value.id);
    onPick(null);
    setErr("");
  };

  return (
    <div className={`flex ${compact ? "flex-row items-center gap-3" : "flex-col gap-3"}`}>
      <div className={`${compact ? "h-12 w-[84px]" : "aspect-video w-full max-w-xs"} shrink-0 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03]`}>
        <Thumb src={shown} title="" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            data-focusable
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2 text-[13px] font-medium text-slate-200 hover:bg-white/[0.12] disabled:opacity-50"
          >
            {busy ? <Spinner /> : value ? "Replace image" : "Upload image"}
          </button>
          {value && (
            <button
              data-focusable
              type="button"
              onClick={remove}
              className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-[13px] text-slate-400 hover:bg-white/[0.08]"
            >
              Remove
            </button>
          )}
          {!compact && <span className="t-small text-slate-500">Strictly 16:9, up to 1MB. Stored as a small 1280x720 image.</span>}
        </div>
        {value && <div className="t-small text-emerald-300/80">Custom thumbnail set - syncs to your other devices.</div>}
        {err && <div className="t-small text-red-300">{err}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])}
      />
    </div>
  );
}

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
  const [entryThumb, setEntryThumb] = useState<ThumbSel | null>(
    existing?.thumbId ? { id: existing.thumbId, v: existing.thumbV ?? 1 } : null
  );
  // Thumbnail lifecycle tracking: ids created this session retire freely;
  // ids committed on the entry retire only when the save lands.
  const staged = useRef(new Set<string>());
  const retireLater = useRef<string[]>([]);
  const uploadsAllowed = canUploadThumbs();
  const stageId = (id: string) => staged.current.add(id);
  const replaced = (oldId: string) => {
    if (staged.current.has(oldId)) void retireThumb(oldId);
    else retireLater.current.push(oldId);
  };

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
    const patch = {
      type,
      title: title.trim(),
      description: description.trim(),
      videos: finalVideos,
      thumbId: entryThumb?.id,
      thumbV: entryThumb?.v,
    };
    if (existing) library.update(existing.id, patch);
    else library.create(patch);
    // Retire thumbnails that are no longer referenced by what was saved.
    const referenced = new Set<string>([
      ...(entryThumb ? [entryThumb.id] : []),
      ...finalVideos.map((v) => v.thumbId).filter((x): x is string => !!x),
    ]);
    for (const id of staged.current) if (!referenced.has(id)) void retireThumb(id);
    for (const id of retireLater.current) if (!referenced.has(id)) void retireThumb(id);
    staged.current.clear();
    retireLater.current = [];
    scheduleSync();
    goBack("/");
  };

  const cancel = () => {
    // Keep only what the saved entry still references; drop the rest locally.
    const keep = new Set(existing ? entryThumbIds(existing) : []);
    for (const id of staged.current) if (!keep.has(id)) void retireThumb(id);
    goBack("/");
  };

  const inputCls = "w-full rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 text-[15px] outline-none placeholder:text-slate-500 focus:border-white/40";

  return (
    <div className="flex min-h-full w-full flex-col">
      <header className="chrome tv-safe fixed inset-x-0 top-0 z-30 flex flex-wrap items-center gap-2.5 px-4 py-3.5 sm:gap-3 sm:px-5 md:px-10">
        <button data-focusable onClick={cancel} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:bg-white/[0.12]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back
        </button>
        <h1 className="t-title">{existing ? "Edit entry" : "Add to shelf"}</h1>
      </header>

      <div className="tv-safe mx-auto flex w-full max-w-2xl flex-col gap-7 px-5 pb-16 pt-chrome-lg md:px-10">
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

        <div className="flex flex-col gap-2.5">
          <span className="t-eyebrow">Custom thumbnail (optional)</span>
          {uploadsAllowed ? (
            <ThumbField
              value={entryThumb}
              autoSrc={thumbnailForUrl(videos[0]?.url ?? "")}
              onPick={setEntryThumb}
              onStage={stageId}
              onReplace={replaced}
            />
          ) : (
            <p className="t-small text-slate-500">Add custom thumbnails from your Mac or phone - they sync to this TV automatically.</p>
          )}
        </div>

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
              {type === "playlist" && uploadsAllowed && (
                <ThumbField
                  compact
                  value={v.thumbId ? { id: v.thumbId, v: v.thumbV ?? 1 } : null}
                  autoSrc={thumbnailForUrl(v.url)}
                  onPick={(sel) =>
                    setVideos((arr) => arr.map((it, j) => (j === i ? { ...it, thumbId: sel?.id, thumbV: sel?.v } : it)))
                  }
                  onStage={stageId}
                  onReplace={replaced}
                />
              )}
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
          <button data-focusable onClick={cancel} className="rounded-2xl border border-white/10 bg-white/[0.05] px-6 py-3.5 text-[15px] font-medium text-slate-200 hover:bg-white/[0.1]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
