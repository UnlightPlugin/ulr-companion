import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DECK_EDIT_SCRIPT_VERSION,
  buildDeckEditPatchScript,
  buildDeckEditStateExpression,
  isDeckEditReport,
  parseDeckEditStatus,
} from "../src/patch-deck-edit.js";
import type { DeckEditContent, DeckEditState } from "../src/patch-deck-edit.js";

/** 一副牌的內容（卡片 id）。三個槽位 ＋ 一把武器 ＋ 一張事件卡，夠算 COST 也夠畫縮圖。 */
function contentOf(a: number, b: number, c: number): DeckEditContent {
  return {
    charaId: [a, b, c],
    weaponId: [1, null, null],
    eventId: [1, ...Array.from({ length: 17 }, () => null)],
  };
}

const STATE: DeckEditState = {
  mode: "plugin",
  room: "dietherm",
  // 規格 §4 的四種房，順序照 ROOM_KINDS（2026-09-12 起：任務→渦→亞城→迪城）
  rooms: [
    { key: "quest", label: "任務" },
    { key: "raid", label: "渦" },
    { key: "alexandria", label: "亞歷山卓城" },
    { key: "dietherm", label: "迪特赫姆" },
  ],
  decks: [
    { id: "d1", name: "壓 C 用", bosses: [], content: contentOf(1, 2, 3) },
    { id: "d2", name: "打人用", bosses: [], content: contentOf(1, 2, 3) },
  ],
  activeId: "d1",
  bossOptions: [
    { key: "sea", label: "海" },
    { key: "fish", label: "魚" },
  ],
  penaltyBands: null,
  costDisplay: "official",
  slots: { "1": { id: "d1", name: "壓 C 用" } },
};

/** 官方三牌組模式：三格各自有名字。 */
const OFFICIAL: DeckEditState = {
  ...STATE,
  mode: "official",
  slots: {
    "1": { id: "d1", name: "壓 C 用" },
    "2": { id: "d2", name: "打人用" },
    "3": { id: null, name: "Deck3" },
  },
};

function script(state: DeckEditState = STATE): string {
  return buildDeckEditPatchScript({ bindingName: "__test", state });
}

describe("注入腳本", () => {
  it("是合法的 JS —— 註解裡混進反引號會把 template literal 提前收尾", () => {
    expect(() => new Script(script())).not.toThrow();
  });

  it("狀態是用 JSON.parse 讀進去的，不是物件字面值（__proto__ 防護）", () => {
    expect(script()).toContain("JSON.parse(");
  });

  it("同版本重裝只換狀態，不重畫", () => {
    expect(script()).toContain("already-installed");
  });

  it("裝之前會清掉舊版留下的孤兒物件", () => {
    const src = script();
    expect(src).toContain("purge(");
    expect(src).toContain("__ulrDeckOwned");
  });

  it("⚠⚠ 房間清單要 JSON.parse 進去，不能直接用 embedJson 的結果", () => {
    // embedJson() 給的是「要餵給 JSON.parse 的字串字面值」，直接用的話拿到的是
    // 字串，ROOMS[i] 是單一字元 —— 選單永遠掛不上而且不報錯（2026-09-09）。
    const src = script();
    const line = /var ROOMS = (JSON\.parse\("(?:[^"\\]|\\.)*"\));/.exec(src);
    expect(line).not.toBeNull();
    const rooms: unknown = new Script(`(${line?.[1]})`).runInNewContext({ JSON });
    expect(rooms).toEqual(["Quest", "Raid", "Match"]);
  });

  it("房型清單只從狀態來，腳本裡不寫死房型鍵", () => {
    const src = script();
    for (const key of ["alexandria", "quest", "dietherm"]) {
      expect(src.includes(`"${key}"`)).toBe(false);
    }
    expect(src).toContain("options: state.rooms");
  });

  it("「房間」那一格的標題跟著遊戲語言換，不是寫死中文", () => {
    const src = script();
    expect(src).toContain("pick(CFG.roomTitle, gameLang())");
    for (const word of ["部屋", "Room", "방", "房间", "房間"]) expect(src).toContain(word);
  });

  it("長按門檻可設定（規格 §10 要 1 秒）", () => {
    expect(buildDeckEditPatchScript({ bindingName: "x", state: STATE })).toContain(
      "var HOLD_MS = 1000;",
    );
    expect(buildDeckEditPatchScript({ bindingName: "x", state: STATE, dragHoldMs: 400 })).toContain(
      "var HOLD_MS = 400;",
    );
  });

  it("⚠ 內容下放到頁面是**為了畫**，但回報裡永遠沒有它", () => {
    const src = script();
    for (const call of src.match(/report\(\{[^}]*\}\)/g) ?? []) {
      expect(call).not.toContain("content");
    }
  });

  it("⚠ 箭頭只拆 pointerup —— hover 換圖不能拆", () => {
    const src = script();
    expect(src).toContain('obj.off("pointerup")');
    expect(src).not.toContain('obj.off("pointerover")');
    expect(src).not.toContain('obj.off("pointerdown")');
  });

  it("⚠ 遊戲畫面上不畫任何訊息文字", () => {
    const src = script();
    expect(src).not.toContain("state.notice");
    expect(src).not.toContain("#ff9a9a");
  });
});

