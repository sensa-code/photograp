import type { App } from '../core/app';
import { PhotoDoc } from '../core/document';
import { createRasterLayer, findParent } from '../core/layer';
import { cloneSurface, createSurface, opaqueBounds } from '../core/surface';
import { compositeLayers } from '../core/compositor';
import { rasterizePath } from '../core/selection';
import { pathFromLoops, toPath2D, createPath, pathIsEmpty, anchorCount } from '../core/path';
import { channelCoverage, createAlphaChannel } from '../core/channels';
import { quickMaskCoverage } from '../core/quickmask';
import { createGuide, type GuideAxis } from '../core/guides';
import {
  cloneShapeStyle, describeShape, renderShapeLayer, type ShapeStyle,
} from '../core/shape';
import { applyFillRegion, contentAwareFill } from '../filters/inpaint';
import { dilateMask } from '../filters/heal';
import { createSmartObject, renderSmartLayer, replaceSmartSource, smartFilterEntry } from '../core/smart';
import { rgbCss } from '../core/color';
import { defaultPathBinding, renderTextLayer } from '../core/text';
import { flattenPath } from '../core/path';
import { askSnapshotName } from './panels/history';
import { FILTER_GROUPS, defaultParams, getFilter, type ParamValue } from '../filters/registry';
import { loadImageFile, pickOpenFiles } from '../io/files';
import { liquifyDialog } from './dialogs/liquify';
import { refineEdgeDialog } from './dialogs/refine';
import {
  applyComp, captureComp, defaultCapture, recaptureComp, type LayerComp,
} from '../core/comps';
import { contentAwareScaleDialog } from './dialogs/seam';
import { cmd, type Cmd } from './command-types';
import { el, on } from './dom';
import {
  checkboxControl, colorChip, formGrid, numberControl, openModal,
  selectControl, sliderControl,
} from './modal';

const doc = (app: App): PhotoDoc | null => app.activeDoc();
const hasPath = (app: App): boolean => !pathIsEmpty(doc(app)?.activePath() ?? null);
const hasSelection = (app: App): boolean => doc(app)?.selection.active ?? false;
const smartLayer = (app: App): ReturnType<PhotoDoc['activeLayer']> => {
  const l = doc(app)?.activeLayer();
  return l && l.kind === 'smart' && l.smart ? l : null;
};

/** Where an "edit contents" document should write its result back to. */
export interface SmartEditLink {
  childDocId: string;
  parentDocId: string;
  layerId: string;
}
const editLinks = new Map<string, SmartEditLink>();
export const smartEditLink = (childDocId: string): SmartEditLink | undefined =>
  editLinks.get(childDocId);

// ---------------------------------------------------------------- paths ----

function pathToCoverage(app: App): Uint8Array | null {
  const d = doc(app);
  const path = d?.activePath();
  if (!d || !path) return null;
  return rasterizePath(toPath2D(path, false), d.width, d.height);
}

function paintPath(app: App, mode: 'fill' | 'stroke'): void {
  const d = doc(app);
  const target = d?.paintTarget();
  const path = d?.activePath();
  if (!d || !path || !target) {
    app.toast('需要一個可編輯的點陣圖層與路徑', 'error');
    return;
  }
  const paint = createSurface(d.width, d.height);
  const p2d = toPath2D(path, mode === 'stroke');
  if (mode === 'fill') {
    paint.ctx.fillStyle = rgbCss(app.foreground);
    paint.ctx.fill(p2d);
  } else {
    const size = Number(app.toolOptions.brush?.size ?? 12);
    paint.ctx.strokeStyle = rgbCss(app.foreground);
    paint.ctx.lineWidth = Math.max(1, size);
    paint.ctx.lineCap = 'round';
    paint.ctx.lineJoin = 'round';
    paint.ctx.stroke(p2d);
  }
  if (target.clipToSelection && d.selection.active) {
    paint.ctx.globalCompositeOperation = 'destination-in';
    paint.ctx.drawImage(d.selection.toSurface().canvas, 0, 0);
  }
  const dest = d.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.drawImage(paint.canvas, -target.offX, -target.offY);
  d.commit(mode === 'fill' ? '填滿路徑' : '筆畫路徑');
  app.changed();
}

// -------------------------------------------------------------- channels ----

function saveSelectionAsChannel(app: App): void {
  const d = doc(app);
  if (!d || !d.selection.active) { app.toast('請先建立選取範圍', 'error'); return; }
  const ch = createAlphaChannel(`Alpha ${d.channels.length + 1}`, d.width, d.height, d.selection.mask);
  d.channels.push(ch);
  d.commit('儲存選取範圍');
  app.toast(`已儲存為「${ch.name}」`, 'success');
  app.changed();
}

// --------------------------------------------------------- smart objects ----

