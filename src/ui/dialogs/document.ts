import type { App } from '../../core/app';
import { PhotoDoc } from '../../core/document';
import { createSurface } from '../../core/surface';
import { rgbCss, type RGB } from '../../core/color';
import { clamp } from '../../core/geometry';
import { exportDocument, type ExportFormat } from '../../io/files';
import {
  loadPatterns, patternSurface, tileInto, warmEmbedded,
} from '../../core/patterns';
import { cloneStops, loadGradients } from '../../core/gradients';
import { defaultEffects } from '../../core/layer';
import {
  cloneEffects, createStyle, describeStyle, loadStyles, saveStyles,
} from '../../core/styles';
import { el, on } from '../dom';
import {
  checkboxControl, colorChip, formGrid, numberControl, openModal, rebuild,
  segmentedControl, selectControl, sliderControl,
} from '../modal';

const PRESETS: { label: string; w: number; h: number; dpi: number }[] = [
  { label: '預設 1920 × 1080', w: 1920, h: 1080, dpi: 72 },
  { label: '螢幕 1280 × 720', w: 1280, h: 720, dpi: 72 },
  { label: '正方形 1080 × 1080', w: 1080, h: 1080, dpi: 72 },
  { label: '限時動態 1080 × 1920', w: 1080, h: 1920, dpi: 72 },
  { label: 'A4 300dpi 2480 × 3508', w: 2480, h: 3508, dpi: 300 },
  { label: '名片 1050 × 600', w: 1050, h: 600, dpi: 300 },
  { label: '4K 3840 × 2160', w: 3840, h: 2160, dpi: 72 },
];

export async function newDocumentDialog(app: App): Promise<void> {
  let width = 1920, height = 1080, dpi = 72;
  let fill: 'white' | 'transparent' | 'black' | 'custom' = 'white';
  let custom: RGB = { r: 255, g: 255, b: 255 };
  let name = `未命名-${app.docs.length + 1}`;

  const nameInput = el('input', { type: 'text', value: name }) as HTMLInputElement;
  on(nameInput, 'input', () => { name = nameInput.value; });

  const wInput = numberControl(width, 1, 12000, 1, (v) => { width = Math.round(v); });
  const hInput = numberControl(height, 1, 12000, 1, (v) => { height = Math.round(v); });
  const dpiInput = numberControl(dpi, 1, 2400, 1, (v) => { dpi = Math.round(v); });

  const preset = selectControl('custom', [
    { value: 'custom', label: '自訂' },
    ...PRESETS.map((p, i) => ({ value: String(i), label: p.label })),
  ], (v) => {
    if (v === 'custom') return;
    const p = PRESETS[Number(v)];
    width = p.w; height = p.h; dpi = p.dpi;
    wInput.value = String(p.w);
    hInput.value = String(p.h);
    dpiInput.value = String(p.dpi);
  });

  const body = formGrid([
    ['名稱', nameInput],
    ['預設集', preset],
    ['寬度 (px)', wInput],
    ['高度 (px)', hInput],
    ['解析度 (dpi)', dpiInput],
    ['背景內容', segmentedControl('white', [
      { value: 'white', label: '白色' },
      { value: 'transparent', label: '透明' },
      { value: 'black', label: '黑色' },
      { value: 'custom', label: '自訂' },
    ], (v) => { fill = v as typeof fill; })],
    ['自訂顏色', colorChip(custom, (c) => { custom = c; fill = 'custom'; })],
  ]);

  if (await openModal({ title: '新增文件', body }) !== 'ok') return;
  // Widened because the value is only ever set from inside a callback.
  const chosenFill: string = fill;
  const doc = PhotoDoc.createBlank(
    name || '未命名', clamp(width, 1, 12000), clamp(height, 1, 12000),
    chosenFill === 'custom' ? rgbCss(custom) : chosenFill,
  );
  doc.meta.dpi = dpi;
  app.addDoc(doc);
}

