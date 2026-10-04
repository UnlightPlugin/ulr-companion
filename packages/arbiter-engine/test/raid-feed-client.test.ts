/**
 * 公開渦通知的托盤端：同一份 SUPPORT 不重傳、只補帳本缺的、關掉互傳只讀不傳、失敗不丟例外。
 */

import type { RaidFeedView } from "@ulr/arbiter-link/raid-feed";
import type { RaidSnapshotRow, RaidSupportRow } from "@ulr/cdp-adapter";
import { describe, expect, it } from "vitest";
import {
  feedToPublicMap,
  ownToFeed,
  pickOwnToFill,
  RaidFeedSync,
} from "../src/raid-feed-client.js";
import type { FetchLike } from "../src/raid-public.js";

const FOUND = 1_791_029_788_126;
const LIMIT = 1_791_051_388_126;

const supportRow: RaidSupportRow = {
  founder: "燈皇",
  foundAt: FOUND,
  limit: LIMIT,
  name: "屠殺者",
  monsterId: 30114,
  mons: "mc1006_02",
  hp: 284,
  hpMax: 1200,
  memberLength: 33,
  memberLimit: 100,
};

const ownRow = (over: Partial<RaidSnapshotRow> = {}): RaidSnapshotRow => ({
  code: "ABCDEFGHIJKL",
  founder: "燈皇",
  tl: null,
  rarity: 1,
  stage: 3,
  mons: null,
  hp: 325,
  hpMax: 1200,
  limit: LIMIT,
  states: [],
  statesAt: null,
  foundAt: FOUND,
  players: ["某人"],
  ...over,
});

const view = (over: Partial<RaidFeedView> = {}): RaidFeedView => ({
  ...supportRow,
  rarity: null,
  level: null,
  stage: null,
  mapIndex: null,
  states: null,
  statesAt: null,
  seenAt: FOUND + 1000,
  fragment: null,
  ...over,
});

interface Call {
  method: string;
  body: { source?: string; raids?: unknown[] } | null;
}

/** 假的 Worker：記下請求，GET 回 `feed`。`fail` 為真時全部 500。 */
function fakeWorker(feed: RaidFeedView[], fail = false) {
  const calls: Call[] = [];
  const impl: FetchLike = async (_url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(init.body) : null });
    if (fail) return { ok: false, json: async () => null };
    return {
      ok: true,
      json: async () => (method === "GET" ? { raids: feed, now: 0 } : { accepted: 1 }),
    };
  };
  return { calls, impl };
}

describe("ownToFeed", () => {
  it("不帶渦碼、玩家名單", () => {
    const [r] = ownToFeed([ownRow()]);
    expect(JSON.stringify(r)).not.toContain("ABCDEFGHIJKL");
    expect(JSON.stringify(r)).not.toContain("某人");
    expect(r).toMatchObject({ founder: "燈皇", foundAt: FOUND, rarity: 1, stage: 3 });
  });

  it("沒有發現時刻的（舊版頁面）丟掉", () => {
    expect(ownToFeed([ownRow({ foundAt: null })])).toEqual([]);
  });
});

describe("pickOwnToFill", () => {
  it("帳本有、缺 stage 才補", () => {
    const own = ownToFeed([ownRow()]);
    expect(pickOwnToFill(own, [view()])).toHaveLength(1);
    expect(pickOwnToFill(own, [view({ stage: 3, rarity: 1 })])).toEqual([]);
    expect(pickOwnToFill(own, [])).toEqual([]);
  });

  it("帳本上已經有別人的 stage 就不蓋", () => {
    expect(pickOwnToFill(ownToFeed([ownRow()]), [view({ stage: 4, rarity: 1 })])).toEqual([]);
  });
});

describe("區塊（查 ulrmap 用）", () => {
  it("自己清單帶 map_index 上去；帳本缺區塊就補", () => {
    const row = ownRow({
      meta: {
        name: "屠殺者",
        monsterId: 30114,
        level: 1,
        mapIndex: 9,
        category: "normal",
        point: 0,
        stage: null,
        expectFrag: null,
        expectCoin: false,
        expectSrc: null,
        expectItems: [],
      },
    });
    const own = ownToFeed([row]);
    expect(own[0]).toMatchObject({ mapIndex: 9, monsterId: 30114, level: 1 });
    expect(pickOwnToFill(own, [view({ stage: 3, rarity: 1 })])).toHaveLength(1);
    expect(pickOwnToFill(own, [view({ stage: 3, rarity: 1, mapIndex: 9 })])).toEqual([]);
  });
});

describe("狀態與死亡", () => {
  const states = [{ type: "mahi", until: FOUND + 9_000_000, count: null }];

  it("開打看過才帶狀態", () => {
    expect(ownToFeed([ownRow()])[0]).toMatchObject({ states: null, statesAt: null });
    expect(ownToFeed([ownRow({ states, statesAt: FOUND + 1 })])[0]).toMatchObject({
      states,
      statesAt: FOUND + 1,
    });
  });

  it("自己的狀態比帳本新、或看到它死了而帳本還不知道，就補", () => {
    const full = { stage: 3, rarity: 1, mapIndex: null };
    const mine = ownToFeed([ownRow({ states, statesAt: FOUND + 5 })]);
    expect(pickOwnToFill(mine, [view({ ...full, statesAt: FOUND + 1 })])).toHaveLength(1);
    expect(pickOwnToFill(mine, [view({ ...full, statesAt: FOUND + 9 })])).toEqual([]);
    const dead = ownToFeed([ownRow({ hp: 0 })]);
    expect(pickOwnToFill(dead, [view({ ...full, hp: 100 })])).toHaveLength(1);
    expect(pickOwnToFill(dead, [view({ ...full, hp: 0 })])).toEqual([]);
  });
});

