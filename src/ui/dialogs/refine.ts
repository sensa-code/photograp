import type { App } from '../../core/app';
import type { PhotoDoc } from '../../core/document';
import { createSurface, type Surface } from '../../core/surface';
import { maskFromCoverage } from '../../core/mask';
import { createRasterLayer } from '../../core/layer';
import {
  defaultRefine, refineIsIdentity, refineMask, scaleMask, type RefineSettings,
} from '../../core/refine';
import { el } from '../dom';
import { openModal, selectControl, sliderControl } from '../modal';

type ViewMode = 'onion' | 'black' | 'white' | 'layers' | 'mask';

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'onion', label: '疊印紅色' },
  { value: 'black', label: '黑底' },
  { value: 'white', label: '白底' },
  { value: 'layers', label: '透明背景' },
  { value: 'mask', label: '遮色片' },
];

type Output = 'selection' | 'mask' | 'layer';

const OUTPUTS: { value: Output; label: string }[] = [
  { value: 'selection', label: '選取範圍' },
  { value: 'mask', label: '圖層遮色片' },
  { value: 'layer', label: '新增圖層' },
];

/** Alternating squares, so a transparent preview reads as transparent. */
function paintChecker(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = 8;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size) + (y / size)) % 2 === 0 ? '#ffffff' : '#c9c9c9';
      ctx.fillRect(x, y, size, size);
    }
  }
}

/** Paint one preview frame for the given refined mask. */
function drawPreview(
  canvas: HTMLCanvasElement, image: Surface, mask: Uint8Array, mode: ViewMode,
): void {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  if (mode === 'mask') {
    const img = ctx.createImageData(w, h);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const v = mask[i];
      img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  // Everything else shows the image with the selection carried in the alpha.
  const cut = createSurface(w, h);
  const src = image.ctx.getImageData(0, 0, w, h);
  for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
    src.data[p] = (src.data[p] * mask[i]) / 255;
  }
  cut.ctx.putImageData(src, 0, 0);

  if (mode === 'onion') {
    ctx.globalAlpha = 0.35;
    ctx.drawImage(image.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(cut.canvas, 0, 0);
    // Tint what falls outside, the way Quick Mask marks a protected area.
    const tint = createSurface(w, h);
    const t = tint.ctx.createImageData(w, h);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      t.data[p] = 255; t.data[p + 1] = 40; t.data[p + 2] = 40;
      t.data[p + 3] = Math.round((255 - mask[i]) * 0.45);
    }
    tint.ctx.putImageData(t, 0, 0);
    ctx.drawImage(tint.canvas, 0, 0);
    return;
  }

  if (mode === 'black') ctx.fillStyle = '#000';
  else if (mode === 'white') ctx.fillStyle = '#fff';
  if (mode === 'layers') paintChecker(ctx, w, h);
  else { ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(cut.canvas, 0, 0);
}

/**
 * Select and Mask: refine the live selection with a preview, then hand the
 * result back as a selection, a layer mask, or a cut-out layer.
 */
export async function refineEdgeDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  const full = doc.selection.mask;
  if (!full) { app.toast('請先建立選取範圍', 'error'); return; }

  const settings: RefineSettings = defaultRefine();
  let mode: ViewMode = 'onion';
  let output: Output = 'selection';

  // The refine passes cost O(pixels x radius), so steer the live preview at a
  // reduced size and only run the real thing once, on OK.
  const scale = Math.min(1, 460 / Math.max(doc.width, doc.height));
  const pw = Math.max(1, Math.round(doc.width * scale));
  const ph = Math.max(1, Math.round(doc.height * scale));
  const small = scaleMask(full, doc.width, doc.height, pw, ph);
  const image = createSurface(pw, ph);
  image.ctx.drawImage(doc.render().canvas, 0, 0, pw, ph);

  const canvas = el('canvas', { width: pw, height: ph }) as HTMLCanvasElement;
  const info = el('div', { class: 'hint' });

  const render = (): void => {
    const mask = refineIsIdentity(settings)
      ? small
      : refineMask(small, pw, ph, settings, scale);
    drawPreview(canvas, image, mask, mode);
    let covered = 0;
    for (let i = 0; i < mask.length; i++) covered += mask[i];
    const pct = (covered / (mask.length * 255)) * 100;
    info.textContent = `選取約 ${pct.toFixed(1)}% 的畫面`;
  };

  const slider = (
    label: string, value: number, min: number, max: number,
    set: (v: number) => void, unit = ' px',
  ): HTMLElement => el('div', {},
    el('div', { class: 'hint', text: label }),
    sliderControl(value, min, max, 1, (v) => { set(v); render(); }, unit, 130));

  // A long option label would otherwise stretch the select past its column.
  const viewSelect = selectControl(mode, VIEW_MODES, (v) => { mode = v as ViewMode; render(); });
  const outputSelect = selectControl(output, OUTPUTS, (v) => { output = v as Output; });
  for (const sel of [viewSelect, outputSelect]) {
    sel.style.width = '100%';
    sel.style.minWidth = '0';
  }

  const controls = el('div', {
    // minmax(0, 1fr) pins the track to the column width; an auto track would
    // stretch to the widest option label and push the select out of the dialog.
    style: 'display:grid;grid-template-columns:minmax(0,1fr);gap:10px;'
      + 'width:214px;min-width:0;align-content:start',
  },
    el('div', { class: 'panel-head', style: 'background:none;padding:0' },
      el('span', { text: '檢視' })),
    viewSelect,
    el('div', { class: 'panel-head', style: 'background:none;padding:0' },
      el('span', { text: '調整邊緣' })),
    slider('平滑', settings.smooth, 0, 50, (v) => { settings.smooth = v; }),
    slider('羽化', settings.feather, 0, 100, (v) => { settings.feather = v; }),
    slider('對比', settings.contrast, 0, 100, (v) => { settings.contrast = v; }, '%'),
    slider('移動邊緣', settings.shift, -50, 50, (v) => { settings.shift = v; }),
    el('div', { class: 'panel-head', style: 'background:none;padding:0' },
      el('span', { text: '輸出至' })),
    outputSelect,
    info);

  const body = el('div', { style: 'display:flex;gap:14px;align-items:flex-start' },
    el('div', { class: 'preview-pane', style: `width:${pw}px;height:${ph}px` }, canvas),
    controls);

  render();
  // Wide enough for the preview and the control column side by side.
  const res = await openModal({ title: '選取並遮住', body, width: pw + 290 });
  if (res !== 'ok') return;

  const refined = refineIsIdentity(settings)
    ? new Uint8Array(full)
    : refineMask(full, doc.width, doc.height, settings, 1);
  applyRefined(app, doc, refined, output);
}

