import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINK_PORT,
  DEFAULT_LINK_TARGET,
  describeTarget,
  endpointOf,
  parseLinkTarget,
  queueCountUrl,
  roomUrl,
} from "../src/target.js";
import { CLOSE_TOO_FAST, CLOSE_WRONG_ROOM } from "../src/protocol.js";
import {
  DEFAULT_RECONNECT_MS,
  reconnectDelayFor,
  THROTTLED_RECONNECT_MS,
} from "../src/link-client.js";

const local = (port = DEFAULT_LINK_PORT) => ({ kind: "local", port }) as const;

describe("中間人在哪", () => {
  it("⚠ 沒填就是**雲端** —— 預設留在本機的話，這個功能對 99% 的人不存在", () => {
    // 本機中間人只配得到同一台電腦上的另一個插件。預設留 local 的話，玩家
    // 裝完永遠是單邊模式，而畫面看起來一切正常（「還沒配到對手」那句話在
    // 對手真的沒裝插件時也是同一句）。
    for (const raw of [undefined, null, "", "   "]) {
      expect(parseLinkTarget(raw)).toEqual({ kind: "remote", endpoint: DEFAULT_LINK_TARGET });
    }
    expect(DEFAULT_LINK_TARGET.startsWith("wss://")).toBe(true);
  });

  it("local 是開發者的逃生口，要明確填才有", () => {
    expect(parseLinkTarget("local")).toEqual(local());
    expect(parseLinkTarget("LOCAL")).toEqual(local());
  });

  it("純數字是本機的那個埠（開發用，也相容舊設定檔的 linkPort）", () => {
    expect(parseLinkTarget("9351")).toEqual(local(9351));
    expect(parseLinkTarget("local:9351")).toEqual(local(9351));
  });

  it("完整網址照用", () => {
    expect(parseLinkTarget("wss://ulr-link.someone.workers.dev")).toEqual({
      kind: "remote",
      endpoint: "wss://ulr-link.someone.workers.dev",
    });
    expect(parseLinkTarget("ws://192.168.1.5:9350")).toEqual({
      kind: "remote",
      endpoint: "ws://192.168.1.5:9350",
    });
  });

  it("http/https 自動換成 ws/wss —— 玩家會直接貼瀏覽器網址", () => {
    expect(parseLinkTarget("https://x.workers.dev")).toEqual({
      kind: "remote",
      endpoint: "wss://x.workers.dev",
    });
    expect(parseLinkTarget("http://x.workers.dev")).toEqual({
      kind: "remote",
      endpoint: "ws://x.workers.dev",
    });
  });

  it("⚠ 裸網域補的是 wss:// 不是 ws://", () => {
    // 補錯的話玩家的側通道會用明文跑在公網上，而且他不會發現。這條通道傳的是
    // 「兩邊都準備好了」——中間有人插手就能操縱勝負。
    expect(parseLinkTarget("x.workers.dev")).toEqual({
      kind: "remote",
      endpoint: "wss://x.workers.dev",
    });
  });

  it("尾巴的斜線要吃掉，否則房間路徑會變成 //r/…", () => {
    expect(parseLinkTarget("wss://x.workers.dev/")).toEqual({
      kind: "remote",
      endpoint: "wss://x.workers.dev",
    });
  });

  it("⚠ 看不懂的東西退回**雲端**，不拋例外", () => {
    // 這一格填錯的代價不該是「插件開不起來」。而退回雲端不是本機：填錯的人
    // 想連的是外面，把他丟回一個只有自己的房間等於安靜地把功能關掉。
    for (const bad of ["ftp://x", "http://", ":::"]) {
      expect(parseLinkTarget(bad), bad).toEqual({ kind: "remote", endpoint: DEFAULT_LINK_TARGET });
    }
    // 純數字仍然是本機（那是開發者的舊用法），但不合法的埠會被夾回預設。
    expect(parseLinkTarget("0")).toEqual(local());
    expect(parseLinkTarget("99999")).toEqual(local());
  });

  it("本機的 endpoint 指回 loopback", () => {
    expect(endpointOf(local(9350))).toBe("ws://127.0.0.1:9350");
    expect(endpointOf({ kind: "remote", endpoint: "wss://x" })).toBe("wss://x");
  });

  it("⚠ 房號在路徑上 —— 雲端靠它決定要交給哪一個 Durable Object", () => {
    expect(roomUrl("wss://x.workers.dev", "0123456789abcdef")).toBe(
      "wss://x.workers.dev/r/0123456789abcdef",
    );
    // 本機 broker 完全不看路徑，所以同一份程式碼兩邊都對。
    expect(roomUrl("ws://127.0.0.1:9350", "abc")).toBe("ws://127.0.0.1:9350/r/abc");
  });

  it("給人看的描述", () => {
    expect(describeTarget(local(9350))).toBe("本機 :9350");
    expect(describeTarget({ kind: "remote", endpoint: "wss://x" })).toBe("wss://x");
  });
});

describe("斷線之後等多久", () => {
  it("⚠ 被限流就要等久一點 —— 兩秒後回去只會再被踢一次", () => {
    // 4008 的意思是「問題出在我這邊」。照一般間隔重連會變成每兩秒敲一次的
    // 迴圈：對伺服器是攻擊，對玩家是側通道永遠不會好。
    expect(reconnectDelayFor(CLOSE_TOO_FAST, DEFAULT_RECONNECT_MS)).toBe(THROTTLED_RECONNECT_MS);
  });

  it("房號對不上就立刻用新網址重連", () => {
    expect(reconnectDelayFor(CLOSE_WRONG_ROOM, DEFAULT_RECONNECT_MS)).toBe(0);
  });

  it("一般斷線用預設間隔", () => {
    expect(reconnectDelayFor(1006, DEFAULT_RECONNECT_MS)).toBe(DEFAULT_RECONNECT_MS);
    expect(reconnectDelayFor(1000, 500)).toBe(500);
  });
});

describe("queueCountUrl", () => {
  const A = "0123456789abcdef";
  const B = "fedcba9876543210";

  it("⚠ 是 http(s) 不是 ws —— endpoint 存的是連線用的位址", () => {
    expect(queueCountUrl("wss://x.workers.dev", { keys: [A] })).toBe(
      "https://x.workers.dev/qn?k=" + A,
    );
    expect(queueCountUrl("ws://127.0.0.1:9350", { keys: [A] })).toBe(
      "http://127.0.0.1:9350/qn?k=" + A,
    );
  });

  it("一次問完所有檔位（一個請求，不是四個）", () => {
    expect(queueCountUrl("wss://x", { keys: [A, B] })).toBe(`https://x/qn?k=${A}&k=${B}`);
  });

  it("⚠ 標籤是一把鍵一個，照順序接在後面", () => {
    // ruleTag 拌過配對鍵，所以同一份規則在不同檔位上是不同的字串 ——
    // 傳一個配四把的話，三檔會永遠數到 0 而且沒有任何錯誤。
    expect(queueCountUrl("wss://x", { keys: [A, B], tags: ["aaaa", "bbbb"] })).toBe(
      `https://x/qn?k=${A}&k=${B}&t=aaaa&t=bbbb`,
    );
  });

  it("舊的陣列寫法還能用（不帶標籤 = 全部都數）", () => {
    expect(queueCountUrl("wss://x", [A])).toBe("https://x/qn?k=" + A);
  });
});
