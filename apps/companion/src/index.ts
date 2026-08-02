/**
 * ULR Companion —— 命令列骨架
 * =============================
 * 這裡還不是 Electron app（那是 WP-08，規格書 §10.3 建議 TypeScript +
 * Electron + electron-builder）。目前是一組能對著**活著的遊戲**實際跑的
 * 子指令，用來驗證 `@ulr/cdp-adapter`，不必先做 UI：
 *
 *     npx tsx apps/companion/src/index.ts probe
 *     npx tsx apps/companion/src/index.ts cost <cost.json> [--reload]
 *     npx tsx apps/companion/src/index.ts rule <規則檔.json>
 *
 * 接手 WP-08 的人請從這裡開始，並先讀 docs/open-questions.md。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_SCHEMA_VERSION } from "@ulr/api-contract";
import type { CostOverrides, CostPatchReport } from "@ulr/cdp-adapter";
import {
  ArbiterRunner,
  BROWSER_DEBUG_PORT,
  buildBookmarklet,
  buildBookmarkUrl,
  buildExtensionFiles,
  createCdpAdapter,
  DEBUG_PORT_SWITCH,
  DEFAULT_BROWSER_PROFILE_DIR,
  DEFAULT_DEBUG_PORT,
  DEFAULT_VALUE_EVENTS,
  ensureBrowser,
  GAME_ORIGIN,
  openGameTab,
  refreshBundles,
} from "@ulr/cdp-adapter";
import { assertCostRule, contentHash, loadRulePackage, shortHash } from "@ulr/rule-schema";
import {
  CACHE_PATH,
  NoBundleCacheError,
  readBundleCache,
  writeBundleCache,
} from "./bundle-cache.js";

/** 套用之後等頁面回報的時間。cc_asset 在載入序列偏後面。 */
const REPORT_WAIT_MS = 15_000;

/**
 * 心跳事件 —— 每秒好幾次，跟遊戲進行完全無關。
 *
 * 預設濾掉，不然真正的事件會被洗出畫面（實測 8 條連線各自在 ping，
 * 6 秒內就刷了 11 行心跳、只有 1 行是真的）。`--all` 可以看全部。
 */
const NOISE_EVENTS = new Set(["__ping_c", "__pong_s", "__ping_s", "__pong_c"]);

function usage(): void {
  console.log("ULR Companion（骨架）");
  console.log(`  API schema 版本 : ${API_SCHEMA_VERSION}`);
  console.log(`  桌面版 CDP 埠   : ${DEFAULT_DEBUG_PORT}`);
  console.log(`  網頁版 CDP 埠   : ${BROWSER_DEBUG_PORT}`);
  console.log(`  啟動參數        : ${DEBUG_PORT_SWITCH}`);
  console.log("");
  console.log("用法：");
  console.log("  probe [--port N]            連上遊戲，回報找到什麼");
  console.log("  cost <cost.json> [--port N] [--reload]");
  console.log("                              套用自訂 COST（鍵是 cc_asset 的 filename）");
  console.log("  watch [--port N] [--seconds N] [--out <檔案>] [--in-only|--out-only]");
  console.log("       [--all] [--filter <字串>]");
  console.log("                              即時印出 WebSocket 事件（不會 reload，對戰中可用）");
  console.log("                              預設濾掉心跳，--all 看全部");
  console.log("  arbiter [--port N] [--policy either|opponent|never] [--deadline 秒]");
  console.log("                              移動階段仲裁（⚠ 會改變遊戲行為）");
  console.log("  rule <規則檔.json>          載入並驗證規則包");
  console.log("");
  console.log("  web --refresh [--no-launch] 讀當前版本的 bundle 檔名（必要時自己開 Steam 版）");
  console.log("  web --steamid <id> [--port N] [--game-port N]");
  console.log("                              免 Steam 直接開一個遊戲分頁");
  console.log("                              瀏覽器沒在跑就自己開一個（帶 debug port）");
  console.log("                              [--profile <目錄>] [--browser <exe>] 覆寫預設");
  console.log(`                              預設 profile：${DEFAULT_BROWSER_PROFILE_DIR}`);
  console.log("  web --bookmarklet --steamid <id>");
  console.log("                              印出書籤網址與 javascript: 書籤");
  console.log("  web --extension <輸出目錄>  產生未封裝的 Chrome 擴充功能");
}

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} 後面要接一個值`);
  }
  return value;
}

function parsePort(args: string[], fallback: number = DEFAULT_DEBUG_PORT): number {
  const i = args.indexOf("--port");
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--port 要接一個正整數，收到 ${String(args[i + 1])}`);
  }
  return value;
}

