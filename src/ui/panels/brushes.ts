import type { App } from '../../core/app';
import {
  applySettingsToOptions, createPreset, describePreset, loadPresets, resetPresets,
  savePresets, settingsFromOptions, type BrushPreset,
} from '../../core/brush-presets';
import { createSurface } from '../../core/surface';
import { getTool, TOOLS } from '../../tools';
import { optionDefaults, type Tool } from '../../tools/types';
import { brushStamp } from '../../tools/stroke';
import { clear, el, on } from '../dom';
import { icon } from '../icons';
import { confirmDialog, formGrid, openModal } from '../modal';

const THUMB_W = 116;
const THUMB_H = 34;

/** The tool a preset should be applied to: the active one if it takes a brush. */
function targetTool(app: App): Tool {
  const active = getTool(app.toolId);
  if (active.options.some((o) => o.key === 'size')) return active;
  return TOOLS.find((t) => t.id === 'brush') ?? active;
}

/** Paint an S-curve with the preset's tip, so the shape is visible at a glance. */
function renderThumb(p: BrushPreset): HTMLCanvasElement {
  const s = p.settings;
  const surf = createSurface(THUMB_W, THUMB_H);
  surf.ctx.fillStyle = '#f2f2f2';
  surf.ctx.fillRect(0, 0, THUMB_W, THUMB_H);

  // Scale the tip down so even a 200px brush shows its character here.
  const size = Math.max(1.5, Math.min(s.size, THUMB_H - 8));
  const scale = size / Math.max(1, s.size);
  const step = Math.max(0.6, (size * Math.max(1, s.spacing)) / 100);
  const stamp = brushStamp(size, s.hardness / 100, { r: 25, g: 25, b: 25 }, s.roundness / 100, s.angle);

  surf.ctx.globalAlpha = Math.max(0.06, (s.flow / 100) * (s.opacity / 100));
  const x0 = 8, x1 = THUMB_W - 8;
  for (let x = x0; x <= x1; x += step) {
    const t = (x - x0) / (x1 - x0);
    let y = THUMB_H / 2 + Math.sin(t * Math.PI * 1.6) * (THUMB_H / 2 - size / 2 - 2);
    let px = x;
    if (s.scatter > 0) {
      const jitter = s.scatter * scale;
      px += (Math.random() * 2 - 1) * jitter;
      y += (Math.random() * 2 - 1) * jitter;
    }
    const w = s.sizeJitter > 0
      ? brushStamp(
        Math.max(1, size * (1 + (Math.random() * 2 - 1) * (s.sizeJitter / 100))),
        s.hardness / 100, { r: 25, g: 25, b: 25 }, s.roundness / 100, s.angle,
      )
      : stamp;
    surf.ctx.drawImage(w.canvas, px - w.w / 2, y - w.h / 2);
  }
  return surf.canvas;
}

