/**
 * 自己打渦的紀錄（打渦隊伍用）
 * ============================
 * 每一場：哪個渦（發現者＋發現時刻）、自己的名字、回合、AP、傷害、分數、用的那副牌。引擎拿它合成「隊伍」、
 * 開著分享時傳上看板（見 `@ulr/arbiter-engine` 的 raid-teams.ts）。
 *
 * **為什麼要落地**：看板上同一個人同一個渦是整份取代。只放記憶體的話托盤一重開，
 * 下一輪上傳的就是一份空的，把之前傳上去的蓋掉。
 *
 * 渦幾個小時就過期，過期的紀錄每次存檔都會被丟掉，這個檔不會一直長大。
 * 改版前（2026-09-23 以前）的紀錄用渦碼，讀進來時整批丟掉（那些渦早就過期）。
 * 只放本機、不進任何同步。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseBattleRecords, type RaidBattleRecord } from "@ulr/arbiter-engine";

export const RAID_BATTLES_PATH = join(homedir(), ".ulr-companion", "raid-battles.json");

/** 讀不到、壞掉一律回空的 —— 少了只是看不到舊的隊伍。 */
export function readRaidBattles(path: string = RAID_BATTLES_PATH): RaidBattleRecord[] {
  try {
    return parseBattleRecords(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

export function writeRaidBattles(
  records: readonly RaidBattleRecord[],
  path: string = RAID_BATTLES_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, battles: records })}\n`, "utf8");
}
