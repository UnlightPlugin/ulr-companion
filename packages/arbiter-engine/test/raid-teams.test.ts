/**
 * 打渦隊伍：紀錄 → 隊伍、上傳（只有雜湊）、查回來（名字對得上才收）、本機優先
 */

import { describe, expect, it } from "vitest";
import { normalizeTeamsUpload, raidPlayerKey, RaidTeamBoard } from "@ulr/arbiter-link";
import {
  aggregateTeams,
  buildTeamUploads,
  localTeamsMap,
  lookupRaidTeams,
  mergeTeamsMaps,
  parseBattleRecords,
  pruneBattles,
  type RaidBattleRecord,
  uploadRaidTeams,
  upsertBattle,
} from "@ulr/arbiter-engine";

const NOW = Date.now();
const DECK_A = {
  chara: ["cc043", "cc011", "cc033"],
  charaIndex: [426, 109, 329],
  weapon: [170, 136, 135],
  eventIndex: [80, 80, 67, 67, 67, 67, 20, 41, 70, 70, 67, 67, 67, 80, 80, 80, 67, 67],
};
const DECK_B = { ...DECK_A, weapon: [170, 136, null] };

const battle = (over: Partial<RaidBattleRecord> = {}): RaidBattleRecord => ({
  code: "tfqLuvEDegF3",
  player: "燈皇",
  limit: NOW + 3_600_000,
  turns: 1,
  ap: 1,
  damage: 20,
  points: 5490,
  deck: DECK_A,
  at: NOW,
  ...over,
});

describe("紀錄 → 隊伍", () => {
  it("同一副（27 格全同）合成一支：場次、回合、AP、傷害加總，單場最高；傷害高的在前", () => {
    const teams = aggregateTeams([
      battle({ damage: 20 }),
      battle({ damage: 50, turns: 3, ap: 3 }),
      battle({ deck: DECK_B, damage: 100 }),
    ]);
    expect(teams.map((t) => [t.damage, t.battles, t.turns, t.ap, t.best, t.points])).toEqual([
      [100, 1, 1, 1, 100, 5490],
      [70, 2, 4, 4, 50, 10980],
    ]);
    expect(teams[1]!.weapon).toEqual([170, 136, 135]);
  });

  it("同一場補報（分數晚到）取代舊的那筆，不多算一場", () => {
    const first = upsertBattle([battle({ at: 1 })], battle({ at: 2, points: 100 }));
    expect(first).toMatchObject({ updated: false });
    const again = upsertBattle(first.records, battle({ at: 2, points: 6382, damage: 29 }));
    expect(again.updated).toBe(true);
    expect(again.records.map((r) => [r.at, r.points])).toEqual([
      [1, 5490],
      [2, 6382],
    ]);
  });

  it("渦碼 → 名字 → 隊伍；本機有的名字蓋掉雲端那份", () => {
    const local = localTeamsMap([battle(), battle({ code: "other" })]);
    expect(Object.keys(local)).toEqual(["tfqLuvEDegF3", "other"]);
    const cloudTeam = { ...aggregateTeams([battle({ damage: 1 })])[0]! };
    const merged = mergeTeamsMaps({ tfqLuvEDegF3: { 燈皇: [cloudTeam], A: [cloudTeam] } }, local);
    expect(merged["tfqLuvEDegF3"]!["燈皇"]![0]!.damage).toBe(20);
    expect(merged["tfqLuvEDegF3"]!["A"]).toEqual([cloudTeam]);
  });

  it("過期的渦丟掉；檔案讀回來形狀不對的丟掉", () => {
    expect(pruneBattles([battle(), battle({ limit: NOW - 1 })], NOW)).toHaveLength(1);
    expect(parseBattleRecords({ battles: [battle(), { code: 1 }, null] })).toEqual([battle()]);
    expect(parseBattleRecords("garbage")).toEqual([]);
  });
});

describe("看板來回", () => {
  function fakeCloud() {
    const board = new RaidTeamBoard();
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (init?.method === "POST") {
        const list = normalizeTeamsUpload(JSON.parse(init.body ?? "{}"), Date.now());
        if (list === null) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ accepted: board.upsert(list, Date.now()) }) };
      }
      const keys = new URL(url).searchParams.get("keys")!.split(",");
      return { ok: true, json: async () => ({ raids: board.lookup(keys, Date.now()) }) };
    };
    return { board, calls, fetchImpl };
  }
  const URL_ = "https://x.invalid/raid-teams";

  it("傳上去只有雜湊；查的人拿渦碼＋榜上名字查得回來，榜上沒有的名字對不上", async () => {
    const cloud = fakeCloud();
    const n = await uploadRaidTeams(
      await buildTeamUploads([battle(), battle({ damage: 30 })]),
      cloud.fetchImpl,
      URL_,
    );
    expect(n).toBe(1);
    const all = cloud.calls.join("\n");
    expect(all).not.toContain("tfqLuvEDegF3");
    expect(all).not.toContain("燈皇");

    const found = await lookupRaidTeams(
      [{ code: "tfqLuvEDegF3", players: ["A", "燈皇"] }],
      cloud.fetchImpl,
      URL_,
    );
    expect(found["tfqLuvEDegF3"]!["燈皇"]![0]).toMatchObject({
      battles: 2,
      damage: 50,
      best: 30,
      points: 10980,
    });
    expect(found["tfqLuvEDegF3"]!["A"]).toBeUndefined();
    expect(cloud.calls.at(-1)).not.toContain(await raidPlayerKey("tfqLuvEDegF3", "燈皇"));

    const stranger = await lookupRaidTeams(
      [{ code: "tfqLuvEDegF3", players: ["A"] }],
      cloud.fetchImpl,
      URL_,
    );
    expect(stranger).toEqual({});
  });

  it("撤回：傳空的隊伍，看板上就查不到那個人", async () => {
    const cloud = fakeCloud();
    await uploadRaidTeams(await buildTeamUploads([battle()]), cloud.fetchImpl, URL_);
    await uploadRaidTeams(await buildTeamUploads([battle()], true), cloud.fetchImpl, URL_);
    expect(
      await lookupRaidTeams([{ code: "tfqLuvEDegF3", players: ["燈皇"] }], cloud.fetchImpl, URL_),
    ).toEqual({});
  });

  it("看板掛了都回空／0，不丟例外", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    expect(await uploadRaidTeams(await buildTeamUploads([battle()]), down, URL_)).toBe(0);
    expect(await lookupRaidTeams([{ code: "x", players: ["y"] }], down, URL_)).toEqual({});
  });
});
