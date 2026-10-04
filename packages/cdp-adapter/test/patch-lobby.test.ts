/**
 * 迪特赫姆的快速比賽補丁
 *
 * 跟 `patch-stage.test.ts` 同一種寫法：搭一個假的遊戲（改版後的 Match 場景、
 * 頻道物件、`channel_match` 那顆鈕、遊戲自己的人數模板與錯誤字串表），把
 * `buildLobbyPatchScript()` 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * ⚠ **不要改成「重寫一份等價的實作再測」。** 這支補丁的坑全部在「跟遊戲的形狀
 * 對不對得上」，而其中幾個只有跑真的字串才抓得到：
 *
 * 1. 腳本整個住在 template literal 裡 —— **跳脫少一層就是語法錯誤**
 *    （`\\n` 寫成 `\n` 的話字串裡會出現真的換行，整支腳本掛掉）
 * 2. 按鈕位置是**從 channel_match 與翻頁鍵算的**，不是寫死座標
 * 3. 人數那幾行填的是**遊戲自己的模板**，欄位名一個字都不能差
 * 4. 等待視窗是官方那一個，取消鈕要換成通知插件（排隊時還沒有房可以收）
 *
 * 假環境照 2026-09-27 從跑著的客戶端讀到的 Match 場景搭。
 */

import { describe, expect, it } from "vitest";
import {
  buildLobbyErrorExpression,
  buildLobbyPatchScript,
  buildLobbyStateExpression,
  LOBBY_SCRIPT_VERSION,
  LOBBY_STATUS_EXPRESSION,
  LOBBY_UNINSTALL_EXPRESSION,
  parseLobbyStatus,
  ROOM_ERROR_AP_SHORT,
  ROOM_ERROR_DECK_INVALID,
  WAIT_LAYOUT,
} from "@ulr/cdp-adapter";
import type { LobbyState } from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

/** `MatchUITexts.channel_length.quick`，**逐字照抄** 2026-09-27 的 tcn。 */
const QUICK_TEMPLATE =
  "COST__COST1__:__LENGTH1__位玩家等待中。\nCOST__COST2__:__LENGTH2__位玩家等待中。\nCOST__COST3__:__LENGTH3__位玩家等待中。\nCOST90+:__LENGTH4__位玩家等待中。";

const ERRORS: Record<string, string> = {
  label: "確認",
  NOT_ENOUGH_AP: "AP不足。",
  INVALID_DECK_ENTER: "這個牌組不符合遊戲規則。",
  DEFAULT: "發生錯誤。(--CODE--)",
};

type Handler = (...args: unknown[]) => void;

interface FakeObj {
  kind: string;
  key?: string;
  frame?: number | string;
  x: number;
  y: number;
  width: number;
  height: number;
  originX: number;
  text?: string;
  depth?: number;
  scene: object | undefined;
  handlers: Record<string, Handler[]>;
  /** Phaser 的 `type`（Image／Text…），補丁靠它認頁碼殘影。 */
  type?: string;
  texture?: { key: string };
  /** 世界座標的範圍 [左, 上, 寬, 高]。沒給就是「點不到」。 */
  box?: [number, number, number, number];
  getBounds(): { contains(x: number, y: number): boolean };
  /** 只給 Cancel 用：origin(0.5, 1)，中心在下緣往上半個高。 */
  getCenter(): { x: number; y: number };
  listeners(ev: string): Handler[];
  setOrigin(x: number, y?: number): FakeObj;
  setInteractive(): FakeObj;
  setDepth(d: number): FakeObj;
  setPosition(x: number, y: number): FakeObj;
  setText(t: string): FakeObj;
  setTexture(key: string, frame?: number | string): FakeObj;
  on(ev: string, fn: Handler): FakeObj;
  off(ev: string): FakeObj;
  emit(ev: string): void;
  destroy(): void;
}

