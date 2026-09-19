import { uid } from './ids';
import { defaultEffects } from './layer';
import type { BlendMode, Layer, LayerEffects } from './types';

/**
 * A layer comp remembers how the document looked, not what it contained:
 * which layers were showing, where they sat, and how they were styled. The
 * pixels are shared with the document, so a comp costs almost nothing.
 */
export interface CompLayerState {
  id: string;
  visible: boolean;
  x: number;
  y: number;
  opacity: number;
  blend: BlendMode;
  effects: LayerEffects;
}

/** Which of the three attribute groups a comp records and restores. */
export interface CompCapture {
  visibility: boolean;
  position: boolean;
  appearance: boolean;
}

export interface LayerComp {
  id: string;
  name: string;
  note: string;
  capture: CompCapture;
  layers: CompLayerState[];
}

export const defaultCapture = (): CompCapture =>
  ({ visibility: true, position: true, appearance: true });

const cloneEffects = (e: LayerEffects): LayerEffects =>
  JSON.parse(JSON.stringify(e)) as LayerEffects;

export function cloneComp(c: LayerComp): LayerComp {
  return {
    id: c.id,
    name: c.name,
    note: c.note,
    capture: { ...c.capture },
    layers: c.layers.map((l) => ({ ...l, effects: cloneEffects(l.effects) })),
  };
}

/** Every layer in the document, groups and their children alike. */
function walk(layers: Layer[], out: Layer[] = []): Layer[] {
  for (const l of layers) {
    out.push(l);
    if (l.children) walk(l.children, out);
  }
  return out;
}

export function captureComp(
  layers: Layer[], name: string, capture: CompCapture = defaultCapture(), note = '',
): LayerComp {
  return {
    id: uid('lc'),
    name: name || '圖層構成',
    note,
    capture: { ...capture },
    layers: walk(layers).map((l) => ({
      id: l.id,
      visible: l.visible,
      x: l.x,
      y: l.y,
      opacity: l.opacity,
      blend: l.blend,
      effects: cloneEffects(l.effects),
    })),
  };
}

/** Re-capture an existing comp's state, keeping its name and settings. */
export function recaptureComp(comp: LayerComp, layers: Layer[]): LayerComp {
  const next = captureComp(layers, comp.name, comp.capture, comp.note);
  next.id = comp.id;
  return next;
}

export interface ApplyResult {
  /** Layers the comp knew about and found. */
  applied: number;
  /** Layers the comp knew about that are no longer in the document. */
  missing: number;
  /** Layers in the document the comp has nothing to say about. */
  extra: number;
}

/**
 * Restore the attributes this comp records. Layers added since the comp was
 * taken are left alone rather than hidden, and layers it remembers but that
 * are gone are simply counted — a comp is a view of the document, not a
 * replacement for it.
 */
export function applyComp(layers: Layer[], comp: LayerComp): ApplyResult {
  const all = walk(layers);
  const byId = new Map(all.map((l) => [l.id, l]));
  let applied = 0;
  for (const state of comp.layers) {
    const layer = byId.get(state.id);
    if (!layer) continue;
    applied++;
    if (comp.capture.visibility) layer.visible = state.visible;
    if (comp.capture.position) {
      layer.x = state.x;
      layer.y = state.y;
    }
    if (comp.capture.appearance) {
      layer.opacity = state.opacity;
      layer.blend = state.blend;
      layer.effects = cloneEffects(state.effects);
    }
  }
  return {
    applied,
    missing: comp.layers.length - applied,
    extra: all.length - applied,
  };
}

/** Repair a comp read from a project file, filling in anything missing. */
export function normalizeComp(c: Partial<LayerComp>): LayerComp | null {
  if (!c || !Array.isArray(c.layers)) return null;
  return {
    id: c.id || uid('lc'),
    name: c.name || '圖層構成',
    note: c.note ?? '',
    capture: { ...defaultCapture(), ...(c.capture ?? {}) },
    layers: c.layers
      // An entry with no id can never match a layer, so it is dead weight.
      .filter((l) => !!l && typeof l.id === 'string' && l.id.length > 0)
      .map((l) => ({
        id: l.id,
        visible: l.visible !== false,
        x: Number(l.x) || 0,
        y: Number(l.y) || 0,
        opacity: typeof l.opacity === 'number' ? l.opacity : 1,
        blend: l.blend ?? 'normal',
        // Merge onto the defaults so a comp saved before an effect existed
        // still restores, with the new effect simply switched off.
        effects: { ...defaultEffects(), ...(l.effects ?? {}) },
      })),
  };
}

/** Short readout for the panel: which groups this comp restores. */
export function describeComp(c: LayerComp): string {
  const bits: string[] = [];
  if (c.capture.visibility) bits.push('可見度');
  if (c.capture.position) bits.push('位置');
  if (c.capture.appearance) bits.push('外觀');
  const what = bits.length ? bits.join(' · ') : '沒有記錄任何屬性';
  return `${c.layers.length} 個圖層 · ${what}`;
}
