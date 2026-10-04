import { describe, expect, it } from "vitest";
import type { DeckContent, DeckLibrary, RaidBoss } from "@ulr/deck-library";
import {
  addDeck,
  emptyDeckContent,
  emptyLibrary,
  listDecks,
  ROOM_KINDS,
  setSelected,
} from "@ulr/deck-library";
import type { DeckSession } from "../src/deck-core.js";
import {
  applyLanded,
  applyReport,
  autoSave,
  deckEditStateOf,
  DEFAULT_APPLY_DELAY_MS,
  DEFAULT_ROOM,
  enterRoom,
  expireNotice,
  followDeckOnEdit,
  highlightOf,
  isApplyDue,
  migrateServerDecks,
  newSession,
  NOTICE_TTL_MS,
  queueApply,
  raidBossOfMons,
  resolveActive,
  resolveAll,
  roomDeckPreloadOf,
  seedAllRooms,
  withNotice,
} from "../src/deck-core.js";

/** 一副長得出來的牌 —— 第一格有人，所以 `guardDeck1` 放行。 */
function deckOf(first: number, event = 3): DeckContent {
  const c = emptyDeckContent();
  c.charaId[0] = first;
  c.eventId[0] = event;
  return c;
}

function libraryOf(...decks: DeckContent[]): DeckLibrary {
  let lib = emptyLibrary("3f2a1c04");
  for (const content of decks) lib = addDeck(lib, DEFAULT_ROOM, { content }).library;
  return lib;
}

function sessionOf(...decks: DeckContent[]): DeckSession {
  return newSession(libraryOf(...decks));
}

function idsOf(session: DeckSession): string[] {
  return listDecks(session.library, session.room).map((d) => d.id);
}

describe("套用中的那一副是算出來的", () => {
  it("Deck1 的內容對得上哪一副，那一副就是套用中的", () => {
    const a = deckOf(684);
    const b = deckOf(674);
    const session = sessionOf(a, b);
    const [idA, idB] = idsOf(session);
    expect(resolveActive(session.library, DEFAULT_ROOM, a)).toBe(idA);
    expect(resolveActive(session.library, DEFAULT_ROOM, b)).toBe(idB);
  });

  it("對不上任何一副就是 null —— 不要硬挑一個", () => {
    // 玩家可能根本沒透過插件換過牌組。硬挑一副的症狀是選單用黃字指著一副
    // 其實不在伺服器上的牌，而玩家會以為自己已經換過去了。
    const session = sessionOf(deckOf(684));
    expect(resolveActive(session.library, DEFAULT_ROOM, deckOf(999))).toBeNull();
  });

  it("四房一起算，沒有那一房就是 null", () => {
    const a = deckOf(684);
    const active = resolveAll(libraryOf(a), a);
    expect(active[DEFAULT_ROOM]).not.toBeNull();
    expect(active.raid).toBeNull();
    expect(active.quest).toBeNull();
  });
});

describe("自動存檔", () => {
  it("玩家在遊戲裡改了牌 → 存回套用中的那一副", () => {
    const before = deckOf(684);
    let session = sessionOf(before);
    const [id] = idsOf(session);
    session = { ...session, active: { ...session.active, [DEFAULT_ROOM]: id ?? null } };

    const after = deckOf(684, 9); // 換了一張事件卡
    const saved = autoSave(session, after, before);
    expect(saved.saved).toBe(true);
    expect(resolveActive(saved.session.library, DEFAULT_ROOM, after)).toBe(id);
  });

  it("沒有套用中的那一副時什麼都不做 —— 硬存會蓋掉別人", () => {
    const session = sessionOf(deckOf(684));
    expect(autoSave(session, deckOf(999), deckOf(684)).saved).toBe(false);
  });

  it("內容一樣就不動 updatedAt —— 不然同步會判成「本地永遠比較新」", () => {
    const content = deckOf(684);
    let session = sessionOf(content);
    const [id] = idsOf(session);
    session = { ...session, active: { ...session.active, [DEFAULT_ROOM]: id ?? null } };
    const before = listDecks(session.library, DEFAULT_ROOM)[0]?.updatedAt;

    const saved = autoSave(session, content, content, new Date(Date.now() + 60_000));
    expect(saved.saved).toBe(false);
    expect(listDecks(saved.session.library, DEFAULT_ROOM)[0]?.updatedAt).toBe(before);
  });

  /**
   * 2026-08-27 實機上弄丟兩副牌的那一條路。**這個測試就是那次事故本身。**
   */
  it("⚠ 寫入沒生效時絕對不能存 —— Deck1 沒變就沒有玩家的編輯可以存", () => {
    const mine = deckOf(684); // Deck1 現在真正的內容
    const other = deckOf(115); // 玩家想換過去的另一副
    let lib = libraryOf(mine, other);
    const [, otherId] = listDecks(lib, DEFAULT_ROOM).map((d) => d.id);
    // 玩家選了 other → active 指向它，但寫入其實沒生效，Deck1 還是 mine
    const session = {
      ...newSession(lib),
      active: { ...newSession(lib).active, [DEFAULT_ROOM]: otherId ?? null },
    };

    // lastSeen 跟 current 一樣（Deck1 從頭到尾沒動過）→ 什麼都不做
    const saved = autoSave(session, mine, mine);
    expect(saved.saved).toBe(false);
    // other 那一副的內容必須原封不動
    lib = saved.session.library;
    expect(listDecks(lib, DEFAULT_ROOM)[1]?.content).toEqual(other);
  });

  it("沒有比較基準（還沒觀察過）就不存", () => {
    const mine = deckOf(684);
    let session = sessionOf(mine);
    const [id] = idsOf(session);
    session = { ...session, active: { ...session.active, [DEFAULT_ROOM]: id ?? null } };
    expect(autoSave(session, deckOf(999), null).saved).toBe(false);
  });
});

