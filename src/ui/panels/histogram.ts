import type { App } from '../../core/app';
import { clear, el, on, raf } from '../dom';
import { computeHistogram, HistogramView, type HistogramData } from '../dialogs/widgets';
import { selectControl } from '../modal';
import { compositeLayers } from '../../core/compositor';
import type { PhotoDoc } from '../../core/document';
import type { Layer } from '../../core/types';
import type { Surface } from '../../core/surface';

type Channel = 'rgb' | 'r' | 'g' | 'b';

export interface Stats {
  mean: number;
  stdDev: number;
  median: number;
  pixels: number;
  min: number;
  max: number;
}

/** Mean, spread and median straight from the 256-bin histogram. */
export function statsFor(data: Uint32Array, total: number): Stats {
  if (!total) return { mean: 0, stdDev: 0, median: 0, pixels: 0, min: 0, max: 0 };
  let sum = 0, sumSq = 0, min = 255, max = 0;
  for (let v = 0; v < 256; v++) {
    const n = data[v];
    if (!n) continue;
    sum += v * n;
    sumSq += v * v * n;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / total;
  let acc = 0, median = 0;
  for (let v = 0; v < 256; v++) {
    acc += data[v];
    if (acc >= total / 2) { median = v; break; }
  }
  return {
    mean,
    stdDev: Math.sqrt(Math.max(0, sumSq / total - mean * mean)),
    median,
    pixels: total,
    min,
    max,
  };
}

/** The pixels of one layer: a group is merged, an adjustment layer has none. */
function layerSurface(layer: Layer | null, doc: PhotoDoc): Surface | null {
  if (!layer) return null;
  if (layer.surface) return layer.surface;
  if (layer.kind === 'group') {
    return compositeLayers(layer.children ?? [], { width: doc.width, height: doc.height });
  }
  return null;
}

export class HistogramPanel {
  readonly root: HTMLElement;
  private view = new HistogramView(272, 92);
  private statsBox: HTMLElement;
  private channel: Channel = 'rgb';
  private source: 'composite' | 'layer' = 'composite';
  private cachedRevision = -1;
  private cachedSource = '';
  private cachedHist: HistogramData | null = null;

  constructor(private app: App) {
    this.statsBox = el('div', {
      style: 'display:grid;grid-template-columns:auto auto auto auto;gap:2px 10px;font-size:11px',
    });

    const body = el('div', { class: 'panel-body', style: 'display:grid;gap:8px' },
      el('div', { style: 'display:flex;gap:6px' },
        selectControl('rgb', [
          { value: 'rgb', label: '明度' },
          { value: 'r', label: '紅' },
          { value: 'g', label: '綠' },
          { value: 'b', label: '藍' },
        ], (v) => { this.channel = v as Channel; this.refresh(); }),
        selectControl('composite', [
          { value: 'composite', label: '合併影像' },
          { value: 'layer', label: '目前圖層' },
        ], (v) => {
          this.source = v as 'composite' | 'layer';
          this.cachedRevision = -1;
          this.refresh();
        })),
      this.view.root,
      this.statsBox);

    this.root = el('div', { class: 'panel panel-histogram collapsed' },
      el('div', { class: 'panel-head' }, el('span', { text: '色階分佈圖' })),
      body);

    // The panel starts collapsed and skips work while hidden, so it has to
    // catch up once the header is clicked open.
    on(this.root.querySelector('.panel-head')!, 'click', () => {
      setTimeout(() => this.refresh(), 0);
    });

    const update = raf(() => this.refresh());
    app.events.on('doc-changed', update);
    app.events.on('docs-changed', update);
    this.refresh();
  }

  private histogram(): HistogramData | null {
    const doc = this.app.activeDoc();
    if (!doc) return null;
    const layer = doc.activeLayer();
    // The revision counter restarts per document, so the key has to say which
    // document it belongs to or switching tabs could reuse the wrong graph.
    const key = `${doc.meta.id}|${this.source}|${layer?.id ?? ''}`;
    // Recomputing a full-size histogram on every stroke would be wasteful,
    // so reuse the last one until the document actually changes.
    if (this.cachedHist && this.cachedRevision === doc.revision && this.cachedSource === key) {
      return this.cachedHist;
    }
    // render() is the plain merged image: no channel view, quick mask overlay
    // or solo, which are display aids and would skew the statistics.
    const surface = this.source === 'layer' ? layerSurface(layer, doc) : doc.render();
    if (!surface) { this.cachedHist = null; return null; }
    const img = surface.ctx.getImageData(0, 0, surface.w, surface.h);
    this.cachedHist = computeHistogram(img);
    this.cachedRevision = doc.revision;
    this.cachedSource = key;
    return this.cachedHist;
  }

  refresh(): void {
    if (this.root.classList.contains('collapsed')) return;
    const hist = this.histogram();
    clear(this.statsBox);
    if (!hist) return;
    this.view.update(hist, this.channel);

    const s = statsFor(hist[this.channel], hist.total);
    const cell = (label: string, value: string): void => {
      this.statsBox.append(el('span', { class: 'hint', text: label }));
      this.statsBox.append(el('span', { text: value }));
    };
    cell('平均值', s.mean.toFixed(1));
    cell('標準差', s.stdDev.toFixed(1));
    cell('中間值', String(s.median));
    cell('像素', s.pixels.toLocaleString('zh-TW'));
    cell('最暗', String(s.min));
    cell('最亮', String(s.max));
  }
}
