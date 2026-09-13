// Media lock: full-page PIN gate. The PIN itself lives only on the worker
// (MEDIA_PIN secret) - this client only ever holds the HMAC token the worker
// mints on a correct unlock. Token = exp.sig, 30-day TTL, checked locally for
// expiry; the worker re-verifies the signature on every media request.
import { SYNC_URL } from "../config";

const KEY = "vidshelf.media.lock.v1";

export function mediaToken(): string | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null") as { token: string; exp: number } | null;
    if (r && typeof r.token === "string" && Number(r.exp) > Date.now() + 60_000) return r.token;
  } catch { /* fall through */ }
  return null;
}

export type UnlockResult = "ok" | "wrong" | "locked" | "error";
export async function unlockMedia(pin: string): Promise<UnlockResult> {
  try {
    const r = await fetch(SYNC_URL + "/media/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (r.ok) {
      const j = (await r.json()) as { token: string; expiresAt: number };
      localStorage.setItem(KEY, JSON.stringify({ token: j.token, exp: j.expiresAt }));
      return "ok";
    }
    if (r.status === 401) return "wrong";
    if (r.status === 429) return "locked";
    return "error";
  } catch {
    return "error";
  }
}

/** Append the media token to a worker media URL (video/img src can't send headers). */
export function withMediaToken(u: string): string {
  const t = mediaToken();
  return t ? u + (u.includes("?") ? "&" : "?") + "mt=" + encodeURIComponent(t) : u;
}
