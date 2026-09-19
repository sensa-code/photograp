import { createSurface, type Surface } from './surface';
import type { Rect } from './geometry';

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

/**
 * A selection is an 8-bit coverage mask the size of the document.
 * A null mask means "nothing selected"; operations then apply everywhere.
 */
export class Selection {
  mask: Uint8Array | null = null;
  private cachedBounds: Rect | null | undefined = undefined;
  private cachedPath: Path2D | null | undefined = undefined;
  private cachedLoops: { x: number; y: number }[][] | undefined = undefined;

  constructor(public width: number, public height: number) {}

  get active(): boolean { return this.mask !== null; }

  clone(): Selection {
    const s = new Selection(this.width, this.height);
    s.mask = this.mask ? new Uint8Array(this.mask) : null;
    return s;
  }

  invalidate(): void {
    this.cachedBounds = undefined;
    this.cachedPath = undefined;
    this.cachedLoops = undefined;
  }

  clear(): void { this.mask = null; this.invalidate(); }

  selectAll(): void {
    this.mask = new Uint8Array(this.width * this.height).fill(255);
    this.invalidate();
  }

  /** Coverage at a pixel; 255 everywhere when there is no active selection. */
  at(x: number, y: number): number {
    if (!this.mask) return 255;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[y * this.width + x];
  }

  /** Combine an 8-bit coverage buffer into this selection. */
  combine(src: Uint8Array, mode: SelectMode): void {
    const n = this.width * this.height;
    if (!this.mask) {
      if (mode === 'subtract') return;
      this.mask = src.slice();
    } else if (mode === 'replace') {
      this.mask = src.slice();
    } else {
      const m = this.mask;
      switch (mode) {
        case 'add': for (let i = 0; i < n; i++) m[i] = Math.max(m[i], src[i]); break;
        case 'subtract': for (let i = 0; i < n; i++) m[i] = Math.max(0, m[i] - src[i]); break;
        case 'intersect': for (let i = 0; i < n; i++) m[i] = Math.min(m[i], src[i]); break;
      }
    }
    this.invalidate();
    if (this.isEmpty()) this.mask = null;
  }

  isEmpty(): boolean {
    if (!this.mask) return true;
    for (let i = 0; i < this.mask.length; i++) if (this.mask[i] > 0) return false;
    return true;
  }

  invert(): void {
    if (!this.mask) { this.selectAll(); return; }
    const m = this.mask;
    for (let i = 0; i < m.length; i++) m[i] = 255 - m[i];
    this.invalidate();
    if (this.isEmpty()) this.mask = null;
  }

  bounds(): Rect | null {
    if (this.cachedBounds !== undefined) return this.cachedBounds;
    if (!this.mask) return (this.cachedBounds = null);
    const { width: w, height: h, mask } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    this.cachedBounds = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    return this.cachedBounds;
  }

  /** An alpha surface of the mask, usable as a clip via destination-in. */
  toSurface(): Surface {
    const s = createSurface(this.width, this.height);
    const img = s.ctx.createImageData(this.width, this.height);
    const d = img.data;
    if (this.mask) {
      for (let i = 0, p = 0; i < this.mask.length; i++, p += 4) {
        d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = this.mask[i];
      }
    } else {
      d.fill(255);
    }
    s.ctx.putImageData(img, 0, 0);
    return s;
  }

  /** Chained boundary loops used to draw the animated selection border. */
  outline(): Path2D | null {
    if (this.cachedPath !== undefined) return this.cachedPath;
    if (!this.mask) return (this.cachedPath = null);
    const path = new Path2D();
    for (const loop of this.loops()) {
      path.moveTo(loop[0].x, loop[0].y);
      for (let i = 1; i < loop.length; i++) path.lineTo(loop[i].x, loop[i].y);
      path.closePath();
    }
    this.cachedPath = path;
    return this.cachedPath;
  }

  /** The same boundary, as polygon point loops (used to build work paths). */
  loops(): { x: number; y: number }[][] {
    if (!this.mask) return [];
    if (this.cachedLoops === undefined) {
      this.cachedLoops = traceLoops(this.mask, this.width, this.height);
    }
    return this.cachedLoops;
  }

  feather(radius: number): void {
    if (!this.mask || radius <= 0) return;
    this.mask = blurMask(this.mask, this.width, this.height, radius);
    this.invalidate();
  }

  expand(px: number): void {
    if (!this.mask || px <= 0) return;
    this.mask = morph(this.mask, this.width, this.height, px, true);
    this.invalidate();
  }

  contract(px: number): void {
    if (!this.mask || px <= 0) return;
    this.mask = morph(this.mask, this.width, this.height, px, false);
    this.invalidate();
    if (this.isEmpty()) this.mask = null;
  }

