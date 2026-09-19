import { uid } from './ids';
import type { Layer } from './types';
import { shallowCopyLayer } from './layer';
import { Selection } from './selection';
import { clonePath, type VectorPath } from './path';
import type { AlphaChannel } from './channels';
import type { QuickMask } from './quickmask';
import type { Guide } from './guides';

export interface HistorySnapshot {
  label: string;
  layers: Layer[];
  activeLayerId: string | null;
  selection: Selection;
  width: number;
  height: number;
  editingMask: boolean;
  paths: VectorPath[];
  activePathId: string | null;
  channels: AlphaChannel[];
  quickMask: QuickMask | null;
  guides: Guide[];
  guidesLocked: boolean;
}

/** A history state the user parked under a name of their own. */
export interface NamedSnapshot {
  id: string;
  name: string;
  snap: HistorySnapshot;
}

export interface HistoryHost {
  layers: Layer[];
  activeLayerId: string | null;
  selection: Selection;
  meta: { width: number; height: number };
  editingMask: boolean;
  paths: VectorPath[];
  activePathId: string | null;
  channels: AlphaChannel[];
  quickMask: QuickMask | null;
  guides: Guide[];
  guidesLocked: boolean;
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
  /** States parked by name; these survive the rolling step limit. */
  named: NamedSnapshot[] = [];
  /**
   * What the history brush paints from. Holding the snapshot itself rather
   * than an index keeps it valid when the rolling buffer drops older steps.
   */
  source: HistorySnapshot | null = null;

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
      paths: host.paths.map(clonePath),
      activePathId: host.activePathId,
      // Channel surfaces are shared copy-on-write, like layer pixels.
      channels: host.channels.map((c) => ({ ...c, color: { ...c.color } })),
      quickMask: host.quickMask
        ? { ...host.quickMask, color: { ...host.quickMask.color } }
        : null,
      guides: host.guides.map((g) => ({ ...g })),
      guidesLocked: host.guidesLocked,
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
    host.paths.length = 0;
    for (const p of snap.paths) host.paths.push(clonePath(p));
    host.activePathId = snap.activePathId;
    host.channels.length = 0;
    for (const c of snap.channels) host.channels.push({ ...c, color: { ...c.color } });
    host.quickMask = snap.quickMask
      ? { ...snap.quickMask, color: { ...snap.quickMask.color } }
      : null;
    host.guides = snap.guides.map((g) => ({ ...g }));
    host.guidesLocked = snap.guidesLocked;
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

  /** Park the current state under a name. Taking one is not itself a step. */
  addNamed(host: HistoryHost, name: string): NamedSnapshot {
    const entry = { id: uid('s'), name, snap: this.capture(host, name) };
    this.named.push(entry);
    return entry;
  }

  removeNamed(id: string): void {
    const entry = this.named.find((n) => n.id === id);
    if (entry && this.source === entry.snap) this.source = null;
    this.named = this.named.filter((n) => n.id !== id);
  }

  /**
   * The state the history brush reads from: whatever the user marked, else
   * the oldest step still held, which is the document as it was opened.
   */
  sourceSnapshot(): HistorySnapshot | null {
    return this.source ?? this.snapshots[0] ?? null;
  }

  clear(): void {
    this.snapshots.length = 0;
    this.index = -1;
    this.named = [];
    this.source = null;
  }
}
