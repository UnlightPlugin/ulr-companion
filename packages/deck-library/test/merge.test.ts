/**
 * 雲端同步的合併（merge.ts）
 *
 * 每一條都在問同一件事：**兩台電腦輪流用，牌組會不會被吃掉、會不會反覆橫跳。**
 * 「橫跳」的測法是合併兩次：第二次（拿第一次的結果對同一份雲端）必須什麼都
 * 不變 —— 否則每一輪同步都會推一次。
 */

import { describe, expect, it } from "vitest";
import {
  libraryFromSyncDocument,
  mergeLibraries,
  parseSyncDocument,
  syncDocumentText,
  toSyncDocument,
} from "../src/merge.js";
import { addDeck, moveDeck, removeDeck, renameDeck, updateDeckContent } from "../src/library.js";
import { serializeLibrary } from "../src/serialize.js";
import { emptyDeckContent, emptyLibrary } from "../src/types.js";
import type { DeckLibrary } from "../src/types.js";

function deckWith(charaIndex: number): ReturnType<typeof emptyDeckContent> {
  const c = emptyDeckContent();
  c.chara[0] = "cc069";
  c.charaIndex[0] = charaIndex;
  return c;
}

const T0 = new Date("2026-09-13T10:00:00.000Z");
const T1 = new Date("2026-09-13T11:00:00.000Z");
const T2 = new Date("2026-09-13T12:00:00.000Z");

/** 兩副牌、一房，兩台電腦一開始一模一樣。 */
function seed(): { a: DeckLibrary; b: DeckLibrary; ids: string[] } {
  let lib = emptyLibrary("4858c81f", "燈皇");
  const ids: string[] = [];
  const r1 = addDeck(lib, "dietherm", { name: "甲", content: deckWith(1), now: T0 });
  ids.push(r1.entry.id);
  lib = r1.library;
  const r2 = addDeck(lib, "dietherm", {
    name: "乙",
    content: deckWith(2),
    now: new Date(T0.getTime() + 1),
  });
  ids.push(r2.entry.id);
  lib = r2.library;
  lib = { ...lib, selected: { ...lib.selected, dietherm: ids[0]! } };
  return { a: lib, b: structuredClone(lib), ids };
}

function names(lib: DeckLibrary, room: "dietherm" | "raid" = "dietherm"): string[] {
  return lib.collections[room].map((d) => d.name);
}

