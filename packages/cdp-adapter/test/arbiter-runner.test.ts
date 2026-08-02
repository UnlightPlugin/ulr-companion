import { describe, expect, it } from "vitest";
import type { ArbiterAction } from "../src/arbitration.js";
import type { PageBridge, PageCommand } from "../src/arbiter-runner.js";
import { ArbiterRunner, commandsFor, translate } from "../src/arbiter-runner.js";
import type { OkPatchReport } from "../src/patch-ok.js";

describe("translate：頁面回報 → 仲裁輸入", () => {
  it("按 OK 與再按一次都對到同一個 press-ok", () => {
    // step() 本來就是 toggle，這一層不需要知道那個規則。
    expect(translate({ type: "ok-intercepted", at: 0 })).toEqual({ type: "press-ok" });
    expect(translate({ type: "ok-pressed-again", at: 0 })).toEqual({ type: "press-ok" });
  });

  it("操作事件帶著去識別化的編號過去", () => {
    expect(
      translate({
        type: "ok-patch-event",
        event: "cardclickedB",
        cardRef: 3,
        clicked: true,
        at: 0,
      }),
    ).toEqual({ type: "game-event", event: "cardclickedB", cardId: 3, clicked: true });
  });

  it("沒有編號的事件不會塞 undefined 進去", () => {
    // exactOptionalPropertyTypes：塞 undefined 跟不塞是兩件事。
    expect(translate({ type: "ok-patch-event", event: "move_select", at: 0 })).toEqual({
      type: "game-event",
      event: "move_select",
    });
  });

  it("其餘回報不影響仲裁", () => {
    for (const r of [
      { type: "ok-released", by: "arbiter", heldMs: 10 },
      { type: "ok-patch-installed", seat: "A" },
      { type: "ok-patch-error", reason: "x" },
    ] as OkPatchReport[]) {
      expect(translate(r)).toBeNull();
    }
  });
});

