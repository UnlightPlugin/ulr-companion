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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_SCHEMA_VERSION } from "@ulr/api-contract";
import type {
  BrowserFamily,
  CostOverrides,
  CostOverrideTables,
  CostPatchReport,
  CostTableId,
  PenaltyBand,
} from "@ulr/cdp-adapter";
import {
  BROWSER_DEBUG_PORT,
  browserDebugPort,
  buildBookmarklet,
  buildBookmarkUrl,
  buildExtensionFiles,
  COST_TABLE_IDS,
  createCdpAdapter,
  DEBUG_PORT_SWITCH,
  DEFAULT_BROWSER_PROFILE_DIR,
  DEFAULT_DEBUG_PORT,
  DEFAULT_VALUE_EVENTS,
  EDGE_BROWSER_PROFILE_DIR,
  EDGE_DEBUG_PORT,
  ensureBrowser,
  GAME_ORIGIN,
  openGameTab,
  refreshBundles,
  toCostTable,
} from "@ulr/cdp-adapter";
import { ArbiterEngine, SPEED_RENEW_MS } from "@ulr/arbiter-engine";
import {
  DEFAULT_HAZARD_SHORTEN_SECONDS,
  DEFAULT_LINK_PORT,
  MOVE_PHASE_TOTAL_SECONDS,
} from "@ulr/arbiter-link";
import type { CostRule } from "@ulr/rule-schema";
import {
  assertCostRule,
  buildCatalog,
  catalogSize,
  contentHash,
  createRulePackage,
  equipmentKey,
  eventCardKey,
  loadRulePackage,
  parseEquipmentKey,
  parseEventCardKey,
  RULE_PACKAGE_EXTENSION,
  shortHash,
  toIndexTable,
} from "@ulr/rule-schema";
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
  console.log(`  Chrome CDP 埠   : ${BROWSER_DEBUG_PORT}`);
  console.log(`  Edge CDP 埠     : ${EDGE_DEBUG_PORT}`);
  console.log(`  啟動參數        : ${DEBUG_PORT_SWITCH}`);
  console.log("");
  console.log("用法：");
  console.log("  probe [--port N]            連上遊戲，回報找到什麼");
  console.log("  cost <cost.json|規則檔> [--port N] [--reload]");
  console.log("                              套用自訂 COST（鍵是 cc_asset 的 filename）");
  console.log("                              裸對照表、規則內容、規則包三種都收");
  console.log("  official-rule [--port N] [--out <檔案>] [--game-version YYYY.MM]");
  console.log("       [--rule-version X.Y.Z]");
  console.log("                              把客戶端的原版 COST 表匯出成規則包");
  console.log("                              ⚠ 要在沒套過自訂 COST 的客戶端上跑");
  console.log("  catalog [--port N] [--out <檔案>] [--game-version YYYY.MM]");
  console.log("                              讀卡片名冊（編號 → 中文名），給托盤的編輯 COST 用");
  console.log("                              預設寫到 ~/.ulr-companion/catalog.json");
  console.log("  watch [--port N] [--seconds N] [--out <檔案>] [--in-only|--out-only]");
  console.log("       [--all] [--filter <字串>]");
  console.log("                              即時印出 WebSocket 事件（不會 reload，對戰中可用）");
  console.log("                              預設濾掉心跳，--all 看全部");
  console.log("  arbiter [--port N] [--policy either|opponent|never] [--deadline 秒]");
  console.log("       [--phase-seconds N] [--hazard-shorten N] [--no-ready]");
  console.log("       [--link <位址>] [--no-link]   （預設是雲端中間人，不用設）");
  console.log(
    `                              --link local（本機 :${DEFAULT_LINK_PORT}，開發用）｜wss://…`,
  );
  console.log("                              移動階段仲裁（⚠ 會改變遊戲行為）");
  console.log("                              --phase-seconds 是「我希望這個階段多長」，");
  console.log("                              雙方取比較長的那個當共同值；沒配到對手就不縮短");
  console.log("                              先開的那個插件自動當中間人，雙開不必多開一個視窗");
  console.log("  speed [--port N] [--factor N]");
  console.log("                              演出加速，只快動畫不動時鐘（預設 ×3）");
  console.log("                              實測約省 1 分鐘／場，伺服器排程那段動不了");
  console.log("  rule <規則檔.json>          載入並驗證規則包");
  console.log("  unpack <規則包> [--out F]   挖出裸規則（信封少一層，好讀好 diff）");
  console.log("  pack <規則檔> [--out F]     重算 contentHash 封成規則包給對手核對");
  console.log("                              ⚠ 改 COST 直接改 .ulrcost.json 就行，Hash 會重算");
  console.log("");
  console.log("  web --refresh [--no-launch] 讀當前版本的 bundle 檔名（必要時自己開 Steam 版）");
  console.log("  web --steamid <id> [--port N] [--game-port N]");
  console.log("                              免 Steam 直接開一個遊戲分頁");
  console.log("                              瀏覽器沒在跑就自己開一個（帶 debug port）");
  console.log("                              [--edge] 改用 Edge（自己的 profile 與埠，");
  console.log("                              跟 Chrome 可以同時開，各掛一個帳號）");
  console.log("                              [--profile <目錄>] [--browser <exe>] 覆寫預設");
  console.log(`                              預設 profile：${DEFAULT_BROWSER_PROFILE_DIR}`);
  console.log(`                              --edge 的是：${EDGE_BROWSER_PROFILE_DIR}`);
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

