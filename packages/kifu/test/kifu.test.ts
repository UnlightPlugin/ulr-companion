/**
 * 牌譜落地與版本快照
 *
 * 要抓的坑：
 * 1. jsonl 寫到一半（托盤當掉）讀回來不會整份壞掉；批次亂序照 seq 排、缺的批記下來
 * 2. 開場那行沒收到（托盤中途重開）照樣收，標孤兒
 * 3. 快照：共用區已經有的不再搬內容；第二場只剩雜湊往返
 * 4. 美術網域換了（每個 session 都換）照樣靠內容雜湊命中，不重存
 * 5. 開場到結束之間資料表換了版本，記下來而不是存錯雜湊
 */

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KifuMeta, KifuTextureInfo } from "@ulr/cdp-adapter";
import {
  canonicalJson,
  extOf,
  isGeneratedTextureKey,
  KifuFileStore,
  KifuSnapshotCache,
  kifuFileName,
  parseKifuText,
  relativeAssetPath,
  sha256Hex,
  snapshotMatch,
  type KifuPage,
  type KifuTextureEntry,
} from "@ulr/kifu";

function meta(over: Partial<KifuMeta> = {}): KifuMeta {
  return {
    script: 1,
    format: 1,
    side: "A",
    rule: "duel",
    stage: "003",
    turnLimit: 18,
    bgm: "bgm003",
    multi: true,
    crossplay: false,
    roomHash: "0123456789abcdef",
    dialogue: null,
    players: {},
    ownDeck: null,
    opponentCharaIds: [],
    hp: {},
    partial: false,
    attachTurn: 1,
    lang: "tcn",
    client: [],
    baseURL: "https://www.playunlight-aaaa.site/",
    tables: {},
    loader: [],
    ...over,
  };
}

describe("檔案格式", () => {
  it("寫到一半的行跳過；批次照 seq 排、缺的記下來", () => {
    const lines = [
      JSON.stringify({ t: "start", format: 1, key: "k1", startedAt: 1, meta: meta() }),
      JSON.stringify({ t: "ev", seq: 2, ev: [[30, "in", "c", []]] }),
      JSON.stringify({ t: "ev", seq: 0, ev: [[10, "in", "a", []]] }),
      JSON.stringify({ t: "ev", seq: 3, ev: [[40, "in", "d", []]] }),
      '{"t":"ev","seq":4,"ev":[[50,"in"', // 當掉在這裡
    ];
    const rec = parseKifuText(lines.join("\n"));
    expect(rec.key).toBe("k1");
    expect(rec.events.map((e) => e[2])).toEqual(["a", "c", "d"]);
    expect(rec.gaps).toEqual([1]);
    expect(rec.end).toBeNull();
  });

  it("同一批寫了兩次（兩個托盤同時接著）只算一次", () => {
    const start = JSON.stringify({ t: "start", format: 1, key: "k1", startedAt: 1, meta: meta() });
    const b0 = JSON.stringify({ t: "ev", seq: 0, ev: [[10, "in", "a", []]] });
    const b1 = JSON.stringify({ t: "ev", seq: 1, ev: [[20, "in", "b", []]] });
    const rec = parseKifuText([start, start, b0, b0, b1, b1].join("\n"));
    expect(rec.events.map((e) => e[2])).toEqual(["a", "b"]);
    expect(rec.gaps).toEqual([]);
  });

  it("檔名照時間排、不帶奇怪字元", () => {
    const name = kifuFileName("mvk-A-x/y", new Date(2026, 9, 23, 19, 6, 51).getTime(), "duel", "B");
    expect(name).toBe("20261023-190651_duel_B_mvk-A-xy.jsonl");
  });

  it("canonicalJson 跟鍵順序無關", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
  });

  it("美術路徑去掉 session 網域；畫布叫 canvas", () => {
    expect(
      relativeAssetPath(
        "https://www.playunlight-aaaa.site/images/a.avif",
        "https://www.playunlight-aaaa.site/",
      ),
    ).toBe("images/a.avif");
    expect(
      relativeAssetPath(
        "https://www.playunlight-bbbb.site/images/a.avif",
        "https://www.playunlight-aaaa.site/",
      ),
    ).toBe("images/a.avif");
    expect(relativeAssetPath("data:image/png;base64,AAAA", null)).toBe("canvas");
    expect(isGeneratedTextureKey("6b9c6dc4-3cd9-44b5-8d56-4fa390f19cd2")).toBe(true);
    expect(isGeneratedTextureKey("cc004_s")).toBe(false);
    expect(extOf("x.json", "application/json; charset=utf-8")).toBe("json");
    expect(extOf("https://a/b/c.avif?v=1", null)).toBe("avif");
  });
});

