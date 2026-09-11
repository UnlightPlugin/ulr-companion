import { describe, expect, it } from "vitest";
import {
  TOMBSTONE_TTL_DAYS,
  addDeck,
  decksForBoss,
  listDecks,
  listTombstones,
  pruneTombstones,
  removeDeck,
  setDeckBosses,
  upsertDeck,
} from "../src/library.js";
import { parseLibrary, serializeLibrary } from "../src/serialize.js";
import { emptyDeckContent, emptyLibrary } from "../src/types.js";
import type { DeckLibrary } from "../src/types.js";

const NOW = new Date("2026-08-24T12:00:00Z");

function seed(): { lib: DeckLibrary; id: string } {
  const r = addDeck(emptyLibrary("4858c81f"), "dietherm", { name: "甲", now: NOW });
  return { lib: r.library, id: r.entry.id };
}

describe("刪除會留下墓碑", () => {
  it("刪掉之後牌組不見了，但留下記錄", () => {
    const { lib, id } = seed();
    const next = removeDeck(lib, "dietherm", id, NOW);
    expect(listDecks(next, "dietherm")).toEqual([]);
    expect(listTombstones(next, "dietherm")).toEqual([
      { id, deletedAt: "2026-08-24T12:00:00.000Z" },
    ]);
  });

  it("同一副刪兩次只留一塊墓碑，時間更新成後面那次", () => {
    const { lib, id } = seed();
    const once = removeDeck(lib, "dietherm", id, NOW);
    const twice = removeDeck(once, "dietherm", id, new Date("2026-08-25T12:00:00Z"));
    const graves = listTombstones(twice, "dietherm");
    expect(graves).toHaveLength(1);
    expect(graves[0]?.deletedAt).toBe("2026-08-25T12:00:00.000Z");
  });

  it("墓碑不會跨房間亂跑", () => {
    const { lib, id } = seed();
    const next = removeDeck(lib, "dietherm", id, NOW);
    expect(listTombstones(next, "raid")).toEqual([]);
  });
});

describe("upsertDeck 會清掉墓碑", () => {
  it("拉回一副被刪掉的牌組時，它的墓碑要消失", () => {
    const { lib, id } = seed();
    const deleted = removeDeck(lib, "dietherm", id, NOW);
    expect(listTombstones(deleted, "dietherm")).toHaveLength(1);

    const restored = upsertDeck(deleted, "dietherm", {
      id,
      name: "從雲端拉回來的",
      content: emptyDeckContent(),
      updatedAt: "2026-08-25T00:00:00.000Z",
      bosses: [],
    });
    expect(listTombstones(restored, "dietherm")).toEqual([]);
    expect(listDecks(restored, "dietherm").map((d) => d.name)).toEqual(["從雲端拉回來的"]);
  });

  it("已經在庫裡的會被換掉，不會變成兩副", () => {
    const { lib, id } = seed();
    const next = upsertDeck(lib, "dietherm", {
      id,
      name: "換過了",
      content: emptyDeckContent(),
      updatedAt: "2026-08-25T00:00:00.000Z",
      bosses: [],
    });
    expect(listDecks(next, "dietherm")).toHaveLength(1);
    expect(listDecks(next, "dietherm")[0]?.name).toBe("換過了");
  });
});

describe("pruneTombstones", () => {
  it("超過保留期的墓碑會被清掉", () => {
    const { lib, id } = seed();
    const old = new Date(NOW.getTime() - (TOMBSTONE_TTL_DAYS + 1) * 86400000);
    const deleted = removeDeck(lib, "dietherm", id, old);
    expect(pruneTombstones(deleted, NOW).tombstones.dietherm).toEqual([]);
  });

  it("還在保留期內的留著", () => {
    const { lib, id } = seed();
    const recent = new Date(NOW.getTime() - 5 * 86400000);
    const deleted = removeDeck(lib, "dietherm", id, recent);
    expect(pruneTombstones(deleted, NOW).tombstones.dietherm).toHaveLength(1);
  });

  it("沒東西可清的時候回傳原本那個物件（不製造無謂的新狀態）", () => {
    const { lib } = seed();
    expect(pruneTombstones(lib, NOW)).toBe(lib);
  });

  it("日期壞掉的墓碑留著 —— 丟掉它等於讓那副牌復活", () => {
    const lib = emptyLibrary("4858c81f");
    lib.tombstones.dietherm.push({ id: "x", deletedAt: "不是日期" });
    expect(pruneTombstones(lib, NOW).tombstones.dietherm).toHaveLength(1);
  });
});