function obj(kind: string, x: number, y: number, extra: Partial<FakeObj> = {}): FakeObj {
  const o: FakeObj = {
    kind,
    x,
    y,
    width: 135,
    height: 17,
    originX: 0.5,
    scene: {},
    handlers: {},
    setOrigin(ox: number) {
      o.originX = ox;
      return o;
    },
    setInteractive: () => o,
    setDepth(d: number) {
      o.depth = d;
      return o;
    },
    setPosition(px: number, py: number) {
      o.x = px;
      o.y = py;
      return o;
    },
    setText(t: string) {
      o.text = t;
      o.height = t === "" ? 0 : t.split("\n").length * 18;
      return o;
    },
    setTexture(key: string, frame?: number | string) {
      o.key = key;
      if (frame !== undefined) o.frame = frame;
      return o;
    },
    on(ev: string, fn: Handler) {
      (o.handlers[ev] ??= []).push(fn);
      return o;
    },
    off(ev: string) {
      delete o.handlers[ev];
      return o;
    },
    emit(ev: string) {
      for (const h of o.handlers[ev] ?? []) h();
    },
    listeners(ev: string) {
      return [...(o.handlers[ev] ?? [])];
    },
    getCenter() {
      return { x: o.x, y: o.y - o.height / 2 };
    },
    getBounds() {
      // 九宮格面板：原點在中心，範圍跟著位置與尺寸走
      const b: FakeObj["box"] =
        o.kind === "NineSlice" ? [o.x - o.width / 2, o.y - o.height / 2, o.width, o.height] : o.box;
      return {
        contains: (px: number, py: number) =>
          b !== undefined && px >= b[0] && px < b[0] + b[2] && py >= b[1] && py < b[1] + b[3],
      };
    },
    destroy() {
      o.scene = undefined;
    },
    ...extra,
  };
  return o;
}

interface FakeMatch {
  scene: { isActive: () => boolean };
  channel: { channel: number; quick: boolean; event: boolean } | null;
  channel_match: FakeObj | null;
  channel_room_prev: FakeObj | null;
  channel_room_next: FakeObj | null;
  channel_page_text_now: FakeObj | null;
  channel_page_text_slash: FakeObj | null;
  channel_page_text_max: FakeObj | null;
  channel_room_images: FakeObj[];
  channel_length: FakeObj | null;
  children: { readonly list: FakeObj[] };
  room_wait: boolean;
  room_select: string | null;
  __ulrWaitRoom?: string | null;
  player_side: string | null;
  wait_zone: FakeZone | null;
  wait_panel: FakeObj | null;
  wait_text: FakeObj[] | null;
  wait_time_text: FakeObj | null;
  btn_cancel: FakeObj | null;
  btn_cancel_text: FakeObj | null;
  ulse01: { play: () => void };
  textures: { exists: (k: string) => boolean };
  add: { image: (...a: never[]) => FakeObj; text: (...a: never[]) => FakeObj };
  create_match_wait(): void;
  remove_match_wait(): void;
  channel_logout(): void;
  match_error(code: string): void;
}

type HitCallback = (area: unknown, x: number, y: number, o: FakeZone) => boolean;

/** 官方的 wait_zone：zone(380, 340, 760, 680)，原點在中心，setInteractive() 不帶參數。 */
interface FakeZone {
  x: number;
  y: number;
  displayOriginX: number;
  displayOriginY: number;
  input: { hitArea: object; hitAreaCallback: HitCallback };
}

interface FakeGame {
  window: Record<string, unknown>;
  sc: FakeMatch;
  added: FakeObj[];
  reports: { type: string; [k: string]: unknown }[];
  /** 官方取消鈕原本那支被叫過幾次（排隊時它不該被叫到）。 */
  officialCancels: number;
  /** 官方取消鈕送出的 cancel_room 房號。 */
  cancelledRooms: (string | null)[];
  waitsCreated: number;
  errors: { code: string; text: string }[];
  texts: { channel_length: { quick: string }; error: Record<string, string> };
  /** 玩家（重新）進一個頻道：頻道畫面上的東西全部重建。 */
  enterChannel(channel: { channel: number; quick: boolean; event: boolean }): void;
  leaveChannel(): void;
  setActive(on: boolean): void;
}

const DUEL = { channel: 2, quick: false, event: false };
const RANKED = { channel: 1, quick: true, event: false };

