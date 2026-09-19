import { clamp, type Rect } from '../core/geometry';

/**
 * Bounding box of a coverage mask, or null when it is empty.
 * `threshold` decides what counts as inside.
 */
export function maskBounds(
  mask: Uint8Array, w: number, h: number, threshold = 128,
): Rect | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Grow a coverage mask by `r` pixels (square structuring element). */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return new Uint8Array(mask);
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w && mask[row + xx] > v) v = mask[row + xx];
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h && tmp[yy * w + x] > v) v = tmp[yy * w + x];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** One Gauss-Seidel sweep of the Laplace equation over the interior. */
function relax(
  f: Float32Array, inside: Uint8Array, free: Uint8Array | null,
  w: number, h: number, sweeps: number,
): void {
  for (let it = 0; it < sweeps; it++) {
    // Cells outside the image mirror their neighbour, giving a zero-gradient
    // edge so a blemish touching the canvas border can still be healed.
    if (free) {
      for (let i = 0; i < free.length; i++) {
        if (!free[i]) continue;
        const x = i % w, y = (i / w) | 0;
        const sx = clamp(x, 1, w - 2), sy = clamp(y, 1, h - 2);
        const src = (sy * w + sx) * 4, dst = i * 4;
        for (let k = 0; k < 4; k++) f[dst + k] = f[src + k];
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!inside[i]) continue;
        const q = i * 4;
        const a = (i - 1) * 4, b = (i + 1) * 4;
        const c = (i - w) * 4, d = (i + w) * 4;
        for (let k = 0; k < 4; k++) {
          f[q + k] = (f[a + k] + f[b + k] + f[c + k] + f[d + k]) * 0.25;
        }
      }
    }
  }
}

/**
 * Solve the membrane on a pyramid, coarse grid first.
 *
 * Plain relaxation needs O(n^2) sweeps to carry the boundary values into the
 * middle of a wide region; solving a half-size grid first and prolongating the
 * answer gets there in a fraction of the work. Without this a large healing
 * brush leaves the original blemish showing through.
 */
function solveMembrane(
  f: Float32Array, inside: Uint8Array, w: number, h: number, sweeps: number,
): void {
  if (w <= 8 || h <= 8) {
    relax(f, inside, null, w, h, 80);
    return;
  }
  const cw = w >> 1, ch = h >> 1;
  const cf = new Float32Array(cw * ch * 4);
  const cInside = new Uint8Array(cw * ch);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const ci = y * cw + x;
      let all = 1;
      let nBoundary = 0;
      const insideSum = [0, 0, 0, 0];
      const boundarySum = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx);
          const p = si * 4;
          if (inside[si]) {
            for (let k = 0; k < 4; k++) insideSum[k] += f[p + k] * 0.25;
          } else {
            all = 0;
            nBoundary++;
            for (let k = 0; k < 4; k++) boundarySum[k] += f[p + k];
          }
        }
      }
      cInside[ci] = all;
      const q = ci * 4;
      // A coarse boundary cell must carry the boundary value, not an average
      // watered down by its interior children, or the condition weakens as
      // the pyramid gets coarser and the patch never fully matches the seam.
      if (all) {
        for (let k = 0; k < 4; k++) cf[q + k] = insideSum[k];
      } else {
        for (let k = 0; k < 4; k++) cf[q + k] = boundarySum[k] / nBoundary;
      }
    }
  }

  solveMembrane(cf, cInside, cw, ch, sweeps);

  for (let y = 0; y < h; y++) {
    const sy = Math.min(ch - 1, y >> 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i]) continue;
      const sx = Math.min(cw - 1, x >> 1);
      const p = i * 4, q = (sy * cw + sx) * 4;
      for (let k = 0; k < 4; k++) f[p + k] = cf[q + k];
    }
  }
  relax(f, inside, null, w, h, sweeps);
}

