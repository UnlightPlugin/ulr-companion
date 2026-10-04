/**
 * ulgg 的 observed_raids → 頁面端要的公開渦表
 *
 * 樣本照 2026-09-13 實際回應的形狀縮的。這是第三方格式，所以重點是
 * **壞掉時不會炸**：缺欄位、非 2xx、逾時、格式不對，全都回空表。
 */

import { describe, expect, it } from "vitest";
import {
  fetchObservedRaids,
  mergePublicMaps,
  parseObservedRaids,
  pickUlggReports,
  reportStageToUlgg,
  syncSharedRaids,
} from "@ulr/arbiter-engine";
import { normalizeRaidUpload, RaidBoard } from "@ulr/arbiter-link";
import type { RaidSnapshotRow } from "@ulr/cdp-adapter";

const SAMPLE = {
  ok: true,
  raids: [
    {
      raid_id: "tfqLuvEDegF3",
      status: "active",
      monster_code: "mc1008_02",
      treasure_level: 2091,
      last_seen_at: 1789268019.2515595,
      reward: { treasureLevel: 2091, rarity: 1, mapLevel: 1 },
      state_raw: [
        { type: "bers", base_type: "bers", level: null, value: null, expires_at: 1789269975466 },
        { type: "movD9", base_type: "movD", level: 9, value: null, expires_at: 1789269975475 },
        { type: "curse", base_type: "curse", level: null, value: 9, expires_at: null },
      ],
    },
    {
      raid_id: "ended1",
      status: "ended",
      monster_code: "mc1003_02",
      treasure_level: 2076,
      reward: {},
    },
    { raid_id: "", status: "active" },
    { status: "active", treasure_level: 1 },
    null,
    { raid_id: "bare", status: "active" },
  ],
};

describe("parseObservedRaids", () => {
  it("只收 active、有渦碼的；欄位照 reward 裡的 rarity/mapLevel", () => {
    const map = parseObservedRaids(SAMPLE);
    expect(Object.keys(map).sort()).toEqual(["bare", "tfqLuvEDegF3"]);
    expect(map["tfqLuvEDegF3"]).toEqual({
      tl: 2091,
      rarity: 1,
      stage: 1,
      mons: "mc1008_02",
      states: [
        { type: "bers", until: 1789269975466, count: null },
        { type: "movD9", until: 1789269975475, count: null },
        { type: "curse", until: null, count: 9 },
      ],
      seenAt: 1789268019252,
      statesAt: 1789268019252,
      limit: null,
      founder: null,
    });
    // 空的 state_raw 不算「看過狀態」（改版後 ulgg 看不到狀態，永遠是空的）
    expect(map["bare"]).toEqual({
      tl: null,
      rarity: null,
      stage: null,
      mons: null,
      states: [],
      seenAt: null,
      statesAt: null,
      limit: null,
      founder: null,
    });
  });

  it("2026-09-23 改版後的形狀：stage_id／rarity 在最上層，帶到期時刻與發現者", () => {
    const map = parseObservedRaids({
      ok: true,
      connected: true,
      raids: [
        {
          raid_id: "X1",
          status: "active",
          founder: "Owlic",
          boss: "龍鯰",
          monster_code: null,
          stage_id: 1,
          rarity: 1,
          fragment: "🟡",
          fragment_source: "stage_sync_deferred",
          treasure_level: null,
          reward: null,
          expires_at: 1790328501134,
          last_seen_at: 1790308349.5628152,
          state_raw: [],
        },
      ],
    });
    expect(map["X1"]).toMatchObject({
      tl: null,
      rarity: 1,
      stage: 1,
      limit: 1790328501134,
      founder: "Owlic",
    });
  });

  it("格式不對就是空表", () => {
    expect(parseObservedRaids(null)).toEqual({});
    expect(parseObservedRaids("nope")).toEqual({});
    expect(parseObservedRaids({ ok: true })).toEqual({});
    expect(parseObservedRaids({ raids: "x" })).toEqual({});
  });
});

