import type {
  AdjustmentSpec, ColorFamily, CurveChannel, GradientStop,
} from '../core/types';
import { hslToRgb, luminance, rgbToHsl, type RGB } from '../core/color';
import { clamp } from '../core/geometry';

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Identity 256-entry lookup table. */
function identityLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

function applyLuts(
  img: ImageData, r: Uint8ClampedArray, g: Uint8ClampedArray, b: Uint8ClampedArray,
): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

/**
 * Monotone cubic Hermite interpolation (Fritsch-Carlson) so curves never
 * overshoot between control points.
 */
export function curveLut(points: [number, number][]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return identityLut();
  if (pts.length === 1) { lut.fill(clamp255(pts[0][1])); return lut; }

  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx: number[] = [], dy: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, xs[i + 1] - xs[i]));
    dy.push(ys[i + 1] - ys[i]);
    slope.push(dy[i] / dx[i]);
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else m[i] = (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { lut[x] = clamp255(ys[0]); continue; }
    if (x >= xs[n - 1]) { lut[x] = clamp255(ys[n - 1]); continue; }
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = dx[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[x] = clamp255(h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1]);
  }
  return lut;
}

function levelsLut(
  inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(1, inWhite - inBlack);
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < 256; i++) {
    let v = (i - inBlack) / span;
    v = clamp(v, 0, 1);
    v = Math.pow(v, invGamma);
    lut[i] = clamp255(outBlack + v * (outWhite - outBlack));
  }
  return lut;
}

function gradientLut(stops: GradientStop[]): RGB[] {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  const out: RGB[] = new Array(256);
  if (sorted.length === 0) {
    for (let i = 0; i < 256; i++) out[i] = { r: i, g: i, b: i };
    return out;
  }
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = sorted[0], b = sorted[sorted.length - 1];
    if (t <= a.pos) { out[i] = { ...a.color }; continue; }
    if (t >= b.pos) { out[i] = { ...b.color }; continue; }
    for (let k = 0; k < sorted.length - 1; k++) {
      if (t >= sorted[k].pos && t <= sorted[k + 1].pos) { a = sorted[k]; b = sorted[k + 1]; break; }
    }
    const f = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
    out[i] = {
      r: a.color.r + (b.color.r - a.color.r) * f,
      g: a.color.g + (b.color.g - a.color.g) * f,
      b: a.color.b + (b.color.b - a.color.b) * f,
    };
  }
  return out;
}

/** Shadow / midtone / highlight weights used by Color Balance. */
function toneWeights(v: number): [number, number, number] {
  const t = v / 255;
  const shadow = Math.max(0, 1 - t * 2);
  const highlight = Math.max(0, t * 2 - 1);
  const mid = 1 - shadow - highlight;
  return [shadow, mid, highlight];
}

/** Apply an adjustment to an ImageData buffer, in place. */
/**
 * How strongly a pixel belongs to each Selective Color band. The six hue
 * bands use a triangular window 60 degrees wide, so a colour sitting between
 * two of them is shared between the pair and the weights still sum to one.
 * Neutral bands are driven by how light or dark the pixel is instead.
 */
function familyWeight(
  family: ColorFamily, r: number, g: number, b: number,
): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (family === 'whites') return clamp((mn - 0.5) * 2, 0, 1);
  if (family === 'blacks') return clamp((0.5 - mx) * 2, 0, 1);
  if (family === 'neutrals') {
    return clamp(1 - clamp((mn - 0.5) * 2, 0, 1) - clamp((0.5 - mx) * 2, 0, 1), 0, 1);
  }

  const chroma = mx - mn;
  if (chroma <= 0) return 0;
  let hue: number;
  if (mx === r) hue = ((g - b) / chroma) % 6;
  else if (mx === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  if (hue < 0) hue += 360;

  const centre = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 }[family];
  let delta = Math.abs(hue - centre);
  if (delta > 180) delta = 360 - delta;
  // Scale by saturation so a nearly grey pixel is left to the neutral bands.
  return clamp(1 - delta / 60, 0, 1) * (chroma / mx);
}

