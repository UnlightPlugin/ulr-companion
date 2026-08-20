/**
 * 迪特赫姆的快速比賽補丁
 *
 * 跟 `patch-stage.test.ts` 同一種寫法：搭一個假的遊戲（Match 場景、duel 頻道
 * 面板、按鈕類別、遊戲自己的人數模板），把 `buildLobbyPatchScript()` 產出來的
 * **那一串字**原封不動 `new Function` 起來跑。
 *
 * ⚠ **不要改成「重寫一份等價的實作再測」。** 這支補丁的坑全部在「跟遊戲的形狀
 * 對不對得上」，而其中三個只有跑真的字串才抓得到：
 *
 * 1. 腳本整個住在 template literal 裡 —— **跳脫少一層就是語法錯誤**
 *    （`\\n` 寫成 `\n` 的話字串裡會出現真的換行，整支腳本掛掉）
 * 2. 按鈕位置是**從 room_btn 算的**，不是寫死座標
 * 3. 人數那幾行填的是**遊戲自己的模板**，欄位名一個字都不能差
 */

import { describe, expect, it } from "vitest";
import {
  buildLobbyErrorExpression,
  buildLobbyPatchScript,
  buildLobbyStateExpression,
  LOBBY_STATUS_EXPRESSION,
  LOBBY_UNINSTALL_EXPRESSION,
  parseLobbyStatus,
  ROOM_ERROR_DECK_INVALID,
} from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

/** 官方模板，**逐字照抄** 2026-08-18 讀到的 `PLAYER_COUNT.tcn`。 */
const PLAYER_COUNT_TCN = [
  "__NAME__:__CHANNEL__登入 [參加人數:__LENGTH__]",
  "COST__COST1__:__LENGTH1__位玩家等待中。\nCOST__COST2__:__LENGTH2__位玩家等待中。\nCOST__COST3__:__LENGTH3__位玩家等待中。\nCOST90+:__LENGTH4__位玩家等待中。",
];

const ROOM_ERROR_TCN = [
  "發生錯誤 (--CODE--)",
  "牌組與規定不合，無法創建房間。",
  "因為懲罰，而無法創建對戰室",
  "因為懲罰，而無法進入對戰室",
  "AP不足",
  "這間對戰房間為朋友限定。",
  "密碼不對。",
  "這個牌組不符合遊戲規則",
];

interface FakeObject {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  texture?: { key: string };
  frame?: string;
  text?: string;
  depth?: number;
  scene?: object;
  destroyed?: boolean;
  handlers?: Record<string, (() => void)[]>;
  [key: string]: unknown;
}

function makeText(x: number, y: number, value: string): FakeObject {
  const o: FakeObject = {
    type: "Text",
    x,
    y,
    width: 0,
    // 高度隨行數變 —— 狀態那一行要接在人數底下，行數算錯就會疊字。
    height: value === "" ? 0 : value.split("\n").length * 18,
    text: value,
    scene: {},
    setOrigin: () => o,
    setText: (t: string) => {
      o.text = t;
      o.height = t === "" ? 0 : t.split("\n").length * 18;
      return o;
    },
    setPosition: (px: number, py: number) => {
      o.x = px;
      o.y = py;
      return o;
    },
    // 等待視窗的每一個字都是 `setOrigin(...).setAlpha(0)` 建的（原版的波浪動畫）。
    setAlpha: (a: number) => {
      o["alpha"] = a;
      return o;
    },
    destroy: () => {
      o.destroyed = true;
      delete o["scene"];
    },
  };
  return o;
}

