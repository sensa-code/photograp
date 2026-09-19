import type { App } from '../core/app';
import type { PaintSlot, PaintTarget, PhotoDoc } from '../core/document';
import type { Layer } from '../core/types';
import type { Surface } from '../core/surface';
import { cloneSurface, createSurface } from '../core/surface';
import { clamp } from '../core/geometry';
import { luminance, type RGB } from '../core/color';
import { gaussianBlur } from '../filters/blur';
import { convolve } from '../filters/effects';
import { brushStamp, Stroke, type BrushSettings } from './stroke';
import {
  cachedPatternSurface, loadPatterns, tileInto, warmPatterns,
} from '../core/patterns';
import type { Tool, ToolOption, ToolPointer } from './types';

const sizeOpt = (def = 30): ToolOption =>
  ({ key: 'size', label: '尺寸', type: 'slider', min: 1, max: 600, step: 1, default: def, unit: ' px' });
const hardnessOpt = (def = 80): ToolOption =>
  ({ key: 'hardness', label: '硬度', type: 'slider', min: 0, max: 100, step: 1, default: def, unit: '%' });
const opacityOpt = (def = 100): ToolOption =>
  ({ key: 'opacity', label: '不透明度', type: 'slider', min: 1, max: 100, step: 1, default: def, unit: '%' });
const flowOpt = (def = 100): ToolOption =>
  ({ key: 'flow', label: '流量', type: 'slider', min: 1, max: 100, step: 1, default: def, unit: '%' });
const spacingOpt: ToolOption =
  { key: 'spacing', label: '間距', type: 'slider', min: 1, max: 200, step: 1, default: 12, unit: '%' };
const smoothingOpt: ToolOption =
  { key: 'smoothing', label: '平滑化', type: 'slider', min: 0, max: 95, step: 1, default: 30, unit: '%' };

function brushSettings(
  app: App, toolId: string, color: RGB, overrides: Partial<BrushSettings> = {},
): BrushSettings {
  const o = app.toolOptions[toolId] ?? {};
  return {
    size: Number(o.size ?? 30),
    hardness: Number(o.hardness ?? 80) / 100,
    opacity: Number(o.opacity ?? 100) / 100,
    flow: Number(o.flow ?? 100) / 100,
    spacing: Number(o.spacing ?? 12),
    smoothing: Number(o.smoothing ?? 30),
    sizePressure: o.sizePressure !== false,
    opacityPressure: Boolean(o.opacityPressure),
    scatter: Number(o.scatter ?? 0),
    roundness: Number(o.roundness ?? 100) / 100,
    angle: Number(o.angle ?? 0),
    sizeJitter: Number(o.sizeJitter ?? 0) / 100,
    color,
    ...overrides,
  };
}

/** Tools that lay down dabs from the shared stroke engine. */
abstract class StrokeTool implements Tool {
  abstract id: string;
  abstract name: string;
  abstract shortcut: string;
  abstract icon: string;
  group = 'paint';
  options: ToolOption[] = [];
  showBrushCursor = true;
  protected stroke: Stroke | null = null;
  protected lastPoint: { x: number; y: number } | null = null;

  protected abstract makeStroke(e: ToolPointer, target: PaintTarget): Stroke | null;

  protected abstract label(): string;

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) {
      e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法繪製', 'error');
      return;
    }
    this.stroke = this.makeStroke(e, target);
    if (!this.stroke) return;
    if (e.shift && this.lastPoint) {
      this.stroke.begin(this.lastPoint.x, this.lastPoint.y, e.pressure);
      this.stroke.extend(e.x, e.y, e.pressure);
    } else {
      this.stroke.begin(e.x, e.y, e.pressure);
    }
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.stroke) return;
    if (e.coalesced && e.coalesced.length > 1) {
      for (const p of e.coalesced) this.stroke.extend(p.x, p.y, p.pressure);
    } else {
      this.stroke.extend(e.x, e.y, e.pressure);
    }
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.stroke) return;
    this.stroke.commit(this.label());
    this.stroke = null;
    this.lastPoint = { x: e.x, y: e.y };
    e.app.changed();
  }

  cancel(app: App): void {
    if (this.stroke) { this.stroke.abort(); this.stroke = null; app.changed(); }
  }
}