function convertToSmartObject(app: App): void {
  const d = doc(app);
  const layer = d?.activeLayer();
  if (!d || !layer) return;
  if (layer.kind === 'smart') { app.toast('此圖層已經是智慧型物件'); return; }
  if (layer.kind === 'group') { app.toast('群組圖層請先點陣化', 'error'); return; }

  // Bake the current appearance, then keep it as the untouched source.
  const rendered = compositeLayers([{ ...layer, opacity: 1, blend: 'normal', clipped: false, mask: null }], {
    width: d.width, height: d.height,
  });
  const bounds = opaqueBounds(rendered) ?? { x: 0, y: 0, w: d.width, h: d.height };
  const source = createSurface(Math.max(1, bounds.w), Math.max(1, bounds.h));
  source.ctx.drawImage(rendered.canvas, -bounds.x, -bounds.y);

  const found = findParent(d.layers, layer.id);
  if (!found) return;
  const next = createRasterLayer(layer.name, d.width, d.height);
  next.kind = 'smart';
  next.opacity = layer.opacity;
  next.blend = layer.blend;
  next.clipped = layer.clipped;
  next.mask = layer.mask;
  next.effects = layer.effects;
  next.smart = createSmartObject(source, bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
  renderSmartLayer(next, d.width, d.height);
  found.list.splice(found.index, 1, next);
  d.activeLayerId = next.id;
  d.commit('轉換為智慧型物件');
  app.toast('已轉換為智慧型物件，縮放不再損失畫質', 'success');
  app.changed();
}

function editSmartContents(app: App): void {
  const parent = doc(app);
  const layer = smartLayer(app);
  if (!parent || !layer?.smart) return;
  const s = layer.smart;
  const child = new PhotoDoc(`${layer.name} (內容)`, s.sourceWidth, s.sourceHeight, parent.meta.dpi);
  const content = createRasterLayer('內容', s.sourceWidth, s.sourceHeight, cloneSurface(s.source));
  child.layers.push(content);
  child.activeLayerId = content.id;
  child.history.commit(child, '開啟智慧型物件內容');
  child.savedRevision = child.revision;
  app.addDoc(child);
  editLinks.set(child.meta.id, {
    childDocId: child.meta.id,
    parentDocId: parent.meta.id,
    layerId: layer.id,
  });
  app.toast('編輯完成後請選擇「圖層 → 智慧型物件 → 儲存回智慧型物件」', 'info');
}

function commitSmartContents(app: App): void {
  const child = doc(app);
  if (!child) return;
  const link = editLinks.get(child.meta.id);
  if (!link) { app.toast('這個文件不是智慧型物件的內容', 'error'); return; }
  const parent = app.docs.find((x) => x.meta.id === link.parentDocId);
  const layer = parent?.allLayers().find((l) => l.id === link.layerId);
  if (!parent || !layer?.smart) { app.toast('找不到來源智慧型物件', 'error'); return; }
  replaceSmartSource(layer, child.render(), parent.width, parent.height);
  parent.commit('更新智慧型物件內容');
  child.savedRevision = child.revision;
  app.setActiveDoc(parent.meta.id);
  app.toast('已更新智慧型物件', 'success');
  app.changed();
}

async function replaceSmartContents(app: App): Promise<void> {
  const d = doc(app);
  const layer = smartLayer(app);
  if (!d || !layer?.smart) return;
  const files = await pickOpenFiles('image/*', false, true);
  if (!files.length) return;
  const img = await loadImageFile(await files[0].blob());
  const source = createSurface(img.naturalWidth, img.naturalHeight);
  source.ctx.drawImage(img, 0, 0);
  replaceSmartSource(layer, source, d.width, d.height);
  d.commit('置換智慧型物件內容');
  app.changed();
}

/** Add or edit the non-destructive filter stack on a smart object. */
async function smartFilterDialog(app: App): Promise<void> {
  const d = doc(app);
  const layer = smartLayer(app);
  if (!d || !layer?.smart) return;
  const s = layer.smart;
  const before = s.filters.map((f) => ({ ...f, params: { ...f.params } }));

  const apply = (): void => {
    renderSmartLayer(layer, d.width, d.height);
    d.touch();
    app.changed();
  };

  const list = el('div', { style: 'display:grid;gap:8px' });

  const rebuild = (): void => {
    list.replaceChildren();
    if (!s.filters.length) {
      list.append(el('div', { class: 'hint', text: '尚未加入智慧型濾鏡。' }));
    }
    s.filters.forEach((entry, index) => {
      const def = getFilter(entry.filterId);
      if (!def) return;
      const box = el('div', {
        style: 'border:1px solid var(--line);border-radius:5px;padding:8px;display:grid;gap:7px',
      });
      const head = el('div', { style: 'display:flex;align-items:center;gap:8px' },
        checkboxControl(def.label, entry.enabled, (v) => { entry.enabled = v; apply(); }));
      const up = el('button', { class: 'mini-btn', text: '▲', title: '上移' });
      on(up, 'click', () => {
        if (index === 0) return;
        s.filters.splice(index - 1, 0, s.filters.splice(index, 1)[0]);
        rebuild(); apply();
      });
      const down = el('button', { class: 'mini-btn', text: '▼', title: '下移' });
      on(down, 'click', () => {
        if (index >= s.filters.length - 1) return;
        s.filters.splice(index + 1, 0, s.filters.splice(index, 1)[0]);
        rebuild(); apply();
      });
      const del = el('button', { class: 'mini-btn', text: '✕', title: '刪除' });
      on(del, 'click', () => { s.filters.splice(index, 1); rebuild(); apply(); });
      head.append(el('span', { style: 'flex:1' }), up, down, del);
      box.append(head);

      for (const p of def.params) {
        if (p.type === 'slider') {
          box.append(el('div', { style: 'display:grid;grid-template-columns:92px 1fr;gap:8px;align-items:center' },
            el('label', { class: 'hint', text: p.label }),
            sliderControl(
              Number(entry.params[p.key]), p.min ?? 0, p.max ?? 100, p.step ?? 1,
              (v) => { entry.params[p.key] = v; apply(); }, p.unit ?? '', 130,
            )));
        } else if (p.type === 'checkbox') {
          box.append(checkboxControl(p.label, Boolean(entry.params[p.key]), (v) => {
            entry.params[p.key] = v; apply();
          }));
        } else if (p.type === 'select') {
          box.append(el('div', { style: 'display:grid;grid-template-columns:92px 1fr;gap:8px;align-items:center' },
            el('label', { class: 'hint', text: p.label }),
            selectControl(String(entry.params[p.key]), p.options ?? [], (v) => {
              entry.params[p.key] = v; apply();
            })));
        } else if (p.type === 'color') {
          box.append(el('div', { style: 'display:grid;grid-template-columns:92px 1fr;gap:8px;align-items:center' },
            el('label', { class: 'hint', text: p.label }),
            colorChip(entry.params[p.key] as { r: number; g: number; b: number }, (c) => {
              entry.params[p.key] = c; apply();
            })));
        }
      }

      box.append(el('div', { style: 'display:grid;grid-template-columns:92px 1fr;gap:8px;align-items:center' },
        el('label', { class: 'hint', text: '不透明度' }),
        sliderControl(entry.opacity * 100, 0, 100, 1, (v) => { entry.opacity = v / 100; apply(); }, '%', 130)));
      list.append(box);
    });
  };
  rebuild();

  const picker = selectControl('', [
    { value: '', label: '新增濾鏡…' },
    ...FILTER_GROUPS().flatMap((g) => g.items.map((f) => ({ value: f.id, label: `${g.group} / ${f.label}` }))),
  ], (v) => {
    if (!v) return;
    const def = getFilter(v);
    if (!def) return;
    s.filters.push(smartFilterEntry(def.id, defaultParams(def) as Record<string, ParamValue>));
    picker.value = '';
    rebuild();
    apply();
  });

  const body = el('div', { style: 'display:grid;gap:12px;min-width:380px;max-height:60vh' }, picker, list);
  const result = await openModal({ title: '智慧型濾鏡', body });
  if (result !== 'ok') {
    s.filters = before;
    renderSmartLayer(layer, d.width, d.height);
    d.touch();
  } else {
    d.commit('智慧型濾鏡');
  }
  app.changed();
}

async function smartTransformDialog(app: App): Promise<void> {
  const d = doc(app);
  const layer = smartLayer(app);
  if (!d || !layer?.smart) return;
  const s = layer.smart;
  const before = { ...s };
  const apply = (): void => {
    renderSmartLayer(layer, d.width, d.height);
    d.touch();
    app.changed();
  };
  const body = formGrid([
    [null, el('div', { class: 'hint', text: `原始尺寸 ${s.sourceWidth} × ${s.sourceHeight} px（縮放不會損失畫質）` })],
    ['中心 X', numberControl(s.cx, -20000, 20000, 1, (v) => { s.cx = v; apply(); })],
    ['中心 Y', numberControl(s.cy, -20000, 20000, 1, (v) => { s.cy = v; apply(); })],
    ['水平縮放 %', sliderControl(s.scaleX * 100, 1, 800, 1, (v) => { s.scaleX = v / 100; apply(); }, '%', 160)],
    ['垂直縮放 %', sliderControl(s.scaleY * 100, 1, 800, 1, (v) => { s.scaleY = v / 100; apply(); }, '%', 160)],
    ['旋轉', sliderControl((s.angle * 180) / Math.PI, -180, 180, 1, (v) => {
      s.angle = (v * Math.PI) / 180; apply();
    }, '°', 160)],
  ]);
  if (await openModal({ title: '智慧型物件變形', body }) === 'ok') {
    d.commit('智慧型物件變形');
  } else {
    Object.assign(s, before);
    renderSmartLayer(layer, d.width, d.height);
    d.touch();
  }
  app.changed();
}

async function quickMaskOptionsDialog(app: App): Promise<void> {
  const d = doc(app);
  if (!d) return;
  if (!d.quickMask) { d.enterQuickMask(); }
  const qm = d.quickMask!;
  const before = { ...qm, color: { ...qm.color } };
  const apply = (): void => { d.touch(); app.changed(); };
  const body = formGrid([
    ['顏色指示', selectControl(qm.showMaskedAreas ? 'masked' : 'selected', [
      { value: 'masked', label: '受遮色片保護的區域' },
      { value: 'selected', label: '選取的區域' },
    ], (v) => { qm.showMaskedAreas = v === 'masked'; apply(); })],
    ['顏色', colorChip(qm.color, (c) => { qm.color = c; apply(); })],
    ['不透明度', sliderControl(qm.opacity * 100, 1, 100, 1, (v) => {
      qm.opacity = v / 100; apply();
    }, '%', 150)],
  ]);
  if (await openModal({ title: '快速遮色片選項', body }) === 'ok') {
    d.commit('快速遮色片選項');
  } else {
    d.quickMask = { ...before, surface: qm.surface };
    d.touch();
  }
  app.changed();
}

/**
 * Content-aware fill: rebuild the selection from the surrounding image.
 * The work is synchronous, so the toast is flushed first and the fill runs
 * on the next frame; otherwise the UI would freeze with no explanation.
 */
async function contentAwareFillDialog(app: App): Promise<void> {
  const d = doc(app);
  const target = d?.paintTarget();
  if (!d || !target) { app.toast('請先選擇可編輯的圖層', 'error'); return; }
  if (!d.selection.active) { app.toast('請先建立選取範圍', 'error'); return; }

  let quality = '480';
  let detail = 7;
  let expand = 2;
  const body = formGrid([
    [null, el('div', {
      class: 'hint',
      text: '選取範圍會以周圍的影像重新合成。選取時多框一點邊緣，結果通常更自然。',
    })],
    ['品質', selectControl(quality, [
      { value: '320', label: '快速（較小取樣）' },
      { value: '480', label: '標準' },
      { value: '720', label: '精細（較慢）' },
    ], (v) => { quality = v; })],
    ['結構細節', sliderControl(detail, 3, 15, 2, (v) => { detail = v; }, ' px', 150)],
    ['擴張選取範圍', sliderControl(expand, 0, 12, 1, (v) => { expand = v; }, ' px', 150)],
  ]);
  if (await openModal({ title: '內容感知填色', body }) !== 'ok') return;

  app.status('內容感知填色運算中…');
  app.toast('內容感知填色運算中…');
  // A plain timeout, not requestAnimationFrame: rAF never fires while the
  // tab is hidden, which would leave the fill waiting forever.
  await new Promise((r) => setTimeout(r, 32));

  const w = target.surface.w, h = target.surface.h;
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mask[y * w + x] = d.selection.at(x + target.offX, y + target.offY);
    }
  }
  if (expand > 0) mask = dilateMask(mask, w, h, expand);

  const img = target.surface.ctx.getImageData(0, 0, w, h);
  const started = performance.now();
  const region = contentAwareFill(img, mask, {
    patchSize: detail,
    maxWorkingSize: Number(quality),
    iterations: quality === '720' ? 5 : 4,
  });
  if (!region) {
    app.toast('選取範圍太大或周圍沒有可取樣的內容', 'error');
    return;
  }
  applyFillRegion(img, region, mask);
  const dest = d.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.putImageData(img, 0, 0);
  d.commit('內容感知填色');
  app.toast(`內容感知填色完成（${Math.round(performance.now() - started)} ms）`, 'success');
  app.changed();
}

