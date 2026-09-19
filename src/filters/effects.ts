import { clamp } from '../core/geometry';
import { luminance, type RGB } from '../core/color';
import { gaussianBlur } from './blur';

/** Generic 3x3 / 5x5 convolution over RGB, leaving alpha untouched. */
export function convolve(
  img: ImageData, kernel: number[], divisor?: number, bias = 0,
): void {
  const size = Math.round(Math.sqrt(kernel.length));
  const half = (size - 1) / 2;
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const div = divisor ?? (kernel.reduce((a, b) => a + b, 0) || 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < size; ky++) {
        const yy = clamp(y + ky - half, 0, h - 1);
        for (let kx = 0; kx < size; kx++) {
          const xx = clamp(x + kx - half, 0, w - 1);
          const k = kernel[ky * size + kx];
          if (k === 0) continue;
          const i = (yy * w + xx) * 4;
          r += src[i] * k; g += src[i + 1] * k; b += src[i + 2] * k;
        }
      }
      const o = (y * w + x) * 4;
      d[o] = clamp(r / div + bias, 0, 255);
      d[o + 1] = clamp(g / div + bias, 0, 255);
      d[o + 2] = clamp(b / div + bias, 0, 255);
    }
  }
}

export const sharpen = (img: ImageData): void =>
  convolve(img, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1);

export const sharpenMore = (img: ImageData): void =>
  convolve(img, [-1, -1, -1, -1, 12, -1, -1, -1, -1], 4);

export const findEdges = (img: ImageData): void => {
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = 0, sy = 0;
      for (let ky = 0; ky < 3; ky++) {
        const yy = clamp(y + ky - 1, 0, h - 1);
        for (let kx = 0; kx < 3; kx++) {
          const xx = clamp(x + kx - 1, 0, w - 1);
          const i = (yy * w + xx) * 4;
          const l = luminance(src[i], src[i + 1], src[i + 2]);
          sx += l * gx[ky * 3 + kx];
          sy += l * gy[ky * 3 + kx];
        }
      }
      const v = clamp(255 - Math.hypot(sx, sy), 0, 255);
      const o = (y * w + x) * 4;
      d[o] = v; d[o + 1] = v; d[o + 2] = v;
    }
  }
};

export function emboss(img: ImageData, angleDeg: number, height: number, amount: number): void {
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad) * height;
  const dy = -Math.sin(rad) * height;
  const k = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ax = clamp(Math.round(x - dx), 0, w - 1);
      const ay = clamp(Math.round(y - dy), 0, h - 1);
      const bx = clamp(Math.round(x + dx), 0, w - 1);
      const by = clamp(Math.round(y + dy), 0, h - 1);
      const ia = (ay * w + ax) * 4;
      const ib = (by * w + bx) * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = clamp(128 + (src[ia + c] - src[ib + c]) * k, 0, 255);
      }
    }
  }
}

export function addNoise(img: ImageData, amount: number, monochrome: boolean, gaussianDist: boolean): void {
  const d = img.data;
  const a = amount * 2.55;
  const rnd = (): number => {
    if (!gaussianDist) return (Math.random() * 2 - 1) * a;
    // Box-Muller, clipped so a single sample cannot blow out the pixel.
    const u = Math.max(1e-9, Math.random());
    const v = Math.random();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return clamp(n, -3, 3) * (a / 3);
  };
  for (let i = 0; i < d.length; i += 4) {
    if (monochrome) {
      const n = rnd();
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    } else {
      d[i] = clamp(d[i] + rnd(), 0, 255);
      d[i + 1] = clamp(d[i + 1] + rnd(), 0, 255);
      d[i + 2] = clamp(d[i + 2] + rnd(), 0, 255);
    }
  }
}

export function pixelate(img: ImageData, cell: number): void {
  const size = Math.max(2, Math.round(cell));
  const w = img.width, h = img.height;
  const d = img.data;
  for (let by = 0; by < h; by += size) {
    for (let bx = 0; bx < w; bx += size) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const ey = Math.min(h, by + size), ex = Math.min(w, bx + size);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
        }
      }
      r /= n; g /= n; b /= n; a /= n;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
        }
      }
    }
  }
}

export function crystallize(img: ImageData, cell: number): void {
  // Voronoi-ish: snap each pixel to the colour of the nearest jittered cell centre.
  const size = Math.max(3, Math.round(cell));
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const cols = Math.ceil(w / size) + 1, rows = Math.ceil(h / size) + 1;
  const px = new Float32Array(cols * rows), py = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      px[r * cols + c] = (c + Math.random()) * size;
      py[r * cols + c] = (r + Math.random()) * size;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c0 = Math.floor(x / size), r0 = Math.floor(y / size);
      let best = Infinity, bi = 0;
      for (let r = Math.max(0, r0 - 1); r <= Math.min(rows - 1, r0 + 1); r++) {
        for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++) {
          const idx = r * cols + c;
          const dd = (px[idx] - x) ** 2 + (py[idx] - y) ** 2;
          if (dd < best) { best = dd; bi = idx; }
        }
      }
      const sx = clamp(Math.round(px[bi]), 0, w - 1);
      const sy = clamp(Math.round(py[bi]), 0, h - 1);
      const s = (sy * w + sx) * 4;
      const o = (y * w + x) * 4;
      d[o] = src[s]; d[o + 1] = src[s + 1]; d[o + 2] = src[s + 2]; d[o + 3] = src[s + 3];
    }
  }
}

