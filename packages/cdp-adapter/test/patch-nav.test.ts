/**
 * 返回鈕左邊的直連捷徑列
 *
 * 跟 `patch-present` 同一套：搭一個夠像的假遊戲，把 `buildNavPatchScript()`
 * 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * 假環境照 2026-09-24 從跑著的客戶端讀的形狀寫（2026-09-23 改版後），**每個
 * 畫面的返回鈕流程都照抄**（這支就是靠按它、改道它最後那句
 * scene.start("Lobby") 來跳的）：
 *
 * ```js
 *   全部：this.btn_back = add.image(760,0,"btn_back").setOrigin(1,0)，離開寫在 pointerup
 *     Match/Quest/Raid/Shop/Lot: 淡出 → start("Lobby")
 *     Edit:    try_scene_end("Lobby") → fetch("deck_update", deck)
 *              → 回 true（伺服器不收）就留在原地；否則看 scene_next → start("Lobby"/"Compo")
 *     Item:    try_scene_end() → fetch("avatar_update", avatar.raw()) → start("Lobby")
 *     Library: fetch("update_chara_favorite") / fetch("update_stamp_favorite") → start("Lobby")
 *     Option:  option_exit() → start("Lobby")
 *   Tutorial: 返回鈕是 create() 的局部變數（Button 類，once("click")）
 *   大廳四顆：move_scene(目標) —— 一個參數都不帶
 *   素材：UL_ASSETS.lobby.{image,spritesheet,atlas}；duel_btn_2 是 atlas
 * ```
 *
 * 這支要抓的坑：
 *
 * 1. 貼圖是自己抓的、路徑照 UL_ASSETS 查 —— 抓好之前不畫、抓好之後才掛
 * 2. 位置相對於返回鈕；四顆順序 DUEL RAID QUEST DECK；所在那一房那顆變暗
 * 3. 官方返回鈕不能按 → 整排不能按
 * 4. 改道只攔 "Lobby"，而且用完就還原；官方流程沒走到 start 看門狗要拆
 * 5. Edit 的存檔、Item 的頭像、Library 的最愛全由官方流程做
 * 6. 清場只收非常駐場景（含 Session）；目標用 SceneManager 的 start、不帶參數
 * 7. 場景重建後重掛；拆掉時貼圖與動畫一起卸、改道還原
 */

