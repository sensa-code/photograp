import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import type { GradientStop, Layer, TextStyle } from '../core/types';
import type { PaintTarget } from '../core/document';
import { createSurface, type Surface } from '../core/surface';
import { clamp, normalizeRect } from '../core/geometry';
import { rgbCss, type RGB } from '../core/color';
import { createRasterLayer, createTextLayer } from '../core/layer';
import { gradientById, loadGradients, resolveStops, sortStops } from '../core/gradients';
import { renderGradient, type GradientKind } from '../core/gradient-render';

// Gradient rendering lives in core so the compositor can use it too; the
// tool keeps re-exporting it because that is where callers already look.
export { renderGradient, type GradientKind };
import {
  defaultShapeStyle, renderShapeLayer, shapeToVectorPath, type ShapeKind as VectorShapeKind,
} from '../core/shape';
import type { Layer as LayerType } from '../core/types';
import {
  defaultPathBinding, defaultTextStyle, overflowLines, renderTextLayer,
} from '../core/text';
import { closestOnPath } from '../core/path';
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

/** Choices for the tool's gradient picker, rebuilt when the user saves one. */
export const GRADIENT_PRESETS: { value: string; label: string }[] = [];

export function refreshGradientOptions(): void {
  GRADIENT_PRESETS.length = 0;
  for (const g of loadGradients()) GRADIENT_PRESETS.push({ value: g.id, label: g.name });
}
refreshGradientOptions();

/** The stops of a saved gradient, with any foreground/background refs resolved. */
export function presetStops(preset: string, fg: RGB, bg: RGB): GradientStop[] {
  return resolveStops(sortStops(gradientById(preset).stops), fg, bg);
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

  /** Set while dragging out a paragraph frame. */
  private start: { x: number; y: number } | null = null;
  private end = { x: 0, y: 0 };
  /** Last overflow count, kept because the overlay redraws far more often
   *  than the type changes and re-wrapping is not free. */
  private overflow: { key: string; lines: number } | null = null;

  /** How many lines of `t` fall outside its frame, from cache when it can. */
  private overflowOf(t: TextStyle): number {
    const key = `${t.text}\u0000${t.box?.w}x${t.box?.h}\u0000${t.fontSize}`
      + `\u0000${t.lineHeight}\u0000${t.letterSpacing}\u0000${t.fontFamily}`
      + `\u0000${t.bold}${t.italic}`;
    if (this.overflow?.key !== key) this.overflow = { key, lines: overflowLines(t) };
    return this.overflow.lines;
  }

  /** The type layer under the pointer, if its glyphs cover that pixel. */
  private layerAt(e: ToolPointer): Layer | null {
    for (let i = e.doc.layers.length - 1; i >= 0; i--) {
      const l = e.doc.layers[i];
      if (l.kind !== 'text' || !l.visible || !l.surface) continue;
      const lx = Math.floor(e.x - l.x), ly = Math.floor(e.y - l.y);
      if (lx < 0 || ly < 0 || lx >= l.surface.w || ly >= l.surface.h) continue;
      if (l.surface.ctx.getImageData(lx, ly, 1, 1).data[3] > 8) return l;
    }
    return null;
  }

  /** Create a type layer at `x,y`; `box` makes it a paragraph frame. */
  private create(e: ToolPointer, x: number, y: number, box: { w: number; h: number } | null): void {
    const style = defaultTextStyle();
    style.color = { ...e.app.foreground };
    style.text = '';
    if (box) {
      style.box = box;
    } else {
      // Clicking on the active path starts type that runs along it, the way
      // Photoshop's type tool does when the cursor is over a path. A frame
      // and a path are alternatives, so only point type looks for one.
      const path = e.doc.activePath();
      const near = path ? closestOnPath(path, { x, y }) : null;
      if (path && near && near.distance <= 10 / e.zoom) {
        style.onPath = { ...defaultPathBinding(path.id), offset: near.along };
      }
    }
    const layer = createTextLayer(box ? '段落文字' : '文字', e.doc.width, e.doc.height, style);
    layer.x = Math.round(x);
    layer.y = Math.round(y);
    e.doc.insertLayerAbove(layer, e.doc.activeLayerId);
    renderTextLayer(layer, e.doc.width, e.doc.height, e.doc.paths);
    e.doc.commit('新增文字圖層');
    textEditorHook?.(layer, e.doc, e.app);
    e.app.changed();
  }

  down(e: ToolPointer): void {
    // Clicking an existing type layer reopens it for editing.
    const hit = this.layerAt(e);
    if (hit) {
      e.doc.activeLayerId = hit.id;
      textEditorHook?.(hit, e.doc, e.app);
      e.app.changed();
      return;
    }
    // Anywhere else, a click makes point type and a drag makes a frame; which
    // one it is only becomes clear on release.
    this.start = { x: e.x, y: e.y };
    this.end = { x: e.x, y: e.y };
  }

  move(e: ToolPointer): void {
    if (!this.start) return;
    this.end = { x: e.x, y: e.y };
    e.app.changed();
  }

  up(e: ToolPointer): void {
    const start = this.start;
    this.start = null;
    if (!start) return;
    const r = normalizeRect(start, this.end);
    // A frame needs room for at least one line; below that it was a click.
    const dragged = r.w >= 8 && r.h >= 8;
    e.app.changed();
    if (dragged) this.create(e, r.x, r.y, { w: Math.round(r.w), h: Math.round(r.h) });
    else this.create(e, start.x, start.y, null);
  }

  drawOverlay(o: OverlayPaint): void {
    const rects: { x: number; y: number; w: number; h: number; live: boolean }[] = [];
    if (this.start) {
      const r = normalizeRect(this.start, this.end);
      rects.push({ ...r, live: true });
    }
    // The frame of the selected paragraph layer, so its bounds stay visible
    // even when the type does not reach them.
    const active = o.doc.activeLayer();
    if (active?.kind === 'text' && active.text?.box) {
      const b = active.text.box;
      rects.push({ x: active.x, y: active.y, w: b.w, h: b.h, live: false });
    }
    if (!rects.length) return;

    const { ctx, zoom } = o;
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    for (const r of rects) {
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = r.live ? '#ffffff' : 'rgba(255,255,255,0.75)';
      ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
    // Photoshop's overflow marker: a cross in the bottom-right handle when
    // there is more type than the frame can show.
    if (active?.kind === 'text' && active.text?.box && this.overflowOf(active.text) > 0) {
      const b = active.text.box;
      const s = 7 / zoom;
      const x = active.x + b.w - s / 2, y = active.y + b.h - s / 2;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = '#c0392b';
      ctx.beginPath();
      ctx.moveTo(x + 1.5 / zoom, y + 1.5 / zoom);
      ctx.lineTo(x + s - 1.5 / zoom, y + s - 1.5 / zoom);
      ctx.moveTo(x + s - 1.5 / zoom, y + 1.5 / zoom);
      ctx.lineTo(x + 1.5 / zoom, y + s - 1.5 / zoom);
      ctx.stroke();
    }
    ctx.restore();
  }

  cancel(app: App): void {
    this.start = null;
    app.changed();
  }
}
