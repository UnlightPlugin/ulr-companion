/**
 * §12 的守門測試。
 *
 * 遊戲分頁的 URL 長這樣：
 *   https://www.playunlight.online:14018/?steamid=765…&token=<36 碼>
 * 也就是**光是印出 URL 就會洩漏帳號憑證**。這些測試存在的目的，是讓任何
 * 「順手把 URL 記進 log」的改動在 CI 就被擋下來。
 */

import { describe, expect, it } from "vitest";
import { redactUrl, summarizeArgs } from "@ulr/cdp-adapter";

describe("redactUrl", () => {
  it("遮掉遊戲 URL 裡的 steamid 與 token，保留看得出是哪個服務的部分", () => {
    const out = redactUrl(
      "https://www.playunlight.online:14018/?steamid=76561199854644708&token=abcdef0123456789&lang=tcn",
    );

    expect(out).not.toContain("76561199854644708");
    expect(out).not.toContain("abcdef0123456789");
    expect(out).toContain("www.playunlight.online:14018");
    expect(out).toContain("lang=tcn"); // 對排查有用的留著
  });

  it("WebSocket debugger URL 的路徑本身就是憑證，整段拿掉", () => {
    const out = redactUrl(
      "ws://127.0.0.1:9333/devtools/browser/03e850e7-8f88-4220-8f52-543f00d22d0f",
    );

    expect(out).not.toContain("03e850e7");
    expect(out).not.toContain("devtools");
    expect(out).toBe("ws://127.0.0.1:9333/***");
  });

  it("拿掉 URL 裡的帳號密碼", () => {
    const out = redactUrl("https://user:hunter2@example.com/x");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("user");
  });

  it("丟掉 fragment —— OAuth 類流程會把 token 放在那裡", () => {
    const out = redactUrl("https://example.com/x#access_token=secret");
    expect(out).not.toContain("secret");
  });

  it("解析不了的字串不原樣吐回去", () => {
    expect(redactUrl("token=這不是一個 URL")).toBe("(已遮蔽)");
    expect(redactUrl("")).toBe("(已遮蔽)");
  });

  it("大小寫不同的敏感鍵一樣要遮", () => {
    expect(redactUrl("https://e.com/?Token=abc&SteamID=123")).not.toContain("abc");
    expect(redactUrl("https://e.com/?Token=abc&SteamID=123")).not.toContain("123");
  });

  it("file:// 的桌面版外殼路徑照樣可讀（那裡沒有憑證）", () => {
    const out = redactUrl("file:///E:/SteamLibrary/steamapps/common/UNLIGHTRevive/index.html");
    expect(out).toContain("UNLIGHTRevive");
  });
});

describe("summarizeArgs", () => {
  it("只留形狀，不留內容 —— args[0] 常常就是 session token", () => {
    const token = "0123456789abcdef0123456789abcdef0123";
    const out = summarizeArgs([token, { chara: "cc078" }, [1, 2, 3], 7, null, true]);

    expect(out.join(" ")).not.toContain(token);
    expect(out.join(" ")).not.toContain("cc078");
    expect(out).toEqual(["string(36)", "object(1 keys)", "array(3)", "number", "null", "boolean"]);
  });

  it("空陣列不會爆", () => {
    expect(summarizeArgs([])).toEqual([]);
  });
});
