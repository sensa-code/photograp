import type { GradientStop } from './types';
import type { Surface } from './surface';
import { clamp } from './geometry';

export type GradientKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

const stopCss = (s: GradientStop): string => `rgba(${s.color.r},${s.color.g},${s.color.b},${s.alpha})`;

function addStops(g: CanvasGradient, stops: GradientStop[], reverse: boolean): void {
  const list = reverse
    ? stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse()
    : stops;
  for (const s of list) g.addColorStop(clamp(s.pos, 0, 1), stopCss(s));
}

/** Sample a stop list at t, returning premultiplied-free RGBA bytes. */
function sampleStops(stops: GradientStop[], t: number): [number, number, number, number] {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (t <= sorted[0].pos) {
    const s = sorted[0];
    return [s.color.r, s.color.g, s.color.b, s.alpha * 255];
  }
  const last = sorted[sorted.length - 1];
  if (t >= last.pos) return [last.color.r, last.color.g, last.color.b, last.alpha * 255];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const f = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
      return [
        a.color.r + (b.color.r - a.color.r) * f,
        a.color.g + (b.color.g - a.color.g) * f,
        a.color.b + (b.color.b - a.color.b) * f,
        (a.alpha + (b.alpha - a.alpha) * f) * 255,
      ];
    }
  }
  return [0, 0, 0, 0];
}

export function renderGradient(
  surface: Surface, kind: GradientKind, x0: number, y0: number, x1: number, y1: number,
  stops: GradientStop[], reverse: boolean, dither: boolean,
): void {
  const ctx = surface.ctx;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;

  if (kind === 'diamond') {
    const img = ctx.createImageData(surface.w, surface.h);
    const d = img.data;
    const ux = dx / len, uy = dy / len;
    for (let y = 0; y < surface.h; y++) {
      for (let x = 0; x < surface.w; x++) {
        const vx = x - x0, vy = y - y0;
        const a = Math.abs(vx * ux + vy * uy);
        const b = Math.abs(-vx * uy + vy * ux);
        let t = clamp((a + b) / len, 0, 1);
        if (reverse) t = 1 - t;
        const [r, g, bl, al] = sampleStops(stops, t);
        const i = (y * surface.w + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = bl; d[i + 3] = al;
      }
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  let grad: CanvasGradient;
  if (kind === 'radial') {
    grad = ctx.createRadialGradient(x0, y0, 0, x0, y0, len);
  } else if (kind === 'angle') {
    grad = ctx.createConicGradient(Math.atan2(dy, dx), x0, y0);
  } else if (kind === 'reflected') {
    grad = ctx.createLinearGradient(x0 - dx, y0 - dy, x1, y1);
    const mirrored: GradientStop[] = [];
    for (let i = stops.length - 1; i >= 0; i--) {
      mirrored.push({ ...stops[i], pos: (1 - stops[i].pos) / 2 });
    }
    for (const s of stops) mirrored.push({ ...s, pos: 0.5 + s.pos / 2 });
    addStops(grad, mirrored, reverse);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, surface.w, surface.h);
    return;
  } else {
    grad = ctx.createLinearGradient(x0, y0, x1, y1);
  }
  addStops(grad, stops, reverse);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, surface.w, surface.h);

  if (dither) {
    const img = ctx.getImageData(0, 0, surface.w, surface.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 3;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
}