function applyRefined(
  app: App, doc: PhotoDoc, refined: Uint8Array, output: Output,
): void {
  if (output === 'selection') {
    doc.selection.combine(refined, 'replace');
    doc.commit('調整選取邊緣');
    app.changed();
    return;
  }

  const layer = doc.activeLayer();
  if (!layer?.surface) {
    app.toast('請先選擇一個有像素的圖層', 'error');
    return;
  }

  if (output === 'mask') {
    layer.mask = maskFromCoverage(refined, doc.width, doc.height);
    layer.maskEnabled = true;
    doc.editingMask = false;
    doc.selection.clear();
    doc.commit('輸出為圖層遮色片');
    app.changed();
    return;
  }

  // A new layer holding just the selected pixels, with the original left alone.
  const cut = createSurface(doc.width, doc.height);
  cut.ctx.drawImage(layer.surface.canvas, layer.x, layer.y);
  const img = cut.ctx.getImageData(0, 0, doc.width, doc.height);
  for (let i = 0, p = 3; i < refined.length; i++, p += 4) {
    img.data[p] = (img.data[p] * refined[i]) / 255;
  }
  cut.ctx.putImageData(img, 0, 0);

  const next = createRasterLayer(`${layer.name} 拷貝`, doc.width, doc.height, cut);
  next.opacity = layer.opacity;
  next.blend = layer.blend;
  doc.insertLayerAbove(next, layer.id);
  doc.selection.clear();
  doc.commit('輸出為新圖層');
  app.changed();
}