export async function imageSizeDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  let w = doc.width, h = doc.height;
  let linked = true;
  let smooth = true;
  const ratio = doc.width / doc.height;

  const wIn = numberControl(w, 1, 20000, 1, (v) => {
    w = Math.round(v);
    if (linked) { h = Math.max(1, Math.round(w / ratio)); hIn.value = String(h); }
  });
  const hIn = numberControl(h, 1, 20000, 1, (v) => {
    h = Math.round(v);
    if (linked) { w = Math.max(1, Math.round(h * ratio)); wIn.value = String(w); }
  });

  const percent = numberControl(100, 1, 1000, 1, (v) => {
    w = Math.max(1, Math.round((doc.width * v) / 100));
    h = Math.max(1, Math.round((doc.height * v) / 100));
    wIn.value = String(w);
    hIn.value = String(h);
  });

  const body = formGrid([
    [null, el('div', { class: 'hint', text: `目前尺寸：${doc.width} × ${doc.height} px` })],
    ['寬度 (px)', wIn],
    ['高度 (px)', hIn],
    ['百分比 (%)', percent],
    [null, checkboxControl('強制等比例', linked, (v) => { linked = v; })],
    [null, checkboxControl('重新取樣（平滑）', smooth, (v) => { smooth = v; })],
  ]);

  if (await openModal({ title: '影像尺寸', body }) !== 'ok') return;
  doc.resampleTo(clamp(w, 1, 20000), clamp(h, 1, 20000), smooth);
  doc.commit('影像尺寸');
  app.changed();
  app.events.emit('view-changed', undefined);
}

export async function canvasSizeDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  let w = doc.width, h = doc.height;
  let anchor = 'center';

  const anchorGrid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,28px);gap:3px;justify-content:start',
  });
  const cells = [
    'nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se',
  ];
  const buttons: HTMLButtonElement[] = [];
  for (const c of cells) {
    const b = el('button', {
      class: `btn${c === anchor ? ' primary' : ''}`,
      style: 'padding:0;height:28px',
      text: c === 'center' ? '•' : '',
    }) as HTMLButtonElement;
    on(b, 'click', () => {
      anchor = c;
      buttons.forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
    });
    buttons.push(b);
    anchorGrid.append(b);
  }

  const body = formGrid([
    [null, el('div', { class: 'hint', text: `目前版面：${doc.width} × ${doc.height} px` })],
    ['寬度 (px)', numberControl(w, 1, 20000, 1, (v) => { w = Math.round(v); })],
    ['高度 (px)', numberControl(h, 1, 20000, 1, (v) => { h = Math.round(v); })],
    ['錨點', anchorGrid],
  ]);

  if (await openModal({ title: '版面尺寸', body }) !== 'ok') return;
  const dx = w - doc.width, dy = h - doc.height;
  let ox = Math.round(dx / 2), oy = Math.round(dy / 2);
  if (anchor.includes('w')) ox = 0;
  if (anchor.includes('e')) ox = dx;
  if (anchor.includes('n')) oy = 0;
  if (anchor.includes('s')) oy = dy;
  doc.resizeCanvas(clamp(w, 1, 20000), clamp(h, 1, 20000), ox, oy);
  doc.commit('版面尺寸');
  app.changed();
  app.events.emit('view-changed', undefined);
}

export async function exportDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  let format: ExportFormat = 'png';
  let quality = 92;
  let filename = doc.meta.name.replace(/\.[^.]+$/, '');
  let whiteBackground = false;

  const nameIn = el('input', { type: 'text', value: filename }) as HTMLInputElement;
  on(nameIn, 'input', () => { filename = nameIn.value; });

  const qualityRow = el('div');
  const rebuildQuality = (): void => {
    qualityRow.replaceChildren();
    if (format === 'png') {
      qualityRow.append(el('span', { class: 'hint', text: 'PNG 為無損格式' }));
    } else {
      qualityRow.append(sliderControl(quality, 1, 100, 1, (v) => { quality = v; }, '%', 160));
    }
  };
  rebuildQuality();

  const body = formGrid([
    ['檔名', nameIn],
    ['格式', segmentedControl('png', [
      { value: 'png', label: 'PNG' },
      { value: 'jpeg', label: 'JPEG' },
      { value: 'webp', label: 'WebP' },
    ], (v) => { format = v as ExportFormat; rebuildQuality(); })],
    ['品質', qualityRow],
    [null, checkboxControl('以白色背景填滿透明區域', whiteBackground, (v) => { whiteBackground = v; })],
    [null, el('div', { class: 'hint', text: `輸出尺寸 ${doc.width} × ${doc.height} px` })],
  ]);

  if (await openModal({ title: '轉存影像', body }) !== 'ok') return;
  const chosenFormat: string = format;
  await exportDocument(
    doc, format, quality / 100, filename,
    whiteBackground || chosenFormat === 'jpeg' ? '#ffffff' : undefined,
  );
  app.toast('已開始下載影像', 'success');
}

