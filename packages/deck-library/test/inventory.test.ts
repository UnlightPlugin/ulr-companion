import { describe, expect, it } from "vitest";
import {
  charaNumberOf,
  charaStock,
  charaVariantOf,
  eventStock,
  findShortages,
  isRareVariant,
  weaponStock,
} from "../src/inventory.js";
import type { Inventory } from "../src/inventory.js";
import { emptyDeckContent } from "../src/types.js";

/**
 * 2026-08-24 從實機（Lv.129 的帳號）量到的真實資料。
 *
 * 當時 Deck1 的三張卡是 charaIndex 684 / 674 / 665，分別是
 * `cc069_05`(L5)、`cc068_05`(L5)、`cc067_r01`(R1)。
 */
const REAL: Inventory = {
  chara: {
    "69": "27,28,23,7,1,0,0,0,0,0", // cc069：L1-L5 有貨，R 版全 0
    "68": "12,9,4,2,3,0,0,0,0,0",
    "67": "5,0,0,0,0,2,0,0,0,0", // cc067：L1 有 5 張，R1 有 2 張
  },
  event: { "2": 150, "6": 2, "20": 1, "67": 258 },
};

describe("角色卡索引 → 庫存的映射（實機驗證過的 %10 規則）", () => {
  it("charaIndex 拆成角色編號與變體格", () => {
    // 684 = cc069 的第 5 格（cc069_05，L5）
    expect(charaNumberOf(684)).toBe(69);
    expect(charaVariantOf(684)).toBe(4);
    // 665 = cc067 的第 6 格（cc067_r01，R1）
    expect(charaNumberOf(665)).toBe(67);
    expect(charaVariantOf(665)).toBe(5);
  });

  it("變體格 > 4 就是 r 版 —— 這是遊戲自己用的判斷式", () => {
    expect(isRareVariant(684)).toBe(false); // cc069_05
    expect(isRareVariant(665)).toBe(true); // cc067_r01
  });

  it("查得到實機那三張卡的持有量", () => {
    expect(charaStock(REAL, 684)).toBe(1); // cc069_05：CSV[4] = 1
    expect(charaStock(REAL, 674)).toBe(3); // cc068_05：CSV[4] = 3
    expect(charaStock(REAL, 665)).toBe(2); // cc067_r01：CSV[5] = 2
  });

  it("讀不到一律當 0 —— 寧可擋下來，也不要送出玩家沒有的卡", () => {
    expect(charaStock(REAL, 10)).toBe(0); // 沒有這個角色編號
    expect(charaStock(REAL, 689)).toBe(0); // cc069_r05：CSV[9] = 0
    expect(charaStock({ chara: { "69": "壞掉的資料" }, event: {} }, 684)).toBe(0);
    expect(charaStock({ chara: { "69": "1,2" }, event: {} }, 684)).toBe(0); // CSV 太短
  });
});

describe("事件卡與武器", () => {
  it("事件卡直接查數量", () => {
    expect(eventStock(REAL, 2)).toBe(150);
    expect(eventStock(REAL, 20)).toBe(1);
    expect(eventStock(REAL, 999)).toBe(0);
  });

  it("武器庫存表沒給時回 null —— 「不知道」不等於「沒有」", () => {
    expect(weaponStock(REAL, 65)).toBeNull();
    expect(weaponStock({ ...REAL, weapon: { "65": 2 } }, 65)).toBe(2);
    expect(weaponStock({ ...REAL, weapon: { "65": 2 } }, 7)).toBe(0);
  });
});

describe("findShortages", () => {
  it("卡都有的時候是空的", () => {
    const deck = emptyDeckContent();
    deck.chara = ["cc069", "cc067", null];
    deck.charaIndex = [684, 665, null];
    deck.eventIndex[0] = 2;
    expect(findShortages(deck, REAL)).toEqual([]);
  });

  it("同一張卡在牌組裡出現多次要一起數", () => {
    const deck = emptyDeckContent();
    deck.chara = ["cc069", null, null];
    deck.charaIndex = [684, null, null];
    // ev20 只有 1 張，卻放了 2 格
    deck.eventIndex[0] = 20;
    deck.eventIndex[1] = 20;
    const short = findShortages(deck, REAL);
    expect(short).toEqual([{ kind: "event", index: 20, need: 2, have: 1 }]);
  });

  it("怪物槽不驗 —— mc_asset 的索引規則還沒實機量過", () => {
    const deck = emptyDeckContent();
    deck.chara = ["mc001_01", null, null];
    deck.charaIndex = [3, null, null]; // 硬套 %10 會把它算成 cc001 的第 3 格
    expect(findShortages(deck, REAL)).toEqual([]);
  });

  it("武器庫存表沒給就不擋", () => {
    const deck = emptyDeckContent();
    deck.chara = ["cc069", null, null];
    deck.charaIndex = [684, null, null];
    deck.weapon = [65, null, null];
    expect(findShortages(deck, REAL)).toEqual([]);
  });
});