describe("畫面狀態", () => {
  it("沒取名字的退回 Deck{n}，順序就是庫裡的順序", () => {
    const session = sessionOf(deckOf(1), deckOf(2));
    expect(deckEditStateOf(session).decks.map((d) => d.name)).toEqual(["Deck1", "Deck2"]);
  });

  it("標籤送的是鍵不是顯示字 —— 勾選面板要拿它比對 bossOptions", () => {
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "raid", { content: deckOf(1), bosses: ["fish"] }).library;
    const state = deckEditStateOf({ ...newSession(lib), room: "raid" });
    expect(state.decks[0]?.bosses).toEqual(["fish"]);
    expect(state.bossOptions).toContainEqual({ key: "fish", label: "魚" });
  });

  it("非渦房不畫標籤", () => {
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, DEFAULT_ROOM, { content: deckOf(1), bosses: ["fish"] }).library;
    expect(deckEditStateOf(newSession(lib)).decks[0]?.bosses).toEqual([]);
  });

  it("四種房型都送過去，頁面不自己寫死；順序是任務→渦→亞城→迪城", () => {
    // 2026-09-12 玩家定的順序：先 PVE 再 PVP，最常用的迪城在最下面。
    expect(deckEditStateOf(sessionOf()).rooms.map((r) => r.key)).toEqual([
      "quest",
      "raid",
      "alexandria",
      "dietherm",
    ]);
  });

  it("每一房該畫哪一種 COST：PVE 不畫、亞城官方、迪城自訂", () => {
    const lib = libraryOf(deckOf(1));
    const modeOf = (room: (typeof ROOM_KINDS)[number]) =>
      deckEditStateOf({ ...newSession(lib), room }).costDisplay;
    expect(modeOf("quest")).toBe("none");
    expect(modeOf("raid")).toBe("none");
    expect(modeOf("alexandria")).toBe("official");
    expect(modeOf("dietherm")).toBe("custom");
  });
});

