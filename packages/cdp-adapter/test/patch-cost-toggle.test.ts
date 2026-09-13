/**
 * 牌組編輯畫面標題列的「自訂 COST ↔ 官方」開關
 *
 * 跟 `patch-present` 同一套：搭一個夠像的假 Edit 場景，把
 * `buildCostTogglePatchScript()` 產出來的**那一串字**原封不動 `new Function`
 * 起來跑。
 *
 * 假環境照 2026-09-12 從跑著的客戶端量的：標題 Text 在 (0,15)、tut_icon 在
 * (96,15)、分頁列 y=43；Edit 場景每次進來都重新 create，物件全換新。
 *
 * 這支要抓的坑：
 *
 * 1. Edit 重建後我們的東西跟著死 → 要重掛（不能只在安裝時掛一次）
 * 2. 沒選規則（`available:false`）→ 整顆不畫，不是停在「官方」
 * 3. 點下去：旋鈕**先動**（樂觀）、回報 `cost-toggle`；Node 推回來的狀態
 *    要能把它扳回去
 * 4. 重裝不留孤兒
 */

import { describe, expect, it } from "vitest";
import type { CostToggleState } from "@ulr/cdp-adapter";
import {
  buildCostTogglePatchScript,
  buildCostToggleStateExpression,
  COST_TOGGLE_SCRIPT_VERSION,
  COST_TOGGLE_STATUS_EXPRESSION,
  COST_TOGGLE_UNINSTALL_EXPRESSION,
  isCostToggleReport,
  parseCostToggleStatus,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeObject {
  handlers = new Map<string, Handler[]>();
  destroyed = false;
  visible = true;
  depth = 0;
  /** Phaser 的物件被 destroy 之後 `scene` 會變 null —— 腳本靠這個認「死了」。 */
  scene: FakeScene | null;
  constructor(
    scene: FakeScene,
    public type: string,
    public x: number,
    public y: number,
  ) {
    this.scene = scene;
  }
  on(name: string, fn: Handler): this {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  setOrigin(): this {
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setResolution(): this {
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setInteractive(): this {
    return this;
  }
  setX(x: number): this {
    this.x = x;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
    this.scene = null;
  }
}

class FakeText extends FakeObject {
  width: number;
  height = 16;
  color = "";
  constructor(
    scene: FakeScene,
    x: number,
    y: number,
    public text: string,
  ) {
    super(scene, "Text", x, y);
    this.width = text.length * 8;
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
  setColor(c: string): this {
    this.color = c;
    return this;
  }
}

class FakeGraphics extends FakeObject {
  fills: number[] = [];
  clear(): this {
    this.fills = [];
    return this;
  }
  fillStyle(color: number): this {
    this.fills.push(color);
    return this;
  }
  fillRoundedRect(): this {
    return this;
  }
  lineStyle(): this {
    return this;
  }
  strokeRoundedRect(): this {
    return this;
  }
}

class FakeContainer extends FakeObject {
  list: FakeObject[] = [];
  add(child: FakeObject): this {
    this.list.push(child);
    return this;
  }
  /** Phaser 的 Container 預設 exclusive：destroy 時連子物件一起收。 */
  override destroy(): void {
    for (const child of this.list) child.destroy();
    super.destroy();
  }
}

class FakeScene {
  objects: FakeObject[] = [];
  active = true;
  ulse01 = { plays: 0, play: () => void (this.ulse01.plays += 1) };
  scene = { isActive: () => this.active };
  add = {
    text: (x: number, y: number, t: string) => this.track(new FakeText(this, x, y, t)),
    graphics: () => this.track(new FakeGraphics(this, "Graphics", 0, 0)),
    circle: (x: number, y: number) => this.track(new FakeObject(this, "Arc", x, y)),
    container: (x: number, y: number) => this.track(new FakeContainer(this, "Container", x, y)),
    rectangle: (x: number, y: number) => this.track(new FakeObject(this, "Rectangle", x, y)),
    zone: (x: number, y: number) => this.track(new FakeObject(this, "Zone", x, y)),
  };
  private track<T extends FakeObject>(o: T): T {
    this.objects.push(o);
    return o;
  }
  /** 玩家離開再進來：舊物件全部 destroy，場景物件本身不換（跟 Phaser 一樣）。 */
  recreate(): void {
    for (const o of this.objects) o.destroy();
    this.objects = [];
  }
  alive(): FakeObject[] {
    return this.objects.filter((o) => !o.destroyed);
  }
}

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> } };
  lang: string;
  [key: string]: unknown;
}

interface FakeGame {
  window: FakeWindow;
  edit: FakeScene;
  reports: { type: string; enabled: boolean }[];
}

function makeGame(lang = "tcn"): FakeGame {
  const edit = new FakeScene();
  const reports: { type: string; enabled: boolean }[] = [];
  const window: FakeWindow = {
    game: { scene: { keys: { Edit: edit } } },
    lang,
    [BINDING]: (payload: string) => {
      const parsed: unknown = JSON.parse(payload);
      if (isCostToggleReport(parsed)) reports.push(parsed);
    },
  };
  return { window, edit, reports };
}

let poll: (() => void) | null = null;

function run(game: FakeGame, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: FakeWindow,
    si: (fn: () => void, ms: number) => number,
    ci: () => void,
  ) => string;
  return fn(
    game.window,
    (cb) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
  );
}

function install(game: FakeGame, state: CostToggleState = { available: true, enabled: true }) {
  return parseCostToggleStatus(
    run(game, buildCostTogglePatchScript({ bindingName: BINDING, state })),
  );
}

function tick(): void {
  expect(poll).not.toBeNull();
  poll!();
}

function status(game: FakeGame) {
  return parseCostToggleStatus(run(game, COST_TOGGLE_STATUS_EXPRESSION));
}

function knob(game: FakeGame): FakeObject | undefined {
  return game.edit.alive().find((o) => o.type === "Arc");
}

function side(game: FakeGame): FakeText | undefined {
  return game.edit
    .alive()
    .filter((o): o is FakeText => o instanceof FakeText)
    .find((t) => t.text !== "COST" && !t.text.includes("："));
}

function click(game: FakeGame): void {
  const zone = game.edit.alive().find((o) => o.type === "Zone");
  expect(zone).toBeDefined();
  zone!.emit("pointerdown");
}

// ---------------------------------------------------------------------------

describe("buildCostTogglePatchScript", () => {
  it("玩家在 Edit 畫面 → 裝上去就畫出來，旋鈕在右、字是「自訂」", () => {
    const game = makeGame();
    const st = install(game);
    expect(st).toMatchObject({ installed: true, mounted: true, enabled: true });
    expect(st.version).toBe(COST_TOGGLE_SCRIPT_VERSION);
    expect(knob(game)!.x).toBeGreaterThan(180);
    expect(side(game)!.text).toBe("自訂");
    expect(game.edit.alive().some((o) => o instanceof FakeText && o.text === "COST")).toBe(true);
  });

  it("enabled:false 裝上去 → 旋鈕在左、字是「官方」", () => {
    const game = makeGame();
    install(game, { available: true, enabled: false });
    expect(knob(game)!.x).toBeLessThan(180);
    expect(side(game)!.text).toBe("官方");
  });

  it("文案跟著遊戲語言走", () => {
    const ja = makeGame("ja");
    install(ja);
    expect(side(ja)!.text).toBe("カスタム");
    const en = makeGame("en");
    install(en, { available: true, enabled: false });
    expect(side(en)!.text).toBe("Official");
    // 認不得的語言退回英文，不會畫出 undefined
    const zz = makeGame("zz");
    install(zz);
    expect(side(zz)!.text).toBe("Custom");
  });

  it("⚠ 沒選規則（available:false）→ 整顆不畫", () => {
    const game = makeGame();
    const st = install(game, { available: false, enabled: true });
    expect(st.mounted).toBe(false);
    expect(game.edit.alive()).toHaveLength(0);
    // 之後有規則了 → 推狀態就出現
    expect(run(game, buildCostToggleStateExpression({ available: true, enabled: true }))).toBe(
      "ok",
    );
    expect(knob(game)).toBeDefined();
    // 規則又拿掉 → 消失
    run(game, buildCostToggleStateExpression({ available: false, enabled: true }));
    expect(game.edit.alive()).toHaveLength(0);
  });

  it("不在 Edit 畫面 → 不畫；進來了 → 輪詢一拍就掛上；離開 → 收掉", () => {
    const game = makeGame();
    game.edit.active = false;
    expect(install(game).mounted).toBe(false);
    expect(game.edit.alive()).toHaveLength(0);

    game.edit.active = true;
    tick();
    expect(status(game).mounted).toBe(true);
    expect(knob(game)).toBeDefined();

    game.edit.active = false;
    tick();
    expect(status(game).mounted).toBe(false);
    expect(game.edit.alive()).toHaveLength(0);
  });

  it("⚠ Edit 重建過（物件全換新）→ 重掛，而且只有一套", () => {
    const game = makeGame();
    install(game);
    game.edit.recreate();
    tick();
    const arcs = game.edit.alive().filter((o) => o.type === "Arc");
    expect(arcs).toHaveLength(1);
    expect(status(game).mounted).toBe(true);
  });

  it("點一下：旋鈕先動、字先換、回報 cost-toggle、播音效", () => {
    const game = makeGame();
    install(game);
    click(game);
    expect(game.reports).toEqual([{ type: "cost-toggle", enabled: false }]);
    expect(knob(game)!.x).toBeLessThan(180);
    expect(side(game)!.text).toBe("官方");
    expect(game.edit.ulse01.plays).toBe(1);

    click(game);
    expect(game.reports[1]).toEqual({ type: "cost-toggle", enabled: true });
    expect(side(game)!.text).toBe("自訂");
  });

  it("Node 推回來的狀態是真相：切失敗時旋鈕彈回去", () => {
    const game = makeGame();
    install(game);
    click(game); // 樂觀更新成官方
    expect(side(game)!.text).toBe("官方");
    // Node 說：沒切成，還是自訂
    expect(run(game, buildCostToggleStateExpression({ available: true, enabled: true }))).toBe(
      "ok",
    );
    expect(side(game)!.text).toBe("自訂");
    expect(status(game).enabled).toBe(true);
  });

  it("hover 顯示說明、離開就收", () => {
    const game = makeGame();
    install(game);
    const tip = game.edit.alive().find((o) => o.type === "Container");
    expect(tip).toBeDefined();
    expect(tip!.visible).toBe(false);
    const zone = game.edit.alive().find((o) => o.type === "Zone")!;
    zone.emit("pointerover");
    expect(tip!.visible).toBe(true);
    zone.emit("pointerout");
    expect(tip!.visible).toBe(false);
  });

  it("重裝不留孤兒；拆掉之後一個都不剩", () => {
    const game = makeGame();
    install(game);
    install(game);
    expect(game.edit.alive().filter((o) => o.type === "Arc")).toHaveLength(1);
    expect(run(game, COST_TOGGLE_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(game.edit.alive()).toHaveLength(0);
    expect(status(game).installed).toBe(false);
    expect(run(game, buildCostToggleStateExpression({ available: true, enabled: true }))).toBe(
      "not-installed",
    );
  });

  it("沒裝時的狀態與拆除", () => {
    const game = makeGame();
    expect(status(game)).toEqual({
      installed: false,
      version: null,
      mounted: false,
      enabled: null,
      reason: null,
    });
    expect(run(game, COST_TOGGLE_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("腳本裡沒有反引號（會把 template literal 提早收尾）", () => {
    const src = buildCostTogglePatchScript({
      bindingName: BINDING,
      state: { available: true, enabled: true },
    });
    expect(src.includes("`")).toBe(false);
  });
});

describe("parseCostToggleStatus", () => {
  it("讀不懂就當成沒裝，原文留在 reason", () => {
    const st = parseCostToggleStatus("nope");
    expect(st.installed).toBe(false);
    expect(st.reason).toContain("nope");
  });
});

describe("isCostToggleReport", () => {
  it("只認 type 對而且 enabled 是布林的", () => {
    expect(isCostToggleReport({ type: "cost-toggle", enabled: true })).toBe(true);
    expect(isCostToggleReport({ type: "cost-toggle", enabled: "yes" })).toBe(false);
    expect(isCostToggleReport({ type: "deck-select", id: "x" })).toBe(false);
    expect(isCostToggleReport(null)).toBe(false);
  });
});
