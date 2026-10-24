/**
 * Autosave: a crash copy of every unsaved document, written to IndexedDB a while
 * after the last edit and offered back on the next launch (ui/dialogs/recovery.ts).
 * Scheduling is pure functions over a timing record and a caller-supplied clock, so
 * the tests need no timers. The serialiser is injected: core never imports io, and
 * io/files.ts imports deleteAutosave from here, so importing back would be a cycle.
 */
import type { App } from './app';
import type { PhotoDoc } from './document';

// ---- scheduling (pure) -----------------------------------------------------

/** Quiet time after the last edit before a copy is written. */
export const DEBOUNCE_MS = 30_000;
/** Longest an edited document goes without a copy, however busy the user is. */
export const MAX_WAIT_MS = 120_000;
/** A serialisation slower than this doubles both waits: it stalls the UI. */
export const SLOW_SERIALIZE_MS = 1500;
export const MAX_RETRIES = 3; // failed writes retried per burst of edits, then wait for the next edit
export const SLOW_NOTICE = '文件較大，自動儲存已放慢';
export const RECOVERED_SUFFIX = '（已復原）';

export interface AutosaveTiming {
  /** Revision the scheduler last saw; a different one on the document is an edit. */
  revision: number;
  /** First and latest edit since the last write; null while nothing is pending. */
  firstChangeAt: number | null;
  lastChangeAt: number | null;
  /** How long the last serialisation took, which decides the slow backoff. */
  lastDurationMs: number;
}

export type AutosavePlan = { action: 'idle' } | { action: 'wait'; until: number } | { action: 'save' };

export const freshTiming = (revision: number): AutosaveTiming =>
  ({ revision, firstChangeAt: null, lastChangeAt: null, lastDurationMs: 0 });

/** An edit (a new revision) was seen at `now`; the first one opens the window. */
export function markChanged(t: AutosaveTiming, revision: number, now: number): AutosaveTiming {
  return { ...t, revision, firstChangeAt: t.firstChangeAt ?? now, lastChangeAt: now };
}

/** The document is clean (saved, or just opened): nothing pending, backoff kept. */
export function markClean(t: AutosaveTiming, revision: number): AutosaveTiming {
  return { ...freshTiming(revision), lastDurationMs: t.lastDurationMs };
}

/**
 * A copy of `revision` was written in `durationMs`. Edits that landed during
 * the write open a new window from now instead of hiding behind a saved revision.
 */
export function markWritten(t: AutosaveTiming, revision: number, durationMs: number, now: number): AutosaveTiming {
  const at = t.revision !== revision ? now : null;
  return { revision: t.revision, firstChangeAt: at, lastChangeAt: at, lastDurationMs: durationMs };
}

/** A write failed: a fresh window from now, so the retry waits a quiet period instead of looping. */
export function markFailed(t: AutosaveTiming, now: number): AutosaveTiming {
  return { ...t, firstChangeAt: now, lastChangeAt: now };
}

export const isSlow = (durationMs: number): boolean => durationMs > SLOW_SERIALIZE_MS;

/** The slow notice is shown once per session, not once per slow write. */
export const slowNoticeDue = (durationMs: number, alreadyShown: boolean): boolean => isSlow(durationMs) && !alreadyShown;

/**
 * When to write next. The debounce keeps the copy out of a burst of edits; the cap
 * from the first edit makes sure a long session still gets one; clean needs none.
 */
export function planAutosave(t: AutosaveTiming, dirty: boolean, now: number): AutosavePlan {
  if (!dirty || t.firstChangeAt === null || t.lastChangeAt === null) return { action: 'idle' };
  const factor = isSlow(t.lastDurationMs) ? 2 : 1;
  const due = Math.min(t.lastChangeAt + DEBOUNCE_MS * factor, t.firstChangeAt + MAX_WAIT_MS * factor);
  return now >= due ? { action: 'save' } : { action: 'wait', until: due };
}

/** "貓.pgraph" → "貓（已復原）.pgraph"; a name recovered twice keeps one suffix. */
export function recoveredName(name: string): string {
  const base = name.trim() || '未命名';
  if (base.includes(RECOVERED_SUFFIX)) return base;
  const ext = /\.pgraph$/i.exec(base);
  return ext ? `${base.slice(0, ext.index)}${RECOVERED_SUFFIX}${ext[0]}` : `${base}${RECOVERED_SUFFIX}`;
}

