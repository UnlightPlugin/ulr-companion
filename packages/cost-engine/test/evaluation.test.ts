/**
 * 跨版本相容
 *
 * 這一份釘的是 WP-16 的核心主張：**「版本不同」不等於「不能一起打」**。
 * 每一個 case 都對應一個具體的情境，而不是抽象的性質 —— 因為判錯的代價是
 * 「兩個人明明可以打卻永遠配不到」或「兩個人算的不是同一套規則卻打起來了」，
 * 兩者都是安靜的。
 */

import { describe, expect, it } from "vitest";
import type { CostRule } from "@ulr/rule-schema";
import {
  canonicalDeck,
  crossVerdict,
  deckFromKeys,
  describeDisagreement,
  evaluateDeck,
  fingerprint,
  parseDeckDescriptor,
} from "@ulr/cost-engine";

function rule(over: Partial<CostRule> = {}): CostRule {
  return {
    schemaVersion: 1,
    ruleSetId: "lampking/arcadia-balance",
    version: "1.5.0",
    name: "亞城平衡",
    publisher: { id: "lampking", name: "燈皇" },
    gameVersion: "2026.08",
    teamCostLimit: 0,
    characters: {
      leon_r3: 22,
      abel_r3: 17,
      evarist_r3: 18,
      // 對照組：只有這一隻的定價在兩個版本之間不一樣
      newbie_r1: 25,
    },
    ...over,
  };
}

/** 只給角色的簡寫。大多數 case 只在乎那三個槽位。 */
const slots = (...characters: (string | null | undefined)[]) => deckFromKeys({ characters });

/** 一份完整的 v2 描述子欄位，給 parse／canonical 的 case 用。 */
const wire = (over: Record<string, unknown> = {}) => ({
  v: 2,
  characters: ["a"],
  equipment: [],
  eventCards: [],
  ...over,
});

const deck = slots("leon_r3", "abel_r3", "evarist_r3");

describe("描述子", () => {
  it("排序過，所以槽位順序不影響指紋", () => {
    const a = slots("leon_r3", "abel_r3", "evarist_r3");
    const b = slots("evarist_r3", "leon_r3", "abel_r3");
    expect(a).toEqual(b);
    expect(fingerprint(rule(), a)).toBe(fingerprint(rule(), b));
  });

  it("空槽丟掉，不會變成一隻查不到的角色", () => {
    expect(slots("leon_r3", null, undefined).characters).toEqual(["leon_r3"]);
  });

  it("四種卡都在描述子裡，各自排序", () => {
    const d = deckFromKeys({
      characters: ["cc002_01", "mc001_01", null],
      equipment: ["wp003", "wp001", null],
      eventCards: ["ev091", "ev003"],
    });
    // ⚠ 怪物就放在 characters 裡 —— 它跟角色是同一種槽位
    expect(d.characters).toEqual(["cc002_01", "mc001_01"]);
    expect(d.equipment).toEqual(["wp001", "wp003"]);
    expect(d.eventCards).toEqual(["ev003", "ev091"]);
  });

  it("⚠ 重複的裝備與事件卡不能去掉 —— 三個角色可以帶一樣的武器", () => {
    const d = deckFromKeys({
      characters: ["a"],
      equipment: ["wp001", "wp001", "wp001"],
      eventCards: ["ev003", "ev003"],
    });
    expect(d.equipment).toHaveLength(3);
    expect(d.eventCards).toHaveLength(2);
  });

  it("⚠ 收來的東西壞掉一律 null，不拋例外", () => {
    expect(parseDeckDescriptor(null)).toBeNull();
    expect(parseDeckDescriptor({ v: 2 })).toBeNull();
    // v1 是舊格式 —— 認出來但拒收，那正是版本號存在的理由
    expect(parseDeckDescriptor({ v: 1, characters: ["a"] })).toBeNull();
    expect(parseDeckDescriptor(wire({ characters: [] }))).toBeNull();
    expect(parseDeckDescriptor(wire({ characters: [1, 2] }))).toBeNull();
    // 少一個欄位也不收 —— 沒有「當成空陣列」這種寬容，那會讓兩邊算出不同指紋
    expect(parseDeckDescriptor({ v: 2, characters: ["a"], equipment: [] })).toBeNull();
    expect(parseDeckDescriptor(wire({ equipment: [null] }))).toBeNull();
  });

  it("⚠ 每種卡都有數量上限 —— 描述子會被拿去跑 O(n²) 的壓 C 迴圈", () => {
    const flood = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    expect(parseDeckDescriptor(wire({ characters: flood(200) }))).toBeNull();
    expect(parseDeckDescriptor(wire({ equipment: flood(200) }))).toBeNull();
    expect(parseDeckDescriptor(wire({ eventCards: flood(200) }))).toBeNull();
    // 遊戲實際是 3 槽位 / 3 武器 / 18 格事件卡，留一倍餘裕都要收
    expect(parseDeckDescriptor(wire({ eventCards: flood(18) }))).not.toBeNull();
  });

  it("收進來的描述子也會被排序", () => {
    const d = parseDeckDescriptor(wire({ characters: ["b", "a"], equipment: ["wp002", "wp001"] }));
    expect(d?.characters).toEqual(["a", "b"]);
    expect(d?.equipment).toEqual(["wp001", "wp002"]);
    expect(
      canonicalDeck({ v: 2, characters: ["b", "a"], equipment: [], eventCards: [] }).characters,
    ).toEqual(["a", "b"]);
  });
});

