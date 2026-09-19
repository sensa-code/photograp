import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import type { GradientStop, Layer } from '../core/types';
import type { PaintTarget } from '../core/document';
import { createSurface, type Surface } from '../core/surface';
import { clamp, normalizeRect } from '../core/geometry';
import { rgbCss, type RGB } from '../core/color';
import { createRasterLayer, createTextLayer } from '../core/layer';
import {
  defaultShapeStyle, renderShapeLayer, shapeToVectorPath, type ShapeKind as VectorShapeKind,
} from '../core/shape';
import type { Layer as LayerType } from '../core/types';
import { defaultTextStyle, renderTextLayer } from '../core/text';
import { floodSelect } from './select';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

/** Fill the current paint target through an 8-bit coverage mask. */
function fillThroughCoverage(
  doc: PhotoDoc, target: PaintTarget, cov: Uint8Array, style: string | CanvasGradient,
  opacity: number, label: string,
): void {
  const covSurf = createSurface(doc.width, doc.height);
  const img = covSurf.ctx.createImageData(doc.width, doc.height);
  const d = img.data;
  const sel = target.clipToSelection ? doc.selection.mask : null;
  for (let i = 0, p = 0; i < cov.length; i++, p += 4) {
    d[p] = 255; d[p + 1] = 255; d[p + 2] = 255;
    d[p + 3] = sel ? (cov[i] * sel[i]) / 255 : cov[i];
  }
  covSurf.ctx.putImageData(img, 0, 0);

  const paint = createSurface(doc.width, doc.height);
  paint.ctx.fillStyle = style;
  paint.ctx.fillRect(0, 0, paint.w, paint.h);
  paint.ctx.globalCompositeOperation = 'destination-in';
  paint.ctx.drawImage(covSurf.canvas, 0, 0);

  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.save();
  dest.ctx.globalAlpha = clamp(opacity, 0, 1);
  dest.ctx.drawImage(paint.canvas, -target.offX, -target.offY);
  dest.ctx.restore();
  doc.commit(label);
}

