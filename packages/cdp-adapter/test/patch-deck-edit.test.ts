import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DECK_EDIT_SCRIPT_VERSION,
  buildDeckEditPatchScript,
  buildDeckEditStateExpression,
  isDeckEditReport,
  parseDeckEditStatus,
} from "../src/patch-deck-edit.js";
import type { DeckEditState } from "../src/patch-deck-edit.js";

const STATE: DeckEditState = {
  room: "dietherm",
  // 規格 §4 的四種房，順序照 ROOM_KINDS
  rooms: [
    { key: "raid", label: "渦" },
    { key: "alexandria", label: "亞歷山卓城" },
    { key: "quest", label: "任務" },
    { key: "dietherm", label: "迪特赫姆" },
  ],
  decks: [
    { id: "d1", name: "壓 C 用", bosses: [] },
    { id: "d2", name: "打人用", bosses: [] },
  ],
  activeId: "d1",
  bossOptions: [
    { key: "sea", label: "海" },
    { key: "fish", label: "魚" },
  ],
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

  it("房裡不畫「房間」切換鈕與 +／-", () => {
    // 兩個理由：(444,510) 在任務房是地圖正中央；而且站在任務房裡把它切成迪城，
    // 房裡的 ◀▶ 就會切迪城的牌組，按 START 打的卻是任務 —— 拿錯牌組上場。
    const src = script();
    expect(src).toContain("if (!isRoom)");
  });

  it("deck-cycle 會帶 from，區分是房裡還是選單那組箭頭", () => {
    expect(script()).toContain('isRoom ? "room" : "menu"');
  });

  it("⚠ 重掛的判斷要看 GameObject 還在不在，不能只比場景物件", () => {
    // Phaser 的 game.scene.keys.Quest 是長命的 Scene 實例：玩家離開再進來
    // 只是重跑 create()，場景沒換但底下的 GameObject 全是新的。只比場景的話
    // 第二次進房不會重掛，箭頭就變回遊戲原本的行為。
    const src = script();
    expect(src).toContain("mounted.objects[0].scene");
    expect(src).toContain("mounted.icon.scene");
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
    // 房間鈕是照 state.rooms 循環的
    expect(src).toContain("state.rooms.map");
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

  it("牌組內容不會下放到頁面 —— 頁面只拿得到 id/名字/標籤", () => {
    const src = script();
    expect(src).not.toContain("charaIndex");
    expect(src).not.toContain("eventIndex");
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
    input: null as unknown,
    scene: null as unknown,
    handlers: {} as Record<string, ((...args: unknown[]) => void)[]>,
    setOrigin: () => o,
    setDepth: (d: number) => ((o.depth = d), o),
    setResolution: () => o,
    setScale: () => o,
    setVisible: () => o,
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
      text: (x: number, y: number, t: string) => add(fakeObject("Text", x, y, null, t)),
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
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: win,
  };
  return new Script(buildDeckEditPatchScript({ bindingName: "__test", state })).runInContext(
    createContext(context),
  );
}

/** 把腳本丟進 vm 跑，回傳掛載結果與玩家操作回報。 */
function run(scenes: Record<string, FakeScene>, state: DeckEditState = STATE): RunResult {
  const reports: { type: string; [key: string]: unknown }[] = [];
  const win: Record<string, unknown> = {
    game: { scene: { keys: scenes } },
    __test: (json: string) => reports.push(JSON.parse(json)),
  };
  const result = exec(win, state);
  return { result, reports, api: win["__ulrDeckEdit"] as RunResult["api"], window: win };
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

  it("渦房才有的標籤鈕在選單裡", () => {
    const raid = fakeScene({ icon: false });
    run({ Raid: raid }, RAID_STATE);
    iconsOf(raid)[0]?.fire("pointerdown");
    expect(raid.children.list.some((o) => o.text === "標籤")).toBe(true);
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
      decks: [{ id: "zzz", name: "完全不一樣的一副", bosses: ["sea", "fish"] }],
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
