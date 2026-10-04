/**
 * 渦 BOSS 被動：什麼時候開（規則照原版伺服器 chara_card.rb 的 check_*_passive）、
 * Discord 那一行怎麼標、狗每 10 分鐘自己重畫、HP 跨門檻馬上重畫。
 */

import { describe, expect, it } from "vitest";
import {
  activeRaidPassives,
  nextRaidPassiveChange,
  raidPassiveIdsOf,
} from "../src/raid-passive.js";
import {
  formatRaidFeedLine,
  normalizeRaidFeedUpload,
  RaidFeedBook,
  raidFeedId,
  type RaidFeedIn,
} from "../src/raid-feed.js";

const MIN = 60_000;
/** 某個整點（UTC 分鐘 0）。 */
const HOUR0 = Date.UTC(2026, 9, 4, 3, 0, 0);
const at = (minute: number, sec = 0) => HOUR0 + minute * MIN + sec * 1000;

const DOG = [11, 12];
const WORM = [18, 19];
const SEA = [27];
const TURTLE = [35];
const shorts = (ids: number[], hp: number | null, hpMax: number | null, now?: number) =>
  activeRaidPassives(ids, hp, hpMax, now).map((p) => p.short);

describe("哪隻 BOSS 帶哪些被動", () => {
  it("看代碼本體（_01/_02/_03 都一樣）", () => {
    expect(raidPassiveIdsOf({ mons: "mc1003_02", name: null })).toEqual(DOG);
    expect(raidPassiveIdsOf({ mons: "mc1003_03", name: "瘟疫" })).toEqual(DOG);
    expect(raidPassiveIdsOf({ mons: "mc1006_01", name: null })).toEqual(WORM);
    expect(raidPassiveIdsOf({ mons: "mc1007_02", name: null })).toEqual(SEA);
    expect(raidPassiveIdsOf({ mons: "mc1008_03", name: null })).toEqual(TURTLE);
    expect(raidPassiveIdsOf({ mons: "mc1009_02", name: null })).toEqual([105]);
    expect(raidPassiveIdsOf({ mons: "mc1013_03", name: null })).toEqual([140]);
    expect(raidPassiveIdsOf({ mons: "mc1012_02", name: "龍鯰" })).toEqual([]);
    expect(raidPassiveIdsOf({ mons: "mc1010_01", name: "惡魔之角" })).toEqual([]);
  });

  it("沒有代碼就看名字（繁簡）", () => {
    expect(raidPassiveIdsOf({ mons: null, name: "黑死獸" })).toEqual(DOG);
    expect(raidPassiveIdsOf({ mons: null, name: "屠杀者" })).toEqual(WORM);
    expect(raidPassiveIdsOf({ mons: null, name: "誘引之者" })).toEqual(SEA);
    expect(raidPassiveIdsOf({ mons: null, name: "灵龟" })).toEqual(TURTLE);
    expect(raidPassiveIdsOf({ mons: null, name: "W.M.公主" })).toEqual([105]);
    expect(raidPassiveIdsOf({ mons: null, name: "翔天虫" })).toEqual([140]);
    expect(raidPassiveIdsOf({ mons: null, name: "新怪" })).toEqual([]);
    expect(raidPassiveIdsOf({ mons: null, name: null })).toEqual([]);
  });
});