describe("玩家點了東西", () => {
  it("選一副 → 排進隊伍、黃字跟著走，但 active 不動", () => {
    // ⚠⚠ **`active` 不動是這一版最重要的一條**（2026-09-09）。它的意思是
    // 「Deck1 現在真的是哪一副」，而點下去的那一刻伺服器上還是舊的那副。
    // 讓它跟著跳的話，自動存檔會把 Deck1 的內容存進玩家還沒換過去的那一副
    // —— 那正是 2026-08-27 弄丟兩副牌的那條路。
    const a = deckOf(684);
    const b = deckOf(674);
    const session = sessionOf(a, b);
    const [idA, idB] = idsOf(session);

    const out = applyReport(session, { type: "deck-select", id: idB ?? "" }, a);
    expect(out.write).toEqual(b);
    expect(out.session.pending?.id).toBe(idB);
    expect(out.session.active[DEFAULT_ROOM]).toBe(session.active[DEFAULT_ROOM]);
    expect(out.session.active[DEFAULT_ROOM]).not.toBe(idB);
    // 黃字要立刻在玩家點的那一副上，否則他看到的是「點了沒反應」。
    expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(idB);
    // 「這一房我要用哪一副」也記下來了 —— 下次進這一房就是套它。
    expect(out.session.library.selected[DEFAULT_ROOM]).toBe(idB);
    expect(idA).not.toBe(idB);
  });

  it("寫進伺服器之後才輪到 active 跟上", () => {
    const a = deckOf(684);
    const b = deckOf(674);
    const session = sessionOf(a, b);
    const [, idB] = idsOf(session);

    const queued = applyReport(session, { type: "deck-select", id: idB ?? "" }, a).session;
    const landed = applyLanded(queued, queued.pending!);
    expect(landed.active[DEFAULT_ROOM]).toBe(idB);
    expect(landed.pending).toBeNull();
  });

  it("選一副跟手上一模一樣的 → 不寫入，而且**不要留紅字**", () => {
    // ⚠ 底下那一行是紅字，玩家會把它讀成錯誤 —— 而這根本不是錯誤
    // （2026-09-09 回報）。2026-08-27 當初加訊息是因為「選了完全沒反應」看起來
    // 像壞掉，但那個理由已經不成立：黃字現在跟的是意圖（highlightOf），玩家
    // 一點下去它就跳過去了，回饋在那裡。
    const same = deckOf(684);
    const session = sessionOf(same);
    const [id] = idsOf(session);
    const out = applyReport(session, { type: "deck-select", id: id ?? "" }, same);
    expect(out.write).toBeNull();
    expect(out.session.notice).toBeNull();
    expect(out.session.active[DEFAULT_ROOM]).toBe(id);
    // 回饋改由黃字提供
    expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(id);
  });

  it("選一副已經不在的 → 不寫入，只給訊息", () => {
    const session = sessionOf(deckOf(684));
    const out = applyReport(session, { type: "deck-select", id: "沒有這副" }, deckOf(684));
    expect(out.write).toBeNull();
    expect(out.session.notice).not.toBeNull();
  });

  it("新增是複製現在這副，不是空牌組 —— 空的在房間選不動、在 Edit 等於 reset", () => {
    const current = deckOf(684);
    const out = applyReport(sessionOf(), { type: "deck-add" }, current);
    const decks = listDecks(out.session.library, DEFAULT_ROOM);
    expect(decks).toHaveLength(1);
    expect(decks[0]?.content).toEqual(current);
    // 內容跟 Deck1 一樣，所以它當場就是「套用中」，不必再寫一次伺服器
    expect(out.write).toBeNull();
    expect(out.session.active[DEFAULT_ROOM]).toBe(decks[0]?.id);
  });

  it("刪除留下墓碑，而且**不動 Deck1**", () => {
    const a = deckOf(684);
    let session = sessionOf(a);
    const [id] = idsOf(session);
    session = { ...session, active: { ...session.active, [DEFAULT_ROOM]: id ?? null } };

    const out = applyReport(session, { type: "deck-remove", id: id ?? "" }, a);
    expect(listDecks(out.session.library, DEFAULT_ROOM)).toHaveLength(0);
    expect(out.session.library.tombstones[DEFAULT_ROOM]).toHaveLength(1);
    expect(out.write).toBeNull();
    expect(out.session.active[DEFAULT_ROOM]).toBeNull();
  });

  it("改名會 trim —— 打了一串空白不該變成一個叫空白的牌組", () => {
    const session = sessionOf(deckOf(1));
    const [id] = idsOf(session);
    const out = applyReport(
      session,
      { type: "deck-rename", id: id ?? "", name: "  壓 C  " },
      deckOf(1),
    );
    expect(listDecks(out.session.library, DEFAULT_ROOM)[0]?.name).toBe("壓 C");
  });

  it("拖曳排序照 id 認人，不認位置", () => {
    const session = sessionOf(deckOf(1), deckOf(2), deckOf(3));
    const ids = idsOf(session);
    const out = applyReport(
      session,
      { type: "deck-move", id: ids[2] ?? "", toIndex: 0 },
      deckOf(1),
    );
    expect(idsOf(out.session)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("認不得的 BOSS 鍵直接丟掉 —— 頁面送來的一律當不可信輸入", () => {
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "raid", { content: deckOf(1) }).library;
    const session = { ...newSession(lib), room: "raid" as const };
    const [id] = idsOf(session);

    const out = applyReport(
      session,
      { type: "deck-bosses", id: id ?? "", bosses: ["fish", "__proto__", "龍"] },
      deckOf(1),
    );
    expect(listDecks(out.session.library, "raid")[0]?.bosses).toEqual(["fish"]);
  });

  it("換房會重算那一房的套用中 —— 手上這副對不對得上是內容說了算", () => {
    const shared = deckOf(684);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "raid", { content: shared }).library;
    const session = newSession(lib); // 現在在 dietherm

    const out = applyReport(session, { type: "room-switch", room: "raid" }, shared);
    expect(out.session.room).toBe("raid");
    expect(out.session.active.raid).toBe(listDecks(lib, "raid")[0]?.id);
  });

  it("換到認不得的房型就不動", () => {
    const session = sessionOf(deckOf(1));
    const out = applyReport(session, { type: "room-switch", room: "月球" }, deckOf(1));
    expect(out.session.room).toBe(DEFAULT_ROOM);
  });

  it("⚠⚠ 換房**牌組要跟著換**（2026-09-12）", () => {
    // 原本只換「選單看哪一房」，手上的牌不動 —— 於是切到渦房之後選單列的是
    // 渦的牌，畫面上擺的還是迪城那副，而玩家會以為自己已經換過去了。
    const here = deckOf(1);
    const there = deckOf(2);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, DEFAULT_ROOM, { content: here }).library;
    lib = addDeck(lib, "raid", { content: there }).library;
    const session = newSession(lib);

    const out = applyReport(session, { type: "room-switch", room: "raid" }, here);
    expect(out.session.room).toBe("raid");
    // 排進隊伍（不是直接寫伺服器），而且 write 交出去給前端即時換牌
    expect(out.session.pending?.id).toBe(listDecks(lib, "raid")[0]?.id);
    expect(out.session.pending?.room).toBe("raid");
    expect(out.write).toEqual(there);
  });

  it("挑的那一副跟進房時一樣 —— 兩邊不一樣的話進房會再閃一次牌", () => {
    const a = deckOf(1);
    const b = deckOf(2);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, DEFAULT_ROOM, { content: deckOf(9) }).library;
    lib = addDeck(lib, "raid", { content: a }).library;
    lib = addDeck(lib, "raid", { content: b }).library;
    const second = listDecks(lib, "raid")[1]?.id ?? "";
    lib = setSelected(lib, "raid", second);
    const session = newSession(lib);

    const switched = applyReport(session, { type: "room-switch", room: "raid" }, deckOf(9));
    const entered = enterRoom(session, "raid", deckOf(9));
    expect(switched.session.pending?.id).toBe(second);
    expect(entered.pending?.id).toBe(second);
  });

  it("那一房還沒有牌組時什麼都不換", () => {
    const here = deckOf(1);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, DEFAULT_ROOM, { content: here }).library;
    const session = newSession(lib);
    const out = applyReport(session, { type: "room-switch", room: "quest" }, here);
    expect(out.session.room).toBe("quest");
    expect(out.session.pending).toBeNull();
    expect(out.write).toBeNull();
  });
});

