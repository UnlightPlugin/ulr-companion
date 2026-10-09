/**
 * 渦戰裡的投降鈕
 *
 * 跟 `patch-nav` 同一套：搭一個夠像的假遊戲，把 `buildRaidSurrenderPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-23 改版後從跑著的客戶端讀的形狀寫：
 *
 * ```js
 *   MainA.menu_button.on("click", () => {
 *     e.menu_buttons = []
 *     e.menu_buttons.push(help)
 *     Ll.check(rule) && e.menu_buttons.push(surrender)   // 只有 PVP
 *     e.menu_list = new 清單(e, x, y, e.menu_buttons)
 *   })
 *   按鈕類別 new I(scene, 0, 0, name)：圖示 MenuIcons / name + "_out"，按完 emit("click")
 *   MainA.game_result：socket.off(); socket.emit("leaveRoom", room_id); socket.disconnect()
 *   戰鬥期間：MainA RUNNING、BackA/AttackPhaseA… RUNNING、Raid SLEEPING、Session 常駐
 *   Raid.init() 不收參數
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 只有渦戰的選單多一顆 surrender，排在 help 後面；PVP／任務戰照原樣
 * 2. 按下去：不開確認框 → 照 game_result 收戰鬥連線 → 清場（連 sleeping 的 Raid）
 *    → start("Raid")；常駐場景（含 Session）一個都不碰
 * 3. 連按只走一次；打完的那一場（is_complete）不走
 * 4. 圖示不在就不加鈕（不會畫出一顆破圖）
 * 5. 拆掉後 menu_buttons 還原成普通屬性，選單回到官方那樣
 * 6. 對人戰（2026-10-05）：迪城 duel 才不確認（亞城、channel 留著迪城的渦戰照舊）；
 *    鈕放外面時 MENU 不列、MENU 正下方一顆 —— 渦是我們那顆、對人戰走官方確認流程；
 *    找不到官方確認那支就不畫、MENU 照官方；開關當場生效、拆掉不留
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRaidSurrenderPatchScript,
  buildRaidSurrenderSetOptionsExpression,
  isRaidSurrenderReport,
  JUMP_PERSISTENT_SCENES,
  parseRaidSurrenderStatus,
  RAID_SURRENDER_SCRIPT_VERSION,
  RAID_SURRENDER_STATUS_EXPRESSION,
  RAID_SURRENDER_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

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
  once(name: string, fn: Handler): this {
    const wrap: Handler = (...args) => {
      this.off(name, wrap);
      fn(...args);
    };
    (wrap as { inner?: Handler }).inner = fn;
    return this.on(name, wrap);
  }
  off(name?: string, fn?: Handler): this {
    if (name === undefined) this.handlers.clear();
    else if (fn === undefined) this.handlers.delete(name);
    else {
      const list = (this.handlers.get(name) ?? []).filter(
        (h) => h !== fn && (h as { inner?: Handler }).inner !== fn,
      );
      this.handlers.set(name, list);
    }
    return this;
  }
  count(name: string): number {
    return this.handlers.get(name)?.length ?? 0;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
}

/** 官方的選單按鈕類別：Container，圖示 MenuIcons / name_out，按完 emit("click")。 */
class FakeMenuButton extends FakeEmitter {
  scene: FakeScene | null;
  depth = 0;
  /** 照實機：button_icon 是 MenuIcons 的 Image，frame.name = name_out。 */
  button_icon: { frame: { name: string } };
  constructor(
    scene: FakeScene,
    public x: number,
    public y: number,
    public icon: string,
  ) {
    super();
    this.scene = scene;
    this.button_icon = { frame: { name: `${icon}_out` } };
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  destroy(): void {
    this.scene = null;
  }
}

class FakeMenuList {
  removed = 0;
  constructor(public buttons: FakeMenuButton[]) {}
  menu_remove(): void {
    this.removed++;
  }
}

class FakeSocket extends FakeEmitter {
  log: unknown[][] = [];
  override emit(name: string, ...args: unknown[]): void {
    this.log.push(["emit", name, ...args]);
  }
  override off(name?: string): this {
    if (name === undefined) this.log.push(["off"]);
    return super.off(name);
  }
  disconnect(): void {
    this.log.push(["disconnect"]);
  }
}

const ICONS = new Set(["menu_out", "help_out", "surrender_out", "friend_out", "stamp_out"]);

class FakeScene {
  events = new FakeEmitter();
  bgm = { stopped: false, stop: () => void (this.bgm.stopped = true) };
  sys: { settings: { key: string; status: number } };
  scene: { isActive: () => boolean };
  textures = {
    get: (key: string) => ({ has: (f: string) => key === "MenuIcons" && ICONS.has(f) }),
  };
  ulse01 = { played: 0, play: () => void this.ulse01.played++ };
  // 照 MainA 的類別欄位：實例自己的資料屬性。
  menu_buttons: FakeMenuButton[] = [];
  menu_list: FakeMenuList | null = null;
  menu_button: FakeMenuButton | null = null;
  room_config: { rule: string } | null = null;
  room_id: string | null = null;
  is_complete = false;
  socket: FakeSocket | null = null;
  /** 官方 surrender 開的確認框次數。 */
  confirms = 0;
  /** Match 場景的頻道物件（迪城：quick／event 都 false）。 */
  channel: Record<string, unknown> | null = null;

