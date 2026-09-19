import type { App } from '../../core/app';
import type { AlphaChannel, ChannelView } from '../../core/channels';
import { channelCoverage, extractChannel, CHANNEL_LABELS } from '../../core/channels';
import { createSurface, type Surface } from '../../core/surface';
import { clear, el, on, raf } from '../dom';
import { icon } from '../icons';
import { runCommand } from '../commands';
import { openModal, colorChip, sliderControl, formGrid } from '../modal';

const THUMB_W = 40;
const THUMB_H = 28;

function thumbCanvas(src: Surface, docW: number, docH: number): HTMLCanvasElement {
  const c = createSurface(THUMB_W, THUMB_H);
  const scale = Math.min(THUMB_W / docW, THUMB_H / docH);
  const w = Math.max(1, docW * scale);
  const h = Math.max(1, docH * scale);
  c.ctx.fillStyle = '#1a1a1a';
  c.ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  c.ctx.drawImage(src.canvas, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  return c.canvas;
}

export class ChannelsPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body' });
    this.root = el('div', { class: 'panel grow' },
      el('div', { class: 'panel-head' }, el('span', { text: '色版' })),
      this.list,
      this.footer());

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  private footer(): HTMLElement {
    const mk = (name: string, title: string, run: () => void): HTMLElement => {
      const b = el('button', { class: 'mini-btn', html: icon(name, 15), title });
      on(b, 'click', run);
      return b;
    };
    return el('div', { class: 'panel-footer' },
      mk('marquee', '將色版載入為選取範圍', () => this.loadActiveAsSelection()),
      mk('mask', '將選取範圍儲存為色版', () => runCommand(this.app, 'channel.saveSelection')),
      mk('plus', '新增色版', () => runCommand(this.app, 'channel.new')),
      mk('trash', '刪除色版', () => this.deleteActive()));
  }

  private activeAlpha(): AlphaChannel | null {
    const doc = this.app.activeDoc();
    if (!doc) return null;
    return doc.channels.find((c) => c.id === doc.channelView) ?? null;
  }

  private loadActiveAsSelection(): void {
    const doc = this.app.activeDoc();
    const ch = this.activeAlpha() ?? doc?.channels[doc.channels.length - 1];
    if (!doc || !ch) { this.app.toast('沒有可載入的色版', 'error'); return; }
    doc.selection.combine(channelCoverage(ch.surface), 'replace');
    doc.commit('載入色版選取範圍');
    this.app.changed();
  }

  private deleteActive(): void {
    const doc = this.app.activeDoc();
    const ch = this.activeAlpha();
    if (!doc || !ch) { this.app.toast('請先選擇一個 Alpha 色版', 'error'); return; }
    doc.channels = doc.channels.filter((c) => c.id !== ch.id);
    doc.channelView = 'rgb';
    doc.commit('刪除色版');
    this.app.changed();
  }

  private setView(view: ChannelView): void {
    const doc = this.app.activeDoc();
    if (!doc) return;
    doc.channelView = view;
    doc.touch();
    this.app.changed();
  }

  private colorRow(view: 'rgb' | 'r' | 'g' | 'b', composite: Surface, docW: number, docH: number): HTMLElement {
    const doc = this.app.activeDoc()!;
    const active = doc.channelView === view;
    const thumb = thumbCanvas(view === 'rgb' ? composite : extractChannel(composite, view), docW, docH);
    thumb.className = 'channel-thumb';
    const row = el('div', { class: `layer-row channel-row${active ? ' active' : ''}` },
      el('span', { class: 'vis', html: icon(active ? 'eye' : 'eyeOff', 14) }),
      el('div', { class: 'thumbs' }, thumb),
      el('div', { class: 'layer-meta' },
        el('div', { class: 'layer-name', text: CHANNEL_LABELS[view] }),
        el('div', { class: 'layer-sub' }, el('span', { text: view === 'rgb' ? 'Ctrl+2' : '色彩色版' }))));
    on(row, 'click', () => this.setView(view));
    return row;
  }

  private alphaRow(ch: AlphaChannel, docW: number, docH: number): HTMLElement {
    const doc = this.app.activeDoc()!;
    const active = doc.channelView === ch.id;
    const thumb = thumbCanvas(ch.surface, docW, docH);
    thumb.className = 'channel-thumb';
    const vis = el('span', { class: 'vis', html: icon(ch.visible ? 'eye' : 'eyeOff', 14) });
    on(vis, 'click', (ev) => {
      ev.stopPropagation();
      ch.visible = !ch.visible;
      doc.touch();
      this.app.changed();
    });

    const name = el('div', { class: 'layer-name', text: ch.name });
    on(name, 'dblclick', async (ev) => {
      ev.stopPropagation();
      const input = el('input', { type: 'text', value: ch.name }) as HTMLInputElement;
      const opacity = sliderControl(ch.opacity * 100, 0, 100, 1, (v) => { ch.opacity = v / 100; }, '%', 140);
      const body = formGrid([
        ['名稱', input],
        ['疊印顏色', colorChip(ch.color, (c) => { ch.color = c; })],
        ['不透明度', opacity],
      ]);
      if (await openModal({ title: '色版選項', body }) === 'ok') {
        if (input.value.trim()) ch.name = input.value.trim();
        doc.commit('色版選項');
        this.app.changed();
      }
    });

    const row = el('div', { class: `layer-row channel-row${active ? ' active' : ''}` },
      vis,
      el('div', { class: 'thumbs' }, thumb),
      el('div', { class: 'layer-meta' }, name,
        el('div', { class: 'layer-sub' }, el('span', { text: 'Alpha · Ctrl 點擊載入選取' }))));

    on(row, 'click', (ev) => {
      if ((ev as MouseEvent).ctrlKey || (ev as MouseEvent).metaKey) {
        doc.selection.combine(channelCoverage(ch.surface), 'replace');
        doc.commit('載入色版選取範圍');
        this.app.changed();
        return;
      }
      this.setView(ch.id);
    });
    return row;
  }

  refresh(): void {
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;
    // Colour-channel thumbnails come from the plain composite, not the view.
    const view = doc.channelView;
    doc.channelView = 'rgb';
    const composite = doc.composite();
    doc.channelView = view;

    for (const c of ['rgb', 'r', 'g', 'b'] as const) {
      this.list.append(this.colorRow(c, composite, doc.width, doc.height));
    }
    if (doc.channels.length) this.list.append(el('div', { class: 'menu-sep' }));
    for (let i = doc.channels.length - 1; i >= 0; i--) {
      this.list.append(this.alphaRow(doc.channels[i], doc.width, doc.height));
    }
  }
}