describe("◀▶ 切的是自訂牌組", () => {
  function threeDecks(): { session: DeckSession; ids: string[]; first: DeckContent } {
    const a = deckOf(1);
    const session = sessionOf(a, deckOf(2), deckOf(3));
    const ids = idsOf(session);
    return {
      session: { ...session, active: { ...session.active, [DEFAULT_ROOM]: ids[0] ?? null } },
      ids,
      first: a,
    };
  }

  // ⚠ 底下這幾個看的是 `highlightOf()`（玩家眼睛看到的黃字）而不是 `active`
  // —— ◀▶ 跟點選同一條規矩：排隊，不直接寫伺服器。見上面那條 ⚠⚠。

  it("▶ 走到下一副並要求寫入它", () => {
    const { session, ids, first } = threeDecks();
    const out = applyReport(session, { type: "deck-cycle", delta: 1 }, first);
    expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(ids[1]);
    expect(out.session.pending?.id).toBe(ids[1]);
    expect(out.write).toEqual(deckOf(2));
  });

  it("◀ 從第一副繞到最後一副", () => {
    const { session, ids, first } = threeDecks();
    const out = applyReport(session, { type: "deck-cycle", delta: -1 }, first);
    expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(ids[2]);
  });

  it("▶ 從最後一副繞回第一副", () => {
    const { session, ids } = threeDecks();
    const at2 = { ...session, active: { ...session.active, [DEFAULT_ROOM]: ids[2] ?? null } };
    const out = applyReport(at2, { type: "deck-cycle", delta: 1 }, deckOf(3));
    expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(ids[0]);
  });

  it("連按時只有停住的那一副會被寫出去", () => {
    // 排隊的那一副一直被換掉，`since` 跟著重算 —— 中間路過的那幾副連排隊都
    // 不算數。少了這個重算，第一副排上之後三秒就會被寫出去，而那正好是玩家
    // 最不想要的那一副。
    const { session, ids, first } = threeDecks();
    const one = applyReport(session, { type: "deck-cycle", delta: 1 }, first);
    const two = applyReport(one.session, { type: "deck-cycle", delta: 1 }, first);
    expect(two.session.pending?.id).toBe(ids[2]);
    expect(two.session.pending?.since).toBeGreaterThanOrEqual(one.session.pending?.since ?? 0);
  });

  it("手上這副不在庫裡時停在第一副，不要兩個方向亂跳", () => {
    const { session } = threeDecks();
    const orphan = { ...session, active: { ...session.active, [DEFAULT_ROOM]: null } };
    const ids = idsOf(orphan);
    for (const delta of [1, -1]) {
      const out = applyReport(orphan, { type: "deck-cycle", delta }, deckOf(999));
      expect(highlightOf(out.session, DEFAULT_ROOM)).toBe(ids[0]);
    }
  });

  it("一副都沒有時只給訊息，不會炸", () => {
    const out = applyReport(sessionOf(), { type: "deck-cycle", delta: 1 }, deckOf(1));
    expect(out.write).toBeNull();
    expect(out.session.notice).not.toBeNull();
  });
});

describe("收編伺服器的 Deck2／Deck3", () => {
  it("落在固定的第 2、3 格，覆蓋原本在那裡的東西", () => {
    // 庫裡是三副垃圾（2026-08-27 那次事故留下的：全部一模一樣）
    const junk = deckOf(684);
    const session = sessionOf(junk, junk, junk);
    const ids = idsOf(session);

    const d2 = deckOf(115);
    const d3 = deckOf(35);
    const out = migrateServerDecks(session, d2, d3);
    const list = listDecks(out.library, DEFAULT_ROOM);

    expect(list).toHaveLength(3);
    expect(list[0]?.content).toEqual(junk); // 第 1 格不動
    expect(list[1]?.content).toEqual(d2);
    expect(list[2]?.content).toEqual(d3);
    // ⚠ 是覆蓋不是新增 —— id 要留著，否則同步會判成「刪了一副又新增一副」
    expect(list.map((d) => d.id)).toEqual(ids);
  });

  it("格子不夠就往後補（第一次用：補出來剛好是 Deck1/2/3 的順序）", () => {
    const d1 = deckOf(44);
    const out = migrateServerDecks(sessionOf(d1), deckOf(115), deckOf(35));
    expect(listDecks(out.library, DEFAULT_ROOM).map((d) => d.content)).toEqual([
      d1,
      deckOf(115),
      deckOf(35),
    ]);
  });

  it("伺服器那一格是空的就往前補，不留一副空牌佔位", () => {
    // ⚠ 「Deck3 要落在第 3 格」得先有第 2 格，而唯一的補法是塞一副空牌 ——
    // 而空牌在房間裡**選不動**（`guardDeck1` 擋著，寫空到伺服器會讓玩家卡死在
    // 編輯畫面）、在 Edit 裡選了等於按 reset。佔位的代價是玩家清單裡多一副
    // 沒有牌的東西，所以寧可往前補。
    const d1 = deckOf(44);
    const out = migrateServerDecks(sessionOf(d1), null, deckOf(35));
    const list = listDecks(out.library, DEFAULT_ROOM);
    expect(list).toHaveLength(2);
    expect(list[1]?.content).toEqual(deckOf(35));
  });

  it("內容已經一樣就不動 updatedAt —— 每次開機都搬一次會讓同步永遠在推", () => {
    const d1 = deckOf(44);
    const d2 = deckOf(115);
    const once = migrateServerDecks(sessionOf(d1), d2, null);
    const stamp = listDecks(once.library, DEFAULT_ROOM)[1]?.updatedAt;
    const twice = migrateServerDecks(once, d2, null, new Date(Date.now() + 60_000));
    expect(listDecks(twice.library, DEFAULT_ROOM)[1]?.updatedAt).toBe(stamp);
  });
});

