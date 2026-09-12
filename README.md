<p align="center"><img src="docs/icon.png" width="128" alt="VidShelf icon"></p>

# VidShelf

Paste a link - it plays. A lightweight personal video library for **LG webOS TV** and **macOS**, from one codebase. No server, no transcoding, no storage cost: the app stores only your links (localStorage) and embeds the source player.

## Install

### macOS (.dmg)

VidShelf is not signed with an Apple Developer certificate, so on first open Gatekeeper may say **"VidShelf is damaged and can't be opened"**. It is not damaged - that is the standard block for unsigned apps. One-time fix:

1. Copy VidShelf.app to /Applications
2. Run in Terminal: `xattr -dr com.apple.quarantine /Applications/VidShelf.app`
3. Open normally

Proper signing/notarization needs a paid Apple Developer account.

### Android / TV (.apk)

arm64, minSdk 24, leanback banner included. Sideload directly, or via ADB on a Jio STB: `adb connect <stb-ip>:5555 && adb install app-arm64-debug.apk`

### LG webOS TV (.ipk)

Install with Developer Mode: `ares-install -d <tv> com.shubhojeet.vidshelf_1.0.0_all.ipk`

## What it plays

| Link type | How it plays | Caveats |
| --- | --- | --- |
| YouTube (watch / youtu.be / shorts / live) | Official IFrame Player API, via a hosted player page | Owner-disabled embeds can't play (error 101/150); ads per YouTube ToS |
| Google Drive share links | Drive `/preview` iframe | Playback capped at 1080p by Drive; rare per-file playback quota; file must be shared |
| Direct video files (.mp4, .webm, ...) | Native `<video>` | Host must allow hotlinking (CORS for some webviews) |
| HLS (.m3u8) | Native where supported (webOS, Safari/WebKit), hls.js fallback | - |
| Netflix / Prime / Hotstar / other OTT | **Not possible** - shown an honest explanation in-app | X-Frame-Options + DRM; no workaround exists |

## Features

- CRUD library: single-video entries and playlist entries (multiple videos per entry)
- Auto thumbnails (YouTube, Drive), best-effort title fetch for YouTube
- Live link-type detection with inline explanation while adding
- Full TV remote navigation (arrow keys / OK / Back, incl. webOS keycode 461)
- Responsive from 390px phones to 1080p TVs; dark, material-based UI
- Export/import the library as JSON

## Architecture

- `app/` - Vite + React + TypeScript + Tailwind v4 SPA (hash routing, so it works from `file://`-style origins). ~76 KB gz main bundle; hls.js is a lazy chunk.
- `src-tauri/` - Tauri v2 shell for macOS (WKWebView). Unsigned dmg; first open needs right-click > Open (Gatekeeper).
- `webos/` - `appinfo.json` + icons; packaged by `scripts/package-webos.sh` using `@webos-tools/cli` (pure npm, Ubuntu/macOS/Windows).
- [`vidshelf-player`](https://github.com/shubho0908/vidshelf-player) - tiny public GitHub Pages site hosting the YouTube IFrame player. webOS/Tauri webviews send no Referer, and YouTube refuses embeds without one (error 153); the hosted page provides a real HTTPS origin.

## Develop

```bash
cd app && npm ci && npm run dev
npm run build   # outputs app/dist
```

## Build installers

```bash
# webOS .ipk (needs: npm i -g @webos-tools/cli)
./scripts/package-webos.sh        # -> build/com.shubhojeet.vidshelf_1.0.0_all.ipk

# macOS .dmg (needs macOS + Rust)
npx @tauri-apps/cli@latest build  # -> src-tauri/target/release/bundle/dmg/
```

## CI (free-tier safe)

- **Every push/PR** (`ci.yml`): Linux only - tests, web build, webOS ipk artifact. Pennies.
- **Only on tags** (`release.yml`): macOS dmg + ipk attached to a GitHub Release. macOS minutes bill ~10x; tag-gating keeps monthly usage far below the 2,000 free minutes.
- npm + Rust caches on; `concurrency.cancel-in-progress` kills stale runs.

Cut a release:

```bash
git tag v1.0.0 && git push https://github.com/shubho0908/vidshelf.git --tags
```

## Install on the TV

Enable Developer Mode on the LG TV, then from any machine with the webOS CLI:

```bash
ares-setup-device            # register the TV once
ares-install --device tv build/com.shubhojeet.vidshelf_1.0.0_all.ipk
```
