/**
 * 依規則計算隊伍 COST（WP-02）
 * ==============================
 *
 * 規格書 §9 的驗收要點只有一句，但它是整個 package 的設計約束：
 *
 *     「同一規則與輸入必須得到確定性結果」
 *
 * 所以這裡的每個函式都必須是純函式 —— 不讀時間、不讀亂數、不讀全域狀態、
 * 不碰網路。雙方玩家在各自的電腦上對同一副牌組跑，必須得到同一個數字，
 * 否則 Room 一致性判定就沒有意義了。
 *
 * ## 壓 C 的語義來自客戶端本體，不是猜的
 *
 * 「差距」是**隊內每一對角色之間的差距**，三名角色就是三對，每一對各自
 * 罰一次。這不是推測 —— 是從跑著的客戶端挖出來的原始碼確認的，出處與
 * 完整推導見 [docs/official-cost-rule.md](../../../docs/official-cost-rule.md)。
 *
 * 武器與事件卡**計入總和但不參與壓 C**，官方就是這樣算的。
 *
 * ## 怪物卡走的是角色那條路，不是第四條
 *
 * 一副牌組是四張表組合出來的，但它們**不是四個平行的加總項目**。客戶端的
 * `Chara.getAsset()` 照 `deck.chara[n]` 的前綴分流（`cc` → `cc_asset`、
 * `mc` → `mc_asset`），兩種卡放的是同樣那三個槽位，也一起被 push 進
 * `costcheck()` 的 `deckArray` —— 所以**怪物照樣參與壓 C**。
 *
 * 換句話說是「3 + 1」：三個槽位（角色或怪物）＋ 各自的武器 ＋ 事件卡。
 */

import { toCentiCost } from "@ulr/rule-schema";
import type { CentiCost, CostRule, GapBand } from "@ulr/rule-schema";

/**
 * 規則沒有定價時當成多少。
 *
 * 對齊客戶端 `src/deck/cost-check.ts` 的 `var UNKNOWN_COST = 99`：
 * 遊戲查不到 asset 時就用 99，而且**這個 99 會照常參與壓 C 計算**。
 * 我們跟著做，總和才會跟玩家畫面上看到的一致。
 *
 * ⚠ 不能改成 0。那會讓「規則漏寫了某張卡」的超標隊伍看起來合法 ——
 * 99 很醒目，配上 `unknownIds` 才是誠實的降級行為。
 */
export const UNKNOWN_COST = 99;

/** 一個上場的槽位。欄位對應到 CDP 抓到的牌組封包。 */
export interface TeamMember {
  /**
   * 這一格放的卡。**角色與怪物共用這個欄位**，因為遊戲裡它們就是同一種槽位。
   *
   * 正規鍵是資產的 filename：角色 `cc078_04`（`cc_asset`）、
   * 怪物 `mc001_01`（`mc_asset`）。前綴分得開，所以查表不需要另外標型別。
   */
  characterId: string;
  /** 裝備的武器，對應 rule.equipment 的鍵（`wp001`） */
  equipmentId?: string;
}

export interface TeamComposition {
  /** 只放**實際有卡的槽**。空槽不要放進來，它們不參與壓 C。 */
  members: TeamMember[];
  /**
   * **不綁槽位**的裝備清單，對應 rule.equipment。
   *
   * 跟 `TeamMember.equipmentId` 是兩條並存的路，兩邊都會計入總和：
   * 讀真的牌組時武器是綁在槽位上的（`deck.weapon[i]` ↔ 槽位 i），走 member；
   * 從已排序的描述子還原時綁不回去，走這裡。⚠ 同一把武器不要兩邊都填。
   */
  equipment?: string[];
  /** 事件卡 ID 清單，對應 rule.eventCards */
  eventCards?: string[];
}

/**
 * 逐項列出每一分 COST 是哪來的 —— 遊戲內要顯示明細，玩家才信得過。
 *
 * ⚠ 所有數值都是 **CentiCost（整數百分之一）**，不是十進位 COST。
 * `8.8 + 26.6 + 26.6` 用 double 相加是 62.00000000000001，剛好卡滿 62
 * 上限的隊伍會被誤判超標。用 `toCentiCost` 轉進來、`formatCentiCost` 顯示。
 */
export interface CostBreakdownItem {
  /**
   * ⚠ `character` 與 `monster` 是**同一種槽位**，只是查了不同的表。要判斷
   * 「這一項參不參與壓 C」請用 `isSlotSource()`，不要寫 `=== "character"`
   * —— 那會讓怪物在明細裡被當成武器一類的加項。
   */
  source: "character" | "monster" | "equipment" | "eventCard" | "compression";
  id: string;
  cost: CentiCost;
}

/** 這一項是不是佔了三個槽位其中之一（＝參與壓 C）。 */
export function isSlotSource(source: CostBreakdownItem["source"]): boolean {
  return source === "character" || source === "monster";
}

/**
 * 一對觸發壓 C 的角色。
 *
 * 有這個才answer得了玩家的「為什麼罰我 5C」—— 光給總和，兩個人算出不同
 * 數字時沒人查得出是哪一對造成的。⚠ 遊戲自己的畫面**做不到**這件事，
 * 見 docs/official-cost-rule.md 的「罰 C 標記貼錯卡」。
 */
export interface CompressionPair {
  /** `members` 的索引，恆有 a < b */
  a: number;
  b: number;
  /** |cost(a) − cost(b)|，CentiCost */
  gap: CentiCost;
  /** 這一對追加的 COST，CentiCost */
  extraCost: CentiCost;
}

