import { clear, el, on } from './dom';
import { icon } from './icons';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, rgbCss, type RGB } from '../core/color';
import { clamp } from '../core/geometry';

export interface ModalButton {
  label: string;
  value: string;
  primary?: boolean;
  keepOpen?: boolean;
}

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  buttons?: ModalButton[];
  width?: number;
  onClose?: () => void;
}

let openCount = 0;
export const modalOpen = (): boolean => openCount > 0;

export function openModal(opts: ModalOptions): Promise<string | null> {
  return new Promise((resolve) => {
    openCount++;
    const buttons = opts.buttons ?? [
      { label: '取消', value: 'cancel' },
      { label: '確定', value: 'ok', primary: true },
    ];
    const foot = el('div', { class: 'modal-foot' });
    const modal = el(
      'div',
      { class: 'modal', style: opts.width ? `width:${opts.width}px` : '' },
      el(
        'div', { class: 'modal-head' },
        el('span', { text: opts.title }),
        el('button', { class: 'mini-btn', html: icon('close', 16), title: '關閉' }),
      ),
      el('div', { class: 'modal-body' }, opts.body),
      foot,
    );
    const backdrop = el('div', { class: 'modal-backdrop' }, modal);

    const finish = (value: string | null): void => {
      openCount--;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      opts.onClose?.();
      resolve(value);
    };

    for (const b of buttons) {
      const btn = el('button', { class: `btn${b.primary ? ' primary' : ''}`, text: b.label });
      on(btn, 'click', () => finish(b.value));
      foot.append(btn);
    }
    on(modal.querySelector('.modal-head button')!, 'click', () => finish(null));
    on(backdrop, 'pointerdown', (ev) => { if (ev.target === backdrop) finish(null); });

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.stopPropagation(); finish(null); }
      if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement)) {
        ev.stopPropagation();
        const primary = buttons.find((b) => b.primary);
        if (primary) finish(primary.value);
      }
    };
    document.addEventListener('keydown', onKey, true);

    document.body.append(backdrop);
    const firstInput = modal.querySelector<HTMLElement>('input, select, textarea');
    firstInput?.focus();
  });
}

export async function alertDialog(title: string, message: string): Promise<void> {
  await openModal({
    title,
    body: el('div', { text: message, style: 'max-width:420px' }),
    buttons: [{ label: '確定', value: 'ok', primary: true }],
  });
}

export async function confirmDialog(title: string, message: string): Promise<boolean> {
  const r = await openModal({
    title,
    body: el('div', { text: message, style: 'max-width:420px' }),
    buttons: [{ label: '取消', value: 'cancel' }, { label: '確定', value: 'ok', primary: true }],
  });
  return r === 'ok';
}

// ---- reusable controls -----------------------------------------------------

export function sliderControl(
  value: number, min: number, max: number, step: number,
  onChange: (v: number) => void, unit = '', width = 150,
): HTMLElement {
  const range = el('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
  const num = el('input', { type: 'number', min, max, step, value }) as HTMLInputElement;
  range.style.setProperty('--slider-w', `${width}px`);
  range.style.width = `${width}px`;
  num.style.width = '68px';
  const sync = (v: number, fire = true): void => {
    const c = clamp(v, min, max);
    range.value = String(c);
    num.value = String(Math.round(c * 1000) / 1000);
    if (fire) onChange(c);
  };
  on(range, 'input', () => sync(Number(range.value)));
  on(num, 'change', () => sync(Number(num.value)));
  const wrap = el('div', { class: 'slider' }, range, num, unit ? el('span', { class: 'val', text: unit }) : null);
  (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => sync(v, false);
  return wrap;
}

export function numberControl(
  value: number, min: number, max: number, step: number, onChange: (v: number) => void,
): HTMLInputElement {
  const num = el('input', { type: 'number', min, max, step, value }) as HTMLInputElement;
  on(num, 'input', () => onChange(clamp(Number(num.value), min, max)));
  return num;
}

export function selectControl(
  value: string, options: { value: string; label: string }[], onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select') as HTMLSelectElement;
  for (const o of options) sel.append(el('option', { value: o.value, text: o.label }));
  sel.value = value;
  on(sel, 'change', () => onChange(sel.value));
  return sel;
}

export function checkboxControl(
  label: string, value: boolean, onChange: (v: boolean) => void,
): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  on(input, 'change', () => onChange(input.checked));
  return el('label', { class: 'checkbox' }, input, el('span', { text: label }));
}

export function segmentedControl(
  value: string, options: { value: string; label: string }[], onChange: (v: string) => void,
): HTMLElement {
  const wrap = el('div', { class: 'segmented' });
  const buttons: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = el('button', { text: o.label, class: o.value === value ? 'active' : '' }) as HTMLButtonElement;
    on(b, 'click', () => {
      for (const other of buttons) other.classList.remove('active');
      b.classList.add('active');
      onChange(o.value);
    });
    buttons.push(b);
    wrap.append(b);
  }
  return wrap;
}

