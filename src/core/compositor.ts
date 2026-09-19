import type { Layer } from './types';
import { cloneSurface, createSurface, type Surface } from './surface';
import { blendSurface } from './blend';
import { applyBlendIf, blendIfMask } from './blend-range';
import { applyAdjustment } from '../filters/adjustments';
import { gaussianBlur } from '../filters/blur';
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

  // Uncut: the caller cuts it to the layer's silhouette, and doing it here
  // as well would apply the layer's alpha twice and leave a semi-transparent
  // layer only half covered.
  return fill;
}

const clamp01 = (v: number): number => (v >= 1 ? 1 : v <= 0 ? 0 : v);

/** The layer's silhouette: its own alpha, with the colour thrown away. */
function silhouette(
  opt: CompositeOptions, drawContent: (ctx: CanvasRenderingContext2D) => void,
): Surface {
  const s = createSurface(opt.width, opt.height);
  drawContent(s.ctx);
  return s;
}

/**
 * Light and shade along the edges, from a height map made by blurring the
 * silhouette's alpha: where that surface slopes towards the light it gets a
 * highlight, where it slopes away it gets a shadow.
 */
function bevelShading(
  layer: Layer, opt: CompositeOptions, sil: Surface,
): Surface | null {
  const b = layer.effects.bevel;
  const size = Math.max(1, Math.round(b.size));
  const { width: w, height: h } = opt;

  const height = sil.ctx.getImageData(0, 0, w, h);
  gaussianBlur(height, size);
  const alpha = new Float32Array(w * h);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = height.data[p] / 255;

  const rad = (b.angle * Math.PI) / 180;
  // The surface normal is the negated height gradient, and screen y grows
  // downwards, so both signs flip out of the naive (cos, -sin) light vector.
  const lx = -Math.cos(rad), ly = Math.sin(rad);
  const gain = (b.depth / 100) * (255 / Math.max(1, size)) * 2;

  const out = createSurface(w, h);
  const img = out.ctx.createImageData(w, h);
  const solid = sil.ctx.getImageData(0, 0, w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = alpha[y * w + Math.min(w - 1, x + 1)] - alpha[y * w + Math.max(0, x - 1)];
      const gy = alpha[Math.min(h - 1, y + 1) * w + x] - alpha[Math.max(0, y - 1) * w + x];
      const lit = (gx * lx + gy * ly) * gain;
      if (lit === 0) continue;
      // Emboss lights the outside of the edge too; a plain bevel is clipped
      // to the layer, so only the inner slope shows.
      const reach = b.emboss ? Math.max(alpha[i], solid.data[i * 4 + 3] / 255) : solid.data[i * 4 + 3] / 255;
      if (reach <= 0) continue;
      const c = lit > 0 ? b.highlight : b.shadow;
      const p = i * 4;
      img.data[p] = c.r;
      img.data[p + 1] = c.g;
      img.data[p + 2] = c.b;
      img.data[p + 3] = Math.min(255, Math.abs(lit) * 255) * reach;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return out;
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
    const edge = createSurface(opt.width, opt.height);
    drawContent(edge.ctx);
    edge.ctx.globalCompositeOperation = 'source-in';
    edge.ctx.fillStyle = rgbCss(e.stroke.color);
    edge.ctx.fillRect(0, 0, edge.w, edge.h);
    out.ctx.save();
    out.ctx.globalAlpha = e.stroke.alpha;
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      out.ctx.drawImage(edge.canvas, Math.cos(a) * e.stroke.width, Math.sin(a) * e.stroke.width);
    }
    out.ctx.restore();
  }

  // Everything inside the layer's own shape is built in one surface and laid
  // down as a unit. The effects are composited source-atop, so they colour
  // the shape without ever widening it; the fill opacity then thins that
  // whole interior on the way out.
  const inside = createSurface(opt.width, opt.height);
  drawContent(inside.ctx);
  /** Emboss reaches past the edge, so it is held back until the clip is done. */
  let spill: { surface: Surface; alpha: number } | null = null;
  /** How strongly the effects paint the interior, whatever the fill does. */
  let effectStrength = 0;
  const counts = (on: boolean, alpha: number): void => {
    if (on && alpha > effectStrength) effectStrength = alpha;
  };

  if (e.innerShadow.enabled || e.innerGlow.enabled || e.bevel.enabled) {
    const sil = silhouette(opt, drawContent);

    // An inner shadow is the shadow cast by everything *outside* the shape:
    // fill the canvas, knock the shape out of it, and let that cast inwards.
    const castInward = (
      color: string, blur: number, dx: number, dy: number, passes: number,
    ): void => {
      const hole = createSurface(opt.width, opt.height);
      hole.ctx.fillStyle = '#000';
      hole.ctx.fillRect(0, 0, hole.w, hole.h);
      hole.ctx.globalCompositeOperation = 'destination-out';
      hole.ctx.drawImage(sil.canvas, 0, 0);

      const shade = createSurface(opt.width, opt.height);
      shade.ctx.save();
      shade.ctx.shadowColor = color;
      shade.ctx.shadowBlur = blur;
      shade.ctx.shadowOffsetX = dx + OFFSCREEN;
      shade.ctx.shadowOffsetY = dy;
      for (let i = 0; i < passes; i++) shade.ctx.drawImage(hole.canvas, -OFFSCREEN, 0);
      shade.ctx.restore();
      // Only the part that falls inside the shape counts.
      shade.ctx.globalCompositeOperation = 'destination-in';
      shade.ctx.drawImage(sil.canvas, 0, 0);

      inside.ctx.save();
      inside.ctx.globalCompositeOperation = 'source-atop';
      inside.ctx.drawImage(shade.canvas, 0, 0);
      inside.ctx.restore();
    };

    if (e.innerShadow.enabled) {
      const c = e.innerShadow.color;
      castInward(
        `rgba(${c.r},${c.g},${c.b},${e.innerShadow.alpha})`,
        e.innerShadow.blur, e.innerShadow.dx, e.innerShadow.dy, 1,
      );
      counts(true, e.innerShadow.alpha);
    }
    if (e.innerGlow.enabled) {
      const c = e.innerGlow.color;
      castInward(`rgba(${c.r},${c.g},${c.b},${e.innerGlow.alpha})`, e.innerGlow.blur, 0, 0, 3);
      counts(true, e.innerGlow.alpha);
    }
    if (e.bevel.enabled && e.bevel.alpha > 0) {
      const shading = bevelShading(layer, opt, sil);
      if (shading) {
        // Emboss spills past the edge, so it draws over everything; a plain
        // bevel stays inside the layer.
        if (e.bevel.emboss) spill = { surface: shading, alpha: e.bevel.alpha };
        else {
          inside.ctx.save();
          inside.ctx.globalCompositeOperation = 'source-atop';
          inside.ctx.globalAlpha = e.bevel.alpha;
          inside.ctx.drawImage(shading.canvas, 0, 0);
          inside.ctx.restore();
          counts(true, e.bevel.alpha);
        }
      }
    }
  }

  if (e.overlay.enabled && e.overlay.alpha > 0) {
    const fill = overlayFill(layer, src, opt);
    if (fill) {
      inside.ctx.save();
      // source-atop keeps the destination alpha, so a semi-transparent layer
      // does not become more opaque just because an overlay was switched on.
      inside.ctx.globalCompositeOperation = 'source-atop';
      inside.ctx.globalAlpha = e.overlay.alpha;
      inside.ctx.drawImage(fill.canvas, 0, 0);
      inside.ctx.restore();
      counts(true, e.overlay.alpha);
    }
  }

  // Fill opacity thins the layer's own pixels but not its styling, so an
  // effect painted across the shape holds the interior up on its own. That
  // is what leaves a colour overlay visible at 0% fill. The strength is per
  // layer rather than per pixel, so a partly transparent effect over faded
  // pixels lands between the two rather than exactly on Photoshop's result.
  out.ctx.save();
  out.ctx.globalAlpha = Math.max(clamp01(layer.fill), effectStrength);
  out.ctx.drawImage(inside.canvas, 0, 0);
  out.ctx.restore();

  if (spill) {
    out.ctx.save();
    out.ctx.globalAlpha = spill.alpha;
    out.ctx.drawImage(spill.surface.canvas, 0, 0);
    out.ctx.restore();
  }

  if (mask && layer.maskEnabled) {
    out.ctx.save();
    out.ctx.globalCompositeOperation = 'destination-in';
    out.ctx.drawImage(maskAlpha(mask).canvas, 0, 0);
    out.ctx.restore();
  }
  return out;
}

