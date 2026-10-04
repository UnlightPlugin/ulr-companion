/**
 * 牌組編輯畫面的「人物篩選」與「最愛卡片」
 *
 * 跟 `patch-cost-toggle` 同一套：搭一個夠像的假 Edit 場景，把產出來的那一串字
 * 原封不動 `new Function` 起來跑。假場景照 2026-09-26 從跑著的客戶端量的欄位
 * （card_displayed、chara_filter、card_filter、filter_label、arrow_next…）。
 *
 * 要抓的坑：
 *
 * 1. 代表卡挑錯（沒有 L5 要退 L4、R 模式沒有 R 卡要退 L）；手上沒卡的角色不畫
 * 2. 一覽開著時原本那 18 張要藏起來、點不到；勾選後重畫的那 18 張也要；收起來要放回去
 * 3. 點一張 = 在原版的 chara_filter 裡勾選／取消那個角色（可複選）、翻回第一頁、叫原版 refresh
 * 4. 原版自己 refresh（翻頁、切分頁）時一覽要先收起來
 * 5. [Favorite] 開著時 card_filter 之後只剩最愛卡片，再按一次回到全部
 * 6. 拆掉要把包住的 refresh／card_filter 還回去（場景實例是長命的）
 * 7. Equipment：通用武排前面、素材最後；[Chara Weapon] 只留通用武＋牌組角色專武；
 *    畫完 weapon_card 要換回原本那個陣列；「隱藏裝備」鈕認預覽的武器名字
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildCharaPickerPatchScript,
  buildCharaPickerStateExpression,
  CHARA_PICKER_STATUS_EXPRESSION,
  CHARA_PICKER_UNINSTALL_EXPRESSION,
  isCharaPickerMode,
  isCharaPickerReport,
  parseCharaPickerStatus,
  PICK_CARD_SNIPPET,
  WEAPON_VIEW_SNIPPET,
} from "@ulr/cdp-adapter";
import type { CharaPickerMode, CharaPickerState } from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 代表卡
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  level: number;
  rarity: number;
}

// eslint-disable-next-line no-new-func
const pickCard = new Function(`${PICK_CARD_SNIPPET}; return ulrPickCard;`)() as (
  rows: Row[],
  owned: Record<number, boolean>,
  mode: string,
) => { id: number; owned: boolean } | null;

/** 艾伯李斯特：L1..L5 是 1..5，R1..R5 是 6..10（2026-09-26 讀的 CharaCards）。 */
const EVARIST: Row[] = [
  ...[1, 2, 3, 4, 5].map((l) => ({ id: l, level: l, rarity: 5 })),
  ...[1, 2, 3, 4, 5].map((l) => ({ id: 5 + l, level: l, rarity: 5 + l })),
];

function owned(...ids: number[]): Record<number, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

