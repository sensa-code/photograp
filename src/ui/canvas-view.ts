import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import { clamp } from '../core/geometry';
import { getTool, transformTool } from '../tools';
import type { Tool, ToolPointer } from '../tools/types';
import { zoomAt } from '../tools/nav';
import { el, on } from './dom';

const RULER = 18;

export class CanvasView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private antsOffset = 0;
  private cursorDoc: { x: number; y: number } | null = null;
  private dragging = false;
  private dragStart = { x: 0, y: 0, sx: 0, sy: 0 };
  private lastDoc = { x: 0, y: 0 };
  private spacePanning = false;
  private panState: { cx: number; cy: number; x: number; y: number } | null = null;
  private activeToolOverride: Tool | null = null;
  private needsDraw = true;

  constructor(private app: App) {
    this.canvas = el('canvas') as HTMLCanvasElement;
    this.root = el('div', { class: 'viewport' }, this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.root);

    this.bindPointer();
    this.bindWheel();

    app.events.on('doc-changed', () => this.invalidate());
    app.events.on('view-changed', () => this.invalidate());
    app.events.on('docs-changed', () => this.invalidate());
    app.events.on('tool-changed', () => this.invalidate());

    const loop = (): void => {
      const doc = this.app.activeDoc();
      if (doc?.selection.active) {
        this.antsOffset = (this.antsOffset + 0.35) % 8;
        this.needsDraw = true;
      }
      if (this.needsDraw) { this.needsDraw = false; this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    queueMicrotask(() => this.resize());
  }

  invalidate(): void { this.needsDraw = true; }

  private resize(): void {
    const r = this.root.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.floor(r.width));
    this.height = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.invalidate();
  }

  private rulerSize(): number {
    return this.app.view().showRulers ? RULER : 0;
  }

  private origin(): { x: number; y: number; zoom: number } {
    const v = this.app.view();
    const rs = this.rulerSize();
    return {
      x: rs + (this.width - rs) / 2 - v.centerX * v.zoom,
      y: rs + (this.height - rs) / 2 - v.centerY * v.zoom,
      zoom: v.zoom,
    };
  }

  screenToDoc(sx: number, sy: number): { x: number; y: number } {
    const o = this.origin();
    return { x: (sx - o.x) / o.zoom, y: (sy - o.y) / o.zoom };
  }

  docToScreen(x: number, y: number): { x: number; y: number } {
    const o = this.origin();
    return { x: o.x + x * o.zoom, y: o.y + y * o.zoom };
  }

  fitToWindow(): void {
    const doc = this.app.activeDoc();
    if (!doc) return;
    // Measure directly: a fit can be requested before the first resize lands.
    if (this.width <= 1 || this.height <= 1) this.resize();
    const rs = this.rulerSize();
    const pad = 40;
    const z = Math.min(
      (this.width - rs - pad) / doc.width,
      (this.height - rs - pad) / doc.height,
    );
    const v = this.app.view();
    v.zoom = clamp(z, 0.01, 32);
    v.centerX = doc.width / 2;
    v.centerY = doc.height / 2;
    v.fitted = true;
    this.app.events.emit('view-changed', undefined);
  }

  zoomTo(z: number): void {
    const doc = this.app.activeDoc();
    if (!doc) return;
    const v = this.app.view();
    zoomAt(this.app, v.centerX, v.centerY, z);
  }

  // ---- input ---------------------------------------------------------

  private tool(): Tool {
    if (this.activeToolOverride) return this.activeToolOverride;
    if (transformTool.state) return transformTool;
    return getTool(this.app.toolId);
  }

  private makePointer(ev: PointerEvent, doc: PhotoDoc): ToolPointer {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = ev.clientX - rect.left;
    const screenY = ev.clientY - rect.top;
    const p = this.screenToDoc(screenX, screenY);
    const coalesced = typeof ev.getCoalescedEvents === 'function'
      ? ev.getCoalescedEvents().map((c) => {
        const q = this.screenToDoc(c.clientX - rect.left, c.clientY - rect.top);
        return { x: q.x, y: q.y, pressure: c.pressure > 0 ? c.pressure : 1 };
      })
      : undefined;
    return {
      app: this.app,
      doc,
      x: p.x,
      y: p.y,
      px: this.lastDoc.x,
      py: this.lastDoc.y,
      sx: this.dragStart.x,
      sy: this.dragStart.y,
      screenX,
      screenY,
      screenSX: this.dragStart.sx,
      screenSY: this.dragStart.sy,
      pressure: ev.pointerType === 'pen' ? Math.max(0.02, ev.pressure) : 1,
      shift: ev.shiftKey,
      alt: ev.altKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      button: ev.button,
      zoom: this.app.view().zoom,
      coalesced,
    };
  }

  private bindPointer(): void {
    on(this.canvas, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      const doc = this.app.activeDoc();
      if (!doc) return;
      this.canvas.setPointerCapture(ev.pointerId);
      const rect = this.canvas.getBoundingClientRect();
      const screenX = ev.clientX - rect.left;
      const screenY = ev.clientY - rect.top;
      const p = this.screenToDoc(screenX, screenY);
      this.dragStart = { x: p.x, y: p.y, sx: screenX, sy: screenY };
      this.lastDoc = { x: p.x, y: p.y };

      // Middle button or Space always pans.
      if (ev.button === 1 || this.spacePanning) {
        const v = this.app.view();
        this.panState = { cx: v.centerX, cy: v.centerY, x: screenX, y: screenY };
        ev.preventDefault();
        return;
      }
      if (ev.button === 2) return;

      this.dragging = true;
      this.tool().down(this.makePointer(ev, doc));
      this.invalidate();
    });

    on(this.canvas, 'pointermove', (e) => {
      const ev = e as PointerEvent;
      const doc = this.app.activeDoc();
      if (!doc) return;
      const rect = this.canvas.getBoundingClientRect();
      const screenX = ev.clientX - rect.left;
      const screenY = ev.clientY - rect.top;

      if (this.panState) {
        const v = this.app.view();
        v.centerX = this.panState.cx - (screenX - this.panState.x) / v.zoom;
        v.centerY = this.panState.cy - (screenY - this.panState.y) / v.zoom;
        this.app.events.emit('view-changed', undefined);
        return;
      }

      const p = this.screenToDoc(screenX, screenY);
      this.cursorDoc = p;
      const pointer = this.makePointer(ev, doc);
      if (this.dragging) this.tool().move(pointer);
      else this.tool().hover?.(pointer);
      this.lastDoc = { x: p.x, y: p.y };
      this.invalidate();
      this.app.status(this.positionText(p, doc));
    });

    const end = (e: Event): void => {
      const ev = e as PointerEvent;
      const doc = this.app.activeDoc();
      this.panState = null;
      if (this.dragging && doc) {
        this.dragging = false;
        this.tool().up(this.makePointer(ev, doc));
      }
      this.dragging = false;
      this.invalidate();
    };
    on(this.canvas, 'pointerup', end);
    on(this.canvas, 'pointercancel', end);

    on(this.canvas, 'pointerleave', () => { this.cursorDoc = null; this.invalidate(); });
    on(this.canvas, 'dblclick', (e) => {
      const ev = e as MouseEvent;
      const doc = this.app.activeDoc();
      if (!doc) return;
      const rect = this.canvas.getBoundingClientRect();
      const p = this.screenToDoc(ev.clientX - rect.left, ev.clientY - rect.top);
      this.tool().doubleClick?.({
        app: this.app, doc, x: p.x, y: p.y, px: p.x, py: p.y, sx: p.x, sy: p.y,
        screenX: 0, screenY: 0, screenSX: 0, screenSY: 0,
        pressure: 1, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey,
        button: 0, zoom: this.app.view().zoom,
      });
      this.invalidate();
    });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
  }

  private positionText(p: { x: number; y: number }, doc: PhotoDoc): string {
    const inside = p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
    if (!inside) return '';
    return `X ${Math.floor(p.x)}  Y ${Math.floor(p.y)}`;
  }

  private bindWheel(): void {
    on(this.canvas, 'wheel', (e) => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      const doc = this.app.activeDoc();
      if (!doc) return;
      const v = this.app.view();
      const rect = this.canvas.getBoundingClientRect();
      const p = this.screenToDoc(ev.clientX - rect.left, ev.clientY - rect.top);
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        const factor = Math.exp(-ev.deltaY * 0.0022);
        zoomAt(this.app, p.x, p.y, v.zoom * factor);
      } else if (ev.shiftKey) {
        v.centerX += ev.deltaY / v.zoom;
        this.app.events.emit('view-changed', undefined);
      } else {
        v.centerX += ev.deltaX / v.zoom;
        v.centerY += ev.deltaY / v.zoom;
        this.app.events.emit('view-changed', undefined);
      }
    }, { passive: false });
  }

  setSpacePanning(active: boolean): void {
    this.spacePanning = active;
    this.canvas.style.cursor = active ? 'grab' : '';
  }

  setToolOverride(tool: Tool | null): void { this.activeToolOverride = tool; }

  // ---- painting ------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, this.width, this.height);

    const doc = this.app.activeDoc();
    this.root.classList.toggle('no-doc', !doc);
    if (!doc) return;

    // A freshly opened document sizes itself to the viewport on first paint.
    const view = this.app.view();
    if (!view.fitted && this.width > 1) {
      this.fitToWindow();
      this.needsDraw = true;
    }

    const o = this.origin();
    const z = o.zoom;
    const v = this.app.view();

    // Document backdrop: checkerboard plus a drop shadow.
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, doc.width * z, doc.height * z);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, doc.width * z, doc.height * z);
    ctx.clip();
    this.drawCheckerboard(ctx, o.x, o.y, doc.width * z, doc.height * z);

    const composite = doc.composite();
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(composite.canvas, o.x, o.y, doc.width * z, doc.height * z);
    ctx.restore();

    // Pixel grid at very high zoom.
    if (z >= 12) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= doc.width; x++) {
        const sx = Math.round(o.x + x * z) + 0.5;
        ctx.moveTo(sx, o.y); ctx.lineTo(sx, o.y + doc.height * z);
      }
      for (let y = 0; y <= doc.height; y++) {
        const sy = Math.round(o.y + y * z) + 0.5;
        ctx.moveTo(o.x, sy); ctx.lineTo(o.x + doc.width * z, sy);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (v.showGrid) this.drawGrid(ctx, doc, o.x, o.y, z);

    // Canvas border.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(o.x - 0.5, o.y - 0.5, doc.width * z + 1, doc.height * z + 1);

    // Tool overlays and the selection border live in document space.
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(z, z);
    this.tool().drawOverlay?.({ ctx, zoom: z, doc, app: this.app, cursor: this.cursorDoc });
    this.drawAnts(ctx, doc, z);
    ctx.restore();

    this.drawBrushCursor(ctx, z);
    if (v.showRulers) this.drawRulers(ctx, doc, o.x, o.y, z);
  }

  private drawCheckerboard(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  ): void {
    const s = 10;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#cccccc';
    const cols = Math.ceil(w / s), rows = Math.ceil(h / s);
    for (let r = 0; r < rows; r++) {
      for (let c = (r % 2); c < cols; c += 2) {
        ctx.fillRect(x + c * s, y + r * s, s, s);
      }
    }
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D, doc: PhotoDoc, ox: number, oy: number, z: number,
  ): void {
    const step = 50;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, doc.width * z, doc.height * z);
    ctx.clip();
    ctx.strokeStyle = 'rgba(120,180,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= doc.width; x += step) {
      const sx = Math.round(ox + x * z) + 0.5;
      ctx.moveTo(sx, oy); ctx.lineTo(sx, oy + doc.height * z);
    }
    for (let y = 0; y <= doc.height; y += step) {
      const sy = Math.round(oy + y * z) + 0.5;
      ctx.moveTo(ox, sy); ctx.lineTo(ox + doc.width * z, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawAnts(ctx: CanvasRenderingContext2D, doc: PhotoDoc, z: number): void {
    const path = doc.selection.outline();
    if (!path) return;
    ctx.save();
    ctx.lineWidth = 1 / z;
    ctx.setLineDash([4 / z, 4 / z]);
    ctx.lineDashOffset = -this.antsOffset / z;
    ctx.strokeStyle = '#000';
    ctx.stroke(path);
    ctx.lineDashOffset = (-this.antsOffset + 4) / z;
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.restore();
  }

  private drawBrushCursor(ctx: CanvasRenderingContext2D, z: number): void {
    const tool = this.tool();
    if (!tool.showBrushCursor || !this.cursorDoc) {
      this.canvas.style.cursor = this.spacePanning ? 'grab' : (tool.cursor ?? 'default');
      return;
    }
    this.canvas.style.cursor = 'none';
    const size = Number(this.app.toolOptions[tool.id]?.size ?? 30);
    const s = this.docToScreen(this.cursorDoc.x, this.cursorDoc.y);
    const r = Math.max(1.5, (size * z) / 2);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (r > 14) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y + 4);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRulers(
    ctx: CanvasRenderingContext2D, doc: PhotoDoc, ox: number, oy: number, z: number,
  ): void {
    ctx.save();
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, this.width, RULER);
    ctx.fillRect(0, 0, RULER, this.height);
    ctx.strokeStyle = '#4a4a4a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER + 0.5); ctx.lineTo(this.width, RULER + 0.5);
    ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, this.height);
    ctx.stroke();

    const candidates = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
    const step = candidates.find((c) => c * z >= 56) ?? 10000;
    ctx.fillStyle = '#9a9a9a';
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.strokeStyle = '#6a6a6a';

    ctx.beginPath();
    for (let x = 0; x <= doc.width; x += step) {
      const sx = Math.round(ox + x * z) + 0.5;
      if (sx < RULER || sx > this.width) continue;
      ctx.moveTo(sx, RULER - 6); ctx.lineTo(sx, RULER);
      ctx.fillText(String(x), sx + 2, 9);
    }
    for (let y = 0; y <= doc.height; y += step) {
      const sy = Math.round(oy + y * z) + 0.5;
      if (sy < RULER || sy > this.height) continue;
      ctx.moveTo(RULER - 6, sy); ctx.lineTo(RULER, sy);
      ctx.save();
      ctx.translate(9, sy - 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(y), 0, 0);
      ctx.restore();
    }
    ctx.stroke();

    // Cursor tick marks.
    if (this.cursorDoc) {
      const s = this.docToScreen(this.cursorDoc.x, this.cursorDoc.y);
      ctx.strokeStyle = '#ff5f5f';
      ctx.beginPath();
      ctx.moveTo(s.x + 0.5, 0); ctx.lineTo(s.x + 0.5, RULER);
      ctx.moveTo(0, s.y + 0.5); ctx.lineTo(RULER, s.y + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }
}