describe("那一行訊息", () => {
  it("過了保留時間才清掉", () => {
    const session = withNotice(sessionOf(), "庫存不足", 1_000);
    expect(expireNotice(session, 1_000 + NOTICE_TTL_MS - 1).changed).toBe(false);
    const gone = expireNotice(session, 1_000 + NOTICE_TTL_MS);
    expect(gone.changed).toBe(true);
    expect(gone.session.notice).toBeNull();
  });

  it("本來就沒有訊息時不算變動 —— 不然每一拍都會重畫一次畫面", () => {
    expect(expireNotice(sessionOf(), Date.now()).changed).toBe(false);
  });
});

describe("第一次使用時四房都要有牌組（WP-19）", () => {
  // ⚠ 原本只收進迪特赫姆一房，結果其他三房一副都沒有 —— 而「進到那一房就自動
  // 套用那一套」在空的房間裡完全不會有動作，玩家看到的是「這功能對我沒作用」。

  it("seedAllRooms 四房各放一份", () => {
    const lib = seedAllRooms(emptyLibrary("3f2a1c04"), deckOf(684));
    for (const room of ROOM_KINDS) {
      expect(listDecks(lib, room)).toHaveLength(1);
      expect(listDecks(lib, room)[0]?.content).toEqual(deckOf(684));
    }
  });

  it("⚠ 是複本不是共用 —— 每一房的 id 都不一樣", () => {
    // 共用 id 的話，在任務房改牌會連迪城那一副一起改掉。
    const lib = seedAllRooms(emptyLibrary("3f2a1c04"), deckOf(684));
    const ids = ROOM_KINDS.map((r) => listDecks(lib, r)[0]?.id);
    expect(new Set(ids).size).toBe(ROOM_KINDS.length);
  });

  it("伺服器的 Deck2／Deck3 也是四房都收", () => {
    const d1 = deckOf(1);
    const session = { ...sessionOf(d1), room: "dietherm" as const };
    const out = migrateServerDecks(session, deckOf(2), deckOf(3));
    for (const room of ROOM_KINDS) {
      const list = listDecks(out.library, room);
      // 迪城本來就有 d1，所以是三副；其他房只有搬進來的那兩副。
      const wanted = room === "dietherm" ? 3 : 2;
      expect(list).toHaveLength(wanted);
    }
  });

  it("每一房都給得出「進去要用哪一副」給頁面預載", () => {
    const lib = seedAllRooms(emptyLibrary("3f2a1c04"), deckOf(684));
    const preload = roomDeckPreloadOf(newSession(lib));
    for (const room of ROOM_KINDS) {
      // 插件模式：只換第 1 格、deck_now 釘 1
      expect(preload[room]?.slots).toHaveLength(1);
      expect(preload[room]?.slots[0]?.deckId).toBe(1);
      expect(preload[room]?.slots[0]?.chara_card_id).toEqual(deckOf(684).charaId);
      expect(preload[room]?.pin).toBe(1);
      expect(typeof preload[room]?.names["1"]).toBe("string");
    }
  });

  it("⚠ 預載挑的那一副要跟 enterRoom 挑的同一副 —— 不然牌會閃兩次", () => {
    const lib = seedAllRooms(emptyLibrary("3f2a1c04"), deckOf(684));
    const session = newSession(lib);
    const preload = roomDeckPreloadOf(session);
    for (const room of ROOM_KINDS) {
      const out = enterRoom({ ...session, here: null }, room, deckOf(999), 1_000);
      expect(preload[room]?.slots[0]?.chara_card_id).toEqual(out.pending?.content.charaId);
    }
  });

  it("那一房一副都沒有就不給 —— 頁面收到沒有那一房就完全不插手", () => {
    expect(roomDeckPreloadOf(newSession(emptyLibrary("3f2a1c04")))).toEqual({});
  });

  it("第一次跑完之後，每一房 enterRoom 都排得出東西來", () => {
    // 這是這一組真正要保護的行為。
    const lib = seedAllRooms(emptyLibrary("3f2a1c04"), deckOf(684));
    const session = newSession(lib);
    for (const room of ROOM_KINDS) {
      const out = enterRoom({ ...session, here: null }, room, deckOf(999), 1_000);
      expect(out.pending).not.toBeNull();
      expect(out.pending?.room).toBe(room);
    }
  });
});

describe("等候套用（WP-19）", () => {
  it("排上之後要等夠久才算到期", () => {
    const a = deckOf(1);
    const session = sessionOf(a, deckOf(2));
    const [, idB] = idsOf(session);
    const queued = queueApply(session, DEFAULT_ROOM, idB ?? "", deckOf(2), a, 1_000);

    expect(isApplyDue(queued, DEFAULT_APPLY_DELAY_MS, 1_000)).toBe(false);
    expect(isApplyDue(queued, DEFAULT_APPLY_DELAY_MS, 1_000 + DEFAULT_APPLY_DELAY_MS - 1)).toBe(
      false,
    );
    expect(isApplyDue(queued, DEFAULT_APPLY_DELAY_MS, 1_000 + DEFAULT_APPLY_DELAY_MS)).toBe(true);
  });

  it("等候秒數 0 = 排上就到期", () => {
    // 玩家把秒數設成 0 就是要「切了馬上寫」，不能因為 `>=` 寫成 `>` 而永遠差
    // 一毫秒。
    const a = deckOf(1);
    const session = sessionOf(a, deckOf(2));
    const [, idB] = idsOf(session);
    const queued = queueApply(session, DEFAULT_ROOM, idB ?? "", deckOf(2), a, 1_000);
    expect(isApplyDue(queued, 0, 1_000)).toBe(true);
  });

  it("沒有排隊就永遠不到期", () => {
    expect(isApplyDue(sessionOf(deckOf(1)), 0, Date.now())).toBe(false);
  });

  it("內容跟手上這副一樣就不排隊 —— 沒有東西要寫", () => {
    const a = deckOf(1);
    const session = sessionOf(a);
    const [idA] = idsOf(session);
    const queued = queueApply(session, DEFAULT_ROOM, idA ?? "", a, a, 1_000);
    expect(queued.pending).toBeNull();
  });
});

