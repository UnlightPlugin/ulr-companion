/**
 * 進了哪一房、開戰前先套牌組（2026-09-24 改版後的客戶端）
 *
 * 搭一個假的遊戲，把 `buildRoomGateScript()` 產出來的**那一串字**原封不動
 * `new Function` 起來跑。
 *
 * ⚠ 這支補丁的風險集中在一個地方：**它會吞掉遊戲真正的開戰請求**。所以測試的
 * 重點不是「有沒有攔到」，而是**每一條路徑最後都有沒有把那一下送出去** ——
 * 少送一次，玩家就卡死在一個「已開始」而且點不動的畫面上。
 */

import { describe, expect, it } from "vitest";
import {
  buildRoomGateDecksExpression,
  buildRoomGatePendingExpression,
  buildRoomGateReleaseExpression,
  buildRoomGateScript,
  GATED_EVENTS,
  parseRoomGateStatus,
  ROOM_GATE_RELEASE_EXPRESSION,
  ROOM_GATE_STATUS_EXPRESSION,
  ROOM_GATE_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";
import type { RoomDeckPreload, RoomGateDecks } from "@ulr/cdp-adapter";

// ---------------------------------------------------------------------------
// 假的遊戲
// ---------------------------------------------------------------------------

interface Fetched {
  ev: string;
  args: unknown[];
}

/** 改版後的 WSClient：開戰全部是 fetch，回 Promise。 */
class FakeSocket {
  fetched: Fetched[] = [];
  fetch(ev: string, ...args: unknown[]): Promise<string> {
    this.fetched.push({ ev, args });
    return Promise.resolve(`ok:${ev}`);
  }
}

interface Deck {
  deck_id: number;
  main: number;
  chara_card_id: (number | null)[];
  weapon_card_id: (number | null)[];
  event_card_id: (number | null)[];
  card_effect: unknown[];
  cost: number;
}

function deckOf(id: number, first: number | null): Deck {
  return {
    deck_id: id,
    main: id === 1 ? 1 : 0,
    chara_card_id: [first, null, null],
    weapon_card_id: [null, null, null],
    event_card_id: new Array<number | null>(18).fill(null),
    card_effect: [],
    cost: 0,
  };
}

class FakeScene {
  socket = new FakeSocket();
  socket_channel?: FakeSocket;
  active = false;
  scene: { isActive: () => boolean };
  deck_now = 1;
  deck: Deck[];
  /** Match 才有：頻道物件本身（改版後 channel_login 直接 this.channel = t）。 */
  channel: Record<string, unknown> | null = null;
  deck_name = { text: "Deck1", setText: (t: string) => (this.deck_name.text = t) };
  deck_card: unknown[] = [];
  created = 0;
  /** create 那一刻畫出來的是哪一副（驗「第一幀就是對的牌」）。 */
  drawn: (number | null)[] | null = null;
  redraws = 0;
  logins = 0;

  constructor(deck: Deck[]) {
    this.deck = deck;
    this.scene = { isActive: () => this.active };
  }

  /** 遊戲自己的 create()：show_deck 在這裡第一次畫。 */
  create(): void {
    this.created++;
    this.show_deck();
    this.drawn = [...(this.deck.find((d) => d.deck_id === this.deck_now)?.chara_card_id ?? [])];
  }

  /** 改版後房間的重畫：那行字寫回 DeckN。 */
  show_deck(): void {
    this.redraws++;
    this.deck_name.setText(`Deck${this.deck_now}`);
  }

  /** Match：選頻道。 */
  async channel_login(t: Record<string, unknown>): Promise<void> {
    this.logins++;
    this.channel = t;
    this.socket_channel = new FakeSocket();
  }
}

interface FakeWindow {
  game: {
    scene: { keys: Record<string, FakeScene> };
    registry: { get: (k: string) => unknown };
  };
  __ulrCompanionReport?: (raw: string) => void;
  __ulrRoomGate?: Record<string, unknown>;
  __ulrDeckMirror?: { server: Deck[] | null };
  __ulrDeckEdit?: { costFor: (content: unknown, custom: boolean) => number | null };
}

interface Harness {
  window: FakeWindow;
  scenes: Record<"Quest" | "Raid" | "Match", FakeScene>;
  registry: { deck: Deck[] };
  reports: Record<string, unknown>[];
  /** 看門狗（setTimeout）。 */
  timers: (() => void)[];
  /** 輪詢（setInterval），最後一個是現役的那支。 */
  intervals: (() => void)[];
}

function makeGame(): Harness {
  const registry = { deck: [deckOf(1, 685), deckOf(2, 10), deckOf(3, 20)] };
  // 每個場景 init() 都是 this.deck = registry.get("deck") —— 同一個參照
  const scenes = {
    Quest: new FakeScene(registry.deck),
    Raid: new FakeScene(registry.deck),
    Match: new FakeScene(registry.deck),
  };
  const reports: Record<string, unknown>[] = [];
  const window: FakeWindow = {
    game: {
      scene: { keys: scenes },
      registry: { get: (k: string) => (registry as Record<string, unknown>)[k] },
    },
    __ulrCompanionReport: (raw: string) => {
      reports.push(JSON.parse(raw) as Record<string, unknown>);
    },
    // 伺服器那份一開始跟客戶端一樣（官方剛拉過）
    __ulrDeckMirror: { server: JSON.parse(JSON.stringify(registry.deck)) as Deck[] },
  };
  return { window, scenes, registry, reports, timers: [], intervals: [] };
}

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
    (f) => (h.intervals.push(f), h.intervals.length),
    () => undefined,
    // 看門狗的 setTimeout：預設不自己跑，要測的那一題自己叫。
    (f) => (h.timers.push(f), h.timers.length),
    () => undefined,
  );
}

