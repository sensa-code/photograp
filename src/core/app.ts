import { Emitter } from './emitter';
import { PhotoDoc } from './document';
import type { RGB } from './color';
import { defaultSnapSettings, type SnapLines, type SnapSettings } from './guides';

export interface ViewState {
  zoom: number;
  /** Document-space point shown at the centre of the viewport. */
  centerX: number;
  centerY: number;
  showGrid: boolean;
  showGuides: boolean;
  showRulers: boolean;
  /** Cleared until the view has sized itself to the document once. */
  fitted: boolean;
}

export interface AppEvents {
  'docs-changed': void;
  'doc-changed': void;
  'tool-changed': string;
  'options-changed': void;
  'color-changed': void;
  'view-changed': void;
  'status': string;
  'toast': { text: string; kind: 'info' | 'error' | 'success' };
}

const SWATCH_DEFAULTS: RGB[] = [
  { r: 0, g: 0, b: 0 }, { r: 68, g: 68, b: 68 }, { r: 136, g: 136, b: 136 },
  { r: 204, g: 204, b: 204 }, { r: 255, g: 255, b: 255 },
  { r: 214, g: 39, b: 40 }, { r: 255, g: 127, b: 14 }, { r: 255, g: 204, b: 0 },
  { r: 44, g: 160, b: 44 }, { r: 23, g: 190, b: 207 }, { r: 31, g: 119, b: 180 },
  { r: 148, g: 103, b: 189 }, { r: 227, g: 119, b: 194 }, { r: 140, g: 86, b: 75 },
];

export class App {
  docs: PhotoDoc[] = [];
  activeDocId: string | null = null;
  toolId = 'brush';
  foreground: RGB = { r: 0, g: 0, b: 0 };
  background: RGB = { r: 255, g: 255, b: 255 };
  swatches: RGB[] = SWATCH_DEFAULTS.map((c) => ({ ...c }));
  events = new Emitter<AppEvents>();
  /** Per-tool option values, keyed by tool id. */
  toolOptions: Record<string, Record<string, unknown>> = {};
  private views = new Map<string, ViewState>();
  /** Snapping preferences, shared by every document. */
  snap: SnapSettings = defaultSnapSettings();
  /** Spacing of the view grid, also used as the grid snap step. */
  gridSize = 50;
  /** Lines the current drag snapped to, drawn as guides-in-progress. */
  snapLines: SnapLines | null = null;
  /** Clipboard holds a detached surface plus its origin in document space. */
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;

  activeDoc(): PhotoDoc | null {
    return this.docs.find((d) => d.meta.id === this.activeDocId) ?? null;
  }

  addDoc(doc: PhotoDoc): void {
    this.docs.push(doc);
    this.activeDocId = doc.meta.id;
    this.views.set(doc.meta.id, {
      zoom: 1, centerX: doc.width / 2, centerY: doc.height / 2,
      showGrid: false, showGuides: true, showRulers: true, fitted: false,
    });
    this.events.emit('docs-changed', undefined);
    this.events.emit('doc-changed', undefined);
  }

  closeDoc(id: string): void {
    const i = this.docs.findIndex((d) => d.meta.id === id);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this.views.delete(id);
    if (this.activeDocId === id) {
      this.activeDocId = this.docs[Math.min(i, this.docs.length - 1)]?.meta.id ?? null;
    }
    this.events.emit('docs-changed', undefined);
    this.events.emit('doc-changed', undefined);
  }

  setActiveDoc(id: string): void {
    if (this.activeDocId === id) return;
    this.activeDocId = id;
    this.events.emit('docs-changed', undefined);
    this.events.emit('doc-changed', undefined);
  }

  view(): ViewState {
    const doc = this.activeDoc();
    if (!doc) {
      return {
        zoom: 1, centerX: 0, centerY: 0,
        showGrid: false, showGuides: true, showRulers: true, fitted: true,
      };
    }
    let v = this.views.get(doc.meta.id);
    if (!v) {
      v = {
        zoom: 1, centerX: doc.width / 2, centerY: doc.height / 2,
        showGrid: false, showGuides: true, showRulers: true, fitted: false,
      };
      this.views.set(doc.meta.id, v);
    }
    return v;
  }

  setTool(id: string): void {
    if (this.toolId === id) return;
    this.toolId = id;
    this.events.emit('tool-changed', id);
  }

  options<T extends Record<string, unknown>>(toolId: string, defaults: T): T {
    let store = this.toolOptions[toolId];
    if (!store) {
      store = { ...defaults };
      this.toolOptions[toolId] = store;
    } else {
      for (const k of Object.keys(defaults)) {
        if (!(k in store)) store[k] = defaults[k];
      }
    }
    return store as T;
  }

  setForeground(c: RGB): void { this.foreground = { ...c }; this.events.emit('color-changed', undefined); }
  setBackground(c: RGB): void { this.background = { ...c }; this.events.emit('color-changed', undefined); }

  swapColors(): void {
    const t = this.foreground;
    this.foreground = this.background;
    this.background = t;
    this.events.emit('color-changed', undefined);
  }

  resetColors(): void {
    this.foreground = { r: 0, g: 0, b: 0 };
    this.background = { r: 255, g: 255, b: 255 };
    this.events.emit('color-changed', undefined);
  }

  changed(): void { this.events.emit('doc-changed', undefined); }
  status(text: string): void { this.events.emit('status', text); }
  toast(text: string, kind: AppEvents['toast']['kind'] = 'info'): void {
    this.events.emit('toast', { text, kind });
  }
}

export const app = new App();