export class BucketTool implements Tool {
  id = 'bucket';
  name = '油漆桶工具';
  shortcut = 'g';
  icon = 'bucket';
  group = 'fill';
  cursor = 'crosshair';
  options: ToolOption[] = [
    {
      key: 'fillWith', label: '填滿', type: 'select', default: 'foreground',
      options: [
        { value: 'foreground', label: '前景色' },
        { value: 'background', label: '背景色' },
      ],
    },
    { key: 'tolerance', label: '容許度', type: 'slider', min: 0, max: 255, step: 1, default: 32 },
    { key: 'opacity', label: '不透明度', type: 'slider', min: 1, max: 100, step: 1, default: 100, unit: '%' },
    { key: 'contiguous', label: '連續的', type: 'checkbox', default: true },
    { key: 'sampleAll', label: '取樣全部圖層', type: 'checkbox', default: false },
    { key: 'expand', label: '擴張邊緣', type: 'slider', min: 0, max: 8, step: 1, default: 1, unit: ' px' },
  ];

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) {
      e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法填色', 'error');
      return;
    }
    const x = Math.floor(e.x), y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;

    const o = e.app.toolOptions[this.id] ?? {};
    const sampleAll = Boolean(o.sampleAll) && target.slot === 'pixels';
    const src = sampleAll ? e.doc.composite() : target.surface;
    const ox = sampleAll ? 0 : target.offX;
    const oy = sampleAll ? 0 : target.offY;
    const lx = x - ox, ly = y - oy;
    if (lx < 0 || ly < 0 || lx >= src.w || ly >= src.h) return;

    const img = src.ctx.getImageData(0, 0, src.w, src.h);
    const raw = floodSelect(img, lx, ly, Number(o.tolerance ?? 32), o.contiguous !== false);

    // Map the coverage back into document space.
    let cov = raw;
    if (ox !== 0 || oy !== 0 || src.w !== e.doc.width || src.h !== e.doc.height) {
      cov = new Uint8Array(e.doc.width * e.doc.height);
      for (let yy = 0; yy < src.h; yy++) {
        const dy = yy + oy;
        if (dy < 0 || dy >= e.doc.height) continue;
        for (let xx = 0; xx < src.w; xx++) {
          const dx = xx + ox;
          if (dx < 0 || dx >= e.doc.width) continue;
          cov[dy * e.doc.width + dx] = raw[yy * src.w + xx];
        }
      }
    }

    const expand = Number(o.expand ?? 1);
    if (expand > 0) cov = dilate(cov, e.doc.width, e.doc.height, expand);

    const color = o.fillWith === 'background' ? e.app.background : e.app.foreground;
    fillThroughCoverage(
      e.doc, target, cov, rgbCss(color), Number(o.opacity ?? 100) / 100, '油漆桶填色',
    );
    e.app.changed();
  }

  move(): void { /* click only */ }
  up(): void { /* click only */ }
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) v = Math.max(v, src[y * w + xx]);
      }
      tmp[y * w + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) v = Math.max(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export type GradientKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export const GRADIENT_PRESETS: { value: string; label: string }[] = [
  { value: 'fg-bg', label: '前景到背景' },
  { value: 'fg-transparent', label: '前景到透明' },
  { value: 'black-white', label: '黑到白' },
  { value: 'spectrum', label: '光譜' },
  { value: 'sunset', label: '日落' },
  { value: 'transparent-fg', label: '透明到前景' },
];

export function presetStops(preset: string, fg: RGB, bg: RGB): GradientStop[] {
  switch (preset) {
    case 'fg-transparent':
      return [{ pos: 0, color: fg, alpha: 1 }, { pos: 1, color: fg, alpha: 0 }];
    case 'transparent-fg':
      return [{ pos: 0, color: fg, alpha: 0 }, { pos: 1, color: fg, alpha: 1 }];
    case 'black-white':
      return [
        { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
        { pos: 1, color: { r: 255, g: 255, b: 255 }, alpha: 1 },
      ];
    case 'spectrum':
      return [
        { pos: 0, color: { r: 255, g: 0, b: 0 }, alpha: 1 },
        { pos: 0.17, color: { r: 255, g: 255, b: 0 }, alpha: 1 },
        { pos: 0.34, color: { r: 0, g: 255, b: 0 }, alpha: 1 },
        { pos: 0.5, color: { r: 0, g: 255, b: 255 }, alpha: 1 },
        { pos: 0.67, color: { r: 0, g: 0, b: 255 }, alpha: 1 },
        { pos: 0.84, color: { r: 255, g: 0, b: 255 }, alpha: 1 },
        { pos: 1, color: { r: 255, g: 0, b: 0 }, alpha: 1 },
      ];
    case 'sunset':
      return [
        { pos: 0, color: { r: 255, g: 94, b: 77 }, alpha: 1 },
        { pos: 0.5, color: { r: 255, g: 175, b: 64 }, alpha: 1 },
        { pos: 1, color: { r: 66, g: 39, b: 90 }, alpha: 1 },
      ];
    default:
      return [{ pos: 0, color: fg, alpha: 1 }, { pos: 1, color: bg, alpha: 1 }];
  }
}

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

export class GradientTool implements Tool {
  id = 'gradient';
  name = '漸層工具';
  shortcut = 'g';
  icon = 'gradient';
  group = 'fill';
  cursor = 'crosshair';
  options: ToolOption[] = [
    { key: 'preset', label: '漸層', type: 'select', default: 'fg-bg', options: GRADIENT_PRESETS },
    {
      key: 'kind', label: '樣式', type: 'segmented', default: 'linear',
      options: [
        { value: 'linear', label: '線性' },
        { value: 'radial', label: '放射狀' },
        { value: 'angle', label: '角度' },
        { value: 'reflected', label: '反射' },
        { value: 'diamond', label: '菱形' },
      ],
    },
    { key: 'opacity', label: '不透明度', type: 'slider', min: 1, max: 100, step: 1, default: 100, unit: '%' },
    { key: 'reverse', label: '反轉', type: 'checkbox', default: false },
    { key: 'dither', label: '混色', type: 'checkbox', default: true },
  ];

  private dragging = false;
  private start = { x: 0, y: 0 };
  private end = { x: 0, y: 0 };
  private preview: Surface | null = null;
  private baseSurface: Surface | null = null;
  private target: PaintTarget | null = null;

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) {
      e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法填入漸層', 'error');
      return;
    }
    this.target = target;
    this.baseSurface = target.surface;
    this.preview = createSurface(target.surface.w, target.surface.h);
    this.dragging = true;
    this.start = { x: e.x, y: e.y };
    this.end = { x: e.x, y: e.y };
    e.doc.setPaintPreview(target.layer, target.slot, this.preview);
  }

  private paint(e: ToolPointer, target: Surface): void {
    const o = e.app.toolOptions[this.id] ?? {};
    const stops = presetStops(String(o.preset ?? 'fg-bg'), e.app.foreground, e.app.background);
    const grad = createSurface(e.doc.width, e.doc.height);
    let { x: ex, y: ey } = this.end;
    if (e.shift) {
      const dx = ex - this.start.x, dy = ey - this.start.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      ex = this.start.x + Math.cos(ang) * len;
      ey = this.start.y + Math.sin(ang) * len;
    }
    renderGradient(
      grad, String(o.kind ?? 'linear') as GradientKind,
      this.start.x, this.start.y, ex, ey,
      stops, Boolean(o.reverse), Boolean(o.dither),
    );
    if (e.doc.selection.active && this.target?.clipToSelection !== false) {
      grad.ctx.globalCompositeOperation = 'destination-in';
      grad.ctx.drawImage(e.doc.selection.toSurface().canvas, 0, 0);
    }
    target.ctx.clearRect(0, 0, target.w, target.h);
    if (this.baseSurface) target.ctx.drawImage(this.baseSurface.canvas, 0, 0);
    target.ctx.save();
    target.ctx.globalAlpha = Number(o.opacity ?? 100) / 100;
    target.ctx.drawImage(grad.canvas, -(this.target?.offX ?? 0), -(this.target?.offY ?? 0));
    target.ctx.restore();
  }

  move(e: ToolPointer): void {
    if (!this.dragging || !this.preview) return;
    this.end = { x: e.x, y: e.y };
    this.paint(e, this.preview);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.dragging || !this.target) return;
    this.dragging = false;
    e.doc.clearPaintPreview();
    const moved = Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) > 1;
    if (moved) {
      const dest = e.doc.mutablePaintSurface(this.target.layer, this.target.slot);
      this.paint(e, dest);
      e.doc.commit('漸層填色');
    } else {
      e.doc.touch();
    }
    this.preview = this.baseSurface = null;
    this.target = null;
    e.app.changed();
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.dragging) return;
    const { ctx, zoom } = o;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(this.start.x, this.start.y);
    ctx.lineTo(this.end.x, this.end.y);
    ctx.stroke();
    ctx.restore();
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    if (doc) { doc.clearPaintPreview(); doc.touch(); }
    this.dragging = false;
    this.preview = this.baseSurface = null;
    this.target = null;
    app.changed();
  }
}