describe("commandsFor：仲裁動作 → 頁面指令", () => {
  const frame = (f: "0" | "2"): ArbiterAction => ({ type: "set-ok-frame", frame: f });
  const announce = (ready: boolean): ArbiterAction => ({ type: "announce-ready", ready });
  const send: ArbiterAction = { type: "send-ok", reason: "both-ready" };

  it("⚠ 取消時一定要下 cancel，不能只改外觀", () => {
    // 光改外觀的話，被攔下來的呼叫還壓在頁面裡，失效保護時間到就會送出去
    // —— 玩家會莫名其妙被鎖定。
    const cmds = commandsFor([frame("0"), announce(false)]);
    expect(cmds).toContainEqual({ kind: "cancel" });
  });

  it("準備中的 frame 2 要保持可按", () => {
    // 外觀跟鎖定一樣，但必須能再按一次取消（V1 規則 1）。
    expect(commandsFor([frame("2"), announce(true)])).toEqual([
      { kind: "set-frame", frame: "2", interactive: true },
    ]);
  });

  it("真的送出之後才不可按", () => {
    const cmds = commandsFor([frame("2"), announce(true), send]);
    expect(cmds).toEqual([
      { kind: "set-frame", frame: "2", interactive: false },
      { kind: "release" },
    ]);
  });

  it("送出與取消不會同時發生", () => {
    const cmds = commandsFor([frame("2"), announce(true), send]);
    expect(cmds.filter((c) => c.kind === "cancel")).toHaveLength(0);
  });

  it("沒有動作就沒有指令", () => {
    expect(commandsFor([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/** 假頁面：記下所有求值，並讓測試自己餵回報。 */
class FakeBridge implements PageBridge {
  calls: string[] = [];
  seat: string | null = "A";
  remaining: number | null = 30;
  armed = true;
  /** false = 頁面上的 patch 不見了（玩家重載了遊戲）。 */
  installed = true;
  #handlers = new Set<(r: OkPatchReport) => void>();

  evaluate<T>(expression: string): Promise<T> {
    this.calls.push(expression);
    if (expression.includes("tick()")) {
      const beat = this.installed
        ? { remaining: this.remaining, armed: this.armed, seat: this.seat }
        : null;
      return Promise.resolve(beat as T);
    }
    if (expression.includes("seat()")) {
      return Promise.resolve((this.installed ? this.seat : null) as T);
    }
    return Promise.resolve(undefined as T);
  }

  onReport(handler: (r: OkPatchReport) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async emit(report: OkPatchReport): Promise<void> {
    for (const h of [...this.#handlers]) h(report);
    // handler 是 async 的，讓它跑完再回來斷言。
    await new Promise((r) => setTimeout(r, 0));
  }

  ran(kind: string): string[] {
    return this.calls.filter((c) => c.includes(kind));
  }
}

const OPTIONS = { config: { policy: "either" as const, deadlineSeconds: 3 } };

describe("ArbiterRunner", () => {
  it("啟動時讀座位", async () => {
    const bridge = new FakeBridge();
    bridge.seat = "B";
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    runner.stop();
    expect(runner.seat).toBe("B");
  });

  it("座位讀不到就什麼都不做，不用錯的座位判斷敵我", async () => {
    // 用錯座位會把自己的動作判成對手的 —— 寧可不動作。
    const bridge = new FakeBridge();
    bridge.seat = null;
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    runner.stop();
    expect(runner.state.ready).toBe(false);
    expect(bridge.ran("release")).toHaveLength(0);
  });

  it("裝上去之後才拿到座位也算數", async () => {
    const bridge = new FakeBridge();
    bridge.seat = null;
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({ type: "ok-patch-installed", seat: "B", armed: true });
    runner.stop();
    expect(runner.seat).toBe("B");
  });

  it("⚠ 換場（rearmed）要把座位與場上的牌整組丟掉", async () => {
    // socket 每場換一顆，座位每場重新分配。沿用舊的症狀是「對手動作不取消
    // 準備、自己動作反而取消」—— 完全不像座位問題（2026-08-03 找到成因）。
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS); // 我方是 A
    await runner.start();
    await bridge.emit({
      type: "ok-patch-event",
      event: "cardclickedA",
      cardRef: 7,
      clicked: true,
      at: 0,
    });
    expect(runner.state.played.A.has(7)).toBe(true);

    await bridge.emit({ type: "ok-patch-rearmed", seat: "B" });
    runner.stop();

    expect(runner.seat).toBe("B");
    expect(runner.state.played.A.size).toBe(0);
    expect(runner.state.ready).toBe(false);
  });

  it("座位換了要跟上 —— A 與 B 兩邊都得成立", async () => {
    // 實測：同兩個客戶端連打兩場，:9334 的 MainA.PLAYER 從 B 變成 A。
    // 換房時 socket 比 MainA 早一步換好，rearmed 當下讀到的可能還是上一場的。
    const bridge = new FakeBridge();
    bridge.seat = "A";
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    expect(runner.seat).toBe("A");

    bridge.seat = "B";
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();

    expect(runner.seat).toBe("B");
  });

  it("⚠ 但準備中途不可以換座位 —— 敵我會當場反過來", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    expect(runner.state.ready).toBe(true);

    bridge.seat = "B";
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();

    expect(runner.seat).toBe("A");
  });

  it("⚠ 心跳每個 tick 都要送，不能只在準備中才送", async () => {
    // 頁面靠心跳判斷「還有沒有人在管」，過期就停止攔截。只在 ready 時送的話，
    // 玩家還沒按 OK 的期間頁面會判定我們死了 —— 第一次按下去根本不會被攔。
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    expect(runner.state.ready).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();

    expect(bridge.ran("tick()").length).toBeGreaterThan(0);
  });

  it("patch 不見了要講出來，不能靜靜地不動作", async () => {
    // 玩家重載遊戲之後 window.__ulrArbiter 就沒了。沒有訊息的話，症狀會是
    // 「按 OK 完全沒反應」，而那看起來像邏輯壞掉。
    const errors: string[] = [];
    const bridge = new FakeBridge();
    bridge.installed = false;
    const runner = new ArbiterRunner(bridge, {
      ...OPTIONS,
      tickIntervalMs: 5,
      onError: (e) => errors.push(e.message),
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();

    expect(errors.some((m) => m.includes("重載"))).toBe(true);
    // 同一個錯不會每秒刷四次
    expect(errors).toHaveLength(1);
    expect(runner.armed).toBe(false);
  });

  it("按 OK 進入準備，並保持可按", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    runner.stop();

    expect(runner.state.ready).toBe(true);
    expect(bridge.ran("setOkFrame")).toEqual(['window.__ulrArbiter.setOkFrame("2", true)']);
    expect(bridge.ran("release")).toHaveLength(0);
  });

  it("再按一次 → 取消，並叫頁面丟掉攔到的呼叫", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    await bridge.emit({ type: "ok-pressed-again", at: 1 });
    runner.stop();

    expect(runner.state.ready).toBe(false);
    expect(bridge.ran("cancel")).toHaveLength(1);
  });

  it("對手動作取消準備", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS); // 我方是 A
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    await bridge.emit({
      type: "ok-patch-event",
      event: "cardclickedB",
      cardRef: 1,
      clicked: true,
      at: 1,
    });
    runner.stop();

    expect(runner.state.ready).toBe(false);
    expect(bridge.ran("cancel")).toHaveLength(1);
  });

  it("時間到硬底線 → 放行", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });

    bridge.remaining = 2.5;
    await new Promise((r) => setTimeout(r, 40));
    runner.stop();

    expect(runner.state.committed).toBe(true);
    expect(bridge.ran("release")).toHaveLength(1);
  });

  it("⚠ 換一場對戰要重讀座位，不能用快取的", async () => {
    // 座位每場重新分配，實測同兩個帳號連打兩場會對調。用舊座位的症狀是
    // 「對手動作不取消準備、自己動作反而取消」—— 完全不像座位問題。
    const bridge = new FakeBridge();
    bridge.seat = "A";
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    expect(runner.seat).toBe("A");

    // 換房，座位對調
    bridge.seat = "B";
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    expect(runner.seat).toBe("B");

    // 現在 cardclickedA 才是對手
    await bridge.emit({
      type: "ok-patch-event",
      event: "cardclickedA",
      cardRef: 1,
      clicked: true,
      at: 1,
    });
    runner.stop();
    expect(runner.state.ready).toBe(false);
  });

  it("換場時場上的牌也要清掉", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({
      type: "ok-patch-event",
      event: "cardclickedA",
      cardRef: 7,
      clicked: true,
      at: 0,
    });
    expect(runner.state.played.A.has(7)).toBe(true);

    bridge.seat = "B";
    await bridge.emit({ type: "ok-intercepted", at: 1 });
    runner.stop();
    expect(runner.state.played.A.has(7)).toBe(false);
  });

  it("⚠ 送出之後要重置，否則整場剩下的階段都不再仲裁", async () => {
    // 2026-08-02 實測踩到：committed 卡在 true，第一次按 OK 之後就再也沒
    // 反應，而且完全沒有錯誤訊息。
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    bridge.remaining = 2;
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.state.committed).toBe(true);

    // 頁面回報送出去了 → 下一個階段要能重新開始
    await bridge.emit({ type: "ok-released", by: "arbiter", heldMs: 100 });
    expect(runner.state.committed).toBe(false);
    expect(runner.state.ready).toBe(false);

    await bridge.emit({ type: "ok-intercepted", at: 1 });
    runner.stop();
    expect(runner.state.ready).toBe(true);
  });

  it("失效保護那條路也會重置", async () => {
    // 它不經過 Node，但頁面照樣回報 released。
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, OPTIONS);
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    await bridge.emit({ type: "ok-released", by: "failsafe", heldMs: 25000 });
    runner.stop();
    expect(runner.state.ready).toBe(false);
  });

  it("沒在準備時不去問剩餘秒數", async () => {
    // 每秒四次的 CDP 往返，沒事就別問。
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    await new Promise((r) => setTimeout(r, 40));
    runner.stop();
    expect(bridge.ran("remaining")).toHaveLength(0);
  });

  it("stop 之後不再輪詢", async () => {
    const bridge = new FakeBridge();
    const runner = new ArbiterRunner(bridge, { ...OPTIONS, tickIntervalMs: 5 });
    await runner.start();
    await bridge.emit({ type: "ok-intercepted", at: 0 });
    runner.stop();
    const before = bridge.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.calls.length).toBe(before);
  });
});

describe("PageCommand 的型別涵蓋", () => {
  it("三種指令都有處理", () => {
    // 加了新的 kind 卻忘記在 #run 裡處理的話，這個 switch 會漏 —— 用窮舉
    // 斷言把它釘住。
    const kinds: PageCommand["kind"][] = ["release", "cancel", "set-frame"];
    expect(new Set(kinds).size).toBe(3);
  });
});
