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
//   GET  /download/<apk|ipk|dmg>   -> PUBLIC. R2-cached release assets, Cache API
//                            in front, GitHub PAT only on cold miss.
//                            Per-IP combined budget: 3 downloads/min -> 429 +
//                            Retry-After; 3 strikes while limited -> 30 min
//                            cooldown. Only successful serves consume budget.
// Warm-isolate cache for Drive file sizes (probe is a 1-byte Range fetch).
// Concurrent players race the probe - dedupe with a promise cache.
const driveSizeCache = new Map(); // fileId -> Promise<number|null>
function driveUrl(id) {
  const up = new URL("https://drive.usercontent.google.com/download");
  up.searchParams.set("id", id);
  up.searchParams.set("export", "download");
  up.searchParams.set("confirm", "t");
  return up.toString();
}
// usercontent flakes under rapid hits from an edge IP - retry before failing.
async function driveFetch(id, rangeHeader) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(driveUrl(id), { headers: { Range: rangeHeader }, redirect: "follow" });
    const ctype = res.headers.get("content-type") || "";
    if (res.status === 206 && !ctype.startsWith("text/html")) return res;
    res.body?.cancel().catch(() => {});
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return null;
}
function driveSize(id) {
  const hit = driveSizeCache.get(id);
  if (hit) return hit;
  const promise = (async () => {
    const res = await driveFetch(id, "bytes=0-0");
    const m = res && /\/(\d+)$/.exec(res.headers.get("content-range") || "");
    if (!m) {
      driveSizeCache.delete(id); // do not cache failures
      return null;
    }
    return Number(m[1]);
  })();
  driveSizeCache.set(id, promise);
  return promise;
}

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    // ---- public downloads: R2 + Cache API, GitHub only on cold miss --------
    const dl = url.pathname.match(/^\/download\/(apk|ipk|dmg)$/);
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
      const pat = { apk: /app-universal-debug\.apk$/, ipk: /\.ipk$/, dmg: /\.dmg$/ }[dl[1]];

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

    // ---- Drive media proxy: <video> cannot load usercontent directly on
    // Chromium (octet-stream + nosniff -> ERR_BLOCKED_BY_ORB), and anonymous
    // fetch is CORS-blocked. The worker re-serves the SAME bytes streamed
    // (no storage) with Range passthrough and the nosniff stripped, so our
    // own player works on every platform. HTML interstitials (quota pages)
    // become 502 so the client falls back to the Drive iframe.
    const dm = url.pathname.match(/^\/stream\/drive\/([A-Za-z0-9_-]{20,})$/);
    if (dm) {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateGate(env, "stream", ip, 60, 600))) { // seeks cost a request each
        return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }
      // usercontent only serves BYTES for CLOSED ranges (bytes=N-M); an
      // open-ended "bytes=0-" or a bare GET gets a 200 text/html interstitial
      // instead. So: learn the total size from a cheap 1-byte probe, then
      // translate every client request into a closed range capped at 64MB
      // per hop. Returning less than asked is valid HTTP - the media stack
      // just issues the next range.
      const size = await driveSize(dm[1]);
      if (size == null) return json({ error: "upstream interstitial" }, 502);
      // usercontent enforces a DYNAMIC per-IP range-size cap (observed:
      // 64MB worked, later 8MB already returned the HTML interstitial; 4MB
      // held). Start at 4MB and halve-shrink on interstitial until it serves.
      let start = 0;
      let wantEnd = size - 1;
      const rm = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") || "");
      if (rm) {
        start = Number(rm[1]);
        if (rm[2]) wantEnd = Math.min(Number(rm[2]), size - 1);
      }
      if (start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, ...CORS } });
      }
      let res = null;
      let end = start;
      for (const win of [4, 1].map((mb) => mb * 1024 * 1024).concat([256 * 1024, 64 * 1024])) {
        end = Math.min(wantEnd, start + win - 1, size - 1);
        if (end < start) break;
        res = await driveFetch(dm[1], `bytes=${start}-${end}`);
        if (res) break;
      }
      if (!res || end < start) return json({ error: "upstream failed" }, 502);
      const ctype = res.headers.get("content-type") || "";
      const h = new Headers();
      // ORB blocks opaque types (octet-stream) for media even without
      // nosniff - relabel as video. Chromium demuxes by content, so the
      // container (mp4/webm/mkv) is sniffed from the bytes themselves.
      h.set("Content-Type", ctype.startsWith("video/") ? ctype : "video/mp4"); // nosniff intentionally NOT copied
      h.set("Content-Range", `bytes ${start}-${end}/${size}`);
      h.set("Content-Length", String(end - start + 1));
      h.set("Accept-Ranges", "bytes");
      h.set("Cache-Control", "private, max-age=3600");
      Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      return new Response(res.body, { status: 206, headers: h });
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