// ---------------------------------------------------------------------------

export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'line' | 'polygon' | 'star' | 'arrow';

export function shapePath(
  kind: ShapeKind, x0: number, y0: number, x1: number, y1: number,
  radius: number, sides: number,
): Path2D {
  const p = new Path2D();
  const r = normalizeRect({ x: x0, y: y0 }, { x: x1, y: y1 });
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  switch (kind) {
    case 'rect':
      p.rect(r.x, r.y, r.w, r.h);
      break;
    case 'rounded':
      p.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.w / 2, r.h / 2));
      break;
    case 'ellipse':
      p.ellipse(cx, cy, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      break;
    case 'line':
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
      break;
    case 'arrow': {
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(8, Math.hypot(x1 - x0, y1 - y0) * 0.18);
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
      p.moveTo(x1, y1);
      p.lineTo(x1 - Math.cos(ang - 0.4) * head, y1 - Math.sin(ang - 0.4) * head);
      p.moveTo(x1, y1);
      p.lineTo(x1 - Math.cos(ang + 0.4) * head, y1 - Math.sin(ang + 0.4) * head);
      break;
    }
    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.round(sides));
      const rx = r.w / 2, ry = r.h / 2;
      for (let i = 0; i < n * (kind === 'star' ? 2 : 1); i++) {
        const step = (Math.PI * 2) / (n * (kind === 'star' ? 2 : 1));
        const a = -Math.PI / 2 + i * step;
        const f = kind === 'star' && i % 2 === 1 ? 0.45 : 1;
        const px = cx + Math.cos(a) * rx * f;
        const py = cy + Math.sin(a) * ry * f;
        if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
      }
      p.closePath();
      break;
    }
  }
  return p;
}

