/**
 * 打包成 Windows 安裝檔（WP-08）
 * ===============================
 * `docs/release.md` 的落地。跑 `npm run dist`，產出在 `out/release/`。
 *
 * ```
 *   apps/tray/src ──esbuild──▶ apps/tray/dist ──┐
 *                                                ├──▶ out/app ──▶ NSIS 安裝檔
 *   程式現畫的圖示 ─────────▶ out/app/icon.ico ─┘
 * ```
 *
 * ⚠ **為什麼要先搬到 `out/app` 而不是直接打包 `apps/tray`：**
 * 這是 npm workspaces 的 monorepo，`apps/tray/package.json` 的 dependencies
 * 是三個 `@ulr/*` workspace 套件，版本寫 `"*"`。electron-builder 會試著把
 * 它們當成真的 npm 套件解析並複製進 asar —— 而它們根本沒發布，解析一定失敗。
 *
 * 實際上**執行期一個都不需要**：esbuild 已經把整棵相依樹打進 `main.cjs`
 * （`build-tray.mjs` 的檔頭說明了為什麼是 esbuild 不是 tsc）。所以這裡另外寫
 * 一份**沒有 dependencies** 的 package.json，讓 electron-builder 沒有東西可解析。
 *
 * ⚠ **圖示是現畫的，repo 裡沒有 .ico 檔。** 理由跟 `icon.ts` 檔頭一樣：
 * 不放官方美術，也不放二進位檔進版控。ICO 直接包一張 PNG（Vista 以後支援），
 * 所以三行就寫得完，不需要任何影像處理相依。
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// ⚠ 這支要用 tsx 跑（package.json 的 dist script），才 import 得動 .ts。
// 圖示的程式碼只有一份 —— 不要為了打包再抄一次那 40 行的 PNG 編碼器。
import { trayIconPng } from "../apps/tray/src/icon.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "out", "app");
const release = join(root, "out", "release");

// --- 1. 先 build（跟 npm run tray 跑的是同一支） ---------------------------
const built = spawnSync(process.execPath, [join(root, "scripts", "build-tray.mjs")], {
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

// --- 2. 搬到乾淨的 staging 目錄 --------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "apps", "tray", "dist"), join(stage, "dist"), { recursive: true });

const trayPkg = JSON.parse(readFileSync(join(root, "apps", "tray", "package.json"), "utf8"));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "ulr-companion",
      productName: "ULR Companion",
      version: trayPkg.version,
      description: trayPkg.description,
      license: trayPkg.license,
      // 沒有這個 electron-builder 會抱怨，而且它會變成安裝檔的「發行者」。
      author: "UnlightPlugin",
      // ⚠ 不是 "module"。打包出來的是 CJS（見 build-tray.mjs：preload 在
      // sandbox 下只吃 CommonJS，而 __dirname 在 ESM 裡不存在）。
      main: "dist/main.cjs",
      // ⚠ 刻意留空。見檔頭 —— 有了它 electron-builder 會去解析 @ulr/*。
      dependencies: {},
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

// --- 3. 現畫圖示 -----------------------------------------------------------
/**
 * 把一張 PNG 包成 ICO。
 *
 * ICO 的目錄項用 1 個 byte 存邊長，所以 **256 要寫成 0**（規格如此）。
 * 寫 256 會被讀成「寬度 0」，Windows 直接把整個檔案當成壞的。
 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // 幾張圖
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // ⚠ 見上面
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // 調色盤色數（真彩色是 0）
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

/**
 * ⚠ **一定要寫到 `build/`，不是 staging 目錄。**
 *
 * electron-builder 的 `win.icon` 是相對 `directories.buildResources`
 * 解析的（預設就是 `build/`），不是相對 `directories.app`。放錯地方的症狀
 * 極度安靜：它不會報錯，只會在 log 裡留一行
 * `default Electron icon is used`，然後產出一個掛著 Electron 預設圖示的安裝檔。
 */
const iconPath = join(root, "build", "icon.ico");
mkdirSync(dirname(iconPath), { recursive: true });
writeFileSync(iconPath, pngToIco(trayIconPng("idle", 256), 256));
console.log(`✓ 圖示已產生 ${iconPath}`);

// --- 4. electron-builder ---------------------------------------------------
//
// ⚠ **直接叫它的 cli.js，不要 spawn `npx` 或 `electron-builder.cmd`。**
// Node 18.20 / 20.12 以後（CVE-2024-27980）不再允許 spawn `.cmd` / `.bat`
// 而不加 `shell: true`。症狀非常安靜：spawnSync 回一個非零的 status，
// **stdout 一個字都沒有** —— 看起來像 electron-builder 靜靜失敗了，
// 但它根本沒被執行到。
const builder = spawnSync(
  process.execPath,
  [
    join(root, "node_modules", "electron-builder", "cli.js"),
    "--win",
    "--config",
    join(root, "electron-builder.yml"),
  ],
  { stdio: "inherit", cwd: root },
);
if (builder.status !== 0) process.exit(builder.status ?? 1);
console.log(`\n✓ 安裝檔在 ${release}`);
