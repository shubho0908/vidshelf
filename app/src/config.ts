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
export const SYNC_KEY = "32215ea5055b9b66fdce15d8692748b843cdff00537dd98e";
