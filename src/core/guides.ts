import { uid } from './ids';
import type { Layer } from './types';
import { opaqueBounds } from './surface';
import type { Rect } from './geometry';

export type GuideAxis = 'h' | 'v';

/** A single ruler guide. Horizontal guides sit at a y position, vertical at x. */
export interface Guide {
  id: string;
  axis: GuideAxis;
  pos: number;
}

export const createGuide = (axis: GuideAxis, pos: number): Guide =>
  ({ id: uid('g'), axis, pos });

export interface SnapSettings {
  enabled: boolean;
  toGuides: boolean;
  toGrid: boolean;
  toDocument: boolean;
  toLayers: boolean;
}

export const defaultSnapSettings = (): SnapSettings => ({
  enabled: true,
  toGuides: true,
  toGrid: false,
  toDocument: true,
  toLayers: true,
});

/** Candidate coordinates a drag can land on, in document space. */
export interface SnapContext {
  x: number[];
  y: number[];
  /** Grid step, or null when grid snapping is off. */
  grid: number | null;
  /** Maximum distance, in document units, that still snaps. */
  threshold: number;
}

export const emptySnapContext = (): SnapContext =>
  ({ x: [], y: [], grid: null, threshold: 0 });

export interface SnapSource {
  width: number;
  height: number;
  guides: Guide[];
  layers: Layer[];
}

/** Content bounds of a layer in document space, or null when it is empty. */
export function layerBounds(layer: Layer): Rect | null {
  if (!layer.surface) return null;
  const b = opaqueBounds(layer.surface);
  if (!b) return null;
  return { x: b.x + layer.x, y: b.y + layer.y, w: b.w, h: b.h };
}

/**
 * Build the snap candidates for the current document. `excludeLayerId` keeps
 * the layer being dragged from snapping to itself.
 */
export function collectSnapTargets(
  src: SnapSource, settings: SnapSettings, threshold: number,
  gridSize: number, excludeLayerId?: string | null,
): SnapContext {
  if (!settings.enabled) return emptySnapContext();
  const x: number[] = [];
  const y: number[] = [];

  if (settings.toDocument) {
    x.push(0, src.width / 2, src.width);
    y.push(0, src.height / 2, src.height);
  }
  if (settings.toGuides) {
    for (const g of src.guides) {
      if (g.axis === 'v') x.push(g.pos); else y.push(g.pos);
    }
  }
  if (settings.toLayers) {
    for (const layer of src.layers) {
      if (!layer.visible || layer.id === excludeLayerId) continue;
      const b = layerBounds(layer);
      if (!b) continue;
      x.push(b.x, b.x + b.w / 2, b.x + b.w);
      y.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
  }

  return {
    x,
    y,
    grid: settings.toGrid && gridSize > 0 ? gridSize : null,
    threshold,
  };
}

export interface SnapResult {
  /** How far to move so the value lands on a target. */
  delta: number;
  /** Document coordinate of the line that was hit, for the indicator. */
  line: number | null;
}

const NO_SNAP: SnapResult = { delta: 0, line: null };

/** Nearest snap for one coordinate. */
export function snapScalar(value: number, axis: 'x' | 'y', ctx: SnapContext): SnapResult {
  if (ctx.threshold <= 0) return NO_SNAP;
  let best = NO_SNAP;
  let bestDist = ctx.threshold;

  for (const t of axis === 'x' ? ctx.x : ctx.y) {
    const d = t - value;
    if (Math.abs(d) < bestDist) {
      bestDist = Math.abs(d);
      best = { delta: d, line: t };
    }
  }
  if (ctx.grid) {
    const t = Math.round(value / ctx.grid) * ctx.grid;
    const d = t - value;
    if (Math.abs(d) < bestDist) {
      bestDist = Math.abs(d);
      best = { delta: d, line: t };
    }
  }
  return best;
}

/**
 * Nearest snap for a whole set of coordinates that move together, e.g. the
 * left / centre / right edges of a dragged layer. The smallest adjustment
 * that puts any one of them on a target wins.
 */
export function snapGroup(values: number[], axis: 'x' | 'y', ctx: SnapContext): SnapResult {
  let best = NO_SNAP;
  let bestDist = Infinity;
  for (const v of values) {
    const r = snapScalar(v, axis, ctx);
    if (r.line === null) continue;
    const d = Math.abs(r.delta);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

export interface SnapLines { x: number[]; y: number[] }

/** Snap a moving rectangle, returning the adjusted offset and hit lines. */
export function snapRect(
  rect: Rect, ctx: SnapContext,
): { dx: number; dy: number; lines: SnapLines } {
  const xs = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const ys = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  const sx = snapGroup(xs, 'x', ctx);
  const sy = snapGroup(ys, 'y', ctx);
  return {
    dx: sx.delta,
    dy: sy.delta,
    lines: {
      x: sx.line === null ? [] : [sx.line],
      y: sy.line === null ? [] : [sy.line],
    },
  };
}

/** Snap a single point, e.g. the corner of a marquee being dragged. */
export function snapPoint(
  x: number, y: number, ctx: SnapContext,
): { x: number; y: number; lines: SnapLines } {
  const sx = snapScalar(x, 'x', ctx);
  const sy = snapScalar(y, 'y', ctx);
  return {
    x: x + sx.delta,
    y: y + sy.delta,
    lines: {
      x: sx.line === null ? [] : [sx.line],
      y: sy.line === null ? [] : [sy.line],
    },
  };
}

/** Find a guide near a document position, for hit-testing a drag. */
export function guideAt(
  guides: Guide[], x: number, y: number, tolerance: number,
): Guide | null {
  let best: Guide | null = null;
  let bestDist = tolerance;
  for (const g of guides) {
    const d = Math.abs((g.axis === 'v' ? x : y) - g.pos);
    if (d <= bestDist) { bestDist = d; best = g; }
  }
  return best;
}
