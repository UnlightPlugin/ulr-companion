import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, LINK_PROTOCOL_VERSION, MOVE_PHASE_TOTAL_SECONDS } from "../src/protocol.js";
import type { ClientMessage, LinkPrefs, ServerMessage } from "../src/protocol.js";
import { RoomRegistry } from "../src/rooms.js";
import type { Outgoing } from "../src/rooms.js";

const ROOM = "room0000";

const prefs = (over: Partial<LinkPrefs> = {}): LinkPrefs => ({ ...DEFAULT_PREFS, ...over });

/** 沒配對到人時該看到的共同設定：秒數滿版、聖水規則關掉。 */
const SOLO = {
  ...DEFAULT_PREFS,
  phaseSeconds: MOVE_PHASE_TOTAL_SECONDS,
  hazardShortenSeconds: 0,
};

function hello(room = ROOM, over: Partial<LinkPrefs> = {}): Extract<ClientMessage, { t: "hello" }> {
  return { t: "hello", v: LINK_PROTOCOL_VERSION, room, prefs: prefs(over) };
}

const to = (out: readonly Outgoing[], id: string): ServerMessage[] =>
  out.filter((o) => o.to === id).map((o) => o.message);

const types = (out: readonly Outgoing[]): string[] => out.map((o) => `${o.to}:${o.message.t}`);

describe("配對", () => {
  it("一個人進來是 solo，第二個人進來兩邊都變成 paired", () => {
    const rooms = new RoomRegistry();
    const first = rooms.join("a", hello());
    expect(to(first, "a")).toEqual([
      { t: "welcome", v: LINK_PROTOCOL_VERSION, paired: false, agreed: SOLO },
    ]);

    const second = rooms.join("b", hello());
    expect(types(second).sort()).toEqual(["a:agreed", "b:welcome"]);
    for (const message of [...to(second, "a"), ...to(second, "b")]) {
      expect(message).toMatchObject({ paired: true });
    }
  });

  it("不同房的人不會配在一起", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello("room-1"));
    const out = rooms.join("b", hello("room-2"));
    expect(to(out, "b")).toEqual([
      { t: "welcome", v: LINK_PROTOCOL_VERSION, paired: false, agreed: SOLO },
    ]);
  });

  it("第三個人被擋在外面，而且不會被記進房裡", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    const out = rooms.join("c", hello());
    expect(out).toEqual([{ to: "c", message: { t: "room-full" } }]);
    expect(rooms.membersOf(ROOM)).toHaveLength(2);
  });

  it("⚠ 版本不合的人不會被收留 —— 光回 incompatible 不夠", () => {
    const rooms = new RoomRegistry();
    const out = rooms.join("a", { ...hello(), v: LINK_PROTOCOL_VERSION + 1 });
    expect(out[0]?.message.t).toBe("incompatible");
    expect(rooms.size).toBe(0);
    // 被拒之後接著送別的訊息也不能混進來。
    expect(rooms.handle("a", { t: "ready", ready: true })).toEqual([]);
    expect(rooms.size).toBe(0);
  });

  it("對手離線 → 剩下的人立刻收到單邊設定", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello(ROOM, { phaseSeconds: 10 }));
    rooms.join("b", hello(ROOM, { phaseSeconds: 15 }));
    const out = rooms.leave("b");
    expect(to(out, "a")).toEqual([{ t: "agreed", paired: false, agreed: SOLO }]);
  });
});

describe("協商結果會送給兩邊", () => {
  it("改設定 → 兩邊都拿到同一份共同設定", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello(ROOM, { phaseSeconds: 10 }));
    rooms.join("b", hello(ROOM, { phaseSeconds: 30 }));

    const out = rooms.handle("b", { t: "prefs", prefs: prefs({ phaseSeconds: 15 }) });
    const forA = to(out, "a")[0];
    const forB = to(out, "b")[0];
    expect(forA).toEqual(forB);
    expect(forA).toMatchObject({ paired: true, agreed: { phaseSeconds: 15 } });
  });
});