export async function fillDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  const target = doc?.paintTarget();
  if (!doc || !target) {
    app.toast('請先選擇可編輯的點陣圖層', 'error');
    return;
  }
  let source = 'foreground';
  let custom: RGB = { ...app.foreground };
  let opacity = 100;
  const patterns = loadPatterns();
  let patternId = patterns[0].id;
  let patternScale = 100;

  const swatch = el('canvas', {
    width: 44, height: 28, style: 'border:1px solid var(--line);border-radius:3px',
  }) as HTMLCanvasElement;
  const paintSwatch = (): void => {
    const p = patterns.find((x) => x.id === patternId);
    if (!p) return;
    void patternSurface(p).then((tile) => {
      const s = createSurface(44, 28);
      tileInto(s, tile, patternScale);
      const ctx = swatch.getContext('2d')!;
      ctx.clearRect(0, 0, 44, 28);
      ctx.drawImage(s.canvas, 0, 0);
    });
  };
  paintSwatch();

  const patternRow = el('div', { style: 'display:flex;gap:6px;align-items:center' },
    selectControl(patternId, patterns.map((p) => ({ value: p.id, label: p.name })), (v) => {
      patternId = v;
      source = 'pattern';
      paintSwatch();
    }),
    swatch);

  const body = formGrid([
    ['使用', selectControl(source, [
      { value: 'foreground', label: '前景色' },
      { value: 'background', label: '背景色' },
      { value: 'custom', label: '自訂顏色' },
      { value: 'black', label: '黑色' },
      { value: 'white', label: '白色' },
      { value: 'gray', label: '50% 灰色' },
      { value: 'pattern', label: '圖樣' },
    ], (v) => { source = v; })],
    ['自訂顏色', colorChip(custom, (c) => { custom = c; source = 'custom'; })],
    ['圖樣', patternRow],
    ['圖樣縮放', sliderControl(patternScale, 10, 400, 5, (v) => {
      patternScale = v;
      paintSwatch();
    }, '%', 150)],
    ['不透明度', sliderControl(opacity, 1, 100, 1, (v) => { opacity = v; }, '%', 150)],
  ]);

  if (await openModal({ title: '填滿', body }) !== 'ok') return;

  const paint = createSurface(doc.width, doc.height);
  if (source === 'pattern') {
    const p = patterns.find((x) => x.id === patternId);
    if (!p) { app.toast('找不到這個圖樣', 'error'); return; }
    tileInto(paint, await patternSurface(p), patternScale);
  } else {
    const color: RGB = source === 'foreground' ? app.foreground
      : source === 'background' ? app.background
        : source === 'black' ? { r: 0, g: 0, b: 0 }
          : source === 'white' ? { r: 255, g: 255, b: 255 }
            : source === 'gray' ? { r: 128, g: 128, b: 128 }
              : custom;
    paint.ctx.fillStyle = rgbCss(color);
    paint.ctx.fillRect(0, 0, paint.w, paint.h);
  }
  if (target.clipToSelection && doc.selection.active) {
    paint.ctx.globalCompositeOperation = 'destination-in';
    paint.ctx.drawImage(doc.selection.toSurface().canvas, 0, 0);
  }
  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.save();
  dest.ctx.globalAlpha = opacity / 100;
  dest.ctx.drawImage(paint.canvas, -target.offX, -target.offY);
  dest.ctx.restore();
  doc.commit('填滿');
  app.changed();
}

