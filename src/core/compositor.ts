import type { Layer } from './types';
import { createSurface, type Surface } from './surface';
import { blendSurface } from './blend';
import { applyAdjustment } from '../filters/adjustments';
import { rgbCss } from './color';
import { maskAlpha } from './mask';
import { opaqueBounds } from './surface';
import { renderGradient } from './gradient-render';
import { resolveStops, sortStops } from './gradients';
import { cachedPatternSurface, embeddedPattern, tileInto } from './patterns';

export interface CompositeOptions {
  width: number;
  height: number;
  /** Skip this layer entirely (used while a layer is being previewed live). */
  hideLayerId?: string | null;
  /** Draw this surface instead of the layer's own pixels (live preview). */
  overrideLayerId?: string | null;
  overrideSurface?: Surface | null;
  /** When true the override replaces the layer mask rather than the pixels. */
  overrideIsMask?: boolean;
  /** Ignore layer visibility flags and render only this layer (isolate mode). */
  soloLayerId?: string | null;
}

/**
 * Paint the overlay fill for a layer, already clipped to its silhouette.
 * A pattern that has not finished decoding yet simply does not draw, which
 * is a frame of nothing rather than a wrong colour.
 */
function overlayFill(layer: Layer, src: Surface, opt: CompositeOptions): Surface | null {
  const o = layer.effects.overlay;
  const fill = createSurface(opt.width, opt.height);

  if (o.kind === 'gradient') {
    const stops = resolveStops(sortStops(o.stops), o.color, { r: 255, g: 255, b: 255 });
    // The gradient runs across the layer's own bounds, so it looks the same
    // wherever the layer sits on the canvas. `src` rather than layer.surface,
    // because a live preview replaces the pixels the user is looking at.
    const b = opaqueBounds(src) ?? { x: 0, y: 0, w: opt.width, h: opt.height };
    const cx = b.x + layer.x + b.w / 2, cy = b.y + layer.y + b.h / 2;
    const rad = (o.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Project the bounds onto the chosen direction, so the ramp spans exactly
    // the layer in that direction rather than always its longest side.
    const reach = (Math.abs(cos) * b.w + Math.abs(sin) * b.h) / 2 || 1;
    // Only a plain linear ramp has two ends. Radial, angle and diamond read
    // their first point as a centre, and a reflected ramp mirrors about it,
    // so all four start from the middle of the layer.
    const centred = o.gradientKind !== 'linear';
    renderGradient(
      fill, o.gradientKind,
      centred ? cx : cx - cos * reach,
      centred ? cy : cy - sin * reach,
      cx + cos * reach, cy + sin * reach,
      stops, false, false,
    );
  } else if (o.kind === 'pattern') {
    const pattern = embeddedPattern(o);
    const tile = pattern ? cachedPatternSurface(pattern) : null;
    if (!tile) return null;
    tileInto(fill, tile, o.scale);
  } else {
    fill.ctx.fillStyle = rgbCss(o.color);
    fill.ctx.fillRect(0, 0, fill.w, fill.h);
  }

  // No clipping here: the caller draws with source-atop, which already
  // limits the fill to the layer. Clipping as well would apply the layer's
  // alpha twice and leave a semi-transparent layer only half covered.
  return fill;
}

/** Render a single layer's pixels into a document-sized surface. */
function renderLayerPixels(layer: Layer, opt: CompositeOptions): Surface | null {
  const overriding = layer.id === opt.overrideLayerId && !!opt.overrideSurface;
  const src = overriding && !opt.overrideIsMask ? opt.overrideSurface! : layer.surface;
  const mask = overriding && opt.overrideIsMask ? opt.overrideSurface! : layer.mask;
  if (!src) return null;

  const out = createSurface(opt.width, opt.height);
  const e = layer.effects;

  const drawContent = (ctx: CanvasRenderingContext2D): void => {
    ctx.drawImage(src.canvas, layer.x, layer.y);
  };

  // The caster is drawn far off-canvas and the shadow offset compensates, so
  // only the shadow itself lands inside the visible area.
  const OFFSCREEN = opt.width + 20000;
  const castShadow = (color: string, blur: number, dx: number, dy: number, passes: number): void => {
    out.ctx.save();
    out.ctx.shadowColor = color;
    out.ctx.shadowBlur = blur;
    out.ctx.shadowOffsetX = dx + OFFSCREEN;
    out.ctx.shadowOffsetY = dy;
    for (let i = 0; i < passes; i++) {
      out.ctx.drawImage(src.canvas, layer.x - OFFSCREEN, layer.y);
    }
    out.ctx.restore();
  };

  if (e.glow.enabled) {
    const c = e.glow.color;
    castShadow(`rgba(${c.r},${c.g},${c.b},${e.glow.alpha})`, e.glow.blur, 0, 0, 3);
  }

  if (e.dropShadow.enabled) {
    const c = e.dropShadow.color;
    castShadow(
      `rgba(${c.r},${c.g},${c.b},${e.dropShadow.alpha})`,
      e.dropShadow.blur, e.dropShadow.dx, e.dropShadow.dy, 1,
    );
  }

  if (e.stroke.enabled && e.stroke.width > 0) {
    const sil = createSurface(opt.width, opt.height);
    drawContent(sil.ctx);
    sil.ctx.globalCompositeOperation = 'source-in';
    sil.ctx.fillStyle = rgbCss(e.stroke.color);
    sil.ctx.fillRect(0, 0, sil.w, sil.h);
    out.ctx.save();
    out.ctx.globalAlpha = e.stroke.alpha;
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      out.ctx.drawImage(sil.canvas, Math.cos(a) * e.stroke.width, Math.sin(a) * e.stroke.width);
    }
    out.ctx.restore();
  }

  drawContent(out.ctx);

  if (e.overlay.enabled && e.overlay.alpha > 0) {
    const fill = overlayFill(layer, src, opt);
    if (fill) {
      out.ctx.save();
      // source-atop keeps the destination alpha, so a semi-transparent layer does
      // not become more opaque just because an overlay was switched on.
      out.ctx.globalCompositeOperation = 'source-atop';
      out.ctx.globalAlpha = e.overlay.alpha;
      out.ctx.drawImage(fill.canvas, 0, 0);
      out.ctx.restore();
    }
  }

  if (mask && layer.maskEnabled) {
    out.ctx.save();
    out.ctx.globalCompositeOperation = 'destination-in';
    out.ctx.drawImage(maskAlpha(mask).canvas, 0, 0);
    out.ctx.restore();
  }
  return out;
}

