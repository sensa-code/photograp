import { NATIVE_BLEND, type BlendMode } from './types';
import type { Surface } from './surface';

type BlendFn = (cb: number, cs: number) => number;

const colorDodge: BlendFn = (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs)));
const colorBurn: BlendFn = (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs));
const linearLight: BlendFn = (cb, cs) => cb + 2 * cs - 1;

/** Separable blend functions the 2D context does not provide. */
const FNS: Partial<Record<BlendMode, BlendFn>> = {
  'linear-burn': (cb, cs) => cb + cs - 1,
  'vivid-light': (cb, cs) => (cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * (cs - 0.5))),
  'linear-light': linearLight,
  'pin-light': (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)),
  'hard-mix': (cb, cs) => (linearLight(cb, cs) < 0.5 ? 0 : 1),
  subtract: (cb, cs) => cb - cs,
  divide: (cb, cs) => (cs <= 0 ? 1 : Math.min(1, cb / cs)),
};

export const isNativeBlend = (mode: BlendMode): boolean => NATIVE_BLEND[mode] !== undefined;

/**
 * Composite `src` over `dst` in place using a blend mode the canvas cannot do
 * natively. Both buffers are straight (non-premultiplied) RGBA.
 */
export function blendImageData(
  dst: ImageData, src: ImageData, mode: BlendMode, opacity: number,
): void {
  const d = dst.data, s = src.data;
  const fn = FNS[mode];

  if (mode === 'dissolve') {
    for (let i = 0; i < d.length; i += 4) {
      const as = (s[i + 3] / 255) * opacity;
      if (as > 0 && Math.random() < as) {
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255;
      }
    }
    return;
  }
  if (!fn) return;

  for (let i = 0; i < d.length; i += 4) {
    const as = (s[i + 3] / 255) * opacity;
    if (as === 0) continue;
    const ab = d[i + 3] / 255;
    const ao = as + ab * (1 - as);
    if (ao === 0) { d[i + 3] = 0; continue; }
    for (let k = 0; k < 3; k++) {
      const cs = s[i + k] / 255;
      const cb = d[i + k] / 255;
      const bl = Math.min(1, Math.max(0, fn(cb, cs)));
      const co = as * (1 - ab) * cs + as * ab * bl + (1 - as) * ab * cb;
      d[i + k] = Math.round(Math.min(1, Math.max(0, co / ao)) * 255);
    }
    d[i + 3] = Math.round(ao * 255);
  }
}

/** Composite one surface onto another honouring blend mode and opacity. */
export function blendSurface(
  dst: Surface, src: Surface, mode: BlendMode, opacity: number,
): void {
  if (opacity <= 0) return;
  const native = NATIVE_BLEND[mode];
  if (native) {
    dst.ctx.save();
    dst.ctx.globalAlpha = opacity;
    dst.ctx.globalCompositeOperation = native;
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.restore();
    return;
  }
  const dd = dst.ctx.getImageData(0, 0, dst.w, dst.h);
  const sd = src.ctx.getImageData(0, 0, src.w, src.h);
  blendImageData(dd, sd, mode, opacity);
  dst.ctx.putImageData(dd, 0, 0);
}

export const BLEND_GROUPS: { label: string; modes: BlendMode[] }[] = [
  { label: '一般', modes: ['normal', 'dissolve'] },
  { label: '變暗', modes: ['darken', 'multiply', 'color-burn', 'linear-burn'] },
  { label: '變亮', modes: ['lighten', 'screen', 'color-dodge', 'linear-dodge'] },
  {
    label: '對比',
    modes: ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'],
  },
  { label: '差異', modes: ['difference', 'exclusion', 'subtract', 'divide'] },
  { label: '色彩', modes: ['hue', 'saturation', 'color', 'luminosity'] },
];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: '正常',
  dissolve: '溶解',
  darken: '變暗',
  multiply: '色彩增值',
  'color-burn': '加深顏色',
  'linear-burn': '線性加深',
  lighten: '變亮',
  screen: '濾色',
  'color-dodge': '加亮顏色',
  'linear-dodge': '線性加亮',
  overlay: '覆蓋',
  'soft-light': '柔光',
  'hard-light': '實光',
  'vivid-light': '強烈光',
  'linear-light': '線性光',
  'pin-light': '小光源',
  'hard-mix': '實色疊印',
  difference: '差異化',
  exclusion: '排除',
  subtract: '減去',
  divide: '分割',
  hue: '色相',
  saturation: '飽和度',
  color: '顏色',
  luminosity: '明度',
};
