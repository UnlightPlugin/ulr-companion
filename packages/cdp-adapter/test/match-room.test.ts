/**
 * 開房／進房（WP-16）
 *
 * 重點在**注入的腳本真的跑一次**，不是只比對字串。2026-08-15 那次
 * 「rooms_snapshot 看得到、join 說找不到」就是純字串測試抓不到的：
 * 產生出來的表達式看起來完全正常，錯在頁面端少 parse 一次。
 *
 * 假遊戲照 2026-09-23 改版後的 Match 場景搭（2026-09-27 從跑著的客戶端讀的）：
 * 每個頻道一條 `socket_channel`、一律 `fetch`、房間清單是 `channel_room`、
 * 等待視窗是 `create_match_wait()`／`remove_match_wait()`。
 */
import { describe, expect, it, vi } from "vitest";
import { equipmentKey, eventCardKey } from "@ulr/rule-schema";
import {
  ARCADIA_STAGES,
  COST_RANGES,
  HIDDEN_STAGES,
  isStageCode,
  MATCH_ROOM_SCRIPT_VERSION,
  MATCH_ROOM_UNINSTALL_EXPRESSION,
  RANDOM_STAGE_CODE,
  SELECTABLE_STAGES,
  STAGE_CODES,
  STAGES,
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  buildMatchRoomScript,
  canAffordDuel,
  costTiersFor,
  duelApCost,
  findOwnRoom,
  stageValue,
  type ChannelInfo,
  type MatchContext,
  type RoomEntry,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 假頁面：只做注入腳本真的會碰到的那些東西。
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;
type Responder = (...args: unknown[]) => unknown;

interface FakeSocketLike {
  sent: { ev: string; args: unknown[] }[];
  respond: Record<string, Responder>;
  on(ev: string, fn: Handler): void;
  once(ev: string, fn: Handler): void;
  /** 模擬伺服器推一則事件。 */
  push(ev: string, ...args: unknown[]): void;
  fetch(ev: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * 每個假遊戲一個新的 socket 類別 —— 腳本會包它的 prototype（記頻道清單），
 * 共用一個類別的話測試之間會互相漏。
 */
function socketClass(): new () => FakeSocketLike {
  return class FakeSocket implements FakeSocketLike {
    sent: { ev: string; args: unknown[] }[] = [];
    respond: Record<string, Responder> = {};
    #handlers = new Map<string, { fn: Handler; once: boolean }[]>();
    on(ev: string, fn: Handler): void {
      this.#handlers.set(ev, [...(this.#handlers.get(ev) ?? []), { fn, once: false }]);
    }
    once(ev: string, fn: Handler): void {
      this.#handlers.set(ev, [...(this.#handlers.get(ev) ?? []), { fn, once: true }]);
    }
    push(ev: string, ...args: unknown[]): void {
      const list = this.#handlers.get(ev) ?? [];
      this.#handlers.set(
        ev,
        list.filter((h) => !h.once),
      );
      for (const h of list) h.fn(...args);
    }
    fetch(ev: string, ...args: unknown[]): Promise<unknown> {
      this.sent.push({ ev, args });
      const r = this.respond[ev];
      return Promise.resolve(r === undefined ? null : r(...args));
    }
  };
}

const DUEL = {
  channel: 2,
  quick: false,
  event: false,
  cost: null,
  required_ap: { normal: { single: 2, multi: 5 }, friend: { single: 1, multi: 3 } },
  domain: "https://example.invalid:11014",
};
const RANKED = {
  channel: 1,
  quick: true,
  event: false,
  cost: [57, 66, 78],
  required_ap: { normal: { single: 2, multi: 5 }, friend: { single: 1, multi: 3 } },
  domain: "https://example.invalid:11011",
};

/** 房間清單的一筆，形狀照抄 channel_room（2026-09-27）。 */
function rawRoom(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 2,
    cost: null,
    create_at: "2026-09-27T10:10:25.000Z",
    friend: false,
    password: true,
    pending: 0,
    playerA_deck: {
      deck_id: -1,
      main: 0,
      chara_card_id: [429, 330, 606],
      weapon_card_id: [153, 123, 21],
      event_card_id: [],
      card_effect: [],
      cost: 106,
    },
    playerA_info: {
      player_name: "燈皇",
      win: 1,
      lose: 0,
      draw: 0,
      bp: 1500,
      level: 92,
      avatar: [],
    },
    playerB_deck: null,
    playerB_info: null,
    room_id: "bN8kekEQrEwqdxlJdUTbCqORtz1vdYGW0E9U",
    room_name: "COST57 夾擠式",
    rule: "duel",
    multi: true,
    stage: 0,
    ...over,
  };
}

/** 新 id → 舊索引（測試用的小表，真的那份由引擎從 rule-schema 反查）。 */
const TABLES = {
  weaponIndexById: { "6": 1, "11": 2 },
  eventIndexById: { "34": 91 },
};

const CHARA_CARDS = [
  { id: 1, filename: "cc001_01" },
  { id: 429, filename: "cc078_04" },
  { id: 700, filename: "mc001_01" },
];

interface FakeMatch {
  scene: { isActive: () => boolean; launch: ReturnType<typeof vi.fn> };
  socket: FakeSocketLike;
  socket_channel: FakeSocketLike | null;
  channel: typeof DUEL | null;
  channel_room: Record<string, unknown>[];
  deck_now: number;
  deck: Record<string, unknown>[];
  player: { player_name: string; duel_free: number };
  player_ap: { ap: number; ap_max: number };
  player_id: string;
  room_wait: boolean;
  room_select: string | null;
  room_detail: null;
  player_side: string | null;
  wait_zone: object | null;
  waitsCreated: number;
  loading: number;
  input: { enabled: boolean };
  create_match_wait(): void;
  remove_match_wait(): void;
  create_match_loading(): void;
}

interface FakeGame {
  window: Record<string, unknown> & { game: { scene: { keys: Record<string, unknown> } } };
  sc: FakeMatch;
  Socket: new () => FakeSocketLike;
  /** 開機時就在的另一個場景的 socket（腳本靠它包 prototype）。 */
  boot: FakeSocketLike;
  setActive(on: boolean): void;
}

function makeGame(over: Partial<FakeMatch> = {}): FakeGame {
  const Socket = socketClass();
  let active = true;
  const sc: FakeMatch = {
    scene: { isActive: () => active, launch: vi.fn() },
    socket: new Socket(),
    socket_channel: new Socket(),
    channel: DUEL,
    channel_room: [],
    deck_now: 1,
    deck: [
      {
        deck_id: 1,
        chara_card_id: [429, null, 999],
        weapon_card_id: [6, null, 12345],
        event_card_id: [34, null],
        cost: 49,
      },
    ],
    player: { player_name: "燈皇", duel_free: 0 },
    player_ap: { ap: 30, ap_max: 30 },
    player_id: "登入憑證不能外流",
    room_wait: false,
    room_select: null,
    room_detail: null,
    player_side: null,
    wait_zone: null,
    waitsCreated: 0,
    loading: 0,
    input: { enabled: true },
    create_match_wait() {
      this.wait_zone = {};
      this.waitsCreated++;
    },
    remove_match_wait() {
      this.wait_zone = null;
    },
    create_match_loading() {
      this.loading++;
    },
    ...over,
  };
  const boot = new Socket();
  const window = {
    game: {
      scene: { keys: { Boot: { socket: boot }, Match: sc } as Record<string, unknown> },
      cache: { json: { get: (k: string) => (k === "CharaCards" ? CHARA_CARDS : null) } },
      registry: { get: () => null },
    },
  };
  return {
    window,
    sc,
    Socket,
    boot,
    setActive: (on) => {
      active = on;
    },
  };
}

function run<T>(game: FakeGame, expression: string): T {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", `return ${expression};`) as (w: unknown) => T;
  return fn(game.window);
}

function install(game: FakeGame): string {
  return run<string>(game, buildMatchRoomScript(TABLES));
}

function context(game: FakeGame): MatchContext {
  return JSON.parse(run<string>(game, "window.__ulrMatch.context()")) as MatchContext;
}

interface Snapshot {
  seq: number;
  live: boolean;
  started: boolean;
  rooms: RoomEntry[];
}

function snapshot(game: FakeGame): Snapshot {
  return JSON.parse(run<string>(game, "window.__ulrMatch.rooms_snapshot()")) as Snapshot;
}

const ROOM_OPTS = {
  name: "COST57 夾擠式",
  stage: "011",
  friend: false,
  pass: "AB12CD34",
  cost: null,
};

// ---------------------------------------------------------------------------

describe("注入腳本：安裝", () => {
  it("回報版本，重裝也安全", () => {
    const game = makeGame();
    expect(install(game)).toBe(`installed:${MATCH_ROOM_SCRIPT_VERSION}`);
    expect(install(game)).toBe(`installed:${MATCH_ROOM_SCRIPT_VERSION}`);
  });

  it("⚠ 搭遊戲自己送的 get_matching_channel 記下頻道清單 —— 不另外發請求", async () => {
    const game = makeGame();
    install(game);
    // 玩家回到頻道選單：遊戲自己（Match 的 lobby socket）問一次頻道清單。
    game.sc.socket.respond["get_matching_channel"] = () => [RANKED, DUEL];
    await game.sc.socket.fetch("get_matching_channel");
    await Promise.resolve();

    const c = context(game);
    expect(c.channels?.["1"]).toEqual({ type: "ranked", cost: [57, 66, 78], crossplay: false });
    expect(c.channels?.["2"]).toEqual({ type: "duel", cost: null, crossplay: false });
    // 插件自己一個請求都沒送 —— 只有遊戲那一次。
    expect(game.sc.socket.sent.map((s) => s.ev)).toEqual(["get_matching_channel"]);
    expect(game.sc.socket_channel?.sent).toEqual([]);
  });

  it("包 socket 的那一層只包一次，重裝不會疊上去", async () => {
    const game = makeGame();
    install(game);
    const once = game.Socket.prototype.fetch;
    install(game);
    install(game);
    expect(game.Socket.prototype.fetch).toBe(once);
  });

  it("拆掉之後 socket 的 fetch 還原成遊戲原本那支", () => {
    const game = makeGame();
    const orig = game.Socket.prototype.fetch;
    install(game);
    expect(game.Socket.prototype.fetch).not.toBe(orig);
    expect(run<string>(game, MATCH_ROOM_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(game.Socket.prototype.fetch).toBe(orig);
    expect(game.window["__ulrMatch"]).toBeUndefined();
  });
});

describe("注入腳本：context", () => {
  it("頻道、AP、星星、名字都從遊戲自己的欄位讀", () => {
    const game = makeGame();
    install(game);
    const c = context(game);
    expect(c).toMatchObject({
      hasId: true,
      channel: 2,
      crossplay: false,
      requiredAp: { single: 2, multi: 5 },
      deckNow: 1,
      deckCost: 49,
      playerName: "燈皇",
      isMatching: false,
      inMatch: true,
      ap: 30,
      apMax: 30,
      duelFree: 0,
    });
  });

  it("⚠ 玩家 id 是登入憑證，只回有沒有，值不出頁面", () => {
    const game = makeGame();
    install(game);
    const raw = run<string>(game, "window.__ulrMatch.context()");
    expect(raw).not.toContain("登入憑證不能外流");
  });

  it("玩家自己開著一間房（room_wait）就是 isMatching", () => {
    const game = makeGame({ room_wait: true });
    install(game);
    expect(context(game).isMatching).toBe(true);
  });

  it("玩家現在所在的頻道一定在表裡，即使沒經過頻道選單", () => {
    const game = makeGame();
    install(game);
    expect(context(game).channels?.["2"]).toEqual({ type: "duel", cost: null, crossplay: false });
  });

  it("跨平台頻道（3 / 4）標出 crossplay", () => {
    const game = makeGame({ channel: { ...DUEL, channel: 4 } });
    install(game);
    const c = context(game);
    expect(c.crossplay).toBe(true);
    expect(c.channels?.["4"]?.crossplay).toBe(true);
  });

  it("不在大廳（對戰中 Match 是 sleep）→ inMatch false，其餘全是 null", () => {
    const game = makeGame();
    install(game);
    game.setActive(false);
    expect(context(game)).toMatchObject({
      inMatch: false,
      channel: null,
      deckKeys: null,
      ap: null,
    });
  });

  it("沒進頻道 → channel 是 null", () => {
    const game = makeGame({ channel: null });
    install(game);
    expect(context(game).channel).toBeNull();
  });
});

describe("注入腳本：自己牌組的規則鍵（deckKeys）", () => {
  it("角色是 CharaCards 的 filename；武器／事件卡從新 id 換回舊索引組鍵", () => {
    const game = makeGame();
    install(game);
    expect(context(game).deckKeys).toEqual({
      characters: ["cc078_04", null, null],
      equipment: [equipmentKey(1), null, null],
      eventCards: [eventCardKey(91), null],
    });
  });

  it("⚠ 補零邏輯跟 rule-schema 那份一致 —— 兩份漂開會被判成規則不相容", () => {
    const game = makeGame();
    install(game);
    const keys = context(game).deckKeys;
    expect(keys?.equipment[0]).toBe("wp001");
    expect(keys?.eventCards[0]).toBe("ev091");
  });

  it("⚠ 空格與認不得的 id 都是 null，不是空字串 —— 呼叫端要分得出少算了一張", () => {
    const game = makeGame();
    install(game);
    const keys = context(game).deckKeys;
    // [429, null, 999]：999 不在 CharaCards 裡
    expect(keys?.characters).toEqual(["cc078_04", null, null]);
    // [6, null, 12345]：12345 不在對照表裡
    expect(keys?.equipment).toEqual(["wp001", null, null]);
  });

  it("怪物卡也是 CharaCards 的 filename", () => {
    const game = makeGame({
      deck: [{ deck_id: 1, chara_card_id: [700], weapon_card_id: [], event_card_id: [], cost: 3 }],
    });
    install(game);
    expect(context(game).deckKeys?.characters).toEqual(["mc001_01"]);
  });

  it("⚠ 遊戲還沒載完 CharaCards 時整個是 null，而且 context() 仍然回得來", () => {
    const game = makeGame();
    (game.window.game as unknown as { cache: { json: { get: () => null } } }).cache.json.get = () =>
      null;
    install(game);
    const c = context(game);
    expect(c.deckKeys).toBeNull();
    expect(c.inMatch).toBe(true);
  });
});

describe("注入腳本：房間清單", () => {
  it("讀遊戲手上那份 channel_room，只挑用得到的欄位", () => {
    const game = makeGame({ channel_room: [rawRoom()] });
    install(game);
    const s = snapshot(game);
    expect(s.live).toBe(true);
    expect(s.started).toBe(false);
    expect(s.rooms).toEqual([
      {
        roomId: "bN8kekEQrEwqdxlJdUTbCqORtz1vdYGW0E9U",
        name: "COST57 夾擠式",
        playerAName: "燈皇",
        playerBName: null,
        pass: true,
        deckA: { charaCardId: [429, 330, 606], cost: 106 },
        deckB: null,
      },
    ]);
  });

  it("沒進頻道 → live false（＝還不知道，不是沒有房）", () => {
    const game = makeGame({ channel: null });
    install(game);
    expect(snapshot(game)).toMatchObject({ live: false, rooms: [] });
  });

  it("⚠ 對戰開始之後大廳 sleep —— live false，但 started 讀得到", () => {
    const game = makeGame({ channel_room: [rawRoom()] });
    install(game);
    game.sc.player_side = "A";
    game.setActive(false);
    expect(snapshot(game)).toMatchObject({ live: false, started: true, rooms: [] });
  });
});

describe("注入腳本：開房", () => {
  it("照官方的參數順序送 create_room，stage 送數字", async () => {
    const game = makeGame();
    install(game);
    game.sc.socket_channel!.respond["create_room"] = () => "new-room-id";
    const r = JSON.parse(
      await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS)),
    ) as unknown;
    expect(r).toEqual({ ok: true, roomId: "new-room-id" });
    expect(game.sc.socket_channel!.sent).toEqual([
      {
        ev: "create_room",
        args: [
          1,
          2,
          {
            room_name: "COST57 夾擠式",
            stage: 11,
            friend: false,
            cost: null,
            password: "AB12CD34",
            deck_id: 1,
          },
        ],
      },
    ]);
  });

  it("⚠ 成功後照官方那樣進入等待狀態 —— 否則對手進來時 on_match_start 會炸", async () => {
    const game = makeGame();
    install(game);
    game.sc.socket_channel!.respond["create_room"] = () => "new-room-id";
    await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS));
    expect(game.sc.room_wait).toBe(true);
    expect(game.sc.room_select).toBe("new-room-id");
    expect(game.sc.wait_zone).not.toBeNull();
    expect(game.sc.waitsCreated).toBe(1);
  });

  it("大廳補丁排隊時已經開了等待視窗 → 沿用，不開第二個", async () => {
    const game = makeGame({ wait_zone: {} });
    install(game);
    game.sc.socket_channel!.respond["create_room"] = () => "new-room-id";
    await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS));
    expect(game.sc.waitsCreated).toBe(0);
  });

  it("伺服器拒絕（回 null）就把 match_error 的代碼帶回來", async () => {
    const game = makeGame();
    install(game);
    const so = game.sc.socket_channel!;
    so.respond["create_room"] = () => {
      so.push("match_error", "NOT_ENOUGH_AP");
      return null;
    };
    const r = JSON.parse(await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS)));
    expect(r).toEqual({ ok: false, reason: "伺服器拒絕開房", fail: "NOT_ENOUGH_AP" });
    expect(game.sc.room_wait).toBe(false);
  });

  it("已經開著一間房就不送", async () => {
    const game = makeGame({ room_wait: true });
    install(game);
    const r = JSON.parse(await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS)));
    expect(r.ok).toBe(false);
    expect(game.sc.socket_channel!.sent).toEqual([]);
  });

  it("沒進頻道就不送", async () => {
    const game = makeGame({ channel: null, socket_channel: null });
    install(game);
    const r = JSON.parse(await run<Promise<string>>(game, buildCreateRoomExpression(ROOM_OPTS)));
    expect(r).toEqual({ ok: false, reason: "還沒進頻道" });
  });

  it("認不得的地點代號在 Node 這邊就擋掉，不會送進頁面", () => {
    expect(() => buildCreateRoomExpression({ ...ROOM_OPTS, stage: "11" })).toThrow();
  });
});

