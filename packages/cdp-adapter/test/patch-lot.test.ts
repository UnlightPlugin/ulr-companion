/**
 * 暗房（抽卡）預覽：已有的調暗、事件卡標持有數
 *
 * 跟 `patch-shop` 同一套：搭一個夠像的假遊戲，把 `buildLotPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-26 從跑著的客戶端挖出來的形狀寫：
 *
 * ```js
 *   create_preview(key, scroll) → { sprites: [...lot_frame nineslice, ...卡 Container] }
 *   // 卡跟 lot_data[key].data 同序；每張卡底下是 Zone + Image/Text（能 tint）
 *   show_preview：preview 是 null 就 create_preview 一份新的
 *   socket.fetch("lot_start" | "lot_select") → { result: [{id, type, slot, amount, tier}] }
 *   registry：weapon_card / event_card（card_id, quantity）、avatar_parts（parts_id）
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 只調暗 Avatar 裝飾與**專武**（通用武器、角色卡、道具都不碰）
 * 2. 抽到的東西 registry 不會更新 —— 要從官方回應記；registry 換了陣列要丟掉記錄
 * 3. 重新進暗房（官方勾選換了一個）要重掛勾選 —— 場景是長命的
 * 4. 拆掉時 create_preview／socket.fetch 還給官方、調暗的卡恢復
 */

import { describe, expect, it } from "vitest";
import {
  buildLotPatchScript,
  DIM_TOOLTIP,
  LOT_DIM_STORAGE_KEY,
  LOT_DIM_TINT,
  LOT_SCRIPT_VERSION,
  LOT_STATUS_EXPRESSION,
  LOT_UNINSTALL_EXPRESSION,
  parseLotStatus,
} from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeObject {
  scene: object | undefined = {};
  type = "Object";
  handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler): this {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
  destroy(): void {
    this.scene = undefined;
  }
  setDepth(): this {
    return this;
  }
  setOrigin(): this {
    return this;
  }
}

class FakeTintable extends FakeObject {
  tint: number | null = null;
  setTint(c: number): this {
    this.tint = c;
    return this;
  }
  clearTint(): this {
    this.tint = null;
    return this;
  }
}