describe("狗：看現實時間的分鐘（10–19／40–49 硬化、20–29／50–59 吸收）", () => {
  it("每一段的頭尾", () => {
    expect(shorts(DOG, 100, 100, at(9, 59))).toEqual([]);
    expect(shorts(DOG, 100, 100, at(10))).toEqual(["硬化"]);
    expect(shorts(DOG, 100, 100, at(19, 59))).toEqual(["硬化"]);
    expect(shorts(DOG, 100, 100, at(20))).toEqual(["吸收"]);
    expect(shorts(DOG, 100, 100, at(29, 59))).toEqual(["吸收"]);
    expect(shorts(DOG, 100, 100, at(30))).toEqual([]);
    expect(shorts(DOG, 100, 100, at(39, 59))).toEqual([]);
    expect(shorts(DOG, 100, 100, at(40))).toEqual(["硬化"]);
    expect(shorts(DOG, 100, 100, at(50))).toEqual(["吸收"]);
    expect(shorts(DOG, 100, 100, at(59, 59))).toEqual(["吸收"]);
    expect(shorts(DOG, 100, 100, at(60))).toEqual([]);
  });

  it("until 是那一段結束（下一段的頭）", () => {
    expect(activeRaidPassives(DOG, 100, 100, at(13, 30))).toEqual([
      { id: 11, short: "硬化", until: at(20) },
    ]);
    expect(activeRaidPassives(DOG, 100, 100, at(55))).toEqual([
      { id: 12, short: "吸收", until: at(60) },
    ]);
  });

  it("HP 不影響；沒給時間就不判斷；死了不開", () => {
    expect(shorts(DOG, 1, 50000, at(15))).toEqual(["硬化"]);
    expect(shorts(DOG, null, null, at(15))).toEqual(["硬化"]);
    expect(shorts(DOG, 100, 100)).toEqual([]);
    expect(shorts(DOG, 0, 100, at(15))).toEqual([]);
  });

  it("下一次換班：10 分鐘一次", () => {
    expect(nextRaidPassiveChange(DOG, at(0))).toBe(at(10));
    expect(nextRaidPassiveChange(DOG, at(9, 59))).toBe(at(10));
    expect(nextRaidPassiveChange(DOG, at(10))).toBe(at(20));
    expect(nextRaidPassiveChange(DOG, at(25))).toBe(at(30));
    expect(nextRaidPassiveChange(DOG, at(35))).toBe(at(40));
    expect(nextRaidPassiveChange(DOG, at(55))).toBe(at(60));
    expect(nextRaidPassiveChange(WORM, at(55))).toBeNull();
  });
});

