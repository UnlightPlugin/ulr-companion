/**
 * 最愛卡片（DeckLibrary.favorites）
 *
 * 玩家 2026-09-26：「最愛角色和插件牌組一樣也要在雲端存起來」。所以它住在牌組庫裡、
 * 跟著雲端文件走。同一天又改成存卡片 id（「最愛角色指的是最愛卡片」）。要抓的坑：
 *
 * 1. 存檔讀回來還在；舊存檔（沒有這一欄）不會憑空長出一個空的最愛
 * 2. 合併整份比時間，較新的贏；沒有這一欄的那一邊不參與（舊版托盤推上來的文件）
 * 3. 合併兩次不橫跳
 * 4. 點了沒變就不動時間戳（時間戳一動雲端就會推一次）
 */

import { describe, expect, it } from "vitest";
import {
  absorbLibrary,
  favoriteCards,
  favoriteEvents,
  hiddenWeapons,
  setFavoriteCard,
  setFavoriteEvent,
  setHiddenWeapon,
} from "../src/library.js";
import { mergeLibraries, parseSyncDocument, toSyncDocument } from "../src/merge.js";
import { parseLibrary, serializeLibrary } from "../src/serialize.js";
import { emptyLibrary } from "../src/types.js";

const T0 = new Date("2026-09-26T10:00:00.000Z");
const T1 = new Date("2026-09-26T11:00:00.000Z");

describe("setFavoriteCard", () => {
  it("加入接在最後、移出拿掉，時間戳跟著動", () => {
    let lib = emptyLibrary("4858c81f");
    lib = setFavoriteCard(lib, 1, true, T0);
    lib = setFavoriteCard(lib, 776, true, T1);
    expect(favoriteCards(lib)).toEqual([1, 776]);
    expect(lib.favorites?.updatedAt).toBe(T1.toISOString());
    lib = setFavoriteCard(lib, 1, false, T1);
    expect(favoriteCards(lib)).toEqual([776]);
  });

  it("沒變就回同一個物件（不動時間戳）", () => {
    const lib = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    expect(setFavoriteCard(lib, 1, true, T1)).toBe(lib);
    expect(setFavoriteCard(lib, 2, false, T1)).toBe(lib);
  });
});

describe("存檔", () => {
  it("讀回來還在；舊存檔沒有這一欄就是沒設過", () => {
    const lib = setFavoriteCard(emptyLibrary("4858c81f"), 5, true, T0);
    const back = parseLibrary(serializeLibrary(lib), "00000000").library;
    expect(back.favorites).toEqual({ cards: [5], updatedAt: T0.toISOString() });

    const old = parseLibrary(serializeLibrary(emptyLibrary("4858c81f")), "00000000").library;
    expect(old.favorites).toBeUndefined();
  });

  it("網路上收來的怪值丟掉、重複的只留一個", () => {
    const raw = {
      version: 2,
      collections: {},
      favorites: { cards: [1, 1, "<script>", -3, 2.5, 776], updatedAt: "x" },
    };
    expect(parseSyncDocument(raw)?.favorites?.cards).toEqual([1, 776]);
  });

  it("當天第一版存角色鍵的 { charas } 當沒設過", () => {
    const raw = {
      version: 2,
      collections: {},
      favorites: { charas: ["cc001"], updatedAt: "x" },
    };
    expect(parseSyncDocument(raw)?.favorites).toBeUndefined();
  });
});

