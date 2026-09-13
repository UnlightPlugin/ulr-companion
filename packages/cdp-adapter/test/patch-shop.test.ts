/**
 * 商店的購買數量檔位
 *
 * 跟 `patch-present` 同一套：搭一個夠像的假遊戲，把 `buildShopPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-12 從跑著的客戶端挖出來的形狀寫：
 *
 * ```js
 *   // 確認框開啟（btn_buy pointerdown）：
 *   t = Math.trunc(this.gem / i.price.gem);  …取 ccoin 最小值… …upper…
 *   t > 20 && (t = 20);                       // 那刀
 *   rm 商品另一套：t = 10
 *   this.panel = V.Create(this, 430, 309, t).setVisible(false).setDepth(2001);
 *
 *   // V.Create 裝的 handler 只讀 e.name：
 *   o.on("child.down", (e) => {
 *     t.btn_panel_text.setText(e.name); o.setVisible(false);
 *     t.buy_quantity = Number(e.name);
 *     t.gem_left_text.setText("" + (t.gem - price.gem * t.buy_quantity));
 *     t.events.emit("test_quantity_select", i);
 *   });
 *
 *   // 數量鈕：this.panel.setVisible(true)；No：this.panel.setVisible(false)
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 只放寬 GEM 商品 —— 課金（rm）、碎片（純 cmem）、活動一律不碰
 * 2. 對帳：算出來的上限跟官方面板的個數對不上就不碰
 * 3. 點選交給官方 handler（buy_quantity / 預覽 / 事件都是它改的）
 * 4. 確認框每開一次官方就建一個新面板 —— 我們的舊面板要跟著收
 * 5. 拆掉時 sc.panel 要還給官方那份
 */

import { describe, expect, it } from "vitest";
import {
  buildShopPatchScript,
  OFFICIAL_QUANTITY_CAP,
  parseShopStatus,
  QUANTITY_TIERS,
  SHOP_SCRIPT_VERSION,
  SHOP_STATUS_EXPRESSION,
  SHOP_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
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
}

/** Phaser 物件 destroy 之後 `scene` 會變 undefined —— 腳本靠這個判活。 */
class FakeObject extends FakeEmitter {
  scene: object | undefined = {};
  visible = true;
  depth = 0;
  destroy(): void {
    this.scene = undefined;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setResolution(): this {
    return this;
  }
}

class FakeText extends FakeObject {
  constructor(public text: string) {
    super();
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
}

class FakeRoundRect extends FakeObject {
  fillColor = 0xffffff;
  stroke: unknown[] = [];
  setStrokeStyle(...args: unknown[]): this {
    this.stroke = args;
    return this;
  }
}

class FakeLabel extends FakeObject {
  name: string;
  background: FakeRoundRect;
  constructor(cfg: { name: string; background: FakeRoundRect; text: FakeText }) {
    super();
    this.name = cfg.name;
    this.background = cfg.background;
  }
  getElement(key: string): unknown {
    return key === "background" ? this.background : undefined;
  }
}

class FakeSizer extends FakeObject {
  children: FakeLabel[] = [];
  add(child: FakeLabel): this {
    this.children.push(child);
    return this;
  }
}

/** rexUI 的 scrollablePanel。名字查詢照官方用法 `getByName(name, true)`。 */
class FakePanel extends FakeObject {
  x: number;
  y: number;
  height: number;
  child: FakeSizer;
  interactive = false;
  constructor(cfg: { x: number; y: number; height: number; panel: { child: FakeSizer } }) {
    super();
    this.x = cfg.x;
    this.y = cfg.y;
    this.height = cfg.height;
    this.child = cfg.panel.child;
  }
  layout(): this {
    return this;
  }
  scrollToChild(): this {
    return this;
  }
  setChildrenInteractive(): this {
    this.interactive = true;
    return this;
  }
  getByName(name: string): FakeLabel | null {
    return this.child.children.find((c) => c.name === name) ?? null;
  }
  names(): number[] {
    return this.child.children.map((c) => Number(c.name));
  }
}

interface FakeItem {
  price: { gem: number; ccoin0?: number; ccoin1?: number; cmem5?: number };
  upper: number | null;
  rm?: number;
  name_tcn: string;
}

interface FakeShop {
  gem: number;
  data_ccoin: Record<string, number>;
  select: { cate1: string | null; cate2: string | null; index: number | null };
  panel: FakePanel | undefined;
  buy_quantity: number;
  btn_panel_text: FakeText;
  gem_left_text: FakeText;
  events: FakeEmitter;
  shop: { item: { other: { upper: number | null }[] } };
  item_other: { upper: number | null }[];
  rexUI: { add: Record<string, (cfg: never) => unknown> };
  add: { text: (x: number, y: number, t: string) => FakeText; sprite: () => FakeObject };
  get_selected_item: () => FakeItem | null;
  /** 面板建了幾個（含官方與我們的）。 */
  built: FakePanel[];
  /** 官方 handler 收到的 child.down。 */
  picked: string[];
  /** 官方 create() 那段：照抄公式建面板。 */
  openDialog(): FakePanel;
  /** 數量鈕。 */
  pressQuantityButton(): void;
  /** No 鈕。 */
  pressNo(): void;
}

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> } };
  [key: string]: unknown;
}

