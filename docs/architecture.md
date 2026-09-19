# Photograp 架構說明

本文說明 Photograp 的內部設計，方便擴充工具、濾鏡與面板。

## 分層

```
main.ts
  └─ ui/app-ui.ts          組裝整個工作區
       ├─ ui/menubar.ts    選單（由 ui/menus.ts 的樹狀定義產生）
       ├─ ui/toolbar.ts    工具列與前景/背景色
       ├─ ui/optionsbar.ts 依作用中工具的 options 宣告自動產生控制項
       ├─ ui/canvas-view.ts 畫布視埠：座標轉換、指標事件、疊加層繪製
       └─ ui/panels/*      導覽器、顏色、步驟記錄、圖層
core/                      與 DOM UI 無關的文件模型
tools/                     工具實作，只依賴 core
filters/                   純函式：輸入 ImageData，就地修改
io/                        檔案讀寫與專案序列化
```

UI 透過 `core/app.ts` 的 `App` 單例取得狀態，並以 `Emitter` 發送事件
（`doc-changed`、`view-changed`、`tool-changed`、`options-changed`、`color-changed`、
`status`、`toast`）。面板只監聽自己需要的事件並重繪。

## 文件模型

`PhotoDoc` 擁有：

- `meta`：名稱、寬高、dpi
- `layers`：由下而上的圖層陣列（群組的 `children` 同樣由下而上）
- `selection`：`Selection` 實例
- `history`：`History` 快照堆疊
- `livePreview`：工具進行中的暫時畫面

### Surface

`Surface` 是 `{ canvas, ctx, w, h }` 的薄封裝。圖層像素、遮色片、暫存緩衝都是 Surface，
因此都能用 Canvas 2D 管線繪製。

### 座標系

- **文件座標**：以畫布左上角為原點。
- **圖層座標**：圖層的 Surface 與文件同尺寸，但 `layer.x / layer.y` 會在合成時位移它。
  在圖層上作畫時要先把文件座標減去該位移；遮色片則永遠位於文件座標（位移為 0）。

### 遮色片

遮色片存成**不透明灰階** Surface（白 = 顯示）。這樣就能直接用筆刷、漸層、濾鏡編輯它。
合成時 `core/mask.ts` 的 `maskAlpha()` 會把灰階轉成 alpha，並以 `WeakMap` 快取；
因為任何修改都會替換整個 Surface 物件，快取不會過期。

### 步驟記錄與寫入時複製

`History` 儲存的是文件狀態的淺快照：圖層記錄會被複製，但像素 Surface 以參照共用。
規則是：**任何會改變像素的操作都必須先換上新的 Surface**，而不是就地塗改舊的。
`PhotoDoc.mutableSurface(layer)` 與 `mutableMask(layer)` 負責這件事。

因此一個步驟的記憶體成本只等於「該次真正被改寫的圖層」，而不是整份文件。

## 合成

`core/compositor.ts` 由下往上走訪圖層：

1. 收集緊鄰其上、標記為 `clipped` 的圖層，組成剪裁群組。
2. 圖層像素繪製到與文件同尺寸的緩衝，套用圖層樣式與遮色片。
3. 剪裁群組的成員先合成到基底上，再以基底的 alpha 做 `destination-in`。
4. 以 `blendSurface()` 疊到累積結果上。

`core/blend.ts` 對 Canvas 原生支援的模式直接使用 `globalCompositeOperation`；
其餘（溶解、線性加深、強烈光、線性光、小光源、實色疊印、減去、分割）走逐像素路徑，
採用 W3C 合成公式處理 alpha。

調整圖層不畫像素，而是讀取目前累積結果、套用調整、再依自身遮色片與不透明度疊回去。

## 選取範圍

`Selection` 以 8 位元覆蓋率緩衝（`Uint8Array`）表示，`mask === null` 代表沒有選取範圍
（此時所有操作作用於全圖）。

- 幾何選取先畫成 `Path2D` 再用 `rasterizePath()` 光柵化，因此自帶消除鋸齒。
- 羽化是三次盒狀模糊（近似高斯）；擴張/縮減是可分離的最大/最小值濾波。
- 動態虛線邊框由 `traceOutline()` 產生：先在「內/外」交界產生單位有向邊，
  再串接成封閉迴圈，這樣 `setLineDash` 才能沿著輪廓連續跑。

## 工具

工具實作 `tools/types.ts` 的 `Tool` 介面：

```ts
interface Tool {
  id: string; name: string; shortcut: string; icon: string; group: string;
  options: ToolOption[];              // 宣告式，選項列自動產生 UI
  down(e: ToolPointer): void;
  move(e: ToolPointer): void;
  up(e: ToolPointer): void;
  drawOverlay?(o: OverlayPaint): void; // 在文件座標中繪製
  key?(e: KeyboardEvent, app: App): boolean;
  cancel?(app: App): void;
}
```

新增工具的步驟：

1. 在 `src/tools/` 建立類別並實作介面。
2. 在 `src/tools/index.ts` 的 `TOOLS` 加入實例，並在 `TOOL_SLOTS` 指定工具列位置。
3. 選項列、快速鍵與筆刷游標都會自動生效。

### 筆觸引擎

`tools/stroke.ts` 的 `Stroke` 負責筆刷類工具：

- 筆觸先累積在 `scratch`，每段結束才依選取範圍裁切，並只重繪髒矩形範圍的預視。
- `commit()` 時整條筆觸以「筆觸不透明度」一次貼上，所以同一筆內的重疊不會加深。
- 筆刷印章依尺寸/硬度/顏色快取，避免每個 dab 都重建漸層。

`tools/paint.ts` 另有 `DirectStroke`，供需要「讀取現有像素再改寫」的工具
（模糊、銳利化、加亮加深、指尖、仿製印章）使用。

## 濾鏡與調整

`filters/adjustments.ts` 輸入 `AdjustmentSpec` 與 `ImageData`，就地修改；
能用查表法的（亮度對比、色階、曲線、曝光、色調分離）都走 256 項 LUT。

`filters/registry.ts` 以宣告式描述每個濾鏡的參數，
`ui/dialogs/pixel-op.ts` 會據此自動產生對話框，並提供：

- 只處理選取範圍外接矩形的即時預視
- 預視開關
- 確定後才寫入圖層並推入步驟記錄

新增濾鏡只需在 `FILTERS` 陣列加一筆定義，選單與對話框都會自動出現。

## 專案檔格式

`.pgraph` 是 JSON，圖層與遮色片以 PNG data URL 內嵌：

```jsonc
{
  "magic": "photograp-project",
  "version": 1,
  "name": "未命名-1",
  "width": 1280, "height": 800, "dpi": 72,
  "activeLayerId": "…",
  "selection": "data:image/png;base64,…",  // alpha = 覆蓋率
  "layers": [ { "kind": "raster", "blend": "multiply", "surface": "data:image/png;…", … } ]
}
```

格式演進時請提高 `version` 並在 `io/files.ts` 的 `loadProject()` 內做向下相容處理。

## 測試

`tests/suite.ts` 是在瀏覽器執行的測試（影像運算需要真正的 Canvas）。
新增功能時請一併補上對應測試，並確認 <http://localhost:5180/tests/index.html> 全數通過。