export class BrushTool extends StrokeTool {
  id = 'brush';
  name = '筆刷工具';
  shortcut = 'b';
  icon = 'brush';
  override options: ToolOption[] = [
    sizeOpt(30), hardnessOpt(80), opacityOpt(), flowOpt(), spacingOpt, smoothingOpt,
    { key: 'roundness', label: '圓度', type: 'slider', min: 5, max: 100, step: 1, default: 100, unit: '%' },
    { key: 'angle', label: '角度', type: 'slider', min: -180, max: 180, step: 1, default: 0, unit: '°' },
    { key: 'scatter', label: '散佈', type: 'slider', min: 0, max: 100, step: 1, default: 0, unit: ' px' },
    { key: 'sizeJitter', label: '尺寸快速變換', type: 'slider', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    { key: 'sizePressure', label: '壓力控制尺寸', type: 'checkbox', default: true },
    { key: 'opacityPressure', label: '壓力控制不透明度', type: 'checkbox', default: false },
  ];

  protected makeStroke(e: ToolPointer, t: PaintTarget): Stroke {
    const color = e.alt ? e.app.background : e.app.foreground;
    return new Stroke(e.doc, t.layer, t.surface, t.slot, brushSettings(e.app, this.id, color), 'paint');
  }

  protected label(): string { return '筆刷'; }
}

export class PencilTool extends StrokeTool {
  id = 'pencil';
  name = '鉛筆工具';
  shortcut = 'b';
  icon = 'pencil';
  override options: ToolOption[] = [sizeOpt(4), opacityOpt(), flowOpt(), spacingOpt, smoothingOpt];

  protected makeStroke(e: ToolPointer, t: PaintTarget): Stroke {
    const color = e.alt ? e.app.background : e.app.foreground;
    const s = brushSettings(e.app, this.id, color, { hardness: 1, sizePressure: false, spacing: 5 });
    return new Stroke(e.doc, t.layer, t.surface, t.slot, s, 'paint');
  }

  protected label(): string { return '鉛筆'; }
}

export class EraserTool extends StrokeTool {
  id = 'eraser';
  name = '橡皮擦工具';
  shortcut = 'e';
  icon = 'eraser';
  override options: ToolOption[] = [
    sizeOpt(40), hardnessOpt(70), opacityOpt(), flowOpt(), spacingOpt, smoothingOpt,
    { key: 'roundness', label: '圓度', type: 'slider', min: 5, max: 100, step: 1, default: 100, unit: '%' },
    { key: 'angle', label: '角度', type: 'slider', min: -180, max: 180, step: 1, default: 0, unit: '°' },
    { key: 'sizePressure', label: '壓力控制尺寸', type: 'checkbox', default: true },
  ];

  protected makeStroke(e: ToolPointer, t: PaintTarget): Stroke {
    // Masks and Quick Mask are opaque greyscale, so there is no alpha to
    // erase; paint with the background colour instead.
    if (t.slot !== 'pixels') {
      const s = brushSettings(e.app, this.id, e.app.background);
      return new Stroke(e.doc, t.layer, t.surface, t.slot, s, 'paint');
    }
    const s = brushSettings(e.app, this.id, { r: 0, g: 0, b: 0 });
    return new Stroke(e.doc, t.layer, t.surface, 'pixels', s, 'erase');
  }

  protected label(): string { return '橡皮擦'; }
}

// ---------------------------------------------------------------------------
// Tools that read the pixels they are about to change.
// ---------------------------------------------------------------------------

type PatchFn = (
  work: Surface, x: number, y: number, radius: number, pressure: number, e: ToolPointer,
) => void;

/**
 * Paints by repeatedly reading a patch of the layer, transforming it and
 * blending it back through the brush stamp. Used by retouch tools.
 */
class DirectStroke {
  work: Surface;
  private selection: Surface | null;
  offX: number;
  offY: number;
  private lastX = 0;
  private lastY = 0;
  private carry = 0;
  private any = false;

