/**
 * 首頁立繪（DeckLibrary.lobbyStand）
 *
 * 跟最愛卡片同一套規則（見 favorites.test.ts），多幾件事：
 * 1. 好幾套登場角色，整份從頁面收來；怪值要夾回範圍、壞掉的整筆丟掉
 * 2. 至少留一套；超過上限的套組與角色不收
 * 3. 大廳元件所有套共用一份，跟官方一樣的不存
 */

import { describe, expect, it } from "vitest";
import { absorbLibrary } from "../src/library.js";
import {
  LOBBY_STAND_MAX,
  LOBBY_STAND_SETS_MAX,
  lobbyStand,
  parseLobbyStand,
  parseStandLayout,
  parseUiLayout,
  setLobbyStandSets,
  setLobbyStandUi,
} from "../src/lobby-stand.js";
import { mergeLibraries, parseSyncDocument, toSyncDocument } from "../src/merge.js";
import { parseLibrary, serializeLibrary } from "../src/serialize.js";
import { emptyLibrary } from "../src/types.js";

const T0 = new Date("2026-10-02T10:00:00.000Z");
const T1 = new Date("2026-10-02T11:00:00.000Z");
const L = { x: 120, y: 400, scale: 0.8, angle: -12.5, flip: true, z: 2 };

describe("setLobbyStandSets", () => {
  it("整份換掉、動時間戳；沒變回同一個物件", () => {
    const sets = [
      { charas: ["cc063", "cc005"], layout: { cc063: L } },
      { charas: ["cc010"], layout: {} },
    ];
    const lib = setLobbyStandSets(emptyLibrary("a"), sets, T0);
    expect(lobbyStand(lib).sets).toEqual(sets);
    expect(lib.lobbyStand?.updatedAt).toBe(T0.toISOString());
    expect(setLobbyStandSets(lib, sets, T1)).toBe(lib);
  });

  it("沒設過是一套空的；全刪光也留一套空的", () => {
    expect(lobbyStand(emptyLibrary("a")).sets).toEqual([{ charas: [], layout: {} }]);
    const lib = setLobbyStandSets(
      setLobbyStandSets(emptyLibrary("a"), [{ charas: ["cc001"], layout: {} }], T0),
      [],
      T1,
    );
    expect(lobbyStand(lib).sets).toEqual([{ charas: [], layout: {} }]);
  });

  it("重複、怪值丟掉，超過上限不收", () => {
    const many = Array.from({ length: 30 }, (_, i) => `cc${String(i + 1).padStart(3, "0")}`);
    const sets = Array.from({ length: 15 }, () => ({
      charas: ["cc001", "cc001", "x", "cc1", ...many],
      layout: { cc001: L, bad: L, cc002: { x: "no" } } as never,
    }));
    const out = lobbyStand(setLobbyStandSets(emptyLibrary("a"), sets, T0)).sets;
    expect(out).toHaveLength(LOBBY_STAND_SETS_MAX);
    expect(out[0]!.charas[0]).toBe("cc001");
    expect(out[0]!.charas).toHaveLength(LOBBY_STAND_MAX);
    expect(new Set(out[0]!.charas).size).toBe(out[0]!.charas.length);
    expect(out[0]!.layout).toEqual({ cc001: L });
  });
});

describe("setLobbyStandUi（大廳元件）", () => {
  const U = { x: -30, y: 12, scale: 0.6, hidden: false };

  it("整份換掉；跟官方一樣的不存；沒變回同一個物件；不動套組", () => {
    let lib = setLobbyStandSets(emptyLibrary("a"), [{ charas: ["cc063"], layout: {} }], T0);
    lib = setLobbyStandUi(lib, { duel: U, serial: { ...U, hidden: true } }, T0);
    expect(Object.keys(lobbyStand(lib).ui)).toEqual(["duel", "serial"]);
    lib = setLobbyStandUi(lib, { duel: U, quest: { x: 0, y: 0, scale: 1, hidden: false } }, T1);
    expect(lobbyStand(lib).ui).toEqual({ duel: U });
    expect(lobbyStand(lib).sets[0]!.charas).toEqual(["cc063"]);
    expect(lib.lobbyStand?.updatedAt).toBe(T1.toISOString());
    expect(setLobbyStandUi(lib, { duel: U }, T1)).toBe(lib);
  });

  it("怪值夾回範圍、壞掉的丟掉", () => {
    expect(parseUiLayout({ x: 5000, y: -5000, scale: 9, hidden: 1 })).toEqual({
      x: 800,
      y: -800,
      scale: 2,
      hidden: false,
    });
    expect(parseUiLayout({ x: 1, y: 2 })).toBeNull();
    const lib = setLobbyStandUi(emptyLibrary("a"), { Bad: U, ok: U, x: U } as never, T0);
    expect(Object.keys(lobbyStand(lib).ui)).toEqual(["ok"]);
  });
});