/** 遊戲自己的按鈕類別（`o.ae`）。⚠ 它在 constructor 裡就把自己加進場景。 */
class FakeButton {
  type = "Sprite";
  width = 135;
  height = 30;
  texture: { key: string };
  frame: string;
  scene: object | undefined;
  destroyed = false;
  #handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  constructor(
    scene: { add: { existing: (o: unknown) => void } },
    public x: number,
    public y: number,
    key: string,
    options: { frames?: { default?: string; over?: string } } = {},
  ) {
    this.texture = { key };
    this.frame = options.frames?.default ?? "0";
    this.scene = scene;
    scene.add.existing(this);
  }
  on(event: string, handler: (...args: unknown[]) => void): this {
    (this.#handlers[event] ??= []).push(handler);
    return this;
  }
  click(): void {
    for (const h of this.#handlers["click"] ?? []) h();
  }
  destroy(): void {
    this.destroyed = true;
    this.scene = undefined;
  }
}

interface FakePanel {
  list: unknown[];
  room_btn?: FakeButton;
  quick_btn?: FakeButton;
  player_count: FakeObject;
  /** 「1 / 1」那一格。**面板的中線就是拿它量的**（實測 x=185）。 */
  room_page_text?: FakeObject;
  scene: object | undefined;
  constructor: unknown;
  add(items: unknown[]): void;
}

interface FakeWindow {
  game: {
    scene: { keys: Record<string, unknown> };
  };
  lang: string;
  [key: string]: unknown;
}

interface FakeTimer {
  removed: boolean;
  fire(): void;
}

interface FakeGame {
  window: FakeWindow;
  scene: Record<string, unknown>;
  panel: FakePanel | undefined;
  /** 換一個新的面板（＝玩家換頻道）。 */
  enterChannel(channel: number): void;
  leaveChannel(): void;
  reports: { type: string; [k: string]: unknown }[];
  /** 直接加進場景（不是面板）的東西 —— 等待視窗就是這樣掛的。 */
  sceneObjects: FakeObject[];
  /** `scene.time.addEvent()` 開出來的計時器。收乾淨了沒要靠它驗。 */
  timers: FakeTimer[];
}

/** duel 面板的基底類別 —— `PLAYER_COUNT` 是這一層的 static。 */
class FakePanelBase {
  static PLAYER_COUNT: Record<string, string[]> = { tcn: PLAYER_COUNT_TCN };
}
class FakeDuelPanel extends FakePanelBase {}
class FakeRankedPanel extends FakePanelBase {}

function makeGame(options: { channel?: number; ranked?: boolean } = {}): FakeGame {
  const reports: { type: string; [k: string]: unknown }[] = [];
  const created: unknown[] = [];
  const sceneObjects: FakeObject[] = [];
  const timers: FakeTimer[] = [];

  const scene: Record<string, unknown> = {
    // 等待視窗那句話是從場景的 static 讀的（`Match.WAIT_TEXT`）。
    constructor: { WAIT_TEXT: { tcn: "正在等待對手加入..." } },
    channels: { "1": { type: "ranked", cost: [54, 61, 77] }, "2": { type: "duel" } },
    channels_cross: { "3": { type: "ranked", cost: [58, 67, 75] }, "4": { type: "duel" } },
    channel: undefined,
    channel_panel: undefined,
    room_error: { tcn: ROOM_ERROR_TCN },
    ulse01: { play: () => undefined },
    scale: { width: 1150, height: 1050 },
    textures: {
      exists: (key: string) => key === "match_quick_btn" || key === "match_roommake_btn",
    },
    time: {
      addEvent: (cfg: { callback: () => void }): FakeTimer => {
        const timer: FakeTimer = {
          removed: false,
          fire: () => cfg.callback(),
        };
        (timer as { remove?: () => void }).remove = () => {
          timer.removed = true;
        };
        timers.push(timer);
        return timer;
      },
    },
    tweens: { killTweensOf: () => undefined },
    add: {
      existing: (o: unknown) => created.push(o),
      text: (x: number, y: number, value: string) => {
        const t = makeText(x, y, value);
        sceneObjects.push(t);
        return t;
      },
      nineslice: (x: number, y: number, key: string) => {
        const o = makeText(x, y, "");
        o.type = "NineSlice";
        o.texture = { key };
        sceneObjects.push(o);
        return o;
      },
      container: () => {
        const items: unknown[] = [];
        const o = makeText(0, 0, "");
        o.type = "Container";
        (o as { add?: (list: unknown[]) => unknown }).add = (list: unknown[]) => {
          items.push(...list);
          return o;
        };
        (o as { setDepth?: (d: number) => unknown }).setDepth = (d: number) => {
          o.depth = d;
          return o;
        };
        (o as { items?: unknown[] }).items = items;
        sceneObjects.push(o);
        return o;
      },
      tween: () => undefined,
      zone: (x: number, y: number, w: number, h: number) => {
        const o = makeText(x, y, "");
        o.type = "Zone";
        o.width = w;
        o.height = h;
        (o as { setInteractive?: () => unknown }).setInteractive = () => o;
        (o as { setDepth?: (d: number) => unknown }).setDepth = (d: number) => {
          o.depth = d;
          return o;
        };
        return o;
      },
      rectangle: (x: number, y: number, _w: number, _h: number) => {
        const o = makeText(x, y, "");
        o.type = "Rectangle";
        (o as { setDepth?: (d: number) => unknown }).setDepth = (d: number) => {
          o.depth = d;
          return o;
        };
        return o;
      },
    },
  };
  // `setOrigin` 在 zone/rectangle 上是鏈式的，makeText 已經有了。

  const window: FakeWindow = {
    game: { scene: { keys: { Match: scene } } },
    lang: "tcn",
  };

  const game: FakeGame = {
    window,
    scene,
    panel: undefined,
    reports,
    sceneObjects,
    timers,
    enterChannel(channel: number) {
      const ranked = options.ranked === true;
      const list: unknown[] = [];
      const panel: FakePanel = {
        list,
        player_count: makeText(10, 470, "玩家:迪特赫姆登入 [參加人數:22]"),
        // ⚠ 座標照抄 2026-08-19 從跑著的客戶端量到的：面板內容是 0…370，
        // 這一格置中在 185。按鈕的對稱位置就是拿它算的。
        room_page_text: makeText(185, 407, "1 / 1"),
        scene: {},
        constructor: ranked ? FakeRankedPanel : FakeDuelPanel,
        add(items: unknown[]) {
          list.push(...items);
        },
      };
      const btn = new FakeButton(scene as never, 296.5, 434, "match_roommake_btn", {
        frames: { default: "tcn_1" },
      });
      if (ranked) panel.quick_btn = btn;
      else panel.room_btn = btn;
      list.push(btn, panel.player_count);
      // ⚠ prototype 要對：補丁是從 `room_btn` 的 prototype 拿按鈕類別的。
      Object.setPrototypeOf(panel, ranked ? FakeRankedPanel.prototype : FakeDuelPanel.prototype);
      scene["channel"] = channel;
      scene["channel_panel"] = panel;
      game.panel = panel;
    },
    leaveChannel() {
      scene["channel"] = undefined;
      scene["channel_panel"] = undefined;
      game.panel = undefined;
    },
  };

  window["__ulrCompanionReport"] = (payload: string) => {
    reports.push(JSON.parse(payload) as { type: string });
  };

  if (options.channel !== undefined) game.enterChannel(options.channel);
  return game;
}

/**
 * 把腳本丟進去跑。
 *
 * ⚠ 用 `new Function` 而不是 `eval`：跳脫錯了的話這裡會直接丟 SyntaxError，
 * 而那正是我們要抓的其中一個坑。
 */
function run(game: FakeGame, expression: string): string {
  // 頁面上的 setInterval 在測試裡不要真的跑 —— 我們自己叫 sync（換頻道那條）。
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: FakeWindow,
    si: () => number,
    ci: () => void,
  ) => string;
  return fn(
    game.window,
    () => 1,
    () => undefined,
  );
}

