/**
 * Headless runner for the browser test suite, so CI can run it with one
 * command:
 *
 *   npm test          (= electron tests/run-headless.cjs)
 *
 * Electron is already a devDependency, so it doubles as the headless browser
 * instead of adding Playwright or Puppeteer. Vite's dev server runs inside
 * this very process (no child process to orphan when the run is killed),
 * tests/index.html is opened in a hidden window, and the page is polled until
 * the suite has rendered its summary.
 *
 * Exit codes:
 *   0  every test passed
 *   1  at least one test failed; each one is printed as "FAIL ✕ name || why"
 *   2  the suite never finished: timeout, load error, renderer crash, ...
 *
 * The window is never shown. Electron reports a never-shown window as
 * `visible`, and `backgroundThrottling: false` keeps its timers at full
 * speed even if the platform later marks it hidden or occluded. The suite
 * itself is almost entirely synchronous work: it yields to the event loop
 * only a handful of times (setTimeout(0) in contentAwareScaleAsync, image
 * decoding) and never waits on requestAnimationFrame, so Chromium's
 * background timer throttling would only cost seconds. The「執行中…」stall
 * seen in a browser tool's background tab did not reproduce in a hidden
 * Electron window in any configuration (see the PR for the measurements).
 *
 * This file is CommonJS because the package is "type": "module" and the
 * Electron main process entry has to be CJS.
 */
'use strict';

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { version: viteVersion } = require('vite/package.json');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5181;
const HOST = '127.0.0.1';
const PAGE_URL = `http://${HOST}:${PORT}/tests/index.html`;
const POLL_MS = 500;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 5000;

const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const flush = (stream) => new Promise((resolve) => stream.write('', resolve));

/** Renderer console errors, reported when the suite never finishes. */
const rendererErrors = [];
/** The last summary line the page reported, for the timeout message. */
let lastSummary = '';
/** The in-process Vite dev server, once it is listening. */
let vite = null;
/** Set by the first call to finish(); later calls (signals, errors) join it. */
let finishing = null;

/** Closes Vite (bounded), flushes output and exits exactly once. */
function finish(code) {
  if (finishing) return finishing;
  finishing = (async () => {
    clearTimeout(watchdog);
    if (code === 2 && rendererErrors.length > 0) {
      err('ERROR 渲染程序的 console 錯誤（最後 20 則）：');
      for (const message of rendererErrors.slice(-20)) err(`  ${message}`);
    }
    if (vite) {
      await Promise.race([vite.close().catch(() => undefined), delay(CLOSE_TIMEOUT_MS)]);
    }
    await Promise.all([flush(process.stdout), flush(process.stderr)]);
    app.exit(code);
  })();
  return finishing;
}

function abort(reason) {
  err(`ERROR ${reason}`);
  return finish(2);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => void abort(`收到 ${signal}，中止測試`));
}
process.on('uncaughtException', (e) => void abort(e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => void abort(e && e.stack ? e.stack : String(e)));
// Electron would otherwise quit with code 0 when the window goes away.
app.on('window-all-closed', () => void abort('測試視窗在套件完成前被關閉'));

// One deadline for everything: Vite start-up, page load and polling. A
// renderer stuck in a synchronous loop never answers executeJavaScript(),
// so the deadline cannot live inside the polling loop.
const watchdog = setTimeout(
  () => void abort(`逾時 ${TOTAL_TIMEOUT_MS / 1000} 秒，頁面停在「${lastSummary}」`),
  TOTAL_TIMEOUT_MS,
);

/** Starts Vite on the fixed port; rejects if the port is taken. */
async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    clearScreen: false,
    server: { host: HOST, port: PORT, strictPort: true, open: false },
  });
  await server.listen();
  return server;
}

/**
 * Runs in the page: the summary line, every failed case with its message,
 * and Vite's error overlay when the module failed to load at all.
 */
const PROBE = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '');
  const failures = [];
  for (const el of document.querySelectorAll('#out .fail')) {
    failures.push({ name: text(el), why: text(el.nextElementSibling) });
  }
  const overlay = document.querySelector('vite-error-overlay');
  const overlayRoot = overlay && overlay.shadowRoot;
  return {
    summary: text(document.getElementById('summary')),
    failures,
    overlay: overlayRoot
      ? ['.message', '.file', '.frame'].map((s) => text(overlayRoot.querySelector(s))).filter(Boolean).join('\\n')
      : '',
  };
})()`;

/** Polls the page until the suite has rendered a verdict; the watchdog ends a run that never does. */
async function waitForSuite(webContents) {
  let probeFailures = 0;
  for (;;) {
    await delay(POLL_MS);
    let state;
    try {
      state = await webContents.executeJavaScript(PROBE, true);
      probeFailures = 0;
    } catch (e) {
      // The page may be mid-navigation (a Vite reload); a few misses are fine.
      if (++probeFailures >= 10) throw new Error(`讀不到測試頁面：${e.message}`);
      continue;
    }
    if (state.overlay) throw new Error(`Vite 無法載入測試套件：\n${state.overlay}`);
    lastSummary = state.summary;
    if (lastSummary.includes('全部通過') || lastSummary.includes('項失敗')) return state;
  }
}

async function main() {
  vite = await startVite();
  out(`INFO Vite ${viteVersion} 於 ${PAGE_URL}，Electron ${process.versions.electron}`);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      // An in-memory session, so localStorage never leaks between runs.
      partition: 'photograp-tests',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const { webContents } = win;
  webContents.on('console-message', (event) => {
    if (event.level === 'error') rendererErrors.push(event.message);
  });
  webContents.on('render-process-gone', (_event, details) => {
    void abort(`渲染程序結束：${details.reason}（exit code ${details.exitCode}）`);
  });

  await win.loadURL(PAGE_URL);
  const state = await waitForSuite(webContents);

  if (state.failures.length === 0 && state.summary.includes('全部通過')) {
    out(`PASS ${state.summary}（耗時 ${elapsed()}）`);
    return finish(0);
  }
  out(`FAIL ${state.summary}（耗時 ${elapsed()}）`);
  for (const { name, why } of state.failures) out(`FAIL ${name} || ${why}`);
  return finish(1);
}

app.whenReady()
  .then(main)
  .catch((e) => abort(e instanceof Error ? e.message : String(e)));