  constructor(key: string) {
    this.sys = { settings: { key, status: 8 } };
    this.scene = { isActive: () => this.sys.settings.status === 5 };
  }

  /** 官方 MainA.create() 的選單那一段（PVP 才有 surrender）。 */
  enterBattle(rule: string, room = "room-32chars"): void {
    this.sys.settings.status = 5;
    this.room_config = { rule };
    this.room_id = room;
    this.is_complete = false;
    this.socket = new FakeSocket();
    const pvp = rule === "duel" || rule === "ranked";
    const b = new FakeMenuButton(this, 734, 98, "menu").setDepth(50);
    b.on("click", () => {
      this.menu_buttons = [];
      this.menu_buttons.push(new FakeMenuButton(this, 0, 0, "help"));
      if (pvp) {
        const s = new FakeMenuButton(this, 0, 0, "surrender");
        s.on("click", () => {
          this.ulse01.play();
          this.menu_list!.menu_remove();
          void officialConfirm(this);
        });
        this.menu_buttons.push(s);
        this.menu_buttons.push(new FakeMenuButton(this, 0, 0, "friend"));
      }
      this.menu_list = new FakeMenuList(this.menu_buttons);
    });
    this.menu_button = b;
  }

  leave(): void {
    this.sys.settings.status = 8;
    this.events.emit("shutdown");
  }

  /** 玩家按選單鈕，回傳這次畫出來的按鈕圖示順序。 */
  openMenu(): string[] {
    this.menu_button!.emit("click");
    return this.menu_list!.buttons.map((b) => b.icon);
  }

  menuItem(icon: string): FakeMenuButton {
    const b = this.menu_list?.buttons.find((x) => x.icon === icon);
    if (!b) throw new Error(`選單裡沒有 ${icon}`);
    return b;
  }

  /** 官方 MainA 的原型方法："win" 以外畫「你投降了」框、等玩家按 ok。 */
  surrenderDialogs: string[] = [];
  show_surrender_result(result: string): Promise<void> {
    this.surrenderDialogs.push(result === "win" ? "opponent_surrender" : "player_surrender");
    return Promise.resolve();
  }

  /** 官方 MainA.game_result 投降那一段：等框關掉才 start Result。 */
  async gameResult(G: FakeGame, code: "surrender" | "normal", result: string): Promise<void> {
    this.is_complete = true;
    if (code === "surrender") await this.show_surrender_result(result);
    G.at("Result").startResult();
  }

  // Phaser 的時鐘、補間、鏡頭（快轉與藏鏡頭用）
  time = { timeScale: 1 };
  tweens = { timeScale: 1 };
  cameras = {
    main: {
      alpha: 1,
      setAlpha(a: number) {
        this.alpha = a;
      },
    },
  };

