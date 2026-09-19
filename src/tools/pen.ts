import type { App } from '../core/app';
import type { PhotoDoc } from '../core/document';
import type { Point } from '../core/geometry';
import {
  anchorCount, createAnchor, createPath, hitTest, moveAnchor, moveHandle,
  previewPath2D, toPath2D, type Anchor, type AnchorHit, type SubPath, type VectorPath,
} from '../core/path';
import { renderShapeLayer } from '../core/shape';
import type { OverlayPaint, Tool, ToolOption, ToolPointer } from './types';

/** Screen-space hit tolerance converted to document units. */
const tol = (zoom: number): number => 7 / zoom;

/**
 * The path the vector tools should act on: a selected shape layer's own
 * geometry if there is one, otherwise the document's work path. This is
 * what makes a drawn shape stay re-editable.
 */
function editablePath(doc: PhotoDoc): { path: VectorPath; shapeLayer: boolean } | null {
  const layer = doc.activeLayer();
  if (layer?.kind === 'shape' && layer.shape && !layer.locked) {
    return { path: layer.shape.path, shapeLayer: true };
  }
  const path = doc.activePath();
  return path ? { path, shapeLayer: false } : null;
}

/** Re-render after geometry changed, so a shape layer shows the edit. */
function afterEdit(doc: PhotoDoc): void {
  const layer = doc.activeLayer();
  if (layer?.kind === 'shape' && layer.shape) renderShapeLayer(layer, doc.width, doc.height);
  const path = doc.activePath();
  if (path) doc.refreshTextOnPath(path.id);
}

function ensurePath(doc: PhotoDoc): VectorPath {
  let path = doc.activePath();
  if (!path) {
    path = createPath('工作路徑');
    doc.setPath(path);
  }
  return path;
}

