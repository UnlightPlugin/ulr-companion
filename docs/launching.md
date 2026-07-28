# 怎麼讓玩家不用手動設 debug port（WP-07）

CDP 的 `--remote-debugging-port` **只能在啟動時指定**，沒辦法對已經在跑的
程序補掛。所以插件必須自己啟動遊戲，否則每個玩家都得手動去設 Steam
啟動選項 —— 那是不可能推廣的。

**結論：插件自己啟動客戶端，桌面版與網頁版都適用，都不需要改任何系統設定。**

---

## 桌面版（Electron）

### 為什麼可以直接執行 exe

原本以為必須透過 Steam 啟動（直接跑 exe 會秒退），但看過遊戲檔案後發現不用：

**1. `steam_appid.txt` 遊戲本身就內建了**

```
E:\SteamLibrary\steamapps\common\UNLIGHTRevive\win-unpacked\steam_appid.txt
```

這是官方包裡就有的檔案（不是我們加的）。有它在，Steamworks 就能在直接執行
exe 時初始化 —— 那正是這個檔案存在的目的。前提只有一個：**Steam 客戶端要在跑**。

**2. `main.js` 沒有單一實例鎖**

全部 110 行裡沒有 `requestSingleInstanceLock`，所以多開不會互相擋。

**3. Steam 初始化是渲染層觸發的，不是啟動時**

```js
ipcMain.handle('steam:init', () => {
  try { return greenworks.init(); }
  catch (error) { app.quit(); }     // ← 失敗才 quit
});
```

也就是 `app.quit()` 發生在頁面呼叫 `steam:init` 失敗時，不是程序一起來就檢查。

**4. 遊戲本來就會讀自訂命令列參數**

```js
const x = app.commandLine.getSwitchValue("x");
const y = app.commandLine.getSwitchValue("y");
const fullscreen = app.commandLine.hasSwitch("fullscreen");
```

多加 `--remote-debugging-port` 不會讓它不高興。

### 做法

```
<遊戲目錄>\UNLIGHTRevive.exe --remote-debugging-port=9333
```

插件負責：

1. 從 Steam 的 `libraryfolders.vdf` 找出遊戲安裝路徑（別寫死 `E:\`）
2. 確認 Steam 客戶端在跑，沒有的話先叫起來並等它就緒
3. 帶參數啟動，然後輪詢 `http://127.0.0.1:9333/json/version` 直到通
4. 保留玩家原本的偏好（例如 `--force-device-scale-factor=1.5`），做成設定項

> ⚠ 尚未實測。推論依據是上面四點，但還沒實際跑過
> `UNLIGHTRevive.exe --remote-debugging-port=9333`。
> 要測的話請在**沒有進行中的對戰**時測 —— 同一個 Steam 帳號重複登入
> 可能會把既有連線踢掉。

### 為什麼不去改 Steam 的啟動選項

技術上做得到：啟動選項存在
`<Steam>\userdata\<accountid>\config\localconfig.vdf` 的
`UserLocalConfigStore/Software/Valve/Steam/apps/3247080/LaunchOptions`。

但**不要這樣做**：

- Steam 把 `localconfig.vdf` 快取在記憶體裡，離開時整個覆寫回去。
  Steam 執行中改它 = 白改。要改就得先關 Steam，UX 很糟。
- 那個檔案裝的是玩家所有遊戲的設定。寫壞了損失遠超過我們的功能。
- 它是**每個 Steam 帳號各自一份**。玩家用小號開遊戲時設定不會生效 ——
  這正是 2026-07-28 現場踩到的狀況：啟動選項只設在主帳號，用小號開的
  視窗就沒有 debug port。

自己啟動完全避開這三個問題。

---

## 網頁版

同一招，對象換成瀏覽器。Chrome、Edge、Brave 都是 Chromium，都吃
`--remote-debugging-port`。

```
chrome.exe --remote-debugging-port=1221 --user-data-dir=<插件自己的 profile>
```

### `--user-data-dir` 是必要的，不是選配

如果玩家已經開著 Chrome，用**同一個 profile** 再啟動一次，Chrome 只會在既有
實例開一個新分頁，**命令列參數整個被忽略**，debug port 不會開。