  constructor(
    private doc: PhotoDoc,
    private layer: Layer | null,
    target: Surface,
    private slot: PaintSlot,
    private step: number,
    private patch: PatchFn,
  ) {
    this.work = cloneSurface(target);
    this.offX = slot === 'pixels' && layer ? layer.x : 0;
    this.offY = slot === 'pixels' && layer ? layer.y : 0;
    this.selection = slot !== 'quickmask' && doc.selection.active ? doc.selection.toSurface() : null;
    doc.setPaintPreview(layer, slot, this.work);
  }

  /** Blend a prepared patch onto the work surface through the brush stamp. */
  applyPatch(patch: Surface, px: number, py: number, radius: number, hardness: number, alpha: number): void {
    const stamp = brushStamp(radius * 2, hardness, { r: 255, g: 255, b: 255 });
    const masked = createSurface(patch.w, patch.h);
    masked.ctx.drawImage(patch.canvas, 0, 0);
    masked.ctx.globalCompositeOperation = 'destination-in';
    masked.ctx.drawImage(stamp.canvas, (patch.w - stamp.w) / 2, (patch.h - stamp.h) / 2);
    if (this.selection) {
      masked.ctx.drawImage(this.selection.canvas, -px - this.offX, -py - this.offY);
    }
    this.work.ctx.save();
    this.work.ctx.globalAlpha = clamp(alpha, 0, 1);
    this.work.ctx.drawImage(masked.canvas, px, py);
    this.work.ctx.restore();
    this.any = true;
  }

  begin(docX: number, docY: number, pressure: number, e: ToolPointer, radius: number): void {
    this.lastX = docX - this.offX;
    this.lastY = docY - this.offY;
    this.carry = 0;
    this.patch(this.work, this.lastX, this.lastY, radius, pressure, e);
  }

  extend(docX: number, docY: number, pressure: number, e: ToolPointer, radius: number): void {
    const x = docX - this.offX, y = docY - this.offY;
    const dx = x - this.lastX, dy = y - this.lastY;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    let travelled = -this.carry;
    const step = Math.max(1, this.step);
    while (travelled + step <= len) {
      travelled += step;
      const t = travelled / len;
      this.patch(this.work, this.lastX + dx * t, this.lastY + dy * t, radius, pressure, e);
    }
    this.carry = len - travelled;
    this.lastX = x;
    this.lastY = y;
  }

  commit(label: string): void {
    this.doc.clearPaintPreview();
    if (!this.any) { this.doc.touch(); return; }
    const target = this.doc.mutablePaintSurface(this.layer, this.slot);
    target.ctx.clearRect(0, 0, target.w, target.h);
    target.ctx.drawImage(this.work.canvas, 0, 0);
    this.doc.commit(label);
  }

  abort(): void { this.doc.clearPaintPreview(); this.doc.touch(); }
}

abstract class RetouchTool implements Tool {
  abstract id: string;
  abstract name: string;
  abstract shortcut: string;
  abstract icon: string;
  group = 'retouch';
  options: ToolOption[] = [];
  showBrushCursor = true;
  protected ds: DirectStroke | null = null;

  protected abstract patchFn(e: ToolPointer): PatchFn;
  protected abstract label(): string;

  protected radius(e: ToolPointer): number {
    return Math.max(1, Number(e.app.toolOptions[this.id]?.size ?? 40) / 2);
  }

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) { e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法編輯', 'error'); return; }
    const r = this.radius(e);
    this.ds = new DirectStroke(
      e.doc, target.layer, target.surface, target.slot,
      Math.max(1, r * 0.25), this.patchFn(e),
    );
    this.ds.begin(e.x, e.y, e.pressure, e, r);
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.ds) return;
    this.ds.extend(e.x, e.y, e.pressure, e, this.radius(e));
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.ds) return;
    this.ds.commit(this.label());
    this.ds = null;
    e.app.changed();
  }

  cancel(app: App): void {
    if (this.ds) { this.ds.abort(); this.ds = null; app.changed(); }
  }
}

