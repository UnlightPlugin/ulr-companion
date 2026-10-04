import { describe, expect, it } from "vitest";
import {
  absorbLibrary,
  addDeck,
  displayName,
  findDeck,
  listDecks,
  moveDeck,
  removeDeck,
  renameDeck,
  setSelected,
  updateDeckContent,
} from "../src/library.js";
import { emptyDeckContent, emptyLibrary, guardDeck1, isEmptyDeck } from "../src/types.js";
import type { DeckLibrary } from "../src/types.js";

function seed(names: string[]): { lib: DeckLibrary; ids: string[] } {
  let lib = emptyLibrary("4858c81f");
  const ids: string[] = [];
  for (const name of names) {
    const r = addDeck(lib, "dietherm", { name });
    lib = r.library;
    ids.push(r.entry.id);
  }
  return { lib, ids };
}

describe("Deck1 的安全閘", () => {
  it("第一格空的一律擋下來", () => {
    const empty = emptyDeckContent();
    expect(guardDeck1(empty)).toContain("不能是空的");
    expect(isEmptyDeck(empty)).toBe(true);
  });

  it("第一格有卡就放行 —— 二三格空著沒關係", () => {
    const deck = emptyDeckContent();
    deck.charaId[0] = 685;
    expect(guardDeck1(deck)).toBeNull();
    expect(isEmptyDeck(deck)).toBe(false);
  });
});

describe("增刪改", () => {
  it("新增的排在最後，而且不動到原本那份（不可變）", () => {
    const { lib } = seed(["甲", "乙"]);
    const before = listDecks(lib, "dietherm").length;
    const { library: next } = addDeck(lib, "dietherm", { name: "丙" });
    expect(listDecks(lib, "dietherm").length).toBe(before); // 原本那份沒被動
    expect(listDecks(next, "dietherm").map((d) => d.name)).toEqual(["甲", "乙", "丙"]);
  });

  it("每副的 id 不一樣 —— 撞號會讓拖曳時兩副一起動", () => {
    const { ids } = seed(["甲", "乙", "丙", "丁"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("改名認 id 不認位置", () => {
    const { lib, ids } = seed(["甲", "乙", "丙"]);
    const moved = moveDeck(lib, "dietherm", ids[0]!, 2); // 甲搬到最後
    const renamed = renameDeck(moved, "dietherm", ids[0]!, "改過的甲");
    expect(findDeck(renamed, "dietherm", ids[0]!)?.name).toBe("改過的甲");
    expect(listDecks(renamed, "dietherm").map((d) => d.name)).toEqual(["乙", "丙", "改過的甲"]);
  });

  it("刪除只動那一副", () => {
    const { lib, ids } = seed(["甲", "乙", "丙"]);
    const next = removeDeck(lib, "dietherm", ids[1]!);
    expect(listDecks(next, "dietherm").map((d) => d.name)).toEqual(["甲", "丙"]);
  });

  it("換內容會更新 updatedAt", () => {
    const { lib, ids } = seed(["甲"]);
    const content = emptyDeckContent();
    content.charaId[0] = 685;
    const next = updateDeckContent(
      lib,
      "dietherm",
      ids[0]!,
      content,
      new Date("2026-08-24T12:00:00Z"),
    );
    const entry = findDeck(next, "dietherm", ids[0]!);
    expect(entry?.content.charaId[0]).toBe(685);
    expect(entry?.updatedAt).toBe("2026-08-24T12:00:00.000Z");
  });

  it("房型之間互不影響", () => {
    const { lib } = seed(["甲", "乙"]);
    const { library: next } = addDeck(lib, "raid", { name: "渦用" });
    expect(listDecks(next, "dietherm").length).toBe(2);
    expect(listDecks(next, "raid").map((d) => d.name)).toEqual(["渦用"]);
  });
});

describe("拖曳排序（規格 §10）", () => {
  it("往後搬", () => {
    const { lib, ids } = seed(["甲", "乙", "丙", "丁"]);
    const next = moveDeck(lib, "dietherm", ids[0]!, 2);
    expect(listDecks(next, "dietherm").map((d) => d.name)).toEqual(["乙", "丙", "甲", "丁"]);
  });

  it("往前搬", () => {
    const { lib, ids } = seed(["甲", "乙", "丙", "丁"]);
    const next = moveDeck(lib, "dietherm", ids[3]!, 1);
    expect(listDecks(next, "dietherm").map((d) => d.name)).toEqual(["甲", "丁", "乙", "丙"]);
  });

  it("超出範圍會夾住，不會弄丟牌組", () => {
    const { lib, ids } = seed(["甲", "乙", "丙"]);
    const far = moveDeck(lib, "dietherm", ids[0]!, 99);
    expect(far.collections.dietherm.map((d) => d.name)).toEqual(["乙", "丙", "甲"]);
    const neg = moveDeck(lib, "dietherm", ids[2]!, -5);
    expect(neg.collections.dietherm.map((d) => d.name)).toEqual(["丙", "甲", "乙"]);
  });

  it("id 不存在就原樣回傳", () => {
    const { lib } = seed(["甲", "乙"]);
    expect(moveDeck(lib, "dietherm", "沒這個", 0)).toBe(lib);
  });
});

describe("顯示名稱", () => {
  it("沒取名字就退回 Deck{位置}", () => {
    const { lib } = seed(["", "  ", "有名字"]);
    const list = listDecks(lib, "dietherm");
    expect(displayName(list[0]!, 0)).toBe("Deck1");
    expect(displayName(list[1]!, 1)).toBe("Deck2");
    expect(displayName(list[2]!, 2)).toBe("有名字");
  });
});

describe("absorbLibrary（同一個角色散成好幾份庫時併回來）", () => {
  const content = (first: number) => {
    const c = emptyDeckContent();
    c.charaId[0] = first;
    return c;
  };

  it("內容一樣的不重收、不一樣的接在後面，名字標籤原樣帶過來", () => {
    let target = emptyLibrary("aaaaaaaa");
    target = addDeck(target, "raid", { content: content(1) }).library;
    let source = emptyLibrary("bbbbbbbb");
    source = addDeck(source, "raid", { content: content(1) }).library; // 複本
    source = addDeck(source, "raid", {
      name: "龜",
      content: content(2),
      bosses: ["turtle"],
    }).library;
    const r = absorbLibrary(target, source);
    expect(r.added).toBe(1);
    const list = listDecks(r.library, "raid");
    expect(list.map((d) => d.content.charaId[0])).toEqual([1, 2]);
    expect(list[1]!.name).toBe("龜");
    expect(list[1]!.bosses).toEqual(["turtle"]);
    expect(r.library.account).toBe("aaaaaaaa");
  });

  it("selected 只在這一房還沒選時接過來；墓碑不帶", () => {
    let source = emptyLibrary("bbbbbbbb");
    const added = addDeck(source, "quest", { content: content(3) });
    source = setSelected(added.library, "quest", added.entry.id);
    source = removeDeck(addDeck(source, "quest", { content: content(4) }).library, "quest", "x");
    const r = absorbLibrary(emptyLibrary("aaaaaaaa"), source);
    expect(r.library.selected.quest).toBe(added.entry.id);
    expect(r.library.tombstones.quest).toEqual([]);
  });
});
