/**
 * 學到的渦獎勵表（渦房獎勵標記用）
 * ================================
 * 改版後渦清單沒有 TL，獎勵表只能邊打邊學：每收到一次結算，引擎依「渦鍵」併進這張表
 * （見 `@ulr/cdp-adapter` 的 raid-learned.ts），這裡負責落地，下次開托盤還在。
 *
 * 另外留一份 `log`：每一次結算的原料（含當時 ulgg 給的 stage），之後找「獎勵到底看什麼」用。
 *
 * 裡面只有怪物 id、階、★、區塊、stage 與獎勵碼 —— 沒有渦碼、沒有玩家名字。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseLearnedTable,
  parseLearnLog,
  type RaidLearnedTable,
  type RaidLearnSample,
} from "@ulr/cdp-adapter";

export const RAID_LEARNED_PATH = join(homedir(), ".ulr-companion", "raid-learned.json");

/** 讀不到、壞掉一律回空的 —— 少了只是要重學。壞掉的那一筆丟掉，其他照收。 */
export function readRaidLearned(path: string = RAID_LEARNED_PATH): {
  table: RaidLearnedTable;
  log: RaidLearnSample[];
} {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { table: parseLearnedTable(raw), log: parseLearnLog(raw) };
  } catch {
    return { table: {}, log: [] };
  }
}

export function writeRaidLearned(
  table: RaidLearnedTable,
  log: readonly RaidLearnSample[],
  path: string = RAID_LEARNED_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: table, log }, null, 1)}\n`, "utf8");
}
