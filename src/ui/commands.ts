import type { App } from '../core/app';
import { PhotoDoc } from '../core/document';
import type { AdjustmentSpec, Layer } from '../core/types';
import {
  createAdjustmentLayer, createGroupLayer, createRasterLayer, duplicateLayer,
  findParent, flattenLayers, layerKindLabel,
} from '../core/layer';
import { layerBounds } from '../core/guides';
import { fitImageToLimit } from '../core/limits';
import {
  createPattern, loadPatterns, savePatterns, MAX_PATTERN,
} from '../core/patterns';
import { refreshPatternOptions } from '../tools/paint';
import type { Rect } from '../core/geometry';
import { renderShapeLayer, transformPathPoints } from '../core/shape';
import { cloneSurface, createSurface, opaqueBounds } from '../core/surface';
import { compositeLayers } from '../core/compositor';
import { maskFromCoverage, coverageFromMask, maskAlpha } from '../core/mask';
import { rgbCss } from '../core/color';
import { ADJUSTMENT_LABELS, applyAdjustment, defaultAdjustment } from '../filters/adjustments';
import { FILTERS, getFilter } from '../filters/registry';
import {
  copyToClipboard, exportDocument, loadImageFile, loadProject, pickOpenFiles,
  saveProject, type PickedFile,
} from '../io/files';
import { transformTool, cropTool, getTool } from '../tools';
import { renderTextLayer } from '../core/text';
import { confirmDialog, openModal } from './modal';
import { el } from './dom';
import {
  aboutDialog, canvasSizeDialog, colorRangeDialog, exportDialog, fillDialog,
  imageSizeDialog, layerStyleDialog, modifySelectionDialog, newDocumentDialog,
  shortcutsDialog, strokeDialog,
} from './dialogs/document';
import { adjustmentDialog, filterDialog, repeatLastFilter, applyAdjustmentNow } from './dialogs/pixel-op';
import { cmd, type Cmd as CmdType } from './command-types';
import { VECTOR_COMMANDS } from './commands-vector';

export type { Cmd } from './command-types';

const hasDoc = (app: App): boolean => app.activeDoc() !== null;
const hasSelection = (app: App): boolean => app.activeDoc()?.selection.active ?? false;
const canPaint = (app: App): boolean => app.activeDoc()?.paintTarget() !== null
  && app.activeDoc()?.paintTarget() !== undefined;
const hasRaster = (app: App): boolean => {
  const l = app.activeDoc()?.activeLayer();
  return !!l && !!l.surface && !l.locked;
};

/** Flattened pixels of the current selection on the active layer. */
function extractSelection(app: App, merged: boolean): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const doc = app.activeDoc();
  if (!doc) return null;
  const src = merged ? doc.render() : (doc.activeLayer()?.surface ?? null);
  if (!src) return null;
  const layer = doc.activeLayer();
  const ox = merged ? 0 : (layer?.x ?? 0);
  const oy = merged ? 0 : (layer?.y ?? 0);

  const full = createSurface(doc.width, doc.height);
  full.ctx.drawImage(src.canvas, ox, oy);
  if (doc.selection.active) {
    full.ctx.globalCompositeOperation = 'destination-in';
    full.ctx.drawImage(doc.selection.toSurface().canvas, 0, 0);
  }
  const b = doc.selection.bounds() ?? opaqueBounds(full);
  if (!b) return null;
  const out = createSurface(b.w, b.h);
  out.ctx.drawImage(full.canvas, -b.x, -b.y);
  return { canvas: out.canvas, x: b.x, y: b.y };
}

function clearSelectionPixels(app: App, label: string): void {
  const doc = app.activeDoc();
  const target = doc?.paintTarget();
  if (!doc || !target) return;
  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  // Masks and Quick Mask are opaque greyscale, so clearing means
  // painting the background colour rather than erasing alpha.
  const erase = target.slot === 'pixels';
  dest.ctx.save();
  if (target.clipToSelection && doc.selection.active) {
    if (erase) {
      dest.ctx.globalCompositeOperation = 'destination-out';
      dest.ctx.drawImage(doc.selection.toSurface().canvas, -target.offX, -target.offY);
    } else {
      const fill = createSurface(dest.w, dest.h);
      fill.ctx.fillStyle = rgbCss(app.background);
      fill.ctx.fillRect(0, 0, fill.w, fill.h);
      fill.ctx.globalCompositeOperation = 'destination-in';
      fill.ctx.drawImage(doc.selection.toSurface().canvas, -target.offX, -target.offY);
      dest.ctx.drawImage(fill.canvas, 0, 0);
    }
  } else if (erase) {
    dest.ctx.clearRect(0, 0, dest.w, dest.h);
  } else {
    dest.ctx.fillStyle = rgbCss(app.background);
    dest.ctx.fillRect(0, 0, dest.w, dest.h);
  }
  dest.ctx.restore();
  doc.commit(label);
  app.changed();
}

function fillWith(app: App, which: 'foreground' | 'background'): void {
  const doc = app.activeDoc();
  const target = doc?.paintTarget();
  if (!doc || !target) return;
  const color = which === 'foreground' ? app.foreground : app.background;
  const paint = createSurface(doc.width, doc.height);
  paint.ctx.fillStyle = rgbCss(color);
  paint.ctx.fillRect(0, 0, paint.w, paint.h);
  if (target.clipToSelection && doc.selection.active) {
    paint.ctx.globalCompositeOperation = 'destination-in';
    paint.ctx.drawImage(doc.selection.toSurface().canvas, 0, 0);
  }
  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.drawImage(paint.canvas, -target.offX, -target.offY);
  doc.commit(which === 'foreground' ? '填入前景色' : '填入背景色');
  app.changed();
}