// ── 真的把腳本跑起來 ─────────────────────────────────────────────────────
//
// ⚠⚠ 上面那一批是「原始碼裡有沒有這串字」，在壞掉的版本上照樣會過。下面用假的
// Phaser 場景把整支腳本執行起來，斷言的是**行為**。場景的樣子照 2026-09-24
// 讀的改版後原始碼：四個場景左下都是 deck_prev(16,644)／deck_icon(32,644)／
// deck_next(46,644)，箭頭行為掛在 pointerup；房裡的重畫是 show_deck()、
// Edit 是 refresh()＋show_deck_label()＋show_cost()。

interface FakeObject {
  type: string;
  x: number;
  y: number;
  text?: string;
  texture: { key: string } | null;
  frame?: unknown;
  depth: number;
  visible: boolean;
  displayWidth: number;
  displayHeight: number;
  input: unknown;
  scene: unknown;
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  setInteractive: () => FakeObject;
  setText: (text: string) => FakeObject;
  on: (event: string, fn: (...args: unknown[]) => void) => FakeObject;
  off: (event: string, fn?: (...args: unknown[]) => void) => FakeObject;
  fire: (event: string, ...args: unknown[]) => void;
  destroy: () => void;
  [key: string]: unknown;
}

function fakeObject(type: string, x: number, y: number, key: string | null, text?: string) {
  const o = {
    type,
    x,
    y,
    text,
    texture: key === null ? null : { key },
    frame: undefined as unknown,
    depth: 0,
    visible: true,
    alpha: 1,
    displayWidth: 16,
    displayHeight: 24,
    input: null as unknown,
    scene: null as unknown,
    handlers: {} as Record<string, ((...args: unknown[]) => void)[]>,
    setOrigin: () => o,
    setDepth: (d: number) => ((o.depth = d), o),
    setResolution: () => o,
    setScale: () => o,
    setVisible: (v?: boolean) => ((o.visible = v !== false), o),
    setAlpha: (a: number) => ((o.alpha = a), o),
    setDisplaySize: (w: number, h: number) => ((o.displayWidth = w), (o.displayHeight = h), o),
    setColor: () => o,
    setPadding: () => o,
    setY: (v: number) => ((o.y = v), o),
    setText: (t: string) => ((o.text = t), o),
    setTexture: (k: string, f?: unknown) => ((o.texture = { key: k }), (o.frame = f), o),
    setInteractive: () => ((o.input = {}), o),
    on(event: string, fn: (...args: unknown[]) => void) {
      (o.handlers[event] ??= []).push(fn);
      return o;
    },
    off(event: string, fn?: (...args: unknown[]) => void) {
      if (fn === undefined) delete o.handlers[event];
      else o.handlers[event] = (o.handlers[event] ?? []).filter((f) => f !== fn);
      return o;
    },
    fire(event: string, ...args: unknown[]) {
      for (const fn of [...(o.handlers[event] ?? [])]) fn(...args);
    },
    destroy() {
      o.scene = null;
    },
  };
  return o as unknown as FakeObject;
}

interface FakeScene {
  children: { list: FakeObject[] };
  deck_now: number;
  deck_max: number;
  deck_prev: FakeObject;
  deck_next: FakeObject;
  /** 房裡的那行字（Edit 沒有，Edit 是 deck_label）。 */
  deck_name?: FakeObject;
  /** 每次 show_deck／show_deck_label 被叫幾次（驗重畫）。 */
  redraws: number;
  [key: string]: unknown;
}

/** 假的貼圖管理。`draws` 記下 plainButtonTexture 裁了哪兩段。 */
function fakeTextures(): {
  manager: Record<string, unknown>;
  draws: number[][];
  created: string[];
} {
  const atlases: Record<string, string[]> = {
    deck_reset: ["0", "1"],
    btn_gene: ["0", "1"],
    deck_icon: [],
    panel_gene: [],
    btn_arrow_deck: ["0", "1", "2"],
    CharaCardImages: ["cc000", "cc001_01", "cc002_01", "cc003_01", "mc001_01"],
  };
  const draws: number[][] = [];
  const created: string[] = [];
  const manager = {
    exists: (k: string) => Object.prototype.hasOwnProperty.call(atlases, k),
    get: (k: string) => ({
      has: (f: string | number) => (atlases[k] ?? []).includes(String(f)),
      getSourceImage: () => ({ width: 64, height: 48 }),
    }),
    createCanvas: (key: string) => {
      created.push(key);
      atlases[key] = [];
      return {
        getContext: () => ({
          clearRect: () => {},
          drawImage: (...args: unknown[]) => draws.push(args.slice(1) as number[]),
        }),
        refresh: () => {},
        add: (name: string | number) => (atlases[key] ??= []).push(String(name)),
      };
    },
  };
  return { manager, draws, created };
}

