// VidShelf sync worker - single-user, passphrase-gated, minimal D1 chatter.
// Endpoints (all require header X-Sync-Key):
//   GET  /pull  -> full state { entries: [...], tombstones: {...} }   (1 read query x2)
//   POST /push  -> { entries: [...], tombstones: {...} } applies deltas,
//                  last-write-wins on updatedAt; returns { applied, conflicts }
//   PUT    /thumb/:id        -> store thumbnail blob in R2 (webp/jpeg, <=512KB)
//   GET    /thumb/:id        -> stream thumbnail blob
//   DELETE /thumb/:id        -> remove thumbnail
//   POST   /thumb-deletions  -> { ids: [...] } batch delete (cascade from clients)
//   GET    /thumb-index      -> { thumbs: [{ id, uploaded }] } for orphan sweeps
//   GET    /download/<apk|ipk|dmg>  -> PUBLIC: streams the latest release asset
//                  (repo is private; the token stays server-side in GH_RELEASE_TOKEN)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
};

const THUMB_ID = /^t_[A-Za-z0-9_-]{6,64}$/;
const THUMB_MIME = { "image/webp": 1, "image/jpeg": 1 };
const THUMB_MAX = 512 * 1024; // clients encode to ~50-100KB; 512KB is generous headroom

function thumbsMissing() {
  return json({ error: "thumbnail storage not configured" }, 503);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function fullState(env) {
  const entries = await env.DB.prepare(
    "SELECT data FROM entries WHERE deleted = 0"
  ).all();
  const tombs = await env.DB.prepare(
    "SELECT id, updated_at FROM entries WHERE deleted = 1"
  ).all();
  const tombstones = {};
  for (const r of tombs.results) tombstones[r.id] = r.updated_at;
  return { entries: entries.results.map((r) => JSON.parse(r.data)), tombstones };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true }); // unauthenticated liveness only

    // Public download proxy: private-repo release assets, streamed server-side.
    const dl = url.pathname.match(/^\/download\/(apk|ipk|dmg)$/);
    if (dl && request.method === "GET") {
      if (!env.GH_RELEASE_TOKEN) return json({ error: "downloads not configured" }, 503);
      const pat = { apk: /app-universal-debug\.apk$/, ipk: /\.ipk$/, dmg: /\.dmg$/ }[dl[1]];
      const gh = { headers: { Authorization: "Bearer " + env.GH_RELEASE_TOKEN, "User-Agent": "vidshelf-sync", Accept: "application/vnd.github+json" } };
      const rel = await fetch("https://api.github.com/repos/shubho0908/vidshelf/releases/latest", gh);
      if (!rel.ok) return json({ error: "release lookup failed" }, 502);
      const data = await rel.json();
      const asset = (data.assets || []).find((a) => pat.test(a.name));
      if (!asset) return json({ error: "asset missing" }, 404);
      const bin = await fetch(asset.url, { headers: { Authorization: "Bearer " + env.GH_RELEASE_TOKEN, "User-Agent": "vidshelf-sync", Accept: "application/octet-stream" } });
      if (!bin.ok || !bin.body) return json({ error: "asset fetch failed" }, 502);
      return new Response(bin.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asset.name}"`,
          "Cache-Control": "public, max-age=300",
          ...CORS,
        },
      });
    }

    const key = request.headers.get("X-Sync-Key") || "";
    if (!env.VIDSHELF_KEY || key !== env.VIDSHELF_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/pull" && request.method === "GET") {
        return json(await fullState(env));
      }

      if (url.pathname === "/push" && request.method === "POST") {
        const body = await request.json();
        const incoming = Array.isArray(body.entries) ? body.entries : [];
        const tombs = body.tombstones && typeof body.tombstones === "object" ? body.tombstones : {};

        // Single read of the rows we might conflict with.
        const ids = [...incoming.map((e) => e && e.id), ...Object.keys(tombs)].filter(Boolean);
        let existing = new Map();
        if (ids.length) {
          const marks = ids.map(() => "?").join(",");
          const rows = await env.DB.prepare(
            `SELECT id, updated_at FROM entries WHERE id IN (${marks})`
          ).bind(...ids).all();
          existing = new Map(rows.results.map((r) => [r.id, r.updated_at]));
        }

        const stmts = [];
        let applied = 0, skipped = 0;
        for (const e of incoming) {
          if (!e || !e.id || !Array.isArray(e.videos)) { skipped++; continue; }
          const server = existing.get(e.id);
          if (server !== undefined && server >= e.updatedAt) { skipped++; continue; } // server newer/equal wins
          stmts.push(
            env.DB.prepare(
              "INSERT INTO entries (id, updated_at, deleted, data) VALUES (?, ?, 0, ?) " +
              "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, data = excluded.data"
            ).bind(e.id, e.updatedAt || Date.now(), JSON.stringify(e))
          );
          applied++;
        }
        for (const [id, ts] of Object.entries(tombs)) {
          const t = Number(ts) || Date.now();
          const server = existing.get(id);
          if (server !== undefined && server >= t) { skipped++; continue; }
          stmts.push(
            env.DB.prepare(
              "INSERT INTO entries (id, updated_at, deleted, data) VALUES (?, ?, 1, '{}') " +
              "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, data = '{}'"
            ).bind(id, t)
          );
          applied++;
        }
        if (stmts.length) await env.DB.batch(stmts); // one round trip for the whole write set
        return json({ applied, skipped });
      }

      // --- thumbnail blobs (R2) -------------------------------------------
      const m = url.pathname.match(/^\/thumb\/([A-Za-z0-9_-]+)$/);
      if (m) {
        if (!env.THUMBS) return thumbsMissing();
        const id = m[1];
        if (!THUMB_ID.test(id)) return json({ error: "bad id" }, 400);

        if (request.method === "PUT") {
          const mime = request.headers.get("Content-Type") || "";
          if (!THUMB_MIME[mime]) return json({ error: "unsupported type" }, 415);
          const len = Number(request.headers.get("Content-Length") || 0);
          if (len > THUMB_MAX) return json({ error: "too large" }, 413);
          const buf = await request.arrayBuffer();
          if (buf.byteLength > THUMB_MAX) return json({ error: "too large" }, 413);
          if (buf.byteLength === 0) return json({ error: "empty" }, 400);
          await env.THUMBS.put(id, buf, { httpMetadata: { contentType: mime } });
          return json({ ok: true, bytes: buf.byteLength });
        }
        if (request.method === "GET") {
          const obj = await env.THUMBS.get(id);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, {
            headers: {
              "Content-Type": obj.httpMetadata?.contentType || "image/webp",
              "Cache-Control": "public, max-age=31536000, immutable", // ids are immutable
              ...CORS,
            },
          });
        }
        if (request.method === "DELETE") {
          await env.THUMBS.delete(id);
          return json({ ok: true });
        }
      }

      if (url.pathname === "/thumb-deletions" && request.method === "POST") {
        if (!env.THUMBS) return thumbsMissing();
        const body = await request.json();
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === "string" && THUMB_ID.test(x)).slice(0, 500);
        if (ids.length) await env.THUMBS.delete(ids);
        return json({ ok: true, deleted: ids.length });
      }

      if (url.pathname === "/thumb-index" && request.method === "GET") {
        if (!env.THUMBS) return thumbsMissing();
        const thumbs = [];
        let cursor;
        do {
          const page = await env.THUMBS.list({ limit: 1000, cursor });
          for (const o of page.objects) thumbs.push({ id: o.key, uploaded: new Date(o.uploaded).getTime() });
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
