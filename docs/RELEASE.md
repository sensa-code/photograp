# 發布與維運手冊

Photograp 有兩種發布形態：網頁版（GitHub Pages）與桌面版（Electron，放在 GitHub Releases）。
這份手冊寫的是每一種怎麼發、怎麼驗證、出問題怎麼回滾，以及還沒做的事。
程式架構見 [architecture.md](architecture.md)。

## 網頁版（GitHub Pages）

- 網址：<https://sensa-code.github.io/photograp/>
- 部署方式：合併到 `main` 就會觸發 `.github/workflows/pages.yml`（`on: push` 到 `main`，也可以
  在 Actions 頁手動 `workflow_dispatch`）。它跑 `npm ci` → `npm run build`，把 `dist/` 上傳成 Pages
  artifact 再部署；`tests/` 的測試頁不在裡面。Pages 的來源已在 repo 設定選成 GitHub Actions，
  `vite.config.ts` 的 `base: './'` 讓靜態檔在 `/photograp/` 子路徑下也能載入。
- 併發設定 `concurrency: pages`、`cancel-in-progress: false`：連續兩次合併會排隊照順序部署，
  不會互相取消，最後上線的一定是最新的 `main`。

### 怎麼驗證

1. 到 <https://github.com/sensa-code/photograp/actions/workflows/pages.yml>，確認最新一筆 run 的
   `build` 與 `deploy` 兩個 job 都綠；`deploy` job 的 environment `github-pages` 會顯示部署網址。
2. 用無痕視窗打開 <https://sensa-code.github.io/photograp/>（Pages 的快取偶爾會讓一般視窗多看一陣子舊版），
   確認工作區載入、可以新增文件、畫一筆、開啟「說明 › 鍵盤快速鍵」。
3. 開 DevTools 的 Console，確認沒有紅字；有 CSP 相關錯誤時，看 `index.html` 的
   Content Security Policy 與 [architecture.md](architecture.md) 的「頁面安全」一節。

### 怎麼回滾

Pages 沒有「回到上一版」的按鈕，回滾就是讓 `main` 回到好的狀態再部署一次：

```bash
git revert <壞掉的 merge commit> -m 1
```

開 PR、CI 綠了合併；合併會再觸發一次 `pages.yml`。驗證方式同上。
急到不能等 CI 時也不要 force push：分支保護的設定見下面「CI 與分支保護」。

## 桌面版（Electron，GitHub Releases）

- 下載頁：<https://github.com/sensa-code/photograp/releases>
- 版本號在 `package.json` 的 `version`（目前 `1.0.0`）。electron-builder 用它命名產出
  （例如 `Photograp Setup 1.0.0.exe`、`Photograp 1.0.0.exe`），Release 的 tag 也照它取 `vX.Y.Z`。
  出新版先改這個欄位，連同「說明 › 關於 Photograp」對話框裡寫死的「版本 1.0.0」字串
  （`src/ui/dialogs/document.ts` 的 `aboutDialog`，目前沒有從 `package.json` 讀）一起改，合併進 `main`，再從 `main` 打包。

### 前置：先停掉開發伺服器

打包前把 `npm run dev` 與 `npm run dev:desktop` 都停掉。electron-builder 會建立並改名
`release/` 底下的目錄，而 Vite 的檔案監看器看著整個專案目錄（包含 `release/`）；
Windows 不允許改名有開啟控制代碼的目錄，開著 dev server 打包會在改名那一步失敗。

### 打包

在 repo 根目錄（Windows）：

```bash
npm run dist:win
```

這會依序跑 `npm run build`（`tsc --noEmit` + `vite build` 產生 `dist/`）、`tsc -p electron`
（產生 `dist-electron/`），再由 electron-builder 做出 NSIS 安裝檔與免安裝版（都是 x64）。
產出在 `release/`：

