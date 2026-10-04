/**
 * 首頁立繪（多張、編輯模式）與 Library 愛心複選
 *
 * 跟 patch-chara-picker 同一套：搭夠像的假 Lobby／Library 場景，把產出來的那一串字
 * 原封不動 new Function 起來跑。欄位照 2026-10-02 從跑著的客戶端讀的：
 * stand_chara（裁過透明邊的圖集格）、lobby_bg、lobby_chara、chara_card_list[i].chara_favorite、
 * chara_card_index、chara_card_page、chara_favorite。
 *
 * 要抓的坑：
 *
 * 1. 牌組庫沒接上（ready: false）時什麼都不動
 * 2. 官方那張 origin 換到人物中心，但沒存過擺法時畫面位置跟官方一模一樣
 * 3. 多出來的立繪共用官方的遮罩、排在 lobby_bg 正上方（所有按鈕下面）
 * 4. 右鍵空白處進編輯；拖曳、滾輪、Shift＋滾輪（Windows 會變 deltaX）、右鍵翻轉；OK 回報擺法
 * 5. 愛心可複選、官方最愛 = 清單第一個；伺服器上的最愛不在清單裡就補到最前面
 * 6. 拆掉要把包住的 create／show_chara_card 還回去、官方那張放回原位
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildLobbyStandPatchScript,
  buildLobbyStandStateExpression,
  isLobbyStandReport,
  LOBBY_STAND_STATUS_EXPRESSION,
  LOBBY_STAND_UNINSTALL_EXPRESSION,
  parseLobbyStandStatus,
} from "@ulr/cdp-adapter";
import type { LobbyStandSet, LobbyStandState } from "@ulr/cdp-adapter";

type Handler = (...args: unknown[]) => void;

class Emitter {
  handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler): this {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  off(name: string, fn: Handler): this {
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((h) => h !== fn),
    );
    return this;
  }
  removeAllListeners(name: string): this {
    this.handlers.delete(name);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  count(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

interface FakeFrame {
  name: string | number;
  realWidth: number;
  realHeight: number;
  cutX: number;
  cutY: number;
  data: { trim: boolean; spriteSourceSize: { x: number; y: number; w: number; h: number } };
  source: null;
}

/** cc063 的立繪格（2026-10-02 實機）：760×680 裁成 397×434，偏移 (25, 150)。 */
function standFrame(name: string): FakeFrame {
  return {
    name,
    realWidth: 760,
    realHeight: 680,
    cutX: 0,
    cutY: 0,
    data: { trim: true, spriteSourceSize: { x: 25, y: 150, w: 397, h: 434 } },
    source: null,
  };
}

