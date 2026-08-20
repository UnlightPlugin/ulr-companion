/**
 * 大廳人數推播的客戶端
 *
 * 這個檔案測的是四件「錯了不會有人發現」的事：
 *
 *   1. 舊中間人不回話時**要放棄**（否則畫面上的人數整個消失，而沒有任何錯誤）
 *   2. 換標籤**不重連**（重連的那幾秒畫面沒有數字）
 *   3. 不看了就要**真的關掉**（連著不看是白付的連線）
 *   4. 同樣的數字**不重複往上報**（每一則都換畫面 = 兩趟 CDP 白跑）
 *
 * 四件的共同點是：跑起來都「看起來正常」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_PROTOCOL_VERSION } from "@ulr/arbiter-link/protocol";
import { encodeQueue } from "@ulr/arbiter-link/match-queue";
import type { WatchSocketHandlers, WatchSocketLike } from "@ulr/arbiter-link";
import { QueueWatcher, WATCH_COUNT_TIMEOUT_MS } from "@ulr/arbiter-link";

const A = "0123456789abcdef";
const B = "fedcba9876543210";

interface Fake extends WatchSocketLike {
  url: string;
  sent: string[];
  closed: boolean;
  handlers: WatchSocketHandlers;
  /** ⚠ 真的 WebSocket 不會同步 open，見 `WatchSocketHandlers` 的說明。 */
  open(): void;
  count(waiting: number): void;
}

function harness() {
  const sockets: Fake[] = [];
  const counts: [string, number][] = [];
  const logs: string[] = [];
  const watcher = new QueueWatcher({
    endpoint: "wss://x",
    onCount: (key, waiting) => counts.push([key, waiting]),
    onLog: (line) => logs.push(line),
    socketFactory: (url, handlers) => {
      const fake: Fake = {
        url,
        sent: [],
        closed: false,
        handlers,
        send: (data) => fake.sent.push(data),
        close: () => {
          fake.closed = true;
        },
        open: () => handlers.onOpen(),
        count: (waiting) => handlers.onMessage(encodeQueue({ t: "q-count", waiting })),
      };
      sockets.push(fake);
      return fake;
    },
  });
  return { watcher, sockets, counts, logs };
}

/** 連上、送 `q-watch`、回一個數字 —— 大部分測試的起點。 */
function live(h: ReturnType<typeof harness>, index = 0, waiting = 0): Fake {
  const socket = h.sockets[index];
  if (socket === undefined) throw new Error(`沒有第 ${index} 條線`);
  socket.open();
  socket.count(waiting);
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("接上去", () => {
  it("一條佇列一條線，路徑是 /q/<鍵>", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }, { key: B }]);
    expect(h.sockets.map((s) => s.url)).toEqual(["wss://x/q/" + A, "wss://x/q/" + B]);
  });

  it("open 之後才送 q-watch，帶著自己的標籤", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A, tag: "tag-a" }]);
    expect(h.sockets[0]?.sent).toEqual([]);
    h.sockets[0]?.open();
    expect(h.sockets[0]?.sent).toEqual([
      JSON.stringify({ t: "q-watch", v: LINK_PROTOCOL_VERSION, key: A, tag: "tag-a" }),
    ]);
  });

  it("沒有標籤就不帶 —— 那是「全部都數」，跟帶一個空字串不一樣", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    h.sockets[0]?.open();
    expect(h.sockets[0]?.sent[0]).toBe(
      JSON.stringify({ t: "q-watch", v: LINK_PROTOCOL_VERSION, key: A }),
    );
  });

  it("收到 q-count 就往上報，狀態變 live", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    live(h, 0, 3);
    expect(h.counts).toEqual([[A, 3]]);
    expect(h.watcher.stateOf(A)).toBe("live");
    expect(h.watcher.allLive).toBe(true);
  });

  it("⚠ 同樣的數字不重複往上報", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    const socket = live(h, 0, 2);
    socket.count(2);
    socket.count(2);
    socket.count(5);
    expect(h.counts).toEqual([
      [A, 2],
      [A, 5],
    ]);
  });

  it("⚠ 有一條還沒 live 就不算 allLive —— 呼叫端要靠它決定還要不要輪詢", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }, { key: B }]);
    live(h, 0, 1);
    expect(h.watcher.allLive).toBe(false);
    live(h, 1, 0);
    expect(h.watcher.allLive).toBe(true);
  });

  it("一條都沒看時 allLive 是 false（沒有推播 = 要輪詢）", () => {
    const h = harness();
    expect(h.watcher.allLive).toBe(false);
  });
});

