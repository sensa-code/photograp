import type { PhotoDoc } from '../core/document';
import type { Layer } from '../core/types';
import { cloneSurface, createSurface, type Surface } from '../core/surface';
import type { RGB } from '../core/color';
import { clamp } from '../core/geometry';

export interface BrushSettings {
  size: number;
  /** 0 = fully soft, 1 = hard edge. */
  hardness: number;
  /** Applied once to the whole stroke. */
  opacity: number;
  /** Applied to each dab, so overlaps build up. */
  flow: number;
  /** Dab spacing as a percentage of the brush diameter. */
  spacing: number;
  color: RGB;
  /** 0..100 lazy-pointer smoothing. */
  smoothing: number;
  sizePressure: boolean;
  opacityPressure: boolean;
  /** Random position jitter in pixels. */
  scatter: number;
}

export const defaultBrush = (): BrushSettings => ({
  size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 12,
  color: { r: 0, g: 0, b: 0 }, smoothing: 30,
  sizePressure: true, opacityPressure: false, scatter: 0,
});

const stampCache = new Map<string, Surface>();

/** A single brush dab, cached by size / hardness / colour. */
export function brushStamp(size: number, hardness: number, color: RGB): Surface {
  const s = Math.max(1, Math.round(size * 2) / 2);
  const h = clamp(hardness, 0, 1);
  const key = `${s}|${h.toFixed(2)}|${color.r},${color.g},${color.b}`;
  const hit = stampCache.get(key);
  if (hit) return hit;

  const dim = Math.ceil(s) + 2;
  const surf = createSurface(dim, dim);
  const c = dim / 2;
  const r = s / 2;
  const { r: cr, g: cg, b: cb } = color;

  if (h >= 0.985 && s > 2) {
    surf.ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    surf.ctx.beginPath();
    surf.ctx.arc(c, c, r, 0, Math.PI * 2);
    surf.ctx.fill();
  } else {
    const grad = surf.ctx.createRadialGradient(c, c, 0, c, c, Math.max(0.01, r));
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let a: number;
      if (t <= h) a = 1;
      else {
        const u = (t - h) / Math.max(1e-4, 1 - h);
        a = 1 - u * u * (3 - 2 * u); // smoothstep falloff
      }
      grad.addColorStop(t, `rgba(${cr},${cg},${cb},${a})`);
    }
    surf.ctx.fillStyle = grad;
    surf.ctx.fillRect(0, 0, dim, dim);
  }

  if (stampCache.size > 160) stampCache.clear();
  stampCache.set(key, surf);
  return surf;
}

export type StrokeMode = 'paint' | 'erase';

interface DirtyRect { x0: number; y0: number; x1: number; y1: number }

/**
 * One continuous brush stroke. Dabs accumulate into a scratch surface so that
 * stroke opacity applies once to the whole stroke, matching how a paint tool
 * is expected to behave; the document only changes when the stroke ends.
 */
export class Stroke {
  private base: Surface;
  private scratch: Surface;
  private preview: Surface;
  private selection: Surface | null;
  private offX: number;
  private offY: number;
  private lastX = 0;
  private lastY = 0;
  private smoothX = 0;
  private smoothY = 0;
  private carry = 0;
  private started = false;
  private dirty: DirtyRect | null = null;
  bounds: DirtyRect | null = null;

  constructor(
    private doc: PhotoDoc,
    private layer: Layer,
    target: Surface,
    private isMask: boolean,
    private settings: BrushSettings,
    private mode: StrokeMode = 'paint',
  ) {
    this.base = cloneSurface(target);
    this.scratch = createSurface(target.w, target.h);
    this.preview = cloneSurface(target);
    this.offX = isMask ? 0 : layer.x;
    this.offY = isMask ? 0 : layer.y;
    this.selection = doc.selection.active ? doc.selection.toSurface() : null;
    doc.livePreview = { layerId: layer.id, surface: this.preview, isMask };
  }

  private markDirty(x: number, y: number, r: number): void {
    const x0 = Math.floor(x - r - 2), y0 = Math.floor(y - r - 2);
    const x1 = Math.ceil(x + r + 2), y1 = Math.ceil(y + r + 2);
    if (!this.dirty) this.dirty = { x0, y0, x1, y1 };
    else {
      this.dirty.x0 = Math.min(this.dirty.x0, x0);
      this.dirty.y0 = Math.min(this.dirty.y0, y0);
      this.dirty.x1 = Math.max(this.dirty.x1, x1);
      this.dirty.y1 = Math.max(this.dirty.y1, y1);
    }
    if (!this.bounds) this.bounds = { x0, y0, x1, y1 };
    else {
      this.bounds.x0 = Math.min(this.bounds.x0, x0);
      this.bounds.y0 = Math.min(this.bounds.y0, y0);
      this.bounds.x1 = Math.max(this.bounds.x1, x1);
      this.bounds.y1 = Math.max(this.bounds.y1, y1);
    }
  }

