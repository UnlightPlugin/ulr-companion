/**
 * 桌面版外殼的畫面大小與全螢幕（shell-display.ts）
 *
 * 跟 patch-display 同一套：把產出來的**那一串字**原封不動 `new Function` 起來，
 * 對一個夠像的假外殼跑。假外殼照 2026-09-25 量的：官方視窗外框 776×719、
 * 內容 760×680，iframe `position:absolute; left:-170px; top:0px`，螢幕
 * 3440×1440（工作區 3440×1400）。
 */

import { describe, expect, it } from "vitest";
import {
  buildShellDisplayScript,
  parseShellDisplayStatus,
  SHELL_DISPLAY_RESET_EXPRESSION,
  SHELL_DISPLAY_VERSION,
} from "@ulr/cdp-adapter";
import type { DisplayState } from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";
const FRAME = { w: 16, h: 39 };

type Listener = () => void;

function makeShell() {
  const listeners = new Map<string, Listener[]>();
  const on = (name: string, fn: Listener) =>
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  const off = (name: string, fn: Listener) =>
    listeners.set(
      name,
      (listeners.get(name) ?? []).filter((f) => f !== fn),
    );
  const fire = (name: string) => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn();
  };

  const attrs = new Map<string, string>();
  const iframe = {
    style: { left: "-170px", top: "0px" } as Record<string, string>,
    hasAttribute: (n: string) => attrs.has(n),
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => attrs.set(n, v),
    removeAttribute: (n: string) => attrs.delete(n),
  };

  const resizes: [number, number][] = [];
  const reports: unknown[] = [];
  const win: Record<string, unknown> = {
    innerWidth: 760,
    innerHeight: 680,
    outerWidth: 776,
    outerHeight: 719,
    screenX: 2311,
    screenY: 112,
    screen: {
      width: 3440,
      height: 1440,
      availWidth: 3440,
      availHeight: 1400,
      availLeft: 0,
      availTop: 0,
    },
    resizeTo(w: number, h: number) {
      resizes.push([w, h]);
      win["outerWidth"] = w;
      win["outerHeight"] = h;
      win["innerWidth"] = w - FRAME.w;
      win["innerHeight"] = h - FRAME.h;
    },
    moveTo(x: number, y: number) {
      win["screenX"] = x;
      win["screenY"] = y;
    },
    addEventListener: on,
    removeEventListener: off,
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };

  let saved: Record<string, unknown> = {};
  const doc = {
    fullscreenElement: null as object | null,
    documentElement: {
      style: { zoom: "" } as Record<string, string>,
      requestFullscreen: () => {
        // 瀏覽器：記下原本的視窗、去框（Node 之後再推滿螢幕）
        saved = {
          outerWidth: win["outerWidth"],
          outerHeight: win["outerHeight"],
          innerWidth: win["innerWidth"],
          innerHeight: win["innerHeight"],
        };
        doc.fullscreenElement = doc.documentElement;
        fire("fullscreenchange");
        return Promise.resolve();
      },
    },
    exitFullscreen: () => {
      // Electron 退出時自己把視窗還原成進去前的樣子
      doc.fullscreenElement = null;
      Object.assign(win, saved);
      fire("fullscreenchange");
      return Promise.resolve();
    },
    getElementById: (id: string) => (id === "frame_game" ? iframe : null),
    addEventListener: on,
    removeEventListener: off,
  };
  win["document"] = doc;

  function run(expression: string): string {
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", "setTimeout", `return ${expression};`) as (
      w: Record<string, unknown>,
      t: (cb: () => void) => void,
    ) => string;
    return fn(win, (cb) => cb());
  }

  function apply(state: DisplayState) {
    return parseShellDisplayStatus(run(buildShellDisplayScript({ bindingName: BINDING, state })));
  }

  /** Node 用 Win32 把全螢幕的視窗推滿（window-fill.ts）→ 外殼收到 resize。 */
  function fillScreen() {
    win["innerWidth"] = 3440;
    win["innerHeight"] = 1440;
    fire("resize");
  }

  return { win, doc, iframe, resizes, reports, listeners, run, apply, fillScreen };
}