  // ---- Result 場景 ----
  result_ok: FakeMenuButton | null = null;
  /** 結算 OK 被按（pointerup）的次數。 */
  resultOkPressed = 0;
  /** 官方 Result：start → create（建 OK）→ OK 淡入完 emit result_ok_shown。 */
  startResult(): void {
    this.events.emit("start");
    this.sys.settings.status = 5;
    const ok = new FakeMenuButton(this, 667, 621, "result_ok");
    ok.on("pointerup", () => void this.resultOkPressed++);
    this.result_ok = ok;
    this.events.emit("create");
  }
  showResultOk(): void {
    this.events.emit("result_ok_shown");
  }
}

class FakeGame {
  scene: {
    keys: Record<string, FakeScene>;
    scenes: FakeScene[];
    stop: (k: string) => void;
    start: (k: string, data?: unknown) => void;
  };
  stopped: string[] = [];
  started: { key: string; data: unknown }[] = [];

  at(key: string): FakeScene {
    const sc = this.scene.keys[key];
    if (!sc) throw new Error(`沒有 ${key} 場景`);
    return sc;
  }

  constructor() {
    const keys: Record<string, FakeScene> = {};
    for (const k of [
      "Lobby",
      "Match",
      "Raid",
      "Raid_MatchBoot",
      "MainA",
      "BackA",
      "AttackPhaseA",
      "Session",
      "Friend",
      "Loader",
      "MainAAssets",
      "Bug",
      "Result",
      "Bonus",
    ]) {
      keys[k] = new FakeScene(k);
    }
    for (const k of ["Session", "Loader", "MainAAssets", "Bug"]) keys[k]!.sys.settings.status = 5;
    this.scene = {
      keys,
      scenes: Object.values(keys),
      stop: (k) => {
        this.stopped.push(k);
        keys[k]?.leave();
      },
      start: (k, data) => this.started.push({ key: k, data }),
    };
  }

