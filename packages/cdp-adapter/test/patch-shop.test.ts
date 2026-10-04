/**
 * 商店的購買數量檔位
 *
 * 跟 `patch-present` 同一套：搭一個夠像的假遊戲，把 `buildShopPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-26 從跑著的客戶端（2026-09-23 改版後）挖出來的形狀寫：
 *
 * ```js
 *   get_max_purchase(t) {
 *     let e = [20];
 *     t.price.gem > 0 && e.push(trunc(money.gem / t.price.gem));  …各 item_xxx…
 *     t.upper !== null && e.push(upper - shop_config 已買);
 *     return Math.min(...e);
 *   }
 *   create_purchase_screen(t) {
 *     const i = this.get_max_purchase(t);
 *     for (E = 0; E < max(i, 1); E++) o[E] = { text: E+1, value: E+1 };
 *     d = this.rexUI.add.dropDownList({ options: o, list: { onButtonClick: n.quantity = value } });
 *     ok → this.socket.fetch("shop_buy", n.id, n.quantity)
 *   }
 * ```
 *
 * 伺服器（改版後）一次最多給 20 個，多的安靜截掉、照樣回成功。
 *
 * 這支要抓的坑：
 *
 * 1. 只放寬 GEM 商品 —— 課金（price.rm）、碎片（item_10011）、活動點數一律不碰
 * 2. 對帳：官方回 20 時我們重算，重算 < 20 就不碰
 * 3. 點選走官方的 onButtonClick（數量是它記的）
 * 4. > 20 的 shop_buy 拆成每批 ≤20 依序送，失敗就停
 * 5. 拆掉時場景上的方法與 socket.fetch 都要還原成原型那支
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

interface Option {
  text: string;
  value: number;
}

/** Phaser 物件 destroy 之後 `scene` 會變 undefined —— 腳本靠這個判活。 */
class FakeObject {
  scene: object | undefined = {};
  destroy(): void {
    this.scene = undefined;
  }
}

/** rexUI 的 dropDownList：清單點開時才照 `options` 現建，所以換 options 就好。 */
class FakeDropDown extends FakeObject {
  options: Option[];
  constructor(
    options: Option[],
    private onButtonClick: (opt: Option) => void,
  ) {
    super();
    this.options = options;
  }
  setOptions(options: Option[]): this {
    this.options = options;
    return this;
  }
  /** 玩家點開清單、點了值為 value 的那項。 */
  pick(value: number): void {
    const opt = this.options.find((o) => o.value === value);
    if (!opt) throw new Error(`清單裡沒有 ${value}`);
    this.onButtonClick(opt);
  }
  values(): number[] {
    return this.options.map((o) => o.value);
  }
}

interface Price {
  gem: number;
  rm: number;
  point: number;
  item_10001: number;
  item_10011: number;
}

interface FakeItem {
  id: number;
  price: Price;
  upper: number | null;
}

type Money = Record<keyof Price, number>;

interface BuyResponse {
  error: string | null;
  rm_process: string | null;
}

/**
 * 官方的 socket。`fetch` 在原型上（實測 ownFetch=false）。
 *
 * 伺服器照 2026-09-26 實測：一次最多給 20 個，多的**安靜截掉**、照樣回成功，
 * 只扣實際給的那 20 個的錢。
 */
class FakeSocket {
  calls: unknown[][] = [];
  /** 第幾次 shop_buy（從 1 起算）回失敗 / 丟例外。 */
  failAt: number | null = null;
  throwAt: number | null = null;
  /** 伺服器每個多扣的 gem（模擬對帳不符）。 */
  overcharge = 0;
  private buys = 0;
  constructor(private server: { gem: number; prices: Map<number, number> }) {}
  async fetch(name: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push([name, ...args]);
    if (name !== "shop_buy") return { echo: name };
    this.buys++;
    if (this.throwAt === this.buys) throw new Error("shop_buy: timed out");
    if (this.failAt === this.buys) return { error: "NOT_ENOUGH", rm_process: null };
    const [id, qty] = args as [number, number];
    const given = Math.min(qty, OFFICIAL_QUANTITY_CAP);
    this.server.gem -= (this.server.prices.get(id)! + this.overcharge) * given;
    return { error: null, rm_process: null };
  }
  shopBuys(): number[] {
    return this.calls.filter((c) => c[0] === "shop_buy").map((c) => c[2] as number);
  }
}

