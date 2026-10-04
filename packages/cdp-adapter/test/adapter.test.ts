import { describe, expect, it } from "vitest";
import type { CostPatchReport, DeckEditReport } from "@ulr/cdp-adapter";
import { createCdpAdapter, NotConnectedError, REPORT_BINDING_NAME } from "@ulr/cdp-adapter";
import { FakeTransport } from "./fake-transport.js";

const SESSION = "SESSION-1";

function fakeGame(): FakeTransport {
  return new FakeTransport()
    .respond("Target.getTargets", () => ({
      targetInfos: [
        {
          targetId: "SHELL",
          type: "page",
          url: "file:///E:/game/index.html",
          title: "UNLIGHT:Revive",
        },
      ],
    }))
    .respond("Target.attachToTarget", () => ({ sessionId: SESSION }))
    .respond("Page.enable", () => ({}))
    .respond("Runtime.enable", () => ({}))
    .respond("Runtime.addBinding", () => ({}))
    .respond("Page.addScriptToEvaluateOnNewDocument", () => ({ identifier: "SCRIPT-1" }))
    .respond("Page.removeScriptToEvaluateOnNewDocument", () => ({}))
    .respond("Page.reload", () => ({}));
}

async function connected(transport: FakeTransport) {
  const adapter = createCdpAdapter({
    transportFactory: () => Promise.resolve(transport),
    commandTimeoutMs: 1000,
  });
  await adapter.connect();
  return adapter;
}

describe("CdpAdapter", () => {
  it("connect 之後開好 Page/Runtime 並建立回報用的 binding", async () => {
    const t = fakeGame();
    const adapter = await connected(t);

    const methods = t.sent.map((m) => m.method);
    expect(methods).toContain("Page.enable");
    expect(methods).toContain("Runtime.enable");

    const binding = t.sent.find((m) => m.method === "Runtime.addBinding");
    expect(binding?.params).toEqual({ name: REPORT_BINDING_NAME });
    // 不指定 executionContextId → 之後才建立的 iframe 也吃得到
    expect(binding?.params).not.toHaveProperty("executionContextId");

    // 所有頁面層級的命令都要帶 sessionId，否則會打到瀏覽器層級
    for (const m of t.sent.filter((x) => x.method.startsWith("Page."))) {
      expect(m.sessionId).toBe(SESSION);
    }
    expect(adapter.session?.targetId).toBe("SHELL");
  });

  it("attach 的 target 消失（detachedFromTarget）也算斷線 —— WebSocket 還連著", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    const reasons: string[] = [];
    adapter.onDisconnect((r) => reasons.push(r));

    t.emitEvent("Target.detachedFromTarget", { sessionId: "別人的" });
    expect(reasons).toHaveLength(0);
    t.emitEvent("Target.detachedFromTarget", { sessionId: SESSION });
    expect(reasons).toHaveLength(1);
  });

  it("Runtime.enable 之前就要開始追 context —— 補送的事件不能漏掉", async () => {
    const t = fakeGame();
    await connected(t);

    // connect() 送出的順序：attach → (建 tracker) → Page.enable → Runtime.enable
    const methods = t.sent.map((m) => m.method);
    expect(methods.indexOf("Target.attachToTarget")).toBeLessThan(
      methods.indexOf("Runtime.enable"),
    );
  });

  it("installCostOverrides 回傳 identifier，而且明講要等下次載入", async () => {
    const t = fakeGame();
    const adapter = await connected(t);

    const result = await adapter.installCostOverrides({ cc078_04: 30 });

    expect(result).toEqual({ scriptIdentifier: "SCRIPT-1", takesEffectOnNextLoad: true });
    const injected = t.sent.find((m) => m.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(String(injected?.params?.["source"])).toContain("cc078_04");
  });

  it("裝規則不會自己 reload 遊戲 —— 玩家可能正在打", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    await adapter.installCostOverrides({ cc078_04: 30 });

    expect(t.sent.map((m) => m.method)).not.toContain("Page.reload");

    // 要 reload 是呼叫端明確的決定
    await adapter.reloadGame();
    expect(t.sent.map((m) => m.method)).toContain("Page.reload");
  });

  it("把頁面的回報轉給訂閱者", async () => {
    const t = fakeGame();
    const adapter = await connected(t);

    const seen: CostPatchReport[] = [];
    adapter.onCostPatchReport((r) => seen.push(r));

    t.emitEvent(
      "Runtime.bindingCalled",
      {
        name: REPORT_BINDING_NAME,
        payload: JSON.stringify({
          type: "cost-patch",
          assetKey: "cc_asset",
          totalFrames: 3,
          applied: 2,
          unknownKeys: [],
          index: ["cc001_01", "cc078_04", "cc078_r04"],
        }),
      },
      SESSION,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "cost-patch", applied: 2 });
  });

  it("忽略別人的 binding 與壞掉的 payload，不整個倒掉", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    const seen: CostPatchReport[] = [];
    adapter.onCostPatchReport((r) => seen.push(r));

    t.emitEvent("Runtime.bindingCalled", { name: "別人的binding", payload: "{}" }, SESSION);
    t.emitEvent(
      "Runtime.bindingCalled",
      { name: REPORT_BINDING_NAME, payload: "不是JSON" },
      SESSION,
    );
    t.emitEvent(
      "Runtime.bindingCalled",
      { name: REPORT_BINDING_NAME, payload: '{"type":"別的東西"}' },
      SESSION,
    );

    expect(seen).toHaveLength(0);
  });

  it("取消訂閱之後就收不到了", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    const seen: CostPatchReport[] = [];
    const off = adapter.onCostPatchReport((r) => seen.push(r));
    off();

    t.emitEvent(
      "Runtime.bindingCalled",
      { name: REPORT_BINDING_NAME, payload: '{"type":"cost-patch-installed"}' },
      SESSION,
    );

    expect(seen).toHaveLength(0);
  });

  it("牌組編輯畫面的回報走同一個 binding，用 type 分流", async () => {
    const t = fakeGame();
    const adapter = await connected(t);

    const decks: DeckEditReport[] = [];
    const costs: CostPatchReport[] = [];
    adapter.onDeckEditReport((r) => decks.push(r));
    adapter.onCostPatchReport((r) => costs.push(r));

    t.emitEvent(
      "Runtime.bindingCalled",
      { name: REPORT_BINDING_NAME, payload: '{"type":"deck-select","id":"d1"}' },
      SESSION,
    );

    expect(decks).toHaveLength(1);
    expect(decks[0]).toMatchObject({ type: "deck-select", id: "d1" });
    // ⚠ 分流不能外溢：同一個 binding 上還有 COST、罰則、大廳那幾種。
    expect(costs).toHaveLength(0);
  });

  it("還沒 connect 就呼叫要明確報錯", async () => {
    const adapter = createCdpAdapter();
    await expect(adapter.installCostOverrides({})).rejects.toBeInstanceOf(NotConnectedError);
    await expect(adapter.evaluate("1")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(adapter.reloadGame()).rejects.toBeInstanceOf(NotConnectedError);
    expect(adapter.connected).toBe(false);
  });

  it("disconnect 之後 connected 變 false", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    expect(adapter.connected).toBe(true);
    await adapter.disconnect();
    expect(adapter.connected).toBe(false);
  });
});

