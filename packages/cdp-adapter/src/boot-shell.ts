/**
 * 免 Steam 啟動：在客戶端重建官方的 HTML 外殼
 * =============================================
 * 移植自 Greasyfork #522688「ULR steam」v2.2.17，機制相同，但**不需要竄改猴**。
 *
 * 為什麼這件事可行（2026-07-30 實測確認）：
 *
 *   403 Forbidden 只發生在 **HTML 文件本身**。同源的靜態資源 —— 三個 webpack
 *   bundle 與 style-steam.css —— 照常供應，沒有任何限制。所以只要在瀏覽器端
 *   把伺服器原本會吐的那個外殼重建一次，遊戲就能正常開起來。
 *
 * 對照過正常 Steam 流程載入的頁面，外殼就是這幾樣東西：
 *
 *     window.SERVER = "steam"
 *     window.auth_string = <網址上的 steamid>
 *     <link rel=stylesheet href="stylesheets/style-steam.css">
 *     <canvas id="myCustomCanvas" width=760 height=680>
 *     依序注入 client/runtime.<hash>.js → unlight-common.<hash>.js → main.<hash>.js
 *
 * ⚠ **token 沒有被用到。** 外殼只讀 `steamid`。這就是書籤能重複開的原因 ——
 * steamid 不會過期，而 Steam 流程每次發的那顆 token 只是拿來換第一次連線的。
 * 也因此這裡產生的東西**不含任何機密**：steamid 是從網址讀的，不嵌在腳本裡。
 *
 * 兩條在這裡特別要守的規則：
 *
 * 1. **bundle 檔名是資料，不是常數。** webpack 的 content hash 每次改版都會變，
 *    寫死就會跟著壞（上游腳本正是因此得每週發新版）。這裡一律由呼叫端傳進來，
 *    來源是 `BUNDLE_DISCOVERY_EXPRESSION` 從**玩家自己跑著的客戶端**讀出來的。
 *
 *    ⚠ **不要以為 `script.onerror` 能偵測過期。** 2026-07-30 社群（5i）指出，
 *    伺服器不會刪掉舊的 bundle，所以拿舊 hash 去要仍然是 200，只是拿到舊版的
 *    程式碼 —— 改版後最可能的結果是**靜默跑在舊版**，而不是報錯。
 *    實測也確認伺服器沒有任何可用來自動比對版本的公開來源：
 *
 *        /asset-manifest.json  404      /client/       404（沒有目錄列表）
 *        /version.json         404      /index.html    404
 *
 *    無 hash 的 `/client/main.js`、`/client/runtime.js` 雖然回 200，但那是
 *    **dev build**（檔頭寫著 eval-source-map devtool、大小也對不上），不能用。
 *
 *    結論：唯一的真相來源是一次真正的 Steam 流程頁面載入。所以 companion 的
 *    做法是**主動去開一次 Steam 版**把檔名讀回來（見 `boot.ts` 的
 *    `refreshBundles`），而不是假裝能偵測過期。
 * 2. **伺服器有正常吐頁面時絕對不能動手。** 注入是掛在 target 上的，正常 Steam
 *    流程開的分頁也會跑到。重建一次就會把已經載好的遊戲砍掉重來。所以動手前
 *    先確認文件裡沒有 `client/` 的 script —— 有就代表伺服器給了真的頁面。
 */

import {
  GAME_BUNDLE_DIR,
  GAME_CANVAS,
  GAME_MAIN_BUNDLE_PREFIX,
  GAME_ORIGIN,
  GAME_PORTS,
  GAME_STYLESHEET,
  GAME_TITLE,
  STEAM_APP_ID,
} from "./constants.js";
import { embedJson } from "./embed.js";

/**
 * 三個 webpack bundle 的路徑，**相對於遊戲來源**，而且順序就是載入順序。
 *
 * 例：`["client/runtime.0e89562b7d68d7d0099f.js", …]`
 *
 * 順序不能亂 —— runtime 必須先於 common 先於 main，這是 webpack 的 chunk
 * 相依關係，不是慣例。
 */
export type GameBundles = readonly string[];

/**
 * 檔名從哪裡來。
 *
 * - `inline`：產生腳本時就嵌進去（CDP 注入、bookmarklet 用）。
 * - `dataset`：執行期從 `document.documentElement.dataset.ulrBundles` 讀。
 *   擴充功能用這個 —— 它的檔名存在 `chrome.storage`，是每次從 Steam 開遊戲時
 *   自己更新的，不能在打包時就固定死。
 */
