import type { App } from '../../core/app';
import { anchorCount, toPath2D, type VectorPath } from '../../core/path';
import { createSurface } from '../../core/surface';
import { clear, el, on, raf } from '../dom';
import { icon } from '../icons';
import { runCommand } from '../commands';
import { openModal } from '../modal';

const THUMB_W = 40;
const THUMB_H = 28;

function pathThumb(path: VectorPath, docW: number, docH: number): HTMLCanvasElement {
  const c = createSurface(THUMB_W, THUMB_H);
  c.ctx.fillStyle = '#efefef';
  c.ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  const scale = Math.min(THUMB_W / docW, THUMB_H / docH);
  c.ctx.save();
  c.ctx.translate((THUMB_W - docW * scale) / 2, (THUMB_H - docH * scale) / 2);
  c.ctx.scale(scale, scale);
  c.ctx.strokeStyle = '#222';
  c.ctx.lineWidth = Math.max(1, 1 / scale);
  c.ctx.stroke(toPath2D(path));
  c.ctx.restore();
  return c.canvas;
}

export class PathsPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body' });
    this.root = el('div', { class: 'panel grow' },
      el('div', { class: 'panel-head' }, el('span', { text: '路徑' })),
      this.list,
      this.footer());

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  private footer(): HTMLElement {
    const mk = (name: string, title: string, id: string): HTMLElement => {
      const b = el('button', { class: 'mini-btn', html: icon(name, 15), title });
      on(b, 'click', () => runCommand(this.app, id));
      return b;
    };
    return el('div', { class: 'panel-footer' },
      mk('bucket', '以前景色填滿路徑', 'path.fill'),
      mk('brush', '以筆刷描邊路徑', 'path.stroke'),
      mk('marquee', '將路徑轉換為選取範圍', 'path.makeSelection'),
      mk('path', '從選取範圍建立工作路徑', 'path.fromSelection'),
      mk('plus', '新增路徑', 'path.new'),
      mk('trash', '刪除路徑', 'path.delete'));
  }

  refresh(): void {
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;
    if (!doc.paths.length) {
      this.list.append(el('div', {
        class: 'hint',
        text: '用筆型工具 (P) 繪製路徑，或從選取範圍建立工作路徑。',
      }));
      return;
    }

    for (let i = doc.paths.length - 1; i >= 0; i--) {
      const path = doc.paths[i];
      const active = doc.activePathId === path.id;
      const name = el('div', { class: 'layer-name', text: path.name });
      on(name, 'dblclick', async (ev) => {
        ev.stopPropagation();
        const input = el('input', { type: 'text', value: path.name }) as HTMLInputElement;
        if (await openModal({ title: '重新命名路徑', body: input }) === 'ok' && input.value.trim()) {
          path.name = input.value.trim();
          doc.commit('重新命名路徑');
          this.app.changed();
        }
      });
      const row = el('div', { class: `layer-row${active ? ' active' : ''}` },
        el('span', { class: 'vis', html: icon('path', 14) }),
        el('div', { class: 'thumbs' }, pathThumb(path, doc.width, doc.height)),
        el('div', { class: 'layer-meta' }, name,
          el('div', { class: 'layer-sub' },
            el('span', { text: `${path.subpaths.length} 個子路徑` }),
            el('span', { text: `${anchorCount(path)} 個控制點` }))));
      on(row, 'click', () => {
        doc.activePathId = path.id;
        doc.touch();
        this.app.changed();
      });
      this.list.append(row);
    }
  }
}
