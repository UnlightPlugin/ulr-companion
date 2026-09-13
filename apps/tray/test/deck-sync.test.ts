/**
 * 雲端牌組庫的整條路：兩台電腦 × 一個假雲端
 *
 * 假雲端就是 Worker 用的那支 `decideDeckSync()` 加一格記憶體 —— 所以這裡測到的
 * 409、428、版本號，跟部署上去的行為是同一份程式碼。
 */

import { describe, expect, it } from "vitest";
import { DECK_SYNC_KEY_SALT, decideDeckSync, type DeckSyncRecord } from "@ulr/arbiter-link";
import { DECK_READ_EXPRESSION, DECK_SYNC_SALT } from "@ulr/cdp-adapter";
import {
  addDeck,
  emptyDeckContent,
  emptyLibrary,
  removeDeck,
  updateDeckContent,
  type DeckLibrary,
} from "@ulr/deck-library";
import { syncDeckLibrary, type FetchLike } from "../src/deck-sync.js";

const KEY = "a".repeat(64);
const BASE = "https://vault.invalid/decks";

function cloud(): {
  fetch: FetchLike;
  record: () => DeckSyncRecord | null;
  calls: string[];
  beforePut: (() => void) | undefined;
  set(rec: DeckSyncRecord): void;
} {
  let current: DeckSyncRecord | null = null;
  const calls: string[] = [];
  const self = {
    calls,
    record: () => current,
    beforePut: undefined as undefined | (() => void),
    fetch: (async (url, init) => {
      expect(url).toBe(`${BASE}/${KEY}`);
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "PUT") self.beforePut?.();
      const h = init?.headers ?? {};
      const d = decideDeckSync(
        method,
        { get: (n: string) => h[n.toLowerCase()] ?? null },
        init?.body ?? "",
        current,
      );
      if (d.write !== null) current = structuredClone(d.write);
      return { status: d.status, json: async () => structuredClone(d.body) };
    }) as FetchLike,
    set(rec: DeckSyncRecord) {
      current = rec;
    },
  };
  return self;
}

function deckWith(i: number) {
  const c = emptyDeckContent();
  c.chara[0] = "cc069";
  c.charaIndex[0] = i;
  return c;
}

const T0 = new Date("2026-09-13T10:00:00.000Z");
const T1 = new Date("2026-09-13T11:00:00.000Z");
const T2 = new Date("2026-09-13T12:00:00.000Z");

function pc(account = "4858c81f"): DeckLibrary {
  return addDeck(emptyLibrary(account, "燈皇"), "dietherm", {
    name: "甲",
    content: deckWith(1),
    now: T0,
  }).library;
}