describe("parseStandLayout", () => {
  it("夾回範圍、角度歸一、小數截短", () => {
    expect(parseStandLayout({ x: 9999, y: -9999, scale: 50, angle: 370.04, z: 1 })).toEqual({
      x: 1160,
      y: -400,
      scale: 3,
      angle: 10,
      flip: false,
      z: 1,
    });
    expect(parseStandLayout({ x: 1, y: 2, scale: 0.12345, angle: -190 })?.scale).toBe(0.2);
    expect(parseStandLayout({ x: 1, y: 2, scale: 1, angle: -190 })?.angle).toBe(170);
  });

  it("缺欄位或不是數字 → null", () => {
    expect(parseStandLayout({ x: 1, y: 2, scale: 1 })).toBeNull();
    expect(parseStandLayout({ x: "1", y: 2, scale: 1, angle: 0 })).toBeNull();
    expect(parseStandLayout({ x: Number.NaN, y: 2, scale: 1, angle: 0 })).toBeNull();
    expect(parseStandLayout(null)).toBeNull();
  });
});

describe("存檔與雲端", () => {
  const two = [
    { charas: ["cc063"], layout: { cc063: L } },
    { charas: ["cc005", "cc010"], layout: {} },
  ];

  it("讀回來還在；舊存檔沒有這一欄就是沒設過", () => {
    let lib = setLobbyStandSets(emptyLibrary("a"), two, T0);
    lib = setLobbyStandUi(lib, { avatar: { x: 1, y: 2, scale: 1, hidden: false } }, T1);
    const back = parseLibrary(serializeLibrary(lib), "00000000").library;
    expect(back.lobbyStand).toEqual(lib.lobbyStand);

    const old = parseLibrary(serializeLibrary(emptyLibrary("a")), "00000000").library;
    expect(old.lobbyStand).toBeUndefined();
  });

  it("開發中的單一套格式（charas／layout）收成第一套", () => {
    const s = parseLobbyStand({
      charas: ["cc063", 5, "evil", "cc063"],
      layout: { cc063: L, bad: L, cc005: { x: "no" } },
      updatedAt: T0.toISOString(),
    });
    expect(s).toEqual({
      sets: [{ charas: ["cc063"], layout: { cc063: L } }],
      ui: {},
      updatedAt: T0.toISOString(),
    });
    expect(parseLobbyStand({ sets: [] })).toBeNull();
  });

  it("合併整份比時間，較新的贏；合併兩次不橫跳", () => {
    const local = setLobbyStandSets(emptyLibrary("a"), [two[0]!], T0);
    const remoteLib = setLobbyStandSets(emptyLibrary("a"), two, T1);
    const remote = parseSyncDocument(toSyncDocument(remoteLib))!;
    const r1 = mergeLibraries(local, remote);
    expect(lobbyStand(r1.library).sets).toEqual(two);
    expect(r1.localChanged).toBe(true);
    const r2 = mergeLibraries(r1.library, r1.document);
    expect(r2.localChanged).toBe(false);
    expect(r2.remoteChanged).toBe(false);
  });

  it("雲端沒有這欄（舊版托盤推的）不會把本地的清掉，還會推上去", () => {
    const local = setLobbyStandSets(emptyLibrary("a"), two, T0);
    const remote = parseSyncDocument(toSyncDocument(emptyLibrary("a")))!;
    const r = mergeLibraries(local, remote);
    expect(lobbyStand(r.library).sets).toEqual(two);
    expect(r.remoteChanged).toBe(true);
  });

  it("併舊庫：這份沒設過才接過來", () => {
    const src = setLobbyStandSets(emptyLibrary("b"), [two[1]!], T0);
    expect(absorbLibrary(emptyLibrary("a"), src).library.lobbyStand?.sets).toEqual([two[1]]);
    const mine = setLobbyStandSets(emptyLibrary("a"), [two[0]!], T1);
    expect(absorbLibrary(mine, src).library.lobbyStand?.sets).toEqual([two[0]]);
  });
});
