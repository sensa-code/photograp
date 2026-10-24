import './styles/app.css';
import { app } from './core/app';
import { PhotoDoc } from './core/document';
import { AppUI } from './ui/app-ui';
import { installDesktop } from './ui/desktop-integration';
import { installErrorGuard } from './ui/error-guard';

const mount = document.getElementById('app');
if (!mount) throw new Error('找不到 #app 容器');

const ui = new AppUI(app);
mount.append(ui.root);
installErrorGuard(app);

// Start with an empty canvas so the workspace is usable immediately.
app.addDoc(PhotoDoc.createBlank('未命名-1', 1280, 800, 'white'));
requestAnimationFrame(() => ui.fitToWindow());

app.status('就緒 · 按 F1 或「說明 → 鍵盤快速鍵」查看操作說明');

// Native dialogs, the window title and files handed over by the OS. Does
// nothing in the browser build.
installDesktop(app);

// A small handle for debugging and automated checks from the console. It is
// deliberately not `photograp`: that name belongs to the desktop bridge the
// preload script installs, and overwriting it would break every native call.
(window as unknown as { __photograp: unknown }).__photograp = { app, ui };
