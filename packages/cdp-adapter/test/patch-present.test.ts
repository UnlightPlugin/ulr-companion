/**
 * 好友面板的贈送次數
 *
 * 跟 `patch-lobby` / `patch-stage` 同一套：搭一個夠像的假遊戲，把
 * `buildPresentPatchScript()` 產出來的**那一串字**原封不動 `new Function`
 * 起來跑。不重寫一份等價實作 —— 那只會證明我看懂了自己寫的東西。
 *
 * 假環境照 2026-10-09 從改版後的客戶端挖出來的形狀寫：
 *
 * ```js
 *   // Friend 場景：PRESENT 鈕是 scene.launch("Friend", { is_quest_present: true })
 *   this.is_quest_present = t.is_quest_present;
 *   this.friend_panel = new f(this, 380, 340);       // rexContainerLite，世界座標
 *   //   panel_base 528x408 → 右緣 644；panel_filter_label y=527
 *   //   FONT_LABEL = { fontFamily: "font_light", fontSize: 12, resolution: 2 }
 *
 *   // 送出（Friend 面板的確認框 OK）：
 *   if (!1 === await s.socket.fetch("quest_pre", quest_pid, friend_code, stamp)) …
 *   // 失敗原因另外走 Quest.socket 的 quest_error 事件（PRESENT_LIMIT …）
 * ```
 *
 * 伺服器**不再告訴我們剩幾次**（db_quest 的 pre_remain 改版後不見了），所以
 * 這支是自己數的。要抓的坑：
 *
 * 1. 面板每開一次都是新物件 —— 掛在舊物件上的東西會跟著死
 * 2. Quest 的 socket 每次進任務畫面都換 —— 監聽要跟著搬
 * 3. 重裝時監聽變兩份 → 送一次記兩次
 * 4. 換日要歸零；伺服器說滿了要歸零；滿了卻又送成功＝伺服器已換日
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildPresentPatchScript,
  parsePresentStatus,
  PRESENT_SCRIPT_VERSION,
  PRESENT_STATUS_EXPRESSION,
  PRESENT_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

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
  off(name: string, fn: Handler): this {
    const list = (this.handlers.get(name) ?? []).filter((h) => h !== fn);
    this.handlers.set(name, list);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  count(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }
}

class FakeObject extends FakeEmitter {
  destroyed = false;
  visible = true;
  originX = 0;
  originY = 0;
  interactive = false;
  depth = 0;
  constructor(
    public type: string,
    public x: number,
    public y: number,
  ) {
    super();
  }
  setOrigin(x: number, y?: number): this {
    this.originX = x;
    this.originY = y ?? x;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setInteractive(): this {
    this.interactive = true;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeText extends FakeObject {
  width: number;
  height = 16;
  constructor(
    x: number,
    y: number,
    public text: string,
    public style: Record<string, unknown>,
  ) {
    super("Text", x, y);
    this.width = text.length * 8;
  }
  setText(t: string): this {
    this.text = t;
    this.width = t.length * 8;
    return this;
  }
  setColor(c: string): this {
    this.style.color = c;
    return this;
  }
}

class FakeContainer extends FakeObject {
  list: FakeObject[] = [];
  constructor(x = 0, y = 0) {
    super("Container", x, y);
  }
  add(child: FakeObject): this {
    this.list.push(child);
    return this;
  }
}

/**
 * 好友面板。⚠ 每次 launch Friend 都是一個新的 —— 這正是坑 1。
 *
 * rexContainerLite：add 保留子物件的世界座標，所以假的 add 也不動座標。
 */
class FakePanel extends FakeContainer {
  active = true;
  FONT_LABEL = { fontFamily: "font_light", fontSize: 12, resolution: 2 };
  // 實測：panel_base 在 380,340、528x408 → 右緣 644
  panel_base: { getBottomRight(): { x: number; y: number } } | undefined = {
    getBottomRight: () => ({ x: 644, y: 544 }),
  };
  panel_filter_label: FakeText | undefined = new FakeText(400, 527, "搜尋", {});
  constructor() {
    super(380, 340);
  }
}

class FakeSocket extends FakeEmitter {}

class FakeStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

interface FakeWindow {
  game: {
    scene: { keys: Record<string, unknown> };
    registry: { get(k: string): unknown };
  };
  lang: string;
  localStorage: FakeStorage;
  [key: string]: unknown;
}

