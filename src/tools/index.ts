import type { Tool } from './types';
import {
  BrushTool, PencilTool, EraserTool, BlurSharpenTool, DodgeBurnTool, SmudgeTool,
  CloneStampTool, HistoryBrushTool,
} from './paint';
import { MarqueeTool, LassoTool, PolygonLassoTool, MagicWandTool } from './select';
import { MoveTool, HandTool, ZoomTool, EyedropperTool, CropTool } from './nav';
import { BucketTool, GradientTool, ShapeTool, TextTool } from './draw';
import { TransformTool } from './transform';
import { PenTool, DirectSelectTool } from './pen';
import { SpotHealingBrushTool, HealingBrushTool } from './heal';

export const transformTool = new TransformTool();
export const cropTool = new CropTool();

export const TOOLS: Tool[] = [
  new MoveTool(),
  new MarqueeTool(),
  new LassoTool(),
  new PolygonLassoTool(),
  new MagicWandTool(),
  cropTool,
  new EyedropperTool(),
  new BrushTool(),
  new PencilTool(),
  new EraserTool(),
  new SpotHealingBrushTool(),
  new HealingBrushTool(),
  new CloneStampTool(),
  new HistoryBrushTool(),
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
  ['crop'],
  ['eyedropper'],
  ['brush', 'pencil', 'eraser'],
  ['spot-heal', 'heal'],
  ['clone', 'history-brush', 'smudge', 'blur-sharpen', 'dodge-burn'],
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
