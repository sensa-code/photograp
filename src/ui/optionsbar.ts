import type { App } from '../core/app';
import { getTool, transformTool } from '../tools';
import type { Tool, ToolOption } from '../tools/types';
import { optionDefaults } from '../tools/types';
import { clear, el, on } from './dom';
import { icon } from './icons';
import { colorChip, segmentedControl, selectControl } from './modal';
import { GRADIENT_PRESETS, presetStops, renderGradient } from '../tools/draw';
import { gradientEditor } from './dialogs/gradient';
import { createSurface } from '../core/surface';
import type { RGB } from '../core/color';

export class OptionsBar {
  readonly root: HTMLElement;
  /** Set while this bar is the source of an option change. */
  private selfEmitting = false;

  constructor(private app: App) {
    this.root = el('div', { class: 'optionsbar' });
    app.events.on('tool-changed', () => this.refresh());
    app.events.on('color-changed', () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    // Rebuilding while one of our own controls is being dragged would destroy
    // the element under the pointer, so ignore changes we caused ourselves.
    if (this.selfEmitting) return;
    clear(this.root);
    const tool: Tool = transformTool.state ? transformTool : getTool(this.app.toolId);
    const values = this.app.options(tool.id, optionDefaults(tool));

    this.root.append(el('div', { class: 'tool-name' },
      el('span', { html: icon(tool.icon, 16) }),
      el('span', { text: tool.name })));

    for (const opt of tool.options) {
      if (opt.visible && !opt.visible(values)) continue;
      const control = this.buildControl(tool, opt, values);
      if (!control) continue;
      this.root.append(el('div', { class: 'opt' },
        opt.type === 'checkbox' ? null : el('label', { text: opt.label }),
        control));
    }

    if (tool.id === 'gradient') this.root.append(this.gradientPreview(values));

    if (transformTool.state) {
      const apply = el('button', { class: 'btn primary', text: '套用變形 (Enter)' });
      on(apply, 'click', () => transformTool.apply(this.app));
      const cancel = el('button', { class: 'btn', text: '取消 (Esc)' });
      on(cancel, 'click', () => transformTool.cancel(this.app));
      const flipH = el('button', { class: 'btn', text: '水平翻轉' });
      on(flipH, 'click', () => transformTool.flip(this.app, 'h'));
      const flipV = el('button', { class: 'btn', text: '垂直翻轉' });
      on(flipV, 'click', () => transformTool.flip(this.app, 'v'));
      const rot = el('button', { class: 'btn', text: '旋轉 90°' });
      on(rot, 'click', () => transformTool.rotateBy(this.app, 90));
      this.root.append(el('div', { class: 'opt' }, flipH, flipV, rot, apply, cancel));
    }

    if (tool.id === 'crop') {
      const apply = el('button', { class: 'btn primary', text: '套用裁切 (Enter)' });
      on(apply, 'click', () => {
        const cropTool = getTool('crop') as Tool & { apply: (a: App) => void };
        cropTool.apply(this.app);
      });
      this.root.append(el('div', { class: 'opt' }, apply));
    }
  }

  private buildControl(
    tool: Tool, opt: ToolOption, values: Record<string, unknown>,
  ): HTMLElement | null {
    const set = (v: unknown): void => {
      values[opt.key] = v;
      this.selfEmitting = true;
      this.app.events.emit('options-changed', undefined);
      this.selfEmitting = false;
      this.app.changed();
    };

    switch (opt.type) {
      case 'slider': {
        const range = el('input', {
          type: 'range', min: opt.min ?? 0, max: opt.max ?? 100,
          step: opt.step ?? 1, value: Number(values[opt.key] ?? 0),
        }) as HTMLInputElement;
        const readout = el('span', { class: 'val' });
        const paint = (): void => {
          readout.textContent = `${Number(range.value)}${opt.unit ?? ''}`;
        };
        paint();
        on(range, 'input', () => { set(Number(range.value)); paint(); });
        range.style.width = `${opt.width ?? 96}px`;
        return el('div', { class: 'slider' }, range, readout);
      }
      case 'checkbox': {
        const input = el('input', { type: 'checkbox', checked: Boolean(values[opt.key]) }) as HTMLInputElement;
        on(input, 'change', () => set(input.checked));
        return el('label', { class: 'checkbox' }, input, el('span', { text: opt.label }));
      }
      case 'select':
        return selectControl(String(values[opt.key] ?? ''), opt.options ?? [], set);
      case 'segmented':
        return segmentedControl(String(values[opt.key] ?? ''), opt.options ?? [], set);
      case 'color':
        return colorChip(values[opt.key] as RGB, set);
      case 'number': {
        const input = el('input', {
          type: 'number', min: opt.min, max: opt.max, step: opt.step ?? 1,
          value: Number(values[opt.key] ?? 0),
        }) as HTMLInputElement;
        on(input, 'input', () => set(Number(input.value)));
        return input;
      }
      case 'button': {
        const b = el('button', { class: 'btn', text: opt.label });
        on(b, 'click', () => opt.onClick?.(this.app));
        return b;
      }
      default:
        void tool;
        return null;
    }
  }

  private gradientPreview(values: Record<string, unknown>): HTMLElement {
    const canvas = el('canvas', {
      width: 130, height: 20, class: 'gradient-swatch', title: '點一下開啟漸層編輯器',
    }) as HTMLCanvasElement;
    const draw = (): void => {
      const s = createSurface(130, 20);
      const stops = presetStops(String(values.preset ?? 'fg-bg'), this.app.foreground, this.app.background);
      renderGradient(s, 'linear', 0, 0, 130, 0, stops, Boolean(values.reverse), false);
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 130, 20);
      ctx.drawImage(s.canvas, 0, 0);
    };
    draw();
    // Clicking the swatch opens the editor, as it does in Photoshop.
    on(canvas, 'click', () => gradientEditor(this.app));
    void GRADIENT_PRESETS;
    return el('div', { class: 'opt' }, el('label', { text: '漸層' }), canvas);
  }
}
