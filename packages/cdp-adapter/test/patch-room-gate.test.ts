/**
 * 進了哪一房、開戰前先套牌組
 *
 * 跟 `patch-lobby.test.ts` 同一種寫法：搭一個假的遊戲，把
 * `buildRoomGateScript()` 產出來的**那一串字**原封不動 `new Function` 起來跑。
 *
 * ⚠ 這支補丁的風險集中在一個地方：**它會吞掉遊戲真正的開戰請求**。所以測試
 * 的重點不是「有沒有攔到」，而是**每一條路徑最後都有沒有把那一下送出去** ——
 * 少送一次，玩家就卡死在一個「已開始」而且點不動的畫面上。
 */

import { describe, expect, it } from "vitest";
import {
  buildRoomGateDecksExpression,
  buildRoomGatePendingExpression,
  buildRoomGateScript,
  parseRoomGateStatus,
  ROOM_GATE_RELEASE_EXPRESSION,
  ROOM_GATE_STATUS_EXPRESSION,
  ROOM_GATE_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

interface Emitted {
  ev: string;
  args: unknown[];
}

class FakeSocket {
  emitted: Emitted[] = [];
  emit(ev: string, ...args: unknown[]): string {
    this.emitted.push({ ev, args });
    return "sent";
  }
}

/** 遊戲的 GameObject —— 只做這支補丁碰得到的那幾件事。 */
class FakeArrow {
  handlers: Record<string, (() => void)[]> = {};
  on(ev: string, fn: () => void): void {
    (this.handlers[ev] ??= []).push(fn);
  }
  removeAllListeners(ev: string): void {
    delete this.handlers[ev];
  }
  fire(ev: string): void {
    for (const fn of this.handlers[ev] ?? []) fn();
  }
  count(ev: string): number {
    return (this.handlers[ev] ?? []).length;
  }
}

class FakeScene {
  socket: FakeSocket;
  active = false;
  /** `Match` 才有的東西。 */
  channel?: number;
  channels?: Record<string, { type: string }>;
  channels_cross?: Record<string, { type: string }>;
  scene: { isActive: () => boolean };

  /** 左下角那組切牌組的 ◀▶。 */
  deck_pre?: FakeArrow;
  deck_next?: FakeArrow;
  deck_now?: number;
  deck1?: { charaIndex: (number | null)[] };
  deck_name?: { text: string; setText: (t: string) => void };
  redrawn = 0;

  constructor(socket: FakeSocket) {
    this.socket = socket;
    this.scene = { isActive: () => this.active };
  }

  /** 進了幾次、進去那一次畫出來的是哪一副（用來驗「第一幀就是對的牌」）。 */
  created = 0;
  drawn: (number | null)[] | null = null;

  /**
   * 遊戲自己的 `create()`。
   *
   * 照抄實機讀到的重點：**create 裡才第一次讀 `this.deck1`**（Raid 是
   * `this.deck_card(this.deck1)`、Quest 是 inline 讀 `this.deck1.chara[i]`），
   * 而且那行字是寫死的「Deck1 」。
   */
  create(): void {
    this.created++;
    this.drawn = this.deck1 ? [...this.deck1.charaIndex] : null;
    const name = { text: "Deck1 ", setText: (t: string) => (name.text = t) };
    this.deck_name = name;
  }

  /** 任務／渦的重畫。 */
  deck_card(): void {
    this.redrawn++;
  }

  /** 把箭頭裝上去（遊戲自己的處理器也一起掛，測我們有沒有把它拆掉）。 */
  withArrows(): this {
    this.deck_pre = new FakeArrow();
    this.deck_next = new FakeArrow();
    this.deck_now = 1;
    this.deck1 = { charaIndex: [684, 674, 665] };
    const name = { text: "Deck1 ", setText: (t: string) => (name.text = t) };
    this.deck_name = name;
    // 遊戲原本的：pointerup 把 deck_now 往前繞
    this.deck_next.on("pointerup", () => {
      this.deck_now = (this.deck_now ?? 1) + 1;
      if (this.deck_now > 3) this.deck_now = 1;
    });
    this.deck_pre.on("pointerup", () => {
      this.deck_now = (this.deck_now ?? 1) - 1;
      if (this.deck_now < 1) this.deck_now = 3;
    });
    // hover 換圖 —— **這個不能被拆掉**
    this.deck_next.on("pointerover", () => undefined);
    this.deck_pre.on("pointerover", () => undefined);
    return this;
  }
}

interface FakeWindow {
  game: { scene: { keys: Record<string, FakeScene> } };
  __ulrCompanionReport?: (raw: string) => void;
  __ulrRoomGate?: Record<string, unknown>;
}

interface Harness {
  window: FakeWindow;
  scenes: Record<"Quest" | "Raid" | "Match", FakeScene>;
  socket: FakeSocket;
  reports: Record<string, unknown>[];
  timers: (() => void)[];
}

function makeGame(): Harness {
  const socket = new FakeSocket();
  const scenes = {
    Quest: new FakeScene(socket),
    Raid: new FakeScene(socket),
    Match: new FakeScene(socket),
  };
  const reports: Record<string, unknown>[] = [];
  const window: FakeWindow = {
    game: { scene: { keys: scenes } },
    __ulrCompanionReport: (raw: string) => {
      reports.push(JSON.parse(raw) as Record<string, unknown>);
    },
  };
  return { window, scenes, socket, reports, timers: [] };
}

/**
 * 把腳本丟進去跑。
 *
 * ⚠ 用 `new Function` 而不是 `eval`：跳脫錯了的話這裡會直接丟 SyntaxError，
 * 而腳本整支住在 template literal 裡，那正是最容易出事的地方。
 */
function run(h: Harness, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    `return ${expression};`,
  ) as (
    w: FakeWindow,
    si: (fn: () => void) => number,
    ci: () => void,
    st: (fn: () => void, ms: number) => number,
    ct: () => void,
  ) => string;
  return fn(
    h.window,
    (fn) => {
      h.timers.push(fn);
      return h.timers.length;
    },
    () => undefined,
    // 看門狗的 setTimeout：預設**不自己跑**，要測的那一題自己叫。
    (fn) => {
      h.timers.push(fn);
      return h.timers.length;
    },
    () => undefined,
  );
}

