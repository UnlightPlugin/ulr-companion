import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildDeckApplyExpression,
  buildEditDeckWriteExpression,
  DECK_READ_EXPRESSION,
  EDIT_DECK_READ_EXPRESSION,
  INVENTORY_READ_EXPRESSION,
  parseDeckApplyResult,
  parseDeckSnapshot,
  parseEditDeck,
  parseInventorySnapshot,
} from "../src/deck-write.js";
import type { DeckSlotWrite, ServerDeck } from "../src/deck-write.js";

// ---------------------------------------------------------------------------
// 假的遊戲（2026-09-23 改版後）
// ---------------------------------------------------------------------------

function deckOf(id: number, first: number | null): ServerDeck {
  return {
    deck_id: id,
    main: id === 1 ? 1 : 0,
    chara_card_id: [first, null, null],
    weapon_card_id: [null, null, null],
    event_card_id: new Array<number | null>(18).fill(null),
    card_effect: [],
    cost: 50,
  };
}

/** 假的 WSClient：記下 fetch 了什麼，`deck_update` 回 `answers` 的下一個。 */
class FakeSock {
  static made: FakeSock[] = [];
  static answers: unknown[] = [];
  fetched: { ev: string; args: unknown[] }[] = [];
  disconnected = false;
  listeners: Record<string, (() => void)[]> = {};
  constructor(public url: string) {
    FakeSock.made.push(this);
  }
  on(ev: string, fn: () => void): void {
    (this.listeners[ev] ??= []).push(fn);
  }
  fire(ev: string): void {
    for (const fn of this.listeners[ev] ?? []) fn();
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fetch(ev: string, ...args: unknown[]): Promise<unknown> {
    this.fetched.push({ ev, args });
    if (ev === "register") return Promise.resolve(0);
    if (ev === "db_deck")
      return Promise.resolve([deckOf(1, 685), deckOf(2, null), deckOf(3, null)]);
    if (ev === "deck_update") {
      const a = FakeSock.answers.shift();
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? false);
    }
    return Promise.resolve(null);
  }
}

interface FakeRoom {
  active: boolean;
  scene: { isActive: () => boolean };
  deck: ServerDeck[];
  deck_now: number;
  deck_card: unknown[];
  channel?: Record<string, unknown> | null;
  calls: string[];
  [k: string]: unknown;
}

function fakeScene(name: string, deck: ServerDeck[], kind: "room" | "edit"): FakeRoom {
  const sc: FakeRoom = {
    active: false,
    scene: { isActive: () => sc.active },
    deck,
    deck_now: 1,
    deck_card: [],
    calls: [],
  };
  if (kind === "room") sc["show_deck"] = () => sc.calls.push(`${name}.show_deck`);
  else {
    sc["refresh"] = () => sc.calls.push("refresh");
    sc["show_deck_label"] = () => sc.calls.push("show_deck_label");
    sc["show_cost"] = () => sc.calls.push("show_cost");
  }
  return sc;
}

interface Game {
  sandbox: Record<string, unknown>;
  win: Record<string, unknown>;
  registry: Record<string, unknown>;
  scenes: Record<string, FakeRoom>;
  emitChange: (value: unknown) => void;
}

function makeGame(opts: { mirror?: boolean } = {}): Game {
  FakeSock.made = [];
  FakeSock.answers = [];
  const deck = [deckOf(1, 685), deckOf(2, null), deckOf(3, null)];
  const registry: Record<string, unknown> = {
    player_id: "pid-123",
    deck,
    deck_now: 1,
    player: { player_name: "燈皇", regist_at: "2025-03-01T12:34:56.789Z" },
    chara_card: [{ card_id: 685, quantity: 1, extra: "x" }],
    weapon_card: [{ card_id: 6, quantity: 2 }],
    event_card: [{ card_id: 28, quantity: 150 }],
  };
  const changeHandlers: ((p: unknown, v: unknown) => void)[] = [];
  const scenes = {
    Edit: fakeScene("Edit", deck, "edit"),
    Quest: fakeScene("Quest", deck, "room"),
    Raid: fakeScene("Raid", deck, "room"),
    Match: fakeScene("Match", deck, "room"),
    Lobby: { scene: { isActive: () => true }, socket: new FakeSock("lobby-scene") },
  } as unknown as Record<string, FakeRoom>;
  FakeSock.made = [];
  const game = {
    scene: { keys: scenes },
    registry: {
      get: (k: string) => registry[k],
      events: {
        on: (_ev: string, fn: (p: unknown, v: unknown) => void) => changeHandlers.push(fn),
      },
    },
  };
  const win: Record<string, unknown> = { game };
  if (opts.mirror !== false) {
    win["__ulrDeckMirror"] = {
      v: 1,
      game,
      server: JSON.parse(JSON.stringify(deck)),
      at: 1,
      source: "test",
    };
  }
  const sandbox: Record<string, unknown> = {
    window: win,
    UL_CONFIG: { domains: { lobby: { urls: ["https://x"], ports: [11002] } } },
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout,
    Promise,
    JSON,
    Array,
    Uint8Array,
  };
  vm.createContext(sandbox);
  return {
    sandbox,
    win,
    registry,
    scenes,
    emitChange: (value) => changeHandlers.forEach((fn) => fn(null, value)),
  };
}

