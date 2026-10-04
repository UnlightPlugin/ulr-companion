/**
 * 庫存：這張卡玩家到底有沒有（WP-18）
 * ====================================
 * 牌組庫寫牌組是繞過牌組編輯畫面直接送 `deck_update` 的，**伺服器驗不驗持有量
 * 未知**（沒測，也不該去測 —— 那等於試探能不能組出沒有的卡，測出來是「可以」
 * 的話帳號就處在違規狀態了）。
 *
 * 所以這條線由插件自己守：**只用客戶端 registry 裡的實際庫存**。伺服器驗不驗都
 * 無所謂，因為我們從來不送玩家沒有的東西。
 *
 * ## 2026-09-23 改版後的庫存形狀
 *
 * ```
 *   registry.chara_card   [{ card_id, quantity }]   角色與怪物同一份（CharaCards 的 id）
 *   registry.weapon_card  [{ card_id, quantity }]
 *   registry.event_card   [{ card_id, quantity }]
 * ```
 *
 * 全部以**卡片 id** 為鍵，跟牌組內容（`DeckContent`）同一套 —— 改版前那套
 * 「角色 CSV 第幾格」「怪物不驗」的規則都不需要了。讀這份不必跑任何網路請求：
 * 遊戲開機（`PreBoot`）與進牌組編輯（`Edit.init`）時自己會更新它。
 *
 * ## ⚠ 三副共用同一個卡池
 *
 * 牌組編輯畫面算「剩幾張」時會扣掉**三副**用掉的（2026-09-24 讀 `Edit` 的原始碼）。
 * 所以：
 *
 * - 插件模式（只用 Deck1）：Deck2／Deck3 清空之後，整個庫存都是 Deck1 的
 *   → {@link findShortages} 拿一副跟整個庫存比。
 * - 官方三牌組模式：三副要**一起**塞得進庫存 → {@link findSetShortages}。
 *
 * ⚠ 超量的牌組寫進客戶端記憶體之後，玩家離開牌組編輯時遊戲送的 `deck_update`
 * 會被伺服器退回，而新版 Edit 退回時**不顯示任何錯誤**，只是讓玩家留在原畫面
 * —— 看起來就是「按返回沒反應」。這支擋的正是那個。
 */

import type { DeckContent } from "./types.js";

/** 一種卡的庫存清單（registry 的原樣）。 */
export interface StockRow {
  card_id: number;
  quantity: number;
}

/**
 * 玩家的庫存，三種卡各一份「id → 數量」。
 *
 * ⚠ 這裡**只放數量**，不放玩家 id、不放 session token。
 */
export interface Inventory {
  chara: Record<string, number>;
  weapon: Record<string, number>;
  event: Record<string, number>;
}

/** registry 的 `[{card_id, quantity}]` → `{ id: 數量 }`。壞掉的列丟掉。 */
export function stockTable(rows: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const id = (row as { card_id?: unknown }).card_id;
    const qty = Number((row as { quantity?: unknown }).quantity);
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out[String(id)] = (out[String(id)] ?? 0) + qty;
  }
  return out;
}

