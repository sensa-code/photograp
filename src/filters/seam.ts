/**
 * Content-Aware Scale, by seam carving (Avidan & Shamir). Resizing crops or
 * squashes everything equally; carving instead removes the least interesting
 * connected paths of pixels, so the busy parts of a picture keep their shape.
 */

/** Per-pixel weights that steer which seams get taken. */
export interface SeamWeights {
  /** 0..255 coverage; anything above zero is pushed to a very high energy. */
  protect?: Uint8Array | null;
  /** 0..255 coverage; anything above zero is pushed to a very low energy. */
  remove?: Uint8Array | null;
}

const PROTECT_BONUS = 1e6;
const REMOVE_PENALTY = -1e6;

/**
 * Gradient magnitude, the classic energy function. Fully transparent pixels
 * count as empty rather than black, so carving does not cling to the edge of
 * a cut-out just because the alpha steps there.
 */
export function energyMap(
  data: Uint8ClampedArray, w: number, h: number, weights: SeamWeights = {},
): Float32Array {
  const out = new Float32Array(w * h);
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * a;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = lum[y * w + Math.max(0, x - 1)];
      const r = lum[y * w + Math.min(w - 1, x + 1)];
      const u = lum[Math.max(0, y - 1) * w + x];
      const d = lum[Math.min(h - 1, y + 1) * w + x];
      out[i] = Math.abs(r - l) + Math.abs(d - u);
      const protect = weights.protect?.[i] ?? 0;
      const remove = weights.remove?.[i] ?? 0;
      if (remove > 0) out[i] += REMOVE_PENALTY * (remove / 255);
      else if (protect > 0) out[i] += PROTECT_BONUS * (protect / 255);
    }
  }
  return out;
}

/**
 * The cheapest top-to-bottom seam, as one x per row. Dynamic programming over
 * the accumulated cost, then a walk back down the choices.
 */
export function findVerticalSeam(energy: Float32Array, w: number, h: number): Int32Array {
  const cost = new Float32Array(w * h);
  const from = new Int8Array(w * h);
  cost.set(energy.subarray(0, w));

  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const above = (y - 1) * w;
      let best = cost[above + x];
      let pick = 0;
      if (x > 0 && cost[above + x - 1] < best) { best = cost[above + x - 1]; pick = -1; }
      if (x < w - 1 && cost[above + x + 1] < best) { best = cost[above + x + 1]; pick = 1; }
      cost[y * w + x] = energy[y * w + x] + best;
      from[y * w + x] = pick;
    }
  }

  let x = 0;
  const last = (h - 1) * w;
  for (let i = 1; i < w; i++) if (cost[last + i] < cost[last + x]) x = i;

  const seam = new Int32Array(h);
  for (let y = h - 1; y >= 0; y--) {
    seam[y] = x;
    x += from[y * w + x];
    if (x < 0) x = 0;
    if (x > w - 1) x = w - 1;
  }
  return seam;
}

/** Drop one pixel per row, giving an image one column narrower. */
export function removeVerticalSeam(
  data: Uint8ClampedArray, w: number, h: number, seam: Int32Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray((w - 1) * h * 4);
  for (let y = 0; y < h; y++) {
    const cut = seam[y];
    let o = y * (w - 1) * 4;
    for (let x = 0; x < w; x++) {
      if (x === cut) continue;
      const i = (y * w + x) * 4;
      out[o] = data[i]; out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
      o += 4;
    }
  }
  return out;
}

/**
 * Duplicate one pixel per row, giving an image one column wider. The new
 * pixel is the average of its neighbours so the insertion does not read as a
 * hard repeated line.
 */
export function insertVerticalSeam(
  data: Uint8ClampedArray, w: number, h: number, seam: Int32Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray((w + 1) * h * 4);
  for (let y = 0; y < h; y++) {
    const at = seam[y];
    let o = y * (w + 1) * 4;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o] = data[i]; out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
      o += 4;
      if (x === at) {
        const j = (y * w + Math.min(w - 1, x + 1)) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = (data[i + c] + data[j + c]) / 2;
        o += 4;
      }
    }
  }
  return out;
}

/** Swap rows and columns, so the vertical pass can do horizontal work too. */
export function transposeRGBA(
  data: Uint8ClampedArray, w: number, h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (y * w + x) * 4;
      const to = (x * h + y) * 4;
      out[to] = data[from]; out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2]; out[to + 3] = data[from + 3];
    }
  }
  return out;
}

/** The same transpose for an 8-bit coverage mask. */
export function transposeMask(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x];
  }
  return out;
}

function carveMask(src: Uint8Array, w: number, h: number, seam: Int32Array, grow: boolean): Uint8Array {
  const nw = grow ? w + 1 : w - 1;
  const out = new Uint8Array(nw * h);
  for (let y = 0; y < h; y++) {
    const at = seam[y];
    let o = y * nw;
    for (let x = 0; x < w; x++) {
      if (!grow && x === at) continue;
      out[o++] = src[y * w + x];
      if (grow && x === at) out[o++] = src[y * w + x];
    }
  }
  return out;
}