describe("注入腳本：進房", () => {
  it("照官方的進房鈕：送 enter_room，拿到設定就 launch MatchBoot", async () => {
    const room = rawRoom({ room_id: "abc123" });
    const game = makeGame({ channel_room: [room], wait_zone: {} });
    install(game);
    const config = { player_side: "B", domain: "https://duel.invalid", port: 12345 };
    game.sc.socket_channel!.respond["enter_room"] = () => config;

    const r = JSON.parse(
      await run<Promise<string>>(game, buildJoinRoomExpression("abc123", "AB12CD34")),
    );
    expect(r).toEqual({ ok: true });
    expect(game.sc.socket_channel!.sent).toEqual([
      { ev: "enter_room", args: ["abc123", 1, "AB12CD34"] },
    ]);
    expect(game.sc.player_side).toBe("B");
    // 大廳補丁的排隊視窗要收掉（官方進房那條路沒有它）
    expect(game.sc.wait_zone).toBeNull();
    expect(game.sc.loading).toBe(1);
    expect(game.sc.scene.launch).toHaveBeenCalledWith("MatchBoot", {
      is_tutorial: false,
      host: "https://duel.invalid",
      port: 12345,
      room_config: config,
      player_side: "B",
    });
  });

  it("密碼原封不動送出去，不會多一對引號", async () => {
    const game = makeGame({ channel_room: [rawRoom({ room_id: "abc123" })] });
    install(game);
    game.sc.socket_channel!.respond["enter_room"] = () => ({ player_side: "B" });
    await run<Promise<string>>(game, buildJoinRoomExpression("abc123", "AB12CD34"));
    expect(game.sc.socket_channel!.sent[0]?.args[2]).toBe("AB12CD34");
  });

  it("沒鎖的房照官方送 null 當密碼", async () => {
    const game = makeGame({ channel_room: [rawRoom({ room_id: "abc123", password: false })] });
    install(game);
    game.sc.socket_channel!.respond["enter_room"] = () => ({ player_side: "B" });
    await run<Promise<string>>(game, buildJoinRoomExpression("abc123", "AB12CD34"));
    expect(game.sc.socket_channel!.sent[0]?.args[2]).toBeNull();
  });

  it("被拒就把代碼帶回來，而且解開 room_wait 與輸入", async () => {
    const game = makeGame({ channel_room: [rawRoom({ room_id: "abc123" })] });
    install(game);
    const so = game.sc.socket_channel!;
    so.respond["enter_room"] = () => {
      so.push("match_error", "INVALID_PASSWORD");
      return null;
    };
    const r = JSON.parse(
      await run<Promise<string>>(game, buildJoinRoomExpression("abc123", "WRONG")),
    );
    expect(r).toEqual({ ok: false, reason: "進房被拒", fail: "INVALID_PASSWORD" });
    expect(game.sc.room_wait).toBe(false);
    expect(game.sc.input.enabled).toBe(true);
    expect(game.sc.scene.launch).not.toHaveBeenCalled();
  });

  it("清單裡沒有那個 room_id 就不進房", async () => {
    const game = makeGame({ channel_room: [rawRoom({ room_id: "別間" })] });
    install(game);
    const r = JSON.parse(
      await run<Promise<string>>(game, buildJoinRoomExpression("abc123", "AB12CD34")),
    );
    expect(r).toEqual({ ok: false, reason: "房間清單裡沒有這個 room_id" });
    expect(game.sc.socket_channel!.sent).toEqual([]);
  });
});

