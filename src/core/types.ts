import type { Surface } from './surface';
import type { RGB } from './color';

export const BLEND_MODES = [
  'normal', 'dissolve',
  'darken', 'multiply', 'color-burn', 'linear-burn',
  'lighten', 'screen', 'color-dodge', 'linear-dodge',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/** Blend modes the 2D context implements natively; the rest run per-pixel. */
export const NATIVE_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  darken: 'darken',
  multiply: 'multiply',
  'color-burn': 'color-burn',
  lighten: 'lighten',
  screen: 'screen',
  'color-dodge': 'color-dodge',
  'linear-dodge': 'lighter',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';

export interface CurvesParams {
  type: 'curves';
  /** Control points per channel, each [input, output] in 0..255, sorted by input. */
  curves: Record<CurveChannel, [number, number][]>;
}

export type AdjustmentSpec =
  | { type: 'brightness-contrast'; brightness: number; contrast: number; legacy: boolean }
  | {
      type: 'levels'; channel: CurveChannel;
      inBlack: number; inWhite: number; gamma: number;
      outBlack: number; outWhite: number;
    }
  | CurvesParams
  | { type: 'hue-saturation'; hue: number; saturation: number; lightness: number; colorize: boolean }
  | {
      type: 'color-balance';
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
      preserveLuminosity: boolean;
    }
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  | {
      type: 'black-white';
      reds: number; yellows: number; greens: number;
      cyans: number; blues: number; magentas: number;
      tint: boolean; tintColor: RGB;
    }
  | { type: 'invert' }
  | { type: 'threshold'; level: number }
  | { type: 'posterize'; levels: number }
  | { type: 'photo-filter'; color: RGB; density: number; preserveLuminosity: boolean }
  | { type: 'gradient-map'; stops: GradientStop[] }
  | { type: 'channel-mixer'; matrix: number[]; monochrome: boolean }
  | {
      type: 'selective-color'; family: ColorFamily;
      /** Cyan, magenta, yellow and black shifts, each -100..100. */
      cyan: number; magenta: number; yellow: number; black: number;
      /** Relative scales the existing ink; absolute adds a flat amount. */
      relative: boolean;
    }
  | {
      type: 'shadows-highlights';
      shadowAmount: number; shadowTone: number;
      highlightAmount: number; highlightTone: number;
      midtoneContrast: number; colorCorrect: number;
    };

/** The nine bands Selective Color works on, as in Photoshop. */
export type ColorFamily =
  | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
  | 'whites' | 'neutrals' | 'blacks';

export type AdjustmentType = AdjustmentSpec['type'];

export interface GradientStop {
  pos: number;
  color: RGB;
  alpha: number;
  /** Follow the live foreground or background colour instead of `color`. */
  ref?: 'fg' | 'bg';
}

export interface TextStyle {
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: RGB;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  strokeWidth: number;
  strokeColor: RGB;
  /** Set to lay the type along a document path instead of in a block. */
  onPath?: TextPathBinding;
}

/** Where a type layer sits on a path. */
export interface TextPathBinding {
  pathId: string;
  /** Extra distance along the path, on top of whatever `align` decides. */
  offset: number;
  /** Perpendicular shift; positive moves the type away from the curve. */
  baselineShift: number;
  /** Read along the other side of the curve, for type inside a circle. */
  flip: boolean;
}

export type LayerKind = 'raster' | 'text' | 'adjustment' | 'group' | 'smart' | 'shape';

/** One non-destructive filter stacked on a smart object. */
export interface SmartFilterEntry {
  id: string;
  filterId: string;
  params: Record<string, unknown>;
  enabled: boolean;
  opacity: number;
  blend: BlendMode;
}

/**
 * A smart object keeps its original pixels untouched. The placement and the
 * smart-filter stack are re-applied from the source whenever either changes,
 * so scaling down and back up loses nothing.
 */
export interface SmartObject {
  source: Surface;
  sourceWidth: number;
  sourceHeight: number;
  /** Centre of the placed content, in document coordinates. */
  cx: number;
  cy: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  filters: SmartFilterEntry[];
}

export interface LayerEffects {
  dropShadow: { enabled: boolean; color: RGB; alpha: number; blur: number; dx: number; dy: number };
  stroke: { enabled: boolean; color: RGB; alpha: number; width: number };
  glow: { enabled: boolean; color: RGB; alpha: number; blur: number };
}

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;          // 0..1
  blend: BlendMode;
  /** Offset of the layer surface within the document. */
  x: number;
  y: number;
  /** Pixel data. null for adjustment/group layers. */
  surface: Surface | null;
  /** Grayscale mask surface (white = visible). null when no mask. */
  mask: Surface | null;
  maskEnabled: boolean;
  maskLinked: boolean;
  /** Clip to the composite of the layers below within the same clipping group. */
  clipped: boolean;
  text?: TextStyle;
  adjustment?: AdjustmentSpec;
  smart?: SmartObject;
  shape?: import('./shape').ShapeLayerData;
  /** Group layers own children (top of array renders last, i.e. on top). */
  children?: Layer[];
  expanded?: boolean;
  effects: LayerEffects;
}

export interface DocumentMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Pixels per inch, used by print-size readouts only. */
  dpi: number;
}
