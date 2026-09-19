import type { App } from '../../core/app';
import { clear, el, on } from '../dom';
import { icon } from '../icons';
import { runCommand } from '../commands';

export class HistoryPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body', style: 'max-height:132px' });

    const undo = el('button', { class: 'mini-btn', html: icon('undo', 14), title: '還原 (Ctrl+Z)' });
    on(undo, 'click', () => runCommand(this.app, 'edit.undo'));
    const redo = el('button', { class: 'mini-btn', html: icon('redo', 14), title: '重做 (Ctrl+Shift+Z)' });
    on(redo, 'click', () => runCommand(this.app, 'edit.redo'));

    this.root = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { text: '步驟記錄' }),
        el('div', { class: 'tools' }, undo, redo)),
      this.list);

    app.events.on('doc-changed', () => this.refresh());
    app.events.on('docs-changed', () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;
    const { snapshots, index } = doc.history;
    snapshots.forEach((snap, i) => {
      const row = el('div', {
        class: `history-row${i === index ? ' active' : ''}${i > index ? ' future' : ''}`,
      },
      el('span', { class: 'idx', text: String(i + 1) }),
      el('span', { text: snap.label }));
      on(row, 'click', () => {
        if (doc.gotoHistory(i)) this.app.changed();
      });
      this.list.append(row);
    });
    this.list.scrollTop = this.list.scrollHeight;
  }
}