function describeReport(report: CostPatchReport): string {
  switch (report.type) {
    case "cost-patch-installed":
      return "  ✓ hook 已掛上，等遊戲載入 cc_asset";
    case "cost-patch": {
      const lines = [
        `  ✓ 改了 ${report.applied} / ${report.totalFrames} 張卡`,
        `    charaIndex → filename 索引已取得（${report.index.length} 筆）`,
      ];
      if (report.unknownKeys.length > 0) {
        // 不能默默忽略 —— 規則裡有、客戶端沒有，代表規則跟遊戲版本對不上，
        // 而那會讓超標的隊伍看起來合法。
        const head = report.unknownKeys.slice(0, 8).join(", ");
        const tail = report.unknownKeys.length > 8 ? " …" : "";
        lines.push(`  ⚠ 規則有 ${report.unknownKeys.length} 個鍵這個客戶端沒有：${head}${tail}`);
      }
      return lines.join("\n");
    }
    case "cost-patch-error":
      return `  ✗ 注入失敗：${report.reason}`;
  }
}

async function cmdProbe(args: string[]): Promise<number> {
  const adapter = createCdpAdapter({ port: parsePort(args) });
  try {
    const session = await adapter.connect();
    console.log(`✓ 接上遊戲分頁「${session.title}」`);
    console.log(`  ${session.safeUrl}`); // 已去識別化：原始 URL 帶 steamid 與 token
    console.log("  等 Phaser 就緒…");

    const context = await adapter.waitForGame();
    console.log(`✓ 遊戲的 execution context = ${context.contextId}`);
    console.log(`  來源        ${context.safeOrigin}`);
    console.log(`  window.game ${context.gameReady ? "已建立" : "還沒建立（仍在載入）"}`);

    const version = await adapter.evaluate<string | null>(
      "typeof Phaser !== 'undefined' ? Phaser.VERSION : null",
    );
    console.log(`  Phaser      ${version ?? "(取不到)"}`);
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

function readCostTable(path: string): CostOverrides {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('COST 表要是一個物件：{ "cc078_04": 30, … }');
  }
  return raw as CostOverrides;
}

async function cmdCost(args: string[]): Promise<number> {
  const path = args[1];
  if (path === undefined || path.startsWith("--")) {
    console.error("要給一個 COST 表檔案。鍵是 cc_asset 的 filename（cc078_04 / cc078_r04）。");
    return 1;
  }

  const costs = readCostTable(path);
  const adapter = createCdpAdapter({ port: parsePort(args) });
  adapter.onCostPatchReport((r) => console.log(describeReport(r)));

  try {
    const session = await adapter.connect();
    console.log(`✓ 接上「${session.title}」，套用 ${Object.keys(costs).length} 筆自訂 COST`);
    await adapter.installCostOverrides(costs);

    // 注入只對「之後載入的 document」生效。要不要重載是玩家的決定 ——
    // 他可能正在對戰中，插件不該替他做關閉的決定。
    if (!args.includes("--reload")) {
      console.log("  ⚠ 要等遊戲下一次載入才會生效。加 --reload 立刻重載（會打斷對戰）。");
      return 0;
    }

    console.log("  重新載入遊戲…");
    await adapter.reloadGame();
    await new Promise((resolve) => setTimeout(resolve, REPORT_WAIT_MS));
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

/**
 * 免 Steam 開遊戲。
 *
 * 為什麼預設接 `BROWSER_DEBUG_PORT` 而不是 `DEFAULT_DEBUG_PORT`：這整組指令
 * 只對網頁版有意義 —— 桌面版本來就能直接跑 exe 帶參數啟動（見 constants.ts
 * 的 `GAME_EXECUTABLE`），不需要重建外殼。
 */
async function cmdWeb(args: string[]): Promise<number> {
  const port = parsePort(args, BROWSER_DEBUG_PORT);

  /**
   * 確保有一個帶 debug port 的瀏覽器在跑。
   *
   * `--remote-debugging-port` 只能在啟動時指定，所以「連不上就叫玩家自己加參數
   * 重開」等於沒有解 —— 插件必須自己開。已經在跑的就沿用，不重開：玩家可能
   * 正開著另一個帳號的分頁在打。
   */
  async function browser(): Promise<void> {
    const profileDir = parseFlag(args, "--profile");
    const browserPath = parseFlag(args, "--browser");
    const result = await ensureBrowser({
      port,
      ...(profileDir !== undefined ? { profileDir } : {}),
      ...(browserPath !== undefined ? { browserPath } : {}),
    });
    if (result.launched) {
      console.log(`  已開 ${result.browser.name}（profile：${result.profileDir}）`);
    }
  }

  /**
   * 讀當前版本的 bundle 檔名並寫進快取。沒有活著的遊戲就自己去開一次 Steam 版。
   *
   * 沒有「偵測過期」這種東西可以用 —— 伺服器不刪舊 bundle，也沒有版本端點
   * （見 boot-shell.ts 開頭的實測）。所以要確保是最新的，唯一的辦法就是真的
   * 再載入一次。
   */
  async function refresh(launch: boolean): Promise<number> {
    // 先把瀏覽器開起來，Steam 才有東西可以把網址交過去。
    // ⚠ 這不保證 Steam 一定交到**這一個** —— openExternal 走的是系統預設
    // 瀏覽器。玩家的預設瀏覽器若是另一個 profile 的 Chrome，遊戲會開在那邊，
    // 這裡就讀不到（症狀是等到逾時）。見 docs/launching.md。
    await browser();
    const found = await refreshBundles({
      port,
      launch,
      onProgress: (m) => console.log(`  ${m}`),
    });
    const cache = writeBundleCache(found.bundles);
    console.log(`✓ 從 ${found.safeUrl} 讀到 ${cache.bundles.length} 個 bundle`);
    for (const b of cache.bundles) console.log(`    ${b}`);
    console.log(`  已寫入 ${CACHE_PATH}`);
    return 0;
  }

  if (args.includes("--refresh")) {
    return await refresh(!args.includes("--no-launch"));
  }

  // 擴充功能不需要快取 —— 它自己會在玩家從 Steam 開遊戲時把檔名記進
  // chrome.storage，所以打包出來的東西跟遊戲版本無關，改版後不用重產。
  const extensionDir = parseFlag(args, "--extension");
  if (extensionDir !== undefined) {
    const files = buildExtensionFiles();
    mkdirSync(extensionDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(extensionDir, name), content, "utf8");
      console.log(`  寫入 ${join(extensionDir, name)}`);
    }
    console.log("");
    console.log("README.txt 是給拿到這個資料夾的人看的 —— 整包直接分享即可。");
    console.log("安裝：chrome://extensions → 開發人員模式 →「載入未封裝項目」→ 選這個資料夾");
    console.log("（--load-extension 在新版 Chrome 會被忽略，只能手動載入）");
    console.log("");
    console.log("裝好之後第一次要先從 Steam 開一次遊戲，讓它記下這個版本的檔案清單。");
    console.log("之後點書籤就能直接進遊戲，改版後也只要再從 Steam 開一次，不用重產。");
    return 0;
  }

  // 其餘三種都要有快取。沒有的話直接去弄一份，不要叫使用者自己先跑一次 refresh。
  let cache;
  try {
    cache = readBundleCache();
  } catch (err) {
    if (!(err instanceof NoBundleCacheError)) throw err;
    console.log("還沒有 bundle 檔名快取，先取得一份…");
    await refresh(true);
    cache = readBundleCache();
  }

  const steamId = parseFlag(args, "--steamid");
  if (steamId === undefined) {
    console.error("要給 --steamid <SteamID64>。它會出現在網址上，不會被寫進腳本或記錄。");
    return 1;
  }

  if (args.includes("--bookmarklet")) {
    const url = buildBookmarkUrl(steamId, GAME_ORIGIN);
    console.log("① 把這個網址存成書籤（已經帶好 port，才能一點就用）：");
    console.log(`   ${url}`);
    console.log("");
    console.log("② 再把這一整串存成第二個書籤（開啟①看到 403 之後點它）：");
    console.log("");
    console.log(buildBookmarklet(cache.bundles));
    console.log("");
    console.log("⚠ 書籤沒辦法在 document-start 執行，所以要點兩下。");
    console.log("  想要一鍵請改用 --extension。");
    return 0;
  }

  const gamePortRaw = parseFlag(args, "--game-port");
  await browser();
  const result = await openGameTab({
    port,
    steamId,
    bundles: cache.bundles,
    ...(gamePortRaw !== undefined ? { gamePort: Number(gamePortRaw) } : {}),
  });
  console.log(`✓ 已開新分頁 ${result.safeUrl}`);
  console.log(`  用的是 ${cache.discoveredAt} 讀到的 bundle 檔名`);
  console.log("  換帳號：換一個 --steamid 再跑一次就好，跟 Steam 登入的是誰無關。");
  console.log("  遊戲沒出來的話多半是改版了 —— 從 Steam 開一次再 web --refresh。");
  return 0;
}

/**
 * 只開一個帶 debug port 的瀏覽器，其他什麼都不做。
 *
 * 為什麼要跟 `web --steamid` 分開：那支會**順便**開好遊戲分頁，需要 steamid
 * 與 bundle 快取。但玩家常常只是要一個能接 CDP 的瀏覽器，進去之後自己點
 * 書籤就好 —— 那條路不需要 steamid，也不該被逼著給一個。
 */
async function cmdBrowser(args: string[]): Promise<number> {
  const profileDir = parseFlag(args, "--profile");
  const browserPath = parseFlag(args, "--browser");
  const result = await ensureBrowser({
    port: parsePort(args, BROWSER_DEBUG_PORT),
    ...(profileDir !== undefined ? { profileDir } : {}),
    ...(browserPath !== undefined ? { browserPath } : {}),
  });

  console.log(
    result.launched
      ? `✓ 已開 ${result.browser.name}，debug port ${result.port}`
      : `✓ debug port ${result.port} 本來就有人在聽，沿用既有的瀏覽器`,
  );
  console.log(`  profile：${result.profileDir}`);
  console.log("  進去之後點書籤開遊戲即可。接事件：companion watch --port " + result.port);
  return 0;
}

/**
 * 即時看 WebSocket 事件（WP-09）。
 *
 * 這是四個戰鬥功能的第一步 —— 先把事件名的目錄建起來，才談得上牌譜。
 *
 * ⚠ **不會 reload 遊戲**，所以對戰中接上來也不會打斷。
 * §12：只印事件名與參數形狀，永遠不印值（界線在 `ws-events.ts` 的 `shapeOf`）。
 */
async function cmdWatch(args: string[]): Promise<number> {
  const adapter = createCdpAdapter({ port: parsePort(args) });
  const outPath = parseFlag(args, "--out");
  const onlyOut = args.includes("--out-only");
  const onlyIn = args.includes("--in-only");
  const showAll = args.includes("--all");
  const filter = parseFlag(args, "--filter");
  /**
   * 臨時把事件加進取值允許清單，用來查某個參數到底是什麼。
   *
   * ⚠ 這是**調查用**的，不是給日常使用的。預設清單刻意排除了幾個事件
   * （例如 `cardclickedX` 的 `num` 在翻牌前是隱藏資訊），用這個旗標繞過去
   * 之前要先想清楚看到的東西算不算 §12 的隱藏資訊。
   *
   * 長字串仍然擋著 —— `VALUE_MAX_STRING_LENGTH` 不受任何清單影響。
   */
  const extraValues = parseFlag(args, "--values");

  const isNoise = (event: string): boolean => NOISE_EVENTS.has(event);

  // 事件名的統計。收工時印一份，比一路捲過去的即時流好對照。
  const tally = new Map<string, { in: number; out: number }>();
  const lines: string[] = [];
  let first: number | null = null;

  try {
    const session = await adapter.connect();
    console.log(`✓ 接上「${session.title}」`);
    await adapter.waitForGame();

    adapter.onWsEvent((report) => {
      if (report.type === "ws-watch-error") {
        console.error(`  ✗ ${report.reason}`);
        return;
      }
      if (report.type === "ws-watch-installed") {
        console.log(
          `✓ 監看已裝上：emit ${report.emitPatched ? "已 patch" : "未 patch"}、` +
            `${report.sockets} 條連線掛了 onAny`,
        );
        console.log("  現在去遊戲裡操作，事件會即時印出來。Ctrl+C 結束。\n");
        return;
      }

      if (onlyOut && report.dir === "in") return;
      if (onlyIn && report.dir === "out") return;
      // 心跳每秒好幾次，不濾掉會把真正的事件洗出畫面。
      if (!showAll && isNoise(report.event)) return;
      if (filter !== undefined && !report.event.includes(filter)) return;

      first ??= report.at;
      const t = ((report.at - first) / 1000).toFixed(2).padStart(8);
      const arrow = report.dir === "out" ? "→送出" : "←收到";
      const line = `${t}s ${arrow} ${report.event}  ${report.shape.join("  ")}`;
      console.log(line);
      lines.push(line);

      const row = tally.get(report.event) ?? { in: 0, out: 0 };
      row[report.dir === "in" ? "in" : "out"]++;
      tally.set(report.event, row);
    });

    // 連線可能還沒建好（還在讀取畫面、還沒進對戰房），重試比直接失敗有用。
    for (let attempt = 1; ; attempt++) {
      const status = await adapter.installWsWatch(
        extraValues !== undefined
          ? { valueEvents: [...DEFAULT_VALUE_EVENTS, ...extraValues.split(",")] }
          : {},
      );
      if (status !== "no-socket") {
        if (status === "updated") console.log("  （本來就掛著，已更新設定）");
        break;
      }
      if (attempt >= 20) {
        console.error("✗ 等不到 WSClient。遊戲載完了嗎？(window.game.scene.keys 底下沒有 socket)");
        return 1;
      }
      if (attempt === 1) console.log("  還沒有連線，等遊戲建好…");
      await new Promise((r) => setTimeout(r, 1_000));
    }

    // 這支的工作就是一直看著。Ctrl+C 或 --seconds 到時結束。
    const secondsRaw = parseFlag(args, "--seconds");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      if (secondsRaw !== undefined) setTimeout(resolve, Number(secondsRaw) * 1000);
    });

    console.log("\n── 事件統計 ──");
    const rows = [...tally.entries()].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out));
    for (const [name, row] of rows) {
      console.log(`  ${String(row.out).padStart(4)}→  ←${String(row.in).padEnd(4)}  ${name}`);
    }
    if (outPath !== undefined) {
      writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
      console.log(`\n  已寫入 ${outPath}`);
    }
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