/** Draw a vector path with its anchors and handles onto the canvas overlay. */
export function drawPathOverlay(
  ctx: CanvasRenderingContext2D, path: VectorPath, zoom: number,
  opts: { anchors?: boolean; selected?: AnchorHit | null; preview?: Path2D | null } = {},
): void {
  ctx.save();
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([]);

  const outline = toPath2D(path);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.stroke(outline);
  ctx.strokeStyle = '#7fd0ff';
  ctx.stroke(outline);

  if (opts.preview) {
    ctx.strokeStyle = 'rgba(127,208,255,0.75)';
    ctx.stroke(opts.preview);
  }

  if (opts.anchors) {
    const r = 3 / zoom;
    for (let s = 0; s < path.subpaths.length; s++) {
      for (let i = 0; i < path.subpaths[s].anchors.length; i++) {
        const a = path.subpaths[s].anchors[i];
        const isSelected = opts.selected?.subpath === s && opts.selected?.anchor === i;

        if (a.inX !== a.x || a.inY !== a.y || a.outX !== a.x || a.outY !== a.y) {
          ctx.strokeStyle = 'rgba(127,208,255,0.9)';
          ctx.beginPath();
          ctx.moveTo(a.inX, a.inY);
          ctx.lineTo(a.x, a.y);
          ctx.lineTo(a.outX, a.outY);
          ctx.stroke();
          ctx.fillStyle = '#7fd0ff';
          for (const h of [[a.inX, a.inY], [a.outX, a.outY]] as const) {
            ctx.beginPath();
            ctx.arc(h[0], h[1], r * 0.85, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.fillStyle = isSelected ? '#ffd24d' : '#ffffff';
        ctx.strokeStyle = '#1b4a6e';
        if (a.smooth) {
          ctx.beginPath();
          ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(a.x - r, a.y - r, r * 2, r * 2);
          ctx.strokeRect(a.x - r, a.y - r, r * 2, r * 2);
        }
      }
    }
  }
  ctx.restore();
}

export class PenTool implements Tool {
  id = 'pen';
  name = '筆型工具';
  shortcut = 'p';
  icon = 'pen';
  group = 'vector';
  cursor = 'crosshair';
  options: ToolOption[] = [
    { key: 'rubberBand', label: '顯示橡皮筋', type: 'checkbox', default: true },
    { key: 'autoSmooth', label: '拖曳建立平滑點', type: 'checkbox', default: true },
  ];

  private dragAnchor: Anchor | null = null;
  private cursor2: Point | null = null;

  /** The subpath currently being extended, if any. */
  private openSubpath(path: VectorPath): SubPath | null {
    const last = path.subpaths[path.subpaths.length - 1];
    return last && !last.closed ? last : null;
  }

  down(e: ToolPointer): void {
    const path = ensurePath(e.doc);
    const t = tol(e.zoom);
    let sp = this.openSubpath(path);

    // Alt-click an existing anchor toggles between smooth and corner.
    if (e.alt) {
      const hit = hitTest(path, e, t);
      if (hit && hit.part === 'point') {
        const a = path.subpaths[hit.subpath].anchors[hit.anchor];
        a.smooth = !a.smooth;
        if (!a.smooth) { a.inX = a.x; a.inY = a.y; a.outX = a.x; a.outY = a.y; }
        e.doc.commit('轉換控制點');
        e.app.changed();
        return;
      }
    }

    // Clicking the first anchor closes the subpath.
    if (sp && sp.anchors.length >= 2) {
      const first = sp.anchors[0];
      if (Math.hypot(first.x - e.x, first.y - e.y) <= t) {
        sp.closed = true;
        e.doc.commit('封閉路徑');
        e.app.changed();
        return;
      }
    }

    if (!sp) {
      sp = { anchors: [], closed: false };
      path.subpaths.push(sp);
    }
    const anchor = createAnchor(e.x, e.y);
    sp.anchors.push(anchor);
    this.dragAnchor = anchor;
    e.doc.touch();
    e.app.changed();
  }

  move(e: ToolPointer): void {
    this.cursor2 = { x: e.x, y: e.y };
    if (!this.dragAnchor) { e.app.changed(); return; }
    if (e.app.toolOptions[this.id]?.autoSmooth === false) return;
    const a = this.dragAnchor;
    if (Math.hypot(e.x - a.x, e.y - a.y) < 1.5 / e.zoom) return;
    a.smooth = true;
    moveHandle(a, 'out', e.x, e.y, true);
    e.doc.touch();
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (!this.dragAnchor) return;
    this.dragAnchor = null;
    const path = e.doc.activePath();
    e.doc.commit(path && anchorCount(path) === 1 ? '建立路徑' : '增加控制點');
    e.app.changed();
  }

  hover(e: ToolPointer): void {
    this.cursor2 = { x: e.x, y: e.y };
    e.app.changed();
  }

  key(ev: KeyboardEvent, app: App): boolean {
    const doc = app.activeDoc();
    const path = doc?.activePath();
    if (!doc || !path) return false;
    const sp = this.openSubpath(path);
    if (ev.key === 'Enter' && sp) {
      // Enter ends the subpath without closing it.
      if (sp.anchors.length < 2) path.subpaths.pop();
      doc.commit('結束路徑');
      app.changed();
      return true;
    }
    if (ev.key === 'Backspace' && sp && sp.anchors.length) {
      sp.anchors.pop();
      if (!sp.anchors.length) path.subpaths.pop();
      doc.commit('刪除控制點');
      app.changed();
      return true;
    }
    return false;
  }

  drawOverlay(o: OverlayPaint): void {
    const path = o.doc.activePath();
    if (!path) return;
    const sp = this.openSubpath(path);
    const rubber = o.app.toolOptions[this.id]?.rubberBand !== false;
    const preview = sp && sp.anchors.length && rubber && this.cursor2 && !this.dragAnchor
      ? previewPath2D(sp, this.cursor2, null)
      : null;
    drawPathOverlay(o.ctx, path, o.zoom, { anchors: true, preview });
  }

  cancel(app: App): void {
    const doc = app.activeDoc();
    const path = doc?.activePath();
    if (!doc || !path) return;
    const sp = this.openSubpath(path);
    if (sp) {
      path.subpaths.pop();
      if (!path.subpaths.length) {
        doc.paths = doc.paths.filter((p) => p.id !== path.id);
        doc.activePathId = doc.paths[doc.paths.length - 1]?.id ?? null;
      }
      doc.commit('取消路徑');
    }
    this.dragAnchor = null;
    app.changed();
  }
}

export class DirectSelectTool implements Tool {
  id = 'direct-select';
  name = '直接選取工具';
  shortcut = 'a';
  icon = 'arrow';
  group = 'vector';
  cursor = 'default';
  options: ToolOption[] = [
    { key: 'mirror', label: '平滑點連動控制桿', type: 'checkbox', default: true },
  ];

  selected: AnchorHit | null = null;
  private dragging = false;
  private moved = false;

  down(e: ToolPointer): void {
    const target = editablePath(e.doc);
    if (!target) return;
    this.selected = hitTest(target.path, e, tol(e.zoom));
    this.dragging = this.selected !== null;
    this.moved = false;
    e.app.changed();
  }

  move(e: ToolPointer): void {
    if (!this.dragging || !this.selected) return;
    const path = editablePath(e.doc)?.path;
    if (!path) return;
    const a = path.subpaths[this.selected.subpath]?.anchors[this.selected.anchor];
    if (!a) return;
    const mirror = e.app.toolOptions[this.id]?.mirror !== false && !e.alt;
    if (this.selected.part === 'point') moveAnchor(a, e.x, e.y);
    else moveHandle(a, this.selected.part, e.x, e.y, mirror);
    this.moved = true;
    afterEdit(e.doc);
    e.doc.touch();
    e.app.changed();
  }

  up(e: ToolPointer): void {
    if (this.dragging && this.moved) {
      afterEdit(e.doc);
      e.doc.commit('編輯路徑');
    }
    this.dragging = false;
    e.app.changed();
  }

  key(ev: KeyboardEvent, app: App): boolean {
    const doc = app.activeDoc();
    const path = doc ? editablePath(doc)?.path : null;
    if (!doc || !path || !this.selected) return false;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const sp = path.subpaths[this.selected.subpath];
      if (!sp) return false;
      sp.anchors.splice(this.selected.anchor, 1);
      if (sp.anchors.length < 2) path.subpaths.splice(this.selected.subpath, 1);
      this.selected = null;
      afterEdit(doc);
      doc.commit('刪除控制點');
      app.changed();
      return true;
    }
    const step = ev.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const d = delta[ev.key];
    if (d) {
      const a = path.subpaths[this.selected.subpath]?.anchors[this.selected.anchor];
      if (a) {
        moveAnchor(a, a.x + d[0], a.y + d[1]);
        afterEdit(doc);
        doc.commit('移動控制點');
        app.changed();
      }
      return true;
    }
    return false;
  }

  drawOverlay(o: OverlayPaint): void {
    const path = editablePath(o.doc)?.path;
    if (!path) return;
    drawPathOverlay(o.ctx, path, o.zoom, { anchors: true, selected: this.selected });
  }

  cancel(app: App): void {
    this.selected = null;
    this.dragging = false;
    app.changed();
  }
}
