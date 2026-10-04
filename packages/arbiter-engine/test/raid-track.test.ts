import { describe, expect, it } from "vitest";
import {
  addBattle,
  applySnapshot,
  clockOf,
  emptyLedger,
  formatLedger,
  formatOutcomeDetail,
  formatRaidTally,
  formatRaidTrack,
  formatVanished,
  ledgerExpect,
  ledgerLevels,
  parseOutcomeState,
  pruneOutcomes,
  RAID_VANISH_GRACE_MS,
  raidOutcome,
  settleOutcomes,
  tallyToday,
  upsertOutcome,
} from "@ulr/arbiter-engine";
import type { RaidRewardEntry, RaidSnapshotRow, RaidTrackReport } from "@ulr/cdp-adapter";

const TW = 8 * 60; // 台灣 UTC+8
const at = (hhmmss: string) => Date.parse(`2026-09-25T${hhmmss}+08:00`);
const FOUND = at("14:29:13");

const R = (over: Partial<RaidTrackReport> = {}): RaidTrackReport => ({
  type: "raid-track",
  name: "魔性的鱗粉",
  level: 1,
  rarity: 6,
  stage: 5,
  category: "normal",
  mapIndex: 9,
  mine: true,
  found: FOUND,
  limitAlive: at("14:49:13"),
  deathByLimit: at("14:38:30"),
  deadSeen: at("14:41:28"),
  point: 3800,
  refreshAfterDeath: 1,
  settled: null,
  gone: at("14:50:01"),
  ...over,
});

const ENTRY = (over: Partial<RaidRewardEntry> = {}): RaidRewardEntry => ({
  prf: "龍鯰",
  boss: "龍鯰",
  founder: "蒼兔",
  defeat: "",
  rank: 4,
  dmg: 1991,
  rewards: { founder: [], participate: ["古代妙藥 x2"], defeat: [], rank: ["死亡的碎片 x2"] },
  found: FOUND,
  received: true,
  items: [
    { key: "avatar_item:2", name: "古代妙藥", value: 2 },
    { key: "chara_card:10010", name: "死亡的碎片", value: 2 },
  ],
  ...over,
});

const ROW = (over: Partial<RaidSnapshotRow> = {}): RaidSnapshotRow => ({
  code: null,
  founder: "蒼兔",
  tl: null,
  rarity: 1,
  stage: null,
  mons: null,
  hp: 500,
  hpMax: 1200,
  limit: at("20:29:13"),
  states: [],
  statesAt: null,
  foundAt: FOUND,
  players: [],
  meta: {
    name: "龍鯰",
    monsterId: 30130,
    level: 1,
    mapIndex: 5,
    category: "another",
    point: 1991,
    stage: 1,
    expectFrag: "死亡的碎片",
    expectCoin: false,
    expectSrc: "map",
    expectItems: [],
  },
  ...over,
});

const battle = (
  over: Partial<{ raid: string; at: number; player: string; points: number }> = {},
) => ({
  raid: `蒼兔@${FOUND}`,
  at: at("14:35:00"),
  player: "燈皇",
  points: 1991,
  limit: at("20:29:13"),
  ...over,
});

describe("渦結束紀錄的一行", () => {
  it("時間用本機時區", () => {
    expect(clockOf(at("14:29:13"), TW)).toBe("14:29:13");
  });

  it("死後重拿過清單還是沒結算：記成沒收到（妖精那種）", () => {
    expect(formatRaidTrack(R(), TW)).toBe(
      "· 渦結束：魔性的鱗粉 Lv1 ★6 stage 5 normal 區塊9 自己開的｜發現 14:29:13｜" +
        "死亡≈14:38:30（到期−10分）／看到 14:41:28｜分數 3,800｜結算 沒收到（死後重拿清單 1 次）｜消失 14:50:01",
    );
  });

  it("死後沒重拿過清單：消失那次才要結算，一樣記沒收到", () => {
    expect(formatRaidTrack(R({ refreshAfterDeath: 0 }), TW)).toContain(
      "結算 沒收到（死後沒重拿過清單，消失那次才要）",
    );
  });

  it("0 分又不是發現者：標本來就沒份", () => {
    expect(formatRaidTrack(R({ mine: false, point: 0 }), TW)).toContain(
      "（0 分又不是發現者，本來就沒份）",
    );
  });

  it("有結算；消失後才到的也標出來", () => {
    expect(formatRaidTrack(R({ settled: at("14:45:00") }), TW)).toContain("結算 14:45:00｜");
    expect(formatRaidTrack(R({ settled: at("14:55:00") }), TW)).toContain(
      "結算 14:55:00（消失後才到）",
    );
  });
});

