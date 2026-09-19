import { clamp, type Rect } from '../core/geometry';
import { maskBounds } from './heal';

export interface InpaintOptions {
  /** Odd patch size; larger keeps more structure, smaller adapts more. */
  patchSize?: number;
  /** EM iterations per pyramid level. */
  iterations?: number;
  /** Longest side of the region actually processed. */
  maxWorkingSize?: number;
  /** Extra context sampled around the hole, as a multiple of the hole size. */
  contextFactor?: number;
}

interface Level {
  w: number;
  h: number;
  /** Current estimate, RGBA as floats. */
  color: Float32Array;
  /** 1 where pixels must be synthesised. */
  hole: Uint8Array;
  /** 1 where a patch centred here lies entirely outside the hole. */
  valid: Uint8Array;
}

const idx = (x: number, y: number, w: number): number => y * w + x;

function buildValid(hole: Uint8Array, w: number, h: number, half: number): Uint8Array {
  // A source patch may not contain any hole pixel, and must fit inside.
  const valid = new Uint8Array(w * h);
  const rowHas = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = 0;
      for (let i = -half; i <= half; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) { any = 1; break; }
        if (hole[idx(xx, y, w)]) { any = 1; break; }
      }
      rowHas[idx(x, y, w)] = any;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = 0;
      for (let i = -half; i <= half; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) { any = 1; break; }
        if (rowHas[idx(x, yy, w)]) { any = 1; break; }
      }
      valid[idx(x, y, w)] = any ? 0 : 1;
    }
  }
  return valid;
}

function downsample(level: Level, half: number): Level {
  const w = Math.max(1, level.w >> 1);
  const h = Math.max(1, level.h >> 1);
  const color = new Float32Array(w * h * 4);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0, anyHole = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = Math.min(level.h - 1, y * 2 + dy);
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.w - 1, x * 2 + dx);
          const si = idx(sx, sy, level.w);
          if (level.hole[si]) { anyHole = 1; continue; }
          const p = si * 4;
          r += level.color[p]; g += level.color[p + 1];
          b += level.color[p + 2]; a += level.color[p + 3];
          n++;
        }
      }
      const di = idx(x, y, w) * 4;
      if (n > 0) {
        color[di] = r / n; color[di + 1] = g / n;
        color[di + 2] = b / n; color[di + 3] = a / n;
      }
      hole[idx(x, y, w)] = anyHole;
    }
  }
  return { w, h, color, hole, valid: buildValid(hole, w, h, half) };
}

/** Seed the hole by pushing known colour inward, so EM starts somewhere sane. */
function seedHole(level: Level): void {
  const { w, h, color, hole } = level;
  const filled = Uint8Array.from(hole, (v) => (v ? 0 : 1));
  const pending = new Set<number>();
  for (let i = 0; i < hole.length; i++) if (hole[i]) pending.add(i);

  let guard = 0;
  while (pending.size && guard++ < 4096) {
    const done: number[] = [];
    for (const i of pending) {
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = idx(xx, yy, w);
          if (!filled[j]) continue;
          const p = j * 4;
          r += color[p]; g += color[p + 1]; b += color[p + 2]; a += color[p + 3];
          n++;
        }
      }
      if (!n) continue;
      const p = i * 4;
      color[p] = r / n; color[p + 1] = g / n;
      color[p + 2] = b / n; color[p + 3] = a / n;
      done.push(i);
    }
    if (!done.length) break;
    for (const i of done) { filled[i] = 1; pending.delete(i); }
  }
}

function patchDistance(
  level: Level, tx: number, ty: number, sx: number, sy: number, half: number, cutoff: number,
): number {
  const { w, h, color } = level;
  let sum = 0;
  for (let dy = -half; dy <= half; dy++) {
    const tyy = clamp(ty + dy, 0, h - 1);
    const syy = clamp(sy + dy, 0, h - 1);
    for (let dx = -half; dx <= half; dx++) {
      const txx = clamp(tx + dx, 0, w - 1);
      const sxx = clamp(sx + dx, 0, w - 1);
      const p = idx(txx, tyy, w) * 4;
      const q = idx(sxx, syy, w) * 4;
      for (let c = 0; c < 4; c++) {
        const d = color[p + c] - color[q + c];
        sum += d * d;
      }
    }
    if (sum > cutoff) return sum;
  }
  return sum;
}