describe("buildShellDisplayScript — 畫面大小", () => {
  it("×1.5：外殼 zoom 1.5，內容區調成 1140×1020（外框加上量到的框）", () => {
    const s = makeShell();
    const status = s.apply({ render: "auto", size: "x1.5" });
    expect(s.doc.documentElement.style["zoom"]).toBe("1.5");
    expect(s.resizes).toEqual([[1140 + FRAME.w, 1020 + FRAME.h]]);
    expect(status).toMatchObject({
      installed: true,
      version: SHELL_DISPLAY_VERSION,
      size: "x1.5",
      zoom: 1.5,
    });
  });

  it("×1 而且視窗本來就是官方大小：不 resize", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "x1" });
    expect(s.resizes).toEqual([]);
    expect(s.doc.documentElement.style["zoom"]).toBe("");
  });

  it("放大後會跑出工作區右邊 → 往左推回來", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "x1.5" });
    expect(s.win["screenX"]).toBe(3440 - (1140 + FRAME.w));
  });

  it("重複套用不重裝、監聽只掛一份；框只在第一次量（之後視窗是放大的）", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "x1.5" });
    s.apply({ render: "auto", size: "x2" });
    expect(s.listeners.get("resize")).toHaveLength(1);
    expect(s.listeners.get("fullscreenchange")).toHaveLength(1);
    expect(s.resizes.at(-1)).toEqual([1520 + FRAME.w, 1360 + FRAME.h]);
  });
});

describe("buildShellDisplayScript — 全螢幕", () => {
  it("進去：回報 display-fullscreen（Node 推滿），推滿後 zoom 到塞得下、iframe 位移置中", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "x1.5" });
    const status = s.apply({ render: "auto", size: "fullscreen" });
    expect(status.fullscreen).toBe(true);
    expect(s.reports).toContainEqual({ type: "display-fullscreen", active: true, host: "desktop" });

    s.fillScreen();
    const z = Math.min(3440 / 760, 1440 / 680);
    expect(Number(s.doc.documentElement.style["zoom"])).toBeCloseTo(z, 3);
    const dx = Math.floor((3440 / z - 760) / 2);
    expect(s.iframe.style["left"]).toBe(`${-170 + dx}px`);
    expect(s.iframe.style["top"]).toBe("0px");
  });

  it("玩家按 Esc：退回上一個大小、iframe 回官方位置，回報讓配置跟上", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "x1.5" });
    s.apply({ render: "auto", size: "fullscreen" });
    s.fillScreen();

    s.doc.exitFullscreen(); // 不是我們叫的
    expect(s.iframe.style).toEqual({ left: "-170px", top: "0px" });
    expect(s.doc.documentElement.style["zoom"]).toBe("1.5");
    expect([s.win["innerWidth"], s.win["innerHeight"]]).toEqual([1140, 1020]);
    expect(s.reports.at(-1)).toEqual({ type: "display-settings", render: "auto", size: "x1.5" });
  });

  it("全螢幕中選 ×2：等退出完成才調大小，不回報（是玩家自己選的）", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "fullscreen" });
    s.fillScreen();
    const before = s.reports.length;
    s.apply({ render: "auto", size: "x2" });
    expect(s.doc.fullscreenElement).toBeNull();
    expect(s.resizes.at(-1)).toEqual([1520 + FRAME.w, 1360 + FRAME.h]);
    expect(s.reports.slice(before)).toEqual([]);
  });
});

describe("SHELL_DISPLAY_RESET_EXPRESSION", () => {
  it("還原成官方 ×1、拆掉監聽；沒裝過就說沒裝", () => {
    const s = makeShell();
    expect(s.run(SHELL_DISPLAY_RESET_EXPRESSION)).toBe("not-installed");
    s.apply({ render: "auto", size: "x2" });
    expect(s.run(SHELL_DISPLAY_RESET_EXPRESSION)).toBe("ok");
    expect(s.doc.documentElement.style["zoom"]).toBe("");
    expect(s.resizes.at(-1)).toEqual([776, 719]);
    expect(s.listeners.get("resize")).toEqual([]);
    expect(s.win["__ulrShellDisplay"]).toBeUndefined();
  });

  it("全螢幕中拆：退出、iframe 回原位、視窗回 ×1", () => {
    const s = makeShell();
    s.apply({ render: "auto", size: "fullscreen" });
    s.fillScreen();
    s.run(SHELL_DISPLAY_RESET_EXPRESSION);
    expect(s.doc.fullscreenElement).toBeNull();
    expect(s.iframe.style).toEqual({ left: "-170px", top: "0px" });
    expect(s.doc.documentElement.style["zoom"]).toBe("");
    expect([s.win["outerWidth"], s.win["outerHeight"]]).toEqual([776, 719]);
  });
});

describe("parseShellDisplayStatus", () => {
  it("讀不懂就當沒裝", () => {
    expect(parseShellDisplayStatus(undefined).installed).toBe(false);
    expect(parseShellDisplayStatus("not json").installed).toBe(false);
    expect(parseShellDisplayStatus("null").installed).toBe(false);
  });
});