function makeGame(channel: FakeMatch["channel"] = DUEL): FakeGame {
  const added: FakeObj[] = [];
  const reports: { type: string; [k: string]: unknown }[] = [];
  const errors: { code: string; text: string }[] = [];
  const texts = { channel_length: { quick: QUICK_TEMPLATE }, error: { ...ERRORS } };
  let active = true;

  const game = {
    added,
    reports,
    errors,
    texts,
    officialCancels: 0,
    cancelledRooms: [],
    waitsCreated: 0,
  } as unknown as FakeGame;

  /** 場景的顯示清單：頻道畫面上的東西都進這裡，destroy 過的就不在了。 */
  const display: FakeObj[] = [];
  const shown = (o: FakeObj): FakeObj => {
    display.push(o);
    return o;
  };

  const sc: FakeMatch = {
    scene: { isActive: () => active },
    channel: null,
    channel_match: null,
    channel_room_prev: null,
    channel_room_next: null,
    channel_page_text_now: null,
    channel_page_text_slash: null,
    channel_page_text_max: null,
    channel_room_images: [],
    channel_length: null,
    children: {
      get list() {
        return display.filter((o) => o.scene !== undefined);
      },
    },
    room_wait: false,
    room_select: null,
    player_side: null,
    wait_zone: null,
    wait_panel: null,
    wait_text: null,
    wait_time_text: null,
    btn_cancel: null,
    btn_cancel_text: null,
    ulse01: { play: () => undefined },
    textures: { exists: (k: string) => k === "match_quick" || k === "match_create" },
    add: {
      image: ((x: number, y: number, key: string, frame: number) => {
        const o = obj("Image", x, y, { key, frame });
        added.push(o);
        return o;
      }) as never,
      text: ((x: number, y: number, t: string) => {
        const o = obj("Text", x, y);
        o.setText(t);
        added.push(o);
        return o;
      }) as never,
    },
    // 官方的等待視窗（照 create_match_wait 的形狀）
    create_match_wait() {
      game.waitsCreated++;
      // 原點在中心 → hitArea 的區域座標 0..760 × 0..680
      sc.wait_zone = {
        x: 380,
        y: 340,
        displayOriginX: 380,
        displayOriginY: 340,
        input: {
          hitArea: {},
          hitAreaCallback: (_a, x, y) => x >= 0 && x < 760 && y >= 0 && y < 680,
        },
      };
      // 實測面板範圍約 (297, 262) 起 166 × 156
      // 照官方：面板 (380, 340) 高 156、逐字波浪 y 325、計時 354、Cancel 下緣在底 -16
      sc.wait_panel = obj("NineSlice", 380, 340, { width: 166, height: 156 });
      sc.wait_text = [360, 380, 400].map((x) => obj("Text", x, 325));
      sc.wait_time_text = obj("Text", 380, 354);
      const cancel = obj("Image", 380, 402, { key: "btn_gene", height: 24 });
      sc.btn_cancel_text = obj("Text", 380, 390);
      // 官方那支：送 cancel_room(room_select)
      cancel.on("pointerup", () => {
        game.officialCancels++;
        game.cancelledRooms.push(sc.room_select);
      });
      sc.btn_cancel = cancel;
    },
    remove_match_wait() {
      sc.wait_zone = null;
      sc.wait_panel = null;
      sc.btn_cancel?.destroy();
      sc.btn_cancel = null;
    },
    // 官方那支：拆 channel_match／channel_length／房間列，**沒拆**翻頁鍵與頁碼字
    channel_logout() {
      for (const o of [sc.channel_match, sc.channel_length, ...sc.channel_room_images])
        o?.destroy();
      sc.channel = null;
      sc.room_select = null;
      sc.channel_match = null;
      sc.channel_length = null;
      sc.channel_room_images = [];
    },
    // 官方的錯誤框：在第一個 await 之前就把字串讀走
    match_error(code: string) {
      const e = texts.error;
      errors.push({
        code,
        text: code in e ? e[code]! : e["DEFAULT"]!.replace("--CODE--", code),
      });
    },
  };

  game.sc = sc;
  // 照官方 channel_login：翻頁鍵與頁碼字**每次都新建**，舊的不管（官方的漏）。
  game.enterChannel = (c) => {
    for (const o of [sc.channel_match, sc.channel_length]) o?.destroy();
    sc.channel = c;
    sc.channel_match = shown(
      obj("Image", 352, 434, {
        key: c.quick ? "match_quick" : "match_create",
        originX: 1,
        width: 135,
        box: [217, 420, 135, 28],
      }),
    );
    const arrow = { type: "Image", texture: { key: "btn_arrow" } };
    sc.channel_room_prev = shown(obj("Image", 143, 400, { ...arrow, box: [119, 400, 24, 14] }));
    sc.channel_room_next = shown(obj("Image", 223, 400, { ...arrow, box: [223, 400, 24, 14] }));
    sc.channel_page_text_now = shown(obj("Text", 175, 407, { type: "Text" }));
    sc.channel_page_text_slash = shown(obj("Text", 183, 407, { type: "Text" }));
    sc.channel_page_text_max = shown(obj("Text", 191, 407, { type: "Text" }));
    // 房間列：實測每列 (16, 53 + 43i) 起 336 × 40
    sc.channel_room_images = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      shown(obj("Container", 184, 73 + i * 43, { box: [16, 53 + i * 43, 336, 40] })),
    );
    sc.channel_length = shown(obj("Text", 8, 472, { height: 17 }));
  };
  game.leaveChannel = () => sc.channel_logout();
  game.setActive = (on) => {
    active = on;
  };
  game.window = {
    game: {
      scene: { keys: { Match: sc } },
      cache: { json: { get: (k: string) => (k === "MatchUITexts" ? texts : null) } },
    },
    lang: "tcn",
    __ulrReport: (json: string) => reports.push(JSON.parse(json)),
  };
  if (channel !== null) game.enterChannel(channel);
  return game;
}