/**
 * 一個場景。`kind` 決定它長得像房間（show_deck）還是牌組編輯畫面
 * （show_deck_label＋refresh＋show_cost＋rexUI）。`icon: false` 模擬牌盒不見了。
 */
function fakeScene(kind: "room" | "edit", options: { icon?: boolean } = {}): FakeScene {
  const list: FakeObject[] = [];
  const add = <T extends FakeObject>(o: T): T => {
    o.scene = sc;
    list.push(o);
    return o;
  };
  const tex = fakeTextures();
  const sc = {
    children: { list },
    deck_now: 1,
    deck_max: 3,
    redraws: 0,
    textures: tex.manager,
    __tex: tex,
    scale: { width: 760, height: 680 },
    scene: { isActive: () => true },
    ulse01: { play: () => {} },
    add: {
      sprite: (x: number, y: number, k: string) => add(fakeObject("Sprite", x, y, k)),
      image: (x: number, y: number, k: string, f?: unknown) =>
        Object.assign(add(fakeObject("Image", x, y, k)), { frame: f }),
      text: (x: number, y: number, t: string, style?: unknown) =>
        Object.assign(add(fakeObject("Text", x, y, null, t)), { style: style ?? {} }),
      zone: (x: number, y: number) => add(fakeObject("Zone", x, y, null)),
      nineslice: (x: number, y: number, k: string) => add(fakeObject("NineSlice", x, y, k)),
      existing: (o: FakeObject) => add(o),
    },
  } as unknown as FakeScene;

  sc.deck_prev = add(fakeObject("Image", 16, 644, "btn_arrow_deck")).setInteractive();
  sc.deck_next = add(fakeObject("Image", 46, 644, "btn_arrow_deck")).setInteractive();
  if (options.icon !== false) add(fakeObject("Image", 32, 644, "deck_icon"));

  // 原版的箭頭（改版後的 create()，四個場景一樣）：pointerdown 換圖，pointerup 換副。
  const cycle = (delta: number) => () => {
    sc.deck_now =
      delta < 0
        ? sc.deck_now === 1
          ? 3
          : sc.deck_now - 1
        : sc.deck_now === 3
          ? 1
          : sc.deck_now + 1;
    if (kind === "room") (sc["show_deck"] as () => void)();
    else {
      (sc["refresh"] as () => void)();
      (sc["show_deck_label"] as () => void)();
      (sc["show_cost"] as () => void)();
    }
  };
  for (const [obj, d] of [
    [sc.deck_prev, -1],
    [sc.deck_next, 1],
  ] as const) {
    obj.on("pointerover", () => {});
    obj.on("pointerdown", () => {});
    obj.on("pointerup", cycle(d));
  }

  if (kind === "room") {
    sc.deck_name = add(fakeObject("Text", 60, 644, null, "Deck1"));
    sc["show_deck"] = function (this: FakeScene) {
      sc.redraws++;
      sc.deck_name?.setText(`Deck${sc.deck_now}`);
    };
  } else {
    // Edit：那行字是 show_deck_label() 每次現建的，舊的淡出後 destroy。
    const labels: { name: FakeObject }[] = [];
    sc["deck_label"] = labels;
    sc["show_deck_label"] = function () {
      sc.redraws++;
      labels.push({ name: add(fakeObject("Text", -4, 447, null, `Deck${sc.deck_now}`)) });
    };
    sc["refresh"] = () => {};
    sc["show_cost"] = () => {};
    (sc["show_deck_label"] as () => void)();
    add(fakeObject("Text", 504, 450, null, "排序"));
    add(fakeObject("Image", 248, 644, "deck_reset"));
    const rex = fakeRexUI(sc);
    sc["rexUI"] = rex.rexUI;
    sc["__drops"] = rex.drops;
  }
  return sc;
}

interface FakeDrop {
  cfg: {
    x: number;
    y: number;
    options: { text: string; value: string }[];
    list: { onButtonClick: (b: unknown) => void };
  };
  obj: FakeObject;
}

