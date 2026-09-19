import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import { clamp } from '../core/geometry';
import { getTool, transformTool } from '../tools';
import { drawPathOverlay } from '../tools/pen';
import {
  collectSnapTargets, createGuide, guideAt, snapScalar, type Guide,
} from '../core/guides';
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
  /** Guide being created from a ruler or dragged with the Move tool. */
  private guideDrag: { guide: Guide; isNew: boolean } | null = null;
  private hoverGuide: Guide | null = null;

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

      // Dragging out of a ruler creates a guide; the Move tool grabs
      // existing ones, the way Photoshop does.
      if (ev.button === 0 && !this.spacePanning && this.startGuideDrag(screenX, screenY, p)) {
        ev.preventDefault();
        return;
      }

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

      if (this.guideDrag) {
        this.updateGuideDrag(this.screenToDoc(screenX, screenY));
        this.invalidate();
        return;
      }

      if (this.panState) {
        const v = this.app.view();
        v.centerX = this.panState.cx - (screenX - this.panState.x) / v.zoom;
        v.centerY = this.panState.cy - (screenY - this.panState.y) / v.zoom;
        this.app.events.emit('view-changed', undefined);
        return;
      }

      const p = this.screenToDoc(screenX, screenY);
      this.cursorDoc = p;
      this.hoverGuide = this.app.toolId === 'move' && !doc.guidesLocked
        ? guideAt(doc.guides, p.x, p.y, 5 / this.app.view().zoom)
        : null;
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
      if (this.guideDrag) {
        this.finishGuideDrag();
        this.invalidate();
        return;
      }
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

  /** Begin creating or moving a guide; returns true when it took over. */
  private startGuideDrag(
    screenX: number, screenY: number, p: { x: number; y: number },
  ): boolean {
    const doc = this.app.activeDoc();
    if (!doc || doc.guidesLocked) return false;
    const rs = this.rulerSize();

    if (rs > 0 && (screenX < rs || screenY < rs)) {
      // Vertical guides come out of the left ruler, horizontal out of the top.
      const axis = screenX < rs && screenY >= rs ? 'v' : screenY < rs ? 'h' : null;
      if (!axis) return false;
      const guide = createGuide(axis, axis === 'v' ? p.x : p.y);
      doc.guides.push(guide);
      this.guideDrag = { guide, isNew: true };
      doc.touch();
      return true;
    }

    if (this.app.toolId !== 'move') return false;
    const hit = guideAt(doc.guides, p.x, p.y, 5 / this.app.view().zoom);
    if (!hit) return false;
    this.guideDrag = { guide: hit, isNew: false };
    return true;
  }

  private updateGuideDrag(p: { x: number; y: number }): void {
    const doc = this.app.activeDoc();
    if (!doc || !this.guideDrag) return;
    const { guide } = this.guideDrag;
    const axis = guide.axis === 'v' ? 'x' : 'y';
    let value = axis === 'x' ? p.x : p.y;
    const ctx = collectSnapTargets(
      { width: doc.width, height: doc.height, guides: doc.guides.filter((g) => g.id !== guide.id), layers: doc.layers },
      this.app.snap, 8 / this.app.view().zoom, this.app.gridSize,
    );
    const snapped = snapScalar(value, axis, ctx);
    if (snapped.line !== null) value += snapped.delta;
    guide.pos = Math.round(value * 100) / 100;
    this.app.snapLines = snapped.line === null
      ? null
      : { x: axis === 'x' ? [snapped.line] : [], y: axis === 'y' ? [snapped.line] : [] };
    doc.touch();
    this.app.status(`${guide.axis === 'v' ? 'X' : 'Y'} ${Math.round(guide.pos)} px`);
  }

  private finishGuideDrag(): void {
    const doc = this.app.activeDoc();
    const drag = this.guideDrag;
    this.guideDrag = null;
    this.app.snapLines = null;
    if (!doc || !drag) return;
    const limit = drag.guide.axis === 'v' ? doc.width : doc.height;
    // Dragging a guide off the canvas removes it, as in Photoshop.
    if (drag.guide.pos < 0 || drag.guide.pos > limit) {
      doc.guides = doc.guides.filter((g) => g.id !== drag.guide.id);
      doc.commit(drag.isNew ? '取消參考線' : '刪除參考線');
    } else {
      doc.commit(drag.isNew ? '新增參考線' : '移動參考線');
    }
    this.app.changed();
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
    if (v.showGuides) this.drawGuides(ctx, doc, o.x, o.y, z);
    this.drawSnapLines(ctx, doc, o.x, o.y, z);

    // Canvas border.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(o.x - 0.5, o.y - 0.5, doc.width * z + 1, doc.height * z + 1);

    // Tool overlays and the selection border live in document space.
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(z, z);
    const tool = this.tool();
    // The active path stays visible under every tool, as in Photoshop.
    const path = doc.activePath();
    if (path && tool.group !== 'vector') drawPathOverlay(ctx, path, z, { anchors: false });
    tool.drawOverlay?.({ ctx, zoom: z, doc, app: this.app, cursor: this.cursorDoc });
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

  private drawGuides(
    ctx: CanvasRenderingContext2D, doc: PhotoDoc, ox: number, oy: number, z: number,
  ): void {
    if (!doc.guides.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (const g of doc.guides) {
      const active = this.guideDrag?.guide.id === g.id || this.hoverGuide?.id === g.id;
      ctx.strokeStyle = doc.guidesLocked
        ? 'rgba(150,150,150,0.75)'
        : active ? '#ff4d9d' : 'rgba(0,229,255,0.85)';
      ctx.beginPath();
      if (g.axis === 'v') {
        const x = Math.round(ox + g.pos * z) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.height);
      } else {
        const y = Math.round(oy + g.pos * z) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.width, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Magenta lines showing what the current drag snapped to. */
  private drawSnapLines(
    ctx: CanvasRenderingContext2D, doc: PhotoDoc, ox: number, oy: number, z: number,
  ): void {
    const lines = this.app.snapLines;
    if (!lines) return;
    ctx.save();
    ctx.strokeStyle = '#ff4d9d';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    for (const x of lines.x) {
      const sx = Math.round(ox + x * z) + 0.5;
      ctx.moveTo(sx, oy - 16);
      ctx.lineTo(sx, oy + doc.height * z + 16);
    }
    for (const y of lines.y) {
      const sy = Math.round(oy + y * z) + 0.5;
      ctx.moveTo(ox - 16, sy);
      ctx.lineTo(ox + doc.width * z + 16, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D, doc: PhotoDoc, ox: number, oy: number, z: number,
  ): void {
    const step = Math.max(2, this.app.gridSize);
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
    if (this.guideDrag || this.hoverGuide) {
      const axis = (this.guideDrag?.guide ?? this.hoverGuide)!.axis;
      this.canvas.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
      return;
    }
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
