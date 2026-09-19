import type { App } from '../../core/app';
import type { PaintSlot, PhotoDoc } from '../../core/document';
import type { Layer, AdjustmentSpec, CurveChannel } from '../../core/types';
import { cloneSurface, createSurface, type Surface } from '../../core/surface';
import { clamp, type Rect } from '../../core/geometry';
import { applyAdjustment, ADJUSTMENT_LABELS, defaultAdjustment } from '../../filters/adjustments';
import { defaultParams, type FilterDef, type ParamValue } from '../../filters/registry';
import { el, on } from '../dom';
import {
  checkboxControl, colorChip, openModal, selectControl, sliderControl,
} from '../modal';
import { computeHistogram, CurveEditor, HistogramView, type HistogramData } from './widgets';
import type { RGB } from '../../core/color';

/**
 * A live-preview editing session over the active layer. Pixels are processed
 * inside the selection bounds only, and the document shows the result through
 * its live-preview slot until the dialog is confirmed or cancelled.
 */
export class PixelOpSession {
  readonly region: Rect;
  readonly source: ImageData;
  private base: Surface;
  private preview: Surface;
  private selection: Surface | null;
  private offX: number;
  private offY: number;

  private constructor(
    private app: App,
    private doc: PhotoDoc,
    private layer: Layer | null,
    private slot: PaintSlot,
    target: Surface,
  ) {
    this.offX = slot === 'pixels' && layer ? layer.x : 0;
    this.offY = slot === 'pixels' && layer ? layer.y : 0;

    // Quick Mask edits the selection itself, so it is never cropped by it.
    const b = slot === 'quickmask' ? null : doc.selection.bounds();
    let region: Rect = { x: 0, y: 0, w: target.w, h: target.h };
    if (b) {
      const x = clamp(Math.floor(b.x - this.offX), 0, target.w);
      const y = clamp(Math.floor(b.y - this.offY), 0, target.h);
      const w = clamp(Math.ceil(b.x + b.w - this.offX) - x, 0, target.w - x);
      const h = clamp(Math.ceil(b.y + b.h - this.offY) - y, 0, target.h - y);
      if (w > 0 && h > 0) region = { x, y, w, h };
    }
    this.region = region;
    this.base = target;
    this.source = target.ctx.getImageData(region.x, region.y, region.w, region.h);
    this.preview = cloneSurface(target);
    this.selection = slot !== 'quickmask' && doc.selection.active ? doc.selection.toSurface() : null;
    doc.setPaintPreview(layer, slot, this.preview);
  }

  static begin(app: App, doc: PhotoDoc): PixelOpSession | null {
    // Quick Mask, layer mask and layer pixels all route through paintTarget.
    const target = doc.paintTarget();
    if (!target) {
      app.toast('此圖層沒有可編輯的像素（已鎖定或為智慧型物件）', 'error');
      return null;
    }
    return new PixelOpSession(app, doc, target.layer, target.slot, target.surface);
  }

  histogram(): HistogramData { return computeHistogram(this.source); }

  /** Re-run the operation and refresh the on-canvas preview. */
  render(apply: ((img: ImageData) => void) | null): void {
    const r = this.region;
    const ctx = this.preview.ctx;
    let processed: Surface | null = null;

    if (apply) {
      const img = new ImageData(new Uint8ClampedArray(this.source.data), r.w, r.h);
      apply(img);
      processed = createSurface(r.w, r.h);
      processed.ctx.putImageData(img, 0, 0);
      if (this.selection) {
        // Outside the selection the untouched pixels must show through.
        processed.ctx.globalCompositeOperation = 'destination-in';
        processed.ctx.drawImage(this.selection.canvas, -(r.x + this.offX), -(r.y + this.offY));
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.base.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    if (processed) ctx.drawImage(processed.canvas, r.x, r.y);
    ctx.restore();

    this.doc.touch();
    this.app.changed();
  }

  commit(label: string): void {
    this.doc.clearPaintPreview();
    const target = this.doc.mutablePaintSurface(this.layer, this.slot);
    target.ctx.clearRect(0, 0, target.w, target.h);
    target.ctx.drawImage(this.preview.canvas, 0, 0);
    this.doc.commit(label);
    this.app.changed();
  }

  cancel(): void {
    this.doc.clearPaintPreview();
    this.doc.touch();
    this.app.changed();
  }
}

// ---------------------------------------------------------------------------

const CHANNEL_OPTIONS = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: '紅' },
  { value: 'g', label: '綠' },
  { value: 'b', label: '藍' },
];