function patchRegion(work: Surface, x: number, y: number, radius: number): {
  px: number; py: number; w: number; h: number;
} | null {
  const pad = 2;
  const px = Math.floor(x - radius - pad), py = Math.floor(y - radius - pad);
  const w = Math.ceil(radius * 2 + pad * 2), h = w;
  if (px + w < 0 || py + h < 0 || px > work.w || py > work.h) return null;
  return { px, py, w, h };
}

export class BlurSharpenTool extends RetouchTool {
  id = 'blur-sharpen';
  name = '模糊 / 銳利化工具';
  shortcut = 'r';
  icon = 'droplet';
  override options: ToolOption[] = [
    sizeOpt(50), hardnessOpt(50),
    {
      key: 'mode', label: '模式', type: 'segmented', default: 'blur',
      options: [{ value: 'blur', label: '模糊' }, { value: 'sharpen', label: '銳利化' }],
    },
    { key: 'strength', label: '強度', type: 'slider', min: 1, max: 100, step: 1, default: 50, unit: '%' },
  ];

  protected label(): string { return '模糊 / 銳利化'; }

  protected patchFn(e: ToolPointer): PatchFn {
    const o = e.app.toolOptions[this.id] ?? {};
    const mode = String(o.mode ?? 'blur');
    const strength = Number(o.strength ?? 50) / 100;
    const hardness = Number(o.hardness ?? 50) / 100;
    return (work, x, y, radius, pressure) => {
      const reg = patchRegion(work, x, y, radius);
      if (!reg) return;
      const patch = createSurface(reg.w, reg.h);
      patch.ctx.drawImage(work.canvas, -reg.px, -reg.py);
      const img = patch.ctx.getImageData(0, 0, reg.w, reg.h);
      if (mode === 'blur') gaussianBlur(img, Math.max(1, radius * 0.35));
      else convolve(img, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1);
      patch.ctx.putImageData(img, 0, 0);
      this.ds!.applyPatch(patch, reg.px, reg.py, radius, hardness, strength * pressure * 0.6);
    };
  }
}

export class DodgeBurnTool extends RetouchTool {
  id = 'dodge-burn';
  name = '加亮 / 加深工具';
  shortcut = 'o';
  icon = 'sun';
  override options: ToolOption[] = [
    sizeOpt(70), hardnessOpt(40),
    {
      key: 'mode', label: '模式', type: 'segmented', default: 'dodge',
      options: [
        { value: 'dodge', label: '加亮' },
        { value: 'burn', label: '加深' },
        { value: 'sponge', label: '海綿' },
      ],
    },
    {
      key: 'range', label: '範圍', type: 'select', default: 'midtones',
      options: [
        { value: 'shadows', label: '陰影' },
        { value: 'midtones', label: '中間調' },
        { value: 'highlights', label: '亮部' },
      ],
    },
    { key: 'exposure', label: '曝光', type: 'slider', min: 1, max: 100, step: 1, default: 30, unit: '%' },
  ];

  protected label(): string { return '加亮 / 加深'; }

