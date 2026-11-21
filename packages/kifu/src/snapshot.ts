/**
 * 版本快照：戰鬥結束後把這場用到的資料表與美術補進共用區
 * ======================================================
 * 頁面錄製器只送雜湊與清單（戰鬥中不碰網路、不做重活），這裡在 `kifu-end` 之後才來要：
 *
 * 1. 資料表：`meta.tables` 裡共用區還沒有的 → 讀 JSON 原文、驗雜湊、存。
 * 2. 貼圖：戰鬥中畫過的 ∪ 官方 loader 清單 → 問 Phaser 每張的來源網址與切法
 *    → 來源圖逐一（從瀏覽器快取）算雜湊 → 共用區沒有的才讀內容回來存
 *    → 「來源雜湊＋切法」本身再算一次雜湊存成貼圖快照。
 *
 * 同一個版本第二場起幾乎全部命中，搬回 Node 的只有雜湊。
 *
 * ⚠ 美術網域每個 session 都不一樣（`playunlight-<亂碼>.site`），所以同一個 session 內
 * 用完整網址記快取，跨 session 靠內容雜湊去重 —— 不拿網址當版本的鍵。
 */

import type { KifuEndReport, KifuMeta, KifuTextureInfo, KifuUrlHash } from "@ulr/cdp-adapter";
import {
  canonicalJson,
  isGeneratedTextureKey,
  relativeAssetPath,
  type KifuSnapLine,
  type KifuTextureEntry,
} from "./format.js";
import { sha256Hex, type KifuStore } from "./store.js";

/** 快照要對頁面做的事（engine 用 adapter 實作，測試用假的）。 */
export interface KifuPage {
  readTable(name: string): Promise<string | null>;
  textureInfo(
    keys: readonly string[],
    usedFrames: Readonly<Record<string, readonly string[]>>,
  ): Promise<KifuTextureInfo[]>;
  hashUrls(urls: readonly string[]): Promise<KifuUrlHash[]>;
  readUrl(url: string): Promise<Uint8Array | null>;
  /** 遊戲從美術目錄載入的字型檔網址 */
  fontFiles(): Promise<string[]>;
}

/** 同一個 session 內記住的雜湊（網址 → sha）。換 session 網域就換了，自然失效。 */
export class KifuSnapshotCache {
  readonly urlSha = new Map<string, string>();
}

const HASH_BATCH = 16;
const TEXTURE_BATCH = 40;

const EXT_BY_TYPE: Record<string, string> = {
  "image/avif": "avif",
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/json": "json",
};

export function extOf(url: string, type: string | null): string {
  if (type !== null) {
    const base = type.split(";")[0]!.trim().toLowerCase();
    const e = EXT_BY_TYPE[base];
    if (e !== undefined) return e;
  }
  if (url.startsWith("data:image/png")) return "png";
  const m = /\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(url);
  return m === null ? "bin" : m[1]!.toLowerCase();
}

function decodeDataUrl(url: string): Uint8Array | null {
  const at = url.indexOf(",");
  if (!url.startsWith("data:") || at < 0) return null;
  const head = url.slice(5, at);
  const body = url.slice(at + 1);
  return head.endsWith(";base64")
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"));
}

export interface SnapshotResult {
  snap: KifuSnapLine;
  /** 這次新存進共用區的檔數（資料表＋圖＋貼圖快照） */
  added: number;
  /** 新搬回來的位元組數 */
  bytes: number;
}