function row(label: string, control: HTMLElement): HTMLElement {
  return el('div', {
    style: 'display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:center',
  }, el('label', { text: label, class: 'hint' }), control);
}

/** Build the parameter UI for one adjustment type. */
export function adjustmentControls(
  spec: AdjustmentSpec, onChange: () => void, hist: HistogramData | null,
): HTMLElement {
  const wrap = el('div', { style: 'display:grid;gap:9px;min-width:330px' });
  const slider = (
    label: string, value: number, min: number, max: number, step: number,
    set: (v: number) => void, unit = '',
  ): void => {
    wrap.append(row(label, sliderControl(value, min, max, step, (v) => { set(v); onChange(); }, unit, 150)));
  };

  switch (spec.type) {
    case 'brightness-contrast':
      slider('亮度', spec.brightness, -150, 150, 1, (v) => { spec.brightness = v; });
      slider('對比', spec.contrast, -100, 100, 1, (v) => { spec.contrast = v; });
      wrap.append(checkboxControl('使用舊版演算法', spec.legacy, (v) => { spec.legacy = v; onChange(); }));
      break;

    case 'levels': {
      const view = new HistogramView(300, 92);
      if (hist) view.update(hist, spec.channel);
      wrap.append(row('色版', selectControl(spec.channel, CHANNEL_OPTIONS, (v) => {
        spec.channel = v as CurveChannel;
        if (hist) view.update(hist, spec.channel);
        onChange();
      })));
      wrap.append(view.root);
      slider('輸入黑點', spec.inBlack, 0, 254, 1, (v) => { spec.inBlack = Math.min(v, spec.inWhite - 1); });
      slider('Gamma', spec.gamma, 0.1, 9.99, 0.01, (v) => { spec.gamma = v; });
      slider('輸入白點', spec.inWhite, 1, 255, 1, (v) => { spec.inWhite = Math.max(v, spec.inBlack + 1); });
      slider('輸出黑點', spec.outBlack, 0, 255, 1, (v) => { spec.outBlack = v; });
      slider('輸出白點', spec.outWhite, 0, 255, 1, (v) => { spec.outWhite = v; });
      break;
    }

    case 'curves': {
      let channel: CurveChannel = 'rgb';
      const editor = new CurveEditor({
        size: 268,
        histogram: hist,
        onChange: (pts) => { spec.curves[channel] = pts; onChange(); },
      });
      editor.setPoints(spec.curves.rgb);
      wrap.append(row('色版', selectControl('rgb', CHANNEL_OPTIONS, (v) => {
        channel = v as CurveChannel;
        editor.setPoints(spec.curves[channel]);
      })));
      wrap.append(el('div', { style: 'display:grid;place-items:center' }, editor.root));
      const reset = el('button', { class: 'btn', text: '重設此色版' });
      on(reset, 'click', () => {
        spec.curves[channel] = [[0, 0], [255, 255]];
        editor.setPoints(spec.curves[channel]);
        onChange();
      });
      wrap.append(el('div', { class: 'hint', text: '點一下新增控制點，Alt 點擊可刪除。' }));
      wrap.append(reset);
      break;
    }

    case 'hue-saturation':
      slider('色相', spec.hue, -180, 180, 1, (v) => { spec.hue = v; }, '°');
      slider('飽和度', spec.saturation, -100, 100, 1, (v) => { spec.saturation = v; });
      slider('明亮', spec.lightness, -100, 100, 1, (v) => { spec.lightness = v; });
      wrap.append(checkboxControl('上色', spec.colorize, (v) => { spec.colorize = v; onChange(); }));
      break;

    case 'color-balance': {
      const band = (label: string, key: 'shadows' | 'midtones' | 'highlights'): void => {
        wrap.append(el('div', { class: 'hint', text: label, style: 'margin-top:4px' }));
        const names = ['青 ↔ 紅', '洋紅 ↔ 綠', '黃 ↔ 藍'];
        for (let i = 0; i < 3; i++) {
          slider(names[i], spec[key][i], -100, 100, 1, (v) => { spec[key][i] = v; });
        }
      };
      band('陰影', 'shadows');
      band('中間調', 'midtones');
      band('亮部', 'highlights');
      wrap.append(checkboxControl('保留明度', spec.preserveLuminosity, (v) => {
        spec.preserveLuminosity = v; onChange();
      }));
      break;
    }

    case 'exposure':
      slider('曝光度', spec.exposure, -5, 5, 0.01, (v) => { spec.exposure = v; });
      slider('偏移量', spec.offset, -0.5, 0.5, 0.001, (v) => { spec.offset = v; });
      slider('Gamma', spec.gamma, 0.1, 5, 0.01, (v) => { spec.gamma = v; });
      break;

    case 'vibrance':
      slider('自然飽和度', spec.vibrance, -100, 100, 1, (v) => { spec.vibrance = v; });
      slider('飽和度', spec.saturation, -100, 100, 1, (v) => { spec.saturation = v; });
      break;

    case 'black-white':
      slider('紅色', spec.reds, -200, 300, 1, (v) => { spec.reds = v; }, '%');
      slider('黃色', spec.yellows, -200, 300, 1, (v) => { spec.yellows = v; }, '%');
      slider('綠色', spec.greens, -200, 300, 1, (v) => { spec.greens = v; }, '%');
      slider('青色', spec.cyans, -200, 300, 1, (v) => { spec.cyans = v; }, '%');
      slider('藍色', spec.blues, -200, 300, 1, (v) => { spec.blues = v; }, '%');
      slider('洋紅', spec.magentas, -200, 300, 1, (v) => { spec.magentas = v; }, '%');
      wrap.append(checkboxControl('色調', spec.tint, (v) => { spec.tint = v; onChange(); }));
      wrap.append(row('色調顏色', colorChip(spec.tintColor, (c) => { spec.tintColor = c; onChange(); })));
      break;

    case 'threshold':
      slider('臨界值色階', spec.level, 1, 255, 1, (v) => { spec.level = v; });
      break;

    case 'posterize':
      slider('色階', spec.levels, 2, 64, 1, (v) => { spec.levels = v; });
      break;

    case 'photo-filter':
      wrap.append(row('濾鏡顏色', colorChip(spec.color, (c) => { spec.color = c; onChange(); })));
      slider('濃度', spec.density, 1, 100, 1, (v) => { spec.density = v; }, '%');
      wrap.append(checkboxControl('保留明度', spec.preserveLuminosity, (v) => {
        spec.preserveLuminosity = v; onChange();
      }));
      break;

    case 'gradient-map': {
      const list = el('div', { style: 'display:grid;gap:6px' });
      const rebuildList = (): void => {
        list.replaceChildren();
        spec.stops.forEach((stop, i) => {
          const r = el('div', { style: 'display:flex;gap:8px;align-items:center' },
            colorChip(stop.color, (c) => { stop.color = c; onChange(); }),
            sliderControl(stop.pos * 100, 0, 100, 1, (v) => { stop.pos = v / 100; onChange(); }, '%', 110));
          if (spec.stops.length > 2) {
            const del = el('button', { class: 'mini-btn', text: '✕' });
            on(del, 'click', () => { spec.stops.splice(i, 1); rebuildList(); onChange(); });
            r.append(del);
          }
          list.append(r);
        });
      };
      rebuildList();
      const add = el('button', { class: 'btn', text: '新增色標' });
      on(add, 'click', () => {
        spec.stops.push({ pos: 0.5, color: { r: 128, g: 128, b: 128 }, alpha: 1 });
        spec.stops.sort((a, b) => a.pos - b.pos);
        rebuildList();
        onChange();
      });
      wrap.append(list, add);
      break;
    }

    case 'channel-mixer': {
      const names = ['紅 → 紅', '綠 → 紅', '藍 → 紅', '紅 常數',
        '紅 → 綠', '綠 → 綠', '藍 → 綠', '綠 常數',
        '紅 → 藍', '綠 → 藍', '藍 → 藍', '藍 常數'];
      spec.matrix.forEach((v, i) => {
        slider(names[i], v, -200, 200, 1, (nv) => { spec.matrix[i] = nv; }, '%');
      });
      wrap.append(checkboxControl('單色', spec.monochrome, (v) => { spec.monochrome = v; onChange(); }));
      break;
    }

    case 'invert':
      wrap.append(el('div', { class: 'hint', text: '將所有色版反轉。' }));
      break;
  }
  return wrap;
}