export type BundlesSource = "inline" | "dataset";

export interface BootShellOptions {
  /** `bundlesSource` 是 `inline`（預設）時必填。 */
  bundles?: GameBundles;
  bundlesSource?: BundlesSource;
  /**
   * 網址沒帶 port 時要不要自己導向 `origin:1401X`。
   *
   * CDP 與擴充功能可以（注入會在導向後的新 document 再跑一次）；
   * bookmarklet 不行 —— 導向會把它的執行環境整個換掉，使用者得再點一次。
   */
  allowPortRedirect?: boolean;
}

/** 擴充功能用來傳遞檔名的 dataset 鍵（`data-ulr-bundles`）。 */
export const BUNDLES_DATASET_KEY = "ulrBundles";

/**
 * 擴充功能用來傳遞身分的 dataset 鍵（`data-ulr-auth`）。
 *
 * 有了它，書籤就不必寫死 steamid —— 擴充功能在看到 Steam 流程的真頁面時
 * 會順手記下來。這是「別人也能用」的關鍵：否則每個人都得自己拼一個
 * 帶自己 steamid 的網址，而多數人根本不知道去哪裡找那串數字。
 */
export const AUTH_DATASET_KEY = "ulrAuth";

/** `chrome.storage.local` 裡存檔名的鍵。 */
export const STORAGE_KEY = "ulrBundles";

export class InvalidBundleError extends Error {
  override readonly name = "InvalidBundleError";
  constructor(reason: string) {
    super(`bundle 清單不合法：${reason}`);
  }
}

// ---------------------------------------------------------------------------
// 從活著的客戶端讀出 bundle 檔名
// ---------------------------------------------------------------------------

/**
 * 在**正常 Steam 流程開起來的遊戲分頁**上求值，得到目前這個版本的 bundle 清單。
 *
 * 只取同源、位在 `client/` 底下的 script，並轉成相對路徑 —— 這樣擴充功能與
 * bookmarklet 拿到的東西跟 port 無關（遊戲每次開在 14012~14021 之間的隨機 port）。
 *
 * 順序沿用 `document.scripts` 的順序，也就是實際的載入順序。
 */
export const BUNDLE_DISCOVERY_EXPRESSION = `(function () {
  var out = [];
  var scripts = document.scripts;
  for (var i = 0; i < scripts.length; i++) {
    var src = scripts[i].src;
    if (!src) continue;
    var u;
    try { u = new URL(src); } catch (e) { continue; }
    if (u.origin !== location.origin) continue;
    var path = u.pathname.replace(/^\\//, "");
    if (path.indexOf(${JSON.stringify(GAME_BUNDLE_DIR)}) !== 0) continue;
    out.push(path);
  }
  return JSON.stringify(out);
})()`;

/**
 * 驗證從頁面讀回來的東西真的是一份 bundle 清單。
 *
 * 頁面是外部輸入 —— 玩家可能裝了別的擴充功能在同源塞 script，也可能遊戲改版
 * 換了目錄結構。與其之後在別處炸掉，不如在邊界擋下來。
 */
export function parseDiscoveredBundles(value: unknown): GameBundles {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) {
    throw new InvalidBundleError("不是陣列");
  }
  const bundles: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new InvalidBundleError(`有一筆不是非空字串：${String(item)}`);
    }
    if (!item.startsWith(GAME_BUNDLE_DIR)) {
      throw new InvalidBundleError(`「${item}」不在 ${GAME_BUNDLE_DIR} 底下`);
    }
    if (item.includes("..") || item.startsWith("/") || item.includes("://")) {
      // 相對路徑會被當成同源資源載入。允許跳脫就等於允許載入任意來源的程式碼。
      throw new InvalidBundleError(`「${item}」不是單純的相對路徑`);
    }
    bundles.push(item);
  }
  if (bundles.length === 0) {
    throw new InvalidBundleError("一個都沒有（這個分頁可能還沒載完，或根本不是遊戲頁）");
  }
  if (!isCompleteBundleSet(bundles)) {
    // ⚠ 這是實際發生過的事故，不是理論上的顧慮：2026-08-02 一份只有
    // runtime 的清單被存進擴充功能的 storage，之後每次用書籤開都只載到
    // runtime，畫面全白。原因見 GAME_MAIN_BUNDLE_PREFIX 的說明。
    throw new InvalidBundleError(
      `沒有 ${GAME_BUNDLE_DIR}${GAME_MAIN_BUNDLE_PREFIX}* —— 這是一份載到一半的清單。` +
        "多半是從「被重建過的頁面」讀的（重建是一個一個非同步接 script）。" +
        "要從**伺服器真的吐出頁面**的那次載入讀，也就是正常 Steam 流程開的分頁。",
    );
  }
  return bundles;
}

