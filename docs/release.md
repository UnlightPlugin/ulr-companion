# 打包、發布與自動更新（WP-08）

規格書 §10 的落地細節。

> **2026-08-08 更新：打包已實作**（`npm run dist` → `out/release/`），
> 但**自動更新沒有走 electron-updater**，而是自己寫的 `apps/tray/src/updater.ts`。
> 理由見那支的檔頭：套用的時機不能落在對戰中。差異整理在文末「實際做出來的樣子」。

---

## 結論先講

| 問題                                | 答案                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| 怎麼打包                            | Electron + electron-builder，Windows 目標 **NSIS**（不是 portable） |
| 怎麼自動更新                        | GitHub Releases + **electron-updater**                              |
| 能不能靜默更新                      | **能**，但有一個必要條件（見下面的 `perMachine`）                   |
| UI 全做在遊戲畫面內、只留系統匣圖示 | **可以**，而且規格書 §9.1 反而要求要有一個備援視窗                  |

---

## 1. 為什麼是 Electron（明明沒有視窗）

插件的畫面全部注入到遊戲裡，本體看起來只需要一個系統匣圖示。那為什麼不用
Node.js + pkg 打成單一 exe？三個理由：

1. **`electron-updater` 是成熟的自動更新方案。** 純 Node 沒有等價物，
   得自己處理下載、驗證、替換執行中的檔案、回滾 —— 那是一整個工作包。
2. **規格書 §9.1 要求備援視窗。**

   > 「UI 注入屬非公開 DOM 耦合，必須有降級策略：若找不到目標節點，仍應在
   > Companion 視窗或系統匣顯示計算結果，不得因注入失敗使遊戲崩潰。」

   遊戲改版一定會把注入弄壞，那時候要有地方顯示 COST。所以視窗還是要有，
   只是預設不顯示。

3. **程式碼簽章與 SmartScreen 的處理** electron-builder 已經包好了。

所以架構是：**平常沒有視窗，只有 Tray；注入失敗時把藏起來的視窗叫出來。**

---

## 2. 打包

```
npm i -D electron electron-builder
npm i electron-updater          # 這個是執行期依賴，不是 devDependency
```

`apps/companion/electron-builder.yml`：

```yaml
appId: online.ulgg.companion
productName: ULR Companion

win:
  target: nsis
  icon: build/icon.ico

nsis:
  oneClick: true # 不問安裝路徑，一路到底
  perMachine: false # ★ 關鍵，見下一節
  allowToChangeInstallationDirectory: false
  deleteAppDataOnUninstall: false # 保留玩家的本機規則包與設定

publish:
  provider: github
  owner: UnlightPlugin
  repo: ulr-companion
```

**不要用 portable target。** Portable exe 沒有安裝器，electron-updater
無法自我替換，等於放棄自動更新。

---

## 3. 靜默更新：`perMachine: false` 是關鍵

```ts
import { autoUpdater } from "electron-updater";

autoUpdater.autoDownload = true; // 背景下載，玩家無感
autoUpdater.autoInstallOnAppQuit = true; // 關閉插件時自動套用，不跳任何視窗

autoUpdater.checkForUpdates(); // 啟動時非阻塞地檢查
```

這樣玩家從頭到尾看不到任何更新對話框：背景下載完，下次關掉插件時就裝好了。

### 為什麼 `perMachine` 決定了能不能真的靜默

| 設定                        | 安裝位置         | 每次更新                          |
| --------------------------- | ---------------- | --------------------------------- |
| `perMachine: false`（預設） | `%LOCALAPPDATA%` | **不需要 UAC** → 真靜默 ✅        |
| `perMachine: true`          | `Program Files`  | 每次都跳 UAC 提權 → 不可能靜默 ❌ |

裝到 `Program Files` 需要管理員權限，所以**每一次更新都會彈 UAC**。
玩家會以為中毒。所以一定要 per-user 安裝。

### 但**不要**在戰鬥中強制重啟

規格書 §10.2 第 3 點：

> 「程式新版下載完成後顯示『重新啟動並更新』；**預設不在戰鬥中強制關閉程式**。」

所以：

- ✅ 背景下載 —— 隨時可以，玩家無感
- ✅ `autoInstallOnAppQuit` —— 玩家自己關的時候才裝
- ❌ 主動呼叫 `autoUpdater.quitAndInstall()` —— 會直接殺掉程式。
  只有在確認不在戰鬥中、而且是玩家按了「立即更新」時才能用。

「靜默」指的是**不打擾**，不是「未經同意就重啟」。

---

## 4. 發布管線

```
git tag v0.4.0 && git push --tags
        ↓
GitHub Actions：lint → test → 封包 fixture 重播 → electron-builder --publish always
        ↓
GitHub Release 自動產生：
  ULR-Companion-Setup-0.4.0.exe    安裝檔
  latest.yml                       ★ electron-updater 靠這個判斷有沒有新版
  *.exe.blockmap                   ★ 差分更新用，只下載變動的區塊
```

`latest.yml` 與 `blockmap` **一定要在 Release 裡**，否則自動更新不會動。
electron-builder 設好 `publish` 之後會自動產生並上傳這三個。

blockmap 很重要：Electron app 大約 80–100MB，有差分更新的話每次只下載幾 MB。

CI 需要的權限：`permissions: contents: write`（目前 `ci.yml` 是唯讀，
發布用另一個 workflow，不要放寬既有的）。

---

## 5. 程式碼簽章與 SmartScreen

**沒有憑證的話**：

- **首次安裝**會跳 SmartScreen「不明的發行者」警告。這是最痛的一關。
- **後續更新不會**再跳 —— 安裝器是由已安裝的程式啟動的，不帶
  Mark-of-the-Web，SmartScreen 通常不介入。

