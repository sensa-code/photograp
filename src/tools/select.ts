import type { App } from '../core/app';
import { rasterizePath, type SelectMode } from '../core/selection';
import { normalizeRect, type Point } from '../core/geometry';
import { snapPoint } from '../core/guides';
import { clearSnapLines, showSnapLines, snapContextFor } from './snap';
import type { Tool, ToolOption, ToolPointer, OverlayPaint } from './types';
import type { PhotoDoc } from '../core/document';

const MODE_OPTION: ToolOption = {
  key: 'mode', label: '運算', type: 'segmented', default: 'replace',
  options: [
    { value: 'replace', label: '新增' },
    { value: 'add', label: '增加' },
    { value: 'subtract', label: '減去' },
    { value: 'intersect', label: '交集' },
  ],
};

const FEATHER_OPTION: ToolOption = {
  key: 'feather', label: '羽化', type: 'slider', min: 0, max: 250, step: 1, default: 0, unit: ' px',
};

const ANTIALIAS_OPTION: ToolOption = {
  key: 'antialias', label: '消除鋸齒', type: 'checkbox', default: true,
};

/** Modifier keys override the options-bar operation, as in Photoshop. */
export function resolveMode(e: ToolPointer, fallback: string): SelectMode {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return (fallback as SelectMode) ?? 'replace';
}

function applySelection(
  doc: PhotoDoc, app: App, path: Path2D, mode: SelectMode, feather: number, label: string,
): void {
  const cov = rasterizePath(path, doc.width, doc.height);
  doc.selection.combine(cov, mode);
  if (feather > 0) doc.selection.feather(feather);
  doc.commit(label);
  app.changed();
}

export class MarqueeTool implements Tool {
  id = 'marquee';
  name = '選取畫面工具';
  shortcut = 'm';
  icon = 'marquee';
  group = 'select';
  cursor = 'crosshair';
  options: ToolOption[] = [
    MODE_OPTION,
    {
      key: 'shape', label: '形狀', type: 'segmented', default: 'rect',
      options: [
        { value: 'rect', label: '矩形' },
        { value: 'ellipse', label: '橢圓' },
        { value: 'row', label: '單列' },
        { value: 'column', label: '單欄' },
      ],
    },
    FEATHER_OPTION,
    ANTIALIAS_OPTION,
    {
      key: 'ratio', label: '比例', type: 'select', default: 'free',
      options: [
        { value: 'free', label: '正常' },
        { value: '1:1', label: '1:1' },
        { value: '4:3', label: '4:3' },
        { value: '3:2', label: '3:2' },
        { value: '16:9', label: '16:9' },
      ],
    },
  ];

  private dragging = false;
  private start: Point = { x: 0, y: 0 };
  private current: Point = { x: 0, y: 0 };
  private fromCenter = false;

  private rect(e?: ToolPointer): { x: number; y: number; w: number; h: number } {
    let a = this.start, b = this.current;
    const ratio = String(e?.app.toolOptions[this.id]?.ratio ?? 'free');
    if (ratio !== 'free') {
      const [rw, rh] = ratio.split(':').map(Number);
      const dx = b.x - a.x, dy = b.y - a.y;
      const target = Math.max(Math.abs(dx), (Math.abs(dy) * rw) / rh);
      b = { x: a.x + Math.sign(dx || 1) * target, y: a.y + Math.sign(dy || 1) * (target * rh) / rw };
    } else if (e?.shift) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      b = { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
    }
    if (this.fromCenter) {
      a = { x: this.start.x - (b.x - this.start.x), y: this.start.y - (b.y - this.start.y) };
    }
    return normalizeRect(a, b);
  }

  private buildPath(e: ToolPointer): Path2D {
    const shape = String(e.app.toolOptions[this.id]?.shape ?? 'rect');
    const p = new Path2D();
    if (shape === 'row') {
      p.rect(0, Math.round(this.current.y), e.doc.width, 1);
      return p;
    }
    if (shape === 'column') {
      p.rect(Math.round(this.current.x), 0, 1, e.doc.height);
      return p;
    }
    const r = this.rect(e);
    if (shape === 'ellipse') p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else p.rect(r.x, r.y, r.w, r.h);
    return p;
  }

  down(e: ToolPointer): void {
    this.dragging = true;
    this.fromCenter = false;
    const snapped = snapPoint(e.x, e.y, snapContextFor(e, null));
    this.start = { x: snapped.x, y: snapped.y };
    this.current = { x: snapped.x, y: snapped.y };
  }

