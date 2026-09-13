import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DECK_READ_EXPRESSION,
  EDIT_DECK_READ_EXPRESSION,
  INVENTORY_READ_EXPRESSION,
  buildDeckApplyExpression,
  buildEditDeckWriteExpression,
  parseDeckApplyResult,
  parseDeckSnapshot,
  parseEditDeck,
  parseInventorySnapshot,
} from "../src/deck-write.js";
import type { DeckPayload } from "../src/deck-write.js";

function payload(charaIndex: number | null): DeckPayload {
  return {
    chara: [charaIndex === null ? null : "cc069", null, null],
    charaIndex: [charaIndex, null, null],
    eventIndex: new Array<number | null>(18).fill(null),
    weapon: [null, null, null],
    cost: 0,
  };
}

/** 2026-08-24 實機讀到的形狀。 */
const SNAPSHOT = JSON.stringify({
  account: "4858c81f",
  accountLabel: "燈皇",
  deckNow: 1,
  deckCheck: true,
  decks: [{ chara1: "cc069", charaIndex1: 684 }, {}, {}],
  endpoint: "https://www.playunlight.online:11006",
});

describe("parseDeckSnapshot", () => {
  it("讀得出實機那份快照", () => {
    const snap = parseDeckSnapshot(SNAPSHOT);
    expect(snap.account).toBe("4858c81f");
    expect(snap.accountLabel).toBe("燈皇");
    expect(snap.deckNow).toBe(1);
    expect(snap.deckCheck).toBe(true);
    expect(snap.decks).toHaveLength(3);
    expect(snap.endpoint).toContain(":11006");
  });

  it("頁面回報的錯誤要變成例外，不能當成空資料吞掉", () => {
    expect(() => parseDeckSnapshot(JSON.stringify({ error: "遊戲還沒起來" }))).toThrow(
      /遊戲還沒起來/,
    );
  });

  it("不是三副就是壞的 —— 少一副會讓後續寫回把它清空", () => {
    expect(() =>
      parseDeckSnapshot(JSON.stringify({ account: "4858c81f", decks: [{}, {}] })),
    ).toThrow(/預期三副/);
  });

  it("指紋格式不對要擋下來 —— 錯的指紋會把牌組存到別人的庫裡", () => {
    const bad = JSON.stringify({ account: "燈皇", decks: [{}, {}, {}] });
    expect(() => parseDeckSnapshot(bad)).toThrow(/指紋/);
  });

  it("不是 JSON 也要給得出人看得懂的錯", () => {
    expect(() => parseDeckSnapshot("<html>")).toThrow(/不是 JSON/);
  });

  it("deck_check 沒給時當成 true —— 預設不要動玩家的 UI 偏好", () => {
    const snap = parseDeckSnapshot(JSON.stringify({ account: "4858c81f", decks: [{}, {}, {}] }));
    expect(snap.deckCheck).toBe(true);
  });

  it("沒設最愛角色時 favorite 是 null —— 這時換牌組會連帶換掉大廳立繪", () => {
    expect(parseDeckSnapshot(SNAPSHOT).favorite).toBeNull();
  });

  it("設了最愛角色要讀得出來 —— 立繪固定成它，Deck1 寫什麼都不影響大廳", () => {
    const raw = JSON.stringify({
      account: "4858c81f",
      favorite: "cc069",
      decks: [{}, {}, {}],
    });
    expect(parseDeckSnapshot(raw).favorite).toBe("cc069");
  });

  it("讀取表達式有把 favorite 帶回來", () => {
    expect(DECK_READ_EXPRESSION).toContain("favorite");
  });
});

describe("parseDeckApplyResult", () => {
  it("ack 為真才算寫進去", () => {
    const r = parseDeckApplyResult(
      JSON.stringify({ ack: true, synced: ["Match", "Edit"], refreshed: "Match.change_deck" }),
    );
    expect(r.ack).toBe(true);
    expect(r.synced).toEqual(["Match", "Edit"]);
    expect(r.refreshed).toBe("Match.change_deck");
  });

  it("沒有 ack 就是沒寫進去，不能當成成功", () => {
    expect(parseDeckApplyResult(JSON.stringify({ ack: false, synced: [] })).ack).toBe(false);
    expect(parseDeckApplyResult(JSON.stringify({ synced: [] })).ack).toBe(false);
  });

  it("頁面端的拒絕（Deck1 空）要變成例外", () => {
    expect(() =>
      parseDeckApplyResult(JSON.stringify({ error: "拒絕寫入：Deck1 第一格是空的" })),
    ).toThrow(/Deck1 第一格是空的/);
  });
});