export async function strokeDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  const target = doc?.paintTarget();
  if (!doc || !target) {
    app.toast('請先選擇可編輯的點陣圖層', 'error');
    return;
  }
  if (!doc.selection.active) {
    app.toast('請先建立選取範圍', 'error');
    return;
  }
  let width = 3;
  let position = 'center';
  let color: RGB = { ...app.foreground };
  let opacity = 100;

  const body = formGrid([
    ['寬度 (px)', numberControl(width, 1, 200, 1, (v) => { width = Math.round(v); })],
    ['顏色', colorChip(color, (c) => { color = c; })],
    ['位置', segmentedControl(position, [
      { value: 'inside', label: '內部' },
      { value: 'center', label: '居中' },
      { value: 'outside', label: '外部' },
    ], (v) => { position = v; })],
    ['不透明度', sliderControl(opacity, 1, 100, 1, (v) => { opacity = v; }, '%', 150)],
  ]);

  if (await openModal({ title: '筆畫', body }) !== 'ok') return;

  // The stroke band is the difference between an expanded and a contracted copy.
  const outer = doc.selection.clone();
  const inner = doc.selection.clone();
  if (position === 'center') {
    outer.expand(Math.ceil(width / 2));
    inner.contract(Math.floor(width / 2));
  } else if (position === 'inside') {
    inner.contract(width);
  } else {
    outer.expand(width);
  }
  const band = new Uint8Array(doc.width * doc.height);
  const o = outer.mask, i = inner.mask;
  for (let k = 0; k < band.length; k++) {
    band[k] = Math.max(0, (o ? o[k] : 0) - (i ? i[k] : 0));
  }

  const paint = createSurface(doc.width, doc.height);
  const img = paint.ctx.createImageData(doc.width, doc.height);
  for (let k = 0; k < band.length; k++) {
    const p = k * 4;
    img.data[p] = color.r;
    img.data[p + 1] = color.g;
    img.data[p + 2] = color.b;
    img.data[p + 3] = band[k];
  }
  paint.ctx.putImageData(img, 0, 0);

  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.save();
  dest.ctx.globalAlpha = opacity / 100;
  dest.ctx.drawImage(paint.canvas, -target.offX, -target.offY);
  dest.ctx.restore();
  doc.commit('筆畫');
  app.changed();
}

export async function modifySelectionDialog(
  app: App, kind: 'feather' | 'expand' | 'contract' | 'border' | 'smooth',
): Promise<void> {
  const doc = app.activeDoc();
  if (!doc || !doc.selection.active) {
    app.toast('請先建立選取範圍', 'error');
    return;
  }
  const titles: Record<typeof kind, string> = {
    feather: '羽化選取範圍', expand: '擴張選取範圍', contract: '縮減選取範圍',
    border: '選取範圍邊界', smooth: '平滑選取範圍',
  };
  let amount = kind === 'feather' ? 5 : 3;
  const body = formGrid([
    [kind === 'feather' ? '羽化強度 (px)' : '強度 (px)',
      numberControl(amount, 1, 250, 1, (v) => { amount = Math.round(v); })],
  ]);
  if (await openModal({ title: titles[kind], body }) !== 'ok') return;

  switch (kind) {
    case 'feather': doc.selection.feather(amount); break;
    case 'expand': doc.selection.expand(amount); break;
    case 'contract': doc.selection.contract(amount); break;
    case 'border': doc.selection.border(amount); break;
    case 'smooth': doc.selection.expand(amount); doc.selection.contract(amount); break;
  }
  doc.commit(titles[kind]);
  app.changed();
}

