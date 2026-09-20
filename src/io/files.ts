import { PhotoDoc } from '../core/document';
import type { BlendIf, Layer, LayerEffects, SmartFilterEntry } from '../core/types';
import { normalizeBlendIf } from '../core/blend-range';
import { createSurface, type Surface } from '../core/surface';
import { defaultEffects, uid } from '../core/layer';
import { Selection } from '../core/selection';
import { clonePath, type VectorPath } from '../core/path';
import type { AlphaChannel } from '../core/channels';
import { renderSmartLayer } from '../core/smart';
import { renderTextLayer } from '../core/text';
import { warmEmbedded } from '../core/patterns';
import { renderShapeLayer } from '../core/shape';
import type { QuickMask } from '../core/quickmask';
import type { Guide } from '../core/guides';
import { cloneComp, normalizeComp, type LayerComp } from '../core/comps';
import {
  dataUrlToBlob, dataUrlToText, desktopOpen, desktopSaveBinary, desktopSaveText,
  desktopSaveTextAs, isDesktop, type DesktopFile,
} from './desktop';

export const PROJECT_EXT = '.pgraph';
const PROJECT_MAGIC = 'photograp-project';
const PROJECT_VERSION = 5;

export interface OpenedImage { name: string; image: HTMLImageElement }

/**
 * One file to open, however it was chosen. The desktop build hands back a
 * path as well, which is what lets a project save back over itself.
 */
export interface PickedFile {
  name: string;
  path?: string;
  text(): Promise<string>;
  blob(): Promise<Blob>;
}

const fromFile = (f: File): PickedFile => ({
  name: f.name,
  text: () => f.text(),
  blob: () => Promise.resolve(f as Blob),
});

const fromDesktop = (f: DesktopFile): PickedFile => ({
  name: f.name,
  path: f.path,
  text: () => Promise.resolve(dataUrlToText(f.data)),
  blob: () => dataUrlToBlob(f.data),
});

export const pickedFromDesktop = fromDesktop;

/**
 * Ask for files: a native dialog in the desktop build, the browser's file
 * input everywhere else.
 */
export async function pickOpenFiles(
  accept: string, multiple = false, images = false,
): Promise<PickedFile[]> {
  const native = await desktopOpen({ multiple, images });
  if (native) return native.map(fromDesktop);
  return (await pickFiles(accept, multiple)).map(fromFile);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export function loadImageFile(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取影像檔案')); };
    img.src = url;
  });
}

function loadImageSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法解碼圖層資料'));
    img.src = src;
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';

/** Returns false when the user cancelled the save dialog. */
export async function exportDocument(
  doc: PhotoDoc, format: ExportFormat, quality: number, filename?: string,
  background?: string,
): Promise<boolean> {
  const render = doc.render();
  let out = render;
  if (format === 'jpeg' || background) {
    out = createSurface(render.w, render.h);
    out.ctx.fillStyle = background ?? '#ffffff';
    out.ctx.fillRect(0, 0, out.w, out.h);
    out.ctx.drawImage(render.canvas, 0, 0);
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    out.canvas.toBlob(resolve, `image/${format}`, quality));
  if (!blob) throw new Error('匯出失敗');
  const base = (filename ?? doc.meta.name).replace(/\.[^.]+$/, '');
  const ext = format === 'jpeg' ? 'jpg' : format;
  if (isDesktop()) {
    // A native save dialog, so the file lands where the user says rather
    // than in the downloads folder.
    return (await desktopSaveBinary(blob, `${base}.${ext}`, ext)) !== null;
  }
  downloadBlob(blob, `${base}.${ext}`);
  return true;
}

// ---- project serialisation -------------------------------------------------

interface SerializedLayer {
  id: string;
  name: string;
  kind: Layer['kind'];
  visible: boolean;
  locked: boolean;
  opacity: number;
  fill?: number;
  blendIf?: Partial<BlendIf>;
  blend: string;
  x: number;
  y: number;
  clipped: boolean;
  maskEnabled: boolean;
  maskLinked: boolean;
  surface: string | null;
  mask: string | null;
  text?: Layer['text'];
  adjustment?: Layer['adjustment'];
  effects: LayerEffects;
  children?: SerializedLayer[];
  expanded?: boolean;
  smart?: SerializedSmart;
  shape?: Layer['shape'];
}

interface SerializedSmart {
  source: string;
  sourceWidth: number;
  sourceHeight: number;
  cx: number;
  cy: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  filters: SmartFilterEntry[];
}

interface SerializedQuickMask {
  surface: string;
  color: { r: number; g: number; b: number };
  opacity: number;
  showMaskedAreas: boolean;
}

interface SerializedChannel {
  id: string;
  name: string;
  surface: string;
  color: { r: number; g: number; b: number };
  opacity: number;
  visible: boolean;
}