// ---- layer operations ------------------------------------------------------

export function addLayer(app: App, layer: Layer, label: string): void {
  const doc = app.activeDoc();
  if (!doc) return;
  doc.insertLayerAbove(layer, doc.activeLayerId);
  doc.commit(label);
  app.changed();
}

function mergeDown(app: App): void {
  const doc = app.activeDoc();
  if (!doc || !doc.activeLayerId) return;
  const found = findParent(doc.layers, doc.activeLayerId);
  if (!found || found.index === 0) { app.toast('下方沒有可合併的圖層', 'error'); return; }
  const upper = found.list[found.index];
  const lower = found.list[found.index - 1];
  if (lower.kind === 'group' || upper.kind === 'group') {
    app.toast('群組圖層請先點陣化', 'error');
    return;
  }
  const merged = compositeLayers([lower, { ...upper, clipped: false }], {
    width: doc.width, height: doc.height,
  });
  const layer = createRasterLayer(lower.name, doc.width, doc.height, merged);
  layer.opacity = 1;
  layer.blend = 'normal';
  found.list.splice(found.index - 1, 2, layer);
  doc.activeLayerId = layer.id;
  doc.commit('向下合併');
  app.changed();
}

function mergeVisible(app: App): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const merged = compositeLayers(doc.layers, { width: doc.width, height: doc.height });
  const keep = doc.layers.filter((l) => !l.visible);
  const layer = createRasterLayer('合併圖層', doc.width, doc.height, merged);
  doc.layers = [...keep, layer];
  doc.activeLayerId = layer.id;
  doc.commit('合併可見圖層');
  app.changed();
}

function flattenImage(app: App): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const merged = compositeLayers(doc.layers, { width: doc.width, height: doc.height });
  const flat = createSurface(doc.width, doc.height);
  flat.ctx.fillStyle = '#ffffff';
  flat.ctx.fillRect(0, 0, flat.w, flat.h);
  flat.ctx.drawImage(merged.canvas, 0, 0);
  const layer = createRasterLayer('背景', doc.width, doc.height, flat);
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  doc.commit('影像平面化');
  app.changed();
}

/**
 * Refuse a destructive pixel edit on a layer that would just redraw over it.
 * Rasterizing first is the way out, exactly as in Photoshop.
 */
function guardPixelEdit(app: App, layer: Layer): boolean {
  if (!PhotoDoc.regenerates(layer)) return true;
  app.toast(`${layerKindLabel(layer)}請先點陣化才能直接修改像素`, 'error');
  return false;
}

export type AlignEdge =
  | 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';

/**
 * Shift a layer by a document-space delta. Most layers just move their origin;
 * a group carries its children, and a shape folds the move into its geometry
 * so the path and the pixels stay in step.
 */
export function moveLayerBy(doc: PhotoDoc, layer: Layer, dx: number, dy: number): void {
  if (!dx && !dy) return;
  if (layer.kind === 'group') {
    for (const child of layer.children ?? []) moveLayerBy(doc, child, dx, dy);
    return;
  }
  layer.x += dx;
  layer.y += dy;
  if (layer.kind === 'shape' && layer.shape) renderShapeLayer(layer, doc.width, doc.height);
}

/** Why this layer cannot be nudged into place, phrased for the user. */
export function moveBlockReason(layer: Layer): string | null {
  if (layer.locked) return '圖層已鎖定';
  // Type on a path takes its position from the curve, not from the layer.
  if (layer.text?.onPath) return '沿路徑的文字要改路徑或起點位移，不能直接對齊';
  if (!layer.surface && layer.kind !== 'group') return '這個圖層沒有可對齊的內容';
  return null;
}

/** The rectangle everything lines up against: the selection, else the canvas. */
export function alignTarget(doc: PhotoDoc): Rect {
  return doc.selection.bounds() ?? { x: 0, y: 0, w: doc.width, h: doc.height };
}

/** How far `box` has to move to sit against `edge` of `into`. */
export function alignDelta(box: Rect, into: Rect, edge: AlignEdge): { dx: number; dy: number } {
  switch (edge) {
    case 'left': return { dx: into.x - box.x, dy: 0 };
    case 'right': return { dx: into.x + into.w - (box.x + box.w), dy: 0 };
    case 'centerH': return { dx: into.x + (into.w - box.w) / 2 - box.x, dy: 0 };
    case 'top': return { dx: 0, dy: into.y - box.y };
    case 'bottom': return { dx: 0, dy: into.y + into.h - (box.y + box.h) };
    case 'centerV': return { dx: 0, dy: into.y + (into.h - box.h) / 2 - box.y };
  }
}

/**
 * Even gaps between the outer two boxes, Photoshop's "distribute spacing".
 * Returns the shift for each input box, in the order they were given.
 */