/** Selective Color for one pixel, in place on a 0..1 RGB triple. */
function selectiveColorPixel(
  rgb: [number, number, number], spec: Extract<AdjustmentSpec, { type: 'selective-color' }>,
): void {
  const [r, g, b] = rgb;
  const w = familyWeight(spec.family, r, g, b);
  if (w <= 0) return;

  const k = 1 - Math.max(r, g, b);
  const inv = 1 - k;
  // A fully black pixel has no colour ink to scale, only black.
  let c = inv > 1e-6 ? (1 - r - k) / inv : 0;
  let m = inv > 1e-6 ? (1 - g - k) / inv : 0;
  let y = inv > 1e-6 ? (1 - b - k) / inv : 0;
  let kk = k;

  const shift = (value: number, amount: number): number => {
    const delta = (amount / 100) * w;
    // Relative works on what is already there; absolute adds a flat amount.
    return clamp(value + (spec.relative ? value * delta : delta), 0, 1);
  };
  c = shift(c, spec.cyan);
  m = shift(m, spec.magenta);
  y = shift(y, spec.yellow);
  kk = shift(kk, spec.black);

  const back = 1 - kk;
  rgb[0] = clamp((1 - c) * back, 0, 1);
  rgb[1] = clamp((1 - m) * back, 0, 1);
  rgb[2] = clamp((1 - y) * back, 0, 1);
}

