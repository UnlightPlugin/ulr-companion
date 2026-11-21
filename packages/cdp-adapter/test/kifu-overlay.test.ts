/**
 * 遊戲裡的復盤畫面：開之前的兩道關
 * 1. 戰鬥中不開（蓋住畫面會害玩家錯過出牌）
 * 2. 找不到遊戲畫布不開
 * 播放器本體（viewer.js）的畫面用 Electron 截圖驗（見 docs/kifu.md）。
 */

import { describe, expect, it } from "vitest";
import { buildKifuOverlayScript, KIFU_OVERLAY_CLOSE_EXPRESSION } from "@ulr/cdp-adapter";

async function run(
  expr: string,
  window: Record<string, unknown>,
  document: unknown,
): Promise<string> {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "document", `return ${expr};`) as (
    w: unknown,
    d: unknown,
  ) => Promise<string>;
  return await fn(window, document);
}

const script = buildKifuOverlayScript({
  viewerSource: "window.KifuViewer = { create: function () {}, loadTextures: function () {} };",
  data: { replay: { steps: [] }, textures: {}, tables: {}, fonts: {} },
});

describe("遊戲裡的復盤畫面", () => {
  it("戰鬥中（MainA 跑著、連線開著）不開", async () => {
    const window = {
      game: {
        scene: { keys: { MainA: { sys: { settings: { status: 5 } }, socket: { readyState: 1 } } } },
      },
    };
    expect(await run(script, window, { querySelector: () => ({}) })).toBe("in-battle");
  });

  it("打完了（連線關了）才開；沒有遊戲畫布不開", async () => {
    const window = {
      game: {
        scene: { keys: { MainA: { sys: { settings: { status: 5 } }, socket: { readyState: 3 } } } },
      },
    };
    expect(await run(script, window, { querySelector: () => null })).toBe("no-canvas");
  });

  it("沒開著時關掉回 not-open", async () => {
    expect(await run(KIFU_OVERLAY_CLOSE_EXPRESSION, {}, {})).toBe("not-open");
  });
});
