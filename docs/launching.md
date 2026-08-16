# 怎麼讓玩家不用手動設 debug port（WP-07）

CDP 的 `--remote-debugging-port` **只能在啟動時指定**，沒辦法對已經在跑的
程序補掛。所以插件必須自己啟動客戶端 —— 否則每個玩家都得手動去設 Steam
啟動選項，那是不可能推廣的。

**結論（2026-07-28 實測驗證）：桌面版與網頁版都可以由插件自己啟動，
兩邊都不需要玩家改任何設定。**

> ⚠ **2026-08-09 更新：那是設計，還不是現況。**
>
> 「插件自己啟動客戶端」在 CLI 那邊有（`companion web`、`browser`），
> **托盤沒有** —— 它只會連上一個已經開著 debug port 的客戶端，不會去開遊戲。
> 所以在那個功能補上之前，**玩家還是得自己去 Steam 設一次啟動選項**：
>
> ```
> Steam 遊戲庫 → UNLIGHT:Revive 按右鍵 → 內容… → 一般 → 啟動選項
> --remote-debugging-port=59222
> ```
>
> 這段教學**寫在托盤的「設置 › 連線」頁裡**，不是只寫在這裡 —— 需要它的人
> 是對著「等遊戲…」不知道下一步的玩家，他不會來翻這份文件。改那段文字時
> 記得兩邊要一致。
>
> 網頁版則相反：**Steam 的啟動選項要清空**，埠是由 `launch-chrome.cmd` 決定的。

---

## 桌面版：直接執行 exe 就可以

```
<遊戲目錄>\UNLIGHTRevive.exe --remote-debugging-port=59222
```

實測撐過 45 秒正常運作，debug port 第 1 秒就通，且

```json
{
  "loaded": true,
  "phaser": "3.87",
  "url": "https://www.playunlight.online:14018/?steamid=765611998546…&token=***"
}
```

—— URL 帶著有效的 steamid 與 token，代表 **Steam 驗證確實通過了**，
不只是 Electron 起得來而已。

### 為什麼不必透過 Steam

1. **`steam_appid.txt` 遊戲本身就內建**（官方包裡就有，不是我們加的）。
   有它在，Steamworks 就能在直接執行時初始化。
2. **`main.js` 沒有 `requestSingleInstanceLock`**，多開不互擋。
3. 遊戲本來就會讀自訂 switch（`x` / `y` / `fullscreen`），不排斥額外參數。

唯一前提：**Steam 客戶端要在跑**，而且登入的是玩家想用的那個帳號。

### 插件要做的事

1. 從登錄檔找 Steam 安裝位置，掃 `libraryfolders.vdf` 找遊戲路徑
   （別寫死磁碟代號 —— 這台機器就裝在 `E:\`）
2. 檢查 Steam 客戶端在跑
3. 檢查 `app.asar` 是視窗版（見下面的陷阱 2）
4. 清掉 `ELECTRON_RUN_AS_NODE`（見陷阱 1）後啟動
5. 輪詢 `http://127.0.0.1:59222/json/version` 直到通
6. 保留玩家原本的偏好（例如 `--force-device-scale-factor=1.5`）做成設定項

參考實作：`Desktop\Unlight\launch.py`。

---

## ⚠ 兩個會讓人誤判「直接執行不可行」的陷阱

排查時兩個都踩過，各浪費不少時間。症狀都是**「一開就立刻關掉」**，
但原因完全不同，而且都跟 Steam 無關。

### 陷阱 1：`ELECTRON_RUN_AS_NODE`

```
UNLIGHTRevive.exe: bad option: --remote-debugging-port=59222
exit code 9
```

**VS Code 的 extension host 會設 `ELECTRON_RUN_AS_NODE=1`**，子程序會繼承。
帶著它啟動任何 Electron app，那個 exe 就被當成**純 Node** 執行，於是
Chromium 的參數變成無法辨識的 Node 選項，直接 exit 9。