describe("fetchObservedRaids", () => {
  it("2xx 就整理；非 2xx、丟例外、逾時都回空表", async () => {
    const good = async () => ({ ok: true, json: async () => SAMPLE });
    expect(Object.keys(await fetchObservedRaids(good))).toEqual(["tfqLuvEDegF3", "bare"]);

    const bad = async () => ({ ok: false, json: async () => SAMPLE });
    expect(await fetchObservedRaids(bad)).toEqual({});

    const boom = async () => {
      throw new Error("offline");
    };
    expect(await fetchObservedRaids(boom)).toEqual({});

    const slow = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<{ ok: boolean; json: () => Promise<unknown> }>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await fetchObservedRaids(slow, 10)).toEqual({});
  });
});

describe("插件互傳（ulgg 的備援）", () => {
  const NOW = Date.now();

  /** 一塊記憶體看板，當成雲端那台 Worker。 */
  function fakeCloud() {
    const board = new RaidBoard();
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (init?.method === "POST") {
        const list = normalizeRaidUpload(JSON.parse(init.body ?? "{}"), Date.now());
        if (list === null) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ accepted: board.upsert(list, Date.now()) }) };
      }
      const keys = new URL(url).searchParams.get("keys")!.split(",");
      return { ok: true, json: async () => ({ raids: board.lookup(keys, Date.now()) }) };
    };
    return { board, calls, fetchImpl };
  }

  const LIMIT = NOW + 3_600_000;
  const BOARD_URL = "https://x.invalid/raids";
  /** 清單上的一個渦。改版後別人開的渦 code 是 null。 */
  const ROW = (over: Partial<RaidSnapshotRow> = {}): RaidSnapshotRow => ({
    code: null,
    founder: "燈皇",
    tl: null,
    rarity: 1,
    stage: null,
    mons: null,
    hp: 5725,
    hpMax: 6000,
    limit: LIMIT,
    states: [],
    statesAt: null,
    foundAt: LIMIT - 21_600_000,
    players: ["燈皇", "喜坂雛"],
    ...over,
  });

  it("發現者傳 stage 與開打時看到的狀態；清單上沒有渦碼的人用發現者＋到期時刻查得回來", async () => {
    const cloud = fakeCloud();
    const a = await syncSharedRaids(
      [
        ROW({
          code: "6y1j1JloNJjm",
          stage: 3,
          states: [{ type: "scare", until: NOW + 60_000, count: null }],
          statesAt: NOW - 5_000,
        }),
      ],
      cloud.fetchImpl,
      BOARD_URL,
    );
    expect(a.uploaded).toBe(2);
    const sent = cloud.calls.join("\n");
    // 看板上沒有渦碼、沒有名字
    expect(sent).not.toContain("6y1j1JloNJjm");
    expect(sent).not.toContain("燈皇");
    expect(sent).not.toContain("喜坂雛");

    const b = await syncSharedRaids([ROW(), ROW({ founder: "別人" })], cloud.fetchImpl, BOARD_URL);
    expect(b.uploaded).toBe(0);
    expect(Object.keys(b.map)).toEqual([`@燈皇@${LIMIT}`]);
    expect(b.map[`@燈皇@${LIMIT}`]).toMatchObject({
      rarity: 1,
      stage: 3,
      states: [{ type: "scare", until: NOW + 60_000, count: null }],
      limit: LIMIT,
      founder: "燈皇",
    });
    expect(b.map[`@燈皇@${LIMIT}`]!.statesAt).toBeGreaterThanOrEqual(NOW - 5_000);
  });

  it("狀態只在自己看到的比看板上的新時才傳：托盤重開不會把別人新的蓋回舊的", async () => {
    const cloud = fakeCloud();
    const old = ROW({
      states: [{ type: "scare", until: NOW + 60_000, count: null }],
      statesAt: NOW - 10_000,
    });
    expect((await syncSharedRaids([old], cloud.fetchImpl, BOARD_URL)).uploaded).toBe(1);
    // 同一份再傳一輪：看板上的比較新，不傳
    expect((await syncSharedRaids([old], cloud.fetchImpl, BOARD_URL)).uploaded).toBe(0);
    // 別人後來開打，看到的是新的
    const fresh = ROW({
      states: [{ type: "huin", until: NOW + 120_000, count: null }],
      statesAt: Date.now() + 1,
    });
    expect((await syncSharedRaids([fresh], cloud.fetchImpl, BOARD_URL)).uploaded).toBe(1);
    // 帶著舊的那個托盤重開（又是一輪）：不蓋
    const again = await syncSharedRaids([old], cloud.fetchImpl, BOARD_URL);
    expect(again.uploaded).toBe(0);
    expect(again.map[`@燈皇@${LIMIT}`]!.states).toEqual([
      { type: "huin", until: NOW + 120_000, count: null },
    ]);
  });

  it("stage 看板上已經有就不再傳；沒有發現者的列不查不傳", async () => {
    const cloud = fakeCloud();
    expect((await syncSharedRaids([ROW({ stage: 2 })], cloud.fetchImpl, BOARD_URL)).uploaded).toBe(
      1,
    );
    expect((await syncSharedRaids([ROW({ stage: 2 })], cloud.fetchImpl, BOARD_URL)).uploaded).toBe(
      0,
    );
    const before = cloud.calls.length;
    const none = await syncSharedRaids(
      [ROW({ founder: null, stage: 2 })],
      cloud.fetchImpl,
      BOARD_URL,
    );
    expect(none).toEqual({ map: {}, uploaded: 0 });
    expect(cloud.calls.length).toBe(before);
  });

  it("看板掛了：查不到、傳不上，都不丟例外", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    expect(
      await syncSharedRaids([ROW({ stage: 1, statesAt: NOW })], down as never, BOARD_URL),
    ).toEqual({ map: {}, uploaded: 0 });
  });

  it("合併：互傳查回來的別人的渦（沒有渦碼）用到期時刻＋發現者併進 ulgg 那一筆", () => {
    const ulgg = {
      "6y1j1JloNJjm": {
        tl: null,
        rarity: null,
        stage: null,
        mons: null,
        states: [],
        seenAt: 9000,
        statesAt: null,
        limit: LIMIT,
        founder: "燈皇",
      },
    };
    const shared = {
      [`@燈皇@${LIMIT}`]: {
        tl: null,
        rarity: 1,
        stage: 3,
        mons: null,
        states: [{ type: "scare", until: 2, count: null }],
        seenAt: 2000,
        statesAt: 2000,
        limit: LIMIT,
        founder: "燈皇",
      },
    };
    const m = mergePublicMaps(ulgg, shared);
    expect(Object.keys(m)).toEqual(["6y1j1JloNJjm"]);
    // ulgg 比較新但沒 stage、也沒看過狀態：stage 與狀態都用互傳的
    expect(m["6y1j1JloNJjm"]).toMatchObject({
      stage: 3,
      rarity: 1,
      states: [{ type: "scare" }],
      statesAt: 2000,
      seenAt: 9000,
    });
  });

  it("合併：同一個渦取比較新的狀態，TL 缺的從另一份補；ulgg 掛了就只剩互傳的", () => {
    const ulgg = {
      a: {
        tl: 2091,
        rarity: 1,
        stage: 1,
        mons: "mc1008_02",
        states: [{ type: "mahi", until: 1, count: null }],
        seenAt: 1000,
      },
      b: { tl: 2076, rarity: 1, stage: 1, mons: "mc1003_02", states: [], seenAt: 5000 },
    };
    const shared = {
      a: {
        tl: null,
        rarity: null,
        stage: null,
        mons: null,
        states: [{ type: "scare", until: 2, count: null }],
        seenAt: 2000,
      },
      b: {
        tl: 2076,
        rarity: 1,
        stage: 1,
        mons: "mc1003_02",
        states: [{ type: "huin", until: 3, count: null }],
        seenAt: 4000,
      },
      c: { tl: 2100, rarity: 6, stage: 3, mons: "mc1004", states: [], seenAt: 3000 },
    };
    const m = mergePublicMaps(ulgg, shared);
    expect(m["a"]).toEqual({
      tl: 2091,
      rarity: 1,
      stage: 1,
      mons: "mc1008_02",
      states: [{ type: "scare", until: 2, count: null }],
      seenAt: 2000,
      limit: null,
      founder: null,
    });
    expect(m["b"]!.states).toEqual([]);
    expect(m["c"]!.tl).toBe(2100);
    expect(mergePublicMaps({}, shared)).toEqual(shared);
  });

  it("合併：通報後台的碎片只有那一份有，比較新的那份沒有也要留著", () => {
    const shared = {
      a: { tl: null, rarity: 1, stage: null, mons: null, states: [], seenAt: 9000 },
    };
    const feed = {
      a: {
        tl: null,
        rarity: 1,
        stage: null,
        mons: null,
        states: [],
        seenAt: 1000,
        fragment: "time" as const,
      },
    };
    expect(mergePublicMaps(shared, feed)["a"]!.fragment).toBe("time");
    expect(mergePublicMaps(feed, shared)["a"]!.fragment).toBe("time");
  });
});