export function distributeDeltas(
  boxes: Rect[], axis: 'h' | 'v',
): { dx: number; dy: number }[] {
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return out;
  const pos = (r: Rect): number => (axis === 'h' ? r.x : r.y);
  const size = (r: Rect): number => (axis === 'h' ? r.w : r.h);
  const order = boxes.map((r, i) => ({ r, i })).sort((a, b) => pos(a.r) - pos(b.r));
  const first = order[0].r, last = order[order.length - 1].r;
  const span = (pos(last) + size(last)) - pos(first);
  const used = order.reduce((n, o) => n + size(o.r), 0);
  const gap = (span - used) / (order.length - 1);
  let cursor = pos(first);
  for (const o of order) {
    const shift = cursor - pos(o.r);
    if (axis === 'h') out[o.i].dx = shift; else out[o.i].dy = shift;
    cursor += size(o.r) + gap;
  }
  return out;
}

/**
 * Siblings of the active layer that have somewhere to go. A layer whose
 * content fills the canvas — a background — is left out: it cannot be spaced
 * against anything, and including it drags everything else into a heap.
 */
function alignSiblings(doc: PhotoDoc): Layer[] {
  const active = doc.activeLayer();
  if (!active) return [];
  const found = findParent(doc.layers, active.id);
  const list = found ? found.list : doc.layers;
  return list.filter((l) => {
    if (!l.visible || moveBlockReason(l)) return false;
    const b = layerBounds(l);
    return !!b && (b.w < doc.width || b.h < doc.height);
  });
}

function alignActiveLayer(app: App, edge: AlignEdge): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer) return;
  const why = moveBlockReason(layer);
  if (why) { app.toast(why, 'error'); return; }
  const box = layerBounds(layer);
  if (!box) { app.toast('這個圖層沒有可對齊的內容', 'error'); return; }
  const { dx, dy } = alignDelta(box, alignTarget(doc), edge);
  if (!dx && !dy) { app.status('已經對齊了'); return; }
  moveLayerBy(doc, layer, Math.round(dx), Math.round(dy));
  doc.commit('對齊圖層');
  app.changed();
}

function distributeLayers(app: App, axis: 'h' | 'v'): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const layers = alignSiblings(doc);
  if (layers.length < 3) {
    app.toast('需要至少三個同層級的可見圖層才能平均分佈', 'error');
    return;
  }
  const boxes = layers.map((l) => layerBounds(l)!);
  const deltas = distributeDeltas(boxes, axis);
  let moved = false;
  layers.forEach((l, i) => {
    const dx = Math.round(deltas[i].dx), dy = Math.round(deltas[i].dy);
    if (dx || dy) { moveLayerBy(doc, l, dx, dy); moved = true; }
  });
  if (!moved) { app.status('已經平均分佈了'); return; }
  doc.commit(axis === 'h' ? '水平平均分佈' : '垂直平均分佈');
  app.changed();
}

/**
 * Edit > Define Pattern: take the selection (or the whole layer) as a tile.
 * The layer's own pixels are used rather than the composite, so a pattern
 * picked off one layer does not pick up whatever sits behind it.
 */
async function definePattern(app: App): Promise<void> {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer?.surface) {
    app.toast('請先選擇一個有像素的圖層', 'error');
    return;
  }
  const b = doc.selection.bounds();
  const x = b ? b.x - layer.x : 0;
  const y = b ? b.y - layer.y : 0;
  const w = b ? b.w : layer.surface.w;
  const h = b ? b.h : layer.surface.h;
  if (w < 1 || h < 1) { app.toast('選取範圍太小', 'error'); return; }
  if (w > MAX_PATTERN || h > MAX_PATTERN) {
    app.status(`圖樣最大為 ${MAX_PATTERN} px，超出的部分已裁掉`);
  }

  const input = el('input', { type: 'text', value: `圖樣 ${loadPatterns().length + 1}` }) as HTMLInputElement;
  if (await openModal({ title: '定義圖樣', body: input, width: 320 }) !== 'ok') return;

  const entry = createPattern(input.value.trim(), layer.surface, x, y, w, h);
  savePatterns([...loadPatterns(), entry]);
  refreshPatternOptions();
  app.events.emit('options-changed', undefined);
  app.status(`已定義圖樣「${entry.name}」（${entry.width} × ${entry.height} px）`);
  app.changed();
}

function rasterizeLayer(app: App): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer) return;
  if (layer.kind === 'raster') { app.toast('此圖層已是點陣圖層'); return; }
  const rendered = compositeLayers([{ ...layer, opacity: 1, blend: 'normal', clipped: false }], {
    width: doc.width, height: doc.height,
  });
  const found = findParent(doc.layers, layer.id);
  if (!found) return;
  const next = createRasterLayer(layer.name, doc.width, doc.height, rendered);
  next.opacity = layer.opacity;
  next.blend = layer.blend;
  next.clipped = layer.clipped;
  found.list.splice(found.index, 1, next);
  doc.activeLayerId = next.id;
  doc.commit('點陣化圖層');
  app.changed();
}

function groupLayers(app: App): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer) return;
  const found = findParent(doc.layers, layer.id);
  if (!found) return;
  const group = createGroupLayer('群組');
  found.list.splice(found.index, 1, group);
  group.children = [layer];
  doc.activeLayerId = group.id;
  doc.commit('群組圖層');
  app.changed();
}