  private dab(x: number, y: number, pressure: number): void {
    const s = this.settings;
    let size = s.size;
    if (s.sizePressure) size = Math.max(1, size * (0.25 + 0.75 * pressure));
    let alpha = s.flow;
    if (s.opacityPressure) alpha *= pressure;
    if (alpha <= 0) return;

    let dx = x, dy = y;
    if (s.scatter > 0) {
      dx += (Math.random() * 2 - 1) * s.scatter;
      dy += (Math.random() * 2 - 1) * s.scatter;
    }

    const stamp = brushStamp(size, s.hardness, s.color);
    const ctx = this.scratch.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.drawImage(stamp.canvas, dx - stamp.w / 2, dy - stamp.h / 2);
    ctx.restore();
    this.markDirty(dx, dy, stamp.w / 2);
  }

  /** Clip freshly painted pixels to the selection and refresh the preview. */
  private flush(): void {
    if (!this.dirty) return;
    const d = this.dirty;
    this.dirty = null;
    const x = clamp(d.x0, 0, this.scratch.w);
    const y = clamp(d.y0, 0, this.scratch.h);
    const w = clamp(d.x1, 0, this.scratch.w) - x;
    const h = clamp(d.y1, 0, this.scratch.h) - y;
    if (w <= 0 || h <= 0) return;

    if (this.selection) {
      const ctx = this.scratch.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.selection.canvas, -this.offX, -this.offY);
      ctx.restore();
    }

    const p = this.preview.ctx;
    p.save();
    p.beginPath();
    p.rect(x, y, w, h);
    p.clip();
    p.clearRect(x, y, w, h);
    p.drawImage(this.base.canvas, x, y, w, h, x, y, w, h);
    p.globalAlpha = clamp(this.settings.opacity, 0, 1);
    p.globalCompositeOperation = this.mode === 'erase' ? 'destination-out' : 'source-over';
    p.drawImage(this.scratch.canvas, x, y, w, h, x, y, w, h);
    p.restore();
  }

  begin(docX: number, docY: number, pressure: number): void {
    const x = docX - this.offX, y = docY - this.offY;
    this.lastX = this.smoothX = x;
    this.lastY = this.smoothY = y;
    this.carry = 0;
    this.started = true;
    this.dab(x, y, pressure);
    this.flush();
  }

  extend(docX: number, docY: number, pressure: number): void {
    if (!this.started) return;
    const s = this.settings;
    const tx = docX - this.offX, ty = docY - this.offY;
    const follow = 1 - clamp(s.smoothing, 0, 95) / 100;
    this.smoothX += (tx - this.smoothX) * Math.max(0.05, follow);
    this.smoothY += (ty - this.smoothY) * Math.max(0.05, follow);
    const x = this.smoothX, y = this.smoothY;

    const size = s.sizePressure ? Math.max(1, s.size * (0.25 + 0.75 * pressure)) : s.size;
    const step = Math.max(0.5, (size * clamp(s.spacing, 1, 200)) / 100);
    const dx = x - this.lastX, dy = y - this.lastY;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;

    let travelled = -this.carry;
    while (travelled + step <= len) {
      travelled += step;
      const t = travelled / len;
      this.dab(this.lastX + dx * t, this.lastY + dy * t, pressure);
    }
    this.carry = len - travelled;
    this.lastX = x;
    this.lastY = y;
    this.flush();
  }

  /** Straight segment used by shift-click line drawing. */
  lineTo(docX: number, docY: number, pressure: number): void {
    this.extend(docX, docY, pressure);
  }

  abort(): void {
    this.doc.livePreview = null;
    this.doc.touch();
  }

  /** Bake the stroke into the layer and push a history step. */
  commit(label: string): boolean {
    this.doc.livePreview = null;
    if (!this.bounds) { this.doc.touch(); return false; }
    this.flush();
    const target = this.isMask
      ? this.doc.mutableMask(this.layer)
      : this.doc.mutableSurface(this.layer);
    target.ctx.save();
    target.ctx.globalAlpha = clamp(this.settings.opacity, 0, 1);
    target.ctx.globalCompositeOperation = this.mode === 'erase' ? 'destination-out' : 'source-over';
    target.ctx.drawImage(this.scratch.canvas, 0, 0);
    target.ctx.restore();
    this.doc.commit(label);
    return true;
  }
}