async function newGuideDialog(app: App): Promise<void> {
  const d = doc(app);
  if (!d) return;
  let axis: GuideAxis = 'v';
  let pos = Math.round(d.width / 2);
  const body = formGrid([
    ['方向', selectControl('v', [
      { value: 'v', label: '垂直' },
      { value: 'h', label: '水平' },
    ], (v) => { axis = v as GuideAxis; })],
    ['位置 (px)', numberControl(pos, 0, Math.max(d.width, d.height), 1, (v) => { pos = v; })],
  ]);
  if (await openModal({ title: '新增參考線', body }) !== 'ok') return;
  const limit = axis === 'v' ? d.width : d.height;
  d.guides.push(createGuide(axis, Math.max(0, Math.min(limit, pos))));
  d.commit('新增參考線');
  app.changed();
}

async function gridSizeDialog(app: App): Promise<void> {
  let size = app.gridSize;
  const body = formGrid([
    ['格點間距 (px)', numberControl(size, 2, 500, 1, (v) => { size = Math.round(v); })],
  ]);
  if (await openModal({ title: '格點間距', body }) !== 'ok') return;
  app.gridSize = Math.max(2, size);
  app.events.emit('view-changed', undefined);
  app.changed();
}

/** Build guides along the edges of the current selection. */
function guidesFromSelection(app: App): void {
  const d = doc(app);
  const b = d?.selection.bounds();
  if (!d || !b) { app.toast('請先建立選取範圍', 'error'); return; }
  d.guides.push(
    createGuide('v', b.x), createGuide('v', b.x + b.w),
    createGuide('h', b.y), createGuide('h', b.y + b.h),
  );
  d.commit('由選取範圍建立參考線');
  app.changed();
}

