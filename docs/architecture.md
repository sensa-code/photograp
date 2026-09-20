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
       └─ ui/panels/*      導覽器、顏色、色階分佈圖、步驟記錄、
                           圖層／色版／路徑／筆刷頁籤群組
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

## 向量形狀圖層

`core/shape.ts` 把一個 `VectorPath` 加上 `ShapeStyle` 綁成 `ShapeLayerData`，
挂在 `layer.shape` 上，`layer.kind` 為 `'shape'`。像素是讀取端：
`renderShapeLayer()` 每次都把幾何重新畫成文件大小的 Surface，
因此後續的合成、混合模式、遮色片與圖層樣式完全不用特別處理。

- 筆畫對齊：`center` 直接描邊；`inside` / `outside` 先用雙倍寬度的置中筆畫
  畫在另一張 Surface 上，再以 `destination-in` / `destination-out` 跟填色區域相交或相減，
  效果等同於只保留形狀內側或外側的那一半。
- `shapeToVectorPath()` 把七種形狀轉成貝茲路徑；圓弧以
  `KAPPA = 0.5522847498307936` 決定控制桿長度（四段三次貝茲近似圓的標準係數）。
- 直接選取工具透過 `editablePath()` 先看作用中的圖層是不是未鎖定的形狀圖層，
  是的話就編輯它自己的路徑，否則回到文件的工作路徑；每次改動後呼叫 `afterEdit()` 重畫。
- 幾何是**可變物件**，所以 `shallowCopyLayer()` 與 `duplicateLayer()` 都必須深拷貝
  （`cloneShape()`），否則步驟記錄的快取會跟現場共用同一組控制點。
- 畫布幾何運算搬動控制點而不重新取樣：`resampleTo()` 等比縮放錐點與筆畫寬度、
  `resizeCanvas()` 位移、`transformAll()` 則用 `canvasPointMap()` 把旋轉與翻轉映射到點上。
- 位置也存在幾何裡：`renderShapeLayer()` 會先把 `layer.x/y` 折入控制點再歸零，
  因此移動工具拖曳完、下一次重畫時不會彈回原位；任意變形則以與預覽相同的
  矩陣搬動控制點（筆畫寬度乘上 `sqrt(|sx*sy|)`）而不是烘成像素。
- `paintTarget()` 對形狀圖層回傳 `null`（跟智慧型物件一樣），否則筆刷畫上去的
  像素會在下一次重畫時消失；`paintBlockReason()` 負責把原因講給使用者聽。
- `core/ids.ts` 只放 `uid()`。拆出來是因為 `layer.ts` 要 import `shape.ts` 的型別、
  而 `shape.ts` 又要 `uid()`，直接互相 import 會形成循環。

## 文字沿路徑

`TextStyle.onPath` 指向一條文件路徑，`renderTextLayer()` 看到它就改走弧長排版，
並把 `layer.x/y` 歸零（字形位置已經帶著路徑的文件座標）。

- 貝茲的參數 `t` 不等於弧長，所以 `core/path.ts` 先把子路徑展平成折線
  （`flattenSubPath()`，每段的切割數與控制多邊形長度成比例）並累積長度，
  `pathPointAt()` 再以二分搜尋找出距離對應的點與切線。
- 封閉路徑的距離會取模回繞；開放路徑超出端點時沿切線延伸，
  文字比路徑長時才不會整段消失。
- 排版時每個字形放在自己字寬的**中點**，並以該處切線旋轉；
  翻轉則是沿路徑反向走一遍再多轉 pi，等同於把整段字對曲線做鏡射。
  基線位移的符號兩邊一致（正值一律是「離開曲線」），因為旋轉 pi 已經把
  局部座標的上下換過來了。
- `PhotoDoc.refreshTextOnPath()` 負責在路徑被編輯時重畫綁定的文字；
  `PhotoDoc.regenerates()` 也把它算進去，所以破壞性像素編輯會被擋下來。
- 文件的儲存路徑現在也會跟著影像尺寸、版面尺寸與旋轉翻轉一起變換，
  否則改完畫布之後文字會跡到與曲線不同的地方。

## 逐像素的調整

`applyAdjustment()` 拿到的可能是整張合成、智慧濾鏡的來源，也可能只是
選取範圍的外接矩形（見 `PixelOpSession.region`）。因此**每一種調整都必須是
逐像素的**：只要依賴鄰居，在有選取範圍時就會在裁切邊界產生與全圖不同的
結果。陰影/亮部因此不採用 Photoshop 那種模糊半徑的局部調性，而是用像素
自己的明度算遮罩；提亮是乘法，所以黑點不動而近黑的差距被拉開。

選取顏色的家族權重用 60 度寬的三角窗，相鄰兩個家族共用一個像素且權重相加
為一，再乘上彩度，接近灰色的像素就留給白/中間調/黑三個中性家族。

`defaultAdjustment()` 是泛型的，傳字面型別時回傳收窄過的變體，
呼叫端才拿得到該變體自己的欄位。

## 桌面版（electron/ 與 io/desktop.ts）

主行程（`electron/main.cts`）是唯一碰得到檔案系統的地方，算繪行程只能透過
preload 用 `contextBridge` 開出來的那幾個函式說話，而且開著 `contextIsolation`
與 `sandbox`。

- 頁面遞過來的路徑一律先比對副檔名白名單（`.pgraph` 與幾種影像格式）再讀，
  所以就算算繪端被塞了奇怪的字串，也讀不到系統檔案。
- 檔案是以 **data URL** 交給算繪端的：那正好是專案原本就會解碼的格式，
  不必為了桌面版多寫一條讀檔路徑。
- `io/desktop.ts` 是**唯一**允許碰 `window.photograp` 的模組，其他地方都走它。
  沒有橋接時每個函式回 `null`，呼叫端據此改走網頁路徑——這也是瀏覽器版
  一行都不用改的原因。
- 關閉視窗要先問過算繪端：只有它知道有沒有沒存的文件。主行程擋下第一次
  `close`，等頁面回話，同意了才真的關。
- 偵錯把手掛在 `window.__photograp`，不是 `window.photograp`——後者是橋接的
  名字，蓋掉就等於把原生功能全部弄壞。

`package.json` 宣告了 `"type": "module"`，所以 Electron 那邊的原始碼副檔名是
`.cts`，`tsc` 會輸出 `.cjs`；沙箱化的 preload 本來就必須是 CommonJS。

## 進階混合（core/blend-range.ts）

混合範圍在合成時判斷，不在圖層自己的算繪裡：它要看的是**下面已經疊好**
的像素，那只有 `compositeLayers()` 手上才有。`applyBlendIf()` 因此直接
削掉圖層那份暫存表面的 alpha，接著才交給 `blendSurface()`。

- 預設值（0/0 與 255/255）會在第一行就被擋掉，所以沒設定的圖層一個像素
  都不會被掃到。
- 下層完全透明的地方沒有顏色可比，會讓圖層原樣通過，而不是拿它跟黑色比；
  半透明的地方則按 alpha 在「照判斷」與「放行」之間插值。

填滿不透明度則在圖層內部處理。圖層裡側（像素、內陰影、內光暈、斜角、
覆蓋）先在自己的表面上用 `source-atop` 疊好——這是唯一不會讓半透明圖層
變厚的疊法——最後整塊以 `max(填滿, 效果強度)` 的透明度放到外側效果上面。
效果強度是每個圖層一個純量而不是逐像素，所以「填滿 0 + 不透明覆蓋」會
完全正確，而「填滿 0 + 半透明覆蓋」會落在兩者之間。

## 穿透群組（core/compositor.ts）

一般的群組會先把子圖層合成到自己的表面上，裡面的調整圖層因此碰不到
群組外的東西。穿透則反過來，把已經疊好的結果**當成背景傳進去**：
`compositeLayers(children, opt, acc)`。

- 回傳的結果本來就含著背景，所以它是**取代**下面那一層而不是疊上去：
  疊上去會讓半透明的背景跟自己再合成一次而變厚。群組的不透明度、遮色片
  與混合範圍合成一張權重圖，用它在「有套用」與「沒套用」之間做交叉淡化
  （`destination-out` 留下背景那一份、`destination-in` 取出結果那一份，
  再以 `lighter` 相加）。
- 被混合範圍擋下的地方權重是零，於是原本的背景原樣留著。
- 上面壓著剪裁圖層時仍然走孤立那條路：剪裁需要一個形狀可以貼，而穿透
  的結果裡分不出哪些像素是群組自己的。

## 段落文字（core/text.ts）

`wrapLines()` 一次處理一段：逐字加進去量寬度，超過框寬就退回最後一個
可斷點。可斷點由 `canBreakBetween()` 判定——空格後面可以斷，中日韓文字
之間也可以斷，但行首禁則（，。」）與行尾禁則（「（）會擋下來。

- 行尾的空格**不計入寬度**：讓它掛在框外，否則一個看不見的空格會把
  前面那個字推到下一行。
- 回傳的每一行都帶著 `endsParagraph`，齊行時靠它跳過段落的最後一行——
  那一行要是也被撐滿，整段看起來就會怪怪的。
- 版面仍然從表面原點排起，框的位置由 `layer.x/y` 決定，跟點文字一樣；
  把位置折進像素裡會讓下一次重繪把搬過的框彈回原處。

## 透視（core/perspective.ts）

畫布自己的變換是仿射的，接不住透視；這裡解一個 3x3 的投影矩陣：
八個未知數、八條方程式（四組對應點各貢獻 x 與 y 各一條），h22 固定為 1
以決定整體縮放，再以部分主元素的高斯消去法解。

- `warpQuad()` 走**逆變換**：從目的地的每一個像素反推回來源取樣，
  所以每個像素恰好填一次、不會留下破洞；取樣點取像素中心，否則結果會偏半個像素。
- `quadIsUsable()` 擋下複形（領結狀）的四邊形：它的單應在紙上有解，
  但會把影像折疊到自己身上，結果毫無意義。

## 混色筆刷（tools/paint.ts）

每畫一下的順序是「先沾、後放」：筆毛先把底下的平均顏色吃進來一部分，
再把手上的顏色按 `混合` 與剩餘顏料量放下去。

- 沾起來的比例最多只到一半（`wet * 0.5`）：全部換掉的話筆上就沒有
  「上一刻的顏色」可以抹，也就抹不出東西來。
- 真正讓顏色拖得遠的是**相鄰筆觸的重疊**：每一下取樣到的大多是前一下
  自己留下的顏料，只有邊緣那一小圈是新的畫布，所以顏色會沿著筆觸衰減
  而不是立刻消失。
- 平均值以 alpha 加權，否則透明像素會把顏色拉向黑色。「取樣全部圖層」
  時，圖層自己是空的地方改用合成結果，這樣才能在空圖層上推下層的顏色。

## 內容感知比例（filters/seam.ts）

接縫裁減（Avidan & Shamir）：能量圖取梯度強度，再以動態規劃找出累積
成本最低的一條上到下路徑，每列一個像素且相鄰兩列最多差一個像素。

- 完全透明的像素以 alpha 加權後才算亮度，否則剪裁過的圖層會因為邊緣的
  alpha 跳變而被當成高能量，接縫永遠繞開它。
- 横向裁減是把影像**轉置**後跑同一個垂向過程，不用再寫一份。
- 保護與移除遮罩會**跟著像素一起裁減**（`carveMask`）：只要遮罩不跟著變窄，
  第二條之後的接縫就會對不準，直接切穿本來要保護的區域。
- **插入接縫要先把全部接縫找齊再一次加進去**：一條一條加的話，剛插入的
  像素幾乎沒有能量，下一次搜尋會再挖同一個地方，結果是一條拖長的糊帶。
  實作是在一份會變窄的副本上找接縫，以索引表把位置映回原始欄位，最後一起插入。
- `carveVertical()` 先複製輸入，不會改到呼叫端的 ImageData；它一併回傳裁減過的
  遮罩，第二輪（高度）才拿得到對齊的保護區。
- `contentAwareScaleAsync()` 每幾條接縫讓出事件迴圈，全尺寸裁減才不會把頁面凍住。

## 調整選取邊緣

`core/refine.ts` 是純運算：輸入一張覆蓋率遵罩，依 `smooth → feather →
contrast → shift` 的順序回傳新的遵罩（與 Photoshop 的調整邊緣一致），
從不改到傳進來的陣列。

- **平滑**是模糊再以陡岭的曲線拉回來：模糊把輪廓磨圓，重映射把它拉回锐利，
  比硬閥值多留下約一個像素的抗鎖齒。
- **對比**是以 128 為中心的線性拉開，走 256 項 LUT。
- **移動邊緣**是可分離的灰階膨脹/侵蟎，O(n·r) 而不是 O(n·r²)。
- `refineMask()` 的 `scale` 參數讓預視用同一段程式：縮小的遵罩配上同比例
  縮小的半徑，覆蓋比例與全尺寸結果相近，避免在拉滑桿時跑全尺寸運算。

對話框（`ui/dialogs/refine.ts`）只負責預視與輸出：選取範圍、圖層遮色片或
剪成新圖層。

## 內側效果與斜角

- **內陰影**是形狀外面投進來的陰影：把畫布填滿、把形狀挖掉，讓這張
  「洞」投影，再以 `destination-in` 只留下落在形狀內的那一半。內光暈相同，
  只是不偏移且疊幾次。兩者都以 `source-atop` 畫上去，所以圖層的外接矩形不變。
- **斜角**先把輪廓的 alpha 模糊成高度圖，再以它的梯度做方向光照明。
  法線是**負的**梯度，而螢幕的 y 又向下為正，所以光源向量是 `(-cos, sin)`
  而不是直覺的 `(cos, -sin)`——兩個負號都要，少一個亮暗就整個反過來。

## 覆蓋效果與圖層樣式

`LayerEffects.overlay` 把顏色、漸層、圖樣三種覆蓋放在**同一個槽位**並以
`kind` 切換。Photoshop 把它們做成三個可疊加的效果，這裡以一個槽位涵蓋
相同的用途，介面只要一小部分。

- 覆蓋在 `drawContent()` 之後、套用遮色片之前畫，並以 `destination-in` 剪到
  圖層自己的輪廓，所以圖層外仍然是透明的。
- 效果自己帶著漸層的色標與圖樣的磁磚，而不是本機庫的 id：
  專案檔與存下來的樣式必須在沒有那個庫的電腦上也一樣；內建圖樣是程式碼，
  所以只存 id 就夠。
- 覆蓋以 `source-atop` 畫上去，不動目標的 alpha；否則半透明的圖層會因為
  開了覆蓋而變得更不透明。
- 漸層的長度是將圖層外接矩形**投影到指定角度**而不是取最長邊；
  放射狀、角度、菱形這三種把第一個點當成圓心，所以從圖層中心起算。
- 圖樣還沒解碼完成時**不畫**，而不是退回某個預設色：一幀空白比一幀錯色好。
- 渲染漸層需要 `renderGradient()`，而它原本在 `tools/draw.ts`。合成器在 core，
  不能反過來依賴 tools，所以漸層渲染搬到 `core/gradient-render.ts`，
  `tools/draw.ts` 再匯出一次讓原本的呼叫端不用改。

`core/styles.ts` 是整組 `LayerEffects` 的預設集，與筆刷、漸層、圖樣同一套
localStorage 作法；載入時合併到 `defaultEffects()` 上，舊樣式缺的欄位會補上。
專案檔的 `effects` 也以同樣的方式合併，因此新增效果不會讓舊檔案載不起來。

## 圖樣

`core/patterns.ts` 的內建圖樣是繪圖函式，需要時才畫成磁磚；使用者定義的
則以 PNG data URL 存在 localStorage。

- 解碼 data URL 是**非同步**的，而繪圖工具是同步的：`down()` 不能等 Promise，
  否則第一筆刷過去時磁磚還是空的，整筆就白畫了。因此 `createPattern()` 會直接
  把已經畫好的磁磚塞進快取，`warmPatterns()` 在啟動與定義後把儲存的圖樣預先
  解碼，工具則只用同步的 `cachedPatternSurface()`。
- `tileInto()` 的位移參數把磁磚相位錨定在**文件原點**而不是表面原點，
  圖層有位移時兩次填滿才接得起來。

## 漸層

`core/gradients.ts` 是漸層的註冊表：內建清單加上使用者存在 localStorage 的自訂漸層。

- `GradientStop` 多了選配的 `ref: 'fg' | 'bg'`。帶 `ref` 的色標在渲染前才由
  `resolveStops()` 換成目前的前景/背景色，所以「前景到背景」這種內建漸層
  能一直跟著顏色井走，而不是存下製作當下的顏色。
- `presetStops(id, fg, bg)` 是工具與預視的入口：查註冊表 → 排序 → 解析 ref。
- `GRADIENT_PRESETS` 是工具選單用的**同一個陣列物件**，`refreshGradientOptions()`
  就地重建內容，因此存完新漸層不用重新建立工具定義。
- 編輯器（`ui/dialogs/gradient.ts`）把不透明度與顏色當成**同一個色標的兩面**，
  所以上下兩列控點共用一個 `pos`；這比 Photoshop 的兩條獨立軌道簡單，
  代價是不能讓不透明度與顏色在不同位置轉折。

## 對齊與分佈

`alignDelta()` 與 `distributeDeltas()` 是純函式，只算位移；實際搬動交給
`moveLayerBy()`，它知道群組要遞迴、形狀圖層要重畫（把位移折進控制點）。
`moveBlockReason()` 負責擋下鎖定圖層與沿路徑的文字（後者的位置來自曲線）。
分佈時會排除內容填滿整張畫布的圖層：底圖沒有可分佈的位置，把它算進去
會讓可用間距變負值、把其他圖層疊成一堆。

## 步驟記錄快照與步驟記錄筆刷

`History` 除了滾動的 `snapshots` 之外，另外持有 `named`（使用者命名的快照）
與 `source`（步驟記錄筆刷要取樣的狀態）。

- `source` 持有的是 `HistorySnapshot` 物件本身而不是索引，滾動緩衝區丟掉舊步驟
  時指標才不會默默指到別人。沒指定時 `sourceSnapshot()` 回傳最舊的一步。
- 快照的像素跟一般步驟一樣是**寫入時複製**共用的，所以存一張快照只花掉
  圖層紀錄的記憶體，不是一份影像副本。
- `PhotoDoc.historySource(layer)` 把來源狀態裡同 `id` 的圖層找出來，順便回傳
  兩者的 `x/y` 差，因為圖層可能在那之後被移動過；尺寸不同或找不到圖層時
  回傳 `null`，`historySourceReason()` 負責把原因講給使用者聽。
- 筆刷本身就是以 `DirectStroke` 實作的仿製印章，只是來源換成那張歷史表面、
  取樣位置不偏移。

## 圖層構成

`core/comps.ts` 的圖層構成記的是**文件看起來的樣子**，不是它的內容：
每個圖層的可見度、位置、不透明度、混合模式與圖層樣式。像素完全不碰，
所以一個構成只花掉幾個數字的記憶體。

- 套用時以圖層 id 對應。構成之後新增的圖層**不會被藏起來**，已經刪掉的
  就只是沒東西可還原；兩者都會在狀態列說清楚，而不是裝作一切正常。
- `comps` 跟 `guides`、`channels` 一樣進入 `HistorySnapshot`，所以建立、更新與
  刪除都能還原；`activeCompId` 只是面板的游標，不列入快取。
- 從專案檔讀回來的構成走 `normalizeComp()`：效果合併到 `defaultEffects()` 上，
  沒有 id 的項目直接丟掉（它永遠對不到任何圖層）。

## 面板

- 面板收起時靠 `.panel.collapsed .panel-body { display: none }` 隱藏內容，
  所以面板本體不要用**行內樣式**設 `display`，否則收起後仍然佔著高度。
- **色階分佈圖**（`ui/panels/histogram.ts`）：`computeHistogram()` 算出 256 格統計，
  `statsFor()` 再從直方圖直接算平均值、標準差與中間值（不再跑一次像素）。
  結果以 `doc.revision` 加來源做快取，面板收起時 `refresh()` 直接返回，
  所以不會在每一筆筆刷中重算全圖。
- **圖層搜尋與篩選**（`ui/panels/layers.ts`）：`layerMatchesFilter()` 是純函式，
  本層不命中時會遞迴看子圖層，因此群組會因為裡面的圖層命中而一併保留。

## 路徑與筆型工具

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
版本 4 加上 `guides` 與 `guidesLocked`；
版本 5 加上形狀圖層的 `shape`（路徑幾何與樣式，載入後重新描繪）。
載入後會重新渲染智慧型物件的快取。格式演進時請提高 `version`
並在 `io/files.ts` 的 `loadProject()` 內做向下相容處理。

## 測試

`tests/suite.ts` 是在瀏覽器執行的測試（影像運算需要真正的 Canvas）。
新增功能時請一併補上對應測試，並確認 <http://localhost:5180/tests/index.html> 全數通過。
