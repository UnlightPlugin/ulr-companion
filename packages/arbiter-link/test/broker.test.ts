/**
 * 真的把 socket 開起來跑一遍。
 *
 * `rooms.test.ts` 已經把規則釘死了，這裡要抓的是**只有真的接上去才會出現**
 * 的東西：hello 有沒有真的送、斷線之後共同設定有沒有退回單邊、
 * 兩個 `LinkNode` 誰當中間人。純函式測試對這些一個都看不到。
 */

import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AddressInUseError, LinkBroker } from "../src/broker.js";
import { LinkClient } from "../src/link-client.js";
import type { LinkStatus } from "../src/link-client.js";
import { LinkNode } from "../src/node.js";
import { DEFAULT_PREFS, MOVE_PHASE_TOTAL_SECONDS } from "../src/protocol.js";
import type { AgreedSettings } from "../src/protocol.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** 等到條件成立。輪詢比固定 sleep 穩 —— CI 上的機器慢很多。 */
async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等不到：${what}`);
}

async function broker(): Promise<LinkBroker> {
  // port 0 讓作業系統挑一個沒人用的 —— 固定埠在開發機上會跟真的在跑的插件撞。
  const b = await LinkBroker.listen({ port: 0 });
  cleanups.push(() => b.close());
  return b;
}

interface Spy {
  client: LinkClient;
  status: () => LinkStatus;
  agreed: () => AgreedSettings;
  bothReady: number;
  forced: string[];
}

function client(port: number, room: string, prefs = DEFAULT_PREFS): Spy {
  const spy: Spy = {
    client: null as unknown as LinkClient,
    status: () => spy.client.status,
    agreed: () => spy.client.agreed,
    bothReady: 0,
    forced: [],
  };
  spy.client = new LinkClient({
    endpoint: `ws://127.0.0.1:${port}`,
    room,
    prefs,
    onBothReady: () => spy.bothReady++,
    onForceEnd: (reason) => spy.forced.push(reason),
  });
  spy.client.start();
  cleanups.push(() => spy.client.stop());
  return spy;
}

describe("接上真的 socket", () => {
  it("兩個插件在同一間房會配對，並拿到協商後的秒數", async () => {
    const b = await broker();
    const a = client(b.port, "room-1", { ...DEFAULT_PREFS, phaseSeconds: 10 });
    const c = client(b.port, "room-1", { ...DEFAULT_PREFS, phaseSeconds: 15 });

    await until(() => a.status() === "paired" && c.status() === "paired", "兩邊都配對");
    expect(a.agreed().phaseSeconds).toBe(15);
    expect(c.agreed().phaseSeconds).toBe(15);
  });

  it("⚠ 只有兩邊都按下去才會收到 both-ready", async () => {
    const b = await broker();
    const a = client(b.port, "room-1");
    const c = client(b.port, "room-1");
    await until(() => a.status() === "paired" && c.status() === "paired", "配對");

    a.client.announceReady(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.bothReady).toBe(0);
    expect(c.bothReady).toBe(0);

    c.client.announceReady(true);
    await until(() => a.bothReady === 1 && c.bothReady === 1, "both-ready");
  });

  it("強制結束只會傳給對手", async () => {
    const b = await broker();
    const a = client(b.port, "room-1");
    const c = client(b.port, "room-1");
    await until(() => a.status() === "paired", "配對");

    a.client.announceForceEnd("hazard-cap");
    await until(() => c.forced.length === 1, "對手收到 force-end");
    expect(c.forced).toEqual(["hazard-cap"]);
    expect(a.forced).toEqual([]);
  });

  it("⚠ 對手離線之後秒數立刻退回滿版 —— 單方面縮短是自損", async () => {
    const b = await broker();
    const a = client(b.port, "room-1", { ...DEFAULT_PREFS, phaseSeconds: 10 });
    const c = client(b.port, "room-1", { ...DEFAULT_PREFS, phaseSeconds: 12 });
    await until(() => a.status() === "paired", "配對");
    expect(a.agreed().phaseSeconds).toBe(12);

    c.client.stop();
    await until(() => a.status() === "solo", "退回 solo");
    expect(a.agreed().phaseSeconds).toBe(MOVE_PHASE_TOTAL_SECONDS);
  });

  it("⚠ 中間人掛掉之後客戶端退回單邊，而且會自己重連", async () => {
    const b = await broker();
    const a = client(b.port, "room-1", { ...DEFAULT_PREFS, phaseSeconds: 10 });
    await until(() => a.status() === "solo", "連上");

    await b.close();
    await until(() => a.status() === "offline", "斷線");
    expect(a.agreed().phaseSeconds).toBe(MOVE_PHASE_TOTAL_SECONDS);
  });
});

/**
 * 借一個現在確定綁得上的埠。
 *
 * ⚠ **不要寫死埠號。** 這裡本來寫死 9377，2026-08-16 整個測試就掛了 ——
 * Windows 把 9377–9476 整段保留了（Hyper-V／WSL／Docker 會從動態埠範圍切走
 * 100 埠一段），`LinkBroker.listen()` 綁不上，於是「第一個開的當中間人」變成
 * false。失敗訊息完全看不出跟埠有關，而且換一台機器就好了。
 *
 * 保留範圍是動態的，所以沒有哪個常數是安全的 —— 只能現場問作業系統要一個。
 * 這跟 `cdp-adapter/debug-port.ts` 對遊戲客戶端做的事是同一件。
 */
async function borrowPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("拿不到埠"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("誰當中間人", () => {
  it("第一個開的當中間人，第二個開的當客戶端，兩邊照樣配對得起來", async () => {
    // 這個 case 需要一個**固定**的埠（第二個 node 要撞上第一個），但不需要是
    // 寫死的埠 —— 跟作業系統借一個，見 borrowPort()。
    const port = await borrowPort();
    const target = { kind: "local", port } as const;
    const first = await LinkNode.start({ target, room: "room-1", prefs: DEFAULT_PREFS });
    cleanups.push(() => first.close());
    const second = await LinkNode.start({ target, room: "room-1", prefs: DEFAULT_PREFS });
    cleanups.push(() => second.close());

    expect(first.hosting).toBe(true);
    expect(second.hosting).toBe(false);
    await until(
      () => first.client.status === "paired" && second.client.status === "paired",
      "兩個 node 配對",
    );
  });

  it("埠被佔走時丟的是 AddressInUseError，不是一般錯誤", async () => {
    const b = await LinkBroker.listen({ port: 0 });
    cleanups.push(() => b.close());
    await expect(LinkBroker.listen({ port: b.port })).rejects.toBeInstanceOf(AddressInUseError);
  });
});