describe("雲端合併", () => {
  it("雲端較新：拿雲端的；本地較新：推上去", () => {
    const local = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    const remote = toSyncDocument(setFavoriteCard(emptyLibrary("4858c81f"), 2, true, T1));

    const pulled = mergeLibraries(local, remote);
    expect(favoriteCards(pulled.library)).toEqual([2]);
    expect(pulled.localChanged).toBe(true);
    expect(pulled.remoteChanged).toBe(false);

    const newer = setFavoriteCard(local, 3, true, new Date("2026-09-26T12:00:00.000Z"));
    const pushed = mergeLibraries(newer, remote);
    expect(pushed.document.favorites?.cards).toEqual([1, 3]);
    expect(pushed.remoteChanged).toBe(true);
  });

  it("舊版托盤推上來的文件沒有最愛：本地的留著，而且要推回去", () => {
    const local = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    const remote = toSyncDocument(emptyLibrary("4858c81f"));
    const r = mergeLibraries(local, remote);
    expect(favoriteCards(r.library)).toEqual([1]);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(true);
  });

  it("雲端還沒有東西、本地只有最愛：也要推", () => {
    const local = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    expect(mergeLibraries(local, null).remoteChanged).toBe(true);
  });

  it("合併兩次不橫跳", () => {
    const local = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    const remote = toSyncDocument(setFavoriteCard(emptyLibrary("4858c81f"), 2, true, T1));
    const first = mergeLibraries(local, remote);
    const second = mergeLibraries(first.library, first.document);
    expect(second.localChanged).toBe(false);
    expect(second.remoteChanged).toBe(false);
  });
});

describe("absorbLibrary", () => {
  it("這份還沒設過才接過來", () => {
    const src = setFavoriteCard(emptyLibrary("11111111"), 1, true, T0);
    const fresh = absorbLibrary(emptyLibrary("22222222"), src).library;
    expect(favoriteCards(fresh)).toEqual([1]);

    const mine = setFavoriteCard(emptyLibrary("22222222"), 9, true, T1);
    expect(favoriteCards(absorbLibrary(mine, src).library)).toEqual([9]);
  });
});

// ---------------------------------------------------------------------------
// 隱藏的裝備（DeckLibrary.hiddenWeapons）：玩家 2026-09-26「手動隱藏的也和最愛卡牌
// 一樣要在雲端儲存」。同一個形狀、同一套規則，這裡確認它真的走了每一條路、而且
// 跟最愛互不干擾。
// ---------------------------------------------------------------------------

describe("hiddenWeapons", () => {
  it("加入／移出、沒變回同一個物件；不碰最愛", () => {
    let lib = setFavoriteCard(emptyLibrary("4858c81f"), 1, true, T0);
    lib = setHiddenWeapon(lib, 25, true, T1);
    expect(hiddenWeapons(lib)).toEqual([25]);
    expect(favoriteCards(lib)).toEqual([1]);
    expect(lib.favorites?.updatedAt).toBe(T0.toISOString());
    expect(setHiddenWeapon(lib, 25, true, T1)).toBe(lib);
    expect(hiddenWeapons(setHiddenWeapon(lib, 25, false, T1))).toEqual([]);
  });

  it("存檔讀回來還在；舊存檔沒有這一欄就是沒設過", () => {
    const lib = setHiddenWeapon(emptyLibrary("4858c81f"), 276, true, T0);
    const back = parseLibrary(serializeLibrary(lib), "00000000").library;
    expect(back.hiddenWeapons).toEqual({ cards: [276], updatedAt: T0.toISOString() });
    expect(back.favorites).toBeUndefined();
  });

  it("上雲：雲端較新拿雲端的、本地較新推上去；舊版文件沒有這欄也要推", () => {
    const local = setHiddenWeapon(emptyLibrary("4858c81f"), 25, true, T0);
    const remote = toSyncDocument(setHiddenWeapon(emptyLibrary("4858c81f"), 276, true, T1));
    const pulled = mergeLibraries(local, remote);
    expect(hiddenWeapons(pulled.library)).toEqual([276]);
    expect(pulled.remoteChanged).toBe(false);

    const old = mergeLibraries(local, toSyncDocument(emptyLibrary("4858c81f")));
    expect(old.document.hiddenWeapons?.cards).toEqual([25]);
    expect(old.remoteChanged).toBe(true);

    expect(mergeLibraries(local, null).remoteChanged).toBe(true);
    const again = mergeLibraries(pulled.library, pulled.document);
    expect(again.localChanged || again.remoteChanged).toBe(false);
  });

  it("網路上收來的怪值丟掉", () => {
    const raw = {
      version: 2,
      collections: {},
      hiddenWeapons: { cards: [25, 25, "x", 0], updatedAt: "x" },
    };
    expect(parseSyncDocument(raw)?.hiddenWeapons?.cards).toEqual([25]);
  });

  it("absorbLibrary：這份還沒設過才接過來", () => {
    const src = setHiddenWeapon(emptyLibrary("11111111"), 25, true, T0);
    expect(hiddenWeapons(absorbLibrary(emptyLibrary("22222222"), src).library)).toEqual([25]);
    const mine = setHiddenWeapon(emptyLibrary("22222222"), 276, true, T1);
    expect(hiddenWeapons(absorbLibrary(mine, src).library)).toEqual([276]);
  });
});