describe("buildDeckApplyExpression", () => {
  it("腳本裡有 Deck1 非空的閘門 —— 這是頁面端的第二道鎖", () => {
    const src = buildDeckApplyExpression([payload(684), payload(null), payload(null)], true);
    expect(src).toContain("拒絕寫入");
    expect(src).toContain("D[0].charaIndex[0]");
  });

  it("deck_check 照原值帶進腳本", () => {
    const on = buildDeckApplyExpression([payload(684), payload(null), payload(null)], true);
    const off = buildDeckApplyExpression([payload(684), payload(null), payload(null)], false);
    expect(on).toContain("D[0], D[1], D[2], true");
    expect(off).toContain("D[0], D[1], D[2], false");
  });

  it("牌組是用 JSON.parse 讀進去的，不是物件字面值（__proto__ 防護）", () => {
    const src = buildDeckApplyExpression([payload(684), payload(null), payload(null)], true);
    expect(src).toContain("JSON.parse(");
  });

  it("送到 game 池，不是玩家當下那條 socket", () => {
    const src = buildDeckApplyExpression([payload(684), payload(null), payload(null)], true);
    expect(src).toContain("UL_CONFIG.domains.game");
    expect(src).not.toContain("domains.duel");
  });
});

describe("parseInventorySnapshot", () => {
  it("三張表都讀得出來", () => {
    const inv = parseInventorySnapshot(
      JSON.stringify({ chara: { "69": "1,0" }, event: { "2": 150 }, weapon: { "65": 2 } }),
    );
    expect(inv.chara["69"]).toBe("1,0");
    expect(inv.event["2"]).toBe(150);
    expect(inv.weapon["65"]).toBe(2);
  });

  it("缺的表當成空的，不要炸掉", () => {
    const inv = parseInventorySnapshot(JSON.stringify({ chara: { "69": "1" } }));
    expect(inv.event).toEqual({});
    expect(inv.weapon).toEqual({});
  });
});

describe("讀取用的表達式", () => {
  it("都走自己開的 game 連線", () => {
    for (const src of [DECK_READ_EXPRESSION, INVENTORY_READ_EXPRESSION]) {
      expect(src).toContain("__ulrDeckSock");
      expect(src).toContain("UL_CONFIG.domains.game");
    }
  });

  it("id 不快取 —— 快取的話玩家換帳號會讀到上一個人的", () => {
    expect(DECK_READ_EXPRESSION).toContain("pid = host.id");
    expect(DECK_READ_EXPRESSION).not.toContain("window.__ulrDeckId");
  });

  it("回傳的是指紋，不是玩家 id 本身（§12）", () => {
    expect(DECK_READ_EXPRESSION).toContain("crypto.subtle.digest");
    expect(DECK_READ_EXPRESSION).toContain("account: __fp");
  });
});