describe("落地", () => {
  it("開場、事件、結束、快照依序寫進同一份；讀得回來", () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    store.begin({ type: "kifu-start", key: "k1", startedAt: Date.now(), meta: meta() });
    store.append({
      type: "kifu-events",
      key: "k1",
      seq: 0,
      events: [[1, "in", "drawPhase", [[], 6]]],
    });
    store.end({
      type: "kifu-end",
      key: "k1",
      endedAt: 2,
      reason: "socket-closed",
      textures: ["a"],
      frames: { a: ["x"] },
      fonts: [],
      lastSeq: 0,
    });
    store.writeSnapshot("k1", {
      t: "snap",
      at: 3,
      tables: {},
      textures: {},
      fonts: [],
      fontFiles: {},
      missing: [],
    });
    const files = store.listFiles();
    expect(files).toHaveLength(1);
    const rec = store.readKifu(files[0]!);
    expect(rec.start?.meta.stage).toBe("003");
    expect(rec.events).toEqual([[1, "in", "drawPhase", [[], 6]]]);
    expect(rec.end?.reason).toBe("socket-closed");
    expect(rec.snap?.t).toBe("snap");
  });

  it("沒收到開場的那場照樣收，第一行是孤兒", () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    store.append({ type: "kifu-events", key: "lost", seq: 5, events: [[1, "in", "x", []]] });
    const text = readFileSync(join(store.kifuDir, store.listFiles()[0]!), "utf8");
    expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({ t: "orphan", key: "lost" });
    expect(parseKifuText(text).key).toBe("lost");
  });
});

/** 假頁面：記錄每種呼叫幾次，網址照 session 網域變 */
function fakePage(
  files: Record<string, Uint8Array>,
  textures: KifuTextureInfo[],
  tables: Record<string, string>,
) {
  const calls = { readTable: 0, textureInfo: 0, hashUrls: 0, readUrl: 0 };
  const page: KifuPage = {
    readTable: async (n) => {
      calls.readTable++;
      return tables[n] ?? null;
    },
    textureInfo: async (keys) => {
      calls.textureInfo++;
      return textures.filter((t) => keys.includes(t.key));
    },
    hashUrls: async (urls) => {
      calls.hashUrls++;
      return urls.map((u) => {
        const b = files[u];
        return b === undefined
          ? { url: u, sha: null, size: 0, type: null, error: "HTTP 404" }
          : {
              url: u,
              sha: sha256Hex(b),
              size: b.byteLength,
              type: u.endsWith(".avif") ? "image/avif" : "image/webp",
            };
      });
    },
    readUrl: async (u) => {
      calls.readUrl++;
      return files[u] ?? null;
    },
    fontFiles: async () => Object.keys(files).filter((u) => u.endsWith(".otf")),
  };
  return { page, calls };
}

