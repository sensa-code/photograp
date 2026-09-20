import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole surface the renderer is given. Nothing here takes a path from the
 * page except `read`, which the main process checks against the extensions the
 * app can open — the page never gets to touch the file system directly.
 */
const api = {
  /** Marks the desktop build; the web build simply has no bridge at all. */
  desktop: true,
  platform: process.platform,

  open: (opts: { multiple?: boolean; images?: boolean } = {}):
  Promise<{ path: string; name: string; data: string }[]> =>
    ipcRenderer.invoke('photograp:open', opts),

  read: (path: string): Promise<{ path: string; name: string; data: string } | null> =>
    ipcRenderer.invoke('photograp:read', path),

  save: (req: { data: string; name: string; ext: string; path?: string; base64?: boolean }):
  Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('photograp:save', req),

  saveAs: (req: { data: string; name: string; ext: string; base64?: boolean }):
  Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('photograp:save-as', req),

  /** Files the OS handed over before the page was listening. */
  pending: (): Promise<string[]> => ipcRenderer.invoke('photograp:pending'),

  confirmClose: (message: string): Promise<boolean> =>
    ipcRenderer.invoke('photograp:confirm-close', message),

  setTitle: (title: string): void => { ipcRenderer.send('photograp:set-title', title); },

  /** Files opened while the app is already running ("open with", second launch). */
  onOpenPath: (fn: (path: string) => void): void => {
    ipcRenderer.on('photograp:open-path', (_e, path: string) => fn(path));
  },

  /** Files were handed over before the page could listen. */
  onPendingFiles: (fn: () => void): void => {
    ipcRenderer.on('photograp:open-pending', () => fn());
  },

  /** The window is trying to close; answer with `quitDecision`. */
  onBeforeQuit: (fn: () => void): void => {
    ipcRenderer.on('photograp:before-quit', () => fn());
  },
  quitDecision: (ok: boolean): void => { ipcRenderer.send('photograp:quit-decision', ok); },
};

contextBridge.exposeInMainWorld('photograp', api);