class FakeText extends FakeObject {
  constructor(public text: string) {
    super();
  }
  setText(s: string): this {
    this.text = s;
    return this;
  }
}

interface ShopEntry {
  id: number;
  item: { type: number; id: number; slot: number; amount: number }[];
}

/** 照 2026-10-02 客戶端的 WeaponCards / Characters 形狀（只留用得到的欄位）。 */
const WEAPON_CARDS = [
  { id: 1, name_tcn: "妖魔短劍", chara: null },
  { id: 89, name_tcn: "毒鐵線", chara: "cc022" },
  { id: 5005, name_tcn: "魔之刀身", chara: "cc000" },
];
const EVENT_CARDS = [{ id: 89, name_tcn: "某張事件卡" }];
const CHARACTERS: Record<string, { name_tcn: string }> = { cc022: { name_tcn: "薩爾卡多" } };

const WEAPON_89: ShopEntry = { id: 1553, item: [{ type: 2, id: 89, slot: 0, amount: 1 }] };
/** 事件卡跟武器 id 撞號 —— 只看 id 會標錯。 */
const EVENT_89: ShopEntry = { id: 3851, item: [{ type: 2, id: 89, slot: 2, amount: 1 }] };
const GENERIC_1: ShopEntry = { id: 5415, item: [{ type: 2, id: 1, slot: 0, amount: 1 }] };
const MATERIAL_5005: ShopEntry = { id: 6000, item: [{ type: 2, id: 5005, slot: 0, amount: 1 }] };
const POTION: ShopEntry = { id: 3230, item: [{ type: 3, id: 1, slot: 0, amount: 1 }] };

class FakeShopScene {
  scene = {};
  children = { list: [] as unknown[] };
  /** create 裡建一次的「使用場所」值，官方之後不再動它。 */
  item_place = new FakeText("-");
  item_name = new FakeText("");
  shop_select: number | null = null;
  shopData: ShopEntry[] = [WEAPON_89, EVENT_89, GENERIC_1, MATERIAL_5005, POTION];
  cache = {
    json: {
      get: (key: string): unknown =>
        ({ WeaponCards: WEAPON_CARDS, EventCards: EVENT_CARDS, Characters: CHARACTERS })[key],
    },
  };
  money: Money;
  /** 伺服器那邊的真實餘額；player 是官方重抓時才更新的快照。 */
  server: { gem: number; prices: Map<number, number> };
  player: { gem: number };
  socket: FakeSocket;
  shop_config: { shop_id: number; quantity: number }[] = [];
  /** 官方 ok 流程最後走到哪：success / error:xxx。 */
  outcome: string | null = null;
  /** 最近一次確認框的數量下拉，與它的 ok。 */
  last: { dd: FakeDropDown; ok: () => Promise<void>; preview: () => number } | null = null;
  rexUI = {
    add: {
      dropDownList: (cfg: {
        options: Option[];
        list: { onButtonClick: (opt: Option) => void };
      }) => {
        const dd = new FakeDropDown(cfg.options, cfg.list.onButtonClick);
        this.children.list.push(dd);
        return dd;
      },
    },
  };

  constructor(money: Partial<Money>) {
    this.money = { gem: 0, rm: 0, point: 0, item_10001: 0, item_10011: 0, ...money };
    this.server = { gem: this.money.gem, prices: new Map() };
    this.player = { gem: this.money.gem };
    this.socket = new FakeSocket(this.server);
  }

  get_money(): Money {
    return { ...this.money, gem: this.player.gem };
  }

  /** 官方：重抓 player（換一個新物件）、跳成功框。 */
  async show_dialogue_success(): Promise<void> {
    this.player = { gem: this.server.gem };
    this.outcome = "success";
  }

  async shop_error(e: string): Promise<void> {
    this.outcome = `error:${e}`;
  }