function randomValid(level: Level, rand: () => number): number {
  const { valid } = level;
  for (let tries = 0; tries < 64; tries++) {
    const i = (rand() * valid.length) | 0;
    if (valid[i]) return i;
  }
  for (let i = 0; i < valid.length; i++) if (valid[i]) return i;
  return -1;
}

/** PatchMatch nearest-neighbour field over the hole pixels. */
function patchMatch(
  level: Level, nnf: Int32Array, nnd: Float32Array, assigned: Uint8Array,
  half: number, passes: number, rand: () => number,
): void {
  const { w, h, hole, valid } = level;

  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue;
    if (!assigned[i]) {
      const s = randomValid(level, rand);
      if (s < 0) continue;
      nnf[i * 2] = s % w;
      nnf[i * 2 + 1] = (s / w) | 0;
      assigned[i] = 1;
    }
    // Voting changed the colours, so the stored score is stale; without
    // re-scoring, propagation compares against a distance that no longer
    // exists and can keep a match that has become worse.
    nnd[i] = patchDistance(
      level, i % w, (i / w) | 0, nnf[i * 2], nnf[i * 2 + 1], half, Infinity,
    );
  }

  const maxRadius = Math.max(w, h);
  for (let pass = 0; pass < passes; pass++) {
    const forward = pass % 2 === 0;
    const xs = forward ? 1 : -1;
    const start = forward ? 0 : h - 1;
    const stop = forward ? h : -1;
    for (let y = start; y !== stop; y += xs) {
      const cstart = forward ? 0 : w - 1;
      const cstop = forward ? w : -1;
      for (let x = cstart; x !== cstop; x += xs) {
        const i = idx(x, y, w);
        if (!hole[i]) continue;

        // Propagate: a good match for my neighbour is probably good for me.
        for (const [ox, oy] of [[-xs, 0], [0, -xs]] as [number, number][]) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = idx(nx, ny, w);
          if (!hole[ni]) continue;
          const cx = nnf[ni * 2] - ox;
          const cy = nnf[ni * 2 + 1] - oy;
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
          if (!valid[idx(cx, cy, w)]) continue;
          const d = patchDistance(level, x, y, cx, cy, half, nnd[i]);
          if (d < nnd[i]) {
            nnd[i] = d;
            nnf[i * 2] = cx;
            nnf[i * 2 + 1] = cy;
          }
        }

        // Random search in an exponentially shrinking window.
        let radius = maxRadius;
        while (radius > 1) {
          const cx = clamp(Math.round(nnf[i * 2] + (rand() * 2 - 1) * radius), 0, w - 1);
          const cy = clamp(Math.round(nnf[i * 2 + 1] + (rand() * 2 - 1) * radius), 0, h - 1);
          if (valid[idx(cx, cy, w)]) {
            const d = patchDistance(level, x, y, cx, cy, half, nnd[i]);
            if (d < nnd[i]) {
              nnd[i] = d;
              nnf[i * 2] = cx;
              nnf[i * 2 + 1] = cy;
            }
          }
          radius = (radius / 2) | 0;
        }
      }
    }
  }
}

/** Rebuild hole pixels by averaging every matched patch that covers them. */
function vote(level: Level, nnf: Int32Array, nnd: Float32Array, half: number): void {
  const { w, h, color, hole } = level;
  const acc = new Float32Array(w * h * 4);
  const wsum = new Float32Array(w * h);
  const area = (half * 2 + 1) * (half * 2 + 1) * 4;

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const ci = idx(cx, cy, w);
      if (!hole[ci]) continue;
      const sx0 = nnf[ci * 2], sy0 = nnf[ci * 2 + 1];
      // Better matches count for more, which keeps the result from going soft.
      const weight = Math.exp(-(nnd[ci] / area) / 50);
      for (let dy = -half; dy <= half; dy++) {
        const ty = cy + dy;
        if (ty < 0 || ty >= h) continue;
        const sy = clamp(sy0 + dy, 0, h - 1);
        for (let dx = -half; dx <= half; dx++) {
          const tx = cx + dx;
          if (tx < 0 || tx >= w) continue;
          const ti = idx(tx, ty, w);
          if (!hole[ti]) continue;
          const sp = idx(clamp(sx0 + dx, 0, w - 1), sy, w) * 4;
          const tp = ti * 4;
          acc[tp] += color[sp] * weight;
          acc[tp + 1] += color[sp + 1] * weight;
          acc[tp + 2] += color[sp + 2] * weight;
          acc[tp + 3] += color[sp + 3] * weight;
          wsum[ti] += weight;
        }
      }
    }
  }

  for (let i = 0; i < wsum.length; i++) {
    if (!hole[i] || wsum[i] <= 0) continue;
    const p = i * 4;
    for (let c = 0; c < 4; c++) color[p + c] = acc[p + c] / wsum[i];
  }
}