export interface CostCalculation {
  total: CentiCost;
  /** 規則宣告的上限。0 或負數代表**不設限**，見 `overLimit`。 */
  limit: CentiCost;
  /**
   * 超標了沒。
   *
   * `limit <= 0` 一律視為不設限 → 永遠 false。UNLIGHT 的 COST 上限是
   * 伺服器按頻道下發的（Match 的 `channels[3].cost`），客戶端裡根本沒有
   * 這個常數，所以「這份規則不管上限」是合法且常見的狀態。
   */
  overLimit: boolean;
  items: CostBreakdownItem[];
  /** 規則裡沒有定價的東西。不能默默當 0，那會讓超標的隊伍看起來合法。 */
  unknownIds: string[];
  /** 壓 C 的明細，逐對列出。沒有壓 C 時是空陣列。 */
  compression: CompressionPair[];
}

/**
 * 查一個差距落在哪個區間，回傳追加的 COST（CentiCost）。沒中就是 0。
 *
 * 區間不重疊由 `validateCostRule` 保證（`band.overlap`），所以這裡取
 * 第一個命中的即可 —— 但仍然照陣列順序找，讓沒驗證過的規則也有確定性結果。
 */
function matchBand(bands: readonly GapBand[], gap: CentiCost): CentiCost {
  for (const band of bands) {
    const min = toCentiCost(band.minGap);
    if (gap < min) continue;
    if (band.maxGap !== undefined && gap > toCentiCost(band.maxGap)) continue;
    return toCentiCost(band.extraCost);
  }
  return 0;
}

/**
 * 依序查幾張表，查不到就回 UNKNOWN_COST 並登記到 unknownIds。
 *
 * 吃多張表是為了角色／怪物那個共用的槽位。⚠ 順序在這裡**不影響結果**：
 * `cc` 與 `mc` 兩組鍵不可能互撞，所以先查哪一張都一樣 —— 但仍然照固定順序
 * 查，讓一份亂寫的規則（同一個鍵同時出現在兩張表裡）也有確定性結果。
 */
function priceOf(
  tables: readonly (Readonly<Record<string, number>> | undefined)[],
  id: string,
  unknownIds: string[],
): CentiCost {
  for (const table of tables) {
    const value = table?.[id];
    if (value !== undefined) return toCentiCost(value);
  }
  // 同一個 ID 出現兩次只登記一次，UI 才不會重複列同一則警告。
  if (!unknownIds.includes(id)) unknownIds.push(id);
  return toCentiCost(UNKNOWN_COST);
}

/**
 * 計算隊伍總 COST。
 *
 * 順序固定為 槽位（角色／怪物）→ 裝備 → 事件卡 → 壓 C，`items` 就照這個
 * 順序排 —— 明細的呈現順序也是輸出的一部分，兩台電腦顯示不同順序會讓人
 * 以為算錯了。
 */
export function calculateTeamCost(rule: CostRule, team: TeamComposition): CostCalculation {
  const unknownIds: string[] = [];
  const items: CostBreakdownItem[] = [];

  // ── 槽位（角色或怪物）────────────────────────────────────────────────
  // 這一格的 COST 要留著給壓 C 用，所以先收集起來再往下走。
  const slotTables = [rule.characters, rule.monsters] as const;
  const slotCosts: CentiCost[] = team.members.map((m) =>
    priceOf(slotTables, m.characterId, unknownIds),
  );
  team.members.forEach((m, i) => {
    // 查得到才分得出是角色還是怪物；兩張表都沒有時（算成 99C）就照鍵的前綴猜，
    // 猜不到當角色。這只影響明細怎麼標示，不影響任何數字。
    const monster =
      rule.monsters?.[m.characterId] !== undefined ||
      (rule.characters[m.characterId] === undefined && m.characterId.startsWith("mc"));
    items.push({
      source: monster ? "monster" : "character",
      id: m.characterId,
      cost: slotCosts[i]!,
    });
  });

  // ── 裝備 ──────────────────────────────────────────────────────────────
  // 綁槽位的先、不綁的後。順序固定就好，兩者的和一樣。
  const equipmentIds = [
    ...team.members.map((m) => m.equipmentId).filter((id): id is string => id !== undefined),
    ...(team.equipment ?? []),
  ];
  for (const id of equipmentIds) {
    items.push({ source: "equipment", id, cost: priceOf([rule.equipment], id, unknownIds) });
  }

  // ── 事件卡 ────────────────────────────────────────────────────────────
  for (const id of team.eventCards ?? []) {
    items.push({ source: "eventCard", id, cost: priceOf([rule.eventCards], id, unknownIds) });
  }

  // ── 壓 C ──────────────────────────────────────────────────────────────
  // 每一對**槽位**各判一次。⚠ 怪物也在裡面（它佔的就是角色的位子），但武器
  // 與事件卡不在 —— 它們計入總和卻不影響差距，官方 costcheck 的 deckArray
  // 就只 push 那三個槽位的 cost。
  const compression: CompressionPair[] = [];
  const bands = rule.compressionRule?.type === "gap-band-v1" ? rule.compressionRule.bands : null;
  if (bands !== null) {
    for (let a = 0; a < slotCosts.length; a++) {
      for (let b = a + 1; b < slotCosts.length; b++) {
        const gap = Math.abs(slotCosts[a]! - slotCosts[b]!);
        const extraCost = matchBand(bands, gap);
        if (extraCost === 0) continue;
        compression.push({ a, b, gap, extraCost });
        items.push({
          source: "compression",
          id: `${team.members[a]!.characterId}+${team.members[b]!.characterId}`,
          cost: extraCost,
        });
      }
    }
  }

  // 整數加總。這裡不能用 COST 直接相加，見 cost-number.ts 的說明。
  let total = 0;
  for (const item of items) total += item.cost;

  const limit = toCentiCost(rule.teamCostLimit);
  return { total, limit, overLimit: limit > 0 && total > limit, items, unknownIds, compression };
}
