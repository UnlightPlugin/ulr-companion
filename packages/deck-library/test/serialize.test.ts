import { describe, expect, it } from "vitest";
import {
  deckContentFromServer,
  isAccountFingerprint,
  isLegacyDeckContent,
  libraryFileName,
  parseDeckContent,
  parseLibrary,
  serializeLibrary,
  withDeckContent,
} from "../src/serialize.js";
import { addDeck } from "../src/library.js";
import { emptyDeckContent, emptyLibrary } from "../src/types.js";

/** 2026-09-24 從實機讀到的 `registry.deck[2]`（改版後的形狀）。 */
const SERVER_DECK3 = {
  deck_id: 3,
  main: 0,
  chara_card_id: [427, 110, 330],
  weapon_card_id: [22, 56, 123],
  event_card_id: [34, 34, 28, 28, 28, 28, 71, 80, 31, 31, 28, 28, 28, 34, 34, 34, 28, 28],
  card_effect: [],
  cost: 111,
};

describe("伺服器的 deck ↔ DeckContent", () => {
  it("讀得出實機那副牌", () => {
    const c = deckContentFromServer(SERVER_DECK3);
    expect(c.charaId).toEqual([427, 110, 330]);
    expect(c.weaponId).toEqual([22, 56, 123]);
    expect(c.eventId).toHaveLength(18);
  });

  it("換內容時 deck_id／main／card_effect／cost 照原樣留著", () => {
    const next = withDeckContent(SERVER_DECK3, emptyDeckContent());
    expect(next.deck_id).toBe(3);
    expect(next.main).toBe(0);
    expect(next.cost).toBe(111);
    expect(next.chara_card_id).toEqual([null, null, null]);
    expect(next.event_card_id).toHaveLength(18);
    // 不動原本那份
    expect(SERVER_DECK3.chara_card_id).toEqual([427, 110, 330]);
  });

  it("欄位缺了也不會炸，缺的當空格", () => {
    const c = deckContentFromServer({ chara_card_id: [685] });
    expect(c.charaId).toEqual([685, null, null]);
    expect(c.eventId).toHaveLength(18);
    expect(deckContentFromServer(null).charaId).toEqual([null, null, null]);
  });
});

describe("改版前的舊存檔轉成新卡號", () => {
  /**
   * 玩家本機牌組庫裡任務房的第一副（2026-09-22 存的舊格式）。伺服器上的 Deck3
   * 就是從它來的 —— 角色與事件卡一張不差；武器那兩格玩家改版後換成了專武，
   * 舊的是冰劍／水擊槍（名字對過：舊 135 冰劍 = 新 165、舊 136 水擊槍 = 新 166）。
   */
  const LEGACY = {
    chara: ["cc043", "cc011", "cc033"],
    charaIndex: [426, 109, 329],
    weapon: [170, 136, 135],
    eventIndex: [80, 80, 67, 67, 67, 67, 20, 41, 70, 70, 67, 67, 67, 80, 80, 80, 67, 67],
  };

  it("認得出舊格式", () => {
    expect(isLegacyDeckContent(LEGACY)).toBe(true);
    expect(isLegacyDeckContent(deckContentFromServer(SERVER_DECK3))).toBe(false);
  });

  it("角色、事件卡轉出來跟伺服器那副一樣；武器照名字對到新 id", () => {
    const c = parseDeckContent(LEGACY);
    expect(c.charaId).toEqual(SERVER_DECK3.chara_card_id);
    expect(c.eventId).toEqual(SERVER_DECK3.event_card_id);
    expect(c.weaponId).toEqual([22, 166, 165]); // 萬聖節叉子、水擊槍、冰劍
  });

  it("怪物查怪物那張表 —— 同一個索引在角色表是另一張卡", () => {
    const c = parseDeckContent({ chara: ["mc001_01", "cc001", null], charaIndex: [0, 0, null] });
    expect(c.charaId).toEqual([1001, 1, null]);
  });

  it("舊資產的最後一組不照編號走（cc078、mc073）", () => {
    const c = parseDeckContent({
      chara: ["cc078", "mc073_01", null],
      charaIndex: [690, 135, null],
    });
    expect(c.charaId).toEqual([771, 20042, null]);
  });

  it("整份存檔讀進來會記下轉了幾副，存回去就是新格式", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {
        quest: [{ id: "d1", name: "", content: LEGACY, updatedAt: "2026-09-22T00:00:00.000Z" }],
      },
    });
    const { library, migrated } = parseLibrary(raw, "4858c81f");
    expect(migrated).toBe(1);
    const text = serializeLibrary(library);
    expect(text).not.toContain("charaIndex");
    const again = parseLibrary(text, "4858c81f");
    expect(again.migrated).toBe(0);
    expect(again.library).toEqual(library);
  });
});

