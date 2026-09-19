/**
 * A Surface is a raster buffer backed by a canvas. Layers, masks and scratch
 * buffers are all Surfaces so they can be drawn with the 2D pipeline.
 */
export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export function createSurface(w: number, h: number): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  return { canvas, ctx, w: canvas.width, h: canvas.height };
}

export function cloneSurface(src: Surface): Surface {
  const s = createSurface(src.w, src.h);
  s.ctx.drawImage(src.canvas, 0, 0);
  return s;
}

export function clearSurface(s: Surface): void {
  s.ctx.clearRect(0, 0, s.w, s.h);
}

export function surfaceFromImage(img: CanvasImageSource, w: number, h: number): Surface {
  const s = createSurface(w, h);
  s.ctx.drawImage(img, 0, 0, w, h);
  return s;
}

export function fillSurface(s: Surface, style: string): void {
  s.ctx.save();
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.fillStyle = style;
  s.ctx.fillRect(0, 0, s.w, s.h);
  s.ctx.restore();
}

export function getImageData(s: Surface): ImageData {
  return s.ctx.getImageData(0, 0, s.w, s.h);
}

export function putImageData(s: Surface, data: ImageData): void {
  s.ctx.putImageData(data, 0, 0);
}

/** Resize a surface's contents into a new surface of the given size. */
export function resampleSurface(
  src: Surface, w: number, h: number, smooth = true, quality: ImageSmoothingQuality = 'high',
): Surface {
  const out = createSurface(w, h);
  out.ctx.imageSmoothingEnabled = smooth;
  out.ctx.imageSmoothingQuality = quality;
  out.ctx.drawImage(src.canvas, 0, 0, src.w, src.h, 0, 0, w, h);
  return out;
}

/** Copy a sub-rect of a surface into a new surface. */
export function cropSurface(src: Surface, x: number, y: number, w: number, h: number): Surface {
  const out = createSurface(w, h);
  out.ctx.drawImage(src.canvas, -x, -y);
  return out;
}

/** Bounding box of non-transparent pixels, or null if fully transparent. */
export function opaqueBounds(s: Surface): { x: number; y: number; w: number; h: number } | null {
  const d = s.ctx.getImageData(0, 0, s.w, s.h).data;
  let minX = s.w, minY = s.h, maxX = -1, maxY = -1;
  for (let y = 0; y < s.h; y++) {
    const row = y * s.w * 4;
    for (let x = 0; x < s.w; x++) {
      if (d[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
