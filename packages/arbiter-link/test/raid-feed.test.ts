/**
 * 公開渦通知：形狀驗證、碎片、Discord 文字、帳本
 *
 * 重點：渦碼進不來、只有 SUPPORT 能新增、30 秒一批、碎片知道了才改訊息、
 * 只有 HP 變了不寫 storage。
 */

import { describe, expect, it } from "vitest";
import {
  formatRaidFeedBatch,
  formatRaidFeedLine,
  MAX_RAID_FEED_PER_POST,
  normalizeRaidFeedUpload,
  RAID_FEED_BATCH_MS,
  RAID_FEED_KEEP_AFTER_LIMIT_MS,
  RaidFeedBook,
  raidFeedFragment,
  raidFeedId,
  raidFeedTier,
  raidFeedTierOf,
  formatRaidFeedStates,
  parseRewardLookup,
  RAID_FEED_GONE_GRACE_MS,
  REWARD_LOOKUP_RETRY_MS,
  rewardLookupKey,
  type RaidFeedIn,
} from "../src/raid-feed.js";

const NOW = 1_791_030_000_000;
const HOUR = 60 * 60 * 1000;

/** 2026-10-03 實機讀到的 SUPPORT 一列（渦碼已拿掉）。 */
const support = (over: Record<string, unknown> = {}) => ({
  founder: "燈皇",
  foundAt: 1_791_029_788_126,
  limit: 1_791_051_388_126,
  name: "屠殺者",
  monsterId: 30114,
  hp: 284,
  hpMax: 1200,
  memberLength: 33,
  memberLimit: 100,
  ...over,
});

const own = (over: Record<string, unknown> = {}) => ({
  founder: "燈皇",
  foundAt: 1_791_029_788_126,
  limit: 1_791_051_388_126,
  hp: 325,
  hpMax: 1200,
  rarity: 1,
  level: 1,
  stage: 3,
  ...over,
});

