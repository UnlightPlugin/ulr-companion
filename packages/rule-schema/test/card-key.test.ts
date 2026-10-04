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
  legacyEventId,
  legacyWeaponId,
  LEGACY_EVENT_IDS,
  LEGACY_WEAPON_IDS,
  toCardIdTable,
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

describe("2026-09-23 改版：舊索引 → 新卡片 id", () => {
  // 名字是 2026-09-24 對著改版後的客戶端與爬蟲的舊清單核對的。
  it("順序重排過 —— 索引 +1 不是 id", () => {
    expect(legacyWeaponId(0)).toBe(1); // 妖魔短劍
    expect(legacyWeaponId(1)).toBe(6); // 勇者短劍（新 WeaponCards[1] 是妖魔彈藥）
    expect(legacyWeaponId(3)).toBe(2); // 妖魔彈藥
    expect(legacyWeaponId(237)).toBe(277); // 成熟可可果
    expect(legacyEventId(0)).toBe(1); // 劍1卡
    expect(legacyEventId(91)).toBe(40); // 聖水
    expect(legacyEventId(109)).toBe(103); // 槍3·盾3卡
  });

  it("佔位卡「グレゴールの武器2」改名成武器3，不是夾在中間的斯托爾茲玫瑰", () => {
    expect(legacyWeaponId(211)).toBe(223);
    expect(legacyWeaponId(212)).toBe(222); // 斯托爾茲玫瑰，舊版就有
  });

  it("一對一：舊索引全部有對到、新 id 不重複", () => {
    expect(LEGACY_WEAPON_IDS).toHaveLength(238);
    expect(LEGACY_EVENT_IDS).toHaveLength(110);
    expect(new Set(LEGACY_WEAPON_IDS).size).toBe(238);
    expect(new Set(LEGACY_EVENT_IDS).size).toBe(110);
  });

  it("超出表的索引回 null", () => {
    expect(legacyWeaponId(238)).toBeNull();
    expect(legacyEventId(110)).toBeNull();
  });

  it("toCardIdTable：規則鍵直接換成新 id；認不得的收進 unmapped", () => {
    expect(
      toCardIdTable({ wp001: 3, wp999: 1, wp1: 2 }, parseEquipmentKey, legacyWeaponId),
    ).toEqual({ byId: { "6": 3 }, unmapped: ["wp999", "wp1"] });
    expect(toCardIdTable({ ev091: 0 }, parseEventCardKey, legacyEventId)).toEqual({
      byId: { "40": 0 },
      unmapped: [],
    });
  });
});
