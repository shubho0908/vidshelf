# VidShelf

A personal video library. Home-server movies appear by default on every
install; your own YouTube and direct-video links sync across devices with
one key. Plays in its own fast, remote-friendly player.

**Surfaces:** the website and the macOS app (Apple Silicon dmg).
(Android apk and LG webOS ipk were retired - do not re-add.)

## Architecture

- `app/` - Vite + React + TypeScript SPA. Two build flavors:
  - `npm run build` - native bundle for the Tauri dmg (bakes the sync key;
    dmg ships only from this private repo's releases).
  - `npm run build:web` - public web bundle (the baked key is aliased OUT;
    CI greps the bundle and fails on any leak). Deployed to Vercel from
    `main` automatically.
- `worker/` - Cloudflare Worker (`vidshelf-sync`). D1 for shelf sync +
  pairing + the home-server media catalog; private R2 buckets
  `vidshelf-thumbs` (thumbnails) and `vidshelf-media` (movies).
- `src-tauri/` - Tauri shell for the macOS dmg.

## Home-server media (read-only by design)

- The media bucket is PRIVATE. Bytes exit only through the worker's
  rate-limited GET routes: `/media/catalog`, `/media/stream/<id>` (full
  Range support), `/media/thumb/<id>`.
- There is NO upload endpoint - apps physically cannot write to R2. Media
  is ingested out-of-band (wrangler/CI ops workflow) only.
- Abuse gates: unguessable 24-hex media ids, per-IP minute limits, and a
  global daily stream circuit breaker that trips well before the free
  worker quota is at risk.

## Sync

- Multi-tenant: any 48-char key maps to an isolated shelf namespace
  (`sha256(key)`). The dmg bakes the default shelf key; the web build
  asks once and stores it in localStorage.
- Pairing: 6-char code flow (`/pair/start` -> approve on a linked device).
- Sync key scope: multi-device pairing and your own added links only.
  The home-server catalog is global and needs no key.

## Workflows

- `CI` (every push/PR, Linux): tests, both builds, web-bundle key-leak gate.
- `Sync backend` (manual): creates D1 + R2 buckets, applies schema,
  deploys the worker.
- `Media ingest` (manual): migrates/ingests server media into R2 + catalog.
- `Release` (version tags only): macOS dmg -> GitHub release.