describe("進了哪一房就套哪一套（WP-19）", () => {
  /** 迪城一副、任務一副的庫。 */
  function twoRooms(): { session: DeckSession; dietherm: DeckContent; quest: DeckContent } {
    const dietherm = deckOf(1);
    const quest = deckOf(2);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "dietherm", { content: dietherm }).library;
    lib = addDeck(lib, "quest", { content: quest }).library;
    return { session: newSession(lib), dietherm, quest };
  }

  it("進任務房 → 選單切到任務、任務那一副排進隊伍", () => {
    const { session, dietherm, quest } = twoRooms();
    const out = enterRoom(session, "quest", dietherm, 1_000);
    expect(out.here).toBe("quest");
    expect(out.room).toBe("quest");
    expect(out.pending?.content).toEqual(quest);
    expect(out.pending?.room).toBe("quest");
  });

  it("同一房重複回報不重排 —— 不然那三秒永遠等不到", () => {
    // 頁面每 500ms 回報一次。重排的話 `since` 會一直被推後。
    const { session, dietherm } = twoRooms();
    const first = enterRoom(session, "quest", dietherm, 1_000);
    const again = enterRoom(first, "quest", dietherm, 5_000);
    expect(again.pending?.since).toBe(1_000);
    expect(isApplyDue(again, DEFAULT_APPLY_DELAY_MS, 5_000)).toBe(true);
  });

  it("那一房本來就是手上這副 → 不排隊", () => {
    const { session, quest } = twoRooms();
    const out = enterRoom(session, "quest", quest, 1_000);
    expect(out.pending).toBeNull();
  });

  // ── 頁面先把牌換好了（preloaded）──────────────────────────────────────
  //
  // 頁面會在房間場景的 create() 跑之前就把 deck1 換掉（`RoomDeckPreload`），
  // 這樣玩家一幀都不會看到上一房的牌。代價是**托盤看到的 current 已經是新的**。

  it("⚠⚠ 頁面先換好了也要排隊 —— 客戶端記憶體一樣了，伺服器還是舊的", () => {
    // 這是最容易漏掉的一條：不排隊的話畫面完全正常，但開戰時 deck_now=1 指的是
    // 伺服器那一格，玩家會拿上一房的牌上場。
    const { session, quest } = twoRooms();
    const out = enterRoom(session, "quest", quest, 1_000, { preloaded: true });
    expect(out.pending).not.toBeNull();
    expect(out.pending?.content).toEqual(quest);
    expect(out.pending?.room).toBe("quest");
  });

  it("頁面先換好了 → fronted 是 true，托盤不必再寫一次前端", () => {
    const { session, quest } = twoRooms();
    const out = enterRoom(session, "quest", quest, 1_000, { preloaded: true });
    expect(out.pending?.fronted).toBe(true);
  });

  it("沒有 preloaded 時照舊：內容一樣就不排", () => {
    const { session, quest } = twoRooms();
    expect(enterRoom(session, "quest", quest, 1_000, { preloaded: false }).pending).toBeNull();
  });

  it("preloaded 也救不了「那一房一副都沒有」—— 沒得排就是沒得排", () => {
    const { session, dietherm } = twoRooms();
    const out = enterRoom(session, "raid", dietherm, 1_000, { preloaded: true });
    expect(out.pending).toBeNull();
  });

  it("那一房一副都沒有 → 不排隊，也不會炸", () => {
    const { session, dietherm } = twoRooms();
    const out = enterRoom(session, "raid", dietherm, 1_000);
    expect(out.here).toBe("raid");
    expect(out.pending).toBeNull();
  });

  it("離開所有房間（回大廳）→ 記成不在任何一房，隊伍不動", () => {
    // ⚠ 隊伍不能清掉：玩家可能是從任務房走去大廳再走回來，而排著的那一副
    // 就是他要的。清掉的話他會發現「換過去的牌組自己跑掉了」。
    const { session, dietherm } = twoRooms();
    const inQuest = enterRoom(session, "quest", dietherm, 1_000);
    const out = enterRoom(inQuest, null, dietherm, 2_000);
    expect(out.here).toBeNull();
    expect(out.pending?.id).toBe(inQuest.pending?.id);
  });

  it("記住的是上次在那一房選的那副，不是清單第一副", () => {
    const dietherm = deckOf(1);
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "quest", { content: deckOf(10) }).library;
    lib = addDeck(lib, "quest", { content: deckOf(11) }).library;
    lib = addDeck(lib, "dietherm", { content: dietherm }).library;
    const session = newSession(lib);
    const second = listDecks(lib, "quest")[1];

    // 玩家在任務房選了第二副（選單此時看的就是任務房）
    const picked = applyReport(
      { ...session, room: "quest" },
      { type: "deck-select", id: second?.id ?? "" },
      deckOf(10),
    ).session;

    // 走掉再回來
    const away = enterRoom({ ...picked, here: "quest" }, "dietherm", dietherm, 2_000);
    const back = enterRoom(away, "quest", dietherm, 3_000);
    expect(back.pending?.id).toBe(second?.id);
  });
});

