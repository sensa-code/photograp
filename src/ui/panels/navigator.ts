import type { App } from '../../core/app';
import type { CanvasView } from '../canvas-view';
import { clamp } from '../../core/geometry';
import { el, on, raf } from '../dom';

export class NavigatorPanel {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private frame: HTMLElement;
  private zoomInput: HTMLInputElement;
  private zoomLabel: HTMLElement;
  private stage: HTMLElement;

  constructor(private app: App, private view: CanvasView) {
    this.canvas = el('canvas', { width: 260, height: 96 }) as HTMLCanvasElement;
    this.frame = el('div', { class: 'nav-rect' });
    this.stage = el('div', { class: 'navigator' }, this.canvas, this.frame);
    this.zoomInput = el('input', {
      type: 'range', min: 1, max: 1600, value: 100, style: 'flex:1',
    }) as HTMLInputElement;
    this.zoomLabel = el('span', { class: 'val', text: '100%' });

    on(this.zoomInput, 'input', () => {
      const z = Number(this.zoomInput.value) / 100;
      this.view.zoomTo(z);
    });

    on(this.stage, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      const doc = this.app.activeDoc();
      if (!doc) return;
      const rect = this.canvas.getBoundingClientRect();
      const nx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      const ny = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      const v = this.app.view();
      v.centerX = nx * doc.width;
      v.centerY = ny * doc.height;
      this.app.events.emit('view-changed', undefined);
    });

    this.root = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', { text: '導覽器' })),
      el('div', { class: 'panel-body', style: 'display:grid;gap:8px' },
        this.stage,
        el('div', { style: 'display:flex;gap:8px;align-items:center' }, this.zoomInput, this.zoomLabel)));

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    app.events.on('view-changed', update);
    update();
  }

  refresh(): void {
    const doc = this.app.activeDoc();
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!doc) { this.frame.style.display = 'none'; return; }

    const scale = Math.min(this.canvas.width / doc.width, this.canvas.height / doc.height);
    const w = Math.max(1, doc.width * scale);
    const h = Math.max(1, doc.height * scale);
    const ox = (this.canvas.width - w) / 2;
    const oy = (this.canvas.height - h) / 2;
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(ox, oy, w, h);
    ctx.drawImage(doc.composite().canvas, ox, oy, w, h);

    const v = this.app.view();
    this.zoomInput.value = String(Math.round(clamp(v.zoom * 100, 1, 1600)));
    this.zoomLabel.textContent = `${Math.round(v.zoom * 100)}%`;

    // Approximate the visible region from the canvas element size.
    const viewportRect = this.view.root.getBoundingClientRect();
    const visW = Math.min(doc.width, viewportRect.width / v.zoom);
    const visH = Math.min(doc.height, viewportRect.height / v.zoom);
    const stageRect = this.stage.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const dx = canvasRect.left - stageRect.left;
    const dy = canvasRect.top - stageRect.top;
    this.frame.style.display = '';
    this.frame.style.left = `${dx + ox + (v.centerX - visW / 2) * scale}px`;
    this.frame.style.top = `${dy + oy + (v.centerY - visH / 2) * scale}px`;
    this.frame.style.width = `${visW * scale}px`;
    this.frame.style.height = `${visH * scale}px`;
  }
}
