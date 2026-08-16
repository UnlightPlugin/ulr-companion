/**
 * 裝備與事件卡的正規鍵
 *
 * 這一份釘的是一件事：**一張卡只能有一個鍵**。裝備與事件卡沒有 filename，
 * 鍵是從陣列索引組出來的，所以「同一個索引有兩種寫法」是這裡唯一致命的錯誤 ——
 * 一份規則裡同時出現 `wp1` 與 `wp001` 時，誰蓋掉誰取決於物件的鍵順序，
 * 而那正是「兩台電腦算出不同數字」的來源。
 */

import { describe, expect, it } from "vitest";
import {
  CARD_INDEX_PAD,
  equipmentKey,
  eventCardKey,
  parseEquipmentKey,
  parseEventCardKey,
  toIndexTable,
} from "@ulr/rule-schema";

describe("組鍵", () => {
  it("補零到三位", () => {
    expect(equipmentKey(0)).toBe("wp000");
    expect(equipmentKey(1)).toBe("wp001");
    expect(equipmentKey(237)).toBe("wp237"); // 2026-08-16 實測 238 件，最後一件
    expect(eventCardKey(91)).toBe("ev091"); // 聖水
    expect(eventCardKey(109)).toBe("ev109"); // 實測 110 張，最後一張
  });

  it("超過三位就四位 —— 不截斷、也不改補法", () => {
    // 改補零位數會讓所有既有的鍵一次全部失效，那比多一位數難處理得多。
    expect(equipmentKey(1000)).toBe("wp1000");
    expect(CARD_INDEX_PAD).toBe(3);
  });

  it("非索引的東西一律拋錯，不會靜靜地組出一個怪鍵", () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => equipmentKey(bad)).toThrow(RangeError);
      expect(() => eventCardKey(bad)).toThrow(RangeError);
    }
  });
});

describe("解鍵", () => {
  it("認得自己組出來的鍵", () => {
    for (const i of [0, 1, 91, 237, 1000]) {
      expect(parseEquipmentKey(equipmentKey(i))).toBe(i);
      expect(parseEventCardKey(eventCardKey(i))).toBe(i);
    }
  });

  it("⚠ 沒補零的寫法不收 —— 一張卡只能有一個鍵", () => {
    expect(parseEquipmentKey("wp1")).toBeNull();
    expect(parseEquipmentKey("wp01")).toBeNull();
    expect(parseEventCardKey("ev91")).toBeNull();
  });

  it("⚠ 補過頭的寫法也不收", () => {
    expect(parseEquipmentKey("wp0001")).toBeNull();
  });

  it("前綴要對 —— 四張表的鍵不能互相認領", () => {
    expect(parseEquipmentKey("ev091")).toBeNull();
    expect(parseEventCardKey("wp001")).toBeNull();
    expect(parseEquipmentKey("cc078_04")).toBeNull();
    expect(parseEquipmentKey("mc001_01")).toBeNull();
  });

  it("不是數字的尾巴不收", () => {
    expect(parseEquipmentKey("wp00a")).toBeNull();
    expect(parseEquipmentKey("wp")).toBeNull();
    expect(parseEquipmentKey("wp-01")).toBeNull();
  });
});

describe("toIndexTable", () => {
  it("鍵換成索引字串 —— 注入的腳本只認得索引", () => {
    expect(toIndexTable({ wp000: 0, wp001: 1, wp237: 3 }, parseEquipmentKey)).toEqual({
      byIndex: { "0": 0, "1": 1, "237": 3 },
      unmapped: [],
    });
  });

  it("⚠ 認不得的鍵是收進 unmapped，不是丟掉", () => {
    // 丟掉等於那張卡的價格安靜地沒生效 —— §9「不得靜默產生錯誤資料」。
    const r = toIndexTable({ wp001: 1, wp1: 9, SWORD_4: 2 }, parseEquipmentKey);
    expect(r.byIndex).toEqual({ "1": 1 });
    expect(r.unmapped).toEqual(["wp1", "SWORD_4"]);
  });

  it("沒有表就是空的，不是錯誤 —— 只定價角色的規則是最常見的形態", () => {
    expect(toIndexTable(undefined, parseEquipmentKey)).toEqual({ byIndex: {}, unmapped: [] });
  });
});