interface SerializedDoc {
  magic: string;
  version: number;
  name: string;
  width: number;
  height: number;
  dpi: number;
  activeLayerId: string | null;
  selection: string | null;
  layers: SerializedLayer[];
  paths?: VectorPath[];
  activePathId?: string | null;
  channels?: SerializedChannel[];
  quickMask?: SerializedQuickMask | null;
  guides?: Guide[];
  guidesLocked?: boolean;
  comps?: LayerComp[];
}

const encode = (s: Surface | null): string | null => (s ? s.canvas.toDataURL('image/png') : null);

function serializeLayer(l: Layer): SerializedLayer {
  return {
    id: l.id, name: l.name, kind: l.kind, visible: l.visible, locked: l.locked,
    opacity: l.opacity, fill: l.fill, blendIf: l.blendIf,
    blend: l.blend, x: l.x, y: l.y, clipped: l.clipped,
    maskEnabled: l.maskEnabled, maskLinked: l.maskLinked,
    surface: encode(l.surface), mask: encode(l.mask),
    text: l.text, adjustment: l.adjustment, effects: l.effects,
    expanded: l.expanded,
    children: l.children?.map(serializeLayer),
    smart: l.smart
      ? {
        source: l.smart.source.canvas.toDataURL('image/png'),
        sourceWidth: l.smart.sourceWidth,
        sourceHeight: l.smart.sourceHeight,
        cx: l.smart.cx,
        cy: l.smart.cy,
        scaleX: l.smart.scaleX,
        scaleY: l.smart.scaleY,
        angle: l.smart.angle,
        filters: l.smart.filters,
      }
      : undefined,
    // Shape geometry is plain data, so it serialises as-is.
    shape: l.shape
      ? JSON.parse(JSON.stringify(l.shape)) as Layer['shape']
      : undefined,
  };
}

/** Selection masks compress well as a PNG alpha channel. */
function encodeSelection(sel: Selection): string | null {
  if (!sel.mask) return null;
  const s = createSurface(sel.width, sel.height);
  const img = s.ctx.createImageData(sel.width, sel.height);
  for (let i = 0, p = 0; i < sel.mask.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
    img.data[p + 3] = sel.mask[i];
  }
  s.ctx.putImageData(img, 0, 0);
  return s.canvas.toDataURL('image/png');
}

export function serializeDocument(doc: PhotoDoc): string {
  const out: SerializedDoc = {
    magic: PROJECT_MAGIC,
    version: PROJECT_VERSION,
    name: doc.meta.name,
    width: doc.width,
    height: doc.height,
    dpi: doc.meta.dpi,
    activeLayerId: doc.activeLayerId,
    selection: encodeSelection(doc.selection),
    layers: doc.layers.map(serializeLayer),
    paths: doc.paths.map(clonePath),
    activePathId: doc.activePathId,
    channels: doc.channels.map((c) => ({
      id: c.id,
      name: c.name,
      surface: c.surface.canvas.toDataURL('image/png'),
      color: { ...c.color },
      opacity: c.opacity,
      visible: c.visible,
    })),
    quickMask: doc.quickMask
      ? {
        surface: doc.quickMask.surface.canvas.toDataURL('image/png'),
        color: { ...doc.quickMask.color },
        opacity: doc.quickMask.opacity,
        showMaskedAreas: doc.quickMask.showMaskedAreas,
      }
      : null,
    guides: doc.guides.map((g) => ({ ...g })),
    guidesLocked: doc.guidesLocked,
    comps: doc.comps.map(cloneComp),
  };
  return JSON.stringify(out);
}

/**
 * Save the project. On the desktop a document that came from disk saves back
 * over itself unless `saveAs` is set; in the browser every save is a download.
 * Returns false when the user cancelled.
 */
export async function saveProject(doc: PhotoDoc, saveAs = false): Promise<boolean> {
  const json = serializeDocument(doc);
  const base = doc.meta.name.replace(/\.[^.]+$/, '');
  const ext = PROJECT_EXT.slice(1);
  if (isDesktop()) {
    const saved = saveAs
      ? await desktopSaveTextAs(json, `${base}${PROJECT_EXT}`, ext)
      : await desktopSaveText(json, `${base}${PROJECT_EXT}`, ext, doc.meta.filePath);
    if (!saved) return false;
    doc.meta.filePath = saved.path;
    doc.meta.name = saved.name;
    doc.savedRevision = doc.revision;
    return true;
  }
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `${base}${PROJECT_EXT}`);
  doc.savedRevision = doc.revision;
  return true;
}

