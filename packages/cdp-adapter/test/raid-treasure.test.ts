/**
 * 渦的獎勵表與分類
 *
 * 表是 2026-09-13 從 ulgg 掃下來的快照；這裡驗的是**表本身的規律**（每個
 * TL 只有一種碎片、★1 與公式一致）跟 `classifyRaid()` 的取捨順序（有表查表、
 * 妖精沒表就不猜）。
 */

import { describe, expect, it } from "vitest";
import {
  classifyRaid,
  describeRaidClass,
  fragmentByFormula,
  fragmentOfEntry,
  lookupRaidTreasure,
  parseRaidStatusCode,
  RAID_TREASURE_TABLE,
  raidTierOf,
} from "@ulr/cdp-adapter";

describe("獎勵表", () => {
  it("60 個 TL，每一個都有四類獎勵", () => {
    expect(RAID_TREASURE_TABLE.size).toBe(60);
    for (const e of RAID_TREASURE_TABLE.values()) {
      expect(e.discovery.length).toBeGreaterThan(0);
      expect(e.participation.length).toBeGreaterThan(0);
      expect(e.ranking.length).toBeGreaterThan(0);
      expect(e.defeat.length).toBeGreaterThan(0);
      for (const r of e.ranking) {
        expect(r.rankMin).toBeTypeOf("number");
        expect(r.rankMax).toBeTypeOf("number");
      }
    }
  });

  it("每個 TL 的排名獎勵只有一種碎片", () => {
    for (const e of RAID_TREASURE_TABLE.values()) {
      const frags = new Set(e.ranking.map((r) => r.item).filter((n) => n.endsWith("的碎片")));
      expect(frags.size, `TL ${e.tl}`).toBe(1);
    }
  });

  it("非妖精的 TL 跟 rarity/stage 公式一致（公式是從表上讀出來的）", () => {
    for (const e of RAID_TREASURE_TABLE.values()) {
      if (e.mons === "mc1004") continue;
      expect(fragmentOfEntry(e)?.key, `TL ${e.tl}`).toBe(fragmentByFormula(e.rarity, e.stage)?.key);
    }
  });

  it("2100 是黑（素材）＋黃；2096 是白（書籤）＋黃；2091 只有黃", () => {
    const c2100 = classifyRaid({
      treasure_level: 2100,
      profound_mons: "mc1004_02",
      rarity: 6,
      stage: 3,
    });
    expect(c2100.special).toBe("material");
    expect(c2100.fragment?.key).toBe("memory");
    expect(c2100.fairy).toBe(true);
    expect(describeRaidClass(c2100)).toBe("素材黃妖");

    const c2096 = classifyRaid({
      treasure_level: 2096,
      profound_mons: "mc1004_02",
      rarity: 6,
      stage: 3,
    });
    expect(c2096.special).toBe("bookmark");
    expect(c2096.fragment?.key).toBe("memory");
    expect(describeRaidClass(c2096)).toBe("書籤黃妖");

    const c2091 = classifyRaid({
      treasure_level: 2091,
      profound_mons: "mc1008_02",
      rarity: 1,
      stage: 1,
    });
    expect(c2091.special).toBeNull();
    expect(c2091.fragment?.key).toBe("memory");
    expect(c2091.source).toBe("table");
    expect(describeRaidClass(c2091)).toBe("黃");
  });

  it("2096 的發現獎勵也有素材，但素材／書籤只看排名獎勵", () => {
    const e = lookupRaidTreasure(2096);
    expect(e?.discovery.some((r) => r.item === "魔之刀身")).toBe(true);
    expect(classifyRaid({ treasure_level: 2096, profound_mons: "mc1004_02" }).special).toBe(
      "bookmark",
    );
  });

  it("查不到 TL 就套公式；妖精查不到就不猜", () => {
    const turtle = classifyRaid({
      treasure_level: 9999,
      profound_mons: "mc1008_02",
      rarity: 6,
      stage: 2,
    });
    expect(turtle.source).toBe("formula");
    expect(turtle.fragment?.key).toBe("soul");
    expect(turtle.special).toBeNull();

    const fairy = classifyRaid({
      treasure_level: 9999,
      profound_mons: "mc1004_02",
      rarity: 6,
      stage: 3,
    });
    expect(fairy.source).toBe("none");
    expect(fairy.fragment).toBeNull();
    expect(fairy.fairy).toBe(true);

    expect(classifyRaid({}).source).toBe("none");
  });

  it("渦階：_01/_02/_03，妖精靠 rarity，吸血女王只有渦I", () => {
    expect(raidTierOf("mc1003_01", 1)).toBe(1);
    expect(raidTierOf("mc1003_02", 6)).toBe(23);
    expect(raidTierOf("mc1003_03", 1)).toBe(4);
    expect(raidTierOf("mc1004_02", 6)).toBe(23);
    expect(raidTierOf("mc1004_02", 5)).toBe(4);
    expect(raidTierOf("mc1005_01", 1)).toBe(1);
    expect(raidTierOf(null, 1)).toBeNull();
    expect(classifyRaid({ profound_mons: "mc1006_03", rarity: 1, stage: 2 }).tier).toBe(4);
  });
});

describe("BOSS 狀態代碼", () => {
  it("整字先查（poison2 是猛毒，不是中毒 2 級）", () => {
    expect(parseRaidStatusCode("poison2").text).toBe("猛毒");
    expect(parseRaidStatusCode("poison").text).toBe("中毒");
  });

  it("帶等級的拆數字", () => {
    const l = parseRaidStatusCode("atkB3");
    expect(l.code).toBe("atkB");
    expect(l.level).toBe(3);
    expect(l.text).toBe("攻↑3");
  });

  it("減益綠、增益紅、認不得的原樣印", () => {
    expect(parseRaidStatusCode("scare").color).toBe("#7ff2a0");
    expect(parseRaidStatusCode("bers").color).toBe("#ff7b7b");
    expect(parseRaidStatusCode("zzz").text).toBe("zzz");
  });
});