describe("⚠⚠ 快取的 game 連線要還連著才重用（2026-09-13）", () => {
  // 實機：遊戲斷線一次之後，__ulrDeckSock 自己重連、WebSocket 開著，卻卡在
  // REGISTERING 永遠等不到 __connected —— 每次 fetch 都逾時，換牌組全部被
  // 「讀不到庫存」擋下來。

  /** 假的 WSClient：記錄自己被建了幾條、有沒有被拆，事件照 on/emit 走。 */
  class FakeSock {
    static made: FakeSock[] = [];
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
    fetch(): Promise<unknown> {
      return Promise.resolve({});
    }
  }

  function sandboxWith(win: Record<string, unknown>): Record<string, unknown> {
    FakeSock.made = [];
    const host = { socket: new FakeSock("game-scene"), id: "pid" };
    FakeSock.made = [];
    const sandbox = {
      window: { game: { scene: { keys: { Raid: host } } }, ...win },
      UL_CONFIG: { domains: { game: { urls: ["https://x"], ports: [11002] } } },
    };
    vm.createContext(sandbox);
    return sandbox;
  }

  async function readInventory(sandbox: Record<string, unknown>): Promise<string> {
    return (await vm.runInContext(INVENTORY_READ_EXPRESSION, sandbox)) as string;
  }

  const win = (sb: Record<string, unknown>) => sb["window"] as Record<string, unknown>;

  it("舊版留下、沒有連線記號的那一條 → 拆掉換新的", async () => {
    const stuck = new FakeSock("stuck");
    const sb = sandboxWith({ __ulrDeckSock: stuck });
    const out = await readInventory(sb);
    expect(JSON.parse(out).error).toBeUndefined();
    expect(stuck.disconnected).toBe(true);
    expect(FakeSock.made).toHaveLength(1);
    expect(win(sb)["__ulrDeckSock"]).toBe(FakeSock.made[0]);
  });

  it("連著的那一條照常重用，不會每次都開新的", async () => {
    const sb = sandboxWith({});
    await readInventory(sb);
    const first = FakeSock.made[0]!;
    first.fire("connect");
    // 就算建立時間已經很久以前，連著就是連著
    win(sb)["__ulrDeckSockAt"] = 0;
    await readInventory(sb);
    expect(FakeSock.made).toHaveLength(1);
    expect(first.disconnected).toBe(false);
  });

  it("剛開、還在握手的那一條也重用 —— 連按兩下不能開出兩條", async () => {
    const sb = sandboxWith({});
    await readInventory(sb);
    await readInventory(sb);
    expect(FakeSock.made).toHaveLength(1);
  });

  it("斷線後自己重連卻一直沒連上 → 過了寬限時間就換新的", async () => {
    const sb = sandboxWith({});
    await readInventory(sb);
    const first = FakeSock.made[0]!;
    first.fire("connect");
    first.fire("close");
    // 剛斷：還在寬限內，給 WSClient 自己重連的機會
    await readInventory(sb);
    expect(FakeSock.made).toHaveLength(1);
    // 卡住很久了
    win(sb)["__ulrDeckSockAt"] = 0;
    await readInventory(sb);
    expect(first.disconnected).toBe(true);
    expect(FakeSock.made).toHaveLength(2);
  });

  it("被換掉的舊連線晚到的 close／connect，不能動到新那條的記號", async () => {
    const sb = sandboxWith({});
    await readInventory(sb);
    const first = FakeSock.made[0]!;
    first.fire("connect");
    first.fire("close");
    win(sb)["__ulrDeckSockAt"] = 0;
    await readInventory(sb);
    const second = FakeSock.made[1]!;
    second.fire("connect");
    // disconnect() 之後舊的那條才把事件發出來
    first.fire("close");
    first.fire("connect");
    expect(win(sb)["__ulrDeckSockLive"]).toBe(second);
    win(sb)["__ulrDeckSockAt"] = 0;
    await readInventory(sb);
    expect(FakeSock.made).toHaveLength(2);
  });
});

describe("讀編輯中的那一副（客戶端記憶體）", () => {
  it("畫面沒開著回 null —— 那時候伺服器才是真相", () => {
    expect(parseEditDeck(JSON.stringify({ active: false }))).toBeNull();
    expect(parseEditDeck(JSON.stringify({ error: "爆了" }))).toBeNull();
    expect(parseEditDeck("<html>")).toBeNull();
  });

  it("讀得出陣列版的形狀（跟 db_deck* 的扁平版不一樣）", () => {
    const deck = {
      chara: ["cc010", null, null],
      charaIndex: [90, null, null],
      eventIndex: new Array(18).fill(null),
      weapon: [null, null, null],
      cost: 26,
    };
    expect(parseEditDeck(JSON.stringify({ active: true, deck, where: "edit" }))).toEqual({
      deck,
      where: "edit",
    });
  });

  it("帶回是從哪個畫面讀的 —— 自動存檔靠它分辨玩家的編輯與進房 preload", () => {
    const deck = { chara: ["cc010", null, null] };
    expect(parseEditDeck(JSON.stringify({ active: true, deck, where: "edit" }))?.where).toBe(
      "edit",
    );
    expect(parseEditDeck(JSON.stringify({ active: true, deck, where: "room" }))?.where).toBe(
      "room",
    );
    // ⚠ 認不出來時要當成 room（保守的那一邊）：猜成 edit 會吃掉玩家的牌組，
    //   猜成 room 只是少存一次編輯。
    expect(parseEditDeck(JSON.stringify({ active: true, deck }))?.where).toBe("room");
  });

  it("只讀 deck1 —— 讀 deck_now 的話玩家切過 2 就會讀錯一副", () => {
    expect(EDIT_DECK_READ_EXPRESSION).toContain("sc.deck1");
    // ⚠ 比對的是**取值的寫法**，不是「有沒有出現這個字」—— 註解裡提到
    // deck_now 是應該的（那正是要解釋為什麼不讀它）。
    expect(EDIT_DECK_READ_EXPRESSION).not.toContain("sc.deck_now");
    expect(EDIT_DECK_READ_EXPRESSION).not.toContain('sc["deck" +');
  });

  it("Edit 沒 active 就不讀 —— 記憶體裡可能是上次進來留下的舊資料", () => {
    expect(EDIT_DECK_READ_EXPRESSION).toContain("sc.scene.isActive()");
  });

  it("⚠⚠ 讀取端要跟寫入端認得一樣多的場景", () => {
    // 2026-09-09 踩過：寫入端教會了它認房間場景、讀取端沒有 —— 於是在任務房裡
    // 讀取端回 active:false，呼叫端退回去讀**伺服器**的 Deck1（那是刻意延後、
    // 還沒更新的舊資料），拿它去比「選的這副跟手上這副一不一樣」，判成一模一樣
    // → 不寫、不重畫 → **玩家永遠換不到那一副**。
    //
    // 兩邊認的場景一旦漂開，症狀就是「有時候換不過去」。
    for (const scene of ["Edit", "Quest", "Raid", "Match"]) {
      expect(EDIT_DECK_READ_EXPRESSION).toContain(scene);
      expect(buildEditDeckWriteExpression(payload(90))).toContain(scene);
    }
  });

  it("讀回來會說是從哪裡讀的（編輯畫面還是房間）", () => {
    expect(EDIT_DECK_READ_EXPRESSION).toContain("where:");
  });
});