class FakeText extends FakeTintable {
  override type = "Text";
  constructor(
    public x: number,
    public y: number,
    public text: string,
  ) {
    super();
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
  alpha = 1;
  interactive = false;
  setPadding(): this {
    return this;
  }
  setBackgroundColor(): this {
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setInteractive(): this {
    this.interactive = true;
    return this;
  }
  getTopRight() {
    return { x: this.x + 52, y: this.y - 8 };
  }
}

class FakeContainer extends FakeObject {
  override type = "Container";
  list: FakeObject[] = [new FakeObject(), new FakeTintable(), new FakeTintable()];
  add(o: FakeObject): this {
    this.list.push(o);
    return this;
  }
  override destroy(): void {
    for (const o of this.list) o.destroy();
    super.destroy();
  }
  /** 卡本身的圖（不含我們加的持有數）。 */
  art(): FakeTintable[] {
    return this.list.filter(
      (o): o is FakeTintable => o instanceof FakeTintable && !(o instanceof FakeText),
    );
  }
  own(): FakeText | undefined {
    return this.list.find((o): o is FakeText => o instanceof FakeText && o.scene !== undefined);
  }
}

class FakeCheckbox extends FakeObject {
  override type = "rexCheckbox";
  value: boolean;
  constructor(
    public x: number,
    public y: number,
    checked: boolean,
  ) {
    super();
    this.value = checked;
  }
  getCenter() {
    return { x: this.x, y: this.y };
  }
  getTopRight() {
    return { x: this.x + 7, y: this.y - 7 };
  }
  getTopLeft() {
    return { x: this.x - 7, y: this.y - 7 };
  }
  click(): void {
    this.value = !this.value;
    this.emit("valuechange", this.value);
  }
}

interface Item {
  tier: number;
  type: number;
  slot: number;
  id: number;
  amount: number;
}

class FakeSocket {
  pending: Array<(v: unknown) => void> = [];
  calls: string[] = [];
}
(FakeSocket.prototype as unknown as { fetch: unknown }).fetch = function (
  this: FakeSocket,
  name: string,
): Promise<unknown> {
  this.calls.push(name);
  return new Promise((resolve) => this.pending.push(resolve));
};

interface Preview {
  sprites: FakeObject[];
}

/**
 * 實測的形狀：同一角色 10 張，前 5 張 L1〜L5（rarity 5）、後 5 張 R1〜R5（rarity 6〜10）。
 * cc034 史塔夏 331〜340、cc035 沃蘭德 341〜350、cc050 古斯塔夫 491〜500。
 */
const CHARA_CARDS = [
  ["cc034", 331],
  ["cc035", 341],
  ["cc050", 491],
].flatMap(([chara, base]) =>
  Array.from({ length: 10 }, (_, i) => ({
    id: (base as number) + i,
    chara,
    level: (i % 5) + 1,
    rarity: i < 5 ? 5 : 6 + (i - 5),
  })),
);

class FakeLot {
  /** 在原型上（跟官方一樣），腳本包的那層才會是場景實例自己的屬性。 */
  declare create_preview: (key: string, scroll: number) => Preview;
  active = true;
  sys = { isActive: () => this.active };
  reg: Record<string, unknown[]> = {};
  registry = { get: (k: string) => this.reg[k] };
  cache = {
    json: {
      get: (k: string) =>
        k === "WeaponCards"
          ? [
              { id: 17, chara: null },
              { id: 26, chara: "cc001" },
              { id: 158, chara: "cc045" },
            ]
          : k === "CharaCards"
            ? CHARA_CARDS
            : k === "Characters"
              ? {
                  // 實測：json 只載當前語言那一份，另有 name_another（英文副標）
                  cc001: { id: 1, name_tcn: "艾伯李斯特", name_another: "- Lord - Evarist" },
                  cc045: { id: 45, name_ja: "フロレンス", name_another: "- x -" },
                }
              : null,
    },
  };
  lot_data: Record<string, { data: Item[] }> = {};
  lot_contents: Record<string, { preview: Preview | null }> = {};
  option_auto_check: FakeCheckbox = new FakeCheckbox(691, 424, true);
  socket: FakeSocket = new FakeSocket();
  texts: FakeText[] = [];
  checks: FakeCheckbox[] = [];
  add = {
    text: (x: number, y: number, t: string) => {
      const o = new FakeText(x, y, t);
      this.texts.push(o);
      return o;
    },
  };
  rexUI = {
    add: {
      checkbox: (cfg: { x: number; y: number; checked?: boolean }) => {
        const c = new FakeCheckbox(cfg.x, cfg.y, cfg.checked === true);
        this.checks.push(c);
        return c;
      },
    },
  };
  /** 重新進暗房：官方的勾選、socket 都是新的，場景物件不變。 */
  enter(): void {
    this.option_auto_check.destroy();
    this.option_auto_check = new FakeCheckbox(691, 424, true);
    this.socket = new FakeSocket();
  }
  /** 滑過某一抽的按鈕。 */
  show(key: string): FakeContainer[] {
    const ct = (this.lot_contents[key] ??= { preview: null });
    const preview = (ct.preview ??= this.create_preview(key, 0));
    return preview.sprites.filter((s): s is FakeContainer => s instanceof FakeContainer);
  }
  hide(key: string): void {
    const ct = this.lot_contents[key];
    if (!ct?.preview) return;
    for (const s of ct.preview.sprites) s.destroy();
    ct.preview = null;
  }
}
(FakeLot.prototype as unknown as { create_preview: unknown }).create_preview = function (
  this: FakeLot,
  key: string,
): Preview {
  const frame = new FakeObject();
  frame.type = "NineSlice";
  return { sprites: [frame, ...this.lot_data[key]!.data.map(() => new FakeContainer())] };
};

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> } };
  lang: string;
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  [k: string]: unknown;
}

