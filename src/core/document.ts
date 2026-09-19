import type { DocumentMeta, Layer } from './types';
import {
  cloneSurface, createSurface, resampleSurface, type Surface,
} from './surface';
import { Selection } from './selection';
import { History } from './history';
import {
  createRasterLayer, findLayer, findParent, flattenLayers, uid,
} from './layer';
import { compositeLayers, type CompositeOptions } from './compositor';

export interface LivePreview {
  layerId: string;
  surface: Surface;
  /** The preview replaces the layer mask rather than its pixels. */
  isMask: boolean;
}

export class PhotoDoc {
  meta: DocumentMeta;
  layers: Layer[] = [];
  activeLayerId: string | null = null;
  selection: Selection;
  history = new History();
  editingMask = false;
  /** Bumped on every edit; views use it to decide whether to re-composite. */
  revision = 0;
  /** Set while a tool is mid-stroke so the composite shows work in progress. */
  livePreview: LivePreview | null = null;
  soloLayerId: string | null = null;
  savedRevision = 0;

  private cache: Surface | null = null;
  private cacheKey = '';

  constructor(name: string, width: number, height: number, dpi = 72) {
    this.meta = { id: uid('d'), name, width, height, dpi };
    this.selection = new Selection(width, height);
  }

  static createBlank(
    name: string, w: number, h: number, fill: 'transparent' | 'white' | 'black' | string = 'white',
  ): PhotoDoc {
    const doc = new PhotoDoc(name, w, h);
    const layer = createRasterLayer('背景', w, h);
    if (fill !== 'transparent') {
      const css = fill === 'white' ? '#ffffff' : fill === 'black' ? '#000000' : fill;
      layer.surface!.ctx.fillStyle = css;
      layer.surface!.ctx.fillRect(0, 0, w, h);
    }
    layer.name = '背景';
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    doc.history.commit(doc, '新增文件');
    return doc;
  }

  static fromImage(name: string, img: CanvasImageSource, w: number, h: number): PhotoDoc {
    const doc = new PhotoDoc(name, w, h);
    const surface = createSurface(w, h);
    surface.ctx.drawImage(img, 0, 0, w, h);
    const layer = createRasterLayer('背景', w, h, surface);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    doc.history.commit(doc, '開啟影像');
    return doc;
  }

  get width(): number { return this.meta.width; }
  get height(): number { return this.meta.height; }
  get isDirty(): boolean { return this.revision !== this.savedRevision; }

  activeLayer(): Layer | null {
    return this.activeLayerId ? findLayer(this.layers, this.activeLayerId) : null;
  }

  allLayers(): Layer[] { return flattenLayers(this.layers); }

  touch(): void {
    this.revision++;
    this.cache = null;
  }

  commit(label: string): void {
    this.history.commit(this, label);
    this.touch();
  }

  undo(): boolean {
    const ok = this.history.undo(this);
    if (ok) this.touch();
    return ok;
  }

  redo(): boolean {
    const ok = this.history.redo(this);
    if (ok) this.touch();
    return ok;
  }

  gotoHistory(i: number): boolean {
    const ok = this.history.goto(this, i);
    if (ok) this.touch();
    return ok;
  }

  /**
   * Return a surface for the layer that is safe to paint into. The previous
   * surface may be referenced by history, so it is cloned first.
   */
  mutableSurface(layer: Layer): Surface {
    if (!layer.surface) layer.surface = createSurface(this.width, this.height);
    layer.surface = cloneSurface(layer.surface);
    return layer.surface;
  }

  mutableMask(layer: Layer): Surface {
    if (!layer.mask) {
      const m = createSurface(this.width, this.height);
      m.ctx.fillStyle = '#ffffff';
      m.ctx.fillRect(0, 0, m.w, m.h);
      layer.mask = m;
    } else {
      layer.mask = cloneSurface(layer.mask);
    }
    return layer.mask;
  }

  /** The surface painting tools should target right now. */
  paintTarget(): { layer: Layer; surface: Surface; isMask: boolean } | null {
    const layer = this.activeLayer();
    if (!layer || layer.locked) return null;
    if (this.editingMask && layer.mask) {
      return { layer, surface: layer.mask, isMask: true };
    }
    if (!layer.surface) return null;
    return { layer, surface: layer.surface, isMask: false };
  }

