import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Extensions the app knows how to open, without the leading dot. */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const PROJECT_EXT = 'pgraph';
const OPENABLE = [PROJECT_EXT, ...IMAGE_EXTS];

/** Vite's dev server, set by `npm run dev:desktop`. */
const DEV_URL = process.env.PHOTOGRAP_DEV_URL ?? '';

let mainWindow: BrowserWindow | null = null;
/** Set once the renderer has agreed the window may close. */
let closing = false;
/** Guards against a renderer that never answers the close request. */
let askTimer: NodeJS.Timeout | null = null;
/** Files named on the command line before the window is ready to hear about them. */
const pending: string[] = [];

const isOpenable = (p: string): boolean =>
  OPENABLE.includes(extname(p).slice(1).toLowerCase());

/** Files among these arguments, ignoring switches and the executable itself. */
function filesFromArgv(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && isOpenable(a) && existsSync(a));
}

// ---------------------------------------------------------------------------
// Window state, so the app opens where it was left.
// ---------------------------------------------------------------------------

interface WindowState { width: number; height: number; x?: number; y?: number; maximized: boolean }

const stateFile = (): string => join(app.getPath('userData'), 'window-state.json');

async function readState(): Promise<WindowState> {
  const fallback: WindowState = { width: 1440, height: 900, maximized: false };
  try {
    const raw = JSON.parse(await readFile(stateFile(), 'utf8')) as Partial<WindowState>;
    return {
      width: Math.max(800, Number(raw.width) || fallback.width),
      height: Math.max(600, Number(raw.height) || fallback.height),
      // A saved position off the edge of the current monitors would strand the
      // window, so it is only restored when it is a pair of real numbers.
      x: Number.isFinite(raw.x) ? raw.x : undefined,
      y: Number.isFinite(raw.y) ? raw.y : undefined,
      maximized: raw.maximized === true,
    };
  } catch {
    return fallback;
  }
}

async function writeState(win: BrowserWindow): Promise<void> {
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const state: WindowState = { ...bounds, maximized: win.isMaximized() };
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(stateFile(), JSON.stringify(state), 'utf8');
  } catch {
    // Losing the window position is not worth interrupting a quit for.
  }
}

// ---------------------------------------------------------------------------
// The window itself.
// ---------------------------------------------------------------------------

async function createWindow(): Promise<BrowserWindow> {
  const state = await readState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    show: false,
    title: 'Photograp',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // The in-page menu bar is the app's menu; a second native one would only
  // duplicate it. macOS always needs an application menu, so it keeps a
  // minimal one for the standard shortcuts.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Anything that wants a new window is a real link; hand it to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // In-page navigation away from the app would strand the user with no menu.
  win.webContents.on('will-navigate', (e, url) => {
    const here = DEV_URL || pathToFileURL(join(__dirname, '../dist/index.html')).href;
    if (!url.startsWith(here.split('#')[0])) {
      e.preventDefault();
      if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url);
    }
  });

  // Files that arrived while the page was still loading are handed over as
  // soon as it can listen.
  win.webContents.on('did-finish-load', () => {
    if (pending.length) win.webContents.send('photograp:open-pending');
  });

  // Closing has to go past the renderer first, because only it knows whether
  // there is unsaved work. The second close, after it says yes, goes through.
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    win.webContents.send('photograp:before-quit');
    // A renderer that never answers must not trap the window: after a short
    // wait the close goes ahead on its own.
    if (askTimer) clearTimeout(askTimer);
    askTimer = setTimeout(() => {
      closing = true;
      win.close();
    }, 2000);
  });

  let saving: NodeJS.Timeout | null = null;
  const remember = (): void => {
    if (saving) clearTimeout(saving);
    saving = setTimeout(() => { void writeState(win); }, 400);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', () => { void writeState(win); });
  win.on('closed', () => { mainWindow = null; });

  return win;
}

/** Tell the renderer to open a file the OS handed us. */
function deliver(path: string): void {
  if (!isOpenable(path) || !existsSync(path)) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('photograp:open-path', path);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pending.push(path);
  }
}