/** 假的 rexUI：只做這支用到的 dropDownList／label／roundRectangle／BBCodeText。 */
function fakeRexUI(sc: FakeScene): { rexUI: Record<string, unknown>; drops: FakeDrop[] } {
  const drops: FakeDrop[] = [];
  const push = <T extends FakeObject>(o: T): T => ((o.scene = sc), sc.children.list.push(o), o);
  const add = {
    roundRectangle: () => push(fakeObject("rexRoundRectangleShape", 0, 0, null)),
    BBCodeText: (x: number, y: number, text: string) =>
      push(fakeObject("rexBBCodeText", x, y, null, text)),
    label: (cfg: { background: FakeObject; value: string }) => ({
      value: cfg.value,
      getElement: () => ({ setFillStyle: () => {} }),
    }),
    dropDownList: (cfg: FakeDrop["cfg"]) => {
      const obj = push(fakeObject("rexDropDownList", cfg.x, cfg.y, null));
      const rec = obj as unknown as Record<string, unknown>;
      const bg = fakeObject("NineSlice", 0, 0, "btn_gene");
      rec["layout"] = () => obj;
      rec["getCenter"] = () => ({ x: cfg.x, y: cfg.y + 10 });
      rec["getElement"] = () => bg;
      rec["closeListPanel"] = () => {};
      drops.push({ cfg, obj });
      return obj;
    },
  };
  return { rexUI: { add }, drops };
}

/** 假的 rexUI InputText —— 就地改名用的那個。 */
class FakeInputText {
  static last: FakeInputText | null = null;
  text: string;
  depth = 0;
  focused = false;
  destroyed = false;
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  constructor(
    readonly scene: unknown,
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
    readonly config: Record<string, unknown>,
  ) {
    this.text = String(config["text"] ?? "");
    FakeInputText.last = this;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setFocus(): this {
    this.focused = true;
    return this;
  }
  on(event: string, fn: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers[event] ?? [])]) fn(...args);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * 遊戲自己的三份卡片資料（改版後），**只放價格要用的欄位**。
 *
 * 15 / 13 / 20 是 docs/official-cost-rule.md 的第一個對照例子：差距 2、5、7 →
 * 只有 13↔20 那一對超標，罰 5。加上武器 3、事件卡 2 之後官方總和是 58。
 */
function fakeJsonCache(): Record<string, unknown> {
  const data: Record<string, unknown> = {
    CharaCards: [
      { id: 1, filename: "cc001_01", cost: 15 },
      { id: 2, filename: "cc002_01", cost: 13 },
      { id: 3, filename: "cc003_01", cost: 20 },
      { id: 1001, filename: "mc001_01", cost: 9 },
    ],
    WeaponCards: [{ id: 1, cost: 3 }],
    EventCards: [{ id: 1, cost: 2 }],
  };
  return {
    has: (k: string) => Object.prototype.hasOwnProperty.call(data, k),
    get: (k: string) => data[k],
  };
}

interface RunResult {
  result: unknown;
  reports: { type: string; [key: string]: unknown }[];
  api: {
    isMounted: () => boolean;
    version: string;
    setState: (s: unknown) => void;
    uninstall: () => void;
  };
  window: Record<string, unknown>;
  tick: () => void;
}

function exec(win: Record<string, unknown>, state: DeckEditState): unknown {
  const context: Record<string, unknown> = {
    setInterval: (fn: () => void) => ((win["__tick"] = fn), 1),
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: win,
  };
  return new Script(buildDeckEditPatchScript({ bindingName: "__test", state })).runInContext(
    createContext(context),
  );
}

function run(
  scenes: Record<string, FakeScene>,
  state: DeckEditState = STATE,
  opts: { cost?: unknown; lang?: string } = {},
): RunResult {
  const reports: { type: string; [key: string]: unknown }[] = [];
  const win: Record<string, unknown> = {
    game: { scene: { keys: scenes }, cache: { json: fakeJsonCache() } },
    RexPlugins: { UI: { InputText: FakeInputText } },
    __test: (json: string) => reports.push(JSON.parse(json)),
  };
  if (opts.cost !== undefined) win["__ulrCostPatch"] = opts.cost;
  if (opts.lang !== undefined) win["lang"] = opts.lang;
  const result = exec(win, state);
  return {
    result,
    reports,
    api: win["__ulrDeckEdit"] as RunResult["api"],
    window: win,
    tick: () => (win["__tick"] as () => void)(),
  };
}

/** 一份「有自訂表」的 `__ulrCostPatch`：三張角色卡都被規則動過。 */
function costPatch(customs: Record<string, number>): Record<string, unknown> {
  return {
    originals: { characters: { cc001_01: 15, cc002_01: 13, cc003_01: 20 } },
    customs: { characters: customs },
  };
}

const alive = (sc: FakeScene) => sc.children.list.filter((o) => o.scene !== null);
const iconsOf = (sc: FakeScene) => alive(sc).filter((o) => o.texture?.key === "deck_icon");
/** 選單裡的字（深度 1503）。 */
const menuTexts = (sc: FakeScene) =>
  alive(sc).filter((o) => o.text !== undefined && o.depth === 1503);
