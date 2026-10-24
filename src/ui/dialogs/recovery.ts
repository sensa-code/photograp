import type { App } from '../../core/app';
import {
  deleteAutosaveIfUnchanged, listAutosaves, recoveredName, writeAutosave, type AutosaveEntry,
} from '../../core/autosave';
import { loadProject } from '../../io/files';
import { el, on } from '../dom';
import { confirmDialog, openModal } from '../modal';

const formatBytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false });
};

const ROW_STYLE = 'display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;'
  + 'padding:6px 10px;border:1px solid var(--line-soft);border-radius:var(--radius);background:var(--bg-sunken)';

/**
 * On launch, offer whatever autosave left behind. Each row restores or
 * discards one copy; the dialog stays up until every copy is dealt with or the
 * user closes it, in which case the copies wait for the next launch.
 */
export async function offerRecovery(app: App): Promise<void> {
  const entries = await listAutosaves();
  if (!entries.length) return;

  const rows = new Map<string, HTMLElement>();
  const buttons: HTMLButtonElement[] = [];
  let busy = false;
  const list = el('div', { style: 'display:grid;gap:6px;max-height:50vh;overflow:auto' });
  const clearAll = el('button', { class: 'btn', text: '全部刪除' }) as HTMLButtonElement;
  buttons.push(clearAll);
  const body = el('div', { style: 'display:grid;gap:10px' },
    el('div', {
      class: 'hint',
      text: '找到自動儲存的未儲存文件。復原後會以新文件開啟，請記得另存；沒有處理的會留到下次啟動再列出。',
    }),
    list,
    el('div', { style: 'display:flex;justify-content:flex-end' }, clearAll),
  );

  // openModal only closes from its own buttons, so an emptied list presses the
  // footer button on the user's behalf.
  const closeDialog = (): void =>
    body.closest('.modal')?.querySelector<HTMLButtonElement>('.modal-foot .btn')?.click();
  const drop = (id: string): void => {
    rows.get(id)?.remove();
    rows.delete(id);
    if (!rows.size) closeDialog();
  };

  /** One operation at a time: a second click while loading would open the document twice. */
  const guard = (fn: () => Promise<void>) => async (): Promise<void> => {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    try {
      await fn();
    } finally {
      busy = false;
      for (const b of buttons) b.disabled = false;
    }
  };

  const recover = async (entry: AutosaveEntry): Promise<void> => {
    const doc = await loadProject(entry.json).catch((err: unknown) => {
      // The copy stays: the failure may be this build's, not the data's.
      app.toast(`無法復原「${entry.name}」：${err instanceof Error ? err.message : String(err)}`, 'error');
      return null;
    });
    if (!doc) return;
    doc.meta.name = recoveredName(entry.name);
    // Recovered work is unsaved work; this also arms the close warning.
    doc.touch();
    // Hand the copy to the new document before dropping the old record, so
    // there is no moment without one. The old id is not reused: another tab
    // may still be writing under it, and a copy it refreshed since the list
    // was read is left alone.
    const handed = await writeAutosave({ ...entry, id: doc.meta.id, name: doc.meta.name, revision: doc.revision });
    if (handed) await deleteAutosaveIfUnchanged(entry.id, entry.savedAt);
    // An untouched blank document is a placeholder, not work (see installDesktop).
    const blank = app.docs.length === 1 && !app.docs[0].isDirty && !app.docs[0].meta.filePath
      ? app.docs[0].meta.id
      : null;
    app.addDoc(doc);
    if (blank) app.closeDoc(blank);
    app.toast(`已復原「${doc.meta.name}」`, 'success');
    drop(entry.id);
  };

  // Deleting is conditional on the copy being the one shown: a record another
  // tab refreshed meanwhile is a live document's backup and simply stays.
  const discard = async (entry: AutosaveEntry): Promise<void> => {
    if (!await deleteAutosaveIfUnchanged(entry.id, entry.savedAt)) {
      app.toast('無法刪除自動儲存的紀錄', 'error');
      return;
    }
    drop(entry.id);
  };

  for (const entry of entries) {
    const restore = el('button', { class: 'btn primary', text: '復原' }) as HTMLButtonElement;
    const remove = el('button', { class: 'btn ghost', text: '刪除' }) as HTMLButtonElement;
    buttons.push(restore, remove);
    on(restore, 'click', guard(async () => {
      restore.textContent = '復原中…';
      try { await recover(entry); } finally { restore.textContent = '復原'; }
    }));
    on(remove, 'click', guard(() => discard(entry)));
    const details = `${formatTime(entry.savedAt)} · ${entry.width} × ${entry.height} px`
      + ` · ${entry.layers} 個圖層 · ${formatBytes(entry.bytes)}`;
    const row = el('div', { style: ROW_STYLE },
      el('div', {},
        el('div', { text: entry.name || '未命名', style: 'font-weight:600' }),
        el('div', { class: 'hint', text: details })),
      restore, remove);
    rows.set(entry.id, row);
    list.append(row);
  }

  on(clearAll, 'click', guard(async () => {
    const sure = await confirmDialog('全部刪除', `要刪除 ${rows.size} 份自動儲存的文件嗎？沒有復原的內容會遺失。`);
    if (!sure) return;
    // Only the copies still listed: recovered ones now belong to their
    // documents, and another tab may have written new ones since the list was read.
    for (const entry of entries) {
      if (!rows.has(entry.id)) continue;
      if (!await deleteAutosaveIfUnchanged(entry.id, entry.savedAt)) {
        app.toast('無法刪除自動儲存的紀錄', 'error');
        return;
      }
      drop(entry.id);
    }
  }));

  await openModal({
    title: '復原未儲存的文件',
    body,
    width: 560,
    buttons: [{ label: '關閉', value: 'close', primary: true }],
  });
}
