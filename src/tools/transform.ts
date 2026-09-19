import type { App } from '../core/app';
import type { Layer } from '../core/types';
import { createSurface, opaqueBounds, type Surface } from '../core/surface';
import { clamp, type Rect } from '../core/geometry';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'move' | null;

interface TransformState {
  layer: Layer;
  source: Surface;
  src: Rect;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  angle: number;
  preview: Surface;
}

/** Free Transform: scale, rotate and flip the active layer interactively. */
export class TransformTool implements Tool {
  id = 'transform';
  name = '任意變形';
  shortcut = '';
  icon = 'transform';
  group = 'nav';
  cursor = 'default';
  options: ToolOption[] = [
    { key: 'constrain', label: '等比例縮放', type: 'checkbox', default: true },
    { key: 'smooth', label: '平滑內插', type: 'checkbox', default: true },
  ];

  state: TransformState | null = null;
  private drag: {
    handle: Handle; x: number; y: number;
    cx: number; cy: number; sx: number; sy: number; angle: number;
  } | null = null;

  /** Begin a transform on the document's active layer. */
  start(app: App): boolean {
    const doc = app.activeDoc();
    const layer = doc?.activeLayer();
    if (!doc || !layer || !layer.surface || layer.locked) {
      app.toast('請先選擇一個可變形的點陣圖層', 'error');
      return false;
    }
    const bounds = opaqueBounds(layer.surface) ?? { x: 0, y: 0, w: layer.surface.w, h: layer.surface.h };
    this.state = {
      layer,
      source: layer.surface,
      src: bounds,
      cx: layer.x + bounds.x + bounds.w / 2,
      cy: layer.y + bounds.y + bounds.h / 2,
      sx: 1, sy: 1, angle: 0,
      preview: createSurface(layer.surface.w, layer.surface.h),
    };
    this.render(app);
    doc.livePreview = { layerId: layer.id, surface: this.state.preview, isMask: false };
    app.events.emit('options-changed', undefined);
    app.changed();
    return true;
  }

  private render(app: App): void {
    const s = this.state;
    if (!s) return;
    const smooth = app.toolOptions[this.id]?.smooth !== false;
    const ctx = s.preview.ctx;
    ctx.clearRect(0, 0, s.preview.w, s.preview.h);
    ctx.save();
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    // Preview lives in layer space, so undo the layer offset first.
    ctx.translate(s.cx - s.layer.x, s.cy - s.layer.y);
    ctx.rotate(s.angle);
    ctx.scale(s.sx, s.sy);
    ctx.drawImage(
      s.source.canvas, s.src.x, s.src.y, s.src.w, s.src.h,
      -s.src.w / 2, -s.src.h / 2, s.src.w, s.src.h,
    );
    ctx.restore();
  }

  /** Corner and edge handle positions in document space. */
  corners(): { x: number; y: number }[] {
    const s = this.state;
    if (!s) return [];
    const hw = (s.src.w * s.sx) / 2, hh = (s.src.h * s.sy) / 2;
    const pts: [number, number][] = [
      [-hw, -hh], [0, -hh], [hw, -hh],
      [hw, 0], [hw, hh], [0, hh],
      [-hw, hh], [-hw, 0],
    ];
    const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
    return pts.map(([x, y]) => ({ x: s.cx + x * cos - y * sin, y: s.cy + x * sin + y * cos }));
  }

