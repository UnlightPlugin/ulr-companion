/**
 * 渦獎勵表：邊打邊學
 *
 * 要抓的：
 * 1. 參加者的獎勵併成一檔一檔；中間有人拿空的不切斷；最後一檔開到底
 * 2. 看不到的那一類（不是發現者／沒打最後一擊）是 null，不會把學過的蓋成「沒有」
 * 3. 兩次對不上 → conflict、用新的；對得上 → 排名留看過比較多人的那份
 * 4. 硬碟上壞掉的那一筆丟掉，其他照收
 */

import { describe, expect, it } from "vitest";
import {
  appendLearnLog,
  isRaidLearnReport,
  mergeLearned,
  parseLearnedTable,
  parseLearnLog,
  RAID_LEARN_LOG_MAX,
  raidRewardKey,
  rankTiers,
  rebuildLearned,
  tierAt,
  type RaidLearnSample,
  type RaidRewardCode,
} from "@ulr/cdp-adapter";

const BLADE = (n: number): RaidRewardCode => ({ type: 2, id: 5005, slot: 0, value: n });
const POTION: RaidRewardCode = { type: 3, id: 2, slot: 0, value: 2 };
const WITCH: RaidRewardCode = { type: 3, id: 3, slot: 0, value: 1 };

const SAMPLE = (over: Partial<RaidLearnSample> = {}): RaidLearnSample => ({
  profoundId: "p1",
  name: "龍鯰",
  monsterId: 30130,
  level: 1,
  rarity: 1,
  mapIndex: 5,
  category: "another",
  founder: null,
  participate: [POTION],
  defeat: null,
  ranks: [
    ...Array.from({ length: 10 }, () => [BLADE(2)]),
    ...Array.from({ length: 5 }, () => [BLADE(1)]),
  ],
  stage: null,
  at: 1000,
  ...over,
});

