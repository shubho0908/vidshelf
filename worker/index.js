// VidShelf sync worker - single-user, passphrase-gated, minimal D1 chatter.
// Endpoints (all require header X-Sync-Key):
//   GET  /pull  -> full state { entries: [...], tombstones: {...} }   (1 read query x2)
//   POST /push  -> { entries: [...], tombstones: {...} } applies deltas,
//                  last-write-wins on updatedAt; returns { applied, conflicts }
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
};

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

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "internal", detail: String(err).slice(0, 200) }, 500);
    }
  },
};