async function takeSnapshot(app: App): Promise<void> {
  const d = doc(app);
  if (!d) return;
  const name = await askSnapshotName(`快照 ${d.history.named.length + 1}`);
  if (name === null) return;
  d.history.addNamed(d, name);
  app.status(`已建立快照「${name}」`);
  app.changed();
}

/** Edit > Fill from History: the selection, repainted from the source state. */
function fillFromHistory(app: App): void {
  const d = doc(app);
  const target = d?.paintTarget();
  if (!d || !target) {
    app.toast(d?.paintBlockReason() ?? '此圖層無法編輯', 'error');
    return;
  }
  if (target.slot !== 'pixels' || !target.layer) {
    app.toast('只能填充到圖層像素上', 'error');
    return;
  }
  const src = d.historySource(target.layer);
  if (!src) { app.toast(d.historySourceReason() ?? '沒有可用的來源', 'error'); return; }

  const out = createSurface(target.surface.w, target.surface.h);
  out.ctx.drawImage(src.surface.canvas, -src.dx, -src.dy);
  if (d.selection.active) {
    // Only the selected part comes back; the rest of the layer is untouched.
    out.ctx.globalCompositeOperation = 'destination-in';
    out.ctx.drawImage(d.selection.toSurface().canvas, -target.layer.x, -target.layer.y);
    out.ctx.globalCompositeOperation = 'destination-over';
    out.ctx.drawImage(target.surface.canvas, 0, 0);
  }
  const dest = d.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.clearRect(0, 0, dest.w, dest.h);
  dest.ctx.drawImage(out.canvas, 0, 0);
  d.commit('填滿步驟記錄');
  app.changed();
}