function makeGame(storage: Record<string, string> = {}) {
  const lot = new FakeLot();
  lot.lot_data = {
    gold: {
      data: [
        { tier: 1, type: 1, slot: 0, id: 339, amount: 1 }, // 角色卡
        { tier: 1, type: 2, slot: 2, id: 7, amount: 1 }, // 事件卡 劍7
        { tier: 4, type: 2, slot: 0, id: 26, amount: 1 }, // 專武（有）
        { tier: 4, type: 2, slot: 0, id: 158, amount: 1 }, // 專武（沒有）
        { tier: 5, type: 3, slot: 0, id: 12, amount: 7 }, // 道具
      ],
    },
    bronze: {
      data: [
        { tier: 1, type: 2, slot: 0, id: 17, amount: 1 }, // 通用武器（有）
        { tier: 4, type: 4, slot: 0, id: 48, amount: 1 }, // 髮帶（有）
        { tier: 5, type: 4, slot: 0, id: 535, amount: 1 }, // 娃娃（沒有）
      ],
    },
  };
  lot.reg = {
    weapon_card: [
      { card_id: 17, quantity: 3 },
      { card_id: 26, quantity: 1 },
    ],
    event_card: [{ card_id: 7, quantity: 2 }],
    avatar_parts: [{ parts_id: 48, quantity: 1 }],
  };
  const window: FakeWindow = {
    game: { scene: { keys: { Lot: lot } } },
    lang: "tcn",
    localStorage: {
      getItem: (k) => (k in storage ? storage[k]! : null),
      setItem: (k, v) => {
        storage[k] = v;
      },
    },
  };
  return { window, lot, storage };
}

type FakeGame = ReturnType<typeof makeGame>;

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

function install(game: FakeGame): string {
  return run(game, buildLotPatchScript());
}

function tick(): void {
  expect(poll).not.toBeNull();
  poll!();
}

function status(game: FakeGame) {
  return parseLotStatus(run(game, LOT_STATUS_EXPRESSION));
}

const dimmed = (c: FakeContainer) => c.art().every((o) => o.tint === LOT_DIM_TINT);
const plain = (c: FakeContainer) => c.art().every((o) => o.tint === null);

