/**
 * 再開一份自己（多開）
 * ======================
 * 「開新實例」按下去之後發生的事。看起來只是 spawn 一個 process，
 * 但有三個踩過的坑，少一個就會變成「按了沒反應」。
 */

import { spawn } from "node:child_process";
import { app } from "electron";

/**
 * 開一份綁在指定配置上的新實例。
 *
 * ⚠ **坑 1：`ELECTRON_RUN_AS_NODE` 一定要清掉。**
 * 帶著它啟動 Electron，那個 exe 會被當成純 Node 跑，`app` 是 `undefined`，
 * 第一行就炸在 `app.setPath`。而錯訊完全看不出原因。VS Code 的 extension host
 * 會設這個變數，從它底下開的程序全部繼承 —— `docs/launching.md` 的陷阱 1、
 * `scripts/run-tray.mjs` 的檔頭、`cdp-adapter` 的 `ENV_KEYS_TO_STRIP`，
 * 這是同一個坑第四次出現。
 *
 * ⚠ **坑 2：打包前後的參數不一樣。**
 * 打包後 `process.execPath` 就是 ULRCompanion.exe，直接給參數即可；
 * 開發時它是 electron.exe，**第一個參數必須是 main.cjs 的路徑**，否則
 * Electron 不知道要跑哪個 app（症狀是開出一個空白的 Electron 預設視窗）。
 *
 * ⚠ **坑 3：`detached` + `unref`。**
 * 不加的話新實例會變成這一份的子程序，這一份結束時它也跟著死 ——
 * 而「關掉主帳號那個視窗，小號那個也不見了」完全不像是設計行為。
 */
export function launchInstance(profileId: string): void {
  /**
   * ⚠ **`--show` 是必要的，不是選配**（玩家 2026-08-10 回報）。
   *
   * 玩家按「開新實例」的當下就是想看到那個視窗。但「開機縮到托盤」
   * （`startMinimized`）是存在**共用**設定檔裡的，新實例一起來就讀到它，
   * 於是安靜地縮進托盤 —— 從按鈕這一側看就是「按了沒反應」，而托盤圖示
   * 又長得跟原本那個一模一樣，玩家根本分不出它到底開了沒。
   *
   * 這個旗標讓「玩家剛剛親手要求」勝過那個偏好。開機自動啟動走的是
   * `--startup`，不帶這個，所以開機的行為完全不受影響。
   */
  const common = ["--profile", profileId, "--show"];
  const args = app.isPackaged
    ? common
    : // process.argv[1] = dist/main.cjs（scripts/run-tray.mjs 傳進來的）
      [process.argv[1] ?? "", ...common];

  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

/**
 * 開機自動啟動時帶的參數：一律縮到托盤 —— 開機就跳三個視窗出來沒有人會喜歡。
 *
 * ⚠ **寫入與讀取必須用同一份。** 見 `launchAtLoginEnabled()`。
 */
const STARTUP_ARGS = ["--startup"];

/**
 * 隨 Windows 開機啟動。
 *
 * ⚠ **開發時不要真的設下去。** `process.execPath` 在開發時是 node_modules
 * 裡的 electron.exe，把它寫進登錄檔的話，玩家（也就是開發者自己）之後會
 * 得到一個開機就跳出來的空白 Electron 視窗，而且很難聯想到是這裡設的。
 */
export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: STARTUP_ARGS });
}

/**
 * 目前真的有設開機啟動嗎。以系統為準，不是以設定檔為準。
 *
 * ⚠⚠ **`getLoginItemSettings()` 不帶參數問會得到錯的答案。** Windows 上的
 * `openAtLogin` 是「登錄檔裡那一行**字串**跟 `路徑 + args` 完全一樣嗎」，而
 * `args` 的預設值是**空陣列** —— 我們是帶著 `--startup` 寫進去的，所以不帶
 * 參數問一定回 false。
 *
 * 症狀是「打勾打不上去」：登錄檔其實寫成功了，但推回畫面的快照說沒開，
 * 重畫之後勾就彈回來。查的時候會往「IPC 沒通」「權限不足」找，而兩個都不是。
 *
 * `executableWillLaunchAtLogin` 是同一件事的另一個問法：它**忽略參數**，只問
 * 「這個 exe 開機會不會被叫起來」，而且會把工作管理員裡的「已停用」算進去。
 * 兩個都收，是為了不管哪一版 Electron 都不會再退化成「勾不起來」。
 */
export function launchAtLoginEnabled(): boolean {
  if (!app.isPackaged) return false;
  const settings = app.getLoginItemSettings({ args: STARTUP_ARGS });
  return settings.openAtLogin || settings.executableWillLaunchAtLogin;
}