async function newComp(app: App): Promise<void> {
  const d = doc(app);
  if (!d) return;
  const capture = defaultCapture();
  const name = el('input', {
    type: 'text', value: `圖層構成 ${d.comps.length + 1}`,
  }) as HTMLInputElement;
  const note = el('input', { type: 'text', placeholder: '選填說明' }) as HTMLInputElement;
  const body = formGrid([
    ['名稱', name],
    ['說明', note],
    [null, checkboxControl('可見度', capture.visibility, (v) => { capture.visibility = v; })],
    [null, checkboxControl('位置', capture.position, (v) => { capture.position = v; })],
    [null, checkboxControl('外觀（混合模式、不透明度、圖層樣式）',
      capture.appearance, (v) => { capture.appearance = v; })],
  ]);
  if (await openModal({ title: '建立圖層構成', body, width: 380 }) !== 'ok') return;

  const comp = captureComp(d.layers, name.value.trim(), capture, note.value.trim());
  d.comps = [...d.comps, comp];
  d.activeCompId = comp.id;
  d.commit('建立圖層構成');
  app.status(`已建立圖層構成「${comp.name}」`);
  app.changed();
}

const currentComp = (app: App): LayerComp | null => {
  const d = doc(app);
  return d?.comps.find((c) => c.id === d.activeCompId) ?? null;
};

function applyCurrentComp(app: App): void {
  const d = doc(app);
  const comp = currentComp(app);
  if (!d || !comp) return;
  const res = applyComp(d.layers, comp);
  d.commit(`套用構成：${comp.name}`);
  const bits = [`套用了 ${res.applied} 個圖層`];
  // Say so rather than pretending: a comp taken before a layer was deleted
  // simply has nothing to restore for it.
  if (res.missing) bits.push(`${res.missing} 個已不存在`);
  if (res.extra) bits.push(`${res.extra} 個不在這個構成裡`);
  app.status(bits.join('，'));
  app.changed();
}

function updateCurrentComp(app: App): void {
  const d = doc(app);
  const comp = currentComp(app);
  if (!d || !comp) return;
  d.comps = d.comps.map((c) => (c.id === comp.id ? recaptureComp(c, d.layers) : c));
  d.commit('更新圖層構成');
  app.status(`「${comp.name}」已更新為目前狀態`);
  app.changed();
}

function deleteCurrentComp(app: App): void {
  const d = doc(app);
  const comp = currentComp(app);
  if (!d || !comp) return;
  d.comps = d.comps.filter((c) => c.id !== comp.id);
  d.activeCompId = null;
  d.commit('刪除圖層構成');
  app.changed();
}

/** The active layer when it is type, which is what the path commands act on. */
const textLayer = (app: App): ReturnType<PhotoDoc['activeLayer']> => {
  const l = doc(app)?.activeLayer();
  return l && l.kind === 'text' && l.text && !l.locked ? l : null;
};

