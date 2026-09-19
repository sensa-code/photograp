import type { App } from '../core/app';
import type { Point } from '../core/geometry';
import { clamp } from '../core/geometry';
import { createSurface } from '../core/surface';
import { createRasterLayer } from '../core/layer';
import { quadIsUsable, suggestedSize, warpQuad } from '../core/perspective';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

/**
 * Perspective Crop: drag a quadrilateral over something photographed at an
 * angle and it comes back as a straight rectangle. Unlike the plain crop
 * this flattens the document, because the warp applies to the merged image.
 */
export class PerspectiveCropTool implements Tool {
  id = 'perspective-crop';
  name = '透視裁切工具';
  shortcut = '';
  icon = 'crop';
  group = 'nav';
  cursor = 'crosshair';
  options: ToolOption[] = [
    { key: 'grid', label: '顯示格線', type: 'checkbox', default: true },
    { key: 'shade', label: '遮蔽框外', type: 'checkbox', default: true },
  ];

  /** Four corners, clockwise from the top left; null until the first drag. */
  quad: Point[] | null = null;
  private dragging = -1;
  private start: Point | null = null;

  private cornerAt(e: ToolPointer): number {
    if (!this.quad) return -1;
    const t = 10 / e.zoom;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(this.quad[i].x - e.x, this.quad[i].y - e.y) <= t) return i;
    }
    return -1;
  }

  down(e: ToolPointer): void {
    const hit = this.cornerAt(e);
    if (hit >= 0) { this.dragging = hit; return; }
    // Starting a fresh drag replaces whatever box was there.
    this.quad = null;
    this.start = { x: e.x, y: e.y };
    this.dragging = -1;
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (this.dragging >= 0 && this.quad) {
      this.quad[this.dragging] = { x: e.x, y: e.y };
      e.app.changed();
      return;
    }
    if (!this.start) return;
    const a = this.start, b = { x: e.x, y: e.y };
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    this.quad = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    e.app.changed();
  }

  up(e: ToolPointer): void {
    this.dragging = -1;
    this.start = null;
    if (this.quad && !quadIsUsable(this.quad)) this.quad = null;
    e.app.changed();
  }

  key(ev: KeyboardEvent, app: App): boolean {
    if (ev.key === 'Enter') { this.apply(app); return true; }
    if (ev.key === 'Escape') { this.cancel(app); return true; }
    return false;
  }

  apply(app: App): void {
    const doc = app.activeDoc();
    if (!doc || !this.quad) return;
    if (!quadIsUsable(this.quad)) {
      app.toast('四個角必須圍出一個沒有交叉的四邊形', 'error');
      return;
    }
    const { w, h } = suggestedSize(this.quad);
    const width = clamp(w, 1, 8000);
    const height = clamp(h, 1, 8000);

    // The warp is a whole-image operation, so the result is one flat layer.
    const merged = doc.render();
    const out = warpQuad(merged, this.quad, width, height);
    if (!out) { app.toast('無法計算這個四邊形的透視', 'error'); return; }

    const flat = createSurface(width, height);
    flat.ctx.drawImage(out.canvas, 0, 0);
    doc.layers = [createRasterLayer(doc.layers[0]?.name ?? '背景', width, height, flat)];
    doc.activeLayerId = doc.layers[0].id;
    doc.meta.width = width;
    doc.meta.height = height;
    doc.selection.resize(width, height);
    doc.guides = [];
    doc.quickMask = null;
    doc.commit('透視裁切');

    this.quad = null;
    const v = app.view();
    v.centerX = width / 2;
    v.centerY = height / 2;
    app.events.emit('view-changed', undefined);
    app.status(`透視裁切：${width} × ${height} px`);
    app.changed();
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.quad) return;
    const { ctx, zoom, doc } = o;
    const q = this.quad;

    if (o.app.toolOptions[this.id]?.shade !== false) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, doc.width, doc.height);
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (o.app.toolOptions[this.id]?.grid !== false) {
      // Lines joining matching points on opposite edges, so the grid follows
      // the perspective and shows how much the corners are skewing it.
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      const lerp = (a: Point, b: Point, t: number): Point =>
        ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        ctx.beginPath();
        const top = lerp(q[0], q[1], t), bottom = lerp(q[3], q[2], t);
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bottom.x, bottom.y);
        const left = lerp(q[0], q[3], t), right = lerp(q[1], q[2], t);
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
      }
    }

    const r = 4 / zoom;
    for (const p of q) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#1b4a6e';
      ctx.stroke();
    }
    ctx.restore();
  }

  cancel(app: App): void {
    this.quad = null;
    this.dragging = -1;
    this.start = null;
    app.changed();
  }
}
