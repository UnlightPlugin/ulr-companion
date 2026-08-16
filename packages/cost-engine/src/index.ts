/**
 * @ulr/cost-engine — WP-02
 * ==========================
 * 兩件事，分兩支檔案：
 *
 * | 檔案             | 回答的問題                                       |
 * | ---------------- | ------------------------------------------------ |
 * | `team-cost.ts`   | 這副牌在這份規則下是幾 COST？                    |
 * | `evaluation.ts`  | **這副牌在兩份規則下算出來的東西一不一樣？**     |
 *
 * 第二支是 WP-16 的配對前提：整張 COST 表的 hash 只回答得了「兩份規則是不是
 * 同一份」，而配對真正要問的是「這一場的計算結果一不一樣」。差在一個雙方都
 * 沒帶上場的新角色，那兩份規則對**這一場**是等價的。
 */

export { calculateTeamCost, isSlotSource, UNKNOWN_COST } from "./team-cost.js";
export type {
  CompressionPair,
  CostBreakdownItem,
  CostCalculation,
  TeamComposition,
  TeamMember,
} from "./team-cost.js";

export {
  canonicalDeck,
  crossVerdict,
  describeDisagreement,
  deckFromKeys,
  EVALUATION_FORMAT_VERSION,
  evaluateDeck,
  evaluationHash,
  fingerprint,
  isDeckDescriptor,
  parseDeckDescriptor,
} from "./evaluation.js";
export type {
  Compatibility,
  CrossEvaluation,
  DeckDescriptor,
  DeckKeys,
  EvaluationRecord,
} from "./evaluation.js";
