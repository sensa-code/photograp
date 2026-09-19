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
       └─ ui/panels/*      導覽器、顏色、步驟記錄、圖層／色版／路徑頁籤群組
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
- `paths` / `activePathId`：具名向量路徑
- `channels` / `channelView`：Alpha 色版與目前檢視的色版
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
- 動態虛線邊框由 `traceLoops()` 產生：先在「內/外」交界產生單位有向邊，
  再串接成封閉迴圈，這樣 `setLineDash` 才能沿著輪廓連續跑。

## 向量路徑

`core/path.ts` 的 `VectorPath` 由多個 `SubPath` 組成，每個子路徑是一串 `Anchor`。
控制桿（`inX/inY`、`outX/outY`）存絕對文件座標，命中測試與拖曳都不需要換算。

- `toPath2D()` 會在兩端控制桿都貼在控制點上時輸出 `lineTo`，否則輸出 `bezierCurveTo`，
  所以同一條路徑可以混用直線段與曲線段。
- 平滑點在拖曳控制桿時由 `moveHandle(..., mirror)` 鏡射另一側。
- 「從選取範圍建立工作路徑」重用選取範圍的輪廓追蹤結果（`Selection.loops()`），
  再以 Ramer–Douglas–Peucker 簡化。追蹤出的迴圈不含重複的收尾點，
  否則 RDP 的基準線會退化成零長度。
- 筆型工具與直接選取工具都標記為 `group: 'vector'`；畫布在非向量工具下只畫路徑外框，
  向量工具下才畫控制點與控制桿。

## 色版

`core/channels.ts` 同時處理兩件事：

- **色彩色版**：從合成結果即時抽出 R/G/B 當成灰階顯示（`extractChannel`）。
- **Alpha 色版**：儲存的 8 位元遮罩，格式與圖層遮色片相同（不透明灰階）。
  可由選取範圍建立，也可以 Ctrl 點擊載回選取範圍。

`renderChannelView()` 在 `PhotoDoc.composite()` 的最後一步套用：
檢視單一色版時輸出灰階，檢視 RGB 時把「顯示中」的 Alpha 色版以設定的顏色疊印上去，
效果等同快速遮色片。合成快取的鍵值含 `channelView` 與顯示中的色版清單。

## 修復與內容感知填色

### 無縫貼合（filters/heal.ts）

修復類工具都建立在同一個運算上：把來源貼進遮色片範圍，但額外加上一個
**調和（harmonic）修正場**，讓貼進來的內容在接縫處與目標完全吻合。
數學上就是解 Laplace 方程式，邊界條件是接縫上的差值，這正是 Poisson
image editing 的簡化版；結果會保留來源的紋理，但亮度與色調跟著目標走。

一開始這裡用單純的 Gauss-Seidel 鬆弛，結果大筆刷修不乾淨——
平面鬆弛要 O(n²) 次掃描才能把邊界值送到寬區域的中心，
迭代次數不夠時內部會保留初始值，等於把原本的瑕疵又畫回去。
現在改成 `solveMembrane()`：先在縮小一半的格點上解，再把答案內插回來，
遞迴到很小的格點為止（多重網格的 cascadic 版本），成本接近線性。

取樣來源由 `findHealSource()` 決定：在瑕疵外圍取一圈像素，
拿它跟各個候選位移處的同一圈比較平方差，挑最像的那個。
換句話說，「周圍長得最像的地方」就是最好的補丁來源。

為了速度，來源不會實際複製一份影像，而是以位移直接從目標取樣
（`seamlessCloneOffset`），外圈的計算也只在瑕疵附近的視窗做。

### 內容感知填色（filters/inpaint.ts）

多尺度 PatchMatch + 投票（Wexler 式影像補全）：

1. 只取破洞周圍的視窗來處理，並限制最長邊，成本因此取決於破洞而非整張圖。
2. 建影像金字塔，最粗的一層先用「把已知顏色往內推」的方式給初始值。
3. 每一層跑數次 EM：
   - **E**：PatchMatch 為每個破洞像素找最相似的來源區塊
     （傳遞 + 半徑遞減的隨機搜尋），來源必須整塊落在已知區域。
   - **M**：投票——每個破洞像素由所有覆蓋它的區塊重建，
     以 `exp(-誤差/50)` 加權，好的匹配權重高，避免結果糊掉。
4. 升到下一層時同時內插顏色與 NNF，收斂會快很多。

## 參考線與靠齊

`core/guides.ts`。參考線只是一條帶方向的座標（`{ axis: 'h' | 'v'; pos }`），
存在文件上，因此會進步驟記錄與專案檔。

靠齊分成兩步：

1. `collectSnapTargets()` 依照偏好設定收集候選座標——文件邊界與中線、
   參考線、其他圖層內容的邊與中心；格點則以「步進值」形式留在 `SnapContext.grid`，
   避免產生整張畫布的候選清單。拖曳中的圖層會用 `excludeLayerId` 排除自己。
2. `snapScalar` / `snapGroup` / `snapRect` / `snapPoint` 在容許距離內挑最近的候選。
   `snapGroup` 用在「一起移動的一組座標」（例如圖層的左緣、中心、右緣），
   取其中調整量最小的那個。

容許距離以螢幕像素定義（8px），再除以縮放倍率換成文件單位，
所以放大時靠齊不會變得過於黏手。`tools/snap.ts` 的 `snapContextFor()` 統一組裝，
並在按住 Ctrl 時回傳空的環境——這就是暫時停用靠齊的方式。

命中的線會寫到 `app.snapLines`，由畫布在疊加層畫成洋紅色虛線，拖曳結束時清掉。
尺標拖曳建立參考線、以移動工具拖動既有參考線都由 `CanvasView` 直接處理，
因為它們發生在工具系統之外（在尺標上，或是在任何工具下都該生效的命中測試）。

## 快速遮色片

`core/quickmask.ts`。快速遮色片就是「把選取範圍暫時變成一張可塗抹的灰階圖」，
格式與圖層遮色片、Alpha 色版一致（白 = 選取）。

為了讓所有繪圖工具都能直接編輯它，`PhotoDoc` 把繪製目標抽象成 `PaintSlot`：

```ts
type PaintSlot = 'pixels' | 'mask' | 'quickmask';
doc.paintTarget(): { layer, surface, slot } | null
doc.mutablePaintSurface(layer, slot): Surface
doc.setPaintPreview(layer, slot, surface): void
```

`Stroke`、`DirectStroke` 與 `PixelOpSession` 都只認這個 slot，因此筆刷、修圖工具、
調整、濾鏡與液化不需要各自處理三種目標。快速遮色片模式下 `paintTarget()` 直接回傳
`quickmask`（且 `layer` 為 null），並且不套用選取範圍裁切——因為它正在編輯選取範圍本身。

疊印在 `PhotoDoc.composite()` 的最後一步由 `renderQuickMaskOverlay()` 畫上；
離開模式時把灰階轉回覆蓋率，若整張都是 255 就直接取消選取。

## 液化

`filters/liquify.ts` 的 `WarpMesh` 是一張位移網格（預設每 4 像素一個節點），
語意是 **取樣位移**：`out(p) = src(p + D(p))`。所以要把內容往某方向推，
就從被筆刷碰到的節點 **減去** 那個方向。

- 筆刷落點用鐘形衰減 `(1 - d²/r²)²`，再乘上 `1 - freeze[i]`
- 扭轉是把節點相對筆刷中心旋轉後的差值；縮攏／膨脹沿半徑方向推拉
- 重建把位移乘上 `1 - w·amount` 逐步收斂回 0
- 凍結遮色片是同一張網格上的另一個 `Float32Array`

`warpImage(src, dst, mesh, scale)` 的 `scale` 表示「一個文件單位等於幾個影像像素」，
所以同一張網格可以先驅動縮小的即時預覽，按下確定後再以 `scale = 1` 在原尺寸重跑一次，
不會有兩套變形邏輯。

## 智慧型物件

`core/smart.ts`。智慧型物件圖層 (`kind: 'smart'`) 持有：

- `source`：原始像素，永遠不被寫入
- 放置資料：`cx/cy`、`scaleX/scaleY`、`angle`
- `filters`：可編輯的智慧型濾鏡堆疊

`layer.surface` 只是快取。`renderSmartLayer()` 會從 `source` 依放置資料重畫，
再依序套用啟用中的濾鏡（只處理放置範圍的外接矩形），因此：

- 縮小再放大不會累積重新取樣的損失
- 濾鏡參數隨時可改、可停用、可調整順序
- 影像尺寸／版面尺寸／版面旋轉翻轉都只轉換放置資料
  （`PhotoDoc.transformAll` 的 `smartOp` 參數負責映射中心點、角度與鏡射）
- 任意變形工具偵測到智慧型物件時會寫回放置資料而不是烘焙像素

因為像素是算出來的，`paintTarget()` 會拒絕把智慧型物件當成繪製目標，
避免筆觸在下一次重繪時被覆蓋；要直接畫就先點陣化。

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

### 筆尖與預設集

`brushStamp()` 會在畫印章前先 `rotate(angle)` 再 `scale(1, roundness)`，
所以同一段程式就能畫出圓筆與傾斜的扁筆；快取鍵包含形狀與顏色。
尺寸抖動在 `dab()` 裡逐一改變印章大小，會多建幾個快取項目，
但因為尺寸被量化到 0.5px，項目數仍然有限。

`core/brush-presets.ts` 的預設集刻意用**選項列的單位**存值
（硬度、不透明度、流量、圓度都是百分比），因此套用預設集就是把值
直接複製進 `app.toolOptions`，不需要兩套換算。套用時會跳過工具沒有宣告的鍵，
免得在橡皮擦的選項裡留下一個永遠用不到的 `scatter`。

自訂內容存在 localStorage，格式是 `{ user, hiddenBuiltins }` 而不是整份清單，
這樣日後新增內建筆刷時，既有使用者也看得到。

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

版本 2 起另外包含 `paths`、`activePathId` 與 `channels`，
智慧型物件圖層會多存一個 `smart` 區塊（內嵌原始來源的 PNG 與放置資料、濾鏡堆疊）；
版本 3 再加上 `quickMask`，所以存檔時停在快速遮色片模式也不會遺失；
版本 4 加上 `guides` 與 `guidesLocked`。
載入後會重新渲染智慧型物件的快取。格式演進時請提高 `version`
並在 `io/files.ts` 的 `loadProject()` 內做向下相容處理。

## 測試

`tests/suite.ts` 是在瀏覽器執行的測試（影像運算需要真正的 Canvas）。
新增功能時請一併補上對應測試，並確認 <http://localhost:5180/tests/index.html> 全數通過。