describe("syncDeckLibrary", () => {
  it("第一台電腦：雲端 404 → 推上去，版本 1", async () => {
    const c = cloud();
    const r = await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch: c.fetch });
    expect(r.ok && r.pushed).toBe(true);
    expect(r.ok && r.version).toBe(1);
    expect(c.calls).toEqual(["GET", "PUT"]);
    expect(JSON.stringify(c.record()?.doc)).not.toContain("燈皇");
  });

  it("第二台電腦（本機是空的）：整份拉下來，不必再推", async () => {
    const c = cloud();
    await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch: c.fetch });
    // 另一台電腦的本機指紋不同也無所謂 —— 雲端認的是鍵
    const other = emptyLibrary("deadbeef", "燈皇");
    const r = await syncDeckLibrary(other, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.localChanged).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.library.account).toBe("deadbeef");
    expect(r.library.collections.dietherm.map((d) => d.name)).toEqual(["甲"]);
    expect(r.pulled).toBe(1);
  });

  it("A 改牌、B 刪另一副：兩邊輪流同步之後一致", async () => {
    const c = cloud();
    let a = pc();
    a = addDeck(a, "dietherm", { name: "乙", content: deckWith(2), now: T0 }).library;
    const first = await syncDeckLibrary(a, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    if (!first.ok) throw new Error(first.reason);
    const b = await syncDeckLibrary(emptyLibrary("deadbeef"), {
      baseUrl: BASE,
      key: KEY,
      fetch: c.fetch,
    });
    if (!b.ok) throw new Error(b.reason);
    let bLib = b.library;

    const [jia, yi] = a.collections.dietherm.map((d) => d.id);
    a = updateDeckContent(a, "dietherm", jia!, deckWith(9), T1);
    bLib = removeDeck(bLib, "dietherm", yi!, T2);

    const ra = await syncDeckLibrary(a, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    if (!ra.ok) throw new Error(ra.reason);
    const rb = await syncDeckLibrary(bLib, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    if (!rb.ok) throw new Error(rb.reason);
    const ra2 = await syncDeckLibrary(ra.library, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    if (!ra2.ok) throw new Error(ra2.reason);

    for (const lib of [rb.library, ra2.library]) {
      expect(lib.collections.dietherm.map((d) => d.name)).toEqual(["甲"]);
      expect(lib.collections.dietherm[0]!.content.charaIndex[0]).toBe(9);
    }
    expect(ra2.pushed).toBe(false);
  });

  it("⚠ 推的那一刻別台先寫了（409）：重新合併，兩邊的改動都在", async () => {
    const c = cloud();
    await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch: c.fetch });
    const rec = c.record()!;

    // A 在本地新增一副；推之前 B 搶先寫了另一副進雲端
    const a = addDeck(pc(), "raid", { name: "A 的龜", content: deckWith(3), now: T1 }).library;
    let raced = false;
    c.beforePut = () => {
      if (raced) return;
      raced = true;
      const doc = structuredClone(rec.doc) as { collections: Record<string, unknown[]> };
      const bLib = addDeck(emptyLibrary("deadbeef"), "quest", {
        name: "B 的任務",
        content: deckWith(4),
        now: T2,
      }).library;
      doc.collections["quest"] = bLib.collections.quest;
      c.set({ version: rec.version + 1, doc });
    };

    const r = await syncDeckLibrary(a, { baseUrl: BASE, key: KEY, fetch: c.fetch });
    if (!r.ok) throw new Error(r.reason);
    expect(c.calls.slice(-3)).toEqual(["GET", "PUT", "PUT"]);
    expect(r.version).toBe(3);
    const doc = c.record()!.doc as { collections: Record<string, { name: string }[]> };
    expect(doc.collections["raid"]!.map((d) => d.name)).toEqual(["A 的龜"]);
    expect(doc.collections["quest"]!.map((d) => d.name)).toEqual(["B 的任務"]);
    expect(r.library.collections.quest.map((d) => d.name)).toEqual(["B 的任務"]);
  });

  it("雲端掛了：回失敗，本地什麼都不動", async () => {
    const fetch: FetchLike = async () => ({ status: 503, json: async () => null });
    const r = await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch });
    expect(r.ok).toBe(false);
  });

  it("⚠ 雲端回一份讀不懂的東西：不合併、不覆蓋", async () => {
    let puts = 0;
    const fetch: FetchLike = async (_u, init) => {
      if (init?.method === "PUT") puts++;
      return { status: 200, json: async () => ({ version: 5, doc: { version: 2, future: true } }) };
    };
    const r = await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch });
    expect(r.ok).toBe(false);
    expect(puts).toBe(0);
  });

  it("斷網（fetch 丟例外）：回失敗", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await syncDeckLibrary(pc(), { baseUrl: BASE, key: KEY, fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ENOTFOUND");
  });
});

describe("decideDeckSync（Worker 的規則）", () => {
  const none = { get: () => null };
  it("PUT 不帶 If-Match 一律 428 —— 不接受「後寫的贏」", () => {
    expect(decideDeckSync("PUT", none, '{"doc":{}}', null).status).toBe(428);
  });
  it("GET 版本沒變回 304", () => {
    const d = decideDeckSync("GET", { get: (n) => (n === "if-none-match" ? '"4"' : null) }, "", {
      version: 4,
      doc: {},
    });
    expect(d.status).toBe(304);
  });
  it("doc 不是物件回 400，不寫", () => {
    const d = decideDeckSync("PUT", { get: () => '"0"' }, '{"doc":[1]}', null);
    expect(d.status).toBe(400);
    expect(d.write).toBeNull();
  });
});

describe("⚠ 頁面算鍵用的前綴跟雲端約定的一字不差", () => {
  it("cdp-adapter 抄的那份 = arbiter-link 那份，而且真的嵌進了讀牌組的腳本", () => {
    expect(DECK_SYNC_SALT).toBe(DECK_SYNC_KEY_SALT);
    expect(DECK_READ_EXPRESSION).toContain(JSON.stringify(DECK_SYNC_KEY_SALT));
    expect(DECK_READ_EXPRESSION).toContain("syncKey: __sync");
  });
});
