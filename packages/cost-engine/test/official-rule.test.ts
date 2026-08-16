/**
 * 原版壓 C 規則的驗收測試
 * =========================
 * 這份測試的對照組**不是我的理解**，是客戶端 `src/deck/cost-check.ts` 的
 * `costcheck()`。`clientCostcheck` 是照著它一行一行搬過來的（含那段看起來
 * 很奇怪的巢狀分支），然後用窮舉證明我們的「全配對」寫法與它等價。
 *
 * 為什麼要這樣做：官方那段分支寫得很繞，光看程式碼很難確定它到底等於什麼。
 * 窮舉比對可以確定，而且遊戲改版動了規則時這裡會直接紅掉。
 *
 * 出處與完整推導見 docs/official-cost-rule.md。
 */

import { describe, expect, it } from "vitest";
import { calculateTeamCost, UNKNOWN_COST } from "@ulr/cost-engine";
import type { TeamComposition } from "@ulr/cost-engine";
import { toCentiCost } from "@ulr/rule-schema";
import type { CostRule } from "@ulr/rule-schema";

// ---------------------------------------------------------------------------
// 官方規則的最小規則檔
// ---------------------------------------------------------------------------

/** 差距 7~13 → +5，差距 14 以上 → +10。這兩條就是官方的全部。 */
const OFFICIAL_BANDS = [
  { minGap: 7, maxGap: 13, extraCost: 5 },
  { minGap: 14, extraCost: 10 },
] as const;

function ruleWith(characters: Record<string, number>): CostRule {
  return {
    schemaVersion: 1,
    ruleSetId: "unlight/official",
    version: "1.0.0",
    name: "測試用",
    publisher: { id: "unlight", name: "官方" },
    gameVersion: "2026.08",
    teamCostLimit: 0,
    characters,
    compressionRule: { type: "gap-band-v1", bands: [...OFFICIAL_BANDS] },
  };
}

/** 給一組角色 COST，組出「規則 + 隊伍」並回傳總和（十進位）。 */
function totalOf(costs: readonly number[]): number {
  const characters: Record<string, number> = {};
  const members = costs.map((c, i) => {
    const id = `slot${i}`;
    characters[id] = c;
    return { characterId: id };
  });
  const team: TeamComposition = { members };
  return calculateTeamCost(ruleWith(characters), team).total / 100;
}

// ---------------------------------------------------------------------------
// 客戶端原始碼的忠實移植（對照組）
// ---------------------------------------------------------------------------

/**
 * 照抄 `src/deck/cost-check.ts` 的 `costcheck()` 壓 C 部分。
 *
 * ⚠ 刻意保留原本的巢狀結構與 `penalties[0]` 被覆寫兩次的寫法。
 * 整理它就失去對照的意義了。
 */
function clientPenalties(costs: readonly number[]): (number | null)[] {
  const penalties: (number | null)[] = [null, null, null];
  const d = [...costs].sort((a, b) => a - b);

  switch (d.length) {
    case 2: {
      if (d[1]! - d[0]! >= 14) penalties[0] = 10;
      else if (d[1]! - d[0]! >= 7) penalties[0] = 5;
      break;
    }
    case 3: {
      if (d[2]! - d[1]! < 7) {
        if (d[2]! - d[0]! >= 7 && d[1]! - d[0]! >= 7) {
          if (d[2]! - d[0]! >= 14) penalties[2] = 10;
          else if (d[2]! - d[0]! >= 7) penalties[2] = 5;
          if (d[1]! - d[0]! >= 14) penalties[1] = 10;
          else if (d[1]! - d[0]! >= 7) penalties[1] = 5;
        } else {
          if (d[2]! - d[0]! >= 14) penalties[0] = 10;
          else if (d[2]! - d[0]! >= 7) penalties[0] = 5;
          if (d[1]! - d[0]! >= 14) penalties[0] = 10;
          else if (d[1]! - d[0]! >= 7) penalties[0] = 5;
        }
      } else {
        if (d[1]! - d[0]! < 7) {
          if (d[2]! - d[0]! >= 14) penalties[0] = 10;
          else if (d[2]! - d[0]! >= 7) penalties[0] = 5;
          if (d[2]! - d[1]! >= 14) penalties[1] = 10;
          else if (d[2]! - d[1]! >= 7) penalties[1] = 5;
        } else {
          if (d[2]! - d[0]! >= 14) penalties[0] = 10;
          else if (d[2]! - d[0]! >= 7) penalties[0] = 5;
          if (d[1]! - d[0]! >= 14) penalties[1] = 10;
          else if (d[1]! - d[0]! >= 7) penalties[1] = 5;
          if (d[2]! - d[1]! >= 14) penalties[2] = 10;
          else if (d[2]! - d[1]! >= 7) penalties[2] = 5;
        }
      }
      break;
    }
    // no default
  }
  return penalties;
}

