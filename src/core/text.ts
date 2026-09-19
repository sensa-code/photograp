import type { Layer, TextStyle } from './types';
import { createSurface } from './surface';
import { rgbCss } from './color';

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

export const cssFont = (t: TextStyle): string =>
  `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.fontSize}px ${t.fontFamily}`;

export interface TextMetricsResult { width: number; height: number; lines: string[] }

export function measureText(t: TextStyle): TextMetricsResult {
  const probe = createSurface(4, 4);
  probe.ctx.font = cssFont(t);
  const lines = t.text.split('\n');
  let width = 0;
  for (const line of lines) {
    const w = probe.ctx.measureText(line).width + Math.max(0, line.length - 1) * t.letterSpacing;
    if (w > width) width = w;
  }
  return { width, height: lines.length * t.fontSize * t.lineHeight, lines };
}

/**
 * Render a text layer's glyphs into its surface. The layer origin is the text
 * baseline anchor, so moving the layer moves the type block.
 */
export function renderTextLayer(layer: Layer, docW: number, docH: number): void {
  if (!layer.text) return;
  const t = layer.text;
  const surface = createSurface(docW, docH);
  const ctx = surface.ctx;
  ctx.font = cssFont(t);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const { lines, width: blockWidth } = measureText(t);
  const lineH = t.fontSize * t.lineHeight;

  const drawLine = (line: string, x: number, y: number, stroke: boolean): void => {
    if (t.letterSpacing === 0) {
      if (stroke) ctx.strokeText(line, x, y);
      else ctx.fillText(line, x, y);
      return;
    }
    let cx = x;
    for (const ch of line) {
      if (stroke) ctx.strokeText(ch, cx, y);
      else ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + t.letterSpacing;
    }
  };

  lines.forEach((line, i) => {
    const w = ctx.measureText(line).width + Math.max(0, line.length - 1) * t.letterSpacing;
    // Lines are aligned inside the block; the layer origin is the block's
    // top-left corner, so dragging the layer moves the whole type block.
    const x = t.align === 'center' ? (blockWidth - w) / 2 : t.align === 'right' ? blockWidth - w : 0;
    const y = (i + 1) * lineH - lineH * 0.22;
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = rgbCss(t.strokeColor);
      drawLine(line, x, y, true);
    }
    ctx.fillStyle = rgbCss(t.color);
    drawLine(line, x, y, false);
  });

  layer.surface = surface;
}
