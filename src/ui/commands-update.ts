import type { App } from '../core/app';
import { desktopCheckForUpdates, isDesktop, type UpdateCheck } from '../io/desktop';
import { cmd } from './command-types';

/**
 * 說明 › 檢查更新…, in a file of its own so commands.ts stops growing. The
 * main process does the checking, downloading and the restart prompt; this
 * only reports the outcome.
 */

let checking = false;

function report(app: App, r: UpdateCheck | null): void {
  if (!r) { app.toast('網頁版每次開啟都是最新版本，不需要更新'); return; }
  switch (r.status) {
    case 'none':
      app.toast(`已經是最新版本（${r.version ?? ''}）`, 'success');
      return;
    case 'available':
      app.toast(`發現新版本 ${r.version ?? ''}，正在背景下載，完成後會詢問是否重新啟動`);
      return;
    case 'downloaded':
      app.toast(`新版本 ${r.version ?? ''} 已下載完成`);
      return;
    case 'unsupported':
      app.toast(r.message ?? '這個版本無法自動更新');
      return;
    case 'error':
      // The main process already wrote a full sentence (electron/update-errors.cts).
      app.toast(r.message ?? '檢查更新失敗，請稍後再試。', 'error');
  }
}

export const checkUpdatesCommand = cmd('help.checkUpdates', '檢查更新…', async (app) => {
  // A check against GitHub can take a few seconds; a second click would only
  // queue a duplicate request.
  if (checking) return;
  checking = true;
  app.toast('正在檢查更新…');
  try {
    report(app, await desktopCheckForUpdates());
  } catch {
    // The IPC call itself failed; its raw error means nothing to the user.
    app.toast('檢查更新失敗，請稍後再試。', 'error');
  } finally {
    checking = false;
  }
}, { enabled: () => isDesktop() && !checking });
