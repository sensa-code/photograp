import type { App } from '../core/app';
import type { Layer } from '../core/types';
import { cloneSurface, createSurface, type Surface } from '../core/surface';
import { clamp, normalizeRect, type Rect } from '../core/geometry';
import { luminance, type RGB } from '../core/color';
import { layerBounds, snapRect } from '../core/guides';
import { clearSnapLines, showSnapLines, snapContextFor } from './snap';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

export const ZOOM_STEPS = [
  0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.66, 1,
  1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32,
];

/** Change zoom while keeping the given document point under the cursor. */
export function zoomAt(app: App, docX: number, docY: number, newZoom: number): void {
  const v = app.view();
  const z = clamp(newZoom, 0.01, 32);
  v.centerX = docX - (docX - v.centerX) * (v.zoom / z);
  v.centerY = docY - (docY - v.centerY) * (v.zoom / z);
  v.zoom = z;
  app.events.emit('view-changed', undefined);
}

export function stepZoom(app: App, dir: 1 | -1, docX?: number, docY?: number): void {
  const v = app.view();
  const doc = app.activeDoc();
  const cx = docX ?? v.centerX;
  const cy = docY ?? v.centerY;
  let next = v.zoom;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > v.zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  else next = [...ZOOM_STEPS].reverse().find((z) => z < v.zoom - 1e-6) ?? ZOOM_STEPS[0];
  zoomAt(app, doc ? cx : 0, doc ? cy : 0, next);
}

export class MoveTool implements Tool {
  id = 'move';
  name = '移動工具';
  shortcut = 'v';
  icon = 'move';
  group = 'nav';
  cursor = 'move';
  options: ToolOption[] = [
    { key: 'autoSelect', label: '自動選取圖層', type: 'checkbox', default: false },
    { key: 'showTransform', label: '顯示變形控制項', type: 'checkbox', default: false },
    { key: 'snap', label: '貼齊整數像素', type: 'checkbox', default: true },
  ];

  private mode: 'none' | 'layer' | 'pixels' = 'none';
  private layer: Layer | null = null;
  private origin = { x: 0, y: 0 };
  private base: Surface | null = null;
  private floatSurf: Surface | null = null;
  private preview: Surface | null = null;
  private delta = { x: 0, y: 0 };
  /** Content bounds at drag start, used to snap edges and centres. */
  private startBounds: Rect | null = null;