  /** 照抄官方：武器 type 2 slot 0、事件卡 type 2 slot 2，數量 > 1 接 " xN"。 */
  get_item_info(t: ShopEntry): { item_name: string; item_effect: string } {
    const it = t.item[0]!;
    const list = it.type === 2 && it.slot === 0 ? WEAPON_CARDS : it.type === 2 ? EVENT_CARDS : [];
    const card = list.find((c) => c.id === it.id);
    const name = card ? card.name_tcn : "精靈之藥";
    return { item_name: it.amount === 1 ? name : `${name} x${it.amount}`, item_effect: "" };
  }

  /** 官方：點格子設 shop_select 後呼叫，更新名字等等，但不碰 item_place。 */
  show_detail(): void {
    const t = this.shopData.find(({ id }) => id === this.shop_select)!;
    this.item_name.setText(this.get_item_info(t).item_name);
  }

  /** 玩家點了上方某一格。 */
  select(entry: ShopEntry): void {
    this.shop_select = entry.id;
    this.show_detail();
  }

  /** ⚠ 照抄官方，含那刀 [20]。這是被測物要對帳的對象。 */
  get_max_purchase(t: FakeItem): number {
    const e = [OFFICIAL_QUANTITY_CAP];
    const s = this.get_money();
    if (t.price.gem > 0) e.push(Math.trunc(s.gem / t.price.gem));
    if (t.price.item_10001 > 0) e.push(Math.trunc(s.item_10001 / t.price.item_10001));
    if (t.price.item_10011 > 0) e.push(Math.trunc(s.item_10011 / t.price.item_10011));
    if (t.upper !== null) {
      let i = t.upper;
      const c = this.shop_config.find(({ shop_id }) => shop_id === t.id);
      if (c) i -= c.quantity;
      e.push(i);
    }
    return Math.min(...e);
  }

  create_purchase_screen(t: FakeItem): void {
    this.server.prices.set(t.id, t.price.gem);
    const i = this.get_max_purchase(t);
    const n = { id: t.id, quantity: 1 };
    const o: Option[] = [];
    for (let E = 0; E < Math.max(i, 1); E++) o[E] = { text: `${E + 1}`, value: E + 1 };
    this.children.list.push(new FakeObject()); // 背景之類的
    const dd = this.rexUI.add.dropDownList({
      options: o,
      list: {
        onButtonClick: (opt) => {
          n.quantity = opt.value;
        },
      },
    });
    this.children.list.push(new FakeObject());
    this.last = {
      dd,
      // 照抄官方 ok 的 pointerup
      ok: async () => {
        const r = (await this.socket.fetch("shop_buy", n.id, n.quantity)) as BuyResponse;
        if (r.error !== null || r.rm_process !== null) {
          if (!(r.error === null && r.rm_process !== null)) await this.shop_error(r.error!);
        } else await this.show_dialogue_success();
      },
      preview: () => this.player.gem - t.price.gem * n.quantity,
    };
  }
}

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> }; registry: { get(key: string): unknown } };
  lang: string;
  [key: string]: unknown;
}

interface FakeGame {
  window: FakeWindow;
  shop: FakeShopScene;
}

function makeGame(money: Partial<Money> = { gem: 5404 }): FakeGame {
  const shop = new FakeShopScene(money);
  const registry = { get: (key: string) => (key === "ShopData" ? shop.shopData : undefined) };
  return { window: { game: { scene: { keys: { Shop: shop } }, registry }, lang: "tcn" }, shop };
}

function price(p: Partial<Price>): Price {
  return { gem: 0, rm: 0, point: 0, item_10001: 0, item_10011: 0, ...p };
}

/** 白色石楠1，200 GEM。 */
const HEATHER: FakeItem = { id: 3230, price: price({ gem: 200 }), upper: null };

let poll: (() => void) | null = null;