const raid = (over: Partial<RaidFeedIn> = {}): RaidFeedIn => ({
  founder: "燈皇",
  foundAt: NOW - HOUR,
  limit: NOW + 5 * HOUR,
  name: "誘引之者",
  monsterId: 30117,
  mons: null,
  hp: 12000,
  hpMax: 20000,
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

const parse = (source: string, raids: unknown[]) => {
  const u = normalizeRaidFeedUpload({ source, raids }, NOW);
  if (u === null) throw new Error("rejected");
  return u;
};

describe("normalizeRaidFeedUpload", () => {
  it("收下 SUPPORT 的一列，缺的欄位是 null", () => {
    const u = parse("support", [support()]);
    expect(u.source).toBe("support");
    expect(u.raids[0]).toMatchObject({
      founder: "燈皇",
      memberLimit: 100,
      rarity: null,
      stage: null,
    });
  });

  it("渦碼欄位不會被收下", () => {
    const u = parse("support", [support({ profound_code: "ABCDEFGHIJKL", code: "ABCDEFGHIJKL" })]);
    expect(JSON.stringify(u)).not.toContain("ABCDEFGHIJKL");
  });

  it("整份不合格回 null", () => {
    expect(normalizeRaidFeedUpload(null, NOW)).toBeNull();
    expect(normalizeRaidFeedUpload({ source: "x", raids: [] }, NOW)).toBeNull();
    expect(normalizeRaidFeedUpload({ source: "own" }, NOW)).toBeNull();
    const many = Array.from({ length: MAX_RAID_FEED_PER_POST + 1 }, () => support());
    expect(normalizeRaidFeedUpload({ source: "support", raids: many }, NOW)).toBeNull();
  });

  it("壞的一筆丟掉，其他留著", () => {
    const u = parse("support", [
      support({ founder: "" }),
      support({ foundAt: NOW + HOUR }), // 未來發現的
      support({ foundAt: NOW - 25 * HOUR }), // 一天以前
      support({ limit: "soon" }),
      support(),
    ]);
    expect(u.raids).toHaveLength(1);
  });
});

describe("raidFeedFragment", () => {
  it("★1：stage 1～5 是黃綠藍紅紫", () => {
    const got = [1, 2, 3, 4, 5].map((stage) =>
      raidFeedFragment({ stage, rarity: 1, name: "屠殺者" }),
    );
    expect(got).toEqual(["memory", "time", "soul", "life", "death"]);
  });

  it("★6 往後錯一格", () => {
    const got = [1, 2, 3, 4, 5].map((stage) =>
      raidFeedFragment({ stage, rarity: 6, name: "龍鯰" }),
    );
    expect(got).toEqual(["time", "soul", "life", "death", "memory"]);
  });

  it("沒 stage、沒 ★、龍鯉（隨機）都推不出來", () => {
    expect(raidFeedFragment({ stage: null, rarity: 1, name: "屠殺者" })).toBeNull();
    expect(raidFeedFragment({ stage: 2, rarity: null, name: "屠殺者" })).toBeNull();
    expect(raidFeedFragment({ stage: 2, rarity: 1, name: "龍鯉" })).toBeNull();
  });
});

describe("raidFeedTier", () => {
  it("人數上限 80／100／120", () => {
    expect(raidFeedTier(80)).toBe("I");
    expect(raidFeedTier(100)).toBe("II/III");
    expect(raidFeedTier(120)).toBe("IV");
    expect(raidFeedTier(null)).toBeNull();
  });
});

describe("Discord 文字", () => {
  it("碎片知道了：顏色＋簡稱＋圖示", () => {
    expect(formatRaidFeedLine(raid({ stage: 4, rarity: 1 }))).toBe("燈皇 紅海🔴🐙 12000/20000");
  });

  it("碎片不知道：❓＋簡稱", () => {
    expect(formatRaidFeedLine(raid())).toBe("燈皇 ❓海🐙 12000/20000");
  });

  it("沒看過的 BOSS 留全名", () => {
    expect(formatRaidFeedLine(raid({ name: "新怪" }))).toBe("燈皇 ❓ 新怪 12000/20000");
  });

  it("★ 大於 1 標出來、死掉加骷髏", () => {
    expect(formatRaidFeedLine(raid({ rarity: 6, hp: 0 }))).toBe("燈皇 ❓海🐙☠️ 0/20000｜✨6★");
  });

  it("一個一行、多個加標題、mention 在最後一行", () => {
    expect(formatRaidFeedBatch([raid()], null)).toBe("🆕 燈皇 ❓海🐙 12000/20000");
    expect(formatRaidFeedBatch([raid(), raid({ founder: "B" })], "123")).toBe(
      "🆕 新增 2 個公開渦\n燈皇 ❓海🐙 12000/20000\nB ❓海🐙 12000/20000\n<@&123>",
    );
  });
});

describe("RaidFeedBook", () => {
  it("SUPPORT 新增、30 秒後才到期發", () => {
    const book = new RaidFeedBook();
    const c = book.ingest(parse("support", [support()]), NOW);
    expect(c.raids).toEqual([raidFeedId(support())]);
    expect(book.dueBatch(NOW + RAID_FEED_BATCH_MS - 1)).toEqual([]);
    expect(book.dueBatch(NOW + RAID_FEED_BATCH_MS)).toHaveLength(1);
    expect(book.nextWake(NOW)).toBe(NOW + RAID_FEED_BATCH_MS);
  });

  it("固定窗：後到的不延長", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("support", [support({ founder: "B" })]), NOW + 20_000);
    expect(book.dueBatch(NOW + RAID_FEED_BATCH_MS)).toHaveLength(2);
  });

  it("自己的清單不能新增（好友限定的渦不能被公告）", () => {
    const book = new RaidFeedBook();
    const c = book.ingest(parse("own", [own()]), NOW);
    expect(c.raids).toEqual([]);
    expect(book.size).toBe(0);
  });

  it("已經死掉的不發；渦 I 也發", () => {
    const book = new RaidFeedBook();
    book.ingest(
      parse("support", [support({ memberLimit: 80 }), support({ founder: "B", hp: 0 })]),
      NOW,
    );
    expect(book.size).toBe(2);
    expect(book.dueBatch(NOW + RAID_FEED_BATCH_MS).map((r) => r.founder)).toEqual([
      support().founder,
    ]);
  });

  it("以前被跳過（舊規則的渦 I）、還活著的：再看到就補發", () => {
    const old = { ...raid({ memberLimit: 80 }), firstSeenAt: NOW - HOUR, seenAt: NOW - HOUR };
    const book = new RaidFeedBook([
      { ...old, status: "skipped", messageId: null },
      { ...old, founder: "B", status: "skipped", messageId: null, failed: true },
    ]);
    const c = book.ingest(
      { source: "support", raids: [raid(), raid({ founder: "B" })], complete: false, present: [] },
      NOW,
    );
    expect(c.raids).toContain(raidFeedId(raid()));
    expect(book.dueBatch(NOW).map((r) => r.founder)).toEqual(["燈皇"]);
  });

  it("發之前就知道 stage：發出去的那一行直接有碎片", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("own", [own()]), NOW + 1000);
    const [r] = book.dueBatch(NOW + RAID_FEED_BATCH_MS);
    expect(r && formatRaidFeedLine(r)).toBe("燈皇 藍蟲🔵🐛 325/1200");
  });

  it("發了之後才知道 stage：那則訊息要重畫", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    const batch = book.dueBatch(NOW + RAID_FEED_BATCH_MS);
    book.markPosted(batch.map(raidFeedId), "m1", false);
    expect(book.dirtyMessages()).toEqual([]);

    const c = book.ingest(parse("own", [own()]), NOW + 60_000);
    expect(c.messages).toEqual(["m1"]);
    const m = book.message("m1");
    expect(m?.dirty).toBe(true);
    expect(m && book.renderMessage(m, "123")).toBe("🆕 燈皇 藍蟲🔵🐛 325/1200");
    expect(book.nextWake(NOW + 60_000)).toBe(NOW + 60_000);
  });

  it("mention 過的訊息重畫時保留 mention 那一行", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support({ memberLimit: 120 })]), NOW);
    book.markPosted([raidFeedId(support())], "m1", true);
    const m = book.message("m1");
    expect(m && book.renderMessage(m, "123")).toMatch(/\n<@&123>$/);
  });

  it("已發出的訊息：HP 變了也改，但同一則最多一分鐘一次", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    const m = book.markPosted([raidFeedId(support())], "m1", false, NOW);
    // 30 秒後 HP 變了：排在上次改之後一分鐘
    let c = book.ingest(parse("support", [support({ hp: 200 })]), NOW + 30_000);
    expect(m.dirty).toBe(false);
    expect(m.stateExpiry).toBe(NOW + 60_000);
    expect(c.messages).toEqual(["m1"]);
    expect(book.nextWake(NOW + 30_000)).toBe(NOW + 60_000);
    // 時間到了 alarm 重畫，用最新的 HP
    c = book.ingest(parse("support", [support({ hp: 150 })]), NOW + 50_000);
    expect(book.expireStates(NOW + 60_000).messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, NOW + 60_000)).toBe("🆕 燈皇 ❓蟲🐛 150/1200");
    book.rendered(m, NOW + 60_000);
    // 離上次改超過一分鐘：馬上改
    book.ingest(parse("support", [support({ hp: 100 })]), NOW + 130_000);
    expect(m.dirty).toBe(true);
  });

  it("只有 HP 變了不寫 storage", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    const c = book.ingest(parse("support", [support({ hp: 100 })]), NOW + 1000);
    expect(c).toEqual({ raids: [], messages: [] });
    expect(book.raid(raidFeedId(support()))?.hp).toBe(100);
  });

  it("SUPPORT 再傳一次不會把自己清單補的 ★／stage 蓋成 null", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("own", [own({ rarity: 6 })]), NOW + 1000);
    book.ingest(parse("support", [support()]), NOW + 2000);
    expect(book.raid(raidFeedId(support()))).toMatchObject({ rarity: 6, stage: 3 });
  });

  it("到期一小時後丟掉；GET 不回到期的", () => {
    const book = new RaidFeedBook();
    const r = support();
    book.ingest(parse("support", [r]), NOW);
    book.markPosted([raidFeedId(r)], "m1", false);
    expect(book.list(r.limit - 1)).toHaveLength(1);
    expect(book.list(r.limit)).toHaveLength(0);
    expect(book.prune(r.limit + RAID_FEED_KEEP_AFTER_LIMIT_MS)).toEqual({
      raids: [raidFeedId(r)],
      messages: ["m1"],
    });
    expect(book.size).toBe(0);
  });

  it("GET 有碎片、沒有渦碼", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support({ profound_code: "ABCDEFGHIJKL" })]), NOW);
    book.ingest(parse("own", [own()]), NOW);
    const [v] = book.list(NOW);
    expect(v?.fragment).toBe("soul");
    expect(JSON.stringify(v)).not.toContain("ABCDEFGHIJKL");
  });
});

