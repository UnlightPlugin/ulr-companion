/**
 * 回報遊戲檔名：什麼時候打網路、什麼時候不打
 *
 * 要守的是請求量 —— 同一份清單處理過就不再問，只有「雲端還沒升級」那段時間
 * 才每小時一次。假雲端照 ulr-hash Worker 的回應形狀。
 */

import { describe, expect, it } from "vitest";
import { createBundleReporter, readPushToken, type FetchLike } from "../src/bundle-report.js";

const OLD = ["client/runtime.40ed.js", "client/unlight-common.bbd5.js", "client/main.42c2.js"];
const NEW = ["client/runtime.2d9a.js", "client/unlight-common.bbd5.js", "client/main.42c2.js"];
const HOUR = 60 * 60 * 1000;

function fakeCloud(opts: { current: string[] | null; reportStatus: string }) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (init?.body !== undefined) bodies.push(JSON.parse(init.body));
    if (method === "GET") {
      return opts.current === null
        ? { status: 404, json: async () => ({ error: "empty" }) }
        : { status: 200, json: async () => ({ bundles: opts.current }) };
    }
    return { status: 200, json: async () => ({ status: opts.reportStatus }) };
  };
  return { fetch, calls, bodies };
}

describe("createBundleReporter", () => {
  it("書籤開的頁面（不是伺服器吐的）一次網路都不打", async () => {
    const cloud = fakeCloud({ current: OLD, reportStatus: "pending" });
    const r = createBundleReporter({ fetch: cloud.fetch, read: async () => null });
    expect(await r.tick()).toBe("not-served");
    expect(cloud.calls).toEqual([]);
  });

  it("跟雲端一樣：GET 一次，之後不再問", async () => {
    const cloud = fakeCloud({ current: NEW, reportStatus: "pending" });
    const r = createBundleReporter({ fetch: cloud.fetch, read: async () => NEW });
    expect(await r.tick()).toBe("current");
    expect(await r.tick()).toBe("skip");
    expect(cloud.calls).toEqual(["GET /bundles"]);
  });

  it("雲端是舊的：送上去；pending 一小時內不重送，過了才再送", async () => {
    let t = 1_000_000;
    const lines: string[] = [];
    const cloud = fakeCloud({ current: OLD, reportStatus: "pending" });
    const r = createBundleReporter({
      fetch: cloud.fetch,
      read: async () => NEW,
      now: () => t,
      log: (l) => lines.push(l),
    });
    expect(await r.tick()).toBe("pending");
    expect(cloud.bodies).toEqual([{ bundles: NEW }]);
    t += HOUR - 1;
    expect(await r.tick()).toBe("skip");
    t += 2;
    expect(await r.tick()).toBe("pending");
    expect(cloud.calls).toEqual(["GET /bundles", "POST /report", "GET /bundles", "POST /report"]);
    // 同一種結果只記一行
    expect(lines).toHaveLength(1);
  });

  it("promoted／retired 之後不再送", async () => {
    for (const status of ["promoted", "retired"]) {
      const cloud = fakeCloud({ current: OLD, reportStatus: status });
      let t = 0;
      const r = createBundleReporter({ fetch: cloud.fetch, read: async () => NEW, now: () => t });
      expect(await r.tick()).toBe(status);
      t += 100 * HOUR;
      expect(await r.tick()).toBe("skip");
      expect(cloud.calls).toHaveLength(2);
    }
  });

  it("送出去的只有檔名（沒有 steamid／token）；一般玩家不帶 Authorization", async () => {
    const headers: Record<string, string>[] = [];
    const cloud = fakeCloud({ current: null, reportStatus: "pending" });
    const r = createBundleReporter({
      fetch: (url, init) => {
        if (init?.method === "POST") headers.push(init.headers ?? {});
        return cloud.fetch(url, init);
      },
      read: async () => NEW,
    });
    await r.tick();
    expect(cloud.bodies).toEqual([{ bundles: NEW }]);
    expect(headers[0]).not.toHaveProperty("authorization");
  });

  it("維護者的電腦：帶推送金鑰；讀不到檔就是 null", async () => {
    const headers: Record<string, string>[] = [];
    const cloud = fakeCloud({ current: OLD, reportStatus: "promoted" });
    const r = createBundleReporter({
      fetch: (url, init) => {
        if (init?.method === "POST") headers.push(init.headers ?? {});
        return cloud.fetch(url, init);
      },
      read: async () => NEW,
      token: "secret",
    });
    expect(await r.tick()).toBe("promoted");
    expect(headers[0]?.["authorization"]).toBe("Bearer secret");

    expect(readPushToken("x", () => "  abc\n")).toBe("abc");
    expect(readPushToken("x", () => "")).toBeNull();
    expect(
      readPushToken("x", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("網路壞了：記一行、十五分鐘後再試；讀頁面 throw 當成沒頁面", async () => {
    let t = 0;
    const lines: string[] = [];
    const r = createBundleReporter({
      fetch: async () => {
        throw new Error("offline");
      },
      read: async () => NEW,
      now: () => t,
      log: (l) => lines.push(l),
    });
    expect(await r.tick()).toBe("error");
    expect(lines[0]).toContain("offline");
    expect(await r.tick()).toBe("skip");
    t += 15 * 60 * 1000 + 1;
    expect(await r.tick()).toBe("error");

    const broken = createBundleReporter({
      fetch: fakeCloud({ current: null, reportStatus: "pending" }).fetch,
      read: async () => {
        throw new Error("not connected");
      },
    });
    expect(await broken.tick()).toBe("no-page");
  });
});
