import { uid } from './ids';
import type { Point } from './geometry';

/**
 * A Bézier anchor. Handles are stored in absolute document coordinates so
 * hit-testing and dragging need no extra conversion.
 */
export interface Anchor {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  /** Smooth anchors keep their two handles mirrored while dragging. */
  smooth: boolean;
}

export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

export interface VectorPath {
  id: string;
  name: string;
  subpaths: SubPath[];
}

export const createAnchor = (x: number, y: number, smooth = false): Anchor =>
  ({ x, y, inX: x, inY: y, outX: x, outY: y, smooth });

export const createPath = (name = '工作路徑'): VectorPath =>
  ({ id: uid('p'), name, subpaths: [] });

export function clonePath(path: VectorPath): VectorPath {
  return {
    id: path.id,
    name: path.name,
    subpaths: path.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => ({ ...a })),
    })),
  };
}

export const pathIsEmpty = (path: VectorPath | null): boolean =>
  !path || path.subpaths.every((sp) => sp.anchors.length < 2);

/** Move an anchor and carry its handles along. */
export function moveAnchor(a: Anchor, x: number, y: number): void {
  const dx = x - a.x, dy = y - a.y;
  a.x = x; a.y = y;
  a.inX += dx; a.inY += dy;
  a.outX += dx; a.outY += dy;
}

/** Drag one handle; smooth anchors mirror the movement on the other side. */
export function moveHandle(a: Anchor, which: 'in' | 'out', x: number, y: number, mirror: boolean): void {
  if (which === 'in') {
    a.inX = x; a.inY = y;
    if (mirror && a.smooth) { a.outX = 2 * a.x - x; a.outY = 2 * a.y - y; }
  } else {
    a.outX = x; a.outY = y;
    if (mirror && a.smooth) { a.inX = 2 * a.x - x; a.inY = 2 * a.y - y; }
  }
}

function emitSegment(p: Path2D, a: Anchor, b: Anchor): void {
  const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y;
  if (straight) p.lineTo(b.x, b.y);
  else p.bezierCurveTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
}

export function toPath2D(path: VectorPath, includeOpen = true): Path2D {
  const out = new Path2D();
  for (const sp of path.subpaths) {
    if (sp.anchors.length < 2) continue;
    if (!sp.closed && !includeOpen) continue;
    out.moveTo(sp.anchors[0].x, sp.anchors[0].y);
    for (let i = 0; i < sp.anchors.length - 1; i++) emitSegment(out, sp.anchors[i], sp.anchors[i + 1]);
    if (sp.closed) {
      emitSegment(out, sp.anchors[sp.anchors.length - 1], sp.anchors[0]);
      out.closePath();
    }
  }
  return out;
}

/** Path2D for a partially drawn subpath plus a rubber band to the cursor. */
export function previewPath2D(sp: SubPath, cursor: Point | null, pending: Anchor | null): Path2D {
  const out = new Path2D();
  if (!sp.anchors.length) return out;
  out.moveTo(sp.anchors[0].x, sp.anchors[0].y);
  for (let i = 0; i < sp.anchors.length - 1; i++) emitSegment(out, sp.anchors[i], sp.anchors[i + 1]);
  const last = sp.anchors[sp.anchors.length - 1];
  if (pending) emitSegment(out, last, pending);
  else if (cursor) {
    emitSegment(out, last, createAnchor(cursor.x, cursor.y));
  }
  return out;
}

export interface AnchorHit {
  subpath: number;
  anchor: number;
  part: 'point' | 'in' | 'out';
}

/** Find the anchor point or handle under a document-space position. */
export function hitTest(path: VectorPath, p: Point, tolerance: number): AnchorHit | null {
  for (let s = 0; s < path.subpaths.length; s++) {
    const anchors = path.subpaths[s].anchors;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (Math.hypot(a.inX - p.x, a.inY - p.y) <= tolerance && (a.inX !== a.x || a.inY !== a.y)) {
        return { subpath: s, anchor: i, part: 'in' };
      }
      if (Math.hypot(a.outX - p.x, a.outY - p.y) <= tolerance && (a.outX !== a.x || a.outY !== a.y)) {
        return { subpath: s, anchor: i, part: 'out' };
      }
    }
    // Anchor points win over handles when they overlap.
    for (let i = 0; i < anchors.length; i++) {
      if (Math.hypot(anchors[i].x - p.x, anchors[i].y - p.y) <= tolerance) {
        return { subpath: s, anchor: i, part: 'point' };
      }
    }
  }
  return null;
}

/** Ramer–Douglas–Peucker simplification for traced selection outlines. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let worst = -1, worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      // A closed loop can hand us a zero-length baseline; fall back to the
      // straight distance from the shared endpoint so the split still works.
      const d = len === 0
        ? Math.hypot(points[i].x - a.x, points[i].y - a.y)
        : Math.abs((points[i].x - a.x) * dy - (points[i].y - a.y) * dx) / len;
      if (d > worst) { worst = d; worstIdx = i; }
    }
    if (worst > tolerance && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Build a vector path from traced selection loops. */
export function pathFromLoops(loops: Point[][], tolerance: number, name = '工作路徑'): VectorPath {
  const path = createPath(name);
  for (const loop of loops) {
    const pts = simplify(loop, tolerance);
    if (pts.length < 3) continue;
    path.subpaths.push({ closed: true, anchors: pts.map((p) => createAnchor(p.x, p.y)) });
  }
  return path;
}