describe("HP 制（整數除法，跟伺服器一樣）", () => {
  it("蟲：3/5 以下潛伏、2/5 以下換成濁濫", () => {
    expect(shorts(WORM, 721, 1200)).toEqual([]);
    expect(shorts(WORM, 720, 1200)).toEqual(["潛伏"]);
    expect(shorts(WORM, 481, 1200)).toEqual(["潛伏"]);
    expect(shorts(WORM, 480, 1200)).toEqual(["濁濫"]);
    expect(shorts(WORM, 1, 1200)).toEqual(["濁濫"]);
    expect(shorts(WORM, 0, 1200)).toEqual([]);
  });

  it("海：一半以下夜霧（max 是奇數時捨去）", () => {
    expect(shorts(SEA, 451, 901)).toEqual([]);
    expect(shorts(SEA, 450, 901)).toEqual(["夜霧"]);
  });

  it("龜：1/3 以下隱身", () => {
    expect(shorts(TURTLE, 2001, 6000)).toEqual([]);
    expect(shorts(TURTLE, 2000, 6000)).toEqual(["隱身"]);
  });

  it("W.M.：一半以下收穫；翔蟲：一半以下磁暴（BOSS 那一半）", () => {
    expect(shorts([105], 451, 900)).toEqual([]);
    expect(shorts([105], 450, 900)).toEqual(["收穫"]);
    expect(shorts([140], 1701, 3400)).toEqual([]);
    expect(shorts([140], 1700, 3400)).toEqual(["磁暴"]);
  });

  it("HP 不知道就不判斷", () => {
    expect(shorts(SEA, null, 900)).toEqual([]);
    expect(shorts(SEA, 100, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

const raid = (over: Partial<RaidFeedIn> = {}): RaidFeedIn => ({
  founder: "燈皇",
  foundAt: at(-60),
  limit: at(5 * 60),
  name: "黑死獸",
  monsterId: 30011,
  mons: "mc1003_02",
  hp: 40000,
  hpMax: 50000,
  memberLength: 3,
  memberLimit: 100,
  rarity: null,
  level: null,
  stage: null,
  mapIndex: null,
  states: null,
  statesAt: null,
  ...over,
});

describe("Discord 那一行", () => {
  it("被動排在 ★ 後面、狀態前面", () => {
    expect(formatRaidFeedLine(raid({ rarity: 6 }), at(12))).toBe(
      "燈皇 ❓狗🐶 40000/50000｜✨6★｜硬化",
    );
    expect(
      formatRaidFeedLine(
        raid({
          states: [{ type: "mahi", until: null, count: null }],
          statesAt: at(0),
        }),
        at(22),
      ),
    ).toBe("燈皇 ❓狗🐶 40000/50000｜吸收｜麻");
    expect(formatRaidFeedLine(raid(), at(5))).toBe("燈皇 ❓狗🐶 40000/50000");
  });

  it("沒給時間就只標 HP 制的", () => {
    expect(formatRaidFeedLine(raid())).toBe("燈皇 ❓狗🐶 40000/50000");
    expect(formatRaidFeedLine(raid({ name: "誘引之者", mons: null, hp: 400, hpMax: 900 }))).toBe(
      "燈皇 ❓海🐙 400/900｜夜霧",
    );
  });

  it("死了、到期了都不標", () => {
    expect(formatRaidFeedLine(raid({ hp: 0 }), at(12))).toBe("燈皇 ❓狗🐶☠️ 0/50000");
    expect(formatRaidFeedLine(raid({ limit: at(11) }), at(12))).toBe("燈皇 ❓狗🐶⌛ 40000/50000");
  });
});

const parse = (source: string, raids: unknown[], now: number) => {
  const u = normalizeRaidFeedUpload({ source, raids }, now);
  if (u === null) throw new Error("rejected");
  return u;
};

describe("Discord 訊息什麼時候改", () => {
  it("狗：每次換班（10 分鐘）自己重畫", () => {
    const book = new RaidFeedBook();
    const r = raid();
    book.ingest(parse("support", [r], at(3)), at(3));
    const m = book.markPosted([raidFeedId(r)], "m1", false, at(3));
    expect(m.stateExpiry).toBe(at(10));
    expect(book.nextWake(at(3))).toBe(at(10));
    expect(book.expireStates(at(9, 59)).messages).toEqual([]);
    expect(book.expireStates(at(10)).messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, at(10))).toBe("🆕 燈皇 ❓狗🐶 40000/50000｜硬化");
    book.rendered(m, at(10));
    expect(m.stateExpiry).toBe(at(20));
  });

  it("死了的狗不再換班", () => {
    const book = new RaidFeedBook();
    const r = raid();
    book.ingest(parse("support", [r], at(3)), at(3));
    const m = book.markPosted([raidFeedId(r)], "m1", false, at(3));
    book.ingest(parse("support", [raid({ hp: 0 })], at(4)), at(4));
    book.rendered(m, at(4));
    expect(m.stateExpiry).toBeNull();
  });

  it("HP 跨過門檻：馬上改，不等一分鐘的限流", () => {
    const book = new RaidFeedBook();
    const sea = raid({ name: "誘引之者", mons: "mc1007_02", hp: 600, hpMax: 900 });
    book.ingest(parse("support", [sea], at(1)), at(1));
    const m = book.markPosted([raidFeedId(sea)], "m1", false, at(1));
    // 掉一點但還沒到一半：照 HP 限流排一分鐘後
    book.ingest(parse("support", [{ ...sea, hp: 500 }], at(1, 10)), at(1, 10));
    expect(m.dirty).toBe(false);
    // 掉到一半以下：夜霧開了，馬上改
    book.ingest(parse("support", [{ ...sea, hp: 450 }], at(1, 20)), at(1, 20));
    expect(m.dirty).toBe(true);
    expect(book.renderMessage(m, null, at(1, 20))).toBe("🆕 燈皇 ❓海🐙 450/900｜夜霧");
  });
});
