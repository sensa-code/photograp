import { el, on } from '../dom';
import { clamp } from '../../core/geometry';
import { luminance } from '../../core/color';
import { curveLut } from '../../filters/adjustments';

export interface HistogramData {
  rgb: Uint32Array;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  total: number;
}

export function computeHistogram(img: ImageData): HistogramData {
  const rgb = new Uint32Array(256);
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const d = img.data;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    rgb[Math.round(clamp(luminance(d[i], d[i + 1], d[i + 2]), 0, 255))]++;
    total++;
  }
  return { rgb, r, g, b, total };
}

export function drawHistogram(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  hist: HistogramData, channel: 'rgb' | 'r' | 'g' | 'b',
): void {
  ctx.clearRect(0, 0, w, h);
  const data = hist[channel];
  let max = 0;
  for (let i = 1; i < 255; i++) max = Math.max(max, data[i]);
  max = Math.max(max, 1);
  ctx.fillStyle = channel === 'r' ? 'rgba(255,90,90,0.75)'
    : channel === 'g' ? 'rgba(90,220,120,0.75)'
      : channel === 'b' ? 'rgba(110,150,255,0.75)'
        : 'rgba(210,210,210,0.7)';
  for (let i = 0; i < 256; i++) {
    const bh = (Math.sqrt(data[i] / max)) * h;
    ctx.fillRect((i / 256) * w, h - bh, Math.ceil(w / 256), bh);
  }
}

export interface CurveEditorOptions {
  size?: number;
  onChange: (points: [number, number][]) => void;
  histogram?: HistogramData | null;
}

/** Interactive tone-curve editor with draggable control points. */
export class CurveEditor {
  readonly root: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;
  points: [number, number][] = [[0, 0], [255, 255]];
  private dragIndex = -1;
  private hist: HistogramData | null;

  constructor(private opts: CurveEditorOptions) {
    this.size = opts.size ?? 256;
    this.hist = opts.histogram ?? null;
    this.root = el('canvas', {
      class: 'curve-editor', width: this.size, height: this.size,
      style: `width:${this.size}px;height:${this.size}px`,
    }) as HTMLCanvasElement;
    this.ctx = this.root.getContext('2d')!;
    this.bind();
    this.draw();
  }

  setPoints(points: [number, number][]): void {
    this.points = points.map((p) => [p[0], p[1]] as [number, number]);
    this.draw();
  }

  setHistogram(h: HistogramData | null): void { this.hist = h; this.draw(); }

  private toCanvas(p: [number, number]): [number, number] {
    return [(p[0] / 255) * this.size, this.size - (p[1] / 255) * this.size];
  }

  private fromCanvas(x: number, y: number): [number, number] {
    return [
      clamp(Math.round((x / this.size) * 255), 0, 255),
      clamp(Math.round((1 - y / this.size) * 255), 0, 255),
    ];
  }

  private bind(): void {
    const pos = (ev: PointerEvent): [number, number] => {
      const r = this.root.getBoundingClientRect();
      return [
        ((ev.clientX - r.left) / r.width) * this.size,
        ((ev.clientY - r.top) / r.height) * this.size,
      ];
    };

    on(this.root, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      const [cx, cy] = pos(ev);
      const hit = this.points.findIndex((p) => {
        const [px, py] = this.toCanvas(p);
        return Math.hypot(px - cx, py - cy) < 9;
      });
      if (ev.altKey || ev.button === 2) {
        if (hit > 0 && hit < this.points.length - 1) {
          this.points.splice(hit, 1);
          this.commit();
        }
        return;
      }
      if (hit >= 0) {
        this.dragIndex = hit;
      } else {
        const p = this.fromCanvas(cx, cy);
        this.points.push(p);
        this.points.sort((a, b) => a[0] - b[0]);
        this.dragIndex = this.points.findIndex((q) => q === p);
        this.commit();
      }
      this.root.setPointerCapture(ev.pointerId);
    });

    on(this.root, 'pointermove', (e) => {
      if (this.dragIndex < 0) return;
      const ev = e as PointerEvent;
      const [cx, cy] = pos(ev);
      const p = this.fromCanvas(cx, cy);
      const isEnd = this.dragIndex === 0 || this.dragIndex === this.points.length - 1;
      // Endpoints keep their input position so the curve always spans 0..255.
      this.points[this.dragIndex] = isEnd ? [this.points[this.dragIndex][0], p[1]] : p;
      this.points.sort((a, b) => a[0] - b[0]);
      this.commit();
    });

    const stop = (): void => { this.dragIndex = -1; };
    on(this.root, 'pointerup', stop);
    on(this.root, 'pointercancel', stop);
    on(this.root, 'contextmenu', (e) => e.preventDefault());
  }

  private commit(): void {
    this.draw();
    this.opts.onChange(this.points.map((p) => [p[0], p[1]] as [number, number]));
  }

  draw(): void {
    const { ctx, size } = this;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#252525';
    ctx.fillRect(0, 0, size, size);

    if (this.hist) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      drawHistogram(ctx, size, size, this.hist, 'rgb');
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const p = (i / 4) * size;
      ctx.moveTo(p, 0); ctx.lineTo(p, size);
      ctx.moveTo(0, p); ctx.lineTo(size, p);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, size); ctx.lineTo(size, 0);
    ctx.stroke();

    // Sampled spline preview using the same LUT the adjustment will use.
    const lut = curveLut(this.points);
    ctx.strokeStyle = '#7fb8ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * size;
      const y = size - (lut[i] / 255) * size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2b6cb0';
    for (const p of this.points) {
      const [x, y] = this.toCanvas(p);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** A histogram canvas that can be re-pointed at fresh data. */
export class HistogramView {
  readonly root: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private w = 256, private h = 90) {
    this.root = el('canvas', {
      width: w, height: h, class: 'curve-editor',
      style: `width:${w}px;height:${h}px`,
    }) as HTMLCanvasElement;
    this.ctx = this.root.getContext('2d')!;
  }

  update(hist: HistogramData, channel: 'rgb' | 'r' | 'g' | 'b' = 'rgb'): void {
    this.ctx.fillStyle = '#252525';
    this.ctx.fillRect(0, 0, this.w, this.h);
    drawHistogram(this.ctx, this.w, this.h, hist, channel);
  }
}
