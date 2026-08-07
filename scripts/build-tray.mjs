/**
 * 把托盤程式打包成 Electron 跑得動的東西。
 *
 * 為什麼是 esbuild 而不是 tsc：主程序要 import 四個 workspace package，
 * 而它們的 `main` 指的是 **`.ts` 原始碼**（tsconfig 的 paths 就是為了讓
 * contributor clone 下來不用先 build）。tsc 產出的 JS 會保留那些 import，
 * Electron 執行時解不開。esbuild 直接把整棵樹打成一支檔案，這個問題就不存在。
 *
 * ⚠ **格式必須是 CJS。** Electron 的 preload 在 sandbox 模式下只吃 CommonJS，
 * 而 `__dirname`（main.ts 用它找 preload 與 renderer）在 ESM 裡也不存在。
 * 兩個限制指向同一個答案，不要為了「比較現代」改成 ESM。
 *
 * `electron` 本身要 external —— 它是執行期由 Electron 提供的，打進來會壞掉。
 */

import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps", "tray");
const out = join(app, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/**
 * ⚠ **版本號在這裡烤進去，不要在執行期讀 `app.getVersion()`。**
 *
 * `app.getVersion()` 只有在**打包後**才讀得到我們的 package.json；開發時
 * 它會退回 **Electron 自己的版本**（實測顯示 v38.8.6）。症狀很惡劣：畫面上
 * 有一個看起來很正常的版本號，而它是錯的 —— 玩家回報問題時報那個號碼，
 * 我們會對著一個不存在的版本查。
 */
const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;

await build({
  define: { __ULR_VERSION__: JSON.stringify(version) },
  entryPoints: {
    main: join(app, "src", "main.ts"),
    preload: join(app, "src", "preload.ts"),
  },
  outdir: out,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});

// 畫面是靜態檔案，直接複製過去 —— 沒有需要編譯的東西。
cpSync(join(app, "renderer"), join(out, "renderer"), { recursive: true });
console.log(`✓ 托盤已打包到 ${out}`);
