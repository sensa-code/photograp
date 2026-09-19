import type { App } from '../../core/app';
import type { GradientStop } from '../../core/types';
import type { RGB } from '../../core/color';
import { rgbCss } from '../../core/color';
import { clamp } from '../../core/geometry';
import { createSurface } from '../../core/surface';
import {
  cloneStops, createGradient, describeGradient, loadGradients, resetGradients,
  resolveStops, saveGradients, sortStops, type GradientPreset,
} from '../../core/gradients';
import { refreshGradientOptions, renderGradient } from '../../tools/draw';
import { clear, el, on } from '../dom';
import { icon } from '../icons';
import { colorPickerDialog, openModal, rebuild } from '../modal';

const BAR_W = 360;
const BAR_H = 34;
/** Room above and below the bar for the opacity and colour stop handles. */
const PAD = 14;

type Kind = 'color' | 'alpha';

/** Transparency behind a gradient reads as a checkerboard, as on the canvas. */
function paintChecker(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = 7;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size) + (y / size)) % 2 === 0 ? '#ffffff' : '#c8c8c8';
      ctx.fillRect(x, y, size, size);
    }
  }
}

/**
 * Photoshop's gradient editor: colour stops under the bar, opacity stops over
 * it. Both are the same list of stops — a stop simply carries both a colour
 * and an alpha, and each row edits one half of it.
 */