describe("注入腳本：收房", () => {
  it("⚠ 收的是自己那一間（cancel_room 吃 room_id），收完照官方清掉等待狀態", async () => {
    const game = makeGame({ room_wait: true, room_select: "mine", wait_zone: {} });
    install(game);
    game.sc.socket_channel!.respond["cancel_room"] = () => true;
    expect(await run<Promise<string>>(game, "window.__ulrMatch.cancel()")).toBe("ok");
    expect(game.sc.socket_channel!.sent).toEqual([{ ev: "cancel_room", args: ["mine"] }]);
    expect(game.sc.room_wait).toBe(false);
    expect(game.sc.room_select).toBeNull();
    expect(game.sc.wait_zone).toBeNull();
  });

  it("⚠ 等待中點過別的房間（room_select 被改掉）→ 收的還是自己那一間", async () => {
    const game = makeGame({ room_wait: true, room_select: "R9", wait_zone: {} });
    (game.sc as unknown as Record<string, unknown>)["__ulrWaitRoom"] = "mine";
    install(game);
    game.sc.socket_channel!.respond["cancel_room"] = () => true;
    expect(await run<Promise<string>>(game, "window.__ulrMatch.cancel()")).toBe("ok");
    expect(game.sc.socket_channel!.sent).toEqual([{ ev: "cancel_room", args: ["mine"] }]);
    expect((game.sc as unknown as Record<string, unknown>)["__ulrWaitRoom"]).toBeNull();
  });

  it("沒有開著的房就不送", async () => {
    const game = makeGame();
    install(game);
    expect(await run<Promise<string>>(game, "window.__ulrMatch.cancel()")).toBe("沒有開著的房");
    expect(game.sc.socket_channel!.sent).toEqual([]);
  });
});

