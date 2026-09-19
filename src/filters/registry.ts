import {
  boxBlur, gaussianBlur, highPass, motionBlur, radialBlur, surfaceBlur, unsharpMask,
} from './blur';
import {
  addNoise, convolve, crystallize, diffuseGlow, emboss, findEdges, median, oilPaint,
  pixelate, polarCoords, ripple, sharpen, sharpenMore, spherize, twirl, vignette, wave,
} from './effects';
import type { RGB } from '../core/color';
import { clamp } from '../core/geometry';

export type ParamValue = number | boolean | string | RGB;

export interface FilterParam {
  key: string;
  label: string;
  type: 'slider' | 'checkbox' | 'select' | 'color';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  default: ParamValue;
}

export interface FilterDef {
  id: string;
  label: string;
  group: string;
  params: FilterParam[];
  apply: (img: ImageData, p: Record<string, ParamValue>) => void;
}

const n = (p: Record<string, ParamValue>, k: string): number => Number(p[k]);
const b = (p: Record<string, ParamValue>, k: string): boolean => Boolean(p[k]);
const s = (p: Record<string, ParamValue>, k: string): string => String(p[k]);
const c = (p: Record<string, ParamValue>, k: string): RGB => p[k] as RGB;

const slider = (
  key: string, label: string, min: number, max: number, def: number, step = 1, unit = '',
): FilterParam => ({ key, label, type: 'slider', min, max, step, default: def, unit });

/** Value-noise clouds, summed over octaves. */
function renderClouds(img: ImageData, scale: number, octaves: number, fg: RGB, bg: RGB): void {
  const w = img.width, h = img.height;
  const d = img.data;
  const seeds: Float32Array[] = [];
  const dims: [number, number][] = [];
  for (let o = 0; o < octaves; o++) {
    const gw = Math.max(2, Math.ceil(w / (scale / Math.pow(2, o)))) + 1;
    const gh = Math.max(2, Math.ceil(h / (scale / Math.pow(2, o)))) + 1;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    seeds.push(grid);
    dims.push([gw, gh]);
  }
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, amp = 1, norm = 0;
      for (let o = 0; o < octaves; o++) {
        const [gw, gh] = dims[o];
        const cell = scale / Math.pow(2, o);
        const gx = Math.min(gw - 2, Math.floor(x / cell));
        const gy = Math.min(gh - 2, Math.floor(y / cell));
        const fx = smooth(clamp(x / cell - gx, 0, 1));
        const fy = smooth(clamp(y / cell - gy, 0, 1));
        const g = seeds[o];
        const v00 = g[gy * gw + gx], v10 = g[gy * gw + gx + 1];
        const v01 = g[(gy + 1) * gw + gx], v11 = g[(gy + 1) * gw + gx + 1];
        const top = v00 + (v10 - v00) * fx;
        const bot = v01 + (v11 - v01) * fx;
        sum += (top + (bot - top) * fy) * amp;
        norm += amp;
        amp *= 0.5;
      }
      const t = clamp(sum / norm, 0, 1);
      const i = (y * w + x) * 4;
      d[i] = bg.r + (fg.r - bg.r) * t;
      d[i + 1] = bg.g + (fg.g - bg.g) * t;
      d[i + 2] = bg.b + (fg.b - bg.b) * t;
      d[i + 3] = 255;
    }
  }
}