/** 讓 then 裡的回呼跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

describe("暗房預覽", () => {
  it("自動選卡下面多一個勾選，預設勾著、字跟遊戲語言", () => {
    const game = makeGame();
    install(game);
    expect(game.lot.checks).toHaveLength(1);
    const [check] = game.lot.checks;
    expect(check!.x).toBe(691);
    expect(check!.y).toBe(424 + 18);
    expect(check!.value).toBe(true);
    expect(game.lot.texts.map((t) => t.text)).toEqual(["調暗已有"]);
    expect(status(game)).toMatchObject({
      installed: true,
      version: LOT_SCRIPT_VERSION,
      mounted: true,
      dimOwned: true,
    });
  });

  it("滑過勾選或字：浮出說明框（跟遊戲語言），移開就收掉", () => {
    const game = makeGame();
    install(game);
    const [check] = game.lot.checks;
    const label = game.lot.texts[0]!;
    expect(label.interactive).toBe(true);
    check!.emit("pointerover");
    const tip = game.lot.texts[1]!;
    expect(tip.text).toBe(DIM_TOOLTIP.tcn);
    expect(tip.alpha).toBe(1);
    expect(tip.y).toBeLessThan(check!.y); // 貼在勾選上方
    check!.emit("pointerout");
    expect(tip.scene).toBeUndefined();
    // 字也會觸發；同一時間只有一個
    label.emit("pointerover");
    label.emit("pointerover");
    expect(
      game.lot.texts.filter((t) => t.scene !== undefined && t.text === DIM_TOOLTIP.tcn),
    ).toHaveLength(1);
    // 拆除時一起收
    run(game, LOT_UNINSTALL_EXPRESSION);
    expect(game.lot.texts.every((t) => t.scene === undefined)).toBe(true);
  });

  it("銅抽：已有的 Avatar 裝飾調暗；通用武器不暗、跟事件卡一樣標持有數", () => {
    const game = makeGame();
    install(game);
    const [weapon, ribbon, doll] = game.lot.show("bronze");
    expect(plain(weapon!)).toBe(true); // 黑的槍劍：通用武器，重複有用
    expect(weapon!.own()?.text).toBe("Own 3");
    expect(ribbon!.own()).toBeUndefined();
    expect(dimmed(ribbon!)).toBe(true);
    expect(plain(doll!)).toBe(true);
  });

  it("金抽：已有的專武調暗，角色卡與道具不動；事件卡標持有數", () => {
    const game = makeGame();
    install(game);
    const [chara, event, owned, notOwned, item] = game.lot.show("gold");
    expect(plain(chara!)).toBe(true);
    expect(dimmed(owned!)).toBe(true);
    expect(plain(notOwned!)).toBe(true);
    expect(plain(item!)).toBe(true);
    expect(event!.own()?.text).toBe("Own 2");
    expect(chara!.own()).toBeUndefined();
    expect(item!.own()).toBeUndefined();
  });

  it("專武標主人名字：WeaponCards.chara 對 Characters，跟遊戲語言；調暗時名字不暗", () => {
    const game = makeGame();
    install(game);
    const [, , owned, notOwned] = game.lot.show("gold");
    expect(owned!.own()?.text).toBe("艾伯李斯特");
    expect(owned!.own()?.tint).toBeNull();
    expect(dimmed(owned!)).toBe(true);
    // 沒有當前語言的名字：退回 json 裡有的那一份，不拿 name_another
    expect(notOwned!.own()?.text).toBe("フロレンス");
    // 取消勾選也照標
    game.lot.checks[0]!.click();
    expect(owned!.own()?.text).toBe("艾伯李斯特");
  });

  it("角色卡：L 卡看整個角色（L1〜L5、R1〜R5 任一張），R 卡只看自己", () => {
    const game = makeGame();
    game.lot.lot_data.chara = {
      data: [
        { tier: 3, type: 1, slot: 0, id: 333, amount: 1 }, // 史塔夏 L3：手上只有 L1 → 暗
        { tier: 1, type: 1, slot: 0, id: 339, amount: 1 }, // 史塔夏 R4：沒有這張 → 原色
        { tier: 1, type: 1, slot: 0, id: 336, amount: 1 }, // 史塔夏 R1：有 → 暗
        { tier: 3, type: 1, slot: 0, id: 343, amount: 1 }, // 沃蘭德 L3：只有 R5 → 暗
        { tier: 3, type: 1, slot: 0, id: 493, amount: 1 }, // 古斯塔夫 L3：整個角色都沒有 → 原色
      ],
    };
    game.lot.reg.chara_card = [
      { card_id: 331, quantity: 1 },
      { card_id: 336, quantity: 1 },
      { card_id: 350, quantity: 1 },
    ];
    install(game);
    const [l3, r4, r1, other, none] = game.lot.show("chara");
    expect(dimmed(l3!)).toBe(true);
    expect(plain(r4!)).toBe(true);
    expect(dimmed(r1!)).toBe(true);
    expect(dimmed(other!)).toBe(true);
    expect(plain(none!)).toBe(true);
  });

  it("抽到角色卡：官方重抓 chara_card 之前也算數", async () => {
    const game = makeGame();
    game.lot.lot_data.chara = { data: [{ tier: 3, type: 1, slot: 0, id: 493, amount: 1 }] };
    game.lot.reg.chara_card = [];
    install(game);
    const sock = game.lot.socket;
    void (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("lot_start");
    sock.pending[0]!({ result: [{ tier: 2, type: 1, slot: 0, id: 497, amount: 1 }] });
    await flush();
    expect(dimmed(game.lot.show("chara")[0]!)).toBe(true);
  });

  it("暗房輪替：沒見過的 id 照類型處理（裝飾、事件卡、專武都不是寫死清單）", () => {
    const game = makeGame();
    game.lot.lot_data.next = {
      data: [
        { tier: 5, type: 4, slot: 0, id: 9001, amount: 1 }, // 新的裝飾（有）
        { tier: 5, type: 4, slot: 0, id: 9002, amount: 1 }, // 新的裝飾（沒有）
        { tier: 3, type: 2, slot: 2, id: 9003, amount: 1 }, // 新的事件卡（沒有）
      ],
    };
    game.lot.reg.avatar_parts!.push({ parts_id: 9001, quantity: 1 });
    install(game);
    const [a, b, e] = game.lot.show("next");
    expect(dimmed(a!)).toBe(true);
    expect(plain(b!)).toBe(true);
    expect(e!.own()?.text).toBe("Own 0");
  });

  it("取消勾選：畫著的預覽當場恢復、狀態存進 localStorage；再勾回來又暗", () => {
    const game = makeGame();
    install(game);
    const cards = game.lot.show("bronze");
    game.lot.checks[0]!.click();
    expect(plain(cards[1]!)).toBe(true);
    expect(game.storage[LOT_DIM_STORAGE_KEY]).toBe("0");
    expect(status(game).dimOwned).toBe(false);
    game.lot.checks[0]!.click();
    expect(dimmed(cards[1]!)).toBe(true);
    expect(game.storage[LOT_DIM_STORAGE_KEY]).toBe("1");
  });

  it("上次取消勾選過：重裝後照舊不調暗", () => {
    const game = makeGame({ [LOT_DIM_STORAGE_KEY]: "0" });
    install(game);
    expect(game.lot.checks[0]!.value).toBe(false);
    expect(plain(game.lot.show("bronze")[1]!)).toBe(true);
    // 持有數不受勾選影響
    expect(game.lot.show("gold")[1]!.own()?.text).toBe("Own 2");
  });

  it("抽到的東西從官方回應記下：下次預覽就調暗／持有數加上去", async () => {
    const game = makeGame();
    install(game);
    const sock = game.lot.socket;
    const p = (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("lot_start");
    sock.pending[0]!({
      error: null,
      result: [
        { tier: 5, type: 4, slot: 0, id: 535, amount: 1 },
        { tier: 1, type: 2, slot: 2, id: 7, amount: 1 },
        { tier: 4, type: 2, slot: 0, id: 158, amount: 1 },
      ],
    });
    // 官方拿到的是原封不動的回應
    await expect(p).resolves.toMatchObject({ error: null });
    await flush();
    expect(status(game).won).toBe(3);
    expect(dimmed(game.lot.show("bronze")[2]!)).toBe(true);
    const gold = game.lot.show("gold");
    expect(gold[1]!.own()?.text).toBe("Own 3");
    expect(dimmed(gold[3]!)).toBe(true);
  });

  it("registry 被別的場景刷新過（換了陣列）：記錄丟掉，不重複算", async () => {
    const game = makeGame();
    install(game);
    const sock = game.lot.socket;
    void (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("lot_select");
    sock.pending[0]!({ result: [{ tier: 1, type: 2, slot: 2, id: 7, amount: 1 }] });
    await flush();
    game.lot.reg.event_card = [{ card_id: 7, quantity: 3 }];
    expect(game.lot.show("gold")[1]!.own()?.text).toBe("Own 3");
  });

  it("其他請求照樣傳過去、不記", async () => {
    const game = makeGame();
    install(game);
    const sock = game.lot.socket;
    void (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("get_dialogue");
    sock.pending[0]!({ result: [{ tier: 5, type: 4, slot: 0, id: 535, amount: 1 }] });
    await flush();
    expect(sock.calls).toEqual(["get_dialogue"]);
    expect(status(game).won).toBe(0);
  });

  it("重新進暗房：官方勾選換了一個 → 我們的勾選重掛、新 socket 也掛上", async () => {
    const game = makeGame();
    install(game);
    const first = game.lot.checks[0]!;
    game.lot.enter();
    tick();
    expect(game.lot.checks).toHaveLength(2);
    expect(first.scene).toBeUndefined();
    const sock = game.lot.socket;
    void (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("lot_start");
    sock.pending[0]!({ result: [{ tier: 5, type: 4, slot: 0, id: 535, amount: 1 }] });
    await flush();
    expect(status(game).won).toBe(1);
    // 同一個官方勾選不重掛
    tick();
    expect(game.lot.checks).toHaveLength(2);
  });

  it("不在暗房時不掛勾選", () => {
    const game = makeGame();
    game.lot.active = false;
    install(game);
    expect(game.lot.checks).toHaveLength(0);
    expect(status(game).mounted).toBe(false);
    game.lot.active = true;
    tick();
    expect(status(game).mounted).toBe(true);
  });

  it("重裝：先拆再裝，不會包兩層，抽到的記錄帶過去", async () => {
    const game = makeGame();
    install(game);
    const sock = game.lot.socket;
    void (sock as unknown as { fetch(n: string): Promise<unknown> }).fetch("lot_start");
    sock.pending[0]!({ result: [{ tier: 5, type: 4, slot: 0, id: 535, amount: 1 }] });
    await flush();
    install(game);
    expect(game.lot.checks.filter((c) => c.scene !== undefined)).toHaveLength(1);
    expect(status(game).won).toBe(1);
    // 畫面上開著的預覽當場補畫（不必等下次滑過）
    const bronze = game.lot.show("bronze");
    install(game);
    expect(dimmed(bronze[1]!)).toBe(true);
    expect(bronze[0]!.own()?.text).toBe("Own 3");
    const own = Object.prototype.hasOwnProperty.call(game.lot, "create_preview");
    expect(own).toBe(true);
    const wrapped = (game.lot as unknown as { create_preview: { __ulrLot?: boolean } })
      .create_preview;
    expect(wrapped.__ulrLot).toBe(true);
    // 包一層而已：拆掉就回到原型上的那支
    run(game, LOT_UNINSTALL_EXPRESSION);
    expect(Object.prototype.hasOwnProperty.call(game.lot, "create_preview")).toBe(false);
  });

  it("拆除：畫著的預覽恢復、持有數拿掉、勾選拆掉、fetch 還給官方", () => {
    const game = makeGame();
    install(game);
    const bronze = game.lot.show("bronze");
    const gold = game.lot.show("gold");
    expect(run(game, LOT_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(plain(bronze[1]!)).toBe(true);
    expect(gold[1]!.own()).toBeUndefined();
    expect(game.lot.checks[0]!.scene).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(game.lot.socket, "fetch")).toBe(false);
    expect(status(game).installed).toBe(false);
    expect(run(game, LOT_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("預覽卡數跟資料對不上：不碰，原因寫進 reason", () => {
    const game = makeGame();
    const orig = FakeLot.prototype as unknown as { create_preview: (k: string) => Preview };
    const saved = orig.create_preview;
    orig.create_preview = function (this: FakeLot, k: string) {
      const p = saved.call(this, k);
      p.sprites.pop();
      return p;
    };
    try {
      install(game);
      const cards = game.lot.show("bronze");
      expect(cards.every(plain)).toBe(true);
      expect(status(game).reason).toMatch(/bronze/);
    } finally {
      orig.create_preview = saved;
    }
  });

  it("讀不懂的狀態當成沒裝", () => {
    expect(parseLotStatus("<html>")).toMatchObject({
      installed: false,
      reason: expect.stringMatching(/讀不懂/),
    });
  });
});
