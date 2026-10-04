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
 */

import { describe, expect, it } from "vitest";
import {
  buildRaidSurrenderPatchScript,
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
  off(name?: string): this {
    if (name === undefined) this.handlers.clear();
    else this.handlers.delete(name);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
}

/** 官方的選單按鈕類別：Container，圖示 MenuIcons / name_out，按完 emit("click")。 */
class FakeMenuButton extends FakeEmitter {
  scene: FakeScene | null;
  constructor(
    scene: FakeScene,
    public x: number,
    public y: number,
    public icon: string,
  ) {
    super();
    this.scene = scene;
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
    const b = new FakeMenuButton(this, 734, 98, "menu");
    b.on("click", () => {
      this.menu_buttons = [];
      this.menu_buttons.push(new FakeMenuButton(this, 0, 0, "help"));
      if (pvp) {
        const s = new FakeMenuButton(this, 0, 0, "surrender");
        s.on("click", () => void this.confirms++);
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

interface FakeWindow {
  game: FakeGame;
  [key: string]: unknown;
}

function makeWindow(): { window: FakeWindow; reports: unknown[] } {
  const reports: unknown[] = [];
  const window: FakeWindow = {
    game: new FakeGame(),
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
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

function install(window: FakeWindow): string {
  poll = null;
  return run(window, buildRaidSurrenderPatchScript({ bindingName: BINDING }));
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
      reason: null,
    });
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
      reason: null,
    });
  });
});
