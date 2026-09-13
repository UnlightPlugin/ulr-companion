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

/** 一副牌的內容。三個槽位 ＋ 一把武器 ＋ 一張事件卡，夠算 COST 也夠畫縮圖。 */
function contentOf(a: number, b: number, c: number): DeckEditContent {
  return {
    chara: ["cc001", "cc002", "cc003"],
    charaIndex: [a, b, c],
    weapon: [0, null, null],
    eventIndex: [0, ...Array.from({ length: 17 }, () => null)],
  };
}

const STATE: DeckEditState = {
  room: "dietherm",
  // 規格 §4 的四種房，順序照 ROOM_KINDS（2026-09-12 起：任務→渦→亞城→迪城）
  rooms: [
    { key: "quest", label: "任務" },
    { key: "raid", label: "渦" },
    { key: "alexandria", label: "亞歷山卓城" },
    { key: "dietherm", label: "迪特赫姆" },
  ],
  decks: [
    { id: "d1", name: "壓 C 用", bosses: [], content: contentOf(0, 1, 2) },
    { id: "d2", name: "打人用", bosses: [], content: contentOf(0, 1, 2) },
  ],
  activeId: "d1",
  bossOptions: [
    { key: "sea", label: "海" },
    { key: "fish", label: "魚" },
  ],
  penaltyBands: null,
  costDisplay: "official",
};

function script(state: DeckEditState = STATE): string {
  return buildDeckEditPatchScript({ bindingName: "__test", state });
}