從 VS Code 終端機、或任何 VS Code 開的程序底下跑都會中。

> **這條對 Companion 自己也適用。** Companion 是 Electron app，它 spawn
> 出去的子程序若帶著 `ELECTRON_RUN_AS_NODE`，一樣會爆。所有 spawn 前都要
> `delete env.ELECTRON_RUN_AS_NODE`。

### 陷阱 2：生效的是網頁版 `app.asar`

`resources\app.asar` 有兩種，靠**互換檔案**切換，一次只有一種生效。沒啟用的那個
通常被改名留在同一個目錄，但**命名沒有標準**（社群的切換腳本各叫各的），所以程式
裡一律**只認體積、不認檔名** —— 見 `cdp-adapter` 的 `detectGameInstall()`：

| 版本   | 大小      | 行為                                                     |
| ------ | --------- | -------------------------------------------------------- |
| 視窗版 | 約 404 MB | 正常開視窗跑遊戲                                         |
| 網頁版 | 約 153 KB | 拿 Steam ticket → `openExternal` 開瀏覽器 → `app.quit()` |

**網頁版「一開就立刻關掉」是設計行為，不是失敗。** 它的工作就是把玩家
丟到瀏覽器然後自己退出，所以不會留下可以掛 CDP 的視窗。

插件啟動前一定要檢查檔案大小，發現是網頁版就明確告訴玩家，
不要讓人對著正常行為除錯。

> 我第一次測時剛好處於網頁版狀態，於是得出「直接執行必定 crash、
> Steam API 載不進來」的錯誤結論，還把它寫進了這份文件。
> 換回視窗版之後同一組測試立刻通過。

---

## 網頁版：插件啟動瀏覽器

Chrome、Edge、Brave 都是 Chromium，都吃 `--remote-debugging-port`。

```
chrome.exe --remote-debugging-port=59223 --user-data-dir=<插件自己的 profile>
```

**已實作**：`cdp-adapter` 的 `ensureBrowser()`（`src/browser.ts`）。
`companion web --steamid <id>` 會先呼叫它 —— 埠有人在聽就沿用，沒有就自己開一個。

```
npx tsx apps/companion/src/index.ts web --steamid <SteamID64>
    [--port 59223] [--profile <目錄>] [--browser <chrome.exe>]
```

預設 profile 是 `%USERPROFILE%\ulr-cdp-profile`。

### ⚠ 埠是首選，不是保證（2026-08-16）

`ensureBrowser()` **啟動前會先試綁一次那個埠**，綁不上就改用
`--remote-debugging-port=0`，讓 Chromium 自己挑，再從
`<user-data-dir>\DevToolsActivePort` 把實際的埠讀回來（第一行是埠，
第二行是 browser ws path）。所以 `result.port` 有可能不等於你要的那個
—— CLI 會印出來，之後的指令要帶那一個。