/** 玩家有幾張這張卡。查不到一律 `0` —— 「讀不到」跟「沒有」同樣保守。 */
export function stockOf(table: Record<string, number>, id: number): number {
  const n = table[String(id)];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一項庫存不足。 */
export interface StockShortage {
  kind: "chara" | "event" | "weapon";
  /** 卡片 id。 */
  id: number;
  /** 這（幾）副牌組一共要用幾張。 */
  need: number;
  /** 玩家實際有幾張。 */
  have: number;
}

function tally(into: Map<number, number>, ids: readonly (number | null)[]): void {
  for (const id of ids) {
    if (id === null || id === undefined) continue;
    into.set(id, (into.get(id) ?? 0) + 1);
  }
}

/**
 * **這幾副牌組合起來，玩家的庫存塞得下嗎。** 回傳空陣列表示塞得下。
 *
 * 同一張卡在同一副、或不同副裡出現幾次就算幾張（三副共用一個卡池）。
 */
export function findSetShortages(
  contents: readonly DeckContent[],
  inventory: Inventory,
): StockShortage[] {
  const need = {
    chara: new Map<number, number>(),
    weapon: new Map<number, number>(),
    event: new Map<number, number>(),
  };
  for (const c of contents) {
    tally(need.chara, c.charaId);
    tally(need.weapon, c.weaponId);
    tally(need.event, c.eventId);
  }
  const out: StockShortage[] = [];
  for (const kind of ["chara", "weapon", "event"] as const) {
    for (const [id, n] of need[kind]) {
      const have = stockOf(inventory[kind], id);
      if (have < n) out.push({ kind, id, need: n, have });
    }
  }
  return out;
}

/**
 * **這副牌組全部的卡，玩家都真的有嗎。** 回傳空陣列表示都有。
 *
 * ⚠ 這裡是拿**整個庫存**比對，沒有扣掉「其他牌組正在用的」—— 插件模式的前提
 * 就是 Deck2/Deck3 已經清空、同一時間只有一副躺在伺服器上。其他情況用
 * {@link findSetShortages} 把三副一起算。
 */
export function findShortages(content: DeckContent, inventory: Inventory): StockShortage[] {
  return findSetShortages([content], inventory);
}

/** 玩家角色卡：卡片 id → 格子鍵（`cc035_r02`）。見 cdp-adapter 的 `InventorySnapshot`。 */
export type CharaFiles = Record<string, string>;

/**
 * 格子鍵拆成「哪個角色」與「階」：L1..L5 = 1..5、R1..R5 = 6..10。
 * 認不出來（怪物、記憶碎片…）回 `null`。
 */
export function charaRank(file: string): { chara: string; rank: number } | null {
  const m = /^(cc\d+)_(r?)(\d+)$/.exec(file);
  if (m === null) return null;
  const level = Number(m[3]);
  if (!Number.isInteger(level) || level < 1) return null;
  return { chara: m[1] ?? "", rank: m[2] === "r" ? 5 + level : level };
}

/** 一張被臨時換掉的角色卡。 */
export interface CharaSwap {
  /** 第幾格角色（0..2）。 */
  slot: number;
  from: number;
  to: number;
}

/**
 * **牌組裡手上沒有的角色卡，臨時換成同一個角色手上有的另一張。**
 *
 * 2026-09-25 迪城回報「Deck1 跟 Deck4 不能選」：玩家把沃蘭德 R2 合成成 R5，
 * 庫裡那副還寫著 R2，庫存 0 張，於是每點一次都「有 1 張卡你手上沒有」。
 * 玩家定的規則：**角色一樣就行，最好是上位高等的** —— 角色本身不會消失。
 *
 * ```
 *   比原本高（或同階）的有 → 取最接近的那一張（R2 沒了、R3 R5 都有 → R3）
 *   沒有                    → 取比原本低的裡面最高的
 *   這個角色一張都沒有      → 原樣留著，交給 findShortages 照舊擋下來
 * ```
 *
 * - 只動**不夠**的那幾格；庫存夠的一張都不碰。
 * - 換上去的卡也要夠：同一副裡其他格已經用掉的會扣掉。
 * - ⚠ **不改牌組庫**。這是寫進遊戲那一刻才做的事，庫裡那副照舊是 R2。
 *
 * 沒有東西可換時回傳的 `content` 就是傳進來的那一個（同一個參照）。
 */
export function substituteCharas(
  content: DeckContent,
  inventory: Inventory,
  files: CharaFiles,
): { content: DeckContent; swaps: CharaSwap[] } {
  const used = new Map<number, number>();
  tally(used, content.charaId);
  const usable = (id: number): boolean => stockOf(inventory.chara, id) > (used.get(id) ?? 0);

  let byChara: Map<string, { id: number; rank: number }[]> | null = null;
  const sameChara = (chara: string): { id: number; rank: number }[] => {
    if (byChara === null) {
      byChara = new Map();
      for (const [key, file] of Object.entries(files)) {
        const info = charaRank(file);
        if (info === null) continue;
        const list = byChara.get(info.chara) ?? [];
        list.push({ id: Number(key), rank: info.rank });
        byChara.set(info.chara, list);
      }
    }
    return byChara.get(chara) ?? [];
  };

  const swaps: CharaSwap[] = [];
  const charaId = content.charaId.slice();
  charaId.forEach((id, slot) => {
    if (id === null || id === undefined) return;
    if ((used.get(id) ?? 0) <= stockOf(inventory.chara, id)) return;
    const file = files[String(id)];
    const self = file === undefined ? null : charaRank(file);
    if (self === null) return;
    const owned = sameChara(self.chara).filter((c) => c.id !== id && usable(c.id));
    const up = owned
      .filter((c) => c.rank >= self.rank)
      .sort((a, b) => a.rank - b.rank || a.id - b.id);
    const down = owned
      .filter((c) => c.rank < self.rank)
      .sort((a, b) => b.rank - a.rank || a.id - b.id);
    const to = up[0]?.id ?? down[0]?.id;
    if (to === undefined) return;
    charaId[slot] = to;
    used.set(id, (used.get(id) ?? 0) - 1);
    used.set(to, (used.get(to) ?? 0) + 1);
    swaps.push({ slot, from: id, to });
  });
  if (swaps.length === 0) return { content, swaps };
  return { content: { ...content, charaId }, swaps };
}
