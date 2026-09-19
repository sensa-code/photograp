import type { App } from '../core/app';
import type { PaintTarget } from '../core/document';
import { cloneSurface, createSurface, type Surface } from '../core/surface';
import { clamp } from '../core/geometry';
import { healFromSource, spotHeal } from '../filters/heal';
import { brushStamp } from './stroke';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

const sizeOpt = (def: number): ToolOption =>
  ({ key: 'size', label: '尺寸', type: 'slider', min: 3, max: 400, step: 1, default: def, unit: ' px' });
const hardnessOpt: ToolOption =
  { key: 'hardness', label: '硬度', type: 'slider', min: 0, max: 100, step: 1, default: 85, unit: '%' };

/**
 * Shared machinery for the healing tools: paint a mask, show it while the
 * pointer is down, then repair the whole painted area in one go on release.
 * Healing a stroke as a unit is what keeps the seam smooth.
 */
abstract class HealToolBase implements Tool {
  abstract id: string;
  abstract name: string;
  abstract shortcut: string;
  abstract icon: string;
  group = 'retouch';
  cursor = 'crosshair';
  showBrushCursor = true;
  options: ToolOption[] = [];

  protected target: PaintTarget | null = null;
  protected scratch: Surface | null = null;
  protected preview: Surface | null = null;
  protected base: Surface | null = null;
  protected last: { x: number; y: number } | null = null;
  protected painted = false;

  /** Repair `img` in place; return false when the tool could not do it. */
  protected abstract heal(img: ImageData, mask: Uint8Array, e: ToolPointer): boolean;
  protected abstract label(): string;

  /** Chance to handle Alt-clicks before a stroke starts. */
  protected prepare(_e: ToolPointer): boolean { return true; }

  private offset(): { x: number; y: number } {
    return { x: this.target?.offX ?? 0, y: this.target?.offY ?? 0 };
  }

  private dab(x: number, y: number, e: ToolPointer): void {
    if (!this.scratch) return;
    const o = e.app.toolOptions[this.id] ?? {};
    const size = Number(o.size ?? 40);
    const hardness = Number(o.hardness ?? 85) / 100;
    const stamp = brushStamp(size, hardness, { r: 255, g: 255, b: 255 });
    const off = this.offset();
    this.scratch.ctx.drawImage(
      stamp.canvas, x - off.x - stamp.w / 2, y - off.y - stamp.h / 2,
    );
    this.painted = true;
  }

  private refreshPreview(): void {
    if (!this.preview || !this.base || !this.scratch) return;
    const ctx = this.preview.ctx;
    ctx.clearRect(0, 0, this.preview.w, this.preview.h);
    ctx.drawImage(this.base.canvas, 0, 0);
    // Grey wash marking what will be repaired, like Photoshop's preview.
    const wash = createSurface(this.preview.w, this.preview.h);
    wash.ctx.fillStyle = 'rgba(40,40,40,0.55)';
    wash.ctx.fillRect(0, 0, wash.w, wash.h);
    wash.ctx.globalCompositeOperation = 'destination-in';
    wash.ctx.drawImage(this.scratch.canvas, 0, 0);
    ctx.drawImage(wash.canvas, 0, 0);
  }