/**
 * Seamless cloning (Poisson image editing, simplified).
 *
 * Inside the mask the result keeps the *source* texture, but a smooth
 * correction field is added so the patch matches the destination exactly at
 * the seam. The correction is harmonic (solves the Laplace equation) with the
 * boundary difference as its boundary condition, which is what makes the join
 * invisible instead of a hard-edged paste.
 */
export function seamlessClone(
  target: ImageData, source: ImageData, mask: Uint8Array, sweeps = 8,
): void {
  cloneCore(target, source, 0, 0, mask, sweeps);
}

/**
 * Same as `seamlessClone`, but the source is the target itself read at an
 * offset. This avoids copying the whole image for every healing stroke.
 */
export function seamlessCloneOffset(
  target: ImageData, mask: Uint8Array, dx: number, dy: number, sweeps = 8,
): void {
  cloneCore(target, null, dx, dy, mask, sweeps);
}

function cloneCore(
  target: ImageData, source: ImageData | null, dx: number, dy: number,
  mask: Uint8Array, sweeps: number,
): void {
  const w = target.width, h = target.height;
  const box = maskBounds(mask, w, h, 128);
  if (!box) return;

  // One-pixel apron around the region. It may fall outside the image, in
  // which case those cells get a zero-gradient condition instead.
  const x0 = box.x - 1, y0 = box.y - 1;
  const bw = box.w + 2, bh = box.h + 2;
  if (bw < 3 || bh < 3) return;

  const t = target.data;
  const s = source ? source.data : t;
  const srcIndex = (gx: number, gy: number): number => (source
    ? (clamp(gy, 0, h - 1) * w + clamp(gx, 0, w - 1)) * 4
    : (clamp(gy + dy, 0, h - 1) * w + clamp(gx + dx, 0, w - 1)) * 4);

  const inside = new Uint8Array(bw * bh);
  const free = new Uint8Array(bw * bh);
  const f = new Float32Array(bw * bh * 4);

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const li = y * bw + x;
      const gxp = x0 + x, gyp = y0 + y;
      const outside = gxp < 0 || gyp < 0 || gxp >= w || gyp >= h;
      const onApron = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
      if (outside) { free[li] = 1; continue; }

      const gi = gyp * w + gxp;
      // The apron ring is always the Dirichlet boundary.
      const isInside = !onApron && mask[gi] >= 128;
      inside[li] = isInside ? 1 : 0;
      if (isInside) continue;
      const p = gi * 4, q = li * 4;
      const sp = srcIndex(gxp, gyp);
      for (let c = 0; c < 4; c++) f[q + c] = t[p + c] - s[sp + c];
    }
  }

  // Seed the free apron from its neighbours before solving.
  relax(f, inside, free, bw, bh, 1);
  solveMembrane(f, inside, bw, bh, sweeps);

  // The source may overlap the region being written, so resolve every output
  // value from the untouched buffer before storing any of them.
  const out = new Float32Array(bw * bh * 4);
  const write = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gxp = x0 + x, gyp = y0 + y;
      if (gxp < 0 || gyp < 0 || gxp >= w || gyp >= h) continue;
      const gi = gyp * w + gxp;
      if (mask[gi] < 1) continue;
      const li = y * bw + x;
      const q = li * 4;
      const sp = srcIndex(gxp, gyp);
      for (let k = 0; k < 4; k++) out[q + k] = clamp(s[sp + k] + f[q + k], 0, 255);
      write[li] = 1;
    }
  }
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const li = y * bw + x;
      if (!write[li]) continue;
      const gi = (y0 + y) * w + (x0 + x);
      const p = gi * 4, q = li * 4;
      // Feather the edge so antialiased mask pixels blend too.
      const a = mask[gi] / 255;
      for (let k = 0; k < 4; k++) t[p + k] = t[p + k] * (1 - a) + out[q + k] * a;
    }
  }
}

/**
 * Pick where a spot-healing patch should come from. Candidate offsets around
 * the blemish are scored on the ring of pixels just outside the mask, so the
 * winner is the one whose surroundings match the surroundings of the spot.
 */