  protected patchFn(e: ToolPointer): PatchFn {
    const o = e.app.toolOptions[this.id] ?? {};
    const mode = String(o.mode ?? 'dodge');
    const range = String(o.range ?? 'midtones');
    const exposure = Number(o.exposure ?? 30) / 100;
    const hardness = Number(o.hardness ?? 40) / 100;
    const weight = (v: number): number => {
      const t = v / 255;
      if (range === 'shadows') return Math.max(0, 1 - t * 1.6);
      if (range === 'highlights') return Math.max(0, t * 1.6 - 0.6);
      return 1 - Math.abs(t - 0.5) * 1.7;
    };
    return (work, x, y, radius, pressure) => {
      const reg = patchRegion(work, x, y, radius);
      if (!reg) return;
      const patch = createSurface(reg.w, reg.h);
      patch.ctx.drawImage(work.canvas, -reg.px, -reg.py);
      const img = patch.ctx.getImageData(0, 0, reg.w, reg.h);
      const d = img.data;
      const k = exposure * pressure;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const lum = luminance(d[i], d[i + 1], d[i + 2]);
        const w = weight(lum) * k;
        if (w <= 0) continue;
        if (mode === 'sponge') {
          for (let c = 0; c < 3; c++) d[i + c] = clamp(lum + (d[i + c] - lum) * (1 - w), 0, 255);
        } else if (mode === 'dodge') {
          for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (255 - d[i + c]) * w, 0, 255);
        } else {
          for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] * (1 - w), 0, 255);
        }
      }
      patch.ctx.putImageData(img, 0, 0);
      this.ds!.applyPatch(patch, reg.px, reg.py, radius, hardness, 1);
    };
  }
}

export class SmudgeTool extends RetouchTool {
  id = 'smudge';
  name = '指尖工具';
  shortcut = 'r';
  icon = 'finger';
  override options: ToolOption[] = [
    sizeOpt(50), hardnessOpt(40),
    { key: 'strength', label: '強度', type: 'slider', min: 1, max: 100, step: 1, default: 55, unit: '%' },
  ];

  private prev: { x: number; y: number } | null = null;

  protected label(): string { return '指尖塗抹'; }

  override down(e: ToolPointer): void {
    this.prev = null;
    super.down(e);
  }

  protected patchFn(e: ToolPointer): PatchFn {
    const o = e.app.toolOptions[this.id] ?? {};
    const strength = Number(o.strength ?? 55) / 100;
    const hardness = Number(o.hardness ?? 40) / 100;
    return (work, x, y, radius) => {
      const reg = patchRegion(work, x, y, radius);
      if (!reg) return;
      if (this.prev) {
        const patch = createSurface(reg.w, reg.h);
        // Smear: stamp the pixels from the previous dab at the new position.
        const dx = this.prev.x - x, dy = this.prev.y - y;
        patch.ctx.drawImage(work.canvas, -reg.px + dx, -reg.py + dy);
        this.ds!.applyPatch(patch, reg.px, reg.py, radius, hardness, strength);
      }
      this.prev = { x, y };
    };
  }
}

/**
 * Paints the layer back to how it looked in an earlier state. It is the clone
 * stamp with the source taken from history rather than from another position,
 * so selective undo becomes a brush.
 */
export class HistoryBrushTool implements Tool {
  id = 'history-brush';
  name = '步驟記錄筆刷';
  shortcut = 'y';
  icon = 'undo';
  group = 'retouch';
  showBrushCursor = true;
  options: ToolOption[] = [
    sizeOpt(50), hardnessOpt(70), opacityOpt(), flowOpt(),
  ];

  private ds: DirectStroke | null = null;

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) { e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法編輯', 'error'); return; }
    if (target.slot !== 'pixels' || !target.layer) {
      e.app.toast('步驟記錄筆刷只能畫在圖層像素上', 'error');
      return;
    }
    const src = e.doc.historySource(target.layer);
    if (!src) {
      e.app.toast(e.doc.historySourceReason() ?? '沒有可用的步驟記錄來源', 'error');
      return;
    }

    const o = e.app.toolOptions[this.id] ?? {};
    const radius = Math.max(1, Number(o.size ?? 50) / 2);
    const hardness = Number(o.hardness ?? 70) / 100;
    const alpha = (Number(o.opacity ?? 100) / 100) * (Number(o.flow ?? 100) / 100);

    this.ds = new DirectStroke(
      e.doc, target.layer, target.surface, target.slot, Math.max(1, radius * 0.2),
      (work, x, y, r) => {
        const reg = patchRegion(work, x, y, r);
        if (!reg) return;
        const patch = createSurface(reg.w, reg.h);
        // The source is another layer-space image; shift by however far the
        // layer has moved since that state was captured.
        patch.ctx.drawImage(src.surface.canvas, -(reg.px + src.dx), -(reg.py + src.dy));
        this.ds!.applyPatch(patch, reg.px, reg.py, r, hardness, alpha);
      },
    );
    this.ds.begin(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.ds) return;
    const radius = Math.max(1, Number(e.app.toolOptions[this.id]?.size ?? 50) / 2);
    this.ds.extend(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.ds) return;
    this.ds.commit('步驟記錄筆刷');
    this.ds = null;
    e.app.changed();
  }

  cancel(app: App): void {
    if (this.ds) { this.ds.abort(); this.ds = null; app.changed(); }
  }
}

