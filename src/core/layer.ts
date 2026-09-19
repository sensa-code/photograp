import type { AdjustmentSpec, Layer, LayerEffects, TextStyle } from './types';
import { cloneBlendIf, defaultBlendIf } from './blend-range';
import { cloneSurface, createSurface, type Surface } from './surface';
import { uid } from './ids';
import { clonePath } from './path';
import { cloneShapeStyle } from './shape';

export { uid } from './ids';

export function defaultEffects(): LayerEffects {
  return {
    dropShadow: { enabled: false, color: { r: 0, g: 0, b: 0 }, alpha: 0.6, blur: 8, dx: 4, dy: 4 },
    stroke: { enabled: false, color: { r: 0, g: 0, b: 0 }, alpha: 1, width: 2 },
    glow: { enabled: false, color: { r: 255, g: 235, b: 140 }, alpha: 0.7, blur: 12 },
    innerShadow: {
      enabled: false, color: { r: 0, g: 0, b: 0 }, alpha: 0.55, blur: 10, dx: 3, dy: 3,
    },
    innerGlow: { enabled: false, color: { r: 255, g: 246, b: 200 }, alpha: 0.7, blur: 12 },
    bevel: {
      enabled: false, size: 8, depth: 100, angle: 120,
      highlight: { r: 255, g: 255, b: 255 }, shadow: { r: 0, g: 0, b: 0 },
      alpha: 0.75, emboss: false,
    },
    overlay: {
      enabled: false, kind: 'color', alpha: 1, color: { r: 220, g: 60, b: 60 },
      stops: [
        { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1, ref: 'fg' },
        { pos: 1, color: { r: 255, g: 255, b: 255 }, alpha: 1, ref: 'bg' },
      ],
      gradientKind: 'linear', angle: 90,
      patternId: 'checker', patternData: '', patternWidth: 0, patternHeight: 0,
      scale: 100,
    },
  };
}

function base(name: string): Omit<Layer, 'kind' | 'surface'> {
  return {
    id: uid(),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    fill: 1,
    blendIf: defaultBlendIf(),
    blend: 'normal',
    x: 0,
    y: 0,
    mask: null,
    maskEnabled: true,
    maskLinked: true,
    clipped: false,
    effects: defaultEffects(),
  };
}

export function createRasterLayer(name: string, w: number, h: number, surface?: Surface): Layer {
  return { ...base(name), kind: 'raster', surface: surface ?? createSurface(w, h) };
}

export function createTextLayer(name: string, w: number, h: number, text: TextStyle): Layer {
  return { ...base(name), kind: 'text', surface: createSurface(w, h), text };
}

export function createAdjustmentLayer(name: string, adjustment: AdjustmentSpec): Layer {
  return { ...base(name), kind: 'adjustment', surface: null, adjustment };
}

export function createGroupLayer(name: string): Layer {
  return { ...base(name), kind: 'group', surface: null, children: [], expanded: true, blend: 'normal' };
}

/** Shallow record copy; pixel surfaces are shared (copy-on-write). */
export function shallowCopyLayer(l: Layer): Layer {
  return {
    ...l,
    blendIf: cloneBlendIf(l.blendIf),
    effects: {
      dropShadow: { ...l.effects.dropShadow, color: { ...l.effects.dropShadow.color } },
      stroke: { ...l.effects.stroke, color: { ...l.effects.stroke.color } },
      glow: { ...l.effects.glow, color: { ...l.effects.glow.color } },
      innerShadow: {
        ...l.effects.innerShadow, color: { ...l.effects.innerShadow.color },
      },
      innerGlow: { ...l.effects.innerGlow, color: { ...l.effects.innerGlow.color } },
      bevel: {
        ...l.effects.bevel,
        highlight: { ...l.effects.bevel.highlight },
        shadow: { ...l.effects.bevel.shadow },
      },
      overlay: {
        ...l.effects.overlay,
        color: { ...l.effects.overlay.color },
        stops: l.effects.overlay.stops.map((s) => ({ ...s, color: { ...s.color } })),
      },
    },
    text: l.text ? { ...l.text, color: { ...l.text.color }, strokeColor: { ...l.text.strokeColor } } : undefined,
    adjustment: l.adjustment ? structuredCloneSpec(l.adjustment) : undefined,
    children: l.children ? l.children.map(shallowCopyLayer) : undefined,
    // The source surface is shared copy-on-write, like layer pixels.
    smart: l.smart
      ? { ...l.smart, filters: l.smart.filters.map((f) => ({ ...f, params: { ...f.params } })) }
      : undefined,
    // Geometry is cheap and must not be shared, or editing one copy of a
    // shape layer would silently rewrite the history snapshots too.
    shape: l.shape ? cloneShape(l.shape) : undefined,
  };
}

function cloneShape(s: NonNullable<Layer['shape']>): NonNullable<Layer['shape']> {
  return { path: clonePath(s.path), style: cloneShapeStyle(s.style) };
}

/** Deep copy including pixel data; used by Duplicate Layer. */
export function duplicateLayer(l: Layer, nameSuffix = ' 拷貝'): Layer {
  const copy = shallowCopyLayer(l);
  copy.id = uid();
  copy.name = l.name + nameSuffix;
  copy.surface = l.surface ? cloneSurface(l.surface) : null;
  copy.mask = l.mask ? cloneSurface(l.mask) : null;
  if (l.smart) {
    copy.smart = {
      ...l.smart,
      source: cloneSurface(l.smart.source),
      filters: l.smart.filters.map((f) => ({ ...f, params: { ...f.params } })),
    };
  }
  if (l.shape) copy.shape = cloneShape(l.shape);
  if (copy.children) copy.children = l.children!.map((c) => duplicateLayer(c, ''));
  return copy;
}

export function structuredCloneSpec<T>(spec: T): T {
  return JSON.parse(JSON.stringify(spec)) as T;
}

/** Depth-first list of every layer, groups included. */
export function flattenLayers(layers: Layer[], out: Layer[] = []): Layer[] {
  for (const l of layers) {
    out.push(l);
    if (l.children) flattenLayers(l.children, out);
  }
  return out;
}

export function findLayer(layers: Layer[], id: string): Layer | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Returns the array that directly contains the layer, plus its index. */
export function findParent(
  layers: Layer[], id: string, parent: Layer | null = null,
): { list: Layer[]; index: number; parent: Layer | null } | null {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx >= 0) return { list: layers, index: idx, parent };
  for (const l of layers) {
    if (l.children) {
      const found = findParent(l.children, id, l);
      if (found) return found;
    }
  }
  return null;
}

export function layerKindLabel(l: Layer): string {
  switch (l.kind) {
    case 'raster': return '點陣圖層';
    case 'text': return '文字圖層';
    case 'adjustment': return '調整圖層';
    case 'group': return '圖層群組';
    case 'smart': return '智慧型物件';
    case 'shape': return '形狀圖層';
    default: return '圖層';
  }
}