/** Destructive adjustment dialog with live preview on the active layer. */
export async function adjustmentDialog(app: App, type: AdjustmentSpec['type']): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  const session = PixelOpSession.begin(app, doc);
  if (!session) return;

  const spec = defaultAdjustment(type);
  let previewOn = true;
  const hist = session.histogram();

  const update = (): void => session.render(previewOn ? (img) => applyAdjustment(img, spec) : null);
  update();

  const body = el('div', { style: 'display:grid;gap:12px' },
    adjustmentControls(spec, update, hist),
    checkboxControl('預視', previewOn, (v) => { previewOn = v; update(); }));

  const result = await openModal({ title: ADJUSTMENT_LABELS[type], body });
  if (result === 'ok') {
    session.render((img) => applyAdjustment(img, spec));
    session.commit(ADJUSTMENT_LABELS[type]);
  } else {
    session.cancel();
  }
}

/** Filter dialog generated from the filter registry definition. */
export async function filterDialog(app: App, def: FilterDef): Promise<boolean> {
  const doc = app.activeDoc();
  if (!doc) return false;
  const session = PixelOpSession.begin(app, doc);
  if (!session) return false;

  const values = defaultParams(def);
  let previewOn = true;
  let timer = 0;

  const apply = (img: ImageData): void => def.apply(img, values);
  const update = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => session.render(previewOn ? apply : null), 90);
  };

  const controls = el('div', { style: 'display:grid;gap:9px;min-width:340px' });
  for (const p of def.params) {
    if (p.type === 'slider') {
      controls.append(row(p.label, sliderControl(
        Number(values[p.key]), p.min ?? 0, p.max ?? 100, p.step ?? 1,
        (v) => { values[p.key] = v; update(); }, p.unit ?? '', 150,
      )));
    } else if (p.type === 'checkbox') {
      controls.append(checkboxControl(p.label, Boolean(values[p.key]), (v) => {
        values[p.key] = v; update();
      }));
    } else if (p.type === 'select') {
      controls.append(row(p.label, selectControl(String(values[p.key]), p.options ?? [], (v) => {
        values[p.key] = v; update();
      })));
    } else if (p.type === 'color') {
      controls.append(row(p.label, colorChip(values[p.key] as RGB, (c) => {
        values[p.key] = c; update();
      })));
    }
  }

  if (def.params.length === 0) {
    controls.append(el('div', { class: 'hint', text: '此濾鏡沒有可調整的參數。' }));
  }
  session.render(apply);

  const body = el('div', { style: 'display:grid;gap:12px' },
    controls,
    checkboxControl('預視', previewOn, (v) => { previewOn = v; update(); }));

  const result = await openModal({ title: def.label, body });
  if (result === 'ok') {
    session.render(apply);
    session.commit(def.label);
    lastFilter = { def, values };
    return true;
  }
  session.cancel();
  return false;
}

export let lastFilter: { def: FilterDef; values: Record<string, ParamValue> } | null = null;

/** Re-run the previous filter with the same settings. */
export function repeatLastFilter(app: App): void {
  const doc = app.activeDoc();
  if (!doc || !lastFilter) { app.toast('沒有可重複的濾鏡', 'error'); return; }
  const session = PixelOpSession.begin(app, doc);
  if (!session) return;
  session.render((img) => lastFilter!.def.apply(img, lastFilter!.values));
  session.commit(lastFilter.def.label);
}

/** Apply an adjustment with no dialog (used by Invert, Auto Tone, ...). */
export function applyAdjustmentNow(app: App, spec: AdjustmentSpec, label: string): void {
  const doc = app.activeDoc();
  if (!doc) return;
  const session = PixelOpSession.begin(app, doc);
  if (!session) return;
  session.render((img) => applyAdjustment(img, spec));
  session.commit(label);
}