  down(e: ToolPointer): void {
    if (!this.prepare(e)) return;
    const target = e.doc.paintTarget();
    if (!target) {
      e.app.toast('此圖層無法修復（已鎖定或為智慧型物件）', 'error');
      return;
    }
    this.target = target;
    this.base = cloneSurface(target.surface);
    this.scratch = createSurface(target.surface.w, target.surface.h);
    this.preview = cloneSurface(target.surface);
    this.painted = false;
    e.doc.setPaintPreview(target.layer, target.slot, this.preview);
    this.dab(e.x, e.y, e);
    this.last = { x: e.x, y: e.y };
    this.refreshPreview();
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.scratch || !this.last) return;
    const size = Number(e.app.toolOptions[this.id]?.size ?? 40);
    const step = Math.max(1, size * 0.15);
    const dx = e.x - this.last.x, dy = e.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.dab(this.last.x + dx * t, this.last.y + dy * t, e);
    }
    this.last = { x: e.x, y: e.y };
    this.refreshPreview();
    e.app.changed();
  }

  up(e: ToolPointer): void {
    const target = this.target;
    const scratch = this.scratch;
    this.target = null;
    this.scratch = null;
    this.preview = null;
    this.base = null;
    this.last = null;
    if (!target || !scratch || !this.painted) {
      e.doc.clearPaintPreview();
      e.doc.touch();
      e.app.changed();
      return;
    }

    const w = target.surface.w, h = target.surface.h;
    const mask = new Uint8Array(w * h);
    const sd = scratch.ctx.getImageData(0, 0, w, h).data;
    const sel = target.clipToSelection && e.doc.selection.active ? e.doc.selection : null;
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
      let v = sd[p];
      if (v && sel) {
        const x = (i % w) + target.offX;
        const y = ((i / w) | 0) + target.offY;
        v = (v * sel.at(x, y)) / 255;
      }
      mask[i] = v;
    }

    const img = target.surface.ctx.getImageData(0, 0, w, h);
    const ok = this.heal(img, mask, e);
    e.doc.clearPaintPreview();
    if (!ok) {
      e.doc.touch();
      e.app.changed();
      return;
    }
    const dest = e.doc.mutablePaintSurface(target.layer, target.slot);
    dest.ctx.putImageData(img, 0, 0);
    e.doc.commit(this.label());
    e.app.changed();
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    if (doc) { doc.clearPaintPreview(); doc.touch(); }
    this.target = null;
    this.scratch = null;
    this.preview = null;
    this.base = null;
    this.last = null;
    app.changed();
  }
}

export class SpotHealingBrushTool extends HealToolBase {
  id = 'spot-heal';
  name = '汙點修復筆刷工具';
  shortcut = 'j';
  icon = 'heal';
  override options: ToolOption[] = [
    sizeOpt(40), hardnessOpt,
    {
      key: 'search', label: '搜尋範圍', type: 'slider',
      min: 20, max: 600, step: 10, default: 160, unit: ' px',
    },
  ];

  protected label(): string { return '汙點修復筆刷'; }

  protected heal(img: ImageData, mask: Uint8Array, e: ToolPointer): boolean {
    const radius = Number(e.app.toolOptions[this.id]?.search ?? 160);
    const ok = spotHeal(img, mask, radius);
    if (!ok) e.app.toast('附近找不到合適的取樣來源，請縮小筆刷或改用修復筆刷', 'error');
    return ok;
  }
}

export class HealingBrushTool extends HealToolBase {
  id = 'heal';
  name = '修復筆刷工具';
  shortcut = 'j';
  icon = 'healSource';
  override options: ToolOption[] = [
    sizeOpt(50), hardnessOpt,
    { key: 'aligned', label: '對齊', type: 'checkbox', default: true },
  ];

  private source: { x: number; y: number } | null = null;
  private offsetFromSource: { dx: number; dy: number } | null = null;

  protected label(): string { return '修復筆刷'; }

  protected override prepare(e: ToolPointer): boolean {
    if (e.alt) {
      this.source = { x: e.x, y: e.y };
      this.offsetFromSource = null;
      e.app.status(`已設定修復來源 (${Math.round(e.x)}, ${Math.round(e.y)})`);
      return false;
    }
    if (!this.source) {
      e.app.toast('請先按住 Alt 點選修復來源', 'error');
      return false;
    }
    const aligned = e.app.toolOptions[this.id]?.aligned !== false;
    if (!aligned || !this.offsetFromSource) {
      this.offsetFromSource = { dx: this.source.x - e.x, dy: this.source.y - e.y };
    }
    return true;
  }

  protected heal(img: ImageData, mask: Uint8Array, e: ToolPointer): boolean {
    if (!this.offsetFromSource) return false;
    healFromSource(
      img, mask,
      Math.round(this.offsetFromSource.dx),
      Math.round(this.offsetFromSource.dy),
    );
    void e;
    return true;
  }

  drawOverlay(o: OverlayPaint): void {
    if (!this.source) return;
    const { ctx, zoom } = o;
    const r = 8 / zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(this.source.x - r, this.source.y);
    ctx.lineTo(this.source.x + r, this.source.y);
    ctx.moveTo(this.source.x, this.source.y - r);
    ctx.lineTo(this.source.x, this.source.y + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.source.x, this.source.y, clamp(r * 0.6, 1, 40), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
