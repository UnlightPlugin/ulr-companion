import { describe, expect, it } from "vitest";
import { pickReloadTarget } from "@ulr/cdp-adapter";

describe("pickReloadTarget", () => {
  it("桌面版：挑 file:// 的外殼，不挑遊戲 iframe", () => {
    expect(
      pickReloadTarget([
        { targetId: "FRAME", type: "iframe", url: "https://www.playunlight.online/client/" },
        { targetId: "SHELL", type: "page", url: "file:///E:/game/index.html" },
      ]),
    ).toBe("SHELL");
  });

  it("網頁版：挑遊戲來源的分頁，不挑玩家開著的別頁", () => {
    expect(
      pickReloadTarget([
        { targetId: "OTHER", type: "page", url: "https://example.com/" },
        { targetId: "GAME", type: "page", url: "https://www.playunlight.online/?x=1" },
      ]),
    ).toBe("GAME");
  });

  it("沒有遊戲頁就回 null（不要隨便重整一頁）", () => {
    expect(
      pickReloadTarget([
        { targetId: "OTHER", type: "page", url: "https://example.com/" },
        { targetId: "DEV", type: "page", url: "devtools://devtools/bundled/inspector.html" },
      ]),
    ).toBeNull();
  });
});
