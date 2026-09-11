/**
 * 庫存：這張卡玩家到底有沒有（WP-18）
 * ====================================
 * 牌組庫寫牌組是繞過客戶端直接送 `db_editdeck` 的，**伺服器驗不驗持有量未知**
 * （沒測，也不該去測 —— 那等於試探能不能組出沒有的卡，測出來是「可以」的話
 * 帳號就處在違規狀態了）。
 *
 * 所以這條線由插件自己守：**只用 `db_characard` / `db_eventcard` /
 * `db_item_weapon` 回報的實際庫存**。伺服器驗不驗都無所謂，因為我們從來不送
 * 玩家沒有的東西。
 *
 * ## 角色卡的索引規則（2026-08-24 實機驗證）
 *
 * 每個角色在 `cc_asset.frames` 裡佔**連續的 10 格**：
 *
 * ```
 *   +0..4  cc069_01 .. cc069_05    普通版 L1-L5   rarity 5
 *   +5..9  cc069_r01 .. cc069_r05  稀有版 R1-R5   rarity 6-10
 * ```
 *
 * 而 `db_characard` 的值是**同樣 10 個位置**的 CSV，一一對應：
 *
 * ```
 *   db_characard["69"] = "27,28,23,7,1,0,0,0,0,0"
 *                         L1 L2 L3 L4 L5 R1..R5
 * ```
 *
 * 對照當時 Deck1 的三張卡：
 *
 * | charaIndex | %10 | frame       | CSV 位置 | 持有 |
 * | ---------- | --- | ----------- | -------- | ---- |
 * | 684        | 4   | cc069_05    | [4]      | 1    |
 * | 674        | 4   | cc068_05    | [4]      | —    |
 * | 665        | 5   | cc067_r01   | [5]      | —    |
 *
 * 所以：
 *
 * ```
 *   角色編號 = floor(charaIndex / 10) + 1
 *   CSV 位置 = charaIndex % 10
 * ```
 *
 * ⚠ **這不是我們推出來的慣例，是遊戲自己在用的。** Quest 場景載語音時就寫
 * `this.deck1.charaIndex[0] % 10 > 4`（>4 表示 r 版）。
 */

import type { DeckContent } from "./types.js";

/** 一個角色在 `cc_asset.frames` 裡佔的格數，也是 `db_characard` CSV 的長度。 */
export const CHARA_VARIANTS = 10;

/**
 * 玩家的庫存。欄位就是那幾個 `db_*` 呼叫的原樣回傳。
 *
 * ⚠ 這裡**只放數量**，不放 id、不放 session token。
 */
export interface Inventory {
  /** `db_characard`：`{ "69": "27,28,23,7,1,0,0,0,0,0" }` */
  chara: Record<string, string>;
  /** `db_eventcard`：`{ "2": 150, "67": 258 }`（2026-08-24 實測） */
  event: Record<string, number | string>;
  /**
   * `db_item_weapon`：`{ 武器索引: 數量 }`。
   *
   * 2026-08-24 實機驗證：讀到 238 種武器，拿去驗兩副真的裝了武器的牌組
   * （`[65,7,86]` 與 `[170,136,135]`）全部通過。格式若不對，這些武器會被
   * 判成「沒有」而報缺貨 —— 沒報，所以 key 確實是武器索引。
   */
  weapon?: Record<string, number | string>;
}

/** 角色卡的 `charaIndex` 對應到哪個角色編號。 */
export function charaNumberOf(charaIndex: number): number {
  return Math.floor(charaIndex / CHARA_VARIANTS) + 1;
}

/** 角色卡的 `charaIndex` 對應到 CSV 的第幾格（0..9）。 */
export function charaVariantOf(charaIndex: number): number {
  return charaIndex % CHARA_VARIANTS;
}

/** 這個 `charaIndex` 是不是稀有（r）版。遊戲自己用的判斷式。 */
export function isRareVariant(charaIndex: number): boolean {
  return charaVariantOf(charaIndex) > 4;
}