- `Photograp Setup <版本>.exe`：安裝檔（可選安裝目錄、建桌面與開始功能表捷徑、關聯 `.pgraph`）
- `Photograp <版本>.exe`：免安裝版（portable）
- `latest.yml`、`*.blockmap`：electron-builder 的附屬檔，目前沒有自動更新所以用不到，不必上傳

`release/` 與 `dist-electron/` 都在 `.gitignore`，不會進 git。`npm run dist` 會依目前作業系統打包：
macOS 的 `.dmg` 要在 macOS 上建、Linux 的 AppImage 要在 Linux 上建（見「還沒做的事」）。

### 建 GitHub Release

需要 `gh` CLI 且已登入 `sensa-code`。在 repo 根目錄：

```bash
gh release create v1.0.0 release/*.exe --repo sensa-code/photograp --title "Photograp 1.0.0" --notes "第一個公開版本。Windows x64 安裝檔與免安裝版；沒有程式碼簽章，SmartScreen 會跳未知的發行者警告。"
```

- tag 不存在時 `gh` 會從 `main` 的最新 commit 建 tag；要指定 commit 加 `--target <sha>`。
- 要先給人試用再公開，加 `--draft`，確認後在 Release 頁按 Publish。
- 補傳或換檔用 `gh release upload v1.0.0 release/*.exe --clobber`。

### 沒簽章時 SmartScreen 的說明

安裝檔與免安裝版目前**沒有程式碼簽章**。Windows 第一次執行會跳「Windows 已保護您的電腦 / 未知的發行者」，
使用者要按「其他資訊 → 仍要執行」。這個警告跟檔案有沒有問題無關，純粹是沒有簽章加上下載次數少；
README 與 Release notes 都要寫明，不然會被當成病毒。要消掉它得買憑證簽章（見「還沒做的事」）。

### 怎麼驗證

1. 本機：打包完成後，`release/` 裡有上面列的兩個 `.exe`，大小合理（數十到一百多 MB，不是幾 KB）。
2. 在另一台沒裝過的 Windows 機器（或乾淨的使用者帳號）跑安裝檔：接受 SmartScreen 之後，
   能安裝、開啟、新增文件、存成 `.pgraph`、關掉後雙擊那個 `.pgraph` 會用 Photograp 打開；
   再開一次程式，應該回到上次的視窗大小與位置。
3. 免安裝版直接雙擊，能開到工作區即可。
4. Release 頁：<https://github.com/sensa-code/photograp/releases> 上看得到該版本、兩個 `.exe` 都在
   Assets 裡，用 `gh release view v1.0.0 --repo sensa-code/photograp` 也能列出。

### 怎麼回滾

- Release 本身：壞掉的版本在 Release 頁改成 Pre-release 或 `gh release delete v1.0.0 --cleanup-tag`
  （會連 tag 一起刪）；已經下載的人不會被收回，所以要在 Release notes 或新版本裡說明。
- 程式碼：跟網頁版一樣用 `git revert`，改版本號後重新打包、重新發。
- 桌面版沒有自動更新，使用者不會被推到壞版本；回滾的急迫性比網頁版低。

## CI 與分支保護

- `.github/workflows/ci.yml` 在每個 PR 與 `main` 的 push 跑一個 job：`npm ci` → `npm run typecheck` →
  `npm test`（Linux 上要 `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a`，原因寫在 workflow 的註解裡）→
  `npm run build`。檢查名稱固定是 **`ci / quality`**，這是 `main` 的必要檢查；改了名稱 PR 會永遠等不到綠燈。
- repo 在 2026-10 改成公開之後不能再呼叫工作室共用模板（公開 repo 呼叫不到私有 repo 的 reusable workflow），
  所以步驟是展開寫在 `ci.yml` 裡的；ci-shared 的 `node-quality.yml@v1` 有改動時要手動對照更新。