/**
 * 這份清單看起來是不是完整的一份。
 *
 * 判準是「有沒有 main.」而不是「有沒有三個」—— 數量是會變的實作細節，
 * 而載入順序的最後一個到齊才代表真的載完了。
 */
export function isCompleteBundleSet(bundles: readonly string[]): boolean {
  const prefix = GAME_BUNDLE_DIR + GAME_MAIN_BUNDLE_PREFIX;
  return bundles.some((b) => b.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 產生外殼重建腳本
// ---------------------------------------------------------------------------

/**
 * 產生要在 `document-start` 執行的外殼重建腳本。
 *
 * 純函式，沒有副作用 —— 所以可以完整測試，不需要活著的遊戲。
 * CDP 注入、Chrome 擴充功能、bookmarklet 三種形態都用這一份。
 */
export function buildBootShellScript(options: BootShellOptions = {}): string {
  const source = options.bundlesSource ?? "inline";
  // dataset 模式打包時還不知道檔名，所以只有 inline 模式驗證。
  const bundles = source === "inline" ? parseDiscoveredBundles(options.bundles) : null;

  const config = {
    ...(bundles !== null ? { bundles } : {}),
    canvasId: GAME_CANVAS.id,
    canvasWidth: GAME_CANVAS.width,
    canvasHeight: GAME_CANVAS.height,
    stylesheet: GAME_STYLESHEET,
    title: GAME_TITLE,
    portMin: GAME_PORTS.quest[0],
    portMax: GAME_PORTS.quest[1],
    allowPortRedirect: options.allowPortRedirect ?? true,
  };

  const bundlesExpr =
    source === "inline"
      ? "CFG.bundles"
      : `JSON.parse(document.documentElement.dataset.${BUNDLES_DATASET_KEY} || "[]")`;

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var BUNDLES = ${bundlesExpr};
  var FLAG = "__ulrBootShell";

  // 注入會在這個 target 的每個 document 跑，導向之後也會再跑一次。
  // 沒有這道閘就會重複建 canvas、重複注入 bundle。
  if (window[FLAG]) return;

  var params = new URLSearchParams(location.search);
  // 網址沒帶身分時退回擴充功能記下來的那個，這樣書籤不必寫死 steamid。
  var authString =
    params.get("steamid") ||
    params.get("stove_id") ||
    document.documentElement.dataset.${AUTH_DATASET_KEY} ||
    "";

  // 兩邊都沒有就別碰這個頁面。
  if (!authString) return;

  window[FLAG] = { rebuilt: false };

  // 遊戲實際跑在 :14012~14021 的其中一個 port，沒帶 port 的網址會拿到 403。
  if (location.port === "" && CFG.allowPortRedirect) {
    var span = CFG.portMax - CFG.portMin + 1;
    var port = CFG.portMin + Math.trunc(Math.random() * span);
    location.href =
      location.protocol + "//" + location.hostname + ":" + port +
      location.pathname + location.search + location.hash;
    return;
  }

  window.SERVER = "steam";
  window.platform_type = location.pathname.indexOf("stove") !== -1 ? "stove" : "steam";
  window.auth_string = authString;

  function alreadyServed() {
    // 伺服器有正常吐頁面的時候（正常 Steam 流程），文件裡本來就有 client/ 的
    // script。這時候動手會把已經載好的遊戲砍掉重來。
    return document.querySelector('script[src*="' + BUNDLES[0] + '"]') !== null ||
           document.querySelector('script[src*="/client/"]') !== null;
  }

  function loadNext(i) {
    if (i >= BUNDLES.length) return;
    var s = document.createElement("script");
    s.src = BUNDLES[i];
    s.onload = function () { loadNext(i + 1); };
    s.onerror = function () {
      // ⚠ 這裡**不要**宣稱「遊戲改版了」。onerror 只在檔案真的不存在時觸發，
      // 而伺服器會保留舊的 bundle（社群實測），所以改版後最可能的結果是
      // 靜默跑在舊版，根本不會走到這裡。詳見檔案開頭的說明。
      var msg = document.createElement("div");
      msg.style.cssText = "color:#f66;font:14px/1.6 monospace;padding:16px";
      msg.style.whiteSpace = "pre-wrap";
      msg.textContent = "載入失敗：" + BUNDLES[i] + "\\n請重新同步 bundle 檔名後再試。";
      document.body.appendChild(msg);
    };
    document.head.appendChild(s);
  }

  function rebuild() {
    if (alreadyServed()) return;
    // dataset 模式下檔名是執行期給的。給不出來就什麼都別做 —— 清空 body 卻又
    // 沒有東西可載，只會留下一片白畫面，比原本的 403 更難懂。
    if (BUNDLES.length === 0) return;

    document.body.textContent = "";
    document.title = CFG.title;

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = CFG.stylesheet;
    document.head.appendChild(css);

    var canvas = document.createElement("canvas");
    canvas.id = CFG.canvasId;
    canvas.width = CFG.canvasWidth;
    canvas.height = CFG.canvasHeight;
    document.body.appendChild(canvas);

    window[FLAG].rebuilt = true;
    loadNext(0);
  }

  // document-start 時 body 還不存在。403 的錯誤頁也要等解析完才知道有沒有
  // client/ 的 script，所以一律等 DOMContentLoaded。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rebuild);
  } else {
    rebuild();
  }
})();`;
}

// ---------------------------------------------------------------------------
// 三種輸出形態
// ---------------------------------------------------------------------------

/** 書籤要指向的網址。帶 port，這樣 bookmarklet 不必先導向就能直接用。 */
export function buildBookmarkUrl(steamId: string, origin: string, port?: number): string {
  const span = GAME_PORTS.quest[1] - GAME_PORTS.quest[0] + 1;
  const chosen = port ?? GAME_PORTS.quest[0] + Math.trunc(Math.random() * span);
  return `${origin}:${chosen}/?steamid=${encodeURIComponent(steamId)}`;
}

/**
 * `javascript:` 書籤。
 *
 * ⚠ bookmarklet 沒辦法在 `document-start` 跑 —— 它是使用者在頁面載完之後
 * 手動點的。對這個場景剛好沒差：403 頁面上沒有任何 script，沒有東西需要
 * 搶在它前面。代價是要點兩下（開書籤 → 看到 403 → 點 bookmarklet）。
 */
export function buildBookmarklet(bundles: GameBundles): string {
  const script = buildBootShellScript({ bundles, allowPortRedirect: false });
  return "javascript:" + encodeURIComponent(script);
}

export interface ExtensionOptions {
  version?: string;
  origin?: string;
}

/**
 * 產生一個會**自己更新**的 Chrome 擴充功能（未封裝，用「載入未封裝項目」安裝）。
 *
 * 這是整套裡唯一不需要 companion 的形態。關鍵想法：
 *
 *   玩家從 Steam 開遊戲的時候，這個擴充功能也在同一個瀏覽器裡跑，而那個頁面
 *   是**伺服器給的真貨** —— 上面就有當前版本的 bundle 檔名。所以在那時候順手
 *   記進 `chrome.storage.local`，之後書籤模式再讀出來用。
 *
 * 於是遊戲改版後不必重新打包、不必按重新載入：只要玩家偶爾用 Steam 開一次，
 * 檔名就自己更新了。**沒有任何「偵測過期」的假承諾** —— 就是每次真的載入時
 * 順手記下來而已。
 *
 * 為什麼要拆成兩個檔案而不是一支 MAIN world 的 content script：
 * MAIN world 裡**沒有 `chrome.*` API**，讀不到 storage。所以由 isolated world 的
 * `content.js` 負責 storage，再把檔名放進 `dataset` 並注入 `shell.js` ——
 * `shell.js` 用 `<script src>` 載入，自然就跑在頁面的世界裡，設得到 `window.SERVER`。
 */
export function buildExtensionFiles(options: ExtensionOptions = {}): Record<string, string> {
  const origin = options.origin ?? GAME_ORIGIN;
  const host = new URL(origin).hostname;
  // Chrome 的 match pattern 不比對 port，所以這條涵蓋 :14012~14021 全部。
  const matches = [`https://${host}/*`];

  const manifest = {
    manifest_version: 3,
    name: "ULR Boot",
    version: options.version ?? "1.0.0",
    description: "免 Steam 開啟 UNLIGHT:Revive 網頁版（由 ulr-companion 產生）",
    permissions: ["storage"],
    content_scripts: [
      {
        matches,
        run_at: "document_start",
        js: ["content.js"],
      },
    ],
    // shell.js 要能被頁面用 <script src> 載入，所以必須是 web accessible。
    web_accessible_resources: [{ resources: ["shell.js"], matches }],
  };

  return {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "content.js": buildExtensionContentScript(),
    "shell.js": buildBootShellScript({ bundlesSource: "dataset", allowPortRedirect: true }),
    "README.txt": buildExtensionReadme(origin),
  };
}