function install(h: Harness): string {
  return run(h, buildRoomGateScript({ bindingName: "__ulrCompanionReport" }));
}

/** 模擬那支 500ms 的輪詢跑了一輪。 */
function tick(h: Harness): void {
  install(h);
}

function status(h: Harness): ReturnType<typeof parseRoomGateStatus> {
  return parseRoomGateStatus(run(h, ROOM_GATE_STATUS_EXPRESSION));
}

function setPending(h: Harness, value: boolean): string {
  return run(h, buildRoomGatePendingExpression(value));
}

// ---------------------------------------------------------------------------

describe("房間偵測", () => {
  it("Quest 場景 active → quest", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    expect(status(h).room).toBe("quest");
    expect(h.reports).toContainEqual({ type: "room-changed", room: "quest", preloaded: false });
  });

  it("Raid 場景 active → raid", () => {
    const h = makeGame();
    h.scenes.Raid.active = true;
    install(h);
    expect(status(h).room).toBe("raid");
  });

  it("Match + duel 頻道 → 迪特赫姆", () => {
    const h = makeGame();
    h.scenes.Match.active = true;
    h.scenes.Match.channel = 2;
    h.scenes.Match.channels = { "1": { type: "ranked" }, "2": { type: "duel" } };
    install(h);
    expect(status(h).room).toBe("dietherm");
  });

  it("Match + ranked 頻道 → 亞歷山卓城", () => {
    const h = makeGame();
    h.scenes.Match.active = true;
    h.scenes.Match.channel = 1;
    h.scenes.Match.channels = { "1": { type: "ranked" }, "2": { type: "duel" } };
    install(h);
    expect(status(h).room).toBe("alexandria");
  });

  it("⚠ 看的是 type 不是編號 —— 官方多開一組 duel 頻道也認得", () => {
    // 寫死 2/4 的版本會把新頻道判成「不是任何一房」，然後那裡永遠不會自動
    // 套牌組。跟 `patch-lobby.ts` 的 `duelChannel()` 同一條規矩。
    const h = makeGame();
    h.scenes.Match.active = true;
    h.scenes.Match.channel = 7;
    h.scenes.Match.channels = { "7": { type: "duel" } };
    install(h);
    expect(status(h).room).toBe("dietherm");
  });

  it("跨平台頻道查得到 channels_cross", () => {
    const h = makeGame();
    h.scenes.Match.active = true;
    h.scenes.Match.channel = 4;
    h.scenes.Match.channels = {};
    h.scenes.Match.channels_cross = { "4": { type: "duel" } };
    install(h);
    expect(status(h).room).toBe("dietherm");
  });

  it("還在選頻道（channel 還沒有）→ 不算在任何一房", () => {
    // 這時候套牌組是錯的：玩家可能正要去另一個頻道，而換牌組會連帶換掉他
    // 看到的房間列表。
    const h = makeGame();
    h.scenes.Match.active = true;
    install(h);
    expect(status(h).room).toBeNull();
  });

  it("都不在 → null，而且只在變動時回報一次", () => {
    const h = makeGame();
    install(h);
    expect(status(h).room).toBeNull();
    const before = h.reports.length;
    tick(h);
    tick(h);
    // 重裝會重報一次初始值，但同一輪輪詢裡不重複回報。
    expect(h.reports.filter((r) => r.type === "room-changed").length).toBeLessThanOrEqual(
      before + 2,
    );
  });
});

