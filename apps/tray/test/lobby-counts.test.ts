/**
 * 「我自己」要算在哪一檔
 *
 * 這一支測的是玩家 2026-08-19 回報的兩句話：「按下去人數沒立刻增加」與
 * 「取消時也要立刻反應」。兩句都是同一個 off-by-one，而它**只會顯示成一個
 * 看起來很正常的數字** —— 沒有錯誤、沒有例外，所以只有測試抓得到。
 */

import { describe, expect, it } from "vitest";
import type { TierCount, TierRef } from "../src/lobby-counts.js";
import { displayCounts, sameTier, tierOf } from "../src/lobby-counts.js";

const BAND = (tier: number): TierRef => ({ tier, open: false });
const OPEN = (tier: number): TierRef => ({ tier, open: true });

/** 亞城那四行的形狀：三個有上限的檔 + 一個開口檔。 */
function counts(a: number, b: number, c: number, open: number): TierCount[] {
  return [
    { tier: 54, waiting: a },
    { tier: 61, waiting: b },
    { tier: 77, waiting: c },
    { tier: 90, waiting: open, open: true },
  ];
}

const waiting = (rows: TierCount[] | null): number[] => (rows ?? []).map((r) => r.waiting);

describe("displayCounts", () => {
  it("沒排隊時原封不動 —— 中間人講什麼就是什麼", () => {
    const rows = displayCounts({
      counts: counts(2, 0, 1, 0),
      fetchedWhileIn: null,
      nowIn: null,
    });
    expect(waiting(rows)).toEqual([2, 0, 1, 0]);
  });

  it("⚠ 剛按下快速比賽：那一檔立刻 +1，不必等下一輪輪詢", () => {
    const rows = displayCounts({
      counts: counts(0, 0, 0, 0),
      fetchedWhileIn: null,
      nowIn: BAND(54),
    });
    expect(waiting(rows)).toEqual([1, 0, 0, 0]);
  });

  it("⚠ 剛按取消：那一檔立刻 −1", () => {
    const rows = displayCounts({
      counts: counts(1, 0, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: null,
    });
    expect(waiting(rows)).toEqual([0, 0, 0, 0]);
  });

  it("其他人的數字要留著 —— 取消只扣掉我自己", () => {
    const rows = displayCounts({
      counts: counts(3, 0, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: null,
    });
    expect(waiting(rows)).toEqual([2, 0, 0, 0]);
  });

  it("排在那一檔而中間人已經算過我了 → 不重複算", () => {
    const rows = displayCounts({
      counts: counts(1, 0, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: BAND(54),
    });
    expect(waiting(rows)).toEqual([1, 0, 0, 0]);
  });

  it("⚠ 我排著的那一檔至少是 1 —— 中間人可能還沒處理完我的 q-hello", () => {
    const rows = displayCounts({
      counts: counts(0, 0, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: BAND(54),
    });
    expect(waiting(rows)).toEqual([1, 0, 0, 0]);
  });

  it("⚠ 不會出現負數 —— 中間人那份可能已經比我的動作新", () => {
    const rows = displayCounts({
      counts: counts(0, 0, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: null,
    });
    expect(waiting(rows)).toEqual([0, 0, 0, 0]);
  });

  it("換檔位：舊的扣掉、新的加上", () => {
    const rows = displayCounts({
      counts: counts(1, 2, 0, 0),
      fetchedWhileIn: BAND(54),
      nowIn: BAND(61),
    });
    expect(waiting(rows)).toEqual([0, 3, 0, 0]);
  });

  it("⚠ 開口檔跟同號的一般檔是**兩條不同的佇列**", () => {
    const rows = displayCounts({
      counts: [
        { tier: 90, waiting: 0 },
        { tier: 90, waiting: 0, open: true },
      ],
      fetchedWhileIn: null,
      nowIn: OPEN(90),
    });
    // 只有開口檔那一行 +1
    expect(waiting(rows)).toEqual([0, 1]);
  });

  it("還沒問到人數就是 null —— 那幾行整個不畫，不是畫成 0", () => {
    expect(displayCounts({ counts: null, fetchedWhileIn: null, nowIn: BAND(54) })).toBeNull();
  });

  it("不改到傳進來的那份 —— 它是下一輪要拿來比對的基準", () => {
    const base = counts(0, 0, 0, 0);
    displayCounts({ counts: base, fetchedWhileIn: null, nowIn: BAND(54) });
    expect(waiting(base)).toEqual([0, 0, 0, 0]);
  });
});

describe("sameTier", () => {
  it("兩個 null 算同一檔（都是沒排）", () => {
    expect(sameTier(null, null)).toBe(true);
  });

  it("null 跟任何一檔都不同", () => {
    expect(sameTier(null, BAND(54))).toBe(false);
    expect(sameTier(BAND(54), null)).toBe(false);
  });

  it("號碼一樣但 open 不同 = 不同檔", () => {
    expect(sameTier(BAND(90), OPEN(90))).toBe(false);
    expect(sameTier(OPEN(90), OPEN(90))).toBe(true);
  });
});

describe("tierOf", () => {
  it("有上限 = 一般檔", () => {
    expect(tierOf({ costLimit: 54, costFloor: null })).toEqual({ tier: 54, open: false });
  });

  it("有下限 = 開口檔", () => {
    expect(tierOf({ costLimit: null, costFloor: 90 })).toEqual({ tier: 90, open: true });
  });

  it("兩個都沒有 → null（不知道自己在哪一檔，畫面就完全照中間人走）", () => {
    expect(tierOf({ costLimit: null, costFloor: null })).toBeNull();
  });
});
