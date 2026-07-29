/**
 * 找遊戲 context 的測試
 * =======================
 * 這一塊有一個容易寫錯又不容易發現的競態：`Runtime.enable` 會把**已經存在**
 * 的 context 用事件補送一次。訂閱掛晚了，接上「已經在跑的遊戲」就一個都收不到，
 * 然後永遠等在那裡 —— 但用剛啟動的遊戲測會過。所以這裡兩種時序都測。
 */

import { describe, expect, it } from "vitest";
import type { CdpClient as CdpClientType } from "@ulr/cdp-adapter";
import {
  CdpClient,
  CdpTimeoutError,
  ExecutionContextTracker,
  findGameContext,
} from "@ulr/cdp-adapter";
import { FakeTransport } from "./fake-transport.js";

const SESSION = "SESSION-1";
const TOP_FRAME = "FRAME-TOP";
const GAME_FRAME = "FRAME-GAME";

/** contextId → 這個 context 裡看不看得到 Phaser / game */
type Worlds = Record<number, { hasPhaser: boolean; hasGame: boolean }>;

function setup(worlds: Worlds): { transport: FakeTransport; client: CdpClientType } {
  const transport = new FakeTransport();
  transport.respond("Page.getFrameTree", () => ({
    frameTree: { frame: { id: TOP_FRAME }, childFrames: [{ frame: { id: GAME_FRAME } }] },
  }));
  transport.respond("Runtime.evaluate", (msg) => {
    const id = msg.params?.["contextId"] as number;
    const world = worlds[id];
    if (world === undefined)
      throw { code: -32000, message: "Cannot find context with specified id" };
    return { result: { value: world } };
  });
  return { transport, client: new CdpClient(transport, { commandTimeoutMs: 1000 }) };
}

function contextCreated(
  transport: FakeTransport,
  id: number,
  frameId: string,
  origin = "https://www.playunlight.online:14018",
): void {
  transport.emitEvent(
    "Runtime.executionContextCreated",
    { context: { id, origin, auxData: { frameId, isDefault: true } } },
    SESSION,
  );
}

describe("findGameContext", () => {
  it("挑有 Phaser 的那個 context，不是頂層", async () => {
    const { transport, client } = setup({
      1: { hasPhaser: false, hasGame: false }, // 頂層外殼
      2: { hasPhaser: true, hasGame: true }, // 遊戲 iframe
    });
    const tracker = new ExecutionContextTracker(client, SESSION);

    contextCreated(transport, 1, TOP_FRAME, "file://");
    contextCreated(transport, 2, GAME_FRAME);

    const ctx = await findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 1000 });
    expect(ctx.contextId).toBe(2);
    expect(ctx.frameId).toBe(GAME_FRAME);
    expect(ctx.gameReady).toBe(true);
  });

  it("context 在開始找之後才出現也接得到（遊戲還在載）", async () => {
    const { transport, client } = setup({ 2: { hasPhaser: true, hasGame: false } });
    const tracker = new ExecutionContextTracker(client, SESSION);

    const pending = findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 2000 });
    setTimeout(() => contextCreated(transport, 2, GAME_FRAME), 20);

    const ctx = await pending;
    expect(ctx.contextId).toBe(2);
    // Phaser 有了但 window.game 還沒建立 —— 這是「還在載」的正常中間狀態
    expect(ctx.gameReady).toBe(false);
  });

  it("Phaser 一直沒出現就逾時，而不是無聲地卡住", async () => {
    const { transport, client } = setup({ 1: { hasPhaser: false, hasGame: false } });
    const tracker = new ExecutionContextTracker(client, SESSION);
    contextCreated(transport, 1, TOP_FRAME);

    await expect(
      findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(CdpTimeoutError);
  });

  it("回傳的 origin 已經去識別化", async () => {
    const { transport, client } = setup({ 2: { hasPhaser: true, hasGame: true } });
    const tracker = new ExecutionContextTracker(client, SESSION);
    contextCreated(
      transport,
      2,
      GAME_FRAME,
      "https://www.playunlight.online:14018/?steamid=76561199854644708&token=abcdef",
    );

    const ctx = await findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 1000 });
    expect(ctx.safeOrigin).not.toContain("76561199854644708");
    expect(ctx.safeOrigin).not.toContain("abcdef");
  });

  it("context 在探測空檔被銷毀時換下一個，不整個失敗", async () => {
    // 只有 3 號答得出來；1 號會回 "Cannot find context with specified id"
    const { transport, client } = setup({ 3: { hasPhaser: true, hasGame: true } });
    const tracker = new ExecutionContextTracker(client, SESSION);
    contextCreated(transport, 1, TOP_FRAME);
    contextCreated(transport, 3, GAME_FRAME);

    const ctx = await findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 1000 });
    expect(ctx.contextId).toBe(3);
  });
});

describe("ExecutionContextTracker", () => {
  it("收 created、destroyed、cleared", () => {
    const { transport, client } = setup({});
    const tracker = new ExecutionContextTracker(client, SESSION);

    contextCreated(transport, 1, TOP_FRAME);
    contextCreated(transport, 2, GAME_FRAME);
    expect(tracker.contexts).toHaveLength(2);

    transport.emitEvent("Runtime.executionContextDestroyed", { executionContextId: 1 }, SESSION);
    expect(tracker.contexts.map((c) => c.contextId)).toEqual([2]);

    // 導航 → 舊的 id 全部作廢，繼續用會拿到 "Cannot find context with specified id"
    transport.emitEvent("Runtime.executionContextsCleared", {}, SESSION);
    expect(tracker.contexts).toHaveLength(0);
  });

  it("不收別的 session 的事件", () => {
    const { transport, client } = setup({});
    const tracker = new ExecutionContextTracker(client, SESSION);

    transport.emitEvent(
      "Runtime.executionContextCreated",
      { context: { id: 9, origin: "", auxData: { frameId: "X", isDefault: true } } },
      "另一個 session",
    );

    expect(tracker.contexts).toHaveLength(0);
  });

  it("isDefault:false 的 isolated world 不算候選", async () => {
    const { transport, client } = setup({ 5: { hasPhaser: true, hasGame: true } });
    const tracker = new ExecutionContextTracker(client, SESSION);

    transport.emitEvent(
      "Runtime.executionContextCreated",
      { context: { id: 5, origin: "", auxData: { frameId: GAME_FRAME, isDefault: false } } },
      SESSION,
    );

    await expect(
      findGameContext(client, tracker, { sessionId: SESSION, timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(CdpTimeoutError);
  });

  it("dispose 之後不再收事件", () => {
    const { transport, client } = setup({});
    const tracker = new ExecutionContextTracker(client, SESSION);
    tracker.dispose();

    contextCreated(transport, 1, TOP_FRAME);
    expect(tracker.contexts).toHaveLength(0);
  });
});
