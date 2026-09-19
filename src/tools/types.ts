import type { PhotoDoc } from '../core/document';
import type { App } from '../core/app';
import type { RGB } from '../core/color';

export interface ToolPointer {
  app: App;
  doc: PhotoDoc;
  /** Document-space position of the pointer. */
  x: number;
  y: number;
  /** Position at the previous event. */
  px: number;
  py: number;
  /** Position where the drag started. */
  sx: number;
  sy: number;
  /** Raw viewport pixel position, unaffected by pan and zoom. */
  screenX: number;
  screenY: number;
  /** Raw viewport pixel position where the drag started. */
  screenSX: number;
  screenSY: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
  zoom: number;
  /** Intermediate points reported by the browser, oldest first. */
  coalesced?: { x: number; y: number; pressure: number }[];
}

export interface OverlayPaint {
  ctx: CanvasRenderingContext2D;
  zoom: number;
  doc: PhotoDoc;
  app: App;
  /** Current pointer position in document space, or null when outside. */
  cursor: { x: number; y: number } | null;
}

export type ToolOptionType = 'slider' | 'select' | 'checkbox' | 'color' | 'number' | 'segmented' | 'button' | 'label';

export interface ToolOption {
  key: string;
  label: string;
  type: ToolOptionType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: number;
  options?: { value: string; label: string; icon?: string }[];
  default?: number | string | boolean | RGB;
  /** Only show the option when this predicate passes. */
  visible?: (values: Record<string, unknown>) => boolean;
  onClick?: (app: App) => void;
}

export interface Tool {
  id: string;
  name: string;
  /** Single-key shortcut; tools sharing a key cycle with Shift. */
  shortcut: string;
  icon: string;
  /** Tools in the same group stack into one toolbar slot. */
  group: string;
  cursor?: string;
  options: ToolOption[];
  /** Painting tools show a size ring instead of a system cursor. */
  showBrushCursor?: boolean;

  down(e: ToolPointer): void;
  move(e: ToolPointer): void;
  up(e: ToolPointer): void;
  /** Movement with no button pressed. */
  hover?(e: ToolPointer): void;
  drawOverlay?(o: OverlayPaint): void;
  key?(e: KeyboardEvent, app: App): boolean;
  /** Called when switching away or pressing Escape. */
  cancel?(app: App): void;
  doubleClick?(e: ToolPointer): void;
}

export const optionDefaults = (t: Tool): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const o of t.options) {
    if (o.default !== undefined) {
      out[o.key] = typeof o.default === 'object' ? { ...(o.default as RGB) } : o.default;
    }
  }
  return out;
};