const install = (h: Harness): string =>
  run(h, buildRoomGateScript({ bindingName: "__ulrCompanionReport" }));
/** 模擬那支 500ms 的輪詢跑了一輪。 */
const tick = (h: Harness): void => h.intervals[h.intervals.length - 1]!();
const status = (h: Harness) => parseRoomGateStatus(run(h, ROOM_GATE_STATUS_EXPRESSION));
const setPending = (h: Harness, v: boolean): string => run(h, buildRoomGatePendingExpression(v));
const setDecks = (h: Harness, payload: RoomGateDecks): string =>
  run(h, buildRoomGateDecksExpression(payload));

/** 插件模式：那一房只換第 1 格、deck_now 釘 1。 */
function pluginPreload(first: number, name = "渦用"): RoomDeckPreload {
  return {
    slots: [
      {
        deckId: 1,
        chara_card_id: [first, null, null],
        weapon_card_id: [null, null, null],
        event_card_id: new Array<number | null>(18).fill(null),
      },
    ],
    pin: 1,
    names: { "1": name },
  };
}

/** 官方三牌組模式：三格一起換、deck_now 不動。 */
function officialPreload(firsts: [number, number, number]): RoomDeckPreload {
  return {
    slots: firsts.map((f, i) => ({
      deckId: i + 1,
      chara_card_id: [f, null, null],
      weapon_card_id: [null, null, null],
      event_card_id: new Array<number | null>(18).fill(null),
    })),
    pin: null,
    names: { "1": "甲", "2": "乙", "3": "丙" },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

describe("房間偵測", () => {
  it("任務／渦 → quest／raid；什麼都沒開 → null", () => {
    const h = makeGame();
    install(h);
    expect(status(h).room).toBeNull();
    h.scenes.Quest.active = true;
    expect(status(h).room).toBe("quest");
    h.scenes.Quest.active = false;
    h.scenes.Raid.active = true;
    expect(status(h).room).toBe("raid");
  });

  it("Match：頻道物件有 type 就看 type（duel = 迪城）", () => {
    const h = makeGame();
    install(h);
    h.scenes.Match.active = true;
    expect(status(h).room).toBeNull(); // 還在選頻道
    h.scenes.Match.channel = { channel: 2, type: "duel" };
    expect(status(h).room).toBe("dietherm");
    h.scenes.Match.channel = { channel: 1, type: "ranked" };
    expect(status(h).room).toBe("alexandria");
  });

  it("Match：沒有 type 時看 quick —— 亞城有快速比賽，迪城只能開房", () => {
    const h = makeGame();
    install(h);
    h.scenes.Match.active = true;
    h.scenes.Match.channel = { channel: 1, quick: true };
    expect(status(h).room).toBe("alexandria");
    h.scenes.Match.channel = { channel: 2, quick: false };
    expect(status(h).room).toBe("dietherm");
  });

  it("換房就回報 room-changed，同一房不重報", () => {
    const h = makeGame();
    install(h);
    h.scenes.Raid.active = true;
    tick(h);
    tick(h);
    expect(h.reports.filter((r) => r["type"] === "room-changed")).toEqual([
      { type: "room-changed", room: "raid", preloaded: false },
    ]);
  });
});

describe("開戰閘門", () => {
  /** 渦房、插件模式、這一房有指派牌組，而且客戶端那份跟伺服器那份不一樣。 */
  function armed(): Harness {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685) } });
    h.scenes.Raid.active = true;
    tick(h);
    h.registry.deck[0]!.chara_card_id = [999, null, null]; // 客戶端換了，伺服器還沒
    return h;
  }

  it("客戶端 ≠ 伺服器 → 攔下來、回報，先不送出去", () => {
    const h = armed();
    void h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(h.scenes.Raid.socket.fetched).toEqual([]);
    expect(h.reports).toContainEqual({ type: "room-gate-hold", event: "raid_start", room: "raid" });
    expect(status(h).holding).toBe(true);
  });

  it("放行時用**原本的參數**送出去，結果原樣交回給遊戲", async () => {
    const h = armed();
    const p = h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(run(h, ROOM_GATE_RELEASE_EXPRESSION)).toBe("released");
    await expect(p).resolves.toBe("ok:raid_start");
    expect(h.scenes.Raid.socket.fetched).toEqual([{ ev: "raid_start", args: [7, 1, 1] }]);
  });

  it("⚠⚠ 看門狗：Node 沒回來也一定要把那一下送出去", async () => {
    const h = armed();
    const p = h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    for (const t of [...h.timers]) t(); // 時間到（也順便跑到輪詢，無妨）
    await expect(p).resolves.toBe("ok:raid_start");
    expect(h.reports).toContainEqual({ type: "room-gate-timeout", event: "raid_start" });
  });

  it("客戶端跟伺服器一樣 → 原樣直通，一趟都不多", async () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685) } });
    h.scenes.Raid.active = true;
    tick(h);
    await h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(h.scenes.Raid.socket.fetched).toHaveLength(1);
    expect(h.reports.some((r) => r["type"] === "room-gate-hold")).toBe(false);
  });

  it("伺服器那份還沒記過 → 攔（Node 會去讀一次）", () => {
    const h = makeGame();
    delete h.window.__ulrDeckMirror;
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685) } });
    h.scenes.Raid.active = true;
    tick(h);
    void h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(status(h).holding).toBe(true);
  });

  it("關閉模式、或這一房沒有指派牌組 → 不攔", async () => {
    for (const payload of [
      { mode: "off", decks: { raid: pluginPreload(685) } },
      { mode: "plugin", decks: {} },
    ] as RoomGateDecks[]) {
      const h = makeGame();
      install(h);
      setDecks(h, payload);
      h.scenes.Raid.active = true;
      tick(h);
      h.registry.deck[0]!.chara_card_id = [999, null, null];
      await h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
      expect(h.scenes.Raid.socket.fetched).toHaveLength(1);
    }
  });

  it("Node 說有東西排著隊 → 就算兩份一樣也攔", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685) } });
    h.scenes.Raid.active = true;
    tick(h);
    setPending(h, true);
    void h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(status(h).holding).toBe(true);
  });

  it("同一時間只攔一下，第二下直通", async () => {
    const h = armed();
    void h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    await h.scenes.Raid.socket.fetch("raid_start", 8, 1, 1);
    expect(h.scenes.Raid.socket.fetched).toEqual([{ ev: "raid_start", args: [8, 1, 1] }]);
  });

  it("⚠ Node 說寫不進去（ok=false）→ 這一房換房之前不再攔", async () => {
    const h = armed();
    void h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    run(h, buildRoomGateReleaseExpression(false));
    await h.scenes.Raid.socket.fetch("raid_start", 8, 1, 1);
    expect(h.scenes.Raid.socket.fetched).toHaveLength(2);
    // 換房再回來就重新開始攔
    h.scenes.Raid.active = false;
    h.scenes.Quest.active = true;
    tick(h);
    h.scenes.Quest.active = false;
    h.scenes.Raid.active = true;
    tick(h);
    void h.scenes.Raid.socket.fetch("raid_start", 9, 1, 1);
    expect(status(h).holding).toBe(true);
  });

  it("五個開戰入口都攔得到，其他請求照常", async () => {
    expect([...GATED_EVENTS].sort()).toEqual(
      ["create_room", "enter_room", "quest_start", "quick_room", "raid_start"].sort(),
    );
    const h = armed();
    await h.scenes.Raid.socket.fetch("db_raid", 1);
    expect(h.scenes.Raid.socket.fetched).toHaveLength(1);
  });

  it("Match 攔的是頻道那條連線（socket_channel）", async () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { dietherm: pluginPreload(685, "迪城用") } });
    h.scenes.Match.active = true;
    await h.scenes.Match.channel_login({ channel: 2, type: "duel" });
    tick(h);
    h.registry.deck[0]!.chara_card_id = [999, null, null];
    void h.scenes.Match.socket_channel!.fetch("create_room", 1, 2, {});
    expect(h.scenes.Match.socket_channel!.fetched).toEqual([]);
    expect(status(h).holding).toBe(true);
  });
});

