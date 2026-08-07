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
  const args = app.isPackaged
    ? ["--profile", profileId]
    : // process.argv[1] = dist/main.cjs（scripts/run-tray.mjs 傳進來的）
      [process.argv[1] ?? "", "--profile", profileId];

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
 * 隨 Windows 開機啟動。
 *
 * ⚠ **開發時不要真的設下去。** `process.execPath` 在開發時是 node_modules
 * 裡的 electron.exe，把它寫進登錄檔的話，玩家（也就是開發者自己）之後會
 * 得到一個開機就跳出來的空白 Electron 視窗，而且很難聯想到是這裡設的。
 */
export function setLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // 開機自動啟動時一律縮到托盤 —— 開機就跳三個視窗出來沒有人會喜歡。
    args: ["--startup"],
  });
}

/** 目前真的有設開機啟動嗎。以系統為準，不是以設定檔為準。 */
export function launchAtLoginEnabled(): boolean {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().openAtLogin;
}
