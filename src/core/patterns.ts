import { uid } from './ids';
import { createSurface, type Surface } from './surface';

/**
 * A tileable image. Built-ins are drawn on demand from a generator so they
 * cost nothing to store; anything the user defines is kept as a PNG data URL
 * in localStorage.
 */
export interface Pattern {
  id: string;
  name: string;
  width: number;
  height: number;
  /** PNG data URL for user patterns; empty for built-ins. */
  data: string;
  builtin?: boolean;
}

/** Biggest tile we will take from the canvas, to keep storage sane. */
export const MAX_PATTERN = 512;

type Draw = (ctx: CanvasRenderingContext2D, size: number) => void;

const BUILTIN_DRAW: Record<string, Draw> = {
  checker: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, s / 2, s / 2);
    ctx.fillRect(s / 2, s / 2, s / 2, s / 2);
  },
  stripes: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, s / 2, s);
  },
  diagonal: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#8f8f8f';
    ctx.lineWidth = Math.max(1, s / 8);
    // Three passes so the stroke wraps cleanly at both corners.
    for (const d of [-s, 0, s]) {
      ctx.beginPath();
      ctx.moveTo(d, s);
      ctx.lineTo(d + s, 0);
      ctx.stroke();
    }
  },
  grid: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#a8a8a8';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  },
  dots: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#7d7d7d';
    // Corners plus centre, so the dots line up across tiles.
    for (const [x, y] of [[0, 0], [s, 0], [0, s], [s, s], [s / 2, s / 2]]) {
      ctx.beginPath();
      ctx.arc(x, y, s / 8, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  crosshatch: (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#909090';
    ctx.lineWidth = Math.max(1, s / 12);
    for (const d of [-s, 0, s]) {
      ctx.beginPath();
      ctx.moveTo(d, s); ctx.lineTo(d + s, 0);
      ctx.moveTo(d, 0); ctx.lineTo(d + s, s);
      ctx.stroke();
    }
  },
  bricks: (ctx, s) => {
    const h = s / 2;
    ctx.fillStyle = '#c96f4a';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#efe3d6';
    ctx.lineWidth = Math.max(1, s / 16);
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(s, h);
    ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, h);
    ctx.moveTo(0, h); ctx.lineTo(0, s);
    ctx.moveTo(s, h); ctx.lineTo(s, s);
    ctx.stroke();
  },
  noise: (ctx, s) => {
    const img = ctx.createImageData(s, s);
    // A fixed sequence keeps the tile identical every time it is drawn.
    let seed = 1337;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = 150 + ((seed >> 16) % 90);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  },
};

export const BUILTIN_PATTERNS: Pattern[] = [
  { id: 'checker', name: '棋盤格', width: 32, height: 32, data: '', builtin: true },
  { id: 'stripes', name: '直條紋', width: 32, height: 32, data: '', builtin: true },
  { id: 'diagonal', name: '斜線', width: 32, height: 32, data: '', builtin: true },
  { id: 'grid', name: '格線', width: 32, height: 32, data: '', builtin: true },
  { id: 'dots', name: '圓點', width: 32, height: 32, data: '', builtin: true },
  { id: 'crosshatch', name: '交叉線', width: 32, height: 32, data: '', builtin: true },
  { id: 'bricks', name: '磚牆', width: 48, height: 48, data: '', builtin: true },
  { id: 'noise', name: '雜訊', width: 32, height: 32, data: '', builtin: true },
];

// ---- storage ---------------------------------------------------------------

const STORAGE_KEY = 'photograp.patterns.v1';

function normalize(p: Pattern): Pattern | null {
  if (!p || typeof p.data !== 'string' || !p.data.startsWith('data:image/')) return null;
  const w = Math.round(Number(p.width)), h = Math.round(Number(p.height));
  if (!(w > 0 && h > 0)) return null;
  return { id: p.id || uid('pt'), name: p.name || '圖樣', width: w, height: h, data: p.data };
}

function readStore(): Pattern[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { user?: Pattern[] };
    if (!Array.isArray(parsed.user)) return [];
    return parsed.user.map(normalize).filter((p): p is Pattern => p !== null);
  } catch {
    // Private windows and blocked storage both land here; patterns are a
    // convenience, so fall back to the built-ins rather than failing.
    return [];
  }
}