function run<T>(game: FakeGame, expression: string): T {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", `return ${expression};`) as (w: unknown) => T;
  return fn(game.window);
}

function install(game: FakeGame): ReturnType<typeof parseLobbyStatus> {
  // 輪詢間隔拉到很大：測試自己叫 tick（重裝就是一次 sync）。
  return parseLobbyStatus(
    run<string>(game, buildLobbyPatchScript({ bindingName: "__ulrReport", pollIntervalMs: 1e9 })),
  );
}

function setState(game: FakeGame, state: LobbyState): string {
  return run<string>(game, buildLobbyStateExpression(state));
}

function status(game: FakeGame): ReturnType<typeof parseLobbyStatus> {
  return parseLobbyStatus(run<string>(game, LOBBY_STATUS_EXPRESSION));
}

/** 我們畫的那顆鈕。 */
function ourButton(game: FakeGame): FakeObj | undefined {
  return game.added.find((o) => o.kind === "Image" && o.key === "match_quick" && o.scene);
}

/** 我們畫的人數那幾行。 */
function countsText(game: FakeGame): FakeObj | undefined {
  return game.added.find((o) => o.kind === "Text" && o.scene && o.x === 8);
}

function uninstallAll(game: FakeGame): void {
  run<string>(game, LOBBY_UNINSTALL_EXPRESSION);
}

// ---------------------------------------------------------------------------