export interface CarveOptions extends SeamWeights {
  /** Called with 0..1 between seams, so a long carve can report progress. */
  onProgress?: (t: number) => void;
}

/** An image plus the weight masks that were carved alongside it. */
export interface CarveResult {
  image: ImageData;
  protect: Uint8Array | null;
  remove: Uint8Array | null;
}

/**
 * Insertion state. The seams are all found on a shrinking working copy before
 * any of them is added: inserting as we go does not work, because the pixels
 * just added have almost no energy and the next search picks the very same
 * place, leaving one smeared band instead of a wider picture.
 */
interface InsertPlan {
  work: Uint8ClampedArray;
  ww: number;
  wp: Uint8Array | null;
  wr: Uint8Array | null;
  index: Int32Array;
  /** picks[y] collects the original columns chosen for that row. */
  picks: number[][];
  wanted: number;
  found: number;
}

function beginInsert(
  data: Uint8ClampedArray, w: number, h: number, count: number,
  protect: Uint8Array | null, remove: Uint8Array | null,
): InsertPlan {
  const index = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) index[y * w + x] = x;
  return {
    work: new Uint8ClampedArray(data),
    ww: w,
    wp: protect ? new Uint8Array(protect) : null,
    wr: remove ? new Uint8Array(remove) : null,
    index,
    picks: Array.from({ length: h }, () => []),
    wanted: Math.min(count, Math.max(0, w - 2)),
    found: 0,
  };
}

/** Find one more seam; returns false once the plan has them all. */
function insertStep(plan: InsertPlan, h: number): boolean {
  if (plan.found >= plan.wanted) return false;
  const { ww } = plan;
  const seam = findVerticalSeam(
    energyMap(plan.work, ww, h, { protect: plan.wp, remove: plan.wr }), ww, h,
  );
  for (let y = 0; y < h; y++) plan.picks[y].push(plan.index[y * ww + seam[y]]);
  plan.work = removeVerticalSeam(plan.work, ww, h, seam);
  if (plan.wp) plan.wp = carveMask(plan.wp, ww, h, seam, false);
  if (plan.wr) plan.wr = carveMask(plan.wr, ww, h, seam, false);
  const next = new Int32Array((ww - 1) * h);
  for (let y = 0; y < h; y++) {
    let o = y * (ww - 1);
    for (let x = 0; x < ww; x++) {
      if (x === seam[y]) continue;
      next[o++] = plan.index[y * ww + x];
    }
  }
  plan.index = next;
  plan.ww--;
  plan.found++;
  return true;
}

/** Add every planned seam in one pass over the original image. */
function finishInsert(
  plan: InsertPlan, data: Uint8ClampedArray, w: number, h: number,
  protect: Uint8Array | null, remove: Uint8Array | null,
): { data: Uint8ClampedArray; protect: Uint8Array | null; remove: Uint8Array | null; width: number } {
  const nw = w + plan.found;
  const out = new Uint8ClampedArray(nw * h * 4);
  const op: Uint8Array | null = protect ? new Uint8Array(nw * h) : null;
  const orr: Uint8Array | null = remove ? new Uint8Array(nw * h) : null;
  for (let y = 0; y < h; y++) {
    const at = new Set(plan.picks[y]);
    let o = y * nw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const write = (dst: number, avg: boolean): void => {
        const j = (y * w + Math.min(w - 1, x + 1)) * 4;
        for (let c = 0; c < 4; c++) {
          out[dst * 4 + c] = avg ? (data[i + c] + data[j + c]) / 2 : data[i + c];
        }
        if (op && protect) op[dst] = protect[y * w + x];
        if (orr && remove) orr[dst] = remove[y * w + x];
      };
      write(o, false);
      o++;
      if (at.has(x)) { write(o, true); o++; }
    }
  }
  return { data: out, protect: op, remove: orr, width: nw };
}

function insertSeams(
  data: Uint8ClampedArray, w: number, h: number, count: number,
  protect: Uint8Array | null, remove: Uint8Array | null,
  onProgress?: (t: number) => void,
): { data: Uint8ClampedArray; protect: Uint8Array | null; remove: Uint8Array | null; width: number } {
  const plan = beginInsert(data, w, h, count, protect, remove);
  while (insertStep(plan, h)) onProgress?.(plan.found / Math.max(1, count));
  return finishInsert(plan, data, w, h, protect, remove);
}

/**
 * Carve `count` vertical seams out of (or into) the image. Weights travel
 * with the pixels, and come back out, so a second pass over the other axis
 * keeps protecting the same content.
 */