describe("注入腳本", () => {
  it("是合法的 JS —— 註解裡混進反引號會把 template literal 提前收尾", () => {
    // 這正是 v3 開發時撞到的：註解寫了一個反引號，整支腳本變成語法錯誤。
    // ⚠ 只編譯不執行 —— 腳本裡碰的是 window/game，在 Node 這邊跑不起來。
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

  it("edit_icon 上的舊 handler 會先清掉 —— 它是遊戲的物件，不會自己消失", () => {
    expect(script()).toContain('icon.off("pointerdown")');
  });

  // ── 房間場景（2026-09-09 加）──────────────────────────────────────────
  //
  // 任務房底下那一排跟編輯畫面**一模一樣**（實機量到 edit_icon(32,644) ＋ 兩顆
  // edit_arrow(16/48,644)），所以同一套 mount() 掛得上去 —— 玩家在房裡按那顆
  // 棕色牌盒，跳出來的是同一個選單。

  it("除了 Edit 之外也認任務／渦／對戰房", () => {
    const src = script();
    expect(src).toContain("Quest");
    expect(src).toContain("Raid");
    expect(src).toContain("Match");
    // 認的是「有沒有那顆牌盒圖示」，不是場景叫什麼名字
    expect(src).toContain("hasDeckRow");
  });

  it("⚠⚠ 房間清單要 JSON.parse 進去，不能直接用 embedJson 的結果", () => {
    // 2026-09-09 實機上踩到：embedJson() 給的是「要餵給 JSON.parse 的字串字面
    // 值」，直接寫成 `var rooms = <embedJson>` 的話 rooms 是一個**字串**，
    // rooms[i] 取到單一字元，於是永遠找不到場景、選單永遠掛不上 —— 而且完全
    // 不報錯。
    //
    // ⚠ 這一題不能用「原始碼裡有沒有 Quest」來測：字串裡也有 Quest，所以那種
    // 斷言在壞掉的版本上照樣會過（第一版就是這樣漏掉的）。要測的是**取值的
    // 寫法**，並且真的把它跑出來看是不是陣列。
    const src = script();
    expect(src).toMatch(/var rooms = JSON\.parse\(/);
    expect(src).not.toMatch(/var rooms = "/);

    // 真的把那一行跑起來，確認拿到的是陣列
    const line = /var rooms = (JSON\.parse\("(?:[^"\\]|\\.)*"\));/.exec(src);
    expect(line).not.toBeNull();
    const rooms: unknown = new Script(`(${line?.[1]})`).runInNewContext({ JSON });
    expect(Array.isArray(rooms)).toBe(true);
    expect(rooms).toEqual(["Quest", "Raid", "Match"]);
  });

  it("⚠ 清孤兒的清單同理，接上去的不能是字串", () => {
    expect(script()).toMatch(/concat\(JSON\.parse\(/);
  });

  it("⚠ 箭頭的 pointerup 也要拆 —— 任務房的原版行為掛在那裡", () => {
    // 只拆 pointerdown 的話，房裡會變成兩邊同時觸發：我們的換牌組跑了，遊戲
    // 原本那個 deck_now++ 也跑了，玩家看到「標籤跳成 Deck2 但牌沒換」。
    const src = script();
    expect(src).toContain('obj.off("pointerup")');
    expect(src).toContain('obj.off("pointerdown")');
    // hover 換圖不能拆
    expect(src).not.toContain('obj.off("pointerover")');
  });

  it("房裡不畫「房間」那一格與 +／-", () => {
    // 兩個理由：(448,500) 在任務房是地圖正中央；而且站在任務房裡把它切成迪城，
    // 房裡的 ◀▶ 就會切迪城的牌組，按 START 打的卻是任務 —— 拿錯牌組上場。
    const src = script();
    expect(src).toContain("if (!isRoom)");
  });

  it("「房間」那一格的標題跟著遊戲語言換，不是寫死中文", () => {
    // 旁邊「排列(升序)」與「抽出」都照 lang 換，這一格也得換 —— 不然英／日
    // 介面裡會突然冒出兩個中文字。
    const src = script();
    expect(src).toContain("pick(CFG.roomTitle, gameLang())");
    for (const word of ["部屋", "Room", "방", "房间", "房間"]) {
      expect(src).toContain(word);
    }
  });

  it("deck-cycle 會帶 from，區分是房裡還是選單那組箭頭", () => {
    expect(script()).toContain('isRoom ? "room" : "menu"');
  });

  it("⚠ 重掛的判斷要看 GameObject 還在不在，不能只比場景物件", () => {
    // Phaser 的 game.scene.keys.Quest 是長命的 Scene 實例：玩家離開再進來
    // 只是重跑 create()，場景沒換但底下的 GameObject 全是新的。只比場景的話
    // 第二次進房不會重掛，箭頭就變回遊戲原本的行為。
    //
    // ⚠ 錨是牌盒（四個場景都有），不是 objects[0] —— 房裡那份清單是空的，
    // 見「選單開著不能被輪詢收掉」那組測試。
    const src = script();
    expect(src).toContain("mounted.anchor.scene");
    expect(src).not.toContain("mounted.objects[0].scene");
  });

  it("裝之前連房間場景的孤兒也一起清", () => {
    expect(script()).toContain("purgeAll");
  });

  it("長按門檻可設定（規格 §10 要 1 秒）", () => {
    expect(buildDeckEditPatchScript({ bindingName: "x", state: STATE })).toContain(
      "var HOLD_MS = 1000;",
    );
    expect(buildDeckEditPatchScript({ bindingName: "x", state: STATE, dragHoldMs: 400 })).toContain(
      "var HOLD_MS = 400;",
    );
  });

  it("渦房才畫標籤鈕", () => {
    expect(script()).toContain('state.room === "raid"');
  });

  it("房型清單只從狀態來，腳本裡不寫死房型鍵", () => {
    // 寫死的話，改房型要同時改頁面與 Node，而漏掉的那邊沒有測試會抓到。
    // 例外是 "raid" —— 標籤鈕確實只有渦房有（上一個測試）。
    const src = script();
    for (const key of ["alexandria", "quest", "dietherm"]) {
      expect(src.includes(`"${key}"`)).toBe(false);
    }
    // 下拉的選項就是 state.rooms 本身
    expect(src).toContain("options: state.rooms");
  });

  it("四種房都畫得進「房間」鈕的初始狀態", () => {
    const src = buildDeckEditPatchScript({ bindingName: "x", state: STATE });
    for (const label of ["渦", "亞歷山卓城", "任務", "迪特赫姆"]) {
      expect(src).toContain(label);
    }
  });

  it("標籤畫出來是查 bossOptions，不是把鍵直接印上去", () => {
    // 鍵是 sea/fish（勾選面板要拿它比對），直接 join 出來選單上會寫「seafish」。
    const src = script();
    expect(src).toContain("deck.bosses.map(bossLabel)");
    expect(src).toContain("state.bossOptions[i].key === key");
  });

  it("⚠ 內容下放到頁面是**為了畫**，但回報裡永遠沒有它", () => {
    // 2026-09-12 起選單要畫三張卡面縮圖與兩種總 COST，那些只能從內容算，
    // 所以 charaIndex／eventIndex 確實會進頁面（見 DeckEditItem.content）。
    //
    // 真正要守住的是**反方向**：頁面回報的每一種都只帶 id／名字／標籤／索引，
    // 沒有任何一種帶牌組內容回來 —— 內容的真相只有 Node 那一份。
    const src = script();
    expect(src).toContain("content.charaIndex");
    for (const bad of [
      'type: "deck-select", id: deck.id, content',
      "content: content",
      "content: deck.content",
    ]) {
      expect(src).not.toContain(bad);
    }
    // 每一個 report({...}) 的內容裡都不准出現 content
    for (const call of src.match(/report\(\{[^}]*\}\)/g) ?? []) {
      expect(call).not.toContain("content");
    }
  });

  it("玩家名稱之類的機敏資訊不會進腳本", () => {
    expect(script()).not.toContain("db_player");
  });

  it("⚠ 遊戲畫面上不畫任何訊息文字", () => {
    // 2026-09-09 移除。那行紅字在渦房會壓到「輸入Raid代碼」，而且它說的事情
    // 左下那行牌組名本來就寫著。訊息改走托盤的記錄。
    const src = script();
    expect(src).not.toContain("state.notice");
    expect(src).not.toContain("mounted.notice");
    expect(src).not.toContain("#ff9a9a"); // 那行字的顏色
  });
});

// ── 真的把腳本跑起來（2026-09-09 加）────────────────────────────────────
//
// ⚠⚠ 上面那一整批是「原始碼裡有沒有這串字」。那種斷言**在壞掉的版本上照樣會
// 過** —— 渦房掛不上就是這樣漏掉的：腳本裡確實有 "Raid" 這幾個字，而
// hasDeckRow() 認的卻是渦房根本沒有的 edit_icon，於是 `expect(src).toContain
// ("Raid")` 綠燈、實機 mounted 永遠是 false。
//
// 所以這一段用假的 Phaser 場景把整支腳本執行起來，斷言的是**行為**。

interface FakeObject {
  type: string;
  x: number;
  y: number;
  text?: string;
  texture: { key: string } | null;
  depth: number;
  visible: boolean;
  /** 卡面縮圖用 setDisplaySize 等比縮 —— 測試要拿它驗比例與間隙。 */
  displayWidth: number;
  displayHeight: number;
  input: unknown;
  scene: unknown;
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  setInteractive: () => FakeObject;
  setText: (text: string) => FakeObject;
  on: (event: string, fn: (...args: unknown[]) => void) => FakeObject;
  off: (event: string, fn?: (...args: unknown[]) => void) => FakeObject;
  /** 測試用：模擬玩家的一下點擊。 */
  fire: (event: string, ...args: unknown[]) => void;
  destroy: () => void;
  [key: string]: unknown;
}

/** 一個夠用的假 GameObject：鏈式 setter、on/off、destroy 會離開場景。 */
function fakeObject(type: string, x: number, y: number, key: string | null, text?: string) {
  const o = {
    type,
    x,
    y,
    text,
    texture: key === null ? null : { key },
    depth: 0,
    originX: 0.5,
    originY: 0.5,
    width: 16,
    height: 24,
    visible: true,
    alpha: 1,
    strokeColor: null as number | null,
    fillColor: 0,
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
    setStrokeStyle: (_w?: number, c?: number) => ((o.strokeColor = c ?? null), o),
    setDisplaySize: (w: number, h: number) => ((o.displayWidth = w), (o.displayHeight = h), o),
    setColor: () => o,
    setY: (v: number) => ((o.y = v), o),
    setText: (t: string) => ((o.text = t), o),
    setTexture: (k: string) => ((o.texture = { key: k }), o),
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
    /** 測試用：模擬玩家的一下點擊。 */
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
  deck_pre: FakeObject;
  deck_next: FakeObject;
  deck_name: FakeObject;
  [key: string]: unknown;
}

/** 編輯畫面多出來的那幾個：那行牌組名，以及遊戲自己那兩格下拉。 */
interface FakeEditScene extends FakeScene {
  deck1_name: FakeObject;
  sort_rect: FakeObject;
  filter_rect: FakeObject;
  sort_panel: FakeObject;
  filter_panel: FakeObject;
}

/**
 * 一個房間場景。`icon` 就是那顆棕色牌盒 —— **渦房沒有**（實機讀 `Raid.create()`
 * 確認），任務房與對戰房有。
 *
 * 箭頭的原版行為照抄實機讀到的：掛在 **pointerup**，把 `deck_now` 在 1..3 之間
 * 繞，順手改那行標籤。
 */
function fakeScene(options: { icon: boolean; arrowX?: [number, number] }): FakeScene {
  const [preX, nextX] = options.arrowX ?? [16, 48];
  const list: FakeObject[] = [];
  const add = <T extends FakeObject>(o: T): T => {
    o.scene = sc;
    list.push(o);
    return o;
  };
  const sc = {
    children: { list },
    deck_now: 1,
    deck1: { chara: [], charaIndex: [] },
    scale: { width: 760, height: 680 },
    scene: { isActive: () => true },
    ulse01: { play: () => {} },
    add: {
      sprite: (x: number, y: number, k: string) => add(fakeObject("Sprite", x, y, k)),
      image: (x: number, y: number, k: string) => add(fakeObject("Image", x, y, k)),
      text: (x: number, y: number, t: string, style?: unknown) =>
        Object.assign(add(fakeObject("Text", x, y, null, t)), { style: style ?? {} }),
      zone: (x: number, y: number) => add(fakeObject("Zone", x, y, null)),
      nineslice: (x: number, y: number, k: string) => add(fakeObject("NineSlice", x, y, k)),
      existing: (o: FakeObject) => add(o),
    },
    deck_card: () => {},
  } as unknown as FakeScene;

  sc.deck_pre = add(fakeObject("Sprite", preX, 644, "edit_arrow")).setInteractive();
  sc.deck_next = add(fakeObject("Sprite", nextX, 644, "edit_arrow")).setInteractive();
  sc.deck_name = add(fakeObject("Text", 64, 644, null, "Deck1 "));
  if (options.icon) add(fakeObject("Sprite", 32, 644, "edit_icon"));

  const step = (delta: number) => () => {
    sc.deck_now += delta;
    if (sc.deck_now < 1) sc.deck_now = 3;
    if (sc.deck_now > 3) sc.deck_now = 1;
    sc.deck_name.setText(`Deck${sc.deck_now} `);
  };
  sc.deck_pre.on("pointerover", () => {});
  sc.deck_pre.on("pointerup", step(-1));
  sc.deck_next.on("pointerover", () => {});
  sc.deck_next.on("pointerup", step(1));
  return sc;
}

interface RunResult {
  result: unknown;
  reports: { type: string; [key: string]: unknown }[];
  api: { isMounted: () => boolean; version: string };
  /** 頁面物件。再跑一次時傳回 {@link rerun}，模擬「遊戲沒重載、腳本還活著」。 */
  window: Record<string, unknown>;
}

/** 在同一個頁面物件上執行一次安裝腳本。 */
function exec(win: Record<string, unknown>, state: DeckEditState): unknown {
  const context: Record<string, unknown> = {
    // 輪詢那一拍存到 window.__tick，測試想模擬「500ms 過去了」就叫它。
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

/**
 * 把腳本丟進 vm 跑，回傳掛載結果與玩家操作回報。
 *
 * `opts.cost` 是頁面上那份 `__ulrCostPatch`（`patch-cost.ts` 留下的）——
 * 有 `customs` 才畫得出「自訂」那個總和，沒有就只畫官方。
 */
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
  return { result, reports, api: win["__ulrDeckEdit"] as RunResult["api"], window: win };
}

/** 一份「有自訂表」的 `__ulrCostPatch`：三張角色卡都被規則動過。 */
function costPatch(customs: Record<string, number>): Record<string, unknown> {
  return {
    originals: { characters: { cc001_01: 15, cc002_01: 13, cc003_01: 20 } },
    customs: { characters: customs },
  };
}

/**
 * 再裝一次到**同一個頁面**上。
 *
 * 這就是實機上那個情境：托盤換了新版、遊戲沒重載，所以 `window.__ulrDeckEdit`
 * 是上一個托盤裝的那份、還活著。
 */
function rerun(win: Record<string, unknown>, state: DeckEditState): { result: unknown } {
  return { result: exec(win, state) };
}

// ── 編輯畫面那一半的假件（2026-09-12 加）───────────────────────────────
//
// 「房間」下拉、＋－、就地改名全部只畫在 Edit，而上面那套假場景是房間場景用
// 的（沒有 rexUI、沒有 deck1_name），所以那三個從來沒被真的跑起來過 ——
// 而它們正是這一輪改的東西。

/** 假的貼圖管理。`draws` 記下 plainButtonTexture 到底裁了哪兩段。 */
function fakeTextures(): {
  manager: Record<string, unknown>;
  draws: number[][];
  frames: (string | number)[];
  created: string[];
} {
  const atlases: Record<string, string[]> = {
    edit_reset: ["0", "1"],
    btn_gene: ["0", "1"],
    edit_icon: [],
    panel_gene: [],
    ccframe_base: ["0"],
    cc_front: ["cc001_01", "cc002_01", "cc003_01"],
    mc_front: ["mc001_01"],
  };
  const draws: number[][] = [];
  const frames: (string | number)[] = [];
  const created: string[] = [];
  const manager = {
    exists: (k: string) => Object.prototype.hasOwnProperty.call(atlases, k),
    get: (k: string) => ({
      has: (f: string | number) => (atlases[k] ?? []).includes(String(f)),
      getFrameNames: () => atlases[k] ?? [],
      getSourceImage: () => ({ width: 64, height: 48 }),
    }),
    createCanvas: (key: string, _w: number, _h: number) => {
      created.push(key);
      atlases[key] = [];
      return {
        getContext: () => ({
          clearRect: () => {},
          drawImage: (...args: unknown[]) => draws.push(args.slice(1) as number[]),
        }),
        refresh: () => {},
        add: (name: string | number) => {
          frames.push(name);
          (atlases[key] ??= []).push(String(name));
        },
      };
    },
  };
  return { manager, draws, frames, created };
}

interface FakePanel extends FakeObject {
  layout: () => FakePanel;
  setChildrenInteractive: () => FakePanel;
  children: never;
}

/**
 * 假的 rexUI，只做這支用到的那幾個：roundRectangle / BBCodeText / sizer /
 * label / scrollablePanel。
 *
 * 展開的面板把 label 記在 `options` 裡，測試就能用 `pick()` 模擬玩家點了
 * 哪一列（真的 rexUI 是發 `child.up` 事件，這裡照樣發）。
 */
function fakeRexUI(sc: FakeScene): {
  rexUI: Record<string, unknown>;
  panels: Record<string, unknown>[];
} {
  const panels: Record<string, unknown>[] = [];
  const add = {
    roundRectangle: (...args: unknown[]) => {
      const [x, y] = typeof args[0] === "number" ? [args[0], args[1] as number] : [0, 0];
      const o = fakeObject("rexRoundRectangleShape", x as number, y, null);
      (sc.children as { list: FakeObject[] }).list.push(o);
      o.scene = sc;
      return o;
    },
    BBCodeText: (x: number, y: number, text: string) => {
      const o = fakeObject("rexBBCodeText", x, y, null, text);
      (sc.children as { list: FakeObject[] }).list.push(o);
      o.scene = sc;
      return o;
    },
    sizer: () => {
      const kids: Record<string, unknown>[] = [];
      return { kids, add: (child: Record<string, unknown>) => (kids.push(child), undefined) };
    },
    label: (cfg: { background: FakeObject; text: FakeObject; name: string }) => ({
      name: cfg.name,
      getElement: (which: string) => (which === "background" ? cfg.background : cfg.text),
    }),
    scrollablePanel: (cfg: {
      x: number;
      y: number;
      height: number;
      panel: { child: { kids: Record<string, unknown>[] } };
    }) => {
      const p = fakeObject("rexScrollablePanel", cfg.x, cfg.y, null) as unknown as FakePanel;
      const rec = p as unknown as Record<string, unknown>;
      rec["options"] = cfg.panel.child.kids;
      rec["height"] = cfg.height;
      rec["layout"] = () => p;
      rec["setChildrenInteractive"] = () => p;
      p.visible = true;
      (sc.children as { list: FakeObject[] }).list.push(p);
      p.scene = sc;
      panels.push(rec);
      return p;
    },
  };
  return { rexUI: { add }, panels };
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
 * 遊戲自己的四份資料，**只放價格要用的欄位**。
 *
 * 15 / 13 / 20 這組是 docs/official-cost-rule.md 的第一個對照例子：差距
 * 2、5、7 → 只有 13↔20 那一對超標，罰 5。加上武器 3、事件卡 2 之後官方總和
 * 是 58。
 */
function fakeJsonCache(): Record<string, unknown> {
  const data: Record<string, unknown> = {
    cc_asset: {
      frames: [
        { filename: "cc001_01", chara: "cc001", cost: 15 },
        { filename: "cc002_01", chara: "cc002", cost: 13 },
        { filename: "cc003_01", chara: "cc003", cost: 20 },
      ],
    },
    mc_asset: { frames: [{ filename: "mc001_01", chara: "mc001", cost: 9 }] },
    avatar_item: { weapon: [{ cost: 3 }] },
    event_info: { frames: [{ cost: 2 }] },
  };
  return {
    has: (k: string) => Object.prototype.hasOwnProperty.call(data, k),
    get: (k: string) => data[k],
  };
}

/** 編輯畫面。有 deck1_name、遊戲自己那兩格下拉、rexUI 與貼圖。 */
function fakeEditScene(): {
  sc: FakeEditScene;
  textures: ReturnType<typeof fakeTextures>;
  panels: Record<string, unknown>[];
} {
  const sc = fakeScene({ icon: true }) as FakeEditScene;
  const list = (sc.children as { list: FakeObject[] }).list;
  const attach = <T extends FakeObject>(o: T): T => ((o.scene = sc), list.push(o), o);
  sc.deck1_name = attach(fakeObject("Text", 5, 450, null, "Deck1 "));
  sc.sort_rect = attach(fakeObject("rexRoundRectangleShape", 510, 480, null));
  sc.filter_rect = attach(fakeObject("rexRoundRectangleShape", 498, 431, null));
  sc.sort_panel = attach(fakeObject("rexScrollablePanel", 461, 490, null));
  sc.filter_panel = attach(fakeObject("rexScrollablePanel", 448, 440, null));
  const textures = fakeTextures();
  sc.textures = textures.manager;
  const rex = fakeRexUI(sc);
  sc.rexUI = rex.rexUI;
  return { sc, textures, panels: rex.panels };
}

/** 選單裡的一列（畫出來的那些物件，照 y 分組）。 */
function menuTexts(sc: FakeScene): FakeObject[] {
  return (sc.children as { list: FakeObject[] }).list.filter(
    (o) => o.scene !== null && o.text !== undefined && o.depth === 1503,
  );
}

const iconsOf = (sc: FakeScene) =>
  sc.children.list.filter((o) => o.texture?.key === "edit_icon" && o.scene !== null);

describe("渦房（實際跑起來，不是比字串）", () => {
  const RAID_STATE: DeckEditState = { ...STATE, room: "raid" };

  it("⚠⚠ 渦房沒有棕色牌盒，照樣要掛得上", () => {
    // 這一題就是 v9 的 bug：hasDeckRow() 認 edit_icon，而 Raid.create() 裡
    // 根本沒有那顆（實機 indexOf 是 -1），於是渦房 mounted 永遠 false。
    const raid = fakeScene({ icon: false });
    const { result, api } = run({ Raid: raid }, RAID_STATE);
    expect(result).toBe("installed");
    expect(api.isMounted()).toBe(true);
  });

  it("找不到牌盒就自己補一顆，位置是兩顆箭頭的正中間", () => {
    const raid = fakeScene({ icon: false });
    run({ Raid: raid }, RAID_STATE);
    const icons = iconsOf(raid);
    expect(icons).toHaveLength(1);
    expect(icons[0]?.x).toBe(32);
    expect(icons[0]?.y).toBe(644);
    expect(icons[0]?.input).not.toBeNull();
  });

  it("補出來的牌盒點得開選單，選一副會回報 deck-select", () => {
    const raid = fakeScene({ icon: false });
    const { reports } = run({ Raid: raid }, RAID_STATE);
    const icon = iconsOf(raid)[0];
    expect(icon).toBeDefined();

    const before = raid.children.list.length;
    icon?.fire("pointerdown");
    expect(raid.children.list.length).toBeGreaterThan(before);

    // 選單第一列的名字要畫出來
    const row = raid.children.list.find((o) => o.text === RAID_STATE.decks[0]?.name);
    expect(row).toBeDefined();

    // 點那一列 → 回報選這一副
    const hit = raid.children.list.find((o) => o.type === "Zone" && o.depth === 1502);
    hit?.fire("pointerdown", { y: 0 });
    hit?.fire("pointerup", { y: 0 });
    expect(reports.map((r) => r.type)).toContain("deck-select");
    expect(reports.find((r) => r.type === "deck-select")?.id).toBe(RAID_STATE.decks[0]?.id);
  });

  it("⚠ 箭頭的原版 pointerup 行為要被拆掉 —— 不然 deck_now 會跑掉", () => {
    // 渦房的原版行為跟任務房一樣掛在 pointerup（實機讀到）：deck_now++ 之後
    // 標籤跳成 Deck2/Deck3，而那兩格是空的，按下 OK 就是拿空牌打渦。
    const raid = fakeScene({ icon: false });
    const { reports } = run({ Raid: raid }, RAID_STATE);

    raid.deck_next.fire("pointerup");
    raid.deck_pre.fire("pointerup");
    expect(raid.deck_now).toBe(1);
    // 標籤也不能被原版動到。⚠ 它現在寫的是**套用中那一副的名字**（見下面那兩
    // 題），所以這裡不能斷言 "Deck1 " —— 要斷言的是它沒有跳成 Deck2／Deck3。
    expect(raid.deck_name.text).toBe(`${RAID_STATE.decks[0]?.name} `);
    expect(raid.deck_name.text).not.toMatch(/^Deck[23] $/);

    // 換牌組改掛在 pointerdown，而且要標明是房裡那一組
    raid.deck_next.fire("pointerdown");
    const cycle = reports.filter((r) => r.type === "deck-cycle");
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toMatchObject({ delta: 1, from: "room" });

    // hover 換圖不能被拆掉
    expect(raid.deck_pre.handlers["pointerover"]?.length).toBe(1);
  });

  it("渦房才有的標籤那一行在選單裡", () => {
    // 2026-09-12 起它不是一顆獨立的鈕，而是那一列右邊三行字的第二行
    // （「標籤 海魚」）—— 點它一樣開勾選面板。
    const raid = fakeScene({ icon: false });
    run({ Raid: raid }, RAID_STATE);
    iconsOf(raid)[0]?.fire("pointerdown");
    expect(raid.children.list.some((o) => String(o.text).indexOf("Tag") === 0)).toBe(true);
  });

  it("⚠ 左下那行字顯示的是套用中那一副的名字，不是寫死的 Deck1", () => {
    // 2026-09-09 回報：「顯示牌組一，但這個牌組在渦房是牌組三的」。房裡那行字
    // 是 deck_name（編輯畫面才是 deck1_name），原本沒人改它。
    const raid = fakeScene({ icon: false });
    run({ Raid: raid }, { ...RAID_STATE, activeId: "d2" });
    expect(raid.deck_name.text).toBe(`${RAID_STATE.decks[1]?.name} `);
  });

  it("狀態換了那行字要跟著換", () => {
    const raid = fakeScene({ icon: false });
    const first = run({ Raid: raid }, { ...RAID_STATE, activeId: "d1" });
    expect(raid.deck_name.text).toBe(`${RAID_STATE.decks[0]?.name} `);

    const api = first.window["__ulrDeckEdit"] as { setState: (s: DeckEditState) => void };
    api.setState({ ...RAID_STATE, activeId: "d2" });
    expect(raid.deck_name.text).toBe(`${RAID_STATE.decks[1]?.name} `);
  });

  it("房裡不畫 +／- 與「房間」鈕", () => {
    const raid = fakeScene({ icon: false });
    run({ Raid: raid }, RAID_STATE);
    const texts = raid.children.list.map((o) => o.text);
    expect(texts).not.toContain("+");
    expect(texts).not.toContain("房間");
  });
});

describe("⚠⚠ 選單開著不能被輪詢收掉（2026-09-12 回報）", () => {
  // 任務房／對戰房：牌盒是遊戲的、＋－與房間那一格不畫 → 我們的物件清單是
  // **空的**。舊的重掛判斷看 objects[0]，空清單永遠答「死了」→ 每 500ms 重掛
  // 一次 → 選單開了半秒就被 unmount 收掉。渦房沒事只是因為我們補了一顆牌盒。
  const tickOf = (win: Record<string, unknown>) => win["__tick"] as () => void;

  for (const [name, make] of [
    ["任務房", () => fakeScene({ icon: true })],
    [
      "對戰房",
      () => {
        const m = fakeScene({ icon: false, arrowX: [396, 428] });
        m.children.list.push(
          Object.assign(fakeObject("Sprite", 412, 644, "edit_icon"), { scene: m }),
        );
        return m;
      },
    ],
    ["渦房", () => fakeScene({ icon: false })],
  ] as const) {
    it(`${name}：連跑幾拍，開著的選單還在`, () => {
      const sc = make();
      const { window: win } = run({ Quest: sc }, { ...STATE, room: "raid" });
      const before = sc.children.list.length;
      iconsOf(sc)[0]?.fire("pointerdown");
      expect(sc.children.list.length).toBeGreaterThan(before);
      const opened = sc.children.list.filter((o) => o.scene !== null).length;

      tickOf(win)();
      tickOf(win)();
      tickOf(win)();
      expect(sc.children.list.filter((o) => o.scene !== null).length).toBe(opened);
      // 錨也沒被重掛換掉：牌盒上仍然只有一個 handler
      expect(iconsOf(sc)[0]?.handlers["pointerdown"]?.length).toBe(1);
    });
  }

  it("場景真的重建了（牌盒死掉）才重掛", () => {
    const sc = fakeScene({ icon: true });
    const { window: win } = run({ Quest: sc });
    const icon = iconsOf(sc)[0];
    expect(icon).toBeDefined();
    // 模擬 create() 重跑：舊物件全死、新的一顆牌盒出現
    sc.children.list.forEach((o) => o.destroy());
    sc.children.list.length = 0;
    const fresh = Object.assign(fakeObject("Sprite", 32, 644, "edit_icon"), { scene: sc });
    sc.children.list.push(fresh);
    sc.deck_pre = Object.assign(fakeObject("Sprite", 16, 644, "edit_arrow"), { scene: sc });
    sc.deck_next = Object.assign(fakeObject("Sprite", 48, 644, "edit_arrow"), { scene: sc });
    sc.children.list.push(sc.deck_pre, sc.deck_next);
    tickOf(win)();
    expect(fresh.handlers["pointerdown"]?.length).toBe(1);
  });
});

describe("渦房選中一個渦 → raid-pick（2026-09-13）", () => {
  const tickOf = (win: Record<string, unknown>) => win["__tick"] as () => void;
  const picks = (reports: RunResult["reports"]) => reports.filter((r) => r.type === "raid-pick");

  function raidScene() {
    const sc = fakeScene({ icon: false }) as FakeScene & Record<string, unknown>;
    sc["raid_info"] = { visible: false };
    sc["raid_idx"] = null;
    sc["raid_data"] = [
      { profound_id: "2076-aaa", profound_mons: "mc1003_02" },
      { profound_id: "2092-bbb", profound_mons: "mc1008_02" },
    ];
    return sc;
  }

  it("面板打開時報一次那隻 BOSS 的代碼，之後每拍不重報", () => {
    const sc = raidScene();
    const { window: win, reports } = run({ Raid: sc }, { ...STATE, room: "raid" });
    expect(picks(reports)).toHaveLength(0);

    sc["raid_idx"] = 1;
    (sc["raid_info"] as { visible: boolean }).visible = true;
    tickOf(win)();
    tickOf(win)();
    tickOf(win)();
    expect(picks(reports)).toEqual([{ type: "raid-pick", mons: "mc1008_02" }]);
  });

  it("換一個渦就再報；關掉再點同一個也會再報", () => {
    const sc = raidScene();
    const { window: win, reports } = run({ Raid: sc }, { ...STATE, room: "raid" });
    const info = sc["raid_info"] as { visible: boolean };

    sc["raid_idx"] = 1;
    info.visible = true;
    tickOf(win)();
    sc["raid_idx"] = 0;
    tickOf(win)();
    info.visible = false;
    tickOf(win)();
    info.visible = true;
    tickOf(win)();
    expect(picks(reports).map((r) => r["mons"])).toEqual(["mc1008_02", "mc1003_02", "mc1003_02"]);
  });

  it("沒有渦資料的房間場景（任務房）什麼都不報", () => {
    const { window: win, reports } = run({ Quest: fakeScene({ icon: true }) });
    tickOf(win)();
    expect(picks(reports)).toHaveLength(0);
  });
});

describe("其他有牌盒的場景不受影響", () => {
  it("任務房本來就有牌盒，不會被補出第二顆", () => {
    const quest = fakeScene({ icon: true });
    const { api } = run({ Quest: quest });
    expect(api.isMounted()).toBe(true);
    expect(iconsOf(quest)).toHaveLength(1);
    expect(iconsOf(quest)[0]?.x).toBe(32);
  });

  it("對戰房的牌盒在 412，一樣認得出來也不會多補", () => {
    // Match 的箭頭是遊戲自訂的按鈕類別，不保證以 edit_arrow 的身分出現在
    // children.list 裡 —— 所以 hasDeckRow() 仍然要認 edit_icon。
    const match = fakeScene({ icon: false, arrowX: [396, 428] });
    match.children.list.push(
      Object.assign(fakeObject("Sprite", 412, 644, "edit_icon"), { scene: match }),
    );
    const { api } = run({ Match: match });
    expect(api.isMounted()).toBe(true);
    expect(iconsOf(match)).toHaveLength(1);
    expect(iconsOf(match)[0]?.x).toBe(412);
  });

  it("沒有那一排的場景不掛 —— 也不會每一拍重掛", () => {
    const bare = {
      children: { list: [] },
      scene: { isActive: () => true },
    } as unknown as FakeScene;
    const { api } = run({ Raid: bare });
    expect(api.isMounted()).toBe(false);
  });
});

describe("狀態推送", () => {
  it("沒安裝時回 not-installed，不是丟例外", () => {
    expect(buildDeckEditStateExpression(STATE)).toContain("not-installed");
  });

  it("狀態一樣是 JSON.parse 進去", () => {
    expect(buildDeckEditStateExpression(STATE)).toContain("JSON.parse(");
  });

  it("⚠ 頁面上是舊腳本時回 stale，不是 ok —— 呼叫端要據此重裝", () => {
    const push = (pageVersion: unknown): unknown => {
      const win: Record<string, unknown> = {
        __ulrDeckEdit:
          pageVersion === undefined
            ? undefined
            : { version: pageVersion, setState: () => {}, isMounted: () => true },
      };
      return new Script(buildDeckEditStateExpression(STATE)).runInContext(
        createContext({ window: win }),
      );
    };
    expect(push(DECK_EDIT_SCRIPT_VERSION)).toBe("ok");
    expect(push(9)).toBe("stale:9"); // 手動號碼的年代留下來的那份
    expect(push("0000deadbeef")).toBe("stale:0000deadbeef");
    expect(push(undefined)).toBe("not-installed");
  });
});

describe("parseDeckEditStatus", () => {
  it("讀得出安裝與掛載狀態", () => {
    const s = parseDeckEditStatus(
      JSON.stringify({ installed: true, mounted: true, version: DECK_EDIT_SCRIPT_VERSION }),
    );
    expect(s).toEqual({ installed: true, mounted: true, version: DECK_EDIT_SCRIPT_VERSION });
  });

  it("installed 與 mounted 是兩件事 —— 玩家不在牌組畫面時只有前者為真", () => {
    const s = parseDeckEditStatus(JSON.stringify({ installed: true, mounted: false, version: 5 }));
    expect(s.installed).toBe(true);
    expect(s.mounted).toBe(false);
  });

  it("壞掉的回傳當成沒安裝，不丟例外", () => {
    expect(parseDeckEditStatus("<html>")).toEqual({
      installed: false,
      mounted: false,
      version: null,
    });
  });

  it("⚠ 舊版腳本回的數字版本讀成 null —— 那會讓呼叫端把它重裝掉", () => {
    // 這正是要的行為：頁面上活著的舊腳本回的是 9（手動維護的那個號碼），
    // 跟現在的指紋一定不相等，於是 `deckEditStatus()` 會重裝一次。
    const s = parseDeckEditStatus(JSON.stringify({ installed: true, mounted: false, version: 9 }));
    expect(s.installed).toBe(true);
    expect(s.version).toBeNull();
    expect(s.version === DECK_EDIT_SCRIPT_VERSION).toBe(false);
  });
});

// ── 版本＝內容指紋（2026-09-09 加）──────────────────────────────────────
//
// 起因：改了腳本、版本號也 +1 了、發版也成功了，**頁面上跑的還是舊的**。
// 兩個環節同時壞掉 —— 沒有人去比那個號碼，而號碼本身還得靠人記得改。
// 現在版本是算出來的，忘不掉。

describe("腳本版本", () => {
  it("是內容指紋，不是手寫的號碼", () => {
    expect(typeof DECK_EDIT_SCRIPT_VERSION).toBe("string");
    expect(DECK_EDIT_SCRIPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it("腳本裡寫進去的就是它", () => {
    expect(script()).toContain(`var VERSION = ${JSON.stringify(DECK_EDIT_SCRIPT_VERSION)};`);
  });

  it("⚠ 玩家的牌組換了不會換指紋 —— 否則改個名字就整份重裝", () => {
    const other: DeckEditState = {
      ...STATE,
      room: "raid",
      decks: [
        {
          id: "zzz",
          name: "完全不一樣的一副",
          bosses: ["sea", "fish"],
          content: contentOf(9, 8, 7),
        },
      ],
      activeId: "zzz",
    };
    const a = buildDeckEditPatchScript({ bindingName: "__test", state: STATE });
    const b = buildDeckEditPatchScript({ bindingName: "__test", state: other });
    expect(a).not.toBe(b); // 內容確實不同
    const version = (s: string) => /var VERSION = "([0-9a-f]{12})";/.exec(s)?.[1];
    expect(version(a)).toBe(DECK_EDIT_SCRIPT_VERSION);
    expect(version(b)).toBe(DECK_EDIT_SCRIPT_VERSION);
  });

  it("同一份指紋重裝只換狀態；指紋不同就整份換掉", () => {
    // 「已經裝著同一版」→ 不動畫面，只換狀態
    const raid = fakeScene({ icon: false });
    const first = run({ Raid: raid }, { ...STATE, room: "raid" });
    expect(first.result).toBe("installed");

    const again = rerun(first.window, { ...STATE, room: "raid" });
    expect(again.result).toBe("already-installed");

    // 「頁面上是舊版」→ 拆掉重裝
    const stale = first.window["__ulrDeckEdit"] as { version: string };
    stale.version = "0000deadbeef";
    const replaced = rerun(first.window, { ...STATE, room: "raid" });
    expect(replaced.result).toBe("installed");
    expect((first.window["__ulrDeckEdit"] as { version: string }).version).toBe(
      DECK_EDIT_SCRIPT_VERSION,
    );
  });
});

describe("isDeckEditReport", () => {
  it("認得每一種玩家動作", () => {
    for (const type of [
      "deck-select",
      "deck-add",
      "deck-remove",
      "deck-rename",
      "deck-move",
      "deck-bosses",
      "deck-save-current",
      "room-switch",
      "raid-pick",
      "deck-ui-error",
    ]) {
      expect(isDeckEditReport({ type })).toBe(true);
    }
  });

  it("不認得的一律擋掉", () => {
    expect(isDeckEditReport({ type: "lobby-quick" })).toBe(false);
    expect(isDeckEditReport({})).toBe(false);
    expect(isDeckEditReport(null)).toBe(false);
    expect(isDeckEditReport("deck-select")).toBe(false);
  });
});

// ── 2026-09-12 那一輪（下拉選單、reset 樣的＋－、選單版面、就地改名）──────

describe("「房間」改成下拉選單", () => {
  /** 畫出來的那顆下拉：值的文字物件與展開的面板。 */
  function roomDrop(panels: Record<string, unknown>[]): Record<string, unknown> {
    const p = panels[panels.length - 1];
    expect(p).toBeDefined();
    return p as Record<string, unknown>;
  }

  it("四房都列進面板裡，照狀態給的順序，不是一顆按一下換一房的循環鈕", () => {
    const { sc, panels } = fakeEditScene();
    run({ Edit: sc });
    const opts = roomDrop(panels)["options"] as { name: string }[];
    expect(opts.map((o) => o.name)).toEqual(["quest", "raid", "alexandria", "dietherm"]);
  });

  it("⚠⚠ 每一列的字要畫在自己那列的白底**上面**", () => {
    // 2026-09-12 實機撞到：字都建好了、位置也對，畫面上卻是一個空白的下拉。
    // 同深度裡後建的在上面，而那版是「先字後底」→ 白底蓋住字。兩道保險：
    // 底先建、字再建；而且字的深度比面板整棵樹（1）再高一層。
    const { sc, panels } = fakeEditScene();
    run({ Edit: sc });
    const list = (sc.children as { list: FakeObject[] }).list;
    const opts = roomDrop(panels)["options"] as {
      getElement: (k: string) => FakeObject;
    }[];
    for (const opt of opts) {
      const bg = opt.getElement("background");
      const text = opt.getElement("text");
      expect(list.indexOf(text)).toBeGreaterThan(list.indexOf(bg));
      expect(text.depth).toBeGreaterThan(roomDrop(panels)["depth"] as number);
    }
  });

  it("「房間」那兩個字右邊留白 —— 斜體會斜出量測寬度被裁掉", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    const label = (sc.children as { list: FakeObject[] }).list.find(
      (o) => o.__ulrDeckOwned === true && o.text === "Room",
    );
    expect(label).toBeDefined();
    expect((label?.style as { padding?: { right?: number } })?.padding?.right).toBeGreaterThan(0);
  });

  it("⚠⚠ 關著的那一列深度必須是 0 —— 不然它會浮在遊戲的排列選單上面", () => {
    // 2026-09-12 回報的第 1 條：排列(升序) 展開之後被我們這一格蓋住。
    // 原版 sort_rect 是深度 0、sort_panel 是 1，我們放 2 就會贏過那個面板。
    const { sc, panels } = fakeEditScene();
    run({ Edit: sc });
    const ours = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.__ulrDeckOwned === true && o.scene !== null,
    );
    const row = ours.filter((o) => Math.round(o.y) >= 495 && Math.round(o.y) <= 535);
    expect(row.length).toBeGreaterThan(0);
    for (const o of row) expect(o.depth).toBe(0);
    // 展開的面板本身可以到 1（跟遊戲自己的面板同一層，而且互斥）
    expect(roomDrop(panels)["depth"]).toBe(1);
  });

  it("點一個選項回報 room-switch；點現在這一房不回報", () => {
    const { sc, panels } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    const panel = roomDrop(panels);
    const opts = panel["options"] as { name: string; getElement: (k: string) => FakeObject }[];
    const fire = panel["fire"] as (event: string, child: unknown) => void;

    fire("child.up", opts[1]); // 渦
    expect(reports.filter((r) => r.type === "room-switch")).toEqual([
      { type: "room-switch", room: "raid" },
    ]);

    // 現在就在迪特赫姆 —— 再點它一次沒有任何事情要做
    fire("child.up", opts[3]);
    expect(reports.filter((r) => r.type === "room-switch")).toHaveLength(1);
    // 選完面板收起來
    expect(panel["visible"]).toBe(false);
  });

  it("三格互斥：開我們的關遊戲的，點遊戲的收我們的", () => {
    const { sc, panels } = fakeEditScene();
    run({ Edit: sc });
    const panel = roomDrop(panels);
    const rect = (sc.children as { list: FakeObject[] }).list.find(
      (o) => o.__ulrDeckOwned === true && o.type === "rexRoundRectangleShape",
    );
    expect(rect).toBeDefined();

    sc.sort_panel.visible = true;
    sc.filter_panel.visible = true;
    rect?.fire("pointerdown");
    expect(panel["visible"]).toBe(true);
    expect(sc.sort_panel.visible).toBe(false);
    expect(sc.filter_panel.visible).toBe(false);

    // 反過來：玩家去點遊戲自己那一格，我們這個要收起來
    sc.sort_rect.fire("pointerdown");
    expect(panel["visible"]).toBe(false);
  });

  it("換了房，那一格顯示的字要跟著換", () => {
    const { sc } = fakeEditScene();
    const { window: win } = run({ Edit: sc });
    const api = win["__ulrDeckEdit"] as { setState: (s: DeckEditState) => void };
    const value = () =>
      (sc.children as { list: FakeObject[] }).list.find(
        (o) => o.__ulrDeckOwned === true && o.type === "rexBBCodeText",
      )?.text;
    expect(value()).toBe("迪特赫姆");
    api.setState({ ...STATE, room: "raid" });
    expect(value()).toBe("渦");
  });

  it("卸載時掛在遊戲那兩格上的 handler 要收回來", () => {
    const { sc } = fakeEditScene();
    const { window: win } = run({ Edit: sc });
    expect(sc.sort_rect.handlers["pointerdown"]?.length).toBe(1);
    (win["__ulrDeckEdit"] as { uninstall: () => void }).uninstall();
    expect(sc.sort_rect.handlers["pointerdown"] ?? []).toHaveLength(0);
  });
});

describe("＋－照抄 reset 的樣子", () => {
  it("貼圖是 edit_reset 的左右邊框拼起來 —— 中間烤著字的那一段不要", () => {
    // edit_reset 的「reset」是畫在圖裡的（字佔 x18..45），疊字上去會有兩層。
    const { sc, textures } = fakeEditScene();
    run({ Edit: sc });
    expect(textures.created).toEqual(["ulr_btn_plain"]);
    expect(textures.draws).toEqual([
      [6, 0, 12, 48, 0, 0, 12, 48],
      [46, 0, 12, 48, 12, 0, 12, 48],
    ]);
    // 常態與 hover 兩格，跟 edit_reset 自己一樣
    expect(textures.frames).toEqual([0, 1]);
  });

  it("兩顆用的就是那張貼圖，而且按了會回報", () => {
    const { sc } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    const btns = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "ulr_btn_plain",
    );
    expect(btns).toHaveLength(2);
    expect(btns.map((b) => b.x)).toEqual([74, 100]);

    btns[0]?.fire("pointerdown");
    btns[1]?.fire("pointerdown");
    expect(reports.map((r) => r.type)).toEqual(["deck-add", "deck-remove"]);
    expect(reports[1]?.id).toBe("d1");
  });

  it("hover 換第二格，就跟 reset 一樣", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    const plus = (sc.children as { list: FakeObject[] }).list.find(
      (o) => o.texture?.key === "ulr_btn_plain",
    );
    plus?.fire("pointerover");
    expect(plus?.texture?.key).toBe("ulr_btn_plain");
  });

  it("⚠ 深度壓在選單的擋點擊罩底下 —— 選單開著不能還按得到「－」", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    const btns = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "ulr_btn_plain",
    );
    for (const b of btns) expect(b.depth).toBeLessThan(1500);
  });

  it("拼不出貼圖就退回 btn_gene，不要整個炸掉", () => {
    const { sc } = fakeEditScene();
    (sc.textures as { createCanvas: unknown }).createCanvas = () => null;
    const { api } = run({ Edit: sc });
    expect(api.isMounted()).toBe(true);
    const btns = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "btn_gene" && Math.round(o.y) === 644,
    );
    expect(btns).toHaveLength(2);
  });
});

describe("牌盒選單的新版面", () => {
  /** 打開選單。 */
  function openMenu(sc: FakeScene): void {
    const icon = (sc.children as { list: FakeObject[] }).list.find(
      (o) => o.texture?.key === "edit_icon",
    );
    expect(icon).toBeDefined();
    icon?.fire("pointerdown");
  }

  it("沒有「改名」鈕了 —— 改名改成點左下那行字", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    openMenu(sc);
    expect(menuTexts(sc).map((o) => o.text)).not.toContain("改名");
  });

  it("三張卡面縮圖，之間不留間隙", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    openMenu(sc);
    const thumbs = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "cc_front" && o.scene !== null,
    );
    // 兩副牌各三張
    expect(thumbs).toHaveLength(6);
    expect(thumbs.slice(0, 3).map((t) => t.texture?.key)).toEqual([
      "cc_front",
      "cc_front",
      "cc_front",
    ]);
    // 卡面比例不能歪：168×240 等比縮
    const first = thumbs[0];
    expect(first?.displayWidth).toBe(Math.round((first?.displayHeight ?? 0) * (168 / 240)));
    // 間隙 0 —— 下一張的左緣正好是上一張的右緣
    const step = (thumbs[1]?.x ?? 0) - (thumbs[0]?.x ?? 0);
    expect(step).toBe(first?.displayWidth);
  });

  it("名字／標籤／COST 都在卡的右邊，沒有一行自己佔一列", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc }, { ...STATE, room: "raid" });
    openMenu(sc);
    const thumbs = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "cc_front" && o.scene !== null,
    );
    const cardsRight = (thumbs[2]?.x ?? 0) + (thumbs[2]?.displayWidth ?? 0);
    const texts = menuTexts(sc);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t.x).toBeGreaterThanOrEqual(cardsRight);

    // 一列裡的三行字都落在那一列的高度內（卡高 ＋ 一點點）
    const rowH = 46;
    const firstRow = texts.filter((t) => Math.abs(t.y - (thumbs[0]?.y ?? 0)) < rowH / 2);
    expect(firstRow).toHaveLength(3); // 名字、標籤、COST
  });

  /** 選單裡那一行 COST 字。沒有就是 undefined。 */
  const costLine = (sc: FakeScene) =>
    menuTexts(sc).find((t) => /^(Official|Custom) /.test(String(t.text)))?.text;

  it("官方那一房畫「官方 N」", () => {
    // 15/13/20 → 卡 48、13↔20 差 7 罰 5、武器 3、事件卡 2 = 58（官方對照例）
    const { sc } = fakeEditScene();
    run(
      { Edit: sc },
      { ...STATE, costDisplay: "official" },
      { cost: costPatch({ cc001_01: 20, cc002_01: 13, cc003_01: 20 }) },
    );
    openMenu(sc);
    expect(costLine(sc)).toBe("Official 58");
  });

  it("自訂那一房畫「自訂 N」—— 價格查規則、壓 C 用官方兩段", () => {
    const { sc } = fakeEditScene();
    run(
      { Edit: sc },
      { ...STATE, costDisplay: "custom" },
      { cost: costPatch({ cc001_01: 20, cc002_01: 13, cc003_01: 20 }) },
    );
    openMenu(sc);
    // 自訂 20/13/20 → 卡 53、兩對差 7 各罰 5、武器 3、事件卡 2 = 68
    expect(costLine(sc)).toBe("Custom 68");
  });

  it("自訂的壓 C 區間會算進自訂那個數字", () => {
    const { sc } = fakeEditScene();
    run(
      { Edit: sc },
      { ...STATE, costDisplay: "custom", penaltyBands: [{ minGap: 5, extraCost: 1 }] },
      { cost: costPatch({ cc001_01: 20, cc002_01: 13, cc003_01: 20 }) },
    );
    openMenu(sc);
    // 20/13/20：兩對差 7 各罰 1 → 53 + 3 + 2 + 2 = 60
    expect(costLine(sc)).toBe("Custom 60");
  });

  it("⚠ 自訂那一房但沒選規則 → 退回官方，而且標籤照實寫「官方」", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc }, { ...STATE, costDisplay: "custom" });
    openMenu(sc);
    expect(costLine(sc)).toBe("Official 58");
  });

  it("PVE 房（任務／渦）不畫 COST —— 那裡沒有 COST 上限", () => {
    const { sc } = fakeEditScene();
    run(
      { Edit: sc },
      { ...STATE, room: "raid", costDisplay: "none" },
      { cost: costPatch({ cc001_01: 20, cc002_01: 13, cc003_01: 20 }) },
    );
    openMenu(sc);
    expect(costLine(sc)).toBeUndefined();
    // 沒有那一行之後，一列只剩名字＋標籤兩行
    const thumbs = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "cc_front" && o.scene !== null,
    );
    const firstRow = menuTexts(sc).filter((t) => Math.abs(t.y - (thumbs[0]?.y ?? 0)) < 23);
    expect(firstRow).toHaveLength(2);
  });

  it("省略 costDisplay 的舊呼叫端當成官方", () => {
    const { sc } = fakeEditScene();
    const { costDisplay: _drop, ...legacy } = STATE;
    run({ Edit: sc }, legacy as DeckEditState);
    openMenu(sc);
    expect(costLine(sc)).toBe("Official 58");
  });

  it("⚠ 自訂價是小數時不要拖著一串零", () => {
    const { sc } = fakeEditScene();
    run(
      { Edit: sc },
      { ...STATE, costDisplay: "custom" },
      { cost: costPatch({ cc001_01: 15.1, cc002_01: 13, cc003_01: 20 }) },
    );
    openMenu(sc);
    // 15.1+13+20+3+2+5 = 58.1，浮點相加會給 58.10000000000001
    expect(costLine(sc)).toBe("Custom 58.1");
  });

  it("渦房才有標籤那一行，點它開勾選面板", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc }, { ...STATE, room: "raid" });
    openMenu(sc);
    const tag = menuTexts(sc).find((t) => String(t.text).indexOf("Tag") === 0);
    expect(tag?.text).toBe("Tag —");
    const before = (sc.children as { list: FakeObject[] }).list.length;
    tag?.fire("pointerdown");
    expect((sc.children as { list: FakeObject[] }).list.length).toBeGreaterThan(before);
  });

  it("非渦房沒有標籤那一行", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    openMenu(sc);
    expect(menuTexts(sc).some((t) => String(t.text).indexOf("Tag") === 0)).toBe(false);
  });

  it("⚠ 牌組多到擺不下就把每一列縮小，一副都不能少畫", () => {
    const many: DeckEditState = {
      ...STATE,
      decks: Array.from({ length: 20 }, (_, i) => ({
        id: "d" + i,
        name: "第 " + i + " 副",
        bosses: [],
        content: contentOf(0, 1, 2),
      })),
      activeId: "d0",
    };
    const { sc } = fakeEditScene();
    run({ Edit: sc }, many);
    openMenu(sc);
    const thumbs = (sc.children as { list: FakeObject[] }).list.filter(
      (o) => o.texture?.key === "cc_front" && o.scene !== null,
    );
    expect(thumbs).toHaveLength(60); // 20 副 × 3 張，沒有少畫
    // 面板上緣不能頂出畫面
    const rows = thumbs.filter((_, i) => i % 3 === 0);
    expect(Math.min(...rows.map((r) => r.y))).toBeGreaterThan(8);
  });

  it("點一列還是選那一副，拖著整列一起動", () => {
    const { sc } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    openMenu(sc);
    const hit = (sc.children as { list: FakeObject[] }).list.find(
      (o) => o.type === "Zone" && o.depth === 1502,
    );
    hit?.fire("pointerdown", { y: 0 });
    hit?.fire("pointerup", { y: 0 });
    expect(reports.map((r) => r.type)).toContain("deck-select");
    expect(reports.find((r) => r.type === "deck-select")?.id).toBe("d1");
  });
});

