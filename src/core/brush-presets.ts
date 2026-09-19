import { uid } from './ids';

/**
 * Preset values are stored in the same units the options bar uses
 * (percentages for hardness / opacity / flow / roundness), so applying a
 * preset is a straight copy into `app.toolOptions`.
 */
export interface BrushPresetSettings {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  smoothing: number;
  scatter: number;
  roundness: number;
  angle: number;
  sizeJitter: number;
  sizePressure: boolean;
  opacityPressure: boolean;
}

export interface BrushPreset {
  id: string;
  name: string;
  builtin: boolean;
  settings: BrushPresetSettings;
}

export const PRESET_KEYS: (keyof BrushPresetSettings)[] = [
  'size', 'hardness', 'opacity', 'flow', 'spacing', 'smoothing', 'scatter',
  'roundness', 'angle', 'sizeJitter', 'sizePressure', 'opacityPressure',
];

const base: BrushPresetSettings = {
  size: 30, hardness: 80, opacity: 100, flow: 100, spacing: 12, smoothing: 30,
  scatter: 0, roundness: 100, angle: 0, sizeJitter: 0,
  sizePressure: true, opacityPressure: false,
};

const preset = (
  id: string, name: string, settings: Partial<BrushPresetSettings>,
): BrushPreset => ({ id, name, builtin: true, settings: { ...base, ...settings } });

export const BUILTIN_PRESETS: BrushPreset[] = [
  preset('soft-round', '柔邊圓形 30', { size: 30, hardness: 0 }),
  preset('hard-round', '硬邊圓形 20', { size: 20, hardness: 100, spacing: 8 }),
  preset('pencil', '鉛筆 4', {
    size: 4, hardness: 100, spacing: 5, smoothing: 10, sizePressure: false,
  }),
  preset('airbrush', '噴槍 60', { size: 60, hardness: 0, flow: 18, spacing: 6, smoothing: 40 }),
  preset('calligraphy', '書法筆 40', {
    size: 40, hardness: 95, roundness: 22, angle: 45, spacing: 4, smoothing: 20,
  }),
  preset('chalk', '粉筆 55', {
    size: 55, hardness: 55, spacing: 22, scatter: 8, sizeJitter: 35, flow: 70,
  }),
  preset('spatter', '噴濺 70', {
    size: 70, hardness: 40, spacing: 45, scatter: 40, sizeJitter: 60, flow: 60,
  }),
  preset('fine-liner', '細線 3', { size: 3, hardness: 100, spacing: 3, smoothing: 60 }),
  preset('soft-wash', '大面積柔邊 200', { size: 200, hardness: 0, flow: 40, spacing: 10 }),
];

const STORAGE_KEY = 'photograp.brushPresets.v1';

interface StoredPresets {
  user: BrushPreset[];
  hiddenBuiltins: string[];
}

function readStore(): StoredPresets {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { user: [], hiddenBuiltins: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPresets>;
    return {
      user: Array.isArray(parsed.user) ? parsed.user.map(normalize) : [],
      hiddenBuiltins: Array.isArray(parsed.hiddenBuiltins) ? parsed.hiddenBuiltins : [],
    };
  } catch {
    // Private windows and blocked storage both land here; presets are a
    // convenience, so fall back to the built-ins rather than failing.
    return { user: [], hiddenBuiltins: [] };
  }
}

function normalize(p: BrushPreset): BrushPreset {
  return {
    id: p.id || uid('bp'),
    name: p.name || '筆刷',
    builtin: false,
    settings: { ...base, ...(p.settings ?? {}) },
  };
}

/** Built-ins first, then anything the user saved. */
export function loadPresets(): BrushPreset[] {
  const { user, hiddenBuiltins } = readStore();
  const builtins = BUILTIN_PRESETS
    .filter((p) => !hiddenBuiltins.includes(p.id))
    .map((p) => ({ ...p, settings: { ...p.settings } }));
  return [...builtins, ...user];
}

export function savePresets(list: BrushPreset[]): void {
  const user = list.filter((p) => !p.builtin).map((p) => ({ ...p, settings: { ...p.settings } }));
  const visible = new Set(list.filter((p) => p.builtin).map((p) => p.id));
  const hiddenBuiltins = BUILTIN_PRESETS.filter((p) => !visible.has(p.id)).map((p) => p.id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, hiddenBuiltins }));
  } catch {
    // Nothing to do; the presets simply will not survive a reload.
  }
}

export function resetPresets(): BrushPreset[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  return loadPresets();
}

/** Read the preset-relevant values out of a tool's option store. */
export function settingsFromOptions(options: Record<string, unknown>): BrushPresetSettings {
  const out = { ...base };
  for (const key of PRESET_KEYS) {
    const v = options[key];
    if (v === undefined) continue;
    if (key === 'sizePressure' || key === 'opacityPressure') {
      out[key] = Boolean(v);
    } else {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

/** Copy a preset into a tool's option store, skipping options it lacks. */
export function applySettingsToOptions(
  settings: BrushPresetSettings, options: Record<string, unknown>,
): void {
  for (const key of PRESET_KEYS) {
    // Tools only take the options they declare; the eraser has no scatter,
    // so writing one would put a dead value in its store.
    if (!(key in options)) continue;
    options[key] = settings[key];
  }
}

export function createPreset(name: string, settings: BrushPresetSettings): BrushPreset {
  return { id: uid('bp'), name, builtin: false, settings: { ...settings } };
}

/** One-line summary shown under a preset's name. */
export function describePreset(s: BrushPresetSettings): string {
  const bits = [`${Math.round(s.size)} px`, `硬度 ${Math.round(s.hardness)}%`];
  if (s.roundness < 100) bits.push(`圓度 ${Math.round(s.roundness)}%`);
  if (s.flow < 100) bits.push(`流量 ${Math.round(s.flow)}%`);
  if (s.scatter > 0) bits.push(`散佈 ${Math.round(s.scatter)}`);
  return bits.join(' · ');
}