describe("進房前就把牌換好", () => {
  it("⚠⚠ create 跑之前就換掉那一格 —— 遊戲畫出來的就是我們那一副", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(777) } });
    h.scenes.Raid.active = true;
    h.scenes.Raid.create();
    expect(h.scenes.Raid.drawn).toEqual([777, null, null]);
    // 就地改：registry 那個陣列還是同一個，其他場景看得到
    expect(h.registry.deck[0]!.chara_card_id).toEqual([777, null, null]);
    expect(h.scenes.Quest.deck).toBe(h.registry.deck);
  });

  it("⚠⚠ 換房回報要帶 preloaded —— 少了它伺服器永遠不會被寫", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(777) } });
    h.scenes.Raid.active = true;
    h.scenes.Raid.create();
    expect(h.reports).toContainEqual({ type: "room-changed", room: "raid", preloaded: true });
  });

  it("插件模式：deck_now 釘 1、左下那行字換成牌組名", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { quest: pluginPreload(777, "任務用") } });
    h.scenes.Quest.deck_now = 3;
    h.scenes.Quest.active = true;
    h.scenes.Quest.create();
    expect(h.scenes.Quest.deck_now).toBe(1);
    expect(h.scenes.Quest.deck_name.text).toBe("任務用");
  });

  it("官方三牌組模式：三格一起換，deck_now 不動", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "official", decks: { quest: officialPreload([101, 102, 103]) } });
    h.scenes.Quest.deck_now = 2;
    h.scenes.Quest.active = true;
    h.scenes.Quest.create();
    expect(h.registry.deck.map((d) => d.chara_card_id[0])).toEqual([101, 102, 103]);
    expect(h.scenes.Quest.deck_now).toBe(2);
    expect(h.scenes.Quest.deck_name.text).toBe("乙");
  });

  it("那一房沒有推牌 → 不碰牌組，但房型照樣回報（preloaded=false）", () => {
    const h = makeGame();
    install(h);
    h.scenes.Quest.active = true;
    h.scenes.Quest.create();
    expect(h.registry.deck[0]!.chara_card_id).toEqual([685, null, null]);
    expect(h.reports).toContainEqual({ type: "room-changed", room: "quest", preloaded: false });
  });

  it("COST 用牌盒那支算的價補進去（迪城自訂、其餘官方）", async () => {
    const h = makeGame();
    const calls: boolean[] = [];
    h.window.__ulrDeckEdit = { costFor: (_c, custom) => (calls.push(custom), custom ? 92 : 91) };
    install(h);
    setDecks(h, {
      mode: "plugin",
      decks: { dietherm: pluginPreload(777), alexandria: pluginPreload(778) },
    });
    h.scenes.Match.active = true;
    await h.scenes.Match.channel_login({ channel: 2, type: "duel" });
    expect(h.registry.deck[0]!.cost).toBe(92);
    await h.scenes.Match.channel_login({ channel: 1, type: "ranked" });
    expect(h.registry.deck[0]!.cost).toBe(91);
    expect(h.registry.deck[0]!.chara_card_id[0]).toBe(778);
  });

  it("亞城／迪城：選頻道那一下換牌、重畫、就地回報", async () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { dietherm: pluginPreload(777, "迪城用") } });
    h.scenes.Match.active = true;
    await h.scenes.Match.channel_login({ channel: 2, type: "duel" });
    expect(h.scenes.Match.logins).toBe(1); // 原版照樣跑
    expect(h.registry.deck[0]!.chara_card_id[0]).toBe(777);
    expect(h.scenes.Match.deck_name.text).toBe("迪城用");
    expect(h.reports).toContainEqual({ type: "room-changed", room: "dietherm", preloaded: true });
  });

  it("重裝不會包兩層", () => {
    const h = makeGame();
    install(h);
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(777) } });
    h.scenes.Raid.active = true;
    h.scenes.Raid.create();
    expect(h.scenes.Raid.created).toBe(1);
  });
});