/** 2026-10-03 實際查 ulrmap 的回應（只留碎片相關的列；locale=zh-TW 仍回簡體）。 */
const LOOKUP_SAMPLE = [
  {
    monsterId: 30114,
    rarity: 1,
    mapIndex: 9,
    rewards: [
      {
        rewardType: "discovery",
        itemBucket: "weapon",
        itemIndex: 5000,
        itemName: "异化矿材",
        sortOrder: 0,
      },
      {
        rewardType: "ranking",
        rankMin: 1,
        rankMax: 10,
        itemBucket: "cmem",
        itemIndex: 10009,
        itemName: "生命的碎片",
        sortOrder: 3,
      },
      {
        rewardType: "ranking",
        rankMin: 31,
        rankMax: 60,
        itemBucket: "ccoin",
        itemIndex: 10004,
        itemName: "金币",
        sortOrder: 5,
      },
    ],
  },
  {
    monsterId: 30130,
    rarity: 6,
    mapIndex: 9,
    rewards: [
      {
        rewardType: "ranking",
        rankMin: 1,
        rankMax: 10,
        itemBucket: "cmem",
        itemIndex: 10006,
        itemName: "记忆的碎片",
        sortOrder: 3,
      },
    ],
  },
];

describe("parseRewardLookup", () => {
  it("排名獎勵的 cmem → 碎片，簡體也認", () => {
    const m = parseRewardLookup(LOOKUP_SAMPLE);
    expect(m.get("30114:1:9")).toBe("life");
    expect(m.get("30130:6:9")).toBe("memory");
  });

  it("壞的回應回空表", () => {
    expect(parseRewardLookup(null).size).toBe(0);
    expect(parseRewardLookup({ error: 1 }).size).toBe(0);
    expect(parseRewardLookup([{ monsterId: 1 }]).size).toBe(0);
  });
});