export function addLayerMask(app: App, mode: 'reveal' | 'hide' | 'selection'): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer) return;
  if (mode === 'selection' && !doc.selection.active) {
    app.toast('請先建立選取範圍', 'error');
    return;
  }
  layer.mask = mode === 'selection'
    ? maskFromCoverage(doc.selection.mask, doc.width, doc.height)
    : maskFromCoverage(null, doc.width, doc.height, mode === 'reveal' ? 255 : 0);
  layer.maskEnabled = true;
  doc.editingMask = true;
  doc.commit('新增圖層遮色片');
  app.changed();
}

function applyLayerMask(app: App): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer || !layer.mask || !layer.surface) return;
  if (!guardPixelEdit(app, layer)) return;
  const target = doc.mutableSurface(layer);
  target.ctx.save();
  target.ctx.globalCompositeOperation = 'destination-in';
  target.ctx.drawImage(maskAlpha(layer.mask).canvas, -layer.x, -layer.y);
  target.ctx.restore();
  layer.mask = null;
  doc.editingMask = false;
  doc.commit('套用圖層遮色片');
  app.changed();
}

function autoTone(app: App, mode: 'tone' | 'contrast'): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer?.surface) return;
  if (!guardPixelEdit(app, layer)) return;
  const img = layer.surface.ctx.getImageData(0, 0, layer.surface.w, layer.surface.h);
  const d = img.data;
  const channels: [number, number][] = [[255, 0], [255, 0], [255, 0]];
  let total = 0;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) hist[c][d[i + c]]++;
    total++;
  }
  if (total === 0) return;
  const cut = Math.max(1, Math.floor(total * 0.005));
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[c][v]; if (acc > cut) { channels[c][0] = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[c][v]; if (acc > cut) { channels[c][1] = v; break; } }
  }
  if (mode === 'contrast') {
    // One shared range keeps the colour balance untouched.
    const lo = Math.min(...channels.map((c) => c[0]));
    const hi = Math.max(...channels.map((c) => c[1]));
    for (const c of channels) { c[0] = lo; c[1] = hi; }
  }
  const luts = channels.map(([lo, hi]) => {
    const lut = new Uint8ClampedArray(256);
    const span = Math.max(1, hi - lo);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, ((v - lo) / span) * 255));
    return lut;
  });
  for (let i = 0; i < d.length; i += 4) {
    d[i] = luts[0][d[i]];
    d[i + 1] = luts[1][d[i + 1]];
    d[i + 2] = luts[2][d[i + 2]];
  }
  const target = doc.mutableSurface(layer);
  target.ctx.putImageData(img, 0, 0);
  doc.commit(mode === 'tone' ? '自動色調' : '自動對比');
  app.changed();
}

function trimTransparent(app: App): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const b = opaqueBounds(doc.render());
  if (!b) { app.toast('影像沒有不透明像素', 'error'); return; }
  doc.resizeCanvas(b.w, b.h, -b.x, -b.y);
  doc.commit('修剪');
  app.changed();
  app.events.emit('view-changed', undefined);
}

function rotateCanvas(app: App, deg: 90 | -90 | 180): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const swap = deg !== 180;
  const w = swap ? doc.height : doc.width;
  const h = swap ? doc.width : doc.height;
  doc.selection.clear();
  doc.transformAll(w, h, (ctx) => {
    if (deg === 90) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
    else if (deg === -90) { ctx.translate(0, h); ctx.rotate(-Math.PI / 2); }
    else { ctx.translate(w, h); ctx.rotate(Math.PI); }
  }, deg === 90 ? 'rot90' : deg === -90 ? 'rot-90' : 'rot180');
  doc.commit(`旋轉版面 ${deg}°`);
  app.changed();
  app.events.emit('view-changed', undefined);
}

function flipCanvas(app: App, axis: 'h' | 'v'): void {
  const doc = app.activeDoc();
  if (!doc) return;
  doc.selection.clear();
  doc.transformAll(doc.width, doc.height, (ctx) => {
    if (axis === 'h') { ctx.translate(doc.width, 0); ctx.scale(-1, 1); }
    else { ctx.translate(0, doc.height); ctx.scale(1, -1); }
  }, axis === 'h' ? 'flipH' : 'flipV');
  doc.commit(axis === 'h' ? '水平翻轉版面' : '垂直翻轉版面');
  app.changed();
}

function flipLayer(app: App, axis: 'h' | 'v'): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer?.surface) return;
  if (layer.kind === 'shape' && layer.shape) {
    // Mirror the geometry inside its own bounds so the shape stays editable.
    const b = layerBounds(layer) ?? { x: 0, y: 0, w: doc.width, h: doc.height };
    transformPathPoints(layer.shape.path, (p) => ({
      x: axis === 'h' ? b.x * 2 + b.w - p.x : p.x,
      y: axis === 'v' ? b.y * 2 + b.h - p.y : p.y,
    }));
    renderShapeLayer(layer, doc.width, doc.height);
    doc.commit(axis === 'h' ? '水平翻轉圖層' : '垂直翻轉圖層');
    app.changed();
    return;
  }
  if (!guardPixelEdit(app, layer)) return;
  const src = cloneSurface(layer.surface);
  const target = doc.mutableSurface(layer);
  target.ctx.clearRect(0, 0, target.w, target.h);
  target.ctx.save();
  if (axis === 'h') { target.ctx.translate(target.w, 0); target.ctx.scale(-1, 1); }
  else { target.ctx.translate(0, target.h); target.ctx.scale(1, -1); }
  target.ctx.drawImage(src.canvas, 0, 0);
  target.ctx.restore();
  doc.commit(axis === 'h' ? '水平翻轉圖層' : '垂直翻轉圖層');
  app.changed();
}