// ---------------------------------------------------------------------------
// Arc-length sampling
//
// Laying type along a curve needs "the point 120px from the start", which a
// Bezier's own parameter cannot answer — it runs faster through the middle of
// a curve than the ends. Flattening to a polyline first makes distance and
// parameter the same thing again.
// ---------------------------------------------------------------------------

/** A subpath flattened to a polyline with cumulative arc lengths. */
export interface FlatPath {
  pts: Point[];
  /** `at[i]` is the distance from the start to `pts[i]`; `at[0]` is 0. */
  at: number[];
  length: number;
  closed: boolean;
}

/** A position on a path together with the tangent direction there. */
export interface PathSample {
  x: number;
  y: number;
  /** Tangent angle in radians, ready for `ctx.rotate()`. */
  angle: number;
}

function cubicAt(
  ax: number, ay: number, c1x: number, c1y: number,
  c2x: number, c2y: number, bx: number, by: number, t: number,
): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * ax + b * c1x + c * c2x + d * bx,
    y: a * ay + b * c1y + c * c2y + d * by,
  };
}

/** Steps proportional to the control polygon, so long curves stay smooth. */
function stepsFor(a: Anchor, b: Anchor): number {
  const rough = Math.hypot(a.outX - a.x, a.outY - a.y)
    + Math.hypot(b.inX - a.outX, b.inY - a.outY)
    + Math.hypot(b.x - b.inX, b.y - b.inY);
  return Math.max(6, Math.min(160, Math.ceil(rough / 3)));
}

/** Flatten one subpath into a polyline with its cumulative arc lengths. */
export function flattenSubPath(sp: SubPath): FlatPath {
  const pts: Point[] = [];
  const at: number[] = [];
  if (!sp.anchors.length) return { pts, at, length: 0, closed: sp.closed };

  let total = 0;
  const push = (p: Point): void => {
    if (pts.length) {
      const prev = pts[pts.length - 1];
      const d = Math.hypot(p.x - prev.x, p.y - prev.y);
      // Duplicate points would give a zero-length segment and no tangent.
      if (d < 1e-9) return;
      total += d;
    }
    pts.push(p);
    at.push(total);
  };

  push({ x: sp.anchors[0].x, y: sp.anchors[0].y });
  const segment = (a: Anchor, b: Anchor): void => {
    const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y;
    if (straight) { push({ x: b.x, y: b.y }); return; }
    const n = stepsFor(a, b);
    for (let i = 1; i <= n; i++) {
      push(cubicAt(a.x, a.y, a.outX, a.outY, b.inX, b.inY, b.x, b.y, i / n));
    }
  };
  for (let i = 0; i < sp.anchors.length - 1; i++) segment(sp.anchors[i], sp.anchors[i + 1]);
  if (sp.closed && sp.anchors.length > 1) {
    segment(sp.anchors[sp.anchors.length - 1], sp.anchors[0]);
  }
  return { pts, at, length: total, closed: sp.closed };
}

/**
 * Flatten every usable subpath of a path, longest first — type follows the
 * main outline rather than whichever fragment happens to come first.
 */
export function flattenPath(path: VectorPath): FlatPath[] {
  return path.subpaths
    .filter((sp) => sp.anchors.length >= 2)
    .map(flattenSubPath)
    .filter((f) => f.length > 0)
    .sort((a, b) => b.length - a.length);
}

/**
 * The point `distance` along the flattened path. A closed path wraps; an open
 * one extends along its end tangent so type never disappears when it overruns.
 */
export function pathPointAt(flat: FlatPath, distance: number): PathSample | null {
  const n = flat.pts.length;
  if (n < 2 || flat.length <= 0) return null;

  let d = distance;
  if (flat.closed) {
    d = ((d % flat.length) + flat.length) % flat.length;
  } else if (d < 0 || d > flat.length) {
    // Off the end: keep going in a straight line along the end tangent.
    const [from, to] = d < 0 ? [flat.pts[1], flat.pts[0]] : [flat.pts[n - 2], flat.pts[n - 1]];
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const over = d < 0 ? -d : d - flat.length;
    return { x: to.x + Math.cos(angle) * over, y: to.y + Math.sin(angle) * over, angle };
  }

  // Binary search the cumulative lengths for the segment holding d.
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (flat.at[mid] <= d) lo = mid; else hi = mid;
  }
  const a = flat.pts[lo], b = flat.pts[hi];
  const span = flat.at[hi] - flat.at[lo];
  const t = span > 0 ? (d - flat.at[lo]) / span : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Distance from `p` to the path, and how far along the path that lands. */
export function closestOnPath(
  path: VectorPath, p: Point,
): { distance: number; along: number; flat: FlatPath } | null {
  let best: { distance: number; along: number; flat: FlatPath } | null = null;
  for (const flat of flattenPath(path)) {
    for (let i = 0; i + 1 < flat.pts.length; i++) {
      const a = flat.pts[i], b = flat.pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const distance = Math.hypot(p.x - qx, p.y - qy);
      if (!best || distance < best.distance) {
        best = { distance, along: flat.at[i] + Math.sqrt(len2) * t, flat };
      }
    }
  }
  return best;
}

/** Total anchor count, used for UI readouts. */
export const anchorCount = (path: VectorPath): number =>
  path.subpaths.reduce((n, sp) => n + sp.anchors.length, 0);