  /** Ring between expanded and contracted copies, i.e. Select > Border. */
  border(px: number): void {
    if (!this.mask || px <= 0) return;
    const outer = morph(this.mask, this.width, this.height, Math.ceil(px / 2), true);
    const inner = morph(this.mask, this.width, this.height, Math.floor(px / 2), false);
    for (let i = 0; i < outer.length; i++) outer[i] = Math.max(0, outer[i] - inner[i]);
    this.mask = outer;
    this.invalidate();
    if (this.isEmpty()) this.mask = null;
  }

  translate(dx: number, dy: number): void {
    if (!this.mask) return;
    const { width: w, height: h } = this;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        if (sx < 0 || sx >= w) continue;
        out[y * w + x] = this.mask[sy * w + sx];
      }
    }
    this.mask = out;
    this.invalidate();
  }

  resize(w: number, h: number, offsetX = 0, offsetY = 0): void {
    const old = this.mask;
    const ow = this.width, oh = this.height;
    this.width = w; this.height = h;
    if (!old) { this.invalidate(); return; }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = y - offsetY;
      if (sy < 0 || sy >= oh) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - offsetX;
        if (sx < 0 || sx >= ow) continue;
        out[y * w + x] = old[sy * ow + sx];
      }
    }
    this.mask = out;
    this.invalidate();
  }
}

/** Rasterize a Path2D into an 8-bit coverage buffer (antialiased). */
export function rasterizePath(path: Path2D, w: number, h: number, evenOdd = false): Uint8Array {
  const s = createSurface(w, h);
  s.ctx.fillStyle = '#fff';
  s.ctx.fill(path, evenOdd ? 'evenodd' : 'nonzero');
  const d = s.ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < out.length; i++, p += 4) out[i] = d[p];
  return out;
}

/** Separable box blur repeated three times, approximating a Gaussian. */
export function blurMask(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(1, Math.round(radius));
  const a = Float32Array.from(src);
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(a[i])));
  return out;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = r * 2 + 1;
  const cl = (v: number): number => (v < 0 ? 0 : v > w - 1 ? w - 1 : v);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + cl(i)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / win;
      sum -= src[row + cl(x - r)];
      sum += src[row + cl(x + r + 1)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = r * 2 + 1;
  const cl = (v: number): number => (v < 0 ? 0 : v > h - 1 ? h - 1 : v);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[cl(i) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      sum -= src[cl(y - r) * w + x];
      sum += src[cl(y + r + 1) * w + x];
    }
  }
}

/** Separable max (dilate) / min (erode) over a square window. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pick = dilate ? Math.max : Math.min;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) { if (!dilate) v = 0; continue; }
        v = pick(v, src[row + xx]);
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) { if (!dilate) v = 0; continue; }
        v = pick(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Walk the boundary between selected (>=128) and unselected pixels and chain
 * the unit edges into closed loops, so the border strokes as a dashed line
 * and can also be converted into a vector work path.
 */
export function traceLoops(mask: Uint8Array, w: number, h: number): { x: number; y: number }[][] {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= 128;

  // Directed unit edges packed as [x1, y1, x2, y2] quadruples.
  const edges: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) edges.push(x, y, x + 1, y);
      if (!inside(x + 1, y)) edges.push(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) edges.push(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) edges.push(x, y + 1, x, y);
    }
  }

  const key = (x: number, y: number): number => y * (w + 2) + x;
  const starts = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i += 4) {
    const k = key(edges[i], edges[i + 1]);
    const arr = starts.get(k);
    if (arr) arr.push(i); else starts.set(k, [i]);
  }

  const used = new Uint8Array(edges.length / 4);
  const loops: { x: number; y: number }[][] = [];
  for (let i = 0; i < edges.length; i += 4) {
    if (used[i / 4]) continue;
    used[i / 4] = 1;
    const sx = edges[i], sy = edges[i + 1];
    const loop: { x: number; y: number }[] = [{ x: sx, y: sy }];
    let cx = edges[i + 2], cy = edges[i + 3];
    let dx = cx - sx, dy = cy - sy;
    let guard = 0;
    while ((cx !== sx || cy !== sy) && guard++ < edges.length) {
      const cand = starts.get(key(cx, cy));
      let next = -1;
      if (cand) {
        // Prefer going straight so long runs collapse into one line segment.
        for (const idx of cand) {
          if (used[idx / 4]) continue;
          const ex = edges[idx + 2] - edges[idx], ey = edges[idx + 3] - edges[idx + 1];
          if (ex === dx && ey === dy) { next = idx; break; }
          if (next < 0) next = idx;
        }
      }
      if (next < 0) break;
      used[next / 4] = 1;
      const nx = edges[next + 2], ny = edges[next + 3];
      dx = nx - cx; dy = ny - cy;
      cx = nx; cy = ny;
      loop.push({ x: cx, y: cy });
    }
    // The walk ends back on the start point; drop that duplicate so the loop
    // is a plain polygon (callers close it themselves).
    const tail = loop[loop.length - 1];
    if (loop.length > 1 && tail.x === loop[0].x && tail.y === loop[0].y) loop.pop();
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}