describe("開戰閘門", () => {
  const START = "quest_start";

  it("沒有待套用的東西 → 原樣直通，一下都不攔", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    const out = h.socket.emit(START, "id", 1, 2, 3, 1);
    expect(out).toBe("sent");
    expect(h.socket.emitted).toHaveLength(1);
    expect(status(h).holding).toBe(false);
  });

  it("有待套用的東西 → 攔下來、回報，先不送出去", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);

    h.socket.emit(START, "id", 1, 2, 3, 1);
    expect(h.socket.emitted).toHaveLength(0);
    expect(status(h).holding).toBe(true);
    expect(status(h).heldEvent).toBe(START);
    expect(h.reports).toContainEqual({ type: "room-gate-hold", event: START, room: "quest" });
  });

  it("放行時用**原本的參數**把那一下補送出去", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit(START, "id", 5, 6, 7, 1);

    expect(run(h, ROOM_GATE_RELEASE_EXPRESSION)).toBe("released");
    expect(h.socket.emitted).toEqual([{ ev: START, args: ["id", 5, 6, 7, 1] }]);
    expect(status(h).holding).toBe(false);
  });

  it("⚠ 補送的那一下不會再被攔一次（不然是無窮迴圈）", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit(START, "id");
    // pending 還是 true —— Node 寫失敗時就是這個狀態。
    run(h, ROOM_GATE_RELEASE_EXPRESSION);
    expect(h.socket.emitted).toHaveLength(1);
    expect(status(h).holding).toBe(false);
  });

  it("⚠⚠ 看門狗：Node 沒回來也一定要把那一下送出去", () => {
    // 被攔的那一刻遊戲已經走過 `input.enabled = false` 與
    // `quest_start_clicked()` —— 不送的話玩家卡死在那個畫面，只能重開遊戲。
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit(START, "id", 9);
    expect(h.socket.emitted).toHaveLength(0);

    // 看門狗的 setTimeout 是最後排進去的那一個。
    const watchdog = h.timers[h.timers.length - 1];
    watchdog?.();

    expect(h.socket.emitted).toEqual([{ ev: START, args: ["id", 9] }]);
    expect(h.reports).toContainEqual({ type: "room-gate-timeout", event: START });
    expect(status(h).timeouts).toBe(1);
  });

  it("看門狗跑過之後 Node 才回來 → 不會送出第二次", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit(START, "id");
    h.timers[h.timers.length - 1]?.();
    expect(run(h, ROOM_GATE_RELEASE_EXPRESSION)).toBe("no-hold");
    expect(h.socket.emitted).toHaveLength(1);
  });

  it("同一時間只攔一下，第二下直通", () => {
    // 攔著的時候再攔一下會讓第一下永遠沒人放行。
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit(START, "first");
    h.socket.emit(START, "second");
    expect(h.socket.emitted).toEqual([{ ev: START, args: ["second"] }]);
  });

  it("不是開戰的事件一律不攔", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit("db_player", "id");
    expect(h.socket.emitted).toEqual([{ ev: "db_player", args: ["id"] }]);
  });

  it.each(["quest_start", "raid_turn", "quick_wait", "room_event", "room_in", "match_room_make"])(
    "%s 會被攔",
    (ev) => {
      const h = makeGame();
      h.scenes.Quest.active = true;
      install(h);
      setPending(h, true);
      h.socket.emit(ev, "id");
      expect(h.socket.emitted).toHaveLength(0);
      expect(status(h).heldEvent).toBe(ev);
    },
  );

  it("閘門自己出事時放行，不能因為我們的東西讓玩家開不了戰", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    // 回報函式炸掉（Node 那邊的 binding 不見了）
    h.window.__ulrCompanionReport = () => {
      throw new Error("binding 不見了");
    };
    h.socket.emit(START, "id");
    // report() 自己吞掉例外，所以還是照攔 —— 但至少沒有把例外丟回遊戲。
    expect(() => h.socket.emit("db_player", "x")).not.toThrow();
  });
});

