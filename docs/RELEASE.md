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
- 版本號只有一個來源：`package.json` 的 `version`（目前 `1.1.2`）。electron-builder 用它命名產出
  （例如 `Photograp-Setup-1.1.0.exe`、`Photograp 1.1.0.exe`），Release 的 tag 也照它取 `vX.Y.Z`；
  「說明 › 關於 Photograp」顯示的版本由 `vite.config.ts` 的 `define` 在建置時注入（`__APP_VERSION__`），不用另外改。
  出新版只改這個欄位，合併進 `main`，再從 `main` 打包。

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

- `Photograp-Setup-<版本>.exe`：安裝檔（可選安裝目錄、建桌面與開始功能表捷徑、關聯 `.pgraph`）。
  檔名用連字號（`build.nsis.artifactName`）是刻意的：GitHub 會把上傳檔名裡的空白換成句點
  （1.0.0 的安裝檔在 Release 上就叫 `Photograp.Setup.1.0.0.exe`），而 `latest.yml` 寫的是連字號的檔名，
  檔名有空白的話自動更新會下載到 404
- `Photograp-Setup-<版本>.exe.blockmap`：差異下載用，下一版的更新程式會拿它跟新版比對，只下載變動的區塊
- `latest.yml`：自動更新的版本資訊（版本號、安裝檔名、sha512），**一定要上傳**，見下面「自動更新」
- `Photograp <版本>.exe`：免安裝版（portable）

`release/` 與 `dist-electron/` 都在 `.gitignore`，不會進 git。`npm run dist` 會依目前作業系統打包：
macOS 的 `.dmg` 要在 macOS 上建、Linux 的 AppImage 要在 Linux 上建（見「還沒做的事」）。

### 建 GitHub Release

需要 `gh` CLI 且已登入 `sensa-code`。在 repo 根目錄：

```bash
gh release create v1.1.0 release/Photograp-Setup-1.1.0.exe release/Photograp-Setup-1.1.0.exe.blockmap release/latest.yml "release/Photograp 1.1.0.exe" --repo sensa-code/photograp --title "Photograp 1.1.0" --notes "加入自動更新（安裝版）。Windows x64 安裝檔與免安裝版；沒有程式碼簽章，SmartScreen 會跳未知的發行者警告。1.0.0 沒有更新程式，要手動下載這一版安裝一次。"
```

- 安裝檔、`.blockmap`、`latest.yml` 三個檔一個都不能少，原因見下面「自動更新」。
- 檔名寫死本次版本，**不要用 `release/*.exe`**：`dist:win` 不會清空 `release/`，同一個工作目錄打包過舊版的話，
  舊的 `.exe` 還在裡面，萬用字元會把新舊版本一起傳上去。打包前 `Remove-Item -Recurse release` 也可以。
- tag 不存在時 `gh` 會從 `main` 的最新 commit 建 tag；要指定 commit 加 `--target <sha>`。
- 要先給人試用再公開，加 `--draft`，確認後在 Release 頁按 Publish。
- 發布後約兩分鐘內，GitHub 的 CDN 可能還回報舊的最新版本；檢查更新若說讀不到最新版本資訊，等幾分鐘再試。
- 補傳或換檔用 `gh release upload v1.1.0 release/Photograp-Setup-1.1.0.exe release/Photograp-Setup-1.1.0.exe.blockmap release/latest.yml --repo sensa-code/photograp --clobber`。
  換了安裝檔就要連 `latest.yml` 一起換：裡面的 sha512 對不上時，更新程式會拒絕安裝。

### 自動更新

