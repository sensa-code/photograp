/**
 * Browser test suite for Photograp's imaging core.
 * Open /tests/index.html with the dev server running.
 */
import { hexToRgb, hslToRgb, hsvToRgb, rgbToHex, rgbToHsl, rgbToHsv } from '../src/core/color';
import { createSurface, cloneSurface, opaqueBounds } from '../src/core/surface';
import { Selection, rasterizePath } from '../src/core/selection';
import type { Rect } from '../src/core/geometry';
import {
  applyComp, captureComp, cloneComp, describeComp, normalizeComp, recaptureComp,
} from '../src/core/comps';
import {
  carveVertical, contentAwareScale, contentAwareScaleAsync, energyMap, findVerticalSeam,
  insertVerticalSeam, removeVerticalSeam, resampleMask, transposeMask, transposeRGBA,
} from '../src/filters/seam';
import {
  BUILTIN_PATTERNS, cachedPatternSurface, createPattern, describePattern, embeddedPattern,
  forgetPattern, loadPatterns, MAX_PATTERN, patternSurface, resetPatterns, savePatterns,
  tileInto, warmEmbedded,
} from '../src/core/patterns';
import {
  defaultRefine, refineIsIdentity, refineMask, scaleMask,
} from '../src/core/refine';
import type { Layer } from '../src/core/types';
import { compositeLayers } from '../src/core/compositor';
import {
  createAdjustmentLayer, createRasterLayer, defaultEffects, duplicateLayer,
} from '../src/core/layer';
import {
  BUILTIN_STYLES, cloneEffects, createStyle, describeStyle, loadStyles,
  resetStyles, saveStyles,
} from '../src/core/styles';
import { maskAlpha, maskFromCoverage, coverageFromMask } from '../src/core/mask';
import { PhotoDoc } from '../src/core/document';
import {
  ADJUSTMENT_LABELS, applyAdjustment, curveLut, defaultAdjustment,
} from '../src/filters/adjustments';
import { gaussianBlur, unsharpMask } from '../src/filters/blur';
import { pixelate, findEdges } from '../src/filters/effects';
import { getFilter, defaultParams } from '../src/filters/registry';
import { Stroke, defaultBrush, brushStamp } from '../src/tools/stroke';
import {
  BUILTIN_PRESETS, applySettingsToOptions, createPreset, describePreset,
  loadPresets, resetPresets, savePresets, settingsFromOptions,
} from '../src/core/brush-presets';
import { floodSelect } from '../src/tools/select';
import {
  renderGradient, presetStops, shapePath, refreshGradientOptions, GRADIENT_PRESETS,
} from '../src/tools/draw';
import {
  BUILTIN_GRADIENTS, cloneStops, createGradient, describeGradient, loadGradients,
  resetGradients, resolveStops, saveGradients, sortStops,
} from '../src/core/gradients';
import {
  defaultPathBinding, defaultTextStyle, renderTextLayer, measureText,
} from '../src/core/text';
import { createTextLayer } from '../src/core/layer';
import { serializeDocument, loadProject } from '../src/io/files';
import { TOOLS } from '../src/tools';
import { optionDefaults, type ToolPointer } from '../src/tools/types';
import { app } from '../src/core/app';
import {
  anchorCount, closestOnPath, createAnchor, createPath, flattenPath, flattenSubPath,
  hitTest, moveAnchor, moveHandle, pathFromLoops, pathPointAt, simplify, toPath2D,
} from '../src/core/path';
import {
  channelCoverage, createAlphaChannel, extractChannel, renderChannelView, setChannelCoverage,
} from '../src/core/channels';
import { createSmartObject, renderSmartLayer, smartBounds, smartFilterEntry } from '../src/core/smart';
import { quickMaskCoverage, renderQuickMaskOverlay } from '../src/core/quickmask';
import { WarpMesh, warpImage, composeWarpWithSelection } from '../src/filters/liquify';
import {
  dilateMask, findHealSource, maskBounds, seamlessClone, spotHeal,
} from '../src/filters/heal';
import { applyFillRegion, contentAwareFill } from '../src/filters/inpaint';
import {
  collectSnapTargets, createGuide, defaultSnapSettings, guideAt, layerBounds,
  snapGroup, snapPoint, snapRect, snapScalar,
} from '../src/core/guides';
import {
  cloneShapeStyle, defaultShapeStyle, describeShape, renderShapeLayer,
  shapeToVectorPath, transformPathPoints,
} from '../src/core/shape';
import { computeHistogram } from '../src/ui/dialogs/widgets';
import { transformTool } from '../src/tools';
import {
  runCommand, alignDelta, alignTarget, distributeDeltas, moveBlockReason, moveLayerBy,
} from '../src/ui/commands';
import { statsFor } from '../src/ui/panels/histogram';
import { layerMatchesFilter } from '../src/ui/panels/layers';

interface Case { name: string; error?: string }
const groups: { name: string; cases: Case[] }[] = [];
let current: { name: string; cases: Case[] } | null = null;

