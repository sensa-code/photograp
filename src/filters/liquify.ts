import { clamp } from '../core/geometry';
import { createSurface, type Surface } from '../core/surface';

export type LiquifyMode =
  | 'forward' | 'twirl-cw' | 'twirl-ccw' | 'pucker' | 'bloat'
  | 'push-left' | 'reconstruct' | 'freeze' | 'thaw';

export const LIQUIFY_TOOLS: { mode: LiquifyMode; label: string; hint: string }[] = [
  { mode: 'forward', label: '向前彎曲', hint: '沿拖曳方向推擠像素' },
  { mode: 'twirl-cw', label: '順時針扭轉', hint: '按住不放讓筆刷範圍旋轉' },
  { mode: 'twirl-ccw', label: '逆時針扭轉', hint: '按住不放讓筆刷範圍反向旋轉' },
  { mode: 'pucker', label: '縮攏', hint: '把像素往筆刷中心吸' },
  { mode: 'bloat', label: '膨脹', hint: '把像素往外推開' },
  { mode: 'push-left', label: '左推', hint: '拖曳時像素往行進方向的左側移動' },
  { mode: 'reconstruct', label: '重建', hint: '把塗抹過的地方還原回原狀' },
  { mode: 'freeze', label: '凍結遮色片', hint: '保護不想被影響的區域' },
  { mode: 'thaw', label: '解凍', hint: '解除凍結保護' },
];

/**
 * A displacement mesh over the document. Each node stores the offset added to
 * the sampling position, so `out(p) = src(p + D(p))`. Pushing content in some
 * direction therefore subtracts that direction from the nodes it touches.
 */
