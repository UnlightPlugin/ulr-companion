/**
 * 共享渦狀態：key、形狀驗證、看板
 *
 * 重點是三件事：雲端上沒有渦碼（key 是雜湊、GET 只回問到的）、壞資料進不來、
 * 過期的東西自己消失。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RAID_SHARE_KEYS,
  MAX_RAID_TEAM_ENTRIES_PER_POST,
  MAX_RAID_TEAMS_PER_PLAYER,
  MAX_RAIDS_PER_POST,
  normalizeRaidUpload,
  normalizeTeamsUpload,
  parseRaidShareKeys,
  RAID_BOARD_CAPACITY,
  RaidBoard,
  raidPlayerKey,
  raidRowShareKey,
  raidShareKey,
  RaidTeamBoard,
  raidTeamKey,
  raidTeamRef,
} from "@ulr/arbiter-link";

const NOW = 1_789_270_000_000;

const upload = (over: Record<string, unknown> = {}) => ({
  key: "0123456789abcdef",
  tl: 2091,
  rarity: 1,
  stage: 1,
  mons: "mc1008_02",
  hp: 1200,
  hpMax: 6000,
  limit: NOW + 3_600_000,
  states: [
    { type: "movD9", until: NOW + 60_000, count: null },
    { type: "curse", until: null, count: 4 },
  ],
  ...over,
});

describe("raidRowShareKey（改版後：發現者＋到期時刻）", () => {
  it("跟給 ulgg 的 Python 範例（tools/ulgg/ulr_raid_share.py 的 self_test）算出一樣的鍵", async () => {
    // ⚠ 改了演算法，Python 那份的向量要一起改
    expect(await raidRowShareKey("燈皇", 1790337757565, "stage")).toBe("aacda4c63eeae29c");
    expect(await raidRowShareKey("燈皇", 1790337757565, "states")).toBe("5a2594021b7b3977");
    expect(await raidRowShareKey("Owlic", 1790328501134, "stage")).toBe("ec4972be39ec3b89");
  });
});

describe("raidShareKey", () => {
  it("SHA-256 前 16 個十六進位字元；同一個渦碼永遠同一把、前後空白不算", async () => {
    const k = await raidShareKey("H59pGlAk1F2y");
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(await raidShareKey(" H59pGlAk1F2y ")).toBe(k);
    expect(await raidShareKey("H59pGlAk1F2z")).not.toBe(k);
    // key 裡不含渦碼本身
    expect(k.includes("H59p")).toBe(false);
  });
});

describe("normalizeRaidUpload", () => {
  it("合格的原樣收下", () => {
    expect(normalizeRaidUpload({ raids: [upload()] }, NOW)).toEqual([upload()]);
  });

  it("整份不合格回 null：不是物件、raids 不是陣列、一次太多", () => {
    expect(normalizeRaidUpload(null, NOW)).toBeNull();
    expect(normalizeRaidUpload({ raids: "x" }, NOW)).toBeNull();
    expect(
      normalizeRaidUpload(
        { raids: Array.from({ length: MAX_RAIDS_PER_POST + 1 }, () => upload()) },
        NOW,
      ),
    ).toBeNull();
  });

  it("個別壞的一筆丟掉：key 不像雜湊、已經到期、到期時刻遠得離譜", () => {
    const out = normalizeRaidUpload(
      {
        raids: [
          upload({ key: "H59pGlAk1F2y" }), // 渦碼本身不收 —— 雲端不該看到渦碼
          upload({ limit: NOW - 1 }),
          upload({ limit: NOW + 7 * 86_400_000 }),
          upload({ key: "fedcba9876543210" }),
        ],
      },
      NOW,
    );
    expect(out?.map((r) => r.key)).toEqual(["fedcba9876543210"]);
  });

  it("欄位清洗：mons 形狀、數字範圍、狀態代碼", () => {
    const [r] = normalizeRaidUpload(
      {
        raids: [
          upload({
            mons: "<script>",
            tl: -5,
            hp: 1.5,
            states: [
              { type: "atkD9", until: NOW + 1000, count: null },
              { type: "a;b", until: null, count: null },
              { type: "mahi", until: NOW + 99 * 86_400_000, count: null },
              { type: "curse", until: null, count: 9999 },
            ],
            extra: "ignored",
          }),
        ],
      },
      NOW,
    )!;
    expect(r).toMatchObject({ mons: null, tl: null, hp: null });
    expect(r!.states).toEqual([
      { type: "atkD9", until: NOW + 1000, count: null },
      { type: "curse", until: null, count: null },
    ]);
    expect("extra" in r!).toBe(false);
  });
});

describe("parseRaidShareKeys", () => {
  const u = (q: string) => new URL(`https://x.invalid/raids${q}`);
  it("逗號分隔、去重", () => {
    expect(
      parseRaidShareKeys(u("?keys=0123456789abcdef,0123456789abcdef,fedcba9876543210")),
    ).toEqual(["0123456789abcdef", "fedcba9876543210"]);
  });
  it("沒帶、有壞的一把、太多 → null（沒有「列出全部」這條路）", () => {
    expect(parseRaidShareKeys(u(""))).toBeNull();
    expect(parseRaidShareKeys(u("?keys="))).toBeNull();
    expect(parseRaidShareKeys(u("?keys=0123456789abcdef,nope"))).toBeNull();
    const many = Array.from({ length: MAX_RAID_SHARE_KEYS + 1 }, (_, i) =>
      i.toString(16).padStart(16, "0"),
    );
    expect(parseRaidShareKeys(u(`?keys=${many.join(",")}`))).toBeNull();
  });
});

describe("RaidBoard", () => {
  it("只回問到的；seenAt 蓋雲端時間；後到的蓋掉先到的", () => {
    const b = new RaidBoard();
    b.upsert([upload(), upload({ key: "fedcba9876543210", tl: 2100 })], NOW);
    expect(b.lookup(["fedcba9876543210"], NOW + 1).map((r) => r.tl)).toEqual([2100]);
    b.upsert([upload({ key: "fedcba9876543210", tl: 2101 })], NOW + 5);
    const [r] = b.lookup(["fedcba9876543210", "aaaaaaaaaaaaaaaa"], NOW + 6);
    expect(r).toMatchObject({ tl: 2101, seenAt: NOW + 5 });
  });

  it("過期的渦查不到、過期的狀態不回", () => {
    const b = new RaidBoard();
    b.upsert([upload()], NOW);
    const [r] = b.lookup(["0123456789abcdef"], NOW + 61_000);
    expect(r!.states.map((s) => s.type)).toEqual(["curse"]);
    expect(b.lookup(["0123456789abcdef"], NOW + 3_600_001)).toEqual([]);
    expect(b.size).toBe(0);
  });

  it("滿了先丟最久沒更新的", () => {
    const b = new RaidBoard();
    const key = (i: number) => i.toString(16).padStart(16, "0");
    for (let i = 0; i < RAID_BOARD_CAPACITY; i++) b.upsert([upload({ key: key(i) })], NOW);
    b.upsert([upload({ key: key(0) })], NOW + 1); // 0 號剛更新，排到最後
    b.upsert([upload({ key: "ffffffffffffffff" })], NOW + 2);
    expect(b.size).toBe(RAID_BOARD_CAPACITY);
    expect(b.lookup([key(0)], NOW + 3).length).toBe(1);
    expect(b.lookup([key(1)], NOW + 3).length).toBe(0);
  });
});

describe("打渦隊伍", () => {
  const team = (over: Record<string, unknown> = {}) => ({
    chara: ["cc043", "cc011", null],
    charaIndex: [426, 109, null],
    weapon: [170, null, null],
    eventIndex: [
      80,
      80,
      67,
      67,
      67,
      67,
      20,
      41,
      70,
      70,
      67,
      67,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
    battles: 3,
    turns: 3,
    ap: 3,
    damage: 120,
    best: 60,
    points: 11872,
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    key: "0123456789abcdef",
    player: "aaaaaaaaaaaaaaaa",
    limit: NOW + 3_600_000,
    teams: [team()],
    ...over,
  });

  it("玩家 key：渦（發現者＋發現時刻）＋名字一起雜湊；換渦就不一樣，也不會跟渦的 key 撞", async () => {
    const ref = raidTeamRef("路德", 1790321644930);
    expect(ref).toBe("路德@1790321644930");
    const k = await raidPlayerKey(ref, "燈皇");
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(await raidPlayerKey(raidTeamRef("路德", 1790321644931), "燈皇")).not.toBe(k);
    expect(await raidPlayerKey(raidTeamRef("路德2", 1790321644930), "燈皇")).not.toBe(k);
    expect(await raidPlayerKey(ref, "燈皇2")).not.toBe(k);
    const raid = await raidTeamKey(ref);
    expect(raid).toMatch(/^[0-9a-f]{16}$/);
    expect(raid).not.toBe(k);
    // 跟 /raids 那兩把（發現者＋到期時刻）不會撞
    expect(raid).not.toBe(await raidShareKey(ref));
    expect(raid).not.toBe(await raidRowShareKey("路德", 1790321644930, "stage"));
  });

  it("形狀驗證：整份壞回 null；壞的一筆、壞的一支各自丟掉", () => {
    expect(normalizeTeamsUpload(null, NOW)).toBeNull();
    expect(
      normalizeTeamsUpload(
        { entries: Array.from({ length: MAX_RAID_TEAM_ENTRIES_PER_POST + 1 }, () => entry()) },
        NOW,
      ),
    ).toBeNull();
    const out = normalizeTeamsUpload(
      {
        entries: [
          entry({ player: "燈皇" }), // 名字本身不收
          entry({ limit: NOW - 1 }),
          entry({
            teams: [
              team(),
              team({ chara: ["<img>", null, null] }),
              team({ eventIndex: [1, 2] }),
              team({ chara: [null, null, null] }),
              team({ best: 999 }), // 單場最高比總傷害還高
              team({ battles: 0 }),
              team({ points: -1 }),
            ],
          }),
        ],
      },
      NOW,
    )!;
    expect(out).toHaveLength(1);
    expect(out[0]!.teams).toEqual([team()]);
    const many = normalizeTeamsUpload(
      { entries: [entry({ teams: Array.from({ length: 30 }, () => team()) })] },
      NOW,
    )!;
    expect(many[0]!.teams).toHaveLength(MAX_RAID_TEAMS_PER_PLAYER);
  });

  it("改版後的新 id 過得了驗證（Worker 不必重新部署）：CharaCards 的 chara／id、武器 5005、怪物卡", () => {
    const fresh = team({
      chara: ["cc035", "cc033", "mc1003_02"],
      charaIndex: [350, 330, 30108],
      weapon: [21, 5005, null],
      eventIndex: [31, 31, 31, 34, 34, 28, 28, 34, 34, 34, 28, 28, 71, 80, 31, 31, 28, 28],
    });
    const out = normalizeTeamsUpload({ entries: [entry({ teams: [fresh] })] }, NOW)!;
    expect(out[0]!.teams).toEqual([fresh]);
  });

  it("看板：同一個人整份取代、傳空的就拿掉；只回問到的渦；渦過期整批消失", () => {
    const b = new RaidTeamBoard();
    b.upsert([entry(), entry({ player: "bbbbbbbbbbbbbbbb" })], NOW);
    expect(b.lookup(["0123456789abcdef"], NOW)[0]!.players).toHaveLength(2);
    b.upsert([entry({ teams: [team({ damage: 500, best: 500 })] })], NOW + 5);
    const [raid] = b.lookup(["0123456789abcdef", "fedcba9876543210"], NOW + 6);
    expect(raid!.players.find((p) => p.player === "aaaaaaaaaaaaaaaa")).toMatchObject({
      seenAt: NOW + 5,
      teams: [{ damage: 500 }],
    });
    b.upsert([entry({ teams: [] })], NOW + 7);
    expect(b.lookup(["0123456789abcdef"], NOW + 8)[0]!.players.map((p) => p.player)).toEqual([
      "bbbbbbbbbbbbbbbb",
    ]);
    expect(b.size).toBe(1);
    expect(b.lookup(["0123456789abcdef"], NOW + 3_600_001)).toEqual([]);
    expect(b.size).toBe(0);
  });
});

describe("隊伍看板：寫 storage 用的變更與讀回", () => {
  const team = (damage: number) => ({
    chara: ["cc043", null, null],
    charaIndex: [426, null, null],
    weapon: [170, null, null],
    eventIndex: Array(18).fill(null),
    battles: 1,
    turns: 1,
    ap: 1,
    damage,
    best: damage,
    points: 100,
  });
  const e = (over: Record<string, unknown> = {}) => ({
    key: "0123456789abcdef",
    player: "aaaaaaaaaaaaaaaa",
    limit: NOW + 3_600_000,
    teams: [team(5)],
    ...over,
  });

  it("只回內容真的變了的：同一份重傳不算、隊伍變了算、撤掉算、撤掉不存在的不算", () => {
    const b = new RaidTeamBoard();
    expect(b.upsertChanges([e()], NOW)).toHaveLength(1);
    expect(b.upsertChanges([e()], NOW + 30_000)).toEqual([]);
    expect(b.upsertChanges([e({ teams: [team(9)] })], NOW + 60_000)).toHaveLength(1);
    expect(b.upsertChanges([e({ limit: NOW + 7_200_000, teams: [team(9)] })], NOW)).toHaveLength(1);
    expect(b.upsertChanges([e({ teams: [] })], NOW)).toHaveLength(1);
    expect(b.upsertChanges([e({ teams: [] })], NOW)).toEqual([]);
  });

  it("讀回來：記憶體裡已經有的人不蓋、到期的不收", () => {
    const b = new RaidTeamBoard();
    b.upsert([e({ teams: [team(99)] })], NOW);
    b.hydrate(
      [
        { ...e({ teams: [team(1)] }), seenAt: NOW - 1000 },
        { ...e({ player: "bbbbbbbbbbbbbbbb" }), seenAt: NOW - 1000 },
        { ...e({ player: "cccccccccccccccc", limit: NOW - 1 }), seenAt: NOW - 1000 },
      ],
      NOW,
    );
    const [raid] = b.lookup(["0123456789abcdef"], NOW);
    expect(raid!.players.map((p) => [p.player, p.teams[0]!.damage])).toEqual([
      ["aaaaaaaaaaaaaaaa", 99],
      ["bbbbbbbbbbbbbbbb", 5],
    ]);
  });
});