/** Select > Color Range: build a selection from colour similarity. */
export async function colorRangeDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  let fuzziness = 40;
  let target: RGB = { ...app.foreground };
  const src = doc.composite();
  const img = src.ctx.getImageData(0, 0, src.w, src.h);

  const previewCanvas = el('canvas', { width: 260, height: 160 }) as HTMLCanvasElement;
  const pctx = previewCanvas.getContext('2d')!;

  const compute = (): Uint8Array => {
    const out = new Uint8Array(doc.width * doc.height);
    const tol = fuzziness * 2.55;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const d = Math.hypot(
        img.data[p] - target.r, img.data[p + 1] - target.g, img.data[p + 2] - target.b,
      );
      out[i] = d <= tol ? 255 : d <= tol * 1.6 ? Math.round(255 * (1 - (d - tol) / (tol * 0.6))) : 0;
    }
    return out;
  };

  const refresh = (): void => {
    const cov = compute();
    const scale = Math.min(previewCanvas.width / doc.width, previewCanvas.height / doc.height);
    const w = Math.max(1, Math.round(doc.width * scale));
    const h = Math.max(1, Math.round(doc.height * scale));
    const tmp = createSurface(doc.width, doc.height);
    const timg = tmp.ctx.createImageData(doc.width, doc.height);
    for (let i = 0, p = 0; i < cov.length; i++, p += 4) {
      timg.data[p] = timg.data[p + 1] = timg.data[p + 2] = cov[i];
      timg.data[p + 3] = 255;
    }
    tmp.ctx.putImageData(timg, 0, 0);
    pctx.fillStyle = '#111';
    pctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    pctx.drawImage(
      tmp.canvas, (previewCanvas.width - w) / 2, (previewCanvas.height - h) / 2, w, h,
    );
  };
  refresh();

  const body = el('div', { style: 'display:grid;gap:10px' },
    formGrid([
      ['選取顏色', colorChip(target, (c) => { target = c; refresh(); })],
      ['朦朧', sliderControl(fuzziness, 0, 100, 1, (v) => { fuzziness = v; refresh(); }, '', 160)],
    ]),
    previewCanvas,
    el('div', { class: 'hint', text: '白色區域為將被選取的部分。' }));

  if (await openModal({ title: '顏色範圍', body }) !== 'ok') return;
  doc.selection.combine(compute(), 'replace');
  doc.commit('顏色範圍');
  app.changed();
}

