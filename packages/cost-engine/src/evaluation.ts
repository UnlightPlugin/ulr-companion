/**
 * 跨版本相容：一場對局的語義指紋（WP-16）
 * ==========================================
 * 配對要問的問題，原本被寫成這樣：
 *
 *     hash(整張 COST 表 A) == hash(整張 COST 表 B)
 *
 * 那判定的是**資料集同一性**，太嚴格。真正要問的是：
 *
 *     Eval(這一場的牌組, 規則 A) == Eval(這一場的牌組, 規則 B)
 *
 * 差別是真實的：兩份規則只差在最新角色的定價，而雙方都沒帶那隻角色上場 ——
 * 那個差異對這一場**沒有任何可觀測影響**，卻會讓整表 hash 不同而配不到對方。
 * 規則多發一版就把社群切成兩半，這是版本碎片化，不是公平性。
 *
 * 所以身分分成三層，**只有第三層是配對的閘門**：
 *
 * | 層                  | 是什麼                       | 用途                       |
 * | ------------------- | ---------------------------- | -------------------------- |
 * | `contentHash`       | 整份規則的 SHA-256           | 版本識別、統計、稽核       |
 * | 配對鍵              | `ruleSetId` + 頻道 + 上限…   | 決定排在哪一條佇列         |
 * | **`evaluationHash`**| **這一場的計算結果**         | **這一場能不能成立**       |
 *
 * ## ⚠ 只比總和是不夠的
 *
 * 兩份規則可以在總和上巧合地相等而內部完全不同：
 *
 * ```
 *   規則 A：20 + 20 + 20，壓 C −2  → 58
 *   規則 B：19 + 20 + 19，壓 C  0  → 58
 * ```
 *
 * 總和一樣，但單角 COST 不一樣 —— 之後任何看單角數字的限制或畫面都會產生
 * 歧義。所以指紋蓋的是**整份計算結果**：逐角定價、逐對壓 C、未定價清單、
 * 規則宣告的上限、總和。
 *
 * ## ⚠ 四次計算，不是兩次
 *
 * 「甲用 A 算自己 = 57，乙用 B 算自己 = 57」證明不了兩人在同一個規則宇宙。
 * 要成立的是**交叉**的四次：
 *
 * ```
 *   Eval(A, 甲牌) == Eval(B, 甲牌)   且   Eval(A, 乙牌) == Eval(B, 乙牌)
 * ```
 *
 * 每一邊各自算兩次、交換兩個指紋，`crossVerdict()` 做最後的比對。
 */

import { contentHash, formatCentiCost } from "@ulr/rule-schema";
import type { CostRule } from "@ulr/rule-schema";
import { calculateTeamCost, isSlotSource } from "./team-cost.js";

/**
 * 描述子與指紋的格式版本。
 *
 * ⚠ **改了這個數字，所有舊版插件都會判定跟新版不相容。** 那是刻意的：指紋
 * 的意義就是「同樣的輸入得到同樣的字串」，格式漂移而版本號沒動的話，兩邊會
 * 對同一副牌算出不同指紋，然後被判定成規則不相容 —— 而錯誤訊息會指向規則，
 * 玩家永遠找不到真正的原因。
 */
export const EVALUATION_FORMAT_VERSION = 2;

/**
 * 一副牌組裡「規則算得到的東西」。
 *
 * ## v1 → v2（2026-08-16）：四種卡全部納入
 *
 * v1 只有角色，因為當時武器與事件卡的正規鍵還沒定案。定案之後（`wp001` /
 * `ev091`，見 `@ulr/rule-schema` 的 card-key.ts）就補上了另外三種。
 *
 * ⚠ **v1 的插件會把 v2 判定成不相容**，那是刻意的：兩個版本對同一副有怪物
 * 或有裝備的牌會算出不同的指紋，沒有版本號的話錯誤訊息會指向規則，玩家永遠
 * 找不到真正的原因。
 */
export interface DeckDescriptor {
  v: typeof EVALUATION_FORMAT_VERSION;
  /**
   * 三個槽位的規則鍵，**字典序**。
   *
   * ⚠ **角色與怪物都在這裡。** 遊戲裡它們是同一種槽位（`Chara.getAsset()`
   * 照 `cc` / `mc` 前綴分流到不同的資產表），而且**都參與壓 C**。欄位名沿用
   * v1 的 `characters` 是為了不讓沒改到的地方靜靜地換語意。
   */
  characters: string[];
  /**
   * 裝備的規則鍵（`wp001`），**字典序**。
   *
   * ⚠ **重複不能去掉。** 三個角色可以各帶一把一樣的武器，那是三份 COST。
   */
  equipment: string[];
  /** 事件卡的規則鍵（`ev091`），**字典序**。重複同樣不能去掉（18 格可放同名卡）。 */
  eventCards: string[];
}