describe("換牌組的快路徑（只動記憶體）", () => {
  const deck = payload(90);

  it("整個換掉 deck1，不是就地改欄位 —— 照抄遊戲自己的 reset 鈕", () => {
    expect(buildEditDeckWriteExpression(deck)).toContain("sc.deck1 = {");
  });

  it("換完呼叫遊戲自己的重畫，cost 標籤不自己算", () => {
    expect(buildEditDeckWriteExpression(deck)).toContain("ed.edit_reflesh()");
  });

  // ── 房間場景（2026-09-09 加）──────────────────────────────────────────
  //
  // 玩家在任務房按左下角的 ◀▶ 換牌組時，Edit 畫面根本沒開著 —— 只認 Edit 的
  // 版本會讓畫面上那三張卡完全不動，而症狀是「按了箭頭沒反應」。

  it("Edit 沒開著時也認任務／渦／對戰房，會用它們自己的重畫", () => {
    const src = buildEditDeckWriteExpression(deck);
    expect(src).toContain('"Quest", "Raid", "Match"');
    expect(src).toContain("sc.deck_card(sc.deck1)");
    expect(src).toContain("sc.change_deck(0)");
  });

  it("⚠⚠ 房間場景回 ok-room，不能跟編輯畫面的 ok 混在一起", () => {
    // 兩者的差別是「還要不要寫伺服器」：編輯畫面遊戲自己會送，房間場景**沒有
    // 人會送**。混成同一個值的話，開戰前的提交會提早 return，伺服器上還是舊的
    // 那一副 —— 而畫面看起來完全正常，這是最難發現的那一種。
    const src = buildEditDeckWriteExpression(deck);
    expect(src).toContain('return "ok-room"');
    expect(src).toContain('return "ok"');
  });

  it('⚠ 標籤是 JSON.parse 進去的 —— 不給名字時要是 null，不是字串 "null"', () => {
    // embedJson() 給的是「要餵給 JSON.parse 的字串字面值」。少了那層 parse，
    // label 會變成字串 "null"，於是遊戲裡那行小字真的印出「null」。
    expect(buildEditDeckWriteExpression(deck)).toContain("var label = JSON.parse(");
    expect(buildEditDeckWriteExpression(deck)).not.toContain('var label = "null"');
  });

  it("給了名字就寫進房裡那行小字", () => {
    const src = buildEditDeckWriteExpression(deck, "打魚用");
    expect(src).toContain("sc.deck_name.setText(label");
    expect(src).toContain("打魚用");
  });

  it("⚠ 一次網路都不跑 —— 這正是它比走伺服器快的原因", () => {
    const src = buildEditDeckWriteExpression(deck);
    expect(src).not.toContain("db_editdeck");
    expect(src).not.toContain("__ulrDeckSock");
    expect(src).not.toContain("emit");
  });

  it("畫面沒開著回 not-active，呼叫端才知道要改走伺服器", () => {
    expect(buildEditDeckWriteExpression(deck)).toContain("not-active");
    expect(buildEditDeckWriteExpression(deck)).toContain("sc.scene.isActive()");
  });

  it("牌組是用 JSON.parse 進去的（__proto__ 防護）", () => {
    expect(buildEditDeckWriteExpression(deck)).toContain("JSON.parse(");
  });

  it("deck_now 釘 1 —— 牌組庫只用 Deck1 這個工作槽", () => {
    expect(buildEditDeckWriteExpression(deck)).toContain("sc.deck_now = 1");
  });
});