describe("deck_now 釘住（最後一道保險）", () => {
  it("插件模式、這一房有指派 → 玩家切到 2 會被釘回 1 並重畫", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685, "渦用") } });
    h.scenes.Raid.active = true;
    h.scenes.Raid.deck_now = 2;
    tick(h);
    expect(h.scenes.Raid.deck_now).toBe(1);
    expect(h.scenes.Raid.deck_name.text).toBe("渦用");
  });

  it("⚠ 官方三牌組模式、或這一房沒有指派 → 不釘（不然打渦只能用牌組一）", () => {
    for (const payload of [
      { mode: "official", decks: { raid: officialPreload([1, 2, 3]) } },
      { mode: "plugin", decks: {} },
    ] as RoomGateDecks[]) {
      const h = makeGame();
      install(h);
      setDecks(h, payload);
      h.scenes.Raid.active = true;
      h.scenes.Raid.deck_now = 2;
      tick(h);
      expect(h.scenes.Raid.deck_now).toBe(2);
    }
  });
});

describe("裝、拆、重裝", () => {
  it("⚠ 拆掉之前要先放行 —— 攔著的時候拆掉，那一下就永遠不會送出去", async () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "plugin", decks: { raid: pluginPreload(685) } });
    h.scenes.Raid.active = true;
    tick(h);
    h.registry.deck[0]!.chara_card_id = [999, null, null];
    const p = h.scenes.Raid.socket.fetch("raid_start", 7, 1, 1);
    expect(run(h, ROOM_GATE_UNINSTALL_EXPRESSION)).toBe("ok");
    await expect(p).resolves.toBe("ok:raid_start");
  });

  it("拆掉之後 fetch／create／channel_login 都回到原版", async () => {
    const h = makeGame();
    install(h);
    const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    expect(hasOwn(h.scenes.Raid, "create")).toBe(true);
    expect(hasOwn(h.scenes.Raid.socket, "fetch")).toBe(true);
    run(h, ROOM_GATE_UNINSTALL_EXPRESSION);
    expect(hasOwn(h.scenes.Raid, "create")).toBe(false);
    expect(hasOwn(h.scenes.Raid.socket, "fetch")).toBe(false);
    expect(hasOwn(h.scenes.Match, "channel_login")).toBe(false);
    expect(h.window.__ulrRoomGate).toBeUndefined();
  });

  it("沒裝時推東西回 not-installed，不丟例外", () => {
    const h = makeGame();
    expect(setPending(h, true)).toBe("not-installed");
    expect(setDecks(h, { mode: "plugin", decks: {} })).toBe("not-installed");
    expect(run(h, ROOM_GATE_RELEASE_EXPRESSION)).toBe("not-installed");
  });
});

describe("parseRoomGateStatus", () => {
  it("讀得出模式與攔截狀態；壞掉的回傳當成沒裝", () => {
    const h = makeGame();
    install(h);
    setDecks(h, { mode: "official", decks: {} });
    expect(status(h).mode).toBe("official");
    expect(parseRoomGateStatus("壞掉")).toMatchObject({
      installed: false,
      mode: "off",
      holding: false,
    });
  });
});

describe("腳本本身", () => {
  it("是合法的 JS", () => {
    const compile = (): unknown =>
      // eslint-disable-next-line no-new-func
      new Function(`return ${buildRoomGateScript({ bindingName: "x" })};`);
    expect(compile).not.toThrow();
  });

  it("重跑一次不會留下兩份輪詢或兩層包裝", async () => {
    const h = makeGame();
    install(h);
    install(h);
    await flush();
    await h.scenes.Quest.socket.fetch("db_quest");
    expect(h.scenes.Quest.socket.fetched).toHaveLength(1);
  });
});
