/**
 * 任務 HighLow 格的獎勵遊戲：開始星數邊玩邊學
 * ============================================
 * HighLow 格（treasure_no 70001～70008）是獎勵遊戲 LV1～LV8。原版伺服器（reward.rb）用等級
 * 墊高開始的步數與上限，但 ULR 的獎勵遊戲是重寫過的（客戶端星條照 step / 100 畫，原版的
 * 步數是 141～200），等級 → 開始星數對不回原版，只能學。
 *
 * 做法：進獎勵遊戲時官方本來就會送 db_bonusgame 拿 step（星條旁邊那個數字），頁面在官方
 * initialize 之前記下那個 step，配上人物站的那一格是幾級，回報一筆樣本。**不多送請求。**
 *
 * 2026-09-26 玩家回報：「歷戰的勇士們2」那兩格 HighLow 都是 LV4。
 */

/** 一次獎勵遊戲開始時的樣本。 */
export interface QuestBonusSample {
  /** HighLow 格的等級（1～8）。 */
  level: number;
  /** 開始的 step（星條旁邊的數字）。 */
  step: number;
  /** 任務 id。 */
  quest: number;
  /** 格子，「列_欄」。 */
  land: string;
  /** 什麼時候（ms）。 */
  at: number;
}

export interface QuestBonusReport {
  type: "quest-bonus";
  sample: QuestBonusSample;
}

/** 每個等級學到的開始 step：最小、最大、幾筆。 */
export type QuestBonusStats = Record<number, { min: number; max: number; n: number }>;

/** 最多留幾筆樣本（舊的先丟）。 */
export const QUEST_BONUS_SAMPLE_CAP = 500;

function isSample(value: unknown): value is QuestBonusSample {
  const s = value as Record<string, unknown> | null;
  return (
    typeof value === "object" &&
    s !== null &&
    Number.isInteger(s["level"]) &&
    (s["level"] as number) >= 1 &&
    (s["level"] as number) <= 8 &&
    typeof s["step"] === "number" &&
    Number.isFinite(s["step"]) &&
    typeof s["quest"] === "number" &&
    typeof s["land"] === "string" &&
    typeof s["at"] === "number"
  );
}

export function isQuestBonusReport(value: unknown): value is QuestBonusReport {
  const o = value as { type?: unknown; sample?: unknown } | null;
  return typeof value === "object" && o !== null && o.type === "quest-bonus" && isSample(o.sample);
}

/** 讀檔用：壞掉的那一筆丟掉，其他照收。 */
export function parseQuestBonusSamples(raw: unknown): QuestBonusSample[] {
  const o = raw as { samples?: unknown } | null;
  const src = typeof raw === "object" && o !== null ? o.samples : null;
  if (!Array.isArray(src)) return [];
  return src.filter(isSample).map((s) => ({
    level: s.level,
    step: s.step,
    quest: s.quest,
    land: s.land,
    at: s.at,
  }));
}

/** 加一筆；超過上限丟最舊的。 */
export function appendQuestBonusSample(
  samples: readonly QuestBonusSample[],
  sample: QuestBonusSample,
  cap: number = QUEST_BONUS_SAMPLE_CAP,
): QuestBonusSample[] {
  const out = [...samples, sample];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function summarizeQuestBonus(samples: readonly QuestBonusSample[]): QuestBonusStats {
  const out: QuestBonusStats = {};
  for (const s of samples) {
    const cur = out[s.level];
    out[s.level] =
      cur === undefined
        ? { min: s.step, max: s.step, n: 1 }
        : { min: Math.min(cur.min, s.step), max: Math.max(cur.max, s.step), n: cur.n + 1 };
  }
  return out;
}