describe("按鈕", () => {
  it("迪城畫一顆遊戲自己的 match_quick，跟「創建對戰房間」沿翻頁鍵中線左右對稱", () => {
    const game = makeGame();
    const st = install(game);
    try {
      expect(st.installed).toBe(true);
      expect(st.version).toBe(LOBBY_SCRIPT_VERSION);
      expect(st.buttonReady).toBe(true);
      expect(st.channel).toBe(2);
      const btn = ourButton(game)!;
      // 官方那顆右緣 352，中線 (143 + 223) / 2 = 183 → 我們的左緣 14
      expect(btn.x).toBe(14);
      expect(btn.originX).toBe(0);
      expect(btn.y).toBe(434);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 有官方快速比賽的頻道（亞城）不畫 —— 不要疊在官方那顆旁邊", () => {
    const game = makeGame(RANKED);
    const st = install(game);
    try {
      expect(st.buttonReady).toBe(false);
      expect(ourButton(game)).toBeUndefined();
      expect(st.reason).toContain("官方");
    } finally {
      uninstallAll(game);
    }
  });

  it("活動頻道不畫", () => {
    const game = makeGame({ channel: 5, quick: false, event: true });
    const st = install(game);
    try {
      expect(st.buttonReady).toBe(false);
    } finally {
      uninstallAll(game);
    }
  });

  it("還沒進頻道 → 等，不是錯誤", () => {
    const game = makeGame(null);
    const st = install(game);
    try {
      expect(st.installed).toBe(true);
      expect(st.buttonReady).toBe(false);
      expect(st.waiting).toBe(true);
    } finally {
      uninstallAll(game);
    }
  });

  it("按下去把頻道與配對狀態回報給 Node", () => {
    const game = makeGame();
    install(game);
    try {
      ourButton(game)!.emit("pointerup");
      expect(game.reports).toEqual([{ type: "lobby-quick", channel: 2, matching: false }]);
    } finally {
      uninstallAll(game);
    }
  });

  it("hover 照官方那顆換 frame", () => {
    const game = makeGame();
    install(game);
    try {
      const btn = ourButton(game)!;
      btn.emit("pointerover");
      expect(btn.frame).toBe(1);
      btn.emit("pointerout");
      expect(btn.frame).toBe(0);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 換頻道（channel_match 重建）→ 重掛到新的那一顆上，舊的拆掉", () => {
    const game = makeGame();
    install(game);
    try {
      const first = ourButton(game)!;
      game.enterChannel({ channel: 4, quick: false, event: false });
      install(game); // 重裝＝跑一次 sync（輪詢做的是同一件事）
      expect(first.scene).toBeUndefined();
      expect(ourButton(game)).toBeDefined();
      expect(status(game).channel).toBe(4);
    } finally {
      uninstallAll(game);
    }
  });

  it("重裝不會多一顆", () => {
    const game = makeGame();
    install(game);
    install(game);
    install(game);
    try {
      expect(game.added.filter((o) => o.key === "match_quick" && o.scene)).toHaveLength(1);
    } finally {
      uninstallAll(game);
    }
  });
});

describe("人數那幾行", () => {
  it("填進遊戲自己的模板，接在「參加人數」那一行底下", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, {
        counts: [
          { tier: 57, waiting: 1 },
          { tier: 66, waiting: 0 },
          { tier: 78, waiting: 2 },
          { tier: 90, waiting: 3, open: true },
        ],
        matching: false,
      });
      const t = countsText(game)!;
      expect(t.text).toBe(
        "COST57:1位玩家等待中。\nCOST66:0位玩家等待中。\nCOST78:2位玩家等待中。\nCOST90+:3位玩家等待中。",
      );
      expect(t.y).toBe(472 + 17);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 沒有開口檔的資料就把那一行整個拿掉，不填 0", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, {
        counts: [
          { tier: 57, waiting: 1 },
          { tier: 66, waiting: 0 },
          { tier: 78, waiting: 2 },
        ],
        matching: false,
      });
      expect(countsText(game)!.text).not.toContain("90+");
      expect(countsText(game)!.text).not.toContain("__LENGTH4__");
    } finally {
      uninstallAll(game);
    }
  });

  it("自訂檔另起一行，前面有 ★", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, {
        counts: [
          { tier: 57, waiting: 0 },
          { tier: 66, waiting: 0 },
          { tier: 78, waiting: 0 },
          { tier: 48, waiting: 1, custom: true },
        ],
        matching: false,
      });
      expect(countsText(game)!.text!.split("\n").at(-1)).toBe("★COST48:1位玩家等待中。");
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 不知道（null）就整段不畫，不寫「0 位」", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: false });
      expect(countsText(game)!.text).toBe("");
    } finally {
      uninstallAll(game);
    }
  });

  it("開口檔的下限從模板讀（90），不寫死", () => {
    const game = makeGame();
    install(game);
    try {
      expect(status(game).openTier).toBe(90);
      game.texts.channel_length.quick = QUICK_TEMPLATE.replace("COST90+", "COST100+");
      expect(status(game).openTier).toBe(100);
    } finally {
      uninstallAll(game);
    }
  });
});

