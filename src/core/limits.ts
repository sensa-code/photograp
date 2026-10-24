/**
 * Hard limits on document size. Every layer surface is w × h × 4 bytes of
 * RGBA, so 40 megapixels is already 160 MB per layer, and the compositor,
 * history and selection each hold more. Past that the browser does not fail
 * gracefully: the tab simply dies, taking every unsaved document with it.
 */

/** Maximum pixels per document (about 8000 × 5000). */
export const MAX_PIXELS = 40_000_000;

/** Longest side a canvas may have; Chromium refuses anything larger. */
export const MAX_SIDE = 16384;

export type SizeCheck = { ok: true } | { ok: false; reason: string };

const megapixels = (px: number): string =>
  `${Math.round(px / 10_000).toLocaleString('zh-TW')} 萬像素`;

/** Whether a w × h document may be created; the reason is written for the user. */
export function checkDocumentSize(w: number, h: number): SizeCheck {
  if (!(w >= 1 && h >= 1)) return { ok: false, reason: '寬度與高度至少要 1 px' };
  if (w > MAX_SIDE || h > MAX_SIDE) {
    return { ok: false, reason: `單邊最多 ${MAX_SIDE} px，目前為 ${w} × ${h} px` };
  }
  if (w * h > MAX_PIXELS) {
    return {
      ok: false,
      reason: `${w} × ${h} px 約 ${megapixels(w * h)}，超過上限 ${megapixels(MAX_PIXELS)}（約 8000 × 5000 px）`,
    };
  }
  return { ok: true };
}

/**
 * Largest size with the same proportions that fits the limits. A size that
 * already fits comes back untouched, so callers can apply this unconditionally.
 */
export function fitWithinLimit(w: number, h: number): { w: number; h: number; scaled: boolean } {
  const scale = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
  if (scale >= 1) return { w, h, scaled: false };
  return {
    w: Math.max(1, Math.floor(w * scale)),
    h: Math.max(1, Math.floor(h * scale)),
    scaled: true,
  };
}

/**
 * Size to open an image at. Oversized images are shrunk rather than refused:
 * PhotoDoc.fromImage resamples straight into the target size, so the full-size
 * bitmap never gets a surface of its own.
 */
export function fitImageToLimit(
  img: { naturalWidth: number; naturalHeight: number },
): { w: number; h: number; notice: string | null } {
  const fit = fitWithinLimit(img.naturalWidth, img.naturalHeight);
  return {
    w: fit.w,
    h: fit.h,
    notice: fit.scaled ? `影像超過上限，已縮小為 ${fit.w}×${fit.h}` : null,
  };
}