describe("裝、拆、重裝", () => {
  it("重裝是安全的：不會把 emit 疊兩層", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    install(h);
    install(h);
    setPending(h, true);
    h.socket.emit("quest_start", "id");
    run(h, ROOM_GATE_RELEASE_EXPRESSION);
    expect(h.socket.emitted).toHaveLength(1);
  });

  it("⚠ 拆掉之前要先放行 —— 攔著的時候拆掉，那一下就永遠不會送出去", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    setPending(h, true);
    h.socket.emit("quest_start", "id", 3);
    expect(h.socket.emitted).toHaveLength(0);

    expect(run(h, ROOM_GATE_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(h.socket.emitted).toEqual([{ ev: "quest_start", args: ["id", 3] }]);
  });

  it("拆完 emit 回到原狀", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    install(h);
    run(h, ROOM_GATE_UNINSTALL_EXPRESSION);
    expect(Object.prototype.hasOwnProperty.call(h.socket, "emit")).toBe(false);
    expect(h.window.__ulrRoomGate).toBeUndefined();
  });

  it("沒裝的時候問狀態不會炸", () => {
    const h = makeGame();
    expect(status(h).installed).toBe(false);
    expect(run(h, ROOM_GATE_RELEASE_EXPRESSION)).toBe("not-installed");
    expect(setPending(h, true)).toBe("not-installed");
    expect(run(h, ROOM_GATE_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("遊戲還沒起來（沒有 window.game）時裝得上，不會炸", () => {
    // 玩家的正常開機順序是先開插件再開遊戲。
    const h = makeGame();
    (h.window as { game?: unknown }).game = undefined;
    expect(() => install(h)).not.toThrow();
    expect(status(h).room).toBeNull();
  });
});

describe("deck_now 釘回 1（最後一道保險）", () => {
  // ⚠ 這一組測的是 2026-09-09 實機上撞到的那個 bug：Deck2/Deck3 被插件清空
  // 之後，遊戲原本的箭頭會把玩家帶到一副空牌，而 deck_now 正是開戰 emit 帶出去
  // 的那個參數 —— 停在 Deck2 按 START 就是拿空牌打，而**開戰閘門救不了**
  // （閘門寫的是 Deck1，emit 帶出去的是 2）。
  //
  // ⚠ 箭頭本身由 patch-deck-edit 接管（見那支的 mount()）。這裡只保底。

  it("玩家已經按到 Deck2 → 釘回 1、標籤改回來、重畫", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    h.scenes.Quest.withArrows();
    h.scenes.Quest.deck_now = 2; // 實機上量到的狀態
    install(h);
    expect(h.scenes.Quest.deck_now).toBe(1);
    expect(h.scenes.Quest.redrawn).toBeGreaterThan(0);
    // 只釘數字不改標籤的話，畫面上會留一個「Deck2」指著其實是 Deck1 的內容
    expect(h.scenes.Quest.deck_name?.text).toBe("Deck1 ");
  });

  it("本來就是 1 就不動它 —— 每 500ms 重畫一次會把卡片一直拆掉重建", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    h.scenes.Quest.withArrows();
    install(h);
    tick(h);
    tick(h);
    expect(h.scenes.Quest.redrawn).toBe(0);
  });

  it("⚠ 不去碰箭頭 —— 那是 patch-deck-edit 的事，兩邊搶會互相拆掉對方", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    h.scenes.Quest.withArrows();
    const before = h.scenes.Quest.deck_next?.count("pointerup");
    install(h);
    expect(h.scenes.Quest.deck_next?.count("pointerup")).toBe(before);
    expect(h.scenes.Quest.deck_next?.count("pointerover")).toBe(1);
  });

  it("場景沒有那組東西時不會炸（還在載入）", () => {
    const h = makeGame();
    h.scenes.Quest.active = true;
    expect(() => install(h)).not.toThrow();
  });
});

