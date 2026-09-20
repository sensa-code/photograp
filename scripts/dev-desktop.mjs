/**
 * Run the desktop app against the Vite dev server, so the window reloads on
 * every edit the way the browser does.
 *
 * Starts Vite, waits for the port to answer, compiles the Electron side and
 * launches it pointed at that URL. Quitting either one takes the other down.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const PORT = Number(process.env.PHOTOGRAP_PORT ?? 5180);
const URL_ = `http://localhost:${PORT}/`;
const isWindows = process.platform === 'win32';

const children = [];
let shuttingDown = false;

function stopAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

function run(command, args, opts = {}) {
  const child = spawn(command, args, { stdio: 'inherit', shell: isWindows, ...opts });
  children.push(child);
  return child;
}

/** Resolves once the dev server answers, or throws after a sensible wait. */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // Not up yet; the loop below is the retry.
    }
    await delay(250);
  }
  throw new Error(`Vite 沒有在 ${timeoutMs / 1000} 秒內於 ${URL_} 啟動`);
}

const vite = run('npx', ['vite', '--port', String(PORT), '--strictPort']);
vite.on('exit', (code) => stopAll(code ?? 0));

try {
  await waitForServer();
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  stopAll(1);
}

// The main process is TypeScript too, so it needs compiling before it runs.
const tsc = run('npx', ['tsc', '-p', 'electron']);
await new Promise((resolve, reject) => {
  tsc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('electron/ 編譯失敗'))));
});

const electron = run(electronPath, ['.'], {
  shell: false,
  env: { ...process.env, PHOTOGRAP_DEV_URL: URL_ },
});
electron.on('exit', (code) => stopAll(code ?? 0));