export async function layerStyleDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  const layer = doc?.activeLayer();
  if (!doc || !layer) return;
  const e = JSON.parse(JSON.stringify(layer.effects)) as typeof layer.effects;
  const apply = (): void => {
    layer.effects = JSON.parse(JSON.stringify(e));
    doc.touch();
    app.changed();
  };

  const section = (title: string, enabled: boolean, set: (v: boolean) => void, rows: HTMLElement): HTMLElement =>
    el('div', { style: 'border:1px solid var(--line);border-radius:5px;padding:9px;display:grid;gap:8px' },
      checkboxControl(title, enabled, (v) => { set(v); apply(); }),
      rows);

  const body = el('div', { style: 'display:grid;gap:10px;min-width:380px' });
  const rebuildBody = (): void => { rebuild(body, [...sections()]); };
  const sections = (): HTMLElement[] => [
    section('陰影', e.dropShadow.enabled, (v) => { e.dropShadow.enabled = v; }, formGrid([
      ['顏色', colorChip(e.dropShadow.color, (c) => { e.dropShadow.color = c; apply(); })],
      ['不透明度', sliderControl(e.dropShadow.alpha * 100, 0, 100, 1, (v) => { e.dropShadow.alpha = v / 100; apply(); }, '%', 130)],
      ['模糊', sliderControl(e.dropShadow.blur, 0, 100, 1, (v) => { e.dropShadow.blur = v; apply(); }, ' px', 130)],
      ['X 位移', sliderControl(e.dropShadow.dx, -80, 80, 1, (v) => { e.dropShadow.dx = v; apply(); }, ' px', 130)],
      ['Y 位移', sliderControl(e.dropShadow.dy, -80, 80, 1, (v) => { e.dropShadow.dy = v; apply(); }, ' px', 130)],
    ])),
    section('外光暈', e.glow.enabled, (v) => { e.glow.enabled = v; }, formGrid([
      ['顏色', colorChip(e.glow.color, (c) => { e.glow.color = c; apply(); })],
      ['不透明度', sliderControl(e.glow.alpha * 100, 0, 100, 1, (v) => { e.glow.alpha = v / 100; apply(); }, '%', 130)],
      ['大小', sliderControl(e.glow.blur, 0, 100, 1, (v) => { e.glow.blur = v; apply(); }, ' px', 130)],
    ])),
    section('筆畫', e.stroke.enabled, (v) => { e.stroke.enabled = v; }, formGrid([
      ['顏色', colorChip(e.stroke.color, (c) => { e.stroke.color = c; apply(); })],
      ['不透明度', sliderControl(e.stroke.alpha * 100, 0, 100, 1, (v) => { e.stroke.alpha = v / 100; apply(); }, '%', 130)],
      ['寬度', sliderControl(e.stroke.width, 0, 40, 1, (v) => { e.stroke.width = v; apply(); }, ' px', 130)],
    ])),
    section('內陰影', e.innerShadow.enabled, (v) => { e.innerShadow.enabled = v; }, formGrid([
      ['顏色', colorChip(e.innerShadow.color, (c) => { e.innerShadow.color = c; apply(); })],
      ['不透明度', sliderControl(e.innerShadow.alpha * 100, 0, 100, 1, (v) => { e.innerShadow.alpha = v / 100; apply(); }, '%', 130)],
      ['模糊', sliderControl(e.innerShadow.blur, 0, 100, 1, (v) => { e.innerShadow.blur = v; apply(); }, ' px', 130)],
      ['X 位移', sliderControl(e.innerShadow.dx, -60, 60, 1, (v) => { e.innerShadow.dx = v; apply(); }, ' px', 130)],
      ['Y 位移', sliderControl(e.innerShadow.dy, -60, 60, 1, (v) => { e.innerShadow.dy = v; apply(); }, ' px', 130)],
    ])),
    section('內光暈', e.innerGlow.enabled, (v) => { e.innerGlow.enabled = v; }, formGrid([
      ['顏色', colorChip(e.innerGlow.color, (c) => { e.innerGlow.color = c; apply(); })],
      ['不透明度', sliderControl(e.innerGlow.alpha * 100, 0, 100, 1, (v) => { e.innerGlow.alpha = v / 100; apply(); }, '%', 130)],
      ['大小', sliderControl(e.innerGlow.blur, 0, 100, 1, (v) => { e.innerGlow.blur = v; apply(); }, ' px', 130)],
    ])),
    section('斜角與浮雕', e.bevel.enabled, (v) => { e.bevel.enabled = v; }, formGrid([
      ['大小', sliderControl(e.bevel.size, 1, 60, 1, (v) => { e.bevel.size = v; apply(); }, ' px', 130)],
      ['深度', sliderControl(e.bevel.depth, 10, 400, 5, (v) => { e.bevel.depth = v; apply(); }, '%', 130)],
      ['角度', sliderControl(e.bevel.angle, -180, 180, 1, (v) => { e.bevel.angle = v; apply(); }, '°', 130)],
      ['不透明度', sliderControl(e.bevel.alpha * 100, 0, 100, 1, (v) => { e.bevel.alpha = v / 100; apply(); }, '%', 130)],
      ['亮部', colorChip(e.bevel.highlight, (c) => { e.bevel.highlight = c; apply(); })],
      ['暗部', colorChip(e.bevel.shadow, (c) => { e.bevel.shadow = c; apply(); })],
      [null, checkboxControl('浮雕（光影延伸到邊緣外）', e.bevel.emboss, (v) => {
        e.bevel.emboss = v; apply();
      })],
    ])),
    section('覆蓋', e.overlay.enabled, (v) => { e.overlay.enabled = v; }, overlayRows()),
    styleRow(),
  ];

  // ---- overlay ----
  const gradients = loadGradients();
  const patterns = loadPatterns();

  const overlayRows = (): HTMLElement => {
    const rows = el('div', { style: 'display:grid;gap:8px' });
    const build = (): void => {
      const common: [string | null, HTMLElement | string][] = [
        ['種類', segmentedControl(e.overlay.kind, [
          { value: 'color', label: '顏色' },
          { value: 'gradient', label: '漸層' },
          { value: 'pattern', label: '圖樣' },
        ], (v) => {
          e.overlay.kind = v as typeof e.overlay.kind;
          apply();
          build();
        })],
        ['不透明度', sliderControl(e.overlay.alpha * 100, 0, 100, 1, (v) => {
          e.overlay.alpha = v / 100; apply();
        }, '%', 130)],
      ];
      if (e.overlay.kind === 'color') {
        common.push(['顏色', colorChip(e.overlay.color, (c) => { e.overlay.color = c; apply(); })]);
      } else if (e.overlay.kind === 'gradient') {
        // Picking copies the stops onto the effect: a project has to keep
        // looking the same on a machine without this gradient library.
        common.push(['漸層', selectControl('',
          [{ value: '', label: '（目前的漸層）' },
            ...gradients.map((g) => ({ value: g.id, label: g.name }))],
          (v) => {
            const g = gradients.find((x) => x.id === v);
            if (!g) return;
            e.overlay.stops = cloneStops(g.stops);
            apply();
          })]);
        common.push(['樣式', selectControl(e.overlay.gradientKind, [
          { value: 'linear', label: '線性' },
          { value: 'radial', label: '放射狀' },
          { value: 'angle', label: '角度' },
          { value: 'reflected', label: '反射' },
          { value: 'diamond', label: '菱形' },
        ], (v) => { e.overlay.gradientKind = v as typeof e.overlay.gradientKind; apply(); })]);
        common.push(['角度', sliderControl(e.overlay.angle, -180, 180, 1, (v) => {
          e.overlay.angle = v; apply();
        }, '°', 130)]);
        common.push([null, el('div', {
          class: 'hint', text: '前景色色標會改用上方的覆蓋顏色。',
        })]);
      } else {
        common.push(['圖樣', selectControl(e.overlay.patternId,
          patterns.map((p) => ({ value: p.id, label: p.name })),
          (v) => {
            const p = patterns.find((x) => x.id === v);
            if (!p) return;
            // A built-in is code, so its id is enough; a user tile has to
            // travel with the effect.
            e.overlay.patternId = p.builtin ? p.id : '';
            e.overlay.patternData = p.builtin ? '' : p.data;
            e.overlay.patternWidth = p.builtin ? 0 : p.width;
            e.overlay.patternHeight = p.builtin ? 0 : p.height;
            void warmEmbedded([e.overlay]).then(apply);
            apply();
          })]);
        common.push(['縮放', sliderControl(e.overlay.scale, 10, 400, 5, (v) => {
          e.overlay.scale = v; apply();
        }, '%', 130)]);
      }
      rebuild(rows, [formGrid(common)]);
    };
    build();
    return rows;
  };

  // ---- saved styles ----
  let styles = loadStyles();

  const styleRow = (): HTMLElement => {
    const row = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' });
    const build = (): void => {
      const pick = selectControl('', [
        { value: '', label: '套用已存樣式…' },
        ...styles.map((s) => ({ value: s.id, label: s.name })),
      ], (v) => {
        const chosen = styles.find((s) => s.id === v);
        if (!chosen) return;
        Object.assign(e, cloneEffects(chosen.effects));
        // A style can carry its own pattern tile, which has to decode first.
        void warmEmbedded([e.overlay]).then(apply);
        apply();
        rebuildBody();
      });
      const save = el('button', { class: 'btn', text: '存成樣式' });
      on(save, 'click', () => {
        const input = el('input', {
          type: 'text', value: `樣式 ${styles.length + 1}`,
        }) as HTMLInputElement;
        // Keystrokes must stay in this prompt; the style dialog behind it
        // would otherwise see Escape and close them both.
        on(input, 'keydown', (ev) => { ev.stopPropagation(); });
        void openModal({ title: '存成樣式', body: input, width: 320 }).then((r) => {
          if (r !== 'ok') return;
          styles = [...styles, createStyle(input.value.trim(), e)];
          saveStyles(styles);
          app.status(`已存成樣式「${styles[styles.length - 1].name}」`);
          build();
        });
      });
      const clear = el('button', { class: 'btn', text: '清除效果' });
      on(clear, 'click', () => {
        Object.assign(e, defaultEffects());
        apply();
        rebuildBody();
      });
      rebuild(row, [pick, save, clear, el('div', { class: 'hint', text: describeStyle(e) })]);
    };
    build();
    return row;
  };

  const before = JSON.parse(JSON.stringify(layer.effects)) as typeof layer.effects;
  rebuildBody();
  const res = await openModal({ title: '圖層樣式', body });
  if (res === 'ok') {
    apply();
    doc.commit('圖層樣式');
  } else {
    layer.effects = before;
    doc.touch();
  }
  app.changed();
}