describe("進了牌組編輯，選單跟著手上這副是哪一房的（2026-09-12）", () => {
  /** 迪城兩副（1、2）、亞城兩副（3、4）。 */
  function twoRoomsTwoDecks(): { session: DeckSession; d: DeckContent[]; a: DeckContent[] } {
    const d = [deckOf(1), deckOf(2)];
    const a = [deckOf(3), deckOf(4)];
    let lib = emptyLibrary("3f2a1c04");
    for (const c of d) lib = addDeck(lib, "dietherm", { content: c }).library;
    for (const c of a) lib = addDeck(lib, "alexandria", { content: c }).library;
    return { session: newSession(lib), d, a };
  }
  const idAt = (s: DeckSession, room: "dietherm" | "alexandria", i: number): string =>
    listDecks(s.library, room)[i]?.id ?? "";

  it("手上是亞城那副、選單停在迪城 → 換到亞城，黃字指著那一副", () => {
    // 回報的情境：托盤重開過，選單停在預設的迪特赫姆，黃字指著迪城 Deck2，
    // 但畫面上的牌其實是亞城的。
    const { session, a } = twoRoomsTwoDecks();
    const stale = {
      ...session,
      library: setSelected(session.library, "dietherm", idAt(session, "dietherm", 1)),
    };
    const out = followDeckOnEdit(stale, a[1]!);
    expect(out.room).toBe("alexandria");
    expect(highlightOf(out, "alexandria")).toBe(idAt(out, "alexandria", 1));
    expect(out.active.alexandria).toBe(idAt(out, "alexandria", 1));
    expect(out.library.selected?.alexandria).toBe(idAt(out, "alexandria", 1));
  });

  it("選單這一房就有這副 → 房不動，黃字對到它（selected 也跟著改）", () => {
    const { session, d } = twoRoomsTwoDecks();
    const stale = {
      ...session,
      library: setSelected(session.library, "dietherm", idAt(session, "dietherm", 0)),
    };
    const out = followDeckOnEdit(stale, d[1]!);
    expect(out.room).toBe("dietherm");
    expect(highlightOf(out, "dietherm")).toBe(idAt(out, "dietherm", 1));
    expect(out.library.selected?.dietherm).toBe(idAt(out, "dietherm", 1));
  });

  it("四房都是同一副的複本 → 誰「記住」了它誰優先，不是照房間順序", () => {
    // seedAllRooms 之後四房內容一樣，光看內容分不出他從哪一房出來。
    const same = deckOf(7);
    let lib = emptyLibrary("3f2a1c04");
    lib = seedAllRooms(lib, same);
    lib = addDeck(lib, "quest", { content: deckOf(8) }).library;
    // 任務房記住的是第二副（8），渦房記住的是第一副（7 = 手上這副）
    lib = setSelected(lib, "quest", listDecks(lib, "quest")[1]?.id ?? "");
    lib = setSelected(lib, "raid", listDecks(lib, "raid")[0]?.id ?? "");
    const session = { ...newSession(lib), room: "quest" as const };
    const out = followDeckOnEdit(session, same);
    expect(out.room).toBe("raid");
  });

  it("對不上任何一副 → 什麼都不動", () => {
    const { session } = twoRoomsTwoDecks();
    const out = followDeckOnEdit(session, deckOf(99));
    expect(out).toBe(session);
  });

  it("有東西排著隊 → 不動，黃字跟隊伍", () => {
    const { session, a, d } = twoRoomsTwoDecks();
    const queued = queueApply(
      session,
      "dietherm",
      idAt(session, "dietherm", 0),
      d[0]!,
      a[0]!,
      1_000,
    );
    expect(followDeckOnEdit(queued, a[1]!)).toBe(queued);
  });

  it("已經對好了 → 回同一個物件，呼叫端不必重畫", () => {
    const { session, a } = twoRoomsTwoDecks();
    const first = followDeckOnEdit(session, a[0]!);
    expect(first.room).toBe("alexandria");
    expect(followDeckOnEdit(first, a[0]!)).toBe(first);
  });
});

