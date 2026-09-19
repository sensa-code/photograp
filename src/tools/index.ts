import type { Tool } from './types';
import {
  BrushTool, PencilTool, EraserTool, MixerBrushTool, BlurSharpenTool, DodgeBurnTool,
  SmudgeTool,
  CloneStampTool, HistoryBrushTool, PatternStampTool,
} from './paint';
import { MarqueeTool, LassoTool, PolygonLassoTool, MagicWandTool } from './select';
import { MoveTool, HandTool, ZoomTool, EyedropperTool, CropTool } from './nav';
import { BucketTool, GradientTool, ShapeTool, TextTool } from './draw';
import { TransformTool } from './transform';
import { PenTool, DirectSelectTool } from './pen';
import { SpotHealingBrushTool, HealingBrushTool } from './heal';
import { PerspectiveCropTool } from './perspective-crop';

export const transformTool = new TransformTool();
export const cropTool = new CropTool();
export const perspectiveCropTool = new PerspectiveCropTool();

export const TOOLS: Tool[] = [
  new MoveTool(),
  new MarqueeTool(),
  new LassoTool(),
  new PolygonLassoTool(),
  new MagicWandTool(),
  cropTool,
  perspectiveCropTool,
  new EyedropperTool(),
  new BrushTool(),
  new PencilTool(),
  new MixerBrushTool(),
  new EraserTool(),
  new SpotHealingBrushTool(),
  new HealingBrushTool(),
  new CloneStampTool(),
  new HistoryBrushTool(),
  new PatternStampTool(),
  new SmudgeTool(),
  new BlurSharpenTool(),
  new DodgeBurnTool(),
  new BucketTool(),
  new GradientTool(),
  new PenTool(),
  new DirectSelectTool(),
  new TextTool(),
  new ShapeTool(),
  new HandTool(),
  new ZoomTool(),
  transformTool,
];

/** Toolbar slots; tools sharing a slot stack behind a flyout. */
export const TOOL_SLOTS: string[][] = [
  ['move'],
  ['marquee', 'lasso', 'poly-lasso', 'wand'],
  ['crop', 'perspective-crop'],
  ['eyedropper'],
  ['brush', 'pencil', 'mixer', 'eraser'],
  ['spot-heal', 'heal'],
  ['clone', 'pattern-stamp', 'history-brush', 'smudge', 'blur-sharpen', 'dodge-burn'],
  ['bucket', 'gradient'],
  ['pen', 'direct-select'],
  ['text', 'shape'],
  ['hand', 'zoom'],
];

const byId = new Map(TOOLS.map((t) => [t.id, t]));

export const getTool = (id: string): Tool => byId.get(id) ?? TOOLS[0];

/** Tools that respond to a keyboard shortcut, in cycle order. */
export function toolsForShortcut(key: string): Tool[] {
  return TOOLS.filter((t) => t.shortcut && t.shortcut === key.toLowerCase());
}

export * from './types';