describe("每個渦拿到結算了沒", () => {
  it("分類：有結算／有分沒結算／0 分非發現者；發現者 0 分照樣有份", () => {
    expect(raidOutcome(R({ settled: at("14:45:00") }))).toBe("got");
    expect(raidOutcome(R({ mine: false }))).toBe("lost");
    expect(raidOutcome(R({ mine: false, point: 0 }))).toBe("none");
    expect(raidOutcome(R({ mine: false, point: 0, settled: at("14:45:00") }))).toBe("none");
    expect(raidOutcome(R({ mine: true, point: 0 }))).toBe("lost");
  });

  it("離線也追得到：打一場記等結算 → 下次進渦房清單上沒有、等一下結算也沒來 → 沒拿到", () => {
    let recs = addBattle([], [battle()], battle(), at("14:35:00"));
    expect(recs[0]).toMatchObject({
      key: String(FOUND),
      outcome: "pending",
      source: "battle",
      founder: "蒼兔",
      mine: false,
      point: 1991,
      battles: 1,
    });
    // 還在清單上：補名字、stage、預期獎勵
    const gone = new Map<string, number>();
    recs = applySnapshot(recs, [ROW()], true, gone, at("14:40:00")).records;
    expect(recs[0]).toMatchObject({
      name: "龍鯰",
      stage: 1,
      mapIndex: 5,
      expectFrag: "死亡的碎片",
    });
    // 第二天才上線、進渦房：清單上已經沒有它
    const next = Date.parse("2026-09-26T10:00:00+08:00");
    let r = applySnapshot(recs, [], true, gone, next);
    expect(r.decided).toHaveLength(0);
    r = applySnapshot(r.records, [], true, gone, next + RAID_VANISH_GRACE_MS);
    expect(r.decided).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      outcome: "lost",
      gone: next,
      at: next + RAID_VANISH_GRACE_MS,
    });
    expect(formatVanished(r.records[0]!)).toBe(
      "· 渦消失沒結算：龍鯰 Lv1★1 stage 1（區塊5） 預期 死亡的碎片｜別人開的｜分數 1,991｜自己打 1 場｜有分卻沒等到結算",
    );
    // 之後結算才到（伺服器補發）：翻成拿到
    const s = settleOutcomes(r.records, [ENTRY()], next + 120_000);
    expect(s.records[0]).toMatchObject({ outcome: "got", rank: 4, received: true });
    expect(s.records[0]!.rewards).toEqual(["古代妙藥 x2", "死亡的碎片 x2"]);
  });

  it("頁面還沒拿到清單（listed false）不判定；等的時候結算到了就不判定", () => {
    const recs = addBattle([], [battle()], battle(), at("14:35:00"));
    const gone = new Map<string, number>();
    let r = applySnapshot(recs, [], false, gone, at("15:00:00"));
    r = applySnapshot(r.records, [], false, gone, at("15:10:00"));
    expect(r.records[0]!.outcome).toBe("pending");
    r = applySnapshot(r.records, [], true, gone, at("15:11:00"));
    const s = settleOutcomes(r.records, [ENTRY()], at("15:11:05"));
    r = applySnapshot(s.records, [], true, gone, at("15:13:00"));
    expect(r.decided).toHaveLength(0);
    expect(r.records[0]!.outcome).toBe("got");
  });

  it("官方回報「領了」失敗：不算拿到（伺服器下次會再列）", () => {
    const recs = addBattle([], [battle()], battle(), at("14:35:00"));
    const s = settleOutcomes(recs, [ENTRY({ received: false })], at("15:00:00"));
    expect(s.records[0]).toMatchObject({ outcome: "pending", received: false });
  });

  it("沒記過的渦的結算也記一筆；沒有發現時刻的退回名字＋發現者＋分數對", () => {
    const s = settleOutcomes([], [ENTRY()], at("15:00:00"));
    expect(s.records[0]).toMatchObject({
      key: String(FOUND),
      source: "settlement",
      outcome: "got",
    });
    const recs = addBattle([], [battle()], battle(), at("14:35:00")).map((x) => ({
      ...x,
      name: "龍鯰",
    }));
    expect(settleOutcomes(recs, [ENTRY({ found: null, founder: "別人" })], 0).changed).toBe(0);
    expect(settleOutcomes(recs, [ENTRY({ found: null })], 0).records[0]!.outcome).toBe("got");
  });

  it("渦結束紀錄：同一個渦補報不多算；結算先到的不翻回去；打渦場次對得上", () => {
    let recs = upsertOutcome([], R({ mine: false }), at("14:50:01"), [
      { raid: `???@${FOUND}`, at: at("14:30:00") },
      { raid: `蒼兔@${FOUND}`, at: at("14:35:00") },
      { raid: `蒼兔@${FOUND + 1}`, at: at("14:36:00") },
    ]);
    expect(recs[0]).toMatchObject({ outcome: "lost", battles: 2, lastBattleAt: at("14:35:00") });
    recs = upsertOutcome(recs, R({ mine: false, settled: at("14:55:00") }), at("14:55:00"));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ outcome: "got", at: at("14:50:01"), battles: 2 });
    const settled = settleOutcomes(
      upsertOutcome([], R({ mine: false }), at("14:50:01")),
      [ENTRY({ prf: "魔性的鱗粉", dmg: 3800 })],
      at("15:00:00"),
    ).records;
    expect(upsertOutcome(settled, R({ mine: false }), at("15:01:00"))[0]).toMatchObject({
      outcome: "got",
      settled: at("15:00:00"),
    });
  });

  it("細節一行：預期獎勵、榜、死後要結算幾次、最後一場離死亡多久", () => {
    const [rec] = upsertOutcome(
      [],
      R({
        rankCount: 12,
        myRank: 4,
        asksAfterDeath: 3,
        emptyAsksAfterDeath: 3,
        expectFrag: "死亡的碎片",
        expectCoin: true,
        expectSrc: "ulgg",
        expectItems: ["異化礦材"],
      }),
      at("14:50:01"),
      [{ raid: `蒼兔@${FOUND}`, at: at("14:35:00") }],
    );
    expect(formatOutcomeDetail(rec!)).toBe(
      "｜預期 白金幣＋異化礦材（ulgg）｜榜 12 人・自己第 4 名｜死後要結算 3 次（整包空 3 次）｜自己打 1 場、最後一場在死亡前 4 分",
    );
  });

  it("今天照本機時區切；等結算的另外數；一個月前的丟掉；存檔讀回來一樣", () => {
    const yesterday = upsertOutcome([], R({ found: 1 }), Date.parse("2026-09-24T23:59:00+08:00"));
    const today = upsertOutcome([], R({ found: 2, mine: false }), at("00:01:00"));
    const pending = addBattle([], [], battle({ raid: "x@3" }), at("00:02:00"));
    const recs = [...yesterday, ...today, ...pending];
    const t = tallyToday(recs, at("23:00:00"), TW);
    expect(t).toMatchObject({ got: 0, lost: 1, none: 0, pending: 1 });
    expect(formatRaidTally(t)).toBe(
      "· 今天結束的渦：拿到獎勵 0｜有分卻沒拿到 1｜本來就沒份 0｜等結算 1（沒拿到：魔性的鱗粉 Lv1★6 stage 5（區塊9） 3,800 分）",
    );
    expect(pruneOutcomes(recs, at("00:00:00") + 30 * 24 * 3600 * 1000)).toHaveLength(2);
    const ledger = emptyLedger();
    const state = parseOutcomeState(JSON.parse(JSON.stringify({ outcomes: recs, ledger })));
    expect(state.outcomes).toEqual(recs);
    // 舊版的鍵（名字@發現時刻）換成發現時刻；少的欄位當不知道
    const old = parseOutcomeState({
      outcomes: [{ key: "龍鯰@5", name: "龍鯰", found: 5, point: 1, outcome: "lost", at: 1 }],
    });
    expect(old.outcomes[0]).toMatchObject({
      key: "5",
      stage: null,
      expectItems: [],
      source: "track",
    });
  });
});