describe("mergeLibraries", () => {
  it("雲端沒東西：本地整份上雲，本地不變", () => {
    const { a } = seed();
    const r = mergeLibraries(a, null);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(true);
    expect(names(libraryFromSyncDocument(r.document, "4858c81f"))).toEqual(["甲", "乙"]);
  });

  it("雲端沒東西、本地也是空的：什麼都不推", () => {
    const r = mergeLibraries(emptyLibrary("4858c81f"), null);
    expect(r.remoteChanged).toBe(false);
    expect(r.localChanged).toBe(false);
  });

  it("兩邊一樣：什麼都不動", () => {
    const { a, b } = seed();
    const r = mergeLibraries(a, toSyncDocument(b));
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(false);
  });

  it("文件不帶帳號、名字、selected —— 那三樣是本機的", () => {
    const { a } = seed();
    const text = syncDocumentText(toSyncDocument(a));
    expect(text).not.toContain("燈皇");
    expect(text).not.toContain("4858c81f");
    expect(JSON.parse(text).selected).toEqual({
      raid: null,
      alexandria: null,
      quest: null,
      dietherm: null,
    });
  });

  it("A 改了牌、B 沒動：B 拉下來；A 那邊 selected 照舊", () => {
    const { a, b, ids } = seed();
    const a2 = updateDeckContent(a, "dietherm", ids[0]!, deckWith(9), T1);
    const r = mergeLibraries(b, toSyncDocument(a2));
    expect(r.localChanged).toBe(true);
    expect(r.remoteChanged).toBe(false);
    expect(r.library.collections.dietherm[0]!.content.charaIndex[0]).toBe(9);
    expect(r.library.selected.dietherm).toBe(ids[0]);
    expect(r.library.accountLabel).toBe("燈皇");
  });

  it("A 刪了、B 沒動：B 跟著刪，墓碑留著", () => {
    const { a, b, ids } = seed();
    const a2 = removeDeck(a, "dietherm", ids[1]!, T1);
    const r = mergeLibraries(b, toSyncDocument(a2));
    expect(names(r.library)).toEqual(["甲"]);
    expect(r.library.tombstones.dietherm.map((t) => t.id)).toEqual([ids[1]]);
    expect(r.localChanged).toBe(true);
    expect(r.remoteChanged).toBe(false);
  });

  it("A 刪了之後 B 又改過那副：B 的編輯贏，牌組復活、墓碑消失", () => {
    const { a, b, ids } = seed();
    const a2 = removeDeck(a, "dietherm", ids[1]!, T1);
    const b2 = updateDeckContent(b, "dietherm", ids[1]!, deckWith(7), T2);
    const r = mergeLibraries(b2, toSyncDocument(a2));
    expect(names(r.library)).toEqual(["甲", "乙"]);
    expect(r.library.tombstones.dietherm).toEqual([]);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(true);
  });

  it("兩邊各新增一副：兩副都在，各自推給對方", () => {
    const { a, b } = seed();
    const a2 = addDeck(a, "dietherm", { name: "A 新", content: deckWith(3), now: T1 }).library;
    const b2 = addDeck(b, "dietherm", { name: "B 新", content: deckWith(4), now: T2 }).library;
    const r = mergeLibraries(b2, toSyncDocument(a2));
    expect(names(r.library).sort()).toEqual(["A 新", "B 新", "乙", "甲"]);
    expect(r.localChanged).toBe(true);
    expect(r.remoteChanged).toBe(true);
  });

  it("B 上的內容一樣、時間比較舊：取雲端的時間，而且合併兩次不會再變", () => {
    const { a, b, ids } = seed();
    // A 改了又改回去：hash 一樣、時間變新
    const a2 = renameDeck(a, "dietherm", ids[0]!, "甲", T2);
    const r1 = mergeLibraries(b, toSyncDocument(a2));
    expect(r1.library.collections.dietherm[0]!.updatedAt).toBe(T2.toISOString());
    expect(r1.remoteChanged).toBe(false);
    const r2 = mergeLibraries(r1.library, toSyncDocument(a2));
    expect(r2.localChanged).toBe(false);
    expect(r2.remoteChanged).toBe(false);
  });

  it("A 拖曳排序：B 照 A 的順序；反過來 B 沒動時不會把舊順序推回去", () => {
    const { a, b, ids } = seed();
    const a2 = moveDeck(a, "dietherm", ids[0]!, 1, T1); // 甲搬到最後
    expect(names(a2)).toEqual(["乙", "甲"]);
    const r = mergeLibraries(b, toSyncDocument(a2));
    expect(names(r.library)).toEqual(["乙", "甲"]);
    expect(r.localChanged).toBe(true);
    expect(r.remoteChanged).toBe(false);
    // 第二輪：一致了
    const again = mergeLibraries(r.library, toSyncDocument(a2));
    expect(again.localChanged).toBe(false);
    expect(again.remoteChanged).toBe(false);
  });

  it("兩邊都排過：晚排的那一邊贏，另一邊多出來的接在後面", () => {
    const { a, b, ids } = seed();
    const a2 = moveDeck(a, "dietherm", ids[0]!, 1, T2); // A 晚：乙 甲
    let b2 = addDeck(b, "dietherm", { name: "丙", content: deckWith(5), now: T1 }).library;
    const bing = b2.collections.dietherm[2]!.id;
    b2 = moveDeck(b2, "dietherm", bing, 0, T1); // B 早：丙 甲 乙
    expect(names(b2)).toEqual(["丙", "甲", "乙"]);
    const r = mergeLibraries(b2, toSyncDocument(a2));
    // A 的順序 [乙, 甲] 在前，B 才有的丙接在後面
    expect(names(r.library)).toEqual(["乙", "甲", "丙"]);
  });

  it("同一副兩邊同時改：時間新的贏", () => {
    const { a, b, ids } = seed();
    const a2 = updateDeckContent(a, "dietherm", ids[0]!, deckWith(11), T1);
    const b2 = updateDeckContent(b, "dietherm", ids[0]!, deckWith(12), T2);
    const r = mergeLibraries(b2, toSyncDocument(a2));
    expect(r.library.collections.dietherm[0]!.content.charaIndex[0]).toBe(12);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(true);
    // 反方向：A 拿 B 的合併結果 → 拉
    const r2 = mergeLibraries(a2, r.document);
    expect(r2.library.collections.dietherm[0]!.content.charaIndex[0]).toBe(12);
    expect(r2.localChanged).toBe(true);
    expect(r2.remoteChanged).toBe(false);
  });

  it("四房各自獨立 —— 渦房的變動不會碰到迪城", () => {
    const { a, b } = seed();
    const a2 = addDeck(a, "raid", {
      name: "龜",
      content: deckWith(6),
      bosses: ["turtle"],
      now: T1,
    }).library;
    const r = mergeLibraries(b, toSyncDocument(a2));
    expect(names(r.library, "raid")).toEqual(["龜"]);
    expect(r.library.collections.raid[0]!.bosses).toEqual(["turtle"]);
    expect(names(r.library)).toEqual(["甲", "乙"]);
  });
});

describe("parseSyncDocument", () => {
  it("正規文字往返不變", () => {
    const { a } = seed();
    const doc = toSyncDocument(a);
    const back = parseSyncDocument(JSON.parse(syncDocumentText(doc)));
    expect(back).not.toBeNull();
    expect(syncDocumentText(back!)).toBe(syncDocumentText(doc));
  });

  it("不是物件、版本不對 → null（不要拿去合併，更不要蓋掉）", () => {
    expect(parseSyncDocument(null)).toBeNull();
    expect(parseSyncDocument([])).toBeNull();
    expect(parseSyncDocument({ version: 2, collections: {} })).toBeNull();
    expect(parseSyncDocument("{}")).toBeNull();
  });

  it("壞掉的那一副丟掉，其他照收", () => {
    const { a } = seed();
    const raw = JSON.parse(syncDocumentText(toSyncDocument(a)));
    raw.collections.dietherm.push({ id: 5, garbage: true });
    const doc = parseSyncDocument(raw);
    expect(doc!.collections.dietherm.map((d) => d.name)).toEqual(["甲", "乙"]);
  });

  it("serializeLibrary 對合併結果仍然是固定 key 順序（雲端比對靠它）", () => {
    const { a, b } = seed();
    const r = mergeLibraries(a, toSyncDocument(b));
    expect(serializeLibrary(r.library)).toBe(serializeLibrary(a));
  });
});
