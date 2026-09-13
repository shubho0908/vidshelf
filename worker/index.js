// VidShelf sync worker - MULTI-TENANT v2.
// Any well-formed sync key maps to an isolated namespace: ns = sha256(key).
// No taken-check endpoint exists (enumeration oracle) - clients generate a
// 48-char random key; a collision just produces a shared namespace by luck
// (2^-192), and clients regenerate silently if they ever see foreign data.
//
// Endpoints (sync endpoints require header X-Sync-Key):
//   GET  /pull            -> { entries: [...], tombstones: {...} } for caller's ns
//   POST /push            -> { entries, tombstones } LWW on updatedAt
//                            quota: MAX_ENTRIES per ns (default 2000) -> 429
//                            write rate: WRITES_PER_HOUR per ns (default 240) -> 429
//   PUT/GET/DELETE /thumb/:id      -> R2, namespaced <ns>/<id>
//   POST /thumb-deletions          -> { ids } batch delete in caller's ns
//   GET  /thumb-index              -> thumbs in caller's ns (orphan sweep)
//   POST /pair/start      -> PUBLIC (IP-limited). {code, token, expires_in}
//   GET  /pair/status     -> PUBLIC (IP-limited). pending | approved(+key, once) | expired
//   POST /pair/approve    -> authed. binds caller's key to a pending code. 5 fails = 10-min lock
//   POST /rotate          -> authed. migrates ns to caller-supplied new key (D1 re-key + R2
//                            re-prefix + tombstones); old ns revoked instantly (401 key_revoked)
//   GET  /download/dmg            -> PUBLIC. R2-cached release asset, Cache API
//                            in front, GitHub PAT only on cold miss.
//                            Per-IP combined budget: 3 downloads/min -> 429 +
//                            Retry-After; 3 strikes while limited -> 30 min
//                            cooldown. Only successful serves consume budget.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
};

const THUMB_ID = /^t_[A-Za-z0-9_-]{6,64}$/;
const THUMB_MIME = { "image/webp": 1, "image/jpeg": 1 };
const THUMB_MAX = 512 * 1024;
const KEY_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_ENTRIES_DEFAULT = 2000;
const WRITES_PER_HOUR_DEFAULT = 240;
const DL_PER_MIN = 3;          // combined across apk/ipk/dmg, per IP
const DL_STRIKES = 3;          // limited-hits before cooldown
const DL_COOLDOWN_S = 1800;    // 30 min

// --- home-server media (R2): READ-ONLY by design ----------------------------
// The MEDIA bucket stays PRIVATE; bytes exit ONLY through the two GET routes
// below. There is NO app-callable write/upload endpoint anywhere in this
// worker - media is added out-of-band (wrangler/CI), never from an app.
// Abuse gates: unguessable 24-hex media ids, per-IP minute limits, and a
// global daily stream budget that trips long before the free-tier worker
// request quota (100k/day) is at risk.
const MEDIA_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MEDIA_CAT_PER_MIN = 30;      // catalog JSON is a few KB
const MEDIA_STREAM_PER_MIN = 240;  // each seek costs one range request
const MEDIA_THUMB_PER_MIN = 60;
const MEDIA_PLAYER_PER_MIN = 120;  // every YouTube play loads the player page
const MEDIA_STREAMS_PER_DAY = 48000; // global circuit breaker, all IPs combined

// YouTube IFrame player page (self-hosted; replaces the old GitHub Pages
// dependency - the vidshelf-player repo can stay private). Any real HTTPS
// origin satisfies YouTube's Referer check, so webOS/Tauri webviews play.
const PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VidShelf Player</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  #player { width: 100%; height: 100%; }
  .err { color: #cbd5e1; font: 16px/1.5 system-ui, sans-serif; display: flex; height: 100%;
         align-items: center; justify-content: center; text-align: center; padding: 24px; box-sizing: border-box; }