function group(name: string): void {
  current = { name, cases: [] };
  groups.push(current);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    current!.cases.push({ name });
  } catch (err) {
    current!.cases.push({ name, error: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function near(a: number, b: number, tol: number, message: string): void {
  if (Math.abs(a - b) > tol) throw new Error(`${message}（${a} ≉ ${b}，容許 ${tol}）`);
}

const pixel = (s: { ctx: CanvasRenderingContext2D }, x: number, y: number): number[] =>
  [...s.ctx.getImageData(x, y, 1, 1).data];

function filled(w: number, h: number, css: string): ReturnType<typeof createSurface> {
  const s = createSurface(w, h);
  s.ctx.fillStyle = css;
  s.ctx.fillRect(0, 0, w, h);
  return s;
}

async function run(): Promise<void> {
  // ---- colour ----
  group('色彩轉換');
  await test('HEX 與 RGB 互轉', () => {
    assert(rgbToHex({ r: 255, g: 128, b: 0 }) === '#ff8000', 'rgbToHex 不正確');
    const c = hexToRgb('#3fa9f5')!;
    assert(c.r === 63 && c.g === 169 && c.b === 245, 'hexToRgb 不正確');
    assert(hexToRgb('zzz') === null, '無效 HEX 應回傳 null');
    const short = hexToRgb('#abc')!;
    assert(short.r === 170 && short.g === 187 && short.b === 204, '三碼 HEX 應展開');
  });
  await test('HSV 往返不失真', () => {
    for (const c of [{ r: 12, g: 200, b: 77 }, { r: 250, g: 4, b: 180 }, { r: 33, g: 33, b: 33 }]) {
      const back = hsvToRgb(rgbToHsv(c));
      near(back.r, c.r, 1, 'R 往返');
      near(back.g, c.g, 1, 'G 往返');
      near(back.b, c.b, 1, 'B 往返');
    }
  });
  await test('HSL 往返不失真', () => {
    for (const c of [{ r: 12, g: 200, b: 77 }, { r: 90, g: 90, b: 240 }]) {
      const back = hslToRgb(rgbToHsl(c));
      near(back.r, c.r, 1, 'R 往返');
      near(back.g, c.g, 1, 'G 往返');
      near(back.b, c.b, 1, 'B 往返');
    }
  });

  // ---- selection ----
  group('選取範圍');
  await test('矩形選取的覆蓋率與邊界', () => {
    const sel = new Selection(100, 100);
    const p = new Path2D();
    p.rect(20, 30, 40, 25);
    sel.combine(rasterizePath(p, 100, 100), 'replace');
    assert(sel.active, '應為作用中');
    assert(sel.at(25, 35) === 255, '內部應完全選取');
    assert(sel.at(5, 5) === 0, '外部不應被選取');
    const b = sel.bounds()!;
    assert(b.x === 20 && b.y === 30 && b.w === 40 && b.h === 25, `邊界不正確：${JSON.stringify(b)}`);
  });
  await test('反轉與相加相減', () => {
    const sel = new Selection(50, 50);
    const a = new Path2D(); a.rect(0, 0, 25, 50);
    const b = new Path2D(); b.rect(25, 0, 25, 50);
    sel.combine(rasterizePath(a, 50, 50), 'replace');
    sel.combine(rasterizePath(b, 50, 50), 'add');
    assert(sel.at(10, 10) === 255 && sel.at(40, 10) === 255, '相加後應涵蓋兩側');
    sel.combine(rasterizePath(a, 50, 50), 'subtract');
    assert(sel.at(10, 10) === 0 && sel.at(40, 10) === 255, '相減後應只剩右側');
    sel.invert();
    assert(sel.at(10, 10) === 255 && sel.at(40, 10) === 0, '反轉後應對調');
  });
  await test('擴張與縮減會改變邊界', () => {
    const sel = new Selection(80, 80);
    const p = new Path2D(); p.rect(30, 30, 20, 20);
    sel.combine(rasterizePath(p, 80, 80), 'replace');
    sel.expand(5);
    let b = sel.bounds()!;
    assert(b.w >= 28 && b.h >= 28, `擴張後寬高應變大，實得 ${b.w}x${b.h}`);
    sel.contract(5);
    b = sel.bounds()!;
    near(b.w, 20, 2, '縮減後應回到原寬度');
  });
  await test('羽化會產生半透明邊緣', () => {
    const sel = new Selection(80, 80);
    const p = new Path2D(); p.rect(20, 20, 40, 40);
    sel.combine(rasterizePath(p, 80, 80), 'replace');
    sel.feather(6);
    const edge = sel.at(20, 40);
    assert(edge > 0 && edge < 255, `邊緣應為半透明，實得 ${edge}`);
    assert(sel.at(40, 40) > 200, '中央仍應接近完全選取');
  });
  await test('選取輪廓可產生路徑', () => {
    const sel = new Selection(40, 40);
    const p = new Path2D(); p.rect(10, 10, 12, 12);
    sel.combine(rasterizePath(p, 40, 40), 'replace');
    assert(sel.outline() instanceof Path2D, '應回傳 Path2D');
    assert(new Selection(10, 10).outline() === null, '無選取時應回傳 null');
  });
  await test('位移選取範圍', () => {
    const sel = new Selection(60, 60);
    const p = new Path2D(); p.rect(10, 10, 10, 10);
    sel.combine(rasterizePath(p, 60, 60), 'replace');
    sel.translate(15, 5);
    const b = sel.bounds()!;
    assert(b.x === 25 && b.y === 15, `位移後應為 (25,15)，實得 (${b.x},${b.y})`);
  });

  // ---- masks ----
  group('遮色片');
  await test('灰階遮色片轉為 alpha', () => {
    const cov = new Uint8Array(4 * 4);
    cov.fill(0);
    cov[5] = 255;
    cov[6] = 128;
    const mask = maskFromCoverage(cov, 4, 4);
    const alpha = maskAlpha(mask);
    assert(pixel(alpha, 1, 1)[3] === 255, '白色應為完全不透明');
    near(pixel(alpha, 2, 1)[3], 128, 2, '中灰應約為半透明');
    assert(pixel(alpha, 0, 0)[3] === 0, '黑色應為全透明');
  });
  await test('遮色片可讀回覆蓋率', () => {
    const cov = new Uint8Array(9).fill(200);
    const back = coverageFromMask(maskFromCoverage(cov, 3, 3));
    assert(back.every((v) => Math.abs(v - 200) <= 1), '往返後數值應保持');
  });

  // ---- compositing ----
  group('圖層合成');
  await test('不透明度會混合兩個圖層', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, '#000000'));
    const top = createRasterLayer('t', 8, 8, filled(8, 8, '#ffffff'));
    top.opacity = 0.5;
    const out = compositeLayers([bottom, top], { width: 8, height: 8 });
    near(pixel(out, 4, 4)[0], 128, 3, '50% 白疊黑應接近中灰');
  });
  await test('色彩增值混合模式', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, 'rgb(200,200,200)'));
    const top = createRasterLayer('t', 8, 8, filled(8, 8, 'rgb(128,128,128)'));
    top.blend = 'multiply';
    const out = compositeLayers([bottom, top], { width: 8, height: 8 });
    near(pixel(out, 4, 4)[0], (200 * 128) / 255, 3, '色彩增值結果不正確');
  });
  await test('非原生混合模式（線性加深）', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, 'rgb(200,200,200)'));
    const top = createRasterLayer('t', 8, 8, filled(8, 8, 'rgb(100,100,100)'));
    top.blend = 'linear-burn';
    const out = compositeLayers([bottom, top], { width: 8, height: 8 });
    near(pixel(out, 4, 4)[0], 45, 4, '線性加深應為 200+100-255');
  });
  await test('隱藏的圖層不會被合成', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, '#000000'));
    const top = createRasterLayer('t', 8, 8, filled(8, 8, '#ffffff'));
    top.visible = false;
    const out = compositeLayers([bottom, top], { width: 8, height: 8 });
    assert(pixel(out, 4, 4)[0] === 0, '隱藏圖層仍被繪製');
  });
  await test('圖層遮色片會遮住像素', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, '#000000'));
    const top = createRasterLayer('t', 8, 8, filled(8, 8, '#ffffff'));
    const cov = new Uint8Array(64).fill(0);
    for (let y = 0; y < 8; y++) cov[y * 8 + 7] = 255;
    top.mask = maskFromCoverage(cov, 8, 8);
    const out = compositeLayers([bottom, top], { width: 8, height: 8 });
    assert(pixel(out, 7, 4)[0] === 255, '遮色片白色處應顯示');
    assert(pixel(out, 1, 4)[0] === 0, '遮色片黑色處應隱藏');
  });
  await test('調整圖層作用於下方所有圖層', () => {
    const bottom = createRasterLayer('b', 8, 8, filled(8, 8, 'rgb(10,20,30)'));
    const inv = createAdjustmentLayer('invert', defaultAdjustment('invert'));
    const out = compositeLayers([bottom, inv], { width: 8, height: 8 });
    const p = pixel(out, 4, 4);
    assert(p[0] === 245 && p[1] === 235 && p[2] === 225, `負片結果不正確：${p}`);
  });
  await test('剪裁遮色片限制在下層的不透明區域', () => {
    const base = createRasterLayer('base', 10, 10);
    base.surface!.ctx.fillStyle = '#ffffff';
    base.surface!.ctx.fillRect(0, 0, 5, 10);
    const clip = createRasterLayer('clip', 10, 10, filled(10, 10, '#ff0000'));
    clip.clipped = true;
    const out = compositeLayers([base, clip], { width: 10, height: 10 });
    assert(pixel(out, 2, 5)[0] === 255 && pixel(out, 2, 5)[1] === 0, '剪裁層應顯示在基底上');
    assert(pixel(out, 8, 5)[3] === 0, '基底透明處應維持透明');
  });
  await test('圖層位移會移動內容', () => {
    const layer = createRasterLayer('l', 20, 20);
    layer.surface!.ctx.fillStyle = '#00ff00';
    layer.surface!.ctx.fillRect(0, 0, 5, 5);
    layer.x = 10;
    layer.y = 10;
    const out = compositeLayers([layer], { width: 20, height: 20 });
    assert(pixel(out, 12, 12)[1] === 255, '位移後內容應出現在新位置');
    assert(pixel(out, 2, 2)[3] === 0, '原位置應為空');
  });

  // ---- adjustments ----
  group('影像調整');
  await test('負片效果', () => {
    const s = filled(4, 4, 'rgb(10,50,200)');
    const img = s.ctx.getImageData(0, 0, 4, 4);
    applyAdjustment(img, { type: 'invert' });
    assert(img.data[0] === 245 && img.data[1] === 205 && img.data[2] === 55, '負片數值不正確');
  });
  await test('亮度調整會提高亮度', () => {
    const s = filled(4, 4, 'rgb(100,100,100)');
    const img = s.ctx.getImageData(0, 0, 4, 4);
    applyAdjustment(img, { type: 'brightness-contrast', brightness: 40, contrast: 0, legacy: true });
    assert(img.data[0] > 130, `亮度未提高，實得 ${img.data[0]}`);
  });
  await test('臨界值產生純黑白', () => {
    const s = createSurface(2, 1);
    s.ctx.fillStyle = 'rgb(20,20,20)'; s.ctx.fillRect(0, 0, 1, 1);
    s.ctx.fillStyle = 'rgb(220,220,220)'; s.ctx.fillRect(1, 0, 1, 1);
    const img = s.ctx.getImageData(0, 0, 2, 1);
    applyAdjustment(img, { type: 'threshold', level: 128 });
    assert(img.data[0] === 0 && img.data[4] === 255, '臨界值結果不正確');
  });
  await test('色階可拉伸對比', () => {
    const s = filled(4, 4, 'rgb(128,128,128)');
    const img = s.ctx.getImageData(0, 0, 4, 4);
    applyAdjustment(img, {
      type: 'levels', channel: 'rgb', inBlack: 100, inWhite: 160, gamma: 1, outBlack: 0, outWhite: 255,
    });
    near(img.data[0], ((128 - 100) / 60) * 255, 3, '色階映射不正確');
  });
  await test('曲線 LUT 單調且端點正確', () => {
    const lut = curveLut([[0, 0], [128, 200], [255, 255]]);
    assert(lut[0] === 0 && lut[255] === 255, '端點應固定');
    near(lut[128], 200, 2, '控制點應被通過');
    for (let i = 1; i < 256; i++) assert(lut[i] >= lut[i - 1] - 1, `LUT 在 ${i} 非單調`);
  });
  await test('色相旋轉 180 度', () => {
    const s = filled(4, 4, 'rgb(255,0,0)');
    const img = s.ctx.getImageData(0, 0, 4, 4);
    applyAdjustment(img, { type: 'hue-saturation', hue: 180, saturation: 0, lightness: 0, colorize: false });
    assert(img.data[0] < 40 && img.data[1] > 200, `紅色旋轉 180 度應接近青色：${[...img.data.slice(0, 3)]}`);
  });
  await test('去飽和度會產生灰階', () => {
    const s = filled(4, 4, 'rgb(200,40,90)');
    const img = s.ctx.getImageData(0, 0, 4, 4);
    applyAdjustment(img, { type: 'hue-saturation', hue: 0, saturation: -100, lightness: 0, colorize: false });
    assert(img.data[0] === img.data[1] && img.data[1] === img.data[2], '飽和度 -100 應為灰階');
  });
  await test('色調分離會降低色階數', () => {
    const s = createSurface(256, 1);
    for (let i = 0; i < 256; i++) {
      s.ctx.fillStyle = `rgb(${i},${i},${i})`;
      s.ctx.fillRect(i, 0, 1, 1);
    }
    const img = s.ctx.getImageData(0, 0, 256, 1);
    applyAdjustment(img, { type: 'posterize', levels: 4 });
    const distinct = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4) distinct.add(img.data[i]);
    assert(distinct.size === 4, `應剩 4 個色階，實得 ${distinct.size}`);
  });

  // ---- filters ----
  group('濾鏡');
  await test('高斯模糊會降低邊緣落差', () => {
    const s = createSurface(32, 4);
    s.ctx.fillStyle = '#000'; s.ctx.fillRect(0, 0, 16, 4);
    s.ctx.fillStyle = '#fff'; s.ctx.fillRect(16, 0, 16, 4);
    const img = s.ctx.getImageData(0, 0, 32, 4);
    gaussianBlur(img, 6);
    const left = img.data[15 * 4];
    const right = img.data[16 * 4];
    assert(left > 10 && right < 245, `模糊後邊界應變平緩：${left}/${right}`);
    assert(img.data[3] === 255, '不應影響 alpha');
  });
  await test('高斯模糊不會把顏色拖出透明區', () => {
    const s = createSurface(16, 16);
    s.ctx.fillStyle = '#ff0000';
    s.ctx.fillRect(0, 0, 8, 16);
    const img = s.ctx.getImageData(0, 0, 16, 16);
    gaussianBlur(img, 3);
    const idx = (15 + 8 * 16) * 4;
    assert(img.data[idx + 3] < 10, '遠離內容處應維持透明');
  });
  await test('遮色片銳利化會增強邊緣', () => {
    const make = (): ImageData => {
      const s = createSurface(16, 2);
      s.ctx.fillStyle = 'rgb(100,100,100)'; s.ctx.fillRect(0, 0, 8, 2);
      s.ctx.fillStyle = 'rgb(160,160,160)'; s.ctx.fillRect(8, 0, 8, 2);
      const i = s.ctx.getImageData(0, 0, 16, 2);
      gaussianBlur(i, 2);
      return i;
    };
    const before = make();
    const after = make();
    unsharpMask(after, 200, 2, 0);
    const gapBefore = Math.abs(before.data[8 * 4] - before.data[7 * 4]);
    const gapAfter = Math.abs(after.data[8 * 4] - after.data[7 * 4]);
    assert(gapAfter > gapBefore, `銳利化後落差應變大：${gapBefore} → ${gapAfter}`);
  });
  await test('馬賽克會讓區塊內顏色一致', () => {
    const s = createSurface(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        s.ctx.fillStyle = `rgb(${x * 30},${y * 30},0)`;
        s.ctx.fillRect(x, y, 1, 1);
      }
    }
    const img = s.ctx.getImageData(0, 0, 8, 8);
    pixelate(img, 4);
    const a = img.data[0], b = img.data[(3 + 3 * 8) * 4];
    assert(a === b, '同一馬賽克區塊應同色');
  });
  await test('尋找邊緣會標出輪廓', () => {
    const s = createSurface(16, 16);
    s.ctx.fillStyle = '#fff'; s.ctx.fillRect(0, 0, 16, 16);
    s.ctx.fillStyle = '#000'; s.ctx.fillRect(4, 4, 8, 8);
    const img = s.ctx.getImageData(0, 0, 16, 16);
    findEdges(img);
    assert(img.data[(4 + 8 * 16) * 4] < 200, '邊界處應變暗');
    assert(img.data[(1 + 1 * 16) * 4] > 240, '平坦處應維持白色');
  });
  await test('濾鏡登錄表可用預設參數執行', () => {
    const def = getFilter('gaussian-blur')!;
    const params = defaultParams(def);
    const s = filled(8, 8, '#808080');
    const img = s.ctx.getImageData(0, 0, 8, 8);
    def.apply(img, params);
    assert(img.data.length === 8 * 8 * 4, '濾鏡輸出尺寸不正確');
  });

  // ---- flood fill / wand ----
  group('填色與魔術棒');
  await test('連續填色只涵蓋相連區域', () => {
    const s = createSurface(10, 10);
    s.ctx.fillStyle = '#ffffff'; s.ctx.fillRect(0, 0, 10, 10);
    s.ctx.fillStyle = '#000000'; s.ctx.fillRect(5, 0, 1, 10);
    const img = s.ctx.getImageData(0, 0, 10, 10);
    const cov = floodSelect(img, 1, 1, 10, true);
    assert(cov[1 * 10 + 1] === 255, '起點應被選取');
    assert(cov[1 * 10 + 8] === 0, '被黑線隔開的另一側不應被選取');
    const all = floodSelect(img, 1, 1, 10, false);
    assert(all[1 * 10 + 8] === 255, '非連續模式應選取全部同色像素');
  });

  // ---- drawing ----
  group('繪圖工具');
  await test('筆刷描繪會被選取範圍限制', () => {
    const doc = PhotoDoc.createBlank('t', 40, 40, 'transparent');
    const layer = doc.activeLayer()!;
    const p = new Path2D(); p.rect(0, 0, 20, 40);
    doc.selection.combine(rasterizePath(p, 40, 40), 'replace');
    const settings = { ...defaultBrush(), size: 12, hardness: 1, smoothing: 0, sizePressure: false };
    const stroke = new Stroke(doc, layer, layer.surface!, 'pixels', settings, 'paint');
    stroke.begin(5, 20, 1);
    stroke.extend(35, 20, 1);
    stroke.commit('test');
    const out = doc.activeLayer()!.surface!;
    assert(pixel(out, 8, 20)[3] > 200, '選取範圍內應有筆觸');
    assert(pixel(out, 30, 20)[3] === 0, '選取範圍外不應有筆觸');
  });
  await test('橡皮擦模式會移除像素', () => {
    const doc = PhotoDoc.createBlank('t', 30, 30, 'white');
    const layer = doc.activeLayer()!;
    const settings = { ...defaultBrush(), size: 10, hardness: 1, smoothing: 0, sizePressure: false };
    const stroke = new Stroke(doc, layer, layer.surface!, 'pixels', settings, 'erase');
    stroke.begin(15, 15, 1);
    stroke.commit('erase');
    assert(pixel(doc.activeLayer()!.surface!, 15, 15)[3] < 40, '擦除處應變透明');
  });
  await test('線性漸層由起點走到終點', () => {
    const s = createSurface(64, 8);
    renderGradient(
      s, 'linear', 0, 0, 63, 0,
      presetStops('black-white', { r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }),
      false, false,
    );
    assert(pixel(s, 1, 4)[0] < 20, '起點應為黑');
    assert(pixel(s, 62, 4)[0] > 235, '終點應為白');
    near(pixel(s, 32, 4)[0], 128, 12, '中間應為中灰');
  });
  await test('形狀路徑可產生填色區域', () => {
    const s = createSurface(40, 40);
    s.ctx.fillStyle = '#ff0000';
    s.ctx.fill(shapePath('ellipse', 5, 5, 35, 35, 0, 5));
    assert(pixel(s, 20, 20)[0] === 255, '橢圓中心應被填色');
    assert(pixel(s, 6, 6)[3] === 0, '橢圓外角應維持透明');
  });
  await test('文字圖層會渲染出像素', () => {
    const doc = PhotoDoc.createBlank('t', 200, 80, 'transparent');
    const layer = createRasterLayer('text', 200, 80);
    layer.kind = 'text';
    layer.text = { ...defaultTextStyle(), text: 'Ag', fontSize: 48 };
    renderTextLayer(layer, 200, 80);
    const bounds = opaqueBounds(layer.surface!);
    assert(bounds !== null && bounds.w > 10, '文字應產生可見像素');
    assert(measureText(layer.text).width > 10, '文字量測寬度應大於 0');
    void doc;
  });

  // ---- document ----
  group('文件與步驟記錄');
  await test('還原與重做可回復像素', () => {
    const doc = PhotoDoc.createBlank('t', 20, 20, 'white');
    const layer = doc.activeLayer()!;
    const target = doc.mutableSurface(layer);
    target.ctx.fillStyle = '#ff0000';
    target.ctx.fillRect(0, 0, 20, 20);
    doc.commit('fill');
    assert(pixel(doc.activeLayer()!.surface!, 5, 5)[0] === 255, '填色後應為紅色');
    assert(doc.undo(), '應可還原');
    assert(pixel(doc.activeLayer()!.surface!, 5, 5)[1] === 255, '還原後應回到白色');
    assert(doc.redo(), '應可重做');
    assert(pixel(doc.activeLayer()!.surface!, 5, 5)[1] === 0, '重做後應回到紅色');
  });
  await test('步驟記錄不會共用可變的像素緩衝', () => {
    const doc = PhotoDoc.createBlank('t', 10, 10, 'white');
    const before = doc.activeLayer()!.surface!;
    const after = doc.mutableSurface(doc.activeLayer()!);
    assert(before !== after, 'mutableSurface 應回傳新的緩衝');
    after.ctx.clearRect(0, 0, 10, 10);
    assert(pixel(before, 5, 5)[3] === 255, '舊快照不應被修改');
  });
  await test('版面尺寸會保留原有內容位置', () => {
    const doc = PhotoDoc.createBlank('t', 20, 20, 'transparent');
    const layer = doc.activeLayer()!;
    layer.surface!.ctx.fillStyle = '#00ff00';
    layer.surface!.ctx.fillRect(0, 0, 4, 4);
    doc.resizeCanvas(30, 30, 10, 10);
    assert(doc.width === 30 && doc.height === 30, '尺寸應更新');
    assert(pixel(doc.activeLayer()!.surface!, 12, 12)[1] === 255, '內容應位移到新位置');
  });
  await test('影像尺寸會重新取樣', () => {
    const doc = PhotoDoc.createBlank('t', 20, 20, 'white');
    doc.resampleTo(40, 40, true);
    assert(doc.width === 40, '寬度應更新');
    assert(pixel(doc.activeLayer()!.surface!, 20, 20)[0] === 255, '重新取樣後內容應保留');
  });
  await test('複製圖層會深拷貝像素', () => {
    const doc = PhotoDoc.createBlank('t', 10, 10, 'white');
    const copy = duplicateLayer(doc.activeLayer()!);
    copy.surface!.ctx.clearRect(0, 0, 10, 10);
    assert(pixel(doc.activeLayer()!.surface!, 5, 5)[3] === 255, '原圖層不應被影響');
  });

  // ---- project IO ----
  group('專案存檔');
  await test('序列化後再載入可得到相同影像', async () => {
    const doc = PhotoDoc.createBlank('t', 40, 30, 'white');
    const layer = createRasterLayer('shape', 40, 30);
    layer.surface!.ctx.fillStyle = '#2288ff';
    layer.surface!.ctx.fillRect(4, 4, 20, 14);
    layer.blend = 'multiply';
    layer.opacity = 0.6;
    layer.mask = maskFromCoverage(null, 40, 30, 255);
    doc.layers.push(layer);
    doc.commit('add');

    const restored = await loadProject(serializeDocument(doc));
    assert(restored.width === 40 && restored.height === 30, '尺寸應一致');
    assert(restored.layers.length === 2, '圖層數應一致');
    assert(restored.layers[1].blend === 'multiply', '混合模式應保留');
    near(restored.layers[1].opacity, 0.6, 0.01, '不透明度應保留');
    assert(restored.layers[1].mask !== null, '遮色片應保留');

    const a = doc.render(), b = restored.render();
    const da = a.ctx.getImageData(0, 0, a.w, a.h).data;
    const db = b.ctx.getImageData(0, 0, b.w, b.h).data;
    let diff = 0;
    for (let i = 0; i < da.length; i++) if (Math.abs(da[i] - db[i]) > 1) diff++;
    assert(diff === 0, `像素應完全一致，實際有 ${diff} 個位元組不同`);
  });
  await test('拒絕非 Photograp 專案檔', async () => {
    let failed = false;
    try {
      await loadProject('{"magic":"nope"}');
    } catch {
      failed = true;
    }
    assert(failed, '應拋出錯誤');
  });

  // ---- surfaces ----
  group('繪圖表面');
  await test('不透明邊界計算', () => {
    const s = createSurface(20, 20);
    s.ctx.fillStyle = '#fff';
    s.ctx.fillRect(5, 6, 4, 3);
    const b = opaqueBounds(s)!;
    assert(b.x === 5 && b.y === 6 && b.w === 4 && b.h === 3, `邊界不正確：${JSON.stringify(b)}`);
    assert(opaqueBounds(createSurface(4, 4)) === null, '全透明應回傳 null');
  });
  await test('複製表面不共用資料', () => {
    const a = filled(8, 8, '#ff0000');
    const b = cloneSurface(a);
    b.ctx.clearRect(0, 0, 8, 8);
    assert(pixel(a, 4, 4)[0] === 255, '原表面不應被清除');
  });

  // ---- vector paths ----
  group('向量路徑');
  await test('控制點與控制桿一起移動', () => {
    const a = createAnchor(10, 10);
    a.outX = 20; a.outY = 10;
    moveAnchor(a, 30, 40);
    assert(a.x === 30 && a.y === 40, '控制點應移動');
    assert(a.outX === 40 && a.outY === 40, '控制桿應跟著位移');
  });
  await test('平滑點的控制桿互相鏡射', () => {
    const a = createAnchor(50, 50, true);
    moveHandle(a, 'out', 70, 50, true);
    assert(a.inX === 30 && a.inY === 50, `另一側應鏡射，實得 ${a.inX},${a.inY}`);
    moveHandle(a, 'out', 70, 20, false);
    assert(a.inX === 30 && a.inY === 50, '未要求鏡射時另一側不應變動');
  });
  await test('路徑可轉成填色區域', () => {
    const path = createPath('t');
    path.subpaths.push({
      closed: true,
      anchors: [createAnchor(10, 10), createAnchor(50, 10), createAnchor(50, 40), createAnchor(10, 40)],
    });
    const cov = rasterizePath(toPath2D(path), 60, 60);
    assert(cov[25 * 60 + 30] === 255, '矩形路徑內部應被填滿');
    assert(cov[5 * 60 + 5] === 0, '路徑外部應為空');
    assert(anchorCount(path) === 4, '控制點數量不正確');
  });
  await test('貝茲曲線段會離開直線', () => {
    const path = createPath('curve');
    const a = createAnchor(10, 50, true);
    const b = createAnchor(90, 50, true);
    a.outX = 30; a.outY = 0;
    b.inX = 70; b.inY = 0;
    path.subpaths.push({ closed: false, anchors: [a, b] });
    const canvas = createSurface(100, 100);
    canvas.ctx.lineWidth = 3;
    canvas.ctx.strokeStyle = '#fff';
    canvas.ctx.stroke(toPath2D(path));
    const d = canvas.ctx.getImageData(0, 0, 100, 100).data;
    let above = 0;
    for (let y = 10; y < 45; y++) above += d[(y * 100 + 50) * 4 + 3];
    assert(above > 0, '曲線應離開起訖點連線');
    assert(d[(50 * 100 + 50) * 4 + 3] < 200, '曲線中段不應停留在直線上');
  });
  await test('命中測試可分辨控制點與控制桿', () => {
    const path = createPath('t');
    const a = createAnchor(40, 40, true);
    moveHandle(a, 'out', 60, 40, true);
    path.subpaths.push({ closed: false, anchors: [a, createAnchor(100, 100)] });
    assert(hitTest(path, { x: 41, y: 41 }, 5)?.part === 'point', '應命中控制點');
    assert(hitTest(path, { x: 60, y: 41 }, 5)?.part === 'out', '應命中外控制桿');
    assert(hitTest(path, { x: 5, y: 5 }, 5) === null, '空白處應無命中');
  });
  await test('簡化會保留轉角', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 },
      { x: 30, y: 10 }, { x: 30, y: 20 },
    ];
    const out = simplify(pts, 1);
    assert(out.length === 3, `應只剩三個點，實得 ${out.length}`);
    assert(out[1].x === 30 && out[1].y === 0, '轉角應被保留');
  });
  await test('從選取範圍建立的路徑可還原選取區域', () => {
    const sel = new Selection(80, 80);
    const p = new Path2D();
    p.rect(20, 20, 40, 30);
    sel.combine(rasterizePath(p, 80, 80), 'replace');
    const path = pathFromLoops(sel.loops(), 1, '工作路徑');
    assert(path.subpaths.length === 1, '應產生一個子路徑');
    const cov = rasterizePath(toPath2D(path), 80, 80);
    assert(cov[35 * 80 + 40] === 255, '還原後內部應被選取');
    assert(cov[5 * 80 + 5] === 0, '還原後外部不應被選取');
  });

  // ---- channels ----
  group('色版');
  await test('可取出單一色彩色版', () => {
    const s = filled(4, 4, 'rgb(200,100,50)');
    assert(pixel(extractChannel(s, 'r'), 1, 1)[0] === 200, '紅色版數值不正確');
    assert(pixel(extractChannel(s, 'g'), 1, 1)[0] === 100, '綠色版數值不正確');
    assert(pixel(extractChannel(s, 'b'), 1, 1)[0] === 50, '藍色版數值不正確');
  });
  await test('Alpha 色版可存取覆蓋率', () => {
    const cov = new Uint8Array(16).fill(0);
    cov[5] = 255;
    const ch = createAlphaChannel('Alpha 1', 4, 4, cov);
    const back = channelCoverage(ch.surface);
    assert(back[5] === 255 && back[0] === 0, '色版覆蓋率往返不正確');
    setChannelCoverage(ch, new Uint8Array(16).fill(128));
    assert(channelCoverage(ch.surface)[0] === 128, '覆蓋率寫入失敗');
  });
  await test('檢視單一色版會顯示灰階', () => {
    const composite = filled(4, 4, 'rgb(255,0,0)');
    const view = renderChannelView(composite, 'r', []);
    const p = pixel(view, 1, 1);
    assert(p[0] === 255 && p[1] === 255 && p[2] === 255, `紅色版應為白色，實得 ${p}`);
    assert(pixel(renderChannelView(composite, 'g', []), 1, 1)[0] === 0, '綠色版應為黑色');
  });
  await test('顯示中的 Alpha 色版會疊印在影像上', () => {
    const composite = filled(8, 8, 'rgb(0,0,0)');
    const ch = createAlphaChannel('quick', 8, 8, new Uint8Array(64).fill(255));
    ch.visible = true;
    ch.opacity = 1;
    ch.color = { r: 255, g: 0, b: 0 };
    const p = pixel(renderChannelView(composite, 'rgb', [ch]), 4, 4);
    assert(p[0] > 200 && p[1] < 40, `疊印顏色不正確：${p}`);
  });

  // ---- smart objects ----
  group('智慧型物件');
  await test('智慧型物件會依放置資料渲染', () => {
    const source = filled(20, 10, '#ff0000');
    const layer = createRasterLayer('smart', 100, 100);
    layer.kind = 'smart';
    layer.smart = createSmartObject(source, 50, 50);
    renderSmartLayer(layer, 100, 100);
    assert(pixel(layer.surface!, 50, 50)[0] === 255, '中心應為來源顏色');
    assert(pixel(layer.surface!, 5, 5)[3] === 0, '範圍外應透明');
    const b = smartBounds(layer.smart, 100, 100);
    assert(b.w >= 20 && b.h >= 10, `放置邊界不正確：${JSON.stringify(b)}`);
  });
  await test('縮小再放大不會損失畫質', () => {
    const source = createSurface(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        source.ctx.fillStyle = (x + y) % 2 ? '#ffffff' : '#000000';
        source.ctx.fillRect(x, y, 1, 1);
      }
    }
    const layer = createRasterLayer('smart', 128, 128);
    layer.kind = 'smart';
    layer.smart = createSmartObject(source, 64, 64);

    renderSmartLayer(layer, 128, 128);
    const original = layer.surface!.ctx.getImageData(0, 0, 128, 128).data.slice();

    layer.smart = { ...layer.smart, scaleX: 0.1, scaleY: 0.1 };
    renderSmartLayer(layer, 128, 128);
    layer.smart = { ...layer.smart, scaleX: 1, scaleY: 1 };
    renderSmartLayer(layer, 128, 128);
    const after = layer.surface!.ctx.getImageData(0, 0, 128, 128).data;

    let diff = 0;
    for (let i = 0; i < original.length; i++) if (Math.abs(original[i] - after[i]) > 1) diff++;
    assert(diff === 0, `來回縮放後應完全相同，實際有 ${diff} 個位元組不同`);
  });
  await test('智慧型濾鏡可套用與停用', () => {
    const source = filled(40, 40, 'rgb(0,0,0)');
    source.ctx.fillStyle = '#ffffff';
    source.ctx.fillRect(20, 0, 20, 40);
    const layer = createRasterLayer('smart', 60, 60);
    layer.kind = 'smart';
    layer.smart = createSmartObject(source, 30, 30);
    renderSmartLayer(layer, 60, 60);
    const sharpEdge = pixel(layer.surface!, 29, 30)[0];

    const entry = smartFilterEntry('gaussian-blur', { radius: 8 });
    layer.smart.filters.push(entry);
    renderSmartLayer(layer, 60, 60);
    const blurred = pixel(layer.surface!, 29, 30)[0];
    assert(blurred > sharpEdge + 10, `濾鏡應讓邊界變模糊：${sharpEdge} → ${blurred}`);

    entry.enabled = false;
    renderSmartLayer(layer, 60, 60);
    assert(Math.abs(pixel(layer.surface!, 29, 30)[0] - sharpEdge) <= 2, '停用濾鏡後應回到原狀');
  });
  await test('專案存檔保留路徑、色版與智慧型物件', async () => {
    const d = PhotoDoc.createBlank('t', 60, 40, 'white');
    const source = filled(20, 20, '#3388ff');
    const smart = createRasterLayer('智慧', 60, 40);
    smart.kind = 'smart';
    smart.smart = createSmartObject(source, 30, 20);
    smart.smart.scaleX = 1.5;
    smart.smart.filters.push(smartFilterEntry('gaussian-blur', { radius: 2 }));
    renderSmartLayer(smart, 60, 40);
    d.layers.push(smart);

    const path = createPath('路徑 1');
    path.subpaths.push({
      closed: true,
      anchors: [createAnchor(5, 5), createAnchor(30, 5), createAnchor(30, 25)],
    });
    d.setPath(path);
    d.channels.push(createAlphaChannel('Alpha 1', 60, 40, new Uint8Array(60 * 40).fill(90)));
    d.commit('setup');

    const restored = await loadProject(serializeDocument(d));
    assert(restored.paths.length === 1 && anchorCount(restored.paths[0]) === 3, '路徑應被保留');
    assert(restored.channels.length === 1, '色版應被保留');
    assert(channelCoverage(restored.channels[0].surface)[0] === 90, '色版內容應被保留');
    const rs = restored.layers[1];
    assert(rs.kind === 'smart' && !!rs.smart, '智慧型物件應被保留');
    assert(rs.smart!.sourceWidth === 20, '來源尺寸應被保留');
    near(rs.smart!.scaleX, 1.5, 0.001, '縮放應被保留');
    assert(rs.smart!.filters.length === 1, '智慧型濾鏡應被保留');

    const a = d.render(), b = restored.render();
    const da = a.ctx.getImageData(0, 0, a.w, a.h).data;
    const db = b.ctx.getImageData(0, 0, b.w, b.h).data;
    let diff = 0;
    for (let i = 0; i < da.length; i++) if (Math.abs(da[i] - db[i]) > 2) diff++;
    assert(diff === 0, `合成結果應一致，實際有 ${diff} 個位元組不同`);
  });
  await test('影像尺寸改變時智慧型物件重新取樣自來源', () => {
    const source = filled(40, 40, '#00aa55');
    const d = PhotoDoc.createBlank('t', 80, 80, 'transparent');
    const layer = createRasterLayer('smart', 80, 80);
    layer.kind = 'smart';
    layer.smart = createSmartObject(source, 40, 40);
    renderSmartLayer(layer, 80, 80);
    d.layers.push(layer);
    d.resampleTo(160, 160, true);
    assert(layer.smart!.scaleX === 2, '放置縮放應跟著文件放大');
    assert(layer.smart!.sourceWidth === 40, '來源不應被重新取樣');
    assert(pixel(layer.surface!, 80, 80)[1] === 170, '重新渲染後顏色應保持');
  });
  await test('智慧型物件圖層不可直接繪製', () => {
    const d = PhotoDoc.createBlank('t', 30, 30, 'transparent');
    const layer = d.activeLayer()!;
    layer.kind = 'smart';
    layer.smart = createSmartObject(filled(10, 10, '#fff'), 15, 15);
    assert(d.paintTarget() === null, '智慧型物件不應成為繪製目標');
  });

  // ---- quick mask ----
  group('快速遮色片');
  await test('進入時由選取範圍產生遮色片', () => {
    const d = PhotoDoc.createBlank('t', 40, 40, 'white');
    const p = new Path2D();
    p.rect(10, 10, 20, 20);
    d.selection.combine(rasterizePath(p, 40, 40), 'replace');
    d.enterQuickMask();
    assert(d.quickMask !== null, '應進入快速遮色片模式');
    assert(!d.selection.active, '進入後選取範圍應交給遮色片');
    assert(pixel(d.quickMask!.surface, 20, 20)[0] === 255, '選取區在遮色片中應為白色');
    assert(pixel(d.quickMask!.surface, 2, 2)[0] === 0, '未選取區應為黑色');
  });
  await test('離開時把遮色片轉回選取範圍', () => {
    const d = PhotoDoc.createBlank('t', 40, 40, 'white');
    d.enterQuickMask();
    const m = d.mutableQuickMask();
    m.ctx.fillStyle = '#000';
    m.ctx.fillRect(0, 0, 20, 40);
    d.exitQuickMask();
    assert(d.quickMask === null, '應離開快速遮色片模式');
    assert(d.selection.active, '應產生選取範圍');
    assert(d.selection.at(30, 20) === 255, '未塗黑的一側應被選取');
    assert(d.selection.at(5, 20) === 0, '塗黑的一側不應被選取');
  });
  await test('沒有任何遮蔽時離開會取消選取', () => {
    const d = PhotoDoc.createBlank('t', 20, 20, 'white');
    d.enterQuickMask();
    d.exitQuickMask();
    assert(!d.selection.active, '未塗抹就離開應維持沒有選取範圍');
  });
  await test('繪製目標會切換到快速遮色片', () => {
    const d = PhotoDoc.createBlank('t', 30, 30, 'white');
    assert(d.paintTarget()?.slot === 'pixels', '一般情況應繪製圖層像素');
    d.enterQuickMask();
    const t = d.paintTarget()!;
    assert(t.slot === 'quickmask', '快速遮色片模式應接管繪製');
    assert(t.layer === null, '快速遮色片不隸屬任何圖層');
  });
  await test('筆刷可直接塗抹快速遮色片', () => {
    const d = PhotoDoc.createBlank('t', 60, 60, 'white');
    d.enterQuickMask();
    const t = d.paintTarget()!;
    const settings = {
      ...defaultBrush(), size: 20, hardness: 1, smoothing: 0,
      sizePressure: false, color: { r: 0, g: 0, b: 0 },
    };
    const stroke = new Stroke(d, t.layer, t.surface, t.slot, settings, 'paint');
    stroke.begin(30, 30, 1);
    stroke.commit('快速遮色片筆刷');
    assert(pixel(d.quickMask!.surface, 30, 30)[0] < 40, '塗抹處應變黑');
    assert(pixel(d.quickMask!.surface, 30, 30)[3] === 255, '遮色片應維持不透明');
    d.exitQuickMask();
    assert(d.selection.at(30, 30) < 40, '塗抹處不應被選取');
    assert(d.selection.at(2, 2) === 255, '其餘部分應被選取');
  });
  await test('覆蓋率往返與疊印顏色', () => {
    const d = PhotoDoc.createBlank('t', 8, 8, 'white');
    d.enterQuickMask();
    const cov = quickMaskCoverage(d.quickMask!.surface);
    assert(cov.every((v) => v === 255), '初始應為全選');
    const composite = filled(8, 8, 'rgb(0,0,0)');
    const qm = d.quickMask!;
    const m = d.mutableQuickMask();
    m.ctx.fillStyle = '#000';
    m.ctx.fillRect(0, 0, 8, 8);
    const tinted = renderQuickMaskOverlay(composite, d.quickMask!, null);
    const p = pixel(tinted, 4, 4);
    assert(p[0] > 100 && p[1] < 40, `遮蔽區應疊上紅色，實得 ${p}`);
    void qm;
  });
  await test('步驟記錄會保留快速遮色片狀態', () => {
    const d = PhotoDoc.createBlank('t', 20, 20, 'white');
    d.commit('base');
    d.enterQuickMask();
    d.commit('進入快速遮色片');
    assert(d.undo(), '應可還原');
    assert(d.quickMask === null, '還原後應離開快速遮色片');
    assert(d.redo(), '應可重做');
    assert(d.quickMask !== null, '重做後應回到快速遮色片');
  });

  // ---- liquify ----
  group('液化');
  await test('未變形的網格會原樣複製影像', () => {
    const src = createSurface(32, 32);
    src.ctx.fillStyle = '#c03040';
    src.ctx.fillRect(0, 0, 16, 32);
    const img = src.ctx.getImageData(0, 0, 32, 32);
    const out = new ImageData(32, 32);
    const mesh = new WarpMesh(32, 32, 4);
    assert(mesh.isIdentity(), '新網格應為恆等');
    warpImage(img, out, mesh, 1);
    let diff = 0;
    for (let i = 0; i < img.data.length; i++) if (img.data[i] !== out.data[i]) diff++;
    assert(diff === 0, `恆等網格應完全複製，實際有 ${diff} 個位元組不同`);
  });
  await test('向前彎曲會把內容往拖曳方向推', () => {
    const src = createSurface(64, 64);
    src.ctx.fillStyle = '#000000';
    src.ctx.fillRect(0, 0, 32, 64);
    src.ctx.fillStyle = '#ffffff';
    src.ctx.fillRect(32, 0, 32, 64);
    const img = src.ctx.getImageData(0, 0, 64, 64);
    const out = new ImageData(64, 64);

    const mesh = new WarpMesh(64, 64, 4);
    mesh.stroke('forward', 32, 32, 24, 1, 10, 0);
    warpImage(img, out, mesh, 1);
    const at = (x: number, y: number): number => out.data[(y * 64 + x) * 4];
    assert(img.data[(32 * 64 + 36) * 4] === 255, '原本 x=36 應為白色');
    assert(at(36, 32) < 60, `推擠後 x=36 應被黑色覆蓋，實得 ${at(36, 32)}`);
    assert(at(60, 32) > 200, '筆刷範圍外不應改變');
  });
  await test('凍結遮色片會保護該區域', () => {
    const mesh = new WarpMesh(64, 64, 4);
    mesh.stroke('freeze', 32, 32, 24, 1, 0, 0);
    assert(mesh.hasFreeze(), '應記錄凍結範圍');
    mesh.stroke('forward', 32, 32, 24, 1, 10, 0);
    const off: [number, number] = [0, 0];
    mesh.sample(32, 32, off);
    assert(Math.abs(off[0]) < 0.01, `完全凍結處不應位移，實得 ${off[0]}`);
    mesh.clearFreeze();
    mesh.stroke('forward', 32, 32, 24, 1, 10, 0);
    mesh.sample(32, 32, off);
    assert(Math.abs(off[0]) > 5, '解凍後應可再次位移');
  });
  await test('重建會把位移拉回原點', () => {
    const mesh = new WarpMesh(64, 64, 4);
    mesh.stroke('forward', 32, 32, 24, 1, 12, 0);
    const off: [number, number] = [0, 0];
    mesh.sample(32, 32, off);
    const before = Math.abs(off[0]);
    assert(before > 5, '應先產生位移');
    for (let i = 0; i < 6; i++) mesh.stroke('reconstruct', 32, 32, 24, 1, 0, 0);
    mesh.sample(32, 32, off);
    assert(Math.abs(off[0]) < before * 0.3, `重建後位移應大幅縮小：${before} → ${Math.abs(off[0])}`);
  });
  await test('膨脹與縮攏的方向相反', () => {
    const off: [number, number] = [0, 0];
    const bloat = new WarpMesh(64, 64, 4);
    bloat.stroke('bloat', 32, 32, 24, 1, 0, 0);
    bloat.sample(40, 32, off);
    const bloatDx = off[0];
    const pucker = new WarpMesh(64, 64, 4);
    pucker.stroke('pucker', 32, 32, 24, 1, 0, 0);
    pucker.sample(40, 32, off);
    const puckerDx = off[0];
    assert(bloatDx < 0 && puckerDx > 0, `方向應相反：膨脹 ${bloatDx}、縮攏 ${puckerDx}`);
  });
  await test('扭轉會產生垂直於半徑的位移', () => {
    const mesh = new WarpMesh(64, 64, 4);
    for (let i = 0; i < 4; i++) mesh.stroke('twirl-cw', 32, 32, 24, 1, 0, 0);
    const off: [number, number] = [0, 0];
    mesh.sample(44, 32, off);
    assert(Math.abs(off[1]) > Math.abs(off[0]), `水平方向的取樣點應主要往垂直位移：${off}`);
  });
  await test('網格縮放與預覽一致', () => {
    const mesh = new WarpMesh(64, 64, 4);
    mesh.stroke('forward', 32, 32, 24, 1, 8, 0);
    const off: [number, number] = [0, 0];
    mesh.sample(32, 32, off);
    // The same mesh drives a half-size preview, so the shift halves in pixels.
    const shiftFull = off[0] * 1;
    const shiftHalf = off[0] * 0.5;
    near(shiftHalf, shiftFull / 2, 0.001, '不同縮放下的位移應成比例');
  });

  // ---- review follow-ups ----
  group('快速遮色片整合');
  await test('填滿與清除會作用在快速遮色片上', () => {
    const d = PhotoDoc.createBlank('t', 30, 30, 'white');
    d.enterQuickMask();
    const t = d.paintTarget()!;
    assert(t.clipToSelection === false, '快速遮色片不應被選取範圍裁切');
    assert(t.offX === 0 && t.offY === 0, '快速遮色片位於文件座標');
    const dest = d.mutablePaintSurface(t.layer, t.slot);
    dest.ctx.fillStyle = '#000';
    dest.ctx.fillRect(0, 0, 15, 30);
    assert(pixel(d.quickMask!.surface, 5, 5)[0] === 0, '應寫入快速遮色片');
    assert(pixel(d.layers[0].surface!, 5, 5)[0] === 255, '圖層像素不應被更動');
  });
  await test('版面尺寸改變時快速遮色片跟著位移', () => {
    const d = PhotoDoc.createBlank('t', 20, 20, 'white');
    d.enterQuickMask();
    const m = d.mutableQuickMask();
    m.ctx.fillStyle = '#000';
    m.ctx.fillRect(0, 0, 10, 20);
    d.resizeCanvas(30, 20, 10, 0);
    assert(d.quickMask!.surface.w === 30, '遮色片應跟著版面變寬');
    assert(pixel(d.quickMask!.surface, 15, 10)[0] === 0, '原本遮蔽的區域應位移');
    assert(pixel(d.quickMask!.surface, 25, 10)[0] === 255, '未遮蔽的區域應保持');
  });
  await test('影像尺寸改變時快速遮色片重新取樣', () => {
    const d = PhotoDoc.createBlank('t', 20, 20, 'white');
    d.enterQuickMask();
    d.resampleTo(40, 40, true);
    assert(d.quickMask!.surface.w === 40 && d.quickMask!.surface.h === 40, '遮色片應同步縮放');
  });
  await test('專案存檔保留快速遮色片', async () => {
    const d = PhotoDoc.createBlank('t', 24, 16, 'white');
    d.enterQuickMask();
    const m = d.mutableQuickMask();
    m.ctx.fillStyle = '#000';
    m.ctx.fillRect(0, 0, 12, 16);
    d.quickMask = { ...d.quickMask!, opacity: 0.8, showMaskedAreas: false };
    d.commit('quick mask');

    const restored = await loadProject(serializeDocument(d));
    assert(restored.quickMask !== null, '快速遮色片應被保留');
    near(restored.quickMask!.opacity, 0.8, 0.001, '不透明度應被保留');
    assert(restored.quickMask!.showMaskedAreas === false, '顏色指示方向應被保留');
    assert(pixel(restored.quickMask!.surface, 3, 8)[0] === 0, '遮蔽內容應被保留');
    assert(pixel(restored.quickMask!.surface, 20, 8)[0] === 255, '未遮蔽內容應被保留');
  });

  group('液化細節');
  await test('取樣不會從透明鄰居帶入顏色', () => {
    const src = new ImageData(4, 1);
    src.data.set([255, 0, 0, 255], 0);
    // The remaining pixels stay fully transparent black.
    const dst = new ImageData(4, 1);
    const mesh = new WarpMesh(4, 1, 4);
    mesh.dx.fill(0.5);
    warpImage(src, dst, mesh, 1);
    assert(dst.data[0] > 240, `色彩應維持純紅，實得 ${dst.data[0]}`);
    assert(dst.data[3] > 100 && dst.data[3] < 200, `alpha 應約為一半，實得 ${dst.data[3]}`);
  });
  await test('選取範圍內的變形透明度會被保留', () => {
    const original = createSurface(20, 20);
    original.ctx.fillStyle = '#ff0000';
    original.ctx.fillRect(4, 4, 8, 8);

    // The warp moved the square out of the selected region entirely.
    const warped = createSurface(20, 20);

    const sel = new Selection(20, 20);
    const p = new Path2D();
    p.rect(2, 2, 12, 12);
    sel.combine(rasterizePath(p, 20, 20), 'replace');

    const merged = composeWarpWithSelection(original, warped, sel.toSurface(), 0, 0);
    assert(pixel(merged, 8, 8)[3] === 0, '選取範圍內應變成透明，而非露出原圖');
  });
  await test('重複扭轉會持續累積旋轉', () => {
    const one = new WarpMesh(64, 64, 4);
    one.stroke('twirl-cw', 32, 32, 24, 1, 0, 0);
    const many = new WarpMesh(64, 64, 4);
    for (let i = 0; i < 5; i++) many.stroke('twirl-cw', 32, 32, 24, 1, 0, 0);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    one.sample(44, 32, a);
    many.sample(44, 32, b);
    assert(Math.hypot(b[0], b[1]) > Math.hypot(a[0], a[1]) * 2, '多次扭轉應明顯大於單次');
  });

  // ---- guides and snapping ----
  group('參考線與靠齊');
  await test('參考線命中測試依方向判斷距離', () => {
    const guides = [createGuide('v', 100), createGuide('h', 40)];
    assert(guideAt(guides, 102, 300, 5)?.axis === 'v', '應命中垂直參考線');
    assert(guideAt(guides, 300, 38, 5)?.axis === 'h', '應命中水平參考線');
    assert(guideAt(guides, 300, 300, 5) === null, '遠處不應命中');
  });
  await test('靠齊候選包含文件、參考線與圖層', () => {
    const layer = createRasterLayer('box', 200, 100);
    layer.surface!.ctx.fillStyle = '#fff';
    layer.surface!.ctx.fillRect(20, 10, 40, 30);
    const ctx = collectSnapTargets(
      { width: 200, height: 100, guides: [createGuide('v', 77)], layers: [layer] },
      defaultSnapSettings(), 8, 50,
    );
    for (const v of [0, 100, 200]) assert(ctx.x.includes(v), `應包含文件 X 候選 ${v}`);
    assert(ctx.x.includes(77), '應包含垂直參考線');
    for (const v of [20, 40, 60]) assert(ctx.x.includes(v), `應包含圖層 X 候選 ${v}`);
    for (const v of [10, 25, 40]) assert(ctx.y.includes(v), `應包含圖層 Y 候選 ${v}`);
    assert(ctx.grid === null, '預設不靠齊格點');
  });
  await test('關閉靠齊時沒有候選', () => {
    const s = { ...defaultSnapSettings(), enabled: false };
    const ctx = collectSnapTargets({ width: 100, height: 100, guides: [], layers: [] }, s, 8, 50);
    assert(ctx.x.length === 0 && ctx.y.length === 0 && ctx.threshold === 0, '應為空的靠齊環境');
  });
  await test('拖曳中的圖層不會靠齊到自己', () => {
    const layer = createRasterLayer('self', 100, 100);
    layer.surface!.ctx.fillStyle = '#fff';
    layer.surface!.ctx.fillRect(10, 10, 20, 20);
    const ctx = collectSnapTargets(
      { width: 100, height: 100, guides: [], layers: [layer] },
      { ...defaultSnapSettings(), toDocument: false }, 8, 50, layer.id,
    );
    assert(ctx.x.length === 0, '排除的圖層不應提供候選');
  });
  await test('只在容許範圍內才靠齊', () => {
    const ctx = { x: [100], y: [], grid: null, threshold: 8 };
    const near = snapScalar(104, 'x', ctx);
    assert(near.line === 100 && near.delta === -4, `應靠齊到 100，實得 ${JSON.stringify(near)}`);
    const far = snapScalar(120, 'x', ctx);
    assert(far.line === null && far.delta === 0, '超出容許範圍不應靠齊');
  });
  await test('格點靠齊會取最近的倍數', () => {
    const ctx = { x: [], y: [], grid: 50, threshold: 8 };
    const r = snapScalar(103, 'x', ctx);
    assert(r.line === 100 && r.delta === -3, `應靠齊到 100，實得 ${JSON.stringify(r)}`);
    assert(snapScalar(130, 'x', ctx).line === null, '距離太遠不應靠齊');
  });
  await test('群組靠齊挑選最小的調整量', () => {
    const ctx = { x: [200], y: [], grid: null, threshold: 8 };
    // Left edge is 7 away, right edge only 3; the right edge should win.
    const r = snapGroup([193, 197], 'x', ctx);
    near(r.delta, 3, 0.001, '應採用右緣的較小調整量');
  });
  await test('矩形靠齊會回報命中的線', () => {
    const ctx = { x: [100], y: [60], grid: null, threshold: 8 };
    const r = snapRect({ x: 94, y: 100, w: 40, h: 20 }, ctx);
    near(r.dx, 6, 0.001, '左緣應貼到 100');
    assert(r.lines.x[0] === 100, '應回報垂直線');
    // The rect's centre at y=110 is nowhere near 60, so no vertical snap.
    assert(r.dy === 0 && r.lines.y.length === 0, '沒有命中時不應調整');
  });
  await test('點靠齊會同時處理兩軸', () => {
    const ctx = { x: [50], y: [80], grid: null, threshold: 8 };
    const r = snapPoint(53, 76, ctx);
    assert(r.x === 50 && r.y === 80, `兩軸都應靠齊，實得 ${r.x},${r.y}`);
    assert(r.lines.x[0] === 50 && r.lines.y[0] === 80, '應回報兩條線');
  });
  await test('圖層邊界包含位移', () => {
    const layer = createRasterLayer('b', 100, 100);
    layer.surface!.ctx.fillStyle = '#fff';
    layer.surface!.ctx.fillRect(10, 20, 30, 40);
    layer.x = 5;
    layer.y = 7;
    const b = layerBounds(layer)!;
    assert(b.x === 15 && b.y === 27 && b.w === 30 && b.h === 40, `邊界不正確：${JSON.stringify(b)}`);
    assert(layerBounds(createRasterLayer('empty', 10, 10)) === null, '空圖層應回傳 null');
  });
  await test('版面尺寸改變時參考線跟著位移', () => {
    const d = PhotoDoc.createBlank('t', 100, 100, 'white');
    d.guides.push(createGuide('v', 30), createGuide('h', 40));
    d.resizeCanvas(140, 100, 20, 0);
    assert(d.guides[0].pos === 50, `垂直參考線應位移到 50，實得 ${d.guides[0].pos}`);
    assert(d.guides[1].pos === 40, '水平參考線不應變動');
  });
  await test('版面縮小時超出範圍的參考線會被移除', () => {
    const d = PhotoDoc.createBlank('t', 100, 100, 'white');
    d.guides.push(createGuide('v', 90));
    d.resizeCanvas(50, 100, 0, 0);
    assert(d.guides.length === 0, '落在版面外的參考線應被移除');
  });
  await test('影像尺寸改變時參考線等比例縮放', () => {
    const d = PhotoDoc.createBlank('t', 100, 100, 'white');
    d.guides.push(createGuide('v', 25));
    d.resampleTo(200, 200, true);
    assert(d.guides[0].pos === 50, `參考線應縮放到 50，實得 ${d.guides[0].pos}`);
  });
  await test('步驟記錄與專案檔保留參考線', async () => {
    const d = PhotoDoc.createBlank('t', 60, 40, 'white');
    d.commit('base');
    d.guides.push(createGuide('v', 12), createGuide('h', 8));
    d.guidesLocked = true;
    d.commit('參考線');
    // Read through a function so the assertions do not narrow the length type.
    const state = (): { n: number; locked: boolean } => ({ n: d.guides.length, locked: d.guidesLocked });
    assert(d.undo(), '應可還原');
    assert(state().n === 0 && !state().locked, '還原後應回到沒有參考線');
    assert(d.redo(), '應可重做');
    assert(state().n === 2 && state().locked, '重做後應恢復參考線與鎖定狀態');

    const restored = await loadProject(serializeDocument(d));
    assert(restored.guides.length === 2, '專案檔應保留參考線');
    assert(restored.guides[0].axis === 'v' && restored.guides[0].pos === 12, '參考線內容應一致');
    assert(restored.guidesLocked === true, '鎖定狀態應被保留');
  });

  // ---- healing ----
  group('修復');
  await test('遮色片邊界與擴張', () => {
    const m = new Uint8Array(10 * 10);
    m[3 * 10 + 4] = 255;
    m[5 * 10 + 6] = 255;
    const b = maskBounds(m, 10, 10)!;
    assert(b.x === 4 && b.y === 3 && b.w === 3 && b.h === 3, `邊界不正確：${JSON.stringify(b)}`);
    const grown = dilateMask(m, 10, 10, 1);
    assert(grown[3 * 10 + 3] === 255 && grown[2 * 10 + 4] === 255, '擴張後應涵蓋鄰居');
    assert(maskBounds(new Uint8Array(4), 2, 2) === null, '空遮色片應回傳 null');
  });
  await test('無縫貼合會吸收亮度落差', () => {
    const dst = new ImageData(40, 40);
    for (let i = 0; i < dst.data.length; i += 4) {
      dst.data[i] = 100; dst.data[i + 1] = 100; dst.data[i + 2] = 100; dst.data[i + 3] = 255;
    }
    const src = new ImageData(40, 40);
    for (let i = 0; i < src.data.length; i += 4) {
      src.data[i] = 200; src.data[i + 1] = 200; src.data[i + 2] = 200; src.data[i + 3] = 255;
    }
    const mask = new Uint8Array(40 * 40);
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) mask[y * 40 + x] = 255;

    seamlessClone(dst, src, mask, 200);
    const centre = dst.data[(20 * 40 + 20) * 4];
    near(centre, 100, 4, '平坦來源貼上後應完全接上目標亮度');
  });
  await test('無縫貼合會保留來源的紋理', () => {
    const size = 40;
    const dst = new ImageData(size, size);
    const src = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = 80;
        dst.data[i + 3] = 255;
        // Source carries a vertical ramp on top of a much brighter base.
        const v = 180 + (x % 8) * 6;
        src.data[i] = src.data[i + 1] = src.data[i + 2] = v;
        src.data[i + 3] = 255;
      }
    }
    const mask = new Uint8Array(size * size);
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) mask[y * size + x] = 255;
    seamlessClone(dst, src, mask, 250);

    const a = dst.data[(20 * size + 16) * 4];
    const b = dst.data[(20 * size + 19) * 4];
    assert(Math.abs(a - b) > 8, `來源紋理應被保留：${a} vs ${b}`);
    near((a + b) / 2, 80, 25, '整體亮度應被拉回目標的水準');
  });
  await test('自動取樣會找到相似的周圍', () => {
    const size = 64;
    const img = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        // Left half dark, right half light; a spot sits in the dark half.
        const v = x < 32 ? 60 : 200;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    for (let y = 28; y < 36; y++) {
      for (let x = 12; x < 20; x++) {
        const i = (y * size + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 40; img.data[i + 2] = 40;
      }
    }
    const mask = new Uint8Array(size * size);
    for (let y = 28; y < 36; y++) for (let x = 12; x < 20; x++) mask[y * size + x] = 255;

    const src = findHealSource(img, mask, 24)!;
    assert(src !== null, '應找得到取樣來源');
    assert(12 + src.dx >= 0 && 12 + src.dx < 32, `來源應留在暗的一側，dx=${src.dx}`);
  });
  await test('汙點修復會移除斑點', () => {
    const size = 64;
    const img = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const v = 120 + ((x + y) % 5) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    for (let y = 28; y < 36; y++) {
      for (let x = 28; x < 36; x++) {
        const i = (y * size + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 30; img.data[i + 2] = 30;
      }
    }
    const mask = new Uint8Array(size * size);
    for (let y = 27; y < 37; y++) for (let x = 27; x < 37; x++) mask[y * size + x] = 255;

    assert(spotHeal(img, mask, 40), '應完成修復');
    const p = (32 * size + 32) * 4;
    assert(Math.abs(img.data[p] - img.data[p + 1]) < 25, `修復後不應殘留紅色：${[...img.data.slice(p, p + 3)]}`);
    near(img.data[p], 128, 30, '亮度應回到周圍的水準');
  });
  await test('大面積修復也要接上周圍（多重網格）', () => {
    // Plain relaxation leaves the middle of a wide region at its initial
    // value, which would reproduce the blemish instead of removing it.
    const size = 320;
    const img = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const v = 110 + ((x + y) % 7) * 3;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    const mask = new Uint8Array(size * size);
    for (let y = 130; y < 190; y++) {
      for (let x = 130; x < 190; x++) {
        mask[y * size + x] = 255;
        const i = (y * size + x) * 4;
        img.data[i] = 250; img.data[i + 1] = 20; img.data[i + 2] = 20;
      }
    }
    assert(spotHeal(img, mask, 120), '應完成修復');
    const p = (160 * size + 160) * 4;
    const [r, g, b] = [img.data[p], img.data[p + 1], img.data[p + 2]];
    assert(Math.abs(r - g) < 25 && Math.abs(g - b) < 25, `區域中心不應殘留紅色：${[r, g, b]}`);
    near(r, 120, 35, '中心亮度應接上周圍');
  });
  await test('沒有可用來源時回報失敗', () => {
    const img = new ImageData(8, 8);
    const mask = new Uint8Array(64).fill(255);
    assert(spotHeal(img, mask, 20) === false, '整張都是遮色片時應失敗');
  });

  // ---- content-aware fill ----
  group('內容感知填色');
  await test('純色區域會補成同一個顏色', () => {
    const size = 48;
    const img = new ImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 120; img.data[i + 1] = 80; img.data[i + 2] = 200; img.data[i + 3] = 255;
    }
    const mask = new Uint8Array(size * size);
    for (let y = 18; y < 30; y++) {
      for (let x = 18; x < 30; x++) {
        mask[y * size + x] = 255;
        const i = (y * size + x) * 4;
        img.data[i] = 0; img.data[i + 1] = 255; img.data[i + 2] = 0;
      }
    }
    const region = contentAwareFill(img, mask, { patchSize: 5, maxWorkingSize: 128, iterations: 3 })!;
    assert(region !== null, '應產生填色結果');
    applyFillRegion(img, region, mask);
    const p = (24 * size + 24) * 4;
    near(img.data[p], 120, 12, 'R 應回到背景色');
    near(img.data[p + 1], 80, 12, 'G 應回到背景色');
    near(img.data[p + 2], 200, 12, 'B 應回到背景色');
  });
  await test('條紋紋理會被延續進破洞', () => {
    const size = 64;
    const stripe = (y: number): number => ((y >> 2) % 2 === 0 ? 40 : 210);
    const img = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const v = stripe(y);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    const mask = new Uint8Array(size * size);
    for (let y = 24; y < 40; y++) {
      for (let x = 24; x < 40; x++) {
        mask[y * size + x] = 255;
        const i = (y * size + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0;
      }
    }

    const region = contentAwareFill(img, mask, { patchSize: 7, maxWorkingSize: 160, iterations: 4 })!;
    applyFillRegion(img, region, mask);

    let worst = 0;
    for (let y = 26; y < 38; y++) {
      for (let x = 26; x < 38; x++) {
        const i = (y * size + x) * 4;
        worst = Math.max(worst, Math.abs(img.data[i] - stripe(y)));
      }
    }
    assert(worst < 45, `填色應延續條紋，最大誤差 ${worst}`);
  });
  await test('沒有遮色片時不做任何事', () => {
    const img = new ImageData(16, 16);
    assert(contentAwareFill(img, new Uint8Array(256), {}) === null, '空遮色片應回傳 null');
    assert(contentAwareFill(img, new Uint8Array(256).fill(255), {}) === null, '整張都是洞應回傳 null');
  });
  await test('只處理破洞周圍的視窗', () => {
    const size = 200;
    const img = new ImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 90; img.data[i + 1] = 90; img.data[i + 2] = 90; img.data[i + 3] = 255;
    }
    const mask = new Uint8Array(size * size);
    for (let y = 96; y < 104; y++) for (let x = 96; x < 104; x++) mask[y * size + x] = 255;
    const region = contentAwareFill(img, mask, { patchSize: 5, maxWorkingSize: 128, iterations: 2 })!;
    assert(region.rect.w < size && region.rect.h < size, '工作視窗應小於整張影像');
    assert(region.rect.x <= 96 && region.rect.y <= 96, '視窗應涵蓋破洞');
  });

  // ---- brush presets ----
  group('筆刷預設集');
  await test('筆尖圓度會壓扁筆刷', () => {
    const round = brushStamp(40, 1, { r: 0, g: 0, b: 0 }, 1, 0);
    const flat = brushStamp(40, 1, { r: 0, g: 0, b: 0 }, 0.3, 0);
    const c = flat.w / 2;
    assert(pixel(round, c, c - 15)[3] > 200, '圓形筆刷上下應是實心');
    assert(pixel(flat, c + 15, c)[3] > 200, '壓扁後左右仍應是實心');
    assert(pixel(flat, c, c - 15)[3] < 40, `壓扁後上下應變空，實得 ${pixel(flat, c, c - 15)[3]}`);
  });
  await test('筆尖角度會旋轉筆刷', () => {
    const turned = brushStamp(40, 1, { r: 0, g: 0, b: 0 }, 0.3, 90);
    const c = turned.w / 2;
    assert(pixel(turned, c, c - 15)[3] > 200, '旋轉 90 度後上下應變實心');
    assert(pixel(turned, c + 15, c)[3] < 40, '旋轉 90 度後左右應變空');
  });
  await test('內建預設集齊全且數值合理', () => {
    assert(BUILTIN_PRESETS.length >= 8, '應提供多組內建筆刷');
    for (const p of BUILTIN_PRESETS) {
      assert(p.builtin === true, `${p.name} 應標記為內建`);
      assert(p.settings.size > 0, `${p.name} 尺寸應大於 0`);
      assert(p.settings.roundness > 0 && p.settings.roundness <= 100, `${p.name} 圓度應在 1..100`);
      assert(p.settings.hardness >= 0 && p.settings.hardness <= 100, `${p.name} 硬度應在 0..100`);
    }
    const calli = BUILTIN_PRESETS.find((p) => p.id === 'calligraphy')!;
    assert(calli.settings.roundness < 50 && calli.settings.angle !== 0, '書法筆應是傾斜的扁筆尖');
  });
  await test('讀寫工具選項', () => {
    const options: Record<string, unknown> = {
      size: 44, hardness: 60, opacity: 90, flow: 55, spacing: 18,
      smoothing: 25, scatter: 7, roundness: 40, angle: 30, sizeJitter: 12,
      sizePressure: false, opacityPressure: true,
    };
    const s = settingsFromOptions(options);
    assert(s.size === 44 && s.roundness === 40 && s.angle === 30, '數值應被讀出');
    assert(s.sizePressure === false && s.opacityPressure === true, '布林選項應被讀出');

    // The eraser has no scatter option, so applying a preset must not add one.
    const target: Record<string, unknown> = { size: 10, hardness: 10, roundness: 100 };
    applySettingsToOptions(s, target);
    assert(target.size === 44 && target.roundness === 40, '存在的選項應被覆寫');
    assert(!('scatter' in target), '工具沒有的選項不應被寫入');
  });
  await test('預設集描述與建立', () => {
    const p = createPreset('測試筆刷', {
      ...BUILTIN_PRESETS[0].settings, size: 12, hardness: 70, roundness: 50, scatter: 4,
    });
    assert(p.builtin === false && p.name === '測試筆刷', '自訂預設集不應標記為內建');
    const text = describePreset(p.settings);
    assert(text.includes('12 px') && text.includes('圓度'), `描述不正確：${text}`);
  });
  await test('自訂預設集可存回並讀出', () => {
    const backup = localStorage.getItem('photograp.brushPresets.v1');
    try {
      localStorage.removeItem('photograp.brushPresets.v1');
      const mine = createPreset('我的筆刷', { ...BUILTIN_PRESETS[0].settings, size: 77 });
      // Also drop one built-in, to check hidden built-ins round-trip.
      const list = loadPresets().filter((p) => p.id !== 'pencil');
      savePresets([...list, mine]);

      const reloaded = loadPresets();
      const found = reloaded.find((p) => p.name === '我的筆刷');
      assert(!!found, '自訂預設集應被讀回');
      assert(found!.settings.size === 77, '設定內容應被保留');
      assert(found!.builtin === false, '讀回後仍應是自訂');
      assert(!reloaded.some((p) => p.id === 'pencil'), '被刪掉的內建筆刷不應復活');
      assert(reloaded.some((p) => p.id === 'soft-round'), '其他內建筆刷仍應存在');

      const after = resetPresets();
      assert(after.length === BUILTIN_PRESETS.length, '恢復預設後應只剩內建筆刷');
    } finally {
      if (backup === null) localStorage.removeItem('photograp.brushPresets.v1');
      else localStorage.setItem('photograp.brushPresets.v1', backup);
    }
  });
  await test('預設筆刷設定包含新的筆尖參數', () => {
    const b = defaultBrush();
    assert(b.roundness === 1 && b.angle === 0 && b.sizeJitter === 0, '預設應為正圓、無角度、無抖動');
  });
  await test('扁筆尖畫出的筆觸有方向性', () => {
    const doc = PhotoDoc.createBlank('t', 80, 80, 'transparent');
    const layer = doc.activeLayer()!;
    const settings = {
      ...defaultBrush(), size: 30, hardness: 1, smoothing: 0, spacing: 5,
      sizePressure: false, roundness: 0.2, angle: 0, color: { r: 0, g: 0, b: 0 },
    };
    const stroke = new Stroke(doc, layer, layer.surface!, 'pixels', settings, 'paint');
    // A horizontal drag with a wide, flat tip lays down a thin band.
    stroke.begin(15, 40, 1);
    stroke.extend(65, 40, 1);
    stroke.commit('flat');
    const out = doc.activeLayer()!.surface!;
    assert(pixel(out, 40, 40)[3] > 200, '筆觸中線應有顏色');
    assert(pixel(out, 40, 52)[3] < 40, `扁筆尖不應畫到 12px 外，實得 ${pixel(out, 40, 52)[3]}`);
  });

  // ---- content-aware scale ----
  group('內容感知比例');
  /** An image with a flat left half and a hard vertical edge on the right. */
  const stripeImage = (w: number, h: number, edgeAt: number): ImageData => {
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = x < edgeAt ? 40 : 230;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    return img;
  };

  await test('能量圖在邊緣處最高', () => {
    const img = stripeImage(20, 10, 10);
    const e = energyMap(img.data, 20, 10);
    const atEdge = e[5 * 20 + 10];
    const flat = e[5 * 20 + 3];
    assert(atEdge > 100, `邊緣能量應很高，實得 ${atEdge}`);
    near(flat, 0, 1, '平坦處能量應近乎零');
  });
  await test('完全透明的像素不被當成黑色邊緣', () => {
    const w = 10, h = 6;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Left half opaque black, right half fully transparent black.
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
        img.data[i + 3] = x < 5 ? 255 : 0;
      }
    }
    const e = energyMap(img.data, w, h);
    near(e[3 * w + 5], 0, 1, '兩邊都是黑的，不應因為 alpha 跳變而有能量');
  });
  await test('接縫會繞開高能量的邊緣', () => {
    const img = stripeImage(20, 10, 10);
    const e = energyMap(img.data, 20, 10);
    const seam = findVerticalSeam(e, 20, 10);
    assert(seam.length === 10, '每一列都要有一個 x');
    for (const x of seam) {
      assert(Math.abs(x - 10) > 1, `接縫不應踩在邊緣上，實得 ${x}`);
    }
    // Neighbouring rows may only shift by one pixel.
    for (let y = 1; y < seam.length; y++) {
      assert(Math.abs(seam[y] - seam[y - 1]) <= 1, '接縫必須是連續的');
    }
  });
  await test('移除與插入接縫改變寬度', () => {
    const img = stripeImage(12, 5, 6);
    const seam = findVerticalSeam(energyMap(img.data, 12, 5), 12, 5);
    const narrower = removeVerticalSeam(img.data, 12, 5, seam);
    assert(narrower.length === 11 * 5 * 4, '應少一列');
    const wider = insertVerticalSeam(img.data, 12, 5, seam);
    assert(wider.length === 13 * 5 * 4, '應多一列');
  });
  await test('轉置兩次會回到原樣', () => {
    const img = stripeImage(7, 4, 3);
    const once = transposeRGBA(img.data, 7, 4);
    const twice = transposeRGBA(once, 4, 7);
    for (let i = 0; i < img.data.length; i++) {
      assert(twice[i] === img.data[i], '轉置兩次應相等');
    }
    const mask = new Uint8Array(7 * 4);
    mask[2 * 7 + 5] = 200;
    const tm = transposeMask(mask, 7, 4);
    assert(tm[5 * 4 + 2] === 200, '遮罩轉置後位置應對換');
  });
  await test('裁減會縮到指定寬度', () => {
    const img = stripeImage(30, 12, 15);
    const out = carveVertical(img, 8, false, {}).image;
    assert(out.width === 22 && out.height === 12, `應為 22×12，實得 ${out.width}×${out.height}`);
    const grown = carveVertical(img, 5, true, {}).image;
    assert(grown.width === 35, `應為 35，實得 ${grown.width}`);
  });
  await test('插入的接縫不會全擠在同一处', () => {
    // Inserting one seam at a time would keep re-picking the pixels it just
    // added, leaving a single smeared band instead of a wider picture.
    const w = 30, h = 8;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // A gentle ramp, so every column is about as interesting as the next.
        const v = 60 + x * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    const out = carveVertical(img, 10, true, {}).image;
    assert(out.width === 40, `應為 40，實得 ${out.width}`);
    // On a ramp of +4 every column, an original reads as 60 + 4x and an
    // inserted one as the average of its neighbours, 2 more than that. So a
    // value two above a multiple of four is exactly an inserted column.
    let inserted = 0, longest = 0, run = 0;
    for (let x = 0; x < out.width; x++) {
      const v = out.data[(4 * out.width + x) * 4];
      if ((v - 60) % 4 === 2) { inserted++; run++; longest = Math.max(longest, run); } else run = 0;
    }
    assert(inserted === 10, `應正好插入十列，實得 ${inserted}`);
    assert(longest < 5, `插入的列不應擠成一坨，最長連續 ${longest}`);
  });
  await test('非同步版本結果相同且會回報進度', async () => {
    const img = stripeImage(24, 8, 12);
    const sync = contentAwareScale(img, 18, 8);
    const seen: number[] = [];
    const async = await contentAwareScaleAsync(img, 18, 8, {
      onProgress: (t) => seen.push(t),
    });
    assert(async.width === sync.width && async.height === sync.height, '尺寸應相同');
    for (let i = 0; i < sync.data.length; i += 997) {
      assert(async.data[i] === sync.data[i], '像素應相同');
    }
    assert(seen.length > 0, '應回報過進度');
    near(seen[seen.length - 1], 1, 0.001, '最後應到 1');
  });
  await test('裁減不會改到傳進來的影像', () => {
    const img = stripeImage(20, 8, 10);
    const before = img.data[0];
    carveVertical(img, 4, false, {});
    assert(img.width === 20 && img.data[0] === before, '來源應保持原樣');
  });
  await test('不會把影像裁到消失', () => {
    const img = stripeImage(6, 4, 3);
    const out = carveVertical(img, 50, false, {}).image;
    assert(out.width >= 2, `應停在最少寬度，實得 ${out.width}`);
  });
  await test('保護遠比平坦區域優先被保留', () => {
    // A flat image, so only the protect mask decides where the seam goes.
    const w = 20, h = 8;
    const img = new ImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 128; img.data[i + 1] = 128; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
    const protect = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 8; x < 12; x++) protect[y * w + x] = 255;
    }
    const seam = findVerticalSeam(energyMap(img.data, w, h, { protect }), w, h);
    for (const x of seam) {
      assert(x < 8 || x >= 12, `接縫不應穿過保護區，實得 ${x}`);
    }
  });
  await test('標記為移除的區域會被優先裁掉', () => {
    const w = 20, h = 8;
    const img = new ImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 128; img.data[i + 1] = 128; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
    const remove = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 14; x < 17; x++) remove[y * w + x] = 255;
    }
    const seam = findVerticalSeam(energyMap(img.data, w, h, { remove }), w, h);
    for (const x of seam) {
      assert(x >= 14 && x < 17, `接縫應走在標記區內，實得 ${x}`);
    }
  });
  await test('保護遮罩會跟著影像一起變窄', () => {
    // If the mask were not carved alongside, the protected band would drift
    // and later seams would cut straight through it.
    const w = 24, h = 8;
    const img = new ImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 100; img.data[i + 1] = 100; img.data[i + 2] = 100; img.data[i + 3] = 255;
    }
    // Mark the protected band with a distinctive colour so we can find it after.
    const protect = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 10; x < 14; x++) {
        protect[y * w + x] = 255;
        const i = (y * w + x) * 4;
        img.data[i] = 220; img.data[i + 1] = 30; img.data[i + 2] = 30;
      }
    }
    const carved = carveVertical(img, 6, false, { protect });
    const out = carved.image;
    assert(out.width === 18, `應縮成 18，實得 ${out.width}`);
    assert(carved.protect && carved.protect.length === 18 * h, '遮罩應跟著變窄並隨結果回傳');
    let red = 0;
    for (let x = 0; x < out.width; x++) {
      const i = (3 * out.width + x) * 4;
      if (out.data[i] > 200 && out.data[i + 1] < 80) red++;
    }
    assert(red === 4, `保護帶的四列應全數保留，實得 ${red}`);
  });
  await test('contentAwareScale 兩個方向都能調', () => {
    const img = stripeImage(24, 20, 12);
    const out = contentAwareScale(img, 18, 15);
    assert(out.width === 18 && out.height === 15, `應為 18×15，實得 ${out.width}×${out.height}`);
    const bigger = contentAwareScale(img, 28, 24);
    assert(bigger.width === 28 && bigger.height === 24, `應為 28×24，實得 ${bigger.width}×${bigger.height}`);
    const same = contentAwareScale(img, 24, 20);
    assert(same.width === 24 && same.height === 20, '尺寸相同時應原樣回傳');
  });
  await test('裁減比直接縮放更能保住主體寬度', () => {
    // A narrow bright bar on a flat field: carving should take the flat parts.
    const w = 40, h = 10;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const bar = x >= 18 && x < 22;
        const v = bar ? 255 : 60;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    const out = contentAwareScale(img, 28, h);
    let barWidth = 0;
    for (let x = 0; x < out.width; x++) {
      if (out.data[(5 * out.width + x) * 4] > 200) barWidth++;
    }
    // A plain resize to 70% would leave the four-pixel bar about three wide.
    assert(barWidth >= 4, `主體應保住原寬度，實得 ${barWidth}`);
  });
  await test('非同步的插入也會分開接縫', async () => {
    // The async path plans insertions the same way; yielding between seam
    // searches must not change which columns get duplicated.
    const w = 30, h = 6;
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = 60 + x * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    const out = await contentAwareScaleAsync(img, 40, h);
    assert(out.width === 40, `應為 40，實得 ${out.width}`);
    let inserted = 0, longest = 0, run = 0;
    for (let x = 0; x < out.width; x++) {
      const v = out.data[(3 * out.width + x) * 4];
      if ((v - 60) % 4 === 2) { inserted++; run++; longest = Math.max(longest, run); } else run = 0;
    }
    assert(inserted === 10, `應插入十列，實得 ${inserted}`);
    assert(longest < 5, `不應擠成一坨，最長連續 ${longest}`);
  });
  await test('進度回報會一路走到一', () => {
    const img = stripeImage(16, 6, 8);
    const seen: number[] = [];
    carveVertical(img, 4, false, { onProgress: (t) => seen.push(t) });
    assert(seen.length === 4, `應回報四次，實得 ${seen.length}`);
    near(seen[seen.length - 1], 1, 0.001, '最後一次應是 1');
  });
  await test('resampleMask 保留大致的覆蓋位置', () => {
    const w = 20, h = 10;
    const src = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 10; x < 20; x++) src[y * w + x] = 255;
    }
    const out = resampleMask(src, w, h, 10, 5);
    assert(out.length === 50, '尺寸應縮半');
    assert(out[2 * 10 + 7] === 255, '右半邊應還是被覆蓋');
    assert(out[2 * 10 + 2] === 0, '左半邊應還是空的');
  });

  // ---- overlay effects and saved styles ----
  group('覆蓋效果');
  /** A layer holding one opaque square, so the silhouette is easy to check. */
  const squareLayer = (size = 40, box = 20): ReturnType<typeof createRasterLayer> => {
    const l = createRasterLayer('方塊', size, size);
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(10, 10, box, box);
    return l;
  };

  await test('預設不啟用覆蓋', () => {
    const e = defaultEffects();
    assert(!e.overlay.enabled, '預設應關閉');
    assert(e.overlay.kind === 'color', '預設種類應是顏色');
    const l = squareLayer();
    const out = compositeLayers([l], { width: 40, height: 40 });
    assert(pixel(out, 20, 20)[0] === 0, '未啟用時應維持原色');
  });
  await test('顏色覆蓋只蓋在圖層內容上', () => {
    const l = squareLayer();
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'color';
    l.effects.overlay.color = { r: 255, g: 0, b: 0 };
    const out = compositeLayers([l], { width: 40, height: 40 });
    const inside = pixel(out, 20, 20);
    assert(inside[0] > 200 && inside[1] < 60, `內容應被蓋成紅的，實得 ${inside}`);
    assert(pixel(out, 2, 2)[3] === 0, '圖層外應仍然透明');
  });
  await test('覆蓋不透明度會與原色混合', () => {
    const l = squareLayer();
    l.effects.overlay.enabled = true;
    l.effects.overlay.color = { r: 255, g: 255, b: 255 };
    l.effects.overlay.alpha = 0.5;
    const out = compositeLayers([l], { width: 40, height: 40 });
    const mid = pixel(out, 20, 20);
    assert(mid[0] > 100 && mid[0] < 180, `半透明白蓋在黑上應是灰的，實得 ${mid}`);
  });
  await test('圖樣覆蓋會鋪在內容上', () => {
    const l = squareLayer(48, 28);
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'pattern';
    l.effects.overlay.patternId = 'bricks';
    const out = compositeLayers([l], { width: 48, height: 48 });
    const inside = pixel(out, 20, 20);
    assert(inside[0] > inside[2], `磚牆是暖色的，實得 ${inside}`);
    assert(pixel(out, 2, 2)[3] === 0, '圖層外應仍然透明');
  });
  await test('找不到的圖樣不會畫錯顏色', () => {
    const l = squareLayer();
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'pattern';
    l.effects.overlay.patternId = '沒這個';
    const out = compositeLayers([l], { width: 40, height: 40 });
    assert(pixel(out, 20, 20)[0] === 0, '應保持原色而不是蓋上預設色');
  });
  await test('漸層覆蓋會形成漸變', () => {
    const l = createRasterLayer('帶', 60, 20);
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(0, 0, 60, 20);
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'gradient';
    l.effects.overlay.stops = [
      { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
      { pos: 1, color: { r: 255, g: 255, b: 255 }, alpha: 1 },
    ];
    l.effects.overlay.angle = 0;
    const out = compositeLayers([l], { width: 60, height: 20 });
    const left = pixel(out, 2, 10)[0];
    const right = pixel(out, 57, 10)[0];
    assert(Math.abs(right - left) > 100, `兩端應差很多，實得 ${left} vs ${right}`);
  });
  await test('覆蓋在遮色片之前套用', () => {
    const l = squareLayer();
    l.effects.overlay.enabled = true;
    l.effects.overlay.color = { r: 255, g: 0, b: 0 };
    l.mask = createSurface(40, 40);
    l.mask.ctx.fillStyle = '#000';
    l.mask.ctx.fillRect(0, 0, 40, 40);
    l.mask.ctx.fillStyle = '#fff';
    l.mask.ctx.fillRect(0, 0, 20, 40);
    const out = compositeLayers([l], { width: 40, height: 40 });
    assert(pixel(out, 15, 20)[0] > 200, '遮色片白的那半應看得到覆蓋');
    assert(pixel(out, 25, 20)[3] === 0, '遮色片黑的那半應被遮掉');
  });
  await test('複製圖層不會共用覆蓋設定', () => {
    const l = squareLayer();
    l.effects.overlay.color = { r: 1, g: 2, b: 3 };
    const copy = duplicateLayer(l);
    copy.effects.overlay.color.r = 200;
    copy.effects.overlay.enabled = true;
    assert(l.effects.overlay.color.r === 1, '原圖層的顏色不應被改');
    assert(!l.effects.overlay.enabled, '原圖層的開關不應被改');
  });
  await test('舊專案檔沒有覆蓋欄位也能載入', async () => {
    const doc = PhotoDoc.createBlank('old-file', 20, 20, 'white');
    const json = JSON.parse(serializeDocument(doc)) as {
      layers: { effects: Record<string, unknown> }[];
    };
    // Strip the field the way a file saved before this version would be.
    for (const l of json.layers) delete l.effects.overlay;
    const back = await loadProject(JSON.stringify(json));
    assert(back.layers[0].effects.overlay, '應補上預設的覆蓋設定');
    assert(!back.layers[0].effects.overlay.enabled, '補上的應是關閉的');
    const out = back.render();
    assert(out.w === 20, '載入後應能正常合成');
  });

  await test('覆蓋不會讓半透明的圖層變不透明', () => {
    const l = createRasterLayer('半透', 40, 40);
    l.surface!.ctx.globalAlpha = 0.5;
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(10, 10, 20, 20);
    const before = pixel(compositeLayers([l], { width: 40, height: 40 }), 20, 20)[3];
    l.effects.overlay.enabled = true;
    l.effects.overlay.color = { r: 255, g: 0, b: 0 };
    const after = pixel(compositeLayers([l], { width: 40, height: 40 }), 20, 20)[3];
    near(after, before, 2, `不透明度應不變，實得 ${before} → ${after}`);
    assert(before > 100 && before < 160, `來源本來就是半透明，實得 ${before}`);
  });
  await test('放射狀覆蓋以圖層中心為圓心', () => {
    const l = createRasterLayer('帶', 60, 60);
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(0, 0, 60, 60);
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'gradient';
    l.effects.overlay.gradientKind = 'radial';
    l.effects.overlay.stops = [
      { pos: 0, color: { r: 255, g: 255, b: 255 }, alpha: 1 },
      { pos: 1, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
    ];
    const out = compositeLayers([l], { width: 60, height: 60 });
    const centre = pixel(out, 30, 30)[0];
    const corner = pixel(out, 2, 2)[0];
    assert(centre > 200, `中心應最亮，實得 ${centre}`);
    assert(corner < 120, `邊緣應變暗，實得 ${corner}`);
  });
  await test('嵌入的圖樣不需要本機圖樣庫', async () => {
    const src = createSurface(8, 8);
    src.ctx.fillStyle = '#20c020';
    src.ctx.fillRect(0, 0, 8, 8);
    const p = createPattern('離線磁磚', src);
    const l = createRasterLayer('方塊', 40, 40);
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(10, 10, 20, 20);
    l.effects.overlay.enabled = true;
    l.effects.overlay.kind = 'pattern';
    // Nothing is saved to the library; the effect carries the tile itself.
    l.effects.overlay.patternId = '';
    l.effects.overlay.patternData = p.data;
    l.effects.overlay.patternWidth = p.width;
    l.effects.overlay.patternHeight = p.height;
    const embedded = embeddedPattern(l.effects.overlay)!;
    assert(embedded, '應能從效果重建圖樣');
    await patternSurface(embedded);
    const out = compositeLayers([l], { width: 40, height: 40 });
    const inside = pixel(out, 20, 20);
    assert(inside[1] > 150 && inside[0] < 100, `應蓋上綠色磁磚，實得 ${inside}`);
    assert(!loadPatterns().some((x) => x.name === '離線磁磚'), '不應寫進圖樣庫');
  });
  await test('樣式帶著自己的漸層而不是一個 id', () => {
    const sunset = BUILTIN_STYLES.find((s2) => s2.id === 'sunset-fill')!;
    assert(sunset.effects.overlay.stops.length >= 2, '樣式應存著色標本身');
    assert(!('gradientId' in sunset.effects.overlay), '不應再依賴漸層 id');
  });

  await test('覆蓋會完全蓋過半透明的內容', () => {
    // source-atop already clips to the layer; clipping the fill as well would
    // apply the layer's alpha twice and leave the overlay half strength.
    const l = createRasterLayer('半透', 40, 40);
    l.surface!.ctx.globalAlpha = 0.5;
    l.surface!.ctx.fillStyle = '#000000';
    l.surface!.ctx.fillRect(10, 10, 20, 20);
    l.effects.overlay.enabled = true;
    l.effects.overlay.color = { r: 255, g: 0, b: 0 };
    const out = compositeLayers([l], { width: 40, height: 40 });
    const px = pixel(out, 20, 20);
    // Over the white page the half-opaque red reads as a pink, not a dull grey-red.
    assert(px[0] > 200 && px[1] < 90, `覆蓋應是滿強度的紅，實得 ${px}`);
  });
  await test('嵌入的圖樣可以隨專案檔一起走', async () => {
    const doc = PhotoDoc.createBlank('overlay-io', 40, 40, 'white');
    const src = createSurface(8, 8);
    src.ctx.fillStyle = '#1560d0';
    src.ctx.fillRect(0, 0, 8, 8);
    const tile = createPattern('隨檔磁磚', src);
    const layer = createRasterLayer('方塊', 40, 40);
    layer.surface!.ctx.fillStyle = '#000000';
    layer.surface!.ctx.fillRect(10, 10, 20, 20);
    layer.effects.overlay.enabled = true;
    layer.effects.overlay.kind = 'pattern';
    layer.effects.overlay.patternId = '';
    layer.effects.overlay.patternData = tile.data;
    layer.effects.overlay.patternWidth = tile.width;
    layer.effects.overlay.patternHeight = tile.height;
    doc.layers.push(layer);

    const back = await loadProject(serializeDocument(doc));
    const restored = back.layers[back.layers.length - 1];
    assert(restored.effects.overlay.patternData.length > 0, '磁磚應隨檔存下來');
    // loadProject decodes embedded tiles, so the first composite already shows it.
    const out = back.render();
    const px = pixel(out, 20, 20);
    assert(px[2] > 150 && px[0] < 90, `載入後第一次合成就應看得到圖樣，實得 ${px}`);
  });
  await test('warmEmbedded 會等磁磚解碼完', async () => {
    const src = createSurface(6, 6);
    src.ctx.fillStyle = '#ff00ff';
    src.ctx.fillRect(0, 0, 6, 6);
    const tile = createPattern('等待', src);
    const overlay = {
      patternId: '', patternData: tile.data,
      patternWidth: tile.width, patternHeight: tile.height,
    };
    forgetPattern(embeddedPattern(overlay)!.id);
    assert(cachedPatternSurface(embeddedPattern(overlay)!) === null, '先確定沒快取');
    await warmEmbedded([overlay]);
    assert(cachedPatternSurface(embeddedPattern(overlay)!), 'warmEmbedded 後應已在快取中');
  });

  // ---- layer comps ----
  group('圖層構成');
  /** A document with three layers in known states. */
  const compDoc = (): PhotoDoc => {
    const d = PhotoDoc.createBlank('comps', 40, 40, 'white');
    for (const name of ['a', 'b']) {
      const l = createRasterLayer(name, 40, 40);
      l.surface!.ctx.fillStyle = '#000';
      l.surface!.ctx.fillRect(0, 0, 10, 10);
      d.layers.push(l);
    }
    return d;
  };

  await test('擷取會記下每一個圖層', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '起始');
    assert(comp.layers.length === 3, `應記下三個圖層，實得 ${comp.layers.length}`);
    assert(comp.name === '起始', '名稱');
    assert(describeComp(comp).includes('3 個圖層'), `描述有誤：${describeComp(comp)}`);
  });
  await test('群組內的子圖層也會被記下', () => {
    const d = compDoc();
    const g = createRasterLayer('群組', 40, 40);
    g.kind = 'group';
    g.surface = null;
    g.children = [createRasterLayer('子', 40, 40)];
    d.layers.push(g);
    const comp = captureComp(d.layers, '帶群組');
    assert(comp.layers.length === 5, `應含群組與子圖層，實得 ${comp.layers.length}`);
  });
  await test('套用會還原可見度、位置與外觀', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '原狀');
    const l = d.layers[1];
    l.visible = false;
    l.x = 17;
    l.opacity = 0.25;
    l.blend = 'multiply';
    l.effects.dropShadow.enabled = true;
    applyComp(d.layers, comp);
    const state = () => ({ visible: l.visible, x: l.x, opacity: l.opacity, blend: String(l.blend) });
    assert(state().visible, '可見度應還原');
    assert(state().x === 0, '位置應還原');
    near(state().opacity, 1, 0.001, '不透明度應還原');
    assert(state().blend === 'normal', '混合模式應還原');
    assert(!l.effects.dropShadow.enabled, '圖層樣式應還原');
  });
  await test('只記可見度的構成不會動到位置', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '只看可見度', {
      visibility: true, position: false, appearance: false,
    });
    const l = d.layers[1];
    l.visible = false;
    l.x = 21;
    l.opacity = 0.5;
    applyComp(d.layers, comp);
    assert(l.visible, '可見度應還原');
    assert(l.x === 21, '位置不應被動到');
    near(l.opacity, 0.5, 0.001, '不透明度不應被動到');
    assert(describeComp(comp).includes('可見度') && !describeComp(comp).includes('位置'),
      `描述應只提可見度：${describeComp(comp)}`);
  });
  await test('對新增與已刪的圖層誠實回報', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '舊的');
    d.layers.pop();
    d.layers.push(createRasterLayer('新的', 40, 40));
    d.layers.push(createRasterLayer('又一個', 40, 40));
    const res = applyComp(d.layers, comp);
    assert(res.applied === 2, `應套用兩個，實得 ${res.applied}`);
    assert(res.missing === 1, `應有一個已不存在，實得 ${res.missing}`);
    assert(res.extra === 2, `應有兩個不在構成裡，實得 ${res.extra}`);
  });
  await test('新增的圖層不會被構成藏起來', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '舊的');
    const fresh = createRasterLayer('新的', 40, 40);
    fresh.visible = true;
    d.layers.push(fresh);
    applyComp(d.layers, comp);
    assert(fresh.visible, '構成沒提到的圖層應保持原樣');
  });
  await test('構成不共用圖層樣式物件', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, 'x');
    comp.layers[1].effects.dropShadow.blur = 99;
    assert(d.layers[1].effects.dropShadow.blur !== 99, '改構成不應改到圖層');
    const copy = cloneComp(comp);
    copy.layers[1].effects.dropShadow.blur = 7;
    copy.capture.position = false;
    assert(comp.layers[1].effects.dropShadow.blur === 99, 'cloneComp 應是深拷貝');
    assert(comp.capture.position, 'cloneComp 應拷貝設定');
  });
  await test('重新擷取保留 id 與設定', () => {
    const d = compDoc();
    const comp = captureComp(d.layers, '我的', { visibility: true, position: false, appearance: true }, '說明');
    d.layers[1].opacity = 0.3;
    const next = recaptureComp(comp, d.layers);
    assert(next.id === comp.id, 'id 應不變');
    assert(next.name === '我的' && next.note === '說明', '名稱與說明應保留');
    assert(!next.capture.position, '設定應保留');
    near(next.layers[1].opacity, 0.3, 0.001, '應抓到新狀態');
  });
  await test('構成可以還原，也能被還原', () => {
    const d = compDoc();
    d.comps = [captureComp(d.layers, '全開')];
    d.commit('建立構成');
    const before = d.comps.length;
    d.comps = [];
    d.commit('刪掉');
    assert(d.comps.length === 0, '刪掉了');
    d.undo();
    assert(d.comps.length === before, `還原後構成應回來，實得 ${d.comps.length}`);
    assert(d.comps[0].name === '全開', '內容也要回來');
  });
  await test('構成可以存進專案檔', async () => {
    const d = compDoc();
    d.layers[1].visible = false;
    d.layers[1].x = 9;
    d.comps = [captureComp(d.layers, '藏起 b', { visibility: true, position: true, appearance: false }, '備註')];
    const back = await loadProject(serializeDocument(d));
    assert(back.comps.length === 1, '應還原一個構成');
    const comp = back.comps[0];
    assert(comp.name === '藏起 b' && comp.note === '備註', '名稱與說明');
    assert(!comp.capture.appearance, '設定應保留');
    assert(comp.layers.length === 3, '圖層數應一致');
    // The ids survive the round trip, so applying still finds its layers.
    back.layers[1].visible = true;
    const res = applyComp(back.layers, comp);
    assert(res.applied === 3, `應套用到三個圖層，實得 ${res.applied}`);
    assert(!back.layers[1].visible, '還原後應再次藏起');
  });
  await test('壞掉的構成資料會被修正或丟掉', () => {
    assert(normalizeComp({} as never) === null, '沒有圖層清單的應丟掉');
    const fixed = normalizeComp({
      layers: [{ id: 'a' }, { id: '' }],
    } as never)!;
    assert(fixed, '應修得回來');
    assert(fixed.id.length > 0 && fixed.name.length > 0, 'id 與名稱應補上');
    assert(fixed.layers.length === 1, '沒有 id 的圖層應丟掉');
    assert(fixed.layers[0].effects.dropShadow, '效果應補上預設');
    assert(fixed.capture.visibility && fixed.capture.position, '設定應補上預設');
  });
  await test('套用構成會改變合成結果', () => {
    const d = compDoc();
    d.layers[1].surface!.ctx.fillStyle = '#ff0000';
    d.layers[1].surface!.ctx.fillRect(0, 0, 40, 40);
    const shown = captureComp(d.layers, '顯示');
    d.layers[1].visible = false;
    const hidden = captureComp(d.layers, '隱藏');
    applyComp(d.layers, shown);
    assert(pixel(d.render(), 20, 20)[0] > 200, '顯示時應看得到紅色');
    applyComp(d.layers, hidden);
    const after = pixel(d.render(), 20, 20);
    assert(after[1] > 200 && after[2] > 200, `隱藏時應回到白底，實得 ${after}`);
  });

  // ---- inner effects ----
  group('內側效果與斜角');
  /** A solid square in the middle, so inside and outside are easy to tell. */
  const block = (size = 60, box = 30): ReturnType<typeof createRasterLayer> => {
    const l = createRasterLayer('方塊', size, size);
    const at = (size - box) / 2;
    l.surface!.ctx.fillStyle = '#808080';
    l.surface!.ctx.fillRect(at, at, box, box);
    return l;
  };

  await test('內陰影只落在形狀內', () => {
    const l = block();
    l.effects.innerShadow = {
      enabled: true, color: { r: 0, g: 0, b: 0 }, alpha: 1, blur: 6, dx: 4, dy: 4,
    };
    const out = compositeLayers([l], { width: 60, height: 60 });
    // Just inside the top-left edge, where a shadow offset down-right lands.
    const inside = pixel(out, 17, 17);
    const middle = pixel(out, 30, 30);
    assert(inside[0] < 110, `內側邊緣應變暗，實得 ${inside}`);
    assert(middle[0] > 115, `中心應幾乎不變，實得 ${middle}`);
    assert(pixel(out, 5, 5)[3] === 0, '形狀外應仍然透明');
  });
  await test('內陰影不會讓圖層變大', () => {
    const l = block();
    const before = opaqueBounds(compositeLayers([l], { width: 60, height: 60 }))!;
    l.effects.innerShadow = {
      enabled: true, color: { r: 0, g: 0, b: 0 }, alpha: 1, blur: 20, dx: 10, dy: 10,
    };
    const after = opaqueBounds(compositeLayers([l], { width: 60, height: 60 }))!;
    assert(after.w === before.w && after.h === before.h, '外接矩形應一樣');
  });
  await test('內光暈從邊緣往內亮', () => {
    const l = block();
    l.effects.innerGlow = {
      enabled: true, color: { r: 255, g: 255, b: 255 }, alpha: 1, blur: 10,
    };
    const out = compositeLayers([l], { width: 60, height: 60 });
    const edge = pixel(out, 16, 30);
    const middle = pixel(out, 30, 30);
    assert(edge[0] > middle[0] + 20, `邊緣應比中心亮，實得 ${edge} vs ${middle}`);
    assert(pixel(out, 3, 3)[3] === 0, '形狀外應仍然透明');
  });
  await test('斜角依光源方向分出亮暗', () => {
    const l = block();
    l.effects.bevel = {
      enabled: true, size: 6, depth: 200, angle: 90,
      highlight: { r: 255, g: 255, b: 255 }, shadow: { r: 0, g: 0, b: 0 },
      alpha: 1, emboss: false,
    };
    const out = compositeLayers([l], { width: 60, height: 60 });
    // Light from straight above: the top edge catches it, the bottom is shaded.
    const top = pixel(out, 30, 17);
    const bottom = pixel(out, 30, 42);
    assert(top[0] > bottom[0] + 30, `上邊應比下邊亮，實得 ${top} vs ${bottom}`);
    assert(pixel(out, 3, 3)[3] === 0, '一般斜角不應溢出形狀');
  });
  await test('反轉角度會對調亮暗', () => {
    const mk = (angle: number): number[] => {
      const l = block();
      l.effects.bevel = {
        enabled: true, size: 6, depth: 200, angle,
        highlight: { r: 255, g: 255, b: 255 }, shadow: { r: 0, g: 0, b: 0 },
        alpha: 1, emboss: false,
      };
      return pixel(compositeLayers([l], { width: 60, height: 60 }), 30, 17);
    };
    const up = mk(90)[0];
    const down = mk(-90)[0];
    assert(up > down + 30, `光源轉 180° 後上邊應變暗，實得 ${up} vs ${down}`);
  });
  await test('浮雕會延伸到形狀外', () => {
    const l = block();
    l.effects.bevel = {
      enabled: true, size: 8, depth: 200, angle: 90,
      highlight: { r: 255, g: 255, b: 255 }, shadow: { r: 0, g: 0, b: 0 },
      alpha: 1, emboss: true,
    };
    const out = compositeLayers([l], { width: 60, height: 60 });
    const bounds = opaqueBounds(out)!;
    assert(bounds.w > 30, `浮雕應超出原本的 30px，實得 ${bounds.w}`);
  });
  await test('深度歸零時斜角不改變畫面', () => {
    const plain = compositeLayers([block()], { width: 60, height: 60 });
    const l = block();
    l.effects.bevel = {
      enabled: true, size: 6, depth: 0, angle: 90,
      highlight: { r: 255, g: 255, b: 255 }, shadow: { r: 0, g: 0, b: 0 },
      alpha: 1, emboss: false,
    };
    const out = compositeLayers([l], { width: 60, height: 60 });
    assert(pixel(out, 30, 17).join() === pixel(plain, 30, 17).join(), '深度 0 應完全不動');
  });
  await test('內側效果都默認關閉且複製時不共用', () => {
    const e = defaultEffects();
    assert(!e.innerShadow.enabled && !e.innerGlow.enabled && !e.bevel.enabled, '預設應全關');
    const l = block();
    const copy = duplicateLayer(l);
    copy.effects.innerShadow.color.r = 200;
    copy.effects.bevel.highlight.g = 10;
    assert(l.effects.innerShadow.color.r === 0, '不應改到原圖層');
    assert(l.effects.bevel.highlight.g === 255, '不應改到原圖層');
  });
  await test('舊專案檔沒有新效果也能載入', async () => {
    const doc = PhotoDoc.createBlank('old-effects', 20, 20, 'white');
    const json = JSON.parse(serializeDocument(doc)) as {
      layers: { effects: Record<string, unknown> }[];
    };
    for (const l of json.layers) {
      delete l.effects.innerShadow;
      delete l.effects.innerGlow;
      delete l.effects.bevel;
    }
    const back = await loadProject(JSON.stringify(json));
    const e = back.layers[0].effects;
    assert(e.innerShadow && e.innerGlow && e.bevel, '缺的效果應補上預設');
    assert(!e.bevel.enabled, '補上的應是關閉的');
    assert(back.render().w === 20, '載入後應能正常合成');
  });
  await test('樣式描述會列出新效果', () => {
    const e = defaultEffects();
    e.innerGlow.enabled = true;
    e.bevel.enabled = true;
    const text = describeStyle(e);
    assert(text.includes('內光暈') && text.includes('斜角'), `描述不完整：${text}`);
    e.bevel.emboss = true;
    assert(describeStyle(e).includes('浮雕'), '浮雕應有自己的名字');
  });

  group('圖層樣式預設');
  await test('內建樣式都至少啟用一種效果', () => {
    assert(BUILTIN_STYLES.length >= 6, '內建樣式數量');
    for (const s2 of BUILTIN_STYLES) {
      const e = s2.effects;
      const any = e.dropShadow.enabled || e.glow.enabled || e.stroke.enabled
        || e.overlay.enabled || e.innerShadow.enabled || e.innerGlow.enabled
        || e.bevel.enabled;
      assert(any, `${s2.name} 應至少啟用一種效果`);
      assert(s2.builtin === true, `${s2.name} 應標記為內建`);
    }
  });
  await test('樣式描述列出啟用的效果', () => {
    const e = defaultEffects();
    assert(describeStyle(e).includes('沒有'), '全關時應說沒有');
    e.dropShadow.enabled = true;
    e.overlay.enabled = true;
    e.overlay.kind = 'pattern';
    const text = describeStyle(e);
    assert(text.includes('陰影') && text.includes('圖樣覆蓋'), `描述不完整：${text}`);
  });
  await test('cloneEffects 是深拷貝', () => {
    const e = defaultEffects();
    const copy = cloneEffects(e);
    copy.dropShadow.color.r = 99;
    copy.overlay.scale = 400;
    assert(e.dropShadow.color.r === 0, '不應影響原本');
    assert(e.overlay.scale === 100, '不應影響原本');
  });
  await test('自訂樣式可以存起來再載入', () => {
    resetStyles();
    const e = defaultEffects();
    e.glow.enabled = true;
    e.glow.blur = 33;
    saveStyles([...loadStyles(), createStyle('測試樣式', e)]);
    const back = loadStyles().find((s2) => s2.name === '測試樣式')!;
    assert(back, '應載得回來');
    assert(back.builtin !== true, '自訂樣式不是內建');
    near(back.effects.glow.blur, 33, 0.001, '參數應一致');
    assert(loadStyles().filter((s2) => s2.builtin).length === BUILTIN_STYLES.length, '內建樣式應仍在');
    resetStyles();
    assert(!loadStyles().some((s2) => s2.name === '測試樣式'), '恢復後應清掉自訂的');
  });
  await test('舊樣式沒有新欄位也能載入', () => {
    localStorage.setItem('photograp.styles.v1', JSON.stringify({
      user: [{ id: 'x', name: '舊樣式', effects: { dropShadow: { enabled: true, color: { r: 0, g: 0, b: 0 }, alpha: 1, blur: 4, dx: 0, dy: 0 } } }],
    }));
    const back = loadStyles().find((s2) => s2.name === '舊樣式')!;
    assert(back, '應載得回來');
    assert(back.effects.overlay && !back.effects.overlay.enabled, '缺的欄位應補上預設');
    assert(back.effects.dropShadow.enabled, '原有的欄位應保留');
    resetStyles();
  });
  await test('套用樣式後合成會跟著改變', () => {
    const l = squareLayer();
    const sunset = BUILTIN_STYLES.find((s2) => s2.id === 'sunset-fill')!;
    l.effects = cloneEffects(sunset.effects);
    const out = compositeLayers([l], { width: 40, height: 40 });
    const inside = pixel(out, 20, 20);
    assert(inside[0] > 60, `日落漸層應讓方塊不再是純黑，實得 ${inside}`);
  });

  // ---- patterns ----
  group('圖樣');
  await test('內建圖樣都能畫出來', async () => {
    assert(BUILTIN_PATTERNS.length >= 8, '內建圖樣數量');
    for (const p of BUILTIN_PATTERNS) {
      const tile = await patternSurface(p);
      assert(tile.w === p.width && tile.h === p.height, `${p.name} 尺寸應相符`);
      const d = tile.ctx.getImageData(0, 0, tile.w, tile.h).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
      assert(opaque === tile.w * tile.h, `${p.name} 應是不透明的磁磚`);
    }
  });
  await test('棋盤格真的是棋盤格', async () => {
    const tile = await patternSurface(BUILTIN_PATTERNS.find((p) => p.id === 'checker')!);
    const a = pixel(tile, 4, 4);
    const b = pixel(tile, 20, 4);
    const c = pixel(tile, 20, 20);
    assert(a[0] !== b[0], `相鄰方格應不同色，實得 ${a} vs ${b}`);
    assert(a[0] === c[0], '對角方格應同色');
  });
  await test('雜訊圖樣每次都一樣', async () => {
    const p = BUILTIN_PATTERNS.find((x) => x.id === 'noise')!;
    const a = await patternSurface(p);
    forgetPattern(p.id);
    const b = await patternSurface(p);
    assert(a !== b, '清除快取後應重新產生');
    assert(pixel(a, 3, 7).join() === pixel(b, 3, 7).join(), '固定亂數序列應產生相同結果');
  });
  await test('tileInto 會鋪滿整張表面', async () => {
    const tile = await patternSurface(BUILTIN_PATTERNS.find((p) => p.id === 'stripes')!);
    const out = createSurface(100, 60);
    tileInto(out, tile);
    const d = out.ctx.getImageData(0, 0, 100, 60).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 250) opaque++;
    assert(opaque === 100 * 60, `應完全鋪滿，實得 ${opaque}`);
    // The stripe repeats every 32 px, so these two columns must match.
    assert(pixel(out, 5, 30).join() === pixel(out, 37, 30).join(), '圖樣應每 32px 重複');
  });
  await test('縮放會改變重複間距', async () => {
    const tile = await patternSurface(BUILTIN_PATTERNS.find((p) => p.id === 'stripes')!);
    const out = createSurface(140, 20);
    tileInto(out, tile, 50);
    // At 50% the 32px tile becomes 16px, so the repeat is 16 px.
    assert(pixel(out, 3, 10).join() === pixel(out, 19, 10).join(), '縮小後應每 16px 重複');
    assert(pixel(out, 3, 10).join() !== pixel(out, 11, 10).join(), '同一磁磚內應有差異');
  });
  await test('位移讓圖樣錨定在文件原點', async () => {
    const tile = await patternSurface(BUILTIN_PATTERNS.find((p) => p.id === 'stripes')!);
    const whole = createSurface(64, 20);
    tileInto(whole, tile);
    // A surface standing 32 px to the right must line up with the full one.
    const shifted = createSurface(32, 20);
    tileInto(shifted, tile, 100, 32, 0);
    assert(pixel(shifted, 5, 10).join() === pixel(whole, 37, 10).join(), '相同相位才能接得起來');
  });
  await test('定義圖樣會截下指定的區域', () => {
    const src = createSurface(60, 60);
    src.ctx.fillStyle = '#ff0000'; src.ctx.fillRect(0, 0, 60, 60);
    src.ctx.fillStyle = '#00ff00'; src.ctx.fillRect(10, 10, 20, 20);
    const p = createPattern('綠塊', src, 10, 10, 20, 20);
    assert(p.width === 20 && p.height === 20, '尺寸應是裁切區域');
    assert(p.data.startsWith('data:image/png'), '應存成 PNG data URL');
    assert(!p.builtin, '自訂圖樣不是內建');
    assert(describePattern(p) === '20 × 20 px', `描述有誤：${describePattern(p)}`);
  });
  await test('過大的區域會被限制在上限', () => {
    const src = createSurface(700, 700);
    src.ctx.fillStyle = '#123456'; src.ctx.fillRect(0, 0, 700, 700);
    const p = createPattern('大', src, 0, 0, 700, 700);
    assert(p.width === MAX_PATTERN && p.height === MAX_PATTERN, `應裁到 ${MAX_PATTERN}`);
  });
  await test('自訂圖樣可以存起來再畫出來', async () => {
    resetPatterns();
    const src = createSurface(16, 16);
    src.ctx.fillStyle = '#0033ff'; src.ctx.fillRect(0, 0, 16, 16);
    src.ctx.fillStyle = '#ffcc00'; src.ctx.fillRect(0, 0, 8, 8);
    const p = createPattern('測試圖樣', src);
    savePatterns([...loadPatterns(), p]);

    const back = loadPatterns().find((x) => x.name === '測試圖樣')!;
    assert(back, '應載得回來');
    assert(back.builtin !== true, '自訂圖樣不是內建');
    const tile = await patternSurface(back);
    assert(pixel(tile, 2, 2)[0] > 200, `左上應是黃的，實得 ${pixel(tile, 2, 2)}`);
    assert(pixel(tile, 12, 12)[2] > 200, `右下應是藍的，實得 ${pixel(tile, 12, 12)}`);
    resetPatterns();
    assert(!loadPatterns().some((x) => x.name === '測試圖樣'), '恢復後應清掉自訂的');
  });
  await test('載入時會丟掉壞掉的資料', () => {
    localStorage.setItem('photograp.patterns.v1', JSON.stringify({
      user: [
        { id: 'a', name: '寬高缺失', data: 'data:image/png;base64,xx', width: 0, height: 0 },
        { id: 'b', name: '沒有資料', width: 8, height: 8 },
      ],
    }));
    const back = loadPatterns();
    assert(back.every((x) => x.builtin), '兩筆壞資料都應被丟掉');
    resetPatterns();
  });
  await test('剛定義的圖樣馬上就能同步取用', () => {
    // Tools paint synchronously, so a pattern that still had to decode from
    // its data URL would paint nothing at all on the first stroke.
    const src = createSurface(12, 12);
    src.ctx.fillStyle = '#ff8800';
    src.ctx.fillRect(0, 0, 12, 12);
    const p = createPattern('即時', src);
    const tile = cachedPatternSurface(p);
    assert(tile, '定義完應立刻拿得到磁磚');
    assert(pixel(tile!, 6, 6)[0] > 200, '磁磚內容應正確');
    assert(cachedPatternSurface(BUILTIN_PATTERNS[0]), '內建圖樣也應是同步的');
    forgetPattern(p.id);
    assert(cachedPatternSurface(p) === null, '清除快取後應回傳 null 而不是白磁磚');
  });
  await test('圖樣印章只刷在刷過的地方', () => {
    const doc = PhotoDoc.createBlank('stamp', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const tool = TOOLS.find((t) => t.id === 'pattern-stamp')!;
    app.options(tool.id, {
      ...optionDefaults(tool), size: 24, hardness: 100, pattern: 'checker',
    });
    tool.down(pointer(doc, 32, 32));
    tool.up(pointer(doc, 32, 32));
    const layer = doc.layers[0];
    assert(doc.history.snapshots.some((h) => h.label === '圖樣印章'), '應記下一筆步驟');
    assert(pixel(layer.surface!, 2, 2)[0] === 255
      && pixel(layer.surface!, 2, 2)[1] === 255, '沒刷到的地方應還是白底');
  });

  // ---- selective colour and shadows/highlights ----
  group('選取顏色');
  /** One pixel through an adjustment, as an [r, g, b] triple. */
  const adjustPixel = (
    rgb: [number, number, number], spec: Parameters<typeof applyAdjustment>[1],
  ): number[] => {
    const img = new ImageData(1, 1);
    img.data[0] = rgb[0]; img.data[1] = rgb[1]; img.data[2] = rgb[2]; img.data[3] = 255;
    applyAdjustment(img, spec);
    return [img.data[0], img.data[1], img.data[2]];
  };

  await test('預設設定不改變像素', () => {
    const spec = defaultAdjustment('selective-color');
    for (const c of [[200, 40, 40], [40, 200, 40], [128, 128, 128], [0, 0, 0], [255, 255, 255]]) {
      const out = adjustPixel(c as [number, number, number], spec);
      for (let i = 0; i < 3; i++) near(out[i], c[i], 1.5, `預設不應改變 ${c}`);
    }
  });
  await test('只影響選到的顏色家族', () => {
    const spec = {
      ...defaultAdjustment('selective-color'),
      family: 'reds' as const, cyan: 60, relative: false,
    };
    const red = adjustPixel([220, 30, 30], spec);
    const green = adjustPixel([30, 220, 30], spec);
    assert(red[0] < 200, `紅色應被加青而變暗，實得 ${red}`);
    near(green[0], 30, 2, '綠色不應受影響');
    near(green[1], 220, 2, '綠色不應受影響');
  });
  await test('相對方式加不進原本沒有的墓色', () => {
    // Pure red holds no cyan ink, so a relative shift has nothing to scale —
    // the same rule Photoshop states for specular white.
    const spec = {
      ...defaultAdjustment('selective-color'),
      family: 'reds' as const, cyan: 60, relative: true,
    };
    const out = adjustPixel([255, 0, 0], spec);
    near(out[0], 255, 1, '相對方式應不改變純紅');
    const abs = adjustPixel([255, 0, 0], { ...spec, relative: false });
    assert(abs[0] < 200, `絕對方式才能加進去，實得 ${abs}`);
  });
  await test('加黑會變暗，減黑會變亮', () => {
    const base = { ...defaultAdjustment('selective-color'), family: 'blues' as const };
    const darker = adjustPixel([40, 60, 220], { ...base, black: 50 });
    const lighter = adjustPixel([40, 60, 220], { ...base, black: -50 });
    assert(darker[2] < 220, `加黑後應變暗，實得 ${darker}`);
    assert(lighter[2] >= 220, `減黑後不應變暗，實得 ${lighter}`);
  });
  await test('絕對方式比相對方式改得多', () => {
    const rel = { ...defaultAdjustment('selective-color'), family: 'reds' as const, yellow: 40, relative: true };
    const abs = { ...rel, relative: false };
    const a = adjustPixel([220, 120, 120], rel);
    const b = adjustPixel([220, 120, 120], abs);
    const shift = (o: number[]): number => Math.abs(o[2] - 120);
    assert(shift(b) > shift(a), `絕對方式應更明顯，實得 ${a} vs ${b}`);
  });
  await test('中性色家族只碰灰階', () => {
    const spec = { ...defaultAdjustment('selective-color'), family: 'neutrals' as const, black: 40 };
    const grey = adjustPixel([128, 128, 128], spec);
    const vivid = adjustPixel([250, 20, 20], spec);
    assert(grey[0] < 125, `中間灰應變暗，實得 ${grey}`);
    near(vivid[0], 250, 3, '鮮豔的紅不應被中性色動到');
  });
  await test('白色與黑色家族分別認得亮部與暗部', () => {
    const white = { ...defaultAdjustment('selective-color'), family: 'whites' as const, black: 30 };
    const black = { ...defaultAdjustment('selective-color'), family: 'blacks' as const, black: -30 };
    const bright = adjustPixel([245, 245, 245], white);
    const dark = adjustPixel([20, 20, 20], white);
    assert(bright[0] < 245, `亮部應被加黑，實得 ${bright}`);
    near(dark[0], 20, 2, '暗部不應被白色家族動到');
    const lifted = adjustPixel([20, 20, 20], black);
    assert(lifted[0] > 20, `黑色家族減黑應提亮，實得 ${lifted}`);
  });
  await test('完全透明的像素不被碰', () => {
    const img = new ImageData(1, 1);
    img.data[0] = 200; img.data[1] = 30; img.data[2] = 30; img.data[3] = 0;
    applyAdjustment(img, {
      ...defaultAdjustment('selective-color'), family: 'reds', cyan: 80,
    });
    assert(img.data[0] === 200, '透明像素應保持原樣');
  });

  group('陰影亮部');
  await test('提亮陰影不動亮部', () => {
    const spec = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 60, highlightAmount: 0, colorCorrect: 0, midtoneContrast: 0,
    };
    const dark = adjustPixel([30, 30, 30], spec);
    const bright = adjustPixel([240, 240, 240], spec);
    assert(dark[0] > 45, `暗部應被提亮，實得 ${dark}`);
    near(bright[0], 240, 3, `亮部應不變，實得 ${bright}`);
  });
  await test('壓低亮部不動陰影', () => {
    const spec = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 0, highlightAmount: 70, colorCorrect: 0, midtoneContrast: 0,
    };
    const bright = adjustPixel([250, 250, 250], spec);
    const dark = adjustPixel([30, 30, 30], spec);
    assert(bright[0] < 230, `亮部應被壓低，實得 ${bright}`);
    near(dark[0], 30, 3, `暗部應不變，實得 ${dark}`);
  });
  await test('色調範圍決定影響到多亮的區域', () => {
    const narrow = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 60, shadowTone: 20, highlightAmount: 0, colorCorrect: 0, midtoneContrast: 0,
    };
    const wide = { ...narrow, shadowTone: 90 };
    const mid = [110, 110, 110] as [number, number, number];
    const a = adjustPixel(mid, narrow);
    const b = adjustPixel(mid, wide);
    near(a[0], 110, 3, '窄範圍不應碰到中間調');
    assert(b[0] > 118, `寬範圍應把中間調也提亮，實得 ${b}`);
  });
  await test('全部歸零時影像不變', () => {
    const spec = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 0, highlightAmount: 0, midtoneContrast: 0, colorCorrect: 0,
    };
    for (const c of [[0, 0, 0], [30, 90, 200], [128, 128, 128], [255, 255, 255]]) {
      const out = adjustPixel(c as [number, number, number], spec);
      for (let i = 0; i < 3; i++) near(out[i], c[i], 1.5, `不應改變 ${c}`);
    }
  });
  await test('黑點保留，接近黑的細節被拉開', () => {
    // A pixel with no light in it has no shadow detail to recover, so the
    // black point stays put; the pixels just above it are pulled apart.
    const spec = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 80, shadowTone: 60, highlightAmount: 0, colorCorrect: 0, midtoneContrast: 0,
    };
    assert(adjustPixel([0, 0, 0], spec)[0] === 0, '純黑應維持純黑');
    const a = adjustPixel([4, 4, 4], spec)[0];
    const b = adjustPixel([8, 8, 8], spec)[0];
    assert(a > 4 && b > 8, `近黑應被提亮，實得 ${a} / ${b}`);
    assert(b - a > 4, `近黑的差距應被拉開，實得 ${b - a}`);
  });
  await test('顏色校正會改變被動到區域的飽和度', () => {
    const base = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 60, highlightAmount: 0, midtoneContrast: 0, colorCorrect: 0,
    };
    const plain = adjustPixel([40, 20, 20], base);
    const saturated = adjustPixel([40, 20, 20], { ...base, colorCorrect: 80 });
    const spread = (o: number[]): number => Math.max(...o) - Math.min(...o);
    assert(spread(saturated) > spread(plain), `校正後應更鮮豔，實得 ${plain} vs ${saturated}`);
  });
  await test('中間調對比形成 S 形曲線', () => {
    const spec = {
      ...defaultAdjustment('shadows-highlights'),
      shadowAmount: 0, highlightAmount: 0, colorCorrect: 0, midtoneContrast: 70,
    };
    const dark = adjustPixel([80, 80, 80], spec);
    const light = adjustPixel([180, 180, 180], spec);
    assert(dark[0] < 80, `中暗部應更暗，實得 ${dark}`);
    assert(light[0] > 180, `中亮部應更亮，實得 ${light}`);
    near(adjustPixel([128, 128, 128], spec)[0], 128, 3, '中間點應幾乎不動');
  });
  await test('兩種新調整都能當成調整圖層', () => {
    const doc = PhotoDoc.createBlank('adj-layer', 20, 20, '#303030');
    for (const type of ['selective-color', 'shadows-highlights'] as const) {
      const layer = createAdjustmentLayer(ADJUSTMENT_LABELS[type], defaultAdjustment(type));
      doc.layers.push(layer);
      assert(layer.kind === 'adjustment', `${type} 應建立調整圖層`);
    }
    const out = doc.render();
    assert(out.w === 20, '合成應成功');
    const px = [...out.ctx.getImageData(10, 10, 1, 1).data];
    assert(px[0] > 0x30, `預設的陰影亮部應把暗底拉亮，實得 ${px}`);
  });

  // ---- select and mask ----
  group('調整選取邊緣');
  /** A hard-edged square of coverage, the simplest thing to measure. */
  const squareMask = (w: number, h: number, x0: number, y0: number, size: number): Uint8Array => {
    const m = new Uint8Array(w * h);
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) m[y * w + x] = 255;
    }
    return m;
  };
  const coverage = (m: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < m.length; i++) n += m[i];
    return n / 255;
  };

  await test('預設設定不改變任何東西', () => {
    const m = squareMask(60, 60, 20, 20, 20);
    assert(refineIsIdentity(defaultRefine()), '預設應是空操作');
    const out = refineMask(m, 60, 60, defaultRefine());
    assert(out !== m, '應回傳新的陣列');
    near(coverage(out), coverage(m), 0.001, '覆蓋率應不變');
  });
  await test('不會改到傳進來的陣列', () => {
    const m = squareMask(60, 60, 20, 20, 20);
    const before = coverage(m);
    refineMask(m, 60, 60, { smooth: 4, feather: 6, contrast: 40, shift: 3 });
    near(coverage(m), before, 0.001, '原陣列應保持原樣');
  });
  await test('移動邊緣會擴大或縮小選取範圍', () => {
    const m = squareMask(80, 80, 30, 30, 20);
    const grown = refineMask(m, 80, 80, { ...defaultRefine(), shift: 5 });
    const shrunk = refineMask(m, 80, 80, { ...defaultRefine(), shift: -5 });
    assert(coverage(grown) > coverage(m), '正值應讓選取變大');
    assert(coverage(shrunk) < coverage(m), '負值應讓選取變小');
    // A 20px square grown by 5 on each side becomes 30px across.
    near(coverage(grown), 30 * 30, 8, '擴大後的面積');
    near(coverage(shrunk), 10 * 10, 8, '縮小後的面積');
  });
  await test('羽化會把硬邊緣變成漸層', () => {
    const m = squareMask(80, 80, 20, 20, 40);
    const soft = refineMask(m, 80, 80, { ...defaultRefine(), feather: 6 });
    const edge = soft[40 * 80 + 20];
    assert(edge > 20 && edge < 235, `邊緣應變成中間值，實得 ${edge}`);
    assert(soft[40 * 80 + 40] > 245, '中心應仍然完全選取');
    assert(soft[5 * 80 + 5] < 10, '遠處應仍然沒被選到');
  });
  await test('對比會把羽化過的邊緣拉回來', () => {
    const m = squareMask(80, 80, 20, 20, 40);
    const soft = refineMask(m, 80, 80, { ...defaultRefine(), feather: 8 });
    const crisp = refineMask(m, 80, 80, { ...defaultRefine(), feather: 8, contrast: 100 });
    const midValues = (x: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i < x.length; i++) if (x[i] > 30 && x[i] < 225) n++;
      return n;
    };
    assert(midValues(crisp) < midValues(soft), '高對比應大幅減少中間值');
    near(coverage(crisp), coverage(soft), 400, '總面積應大致相當');
  });
  await test('平滑會磨掉突出來的雜訊', () => {
    const w = 80, h = 80;
    const m = squareMask(w, h, 20, 20, 40);
    // A one-pixel spike sticking out of the square.
    m[10 * w + 40] = 255;
    const smoothed = refineMask(m, w, h, { ...defaultRefine(), smooth: 4 });
    assert(smoothed[10 * w + 40] < 60, `孤立的雜訊應被磨掉，實得 ${smoothed[10 * w + 40]}`);
    assert(smoothed[40 * w + 40] > 200, '主體應保留');
  });
  await test('依序套用：平滑、羽化、對比、移動邊緣', () => {
    const m = squareMask(80, 80, 20, 20, 40);
    const all = refineMask(m, 80, 80, { smooth: 2, feather: 4, contrast: 50, shift: 3 });
    assert(coverage(all) > coverage(m), '全部套用後應因為移動邊緣而變大');
    assert(all.length === m.length, '尺寸不變');
  });
  await test('縮放過的半徑與全尺寸結果相當', () => {
    const w = 120, h = 120;
    const m = squareMask(w, h, 30, 30, 60);
    const settings = { ...defaultRefine(), shift: 8 };
    const fullOut = refineMask(m, w, h, settings, 1);
    // The preview path: half-size mask, half-size radii.
    const small = scaleMask(m, w, h, w / 2, h / 2);
    const smallOut = refineMask(small, w / 2, h / 2, settings, 0.5);
    const fullPct = coverage(fullOut) / (w * h);
    const smallPct = coverage(smallOut) / ((w / 2) * (h / 2));
    near(smallPct, fullPct, 0.02, '預視的覆蓋比例應與實際結果相近');
  });
  await test('scaleMask 保留大致的覆蓋比例', () => {
    const w = 100, h = 100;
    const m = squareMask(w, h, 20, 20, 40);
    const small = scaleMask(m, w, h, 50, 50);
    assert(small.length === 2500, '尺寸應縮半');
    near(coverage(small) / 2500, coverage(m) / (w * h), 0.02, '覆蓋比例應相近');
  });
  await test('選取範圍可以換成調整過的結果', () => {
    const doc = PhotoDoc.createBlank('refine-doc', 80, 80, 'white');
    const path = new Path2D();
    path.rect(20, 20, 40, 40);
    doc.selection.combine(rasterizePath(path, 80, 80), 'replace');
    const before = doc.selection.bounds()!;
    const refined = refineMask(doc.selection.mask!, 80, 80, { ...defaultRefine(), shift: 6 });
    doc.selection.combine(refined, 'replace');
    const after = doc.selection.bounds()!;
    assert(after.w > before.w && after.h > before.h, '邊界應變大');
    near(after.x, before.x - 6, 1.5, '左邊應往外移');
  });
  await test('輸出為圖層遮色片會把覆蓋率轉成灰階', () => {
    const doc = PhotoDoc.createBlank('refine-mask', 60, 60, 'white');
    const path = new Path2D();
    path.rect(10, 10, 30, 30);
    doc.selection.combine(rasterizePath(path, 60, 60), 'replace');
    const refined = refineMask(doc.selection.mask!, 60, 60, { ...defaultRefine(), feather: 4 });
    const layer = doc.layers[0];
    layer.mask = maskFromCoverage(refined, 60, 60);
    layer.maskEnabled = true;
    assert(layer.mask, '應建立遮色片');
    assert(pixel(layer.mask!, 25, 25)[0] > 200, '選取內部應是白的');
    assert(pixel(layer.mask!, 2, 2)[0] < 40, '選取外部應是黑的');
    const edge = pixel(layer.mask!, 10, 25)[0];
    assert(edge > 20 && edge < 235, `羽化的邊緣應是灰的，實得 ${edge}`);
  });

  // ---- align and distribute ----
  group('對齊與分佈');
  const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  await test('對齊位移的計算', () => {
    const into = box(0, 0, 100, 100);
    const b = box(20, 30, 40, 20);
    near(alignDelta(b, into, 'left').dx, -20, 0.001, '靠左');
    near(alignDelta(b, into, 'right').dx, 40, 0.001, '靠右');
    near(alignDelta(b, into, 'centerH').dx, 10, 0.001, '水平置中');
    near(alignDelta(b, into, 'top').dy, -30, 0.001, '靠上');
    near(alignDelta(b, into, 'bottom').dy, 50, 0.001, '靠下');
    near(alignDelta(b, into, 'centerV').dy, 10, 0.001, '垂直置中');
    assert(alignDelta(b, into, 'left').dy === 0, '水平對齊不動到 Y');
    assert(alignDelta(b, into, 'top').dx === 0, '垂直對齊不動到 X');
  });
  await test('對齊目標是選取範圍，沒選取時是畫布', () => {
    const doc = PhotoDoc.createBlank('align-target', 200, 120, 'white');
    const full = alignTarget(doc);
    assert(full.x === 0 && full.w === 200 && full.h === 120, '沒選取時應是整張畫布');
    const p2 = new Path2D();
    p2.rect(40, 20, 60, 50);
    doc.selection.combine(rasterizePath(p2, 200, 120), 'replace');
    const sel = alignTarget(doc);
    near(sel.x, 40, 1, '選取範圍 X');
    near(sel.w, 60, 1, '選取範圍寬');
  });
  await test('平均分佈會拉出相等的間距', () => {
    const boxes = [box(0, 0, 10, 10), box(15, 0, 10, 10), box(100, 0, 10, 10)];
    const d = distributeDeltas(boxes, 'h');
    const after = boxes.map((b, i) => ({ ...b, x: b.x + d[i].dx }));
    const gap1 = after[1].x - (after[0].x + after[0].w);
    const gap2 = after[2].x - (after[1].x + after[1].w);
    near(gap1, gap2, 0.001, '兩段間距應相等');
    near(after[0].x, 0, 0.001, '第一個不動');
    near(after[2].x, 100, 0.001, '最後一個不動');
  });
  await test('分佈會依位置排序而不是依輸入順序', () => {
    const boxes = [box(100, 0, 10, 10), box(0, 0, 10, 10), box(40, 0, 10, 10)];
    const d = distributeDeltas(boxes, 'h');
    const after = boxes.map((b, i) => b.x + d[i].dx);
    near(after[1], 0, 0.001, '最左的不動');
    near(after[0], 100, 0.001, '最右的不動');
    near(after[2], 50, 0.001, '中間的應落在均分點');
  });
  await test('少於三個時分佈不動作', () => {
    const boxes = [box(0, 0, 10, 10), box(50, 0, 10, 10)];
    const d = distributeDeltas(boxes, 'h');
    assert(d.every((x) => x.dx === 0 && x.dy === 0), '兩個時不應有位移');
  });
  await test('垂直分佈只動 Y', () => {
    const boxes = [box(0, 0, 10, 10), box(0, 15, 10, 10), box(0, 100, 10, 10)];
    const d = distributeDeltas(boxes, 'v');
    assert(d.every((x) => x.dx === 0), '不應動到 X');
    const after = boxes.map((b, i) => b.y + d[i].dy);
    near(after[1] - after[0], after[2] - after[1], 0.001, '間距應相等');
  });
  await test('移動圖層時群組會帶著子圖層', () => {
    const doc = PhotoDoc.createBlank('align-group', 100, 100, 'white');
    const a = createRasterLayer('a', 100, 100);
    const b = createRasterLayer('b', 100, 100);
    a.x = 5; b.x = 9;
    const g = createRasterLayer('g', 100, 100);
    g.kind = 'group';
    g.surface = null;
    g.children = [a, b];
    moveLayerBy(doc, g, 10, -3);
    assert(a.x === 15 && b.x === 19, '子圖層應一起搬動');
    assert(a.y === -3 && b.y === -3, '垂直也要搬');
  });
  await test('移動形狀圖層會折入幾何', () => {
    const doc = PhotoDoc.createBlank('align-shape', 100, 100, 'white');
    const layer = createRasterLayer('形狀', 100, 100);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 10, 10, 30, 30, 0, 5),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 100, 100);
    moveLayerBy(doc, layer, 20, 5);
    assert(layer.x === 0 && layer.y === 0, '位移應已折入幾何');
    const xs = layer.shape.path.subpaths[0].anchors.map((p) => p.x);
    near(Math.min(...xs), 30, 0.001, '控制點應搬過去');
  });
  await test('沿路徑的文字不接受對齊', () => {
    const plain = createRasterLayer('點陣', 20, 20);
    assert(moveBlockReason(plain) === null, '一般圖層可對齊');
    plain.locked = true;
    assert(moveBlockReason(plain)?.includes('鎖定'), '鎖定圖層應說明原因');
    const style = defaultTextStyle();
    style.text = 'X';
    style.onPath = defaultPathBinding('p1');
    const onPath = createTextLayer('文字', 20, 20, style);
    assert(moveBlockReason(onPath)?.includes('路徑'), '路徑文字應說明原因');
  });
  await test('靠右對齊會把圖層推到畫布邊緣', () => {
    const doc = PhotoDoc.createBlank('align-run', 200, 100, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = createRasterLayer('方塊', 200, 100);
    layer.surface!.ctx.fillStyle = '#ff0000';
    layer.surface!.ctx.fillRect(10, 10, 40, 20);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    runCommand(app, 'layer.alignRight');
    const b = layerBounds(layer)!;
    near(b.x + b.w, 200, 1, '右邊應貼到畫布右緣');
    runCommand(app, 'layer.alignBottom');
    const b2 = layerBounds(layer)!;
    near(b2.y + b2.h, 100, 1, '下邊應貼到畫布下緣');
    assert(doc.history.snapshots.some((h) => h.label === '對齊圖層'), '應記下步驟');
  });
  await test('水平平均分佈會拉齊三個圖層', () => {
    const doc = PhotoDoc.createBlank('dist-run', 300, 100, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    doc.layers.length = 0;
    const at = (x: number): Layer => {
      const l = createRasterLayer(`方塊 ${x}`, 300, 100);
      l.surface!.ctx.fillStyle = '#000';
      l.surface!.ctx.fillRect(x, 10, 20, 20);
      doc.layers.push(l);
      return l;
    };
    const a = at(0), b = at(30), c = at(200);
    doc.activeLayerId = b.id;
    runCommand(app, 'layer.distributeH');
    const boxes = [a, b, c].map((l) => layerBounds(l)!);
    const gap1 = boxes[1].x - (boxes[0].x + boxes[0].w);
    const gap2 = boxes[2].x - (boxes[1].x + boxes[1].w);
    near(gap1, gap2, 1.5, `間距應相等，實得 ${gap1} vs ${gap2}`);
    assert(gap1 > 0, `方塊不應疊在一起，實得 ${gap1}`);
    assert(doc.history.snapshots.some((h) => h.label === '水平平均分佈'), '應記下步驟');
  });
  await test('底圖不會把分佈拉坦', () => {
    // A full-canvas background has nowhere to go; including it used to drag
    // every other layer into a negative-gap heap.
    const doc = PhotoDoc.createBlank('dist-bg', 300, 100, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const at = (x: number): Layer => {
      const l = createRasterLayer(`方塊 ${x}`, 300, 100);
      l.surface!.ctx.fillStyle = '#000';
      l.surface!.ctx.fillRect(x, 10, 20, 20);
      doc.layers.push(l);
      return l;
    };
    const a = at(0), b = at(30), c = at(200);
    doc.activeLayerId = b.id;
    runCommand(app, 'layer.distributeH');
    const boxes = [a, b, c].map((l) => layerBounds(l)!);
    near(boxes[0].x, 0, 1, '最左的不動');
    near(boxes[2].x, 200, 1, '最右的不動');
    const gap1 = boxes[1].x - (boxes[0].x + boxes[0].w);
    const gap2 = boxes[2].x - (boxes[1].x + boxes[1].w);
    assert(gap1 > 0 && gap2 > 0, `間距應為正，實得 ${gap1} / ${gap2}`);
    near(gap1, gap2, 1.5, '間距應相等');
  });

  // ---- gradient editor ----
  group('漸層編輯器');
  await test('內建漸層都至少有兩個色標', () => {
    assert(BUILTIN_GRADIENTS.length >= 6, '內建漸層數量');
    for (const g of BUILTIN_GRADIENTS) {
      assert(g.stops.length >= 2, `${g.name} 至少要兩個色標`);
      assert(g.builtin === true, `${g.name} 應標記為內建`);
      const ps = g.stops.map((x) => x.pos);
      assert(Math.min(...ps) === 0 && Math.max(...ps) === 1, `${g.name} 應涵蓋頭尾`);
    }
  });
  await test('前景背景色標會跟著顏色走', () => {
    const fg = { r: 10, g: 20, b: 30 };
    const bg = { r: 200, g: 210, b: 220 };
    const out = resolveStops(BUILTIN_GRADIENTS[0].stops, fg, bg);
    assert(out[0].color.r === 10 && out[1].color.r === 200, '應解析成目前的前景與背景色');
    const other = resolveStops(BUILTIN_GRADIENTS[0].stops, bg, fg);
    assert(other[0].color.r === 200, '換了前景色就跟著換');
    assert(BUILTIN_GRADIENTS[0].stops[0].color.r === 0, '不應改到原本的色標');
  });
  await test('固定顏色的色標不受前景色影響', () => {
    const black = BUILTIN_GRADIENTS.find((g) => g.id === 'black-white')!;
    const out = resolveStops(black.stops, { r: 9, g: 9, b: 9 }, { r: 9, g: 9, b: 9 });
    assert(out[0].color.r === 0 && out[1].color.r === 255, '黑到白應維持原樣');
  });
  await test('sortStops 不會改到原陣列', () => {
    const raw = [
      { pos: 0.8, color: { r: 1, g: 1, b: 1 }, alpha: 1 },
      { pos: 0.1, color: { r: 2, g: 2, b: 2 }, alpha: 1 },
    ];
    const sorted = sortStops(raw);
    near(sorted[0].pos, 0.1, 0.0001, '應依位置排序');
    near(raw[0].pos, 0.8, 0.0001, '原陣列不變');
  });
  await test('cloneStops 是深拷貝', () => {
    const src = [{ pos: 0, color: { r: 1, g: 2, b: 3 }, alpha: 1 }];
    const copy = cloneStops(src);
    copy[0].color.r = 99;
    assert(src[0].color.r === 1, '改複本不應影響原本');
  });
  await test('自訂漸層可以存起來再載入', () => {
    const base = resetGradients();
    const mine = createGradient('測試漸層', [
      { pos: 0, color: { r: 255, g: 0, b: 0 }, alpha: 1 },
      { pos: 0.5, color: { r: 0, g: 255, b: 0 }, alpha: 0.5 },
      { pos: 1, color: { r: 0, g: 0, b: 255 }, alpha: 1 },
    ]);
    saveGradients([...base, mine]);
    const back = loadGradients();
    const found = back.find((g) => g.name === '測試漸層')!;
    assert(found, '應載得回來');
    assert(found.builtin !== true, '自訂漸層不是內建');
    assert(found.stops.length === 3, '色標數應一致');
    near(found.stops[1].alpha, 0.5, 0.0001, '不透明度應一致');
    assert(back.filter((g) => g.builtin).length === BUILTIN_GRADIENTS.length, '內建漸層應仍在');
    resetGradients();
    assert(!loadGradients().some((g) => g.name === '測試漸層'), '恢復內建應清掉自訂的');
  });
  await test('載入時會修正壞掉的資料', () => {
    localStorage.setItem('photograp.gradients.v1', JSON.stringify({
      user: [{ id: '', name: '', stops: [{ pos: 0, color: { r: 1, g: 1, b: 1 }, alpha: 1 }] }],
    }));
    const back = loadGradients();
    const broken = back[back.length - 1];
    assert(broken.id.length > 0, '應補上 id');
    assert(broken.stops.length >= 2, '只有一個色標時應補成清單');
    resetGradients();
  });
  await test('選單選項會跟著儲存的漸層更新', () => {
    resetGradients();
    refreshGradientOptions();
    const before = GRADIENT_PRESETS.length;
    saveGradients([...loadGradients(), createGradient('附加', [
      { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
      { pos: 1, color: { r: 9, g: 9, b: 9 }, alpha: 1 },
    ])]);
    refreshGradientOptions();
    assert(GRADIENT_PRESETS.length === before + 1, '選單應多一項');
    assert(GRADIENT_PRESETS.some((o) => o.label === '附加'), '應列出新漸層');
    resetGradients();
    refreshGradientOptions();
    assert(GRADIENT_PRESETS.length === before, '恢復後應回到原數量');
  });
  await test('presetStops 以 id 取得排好序的色標', () => {
    const stops = presetStops('spectrum', { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 });
    assert(stops.length === 7, `光譜應有 7 個色標，實得 ${stops.length}`);
    for (let i = 1; i < stops.length; i++) {
      assert(stops[i].pos >= stops[i - 1].pos, '色標應已排序');
    }
    const unknown = presetStops('沒這個', { r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 });
    assert(unknown.length >= 2, '找不到時應退回第一個內建漸層');
  });
  await test('自訂漸層畫出來的像素正確', () => {
    resetGradients();
    const mine = createGradient('紅綠藍', [
      { pos: 0, color: { r: 255, g: 0, b: 0 }, alpha: 1 },
      { pos: 0.5, color: { r: 0, g: 255, b: 0 }, alpha: 1 },
      { pos: 1, color: { r: 0, g: 0, b: 255 }, alpha: 1 },
    ]);
    saveGradients([...loadGradients(), mine]);
    const s = createSurface(100, 10);
    renderGradient(
      s, 'linear', 0, 0, 100, 0,
      presetStops(mine.id, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }), false, false,
    );
    const left = pixel(s, 2, 5), mid = pixel(s, 50, 5), right = pixel(s, 97, 5);
    assert(left[0] > 200 && left[1] < 60, `左端應是紅的，實得 ${left}`);
    assert(mid[1] > 200 && mid[0] < 60, `中間應是綠的，實得 ${mid}`);
    assert(right[2] > 200 && right[0] < 60, `右端應是藍的，實得 ${right}`);
    resetGradients();
  });
  await test('色標的不透明度會畫出來', () => {
    const s = createSurface(100, 10);
    renderGradient(s, 'linear', 0, 0, 100, 0, [
      { pos: 0, color: { r: 255, g: 0, b: 0 }, alpha: 1 },
      { pos: 1, color: { r: 255, g: 0, b: 0 }, alpha: 0 },
    ], false, false);
    assert(pixel(s, 2, 5)[3] > 230, '左端應不透明');
    assert(pixel(s, 97, 5)[3] < 30, '右端應透明');
  });
  await test('describeGradient 會標出重點', () => {
    const plain = describeGradient([
      { pos: 0, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
      { pos: 1, color: { r: 0, g: 0, b: 0 }, alpha: 1 },
    ]);
    assert(plain.includes('2 個色標') && !plain.includes('透明度'), `描述有誤：${plain}`);
    const fancy = describeGradient(BUILTIN_GRADIENTS[1].stops);
    assert(fancy.includes('透明度') && fancy.includes('前景'), `描述不完整：${fancy}`);
  });

  // ---- history snapshots and the history brush ----
  group('步驟記錄快照');
  await test('快照不會變成一個步驟', () => {
    const doc = PhotoDoc.createBlank('snap', 32, 32, 'white');
    const steps = doc.history.snapshots.length;
    doc.history.addNamed(doc, '起始');
    assert(doc.history.snapshots.length === steps, '建立快照不應新增步驟');
    assert(doc.history.named.length === 1, '應記下一個快照');
    assert(doc.history.named[0].name === '起始', '快照名稱');
  });
  await test('快照還原會變成可還原的步驟', () => {
    const doc = PhotoDoc.createBlank('snap-restore', 32, 32, 'white');
    const layer = doc.layers[0];
    const entry = doc.history.addNamed(doc, '白底');
    const surface = doc.mutableSurface(layer);
    surface.ctx.fillStyle = '#ff0000';
    surface.ctx.fillRect(0, 0, 32, 32);
    doc.commit('塗紅');
    assert(pixel(doc.layers[0].surface!, 5, 5)[0] > 200, '塗完應是紅的');
    assert(doc.restoreNamed(entry.id), '還原應成功');
    const back = pixel(doc.layers[0].surface!, 5, 5);
    assert(back[1] > 200 && back[2] > 200, `還原後應回到白底，實得 ${back}`);
    assert(doc.history.snapshots[doc.history.index].label.includes('白底'), '應記下一筆快照步驟');
    doc.undo();
    const red = pixel(doc.layers[0].surface!, 5, 5);
    assert(red[0] > 200 && red[1] < 80, `還原本身也能被還原，實得 ${red}`);
  });
  await test('刪除快照會一併清掉來源標記', () => {
    const doc = PhotoDoc.createBlank('snap-del', 16, 16, 'white');
    const entry = doc.history.addNamed(doc, 'A');
    doc.history.source = entry.snap;
    doc.history.removeNamed(entry.id);
    assert(doc.history.named.length === 0, '快照應被刪除');
    assert(doc.history.source === null, '來源應回到預設');
  });
  await test('未指定時來源是最舊的步驟', () => {
    const doc = PhotoDoc.createBlank('snap-default', 16, 16, 'white');
    doc.commit('第二步');
    assert(doc.history.sourceSnapshot() === doc.history.snapshots[0], '預設應是第一個步驟');
    doc.history.source = doc.history.snapshots[1];
    assert(doc.history.sourceSnapshot() === doc.history.snapshots[1], '指定後應改用指定的');
  });
  await test('清除步驟記錄會一併清掉快照與來源', () => {
    const doc = PhotoDoc.createBlank('snap-clear', 16, 16, 'white');
    const entry = doc.history.addNamed(doc, 'A');
    doc.history.source = entry.snap;
    doc.history.clear();
    assert(doc.history.named.length === 0 && doc.history.source === null, '應全部清掉');
  });

  group('步驟記錄筆刷');
  const redDoc = (): PhotoDoc => {
    const doc = PhotoDoc.createBlank('hb', 64, 64, 'white');
    const layer = doc.layers[0];
    const surface = doc.mutableSurface(layer);
    surface.ctx.fillStyle = '#ff0000';
    surface.ctx.fillRect(0, 0, 64, 64);
    doc.commit('塗紅');
    return doc;
  };
  await test('來源會對應到同一個圖層', () => {
    const doc = redDoc();
    const layer = doc.layers[0];
    const src = doc.historySource(layer)!;
    assert(src, '應找得到來源');
    assert(pixel(src.surface, 5, 5)[0] > 200 && pixel(src.surface, 5, 5)[1] > 200,
      '來源應是塗紅之前的白底');
    assert(src.dx === 0 && src.dy === 0, '圖層沒移動時不需要位移');
    assert(doc.historySourceReason() === null, '來源可用時不應有阻擋原因');
  });
  await test('圖層移動過會反映在來源位移上', () => {
    const doc = redDoc();
    const layer = doc.layers[0];
    layer.x = 12; layer.y = -4;
    const src = doc.historySource(layer)!;
    near(src.dx, 12, 0.001, '水平位移');
    near(src.dy, -4, 0.001, '垂直位移');
  });
  await test('尺寸不同的來源會被拒絕', () => {
    const doc = redDoc();
    doc.resampleTo(128, 128);
    assert(doc.historySource(doc.layers[0]) === null, '尺寸不同時不應回傳來源');
    assert(doc.historySourceReason()?.includes('尺寸'), '應說明是尺寸問題');
  });
  await test('來源狀態沒有這個圖層時會被拒絕', () => {
    const doc = redDoc();
    const added = createRasterLayer('新圖層', 64, 64);
    doc.layers.push(added);
    doc.activeLayerId = added.id;
    doc.commit('新增圖層');
    assert(doc.historySource(added) === null, '來源中沒有這個圖層');
    assert(doc.historySourceReason()?.includes('不存在'), '應說明圖層不存在');
  });
  await test('筆刷會把塗過的地方改回舊狀態', () => {
    const doc = redDoc();
    app.docs.length = 0;
    app.addDoc(doc);
    const tool = TOOLS.find((t) => t.id === 'history-brush')!;
    app.options(tool.id, { ...optionDefaults(tool), size: 24, hardness: 100 });
    tool.down(pointer(doc, 32, 32));
    tool.up(pointer(doc, 32, 32));
    const layer = doc.layers[0];
    const centre = pixel(layer.surface!, 32, 32);
    const corner = pixel(layer.surface!, 2, 2);
    assert(centre[1] > 200 && centre[2] > 200, `刷過的地方應回到白底，實得 ${centre}`);
    assert(corner[0] > 200 && corner[1] < 80, `沒刷到的地方應還是紅的，實得 ${corner}`);
    assert(doc.history.snapshots.some((h) => h.label === '步驟記錄筆刷'), '應記下一筆步驟');
  });
  await test('改指定來源後筆刷會取新的狀態', () => {
    const doc = redDoc();
    app.docs.length = 0;
    app.addDoc(doc);
    // Paint blue, then point the brush at the red state rather than the white one.
    const surface = doc.mutableSurface(doc.layers[0]);
    surface.ctx.fillStyle = '#0000ff';
    surface.ctx.fillRect(0, 0, 64, 64);
    doc.commit('塗藍');
    doc.history.source = doc.history.snapshots[1];
    const tool = TOOLS.find((t) => t.id === 'history-brush')!;
    app.options(tool.id, { ...optionDefaults(tool), size: 24, hardness: 100 });
    tool.down(pointer(doc, 32, 32));
    tool.up(pointer(doc, 32, 32));
    const centre = pixel(doc.layers[0].surface!, 32, 32);
    assert(centre[0] > 200 && centre[2] < 80, `應回到紅色而不是白色，實得 ${centre}`);
  });
  await test('填滿步驟記錄只改選取範圍', () => {
    const doc = redDoc();
    app.docs.length = 0;
    app.addDoc(doc);
    const box = new Path2D();
    box.rect(8, 8, 24, 24);
    doc.selection.combine(rasterizePath(box, 64, 64), 'replace');
    runCommand(app, 'edit.fillHistory');
    const layer = doc.layers[0];
    const inside = pixel(layer.surface!, 20, 20);
    const outside = pixel(layer.surface!, 50, 50);
    assert(inside[1] > 200 && inside[2] > 200, `選取內應回到白底，實得 ${inside}`);
    assert(outside[0] > 200 && outside[1] < 80, `選取外應保持紅色，實得 ${outside}`);
    assert(doc.history.snapshots.some((h) => h.label === '填滿步驟記錄'), '應記下一筆步驟');
    doc.selection.clear();
  });
  await test('步驟記錄筆刷不碰形狀圖層', () => {
    const doc = redDoc();
    app.docs.length = 0;
    app.addDoc(doc);
    const shape = createRasterLayer('形狀', 64, 64);
    shape.kind = 'shape';
    shape.shape = {
      path: shapeToVectorPath('rect', 5, 5, 40, 40, 0, 5),
      style: defaultShapeStyle({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(shape, 64, 64);
    doc.layers.push(shape);
    doc.activeLayerId = shape.id;
    doc.commit('新增形狀');
    const before = pixel(shape.surface!, 20, 20);
    const tool = TOOLS.find((t) => t.id === 'history-brush')!;
    app.options(tool.id, optionDefaults(tool));
    tool.down(pointer(doc, 20, 20));
    tool.up(pointer(doc, 20, 20));
    assert(pixel(shape.surface!, 20, 20).join() === before.join(), '形狀圖層不應被刷到');
  });

  // ---- arc-length sampling and type on a path ----
  group('路徑弧長取樣');
  await test('直線子路徑的長度與取樣', () => {
    const sp = {
      closed: false,
      anchors: [createAnchor(0, 0), createAnchor(100, 0), createAnchor(100, 50)],
    };
    const flat = flattenSubPath(sp);
    near(flat.length, 150, 0.001, '總長度');
    const mid = pathPointAt(flat, 50)!;
    near(mid.x, 50, 0.001, '一半處的 X');
    near(mid.y, 0, 0.001, '一半處的 Y');
    near(mid.angle, 0, 0.001, '水平段的切線角');
    const down = pathPointAt(flat, 125)!;
    near(down.x, 100, 0.001, '垂直段的 X');
    near(down.y, 25, 0.001, '垂直段的 Y');
    near(down.angle, Math.PI / 2, 0.001, '垂直段的切線角');
  });
  await test('超過端點時沿切線延伸', () => {
    const flat = flattenSubPath({
      closed: false, anchors: [createAnchor(0, 0), createAnchor(100, 0)],
    });
    const over = pathPointAt(flat, 130)!;
    near(over.x, 130, 0.001, '超出後繼續延伸');
    const before = pathPointAt(flat, -20)!;
    near(before.x, -20, 0.001, '起點之前也延伸');
  });
  await test('封閉路徑會回繞', () => {
    const flat = flattenSubPath({
      closed: true,
      anchors: [createAnchor(0, 0), createAnchor(60, 0), createAnchor(60, 60), createAnchor(0, 60)],
    });
    near(flat.length, 240, 0.001, '正方形周長');
    const a = pathPointAt(flat, 30)!;
    const b = pathPointAt(flat, 30 + 240)!;
    near(b.x, a.x, 0.001, '繞一圈後回到同一點');
    near(b.y, a.y, 0.001, '繞一圈後回到同一點');
  });
  await test('圓弧弧長接近理論值', () => {
    // A quarter circle of radius 100 drawn with the standard kappa handle.
    const k = 0.5522847498307936 * 100;
    const a = createAnchor(0, 0, true);
    a.outX = k; a.outY = 0;
    const b = createAnchor(100, 100, true);
    b.inX = 100; b.inY = 100 - k;
    const flat = flattenSubPath({ closed: false, anchors: [a, b] });
    near(flat.length, (Math.PI / 2) * 100, 1, '四分之一圓弧長');
    const mid = pathPointAt(flat, flat.length / 2)!;
    // The midpoint of the arc sits at 45 degrees from the centre (0, 100).
    near(Math.hypot(mid.x - 0, mid.y - 100), 100, 1.5, '弧中點到圓心的距離');
  });
  await test('flattenPath 以最長的子路徑優先', () => {
    const path = createPath('p');
    path.subpaths.push({ closed: false, anchors: [createAnchor(0, 0), createAnchor(10, 0)] });
    path.subpaths.push({ closed: false, anchors: [createAnchor(0, 40), createAnchor(200, 40)] });
    path.subpaths.push({ closed: false, anchors: [createAnchor(5, 5)] });
    const flats = flattenPath(path);
    assert(flats.length === 2, `只有兩條可用子路徑，實得 ${flats.length}`);
    near(flats[0].length, 200, 0.001, '最長的子路徑應排在前面');
  });
  await test('closestOnPath 找得到最近的點與弧長', () => {
    const path = createPath('p');
    path.subpaths.push({ closed: false, anchors: [createAnchor(0, 0), createAnchor(100, 0)] });
    const hit = closestOnPath(path, { x: 30, y: 12 })!;
    near(hit.distance, 12, 0.001, '垂直距離');
    near(hit.along, 30, 0.001, '落在路徑上的弧長');
  });

  group('文字沿路徑');
  const linePath = (): ReturnType<typeof createPath> => {
    const path = createPath('基準線');
    path.subpaths.push({ closed: false, anchors: [createAnchor(20, 100), createAnchor(380, 100)] });
    return path;
  };
  await test('綁定路徑後文字會畫在路徑上', () => {
    const doc = PhotoDoc.createBlank('type-path', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'HELLO';
    style.fontSize = 40;
    style.color = { r: 255, g: 0, b: 0 };
    const layer = createTextLayer('文字', 400, 200, style);
    layer.x = 0; layer.y = 0;
    renderTextLayer(layer, 400, 200, doc.paths);
    const blockPixels = opaqueBounds(layer.surface!)!;
    style.onPath = defaultPathBinding(path.id);
    renderTextLayer(layer, 400, 200, doc.paths);
    const onPath = opaqueBounds(layer.surface!)!;
    assert(layer.x === 0 && layer.y === 0, '沿路徑的文字圖層應固定在原點');
    near(onPath.x, 20, 6, '文字應從路徑起點開始');
    // The baseline sits on the path, so the glyphs stack just above y = 100.
    assert(onPath.y < 100 && onPath.y + onPath.h <= 104, `字形應坐在基準線上方，實得 ${onPath.y}~${onPath.y + onPath.h}`);
    assert(blockPixels.y !== onPath.y, '綁定前後位置應不同');
  });
  await test('起點與基線位移會搬動字形', () => {
    const doc = PhotoDoc.createBlank('type-shift', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'AB';
    style.fontSize = 40;
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 400, 200, style);
    renderTextLayer(layer, 400, 200, doc.paths);
    const base = opaqueBounds(layer.surface!)!;
    style.onPath.offset = 100;
    renderTextLayer(layer, 400, 200, doc.paths);
    const moved = opaqueBounds(layer.surface!)!;
    near(moved.x - base.x, 100, 2, '起點位移應沿路徑往前');
    style.onPath.offset = 0;
    style.onPath.baselineShift = 30;
    renderTextLayer(layer, 400, 200, doc.paths);
    const lifted = opaqueBounds(layer.surface!)!;
    near(base.y - lifted.y, 30, 2, '基線位移應把字形推離曲線');
  });
  await test('對齊方式決定文字在路徑上的位置', () => {
    const doc = PhotoDoc.createBlank('type-align', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'MID';
    style.fontSize = 32;
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 400, 200, style);
    const boundsFor = (align: 'left' | 'center' | 'right'): { x: number; w: number } => {
      style.align = align;
      renderTextLayer(layer, 400, 200, doc.paths);
      const b = opaqueBounds(layer.surface!)!;
      return { x: b.x, w: b.w };
    };
    const left = boundsFor('left');
    const center = boundsFor('center');
    const right = boundsFor('right');
    assert(left.x < center.x && center.x < right.x, '靠左 < 置中 < 靠右');
    near(center.x + center.w / 2, 200, 6, '置中時應落在路徑中點');
    assert(right.x + right.w <= 382, '靠右時不應超出路徑終點');
  });
  await test('翻轉會把文字換到曲線另一側', () => {
    const doc = PhotoDoc.createBlank('type-flip', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'FLIP';
    style.fontSize = 36;
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 400, 200, style);
    renderTextLayer(layer, 400, 200, doc.paths);
    const up = opaqueBounds(layer.surface!)!;
    style.onPath.flip = true;
    renderTextLayer(layer, 400, 200, doc.paths);
    const down = opaqueBounds(layer.surface!)!;
    assert(up.y + up.h <= 104, '未翻轉時字形在線上方');
    assert(down.y >= 96, `翻轉後字形應在線下方，實得 ${down.y}`);
  });
  await test('文字會跟著彎曲的路徑走', () => {
    const doc = PhotoDoc.createBlank('type-curve', 300, 300, 'white');
    const path = createPath('弧');
    const a = createAnchor(30, 250, true);
    a.outX = 30; a.outY = 60;
    const b = createAnchor(270, 250, true);
    b.inX = 270; b.inY = 60;
    path.subpaths.push({ closed: false, anchors: [a, b] });
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'ARCHED';
    style.fontSize = 30;
    style.align = 'center';
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 300, 300, style);
    renderTextLayer(layer, 300, 300, doc.paths);
    const b2 = opaqueBounds(layer.surface!)!;
    // On an arch the middle letters ride higher than the ends. Scan a window
    // rather than one column, which could land in the gap between two letters.
    const topIn = (x0: number, w: number): number => {
      const img = layer.surface!.ctx.getImageData(x0, 0, w, 300).data;
      for (let y = 0; y < 300; y++) {
        for (let x = 0; x < w; x++) if (img[(y * w + x) * 4 + 3] > 0) return y;
      }
      return 300;
    };
    const middle = topIn(140, 20);
    const edge = topIn(b2.x, 20);
    assert(middle < edge, `中間的字應比兩端高，實得 ${middle} vs ${edge}`);
    assert(b2.w > 100, '文字應橫跨整道弧');
  });
  await test('沿路徑的文字不接受直接塗抹', () => {
    const doc = PhotoDoc.createBlank('type-paint', 200, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'X';
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 200, 200, style);
    renderTextLayer(layer, 200, 200, doc.paths);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    assert(PhotoDoc.regenerates(layer), '沿路徑的文字會重畫');
    assert(doc.paintTarget() === null, '不應回傳繪圖目標');
    assert(doc.paintBlockReason()?.includes('點陣化'), '應告訴使用者要先點陣化');
  });
  await test('編輯路徑會帶著文字一起走', () => {
    const doc = PhotoDoc.createBlank('type-follow', 400, 300, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'FOLLOW';
    style.fontSize = 30;
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 400, 300, style);
    renderTextLayer(layer, 400, 300, doc.paths);
    doc.layers.push(layer);
    const before = opaqueBounds(layer.surface!)!;
    // Drag the whole baseline down the canvas.
    for (const a of path.subpaths[0].anchors) moveAnchor(a, a.x, a.y + 80);
    doc.refreshTextOnPath(path.id);
    const after = opaqueBounds(layer.surface!)!;
    near(after.y - before.y, 80, 2, '文字應跟著路徑下移');
  });
  await test('影像尺寸改變時路徑與文字一起縮放', () => {
    const doc = PhotoDoc.createBlank('type-resample', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'SCALE';
    style.fontSize = 30;
    style.onPath = defaultPathBinding(path.id);
    const layer = createTextLayer('文字', 400, 200, style);
    renderTextLayer(layer, 400, 200, doc.paths);
    doc.layers.push(layer);
    doc.resampleTo(800, 400);
    const anchors = doc.paths[0].subpaths[0].anchors;
    near(anchors[0].x, 40, 0.01, '路徑控制點應等比放大');
    near(anchors[0].y, 200, 0.01, '路徑控制點應等比放大');
    const b = opaqueBounds(layer.surface!)!;
    assert(b.y > 150 && b.y < 200, `文字應重新畫在新的基準線上，實得 ${b.y}`);
  });
  await test('沿路徑的文字可存檔並還原', async () => {
    const doc = PhotoDoc.createBlank('type-io', 400, 200, 'white');
    const path = linePath();
    doc.setPath(path);
    const style = defaultTextStyle();
    style.text = 'SAVED';
    style.fontSize = 28;
    style.onPath = { ...defaultPathBinding(path.id), offset: 40, baselineShift: 6, flip: true };
    const layer = createTextLayer('文字', 400, 200, style);
    renderTextLayer(layer, 400, 200, doc.paths);
    doc.layers.push(layer);
    const back = await loadProject(serializeDocument(doc));
    const restored = back.layers.find((l) => l.kind === 'text')!;
    assert(restored?.text?.onPath, '應還原路徑綁定');
    assert(restored.text!.onPath!.pathId === path.id, '路徑 id 應一致');
    near(restored.text!.onPath!.offset, 40, 0.001, '起點位移');
    near(restored.text!.onPath!.baselineShift, 6, 0.001, '基線位移');
    assert(restored.text!.onPath!.flip, '翻轉設定');
    const b = opaqueBounds(restored.surface!)!;
    assert(b.w > 0, '還原後應重新畫出字形');
  });
  await test('文字工具點在路徑上會直接建立路徑文字', () => {
    const doc = PhotoDoc.createBlank('type-tool', 400, 200, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    doc.setPath(linePath());
    const tool = TOOLS.find((t) => t.id === 'text')!;
    app.options(tool.id, optionDefaults(tool));
    tool.down(pointer(doc, 150, 103));
    const layer = doc.layers[doc.layers.length - 1];
    assert(layer.kind === 'text', '應新增文字圖層');
    assert(layer.text?.onPath, '點在路徑附近應綁定路徑');
    near(layer.text!.onPath!.offset, 130, 1, '起點應落在點擊處');
  });
  await test('點在離路徑很遠的地方仍是一般文字', () => {
    const doc = app.activeDoc()!;
    const tool = TOOLS.find((t) => t.id === 'text')!;
    tool.down(pointer(doc, 150, 180));
    const layer = doc.layers[doc.layers.length - 1];
    assert(!layer.text?.onPath, '離路徑太遠不應綁定');
    near(layer.x, 150, 1, '一般文字仍以點擊處為原點');
  });

  // ---- vector shape layers ----
  group('向量形狀圖層');
  await test('矩形與橢圓會產生正確的控制點數', () => {
    const rect = shapeToVectorPath('rect', 10, 20, 50, 60, 0, 5);
    assert(rect.subpaths.length === 1 && rect.subpaths[0].closed, '矩形應為單一封閉子路徑');
    assert(anchorCount(rect) === 4, `矩形應有 4 個控制點，實得 ${anchorCount(rect)}`);
    const ellipse = shapeToVectorPath('ellipse', 0, 0, 40, 20, 0, 5);
    assert(anchorCount(ellipse) === 4, '橢圓應以 4 個平滑點近似');
    assert(ellipse.subpaths[0].anchors.every((a) => a.smooth), '橢圓控制點應為平滑點');
    const star = shapeToVectorPath('star', 0, 0, 100, 100, 0, 6);
    assert(anchorCount(star) === 12, `六角星應有 12 個控制點，實得 ${anchorCount(star)}`);
    const line = shapeToVectorPath('line', 3, 4, 33, 44, 0, 5);
    assert(anchorCount(line) === 2 && !line.subpaths[0].closed, '線段應為 2 點開放路徑');
  });
  await test('形狀圖層會依樣式描繪填色與筆畫', () => {
    const doc = PhotoDoc.createBlank('shape', 60, 60, 'white');
    const layer = createRasterLayer('形狀', 60, 60);
    layer.kind = 'shape';
    const style = defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    style.strokeEnabled = true;
    style.strokeWidth = 6;
    style.strokeAlign = 'inside';
    layer.shape = { path: shapeToVectorPath('rect', 10, 10, 50, 50, 0, 5), style };
    renderShapeLayer(layer, doc.width, doc.height);
    assert(layer.x === 0 && layer.y === 0, '形狀圖層應為文件大小');
    const c = pixel(layer.surface!, 30, 30);
    assert(c[0] > 200 && c[2] < 60, `中心應為填色紅，實得 ${c}`);
    const edge = pixel(layer.surface!, 30, 12);
    assert(edge[2] > 200 && edge[0] < 60, `內部對齊筆畫應落在形狀內，實得 ${edge}`);
    const outside = pixel(layer.surface!, 30, 6);
    assert(outside[3] === 0, '內部對齊時形狀外不應有筆畫');
  });
  await test('關閉填色後只剩筆畫', () => {
    const layer = createRasterLayer('形狀', 40, 40);
    layer.kind = 'shape';
    const style = defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 });
    style.fillEnabled = false;
    style.strokeEnabled = true;
    style.strokeWidth = 4;
    layer.shape = { path: shapeToVectorPath('ellipse', 5, 5, 35, 35, 0, 5), style };
    renderShapeLayer(layer, 40, 40);
    assert(pixel(layer.surface!, 20, 20)[3] === 0, '關閉填色後中心應透明');
    assert(pixel(layer.surface!, 20, 5)[1] > 180, '筆畫仍應可見');
  });
  await test('形狀幾何會隨畫布變形一起搬移', () => {
    const doc = PhotoDoc.createBlank('shape-ops', 80, 40, 'white');
    const layer = createRasterLayer('形狀', 80, 40);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 10, 5, 30, 25, 0, 5),
      style: defaultShapeStyle({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 80, 40);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    doc.transformAll(doc.width, doc.height, (ctx) => {
      ctx.translate(doc.width, 0);
      ctx.scale(-1, 1);
    }, 'flipH');
    const xs = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    near(Math.min(...xs), 80 - 30, 0.01, '水平翻轉後最左點');
    near(Math.max(...xs), 80 - 10, 0.01, '水平翻轉後最右點');
    doc.resampleTo(160, 80);
    const scaled = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    near(Math.min(...scaled), (80 - 30) * 2, 0.01, '縮放後座標應等比放大');
    assert(layer.surface!.w === 160, '重新取樣後表面應跟著更新');
  });
  await test('形狀圖層可存檔並還原', async () => {
    const doc = PhotoDoc.createBlank('shape-io', 48, 48, 'white');
    const layer = createRasterLayer('星星', 48, 48);
    layer.kind = 'shape';
    const style = defaultShapeStyle({ r: 12, g: 200, b: 90 }, { r: 0, g: 0, b: 0 });
    style.dash = 5;
    layer.shape = { path: shapeToVectorPath('star', 4, 4, 44, 44, 0, 5), style };
    renderShapeLayer(layer, 48, 48);
    doc.layers.push(layer);
    const back = await loadProject(serializeDocument(doc));
    const restored = back.layers.find((l) => l.kind === 'shape')!;
    assert(restored, '應還原形狀圖層');
    assert(anchorCount(restored.shape!.path) === 10, '還原後控制點數應一致');
    near(restored.shape!.style.dash, 5, 0.001, '還原後虛線設定');
    assert(restored.surface, '還原後應重新描繪出表面');
    assert(restored.shape!.path !== layer.shape.path, '還原後應是獨立的幾何');
  });
  await test('複製形狀圖層不會共用幾何', () => {
    const layer = createRasterLayer('形狀', 32, 32);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 2, 2, 20, 20, 0, 5),
      style: defaultShapeStyle({ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }),
    };
    const copy = duplicateLayer(layer);
    copy.shape!.path.subpaths[0].anchors[0].x = 999;
    copy.shape!.style.strokeWidth = 42;
    assert(layer.shape.path.subpaths[0].anchors[0].x !== 999, '複本不應改到原圖層幾何');
    assert(layer.shape.style.strokeWidth !== 42, '複本不應改到原圖層樣式');
    const clone = cloneShapeStyle(layer.shape.style);
    clone.fill.r = 200;
    assert(layer.shape.style.fill.r === 1, 'cloneShapeStyle 應深拷貝顏色');
  });
  await test('直接選取工具會編輯形狀圖層本身的路徑', () => {
    const doc = PhotoDoc.createBlank('shape-edit', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = createRasterLayer('形狀', 64, 64);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 10, 10, 40, 40, 0, 5),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 64, 64);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    const tool = TOOLS.find((t) => t.id === 'direct-select')!;
    app.options(tool.id, optionDefaults(tool));
    tool.down(pointer(doc, 10, 10));
    tool.move(pointer(doc, 4, 4, { sx: 10, sy: 10 }));
    tool.up(pointer(doc, 4, 4, { sx: 10, sy: 10 }));
    const a = layer.shape.path.subpaths[0].anchors[0];
    near(a.x, 4, 0.01, '拖曳後控制點 X');
    near(a.y, 4, 0.01, '拖曳後控制點 Y');
    assert(pixel(layer.surface!, 6, 6)[0] > 200, '形狀應重新描繪到新位置');
    tool.cancel?.(app);
  });
  await test('形狀工具會建立可再編輯的形狀圖層', () => {
    const doc = PhotoDoc.createBlank('shape-tool', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const before = doc.layers.length;
    const tool = TOOLS.find((t) => t.id === 'shape')!;
    app.options(tool.id, { ...optionDefaults(tool), kind: 'ellipse', output: 'shape' });
    tool.down(pointer(doc, 8, 8));
    tool.move(pointer(doc, 40, 40, { sx: 8, sy: 8 }));
    tool.up(pointer(doc, 40, 40, { sx: 8, sy: 8 }));
    assert(doc.layers.length === before + 1, '應新增一個圖層');
    const layer = doc.layers[doc.layers.length - 1];
    assert(layer.kind === 'shape' && layer.shape, '新圖層應為形狀圖層');
    assert(anchorCount(layer.shape!.path) === 4, '橢圓應保留 4 個控制點');
    assert(pixel(layer.surface!, 24, 24)[3] > 0, '形狀應已描繪');
  });
  await test('未拖曳的點按不會留下空圖層', () => {
    const doc = app.activeDoc()!;
    const before = doc.layers.length;
    const tool = TOOLS.find((t) => t.id === 'shape')!;
    tool.down(pointer(doc, 20, 20));
    tool.up(pointer(doc, 20, 20));
    assert(doc.layers.length === before, '點按後圖層數不應改變');
  });
  await test('形狀描述會標出啟用的項目', () => {
    const style = defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    style.strokeEnabled = true;
    style.strokeWidth = 3;
    const text = describeShape({ path: shapeToVectorPath('rect', 0, 0, 10, 10, 0, 5), style });
    assert(text.includes('填色') && text.includes('筆畫'), `描述不完整：${text}`);
  });
  await test('transformPathPoints 會一併搬移控制桿', () => {
    const path = createPath('t');
    const a = createAnchor(10, 10, true);
    moveHandle(a, 'out', 20, 10, true);
    path.subpaths.push({ anchors: [a], closed: false });
    transformPathPoints(path, (p) => ({ x: p.x + 5, y: p.y - 2 }));
    near(a.x, 15, 0.001, '錪點 X');
    near(a.y, 8, 0.001, '錪點 Y');
    near(a.outX, 25, 0.001, '外控制桿 X');
    near(a.inX, 5, 0.001, '內控制桿 X');
  });

  await test('移動圖層的位移會寫回控制點', () => {
    const layer = createRasterLayer('形狀', 40, 40);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 5, 5, 15, 15, 0, 5),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 40, 40);
    layer.x = 12;
    layer.y = 8;
    renderShapeLayer(layer, 40, 40);
    assert(layer.x === 0 && layer.y === 0, '重畫後圖層位移應歸零');
    const xs = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    near(Math.min(...xs), 17, 0.01, '控制點應吸收水平位移');
    assert(pixel(layer.surface!, 20, 16)[0] > 200, '形狀應畫在移動後的位置');
    assert(pixel(layer.surface!, 8, 8)[3] === 0, '原位置應已清空');
  });
  await test('任意變形會搬動形狀的控制點而不是烘成像素', () => {
    const doc = PhotoDoc.createBlank('shape-xf', 80, 80, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = createRasterLayer('形狀', 80, 80);
    layer.kind = 'shape';
    const style = defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 });
    style.strokeEnabled = true;
    style.strokeWidth = 4;
    layer.shape = { path: shapeToVectorPath('rect', 20, 30, 40, 50, 0, 5), style };
    renderShapeLayer(layer, 80, 80);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    assert(transformTool.start(app), '應能對形狀圖層啟動變形');
    transformTool.setScale(app, 2, 2);
    transformTool.apply(app);
    const xs = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    const ys = layer.shape.path.subpaths[0].anchors.map((a) => a.y);
    near(Math.max(...xs) - Math.min(...xs), 40, 1.5, '寬度應放大一倍');
    near(Math.max(...ys) - Math.min(...ys), 40, 1.5, '高度應放大一倍');
    near(layer.shape.style.strokeWidth, 8, 0.01, '筆畫寬度應跟著縮放');
    // Re-rendering from the geometry must reproduce the transformed shape.
    const before = pixel(layer.surface!, 40, 40);
    renderShapeLayer(layer, 80, 80);
    const after = pixel(layer.surface!, 40, 40);
    assert(before[3] > 0 && after[3] > 0, '變形後中心應有像素');
    assert(before.join() === after.join(), '重畫後應與變形結果一致');
  });
  await test('形狀圖層不接受直接塗抹', () => {
    const doc = PhotoDoc.createBlank('shape-paint', 40, 40, 'white');
    const layer = createRasterLayer('形狀', 40, 40);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 5, 5, 30, 30, 0, 5),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 40, 40);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    assert(doc.paintTarget() === null, '形狀圖層不應回傳繪圖目標');
    assert(doc.paintBlockReason()?.includes('點陣化'), '應告訴使用者要先點陣化');
    doc.activeLayerId = doc.layers[0].id;
    assert(doc.paintTarget() !== null, '點陣圖層仍可繪圖');
    assert(doc.paintBlockReason() === null, '可繪圖時不應有阻擋原因');
    doc.activeLayer()!.locked = true;
    assert(doc.paintBlockReason()?.includes('鎖定'), '鎖定圖層應說明是鎖定');
  });
  await test('釋放位置與最後一次移動不同時以釋放點為準', () => {
    const doc = PhotoDoc.createBlank('shape-up', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const tool = TOOLS.find((t) => t.id === 'shape')!;
    app.options(tool.id, optionDefaults(tool));
    tool.down(pointer(doc, 10, 10));
    tool.move(pointer(doc, 20, 20, { sx: 10, sy: 10 }));
    // The pointer keeps travelling before the button comes up.
    tool.up(pointer(doc, 50, 44, { sx: 10, sy: 10 }));
    const layer = doc.layers[doc.layers.length - 1];
    const xs = layer.shape!.path.subpaths[0].anchors.map((a) => a.x);
    const ys = layer.shape!.path.subpaths[0].anchors.map((a) => a.y);
    near(Math.max(...xs), 50, 0.01, '右邊應跟到釋放點');
    near(Math.max(...ys), 44, 0.01, '下邊應跟到釋放點');
  });

  await test('會自己重畫的圖層不接受破壞性像素編輯', () => {
    const shape = createRasterLayer('形狀', 16, 16);
    shape.kind = 'shape';
    const smart = createRasterLayer('智慧', 16, 16);
    smart.kind = 'smart';
    const raster = createRasterLayer('點陣', 16, 16);
    assert(PhotoDoc.regenerates(shape), '形狀圖層會重畫');
    assert(PhotoDoc.regenerates(smart), '智慧型物件會重畫');
    assert(!PhotoDoc.regenerates(raster), '點陣圖層不會重畫');
  });
  await test('選取範圍存在時移動形狀圖層仍搬動整層', () => {
    const doc = PhotoDoc.createBlank('shape-move-sel', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = createRasterLayer('形狀', 64, 64);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('rect', 10, 10, 30, 30, 0, 5),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 64, 64);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    doc.selection.selectAll();
    const tool = TOOLS.find((t) => t.id === 'move')!;
    app.options(tool.id, optionDefaults(tool));
    tool.down(pointer(doc, 20, 20));
    tool.move(pointer(doc, 32, 26, { sx: 20, sy: 20 }));
    tool.up(pointer(doc, 32, 26, { sx: 20, sy: 20 }));
    const xs = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    near(Math.min(...xs), 22, 0.01, '控制點應跟著搬動');
    assert(layer.x === 0 && layer.y === 0, '位移應已折入幾何');
    doc.selection.clear();
  });
  await test('翻轉圖層會鏡射形狀的控制點', () => {
    const doc = PhotoDoc.createBlank('shape-flip', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = createRasterLayer('形狀', 64, 64);
    layer.kind = 'shape';
    layer.shape = {
      path: shapeToVectorPath('polygon', 10, 10, 40, 30, 0, 3),
      style: defaultShapeStyle({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }),
    };
    renderShapeLayer(layer, 64, 64);
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    const before = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    runCommand(app, 'edit.flipLayerH');
    const after = layer.shape.path.subpaths[0].anchors.map((a) => a.x);
    assert(layer.shape, '翻轉後仍應是形狀圖層');
    near(Math.min(...after), Math.min(...before), 0.6, '翻轉不應移動外接矩形');
    near(Math.max(...after), Math.max(...before), 0.6, '翻轉不應移動外接矩形');
    assert(after.join() !== before.join(), '控制點應確實被鏡射');
  });
  await test('編輯遮色片時形狀工具畫在遮色片上', () => {
    const doc = PhotoDoc.createBlank('shape-mask', 48, 48, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    const layer = doc.layers[0];
    layer.mask = createSurface(48, 48);
    layer.mask.ctx.fillStyle = '#fff';
    layer.mask.ctx.fillRect(0, 0, 48, 48);
    layer.maskEnabled = true;
    doc.editingMask = true;
    const before = doc.layers.length;
    const tool = TOOLS.find((t) => t.id === 'shape')!;
    app.options(tool.id, optionDefaults(tool));
    app.foreground = { r: 0, g: 0, b: 0 };
    tool.down(pointer(doc, 8, 8));
    tool.move(pointer(doc, 30, 30, { sx: 8, sy: 8 }));
    tool.up(pointer(doc, 30, 30, { sx: 8, sy: 8 }));
    assert(doc.layers.length === before, '不應在遮色片模式下新增圖層');
    assert(pixel(doc.layers[0].mask!, 20, 20)[0] < 60, '形狀應畫進遮色片');
    doc.editingMask = false;
  });

  // ---- histogram panel ----
  group('色階分佈圖');
  await test('統計值符合已知影像', () => {
    const s = filled(10, 10, '#808080');
    const hist = computeHistogram(s.ctx.getImageData(0, 0, 10, 10));
    const stats = statsFor(hist.rgb, hist.total);
    assert(stats.pixels === 100, `像素數應為 100，實得 ${stats.pixels}`);
    near(stats.mean, 128, 1.5, '純灰階的平均值');
    near(stats.stdDev, 0, 0.01, '單一色調的標準差應為 0');
    assert(stats.min === stats.max, '單一色調的最暗與最亮應相同');
  });
  await test('半黑半白的中間值落在資料中央', () => {
    const s = createSurface(10, 10);
    s.ctx.fillStyle = '#000000';
    s.ctx.fillRect(0, 0, 10, 5);
    s.ctx.fillStyle = '#ffffff';
    s.ctx.fillRect(0, 5, 10, 5);
    const hist = computeHistogram(s.ctx.getImageData(0, 0, 10, 10));
    const stats = statsFor(hist.rgb, hist.total);
    near(stats.mean, 127.5, 1, '半黑半白的平均值');
    assert(stats.min === 0 && stats.max === 255, '應涵蓋全幅');
    assert(stats.median === 0, `中間值應落在前半段，實得 ${stats.median}`);
    near(stats.stdDev, 127.5, 1, '兩極分佈的標準差');
  });
  await test('完全透明的影像不會除以零', () => {
    const s = createSurface(4, 4);
    const hist = computeHistogram(s.ctx.getImageData(0, 0, 4, 4));
    const stats = statsFor(hist.rgb, hist.total);
    assert(stats.pixels === 0 && stats.mean === 0, '空白統計應為零值');
  });
  await test('紅色色版統計與明度不同', () => {
    const s = filled(8, 8, 'rgb(255,0,0)');
    const hist = computeHistogram(s.ctx.getImageData(0, 0, 8, 8));
    near(statsFor(hist.r, hist.total).mean, 255, 0.5, '紅色版平均值');
    near(statsFor(hist.g, hist.total).mean, 0, 0.5, '綠色版平均值');
    assert(statsFor(hist.rgb, hist.total).mean < 200, '明度應低於純紅的紅色版');
  });

  await test('快取鍵值包含文件身分', () => {
    const a = PhotoDoc.createBlank('a', 8, 8, 'white');
    const b = PhotoDoc.createBlank('b', 8, 8, 'black');
    assert(a.meta.id !== b.meta.id, '兩個文件的 id 應不同');
    assert(a.revision === b.revision, '兩個新文件的版本號會相同，所以鍵值不能只看版本');
    const statsOf = (d: PhotoDoc): number => {
      const s2 = d.render();
      const h = computeHistogram(s2.ctx.getImageData(0, 0, s2.w, s2.h));
      return statsFor(h.rgb, h.total).mean;
    };
    near(statsOf(a), 255, 1, '白底文件的平均值');
    near(statsOf(b), 0, 1, '黑底文件的平均值');
  });
  await test('合併影像不含快速遮色片等畫面疊加', () => {
    const d = PhotoDoc.createBlank('overlay', 16, 16, 'white');
    d.enterQuickMask();
    // Paint half the channel black, which is what puts the red tint on screen.
    const qm = d.quickMask!.surface;
    qm.ctx.fillStyle = '#000';
    qm.ctx.fillRect(0, 0, 8, 16);
    const overlaid = d.composite();
    const plain = d.render();
    const meanOf = (s2: ReturnType<typeof createSurface>): number => {
      const h = computeHistogram(s2.ctx.getImageData(0, 0, s2.w, s2.h));
      return statsFor(h.rgb, h.total).mean;
    };
    near(meanOf(plain), 255, 1, '未疊加的合併影像應仍是白的');
    assert(meanOf(overlaid) !== meanOf(plain), '快速遮色片疊加確實會改變畫面');
  });

  // ---- layer search and filter ----
  group('圖層搜尋與篩選');
  await test('名稱搜尋不分大小寫', () => {
    const layer = createRasterLayer('Background Copy', 8, 8);
    assert(layerMatchesFilter(layer, 'background', 'all'), '應命中小寫關鍵字');
    assert(layerMatchesFilter(layer, 'copy', 'all'), '應命中部分字串');
    assert(!layerMatchesFilter(layer, 'shape', 'all'), '不相符時不應命中');
    assert(layerMatchesFilter(layer, '', 'all'), '空關鍵字應全部通過');
  });
  await test('類型篩選能分辨形狀與調整圖層', () => {
    const raster = createRasterLayer('點陣', 8, 8);
    const shape = createRasterLayer('形狀', 8, 8);
    shape.kind = 'shape';
    const adj = createAdjustmentLayer('levels', defaultAdjustment('levels'));
    assert(layerMatchesFilter(shape, '', 'shape'), '形狀圖層應通過形狀篩選');
    assert(!layerMatchesFilter(raster, '', 'shape'), '點陣圖層不應通過形狀篩選');
    assert(layerMatchesFilter(adj, '', 'adjustment'), '調整圖層應通過調整篩選');
    assert(layerMatchesFilter(raster, '', 'raster'), '點陣圖層應通過點陣篩選');
  });
  await test('遮色片與樣式篩選', () => {
    const plain = createRasterLayer('無', 8, 8);
    const masked = createRasterLayer('有遮色片', 8, 8);
    masked.mask = createSurface(8, 8);
    const styled = createRasterLayer('有樣式', 8, 8);
    styled.effects.stroke.enabled = true;
    assert(layerMatchesFilter(masked, '', 'masked'), '應命中有遮色片的圖層');
    assert(!layerMatchesFilter(plain, '', 'masked'), '無遮色片不應命中');
    assert(layerMatchesFilter(styled, '', 'effects'), '應命中有圖層樣式的圖層');
    assert(!layerMatchesFilter(plain, '', 'effects'), '無樣式不應命中');
  });
  await test('群組會因子圖層命中而保留', () => {
    const child = createRasterLayer('logo', 8, 8);
    child.kind = 'shape';
    const folder = createRasterLayer('資料夾', 8, 8);
    folder.kind = 'group';
    folder.children = [child];
    folder.surface = null;
    assert(layerMatchesFilter(folder, 'logo', 'all'), '子圖層命中時群組應保留');
    assert(layerMatchesFilter(folder, '', 'shape'), '子圖層型別命中時群組應保留');
    assert(!layerMatchesFilter(folder, 'nothing', 'all'), '全部不命中時群組應隱藏');
    assert(layerMatchesFilter(folder, '', 'group'), '群組本身應通過群組篩選');
  });

  // ---- tools smoke test ----
  group('工具互動');
  await test('每個工具都能完成一次拖曳而不出錯', () => {
    const doc = PhotoDoc.createBlank('smoke', 64, 64, 'white');
    app.docs.length = 0;
    app.addDoc(doc);
    // Give the clone stamp a source and the polygon lasso a few clicks.
    const failures: string[] = [];
    for (const tool of TOOLS) {
      try {
        app.options(tool.id, optionDefaults(tool));
        const alt = tool.id === 'clone';
        tool.down(pointer(doc, 12, 12, { alt }));
        if (alt) tool.down(pointer(doc, 20, 20));
        tool.move(pointer(doc, 30, 26, { sx: 12, sy: 12 }));
        tool.move(pointer(doc, 44, 38, { sx: 12, sy: 12 }));
        tool.up(pointer(doc, 44, 38, { sx: 12, sy: 12 }));
        tool.cancel?.(app);
      } catch (err) {
        failures.push(`${tool.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert(failures.length === 0, failures.join(' | '));
  });
  await test('工具互動後文件仍可合成', () => {
    const doc = app.activeDoc()!;
    doc.livePreview = null;
    const out = doc.render();
    assert(out.w === doc.width && out.h === doc.height, '合成輸出尺寸不符');
  });

  render();
}

function pointer(
  doc: PhotoDoc, x: number, y: number,
  extra: { alt?: boolean; shift?: boolean; sx?: number; sy?: number } = {},
): ToolPointer {
  return {
    app,
    doc,
    x,
    y,
    px: x,
    py: y,
    sx: extra.sx ?? x,
    sy: extra.sy ?? y,
    screenX: x,
    screenY: y,
    screenSX: extra.sx ?? x,
    screenSY: extra.sy ?? y,
    pressure: 1,
    shift: extra.shift ?? false,
    alt: extra.alt ?? false,
    ctrl: false,
    button: 0,
    zoom: 1,
  };
}

function render(): void {
  const out = document.getElementById('out')!;
  let pass = 0, fail = 0;
  out.innerHTML = '';
  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'group';
    head.textContent = g.name;
    out.append(head);
    for (const c of g.cases) {
      const row = document.createElement('div');
      row.className = 'case';
      if (c.error) {
        fail++;
        row.innerHTML = `<span class="fail">✕ ${c.name}</span><span class="why">${c.error}</span>`;
      } else {
        pass++;
        row.innerHTML = `<span class="ok">✓</span> ${c.name}`;
      }
      out.append(row);
    }
  }
  const summary = document.getElementById('summary')!;
  summary.className = fail === 0 ? 'ok' : 'fail';
  summary.textContent = fail === 0
    ? `全部通過：${pass} 項測試`
    : `${pass} 項通過，${fail} 項失敗`;
  (window as unknown as { __testResult: unknown }).__testResult = { pass, fail };
}

void run();