async function evalIn(g: Game, expr: string): Promise<string> {
  return (await vm.runInContext(expr, g.sandbox)) as string;
}

const allFetched = () => FakeSock.made.flatMap((s) => s.fetched.map((f) => f.ev));

// ---------------------------------------------------------------------------

describe("讀伺服器那份（DECK_READ_EXPRESSION）", () => {
  it("頁面記過伺服器那份 → 一趟網路都不跑", async () => {
    const g = makeGame();
    const snap = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(snap.source).toBe("mirror");
    expect(snap.decks.map((d) => d.deck_id)).toEqual([1, 2, 3]);
    expect(snap.accountLabel).toBe("燈皇");
    expect(snap.account).toMatch(/^[0-9a-f]{8}$/);
    expect(FakeSock.made).toHaveLength(0);
  });

  it("⚠ 指紋是玩家名稱的雜湊 —— player_id 每次登入都換，指紋不能跟著換", async () => {
    const g = makeGame();
    const first = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    const want = createHash("sha256").update("燈皇").digest("hex").slice(0, 8);
    expect(first.account).toBe(want);
    // 2026-09-25 實機：遊戲重載一次 player_id 就換一個 UUID
    g.registry["player_id"] = "0b6c0a0e-1111-4222-8333-944445555666";
    const again = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(again.account).toBe(want);
    expect(again.syncKey).toBe(first.syncKey);
  });

  it("雲端鍵 = SHA-256(前綴 + 名稱 + 換行 + 註冊時間) 的 64 hex", async () => {
    const snap = parseDeckSnapshot(await evalIn(makeGame(), DECK_READ_EXPRESSION));
    const want = createHash("sha256")
      .update("ulr-deck-sync\n燈皇\n2025-03-01T12:34:56.789Z")
      .digest("hex");
    expect(snap.syncKey).toBe(want);
  });

  it("⚠ 讀不到註冊時間 → 不給雲端鍵（絕不退回只用公開的名稱算）", async () => {
    const g = makeGame();
    g.registry["player"] = { player_name: "燈皇" };
    const snap = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(snap.account).toMatch(/^[0-9a-f]{8}$/);
    expect(snap.syncKey).toBeNull();
  });

  it("讀不到名稱 = 還沒登入", async () => {
    const g = makeGame();
    g.registry["player"] = {};
    expect(await evalIn(g, DECK_READ_EXPRESSION)).toContain("還沒登入");
  });

  it("還沒記過 → register 一次、db_deck 一次，記下來；第二次就不再送", async () => {
    const g = makeGame({ mirror: false });
    const first = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(first.source).toBe("server");
    expect(allFetched()).toEqual(["register", "db_deck"]);
    const second = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(second.source).toBe("mirror");
    expect(allFetched()).toEqual(["register", "db_deck"]);
  });

  it("⚠ 走的是 lobby 池（Edit 就是用它），不是玩家當下那條 socket", async () => {
    const g = makeGame({ mirror: false });
    await evalIn(g, DECK_READ_EXPRESSION);
    expect(FakeSock.made[0]!.url).toBe("https://x:11002");
  });

  it("官方整份換掉 registry.deck（離開牌組編輯、開機）→ 伺服器那份跟上，而且是拷貝", async () => {
    const g = makeGame({ mirror: false });
    await evalIn(g, DECK_READ_EXPRESSION); // 裝上監聽
    const fresh = [deckOf(1, 111), deckOf(2, 222), deckOf(3, null)];
    g.emitChange(fresh);
    fresh[0]!.chara_card_id[0] = 999; // 之後玩家在 Edit 就地改 —— 不能連伺服器那份一起改
    const snap = parseDeckSnapshot(await evalIn(g, DECK_READ_EXPRESSION));
    expect(snap.decks[0]!.chara_card_id[0]).toBe(111);
    expect(snap.decks[1]!.chara_card_id[0]).toBe(222);
  });

  it("頁面回報的錯誤要變成例外；指紋格式不對要擋", () => {
    expect(() => parseDeckSnapshot(JSON.stringify({ error: "還沒登入" }))).toThrow(/還沒登入/);
    expect(() =>
      parseDeckSnapshot(JSON.stringify({ account: "PID", decks: [deckOf(1, 1)] })),
    ).toThrow(/指紋/);
    expect(() => parseDeckSnapshot(JSON.stringify({ account: "4858c81f", decks: [] }))).toThrow();
    expect(() => parseDeckSnapshot("不是 JSON")).toThrow(/JSON/);
  });
});