async function openFiles(app: App, asLayer: boolean): Promise<void> {
  const files = await pickOpenFiles('image/*,.pgraph,application/json', true);
  await openPicked(app, files, asLayer);
}

/** Open files that have already been chosen, from a dialog or from the OS. */
export async function openPicked(
  app: App, files: PickedFile[], asLayer: boolean,
): Promise<void> {
  for (const file of files) {
    try {
      if (file.name.endsWith('.pgraph')) {
        const doc = await loadProject(await file.text());
        // Remembering the path is what lets the next save go straight back
        // to the same file instead of asking again.
        doc.meta.name = file.name;
        doc.meta.filePath = file.path;
        app.addDoc(doc);
        continue;
      }
      const img = await loadImageFile(await file.blob());
      if (asLayer && app.activeDoc()) {
        const doc = app.activeDoc()!;
        const surface = createSurface(doc.width, doc.height);
        surface.ctx.drawImage(img, 0, 0);
        const layer = createRasterLayer(file.name.replace(/\.[^.]+$/, ''), doc.width, doc.height, surface);
        doc.insertLayerAbove(layer, doc.activeLayerId);
        doc.commit('置入影像');
        app.changed();
      } else {
        const size = fitImageToLimit(img);
        if (size.notice) app.toast(size.notice);
        app.addDoc(PhotoDoc.fromImage(file.name.replace(/\.[^.]+$/, ''), img, size.w, size.h));
      }
    } catch (err) {
      app.toast(err instanceof Error ? err.message : '無法開啟檔案', 'error');
    }
  }
}

async function pasteFromApp(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc || !app.clipboard) { app.toast('剪貼簿是空的', 'error'); return; }
  const surface = createSurface(doc.width, doc.height);
  surface.ctx.drawImage(app.clipboard.canvas, app.clipboard.x, app.clipboard.y);
  const layer = createRasterLayer('貼上的圖層', doc.width, doc.height, surface);
  doc.insertLayerAbove(layer, doc.activeLayerId);
  doc.commit('貼上');
  app.changed();
}

function selectionFromLayerAlpha(app: App): void {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer?.surface) return;
  const d = layer.surface.ctx.getImageData(0, 0, layer.surface.w, layer.surface.h).data;
  const cov = new Uint8Array(doc.width * doc.height);
  for (let y = 0; y < layer.surface.h; y++) {
    const dy = y + layer.y;
    if (dy < 0 || dy >= doc.height) continue;
    for (let x = 0; x < layer.surface.w; x++) {
      const dx = x + layer.x;
      if (dx < 0 || dx >= doc.width) continue;
      cov[dy * doc.width + dx] = d[(y * layer.surface.w + x) * 4 + 3];
    }
  }
  doc.selection.combine(cov, 'replace');
  doc.commit('載入圖層選取範圍');
  app.changed();
}

// ---- command registry ------------------------------------------------------