/**
 * 給**拿到這個資料夾的人**看的說明。
 *
 * 幾個刻意的選擇：
 *
 * - **`.txt` 不是 `.md`**：Windows 上 `.md` 沒有預設程式，雙擊會跳出
 *   「要用什麼開啟」。`.txt` 直接進記事本。
 * - **純文字、沒有 Markdown 語法**：既然不會被算繪，`#` 和反引號只是雜訊。
 * - **CRLF + BOM**：舊版記事本讀到單純的 LF 會把全部擠成一行；中文沒有 BOM
 *   在某些工具裡會變亂碼。這個檔案是要傳給不特定的人的，容錯比乾淨重要。
 *
 * 內容是給玩家看的，不是給維護者看的 —— 不提 companion、不提 repo，
 * 也不能出現任何本機路徑或別人的 steamid（`buildExtensionFiles` 的測試會擋）。
 */
export function buildExtensionReadme(origin: string = GAME_ORIGIN): string {
  const body = `ULR Boot ── 用書籤開 UNLIGHT:Revive 網頁版
================================================

不用每次都透過 Steam，點一下書籤就進遊戲。


它做什麼
────────
網頁版的遊戲網址直接用瀏覽器開，會看到 403 Forbidden：伺服器不把那頁
HTML 給一般瀏覽器。但同一個網站的 JavaScript 和 CSS 都是照常供應的。

這個擴充功能就是在那個 403 頁面上，把伺服器原本會給的外殼在瀏覽器端
重建一次，然後照原本的順序載入遊戲程式。

它不繞過任何驗證，也沒有用到 Steam 的 token。遊戲需要的身分只是你的
SteamID，那個不會過期。


安裝
────
  1. 網址列輸入   chrome://extensions
  2. 右上角打開「開發人員模式」
  3. 按左上角「載入未封裝項目」，選這個資料夾

開發人員模式是必要的 —— Chrome 不允許用其他方式安裝未上架的擴充功能。
（竄改猴那類工具也有同樣要求。）


第一次使用
──────────
裝好之後，先從 Steam 正常開一次遊戲（網頁版）。

遊戲載入的時候，這個擴充功能會在背景記下當前版本用到的檔案清單和你的
身分。它只是記錄，不會改動畫面，你照常玩就好。

然後把這個網址存成書籤：

    ${origin}/

不用加任何參數。之後點書籤就會直接進遊戲。


遊戲更新之後
────────────
遊戲每週會更新，程式檔名跟著改變。這時候用書籤開，畫面上方會出現一條
黃色提示，按上面的「開啟 Steam 更新」：

  1. Steam 開啟遊戲
  2. 擴充功能記下新版本的檔案清單
  3. 原本那個分頁會自己重新載入，遊戲就起來了

按鈕是免不了的 —— 瀏覽器不允許網頁在沒有使用者點擊的情況下啟動外部
程式。第一次會問「要開啟 Steam 嗎？」，勾「一律允許」之後就不再問。

※ 老實說：沒辦法真正偵測版本過期。舊版的程式檔案伺服器不會刪除，所以
  用舊清單開起來也不會報錯，只是會跑在舊版上。那條黃色提示是依更新
  時程推算的，不是驗證過的結果 —— 所以它的措辭是「可能是舊版」。
  換句話說，沒看到黃條不代表你一定是最新版。


遇到問題
────────
點書籤只看到 403，什麼都沒發生
    擴充功能沒有裝在這個瀏覽器設定檔裡。每個設定檔都要各裝一次。

黃條一直在，按了也沒用
    從 Steam 開起來的遊戲必須落在同一個瀏覽器裡，擴充功能才記得到。
    如果你的預設瀏覽器不是這一個，Steam 會把遊戲開到別的瀏覽器去。

按了按鈕，遊戲開在自己的視窗裡
    你目前啟用的是桌面版客戶端，它不經過瀏覽器，這條路收不到檔案
    清單。要改用網頁版客戶端才行。


隱私
────
你的 SteamID 和程式檔名只存在這個瀏覽器本機（chrome.storage.local），
不會傳到任何地方。這個擴充功能沒有任何對外連線，也不碰 Steam 的登入
token。
`;

  // BOM + CRLF：見上面的說明。
  return "﻿" + body.replace(/\n/g, "\r\n");
}