describe("版本快照", () => {
  const tableText = JSON.stringify([{ id: 37, name: "利恩" }]);
  const tableSha = sha256Hex(tableText);
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const canvas = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

  function session(domain: string) {
    const base = `https://www.playunlight-${domain}.site/`;
    const stand = new Uint8Array([1, 2, 3, 4]);
    const ui = new Uint8Array([5, 6, 7]);
    const files: Record<string, Uint8Array> = {
      [`${base}images/assets/CharaCards/standchara/cc004.avif`]: stand,
      [`${base}images/assets/Game/ui.webp`]: ui,
      [`${base}images/assets/Fonts/BradleyGratis.otf`]: new Uint8Array([79, 84, 84, 79]),
    };
    const textures: KifuTextureInfo[] = [
      {
        key: "cc004_s",
        sources: [`${base}images/assets/CharaCards/standchara/cc004.avif`],
        frames: { "0": [0, 0, 0, 10, 10, 0, 0, 10, 10, 0] },
      },
      {
        key: "GameUIImages",
        sources: [`${base}images/assets/Game/ui.webp`],
        frames: { a: [0, 0, 0, 5, 5, 0, 0, 5, 5, 0] },
        bitmapFont: { lineHeight: 10, chars: {} },
      },
      { key: "circle", sources: [canvas], frames: { __BASE: [0, 0, 0, 1, 1, 0, 0, 1, 1, 0] } },
    ];
    return { base, files, textures };
  }

  it("第一場全存；第二場（換了網域）只剩雜湊往返", async () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    const s1 = session("aaaa");
    const m1 = meta({
      baseURL: s1.base,
      tables: { CharaCards: tableSha, Feats: null },
      loader: [
        { kind: "atlas", key: "cc004_s", url: "images/assets/CharaCards/standchara/cc004.avif" },
      ],
    });
    const f1 = fakePage(s1.files, s1.textures, { CharaCards: tableText });
    const r1 = await snapshotMatch(
      f1.page,
      store,
      m1,
      {
        textures: ["GameUIImages", "circle", "6b9c6dc4-3cd9-44b5-8d56-4fa390f19cd2"],
        fonts: ["font_heavy"],
      },
      new KifuSnapshotCache(),
    );

    expect(r1.snap.tables).toEqual({ CharaCards: tableSha });
    expect(r1.snap.missing).toEqual(["table:Feats 開場時就沒有"]);
    expect(Object.keys(r1.snap.fontFiles)).toEqual(["BradleyGratis.otf"]);
    expect(Object.keys(r1.snap.textures).sort()).toEqual(["GameUIImages", "cc004_s", "circle"]);
    expect(f1.calls.readUrl).toBe(3); // 兩個檔＋字型；畫布在 Node 直接解
    expect(store.readTable(tableSha)).toBe(tableText);
    const entry = JSON.parse(store.readTexture(r1.snap.textures.cc004_s!)!) as KifuTextureEntry;
    expect(entry.paths).toEqual(["images/assets/CharaCards/standchara/cc004.avif"]);
    expect(entry.sources).toEqual([sha256Hex(new Uint8Array([1, 2, 3, 4]))]);
    expect(store.blobPath(entry.sources[0]!)).toMatch(/\.avif$/);
    expect(JSON.parse(store.readTexture(r1.snap.textures.GameUIImages!)!)).toMatchObject({
      bitmapFont: { lineHeight: 10 },
    });
    const circle = JSON.parse(store.readTexture(r1.snap.textures.circle!)!) as KifuTextureEntry;
    expect(circle.paths).toEqual(["canvas"]);
    expect(store.blobPath(circle.sources[0]!)).toMatch(/\.png$/);
    expect(r1.added).toBeGreaterThan(0);

    // 第二場：新 session、新網域、新的快取物件
    const s2 = session("bbbb");
    const f2 = fakePage(s2.files, s2.textures, { CharaCards: tableText });
    const r2 = await snapshotMatch(
      f2.page,
      store,
      { ...m1, baseURL: s2.base },
      { textures: ["GameUIImages", "circle"], fonts: [] },
      new KifuSnapshotCache(),
    );
    expect(f2.calls.readTable).toBe(0);
    expect(f2.calls.readUrl).toBe(0);
    expect(r2.added).toBe(0);
    expect(r2.snap.textures).toEqual(r1.snap.textures);
    expect(readdirSync(store.blobDir)).toHaveLength(4);
  });

  it("同一個 session 第二場連雜湊都不算", async () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    const s = session("aaaa");
    const cache = new KifuSnapshotCache();
    const m = meta({ baseURL: s.base });
    await snapshotMatch(
      fakePage(s.files, s.textures, {}).page,
      store,
      m,
      { textures: ["GameUIImages"], fonts: [] },
      cache,
    );
    const f = fakePage(s.files, s.textures, {});
    await snapshotMatch(f.page, store, m, { textures: ["GameUIImages"], fonts: [] }, cache);
    expect(f.calls.hashUrls).toBe(0);
  });

  it("資料表在開場後換了版本：存現在的、記下來", async () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    const newer = JSON.stringify([{ id: 37, name: "利恩（新）" }]);
    const r = await snapshotMatch(
      fakePage({}, [], { CharaCards: newer }).page,
      store,
      meta({ tables: { CharaCards: tableSha } }),
      { textures: [], fonts: [] },
      new KifuSnapshotCache(),
    );
    expect(r.snap.tables.CharaCards).toBe(sha256Hex(newer));
    expect(r.snap.missing[0]).toMatch(/開場的版本已經不在/);
  });

  it("讀不到的檔記成 missing，貼圖快照照樣寫（來源是 null）", async () => {
    const root = mkdtempSync(join(tmpdir(), "kifu-"));
    const store = new KifuFileStore(root);
    const tex: KifuTextureInfo[] = [
      { key: "gone", sources: ["https://x.site/images/gone.webp"], frames: {} },
    ];
    const r = await snapshotMatch(
      fakePage({}, tex, {}).page,
      store,
      meta({ baseURL: "https://x.site/" }),
      { textures: ["gone", "never"], fonts: [] },
      new KifuSnapshotCache(),
    );
    expect(r.snap.missing).toEqual([
      "texture:never 已經不在遊戲裡",
      "url:images/gone.webp HTTP 404",
      "texture:gone 有來源圖沒存到",
    ]);
    expect(JSON.parse(store.readTexture(r.snap.textures.gone!)!)).toMatchObject({
      sources: [null],
    });
  });
});
