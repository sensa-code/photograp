import { createSurface, type Surface } from './surface';

/**
 * Layer masks are stored as opaque greyscale surfaces so they can be painted
 * with the ordinary brush tools. Compositing needs the grey turned into alpha;
 * the conversion is cached per surface object, and surfaces are replaced (never
 * mutated in place) whenever a mask changes, so the cache cannot go stale.
 */
const cache = new WeakMap<Surface, Surface>();

export function maskAlpha(mask: Surface): Surface {
  const hit = cache.get(mask);
  if (hit) return hit;
  const out = createSurface(mask.w, mask.h);
  const src = mask.ctx.getImageData(0, 0, mask.w, mask.h);
  const dst = out.ctx.createImageData(mask.w, mask.h);
  const s = src.data, d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
    // Greyscale, so any channel works; scale by its own alpha for safety.
    d[i + 3] = (s[i] * s[i + 3]) / 255;
  }
  out.ctx.putImageData(dst, 0, 0);
  cache.set(mask, out);
  return out;
}

/** Build a mask surface from an 8-bit coverage buffer (e.g. a selection). */
export function maskFromCoverage(
  cov: Uint8Array | null, w: number, h: number, fallback = 255,
): Surface {
  const s = createSurface(w, h);
  const img = s.ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const v = cov ? cov[i] : fallback;
    d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
  }
  s.ctx.putImageData(img, 0, 0);
  return s;
}

/** Read a mask back as an 8-bit coverage buffer. */
export function coverageFromMask(mask: Surface): Uint8Array {
  const d = mask.ctx.getImageData(0, 0, mask.w, mask.h).data;
  const out = new Uint8Array(mask.w * mask.h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (d[p] * d[p + 3]) / 255;
  return out;
}
