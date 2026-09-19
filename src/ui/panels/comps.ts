import type { App } from '../../core/app';
import { describeComp } from '../../core/comps';
import { clear, el, on, raf } from '../dom';
import { icon } from '../icons';
import { runCommand } from '../commands';

export class CompsPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body', style: 'max-height:150px' });

    const add = el('button', {
      class: 'mini-btn', html: icon('camera', 14), title: '依目前狀態建立圖層構成',
    });
    on(add, 'click', () => runCommand(this.app, 'comp.new'));

    this.root = el('div', { class: 'panel panel-comps collapsed' },
      el('div', { class: 'panel-head' },
        el('span', { text: '圖層構成' }),
        el('div', { class: 'tools' }, add)),
      this.list);

    // The panel starts collapsed and skips work while hidden, so it has to
    // catch up once the header is clicked open.
    on(this.root.querySelector('.panel-head')!, 'click', () => {
      setTimeout(() => this.refresh(), 0);
    });

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  refresh(): void {
    if (this.root.classList.contains('collapsed')) return;
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;

    if (!doc.comps.length) {
      this.list.append(el('div', {
        class: 'hint',
        text: '還沒有圖層構成。調好可見度與位置後，按上方的相機圖示存起來。',
      }));
      return;
    }

    for (const comp of doc.comps) {
      const row = el('div', { class: 'comp-row', title: comp.note || comp.name },
        el('div', { class: 'layer-meta' },
          el('div', { class: 'layer-name', text: comp.name }),
          el('div', { class: 'layer-sub' }, el('span', { text: describeComp(comp) }))));

      on(row, 'click', () => {
        doc.activeCompId = comp.id;
        runCommand(this.app, 'comp.apply');
      });

      const tools = el('div', { class: 'tools' });
      const mk = (name: string, title: string, run: () => void): void => {
        const b = el('button', { class: 'mini-btn', html: icon(name, 11), title });
        on(b, 'click', (ev) => { ev.stopPropagation(); run(); });
        tools.append(b);
      };
      mk('undo', '以目前狀態更新這個構成', () => {
        doc.activeCompId = comp.id;
        runCommand(this.app, 'comp.update');
      });
      mk('trash', '刪除這個構成', () => {
        doc.activeCompId = comp.id;
        runCommand(this.app, 'comp.delete');
      });
      row.append(tools);
      this.list.append(row);
    }
  }
}