/** Edit 那行字（最後一個 deck_label）。 */
const editLabel = (sc: FakeScene) => {
  const l = sc["deck_label"] as { name: FakeObject }[];
  return l[l.length - 1]!.name;
};

function openMenu(sc: FakeScene): void {
  iconsOf(sc)[0]!.fire("pointerdown");
}

describe("房間場景（實際跑起來）", () => {
  it("掛得上任務／渦／對戰房，牌盒點得開選單，選一副回報 deck-select", () => {
    for (const name of ["Quest", "Raid", "Match"]) {
      const sc = fakeScene("room");
      const { api, reports } = run({ [name]: sc });
      expect(api.isMounted()).toBe(true);
      openMenu(sc);
      const row = alive(sc).find((o) => o.type === "Zone" && o.depth === 1502);
      expect(row).toBeDefined();
      row!.fire("pointerdown", { y: 0 });
      row!.fire("pointerup", { y: 0 });
      expect(reports).toContainEqual({ type: "deck-select", id: "d1" });
    }
  });

  it("牌盒不見了就在兩顆箭頭正中間補一顆", () => {
    const sc = fakeScene("room", { icon: false });
    run({ Raid: sc });
    const icons = iconsOf(sc);
    expect(icons).toHaveLength(1);
    expect(icons[0]!.x).toBe(31);
  });

  it("⚠ 本來就有牌盒的不會被補出第二顆", () => {
    const sc = fakeScene("room");
    run({ Quest: sc });
    expect(iconsOf(sc)).toHaveLength(1);
  });

  it("插件模式：◀▶ 不再換 deck_now，改成回報 deck-cycle（from room），deck_now 釘 1", () => {
    const sc = fakeScene("room");
    sc.deck_now = 2; // 掛上去之前玩家用原版箭頭切到了 2
    const { reports } = run({ Raid: sc });
    expect(sc.deck_now).toBe(1);
    sc.deck_next.fire("pointerdown");
    sc.deck_next.fire("pointerup");
    expect(sc.deck_now).toBe(1);
    expect(reports).toContainEqual({ type: "deck-cycle", delta: 1, from: "room" });
  });

  it("插件模式：左下那行字是牌組庫的名字，每次 show_deck 之後都換回來", () => {
    const sc = fakeScene("room");
    run({ Quest: sc });
    expect(sc.deck_name!.text).toBe("壓 C 用");
    (sc["show_deck"] as () => void)();
    expect(sc.deck_name!.text).toBe("壓 C 用");
  });

  it("官方三牌組模式：◀▶ 照官方切 1..3，那行字跟著換成那一格的名字", () => {
    const sc = fakeScene("room");
    const { reports } = run({ Raid: sc }, OFFICIAL);
    sc.deck_next.fire("pointerup");
    expect(sc.deck_now).toBe(2);
    expect(sc.deck_name!.text).toBe("打人用");
    sc.deck_next.fire("pointerup");
    expect(sc.deck_now).toBe(3);
    expect(sc.deck_name!.text).toBe("Deck3");
    expect(reports.filter((r) => r.type === "deck-cycle")).toEqual([]);
  });

  it("狀態換了那行字要跟著換", () => {
    const sc = fakeScene("room");
    const { api } = run({ Quest: sc });
    api.setState({ ...STATE, slots: { "1": { id: "d2", name: "打人用" } } });
    expect(sc.deck_name!.text).toBe("打人用");
  });

  it("房裡不畫 +／- 與「房間」下拉", () => {
    const sc = fakeScene("room");
    run({ Quest: sc });
    expect(alive(sc).some((o) => o.text === "+" || o.text === "-")).toBe(false);
    expect(alive(sc).some((o) => o.type === "rexDropDownList")).toBe(false);
  });

  it("卸載時箭頭裝回原版行為、show_deck 還回去", () => {
    const sc = fakeScene("room");
    const original = sc["show_deck"];
    const { api } = run({ Quest: sc });
    expect(sc["show_deck"]).not.toBe(original);
    api.uninstall();
    expect(sc["show_deck"]).toBe(original);
    sc.deck_next.fire("pointerup");
    expect(sc.deck_now).toBe(2);
    expect(sc.deck_name!.text).toBe("Deck2");
  });

  it("⚠ 模式從插件切到官方：重掛，箭頭回到官方行為", () => {
    const sc = fakeScene("room");
    const { api } = run({ Quest: sc });
    api.setState(OFFICIAL);
    sc.deck_next.fire("pointerup");
    expect(sc.deck_now).toBe(2);
  });
});