function attachTextToPath(app: App): void {
  const d = doc(app);
  const layer = textLayer(app);
  const path = d?.activePath();
  if (!d || !layer?.text) return;
  if (!path || !flattenPath(path).length) {
    app.toast('請先選擇一條至少有兩個控制點的路徑', 'error');
    return;
  }
  layer.text.onPath = defaultPathBinding(path.id);
  renderTextLayer(layer, d.width, d.height, d.paths);
  d.commit('使文字沿路徑');
  app.status(`「${layer.name}」已沿著路徑「${path.name}」排列`);
  app.changed();
}

function detachTextFromPath(app: App): void {
  const d = doc(app);
  const layer = textLayer(app);
  if (!d || !layer?.text?.onPath) return;
  // Leave the block where the type was sitting rather than at the origin.
  const flat = flattenPath(d.paths.find((p) => p.id === layer.text!.onPath!.pathId)
    ?? { id: '', name: '', subpaths: [] })[0];
  const start = flat?.pts[0];
  layer.text.onPath = undefined;
  if (start) {
    layer.x = Math.round(start.x);
    layer.y = Math.round(start.y);
  }
  renderTextLayer(layer, d.width, d.height, d.paths);
  d.commit('解除文字路徑');
  app.changed();
}

/** The active layer when it is an unlocked, re-editable vector shape. */
const shapeLayer = (app: App): ReturnType<PhotoDoc['activeLayer']> => {
  const l = doc(app)?.activeLayer();
  return l && l.kind === 'shape' && l.shape ? l : null;
};

function shapeOptionsDialog(app: App): void {
  const d = doc(app);
  const layer = shapeLayer(app);
  if (!d || !layer?.shape) return;
  const original = cloneShapeStyle(layer.shape.style);
  const style = layer.shape.style;

  const apply = <K extends keyof ShapeStyle>(key: K, value: ShapeStyle[K]): void => {
    style[key] = value;
    renderShapeLayer(layer, d.width, d.height);
    d.touch();
    app.changed();
  };

  const body = formGrid([
    [null, el('div', { class: 'hint', text: describeShape(layer.shape) })],
    [null, checkboxControl('填色', style.fillEnabled, (v) => apply('fillEnabled', v))],
    ['顏色', colorChip(style.fill, (c) => apply('fill', c))],
    ['不透明度', sliderControl(style.fillOpacity * 100, 0, 100, 1,
      (v) => apply('fillOpacity', v / 100), '%')],
    [null, checkboxControl('筆畫', style.strokeEnabled, (v) => apply('strokeEnabled', v))],
    ['筆畫顏色', colorChip(style.stroke, (c) => apply('stroke', c))],
    ['筆畫寬度', sliderControl(style.strokeWidth, 0, 200, 0.5,
      (v) => apply('strokeWidth', v), 'px')],
    ['筆畫不透明度', sliderControl(style.strokeOpacity * 100, 0, 100, 1,
      (v) => apply('strokeOpacity', v / 100), '%')],
    ['對齊', selectControl(style.strokeAlign, [
      { value: 'center', label: '置中' },
      { value: 'inside', label: '內部' },
      { value: 'outside', label: '外部' },
    ], (v) => apply('strokeAlign', v as ShapeStyle['strokeAlign']))],
    ['虛線', sliderControl(style.dash, 0, 60, 1, (v) => apply('dash', v), 'px')],
    ['轉角', selectControl(style.lineJoin, [
      { value: 'miter', label: '尖角' },
      { value: 'round', label: '圓角' },
      { value: 'bevel', label: '斜角' },
    ], (v) => apply('lineJoin', v as CanvasLineJoin))],
    ['端點', selectControl(style.lineCap, [
      { value: 'butt', label: '平端' },
      { value: 'round', label: '圓端' },
      { value: 'square', label: '方端' },
    ], (v) => apply('lineCap', v as CanvasLineCap))],
  ]);

  void openModal({ title: '形狀選項', body, width: 380 }).then((res) => {
    if (res === 'ok') {
      d.commit('形狀選項');
    } else {
      // Cancel restores the style the dialog started from.
      Object.assign(style, original);
      renderShapeLayer(layer, d.width, d.height);
      d.touch();
    }
    app.changed();
  });
}

const snapToggle = (
  id: string, label: string, key: 'toGuides' | 'toGrid' | 'toDocument' | 'toLayers',
): Cmd => cmd(id, label, (a) => {
  a.snap[key] = !a.snap[key];
  a.events.emit('view-changed', undefined);
}, { checked: (a) => a.snap[key] });

