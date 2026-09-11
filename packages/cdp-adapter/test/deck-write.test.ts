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
