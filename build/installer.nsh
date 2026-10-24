; Photograp 的 NSIS 自訂腳本（package.json 的 build.nsis.include 指向這個檔）。
;
; 移除時清掉 .pgraph 的檔案關聯。
; electron-builder 26.18 內建的 unregisterFileAssociations（APP_UNASSOCIATE 巨集）只刪
; ProgID 機碼「Software\Classes\Photograp Project」與 .pgraph\OpenWithProgids 裡的值，
; 不刪「Software\Classes\.pgraph」本身：它的預設值仍是「Photograp Project」，
; 移除後雙擊 .pgraph 會指向已經不存在的程式。這裡補上那一段。
;
; customUnInstall 在 uninstaller.nsh 的移除 Section 一開始執行，這時 un.onInit 已經跑過
; initMultiUser，SetShellVarContext 已依安裝模式設好：預設的使用者層級安裝是 current，
; SHCTX 指向 HKCU；安裝模式頁選了所有使用者時是 all，指向 HKLM。跟安裝時 APP_ASSOCIATE
; 寫入用的 SHELL_CONTEXT 是同一個根機碼（SHELL_CONTEXT 是 SHCTX 的別名）。

!define PHOTOGRAP_ASSOC_EXT_KEY "Software\Classes\.pgraph"
; ProgID 等於 package.json fileAssociations 的 name（APP_ASSOCIATE 的 FILECLASS 參數）。
!define PHOTOGRAP_ASSOC_PROGID "Photograp Project"

!macro customUnInstall
  ; 更新時跳過：electron-updater 安裝新版前會帶 --updated 執行舊版的移除程式，
  ; 再由新版安裝程式重新寫入關聯。這時刪掉 .pgraph 機碼，會在更新途中短暫拿掉關聯；
  ; 只有使用者真的移除 Photograp 時才清。
  ${ifNot} ${isUpdated}
    Push $0
    ReadRegStr $0 SHCTX "${PHOTOGRAP_ASSOC_EXT_KEY}" ""
    ; 只有預設值還是我們的 ProgID 才刪整個 .pgraph 機碼：裝了 Photograp 之後，
    ; 若有別的程式把 .pgraph 登記成自己的（預設值改成它的 ProgID），那是別人的關聯，
    ; 移除 Photograp 不能把它一起刪掉。
    ${if} $0 == "${PHOTOGRAP_ASSOC_PROGID}"
      DeleteRegKey SHCTX "${PHOTOGRAP_ASSOC_EXT_KEY}"
    ${endIf}
    ; ProgID 機碼是 Photograp 自己的，不論 .pgraph 指向誰都刪（不存在時 DeleteRegKey 什麼也不做）。
    DeleteRegKey SHCTX "Software\Classes\${PHOTOGRAP_ASSOC_PROGID}"
    ClearErrors
    Pop $0
    ; SHCNE_ASSOCCHANGED：通知檔案總管關聯已變，圖示與「開啟檔案」的對應立即更新。
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
