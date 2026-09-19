import type { App } from '../../core/app';
import { createSurface } from '../../core/surface';
import {
  composeWarpWithSelection, freezeOverlay, meshPath, warpImage, WarpMesh,
  LIQUIFY_TOOLS, type LiquifyMode,
} from '../../filters/liquify';
import { el, on } from '../dom';
import { checkboxControl, openModal, sliderControl } from '../modal';

const MAX_W = 560;
const MAX_H = 420;

/**
 * Liquify workspace: a displacement mesh the user pushes around with brushes.
 * The preview warps a downscaled copy so it stays interactive; the same mesh
 * is replayed at full resolution when the dialog is confirmed.
 */
export async function liquifyDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  const target = doc.paintTarget();
  if (!target) {
    app.toast('此圖層無法液化（已鎖定或為智慧型物件）', 'error');
    return;
  }

  const source = target.surface;
  const scale = Math.min(1, MAX_W / source.w, MAX_H / source.h);
  const pw = Math.max(1, Math.round(source.w * scale));
  const ph = Math.max(1, Math.round(source.h * scale));

  // Downscaled copy the preview warps, so a drag stays responsive on big files.
  const small = createSurface(pw, ph);
  small.ctx.imageSmoothingQuality = 'high';
  small.ctx.drawImage(source.canvas, 0, 0, pw, ph);
  const srcData = small.ctx.getImageData(0, 0, pw, ph);
  const dstData = new ImageData(pw, ph);

  const mesh = new WarpMesh(source.w, source.h, 4);

  let mode: LiquifyMode = 'forward';
  let brushSize = Math.max(20, Math.round(Math.min(source.w, source.h) / 6));
  let pressure = 50;
  let showMesh = false;
  let showFreeze = true;
  let cursor: { x: number; y: number } | null = null;

  const canvas = el('canvas', {
    width: pw, height: ph,
    style: `width:${pw}px;height:${ph}px;cursor:crosshair;border-radius:3px;display:block`,
  }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  const render = (): void => {
    warpImage(srcData, dstData, mesh, scale);
    ctx.putImageData(dstData, 0, 0);
    if (showFreeze && mesh.hasFreeze()) {
      const overlay = freezeOverlay(mesh, pw, ph, scale);
      const tmp = createSurface(pw, ph);
      tmp.ctx.putImageData(overlay, 0, 0);
      ctx.drawImage(tmp.canvas, 0, 0);
    }
    if (showMesh) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke(meshPath(mesh, scale, 4));
      ctx.restore();
    }
    if (cursor) {
      const r = (brushSize / 2) * scale;
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, r + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  };
  render();

  // ---- pointer handling -------------------------------------------------

  let dragging = false;
  let last = { x: 0, y: 0 };
  let repeat = 0;

  const toDoc = (ev: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * source.w,
      y: ((ev.clientY - r.top) / r.height) * source.h,
    };
  };

  const step = (x: number, y: number, dx: number, dy: number): void => {
    mesh.stroke(mode, x, y, brushSize / 2, pressure / 100, dx, dy);
  };

  on(canvas, 'pointerdown', (e) => {
    const ev = e as PointerEvent;
    canvas.setPointerCapture(ev.pointerId);
    dragging = true;
    last = toDoc(ev);
    step(last.x, last.y, 0, 0);
    // Twirl, pucker and bloat keep working while the pointer is held still.
    if (mode === 'twirl-cw' || mode === 'twirl-ccw' || mode === 'pucker' || mode === 'bloat') {
      repeat = window.setInterval(() => {
        step(last.x, last.y, 0, 0);
        render();
      }, 45);
    }
    render();
  });

  on(canvas, 'pointermove', (e) => {
    const ev = e as PointerEvent;
    const r = canvas.getBoundingClientRect();
    cursor = { x: ((ev.clientX - r.left) / r.width) * pw, y: ((ev.clientY - r.top) / r.height) * ph };
    if (!dragging) { render(); return; }
    const p = toDoc(ev);
    const dx = p.x - last.x, dy = p.y - last.y;
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(1, brushSize / 8);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      step(last.x + dx * t, last.y + dy * t, dx / steps, dy / steps);
    }
    last = p;
    render();
  });

  const endDrag = (): void => {
    dragging = false;
    if (repeat) { window.clearInterval(repeat); repeat = 0; }
  };
  on(canvas, 'pointerup', endDrag);
  on(canvas, 'pointercancel', endDrag);
  on(canvas, 'pointerleave', () => { cursor = null; render(); });

  // ---- controls ---------------------------------------------------------

  const toolButtons: HTMLButtonElement[] = [];
  const toolList = el('div', { style: 'display:grid;gap:3px' });
  for (const t of LIQUIFY_TOOLS) {
    const b = el('button', {
      class: `btn${t.mode === mode ? ' primary' : ''}`,
      style: 'text-align:left;padding:5px 9px',
      title: t.hint,
      text: t.label,
    }) as HTMLButtonElement;
    on(b, 'click', () => {
      mode = t.mode;
      toolButtons.forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
      hint.textContent = t.hint;
    });
    toolButtons.push(b);
    toolList.append(b);
  }
  const hint = el('div', { class: 'hint', text: LIQUIFY_TOOLS[0].hint });

  const resetAll = el('button', { class: 'btn', text: '全部復原' });
  on(resetAll, 'click', () => { mesh.reset(); render(); });
  const thawAll = el('button', { class: 'btn', text: '全部解凍' });
  on(thawAll, 'click', () => { mesh.clearFreeze(); render(); });

  const controls = el('div', { style: 'display:grid;gap:10px;width:212px;align-content:start' },
    el('div', { class: 'panel-head', style: 'background:none;padding:0' }, el('span', { text: '工具' })),
    toolList,
    hint,
    el('div', { class: 'panel-head', style: 'background:none;padding:0' }, el('span', { text: '筆刷選項' })),
    el('div', {},
      el('div', { class: 'hint', text: '筆刷尺寸' }),
      sliderControl(brushSize, 5, Math.max(50, Math.min(source.w, source.h)), 1, (v) => {
        brushSize = v; render();
      }, ' px', 120)),
    el('div', {},
      el('div', { class: 'hint', text: '筆刷壓力' }),
      sliderControl(pressure, 1, 100, 1, (v) => { pressure = v; }, '%', 120)),
    checkboxControl('顯示網格', showMesh, (v) => { showMesh = v; render(); }),
    checkboxControl('顯示凍結區', showFreeze, (v) => { showFreeze = v; render(); }),
    el('div', { style: 'display:flex;gap:6px' }, resetAll, thawAll));

  const body = el('div', { style: 'display:flex;gap:14px;align-items:flex-start' },
    el('div', { class: 'preview-pane', style: `width:${pw}px;height:${ph}px` }, canvas),
    controls);

  const result = await openModal({ title: '液化', body });
  endDrag();
  if (result !== 'ok' || mesh.isIdentity()) return;

  // ---- apply at full resolution -----------------------------------------

  const full = source.ctx.getImageData(0, 0, source.w, source.h);
  const warped = new ImageData(source.w, source.h);
  warpImage(full, warped, mesh, 1);

  let out = createSurface(source.w, source.h);
  out.ctx.putImageData(warped, 0, 0);

  if (target.clipToSelection && doc.selection.active) {
    out = composeWarpWithSelection(
      source, out, doc.selection.toSurface(), target.offX, target.offY,
    );
  }

  const dest = doc.mutablePaintSurface(target.layer, target.slot);
  dest.ctx.clearRect(0, 0, dest.w, dest.h);
  dest.ctx.drawImage(out.canvas, 0, 0);
  doc.commit('液化');
  app.changed();
}
