/**
 * 開房／進房（WP-16）
 *
 * 重點在**注入的腳本真的跑一次**，不是只比對字串。2026-08-15 那次
 * 「rooms_snapshot 看得到、join 說找不到」就是純字串測試抓不到的：
 * 產生出來的表達式看起來完全正常，錯在頁面端少 parse 一次。
 */
import { describe, expect, it, vi } from "vitest";
import { equipmentKey, eventCardKey } from "@ulr/rule-schema";
import {
  COST_RANGES,
  HIDDEN_STAGES,
  MATCH_ROOM_INSTALL_EXPRESSION,
  STAGES,
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  costTiersFor,
  findOwnRoom,
  type ChannelInfo,
  type RoomEntry,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 假頁面：只做注入腳本真的會碰到的那些東西。

type Handler = (value: unknown) => void;

interface FakeSocket {
  on(ev: string, fn: Handler): void;
  once(ev: string, fn: Handler): void;
  emit(ev: string, ...args: unknown[]): void;
  fire(ev: string, v?: unknown): void;
  emitted: { ev: string; args: unknown[] }[];
  __ulrListened?: Record<string, unknown>;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const onces = new Map<string, Handler[]>();
  return {
    emitted: [],
    on(ev, fn) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    once(ev, fn) {
      onces.set(ev, [...(onces.get(ev) ?? []), fn]);
    },
    emit(ev, ...args) {
      this.emitted.push({ ev, args });
    },
    fire(ev, v) {
      for (const fn of handlers.get(ev) ?? []) fn(v);
      const os = onces.get(ev) ?? [];
      onces.set(ev, []);
      for (const fn of os) fn(v);
    },
  };
}

function rawRoom(over: Record<string, unknown> = {}) {
  return {
    room_id: "ROOM-ID-1",
    name: "ULR3",
    playerA: { name: "燈皇" },
    playerB: null,
    deckA: { chara: ["cc069"], charaIndex: [3], cost: 49 },
    deckB: null,
    pass: 1,
    stage: "000",
    ...over,
  };
}

/**
 * @param channel 2 = 迪特赫姆（一般，走 socket）／4 = 布萊德克洛伊茲（跨平台，走 socket_cross）
 */
function makePage(channel = 2) {
  const socket = makeSocket();
  const socketCross = makeSocket();
  const scene = {
    id: "player-id",
    channel,
    channels: { "1": { type: "ranked", cost: [57, 66, 78] }, "2": { type: "duel" } },
    channels_cross: { "3": { type: "ranked", cost: [56, 69, 71] }, "4": { type: "duel" } },
    deck_now: 1,
    deck1: { cost: 49 },
    player: { name: "燈皇" },
    socket,
    socket_cross: socketCross,
    // ⚠ 預設不給 match_room_data，這樣既有的測試仍走推播快取那條路 ——
    // 兩條路都要有測試。要測即時清單的自己塞進去。
    channel_panel: {
      room_select: null as unknown,
      is_matching: false,
      match_room_data: undefined as unknown[] | undefined,
    },
    password: undefined as unknown,
    room_in: vi.fn(),
    scene: { isActive: () => true },
  };
  // 這個假 window 刻意不上型別：注入的腳本是**字串裡的 JS**，它在上面掛什麼
  // 屬性、什麼時候掛，TypeScript 一概不知道。硬要描述型別只會描述成我們**以為**
  // 的樣子，而這組測試存在的理由正是「不要相信我們以為的」。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const window: any = { game: { scene: { keys: { Match: scene } } } };
  return { window, scene, socket, socketCross };
}

/**
 * 在假 window 上跑一段注入腳本，回傳它的結果。
 *
 * ⚠ 這裡的 `new Function` 是**這組測試的重點**，不是偷懶：要驗的就是那段
 * 字串在頁面上真的執行起來會怎樣。純比對字串的測試抓不到 2026-08-15 那個
 * 「產生的表達式跟頁面端函式簽章對不上」的 bug。
 */
// eslint-disable-next-line no-new-func
const compile = (expression: string) => new Function("window", `return (${expression});`);

function run<T>(window: unknown, expression: string): T {
  return compile(expression)(window) as T;
}

/** 某個頻道那一格的原始房間清單。清單是**按頻道分開存**的。 */
function rawOf(
  window: { __ulrMatch?: { byChannel?: Record<string, { raw: unknown[] }> } },
  channel: number,
): unknown[] {
  return window.__ulrMatch?.byChannel?.[String(channel)]?.raw ?? [];
}

function install(window: unknown): string {
  return run<string>(window, MATCH_ROOM_INSTALL_EXPRESSION);
}

describe("注入腳本：安裝", () => {
  it("第一次是 installed，再裝一次是 reinstalled", () => {
    const { window } = makePage();
    expect(install(window)).toBe("installed");
    expect(install(window)).toBe("reinstalled");
  });

  it("重裝沿用同一個 state 物件，舊 listener 寫進去的資料不會不見", () => {
    const { window, socket } = makePage();
    install(window);
    run(window, "window.__ulrMatch.context()"); // 觸發 listen()
    const before = window.__ulrMatch;
    socket.fire("channel2_room", [rawRoom()]);
    expect(rawOf(window, 2)).toHaveLength(1);

    // ⚠ 這裡是真正的回歸點：換成新 state 物件的話，還掛在 socket 上的
    // 舊 listener 會繼續往舊物件寫，rawOf(window, 2) 就永遠是空的。
    install(window);
    expect(window.__ulrMatch).toBe(before);
    expect(rawOf(window, 2)).toHaveLength(1);
  });

  it("listener 只掛一支，重裝不會愈積愈多", () => {
    const { window, socket } = makePage();
    install(window);
    run(window, "window.__ulrMatch.context()");
    install(window);
    run(window, "window.__ulrMatch.context()");
    socket.fire("channel2_room", [rawRoom()]);
    // 掛兩支的話 seq 會一次跳 2
    expect(JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()")).seq).toBe(1);
  });

  it("卸載後重裝，還活著的 listener 會寫進新的 state", () => {
    const { window, socket } = makePage();
    install(window);
    run(window, "window.__ulrMatch.context()");
    delete window.__ulrMatch;
    install(window);
    socket.fire("channel2_room", [rawRoom()]);
    expect(rawOf(window, 2)).toHaveLength(1);
  });
});

describe("COST 階層：duel 頻道借用同組 ranked 的", () => {
  /**
   * 2026-08-16 從兩個跑著的客戶端（59222 迪特、9334 亞城）**照抄**下來的。
   * ⚠ 這些數字**每週二會變**，所以它們只是這組測試的固定輸入，不是可以拿去
   * 用的常數 —— 真正的值一律從玩家自己的客戶端讀。
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
    // 兩組的數字真的不一樣 —— 借錯不會報錯，只會讓兩個人約定到不同的上限
    expect(costTiersFor(CHANNELS, 4)).toEqual([56, 69, 71]);
    expect(costTiersFor(CHANNELS, 4)).not.toEqual(costTiersFor(CHANNELS, 2));
  });

  it("借的依據是「同一條 socket」而不是寫死的編號", () => {
    // 官方哪天多開一組頻道（5 ranked / 6 duel）也要對
    const more: Record<string, ChannelInfo> = {
      ...CHANNELS,
      "5": { type: "ranked", cost: [40, 50], crossplay: false },
    };
    // 同一組裡先找到誰就用誰 —— 至少不會拿到另一組（crossplay 不同）的
    expect(costTiersFor(more, 4)).toEqual([56, 69, 71]);
  });

  it("沒進頻道、讀不到頻道表、或那個頻道不存在 → null", () => {
    expect(costTiersFor(CHANNELS, null)).toBeNull();
    expect(costTiersFor(null, 2)).toBeNull();
    expect(costTiersFor(CHANNELS, 99)).toBeNull();
  });

  it("⚠ 整組都沒有 cost 的話回 null，不要湊一個空陣列出來", () => {
    const noRanked: Record<string, ChannelInfo> = {
      "2": { type: "duel", cost: null, crossplay: false },
    };
    expect(costTiersFor(noRanked, 2)).toBeNull();
    // 有鍵但全是 null 也一樣（伺服器回了一組空的）
    expect(
      costTiersFor({ "1": { type: "ranked", cost: [null, null], crossplay: false } }, 1),
    ).toBeNull();
  });
});

describe("注入腳本：自己牌組的規則鍵（deckKeys）", () => {
  /** 塞假的 cc_asset / mc_asset。`filename` 就是規則的正規鍵。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function withAsset(window: any, cc: unknown[], mc: unknown[] = []): void {
    const tables: Record<string, unknown> = { cc_asset: { frames: cc }, mc_asset: { frames: mc } };
    window.game.cache = { json: { get: (k: string) => tables[k] ?? null } };
  }

  const keysOf = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: any,
  ): { characters: unknown; equipment: string[]; eventCards: string[] } | null =>
    JSON.parse(run<string>(window, "window.__ulrMatch.context()")).deckKeys;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const charactersOf = (window: any): unknown => keysOf(window)?.characters;

  it("charaIndex 直接當 cc_asset.frames 的索引 —— 不需要任何對照表", () => {
    const { window, scene } = makePage();
    withAsset(window, [
      { filename: "cc001_01", cost: 8 },
      { filename: "cc078_04", cost: 19 },
      { filename: "cc078_r04", cost: 21 },
    ]);
    scene.deck1 = { cost: 49, chara: ["cc078", "cc001"], charaIndex: [2, 0] } as never;
    install(window);
    expect(charactersOf(window)).toEqual(["cc078_r04", "cc001_01"]);
  });

  it("⚠⚠ 怪物要查 mc_asset —— 拿去查 cc_asset 會撈到一張不相干的角色卡", () => {
    // 這是實際發生過的 bug：怪物與角色共用同樣三個槽位，charaIndex 卻索引
    // 不同的資產。查錯不會報錯，只會安靜地換成另一張存在的卡。
    const { window, scene } = makePage();
    withAsset(
      window,
      [
        { filename: "cc001_01", cost: 8 },
        { filename: "cc002_01", cost: 9 },
      ],
      [
        { filename: "mc001_01", cost: 9 },
        { filename: "mc001_02", cost: 10 },
      ],
    );
    scene.deck1 = {
      cost: 27,
      chara: ["cc001", "mc001_02", "mc001_01"],
      charaIndex: [0, 1, 0],
    } as never;
    install(window);
    expect(charactersOf(window)).toEqual(["cc001_01", "mc001_02", "mc001_01"]);
  });

  it("⚠ 空格是 null，不是空字串 —— 呼叫端要分得出「這格沒卡」", () => {
    const { window, scene } = makePage();
    withAsset(window, [{ filename: "cc001_01", cost: 8 }]);
    scene.deck1 = { cost: 8, chara: ["cc001", null], charaIndex: [0, null] } as never;
    install(window);
    expect(charactersOf(window)).toEqual(["cc001_01", null]);
  });

  it("⚠ 索引超出範圍也是 null，不會拿到 undefined 或炸掉", () => {
    const { window, scene } = makePage();
    withAsset(window, [{ filename: "cc001_01", cost: 8 }]);
    scene.deck1 = { cost: 8, chara: ["cc001"], charaIndex: [999] } as never;
    install(window);
    expect(charactersOf(window)).toEqual([null]);
  });

  it("裝備與事件卡的鍵直接由索引補零組出來", () => {
    const { window, scene } = makePage();
    withAsset(window, [{ filename: "cc001_01", cost: 8 }]);
    scene.deck1 = {
      cost: 8,
      chara: ["cc001"],
      charaIndex: [0],
      weapon: [1, null, 237],
      eventIndex: [91, null, 3],
    } as never;
    install(window);
    expect(keysOf(window)).toEqual({
      characters: ["cc001_01"],
      equipment: ["wp001", null, "wp237"],
      eventCards: ["ev091", null, "ev003"],
    });
  });

  it("⚠ 遊戲還沒載完 cc_asset 時整個是 null，而且 context() 仍然回得來", () => {
    const { window, scene } = makePage();
    scene.deck1 = { cost: 49, chara: ["cc001", "cc002"], charaIndex: [0, 1] } as never;
    install(window);
    const ctx = JSON.parse(run<string>(window, "window.__ulrMatch.context()"));
    expect(ctx.deckKeys).toBeNull();
    expect(ctx.inMatch).toBe(true);
  });

  it("⚠ 讀的是 filename 不是 cost —— 套過自訂 COST 的客戶端上也讀得對", () => {
    const { window, scene } = makePage();
    // 自訂 COST 的注入就地改寫的是 cost 欄位，filename 沒被動過
    withAsset(window, [{ filename: "cc001_01", cost: 999 }]);
    scene.deck1 = { cost: 999, chara: ["cc001"], charaIndex: [0] } as never;
    install(window);
    expect(charactersOf(window)).toEqual(["cc001_01"]);
  });

  /**
   * ⚠⚠ 注入腳本裡的 `padIndex()` 是 `@ulr/rule-schema` 那份補零邏輯的**第二份
   * 拷貝** —— 頁面端沒辦法 import，只能各寫一次。
   *
   * 兩份漂開的症狀極難認：規則明明一樣，卻因為配對送出的鍵不同而被判成
   * 「規則不相容」，錯誤訊息會指向規則，玩家永遠找不到真正的原因。
   * 所以這裡拿真正的 `equipmentKey()` / `eventCardKey()` 當對照組。
   * （`patch-penalty.test.ts` 對罰則算法用的是同一招。）
   */
  it("⚠ 補零邏輯跟 rule-schema 那份一致 —— 兩份漂開會被判成規則不相容", () => {
    const { window, scene } = makePage();
    withAsset(window, [{ filename: "cc001_01", cost: 8 }]);
    const indexes = [0, 1, 9, 10, 99, 100, 109, 237];
    scene.deck1 = {
      cost: 8,
      chara: ["cc001"],
      charaIndex: [0],
      weapon: indexes,
      eventIndex: indexes,
    } as never;
    install(window);

    const keys = keysOf(window);
    expect(keys?.equipment).toEqual(indexes.map(equipmentKey));
    expect(keys?.eventCards).toEqual(indexes.map(eventCardKey));
  });
});

describe("注入腳本：rooms_snapshot 與 join 讀同一份資料", () => {
  it("snapshot 看得到的房，join 就找得到", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socket } = makePage();
      install(window);
      run(window, "window.__ulrMatch.context()");
      socket.fire("channel2_room", [rawRoom({ room_id: "abc123" })]);

      const snap = JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()"));
      expect(snap.rooms.map((r: RoomEntry) => r.roomId)).toContain("abc123");

      // ⚠ 一定要走 buildJoinRoomExpression 產生的**那一句**，不要自己組。
      // 那次的 bug 就在產生的表達式與頁面端函式簽章對不上。
      const p = run<Promise<string>>(window, buildJoinRoomExpression("abc123", "AB12CD34"));
      socket.fire("duel_standby");
      expect(JSON.parse(await p)).toEqual({ ok: true });

      expect(scene.room_in).toHaveBeenCalledOnce();
      expect(scene.channel_panel.room_select).toMatchObject({ room_id: "abc123" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("密碼原封不動送到頁面，不會多一對引號", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socket } = makePage();
      install(window);
      run(window, "window.__ulrMatch.context()");
      socket.fire("channel2_room", [rawRoom({ room_id: "abc123" })]);

      const p = run<Promise<string>>(window, buildJoinRoomExpression("abc123", "AB12CD34"));
      // 遊戲問密碼的時候，腳本要回傳 token 本身。
      await expect((scene.password as () => Promise<string>)()).resolves.toBe("AB12CD34");
      socket.fire("duel_standby");
      await p;
      // 叫完要還原，不能把遊戲的密碼輸入框吃掉。
      expect(scene.password).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("清單裡沒有那個 room_id 就不進房", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socket } = makePage();
      install(window);
      run(window, "window.__ulrMatch.context()");
      socket.fire("channel2_room", [rawRoom({ room_id: "abc123" })]);

      const out = JSON.parse(
        await run<Promise<string>>(window, buildJoinRoomExpression("別間", "AB12CD34")),
      );
      expect(out.ok).toBe(false);
      expect(scene.room_in).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("注入腳本：開房", () => {
  it("參數照 match_room_make 的順序送出，stage 原樣帶過去", async () => {
    vi.useFakeTimers();
    try {
      const { window, socket } = makePage();
      install(window);

      const p = run<Promise<string>>(
        window,
        buildCreateRoomExpression({
          name: "ULR3",
          stage: "000",
          multi: true,
          friend: false,
          pass: "AB12CD34",
          cost: null,
        }),
      );
      socket.fire("match_waiting");
      expect(JSON.parse(await p)).toEqual({ ok: true, roomId: null });

      const call = socket.emitted.find((e) => e.ev === "match_room_make");
      expect(call?.args).toEqual(["player-id", 2, "ULR3", "000", true, false, "AB12CD34", null, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("伺服器拒絕就把 fail 代碼帶回來", async () => {
    vi.useFakeTimers();
    try {
      const { window, socket } = makePage();
      install(window);
      const p = run<Promise<string>>(
        window,
        buildCreateRoomExpression({
          name: "ULR3",
          stage: "000",
          multi: true,
          friend: false,
          pass: "AB12CD34",
          cost: null,
        }),
      );
      socket.fire("match_room_error", { fail: 20 });
      expect(JSON.parse(await p)).toMatchObject({ ok: false, fail: 20 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("跨平台頻道（3 / 4）走的是另一條 socket", () => {
  // ⚠ 用錯 socket 不會拋錯，只會**安靜地什麼都收不到**。這一組測的就是
  // 「有沒有掛/送到對的那條線上」，不是「有沒有報錯」。

  it("context 標出 crossplay，而且併出四個頻道", () => {
    const { window } = makePage(4);
    install(window);
    const ctx = JSON.parse(run<string>(window, "window.__ulrMatch.context()"));
    expect(ctx.crossplay).toBe(true);
    expect(Object.keys(ctx.channels).sort()).toEqual(["1", "2", "3", "4"]);
    expect(ctx.channels["4"]).toEqual({ type: "duel", cost: null, crossplay: true });
    expect(ctx.channels["1"]).toEqual({ type: "ranked", cost: [57, 66, 78], crossplay: false });
    expect(ctx.deckCost).toBe(49);
  });

  it("一般頻道不算 crossplay", () => {
    const { window } = makePage(2);
    install(window);
    expect(JSON.parse(run<string>(window, "window.__ulrMatch.context()")).crossplay).toBe(false);
  });

  it("頻道 4 的房間清單掛在 socket_cross 上，一般 socket 收不到", () => {
    const { window, socket, socketCross } = makePage(4);
    install(window);
    run(window, "window.__ulrMatch.context()");

    socket.fire("channel4_room", [rawRoom()]); // 掛錯線的話會是這條在餵
    expect(rawOf(window, 4)).toHaveLength(0);

    socketCross.fire("channel4_room", [rawRoom()]);
    expect(rawOf(window, 4)).toHaveLength(1);
  });

  it("頻道 4 的開房送到 socket_cross", async () => {
    vi.useFakeTimers();
    try {
      const { window, socket, socketCross } = makePage(4);
      install(window);
      const p = run<Promise<string>>(
        window,
        buildCreateRoomExpression({
          name: "ULR3",
          stage: "000",
          multi: true,
          friend: false,
          pass: "AB12CD34",
          cost: 5,
        }),
      );
      socketCross.fire("match_waiting");
      expect(JSON.parse(await p)).toEqual({ ok: true, roomId: null });

      expect(socket.emitted).toHaveLength(0);
      const call = socketCross.emitted.find((e) => e.ev === "match_room_make");
      // 第 9 個參數是「牌組 Cost 限制」＝ ±N，不是絕對上限。
      expect(call?.args).toEqual(["player-id", 4, "ULR3", "000", true, false, "AB12CD34", 5, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("頻道 4 的進房把 crossplay=true 交給 room_in", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socketCross } = makePage(4);
      install(window);
      run(window, "window.__ulrMatch.context()");
      socketCross.fire("channel4_room", [rawRoom({ room_id: "abc123" })]);

      const p = run<Promise<string>>(window, buildJoinRoomExpression("abc123", "AB12CD34"));
      socketCross.fire("duel_standby");
      expect(JSON.parse(await p)).toEqual({ ok: true });
      expect(scene.room_in).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ room_id: "abc123" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("頻道 2 的進房是 crossplay=false", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socket } = makePage(2);
      install(window);
      run(window, "window.__ulrMatch.context()");
      socket.fire("channel2_room", [rawRoom({ room_id: "abc123" })]);
      const p = run<Promise<string>>(window, buildJoinRoomExpression("abc123", "AB12CD34"));
      socket.fire("duel_standby");
      await p;
      expect(scene.room_in).toHaveBeenCalledWith(false, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("⚠ 換頻道之後，舊頻道的推播不能蓋掉新頻道的清單", () => {
    // 2026-08-15 實測踩到：人在頻道 4，raw 裡卻是頻道 2 的房。舊頻道的
    // listener 拆不掉、伺服器也還在推，共用一份清單就會互相蓋。
    // 後果是 findOwnRoom 從別的頻道挑房，把錯的 room_id 交給對手。
    const { window, scene, socket, socketCross } = makePage(2);
    install(window);
    run(window, "window.__ulrMatch.context()");
    socket.fire("channel2_room", [rawRoom({ room_id: "頻道2的房", name: "舊的" })]);

    // 玩家換到頻道 4
    scene.channel = 4;
    run(window, "window.__ulrMatch.context()");
    socketCross.fire("channel4_room", [rawRoom({ room_id: "頻道4的房", name: "新的" })]);

    // 舊頻道又推了一次 —— 不能污染目前頻道看到的東西
    socket.fire("channel2_room", [rawRoom({ room_id: "頻道2的房", name: "舊的" })]);

    const snap = JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()"));
    expect(snap.rooms.map((r: RoomEntry) => r.roomId)).toEqual(["頻道4的房"]);
  });

  it("剛換到沒收過推播的頻道，seq 是 0（＝還不知道，不是沒有房）", () => {
    const { window, scene, socket } = makePage(2);
    install(window);
    run(window, "window.__ulrMatch.context()");
    socket.fire("channel2_room", [rawRoom()]);

    scene.channel = 3;
    const snap = JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()"));
    // ⚠ seq 0 讓 preflight 分得出「這個頻道沒有房」跟「還不知道」。分不出來
    // 就會在空清單上判定「玩家沒有自己的房」，然後踩到 delete_room 那個坑。
    expect(snap).toEqual({ seq: 0, live: false, rooms: [] });
  });

  it("取消配對也要送到對的那條 socket", () => {
    const { window, socket, socketCross } = makePage(4);
    install(window);
    expect(run<string>(window, "window.__ulrMatch.cancel()")).toBe("ok");
    expect(socket.emitted).toHaveLength(0);
    expect(socketCross.emitted[0]).toMatchObject({ ev: "delete_room", args: [4] });
  });
});

describe("清單以遊戲手上那份為準，不靠推播", () => {
  // ⚠ 房間清單是「有變動才推」不是定時推 —— 2026-08-15 實測，頻道裡沒人開關房
  // 時等 45 秒一次推播都收不到。只靠推播快取的話，剛進頻道的玩家會看到空清單，
  // 而空清單會被誤判成「我沒有自己的房」，直接踩到 delete_room 是頻道層級的坑。

  it("一次推播都沒收到，也讀得到遊戲正在畫的那份", () => {
    const { window, scene } = makePage(4);
    scene.channel_panel.match_room_data = [rawRoom({ room_id: "遊戲手上的", name: "現在就有" })];
    install(window);

    const snap = JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()"));
    expect(snap.live).toBe(true);
    expect(snap.seq).toBe(0); // 真的一次推播都沒收到
    expect(snap.rooms.map((r: RoomEntry) => r.roomId)).toEqual(["遊戲手上的"]);
  });

  it("遊戲那份贏過推播快取", () => {
    const { window, scene, socketCross } = makePage(4);
    install(window);
    run(window, "window.__ulrMatch.context()");
    socketCross.fire("channel4_room", [rawRoom({ room_id: "推播來的" })]);

    scene.channel_panel.match_room_data = [rawRoom({ room_id: "遊戲手上的" })];
    const snap = JSON.parse(run<string>(window, "window.__ulrMatch.rooms_snapshot()"));
    expect(snap.rooms.map((r: RoomEntry) => r.roomId)).toEqual(["遊戲手上的"]);
  });

  it("join 也要用遊戲那份找房", async () => {
    vi.useFakeTimers();
    try {
      const { window, scene, socketCross } = makePage(4);
      scene.channel_panel.match_room_data = [rawRoom({ room_id: "只在遊戲那份裡" })];
      install(window);

      const p = run<Promise<string>>(window, buildJoinRoomExpression("只在遊戲那份裡", "AB12CD34"));
      socketCross.fire("duel_standby");
      expect(JSON.parse(await p)).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("官方常數（照抄客戶端 bundle，不是自己編的）", () => {
  it("⚠ 隨機是 014，000 是雷德貝魯格城 —— 這兩個很容易搞反", () => {
    // 官方對話框預設選清單第一項（000），不是隨機，所以大廳一堆房是
    // stage:"000"，看起來很像「沒選 = 隨機」。搞反的話玩家以為選了隨機，
    // 實際上每一場都在同一張地圖。
    expect(STAGES.find((s) => s.value === "014")?.name).toBe("隨機");
    expect(STAGES.find((s) => s.value === "000")?.name).toBe("雷德貝魯格城");
  });

  it("官方清單是 000~009 加 014", () => {
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
      "014",
    ]);
  });

  it("隱藏地圖是 010~013", () => {
    expect(HIDDEN_STAGES.map((s) => s.value)).toEqual(["010", "011", "012", "013"]);
  });

  it("隱藏地圖不能跟官方的重疊 —— 代號與名稱都是", () => {
    // ⚠ 名稱也要查：遊戲的下拉選單是拿**名稱**回查代號的
    // （`STAGES[lang].find((s) => s.name === item.name)`），撞名會讓官方那張
    // 選出錯的代號。
    const values = new Set(STAGES.map((s) => s.value));
    const names = new Set(STAGES.map((s) => s.name));
    for (const s of HIDDEN_STAGES) {
      expect(values.has(s.value)).toBe(false);
      expect(names.has(s.name)).toBe(false);
    }
  });

  it("Cost 限制只有 0~5", () => {
    expect(COST_RANGES).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stage 一律是 3 位數字串", () => {
    for (const v of [...STAGES, ...HIDDEN_STAGES].map((s) => s.value)) {
      expect(v).toMatch(/^\d{3}$/);
    }
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
    // ⚠ 退回「隨便挑一間」會把上一場的 room_id 交給對手 → 伺服器回 fail:9。
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