/** The mask in effect for a layer, accounting for a live mask preview. */
function effectiveMask(layer: Layer, opt: CompositeOptions): Surface | null {
  if (layer.id === opt.overrideLayerId && opt.overrideIsMask && opt.overrideSurface) {
    return opt.overrideSurface;
  }
  return layer.mask;
}

/** Apply an adjustment layer to an accumulated surface, honouring its mask. */
function applyAdjustmentLayer(
  acc: Surface, layer: Layer, clipTo: Surface | null, opt: CompositeOptions,
): void {
  if (!layer.adjustment) return;
  const before = acc.ctx.getImageData(0, 0, acc.w, acc.h);
  const after = new ImageData(new Uint8ClampedArray(before.data), before.width, before.height);
  applyAdjustment(after, layer.adjustment);

  const adjusted = createSurface(acc.w, acc.h);
  adjusted.ctx.putImageData(after, 0, 0);

  const mask = effectiveMask(layer, opt);
  if (mask && layer.maskEnabled) {
    adjusted.ctx.save();
    adjusted.ctx.globalCompositeOperation = 'destination-in';
    adjusted.ctx.drawImage(maskAlpha(mask).canvas, 0, 0);
    adjusted.ctx.restore();
  }
  if (clipTo) {
    adjusted.ctx.save();
    adjusted.ctx.globalCompositeOperation = 'destination-in';
    adjusted.ctx.drawImage(clipTo.canvas, 0, 0);
    adjusted.ctx.restore();
  }

  blendSurface(acc, adjusted, layer.blend, layer.opacity);
}

/**
 * Composite a stack of layers (bottom of array = bottom of the stack).
 * `backdrop` supplies the pixels adjustment layers act on.
 */
export function compositeLayers(
  layers: Layer[], opt: CompositeOptions, backdrop?: Surface | null,
): Surface {
  const acc = createSurface(opt.width, opt.height);
  if (backdrop) acc.ctx.drawImage(backdrop.canvas, 0, 0);

  let i = 0;
  while (i < layers.length) {
    const layer = layers[i];
    // Collect the clipping group riding on top of this base layer.
    const clipped: Layer[] = [];
    let j = i + 1;
    while (j < layers.length && layers[j].clipped) { clipped.push(layers[j]); j++; }
    i = j;

    const solo = opt.soloLayerId;
    const skip = solo
      ? layer.id !== solo && !clipped.some((c) => c.id === solo)
      : !layer.visible;
    if (skip || layer.id === opt.hideLayerId) continue;

    if (layer.kind === 'adjustment') {
      applyAdjustmentLayer(acc, layer, null, opt);
      continue;
    }

    let body: Surface | null;
    if (layer.kind === 'group') {
      body = compositeLayers(layer.children ?? [], opt, null);
      const gmask = effectiveMask(layer, opt);
      if (gmask && layer.maskEnabled) {
        body.ctx.save();
        body.ctx.globalCompositeOperation = 'destination-in';
        body.ctx.drawImage(maskAlpha(gmask).canvas, 0, 0);
        body.ctx.restore();
      }
    } else {
      body = renderLayerPixels(layer, opt);
    }
    if (!body) continue;

    if (clipped.length) {
      // Alpha of the base layer acts as the clip for everything above it.
      const clipMask = createSurface(opt.width, opt.height);
      clipMask.ctx.drawImage(body.canvas, 0, 0);
      for (const c of clipped) {
        if (!c.visible && !solo) continue;
        if (c.id === opt.hideLayerId) continue;
        if (c.kind === 'adjustment') {
          applyAdjustmentLayer(body, c, clipMask, opt);
        } else {
          const cs = c.kind === 'group'
            ? compositeLayers(c.children ?? [], opt, null)
            : renderLayerPixels(c, opt);
          if (!cs) continue;
          cs.ctx.save();
          cs.ctx.globalCompositeOperation = 'destination-in';
          cs.ctx.drawImage(clipMask.canvas, 0, 0);
          cs.ctx.restore();
          blendSurface(body, cs, c.blend, c.opacity);
        }
      }
      body.ctx.save();
      body.ctx.globalCompositeOperation = 'destination-in';
      body.ctx.drawImage(clipMask.canvas, 0, 0);
      body.ctx.restore();
    }

    blendSurface(acc, body, layer.blend, layer.opacity);
  }
  return acc;
}