export const FILTERS: FilterDef[] = [
  // ---- 模糊 ----
  {
    id: 'gaussian-blur', label: '高斯模糊', group: '模糊',
    params: [slider('radius', '強度', 0, 200, 4, 0.1, ' px')],
    apply: (img, p) => gaussianBlur(img, n(p, 'radius')),
  },
  {
    id: 'box-blur', label: '方框模糊', group: '模糊',
    params: [slider('radius', '強度', 1, 100, 4)],
    apply: (img, p) => boxBlur(img, n(p, 'radius')),
  },
  {
    id: 'motion-blur', label: '動態模糊', group: '模糊',
    params: [slider('angle', '角度', -180, 180, 0, 1, '°'), slider('distance', '間距', 1, 200, 20, 1, ' px')],
    apply: (img, p) => motionBlur(img, n(p, 'angle'), n(p, 'distance')),
  },
  {
    id: 'radial-blur', label: '放射狀模糊', group: '模糊',
    params: [
      slider('amount', '總量', 1, 100, 20),
      {
        key: 'kind', label: '方式', type: 'select', default: 'zoom',
        options: [{ value: 'zoom', label: '縮放' }, { value: 'spin', label: '迴轉' }],
      },
    ],
    apply: (img, p) => radialBlur(img, n(p, 'amount'), s(p, 'kind') as 'zoom' | 'spin'),
  },
  {
    id: 'surface-blur', label: '表面模糊', group: '模糊',
    params: [slider('radius', '強度', 1, 20, 5), slider('threshold', '臨界值', 1, 100, 15)],
    apply: (img, p) => surfaceBlur(img, n(p, 'radius'), n(p, 'threshold')),
  },

  // ---- 銳利化 ----
  {
    id: 'sharpen', label: '銳利化', group: '銳利化',
    params: [], apply: (img) => sharpen(img),
  },
  {
    id: 'sharpen-more', label: '更銳利化', group: '銳利化',
    params: [], apply: (img) => sharpenMore(img),
  },
  {
    id: 'unsharp-mask', label: '遮色片銳利化調整', group: '銳利化',
    params: [
      slider('amount', '總量', 1, 500, 80, 1, '%'),
      slider('radius', '強度', 0.1, 50, 1.5, 0.1, ' px'),
      slider('threshold', '臨界值', 0, 255, 0),
    ],
    apply: (img, p) => unsharpMask(img, n(p, 'amount'), n(p, 'radius'), n(p, 'threshold')),
  },
  {
    id: 'high-pass', label: '高反差保留', group: '銳利化',
    params: [slider('radius', '強度', 0.1, 100, 3, 0.1, ' px')],
    apply: (img, p) => highPass(img, n(p, 'radius')),
  },

  // ---- 扭曲 ----
  {
    id: 'twirl', label: '扭轉', group: '扭曲',
    params: [slider('angle', '角度', -720, 720, 120, 1, '°')],
    apply: (img, p) => twirl(img, n(p, 'angle')),
  },
  {
    id: 'ripple', label: '漣漪', group: '扭曲',
    params: [slider('amount', '總量', 1, 200, 40), slider('wavelength', '波長', 2, 200, 30)],
    apply: (img, p) => ripple(img, n(p, 'amount'), n(p, 'wavelength')),
  },
  {
    id: 'wave', label: '波浪', group: '扭曲',
    params: [slider('amplitude', '振幅', 1, 200, 20), slider('wavelength', '波長', 2, 300, 60)],
    apply: (img, p) => wave(img, n(p, 'amplitude'), n(p, 'wavelength')),
  },
  {
    id: 'spherize', label: '魚眼', group: '扭曲',
    params: [slider('amount', '總量', -95, 95, 50, 1, '%')],
    apply: (img, p) => spherize(img, n(p, 'amount')),
  },
  {
    id: 'polar', label: '旋轉效果', group: '扭曲',
    params: [{
      key: 'mode', label: '方式', type: 'select', default: 'to',
      options: [{ value: 'to', label: '平面座標到旋轉效果' }, { value: 'from', label: '旋轉效果到平面座標' }],
    }],
    apply: (img, p) => polarCoords(img, s(p, 'mode') === 'to'),
  },

  // ---- 風格化 ----
  {
    id: 'emboss', label: '浮雕', group: '風格化',
    params: [
      slider('angle', '角度', -180, 180, 135, 1, '°'),
      slider('height', '高度', 1, 20, 3),
      slider('amount', '總量', 1, 500, 100, 1, '%'),
    ],
    apply: (img, p) => emboss(img, n(p, 'angle'), n(p, 'height'), n(p, 'amount')),
  },
  {
    id: 'find-edges', label: '尋找邊緣', group: '風格化',
    params: [], apply: (img) => findEdges(img),
  },
  {
    id: 'oil-paint', label: '油畫', group: '風格化',
    params: [slider('radius', '筆刷大小', 1, 10, 3), slider('levels', '色階', 2, 64, 20)],
    apply: (img, p) => oilPaint(img, n(p, 'radius'), n(p, 'levels')),
  },
  {
    id: 'diffuse-glow', label: '擴散光暈', group: '風格化',
    params: [
      slider('radius', '柔和度', 1, 60, 8),
      slider('amount', '總量', 0, 100, 40, 1, '%'),
      { key: 'color', label: '光暈顏色', type: 'color', default: { r: 255, g: 255, b: 255 } },
    ],
    apply: (img, p) => diffuseGlow(img, n(p, 'radius'), n(p, 'amount'), c(p, 'color')),
  },
  {
    id: 'vignette', label: '暈映', group: '風格化',
    params: [
      slider('amount', '總量', 0, 100, 45, 1, '%'),
      slider('midpoint', '中點', 1, 100, 55),
      slider('roundness', '圓度', 0.5, 4, 2, 0.1),
    ],
    apply: (img, p) => vignette(img, n(p, 'amount'), n(p, 'midpoint'), n(p, 'roundness')),
  },
  {
    id: 'custom-convolve', label: '自訂卷積', group: '風格化',
    params: [
      slider('k0', '左上', -10, 10, 0), slider('k1', '上', -10, 10, -1), slider('k2', '右上', -10, 10, 0),
      slider('k3', '左', -10, 10, -1), slider('k4', '中心', -10, 20, 5), slider('k5', '右', -10, 10, -1),
      slider('k6', '左下', -10, 10, 0), slider('k7', '下', -10, 10, -1), slider('k8', '右下', -10, 10, 0),
      slider('bias', '位移', -128, 128, 0),
    ],
    apply: (img, p) => {
      const k = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => n(p, `k${i}`));
      convolve(img, k, undefined, n(p, 'bias'));
    },
  },

  // ---- 雜訊 ----
  {
    id: 'add-noise', label: '增加雜訊', group: '雜訊',
    params: [
      slider('amount', '總量', 0.1, 100, 12, 0.1, '%'),
      { key: 'mono', label: '單色的', type: 'checkbox', default: false },
      { key: 'gaussian', label: '高斯分佈', type: 'checkbox', default: true },
    ],
    apply: (img, p) => addNoise(img, n(p, 'amount'), b(p, 'mono'), b(p, 'gaussian')),
  },
  {
    id: 'median', label: '中和 (中間值)', group: '雜訊',
    params: [slider('radius', '強度', 1, 8, 2)],
    apply: (img, p) => median(img, n(p, 'radius')),
  },

  // ---- 像素 ----
  {
    id: 'pixelate', label: '馬賽克', group: '像素',
    params: [slider('cell', '單元格大小', 2, 100, 10)],
    apply: (img, p) => pixelate(img, n(p, 'cell')),
  },
  {
    id: 'crystallize', label: '結晶化', group: '像素',
    params: [slider('cell', '單元格大小', 3, 100, 12)],
    apply: (img, p) => crystallize(img, n(p, 'cell')),
  },

  // ---- 演算 ----
  {
    id: 'clouds', label: '雲彩', group: '演算',
    params: [
      slider('scale', '尺度', 8, 512, 128),
      slider('octaves', '細節', 1, 8, 5),
      { key: 'fg', label: '前景色', type: 'color', default: { r: 255, g: 255, b: 255 } },
      { key: 'bg', label: '背景色', type: 'color', default: { r: 25, g: 60, b: 120 } },
    ],
    apply: (img, p) => renderClouds(img, n(p, 'scale'), Math.round(n(p, 'octaves')), c(p, 'fg'), c(p, 'bg')),
  },
];

export const FILTER_GROUPS = (): { group: string; items: FilterDef[] }[] => {
  const map = new Map<string, FilterDef[]>();
  for (const f of FILTERS) {
    const arr = map.get(f.group);
    if (arr) arr.push(f); else map.set(f.group, [f]);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
};

export const getFilter = (id: string): FilterDef | undefined => FILTERS.find((f) => f.id === id);

export function defaultParams(def: FilterDef): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of def.params) {
    out[p.key] = typeof p.default === 'object' ? { ...(p.default as RGB) } : p.default;
  }
  return out;
}
