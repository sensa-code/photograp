import type { App } from '../core/app';
import { COMMANDS, runCommand } from './commands';
import { getTool, transformTool, TOOLS } from '../tools';
import { modalOpen } from './modal';
import type { ToolBar } from './toolbar';
import type { CanvasView } from './canvas-view';
import type { TextEditor } from './text-editor';

const MOD_NAMES = ['ctrl', 'cmd', 'meta', 'shift', 'alt'];

/** Parse "Ctrl+Shift+Z" or "Ctrl++" into a canonical combo string. */
function parseShortcut(shortcut: string): string {
  const mods: string[] = [];
  let rest = shortcut.trim();
  for (;;) {
    const hit = MOD_NAMES.find((m) => rest.toLowerCase().startsWith(`${m}+`) && rest.length > m.length + 1);
    if (!hit) break;
    mods.push(hit === 'cmd' || hit === 'meta' ? 'ctrl' : hit);
    rest = rest.slice(hit.length + 1);
  }
  mods.sort();
  return [...new Set(mods), rest.toLowerCase()].join('+');
}

function eventCombo(ev: KeyboardEvent): string {
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push('ctrl');
  if (ev.shiftKey) mods.push('shift');
  if (ev.altKey) mods.push('alt');
  mods.sort();
  let key = ev.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === '=') key = '+';
  if (key === '_') key = '-';
  return [...mods, key].join('+');
}

const isTyping = (target: EventTarget | null): boolean => {
  const n = target as HTMLElement | null;
  if (!n) return false;
  return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable;
};

export function installShortcuts(
  app: App, toolbar: ToolBar, view: CanvasView, textEditor: TextEditor,
): void {
  const map = new Map<string, string>();
  for (const c of COMMANDS) {
    if (c.shortcut) map.set(parseShortcut(c.shortcut), c.id);
  }
  // Aliases for keys that differ across layouts.
  map.set('ctrl++', 'view.zoomIn');
  map.set('ctrl+-', 'view.zoomOut');
  map.set('ctrl+0', 'view.fit');

  window.addEventListener('keydown', (ev) => {
    if (modalOpen()) return;
    if (isTyping(ev.target)) return;

    // Space temporarily switches to panning.
    if (ev.code === 'Space' && !ev.repeat) {
      view.setSpacePanning(true);
      ev.preventDefault();
      return;
    }

    const doc = app.activeDoc();
    const tool = transformTool.state ? transformTool : getTool(app.toolId);
    if (tool.key?.(ev, app)) { ev.preventDefault(); return; }

    const combo = eventCombo(ev);
    const cmdId = map.get(combo);
    if (cmdId) {
      ev.preventDefault();
      runCommand(app, cmdId);
      return;
    }

    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    // Brush size.
    if (ev.key === '[' || ev.key === ']') {
      const opts = app.toolOptions[app.toolId];
      if (opts && typeof opts.size === 'number') {
        const step = opts.size < 12 ? 1 : opts.size < 60 ? 4 : 12;
        opts.size = Math.max(1, Math.min(600, opts.size + (ev.key === ']' ? step : -step)));
        app.events.emit('options-changed', undefined);
        app.status(`筆刷尺寸 ${opts.size} px`);
        app.changed();
        ev.preventDefault();
      }
      return;
    }

    if (ev.key.toLowerCase() === 'x') { app.swapColors(); ev.preventDefault(); return; }
    if (ev.key.toLowerCase() === 'd') { app.resetColors(); ev.preventDefault(); return; }

    if (ev.key === 'Escape') {
      if (textEditor.active) { textEditor.close(true); return; }
      tool.cancel?.(app);
      ev.preventDefault();
      return;
    }

    // Nudge the active layer.
    if (doc && ev.key.startsWith('Arrow')) {
      const layer = doc.activeLayer();
      if (layer && !layer.locked) {
        const d = ev.shiftKey ? 10 : 1;
        if (ev.key === 'ArrowLeft') layer.x -= d;
        if (ev.key === 'ArrowRight') layer.x += d;
        if (ev.key === 'ArrowUp') layer.y -= d;
        if (ev.key === 'ArrowDown') layer.y += d;
        doc.commit('移動圖層');
        app.changed();
        ev.preventDefault();
      }
      return;
    }

    // Single-letter tool shortcuts, cycling tools that share a key.
    const key = ev.key.toLowerCase();
    if (/^[a-z]$/.test(key) && TOOLS.some((t) => t.shortcut === key)) {
      toolbar.cycleShortcut(key);
      ev.preventDefault();
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') view.setSpacePanning(false);
  });

  window.addEventListener('blur', () => view.setSpacePanning(false));
}