export const COMMANDS: CmdType[] = [
  // ---- file ----
  cmd('file.new', '開新檔案…', (a) => newDocumentDialog(a), { shortcut: 'Ctrl+N' }),
  cmd('file.open', '開啟舊檔…', (a) => openFiles(a, false), { shortcut: 'Ctrl+O' }),
  cmd('file.place', '置入影像為圖層…', (a) => openFiles(a, true), { enabled: hasDoc }),
  cmd('file.save', '儲存專案 (.pgraph)', async (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    if (await saveProject(doc)) a.toast('已儲存專案檔', 'success');
  }, { shortcut: 'Ctrl+S', enabled: hasDoc }),
  cmd('file.saveAs', '另存新檔…', async (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    if (await saveProject(doc, true)) a.toast('已儲存專案檔', 'success');
  }, { shortcut: 'Ctrl+Shift+Alt+S', enabled: hasDoc }),
  cmd('file.export', '轉存影像…', (a) => exportDialog(a), { shortcut: 'Ctrl+Shift+S', enabled: hasDoc }),
  cmd('file.exportPng', '快速轉存 PNG', async (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    if (await exportDocument(doc, 'png', 1)) a.toast('已轉存 PNG', 'success');
  }, { enabled: hasDoc }),
  cmd('file.close', '關閉文件', async (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    if (doc.isDirty && !(await confirmDialog('關閉文件', '文件有未儲存的變更，確定要關閉嗎？'))) return;
    a.closeDoc(doc.meta.id);
  }, { shortcut: 'Ctrl+W', enabled: hasDoc }),

  // ---- edit ----
  cmd('edit.undo', '還原', (a) => {
    const doc = a.activeDoc();
    if (doc?.undo()) { a.changed(); a.status(`還原：${doc.history.snapshots[doc.history.index].label}`); }
  }, { shortcut: 'Ctrl+Z', enabled: (a) => a.activeDoc()?.history.canUndo ?? false }),
  cmd('edit.redo', '重做', (a) => {
    const doc = a.activeDoc();
    if (doc?.redo()) { a.changed(); a.status(`重做：${doc.history.snapshots[doc.history.index].label}`); }
  }, { shortcut: 'Ctrl+Shift+Z', enabled: (a) => a.activeDoc()?.history.canRedo ?? false }),
  cmd('edit.cut', '剪下', (a) => {
    const data = extractSelection(a, false);
    if (!data) return;
    a.clipboard = data;
    clearSelectionPixels(a, '剪下');
  }, { shortcut: 'Ctrl+X', enabled: hasRaster }),
  cmd('edit.copy', '拷貝', async (a) => {
    const data = extractSelection(a, false);
    if (!data) return;
    a.clipboard = data;
    try { await copyToClipboard({ canvas: data.canvas, ctx: data.canvas.getContext('2d')!, w: data.canvas.width, h: data.canvas.height }); } catch { /* clipboard permission denied */ }
    a.toast('已拷貝到剪貼簿', 'success');
  }, { shortcut: 'Ctrl+C', enabled: hasRaster }),
  cmd('edit.copyMerged', '拷貝合併', (a) => {
    const data = extractSelection(a, true);
    if (data) { a.clipboard = data; a.toast('已拷貝合併影像', 'success'); }
  }, { shortcut: 'Ctrl+Shift+C', enabled: hasDoc }),
  cmd('edit.paste', '貼上', (a) => pasteFromApp(a), { shortcut: 'Ctrl+V', enabled: hasDoc }),
  cmd('edit.clear', '清除', (a) => clearSelectionPixels(a, '清除'), { shortcut: 'Delete', enabled: canPaint }),
  cmd('edit.fill', '填滿…', (a) => fillDialog(a), { shortcut: 'Shift+F5', enabled: canPaint }),
  cmd('edit.definePattern', '定義圖樣…', (a) => definePattern(a), { enabled: hasRaster }),
  cmd('edit.fillFg', '填入前景色', (a) => fillWith(a, 'foreground'), { shortcut: 'Alt+Backspace', enabled: canPaint }),
  cmd('edit.fillBg', '填入背景色', (a) => fillWith(a, 'background'), { shortcut: 'Ctrl+Backspace', enabled: canPaint }),
  cmd('edit.stroke', '筆畫…', (a) => strokeDialog(a), { enabled: canPaint }),
  cmd('edit.transform', '任意變形', (a) => { transformTool.start(a); }, { shortcut: 'Ctrl+T', enabled: hasRaster }),
  cmd('edit.flipLayerH', '水平翻轉圖層', (a) => flipLayer(a, 'h'), { enabled: hasRaster }),
  cmd('edit.flipLayerV', '垂直翻轉圖層', (a) => flipLayer(a, 'v'), { enabled: hasRaster }),

  // ---- image ----
  cmd('image.size', '影像尺寸…', (a) => imageSizeDialog(a), { shortcut: 'Ctrl+Alt+I', enabled: hasDoc }),
  cmd('image.canvas', '版面尺寸…', (a) => canvasSizeDialog(a), { shortcut: 'Ctrl+Alt+C', enabled: hasDoc }),
  cmd('image.rotate90', '版面旋轉 90° 順時針', (a) => rotateCanvas(a, 90), { enabled: hasDoc }),
  cmd('image.rotate-90', '版面旋轉 90° 逆時針', (a) => rotateCanvas(a, -90), { enabled: hasDoc }),
  cmd('image.rotate180', '版面旋轉 180°', (a) => rotateCanvas(a, 180), { enabled: hasDoc }),
  cmd('image.flipH', '水平翻轉版面', (a) => flipCanvas(a, 'h'), { enabled: hasDoc }),
  cmd('image.flipV', '垂直翻轉版面', (a) => flipCanvas(a, 'v'), { enabled: hasDoc }),
  cmd('image.cropToSelection', '裁切至選取範圍', (a) => {
    const doc = a.activeDoc();
    const b = doc?.selection.bounds();
    if (!doc || !b) { a.toast('請先建立選取範圍', 'error'); return; }
    doc.resizeCanvas(b.w, b.h, -b.x, -b.y);
    doc.selection.clear();
    doc.commit('裁切');
    a.changed();
    a.events.emit('view-changed', undefined);
  }, { enabled: hasSelection }),
  cmd('image.trim', '修剪透明邊界', (a) => trimTransparent(a), { enabled: hasDoc }),
  cmd('image.autoTone', '自動色調', (a) => autoTone(a, 'tone'), { shortcut: 'Ctrl+Shift+L', enabled: hasRaster }),
  cmd('image.autoContrast', '自動對比', (a) => autoTone(a, 'contrast'), { enabled: hasRaster }),

  // ---- layer ----
  cmd('layer.new', '新增圖層', (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    addLayer(a, createRasterLayer(`圖層 ${flattenLayers(doc.layers).length + 1}`, doc.width, doc.height), '新增圖層');
  }, { shortcut: 'Ctrl+Shift+N', enabled: hasDoc }),
  cmd('layer.duplicate', '複製圖層', (a) => {
    const doc = a.activeDoc();
    const layer = doc?.activeLayer();
    if (!doc || !layer) return;
    addLayer(a, duplicateLayer(layer), '複製圖層');
  }, { shortcut: 'Ctrl+J', enabled: hasDoc }),
  cmd('layer.delete', '刪除圖層', (a) => {
    const doc = a.activeDoc();
    if (!doc || !doc.activeLayerId) return;
    if (flattenLayers(doc.layers).length <= 1) { a.toast('至少要保留一個圖層', 'error'); return; }
    doc.removeLayer(doc.activeLayerId);
    doc.commit('刪除圖層');
    a.changed();
  }, { enabled: hasDoc }),
  cmd('layer.rasterize', '點陣化圖層', (a) => rasterizeLayer(a), { enabled: hasDoc }),
  cmd('layer.alignLeft', '靠左對齊', (a) => alignActiveLayer(a, 'left'), { enabled: hasRaster }),
  cmd('layer.alignCenterH', '水平置中對齊', (a) => alignActiveLayer(a, 'centerH'), { enabled: hasRaster }),
  cmd('layer.alignRight', '靠右對齊', (a) => alignActiveLayer(a, 'right'), { enabled: hasRaster }),
  cmd('layer.alignTop', '靠上對齊', (a) => alignActiveLayer(a, 'top'), { enabled: hasRaster }),
  cmd('layer.alignCenterV', '垂直置中對齊', (a) => alignActiveLayer(a, 'centerV'), { enabled: hasRaster }),
  cmd('layer.alignBottom', '靠下對齊', (a) => alignActiveLayer(a, 'bottom'), { enabled: hasRaster }),
  cmd('layer.distributeH', '水平平均分佈', (a) => distributeLayers(a, 'h'), { enabled: hasDoc }),
  cmd('layer.distributeV', '垂直平均分佈', (a) => distributeLayers(a, 'v'), { enabled: hasDoc }),
  cmd('layer.group', '群組圖層', (a) => groupLayers(a), { shortcut: 'Ctrl+G', enabled: hasDoc }),
  cmd('layer.mergeDown', '向下合併', (a) => mergeDown(a), { shortcut: 'Ctrl+E', enabled: hasDoc }),
  cmd('layer.mergeVisible', '合併可見圖層', (a) => mergeVisible(a), { shortcut: 'Ctrl+Shift+E', enabled: hasDoc }),
  cmd('layer.flatten', '影像平面化', (a) => flattenImage(a), { enabled: hasDoc }),
  cmd('layer.maskReveal', '圖層遮色片：顯示全部', (a) => addLayerMask(a, 'reveal'), { enabled: hasDoc }),
  cmd('layer.maskHide', '圖層遮色片：隱藏全部', (a) => addLayerMask(a, 'hide'), { enabled: hasDoc }),
  cmd('layer.maskSelection', '圖層遮色片：顯示選取範圍', (a) => addLayerMask(a, 'selection'), { enabled: hasSelection }),
  cmd('layer.maskApply', '套用圖層遮色片', (a) => applyLayerMask(a), {
    enabled: (a) => !!a.activeDoc()?.activeLayer()?.mask,
  }),
  cmd('layer.maskDelete', '刪除圖層遮色片', (a) => {
    const doc = a.activeDoc();
    const layer = doc?.activeLayer();
    if (!doc || !layer?.mask) return;
    layer.mask = null;
    doc.editingMask = false;
    doc.commit('刪除圖層遮色片');
    a.changed();
  }, { enabled: (a) => !!a.activeDoc()?.activeLayer()?.mask }),
  cmd('layer.clip', '建立/釋放剪裁遮色片', (a) => {
    const doc = a.activeDoc();
    const layer = doc?.activeLayer();
    if (!doc || !layer) return;
    layer.clipped = !layer.clipped;
    doc.commit(layer.clipped ? '建立剪裁遮色片' : '釋放剪裁遮色片');
    a.changed();
  }, { shortcut: 'Ctrl+Alt+G', enabled: hasDoc }),
  cmd('layer.style', '圖層樣式…', (a) => layerStyleDialog(a), { enabled: hasDoc }),
  cmd('layer.up', '上移圖層', (a) => {
    const doc = a.activeDoc();
    if (doc?.activeLayerId && doc.moveLayer(doc.activeLayerId, 1)) { doc.commit('上移圖層'); a.changed(); }
  }, { shortcut: 'Ctrl+]', enabled: hasDoc }),
  cmd('layer.down', '下移圖層', (a) => {
    const doc = a.activeDoc();
    if (doc?.activeLayerId && doc.moveLayer(doc.activeLayerId, -1)) { doc.commit('下移圖層'); a.changed(); }
  }, { shortcut: 'Ctrl+[', enabled: hasDoc }),

  // ---- select ----
  cmd('select.all', '全部', (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    doc.selection.selectAll();
    doc.commit('全選');
    a.changed();
  }, { shortcut: 'Ctrl+A', enabled: hasDoc }),
  cmd('select.none', '取消選取', (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    doc.selection.clear();
    doc.commit('取消選取');
    a.changed();
  }, { shortcut: 'Ctrl+D', enabled: hasSelection }),
  cmd('select.inverse', '反轉選取範圍', (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    doc.selection.invert();
    doc.commit('反轉選取範圍');
    a.changed();
  }, { shortcut: 'Ctrl+Shift+I', enabled: hasDoc }),
  cmd('select.feather', '羽化…', (a) => modifySelectionDialog(a, 'feather'), {
    shortcut: 'Shift+F6', enabled: hasSelection,
  }),
  cmd('select.expand', '擴張…', (a) => modifySelectionDialog(a, 'expand'), { enabled: hasSelection }),
  cmd('select.contract', '縮減…', (a) => modifySelectionDialog(a, 'contract'), { enabled: hasSelection }),
  cmd('select.border', '邊界…', (a) => modifySelectionDialog(a, 'border'), { enabled: hasSelection }),
  cmd('select.smooth', '平滑…', (a) => modifySelectionDialog(a, 'smooth'), { enabled: hasSelection }),
  cmd('select.colorRange', '顏色範圍…', (a) => colorRangeDialog(a), { enabled: hasDoc }),
  cmd('select.fromLayer', '載入圖層透明度為選取範圍', (a) => selectionFromLayerAlpha(a), { enabled: hasDoc }),
  cmd('select.fromMask', '載入遮色片為選取範圍', (a) => {
    const doc = a.activeDoc();
    const layer = doc?.activeLayer();
    if (!doc || !layer?.mask) return;
    doc.selection.combine(coverageFromMask(layer.mask), 'replace');
    doc.commit('載入遮色片選取範圍');
    a.changed();
  }, { enabled: (a) => !!a.activeDoc()?.activeLayer()?.mask }),

  // ---- filter ----
  cmd('filter.repeat', '重複上次濾鏡', (a) => repeatLastFilter(a), { shortcut: 'Ctrl+F', enabled: hasRaster }),

  // ---- view ----
  cmd('view.zoomIn', '放大', (a) => {
    const v = a.view();
    v.zoom = Math.min(32, v.zoom * 1.5);
    a.events.emit('view-changed', undefined);
  }, { shortcut: 'Ctrl++', enabled: hasDoc }),
  cmd('view.zoomOut', '縮小', (a) => {
    const v = a.view();
    v.zoom = Math.max(0.01, v.zoom / 1.5);
    a.events.emit('view-changed', undefined);
  }, { shortcut: 'Ctrl+-', enabled: hasDoc }),
  cmd('view.actual', '實際尺寸 (100%)', (a) => {
    const v = a.view();
    v.zoom = 1;
    a.events.emit('view-changed', undefined);
  }, { shortcut: 'Ctrl+1', enabled: hasDoc }),
  cmd('view.grid', '顯示格點', (a) => {
    const v = a.view();
    v.showGrid = !v.showGrid;
    a.events.emit('view-changed', undefined);
  }, { shortcut: "Ctrl+'", enabled: hasDoc, checked: (a) => a.view().showGrid }),
  cmd('view.rulers', '顯示尺標', (a) => {
    const v = a.view();
    v.showRulers = !v.showRulers;
    a.events.emit('view-changed', undefined);
  }, { shortcut: 'Ctrl+R', enabled: hasDoc, checked: (a) => a.view().showRulers }),

  // ---- help ----
  cmd('help.about', '關於 Photograp', () => aboutDialog()),
  cmd('help.shortcuts', '鍵盤快速鍵…', () => shortcutsDialog(), { shortcut: 'F1' }),
];

