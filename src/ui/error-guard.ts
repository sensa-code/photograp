import type { App } from '../core/app';

/** Repeats of the same message within this window are not shown again. */
export const REPORT_GAP_MS = 2000;

/** When each message was last shown, keyed by message. */
export type ReportLog = Map<string, number>;

/**
 * Whether a message should be shown now. A failing render loop or a handler
 * that throws on every pointer move would otherwise stack one toast per event;
 * different messages still show at once. Only shown messages are recorded, so
 * a steady stream of the same error still gets through once per window.
 */
export function shouldReport(message: string, now: number, log: ReportLog): boolean {
  const last = log.get(message);
  if (last !== undefined && now - last < REPORT_GAP_MS) return false;
  // Messages that embed changing numbers (coordinates, ids) would otherwise
  // each leave an entry behind; anything past the window has no further use.
  for (const [key, at] of log) if (now - at >= REPORT_GAP_MS) log.delete(key);
  log.set(message, now);
  return true;
}

/** First line of an error, short enough to read in a toast. */
function brief(err: unknown): string {
  const text = err instanceof Error ? err.message : err == null ? '' : String(err);
  const line = text.split('\n')[0].trim() || '未知錯誤';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * Show uncaught errors and unhandled rejections as toasts. Without this an
 * exception in an event handler only reaches the console, and the user sees a
 * tool that silently stopped responding. Install it once the UI is mounted:
 * toasts are events, and nothing displays them before AppUI subscribes.
 */
export function installErrorGuard(app: App): void {
  const log: ReportLog = new Map();
  const report = (err: unknown): void => {
    // The console gets the full object, stack included; the toast only gets
    // the first line. Every occurrence is logged, only the toast is debounced.
    console.error(err);
    const message = brief(err);
    if (shouldReport(message, Date.now(), log)) app.toast(`發生錯誤：${message}`, 'error');
  };
  window.addEventListener('error', (ev) => report(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => report(ev.reason));
}