/** {@link deckFromKeys} 的輸入。空格用 `null`，會被丟掉。 */
export interface DeckKeys {
  /** 三個槽位，角色或怪物的 filename。 */
  characters: readonly (string | null | undefined)[];
  /** 每個槽位裝的武器。 */
  equipment?: readonly (string | null | undefined)[];
  /** 18 格事件卡。 */
  eventCards?: readonly (string | null | undefined)[];
}

/**
 * 一次計算的完整結果，**已經正規化成可以直接雜湊的樣子**。
 *
 * 數值一律是固定兩位小數的字串而不是數字：進 JCS 的是十進位表示法，而
 * `0.1 + 0.2` 這種尾巴會讓兩台電腦算出不同的字串。整數百分之一在引擎內部，
 * 到了指紋這一層轉成字串就沒有浮點的事了（見 `cost-number.ts`）。
 */
export interface EvaluationRecord {
  v: typeof EVALUATION_FORMAT_VERSION;
  /** `[規則鍵, "22.00"]`，順序同 {@link DeckDescriptor.characters}。含怪物。 */
  characters: [string, string][];
  /** `[規則鍵, "1.00"]`，順序同 {@link DeckDescriptor.equipment}。 */
  equipment: [string, string][];
  /** `[規則鍵, "0.00"]`，順序同 {@link DeckDescriptor.eventCards}。 */
  eventCards: [string, string][];
  /** `[鍵 A, 鍵 B, 差距, 追加]`，逐對列出。沒有壓 C 時是空陣列。 */
  compression: [string, string, string, string][];
  /** 這份規則沒有定價的鍵。⚠ 不是空的就代表兩邊都在用 99 這個代替值。 */
  unknown: string[];
  /** 規則宣告的隊伍上限。不設限是 `"none"`。 */
  limit: string;
  total: string;
}

/** 一邊用**自己那份規則**算出來的兩個指紋。角色用 host/guest，不用「我／對手」。 */
export interface CrossEvaluation {
  /** host 那副牌的指紋。 */
  host: string;
  /** guest 那副牌的指紋。 */
  guest: string;
}

/**
 * 兩份規則對這一場的關係。
 *
 * - `exact`        兩邊的 `contentHash` 就是同一個，不必再算
 * - `compatible`   規則不同，但這一場的四次計算完全一致
 * - `incompatible` 至少有一副牌在兩份規則下算出不同的東西
 */
export type Compatibility = "exact" | "compatible" | "incompatible";

// ---------------------------------------------------------------------------
// 描述子
// ---------------------------------------------------------------------------

/**
 * 把牌組的規則鍵整理成描述子。
 *
 * ⚠ **要排序。** 兩邊拿到的必須是位元相同的描述子，而槽位順序是玩家在牌組
 * 畫面上排的 —— 它不影響任何計算（壓 C 是每一對各判一次，跟順序無關），
 * 卻會讓指紋不同。排序之後「同樣三隻角色」就只有一種表示法。
 *
 * 空槽（`null`）直接丟掉：它們不參與任何計算。
 */
export function deckFromKeys(keys: DeckKeys): DeckDescriptor {
  const present = (list: readonly (string | null | undefined)[] | undefined): string[] =>
    (list ?? []).filter((k): k is string => typeof k === "string" && k !== "");
  return canonicalDeck({
    v: EVALUATION_FORMAT_VERSION,
    characters: present(keys.characters),
    equipment: present(keys.equipment),
    eventCards: present(keys.eventCards),
  });
}

/** 位元序，不是人類的排序 —— `localeCompare` 會受作業系統語系影響。 */
function byteOrder(list: readonly string[]): string[] {
  return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 把描述子排成唯一的表示法。已經是這個樣子的話回傳等值的新物件。 */
export function canonicalDeck(deck: DeckDescriptor): DeckDescriptor {
  return {
    v: EVALUATION_FORMAT_VERSION,
    characters: byteOrder(deck.characters),
    equipment: byteOrder(deck.equipment),
    eventCards: byteOrder(deck.eventCards),
  };
}

function isKeyList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((k) => typeof k === "string" && k.length > 0 && k.length <= 48)
  );
}

/** 這是不是一份能用的描述子。⚠ 從網路收來的東西一律先過這關。 */
export function isDeckDescriptor(value: unknown): value is DeckDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  if (d["v"] !== EVALUATION_FORMAT_VERSION) return false;
  return isKeyList(d["characters"]) && isKeyList(d["equipment"]) && isKeyList(d["eventCards"]);
}

/**
 * 解析對手送來的描述子。**壞掉一律回 `null`，絕不拋例外。**
 *
 * ⚠ 三個上限不是防呆而是防護：描述子會被拿去跑 O(n²) 的壓 C 迴圈，而一則塞了
 * 一千隻角色的訊息會讓對手的插件卡在那個迴圈裡。全部照遊戲的實際格數留一倍
 * 餘裕 —— 3 個槽位、3 把武器、18 格事件卡（2026-08-16 從跑著的客戶端讀到的
 * `deck1` 就是這個形狀）。
 */