class FakeObject extends Emitter {
  scene: FakeScene | null;
  originX = 0.5;
  originY = 0.5;
  scaleX = 1;
  scaleY = 1;
  angle = 0;
  flipX = false;
  alpha = 1;
  visible = true;
  depth = 0;
  mask: unknown = null;
  interactive = false;
  width = 80;
  height = 25;
  text?: string;
  constructor(
    scene: FakeScene,
    public type: string,
    public x: number,
    public y: number,
    public texture: string | null = null,
    public frame: FakeFrame = standFrame("x"),
  ) {
    super();
    this.scene = scene;
  }
  get rotation(): number {
    return (this.angle * Math.PI) / 180;
  }
  /** 不轉的外框（大廳元件都不轉）。 */
  getBounds(): { x: number; y: number; right: number; bottom: number } {
    const w = this.width * Math.abs(this.scaleX);
    const h = this.height * Math.abs(this.scaleY);
    const x = this.x - this.originX * w;
    const y = this.y - this.originY * h;
    return { x, y, right: x + w, bottom: y + h };
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
  get displayOriginX(): number {
    return this.originX * this.frame.realWidth;
  }
  get displayOriginY(): number {
    return this.originY * this.frame.realHeight;
  }
  setOrigin(x: number, y: number = x): this {
    this.originX = x;
    this.originY = y;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(x: number, y: number = x): this {
    this.scaleX = x;
    this.scaleY = y;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setAngle(a: number): this {
    let d = a % 360;
    if (d <= -180) d += 360;
    if (d > 180) d -= 360;
    this.angle = d;
    return this;
  }
  setFlipX(v: boolean): this {
    this.flipX = v;
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
  setMask(m: unknown): this {
    this.mask = m;
    return this;
  }
  setStroke(): this {
    return this;
  }
  setInteractive(): this {
    this.interactive = true;
    return this;
  }
  setTexture(key: string, frame?: number | string): this {
    this.texture = key;
    if (frame !== undefined) this.frame = { ...this.frame, name: frame };
    return this;
  }
  destroy(): void {
    this.scene?.children.list.splice(this.scene.children.list.indexOf(this), 1);
    this.scene = null;
  }
}

class FakeScene {
  key: string;
  active = true;
  children = { list: [] as FakeObject[] };
  input = Object.assign(new Emitter(), { enabled: true });
  /** Systems.events：每一幀 postupdate（測試裡手動 emit）。 */
  events = new Emitter();
  tweens = {
    added: [] as { targets: FakeObject }[],
    killed: [] as FakeObject[],
    add: (cfg: { targets: FakeObject }) => {
      this.tweens.added.push(cfg);
    },
    killTweensOf: (o: FakeObject) => {
      this.tweens.killed.push(o);
    },
  };
  /** Phaser 的 Clock：測試裡手動跑（runTimers）。 */
  timers: { delay: number; repeat: number; fn: () => void; removed: boolean }[] = [];
  time = {
    addEvent: (cfg: { delay: number; repeat?: number; callback: () => void }) => {
      const t = { delay: cfg.delay, repeat: cfg.repeat ?? 0, fn: cfg.callback, removed: false };
      this.timers.push(t);
      return { remove: () => (t.removed = true) };
    },
    delayedCall: (delay: number, fn: () => void) => {
      const t = { delay, repeat: 0, fn, removed: false };
      this.timers.push(t);
      return { remove: () => (t.removed = true) };
    },
  };
  /** 把排著的計時器全部跑完（repeat 照次數跑）。 */
  runTimers(): void {
    for (let guard = 0; guard < 50 && this.timers.length > 0; guard++) {
      const list = this.timers.splice(0);
      for (const t of list) for (let i = 0; i <= t.repeat && !t.removed; i++) t.fn();
    }
  }
  load = { baseURL: "https://cdn.example/" };
  cache = { json: { get: (k: string) => (k === "Characters" ? CHARACTERS : null) } };
  scene = { isActive: () => this.active };
  add = {
    image: (x: number, y: number, key: string, frame?: string | number) => {
      const o = new FakeObject(this, "Image", x, y, key, standFrame(String(frame ?? key)));
      // 實機量的對話框大小
      if (key === "ulrStandBubble") [o.width, o.height] = [346, 115];
      return this.push(o);
    },
    zone: (x: number, y: number) => this.push(new FakeObject(this, "Zone", x, y)),
    text: (x: number, y: number, text: string) => {
      const o = new FakeObject(this, "Text", x, y);
      o.text = text;
      return this.push(o);
    },
  };
  constructor(key: string) {
    this.key = key;
  }
  push(o: FakeObject): FakeObject {
    this.children.list.push(o);
    return o;
  }
  live(type: string): FakeObject[] {
    return this.children.list.filter((o) => o.scene !== null && o.type === type);
  }
}

const CHARACTERS: Record<string, { id: number }> = {
  cc001: { id: 1 },
  cc005: { id: 5 },
  cc010: { id: 10 },
  cc063: { id: 63 },
};

/** 官方 Lobby：create 時畫 lobby_bg、立繪（-190 起跳、遮罩）、按鈕。 */
class LobbyScene extends FakeScene {
  lobby_chara = "cc063";
  lobby_bg: FakeObject | null = null;
  stand_chara: FakeObject | null = null;
  btn_duel_base: FakeObject | null = null;
  btn_serial: FakeObject | null = null;
  rank_bp_info: FakeObject[] = [];
  mask = { geometryMask: true };
  constructor() {
    super("Lobby");
  }
  create(): void {
    this.children.list = [];
    this.lobby_bg = this.add.image(380, 340, "lobby_bg");
    this.stand_chara = this.add.image(-190, 412, "standchara", this.lobby_chara).setAlpha(0);
    this.stand_chara.setMask(this.mask);
    this.tweens.add({ targets: this.stand_chara });
    // 實機：duel_btn 160×160、origin 左上
    const duel = this.add.image(192, 163, "duel_btn").setOrigin(0, 0).setInteractive();
    duel.width = 160;
    duel.height = 160;
    this.btn_duel_base = duel;
    const serial = this.add.image(756, 200, "btn_serial").setOrigin(1, 0).setInteractive();
    serial.width = 104;
    serial.height = 24;
    this.btn_serial = serial;
    this.rank_bp_info = [this.add.text(264, 466, "10月份排行榜獎勵")];
    this.rank_bp_info[0]!.setOrigin(0, 0);
  }
  /** 跑一幀。 */
  frame(): void {
    this.events.emit("postupdate");
  }
}

/** 官方 Library：Characters 分頁，每列一顆愛心（frame 2 = 已選）。 */
class LibraryScene extends FakeScene {
  chara_favorite: string | null = null;
  chara_card_page = 1;
  chara_card_index = [1, 5, 10, 63];
  chara_card_list: { chara_favorite: FakeObject | null }[] = [];
  category_main = "chara_card";
  refreshed = 0;
  constructor() {
    super("Library");
  }
  show_chara_card(): void {
    this.chara_card_list = this.chara_card_index.map((id, i) => {
      const p = this.add.image(100, 109 + 26 * i, "library_deco", 0).setInteractive();
      const key = Object.keys(CHARACTERS).find((k) => CHARACTERS[k]!.id === id)!;
      // 官方：單選，點了把別列清掉
      p.on("pointerup", () => {
        this.chara_favorite = key;
        p.setTexture("library_deco", 2);
      });
      if (this.chara_favorite === key) p.setTexture("library_deco", 2);
      return { chara_favorite: p };
    });
  }
  refresh(): void {
    this.refreshed++;
    for (const r of this.chara_card_list) r.chara_favorite?.destroy();
    this.show_chara_card();
  }
}

interface FakeWindow {
  game: {
    scene: { keys: Record<string, unknown> };
    textures: { exists: (k: string) => boolean; get: (k: string) => unknown };
    cache: { json: { get: (k: string) => unknown } };
  };
  [key: string]: unknown;
}

/** 測試用的小台詞表：cc063 一般 1 句、對 cc005 說 1 句；cc005 一般 1 句。 */
const DIALOGUE = {
  langs: ["ja", "tcn"],
  lines: {
    "1": ["一般の台詞", "一般台詞"],
    "2": ["利恩へ", "對利恩說的"],
    "3": ["二行目が\nあるよ", ""],
  },
  charas: {
    cc063: { general: [1], vs: { cc005: [2], cc010: [3] } },
    cc005: { general: [3], vs: {} },
  },
};

/** CharaVoice（遊戲快取的 voice）與 Feats 的最小形狀。 */
const VOICE = {
  cc005: [
    { voice: "cc005_dialogue3", data: "Leon_22.mp3" },
    { voice: "cc005_skill1", data: "Leon_16.mp3" },
  ],
};
const FEATS = [
  { id: 1, effect_image: "cc005_sk01", name_tcn: "大地之劍" },
  { id: 2, effect_image: "cc005_sk01_ex", name_tcn: "Ex大地之劍" },
];

const installed: FakeWindow[] = [];

function makeGame(): {
  window: FakeWindow;
  lobby: LobbyScene;
  library: LibraryScene;
  reports: { type: string; [k: string]: unknown }[];
} {
  const lobby = new LobbyScene();
  const library = new LibraryScene();
  library.active = false;
  const reports: { type: string }[] = [];
  const window: FakeWindow = {
    game: {
      scene: { keys: { Lobby: lobby, Library: library } },
      // 立繪與對話框貼圖當作載過了（測試裡沒有 fetch 與 Image）
      textures: {
        exists: (k: string) => k.startsWith("ulrStand_") || k === "ulrStandBubble",
        get: (k: string) => ({ getFrameNames: () => [k.slice("ulrStand_".length)] }),
      },
      cache: {
        json: { get: (k: string) => (k === "voice" ? VOICE : k === "Feats" ? FEATS : null) },
      },
    },
    lang: "tcn",
    // 0 = 不播語音（測試裡沒有 Audio）
    volume_voice: 0,
    __ulrReport: (payload: string) => reports.push(JSON.parse(payload)),
  };
  return { window, lobby, library, reports: reports as never };
}

function run(window: FakeWindow, script: string): string {
  // eslint-disable-next-line no-new-func
  return new Function("window", `return ${script};`)(window) as string;
}

/** 只有一套時的簡寫：`charas`／`layout` 就是第一套。 */
interface StateSugar extends Partial<LobbyStandState> {
  charas?: string[];
  layout?: LobbyStandSet["layout"];
}

function stateOf(s: StateSugar = {}): LobbyStandState {
  return {
    ready: s.ready ?? true,
    sets: s.sets ?? [{ charas: s.charas ?? [], layout: s.layout ?? {} }],
    ui: s.ui ?? {},
  };
}

function install(window: FakeWindow, state: StateSugar = {}): string {
  installed.push(window);
  return run(
    window,
    buildLobbyStandPatchScript({
      bindingName: "__ulrReport",
      state: stateOf(state),
      pollIntervalMs: 60_000,
      dialogue: DIALOGUE,
    }),
  );
}

function tick(window: FakeWindow): void {
  // 腳本的輪詢間隔設很長；直接推一次同樣的狀態就會跑一拍
  const st = window["__ulrLobbyStand"] as { state: LobbyStandState };
  run(window, buildLobbyStandStateExpression(JSON.parse(JSON.stringify(st.state))));
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function pointer(x: number, y: number, opts: { right?: boolean; shift?: boolean } = {}) {
  return {
    worldX: x,
    worldY: y,
    isDown: true,
    event: { shiftKey: opts.shift === true },
    rightButtonDown: () => opts.right === true,
    rightButtonReleased: () => opts.right === true,
  };
}

/** 編輯模式的按鈕：照上面的字找（各排的高度照模式會變）。 */
function editButton(lobby: LobbyScene, label: string): FakeObject {
  const t = lobby.live("Text").find((o) => o.text === label && o.depth > 190)!;
  return lobby
    .live("Image")
    .find((o) => o.texture === "btn_gene" && o.x === t.x - 40 && o.y === t.y - 12.5)!;
}

afterEach(() => {
  for (const w of installed.splice(0)) run(w, LOBBY_STAND_UNINSTALL_EXPRESSION);
});

describe("ready: false", () => {
  it("首頁與 Library 都不動", () => {
    const { window, lobby, library } = makeGame();
    lobby.create();
    library.active = true;
    library.show_chara_card();
    install(window, { ready: false, charas: ["cc005"] });
    expect(lobby.stand_chara!.originX).toBe(0.5);
    expect(lobby.live("Image").filter((o) => o.texture === "ulrStand_cc005")).toHaveLength(0);
    library.chara_card_list[1]!.chara_favorite!.emit("pointerup");
    expect(library.chara_favorite).toBe("cc005"); // 官方 handler 還在
  });
});

describe("首頁", () => {
  it("官方那張：origin 換到人物中心，位置跟官方一樣（沒存過擺法）", () => {
    const { window, lobby } = makeGame();
    lobby.create();
    lobby.stand_chara!.x = 310; // 官方 tween 已經跑完
    lobby.stand_chara!.alpha = 1;
    const status = parseLobbyStandStatus(install(window));
    expect(status).toMatchObject({ installed: true, stands: 1, editing: false });
    const s = lobby.stand_chara!;
    // 可見部分中心：310 − 380 + 25 + 397/2、412 − 340 + 150 + 434/2
    expect(s.originX).toBeCloseTo((25 + 397 / 2) / 760);
    expect(s.originY).toBeCloseTo((150 + 434 / 2) / 680);
    expect(s.x).toBe(Math.round(310 - 380 + 25 + 397 / 2));
    expect(s.y).toBe(412 - 340 + 150 + 217);
    expect(s.alpha).toBe(1);
  });

  it("進首頁（create）時接管官方的進場：殺掉官方 tween、照存的擺法滑進來", () => {
    const { window, lobby } = makeGame();
    install(window, {
      layout: { cc063: { x: 400, y: 300, scale: 0.8, angle: 10, flip: true, z: 0 } },
    });
    tick(window); // 看到 Lobby 實例 → 包 create
    lobby.create();
    const s = lobby.stand_chara!;
    expect(lobby.tweens.killed).toContain(s);
    // 翻轉過的（臉朝左）從右邊滑進來
    expect(s.x).toBe(400 + 500);
    expect(s.alpha).toBe(0);
    expect(lobby.tweens.added.some((t) => t.targets === s && (t as never)["x"] === 400)).toBe(true);
    // 翻轉是負的 scaleX（flipX 會繞整張畫布翻，人跑掉）
    expect([s.y, s.scaleX, s.scaleY, s.angle, s.flipX]).toEqual([300, -0.8, 0.8, 10, false]);
  });

  it("沒翻轉的照官方從左邊滑進來", () => {
    const { window, lobby } = makeGame();
    install(window, {
      layout: { cc063: { x: 400, y: 300, scale: 0.8, angle: 0, flip: false, z: 0 } },
    });
    tick(window);
    lobby.create();
    const s = lobby.stand_chara!;
    expect(s.x).toBe(400 - 500);
    expect(lobby.tweens.added.some((t) => t.targets === s && (t as never)["x"] === 400)).toBe(true);
  });

  it("存過的擺法超出畫面：人物中心拉回遮罩範圍內", () => {
    const { window, lobby } = makeGame();
    lobby.create();
    install(window, {
      layout: { cc063: { x: 1100, y: -300, scale: 1, angle: 0, flip: false, z: 0 } },
    });
    const s = lobby.stand_chara!;
    expect([s.x, s.y]).toEqual([760, 160]);
  });

  it("多出來的立繪：共用遮罩、排在 lobby_bg 正上方、照 z 疊", async () => {
    const { window, lobby } = makeGame();
    lobby.create();
    install(window, {
      charas: ["cc063", "cc005", "cc010"],
      layout: { cc005: { x: 500, y: 450, scale: 1, angle: 0, flip: false, z: -1 } },
    });
    await flush();
    const list = lobby.children.list;
    const extras = list.filter((o) => o.texture?.startsWith("ulrStand_"));
    expect(extras.map((o) => o.texture)).toEqual(["ulrStand_cc005", "ulrStand_cc010"]);
    for (const e of extras) expect(e.mask).toBe(lobby.mask);
    // lobby_bg、cc005(z -1)、官方(z 0)、cc010(z 2)、然後才是按鈕
    expect(list.slice(0, 5).map((o) => o.texture)).toEqual([
      "lobby_bg",
      "ulrStand_cc005",
      "standchara",
      "ulrStand_cc010",
      "duel_btn",
    ]);
    expect(parseLobbyStandStatus(run(window, LOBBY_STAND_STATUS_EXPRESSION)).stands).toBe(3);
  });

  it("清單少了一個：那張拿掉", async () => {
    const { window, lobby } = makeGame();
    lobby.create();
    install(window, { charas: ["cc005", "cc010"] });
    await flush();
    run(window, buildLobbyStandStateExpression(stateOf({ charas: ["cc010"] })));
    await flush();
    const extras = lobby.live("Image").filter((o) => o.texture?.startsWith("ulrStand_"));
    expect(extras.map((o) => o.texture)).toEqual(["ulrStand_cc010"]);
  });
});

describe("編輯模式", () => {
  async function editing() {
    const g = makeGame();
    g.lobby.create();
    g.lobby.stand_chara!.x = 310;
    // 多的那張擺遠一點：測試裡讀不到 alpha，點中與否只看外框
    install(g.window, {
      charas: ["cc063", "cc005"],
      layout: { cc005: { x: 650, y: 300, scale: 1, angle: 0, flip: false, z: 1 } },
    });
    await flush();
    const zone = (): FakeObject | undefined => g.lobby.live("Zone")[0];
    return { ...g, zone };
  }

  it("右鍵點在按鈕上不進；點在空白處才進，畫出 Reset／OK", async () => {
    const { lobby, zone } = await editing();
    const btn = lobby.live("Image").find((o) => o.texture === "duel_btn")!;
    lobby.input.emit("pointerdown", pointer(192, 163, { right: true }), [btn]);
    expect(zone()).toBeUndefined();
    lobby.input.emit("pointerdown", pointer(600, 300), []); // 左鍵不算
    expect(zone()).toBeUndefined();
    lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    expect(zone()).toBeDefined();
    expect(lobby.live("Text").map((t) => t.text)).toEqual(expect.arrayContaining(["Reset", "OK"]));
  });

  it("拖曳、滾輪縮放、Shift＋滾輪旋轉（deltaX）、右鍵翻轉，OK 回報並離開", async () => {
    const { lobby, zone, reports } = await editing();
    lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    const s = lobby.stand_chara!;
    const z = zone()!;

    z.emit("pointerdown", pointer(s.x, s.y));
    z.emit("pointermove", pointer(s.x + 40, s.y - 10));
    lobby.input.emit("pointerup");
    expect([s.x, s.y]).toEqual([154 + 40, 439 - 10]);

    z.emit("wheel", pointer(s.x, s.y), 0, -100, 0);
    expect(s.scaleX).toBeCloseTo(1.05);
    z.emit("wheel", pointer(s.x, s.y, { shift: true }), 100, 0, 0);
    expect(s.angle).toBe(3);
    z.emit("pointerdown", pointer(s.x, s.y, { right: true }));
    expect([s.scaleX, s.scaleY, s.flipX]).toEqual([-s.scaleY, s.scaleY, false]);

    const ok = editButton(lobby, "OK");
    ok.emit("pointerup", pointer(0, 0));
    expect(zone()).toBeUndefined();
    const r = reports.find((x) => x.type === "lobby-stand-sets") as never as {
      sets: LobbyStandSet[];
    };
    const layout = r.sets[0]!.layout;
    expect(layout.cc063).toMatchObject({ x: 194, scale: 1.05, angle: 3, flip: true });
    expect(Object.keys(layout).sort()).toEqual(["cc005", "cc063"]);
    expect(isLobbyStandReport(r)).toBe(true);
  });

  it("翻轉、縮放、轉過之後點人物本身點得中（負 scaleX 的反轉換）", async () => {
    const { lobby, zone } = await editing();
    lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    const s = lobby.stand_chara!;
    const z = zone()!;
    z.emit("pointerdown", pointer(s.x, s.y, { right: true })); // 翻
    z.emit("wheel", pointer(s.x, s.y), 0, 100, 0); // 縮
    z.emit("wheel", pointer(s.x, s.y, { shift: true }), 0, 100, 0); // 轉
    z.emit("pointerdown", pointer(0, 0)); // 點空白：取消選取
    // 人物可見部分的右緣附近（翻過之後在左邊）：397 寬的框，中心往左 180 還在框裡
    const r = (s.angle * Math.PI) / 180;
    const k = Math.abs(s.scaleX) * 180;
    z.emit("pointerdown", pointer(s.x - k * Math.cos(r), s.y - k * Math.sin(r)));
    const extra = lobby.children.list.find((o) => o.texture === "ulrStand_cc005")!;
    expect(extra.alpha).toBeLessThan(1); // 選中的是官方那張，另一張調暗
    expect(s.alpha).toBe(1);
  });

  it("編輯時藏起大廳按鈕，離開時還原；藏之前就隱藏的不動", async () => {
    const { lobby, zone } = await editing();
    const btn = lobby.live("Image").find((o) => o.texture === "duel_btn")!;
    const hiddenBefore = lobby.add.image(10, 10, "already_hidden");
    hiddenBefore.visible = false;
    lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    expect(btn.visible).toBe(false);
    expect(lobby.lobby_bg!.visible).toBe(true);
    expect(lobby.stand_chara!.visible).toBe(true);
    expect(zone()!.visible).toBe(true);
    expect(lobby.rank_bp_info[0]!.visible).toBe(false);
    expect(
      lobby
        .live("Text")
        .filter((t) => t.depth > 190)
        .every((t) => t.visible),
    ).toBe(true);
    const ok = editButton(lobby, "OK");
    ok.emit("pointerup", pointer(0, 0));
    expect(btn.visible).toBe(true);
    expect(lobby.rank_bp_info[0]!.visible).toBe(true);
    expect(hiddenBefore.visible).toBe(false);
  });

  it("點了只選不改圖層；Front／Back 調圖層；Reset 只回復選中的那張", async () => {
    const { lobby, zone } = await editing();
    lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    const s = lobby.stand_chara!;
    const z = zone()!;
    const list = lobby.children.list;
    const extra = list.find((o) => o.texture === "ulrStand_cc005")!;
    z.emit("pointerdown", pointer(s.x, s.y));
    lobby.input.emit("pointerup");
    expect(list.indexOf(s)).toBeLessThan(list.indexOf(extra));
    expect(extra.alpha).toBeLessThan(1); // 沒選中的調暗
    const btn = (label: string) => editButton(lobby, label);
    btn("Front").emit("pointerup", pointer(0, 0)); // Front
    expect(list.indexOf(s)).toBeGreaterThan(list.indexOf(extra));
    btn("Back").emit("pointerup", pointer(0, 0)); // Back
    expect(list.indexOf(s)).toBeLessThan(list.indexOf(extra));
    expect(list.indexOf(s)).toBe(list.indexOf(lobby.lobby_bg!) + 1);

    z.emit("wheel", pointer(s.x, s.y), 0, -100, 0);
    const extraScale = extra.scaleX;
    const reset = editButton(lobby, "Reset");
    reset.emit("pointerup", pointer(0, 0));
    expect(s.scaleX).toBe(1);
    expect(extra.scaleX).toBe(extraScale);
  });
});

describe("大廳元件", () => {
  async function editingUi() {
    const g = makeGame();
    g.lobby.create();
    install(g.window, { charas: ["cc063"] });
    await flush();
    g.lobby.input.emit("pointerdown", pointer(600, 300, { right: true }), []);
    const btn = (label: string) => editButton(g.lobby, label);
    btn("UI").emit("pointerup", pointer(0, 0)); // [UI]
    const zone = g.lobby.live("Zone")[0]!;
    return { ...g, btn, zone };
  }

  it("切到 UI：大廳元件叫回來、Front／Back 收起來、字換成 Chara", async () => {
    const { lobby, btn } = await editingUi();
    expect(lobby.btn_duel_base!.visible).toBe(true);
    expect(btn("Front").visible).toBe(false);
    expect(btn("Back").visible).toBe(false);
    expect(lobby.live("Text").map((t) => t.text)).toContain("Chara");
  });

  it("按鈕擺位：編輯立繪放頂端黑色區域；編輯 UI 放回標題帶下面、說明緊接第一排", async () => {
    const { lobby, btn } = await editingUi();
    const hint = (): FakeObject =>
      lobby.live("Text").find((t) => t.depth > 190 && t.text?.includes("Wheel"))!;
    expect(btn("OK").y).toBe(166);
    expect(hint().y).toBe(196); // 不留套組那排的空位
    btn("Chara").emit("pointerup", pointer(0, 0));
    expect(btn("OK").y).toBe(42);
    expect(btn("Next").y).toBe(72);
    expect(hint().y).toBe(104);
    expect(hint().y + 16).toBeLessThan(160); // 整塊在立繪遮罩上面
  });

  it("拖曳移動整組、滾輪繞組中心縮放、右鍵隱藏；OK 回報整份並照存的擺", async () => {
    const { lobby, zone, btn, reports } = await editingUi();
    const duel = lobby.btn_duel_base!;
    zone.emit("pointerdown", pointer(272, 243)); // 圓心
    zone.emit("pointermove", pointer(272 + 300, 243 - 60));
    lobby.input.emit("pointerup");
    lobby.frame();
    expect([duel.x, duel.y]).toEqual([192 + 300, 163 - 60]);

    zone.emit("wheel", pointer(572, 183), 0, 100, 0); // 縮小
    lobby.frame();
    const s = 1 / 1.05;
    expect(duel.scaleX).toBeCloseTo(s);
    // 繞官方外框中心 (272, 243) 縮放，再加位移
    expect(duel.x).toBeCloseTo(272 + (192 - 272) * s + 300);

    // 序號鈕：右鍵藏，編輯中半透明還點得到
    const serial = lobby.btn_serial!;
    zone.emit("pointerdown", pointer(700, 210, { right: true }));
    lobby.frame();
    expect(serial.visible).toBe(true);
    expect(serial.alpha).toBeCloseTo(0.3);

    btn("OK").emit("pointerup", pointer(0, 0)); // OK
    const r = reports.find((x) => x.type === "lobby-stand-sets") as never as {
      ui: Record<string, { x: number; y: number; scale: number; hidden: boolean }>;
    };
    expect(r.ui).toEqual({
      duel: { x: 300, y: -60, scale: Math.round(s * 1000) / 1000, hidden: false },
      serial: { x: 0, y: 0, scale: 1, hidden: true },
    });
    expect(isLobbyStandReport(r)).toBe(true);
    lobby.frame();
    expect(serial.visible).toBe(false);
    expect(serial.alpha).toBe(1);
    // 存下來的縮放取到小數三位
    const saved = Math.round(s * 1000) / 1000;
    expect(duel.x).toBeCloseTo(272 + (192 - 272) * saved + 300);
  });

  it("官方自己改的值當新的官方值（refresh_ranking 切 visible、換頁重建）", async () => {
    const { window, lobby } = await editingUi();
    run(window, LOBBY_STAND_UNINSTALL_EXPRESSION);
    installed.length = 0;
    install(window, {
      charas: ["cc063"],
      ui: { notice: { x: 10, y: 0, scale: 1, hidden: false } },
    });
    const notice = lobby.rank_bp_info[0]!;
    lobby.frame();
    expect(notice.x).toBe(274);
    notice.visible = false; // 官方切到 QP 分頁
    lobby.frame();
    expect(notice.visible).toBe(false);
    notice.visible = true;
    lobby.frame();
    expect(notice.visible).toBe(true);
    // 官方重建：新物件也認得出來
    const fresh = lobby.add.text(264, 466, "11月");
    fresh.setOrigin(0, 0);
    lobby.rank_bp_info = [fresh];
    lobby.frame();
    expect(fresh.x).toBe(274);
  });

  it("沒按 OK 就離開：草稿丟掉；拆掉：全部放回官方原樣", async () => {
    const { window, lobby, zone } = await editingUi();
    const duel = lobby.btn_duel_base!;
    zone.emit("pointerdown", pointer(272, 243, { right: true }));
    lobby.frame();
    run(window, buildLobbyStandStateExpression(stateOf({ ready: false })));
    expect([duel.x, duel.y, duel.scaleX, duel.visible, duel.alpha]).toEqual([192, 163, 1, true, 1]);
    expect(lobby.events.count("postupdate")).toBe(0);
  });
});

describe("套組", () => {
  const shownTextures = (lobby: LobbyScene): string[] =>
    lobby
      .live("Image")
      .filter(
        (o) => o.texture?.startsWith("ulrStand_") || (o.texture === "standchara" && o.visible),
      )
      .map((o) => String(o.texture));

  it("官方最愛不在這套裡就藏起來；空的那套照官方畫", async () => {
    const { window, lobby } = makeGame();
    lobby.create();
    install(window, { charas: ["cc005"] });
    await flush();
    expect(lobby.stand_chara!.visible).toBe(false);
    expect(shownTextures(lobby)).toEqual(["ulrStand_cc005"]);
    run(window, buildLobbyStandStateExpression(stateOf({ charas: [] })));
    await flush();
    expect(lobby.stand_chara!.visible).toBe(true);
    expect(shownTextures(lobby)).toEqual(["standchara"]);
  });

  it("每次進首頁從有角色的那幾套隨機挑、不連續同一套、空的不挑", async () => {
    const { window, lobby } = makeGame();
    install(window, {
      sets: [
        { charas: ["cc005"], layout: {} },
        { charas: [], layout: {} },
        { charas: ["cc010"], layout: {} },
      ],
    });
    tick(window); // 包 create
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      lobby.create();
      await flush();
      seen.push((window["__ulrLobbyStand"] as { cur: number }).cur);
    }
    expect(new Set(seen)).toEqual(new Set([0, 2]));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("Library 剛改過的那套，回首頁先畫它一次", async () => {
    const { window, lobby, library } = makeGame();
    install(window, {
      sets: [
        { charas: ["cc005"], layout: {} },
        { charas: ["cc010"], layout: {} },
      ],
    });
    tick(window);
    lobby.create();
    const st = window["__ulrLobbyStand"] as { cur: number };
    const first = st.cur;
    lobby.active = false;
    library.active = true;
    library.show_chara_card();
    library.chara_card_list[0]!.chara_favorite!.emit("pointerup"); // cc001 加進這套
    library.active = false;
    lobby.active = true;
    lobby.create();
    expect(st.cur).toBe(first);
    lobby.create();
    expect(st.cur).not.toBe(first);
  });

  async function editingSets() {
    const g = makeGame();
    g.lobby.create();
    install(g.window, {
      sets: [
        {
          charas: ["cc005"],
          layout: { cc005: { x: 500, y: 400, scale: 1, angle: 0, flip: false, z: 0 } },
        },
        { charas: ["cc010"], layout: {} },
      ],
    });
    await flush();
    g.lobby.input.emit("pointerdown", pointer(700, 600, { right: true }), []);
    const btn = (label: string) => editButton(g.lobby, label);
    const label = () => g.lobby.live("Text").find((t) => t.text?.startsWith("Set "))!.text;
    return { ...g, btn, label, zone: g.lobby.live("Zone")[0]! };
  }

  it("編輯中 Next／New／Del 換畫哪一套；OK 存整份（各套擺法各自記）", async () => {
    const { lobby, btn, label, zone, reports } = await editingSets();
    expect(label()).toBe("Set 1/2");
    const cc005 = lobby.live("Image").find((o) => o.texture === "ulrStand_cc005")!;
    zone.emit("pointerdown", pointer(cc005.x, cc005.y));
    zone.emit("pointermove", pointer(cc005.x - 100, cc005.y));
    lobby.input.emit("pointerup");

    btn("Next").emit("pointerup", pointer(0, 0)); // Next
    await flush();
    expect(label()).toBe("Set 2/2");
    expect(shownTextures(lobby)).toEqual(["ulrStand_cc010"]);

    btn("New").emit("pointerup", pointer(0, 0)); // New
    expect(label()).toBe("Set 3/3");
    expect(shownTextures(lobby)).toEqual(["standchara"]); // 空的照官方

    btn("Del").emit("pointerup", pointer(0, 0)); // Del
    expect(label()).toBe("Set 2/2");

    btn("Prev").emit("pointerup", pointer(0, 0)); // Prev
    await flush();
    expect(label()).toBe("Set 1/2");
    const back = lobby.live("Image").find((o) => o.texture === "ulrStand_cc005")!;
    expect(back.x).toBe(400); // 換回來，剛才拖的還在

    btn("OK").emit("pointerup", pointer(0, 0)); // OK
    const r = reports.find((x) => x.type === "lobby-stand-sets") as never as {
      sets: LobbyStandSet[];
    };
    expect(r.sets.map((s) => s.charas)).toEqual([["cc005"], ["cc010"]]);
    expect(r.sets[0]!.layout.cc005).toMatchObject({ x: 400, y: 400 });
    expect(r.sets[1]!.layout.cc010).toBeDefined();
    expect(isLobbyStandReport(r)).toBe(true);
  });

  it("沒按 OK 就離開：新增、刪除、換套都不算", async () => {
    const { window, lobby, btn } = await editingSets();
    btn("Del").emit("pointerup", pointer(0, 0)); // Del 第一套
    run(window, buildLobbyStandStateExpression(stateOf({ ready: false })));
    const st = window["__ulrLobbyStand"] as { state: LobbyStandState };
    expect(st.state.sets).toHaveLength(1); // ready:false 推來的那份，不是草稿
    expect(lobby.stand_chara!.visible).toBe(true);
  });
});

describe("點立繪說話", () => {
  async function onStage() {
    const g = makeGame();
    g.lobby.create();
    g.lobby.stand_chara!.x = 310;
    install(g.window, {
      charas: ["cc063", "cc005"],
      layout: { cc005: { x: 650, y: 300, scale: 1, angle: 0, flip: false, z: 1 } },
    });
    await flush();
    // 多的那張是滑進來的（x − 500 起跳），假場景的 tween 不會跑：直接放到終點
    g.lobby.live("Image").find((o) => o.texture === "ulrStand_cc005")!.x = 650;
    const click = async (x: number, y: number, over: FakeObject[] = []) => {
      g.lobby.input.emit("pointerdown", pointer(x, y), over);
      await flush();
    };
    const bubble = () => g.lobby.live("Image").find((o) => o.texture === "ulrStandBubble");
    const said = () =>
      g.lobby
        .live("Text")
        .filter((t) => t.depth === 180)
        .map((t) => t.text);
    return { ...g, click, bubble, said };
  }

  it("左鍵點立繪：一般台詞＋對同台角色說的（不在場的不說），字一個一個打完；不連說同一句", async () => {
    const { lobby, click, bubble, said } = await onStage();
    const s = lobby.stand_chara!;
    const heard = new Set<string>();
    let last = "";
    for (let i = 0; i < 6; i++) {
      await click(s.x, s.y);
      expect(bubble()).toBeDefined();
      expect(said()).toEqual([""]); // 還沒開始打字
      // 跑完打字（不含收尾的淡出計時）
      const typing = lobby.timers.filter((t) => t.repeat > 0);
      for (const t of typing) for (let k = 0; k <= t.repeat; k++) t.fn();
      const line = said().join("");
      expect(line).not.toBe(last);
      heard.add(line);
      last = line;
    }
    expect(heard).toEqual(new Set(["一般台詞", "對利恩說的"]));
  });

  it("沒有翻譯就退回日文、有換行拆兩行；招式語音的字幕是招式名", async () => {
    const { lobby, click, said } = await onStage();
    const heard = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await click(650, 300);
      lobby.runTimers();
      heard.add(JSON.stringify(said()));
      await click(0, 0); // 點空白：不說話，也不影響下一句
    }
    expect(heard).toEqual(
      new Set([JSON.stringify(["二行目が", "あるよ"]), JSON.stringify(["大地之劍"])]),
    );
  });

  it("點到按鈕不說話；右鍵進編輯時對話框收掉", async () => {
    const { lobby, click, bubble } = await onStage();
    const s = lobby.stand_chara!;
    await click(s.x, s.y, [lobby.btn_duel_base!]);
    expect(bubble()).toBeUndefined();
    await click(s.x, s.y);
    expect(bubble()).toBeDefined();
    lobby.input.emit("pointerdown", pointer(5, 600, { right: true }), []);
    expect(bubble()).toBeUndefined();
    expect(lobby.live("Zone")).toHaveLength(1);
  });
});

describe("Library 愛心複選", () => {
  function open(state: StateSugar = {}, fav: string | null = null) {
    const g = makeGame();
    g.lobby.active = false;
    g.library.active = true;
    g.library.chara_favorite = fav;
    install(g.window, state);
    g.library.show_chara_card(); // 已經包好 → 重畫完就改裝
    return g;
  }
  const heart = (lib: LibraryScene, i: number): FakeObject =>
    lib.chara_card_list[i]!.chara_favorite!;

  it("可以標好幾個、取消；官方最愛（sc.chara_favorite）一律不動", () => {
    const { library, reports } = open({}, "cc063");
    heart(library, 1).emit("pointerup");
    heart(library, 2).emit("pointerup");
    expect([heart(library, 1).frame.name, heart(library, 2).frame.name]).toEqual([2, 2]);
    expect(library.chara_favorite).toBe("cc063");
    expect(reports.at(-1)).toEqual({
      type: "lobby-stand-sets",
      sets: [{ charas: ["cc005", "cc010"], layout: {} }],
    });
    expect(isLobbyStandReport(reports.at(-1))).toBe(true);

    heart(library, 1).emit("pointerup");
    heart(library, 2).emit("pointerup");
    expect(library.chara_favorite).toBe("cc063");
    expect(reports.at(-1)).toEqual({
      type: "lobby-stand-sets",
      sets: [{ charas: [], layout: {} }],
    });
  });

  it("伺服器上的最愛不會被自動加進清單", () => {
    const { reports, library } = open({ charas: ["cc005"] }, "cc063");
    expect(reports).toEqual([]);
    expect(String(heart(library, 3).frame.name)).toBe("0");
    expect(heart(library, 1).frame.name).toBe(2);
  });

  it("改的是首頁上次畫的那一套，其他套不動", () => {
    const sets = [
      { charas: ["cc001"], layout: {} },
      { charas: ["cc005"], layout: {} },
    ];
    const { window, library, reports } = open({ sets });
    (window["__ulrLobbyStand"] as { cur: number }).cur = 1;
    library.show_chara_card();
    expect(String(heart(library, 0).frame.name)).toBe("0");
    expect(heart(library, 1).frame.name).toBe(2);
    heart(library, 2).emit("pointerup");
    expect(reports.at(-1)).toEqual({
      type: "lobby-stand-sets",
      sets: [sets[0], { charas: ["cc005", "cc010"], layout: {} }],
    });
  });

  it("清單被托盤改了（雲端同步）：愛心跟著換", () => {
    const { window, library } = open({ charas: ["cc005"] });
    run(window, buildLobbyStandStateExpression(stateOf({ charas: ["cc010"] })));
    expect([heart(library, 1).frame.name, heart(library, 2).frame.name]).toEqual([0, 2]);
  });
});

describe("拆掉", () => {
  it("官方那張放回原位、多的拿掉、包住的方法還回去、Library 叫官方重畫", async () => {
    const { window, lobby, library } = makeGame();
    lobby.create();
    install(window, { charas: ["cc005"] });
    await flush();
    library.active = true;
    library.show_chara_card();
    tick(window);
    expect(Object.prototype.hasOwnProperty.call(lobby, "create")).toBe(true);

    run(window, LOBBY_STAND_UNINSTALL_EXPRESSION);
    installed.length = 0;
    const s = lobby.stand_chara!;
    expect([s.originX, s.x, s.y, s.scaleX, s.angle]).toEqual([0.5, 310, 412, 1, 0]);
    expect(lobby.live("Image").some((o) => o.texture === "ulrStand_cc005")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(lobby, "create")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(library, "show_chara_card")).toBe(false);
    expect(library.refreshed).toBe(1);
    expect(lobby.input.count("pointerdown")).toBe(0);
  });
});

describe("isLobbyStandReport", () => {
  it("角色鍵、擺法、套數都要像樣", () => {
    const L = { x: 1, y: 2, scale: 1, angle: 0, flip: false, z: 0 };
    const sets = (s: unknown): unknown => ({ type: "lobby-stand-sets", sets: s });
    expect(isLobbyStandReport(sets([{ charas: ["cc001"], layout: { cc001: L } }]))).toBe(true);
    expect(isLobbyStandReport(sets([{ charas: ["x"], layout: {} }]))).toBe(false);
    expect(isLobbyStandReport(sets([{ charas: [], layout: { cc001: { ...L, x: "1" } } }]))).toBe(
      false,
    );
    expect(isLobbyStandReport(sets([{ charas: [], layout: { bad: L } }]))).toBe(false);
    expect(
      isLobbyStandReport(sets(Array.from({ length: 11 }, () => ({ charas: [], layout: {} })))),
    ).toBe(false);
    expect(isLobbyStandReport({ type: "lobby-stand-charas", charas: ["cc001"] })).toBe(false);
  });
});