// ---- IndexedDB store -------------------------------------------------------

export const AUTOSAVE_DB = 'photograp';
const STORE = 'autosave';
const DB_VERSION = 1;

/** One record per document id; `savedAt` is ISO, `json` the project file as serializeDocument makes it. */
export interface AutosaveEntry {
  id: string;
  name: string;
  savedAt: string;
  revision: number;
  width: number;
  height: number;
  layers: number;
  /** Length of `json`; base64 dominates it, so this is close to the byte size. */
  bytes: number;
  json: string;
}

/** Cleared once IndexedDB turns out to be missing or refused (private windows, blocked storage). */
let available = true;
export const autosaveAvailable = (): boolean => available;

function openDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB 不存在');
      req = indexedDB.open(name, DB_VERSION);
    } catch { available = false; resolve(null); return; }
    // Version 1 only ever upgrades from nothing, so the store cannot exist yet.
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => { available = true; resolve(req.result); };
    req.onerror = () => { available = false; resolve(null); };
    req.onblocked = () => resolve(null);
  });
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

/**
 * One request in a transaction of its own, settled when the transaction is. Every
 * failure, a full quota included, is a quiet `ok: false`: a safety net must not throw.
 */
function run<T>(name: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<Outcome<T>> {
  return openDb(name).then((db) => new Promise<Outcome<T>>((resolve) => {
    if (!db) { resolve({ ok: false }); return; }
    let value: T | undefined;
    const fail = (): void => { db.close(); resolve({ ok: false }); };
    try {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => { db.close(); resolve({ ok: true, value: value as T }); };
      tx.onerror = tx.onabort = fail;
    } catch {
      fail();
    }
  }));
}

const isEntry = (v: unknown): v is AutosaveEntry => typeof v === 'object' && v !== null
  && typeof (v as AutosaveEntry).id === 'string' && typeof (v as AutosaveEntry).json === 'string';

/** Stores or replaces the record for `entry.id`. */
export async function writeAutosave(entry: AutosaveEntry, name = AUTOSAVE_DB): Promise<boolean> {
  return (await run(name, 'readwrite', (s) => s.put(entry))).ok;
}

/** Every record, newest first; an empty list when the store is unusable. */
export async function listAutosaves(name = AUTOSAVE_DB): Promise<AutosaveEntry[]> {
  const out = await run(name, 'readonly', (s) => s.getAll());
  if (!out.ok) return [];
  return (out.value as unknown[]).filter(isEntry)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

export async function deleteAutosave(id: string, name = AUTOSAVE_DB): Promise<boolean> {
  return (await run(name, 'readwrite', (s) => s.delete(id))).ok;
}

/** Removes the record only while it is still the listed copy; a tab that refreshed it since keeps its backup. */
export async function deleteAutosaveIfUnchanged(id: string, savedAt: string, name = AUTOSAVE_DB): Promise<boolean> {
  return (await run(name, 'readwrite', (s) => {
    const get = s.get(id);
    // addEventListener because run() owns onsuccess; a delete issued here still joins the same transaction.
    get.addEventListener('success', () => { if (isEntry(get.result) && get.result.savedAt === savedAt) s.delete(id); });
    return get;
  })).ok;
}

export async function clearAllAutosaves(name = AUTOSAVE_DB): Promise<boolean> {
  return (await run(name, 'readwrite', (s) => s.clear())).ok;
}

// ---- wiring ----------------------------------------------------------------

export interface AutosaveOptions {
  /** Turns a document into project JSON; injected for the reason given at the top. */
  serialize: (doc: PhotoDoc) => string;
  dbName?: string;
}

/**
 * Watch every open document and keep a copy of each unsaved one. Writes run
 * from an idle callback so they miss the middle of a stroke; each one is timed
 * so an oversized document backs off instead of stuttering the editor.
 */
export function installAutosave(app: App, options: AutosaveOptions): void {
  const dbName = options.dbName ?? AUTOSAVE_DB;
  const timings = new Map<string, AutosaveTiming>();
  /** Documents queued or being written; keeps a burst of events from queuing twice. */
  const inFlight = new Set<string>();
  /** Consecutive failed writes per document. */
  const failures = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let slowShown = false;
  let unavailableShown = false;
  let failureShown = false;

  const write = async (doc: PhotoDoc): Promise<void> => {
    const id = doc.meta.id;
    if (doc.livePreview) {
      // Mid-stroke: pixels are not committed yet, and a long serialisation would stutter the stroke.
      setTimeout(() => { inFlight.delete(id); schedule(); }, 1000);
      return;
    }
    const revision = doc.revision;
    const started = performance.now();
    let durationMs = 0, failed = false;
    try {
      if (!app.docs.includes(doc)) return;
      const json = options.serialize(doc);
      durationMs = performance.now() - started;
      failed = !await writeAutosave({
        id, name: doc.meta.name, savedAt: new Date().toISOString(), revision,
        width: doc.width, height: doc.height, layers: doc.allLayers().length,
        bytes: json.length, json,
      }, dbName);
      // Saved or closed while the write was in flight: the record would outlive the work.
      if (!failed && (!app.docs.includes(doc) || !doc.isDirty)) await deleteAutosave(id, dbName);
    } catch (err) {
      failed = true;
      durationMs = durationMs || performance.now() - started;
      console.error(err);
      if (!failureShown) app.toast(`自動儲存失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
      failureShown = true;
    } finally {
      const now = Date.now();
      const strikes = failed ? (failures.get(id) ?? 0) + 1 : 0;
      failures.set(id, strikes);
      // Retry after a quiet period, a few times; a store that is gone or keeps refusing waits for an edit.
      const retry = failed && autosaveAvailable() && strikes <= MAX_RETRIES;
      if (failed && !retry && autosaveAvailable() && !failureShown) {
        failureShown = true;
        app.toast('自動儲存一直寫不進瀏覽器的儲存空間（可能已滿），請記得手動存檔', 'error');
      }
      const t = timings.get(id);
      if (t) timings.set(id, retry ? markFailed(t, now) : markWritten(t, revision, durationMs, now));
      if (slowNoticeDue(durationMs, slowShown)) { slowShown = true; app.toast(SLOW_NOTICE); }
      inFlight.delete(id);
      schedule();
    }
  };

  const schedule = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!autosaveAvailable()) {
      // Nothing can be written; say so once, since the safety net is off.
      if (!unavailableShown) app.toast('這個瀏覽器無法使用自動儲存（私密視窗或已封鎖網站資料），請記得手動存檔');
      unavailableShown = true;
      return;
    }
    const now = Date.now();
    let next = Infinity;
    for (const doc of app.docs) {
      const t = timings.get(doc.meta.id);
      if (!t || inFlight.has(doc.meta.id)) continue;
      const plan = planAutosave(t, doc.isDirty, now);
      if (plan.action === 'wait') next = Math.min(next, plan.until);
      else if (plan.action === 'save') {
        inFlight.add(doc.meta.id);
        if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void write(doc), { timeout: 1000 });
        else setTimeout(() => void write(doc), 0);
      }
    }
    if (next < Infinity) timer = setTimeout(schedule, Math.max(0, next - now));
  };

  const observe = (): void => {
    const now = Date.now();
    const live = new Set<string>();
    for (const doc of app.docs) {
      const id = doc.meta.id;
      live.add(id);
      const t = timings.get(id);
      if (!t) {
        // Arriving already dirty (a recovered document) counts as an edit now.
        timings.set(id, doc.isDirty ? markChanged(freshTiming(doc.revision), doc.revision, now) : freshTiming(doc.revision));
      } else if (!doc.isDirty) {
        timings.set(id, markClean(t, doc.revision));
      } else if (doc.revision !== t.revision) {
        timings.set(id, markChanged(t, doc.revision, now));
      }
    }
    // Closed documents: app.closeDoc removes the record itself.
    for (const id of [...timings.keys()]) if (!live.has(id)) { timings.delete(id); failures.delete(id); }
    schedule();
  };

  app.events.on('doc-changed', observe);
  app.events.on('docs-changed', observe);
  observe();
}