export const VECTOR_COMMANDS: Cmd[] = [
  // ---- retouching ----
  cmd('edit.contentAwareFill', '內容感知填色…', (a) => contentAwareFillDialog(a), {
    shortcut: 'Shift+Backspace',
    enabled: (a) => hasSelection(a) && !!doc(a)?.paintTarget(),
  }),

  // ---- guides and snapping ----
  cmd('view.guides', '顯示參考線', (a) => {
    const v = a.view();
    v.showGuides = !v.showGuides;
    a.events.emit('view-changed', undefined);
  }, { shortcut: "Ctrl+;", enabled: (a) => !!doc(a), checked: (a) => a.view().showGuides }),
  cmd('view.lockGuides', '鎖定參考線', (a) => {
    const d = doc(a);
    if (!d) return;
    d.guidesLocked = !d.guidesLocked;
    d.commit(d.guidesLocked ? '鎖定參考線' : '解除鎖定參考線');
    a.changed();
  }, { shortcut: 'Ctrl+Alt+;', enabled: (a) => !!doc(a), checked: (a) => !!doc(a)?.guidesLocked }),
  cmd('view.newGuide', '新增參考線…', (a) => newGuideDialog(a), { enabled: (a) => !!doc(a) }),
  cmd('view.guidesFromSelection', '由選取範圍建立參考線', guidesFromSelection, {
    enabled: hasSelection,
  }),
  cmd('view.clearGuides', '清除參考線', (a) => {
    const d = doc(a);
    if (!d || !d.guides.length) return;
    d.guides = [];
    d.commit('清除參考線');
    a.changed();
  }, { enabled: (a) => (doc(a)?.guides.length ?? 0) > 0 }),
  cmd('view.snap', '靠齊', (a) => {
    a.snap.enabled = !a.snap.enabled;
    a.events.emit('view-changed', undefined);
    a.status(a.snap.enabled ? '已開啟靠齊（拖曳時按住 Ctrl 可暫時停用）' : '已關閉靠齊');
  }, { shortcut: 'Ctrl+Shift+;', checked: (a) => a.snap.enabled }),
  snapToggle('view.snapGuides', '靠齊至參考線', 'toGuides'),
  snapToggle('view.snapGrid', '靠齊至格點', 'toGrid'),
  snapToggle('view.snapDocument', '靠齊至文件邊界', 'toDocument'),
  snapToggle('view.snapLayers', '靠齊至圖層', 'toLayers'),
  cmd('view.gridSize', '格點間距…', (a) => gridSizeDialog(a)),

  // ---- layer comps ----
  cmd('comp.new', '建立圖層構成…', (a) => { void newComp(a); }, {
    enabled: (a) => !!doc(a),
  }),
  cmd('comp.apply', '套用圖層構成', applyCurrentComp, {
    enabled: (a) => !!currentComp(a),
  }),
  cmd('comp.update', '更新圖層構成', updateCurrentComp, {
    enabled: (a) => !!currentComp(a),
  }),
  cmd('comp.delete', '刪除圖層構成', deleteCurrentComp, {
    enabled: (a) => !!currentComp(a),
  }),

  // ---- content-aware scale ----
  cmd('edit.contentAwareScale', '內容感知比例…', (a) => {
    void contentAwareScaleDialog(a);
  }, { enabled: (a) => !!doc(a)?.paintTarget() }),

  // ---- select and mask ----
  cmd('select.refineEdge', '選取並遮住…', (a) => { void refineEdgeDialog(a); }, {
    shortcut: 'Ctrl+Alt+R',
    enabled: hasSelection,
  }),

  // ---- history snapshots ----
  cmd('history.snapshot', '建立快照…', (a) => { void takeSnapshot(a); }, {
    enabled: (a) => !!doc(a),
  }),
  cmd('edit.fillHistory', '填滿步驟記錄', fillFromHistory, {
    enabled: (a) => !!doc(a)?.paintTarget() && !doc(a)?.historySourceReason(),
  }),

  // ---- type on a path ----
  cmd('text.onPath', '使文字沿路徑', attachTextToPath, {
    enabled: (a) => !!textLayer(a) && !pathIsEmpty(doc(a)?.activePath() ?? null),
  }),
  cmd('text.offPath', '解除文字路徑', detachTextFromPath, {
    enabled: (a) => !!textLayer(a)?.text?.onPath,
  }),

  // ---- vector shape layers ----
  cmd('layer.shapeOptions', '形狀選項…', (a) => shapeOptionsDialog(a), {
    enabled: (a) => !!shapeLayer(a),
  }),


  // ---- liquify ----
  cmd('filter.liquify', '液化…', (a) => liquifyDialog(a), {
    shortcut: 'Ctrl+Shift+X',
    enabled: (a) => !!doc(a)?.paintTarget(),
  }),

  // ---- quick mask ----
  cmd('quickmask.toggle', '以快速遮色片模式編輯', (a) => {
    const d = doc(a);
    if (!d) return;
    if (d.quickMask) {
      d.exitQuickMask();
      d.commit('結束快速遮色片');
      a.status('已將快速遮色片轉換為選取範圍');
    } else {
      d.enterQuickMask();
      d.commit('進入快速遮色片');
      a.status('快速遮色片：用黑色塗抹可遮蔽，白色塗抹可取消遮蔽');
    }
    a.changed();
  }, { shortcut: 'Q', enabled: (a) => !!doc(a), checked: (a) => !!doc(a)?.quickMask }),
  cmd('quickmask.options', '快速遮色片選項…', (a) => quickMaskOptionsDialog(a), {
    enabled: (a) => !!doc(a),
  }),
  cmd('quickmask.toChannel', '將快速遮色片儲存為色版', (a) => {
    const d = doc(a);
    if (!d?.quickMask) { a.toast('請先進入快速遮色片模式', 'error'); return; }
    const cov = quickMaskCoverage(d.quickMask.surface);
    const ch = createAlphaChannel(`Alpha ${d.channels.length + 1}`, d.width, d.height, cov);
    d.channels.push(ch);
    d.commit('儲存快速遮色片');
    a.toast(`已儲存為「${ch.name}」`, 'success');
    a.changed();
  }, { enabled: (a) => !!doc(a)?.quickMask }),

  // ---- paths ----
  cmd('path.new', '新增路徑', (a) => {
    const d = doc(a);
    if (!d) return;
    d.setPath(createPath(`路徑 ${d.paths.length + 1}`));
    d.commit('新增路徑');
    a.changed();
  }, { enabled: (a) => !!doc(a) }),
  cmd('path.makeSelection', '將路徑轉換為選取範圍', (a) => {
    const d = doc(a);
    const cov = pathToCoverage(a);
    if (!d || !cov) { a.toast('沒有可用的路徑', 'error'); return; }
    d.selection.combine(cov, 'replace');
    d.commit('路徑轉選取範圍');
    a.changed();
  }, { shortcut: 'Ctrl+Enter', enabled: hasPath }),
  cmd('path.fromSelection', '從選取範圍建立工作路徑', (a) => {
    const d = doc(a);
    if (!d || !d.selection.active) { a.toast('請先建立選取範圍', 'error'); return; }
    const path = pathFromLoops(d.selection.loops(), 1.5, '工作路徑');
    if (pathIsEmpty(path)) { a.toast('選取範圍太小，無法建立路徑', 'error'); return; }
    d.setPath(path);
    d.commit('建立工作路徑');
    a.toast(`已建立 ${anchorCount(path)} 個控制點`, 'success');
    a.changed();
  }, { enabled: hasSelection }),
  cmd('path.fill', '以前景色填滿路徑', (a) => paintPath(a, 'fill'), { enabled: hasPath }),
  cmd('path.stroke', '以筆刷描邊路徑', (a) => paintPath(a, 'stroke'), { enabled: hasPath }),
  cmd('path.delete', '刪除路徑', (a) => {
    const d = doc(a);
    if (!d || !d.activePathId) return;
    d.paths = d.paths.filter((p) => p.id !== d.activePathId);
    d.activePathId = d.paths[d.paths.length - 1]?.id ?? null;
    d.commit('刪除路徑');
    a.changed();
  }, { enabled: (a) => !!doc(a)?.activePathId }),

  // ---- channels ----
  cmd('channel.saveSelection', '儲存選取範圍為色版', saveSelectionAsChannel, { enabled: hasSelection }),
  cmd('channel.new', '新增色版', (a) => {
    const d = doc(a);
    if (!d) return;
    d.channels.push(createAlphaChannel(`Alpha ${d.channels.length + 1}`, d.width, d.height, null));
    d.commit('新增色版');
    a.changed();
  }, { enabled: (a) => !!doc(a) }),
  cmd('channel.loadSelection', '載入色版為選取範圍', (a) => {
    const d = doc(a);
    const ch = d?.channels[d.channels.length - 1];
    if (!d || !ch) { a.toast('沒有可載入的色版', 'error'); return; }
    d.selection.combine(channelCoverage(ch.surface), 'replace');
    d.commit('載入色版選取範圍');
    a.changed();
  }, { enabled: (a) => (doc(a)?.channels.length ?? 0) > 0 }),

  // ---- smart objects ----
  cmd('smart.convert', '轉換為智慧型物件', convertToSmartObject, {
    enabled: (a) => !!doc(a)?.activeLayer(),
  }),
  cmd('smart.transform', '智慧型物件變形…', (a) => smartTransformDialog(a), {
    enabled: (a) => !!smartLayer(a),
  }),
  cmd('smart.filters', '智慧型濾鏡…', (a) => smartFilterDialog(a), {
    enabled: (a) => !!smartLayer(a),
  }),
  cmd('smart.edit', '編輯內容', editSmartContents, { enabled: (a) => !!smartLayer(a) }),
  cmd('smart.commit', '儲存回智慧型物件', commitSmartContents, {
    enabled: (a) => !!doc(a) && editLinks.has(doc(a)!.meta.id),
  }),
  cmd('smart.replace', '置換內容…', (a) => replaceSmartContents(a), {
    enabled: (a) => !!smartLayer(a),
  }),
  cmd('smart.reset', '重設變形', (a) => {
    const d = doc(a);
    const layer = smartLayer(a);
    if (!d || !layer?.smart) return;
    layer.smart.scaleX = 1;
    layer.smart.scaleY = 1;
    layer.smart.angle = 0;
    renderSmartLayer(layer, d.width, d.height);
    d.commit('重設智慧型物件變形');
    a.changed();
  }, { enabled: (a) => !!smartLayer(a) }),
];
