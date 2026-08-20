import { describe, expect, it, vi } from "vitest";
import type { MatchContext, RoomEntry } from "@ulr/cdp-adapter";
import { guestJoinRoom, hostOpenRoom, preflight, type MatchDriver } from "../src/match-session.js";

const ROOM: Parameters<MatchDriver["createRoom"]>[0] = {
  name: "ULR3",
  stage: "000",
  multi: true,
  friend: false,
  pass: "AB12CD34",
  cost: null,
};

function ctx(over: Partial<MatchContext> = {}): MatchContext {
  return {
    hasId: true,
    channel: 4,
    channels: null,
    crossplay: true,
    deckNow: 1,
    deckCost: 49,
    deckKeys: {
      characters: ["cc001_04", "cc002_03", "cc003_r02"],
      equipment: [],
      eventCards: [],
    },
    playerName: "燈皇",
    isMatching: false,
    inMatch: true,
    ap: 30,
    apMax: 30,
    duelFree: 0,
    ...over,
  };
}

function room(over: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: "r1",
    name: "ULR3",
    playerAName: "燈皇",
    playerBName: null,
    pass: true,
    deckA: null,
    deckB: null,
    ...over,
  };
}

/** 房間清單一輪一輪地換，模擬推播。 */
type Snap = { seq: number; live?: boolean; rooms: RoomEntry[] };

function driver(over: Partial<MatchDriver> & { snapshots?: Snap[] } = {}): MatchDriver {
  // 預設 live=true：正常情況讀得到遊戲手上那份清單。要測「讀不到」的那條路
  // 就自己傳 live:false。
  const snaps = over.snapshots ?? [{ seq: 1, rooms: [] }];
  let i = 0;
  return {
    matchContext: over.matchContext ?? (async () => ctx()),
    roomSnapshot:
      over.roomSnapshot ??
      (async () => {
        const s = snaps[Math.min(i++, snaps.length - 1)]!;
        return { seq: s.seq, live: s.live ?? true, rooms: s.rooms };
      }),
    createRoom: over.createRoom ?? (async () => ({ ok: true, roomId: null })),
    joinRoom: over.joinRoom ?? (async () => ({ ok: true })),
    cancelRoom: over.cancelRoom ?? (async () => "ok"),
  };
}

const nosleep = async () => {};

