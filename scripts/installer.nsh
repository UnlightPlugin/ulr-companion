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

# ## 靜默更新裝完之後，要自己把新版叫起來
#
# ⚠ **這是玩家 2026-08-09 回報的「更新完插件就不見了，要手動再開一次」。**
#
# 成因是 `oneClick: false` 的副作用，而且是很難聯想的那種：
#
#   oneClick   裝完自動啟動新版（`runAfterFinish` 預設 true）
#   引導式     「啟動程式」是**完成頁上的一個核取方塊**
#
# 而 `/S` 靜默安裝**整個跳過完成頁** —— 於是那個核取方塊永遠沒有機會被勾，
# 也就沒有人去啟動新版。updater.ts 那邊 `app.quit()` 把舊版關掉了，新版沒人開，
# 玩家看到的就是「插件自己消失了」。
#
# 當初從 oneClick 改成引導式是為了讓玩家選安裝路徑（上面那段），完全沒有想到
# 會把自動更新的最後一步一起換掉。**兩件事在 electron-builder 裡是綁在一起的。**
#
# ## 為什麼修在這裡，不是修在 updater.ts
#
# updater.ts 那邊也做得到（spawn 一個等安裝器結束再開 app 的殼），但它得自己
# 猜新版裝在哪 —— 而這裡的 `$INSTDIR` **就是剛剛裝進去的那個目錄**，不需要猜。
# 玩家把程式裝到 D:／E: 正是上面那段在支援的事，猜錯的話症狀會是「更新完開起來
# 的還是舊版」，比現在更難查。
#
# ⚠ **兩邊只能有一個做這件事。** 這個 app 刻意沒有 single instance lock（雙開
# 是預期用法，見 main.ts），所以兩邊都relaunch 會變成同一個埠開兩份，搶同一份
# userData 的鎖 —— 症狀是第二份畫面全白或直接退出。
#
# ⚠ 只在 `${Silent}` 時做。玩家自己雙擊安裝檔時走的是完成頁那條路，那裡本來
# 就有核取方塊；這裡再開一次會變成開兩份。
!macro customInstall
  ${if} ${Silent}
    # ⚠ 用 `Exec` 不是 `ExecShell`：後者會透過 Explorer 開，而 Explorer 是
    # **未提權**的殼 —— 這裡雖然 per-user 不會提權，但 Exec 的父子關係比較單純，
    # 而且拿得到我們清理過的環境（updater.ts 已經把 ELECTRON_RUN_AS_NODE 拔掉）。
    #
    # 新版看到 userData 裡的 updating.mark 就不會跳視窗，只在托盤出現 ——
    # 那是 updater.ts 刻意的行為，不是這裡漏做。
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${endif}
!macroend