import { describe, expect, it } from "vitest";
import {
  buildNavPatchScript,
  isNavReport,
  NAV_SCRIPT_VERSION,
  NAV_STATUS_EXPRESSION,
  NAV_TARGETS,
  NAV_UNINSTALL_EXPRESSION,
  parseNavStatus,
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
    const wrapped: Handler = (...args) => {
      this.off(name, wrapped);
      fn(...args);
    };
    return this.on(name, wrapped);
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
  listenerCount(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

/** Phaser 的物件被 destroy 之後 `scene` 會變 null —— 腳本靠這個認「死了」。 */
class FakeObject extends FakeEmitter {
  scene: FakeScene | null;
  visible = true;
  alpha = 1;
  depth = 0;
  angle = 0;
  scaleX = 1;
  originX = 0.5;
  originY = 0.5;
  width = 0;
  height = 0;
  input: { enabled: boolean; cursor?: string; hitArea?: unknown } | null = null;
  texture: { key: string } = { key: "" };
  frame: { name: number } = { name: 0 };
  anims = { playAfterRepeat: (key: string) => this.played.push("after:" + key) };
  played: string[] = [];
  mask: unknown = null;
  constructor(
    scene: FakeScene,
    public type: string,
    public x: number,
    public y: number,
  ) {
    super();
    this.scene = scene;
  }
  get displayWidth(): number {
    return this.width * this.scaleX;
  }
  get displayHeight(): number {
    return this.height * this.scaleX;
  }
  destroy(): void {
    this.scene = null;
  }
  setInteractive(hitArea?: unknown): this {
    this.input = { enabled: true, hitArea };
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
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setScale(s: number): this {
    this.scaleX = s;
    return this;
  }
  setOrigin(x: number, y?: number): this {
    this.originX = x;
    this.originY = y ?? x;
    return this;
  }
  setAngle(a: number): this {
    this.angle = a;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setResolution(): this {
    return this;
  }
  setTexture(key: string, frame?: number): this {
    this.texture = { key };
    this.frame = { name: frame ?? 0 };
    return this;
  }
  setFrame(frame: number): this {
    this.frame = { name: frame };
    return this;
  }
  setMask(m: unknown): this {
    this.mask = m;
    return this;
  }
  play(key: string): this {
    this.played.push(key);
    return this;
  }
  stop(): this {
    this.played.push("stop");
    return this;
  }
  // Graphics
  fillStyle(): this {
    return this;
  }
  fillCircle(): this {
    return this;
  }
  lineStyle(): this {
    return this;
  }
  strokeCircle(): this {
    return this;
  }
  createGeometryMask(): { mask: true } {
    return { mask: true };
  }
  // Container
  add(): this {
    return this;
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
    this.width = text.length * 7 + 10;
    this.height = 18;
  }
}

/**
 * 場景的 WSClient。`fetch` 記下來、**不自動回** —— 測試用 `answer()` 決定伺服器
 * 什麼時候回、回什麼（Edit 要測「伺服器還沒回」與「伺服器退回」）。
 */
class FakeSocket extends FakeEmitter {
  fetched: unknown[][] = [];
  pending: { event: string; resolve: (v: unknown) => void }[] = [];
  /** 設了就立刻回這個值（Item／Library 不測等待）。 */
  autoAnswer: Record<string, unknown> = {};
  fetch(event: string, ...args: unknown[]): Promise<unknown> {
    this.fetched.push([event, ...args]);
    if (event in this.autoAnswer) return Promise.resolve(this.autoAnswer[event]);
    return new Promise((resolve) => this.pending.push({ event, resolve }));
  }
  /** 伺服器回 `event`。 */
  answer(event: string, value: unknown): void {
    const i = this.pending.findIndex((p) => p.event === event);
    if (i < 0) throw new Error(`沒有在等 ${event}`);
    const [p] = this.pending.splice(i, 1);
    p!.resolve(value);
  }
}

/** Phaser 的 ScenePlugin：start 在 prototype 上，腳本會用自有屬性蓋掉它。 */
class FakeScenePlugin {
  constructor(
    public key: string,
    private readonly sc: FakeScene,
  ) {}
  isActive(): boolean {
    return this.sc.sys.settings.status === 5;
  }
  start(key: string, data?: unknown): this {
    this.sc.officialStarts.push({ key, data });
    return this;
  }
}

class FakeScene {
  /** Phaser 的 DisplayList：物件在 children.list 裡。 */
  children: { list: FakeObject[] } = { list: [] };
  tweensMade: { targets: unknown; stopped: boolean; stop: () => void }[] = [];
  fadeCalls = 0;
  bgm = { key: "bgm", stopped: false, stop: () => void (this.bgm.stopped = true) };
  ulse01 = { plays: 0, play: () => void this.ulse01.plays++ };
  btn_back: FakeObject | null = null;
  socket = new FakeSocket();
  input = { enabled: true };
  sys: { settings: { key: string; status: number } };
  scene: FakeScenePlugin;
  game: FakeGame;
  /** 官方流程叫的 this.scene.start（沒被改道的）。 */
  officialStarts: { key: string; data?: unknown }[] = [];
  add: {
    sprite: (x: number, y: number, key: string, frame?: number) => FakeObject;
    image: (x: number, y: number, key: string) => FakeObject;
    graphics: () => FakeObject;
    container: (x: number, y: number) => FakeObject;
    rectangle: (x: number, y: number) => FakeObject;
    zone: (x: number, y: number) => FakeObject;
    text: (x: number, y: number, t: string) => FakeText;
  };
  make: { graphics: () => FakeObject };
  tweens: { add: (cfg: { targets: unknown }) => { stop: () => void } };
  cameras: { main: { fadeOut: (ms: number) => FakeEmitter } };
  [k: string]: unknown;

  constructor(game: FakeGame, key: string) {
    this.game = game;
    this.sys = { settings: { key, status: 8 } };
    this.scene = new FakeScenePlugin(key, this);
    const mk = (type: string, x: number, y: number): FakeObject => {
      const o = new FakeObject(this, type, x, y);
      this.children.list.push(o);
      return o;
    };
    this.add = {
      sprite: (x: number, y: number, key: string, frame?: number) => {
        const o = mk("Sprite", x, y).setTexture(key, frame);
        o.width = o.height = key.indexOf("deck") >= 0 ? 112 : key.indexOf("Icon") >= 0 ? 51 : 160;
        return o;
      },
      image: (x: number, y: number, key: string) => {
        const o = mk("Image", x, y).setTexture(key);
        o.width = o.height = 160;
        return o;
      },
      graphics: () => mk("Graphics", 0, 0),
      container: (x: number, y: number) => mk("Container", x, y),
      rectangle: (x: number, y: number) => mk("Rectangle", x, y),
      zone: (x: number, y: number) => mk("Zone", x, y),
      text: (x: number, y: number, t: string) => {
        const o = new FakeText(this, x, y, t);
        this.children.list.push(o);
        return o;
      },
    };
    this.make = { graphics: () => new FakeObject(this, "Graphics", 0, 0) };
    this.tweens = {
      add: (cfg) => {
        const t = { targets: cfg.targets, stopped: false, stop: () => void (t.stopped = true) };
        this.tweensMade.push(t);
        return t;
      },
    };
    this.cameras = {
      main: {
        fadeOut: () => {
          this.fadeCalls++;
          const e = new FakeEmitter();
          // 淡出瞬間完成 —— 測的是流程，不是 700ms。
          const orig = e.on.bind(e);
          e.on = (name, fn) => {
            orig(name, fn);
            if (name === "camerafadeoutcomplete") fn();
            return e;
          };
          return e;
        },
      },
    };
  }

  /** 官方的淡出（Match/Edit/Shop/Item 的 scene_end 是 Promise）。 */
  scene_end(): Promise<void> {
    this.fadeCalls++;
    return Promise.resolve();
  }

  /**
   * 官方 create()：每次進來物件全部新的，返回鈕流程照抄各畫面（2026-09-24 讀的）。
   * 返回鈕 add.image(760,0,"btn_back").setOrigin(1,0)，48×32 → 左緣 712、中心 y 16。
   */
  enter(): void {
    const key = this.sys.settings.key;
    this.sys.settings.status = 5;
    this.officialStarts = [];
    this.input.enabled = true;
    const b = this.add.image(760, 0, "btn_back").setOrigin(1, 0);
    b.width = 48;
    b.height = 32;
    b.setInteractive();
    const fadeToLobby = (data?: unknown): void => {
      this.cameras.main.fadeOut(700).on("camerafadeoutcomplete", () => {
        this.scene.start("Lobby", data);
      });
    };
    const leaving = (): void => {
      this.input.enabled = false;
      b.disableInteractive();
      this.ulse01.play();
    };
    switch (key) {
      case "TutorialNewMenu":
        // 局部變數（Button 類），不掛在 this.btn_back 上。
        b.once("click", () => void this.scene_end().then(() => this.scene.start("Lobby", {})));
        return;
      case "Edit":
        b.on("pointerup", () => void this.try_scene_end("Lobby"));
        break;
      case "Item":
        b.on("pointerup", () => {
          b.disableInteractive();
          void (async () => {
            const avatar = this.avatar as { raw: () => unknown };
            await this.socket.fetch("avatar_update", avatar.raw());
            this.ulse01.play();
            fadeToLobby({ is_news: false, is_tutorial: false });
          })();
        });
        break;
      case "Library":
        b.on("pointerup", () => {
          this.input.enabled = false;
          void (async () => {
            await this.socket.fetch("update_chara_favorite", this.chara_favorite);
            await this.socket.fetch("update_stamp_favorite", this.stamp_favorite);
            b.disableInteractive();
            this.ulse01.play();
            fadeToLobby();
          })();
        });
        break;
      default:
        // Match / Quest / Raid / Shop / Lot / Option
        b.on("pointerup", () => {
          leaving();
          fadeToLobby();
        });
    }
    this.btn_back = b;
  }

  /** 官方 Edit.try_scene_end：先存牌組，伺服器退回（true）就留在原地。 */
  async try_scene_end(next: string): Promise<void> {
    this.input.enabled = false;
    this.scene_next = next;
    this.ulse01.play();
    const refused = await this.socket.fetch("deck_update", this.deck);
    if (refused === true) {
      this.input.enabled = true;
      return;
    }
    await new Promise<void>((r) =>
      this.cameras.main.fadeOut(700).on("camerafadeoutcomplete", () => r()),
    );
    if (this.scene_next === "Lobby")
      this.scene.start("Lobby", { is_news: false, is_tutorial: false });
    else if (this.scene_next === "Compo") this.scene.start("Compo", { compo_data: null });
  }

  /** 官方返回鈕（含 Tutorial 那顆局部的）。 */
  back(): FakeObject {
    const b =
      this.btn_back ??
      this.children.list.find((c) => c.scene !== null && c.texture.key === "btn_back");
    if (!b) throw new Error("沒有返回鈕");
    return b;
  }

  leave(): void {
    this.sys.settings.status = 8;
    for (const c of this.children.list) c.destroy();
    this.children = { list: [] };
    this.btn_back = null;
  }

  /** 我們畫上去的（活著的）東西。 */
  mine(): FakeObject[] {
    return this.children.list.filter(
      (c) => c.scene !== null && c.texture.key.indexOf("__ulrNav") === 0,
    );
  }
  sprite(key: string): FakeObject {
    const o = this.mine().find((c) => c.texture.key === key);
    if (!o) throw new Error(`沒有 ${key}`);
    return o;
  }
}

class FakeGame {
  scene: {
    keys: Record<string, FakeScene>;
    scenes: FakeScene[];
    stop: (k: string) => void;
    start: (k: string, data: unknown) => void;
  };
  textures: {
    keys: Set<string>;
    /** 我們的 key → 怎麼加進來的（spritesheet 的切格、atlas 的 json）。 */
    added: Map<string, { kind: string; data: unknown }>;
    exists: (k: string) => boolean;
    addSpriteSheet: (k: string, img: unknown, frame: unknown) => void;
    addImage: (k: string) => void;
    addAtlas: (k: string, img: unknown, json: unknown) => void;
    remove: (k: string) => void;
  };
  anims: {
    keys: Set<string>;
    made: Map<string, unknown>;
    exists: (k: string) => boolean;
    create: (cfg: { key: string; frames: unknown }) => void;
    generateFrameNumbers: (k: string, cfg: { start: number; end: number }) => number[];
    remove: (k: string) => void;
  };
  scale = { width: 760, height: 680 };
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
      "Quest",
      "Raid",
      "Edit",
      "Shop",
      "Item",
      "Library",
      "Option",
      "TutorialNewMenu",
      "MainA",
      "BackA",
      "Session",
      "Friend",
      "Loader",
      "MainAAssets",
      "Bug",
    ]) {
      keys[k] = new FakeScene(this, k);
    }
    for (const k of ["Session", "Friend", "Loader", "MainAAssets", "Bug"]) {
      keys[k]!.sys.settings.status = 5;
    }
    this.scene = {
      keys,
      scenes: Object.values(keys),
      stop: (k) => {
        this.stopped.push(k);
        keys[k]?.leave();
      },
      start: (k, data) => this.started.push({ key: k, data }),
    };
    const tk = new Set<string>();
    const added = new Map<string, { kind: string; data: unknown }>();
    this.textures = {
      keys: tk,
      added,
      exists: (k) => tk.has(k),
      addSpriteSheet: (k, _img, frame) => {
        tk.add(k);
        added.set(k, { kind: "spritesheet", data: frame });
      },
      addImage: (k) => {
        tk.add(k);
        added.set(k, { kind: "image", data: null });
      },
      addAtlas: (k, _img, json) => {
        tk.add(k);
        added.set(k, { kind: "atlas", data: json });
      },
      remove: (k) => void tk.delete(k),
    };
    const ak = new Set<string>();
    const made = new Map<string, unknown>();
    this.anims = {
      keys: ak,
      made,
      exists: (k) => ak.has(k),
      create: (cfg) => {
        ak.add(cfg.key);
        made.set(cfg.key, cfg.frames);
      },
      generateFrameNumbers: (_k, cfg) => {
        const out: number[] = [];
        for (let i = cfg.start; i <= cfg.end; i++) out.push(i);
        return out;
      },
      remove: (k) => void ak.delete(k),
    };
  }
}

interface FakeWindow {
  game: FakeGame;
  lang: string;
  UL_CONFIG: { domains: { assets: { urls: string[] } } };
  UL_ASSETS: { lobby: Record<string, unknown[]> };
  Phaser: unknown;
  fetched: string[];
  [key: string]: unknown;
}

/** 2026-09-24 讀的 UL_ASSETS.lobby（只留這支用得到的，加一個不相干的）。 */
const LOBBY_ASSETS = {
  image: [
    { key: "lobby_bg", url: "images/assets/Lobby/lobby_bg.avif" },
    { key: "raid_btn_base", url: "images/assets/Lobby/raid_btn_base.avif" },
  ],
  spritesheet: [
    {
      key: "deck_btn",
      url: "images/assets/Lobby/deck_btn.avif",
      frameConfig: { frameWidth: 112, frameHeight: 112 },
    },
    {
      key: "duel_btn",
      url: "images/assets/Lobby/duel_btn.avif",
      frameConfig: { frameWidth: 160, frameHeight: 160 },
    },
    {
      key: "quest_btn",
      url: "images/assets/Lobby/quest_btn.avif",
      frameConfig: { frameWidth: 160, frameHeight: 160 },
    },
    {
      key: "raid_btn_icon",
      url: "images/assets/Lobby/raid_btn_icon.avif",
      frameConfig: { frameWidth: 51, frameHeight: 51 },
    },
  ],
  atlas: [
    {
      key: "duel_btn_2",
      textureURL: "images/assets/Lobby/duel_btn_2.avif",
      atlasURL: "images/assets/Lobby/duel_btn_2.json",
    },
  ],
};

const DUEL2_JSON = {
  textures: [{ image: "duel_btn_2.png", frames: [{ filename: "duel_btn_2-0.png" }] }],
};

function makeWindow(options: { fetchFails?: boolean } = {}): {
  window: FakeWindow;
  reports: unknown[];
} {
  const game = new FakeGame();
  const reports: unknown[] = [];
  const window: FakeWindow = {
    game,
    lang: "tcn",
    UL_CONFIG: { domains: { assets: { urls: ["https://assets.example"] } } },
    UL_ASSETS: { lobby: LOBBY_ASSETS },
    Phaser: {
      Geom: {
        Circle: class {
          constructor(
            public x: number,
            public y: number,
            public r: number,
          ) {}
          static Contains(): boolean {
            return true;
          }
        },
      },
    },
    fetched: [],
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  window.fetch = (url: string) => {
    window.fetched.push(url);
    if (options.fetchFails) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      blob: () => Promise.resolve({}),
      json: () => Promise.resolve(DUEL2_JSON),
    });
  };
  return { window, reports };
}