interface FakeGame {
  window: FakeWindow;
  shop: FakeShop;
}

function makeGame(
  options: { gem?: number; item?: FakeItem | null; ccoin?: Record<string, number> } = {},
): FakeGame {
  const gem = options.gem ?? 5404;
  const item: FakeItem | null =
    options.item === undefined
      ? { price: { gem: 200 }, upper: null, name_tcn: "白色石楠1" }
      : options.item;
  const ccoin = options.ccoin ?? { 0: 5, 1: 53, 2: 52, 3: 1, 4: 17 };

  const built: FakePanel[] = [];
  const picked: string[] = [];

  const rexAdd = {
    sizer: () => new FakeSizer(),
    roundRectangle: () => new FakeRoundRect(),
    label: (cfg: { name: string; background: FakeRoundRect; text: FakeText }) => new FakeLabel(cfg),
    scrollablePanel: (cfg: {
      x: number;
      y: number;
      height: number;
      panel: { child: FakeSizer };
    }) => {
      const p = new FakePanel(cfg);
      built.push(p);
      return p;
    },
  };

  const shop: FakeShop = {
    gem,
    data_ccoin: ccoin,
    select: { cate1: "item", cate2: "battle", index: 0 },
    panel: undefined,
    buy_quantity: 1,
    btn_panel_text: new FakeText("1"),
    gem_left_text: new FakeText(""),
    events: new FakeEmitter(),
    shop: { item: { other: [{ upper: null }] } },
    item_other: [{ upper: null }],
    rexUI: { add: rexAdd as unknown as Record<string, (cfg: never) => unknown> },
    add: { text: (_x, _y, t) => new FakeText(t), sprite: () => new FakeObject() },
    get_selected_item: () => item,
    built,
    picked,
    openDialog() {
      // ⚠ 照抄官方公式，含那刀。這是被測物要對帳的對象。
      const i = shop.get_selected_item()!;
      let t: number;
      const isRm = "rm" in i && i.rm !== undefined;
      if (i.price.gem !== 0) {
        t = Math.trunc(shop.gem / i.price.gem);
        for (const k of Object.keys(shop.data_ccoin)) {
          const price = (i.price as Record<string, number | undefined>)["ccoin" + k];
          const e = Math.trunc((shop.data_ccoin[k] ?? 0) / (price ?? 0));
          if (e < t) t = e;
        }
      } else t = 20;
      if (i.upper !== null && t > i.upper) t = i.upper;
      if (t > OFFICIAL_QUANTITY_CAP) t = OFFICIAL_QUANTITY_CAP;
      if (isRm) t = 10;

      const list = new FakeSizer();
      for (let s = 1; s <= t; s++) {
        list.add(
          new FakeLabel({
            name: String(s),
            background: new FakeRoundRect(),
            text: new FakeText(String(s)),
          }),
        );
      }
      const o = new FakePanel({
        x: 430,
        y: 309,
        height: t < 10 ? 22 * t : 220,
        panel: { child: list },
      });
      built.push(o);
      o.on("child.down", (e) => {
        const name = (e as { name: string }).name;
        picked.push(name);
        shop.btn_panel_text.setText(name);
        o.setVisible(false);
        shop.buy_quantity = Number(name);
        shop.gem_left_text.setText("" + (shop.gem - i.price.gem * shop.buy_quantity));
        shop.events.emit("test_quantity_select", Number(name));
      });
      shop.buy_quantity = 1;
      shop.btn_panel_text.setText("1");
      shop.panel = o;
      o.setVisible(false).setDepth(2001);
      return o;
    },
    pressQuantityButton() {
      shop.panel?.setVisible(true);
    },
    pressNo() {
      shop.panel?.setVisible(false);
    },
  };

  const window: FakeWindow = { game: { scene: { keys: { Shop: shop } } } };
  return { window, shop };
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

function install(game: FakeGame, options?: Parameters<typeof buildShopPatchScript>[0]): string {
  return run(game, buildShopPatchScript(options));
}

function tick(): void {
  expect(poll).not.toBeNull();
  poll!();
}

function status(game: FakeGame) {
  return parseShopStatus(run(game, SHOP_STATUS_EXPRESSION));
}

// ---------------------------------------------------------------------------

describe("商店的購買數量檔位", () => {
  it("GEM 商品：確認框開了之後 sc.panel 換成檔位表，只留買得起的", () => {
    // gem 5404 / 200 = 27 → 官方 1..20，我們 1..20 那幾檔
    const game = makeGame({ gem: 5404 });
    install(game);
    const official = game.shop.openDialog();
    expect(official.names()).toHaveLength(20);
    tick();
    expect(game.shop.panel).not.toBe(official);
    expect(game.shop.panel!.names()).toEqual([1, 2, 3, 5, 7, 10, 15, 20]);
    expect(official.visible).toBe(false);
    expect(status(game)).toMatchObject({
      active: true,
      max: 27,
      tiers: [1, 2, 3, 5, 7, 10, 15, 20],
    });
  });

  it("GEM 充足時 14 個檔位全出，而且是照 QUANTITY_TIERS 的順序", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    game.shop.openDialog();
    tick();
    expect(game.shop.panel!.names()).toEqual([...QUANTITY_TIERS]);
    expect(status(game).max).toBe(4999);
  });

  it("不夠買 20 個就看不到 20（跟官方一樣）", () => {
    const game = makeGame({ gem: 1800 }); // 9 個
    install(game);
    game.shop.openDialog();
    tick();
    expect(game.shop.panel!.names()).toEqual([1, 2, 3, 5, 7]);
  });

  it("面板高度規則照抄官方：不到 10 項是 22*n，否則 220 加捲軸", () => {
    const a = makeGame({ gem: 1800 });
    install(a);
    a.shop.openDialog();
    tick();
    expect(a.shop.panel!.height).toBe(22 * 5);

    const b = makeGame({ gem: 999_999 });
    install(b);
    b.shop.openDialog();
    tick();
    expect(b.shop.panel!.height).toBe(220);
  });

  it("點了檔位：交給官方 handler 改 buy_quantity、預覽與事件，我們只把自己收起來", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    game.shop.openDialog();
    tick();
    game.shop.pressQuantityButton();
    expect(game.shop.panel!.visible).toBe(true);

    let got: unknown = null;
    game.shop.events.on("test_quantity_select", (n) => (got = n));
    const mine = game.shop.panel!;
    mine.emit("child.down", mine.getByName("500"));

    expect(game.shop.picked).toEqual(["500"]);
    expect(game.shop.buy_quantity).toBe(500);
    expect(game.shop.btn_panel_text.text).toBe("500");
    expect(game.shop.gem_left_text.text).toBe(String(999_999 - 200 * 500));
    expect(got).toBe(500);
    expect(mine.visible).toBe(false);
  });

  it("數量鈕與 No 鈕操作的是我們的面板（官方只動 sc.panel 這個參考）", () => {
    const game = makeGame();
    install(game);
    game.shop.openDialog();
    tick();
    const mine = game.shop.panel!;
    expect(mine.visible).toBe(false);
    game.shop.pressQuantityButton();
    expect(mine.visible).toBe(true);
    game.shop.pressNo();
    expect(mine.visible).toBe(false);
  });

  it("換的時候官方面板已經亮著，我們的就跟著亮 —— 不會讓清單憑空消失", () => {
    const game = makeGame();
    install(game);
    game.shop.openDialog();
    game.shop.pressQuantityButton(); // 玩家手快，輪詢還沒到
    tick();
    expect(game.shop.panel!.visible).toBe(true);
  });

  // ── 閘門 ────────────────────────────────────────────────────────────────

  it("課金商品完全不碰：sc.panel 還是官方那份 1..10", () => {
    const game = makeGame({
      item: { price: { gem: 0 }, upper: null, rm: 80, name_tcn: "白色石楠5" },
    });
    install(game);
    const official = game.shop.openDialog();
    tick();
    expect(game.shop.panel).toBe(official);
    expect(official.names()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(official.visible).toBe(false);
    expect(status(game)).toMatchObject({ active: false, reason: null });
  });

  it("碎片商品（純 cmem，gem=0）完全不碰", () => {
    const game = makeGame({ item: { price: { gem: 0, cmem5: 2 }, upper: null, name_tcn: "碎片" } });
    install(game);
    const official = game.shop.openDialog();
    tick();
    expect(game.shop.panel).toBe(official);
    expect(official.names()).toHaveLength(20);
  });

  it("活動商店（cate1 === event）完全不碰", () => {
    const game = makeGame({ gem: 999_999 });
    game.shop.select = { cate1: "event", cate2: "x", index: 0 };
    install(game);
    const official = game.shop.openDialog();
    tick();
    expect(game.shop.panel).toBe(official);
  });

  // ── 上限 ────────────────────────────────────────────────────────────────

  it("購買上限（upper）會壓住檔位", () => {
    const game = makeGame({
      gem: 999_999,
      item: { price: { gem: 200 }, upper: 30, name_tcn: "限購品" },
    });
    install(game);
    game.shop.openDialog();
    tick();
    expect(game.shop.panel!.names()).toEqual([1, 2, 3, 5, 7, 10, 15, 20, 30]);
    expect(status(game).max).toBe(30);
  });

  it("GEM+ccoin 商品：ccoin 不夠時以 ccoin 為準", () => {
    const game = makeGame({
      gem: 999_999,
      ccoin: { 0: 5, 1: 53 },
      item: { price: { gem: 1000, ccoin0: 0, ccoin1: 11 }, upper: null, name_tcn: "武器" },
    });
    install(game);
    game.shop.openDialog();
    tick();
    // 53 / 11 = 4
    expect(game.shop.panel!.names()).toEqual([1, 2, 3]);
    expect(status(game).max).toBe(4);
  });

  it("對帳不符（官方公式變了）就不碰，原因說得出來", () => {
    const game = makeGame({ gem: 5404 });
    install(game);
    const official = game.shop.openDialog();
    // 官方面板被動了手腳：只有 15 個，但我們算 27 → 預期 20
    official.child.children.splice(15);
    tick();
    expect(game.shop.panel).toBe(official);
    expect(status(game).active).toBe(false);
    expect(status(game).reason).toContain("對帳");
  });

  // ── 生命週期 ────────────────────────────────────────────────────────────

  it("確認框再開一次：舊的我們那份銷毀，新的換上", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    game.shop.openDialog();
    tick();
    const first = game.shop.panel!;
    game.shop.openDialog();
    tick();
    const second = game.shop.panel!;
    expect(second).not.toBe(first);
    expect(first.scene).toBeUndefined();
    expect(second.scene).toBeDefined();
    expect(second.names()).toEqual([...QUANTITY_TIERS]);
  });

  it("sc.panel 是死物件（離開商店又回來）就跳過，不會炸", () => {
    const game = makeGame();
    install(game);
    const official = game.shop.openDialog();
    official.destroy();
    tick();
    expect(game.shop.panel).toBe(official);
    expect(status(game)).toMatchObject({ installed: true, active: false, reason: null });
  });

  it("還沒選商品（get_selected_item 是 null）時安靜等著", () => {
    const game = makeGame({ item: null });
    install(game);
    game.shop.panel = new FakePanel({
      x: 430,
      y: 309,
      height: 22,
      panel: { child: new FakeSizer() },
    });
    tick();
    expect(status(game)).toMatchObject({ installed: true, active: false, reason: null });
  });

  it("拆得乾淨：sc.panel 還給官方、我們的銷毀、旗標刪除", () => {
    const game = makeGame();
    install(game);
    const official = game.shop.openDialog();
    tick();
    const mine = game.shop.panel!;
    expect(run(game, SHOP_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(game.shop.panel).toBe(official);
    expect(mine.scene).toBeUndefined();
    expect(game.window.__ulrShop).toBeUndefined();
    expect(poll).toBeNull();
    expect(status(game).installed).toBe(false);
  });

  it("重裝從原狀開始：先還給官方再換一次，不會疊兩層", () => {
    const game = makeGame();
    install(game);
    const official = game.shop.openDialog();
    tick();
    const first = game.shop.panel!;
    install(game);
    // 重裝那一刻 sc.panel 已經還給官方，第一輪 tick 又換一次
    tick();
    const second = game.shop.panel!;
    expect(first.scene).toBeUndefined();
    expect(second).not.toBe(official);
    expect(second).not.toBe(first);
    expect(second.names()).toEqual([1, 2, 3, 5, 7, 10, 15, 20]);
  });

  it("狀態帶著版本號，而且沒裝的時候說得出來", () => {
    const game = makeGame();
    expect(status(game)).toEqual({
      installed: false,
      version: null,
      active: false,
      tiers: [],
      max: null,
      reason: null,
    });
    install(game);
    expect(status(game)).toMatchObject({
      installed: true,
      version: SHOP_SCRIPT_VERSION,
      active: false,
    });
  });

  it("檔位表可以換，但一定會排序、去掉非正整數", () => {
    const game = makeGame({ gem: 999_999 });
    install(game, { tiers: [50, 1, 0, -3, 2.5, 10] });
    game.shop.openDialog();
    tick();
    expect(game.shop.panel!.names()).toEqual([1, 10, 50]);
  });

  it("讀不懂的回應當成沒裝，原文帶在 reason 裡", () => {
    const s = parseShopStatus("<html>");
    expect(s.installed).toBe(false);
    expect(s.reason).toContain("<html>");
  });

  it("沒有「最大」、沒有輸入框 —— 檔位表就是使用者給的那 14 個", () => {
    expect(QUANTITY_TIERS).toEqual([1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 100, 200, 300, 500]);
    expect(buildShopPatchScript()).not.toContain("inputText");
  });
});