export function applyAdjustment(img: ImageData, spec: AdjustmentSpec): void {
  const d = img.data;

  switch (spec.type) {
    case 'brightness-contrast': {
      const lut = new Uint8ClampedArray(256);
      const b = spec.brightness;
      const c = spec.contrast;
      if (spec.legacy) {
        const f = (100 + c) / 100;
        for (let i = 0; i < 256; i++) lut[i] = clamp255((i + b - 128) * f * f + 128);
      } else {
        const f = c < 0 ? 1 + c / 100 : 1 + (c / 100) * 2;
        for (let i = 0; i < 256; i++) {
          const shifted = i + b * (1 - Math.abs(i / 127.5 - 1) * 0.35);
          lut[i] = clamp255((shifted - 127.5) * f + 127.5);
        }
      }
      applyLuts(img, lut, lut, lut);
      return;
    }

    case 'levels': {
      const lut = levelsLut(spec.inBlack, spec.inWhite, spec.gamma, spec.outBlack, spec.outWhite);
      const id = identityLut();
      applyLuts(
        img,
        spec.channel === 'rgb' || spec.channel === 'r' ? lut : id,
        spec.channel === 'rgb' || spec.channel === 'g' ? lut : id,
        spec.channel === 'rgb' || spec.channel === 'b' ? lut : id,
      );
      return;
    }

    case 'curves': {
      const master = curveLut(spec.curves.rgb);
      const lr = curveLut(spec.curves.r);
      const lg = curveLut(spec.curves.g);
      const lb = curveLut(spec.curves.b);
      const cr = new Uint8ClampedArray(256), cg = new Uint8ClampedArray(256), cb = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        cr[i] = master[lr[i]];
        cg[i] = master[lg[i]];
        cb[i] = master[lb[i]];
      }
      applyLuts(img, cr, cg, cb);
      return;
    }

    case 'hue-saturation': {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        if (spec.colorize) {
          const l = luminance(d[i], d[i + 1], d[i + 2]) / 255;
          const rgb = hslToRgb({
            h: spec.hue,
            s: clamp(spec.saturation / 100, 0, 1),
            l: clamp(l + spec.lightness / 200, 0, 1),
          });
          d[i] = rgb.r; d[i + 1] = rgb.g; d[i + 2] = rgb.b;
        } else {
          const hsl = rgbToHsl({ r: d[i], g: d[i + 1], b: d[i + 2] });
          hsl.h = (hsl.h + spec.hue + 360) % 360;
          hsl.s = clamp(spec.saturation >= 0
            ? hsl.s + (1 - hsl.s) * (spec.saturation / 100)
            : hsl.s * (1 + spec.saturation / 100), 0, 1);
          hsl.l = clamp(spec.lightness >= 0
            ? hsl.l + (1 - hsl.l) * (spec.lightness / 100)
            : hsl.l * (1 + spec.lightness / 100), 0, 1);
          const rgb = hslToRgb(hsl);
          d[i] = rgb.r; d[i + 1] = rgb.g; d[i + 2] = rgb.b;
        }
      }
      return;
    }

    case 'color-balance': {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const before = spec.preserveLuminosity ? luminance(d[i], d[i + 1], d[i + 2]) : 0;
        for (let k = 0; k < 3; k++) {
          const [s, m, h] = toneWeights(d[i + k]);
          const delta = spec.shadows[k] * s + spec.midtones[k] * m + spec.highlights[k] * h;
          d[i + k] = clamp255(d[i + k] + delta * 1.2);
        }
        if (spec.preserveLuminosity) {
          const after = luminance(d[i], d[i + 1], d[i + 2]);
          if (after > 0.5) {
            const f = before / after;
            d[i] = clamp255(d[i] * f);
            d[i + 1] = clamp255(d[i + 1] * f);
            d[i + 2] = clamp255(d[i + 2] * f);
          }
        }
      }
      return;
    }

    case 'exposure': {
      const lut = new Uint8ClampedArray(256);
      const gain = Math.pow(2, spec.exposure);
      const invGamma = 1 / Math.max(0.01, spec.gamma);
      for (let i = 0; i < 256; i++) {
        let v = i / 255;
        v = Math.max(0, v * gain + spec.offset);
        v = Math.pow(v, invGamma);
        lut[i] = clamp255(v * 255);
      }
      applyLuts(img, lut, lut, lut);
      return;
    }

    case 'vibrance': {
      const vib = spec.vibrance / 100;
      const sat = spec.saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const s = mx === 0 ? 0 : (mx - mn) / mx;
        const amount = vib * (1 - s) + sat;
        const lum = luminance(r, g, b);
        d[i] = clamp255(lum + (r - lum) * (1 + amount));
        d[i + 1] = clamp255(lum + (g - lum) * (1 + amount));
        d[i + 2] = clamp255(lum + (b - lum) * (1 + amount));
      }
      return;
    }

    case 'black-white': {
      const w = {
        r: spec.reds / 100, y: spec.yellows / 100, g: spec.greens / 100,
        c: spec.cyans / 100, b: spec.blues / 100, m: spec.magentas / 100,
      };
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const mid = r + g + b - mx - mn;
        // Decompose into the primary/secondary pair that spans this colour.
        let gray: number;
        if (mx === mn) {
          gray = mx;
        } else {
          const chroma = mx - mn;
          let primaryW: number, secondaryW: number;
          if (mx === r) { primaryW = w.r; secondaryW = mid === g ? w.y : w.m; }
          else if (mx === g) { primaryW = w.g; secondaryW = mid === b ? w.c : w.y; }
          else { primaryW = w.b; secondaryW = mid === r ? w.m : w.c; }
          const midFrac = chroma === 0 ? 0 : (mid - mn) / chroma;
          gray = mn + chroma * (primaryW * (1 - midFrac) + secondaryW * midFrac);
        }
        let v = clamp255(gray * 255);
        if (spec.tint) {
          d[i] = clamp255((v / 255) * spec.tintColor.r);
          d[i + 1] = clamp255((v / 255) * spec.tintColor.g);
          d[i + 2] = clamp255((v / 255) * spec.tintColor.b);
        } else {
          d[i] = v; d[i + 1] = v; d[i + 2] = v;
        }
      }
      return;
    }

    case 'selective-color': {
      const rgb: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        rgb[0] = d[i] / 255; rgb[1] = d[i + 1] / 255; rgb[2] = d[i + 2] / 255;
        selectiveColorPixel(rgb, spec);
        d[i] = clamp255(rgb[0] * 255);
        d[i + 1] = clamp255(rgb[1] * 255);
        d[i + 2] = clamp255(rgb[2] * 255);
      }
      return;
    }

    case 'shadows-highlights': {
      // Deliberately point-wise: every adjustment here has to give the same
      // answer whether it runs on a whole composite, a smart filter, or just
      // the bounding box of a selection, which a radius-based version could
      // not do without seeing the pixels outside that box.
      const sAmt = spec.shadowAmount / 100;
      const hAmt = spec.highlightAmount / 100;
      const sTone = Math.max(0.01, spec.shadowTone / 100);
      const hTone = Math.max(0.01, spec.highlightTone / 100);
      const contrast = spec.midtoneContrast / 100;
      const colour = spec.colorCorrect / 100;

      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = luminance(r, g, b) / 255;

        const sMask = clamp(1 - lum / sTone, 0, 1) ** 2;
        const hMask = clamp((lum - (1 - hTone)) / hTone, 0, 1) ** 2;
        // At full strength shadows roughly treble and highlights drop to a
        // third, so the two sliders pull with about the same force.
        let out = lum * (1 + sAmt * sMask * 2) * (1 - hAmt * hMask * 0.7);

        // Midtone contrast is an S-curve about the middle grey.
        if (contrast !== 0) {
          const t = clamp(out, 0, 1);
          const s = t * t * (3 - 2 * t);
          out = t + (s - t) * contrast;
        }
        out = clamp(out, 0, 1);

        // Scaling keeps the black point: a pixel with no light in it has no
        // shadow detail to recover, while near-black pixels are pulled apart
        // enough to bring their detail back without washing the blacks out.
        const ratio = lum > 0 ? out / lum : 1;
        let nr = r * ratio, ng = g * ratio, nb = b * ratio;

        if (colour !== 0) {
          const touched = clamp(sMask + hMask, 0, 1);
          const nl = luminance(nr, ng, nb);
          const k = 1 + colour * touched;
          nr = nl + (nr - nl) * k;
          ng = nl + (ng - nl) * k;
          nb = nl + (nb - nl) * k;
        }
        d[i] = clamp255(nr);
        d[i + 1] = clamp255(ng);
        d[i + 2] = clamp255(nb);
      }
      return;
    }

    case 'invert': {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
      }
      return;
    }

    case 'threshold': {
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) lut[i] = i < spec.level ? 0 : 255;
      for (let i = 0; i < d.length; i += 4) {
        const v = lut[Math.round(luminance(d[i], d[i + 1], d[i + 2]))];
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
      return;
    }

    case 'posterize': {
      const n = Math.max(2, Math.round(spec.levels));
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.round((i / 255) * (n - 1)) / (n - 1) * 255);
      applyLuts(img, lut, lut, lut);
      return;
    }

    case 'photo-filter': {
      const t = clamp(spec.density / 100, 0, 1);
      const { r: fr, g: fg, b: fb } = spec.color;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const before = luminance(d[i], d[i + 1], d[i + 2]);
        // Multiply-toward-filter keeps the filter looking like coloured glass.
        d[i] = clamp255(d[i] * (1 - t) + (d[i] * fr) / 255 * t);
        d[i + 1] = clamp255(d[i + 1] * (1 - t) + (d[i + 1] * fg) / 255 * t);
        d[i + 2] = clamp255(d[i + 2] * (1 - t) + (d[i + 2] * fb) / 255 * t);
        if (spec.preserveLuminosity) {
          const after = luminance(d[i], d[i + 1], d[i + 2]);
          if (after > 0.5) {
            const f = before / after;
            d[i] = clamp255(d[i] * f);
            d[i + 1] = clamp255(d[i + 1] * f);
            d[i + 2] = clamp255(d[i + 2] * f);
          }
        }
      }
      return;
    }

    case 'gradient-map': {
      const lut = gradientLut(spec.stops);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const c = lut[Math.round(clamp(luminance(d[i], d[i + 1], d[i + 2]), 0, 255))];
        d[i] = clamp255(c.r); d[i + 1] = clamp255(c.g); d[i + 2] = clamp255(c.b);
      }
      return;
    }

    case 'channel-mixer': {
      const m = spec.matrix; // [rr,rg,rb,ro, gr,gg,gb,go, br,bg,bb,bo] in percent
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const nr = (r * m[0] + g * m[1] + b * m[2]) / 100 + (m[3] / 100) * 255;
        if (spec.monochrome) {
          const v = clamp255(nr);
          d[i] = v; d[i + 1] = v; d[i + 2] = v;
        } else {
          d[i] = clamp255(nr);
          d[i + 1] = clamp255((r * m[4] + g * m[5] + b * m[6]) / 100 + (m[7] / 100) * 255);
          d[i + 2] = clamp255((r * m[8] + g * m[9] + b * m[10]) / 100 + (m[11] / 100) * 255);
        }
      }
      return;
    }
  }
}