describe("回報 stage 給 ulgg", () => {
  const row = (over: Partial<RaidSnapshotRow> = {}): RaidSnapshotRow => ({
    code: "6y1j1JloNJjm",
    founder: "燈皇",
    tl: null,
    rarity: 1,
    stage: 2,
    mons: null,
    hp: null,
    hpMax: null,
    limit: 1,
    states: [],
    statesAt: null,
    foundAt: null,
    players: [],
    ...over,
  });
  const seen = (stage: number | null) => ({
    tl: null,
    rarity: null,
    stage,
    mons: null,
    states: [],
    seenAt: 1,
  });

  it("只報：有渦碼（自己開的）、自己知道 stage、ulgg 有列這個渦但還沒 stage、還沒報過", () => {
    const ulgg = { "6y1j1JloNJjm": seen(null), HAS: seen(3), NEW: seen(null) };
    const picks = pickUlggReports(
      [
        row(),
        row({ code: null }), // 別人開的：沒有渦碼
        row({ code: "HAS" }), // ulgg 已經有 stage：不蓋
        row({ code: "PRIVATE" }), // ulgg 沒列的渦碼：不送出去
        row({ code: "NEW", stage: null }), // 自己不知道 stage
        row({ code: "DONE" }),
      ],
      { ...ulgg, DONE: seen(null) },
      new Set(["DONE"]),
    );
    expect(picks).toEqual([{ raid_code: "6y1j1JloNJjm", stage: 2, rarity: 1 }]);
  });

  it("別人開的渦（沒有渦碼）：發現者＋到期時刻對上 ulgg 那一筆，用 ulgg 公開的渦碼報", () => {
    const listed = (stage: number | null, founder: string, limit: number) => ({
      ...seen(stage),
      founder,
      limit,
    });
    const ulgg = {
      K9DuPkm5MO3f: listed(null, "咕嚕．挖2朵", 1790340999771),
      HAS: listed(4, "燈皇", 1790342032749),
      DONE: listed(null, "dreamscape", 1790342079007),
    };
    const picks = pickUlggReports(
      [
        row({ code: null, founder: "咕嚕．挖2朵", limit: 1790340999771, stage: 3, rarity: 6 }),
        row({ code: null, founder: "咕嚕．挖2朵", limit: 1790340999772 }), // 到期時刻不同：不是同一個
        row({ code: null, founder: "別人", limit: 1790340999771 }), // 發現者不同
        row({ code: null, founder: null, limit: 1790340999771 }),
        row({ code: null, founder: "燈皇", limit: 1790342032749 }), // ulgg 已經有 stage
        row({ code: null, founder: "dreamscape", limit: 1790342079007 }), // 報過了
      ],
      ulgg,
      new Set(["DONE"]),
    );
    expect(picks).toEqual([{ raid_code: "K9DuPkm5MO3f", stage: 3, rarity: 6 }]);
  });

  it("POST JSON 給 ulgg；網路失敗回 null（下一輪再試）", async () => {
    const calls: { url: string; init: { method?: string; body?: string } | undefined }[] = [];
    const ok = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, accepted: true, matched: true }) };
    };
    const res = await reportStageToUlgg(
      { raid_code: "X", stage: 4, rarity: 6 },
      ok,
      "https://u.invalid/r",
    );
    expect(res).toMatchObject({ ok: true, accepted: true });
    expect(calls[0]!.init!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({ raid_code: "X", stage: 4, rarity: 6 });
    const down = async () => {
      throw new Error("offline");
    };
    expect(await reportStageToUlgg({ raid_code: "X", stage: 4, rarity: 6 }, down)).toBeNull();
  });
});
