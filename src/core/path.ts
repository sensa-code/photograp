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

/** Total anchor count, used for UI readouts. */
export const anchorCount = (path: VectorPath): number =>
  path.subpaths.reduce((n, sp) => n + sp.anchors.length, 0);