export const ADJUSTMENT_LABELS: Record<AdjustmentSpec['type'], string> = {
  'brightness-contrast': '亮度/對比',
  levels: '色階',
  curves: '曲線',
  'hue-saturation': '色相/飽和度',
  'color-balance': '色彩平衡',
  exposure: '曝光度',
  vibrance: '自然飽和度',
  'black-white': '黑白',
  invert: '負片效果',
  threshold: '臨界值',
  posterize: '色調分離',
  'photo-filter': '相片濾鏡',
  'gradient-map': '漸層對應',
  'channel-mixer': '色版混合器',
  'selective-color': '選取顏色',
  'shadows-highlights': '陰影/亮部',
};

/**
 * Fresh parameters for one adjustment. Generic so a literal type argument
 * narrows the result, which lets callers reach the variant's own fields.
 */
export function defaultAdjustment<T extends AdjustmentSpec['type']>(
  type: T,
): Extract<AdjustmentSpec, { type: T }> {
  // The switch below returns exactly the variant named by `type`, which
  // TypeScript cannot follow through the generic parameter.
  return defaultSpec(type) as Extract<AdjustmentSpec, { type: T }>;
}

function defaultSpec(type: AdjustmentSpec['type']): AdjustmentSpec {
  switch (type) {
    case 'brightness-contrast': return { type, brightness: 0, contrast: 0, legacy: false };
    case 'levels': return { type, channel: 'rgb', inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
    case 'curves': return {
      type,
      curves: {
        rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]],
        g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]],
      } as Record<CurveChannel, [number, number][]>,
    };
    case 'hue-saturation': return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'color-balance': return {
      type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true,
    };
    case 'exposure': return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance': return { type, vibrance: 0, saturation: 0 };
    case 'black-white': return {
      type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
      tint: false, tintColor: { r: 225, g: 200, b: 160 },
    };
    case 'invert': return { type };
    case 'threshold': return { type, level: 128 };
    case 'posterize': return { type, levels: 4 };
    case 'photo-filter': return { type, color: { r: 236, g: 138, b: 0 }, density: 25, preserveLuminosity: true };
    case 'gradient-map': return {
      type,
      stops: [
        { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
        { pos: 1, color: { r: 255, g: 255, b: 255 }, alpha: 1 },
      ],
    };
    case 'channel-mixer': return {
      type, matrix: [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0], monochrome: false,
    };
    case 'selective-color': return {
      type, family: 'reds', cyan: 0, magenta: 0, yellow: 0, black: 0, relative: true,
    };
    case 'shadows-highlights': return {
      type, shadowAmount: 35, shadowTone: 50, highlightAmount: 0, highlightTone: 50,
      midtoneContrast: 0, colorCorrect: 20,
    };
  }
}
