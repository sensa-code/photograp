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
import { clonePath, type VectorPath } from './path';
import { renderChannelView, type AlphaChannel, type ChannelView } from './channels';
import { renderSmartLayer } from './smart';

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
  /** Saved vector paths; the last one is usually the live work path. */
  paths: VectorPath[] = [];
  activePathId: string | null = null;
  /** Stored alpha channels (saved selections, spot masks). */
  channels: AlphaChannel[] = [];
  /** Which channel the canvas shows; not part of the undo history. */
  channelView: ChannelView = 'rgb';

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

  activePath(): VectorPath | null {
    return this.paths.find((p) => p.id === this.activePathId) ?? null;
  }

  /** Replace or insert a path, making it the active one. */
  setPath(path: VectorPath): void {
    const i = this.paths.findIndex((p) => p.id === path.id);
    if (i >= 0) this.paths.splice(i, 1, path);
    else this.paths.push(path);
    this.activePathId = path.id;
  }

  clonePaths(): VectorPath[] { return this.paths.map(clonePath); }

  /** Re-render every smart object whose cache is missing or stale. */
  refreshSmartLayers(): void {
    for (const l of this.allLayers()) {
      if (l.kind === 'smart' && l.smart) renderSmartLayer(l, this.width, this.height);
    }
  }

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
    // Smart objects re-render from their source, so direct paint would be lost.
    if (layer.kind === 'smart') return null;
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
    const key = [
      this.revision,
      this.livePreview?.layerId ?? '',
      this.soloLayerId ?? '',
      `${this.width}x${this.height}`,
      this.channelView,
      this.channels.filter((c) => c.visible).map((c) => c.id).join(','),
    ].join('|');
    if (this.cache && this.cacheKey === key && !this.livePreview) return this.cache;
    let out = compositeLayers(this.layers, this.compositeOptions());
    if (this.channelView !== 'rgb' || this.channels.some((c) => c.visible)) {
      out = renderChannelView(out, this.channelView, this.channels);
    }
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
        // Smart objects rescale their placement and re-render from the source,
        // so an Image Size change costs them no quality at all.
        if (l.kind === 'smart' && l.smart) {
          l.smart = {
            ...l.smart,
            cx: l.smart.cx * sx,
            cy: l.smart.cy * sy,
            scaleX: l.smart.scaleX * sx,
            scaleY: l.smart.scaleY * sy,
          };
        } else if (l.surface) {
          l.surface = resampleSurface(l.surface, w, h, smooth);
        }
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
    this.refreshSmartLayers();
  }

  /** Canvas Size: keep pixel scale, re-place layers at an offset. */
  resizeCanvas(w: number, h: number, offsetX: number, offsetY: number): void {
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.kind === 'smart' && l.smart) {
          l.smart = { ...l.smart, cx: l.smart.cx + offsetX, cy: l.smart.cy + offsetY };
        }
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
    this.refreshSmartLayers();
  }

  /**
   * Apply a canvas-level transform (rotate / flip) to every layer. Smart
   * objects move their placement instead of their pixels, so they stay lossless.
   */
  transformAll(
    w: number, h: number,
    apply: (ctx: CanvasRenderingContext2D) => void,
    smartOp?: SmartCanvasOp,
  ): void {
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.kind === 'smart' && l.smart && smartOp) {
          l.smart = { ...l.smart, ...remapSmart(l.smart, smartOp, this.width, this.height, w, h) };
          l.x = 0; l.y = 0;
          if (l.mask) {
            const m = createSurface(w, h);
            m.ctx.save(); apply(m.ctx);
            m.ctx.drawImage(l.mask.canvas, 0, 0);
            m.ctx.restore();
            l.mask = m;
          }
          if (l.children) walk(l.children);
          continue;
        }
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
    this.refreshSmartLayers();
  }
}

export type SmartCanvasOp = 'rot90' | 'rot-90' | 'rot180' | 'flipH' | 'flipV';

/** Map a smart object's placement through a canvas rotate / flip. */
function remapSmart(
  s: NonNullable<Layer['smart']>, op: SmartCanvasOp,
  oldW: number, oldH: number, newW: number, newH: number,
): Partial<NonNullable<Layer['smart']>> {
  void oldW; void oldH;
  const HALF = Math.PI / 2;
  switch (op) {
    case 'rot90':
      return { cx: newW - s.cy, cy: s.cx, angle: s.angle + HALF };
    case 'rot-90':
      return { cx: s.cy, cy: newH - s.cx, angle: s.angle - HALF };
    case 'rot180':
      return { cx: newW - s.cx, cy: newH - s.cy, angle: s.angle + Math.PI };
    case 'flipH':
      return { cx: newW - s.cx, angle: -s.angle, scaleX: -s.scaleX };
    case 'flipV':
      return { cy: newH - s.cy, angle: -s.angle, scaleY: -s.scaleY };
  }
}