// Adjustment commands (destructive + adjustment layer variants).
const ADJUSTMENT_TYPES = Object.keys(ADJUSTMENT_LABELS) as AdjustmentSpec['type'][];
for (const type of ADJUSTMENT_TYPES) {
  COMMANDS.push(cmd(`adjust.${type}`, ADJUSTMENT_LABELS[type], (a) => {
    if (type === 'invert') {
      applyAdjustmentNow(a, defaultAdjustment('invert'), ADJUSTMENT_LABELS.invert);
      return;
    }
    return adjustmentDialog(a, type);
  }, { enabled: hasRaster, shortcut: type === 'invert' ? 'Ctrl+I' : undefined }));

  COMMANDS.push(cmd(`adjustLayer.${type}`, ADJUSTMENT_LABELS[type], (a) => {
    const doc = a.activeDoc();
    if (!doc) return;
    addLayer(a, createAdjustmentLayer(ADJUSTMENT_LABELS[type], defaultAdjustment(type)), '新增調整圖層');
  }, { enabled: hasDoc }));
}

// Filter commands, generated from the filter registry.
for (const f of FILTERS) {
  COMMANDS.push(cmd(`filter.${f.id}`, `${f.label}…`, async (a) => {
    const def = getFilter(f.id);
    if (def) await filterDialog(a, def);
  }, { enabled: hasRaster }));
}