describe("這一場算出來的東西", () => {
  it("逐角定價、壓 C、上限、總和都在裡面 —— 不是只有總和", () => {
    const r = evaluateDeck(
      rule({
        teamCostLimit: 62,
        compressionRule: { type: "gap-band-v1", bands: [{ minGap: 5, extraCost: 5 }] },
      }),
      deck,
    );
    expect(r.characters).toEqual([
      ["abel_r3", "17.00"],
      ["evarist_r3", "18.00"],
      ["leon_r3", "22.00"],
    ]);
    // 17↔22 差 5 → +5；17↔18 差 1、18↔22 差 4，都不到門檻
    expect(r.compression).toEqual([["abel_r3", "leon_r3", "5.00", "5.00"]]);
    expect(r.limit).toBe("62.00");
    expect(r.total).toBe("62.00");
  });

  it("規則沒定價的鍵會被列出來（那些是用 99 頂替的）", () => {
    expect(evaluateDeck(rule(), slots("沒這隻")).unknown).toEqual(["沒這隻"]);
  });

  it("不設限時 limit 是 none，不是 0.00", () => {
    expect(evaluateDeck(rule(), deck).limit).toBe("none");
  });
});

describe("⚠ 差在沒上場的角色 → 可以打", () => {
  // 這就是整個 WP-16 的出發點：
  // 兩份規則只差在最新角色的定價，而雙方都沒帶那隻上場。
  const v150 = rule({ version: "1.5.0", characters: { ...rule().characters, newbie_r1: 25 } });
  const v151 = rule({ version: "1.5.1", characters: { ...rule().characters, newbie_r1: 26 } });

  it("兩份規則的內容確實不同", () => {
    expect(v150.characters["newbie_r1"]).not.toBe(v151.characters["newbie_r1"]);
  });

  it("但這一場的指紋一模一樣", () => {
    expect(fingerprint(v150, deck)).toBe(fingerprint(v151, deck));
  });

  it("四次交叉驗算都一致 → compatible", () => {
    const other = slots("leon_r3", "abel_r3");
    const mine = { host: fingerprint(v150, deck), guest: fingerprint(v150, other) };
    const theirs = { host: fingerprint(v151, deck), guest: fingerprint(v151, other) };
    expect(crossVerdict(mine, theirs)).toBe("compatible");
  });

  it("⚠ 有人帶了那隻新角色，同一組規則就變成不相容", () => {
    const withNew = slots("leon_r3", "abel_r3", "newbie_r1");
    const mine = { host: fingerprint(v150, deck), guest: fingerprint(v150, withNew) };
    const theirs = { host: fingerprint(v151, deck), guest: fingerprint(v151, withNew) };
    expect(crossVerdict(mine, theirs)).toBe("incompatible");
    expect(describeDisagreement(mine, theirs)).toContain("進房方");
  });
});

describe("⚠ 總和相同不等於相容", () => {
  // 這是「只比 totalCost」會出事的那個例子：兩份規則加起來都是 58，
  // 但每一隻角色的定價都不一樣。之後任何看單角 COST 的東西都會產生歧義。
  const a = rule({ characters: { x: 20, y: 20, z: 18 } });
  const b = rule({ characters: { x: 19, y: 20, z: 19 } });
  const three = slots("x", "y", "z");

  it("總和真的一樣", () => {
    expect(evaluateDeck(a, three).total).toBe(evaluateDeck(b, three).total);
  });

  it("但指紋不一樣 → incompatible", () => {
    expect(fingerprint(a, three)).not.toBe(fingerprint(b, three));
    expect(
      crossVerdict(
        { host: fingerprint(a, three), guest: fingerprint(a, three) },
        { host: fingerprint(b, three), guest: fingerprint(b, three) },
      ),
    ).toBe("incompatible");
  });
});

describe("⚠ 只差在上限也是真的差異", () => {
  it("同樣的定價、不同的 teamCostLimit → 指紋不同", () => {
    const a = rule({ teamCostLimit: 60 });
    const b = rule({ teamCostLimit: 62 });
    expect(fingerprint(a, deck)).not.toBe(fingerprint(b, deck));
  });
});

describe("⚠ 只差在壓 C 也是真的差異", () => {
  it("罰則區間不同 → 指紋不同（即使角色定價一字不差）", () => {
    const a = rule({
      compressionRule: { type: "gap-band-v1", bands: [{ minGap: 5, extraCost: 5 }] },
    });
    const b = rule({
      compressionRule: { type: "gap-band-v1", bands: [{ minGap: 5, extraCost: 1 }] },
    });
    expect(fingerprint(a, deck)).not.toBe(fingerprint(b, deck));
  });
});

describe("指紋本身", () => {
  it("同一份規則配同一副牌，算幾次都一樣（確定性）", () => {
    expect(fingerprint(rule(), deck)).toBe(fingerprint(rule(), deck));
  });

  it("格式是 sha256:… —— 跟規則的 contentHash 同一套", () => {
    expect(fingerprint(rule(), deck)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("⚠ 規則的名字／版本號／發行者不影響指紋 —— 那些不是計算的一部分", () => {
    const renamed = rule({ name: "換個名字", version: "9.9.9", publisher: { id: "x", name: "X" } });
    expect(fingerprint(renamed, deck)).toBe(fingerprint(rule(), deck));
  });
});
