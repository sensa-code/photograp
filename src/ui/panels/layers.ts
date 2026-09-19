import type { App } from '../../core/app';
import type { Layer } from '../../core/types';
import { BLEND_GROUPS, BLEND_LABELS } from '../../core/blend';
import { createSurface, type Surface } from '../../core/surface';
import { findParent, layerKindLabel } from '../../core/layer';
import { compositeLayers } from '../../core/compositor';
import { clear, el, on, raf } from '../dom';
import { icon } from './../icons';
import { runCommand } from '../commands';
import { popupMenu } from '../menubar';
import { cmdEntry } from '../menus';
import { openModal, selectControl } from '../modal';

const THUMB = 34;
const thumbCache = new WeakMap<Surface, HTMLCanvasElement>();

function thumbFor(surface: Surface, docW: number, docH: number): HTMLCanvasElement {
  const hit = thumbCache.get(surface);
  if (hit) return hit;
  const scale = Math.min(THUMB / docW, THUMB / docH);
  const w = Math.max(1, Math.round(docW * scale));
  const h = Math.max(1, Math.round(docH * scale));
  const c = createSurface(THUMB, THUMB);
  c.ctx.imageSmoothingQuality = 'medium';
  c.ctx.drawImage(surface.canvas, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
  thumbCache.set(surface, c.canvas);
  return c.canvas;
}

const KIND_FILTERS = [
  { value: 'all', label: '所有類型' },
  { value: 'raster', label: '點陣' },
  { value: 'text', label: '文字' },
  { value: 'shape', label: '形狀' },
  { value: 'smart', label: '智慧型物件' },
  { value: 'adjustment', label: '調整' },
  { value: 'group', label: '群組' },
  { value: 'effects', label: '有樣式' },
  { value: 'masked', label: '有遮色片' },
];

/**
 * Does this layer, or anything nested inside it, pass the panel's filter?
 * Keeping a parent visible when a child matches is what lets a search reach
 * into collapsed groups.
 */
export function layerMatchesFilter(layer: Layer, search: string, kind: string): boolean {
  const deep = (): boolean =>
    (layer.children ?? []).some((c) => layerMatchesFilter(c, search, kind));
  if (search && !layer.name.toLowerCase().includes(search)) return deep();
  switch (kind) {
    case 'all':
      return true;
    case 'effects':
      return Object.values(layer.effects).some((e) => e.enabled) || deep();
    case 'masked':
      return !!layer.mask || deep();
    default:
      return layer.kind === kind || deep();
  }
}

export class LayersPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private search = '';
  private kindFilter = 'all';
  private opacityInput!: HTMLInputElement;
  private blendSelect!: HTMLSelectElement;
  private dragId: string | null = null;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body' });
    this.root = el('div', { class: 'panel grow' },
      el('div', { class: 'panel-head' },
        el('span', { text: '圖層' }),
        this.headTools()),
      this.filterRow(),
      this.controls(),
      this.list,
      this.footer());

    // Painting fires doc-changed on every pointer move; rebuilding the whole
    // list that often is wasted work, so coalesce into one frame.
    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  private headTools(): HTMLElement {
    const menu = el('button', { class: 'mini-btn', html: icon('adjust', 14), title: '圖層選單' });
    on(menu, 'click', () => popupMenu(menu, [
      cmdEntry('layer.duplicate'), cmdEntry('layer.delete'), cmdEntry('layer.rasterize'),
      { kind: 'sep' }, cmdEntry('layer.mergeDown'), cmdEntry('layer.mergeVisible'), cmdEntry('layer.flatten'),
      { kind: 'sep' }, cmdEntry('layer.maskReveal'), cmdEntry('layer.maskHide'),
      cmdEntry('layer.maskSelection'), cmdEntry('layer.maskApply'), cmdEntry('layer.maskDelete'),
      { kind: 'sep' }, cmdEntry('layer.clip'), cmdEntry('layer.style'),
      cmdEntry('layer.shapeOptions'),
    ], this.app));
    return el('div', { class: 'tools' }, menu);
  }

  private filterRow(): HTMLElement {
    const input = el('input', {
      type: 'text', placeholder: '搜尋圖層名稱…', style: 'flex:1;min-width:0',
    }) as HTMLInputElement;
    on(input, 'input', () => { this.search = input.value.trim().toLowerCase(); this.refresh(); });
    const kinds = selectControl('all', KIND_FILTERS, (v) => {
      this.kindFilter = v;
      this.refresh();
    });
    kinds.style.maxWidth = '110px';
    return el('div', { class: 'layer-filter' }, input, kinds);
  }

  private matches(layer: Layer): boolean {
    return layerMatchesFilter(layer, this.search, this.kindFilter);
  }

  private filterActive(): boolean {
    return this.search !== '' || this.kindFilter !== 'all';
  }

  private controls(): HTMLElement {
    this.blendSelect = el('select') as HTMLSelectElement;
    for (const group of BLEND_GROUPS) {
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const m of group.modes) {
        og.append(el('option', { value: m, text: BLEND_LABELS[m] }));
      }
      this.blendSelect.append(og);
    }
    on(this.blendSelect, 'change', () => {
      const doc = this.app.activeDoc();
      const layer = doc?.activeLayer();
      if (!doc || !layer) return;
      layer.blend = this.blendSelect.value as Layer['blend'];
      doc.commit('變更混合模式');
      this.app.changed();
    });

    this.opacityInput = el('input', { type: 'range', min: 0, max: 100, value: 100 }) as HTMLInputElement;
    const readout = el('span', { class: 'val', text: '100%' });
    const applyOpacity = (commit: boolean): void => {
      const doc = this.app.activeDoc();
      const layer = doc?.activeLayer();
      if (!doc || !layer) return;
      layer.opacity = Number(this.opacityInput.value) / 100;
      readout.textContent = `${this.opacityInput.value}%`;
      if (commit) doc.commit('變更不透明度'); else doc.touch();
      this.app.changed();
    };
    on(this.opacityInput, 'input', () => applyOpacity(false));
    on(this.opacityInput, 'change', () => applyOpacity(true));

    return el('div', { class: 'layer-controls' },
      el('label', { text: '混合' }), this.blendSelect,
      el('label', { text: '不透明' }), el('div', { class: 'slider' }, this.opacityInput, readout));
  }

  private footer(): HTMLElement {
    const mk = (name: string, title: string, run: () => void): HTMLElement => {
      const b = el('button', { class: 'mini-btn', html: icon(name, 15), title });
      on(b, 'click', run);
      return b;
    };
    const adjustBtn = mk('adjust', '新增調整圖層', () => {
      popupMenu(adjustBtn, [
        'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance',
        'hue-saturation', 'color-balance', 'black-white', 'photo-filter',
        'gradient-map', 'invert', 'posterize', 'threshold',
      ].map((t) => cmdEntry(`adjustLayer.${t}`)), this.app);
    });

    return el('div', { class: 'panel-footer' },
      mk('link', '建立/釋放剪裁遮色片', () => runCommand(this.app, 'layer.clip')),
      mk('fx', '圖層樣式', () => runCommand(this.app, 'layer.style')),
      mk('mask', '新增圖層遮色片', () => runCommand(this.app, 'layer.maskReveal')),
      adjustBtn,
      mk('folder', '群組圖層', () => runCommand(this.app, 'layer.group')),
      mk('plus', '新增圖層', () => runCommand(this.app, 'layer.new')),
      mk('copy', '複製圖層', () => runCommand(this.app, 'layer.duplicate')),
      mk('trash', '刪除圖層', () => runCommand(this.app, 'layer.delete')));
  }

  private buildRow(layer: Layer, doc: ReturnType<App['activeDoc']>): HTMLElement {
    if (!doc) return el('div');
    const active = doc.activeLayerId === layer.id;
    const row = el('div', {
      class: `layer-row${active ? ' active' : ''}`,
      draggable: 'true',
      title: `${layerKindLabel(layer)} · ${layer.name}`,
    });

    const vis = el('span', { class: 'vis', html: icon(layer.visible ? 'eye' : 'eyeOff', 15) });
    on(vis, 'click', (ev) => {
      ev.stopPropagation();
      layer.visible = !layer.visible;
      doc.commit(layer.visible ? '顯示圖層' : '隱藏圖層');
      this.app.changed();
    });

    const thumbs = el('div', { class: 'thumbs' });
    const pixels = el('canvas', { class: 'layer-thumb', width: THUMB, height: THUMB }) as HTMLCanvasElement;
    const pctx = pixels.getContext('2d')!;
    if (layer.surface) {
      pctx.drawImage(thumbFor(layer.surface, doc.width, doc.height), 0, 0);
    } else if (layer.kind === 'group') {
      const rendered = compositeLayers(layer.children ?? [], { width: doc.width, height: doc.height });
      pctx.drawImage(thumbFor(rendered, doc.width, doc.height), 0, 0);
    } else {
      pctx.fillStyle = '#555';
      pctx.fillRect(0, 0, THUMB, THUMB);
      pctx.fillStyle = '#ddd';
      pctx.font = '9px sans-serif';
      pctx.textAlign = 'center';
      pctx.fillText('調整', THUMB / 2, THUMB / 2 + 3);
    }
    on(pixels, 'click', (ev) => {
      ev.stopPropagation();
      doc.activeLayerId = layer.id;
      doc.editingMask = false;
      this.app.changed();
    });
    if (layer.kind === 'shape') {
      // Double-clicking a shape thumbnail is the quickest route to its style.
      on(pixels, 'dblclick', (ev) => {
        ev.stopPropagation();
        doc.activeLayerId = layer.id;
        runCommand(this.app, 'layer.shapeOptions');
      });
    }
    thumbs.append(pixels);

    if (layer.mask) {
      const maskCanvas = el('canvas', {
        class: `layer-thumb mask${active && doc.editingMask ? ' editing' : ''}`,
        width: THUMB, height: THUMB,
      }) as HTMLCanvasElement;
      maskCanvas.getContext('2d')!.drawImage(thumbFor(layer.mask, doc.width, doc.height), 0, 0);
      on(maskCanvas, 'click', (ev) => {
        ev.stopPropagation();
        doc.activeLayerId = layer.id;
        doc.editingMask = true;
        this.app.changed();
      });
      on(maskCanvas, 'dblclick', (ev) => {
        ev.stopPropagation();
        layer.maskEnabled = !layer.maskEnabled;
        doc.commit(layer.maskEnabled ? '啟用遮色片' : '停用遮色片');
        this.app.changed();
      });
      thumbs.append(maskCanvas);
    }

    const smartFilters = layer.smart?.filters.filter((f) => f.enabled).length ?? 0;
    const sub = el('div', { class: 'layer-sub' },
      el('span', { text: `${Math.round(layer.opacity * 100)}%` }),
      el('span', { text: BLEND_LABELS[layer.blend] }),
      layer.kind === 'smart' ? el('span', { class: 'badge', text: '智慧' }) : null,
      layer.kind === 'shape' ? el('span', { class: 'badge', text: '形狀' }) : null,
      layer.text?.onPath ? el('span', { class: 'badge', text: '沿路徑' }) : null,
      smartFilters ? el('span', { class: 'badge', text: `濾鏡 ${smartFilters}` }) : null,
      layer.clipped ? el('span', { class: 'clip-mark', text: '↳ 剪裁' }) : null,
      layer.locked ? el('span', { text: '🔒' }) : null);

    const name = el('div', { class: 'layer-name', text: layer.name });
    on(name, 'dblclick', async () => {
      const input = el('input', { type: 'text', value: layer.name }) as HTMLInputElement;
      if (await openModal({ title: '重新命名圖層', body: input }) === 'ok' && input.value.trim()) {
        layer.name = input.value.trim();
        doc.commit('重新命名圖層');
        this.app.changed();
      }
    });

    const meta = el('div', { class: 'layer-meta' }, name, sub);
    row.append(vis, thumbs, meta);

    on(row, 'click', () => {
      doc.activeLayerId = layer.id;
      doc.editingMask = false;
      this.app.changed();
    });
    on(row, 'contextmenu', (ev) => {
      ev.preventDefault();
      doc.activeLayerId = layer.id;
      this.app.changed();
      popupMenu(row, [
        cmdEntry('layer.duplicate'), cmdEntry('layer.delete'), cmdEntry('layer.rasterize'),
        { kind: 'sep' }, cmdEntry('layer.clip'), cmdEntry('layer.style'),
        cmdEntry('layer.shapeOptions'),
        { kind: 'sep' }, cmdEntry('smart.convert'), cmdEntry('smart.filters'), cmdEntry('smart.edit'),
        { kind: 'sep' }, cmdEntry('layer.mergeDown'),
      ], this.app, [
        {
          label: layer.locked ? '解除鎖定' : '鎖定圖層',
          run: () => { layer.locked = !layer.locked; doc.commit('鎖定狀態'); this.app.changed(); },
        },
        {
          label: '單獨顯示此圖層',
          run: () => {
            doc.soloLayerId = doc.soloLayerId === layer.id ? null : layer.id;
            doc.touch();
            this.app.changed();
          },
        },
      ]);
    });

    on(row, 'dragstart', (ev) => {
      this.dragId = layer.id;
      (ev as DragEvent).dataTransfer?.setData('text/plain', layer.id);
    });
    on(row, 'dragover', (ev) => { ev.preventDefault(); row.classList.add('dragover'); });
    on(row, 'dragleave', () => row.classList.remove('dragover'));
    on(row, 'drop', (ev) => {
      ev.preventDefault();
      row.classList.remove('dragover');
      if (!this.dragId || this.dragId === layer.id) return;
      const from = findParent(doc.layers, this.dragId);
      const to = findParent(doc.layers, layer.id);
      if (!from || !to || from.list !== to.list) { this.dragId = null; return; }
      const [moved] = from.list.splice(from.index, 1);
      const target = to.list.indexOf(layer);
      to.list.splice(target, 0, moved);
      this.dragId = null;
      doc.commit('重新排列圖層');
      this.app.changed();
    });

    return row;
  }

  refresh(): void {
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;

    let shown = 0;
    const render = (layers: Layer[], into: HTMLElement): void => {
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!this.matches(layer)) continue;
        shown++;
        into.append(this.buildRow(layer, doc));
        if (layer.kind === 'group' && layer.children?.length && layer.expanded !== false) {
          const kids = el('div', { class: 'layer-children' });
          render(layer.children, kids);
          into.append(kids);
        }
      }
    };
    render(doc.layers, this.list);
    if (this.filterActive() && shown === 0) {
      this.list.append(el('div', { class: 'hint', text: '沒有符合條件的圖層。' }));
    }

    const active = doc.activeLayer();
    if (active) {
      this.blendSelect.value = active.blend;
      this.opacityInput.value = String(Math.round(active.opacity * 100));
      const readout = this.opacityInput.parentElement?.querySelector('.val');
      if (readout) readout.textContent = `${Math.round(active.opacity * 100)}%`;
    }
  }
}
