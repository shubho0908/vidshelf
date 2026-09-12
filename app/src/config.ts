// Hosted YouTube player page (public GitHub Pages repo: vidshelf-player).
// webOS webviews and Tauri load the app from non-HTTP origins, so YouTube's
// IFrame player cannot see a Referer and refuses to play (error 153).
// The hosted player page runs on a real HTTPS origin and embeds the
// official IFrame Player API there instead.
export const YT_PLAYER_BASE = "https://shubho0908.github.io/vidshelf-player/";

// Sync defaults (deployed via .github/workflows/sync.yml). Single-user app:
// the key ships inside the binaries, which are downloadable only from the
// private repo's releases - so sync works out of the box with zero typing,
// on TV included. Rotate by changing the GitHub secret + rebuilding.
export const SYNC_URL = "https://vidshelf-sync.shubhoeducation.workers.dev";
// App binaries bake the key (private-repo releases only). The PUBLIC web build
// aliases syncKey.baked to syncKey.none at build time (vite.config resolve.alias),
// so the key never enters the web bundle; web users enter it once, stored in
// localStorage. Verified by grepping dist-web after every web build.
import { BAKED_SYNC_KEY } from "./syncKey.baked";
export const SYNC_KEY: string = BAKED_SYNC_KEY;
export const IS_WEB_BUILD = import.meta.env.VITE_WEB_BUILD === "1";
