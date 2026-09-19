import { uid } from './ids';
import type { RGB } from './color';
import type { GradientStop } from './types';

/**
 * A named gradient. The built-ins that use the foreground or background colour
 * store a `ref` on the stop instead of a fixed colour, so they keep following
 * the colour well the way Photoshop's do.
 */
export interface GradientPreset {
  id: string;
  name: string;
  stops: GradientStop[];
  builtin?: boolean;
}

const stop = (pos: number, color: RGB, alpha = 1): GradientStop => ({ pos, color, alpha });
const ref = (pos: number, which: 'fg' | 'bg', alpha = 1): GradientStop =>
  ({ pos, color: { r: 0, g: 0, b: 0 }, alpha, ref: which });

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

export const BUILTIN_GRADIENTS: GradientPreset[] = [
  { id: 'fg-bg', name: '前景到背景', builtin: true, stops: [ref(0, 'fg'), ref(1, 'bg')] },
  { id: 'fg-transparent', name: '前景到透明', builtin: true, stops: [ref(0, 'fg'), ref(1, 'fg', 0)] },
  { id: 'transparent-fg', name: '透明到前景', builtin: true, stops: [ref(0, 'fg', 0), ref(1, 'fg')] },
  { id: 'black-white', name: '黑到白', builtin: true, stops: [stop(0, BLACK), stop(1, WHITE)] },
  {
    id: 'spectrum',
    name: '光譜',
    builtin: true,
    stops: [
      stop(0, { r: 255, g: 0, b: 0 }), stop(0.17, { r: 255, g: 255, b: 0 }),
      stop(0.34, { r: 0, g: 255, b: 0 }), stop(0.5, { r: 0, g: 255, b: 255 }),
      stop(0.67, { r: 0, g: 0, b: 255 }), stop(0.84, { r: 255, g: 0, b: 255 }),
      stop(1, { r: 255, g: 0, b: 0 }),
    ],
  },
  {
    id: 'sunset',
    name: '日落',
    builtin: true,
    stops: [
      stop(0, { r: 255, g: 94, b: 77 }),
      stop(0.5, { r: 255, g: 175, b: 64 }),
      stop(1, { r: 66, g: 39, b: 90 }),
    ],
  },
  {
    id: 'copper',
    name: '銅色',
    builtin: true,
    stops: [
      stop(0, { r: 40, g: 20, b: 10 }),
      stop(0.45, { r: 196, g: 121, b: 62 }),
      stop(0.7, { r: 255, g: 226, b: 186 }),
      stop(1, { r: 120, g: 62, b: 28 }),
    ],
  },
  {
    id: 'steel',
    name: '鋼鐵',
    builtin: true,
    stops: [
      stop(0, { r: 58, g: 66, b: 78 }),
      stop(0.5, { r: 208, g: 216, b: 226 }),
      stop(1, { r: 78, g: 88, b: 102 }),
    ],
  },
];

export const cloneStops = (stops: GradientStop[]): GradientStop[] =>
  stops.map((s) => ({ ...s, color: { ...s.color } }));

/** Stops in drawing order; a gradient with them out of order is still valid. */
export const sortStops = (stops: GradientStop[]): GradientStop[] =>
  [...stops].sort((a, b) => a.pos - b.pos);

/** Swap `ref` stops for the colours they point at, ready for rendering. */
export function resolveStops(stops: GradientStop[], fg: RGB, bg: RGB): GradientStop[] {
  return stops.map((s) => (
    s.ref ? { ...s, color: { ...(s.ref === 'fg' ? fg : bg) } } : { ...s, color: { ...s.color } }
  ));
}

// ---- storage ---------------------------------------------------------------

const STORAGE_KEY = 'photograp.gradients.v1';

interface Stored { user: GradientPreset[] }

function normalize(g: GradientPreset): GradientPreset {
  const stops = Array.isArray(g.stops) ? g.stops.filter((s) => s && typeof s.pos === 'number') : [];
  return {
    id: g.id || uid('gr'),
    name: g.name || '漸層',
    builtin: false,
    // A gradient needs two stops to be a gradient at all.
    stops: stops.length >= 2 ? cloneStops(stops) : [stop(0, BLACK), stop(1, WHITE)],
  };
}

function readStore(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { user: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return { user: Array.isArray(parsed.user) ? parsed.user.map(normalize) : [] };
  } catch {
    // Private windows and blocked storage both land here; saved gradients are
    // a convenience, so fall back to the built-ins rather than failing.
    return { user: [] };
  }
}

/** Built-ins first, then anything the user saved. */
export function loadGradients(): GradientPreset[] {
  const builtins = BUILTIN_GRADIENTS.map((g) => ({ ...g, stops: cloneStops(g.stops) }));
  return [...builtins, ...readStore().user];
}

export function saveGradients(list: GradientPreset[]): void {
  const user = list.filter((g) => !g.builtin).map((g) => ({ ...g, stops: cloneStops(g.stops) }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user }));
  } catch {
    // Nothing to do; the gradients simply will not survive a reload.
  }
}

export function resetGradients(): GradientPreset[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  return loadGradients();
}

export const createGradient = (name: string, stops: GradientStop[]): GradientPreset =>
  ({ id: uid('gr'), name, stops: cloneStops(stops) });

/** Look up a gradient by id, falling back to the first built-in. */
export function gradientById(id: string): GradientPreset {
  const all = loadGradients();
  return all.find((g) => g.id === id) ?? all[0];
}

/** Short readout for the editor, e.g. "5 個色標 · 含透明度". */
export function describeGradient(stops: GradientStop[]): string {
  const bits = [`${stops.length} 個色標`];
  if (stops.some((s) => s.alpha < 1)) bits.push('含透明度');
  if (stops.some((s) => s.ref)) bits.push('跟隨前景/背景色');
  return bits.join(' · ');
}