describe("等待視窗", () => {
  it("配對中 → 開遊戲自己的 create_match_wait()", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      expect(game.waitsCreated).toBe(1);
      expect(game.sc.wait_zone).not.toBeNull();
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 取消鈕改成通知插件 —— 官方那支會送 cancel_room，而排隊時還沒有房", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      game.sc.btn_cancel!.emit("pointerup");
      expect(game.officialCancels).toBe(0);
      expect(game.reports).toEqual([{ type: "lobby-quick", channel: 2, matching: true }]);
    } finally {
      uninstallAll(game);
    }
  });

  it("停止配對 → 收掉我們開的那一個", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      setState(game, { counts: null, matching: false });
      expect(game.sc.wait_zone).toBeNull();
    } finally {
      uninstallAll(game);
    }
  });

  it("推同一個狀態很多次也只開一個", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      setState(game, { counts: [], matching: true });
      install(game);
      expect(game.waitsCreated).toBe(1);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 玩家自己開著一間房（room_wait）→ 不開，那是官方的視窗", () => {
    const game = makeGame();
    game.sc.room_wait = true;
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      expect(game.waitsCreated).toBe(0);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 對戰已經開始（player_side 有值）→ 不開，Match 正要 sleep", () => {
    const game = makeGame();
    game.sc.player_side = "A";
    install(game);
    try {
      setState(game, { counts: null, matching: true });
      expect(game.waitsCreated).toBe(0);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 不是我們開的視窗（插件開房時 match-room 開的）不由我們收", () => {
    const game = makeGame();
    install(game);
    try {
      game.sc.create_match_wait(); // 別人開的
      setState(game, { counts: null, matching: true });
      setState(game, { counts: null, matching: false });
      expect(game.sc.wait_zone).not.toBeNull();
    } finally {
      uninstallAll(game);
    }
  });

  it("標記那一行畫在視窗上，面板不夠寬就撐開", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true, badge: "★ COST 48 · 夾擠式罰C" });
      const badge = game.added.find((o) => o.text === "★ COST 48 · 夾擠式罰C" && o.scene);
      expect(badge).toBeDefined();
      // 跟著搬過的框：水平置中、上緣 + badgeY
      const p = game.sc.wait_panel!;
      expect(badge!.x).toBe(p.x);
      expect(badge!.y).toBe(WAIT_LAYOUT.top + WAIT_LAYOUT.badgeY);
      setState(game, { counts: null, matching: false });
      expect(badge!.scene).toBeUndefined();
    } finally {
      uninstallAll(game);
    }
  });
});

/** 擋板在 (x, y) 這一點吃不吃點擊。 */
function blocks(game: FakeGame, x: number, y: number): boolean {
  const z = game.sc.wait_zone!;
  // Phaser 傳進來的是區域座標：原點在中心的 zone，世界 (x, y) = 區域 (x, y)
  return z.input.hitAreaCallback(
    z.input.hitArea,
    x - z.x + z.displayOriginX,
    y - z.y + z.displayOriginY,
    z,
  );
}

/** 照官方 quick_match：room_wait、room_select = 排隊 id、開等待視窗。 */
function officialQuick(game: FakeGame, id: string): void {
  game.sc.room_wait = true;
  game.sc.room_select = id;
  game.sc.create_match_wait();
}

