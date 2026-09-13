/**
 * 畫面設定（解析度／畫面大小）＋ Option 的 plugin 分頁
 *
 * 跟 `patch-cost-toggle` 同一套：搭一個夠像的假遊戲，把
 * `buildDisplayPatchScript()` 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-13 從跑著的客戶端量的：Phaser 3.87 WebGL、canvas 760×680、
 * `devicePixelRatio` 1.5、renderer 用邏輯尺寸算 viewport／scissor；three.js 的
 * 骰子會對同一個 canvas `setSize(760, 680)`。
 *
 * 這支要抓的坑：
 *
 * 1. 只放大「畫到螢幕」的那層：framebuffer 綁著時 viewport 不縮放
 * 2. `canvas.width` 被三方（three.js）設回 760 時倍率要跟著活（不是存死的數字）
 * 3. 小字的 resolution 在 `renderWebGL` 前排隊、`postrender` 才套，關掉要還原
 * 4. game 建好之後**沒有輪詢**（timer 要停）
 * 5. 拆掉要把 gl／canvas 的屬性全部還原，不留孤兒
 */

import { describe, expect, it } from "vitest";
import {
  buildDisplayPatchScript,
  buildDisplayStateExpression,
  DISPLAY_SCRIPT_VERSION,
  DISPLAY_STATUS_EXPRESSION,
  DISPLAY_UNINSTALL_EXPRESSION,
  isDisplayFullscreenReport,
  isDisplaySettingsReport,
  isDisplayWindowReport,
  parseDisplayStatus,
  parseWindowFillOutput,
  planBrowserWindow,
  sameSize,
} from "@ulr/cdp-adapter";
import type { DisplayState, DisplayWindowReport } from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

// ---------------------------------------------------------------------------
// 假的 GL／canvas
// ---------------------------------------------------------------------------

class FakeCanvasProto {
  _w = 760;
  _h = 680;
  style: Record<string, string> = {};
  get width(): number {
    return this._w;
  }
  set width(v: number) {
    this._w = v;
  }
  get height(): number {
    return this._h;
  }
  set height(v: number) {
    this._h = v;
  }
  getBoundingClientRect() {
    return { width: 760, height: 680 };
  }
}

class FakeGLProto {
  FRAMEBUFFER = 0x8d40;
  FRAMEBUFFER_BINDING = 0x8ca6;
  VIEWPORT = 0x0ba2;
  SCISSOR_BOX = 0x0c10;
  canvas: FakeCanvasProto;
  calls: { name: string; args: number[] }[] = [];
  bound: object | null = null;
  vp: number[];
  sc: number[];
  constructor(canvas: FakeCanvasProto) {
    this.canvas = canvas;
    this.vp = [0, 0, canvas._w, canvas._h];
    this.sc = [0, 0, canvas._w, canvas._h];
  }
  get drawingBufferWidth(): number {
    return this.canvas._w;
  }
  get drawingBufferHeight(): number {
    return this.canvas._h;
  }
  getParameter(p: number): object | null {
    if (p === this.VIEWPORT) return Int32Array.from(this.vp);
    if (p === this.SCISSOR_BOX) return Int32Array.from(this.sc);
    return this.bound;
  }
  bindFramebuffer(_t: number, fb: object | null): void {
    this.bound = fb;
  }
  viewport(x: number, y: number, w: number, h: number): void {
    this.vp = [x, y, w, h];
    this.calls.push({ name: "viewport", args: [x, y, w, h] });
  }
  scissor(x: number, y: number, w: number, h: number): void {
    this.sc = [x, y, w, h];
    this.calls.push({ name: "scissor", args: [x, y, w, h] });
  }
}