describe("CdpAdapter — 桌面版外殼（2026-09-23 起遊戲是 out-of-process iframe）", () => {
  const FRAME_SESSION = "FRAME-SESSION";
  const SHELL_SESSION = "SHELL-SESSION";

  function fakeDesktop(): FakeTransport {
    return fakeGame()
      .respond("Target.getTargets", () => ({
        targetInfos: [
          {
            targetId: "SHELL",
            type: "page",
            url: "file:///E:/game/index.html",
            title: "UNLIGHT: Revive",
          },
          {
            targetId: "FRAME",
            type: "iframe",
            url: "https://www.playunlight.online/?x=1",
            title: "",
          },
        ],
      }))
      .respond("Target.attachToTarget", (m) => ({
        sessionId: m.params?.["targetId"] === "SHELL" ? SHELL_SESSION : FRAME_SESSION,
      }))
      .respond("Runtime.evaluate", () => ({
        result: { value: JSON.stringify({ installed: true, version: 1, size: "x1.5", zoom: 1.5 }) },
      }));
  }

  it("畫面大小對外殼下：第一次才 attach，帶 userGesture，binding 也掛上", async () => {
    const t = fakeDesktop();
    const adapter = await connected(t);
    expect(adapter.hasShell).toBe(true);

    const status = await adapter.applyShellDisplay({ render: "auto", size: "x1.5" });
    await adapter.applyShellDisplay({ render: "auto", size: "x1.5" });

    expect(status).toMatchObject({ installed: true, size: "x1.5", zoom: 1.5 });
    const attaches = t.sent.filter((m) => m.method === "Target.attachToTarget");
    expect(attaches.map((m) => m.params?.["targetId"])).toEqual(["FRAME", "SHELL"]);
    const bindings = t.sent.filter((m) => m.method === "Runtime.addBinding");
    expect(bindings.map((m) => m.sessionId)).toEqual([FRAME_SESSION, SHELL_SESSION]);
    const evals = t.sent.filter((m) => m.method === "Runtime.evaluate");
    expect(evals).toHaveLength(2);
    for (const e of evals) {
      expect(e.sessionId).toBe(SHELL_SESSION);
      expect(e.params?.["userGesture"]).toBe(true);
    }
  });

  it("外殼的回報（Esc 退出全螢幕）也送到訂閱者；別的 session 的不收", async () => {
    const t = fakeDesktop();
    const adapter = await connected(t);
    const seen: unknown[] = [];
    adapter.onDisplaySettings((r) => seen.push(r));
    const payload = JSON.stringify({ type: "display-settings", render: "auto", size: "x1.5" });

    t.emitEvent("Runtime.bindingCalled", { name: REPORT_BINDING_NAME, payload }, SHELL_SESSION);
    expect(seen).toHaveLength(0); // 還沒 attach 外殼

    await adapter.applyShellDisplay({ render: "auto", size: "fullscreen" });
    t.emitEvent("Runtime.bindingCalled", { name: REPORT_BINDING_NAME, payload }, SHELL_SESSION);
    t.emitEvent("Runtime.bindingCalled", { name: REPORT_BINDING_NAME, payload }, "別人的");
    expect(seen).toEqual([{ type: "display-settings", render: "auto", size: "x1.5" }]);
  });

  it("外殼 session 消失不算斷線，下次用時重新 attach", async () => {
    const t = fakeDesktop();
    const adapter = await connected(t);
    const reasons: string[] = [];
    adapter.onDisconnect((r) => reasons.push(r));
    await adapter.applyShellDisplay({ render: "auto", size: "x1" });

    t.emitEvent("Target.detachedFromTarget", { sessionId: SHELL_SESSION });
    expect(reasons).toHaveLength(0);
    await adapter.applyShellDisplay({ render: "auto", size: "x1" });
    expect(t.sent.filter((m) => m.method === "Target.attachToTarget")).toHaveLength(3);
  });

  it("網頁版沒有外殼：什麼都不送", async () => {
    const t = fakeGame();
    const adapter = await connected(t);
    const before = t.sent.length;
    expect(adapter.hasShell).toBe(false);
    expect(await adapter.applyShellDisplay({ render: "auto", size: "x2" })).toBeNull();
    expect(await adapter.resetShellDisplay()).toBe("not-installed");
    expect(t.sent.length).toBe(before);
  });
});

