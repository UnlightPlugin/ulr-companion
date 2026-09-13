/**
 * 渦戰裡的投降鈕
 *
 * 跟 `patch-nav` 同一套：搭一個夠像的假遊戲，把 `buildRaidSurrenderPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-13 從跑著的客戶端讀的形狀寫：
 *
 * ```js
 *   MainA.create()：
 *     btn_surrender = add.image(760,118,"btn_surrender",0).setOrigin(1,0).setInteractive()
 *     pointerover/out 換圖；pointerdown 開確認面板
 *     rule 是 quest/raid/event → btn_surrender.visible = false
 *   MainA.on_result()：socket.off(); socket.emit("leaveRoom", room); socket.disconnect()
 *   MainA 掛了 events.once("shutdown") → socket.disconnect(); socket.off()
 *   戰鬥期間：MainA RUNNING、BackA/Log/AttackPhaseA… RUNNING、Raid SLEEPING
 *   大廳 RAID 鈕：socket.fetch("raid_port") → [host, port]
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 只在 rule === "raid" 而且 MainA active 時掛；掛上去 = 白旗看得見、官方
 *    pointerdown 拆掉、hover 的換圖留著
 * 2. 按下去：先問路 → 照 on_result 收戰鬥連線 → 清場（連 sleeping 的 Raid）→
 *    SceneManager 的 start("Raid", {id, host, port})；常駐場景一個都不碰
 * 3. 問不到路就**什麼都不動**：連線還在、場景還在、白旗彈回來、回報 ok:false
 * 4. 連按只走一次
 * 5. 下一場是新的一顆白旗 → 重掛；拆掉時官方 handler 掛回去、白旗藏回去
 */

