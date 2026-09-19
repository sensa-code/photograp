import type { BlendBand, BlendIf, BlendRangeChannel } from './types';
import { createSurface, type Surface } from './surface';
import { luminance } from './color';

/** Wide open: nothing is hidden at either end. */
export const fullBand = (): BlendBand => ({ b0: 0, b1: 0, w0: 255, w1: 255 });

export const defaultBlendIf = (): BlendIf => ({
  channel: 'gray',
  self: fullBand(),
  under: fullBand(),
});

const bandIsOpen = (b: BlendBand): boolean => b.b0 <= 0 && b.b1 <= 0 && b.w0 >= 255 && b.w1 >= 255;

/** True when the ranges hide nothing, so the whole pass can be skipped. */
export const blendIfIsDefault = (r: BlendIf | undefined): boolean =>
  !r || (bandIsOpen(r.self) && bandIsOpen(r.under));

/**
 * How much of a pixel survives a band. Values below the black slider and
 * above the white slider are dropped; between each pair of handles the layer
 * fades, which is what stops a cutoff from leaving a jagged edge.
 */
export function bandFactor(v: number, b: BlendBand): number {
  if (v < b.b0) return 0;
  if (v < b.b1) return (v - b.b0) / (b.b1 - b.b0);
  if (v <= b.w0) return 1;
  if (v < b.w1) return 1 - (v - b.w0) / (b.w1 - b.w0);
  // Anything still here is past the white handle.
  return 0;
}

/** Sort the four handles so a band always reads black → white. */
export function normalizeBand(b: Partial<BlendBand> | undefined): BlendBand {
  const v = [b?.b0 ?? 0, b?.b1 ?? 0, b?.w0 ?? 255, b?.w1 ?? 255]
    .map((n) => Math.round(Math.min(255, Math.max(0, Number(n) || 0))))
    .sort((p, q) => p - q);
  return { b0: v[0], b1: v[1], w0: v[2], w1: v[3] };
}

export function normalizeBlendIf(r: Partial<BlendIf> | undefined): BlendIf {
  const channel = r?.channel;
  return {
    channel: channel === 'r' || channel === 'g' || channel === 'b' ? channel : 'gray',
    self: normalizeBand(r?.self),
    under: normalizeBand(r?.under),
  };
}

export const cloneBlendIf = (r: BlendIf): BlendIf =>
  ({ channel: r.channel, self: { ...r.self }, under: { ...r.under } });

const channelValue = (
  d: Uint8ClampedArray, i: number, channel: BlendRangeChannel,
): number => {
  if (channel === 'r') return d[i];
  if (channel === 'g') return d[i + 1];
  if (channel === 'b') return d[i + 2];
  return luminance(d[i], d[i + 1], d[i + 2]);
};

/**
 * How much of each pixel the blend ranges let through, judging `self` on the
 * layer's own pixels and `under` on the pixels beneath it. Returns null when
 * the ranges hide nothing at all.
 */
export function blendIfFactors(
  self: Surface, under: Surface, r: BlendIf,
): Float32Array | null {
  if (blendIfIsDefault(r)) return null;
  const top = self.ctx.getImageData(0, 0, self.w, self.h).data;
  const back = under.ctx.getImageData(0, 0, under.w, under.h).data;
  const out = new Float32Array(self.w * self.h);
  for (let n = 0, i = 0; n < out.length; n++, i += 4) {
    let f = bandFactor(channelValue(top, i, r.channel), r.self);
    if (f > 0) {
      // A transparent backdrop has no colour to compare against, so it lets
      // the layer through rather than judging it against black.
      const weight = back[i + 3] / 255;
      f *= 1 + (bandFactor(channelValue(back, i, r.channel), r.under) - 1) * weight;
    }
    out[n] = f < 0 ? 0 : f > 1 ? 1 : f;
  }
  return out;
}

/**
 * Thin `body`'s alpha where the blend ranges say the layer should give way,
 * reading `under` as the pixels already composited beneath it. Mutates `body`,
 * which is a scratch surface the compositor is about to blend and discard.
 */
export function applyBlendIf(body: Surface, under: Surface, r: BlendIf): void {
  const factors = blendIfFactors(body, under, r);
  if (!factors) return;
  const img = body.ctx.getImageData(0, 0, body.w, body.h);
  const d = img.data;
  for (let n = 0, i = 3; n < factors.length; n++, i += 4) {
    if (d[i] === 0 || factors[n] >= 1) continue;
    d[i] = Math.round(d[i] * factors[n]);
  }
  body.ctx.putImageData(img, 0, 0);
}

/** The same factors as a white surface whose alpha carries them. */
export function blendIfMask(self: Surface, under: Surface, r: BlendIf): Surface | null {
  const factors = blendIfFactors(self, under, r);
  if (!factors) return null;
  const out = createSurface(self.w, self.h);
  const img = out.ctx.createImageData(self.w, self.h);
  for (let n = 0, i = 0; n < factors.length; n++, i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(factors[n] * 255);
  }
  out.ctx.putImageData(img, 0, 0);
  return out;
}

/** One line for the layers panel, empty when the ranges do nothing. */
export function describeBlendIf(r: BlendIf | undefined): string {
  if (blendIfIsDefault(r) || !r) return '';
  const names: Record<BlendRangeChannel, string> = {
    gray: '灰階', r: '紅', g: '綠', b: '藍',
  };
  const part = (label: string, b: BlendBand): string => {
    if (bandIsOpen(b)) return '';
    return `${label} ${b.b0}/${b.b1}–${b.w0}/${b.w1}`;
  };
  return [names[r.channel], part('本身', r.self), part('下層', r.under)]
    .filter(Boolean).join(' ');
}