/** 遊戲沒開就等它開 —— 玩家不會為了插件而先開遊戲。 */
const CONNECT_RETRY_MS = 2_000;

/**
 * 一直等到連得上為止。回傳分頁標題。
 *
 * ⚠ 沒有次數上限是刻意的。這支指令的預期用法是「開著它，然後去玩」——
 * 玩家什麼時候開遊戲、開幾次、中途關掉再開，都不該讓插件自己結束。
 */
async function connectWhenReady(adapter: ReturnType<typeof createCdpAdapter>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const session = await adapter.connect();
      await adapter.waitForGame();
      return session.title;
    } catch (err) {
      if (attempt === 1) {
        console.log(`  等遊戲…（${err instanceof Error ? err.message : String(err)}）`);
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
}

/**
 * 移動階段仲裁（WP-12）—— 單邊模式。
 *
 * ⚠ **這會改變遊戲行為。** 按下 OK 之後不會立刻送出，會壓到硬底線
 * （或之後接上側通道後、對手也準備好時）。
 *
 * 目前沒有側通道，所以永遠等不到對手就緒 —— 行為等同「誤按反悔窗口」：
 * 按了 OK 還可以再按一次取消、對手一動也會自動解除，時間快到才真的送出。
 *
 * **這支要能全程掛著。** 玩家的實際流程是「開著它去玩」，所以四種時機都得
 * 成立：遊戲還沒開、開了還在大廳、對戰中途接手、打完一場重新開房。前三種
 * 靠這裡的等待與 `installOkPatch()` 的 `waiting` 狀態，第四種靠頁面自己偵測
 * socket 換過了沒（`patch-ok.ts` 的 `arm()`）。
 */
async function cmdArbiter(args: string[]): Promise<number> {
  const adapter = createCdpAdapter({ port: parsePort(args) });
  const policyRaw = parseFlag(args, "--policy") ?? "either";
  if (policyRaw !== "either" && policyRaw !== "opponent" && policyRaw !== "never") {
    console.error(`--policy 只能是 either / opponent / never，收到 ${policyRaw}`);
    return 1;
  }
  const deadline = Number(parseFlag(args, "--deadline") ?? 3);

  try {
    const title = await connectWhenReady(adapter);
    console.log(`✓ 接上「${title}」`);

    adapter.onOkPatchReport((r) => {
      if (r.type === "ok-patch-error") console.error(`  ✗ ${r.reason}`);
      else if (r.type === "ok-patch-rearmed") {
        // 換房／進任務都會換一顆 socket。看得到這行才代表新的一場真的接上了。
        console.log(`  ⟳ 換場，攔截已重新掛上  座位=${r.seat ?? "(還不知道)"}`);
      } else if (r.type === "ok-released") {
        // failsafe 代表連心跳都沒發揮作用 —— 最後一道防線，不該常發生。
        const tag = { failsafe: "⚠ 失效保護", "node-gone": "⚠ 心跳過期" }[r.by as string] ?? r.by;
        console.log(`  → 真的送出 I_am_ok（${tag}，壓了 ${(r.heldMs / 1000).toFixed(1)}s）`);
      }
    });

    // ⚠ 不必等到進對戰。沒有 socket 也裝得上去（回 waiting），頁面每 200ms
    // 會自己去補掛 —— 「先開 companion 再開遊戲」才是玩家實際的順序。
    const status = await adapter.installOkPatch();

    const runner = new ArbiterRunner(adapter.asPageBridge(), {
      config: { policy: policyRaw, deadlineSeconds: deadline },
      onError: (err) => console.error(`  ✗ ${err.message}`),
      onStep: ({ input, state, actions }) => {
        const what =
          input.type === "tick" ? `tick ${input.remainingSeconds.toFixed(1)}s` : input.type;
        if (actions.length === 0 && input.type === "tick") return; // 沒事的 tick 不印
        console.log(
          `  ${what.padEnd(16)} ready=${String(state.ready).padEnd(5)} ` +
            `committed=${String(state.committed).padEnd(5)} ${actions.map((a) => a.type).join(",")}`,
        );
      },
    });
    await runner.start();
    console.log(
      `✓ 仲裁已啟動  座位=${runner.seat ?? "(還不知道)"}  策略=${policyRaw}  底線=${deadline}s`,
    );
    if (status === "waiting") console.log("  還沒進對戰 —— 進去之後會自己掛上，不必重跑。");
    console.log("  按下 OK 會被壓住；再按一次取消；對手一動也會解除。Ctrl+C 結束。\n");

    const secondsRaw = parseFlag(args, "--seconds");
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      if (secondsRaw !== undefined) setTimeout(resolve, Number(secondsRaw) * 1000);
    });
    runner.stop();

    // ⚠ **一定要拆。** 留著的話頁面上會有一個沒有鑰匙的鎖：原型上的 patch
    // 照樣攔 I_am_ok，但沒有人能下 cancel／release。心跳讓它 3 秒後自己停手，
    // 不拆仍然沒有任何好處（2026-08-03 就是這樣坑到玩家的）。
    try {
      const gone = await adapter.uninstallOkPatch();
      console.log(gone === "uninstalled" ? "\n✓ 攔截已拆除，遊戲回到原本行為" : "\n（本來就沒裝）");
    } catch (err) {
      console.error(`\n✗ 拆不掉攔截：${err instanceof Error ? err.message : String(err)}`);
      console.error("  遊戲重載一次就會乾淨（頁面上的 patch 不會跨載入存活）。");
    }
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

function cmdRule(args: string[]): number {
  const path = args[1];
  if (path === undefined) {
    console.error("要給一個規則檔。");
    return 1;
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));

  // 兩種都收：規則包信封，或裸的規則內容
  if (typeof raw === "object" && raw !== null && "packageVersion" in raw) {
    const result = loadRulePackage(raw);
    if (!result.ok) {
      console.error(`✗ 載入失敗 [${result.code}] ${result.message}`);
      return 1;
    }
    const { pkg, short } = result.value;
    console.log(`✓ ${pkg.rule.name} ${pkg.rule.version}  (${short})`);
    console.log(`  發布者   ${pkg.rule.publisher.name}`);
    console.log(`  上限     ${pkg.rule.teamCostLimit}`);
    console.log(`  角色     ${Object.keys(pkg.rule.characters).length} 筆`);
    return 0;
  }

  const rule = assertCostRule(raw);
  console.log(`✓ ${rule.name} ${rule.version}  (${shortHash(contentHash(rule))})`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
        usage();
        return 0;
      case "probe":
        return await cmdProbe(args);
      case "cost":
        return await cmdCost(args);
      case "watch":
        return await cmdWatch(args);
      case "browser":
        return await cmdBrowser(args);
      case "arbiter":
        return await cmdArbiter(args);
      case "web":
        return await cmdWeb(args);
      case "rule":
        return cmdRule(args);
      default:
        // 舊用法：直接給規則檔路徑
        return cmdRule(["rule", ...args]);
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv);