/** Bilinear upsample of the coarse estimate into the finer level's hole. */
function upsampleInto(coarse: Level, fine: Level): void {
  const { w, h, color, hole } = fine;
  for (let y = 0; y < h; y++) {
    const sy = clamp((y - 0.5) / 2, 0, coarse.h - 1);
    const y0 = sy | 0, y1 = Math.min(coarse.h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const i = idx(x, y, w);
      if (!hole[i]) continue;
      const sx = clamp((x - 0.5) / 2, 0, coarse.w - 1);
      const x0 = sx | 0, x1 = Math.min(coarse.w - 1, x0 + 1);
      const fx = sx - x0;
      const p = i * 4;
      for (let c = 0; c < 4; c++) {
        const a = coarse.color[idx(x0, y0, coarse.w) * 4 + c];
        const b = coarse.color[idx(x1, y0, coarse.w) * 4 + c];
        const d = coarse.color[idx(x0, y1, coarse.w) * 4 + c];
        const e = coarse.color[idx(x1, y1, coarse.w) * 4 + c];
        const top = a + (b - a) * fx;
        const bot = d + (e - d) * fx;
        color[p + c] = top + (bot - top) * fy;
      }
    }
  }
}

function upsampleNnf(
  coarse: { w: number; h: number }, fine: Level,
  coarseNnf: Int32Array, nnf: Int32Array, assigned: Uint8Array,
): void {
  const { w, h, hole, valid } = fine;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y, w);
      if (!hole[i]) continue;
      const cx = Math.min(coarse.w - 1, x >> 1);
      const cy = Math.min(coarse.h - 1, y >> 1);
      const ci = idx(cx, cy, coarse.w);
      const sx = clamp(coarseNnf[ci * 2] * 2 + (x & 1), 0, w - 1);
      const sy = clamp(coarseNnf[ci * 2 + 1] * 2 + (y & 1), 0, h - 1);
      if (!valid[idx(sx, sy, w)]) continue;
      nnf[i * 2] = sx;
      nnf[i * 2 + 1] = sy;
      assigned[i] = 1; // keep the coarse match; it is re-scored later
    }
  }
}

