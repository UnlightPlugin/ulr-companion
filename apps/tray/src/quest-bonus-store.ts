/**
 * 學到的 HighLow 開始星數（寶箱標註用）
 * ====================================
 * 每進一次任務 HighLow 格的獎勵遊戲，引擎收一筆「幾級、開始 step」（見 `@ulr/cdp-adapter` 的
 * quest-bonus.ts），這裡負責落地，下次開托盤還在。
 *
 * 裡面只有等級、step、任務 id、格子與時間 —— 沒有玩家名字。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseQuestBonusSamples, type QuestBonusSample } from "@ulr/cdp-adapter";

export const QUEST_BONUS_PATH = join(homedir(), ".ulr-companion", "quest-bonus-learned.json");

/** 讀不到、壞掉一律回空的 —— 少了只是要重學。壞掉的那一筆丟掉，其他照收。 */
export function readQuestBonus(path: string = QUEST_BONUS_PATH): QuestBonusSample[] {
  try {
    return parseQuestBonusSamples(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

export function writeQuestBonus(
  samples: readonly QuestBonusSample[],
  path: string = QUEST_BONUS_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, samples }, null, 1)}\n`, "utf8");
}
