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
import { Stroke, defaultBrush } from '../src/tools/stroke';
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
    const stroke = new Stroke(doc, layer, layer.surface!, false, settings, 'paint');
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
    const stroke = new Stroke(doc, layer, layer.surface!, false, settings, 'erase');
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