describe("ulrmap 查表", () => {
  const withMap = (over: Record<string, unknown> = {}) =>
    own({ stage: null, mapIndex: 9, ...over });

  it("看到的 stage 優先於查到的", () => {
    expect(raidFeedFragment({ stage: 3, rarity: 1, name: "屠殺者", lookupFragment: "life" })).toBe(
      "soul",
    );
    expect(
      raidFeedFragment({ stage: null, rarity: 1, name: "屠殺者", lookupFragment: "life" }),
    ).toBe("life");
  });

  it("怪／★／區塊都知道才查；同一組只列一次", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support(), support({ founder: "B" })]), NOW);
    expect(book.needsLookup(NOW)).toEqual([]);
    book.ingest(parse("own", [withMap(), withMap({ founder: "B" })]), NOW);
    expect(book.needsLookup(NOW)).toEqual([{ monsterId: 30114, rarity: 1, mapIndex: 9 }]);
    expect(book.nextWake(NOW)).toBe(NOW);
  });

  it("發之前查到：發出去的那一行直接有碎片", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("own", [withMap()]), NOW);
    const asked = book.needsLookup(NOW);
    book.applyLookup(asked, parseRewardLookup(LOOKUP_SAMPLE), NOW);
    const [r] = book.dueBatch(NOW + RAID_FEED_BATCH_MS);
    expect(r && formatRaidFeedLine(r)).toBe("燈皇 紅蟲🔴🐛 325/1200");
    expect(book.list(NOW)[0]?.fragment).toBe("life");
  });

  it("發了之後才查到：那則訊息要重畫", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    // 發出時帶時刻：1 秒後的 HP 變動只排程（一分鐘限流），重畫是查到碎片觸發的
    book.markPosted([raidFeedId(support())], "m1", false, NOW);
    book.ingest(parse("own", [withMap()]), NOW + 1000);
    const asked = book.needsLookup(NOW + 1000);
    const c = book.applyLookup(asked, parseRewardLookup(LOOKUP_SAMPLE), NOW + 1000);
    expect(c.messages).toEqual(["m1"]);
    const m = book.message("m1");
    expect(m && book.renderMessage(m, null)).toBe("🆕 燈皇 紅蟲🔴🐛 325/1200");
  });

  it("表裡沒有：30 分鐘內不再查", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("own", [withMap({ mapIndex: 3 })]), NOW);
    const asked = book.needsLookup(NOW);
    expect(asked).toHaveLength(1);
    book.applyLookup(asked, new Map(), NOW);
    expect(book.needsLookup(NOW + 1000)).toEqual([]);
    expect(book.needsLookup(NOW + REWARD_LOOKUP_RETRY_MS)).toHaveLength(1);
    expect(rewardLookupKey(asked[0]!)).toBe("30114:1:3");
  });

  it("已經有碎片（看到 stage）就不查", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(parse("own", [withMap({ stage: 2 })]), NOW);
    expect(book.needsLookup(NOW)).toEqual([]);
  });
});