describe("墓碑的存檔往返", () => {
  it("存了再讀回來，墓碑還在", () => {
    const { lib, id } = seed();
    const deleted = removeDeck(lib, "dietherm", id, NOW);
    const { library: back } = parseLibrary(serializeLibrary(deleted), "4858c81f");
    expect(back.tombstones.dietherm).toEqual([{ id, deletedAt: "2026-08-24T12:00:00.000Z" }]);
  });

  it("舊版存檔沒有 tombstones 也讀得進來", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: { dietherm: [{ id: "d1", name: "舊的", content: {}, updatedAt: "x" }] },
    });
    const { library } = parseLibrary(raw, "4858c81f");
    expect(library.tombstones.dietherm).toEqual([]);
    expect(library.collections.dietherm).toHaveLength(1);
  });

  it("牌組還在卻又有墓碑的話，墓碑丟掉 —— 兩者並存會讓同步反覆橫跳", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: { dietherm: [{ id: "d1", name: "還在", content: {}, updatedAt: "x" }] },
      tombstones: { dietherm: [{ id: "d1", deletedAt: "2026-08-24T00:00:00.000Z" }] },
    });
    const { library } = parseLibrary(raw, "4858c81f");
    expect(library.collections.dietherm).toHaveLength(1);
    expect(library.tombstones.dietherm).toEqual([]);
  });

  it("沒有 deletedAt 的墓碑丟掉", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {},
      tombstones: { dietherm: [{ id: "d1" }, { deletedAt: "x" }] },
    });
    expect(parseLibrary(raw, "4858c81f").library.tombstones.dietherm).toEqual([]);
  });
});

describe("渦 BOSS 標籤（規格 §12）", () => {
  it("標籤會去重並照固定順序排 —— 同一組標籤永遠算出同一個 hash", () => {
    const r = addDeck(emptyLibrary("4858c81f"), "raid", { name: "渦用", now: NOW });
    const tagged = setDeckBosses(r.library, "raid", r.entry.id, ["dog", "sea", "dog", "fish"], NOW);
    expect(tagged.collections.raid[0]?.bosses).toEqual(["sea", "fish", "dog"]);
  });

  it("一副可以掛多個 BOSS", () => {
    const r = addDeck(emptyLibrary("4858c81f"), "raid", {
      name: "通用",
      bosses: ["sea", "fish", "bug", "turtle", "dog"],
      now: NOW,
    });
    expect(r.entry.bosses).toHaveLength(5);
  });

  it("找得出打得動某隻 BOSS 的牌組，而且照玩家排的順序", () => {
    let lib = emptyLibrary("4858c81f");
    lib = addDeck(lib, "raid", { name: "甲", bosses: ["fish"], now: NOW }).library;
    lib = addDeck(lib, "raid", { name: "乙", bosses: ["sea"], now: NOW }).library;
    lib = addDeck(lib, "raid", { name: "丙", bosses: ["fish", "dog"], now: NOW }).library;

    expect(decksForBoss(lib, "fish").map((d) => d.name)).toEqual(["甲", "丙"]);
    expect(decksForBoss(lib, "sea").map((d) => d.name)).toEqual(["乙"]);
    expect(decksForBoss(lib, "turtle")).toEqual([]);
  });

  it("存檔往返之後標籤還在，而且順序正規化過", () => {
    const raw = JSON.stringify({
      version: 1,
      account: "4858c81f",
      collections: {
        raid: [
          {
            id: "d1",
            name: "渦用",
            content: {},
            updatedAt: "x",
            bosses: ["dog", "sea", "不是標籤", "sea"],
          },
        ],
      },
    });
    expect(parseLibrary(raw, "4858c81f").library.collections.raid[0]?.bosses).toEqual([
      "sea",
      "dog",
    ]);
  });
});
