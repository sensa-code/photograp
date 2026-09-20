import type { App } from '../core/app';
import { pickedFromDesktop } from '../io/files';
import {
  desktopConfirmClose, desktopPending, desktopQuitDecision, desktopRead,
  desktopSetTitle, isDesktop, onDesktopBeforeQuit, onDesktopOpenPath,
  onDesktopPendingFiles,
} from '../io/desktop';
import { openPicked } from './commands';

/**
 * Everything that only makes sense in the packaged app: the window title, the
 * files the OS hands over, and the check before quitting. Returns immediately
 * in the browser build, which has no bridge at all.
 */
export function installDesktop(app: App): void {
  if (!isDesktop()) return;

  const syncTitle = (): void => {
    const doc = app.activeDoc();
    // The bullet is the usual "unsaved" marker in a native title bar.
    desktopSetTitle(doc ? `${doc.meta.name}${doc.isDirty ? ' •' : ''}` : '');
  };
  app.events.on('doc-changed', syncTitle);
  app.events.on('docs-changed', syncTitle);
  syncTitle();

  const openPath = async (path: string): Promise<void> => {
    const file = await desktopRead(path);
    if (!file) return;
    // An untouched blank document is a placeholder, not work: opening a real
    // file from the OS should replace it rather than pile up beside it.
    const blank = app.docs.length === 1 && !app.docs[0].isDirty && !app.docs[0].meta.filePath
      ? app.docs[0].meta.id
      : null;
    await openPicked(app, [pickedFromDesktop(file)], false);
    if (blank && app.docs.length > 1) app.closeDoc(blank);
    syncTitle();
  };

  onDesktopOpenPath((path) => { void openPath(path); });

  const drain = async (): Promise<void> => {
    for (const path of await desktopPending()) await openPath(path);
  };
  onDesktopPendingFiles(() => { void drain(); });
  void drain();

  onDesktopBeforeQuit(() => {
    void (async (): Promise<void> => {
      const dirty = app.docs.filter((d) => d.isDirty);
      if (!dirty.length) { desktopQuitDecision(true); return; }
      const names = dirty.map((d) => d.meta.name).join('、');
      const ok = await desktopConfirmClose(
        `${names} 有未儲存的變更，關閉後會遺失。`,
      );
      desktopQuitDecision(ok === true);
    })();
  });
}
