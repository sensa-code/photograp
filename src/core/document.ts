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
import type { Guide } from './guides';
import { renderChannelView, type AlphaChannel, type ChannelView } from './channels';
import { renderSmartLayer } from './smart';
import { renderTextLayer } from './text';
import type { LayerComp } from './comps';
import { renderShapeLayer, transformPathPoints } from './shape';
import {
  createQuickMask, quickMaskCoverage, quickMaskIsFull, renderQuickMaskOverlay, type QuickMask,
} from './quickmask';

export interface LivePreview {
  layerId: string;
  surface: Surface;
  /** The preview replaces the layer mask rather than its pixels. */
  isMask: boolean;
}

/** Where a painting tool writes: layer pixels, a layer mask, or Quick Mask. */
export type PaintSlot = 'pixels' | 'mask' | 'quickmask';

export interface PaintTarget {
  layer: Layer | null;
  surface: Surface;
  slot: PaintSlot;
  /** Offset of the target surface inside the document. */
  offX: number;
  offY: number;
  /** Quick Mask edits the selection itself, so it is never clipped by one. */
  clipToSelection: boolean;
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
  /** Saved layer comps: named views of visibility, position and appearance. */
  comps: LayerComp[] = [];
  /** Which comp the panel is acting on; not part of the undo history. */
  activeCompId: string | null = null;

  /** Saved vector paths; the last one is usually the live work path. */
  paths: VectorPath[] = [];
  activePathId: string | null = null;
  /** Stored alpha channels (saved selections, spot masks). */
  channels: AlphaChannel[] = [];
  /** Which channel the canvas shows; not part of the undo history. */
  channelView: ChannelView = 'rgb';
  /** Ruler guides, in document coordinates. */
  guides: Guide[] = [];
  guidesLocked = false;
  /** Non-null while Quick Mask mode is on. */
  quickMask: QuickMask | null = null;
  /** In-progress edit of the quick mask, shown instead of the stored one. */
  quickMaskPreview: Surface | null = null;

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

  /**
   * The pixels of `layer` as they were in the history brush's source state,
   * with the shift needed to read them in the layer's current space. Null when
   * that state has no usable version of this layer, which is what disables the
   * history brush instead of painting something arbitrary.
   */
  historySource(layer: Layer): { surface: Surface; dx: number; dy: number } | null {
    const snap = this.history.sourceSnapshot();
    if (!snap || snap.width !== this.width || snap.height !== this.height) return null;
    const found = findParent(snap.layers, layer.id);
    const from = found ? found.list[found.index] : null;
    if (!from?.surface) return null;
    return { surface: from.surface, dx: layer.x - from.x, dy: layer.y - from.y };
  }

  /** Why the history brush has nothing to paint from, phrased for the user. */
  historySourceReason(): string | null {
    const snap = this.history.sourceSnapshot();
    if (!snap) return '沒有可用的步驟記錄來源';
    if (snap.width !== this.width || snap.height !== this.height) {
      return '來源狀態的尺寸不同，請重新指定步驟記錄來源';
    }
    const layer = this.activeLayer();
    if (!layer) return '請先選擇一個圖層';
    return this.historySource(layer) ? null : '這個圖層在來源狀態中不存在';
  }

  /** Restore a parked snapshot as a new step, so it can be undone. */
  restoreNamed(id: string): boolean {
    const entry = this.history.named.find((n) => n.id === id);
    if (!entry) return false;
    this.history.restore(this, entry.snap);
    this.commit(`快照：${entry.name}`);
    return true;
  }

  /** Re-render every layer whose pixels are generated from other data. */
  refreshGeneratedLayers(): void {
    for (const l of this.allLayers()) {
      if (l.kind === 'smart' && l.smart) renderSmartLayer(l, this.width, this.height);
      else if (l.kind === 'shape' && l.shape) renderShapeLayer(l, this.width, this.height);
      else if (l.kind === 'text' && l.text?.onPath) {
        renderTextLayer(l, this.width, this.height, this.paths);
      }
    }
  }

