import { describe, expect, it } from "vitest";
import {
  charaRank,
  findSetShortages,
  findShortages,
  stockOf,
  stockTable,
  substituteCharas,
} from "../src/inventory.js";
import type { CharaFiles, Inventory } from "../src/inventory.js";
import { emptyDeckContent } from "../src/types.js";
import type { DeckContent } from "../src/types.js";

/**
 * 2026-09-24 改版後的庫存形狀：registry 裡 `[{card_id, quantity}]`，
 * 角色與怪物同一份（CharaCards 的 id，怪物是 1001 起）。
 */
const REAL: Inventory = {
  chara: stockTable([
    { card_id: 685, quantity: 1 }, // cc069_05
    { card_id: 675, quantity: 3 }, // cc068_05
    { card_id: 666, quantity: 2 }, // cc067_r01
    { card_id: 1001, quantity: 4 }, // mc001_01
  ]),
  weapon: stockTable([{ card_id: 6, quantity: 2 }]),
  event: stockTable([
    { card_id: 2, quantity: 150 },
    { card_id: 20, quantity: 1 },
  ]),
};

describe("stockTable", () => {
  it("registry 的列表攤成 id → 數量", () => {
    expect(stockTable([{ card_id: 5, quantity: 3 }])).toEqual({ "5": 3 });
  });

  it("數量 0、壞掉的列一律丟掉 —— 讀不到跟沒有同樣保守", () => {
    expect(
      stockTable([
        { card_id: 5, quantity: 0 },
        { card_id: "6", quantity: 1 },
        null,
        { quantity: 2 },
      ]),
    ).toEqual({});
    expect(stockTable("不是陣列")).toEqual({});
  });

  it("查不到的卡是 0", () => {
    expect(stockOf(REAL.chara, 685)).toBe(1);
    expect(stockOf(REAL.chara, 999)).toBe(0);
  });
});

describe("findShortages", () => {
  it("卡都有的時候是空的（怪物也一樣驗，改版後同一張表）", () => {
    const deck = emptyDeckContent();
    deck.charaId = [685, 666, 1001];
    deck.eventId[0] = 2;
    deck.weaponId[0] = 6;
    expect(findShortages(deck, REAL)).toEqual([]);
  });

  it("同一張卡在牌組裡出現多次要一起數", () => {
    const deck = emptyDeckContent();
    deck.charaId = [685, null, null];
    // 事件卡 20 只有 1 張，卻放了 2 格
    deck.eventId[0] = 20;
    deck.eventId[1] = 20;
    expect(findShortages(deck, REAL)).toEqual([{ kind: "event", id: 20, need: 2, have: 1 }]);
  });

  it("沒有的武器照樣擋", () => {
    const deck = emptyDeckContent();
    deck.charaId = [685, null, null];
    deck.weaponId = [7, null, null];
    expect(findShortages(deck, REAL)).toEqual([{ kind: "weapon", id: 7, need: 1, have: 0 }]);
  });
});

describe("findSetShortages —— 三副共用一個卡池", () => {
  it("單看每一副都夠，合起來超量就擋", () => {
    const a = emptyDeckContent();
    a.charaId = [685, null, null];
    const b = emptyDeckContent();
    b.charaId = [685, null, null]; // cc069_05 只有 1 張
    expect(findShortages(a, REAL)).toEqual([]);
    expect(findShortages(b, REAL)).toEqual([]);
    expect(findSetShortages([a, b], REAL)).toEqual([{ kind: "chara", id: 685, need: 2, have: 1 }]);
  });

  it("空牌組不佔任何東西", () => {
    expect(findSetShortages([emptyDeckContent(), emptyDeckContent()], REAL)).toEqual([]);
  });
});

describe("charaRank", () => {
  it("L1..L5 = 1..5、R1..R5 = 6..10", () => {
    expect(charaRank("cc035_01")).toEqual({ chara: "cc035", rank: 1 });
    expect(charaRank("cc035_05")).toEqual({ chara: "cc035", rank: 5 });
    expect(charaRank("cc035_r02")).toEqual({ chara: "cc035", rank: 7 });
  });

  it("怪物、記憶碎片認不出來", () => {
    expect(charaRank("mc001_01")).toBeNull();
    expect(charaRank("cmem_6")).toBeNull();
  });
});

/** 實機 2026-09-25 的格子鍵（CharaCards 的 filename）。沃蘭德是 cc035。 */
const FILES: CharaFiles = {
  "341": "cc035_01",
  "343": "cc035_03",
  "345": "cc035_05",
  "346": "cc035_r01",
  "347": "cc035_r02",
  "348": "cc035_r03",
  "349": "cc035_r04",
  "350": "cc035_r05",
  "110": "cc011_r05",
  "330": "cc033_r05",
};

function charas(ids: (number | null)[]): DeckContent {
  const deck = emptyDeckContent();
  deck.charaId = ids;
  return deck;
}

function inv(stock: Record<string, number>): Inventory {
  return { chara: stock, weapon: {}, event: {} };
}

describe("substituteCharas —— 手上沒有的角色卡臨時換成同角色的另一張", () => {
  it("迪城 Deck1：沃蘭德 R2 合成成 R5 了 → 用 R5，其他格不動", () => {
    const stock = inv({ "350": 1, "110": 1, "330": 1, "343": 4 });
    const out = substituteCharas(charas([347, 110, 330]), stock, FILES);
    expect(out.content.charaId).toEqual([350, 110, 330]);
    expect(out.swaps).toEqual([{ slot: 0, from: 347, to: 350 }]);
    expect(findShortages(out.content, stock)).toEqual([]);
  });

  it("比原本高的取最接近的：R3、R5 都有 → R3", () => {
    const out = substituteCharas(charas([347]), inv({ "348": 1, "350": 1 }), FILES);
    expect(out.content.charaId).toEqual([348]);
  });

  it("沒有更高的 → 取比原本低的裡面最高的", () => {
    const out = substituteCharas(charas([350]), inv({ "341": 1, "345": 1, "346": 1 }), FILES);
    expect(out.content.charaId).toEqual([346]); // R1（6）高過 L5（5）
  });

  it("庫存夠的卡一張都不碰，回傳同一個參照", () => {
    const deck = charas([350, 110, 330]);
    const out = substituteCharas(deck, inv({ "350": 1, "110": 1, "330": 1, "348": 1 }), FILES);
    expect(out.content).toBe(deck);
    expect(out.swaps).toEqual([]);
  });

  it("換上去的卡同一副裡已經用掉了就不能再拿", () => {
    // 350 只有一張，已經在第二格；只剩 L3 可用
    const out = substituteCharas(charas([347, 350, null]), inv({ "350": 1, "343": 1 }), FILES);
    expect(out.content.charaId).toEqual([343, 350, null]);
  });

  it("這個角色一張都沒有 → 原樣留著，交給 findShortages 擋", () => {
    const stock = inv({ "110": 1 });
    const out = substituteCharas(charas([347]), stock, FILES);
    expect(out.content.charaId).toEqual([347]);
    expect(findShortages(out.content, stock)).toHaveLength(1);
  });

  it("不認得的卡（沒有格子鍵）不動", () => {
    const out = substituteCharas(charas([9999]), inv({ "350": 1 }), FILES);
    expect(out.swaps).toEqual([]);
  });
});