  move(e: ToolPointer): void {
    if (!this.dragging) return;
    this.fromCenter = e.alt && !e.shift;
    const snapped = snapPoint(e.x, e.y, snapContextFor(e, null));
    this.current = { x: snapped.x, y: snapped.y };
    showSnapLines(e, snapped.lines);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    clearSnapLines(e);
    if (!this.dragging) return;
    this.dragging = false;
    const shape = String(e.app.toolOptions[this.id]?.shape ?? 'rect');
    const r = this.rect(e);
    const mode = resolveMode(e, String(e.app.toolOptions[this.id]?.mode ?? 'replace'));
    if (shape !== 'row' && shape !== 'column' && (r.w < 0.5 || r.h < 0.5)) {
      // A click with no drag clears the selection, matching Photoshop.
      if (mode === 'replace' && e.doc.selection.active) {
        e.doc.selection.clear();
        e.doc.commit('取消選取');
      }
      e.app.changed();
      return;
    }
    applySelection(
      e.doc, e.app, this.buildPath(e), mode,
      Number(e.app.toolOptions[this.id]?.feather ?? 0), '選取畫面',
    );
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.dragging) return;
    const { ctx, zoom } = o;
    const shape = String(o.app.toolOptions[this.id]?.shape ?? 'rect');
    if (shape === 'row' || shape === 'column') return;
    const r = this.rect();
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    if (shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 4 / zoom;
    ctx.stroke();
    ctx.restore();
  }

  cancel(app: App): void {
    if (this.dragging) { this.dragging = false; app.changed(); }
  }
}

export class LassoTool implements Tool {
  id = 'lasso';
  name = '套索工具';
  shortcut = 'l';
  icon = 'lasso';
  group = 'select';
  cursor = 'crosshair';
  options: ToolOption[] = [MODE_OPTION, FEATHER_OPTION, ANTIALIAS_OPTION];

  private points: Point[] = [];
  private active = false;

  down(e: ToolPointer): void {
    this.active = true;
    this.points = [{ x: e.x, y: e.y }];
  }

  move(e: ToolPointer): void {
    if (!this.active) return;
    const last = this.points[this.points.length - 1];
    if (Math.hypot(e.x - last.x, e.y - last.y) < 1) return;
    this.points.push({ x: e.x, y: e.y });
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.active) return;
    this.active = false;
    if (this.points.length < 3) { this.points = []; e.app.changed(); return; }
    const p = new Path2D();
    p.moveTo(this.points[0].x, this.points[0].y);
    for (const pt of this.points.slice(1)) p.lineTo(pt.x, pt.y);
    p.closePath();
    applySelection(
      e.doc, e.app, p, resolveMode(e, String(e.app.toolOptions[this.id]?.mode ?? 'replace')),
      Number(e.app.toolOptions[this.id]?.feather ?? 0), '套索選取',
    );
    this.points = [];
  }

  drawOverlay(o: OverlayPaint): void {
    if (this.points.length < 2) return;
    const { ctx, zoom } = o;
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (const p of this.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  }

  cancel(app: App): void {
    this.active = false;
    this.points = [];
    app.changed();
  }
}

export class PolygonLassoTool implements Tool {
  id = 'poly-lasso';
  name = '多邊形套索工具';
  shortcut = 'l';
  icon = 'polygon';
  group = 'select';
  cursor = 'crosshair';
  options: ToolOption[] = [MODE_OPTION, FEATHER_OPTION, ANTIALIAS_OPTION];

  private points: Point[] = [];
  private hoverPoint: Point | null = null;

  private finish(e: ToolPointer): void {
    if (this.points.length < 3) { this.points = []; this.hoverPoint = null; e.app.changed(); return; }
    const p = new Path2D();
    p.moveTo(this.points[0].x, this.points[0].y);
    for (const pt of this.points.slice(1)) p.lineTo(pt.x, pt.y);
    p.closePath();
    applySelection(
      e.doc, e.app, p, resolveMode(e, String(e.app.toolOptions[this.id]?.mode ?? 'replace')),
      Number(e.app.toolOptions[this.id]?.feather ?? 0), '多邊形選取',
    );
    this.points = [];
    this.hoverPoint = null;
  }

  down(e: ToolPointer): void {
    const first = this.points[0];
    if (first && this.points.length > 2 && Math.hypot(e.x - first.x, e.y - first.y) * e.zoom < 8) {
      this.finish(e);
      return;
    }
    this.points.push({ x: e.x, y: e.y });
    e.app.changed();
  }

  move(e: ToolPointer): void { this.hoverPoint = { x: e.x, y: e.y }; e.app.changed(); }
  up(): void { /* polygons advance on click, not on release */ }
  doubleClick(e: ToolPointer): void { this.finish(e); }

  key(ev: KeyboardEvent, app: App): boolean {
    if (ev.key === 'Enter' && this.points.length > 2) {
      const doc = app.activeDoc();
      if (!doc) return false;
      this.finish({
        app, doc, x: 0, y: 0, px: 0, py: 0, sx: 0, sy: 0,
        screenX: 0, screenY: 0, screenSX: 0, screenSY: 0,
        pressure: 1, shift: false, alt: false, ctrl: false, button: 0, zoom: 1,
      });
      return true;
    }
    if (ev.key === 'Backspace' && this.points.length) { this.points.pop(); app.changed(); return true; }
    return false;
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.points.length) return;
    const { ctx, zoom } = o;
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (const p of this.points.slice(1)) ctx.lineTo(p.x, p.y);
    if (this.hoverPoint) ctx.lineTo(this.hoverPoint.x, this.hoverPoint.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    for (const p of this.points) ctx.fillRect(p.x - 2 / zoom, p.y - 2 / zoom, 4 / zoom, 4 / zoom);
    ctx.restore();
  }