export function carveVertical(
  img: ImageData, count: number, grow: boolean, opts: CarveOptions = {},
): CarveResult {
  const h = img.height;
  if (grow) {
    const r = insertSeams(
      new Uint8ClampedArray(img.data), img.width, h, count,
      opts.protect ?? null, opts.remove ?? null, opts.onProgress,
    );
    const out = new ImageData(r.width, h);
    out.data.set(r.data);
    return { image: out, protect: r.protect, remove: r.remove };
  }

  let data: Uint8ClampedArray = new Uint8ClampedArray(img.data);
  let w = img.width;
  let protect: Uint8Array | null = opts.protect ? new Uint8Array(opts.protect) : null;
  let remove: Uint8Array | null = opts.remove ? new Uint8Array(opts.remove) : null;

  for (let n = 0; n < count; n++) {
    if (w <= 2) break;
    const energy = energyMap(data, w, h, { protect, remove });
    const seam = findVerticalSeam(energy, w, h);
    data = removeVerticalSeam(data, w, h, seam);
    if (protect) protect = carveMask(protect, w, h, seam, false);
    if (remove) remove = carveMask(remove, w, h, seam, false);
    w--;
    opts.onProgress?.((n + 1) / count);
  }

  const out = new ImageData(w, h);
  out.data.set(data.subarray(0, w * h * 4));
  return { image: out, protect, remove };
}

/**
 * Content-aware resize to an exact size. Width is carved first, then the
 * image is transposed so the same pass handles height — carrying the carved
 * weight masks across, not the originals, or the second pass would protect
 * the wrong columns.
 */
export function contentAwareScale(
  img: ImageData, targetW: number, targetH: number, opts: CarveOptions = {},
): ImageData {
  let out = img;
  let protect = opts.protect ?? null;
  let remove = opts.remove ?? null;

  const dw = targetW - out.width;
  if (dw !== 0) {
    const r = carveVertical(out, Math.abs(dw), dw > 0, {
      protect, remove, onProgress: opts.onProgress,
    });
    out = r.image;
    protect = r.protect;
    remove = r.remove;
  }

  const dh = targetH - out.height;
  if (dh !== 0) {
    const t = new ImageData(out.height, out.width);
    t.data.set(transposeRGBA(out.data, out.width, out.height));
    const r = carveVertical(t, Math.abs(dh), dh > 0, {
      protect: protect ? transposeMask(protect, out.width, out.height) : null,
      remove: remove ? transposeMask(remove, out.width, out.height) : null,
      onProgress: opts.onProgress,
    });
    out = new ImageData(r.image.height, r.image.width);
    out.data.set(transposeRGBA(r.image.data, r.image.width, r.image.height));
  }
  return out;
}

/**
 * The same resize, but yielding to the event loop every few seams so a
 * full-size carve does not freeze the page.
 */
export async function contentAwareScaleAsync(
  img: ImageData, targetW: number, targetH: number, opts: CarveOptions = {},
): Promise<ImageData> {
  const total = Math.abs(targetW - img.width) + Math.abs(targetH - img.height);
  let done = 0;
  const tick = async (): Promise<void> => {
    done++;
    opts.onProgress?.(total ? Math.min(1, done / total) : 1);
    if (done % 8 === 0) await new Promise((r) => { setTimeout(r, 0); });
  };

  const step = async (
    src: ImageData, want: number, protect: Uint8Array | null, remove: Uint8Array | null,
  ): Promise<CarveResult> => {
    if (want > src.width) {
      // Insertion picks all its seams before adding any of them, so yield
      // between the searches rather than blocking for the whole run.
      const plan = beginInsert(
        src.data, src.width, src.height, want - src.width, protect, remove,
      );
      while (insertStep(plan, src.height)) await tick();
      const r = finishInsert(plan, src.data, src.width, src.height, protect, remove);
      const image = new ImageData(r.width, src.height);
      image.data.set(r.data);
      return { image, protect: r.protect, remove: r.remove };
    }
    let cur: CarveResult = { image: src, protect, remove };
    while (cur.image.width > want && cur.image.width > 2) {
      cur = carveVertical(cur.image, 1, false, { protect: cur.protect, remove: cur.remove });
      await tick();
    }
    return cur;
  };

  let state: CarveResult = {
    image: img, protect: opts.protect ?? null, remove: opts.remove ?? null,
  };
  if (targetW !== state.image.width) {
    state = await step(state.image, targetW, state.protect, state.remove);
  }
  if (targetH !== state.image.height) {
    const w = state.image.width, h = state.image.height;
    const t = new ImageData(h, w);
    t.data.set(transposeRGBA(state.image.data, w, h));
    const carved = await step(
      t, targetH,
      state.protect ? transposeMask(state.protect, w, h) : null,
      state.remove ? transposeMask(state.remove, w, h) : null,
    );
    const out = new ImageData(carved.image.height, carved.image.width);
    out.data.set(transposeRGBA(carved.image.data, carved.image.width, carved.image.height));
    state = { image: out, protect: null, remove: null };
  }
  opts.onProgress?.(1);
  return state.image;
}

/** Nearest-neighbour resample of a coverage mask. */
export function resampleMask(
  src: Uint8Array, w: number, h: number, dw: number, dh: number,
): Uint8Array {
  if (w === dw && h === dh) return new Uint8Array(src);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / dh));
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = src[sy * w + Math.min(w - 1, Math.floor((x * w) / dw))];
    }
  }
  return out;
}