/** Built-ins first, then anything the user defined. */
export function loadPatterns(): Pattern[] {
  return [...BUILTIN_PATTERNS.map((p) => ({ ...p })), ...readStore()];
}

export function savePatterns(list: Pattern[]): void {
  const user = list.filter((p) => !p.builtin).map((p) => ({ ...p }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user }));
  } catch {
    // Nothing to do; the patterns simply will not survive a reload.
  }
}

export function resetPatterns(): Pattern[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  return loadPatterns();
}

/**
 * Take a tile out of a surface. The source is cropped to `MAX_PATTERN` so one
 * careless "define pattern" on a whole photo cannot fill up localStorage.
 */
export function createPattern(
  name: string, src: Surface, x = 0, y = 0, w = src.w, h = src.h,
): Pattern {
  const cw = Math.max(1, Math.min(Math.round(w), MAX_PATTERN));
  const ch = Math.max(1, Math.min(Math.round(h), MAX_PATTERN));
  const tile = createSurface(cw, ch);
  tile.ctx.drawImage(src.canvas, Math.round(x), Math.round(y), cw, ch, 0, 0, cw, ch);
  const out: Pattern = {
    id: uid('pt'),
    name: name || '圖樣',
    width: cw,
    height: ch,
    data: tile.canvas.toDataURL('image/png'),
  };
  // The tile is already drawn, so seed the cache rather than making the next
  // reader decode the data URL back into the same pixels.
  cache.set(out.id, tile);
  return out;
}

// ---- rendering -------------------------------------------------------------

const cache = new Map<string, Surface>();

/** Draw a built-in tile; they are generated rather than stored. */
function drawBuiltin(p: Pattern): Surface {
  const s = createSurface(p.width, p.height);
  (BUILTIN_DRAW[p.id] ?? BUILTIN_DRAW.checker)(s.ctx, Math.min(p.width, p.height));
  return s;
}

/**
 * The pattern as a surface, ready to tile. User patterns decode from their
 * data URL, so this is async; the result is cached by pattern id.
 */
export async function patternSurface(p: Pattern): Promise<Surface> {
  const hit = cache.get(p.id);
  if (hit) return hit;
  let out: Surface;
  if (p.builtin || !p.data) {
    out = drawBuiltin(p);
  } else {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('無法解碼圖樣'));
      el.src = p.data;
    });
    out = createSurface(p.width, p.height);
    out.ctx.drawImage(img, 0, 0);
  }
  cache.set(p.id, out);
  return out;
}

/**
 * The tile if it is already decoded. Tools paint synchronously, so they need
 * an answer now rather than a promise that resolves after the first dab.
 */
export function cachedPatternSurface(p: Pattern): Surface | null {
  const hit = cache.get(p.id);
  if (hit) return hit;
  if (p.builtin || !p.data) {
    const out = drawBuiltin(p);
    cache.set(p.id, out);
    return out;
  }
  return null;
}

/** Decode every stored pattern up front so the tools never have to wait. */
export function warmPatterns(): void {
  for (const p of loadPatterns()) {
    if (!cache.has(p.id)) void patternSurface(p).catch(() => { /* skip broken */ });
  }
}

/** Forget a cached tile, so a redefined pattern is not served from before. */
export function forgetPattern(id: string): void {
  cache.delete(id);
}

/**
 * Tile `tile` across `target`. `scale` is a percentage; the phase is taken
 * from the document origin so two fills of the same pattern line up.
 */
export function tileInto(
  target: Surface, tile: Surface, scale = 100, offsetX = 0, offsetY = 0,
): void {
  const w = Math.max(1, Math.round((tile.w * scale) / 100));
  const h = Math.max(1, Math.round((tile.h * scale) / 100));
  const scaled = w === tile.w && h === tile.h ? tile : (() => {
    const s = createSurface(w, h);
    s.ctx.imageSmoothingQuality = 'high';
    s.ctx.drawImage(tile.canvas, 0, 0, w, h);
    return s;
  })();

  const pat = target.ctx.createPattern(scaled.canvas, 'repeat');
  if (!pat) return;
  target.ctx.save();
  target.ctx.translate(-offsetX, -offsetY);
  target.ctx.fillStyle = pat;
  target.ctx.fillRect(offsetX, offsetY, target.w, target.h);
  target.ctx.restore();
}

/** Short readout for the picker. */
export const describePattern = (p: Pattern): string => `${p.width} × ${p.height} px`;