describe("⚠⚠ 快取的連線要還連著才重用（2026-09-13）", () => {
  const read = (g: Game) => evalIn(g, DECK_READ_EXPRESSION);
  const fresh = (g: Game) => {
    delete (g.win["__ulrDeckMirror"] as Record<string, unknown>)?.["server"];
    (g.win["__ulrDeckMirror"] as Record<string, unknown>)["server"] = null;
  };

  it("舊版留下、沒有連線記號的那一條 → 拆掉換新的", async () => {
    const g = makeGame({ mirror: false });
    const stuck = new FakeSock("stuck");
    FakeSock.made = [];
    g.win["__ulrDeckSock"] = stuck;
    await read(g);
    expect(stuck.disconnected).toBe(true);
    expect(g.win["__ulrDeckSock"]).toBe(FakeSock.made[0]);
  });

  it("連著的那一條照常重用；register 每條連線只做一次", async () => {
    const g = makeGame({ mirror: false });
    await read(g);
    const first = FakeSock.made[0]!;
    first.fire("connect");
    g.win["__ulrDeckSockAt"] = 0;
    fresh(g);
    await read(g);
    expect(FakeSock.made).toHaveLength(1);
    expect(first.fetched.map((f) => f.ev)).toEqual(["register", "db_deck", "db_deck"]);
  });

  it("斷線過 → register 要重做；卡太久沒連上 → 換新的", async () => {
    const g = makeGame({ mirror: false });
    await read(g);
    const first = FakeSock.made[0]!;
    first.fire("connect");
    first.fire("close");
    fresh(g);
    await read(g); // 還在寬限內：重用，但要重新 register
    expect(FakeSock.made).toHaveLength(1);
    expect(first.fetched.filter((f) => f.ev === "register")).toHaveLength(2);
    g.win["__ulrDeckSockAt"] = 0;
    fresh(g);
    await read(g);
    expect(first.disconnected).toBe(true);
    expect(FakeSock.made).toHaveLength(2);
  });

  it("換帳號登入 → 同一條連線也要用新的 id 重新 register", async () => {
    const g = makeGame({ mirror: false });
    await read(g);
    FakeSock.made[0]!.fire("connect");
    g.registry["player_id"] = "someone-else";
    fresh(g);
    await read(g);
    const regs = FakeSock.made[0]!.fetched.filter((f) => f.ev === "register").map((f) => f.args[0]);
    expect(regs).toEqual(["pid-123", "someone-else"]);
  });
});

describe("寫進伺服器（buildDeckApplyExpression）", () => {
  const next = () => [deckOf(1, 777), deckOf(2, null), deckOf(3, null)];

  it("deck_update 回 false = 成功：伺服器那份記下來、客戶端記憶體**就地**跟上、重畫", async () => {
    const g = makeGame();
    const before = g.registry["deck"];
    g.scenes["Raid"]!.active = true;
    const r = parseDeckApplyResult(await evalIn(g, buildDeckApplyExpression(next())));
    expect(r).toEqual({ answer: "ok", refreshed: "Raid" });
    expect(g.registry["deck"]).toBe(before); // 同一個陣列 —— 每個場景拿的都是它
    expect((g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0]).toBe(777);
    const mirror = g.win["__ulrDeckMirror"] as { server: ServerDeck[] };
    expect(mirror.server[0]!.chara_card_id[0]).toBe(777);
    const sent = FakeSock.made[0]!.fetched.find((f) => f.ev === "deck_update");
    expect((sent!.args[0] as ServerDeck[])[0]!.chara_card_id[0]).toBe(777);
  });

  it("回 true = 伺服器退回：記憶體與伺服器那份都不動", async () => {
    const g = makeGame();
    FakeSock.answers = [true];
    const r = parseDeckApplyResult(await evalIn(g, buildDeckApplyExpression(next())));
    expect(r.answer).toBe("rejected");
    expect((g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0]).toBe(685);
  });

  it("丟例外 = 不知道有沒有寫進去（no-answer），記憶體不動", async () => {
    const g = makeGame();
    FakeSock.answers = [new Error("斷線")];
    const r = parseDeckApplyResult(await evalIn(g, buildDeckApplyExpression(next())));
    expect(r.answer).toBe("no-answer");
    expect((g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0]).toBe(685);
  });

  it("⚠ 三副全是空的 → 頁面端拒絕，不送（第二道鎖）", async () => {
    const g = makeGame();
    const out = await evalIn(g, buildDeckApplyExpression([deckOf(1, null), deckOf(2, null)]));
    expect(() => parseDeckApplyResult(out)).toThrow(/空/);
    expect(allFetched()).not.toContain("deck_update");
  });

  it("牌組是用 JSON.parse 讀進去的（__proto__ 防護）", () => {
    expect(buildDeckApplyExpression(next())).toContain("JSON.parse(");
  });
});