describe("PICK_CARD_SNIPPET", () => {
  it("有 L5 就是 L5", () => {
    expect(pickCard(EVARIST, owned(1, 5, 10), "L5")).toEqual({ id: 5, owned: true });
  });

  it("沒有 L5 退最接近的（玩家的例子：L4）", () => {
    expect(pickCard(EVARIST, owned(1, 4), "L5")).toEqual({ id: 4, owned: true });
  });

  it("一樣近取高的", () => {
    expect(pickCard(EVARIST, owned(2, 4), "L3")).toEqual({ id: 4, owned: true });
  });

  it("R 模式：手上最高等的 R 卡；沒有 R 卡照 L5 挑", () => {
    expect(pickCard(EVARIST, owned(5, 7, 9), "R")).toEqual({ id: 9, owned: true });
    expect(pickCard(EVARIST, owned(3), "R")).toEqual({ id: 3, owned: true });
  });

  it("L 模式只有 R 卡：拿 R 卡", () => {
    expect(pickCard(EVARIST, owned(8), "L5")).toEqual({ id: 8, owned: true });
  });

  it("一張都沒有：照同樣規則挑，標 owned: false", () => {
    expect(pickCard(EVARIST, {}, "L2")).toEqual({ id: 2, owned: false });
    expect(pickCard(EVARIST, {}, "R")).toEqual({ id: 10, owned: false });
    expect(pickCard([], {}, "L5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Equipment 的順序與過濾
// ---------------------------------------------------------------------------

interface WeaponRow {
  id: number;
  chara: string | null;
}

// eslint-disable-next-line no-new-func
const weaponView = new Function(`${WEAPON_VIEW_SNIPPET}; return ulrWeaponView;`)() as (
  list: { card_id: number }[],
  rows: Record<number, WeaponRow>,
  opt: { charaOnly: boolean; deckCharas: string[]; hidden: number[] },
) => { card_id: number }[];

/** 2026-09-26 實機的一小段：妖魔短劍、艾伯專武、艾依查庫專武、冰劍、可可果、異化礦材。 */
const WEAPON_ROWS: Record<number, WeaponRow> = {
  1: { id: 1, chara: null },
  25: { id: 25, chara: null }, // 叮噹星
  26: { id: 26, chara: "cc001" },
  30: { id: 30, chara: "cc002" },
  165: { id: 165, chara: null }, // 冰劍
  276: { id: 276, chara: null }, // 可可果
  5000: { id: 5000, chara: "cc000" }, // 異化礦材
};
const OWNED_WEAPONS = [1, 25, 26, 30, 165, 276, 5000].map((card_id) => ({ card_id, quantity: 1 }));

function ids(list: { card_id: number }[]): number[] {
  return list.map((w) => w.card_id);
}

describe("WEAPON_VIEW_SNIPPET", () => {
  it("平常：通用武全部排前面（冰劍、可可果跟上來），素材最後，什麼都不拿掉", () => {
    const out = weaponView(OWNED_WEAPONS, WEAPON_ROWS, {
      charaOnly: false,
      deckCharas: [],
      hidden: [25],
    });
    expect(ids(out)).toEqual([1, 25, 165, 276, 26, 30, 5000]);
    // 元素是原本那幾個物件（原版拿它們查持有數量）
    expect(out[0]).toBe(OWNED_WEAPONS[0]);
  });

  it("[Chara Weapon]：通用武＋牌組角色的專武（照槽位順序），素材與隱藏的拿掉", () => {
    const out = weaponView(OWNED_WEAPONS, WEAPON_ROWS, {
      charaOnly: true,
      deckCharas: ["cc002", "cc001"],
      hidden: [25, 276],
    });
    expect(ids(out)).toEqual([1, 165, 30, 26]);
  });

  it("[Chara Weapon]、牌組沒有角色：只剩通用武", () => {
    const out = weaponView(OWNED_WEAPONS, WEAPON_ROWS, {
      charaOnly: true,
      deckCharas: [],
      hidden: [],
    });
    expect(ids(out)).toEqual([1, 25, 165, 276]);
  });

  it("WeaponCards 查不到的：留著，排在專武後面、素材前面", () => {
    const out = weaponView([{ card_id: 9999 }, ...OWNED_WEAPONS], WEAPON_ROWS, {
      charaOnly: false,
      deckCharas: [],
      hidden: [],
    });
    expect(ids(out)).toEqual([1, 25, 165, 276, 26, 30, 9999, 5000]);
  });
});

// ---------------------------------------------------------------------------
// 回報與狀態
// ---------------------------------------------------------------------------

describe("回報與狀態", () => {
  it("認得四種回報，其他不收", () => {
    expect(isCharaPickerReport({ type: "card-favorite", card: 776, on: true })).toBe(true);
    expect(isCharaPickerReport({ type: "weapon-hidden", card: 25, on: true })).toBe(true);
    expect(isCharaPickerReport({ type: "weapon-hidden", card: 0, on: true })).toBe(false);
    expect(isCharaPickerReport({ type: "event-favorite", card: 44, on: false })).toBe(true);
    expect(isCharaPickerReport({ type: "event-favorite", card: 44 })).toBe(false);
    expect(isCharaPickerReport({ type: "chara-picker-error", message: "x" })).toBe(true);
    expect(isCharaPickerReport({ type: "card-favorite", card: 776 })).toBe(false);
    expect(isCharaPickerReport({ type: "card-favorite", card: "cc001", on: true })).toBe(false);
    expect(isCharaPickerReport({ type: "cost-toggle", enabled: true })).toBe(false);
  });

  it("模式只收那七種", () => {
    for (const m of ["L1", "L2", "L3", "L4", "L5", "R", "off"])
      expect(isCharaPickerMode(m)).toBe(true);
    expect(isCharaPickerMode("L6")).toBe(false);
  });

  it("讀不懂的狀態當成沒裝", () => {
    expect(parseCharaPickerStatus("nope").installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeObject {
  handlers = new Map<string, Handler[]>();
  destroyed = false;
  visible = true;
  alpha = 1;
  input: { enabled: boolean } | null = null;
  scene: FakeScene | null;
  constructor(
    scene: FakeScene,
    public type: string,
    public x: number,
    public y: number,
    public texture: string | null = null,
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
  setDepth(): this {
    return this;
  }
  setScale(): this {
    return this;
  }
  setDisplaySize(): this {
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setTexture(key?: string): this {
    if (typeof key === "string") this.texture = key;
    return this;
  }
  setFrame(): this {
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setInteractive(): this {
    this.input = { enabled: true };
    return this;
  }
  disableInteractive(): this {
    if (this.input) this.input.enabled = false;
    return this;
  }
  getTopLeft(): { x: number; y: number } {
    return { x: this.x - 24, y: this.y - 8 };
  }
  getTopRight(): { x: number; y: number } {
    return { x: this.x + 28, y: this.y - 8 };
  }
  destroy(): void {
    this.destroyed = true;
    this.scene = null;
  }
}

class FakeText extends FakeObject {
  constructor(
    scene: FakeScene,
    x: number,
    y: number,
    public text: string,
  ) {
    super(scene, "Text", x, y);
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
  setResolution(): this {
    return this;
  }
}

/** 格線上的一張卡：遊戲的卡是 Container，點擊掛在裡面的 zone。 */
class FakeCard extends FakeObject {
  zone: FakeObject;
  constructor(scene: FakeScene, x: number, y: number) {
    super(scene, "Container", x, y);
    this.zone = new FakeObject(scene, "Zone", x, y).setInteractive();
  }
  override disableInteractive(): this {
    this.zone.disableInteractive();
    return this;
  }
  override setInteractive(): this {
    this.zone.setInteractive();
    return this;
  }
}

const CHARA_CARDS = [
  ...[1, 2, 3, 4, 5].map((l) => ({
    id: l,
    chara: "cc001",
    kind: 0,
    level: l,
    rarity: 5,
    filename: `cc001_0${l}`,
  })),
  { id: 11, chara: "cc002", kind: 0, level: 1, rarity: 5, filename: "cc002_01" },
  { id: 12, chara: "cc002", kind: 0, level: 2, rarity: 5, filename: "cc002_02" },
  // 手上一張都沒有的角色：一覽不畫
  { id: 21, chara: "cc003", kind: 0, level: 1, rarity: 5, filename: "cc003_01" },
  { id: 500, chara: "mc001", kind: 1, level: 1, rarity: 2, filename: "mc001_01" },
];

const CHARACTERS = {
  cc001: { name_tcn: "艾伯李斯特", name_en: "Evarist" },
  cc002: { name_tcn: "艾依查庫", name_en: "Izac" },
  cc003: { name_tcn: "古魯瓦爾多", name_en: "Grunwald" },
  mc001: { name_tcn: "怪物" },
};

const WEAPON_NAMES: Record<number, string> = {
  1: "妖魔短劍",
  25: "叮噹星",
  26: "永恆之棘",
  30: "怒",
  165: "冰劍",
  276: "可可果",
  5000: "異化礦材",
};
const WEAPON_CARDS = Object.values(WEAPON_ROWS).map((r) => ({
  ...r,
  name_tcn: WEAPON_NAMES[r.id],
}));

/** 手上的卡（registry 的 chara_card）。 */
const OWNED_CARDS = [
  { card_id: 4, quantity: 2 },
  { card_id: 11, quantity: 1 },
  { card_id: 12, quantity: 1 },
];

class FakeScene {
  objects: FakeObject[] = [];
  active = true;
  category = "chara";
  chara_filter: string[] = [];
  chara_page = 3;
  show_info = true;
  refreshes = 0;
  /** 原版 card_filter 產出、格線要畫的那幾張。 */
  chara_card: { card_id: number; quantity: number }[] = [];
  ulse01 = { play: () => undefined };
  scene = { isActive: () => this.active };
  card_displayed: {
    card_base: FakeObject;
    card: FakeCard;
    stock_label: FakeObject;
    stock_max: FakeObject;
    stock_now: FakeObject;
    penalty: FakeObject[];
  }[] = [];
  filter_btn_drop = new FakeObject(this, "rexDropDownList", 548, 431);
  filter_label = new FakeText(this, 442, 431, "抽出");
  arrow_next = new FakeObject(this, "Image", 340, 431);
  page_btn_label = new FakeText(this, 40, 433, "Page");
  page_now = new FakeText(this, 266, 432, "1");
  card_infomation = new FakeText(this, 0, 0, "");
  btn_copy = { image: null, text: null };
  btn_story = null;
  profile_texts: FakeText[] = [];
  /** 右邊資料面板的底圖：武器／事件卡預覽時是 event_info。 */
  chara_profile_base: { scene: unknown; texture: { key: string } } | null = null;
  /** Equipment：原版在初始化時拿 registry 的陣列、算一次頁數。 */
  weapon_card = OWNED_WEAPONS.map((w) => ({ ...w }));
  weapon_page = 1;
  weapon_page_max = 1;
  /** 牌組 1：艾依查庫、空、艾伯李斯特。 */
  deck = [{ deck_id: 1, chara_card_id: [11, null, 4] as (number | null)[] }];
  deck_now = 1;
  /** 上一次 refresh 在 weapon 分頁畫的那一份（id 順序）。 */
  weaponDrawn: number[] = [];
  /** Event：跟 Equipment 一樣直接畫這個陣列、頁數只在初始化算。id 刻意跟角色卡重疊。 */
  event_card = [3, 4, 44, 60].map((id) => ({ card_id: id, quantity: 1 }));
  event_page = 1;
  event_page_max = 1;
  eventDrawn: number[] = [];
  /** 右邊預覽的卡（原版每次預覽都重建）。 */
  card_preview: unknown = undefined;
  registry = {
    get: (key: string) => (key === "chara_card" ? OWNED_CARDS : undefined),
  };
  cache = {
    json: {
      get: (key: string) =>
        key === "CharaCards"
          ? CHARA_CARDS
          : key === "Characters"
            ? CHARACTERS
            : key === "WeaponCards"
              ? WEAPON_CARDS
              : null,
    },
  };
  textures = {
    // 「最愛卡片」／「隱藏裝備」的貼圖要 canvas 畫；假環境直接當成已經畫好。
    exists: (key: string) => key === "CharaCardImages" || key.startsWith("ulr_fav_btn_"),
    get: () => ({ has: () => true }),
  };
  add = {
    text: (x: number, y: number, t: string) => this.track(new FakeText(this, x, y, t)),
    image: (x: number, y: number, key: string) =>
      this.track(new FakeObject(this, "Image", x, y, key)),
    nineslice: (x: number, y: number, key: string) =>
      this.track(new FakeObject(this, "NineSlice", x, y, key)),
    zone: (x: number, y: number) => this.track(new FakeObject(this, "Zone", x, y)),
  };
  constructor() {
    this.rebuildGrid();
  }
  /** 原版的 refresh：先 card_filter、再把 18 張整個換掉；weapon 分頁直接畫 weapon_card。 */
  refresh(): void {
    this.refreshes += 1;
    if (this.category === "weapon") this.weaponDrawn = this.weapon_card.map((w) => w.card_id);
    else if (this.category === "event") this.eventDrawn = this.event_card.map((e) => e.card_id);
    else this.card_filter();
    this.rebuildGrid();
  }
  /** 右邊預覽一張事件卡（原版：event_info 底圖＋card_preview 裡一張 event_<id>）。 */
  previewEvent(id: number): void {
    this.chara_profile_base = { scene: this, texture: { key: "event_info" } };
    this.profile_texts = [new FakeText(this, 697, 350, "Hp恢復")];
    this.card_preview = {
      scene: this,
      list: [
        { texture: { key: "card_common_base" }, frame: { name: 0 } },
        { texture: { key: "EventCardTypeImages" }, frame: { name: "type_6" } },
        { texture: { key: "EventCardImages" }, frame: { name: `event_${id}` } },
      ],
    };
  }
  /** 右邊預覽一把武器（原版的武器預覽：event_info 底圖＋名字）。 */
  previewWeapon(id: number): void {
    this.chara_profile_base = { scene: this, texture: { key: "event_info" } };
    this.profile_texts = [new FakeText(this, 697, 350, WEAPON_NAMES[id]!)];
    this.card_preview = {
      scene: this,
      list: [{ texture: { key: "WeaponCardImages" }, frame: { name: `weapon_${id}` } }],
    };
  }
  /** 原版的 card_filter（2026-09-26 讀的）：照 chara_filter 從 registry 濾。 */
  card_filter(): void {
    this.chara_card = this.registry.get("chara_card") ?? [];
    if (this.category === "chara" && this.chara_filter.length !== 0) {
      this.chara_card = this.chara_card.filter(({ card_id }) => {
        const row = CHARA_CARDS.find(({ id }) => id === card_id);
        return row !== undefined && this.chara_filter.includes(row.chara);
      });
    }
  }
  rebuildGrid(): void {
    for (const d of this.card_displayed) {
      d.card.destroy();
      d.card_base.destroy();
    }
    this.card_displayed = [0, 1].map((i) => ({
      card_base: new FakeObject(this, "Container", 66 + i * 88, 115),
      card: new FakeCard(this, 66 + i * 88, 115),
      stock_label: new FakeObject(this, "Image", 0, 0),
      stock_max: new FakeText(this, 0, 0, "1"),
      stock_now: new FakeText(this, 0, 0, "1"),
      penalty: [],
    }));
  }
  private track<T extends FakeObject>(o: T): T {
    this.objects.push(o);
    return o;
  }
  /** 我們畫的東西（不含原版那幾樣）。 */
  ours(type?: string): FakeObject[] {
    return this.objects.filter((o) => !o.destroyed && (type === undefined || o.type === type));
  }
}

interface FakeWindow {
  game: { scene: { keys: Record<string, unknown> } };
  lang: string;
  [key: string]: unknown;
}

const installed: FakeWindow[] = [];

function makeGame(): { window: FakeWindow; edit: FakeScene; reports: unknown[] } {
  const edit = new FakeScene();
  const reports: unknown[] = [];
  const window: FakeWindow = {
    game: { scene: { keys: { Edit: edit } } },
    lang: "tcn",
    __ulrReport: (payload: string) => reports.push(JSON.parse(payload)),
  };
  return { window, edit, reports };
}

function run(window: FakeWindow, script: string): string {
  // eslint-disable-next-line no-new-func
  return new Function("window", `return ${script};`)(window) as string;
}

function install(window: FakeWindow, state: Partial<CharaPickerState> = {}): string {
  installed.push(window);
  const full: CharaPickerState = {
    mode: "L5" as CharaPickerMode,
    favorites: [],
    hiddenWeapons: [],
    favoriteEvents: [],
    favoritesReady: true,
    ...state,
  };
  return run(
    window,
    buildCharaPickerPatchScript({
      bindingName: "__ulrReport",
      state: full,
      pollIntervalMs: 60_000,
    }),
  );
}

function picker(window: FakeWindow): {
  overlay: { tiles: FakeObject[] } | null;
  picker: { base: FakeObject } | null;
  fav: { base: FakeObject } | null;
  favOn: boolean;
  weapon: { base: FakeObject; text: FakeObject } | null;
  weaponOn: boolean;
  eventFav: { base: FakeObject; text: FakeObject } | null;
  eventFavOn: boolean;
  favBtn: { img: FakeObject } | null;
} {
  return window["__ulrCharaPicker"] as never;
}

afterEach(() => {
  // 腳本裡有 setInterval，不拆的話 vitest 收不了工。
  for (const w of installed.splice(0)) run(w, CHARA_PICKER_UNINSTALL_EXPRESSION);
});

describe("[Chara] 鈕與角色一覽", () => {
  it("裝上就畫在 Edit 上；點下去格線換成每個持有的角色一張（怪物、沒卡的角色不算）", () => {
    const { window, edit } = makeGame();
    const status = parseCharaPickerStatus(install(window));
    expect(status).toMatchObject({ installed: true, mounted: true, open: false });

    picker(window).picker!.base.emit("pointerup");
    const st = picker(window);
    expect(st.overlay).not.toBeNull();
    // 兩個角色 × (卡 + 選中框)
    expect(st.overlay!.tiles).toHaveLength(4);
    // 原本那幾張藏起來、點不到
    for (const d of edit.card_displayed) {
      expect(d.card.visible).toBe(false);
      expect(d.card.zone.input?.enabled).toBe(false);
    }
  });

  it("代表卡照設定挑：cc001 手上只有 L4 → L4、cc002 手上只有 L1 → L1", () => {
    const { window } = makeGame();
    install(window);
    picker(window).picker!.base.emit("pointerup");
    const cards = picker(window).overlay!.tiles.filter((o) => o.texture === "CharaCardImages");
    expect(cards.map((o) => o.alpha)).toEqual([1, 1]);
  });

  it("點一張 = 勾選那個角色、翻回第一頁、叫原版 refresh；一覽不收，重畫的格線照樣藏著", () => {
    const { window, edit } = makeGame();
    install(window);
    picker(window).picker!.base.emit("pointerup");
    const [first, firstMark, second] = picker(window).overlay!.tiles;
    first!.emit("pointerup");
    expect(edit.chara_filter).toEqual(["cc001"]);
    expect(edit.chara_page).toBe(1);
    expect(edit.refreshes).toBe(1);
    expect(picker(window).overlay).not.toBeNull();
    expect(firstMark!.visible).toBe(true);
    for (const d of edit.card_displayed) {
      expect(d.card.visible).toBe(false);
      expect(d.card.zone.input?.enabled).toBe(false);
    }

    // 可以複選；再點一次同一個 = 取消它
    second!.emit("pointerup");
    expect(edit.chara_filter).toEqual(["cc001", "cc002"]);
    first!.emit("pointerup");
    expect(edit.chara_filter).toEqual(["cc002"]);
    expect(firstMark!.visible).toBe(false);
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([11, 12]);

    // 再按 [Chara] 收起來：格線回來、點得到
    picker(window).picker!.base.emit("pointerup");
    expect(picker(window).overlay).toBeNull();
    expect(first!.destroyed).toBe(true);
    for (const d of edit.card_displayed) {
      expect(d.card.visible).toBe(true);
      expect(d.card.zone.input?.enabled).toBe(true);
    }
  });

  it("原版自己 refresh（翻頁、切分頁）時一覽先收起來", () => {
    const { window, edit } = makeGame();
    install(window);
    const hidden = edit.card_displayed[0]!.card;
    picker(window).picker!.base.emit("pointerup");
    edit.refresh();
    expect(picker(window).overlay).toBeNull();
    // 被換掉之前先放回來了（放不放都會被 refresh 換掉，但不能留著點不到）
    expect(hidden.zone.input?.enabled).toBe(true);
  });

  it("off：不畫 [Chara] 鈕", () => {
    const { window } = makeGame();
    install(window, { mode: "off" });
    expect(picker(window).picker).toBeNull();
  });

  it("推新模式會重掛；拆掉把 refresh、card_filter 還回 prototype 那一支", () => {
    const { window, edit } = makeGame();
    install(window);
    expect(Object.prototype.hasOwnProperty.call(edit, "refresh")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(edit, "card_filter")).toBe(true);
    expect(
      run(
        window,
        buildCharaPickerStateExpression({
          mode: "off",
          favorites: [],
          hiddenWeapons: [],
          favoriteEvents: [],
          favoritesReady: true,
        }),
      ),
    ).toBe("ok");
    expect(picker(window).picker).toBeNull();

    expect(run(window, CHARA_PICKER_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(edit, "refresh")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(edit, "card_filter")).toBe(false);
    expect(parseCharaPickerStatus(run(window, CHARA_PICKER_STATUS_EXPRESSION)).installed).toBe(
      false,
    );
  });

  it("[Favorite]：按下去只剩最愛卡片（清掉人物篩選）、再按一次回到全部", () => {
    const { window, edit } = makeGame();
    install(window, { favorites: [4, 12] });
    edit.chara_filter = ["cc001"];
    picker(window).fav!.base.emit("pointerup");
    expect(picker(window).favOn).toBe(true);
    expect(edit.chara_filter).toEqual([]);
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 12]);

    picker(window).fav!.base.emit("pointerup");
    expect(picker(window).favOn).toBe(false);
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 11, 12]);
  });

  it("[Favorite] 開著時用 [Chara] 勾選：關掉 [Favorite]，照人物篩選", () => {
    const { window, edit } = makeGame();
    install(window, { favorites: [4] });
    picker(window).fav!.base.emit("pointerup");
    picker(window).picker!.base.emit("pointerup");
    picker(window).overlay!.tiles[2]!.emit("pointerup"); // cc002
    expect(picker(window).favOn).toBe(false);
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([11, 12]);
  });

  it("[Favorite] 只濾 chara 分頁", () => {
    const { window, edit } = makeGame();
    install(window, { favorites: [4] });
    picker(window).fav!.base.emit("pointerup");
    edit.category = "monster";
    edit.refresh();
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 11, 12]);
  });

  it("最愛清單被推新的：[Favorite] 開著就跟著重畫；拆掉時格線放回全部", () => {
    const { window, edit } = makeGame();
    install(window, { favorites: [4] });
    picker(window).fav!.base.emit("pointerup");
    run(
      window,
      buildCharaPickerStateExpression({
        mode: "L5",
        favorites: [4, 11],
        hiddenWeapons: [],
        favoriteEvents: [],
        favoritesReady: true,
      }),
    );
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 11]);

    run(window, CHARA_PICKER_UNINSTALL_EXPRESSION);
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 11, 12]);
  });

  it("最愛存不進去（favoritesReady: false）：不畫 [Favorite]", () => {
    const { window } = makeGame();
    install(window, { favoritesReady: false });
    expect(picker(window).fav).toBeNull();
  });

  it("不在 Edit：裝得上但不畫", () => {
    const { window, edit } = makeGame();
    edit.active = false;
    expect(parseCharaPickerStatus(install(window))).toMatchObject({
      installed: true,
      mounted: false,
    });
  });
});

describe("Equipment：[Chara Weapon] 與「隱藏裝備」", () => {
  it("[Chara Weapon] 只在 Equipment 分頁出現", () => {
    const { window, edit } = makeGame();
    install(window);
    expect(picker(window).weapon!.base.visible).toBe(false);
    edit.category = "weapon";
    // 輪詢間隔設成 60 秒，推一次狀態讓它跑 tick
    run(window, buildCharaPickerStateExpression(stateOf({})));
    expect(picker(window).weapon!.base.visible).toBe(true);
  });

  it("裝上時停在 Equipment：照新順序重畫；畫完 weapon_card 換回原本的陣列", () => {
    const { window, edit } = makeGame();
    edit.category = "weapon";
    const original = edit.weapon_card;
    install(window);
    expect(edit.weaponDrawn).toEqual([1, 25, 165, 276, 26, 30, 5000]);
    expect(edit.weapon_card).toBe(original);
    expect(edit.weapon_card.map((w) => w.card_id)).toEqual([1, 25, 26, 30, 165, 276, 5000]);
  });

  it("按 [Chara Weapon]：只剩通用武＋牌組角色專武（槽位順序）、素材與隱藏的不見，頁數重算；再按一次回來", () => {
    const { window, edit } = makeGame();
    edit.category = "weapon";
    edit.weapon_page = 3;
    install(window, { hiddenWeapons: [25] });
    picker(window).weapon!.base.emit("pointerup");
    expect(picker(window).weaponOn).toBe(true);
    // 牌組：艾依查庫（cc002）、艾伯李斯特（cc001）
    expect(edit.weaponDrawn).toEqual([1, 165, 276, 30, 26]);
    expect(edit.weapon_page).toBe(1);
    expect(edit.weapon_page_max).toBe(1);

    picker(window).weapon!.base.emit("pointerup");
    expect(picker(window).weaponOn).toBe(false);
    expect(edit.weaponDrawn).toEqual([1, 25, 165, 276, 26, 30, 5000]);
  });

  it("預覽武器時右下是「隱藏裝備」：點了回報、[Chara Weapon] 開著就從格線拿掉", () => {
    const { window, edit, reports } = makeGame();
    edit.category = "weapon";
    install(window);
    picker(window).weapon!.base.emit("pointerup");
    edit.previewWeapon(25);
    run(window, buildCharaPickerStateExpression(stateOf({})));
    const btn = picker(window).favBtn!.img;
    expect(btn.visible).toBe(true);
    expect(btn.texture).toBe("ulr_fav_btn_隱藏裝備");

    btn.emit("pointerup");
    expect(reports).toContainEqual({ type: "weapon-hidden", card: 25, on: true });
    expect(edit.weaponDrawn).not.toContain(25);
  });

  it("托盤推來新的隱藏清單（雲端同步）：[Chara Weapon] 開著就重畫", () => {
    const { window, edit } = makeGame();
    edit.category = "weapon";
    install(window);
    picker(window).weapon!.base.emit("pointerup");
    run(window, buildCharaPickerStateExpression(stateOf({ hiddenWeapons: [165] })));
    expect(edit.weaponDrawn).toEqual([1, 25, 276, 30, 26]);
  });

  it("托盤重裝：[Chara Weapon] 開著就接著開", () => {
    const { window, edit } = makeGame();
    edit.category = "weapon";
    install(window);
    picker(window).weapon!.base.emit("pointerup");
    install(window);
    expect(picker(window).weaponOn).toBe(true);
    expect(edit.weaponDrawn).toEqual([1, 25, 165, 276, 30, 26]);
  });

  it("拆掉：頁數照原版算回來、格線照原版順序重畫", () => {
    const { window, edit } = makeGame();
    edit.category = "weapon";
    edit.weapon_card = Array.from({ length: 40 }, (_, i) => ({ card_id: 1000 + i, quantity: 1 }));
    install(window, { hiddenWeapons: [] });
    picker(window).weapon!.base.emit("pointerup");
    // 查不到的 WeaponCards（1000..）在 [Chara Weapon] 下照樣留著
    expect(edit.weapon_page_max).toBe(3);
    run(window, CHARA_PICKER_UNINSTALL_EXPRESSION);
    expect(edit.weapon_page_max).toBe(3);
    expect(edit.weaponDrawn[0]).toBe(1000);
    expect(Object.prototype.hasOwnProperty.call(edit, "refresh")).toBe(false);
  });

  it("預覽的是角色卡時還是「最愛卡片」", () => {
    const { window, edit } = makeGame();
    install(window);
    edit.btn_copy = { image: new FakeObject(edit, "Image", 616, 612), text: null } as never;
    edit.profile_texts = Array.from(
      { length: 11 },
      (_, i) => new FakeText(edit, 0, 0, i === 10 ? "4" : ""),
    );
    run(window, buildCharaPickerStateExpression(stateOf({})));
    expect(picker(window).favBtn!.img.texture).toBe("ulr_fav_btn_最愛卡片");
  });
});

describe("Event：[Favorite] 與「最愛卡片」", () => {
  it("[Favorite] 只在 Event 分頁出現，跟角色那顆不是同一顆", () => {
    const { window, edit } = makeGame();
    install(window);
    expect(picker(window).eventFav!.base.visible).toBe(false);
    edit.category = "event";
    run(window, buildCharaPickerStateExpression(stateOf({})));
    expect(picker(window).eventFav!.base.visible).toBe(true);
    expect(picker(window).eventFav!.base).not.toBe(picker(window).fav!.base);
  });

  it("按 [Favorite]：只剩最愛的事件卡、翻回第一頁、頁數重算；畫完 event_card 換回原本的陣列", () => {
    const { window, edit } = makeGame();
    edit.category = "event";
    edit.event_card = Array.from({ length: 40 }, (_, i) => ({ card_id: i + 1, quantity: 1 }));
    edit.event_page = 3;
    const original = edit.event_card;
    install(window, { favoriteEvents: [44, 3, 7] });
    picker(window).eventFav!.base.emit("pointerup");
    expect(picker(window).eventFavOn).toBe(true);
    expect(edit.eventDrawn).toEqual([3, 7]);
    expect(edit.event_page).toBe(1);
    expect(edit.event_page_max).toBe(1);
    expect(edit.event_card).toBe(original);

    picker(window).eventFav!.base.emit("pointerup");
    expect(picker(window).eventFavOn).toBe(false);
    expect(edit.eventDrawn).toHaveLength(40);
    expect(edit.event_page_max).toBe(3);
  });

  it("事件卡的最愛跟角色卡的最愛各用各的清單（id 會重疊）、各開各的", () => {
    const { window, edit } = makeGame();
    install(window, { favorites: [4], favoriteEvents: [44] });
    edit.category = "event";
    picker(window).eventFav!.base.emit("pointerup");
    expect(edit.eventDrawn).toEqual([44]);
    // 切回 Chara：角色格線不被事件的最愛濾掉
    edit.category = "chara";
    edit.refresh();
    expect(edit.chara_card.map((c) => c.card_id)).toEqual([4, 11, 12]);
    expect(picker(window).favOn).toBe(false);
  });

  it("預覽事件卡時右下是「最愛卡片」：點了回報 event-favorite，[Favorite] 開著就從格線拿掉", () => {
    const { window, edit, reports } = makeGame();
    edit.category = "event";
    install(window, { favoriteEvents: [44, 60] });
    picker(window).eventFav!.base.emit("pointerup");
    edit.previewEvent(60);
    run(window, buildCharaPickerStateExpression(stateOf({ favoriteEvents: [44, 60] })));
    const btn = picker(window).favBtn!.img;
    expect(btn.visible).toBe(true);
    expect(btn.texture).toBe("ulr_fav_btn_取消最愛");

    btn.emit("pointerup");
    expect(reports).toContainEqual({ type: "event-favorite", card: 60, on: false });
    expect(edit.eventDrawn).toEqual([44]);
    expect(btn.texture).toBe("ulr_fav_btn_最愛卡片");
  });

  it("id 從預覽圖讀，不用名字（「Hp恢復」有五張）；預覽換成武器就換回「隱藏裝備」", () => {
    const { window, edit, reports } = makeGame();
    install(window);
    edit.previewEvent(59);
    run(window, buildCharaPickerStateExpression(stateOf({})));
    picker(window).favBtn!.img.emit("pointerup");
    expect(reports).toContainEqual({ type: "event-favorite", card: 59, on: true });

    edit.previewWeapon(25);
    run(window, buildCharaPickerStateExpression(stateOf({ favoriteEvents: [59] })));
    expect(picker(window).favBtn!.img.texture).toBe("ulr_fav_btn_隱藏裝備");
  });

  it("托盤推來新的事件最愛（雲端同步）：[Favorite] 開著就重畫", () => {
    const { window, edit } = makeGame();
    edit.category = "event";
    install(window, { favoriteEvents: [3] });
    picker(window).eventFav!.base.emit("pointerup");
    run(window, buildCharaPickerStateExpression(stateOf({ favoriteEvents: [3, 60] })));
    expect(edit.eventDrawn).toEqual([3, 60]);
  });

  it("拆掉：頁數照原版算回來、格線放回全部", () => {
    const { window, edit } = makeGame();
    edit.category = "event";
    edit.event_card = Array.from({ length: 40 }, (_, i) => ({ card_id: i + 1, quantity: 1 }));
    install(window, { favoriteEvents: [1] });
    picker(window).eventFav!.base.emit("pointerup");
    expect(edit.event_page_max).toBe(1);
    run(window, CHARA_PICKER_UNINSTALL_EXPRESSION);
    expect(edit.event_page_max).toBe(3);
    expect(edit.eventDrawn).toHaveLength(40);
  });

  it("最愛存不進去（favoritesReady: false）：不畫 Event 的 [Favorite]", () => {
    const { window } = makeGame();
    install(window, { favoritesReady: false });
    expect(picker(window).eventFav).toBeNull();
  });

  it("舊版托盤沒送 favoriteEvents：當成空的", () => {
    const { window, edit } = makeGame();
    edit.category = "event";
    const { favoriteEvents: _drop, ...old } = stateOf({});
    installed.push(window);
    run(
      window,
      buildCharaPickerPatchScript({
        bindingName: "__ulrReport",
        state: old as CharaPickerState,
        pollIntervalMs: 60_000,
      }),
    );
    picker(window).eventFav!.base.emit("pointerup");
    expect(edit.eventDrawn).toEqual([]);
  });
});

function stateOf(state: Partial<CharaPickerState>): CharaPickerState {
  return {
    mode: "L5",
    favorites: [],
    hiddenWeapons: [],
    favoriteEvents: [],
    favoritesReady: true,
    ...state,
  };
}