/** `cleared` 收 clearInterval 拿到的 id。 */
function run(game: FakeGame, expression: string, cleared: unknown[] = []): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: FakeWindow,
    si: (fn: () => void, ms: number) => number,
    ci: (id: unknown) => void,
  ) => string;
  return fn(
    game.window,
    (cb) => {
      poll = cb;
      return 1;
    },
    (id) => {
      cleared.push(id);
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

/** 按購買，回傳這次的數量下拉。 */
function open(game: FakeGame, item: FakeItem = HEATHER): FakeDropDown {
  game.shop.create_purchase_screen(item);
  return game.shop.last!.dd;
}

// ---------------------------------------------------------------------------

describe("商店的購買數量檔位", () => {
  it("GEM 商品：數量下拉換成檔位表，只留買得起的", () => {
    // gem 5404 / 200 = 27 → 官方 1..20，我們 ≤27 那幾檔
    const game = makeGame({ gem: 5404 });
    install(game);
    const dd = open(game);
    expect(dd.values()).toEqual([1, 2, 3, 5, 7, 10, 15, 20]);
    expect(status(game)).toMatchObject({
      active: true,
      max: 27,
      tiers: [1, 2, 3, 5, 7, 10, 15, 20],
      reason: null,
    });
  });

  it("GEM 充足時 14 個檔位全出，而且是照 QUANTITY_TIERS 的順序", () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    expect(open(game).values()).toEqual([...QUANTITY_TIERS]);
    expect(status(game).max).toBe(1564);
  });

  it("不夠買 20 個就看不到 20（跟官方一樣）", () => {
    const game = makeGame({ gem: 1800 }); // 9 個
    install(game);
    expect(open(game).values()).toEqual([1, 2, 3, 5, 7]);
    expect(status(game).max).toBe(9);
  });

  // ── 分批 ────────────────────────────────────────────────────────────────

  it("選 500 按 ok：拆成 25 批各 20 依序送，官方跳成功框，對帳通過", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    const dd = open(game);
    dd.pick(500);
    expect(game.shop.last!.preview()).toBe(312_900 - 200 * 500);
    await game.shop.last!.ok();
    expect(game.shop.socket.shopBuys()).toEqual(Array(25).fill(20));
    expect(game.shop.socket.calls.every((c) => c[1] === 3230)).toBe(true);
    expect(game.shop.outcome).toBe("success");
    expect(game.shop.server.gem).toBe(312_900 - 200 * 500);
    tick(); // 官方重抓過 player，輪詢對帳
    expect(status(game).lastBuy).toEqual({
      requested: 500,
      bought: 500,
      batches: 25,
      expectedGemDelta: -100_000,
      gemDelta: -100_000,
      verified: true,
    });
    expect(status(game).reason).toBeNull();
  });

  it("白色石楠3 買 30 個 → 20 + 10", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game, { id: 6622, price: price({ gem: 540 }), upper: null });
    game.shop.last!.dd.pick(30);
    await game.shop.last!.ok();
    expect(game.shop.socket.shopBuys()).toEqual([20, 10]);
    expect(game.shop.server.gem).toBe(312_900 - 540 * 30);
  });

  it("≤20 原樣放行，一個請求", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(15);
    await game.shop.last!.ok();
    expect(game.shop.socket.shopBuys()).toEqual([15]);
    expect(status(game).lastBuy).toBeNull();
  });

  it("別的事件、別的商品的 shop_buy 原樣放行", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game);
    expect(await game.shop.socket.fetch("db_event")).toEqual({ echo: "db_event" });
    await game.shop.socket.fetch("shop_buy", 9999, 40);
    expect(game.shop.socket.shopBuys()).toEqual([40]);
  });

  it("課金品開的框不接手（下拉沒換，就沒有 pending）", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game); // 先開一個 GEM 的
    open(game, { id: 6717, price: price({ rm: 135 }), upper: null }); // 再開課金的
    await game.shop.socket.fetch("shop_buy", 3230, 40); // 就算送了 GEM 那件也不接手
    expect(game.shop.socket.shopBuys()).toEqual([40]);
  });

  it("一個框只接手一次", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(50);
    await game.shop.last!.ok();
    await game.shop.socket.fetch("shop_buy", 3230, 50);
    expect(game.shop.socket.shopBuys()).toEqual([20, 20, 10, 50]);
  });

  it("中途失敗：停下、回成功形狀讓官方重抓，短少寫進 reason", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(500);
    game.shop.socket.failAt = 3;
    await game.shop.last!.ok();
    expect(game.shop.socket.shopBuys()).toEqual([20, 20, 20]);
    expect(game.shop.outcome).toBe("success");
    tick();
    const s = status(game);
    expect(s.lastBuy).toMatchObject({ requested: 500, bought: 40, batches: 3, verified: true });
    expect(s.reason).toContain("40 / 500");
  });

  it("第一批就失敗：原樣交回官方跳錯誤框，不留 lastBuy", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(500);
    game.shop.socket.failAt = 1;
    await game.shop.last!.ok();
    expect(game.shop.outcome).toBe("error:NOT_ENOUGH");
    expect(status(game).lastBuy).toBeNull();
  });

  it("第一批就逾時：例外照丟（跟官方一樣）", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(500);
    game.shop.socket.throwAt = 1;
    await expect(game.shop.last!.ok()).rejects.toThrow("timed out");
    expect(game.shop.socket.shopBuys()).toEqual([20]);
  });

  it("數量超過開框時的上限：一個都不送", async () => {
    const game = makeGame({ gem: 5404 }); // 27 個
    install(game);
    open(game);
    const r = await game.shop.socket.fetch("shop_buy", 3230, 500);
    expect(r).toEqual({ error: "DEFAULT", rm_process: null });
    expect(game.shop.socket.shopBuys()).toEqual([]);
    expect(status(game).reason).toContain("一個都沒送");
  });

  it("伺服器扣的跟預期不同：對帳不符寫進 reason", async () => {
    const game = makeGame({ gem: 312_900 });
    install(game);
    open(game).pick(50);
    game.shop.socket.overcharge = 1;
    await game.shop.last!.ok();
    tick();
    const s = status(game);
    expect(s.lastBuy).toMatchObject({ verified: false, gemDelta: -201 * 50 });
    expect(s.reason).toContain("對帳不符");
  });

  it("文字照官方格式：text 是字串、value 是數字", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    const dd = open(game);
    expect(dd.options[0]).toEqual({ text: "1", value: 1 });
  });

  // ── 閘門 ────────────────────────────────────────────────────────────────

  it("課金商品（price.rm > 0）完全不碰", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    const dd = open(game, { id: 6717, price: price({ rm: 135 }), upper: null });
    expect(dd.values()).toHaveLength(20);
    expect(status(game)).toMatchObject({ active: false, reason: null });
  });

  it("碎片商品（item_10011，gem=0）完全不碰", () => {
    const game = makeGame({ gem: 999_999, item_10011: 999 });
    install(game);
    const dd = open(game, { id: 1, price: price({ item_10011: 2 }), upper: null });
    expect(dd.values()).toHaveLength(20);
  });

  it("活動點數商品完全不碰，就算也標了 GEM", () => {
    const game = makeGame({ gem: 999_999, point: 999 });
    install(game);
    const dd = open(game, { id: 1, price: price({ gem: 1, point: 1 }), upper: null });
    expect(dd.values()).toHaveLength(20);
  });

  // ── 上限 ────────────────────────────────────────────────────────────────

  it("購買上限（upper − 已買）會壓住檔位", () => {
    const game = makeGame({ gem: 999_999 });
    game.shop.shop_config = [{ shop_id: 77, quantity: 10 }];
    install(game);
    const dd = open(game, { id: 77, price: price({ gem: 200 }), upper: 60 });
    expect(dd.values()).toEqual([1, 2, 3, 5, 7, 10, 15, 20, 30, 50]);
    expect(status(game).max).toBe(50);
  });

  it("GEM+角色碎片商品：碎片不夠時以碎片為準", () => {
    const game = makeGame({ gem: 999_999, item_10001: 530 });
    install(game);
    const dd = open(game, { id: 1, price: price({ gem: 1000, item_10001: 11 }), upper: null });
    // 530 / 11 = 48
    expect(dd.values()).toEqual([1, 2, 3, 5, 7, 10, 15, 20, 30]);
    expect(status(game).max).toBe(48);
  });

  it("對帳不符（官方公式變了）就不碰，原因說得出來", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    // 官方公式改了：回 20，但照我們抄的公式只買得起 5 個
    const realGetMoney = game.shop.get_money.bind(game.shop);
    game.shop.get_money = () => ({ ...realGetMoney(), gem: 1000 });
    const official = game.shop.get_max_purchase.bind(game.shop);
    game.shop.get_max_purchase = (t) => Math.max(official(t), OFFICIAL_QUANTITY_CAP);
    const dd = open(game);
    expect(dd.values()).toHaveLength(20);
    expect(status(game).active).toBe(false);
    expect(status(game).reason).toContain("對帳");
  });

  it("官方下拉的選項數跟上限對不上就不碰", () => {
    const game = makeGame({ gem: 999_999 });
    const orig = FakeShopScene.prototype.create_purchase_screen;
    game.shop.get_max_purchase = () => 20;
    // 官方改成只建 10 項
    Object.getPrototypeOf(game.shop).create_purchase_screen = function (
      this: FakeShopScene,
      t: FakeItem,
    ) {
      orig.call(this, t);
      this.last!.dd.options.splice(10);
    };
    try {
      install(game);
      const dd = open(game);
      expect(dd.values()).toHaveLength(10);
      expect(status(game).reason).toContain("選項");
    } finally {
      FakeShopScene.prototype.create_purchase_screen = orig;
    }
  });

  // ── 生命週期 ────────────────────────────────────────────────────────────

  it("確認框再開一次：新的下拉照樣換", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    open(game);
    const second = open(game);
    expect(second.values()).toEqual([...QUANTITY_TIERS]);
  });

  it("Shop 場景晚出現：輪詢到了才包", () => {
    const game = makeGame({ gem: 999_999 });
    const shop = game.shop;
    delete game.window.game.scene.keys.Shop;
    install(game);
    expect(Object.prototype.hasOwnProperty.call(shop, "create_purchase_screen")).toBe(false);
    game.window.game.scene.keys.Shop = shop;
    tick();
    expect(open(game).values()).toEqual([...QUANTITY_TIERS]);
  });

  it("場景的形狀變了就說出來，不包", () => {
    const game = makeGame();
    (game.shop as unknown as Record<string, unknown>).get_max_purchase = undefined;
    install(game);
    expect(status(game).reason).toContain("形狀變了");
    expect(Object.prototype.hasOwnProperty.call(game.shop, "create_purchase_screen")).toBe(false);
  });

  it("拆得乾淨：方法還原成原型那支、旗標刪除、輪詢停掉", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    expect(Object.prototype.hasOwnProperty.call(game.shop, "create_purchase_screen")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(game.shop.socket, "fetch")).toBe(true);
    expect(run(game, SHOP_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(game.shop, "create_purchase_screen")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(game.shop.socket, "fetch")).toBe(false);
    expect(game.window.__ulrShop).toBeUndefined();
    expect(poll).toBeNull();
    expect(open(game).values()).toHaveLength(20);
    expect(status(game).installed).toBe(false);
  });

  it("重裝從原狀開始：不會包兩層", () => {
    const game = makeGame({ gem: 999_999 });
    install(game);
    const first = game.shop.create_purchase_screen;
    install(game);
    const second = game.shop.create_purchase_screen;
    expect(second).not.toBe(first);
    expect(open(game).values()).toEqual([...QUANTITY_TIERS]);
    run(game, SHOP_UNINSTALL_EXPRESSION);
    expect(game.shop.create_purchase_screen).toBe(FakeShopScene.prototype.create_purchase_screen);
  });

  it("v1 留在頁面上的狀態也拆得掉", () => {
    const game = makeGame({ gem: 999_999 });
    const cleared: unknown[] = [];
    game.window.__ulrShop = { version: 1, timer: 9, mine: null, orig: null };
    run(game, buildShopPatchScript(), cleared);
    expect(cleared).toEqual([9]);
    expect(status(game).version).toBe(SHOP_SCRIPT_VERSION);
  });

  it("狀態帶著版本號，而且沒裝的時候說得出來", () => {
    const game = makeGame();
    expect(status(game)).toEqual({
      installed: false,
      version: null,
      active: false,
      tiers: [],
      max: null,
      lastBuy: null,
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
    expect(open(game).values()).toEqual([1, 10, 50]);
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

describe("商店的專武：使用場所填角色名", () => {
  it("點專武：使用場所顯示角色名，官方面板照常更新", () => {
    const game = makeGame();
    install(game);
    game.shop.select(WEAPON_89);
    expect(game.shop.item_name.text).toBe("毒鐵線");
    expect(game.shop.item_place.text).toBe("薩爾卡多");
    expect(status(game).reason).toBeNull();
  });

  it("通用武器（chara null）與魔之刀身那類（cc000）照舊「-」", () => {
    const game = makeGame();
    install(game);
    game.shop.select(GENERIC_1);
    expect(game.shop.item_place.text).toBe("-");
    game.shop.select(MATERIAL_5005);
    expect(game.shop.item_place.text).toBe("-");
  });

  it("從專武換點別的：變回「-」", () => {
    const game = makeGame();
    install(game);
    game.shop.select(WEAPON_89);
    game.shop.select(POTION);
    expect(game.shop.item_place.text).toBe("-");
  });

  it("跟武器撞號的事件卡不會被標成專武", () => {
    const game = makeGame();
    install(game);
    game.shop.select(EVENT_89);
    expect(game.shop.item_name.text).toBe("某張事件卡");
    expect(game.shop.item_place.text).toBe("-");
  });

  it("數量大於 1 的武器商品（名字接 xN）照樣標", () => {
    const game = makeGame();
    const pack: ShopEntry = { id: 7000, item: [{ type: 2, id: 89, slot: 0, amount: 3 }] };
    game.shop.shopData.push(pack);
    install(game);
    game.shop.select(pack);
    expect(game.shop.item_name.text).toBe("毒鐵線 x3");
    expect(game.shop.item_place.text).toBe("薩爾卡多");
  });

  it("官方顯示的名字跟那把武器對不上（type/slot 常數變了）就不標", () => {
    const game = makeGame();
    install(game);
    game.shop.get_item_info = () => ({ item_name: "別的東西", item_effect: "" });
    game.shop.select(WEAPON_89);
    expect(game.shop.item_place.text).toBe("-");
  });

  it("裝上時面板已經停在專武上：立刻補上", () => {
    const game = makeGame();
    game.shop.select(WEAPON_89);
    expect(game.shop.item_place.text).toBe("-");
    install(game);
    expect(game.shop.item_place.text).toBe("薩爾卡多");
  });

  it("重裝不會包兩層，面板維持角色名", () => {
    const game = makeGame();
    install(game);
    game.shop.select(WEAPON_89);
    install(game);
    expect(game.shop.item_place.text).toBe("薩爾卡多");
    const wrapped = game.shop.show_detail;
    install(game);
    expect(game.shop.show_detail).not.toBe(wrapped);
    run(game, SHOP_UNINSTALL_EXPRESSION);
    expect(game.shop.show_detail).toBe(FakeShopScene.prototype.show_detail);
  });

  it("拆掉：show_detail 還原成原型那支、使用場所變回「-」", () => {
    const game = makeGame();
    install(game);
    game.shop.select(WEAPON_89);
    expect(run(game, SHOP_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(game.shop, "show_detail")).toBe(false);
    expect(game.shop.item_place.text).toBe("-");
    game.shop.select(WEAPON_89);
    expect(game.shop.item_place.text).toBe("-");
  });

  it("我們這段出錯不影響官方的面板，原因寫進 reason", () => {
    const game = makeGame();
    install(game);
    game.shop.cache.json.get = () => {
      throw new Error("cache 壞了");
    };
    game.shop.select(WEAPON_89);
    expect(game.shop.item_name.text).toBe("毒鐵線");
    expect(status(game).reason).toContain("專武");
  });
});