  /** 開一場渦戰：MainA 跟子場景 RUNNING、渦房 SLEEPING（照實機的樣子）。 */
  raidBattle(): FakeScene {
    const m = this.at("MainA");
    m.enterBattle("raid");
    for (const k of ["BackA", "AttackPhaseA"]) this.at(k).sys.settings.status = 5;
    this.at("Raid").sys.settings.status = 7;
    return m;
  }
}

/** 官方確認框按 ok 了沒（確認那支照這個決定送不送）。 */
let CONFIRM_OK = false;
beforeEach(() => {
  CONFIRM_OK = false;
});

/**
 * 官方的投降確認流程（2026-10-05 實機讀的模組 3480 的 XF：確認框 → ok 才 emit）。
 * 插件靠函式原始碼裡的 surrender_confirm ＋ emit("surrender" 認它，這兩段字要留著。
 */
async function officialConfirm(e: FakeScene) {
  const text = "surrender_confirm";
  e.confirms += text.length > 0 ? 1 : 0;
  if (CONFIRM_OK) e.socket!.emit("surrender", e.room_id);
}

/** webpack 的 chunk 陣列：push 一個 entry 會把 require 交給它的第三個元素。 */
function webpackChunks(): unknown[] {
  const req = Object.assign((id: string) => (id === "3480" ? { XF: officialConfirm } : {}), {
    m: {
      "1": function other() {
        return "nothing";
      },
      "3480": function battleDialogModule() {
        return 'surrender_confirm socket.emit("surrender", room_id)';
      },
    },
  });
  const chunks: unknown[] = [];
  chunks.push = (entry: unknown) => {
    (entry as [unknown, unknown, (r: unknown) => void])[2](req);
    return 0;
  };
  return chunks;
}

interface FakeWindow {
  game: FakeGame;
  [key: string]: unknown;
}

function makeWindow(withWebpack = true): { window: FakeWindow; reports: unknown[] } {
  const reports: unknown[] = [];
  const window: FakeWindow = {
    game: new FakeGame(),
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  if (withWebpack) window["webpackChunkunlight"] = webpackChunks();
  return { window, reports };
}

let poll: (() => void) | null = null;

function run(window: FakeWindow, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    ...args: unknown[]
  ) => string;
  return fn(
    window,
    (cb: () => void) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
  );
}

function install(window: FakeWindow, surrender = { dietNoConfirm: false, outside: false }): string {
  poll = null;
  return run(window, buildRaidSurrenderPatchScript({ bindingName: BINDING, surrender }));
}

function tick(): void {
  poll?.();
}

function status(window: FakeWindow) {
  return parseRaidSurrenderStatus(run(window, RAID_SURRENDER_STATUS_EXPRESSION));
}

// ---------------------------------------------------------------------------
// 測試
// ---------------------------------------------------------------------------

describe("buildRaidSurrenderPatchScript", () => {
  it("組態是解析過的值，不是字串（embedJson 的坑）；沒有反引號", () => {
    const src = buildRaidSurrenderPatchScript({ bindingName: BINDING });
    expect(src).toMatch(/var CFG = JSON\.parse\(/);
    expect(src).not.toContain("`");
  });

  it("渦戰的選單：help 後面多一顆 surrender，用官方的按鈕類別", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    expect(m.openMenu()).toEqual(["help"]);
    install(window);

    expect(m.openMenu()).toEqual(["help", "surrender"]);
    expect(m.menuItem("surrender")).toBeInstanceOf(FakeMenuButton);
    expect(status(window)).toEqual({
      installed: true,
      version: RAID_SURRENDER_SCRIPT_VERSION,
      mounted: true,
      dietNoConfirm: false,
      outside: false,
      outsideShown: false,
      reason: null,
    });
    // 再開一次選單還是只有一顆。
    expect(m.openMenu()).toEqual(["help", "surrender"]);
  });

  it("PVP 與任務戰的選單照原樣 —— 不重複、不多加", () => {
    const { window } = makeWindow();
    const m = window.game.at("MainA");
    install(window);
    m.enterBattle("duel");
    tick();
    expect(m.openMenu()).toEqual(["help", "surrender", "friend"]);
    m.menuItem("surrender").emit("click");
    expect(m.confirms).toBe(1);
    expect(window.game.started).toEqual([]);

    m.enterBattle("quest");
    expect(m.openMenu()).toEqual(["help"]);
    expect(status(window).mounted).toBe(false);
  });

  it("插件比戰鬥先裝：MainA 之後才進渦戰也掛得上", () => {
    const { window } = makeWindow();
    install(window);
    const m = window.game.raidBattle();
    tick();
    expect(m.openMenu()).toEqual(["help", "surrender"]);
  });

  it("按下去：不開確認框 → 照 game_result 收連線 → 清場（連 sleeping 的渦房）→ start Raid", () => {
    const { window, reports } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);
    const battle = m.socket!;

    m.openMenu();
    const list = m.menu_list!;
    m.menuItem("surrender").emit("click");

    expect(m.confirms).toBe(0);
    expect(m.ulse01.played).toBe(1);
    expect(list.removed).toBe(1);
    expect(m.is_complete).toBe(true);
    expect(battle.log).toEqual([["off"], ["emit", "leaveRoom", "room-32chars"], ["disconnect"]]);
    // 清場：MainA、子場景、sleeping 的 Raid 全收；常駐（含 Session）一個都不碰。
    expect([...G.stopped].sort()).toEqual(["AttackPhaseA", "BackA", "MainA", "Raid"]);
    expect(m.bgm.stopped).toBe(true);
    for (const k of ["Session", "Loader", "MainAAssets", "Bug"]) {
      expect(G.at(k).sys.settings.status).toBe(5);
    }
    // 改版後 Raid.init() 不收參數。
    expect(G.started).toEqual([{ key: "Raid", data: undefined }]);
    expect(reports.filter(isRaidSurrenderReport)).toEqual([
      { type: "raid-surrender", ok: true, reason: null, stopped: expect.any(Array) },
    ]);
    expect(status(window).mounted).toBe(false);
  });

  it("Session 在常駐名單裡（它管斷線重連）", () => {
    expect(JUMP_PERSISTENT_SCENES).toContain("Session");
  });

  it("連按只走一次；已經結束的那一場不走", () => {
    const { window, reports } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);
    m.openMenu();
    const b = m.menuItem("surrender");
    b.emit("click");
    b.emit("click");
    expect(G.started).toHaveLength(1);
    expect(reports.filter(isRaidSurrenderReport).at(-1)).toMatchObject({
      ok: false,
      reason: "這一場已經結束了",
    });
  });

