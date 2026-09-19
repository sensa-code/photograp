import type { App } from '../../core/app';
import { hexToRgb, hsvToRgb, rgbCss, rgbToHex, rgbToHsv, type RGB } from '../../core/color';
import { clamp } from '../../core/geometry';
import { el, on } from '../dom';

export class ColorPanel {
  readonly root: HTMLElement;
  private sv: HTMLElement;
  private svDot: HTMLElement;
  private hue: HTMLElement;
  private hueDot: HTMLElement;
  private hex: HTMLInputElement;
  private rgbInputs: HTMLInputElement[] = [];
  private hsv = { h: 0, s: 0, v: 0 };
  private suppress = false;

  constructor(private app: App) {
    this.sv = el('div', { class: 'sv-area' });
    this.svDot = el('div', { class: 'picker-dot' });
    this.sv.append(this.svDot);
    this.hue = el('div', { class: 'hue-bar' });
    this.hueDot = el('div', { class: 'hue-dot' });
    this.hue.append(this.hueDot);
    this.hex = el('input', { type: 'text', maxlength: 7, style: 'width:100%' }) as HTMLInputElement;

    const rgbRow = el('div', { class: 'rgb-row' });
    for (const label of ['R', 'G', 'B']) {
      const input = el('input', { type: 'number', min: 0, max: 255, style: 'width:100%' }) as HTMLInputElement;
      on(input, 'input', () => this.fromRgbInputs());
      this.rgbInputs.push(input);
      rgbRow.append(el('div', {},
        el('div', { class: 'hint', text: label }),
        input));
    }
    rgbRow.append(el('div', {}, el('div', { class: 'hint', text: 'HEX' }), this.hex));
    on(this.hex, 'input', () => {
      const c = hexToRgb(this.hex.value);
      if (c) this.app.setForeground(c);
    });

    const swatches = el('div', { class: 'swatch-grid' });
    for (const c of app.swatches) {
      const sw = el('div', { class: 'sw', style: `background:${rgbCss(c)}`, title: rgbToHex(c) });
      on(sw, 'click', () => this.app.setForeground(c));
      on(sw, 'contextmenu', (ev) => { ev.preventDefault(); this.app.setBackground(c); });
      swatches.append(sw);
    }

    this.root = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', { text: '顏色' })),
      el('div', { class: 'panel-body color-panel' },
        this.sv, this.hue, rgbRow,
        el('div', { class: 'hint', text: '色票（右鍵設為背景色）' }),
        swatches));

    this.bind();
    app.events.on('color-changed', () => this.refresh());
    this.refresh();
  }

  private bind(): void {
    const drag = (node: HTMLElement, handler: (nx: number, ny: number) => void): void => {
      const update = (ev: PointerEvent): void => {
        const r = node.getBoundingClientRect();
        handler(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
      };
      on(node, 'pointerdown', (e) => {
        const ev = e as PointerEvent;
        node.setPointerCapture(ev.pointerId);
        update(ev);
        const move = (m: PointerEvent): void => update(m);
        const up = (): void => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
      });
    };
    drag(this.sv, (nx, ny) => {
      this.hsv.s = nx;
      this.hsv.v = 1 - ny;
      this.push();
    });
    drag(this.hue, (nx) => {
      this.hsv.h = nx * 360;
      this.push();
    });
  }

  private push(): void {
    this.suppress = true;
    this.app.setForeground(hsvToRgb(this.hsv));
    this.suppress = false;
    this.paint();
  }

  private fromRgbInputs(): void {
    const c: RGB = {
      r: clamp(Number(this.rgbInputs[0].value), 0, 255),
      g: clamp(Number(this.rgbInputs[1].value), 0, 255),
      b: clamp(Number(this.rgbInputs[2].value), 0, 255),
    };
    this.app.setForeground(c);
  }

  private paint(): void {
    const c = this.app.foreground;
    this.sv.style.background =
      `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${this.hsv.h} 100% 50%))`;
    this.svDot.style.left = `${this.hsv.s * 100}%`;
    this.svDot.style.top = `${(1 - this.hsv.v) * 100}%`;
    this.hueDot.style.left = `${(this.hsv.h / 360) * 100}%`;
    if (document.activeElement !== this.hex) this.hex.value = rgbToHex(c);
    const vals = [c.r, c.g, c.b];
    this.rgbInputs.forEach((input, i) => {
      if (document.activeElement !== input) input.value = String(vals[i]);
    });
  }

  refresh(): void {
    if (!this.suppress) {
      const next = rgbToHsv(this.app.foreground);
      // Keep the current hue when the colour is grey, so the ring does not jump.
      this.hsv = { h: next.s < 0.01 ? this.hsv.h : next.h, s: next.s, v: next.v };
    }
    this.paint();
  }
}