describe("⚠⚠ 選單開著不能被輪詢收掉（2026-09-12 回報）", () => {
  it("連跑幾拍，開著的選單還在", () => {
    for (const name of ["Quest", "Raid", "Match"]) {
      const sc = fakeScene("room");
      const { tick } = run({ [name]: sc });
      openMenu(sc);
      const before = menuTexts(sc).length;
      expect(before).toBeGreaterThan(0);
      tick();
      tick();
      expect(menuTexts(sc).length).toBe(before);
    }
  });

  it("場景真的重建了（牌盒死掉）才重掛", () => {
    const sc = fakeScene("room");
    const { tick } = run({ Quest: sc });
    const icon = iconsOf(sc)[0]!;
    icon.destroy();
    const fresh = fakeObject("Image", 32, 644, "deck_icon");
    fresh.scene = sc;
    sc.children.list.push(fresh);
    tick();
    expect(fresh.input).not.toBeNull();
  });

  it("沒有那一排的場景不掛", () => {
    const sc = fakeScene("room");
    sc.children.list.length = 0;
    const { api } = run({ Quest: sc });
    expect(api.isMounted()).toBe(false);
  });
});

describe("渦房選中一個渦 → raid-pick（2026-09-13）", () => {
  function raidScene(): FakeScene {
    const sc = fakeScene("room");
    sc["raid_info"] = { visible: false };
    sc["raid_data"] = [
      { profound_id: 11, profound_mons: "mc1008_02" },
      { profound_id: 12, profound_mons: "mc1012_01" },
    ];
    sc["raid_idx"] = 0;
    return sc;
  }

  it("面板打開時報一次那隻 BOSS 的代碼，之後每拍不重報", () => {
    const sc = raidScene();
    const { reports, tick } = run({ Raid: sc });
    (sc["raid_info"] as { visible: boolean }).visible = true;
    tick();
    tick();
    expect(reports.filter((r) => r.type === "raid-pick")).toEqual([
      { type: "raid-pick", mons: "mc1008_02" },
    ]);
  });

  it("官方三牌組模式不報（那是「一房很多副」才有的功能）", () => {
    const sc = raidScene();
    const { reports, tick } = run({ Raid: sc }, OFFICIAL);
    (sc["raid_info"] as { visible: boolean }).visible = true;
    tick();
    expect(reports.filter((r) => r.type === "raid-pick")).toEqual([]);
  });
});