安裝版用 [electron-updater](https://www.electron.build/auto-update) 從 GitHub Releases 更新
（`package.json` 的 `build.publish`，打包時寫進安裝目錄的 `resources/app-update.yml`）。程式在 `electron/updater.cts`。

- **怎麼運作**：啟動約 10 秒後在背景檢查一次最新的正式 Release（不含 draft 與 pre-release）的 `latest.yml`，
  版本比自己新就自動下載安裝檔並比對 sha512。下載完成跳原生對話框「Photograp X.Y.Z 已下載完成，重新啟動後安裝。」：
  - 「立即重新啟動」先走跟按視窗 X 一樣的關窗確認：有未存的文件會先問，使用者取消就不更新、視窗留著；
    確認後才以靜默模式執行安裝檔，裝完自動重新開啟程式。順序不能反過來：`quitAndInstall` 會先啟動安裝檔再結束程式，
    先裝再問的話，使用者取消後安裝檔會卡在等一個關不掉的視窗。
  - 「稍後」或在未存確認時取消：下載好的檔案留在 `%LOCALAPPDATA%\photograp-updater`，**關閉程式時不會自動安裝**
    （`autoInstallOnAppQuit = false`）；下次啟動檢查時會直接用快取的檔案再問一次。
  - 「說明 › 檢查更新…」可以手動檢查，結果用畫面上的提示顯示；已經下載好的話會再跳一次重新啟動的對話框。
    失敗時只顯示一句中文（連不上、GitHub 限流、讀不到最新版本資訊、其他），分類在 `electron/update-errors.cts`，原始錯誤寫進 log。
- **一定要上傳 `latest.yml`**：更新程式只看最新 Release 的 `latest.yml`，少了它就不會有任何人收到更新
  （背景檢查失敗只寫 log，不會打擾使用者）。`.blockmap` 少了只是退回完整下載，但下一版的差異下載會用到這一版的 blockmap，所以也要傳。
- **1.0.0 不會自動更新**：那一版沒有更新程式，1.0.0 的使用者要手動下載安裝一次 1.1.0，之後的版本才會自動更新。
- **免安裝版不支援**：沒有安裝程式可以執行，`PORTABLE_EXECUTABLE_DIR` 有值時更新程式整個關掉，
  手動檢查會說明要到 Releases 頁下載。開發模式（`npm start`、`npm run dev:desktop`）也一樣不檢查。
- **沒有簽章也能更新**：`app-update.yml` 沒有 `publisherName`，更新程式只比對 sha512、不驗簽章。
  之後加上程式碼簽章時，electron-builder 會把簽章者寫進 `publisherName`，從那一版起更新檔必須用同一張憑證簽。
- **log**：`%APPDATA%\Photograp\logs\updater.log`（超過 1 MB 會換成 `updater.log.old`）。使用者回報收不到更新時先看這個檔。
- **緊急停止更新**：發出去的版本有問題、要讓還沒更新的人停下來，把那一版 Release 的 `latest.yml` 刪掉，
  或把整個 Release 改回 draft（兩種擇一）：

  ```bash
  gh release delete-asset v1.1.0 latest.yml --repo sensa-code/photograp --yes
  ```

  ```bash
  gh release edit v1.1.0 --draft --repo sensa-code/photograp
  ```

  刪掉 `latest.yml` 後檢查會失敗（只寫 log），沒有人會再下載；改成 draft 則「最新 Release」變回前一版，
  前一版的版本號不比使用者手上的新，所以不會降版，只是停止推送。
  已經下載但還沒按重新啟動的人仍會被提示（檔案已經在他們電腦上）；要修正就盡快發下一個修正版。
- **測試用的掛鉤**：環境變數 `PHOTOGRAP_UPDATE_URL` 有值時，更新來源改成那個網址（generic provider，放 `latest.yml` 與安裝檔的資料夾），
  用來在本機驗證下載流程，不必真的發 Release。只在明確設定時生效。

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
4. Release 頁：<https://github.com/sensa-code/photograp/releases> 上看得到該版本，Assets 裡有安裝檔、`.blockmap`、
   `latest.yml` 與免安裝版，用 `gh release view v1.1.0 --repo sensa-code/photograp` 也能列出；
   `curl -sL https://github.com/sensa-code/photograp/releases/latest/download/latest.yml` 要印出新的版本號。
5. 自動更新：裝著上一版（1.1.0 以後）的電腦開啟程式，約 10 秒後應該跳出「已下載完成」的對話框；
   沒跳就看 `%APPDATA%\Photograp\logs\updater.log`。

### 怎麼在工作站上驗證安裝與更新

用命令列安裝、移除，不必點安裝精靈。以下在 repo 根目錄的 PowerShell 執行，`X.Y.Z` 換成要驗的版本。

- 靜默安裝（使用者層級，裝到 `%LOCALAPPDATA%\Programs\Photograp`）：

  ```powershell
  .\release\Photograp-Setup-X.Y.Z.exe /S
  ```

- 靜默移除（cmd 的寫法是 `"%LOCALAPPDATA%\Programs\Photograp\Uninstall Photograp.exe" /S /currentuser`）：

  ```powershell
  & "$env:LOCALAPPDATA\Programs\Photograp\Uninstall Photograp.exe" /S /currentuser
  ```

- 更新日誌在 `%APPDATA%\Photograp\logs\updater.log`，看最後幾行：

  ```powershell
  Get-Content "$env:APPDATA\Photograp\logs\updater.log" -Tail 30
  ```

- **在有 Claude 桌面版的工作站上，啟動程式與看日誌都要用 PowerShell**：Claude 桌面版是 MSIX 套件，
  從 Claude 的 Bash 啟動的程式寫進 AppData 的新檔案，會被轉到 Claude 的私有資料夾
  （`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache`），只有 Claude 裡看得到。
  用 Bash 啟動、再用一般視窗看日誌（或反過來），會看到兩份內容不同的 `updater.log`，以為更新沒跑。
  Claude 的 PowerShell 工具用的 PowerShell 7 不會被轉向。
- 剛發布的版本：發布後約兩分鐘內 GitHub 的 CDN 可能還回舊的 `latest.yml`，這段時間檢查更新會說已是最新，等幾分鐘再試。

**實測紀錄（2026-10-24，K95）**：安裝 1.1.0 後啟動，約 10 秒後找到 1.1.1；差異下載只抓了 927 KB
（完整安裝檔 118 MB）；跳出原生對話框「Photograp 1.1.1 已下載完成，重新啟動後安裝。」，按「立即重新啟動」後
12 秒內換成 1.1.1，約 19 秒後程式自己以 `--updated` 重新開啟；重開 10 秒後的背景檢查回報 1.1.1 已是最新。
接著用上面的指令移除，程式、捷徑與安裝資料夾都清乾淨，但 `.pgraph` 的關聯機碼留著（見下面「移除」，1.1.2 修正）。

### 移除

從 Windows 的「設定 › 應用程式」移除，或用上面的靜默移除指令。移除程式會刪掉安裝資料夾、桌面與開始功能表捷徑；
使用者資料夾 `%APPDATA%\Photograp`（例如更新日誌）不會刪。

- **`.pgraph` 關聯（1.1.2 起）**：移除程式（`build/installer.nsh` 的 `customUnInstall`）在
  `HKEY_CURRENT_USER\Software\Classes` 底下做這幾件事，再通知檔案總管關聯已變；安裝時在安裝模式頁選了所有使用者的話，
  改在 `HKEY_LOCAL_MACHINE\Software\Classes`，移除程式會跟著安裝模式清對的位置：
  1. `.pgraph` 的預設值是 `Photograp Project` 才刪這個預設值。不是的話代表裝了 Photograp 之後有別的程式把 `.pgraph`
     登記成自己的，不動。
  2. 刪 `.pgraph\OpenWithProgids` 裡 `Photograp Project` 這個值。
  3. `.pgraph\OpenWithProgids` 與 `.pgraph` 這兩個機碼**真的空了**（沒有子機碼、也沒有任何值）才刪。
     不整個刪 `.pgraph`，是因為別的程式可能在底下登記了自己的 `OpenWithProgids` 值、`ShellEx` 子機碼或其他值。
  4. 刪 ProgID 機碼 `Photograp Project`（這是 Photograp 自己的）。

  自動更新時整段跳過：electron-updater 會帶 `--updated` 執行舊版的移除程式，再由新版安裝程式重新登記關聯，
  這時清掉會在更新途中短暫拿掉關聯。
- **1.1.1 以前的版本移除後的殘留**：electron-builder 內建的移除邏輯只刪 ProgID 與 `OpenWithProgids` 裡的值，
  `.pgraph` 機碼本身（預設值 `Photograp Project`，底下一個空的 `OpenWithProgids`）會留著，雙擊 `.pgraph`
  會指向不存在的程式。手動清的做法跟 1.1.2 的移除程式一樣保守，先列出底下所有內容：

  ```powershell
  reg query "HKCU\Software\Classes\.pgraph" /s
  ```

  **只有 `(預設值)` 是 `Photograp Project` 時**才刪這個預設值；是別的值代表已經有其他程式登記了 `.pgraph`，整段都不要做：

  ```powershell
  reg delete "HKCU\Software\Classes\.pgraph" /ve /f
  ```

  刪完再跑一次上面的 `reg query ... /s`。**除了 `.pgraph` 與底下的 `OpenWithProgids` 兩個空機碼以外，沒有任何別的值或子機碼時**，
  才把空機碼刪掉；看到別的東西就停在這裡（預設值已經刪了，雙擊 `.pgraph` 不會再指向不存在的程式）：

  ```powershell
  reg delete "HKCU\Software\Classes\.pgraph" /f
  ```

### 怎麼回滾

- Release 本身：壞掉的版本在 Release 頁改成 Pre-release 或 `gh release delete vX.Y.Z --cleanup-tag`
  （會連 tag 一起刪）；已經下載的人不會被收回，所以要在 Release notes 或新版本裡說明。
- 程式碼：跟網頁版一樣用 `git revert`，改版本號後重新打包、重新發。
- 自動更新：先照上面「緊急停止更新」把壞版本的 `latest.yml` 拿掉，再發一個版本號更大的修正版
  （electron-updater 不會降版，所以「回滾」就是往前發一版、內容是舊程式碼的新版本）。

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

1. **程式碼簽章**：安裝檔沒簽，SmartScreen 會擋。要買 OV 或 EV 憑證，在 `package.json` 設
   `build.win.signtoolOptions.certificateSubjectName`（或 `certificateFile`）；目前的 electron-builder 26.18
   只認 `signtoolOptions` 底下的欄位，直接放在 `build.win` 會在設定驗證階段被拒絕。憑證與密碼走環境變數，不進 repo。
   驗證：`signtool verify /pa "release/Photograp Setup <版本>.exe"` 通過；乾淨的 Windows 上第一次執行不跳
   「未知的發行者」（EV 憑證立即生效，OV 憑證要累積下載量 SmartScreen 才會放行）。
2. **自動更新的安裝那一步：已實機驗證（2026-10-24，K95）**。從 1.1.0 自動更新到正式 Release 1.1.1：
   約 10 秒後找到新版、差異下載 927 KB（完整 118 MB）、對話框按「立即重新啟動」後 12 秒內換成 1.1.1、
   約 19 秒後以 `--updated` 自己重開、重開 10 秒後的檢查回報已是最新。紀錄與指令見上面「怎麼在工作站上驗證安裝與更新」。
   這次沒走到的只剩一條路徑：開著未存的文件時按「立即重新啟動」，應該先問未存變更，取消時不安裝、視窗留著。
   驗證：裝著上一版時開一個未存的文件，等提示後按「立即重新啟動」並在未存確認時取消，確認視窗留著、版本沒變；
   再按一次並確認後照常更新。
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