describe("整份 SUPPORT（判斷打倒用）", () => {
  it("說是整份，附上自己清單上還活著、帳本上已經有的渦", async () => {
    const w = fakeWorker([view()]);
    const otherOwn = ownRow({ founder: "別人", foundAt: FOUND + 5 });
    await new RaidFeedSync(w.impl, "https://x/raid-feed").sync(
      [supportRow],
      [ownRow(), otherOwn],
      true,
    );
    const body = w.calls.find((c) => c.body?.source === "support")?.body as {
      complete?: boolean;
      present?: unknown[];
    };
    expect(body.complete).toBe(true);
    // 「別人」不在帳本上（可能是好友限定的渦）：不送
    expect(body.present).toEqual([{ founder: "燈皇", foundAt: FOUND }]);
  });

  it("GET 失敗（不知道帳本上有什麼）就不說是整份", async () => {
    let n = 0;
    const impl: FetchLike = async (_url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        n++;
        return { ok: false, json: async () => null };
      }
      return { ok: true, json: async () => ({ accepted: 1 }) };
    };
    const calls: unknown[] = [];
    const spy: FetchLike = async (url, init) => {
      if (init?.body) calls.push(JSON.parse(init.body));
      return impl(url, init);
    };
    await new RaidFeedSync(spy, "https://x/raid-feed").sync([supportRow], [ownRow()], true);
    expect(n).toBeGreaterThan(0);
    expect((calls[0] as { complete?: boolean }).complete).toBe(false);
  });
});

describe("自己按送出公開", () => {
  const pub = {
    founder: "燈皇",
    foundAt: FOUND,
    limit: LIMIT,
    name: "爬行者",
    monsterId: 30113,
    mons: "mc1006_03",
    hp: 3000,
    hpMax: 3000,
    rarity: 1,
    level: 1,
    mapIndex: 4,
    at: FOUND + 1,
  };

  it("傳一次就好；關掉互傳不傳", async () => {
    const w = fakeWorker([]);
    const sync = new RaidFeedSync(w.impl, "https://x/raid-feed");
    await sync.sync([], [], true, [pub]);
    await sync.sync([], [], true, [pub]);
    const sent = w.calls.filter((c) => c.body?.source === "publish");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body?.raids?.[0]).toMatchObject({ mons: "mc1006_03", rarity: 1, mapIndex: 4 });
    const off = fakeWorker([]);
    await new RaidFeedSync(off.impl, "https://x/raid-feed").sync([], [], false, [pub]);
    expect(off.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("feedToPublicMap", () => {
  it("用發現者＋到期時刻當鍵，頁面拿它對渦", () => {
    const map = feedToPublicMap([view({ stage: 2, rarity: 6 })]);
    expect(map[`@燈皇@${LIMIT}`]).toMatchObject({
      stage: 2,
      rarity: 6,
      founder: "燈皇",
      limit: LIMIT,
    });
  });

  it("後台算好的碎片也帶下去（stage 還沒人看到、ulrmap 查到的）", () => {
    const map = feedToPublicMap([view({ stage: null, fragment: "soul" })]);
    expect(map[`@燈皇@${LIMIT}`]).toMatchObject({ stage: null, fragment: "soul" });
    expect(feedToPublicMap([view()])[`@燈皇@${LIMIT}`]!.fragment ?? null).toBeNull();
  });
});

describe("RaidFeedSync", () => {
  it("同一份 SUPPORT 只傳一次；變了再傳", async () => {
    const w = fakeWorker([]);
    const sync = new RaidFeedSync(w.impl, "https://x/raid-feed");
    expect((await sync.sync([supportRow], [], true)).support).toBe(1);
    expect((await sync.sync([supportRow], [], true)).support).toBe(0);
    expect((await sync.sync([{ ...supportRow, hp: 100 }], [], true)).support).toBe(1);
    expect(w.calls.filter((c) => c.body?.source === "support")).toHaveLength(2);
  });

  it("補帳本缺的 stage", async () => {
    const w = fakeWorker([view()]);
    const r = await new RaidFeedSync(w.impl, "https://x/raid-feed").sync([], [ownRow()], true);
    expect(r.own).toBe(1);
    expect(w.calls.find((c) => c.body?.source === "own")?.body?.raids).toHaveLength(1);
  });

  it("關掉互傳：只讀不傳", async () => {
    const w = fakeWorker([view({ stage: 2, rarity: 1 })]);
    const r = await new RaidFeedSync(w.impl, "https://x/raid-feed").sync(
      [supportRow],
      [ownRow()],
      false,
    );
    expect(w.calls.every((c) => c.method === "GET")).toBe(true);
    expect(Object.keys(r.map)).toHaveLength(1);
  });

  it("Worker 掛了：不丟例外、空表、下一輪重傳 SUPPORT", async () => {
    const down = fakeWorker([], true);
    const sync = new RaidFeedSync(down.impl, "https://x/raid-feed");
    expect(await sync.sync([supportRow], [ownRow()], true)).toEqual({
      map: {},
      support: 0,
      own: 0,
    });
    // 同一個實例換成好的 Worker 不行（fetch 是建構時給的），所以驗「沒記成傳過」：再傳一次還會打 POST
    await sync.sync([supportRow], [], true);
    expect(down.calls.filter((c) => c.body?.source === "support")).toHaveLength(2);
  });
});
