import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import type { Layer } from '../core/types';
import {
  FONT_STACKS, defaultPathBinding, measureText, overflowLines, renderTextLayer,
} from '../core/text';
import { flattenPath } from '../core/path';
import { el, on } from './dom';
import { colorChip, segmentedControl, selectControl } from './modal';
import type { CanvasView } from './canvas-view';

/** Floating on-canvas editor for type layers. */
export class TextEditor {
  private node: HTMLElement | null = null;
  private layer: Layer | null = null;
  private doc: PhotoDoc | null = null;

  constructor(private app: App, private view: CanvasView) {}

  get active(): boolean { return this.node !== null; }

  open(layer: Layer, doc: PhotoDoc): void {
    this.close(true);
    if (!layer.text) return;
    this.layer = layer;
    this.doc = doc;

    const t = layer.text;
    const area = el('textarea', { placeholder: '輸入文字…' }) as HTMLTextAreaElement;
    area.value = t.text;

    const rerender = (commitLabel?: string): void => {
      renderTextLayer(layer, doc.width, doc.height, doc.paths);
      if (commitLabel) doc.commit(commitLabel);
      else doc.touch();
      this.app.changed();
    };

    on(area, 'input', () => { t.text = area.value; rerender(); syncBoxRow(); });

    const fontSelect = selectControl(t.fontFamily, FONT_STACKS, (v) => {
      t.fontFamily = v; rerender();
    });
    const sizeInput = el('input', { type: 'number', min: 4, max: 800, value: t.fontSize, style: 'width:70px' }) as HTMLInputElement;
    on(sizeInput, 'input', () => { t.fontSize = Math.max(4, Number(sizeInput.value)); rerender(); });

    const bold = el('button', { class: `btn${t.bold ? ' primary' : ''}`, text: 'B', style: 'font-weight:700;width:30px' });
    on(bold, 'click', () => {
      t.bold = !t.bold;
      bold.classList.toggle('primary', t.bold);
      rerender();
    });
    const italic = el('button', { class: `btn${t.italic ? ' primary' : ''}`, text: 'I', style: 'font-style:italic;width:30px' });
    on(italic, 'click', () => {
      t.italic = !t.italic;
      italic.classList.toggle('primary', t.italic);
      rerender();
    });

    const align = segmentedControl(t.align, [
      { value: 'left', label: '靠左' },
      { value: 'center', label: '置中' },
      { value: 'right', label: '靠右' },
      { value: 'justify', label: '齊行' },
    ], (v) => { t.align = v as typeof t.align; rerender(); });

    const color = colorChip(t.color, (c) => { t.color = c; rerender(); });

    const spacing = el('input', { type: 'number', min: -20, max: 80, value: t.letterSpacing, style: 'width:62px' }) as HTMLInputElement;
    on(spacing, 'input', () => { t.letterSpacing = Number(spacing.value); rerender(); });

    const lineHeight = el('input', { type: 'number', min: 0.6, max: 4, step: 0.05, value: t.lineHeight, style: 'width:62px' }) as HTMLInputElement;
    on(lineHeight, 'input', () => { t.lineHeight = Math.max(0.5, Number(lineHeight.value)); rerender(); });

    // ---- type on a path ----
    const usable = doc.paths.filter((path) => flattenPath(path).length > 0);
    const pathSelect = selectControl(t.onPath?.pathId ?? '', [
      { value: '', label: '不沿路徑' },
      ...usable.map((path) => ({ value: path.id, label: path.name })),
    ], (v) => {
      // A curve has one baseline, so a frame and a path are alternatives.
      t.onPath = v ? defaultPathBinding(v) : undefined;
      if (t.onPath) t.box = undefined;
      syncPathRow();
      syncBoxRow();
      rerender();
    });

    const offset = el('input', {
      type: 'number', step: 2, value: t.onPath?.offset ?? 0, style: 'width:66px',
    }) as HTMLInputElement;
    on(offset, 'input', () => {
      if (t.onPath) { t.onPath.offset = Number(offset.value); rerender(); }
    });

    const shift = el('input', {
      type: 'number', step: 1, value: t.onPath?.baselineShift ?? 0, style: 'width:66px',
    }) as HTMLInputElement;
    on(shift, 'input', () => {
      if (t.onPath) { t.onPath.baselineShift = Number(shift.value); rerender(); }
    });

    const flipBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    flipBox.checked = t.onPath?.flip ?? false;
    on(flipBox, 'change', () => {
      if (t.onPath) { t.onPath.flip = flipBox.checked; rerender(); }
    });
    const flip = el('label', { class: 'checkbox' }, flipBox, el('span', { text: '翻轉' }));

    const pathRow = el('div', { class: 'row' },
      pathSelect,
      el('span', { class: 'hint', text: '起點' }), offset,
      el('span', { class: 'hint', text: '基線' }), shift,
      flip);

    const syncPathRow = (): void => {
      const bound = !!t.onPath;
      for (const c of [offset, shift, flipBox]) c.disabled = !bound;
      // Turning on a frame drops the binding, so the menu has to follow.
      pathSelect.value = t.onPath?.pathId ?? '';
      if (t.onPath) {
        offset.value = String(t.onPath.offset);
        shift.value = String(t.onPath.baselineShift);
        flipBox.checked = t.onPath.flip;
      }
    };
    syncPathRow();

    // ---- paragraph frame ----
    const boxCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
    boxCheck.checked = !!t.box;
    const boxW = el('input', {
      type: 'number', min: 16, max: 8000, value: t.box?.w ?? 0, style: 'width:64px',
    }) as HTMLInputElement;
    const boxH = el('input', {
      type: 'number', min: 16, max: 8000, value: t.box?.h ?? 0, style: 'width:64px',
    }) as HTMLInputElement;
    const fit = el('button', { class: 'btn', text: '符合文字' });
    const overflow = el('span', { class: 'hint' });

    const syncBoxRow = (): void => {
      const boxed = !!t.box;
      boxCheck.checked = boxed;
      for (const c of [boxW, boxH]) c.disabled = !boxed;
      fit.disabled = !boxed;
      if (t.box) {
        boxW.value = String(Math.round(t.box.w));
        boxH.value = String(Math.round(t.box.h));
      }
      const hidden = overflowLines(t);
      overflow.textContent = hidden > 0 ? `溢出 ${hidden} 行` : '';
      overflow.style.color = hidden > 0 ? 'var(--warn, #e0a030)' : '';
    };

    on(boxCheck, 'change', () => {
      if (boxCheck.checked) {
        // Start from the size the type already occupies, so turning a point
        // layer into a paragraph does not reflow it on the spot.
        const m = measureText({ ...t, box: undefined });
        const lineH = t.fontSize * t.lineHeight;
        t.box = {
          w: Math.max(160, Math.ceil(m.width)),
          h: Math.max(lineH, Math.ceil(m.height)),
        };
        t.onPath = undefined;
      } else {
        t.box = undefined;
      }
      syncPathRow();
      syncBoxRow();
      rerender();
    });
    const readBox = (): void => {
      if (!t.box) return;
      t.box = {
        w: Math.max(16, Number(boxW.value) || 16),
        h: Math.max(16, Number(boxH.value) || 16),
      };
      rerender();
      syncBoxRow();
    };
    on(boxW, 'input', readBox);
    on(boxH, 'input', readBox);
    on(fit, 'click', () => {
      if (!t.box) return;
      // Grow the frame down until every wrapped line is inside it.
      t.box = { w: t.box.w, h: Math.max(16, Math.ceil(measureText(t).height)) };
      rerender();
      syncBoxRow();
    });

    const boxRow = el('div', { class: 'row' },
      el('label', { class: 'checkbox' }, boxCheck, el('span', { text: '段落框' })),
      el('span', { class: 'hint', text: '寬' }), boxW,
      el('span', { class: 'hint', text: '高' }), boxH,
      fit, overflow);
    syncBoxRow();

    const done = el('button', { class: 'btn primary', text: '完成' });
    on(done, 'click', () => this.close(false));
    const cancel = el('button', { class: 'btn', text: '取消' });
    on(cancel, 'click', () => this.close(true));

    this.node = el('div', { class: 'text-overlay' },
      area,
      el('div', { class: 'row' }, fontSelect, sizeInput, bold, italic),
      el('div', { class: 'row' }, align, color,
        el('span', { class: 'hint', text: '字距' }), spacing,
        el('span', { class: 'hint', text: '行距' }), lineHeight),
      boxRow,
      usable.length ? pathRow : null,
      el('div', { class: 'row', style: 'justify-content:flex-end' }, cancel, done));

    this.position();
    this.view.root.append(this.node);
    area.focus();
    area.select();

    on(area, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      ev.stopPropagation();
      if (ev.key === 'Escape') this.close(true);
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) this.close(false);
    });
  }

  private position(): void {
    if (!this.node || !this.layer) return;
    const bind = this.layer.text?.onPath;
    const start = bind && this.doc
      ? flattenPath(this.doc.paths.find((x) => x.id === bind.pathId)
        ?? { id: '', name: '', subpaths: [] })[0]?.pts[0]
      : null;
    const p = start
      ? this.view.docToScreen(start.x, start.y)
      : this.view.docToScreen(this.layer.x, this.layer.y);
    const rect = this.view.root.getBoundingClientRect();
    const left = Math.min(Math.max(8, p.x), rect.width - 346);
    const top = Math.min(Math.max(8, p.y + 10), rect.height - 220);
    this.node.style.left = `${left}px`;
    this.node.style.top = `${top}px`;
  }

  close(cancelled: boolean): void {
    if (!this.node) return;
    this.node.remove();
    this.node = null;
    const layer = this.layer;
    const doc = this.doc;
    this.layer = null;
    this.doc = null;
    if (!layer || !doc) return;

    if (cancelled && layer.text && layer.text.text.trim() === '') {
      doc.removeLayer(layer.id);
      doc.commit('取消文字圖層');
    } else if (!cancelled) {
      renderTextLayer(layer, doc.width, doc.height, doc.paths);
      layer.name = layer.text?.text.split('\n')[0].slice(0, 20) || '文字';
      doc.commit('編輯文字');
    }
    this.app.changed();
  }
}