/** 客戶端算出來的隊伍總和（只有角色，沒有武器與事件卡）。 */
function clientTotal(costs: readonly number[]): number {
  const sum = costs.reduce((a, b) => a + b, 0);
  const pen = clientPenalties(costs).reduce<number>((a, b) => a + (b ?? 0), 0);
  return sum + pen;
}

// ---------------------------------------------------------------------------

describe("原版壓 C：與客戶端 costcheck 等價", () => {
  it("三名角色，窮舉 0~40 的所有組合都得到同一個總和", () => {
    const mismatches: string[] = [];
    for (let a = 0; a <= 40; a++) {
      for (let b = a; b <= 40; b++) {
        for (let c = b; c <= 40; c++) {
          const mine = totalOf([a, b, c]);
          const theirs = clientTotal([a, b, c]);
          if (mine !== theirs) mismatches.push(`[${a},${b},${c}] 我方 ${mine} / 客戶端 ${theirs}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("兩名角色（case 2）也一致", () => {
    const mismatches: string[] = [];
    for (let a = 0; a <= 60; a++) {
      for (let b = a; b <= 60; b++) {
        const mine = totalOf([a, b]);
        const theirs = clientTotal([a, b]);
        if (mine !== theirs) mismatches.push(`[${a},${b}] 我方 ${mine} / 客戶端 ${theirs}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("槽位順序不影響總和 —— 客戶端會先排序，我們則是無序配對", () => {
    expect(totalOf([30, 8, 15])).toBe(totalOf([8, 15, 30]));
    expect(totalOf([30, 8, 15])).toBe(totalOf([15, 30, 8]));
  });
});

describe("原版壓 C：實機驗證過的例子", () => {
  // 前三筆是 2026-08-15 在網頁版牌組畫面上直接截到的，
  // 後兩筆是燈皇給的例子。五筆全部對得上。
  it.each([
    { deck: [15, 13, 20], penalty: 5, total: 53, why: "13↔20 差 7" },
    { deck: [9, 13, 20], penalty: 10, total: 52, why: "13↔20 差 7、9↔20 差 11" },
    { deck: [17, 17, 99], penalty: 20, total: 153, why: "兩對都差 82" },
    { deck: [24, 8, 8], penalty: 20, total: 60, why: "24↔8 兩對都差 16" },
    { deck: [30, 8, 15], penalty: 25, total: 78, why: "15↔8 差 7、30↔15 差 15、30↔8 差 22" },
  ])("$deck → 罰 $penalty（$why）", ({ deck, penalty, total }) => {
    const base = deck.reduce((a, b) => a + b, 0);
    expect(totalOf(deck)).toBe(total);
    expect(totalOf(deck) - base).toBe(penalty);
  });

  it("差距剛好 6 不罰，剛好 7 罰 5，剛好 13 罰 5，剛好 14 罰 10", () => {
    expect(totalOf([10, 16]) - 26).toBe(0);
    expect(totalOf([10, 17]) - 27).toBe(5);
    expect(totalOf([10, 23]) - 33).toBe(5);
    expect(totalOf([10, 24]) - 34).toBe(10);
  });

  it("差距再大也只罰 10，沒有第三級", () => {
    expect(totalOf([10, 200]) - 210).toBe(10);
  });

  it("單一角色不可能有差距，罰 0", () => {
    expect(totalOf([30])).toBe(30);
  });
});

describe("壓 C 明細", () => {
  it("逐對列出是哪兩個位置、差多少、罰多少", () => {
    const characters = { A: 8, B: 15, C: 30 };
    const result = calculateTeamCost(ruleWith(characters), {
      members: [{ characterId: "A" }, { characterId: "B" }, { characterId: "C" }],
    });

    expect(result.compression).toEqual([
      { a: 0, b: 1, gap: toCentiCost(7), extraCost: toCentiCost(5) },
      { a: 0, b: 2, gap: toCentiCost(22), extraCost: toCentiCost(10) },
      { a: 1, b: 2, gap: toCentiCost(15), extraCost: toCentiCost(10) },
    ]);
    expect(result.total).toBe(toCentiCost(78));
  });

  it("沒有壓 C 時 compression 是空陣列，不是 undefined", () => {
    const characters = { A: 10, B: 11, C: 12 };
    const result = calculateTeamCost(ruleWith(characters), {
      members: [{ characterId: "A" }, { characterId: "B" }, { characterId: "C" }],
    });
    expect(result.compression).toEqual([]);
    expect(result.items.some((i) => i.source === "compression")).toBe(false);
  });

  it("規則沒有 compressionRule 就完全不壓 C", () => {
    const rule = ruleWith({ A: 8, B: 30 });
    delete rule.compressionRule;
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A" }, { characterId: "B" }],
    });
    expect(result.total).toBe(toCentiCost(38));
  });
});

describe("武器與事件卡", () => {
  const rule: CostRule = {
    ...ruleWith({ A: 10, B: 10, C: 10 }),
    equipment: { SWORD: 2.5 },
    eventCards: { EV1: 1.25 },
  };

  it("計入總和", () => {
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A", equipmentId: "SWORD" }, { characterId: "B" }],
      eventCards: ["EV1", "EV1"],
    });
    // 10 + 10 + 2.5 + 1.25 + 1.25
    expect(result.total).toBe(toCentiCost(25));
  });

  it("⚠ 但不參與壓 C —— 差距只看角色", () => {
    // 角色都是 10，武器再貴也不該生出壓 C。
    const expensive: CostRule = { ...rule, equipment: { SWORD: 50 } };
    const result = calculateTeamCost(expensive, {
      members: [{ characterId: "A", equipmentId: "SWORD" }, { characterId: "B" }],
    });
    expect(result.compression).toEqual([]);
    expect(result.total).toBe(toCentiCost(70));
  });

  it("不綁槽位的武器清單也計入 —— 從已排序的描述子還原時綁不回槽位", () => {
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A" }, { characterId: "B" }],
      equipment: ["SWORD", "SWORD"],
    });
    expect(result.total).toBe(toCentiCost(10 + 10 + 2.5 + 2.5));
  });

  it("兩條路並存時都算 —— 綁槽位的先、不綁的後", () => {
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A", equipmentId: "SWORD" }],
      equipment: ["SWORD"],
    });
    expect(result.items.map((i) => i.source)).toEqual(["character", "equipment", "equipment"]);
    expect(result.total).toBe(toCentiCost(15));
  });
});