export function median(img: ImageData, radius: number): void {
  const r = Math.max(1, Math.round(radius));
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const buf: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        buf.length = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = clamp(y + dy, 0, h - 1);
          for (let dx = -r; dx <= r; dx++) {
            const xx = clamp(x + dx, 0, w - 1);
            buf.push(src[(yy * w + xx) * 4 + c]);
          }
        }
        buf.sort((a, b) => a - b);
        d[(y * w + x) * 4 + c] = buf[buf.length >> 1];
      }
    }
  }
}

export function oilPaint(img: ImageData, radius: number, levels: number): void {
  const r = Math.max(1, Math.round(radius));
  const n = Math.max(2, Math.round(levels));
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  const count = new Int32Array(n);
  const sums = new Float64Array(n * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      count.fill(0); sums.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const yy = clamp(y + dy, 0, h - 1);
        for (let dx = -r; dx <= r; dx++) {
          const xx = clamp(x + dx, 0, w - 1);
          const i = (yy * w + xx) * 4;
          const bin = Math.min(n - 1, Math.floor((luminance(src[i], src[i + 1], src[i + 2]) / 256) * n));
          count[bin]++;
          sums[bin * 3] += src[i];
          sums[bin * 3 + 1] += src[i + 1];
          sums[bin * 3 + 2] += src[i + 2];
        }
      }
      let best = 0;
      for (let k = 1; k < n; k++) if (count[k] > count[best]) best = k;
      const o = (y * w + x) * 4;
      const c = Math.max(1, count[best]);
      d[o] = sums[best * 3] / c;
      d[o + 1] = sums[best * 3 + 1] / c;
      d[o + 2] = sums[best * 3 + 2] / c;
    }
  }
}

export function diffuseGlow(img: ImageData, radius: number, amount: number, glowColor: RGB): void {
  const original = new Uint8ClampedArray(img.data);
  gaussianBlur(img, radius);
  const d = img.data;
  const k = clamp(amount / 100, 0, 1);
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const g = [glowColor.r, glowColor.g, glowColor.b][c];
      // Screen the blurred copy back over the original.
      const blurLit = 255 - ((255 - d[i + c]) * (255 - g)) / 255;
      d[i + c] = clamp(original[i + c] * (1 - k) + blurLit * k, 0, 255);
    }
    d[i + 3] = original[i + 3];
  }
}

export function vignette(img: ImageData, amount: number, midpoint: number, roundness: number): void {
  const w = img.width, h = img.height;
  const d = img.data;
  const cx = w / 2, cy = h / 2;
  const mid = clamp(midpoint / 100, 0.01, 1);
  const k = amount / 100;
  const power = clamp(roundness, 0.2, 5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / cx, ny = (y - cy) / cy;
      const rr = Math.pow(Math.pow(Math.abs(nx), power) + Math.pow(Math.abs(ny), power), 1 / power);
      const t = clamp((rr - mid) / Math.max(0.01, 1 - mid), 0, 1);
      const f = 1 - k * t * t;
      const i = (y * w + x) * 4;
      d[i] = clamp(d[i] * f, 0, 255);
      d[i + 1] = clamp(d[i + 1] * f, 0, 255);
      d[i + 2] = clamp(d[i + 2] * f, 0, 255);
    }
  }
}

type Remap = (x: number, y: number, w: number, h: number) => [number, number];

function resample(img: ImageData, remap: Remap): void {
  const w = img.width, h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = remap(x, y, w, h);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p = (ix: number, iy: number): number =>
          src[(clamp(iy, 0, h - 1) * w + clamp(ix, 0, w - 1)) * 4 + c];
        const top = p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx;
        const bot = p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx;
        d[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
}

export function twirl(img: ImageData, angleDeg: number): void {
  const maxAngle = (angleDeg * Math.PI) / 180;
  resample(img, (x, y, w, h) => {
    const cx = w / 2, cy = h / 2;
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    const radius = Math.min(cx, cy);
    if (r > radius) return [x, y];
    const a = Math.atan2(dy, dx) - maxAngle * (1 - r / radius);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

export function ripple(img: ImageData, amount: number, wavelength: number): void {
  const amp = amount / 4;
  const wl = Math.max(2, wavelength);
  resample(img, (x, y) => [
    x + Math.sin((y / wl) * Math.PI * 2) * amp,
    y + Math.sin((x / wl) * Math.PI * 2) * amp,
  ]);
}

export function wave(img: ImageData, amplitude: number, wavelength: number): void {
  const wl = Math.max(2, wavelength);
  resample(img, (x, y) => [x + Math.sin((y / wl) * Math.PI * 2) * amplitude, y]);
}

/** Positive amount bulges the centre outward, negative pinches it inward. */
export function spherize(img: ImageData, amount: number): void {
  const k = clamp(amount / 100, -0.95, 0.95);
  resample(img, (x, y, w, h) => {
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(cx, cy);
    const dx = (x - cx) / radius, dy = (y - cy) / radius;
    const r = Math.hypot(dx, dy);
    if (r >= 1 || r === 0) return [x, y];
    const scale = Math.pow(r, 1 - k) / r;
    return [cx + dx * radius * scale, cy + dy * radius * scale];
  });
}

export function polarCoords(img: ImageData, toPolar: boolean): void {
  resample(img, (x, y, w, h) => {
    if (toPolar) {
      const cx = w / 2, cy = h / 2;
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      const a = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
      return [a * w, (r / Math.hypot(cx, cy)) * h];
    }
    const a = (x / w) * Math.PI * 2 - Math.PI;
    const r = (y / h) * Math.hypot(w / 2, h / 2);
    return [w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r];
  });
}
