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

### ⚠ 2026-08-18 起：**主力是 zip，不是安裝檔**（WP-17）

一位玩家因為「exe 下載被瀏覽器標成危險」而放棄安裝。這件事分兩關，
而它們常被混為一談：

| 關卡                    | 咬什麼                      | zip 有沒有救                            |
| ----------------------- | --------------------------- | --------------------------------------- |
| **下載**（Chrome/Edge） | `.exe`，低信譽 → 警告或封鎖 | ✅ zip 幾乎不會被擋                     |
| **執行**（SmartScreen） | MOTW + 未簽章               | ⚠ Explorer 解壓會**把 MOTW 傳染給檔案** |

但 zip 有一條 exe 沒有的路：**在 zip 上按右鍵 →「內容」→ 勾「解除封鎖」→
再解壓**，解出來的檔案完全沒有 MOTW，執行時一個警告都不會跳。這一段要寫進
下載頁 —— 它比「更多資訊 → 仍要執行」那條路好走得多，也不必教任何人關防護。

`portable` 與 `zip` 完全是兩回事，不要一起否定掉：portable 是「單一 exe，
執行時解到暫存目錄再跑」，沒有一個穩定的安裝目錄可以換檔；zip 就是
`win-unpacked` 整包壓起來，**玩家解到哪就是哪**，換檔做得到。

### zip 版怎麼自我更新（照 MAA 的做法）

```
   主程式：驗簽章 → 驗雜湊 → 解壓到暫存 → 寫一支換檔腳本
           → 帶著自己的 PID 把它叫起來 → app.quit()
   腳本：  等那個 PID 死掉 → 搬檔案 → 把程式叫回來 → 收拾
```

⚠⚠ **Windows 擋的是「覆寫執行中的 exe」，不是「動那個目錄」。**
執行中的 exe **改名是允許的** —— 所以流程是「舊的改名 → 新的放進去 →
下次啟動再刪掉改名的那些」。MAA 的 `src/MaaUpdater/main.cpp` 裡
`RenameLockedFile` / `CleanupPendingDeleteFiles` 就是這兩步，我們的
`apps/tray/src/zip-update.ts` 也是。

⚠ **等 PID，不要睡固定秒數。** Electron 退出要跑完 `quit()`（拆補丁、關 CDP、
寫設定檔），時間不固定；睡三秒的失敗方式是「偶爾換不掉，而且只在慢的機器上」。