describe("渦獎勵表", () => {
  it("渦鍵跟 探渦.py 同一把", () => {
    expect(raidRewardKey({ monsterId: 30130, level: 1, rarity: 6, mapIndex: 7 })).toBe(
      "m30130-L1-R6-M7",
    );
  });

  it("參加者的獎勵併成檔；中間拿空的不切斷；最後一檔開到底", () => {
    const tiers = rankTiers([[BLADE(2)], [BLADE(2)], [], [BLADE(2)], [BLADE(1)], [], [BLADE(1)]]);
    expect(tiers).toEqual([
      { from: 1, to: 4, items: [BLADE(2)] },
      { from: 5, to: null, items: [BLADE(1)] },
    ]);
    expect(tierAt(tiers, 3)?.items).toEqual([BLADE(2)]);
    expect(tierAt(tiers, 99)?.items).toEqual([BLADE(1)]);
    // 同一組東西換順序算同一檔
    expect(
      rankTiers([
        [BLADE(1), POTION],
        [POTION, BLADE(1)],
      ]),
    ).toHaveLength(1);
  });

  it("第一次學：看不到的類別是 null，擊破空的也當看不到", () => {
    const { table, isNew, entry } = mergeLearned({}, SAMPLE({ defeat: [] as RaidRewardCode[] }));
    expect(isNew).toBe(true);
    expect(Object.keys(table)).toEqual(["m30130-L1-R1-M5"]);
    expect(entry).toMatchObject({
      discovery: null,
      participation: [POTION],
      defeat: null,
      rankSeen: 15,
      samples: 1,
      conflict: false,
    });
    expect(entry.ranking).toEqual([
      { from: 1, to: 10, items: [BLADE(2)] },
      { from: 11, to: null, items: [BLADE(1)] },
    ]);
  });

  it("再學一次：看得到的補上、看不到的不蓋掉；排名留看過比較多人的", () => {
    const first = mergeLearned({}, SAMPLE({ defeat: [WITCH] })).table;
    const { entry, conflict } = mergeLearned(
      first,
      SAMPLE({ at: 2000, founder: [BLADE(3)], defeat: null, ranks: [[BLADE(2)], [BLADE(2)]] }),
    );
    expect(conflict).toBe(false);
    expect(entry.discovery).toEqual([BLADE(3)]);
    expect(entry.defeat).toEqual([WITCH]);
    expect(entry.rankSeen).toBe(15);
    expect(entry.ranking).toHaveLength(2);
    expect(entry.samples).toBe(2);
    expect(entry.at).toBe(2000);
  });

  it("category 不同不算對不上：自己開的是 normal、別人的是 another", () => {
    const first = mergeLearned({}, SAMPLE({ category: "another" })).table;
    const { conflict, entry } = mergeLearned(first, SAMPLE({ at: 2000, category: "normal" }));
    expect(conflict).toBe(false);
    expect(entry.conflict).toBe(false);
  });

  it("用 log 重算：舊規則誤標的 conflict 恢復；log 沒有的舊條目照留", () => {
    const stale = mergeLearned({}, SAMPLE()).table;
    const key = Object.keys(stale)[0]!;
    const other = { ...stale[key]!, key: "m1-L1-R1-M1", monsterId: 1 };
    const table = { [key]: { ...stale[key]!, conflict: true }, [other.key]: other };
    const rebuilt = rebuildLearned(table, [
      SAMPLE({ profoundId: "b", at: 2000, category: "normal" }),
      SAMPLE({ profoundId: "a", at: 1000, category: "another" }),
    ]);
    expect(rebuilt[key]!.conflict).toBe(false);
    expect(rebuilt[key]!.samples).toBe(2);
    expect(rebuilt[other.key]).toEqual(other);
  });

  it("同一個名次拿到不一樣 → conflict，改用新的那份", () => {
    const first = mergeLearned({}, SAMPLE()).table;
    const { entry, conflict } = mergeLearned(
      first,
      SAMPLE({ at: 2000, ranks: [[WITCH], [WITCH]] }),
    );
    expect(conflict).toBe(true);
    expect(entry.conflict).toBe(true);
    expect(entry.ranking).toEqual([{ from: 1, to: null, items: [WITCH] }]);
    // 沒有角色卡（碎片）可比：碎片不算對不上
    expect(entry.fragConflict).toBe(false);
  });

  it("第 1 名的碎片（角色卡）不一樣才標 fragConflict", () => {
    const MEM = { type: 1, id: 10006, slot: 0, value: 2 };
    const TIME = { type: 1, id: 10007, slot: 0, value: 2 };
    const first = mergeLearned({}, SAMPLE({ ranks: [[MEM], [MEM]] })).table;
    // 碎片一樣、其他（第 2 名）不一樣：conflict 但碎片沒錯
    const same = mergeLearned(first, SAMPLE({ at: 2000, ranks: [[MEM], [WITCH]] })).entry;
    expect(same).toMatchObject({ conflict: true, fragConflict: false });
    const diff = mergeLearned(first, SAMPLE({ at: 2000, ranks: [[TIME], [TIME]] })).entry;
    expect(diff).toMatchObject({ conflict: true, fragConflict: true });
  });

  it("看不到不算對不上：參加獎勵空的當沒看到、排名最後拿空的不算看過（2026-09-25 黑死獸 M1／M5）", () => {
    // M5：第一筆參加獎勵是空的
    const a = mergeLearned({}, SAMPLE({ participate: [] })).table;
    expect(Object.values(a)[0]!.participation).toBeNull();
    expect(mergeLearned(a, SAMPLE({ at: 2000 })).conflict).toBe(false);
    // M1：第一筆第 11 名拿空的（最後一檔開到底是 x2），第二筆看到第 11 名拿 x1
    const b = mergeLearned(
      {},
      SAMPLE({ ranks: [...Array.from({ length: 10 }, () => [BLADE(2)]), []] }),
    ).table;
    expect(Object.values(b)[0]!.rankSeen).toBe(10);
    const { conflict, entry } = mergeLearned(b, SAMPLE({ at: 2000 }));
    expect(conflict).toBe(false);
    expect(entry.rankSeen).toBe(15);
  });

  it("舊檔沒有 fragConflict：照 conflict", () => {
    const good = mergeLearned({}, SAMPLE()).table;
    const key = Object.keys(good)[0]!;
    const { fragConflict: _drop, ...old } = { ...good[key]!, conflict: true };
    const parsed = parseLearnedTable({ version: 1, entries: { [key]: old } });
    expect(parsed[key]!.fragConflict).toBe(true);
  });

  it("硬碟上那份：壞掉的丟掉，其他照收", () => {
    const good = mergeLearned({}, SAMPLE()).table;
    const parsed = parseLearnedTable({
      version: 1,
      entries: { ...good, bad: { name: "x" } },
    });
    expect(Object.keys(parsed)).toEqual(["m30130-L1-R1-M5"]);
    expect(parsed["m30130-L1-R1-M5"]).toEqual(good["m30130-L1-R1-M5"]);
    expect(parseLearnedTable(null)).toEqual({});
  });

  it("原料 log：同一個渦只留一筆、超過上限丟最舊的；硬碟上壞掉的丟掉", () => {
    let log = appendLearnLog([], SAMPLE({ profoundId: "a" }));
    log = appendLearnLog(log, SAMPLE({ profoundId: "a", stage: 3 }));
    expect(log).toHaveLength(1);
    expect(log[0]!.stage).toBe(3);
    for (let i = 0; i < RAID_LEARN_LOG_MAX + 5; i++)
      log = appendLearnLog(log, SAMPLE({ profoundId: `p${i}` }));
    expect(log).toHaveLength(RAID_LEARN_LOG_MAX);
    expect(log.at(-1)!.profoundId).toBe(`p${RAID_LEARN_LOG_MAX + 4}`);
    expect(parseLearnLog({ log: [SAMPLE(), { profoundId: "x" }] })).toEqual([SAMPLE()]);
    expect(parseLearnLog({})).toEqual([]);
  });

  it("回報的形狀檢查", () => {
    expect(isRaidLearnReport({ type: "raid-learn", sample: SAMPLE() })).toBe(true);
    expect(isRaidLearnReport({ type: "raid-learn", sample: { ...SAMPLE(), ranks: [[{}]] } })).toBe(
      false,
    );
    expect(isRaidLearnReport({ type: "raid-learn" })).toBe(false);
  });
});