/**
 * `--edge` / `--chrome`：要開哪一族瀏覽器。
 *
 * ⚠ **不給就回 `undefined`，不要預設成 `"chrome"`。** 兩者不一樣：`undefined`
 * 是「照偏好順序找一個能用的」（Chrome ＞ Edge ＞ Brave），指名 `"chrome"` 則是
 * 「非 Chrome 不可，沒有就報錯」。沒裝 Chrome 只有 Edge 的機器上，寫死預設會
 * 讓本來能跑的指令開始失敗。
 */
function parseBrowserFamily(args: string[]): BrowserFamily | undefined {
  if (args.includes("--edge")) return "edge";
  if (args.includes("--chrome")) return "chrome";
  return undefined;
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

/** 四張表的中文名。CLI 與托盤各留一份是刻意的 —— 兩邊的語氣不同。 */
const TABLE_LABEL: Readonly<Record<CostTableId, string>> = {
  characters: "角色",
  monsters: "怪物",
  equipment: "裝備",
  eventCards: "事件卡",
};

function describeReport(report: CostPatchReport): string {
  switch (report.type) {
    case "cost-patch-installed":
      return "  ✓ hook 已掛上，等遊戲載入四張 COST 表";
    case "cost-patch": {
      const label = TABLE_LABEL[report.table];
      const lines = [`  ✓ ${label}：改了 ${report.applied} / ${report.totalFrames} 張`];
      if (report.index !== null) {
        lines.push(`    charaIndex → filename 索引已取得（${report.index.length} 筆）`);
      }
      if (report.unknownKeys.length > 0) {
        // 不能默默忽略 —— 規則裡有、客戶端沒有，代表規則跟遊戲版本對不上，
        // 而那會讓超標的隊伍看起來合法。
        const head = report.unknownKeys.slice(0, 8).join(", ");
        const tail = report.unknownKeys.length > 8 ? " …" : "";
        lines.push(
          `  ⚠ ${label}有 ${report.unknownKeys.length} 個鍵這個客戶端沒有：${head}${tail}`,
        );
      }
      return lines.join("\n");
    }
    case "cost-patch-error": {
      const where = report.table === null ? "" : `（${TABLE_LABEL[report.table]}）`;
      return `  ✗ 注入失敗${where}：${report.reason}`;
    }
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

/**
 * 讀 COST 表。三種都收：
 *
 *   1. 裸的對照表      `{ "cc078_04": 30, … }`
 *   2. 規則內容        有 `schemaVersion` 的物件 → 取它的 `characters`
 *   3. 規則包信封      有 `packageVersion` 的物件 → 驗 Hash 後取 `characters`
 *
 * 2 與 3 能直接用，是因為規則的正規鍵**就是** cc_asset 的 filename，中間
 * 不需要任何對照表（見 docs/open-questions.md 第 1 題）。
 *
 * ⚠ 只取 `characters` 與 `compressionRule`。武器與事件卡的 COST 改不動 ——
 * `patch-cost` 攔的是 cc_asset，那裡面只有角色卡。
 */
/**
 * 一份規則 → 注入腳本要的四張表。
 *
 * ⚠ 裝備與事件卡的鍵在這裡就換成**陣列索引字串**（`wp001` → `"1"`）。
 * 注入的腳本刻意不認得 `wp` / `ev` 這套命名，見 `patch-cost.ts`。
 * 認不得的鍵會被列出來 —— 默默丟掉等於那張卡的價格安靜地沒有生效。
 */
function tablesOf(rule: CostRule): { costs: CostOverrideTables; unmapped: string[] } {
  const equipment = toIndexTable(rule.equipment, parseEquipmentKey);
  const eventCards = toIndexTable(rule.eventCards, parseEventCardKey);
  return {
    costs: {
      characters: rule.characters,
      monsters: rule.monsters,
      equipment: equipment.byIndex,
      eventCards: eventCards.byIndex,
    },
    unmapped: [...equipment.unmapped, ...eventCards.unmapped],
  };
}

function readCostTable(path: string): {
  costs: CostOverrideTables;
  bands: readonly PenaltyBand[] | null;
  note: string;
  unmapped: string[];
} {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('COST 表要是一個物件：{ "cc078_04": 30, … }');
  }

  if ("packageVersion" in raw) {
    const result = loadRulePackage(raw);
    if (!result.ok) throw new Error(`規則包載入失敗 [${result.code}] ${result.message}`);
    const { pkg, short } = result.value;
    return {
      ...tablesOf(pkg.rule),
      bands: bandsOf(pkg.rule),
      note: `規則包 ${pkg.rule.name} ${pkg.rule.version} (${short})`,
    };
  }

  if ("schemaVersion" in raw) {
    const rule = assertCostRule(raw);
    return {
      ...tablesOf(rule),
      bands: bandsOf(rule),
      note: `規則 ${rule.name} ${rule.version} (${shortHash(contentHash(rule))})`,
    };
  }

  // 裸對照表沒有壓 C 資訊 —— null 代表「不要動罰則」，不是「不罰」。
  // ⚠ 也沒有表的分野：一律當角色表，那是這個格式唯一支援過的語意。
  return {
    costs: { characters: raw as CostOverrides },
    bands: null,
    note: "裸 COST 表（只當角色表）",
    unmapped: [],
  };
}

function bandsOf(rule: CostRule): readonly PenaltyBand[] | null {
  return rule.compressionRule?.type === "gap-band-v1" ? rule.compressionRule.bands : null;
}

/** 官方的壓 C 區間：差距 7~13 → +5，14 以上 → +10。出處見 docs/official-cost-rule.md。 */
const OFFICIAL_GAP_BANDS = [
  { minGap: 7, maxGap: 13, extraCost: 5 },
  { minGap: 14, extraCost: 10 },
];

/**
 * 把跑著的客戶端的原版 COST 表匯出成規則包。
 *
 * 這是「自訂規則」的起點 —— 玩家 fork 它，只改想改的角色，其餘保持原版。
 * 每次遊戲改版都該重跑一次。
 *
 * **四張表一次讀完**：角色（`cc_asset`）、怪物（`mc_asset`）、
 * 裝備（`avatar_item.weapon`）、事件卡（`event_info`）。一副牌組就是這四張
 * 組合出來的，少讀一張就等於那一種卡在規則裡全部缺席 → 每張都被算成 99C。
 */
async function cmdOfficialRule(args: string[]): Promise<number> {
  const out = parseFlag(args, "--out") ?? "unlight-official.ulrcost.json";
  const version = parseFlag(args, "--rule-version") ?? "1.0.0";
  const now = new Date();
  const gameVersion =
    parseFlag(args, "--game-version") ??
    `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;

  const adapter = createCdpAdapter({ port: parsePort(args, BROWSER_DEBUG_PORT) });
  try {
    const session = await adapter.connect();
    console.log(`✓ 接上「${session.title}」`);
    await adapter.waitForGame();

    const cc = await adapter.readCharacterAssets();
    const characters = toCostTable(cc.assets);
    console.log(`✓ 讀到 ${cc.assets.length} 張角色卡（cc_asset 共 ${cc.totalFrames} 格）`);
    if (cc.placeholders > 0) {
      console.log(`  略過 ${cc.placeholders} 個沒有 filename 的保留空位`);
    }

    const mc = await adapter.readMonsterAssets();
    const monsters = toCostTable(mc.assets);
    console.log(`✓ 讀到 ${mc.assets.length} 張怪物卡（mc_asset 共 ${mc.totalFrames} 格）`);
    if (mc.placeholders > 0) {
      console.log(`  略過 ${mc.placeholders} 個沒有 filename 的保留空位`);
    }

    // 索引型的兩張。⚠ 鍵是這裡才組出來的 —— cdp-adapter 只回傳陣列索引。
    const weapons = await adapter.readWeaponAssets();
    const equipment: Record<string, number> = {};
    for (const w of weapons.cards) equipment[equipmentKey(w.index)] = w.cost;
    console.log(`✓ 讀到 ${weapons.cards.length} 件裝備（avatar_item.weapon）`);

    const events = await adapter.readEventCardAssets();
    const eventCards: Record<string, number> = {};
    for (const e of events.cards) eventCards[eventCardKey(e.index)] = e.cost;
    console.log(`✓ 讀到 ${events.cards.length} 張事件卡（event_info）`);

    // 客戶端的 UNKNOWN_COST 也是 99，兩者長得一樣。這裡只是提醒操作者去確認，
    // 不擋 —— 真的有卡就叫 99 是可能的。
    const suspicious = [...cc.assets, ...mc.assets].filter((a) => a.cost === 99);
    if (suspicious.length > 0) {
      console.log(
        `  ⚠ 有 ${suspicious.length} 張的 cost 剛好是 99（${suspicious
          .slice(0, 6)
          .map((a) => a.filename)
          .join(", ")}）。` +
          "\n    99 是客戶端查不到資料時的預設值，也可能是這個客戶端已經套過自訂 COST。" +
          "\n    請確認是在**沒有套過**的客戶端上讀的。",
      );
    }

    const rule = assertCostRule({
      schemaVersion: 1,
      ruleSetId: "unlight/official",
      version,
      name: "UNLIGHT 原版 COST",
      description:
        "從客戶端直接讀出的原版 COST：角色（cc_asset）、怪物（mc_asset）、" +
        "裝備（avatar_item.weapon）、事件卡（event_info），加上官方的壓 C 規則" +
        "（差距 7~13 罰 5C、14 以上罰 10C，隊內每一對各罰一次）。" +
        "⚠ 怪物與角色共用同樣三個槽位，照樣參與壓 C；裝備與事件卡計入總和但不參與。" +
        "teamCostLimit 是 0＝不設限：上限由伺服器按頻道下發，不是規則的一部分。",
      publisher: { id: "unlight", name: "UNLIGHT:Revive" },
      gameVersion,
      appliesTo: "any",
      teamCostLimit: 0,
      characters,
      monsters,
      equipment,
      eventCards,
      compressionRule: { type: "gap-band-v1", bands: OFFICIAL_GAP_BANDS },
      changelog:
        `以 ${gameVersion} 的客戶端為準：角色 ${cc.assets.length}、` +
        `怪物 ${mc.assets.length}、裝備 ${weapons.cards.length}、` +
        `事件卡 ${events.cards.length}。`,
    });

    const pkg = createRulePackage(rule, { exportedBy: "ulr-companion official-rule" });
    writeFileSync(out, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    console.log(`✓ 寫入 ${out}`);
    console.log(`  contentHash ${shortHash(pkg.contentHash)}`);
    console.log(`  遊戲版本    ${gameVersion}（--game-version 可覆寫）`);
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

/**
 * 讀一份卡片名冊（編號 → 中文名 + 原價）給托盤的「編輯 COST」用。
 *
 * 托盤自己也有一顆按鈕做同一件事；留一個 CLI 入口是為了在沒開 GUI 時
 * 也能重讀（改版之後最常做的就是這件事）。
 *
 * ⚠ 跟 `official-rule` 一樣**要在沒套過自訂 COST 的客戶端上跑** —— 名冊裡的
 * 「原價」是編輯器「改回原價」的基準，讀到改過的數字會讓玩家改回一個他從來
 * 沒設過的值。
 */
async function cmdCatalog(args: string[]): Promise<number> {
  const out = parseFlag(args, "--out") ?? join(homedir(), ".ulr-companion", "catalog.json");
  const now = new Date();
  const gameVersion =
    parseFlag(args, "--game-version") ??
    `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;

  const adapter = createCdpAdapter({ port: parsePort(args, BROWSER_DEBUG_PORT) });
  try {
    const session = await adapter.connect();
    console.log(`✓ 接上「${session.title}」`);
    await adapter.waitForGame();

    const [cc, mc, weapons, events, profiles] = [
      await adapter.readCharacterAssets(),
      await adapter.readMonsterAssets(),
      await adapter.readWeaponAssets(),
      await adapter.readEventCardAssets(),
      await adapter.readProfiles(),
    ];
    const catalog = buildCatalog({
      gameVersion,
      characters: cc.assets,
      monsters: mc.assets,
      equipment: weapons.cards,
      eventCards: events.cards,
      profiles,
      // ⚠ 少了它每張卡都會被判成「官方還沒出」—— 見 `buildCatalog` 的 `locked`。
      hasUpgradeGraph: { characters: cc.hasUpgradeGraph, monsters: mc.hasUpgradeGraph },
    });

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    const n = catalogSize(catalog);
    console.log(`✓ 寫入 ${out}`);
    console.log(`  角色   ${catalog.characters.length} 位 / ${n.characters} 張`);
    console.log(`  怪物   ${catalog.monsters.length} 種 / ${n.monsters} 張`);
    console.log(`  裝備   ${n.equipment} 件（${catalog.equipment.length} 組，含通用）`);
    console.log(`  事件卡 ${n.eventCards} 張（${catalog.eventCards.length} 族）`);
    // 讀不到名字的會退回代號，那正是「玩家又看到編號了」的情況，要點出來。
    const nameless = [
      ...catalog.characters.filter((g) => g.name === g.id).map((g) => g.id),
      ...catalog.monsters.filter((g) => g.name === g.id).map((g) => g.id),
    ];
    if (nameless.length > 0) {
      console.log(
        `  ⚠ 有 ${nameless.length} 組查不到名字，畫面上會顯示代號：${nameless
          .slice(0, 8)
          .join(", ")}`,
      );
    }
    return 0;
  } finally {
    await adapter.disconnect();
  }
}

async function cmdCost(args: string[]): Promise<number> {
  const path = args[1];
  if (path === undefined || path.startsWith("--")) {
    console.error("要給一個 COST 表檔案。鍵是 cc_asset 的 filename（cc078_04 / cc078_r04）。");
    return 1;
  }

  const { costs, bands, note, unmapped } = readCostTable(path);
  const adapter = createCdpAdapter({ port: parsePort(args) });
  adapter.onCostPatchReport((r) => console.log(describeReport(r)));
  adapter.onPenaltyPatchReport((r) => {
    console.log(
      r.type === "penalty-patch-error"
        ? `  ✗ 罰則注入失敗：${r.reason}`
        : `  ✓ 壓 C 罰則已改寫（${r.bands} 段區間` +
            `${r.badgesPatched ? "，徽章也已改寫" : "，⚠ 徽章沒改到，只有總和會對"}` +
            `${r.socketPatched ? "，全遊戲生效" : "，⚠ 只有牌組畫面生效"}）` +
            (r.sample === null
              ? ""
              : `
    目前牌組 ${JSON.stringify(r.sample.cards)} → 罰 ` +
                `${JSON.stringify(r.sample.penalties)}  總 ${r.sample.total}`),
    );
  });

  try {
    const session = await adapter.connect();
    console.log(`✓ 接上「${session.title}」，來源：${note}`);
    const counts = COST_TABLE_IDS.map((id) => {
      const n = Object.keys(costs[id] ?? {}).length;
      return n === 0 ? null : `${TABLE_LABEL[id]} ${n}`;
    }).filter((s): s is string => s !== null);
    console.log(`  套用自訂 COST：${counts.length === 0 ? "（空的）" : counts.join("、")}`);
    if (unmapped.length > 0) {
      // 鍵格式不對就等於那張卡的價格安靜地沒生效。`wp1`（沒補零）最常見。
      console.log(
        `  ⚠ 有 ${unmapped.length} 個裝備／事件卡的鍵格式不對，已略過：` +
          `${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? " …" : ""}` +
          "\n    正確格式是 wp001 / ev091（前綴 + 補零到 3 位的索引）。",
      );
    }
    await adapter.installCostOverrides(costs);

    // ⚠ 罰則跟價格是兩回事，而且生效時機不同。
    // 價格改的是 cc_asset 資料（要重載）；罰則改的是 Deck.prototype.getCost
    // （立刻生效）。只做前者的話，規則的 compressionRule 對畫面毫無作用。
    if (bands !== null) {
      await adapter.waitForGame();
      await adapter.installPenaltyOverrides(bands);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    // 注入只對「之後載入的 document」生效。要不要重載是玩家的決定 ——
    // 他可能正在對戰中，插件不該替他做關閉的決定。
    if (!args.includes("--reload")) {
      console.log("  ⚠ 卡片價格要等遊戲下一次載入才會生效。加 --reload 立刻重載（會打斷對戰）。");
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
  const family = parseBrowserFamily(args);
  // 首選埠跟著瀏覽器走（Chrome 59223、Edge 59224）。共用一個埠的話，兩個
  // 瀏覽器不可能同時掛著 —— 而「Chrome 掛任務、Edge 打對戰」正是要支援的用法。
  const requestedPort = parsePort(args, browserDebugPort(family));
  /**
   * **實際**接得上的埠。
   *
   * ⚠ 不能整支都用 `requestedPort`：那個埠綁不上時（Windows 保留範圍）
   * `ensureBrowser()` 會退回讓瀏覽器自己挑，挑到的埠只有它知道。後面的
   * `refreshBundles` 與 `openGameTab` 都要接**那一個**，不然瀏覽器好好地開著、
   * 這裡卻一路等到逾時。
   */
  let port = requestedPort;

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
      port: requestedPort,
      ...(family !== undefined ? { family } : {}),
      ...(profileDir !== undefined ? { profileDir } : {}),
      ...(browserPath !== undefined ? { browserPath } : {}),
      onNotice: (m) => console.log(`  ${m}`),
    });
    port = result.port;
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
  const family = parseBrowserFamily(args);
  const profileDir = parseFlag(args, "--profile");
  const browserPath = parseFlag(args, "--browser");
  const result = await ensureBrowser({
    port: parsePort(args, browserDebugPort(family)),
    ...(family !== undefined ? { family } : {}),
    ...(profileDir !== undefined ? { profileDir } : {}),
    ...(browserPath !== undefined ? { browserPath } : {}),
    onNotice: (m) => console.log(`  ${m}`),
  });

  console.log(
    result.launched
      ? `✓ 已開 ${result.browser.name}，debug port ${result.port}`
      : `✓ debug port ${result.port} 本來就有人在聽，沿用既有的瀏覽器`,
  );
  if (result.port !== result.requestedPort) {
    console.log(`  ⚠ 不是你要的 :${result.requestedPort} —— 之後的指令要帶 --port ${result.port}`);
  }
  console.log(`  profile：${result.profileDir}`);
  // 托盤是照**配置的客戶端種類**去找 DevToolsActivePort 的，種類選錯就會接到
  // 另一個瀏覽器的遊戲去（而畫面上看不出來）。開的當下講一句最省事。
  console.log(
    `  托盤那邊把配置的「客戶端」選成 ${result.browser.family === "edge" ? "Edge" : "Chrome"}。`,
  );
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

/** 等待期間每隔這麼多次重試提醒一次（2 秒 × 15 = 30 秒）。 */
const CONNECT_NAG_EVERY = 15;

/**
 * 一直等到連得上為止。回傳分頁標題。
 *
 * ⚠ 沒有次數上限是刻意的。這支指令的預期用法是「開著它，然後去玩」——
 * 玩家什麼時候開遊戲、開幾次、中途關掉再開，都不該讓插件自己結束。
 *
 * ⚠ 但**不能安靜地等**。埠打錯的話症狀會是「跑起來之後什麼都沒發生」，
 * 而真正的原因（連不上那個埠）只在第一行閃過去。所以每 30 秒把原因重印
 * 一次，並且把等的是哪個埠講出來。
 */
async function connectWhenReady(
  adapter: ReturnType<typeof createCdpAdapter>,
  port: number,
  shouldStop: () => boolean,
): Promise<string | null> {
  for (let attempt = 1; !shouldStop(); attempt++) {
    try {
      const session = await adapter.connect();
      await adapter.waitForGame();
      return session.title;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt === 1) {
        console.log(`  等遊戲…（${reason}）`);
      } else if (attempt % CONNECT_NAG_EVERY === 0) {
        const waited = Math.round((attempt * CONNECT_RETRY_MS) / 1000);
        console.log(`  還在等 :${port}（已經 ${waited} 秒）—— 埠對嗎？遊戲有帶 debug port 嗎？`);
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  return null;
}

/**
 * 移動階段仲裁（WP-12 + WP-15 的側通道）。
 *
 * ⚠ **這會改變遊戲行為**，而且現在有兩條路會送出 `I_am_ok`：
 *
 *   準備功能    按下 OK 先壓著，等對手也好了才真的送出（再按一次可取消）
 *   約定秒數    時間到了**就算玩家沒按也送**，把 30 秒的階段縮成講好的長度
 *
 * 第二條只有在**雙方都同意**時才會啟用 —— 沒配到對手時共同值會退回滿版
 * 30 秒（`soloSettings()`），因為單方面縮短只是讓自己更早承諾。
 *
 * ⚠ **邏輯全部在 `@ulr/arbiter-engine`，這裡只負責印字。** 托盤跑的是同一份 ——
 * 生命週期有六個「錯了就安靜失效」的細節（重連、換場、換階段、側通道比 CDP
 * 活得久、runner 每次重連換一個、拆 patch），複製一份到 UI 那邊只會漂移。
 */
async function cmdArbiter(args: string[]): Promise<number> {
  const policyRaw = parseFlag(args, "--policy") ?? "either";
  if (policyRaw !== "either" && policyRaw !== "opponent" && policyRaw !== "never") {
    console.error(`--policy 只能是 either / opponent / never，收到 ${policyRaw}`);
    return 1;
  }
  const secondsRaw = parseFlag(args, "--seconds");
  // `--link-port`（純數字）是舊用法，parseLinkTarget 把數字當成本機的埠。
  const linkRaw = parseFlag(args, "--link") ?? parseFlag(args, "--link-port");
  const deadlineRaw = parseFlag(args, "--deadline");

  const engine = new ArbiterEngine({
    port: parsePort(args),
    ...(linkRaw !== undefined ? { link: linkRaw } : {}),
    ...(args.includes("--no-link") ? { noLink: true } : {}),
    policy: policyRaw,
    ...(deadlineRaw !== undefined ? { deadlineSeconds: Number(deadlineRaw) } : {}),
    prefs: {
      phaseSeconds: Number(parseFlag(args, "--phase-seconds") ?? MOVE_PHASE_TOTAL_SECONDS),
      hazardShortenSeconds: Number(
        parseFlag(args, "--hazard-shorten") ?? DEFAULT_HAZARD_SHORTEN_SECONDS,
      ),
      readyEnabled: !args.includes("--no-ready"),
    },
    onLog: (line) => console.log(line),
    onStatus: (status) => {
      // 只在**摘要真的變了**的時候印一行。狀態每個 tick 都會發，
      // 不去重的話終端機會被洗掉，反而看不到真正該注意的那一行。
      const line =
        `  ${describeLink(status.link)}` +
        `  階段=${status.capSeconds === null ? "不縮短" : `${status.capSeconds}s`}` +
        `${status.hazard ? "（聖水+麻痺）" : ""}` +
        `  座位=${status.seat ?? "?"}` +
        `${status.error === null ? "" : `  ✗ ${status.error}`}`;
      if (line === lastLine) return;
      lastLine = line;
      console.log(line);
    },
  });

  let lastLine = "";
  await engine.start();
  console.log(`✓ 仲裁已啟動  策略=${policyRaw}  我方希望的階段長度=${engine.prefs.phaseSeconds}s`);
  console.log("  按下 OK 會被壓住；再按一次取消；對手一動也會解除。");
  console.log("  沒配到對手時秒數不會縮短 —— 單方面縮短只是自己更早承諾。");
  console.log("  遊戲不必先開，關掉再開也不用重跑這支。Ctrl+C 結束。\n");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    if (secondsRaw !== undefined) setTimeout(resolve, Number(secondsRaw) * 1000);
  });

  await engine.stop();
  console.log("\n✓ 已收手（頁面上的攔截已拆除）");
  return 0;
}

function describeLink(status: string): string {
  return (
    {
      offline: "側通道 離線",
      solo: "側通道 已連上、還沒配到對手",
      paired: "側通道 已配對",
      incompatible: "側通道 ⚠ 版本不合，退回單邊",
    }[status] ?? status
  );
}

/**
 * 演出加速（WP-14）。
 *
 * ⚠ **這會改變畫面，但不會改變遊戲行為** —— 只有 tween 與 sprite 動畫變快，
 * 送出的東西、伺服器判定、倒數計時全部不變。
 *
 * 收益要講實話：實測約 1 分鐘／場。省的是「決策窗開頭被殘留動畫擋住」那段
 * （okVisibleX 到了但點不下去），不是整場對戰。伺服器排程的部分（一場約
 * 230 秒）客戶端動不了 —— 見 docs/battle-timing.md。
 *
 * 跟 `arbiter` 一樣要能全程掛著：遊戲還沒開就等、關掉再開會自己接回去。
 */
async function cmdSpeed(args: string[]): Promise<number> {
  const port = parsePort(args);
  const factorRaw = parseFlag(args, "--factor");
  const factor = factorRaw === undefined ? undefined : Number(factorRaw);
  if (factor !== undefined && (!Number.isFinite(factor) || factor < 1)) {
    console.error(`--factor 要是 ≥1 的數字，收到 ${String(factorRaw)}`);
    return 1;
  }
  const secondsRaw = parseFlag(args, "--seconds");

  let stopping = false;
  const stopped = new Promise<void>((resolve) => {
    const finish = (): void => {
      stopping = true;
      resolve();
    };
    process.on("SIGINT", finish);
    if (secondsRaw !== undefined) setTimeout(finish, Number(secondsRaw) * 1000);
  });

  for (let attach = 1; !stopping; attach++) {
    const adapter = createCdpAdapter({ port });
    try {
      const title = await connectWhenReady(adapter, port, () => stopping);
      if (title === null) break;
      console.log(attach === 1 ? `✓ 接上「${title}」` : `✓ 重新接上「${title}」`);

      const lost = new Promise<string>((resolve) => {
        adapter.onDisconnect(resolve);
      });

      // 場景每個階段會換，所以只在**組合變了**的時候印一行，不然會洗畫面。
      adapter.onSpeedPatchReport((r) => {
        if (r.type === "speed-patch-error") console.error(`  ✗ ${r.reason}`);
        else console.log(`  ×${r.factor}  ${r.sceneKeys.join(" ")}`);
      });

      const status = await adapter.installSpeedPatch(factor !== undefined ? { factor } : {});
      if (attach === 1) {
        console.log("");
        console.log("  只加速演出（tween 與逐格動畫）。倒數計時、出牌判定、");
        console.log("  伺服器結算全部不變 —— 倒數住在 scene.time，這支刻意不碰它，");
        console.log("  否則 WP-12 的硬底線會跟著提早觸發。");
        console.log("");
        console.log("  預期收益約 1 分鐘／場。伺服器排程那 230 秒動不了。");
        console.log("  Ctrl+C 結束（會自動還原）。");
        if (status === "waiting") console.log("  還沒進遊戲 —— 進去之後會自己套上，不必重跑。");
        console.log("");
      }

      /**
       * ⚠ **一定要續約，否則 10 秒後頁面會自己還原成原速。**
       *
       * 那個租約是為了「插件當掉時加速不要留在頁面上」而存在的（見
       * `patch-speed.ts` 的 `DEFAULT_SPEED_LEASE_MS`）。它不分是誰在裝，
       * 所以命令列版本也要證明自己還活著 —— 少了這一段，症狀是
       * 「跑起來有效，過十秒自己變回原速」，而且什麼錯誤都不會印。
       */
      const renew = setInterval(() => {
        void adapter
          .renewSpeedLease()
          .then(async (r) => {
            // 玩家重載過遊戲 → 頁面上那份沒了，重裝。
            if (r === "not-installed") {
              await adapter.installSpeedPatch(factor !== undefined ? { factor } : {});
              console.log("  ⟳ 遊戲重載過，加速已重新套上");
            }
          })
          .catch(() => {
            // 連線正在死。下面那條 race 會處理，這裡不必吵。
          });
      }, SPEED_RENEW_MS);

      const reason = await Promise.race([lost, stopped.then(() => null)]);
      clearInterval(renew);
      if (reason !== null) {
        // 連線死了就不要再 evaluate —— 只會再拋一次錯。頁面那邊：遊戲還在的話
        // 加速仍然套著（無害，但要還原），重連之後 install 會先拆再裝。
        console.log(`\n⟳ 連線斷了（${reason}）—— 遊戲關掉了嗎？重新連…\n`);
        continue;
      }

      try {
        const gone = await adapter.uninstallSpeedPatch();
        console.log(gone === "uninstalled" ? "\n✓ 已還原成原速" : "\n（本來就沒裝）");
      } catch (err) {
        console.error(`\n✗ 還原失敗：${err instanceof Error ? err.message : String(err)}`);
        console.error("  遊戲重載一次就會乾淨（頁面上的加速不會跨載入存活）。");
      }
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      if (stopping) break;
      console.log("⟳ 重新連…\n");
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    } finally {
      await adapter.disconnect();
    }
  }
  return 0;
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
    const { pkg, short, staleHash } = result.value;
    console.log(`✓ ${pkg.rule.name} ${pkg.rule.version}  (${short})`);
    console.log(`  發布者   ${pkg.rule.publisher.name}`);
    console.log(`  上限     ${pkg.rule.teamCostLimit}`);
    // 四張表分開列。一個總數看不出「這份規則管不管裝備」，而那是拿到別人的
    // 規則檔時第一個要知道的事。
    for (const [label, table] of [
      ["角色  ", pkg.rule.characters],
      ["怪物  ", pkg.rule.monsters],
      ["裝備  ", pkg.rule.equipment],
      ["事件卡", pkg.rule.eventCards],
    ] as const) {
      const n = Object.keys(table ?? {}).length;
      console.log(`  ${label}   ${n === 0 ? "沒定價，用原版" : `${n} 筆`}`);
    }
    if (staleHash !== null) {
      // 核對碼是拿來跟對手比的，變了就一定要說 —— 不然兩邊會比到不同的東西。
      console.log(`  ⚠ 這個檔案被直接改過，核對碼已重算：${staleHash.claimedShort} → ${short}`);
      console.log("    對手手上那份是舊的，把這個檔案傳給他。");
    }
    return 0;
  }

  const rule = assertCostRule(raw);
  console.log(`✓ ${rule.name} ${rule.version}  (${shortHash(contentHash(rule))})`);
  return 0;
}

/**
 * 從檔案取出規則內容。裸規則與規則包都收。
 *
 * 規則包一律走 `loadRulePackage` —— 它會驗**內容**（schema），Hash 則是
 * 從內容重算的。所以直接編輯過的包在這裡是正常輸入，只是會多印一行提醒
 * 說核對碼變了（對手手上那份的碼已經不一樣了，要重傳）。
 */
function extractRule(path: string): CostRule {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (typeof raw === "object" && raw !== null && "packageVersion" in raw) {
    const result = loadRulePackage(raw);
    if (!result.ok) throw new Error(`[${result.code}] ${result.message}`);
    const { staleHash, short } = result.value;
    if (staleHash !== null) {
      console.error(`⚠ 這個包被直接編輯過，核對碼已重算：${staleHash.claimedShort} → ${short}`);
      console.error("  對手手上那份的碼是舊的，改完記得把新檔案傳給他。");
    }
    return result.value.pkg.rule;
  }
  return assertCostRule(raw);
}

/** `<名字>.ulrcost.json`；已經是的話就原樣。 */
function packageFileName(rule: CostRule): string {
  const slug = rule.ruleSetId.replace("/", "-");
  return `${slug}-${rule.version}${RULE_PACKAGE_EXTENSION}`;
}

/**
 * 規則 → 封好 Hash 的規則包。裸規則與（改過的）規則包都收。
 *
 * 這是「自訂完之後要給對手」的最後一步 —— Hash 一律重算，所以
 * **直接拿改過的 `.ulrcost.json` 進來就對了**，不必先 unpack。
 */
function cmdPack(args: string[]): number {
  const path = args[1];
  if (path === undefined || path.startsWith("--")) {
    console.error("要給一個規則檔（裸規則或規則包都可以）。");
    return 1;
  }

  const rule = extractRule(path);
  const pkg = createRulePackage(rule, { exportedBy: "ulr-companion pack" });
  const out = parseFlag(args, "--out") ?? packageFileName(rule);

  writeFileSync(out, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`✓ ${rule.name} ${rule.version} → ${out}`);
  console.log(`  contentHash ${shortHash(pkg.contentHash)}`);
  console.log("  ⚠ 對手載入時要核對的就是這 8 碼。改了任何一個字都要重新 pack。");
  return 0;
}

/**
 * 規則包 → 裸規則，方便編輯。
 *
 * ⚠ **這已經不是改 COST 的必要步驟了。** Hash 會在載入與 pack 時重算，所以
 * 直接編輯 `.ulrcost.json` 是支援的做法。留著 unpack 是因為裸規則少一層
 * 信封、比較好讀，diff 起來也乾淨。
 */
function cmdUnpack(args: string[]): number {
  const path = args[1];
  if (path === undefined || path.startsWith("--")) {
    console.error("要給一個規則包。");
    return 1;
  }

  const rule = extractRule(path);
  const out = parseFlag(args, "--out") ?? `${rule.ruleSetId.replace("/", "-")}.rule.json`;

  writeFileSync(out, `${JSON.stringify(rule, null, 2)}\n`, "utf8");
  console.log(`✓ ${rule.name} ${rule.version} → ${out}`);
  console.log(`  角色 ${Object.keys(rule.characters).length} 筆`);
  console.log("  改完之後跑 `companion pack` 封回去，才能給對手。");
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
      case "speed":
        return await cmdSpeed(args);
      case "web":
        return await cmdWeb(args);
      case "rule":
        return cmdRule(args);
      case "catalog":
        return await cmdCatalog(args);
      case "official-rule":
        return await cmdOfficialRule(args);
      case "pack":
        return cmdPack(args);
      case "unpack":
        return cmdUnpack(args);
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
