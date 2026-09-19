import type { App } from '../../core/app';
import type { HistorySnapshot } from '../../core/history';
import { clear, el, on, raf } from '../dom';
import { icon } from '../icons';
import { runCommand } from '../commands';
import { openModal } from '../modal';

export class HistoryPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = el('div', { class: 'panel-body', style: 'max-height:150px' });

    const snapshot = el('button', {
      class: 'mini-btn', html: icon('camera', 14), title: '以目前狀態建立快照',
    });
    on(snapshot, 'click', () => runCommand(this.app, 'history.snapshot'));
    const undo = el('button', { class: 'mini-btn', html: icon('undo', 14), title: '還原 (Ctrl+Z)' });
    on(undo, 'click', () => runCommand(this.app, 'edit.undo'));
    const redo = el('button', { class: 'mini-btn', html: icon('redo', 14), title: '重做 (Ctrl+Shift+Z)' });
    on(redo, 'click', () => runCommand(this.app, 'edit.redo'));

    this.root = el('div', { class: 'panel panel-history' },
      el('div', { class: 'panel-head' },
        el('span', { text: '步驟記錄' }),
        el('div', { class: 'tools' }, snapshot, undo, redo)),
      this.list);

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  /**
   * The box on the left of every row marks what the history brush paints
   * from, the way Photoshop's history panel does.
   */
  private sourceMark(snap: HistorySnapshot, isSource: boolean): HTMLElement {
    const box = el('span', {
      class: `history-source${isSource ? ' on' : ''}`,
      title: '設為步驟記錄筆刷的來源',
      html: isSource ? icon('brush', 11) : '',
    });
    on(box, 'click', (ev) => {
      ev.stopPropagation();
      const doc = this.app.activeDoc();
      if (!doc) return;
      doc.history.source = isSource ? null : snap;
      this.app.status(isSource
        ? '已取消步驟記錄來源'
        : `步驟記錄筆刷將從「${snap.label}」取樣`);
      this.app.changed();
    });
    return box;
  }

  refresh(): void {
    clear(this.list);
    const doc = this.app.activeDoc();
    if (!doc) return;
    const { snapshots, index, named, source } = doc.history;

    for (const entry of named) {
      const row = el('div', { class: 'history-row snapshot' },
        this.sourceMark(entry.snap, source === entry.snap),
        el('span', { class: 'idx', html: icon('camera', 11) }),
        el('span', { text: entry.name }));
      on(row, 'click', () => {
        if (doc.restoreNamed(entry.id)) this.app.changed();
      });
      const del = el('button', { class: 'mini-btn', html: icon('trash', 11), title: '刪除快照' });
      on(del, 'click', (ev) => {
        ev.stopPropagation();
        doc.history.removeNamed(entry.id);
        this.app.changed();
      });
      row.append(del);
      this.list.append(row);
    }
    if (named.length) this.list.append(el('div', { class: 'menu-sep' }));

    snapshots.forEach((snap, i) => {
      const row = el('div', {
        class: `history-row${i === index ? ' active' : ''}${i > index ? ' future' : ''}`,
      },
      this.sourceMark(snap, source === snap || (!source && i === 0)),
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

/** Ask for a snapshot name; returns null when the dialog is dismissed. */
export async function askSnapshotName(suggestion: string): Promise<string | null> {
  const input = el('input', { type: 'text', value: suggestion }) as HTMLInputElement;
  const ok = await openModal({ title: '建立快照', body: input, width: 320 });
  if (ok !== 'ok') return null;
  return input.value.trim() || suggestion;
}