用插件專屬的 profile 目錄才能保證是全新實例、確實帶著 debug port，
而且完全不影響玩家平常的瀏覽器（可以同時開著）。

### 代價：要在那個 profile 裡登入一次

新 profile 沒有 cookie，玩家得在插件開的瀏覽器裡登入一次。之後 profile
會保存，不用重登。這點要在 UI 講清楚，不然會以為壞掉。

### 之後可以考慮：瀏覽器擴充功能

對純網頁版玩家，Chrome 擴充功能其實比 CDP 更順 —— 不用另開瀏覽器、不用
重新登入、直接就有頁面存取權。

但那是另一套發布管道（Web Store 審核或未封裝載入），而且拿不到桌面端的
東西（系統匣、自動更新、本機規則檔）。**MVP 先不做**，等網頁版玩家的比例
確定值得再說。

---

## 已經啟動的程序能不能補上 debug port？

**不能。** 沒有任何受支援的做法。

`--remote-debugging-port` 會讓 Chromium 在**啟動過程中**建立 DevTools 的
HTTP/WebSocket 伺服器。之後沒有任何 API、訊號或 IPC 可以叫它補開。

理論上還有一條路：Electron 主程序是 Node，Node 有辦法對執行中的程序啟用
inspector（POSIX 的 SIGUSR1、Windows 的 `process._debugProcess`），接上去
之後可以從主程序拿到 `webContents` 再操作渲染層。**但不要走這條**：

- 那是對別人的程序做注入，防毒與 SmartScreen 幾乎一定會有意見
- 各 Electron 版本行為不一致，打包後的 app 更難預期
- 為了省一次重開遊戲，換來一個難以維護又難以取信於人的機制，不划算

所以插件的策略只有一個：**由插件負責啟動**。玩家自己先開好的情況，就請他
重開一次（見下面的「偵測與降級」）。

---

## 「開遊戲時自動開插件」

三種做法，可以並存。

### A. 插件的捷徑取代遊戲捷徑（推薦，零設定）

安裝時建立「UNLIGHT:Revive（含 ULR Companion）」捷徑。玩家點它 →
插件先起來 → 插件帶參數啟動遊戲 → 自動接上。

桌面版與網頁版都適用，不碰 Steam 任何設定，也不需要玩家複製貼上什麼。

### B. Steam 啟動選項用 `%command%` 包一層

給堅持要從 Steam 按「遊玩」的玩家。Steam 的啟動選項支援 `%command%`
佔位符，會被代換成遊戲真正的命令列 —— 也就是可以用自己的執行檔把遊戲包起來：

```
"%LOCALAPPDATA%\Programs\ULR Companion\ULRCompanion.exe" %command% --remote-debugging-port=9333
```

流程變成：Steam 按遊玩 → 啟動 Companion → Companion 補上參數再啟動遊戲。

代價：這行要玩家自己貼一次，而且**每個 Steam 帳號各設一份**。
用小號玩的時候要記得也設。

> ⚠ `%command%` 在 Windows 版 Steam 的行為尚未在本專案實測，
> 實作前先驗證一次。

### C. 插件隨 Windows 開機常駐

`app.setLoginItemSettings({ openAtLogin: true })`，系統匣圖示一直在。
這樣玩家不管用哪種方式開遊戲，插件都已經在等了。

但要注意：**光是常駐不能解決 debug port 的問題** —— 如果玩家繞過 A 和 B
直接開遊戲，port 還是沒開，插件只能請他重開。C 是搭配 A/B 用的，不是替代。

---

## 偵測與降級

不管哪一種，插件都要能處理「玩家自己先開好了遊戲」的情況：

1. 先探 `127.0.0.1:<port>/json/version`
2. 通 → 直接接上
3. 不通但遊戲已經在跑 → **不要偷偷殺掉玩家的遊戲**。顯示「請透過插件重新
   啟動遊戲」並提供按鈕，讓玩家自己決定什麼時候關。
4. 遊戲沒在跑 → 直接帶參數啟動

第 3 點很重要：玩家可能正在打，插件不該替他做關閉的決定。