describe("等待中點房間看牌組", () => {
  it("擋板只放行房間列與翻頁鍵", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      expect(blocks(game, 100, 73)).toBe(false); // 第一列房
      expect(blocks(game, 100, 374)).toBe(false); // 最後一列房
      expect(blocks(game, 130, 405)).toBe(false); // ◀
      expect(blocks(game, 235, 405)).toBe(false); // ▶
      expect(blocks(game, 300, 434)).toBe(true); // 快速比賽鈕
      expect(blocks(game, 100, 640)).toBe(true); // 換牌組那一排
      expect(blocks(game, 560, 172)).toBe(true); // 房間詳情（進入鈕在這）
    } finally {
      uninstallAll(game);
    }
  });

  it("框搬走之後，原本被它蓋住的那一截房間列也點得到；框本身照擋", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      // 第 6 列 (y 268..308) 的右半截原本在官方框 (x 297..463) 底下
      expect(blocks(game, 330, 290)).toBe(false);
      expect(blocks(game, WAIT_LAYOUT.left + 20, WAIT_LAYOUT.top + 20)).toBe(true);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 點過別的房間再按 Cancel，送的還是排隊那一個 id", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      game.sc.room_select = "R9"; // 官方的房間點擊就是這樣改的
      game.sc.btn_cancel!.emit("pointerup");
      expect(game.cancelledRooms).toEqual(["Q1"]);
    } finally {
      uninstallAll(game);
    }
  });

  it("視窗收掉就忘了那個 id", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      expect(game.sc.__ulrWaitRoom).toBe("Q1");
      game.sc.remove_match_wait();
      expect(game.sc.__ulrWaitRoom).toBeNull();
    } finally {
      uninstallAll(game);
    }
  });

  it("迪城插件排隊（還沒有房）不記 id，取消鈕照舊通知插件", () => {
    const game = makeGame();
    install(game);
    try {
      game.sc.room_select = "R9"; // 排隊前點過房
      setState(game, { counts: null, matching: true });
      expect(game.sc.__ulrWaitRoom).toBeNull();
      expect(blocks(game, 100, 73)).toBe(false);
      game.sc.btn_cancel!.emit("pointerup");
      expect(game.officialCancels).toBe(0);
    } finally {
      uninstallAll(game);
    }
  });

  it("裝上之前就開著的視窗也補挖", () => {
    const game = makeGame(RANKED);
    officialQuick(game, "Q1");
    install(game);
    try {
      expect(blocks(game, 100, 73)).toBe(false);
      game.sc.room_select = "R9";
      game.sc.btn_cancel!.emit("pointerup");
      expect(game.cancelledRooms).toEqual(["Q1"]);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 重裝不包兩層，拆掉之後方法與擋板都還原", () => {
    const game = makeGame(RANKED);
    const create = game.sc.create_match_wait;
    const logout = game.sc.channel_logout;
    install(game);
    install(game);
    officialQuick(game, "Q1");
    expect(game.waitsCreated).toBe(1);
    uninstallAll(game);
    expect(game.sc.create_match_wait).toBe(create);
    expect(game.sc.channel_logout).toBe(logout);
    expect(blocks(game, 100, 73)).toBe(true);
  });
});

describe("等待視窗搬到右下空白", () => {
  const L = WAIT_LAYOUT;

  it("左緣與上緣釘在 WAIT_LAYOUT，高度壓成它的高", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      const p = game.sc.wait_panel!;
      expect(p.height).toBe(L.height);
      expect(p.x - p.width / 2).toBe(L.left);
      expect(p.y - p.height / 2).toBe(L.top);
    } finally {
      uninstallAll(game);
    }
  });

  it("裡面的東西跟著搬：水平位移一樣，y 照版面", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      const dx = L.left + 166 / 2 - 380;
      expect(game.sc.wait_text!.map((t) => [t.x, t.y])).toEqual(
        [360, 380, 400].map((x) => [x + dx, L.top + L.textY]),
      );
      expect([game.sc.wait_time_text!.x, game.sc.wait_time_text!.y]).toEqual([
        380 + dx,
        L.top + L.timerY,
      ]);
      const c = game.sc.btn_cancel!;
      expect([c.x, c.y]).toEqual([380 + dx, L.top + L.height - L.cancelBottom]);
      expect(game.sc.btn_cancel_text!.y).toBe(c.getCenter().y);
    } finally {
      uninstallAll(game);
    }
  });

  it("⚠ 重裝不會再搬一次（y 不重排、x 不累加）", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      officialQuick(game, "Q1");
      const before = game.sc.wait_text!.map((t) => [t.x, t.y]);
      install(game);
      expect(game.sc.wait_text!.map((t) => [t.x, t.y])).toEqual(before);
      expect(game.sc.wait_panel!.x - game.sc.wait_panel!.width / 2).toBe(L.left);
    } finally {
      uninstallAll(game);
    }
  });

  it("標記那一行把框撐寬時，左緣不動、往右長，裡面跟著重新置中", () => {
    const game = makeGame();
    install(game);
    try {
      setState(game, { counts: null, matching: true, badge: "★ COST 48 · 夾擠式罰C" });
      const p = game.sc.wait_panel!;
      const badge = game.added.find((o) => o.text === "★ COST 48 · 夾擠式罰C" && o.scene)!;
      // 假的 Text 寬 135 → 需要 167；官方框 166 → 撐到 167
      expect(p.width).toBe(167);
      expect(p.x - p.width / 2).toBe(L.left);
      expect(game.sc.btn_cancel!.x).toBe(p.x);
      expect(badge.x).toBe(p.x);
    } finally {
      uninstallAll(game);
    }
  });
});

