import { uid } from './ids';
import { defaultEffects } from './layer';
import type { LayerEffects } from './types';
import { BUILTIN_GRADIENTS, cloneStops } from './gradients';

/** A whole set of layer effects, saved under a name. */
export interface StylePreset {
  id: string;
  name: string;
  effects: LayerEffects;
  builtin?: boolean;
}

export const cloneEffects = (e: LayerEffects): LayerEffects =>
  JSON.parse(JSON.stringify(e)) as LayerEffects;

const preset = (id: string, name: string, edit: (e: LayerEffects) => void): StylePreset => {
  const effects = defaultEffects();
  edit(effects);
  return { id, name, effects, builtin: true };
};

export const BUILTIN_STYLES: StylePreset[] = [
  preset('soft-shadow', '柔和陰影', (e) => {
    e.dropShadow = { enabled: true, color: { r: 0, g: 0, b: 0 }, alpha: 0.45, blur: 18, dx: 6, dy: 8 };
  }),
  preset('hard-edge', '黑框', (e) => {
    e.stroke = { enabled: true, color: { r: 20, g: 20, b: 20 }, alpha: 1, width: 3 };
  }),
  preset('sticker', '貼紙', (e) => {
    e.stroke = { enabled: true, color: { r: 255, g: 255, b: 255 }, alpha: 1, width: 6 };
    e.dropShadow = { enabled: true, color: { r: 0, g: 0, b: 0 }, alpha: 0.35, blur: 10, dx: 3, dy: 4 };
  }),
  preset('neon', '霓虹', (e) => {
    e.glow = { enabled: true, color: { r: 90, g: 220, b: 255 }, alpha: 0.9, blur: 26 };
    e.stroke = { enabled: true, color: { r: 255, g: 255, b: 255 }, alpha: 0.9, width: 2 };
  }),
  preset('sunset-fill', '日落漸層', (e) => {
    e.overlay.enabled = true;
    e.overlay.kind = 'gradient';
    e.overlay.stops = cloneStops(
      BUILTIN_GRADIENTS.find((g) => g.id === 'sunset')!.stops,
    );
    e.overlay.angle = 90;
  }),
  preset('brick-fill', '磚牆圖樣', (e) => {
    e.overlay.enabled = true;
    e.overlay.kind = 'pattern';
    e.overlay.patternId = 'bricks';
  }),
];

const STORAGE_KEY = 'photograp.styles.v1';

function normalize(s: StylePreset): StylePreset | null {
  if (!s || typeof s.name !== 'string' || !s.effects) return null;
  // Merge onto the defaults so a style saved before an effect existed loads.
  return {
    id: s.id || uid('st'),
    name: s.name || '樣式',
    effects: { ...defaultEffects(), ...s.effects },
  };
}

function readStore(): StylePreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { user?: StylePreset[] };
    if (!Array.isArray(parsed.user)) return [];
    return parsed.user.map(normalize).filter((s): s is StylePreset => s !== null);
  } catch {
    // Private windows and blocked storage both land here; styles are a
    // convenience, so fall back to the built-ins rather than failing.
    return [];
  }
}

/** Built-ins first, then anything the user saved. */
export function loadStyles(): StylePreset[] {
  const builtins = BUILTIN_STYLES.map((s) => ({ ...s, effects: cloneEffects(s.effects) }));
  return [...builtins, ...readStore()];
}

export function saveStyles(list: StylePreset[]): void {
  const user = list.filter((s) => !s.builtin)
    .map((s) => ({ id: s.id, name: s.name, effects: cloneEffects(s.effects) }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user }));
  } catch {
    // Nothing to do; the styles simply will not survive a reload.
  }
}

export function resetStyles(): StylePreset[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  return loadStyles();
}

export const createStyle = (name: string, effects: LayerEffects): StylePreset =>
  ({ id: uid('st'), name: name || '樣式', effects: cloneEffects(effects) });

/** Short readout listing which effects a style turns on. */
export function describeStyle(e: LayerEffects): string {
  const bits: string[] = [];
  if (e.dropShadow.enabled) bits.push('陰影');
  if (e.glow.enabled) bits.push('外光暈');
  if (e.stroke.enabled) bits.push('筆畫');
  if (e.overlay.enabled) {
    bits.push({ color: '顏色覆蓋', gradient: '漸層覆蓋', pattern: '圖樣覆蓋' }[e.overlay.kind]);
  }
  return bits.length ? bits.join(' · ') : '沒有啟用任何效果';
}