export class BrushesPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private presets: BrushPreset[];
  private activeId: string | null = null;

  constructor(private app: App) {
    this.presets = loadPresets();
    this.list = el('div', { class: 'panel-body' });
    this.root = el('div', { class: 'panel grow' },
      el('div', { class: 'panel-head' }, el('span', { text: '筆刷預設集' })),
      this.list,
      this.footer());
    app.events.on('tool-changed', () => this.refresh());
    this.refresh();
  }

  private footer(): HTMLElement {
    const mk = (name: string, title: string, run: () => void): HTMLElement => {
      const b = el('button', { class: 'mini-btn', html: icon(name, 15), title });
      on(b, 'click', run);
      return b;
    };
    return el('div', { class: 'panel-footer' },
      mk('plus', '以目前筆刷設定新增預設集', () => this.saveCurrent()),
      mk('copy', '重新命名選取的預設集', () => this.renameActive()),
      mk('trash', '刪除選取的預設集', () => this.deleteActive()),
      mk('refresh', '恢復預設的筆刷集', () => this.reset()));
  }

  private currentSettings(): ReturnType<typeof settingsFromOptions> {
    const tool = targetTool(this.app);
    return settingsFromOptions(this.app.options(tool.id, optionDefaults(tool)));
  }

  private apply(p: BrushPreset): void {
    const tool = targetTool(this.app);
    const opts = this.app.options(tool.id, optionDefaults(tool));
    applySettingsToOptions(p.settings, opts);
    this.activeId = p.id;
    if (this.app.toolId !== tool.id) this.app.setTool(tool.id);
    this.app.events.emit('options-changed', undefined);
    this.app.status(`已套用筆刷「${p.name}」到${tool.name}`);
    this.refresh();
  }

  private async saveCurrent(): Promise<void> {
    const settings = this.currentSettings();
    const input = el('input', {
      type: 'text', value: `筆刷 ${Math.round(settings.size)}`,
    }) as HTMLInputElement;
    const body = formGrid([
      ['名稱', input],
      [null, el('div', { class: 'hint', text: describePreset(settings) })],
    ]);
    if (await openModal({ title: '新增筆刷預設集', body }) !== 'ok') return;
    const p = createPreset(input.value.trim() || '筆刷', settings);
    this.presets = [...this.presets, p];
    savePresets(this.presets);
    this.activeId = p.id;
    this.app.toast(`已儲存筆刷「${p.name}」`, 'success');
    this.refresh();
  }

  private async renameActive(): Promise<void> {
    const p = this.presets.find((x) => x.id === this.activeId);
    if (!p) { this.app.toast('請先選擇一個預設集', 'error'); return; }
    const input = el('input', { type: 'text', value: p.name }) as HTMLInputElement;
    if (await openModal({ title: '重新命名預設集', body: input }) !== 'ok') return;
    const name = input.value.trim();
    if (!name) return;
    // Renaming a built-in turns it into a copy the user owns.
    if (p.builtin) {
      const copy = createPreset(name, p.settings);
      this.presets = this.presets.map((x) => (x.id === p.id ? copy : x));
      this.activeId = copy.id;
    } else {
      p.name = name;
    }
    savePresets(this.presets);
    this.refresh();
  }

  private async deleteActive(): Promise<void> {
    const p = this.presets.find((x) => x.id === this.activeId);
    if (!p) { this.app.toast('請先選擇一個預設集', 'error'); return; }
    if (!(await confirmDialog('刪除預設集', `確定要刪除「${p.name}」嗎？`))) return;
    this.presets = this.presets.filter((x) => x.id !== p.id);
    savePresets(this.presets);
    this.activeId = null;
    this.refresh();
  }

  private async reset(): Promise<void> {
    if (!(await confirmDialog('恢復預設', '這會刪除自訂的筆刷預設集，確定嗎？'))) return;
    this.presets = resetPresets();
    this.activeId = null;
    this.app.toast('已恢復預設的筆刷集', 'success');
    this.refresh();
  }

  refresh(): void {
    clear(this.list);
    const tool = targetTool(this.app);
    this.list.append(el('div', {
      class: 'hint',
      style: 'margin-bottom:6px',
      text: `套用目標：${tool.name}`,
    }));

    for (const p of this.presets) {
      const row = el('div', {
        class: `layer-row brush-row${p.id === this.activeId ? ' active' : ''}`,
        title: describePreset(p.settings),
      },
      el('span', { class: 'vis', html: icon('brush', 14) }),
      el('div', { class: 'thumbs' }, renderThumb(p)),
      el('div', { class: 'layer-meta' },
        el('div', { class: 'layer-name', text: p.name }),
        el('div', { class: 'layer-sub' },
          el('span', { text: describePreset(p.settings) }),
          p.builtin ? null : el('span', { class: 'badge', text: '自訂' }))));
      on(row, 'click', () => this.apply(p));
      on(row, 'dblclick', () => { this.activeId = p.id; void this.renameActive(); });
      this.list.append(row);
    }
  }
}