describe("CdpAdapter — 桌面版重載的空檔（只挑得到外殼）", () => {
  function shellOnly(): FakeTransport {
    return fakeGame()
      .respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "TOP" } } }))
      .respond("Target.setDiscoverTargets", () => ({}));
  }

  it("等 Phaser 的時候遊戲 iframe 冒出來 → 丟 GameFrameAppearedError，不空等到逾時", async () => {
    const t = shellOnly();
    const adapter = await connected(t);
    const waiting = adapter.waitForGame(5000);
    const outcome = waiting.then(
      () => "found",
      (err: unknown) => (err as Error).name,
    );

    // 剛建立時網址是空的 —— 還不能算
    t.emitEvent("Target.targetCreated", { targetInfo: { type: "iframe", url: "" } });
    t.emitEvent("Target.targetInfoChanged", {
      targetInfo: { type: "iframe", url: "https://www.playunlight.online/?x=1" },
    });

    expect(await outcome).toBe("GameFrameAppearedError");
    const discover = t.sent.filter((m) => m.method === "Target.setDiscoverTargets");
    expect(discover.map((m) => m.params?.["discover"])).toEqual([true, false]);
  });

  it("畫面大小不等遊戲，直接對接到的外殼套（帶 userGesture）", async () => {
    const t = shellOnly().respond("Runtime.evaluate", () => ({
      result: { value: JSON.stringify({ installed: true, version: 1, size: "x1.5", zoom: 1.5 }) },
    }));
    const adapter = await connected(t);

    const status = await adapter.applyDisplayToAttachedShell({ render: "auto", size: "x1.5" });

    expect(status).toMatchObject({ installed: true, size: "x1.5", zoom: 1.5 });
    const evals = t.sent.filter((m) => m.method === "Runtime.evaluate");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.sessionId).toBe(SESSION);
    expect(evals[0]?.params?.["userGesture"]).toBe(true);
    expect(evals[0]?.params).not.toHaveProperty("contextId");
  });

  it("接到的是遊戲 iframe（或網頁版）就不套", async () => {
    const t = fakeGame().respond("Target.getTargets", () => ({
      targetInfos: [
        { targetId: "SHELL", type: "page", url: "file:///E:/game/index.html" },
        { targetId: "FRAME", type: "iframe", url: "https://www.playunlight.online/?x=1" },
      ],
    }));
    const adapter = await connected(t);
    expect(await adapter.applyDisplayToAttachedShell({ render: "auto", size: "x2" })).toBeNull();
    expect(t.sent.some((m) => m.method === "Runtime.evaluate")).toBe(false);
  });

  it("別的 iframe 不算；舊客戶端照樣在外殼裡等", async () => {
    const t = shellOnly();
    const adapter = await connected(t);
    const waiting = adapter.waitForGame(80);
    t.emitEvent("Target.targetCreated", {
      targetInfo: { type: "iframe", url: "https://example.com/ad" },
    });
    await expect(waiting).rejects.toThrow(/Phaser/);
  });
});