/** Deterministic PRNG so a fill can be reproduced. */
function makeRandom(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export interface FillRegion {
  /** Region of the source image that was processed. */
  rect: Rect;
  /** Filled pixels for that region. */
  image: ImageData;
}

/**
 * Content-aware fill: synthesise the masked area from the rest of the image
 * with a multi-scale PatchMatch / voting loop (Wexler-style image completion).
 *
 * Only a window around the hole is processed, and that window is capped in
 * size, so the cost depends on the hole rather than the whole document.
 */
export function contentAwareFill(
  img: ImageData, holeMask: Uint8Array, opts: InpaintOptions = {},
): FillRegion | null {
  const patchSize = Math.max(3, (opts.patchSize ?? 7) | 1);
  const half = patchSize >> 1;
  const iterations = opts.iterations ?? 4;
  const maxWorking = opts.maxWorkingSize ?? 480;
  const contextFactor = opts.contextFactor ?? 2.5;

  const box = maskBounds(holeMask, img.width, img.height, 128);
  if (!box) return null;

  // Window the work: the hole plus enough surrounding texture to sample from.
  const pad = Math.max(patchSize * 4, Math.round(Math.max(box.w, box.h) * contextFactor));
  const rx = clamp(box.x - pad, 0, img.width);
  const ry = clamp(box.y - pad, 0, img.height);
  const rw = clamp(box.x + box.w + pad, 0, img.width) - rx;
  const rh = clamp(box.y + box.h + pad, 0, img.height) - ry;
  if (rw < 3 || rh < 3) return null;

  const scale = Math.min(1, maxWorking / Math.max(rw, rh));
  const ww = Math.max(4, Math.round(rw * scale));
  const wh = Math.max(4, Math.round(rh * scale));

  // Build the working level, resampling if the window had to shrink.
  const color = new Float32Array(ww * wh * 4);
  const hole = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    const sy = clamp(Math.round(ry + (y + 0.5) / scale - 0.5), 0, img.height - 1);
    for (let x = 0; x < ww; x++) {
      const sx = clamp(Math.round(rx + (x + 0.5) / scale - 0.5), 0, img.width - 1);
      const si = sy * img.width + sx;
      const p = idx(x, y, ww) * 4, q = si * 4;
      color[p] = img.data[q]; color[p + 1] = img.data[q + 1];
      color[p + 2] = img.data[q + 2]; color[p + 3] = img.data[q + 3];
      // Anything the selection touches is synthesised; the soft edge is
      // applied when the result is blended back.
      hole[idx(x, y, ww)] = holeMask[si] > 0 ? 1 : 0;
    }
  }

  let holeCount = 0;
  for (let i = 0; i < hole.length; i++) if (hole[i]) holeCount++;
  if (!holeCount || holeCount === hole.length) return null;

  const finest: Level = { w: ww, h: wh, color, hole, valid: buildValid(hole, ww, wh, half) };

  // Pyramid, coarsest last.
  const levels: Level[] = [finest];
  while (
    levels.length < 6
    && Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > patchSize * 3
  ) {
    levels.push(downsample(levels[levels.length - 1], half));
  }

  const rand = makeRandom(20260919);
  let prevNnf: Int32Array | null = null;
  let prevLevel: Level | null = null;
  let solved = false;

  for (let li = levels.length - 1; li >= 0; li--) {
    const level = levels[li];
    let hasValid = false;
    for (let i = 0; i < level.valid.length; i++) if (level.valid[i]) { hasValid = true; break; }
    if (!hasValid) continue;

    const nnf = new Int32Array(level.w * level.h * 2);
    const nnd = new Float32Array(level.w * level.h);
    const assigned = new Uint8Array(level.w * level.h);

    if (prevNnf && prevLevel) {
      upsampleInto(prevLevel, level);
      upsampleNnf(prevLevel, level, prevNnf, nnf, assigned);
    } else {
      seedHole(level);
    }

    const rounds = li === 0 ? iterations : Math.max(2, iterations - 1);
    for (let it = 0; it < rounds; it++) {
      patchMatch(level, nnf, nnd, assigned, half, 2, rand);
      vote(level, nnf, nnd, half);
    }

    solved = true;
    prevNnf = nnf;
    prevLevel = level;
  }

  // Every level was surrounded by hole, so there was nothing to copy from.
  if (!solved) return null;

  // Back to an ImageData at the working resolution, then to the window size.
  const filled = new ImageData(rw, rh);
  for (let y = 0; y < rh; y++) {
    const sy = clamp(Math.round((y + 0.5) * scale - 0.5), 0, wh - 1);
    for (let x = 0; x < rw; x++) {
      const sx = clamp(Math.round((x + 0.5) * scale - 0.5), 0, ww - 1);
      const p = (y * rw + x) * 4;
      const q = idx(sx, sy, ww) * 4;
      const srcI = ((ry + y) * img.width + (rx + x)) * 4;
      const isHole = holeMask[(ry + y) * img.width + (rx + x)] > 0;
      for (let c = 0; c < 4; c++) {
        filled.data[p + c] = isHole ? finest.color[q + c] : img.data[srcI + c];
      }
    }
  }

  return { rect: { x: rx, y: ry, w: rw, h: rh }, image: filled };
}

/** Apply a fill result back onto the full-size image, honouring soft edges. */
export function applyFillRegion(
  img: ImageData, region: FillRegion, holeMask: Uint8Array,
): void {
  const { rect, image } = region;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const gi = (rect.y + y) * img.width + (rect.x + x);
      const a = holeMask[gi] / 255;
      if (a <= 0) continue;
      const p = gi * 4, q = (y * rect.w + x) * 4;
      for (let c = 0; c < 4; c++) {
        img.data[p + c] = img.data[p + c] * (1 - a) + image.data[q + c] * a;
      }
    }
  }
}
