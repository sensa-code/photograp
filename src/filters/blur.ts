import { clamp } from '../core/geometry';

/** Premultiply alpha so blurring does not drag colour out of transparent areas. */
function premultiply(src: ImageData): Float32Array {
  const d = src.data;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a;
    out[i + 1] = d[i + 1] * a;
    out[i + 2] = d[i + 2] * a;
    out[i + 3] = d[i + 3];
  }
  return out;
}

function unpremultiply(buf: Float32Array, dst: ImageData): void {
  const d = dst.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = buf[i + 3];
    const inv = a > 0.5 ? 255 / a : 0;
    d[i] = clamp(buf[i] * inv, 0, 255);
    d[i + 1] = clamp(buf[i + 1] * inv, 0, 255);
    d[i + 2] = clamp(buf[i + 2] * inv, 0, 255);
    d[i + 3] = clamp(a, 0, 255);
  }
}

function boxPassH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1) * 4 + c];
      for (let x = 0; x < w; x++) {
        dst[row + x * 4 + c] = sum / win;
        sum -= src[row + clamp(x - r, 0, w - 1) * 4 + c];
        sum += src[row + clamp(x + r + 1, 0, w - 1) * 4 + c];
      }
    }
  }
}

function boxPassV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = r * 2 + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[clamp(i, 0, h - 1) * w * 4 + x * 4 + c];
      for (let y = 0; y < h; y++) {
        dst[y * w * 4 + x * 4 + c] = sum / win;
        sum -= src[clamp(y - r, 0, h - 1) * w * 4 + x * 4 + c];
        sum += src[clamp(y + r + 1, 0, h - 1) * w * 4 + x * 4 + c];
      }
    }
  }
}

/** Three box passes approximate a Gaussian closely enough for image work. */
export function gaussianBlur(img: ImageData, radius: number): void {
  if (radius <= 0) return;
  const w = img.width, h = img.height;
  const r = Math.max(1, Math.round(radius * 0.57));
  let a = premultiply(img);
  let b = new Float32Array(a.length);
  for (let p = 0; p < 3; p++) {
    boxPassH(a, b, w, h, r);
    boxPassV(b, a, w, h, r);
  }
  unpremultiply(a, img);
}

export function boxBlur(img: ImageData, radius: number): void {
  if (radius <= 0) return;
  const w = img.width, h = img.height;
  const r = Math.max(1, Math.round(radius));
  const a = premultiply(img);
  const b = new Float32Array(a.length);
  boxPassH(a, b, w, h, r);
  boxPassV(b, a, w, h, r);
  unpremultiply(a, img);
}

export function motionBlur(img: ImageData, angleDeg: number, distance: number): void {
  if (distance <= 0) return;
  const w = img.width, h = img.height;
  const src = premultiply(img);
  const out = new Float32Array(src.length);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad), dy = -Math.sin(rad);
  const steps = Math.max(1, Math.round(distance));
  const half = (steps - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < steps; s++) {
        const t = s - half;
        const sx = clamp(Math.round(x + dx * t), 0, w - 1);
        const sy = clamp(Math.round(y + dy * t), 0, h - 1);
        const i = (sy * w + sx) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
      }
      const o = (y * w + x) * 4;
      out[o] = r / steps; out[o + 1] = g / steps; out[o + 2] = b / steps; out[o + 3] = a / steps;
    }
  }
  unpremultiply(out, img);
}

export type RadialBlurKind = 'spin' | 'zoom';

export function radialBlur(
  img: ImageData, amount: number, kind: RadialBlurKind, cx = 0.5, cy = 0.5,
): void {
  if (amount <= 0) return;
  const w = img.width, h = img.height;
  const src = premultiply(img);
  const out = new Float32Array(src.length);
  const ox = cx * w, oy = cy * h;
  const steps = Math.max(2, Math.min(48, Math.round(amount / 2) + 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vx = x - ox, vy = y - oy;
      const dist = Math.hypot(vx, vy);
      const ang = Math.atan2(vy, vx);
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < steps; s++) {
        const t = (s / (steps - 1) - 0.5);
        let sx: number, sy: number;
        if (kind === 'spin') {
          const na = ang + t * (amount / 400);
          sx = ox + Math.cos(na) * dist;
          sy = oy + Math.sin(na) * dist;
        } else {
          const nd = dist * (1 + t * (amount / 400));
          sx = ox + Math.cos(ang) * nd;
          sy = oy + Math.sin(ang) * nd;
        }
        const i = (clamp(Math.round(sy), 0, h - 1) * w + clamp(Math.round(sx), 0, w - 1)) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
      }
      const o = (y * w + x) * 4;
      out[o] = r / steps; out[o + 1] = g / steps; out[o + 2] = b / steps; out[o + 3] = a / steps;
    }
  }
  unpremultiply(out, img);
}

/** Blur only where the local contrast is low, i.e. Surface Blur. */
export function surfaceBlur(img: ImageData, radius: number, threshold: number): void {
  if (radius <= 0) return;
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let sr = 0, sg = 0, sb = 0, wsum = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = clamp(y + dy, 0, h - 1);
        for (let dx = -r; dx <= r; dx++) {
          const xx = clamp(x + dx, 0, w - 1);
          const i = (yy * w + xx) * 4;
          const diff = Math.abs(src[i] - src[o]) + Math.abs(src[i + 1] - src[o + 1]) + Math.abs(src[i + 2] - src[o + 2]);
          const weight = diff > threshold * 3 ? 0 : 1 - diff / (threshold * 3 + 1);
          sr += src[i] * weight; sg += src[i + 1] * weight; sb += src[i + 2] * weight;
          wsum += weight;
        }
      }
      if (wsum > 0) {
        d[o] = sr / wsum; d[o + 1] = sg / wsum; d[o + 2] = sb / wsum;
      }
    }
  }
}

/** Unsharp mask: add back the difference between the image and its blur. */
export function unsharpMask(
  img: ImageData, amount: number, radius: number, threshold: number,
): void {
  const original = new Uint8ClampedArray(img.data);
  gaussianBlur(img, radius);
  const d = img.data;
  const k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = original[i + c] - d[i + c];
      d[i + c] = Math.abs(diff) < threshold
        ? original[i + c]
        : clamp(original[i + c] + diff * k, 0, 255);
    }
    d[i + 3] = original[i + 3];
  }
}

/** High pass keeps the detail the blur removes, centred on mid grey. */
export function highPass(img: ImageData, radius: number): void {
  const original = new Uint8ClampedArray(img.data);
  gaussianBlur(img, radius);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = clamp(original[i + c] - d[i + c] + 128, 0, 255);
    d[i + 3] = original[i + 3];
  }
}