export async function snapshotMatch(
  page: KifuPage,
  store: KifuStore,
  meta: KifuMeta,
  end: Pick<KifuEndReport, "textures" | "fonts"> & Partial<Pick<KifuEndReport, "frames">>,
  cache: KifuSnapshotCache,
): Promise<SnapshotResult> {
  const snap: KifuSnapLine = {
    t: "snap",
    at: Date.now(),
    tables: {},
    textures: {},
    fonts: [...end.fonts],
    fontFiles: {},
    missing: [],
  };
  let added = 0;
  let bytes = 0;

  // ── 1. 資料表 ──
  for (const [name, sha] of Object.entries(meta.tables)) {
    if (sha === null) {
      snap.missing.push(`table:${name} 開場時就沒有`);
      continue;
    }
    if (store.hasTable(sha)) {
      snap.tables[name] = sha;
      continue;
    }
    const text = await page.readTable(name);
    if (text === null) {
      snap.missing.push(`table:${name} 讀不到`);
      continue;
    }
    const actual = sha256Hex(text);
    store.putTable(actual, text);
    added++;
    bytes += text.length;
    snap.tables[name] = actual;
    // 開場到現在之間遊戲換了版本（極少）：存的是現在這份，記下來
    if (actual !== sha)
      snap.missing.push(`table:${name} 開場的版本已經不在（存了現在的 ${actual.slice(0, 8)}）`);
  }

  // ── 2. 貼圖 ──
  const keys = new Set<string>();
  for (const k of end.textures) if (!isGeneratedTextureKey(k)) keys.add(k);
  for (const a of meta.loader) keys.add(a.key);
  // 角色卡圖：戰鬥畫面上那張大卡是官方用畫布合成的（key 是 UUID，存不到），原圖在
  // CharaCardImages（巨型圖集，格名＝CharaCards.filename）。照雙方牌組的角色卡 id 指定那幾格。
  const usedFrames: Record<string, string[]> = { ...(end.frames ?? {}) };
  const ccSha = snap.tables.CharaCards;
  const ccText = ccSha === undefined ? null : store.readTable(ccSha);
  if (ccText !== null) {
    const ids = new Set<number>();
    const own = (meta.ownDeck as { chara_card_id?: unknown } | null)?.chara_card_id;
    for (const v of [...(Array.isArray(own) ? own : []), ...meta.opponentCharaIds]) {
      if (typeof v === "number") ids.add(v);
    }
    const names = (JSON.parse(ccText) as { id?: unknown; filename?: unknown }[])
      .filter((c) => typeof c.id === "number" && ids.has(c.id) && typeof c.filename === "string")
      .map((c) => c.filename as string);
    if (names.length > 0) {
      keys.add("CharaCardImages");
      usedFrames.CharaCardImages = [...new Set([...(usedFrames.CharaCardImages ?? []), ...names])];
    }
  }
  const keyList = [...keys].sort();

  const infos: KifuTextureInfo[] = [];
  for (let i = 0; i < keyList.length; i += TEXTURE_BATCH) {
    const batch = keyList.slice(i, i + TEXTURE_BATCH);
    const used: Record<string, string[]> = {};
    for (const k of batch) if (usedFrames[k] !== undefined) used[k] = usedFrames[k]!;
    infos.push(...(await page.textureInfo(batch, used)));
  }
  const seen = new Set(infos.map((t) => t.key));
  for (const k of keyList) if (!seen.has(k)) snap.missing.push(`texture:${k} 已經不在遊戲裡`);

  // 字型檔（數字用的 BradleyGratis）：跟圖一起雜湊、存
  const fontUrls = await page.fontFiles();

  // 來源網址 → sha
  const need: string[] = [];
  for (const t of infos) {
    for (const u of t.sources) {
      if (u === null || cache.urlSha.has(u) || need.includes(u)) continue;
      if (u.startsWith("data:")) {
        const b = decodeDataUrl(u);
        if (b === null) continue;
        const sha = sha256Hex(b);
        cache.urlSha.set(u, sha);
        if (!store.hasBlob(sha)) {
          store.putBlob(sha, extOf(u, null), b);
          added++;
          bytes += b.byteLength;
        }
        continue;
      }
      need.push(u);
    }
  }
  for (const u of fontUrls) if (!cache.urlSha.has(u) && !need.includes(u)) need.push(u);
  const types = new Map<string, string | null>();
  for (let i = 0; i < need.length; i += HASH_BATCH) {
    const hashes = await page.hashUrls(need.slice(i, i + HASH_BATCH));
    for (const h of hashes) {
      if (h.sha === null) {
        snap.missing.push(
          `url:${relativeAssetPath(h.url, meta.baseURL) ?? h.url} ${h.error ?? "讀不到"}`,
        );
        continue;
      }
      cache.urlSha.set(h.url, h.sha);
      types.set(h.url, h.type);
    }
  }
  for (const u of need) {
    const sha = cache.urlSha.get(u);
    if (sha === undefined || store.hasBlob(sha)) continue;
    const b = await page.readUrl(u);
    if (b === null) {
      snap.missing.push(`url:${relativeAssetPath(u, meta.baseURL) ?? u} 讀內容失敗`);
      continue;
    }
    const actual = sha256Hex(b);
    if (actual !== sha) cache.urlSha.set(u, actual);
    store.putBlob(actual, extOf(u, types.get(u) ?? null), b);
    added++;
    bytes += b.byteLength;
  }

  for (const u of fontUrls) {
    const sha = cache.urlSha.get(u);
    const name = u.split("/").pop()!.split(/[?#]/)[0]!;
    if (sha !== undefined && store.hasBlob(sha)) snap.fontFiles[name] = sha;
    else snap.missing.push(`font:${name}`);
  }

  // 貼圖快照
  for (const t of infos) {
    const entry: KifuTextureEntry = {
      sources: t.sources.map((u) => (u === null ? null : (cache.urlSha.get(u) ?? null))),
      paths: t.sources.map((u) => (u === null ? null : relativeAssetPath(u, meta.baseURL))),
      frames: t.frames,
      ...(t.bitmapFont !== undefined ? { bitmapFont: t.bitmapFont } : {}),
    };
    if (entry.sources.some((s) => s === null)) snap.missing.push(`texture:${t.key} 有來源圖沒存到`);
    const json = canonicalJson(entry);
    const sha = sha256Hex(json);
    if (!store.hasTexture(sha)) {
      store.putTexture(sha, json);
      added++;
    }
    snap.textures[t.key] = sha;
  }

  return { snap, added, bytes };
}