describe("COST 階層：duel 頻道借用同組 ranked 的", () => {
  /**
   * 2026-08-16 從兩個跑著的客戶端照抄下來的。
   * ⚠ 這些數字**每週二會變**，所以它們只是這組測試的固定輸入。
   */
  const CHANNELS: Record<string, ChannelInfo> = {
    "1": { type: "ranked", cost: [57, 66, 78], crossplay: false },
    "2": { type: "duel", cost: null, crossplay: false },
    "3": { type: "ranked", cost: [56, 69, 71], crossplay: true },
    "4": { type: "duel", cost: null, crossplay: true },
  };

  it("ranked 頻道用自己的", () => {
    expect(costTiersFor(CHANNELS, 1)).toEqual([57, 66, 78]);
    expect(costTiersFor(CHANNELS, 3)).toEqual([56, 69, 71]);
  });

  it("⚠ 迪特赫姆（2）借亞歷山卓城（1）的", () => {
    expect(costTiersFor(CHANNELS, 2)).toEqual([57, 66, 78]);
  });

  it("⚠ 布萊德克洛伊茲（4）借峰亥盧遺跡（3）的，**不是**借頻道 1 的", () => {
    expect(costTiersFor(CHANNELS, 4)).toEqual([56, 69, 71]);
    expect(costTiersFor(CHANNELS, 4)).not.toEqual(costTiersFor(CHANNELS, 2));
  });

  it("⚠ 那個 ranked 頻道沒看過（玩家還沒經過頻道選單）→ null，不是別組的", () => {
    const onlyDuel: Record<string, ChannelInfo> = {
      "2": { type: "duel", cost: null, crossplay: false },
      "3": { type: "ranked", cost: [56, 69, 71], crossplay: true },
    };
    expect(costTiersFor(onlyDuel, 2)).toBeNull();
  });

  it("沒進頻道、讀不到頻道表、或那個頻道不存在 → null", () => {
    expect(costTiersFor(CHANNELS, null)).toBeNull();
    expect(costTiersFor(null, 2)).toBeNull();
    expect(costTiersFor(CHANNELS, 99)).toBeNull();
  });

  it("⚠ 有鍵但全是 null 也回 null，不要湊一個空陣列出來", () => {
    expect(
      costTiersFor({ "1": { type: "ranked", cost: [null, null], crossplay: false } }, 1),
    ).toBeNull();
  });
});