  cancel(app: App): void { this.points = []; this.hoverPoint = null; app.changed(); }
}

/** Scanline flood fill returning an 8-bit coverage buffer. */
export function floodSelect(
  img: ImageData, sx: number, sy: number, tolerance: number, contiguous: boolean,
): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(w * h);
  const si = (sy * w + sx) * 4;
  const sr = d[si], sg = d[si + 1], sb = d[si + 2], sa = d[si + 3];
  const tol = tolerance * tolerance * 4;

  const matches = (i: number): boolean => {
    const dr = d[i] - sr, dg = d[i + 1] - sg, db = d[i + 2] - sb, da = d[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  if (!contiguous) {
    for (let p = 0, i = 0; p < out.length; p++, i += 4) if (matches(i)) out[p] = 255;
    return out;
  }

  const stack: number[] = [sx, sy];
  const seen = new Uint8Array(w * h);
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    while (x >= 0 && !seen[y * w + x] && matches((y * w + x) * 4)) x--;
    x++;
    let spanUp = false, spanDown = false;
    while (x < w && !seen[y * w + x] && matches((y * w + x) * 4)) {
      seen[y * w + x] = 1;
      out[y * w + x] = 255;
      if (y > 0) {
        const up = matches(((y - 1) * w + x) * 4) && !seen[(y - 1) * w + x];
        if (up && !spanUp) { stack.push(x, y - 1); spanUp = true; }
        else if (!up) spanUp = false;
      }
      if (y < h - 1) {
        const dn = matches(((y + 1) * w + x) * 4) && !seen[(y + 1) * w + x];
        if (dn && !spanDown) { stack.push(x, y + 1); spanDown = true; }
        else if (!dn) spanDown = false;
      }
      x++;
    }
  }
  return out;
}

export class MagicWandTool implements Tool {
  id = 'wand';
  name = '魔術棒工具';
  shortcut = 'w';
  icon = 'wand';
  group = 'select';
  cursor = 'crosshair';
  options: ToolOption[] = [
    MODE_OPTION,
    { key: 'tolerance', label: '容許度', type: 'slider', min: 0, max: 255, step: 1, default: 32 },
    { key: 'contiguous', label: '連續的', type: 'checkbox', default: true },
    { key: 'sampleAll', label: '取樣全部圖層', type: 'checkbox', default: false },
    FEATHER_OPTION,
    { key: 'smooth', label: '平滑', type: 'slider', min: 0, max: 20, step: 1, default: 0, unit: ' px' },
  ];

  down(e: ToolPointer): void {
    const o = e.app.toolOptions[this.id] ?? {};
    const x = Math.floor(e.x), y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;

    const layer = e.doc.activeLayer();
    const src = o.sampleAll || !layer?.surface ? e.doc.composite() : layer.surface;
    // Layer surfaces are offset inside the document.
    const ox = o.sampleAll || !layer?.surface ? 0 : layer.x;
    const oy = o.sampleAll || !layer?.surface ? 0 : layer.y;
    const lx = x - ox, ly = y - oy;
    if (lx < 0 || ly < 0 || lx >= src.w || ly >= src.h) return;

    const img = src.ctx.getImageData(0, 0, src.w, src.h);
    const cov = floodSelect(img, lx, ly, Number(o.tolerance ?? 32), o.contiguous !== false);

    // Shift the coverage back into document space when sampling a layer.
    let docCov = cov;
    if (ox !== 0 || oy !== 0 || src.w !== e.doc.width || src.h !== e.doc.height) {
      docCov = new Uint8Array(e.doc.width * e.doc.height);
      for (let yy = 0; yy < src.h; yy++) {
        const dy = yy + oy;
        if (dy < 0 || dy >= e.doc.height) continue;
        for (let xx = 0; xx < src.w; xx++) {
          const dx = xx + ox;
          if (dx < 0 || dx >= e.doc.width) continue;
          docCov[dy * e.doc.width + dx] = cov[yy * src.w + xx];
        }
      }
    }

    e.doc.selection.combine(docCov, resolveMode(e, String(o.mode ?? 'replace')));
    const smooth = Number(o.smooth ?? 0);
    if (smooth > 0) { e.doc.selection.expand(smooth); e.doc.selection.contract(smooth); }
    const feather = Number(o.feather ?? 0);
    if (feather > 0) e.doc.selection.feather(feather);
    e.doc.commit('魔術棒選取');
    e.app.changed();
  }

  move(): void { /* single click tool */ }
  up(): void { /* single click tool */ }
}