export class WarpMesh {
  readonly cols: number;
  readonly rows: number;
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  /** 0 = editable, 1 = fully frozen. */
  readonly freeze: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = 4,
  ) {
    this.cols = Math.ceil(width / cell) + 1;
    this.rows = Math.ceil(height / cell) + 1;
    const n = this.cols * this.rows;
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.freeze = new Float32Array(n);
  }

  reset(): void {
    this.dx.fill(0);
    this.dy.fill(0);
  }

  clearFreeze(): void {
    this.freeze.fill(0);
  }

  isIdentity(): boolean {
    for (let i = 0; i < this.dx.length; i++) {
      if (this.dx[i] !== 0 || this.dy[i] !== 0) return false;
    }
    return true;
  }

  /** Bilinear displacement at a document-space position. */
  sample(x: number, y: number, out: [number, number]): void {
    const gx = clamp(x / this.cell, 0, this.cols - 1.001);
    const gy = clamp(y / this.cell, 0, this.rows - 1.001);
    const x0 = gx | 0, y0 = gy | 0;
    const fx = gx - x0, fy = gy - y0;
    const i00 = y0 * this.cols + x0;
    const i10 = i00 + 1;
    const i01 = i00 + this.cols;
    const i11 = i01 + 1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = this.dx[i00] * w00 + this.dx[i10] * w10 + this.dx[i01] * w01 + this.dx[i11] * w11;
    out[1] = this.dy[i00] * w00 + this.dy[i10] * w10 + this.dy[i01] * w01 + this.dy[i11] * w11;
  }

  /**
   * Apply one brush step. `dragX/dragY` is the pointer movement since the last
   * step, in document units; `amount` is 0..1 from the pressure setting.
   */
  stroke(
    mode: LiquifyMode, cx: number, cy: number, radius: number, amount: number,
    dragX: number, dragY: number,
  ): void {
    const r = Math.max(1, radius);
    const c0 = Math.max(0, Math.floor((cx - r) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((cx + r) / this.cell));
    const r0 = Math.max(0, Math.floor((cy - r) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.ceil((cy + r) / this.cell));
    if (c1 < c0 || r1 < r0) return;

    const dragLen = Math.hypot(dragX, dragY);
    const twirl = (mode === 'twirl-cw' ? 1 : -1) * amount * 0.35;

    for (let gy = r0; gy <= r1; gy++) {
      const py = gy * this.cell;
      for (let gx = c0; gx <= c1; gx++) {
        const px = gx * this.cell;
        const vx = px - cx, vy = py - cy;
        const d = Math.hypot(vx, vy);
        if (d > r) continue;
        const i = gy * this.cols + gx;

        // Smooth bell falloff: full strength at the centre, zero at the edge.
        const t = 1 - (d * d) / (r * r);
        const fall = t * t;

        if (mode === 'freeze') {
          this.freeze[i] = clamp(this.freeze[i] + fall * amount, 0, 1);
          continue;
        }
        if (mode === 'thaw') {
          this.freeze[i] = clamp(this.freeze[i] - fall * amount, 0, 1);
          continue;
        }

        const w = fall * (1 - this.freeze[i]);
        if (w <= 0) continue;

        switch (mode) {
          case 'forward':
            // Pressure below 100% makes the content lag behind the pointer.
            this.dx[i] -= dragX * w * amount;
            this.dy[i] -= dragY * w * amount;
            break;
          case 'push-left': {
            if (dragLen < 1e-4) break;
            // Perpendicular to the drag, pointing to its left-hand side.
            const nx = dragY / dragLen, ny = -dragX / dragLen;
            this.dx[i] -= nx * dragLen * w * amount;
            this.dy[i] -= ny * dragLen * w * amount;
            break;
          }
          // These compose with the deformation already stored at the
          // node, so repeated steps keep rotating or pulling the pixels
          // the node currently samples rather than the original ones.
          case 'twirl-cw':
          case 'twirl-ccw': {
            const a = -twirl * w;
            const cos = Math.cos(a), sin = Math.sin(a);
            const sxv = vx + this.dx[i], syv = vy + this.dy[i];
            this.dx[i] = sxv * cos - syv * sin - vx;
            this.dy[i] = sxv * sin + syv * cos - vy;
            break;
          }
          case 'pucker': {
            const k = w * amount * 0.3;
            this.dx[i] += (vx + this.dx[i]) * k;
            this.dy[i] += (vy + this.dy[i]) * k;
            break;
          }
          case 'bloat': {
            const k = w * amount * 0.3;
            this.dx[i] -= (vx + this.dx[i]) * k;
            this.dy[i] -= (vy + this.dy[i]) * k;
            break;
          }
          case 'reconstruct': {
            const k = clamp(1 - w * amount, 0, 1);
            this.dx[i] *= k;
            this.dy[i] *= k;
            break;
          }
        }
      }
    }
  }

  /** True where the freeze mask protects anything, for the overlay. */
  hasFreeze(): boolean {
    for (let i = 0; i < this.freeze.length; i++) if (this.freeze[i] > 0.01) return true;
    return false;
  }
}

/**
 * Warp `src` into `dst` through the mesh. Both buffers may be a scaled-down
 * copy of the document; `scale` says how many image pixels one document unit
 * covers, so the same mesh drives the preview and the final render.
 */
export function warpImage(src: ImageData, dst: ImageData, mesh: WarpMesh, scale: number): void {
  const w = dst.width, h = dst.height;
  const sw = src.width, sh = src.height;
  const s = src.data, d = dst.data;
  const off: [number, number] = [0, 0];

  for (let y = 0; y < h; y++) {
    const docY = y / scale;
    for (let x = 0; x < w; x++) {
      mesh.sample(x / scale, docY, off);
      const o = (y * w + x) * 4;
      if (off[0] === 0 && off[1] === 0) {
        const i = o;
        d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        continue;
      }
      const sx = clamp(x + off[0] * scale, 0, sw - 1);
      const sy = clamp(y + off[1] * scale, 0, sh - 1);
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      // Weight by alpha as well, so transparent neighbours cannot bleed
      // their colour into the result.
      const a00 = s[i00 + 3] * (1 - fx) * (1 - fy);
      const a10 = s[i10 + 3] * fx * (1 - fy);
      const a01 = s[i01 + 3] * (1 - fx) * fy;
      const a11 = s[i11 + 3] * fx * fy;
      const aOut = a00 + a10 + a01 + a11;
      if (aOut <= 0) {
        d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
      } else {
        for (let c = 0; c < 3; c++) {
          d[o + c] = (s[i00 + c] * a00 + s[i10 + c] * a10
            + s[i01 + c] * a01 + s[i11 + c] * a11) / aOut;
        }
        d[o + 3] = aOut;
      }
    }
  }
}

/**
 * Replace the selected region of `original` with `warped`. The selected
 * area is swapped wholesale, because a warp can introduce transparency
 * there and the untouched pixels must not show through it.
 */
export function composeWarpWithSelection(
  original: Surface, warped: Surface, selection: Surface, offX: number, offY: number,
): Surface {
  const inside = createSurface(original.w, original.h);
  inside.ctx.drawImage(warped.canvas, 0, 0);
  inside.ctx.globalCompositeOperation = 'destination-in';
  inside.ctx.drawImage(selection.canvas, -offX, -offY);

  const outside = createSurface(original.w, original.h);
  outside.ctx.drawImage(original.canvas, 0, 0);
  outside.ctx.globalCompositeOperation = 'destination-out';
  outside.ctx.drawImage(selection.canvas, -offX, -offY);

  const merged = createSurface(original.w, original.h);
  merged.ctx.drawImage(outside.canvas, 0, 0);
  merged.ctx.drawImage(inside.canvas, 0, 0);
  return merged;
}

/** Draw the mesh lines for the "show mesh" option. */
export function meshPath(mesh: WarpMesh, scale: number, step = 4): Path2D {
  const path = new Path2D();
  const off: [number, number] = [0, 0];
  const node = (gx: number, gy: number): [number, number] => {
    const px = gx * mesh.cell, py = gy * mesh.cell;
    mesh.sample(px, py, off);
    // The mesh shows where each grid point lands in the output.
    return [(px - off[0]) * scale, (py - off[1]) * scale];
  };
  for (let gy = 0; gy < mesh.rows; gy += step) {
    for (let gx = 0; gx < mesh.cols; gx += step) {
      const [x, y] = node(gx, gy);
      if (gx === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
  }
  for (let gx = 0; gx < mesh.cols; gx += step) {
    for (let gy = 0; gy < mesh.rows; gy += step) {
      const [x, y] = node(gx, gy);
      if (gy === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
  }
  return path;
}

/** Freeze-mask overlay as an RGBA buffer at the preview scale. */
export function freezeOverlay(mesh: WarpMesh, w: number, h: number, scale: number): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const gy = clamp((y / scale) / mesh.cell, 0, mesh.rows - 1.001);
    const y0 = gy | 0, fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = clamp((x / scale) / mesh.cell, 0, mesh.cols - 1.001);
      const x0 = gx | 0, fx = gx - x0;
      const i00 = y0 * mesh.cols + x0;
      const v = mesh.freeze[i00] * (1 - fx) * (1 - fy)
        + mesh.freeze[i00 + 1] * fx * (1 - fy)
        + mesh.freeze[i00 + mesh.cols] * (1 - fx) * fy
        + mesh.freeze[i00 + mesh.cols + 1] * fx * fy;
      const o = (y * w + x) * 4;
      d[o] = 90; d[o + 1] = 190; d[o + 2] = 255;
      d[o + 3] = Math.round(v * 140);
    }
  }
  return img;
}