/**
 * How strongly a pass-through group applies, as a white surface whose alpha
 * combines its opacity, its mask and its blend ranges. Null means "all of it",
 * which the caller can take as a plain replacement.
 */
function groupWeight(
  layer: Layer, gmask: Surface | null, merged: Surface, acc: Surface,
  opt: CompositeOptions,
): Surface | null {
  const alpha = layer.opacity * clamp01(layer.fill);
  const masked = !!gmask && layer.maskEnabled;
  const ranges = blendIfMask(merged, acc, layer.blendIf);
  if (alpha >= 1 && !masked && !ranges) return null;

  const weight = createSurface(opt.width, opt.height);
  weight.ctx.globalAlpha = alpha;
  weight.ctx.fillStyle = '#ffffff';
  weight.ctx.fillRect(0, 0, weight.w, weight.h);
  weight.ctx.globalAlpha = 1;
  weight.ctx.globalCompositeOperation = 'destination-in';
  if (gmask && layer.maskEnabled) weight.ctx.drawImage(maskAlpha(gmask).canvas, 0, 0);
  if (ranges) weight.ctx.drawImage(ranges.canvas, 0, 0);
  return weight;
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

  applyBlendIf(adjusted, acc, layer.blendIf);
  // An adjustment has no pixels either, so fill doubles as opacity.
  blendSurface(acc, adjusted, layer.blend, layer.opacity * clamp01(layer.fill));
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

    // Hidden members draw nothing, so they must not change how the base
    // layer is treated either.
    const drawnClipped = clipped.filter(
      (c) => (solo ? true : c.visible) && c.id !== opt.hideLayerId,
    );

    let body: Surface | null;
    if (layer.kind === 'group') {
      const gmask = effectiveMask(layer, opt);
      // Pass through: the children composite straight onto what is already
      // underneath, so an adjustment inside the group reaches the layers
      // below it. A clipping group riding on top needs a shape to clip to,
      // so that case stays isolated.
      if (layer.blend === 'pass-through' && !drawnClipped.length) {
        const merged = compositeLayers(layer.children ?? [], opt, acc);
        // The result already contains the backdrop, so it *replaces* what is
        // underneath. Drawing it over instead would composite the backdrop
        // with itself and thicken anything semi-transparent.
        const weight = groupWeight(layer, gmask, merged, acc, opt);
        if (!weight) {
          acc.ctx.save();
          acc.ctx.globalCompositeOperation = 'copy';
          acc.ctx.drawImage(merged.canvas, 0, 0);
          acc.ctx.restore();
          continue;
        }
        // out = backdrop x (1 - weight) + merged x weight, which is a proper
        // cross-fade between the document with the group and without it.
        const keep = cloneSurface(acc);
        keep.ctx.save();
        keep.ctx.globalCompositeOperation = 'destination-out';
        keep.ctx.drawImage(weight.canvas, 0, 0);
        keep.ctx.restore();
        merged.ctx.save();
        merged.ctx.globalCompositeOperation = 'destination-in';
        merged.ctx.drawImage(weight.canvas, 0, 0);
        merged.ctx.restore();
        acc.ctx.save();
        acc.ctx.globalCompositeOperation = 'copy';
        acc.ctx.drawImage(keep.canvas, 0, 0);
        acc.ctx.globalCompositeOperation = 'lighter';
        acc.ctx.drawImage(merged.canvas, 0, 0);
        acc.ctx.restore();
        continue;
      }
      body = compositeLayers(layer.children ?? [], opt, null);
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

    if (drawnClipped.length) {
      // Alpha of the base layer acts as the clip for everything above it.
      const clipMask = createSurface(opt.width, opt.height);
      clipMask.ctx.drawImage(body.canvas, 0, 0);
      for (const c of drawnClipped) {
        if (c.kind === 'adjustment') {
          applyAdjustmentLayer(body, c, clipMask, opt);
        } else {
          // A clipped member is masked by the base layer, so even a
          // pass-through group has to be resolved on its own here.
          const cs = c.kind === 'group'
            ? compositeLayers(c.children ?? [], opt, null)
            : renderLayerPixels(c, opt);
          if (!cs) continue;
          cs.ctx.save();
          cs.ctx.globalCompositeOperation = 'destination-in';
          cs.ctx.drawImage(clipMask.canvas, 0, 0);
          cs.ctx.restore();
          applyBlendIf(cs, body, c.blendIf);
          blendSurface(body, cs, c.blend, c.opacity);
        }
      }
      body.ctx.save();
      body.ctx.globalCompositeOperation = 'destination-in';
      body.ctx.drawImage(clipMask.canvas, 0, 0);
      body.ctx.restore();
    }

    // Blend ranges are judged against what is already underneath, so they
    // belong here rather than inside the layer's own render. A group has no
    // pixels of its own for the fill to thin, so there it acts as a second
    // opacity, which is what Photoshop does too.
    applyBlendIf(body, acc, layer.blendIf);
    const alpha = layer.kind === 'group'
      ? layer.opacity * clamp01(layer.fill)
      : layer.opacity;
    blendSurface(acc, body, layer.blend, alpha);
  }
  return acc;
}