/**
 * 一副牌組是四張表組合出來的，但**怪物不是第四種加項** —— 它跟角色共用同樣
 * 那三個槽位，走進 `costcheck()` 的同一個 `deckArray`。
 */
describe("怪物卡", () => {
  const rule: CostRule = {
    ...ruleWith({ cc001_01: 10 }),
    monsters: { mc001_01: 24, mc001_02: 10 },
  };

  it("查得到怪物表 —— 角色表沒有它不代表就是 99", () => {
    const result = calculateTeamCost(rule, { members: [{ characterId: "mc001_01" }] });
    expect(result.total).toBe(toCentiCost(24));
    expect(result.unknownIds).toEqual([]);
  });

  it("⚠⚠ 怪物照樣參與壓 C —— 它佔的就是角色的位子", () => {
    // 10 與 24 差 14 → 官方規則罰 10。武器差這麼多是不罰的，怪物會。
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "cc001_01" }, { characterId: "mc001_01" }],
    });
    expect(result.compression).toMatchObject([
      { gap: toCentiCost(14), extraCost: toCentiCost(10) },
    ]);
    expect(result.total).toBe(toCentiCost(10 + 24 + 10));
  });

  it("明細標成 monster，但那只是標示 —— 數字跟角色走同一條路", () => {
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "cc001_01" }, { characterId: "mc001_02" }],
    });
    expect(result.items.map((i) => i.source)).toEqual(["character", "monster"]);
  });

  it("兩張表都沒有時算 99，並照前綴猜是哪一種（只影響標示）", () => {
    const result = calculateTeamCost(rule, { members: [{ characterId: "mc999_01" }] });
    expect(result.unknownIds).toEqual(["mc999_01"]);
    expect(result.items[0]).toMatchObject({ source: "monster", cost: toCentiCost(99) });
  });
});