describe("渦房選了渦，照 BOSS 標籤換牌組（2026-09-13）", () => {
  /** 渦房四副：龜海、龜甲、龜乙、魚蟲狗。選單停在迪城（預設）。 */
  function raidDecks(): { session: DeckSession; c: DeckContent[]; id: (i: number) => string } {
    const c = [deckOf(11), deckOf(12), deckOf(13), deckOf(14)];
    const tags: RaidBoss[][] = [["sea", "turtle"], ["turtle"], ["turtle"], ["fish", "bug", "dog"]];
    let lib = emptyLibrary("3f2a1c04");
    c.forEach((content, i) => {
      lib = addDeck(lib, "raid", { content, bosses: tags[i] ?? [] }).library;
    });
    const session = newSession(lib);
    return { session, c, id: (i) => listDecks(session.library, "raid")[i]?.id ?? "" };
  }

  it("BOSS 代碼對得到標籤：前綴相同的渦I／II·III／IV 都算", () => {
    expect(raidBossOfMons("mc1008_02")).toBe("turtle");
    expect(raidBossOfMons("mc1008_03")).toBe("turtle");
    expect(raidBossOfMons("mc1003_01")).toBe("dog");
    expect(raidBossOfMons("mc1004")).toBeNull();
    expect(raidBossOfMons("__proto__")).toBeNull();
  });

  it("選了龜 → 挑標籤最少、排最前面的那副，排隊並回傳要換上的內容", () => {
    const { session, c, id } = raidDecks();
    const out = applyReport(session, { type: "raid-pick", mons: "mc1008_02" }, c[3]!);
    expect(out.session.room).toBe("raid");
    expect(out.session.pending?.id).toBe(id(1));
    expect(out.session.library.selected?.raid).toBe(id(1));
    expect(out.write).toEqual(c[1]);
  });

  it("手上已經是那副 → 不排隊、不寫", () => {
    const { session, c, id } = raidDecks();
    const out = applyReport(session, { type: "raid-pick", mons: "mc1008_02" }, c[1]!);
    expect(out.write).toBeNull();
    expect(out.session.pending).toBeNull();
    expect(out.session.active.raid).toBe(id(1));
  });

  it("⚠ 沒有任何一副掛那個標籤、或認不得的 BOSS → 什麼都不變", () => {
    let lib = emptyLibrary("3f2a1c04");
    lib = addDeck(lib, "raid", { content: deckOf(21), bosses: ["sea"] }).library;
    const session = newSession(lib);
    for (const mons of ["mc1008_02", "mc1004", "mc1005"]) {
      const out = applyReport(session, { type: "raid-pick", mons }, deckOf(99));
      expect(out.session).toBe(session);
      expect(out.write).toBeNull();
    }
  });
});

/**
 * 2026-09-20 實機：**從渦房走到對戰房打小號，庫裡迪城的牌組1 變成渦那副。**
 *
 * 這一整個 describe 就是那次事故本身。三副拼圖：
 *
 * ```
 *   頁面   點下迪城頻道就把客戶端記憶體換成迪城那副（patch-room-gate）
 *   托盤   enterRoom 用那一份算出 active.dietherm = 迪城Deck1，並排隊
 *   伺服器 還躺著渦那副，要等三秒後 commitPending() 才被寫到
 * ```
 *
 * 這三秒內只要讀到伺服器，舊制就判成「玩家改了牌」→ 存進 active[room]。
 * 基準那一半的測試在 `deck-seen.test.ts`；這裡測的是 `autoSave` 自己那兩道閘。
 */
describe("⚠⚠ 換房那幾秒不能把上一房的牌存進這一房（2026-09-20）", () => {
  /** 渦房一副（選著的）、迪城一副（選著的）。 */
  function raidToDietherm(): {
    session: DeckSession;
    raidDeck: DeckContent;
    diethermDeck: DeckContent;
    diethermId: string;
  } {
    const raidDeck = deckOf(684);
    const diethermDeck = deckOf(115);
    let lib = emptyLibrary("3f2a1c04");
    const added = addDeck(lib, "dietherm", { content: diethermDeck });
    lib = setSelected(added.library, "dietherm", added.entry.id);
    lib = addDeck(lib, "raid", { content: raidDeck }).library;
    return { session: newSession(lib), raidDeck, diethermDeck, diethermId: added.entry.id };
  }

  it("排著隊的時候一律不存 —— 那時候兩邊不一致是我們自己造成的", () => {
    const { session, raidDeck, diethermDeck, diethermId } = raidToDietherm();
    // 點下迪城頻道：頁面已經把客戶端換成迪城那副（preloaded）。
    const entered = enterRoom(session, "dietherm", diethermDeck, 1_000, { preloaded: true });
    expect(entered.pending?.id).toBe(diethermId);
    expect(entered.active.dietherm).toBe(diethermId);

    // 這三秒內讀到伺服器 —— 上面還躺著渦那副。舊制會把它存進迪城的牌組1。
    const saved = autoSave(entered, raidDeck, diethermDeck);
    expect(saved.saved).toBe(false);
    expect(listDecks(saved.session.library, "dietherm")[0]?.content).toEqual(diethermDeck);
  });

  it("⚠ 提交失敗之後 active 照伺服器重算 → 指不到任何一副，存不進去", () => {
    const { session, raidDeck, diethermDeck } = raidToDietherm();
    const entered = enterRoom(session, "dietherm", diethermDeck, 1_000, { preloaded: true });

    // commitPending() 寫失敗：隊伍清掉，active 照伺服器現況（渦那副）重算。
    const failed: DeckSession = {
      ...entered,
      pending: null,
      active: {
        ...entered.active,
        dietherm: resolveActive(entered.library, "dietherm", raidDeck),
      },
    };
    expect(failed.active.dietherm).toBeNull();

    const saved = autoSave(failed, raidDeck, diethermDeck);
    expect(saved.saved).toBe(false);
    expect(listDecks(saved.session.library, "dietherm")[0]?.content).toEqual(diethermDeck);
  });

  it("玩家真的在編輯畫面改牌還是照存 —— 這兩道閘沒有擋到正事", () => {
    const { session, diethermDeck, diethermId } = raidToDietherm();
    // 人在 Edit：排著的那一副換到眼前就落地、pending 當場清掉（frontApplyPending）。
    const landed = applyLanded(
      { ...session, room: "dietherm" },
      {
        id: diethermId,
        content: diethermDeck,
        room: "dietherm",
        since: 1_000,
        fronted: true,
      },
    );
    expect(landed.pending).toBeNull();

    const edited = deckOf(115, 9); // 換了一張事件卡
    const saved = autoSave(landed, edited, diethermDeck);
    expect(saved.saved).toBe(true);
    expect(listDecks(saved.session.library, "dietherm")[0]?.content).toEqual(edited);
  });
});