// ---------------------------------------------------------------------------
// 假的 Phaser
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class Emitter {
  handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler): this {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  off(name: string, fn: Handler): this {
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((h) => h !== fn),
    );
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  count(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

/**
 * 每個 harness 各建一個文字類別 —— 腳本會**包住原型上的 `renderWebGL`**，
 * 類別跨測試共用的話，前一個測試包過的原型會讓下一個測試的「拆掉」斷言失真。
 */
function makeTextClass() {
  return class FakeText {
    style: { resolution: number };
    scaleX: number;
    scaleY: number;
    scene: object | null = {};
    list?: undefined;
    constructor(resolution: number, scale = 1) {
      this.style = { resolution };
      this.scaleX = scale;
      this.scaleY = scale;
    }
    setResolution(r: number): this {
      this.style.resolution = r;
      return this;
    }
    renderWebGL(_renderer: unknown, _src: unknown, _camera: unknown, _parent: unknown): void {
      /* 官方的畫法；包起來的版本會先呼叫 checkText */
    }
  };
}
type FakeText = InstanceType<ReturnType<typeof makeTextClass>>;

class FakeRenderer {
  width = 760;
  height = 680;
  gl: FakeGLProto;
  resized = 0;
  constructor(gl: FakeGLProto) {
    this.gl = gl;
  }
  resize(): void {
    this.resized += 1;
    // 照 Phaser：resize 會用邏輯尺寸重設 viewport／scissor
    this.gl.viewport(0, 0, this.width, this.height);
    this.gl.scissor(0, this.gl.drawingBufferHeight - this.height, this.width, this.height);
  }
}

class FakeOption {
  CATEGORY: Record<string, unknown> = { sound: {}, language: {}, profile: {} };
  events = new Emitter();
  active = false;
  scene = { isActive: () => this.active, key: "Option" };
  children = { list: [] as unknown[] };
}

interface FakeGame {
  canvas: FakeCanvasProto;
  renderer: FakeRenderer;
  events: Emitter;
  scene: {
    keys: Record<string, unknown>;
    getScenes: (active: boolean) => { children: { list: unknown[] } }[];
  };
  textures: Emitter & { exists: (k: string) => boolean };
}

interface Harness {
  window: Record<string, unknown>;
  gl: FakeGLProto;
  canvas: FakeCanvasProto;
  game: FakeGame;
  texts: FakeText[];
  Text: ReturnType<typeof makeTextClass>;
  reports: unknown[];
  windows: DisplayWindowReport[];
  doc: {
    documentElement: { style: Record<string, string> };
    body: { style: Record<string, string> };
  };
  timers: (() => void)[];
  /** 觸發 window 的 resize 事件（腳本靠它重算 auto 倍率）。 */
  resize: () => void;
}

function makeHarness(opts: { dpr?: number; withGame?: boolean } = {}): Harness {
  const canvas = new FakeCanvasProto();
  const gl = new FakeGLProto(canvas);
  const renderer = new FakeRenderer(gl);
  const Text = makeTextClass();
  const texts = [new Text(2), new Text(0.6, 0.5), new Text(1)];
  const scene = { children: { list: texts } };
  const option = new FakeOption();
  const textures = Object.assign(new Emitter(), { exists: () => false });
  const game: FakeGame = {
    canvas,
    renderer,
    events: new Emitter(),
    scene: { keys: { Option: option }, getScenes: () => [scene] },
    textures,
  };
  const reports: unknown[] = [];
  const windows: DisplayWindowReport[] = [];
  const listeners: (() => void)[] = [];
  const doc = {
    documentElement: {
      style: {} as Record<string, string>,
      requestFullscreen: () => Promise.reject(new Error("no gesture")),
    },
    body: { style: {} as Record<string, string> },
    fullscreenElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ getContext: () => null }),
  };
  const window: Record<string, unknown> = {
    devicePixelRatio: opts.dpr ?? 1.5,
    lang: "tcn",
    document: doc,
    screen: {
      width: 1529,
      height: 640,
      availWidth: 2294,
      availHeight: 934,
      availLeft: 0,
      availTop: 0,
    },
    innerWidth: 818,
    innerHeight: 760,
    addEventListener: (name: string, fn: () => void) => {
      if (name === "resize") listeners.push(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      if (name === "resize") listeners.splice(listeners.indexOf(fn), 1);
    },
    Phaser: {
      GameObjects: {
        Text: { prototype: Text.prototype },
        DisplayList: { prototype: { addChildCallback() {} } },
        Container: { prototype: { addHandler() {} } },
      },
      Textures: {},
    },
    [BINDING]: (payload: string) => {
      const parsed: unknown = JSON.parse(payload);
      if (isDisplaySettingsReport(parsed)) reports.push(parsed);
      if (isDisplayWindowReport(parsed)) windows.push(parsed);
    },
  };
  // window.parent === window → 網頁版路徑（不去摸外殼）
  window["parent"] = window;
  if (opts.withGame !== false) window["game"] = game;
  return {
    window,
    gl,
    canvas,
    game,
    texts,
    Text,
    reports,
    windows,
    doc,
    timers: [],
    resize: () => {
      for (const fn of [...listeners]) fn();
    },
  };
}

function run(h: Harness, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: Record<string, unknown>,
    si: (fn: () => void, ms: number) => number,
    ci: (id: number) => void,
  ) => string;
  return fn(
    h.window,
    (cb) => {
      h.timers.push(cb);
      return h.timers.length;
    },
    (id) => {
      h.timers.splice(id - 1, 1);
    },
  );
}

