; Photograp 的 NSIS 自訂腳本（package.json 的 build.nsis.include 指向這個檔）。
;
; 移除時清掉 .pgraph 的檔案關聯。
; electron-builder 26.18 內建的 unregisterFileAssociations（APP_UNASSOCIATE 巨集）只刪
; ProgID 機碼「Software\Classes\Photograp Project」與 .pgraph\OpenWithProgids 裡的值，
; 不動「Software\Classes\.pgraph」本身：它的預設值仍是「Photograp Project」，
; 移除後雙擊 .pgraph 會指向已經不存在的程式。這裡補上那一段。
;
; customUnInstall 在 uninstaller.nsh 的移除 Section 一開始執行，這時 un.onInit 已經跑過
; initMultiUser，SetShellVarContext 已依安裝模式設好：預設的使用者層級安裝是 current，
; SHCTX 指向 HKCU；安裝模式頁選了所有使用者時是 all，指向 HKLM。跟安裝時 APP_ASSOCIATE
; 寫入用的 SHELL_CONTEXT 是同一個根機碼（SHELL_CONTEXT 是 SHCTX 的別名）。
;
; 不整個刪掉 .pgraph 機碼：別的程式可能在 .pgraph 底下登記了東西（OpenWithProgids 裡
; 它自己的 ProgID、ShellEx 之類的子機碼、Content Type 之類的值），整個刪會把它們一起刪掉。
; 所以只刪 Photograp 自己寫的值，機碼要真的空了才刪。

!define PHOTOGRAP_ASSOC_EXT_KEY "Software\Classes\.pgraph"
; ProgID 等於 package.json fileAssociations 的 name（APP_ASSOCIATE 的 FILECLASS 參數）。
!define PHOTOGRAP_ASSOC_PROGID "Photograp Project"

; 機碼底下沒有子機碼、也沒有任何值時才刪。
; electron-builder 用的 NSIS 3.04 的 DeleteRegKey /ifempty 只檢查子機碼（exec.c 的
; DeleteRegTree 只看 DRTF_ONLYIFNOSUBKEYS），值會跟著機碼一起被刪，所以值要自己先查：
; EnumRegValue 在沒有任何值（或機碼不存在）時會設錯誤旗標；有值時即使只有預設值
; （名稱是空字串）也不會設，所以看錯誤旗標而不是看回傳的名稱。
!macro PHOTOGRAP_DELETE_KEY_IF_EMPTY KEY
  EnumRegKey $1 SHCTX "${KEY}" 0
  ${if} $1 == ""
    ClearErrors
    EnumRegValue $1 SHCTX "${KEY}" 0
    ${if} ${Errors}
      DeleteRegKey /ifempty SHCTX "${KEY}"
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ; 更新時跳過：electron-updater 安裝新版前會帶 --updated 執行舊版的移除程式，
  ; 再由新版安裝程式重新寫入關聯。這時清掉會在更新途中短暫拿掉關聯；
  ; 只有使用者真的移除 Photograp 時才清。
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    ; 預設值還是我們的 ProgID 才刪預設值：裝了 Photograp 之後若有別的程式把 .pgraph
    ; 登記成自己的（預設值改成它的 ProgID），那是別人的關聯，不能動。
    ReadRegStr $0 SHCTX "${PHOTOGRAP_ASSOC_EXT_KEY}" ""
    ${if} $0 == "${PHOTOGRAP_ASSOC_PROGID}"
      DeleteRegValue SHCTX "${PHOTOGRAP_ASSOC_EXT_KEY}" ""
    ${endIf}
    ; 內建的 APP_UNASSOCIATE 也會刪這個值，但它在 customUnInstall 之後才執行
    ; （uninstaller.nsh 的 Section "un.Uninstall"），這裡不先刪的話 OpenWithProgids 不會是空的。
    DeleteRegValue SHCTX "${PHOTOGRAP_ASSOC_EXT_KEY}\OpenWithProgids" "${PHOTOGRAP_ASSOC_PROGID}"
    !insertmacro PHOTOGRAP_DELETE_KEY_IF_EMPTY "${PHOTOGRAP_ASSOC_EXT_KEY}\OpenWithProgids"
    !insertmacro PHOTOGRAP_DELETE_KEY_IF_EMPTY "${PHOTOGRAP_ASSOC_EXT_KEY}"
    ; ProgID 機碼是 Photograp 自己的，不論 .pgraph 指向誰都刪（不存在時 DeleteRegKey 什麼也不做）。
    DeleteRegKey SHCTX "Software\Classes\${PHOTOGRAP_ASSOC_PROGID}"
    ClearErrors
    Pop $1
    Pop $0
    ; SHCNE_ASSOCCHANGED：通知檔案總管關聯已變，圖示與「開啟檔案」的對應立即更新。
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
