import type { Layer } from './types';
import { shallowCopyLayer } from './layer';
import { Selection } from './selection';

export interface HistorySnapshot {
  label: string;
  layers: Layer[];
  activeLayerId: string | null;
  selection: Selection;
  width: number;
  height: number;
  editingMask: boolean;
}

export interface HistoryHost {
  layers: Layer[];
  activeLayerId: string | null;
  selection: Selection;
  meta: { width: number; height: number };
  editingMask: boolean;
}

/**
 * Snapshot history. Layer records are copied but pixel surfaces are shared,
 * so a step only costs memory for the surfaces an edit actually replaced.
 * Every mutating operation must swap in a fresh surface rather than paint
 * into one an older snapshot still references (see PhotoDoc.mutableSurface).
 */
export class History {
  snapshots: HistorySnapshot[] = [];
  index = -1;
  limit = 50;

  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.snapshots.length - 1; }

  capture(host: HistoryHost, label: string): HistorySnapshot {
    return {
      label,
      layers: host.layers.map(shallowCopyLayer),
      activeLayerId: host.activeLayerId,
      selection: host.selection.clone(),
      width: host.meta.width,
      height: host.meta.height,
      editingMask: host.editingMask,
    };
  }

  commit(host: HistoryHost, label: string): void {
    if (this.index < this.snapshots.length - 1) {
      this.snapshots.length = this.index + 1;
    }
    this.snapshots.push(this.capture(host, label));
    while (this.snapshots.length > this.limit) this.snapshots.shift();
    this.index = this.snapshots.length - 1;
  }

  restore(host: HistoryHost, snap: HistorySnapshot): void {
    host.layers.length = 0;
    for (const l of snap.layers) host.layers.push(shallowCopyLayer(l));
    host.activeLayerId = snap.activeLayerId;
    host.selection = snap.selection.clone();
    host.meta.width = snap.width;
    host.meta.height = snap.height;
    host.editingMask = snap.editingMask;
  }

  undo(host: HistoryHost): boolean {
    if (!this.canUndo) return false;
    this.index--;
    this.restore(host, this.snapshots[this.index]);
    return true;
  }

  redo(host: HistoryHost): boolean {
    if (!this.canRedo) return false;
    this.index++;
    this.restore(host, this.snapshots[this.index]);
    return true;
  }

  goto(host: HistoryHost, index: number): boolean {
    if (index < 0 || index >= this.snapshots.length || index === this.index) return false;
    this.index = index;
    this.restore(host, this.snapshots[index]);
    return true;
  }

  clear(): void {
    this.snapshots.length = 0;
    this.index = -1;
  }
}
