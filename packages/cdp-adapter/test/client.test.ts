import { describe, expect, it } from "vitest";
import {
  CdpClient,
  CdpConnectionClosedError,
  CdpProtocolError,
  CdpTimeoutError,
} from "@ulr/cdp-adapter";
import { FakeTransport } from "./fake-transport.js";

describe("CdpClient", () => {
  it("把回應對回正確的那一則命令", async () => {
    const t = new FakeTransport();
    t.respond("Runtime.evaluate", (msg) => ({ echo: msg.params?.["expression"] }));
    const client = new CdpClient(t);

    // 同時送三則，回應可能亂序 —— 靠 id 對應而不是順序。
    const [a, b, c] = await Promise.all([
      client.send<{ echo: string }>("Runtime.evaluate", { expression: "a" }),
      client.send<{ echo: string }>("Runtime.evaluate", { expression: "b" }),
      client.send<{ echo: string }>("Runtime.evaluate", { expression: "c" }),
    ]);

    expect([a.echo, b.echo, c.echo]).toEqual(["a", "b", "c"]);
    expect(t.sent.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("回應亂序到達也對得起來", async () => {
    const t = new FakeTransport();
    const client = new CdpClient(t);

    const first = client.send<{ n: number }>("A");
    const second = client.send<{ n: number }>("B");

    // 故意先回第二則
    t.emitResponse(2, { n: 2 });
    t.emitResponse(1, { n: 1 });

    expect((await first).n).toBe(1);
    expect((await second).n).toBe(2);
  });

  it("帶 sessionId 出去", async () => {
    const t = new FakeTransport();
    t.respond("Page.enable", () => ({}));
    const client = new CdpClient(t);

    await client.send("Page.enable", undefined, "SESSION-1");

    expect(t.sent[0]?.sessionId).toBe("SESSION-1");
  });

  it("error 回應轉成 CdpProtocolError，保留錯誤碼", async () => {
    const t = new FakeTransport();
    const client = new CdpClient(t);
    const pending = client.send("Runtime.evaluate");
    t.emitError(1, -32000, "Cannot find context with specified id");

    await expect(pending).rejects.toBeInstanceOf(CdpProtocolError);
    await expect(pending).rejects.toMatchObject({ code: -32000, method: "Runtime.evaluate" });
  });

  it("連線斷掉時，所有還在等的命令都要 reject —— 不能無限期掛著", async () => {
    const t = new FakeTransport();
    const client = new CdpClient(t);
    const a = client.send("A");
    const b = client.send("B");

    t.dropConnection("遊戲被關掉了");

    await expect(a).rejects.toBeInstanceOf(CdpConnectionClosedError);
    await expect(b).rejects.toThrow("遊戲被關掉了");
    expect(client.closed).toBe(true);
  });

  it("斷線之後再送就直接拒絕", async () => {
    const t = new FakeTransport();
    const client = new CdpClient(t);
    t.dropConnection("斷了");
    await expect(client.send("A")).rejects.toBeInstanceOf(CdpConnectionClosedError);
  });

  it("沒人回應就逾時", async () => {
    const t = new FakeTransport(); // 沒設 responder
    const client = new CdpClient(t, { commandTimeoutMs: 10 });
    await expect(client.send("Runtime.evaluate")).rejects.toBeInstanceOf(CdpTimeoutError);
  });

  it("不是 JSON 的訊息直接忽略，不能弄倒整條連線", async () => {
    const t = new FakeTransport();
    t.respond("A", () => ({ ok: true }));
    const client = new CdpClient(t);

    t.emitRaw("這不是 JSON");
    t.emitRaw("");

    await expect(client.send<{ ok: boolean }>("A")).resolves.toEqual({ ok: true });
  });

  describe("事件", () => {
    it("派送給訂閱者，回傳的函式可以取消訂閱", () => {
      const t = new FakeTransport();
      const client = new CdpClient(t);
      const seen: unknown[] = [];

      const off = client.on("Runtime.bindingCalled", (params) => seen.push(params["payload"]));
      t.emitEvent("Runtime.bindingCalled", { payload: "one" });
      off();
      t.emitEvent("Runtime.bindingCalled", { payload: "two" });

      expect(seen).toEqual(["one"]);
    });

    it("某個訂閱者拋例外，其他人照收", () => {
      const t = new FakeTransport();
      const client = new CdpClient(t);
      const seen: string[] = [];

      client.on("E", () => {
        throw new Error("我壞了");
      });
      client.on("E", () => seen.push("第二個還是有收到"));

      expect(() => t.emitEvent("E", {})).not.toThrow();
      expect(seen).toHaveLength(1);
    });

    it("handler 內部取消訂閱不會漏掉後面的 handler", () => {
      // 直接迭代原本的 Set 會踩到這個 —— waitFor 就是在 handler 裡取消自己。
      const t = new FakeTransport();
      const client = new CdpClient(t);
      const seen: string[] = [];

      const off = client.on("E", () => {
        off();
        seen.push("first");
      });
      client.on("E", () => seen.push("second"));

      t.emitEvent("E", {});
      expect(seen).toEqual(["first", "second"]);
    });

    it("waitFor 會等到條件成立的那一則", async () => {
      const t = new FakeTransport();
      const client = new CdpClient(t);

      const pending = client.waitFor("E", (p) => p["want"] === true, 1000);
      t.emitEvent("E", { want: false });
      t.emitEvent("E", { want: true, tag: "命中" });

      await expect(pending).resolves.toMatchObject({ tag: "命中" });
    });

    it("waitFor 等不到會逾時", async () => {
      const t = new FakeTransport();
      const client = new CdpClient(t);
      await expect(client.waitFor("E", () => true, 10)).rejects.toBeInstanceOf(CdpTimeoutError);
    });
  });
});