/** Choices for the pattern stamp, rebuilt when the user defines one. */
export const PATTERN_OPTIONS: { value: string; label: string }[] = [];

export function refreshPatternOptions(): void {
  PATTERN_OPTIONS.length = 0;
  for (const p of loadPatterns()) PATTERN_OPTIONS.push({ value: p.id, label: p.name });
  warmPatterns();
}
refreshPatternOptions();

/**
 * Paints a tiled pattern through the brush. The tile is anchored to the
 * document, not the stroke, so separate strokes line up into one surface.
 */
export class PatternStampTool implements Tool {
  id = 'pattern-stamp';
  name = '圖樣印章工具';
  shortcut = '';
  icon = 'grid';
  group = 'retouch';
  showBrushCursor = true;
  options: ToolOption[] = [
    sizeOpt(60), hardnessOpt(70), opacityOpt(), flowOpt(),
    { key: 'pattern', label: '圖樣', type: 'select', default: 'checker', options: PATTERN_OPTIONS },
    { key: 'scale', label: '縮放', type: 'slider', min: 10, max: 400, step: 5, default: 100, unit: '%' },
  ];

  private ds: DirectStroke | null = null;
  private tiled: Surface | null = null;

  down(e: ToolPointer): void {
    const target = e.doc.paintTarget();
    if (!target) { e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法編輯', 'error'); return; }

    const o = e.app.toolOptions[this.id] ?? {};
    const pattern = loadPatterns().find((p) => p.id === String(o.pattern ?? 'checker'));
    if (!pattern) { e.app.toast('找不到這個圖樣', 'error'); return; }

    const radius = Math.max(1, Number(o.size ?? 60) / 2);
    const hardness = Number(o.hardness ?? 70) / 100;
    const alpha = (Number(o.opacity ?? 100) / 100) * (Number(o.flow ?? 100) / 100);

    const tile = cachedPatternSurface(pattern);
    if (!tile) {
      // Only a stored pattern that has not finished decoding lands here.
      warmPatterns();
      e.app.toast('圖樣還在載入，請再試一次', 'error');
      return;
    }
    // One tiled surface per stroke; the brush only reveals parts of it.
    const tiled = createSurface(target.surface.w, target.surface.h);
    tileInto(tiled, tile, Number(o.scale ?? 100), target.offX, target.offY);
    this.tiled = tiled;

    this.ds = new DirectStroke(
      e.doc, target.layer, target.surface, target.slot, Math.max(1, radius * 0.2),
      (work, x, y, r) => {
        const reg = patchRegion(work, x, y, r);
        if (!reg || !this.tiled) return;
        const patch = createSurface(reg.w, reg.h);
        patch.ctx.drawImage(this.tiled.canvas, -reg.px, -reg.py);
        this.ds!.applyPatch(patch, reg.px, reg.py, r, hardness, alpha);
      },
    );
    this.ds.begin(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.ds) return;
    const radius = Math.max(1, Number(e.app.toolOptions[this.id]?.size ?? 60) / 2);
    this.ds.extend(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.ds) return;
    this.ds.commit('圖樣印章');
    this.ds = null;
    this.tiled = null;
    e.app.changed();
  }

  cancel(app: App): void {
    if (this.ds) { this.ds.abort(); this.ds = null; this.tiled = null; app.changed(); }
  }
}

export class CloneStampTool implements Tool {
  id = 'clone';
  name = '仿製印章工具';
  shortcut = 's';
  icon = 'stamp';
  group = 'retouch';
  showBrushCursor = true;
  options: ToolOption[] = [
    sizeOpt(60), hardnessOpt(70), opacityOpt(), flowOpt(),
    { key: 'aligned', label: '對齊', type: 'checkbox', default: true },
    { key: 'sampleAll', label: '取樣全部圖層', type: 'checkbox', default: false },
  ];

