import { collectSnapTargets, emptySnapContext, type SnapContext } from '../core/guides';
import type { ToolPointer } from './types';

/** Screen-space snap distance, converted to document units. */
const SNAP_PX = 8;

/**
 * Snap candidates for the current drag. Holding Ctrl suspends snapping, the
 * same escape hatch Photoshop offers.
 */
export function snapContextFor(e: ToolPointer, excludeLayerId?: string | null): SnapContext {
  if (e.ctrl || !e.app.snap.enabled) return emptySnapContext();
  return collectSnapTargets(
    {
      width: e.doc.width,
      height: e.doc.height,
      guides: e.doc.guides,
      layers: e.doc.layers,
    },
    e.app.snap,
    SNAP_PX / Math.max(0.01, e.zoom),
    e.app.gridSize,
    excludeLayerId,
  );
}

/** Publish (or clear) the lines the canvas should highlight. */
export function showSnapLines(e: ToolPointer, lines: { x: number[]; y: number[] } | null): void {
  e.app.snapLines = lines && (lines.x.length || lines.y.length) ? lines : null;
}

export const clearSnapLines = (e: ToolPointer): void => { e.app.snapLines = null; };