describe("頁碼疊字（官方漏拆）", () => {
  const pagerAlive = (game: FakeGame): number =>
    game.sc.children.list.filter(
      (o) => (o.type === "Text" && o.y === 407) || o.texture?.key === "btn_arrow",
    ).length;

  it("退頻道時翻頁鍵與頁碼字一起拆", () => {
    const game = makeGame(RANKED);
    install(game);
    try {
      expect(pagerAlive(game)).toBe(5);
      game.leaveChannel();
      expect(pagerAlive(game)).toBe(0);
      expect(game.sc.channel_page_text_now).toBeNull();
      game.enterChannel(DUEL);
      expect(pagerAlive(game)).toBe(5);
    } finally {
      uninstallAll(game);
    }
  });

  it("裝上之前漏下來的幾組清掉，現役那一組留著", () => {
    const game = makeGame(RANKED);
    game.leaveChannel();
    game.enterChannel(RANKED);
    game.leaveChannel();
    game.enterChannel(RANKED);
    expect(pagerAlive(game)).toBe(15);
    const now = game.sc.channel_page_text_now!;
    install(game);
    try {
      expect(pagerAlive(game)).toBe(5);
      expect(now.scene).toBeDefined();
    } finally {
      uninstallAll(game);
    }
  });
});

describe("錯誤框", () => {
  it("用遊戲自己的 match_error 與字串表", () => {
    const game = makeGame();
    install(game);
    try {
      expect(run<string>(game, buildLobbyErrorExpression(ROOM_ERROR_AP_SHORT))).toBe("ok");
      expect(run<string>(game, buildLobbyErrorExpression(ROOM_ERROR_DECK_INVALID))).toBe("ok");
      expect(game.errors).toEqual([
        { code: "NOT_ENOUGH_AP", text: "AP不足。" },
        { code: "INVALID_DECK_ENTER", text: "這個牌組不符合遊戲規則。" },
      ]);
    } finally {
      uninstallAll(game);
    }
  });

  it("遊戲沒有對應句子時顯示 Node 給的字，而且用完就從字串表拿掉", () => {
    const game = makeGame();
    install(game);
    try {
      run<string>(game, buildLobbyErrorExpression(null, "讀不到你的牌組。"));
      expect(game.errors).toEqual([{ code: "__ulr_message", text: "讀不到你的牌組。" }]);
      expect(game.texts.error).not.toHaveProperty("__ulr_message");
    } finally {
      uninstallAll(game);
    }
  });

  it("沒有代碼也沒有字 → 不跳", () => {
    const game = makeGame();
    install(game);
    try {
      expect(run<string>(game, buildLobbyErrorExpression(null))).toBe("no-message");
      expect(game.errors).toEqual([]);
    } finally {
      uninstallAll(game);
    }
  });
});

describe("拆掉", () => {
  it("按鈕、人數、我們開的等待視窗都收乾淨", () => {
    const game = makeGame();
    install(game);
    setState(game, { counts: [], matching: true });
    expect(run<string>(game, LOBBY_UNINSTALL_EXPRESSION)).toBe("uninstalled");
    expect(ourButton(game)).toBeUndefined();
    expect(countsText(game)).toBeUndefined();
    expect(game.sc.wait_zone).toBeNull();
    expect(status(game).installed).toBe(false);
  });

  it("沒裝過就回 not-installed", () => {
    const game = makeGame();
    expect(run<string>(game, LOBBY_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("推狀態給沒裝的頁面 → not-installed，不會爆", () => {
    const game = makeGame();
    expect(setState(game, { counts: null, matching: false })).toBe("not-installed");
  });
});

describe("parseLobbyStatus", () => {
  it("頁面回垃圾就當成沒裝上", () => {
    expect(parseLobbyStatus("not json").installed).toBe(false);
    expect(parseLobbyStatus("null").installed).toBe(false);
    expect(parseLobbyStatus('{"installed":true}').installed).toBe(false);
  });
});