function install(game: FakeGame): string {
  return run(game, buildLobbyPatchScript({ bindingName: "__ulrCompanionReport" }));
}

/** 讓補丁重新檢查一次面板（模擬那支 500ms 的輪詢跑了一輪）。 */
function tick(game: FakeGame): void {
  install(game);
}

function texts(game: FakeGame): string[] {
  return (game.panel?.list ?? [])
    .filter((o): o is FakeObject => (o as FakeObject).type === "Text")
    .map((o) => String(o.text));
}

function quickButton(game: FakeGame): FakeButton | undefined {
  return (game.panel?.list ?? []).find(
    (o): o is FakeButton =>
      o instanceof FakeButton && o.texture.key === "match_quick_btn" && !o.destroyed,
  );
}

// ---------------------------------------------------------------------------

describe("大廳快速比賽補丁", () => {
  it("在 duel 頻道的面板上加一顆按鈕，靠左而且跟創建對戰室左右對稱", () => {
    const game = makeGame({ channel: 2 });
    const status = parseLobbyStatus(install(game));

    expect(status.installed).toBe(true);
    expect(status.buttonReady).toBe(true);
    expect(status.channel).toBe(2);

    const btn = quickButton(game);
    expect(btn).toBeDefined();
    // 沿面板中線（185）把 room_btn（296.5）鏡射過去：2×185 − 296.5 = 73.5。
    // 兩顆的邊距因此一模一樣（左緣 6、右緣 370−364＝6）。
    expect(btn?.x).toBeCloseTo(73.5);
    expect(btn?.y).toBe(434);
    // ⚠ 貼圖與 frame 都要是官方那顆的 —— 自己畫一顆會被一眼看出來。
    expect(btn?.frame).toBe("tcn_1");

    // 中線本身也要是算出來的：官方把那一格移到哪，按鈕就跟到哪。
    const mid = game.panel?.room_page_text as FakeObject;
    const roomBtn = game.panel?.room_btn as FakeButton;
    expect(btn!.x - mid.x).toBeCloseTo(mid.x - roomBtn.x);
  });

  it("讀不到面板中線時退回舊的相對位置，不是把按鈕丟到畫面外", () => {
    const game = makeGame({ channel: 2 });
    delete game.panel?.room_page_text;
    install(game);

    const btn = quickButton(game);
    // 296.5 − 135 − 10 = 151.5
    expect(btn?.x).toBeCloseTo(151.5);
  });

  it("開口檔的下限是從遊戲自己的模板讀的，不是寫死的 90", () => {
    const game = makeGame({ channel: 2 });
    const status = parseLobbyStatus(install(game));
    expect(status.openTier).toBe(90);

    // 官方改成 100+ 的話要跟著改，不能還是 90。
    FakePanelBase.PLAYER_COUNT["tcn"] = [
      PLAYER_COUNT_TCN[0]!,
      PLAYER_COUNT_TCN[1]!.replace("COST90+", "COST100+"),
    ];
    const other = makeGame({ channel: 2 });
    expect(parseLobbyStatus(install(other)).openTier).toBe(100);
    FakePanelBase.PLAYER_COUNT["tcn"] = PLAYER_COUNT_TCN;
  });

  it("ranked 頻道不碰 —— 那邊有官方自己的快速比賽", () => {
    const game = makeGame({ channel: 1, ranked: true });
    const status = parseLobbyStatus(install(game));
    expect(status.buttonReady).toBe(false);
    expect(quickButton(game)).toBeUndefined();
  });

  it("還沒進頻道時不裝，進去之後自己補上", () => {
    const game = makeGame();
    expect(parseLobbyStatus(install(game)).buttonReady).toBe(false);

    game.enterChannel(2);
    tick(game);
    expect(quickButton(game)).toBeDefined();
  });

  it("換頻道之後掛到新的面板上（舊的會被遊戲 destroy）", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const first = quickButton(game);

    game.enterChannel(4);
    tick(game);
    const second = quickButton(game);

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(parseLobbyStatus(run(game, LOBBY_STATUS_EXPRESSION)).channel).toBe(4);
  });

  it("按下去會回報，而且帶著當下的頻道", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    quickButton(game)?.click();

    expect(game.reports).toEqual([{ type: "lobby-quick", channel: 2, matching: false }]);
  });

  it("配對中按下去，回報裡的 matching 是 true（那顆按鈕同時是取消鍵）", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    run(game, buildLobbyStateExpression({ counts: null, matching: true }));
    quickButton(game)?.click();
    expect(game.reports.at(-1)).toMatchObject({ matching: true });
  });

  it("人數填進遊戲自己的模板，四行都在", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    run(
      game,
      buildLobbyStateExpression({
        counts: [
          { tier: 54, waiting: 1 },
          { tier: 61, waiting: 0 },
          { tier: 77, waiting: 2 },
          { tier: 90, waiting: 3, open: true },
        ],
        matching: false,
      }),
    );

    expect(texts(game)).toContain(
      "COST54:1位玩家等待中。\nCOST61:0位玩家等待中。\nCOST77:2位玩家等待中。\nCOST90+:3位玩家等待中。",
    );
  });

  it("沒有開口檔的資料時整行拿掉，不留 0 也不留佔位符", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    run(
      game,
      buildLobbyStateExpression({
        counts: [
          { tier: 54, waiting: 1 },
          { tier: 61, waiting: 0 },
          { tier: 77, waiting: 2 },
        ],
        matching: false,
      }),
    );

    const shown = texts(game).find((t) => t.startsWith("COST54"));
    expect(shown).toBe("COST54:1位玩家等待中。\nCOST61:0位玩家等待中。\nCOST77:2位玩家等待中。");
    expect(shown).not.toContain("__LENGTH4__");
  });

  it("問不到人數（null）時那幾行是空的 —— 不能畫成 0 位", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    run(game, buildLobbyStateExpression({ counts: null, matching: false }));

    for (const t of texts(game)) {
      expect(t).not.toContain("位玩家等待中");
    }
  });

  it("人數那幾行接在 player_count 底下", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    run(
      game,
      buildLobbyStateExpression({
        counts: [
          { tier: 54, waiting: 1 },
          { tier: 61, waiting: 0 },
          { tier: 77, waiting: 2 },
        ],
        matching: false,
      }),
    );

    const counts = (game.panel?.list ?? [])
      .filter((o): o is FakeObject => (o as FakeObject).type === "Text")
      .find((o) => String(o.text).startsWith("COST54"));
    // player_count 在 y=470、高 18 —— 亞城的那幾行就是接在它底下。
    expect(counts?.y).toBe(488);
  });

  /**
   * ⚠⚠ 2026-08-20 實機回歸：`baseY` 是掛上去那一刻算好就一直用的，而
   * `player_count` 的高度是**會變的**（那一行字是遊戲自己重寫的）。實測到
   * 一台的快取值卡在 506、而 player_count 底部是 488 —— 於是 COST54 上面
   * 永遠空一行，換頻道也不會好。
   *
   * 官方那一版（`refresh_ranked_players`）每次 refresh 都重新 `setPosition`，
   * 我們現在也是。
   */
  it("⚠ player_count 的高度變了，那幾行要跟著移，不能用掛上去時算的位置", () => {
    const game = makeGame({ channel: 2 });
    install(game);

    const push = (): void => {
      run(game, buildLobbyStateExpression({ counts: [{ tier: 54, waiting: 1 }], matching: false }));
    };
    const countsText = (): FakeObject | undefined =>
      (game.panel?.list ?? [])
        .filter((o): o is FakeObject => (o as FakeObject).type === "Text")
        .find((o) => String(o.text).startsWith("COST54"));
    /** 遊戲自己改寫那一行（`refresh_player_count` 做的就是這件事）。 */
    const rewrite = (value: string): void => {
      (game.panel?.player_count as unknown as { setText(v: string): void }).setText(value);
    };

    push();
    expect(countsText()?.y).toBe(488);

    // 遊戲把那一行改成兩行（名字太長換行、或推播帶了第二行）
    rewrite("玩家:迪特赫姆登入 [參加人數:22]\n第二行");
    push();
    expect(countsText()?.y).toBe(470 + 36);

    // 再變回一行 —— 也要跟著回去，不是卡在下面
    rewrite("玩家:迪特赫姆登入 [參加人數:23]");
    push();
    expect(countsText()?.y).toBe(488);
  });

  it("⚠ 重裝時連上一版留下的東西一起拆（欄位可能跟這一版不一樣）", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    // 假裝上一版多掛了一個字（真的發生過：舊版有 statusText，新版沒有那一格）。
    const leftover = makeText(10, 560, "排隊中…（上一版留下的）");
    game.panel?.list.push(leftover);
    const st = game.window["__ulrLobby"] as { mine: unknown[] };
    st.mine.push(leftover);

    install(game);
    expect(leftover.destroyed).toBe(true);
  });

  it("拆掉之後畫面上的東西都不見了", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const btn = quickButton(game);
    expect(run(game, LOBBY_UNINSTALL_EXPRESSION)).toBe("uninstalled");
    expect(btn?.destroyed).toBe(true);
    expect(parseLobbyStatus(run(game, LOBBY_STATUS_EXPRESSION)).installed).toBe(false);
  });

  it("沒裝的時候問狀態不會爆", () => {
    const game = makeGame({ channel: 2 });
    const status = parseLobbyStatus(run(game, LOBBY_STATUS_EXPRESSION));
    expect(status.installed).toBe(false);
    expect(status.buttonReady).toBe(false);
  });
});