  compositeOptions(): CompositeOptions {
    return {
      width: this.width,
      height: this.height,
      overrideLayerId: this.livePreview?.layerId ?? null,
      overrideSurface: this.livePreview?.surface ?? null,
      overrideIsMask: this.livePreview?.isMask ?? false,
      soloLayerId: this.soloLayerId,
    };
  }

  /** Cached flattened render of the document. */
  composite(): Surface {
    const key = `${this.revision}|${this.livePreview?.layerId ?? ''}|${this.soloLayerId ?? ''}|${this.width}x${this.height}`;
    if (this.cache && this.cacheKey === key && !this.livePreview) return this.cache;
    const out = compositeLayers(this.layers, this.compositeOptions());
    if (!this.livePreview) { this.cache = out; this.cacheKey = key; }
    return out;
  }

  /** Composite ignoring caches; used for export and thumbnails. */
  render(): Surface {
    return compositeLayers(this.layers, {
      width: this.width, height: this.height, soloLayerId: null,
    });
  }

  // ---- structure -------------------------------------------------------

  insertLayerAbove(layer: Layer, referenceId: string | null): void {
    const ref = referenceId ? findParent(this.layers, referenceId) : null;
    if (ref) ref.list.splice(ref.index + 1, 0, layer);
    else this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.editingMask = false;
  }

  removeLayer(id: string): Layer | null {
    const found = findParent(this.layers, id);
    if (!found) return null;
    const [removed] = found.list.splice(found.index, 1);
    const next = found.list[found.index] ?? found.list[found.index - 1] ?? found.parent;
    this.activeLayerId = next ? next.id : (this.layers[this.layers.length - 1]?.id ?? null);
    this.editingMask = false;
    return removed;
  }

  moveLayer(id: string, delta: number): boolean {
    const found = findParent(this.layers, id);
    if (!found) return false;
    const target = found.index + delta;
    if (target < 0 || target >= found.list.length) return false;
    const [l] = found.list.splice(found.index, 1);
    found.list.splice(target, 0, l);
    return true;
  }

  /** Reorder within the top-level stack by absolute index. */
  reorderTop(id: string, toIndex: number): boolean {
    const from = this.layers.findIndex((l) => l.id === id);
    if (from < 0) return false;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, toIndex)), 0, l);
    return true;
  }

  // ---- canvas geometry -------------------------------------------------

  /** Image Size: resample every layer. */
  resampleTo(w: number, h: number, smooth = true): void {
    const sx = w / this.width, sy = h / this.height;
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.surface) l.surface = resampleSurface(l.surface, w, h, smooth);
        if (l.mask) l.mask = resampleSurface(l.mask, w, h, smooth);
        l.x = Math.round(l.x * sx);
        l.y = Math.round(l.y * sy);
        if (l.children) walk(l.children);
      }
    };
    walk(this.layers);
    this.meta.width = w;
    this.meta.height = h;
    this.selection.resize(w, h);
  }

  /** Canvas Size: keep pixel scale, re-place layers at an offset. */
  resizeCanvas(w: number, h: number, offsetX: number, offsetY: number): void {
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.surface) {
          const s = createSurface(w, h);
          s.ctx.drawImage(l.surface.canvas, offsetX, offsetY);
          l.surface = s;
        }
        if (l.mask) {
          const m = createSurface(w, h);
          m.ctx.fillStyle = '#000';
          m.ctx.fillRect(0, 0, w, h);
          m.ctx.drawImage(l.mask.canvas, offsetX, offsetY);
          l.mask = m;
        }
        if (l.children) walk(l.children);
      }
    };
    walk(this.layers);
    this.meta.width = w;
    this.meta.height = h;
    this.selection.resize(w, h, offsetX, offsetY);
  }

  /** Apply an arbitrary transform to every layer (rotate / flip). */
  transformAll(w: number, h: number, apply: (ctx: CanvasRenderingContext2D) => void): void {
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.surface) {
          const s = createSurface(w, h);
          s.ctx.save(); apply(s.ctx);
          s.ctx.drawImage(l.surface.canvas, l.x, l.y);
          s.ctx.restore();
          l.surface = s;
        }
        if (l.mask) {
          const m = createSurface(w, h);
          m.ctx.save(); apply(m.ctx);
          m.ctx.drawImage(l.mask.canvas, 0, 0);
          m.ctx.restore();
          l.mask = m;
        }
        l.x = 0; l.y = 0;
        if (l.children) walk(l.children);
      }
    };
    walk(this.layers);
    this.meta.width = w;
    this.meta.height = h;
    this.selection.resize(w, h);
  }
}