async function deserializeLayer(s: SerializedLayer, w: number, h: number): Promise<Layer> {
  const decode = async (data: string | null): Promise<Surface | null> => {
    if (!data) return null;
    const img = await loadImageSrc(data);
    const surf = createSurface(w, h);
    surf.ctx.drawImage(img, 0, 0);
    return surf;
  };
  const children = s.children ? await Promise.all(s.children.map((c) => deserializeLayer(c, w, h))) : undefined;
  let smart: Layer['smart'];
  if (s.smart) {
    const img = await loadImageSrc(s.smart.source);
    const source = createSurface(s.smart.sourceWidth, s.smart.sourceHeight);
    source.ctx.drawImage(img, 0, 0);
    smart = {
      source,
      sourceWidth: s.smart.sourceWidth,
      sourceHeight: s.smart.sourceHeight,
      cx: s.smart.cx,
      cy: s.smart.cy,
      scaleX: s.smart.scaleX,
      scaleY: s.smart.scaleY,
      angle: s.smart.angle,
      filters: s.smart.filters ?? [],
    };
  }
  return {
    id: s.id || uid(),
    name: s.name,
    kind: s.kind,
    visible: s.visible,
    locked: s.locked,
    opacity: s.opacity,
    // Projects saved before advanced blending simply have neither.
    fill: typeof s.fill === 'number' ? s.fill : 1,
    blendIf: normalizeBlendIf(s.blendIf),
    blend: s.blend as Layer['blend'],
    x: s.x,
    y: s.y,
    clipped: s.clipped,
    maskEnabled: s.maskEnabled ?? true,
    maskLinked: s.maskLinked ?? true,
    surface: await decode(s.surface),
    mask: await decode(s.mask),
    text: s.text,
    adjustment: s.adjustment,
    // Merge so a project saved before an effect existed still loads.
    effects: { ...defaultEffects(), ...(s.effects ?? {}) },
    expanded: s.expanded ?? true,
    children,
    smart,
    shape: s.shape ? JSON.parse(JSON.stringify(s.shape)) as Layer['shape'] : undefined,
  };
}

export async function loadProject(text: string): Promise<PhotoDoc> {
  const data = JSON.parse(text) as SerializedDoc;
  if (data.magic !== PROJECT_MAGIC) throw new Error('不是有效的 Photograp 專案檔');
  const doc = new PhotoDoc(data.name, data.width, data.height, data.dpi ?? 72);
  doc.layers = await Promise.all(data.layers.map((l) => deserializeLayer(l, data.width, data.height)));
  doc.activeLayerId = data.activeLayerId ?? doc.layers[doc.layers.length - 1]?.id ?? null;
  doc.paths = (data.paths ?? []).map(clonePath);
  doc.activePathId = data.activePathId ?? doc.paths[doc.paths.length - 1]?.id ?? null;
  doc.channels = await Promise.all((data.channels ?? []).map(async (c): Promise<AlphaChannel> => {
    const img = await loadImageSrc(c.surface);
    const surface = createSurface(data.width, data.height);
    surface.ctx.drawImage(img, 0, 0);
    return { id: c.id, name: c.name, surface, color: c.color, opacity: c.opacity, visible: c.visible };
  }));
  doc.guides = (data.guides ?? []).map((g) => ({ ...g }));
  doc.guidesLocked = data.guidesLocked ?? false;
  doc.comps = (data.comps ?? [])
    .map(normalizeComp)
    .filter((c): c is LayerComp => c !== null);
  if (data.quickMask) {
    const img = await loadImageSrc(data.quickMask.surface);
    const surface = createSurface(data.width, data.height);
    surface.ctx.drawImage(img, 0, 0);
    const qm: QuickMask = {
      surface,
      color: data.quickMask.color,
      opacity: data.quickMask.opacity,
      showMaskedAreas: data.quickMask.showMaskedAreas,
    };
    doc.quickMask = qm;
  }
  // An overlay can carry its own pattern tile; decode those before the first
  // composite, or the effect would quietly draw nothing.
  await warmEmbedded(doc.allLayers().map((l) => l.effects.overlay));

  // Generated pixels are not stored; rebuild them from the saved data.
  for (const l of doc.allLayers()) {
    if (l.kind === 'smart' && l.smart) renderSmartLayer(l, doc.width, doc.height);
    else if (l.kind === 'shape' && l.shape) renderShapeLayer(l, doc.width, doc.height);
    else if (l.kind === 'text' && l.text?.onPath) {
      renderTextLayer(l, doc.width, doc.height, doc.paths);
    }
  }
  if (data.selection) {
    const img = await loadImageSrc(data.selection);
    const s = createSurface(data.width, data.height);
    s.ctx.drawImage(img, 0, 0);
    const d = s.ctx.getImageData(0, 0, data.width, data.height).data;
    const mask = new Uint8Array(data.width * data.height);
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) mask[i] = d[p];
    doc.selection.mask = mask;
    doc.selection.invalidate();
  }
  doc.history.commit(doc, '開啟專案');
  doc.savedRevision = doc.revision;
  return doc;
}

/** Copy the flattened document (or the active layer) to the system clipboard. */
export async function copyToClipboard(surface: Surface): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => surface.canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('無法建立影像');
  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}
