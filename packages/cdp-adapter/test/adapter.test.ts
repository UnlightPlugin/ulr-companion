import { describe, expect, it } from "vitest";
import type { CostPatchReport } from "@ulr/cdp-adapter";
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
