import type { Layer, SmartFilterEntry, SmartObject } from './types';
import { createSurface, cloneSurface, type Surface } from './surface';
import { clamp, type Rect } from './geometry';
import { uid } from './layer';
import { getFilter, type ParamValue } from '../filters/registry';
import { blendImageData, isNativeBlend } from './blend';

/** Wrap a surface as a smart object placed at its natural size and position. */
export function createSmartObject(
  source: Surface, cx: number, cy: number,
): SmartObject {
  return {
    source: cloneSurface(source),
    sourceWidth: source.w,
    sourceHeight: source.h,
    cx,
    cy,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    filters: [],
  };
}

export function smartFilterEntry(filterId: string, params: Record<string, ParamValue>): SmartFilterEntry {
  return { id: uid('sf'), filterId, params, enabled: true, opacity: 1, blend: 'normal' };
}

/** Axis-aligned bounds of the placed content, clamped to the document. */
export function smartBounds(s: SmartObject, docW: number, docH: number): Rect {
  const hw = (s.sourceWidth * Math.abs(s.scaleX)) / 2;
  const hh = (s.sourceHeight * Math.abs(s.scaleY)) / 2;
  const cos = Math.abs(Math.cos(s.angle)), sin = Math.abs(Math.sin(s.angle));
  const ex = hw * cos + hh * sin;
  const ey = hw * sin + hh * cos;
  const x = clamp(Math.floor(s.cx - ex) - 2, 0, docW);
  const y = clamp(Math.floor(s.cy - ey) - 2, 0, docH);
  return {
    x,
    y,
    w: clamp(Math.ceil(s.cx + ex) + 2 - x, 0, docW - x),
    h: clamp(Math.ceil(s.cy + ey) + 2 - y, 0, docH - y),
  };
}

/**
 * Re-render a smart object's cached pixels from its untouched source.
 * Called whenever the placement or the smart-filter stack changes, so the
 * layer never accumulates resampling loss.
 */
export function renderSmartLayer(layer: Layer, docW: number, docH: number): void {
  const s = layer.smart;
  if (!s) return;

  const out = createSurface(docW, docH);
  out.ctx.save();
  out.ctx.imageSmoothingEnabled = true;
  out.ctx.imageSmoothingQuality = 'high';
  out.ctx.translate(s.cx, s.cy);
  out.ctx.rotate(s.angle);
  out.ctx.scale(s.scaleX, s.scaleY);
  out.ctx.drawImage(s.source.canvas, -s.sourceWidth / 2, -s.sourceHeight / 2);
  out.ctx.restore();

  const active = s.filters.filter((f) => f.enabled);
  if (active.length) {
    const r = smartBounds(s, docW, docH);
    if (r.w > 0 && r.h > 0) {
      const base = out.ctx.getImageData(r.x, r.y, r.w, r.h);
      for (const entry of active) {
        const def = getFilter(entry.filterId);
        if (!def) continue;
        const working = new ImageData(new Uint8ClampedArray(base.data), r.w, r.h);
        def.apply(working, entry.params as Record<string, ParamValue>);
        mergeFilterResult(base, working, entry);
      }
      out.ctx.putImageData(base, r.x, r.y);
    }
  }

  layer.surface = out;
  layer.x = 0;
  layer.y = 0;
}

/** Blend one smart filter's output back over the accumulated pixels. */
function mergeFilterResult(base: ImageData, working: ImageData, entry: SmartFilterEntry): void {
  const opacity = clamp(entry.opacity, 0, 1);
  if (entry.blend === 'normal' && opacity >= 1) {
    base.data.set(working.data);
    return;
  }
  if (!isNativeBlend(entry.blend)) {
    blendImageData(base, working, entry.blend, opacity);
    return;
  }
  // Native modes go through the 2D pipeline on scratch surfaces.
  const a = createSurface(base.width, base.height);
  a.ctx.putImageData(base, 0, 0);
  const b = createSurface(working.width, working.height);
  b.ctx.putImageData(working, 0, 0);
  a.ctx.save();
  a.ctx.globalAlpha = opacity;
  a.ctx.globalCompositeOperation = entry.blend === 'normal'
    ? 'source-over'
    : (entry.blend as GlobalCompositeOperation);
  a.ctx.drawImage(b.canvas, 0, 0);
  a.ctx.restore();
  base.data.set(a.ctx.getImageData(0, 0, base.width, base.height).data);
}

/** Replace the embedded source, keeping the current placement. */
export function replaceSmartSource(layer: Layer, source: Surface, docW: number, docH: number): void {
  if (!layer.smart) return;
  layer.smart = {
    ...layer.smart,
    source: cloneSurface(source),
    sourceWidth: source.w,
    sourceHeight: source.h,
  };
  renderSmartLayer(layer, docW, docH);
}

/** Human-readable placement summary for the properties readout. */
export function smartSummary(s: SmartObject): string {
  const sx = Math.round(s.scaleX * 100);
  const sy = Math.round(s.scaleY * 100);
  const deg = Math.round((s.angle * 180) / Math.PI);
  return `${s.sourceWidth}×${s.sourceHeight} · ${sx}% / ${sy}%${deg ? ` · ${deg}°` : ''}`;
}
