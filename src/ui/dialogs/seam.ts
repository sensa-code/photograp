import type { App } from '../../core/app';
import { createSurface } from '../../core/surface';
import { contentAwareScale, contentAwareScaleAsync } from '../../filters/seam';
import { el } from '../dom';
import { checkboxControl, openModal, sliderControl } from '../modal';

/**
 * Content-Aware Scale: resize the active layer by carving seams instead of
 * squashing pixels. The preview runs on a reduced copy — carving is O(w·h)
 * per seam, so a full-size preview would stall on every slider move.
 */
export async function contentAwareScaleDialog(app: App): Promise<void> {
  const doc = app.activeDoc();
  if (!doc) return;
  const target = doc.paintTarget();
  if (!target) {
    app.toast(doc.paintBlockReason() ?? '此圖層無法編輯', 'error');
    return;
  }
  // Carving reshapes a picture, which is not something to do to a mask or to
  // the Quick Mask channel the user is currently painting in.
  if (target.slot !== 'pixels' || !target.layer?.surface) {
    app.toast('內容感知比例只能用在圖層像素上', 'error');
    return;
  }
  const layer = target.layer;
  const source = target.surface;

  let widthPct = 100;
  let heightPct = 100;
  let protectSelection = doc.selection.active;

  // The preview works on the same surface the real pass will, just smaller.
  const scale = Math.min(1, 220 / Math.max(source.w, source.h));
  const pw = Math.max(8, Math.round(source.w * scale));
  const ph = Math.max(8, Math.round(source.h * scale));
  const small = createSurface(pw, ph);
  small.ctx.drawImage(source.canvas, 0, 0, source.w, source.h, 0, 0, pw, ph);
  const smallSource = small.ctx.getImageData(0, 0, pw, ph);

  /**
   * The selection lives in document space; the carve works in the layer's
   * own space, so the mask has to be shifted by the layer offset or a moved
   * layer would protect the wrong part of the picture.
   */
  const layerProtect = (w: number, h: number): Uint8Array | null => {
    const sel = doc.selection.mask;
    if (!protectSelection || !sel) return null;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ly = Math.min(source.h - 1, Math.floor((y * source.h) / h));
      const dy = ly + layer.y;
      if (dy < 0 || dy >= doc.height) continue;
      for (let x = 0; x < w; x++) {
        const lx = Math.min(source.w - 1, Math.floor((x * source.w) / w));
        const dx = lx + layer.x;
        if (dx < 0 || dx >= doc.width) continue;
        out[y * w + x] = sel[dy * doc.width + dx];
      }
    }
    return out;
  };

  const canvas = el('canvas', { width: pw, height: ph }) as HTMLCanvasElement;
  const info = el('div', { class: 'hint' });
  let token = 0;

  const render = async (): Promise<void> => {
    const mine = ++token;
    const tw = Math.max(4, Math.round((pw * widthPct) / 100));
    const th = Math.max(4, Math.round((ph * heightPct) / 100));
    info.textContent = `預視 ${tw} × ${ph === th ? ph : th} px`;
    const out = contentAwareScale(smallSource, tw, th, { protect: layerProtect(pw, ph) });
    if (mine !== token) return;
    canvas.width = out.width;
    canvas.height = out.height;
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    info.textContent = `結果 ${Math.round((doc.width * widthPct) / 100)}`
      + ` × ${Math.round((doc.height * heightPct) / 100)} px`;
  };

  const body = el('div', { style: 'display:grid;gap:10px;min-width:330px;justify-items:center' },
    el('div', {
      class: 'preview-pane',
      style: `width:${pw}px;height:${ph}px;display:grid;place-items:center`,
    }, canvas),
    el('div', { style: 'display:grid;gap:8px;width:100%' },
      el('div', {},
        el('div', { class: 'hint', text: '寬度' }),
        sliderControl(100, 40, 160, 1, (v) => { widthPct = v; void render(); }, '%', 150)),
      el('div', {},
        el('div', { class: 'hint', text: '高度' }),
        sliderControl(100, 40, 160, 1, (v) => { heightPct = v; void render(); }, '%', 150)),
      checkboxControl('保護選取範圍內的內容', protectSelection, (v) => {
        protectSelection = v;
        void render();
      }),
      info,
      el('div', {
        class: 'hint',
        text: '接縫裁減會挑走畫面中最不重要的像素路徑，主體因此比較不會被壓扁。',
      })));

  void render();
  const res = await openModal({ title: '內容感知比例', body, width: Math.max(340, pw + 80) });
  token++;
  if (res !== 'ok') return;
  if (widthPct === 100 && heightPct === 100) return;

  // ---- run it for real, on the full-size layer ----------------------------
  const targetW = Math.max(4, Math.round((source.w * widthPct) / 100));
  const targetH = Math.max(4, Math.round((source.h * heightPct) / 100));
  const full = source.ctx.getImageData(0, 0, source.w, source.h);
  const protect = layerProtect(source.w, source.h);

  // Carving yields to the event loop, so the user can keep working while it
  // runs. Remember what we started from and abandon the result rather than
  // writing it over whatever they did in the meantime.
  const guardDoc = doc;
  const guardRevision = doc.revision;
  const guardLayerId = layer.id;

  app.status('內容感知比例運算中…');
  let last = 0;
  // The async variant yields between seams, so the status line actually
  // updates instead of the page locking up until the whole carve is done.
  const carved = await contentAwareScaleAsync(full, targetW, targetH, {
    protect,
    onProgress: (t) => {
      const pct = Math.round(t * 100);
      if (pct !== last) { last = pct; app.status(`內容感知比例 ${pct}%`); }
    },
  });

  if (app.activeDoc() !== guardDoc
    || guardDoc.revision !== guardRevision
    || !guardDoc.allLayers().some((l) => l.id === guardLayerId)) {
    app.toast('文件在運算期間被改過，已取消內容感知比例', 'error');
    return;
  }

  const tmp = createSurface(carved.width, carved.height);
  tmp.ctx.putImageData(carved, 0, 0);

  const dest = doc.mutableSurface(layer);
  dest.ctx.clearRect(0, 0, dest.w, dest.h);
  // Centre the carved result inside the layer's own surface and leave the
  // layer's offset alone, so a layer that had been moved stays put.
  dest.ctx.drawImage(
    tmp.canvas,
    Math.round((dest.w - carved.width) / 2),
    Math.round((dest.h - carved.height) / 2),
  );
  doc.commit('內容感知比例');
  app.status(`內容感知比例：${carved.width} × ${carved.height} px`);
  app.changed();
}