  private pickLayer(e: ToolPointer): Layer | null {
    const list = e.doc.layers;
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (!l.visible || !l.surface) continue;
      const lx = Math.floor(e.x - l.x), ly = Math.floor(e.y - l.y);
      if (lx < 0 || ly < 0 || lx >= l.surface.w || ly >= l.surface.h) continue;
      if (l.surface.ctx.getImageData(lx, ly, 1, 1).data[3] > 8) return l;
    }
    return null;
  }

  down(e: ToolPointer): void {
    if (e.app.toolOptions[this.id]?.autoSelect) {
      const picked = this.pickLayer(e);
      if (picked) { e.doc.activeLayerId = picked.id; e.app.changed(); }
    }
    const layer = e.doc.activeLayer();
    if (!layer || layer.locked) {
      e.app.toast(layer ? '圖層已鎖定' : '沒有作用中的圖層', 'error');
      return;
    }
    this.layer = layer;
    this.delta = { x: 0, y: 0 };
    this.startBounds = e.doc.selection.active && !e.doc.editingMask
      ? e.doc.selection.bounds()
      : layerBounds(layer);

    if (e.doc.selection.active && layer.surface && !e.doc.editingMask) {
      const sel = e.doc.selection.toSurface();
      const w = layer.surface.w, h = layer.surface.h;
      this.floatSurf = createSurface(w, h);
      this.floatSurf.ctx.drawImage(layer.surface.canvas, 0, 0);
      this.floatSurf.ctx.globalCompositeOperation = 'destination-in';
      this.floatSurf.ctx.drawImage(sel.canvas, -layer.x, -layer.y);

      this.base = createSurface(w, h);
      this.base.ctx.drawImage(layer.surface.canvas, 0, 0);
      this.base.ctx.globalCompositeOperation = 'destination-out';
      this.base.ctx.drawImage(sel.canvas, -layer.x, -layer.y);

      this.preview = cloneSurface(layer.surface);
      e.doc.livePreview = { layerId: layer.id, surface: this.preview, isMask: false };
      this.mode = 'pixels';
    } else {
      this.origin = { x: layer.x, y: layer.y };
      this.mode = 'layer';
    }
  }

  move(e: ToolPointer): void {
    if (this.mode === 'none' || !this.layer) return;
    let dx = e.x - e.sx, dy = e.y - e.sy;
    if (e.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }
    if (e.app.toolOptions[this.id]?.snap !== false) {
      dx = Math.round(dx); dy = Math.round(dy);
    }

    // Snap the moved content to guides, the grid, the canvas and other layers.
    if (this.startBounds) {
      const ctx = snapContextFor(e, this.layer.id);
      const moved = {
        x: this.startBounds.x + dx,
        y: this.startBounds.y + dy,
        w: this.startBounds.w,
        h: this.startBounds.h,
      };
      const snapped = snapRect(moved, ctx);
      dx += snapped.dx;
      dy += snapped.dy;
      showSnapLines(e, snapped.lines);
    } else {
      clearSnapLines(e);
    }
    this.delta = { x: dx, y: dy };

    if (this.mode === 'layer') {
      this.layer.x = this.origin.x + dx;
      this.layer.y = this.origin.y + dy;
      e.doc.touch();
    } else if (this.preview && this.base && this.floatSurf) {
      const p = this.preview.ctx;
      p.clearRect(0, 0, this.preview.w, this.preview.h);
      p.drawImage(this.base.canvas, 0, 0);
      p.drawImage(this.floatSurf.canvas, dx, dy);
    }
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (this.mode === 'none' || !this.layer) return;
    const { x: dx, y: dy } = this.delta;
    if (this.mode === 'pixels' && this.base && this.floatSurf) {
      e.doc.livePreview = null;
      if (dx !== 0 || dy !== 0) {
        const target = e.doc.mutableSurface(this.layer);
        target.ctx.clearRect(0, 0, target.w, target.h);
        target.ctx.drawImage(this.base.canvas, 0, 0);
        target.ctx.drawImage(this.floatSurf.canvas, dx, dy);
        e.doc.selection.translate(Math.round(dx), Math.round(dy));
        e.doc.commit('移動選取範圍');
      } else {
        e.doc.touch();
      }
    } else if (dx !== 0 || dy !== 0) {
      e.doc.commit('移動圖層');
    }
    this.mode = 'none';
    this.layer = null;
    this.startBounds = null;
    this.base = this.floatSurf = this.preview = null;
    clearSnapLines(e);
    e.app.changed();
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    if (this.mode === 'layer' && this.layer) {
      this.layer.x = this.origin.x;
      this.layer.y = this.origin.y;
    }
    if (doc) { doc.livePreview = null; doc.touch(); }
    this.mode = 'none';
    this.layer = null;
    this.startBounds = null;
    this.base = this.floatSurf = this.preview = null;
    app.snapLines = null;
    app.changed();
  }
}

export class HandTool implements Tool {
  id = 'hand';
  name = '手形工具';
  shortcut = 'h';
  icon = 'hand';
  group = 'nav';
  cursor = 'grab';
  options: ToolOption[] = [];
  private start = { cx: 0, cy: 0, x: 0, y: 0 };

  down(e: ToolPointer): void {
    const v = e.app.view();
    this.start = { cx: v.centerX, cy: v.centerY, x: e.screenX, y: e.screenY };
  }

  move(e: ToolPointer): void {
    // Panning moves the viewport, so document coordinates would chase
    // themselves; the raw screen delta is the stable input here.
    const v = e.app.view();
    v.centerX = this.start.cx - (e.screenX - this.start.x) / v.zoom;
    v.centerY = this.start.cy - (e.screenY - this.start.y) / v.zoom;
    e.app.events.emit('view-changed', undefined);
  }

  up(): void { /* nothing to commit */ }
}

export class ZoomTool implements Tool {
  id = 'zoom';
  name = '縮放顯示工具';
  shortcut = 'z';
  icon = 'zoom';
  group = 'nav';
  cursor = 'zoom-in';
  options: ToolOption[] = [
    { key: 'marquee', label: '拖曳縮放', type: 'checkbox', default: true },
  ];

  private dragging = false;
  private start = { x: 0, y: 0 };
  private current = { x: 0, y: 0 };

  down(e: ToolPointer): void {
    this.dragging = true;
    this.start = { x: e.x, y: e.y };
    this.current = { x: e.x, y: e.y };
  }