</style>
</head>
<body>
<div id="player"></div>
<script>
  const v = new URLSearchParams(location.search).get('v');
  const show = (m) => { document.body.innerHTML = '<div class="err"></div>'; document.querySelector('.err').textContent = m; };
  if (!v || !/^[A-Za-z0-9_-]{11}$/.test(v)) {
    show('No video specified.');
  } else {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      new YT.Player('player', {
        videoId: v,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, vq: 'highres' },
        events: {
          // Prefer the highest available rendition; YouTube still adapts down
          // automatically on weak bandwidth, so this never stalls playback.
          onReady: (e) => e.target.setPlaybackQuality('highres'),
          onError: (e) => {
            const map = {
              2: 'Invalid video ID.',
              5: 'This video cannot play in an embedded player.',
              100: 'Video not found or private.',
              101: 'The owner does not allow embedding this video.',
              150: 'The owner does not allow embedding this video.',
              153: 'Player configuration error.'
            };
            show(map[e.data] || 'Playback error (' + e.data + ').');
          }
        }
      });
    };
  }
</script>
</body>
</html>
`;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

async function nsOf(key) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function keyOk(key) {
  // Hex keys (48 chars = 192 bits) only have 16 possible symbols, so the bar
  // is "not obviously degenerate": 10+ distinct symbols rejects aaaa.../abab...
  // patterns while never rejecting a real random key.
  if (!KEY_SHAPE.test(key)) return false;
  return new Set(key).size >= 10;
}


// Constant-time string compare for the owner key check.
function keyEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// --- device pairing ----------------------------------------------------------
// 256 % 32 == 0, so the modulo below is unbiased. Alphabet drops 0/O/1/I/L.
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_TTL_S = 600;
const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_S = 600;

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
}

// Small fixed-window limiter over ip_rate for unauthenticated/utility endpoints.
async function rateGate(env, scope, id, windowS, limit) {
  const win = Math.floor(Date.now() / (windowS * 1000));
  const rid = scope + ":" + id;
  await env.DB.prepare(
    "INSERT INTO ip_rate (id, win, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(id) DO UPDATE SET count = CASE WHEN ip_rate.win = excluded.win THEN ip_rate.count + 1 ELSE 1 END, win = excluded.win"
  ).bind(rid, win).run();
  const row = await env.DB.prepare("SELECT count FROM ip_rate WHERE id = ?").bind(rid).first();
  return (row?.count ?? 0) <= limit;
}

// --- in-isolate hot-path limiting/caching -----------------------------------
// Range requests are the hottest path in the system (every play, every seek).
// Paying 5 sequential D1 round trips per range (2 limiters + media lookup)
// added hundreds of ms to every seek, so the hot path stays in-isolate:
// - per-minute burst gates become per-isolate fixed windows (burst smoothing
//   is best-effort by nature; the daily breaker stays the hard stop),
// - the daily global breaker is sampled once per minute per isolate: it still
//   trips under a storm (many isolates x samples) without D1 per request,
// - media rows are cached by id; ids are immutable per upload, and a deleted
//   row's object is gone too, so a stale entry still 404s at the R2 get.
const localBuckets = new Map(); // "scope:id" -> {win, count}
function rateGateLocal(scope, id, windowS, limit) {
  const win = Math.floor(Date.now() / (windowS * 1000));
  const k = scope + ":" + id;
  const e = localBuckets.get(k);
  if (e && e.win === win) { e.count++; return e.count <= limit; }
  localBuckets.set(k, { win, count: 1 });
  return true;
}
let dailyOkUntil = 0, dailyOk = true;
async function dailyStreamBudget(env) {
  const now = Date.now();
  if (now < dailyOkUntil) return dailyOk;
  dailyOk = await rateGate(env, "mediaday", "global", 86400, MEDIA_STREAMS_PER_DAY);
  dailyOkUntil = now + 60_000;
  return dailyOk;
}
const mediaRowCache = new Map(); // id -> { r2_key, size_bytes, content_type }
async function mediaRow(env, id) {
  let row = mediaRowCache.get(id);
  if (row) return row;
  row = await env.DB.prepare(
    "SELECT r2_key, size_bytes, content_type FROM media_videos WHERE id = ?"
  ).bind(id).first();
  if (row) mediaRowCache.set(id, row);
  return row;
}

// --- sync write rate limit: one row per (ns, hour bucket) -------------------
async function writeBudget(env, ns) {
  const perHour = Number(env.WRITES_PER_HOUR) || WRITES_PER_HOUR_DEFAULT;
  const bucket = Math.floor(Date.now() / 3600000);
  await env.DB.prepare(
    "INSERT INTO wrate (ns, bucket, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(ns, bucket) DO UPDATE SET count = count + 1"
  ).bind(ns, bucket).run();
  const row = await env.DB.prepare(
    "SELECT count FROM wrate WHERE ns = ? AND bucket = ?"
  ).bind(ns, bucket).first();
  return (row?.count ?? 0) <= perHour;
}

// --- per-IP download rate limit with escalation ------------------------------
// dl_rate: ip PK, win (minute bucket), count, strikes, cooldown_until (epoch s)
async function dlGate(env, ip, consume) {
  const nowS = Math.floor(Date.now() / 1000);
  const win = Math.floor(nowS / 60);
  let r = await env.DB.prepare("SELECT * FROM dl_rate WHERE ip = ?").bind(ip).first();
  if (!r) r = { ip, win, count: 0, strikes: 0, cooldown_until: 0 };

  if ((r.cooldown_until || 0) > nowS) {
    return { ok: false, retry: r.cooldown_until - nowS, reason: "cooldown" };
  }
  if (r.win !== win) { r.win = win; r.count = 0; }

  if (r.count >= DL_PER_MIN) {
    // limited hit: count the strike, escalate at DL_STRIKES
    r.strikes = (r.strikes || 0) + 1;
    let retry = 60 - (nowS % 60);
    if (r.strikes >= DL_STRIKES) {
      r.cooldown_until = nowS + DL_COOLDOWN_S;
      r.strikes = 0;
      retry = DL_COOLDOWN_S;
    }
    await env.DB.prepare(
      "INSERT INTO dl_rate (ip, win, count, strikes, cooldown_until) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(ip) DO UPDATE SET win=excluded.win, count=excluded.count, strikes=excluded.strikes, cooldown_until=excluded.cooldown_until"
    ).bind(ip, r.win, r.count, r.strikes, r.cooldown_until || 0).run();
    return { ok: false, retry, reason: r.cooldown_until ? "cooldown" : "limited" };
  }
  if (consume) {
    r.count++;
    await env.DB.prepare(
      "INSERT INTO dl_rate (ip, win, count, strikes, cooldown_until) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(ip) DO UPDATE SET win=excluded.win, count=excluded.count, strikes=excluded.strikes, cooldown_until=excluded.cooldown_until"
    ).bind(ip, r.win, r.count, r.strikes || 0, r.cooldown_until || 0).run();
  }
  return { ok: true };
}

async function fullState(env, ns) {
  const entries = await env.DB.prepare(
    "SELECT data FROM entries_v2 WHERE ns = ? AND deleted = 0"
  ).bind(ns).all();
  const tombs = await env.DB.prepare(
    "SELECT id, updated_at FROM entries_v2 WHERE ns = ? AND deleted = 1"
  ).bind(ns).all();
  const tombstones = {};
  for (const r of tombs.results) tombstones[r.id] = r.updated_at;
  return { entries: entries.results.map((r) => JSON.parse(r.data)), tombstones };
}

// Latest release lookup, Cache API front (5 min) so the PAT stays cold.
// Pick the newest published release that actually HAS the requested asset.
// /releases/latest alone races the asset upload: a tag publishes the release
// before CI finishes uploading binaries, and users hit "asset missing".
async function releaseWithAsset(env, cache, kind, pat) {
  const cacheKey = new Request("https://vidshelf.internal/release-for/" + kind);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const gh = { headers: { Authorization: "Bearer " + env.GH_RELEASE_TOKEN, "User-Agent": "vidshelf-sync", Accept: "application/vnd.github+json" } };
  const res = await fetch("https://api.github.com/repos/shubho0908/vidshelf/releases?per_page=10", gh);
  if (!res.ok) return null;
  const list = await res.json();
  const rel = (Array.isArray(list) ? list : []).find((r) => !r.draft && (r.assets || []).some((a) => pat.test(a.name)));
  if (rel) {
    await cache.put(cacheKey, new Response(JSON.stringify(rel), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" },
    }));
  }
  return rel || null;
}

// Auto-warm: every few minutes, mirror the newest release assets into R2 so
// the first real user download is served hot, not streamed cold from GitHub.
const DL_PATTERNS = { dmg: /\.dmg$/ };

async function warmReleases(env) {
  const cache = caches.default;
  const liveKeys = new Set();
  for (const [kind, pat] of Object.entries(DL_PATTERNS)) {
    const rel = await releaseWithAsset(env, cache, kind, pat).catch(() => null);
    if (!rel) continue;
    const asset = (rel.assets || []).find((a) => pat.test(a.name));
    if (!asset) continue;
    const key = "releases/" + rel.tag_name + "/" + asset.name;
    liveKeys.add(key);
    if (await env.THUMBS.head(key)) continue;
    const resp = await fetch(asset.url, {
      headers: { Authorization: "Bearer " + env.GH_RELEASE_TOKEN, Accept: "application/octet-stream", "User-Agent": "vidshelf-sync" },
    });
    if (!resp.ok || !resp.body) continue;
    await env.THUMBS.put(key, resp.body, { httpMetadata: { contentType: "application/octet-stream" } });
  }
  // latest-only rollover, same rule as the download route
  const listed = await env.THUMBS.list({ prefix: "releases/" });
  const stale = listed.objects.filter((o) => !liveKeys.has(o.key)).map((o) => o.key);
  if (stale.length) await env.THUMBS.delete(stale);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warmReleases(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    // ---- public downloads: R2 + Cache API, GitHub only on cold miss --------
    const dl = url.pathname.match(/^\/download\/(dmg)$/);
    if (dl) {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const gate = await dlGate(env, ip, false); // check first, consume on success
      if (!gate.ok) {
        return json({ error: "rate_limited", reason: gate.reason, retry_after: gate.retry },
          429, { "Retry-After": String(gate.retry) });
      }
      // Cheap preflight for the landing page: probe never consumes budget.
      if (request.headers.get("Range") === "bytes=0-0") {
        return new Response(null, { status: 204, headers: CORS });
      }

      const cache = caches.default;
      const pat = /\.dmg$/;

      // Resolve current asset name via (cached) latest release.
      const rel = await releaseWithAsset(env, cache, dl[1], pat).catch(() => null);
      if (!rel) return json({ error: "release lookup failed" }, 502);
      const asset = (rel.assets || []).find((a) => pat.test(a.name));
      if (!asset) return json({ error: "asset missing" }, 404);

      const tag = rel.tag_name || "unknown";
      const r2key = `releases/${tag}/${asset.name}`;
      const serveKey = new Request(url.origin + "/release/" + tag + "/" + asset.name);

      const cached = await cache.match(serveKey);
      if (cached) {
        await dlGate(env, ip, true); // served: consume budget
        const h = new Headers(cached.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
        return new Response(cached.body, { headers: h });
      }

      // Streamed throughout: a 126MB apk must never buffer into worker memory.
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${asset.name}"`,
        "Cache-Control": "public, max-age=300",
        ...CORS,
      };
      let obj = await env.THUMBS.get(r2key);
      if (obj) {
        const [toClient, toCache] = obj.body.tee();
        await dlGate(env, ip, true); // about to serve: consume budget
        ctx.waitUntil(cache.put(serveKey, new Response(toCache, { headers })));
        return new Response(toClient, { headers });
      }
      // cold miss: pull from GitHub once, fan out to client + R2 + cache
      const bin = await fetch(asset.url, { headers: { Authorization: "Bearer " + env.GH_RELEASE_TOKEN, "User-Agent": "vidshelf-sync", Accept: "application/octet-stream" } });
      if (!bin.ok || !bin.body) return json({ error: "asset fetch failed" }, 502);
      const [toClient, rest] = bin.body.tee();
      const [toR2, toCache] = rest.tee();
      await dlGate(env, ip, true); // about to serve: consume budget
      ctx.waitUntil((async () => {
        await env.THUMBS.put(r2key, toR2, { httpMetadata: { contentType: "application/octet-stream" } });
        // latest-only: older release folders are deleted silently on tag rollover
        const listed = await env.THUMBS.list({ prefix: "releases/" });
        const stale = listed.objects.filter((o) => !o.key.startsWith("releases/" + tag + "/")).map((o) => o.key);
        if (stale.length) await env.THUMBS.delete(stale);
      })());
      ctx.waitUntil(cache.put(serveKey, new Response(toCache, { headers })));
      return new Response(toClient, { headers });
    }

    // ---- YouTube player page (public, tiny, cacheable) ------------------
    if (url.pathname === "/player" || url.pathname === "/player.html") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateGate(env, "player", ip, 60, MEDIA_PLAYER_PER_MIN))) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      return new Response(PLAYER_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600", ...CORS },
      });
    }

    // ---- home-server media catalog (public read, server-managed only) ----
    // --- owner-gated media delete ------------------------------------------
    // Only the owner key (the one baked into the binaries / entered on the
    // web app) may delete home-server media. Auth is checked BEFORE any
    // storage op, so abuse costs zero D1/R2. A successful delete costs
    // exactly one D1 row delete + one R2 object delete. No listing, no
    // scanning, no read-back.
    const dm = url.pathname.match(/^\/media\/([A-Za-z0-9_-]{16,64})$/);
    if (dm && request.method === "DELETE") {
      const key = request.headers.get("X-Sync-Key") || "";
      if (!env.VIDSHELF_KEY || !keyEq(key, env.VIDSHELF_KEY))
        return json({ ok: false, error: "forbidden" }, 403);
      const id = dm[1];
      const res = await env.DB.prepare("DELETE FROM media_videos WHERE id = ?").bind(id).run();
      await env.MEDIA.delete([`media/${id}`, `media/${id}.webp`]); // video + poster
      return json({ ok: true, removed: (res.meta?.changes ?? 0) > 0 });
    }

    if (url.pathname === "/media/catalog") {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateGate(env, "mediacat", ip, 60, MEDIA_CAT_PER_MIN))) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      const rows = await env.DB.prepare(
        "SELECT id, title, description, size_bytes, content_type, duration_sec, position, has_thumb, added_at FROM media_videos ORDER BY position ASC, added_at DESC"
      ).all();
      return json({
        videos: rows.results.map((r) => ({
          id: r.id, title: r.title, description: r.description || "",
          sizeBytes: r.size_bytes, contentType: r.content_type,
          durationSec: r.duration_sec, position: r.position,
          hasThumb: !!r.has_thumb, addedAt: r.added_at,
        })),
      }, 200, { "Cache-Control": "public, max-age=5" });
    }

    // ---- media bytes: R2 private bucket, full Range support ----------------
    const mm = url.pathname.match(/^\/media\/stream\/([A-Za-z0-9_-]{16,64})$/);
    if (mm) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateGateLocal("mediastream", ip, 60, MEDIA_STREAM_PER_MIN)) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      // Global daily circuit breaker (sampled per isolate): trips at ~half the
      // free worker quota, so a hotlink storm can never take pairing/sync/
      // downloads down with it.
      if (!(await dailyStreamBudget(env))) {
        return json({ error: "daily_budget" }, 503, { "Retry-After": "3600" });
      }
      const row = await mediaRow(env, mm[1]);
      if (!row) return json({ error: "not found" }, 404);
      const size = Number(row.size_bytes) || 0;
      let start = 0, end = size - 1, status = 200;
      const rm = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") || "");
      if (rm) {
        start = Number(rm[1]);
        if (rm[2]) end = Math.min(Number(rm[2]), size - 1);
        if (start >= size || end < start) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, ...CORS } });
        }
        status = 206;
      }
      const obj = await env.MEDIA.get(row.r2_key, {
        range: { offset: start, length: end - start + 1 },
      });
      if (!obj) return json({ error: "object missing" }, 404);
      const h = new Headers();
      h.set("Content-Type", row.content_type || "video/mp4");
      h.set("Accept-Ranges", "bytes");
      h.set("Content-Length", String(end - start + 1));
      if (status === 206) h.set("Content-Range", `bytes ${start}-${end}/${size}`);
      h.set("Cache-Control", "public, max-age=86400, immutable");
      Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      return new Response(request.method === "HEAD" ? null : obj.body, { status, headers: h });
    }

    // ---- media thumbnails (poster frames extracted at ingest) --------------
    const mt = url.pathname.match(/^\/media\/thumb\/([A-Za-z0-9_-]{16,64})$/);
    if (mt) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateGateLocal("mediathumb", ip, 60, MEDIA_THUMB_PER_MIN)) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      const obj = await env.MEDIA.get("media/" + mt[1] + ".webp");
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(request.method === "HEAD" ? null : obj.body, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...CORS,
        },
      });
    }

    // ---- device pairing: public endpoints (IP-limited, tiny tables) --------
    if (url.pathname === "/pair/start") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateGate(env, "pairstart", ip, 60, 20))) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      const now = Date.now();
      await env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(now).run();
      let code = "", free = false;
      for (let i = 0; i < 5 && !free; i++) {
        code = makeCode();
        free = !(await env.DB.prepare("SELECT code FROM pair_codes WHERE code = ?").bind(code).first());
      }
      if (!free) return json({ error: "busy" }, 503);
      const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare(
        "INSERT INTO pair_codes (code, token, status, expires_at, created_at) VALUES (?, ?, 'pending', ?, ?)"
      ).bind(code, token, now + PAIR_TTL_S * 1000, now).run();
      return json({ code, token, expires_in: PAIR_TTL_S });
    }

    if (url.pathname === "/pair/status") {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateGate(env, "pairstatus", ip, 60, 40))) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      const token = url.searchParams.get("token") || "";
      if (!/^[0-9a-f]{32}$/.test(token)) return json({ error: "bad token" }, 400);
      const row = await env.DB.prepare("SELECT status, key, expires_at FROM pair_codes WHERE token = ?").bind(token).first();
      if (!row) return json({ status: "expired" }); // unknown or already-consumed token
      if (row.expires_at < Date.now()) {
        await env.DB.prepare("DELETE FROM pair_codes WHERE token = ?").bind(token).run();
        return json({ status: "expired" });
      }
      if (row.status === "approved") {
        // deliver the key exactly once, then destroy the record
        await env.DB.prepare("DELETE FROM pair_codes WHERE token = ?").bind(token).run();
        return json({ status: "approved", key: row.key });
      }
      return json({ status: "pending" });
    }

    // ---- everything below requires a well-formed key -----------------------
    const key = request.headers.get("X-Sync-Key") || "";
    if (!keyOk(key)) return json({ error: "unauthorized" }, 401);
    const ns = await nsOf(key);
    if (await env.DB.prepare("SELECT ns FROM revoked_ns WHERE ns = ?").bind(ns).first()) {
      return json({ error: "key_revoked" }, 401);
    }

    try {
      if (url.pathname === "/pull" && request.method === "GET") {
        return json(await fullState(env, ns));
      }

      if (url.pathname === "/pair/approve" && request.method === "POST") {
        const nowS = Math.floor(Date.now() / 1000);
        const lock = await env.DB.prepare("SELECT fails, locked_until FROM pair_lock WHERE ns = ?").bind(ns).first();
        if (lock && lock.locked_until > nowS) {
          return json({ error: "locked", retry_after: lock.locked_until - nowS }, 429,
            { "Retry-After": String(lock.locked_until - nowS) });
        }
        const body = await request.json().catch(() => ({}));
        const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        const row = code
          ? await env.DB.prepare("SELECT status, expires_at FROM pair_codes WHERE code = ?").bind(code).first()
          : null;
        const valid = row && row.status === "pending" && row.expires_at > Date.now();
        if (!valid) {
          const fails = (lock?.fails || 0) + 1;
          const hitMax = fails >= PAIR_MAX_FAILS;
          await env.DB.prepare(
            "INSERT INTO pair_lock (ns, fails, locked_until) VALUES (?, ?, ?) " +
            "ON CONFLICT(ns) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until"
          ).bind(ns, hitMax ? 0 : fails, hitMax ? nowS + PAIR_LOCK_S : 0).run();
          return json({ error: "invalid_code", attempt: fails }, 404);
        }
        await env.DB.prepare(
          "UPDATE pair_codes SET status = 'approved', key = ? WHERE code = ? AND status = 'pending'"
        ).bind(key, code).run();
        await env.DB.prepare("DELETE FROM pair_lock WHERE ns = ?").bind(ns).run();
        return json({ ok: true });
      }

      if (url.pathname === "/rotate" && request.method === "POST") {
        if (!(await rateGate(env, "rotate", ns, 3600, 6))) {
          return json({ error: "rate_limited", scope: "rotate" }, 429, { "Retry-After": "3600" });
        }
        const body = await request.json().catch(() => ({}));
        const newKey = String(body.newKey || "");
        if (!keyOk(newKey)) return json({ error: "bad_new_key" }, 400);
        const newNs = await nsOf(newKey);
        if (newNs === ns) return json({ error: "same_key" }, 400);

        // D1 re-key: tombstones are rows in entries_v2, they migrate with it.
        await env.DB.batch([
          env.DB.prepare("UPDATE entries_v2 SET ns = ? WHERE ns = ?").bind(newNs, ns),
          env.DB.prepare("UPDATE wrate SET ns = ? WHERE ns = ?").bind(newNs, ns),
          env.DB.prepare("DELETE FROM pair_lock WHERE ns = ?").bind(ns),
          env.DB.prepare("INSERT OR REPLACE INTO revoked_ns (ns, at) VALUES (?, ?)").bind(ns, Date.now()),
          env.DB.prepare("DELETE FROM revoked_ns WHERE at < ?").bind(Date.now() - 30 * 86400000),
        ]);

        // R2 thumbs re-prefix (get+put per object; thumbs are small and few).
        let cursor; const oldKeys = [];
        do {
          const page = await env.THUMBS.list({ prefix: ns + "/", limit: 1000, cursor });
          for (const o of page.objects) {
            const obj = await env.THUMBS.get(o.key);
            if (obj) await env.THUMBS.put(newNs + o.key.slice(ns.length), obj.body, { httpMetadata: obj.httpMetadata });
            oldKeys.push(o.key);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        if (oldKeys.length) await env.THUMBS.delete(oldKeys);
        return json({ ok: true, migrated_thumbs: oldKeys.length });
      }

      if (url.pathname === "/push" && request.method === "POST") {
        if (!(await writeBudget(env, ns))) {
          return json({ error: "rate_limited", scope: "sync_writes", retry_after: 3600 - (Math.floor(Date.now() / 1000) % 3600) }, 429);
        }
        const body = await request.json();
        const incoming = Array.isArray(body.entries) ? body.entries : [];
        const tombs = body.tombstones && typeof body.tombstones === "object" ? body.tombstones : {};

        // per-namespace entry quota
        const maxEntries = Number(env.MAX_ENTRIES) || MAX_ENTRIES_DEFAULT;
        const cnt = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM entries_v2 WHERE ns = ? AND deleted = 0"
        ).bind(ns).first();
        const liveNew = incoming.filter((e) => e && e.id && Array.isArray(e.videos)).length;
        if ((cnt?.c ?? 0) + liveNew > maxEntries) {
          return json({ error: "quota_exceeded", max_entries: maxEntries }, 429);
        }

        const ids = [...incoming.map((e) => e && e.id), ...Object.keys(tombs)].filter(Boolean);
        let existing = new Map();
        if (ids.length) {
          const marks = ids.map(() => "?").join(",");
          const rows = await env.DB.prepare(
            `SELECT id, updated_at FROM entries_v2 WHERE ns = ? AND id IN (${marks})`
          ).bind(ns, ...ids).all();
          existing = new Map(rows.results.map((r) => [r.id, r.updated_at]));
        }

        const stmts = [];
        let applied = 0, skipped = 0;
        for (const e of incoming) {
          if (!e || !e.id || !Array.isArray(e.videos)) { skipped++; continue; }
          const server = existing.get(e.id);
          if (server !== undefined && server >= e.updatedAt) { skipped++; continue; }
          stmts.push(
            env.DB.prepare(
              "INSERT INTO entries_v2 (ns, id, updated_at, deleted, data) VALUES (?, ?, ?, 0, ?) " +
              "ON CONFLICT(ns, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, data = excluded.data"
            ).bind(ns, e.id, e.updatedAt || Date.now(), JSON.stringify(e))
          );
          applied++;
        }
        for (const [id, ts] of Object.entries(tombs)) {
          const t = Number(ts) || Date.now();
          const server = existing.get(id);
          if (server !== undefined && server >= t) { skipped++; continue; }
          stmts.push(
            env.DB.prepare(
              "INSERT INTO entries_v2 (ns, id, updated_at, deleted, data) VALUES (?, ?, ?, 1, '{}') " +
              "ON CONFLICT(ns, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, data = '{}'"
            ).bind(ns, id, t)
          );
          applied++;
        }
        if (stmts.length) await env.DB.batch(stmts);
        return json({ applied, skipped });
      }

      // --- thumbnails: R2 keys namespaced -----------------------------------
      const m = url.pathname.match(/^\/thumb\/([A-Za-z0-9_-]+)$/);
      if (m) {
        const id = m[1];
        if (!THUMB_ID.test(id)) return json({ error: "bad id" }, 400);
        const r2k = ns + "/" + id;

        if (request.method === "PUT") {
          if (!(await writeBudget(env, ns))) return json({ error: "rate_limited", scope: "sync_writes" }, 429);
          const mime = request.headers.get("Content-Type") || "";
          if (!THUMB_MIME[mime]) return json({ error: "unsupported type" }, 415);
          const len = Number(request.headers.get("Content-Length") || 0);
          if (len > THUMB_MAX) return json({ error: "too large" }, 413);
          const buf = await request.arrayBuffer();
          if (buf.byteLength > THUMB_MAX) return json({ error: "too large" }, 413);
          if (buf.byteLength === 0) return json({ error: "empty" }, 400);
          await env.THUMBS.put(r2k, buf, { httpMetadata: { contentType: mime } });
          return json({ ok: true, bytes: buf.byteLength });
        }
        if (request.method === "GET") {
          const obj = await env.THUMBS.get(r2k);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, {
            headers: {
              "Content-Type": obj.httpMetadata?.contentType || "image/webp",
              "Cache-Control": "public, max-age=31536000, immutable",
              ...CORS,
            },
          });
        }
        if (request.method === "DELETE") {
          await env.THUMBS.delete(r2k);
          return json({ ok: true });
        }
      }

      if (url.pathname === "/thumb-deletions" && request.method === "POST") {
        const body = await request.json();
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === "string" && THUMB_ID.test(x)).slice(0, 500);
        if (ids.length) await env.THUMBS.delete(ids.map((x) => ns + "/" + x));
        return json({ ok: true, deleted: ids.length });
      }

      if (url.pathname === "/thumb-index" && request.method === "GET") {
        const thumbs = [];
        let cursor;
        do {
          const page = await env.THUMBS.list({ prefix: ns + "/", limit: 1000, cursor });
          for (const o of page.objects) thumbs.push({ id: o.key.slice(ns.length + 1), uploaded: new Date(o.uploaded).getTime() });
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return json({ thumbs });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "internal", detail: String(err).slice(0, 200) }, 500);
    }
  },
};