  private source: { x: number; y: number } | null = null;
  private offset: { dx: number; dy: number } | null = null;
  private ds: DirectStroke | null = null;
  private sampleSurface: Surface | null = null;

  down(e: ToolPointer): void {
    if (e.alt) {
      this.source = { x: e.x, y: e.y };
      this.offset = null;
      e.app.status(`已設定仿製來源 (${Math.round(e.x)}, ${Math.round(e.y)})`);
      return;
    }
    if (!this.source) {
      e.app.toast('請先按住 Alt 點選仿製來源', 'error');
      return;
    }
    const target = e.doc.paintTarget();
    if (!target) { e.app.toast(e.doc.paintBlockReason() ?? '此圖層無法編輯', 'error'); return; }

    const o = e.app.toolOptions[this.id] ?? {};
    const aligned = o.aligned !== false;
    if (!aligned || !this.offset) {
      this.offset = { dx: e.x - this.source.x, dy: e.y - this.source.y };
    }
    this.sampleSurface = o.sampleAll ? e.doc.composite() : cloneSurface(target.surface);

    const radius = Math.max(1, Number(o.size ?? 60) / 2);
    const hardness = Number(o.hardness ?? 70) / 100;
    const alpha = (Number(o.opacity ?? 100) / 100) * (Number(o.flow ?? 100) / 100);
    const layerX = target.slot === 'pixels' && target.layer ? target.layer.x : 0;
    const layerY = target.slot === 'pixels' && target.layer ? target.layer.y : 0;
    const srcOffX = o.sampleAll ? 0 : layerX;
    const srcOffY = o.sampleAll ? 0 : layerY;

    this.ds = new DirectStroke(
      e.doc, target.layer, target.surface, target.slot, Math.max(1, radius * 0.2),
      (work, x, y, r) => {
        const reg = patchRegion(work, x, y, r);
        if (!reg || !this.sampleSurface || !this.offset) return;
        const patch = createSurface(reg.w, reg.h);
        // Layer-space patch position, sampled from the source offset.
        const sx = reg.px - this.offset.dx + (layerX - srcOffX);
        const sy = reg.py - this.offset.dy + (layerY - srcOffY);
        patch.ctx.drawImage(this.sampleSurface.canvas, -sx, -sy);
        this.ds!.applyPatch(patch, reg.px, reg.py, r, hardness, alpha);
      },
    );
    this.ds.begin(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.ds) return;
    const radius = Math.max(1, Number(e.app.toolOptions[this.id]?.size ?? 60) / 2);
    this.ds.extend(e.x, e.y, e.pressure, e, radius);
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.ds) return;
    this.ds.commit('仿製印章');
    this.ds = null;
    this.sampleSurface = null;
    e.app.changed();
  }

  drawOverlay(o: { ctx: CanvasRenderingContext2D; zoom: number }): void {
    if (!this.source) return;
    const { ctx, zoom } = o;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(this.source.x - 8 / zoom, this.source.y);
    ctx.lineTo(this.source.x + 8 / zoom, this.source.y);
    ctx.moveTo(this.source.x, this.source.y - 8 / zoom);
    ctx.lineTo(this.source.x, this.source.y + 8 / zoom);
    ctx.stroke();
    ctx.restore();
  }

  cancel(app: App): void {
    if (this.ds) { this.ds.abort(); this.ds = null; app.changed(); }
  }
}
