import type { Layer, TextPathBinding, TextStyle } from './types';
import { createSurface } from './surface';
import { rgbCss } from './color';
import { flattenPath, pathPointAt, type FlatPath, type VectorPath } from './path';

export const FONT_STACKS: { value: string; label: string }[] = [
  { value: '"Noto Sans TC", "Microsoft JhengHei", sans-serif', label: '思源黑體 / 微軟正黑' },
  { value: '"Noto Serif TC", "Microsoft JhengHei", serif', label: '思源宋體' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
  { value: 'Georgia, "Times New Roman", serif', label: 'Georgia' },
  { value: '"Courier New", monospace', label: 'Courier New' },
  { value: 'Impact, "Arial Black", sans-serif', label: 'Impact' },
  { value: '"Comic Sans MS", cursive', label: 'Comic Sans MS' },
];

export const defaultTextStyle = (): TextStyle => ({
  text: '',
  fontFamily: FONT_STACKS[0].value,
  fontSize: 48,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
  align: 'left',
  lineHeight: 1.25,
  letterSpacing: 0,
  strokeWidth: 0,
  strokeColor: { r: 255, g: 255, b: 255 },
});

export const defaultPathBinding = (pathId: string): TextPathBinding =>
  ({ pathId, offset: 0, baselineShift: 0, flip: false });

export const cssFont = (t: TextStyle): string =>
  `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.fontSize}px ${t.fontFamily}`;

/**
 * Whether a line may break between these two characters. Latin text breaks at
 * spaces; CJK has no spaces, so it may break between any two ideographs, but
 * not before a closing bracket or a full stop.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60]/;
const NO_BREAK_BEFORE = /^[\u3001\u3002\uff0c\uff0e\uff1a\uff1b\uff1f\uff01\u300d\u300f\uff09\uff3d\u3011.,:;?!)\]}\u2019\u201d]/;
const NO_BREAK_AFTER = /[\u300c\u300e\uff08\uff3b\u3010([{\u2018\u201c]$/;

function canBreakBetween(before: string, after: string): boolean {
  if (!before || !after) return false;
  if (NO_BREAK_BEFORE.test(after)) return false;
  if (NO_BREAK_AFTER.test(before)) return false;
  if (before === ' ') return true;
  return CJK.test(before) || CJK.test(after);
}

/** Advance width of a run, including the tracking between its characters. */
function runWidth(ctx: CanvasRenderingContext2D, run: string, letterSpacing: number): number {
  if (!run) return 0;
  return ctx.measureText(run).width + Math.max(0, [...run].length - 1) * letterSpacing;
}

/** A wrapped line, and whether it is the one that closes its paragraph. */
export interface WrappedLine { text: string; endsParagraph: boolean }

/**
 * Break `text` into lines that fit `maxWidth`. Explicit newlines always break;
 * a word longer than the whole line is split rather than allowed to overflow.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number, letterSpacing: number,
): WrappedLine[] {
  const out: WrappedLine[] = [];
  for (const paragraph of text.split('\n')) {
    const chars = [...paragraph];
    if (!chars.length) { out.push({ text: '', endsParagraph: true }); continue; }
    let line = '';
    let lastBreak = -1;
    for (let i = 0; i < chars.length; i++) {
      const next = line + chars[i];
      if (canBreakBetween(chars[i - 1] ?? '', chars[i])) lastBreak = line.length;
      // A space at the end of a line hangs past the margin instead of
      // pushing the word before it down, which is how text is set.
      if (chars[i] === ' ' || runWidth(ctx, next, letterSpacing) <= maxWidth || line === '') {
        line = next;
        continue;
      }
      if (lastBreak > 0) {
        // Push back to the last opportunity and carry the rest to the next line.
        out.push({ text: line.slice(0, lastBreak).replace(/ +$/, ''), endsParagraph: false });
        line = line.slice(lastBreak) + chars[i];
      } else {
        // Nowhere to break: a single long word, so split it mid-word.
        out.push({ text: line, endsParagraph: false });
        line = chars[i];
      }
      lastBreak = -1;
    }
    // The run that reaches the end of the paragraph is never stretched.
    out.push({ text: line, endsParagraph: true });
  }
  return out;
}

export function wrapText(
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number, letterSpacing: number,
): string[] {
  return wrapLines(ctx, text, maxWidth, letterSpacing).map((l) => l.text);
}

export interface TextMetricsResult { width: number; height: number; lines: string[] }

export function measureText(t: TextStyle): TextMetricsResult {
  const probe = createSurface(4, 4);
  probe.ctx.font = cssFont(t);
  const lines = t.box
    ? wrapText(probe.ctx, t.text, t.box.w, t.letterSpacing)
    : t.text.split('\n');
  let width = t.box ? t.box.w : 0;
  for (const line of lines) {
    const w = runWidth(probe.ctx, line, t.letterSpacing);
    if (w > width) width = w;
  }
  return { width, height: lines.length * t.fontSize * t.lineHeight, lines };
}

/** How many lines of a boxed layer fall outside its box. */
export function overflowLines(t: TextStyle): number {
  if (!t.box) return 0;
  const { lines } = measureText(t);
  const fits = Math.max(0, Math.floor(t.box.h / (t.fontSize * t.lineHeight)));
  return Math.max(0, lines.length - fits);
}

/** One glyph with the advance width it occupies along the baseline. */
interface Glyph { ch: string; width: number }

/**
 * Split the run into glyphs with their advances. Newlines collapse to spaces:
 * a curve has one baseline, so a second line has nowhere to go.
 */
function pathGlyphs(ctx: CanvasRenderingContext2D, t: TextStyle): Glyph[] {
  const out: Glyph[] = [];
  for (const ch of t.text.replace(/\n/g, ' ')) {
    out.push({ ch, width: ctx.measureText(ch).width + t.letterSpacing });
  }
  return out;
}

/** The subpath the binding points at: the longest one in that path. */
function boundFlatPath(paths: VectorPath[], bind: TextPathBinding): FlatPath | null {
  const path = paths.find((x) => x.id === bind.pathId);
  if (!path) return null;
  return flattenPath(path)[0] ?? null;
}

/**
 * Lay the run along `flat`. Each glyph is placed at the middle of its own
 * advance and rotated to the tangent there, which keeps letters upright
 * through a curve instead of shearing the whole run.
 */
function drawOnPath(
  ctx: CanvasRenderingContext2D, t: TextStyle, flat: FlatPath, bind: TextPathBinding,
  stroke: boolean,
): void {
  const glyphs = pathGlyphs(ctx, t);
  const run = glyphs.reduce((n, g) => n + g.width, 0);
  const slack = flat.length - run;
  const start = (t.align === 'center' ? slack / 2 : t.align === 'right' ? slack : 0) + bind.offset;
  // Rotating a flipped glyph by pi already swaps which screen direction is
  // "up", so one sign works for both: positive always moves away from the curve.
  const shift = bind.baselineShift;

  let acc = 0;
  for (const g of glyphs) {
    const mid = start + acc + g.width / 2;
    acc += g.width;
    if (g.ch === ' ') continue;
    const at = pathPointAt(flat, bind.flip ? start + (run - (acc - g.width / 2)) : mid);
    if (!at) continue;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(at.angle + (bind.flip ? Math.PI : 0));
    if (stroke) ctx.strokeText(g.ch, -g.width / 2, -shift);
    else ctx.fillText(g.ch, -g.width / 2, -shift);
    ctx.restore();
  }
}

/**
 * Render a text layer's glyphs into its surface. The layer origin is the text
 * baseline anchor, so moving the layer moves the type block. Type bound to a
 * path takes its position from the path instead, so the layer sits at 0,0.
 */
export function renderTextLayer(
  layer: Layer, docW: number, docH: number, paths: VectorPath[] = [],
): void {
  if (!layer.text) return;
  const t = layer.text;
  const surface = createSurface(docW, docH);
  const ctx = surface.ctx;
  ctx.font = cssFont(t);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const bound = t.onPath ? boundFlatPath(paths, t.onPath) : null;
  if (t.onPath && bound) {
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = rgbCss(t.strokeColor);
      drawOnPath(ctx, t, bound, t.onPath, true);
    }
    ctx.fillStyle = rgbCss(t.color);
    drawOnPath(ctx, t, bound, t.onPath, false);
    layer.surface = surface;
    // The glyph positions already carry the path's own document coordinates.
    layer.x = 0;
    layer.y = 0;
    return;
  }

  const box = t.box ?? null;
  // Paragraph type wraps into a fixed frame; point type runs on as written.
  // Either way the lines are laid out from the surface origin and the layer
  // offset positions the block, so dragging moves the type rather than
  // reflowing it.
  const lines: WrappedLine[] = box
    ? wrapLines(ctx, t.text, box.w, t.letterSpacing)
    : t.text.split('\n').map((text) => ({ text, endsParagraph: true }));
  const blockWidth = box ? box.w : measureText(t).width;
  const lineH = t.fontSize * t.lineHeight;

  if (box) {
    // Whatever does not fit is hidden, exactly as a type frame does it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, box.w, box.h);
    ctx.clip();
  }

  /** Draw one line, spreading `extra` px over the gaps between characters. */
  const drawLine = (
    line: string, x: number, y: number, stroke: boolean, extra: number,
  ): void => {
    if (t.letterSpacing === 0 && extra === 0) {
      if (stroke) ctx.strokeText(line, x, y);
      else ctx.fillText(line, x, y);
      return;
    }
    const chars = [...line];
    // With a single character there is no gap to stretch.
    const pad = chars.length > 1 ? extra / (chars.length - 1) : 0;
    let cx = x;
    for (const ch of chars) {
      if (stroke) ctx.strokeText(ch, cx, y);
      else ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + t.letterSpacing + pad;
    }
  };

  lines.forEach((line, i) => {
    const y = (i + 1) * lineH - lineH * 0.22;
    // Skip the lines the frame has already cut off.
    if (box && y - lineH >= box.h) return;
    const w = runWidth(ctx, line.text, t.letterSpacing);
    let x = 0;
    let extra = 0;
    if (t.align === 'center') x = (blockWidth - w) / 2;
    else if (t.align === 'right') x = blockWidth - w;
    // Justification needs a frame to justify to, and the line that closes a
    // paragraph keeps its natural width.
    else if (t.align === 'justify' && box && !line.endsParagraph) {
      extra = Math.max(0, blockWidth - w);
    }
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = rgbCss(t.strokeColor);
      drawLine(line.text, x, y, true, extra);
    }
    ctx.fillStyle = rgbCss(t.color);
    drawLine(line.text, x, y, false, extra);
  });

  if (box) ctx.restore();
  layer.surface = surface;
}