interface FakeFactory {
  text(x: number, y: number, t: string, style: Record<string, unknown>): FakeText;
  container(x: number, y: number): FakeContainer;
  rectangle(x: number, y: number, w: number, h: number, color: number, alpha: number): FakeObject;
}

interface FakeGame {
  window: FakeWindow;
  friend: { is_quest_present: boolean; friend_panel: FakePanel | null; add: FakeFactory };
  quest: { socket: FakeSocket };
  storage: FakeStorage;
  player: { player_name: string; regist_at: string } | null;
  openPanel(present?: boolean): FakePanel;
  closePanel(): void;
  /** 伺服器回 quest_pre（官方 fetch 收到的那一個）。 */
  reply(ok: boolean): void;
  /** 伺服器推 quest_error。 */
  error(code: string): void;
}

function makeGame(): FakeGame {
  const factory: FakeFactory = {
    text: (x, y, t, style) => new FakeText(x, y, t, { ...style }),
    container: (x, y) => new FakeContainer(x, y),
    rectangle: (x, y) => new FakeObject("Rectangle", x, y),
  };
  const storage = new FakeStorage();

  const game: FakeGame = {
    friend: { is_quest_present: true, friend_panel: null, add: factory },
    quest: { socket: new FakeSocket() },
    storage,
    player: { player_name: "不要樂奈", regist_at: "2025-04-24T01:57:22.000Z" },
    window: null as unknown as FakeWindow,
    openPanel(present = true) {
      // ⚠ 舊面板連同我們掛上去的東西一起 destroy —— 客戶端就是這樣。
      game.closePanel();
      game.friend.is_quest_present = present;
      const panel = new FakePanel();
      game.friend.friend_panel = panel;
      return panel;
    },
    closePanel() {
      const old = game.friend.friend_panel;
      if (old) {
        for (const child of old.list) child.destroy();
        old.destroy();
        old.active = false;
      }
      game.friend.friend_panel = null;
    },
    reply(ok) {
      game.quest.socket.emit("quest_pre", ok);
    },
    error(code) {
      game.quest.socket.emit("quest_error", code);
    },
  };

  game.window = {
    game: {
      scene: { keys: { Friend: game.friend, Quest: game.quest } },
      registry: { get: (k: string) => (k === "player" ? game.player : undefined) },
    },
    lang: "tcn",
    localStorage: storage,
  };
  return game;
}

/**
 * 腳本交給 `setInterval` 的那支輪詢。**測試手動代打它，而不是用重裝假裝。**
 *
 * ⚠ 用重裝當輪詢會把一整類 bug 測不到：重裝每次都從乾淨狀態開始，而輪詢是
 * **帶著上一輪的 `st` 跑的** —— 「面板換人了要重掛」「socket 換了要搬監聽」
 * 全都在那個狀態差上。
 */
let poll: (() => void) | null = null;

/**
 * 把腳本丟進去跑。
 *
 * ⚠ 用 `new Function` 而不是 `eval`：跳脫錯了的話這裡會直接丟 SyntaxError，
 * 而那正是要抓的其中一個坑（腳本住在 template literal 裡）。
 */
function run(game: FakeGame, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    w: FakeWindow,
    si: (fn: () => void, ms: number) => number,
    ci: () => void,
  ) => string;
  return fn(
    game.window,
    (cb) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
  );
}

function install(game: FakeGame): string {
  return run(game, buildPresentPatchScript());
}

/** 輪詢跑一輪（＝頁面上那 500ms 到了）。 */
function tick(): void {
  expect(poll).not.toBeNull();
  poll!();
}

function status(game: FakeGame) {
  return parsePresentStatus(run(game, PRESENT_STATUS_EXPRESSION));
}

function ourText(game: FakeGame): FakeText | undefined {
  const panel = game.friend.friend_panel;
  return panel?.list.find((o): o is FakeText => o instanceof FakeText && !o.destroyed);
}

function tooltip(game: FakeGame): FakeContainer | undefined {
  const panel = game.friend.friend_panel;
  return panel?.list.find((o): o is FakeContainer => o instanceof FakeContainer && !o.destroyed);
}

const KEY = "ulr.present.不要樂奈|2025-04-24T01:57:22.000Z";

// ---------------------------------------------------------------------------

