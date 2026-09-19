import type { Layer } from './types';
import type { RGB } from './color';
import { rgbCss } from './color';
import { createSurface } from './surface';
import { createAnchor, createPath, toPath2D, type Anchor, type VectorPath } from './path';
import { normalizeRect, type Point } from './geometry';

/** Circle-to-Bézier constant: handle length for a quarter arc of radius 1. */
const KAPPA = 0.5522847498307936;

export type StrokeAlign = 'center' | 'inside' | 'outside';

export interface ShapeStyle {
  fillEnabled: boolean;
  fill: RGB;
  fillOpacity: number;
  strokeEnabled: boolean;
  stroke: RGB;
  strokeWidth: number;
  strokeOpacity: number;
  strokeAlign: StrokeAlign;
  /** Dash length in pixels; 0 draws a solid line. */
  dash: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
}

/** A shape layer keeps its geometry, so it stays editable and resolution free. */
export interface ShapeLayerData {
  path: VectorPath;
  style: ShapeStyle;
}

export const defaultShapeStyle = (fill: RGB, stroke: RGB): ShapeStyle => ({
  fillEnabled: true,
  fill: { ...fill },
  fillOpacity: 1,
  strokeEnabled: false,
  stroke: { ...stroke },
  strokeWidth: 4,
  strokeOpacity: 1,
  strokeAlign: 'center',
  dash: 0,
  lineJoin: 'round',
  lineCap: 'round',
});

export const cloneShapeStyle = (s: ShapeStyle): ShapeStyle => ({
  ...s, fill: { ...s.fill }, stroke: { ...s.stroke },
});

function anchorWithHandles(
  x: number, y: number, inX: number, inY: number, outX: number, outY: number,
): Anchor {
  return { x, y, inX, inY, outX, outY, smooth: true };
}

export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'line' | 'polygon' | 'star' | 'arrow';

/**
 * Build the editable geometry for a drawn shape. Curved shapes get real
 * Bézier handles, so the result can be reshaped afterwards exactly like a
 * path drawn with the pen.
 */
export function shapeToVectorPath(
  kind: ShapeKind, x0: number, y0: number, x1: number, y1: number,
  radius: number, sides: number, name = '形狀',
): VectorPath {
  const path = createPath(name);
  const r = normalizeRect({ x: x0, y: y0 }, { x: x1, y: y1 });
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;

  switch (kind) {
    case 'rect':
      path.subpaths.push({
        closed: true,
        anchors: [
          createAnchor(r.x, r.y), createAnchor(r.x + r.w, r.y),
          createAnchor(r.x + r.w, r.y + r.h), createAnchor(r.x, r.y + r.h),
        ],
      });
      break;

    case 'rounded': {
      const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
      if (rad <= 0.5) {
        return shapeToVectorPath('rect', x0, y0, x1, y1, 0, sides, name);
      }
      const k = rad * (1 - KAPPA);
      const x = r.x, y = r.y, w = r.w, h = r.h;
      path.subpaths.push({
        closed: true,
        anchors: [
          anchorWithHandles(x + rad, y, x + k, y, x + rad, y),
          anchorWithHandles(x + w - rad, y, x + w - rad, y, x + w - k, y),
          anchorWithHandles(x + w, y + rad, x + w, y + k, x + w, y + rad),
          anchorWithHandles(x + w, y + h - rad, x + w, y + h - rad, x + w, y + h - k),
          anchorWithHandles(x + w - rad, y + h, x + w - k, y + h, x + w - rad, y + h),
          anchorWithHandles(x + rad, y + h, x + rad, y + h, x + k, y + h),
          anchorWithHandles(x, y + h - rad, x, y + h - k, x, y + h - rad),
          anchorWithHandles(x, y + rad, x, y + rad, x, y + k),
        ],
      });
      break;
    }

    case 'ellipse': {
      const rx = r.w / 2, ry = r.h / 2;
      const hx = rx * KAPPA, hy = ry * KAPPA;
      path.subpaths.push({
        closed: true,
        anchors: [
          anchorWithHandles(cx, cy - ry, cx - hx, cy - ry, cx + hx, cy - ry),
          anchorWithHandles(cx + rx, cy, cx + rx, cy - hy, cx + rx, cy + hy),
          anchorWithHandles(cx, cy + ry, cx + hx, cy + ry, cx - hx, cy + ry),
          anchorWithHandles(cx - rx, cy, cx - rx, cy + hy, cx - rx, cy - hy),
        ],
      });
      break;
    }

    case 'line':
      path.subpaths.push({ closed: false, anchors: [createAnchor(x0, y0), createAnchor(x1, y1)] });
      break;

    case 'arrow': {
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(8, Math.hypot(x1 - x0, y1 - y0) * 0.18);
      path.subpaths.push({ closed: false, anchors: [createAnchor(x0, y0), createAnchor(x1, y1)] });
      path.subpaths.push({
        closed: false,
        anchors: [
          createAnchor(x1 - Math.cos(ang - 0.4) * head, y1 - Math.sin(ang - 0.4) * head),
          createAnchor(x1, y1),
          createAnchor(x1 - Math.cos(ang + 0.4) * head, y1 - Math.sin(ang + 0.4) * head),
        ],
      });
      break;
    }

    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.round(sides));
      const count = kind === 'star' ? n * 2 : n;
      const rx = r.w / 2, ry = r.h / 2;
      const anchors: Anchor[] = [];
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
        const f = kind === 'star' && i % 2 === 1 ? 0.45 : 1;
        anchors.push(createAnchor(cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f));
      }
      path.subpaths.push({ closed: true, anchors });
      break;
    }
  }
  return path;
}