import { describe, expect, it } from "vitest";
import {
  buildRaidSurrenderPatchScript,
  isRaidSurrenderReport,
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

/** 照 eventemitter3 的形狀：off(event) 不帶 fn 就是全拆；listeners(event) 給 fn 陣列。 */
class FakeEmitter {
  handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler): this {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  once(name: string, fn: Handler): this {
    const wrapped: Handler = (...args) => {
      this.off(name, wrapped);
      fn(...args);
    };
    return this.on(name, wrapped);
  }
  off(name: string, fn?: Handler): this {
    if (fn === undefined) {
      this.handlers.delete(name);
      return this;
    }
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((h) => h !== fn),
    );
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  listeners(name: string): Handler[] {
    return [...(this.handlers.get(name) ?? [])];
  }
  listenerCount(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

/** Phaser 的物件被 destroy 之後 `scene` 會變 null —— 腳本靠這個認「死了」。 */
class FakeObject extends FakeEmitter {
  scene: FakeScene | null;
  visible = true;
  input: { enabled: boolean } | null = null;
  texture: { key: string } = { key: "" };
  frame: { name: number } = { name: 0 };
  constructor(
    scene: FakeScene,
    public x: number,
    public y: number,
  ) {
    super();
    this.scene = scene;
  }
  destroy(): void {
    this.scene = null;
  }
  setInteractive(): this {
    this.input = { enabled: true };
    return this;
  }
  disableInteractive(): this {
    if (this.input) this.input.enabled = false;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setTexture(key: string, frame?: number): this {
    this.texture = { key };
    this.frame = { name: frame ?? 0 };
    return this;
  }
}

class FakeSocket extends FakeEmitter {
  static made: FakeSocket[] = [];
  /** `fetch(event)` 的回應表。沒有的事件永遠不回。 */
  static answers: Record<string, unknown> = {};
  disconnected = false;
  /** 依序記下對它做的事：emit 的封包、off()、disconnect()。 */
  log: unknown[][] = [];
  constructor(
    public url: string,
    public protocols?: unknown,
  ) {
    super();
    FakeSocket.made.push(this);
  }
  fetch(event: string): Promise<unknown> {
    const a = FakeSocket.answers[event];
    if (a === undefined) return new Promise(() => {});
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a);
  }
  /** 送給伺服器。⚠ 不會觸發本地的 on() —— 那是收到回應才會的事。 */
  override emit(name: string, ...args: unknown[]): void {
    this.log.push(["emit", name, ...args]);
  }
  override off(name?: string, fn?: Handler): this {
    if (name === undefined) {
      this.log.push(["off"]);
      this.handlers.clear();
      return this;
    }
    return super.off(name, fn);
  }
  disconnect(): void {
    this.log.push(["disconnect"]);
    this.disconnected = true;
  }
}

class FakeScene {
  children: FakeObject[] = [];
  events = new FakeEmitter();
  bgm = { stopped: false, stop: () => void (this.bgm.stopped = true) };
  sys: { settings: { key: string; status: number } };
  scene: { isActive: () => boolean };
  id: string | null = "player-id-36chars";
  socket: FakeSocket | null = null;
  config: { rule: string } | null = null;
  room: string | null = null;
  btn_surrender: FakeObject | null = null;
  /** 官方確認面板開了幾次（官方 pointerdown 做的事）。 */
  panels = 0;

  constructor(
    public game: FakeGame,
    key: string,
  ) {
    this.sys = { settings: { key, status: 8 } };
    this.scene = { isActive: () => this.sys.settings.status === 5 };
  }

  add(x: number, y: number, key: string, frame?: number): FakeObject {
    const o = new FakeObject(this, x, y).setTexture(key, frame);
    this.children.push(o);
    return o;
  }

  /**
   * 官方 MainA.create()：白旗照原文建、rule 不是 duel/ranked 就藏起來；
   * 掛 shutdown → 收 socket。
   */
  enterBattle(rule: string, room = "room-32chars"): void {
    this.sys.settings.status = 5;
    this.config = { rule };
    this.room = room;
    this.socket = new FakeSocket("wss://battle");
    const b = this.add(760, 118, "btn_surrender", 0).setOrigin().setInteractive();
    b.on("pointerover", () => void b.setTexture("btn_surrender", 1));
    b.on("pointerout", () => void b.setTexture("btn_surrender", 0));
    b.on("pointerdown", () => {
      b.setTexture("btn_surrender", 0).disableInteractive();
      this.panels++;
    });
    if (rule === "quest" || rule === "raid" || rule === "event") b.visible = false;
    this.btn_surrender = b;
    this.events.once("shutdown", () => {
      this.socket?.disconnect();
      this.socket?.off();
    });
  }

  /** Phaser 的 stop：shutdown 事件、物件全 destroy。 */
  leave(): void {
    this.sys.settings.status = 8;
    this.events.emit("shutdown");
    for (const c of this.children) c.destroy();
    this.children = [];
    this.btn_surrender = null;
  }

  flag(): FakeObject {
    if (!this.btn_surrender) throw new Error("沒有白旗");
    return this.btn_surrender;
  }
}

class FakeGame {
  scene: {
    keys: Record<string, FakeScene>;
    scenes: FakeScene[];
    stop: (k: string) => void;
    start: (k: string, data: unknown) => void;
  };
  stopped: string[] = [];
  started: { key: string; data: Record<string, unknown> }[] = [];

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
      "MainA",
      "BackA",
      "Log",
      "AttackPhaseA",
      "Friend",
      "Loader",
      "ConnectionCheck",
      "MainAAssets",
      "Bug",
      "MatchBoot",
    ]) {
      keys[k] = new FakeScene(this, k);
    }
    for (const k of ["Friend", "Loader", "ConnectionCheck", "MainAAssets", "Bug", "MatchBoot"]) {
      keys[k]!.sys.settings.status = 5;
    }
    // 離開大廳後 Lobby.socket 是 disconnect 的，但 url 讀得到。
    const lobby = keys.Lobby!;
    lobby.socket = new FakeSocket("https://www.playunlight.online:11009");
    lobby.socket.disconnected = true;
    this.scene = {
      keys,
      scenes: Object.values(keys),
      stop: (k) => {
        this.stopped.push(k);
        keys[k]?.leave();
      },
      start: (k, data) => this.started.push({ key: k, data: data as Record<string, unknown> }),
    };
  }

  /** 開一場渦戰：MainA 跟子場景 RUNNING、渦房 SLEEPING（照實機的樣子）。 */
  raidBattle(): FakeScene {
    const m = this.at("MainA");
    m.enterBattle("raid");
    for (const k of ["BackA", "Log", "AttackPhaseA"]) this.at(k).sys.settings.status = 5;
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
let timers: (() => void)[] = [];

function run(window: FakeWindow, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window",
    "setInterval",
    "clearInterval",
    "setTimeout",
    `return ${expression};`,
  ) as (...args: unknown[]) => string;
  return fn(
    window,
    (cb: () => void) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
    (cb: () => void) => {
      timers.push(cb);
      return timers.length;
    },
  );
}

/** 讓問路那串 Promise 跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => queueMicrotask(() => r(undefined)));
}

function install(window: FakeWindow): string {
  poll = null;
  timers = [];
  FakeSocket.made = [];
  FakeSocket.answers = { raid_port: ["https://www.playunlight.online", 15009] };
  return run(window, buildRaidSurrenderPatchScript({ bindingName: BINDING }));
}

function tick(): void {
  poll?.();
}

// ---------------------------------------------------------------------------
// 測試
// ---------------------------------------------------------------------------

describe("buildRaidSurrenderPatchScript", () => {
  it("組態是解析過的值，不是字串（embedJson 的坑）", () => {
    const src = buildRaidSurrenderPatchScript({ bindingName: BINDING });
    expect(src).toMatch(/var CFG = JSON\.parse\(/);
    expect(src).not.toContain("`");
  });

  it("不在渦戰裡不掛：沒開打、或是 PVP，白旗都不動", () => {
    const { window } = makeWindow();
    const G = window.game;
    const raw = install(window);
    expect(parseRaidSurrenderStatus(raw)).toEqual({
      installed: true,
      version: RAID_SURRENDER_SCRIPT_VERSION,
      mounted: false,
      reason: null,
    });

    // PVP：白旗本來就看得見、官方 pointerdown 開確認面板 —— 一個都不碰。
    const m = G.at("MainA");
    m.enterBattle("duel");
    tick();
    expect(parseRaidSurrenderStatus(run(window, RAID_SURRENDER_STATUS_EXPRESSION)).mounted).toBe(
      false,
    );
    m.flag().emit("pointerdown");
    expect(m.panels).toBe(1);
    expect(m.flag().visible).toBe(true);
  });

  it("渦戰：白旗顯示出來、官方 pointerdown 拆掉、hover 換圖留著", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    expect(m.flag().visible).toBe(false);
    install(window);

    const b = m.flag();
    expect(b.visible).toBe(true);
    expect(b.input?.enabled).toBe(true);
    expect(b.listenerCount("pointerdown")).toBe(1);
    expect(b.listenerCount("pointerover")).toBe(1);
    expect(b.listenerCount("pointerout")).toBe(1);
    b.emit("pointerover");
    expect(b.frame.name).toBe(1);
    b.emit("pointerout");
    expect(b.frame.name).toBe(0);
    expect(parseRaidSurrenderStatus(run(window, RAID_SURRENDER_STATUS_EXPRESSION)).mounted).toBe(
      true,
    );
  });

  it("按下去：問路 → 照 on_result 收戰鬥連線 → 清場（連 sleeping 的渦房）→ start Raid，不開確認面板", async () => {
    const { window, reports } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);
    const battle = m.socket!;

    m.flag().emit("pointerdown");
    expect(m.panels).toBe(0);
    expect(m.flag().input?.enabled).toBe(false);
    await settle();

    // 問路：照大廳的 url 另開一條臨時連線，問完就關。
    const asked = FakeSocket.made.filter((s) => s.url.indexOf("11009") >= 0);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.disconnected).toBe(true);
    // 戰鬥連線照 on_result 的順序收：off → leaveRoom → disconnect —— 而且要在
    // stop 之前（後面那兩筆是 MainA 自己的 shutdown 補的，那時 leaveRoom 已經送走了）。
    expect(battle.log).toEqual([
      ["off"],
      ["emit", "leaveRoom", "room-32chars"],
      ["disconnect"],
      ["disconnect"],
      ["off"],
    ]);
    // 清場：MainA、子場景、sleeping 的 Raid 全收；常駐一個都不碰。
    expect([...G.stopped].sort()).toEqual(["AttackPhaseA", "BackA", "Log", "MainA", "Raid"]);
    expect(m.bgm.stopped).toBe(true);
    for (const k of ["Friend", "Loader", "ConnectionCheck", "MainAAssets", "Bug", "MatchBoot"]) {
      expect(G.at(k).sys.settings.status).toBe(5);
    }
    expect(G.started).toEqual([
      {
        key: "Raid",
        data: { id: "player-id-36chars", host: "https://www.playunlight.online", port: 15009 },
      },
    ]);
    expect(reports.filter(isRaidSurrenderReport)).toEqual([
      { type: "raid-surrender", ok: true, reason: null, stopped: expect.any(Array) },
    ]);
    // 戰鬥停了 → 下一拍狀態清掉。
    tick();
    expect(parseRaidSurrenderStatus(run(window, RAID_SURRENDER_STATUS_EXPRESSION)).mounted).toBe(
      false,
    );
  });

  it("問不到路就什麼都不動：連線還在、場景還在、白旗彈回來、回報 ok:false", async () => {
    const { window, reports } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);
    FakeSocket.answers = { raid_port: new Error("伺服器不理") };

    m.flag().emit("pointerdown");
    await settle();
    expect(m.socket!.log).toEqual([]);
    expect(G.stopped).toEqual([]);
    expect(G.started).toEqual([]);
    expect(m.flag().input?.enabled).toBe(true);
    expect(m.flag().visible).toBe(true);
    expect(reports.find(isRaidSurrenderReport)).toEqual({
      type: "raid-surrender",
      ok: false,
      reason: "伺服器不理",
    });

    // 修好了再按一次就走得掉。
    FakeSocket.answers = { raid_port: ["https://www.playunlight.online", 15002] };
    m.flag().emit("pointerdown");
    await settle();
    expect(G.started[0]?.data.port).toBe(15002);
  });

  it("連按只走一次", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);

    m.flag().emit("pointerdown");
    m.flag().emit("pointerdown");
    m.flag().emit("pointerdown");
    await settle();
    expect(FakeSocket.made.filter((s) => s.url.indexOf("11009") >= 0)).toHaveLength(1);
    expect(G.started).toHaveLength(1);
  });

  it("挖不到玩家 id 就不問路、不動", async () => {
    const { window, reports } = makeWindow();
    const m = window.game.raidBattle();
    m.id = null;
    install(window);

    m.flag().emit("pointerdown");
    await settle();
    expect(FakeSocket.made.filter((s) => s.url.indexOf("11009") >= 0)).toHaveLength(0);
    expect(window.game.started).toEqual([]);
    expect(reports.find(isRaidSurrenderReport)).toMatchObject({
      ok: false,
      reason: "挖不到玩家 id",
    });
  });

  it("下一場是新的一顆白旗 → 重掛；同一場不重掛", () => {
    const { window } = makeWindow();
    const G = window.game;
    const m = G.raidBattle();
    install(window);
    const first = m.flag();
    tick();
    tick();
    expect(first.listenerCount("pointerdown")).toBe(1);

    // 打完一場（MainA stop）再開下一場：create 重跑、白旗是新的一顆。
    m.leave();
    tick();
    m.enterBattle("raid", "room-next");
    expect(m.flag()).not.toBe(first);
    expect(m.flag().visible).toBe(false);
    tick();
    expect(m.flag().visible).toBe(true);
    expect(m.flag().listenerCount("pointerdown")).toBe(1);
    m.flag().emit("pointerdown");
    expect(m.panels).toBe(0);
  });

  it("拆掉：官方 handler 掛回去、白旗藏回去；重裝不留孤兒", () => {
    const { window } = makeWindow();
    const m = window.game.raidBattle();
    install(window);
    const b = m.flag();

    // 重裝：先拆再裝，handler 還是一個。
    install(window);
    expect(b.listenerCount("pointerdown")).toBe(1);
    expect(b.visible).toBe(true);

    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(poll).toBeNull();
    expect(b.visible).toBe(false);
    expect(b.listenerCount("pointerdown")).toBe(1);
    b.emit("pointerdown");
    expect(m.panels).toBe(1);
    expect(run(window, RAID_SURRENDER_UNINSTALL_EXPRESSION)).toBe("not-installed");
    expect(parseRaidSurrenderStatus(run(window, RAID_SURRENDER_STATUS_EXPRESSION))).toEqual({
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