  move(e: ToolPointer): void {
    if (!this.dragging) return;
    this.current = { x: e.x, y: e.y };
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.dragging) return;
    this.dragging = false;
    const r = normalizeRect(this.start, this.current);
    const marquee = e.app.toolOptions[this.id]?.marquee !== false;
    if (marquee && r.w > 4 && r.h > 4) {
      const v = e.app.view();
      v.centerX = r.x + r.w / 2;
      v.centerY = r.y + r.h / 2;
      // Fit the dragged box; the exact factor depends on the viewport, so use
      // the document-to-box ratio as a good approximation.
      v.zoom = clamp((v.zoom * e.doc.width) / Math.max(1, r.w), 0.01, 32);
      e.app.events.emit('view-changed', undefined);
    } else {
      stepZoom(e.app, e.alt ? -1 : 1, e.x, e.y);
    }
    e.app.changed();
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.dragging) return;
    const r = normalizeRect(this.start, this.current);
    if (r.w < 2 || r.h < 2) return;
    o.ctx.save();
    o.ctx.strokeStyle = '#4da3ff';
    o.ctx.lineWidth = 1 / o.zoom;
    o.ctx.strokeRect(r.x, r.y, r.w, r.h);
    o.ctx.restore();
  }

  cancel(): void { this.dragging = false; }
}

export class EyedropperTool implements Tool {
  id = 'eyedropper';
  name = '滴管工具';
  shortcut = 'i';
  icon = 'eyedropper';
  group = 'nav';
  cursor = 'crosshair';
  options: ToolOption[] = [
    {
      key: 'sample', label: '樣本', type: 'select', default: '1',
      options: [
        { value: '1', label: '點狀樣本' },
        { value: '3', label: '3 x 3 平均' },
        { value: '5', label: '5 x 5 平均' },
        { value: '11', label: '11 x 11 平均' },
      ],
    },
    { key: 'currentLayer', label: '僅目前圖層', type: 'checkbox', default: false },
  ];

  private pick(e: ToolPointer): RGB | null {
    const o = e.app.toolOptions[this.id] ?? {};
    const layer = e.doc.activeLayer();
    const useLayer = Boolean(o.currentLayer) && layer?.surface;
    const src = useLayer ? layer!.surface! : e.doc.composite();
    const ox = useLayer ? layer!.x : 0;
    const oy = useLayer ? layer!.y : 0;
    const n = Number(o.sample ?? 1);
    const half = Math.floor(n / 2);
    const cx = Math.floor(e.x) - ox, cy = Math.floor(e.y) - oy;
    const x0 = clamp(cx - half, 0, src.w - 1), y0 = clamp(cy - half, 0, src.h - 1);
    const w = clamp(n, 1, src.w - x0), h = clamp(n, 1, src.h - y0);
    if (cx < 0 || cy < 0 || cx >= src.w || cy >= src.h) return null;
    const d = src.ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; count++; }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
  }

  down(e: ToolPointer): void {
    const c = this.pick(e);
    if (!c) return;
    if (e.alt) e.app.setBackground(c); else e.app.setForeground(c);
  }

  move(e: ToolPointer): void { this.down(e); }
  up(): void { /* nothing */ }

  hover(e: ToolPointer): void {
    const c = this.pick(e);
    if (c) e.app.status(`R ${c.r}  G ${c.g}  B ${c.b}  ·  亮度 ${Math.round(luminance(c.r, c.g, c.b))}`);
  }
}

type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'inside' | null;

export class CropTool implements Tool {
  id = 'crop';
  name = '裁切工具';
  shortcut = 'c';
  icon = 'crop';
  group = 'nav';
  cursor = 'crosshair';
  options: ToolOption[] = [
    {
      key: 'ratio', label: '比例', type: 'select', default: 'free',
      options: [
        { value: 'free', label: '不受拘束' },
        { value: '1:1', label: '1:1 方形' },
        { value: '4:3', label: '4:3' },
        { value: '3:2', label: '3:2' },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16 直式' },
      ],
    },
    { key: 'guides', label: '三分構圖線', type: 'checkbox', default: true },
    { key: 'shade', label: '遮蔽裁切區外', type: 'checkbox', default: true },
  ];

  rect: Rect | null = null;
  private dragMode: CropHandle = null;
  private startRect: Rect | null = null;
  private startPt = { x: 0, y: 0 };

  private handleAt(e: ToolPointer): CropHandle {
    if (!this.rect) return null;
    const t = 8 / e.zoom;
    const { x, y, w, h } = this.rect;
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= t;
    const inX = e.x >= x - t && e.x <= x + w + t;
    const inY = e.y >= y - t && e.y <= y + h + t;
    if (near(e.x, x) && near(e.y, y)) return 'nw';
    if (near(e.x, x + w) && near(e.y, y)) return 'ne';
    if (near(e.x, x) && near(e.y, y + h)) return 'sw';
    if (near(e.x, x + w) && near(e.y, y + h)) return 'se';
    if (near(e.y, y) && inX) return 'n';
    if (near(e.y, y + h) && inX) return 's';
    if (near(e.x, x) && inY) return 'w';
    if (near(e.x, x + w) && inY) return 'e';
    if (e.x > x && e.x < x + w && e.y > y && e.y < y + h) return 'inside';
    return null;
  }