function install(h: Harness, state: DisplayState = { render: "auto", size: "x1" }) {
  return parseDisplayStatus(run(h, buildDisplayPatchScript({ bindingName: BINDING, state })));
}

function status(h: Harness) {
  return parseDisplayStatus(run(h, DISPLAY_STATUS_EXPRESSION));
}

/** 畫一格：每個字的 renderWebGL（帶 camera zoom 1）→ postrender。 */
function frame(h: Harness): void {
  for (const t of h.texts) t.renderWebGL.call(t, {}, t, { zoom: 1 }, null);
  h.game.events.emit("postrender");
}

// ---------------------------------------------------------------------------

describe("buildDisplayPatchScript — 繪圖緩衝", () => {
  it("auto：緩衝放大成 dpr 倍，CSS 大小釘住，邏輯尺寸不變", () => {
    const h = makeHarness();
    const st = install(h);
    expect(st).toMatchObject({
      installed: true,
      version: DISPLAY_SCRIPT_VERSION,
      scale: 1.5,
      buffer: "1140x1020",
    });
    // 遊戲讀到的還是 760×680
    expect((h.canvas as unknown as { width: number }).width).toBe(760);
    expect(h.canvas.style["width"]).toBe("760px");
    expect(h.gl.drawingBufferHeight).toBe(680);
  });

  it("off：什麼都不碰", () => {
    const h = makeHarness();
    install(h, { render: "off", size: "x1" });
    expect(h.canvas._w).toBe(760);
    expect(Object.getOwnPropertyDescriptor(h.gl, "viewport")).toBeUndefined();
  });

  it("畫到螢幕時 viewport／scissor × 倍率；framebuffer 綁著時不縮放", () => {
    const h = makeHarness();
    install(h);
    h.gl.calls = [];
    h.gl.viewport(0, 0, 760, 680);
    h.gl.scissor(10, 20, 100, 50);
    expect(h.gl.calls).toEqual([
      { name: "viewport", args: [0, 0, 1140, 1020] },
      { name: "scissor", args: [15, 30, 150, 75] },
    ]);
    // 綁上 framebuffer：上次要的值照原樣重套（Phaser 常常先 viewport 再 bind）
    h.gl.calls = [];
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, { webGLFramebuffer: 1 });
    expect(h.gl.calls).toEqual([
      { name: "viewport", args: [0, 0, 760, 680] },
      { name: "scissor", args: [10, 20, 100, 50] },
    ]);
    h.gl.calls = [];
    h.gl.viewport(0, 0, 256, 256);
    expect(h.gl.calls).toEqual([{ name: "viewport", args: [0, 0, 256, 256] }]);
    // framebuffer 之間切換不重套；回到螢幕才乘倍率
    h.gl.calls = [];
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, { webGLFramebuffer: 2 });
    expect(h.gl.calls).toEqual([]);
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, null);
    expect(h.gl.calls).toEqual([
      { name: "viewport", args: [0, 0, 384, 384] },
      { name: "scissor", args: [15, 30, 150, 75] },
    ]);
  });

  it("FxPipeline 的順序：先 viewport(760×680) 再綁 fxTarget → 畫進 fxTarget 的是原尺寸", () => {
    // 2026-09-13 實機：任務地圖的區域高亮與標籤（preFX colorMatrix）整個消失，
    // 因為 viewport 在還綁著螢幕時就被乘了倍率。
    const h = makeHarness();
    install(h);
    h.gl.viewport(0, 0, 760, 680);
    h.gl.calls = [];
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, { webGLFramebuffer: 7 });
    expect(h.gl.vp).toEqual([0, 0, 760, 680]);
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, null);
    expect(h.gl.vp).toEqual([0, 0, 1140, 1020]);
    // 拆掉後 GL 的原生函式回來，不再插手
    run(h, DISPLAY_UNINSTALL_EXPRESSION);
    h.gl.calls = [];
    h.gl.viewport(0, 0, 760, 680);
    h.gl.bindFramebuffer(h.gl.FRAMEBUFFER, { webGLFramebuffer: 7 });
    expect(h.gl.calls).toEqual([{ name: "viewport", args: [0, 0, 760, 680] }]);
  });

  it("three.js 把 canvas.width 設回 760 → 緩衝仍是 1140（倍率不是存死的）", () => {
    const h = makeHarness();
    install(h);
    (h.canvas as unknown as { width: number }).width = 760;
    (h.canvas as unknown as { height: number }).height = 680;
    expect(h.canvas._w).toBe(1140);
    expect(h.canvas._h).toBe(1020);
    expect(status(h).buffer).toBe("1140x1020");
  });

  it("dpr 1 的 auto = 不放大；螢幕縮放變了（resize）就跟著變；關掉還原", () => {
    const h = makeHarness({ dpr: 1 });
    expect(install(h).scale).toBe(1);
    expect(h.canvas._w).toBe(760);
    // 玩家把 Windows 縮放調成 200% → resize 事件
    h.window["devicePixelRatio"] = 2;
    h.resize();
    expect(status(h)).toMatchObject({ scale: 2, buffer: "1520x1360" });
    run(h, buildDisplayStateExpression({ render: "off", size: "x1" }));
    expect(status(h)).toMatchObject({ scale: 1, buffer: "760x680" });
  });

  it("舊設定檔裡的 x2／x3 之類讀不懂就當 off／x1", () => {
    const h = makeHarness();
    install(h, { render: "x2" as unknown as "auto", size: "x9" as unknown as "x1" });
    expect(status(h).state).toEqual({ render: "off", size: "x1" });
  });
});