describe("道具對帳（碎片、渦幣、抽獎券、異化礦材只會變多）", () => {
  const LV = (q: number) => ({ "chara_card:10010": q });

  it("第一次看到只當起點；之後進的跟結算列的比", () => {
    let l = ledgerLevels(emptyLedger(), "chara_card", LV(320), {}, 1).ledger;
    l = ledgerExpect(l, [ENTRY()]);
    // 古代妙藥不在對帳名單（AP 水會用掉）
    expect(l.expect).toEqual({ "chara_card:10010": 2 });
    const r = ledgerLevels(l, "chara_card", LV(322), {}, 2);
    expect(r.lines).toEqual([{ key: "chara_card:10010", name: "死亡的碎片", got: 2, listed: 2 }]);
    expect(formatLedger("chara_card", r.lines)).toEqual([
      "· 道具對帳（chara_card）：死亡的碎片 +2，跟結算列的一樣",
    ]);
    expect(r.ledger.expect).toEqual({});
  });

  it("結算列了卻沒入帳／多出來的（離線期間別台領的）都標出來；回報失敗的不算列了", () => {
    let l = ledgerLevels(emptyLedger(), "chara_card", LV(320), {}, 1).ledger;
    l = ledgerExpect(l, [ENTRY(), ENTRY({ received: false })]);
    let r = ledgerLevels(l, "chara_card", LV(320), {}, 2);
    expect(formatLedger("chara_card", r.lines)[0]).toContain("結算列了 2、只進了 0");
    r = ledgerLevels(r.ledger, "chara_card", LV(325), { "chara_card:10010": "死亡的碎片" }, 3);
    expect(formatLedger("chara_card", r.lines)[0]).toContain("進了 5、插件看到的結算只列 0");
    // 沒變、也沒列：不寫
    expect(ledgerLevels(r.ledger, "chara_card", LV(325), {}, 4).lines).toEqual([]);
  });
});