/**
 * 空牌組的快路徑（2026-09-12）—— **真的跑起來**驗，不比字串。
 *
 * 玩家在 Edit 選了一副空的，要幫他按 reset：寫進記憶體、重畫。房間場景不收，
 * 否則畫面三格空的、開戰卻用伺服器那副舊的。
 */
describe("空牌組只有 Edit 收（等於幫玩家按 reset）", () => {
  /** 一個「有在畫牌組」的假場景：deck1 有東西、遊戲自己的重畫函式都在。 */
  function sceneOf(active: boolean) {
    const calls: string[] = [];
    return {
      calls,
      scene: {
        scene: { isActive: () => active },
        deck_now: 2,
        deck1: payload(684),
        edit_reflesh: () => calls.push("edit_reflesh"),
        deck_card: () => calls.push("deck_card"),
      },
    };
  }

  function run(keys: Record<string, unknown>, deck: DeckPayload): string {
    const sandbox = { window: { game: { scene: { keys } } } };
    vm.createContext(sandbox);
    return vm.runInContext(buildEditDeckWriteExpression(deck), sandbox) as string;
  }

  it("Edit 開著：空的照寫、照重畫，回 ok —— 跟 reset 鈕一樣", () => {
    const edit = sceneOf(true);
    expect(run({ Edit: edit.scene }, payload(null))).toBe("ok");
    expect(edit.scene.deck1.charaIndex).toEqual([null, null, null]);
    expect(edit.scene.deck_now).toBe(1);
    expect(edit.calls).toEqual(["edit_reflesh"]);
  });

  it("⚠ 房間場景：空的不寫、不重畫，回 empty-room", () => {
    const quest = sceneOf(true);
    expect(run({ Edit: sceneOf(false).scene, Quest: quest.scene }, payload(null))).toBe(
      "empty-room",
    );
    // 記憶體要原封不動 —— 寫進去的話畫面會變成三格空的
    expect(quest.scene.deck1.charaIndex).toEqual([684, null, null]);
    expect(quest.scene.deck_now).toBe(2);
    expect(quest.calls).toEqual([]);
  });

  it("房間場景：有牌的照原本走，回 ok-room", () => {
    const quest = sceneOf(true);
    expect(run({ Quest: quest.scene }, payload(90))).toBe("ok-room");
    expect(quest.scene.deck1.charaIndex).toEqual([90, null, null]);
    expect(quest.calls).toEqual(["deck_card"]);
  });

  it("哪個畫面都沒開：回 not-active", () => {
    expect(run({ Edit: sceneOf(false).scene }, payload(null))).toBe("not-active");
  });
});

/**
 * 房間場景換牌後要把 COST 算對（2026-09-12 亞城回報）。
 *
 * 大廳的 `cost:NN` 讀的是 `deck1.cost`，遊戲不重算；payload 帶的 cost 一律 0，
 * 所以換完會叫 `__ulrDeckEdit.costFor()` 把官方 COST 補進去。
 */
