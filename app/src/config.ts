// Hosted YouTube player page (public GitHub Pages repo: vidshelf-player).
// webOS webviews and Tauri load the app from non-HTTP origins, so YouTube's
// IFrame player cannot see a Referer and refuses to play (error 153).
// The hosted player page runs on a real HTTPS origin and embeds the
// official IFrame Player API there instead.
export const YT_PLAYER_BASE = "https://shubho0908.github.io/vidshelf-player/";