  private handleAt(e: ToolPointer): Handle {
    const s = this.state;
    if (!s) return null;
    const names: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const pts = this.corners();
    const t = 9 / e.zoom;
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(e.x - pts[i].x, e.y - pts[i].y) <= t) return names[i];
    }
    // Just outside a corner rotates.
    for (const p of [pts[0], pts[2], pts[4], pts[6]]) {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d > t && d <= t * 3) return 'rotate';
    }
    // Inside the box moves it.
    const cos = Math.cos(-s.angle), sin = Math.sin(-s.angle);
    const dx = e.x - s.cx, dy = e.y - s.cy;
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    if (Math.abs(lx) <= (s.src.w * Math.abs(s.sx)) / 2 && Math.abs(ly) <= (s.src.h * Math.abs(s.sy)) / 2) {
      return 'move';
    }
    return null;
  }

  down(e: ToolPointer): void {
    if (!this.state) { this.start(e.app); return; }
    const handle = this.handleAt(e);
    if (!handle) return;
    const s = this.state;
    this.drag = { handle, x: e.x, y: e.y, cx: s.cx, cy: s.cy, sx: s.sx, sy: s.sy, angle: s.angle };
  }

  move(e: ToolPointer): void {
    const s = this.state, d = this.drag;
    if (!s || !d) return;
    const dx = e.x - d.x, dy = e.y - d.y;

    if (d.handle === 'move') {
      s.cx = d.cx + dx;
      s.cy = d.cy + dy;
    } else if (d.handle === 'rotate') {
      const a0 = Math.atan2(d.y - d.cy, d.x - d.cx);
      const a1 = Math.atan2(e.y - d.cy, e.x - d.cx);
      let ang = d.angle + (a1 - a0);
      if (e.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      s.angle = ang;
    } else if (d.handle) {
      // Work in the box's own frame so scaling follows the rotation.
      const cos = Math.cos(-d.angle), sin = Math.sin(-d.angle);
      const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      let sx = d.sx, sy = d.sy;
      if (d.handle.includes('e')) sx = d.sx + (lx * 2) / s.src.w;
      if (d.handle.includes('w')) sx = d.sx - (lx * 2) / s.src.w;
      if (d.handle.includes('s')) sy = d.sy + (ly * 2) / s.src.h;
      if (d.handle.includes('n')) sy = d.sy - (ly * 2) / s.src.h;
      // Corner handles keep the aspect ratio; Shift releases the constraint.
      const constrain = e.app.toolOptions[this.id]?.constrain !== false;
      if (constrain && d.handle.length === 2 && !e.shift) {
        const f = Math.abs(sx / (d.sx || 1));
        sy = d.sy * f * Math.sign(sy || 1);
      }
      sx = Math.abs(sx) < 0.01 ? 0.01 * Math.sign(sx || 1) : sx;
      sy = Math.abs(sy) < 0.01 ? 0.01 * Math.sign(sy || 1) : sy;

      // Keep the opposite edge or corner pinned, unless Alt scales from centre.
      if (!e.alt) {
        const fx = d.handle.includes('e') ? -1 : d.handle.includes('w') ? 1 : 0;
        const fy = d.handle.includes('s') ? -1 : d.handle.includes('n') ? 1 : 0;
        const bx = (fx * s.src.w * d.sx) / 2 - (fx * s.src.w * sx) / 2;
        const by = (fy * s.src.h * d.sy) / 2 - (fy * s.src.h * sy) / 2;
        const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
        s.cx = d.cx + bx * ca - by * sa;
        s.cy = d.cy + bx * sa + by * ca;
      } else {
        s.cx = d.cx;
        s.cy = d.cy;
      }
      s.sx = sx;
      s.sy = sy;
    }
    this.render(e.app);
    e.app.changed();
  }

  up(): void { this.drag = null; }

  flip(app: App, axis: 'h' | 'v'): void {
    if (!this.state) return;
    if (axis === 'h') this.state.sx *= -1; else this.state.sy *= -1;
    this.render(app);
    app.changed();
  }

  rotateBy(app: App, deg: number): void {
    if (!this.state) return;
    this.state.angle += (deg * Math.PI) / 180;
    this.render(app);
    app.changed();
  }

  setScale(app: App, sx: number, sy: number): void {
    if (!this.state) return;
    this.state.sx = clamp(sx, -20, 20);
    this.state.sy = clamp(sy, -20, 20);
    this.render(app);
    app.changed();
  }

  apply(app: App): void {
    const doc = app.activeDoc();
    const s = this.state;
    if (!doc || !s) return;
    doc.livePreview = null;
    const target = doc.mutableSurface(s.layer);
    target.ctx.clearRect(0, 0, target.w, target.h);
    target.ctx.drawImage(s.preview.canvas, 0, 0);
    this.state = null;
    this.drag = null;
    doc.commit('任意變形');
    app.events.emit('options-changed', undefined);
    app.changed();
  }

  key(ev: KeyboardEvent, app: App): boolean {
    if (!this.state) return false;
    if (ev.key === 'Enter') { this.apply(app); return true; }
    if (ev.key === 'Escape') { this.cancel(app); return true; }
    return false;
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.state) return;
    const { ctx, zoom } = o;
    const pts = this.corners();
    ctx.save();
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of [pts[2], pts[4], pts[6]]) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.stroke();
    const hs = 8 / zoom;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2b6cb0';
    for (const p of pts) {
      ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
    }
    ctx.restore();
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    if (doc) { doc.livePreview = null; doc.touch(); }
    this.state = null;
    this.drag = null;
    app.events.emit('options-changed', undefined);
    app.changed();
  }
}
