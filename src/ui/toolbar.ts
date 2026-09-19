import type { App } from '../core/app';
import { getTool, TOOL_SLOTS, TOOLS } from '../tools';
import { el, on } from './dom';
import { icon } from './icons';
import { colorPickerDialog } from './modal';
import { rgbCss } from '../core/color';

export class ToolBar {
  readonly root: HTMLElement;
  /** Last tool chosen inside each stacked slot. */
  private slotChoice: string[] = TOOL_SLOTS.map((s) => s[0]);
  private buttons: HTMLButtonElement[] = [];
  private fgSwatch!: HTMLElement;
  private bgSwatch!: HTMLElement;

  constructor(private app: App) {
    this.root = el('div', { class: 'toolbar' });
    this.build();
    app.events.on('tool-changed', () => this.refresh());
    app.events.on('color-changed', () => this.paintColors());
  }

  private build(): void {
    TOOL_SLOTS.forEach((slot, i) => {
      const wrap = el('div', { class: 'tool-slot' });
      const btn = el('button', { class: 'tool-btn' }) as HTMLButtonElement;
      let pressTimer = 0;

      const openFlyout = (): void => {
        if (slot.length < 2) return;
        const pop = el('div', { class: 'flyout' });
        for (const id of slot) {
          const t = getTool(id);
          const row = el('div', { class: 'menu-row' },
            el('span', { html: icon(t.icon, 16) }),
            el('span', { text: t.name }),
            t.shortcut ? el('kbd', { text: t.shortcut.toUpperCase() }) : null);
          on(row, 'click', () => {
            this.slotChoice[i] = id;
            this.app.setTool(id);
            cleanup();
          });
          pop.append(row);
        }
        const r = btn.getBoundingClientRect();
        pop.style.left = `${r.right + 4}px`;
        pop.style.top = `${r.top}px`;
        document.body.append(pop);
        const outside = (ev: Event): void => {
          if (!pop.contains(ev.target as Node)) cleanup();
        };
        const cleanup = (): void => {
          pop.remove();
          document.removeEventListener('pointerdown', outside, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
      };

      on(btn, 'pointerdown', () => {
        pressTimer = window.setTimeout(openFlyout, 380);
      });
      on(btn, 'pointerup', () => window.clearTimeout(pressTimer));
      on(btn, 'pointerleave', () => window.clearTimeout(pressTimer));
      on(btn, 'click', () => this.app.setTool(this.slotChoice[i]));
      on(btn, 'contextmenu', (ev) => { ev.preventDefault(); openFlyout(); });

      wrap.append(btn);
      if (slot.length > 1) wrap.append(el('span', { class: 'more' }));
      this.buttons.push(btn);
      this.root.append(wrap);
    });

    this.root.append(el('div', { style: 'height:8px' }));

    // Foreground / background colour wells.
    const well = el('div', { class: 'color-well' });
    this.fgSwatch = el('div', { class: 'swatch fg', title: '前景色' });
    this.bgSwatch = el('div', { class: 'swatch bg', title: '背景色' });
    on(this.fgSwatch, 'click', async () => {
      const c = await colorPickerDialog(this.app.foreground);
      if (c) this.app.setForeground(c);
    });
    on(this.bgSwatch, 'click', async () => {
      const c = await colorPickerDialog(this.app.background);
      if (c) this.app.setBackground(c);
    });
    well.append(this.bgSwatch, this.fgSwatch);
    this.root.append(well);

    const swap = el('button', { class: 'mini-btn', html: icon('swap', 14), title: '交換顏色 (X)' });
    on(swap, 'click', () => this.app.swapColors());
    const reset = el('button', { class: 'mini-btn', html: icon('close', 14), title: '重設為黑白 (D)' });
    on(reset, 'click', () => this.app.resetColors());
    this.root.append(el('div', { style: 'display:flex;gap:2px;margin-top:4px' }, swap, reset));

    this.paintColors();
    this.refresh();
  }

  private paintColors(): void {
    this.fgSwatch.style.background = rgbCss(this.app.foreground);
    this.bgSwatch.style.background = rgbCss(this.app.background);
  }

  refresh(): void {
    const active = this.app.toolId;
    TOOL_SLOTS.forEach((slot, i) => {
      if (slot.includes(active)) this.slotChoice[i] = active;
      const tool = getTool(this.slotChoice[i]);
      const btn = this.buttons[i];
      btn.innerHTML = icon(tool.icon, 18);
      btn.title = `${tool.name}${tool.shortcut ? ` (${tool.shortcut.toUpperCase()})` : ''}`;
      btn.classList.toggle('active', slot.includes(active));
    });
  }

  /** Cycle to the next tool sharing a keyboard shortcut. */
  cycleShortcut(key: string): boolean {
    const matches = TOOLS.filter((t) => t.shortcut === key);
    if (!matches.length) return false;
    const idx = matches.findIndex((t) => t.id === this.app.toolId);
    const next = matches[(idx + 1) % matches.length];
    this.app.setTool(next.id);
    return true;
  }
}
