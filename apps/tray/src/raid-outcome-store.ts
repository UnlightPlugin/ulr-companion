/**
 * 每個渦拿到結算了沒＋道具對帳（「今天有幾個渦沒獎勵」與找規律用）
 * ================================================================
 * 引擎每打一場、每收到結算、每次人在渦房讀到清單、官方每重讀一次道具清單都會更新
 * （見 `@ulr/arbiter-engine` 的 raid-track.ts），這裡負責落地：托盤重開、玩家離線
 * 一整天，還在等結算的渦與上次的道具數量都接得上。留一個月。只放本機、不進任何同步。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseOutcomeState, type RaidOutcomeState } from "@ulr/arbiter-engine";

export const RAID_OUTCOMES_PATH = join(homedir(), ".ulr-companion", "raid-outcomes.json");

/** 讀不到、壞掉一律回空的 —— 少了只是從現在開始記。 */
export function readRaidOutcomes(path: string = RAID_OUTCOMES_PATH): RaidOutcomeState {
  let state: RaidOutcomeState;
  try {
    state = parseOutcomeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    state = parseOutcomeState(null);
  }
  return mergeImport(state, path);
}

/**
 * 旁邊有 `raid-outcomes.import.json`（從舊記錄檔補出來的歷史）就併進來：這邊沒有的渦才收，
 * 併完寫回、把匯入檔改名成 `.imported`，下次不會再併。托盤跑著時直接改主檔會被它下一次
 * 存檔蓋掉，所以走這條。
 */
function mergeImport(state: RaidOutcomeState, path: string): RaidOutcomeState {
  const importPath = path.replace(/\.json$/, ".import.json");
  if (!existsSync(importPath)) return state;
  try {
    const add = parseOutcomeState(JSON.parse(readFileSync(importPath, "utf8"))).outcomes;
    const have = new Set(state.outcomes.map((x) => x.key));
    const merged: RaidOutcomeState = {
      outcomes: [...add.filter((x) => !have.has(x.key)), ...state.outcomes],
      ledger: state.ledger,
    };
    writeRaidOutcomes(merged, path);
    renameSync(importPath, `${importPath}.imported`);
    return merged;
  } catch {
    return state;
  }
}

export function writeRaidOutcomes(
  state: RaidOutcomeState,
  path: string = RAID_OUTCOMES_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, outcomes: state.outcomes, ledger: state.ledger })}\n`,
    "utf8",
  );
}