describe("BOSS 狀態", () => {
  const S = 1000;
  const withStates = (states: unknown[], statesAt: number, over: Record<string, unknown> = {}) =>
    own({ stage: null, states, statesAt, ...over });

  it("短字照舊 bot：順序固定、等級／層數接在後面、猛毒不帶數字", () => {
    expect(
      formatRaidFeedStates([
        { type: "curse", until: null, count: 9 },
        { type: "movD9", until: null, count: null },
        { type: "mahi", until: null, count: null },
        { type: "poison2", until: null, count: null },
        { type: "xyz3", until: null, count: null },
      ]),
    ).toBe("麻 移-9 猛 詛9");
  });

  it("給了 now 就不列過期的", () => {
    const st = [
      { type: "mahi", until: NOW + 26 * S, count: null },
      { type: "atkD5", until: NOW - 1, count: null },
    ];
    expect(formatRaidFeedStates(st, NOW)).toBe("麻");
  });

  it("沒帶 statesAt 的狀態不收；壞的一個丟那一個", () => {
    const u = parse("own", [
      own({ states: [{ type: "mahi", until: NOW + S, count: null }] }),
      own({
        founder: "B",
        states: [{ type: "mahi" }, { type: "!!" }, { type: "movD9", until: "x" }],
        statesAt: NOW,
      }),
    ]);
    expect(u.raids[0]).toMatchObject({ states: null, statesAt: null });
    expect(u.raids[1]?.states).toEqual([{ type: "mahi", until: null, count: null }]);
  });

  it("比較新的才換；換了要重畫，舊的不理", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.markPosted([raidFeedId(support())], "m1", false, NOW);
    const c = book.ingest(
      parse("own", [withStates([{ type: "mahi", until: NOW + 26 * S, count: null }], NOW)]),
      NOW,
    );
    expect(c.messages).toEqual(["m1"]);
    const m = book.message("m1")!;
    expect(book.renderMessage(m, null, NOW)).toBe("🆕 燈皇 ❓蟲🐛 325/1200｜麻");
    book.rendered(m, NOW);
    const old = book.ingest(
      parse("own", [
        withStates([{ type: "atkD5", until: NOW + 99 * S, count: null }], NOW - 5 * S),
      ]),
      NOW,
    );
    expect(old.messages).toEqual([]);
    expect(book.raid(raidFeedId(support()))?.states?.[0]?.type).toBe("mahi");
  });

  it("沒有新的狀態：到期時刻一到就重畫，把過期的拿掉", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(
      parse("own", [
        withStates(
          [
            { type: "mahi", until: NOW + 26 * S, count: null },
            { type: "movD9", until: NOW + 120 * S, count: null },
          ],
          NOW,
        ),
      ]),
      NOW,
    );
    const m = book.markPosted([raidFeedId(support())], "m1", false, NOW);
    expect(m.stateExpiry).toBe(NOW + 26 * S);
    expect(book.nextWake(NOW)).toBe(NOW + 26 * S);
    expect(book.expireStates(NOW + 25 * S).messages).toEqual([]);
    expect(book.expireStates(NOW + 26 * S).messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, NOW + 26 * S)).toBe("🆕 燈皇 ❓蟲🐛 325/1200｜移-9");
    book.rendered(m, NOW + 26 * S);
    expect(m.stateExpiry).toBe(NOW + 120 * S);
    book.rendered(m, NOW + 120 * S);
    // 狀態都過期了，下一次重畫是渦本身到期（標 ⌛）
    expect(m.stateExpiry).toBe(support().limit);
    expect(book.renderMessage(m, null, NOW + 120 * S)).toBe("🆕 燈皇 ❓蟲🐛 325/1200");
  });

  it("打倒了：重畫成 ☠️ 0/上限，狀態不再顯示也不再等它到期", () => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", [support()]), NOW);
    book.ingest(
      parse("own", [withStates([{ type: "mahi", until: NOW + 26 * S, count: null }], NOW)]),
      NOW,
    );
    const m = book.markPosted([raidFeedId(support())], "m1", false, NOW);
    book.rendered(m, NOW);
    const c = book.ingest(parse("own", [own({ hp: 0, stage: null })]), NOW + 5 * S);
    expect(c.messages).toEqual(["m1"]);
    expect(c.raids).toEqual([raidFeedId(support())]);
    expect(book.renderMessage(m, null, NOW + 5 * S)).toBe("🆕 燈皇 ❓蟲🐛☠️ 0/1200");
    book.rendered(m, NOW + 5 * S);
    expect(m.stateExpiry).toBeNull();
    // 死了再收到一次不會再重畫
    expect(book.ingest(parse("own", [own({ hp: 0, stage: null })]), NOW + 9 * S).messages).toEqual(
      [],
    );
  });
});