/**
 * 玩家有幾張這個 `charaIndex` 的角色卡。
 *
 * 查不到（沒有這個角色編號、CSV 太短、值不是數字）一律回 `0` —— 「讀不到」
 * 跟「沒有」在這裡要同樣保守，寧可擋下來也不要送出玩家沒有的卡。
 */
export function charaStock(inventory: Inventory, charaIndex: number): number {
  const csv = inventory.chara[String(charaNumberOf(charaIndex))];
  if (typeof csv !== "string") return 0;
  const cell = csv.split(",")[charaVariantOf(charaIndex)];
  if (cell === undefined) return 0;
  const n = Number(cell.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 玩家有幾張這張事件卡。 */
export function eventStock(inventory: Inventory, eventIndex: number): number {
  const raw = inventory.event[String(eventIndex)];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 玩家有幾把這個武器。庫存表沒給就回 `null` —— 「不知道」不等於「沒有」。 */
export function weaponStock(inventory: Inventory, weaponIndex: number): number | null {
  if (inventory.weapon === undefined) return null;
  const raw = inventory.weapon[String(weaponIndex)];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一項庫存不足。 */
export interface StockShortage {
  kind: "chara" | "event" | "weapon";
  /** 卡的索引（`charaIndex` / `eventIndex` / 武器索引）。 */
  index: number;
  /** 這副牌組要用幾張。 */
  need: number;
  /** 玩家實際有幾張。 */
  have: number;
}

/**
 * **這副牌組全部的卡，玩家都真的有嗎。**
 *
 * 回傳空陣列表示都有。
 *
 * ⚠ 這裡是拿**整個庫存**比對，沒有扣掉「其他牌組正在用的」—— 那是故意的：
 * 牌組庫的前提就是 Deck2/Deck3 已經清空、同一時間只有一副躺在伺服器上，
 * 所以整個庫存都是這副的。呼叫端如果沒有清空 Deck2/Deck3 就用這支，
 * 會放行一些實際上被佔住的卡。
 *
 * ⚠ 怪物卡（`mc` 開頭）**不驗**。`mc_asset` 的索引規則沒有實機量過，硬套
 * 角色那套 `%10` 幾乎一定是錯的，錯的方向還是「把有的卡判成沒有」。
 * 要驗之前先量 `db_monstercard` 跟 `mc_asset` 的對應。
 */
export function findShortages(content: DeckContent, inventory: Inventory): StockShortage[] {
  const out: StockShortage[] = [];

  // 同一張卡在同一副牌組裡可能出現多次（事件卡尤其常見），要先數過。
  const charaNeed = new Map<number, number>();
  const eventNeed = new Map<number, number>();
  const weaponNeed = new Map<number, number>();

  content.charaIndex.forEach((idx, slot) => {
    if (idx === null || idx === undefined) return;
    // 怪物槽跳過 —— 見上面那段 ⚠
    const who = content.chara[slot];
    if (typeof who === "string" && who.startsWith("mc")) return;
    charaNeed.set(idx, (charaNeed.get(idx) ?? 0) + 1);
  });
  for (const idx of content.eventIndex) {
    if (idx === null || idx === undefined) continue;
    eventNeed.set(idx, (eventNeed.get(idx) ?? 0) + 1);
  }
  for (const idx of content.weapon) {
    if (idx === null || idx === undefined) continue;
    weaponNeed.set(idx, (weaponNeed.get(idx) ?? 0) + 1);
  }

  for (const [index, need] of charaNeed) {
    const have = charaStock(inventory, index);
    if (have < need) out.push({ kind: "chara", index, need, have });
  }
  for (const [index, need] of eventNeed) {
    const have = eventStock(inventory, index);
    if (have < need) out.push({ kind: "event", index, need, have });
  }
  for (const [index, need] of weaponNeed) {
    const have = weaponStock(inventory, index);
    if (have === null) continue; // 庫存表沒給，不擋
    if (have < need) out.push({ kind: "weapon", index, need, have });
  }

  return out;
}