  /**
   * Re-render only the type bound to a path, which is what editing anchors
   * needs: the glyphs have to follow the curve as it is dragged.
   */
  refreshTextOnPath(pathId?: string): void {
    for (const l of this.allLayers()) {
      const bind = l.kind === 'text' ? l.text?.onPath : undefined;
      if (bind && (!pathId || bind.pathId === pathId)) {
        renderTextLayer(l, this.width, this.height, this.paths);
      }
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
  paintTarget(): PaintTarget | null {
    // Quick Mask takes over every painting tool while it is on.
    if (this.quickMask) {
      return {
        layer: null, surface: this.quickMask.surface, slot: 'quickmask',
        offX: 0, offY: 0, clipToSelection: false,
      };
    }
    const layer = this.activeLayer();
    if (!layer || layer.locked) return null;
    if (this.editingMask && layer.mask) {
      return { layer, surface: layer.mask, slot: 'mask', offX: 0, offY: 0, clipToSelection: true };
    }
    // Smart objects, shape layers and type on a path re-render from their own
    // source data, so direct paint would be thrown away. Rasterize first.
    if (PhotoDoc.regenerates(layer)) return null;
    if (!layer.surface) return null;
    return {
      layer, surface: layer.surface, slot: 'pixels',
      offX: layer.x, offY: layer.y, clipToSelection: true,
    };
  }

  /**
   * Shape layers and smart objects rebuild their pixels from their own source
   * data, so anything written straight into `layer.surface` is lost on the
   * next redraw. Destructive commands check this before touching a layer.
   */
  static regenerates(layer: Layer): boolean {
    return layer.kind === 'shape' || layer.kind === 'smart' || !!layer.text?.onPath;
  }

  /** Why `paintTarget()` came back empty, phrased for the user. */
  paintBlockReason(): string | null {
    if (this.paintTarget()) return null;
    const layer = this.activeLayer();
    if (!layer) return '請先選擇一個圖層';
    if (layer.locked) return '圖層已鎖定，請先解除鎖定';
    if (layer.kind === 'shape') return '形狀圖層請先點陣化才能塗抹';
    if (layer.text?.onPath) return '沿路徑的文字圖層請先點陣化才能塗抹';
    if (layer.kind === 'smart') return '智慧型物件請先點陣化才能塗抹';
    if (layer.kind === 'group') return '群組圖層請先點陣化才能塗抹';
    if (!layer.surface) return '此圖層沒有可塗抹的像素';
    return '此圖層無法繪製';
  }

  /** A surface for the given slot that is safe to write into. */
  mutablePaintSurface(layer: Layer | null, slot: PaintSlot): Surface {
    if (slot === 'quickmask') return this.mutableQuickMask();
    if (!layer) throw new Error('沒有可編輯的圖層');
    return slot === 'mask' ? this.mutableMask(layer) : this.mutableSurface(layer);
  }

  /** Show work in progress for the given slot without committing it. */
  setPaintPreview(layer: Layer | null, slot: PaintSlot, surface: Surface): void {
    if (slot === 'quickmask') {
      this.quickMaskPreview = surface;
      return;
    }
    if (layer) this.livePreview = { layerId: layer.id, surface, isMask: slot === 'mask' };
  }

  clearPaintPreview(): void {
    this.livePreview = null;
    this.quickMaskPreview = null;
  }

  mutableQuickMask(): Surface {
    if (!this.quickMask) this.quickMask = createQuickMask(this.selection, this.width, this.height);
    else this.quickMask = { ...this.quickMask, surface: cloneSurface(this.quickMask.surface) };
    return this.quickMask.surface;
  }

  /** Turn Quick Mask on, seeding it from the current selection. */
  enterQuickMask(): void {
    if (this.quickMask) return;
    this.quickMask = createQuickMask(this.selection, this.width, this.height);
    this.selection.clear();
  }

  /** Turn Quick Mask off, converting the painted channel back to a selection. */
  exitQuickMask(): void {
    if (!this.quickMask) return;
    const coverage = quickMaskCoverage(this.quickMask.surface);
    this.quickMask = null;
    this.quickMaskPreview = null;
    if (quickMaskIsFull(coverage)) this.selection.clear();
    else this.selection.combine(coverage, 'replace');
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
      this.quickMask ? 'qm' : '',
    ].join('|');
    const live = this.livePreview || this.quickMaskPreview;
    if (this.cache && this.cacheKey === key && !live) return this.cache;
    let out = compositeLayers(this.layers, this.compositeOptions());
    if (this.channelView !== 'rgb' || this.channels.some((c) => c.visible)) {
      out = renderChannelView(out, this.channelView, this.channels);
    }
    if (this.quickMask) {
      out = renderQuickMaskOverlay(out, this.quickMask, this.quickMaskPreview);
    }
    if (!live) { this.cache = out; this.cacheKey = key; }
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
        } else if (l.kind === 'shape' && l.shape) {
          // Vector geometry scales exactly; the pixels are redrawn after.
          transformPathPoints(l.shape.path, (p) => ({ x: p.x * sx, y: p.y * sy }));
          l.shape.style.strokeWidth *= (sx + sy) / 2;
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
    this.guides = this.guides.map((g) => ({
      ...g,
      pos: g.axis === 'v' ? g.pos * sx : g.pos * sy,
    }));
    // Stored paths are document geometry too, and type may be riding on one.
    for (const path of this.paths) transformPathPoints(path, (q) => ({ x: q.x * sx, y: q.y * sy }));
    this.resampleQuickMask(w, h, smooth);
    this.refreshGeneratedLayers();
  }

  /** Keep the Quick Mask in step with the document geometry. */
  private resampleQuickMask(w: number, h: number, smooth: boolean): void {
    if (!this.quickMask) return;
    this.quickMask = {
      ...this.quickMask,
      surface: resampleSurface(this.quickMask.surface, w, h, smooth),
    };
    this.quickMaskPreview = null;
  }

  /** Re-place the Quick Mask when the canvas grows, shrinks or turns. */
  private redrawQuickMask(
    w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void,
  ): void {
    if (!this.quickMask) return;
    const next = createSurface(w, h);
    // New canvas area starts unselected, matching a fresh mask.
    next.ctx.fillStyle = '#000';
    next.ctx.fillRect(0, 0, w, h);
    next.ctx.save();
    draw(next.ctx);
    next.ctx.restore();
    this.quickMask = { ...this.quickMask, surface: next };
    this.quickMaskPreview = null;
  }

  /** Canvas Size: keep pixel scale, re-place layers at an offset. */
  resizeCanvas(w: number, h: number, offsetX: number, offsetY: number): void {
    const walk = (list: Layer[]): void => {
      for (const l of list) {
        if (l.kind === 'smart' && l.smart) {
          l.smart = { ...l.smart, cx: l.smart.cx + offsetX, cy: l.smart.cy + offsetY };
        }
        if (l.kind === 'shape' && l.shape) {
          transformPathPoints(l.shape.path, (p) => ({ x: p.x + offsetX, y: p.y + offsetY }));
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
    this.guides = this.guides
      .map((g) => ({ ...g, pos: g.pos + (g.axis === 'v' ? offsetX : offsetY) }))
      .filter((g) => g.pos >= 0 && g.pos <= (g.axis === 'v' ? w : h));
    for (const path of this.paths) {
      transformPathPoints(path, (q) => ({ x: q.x + offsetX, y: q.y + offsetY }));
    }
    const qmSource = this.quickMask?.surface;
    if (qmSource) this.redrawQuickMask(w, h, (ctx) => ctx.drawImage(qmSource.canvas, offsetX, offsetY));
    this.refreshGeneratedLayers();
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
        if (l.kind === 'shape' && l.shape && smartOp) {
          const map = canvasPointMap(smartOp, w, h);
          transformPathPoints(l.shape.path, map);
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
    if (smartOp) {
      const map = canvasPointMap(smartOp, w, h);
      for (const path of this.paths) transformPathPoints(path, map);
    }
    const qmSource = this.quickMask?.surface;
    if (qmSource) {
      this.redrawQuickMask(w, h, (ctx) => { apply(ctx); ctx.drawImage(qmSource.canvas, 0, 0); });
    }
    this.refreshGeneratedLayers();
  }
}

export type SmartCanvasOp = 'rot90' | 'rot-90' | 'rot180' | 'flipH' | 'flipV';

/** Map a document point through a canvas rotate / flip. */
export function canvasPointMap(
  op: SmartCanvasOp, newW: number, newH: number,
): (p: { x: number; y: number }) => { x: number; y: number } {
  switch (op) {
    case 'rot90': return (p) => ({ x: newW - p.y, y: p.x });
    case 'rot-90': return (p) => ({ x: p.y, y: newH - p.x });
    case 'rot180': return (p) => ({ x: newW - p.x, y: newH - p.y });
    case 'flipH': return (p) => ({ x: newW - p.x, y: p.y });
    case 'flipV': return (p) => ({ x: p.x, y: newH - p.y });
  }
}

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
