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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

/**
 * ⚠⚠ **出貨前的最後一道：掃掉「測試會過但 app 開不起來」的東西。**
 *
 * 2026-08-09 真的發生過，而且已經發到 GitHub Release 才被抓到：
 * `update-verify.ts` 為了一個 `canonicalBytes` 去 import `@ulr/rule-schema` 的
 * **根**，而根匯出會把 `validate.ts` 一起帶進來 —— 那支在模組載入時就跑
 *
 *     new URL("../schema/…json", import.meta.url)
 *
 * ESM 底下沒問題，**打成 CJS 之後 `import.meta.url` 是 `undefined`**，
 * `new URL(path, undefined)` 直接丟 `TypeError: Invalid URL`，而且是在
 * 主程序載入時 —— 玩家看到的是一個 JavaScript error 對話框，插件完全打不開。
 *
 * **476 個測試全部綠的。** 因為 vitest 跑的是 ESM 原始碼，而出貨的是這支
 * 產生的 CJS bundle —— 兩個不同的世界。單元測試在設計上就照不到這裡。
 *
 * 所以這道關卡不是「防禦性寫作」，是那次事故的直接產物。
 */
const bundle = readFileSync(join(out, "main.cjs"), "utf8");
const landmines = [
  // esbuild 把 CJS 裡的 import.meta 換成一個空物件，於是 .url 是 undefined
  ["import_meta.url", "有模組在載入時用 import.meta.url —— CJS 打包後那是 undefined"],
];
const hits = landmines.filter(([needle]) => bundle.includes(needle));
if (hits.length > 0) {
  console.error("");
  console.error("✗ bundle 裡有會讓 app 開不起來的東西：");
  for (const [needle, why] of hits) console.error(`    ${needle} —— ${why}`);
  console.error("");
  console.error("  多半是 import 到某個 package 的**根**，把不需要的模組一起拖進來了。");
  console.error("  改成 import 子路徑（例如 @ulr/rule-schema/canonical）。");
  process.exit(1);
}

// 畫面是靜態檔案，直接複製過去 —— 沒有需要編譯的東西。
cpSync(join(app, "renderer"), join(out, "renderer"), { recursive: true });

/**
 * 預設 COST 表。**烤進安裝包，離線也一定有一份。**
 *
 * ⚠ 這是那份規則的**唯一來源**（`rules/` 底下那個檔）—— 中間人發的那一份也是
 * 從同一個檔簽出來的（`scripts/sign-rule.mjs`）。複製而不是各留一份，是因為
 * 「安裝包裡的規則」與「發下去的規則」內容不同時，症狀是**兩個玩家的預設規則
 * 不一樣卻都寫著同一個版本號** —— 而那正是配對驗算會擋、但畫面上完全看不出來
 * 的那種問題。
 */
const DEFAULT_RULE_SOURCE = join(root, "rules", "tomorin-squeeze-band-1C.ulrcost.json");
if (!existsSync(DEFAULT_RULE_SOURCE)) {
  console.error(`✗ 找不到預設 COST 表：${DEFAULT_RULE_SOURCE}`);
  console.error("  它是安裝包的一部分，缺了的話玩家裝上去會沒有規則。");
  process.exit(1);
}
mkdirSync(join(out, "rules"), { recursive: true });
cpSync(DEFAULT_RULE_SOURCE, join(out, "rules", "default.ulrcost.json"));

console.log(`✓ 托盤已打包到 ${out}`);