describe("preflight", () => {
  it("條件都對就放行", async () => {
    const r = await preflight(driver({ snapshots: [{ seq: 5, rooms: [] }] }), { expectChannel: 4 });
    expect(r.ok).toBe(true);
  });

  it("不在大廳", async () => {
    const d = driver({ matchContext: async () => ctx({ inMatch: false }) });
    const r = await preflight(d, { expectChannel: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.code).toBe("not-in-match");
  });

  it("沒進頻道", async () => {
    const d = driver({ matchContext: async () => ctx({ channel: null }) });
    const r = await preflight(d, { expectChannel: 4 });
    if (!r.ok) expect(r.block.code).toBe("no-channel");
  });

  it("在別的頻道 —— 訊息要講出兩邊各是幾號", async () => {
    const d = driver({ matchContext: async () => ctx({ channel: 2 }) });
    const r = await preflight(d, { expectChannel: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block.code).toBe("wrong-channel");
      expect(r.block.message).toContain("頻道 2");
      expect(r.block.message).toContain("頻道 4");
    }
  });

  it("已經在配對中", async () => {
    const d = driver({ matchContext: async () => ctx({ isMatching: true }) });
    const r = await preflight(d, { expectChannel: 4 });
    if (!r.ok) expect(r.block.code).toBe("already-matching");
  });

  it("⚠ 玩家已經有自己的房就不能開 —— delete_room 會連那間一起收掉", async () => {
    const d = driver({ snapshots: [{ seq: 3, rooms: [room({ name: "請多關照" })] }] });
    const r = await preflight(d, { expectChannel: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.code).toBe("has-own-room");
  });

  it("⚠ 讀不到遊戲那份、又一次推播都沒收到時，空清單不算「沒有房」", async () => {
    // live=false 且 seq=0 = 完全不知道。拿它當證據會直接踩到上面那個坑。
    // 反過來說 live=true 的空清單是**真的空**，可以放行 —— 房間清單是「有變動
    // 才推」，硬等推播會讓正常流程整個卡住（實測等 45 秒都等不到）。
    const d = driver({ snapshots: [{ seq: 0, live: false, rooms: [] }] });
    const r = await preflight(d, { expectChannel: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.code).toBe("no-room-list");
  });
});

describe("hostOpenRoom", () => {
  it("開房之後從新的推播裡找出 room_id", async () => {
    const d = driver({
      snapshots: [
        { seq: 10, rooms: [] }, // 開房前
        { seq: 11, rooms: [room({ roomId: "新的一間" })] }, // 開房後
      ],
    });
    const r = await hostOpenRoom(d, { room: ROOM, playerName: "燈皇", sleep: nosleep });
    expect(r).toEqual({ ok: true, roomId: "新的一間" });
  });

  it("⚠ 開房前就在清單上的房不算數 —— 那會交出上一場的 room_id", async () => {
    // 清單裡有一間看起來很像的房（同房主、同房名、也沒有對手），但它在開房
    // **之前**就在了。採信的話會把上一場的 room_id 交給對手，而伺服器會正確地
    // 回 fail:9（那間房早就配對過了）—— 錯誤訊息看起來完全像別的問題。
    const stale = { seq: 10, rooms: [room({ roomId: "上一場的" })] };
    const d = driver({ snapshots: [stale] });
    const r = await hostOpenRoom(d, {
      room: ROOM,
      playerName: "燈皇",
      attempts: 3,
      sleep: nosleep,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsCancel).toBe(true);
  });

  it("伺服器拒絕開房就不用收房", async () => {
    const d = driver({
      createRoom: async () => ({ ok: false, reason: "伺服器拒絕開房", fail: 20 }),
    });
    const r = await hostOpenRoom(d, { room: ROOM, playerName: "燈皇", sleep: nosleep });
    expect(r).toMatchObject({ ok: false, fail: 20, needsCancel: false });
  });

  it("開出來的房沒鎖就不拿去配對", async () => {
    const d = driver({
      snapshots: [
        { seq: 1, rooms: [] },
        { seq: 2, rooms: [room({ pass: false })] },
      ],
    });
    const r = await hostOpenRoom(d, { room: ROOM, playerName: "燈皇", sleep: nosleep });
    expect(r).toMatchObject({ ok: false, needsCancel: true });
  });

  it("找不到自己那間房時要求收房", async () => {
    const d = driver({
      snapshots: [
        { seq: 1, rooms: [] },
        { seq: 2, rooms: [] },
      ],
    });
    const r = await hostOpenRoom(d, {
      room: ROOM,
      playerName: "燈皇",
      attempts: 2,
      sleep: nosleep,
    });
    expect(r).toMatchObject({ ok: false, needsCancel: true });
  });
});

describe("guestJoinRoom", () => {
  it("房出現了才進", async () => {
    const join = vi.fn(async () => ({ ok: true as const }));
    const d = driver({
      snapshots: [
        { seq: 1, rooms: [] },
        { seq: 2, rooms: [room({ roomId: "對方的房" })] },
      ],
      joinRoom: join,
    });
    const r = await guestJoinRoom(d, { roomId: "對方的房", pass: "AB12CD34", sleep: nosleep });
    expect(r).toEqual({ ok: true });
    expect(join).toHaveBeenCalledWith("對方的房", "AB12CD34");
  });

  it("房一直沒出現就不進，也不亂猜", async () => {
    const join = vi.fn();
    const d = driver({ snapshots: [{ seq: 1, rooms: [] }], joinRoom: join as never });
    const r = await guestJoinRoom(d, {
      roomId: "對方的房",
      pass: "AB12CD34",
      attempts: 3,
      sleep: nosleep,
    });
    expect(r.ok).toBe(false);
    expect(join).not.toHaveBeenCalled();
  });

  it("進房被拒就把 fail 代碼帶回來", async () => {
    const d = driver({
      snapshots: [{ seq: 1, rooms: [room({ roomId: "對方的房" })] }],
      joinRoom: async () => ({ ok: false, reason: "進房被拒", fail: 9 }),
    });
    const r = await guestJoinRoom(d, { roomId: "對方的房", pass: "AB12CD34", sleep: nosleep });
    expect(r).toMatchObject({ ok: false, fail: 9 });
  });
});

/**
 * 「按下去到開打」那幾秒花在哪。
 *
 * ⚠ 玩家 2026-08-19 回報「2~5 秒還是很久」。那段時間幾乎全部是這兩支在等
 * 房間清單，而其中**一整秒是白等的** —— host 原本先睡再看，即使推播早就到了
 * 也要睡滿一輪。這一組釘的就是「先看再睡」。
 */
describe("⚠ 開房／進房不白等", () => {
  it("房已經在清單上時，host 一次都不睡", async () => {
    const sleep = vi.fn(async () => {});
    const d = driver({
      snapshots: [
        { seq: 10, rooms: [] }, // 開房前
        { seq: 11, rooms: [room({ roomId: "新的一間" })] }, // 開房後，推播已經到了
      ],
    });
    const r = await hostOpenRoom(d, { room: ROOM, playerName: "燈皇", sleep });
    expect(r).toEqual({ ok: true, roomId: "新的一間" });
    // 先看再睡：第一眼就找到 → 完全沒有睡過
    expect(sleep).not.toHaveBeenCalled();
  });

  it("推播還沒到就照節奏等，等到了才回", async () => {
    const sleep = vi.fn(async () => {});
    const d = driver({
      snapshots: [
        { seq: 10, rooms: [] }, // 開房前
        { seq: 10, rooms: [] }, // 第一眼：還沒推下來
        { seq: 11, rooms: [room({ roomId: "新的一間" })] },
      ],
    });
    const r = await hostOpenRoom(d, { room: ROOM, playerName: "燈皇", sleep });
    expect(r).toEqual({ ok: true, roomId: "新的一間" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("guest 同樣先看再睡", async () => {
    const sleep = vi.fn(async () => {});
    const d = driver({ snapshots: [{ seq: 1, rooms: [room({ roomId: "對方的" })] }] });
    const r = await guestJoinRoom(d, { roomId: "對方的", pass: "AB12CD34", sleep });
    expect(r.ok).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});