// ---------------------------------------------------------------------------
// IPC: the renderer asks, the main process touches the disk.
// ---------------------------------------------------------------------------

interface ReadResult { path: string; name: string; data: string }

/** A file as a data URL, which is what the renderer already knows how to decode. */
async function readAsDataUrl(path: string): Promise<ReadResult> {
  const buf = await readFile(path);
  const ext = extname(path).slice(1).toLowerCase();
  const mime = ext === 'pgraph'
    ? 'application/json'
    : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return { path, name: basename(path), data: `data:${mime};base64,${buf.toString('base64')}` };
}

function register(): void {
  ipcMain.handle('photograp:open', async (_e, opts: { multiple?: boolean; images?: boolean }) => {
    if (!mainWindow) return [];
    const filters = opts.images
      ? [{ name: '影像', extensions: IMAGE_EXTS }]
      : [
        { name: 'Photograp 專案與影像', extensions: OPENABLE },
        { name: 'Photograp 專案', extensions: [PROJECT_EXT] },
        { name: '影像', extensions: IMAGE_EXTS },
      ];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '開啟舊檔',
      filters,
      properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(readAsDataUrl));
  });

  ipcMain.handle('photograp:read', async (_e, path: string) => {
    if (!isOpenable(path) || !existsSync(path)) return null;
    return readAsDataUrl(path);
  });

  ipcMain.handle('photograp:save', async (
    _e, req: { data: string; name: string; ext: string; path?: string; base64?: boolean },
  ) => {
    if (!mainWindow) return null;
    let target = req.path;
    // A file opened from disk saves back over itself; anything else asks.
    if (!target || extname(target).slice(1).toLowerCase() !== req.ext.toLowerCase()) {
      const r = await dialog.showSaveDialog(mainWindow, {
        title: '儲存',
        defaultPath: req.name,
        filters: [{
          name: req.ext === PROJECT_EXT ? 'Photograp 專案' : req.ext.toUpperCase(),
          extensions: [req.ext],
        }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    await writeFile(target, req.base64 ? Buffer.from(req.data, 'base64') : req.data, req.base64 ? undefined : 'utf8');
    return { path: target, name: basename(target) };
  });

  ipcMain.handle('photograp:save-as', async (
    _e, req: { data: string; name: string; ext: string; base64?: boolean },
  ) => {
    if (!mainWindow) return null;
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '另存新檔',
      defaultPath: req.name,
      filters: [{
        name: req.ext === PROJECT_EXT ? 'Photograp 專案' : req.ext.toUpperCase(),
        extensions: [req.ext],
      }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, req.base64 ? Buffer.from(req.data, 'base64') : req.data, req.base64 ? undefined : 'utf8');
    return { path: r.filePath, name: basename(r.filePath) };
  });

  ipcMain.handle('photograp:pending', () => pending.splice(0, pending.length));

  ipcMain.handle('photograp:confirm-close', async (_e, message: string) => {
    if (!mainWindow) return true;
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', '仍要關閉'],
      defaultId: 0,
      cancelId: 0,
      title: '未儲存的變更',
      message,
    });
    return r.response === 1;
  });

  ipcMain.on('photograp:set-title', (_e, title: string) => {
    mainWindow?.setTitle(title ? `${title} — Photograp` : 'Photograp');
  });

  ipcMain.on('photograp:quit-decision', (_e, ok: boolean) => {
    if (askTimer) { clearTimeout(askTimer); askTimer = null; }
    if (!ok) return;
    closing = true;
    mainWindow?.close();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle. One instance owns the app so "open with" reuses the window.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    for (const f of filesFromArgv(argv)) deliver(f);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS hands files over through an event rather than argv.
  app.on('open-file', (e, path) => {
    e.preventDefault();
    deliver(path);
  });

  void app.whenReady().then(async () => {
    register();
    pending.push(...filesFromArgv(process.argv));
    mainWindow = await createWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