export class ShapeTool implements Tool {
  id = 'shape';
  name = '形狀工具';
  shortcut = 'u';
  icon = 'shape';
  group = 'fill';
  cursor = 'crosshair';
  options: ToolOption[] = [
    {
      key: 'output', label: '輸出', type: 'segmented', default: 'shape',
      options: [
        { value: 'shape', label: '形狀圖層' },
        { value: 'pixels', label: '填滿像素' },
      ],
    },
    {
      key: 'kind', label: '形狀', type: 'select', default: 'rect',
      options: [
        { value: 'rect', label: '矩形' },
        { value: 'rounded', label: '圓角矩形' },
        { value: 'ellipse', label: '橢圓' },
        { value: 'line', label: '直線' },
        { value: 'arrow', label: '箭頭' },
        { value: 'polygon', label: '多邊形' },
        { value: 'star', label: '星形' },
      ],
    },
    {
      key: 'paint', label: '繪製', type: 'segmented', default: 'fill',
      options: [
        { value: 'fill', label: '填滿' },
        { value: 'stroke', label: '筆畫' },
        { value: 'both', label: '兩者' },
      ],
    },
    { key: 'strokeWidth', label: '筆畫寬度', type: 'slider', min: 1, max: 100, step: 1, default: 4, unit: ' px' },
    { key: 'radius', label: '圓角', type: 'slider', min: 0, max: 200, step: 1, default: 16, unit: ' px' },
    { key: 'sides', label: '邊數', type: 'slider', min: 3, max: 24, step: 1, default: 5 },
    { key: 'newLayer', label: '建立新圖層', type: 'checkbox', default: false },
  ];

  private dragging = false;
  private start = { x: 0, y: 0 };
  private end = { x: 0, y: 0 };
  private preview: Surface | null = null;
  private baseSurface: Surface | null = null;
  private target: PaintTarget | null = null;
  /** Set while drawing a live, re-editable vector shape layer. */
  private shapeLayer: LayerType | null = null;