⚠ **安裝目錄寫不進去就明白地說一句**（有人會解壓到 `C:\Program Files\`）。
靜默失敗最糟：每小時重試一次、每次都失敗、玩家永遠停在舊版。

⚠ 客戶端**照清單裡網址的副檔名**決定走哪條路（`.exe` → NSIS `/S`，
`.zip` → 換檔）。所以「發布格式什麼時候從 exe 換成 zip」跟「玩家什麼時候
升級到支援 zip 的版本」是**解耦**的 —— 同一版兩種都吃得下。

⚠⚠ **但 1.0.0 的客戶端只認得 exe。** 它會把 zip 下載回來、驗完雜湊，然後
`spawn(zip, ["/S"])` 失敗。所以**要讓 1.0.0 的人升上來，`/update` 那份清單的
`url` 在這一版必須還是 `.exe`**；zip 給新玩家下載。下一版起才可以只發 zip。

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

### 真的要根治只有簽章（2026-08 的行情）

| 做法                    | 價錢            | 效果                                             |
| ----------------------- | --------------- | ------------------------------------------------ |
| **SignPath Foundation** | 0（OSS 專案）   | 真簽章、要申請；本專案 MIT 符合它收的授權        |
| Azure Trusted Signing   | 約 US$10／月    | 便宜，但**開放地區有限**，見下面那個 ⚠           |
| EV 憑證                 | US$300+／年     | 要硬體 token，而且**已經不再送即時信譽**（見下） |
| OV 憑證                 | US$200+／年     | 信譽要慢慢累積，發版初期還是會跳                 |
| Microsoft Store（MSIX） | 0（上架費另計） | **唯一保證不跳的**，但自動更新要整套交出去       |
| 不簽                    | 0               | 見上面那張表                                     |

⚠ **未簽章的檔案信譽是綁 hash 的，每發一版就歸零** —— 對一個常發版的專案，
「等信譽累積起來」這條路實際上不存在。

⚠⚠ **不要為了 SmartScreen 去買 EV。** 「EV 一簽下去就不跳」是 2023 年以前的
行情，那個特殊待遇已經被 Microsoft 取消 —— 現在 OV 與 EV 一樣要靠信譽累積，
新版初期照樣可能跳。electron-builder 的文件還停在舊說法，以 Microsoft 的為準。

⚠ **Azure Trusted Signing 要先確認發行主體所在地過不過得了身分驗證。** 它的
public trust 目前只收特定地區的公司／個人（美、加、歐盟、英國一線），發行主體
在台灣的話這條路現在走不了 —— 決定買之前先去確認一次，不要先付錢再發現。

⚠ **簽章要在算 SHA-256 之前。** 簽章會改動 exe 本身，順序顛倒的話清單裡的
雜湊一定對不上，而 `updater.ts` 的症狀是安靜地不更新。

⚠ **Microsoft Store 那條路跟 `updater.ts` 是互斥的。** MSIX 的安裝內容由
Windows 管，程式不能自己換檔 —— 上架就等於把「程式本體的更新」整套交給 Store，
只剩規則表還走我們自己的 `/rules`。要不要換是產品決定，不是打包設定。

### 現在（未簽章）實際能做到不跳的，只有 zip 那條

`.exe` 一定跳，因為 SmartScreen 咬的是「有 MOTW 而且沒信譽」。**zip 可以在
解壓前把 MOTW 拿掉**（右鍵 → 內容 → 解除封鎖），解出來的檔案根本不帶 MOTW，
SmartScreen 沒有東西可以咬。這不是繞過防護，是 Windows 自己給的那顆按鈕。

代價是要玩家多做一步，而且**忘了做就會退回「其他資訊 → 仍要執行」那條路** ——
所以 zip 是主力、下載頁要把那一步寫在最前面，但它不能取代簽章。

⚠ 被 Defender 誤判（跟 SmartScreen 是兩回事）可以送
<https://www.microsoft.com/en-us/wdsi/filesubmission> 申訴。

⚠ 「包成 portable node runtime 用 node.exe 跑」對這個專案不通：托盤是 Electron
（托盤圖示 + 設定視窗），純 node 跑不起來。那條路只有純 CLI 版才有意義。

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

### 另一條發布線：預設 COST 表（WP-17）

插件現在**裝上就有一份規則**（`rules/tomorin-squeeze-band-1C.ulrcost.json`，
`build-tray.mjs` 會複製進安裝包）。它自己會更新，走的是**另一條路由**：

```
   /update  → 程式（82 MB，url + sha256 + 簽章）
   /rules   → 規則（30 KB，**整份帶在清單裡** + 簽章）
```

⚠ **為什麼規則不用 url + sha256。** 安裝檔塞不進清單所以只能給網址；規則包
30 KB，帶著走就少掉一整條路徑 —— 下載、白名單、雜湊比對，以及「清單發出去了
但檔案還沒上傳」那個順序陷阱。簽章直接蓋在內容上。

發一份新規則：

```powershell
# 1. 改規則（插件的「編輯 COST」就行），⚠ 2. 把 version 往上跳
npm run rules:sign -- --file rules/tomorin-squeeze-band-1C.ulrcost.json --notes "一行說明"
npm --workspace apps/link-worker run deploy
```

⚠ **版本沒跳就發不出去**（`sign-rule.mjs` 會擋）。客戶端只往新版走，那是防
重播的那一道 —— 版本相同的規則發了也不會擴散，而且兩邊都沒有錯誤訊息。

⚠ 客戶端還有兩道：**規則族要一樣**（`ruleSetId`），以及**內容要過 schema
才落地**。前者擋的是「一次手滑把所有人的預設規則換成另一族」——
而規則族**進配對鍵**，那會讓整個社群一起換到另一條佇列上。

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
