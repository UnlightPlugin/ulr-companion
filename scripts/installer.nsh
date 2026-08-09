# NSIS 客製：強制「只裝給我自己」
# =================================
# electron-builder 的 `nsis.include` 會把這一段插進安裝器。
#
# ⚠ **為什麼不是放在慣例的 `build/installer.nsh`：** `build/` 整個在 .gitignore
# 裡（那裡只有 `pack-tray.mjs` 現畫出來的 icon.ico，是產生物）。這一支是原始碼，
# 必須進版控，所以放 `scripts/` 並在 electron-builder.yml 明寫 `include:`。
#
# ## 這一行在解什麼問題
#
# 為了讓玩家能把程式裝到 D:／E:（C 槽最先滿），安裝器從 oneClick 改成引導式
# （`oneClick: false` + `allowToChangeInstallationDirectory: true`）。但引導式
# 安裝器**預設會多出一頁「要裝給誰用」**（所有使用者／只有我），而那一頁是個陷阱：
#
#   選「所有使用者」→ 裝進 Program Files → 需要 UAC → **之後每一次自動更新
#   都會跳 UAC**。玩家看到的是「這個插件三不五時要我按同意」，而更新本來
#   應該是他察覺不到的事（updater.ts 的整個設計前提）。
#
# `$isForceCurrentInstall` 是 app-builder-lib 的 multiUserUi.nsh 留的鉤子：
# 設成 1 就直接選定 per-user 並 `Abort` 掉那一頁 —— 玩家不會看到它，也就不會
# 選錯。選路徑那一頁**照常出現**，兩件事是獨立的。
#
# per-user 不代表只能裝在 C：`$INSTDIR` 只是預設帶到 %LOCALAPPDATA%\Programs，
# 玩家在下一頁改成 E:\Programs\ULR Companion 完全沒問題，而且不需要管理員權限
# （只要那個資料夾他寫得進去）。
#
# ⚠ 靜默更新（updater.ts 的 `/S`）不經過這一頁：安裝器的 .onInit 會先從
# HKCU 的 InstallLocation 讀出上次裝在哪，所以更新一律裝回玩家選的那個位置。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