let poll: (() => void) | null = null;
let timers: (() => void)[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function run(window: FakeWindow, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "fetch",
    "Image",
    "URL",
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
    window.fetch,
    FakeImage,
    { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
  );
}

/** 讓 fetch → blob → Image.onload → Promise.all 那一串跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => queueMicrotask(() => r(undefined)));
}

async function install(window: FakeWindow): Promise<string> {
  poll = null;
  timers = [];
  const raw = run(window, buildNavPatchScript({ bindingName: BINDING }));
  await settle();
  return raw;
}

function tick(): void {
  poll?.();
}

function centers(sc: FakeScene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["__ulrNav_duel", "__ulrNav_raid", "__ulrNav_quest", "__ulrNav_deck"]) {
    out[key.replace("__ulrNav_", "")] = sc.sprite(key).x;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 測試
// ---------------------------------------------------------------------------

describe("buildNavPatchScript", () => {
  it("組態是解析過的值，不是字串（embedJson 的坑）", () => {
    const src = buildNavPatchScript({ bindingName: BINDING });
    expect(src).toMatch(/var CFG = JSON\.parse\(/);
    expect(src).not.toContain("`");
  });

  it("貼圖抓好之前不畫；抓好之後掛在返回鈕左邊，順序 DUEL RAID QUEST DECK", async () => {
    const { window } = makeWindow();
    const sc = window.game.at("Match");
    sc.enter();
    poll = null;
    timers = [];
    const raw = run(window, buildNavPatchScript({ bindingName: BINDING }));
    const status = parseNavStatus(raw);
    expect(status.installed).toBe(true);
    expect(status.version).toBe(NAV_SCRIPT_VERSION);
    expect(status.ready).toBe(false);
    expect(sc.mine()).toHaveLength(0);

    await settle();
    // 六張圖 + duel_btn_2 的 atlas json；路徑照 UL_ASSETS.lobby 查，不是寫死的。
    expect(window.fetched).toHaveLength(7);
    expect(window.fetched).toContain("https://assets.example/images/assets/Lobby/duel_btn.avif");
    expect(window.fetched).toContain("https://assets.example/images/assets/Lobby/duel_btn_2.json");
    const added = window.game.textures.added;
    expect(added.get("__ulrNav_duel")).toEqual({
      kind: "spritesheet",
      data: { frameWidth: 160, frameHeight: 160 },
    });
    expect(added.get("__ulrNav_duel2")).toEqual({ kind: "atlas", data: DUEL2_JSON });
    expect(added.get("__ulrNav_raid")?.kind).toBe("image");
    expect(window.game.anims.keys.has("__ulrNav_duel_1")).toBe(true);
    // atlas 的動畫照官方用「整張貼圖」—— frames 是貼圖 key，不是數字。
    expect(window.game.anims.made.get("__ulrNav_duel_2")).toBe("__ulrNav_duel2");

    const c = centers(sc);
    // 返回鈕左緣 712，往左 gap 6，半徑 14 → 最右 692，每顆間距 34。
    expect(c.deck).toBe(692);
    expect(c.quest).toBe(658);
    expect(c.raid).toBe(624);
    expect(c.duel).toBe(590);
    expect(sc.sprite("__ulrNav_duel").scaleX).toBeCloseTo(28 / 160);
    expect(sc.sprite("__ulrNav_deck").mask).toEqual({ mask: true });
    expect(parseNavStatus(run(window, NAV_STATUS_EXPRESSION)).mounted).toBe("Match");
  });

  it("所在那一房的那顆變暗、點不動；其他三顆亮著", async () => {
    const { window } = makeWindow();
    const sc = window.game.at("Match");
    sc.enter();
    await install(window);
    expect(sc.sprite("__ulrNav_duel").alpha).toBe(0.4);
    expect(sc.sprite("__ulrNav_duel").input?.enabled).toBe(false);
    for (const k of ["__ulrNav_raid", "__ulrNav_quest", "__ulrNav_deck"]) {
      expect(sc.sprite(k).alpha).toBe(1);
      expect(sc.sprite(k).input?.enabled).toBe(true);
    }
  });

  it("官方返回鈕不能按 → 整排變暗、點不動；恢復就亮回來", async () => {
    const { window } = makeWindow();
    const sc = window.game.at("Quest");
    sc.enter();
    await install(window);
    expect(sc.sprite("__ulrNav_duel").input?.enabled).toBe(true);

    sc.back().disableInteractive();
    tick();
    expect(sc.sprite("__ulrNav_duel").alpha).toBe(0.4);
    expect(sc.sprite("__ulrNav_duel").input?.enabled).toBe(false);
    sc.sprite("__ulrNav_duel").emit("pointerdown");
    expect(window.game.started).toHaveLength(0);

    sc.back().setInteractive();
    tick();
    expect(sc.sprite("__ulrNav_duel").alpha).toBe(1);
  });

  it("從對戰大廳點 QUEST：按官方返回鈕 → 它的 scene.start(Lobby) 被改道成清場 + start Quest（不帶參數）", async () => {
    const { window, reports } = makeWindow();
    const G = window.game;
    const sc = G.at("Match");
    sc.enter();
    await install(window);

    sc.sprite("__ulrNav_quest").emit("pointerdown");
    await settle();

    // 官方流程跑了（音效、淡出是它做的），最後那句 start("Lobby") 沒有真的到大廳。
    expect(sc.ulse01.plays).toBe(1);
    expect(sc.fadeCalls).toBe(1);
    expect(sc.officialStarts).toEqual([]);
    // 只收非常駐場景（Session 那些不動）。
    expect(G.stopped).toEqual(["Match"]);
    expect(G.at("Session").sys.settings.status).toBe(5);
    // 改版後場景的 init() 不收參數。
    expect(G.started).toEqual([{ key: "Quest", data: undefined }]);
    // 改道用完就還原：ScenePlugin 身上沒有自有的 start 了。
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(false);
    const r = reports.find(isNavReport);
    expect(r).toMatchObject({ type: "nav", from: "Match", to: "quest", ok: true });
  });

  it("從任務房點 DUEL／DECK：按的是 pointerup，目的地不帶參數", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Quest");
    sc.enter();
    await install(window);

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    expect(sc.ulse01.plays).toBe(1);
    expect(G.started).toEqual([{ key: "Match", data: undefined }]);

    G.started = [];
    G.stopped = [];
    sc.enter();
    tick();
    sc.sprite("__ulrNav_deck").emit("pointerdown");
    await settle();
    expect(G.started).toEqual([{ key: "Edit", data: undefined }]);
  });

  it("從牌組編輯離開：官方流程先存牌組（deck_update）、等回應才到 start —— 那一刻才改道", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Edit");
    sc.enter();
    sc.deck = [{ deck_id: 1 }];
    await install(window);

    sc.sprite("__ulrNav_quest").emit("pointerdown");
    await settle();
    // 官方的存檔送出去了、還在等回應 → 還沒跳。
    expect(sc.socket.fetched).toEqual([["deck_update", sc.deck]]);
    expect(G.started).toEqual([]);
    expect(sc.sprite("__ulrNav_deck").input?.enabled).toBe(false);

    sc.socket.answer("deck_update", false);
    await settle();
    expect(sc.officialStarts).toEqual([]);
    expect(G.stopped).toEqual(["Edit"]);
    expect(G.started).toEqual([{ key: "Quest", data: undefined }]);
  });

  it("牌組編輯：伺服器退回存檔就留在原地 —— 看門狗把改道拆掉、按鈕亮回來", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Edit");
    sc.enter();
    await install(window);

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    sc.socket.answer("deck_update", true);
    await settle();
    expect(G.started).toEqual([]);
    expect(sc.input.enabled).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(true);

    for (const t of timers.splice(0)) t();
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(false);
    tick();
    expect(sc.sprite("__ulrNav_duel").input?.enabled).toBe(true);
  });

  it("道具畫面：官方流程送完 avatar_update 才跳", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Item");
    sc.enter();
    sc.avatar = { raw: () => ({ hair: 3 }) };
    sc.socket.autoAnswer = { avatar_update: true };
    await install(window);

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    expect(sc.socket.fetched).toEqual([["avatar_update", { hair: 3 }]]);
    expect(G.started).toEqual([{ key: "Match", data: undefined }]);
  });

  it("圖書館：官方先存最愛、伺服器回話才跳", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Library");
    sc.enter();
    sc.chara_favorite = "cc001";
    sc.stamp_favorite = [1, 2];
    await install(window);

    sc.sprite("__ulrNav_raid").emit("pointerdown");
    await settle();
    expect(sc.socket.fetched).toEqual([["update_chara_favorite", "cc001"]]);
    expect(G.started).toEqual([]);

    sc.socket.answer("update_chara_favorite", "cc001");
    await settle();
    sc.socket.answer("update_stamp_favorite", [1, 2]);
    await settle();
    expect(G.stopped).toEqual(["Library"]);
    expect(G.started).toEqual([{ key: "Raid", data: undefined }]);
  });

  it("教學選單：返回鈕不在 this.btn_back 上，從 children 找；位置照它的 origin 算", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("TutorialNewMenu");
    sc.enter();
    expect(sc.btn_back).toBeNull();
    await install(window);
    // 返回鈕 origin(1,0) 放在 (760,0)：左緣 712、中心 y 16。
    expect(sc.sprite("__ulrNav_deck").x).toBe(692);
    expect(sc.sprite("__ulrNav_deck").y).toBe(16);

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    expect(G.started).toEqual([{ key: "Match", data: undefined }]);
  });

  it("設定畫面也掛", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Option");
    sc.enter();
    await install(window);
    expect(sc.mine().length).toBeGreaterThan(0);
    sc.sprite("__ulrNav_quest").emit("pointerdown");
    await settle();
    expect(G.started[0]?.key).toBe("Quest");
  });

  it("改道只攔 Lobby：官方流程跳去別的地方就原樣放行並解除", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Edit");
    sc.enter();
    await install(window);

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    // 假設玩家（或遊戲）在存檔回來之前把去向改成合成。
    sc.scene_next = "Compo";
    sc.socket.answer("deck_update", false);
    await settle();
    expect(sc.officialStarts).toEqual([{ key: "Compo", data: { compo_data: null } }]);
    expect(G.started).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(false);
  });

  it("看門狗：官方流程一直沒走到 start，時間到把改道拆掉、按鈕亮回來", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Quest");
    sc.enter();
    await install(window);
    // 官方的淡出永遠不完成（例如場景卡住）。
    sc.cameras.main.fadeOut = () => {
      sc.fadeCalls++;
      return new FakeEmitter();
    };

    sc.sprite("__ulrNav_duel").emit("pointerdown");
    await settle();
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(true);
    expect(sc.sprite("__ulrNav_raid").input?.enabled).toBe(false);

    for (const t of timers.splice(0)) t();
    expect(Object.prototype.hasOwnProperty.call(sc.scene, "start")).toBe(false);
    // 官方把返回鈕 disable 了，所以整排仍照官方狀態變暗；但 busy 已經放掉 ——
    // 返回鈕一恢復就能按。
    sc.back().setInteractive();
    tick();
    expect(sc.sprite("__ulrNav_raid").input?.enabled).toBe(true);
    expect(G.started).toEqual([]);
  });

  it("hover 播大廳那套動畫、放開就停；離開房間再進來會重掛", async () => {
    const { window } = makeWindow();
    const sc = window.game.at("Raid");
    sc.enter();
    await install(window);

    const duel = sc.sprite("__ulrNav_duel");
    duel.emit("pointerover");
    expect(duel.played).toEqual(["__ulrNav_duel_1"]);
    expect(sc.sprite("__ulrNav_duel2").visible).toBe(true);
    duel.emit("pointerout");
    expect(sc.sprite("__ulrNav_duel2").visible).toBe(false);

    const deck = sc.sprite("__ulrNav_deck");
    deck.emit("pointerover");
    expect(deck.played).toEqual(["__ulrNav_deck_1", "after:__ulrNav_deck_2"]);

    // 渦：所在那一房，圖示不轉。
    const icon = sc.sprite("__ulrNav_raidIcon");
    sc.sprite("__ulrNav_raid").emit("pointerover");
    expect(sc.tweensMade.some((t) => t.targets === icon)).toBe(false);

    const before = sc.mine().length;
    sc.leave();
    tick();
    expect(sc.mine()).toHaveLength(0);
    sc.enter();
    tick();
    expect(sc.mine()).toHaveLength(before);
    expect(parseNavStatus(run(window, NAV_STATUS_EXPRESSION)).mounted).toBe("Raid");
  });

  it("不在名單裡的場景（大廳、戰鬥）不畫", async () => {
    const { window } = makeWindow();
    const G = window.game;
    G.at("Lobby").enter();
    G.at("MainA").sys.settings.status = 5;
    await install(window);
    tick();
    expect(G.at("Lobby").mine()).toHaveLength(0);
    expect(parseNavStatus(run(window, NAV_STATUS_EXPRESSION)).mounted).toBeNull();
  });

  it("貼圖抓不到：記在 reason、之後會再試", async () => {
    const { window } = makeWindow({ fetchFails: true });
    window.game.at("Match").enter();
    await install(window);
    const status = parseNavStatus(run(window, NAV_STATUS_EXPRESSION));
    expect(status.ready).toBe(false);
    expect(status.reason).toContain("HTTP 404");
  });

  it("拆掉：物件、貼圖、動畫都不留；重裝不留孤兒", async () => {
    const { window } = makeWindow();
    const G = window.game;
    const sc = G.at("Match");
    sc.enter();
    await install(window);
    const first = sc.mine();
    expect(first.length).toBeGreaterThan(0);

    await install(window);
    for (const o of first) expect(o.scene).toBeNull();
    expect(sc.mine().length).toBe(first.length);

    // 改道到一半（Edit 在等存檔回應）就被拆：ScenePlugin.start 要還原。
    const edit = G.at("Edit");
    sc.leave();
    edit.enter();
    tick();
    edit.sprite("__ulrNav_quest").emit("pointerdown");
    await settle();
    expect(Object.prototype.hasOwnProperty.call(edit.scene, "start")).toBe(true);
    expect(run(window, NAV_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(edit.scene, "start")).toBe(false);
    expect(edit.mine()).toHaveLength(0);
    expect(sc.mine()).toHaveLength(0);
    expect(G.textures.keys.size).toBe(0);
    expect(G.anims.keys.size).toBe(0);
    expect(run(window, NAV_UNINSTALL_EXPRESSION)).toBe("not-installed");
    expect(parseNavStatus(run(window, NAV_STATUS_EXPRESSION)).installed).toBe(false);
  });
});

describe("isNavReport / parseNavStatus", () => {
  it("只認 type=nav 而且 to 是四個目的地之一", () => {
    for (const to of NAV_TARGETS) {
      expect(isNavReport({ type: "nav", from: "Match", to, ok: true })).toBe(true);
    }
    expect(isNavReport({ type: "nav", from: "Match", to: "lobby", ok: true })).toBe(false);
    expect(isNavReport({ type: "cost-toggle", enabled: true })).toBe(false);
  });

  it("讀不懂的回應當成沒裝", () => {
    const s = parseNavStatus("not json");
    expect(s.installed).toBe(false);
    expect(s.reason).toContain("讀不懂");
  });
});