規格書 §10.3 的底線：

> 「尚未簽章時，下載頁必須揭露 Windows SmartScreen 可能警告，
> **不得教玩家關閉系統防護**。」

所以下載頁要放安裝檔的 SHA-256 讓人自行核對，並老實說明會看到什麼畫面。
不要寫「把防毒關掉就好」那種指引。

---

## 6. 系統匣 + 全部畫面在遊戲內

```ts
// 沒有視窗也不要退出 —— 預設行為是關掉最後一個視窗就 quit
app.on("window-all-closed", () => {});

const tray = new Tray(path.join(__dirname, "icon.ico"));
tray.setContextMenu(
  Menu.buildFromTemplate([
    { label: "規則：亞城平衡表 1.2.0 (c5af2bd9)", enabled: false },
    { type: "separator" },
    { label: "顯示診斷視窗", click: () => fallbackWindow.show() },
    { label: "檢查更新", click: () => autoUpdater.checkForUpdates() },
    { type: "separator" },
    { label: "結束", click: () => app.quit() },
  ]),
);

// §9.1 的備援視窗：平常藏著，注入失敗才叫出來
const fallbackWindow = new BrowserWindow({ show: false });
```

三個 Windows 上的坑：

1. `window-all-closed` 預設會讓 app 退出。沒有視窗的 app 一定要蓋掉它。
2. Tray 圖示在 Windows 要 `.ico`，png 會不顯示或糊掉。
3. 玩家可能把圖示收進「隱藏的圖示」區，找不到就以為當掉了。
   第一次啟動時給一個 balloon 提示。

---

## 7. 怎麼驗證（M6 驗收）

規格書 §13 的 M6 通過條件是「首次安裝後可自動升級；規則更新不重裝；
強制升級、離線與驗證失敗案例通過」。最小的端到端驗證：

1. 發 `v0.0.1-alpha.1`（prerelease），下載安裝
2. 改個看得出來的東西，發 `v0.0.1-alpha.2`
3. 開著插件放一下 → 背景下載完成
4. 關掉插件再開 → **應該已經是 alpha.2，全程沒有任何對話框**

再加測三個失敗情境：

- 把網路拔掉 → 用最後一次驗證過的本機版本，畫面顯示「無法檢查更新」，不得刪資料
- 手改 `latest.yml` 的 sha512 → 拒絕套用，保留上一版
- 把 ULGG 的 `minimumPluginVersion` 調高 → 舊版停止上傳 Room／戰果並導向更新，
  但本機查詢與診斷仍可使用

這四步跑通，WP-08 就算完成。

---

## 實際做出來的樣子（2026-08-08）

### 要發布的只有一個檔

| 檔案                                  | 發？ |                                       |
| ------------------------------------- | ---- | ------------------------------------- |
| `ULR Companion Setup <版本>.exe`      | ✅   | 唯一要發的                            |
| `latest.yml` / `*.blockmap`           | ❌   | electron-updater 的機制，**我們沒用** |
| `builder-debug.yml` / `win-unpacked/` | ❌   | 建置中間產物                          |

加上一份**自己寫的清單 JSON**，位置由環境變數 `ULR_UPDATE_FEED` 指定：

```json
{
  "version": "0.1.0",
  "url": "https://.../ULR.Companion.Setup.0.1.0.exe",
  "sha256": "<64 個十六進位字元>",
  "notes": "一行說明，會寫進 log"
}
```

⚠ **沒有 `sha256` 就整份丟掉。** 下載回來的是會被執行的東西，
「來源是 HTTPS」不足以當作它沒被換過的理由。

### ⚠ 沒有差分更新

`updater.ts` 是 `fetch(url)` 抓**整個**安裝檔（約 86 MB），不是差分。
差分是 electron-updater 靠 `latest.yml` + `blockmap` 做的。要差分就得換回
electron-updater，代價是「不在對戰中套用」那個保證要重做。

### ⚠ 更新一定會重啟，這件事沒有辦法繞過

換掉正在執行的執行檔，程序就必須結束。能做的只有讓它**不被察覺**：

1. 下載完全靜默（背景，沒有任何對話框）
2. **只在 `armed === false` 時套用** —— 也就是攔截沒掛在 socket 上，不在對戰中
3. 靜默安裝（`/S`），NSIS 裝完自己把新版叫起來
4. 新版看到 `updating.mark` 就**不跳視窗**，只在 log 留一行「已更新到 x.y.z」

⚠ 第 4 點需要一張**檔案**紙條，不能用命令列旗標 —— 新版是 NSIS 叫起來的，
不是我們，我們決定不了它帶什麼參數。

⚠ 紙條有 10 分鐘時效。安裝被取消時紙條會留著，沒有時效的話玩家之後每次
手動開都不跳視窗，症狀是「點了圖示沒反應」。

### ⚠ 曾經有過的 bug：套用其實沒有發生

早期版本的 `applyIfIdle()` 只做了 `app.relaunch()`，**從來沒有去執行下載回來的
安裝檔**。結果是版本永遠不變 → 下一輪 tick 又下載、又重開 → **每小時無限重啟**，
而且因為沒有拋錯，log 上完全看不出哪裡不對。

### 🔲 還沒處理：多開時的更新

一個實例觸發更新，NSIS 會把**所有**執行中的實例關掉，而裝完只會叫起來一個。
玩家的第二個實例會安靜地消失。目前沒有處理 —— 要嘛記下當時開著哪幾份配置
再逐一叫回來，要嘛只讓其中一份負責更新。