/** Apply a point mapping to every anchor and handle of a path, in place. */
export function transformPathPoints(path: VectorPath, map: (p: Point) => Point): void {
  for (const sp of path.subpaths) {
    for (const a of sp.anchors) {
      const pt = map({ x: a.x, y: a.y });
      const pin = map({ x: a.inX, y: a.inY });
      const pout = map({ x: a.outX, y: a.outY });
      a.x = pt.x; a.y = pt.y;
      a.inX = pin.x; a.inY = pin.y;
      a.outX = pout.x; a.outY = pout.y;
    }
  }
}

/**
 * Redraw a shape layer's cached pixels from its geometry. Called whenever the
 * path or the style changes, which is what keeps the layer re-editable.
 */
export function renderShapeLayer(layer: Layer, docW: number, docH: number): void {
  const data = layer.shape;
  if (!data) return;
  // The Move tool offsets the layer instead of the path, so fold any offset
  // into the geometry first — otherwise this redraw would snap the shape back
  // to where the anchors still sit.
  if (layer.x !== 0 || layer.y !== 0) {
    const dx = layer.x, dy = layer.y;
    transformPathPoints(data.path, (p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  const surface = createSurface(docW, docH);
  const ctx = surface.ctx;
  const style = data.style;
  const p2d = toPath2D(data.path);

  if (style.fillEnabled) {
    ctx.save();
    ctx.globalAlpha = style.fillOpacity;
    ctx.fillStyle = rgbCss(style.fill);
    ctx.fill(p2d);
    ctx.restore();
  }

  if (style.strokeEnabled && style.strokeWidth > 0) {
    const band = createSurface(docW, docH);
    const bctx = band.ctx;
    bctx.lineJoin = style.lineJoin;
    bctx.lineCap = style.lineCap;
    bctx.strokeStyle = rgbCss(style.stroke);
    if (style.dash > 0) bctx.setLineDash([style.dash, style.dash * 0.75]);
    // Inside / outside alignment is a centred stroke of double width, with the
    // unwanted half clipped away.
    bctx.lineWidth = style.strokeAlign === 'center' ? style.strokeWidth : style.strokeWidth * 2;
    bctx.stroke(p2d);
    if (style.strokeAlign === 'inside') {
      bctx.globalCompositeOperation = 'destination-in';
      bctx.fillStyle = '#fff';
      bctx.fill(p2d);
    } else if (style.strokeAlign === 'outside') {
      bctx.globalCompositeOperation = 'destination-out';
      bctx.fillStyle = '#fff';
      bctx.fill(p2d);
    }
    ctx.save();
    ctx.globalAlpha = style.strokeOpacity;
    ctx.drawImage(band.canvas, 0, 0);
    ctx.restore();
  }

  layer.surface = surface;
  layer.x = 0;
  layer.y = 0;
}

/** Short readout for the layers panel. */
export function describeShape(data: ShapeLayerData): string {
  const anchors = data.path.subpaths.reduce((n, sp) => n + sp.anchors.length, 0);
  const bits = [`${anchors} 點`];
  if (data.style.fillEnabled) bits.push('填色');
  if (data.style.strokeEnabled) bits.push(`筆畫 ${Math.round(data.style.strokeWidth)}px`);
  return bits.join(' · ');
}