export function colorChip(value: RGB, onChange: (c: RGB) => void): HTMLButtonElement {
  const btn = el('button', { class: 'color-chip' }) as HTMLButtonElement;
  const paint = (c: RGB): void => { btn.style.background = rgbCss(c); };
  paint(value);
  let current = { ...value };
  on(btn, 'click', async () => {
    const picked = await colorPickerDialog(current);
    if (picked) { current = picked; paint(picked); onChange(picked); }
  });
  return btn;
}

// ---- colour picker ---------------------------------------------------------

export function colorPickerDialog(initial: RGB): Promise<RGB | null> {
  let hsv = rgbToHsv(initial);
  let rgb = { ...initial };

  const sv = el('div', { class: 'sv-area' });
  const svDot = el('div', { class: 'picker-dot' });
  sv.append(svDot);
  const hue = el('div', { class: 'hue-bar' });
  const hueDot = el('div', { class: 'hue-dot' });
  hue.append(hueDot);

  const preview = el('div', {
    style: 'height:34px;border:1px solid #111;box-shadow:0 0 0 1px #777;border-radius:3px',
  });
  const hexInput = el('input', { type: 'text', value: rgbToHex(initial), maxlength: 7 }) as HTMLInputElement;
  const rIn = el('input', { type: 'number', min: 0, max: 255, value: initial.r }) as HTMLInputElement;
  const gIn = el('input', { type: 'number', min: 0, max: 255, value: initial.g }) as HTMLInputElement;
  const bIn = el('input', { type: 'number', min: 0, max: 255, value: initial.b }) as HTMLInputElement;

  const refresh = (from: 'hsv' | 'rgb'): void => {
    if (from === 'hsv') rgb = hsvToRgb(hsv);
    else hsv = rgbToHsv(rgb);
    sv.style.background =
      `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
    svDot.style.left = `${hsv.s * 100}%`;
    svDot.style.top = `${(1 - hsv.v) * 100}%`;
    hueDot.style.left = `${(hsv.h / 360) * 100}%`;
    preview.style.background = rgbCss(rgb);
    hexInput.value = rgbToHex(rgb);
    rIn.value = String(rgb.r);
    gIn.value = String(rgb.g);
    bIn.value = String(rgb.b);
  };

  const dragArea = (node: HTMLElement, handler: (nx: number, ny: number) => void): void => {
    const update = (ev: PointerEvent): void => {
      const r = node.getBoundingClientRect();
      handler(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
    };
    on(node, 'pointerdown', (ev) => {
      node.setPointerCapture(ev.pointerId);
      update(ev);
      const move = (e: PointerEvent): void => update(e);
      const up = (): void => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
  };

  dragArea(sv, (nx, ny) => { hsv.s = nx; hsv.v = 1 - ny; refresh('hsv'); });
  dragArea(hue, (nx) => { hsv.h = nx * 360; refresh('hsv'); });

  on(hexInput, 'input', () => {
    const c = hexToRgb(hexInput.value);
    if (c) { rgb = c; refresh('rgb'); }
  });
  for (const [input, key] of [[rIn, 'r'], [gIn, 'g'], [bIn, 'b']] as const) {
    on(input, 'input', () => {
      rgb = { ...rgb, [key]: clamp(Number(input.value), 0, 255) };
      refresh('rgb');
    });
  }

  refresh('hsv');

  const body = el(
    'div', { style: 'width:290px;display:grid;gap:9px' },
    sv, hue, preview,
    el('div', { class: 'rgb-row' },
      el('label', { text: 'HEX', class: 'hint' }), hexInput,
      el('span'), el('span')),
    el('div', { class: 'rgb-row' },
      el('label', { text: 'R', class: 'hint' }), rIn,
      el('label', { text: 'G', class: 'hint' }), gIn),
    el('div', { class: 'rgb-row' },
      el('label', { text: 'B', class: 'hint' }), bIn,
      el('span'), el('span')),
  );

  return openModal({ title: '檢色器', body }).then((r) => (r === 'ok' ? rgb : null));
}

/** Build a labelled two-column form. */
export function formGrid(rows: [string | null, HTMLElement | string][]): HTMLElement {
  const grid = el('div', { class: 'form-grid' });
  for (const [label, control] of rows) {
    if (label === null) {
      const node = typeof control === 'string' ? el('div', { text: control }) : control;
      node.classList.add('full');
      grid.append(node);
      continue;
    }
    grid.append(el('label', { text: label }));
    grid.append(typeof control === 'string' ? el('span', { text: control }) : control);
  }
  return grid;
}

export function rebuild(node: HTMLElement, children: (Node | null)[]): void {
  clear(node);
  for (const c of children) if (c) node.append(c);
}
