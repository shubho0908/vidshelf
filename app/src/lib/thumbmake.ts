// Custom thumbnail pipeline: strict 16:9 validation + WebP/JPEG encode capped
// at 1280x720. Pure-web (canvas) so Mac (WKWebView), Android WebView and
// webOS all run the identical code path.

export const THUMB_W = 1280;
export const THUMB_H = 720;
export const RATIO = 16 / 9;
// Tolerance admits integer-rounded 16:9 sizes (e.g. 853x480 = 1.77708) while
// decisively rejecting 4:3 (1.3333) and 1:1.
export const RATIO_TOL = 0.005;
export const MAX_BYTES = 150 * 1024; // stored output: target band 50-100KB, hard cap 150KB
export const SRC_MAX_BYTES = 1024 * 1024; // source image hard cap 1MB (user decision; he pre-compresses bigger images)

export interface RatioCheck {
  ok: boolean;
  actual: number;
}

export function checkRatio(w: number, h: number): RatioCheck {
  const actual = w / h;
  return { ok: Math.abs(actual - RATIO) <= RATIO_TOL, actual };
}

export function ratioError(w: number, h: number): string {
  const a = (w / h).toFixed(2);
  return `Thumbnails must be exactly 16:9 (like 1280x720 or 1920x1080). Your image is ${w}x${h} (ratio ${a}:1). Please pick a 16:9 image - no cropping is applied.`;
}

/** True when this engine can ENCODE webp from canvas (decode is universal on
 *  our targets; encode is missing on some WKWebView builds -> jpeg fallback). */
export function canEncodeWebP(): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = 2; c.height = 2;
    return c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

export interface MadeThumb {
  blob: Blob;
  mime: "image/webp" | "image/jpeg";
  width: number;
  height: number;
  bytes: number;
}

async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; close?: () => void }> {
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    // Fallback for engines without createImageBitmap on files.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("Could not read that image file."));
        i.src = url;
      });
      return { src: img, w: img.naturalWidth, h: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toBlob(canvas: HTMLCanvasElement, mime: string, q: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob((b) => res(b), mime, q));
}

/** Validate + downscale + encode. Throws Error with a user-facing message on
 *  any rejection (wrong ratio, unreadable file). Never crops. */
export async function makeThumb(file: File): Promise<MadeThumb> {
  if (!file.type.startsWith("image/")) throw new Error("That is not an image file. Pick a JPG, PNG or WebP.");
  if (file.size > SRC_MAX_BYTES)
    throw new Error(`That image is ${(file.size / 1048576).toFixed(2)}MB - the limit is 1MB. Compress or resize it first (it is stored as 1280x720 anyway).`);
  const d = await decode(file);
  const ratio = checkRatio(d.w, d.h);
  if (!ratio.ok) {
    d.close?.();
    throw new Error(ratioError(d.w, d.h));
  }
  const scale = Math.min(1, THUMB_W / d.w, THUMB_H / d.h);
  const w = Math.max(1, Math.round(d.w * scale));
  const h = Math.max(1, Math.round(d.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device cannot process images (no canvas).");
  ctx.drawImage(d.src, 0, 0, w, h);
  d.close?.();

  const mime: MadeThumb["mime"] = canEncodeWebP() ? "image/webp" : "image/jpeg";
  let q = 0.82;
  let blob = await toBlob(canvas, mime, q);
  while (blob && blob.size > MAX_BYTES && q > 0.55) {
    q -= 0.08;
    blob = await toBlob(canvas, mime, q);
  }
  if (!blob) throw new Error("Could not encode the image on this device.");
  if (blob.size > MAX_BYTES * 2) throw new Error("Could not compress that image below the size limit. Try a simpler 16:9 image.");
  return { blob, mime, width: w, height: h, bytes: blob.size };
}

/** webOS TVs have no usable file picker; upload UI hides there (synced
 *  display still works). */
export function canUploadThumbs(): boolean {
  const ua = navigator.userAgent;
  if (/webOS|web0S|SmartTV.*LG|NetCast/i.test(ua)) return false;
  if (typeof (window as unknown as { PalmSystem?: unknown }).PalmSystem !== "undefined") return false;
  return true;
}