// ---------------------------------------------------------------------------
// 最愛的事件卡（DeckLibrary.favoriteEvents）：玩家 2026-09-26「事件卡區域…增加最愛
// 卡片…一樣要存到雲端內」。事件卡 id 跟角色卡 id 重疊，所以是另一個清單 ——
// 這裡確認同一個數字在兩個清單裡互不干擾。
// ---------------------------------------------------------------------------

describe("favoriteEvents", () => {
  it("加入／移出、沒變回同一個物件；同一個 id 跟角色卡的最愛互不干擾", () => {
    let lib = setFavoriteCard(emptyLibrary("4858c81f"), 3, true, T0);
    lib = setFavoriteEvent(lib, 3, true, T1);
    expect(favoriteEvents(lib)).toEqual([3]);
    expect(favoriteCards(lib)).toEqual([3]);
    expect(lib.favorites?.updatedAt).toBe(T0.toISOString());
    expect(setFavoriteEvent(lib, 3, true, T1)).toBe(lib);
    lib = setFavoriteEvent(lib, 3, false, T1);
    expect(favoriteEvents(lib)).toEqual([]);
    expect(favoriteCards(lib)).toEqual([3]);
  });

  it("存檔讀回來還在；舊存檔沒有這一欄就是沒設過", () => {
    const lib = setFavoriteEvent(emptyLibrary("4858c81f"), 44, true, T0);
    const back = parseLibrary(serializeLibrary(lib), "00000000").library;
    expect(back.favoriteEvents).toEqual({ cards: [44], updatedAt: T0.toISOString() });
    expect(back.favorites).toBeUndefined();
    const old = parseLibrary(serializeLibrary(emptyLibrary("4858c81f")), "00000000").library;
    expect(old.favoriteEvents).toBeUndefined();
  });

  it("上雲：雲端較新拿雲端的、本地較新推上去；舊版文件沒有這欄也要推", () => {
    const local = setFavoriteEvent(emptyLibrary("4858c81f"), 3, true, T0);
    const remote = toSyncDocument(setFavoriteEvent(emptyLibrary("4858c81f"), 44, true, T1));
    const pulled = mergeLibraries(local, remote);
    expect(favoriteEvents(pulled.library)).toEqual([44]);
    expect(pulled.remoteChanged).toBe(false);

    const old = mergeLibraries(local, toSyncDocument(emptyLibrary("4858c81f")));
    expect(old.document.favoriteEvents?.cards).toEqual([3]);
    expect(old.remoteChanged).toBe(true);

    expect(mergeLibraries(local, null).remoteChanged).toBe(true);
    const again = mergeLibraries(pulled.library, pulled.document);
    expect(again.localChanged || again.remoteChanged).toBe(false);
  });

  it("網路上收來的怪值丟掉", () => {
    const raw = {
      version: 2,
      collections: {},
      favoriteEvents: { cards: [3, 3, "x", 0], updatedAt: "x" },
    };
    expect(parseSyncDocument(raw)?.favoriteEvents?.cards).toEqual([3]);
  });

  it("absorbLibrary：這份還沒設過才接過來", () => {
    const src = setFavoriteEvent(emptyLibrary("11111111"), 3, true, T0);
    expect(favoriteEvents(absorbLibrary(emptyLibrary("22222222"), src).library)).toEqual([3]);
    const mine = setFavoriteEvent(emptyLibrary("22222222"), 44, true, T1);
    expect(favoriteEvents(absorbLibrary(mine, src).library)).toEqual([44]);
  });
});
