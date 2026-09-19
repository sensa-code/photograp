import type { Point } from './geometry';
import { createSurface, type Surface } from './surface';

/**
 * A 3x3 projective transform, row-major. Unlike the affine transforms the
 * canvas can do, this one can turn a quadrilateral back into a rectangle,
 * which is what straightening a photographed page needs.
 */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Solve `A x = b` by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / m[i][i]);
}

/**
 * The transform taking four source points to four destination points. Eight
 * unknowns, eight equations: each correspondence gives one for x and one
 * for y, with h22 pinned to 1 to fix the overall scale.
 */
export function homography(from: Point[], to: Point[]): Matrix3 | null {
  if (from.length !== 4 || to.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Apply a projective transform to a point. */
export function applyMatrix(m: Matrix3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  const d = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / d,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / d,
  };
}

/** Bilinear sample, with everything outside the source treated as empty. */
function sample(
  data: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Uint8ClampedArray,
  at: number,
): void {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const px = (cx: number, cy: number): number =>
    (Math.min(h - 1, Math.max(0, cy)) * w + Math.min(w - 1, Math.max(0, cx))) * 4;
  const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
  for (let k = 0; k < 4; k++) {
    const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
    const bottom = data[c + k] + (data[d + k] - data[c + k]) * fx;
    out[at + k] = top + (bottom - top) * fy;
  }
}

/**
 * Straighten `quad` (four source corners, clockwise from the top left) into a
 * `w` x `h` image. The inverse transform is used so every destination pixel
 * is filled exactly once, with no gaps.
 */
export function warpQuad(
  src: Surface, quad: Point[], w: number, h: number,
): Surface | null {
  const dest: Point[] = [
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
  ];
  const inverse = homography(dest, quad);
  if (!inverse) return null;

  const from = src.ctx.getImageData(0, 0, src.w, src.h);
  const out = createSurface(w, h);
  const img = out.ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sample at the pixel centre, or the result drifts half a pixel.
      const p = applyMatrix(inverse, { x: x + 0.5, y: y + 0.5 });
      sample(from.data, src.w, src.h, p.x - 0.5, p.y - 0.5, img.data, (y * w + x) * 4);
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return out;
}

/** Side lengths of a quad, clockwise from the top edge. */
export function quadSides(quad: Point[]): [number, number, number, number] {
  const d = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  return [d(quad[0], quad[1]), d(quad[1], quad[2]), d(quad[2], quad[3]), d(quad[3], quad[0])];
}

/**
 * A sensible output size for a quad: the longer of each opposite pair, so a
 * page photographed at an angle comes out at roughly its true proportions
 * rather than squashed to the foreshortened side.
 */
export function suggestedSize(quad: Point[]): { w: number; h: number } {
  const [top, right, bottom, left] = quadSides(quad);
  return {
    w: Math.max(1, Math.round(Math.max(top, bottom))),
    h: Math.max(1, Math.round(Math.max(left, right))),
  };
}

/** Twice the signed area; positive means the corners run clockwise. */
export function quadArea(quad: Point[]): number {
  let sum = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Whether the four corners make a shape we can straighten: convex, wound the
 * same way all round, and with some actual area. A bow-tie quad has a valid
 * homography on paper but folds the image over itself.
 */
export function quadIsUsable(quad: Point[]): boolean {
  if (quad.length !== 4) return false;
  if (Math.abs(quadArea(quad)) < 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}