describe("⚠ 紅線 1：只發合成訊號", () => {
  it("一方 ready 不會產生任何送給對手的訊息", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    expect(rooms.handle("a", { t: "ready", ready: true })).toEqual([]);
  });

  it("兩邊都 ready 才發，而且是同時發給兩個人", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    rooms.handle("a", { t: "ready", ready: true });
    const out = rooms.handle("b", { t: "ready", ready: true });
    expect(types(out).sort()).toEqual(["a:both-ready", "b:both-ready"]);
  });

  it("協定裡根本沒有一則「對手準備好了」可以發", () => {
    // 這條看起來像廢話，但它是紅線 1 的機械化版本：只要有人手滑加了一種
    // 訊息把 peer.ready 洩出去，這個測試就會紅。
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    const all = [
      ...rooms.handle("a", { t: "ready", ready: true }),
      ...rooms.handle("a", { t: "ready", ready: false }),
      ...rooms.handle("b", { t: "ready", ready: true }),
      ...rooms.handle("b", { t: "ready", ready: false }),
    ];
    expect(all).toEqual([]);
  });

  it("取消準備之後對手再按下去，不會湊成 both-ready", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    rooms.handle("a", { t: "ready", ready: true });
    rooms.handle("a", { t: "ready", ready: false });
    expect(rooms.handle("b", { t: "ready", ready: true })).toEqual([]);
  });

  it("⚠ 邊緣觸發：發過一次之後旗標要收掉，不會重複觸發", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    rooms.handle("a", { t: "ready", ready: true });
    expect(rooms.handle("b", { t: "ready", ready: true })).toHaveLength(2);
    // 下一個階段 a 先按 —— 不該因為 b 上一次的旗標還留著就立刻放行。
    expect(rooms.handle("a", { t: "ready", ready: true })).toEqual([]);
  });

  it("任一方關掉準備功能就不同步釋放", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello(ROOM, { readyEnabled: true }));
    rooms.join("b", hello(ROOM, { readyEnabled: false }));
    rooms.handle("a", { t: "ready", ready: true });
    expect(rooms.handle("b", { t: "ready", ready: true })).toEqual([]);
  });
});

describe("換場", () => {
  it("⚠ 換房要把 ready 清掉，否則新的一場一開始就會被放行", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    rooms.handle("a", { t: "ready", ready: true });

    rooms.handle("a", { t: "room", room: "room-next" });
    rooms.handle("b", { t: "room", room: "room-next" });
    // a 的舊 ready 不該還算數。
    expect(rooms.handle("b", { t: "ready", ready: true })).toEqual([]);
  });

  it("換房之後舊房與新房的人都會收到新的共同設定", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    const out = rooms.handle("b", { t: "room", room: "room-next" });
    expect(types(out).sort()).toEqual(["a:agreed", "b:agreed"]);
    expect(to(out, "a")[0]).toMatchObject({ paired: false });
  });

  it("房號沒變就什麼都不做", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    expect(rooms.handle("a", { t: "room", room: ROOM })).toEqual([]);
  });
});

describe("強制提早結束", () => {
  it("只轉給對手，不回給自己", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    rooms.join("b", hello());
    const out = rooms.handle("a", { t: "force-end", reason: "hazard-cap" });
    expect(out).toEqual([{ to: "b", message: { t: "force-end", reason: "hazard-cap" } }]);
  });

  it("沒有對手就沒人可以轉", () => {
    const rooms = new RoomRegistry();
    rooms.join("a", hello());
    expect(rooms.handle("a", { t: "force-end", reason: "agreed-cap" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 還原（雲端版的 hibernation 用）
// ---------------------------------------------------------------------------
describe("還原", () => {
  it("⚠ 還原一個人**不送任何訊息** —— 對手不該看到約定秒數閃一下", () => {
    const rooms = new RoomRegistry();
    // `restore()` 沒有回傳值就是這條規則的形狀：它連「要送什麼」都不產生。
    rooms.restore({ id: "a", room: ROOM, prefs: prefs({ phaseSeconds: 12 }), ready: false });
    expect(rooms.membersOf(ROOM)).toHaveLength(1);
    expect(rooms.memberOf("a")?.prefs.phaseSeconds).toBe(12);
  });

  it("⚠ ready 要一起還原 —— 掉了的話玩家剛按下的 OK 會被默默取消", () => {
    // 雲端版：兩個人都按了 OK、正在等對方，這時中間人被移出記憶體。醒來後
    // 若 ready 變回 false，兩邊會一路等到硬底線才各自送出。
    const rooms = new RoomRegistry();
    rooms.restore({ id: "a", room: ROOM, prefs: prefs(), ready: true });
    rooms.restore({ id: "b", room: ROOM, prefs: prefs(), ready: false });
    expect(rooms.memberOf("a")?.ready).toBe(true);

    // 還原之後 b 按下 OK，兩邊就該同時收到 both-ready。
    expect(types(rooms.handle("b", { t: "ready", ready: true })).sort()).toEqual([
      "a:both-ready",
      "b:both-ready",
    ]);
  });

  it("還原進來的人跟一般成員一樣會被協商到", () => {
    const rooms = new RoomRegistry();
    rooms.restore({ id: "a", room: ROOM, prefs: prefs({ phaseSeconds: 25 }), ready: false });
    const out = rooms.join("b", hello(ROOM, { phaseSeconds: 10 }));
    // 取比較長的那個 —— 25，不是 10。
    for (const message of [...to(out, "a"), ...to(out, "b")]) {
      expect(message).toMatchObject({ paired: true, agreed: { phaseSeconds: 25 } });
    }
  });

  it("memberOf：沒這個人就是 null", () => {
    expect(new RoomRegistry().memberOf("nobody")).toBeNull();
  });
});
