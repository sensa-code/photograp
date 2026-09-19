import { blurMask } from './selection';

/**
 * Edge refinement for a coverage mask, in the order Photoshop applies it:
 * smooth, feather, contrast, then shift. Each step is a no-op at zero, so a
 * default settings object leaves the mask exactly as it was.
 */
export interface RefineSettings {
  /** Radius that rounds off corners and speckle, in pixels. */
  smooth: number;
  /** Gaussian softening of the edge, in pixels. */
  feather: number;
  /** 0 keeps the soft edge, 100 drives it back to a hard one. */
  contrast: number;
  /** Move the edge outwards (+) or inwards (-), in pixels. */
  shift: number;
}

export const defaultRefine = (): RefineSettings =>
  ({ smooth: 0, feather: 0, contrast: 0, shift: 0 });

export const refineIsIdentity = (s: RefineSettings): boolean =>
  s.smooth <= 0 && s.feather <= 0 && s.contrast <= 0 && s.shift === 0;

/** Push coverage away from the midpoint, which hardens a soft edge. */
function applyContrast(mask: Uint8Array, amount: number): void {
  if (amount <= 0) return;
  const k = 1 + (amount / 100) * 15;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, Math.round((v - 128) * k + 128)));
  }
  for (let i = 0; i < mask.length; i++) mask[i] = lut[mask[i]];
}

/**
 * Grey dilate/erode with a square window. Separable, so the cost is O(n·r)
 * rather than O(n·r²); at the border an erode treats the outside as empty so
 * a selection touching the edge shrinks away from it like any other edge.
 */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pick = dilate ? Math.max : Math.min;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) { if (!dilate) v = 0; continue; }
        v = pick(v, src[row + xx]);
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) { if (!dilate) v = 0; continue; }
        v = pick(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Smoothing is a blur followed by a steep remap: the blur rounds the outline
 * and the remap pulls it back to a crisp edge, leaving roughly a pixel of
 * anti-aliasing instead of the stair-steps a hard threshold would give.
 */
function applySmooth(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const blurred = new Uint8Array(blurMask(mask, w, h, radius));
  applyContrast(blurred, 60);
  return blurred;
}

/** Refine a copy of `src`; the input is never modified. */
export function refineMask(
  src: Uint8Array, w: number, h: number, s: RefineSettings, scale = 1,
): Uint8Array {
  let mask: Uint8Array = new Uint8Array(src);
  const px = (v: number): number => Math.round(v * scale);

  const smooth = px(s.smooth);
  if (smooth > 0) mask = applySmooth(mask, w, h, smooth);

  const feather = px(s.feather);
  if (feather > 0) mask = new Uint8Array(blurMask(mask, w, h, feather));

  applyContrast(mask, s.contrast);

  const shift = px(s.shift);
  if (shift !== 0) mask = morph(mask, w, h, Math.abs(shift), shift > 0);

  return mask;
}

/** Nearest-neighbour resample of a coverage mask, for the live preview. */
export function scaleMask(
  src: Uint8Array, w: number, h: number, dw: number, dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / dw));
      out[y * dw + x] = src[sy * w + sx];
    }
  }
  return out;
}