describe("buildDisplayPatchScript — 小字的 resolution", () => {
  it("畫之前排隊、postrender 才套；只補不夠的", () => {
    const h = makeHarness();
    install(h);
    // 還沒畫：一個都沒動
    expect(h.texts.map((t) => t.style.resolution)).toEqual([2, 0.6, 1]);
    frame(h);
    // res 2 夠了不動；0.6×(0.5 世界縮放) → 0.75；1 → 1.5
    expect(h.texts.map((t) => t.style.resolution)).toEqual([2, 0.75, 1.5]);
    expect(status(h).texts).toBe(2);
  });

  it("關掉放大 → 全部還原", () => {
    const h = makeHarness();
    install(h);
    frame(h);
    run(h, buildDisplayStateExpression({ render: "off", size: "x1" }));
    expect(h.texts.map((t) => t.style.resolution)).toEqual([2, 0.6, 1]);
    expect(status(h).texts).toBe(0);
  });

  it("倍率換了，下一格自己重算", () => {
    const h = makeHarness();
    install(h);
    frame(h);
    h.window["devicePixelRatio"] = 2;
    h.resize();
    frame(h);
    expect(h.texts.map((t) => t.style.resolution)).toEqual([2, 1, 2]);
  });
});

describe("buildDisplayPatchScript — 生命週期", () => {
  it("game 建好之後沒有輪詢；先開插件再開遊戲時等到 game 出現就停", () => {
    const h = makeHarness();
    install(h);
    expect(h.timers).toHaveLength(0);

    const late = makeHarness({ withGame: false });
    install(late);
    expect(late.timers).toHaveLength(1);
    late.window["game"] = late.game;
    late.timers[0]!();
    expect(late.timers).toHaveLength(0);
    expect(status(late).buffer).toBe("1140x1020");
  });

  it("拆掉：gl／canvas 屬性還原、字還原、事件拆光", () => {
    const h = makeHarness();
    install(h);
    frame(h);
    expect(run(h, DISPLAY_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(h.canvas._w).toBe(760);
    expect(Object.getOwnPropertyDescriptor(h.gl, "viewport")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(h.canvas, "width")).toBeUndefined();
    expect(h.texts.map((t) => t.style.resolution)).toEqual([2, 0.6, 1]);
    expect(h.Text.prototype.renderWebGL.toString()).not.toContain("checkText");
    expect(h.game.events.count("postrender")).toBe(0);
    expect(status(h).installed).toBe(false);
    expect(run(h, DISPLAY_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("重裝不留孤兒：postrender 只掛一個", () => {
    const h = makeHarness();
    install(h);
    install(h);
    expect(h.game.events.count("postrender")).toBe(1);
    expect(h.canvas._w).toBe(1140);
  });

  it("沒貼圖時不動 Option 的 CATEGORY（否則 create 會拿不存在的 frame 建鈕）", () => {
    const h = makeHarness();
    install(h);
    const option = h.game.scene.keys["Option"] as FakeOption;
    expect(Object.keys(option.CATEGORY)).toEqual(["sound", "language", "profile"]);
    expect(status(h)).toMatchObject({ tab: false, mounted: false });
  });
});

describe("buildDisplayPatchScript — 網頁版的畫面大小", () => {
  it("zoom 套在 html 不是 canvas（rexUI 輸入框才跟得上）；清掉官方白邊；請 Node 調視窗", () => {
    const h = makeHarness();
    install(h, { render: "auto", size: "x1.25" });
    expect(h.doc.documentElement.style["zoom"]).toBe("1.25");
    expect(h.canvas.style["zoom"] ?? "").toBe("");
    expect(h.doc.body.style).toMatchObject({
      margin: "0px",
      padding: "0px",
      justifyItems: "start",
      alignContent: "start",
    });
    expect(h.windows.at(-1)).toMatchObject({
      type: "display-window",
      width: 950,
      height: 850,
      innerWidth: 818,
      innerHeight: 760,
      availWidth: 2294,
    });
  });

  it("上一版留在 canvas 上的 zoom 重裝時清掉（不然放大兩次）", () => {
    const h = makeHarness();
    h.canvas.style["zoom"] = "1.25";
    install(h, { render: "auto", size: "x1.25" });
    expect(h.canvas.style["zoom"]).toBe("");
    expect(h.doc.documentElement.style["zoom"]).toBe("1.25");
  });

  it("換大小再回報一次；拆掉還原成官方外殼、不再回報", () => {
    const h = makeHarness();
    install(h, { render: "auto", size: "x1" });
    expect(h.windows.at(-1)).toMatchObject({ width: 760, height: 680 });
    run(h, buildDisplayStateExpression({ render: "auto", size: "x2" }));
    expect(h.windows.at(-1)).toMatchObject({ width: 1520, height: 1360 });
    const n = h.windows.length;
    run(h, DISPLAY_UNINSTALL_EXPRESSION);
    expect(h.doc.documentElement.style["zoom"]).toBe("");
    expect(h.doc.body.style).toMatchObject({
      margin: "",
      padding: "",
      justifyItems: "",
      alignContent: "",
    });
    expect(h.windows).toHaveLength(n);
  });
});

describe("planBrowserWindow", () => {
  // 2026-09-13 實機：外框 1030×908、內容區 1015×780（Chrome 的分頁列＋網址列 128px）
  const report = (w: number, h: number): DisplayWindowReport => ({
    type: "display-window",
    width: w,
    height: h,
    innerWidth: 1015,
    innerHeight: 780,
    availLeft: 0,
    availTop: 0,
    availWidth: 2294,
    availHeight: 934,
  });

  it("外框 = 外框 + (要的內容區 − 現在的內容區)，位置不動", () => {
    expect(
      planBrowserWindow({ left: 264, top: 0, width: 1030, height: 908 }, report(950, 850)),
    ).toEqual({
      left: 264,
      top: 0,
      width: 965,
      height: 978,
    });
  });

  it("調大會跑出工作區時才往回推，推不回去就貼齊工作區左上", () => {
    const next = planBrowserWindow(
      { left: 1800, top: 100, width: 1030, height: 908 },
      report(1520, 1360),
    );
    expect(next).toEqual({ left: 2294 - 1535, top: 0, width: 1535, height: 1488 });
    expect(next.top).toBe(0);
  });

  it("差 1px 以內當成一樣，不重調", () => {
    const a = { left: 1, top: 2, width: 965, height: 978 };
    expect(sameSize(a, { ...a, width: 966 })).toBe(true);
    expect(sameSize(a, { ...a, width: 967 })).toBe(false);
    expect(sameSize(a, { ...a, left: 2 })).toBe(false);
  });

  it("回報欄位缺一個就不收", () => {
    const { availHeight: _, ...partial } = report(760, 680);
    expect(isDisplayWindowReport(partial)).toBe(false);
    expect(isDisplayWindowReport(report(760, 680))).toBe(true);
  });
});

describe("parseDisplayStatus / isDisplaySettingsReport", () => {
  it("讀不懂就當沒裝", () => {
    const st = parseDisplayStatus("nope");
    expect(st.installed).toBe(false);
    expect(st.reason).toContain("nope");
  });

  it("狀態欄位要兩個都合法才收", () => {
    expect(
      parseDisplayStatus(JSON.stringify({ installed: true, state: { render: "auto", size: "x9" } }))
        .state,
    ).toBeNull();
    expect(
      isDisplaySettingsReport({ type: "display-settings", render: "auto", size: "fullscreen" }),
    ).toBe(true);
    expect(isDisplaySettingsReport({ type: "display-settings", render: "big", size: "x1" })).toBe(
      false,
    );
    expect(isDisplaySettingsReport({ type: "cost-toggle", enabled: true })).toBe(false);
    expect(
      isDisplayFullscreenReport({ type: "display-fullscreen", active: true, host: "desktop" }),
    ).toBe(true);
    expect(
      isDisplayFullscreenReport({ type: "display-fullscreen", active: "yes", host: "desktop" }),
    ).toBe(false);
  });
});

describe("parseWindowFillOutput", () => {
  it("只認最後一行 JSON；Add-Type 的雜訊不算", () => {
    const out = 'some warning\r\n{"ok":true,"rect":[0,0,3440,1440]}\r\n';
    expect(parseWindowFillOutput(out)).toEqual({
      ok: true,
      rect: [0, 0, 3440, 1440],
      reason: null,
    });
  });

  it("找不到視窗、沒輸出、壞 JSON 都是失敗且帶原因", () => {
    expect(parseWindowFillOutput('{"ok":false,"reason":"no-window"}')).toMatchObject({
      ok: false,
      reason: "no-window",
    });
    expect(parseWindowFillOutput("").ok).toBe(false);
    expect(parseWindowFillOutput("{nope").reason).toContain("nope");
  });
});