- 必要檢查、分支保護與 auto-merge 設定**由 `sensa-code/ci-shared` 的 `policy/repos.json` 管理**
  （`photograp` 那一筆：`branch: main`、`requiredChecks: ["ci / quality"]`、`allow_auto_merge: true`、
  不要求 review）。要改這些設定，先經 PR 改清單、合併後用清單的套用腳本套用，**不要直接在 GitHub 的
  Settings 改**：每天的比對會把手動改的報成漂移（ci-shared 裡 `ci-policy-drift` 標籤的 issue）。
  程序見 skill `ci-shared` 與 ci-shared 的 README。

### 怎麼驗證

- 任一支 PR 的 Checks 分頁有 `ci / quality`，而且合併按鈕在它綠之前是鎖住的。
- `gh api repos/sensa-code/photograp/branches/main/protection --jq '.required_status_checks.contexts'`
  應該只列出 `ci / quality`。
- 本機要先跑一遍 CI 同樣的三步：`npm run typecheck`、`npm test`、`npm run build`。

## 還沒做的事

每一條都寫了做完之後怎麼驗證，接手時照著驗。

1. **程式碼簽章**：安裝檔沒簽，SmartScreen 會擋。要買 OV 或 EV 憑證，在 `package.json` 的 `build.win`
   設 `certificateSubjectName` 或 `signtoolOptions`，憑證與密碼走環境變數，不進 repo。
   驗證：`signtool verify /pa "release/Photograp Setup <版本>.exe"` 通過；乾淨的 Windows 上第一次執行不跳
   「未知的發行者」（EV 憑證立即生效，OV 憑證要累積下載量 SmartScreen 才會放行）。
2. **自動更新**：目前沒有。計畫用 `electron-updater` 搭配 GitHub Releases 當更新來源（electron-builder
   已經會產 `latest.yml` 與 blockmap，發 Release 時一併上傳即可），主程序在啟動後 `checkForUpdatesAndNotify`。
   自動更新要求安裝檔有簽章，所以排在第 1 項之後。
   驗證：裝舊版，發一個版本號較大的 Release，開啟舊版後應該提示更新、下載、重啟後 `關於` 顯示新版本。
3. **逐像素路徑搬到 Worker**：混合模式裡 Canvas 不原生支援的那幾種、濾鏡與內容感知運算都在主執行緒跑，
   大圖會卡住 UI（自動儲存放慢的機制也是在補這個洞）。計畫把 `filters/` 的純函式與 `core/blend.ts`
   的逐像素分支搬到 Web Worker，用 `ImageData` 的 buffer 做 transfer。
   驗證：開一張接近 4,000 萬像素上限的影像套高斯模糊時，主執行緒不凍結（DevTools Performance 沒有長任務）、
   `npm test` 仍 395 項全過、`npm run build` 的 Worker 進入點在 Pages 的子路徑下載得到。
4. **macOS／Linux 建置從未跑過**：`package.json` 的 `build.mac`（dmg、zip）與 `build.linux`（AppImage）
   設定在，但沒有在那兩個平台上執行過 `npm run dist`，圖示轉檔、檔案關聯與啟動都沒驗過。
   驗證：在 macOS 跑 `npm run dist` 得到 `.dmg`，安裝後能開啟並雙擊 `.pgraph`；在 Linux 跑得到 `.AppImage`，
   `chmod +x` 後能開啟。兩者都過了再把 Release 的 Assets 補上，README 的桌面版一節同步改。
5. **photograp 尚未納入派工中樞**：aiplatform 的 workhub 裡還沒有 photograp 的項目，所以這個 repo 的 PR
   本文第一行目前寫 `Work: 待補建`，對照器不會把合併、部署標成已上線。要由值班指揮官用 `workhub_item`
   建立（建議編號前綴 `pg.`），之後的 PR 照全域規則寫 `Work: <編號>`、分支用 `work/<編號>-<簡述>`。
   驗證：`workhub_overview` 看得到 photograp；開一支寫了 `Work:` 行的 PR，合併後在中樞的進度頁被標成已合併。
