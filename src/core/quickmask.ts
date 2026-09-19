import { createSurface, type Surface } from './surface';
import type { RGB } from './color';
import type { Selection } from './selection';

/**
 * Quick Mask turns the selection into a paintable greyscale channel so the
 * ordinary brush, gradient and filter tools can shape it. The channel follows
 * the same convention as layer masks and alpha channels: white = selected.
 */
export interface QuickMask {
  surface: Surface;
  color: RGB;
  opacity: number;
  /** Tint the unselected area (Photoshop's default) rather than the selected one. */
  showMaskedAreas: boolean;
}

export function createQuickMask(selection: Selection, w: number, h: number): QuickMask {
  const surface = createSurface(w, h);
  const img = surface.ctx.createImageData(w, h);
  const d = img.data;
  const mask = selection.mask;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    // With nothing selected everything starts editable, as Photoshop does.
    const v = mask ? mask[i] : 255;
    d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
  }
  surface.ctx.putImageData(img, 0, 0);
  return {
    surface,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.5,
    showMaskedAreas: true,
  };
}

/** Read the quick mask back as selection coverage. */
export function quickMaskCoverage(surface: Surface): Uint8Array {
  const d = surface.ctx.getImageData(0, 0, surface.w, surface.h).data;
  const out = new Uint8Array(surface.w * surface.h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (d[p] * d[p + 3]) / 255;
  return out;
}

/** True when the mask selects everything, i.e. leaving it should deselect. */
export function quickMaskIsFull(coverage: Uint8Array): boolean {
  for (let i = 0; i < coverage.length; i++) if (coverage[i] !== 255) return false;
  return true;
}

/** Paint the rubylith overlay over a composited image. */
export function renderQuickMaskOverlay(
  composite: Surface, qm: QuickMask, override?: Surface | null,
): Surface {
  const src = override ?? qm.surface;
  const out = createSurface(composite.w, composite.h);
  out.ctx.drawImage(composite.canvas, 0, 0);

  const tint = createSurface(composite.w, composite.h);
  const mask = src.ctx.getImageData(0, 0, src.w, src.h);
  const img = tint.ctx.createImageData(composite.w, composite.h);
  for (let i = 0; i < img.data.length; i += 4) {
    const selected = mask.data[i];
    img.data[i] = qm.color.r;
    img.data[i + 1] = qm.color.g;
    img.data[i + 2] = qm.color.b;
    img.data[i + 3] = qm.showMaskedAreas ? 255 - selected : selected;
  }
  tint.ctx.putImageData(img, 0, 0);

  out.ctx.save();
  out.ctx.globalAlpha = qm.opacity;
  out.ctx.drawImage(tint.canvas, 0, 0);
  out.ctx.restore();
  return out;
}