describe("牌組編輯畫面", () => {
  it("插件模式：＋－ 畫出來，按了會回報", () => {
    const sc = fakeScene("edit");
    const { reports } = run({ Edit: sc });
    const plus = alive(sc).find((o) => o.text === "+");
    const minus = alive(sc).find((o) => o.text === "-");
    expect(plus).toBeDefined();
    expect(minus).toBeDefined();
    const imgs = alive(sc).filter((o) => o.texture?.key === "ulr_btn_plain");
    expect(imgs).toHaveLength(2);
    imgs[0]!.fire("pointerdown");
    imgs[1]!.fire("pointerdown");
    expect(reports).toContainEqual({ type: "deck-add" });
    expect(reports).toContainEqual({ type: "deck-remove", id: "d1" });
  });

  it("＋－ 的貼圖是 deck_reset 的左右邊框拼起來 —— 中間烤著字的那一段不要", () => {
    const sc = fakeScene("edit");
    run({ Edit: sc });
    const tex = sc["__tex"] as ReturnType<typeof fakeTextures>;
    expect(tex.created).toEqual(["ulr_btn_plain"]);
    expect(tex.draws.map((d) => d[0])).toEqual([6, 46]);
  });

  it("官方三牌組模式：沒有 ＋－（一房就是三格）", () => {
    const sc = fakeScene("edit");
    run({ Edit: sc }, OFFICIAL);
    expect(alive(sc).some((o) => o.text === "+" || o.text === "-")).toBe(false);
  });

  it("插件模式：Edit 的 ◀▶ 回報 deck-cycle（from menu）", () => {
    const sc = fakeScene("edit");
    const { reports } = run({ Edit: sc });
    sc.deck_prev.fire("pointerup");
    expect(reports).toContainEqual({ type: "deck-cycle", delta: -1, from: "menu" });
    expect(sc.deck_now).toBe(1);
  });

  it("那行字換成牌組庫的名字；官方模式照 deck_now 換", () => {
    const sc = fakeScene("edit");
    run({ Edit: sc }, OFFICIAL);
    expect(editLabel(sc).text).toBe("壓 C 用");
    sc.deck_next.fire("pointerup");
    expect(editLabel(sc).text).toBe("打人用");
  });

  describe("「房間」下拉（照抄排序那個 dropDownList）", () => {
    it("四房都列進去、照狀態給的順序；點一個回報 room-switch，點現在這一房不回報", () => {
      const sc = fakeScene("edit");
      const { reports } = run({ Edit: sc });
      const drops = sc["__drops"] as FakeDrop[];
      expect(drops).toHaveLength(1);
      const cfg = drops[0]!.cfg;
      expect(cfg.options.map((o) => o.text)).toEqual(["任務", "渦", "亞歷山卓城", "迪特赫姆"]);
      expect(cfg.x).toBe(504);
      cfg.list.onButtonClick({ value: "raid", getElement: () => ({ setFillStyle: () => {} }) });
      cfg.list.onButtonClick({ value: "dietherm", getElement: () => ({ setFillStyle: () => {} }) });
      expect(reports.filter((r) => r.type === "room-switch")).toEqual([
        { type: "room-switch", room: "raid" },
      ]);
    });

    it("換了房，那一格顯示的字要跟著換", () => {
      const sc = fakeScene("edit");
      const { api } = run({ Edit: sc });
      const value = () => alive(sc).find((o) => o.type === "rexBBCodeText" && o.x === 504);
      expect(value()?.text).toBe("迪特赫姆");
      api.setState({ ...STATE, room: "raid" });
      expect(value()?.text).toBe("渦");
    });

    it("「房間」那兩個字右邊留白、跟著遊戲語言換", () => {
      const sc = fakeScene("edit");
      run({ Edit: sc }, STATE, { lang: "ja" });
      const title = alive(sc).find((o) => o.text === "部屋");
      expect(title).toBeDefined();
      expect((title!["style"] as { padding?: { right?: number } }).padding?.right).toBeGreaterThan(
        0,
      );
    });
  });

  describe("就地改名（點左下那行字）", () => {
    it("點下去變成輸入框，Enter 送出 deck-rename（改的是那一格對應的那一副）", () => {
      const sc = fakeScene("edit");
      const { reports } = run({ Edit: sc }, OFFICIAL);
      sc.deck_next.fire("pointerup"); // 第 2 格
      editLabel(sc).fire("pointerdown");
      const box = FakeInputText.last!;
      expect(box.text).toBe("打人用");
      box.text = "新名字";
      box.fire("keydown", box, { key: "Enter" });
      expect(reports).toContainEqual({ type: "deck-rename", id: "d2", name: "新名字" });
      expect(box.destroyed).toBe(true);
    });

    it("⚠ 那一格對不上任何一副就不開輸入框 —— 打完了沒有地方存", () => {
      const sc = fakeScene("edit");
      run({ Edit: sc }, OFFICIAL);
      FakeInputText.last = null;
      sc.deck_prev.fire("pointerup"); // 1 → 3（Deck3 沒有對應的牌組）
      editLabel(sc).fire("pointerdown");
      expect(FakeInputText.last).toBeNull();
    });

    it("Esc 放棄、沒改不送", () => {
      const sc = fakeScene("edit");
      const { reports } = run({ Edit: sc });
      editLabel(sc).fire("pointerdown");
      FakeInputText.last!.fire("keydown", FakeInputText.last, { key: "Escape" });
      editLabel(sc).fire("pointerdown");
      FakeInputText.last!.fire("blur");
      expect(reports.filter((r) => r.type === "deck-rename")).toEqual([]);
    });
  });
});