/**
 * 假的 webpack 登錄表，裡面放遊戲那三樣 UI：確認對話框、文字按鈕、字串表。
 *
 * ⚠ 三個都是**照真的那幾個類別的特徵**放的（對話框的原始碼含 `ok_button` 與
 * `panel_gene`，按鈕含 `btn_gene` 與 `setText`，字串表有 `CANCEL_BUTTON`）——
 * 補丁就是靠這些特徵找它們的，測試用別的特徵等於沒測到那段。
 */
function withWebpack(game: FakeGame): {
  dialogs: { message: string; depth: number }[];
  buttons: { label: string; click: () => void }[];
} {
  const dialogs: { message: string; depth: number }[] = [];
  const buttons: { label: string; click: () => void }[] = [];

  class FakeDialog {
    ok_button = { on: (_e: string, _h: () => void) => undefined };
    depth = 0;
    // 這一行讓 toString() 裡有 ok_button 與 panel_gene —— 補丁靠它認人。
    box = "panel_gene ok_button";
    constructor(
      _scene: unknown,
      _x: number,
      _y: number,
      _lang: string,
      public message: string,
    ) {}
    setDepth(d: number): this {
      this.depth = d;
      dialogs.push({ message: this.message, depth: d });
      return this;
    }
  }

  class FakeTextButton {
    #handlers: (() => void)[] = [];
    base = "btn_gene";
    constructor(
      _scene: unknown,
      public x: number,
      public y: number,
      public label: string,
    ) {
      buttons.push({ label, click: () => this.#handlers.forEach((h) => h()) });
    }
    setText(t: string): this {
      this.label = t;
      return this;
    }
    on(_e: string, h: () => void): this {
      this.#handlers.push(h);
      return this;
    }
    destroy(): void {}
  }

  const labels = {
    OK_BUTTON: { tcn: "ok" },
    CANCEL_BUTTON: { tcn: "cancel" },
    CONFIRM_TITLE: { tcn: "確認" },
  };

  const req = Object.assign(
    (id: string) => (id === "79733" ? { Cw: FakeDialog, KK: FakeTextButton, ES: labels } : {}),
    { m: { "79733": {} } },
  );
  // Array.isArray 要是 true，補丁才認得那是 chunk 陣列。
  const arr: unknown[] = [];
  (arr as unknown as { push: unknown }).push = (
    chunk: [string[], object, ((r: unknown) => void)?],
  ) => {
    chunk[2]?.(req);
    return 1;
  };
  game.window["webpackChunkulr"] = arr;
  return { dialogs, buttons };
}

describe("牌組不符合規則的對話框", () => {
  it("用遊戲自己那句話（room_error[lang][7]）", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const { dialogs } = withWebpack(game);

    const out = run(game, buildLobbyErrorExpression(ROOM_ERROR_DECK_INVALID));
    expect(out).toBe("ok");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.message).toBe("這個牌組不符合遊戲規則");
    // 照抄 room_quick()：對話框 500，遮罩與 zone 499。
    expect(dialogs[0]?.depth).toBe(500);
  });

  it("遊戲沒有對應句子時才用我們自己的字串", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const { dialogs } = withWebpack(game);

    run(game, buildLobbyErrorExpression(null, "請先進入一個頻道。"));
    expect(dialogs[0]?.message).toBe("請先進入一個頻道。");
  });
});