  /** Geometry for the current drag, with Shift constraints applied. */
  private corners(e: ToolPointer, kind: string): [number, number, number, number] {
    let ex = this.end.x, ey = this.end.y;
    if (e.shift) {
      const dx = ex - this.start.x, dy = ey - this.start.y;
      if (kind === 'line' || kind === 'arrow') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        ex = this.start.x + Math.cos(ang) * len;
        ey = this.start.y + Math.sin(ang) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        ex = this.start.x + Math.sign(dx || 1) * m;
        ey = this.start.y + Math.sign(dy || 1) * m;
      }
    }
    return [this.start.x, this.start.y, ex, ey];
  }

  /** Rebuild the live shape layer's geometry from the current drag. */
  private updateShape(e: ToolPointer): void {
    const layer = this.shapeLayer;
    if (!layer?.shape) return;
    const o = e.app.toolOptions[this.id] ?? {};
    const kind = String(o.kind ?? 'rect');
    const [x0, y0, x1, y1] = this.corners(e, kind);
    layer.shape.path = shapeToVectorPath(
      kind as VectorShapeKind, x0, y0, x1, y1,
      Number(o.radius ?? 16), Number(o.sides ?? 5), layer.name,
    );
    renderShapeLayer(layer, e.doc.width, e.doc.height);
    e.doc.touch();
  }

  down(e: ToolPointer): void {
    const opts = e.app.toolOptions[this.id] ?? {};
    // While a mask or Quick Mask has the brush, the shape belongs in that
    // channel — creating a layer there would ignore what the user is editing.
    const intoMask = !!e.doc.quickMask || (e.doc.editingMask && !!e.doc.activeLayer()?.mask);
    if (!intoMask && String(opts.output ?? 'shape') === 'shape') {
      const kind = String(opts.kind ?? 'rect');
      const mode = String(opts.paint ?? 'fill');
      const outline = kind === 'line' || kind === 'arrow';
      const layer = createRasterLayer('形狀', e.doc.width, e.doc.height);
      layer.kind = 'shape';
      const style = defaultShapeStyle(e.app.foreground, e.app.background);
      style.fillEnabled = !outline && (mode === 'fill' || mode === 'both');
      style.strokeEnabled = outline || mode === 'stroke' || mode === 'both';
      if (outline || mode === 'stroke') style.stroke = { ...e.app.foreground };
      style.strokeWidth = Number(opts.strokeWidth ?? 4);
      layer.shape = {
        path: shapeToVectorPath(kind as VectorShapeKind, e.x, e.y, e.x, e.y, 0, 5, '形狀'),
        style,
      };
      e.doc.insertLayerAbove(layer, e.doc.activeLayerId);
      this.shapeLayer = layer;
      this.dragging = true;
      this.start = { x: e.x, y: e.y };
      this.end = { x: e.x, y: e.y };
      e.app.changed();
      return;
    }
    let target = e.doc.paintTarget();
    // A brand new layer only makes sense when drawing onto layer pixels.
    const wantsNewLayer = Boolean(e.app.toolOptions[this.id]?.newLayer);
    if (!target || (target.slot === 'pixels' && wantsNewLayer)) {
      if (target === null && e.doc.activeLayer()?.locked) {
        e.app.toast('圖層已鎖定', 'error');
        return;
      }
      if (!target || target.slot === 'pixels') {
        const layer = createRasterLayer('形狀', e.doc.width, e.doc.height);
        e.doc.insertLayerAbove(layer, e.doc.activeLayerId);
        target = e.doc.paintTarget();
      }
    }
    if (!target) {
      e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法繪製形狀', 'error');
      return;
    }
    this.target = target;
    this.baseSurface = target.surface;
    this.preview = createSurface(target.surface.w, target.surface.h);
    this.dragging = true;
    this.start = { x: e.x, y: e.y };
    this.end = { x: e.x, y: e.y };
    e.doc.setPaintPreview(target.layer, target.slot, this.preview);
  }

  private paint(e: ToolPointer, target: Surface): void {
    const o = e.app.toolOptions[this.id] ?? {};
    const kind = String(o.kind ?? 'rect') as ShapeKind;
    let { x: ex, y: ey } = this.end;
    if (e.shift) {
      if (kind === 'line' || kind === 'arrow') {
        const dx = ex - this.start.x, dy = ey - this.start.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        ex = this.start.x + Math.cos(ang) * len;
        ey = this.start.y + Math.sin(ang) * len;
      } else {
        const dx = ex - this.start.x, dy = ey - this.start.y;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        ex = this.start.x + Math.sign(dx || 1) * m;
        ey = this.start.y + Math.sign(dy || 1) * m;
      }
    }
    const shape = createSurface(e.doc.width, e.doc.height);
    const ctx = shape.ctx;
    const path = shapePath(
      kind, this.start.x, this.start.y, ex, ey,
      Number(o.radius ?? 16), Number(o.sides ?? 5),
    );
    const mode = String(o.paint ?? 'fill');
    const isStrokeOnly = kind === 'line' || kind === 'arrow';
    if (!isStrokeOnly && (mode === 'fill' || mode === 'both')) {
      ctx.fillStyle = rgbCss(e.app.foreground);
      ctx.fill(path);
    }
    if (isStrokeOnly || mode === 'stroke' || mode === 'both') {
      ctx.lineWidth = Number(o.strokeWidth ?? 4);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgbCss(isStrokeOnly || mode === 'stroke' ? e.app.foreground : e.app.background);
      ctx.stroke(path);
    }
    if (e.doc.selection.active && this.target?.clipToSelection !== false) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(e.doc.selection.toSurface().canvas, 0, 0);
    }
    target.ctx.clearRect(0, 0, target.w, target.h);
    if (this.baseSurface) target.ctx.drawImage(this.baseSurface.canvas, 0, 0);
    target.ctx.drawImage(shape.canvas, -(this.target?.offX ?? 0), -(this.target?.offY ?? 0));
  }

  move(e: ToolPointer): void {
    if (!this.dragging) return;
    this.end = { x: e.x, y: e.y };
    if (this.shapeLayer) {
      this.updateShape(e);
      e.app.changed();
      return;
    }
    if (!this.preview) return;
    this.paint(e, this.preview);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (this.shapeLayer) {
      const layer = this.shapeLayer;
      this.dragging = false;
      // The pointer can travel between the last move and the release, so take
      // the geometry from this event before letting go of the layer.
      this.end = { x: e.x, y: e.y };
      if (Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) > 1) {
        this.updateShape(e);
        this.shapeLayer = null;
        e.doc.commit('建立形狀圖層');
      } else {
        // A click with no drag leaves nothing behind.
        this.shapeLayer = null;
        e.doc.removeLayer(layer.id);
        e.doc.touch();
      }
      e.app.changed();
      return;
    }
    if (!this.dragging || !this.target) return;
    this.dragging = false;
    e.doc.clearPaintPreview();
    if (Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) > 1) {
      const dest = e.doc.mutablePaintSurface(this.target.layer, this.target.slot);
      this.paint(e, dest);
      e.doc.commit('繪製形狀');
    } else {
      e.doc.touch();
    }
    this.preview = this.baseSurface = null;
    this.target = null;
    e.app.changed();
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    if (doc && this.shapeLayer) doc.removeLayer(this.shapeLayer.id);
    if (doc) { doc.clearPaintPreview(); doc.touch(); }
    this.shapeLayer = null;
    this.dragging = false;
    this.preview = this.baseSurface = null;
    this.target = null;
    app.changed();
  }
}

