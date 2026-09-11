/**
 * 啟動托盤程式。
 *
 * ⚠⚠ **這支存在的唯一理由是 `ELECTRON_RUN_AS_NODE`。**
 *
 * 那個環境變數會讓 Electron 的 exe 被當成**純 Node** 執行 —— 於是
 * `require("electron")` 拿到的是 npm 那個只回傳執行檔路徑的殼，
 * `app` 是 `undefined`，第一行就炸：
 *
 *     TypeError: Cannot read properties of undefined (reading 'setPath')
 *
 * 而錯訊完全看不出真正的原因。認得出來的線索只有堆疊裡的
 * `node:electron/js2c/node_init`（正常是 `browser_init`）。
 *
 * **VS Code 的 extension host 會設這個變數**，從它的終端機跑 npm script 就會
 * 繼承到。`constants.ts` 的 `ENV_KEYS_TO_STRIP` 早就為了「插件自己開遊戲」
 * 記過同一個坑 —— 2026-08-06 我們自己的 Electron 也踩了一次。
 *
 * 用法：
 *
 *     npm run tray                        **Chrome**（不帶參數時的預設，見下）
 *     npm run tray -- --kind edge         Edge
 *     npm run tray -- --kind desktop      桌面版
 *     npm run tray -- --profile <id>      指定某一份配置
 *     npm run tray -- --port 59222        相容用法：對得上就用那份，對不上開臨時的
 *
 * 兩份可以同時開，各管一個客戶端（`apps/tray/src/main.ts` 檔頭說明了為什麼
 * 這件事在 Electron 上需要特別處理）。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
if (typeof electron !== "string") {
  console.error("✗ 找不到 Electron 執行檔。試試 npm install --force electron");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
// ⚠ 見檔頭。少了這一行，從 VS Code 的終端機跑起來一定失敗。
delete env["ELECTRON_RUN_AS_NODE"];

/**
 * ⚠ **不帶參數 = Chrome。** 這只影響開發時的 `npm run tray` —— 打包版不經過
 * 這支，它的預設仍然是清單第一份（新安裝就是桌面版）。
 *
 * 理由是開發機上幾乎一定同時有一份**安裝版**在跑（開機自動啟動、綁桌面版
 * :59222）。開發版要是也預設接桌面版，`main.ts` 的 `requestSingleInstanceLock()`
 * 會直接把它擋掉 —— 而那不是報錯，是**安靜地退出並把安裝版的視窗叫出來**：
 * 看起來就像「我改的東西完全沒生效」，因為接著遊戲的自始至終是舊的那一份。
 *
 * 已經自己講清楚要開哪一份的（`--profile` / `--port` / `--kind`）就照他說的。
 */
const argv = process.argv.slice(2);
const picked = ["--profile", "--port", "--kind"].some((f) => argv.includes(f));
const args = picked ? argv : ["--kind", "chrome", ...argv];

const child = spawn(electron, [join(root, "apps", "tray", "dist", "main.cjs"), ...args], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