describe("打倒、不見了、到期", () => {
  const MIN = 60_000;
  /** NOW 時已經發現 10 分鐘、還活著的渦。 */
  const alive = (over: Record<string, unknown> = {}) =>
    support({ foundAt: NOW - 10 * MIN, limit: NOW + 5 * HOUR, ...over });
  const fullList = (raids: unknown[], present: unknown[] = []) => {
    const u = normalizeRaidFeedUpload({ source: "support", raids, complete: true, present }, NOW);
    if (u === null) throw new Error("rejected");
    return u;
  };
  const posted = (...rows: ReturnType<typeof alive>[]) => {
    const book = new RaidFeedBook();
    book.ingest(parse("support", rows), NOW - MIN);
    const m = book.markPosted(rows.map(raidFeedId), "m1", false, NOW - MIN);
    book.rendered(m, NOW - MIN);
    return { book, m };
  };

  it("新鮮的整份 SUPPORT 裡沒有 = 打倒：☠️ 0/上限、要重畫", () => {
    const a = alive();
    const b = alive({ founder: "B" });
    const { book, m } = posted(a, b);
    const c = book.ingest(fullList([b]), NOW);
    expect(c.raids).toEqual([raidFeedId(a)]);
    expect(c.messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, NOW)).toBe(
      "🆕 新增 2 個公開渦\n燈皇 ❓蟲🐛☠️ 0/1200\nB ❓蟲🐛 284/1200",
    );
  });

  it("不是整份（舊版插件）就不判斷", () => {
    const { book } = posted(alive(), alive({ founder: "B" }));
    expect(book.ingest(parse("support", [alive({ founder: "B" })]), NOW).raids).toEqual([]);
  });

  it("上傳的人自己清單上還有（SUPPORT 可能藏掉自己加入的）就不判", () => {
    const a = alive();
    const { book } = posted(a);
    expect(
      book.ingest(fullList([], [{ founder: a.founder, foundAt: a.foundAt }]), NOW).raids,
    ).toEqual([]);
  });

  it("剛發現的、已經到期的、上次看到滿人的都不判", () => {
    const fresh = alive({ founder: "新", foundAt: NOW - RAID_FEED_GONE_GRACE_MS + 1 });
    const over = alive({ founder: "期", limit: NOW });
    const full = alive({ founder: "滿", memberLength: 100, memberLimit: 100 });
    const book = new RaidFeedBook();
    book.ingest(parse("support", [fresh, over, full]), NOW - MIN);
    expect(book.ingest(fullList([]), NOW).raids).toEqual([]);
  });

  it("判錯了（之後又看到活的）改回來", () => {
    const a = alive();
    const { book, m } = posted(a);
    book.ingest(fullList([]), NOW);
    book.rendered(m, NOW);
    const c = book.ingest(parse("support", [alive({ hp: 200 })]), NOW + MIN);
    expect(c.messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, NOW + MIN)).toBe("🆕 燈皇 ❓蟲🐛 200/1200");
  });

  it("到期時刻往前跳（伺服器改成死亡＋10 分）= 打倒", () => {
    const a = alive();
    const { book, m } = posted(a);
    const c = book.ingest(
      parse("own", [own({ foundAt: a.foundAt, limit: NOW + 10 * MIN, hp: null, stage: null })]),
      NOW,
    );
    expect(c.messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, NOW)).toBe("🆕 燈皇 ❓蟲🐛☠️ 0/1200");
  });

  it("到期還沒打倒：到期那一刻重畫成 ⌛、狀態不顯示", () => {
    const a = alive({ limit: NOW + MIN });
    const { book, m } = posted(a);
    book.ingest(
      parse("own", [
        own({
          foundAt: a.foundAt,
          limit: a.limit,
          stage: null,
          states: [{ type: "mahi", until: NOW + 10 * MIN, count: null }],
          statesAt: NOW,
        }),
      ]),
      NOW,
    );
    book.rendered(m, NOW);
    expect(m.stateExpiry).toBe(a.limit);
    expect(book.expireStates(a.limit).messages).toEqual(["m1"]);
    expect(book.renderMessage(m, null, a.limit)).toBe("🆕 燈皇 ❓蟲🐛⌛ 325/1200");
  });
});

