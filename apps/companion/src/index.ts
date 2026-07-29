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

import { readFileSync } from "node:fs";
import { API_SCHEMA_VERSION } from "@ulr/api-contract";
import type { CostOverrides, CostPatchReport } from "@ulr/cdp-adapter";
import {
  BROWSER_DEBUG_PORT,
  createCdpAdapter,
  DEBUG_PORT_SWITCH,
  DEFAULT_DEBUG_PORT,
} from "@ulr/cdp-adapter";
import { assertCostRule, contentHash, loadRulePackage, shortHash } from "@ulr/rule-schema";

/** 套用之後等頁面回報的時間。cc_asset 在載入序列偏後面。 */
const REPORT_WAIT_MS = 15_000;

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
  console.log("  rule <規則檔.json>          載入並驗證規則包");
}

function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  if (i === -1) return DEFAULT_DEBUG_PORT;
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