describe("房間換牌後補上正確的官方 COST", () => {
  /** 一個房間場景 + 記錄 change_deck 時看到的 cost。 */
  function roomScene() {
    const seen: Array<number | undefined> = [];
    return {
      seen,
      scene: {
        scene: { isActive: () => true },
        deck_now: 2,
        deck1: payload(90),
        deck_name: {
          text: "",
          setText(t: string) {
            this.text = t;
            return this;
          },
        },
        change_deck(this: { deck1: { cost?: number } }) {
          seen.push(this.deck1.cost);
        },
      },
    };
  }

  function runWith(
    scene: unknown,
    deck: DeckPayload,
    api: unknown,
  ): { result: string; deck1: { cost?: number } } {
    const sandbox = {
      window: { game: { scene: { keys: { Match: scene } } }, __ulrDeckEdit: api },
    };
    vm.createContext(sandbox);
    const result = vm.runInContext(buildEditDeckWriteExpression(deck), sandbox) as string;
    return { result, deck1: (scene as { deck1: { cost?: number } }).deck1 };
  }

  it("有 costFor：把它算出來的官方 COST 填進 deck1.cost，再重畫", () => {
    const room = roomScene();
    const api = { costFor: (_c: unknown, custom: boolean) => (custom ? 79 : 53) };
    const { result, deck1 } = runWith(room.scene, payload(90), api);
    expect(result).toBe("ok-room");
    // ⚠ 要官方那個數（custom=false），不是自訂 79
    expect(deck1.cost).toBe(53);
    // 重畫是在補完 cost 之後跑的 —— change_deck 看到的就是 53，不是 payload 的 0
    expect(room.seen).toEqual([53]);
  });

  it("問的是官方價（custom=false）—— 大廳配對與伺服器用的就是官方", () => {
    const room = roomScene();
    const asked: boolean[] = [];
    const api = {
      costFor: (_c: unknown, custom: boolean) => {
        asked.push(custom);
        return 53;
      },
    };
    runWith(room.scene, payload(90), api);
    expect(asked).toEqual([false]);
  });

  it("沒有 __ulrDeckEdit（還沒掛上）：不炸，維持 payload 帶的值", () => {
    const room = roomScene();
    const { result, deck1 } = runWith(room.scene, payload(90), undefined);
    expect(result).toBe("ok-room");
    expect(deck1.cost).toBe(0); // payload() 帶的 0
  });

  it("costFor 回非數字（算不出來）：維持原值，不寫壞", () => {
    const room = roomScene();
    const api = { costFor: () => null };
    const { deck1 } = runWith(room.scene, payload(90), api);
    expect(deck1.cost).toBe(0);
  });

  /**
   * 2026-09-12 迪城「COST 變來變去」：三個會換 deck1 的地方各算各的。現在只有
   * 一種算法 —— 跟牌盒同一張表（迪城自訂、其餘官方），見 room-cost.ts。
   */
  it("⚠ 迪城（duel 頻道）問的是自訂價 —— 牌盒寫 92、畫面就要是 92", () => {
    const room = roomScene();
    const asked: boolean[] = [];
    const scene = Object.assign(room.scene, {
      channel: 2,
      channels: { 1: { type: "ranked" }, 2: { type: "duel" } },
    });
    const sandbox = {
      window: {
        game: { scene: { keys: { Match: scene } } },
        __ulrDeckEdit: {
          costFor: (_c: unknown, custom: boolean) => {
            asked.push(custom);
            return custom ? 92 : 91;
          },
        },
      },
    };
    vm.createContext(sandbox);
    const result = vm.runInContext(buildEditDeckWriteExpression(payload(90)), sandbox) as string;
    expect(result).toBe("ok-room");
    expect(asked).toEqual([true]);
    expect(room.seen).toEqual([92]);
  });

  it("亞城（ranked 頻道）問的是官方價，就算罰則補丁在也不拿它的自訂價", () => {
    const room = roomScene();
    const scene = Object.assign(room.scene, {
      channel: 1,
      channels: { 1: { type: "ranked" }, 2: { type: "duel" } },
    });
    const sandbox = {
      window: {
        game: { scene: { keys: { Match: scene } } },
        __ulrDeckEdit: { costFor: (_c: unknown, custom: boolean) => (custom ? 80 : 79) },
        __ulrPenaltyPatch: { installed: true, costOf: () => 80 },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(buildEditDeckWriteExpression(payload(90)), sandbox);
    expect(room.seen).toEqual([79]);
  });

  it("迪城、牌盒還沒掛上：退回罰則補丁的 costOf（它裝著時算的就是自訂價）", () => {
    const room = roomScene();
    const scene = Object.assign(room.scene, {
      channel: 2,
      channels: { 2: { type: "duel" } },
    });
    const sandbox = {
      window: {
        game: { scene: { keys: { Match: scene } } },
        __ulrPenaltyPatch: { installed: true, costOf: () => 92 },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(buildEditDeckWriteExpression(payload(90)), sandbox);
    expect(room.scene.deck1.cost).toBe(92);
  });

  it("慢路徑同步記憶體時也不能照抄 payload 的 cost —— 那是快照裡上一副的數字", () => {
    const src = buildDeckApplyExpression([payload(90), payload(null), payload(null)], true);
    expect(src).toContain("ulrRoomCostOf(cur, ulrRoomOfScene(k, sc))");
    expect(src).not.toMatch(/cur\.cost = src\.cost;/);
  });
});