export function gradientEditor(app: App): void {
  let presets = loadGradients();
  let currentId = String(app.toolOptions.gradient?.preset ?? presets[0].id);
  let current = presets.find((p) => p.id === currentId) ?? presets[0];
  currentId = current.id;
  let stops = cloneStops(current.stops);
  let selected = 0;
  let selectedKind: Kind = 'color';

  const bar = el('canvas', {
    width: BAR_W, height: BAR_H, class: 'gradient-bar',
  }) as HTMLCanvasElement;
  const track = el('div', { class: 'gradient-track' }, bar);
  const info = el('div', { class: 'hint' });
  const presetList = el('div', { class: 'gradient-presets' });
  const stopRow = el('div', { class: 'row' });

  const posOf = (s: GradientStop): number => clamp(s.pos, 0, 1) * BAR_W;

  const drawBar = (): void => {
    const ctx = bar.getContext('2d')!;
    paintChecker(ctx, BAR_W, BAR_H);
    const s = createSurface(BAR_W, BAR_H);
    renderGradient(
      s, 'linear', 0, 0, BAR_W, 0,
      resolveStops(sortStops(stops), app.foreground, app.background), false, false,
    );
    ctx.drawImage(s.canvas, 0, 0);
  };

  /** Rebuild the draggable handles that sit above and below the bar. */
  const drawHandles = (): void => {
    for (const node of [...track.querySelectorAll('.gradient-stop')]) node.remove();
    stops.forEach((s, i) => {
      for (const kind of ['alpha', 'color'] as Kind[]) {
        const handle = el('span', {
          class: `gradient-stop ${kind}${selected === i && selectedKind === kind ? ' on' : ''}`,
          style: `left:${posOf(s)}px`,
          title: kind === 'color' ? '色標' : '不透明度色標',
        });
        if (kind === 'color') {
          handle.style.background = s.ref
            ? rgbCss(s.ref === 'fg' ? app.foreground : app.background)
            : rgbCss(s.color);
        } else {
          const v = Math.round(s.alpha * 255);
          handle.style.background = `rgb(${v},${v},${v})`;
        }
        on(handle, 'pointerdown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selected = i;
          selectedKind = kind;
          startDrag(ev as PointerEvent, i);
          refresh();
        });
        on(handle, 'dblclick', (ev) => {
          ev.stopPropagation();
          if (kind === 'color') void pickColour(i);
        });
        track.append(handle);
      }
    });
  };

  const startDrag = (ev: PointerEvent, index: number): void => {
    const rect = bar.getBoundingClientRect();
    const move = (m: PointerEvent): void => {
      stops[index].pos = clamp((m.clientX - rect.left) / BAR_W, 0, 1);
      refresh();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void ev;
  };

  const pickColour = async (index: number): Promise<void> => {
    const s = stops[index];
    const start: RGB = s.ref ? (s.ref === 'fg' ? app.foreground : app.background) : s.color;
    const picked = await colorPickerDialog(start);
    if (!picked) return;
    stops[index] = { ...s, color: picked, ref: undefined };
    refresh();
  };

  // Clicking the bar itself drops a new stop that matches what is already
  // there, so the gradient does not jump when you add one.
  on(bar, 'pointerdown', (ev) => {
    const rect = bar.getBoundingClientRect();
    const pos = clamp(((ev as PointerEvent).clientX - rect.left) / BAR_W, 0, 1);
    const sorted = sortStops(stops);
    const after = sorted.find((s) => s.pos >= pos) ?? sorted[sorted.length - 1];
    const before = [...sorted].reverse().find((s) => s.pos <= pos) ?? sorted[0];
    const span = after.pos - before.pos;
    const t = span > 0 ? (pos - before.pos) / span : 0;
    const lerp = (a: number, b: number): number => Math.round(a + (b - a) * t);
    const ca = before.ref ? (before.ref === 'fg' ? app.foreground : app.background) : before.color;
    const cb = after.ref ? (after.ref === 'fg' ? app.foreground : app.background) : after.color;
    stops.push({
      pos,
      color: { r: lerp(ca.r, cb.r), g: lerp(ca.g, cb.g), b: lerp(ca.b, cb.b) },
      alpha: before.alpha + (after.alpha - before.alpha) * t,
    });
    selected = stops.length - 1;
    selectedKind = 'color';
    refresh();
  });

  const removeSelected = (): void => {
    if (stops.length <= 2) return;
    stops.splice(selected, 1);
    selected = Math.min(selected, stops.length - 1);
    refresh();
  };

  const buildStopRow = (): void => {
    const s = stops[selected];
    const posInput = el('input', {
      type: 'number', min: 0, max: 100, step: 1,
      value: Math.round(s.pos * 100), style: 'width:64px',
    }) as HTMLInputElement;
    on(posInput, 'input', () => {
      stops[selected].pos = clamp(Number(posInput.value) / 100, 0, 1);
      refresh();
    });

    const colourBtn = el('button', { class: 'color-chip' }) as HTMLButtonElement;
    colourBtn.style.background = rgbCss(
      s.ref ? (s.ref === 'fg' ? app.foreground : app.background) : s.color,
    );
    on(colourBtn, 'click', () => { void pickColour(selected); });

    const alphaInput = el('input', {
      type: 'number', min: 0, max: 100, step: 1,
      value: Math.round(s.alpha * 100), style: 'width:64px',
    }) as HTMLInputElement;
    on(alphaInput, 'input', () => {
      stops[selected].alpha = clamp(Number(alphaInput.value) / 100, 0, 1);
      refresh();
    });

    const follow = el('select') as HTMLSelectElement;
    for (const o of [
      { value: '', label: '固定顏色' },
      { value: 'fg', label: '前景色' },
      { value: 'bg', label: '背景色' },
    ]) follow.append(el('option', { value: o.value, text: o.label }));
    follow.value = s.ref ?? '';
    on(follow, 'change', () => {
      stops[selected] = {
        ...stops[selected],
        ref: (follow.value || undefined) as GradientStop['ref'],
      };
      refresh();
    });

    const del = el('button', { class: 'btn', text: '刪除色標' }) as HTMLButtonElement;
    del.disabled = stops.length <= 2;
    on(del, 'click', removeSelected);

    rebuild(stopRow, [
      el('span', { class: 'hint', text: '位置' }), posInput,
      el('span', { class: 'hint', text: '顏色' }), colourBtn, follow,
      el('span', { class: 'hint', text: '不透明' }), alphaInput,
      del,
    ]);
  };

  const buildPresets = (): void => {
    clear(presetList);
    for (const p of presets) {
      const swatch = el('canvas', { width: 64, height: 18 }) as HTMLCanvasElement;
      const s = createSurface(64, 18);
      paintChecker(s.ctx, 64, 18);
      const g = createSurface(64, 18);
      renderGradient(
        g, 'linear', 0, 0, 64, 0,
        resolveStops(sortStops(p.stops), app.foreground, app.background), false, false,
      );
      s.ctx.drawImage(g.canvas, 0, 0);
      swatch.getContext('2d')!.drawImage(s.canvas, 0, 0);

      const item = el('div', {
        class: `gradient-preset${p.id === currentId ? ' on' : ''}`, title: p.name,
      }, swatch, el('span', { text: p.name }));
      on(item, 'click', () => {
        currentId = p.id;
        current = p;
        stops = cloneStops(p.stops);
        selected = 0;
        refresh();
      });
      if (!p.builtin) {
        const del = el('button', { class: 'mini-btn', html: icon('trash', 11), title: '刪除' });
        on(del, 'click', (ev) => {
          ev.stopPropagation();
          presets = presets.filter((x) => x.id !== p.id);
          saveGradients(presets);
          refreshGradientOptions();
          if (currentId === p.id) {
            current = presets[0];
            currentId = current.id;
            stops = cloneStops(current.stops);
          }
          refresh();
        });
        item.append(del);
      }
      presetList.append(item);
    }
  };

  const refresh = (): void => {
    drawBar();
    drawHandles();
    buildStopRow();
    buildPresets();
    info.textContent = describeGradient(stops);
  };

  const nameInput = el('input', {
    type: 'text', value: current.name, style: 'flex:1;min-width:0',
  }) as HTMLInputElement;
  const saveBtn = el('button', { class: 'btn', text: '儲存為新漸層' });
  on(saveBtn, 'click', () => {
    const entry = createGradient(nameInput.value.trim() || '自訂漸層', sortStops(stops));
    presets = [...presets, entry];
    saveGradients(presets);
    refreshGradientOptions();
    currentId = entry.id;
    current = entry;
    app.status(`已儲存漸層「${entry.name}」`);
    refresh();
  });
  const resetBtn = el('button', { class: 'btn', text: '恢復內建' });
  on(resetBtn, 'click', () => {
    presets = resetGradients();
    refreshGradientOptions();
    current = presets.find((p) => p.id === currentId) ?? presets[0];
    currentId = current.id;
    stops = cloneStops(current.stops);
    selected = 0;
    refresh();
  });

  const body = el('div', { class: 'gradient-editor' },
    presetList,
    el('div', { class: 'row' }, nameInput, saveBtn, resetBtn),
    track,
    info,
    stopRow,
    el('div', { class: 'hint', text: '點一下漸層條新增色標，拖曳可移動，雙擊色標可換色。' }));

  void openModal({ title: '漸層編輯器', body, width: BAR_W + PAD * 2 + 48 }).then((res) => {
    if (res !== 'ok') return;
    // Picking OK keeps the edits by saving them over the chosen gradient, or
    // as a new one when the chosen gradient is a built-in.
    let target = current;
    if (current.builtin) {
      target = createGradient(`${current.name} 拷貝`, sortStops(stops));
      presets = [...presets, target];
    } else {
      target = { ...current, stops: cloneStops(sortStops(stops)) };
      presets = presets.map((p) => (p.id === target.id ? target : p));
    }
    saveGradients(presets);
    refreshGradientOptions();
    app.options('gradient', {});
    (app.toolOptions.gradient ??= {}).preset = target.id;
    app.events.emit('options-changed', undefined);
    app.changed();
  });

  refresh();
}

/** The dialog needs the current preset list refreshed in the tool options. */
export function gradientPresets(): GradientPreset[] {
  return loadGradients();
}