describe("規則沒定價的東西", () => {
  it("當成 99 並登記，與客戶端的 UNKNOWN_COST 一致", () => {
    const result = calculateTeamCost(ruleWith({ A: 17, B: 17 }), {
      members: [{ characterId: "A" }, { characterId: "B" }, { characterId: "沒寫" }],
    });
    expect(result.unknownIds).toEqual(["沒寫"]);
    // 17 + 17 + 99 + (兩對差 82 各罰 10)
    expect(result.total).toBe(toCentiCost(17 + 17 + UNKNOWN_COST + 20));
  });

  it("同一個 ID 出現多次只登記一次", () => {
    const result = calculateTeamCost(ruleWith({}), {
      members: [{ characterId: "X" }, { characterId: "X" }],
    });
    expect(result.unknownIds).toEqual(["X"]);
  });
});

describe("上限", () => {
  it("limit 為 0 代表不設限，永遠不算超標", () => {
    const result = calculateTeamCost(ruleWith({ A: 99 }), { members: [{ characterId: "A" }] });
    expect(result.limit).toBe(0);
    expect(result.overLimit).toBe(false);
  });

  it("剛好卡滿上限不算超標 —— 這是 CentiCost 存在的理由", () => {
    // 8.8 + 26.6 + 26.6 用 double 相加是 62.00000000000001。
    // 這組差距 17.8 本來會壓 C，但這裡要測的是浮點邊界，所以拿掉壓 C。
    const rule: CostRule = { ...ruleWith({ A: 8.8, B: 26.6, C: 26.6 }), teamCostLimit: 62 };
    delete rule.compressionRule;
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A" }, { characterId: "B" }, { characterId: "C" }],
    });
    expect(result.total).toBe(6200);
    expect(result.overLimit).toBe(false);
  });

  it("超過一分錢就算超標", () => {
    const rule: CostRule = { ...ruleWith({ A: 62.01 }), teamCostLimit: 62 };
    const result = calculateTeamCost(rule, { members: [{ characterId: "A" }] });
    expect(result.overLimit).toBe(true);
  });
});

describe("確定性（§9）", () => {
  it("同一輸入跑兩次得到完全相同的結果物件", () => {
    const rule: CostRule = {
      ...ruleWith({ A: 8, B: 15, C: 30 }),
      equipment: { W: 1.5 },
      eventCards: { E: 0.25 },
    };
    const team: TeamComposition = {
      members: [{ characterId: "A", equipmentId: "W" }, { characterId: "B" }, { characterId: "C" }],
      eventCards: ["E"],
    };
    expect(calculateTeamCost(rule, team)).toEqual(calculateTeamCost(rule, team));
  });

  it("明細順序固定為 角色 → 裝備 → 事件卡 → 壓 C", () => {
    const rule: CostRule = {
      ...ruleWith({ A: 8, B: 30 }),
      equipment: { W: 1 },
      eventCards: { E: 1 },
    };
    const result = calculateTeamCost(rule, {
      members: [{ characterId: "A", equipmentId: "W" }, { characterId: "B" }],
      eventCards: ["E"],
    });
    expect(result.items.map((i) => i.source)).toEqual([
      "character",
      "character",
      "equipment",
      "eventCard",
      "compression",
    ]);
  });
});