為什麼要這樣做，而不是「換一個好一點的埠號」：見
[埠被 Windows 保留](#埠被-windows-保留吃掉整段)。

### 這條路完全不經過 Steam

2026-08-02 實測（`web --steamid` → `probe --port 9334`）：

```
✓ 已開新分頁 https://www.playunlight.online:14018/?steamid=***
✓ 遊戲的 execution context = 2   window.game 已建立   Phaser 3.87
```

身分只有網址上的 `steamid`（token 沒有被用到，見 `boot-shell.ts` 開頭），所以：

- **換帳號＝換一個 `--steamid`**，跟 Steam 客戶端登入的是誰無關。
  Steam 網頁版本身沒有換帳號的路，這裡繞過了整個問題。
- **不會卡在「正在停止」**。那是 Steam 在等遊戲行程收尾，我們沒讓 Steam 參與。
  反過來說，Steam 卡在停止中的時候 `steam://rungameid` 會失效 —— 那正是
  `refreshBundles()` 會失敗、更需要這條備援路徑的時候。

Steam 只剩下**一個**用途：改版後重讀 bundle 檔名。那是每週一次，不是每次開遊戲。

> ⚠ 兩個帳號**同時**開還是不行 —— 伺服器依 IP 擋多重登入（見文末附註）。
> 這條路解決的是「換」帳號，不是「雙開」。

> ⚠ `web --refresh` 仍然依賴 Steam 把網址交給**這一個**瀏覽器。`openExternal`
> 走的是系統預設瀏覽器，玩家的預設若是另一個 profile 的 Chrome，遊戲會開在
> 那邊，`--refresh` 就讀不到（症狀是等到逾時）。

### `--user-data-dir` 是必要的，不是選配

玩家已經開著 Chrome 時，用**同一個 profile** 再啟動一次，Chrome 只會在既有
實例開一個新分頁，**命令列參數整個被忽略**，debug port 不會開。

專屬 profile 才能保證是全新實例，也完全不影響玩家平常的瀏覽器
（兩邊可以同時開著）。

### 代價：要在那個 profile 裡登入一次

新 profile 沒有 cookie，玩家得在插件開的瀏覽器裡登入一次，之後會記住。
UI 要講清楚，不然會以為壞掉。

### 之後可以考慮：瀏覽器擴充功能

對純網頁版玩家，Chrome 擴充功能比 CDP 順 —— 不用另開瀏覽器、不用重新登入、
直接就有頁面存取權。但那是另一套發布管道，而且拿不到桌面端的東西
（系統匣、自動更新、本機規則檔）。**MVP 先不做。**

---

## 埠被 Windows 保留（吃掉整段）

**這是這個專案踩過兩次、每次都花掉一小時的坑。** 症狀在外觀上跟「參數被忽略」
一模一樣：客戶端照常啟動、`--remote-debugging-port` 也確實在它的命令列上
（工作管理員看得到），但**沒有人在聽那個埠，`DevToolsActivePort` 也不會產生**。

| 日期       | 埠   | 被誰吃掉           |
| ---------- | ---- | ------------------ |
| 2026-07-30 | 1221 | 保留範圍 1196–1295 |
| 2026-08-16 | 9334 | 保留範圍 9277–9876 |

### 為什麼會這樣

Hyper-V／WSL／Docker 會從**動態埠範圍**裡切走 100 埠一段拿去用，而那個範圍
本身是可以被改的：

```
netsh interface ipv4 show excludedportrange protocol=tcp   ← 現在被保留了哪些
netsh interface ipv4 show dynamicport tcp                  ← 保留是從這裡切的
```

- Windows 預設的動態範圍是 **49152–65535** → 高位埠有風險
- 被改過的機器（開發機是 **1024–15000**）→ 低位埠有風險

兩種設定的危險區剛好相反，**所以沒有任何常數在兩邊都安全**。挑埠號等於在賭
玩家的機器是哪一種，而且保留範圍是**動態的** —— 重開機、起一次 Docker 都可能
改變，「本來好好的，今天突然連不上」就是這麼來的。

### 所以插件不靠埠號，靠偵測

`packages/cdp-adapter/src/debug-port.ts`：

| 時機         | 做什麼                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| 啟動瀏覽器前 | `probePortState()` 試綁一次。`blocked` 就改用 `--remote-debugging-port=0` |
| 連線時       | 首選埠沒回應 → 讀 `<user-data-dir>\DevToolsActivePort` 找回實際的埠       |
| 連不上時     | `explainDebugPort()` 分辨「沒開遊戲」與「這個埠根本綁不上」               |

`--remote-debugging-port=0` 的 0 **不是位址**，是「Chromium 你自己挑一個」。
`127.0.0.1:0` 永遠不會有人聽 —— 挑到什麼只寫在 `DevToolsActivePort` 的第一行。

⚠ **所以 0 只能出現在命令列上，不能存進設定。** 托盤是拿埠當實例身分的
（`main.ts` 的 userData 分離、兩份配置不得重複），存 0 會讓兩份配置撞在一起。

⚠ **回退範圍必須限定在同一種客戶端。** 兩種客戶端各有各的 user-data-dir：

```
桌面版  %APPDATA%\UNLIGHT-Revive
網頁版  %USERPROFILE%\ulr-cdp-profile
```

不分種類地亂找，症狀會是「我開的是網頁版的插件，它卻接到桌面版的遊戲去」。
所以 `userDataDirFor(kind)` 跟著配置的 `kind` 走，而且**不給就不回退** ——
寧可連不上，也不要接錯客戶端。

> 這個病不只咬客戶端。`arbiter-link` 的 broker 測試本來寫死 9377，
> 2026-08-16 那天整個測試跟著掛掉，而失敗訊息（「第一個開的沒有當中間人」）
> 完全看不出跟埠有關。任何需要固定埠的地方都該跟作業系統借，不要寫死。

---

## 已經啟動的程序能不能補 debug port？

**不能。** DevTools 的 HTTP/WebSocket 伺服器是 Chromium 在**啟動過程中**
建立的，之後沒有任何 API、訊號或 IPC 可以叫它補開。

（這也是 `--remote-debugging-port=0` 值得推薦給玩家的理由：既然只有啟動時
設得了，那就設一個**永遠不會綁不上**的值，剩下的交給插件去查。）

理論上還有一條路（Node 對執行中程序啟用 inspector，再從 Electron 主程序
摸到 `webContents`），**但不要走**：那是對別人的程序做注入，防毒與
SmartScreen 幾乎一定會有意見，各 Electron 版本行為又不一致。

---

## 「開遊戲時自動開插件」

### A. 插件的捷徑取代遊戲捷徑（推薦，零設定）

安裝時建立「UNLIGHT:Revive（含 ULR Companion）」捷徑。玩家點它 →
插件先起來 → 插件帶參數啟動遊戲 → 自動接上。

桌面版與網頁版都適用，完全不碰 Steam 設定。

### B. Steam 啟動選項用 `%command%` 包一層

給堅持要從 Steam 按「遊玩」的玩家。`%command%` 會被代換成遊戲真正的
命令列，可以用自己的執行檔把遊戲包起來：

```
"%LOCALAPPDATA%\Programs\ULR Companion\ULRCompanion.exe" %command% --remote-debugging-port=59222
```

代價：要玩家自己貼一次，而且**每個 Steam 帳號各設一份** ——
用小號玩時主帳號的設定不會生效。既然 A 方案可行，B 只是備案。

> ⚠ `%command%` 在 Windows 版 Steam 的行為尚未實測。

### C. 插件隨 Windows 開機常駐

`app.setLoginItemSettings({ openAtLogin: true })`，系統匣圖示一直在。
搭配 A 用，不是替代 —— 玩家若繞過插件直接開遊戲，port 還是沒開。

---

## 偵測與降級

1. 先探 `127.0.0.1:<port>/json/version`
2. 通 → 直接接上
3. 不通但遊戲已經在跑 → **不要偷偷殺掉玩家的遊戲**。說明要透過插件重新
   啟動才能接上，並提供按鈕，讓玩家自己決定何時關。
4. 遊戲沒在跑 → 直接帶參數啟動

第 3 點很重要：玩家可能正在打，插件不該替他做關閉的決定。

---

## 附註：本機雙開測試的限制

開發時想在同一台機器跑兩個客戶端互打，會遇到伺服器端的

> 錯誤：禁止多重啟動遊戲

這是**依 IP 判斷**的，兩個客戶端必須來自不同 IP。網頁版可以靠瀏覽器的
VPN 擴充功能，桌面版沒有等價做法。

不過**大部分工作不需要本機雙開**：

- 回合倒數量測 —— 單邊就夠
- 第一期的 3 秒反悔窗口 —— 本來就是單邊功能
- 只有「A 的動作會不會洩漏給 B」的驗證與第二期握手需要兩邊

那兩項用兩台裝置（其中一台用手機熱點）比在同一台上想辦法簡單得多。