describe("渦幾（BOSS 代碼）與自己公開", () => {
  const tier = (
    mons: string | null,
    rarity: number | null = null,
    memberLimit: number | null = null,
  ) => raidFeedTierOf({ mons, rarity, memberLimit });

  it("代碼尾碼 _01/_02/_03 = 渦I／渦II·III／渦IV（照 Moon/打渦.py 的 渦階()）", () => {
    expect(tier("mc1003_01")).toBe("I");
    expect(tier("mc1006_02")).toBe("II/III");
    expect(tier("mc1006_03")).toBe("IV");
    expect(tier("mc1005")).toBe("I");
  });

  it("妖精看 ★：★5 渦IV、其他渦II·III；★ 不知道就退回人數上限", () => {
    expect(tier("mc1004_01", 5)).toBe("IV");
    expect(tier("mc1004_01", 6)).toBe("II/III");
    expect(tier("mc1004_01", null, 120)).toBe("IV");
  });

  it("沒有代碼退回人數上限", () => {
    expect(tier(null, null, 80)).toBe("I");
    expect(tier(null, null, 120)).toBe("IV");
    expect(tier(null)).toBeNull();
  });

  it("自己按送出公開（publish）能新增；渦IV 照代碼判斷", () => {
    const book = new RaidFeedBook();
    const u = normalizeRaidFeedUpload(
      { source: "publish", raids: [own({ name: "爬行者", mons: "mc1006_03", stage: null })] },
      NOW,
    );
    if (u === null) throw new Error("rejected");
    book.ingest(u, NOW);
    const [r] = book.dueBatch(NOW + RAID_FEED_BATCH_MS);
    expect(r && raidFeedTierOf(r)).toBe("IV");
  });

  it("渦I（照代碼）也發", () => {
    const book = new RaidFeedBook();
    book.ingest(
      parse("support", [support({ name: "龍魚", mons: "mc1003_01", memberLimit: null })]),
      NOW,
    );
    expect(book.dueBatch(NOW + RAID_FEED_BATCH_MS)).toHaveLength(1);
  });

  it("壞的代碼不收", () => {
    expect(parse("support", [support({ mons: "<script>" })]).raids[0]?.mons).toBeNull();
  });
});
