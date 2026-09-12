// Hosted YouTube player page (public GitHub Pages repo: vidshelf-player).
// webOS webviews and Tauri load the app from non-HTTP origins, so YouTube's
// IFrame player cannot see a Referer and refuses to play (error 153).
// The hosted player page runs on a real HTTPS origin and embeds the
// official IFrame Player API there instead.
export const YT_PLAYER_BASE = "https://shubho0908.github.io/vidshelf-player/";

// Sync defaults. Multi-tenant sync: a shelf key is never shipped in source or
// binaries. First run on every platform offers one-tap "Create my shelf" (key
// minted on-device) or paste-an-existing-key; the key lives in localStorage on
// each device only.
export const SYNC_URL = "https://vidshelf-sync.shubhoeducation.workers.dev";
export const SYNC_KEY: string = "";
export const IS_WEB_BUILD = import.meta.env.VITE_WEB_BUILD === "1";