// ---------------------------------------------------------------------------

/** The UI installs the inline type editor here so the tool can call it. */
let textEditorHook: ((layer: Layer, doc: PhotoDoc, app: App) => void) | null = null;
export function setTextEditorHook(fn: (layer: Layer, doc: PhotoDoc, app: App) => void): void {
  textEditorHook = fn;
}

export class TextTool implements Tool {
  id = 'text';
  name = '文字工具';
  shortcut = 't';
  icon = 'text';
  group = 'fill';
  cursor = 'text';
  options: ToolOption[] = [];

  down(e: ToolPointer): void {
    // Clicking an existing type layer reopens it for editing.
    for (let i = e.doc.layers.length - 1; i >= 0; i--) {
      const l = e.doc.layers[i];
      if (l.kind !== 'text' || !l.visible || !l.surface) continue;
      const lx = Math.floor(e.x - l.x), ly = Math.floor(e.y - l.y);
      if (lx < 0 || ly < 0 || lx >= l.surface.w || ly >= l.surface.h) continue;
      if (l.surface.ctx.getImageData(lx, ly, 1, 1).data[3] > 8) {
        e.doc.activeLayerId = l.id;
        textEditorHook?.(l, e.doc, e.app);
        e.app.changed();
        return;
      }
    }
    const style = defaultTextStyle();
    style.color = { ...e.app.foreground };
    style.text = '';
    const layer = createTextLayer('文字', e.doc.width, e.doc.height, style);
    layer.x = Math.round(e.x);
    layer.y = Math.round(e.y);
    e.doc.insertLayerAbove(layer, e.doc.activeLayerId);
    renderTextLayer(layer, e.doc.width, e.doc.height);
    e.doc.commit('新增文字圖層');
    textEditorHook?.(layer, e.doc, e.app);
    e.app.changed();
  }

  move(): void { /* click only */ }
  up(): void { /* click only */ }
}
