// Baked sync key for the private app binaries (macOS/Android/webOS releases
// from the private repo). NEVER bundled into the public web build - vite.config
// aliases this module to syncKey.none.ts when VITE_WEB_BUILD=1.
export const BAKED_SYNC_KEY = "32215ea5055b9b66fdce15d8692748b843cdff00537dd98e";