export function findHealSource(
  img: ImageData, mask: Uint8Array, searchRadius: number,
): { dx: number; dy: number } | null {
  const w = img.width, h = img.height;
  const box = maskBounds(mask, w, h, 128);
  if (!box) return null;

  const ringWidth = Math.max(2, Math.round(Math.min(box.w, box.h) * 0.4));
  // Only the neighbourhood of the blemish matters, so dilate a window of the
  // mask rather than the whole image.
  const wx = clamp(box.x - ringWidth - 1, 0, w);
  const wy = clamp(box.y - ringWidth - 1, 0, h);
  const ww = clamp(box.x + box.w + ringWidth + 1, 0, w) - wx;
  const wh2 = clamp(box.y + box.h + ringWidth + 1, 0, h) - wy;
  const window = new Uint8Array(ww * wh2);
  for (let y = 0; y < wh2; y++) {
    for (let x = 0; x < ww; x++) window[y * ww + x] = mask[(wy + y) * w + (wx + x)];
  }
  const grown = dilateMask(window, ww, wh2, ringWidth);
  const ring: number[] = [];
  for (let y = 0; y < wh2; y++) {
    for (let x = 0; x < ww; x++) {
      const li = y * ww + x;
      if (grown[li] >= 128 && window[li] < 128) ring.push((wy + y) * w + (wx + x));
    }
  }
  if (!ring.length) return null;

  const d = img.data;
  let best: { dx: number; dy: number } | null = null;
  let bestScore = Infinity;

  const minShift = Math.max(3, Math.round(Math.max(box.w, box.h) * 0.75));
  const radii = [minShift, minShift * 1.6, minShift * 2.4, searchRadius];
  for (const r of radii) {
    if (r < minShift) continue;
    const steps = 24;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const dx = Math.round(Math.cos(a) * r);
      const dy = Math.round(Math.sin(a) * r);
      if (dx === 0 && dy === 0) continue;

      // The source must not sit on the blemish we are trying to remove.
      if (Math.abs(dx) < box.w && Math.abs(dy) < box.h) continue;

      let score = 0;
      let counted = 0;
      let usable = true;
      for (let n = 0; n < ring.length; n += 2) {
        const i = ring[n];
        const x = i % w, y = (i / w) | 0;
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) { usable = false; break; }
        const si = sy * w + sx;
        if (mask[si] >= 128) { usable = false; break; }
        const p = i * 4, q = si * 4;
        for (let c = 0; c < 3; c++) {
          const diff = d[p + c] - d[q + c];
          score += diff * diff;
        }
        counted++;
      }
      if (!usable || !counted) continue;
      score /= counted;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
    if (best && bestScore < 40) break;
  }
  return best;
}

/** Build a shifted copy of `img`, clamped at the edges. */
export function shiftImage(img: ImageData, dx: number, dy: number): ImageData {
  const w = img.width, h = img.height;
  const out = new ImageData(w, h);
  const s = img.data, o = out.data;
  for (let y = 0; y < h; y++) {
    const sy = clamp(y + dy, 0, h - 1);
    for (let x = 0; x < w; x++) {
      const sx = clamp(x + dx, 0, w - 1);
      const p = (y * w + x) * 4, q = (sy * w + sx) * 4;
      o[p] = s[q]; o[p + 1] = s[q + 1]; o[p + 2] = s[q + 2]; o[p + 3] = s[q + 3];
    }
  }
  return out;
}

/**
 * Heal a painted region: find a source, clone it in and blend the seam away.
 * Returns false when no usable source could be found.
 */
export function spotHeal(
  img: ImageData, mask: Uint8Array, searchRadius: number,
): boolean {
  const src = findHealSource(img, mask, searchRadius);
  if (!src) return false;
  seamlessCloneOffset(img, mask, src.dx, src.dy);
  return true;
}

/** Heal using an explicit source offset, as the healing brush does. */
export function healFromSource(
  img: ImageData, mask: Uint8Array, dx: number, dy: number,
): void {
  seamlessCloneOffset(img, mask, dx, dy);
}
