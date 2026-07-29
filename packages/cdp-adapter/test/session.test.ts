import { describe, expect, it } from "vitest";
import {
  attachToGamePage,
  CdpClient,
  GamePageNotFoundError,
  selectGamePage,
} from "@ulr/cdp-adapter";
import { FakeTransport } from "./fake-transport.js";

/** 桌面版：外殼是 file://…/index.html，遊戲載在它的 iframe 裡。 */
const DESKTOP_SHELL = {
  targetId: "SHELL",
  type: "page",
  url: "file:///E:/SteamLibrary/steamapps/common/UNLIGHTRevive/win-unpacked/resources/app/index.html",
  title: "UNLIGHT:Revive",
};

/** 網頁版：分頁本身就是遊戲網址，帶著 steamid 與 token。 */
const WEB_PAGE = {
  targetId: "WEB",
  type: "page",
  url: "https://www.playunlight.online:14018/?steamid=76561199854644708&token=abcdef0123456789",
  title: "UNLIGHT:Revive",
};

describe("selectGamePage", () => {
  it("桌面版選 file:// 的外殼", () => {
    const picked = selectGamePage([
      { targetId: "OTHER", type: "page", url: "https://example.com/", title: "別人的分頁" },
      DESKTOP_SHELL,
    ]);
    expect(picked?.targetId).toBe("SHELL");
  });

  it("網頁版選那個 https 分頁", () => {
    expect(selectGamePage([WEB_PAGE])?.targetId).toBe("WEB");
  });

  it("選出來的 URL 已經去識別化", () => {
    const picked = selectGamePage([WEB_PAGE]);
    expect(picked?.safeUrl).not.toContain("76561199854644708");
    expect(picked?.safeUrl).not.toContain("abcdef0123456789");
  });

  it("跳過 devtools、擴充功能與空白頁", () => {
    const picked = selectGamePage([
      {
        targetId: "DT",
        type: "page",
        url: "devtools://devtools/bundled/x.html",
        title: "DevTools",
      },
      { targetId: "EXT", type: "page", url: "chrome-extension://abc/popup.html", title: "外掛" },
      { targetId: "BLANK", type: "page", url: "about:blank", title: "" },
      DESKTOP_SHELL,
    ]);
    expect(picked?.targetId).toBe("SHELL");
  });

  it("忽略非 page 的 target（service worker、iframe 之類）", () => {
    const picked = selectGamePage([
      { targetId: "SW", type: "service_worker", url: "https://x/sw.js", title: "" },
      { targetId: "IF", type: "iframe", url: "https://x/", title: "" },
    ]);
    expect(picked).toBeNull();
  });

  it("一個都沒有就回 null", () => {
    expect(selectGamePage([])).toBeNull();
  });
});

describe("attachToGamePage", () => {
  // attachResult 收整個回應物件而不是 sessionId 字串：預設參數碰到明確傳進來
  // 的 undefined 一樣會生效，所以「沒有 sessionId」那個案例用預設值表達不了。
  function clientWith(targetInfos: unknown[], attachResult: unknown = { sessionId: "SESSION-1" }) {
    const t = new FakeTransport();
    t.respond("Target.getTargets", () => ({ targetInfos }));
    t.respond("Target.attachToTarget", () => attachResult);
    return { transport: t, client: new CdpClient(t) };
  }

  it("attach 之後拿到 sessionId，並且用 flatten", async () => {
    const { transport, client } = clientWith([DESKTOP_SHELL]);
    const session = await attachToGamePage(client);

    expect(session.sessionId).toBe("SESSION-1");
    expect(session.targetId).toBe("SHELL");
    const attach = transport.sent.find((m) => m.method === "Target.attachToTarget");
    expect(attach?.params).toMatchObject({ targetId: "SHELL", flatten: true });
  });

  it("找不到遊戲分頁時，錯誤訊息列出候選（且不含 token）", async () => {
    const { client } = clientWith([
      { targetId: "DT", type: "page", url: "devtools://devtools/x.html", title: "DevTools" },
    ]);

    await expect(attachToGamePage(client)).rejects.toBeInstanceOf(GamePageNotFoundError);
    await expect(attachToGamePage(client)).rejects.toThrow("DevTools");
  });

  it("attach 沒回 sessionId 也要明確失敗，不要回一個半殘的物件", async () => {
    const { client } = clientWith([DESKTOP_SHELL], {});
    await expect(attachToGamePage(client)).rejects.toBeInstanceOf(GamePageNotFoundError);
  });
});