  private ratio(app: App): number | null {
    const r = String(app.toolOptions[this.id]?.ratio ?? 'free');
    if (r === 'free') return null;
    const [a, b] = r.split(':').map(Number);
    return a / b;
  }

  down(e: ToolPointer): void {
    this.dragMode = this.handleAt(e);
    this.startPt = { x: e.x, y: e.y };
    if (!this.dragMode) {
      this.rect = { x: e.x, y: e.y, w: 0, h: 0 };
      this.dragMode = 'se';
    }
    this.startRect = this.rect ? { ...this.rect } : null;
  }

  move(e: ToolPointer): void {
    if (!this.dragMode || !this.startRect) return;
    const snapCtx = snapContextFor(e, null);
    const dx = e.x - this.startPt.x, dy = e.y - this.startPt.y;
    const s = this.startRect;
    let r: Rect;
    if (this.dragMode === 'inside') {
      r = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h };
    } else {
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (this.dragMode.includes('w')) x0 += dx;
      if (this.dragMode.includes('e')) x1 += dx;
      if (this.dragMode.includes('n')) y0 += dy;
      if (this.dragMode.includes('s')) y1 += dy;
      r = normalizeRect({ x: x0, y: y0 }, { x: x1, y: y1 });
      const ratio = this.ratio(e.app);
      if (ratio) {
        if (r.w / Math.max(1e-6, r.h) > ratio) r.h = r.w / ratio;
        else r.w = r.h * ratio;
        if (this.dragMode.includes('w')) r.x = x1 - r.w;
        if (this.dragMode.includes('n')) r.y = y1 - r.h;
      }
    }
    const snapped = snapRect(r, snapCtx);
    if (this.dragMode === 'inside') {
      r = { ...r, x: r.x + snapped.dx, y: r.y + snapped.dy };
    } else {
      // Only the edges being dragged move onto the snap lines.
      if (this.dragMode.includes('w')) r = { ...r, x: r.x + snapped.dx, w: r.w - snapped.dx };
      else if (this.dragMode.includes('e')) r = { ...r, w: r.w + snapped.dx };
      if (this.dragMode.includes('n')) r = { ...r, y: r.y + snapped.dy, h: r.h - snapped.dy };
      else if (this.dragMode.includes('s')) r = { ...r, h: r.h + snapped.dy };
    }
    showSnapLines(e, snapped.lines);
    this.rect = r;
    e.app.changed();
  }

  up(e: ToolPointer): void {
    clearSnapLines(e);
    this.dragMode = null;
    if (this.rect && (this.rect.w < 2 || this.rect.h < 2)) this.rect = null;
    e.app.changed();
  }

  key(ev: KeyboardEvent, app: App): boolean {
    if (ev.key === 'Enter' && this.rect) { this.apply(app); return true; }
    if (ev.key === 'Escape' && this.rect) { this.rect = null; app.changed(); return true; }
    return false;
  }

  apply(app: App): void {
    const doc = app.activeDoc();
    if (!doc || !this.rect) return;
    const x = Math.round(clamp(this.rect.x, 0, doc.width));
    const y = Math.round(clamp(this.rect.y, 0, doc.height));
    const w = Math.round(clamp(this.rect.w, 1, doc.width - x));
    const h = Math.round(clamp(this.rect.h, 1, doc.height - y));
    doc.resizeCanvas(w, h, -x, -y);
    doc.commit('裁切');
    this.rect = null;
    const v = app.view();
    v.centerX = w / 2;
    v.centerY = h / 2;
    app.events.emit('view-changed', undefined);
    app.changed();
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.rect) return;
    const { ctx, zoom, doc } = o;
    const r = this.rect;
    if (o.app.toolOptions[this.id]?.shade !== false) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, doc.width, doc.height);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fill('evenodd');
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (o.app.toolOptions[this.id]?.guides !== false) {
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(r.x + (r.w * i) / 3, r.y);
        ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
        ctx.moveTo(r.x, r.y + (r.h * i) / 3);
        ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const hs = 7 / zoom;
    ctx.fillStyle = '#fff';
    const pts: [number, number][] = [
      [r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y],
      [r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2],
      [r.x, r.y + r.h], [r.x + r.w / 2, r.y + r.h], [r.x + r.w, r.y + r.h],
    ];
    for (const [px, py] of pts) ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
    ctx.restore();
  }

  cancel(app: App): void { this.rect = null; app.changed(); }
}
