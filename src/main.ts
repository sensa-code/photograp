import './styles/app.css';
import { app } from './core/app';
import { PhotoDoc } from './core/document';
import { AppUI } from './ui/app-ui';

const mount = document.getElementById('app');
if (!mount) throw new Error('找不到 #app 容器');

const ui = new AppUI(app);
mount.append(ui.root);

// Start with an empty canvas so the workspace is usable immediately.
app.addDoc(PhotoDoc.createBlank('未命名-1', 1280, 800, 'white'));
requestAnimationFrame(() => ui.fitToWindow());

app.status('就緒 · 按 F1 或「說明 → 鍵盤快速鍵」查看操作說明');

// A small handle for debugging and automated checks from the console.
(window as unknown as { photograp: unknown }).photograp = { app, ui };
