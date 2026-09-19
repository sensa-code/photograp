import { createSurface, type Surface } from './surface';
import { uid } from './layer';
import { luminance } from './color';

export type ColorChannel = 'r' | 'g' | 'b';

/** A stored 8-bit channel, used for saved selections and spot masks. */
export interface AlphaChannel {
  id: string;
  name: string;
  /** Opaque greyscale, same convention as layer masks. */
  surface: Surface;
  /** Overlay colour used when the channel is shown with the composite. */
  color: { r: number; g: number; b: number };
  opacity: number;
  visible: boolean;
}

export function createAlphaChannel(
  name: string, w: number, h: number, coverage?: Uint8Array | null,
): AlphaChannel {
  const surface = createSurface(w, h);
  const img = surface.ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const v = coverage ? coverage[i] : 0;
    d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
  }
  surface.ctx.putImageData(img, 0, 0);
  return {
    id: uid('ch'),
    name,
    surface,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.5,
    visible: false,
  };
}

/** Pull one colour channel out of a composite as an opaque greyscale image. */
export function extractChannel(src: Surface, channel: ColorChannel | 'luma'): Surface {
  const out = createSurface(src.w, src.h);
  const s = src.ctx.getImageData(0, 0, src.w, src.h);
  const d = out.ctx.createImageData(src.w, src.h);
  const offset = channel === 'r' ? 0 : channel === 'g' ? 1 : 2;
  for (let i = 0; i < s.data.length; i += 4) {
    const a = s.data[i + 3] / 255;
    const v = channel === 'luma'
      ? luminance(s.data[i], s.data[i + 1], s.data[i + 2]) * a
      : s.data[i + offset] * a;
    d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v; d.data[i + 3] = 255;
  }
  out.ctx.putImageData(d, 0, 0);
  return out;
}

/** Read a channel surface back as an 8-bit coverage buffer. */
export function channelCoverage(surface: Surface): Uint8Array {
  const d = surface.ctx.getImageData(0, 0, surface.w, surface.h).data;
  const out = new Uint8Array(surface.w * surface.h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (d[p] * d[p + 3]) / 255;
  return out;
}

/** Write a coverage buffer into an existing channel surface. */
export function setChannelCoverage(channel: AlphaChannel, coverage: Uint8Array | null): void {
  const { w, h } = channel.surface;
  const img = channel.surface.ctx.createImageData(w, h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const v = coverage ? coverage[i] : 0;
    img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  channel.surface.ctx.putImageData(img, 0, 0);
}

/**
 * What the canvas should show. `rgb` is the normal composite; a colour channel
 * shows it as greyscale; an alpha channel id shows that stored channel.
 */
export type ChannelView = 'rgb' | ColorChannel | string;

export function renderChannelView(
  composite: Surface, view: ChannelView, channels: AlphaChannel[],
): Surface {
  if (view === 'rgb') {
    const visible = channels.filter((c) => c.visible);
    if (!visible.length) return composite;
    // Quick-mask style overlay for visible alpha channels.
    const out = createSurface(composite.w, composite.h);
    out.ctx.drawImage(composite.canvas, 0, 0);
    for (const ch of visible) {
      const tint = createSurface(composite.w, composite.h);
      const src = ch.surface.ctx.getImageData(0, 0, ch.surface.w, ch.surface.h);
      const img = tint.ctx.createImageData(composite.w, composite.h);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = ch.color.r;
        img.data[i + 1] = ch.color.g;
        img.data[i + 2] = ch.color.b;
        img.data[i + 3] = src.data[i];
      }
      tint.ctx.putImageData(img, 0, 0);
      out.ctx.save();
      out.ctx.globalAlpha = ch.opacity;
      out.ctx.drawImage(tint.canvas, 0, 0);
      out.ctx.restore();
    }
    return out;
  }
  if (view === 'r' || view === 'g' || view === 'b') {
    return extractChannel(composite, view);
  }
  const ch = channels.find((c) => c.id === view);
  return ch ? ch.surface : composite;
}

export const CHANNEL_LABELS: Record<string, string> = {
  rgb: 'RGB',
  r: '紅',
  g: '綠',
  b: '藍',
};