describe("牌盒選單的版面", () => {
  it("三張卡面縮圖用 CharaCardImages、之間不留間隙；查不到的畫 cc000", () => {
    const sc = fakeScene("room");
    const state = {
      ...STATE,
      decks: [{ id: "d1", name: "x", bosses: [], content: contentOf(1, 2, 999) }],
    };
    run({ Quest: sc }, state);
    openMenu(sc);
    const thumbs = alive(sc).filter((o) => o.texture?.key === "CharaCardImages");
    expect(thumbs.map((t) => t.frame)).toEqual(["cc001_01", "cc002_01", "cc000"]);
    const w = thumbs[0]!.displayWidth;
    expect(thumbs[1]!.x - thumbs[0]!.x).toBe(w);
    expect(thumbs[0]!.displayHeight / w).toBeCloseTo(240 / 168, 1);
  });

  it("官方那一房畫「官方 58」（角色 15/13/20 ＋ 壓 C 5 ＋ 武器 3 ＋ 事件 2）", () => {
    const sc = fakeScene("room");
    run({ Match: sc }, { ...STATE, costDisplay: "official" }, { lang: "tcn" });
    openMenu(sc);
    expect(menuTexts(sc).map((t) => t.text)).toContain("官方 58");
  });

  it("自訂那一房畫「自訂 N」—— 價格查規則", () => {
    const sc = fakeScene("room");
    run(
      { Match: sc },
      { ...STATE, costDisplay: "custom" },
      {
        cost: costPatch({ cc001_01: 10, cc002_01: 10, cc003_01: 10 }),
        lang: "tcn",
      },
    );
    openMenu(sc);
    // 10×3 ＋ 武器 3 ＋ 事件 2，差距 0 不罰
    expect(menuTexts(sc).map((t) => t.text)).toContain("自訂 35");
  });

  it("⚠ 自訂那一房但沒選規則 → 退回官方，而且標籤照實寫「官方」", () => {
    const sc = fakeScene("room");
    run({ Match: sc }, { ...STATE, costDisplay: "custom" }, { lang: "tcn" });
    openMenu(sc);
    expect(menuTexts(sc).map((t) => t.text)).toContain("官方 58");
  });

  it("PVE 房不畫 COST", () => {
    const sc = fakeScene("room");
    run({ Quest: sc }, { ...STATE, costDisplay: "none" });
    openMenu(sc);
    expect(menuTexts(sc).some((t) => /^官方|^自訂/.test(String(t.text)))).toBe(false);
  });

  it("渦房才有標籤那一行（查 bossOptions 的字，不是印鍵）", () => {
    const sc = fakeScene("room");
    const state = {
      ...STATE,
      room: "raid",
      decks: [{ id: "d1", name: "x", bosses: ["sea", "fish"], content: contentOf(1, 2, 3) }],
    };
    run({ Raid: sc }, state, { lang: "tcn" });
    openMenu(sc);
    expect(menuTexts(sc).map((t) => t.text)).toContain("標籤 海魚");
  });

  it("官方三牌組模式：前三副名字前面標格號", () => {
    const sc = fakeScene("room");
    run({ Quest: sc }, OFFICIAL);
    openMenu(sc);
    const names = menuTexts(sc).map((t) => t.text);
    expect(names).toContain("1 壓 C 用");
    expect(names).toContain("2 打人用");
  });

  it("⚠ 牌組多到擺不下就把每一列縮小，一副都不能少畫", () => {
    const sc = fakeScene("room");
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      name: `第${i}副`,
      bosses: [],
      content: contentOf(1, 2, 3),
    }));
    run({ Quest: sc }, { ...STATE, decks: many, costDisplay: "none" });
    openMenu(sc);
    expect(menuTexts(sc).filter((t) => String(t.text).startsWith("第"))).toHaveLength(20);
  });
});

describe("狀態推送", () => {
  it("沒安裝時回 not-installed，不是丟例外", () => {
    const expr = buildDeckEditStateExpression(STATE);
    expect(new Script(expr).runInNewContext({ window: {}, JSON })).toBe("not-installed");
  });

  it("⚠ 頁面上是舊腳本時回 stale，不是 ok —— 呼叫端要據此重裝", () => {
    const expr = buildDeckEditStateExpression(STATE);
    const out = new Script(expr).runInNewContext({
      window: { __ulrDeckEdit: { version: 9, setState: () => {} } },
      JSON,
    });
    expect(out).toBe("stale:9");
  });
});

describe("parseDeckEditStatus", () => {
  it("讀得出安裝與掛載狀態", () => {
    expect(
      parseDeckEditStatus(JSON.stringify({ installed: true, mounted: false, version: "abc" })),
    ).toEqual({
      installed: true,
      mounted: false,
      version: "abc",
    });
  });

  it("壞掉的回傳當成沒安裝；舊版的數字版本讀成 null", () => {
    expect(parseDeckEditStatus("壞掉")).toEqual({
      installed: false,
      mounted: false,
      version: null,
    });
    expect(
      parseDeckEditStatus(JSON.stringify({ installed: true, mounted: true, version: 9 })).version,
    ).toBeNull();
  });
});

describe("腳本版本", () => {
  it("是內容指紋，而且寫進腳本裡", () => {
    expect(DECK_EDIT_SCRIPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(script()).toContain(JSON.stringify(DECK_EDIT_SCRIPT_VERSION));
  });

  it("⚠ 玩家的牌組換了不會換指紋 —— 否則改個名字就整份重裝", () => {
    const a = buildDeckEditPatchScript({ bindingName: "__test", state: STATE });
    const b = buildDeckEditPatchScript({ bindingName: "__test", state: OFFICIAL });
    const v = (s: string) => /var VERSION = "([0-9a-f]*)"/.exec(s)?.[1];
    expect(v(a)).toBe(v(b));
  });
});

describe("isDeckEditReport", () => {
  it("認得每一種玩家動作，不認得的擋掉", () => {
    for (const type of ["deck-select", "deck-cycle", "room-switch", "raid-pick", "deck-rename"]) {
      expect(isDeckEditReport({ type })).toBe(true);
    }
    expect(isDeckEditReport({ type: "evil" })).toBe(false);
    expect(isDeckEditReport(null)).toBe(false);
  });
});