/**
 * 等待對手的視窗。
 *
 * ⚠ 這一組釘的是「**跟亞城那個框是同一個東西**」：同一句 WAIT_TEXT、
 * 同一顆 cancel 鈕、會計時。玩家會把兩邊擺在一起看。
 */
describe("等待視窗", () => {
  it("配對中跳出來，用遊戲自己的 WAIT_TEXT 與 cancel 鈕", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const { buttons } = withWebpack(game);

    run(game, buildLobbyStateExpression({ counts: null, matching: true }));

    // WAIT_TEXT 是**一個字一個 text**（原版的波浪動畫就是這樣做的）。
    const letters = game.sceneObjects.filter(
      (o) => o.type === "Text" && "正在等待對手加入...".includes(String(o.text)),
    );
    expect(letters.length).toBeGreaterThan(5);
    // 計時器從 00:00 起跳。
    expect(game.sceneObjects.some((o) => o.text === "00:00")).toBe(true);
    // cancel 鈕用的是遊戲自己的字串表。
    expect(buttons.map((b) => b.label)).toEqual(["cancel"]);
  });

  it("按 cancel 等於再按一次快速比賽（同一條回報路徑）", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    const { buttons } = withWebpack(game);
    run(game, buildLobbyStateExpression({ counts: null, matching: true }));

    buttons[0]?.click();
    expect(game.reports.at(-1)).toEqual({ type: "lobby-quick", channel: 2, matching: true });
  });

  it("配對結束就收掉，計時器也要停", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    withWebpack(game);
    run(game, buildLobbyStateExpression({ counts: null, matching: true }));
    expect(game.timers.filter((t) => !t.removed)).toHaveLength(2);

    run(game, buildLobbyStateExpression({ counts: null, matching: false }));
    // ⚠ 計時器沒收的話，它會抓著已經 destroy 的 text 每秒跑一次。
    expect(game.timers.filter((t) => !t.removed)).toHaveLength(0);
  });

  it("⚠ 換頻道時也要收 —— 它掛在場景上，不會跟著面板被 destroy", () => {
    const game = makeGame({ channel: 2 });
    install(game);
    withWebpack(game);
    run(game, buildLobbyStateExpression({ counts: null, matching: true }));

    game.leaveChannel();
    tick(game);
    expect(game.timers.filter((t) => !t.removed)).toHaveLength(0);
  });
});