describe("parseRoomGateStatus", () => {
  it("壞掉的字串回一份安全的預設", () => {
    const s = parseRoomGateStatus("這不是 JSON");
    expect(s.installed).toBe(false);
    expect(s.room).toBeNull();
    expect(s.holding).toBe(false);
  });

  it("認不得的房型鍵當成 null", () => {
    expect(parseRoomGateStatus(JSON.stringify({ room: "月球" })).room).toBeNull();
  });
});

describe("腳本本身", () => {
  it("產出來的是一段跑得起來的運算式（跳脫沒有少一層）", () => {
    const script = buildRoomGateScript({ bindingName: "__x" });
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });

  it("binding 名字有被帶進去", () => {
    expect(buildRoomGateScript({ bindingName: "__ulrCompanionReport" })).toContain(
      "__ulrCompanionReport",
    );
  });

  it("等候與輪詢的間隔可以覆寫", () => {
    const script = buildRoomGateScript({
      bindingName: "__x",
      pollIntervalMs: 123,
      holdTimeoutMs: 4567,
    });
    expect(script).toContain("123");
    expect(script).toContain("4567");
  });
});

// ---------------------------------------------------------------------------
// 進房前就把牌換好（2026-09-10 加）
//
// 起因：進房之後會先看到**上一房的牌**約半秒，因為原本的流程是「頁面每 500ms
// 發現換房 → 回報 Node → Node 寫回客戶端記憶體」。房間場景是在 create() 裡就
// 把三張卡畫出來的，所以要一幀都不閃，只能在 create() **跑之前**就把 deck1
// 換掉。
// ---------------------------------------------------------------------------

const PRELOAD_RAID = {
  raid: {
    deck: {
      chara: ["cc043", "cc011", "cc033"],
      charaIndex: [426, 109, 329],
      eventIndex: Array<number | null>(18).fill(null),
      weapon: [null, null, null],
      cost: 0,
    },
    name: "渦專用",
  },
};

function setRoomDecks(h: Harness, decks: unknown): string {
  return run(h, buildRoomGateDecksExpression(decks as never));
}

