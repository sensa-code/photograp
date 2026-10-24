import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { classifyUpdateError, describeUpdateError, RELEASES_URL } from './update-errors.cjs';

/**
 * Automatic updates from GitHub Releases (the `build.publish` entry in
 * package.json, which electron-builder bakes into resources/app-update.yml).
 *
 * The rules, and why:
 * - Only the installed (NSIS) build updates itself. The portable exe has no
 *   installer to run, and a dev run has no app-update.yml.
 * - Updates download on their own but are never installed behind the user's
 *   back (`autoInstallOnAppQuit = false`): the installer replaces the whole app
 *   and the user decides when that happens.
 * - "Restart now" goes through the same close confirmation as the window's X
 *   button, because `quitAndInstall` launches the installer *before* quitting;
 *   asking afterwards would leave the installer waiting on a window that the
 *   user decided to keep. Cancelling there keeps the window and the download;
 *   the next launch finds the cached download and asks again.
 * - Background failures (offline, GitHub rate limit, a release without
 *   latest.yml) are normal and only logged. A manual check reports them as a
 *   short sentence (update-errors.cts); the raw error stays in the log.
 */

const FIRST_CHECK_DELAY_MS = 10_000;
const LOG_LIMIT_BYTES = 1024 * 1024;

/**
 * Test hook only: when set to an http(s) URL, updates come from that generic
 * feed (a folder holding latest.yml and the Setup exe) instead of GitHub. It
 * exists so the download-and-verify path can be exercised against a local
 * server without publishing a release. Unset in every normal launch, and it
 * changes nothing unless it is explicitly set.
 */
const TEST_FEED_URL = process.env.PHOTOGRAP_UPDATE_URL ?? '';

export type UpdateStatus = 'available' | 'none' | 'downloaded' | 'error' | 'unsupported';
export interface UpdateCheck { status: UpdateStatus; version?: string; message?: string }

let getWindow: () => BrowserWindow | null = () => null;
/** Version of an update that is downloaded and ready to install. */
let downloadedVersion: string | null = null;
/** The user chose "restart now"; the next approved close installs. */
let installRequested = false;
let prompting = false;
/** A manual check is already waiting on the current download to report its failure. */
let watchingDownload = false;
let lastLoggedPercent = -1;
/** Log writes run one after another so the file keeps the events in order. */
let logQueue: Promise<void> = Promise.resolve();

const isPortable = (): boolean => Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

/** Why updates are off in this run, or null when they are on. */
function unsupportedReason(): string | null {
  if (isPortable()) return `免安裝版不支援自動更新，新版請到 ${RELEASES_URL} 下載。`;
  if (!app.isPackaged) return `開發模式不會自動更新，新版請到 ${RELEASES_URL} 下載。`;
  return null;
}

// ---------------------------------------------------------------------------
// Log: userData/logs/updater.log, since a packaged app has no console to read.
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: unknown): void {
  const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
  const line = `${new Date().toISOString()} [updater] ${level} ${text}\n`;
  process.stdout.write(line);
  logQueue = logQueue.then(async (): Promise<void> => {
    try {
      const dir = app.getPath('logs');
      const file = join(dir, 'updater.log');
      await mkdir(dir, { recursive: true });
      // One rotation is enough to keep a years-old install from growing it forever.
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size > LOG_LIMIT_BYTES) await rename(file, `${file}.old`);
      await appendFile(file, line, 'utf8');
    } catch {
      // A log that cannot be written is not worth bothering the user about.
    }
  });
}

// ---------------------------------------------------------------------------
// Asking the user.
// ---------------------------------------------------------------------------

async function promptRestart(version: string): Promise<void> {
  if (prompting) return;
  prompting = true;
  try {
    const options = {
      type: 'info' as const,
      buttons: ['稍後', '立即重新啟動'],
      defaultId: 1,
      cancelId: 0,
      title: '有新版本',
      message: `Photograp ${version} 已下載完成，重新啟動後安裝。`,
    };
    const win = getWindow();
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (r.response !== 1) {
      log('info', `user postponed ${version}; it stays downloaded and is offered again next launch`);
      return;
    }
    log('info', `user chose to restart into ${version}`);
    installRequested = true;
    // Closing asks the renderer about unsaved work first; main.cts calls
    // installUpdateNow() once that is approved, or forgetInstallRequest().
    if (win) win.close();
    else installUpdateNow();
  } finally {
    prompting = false;
  }
}

/** True while a "restart now" is waiting for the window to be allowed to close. */
export const updateInstallRequested = (): boolean => installRequested;