/**
 * 擴充功能的 isolated world 部分：管 storage，並決定要記錄還是要重建。
 *
 * 兩種頁面走兩條路：
 *   - 伺服器給了真頁面（Steam 流程）→ 把檔名記起來，**不碰畫面**
 *   - 403（書籤）→ 把記下來的檔名放進 dataset，注入 shell.js
 */
export function buildExtensionContentScript(): string {
  const config = {
    storageKey: STORAGE_KEY,
    datasetKey: BUNDLES_DATASET_KEY,
    authDatasetKey: AUTH_DATASET_KEY,
    bundleDir: GAME_BUNDLE_DIR,
    // 判斷清單完不完整用的。見 constants.ts 的 GAME_MAIN_BUNDLE_PREFIX。
    mainPrefix: GAME_MAIN_BUNDLE_PREFIX,
    // 觀測到的部署時間：每週二 02:02 GMT。用來推算快取可能過期 —— 這是
    // **依時程推算**，不是驗證過的，訊息措辭必須誠實。
    deployWeekday: 2,
    deployUtcHour: 2,
    steamUrl: `steam://rungameid/${STEAM_APP_ID}`,
    // 按下按鈕後等多久還沒等到更新，就改口提示可能是客戶端模式不對。
    waitAfterLaunchMs: 90_000,
  };

  return `(function () {
  "use strict";
  var CFG = ${JSON.stringify(config)};

  function currentBundles() {
    var out = [];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (!src) continue;
      var u;
      try { u = new URL(src); } catch (e) { continue; }
      if (u.origin !== location.origin) continue;
      var p = u.pathname.replace(/^\\//, "");
      if (p.indexOf(CFG.bundleDir) !== 0) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * 這份清單是不是完整的一份。
   *
   * ⚠ 這道檢查是 2026-08-02 的事故補上的，不是防禦性程式碼：外殼重建
   * （CDP 注入或下面的 shell.js）是**一個一個非同步接** script 的，所以在
   * 重建頁上掃 document.scripts 隨時可能只看到 runtime。少了這道檢查，
   * 那份殘缺清單會被當成「伺服器給的真貨」存進 storage，蓋掉好的那份 ——
   * 之後每次用書籤開都只載得到 runtime，畫面全白，而且完全看不出哪裡壞了。
   *
   * 判準是「有沒有 main.」而不是數量：載入順序的最後一個到齊才代表載完。
   */
  function looksComplete(list) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).indexOf(CFG.bundleDir + CFG.mainPrefix) === 0) return true;
    }
    return false;
  }

  /** 最近一次「應該已經部署」的時間點。 */
  function lastDeploy(now) {
    var d = new Date(now.getTime());
    d.setUTCHours(CFG.deployUtcHour, 5, 0, 0);
    while (d.getUTCDay() !== CFG.deployWeekday || d.getTime() > now.getTime()) {
      d.setUTCDate(d.getUTCDate() - 1);
      d.setUTCHours(CFG.deployUtcHour, 5, 0, 0);
    }
    return d;
  }

  /**
   * 黃條。可以帶一顆「開啟 Steam」按鈕。
   *
   * ⚠ 為什麼一定要按鈕、不能自動導向 steam://：瀏覽器對外部協定強制要求
   * user gesture，這是防止網頁隨意啟動本機程式的安全機制，擴充功能沒有豁免。
   * 沒有點擊的話 Chrome 會直接吞掉，而且不會有任何錯誤 —— 那比要求點一下更糟。
   */
  function notice(text, withButton) {
    var el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:8px 12px;" +
      "background:#3a2a00;color:#ffd479;font:13px/1.5 sans-serif;white-space:pre-wrap";
    var span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);

    if (withButton) {
      var btn = document.createElement("button");
      btn.textContent = "開啟 Steam 更新";
      btn.style.cssText =
        "margin-left:12px;padding:3px 10px;border:1px solid #ffd479;border-radius:4px;" +
        "background:transparent;color:#ffd479;font:inherit;cursor:pointer";
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "已送出，等遊戲載入…";
        location.href = CFG.steamUrl;
        setTimeout(function () {
          span.textContent =
            "等不到更新。若你目前啟用的是桌面版客戶端（遊戲開在自己的視窗、" +
            "不經過瀏覽器），這條路就收不到檔案清單 —— 要先換成網頁版客戶端。";
          btn.disabled = false;
          btn.textContent = "再試一次";
        }, CFG.waitAfterLaunchMs);
      });
      el.appendChild(btn);
    }
    document.body.appendChild(el);
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    var params = new URLSearchParams(location.search);
    var urlAuth = params.get("steamid") || params.get("stove_id") || "";

    var served = currentBundles();
    if (served.length > 0) {
      // 有 client/ script 不等於「伺服器給了真頁面」—— 被重建過的頁面也有，
      // 只是它們是非同步一個一個接上去的，現在看到的可能只是載到一半。
      // 拿那種清單去覆寫，就會把好的那份蓋掉。
      if (!looksComplete(served)) return;

      // 伺服器給了真的頁面 —— 這是唯一可靠的真相來源，記下來就好，不要動畫面。
      // 身分也一起記：這樣書籤不必寫死 steamid，換一台機器、換個人都能用。
      var rec = {};
      rec[CFG.storageKey] = {
        bundles: served,
        auth: urlAuth,
        discoveredAt: new Date().toISOString()
      };
      chrome.storage.local.set(rec);
      return;
    }

    chrome.storage.local.get(CFG.storageKey, function (data) {
      var rec = data && data[CFG.storageKey];
      var known = rec && rec.bundles ? rec.bundles.join(",") : "";

      // 按了按鈕之後，遊戲會在另一個分頁載入、由那邊的 content script 記下
      // 新檔名。這裡等 storage 一變就自己重載 —— 使用者不必回來手動 F5。
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes[CFG.storageKey]) return;
        var next = changes[CFG.storageKey].newValue;
        if (!next || !next.bundles) return;
        if (next.bundles.join(",") === known) return;
        location.reload();
      });

      var auth = urlAuth || (rec && rec.auth) || "";

      if (!rec || !rec.bundles || rec.bundles.length === 0 || !auth) {
        notice(
          "ULR Boot：還沒有這個版本的檔案清單。需要從 Steam 開一次遊戲來取得。",
          true
        );
        return;
      }

      // 存進去的東西也可能是殘缺的（舊版本沒有上面那道寫入檢查，storage 會
      // 留著壞資料）。與其靜靜載出一片白畫面，不如講清楚發生什麼事。
      if (!looksComplete(rec.bundles)) {
        notice(
          "ULR Boot：記到的檔案清單不完整（只有 " + rec.bundles.length + " 個，缺 " +
          CFG.mainPrefix + "*）。這是舊版留下的壞資料，重新從 Steam 開一次即可覆蓋。",
          true
        );
        return;
      }

      if (rec.discoveredAt && new Date(rec.discoveredAt) < lastDeploy(new Date())) {
        // 措辭要保守：我們無法驗證是否過期，只知道記錄的時間早於上一次
        // 例行部署時間。舊 bundle 伺服器不會刪，所以真的過期也不會報錯。
        notice(
          "ULR Boot：這份檔案清單記錄於上一次例行更新之前，可能是舊版。" +
          "（無法確認 —— 舊版檔案伺服器仍會供應。）",
          true
        );
      }

      document.documentElement.dataset[CFG.datasetKey] = JSON.stringify(rec.bundles);
      document.documentElement.dataset[CFG.authDatasetKey] = auth;
      var s = document.createElement("script");
      s.src = chrome.runtime.getURL("shell.js");
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    });
  });
})();`;
}