export function parseDeckDescriptor(value: unknown): DeckDescriptor | null {
  if (!isDeckDescriptor(value)) return null;
  if (value.characters.length === 0 || value.characters.length > 6) return null;
  if (value.equipment.length > 6) return null;
  if (value.eventCards.length > 36) return null;
  return canonicalDeck(value);
}

// ---------------------------------------------------------------------------
// 計算與指紋
// ---------------------------------------------------------------------------

/**
 * 用一份規則算一副牌，輸出可雜湊的完整結果。
 *
 * **純函式** —— 同一份規則配同一副牌，在任何一台電腦上都得到位元相同的結果。
 * 整個跨版本相容判定就架在這句話上。
 */
export function evaluateDeck(rule: CostRule, deck: DeckDescriptor): EvaluationRecord {
  const canonical = canonicalDeck(deck);

  // ⚠ 描述子裡的武器**不綁槽位**。遊戲裡每個角色各帶一把，但描述子排過序了，
  // 誰帶哪一把在這裡拿不回來 —— 也不需要：武器不參與壓 C，只是加項，掛在哪一格
  // 對總和與指紋都沒有差別。所以走 `TeamComposition.equipment` 那條不綁槽位的路。
  const members = canonical.characters.map((characterId) => ({ characterId }));
  const result = calculateTeamCost(rule, {
    members,
    equipment: canonical.equipment,
    eventCards: canonical.eventCards,
  });

  const characters: [string, string][] = [];
  const equipment: [string, string][] = [];
  const eventCards: [string, string][] = [];
  for (const item of result.items) {
    const row: [string, string] = [item.id, formatCentiCost(item.cost)];
    if (isSlotSource(item.source)) characters.push(row);
    else if (item.source === "equipment") equipment.push(row);
    else if (item.source === "eventCard") eventCards.push(row);
  }

  const compression = result.compression.map((pair): [string, string, string, string] => [
    canonical.characters[pair.a] ?? "",
    canonical.characters[pair.b] ?? "",
    formatCentiCost(pair.gap),
    formatCentiCost(pair.extraCost),
  ]);

  return {
    v: EVALUATION_FORMAT_VERSION,
    characters,
    equipment,
    eventCards,
    compression,
    // ⚠ 也要排序：`unknownIds` 是照出現順序記的，而描述子已經排過了，
    // 所以這裡本來就會是同一個順序 —— 排一次是為了不依賴那個巧合。
    unknown: [...result.unknownIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    // ⚠ 上限是規則的一部分。兩份規則只差在 `teamCostLimit` 也是真的差異：
    // 同一副牌在一邊合法、另一邊超標，那不是同一場比賽。
    limit: result.limit > 0 ? formatCentiCost(result.limit) : "none",
    total: formatCentiCost(result.total),
  };
}

/**
 * 計算結果的指紋。走的是規則自己那套 canonical JSON（RFC 8785）+ SHA-256 ——
 * **同一套正規化**，所以 ULGG 那邊（PHP）照 docs/canonical-json.md 實作就對得上。
 */
export function evaluationHash(record: EvaluationRecord): string {
  return contentHash(record);
}

/** 一步到底：規則 + 牌組 → 指紋。 */
export function fingerprint(rule: CostRule, deck: DeckDescriptor): string {
  return evaluationHash(evaluateDeck(rule, deck));
}

// ---------------------------------------------------------------------------
// 判決
// ---------------------------------------------------------------------------

/**
 * 兩邊各自算完之後的最後一步。
 *
 * ⚠ **要兩副牌都對得起來才算數。** 只驗自己那副的話會發生這種事：
 *
 * ```
 *   甲的牌   規則 A → 60    規則 B → 61
 *   乙的牌   規則 A → 59    規則 B → 60
 * ```
 *
 * 兩人各自看到的數字都「合理」，但他們身處不同的規則宇宙 —— 同一場比賽裡，
 * 對手的隊伍在我眼中是 60、在他眼中是 61。
 */
export function crossVerdict(
  mine: CrossEvaluation,
  theirs: CrossEvaluation,
): "compatible" | "incompatible" {
  return mine.host === theirs.host && mine.guest === theirs.guest ? "compatible" : "incompatible";
}

/**
 * 判不相容時，是哪一副牌對不起來。**給玩家看的一句話。**
 *
 * ⚠ 只講「哪一副」，不講內容 —— 對手的牌組在這裡是拿來算指紋的，不是拿來
 * 顯示的（見 docs/match-making.md 的「對手的牌組不會出現在畫面上」）。
 */
export function describeDisagreement(mine: CrossEvaluation, theirs: CrossEvaluation): string {
  const bad: string[] = [];
  if (mine.host !== theirs.host) bad.push("開房方");
  if (mine.guest !== theirs.guest) bad.push("進房方");
  if (bad.length === 0) return "兩邊算出來的東西一致。";
  return `${bad.join("與")}的隊伍在兩份規則下算出來的 COST 不一樣。`;
}