  it("MenuIcons 沒有 surrender 圖示就不加鈕，原因寫進狀態", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    m.textures = { get: () => ({ has: () => false }) };
    install(window);
    expect(m.openMenu()).toEqual(["help"]);
    expect(status(window).reason).toContain("surrender_out");
  });

  it("拆掉：menu_buttons 還原成普通屬性，選單回到官方那樣；重裝不留孤兒", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    install(window);
    install(window);
    expect(m.openMenu()).toEqual(["help", "surrender"]);

    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(poll).toBeNull();
    const desc = Object.getOwnPropertyDescriptor(m, "menu_buttons");
    expect(desc?.writable).toBe(true);
    expect(desc?.get).toBeUndefined();
    expect(m.openMenu()).toEqual(["help"]);
    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("not-installed");
    expect(status(window)).toEqual({
      installed: false,
      version: null,
      mounted: false,
      dietNoConfirm: false,
      outside: false,
      outsideShown: false,
      reason: null,
    });
  });
});

describe("對人戰的投降與鈕放外面", () => {
  const DIET = { channel: 2, quick: false, event: false };
  const ALEX = { channel: 1, quick: true, event: false };

  function duel(window: FakeWindow, channel: Record<string, unknown>, rule = "duel"): FakeScene {
    window.game.at("Match").channel = channel;
    const m = window.game.at("MainA");
    m.enterBattle(rule);
    tick();
    return m;
  }
  const outside = (window: FakeWindow) =>
    (window["__ulrRaidSurrender"] as { out: FakeMenuButton | null }).out;
  const emits = (m: FakeScene) => m.socket!.log.filter((l) => l[0] === "emit");

  it("迪城 duel＋不確認：MENU 裡的投降按下去直接送那一個，不跳確認框", () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const m = duel(window, DIET);
    expect(m.openMenu()).toEqual(["help", "surrender", "friend"]);
    const list = m.menu_list!;
    m.menuItem("surrender").emit("click");
    expect(m.confirms).toBe(0);
    expect(emits(m)).toEqual([["emit", "surrender", "room-32chars"]]);
    expect(list.removed).toBe(1);
    expect(window.game.started).toEqual([]);
  });

  it("⚠ 不確認只在迪城的 duel：亞城、迪城的 ranked 照官方跳確認", () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const alex = duel(window, ALEX);
    alex.openMenu();
    alex.menuItem("surrender").emit("click");
    expect(alex.confirms).toBe(1);
    expect(emits(alex)).toEqual([]);

    const ranked = duel(window, DIET, "ranked");
    ranked.openMenu();
    ranked.menuItem("surrender").emit("click");
    expect(ranked.confirms).toBe(2);
    expect(emits(ranked)).toEqual([]);
  });

  it("⚠ channel 還留著迪城的渦戰：還是我們那顆、直接回渦房，不送 surrender", () => {
    const { window } = makeWindow();
    window.game.at("Match").channel = DIET;
    const m = window.game.raidBattle();
    const battle = m.socket!;
    install(window, { dietNoConfirm: true, outside: false });
    expect(m.openMenu()).toEqual(["help", "surrender"]);
    m.menuItem("surrender").emit("click");
    expect(battle.log.filter((l) => l[0] === "emit")).toEqual([
      ["emit", "leaveRoom", "room-32chars"],
    ]);
    expect(window.game.started).toEqual([{ key: "Raid", data: undefined }]);
  });

  it("渦＋鈕放外面：MENU 只剩 help，MENU 正下方一顆；按下去直接回渦房", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    install(window, { dietNoConfirm: false, outside: true });
    const b = outside(window)!;
    expect([b.icon, b.x, b.y, b.depth]).toEqual(["surrender", 734, 132, 50]);
    expect(status(window)).toMatchObject({ outside: true, outsideShown: true, mounted: true });
    expect(m.openMenu()).toEqual(["help"]);
    b.emit("click");
    expect(m.confirms).toBe(0);
    expect(window.game.started).toEqual([{ key: "Raid", data: undefined }]);
    // 走了（is_complete）下一輪就收
    tick();
    expect(b.scene).toBeNull();
    expect(outside(window)).toBeNull();
  });

  it("亞城＋鈕放外面：MENU 不列投降（不留空格）；外面那顆走官方確認流程", () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: false, outside: true });
    const m = duel(window, ALEX);
    const b = outside(window)!;
    expect([b.x, b.y]).toEqual([734, 132]);
    expect(m.openMenu()).toEqual(["help", "friend"]);
    b.emit("click");
    expect(m.confirms).toBe(1);
    // 送出是官方確認框按 ok 之後的事
    expect(emits(m)).toEqual([]);
  });

  it("迪城＋鈕放外面＋不確認：外面那顆直接送", () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: true });
    const m = duel(window, DIET);
    outside(window)!.emit("click");
    expect(m.confirms).toBe(0);
    expect(emits(m)).toEqual([["emit", "surrender", "room-32chars"]]);
  });

  it("找不到官方確認那支：對人戰不畫外面那顆、MENU 照官方；渦照畫", () => {
    const { window } = makeWindow(false);
    install(window, { dietNoConfirm: false, outside: true });
    const m = duel(window, ALEX);
    expect(outside(window)).toBeNull();
    expect(m.openMenu()).toEqual(["help", "surrender", "friend"]);

    window.game.raidBattle();
    tick();
    expect(outside(window)!.icon).toBe("surrender");
  });

  it("任務戰（官方沒投降）不畫外面那顆", () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: true });
    const m = duel(window, DIET, "quest");
    expect(outside(window)).toBeNull();
    expect(m.openMenu()).toEqual(["help"]);
  });

  it("開關當場生效；拆掉不留外面那顆；下一場（新的 MENU 鈕）重掛", () => {
    const { window } = makeWindow();
    install(window);
    const m = duel(window, ALEX);
    expect(outside(window)).toBeNull();
    const set = (outsideOn: boolean) =>
      run(
        window,
        buildRaidSurrenderSetOptionsExpression({ dietNoConfirm: false, outside: outsideOn }),
      );
    expect(set(true)).toBe("ok");
    const first = outside(window)!;
    expect(first.scene).toBe(m);
    expect(m.openMenu()).toEqual(["help", "friend"]);
    expect(set(false)).toBe("ok");
    expect(first.scene).toBeNull();
    expect(m.openMenu()).toEqual(["help", "surrender", "friend"]);

    set(true);
    const second = outside(window)!;
    m.enterBattle("duel");
    tick();
    const third = outside(window)!;
    expect(third).not.toBe(second);
    expect(second.scene).toBeNull();

    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(third.scene).toBeNull();
  });

  it("不確認送出之後直接到獎勵遊戲：不跳「你投降了」、收尾快轉、結算藏起來 OK 自動按", async () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const G = window.game;
    const m = duel(window, DIET);
    const R = G.at("Result");
    const B = G.at("Bonus");
    m.openMenu();
    m.menuItem("surrender").emit("click");

    // game_result：框直接過、MainA 收尾快轉
    m.is_complete = true;
    await m.show_surrender_result("lose");
    expect(m.surrenderDialogs).toEqual([]);
    expect([m.time.timeScale, m.tweens.timeScale]).toEqual([50, 50]);

    // Result：MainA 還原；結算藏鏡頭＋快轉，OK 一出來就按
    R.startResult();
    expect([m.time.timeScale, m.tweens.timeScale]).toEqual([1, 1]);
    expect([R.cameras.main.alpha, R.time.timeScale, R.tweens.timeScale]).toEqual([0, 50, 50]);
    expect(R.resultOkPressed).toBe(0);
    R.showResultOk();
    expect(R.resultOkPressed).toBe(1);

    // 獎勵遊戲疊在 Result 上：一開始就把 Result 還原
    B.events.emit("start");
    expect([R.cameras.main.alpha, R.time.timeScale, R.tweens.timeScale]).toEqual([1, 1, 1]);
    // 獎勵遊戲結束後那顆 OK 照常由玩家按
    R.showResultOk();
    expect(R.resultOkPressed).toBe(1);
    R.leave();
    expect(R.events.count("result_ok_shown")).toBe(0);
    expect(R.events.count("create")).toBe(0);
    expect(B.events.count("start")).toBe(0);
  });

  it("沒有獎勵遊戲：OK 自動按（回大廳），Result 收掉時鏡頭與速度還原", async () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const G = window.game;
    const m = duel(window, DIET);
    const R = G.at("Result");
    m.openMenu();
    m.menuItem("surrender").emit("click");
    await m.gameResult(G, "surrender", "lose");
    R.showResultOk();
    expect(R.resultOkPressed).toBe(1);
    R.leave();
    expect([R.cameras.main.alpha, R.time.timeScale, m.time.timeScale]).toEqual([1, 1, 1]);
    expect(G.at("Bonus").events.count("start")).toBe(0);
  });

  it("⚠ 只跳過自己不確認送出的那一房：對手投降、官方確認框送的、下一場都照官方", async () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const G = window.game;
    const R = G.at("Result");

    // 對手投降（我們沒送）
    const m = duel(window, DIET);
    await m.gameResult(G, "surrender", "win");
    expect(m.surrenderDialogs).toEqual(["opponent_surrender"]);

    // 亞城走官方確認框
    CONFIRM_OK = true;
    const alex = duel(window, ALEX);
    alex.openMenu();
    alex.menuItem("surrender").emit("click");
    await alex.gameResult(G, "surrender", "lose");
    expect(alex.surrenderDialogs).toEqual(["opponent_surrender", "player_surrender"]);

    // 送了，但這一場是別的收尾（沒經過「你投降了」）：結算不自動按
    const third = duel(window, DIET);
    third.openMenu();
    third.menuItem("surrender").emit("click");
    await third.gameResult(G, "normal", "lose");
    R.showResultOk();
    expect(R.resultOkPressed).toBe(0);
    // 下一場（新 room_id）就算以投降收尾也不吃上一場的標記
    third.enterBattle("duel", "another-room");
    await third.gameResult(G, "surrender", "lose");
    expect(third.surrenderDialogs.at(-1)).toBe("player_surrender");
  });

  it("拆掉：show_surrender_result 回到原型、沒觸發的結算鉤子一起收", async () => {
    const { window } = makeWindow();
    install(window, { dietNoConfirm: true, outside: false });
    const G = window.game;
    const m = duel(window, DIET);
    expect(Object.prototype.hasOwnProperty.call(m, "show_surrender_result")).toBe(true);
    m.openMenu();
    m.menuItem("surrender").emit("click");
    await m.gameResult(G, "surrender", "lose");
    expect(G.at("Result").events.count("result_ok_shown")).toBe(1);

    const R = G.at("Result");
    expect(R.cameras.main.alpha).toBe(0);

    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(m, "show_surrender_result")).toBe(false);
    expect(R.events.count("result_ok_shown")).toBe(0);
    expect(R.events.count("shutdown")).toBe(0);
    expect([R.cameras.main.alpha, R.time.timeScale]).toEqual([1, 1]);
  });

  it("沒裝時換開關回 not-installed（引擎會整支補裝）", () => {
    const { window } = makeWindow();
    expect(
      run(window, buildRaidSurrenderSetOptionsExpression({ dietNoConfirm: true, outside: true })),
    ).toBe("not-installed");
  });
});

describe("isRaidSurrenderReport / parseRaidSurrenderStatus", () => {
  it("只認 type=raid-surrender 而且 ok 是布林", () => {
    expect(isRaidSurrenderReport({ type: "raid-surrender", ok: true, reason: null })).toBe(true);
    expect(isRaidSurrenderReport({ type: "raid-surrender", ok: "yes" })).toBe(false);
    expect(isRaidSurrenderReport({ type: "nav", ok: true })).toBe(false);
    expect(isRaidSurrenderReport(null)).toBe(false);
  });

  it("讀不懂的回應當成沒裝", () => {
    const s = parseRaidSurrenderStatus("not json");
    expect(s.installed).toBe(false);
    expect(s.reason).toContain("讀不懂");
    expect(parseRaidSurrenderStatus('{"installed":true,"version":1,"mounted":true}')).toEqual({
      installed: true,
      version: 1,
      mounted: true,
      dietNoConfirm: false,
      outside: false,
      outsideShown: false,
      reason: null,
    });
  });
});
