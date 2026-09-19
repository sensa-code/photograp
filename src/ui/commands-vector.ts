import type { App } from '../core/app';
import { PhotoDoc } from '../core/document';
import { createRasterLayer, findParent } from '../core/layer';
import { cloneSurface, createSurface, opaqueBounds } from '../core/surface';
import { compositeLayers } from '../core/compositor';
import { rasterizePath } from '../core/selection';
import { pathFromLoops, toPath2D, createPath, pathIsEmpty, anchorCount } from '../core/path';
import { channelCoverage, createAlphaChannel } from '../core/channels';
import { createSmartObject, renderSmartLayer, replaceSmartSource, smartFilterEntry } from '../core/smart';
import { rgbCss } from '../core/color';
import { FILTER_GROUPS, defaultParams, getFilter, type ParamValue } from '../filters/registry';
import { loadImageFile, pickFiles } from '../io/files';
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
  const layer = d?.activeLayer();
  const path = d?.activePath();
  if (!d || !path || !layer?.surface || layer.locked) {
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
  if (d.selection.active) {
    paint.ctx.globalCompositeOperation = 'destination-in';
    paint.ctx.drawImage(d.selection.toSurface().canvas, 0, 0);
  }
  const target = d.mutableSurface(layer);
  target.ctx.drawImage(paint.canvas, -layer.x, -layer.y);
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
  const files = await pickFiles('image/*');
  if (!files.length) return;
  const img = await loadImageFile(files[0]);
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

export const VECTOR_COMMANDS: Cmd[] = [
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
