import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDeck,
  emptyDeckContent,
  emptyLibrary,
  listDecks,
  serializeLibrary,
  setSelected,
} from "@ulr/deck-library";
import type { DeckLibrary } from "@ulr/deck-library";
import { deckDir, readLibrary, writeLibrary } from "../src/deck-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ulr-deck-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function content(first: number) {
  const c = emptyDeckContent();
  c.charaId[0] = first;
  return c;
}

/** 在四房各放這幾副（firsts 是每副第一格的角色 id）。 */
function libraryOf(account: string, label: string, firsts: number[]): DeckLibrary {
  let lib = emptyLibrary(account, label);
  for (const room of ["quest", "raid", "alexandria", "dietherm"] as const) {
    for (const f of firsts) lib = addDeck(lib, room, { content: content(f) }).library;
  }
  return lib;
}

function put(lib: DeckLibrary, mtimeSec: number): void {
  writeLibrary(dir, lib);
  const path = join(deckDir(dir), `decks-${lib.account}.json`);
  utimesSync(path, mtimeSec, mtimeSec);
}

describe("readLibrary：指紋換成名稱之後，同名的舊庫要併回來", () => {
  it("2026-09-25 實機那一條：改版前一份、昨天一份、今天被當成新帳號的一份", () => {
    put(libraryOf("4858c81f", "燈皇", [10, 11, 12]), 1_000); // 改版前
    put(libraryOf("9d03dfb2", "燈皇", [20, 21, 22, 23]), 2_000); // 昨天在用的
    put(libraryOf("3252f537", "燈皇", [20]), 3_000); // 今天：只剩 Deck1 的複本
    put(libraryOf("bf112c58", "打喵", [99]), 4_000); // 別的角色，不能混進來

    const r = readLibrary(dir, "c0ffee00", "燈皇");
    expect(r.existed).toBe(true);
    expect(r.adopted?.files).toEqual([
      "decks-3252f537.json",
      "decks-9d03dfb2.json",
      "decks-4858c81f.json",
    ]);
    // 新的在前；Deck1(20) 的複本只留一副；打喵的 99 沒進來
    expect(listDecks(r.library, "raid").map((d) => d.content.charaId[0])).toEqual([
      20, 21, 22, 23, 10, 11, 12,
    ]);
    expect(r.adopted?.decks).toBe(7 * 4);
    expect(r.library.account).toBe("c0ffee00");
    expect(r.library.accountLabel).toBe("燈皇");
    // 舊檔一個都沒動
    expect(readdirSync(deckDir(dir)).sort()).toEqual([
      "decks-3252f537.json",
      "decks-4858c81f.json",
      "decks-9d03dfb2.json",
      "decks-bf112c58.json",
    ]);
  });

  it("接過舊庫記住的選擇", () => {
    let old = libraryOf("9d03dfb2", "燈皇", [20, 21]);
    const pick = listDecks(old, "quest")[1]!.id;
    old = setSelected(old, "quest", pick);
    put(old, 1_000);
    expect(readLibrary(dir, "c0ffee00", "燈皇").library.selected.quest).toBe(pick);
  });

  it("新指紋已經有檔 → 照讀，不再去併", () => {
    put(libraryOf("9d03dfb2", "燈皇", [20, 21]), 1_000);
    put(libraryOf("c0ffee00", "燈皇", [30]), 2_000);
    const r = readLibrary(dir, "c0ffee00", "燈皇");
    expect(r.adopted).toBeNull();
    expect(listDecks(r.library, "raid").map((d) => d.content.charaId[0])).toEqual([30]);
  });

  it("沒有同名的舊庫、或不知道名字 → 真的是第一次用", () => {
    put(libraryOf("bf112c58", "打喵", [99]), 1_000);
    expect(readLibrary(dir, "c0ffee00", "燈皇")).toMatchObject({ existed: false, adopted: null });
    expect(readLibrary(dir, "c0ffee00")).toMatchObject({ existed: false, adopted: null });
  });

  it("備份檔、壞掉的檔不算庫", () => {
    const lib = libraryOf("9d03dfb2", "燈皇", [20]);
    writeLibrary(dir, emptyLibrary("00000000"));
    writeFileSync(join(deckDir(dir), "decks-9d03dfb2.backup-v2.json"), serializeLibrary(lib));
    writeFileSync(join(deckDir(dir), "decks-4858c81f.json"), "{壞掉");
    expect(readLibrary(dir, "c0ffee00", "燈皇")).toMatchObject({ existed: false, adopted: null });
  });
});
