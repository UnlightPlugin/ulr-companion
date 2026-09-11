import { describe, expect, it } from "vitest";
import {
  deckContentFromFlat,
  deckContentToPayload,
  isAccountFingerprint,
  libraryFileName,
  parseLibrary,
  serializeLibrary,
} from "../src/serialize.js";
import { addDeck } from "../src/library.js";
import { emptyDeckContent, emptyLibrary } from "../src/types.js";

/** 2026-08-24 從實機讀到的 `db_deck1` 形狀（28 個欄位）。 */
const FLAT_DECK1: Record<string, unknown> = {
  chara1: "cc069",
  chara2: "cc068",
  chara3: "cc067",
  charaIndex1: 684,
  charaIndex2: 674,
  charaIndex3: 665,
  weapon1: null,
  weapon2: null,
  weapon3: null,
  cost: 68,
  ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`event${i + 1}`, null])),
};

describe("db_deck 的扁平格式 ↔ DeckContent", () => {
  it("讀得出實機那副牌", () => {
    const c = deckContentFromFlat(FLAT_DECK1);
    expect(c.chara).toEqual(["cc069", "cc068", "cc067"]);
    expect(c.charaIndex).toEqual([684, 674, 665]);
    expect(c.weapon).toEqual([null, null, null]);
    expect(c.eventIndex).toHaveLength(18);
    expect(c.eventIndex.every((x) => x === null)).toBe(true);
  });

  it("送出去的形狀跟收回來的不一樣 —— eventIndex 是陣列不是 event1..18", () => {
    const c = deckContentFromFlat(FLAT_DECK1);
    const payload = deckContentToPayload(c, 68);
    expect(Object.keys(payload).sort()).toEqual(
      ["chara", "charaIndex", "cost", "eventIndex", "weapon"].sort(),
    );
    expect(payload.eventIndex).toHaveLength(18);
    expect(payload).not.toHaveProperty("event1");
  });

  it("欄位缺了也不會炸，缺的當空格", () => {
    const c = deckContentFromFlat({ chara1: "cc069", charaIndex1: 684 });
    expect(c.charaIndex).toEqual([684, null, null]);
    expect(c.eventIndex).toHaveLength(18);
  });

  it("字串數字也讀得進來 —— 伺服器有些欄位是字串", () => {
    const c = deckContentFromFlat({ charaIndex1: "684", event1: "2" });
    expect(c.charaIndex[0]).toBe(684);
    expect(c.eventIndex[0]).toBe(2);
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
    const content = deckContentFromFlat(FLAT_DECK1);
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
            content: { chara: ["cc069"], charaIndex: [684], eventIndex: [2, 2] },
            updatedAt: "x",
          },
        ],
      },
    });
    const { library } = parseLibrary(raw, "0000dead");
    const deck = library.collections.quest[0]!;
    expect(deck.content.chara).toEqual(["cc069", null, null]);
    expect(deck.content.eventIndex).toHaveLength(18);
    expect(deck.content.eventIndex.slice(0, 3)).toEqual([2, 2, null]);
  });

  it("檔案裡的帳號不合法時退回當下這個帳號", () => {
    const raw = JSON.stringify({ version: 1, account: "不是指紋", collections: {} });
    expect(parseLibrary(raw, "4858c81f").library.account).toBe("4858c81f");
  });

  it("空牌組存得住 —— 新增一副還沒配卡的時候就是這個狀態", () => {
    let lib = emptyLibrary("4858c81f");
    lib = addDeck(lib, "quest", { name: "還沒配", content: emptyDeckContent() }).library;
    const { library: back } = parseLibrary(serializeLibrary(lib), "4858c81f");
    expect(back.collections.quest[0]?.content.charaIndex).toEqual([null, null, null]);
  });
});