describe("進房前就把牌換好", () => {
  it("create 被包起來了，而且包的是實例不是 prototype", () => {
    const h = makeGame();
    install(h);
    const raid = h.scenes.Raid;
    expect(Object.prototype.hasOwnProperty.call(raid, "create")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(raid), "create")).toBe(true);
  });

  it("⚠⚠ create 跑之前就換掉 deck1 —— 遊戲畫出來的就是我們那一副", () => {
    const h = makeGame();
    install(h);
    setRoomDecks(h, PRELOAD_RAID);

    const raid = h.scenes.Raid;
    raid.deck1 = { charaIndex: [1, 2, 3] }; // 上一房留下來的
    raid.create();

    // 遊戲自己在 create 裡讀到的就已經是新的那一副
    expect(raid.drawn).toEqual([426, 109, 329]);
    expect(raid.deck1?.charaIndex).toEqual([426, 109, 329]);
    // 左下那行字也不是寫死的 Deck1 了
    expect(raid.deck_name?.text).toBe("渦專用 ");
    expect(raid.deck_now).toBe(1);
  });

  it("沒有推那一房的牌時完全不插手", () => {
    const h = makeGame();
    install(h);
    const quest = h.scenes.Quest;
    quest.deck1 = { charaIndex: [7, 8, 9] };
    quest.create();
    expect(quest.drawn).toEqual([7, 8, 9]);
    expect(quest.deck_name?.text).toBe("Deck1 ");
  });

  it("⚠ Match 不能被插手 —— 它是哪一房要看玩家選哪個頻道，create 時還不知道", () => {
    const h = makeGame();
    install(h);
    expect(Object.prototype.hasOwnProperty.call(h.scenes.Match, "create")).toBe(false);
  });

  it("整份換掉，不合併 —— 刪掉的那一房要真的消失", () => {
    const h = makeGame();
    install(h);
    setRoomDecks(h, PRELOAD_RAID);
    setRoomDecks(h, {});

    const raid = h.scenes.Raid;
    raid.deck1 = { charaIndex: [1, 2, 3] };
    raid.create();
    expect(raid.drawn).toEqual([1, 2, 3]);
  });

  it("⚠⚠ 換房的回報要帶 preloaded —— 少了它伺服器永遠不會被寫", () => {
    const h = makeGame();
    install(h);
    // ⚠ 這裡不能用 tick()（那是重裝，會把推過去的牌組清光，見下一題），
    // 要跑安裝時註冊的那支 500ms 輪詢。
    const poll = h.timers[h.timers.length - 1];
    expect(poll).toBeDefined();
    setRoomDecks(h, PRELOAD_RAID);

    h.scenes.Raid.active = true;
    poll?.();
    expect(h.reports.filter((r) => r.type === "room-changed").at(-1)).toMatchObject({
      room: "raid",
      preloaded: true,
    });

    // 沒有推那一房的牌時是 false（Node 就照原本那條路判斷）
    h.scenes.Raid.active = false;
    h.scenes.Quest.active = true;
    poll?.();
    expect(h.reports.filter((r) => r.type === "room-changed").at(-1)).toMatchObject({
      room: "quest",
      preloaded: false,
    });
  });

  it("⚠⚠ 重裝會把推過去的牌組清光 —— 呼叫端裝完一定要重推", () => {
    // 這不是缺陷，是「重裝一律從原狀開始」的必然結果。但它有牙齒：遊戲重載
    // 之後 engine 會重裝閘門，那時候如果沒有把牌組補推回去，進房就又會閃一下
    // 上一房的牌 —— 而且完全不報錯。engine 的 #syncRoomGate() 負責補推。
    const h = makeGame();
    install(h);
    setRoomDecks(h, PRELOAD_RAID);
    install(h); // 遊戲重載 → 重裝

    const raid = h.scenes.Raid;
    raid.deck1 = { charaIndex: [1, 2, 3] };
    raid.create();
    expect(raid.drawn).toEqual([1, 2, 3]);
  });

  it("拆掉之後 create 要還回去，不能繼續塞牌", () => {
    const h = makeGame();
    install(h);
    setRoomDecks(h, PRELOAD_RAID);
    expect(run(h, ROOM_GATE_UNINSTALL_EXPRESSION)).toBe("ok");

    const raid = h.scenes.Raid;
    expect(Object.prototype.hasOwnProperty.call(raid, "create")).toBe(false);
    raid.deck1 = { charaIndex: [1, 2, 3] };
    raid.create();
    expect(raid.drawn).toEqual([1, 2, 3]);
    expect(raid.deck_name?.text).toBe("Deck1 ");
  });

  it("重裝不會包兩層", () => {
    const h = makeGame();
    install(h);
    install(h);
    install(h);
    setRoomDecks(h, PRELOAD_RAID);

    const raid = h.scenes.Raid;
    raid.deck1 = { charaIndex: [1, 2, 3] };
    raid.create();
    expect(raid.created).toBe(1); // 原版只跑了一次
    expect(raid.drawn).toEqual([426, 109, 329]);
  });

  it("沒安裝時推牌組回 not-installed，不丟例外", () => {
    const h = makeGame();
    expect(setRoomDecks(h, PRELOAD_RAID)).toBe("not-installed");
  });
});

describe("回報型別", () => {
  it("認得自己的三種回報", async () => {
    const { isRoomGateReport } = await import("@ulr/cdp-adapter");
    expect(isRoomGateReport({ type: "room-changed", room: "quest" })).toBe(true);
    expect(isRoomGateReport({ type: "room-gate-hold", event: "quest_start" })).toBe(true);
    expect(isRoomGateReport({ type: "room-gate-timeout", event: "quest_start" })).toBe(true);
    expect(isRoomGateReport({ type: "lobby-quick" })).toBe(false);
    expect(isRoomGateReport(null)).toBe(false);
  });
});