export async function aboutDialog(): Promise<void> {
  const body = el('div', { style: 'max-width:460px;display:grid;gap:8px' },
    el('div', { style: 'font-size:18px;font-weight:700;color:var(--text-bright)', text: 'Photograp' }),
    el('div', { class: 'hint', text: '版本 1.0.0 · MIT 授權的開源影像編輯器' }),
    el('p', {
      text: '以 TypeScript 與 HTML5 Canvas 實作的圖層式影像編輯器，'
        + '支援圖層、遮色片、選取範圍、混合模式、非破壞性調整圖層與濾鏡。'
        + '所有運算都在瀏覽器本機完成，影像不會上傳到任何伺服器。',
    }),
    el('div', { class: 'hint', text: '專案檔副檔名：.pgraph（JSON + PNG 圖層資料）' }));
  await openModal({ title: '關於 Photograp', body, buttons: [{ label: '關閉', value: 'ok', primary: true }] });
}

const SHORTCUTS: [string, string][] = [
  ['V / M / L / W', '移動、選取畫面、套索、魔術棒'],
  ['C / I / B / E', '裁切、滴管、筆刷、橡皮擦'],
  ['S / R / O', '仿製印章、模糊指尖、加亮加深'],
  ['G / T / U', '油漆桶漸層、文字、形狀'],
  ['H / Z / 空白鍵', '手形、縮放、暫時平移'],
  ['Ctrl+N / O / S', '新增、開啟、儲存專案'],
  ['Ctrl+Shift+S', '轉存影像'],
  ['Ctrl+Z / Ctrl+Shift+Z', '還原 / 重做'],
  ['Ctrl+X / C / V', '剪下、拷貝、貼上'],
  ['Ctrl+A / D / Shift+I', '全選、取消選取、反轉選取'],
  ['Ctrl+T', '任意變形'],
  ['Ctrl+J', '拷貝圖層'],
  ['Ctrl+E / Ctrl+Shift+E', '向下合併 / 合併可見圖層'],
  ['Ctrl+G', '群組圖層'],
  ['Ctrl+ +/- / Ctrl+0 / Ctrl+1', '放大、縮小、顯示全頁、100%'],
  ['[ / ]', '縮小 / 放大筆刷'],
  ['Ctrl+;  /  Ctrl+Shift+;', '顯示參考線 / 切換靠齊'],
  ['從尺標拖曳', '建立參考線（移動工具可拖動，拖出畫布即刪除）'],
  ['拖曳時按住 Ctrl', '暫時停用靠齊'],
  ['J', '汙點修復筆刷 / 修復筆刷'],
  ['Shift+Backspace', '內容感知填色'],
  ['Q', '切換快速遮色片模式'],
  ['Ctrl+Shift+X', '液化'],
  ['X / D', '交換前景背景色 / 重設為黑白'],
  ['Alt+Backspace / Ctrl+Backspace', '填入前景色 / 背景色'],
  ['Delete', '刪除選取範圍內容'],
  ['Ctrl+滾輪', '以游標為中心縮放'],
];

export async function shortcutsDialog(): Promise<void> {
  const grid = el('div', { class: 'form-grid', style: 'min-width:420px' });
  for (const [k, v] of SHORTCUTS) {
    grid.append(el('kbd', { text: k, style: 'color:var(--text-bright)' }));
    grid.append(el('span', { text: v }));
  }
  await openModal({
    title: '鍵盤快速鍵', body: grid,
    buttons: [{ label: '關閉', value: 'ok', primary: true }],
  });
}
