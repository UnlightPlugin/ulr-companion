/**
 * ulgg 的 observed_raids → 頁面端要的公開渦表
 *
 * 樣本照 2026-09-13 實際回應的形狀縮的。這是第三方格式，所以重點是
 * **壞掉時不會炸**：缺欄位、非 2xx、逾時、格式不對，全都回空表。
 */

import { describe, expect, it } from "vitest";
import {
  fetchObservedRaids,
  lookupSharedRaids,
  mergePublicMaps,
  parseObservedRaids,
  uploadSharedRaids,
} from "@ulr/arbiter-engine";
import { normalizeRaidUpload, RaidBoard, raidShareKey } from "@ulr/arbiter-link";

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
    });
    expect(map["bare"]).toEqual({
      tl: null,
      rarity: null,
      stage: null,
      mons: null,
      states: [],
      seenAt: null,
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

  it("上傳的人傳渦碼的雜湊；查的人拿渦碼查得回來；看板上沒有渦碼", async () => {
    const cloud = fakeCloud();
    const n = await uploadSharedRaids(
      [
        {
          code: "tfqLuvEDegF3",
          tl: 2091,
          rarity: 1,
          stage: 1,
          mons: "mc1008_02",
          hp: 100,
          hpMax: 6000,
          limit: NOW + 3_600_000,
          states: [{ type: "scare", until: NOW + 60_000, count: null }],
          players: ["燈皇"],
        },
      ],
      cloud.fetchImpl,
      "https://x.invalid/raids",
    );
    expect(n).toBe(1);
    expect(cloud.calls.join("\n")).not.toContain("tfqLuvEDegF3");
    // 排行榜名字只給查隊伍用，不跟渦狀態一起上傳
    expect(cloud.calls.join("\n")).not.toContain("燈皇");
    const map = await lookupSharedRaids(
      ["tfqLuvEDegF3", "nobody"],
      cloud.fetchImpl,
      "https://x.invalid/raids",
    );
    expect(Object.keys(map)).toEqual(["tfqLuvEDegF3"]);
    expect(map["tfqLuvEDegF3"]).toMatchObject({
      tl: 2091,
      mons: "mc1008_02",
      states: [{ type: "scare" }],
    });
    expect(cloud.calls.at(-1)).toContain(await raidShareKey("tfqLuvEDegF3"));
  });

  it("查不到、看板掛了都回空表", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    expect(await lookupSharedRaids(["abc"], down)).toEqual({});
    expect(
      await uploadSharedRaids(
        [
          {
            code: "abc",
            tl: null,
            rarity: null,
            stage: null,
            mons: null,
            hp: null,
            hpMax: null,
            limit: NOW + 1000,
            states: [],
            players: [],
          },
        ],
        down,
      ),
    ).toBe(0);
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
    });
    expect(m["b"]!.states).toEqual([]);
    expect(m["c"]!.tl).toBe(2100);
    expect(mergePublicMaps({}, shared)).toEqual(shared);
  });
});