describe("庫存（INVENTORY_READ_EXPRESSION）", () => {
  it("讀 registry，一趟網路都不跑，只帶 card_id 與數量", async () => {
    const g = makeGame();
    const inv = parseInventorySnapshot(await evalIn(g, INVENTORY_READ_EXPRESSION));
    expect(inv.chara).toEqual([{ card_id: 685, quantity: 1 }]);
    expect(inv.weapon).toEqual([{ card_id: 6, quantity: 2 }]);
    expect(FakeSock.made).toHaveLength(0);
  });

  it("帶回玩家角色卡的格子鍵（只有 kind 0；怪物、記憶碎片不列）", async () => {
    const g = makeGame();
    const cards = [
      { id: 347, kind: 0, filename: "cc035_r02" },
      { id: 350, kind: 0, filename: "cc035_r05" },
      { id: 1001, kind: 1, filename: "mc001_01" },
      { id: 10012, kind: 7, filename: "cmem_6" },
    ];
    (g.sandbox["window"] as { game: Record<string, unknown> }).game["cache"] = {
      json: { get: (k: string) => (k === "CharaCards" ? cards : undefined) },
    };
    const inv = parseInventorySnapshot(await evalIn(g, INVENTORY_READ_EXPRESSION));
    expect(inv.charaFiles).toEqual({ "347": "cc035_r02", "350": "cc035_r05" });
  });

  it("讀不到卡片資料 → 格子鍵是空的，庫存照樣回", async () => {
    const inv = parseInventorySnapshot(await evalIn(makeGame(), INVENTORY_READ_EXPRESSION));
    expect(inv.charaFiles).toEqual({});
    expect(inv.chara).toHaveLength(1);
  });

  it("庫存還沒載入 → 例外（呼叫端當成不准寫）", async () => {
    const g = makeGame();
    g.registry["chara_card"] = undefined;
    expect(() => parseInventorySnapshot(JSON.stringify({ error: "x" }))).toThrow();
    const out = await evalIn(g, INVENTORY_READ_EXPRESSION);
    expect(() => parseInventorySnapshot(out)).toThrow(/庫存/);
  });
});

describe("讀玩家眼前那份（EDIT_DECK_READ_EXPRESSION）", () => {
  it("沒有有牌組列的畫面 → null（呼叫端改讀伺服器那份）", async () => {
    const g = makeGame();
    expect(parseEditDeck(await evalIn(g, EDIT_DECK_READ_EXPRESSION))).toBeNull();
  });

  it("Edit：where=edit、整份照 deck_id 排好、帶伺服器那份與 deck_now", async () => {
    const g = makeGame();
    g.scenes["Edit"]!.active = true;
    g.scenes["Edit"]!.deck_now = 2;
    (g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0] = 900; // 玩家正在排
    const r = parseEditDeck(await evalIn(g, EDIT_DECK_READ_EXPRESSION))!;
    expect(r.where).toBe("edit");
    expect(r.deckNow).toBe(2);
    expect(r.decks[0]!.chara_card_id[0]).toBe(900);
    expect(r.server![0]!.chara_card_id[0]).toBe(685);
    expect(r.account).toMatch(/^[0-9a-f]{8}$/);
  });

  it("房間場景：where=room（自動存檔靠它分辨玩家的編輯與進房預載）", async () => {
    for (const name of ["Quest", "Raid", "Match"]) {
      const g = makeGame();
      g.scenes[name]!.active = true;
      expect(parseEditDeck(await evalIn(g, EDIT_DECK_READ_EXPRESSION))?.where).toBe("room");
    }
  });
});