describe("官方常數（照抄客戶端，不是自己編的）", () => {
  it("⚠ 隨機是 999，000 是雷德貝魯格城 —— 改版前隨機是 014，現在 014 是一張地圖", () => {
    expect(RANDOM_STAGE_CODE).toBe("999");
    expect(STAGES.find((s) => s.value === "999")?.name).toBe("隨機");
    expect(STAGES.find((s) => s.value === "000")?.name).toBe("雷德貝魯格城");
    expect(HIDDEN_STAGES.find((s) => s.value === "014")?.name).toBe("聖域的凱旋門");
  });

  it("官方清單是 000~009 加 999", () => {
    expect(STAGES.map((s) => s.value)).toEqual([
      "000",
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "999",
    ]);
  });

  it("隱藏地圖是 011~014（010 只是雷德貝魯格城的別名）", () => {
    expect(HIDDEN_STAGES.map((s) => s.value)).toEqual(["011", "012", "013", "014"]);
  });

  it("隱藏地圖不能跟官方的重疊 —— 代號與名稱都是", () => {
    const values = new Set(STAGES.map((s) => s.value));
    const names = new Set(STAGES.map((s) => s.name));
    for (const s of HIDDEN_STAGES) {
      expect(values.has(s.value)).toBe(false);
      expect(names.has(s.name)).toBe(false);
    }
  });

  it("亞城池是官方那 10 張加 011", () => {
    expect(ARCADIA_STAGES).toEqual([
      ...STAGES.filter((s) => s.value !== RANDOM_STAGE_CODE).map((s) => s.value),
      "011",
    ]);
  });

  it("Cost 限制只有 0~5", () => {
    expect(COST_RANGES).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("地點一律寫成 3 位數字串，送出去才轉數字", () => {
    for (const v of [...STAGES, ...HIDDEN_STAGES].map((s) => s.value)) {
      expect(v).toMatch(/^\d{3}$/);
    }
    expect(stageValue("000")).toBe(0);
    expect(stageValue("011")).toBe(11);
    expect(stageValue("999")).toBe(999);
    expect(() => stageValue("abc")).toThrow();
  });

  it("選得到的地圖是 000~009 與 011~014，不含隨機", () => {
    expect(STAGE_CODES).toEqual([
      "000",
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "011",
      "012",
      "013",
      "014",
    ]);
    expect(STAGE_CODES as readonly string[]).not.toContain("999");
  });

  it("每一張選得到的地圖都查得到名字，而且跟官方／隱藏那兩張表一致", () => {
    const byValue = new Map([...STAGES, ...HIDDEN_STAGES].map((s) => [s.value, s.name]));
    expect(SELECTABLE_STAGES.map((s) => s.value)).toEqual([...STAGE_CODES]);
    for (const s of SELECTABLE_STAGES) {
      expect(s.name).toBe(byValue.get(s.value));
    }
  });

  it("isStageCode 只認那十四個", () => {
    expect(isStageCode("000")).toBe(true);
    expect(isStageCode("014")).toBe(true);
    expect(isStageCode("010")).toBe(false);
    expect(isStageCode("999")).toBe(false);
    expect(isStageCode("arcadia")).toBe(false);
    expect(isStageCode(13)).toBe(false);
    expect(isStageCode(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("findOwnRoom", () => {
  const room = (over: Partial<RoomEntry>): RoomEntry => ({
    roomId: "r1",
    name: "ULR3",
    playerAName: "燈皇",
    playerBName: null,
    pass: true,
    deckA: null,
    deckB: null,
    ...over,
  });

  it("只有一間就回那一間", () => {
    expect(findOwnRoom([room({})], "燈皇")?.roomId).toBe("r1");
  });

  it("別人的房不會被當成自己的", () => {
    expect(findOwnRoom([room({ playerAName: "路人" })], "燈皇")).toBeNull();
  });

  it("同時有兩間房時靠房名分辨", () => {
    const rooms = [
      room({ roomId: "手動", name: "請多關照" }),
      room({ roomId: "插件", name: "ULR3" }),
    ];
    expect(findOwnRoom(rooms, "燈皇", "ULR3")?.roomId).toBe("插件");
  });

  it("指定了房名卻找不到就回 null，不退回別間", () => {
    expect(findOwnRoom([room({ name: "請多關照" })], "燈皇", "ULR3")).toBeNull();
  });

  it("排掉已經有對手的房", () => {
    const rooms = [room({ roomId: "打完了", playerBName: "不要樂奈" }), room({ roomId: "空的" })];
    expect(findOwnRoom(rooms, "燈皇")?.roomId).toBe("空的");
  });

  it("分不出來就回 null", () => {
    expect(findOwnRoom([room({ roomId: "a" }), room({ roomId: "b" })], "燈皇")).toBeNull();
  });
});

/**
 * AP 與免費對戰星星。
 *
 * ⚠ 這一組釘的是玩家 2026-08-19 回報的那件事：AP 剩 2 卻排得下去，一路排到
 * 配對成功、開房時才跳「AP不足」—— 而那時對手已經在等一間永遠不會開的房。
 */
describe("開一場要多少 AP（讀不到頻道物件時的退路）", () => {
  it("一般頻道：3vs3 要 5、1vs1 要 2", () => {
    expect(duelApCost({ multi: true, crossplay: false })).toBe(5);
    expect(duelApCost({ multi: false, crossplay: false })).toBe(2);
  });

  it("跨平台頻道：3vs3 只要 4", () => {
    expect(duelApCost({ multi: true, crossplay: true })).toBe(4);
    expect(duelApCost({ multi: false, crossplay: true })).toBe(2);
  });
});

describe("排不排得下去", () => {
  it("AP 夠就排得下去，而且不吃星星", () => {
    expect(canAffordDuel({ ap: 30, duelFree: 0, cost: 5 })).toEqual({
      ok: true,
      byStar: false,
      cost: 5,
    });
  });

  it("剛好等於需要的 AP 也算夠", () => {
    expect(canAffordDuel({ ap: 5, duelFree: 0, cost: 5 })).toMatchObject({ ok: true });
  });

  it("⚠ AP 不夠但**還有星星** → 照樣排得下去，而且是靠星星", () => {
    expect(canAffordDuel({ ap: 2, duelFree: 3, cost: 5 })).toEqual({
      ok: true,
      byStar: true,
      cost: 5,
    });
    expect(canAffordDuel({ ap: 0, duelFree: 1, cost: 5 })).toMatchObject({ byStar: true });
  });

  it("⚠ AP 不夠又沒星星 → 擋下來，而且要講得出差多少", () => {
    expect(canAffordDuel({ ap: 2, duelFree: 0, cost: 5 })).toEqual({ ok: false, cost: 5, ap: 2 });
  });

  it("⚠⚠ 讀不到就當排得下去 ——「不知道」不是「不夠」", () => {
    expect(canAffordDuel({ ap: null, duelFree: null, cost: 5 })).toMatchObject({ ok: true });
    expect(canAffordDuel({ ap: null, duelFree: 0, cost: 5 })).toMatchObject({ ok: true });
  });

  it("星星欄位讀不到但 AP 夠 → 照樣過", () => {
    expect(canAffordDuel({ ap: 10, duelFree: null, cost: 5 })).toMatchObject({
      ok: true,
      byStar: false,
    });
  });
});