describe("好友面板的贈送次數", () => {
  it("畫在下方按鈕列的右端，字體照抄旁邊的標籤", () => {
    const game = makeGame();
    game.openPanel();
    install(game);

    const text = ourText(game)!;
    expect(text).toBeDefined();
    // 右緣 644 往內 8，跟「搜尋」同一條線
    expect(text.x).toBe(636);
    expect(text.y).toBe(527);
    expect(text.originX).toBe(1);
    expect(text.originY).toBe(0.5);
    expect(text.style.fontFamily).toBe("font_light");
    expect(text.style.fontSize).toBe(12);
    expect(text.text).toBe("剩餘贈送: 5/5");
  });

  it("讀不到面板的底圖與標籤時退回量好的座標", () => {
    const game = makeGame();
    const panel = game.openPanel();
    panel.panel_base = undefined;
    panel.panel_filter_label = undefined;
    install(game);

    expect(ourText(game)!.x).toBe(636);
    expect(ourText(game)!.y).toBe(527);
  });

  it("從 FRIENDLIST 鈕開的面板完全不畫", () => {
    const game = makeGame();
    game.openPanel(false);
    install(game);

    expect(ourText(game)).toBeUndefined();
    expect(status(game).mounted).toBe(false);
    // ⚠ 這不是錯誤 —— UI 不該報紅。
    expect(status(game).reason).toBeNull();
  });

  it("送成功才扣；quest_pre 回 false 不扣", () => {
    const game = makeGame();
    game.openPanel();
    install(game);

    game.reply(false);
    expect(status(game).remain).toBe(5);

    game.reply(true);
    expect(status(game).remain).toBe(4);
    expect(ourText(game)!.text).toBe("剩餘贈送: 4/5");
  });

  it("面板送完會關掉，再開時數字還在（存在 localStorage）", () => {
    const game = makeGame();
    game.openPanel();
    install(game);

    // 官方：送成功 → 好友面板關掉
    game.reply(true);
    game.closePanel();
    tick();
    expect(status(game).mounted).toBe(false);

    game.reply(true);
    game.openPanel();
    tick();
    expect(ourText(game)!.text).toBe("剩餘贈送: 3/5");

    // 重載頁面（＝重裝）也記得
    install(game);
    expect(status(game).remain).toBe(3);
    expect(JSON.parse(game.storage.getItem(KEY)!).sent).toBe(2);
  });

  it("伺服器說今天不能再送就直接歸零，而且變紅", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    expect(ourText(game)!.style.color).toBe("#ffffff");

    game.error("PRESENT_RECEIVER_FULL");
    expect(status(game).remain).toBe(5);

    game.error("PRESENT_LIMIT");
    expect(ourText(game)!.text).toBe("剩餘贈送: 0/5");
    expect(ourText(game)!.style.color).toBe("#ff7070");
  });

  it("記成滿了卻又送成功 —— 伺服器已經換日，從 1 重新數", () => {
    const game = makeGame();
    game.openPanel();
    install(game);

    game.error("PRESENT_LIMIT");
    game.reply(true);
    expect(status(game).remain).toBe(4);
  });

  it("換日了就從頭數", () => {
    const game = makeGame();
    game.storage.setItem(KEY, JSON.stringify({ day: "2000-01-01", sent: 5, full: true }));
    game.openPanel();
    install(game);

    expect(ourText(game)!.text).toBe("剩餘贈送: 5/5");
  });

  it("台灣時間 03:00 換日：02:59 送的算前一天", () => {
    vi.useFakeTimers();
    try {
      // 台灣 10/10 02:59 ＝ UTC 10/09 18:59
      vi.setSystemTime(new Date("2026-10-09T18:59:00Z"));
      const game = makeGame();
      game.openPanel();
      install(game);
      game.reply(true);
      game.reply(true);
      expect(status(game).remain).toBe(3);

      // 台灣 03:00 —— 伺服器換日
      vi.setSystemTime(new Date("2026-10-09T19:00:00Z"));
      game.openPanel();
      tick();
      expect(ourText(game)!.text).toBe("剩餘贈送: 5/5");

      // 台灣當天 23:30（日本時間已經過午夜）—— 還是同一天
      game.reply(true);
      vi.setSystemTime(new Date("2026-10-10T15:30:00Z"));
      game.openPanel();
      tick();
      expect(ourText(game)!.text).toBe("剩餘贈送: 4/5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("數到超過上限還送得出去，分母跟著頂上去", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    for (let i = 0; i < 6; i++) game.reply(true);

    expect(status(game).max).toBe(6);
    expect(status(game).remain).toBe(0);
  });

  it("不同角色分開記", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    game.reply(true);

    game.player = { player_name: "燈皇", regist_at: "2024-01-01T00:00:00.000Z" };
    game.openPanel();
    tick();
    expect(ourText(game)!.text).toBe("剩餘贈送: 5/5");
  });

  it("還沒登入時不畫假數字", () => {
    const game = makeGame();
    game.player = null;
    game.openPanel();
    install(game);

    expect(status(game).remain).toBeNull();
    expect(ourText(game)!.text).toBe("");
  });

  it("Quest 的 socket 換了，監聽跟著搬過去", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    const old = game.quest.socket;

    game.quest.socket = new FakeSocket();
    tick();
    expect(old.count("quest_pre")).toBe(0);
    expect(old.count("quest_error")).toBe(0);
    expect(game.quest.socket.count("quest_pre")).toBe(1);

    game.reply(true);
    expect(status(game).remain).toBe(4);
  });

  it("重裝不會讓監聽變兩份（送一次只扣一次）", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    install(game);
    install(game);

    expect(game.quest.socket.count("quest_pre")).toBe(1);
    expect(game.quest.socket.count("quest_error")).toBe(1);
    game.reply(true);
    expect(status(game).remain).toBe(4);
  });

  it("面板重開會重新掛上去（舊的跟著舊面板一起死）", () => {
    const game = makeGame();
    const first = game.openPanel();
    install(game);
    const firstText = ourText(game)!;

    game.openPanel();
    // ⚠ 這裡是**輪詢**發現面板換人了，不是重裝。
    tick();

    expect(firstText.destroyed).toBe(true);
    expect(first.active).toBe(false);
    const second = ourText(game)!;
    expect(second).not.toBe(firstText);
    expect(second.text).toBe("剩餘贈送: 5/5");
  });

  it("說明只出現在 tooltip，而且預設是收起來的", () => {
    const game = makeGame();
    game.openPanel();
    install(game);

    const tip = tooltip(game)!;
    expect(tip.visible).toBe(false);

    const text = ourText(game)!;
    expect(text.interactive).toBe(true);
    text.emit("pointerover");
    expect(tip.visible).toBe(true);
    text.emit("pointerout");
    expect(tip.visible).toBe(false);

    const tipText = tip.list.find((o): o is FakeText => o instanceof FakeText)!;
    // 講清楚是本機數的、不是官方伺服器給的；換行要真的是換行（嵌進腳本沒被吃掉）
    expect(tipText.text).toBe(
      "今日剩餘贈送次數（本機記錄）\n不是官方伺服器提供的數字，其他裝置送出的不計入",
    );
  });

  it("面板上那一行跟著語言走，格式照抄「好友人數: 1/15」而且很短", () => {
    for (const [lang, expected] of [
      ["ja", "残り送信: 5/5"],
      ["en", "Gifts left: 5/5"],
      ["kr", "남은 선물: 5/5"],
      ["scn", "剩余赠送: 5/5"],
      ["tcn", "剩餘贈送: 5/5"],
    ] as const) {
      const game = makeGame();
      game.window.lang = lang;
      game.openPanel();
      install(game);
      const shown = ourText(game)!.text;
      expect(shown).toBe(expected);
      expect(shown.split(":")[0]!.length).toBeLessThanOrEqual(11);
    }
  });

  it("狀態帶著版本號，而且沒裝的時候說得出來", () => {
    const game = makeGame();
    expect(status(game).installed).toBe(false);

    game.openPanel();
    install(game);
    expect(status(game).installed).toBe(true);
    expect(status(game).version).toBe(PRESENT_SCRIPT_VERSION);
  });

  it("拆得乾淨：物件、監聽、旗標都不留", () => {
    const game = makeGame();
    game.openPanel();
    install(game);
    const text = ourText(game)!;

    expect(run(game, PRESENT_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(text.destroyed).toBe(true);
    expect(game.quest.socket.count("quest_pre")).toBe(0);
    expect(game.quest.socket.count("quest_error")).toBe(0);
    expect(game.window.__ulrPresent).toBeUndefined();
    expect(run(game, PRESENT_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("讀不懂的回應當成沒裝，原文帶在 reason 裡", () => {
    const parsed = parsePresentStatus("<!doctype html>");
    expect(parsed.installed).toBe(false);
    expect(parsed.reason).toContain("doctype");
  });
});

// ---------------------------------------------------------------------------
// 收到的任務：贈送者（v5）
//
// 形狀照 2026-11-22 對著跑著的客戶端讀到的：
//   Lobby.achievement_data.quest_pre_notice = [{ player_name, stamp_id, quest_id }]
//   registry quest_data = [{ quest_pid, quest_id, is_present, quest_find, is_check }]
//   Quest.quest_list[i]：Container(x=620, y=52+16i)，list_name Text(-82,0)、
//     list_rarity_icon Image(79,0) 16x16、list_zone Zone 264x16
// ---------------------------------------------------------------------------

interface QuestRow extends FakeContainer {
  scene: unknown;
  quest_list_data: Record<string, unknown>;
  list_name: FakeText;
  list_rarity_icon: FakeObject & { displayWidth: number };
  list_zone: FakeObject;
}

function questRow(i: number, data: Record<string, unknown>, name = "夜鬼花園4"): QuestRow {
  const row = new FakeContainer(620, 52 + 16 * i) as QuestRow;
  row.scene = {};
  row.quest_list_data = data;
  row.list_name = new FakeText(-82, 0, name, {
    fontFamily: "font_light",
    fontSize: "11px",
    color: "#fff",
  });
  row.list_name.setOrigin(0, 0.5);
  row.list_rarity_icon = Object.assign(new FakeObject("Image", 79, 0), { displayWidth: 16 });
  row.list_rarity_icon.setOrigin(0.5, 0.5);
  row.list_zone = new FakeObject("Zone", 0, 0);
  const destroy = row.destroy.bind(row);
  row.destroy = () => {
    for (const c of row.list) c.destroy();
    row.scene = null;
    destroy();
  };
  return row;
}

function withQuests(game: FakeGame) {
  const factory: FakeFactory = {
    text: (x, y, t, style) => new FakeText(x, y, t, { ...style }),
    container: (x, y) => new FakeContainer(x, y),
    rectangle: (x, y) => new FakeObject("Rectangle", x, y),
  };
  const quest = game.quest as unknown as { add: FakeFactory; quest_list: QuestRow[] };
  quest.add = factory;
  quest.quest_list = [];
  const lobby: { achievement_data: { quest_pre_notice: unknown[] } | null } = {
    achievement_data: null,
  };
  game.window.game.scene.keys.Lobby = lobby;
  let questData: Record<string, unknown>[] | undefined;
  game.window.game.registry = {
    get: (k: string) => (k === "player" ? game.player : k === "quest_data" ? questData : undefined),
  };
  return {
    quest,
    /** 進大廳：官方 achievement_update 換一份新的回應物件 */
    lobby(notices: unknown[]) {
      lobby.achievement_data = { quest_pre_notice: notices };
    },
    /** 任務清單刷新：registry 換一份新陣列、清單列整批重建 */
    quests(list: Record<string, unknown>[]) {
      questData = list;
      for (const r of quest.quest_list) r.destroy();
      quest.quest_list = list.map((d, i) => questRow(i, d));
    },
  };
}

const GIFT_KEY = "ulr.gifter.不要樂奈|2025-04-24T01:57:22.000Z";
const Q478 = {
  quest_pid: "Wvtp",
  quest_id: 478,
  is_present: true,
  quest_find: "2026-11-21T14:11:03.000Z",
  is_check: 1,
};
const Q1015 = {
  quest_pid: "HOAO",
  quest_id: 1015,
  is_present: true,
  quest_find: "2026-11-21T14:10:57.000Z",
  is_check: 1,
};
const Q461 = {
  quest_pid: "0YTw",
  quest_id: 461,
  is_present: false,
  quest_find: "2026-11-21T00:17:43.000Z",
  is_check: 0,
};

function giftText(row: QuestRow): FakeText | undefined {
  return row.list.find((o): o is FakeText => o instanceof FakeText && !o.destroyed);
}

describe("收到的任務：清單上標贈送者", () => {
  it("大廳通知對到清單上收到的那筆，名字畫在稀有度圖示左邊、字體照抄任務名", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([
      { player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 },
      { player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 1015 },
    ]);
    w.quests([Q461, Q1015, Q478]);
    install(game);

    const [own, a, b] = w.quest.quest_list;
    expect(giftText(own!)).toBeUndefined();
    const t = giftText(b!)!;
    expect(t.text).toBe("莫里亞蒂博士");
    // 稀有度圖示 79、寬 16、置中 → 左緣 71，再空 4
    expect(t.x).toBe(67);
    expect(t.originX).toBe(1);
    expect(t.style.fontSize).toBe("11px");
    expect(giftText(a!)!.text).toBe("莫里亞蒂博士");
    expect(status(game).gifters).toBe(2);
    expect(JSON.parse(game.storage.getItem(GIFT_KEY)!).byPid).toEqual({
      Wvtp: expect.objectContaining({ name: "莫里亞蒂博士" }),
      HOAO: expect.objectContaining({ name: "莫里亞蒂博士" }),
    });
  });

  it("名字不蓋到任務名：放不下就截斷加省略號", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([{ player_name: "一二三四五六七八九十", stamp_id: null, quest_id: 478 }]);
    w.quests([Q478]);
    // 任務名很長：-82 起、寬 8×9=72 → 右緣 -10，留 6 → 名字左緣最多到 -4，右緣 67 → 71 px
    w.quest.quest_list[0]!.list_name.setText("通往王座之路一二三");
    install(game);
    const t = giftText(w.quest.quest_list[0]!)!;
    expect(t.width).toBeLessThanOrEqual(71);
    expect(t.text.endsWith("…")).toBe(true);
  });

  it("hover 掛在官方那一列的 list_zone 上，我們的字不搶點擊", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([{ player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 }]);
    w.quests([Q478]);
    install(game);
    const row = w.quest.quest_list[0]!;
    expect(giftText(row)!.interactive).toBe(false);
    expect(row.list_zone.count("pointerover")).toBe(1);
  });

  it("通知先到、清單後到也對得上；同一份通知重裝不會收兩次", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([{ player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 }]);
    install(game);
    install(game); // 重裝：同一個通知陣列
    expect(JSON.parse(game.storage.getItem(GIFT_KEY)!).pending).toHaveLength(1);

    w.quests([Q478]);
    tick();
    expect(giftText(w.quest.quest_list[0]!)!.text).toBe("莫里亞蒂博士");
    expect(JSON.parse(game.storage.getItem(GIFT_KEY)!).pending).toHaveLength(0);
  });

  it("清單重建（換頁、刷新）後重畫；任務不在清單上了就丟掉記錄", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([{ player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 }]);
    w.quests([Q478]);
    install(game);
    const first = giftText(w.quest.quest_list[0]!)!;

    w.quests([Q461, Q478]);
    tick();
    expect(first.destroyed).toBe(true);
    expect(giftText(w.quest.quest_list[1]!)!.text).toBe("莫里亞蒂博士");

    w.quests([Q461]); // 打完了
    tick();
    expect(JSON.parse(game.storage.getItem(GIFT_KEY)!).byPid).toEqual({});
    expect(status(game).gifters).toBe(0);
  });

  it("同一張任務兩個人各送一次：照通知順序配發現時刻早的", () => {
    const game = makeGame();
    const w = withQuests(game);
    const early = { ...Q478, quest_pid: "early", quest_find: "2026-11-21T10:00:00.000Z" };
    const late = { ...Q478, quest_pid: "late", quest_find: "2026-11-21T12:00:00.000Z" };
    w.lobby([
      { player_name: "甲", stamp_id: null, quest_id: 478 },
      { player_name: "乙", stamp_id: null, quest_id: 478 },
    ]);
    w.quests([late, early]);
    install(game);
    const byPid = JSON.parse(game.storage.getItem(GIFT_KEY)!).byPid;
    expect(byPid.early.name).toBe("甲");
    expect(byPid.late.name).toBe("乙");
  });

  it("拆除時名字、說明、hover 都收掉", () => {
    const game = makeGame();
    const w = withQuests(game);
    w.lobby([{ player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 }]);
    w.quests([Q478]);
    install(game);
    const row = w.quest.quest_list[0]!;
    const t = giftText(row)!;
    expect(run(game, PRESENT_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(t.destroyed).toBe(true);
    expect(row.list_zone.count("pointerover")).toBe(0);
  });
});