describe("換牌組的快路徑（buildEditDeckWriteExpression，只動記憶體）", () => {
  const slot = (deckId: number, first: number | null): DeckSlotWrite => ({
    deckId,
    chara_card_id: [first, null, null],
    weapon_card_id: [null, null, null],
    event_card_id: new Array<number | null>(18).fill(null),
  });

  it("Edit：就地改那一格、釘 deck_now、照原版 ◀▶ 的三下重畫，回 ok", async () => {
    const g = makeGame();
    const ed = g.scenes["Edit"]!;
    ed.active = true;
    ed.deck_now = 3;
    const before = g.registry["deck"];
    expect(await evalIn(g, buildEditDeckWriteExpression([slot(1, 777)], 1))).toBe("ok");
    expect(g.registry["deck"]).toBe(before);
    expect((before as ServerDeck[])[0]!.chara_card_id[0]).toBe(777);
    expect(ed.deck_now).toBe(1);
    expect(ed.calls).toEqual(["refresh", "show_deck_label", "show_cost"]);
    expect(FakeSock.made).toHaveLength(0);
  });

  it("⚠ Edit 收空牌組（等於幫玩家按 reset）", async () => {
    const g = makeGame();
    g.scenes["Edit"]!.active = true;
    expect(await evalIn(g, buildEditDeckWriteExpression([slot(1, null)], 1))).toBe("ok");
  });

  it("⚠⚠ 房間場景回 ok-room，不能跟編輯畫面的 ok 混在一起（沒有人會把它送上伺服器）", async () => {
    const g = makeGame();
    const q = g.scenes["Quest"]!;
    q.active = true;
    expect(await evalIn(g, buildEditDeckWriteExpression([slot(1, 777)], 1))).toBe("ok-room");
    expect(q.calls).toEqual(["Quest.show_deck"]);
  });

  it("⚠ 房間場景：要釘的那一格是空的 → empty-room，不寫", async () => {
    const g = makeGame();
    g.scenes["Raid"]!.active = true;
    expect(await evalIn(g, buildEditDeckWriteExpression([slot(1, null)], 1))).toBe("empty-room");
    expect((g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0]).toBe(685);
  });

  it("官方三牌組模式：三格一起換、deck_now 不動；空的第 3 格照寫", async () => {
    const g = makeGame();
    const r = g.scenes["Raid"]!;
    r.active = true;
    r.deck_now = 2;
    const out = await evalIn(
      g,
      buildEditDeckWriteExpression([slot(1, 1), slot(2, 2), slot(3, null)], null),
    );
    expect(out).toBe("ok-room");
    expect((g.registry["deck"] as ServerDeck[]).map((d) => d.chara_card_id[0])).toEqual([
      1,
      2,
      null,
    ]);
    expect(r.deck_now).toBe(2);
  });

  it("畫面沒開著 → not-active，什麼都沒動", async () => {
    const g = makeGame();
    expect(await evalIn(g, buildEditDeckWriteExpression([slot(1, 777)], 1))).toBe("not-active");
    expect((g.registry["deck"] as ServerDeck[])[0]!.chara_card_id[0]).toBe(685);
  });

  it("房間的 cost:NN 照房型算好填進去：迪城問自訂價、亞城問官方價", async () => {
    for (const [channel, custom, want] of [
      [{ channel: 2, type: "duel" }, true, 92],
      [{ channel: 1, type: "ranked" }, false, 91],
    ] as const) {
      const g = makeGame();
      const asked: boolean[] = [];
      g.win["__ulrDeckEdit"] = {
        costFor: (_c: unknown, c: boolean) => (asked.push(c), c ? 92 : 91),
      };
      const m = g.scenes["Match"]!;
      m.active = true;
      m.channel = channel;
      await evalIn(g, buildEditDeckWriteExpression([slot(1, 777)], 1));
      expect(asked).toEqual([custom]);
      expect((g.registry["deck"] as ServerDeck[])[0]!.cost).toBe(want);
    }
  });

  it("算不出 COST 時維持原值，不寫壞", async () => {
    const g = makeGame();
    g.scenes["Quest"]!.active = true;
    await evalIn(g, buildEditDeckWriteExpression([slot(1, 777)], 1));
    expect((g.registry["deck"] as ServerDeck[])[0]!.cost).toBe(50);
  });
});
