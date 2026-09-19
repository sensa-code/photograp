/**
 * Browser test suite for Photograp's imaging core.
 * Open /tests/index.html with the dev server running.
 */
import { hexToRgb, hslToRgb, hsvToRgb, rgbToHex, rgbToHsl, rgbToHsv } from '../src/core/color';
import { createSurface, cloneSurface, opaqueBounds } from '../src/core/surface';
import { Selection, rasterizePath } from '../src/core/selection';
import { compositeLayers } from '../src/core/compositor';
import { createAdjustmentLayer, createRasterLayer, duplicateLayer } from '../src/core/layer';
import { maskAlpha, maskFromCoverage, coverageFromMask } from '../src/core/mask';
import { PhotoDoc } from '../src/core/document';
import { applyAdjustment, curveLut, defaultAdjustment } from '../src/filters/adjustments';
import { gaussianBlur, unsharpMask } from '../src/filters/blur';
import { pixelate, findEdges } from '../src/filters/effects';
import { getFilter, defaultParams } from '../src/filters/registry';
import { Stroke, defaultBrush, brushStamp } from '../src/tools/stroke';
import {
  BUILTIN_PRESETS, applySettingsToOptions, createPreset, describePreset,
  loadPresets, resetPresets, savePresets, settingsFromOptions,
} from '../src/core/brush-presets';
import { floodSelect } from '../src/tools/select';
import { renderGradient, presetStops, shapePath } from '../src/tools/draw';
import { defaultTextStyle, renderTextLayer, measureText } from '../src/core/text';
import { serializeDocument, loadProject } from '../src/io/files';
import { TOOLS } from '../src/tools';
import { optionDefaults, type ToolPointer } from '../src/tools/types';
import { app } from '../src/core/app';
import {
  anchorCount, createAnchor, createPath, hitTest, moveAnchor, moveHandle,
  pathFromLoops, simplify, toPath2D,
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
import { runCommand } from '../src/ui/commands';
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