describe("⚠ 舊中間人：線開著但不回話", () => {
  it("逾時之後放棄，關線、不重試", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    h.sockets[0]?.open();

    vi.advanceTimersByTime(WATCH_COUNT_TIMEOUT_MS - 1);
    expect(h.watcher.stateOf(A)).toBe("connecting");

    vi.advanceTimersByTime(2);
    expect(h.watcher.stateOf(A)).toBe("unsupported");
    expect(h.sockets[0]?.closed).toBe(true);

    // ⚠ 不重試。舊版就是舊版，敲一萬次也一樣 —— 呼叫端會退回輪詢。
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.logs.join("")).toContain("輪詢");
  });

  it("回了數字就不會被逾時砍掉", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    live(h, 0, 1);
    vi.advanceTimersByTime(10 * WATCH_COUNT_TIMEOUT_MS);
    expect(h.watcher.stateOf(A)).toBe("live");
    expect(h.sockets[0]?.closed).toBe(false);
  });

  it("版本不合也是放棄，不重試", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    h.sockets[0]?.open();
    h.sockets[0]?.handlers.onMessage(
      encodeQueue({ t: "q-incompatible", v: LINK_PROTOCOL_VERSION + 1, reason: "太舊" }),
    );
    expect(h.watcher.stateOf(A)).toBe("unsupported");
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("斷線", () => {
  it("連上過再斷線 → 重連（退避）", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    live(h, 0, 1);
    h.sockets[0]?.handlers.onClose(1006);
    expect(h.watcher.stateOf(A)).toBe("connecting");

    vi.advanceTimersByTime(2_000);
    expect(h.sockets).toHaveLength(2);
    live(h, 1, 4);
    expect(h.counts).toEqual([
      [A, 1],
      [A, 4],
    ]);
  });

  it("⚠ 一次都沒推過就一直連不上 → 放棄，讓呼叫端退回輪詢", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    // 每一次都是「開了就被關掉」（位址錯、服務沒部署都長這樣）
    for (let i = 0; i < 10; i++) {
      h.sockets[h.sockets.length - 1]?.handlers.onClose(1006);
      vi.advanceTimersByTime(60_000);
    }
    expect(h.watcher.stateOf(A)).toBe("unsupported");
    expect(h.sockets.length).toBeLessThanOrEqual(5);
  });

  it("⚠ 一條壞掉不會害另一條放棄得比較晚", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }, { key: B }]);
    live(h, 0, 2); // A 好的
    // B 一直連不上
    for (let i = 0; i < 10; i++) {
      const last = h.sockets[h.sockets.length - 1];
      if (last?.url.endsWith(B) === true) last.handlers.onClose(1006);
      vi.advanceTimersByTime(60_000);
    }
    expect(h.watcher.stateOf(A)).toBe("live");
    expect(h.watcher.stateOf(B)).toBe("unsupported");
  });
});

describe("換要看的東西", () => {
  it("⚠ 只換標籤 → 不重連，直接再送一則", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A, tag: "old" }]);
    live(h, 0, 1);
    h.watcher.setTargets([{ key: A, tag: "new" }]);

    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]?.closed).toBe(false);
    expect(h.sockets[0]?.sent).toHaveLength(2);
    expect(h.sockets[0]?.sent[1]).toContain('"tag":"new"');
  });

  it("同一組再叫一次什麼都不做（這支每三秒會被叫一次）", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A, tag: "t" }]);
    live(h, 0, 1);
    h.watcher.setTargets([{ key: A, tag: "t" }]);
    h.watcher.setTargets([{ key: A, tag: "t" }]);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]?.sent).toHaveLength(1);
  });

  it("不看了就關掉，數字也一起忘掉", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }, { key: B }]);
    live(h, 0, 3);
    live(h, 1, 1);
    h.watcher.setTargets([{ key: B }]);

    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.sockets[1]?.closed).toBe(false);
    expect([...h.watcher.counts.keys()]).toEqual([B]);
    expect(h.watcher.stateOf(A)).toBeNull();
  });

  it("⚠ stop() 之後不會再有任何重連 —— 玩家離開大廳走的就是這條", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    live(h, 0, 1);
    h.watcher.stop();

    expect(h.sockets[0]?.closed).toBe(true);
    h.sockets[0]?.handlers.onClose(1006);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.watcher.allLive).toBe(false);
  });

  it("stop() 之後再 setTargets 可以重新開始（回大廳）", () => {
    const h = harness();
    h.watcher.setTargets([{ key: A }]);
    live(h, 0, 1);
    h.watcher.stop();
    h.watcher.setTargets([{ key: A }]);
    expect(h.sockets).toHaveLength(2);
    live(h, 1, 7);
    expect(h.counts.at(-1)).toEqual([A, 7]);
  });
});