describe("帳號指紋", () => {
  it("只認 8 個 hex", () => {
    expect(isAccountFingerprint("4858c81f")).toBe(true);
    expect(isAccountFingerprint("bf112c58")).toBe(true);
    expect(isAccountFingerprint("4858C81F")).toBe(false); // 大寫不算
    expect(isAccountFingerprint("4858c81")).toBe(false);
    expect(isAccountFingerprint("")).toBe(false);
    expect(isAccountFingerprint(undefined)).toBe(false);
  });

  it("檔名只帶指紋，不帶玩家名稱", () => {
    expect(libraryFileName("4858c81f")).toBe("decks-4858c81f.json");
  });
});

describe("存檔往返", () => {
  it("存了再讀回來是同一份", () => {
    let lib = emptyLibrary("4858c81f", "燈皇");
    const content = deckContentFromServer(SERVER_DECK3);
    lib = addDeck(lib, "dietherm", { name: "壓 C 用", content }).library;
    lib = addDeck(lib, "raid", { name: "渦用" }).library;

    const { library: back, dropped } = parseLibrary(serializeLibrary(lib), "0000dead");
    expect(dropped).toBe(0);
    expect(back).toEqual(lib);
  });

  it("同樣的內容序列化出同一串位元組（雲端同步要靠這個比對）", () => {
    const a = emptyLibrary("4858c81f");
    const b = emptyLibrary("4858c81f");
    expect(serializeLibrary(a)).toBe(serializeLibrary(b));
  });
});

describe("解析一律容錯，永遠不丟例外", () => {
  it("整份不是 JSON 就給一份空的", () => {
    const { library } = parseLibrary("這不是 JSON{{{", "4858c81f");
    expect(library.account).toBe("4858c81f");
    expect(library.collections.dietherm).toEqual([]);
  });

  it("壞掉的那一副丟掉，其他的照常載入", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {
        dietherm: [
          { id: "d1", name: "好的", content: {}, updatedAt: "2026-08-24T00:00:00.000Z" },
          { name: "沒有 id" },
          null,
          { id: "d2", name: "也是好的", content: {}, updatedAt: "2026-08-24T00:00:00.000Z" },
        ],
      },
    });
    const { library, dropped } = parseLibrary(raw, "0000dead");
    expect(dropped).toBe(2);
    expect(library.collections.dietherm.map((d) => d.name)).toEqual(["好的", "也是好的"]);
  });

  it("撞 id 的只留第一副", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {
        raid: [
          { id: "same", name: "先來的", content: {}, updatedAt: "x" },
          { id: "same", name: "後來的", content: {}, updatedAt: "x" },
        ],
      },
    });
    const { library, dropped } = parseLibrary(raw, "0000dead");
    expect(dropped).toBe(1);
    expect(library.collections.raid.map((d) => d.name)).toEqual(["先來的"]);
  });

  it("陣列長度不對會補齊，不會整副丟掉", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {
        quest: [
          {
            id: "d1",
            name: "短的",
            content: { charaId: [685], eventId: [2, 2] },
            updatedAt: "x",
          },
        ],
      },
    });
    const { library } = parseLibrary(raw, "0000dead");
    const deck = library.collections.quest[0]!;
    expect(deck.content.charaId).toEqual([685, null, null]);
    expect(deck.content.eventId).toHaveLength(18);
    expect(deck.content.eventId.slice(0, 3)).toEqual([2, 2, null]);
  });

  it("檔案裡的帳號不合法時退回當下這個帳號", () => {
    const raw = JSON.stringify({ version: 1, account: "不是指紋", collections: {} });
    expect(parseLibrary(raw, "4858c81f").library.account).toBe("4858c81f");
  });

  it("空牌組存得住 —— 新增一副還沒配卡的時候就是這個狀態", () => {
    let lib = emptyLibrary("4858c81f");
    lib = addDeck(lib, "quest", { name: "還沒配", content: emptyDeckContent() }).library;
    const { library: back } = parseLibrary(serializeLibrary(lib), "4858c81f");
    expect(back.collections.quest[0]?.content.charaId).toEqual([null, null, null]);
  });
});