describe("就地改名（點左下那行 Deck1）", () => {
  it("點下去變成透明無框的輸入框，字型照抄原版那行字", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const box = FakeInputText.last;
    expect(box?.destroyed).toBe(false);
    expect(box?.text).toBe("壓 C 用"); // 套用中那一副
    expect(box?.config["backgroundColor"]).toBe("transparent");
    expect(box?.config["border"]).toBe(0);
    expect(box?.config["fontFamily"]).toBe("font_heavy");
    expect(box?.config["fontSize"]).toBe("20px");
    expect(box?.config["fontStyle"]).toBe("italic");
    // 擺在原版那行字的位置上，而那行字要藏起來 —— 不然兩份疊在一起
    expect(box?.x).toBe(5);
    expect(box?.y).toBe(450);
    expect(sc.deck1_name.visible).toBe(false);
    expect(box?.focused).toBe(true);
  });

  it("Enter 送出 deck-rename，那行字回來", () => {
    const { sc } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const box = FakeInputText.last;
    if (box) box.text = "新名字";
    box?.fire("keydown", box, { key: "Enter" });
    expect(reports).toContainEqual({ type: "deck-rename", id: "d1", name: "新名字" });
    expect(sc.deck1_name.visible).toBe(true);
    expect(box?.destroyed).toBe(true);
  });

  it("Esc 放棄、點到別處（blur）收下", () => {
    const { sc } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const esc = FakeInputText.last;
    if (esc) esc.text = "不要這個";
    esc?.fire("keydown", esc, { key: "Escape" });
    expect(reports.some((r) => r.type === "deck-rename")).toBe(false);

    sc.deck1_name.fire("pointerdown");
    const blur = FakeInputText.last;
    if (blur) blur.text = "這個要";
    blur?.fire("blur");
    expect(reports).toContainEqual({ type: "deck-rename", id: "d1", name: "這個要" });
  });

  it("空白與沒改不送 —— 送過去會變成一副沒名字的牌", () => {
    const { sc } = fakeEditScene();
    const { reports } = run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const box = FakeInputText.last;
    if (box) box.text = "   ";
    box?.fire("keydown", box, { key: "Enter" });
    expect(reports.some((r) => r.type === "deck-rename")).toBe(false);

    sc.deck1_name.fire("pointerdown");
    const same = FakeInputText.last;
    same?.fire("keydown", same, { key: "Enter" });
    expect(reports.some((r) => r.type === "deck-rename")).toBe(false);
  });

  it("⚠ 沒有套用中的那一副就不開輸入框 —— 打完了沒有地方存", () => {
    const { sc } = fakeEditScene();
    FakeInputText.last = null;
    run({ Edit: sc }, { ...STATE, activeId: null });
    sc.deck1_name.fire("pointerdown");
    expect(FakeInputText.last).toBeNull();
  });

  it("開著的輸入框連點兩次不會疊出兩個", () => {
    const { sc } = fakeEditScene();
    run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const first = FakeInputText.last;
    sc.deck1_name.fire("pointerdown");
    expect(FakeInputText.last).toBe(first);
  });

  it("⚠ 卸載時輸入框要收掉、那行字要放回來", () => {
    const { sc } = fakeEditScene();
    const { window: win } = run({ Edit: sc });
    sc.deck1_name.fire("pointerdown");
    const box = FakeInputText.last;
    (win["__ulrDeckEdit"] as { uninstall: () => void }).uninstall();
    expect(box?.destroyed).toBe(true);
    expect(sc.deck1_name.visible).toBe(true);
    // 那行字上的 handler 也要收回來，否則重掛一次就多一個
    expect(sc.deck1_name.handlers["pointerdown"] ?? []).toHaveLength(0);
  });

  it("房裡不給點 —— 那一排右邊就是「輸入Raid代碼」", () => {
    const raid = fakeScene({ icon: false });
    run({ Raid: raid });
    expect(raid.deck_name.handlers["pointerdown"] ?? []).toHaveLength(0);
  });
});
