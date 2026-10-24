/**
 * The desktop bridge. In the Electron build `window.photograp` is injected by
 * the preload script; in the browser it is simply absent, and every call here
 * reports that so callers can fall back to the web path. Nothing else in the
 * app is allowed to reach for `window.photograp` directly.
 */

export interface DesktopFile { path: string; name: string; data: string }
export interface SavedFile { path: string; name: string }
/** Mirrors UpdateCheck in electron/updater.cts. */
export interface UpdateCheck {
  status: 'available' | 'none' | 'downloaded' | 'error' | 'unsupported';
  version?: string;
  message?: string;
}

interface Bridge {
  desktop: true;
  platform: string;
  open(opts?: { multiple?: boolean; images?: boolean }): Promise<DesktopFile[]>;
  read(path: string): Promise<DesktopFile | null>;
  save(req: {
    data: string; name: string; ext: string; path?: string; base64?: boolean;
  }): Promise<SavedFile | null>;
  saveAs(req: {
    data: string; name: string; ext: string; base64?: boolean;
  }): Promise<SavedFile | null>;
  pending(): Promise<string[]>;
  confirmClose(message: string): Promise<boolean>;
  setTitle(title: string): void;
  onOpenPath(fn: (path: string) => void): void;
  onPendingFiles(fn: () => void): void;
  onBeforeQuit(fn: () => void): void;
  quitDecision(ok: boolean): void;
  checkForUpdates(): Promise<UpdateCheck>;
}

const bridge = (): Bridge | null =>
  (globalThis as { photograp?: Bridge }).photograp ?? null;

/** True only in the packaged app. */
export const isDesktop = (): boolean => bridge() !== null;

export const desktopPlatform = (): string => bridge()?.platform ?? 'web';

/** Native open dialog; null means "not the desktop build, use the web path". */
export async function desktopOpen(
  opts: { multiple?: boolean; images?: boolean } = {},
): Promise<DesktopFile[] | null> {
  const b = bridge();
  return b ? b.open(opts) : null;
}

export async function desktopRead(path: string): Promise<DesktopFile | null> {
  return bridge()?.read(path) ?? null;
}

/**
 * Write text to disk. With `path` it overwrites that file silently, which is
 * what Ctrl+S on an already-saved document should do; without one it asks.
 */
export async function desktopSaveText(
  data: string, name: string, ext: string, path?: string,
): Promise<SavedFile | null> {
  const b = bridge();
  return b ? b.save({ data, name, ext, path }) : null;
}

export async function desktopSaveBinary(
  blob: Blob, name: string, ext: string,
): Promise<SavedFile | null> {
  const b = bridge();
  if (!b) return null;
  return b.saveAs({ data: await blobToBase64(blob), name, ext, base64: true });
}

export async function desktopSaveTextAs(
  data: string, name: string, ext: string,
): Promise<SavedFile | null> {
  const b = bridge();
  return b ? b.saveAs({ data, name, ext }) : null;
}

/** Files the OS handed over before the page was listening. */
export async function desktopPending(): Promise<string[]> {
  return bridge()?.pending() ?? [];
}

export function onDesktopOpenPath(fn: (path: string) => void): void {
  bridge()?.onOpenPath(fn);
}

export function onDesktopPendingFiles(fn: () => void): void {
  bridge()?.onPendingFiles(fn);
}

export function onDesktopBeforeQuit(fn: () => void): void {
  bridge()?.onBeforeQuit(fn);
}

/** Answer the window's close request: true lets it go. */
export function desktopQuitDecision(ok: boolean): void {
  bridge()?.quitDecision(ok);
}

/** Native confirmation, falling back to the caller's own when on the web. */
export async function desktopConfirmClose(message: string): Promise<boolean | null> {
  const b = bridge();
  return b ? b.confirmClose(message) : null;
}

export function desktopSetTitle(title: string): void {
  bridge()?.setTitle(title);
}

/** Manual update check; null in the browser, which is always the latest build. */
export async function desktopCheckForUpdates(): Promise<UpdateCheck | null> {
  const b = bridge();
  return b ? b.checkForUpdates() : null;
}

/** A data URL back into a Blob, for files read through the bridge. */
export async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

/** A data URL's payload as text, without a round trip through Blob. */
export function dataUrlToText(url: string): string {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (!head.includes(';base64')) return decodeURIComponent(body);
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('無法讀取要儲存的資料'));
    reader.readAsDataURL(blob);
  });
}