/** The close was cancelled: keep the download, do not install on a later quit. */
export function forgetInstallRequest(): void {
  if (installRequested) log('info', 'restart cancelled at the unsaved-work prompt; update kept for later');
  installRequested = false;
}

/**
 * Runs the installer and quits. Returns false when the installer could not be
 * started, in which case the app keeps running and the user is told.
 */
export function installUpdateNow(): boolean {
  installRequested = false;
  const failures: Error[] = [];
  const onError = (e: Error): void => { failures.push(e); };
  // install() reports a missing or broken download synchronously through the
  // error event, before quitAndInstall returns.
  autoUpdater.once('error', onError);
  // Silent, then relaunch: the assisted installer's wizard would otherwise
  // reappear on every update; a silent run keeps the existing install folder.
  autoUpdater.quitAndInstall(true, true);
  autoUpdater.removeListener('error', onError);
  if (!failures.length) return true;
  const reason = failures[0].message;
  log('error', `installer did not start: ${reason}`);
  dialog.showErrorBox('無法安裝更新', `更新程式沒有啟動：${reason}\n請到 ${RELEASES_URL} 下載安裝檔。`);
  return false;
}

// ---------------------------------------------------------------------------
// Checking.
// ---------------------------------------------------------------------------

function reportDownloadFailure(e: unknown): void {
  // The raw error is already in the log through the error event.
  log('warn', `download failed; shown to the user as ${classifyUpdateError(e)}`);
  const options = {
    type: 'error' as const,
    title: '更新下載失敗',
    message: describeUpdateError(e, 'download'),
  };
  const win = getWindow();
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
}

async function check(manual: boolean): Promise<UpdateCheck> {
  const reason = unsupportedReason();
  if (reason) return { status: 'unsupported', message: reason };
  if (downloadedVersion) {
    if (manual) void promptRestart(downloadedVersion);
    return { status: 'downloaded', version: downloadedVersion };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return { status: 'unsupported', message: `這個版本無法自動更新，新版請到 ${RELEASES_URL} 下載。` };
    // A failed download is logged by the error event. After a background
    // check that is all; after a manual one the user was told "downloading",
    // so they are told it stopped, too. Repeated checks share one download,
    // so only the first one waits on it: one failure, one dialog.
    if (manual && !watchingDownload && result.downloadPromise) {
      watchingDownload = true;
      result.downloadPromise.then(() => { watchingDownload = false; }, (e: unknown) => {
        watchingDownload = false;
        reportDownloadFailure(e);
      });
    } else {
      result.downloadPromise?.catch(() => undefined);
    }
    return result.isUpdateAvailable
      ? { status: 'available', version: result.updateInfo.version }
      : { status: 'none', version: app.getVersion() };
  } catch (e) {
    // The raw error is already logged by the error event; only a manual check
    // shows it, and only as a short sentence.
    if (manual) log('warn', `manual check failed; shown to the user as ${classifyUpdateError(e)}`);
    return { status: 'error', message: describeUpdateError(e) };
  }
}

/** Wires up events, the manual-check IPC and the first background check. */
export function setupUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  ipcMain.handle('photograp:check-update', () => check(true));

  const reason = unsupportedReason();
  if (reason) {
    log('info', `disabled: ${reason}`);
    return;
  }

  autoUpdater.logger = {
    info: (m?: unknown) => log('info', m),
    warn: (m?: unknown) => log('warn', m),
    error: (m?: unknown) => log('error', m),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // Releases carry the full Setup exe, never the web installer's split packages.
  autoUpdater.disableWebInstaller = true;
  if (/^https?:\/\//.test(TEST_FEED_URL)) {
    log('warn', `PHOTOGRAP_UPDATE_URL is set; using the test feed ${TEST_FEED_URL}`);
    autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED_URL });
  }

  autoUpdater.on('checking-for-update', () => log('info', 'event checking-for-update'));
  autoUpdater.on('update-available', (info: UpdateInfo) => log('info', `event update-available ${info.version}`));
  autoUpdater.on('update-not-available', (info: UpdateInfo) => log('info', `event update-not-available (latest ${info.version})`));
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    // Every 10 % is plenty for a log; the event itself fires many times a second.
    const step = Math.floor(p.percent / 10) * 10;
    if (step === lastLoggedPercent) return;
    lastLoggedPercent = step;
    log('info', `event download-progress ${p.percent.toFixed(1)}% (${p.transferred}/${p.total} bytes)`);
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log('info', `event update-downloaded ${info.version}`);
    downloadedVersion = info.version;
    void promptRestart(info.version);
  });
  autoUpdater.on('error', (e: Error) => log('error', `event error ${e.message}`));

  setTimeout(() => { void check(false); }, FIRST_CHECK_DELAY_MS);
}