COMMANDS.push(...VECTOR_COMMANDS);

const commandMap = new Map(COMMANDS.map((c) => [c.id, c]));
export const getCommand = (id: string): CmdType | undefined => commandMap.get(id);

/** Register a command that needs a live UI object (e.g. the canvas view). */
export function registerCommand(c: CmdType): void {
  const existing = COMMANDS.findIndex((x) => x.id === c.id);
  if (existing >= 0) COMMANDS.splice(existing, 1, c);
  else COMMANDS.push(c);
  commandMap.set(c.id, c);
}

export function runCommand(app: App, id: string): void {
  const c = commandMap.get(id);
  if (!c) return;
  if (c.enabled && !c.enabled(app)) return;
  void c.run(app);
}

export const commandEnabled = (app: App, id: string): boolean => {
  const c = commandMap.get(id);
  return c ? (c.enabled ? c.enabled(app) : true) : false;
};

/** Re-render a text layer after its style changed. */
export function refreshTextLayer(app: App, layer: Layer, label: string): void {
  const doc = app.activeDoc();
  if (!doc || !layer.text) return;
  renderTextLayer(layer, doc.width, doc.height, doc.paths);
  doc.commit(label);
  app.changed();
}

export { cropTool, getTool, applyAdjustment, maskFromCoverage };
