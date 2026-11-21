/**
 * 牌譜檔的格式
 * ============
 * 一場一個 `.jsonl`，一行一個物件，`t` 說是哪一種：
 *
 *     {"t":"start", key, startedAt, meta}          開場（頁面錄製器送的 meta 原樣）
 *     {"t":"ev", seq, ev:[[時間, 方向, 事件名, 參數], …]}   一批事件（約一秒一批）
 *     {"t":"end", endedAt, reason, textures, fonts, lastSeq}
 *     {"t":"snap", at, tables, textures, fonts, missing}    版本快照（戰鬥結束後補的）
 *
 * 用 jsonl 而不是一整份 JSON：戰鬥中每秒追加一行，托盤當掉、遊戲重載都只掉最後一秒，
 * 已經寫下去的不會因為檔尾沒收好而整份讀不回來。
 *
 * **版本快照是內容定址的**：`meta.tables` 與 `snap.textures` 裡全是 SHA-256，內容放在
 * 共用的 `store/` 底下。同一個版本的資料表、同一張立繪，不管錄了幾場都只存一份；
 * 改版之後內容變了雜湊就變，舊牌譜指著的還是舊的那份 —— 這就是「改版後還能照當時的版本、
 * 美術重播」的全部機制。
 *
 * 這支只有型別與純函式，瀏覽器裡的播放器也會 import。
 */

import type { KifuEndReport, KifuEvent, KifuMeta } from "@ulr/cdp-adapter";

export const KIFU_FILE_FORMAT = 1;

export interface KifuStartLine {
  t: "start";
  format: number;
  key: string;
  startedAt: number;
  meta: KifuMeta;
}

export interface KifuEventsLine {
  t: "ev";
  seq: number;
  ev: KifuEvent[];
}

export interface KifuEndLine extends Omit<KifuEndReport, "type" | "key"> {
  t: "end";
}

/**
 * 一張貼圖的快照：每個來源圖的雜湊＋每一格的切法（`KifuTextureInfo.frames` 原樣）。
 * 本身也以內容雜湊存成一個檔，`snap.textures` 指到它。
 */
export interface KifuTextureEntry {
  /** 來源圖的 SHA-256（拿不到的是 null） */
  sources: (string | null)[];
  /** 來源圖當時的路徑（相對美術根目錄；畫布轉的是 "canvas"）。只是給人看的。 */
  paths: (string | null)[];
  frames: Record<string, number[]>;
  /** 點陣字的字形資料（`KifuTextureInfo.bitmapFont` 原樣；不是點陣字就沒有） */
  bitmapFont?: unknown;
}

export interface KifuSnapLine {
  t: "snap";
  at: number;
  /** 資料表名 → 存好的 SHA-256 */
  tables: Record<string, string>;
  /** 貼圖 key → 貼圖快照（`KifuTextureEntry`）的 SHA-256 */
  textures: Record<string, string>;
  fonts: string[];
  /** 字型檔名（`BradleyGratis.otf`）→ SHA-256 */
  fontFiles: Record<string, string>;
  /** 沒存成的東西（`table:Feats`、`texture:cc017_s`、`url:…`）與原因 */
  missing: string[];
}

/** 開場那行遺失（例如托盤在戰鬥中途重開）時，第一行改寫這個。 */
export interface KifuOrphanLine {
  t: "orphan";
  key: string;
  at: number;
}

export type KifuLine = KifuStartLine | KifuEventsLine | KifuEndLine | KifuSnapLine | KifuOrphanLine;

/** 讀回一整份牌譜。壞掉的行（寫到一半）跳過。 */
export interface KifuRecord {
  key: string;
  start: KifuStartLine | null;
  events: KifuEvent[];
  end: KifuEndLine | null;
  snap: KifuSnapLine | null;
  /** 中間缺了哪幾批（seq 不連號） */
  gaps: number[];
}

export function parseKifuText(text: string, fallbackKey = ""): KifuRecord {
  const rec: KifuRecord = {
    key: fallbackKey,
    start: null,
    events: [],
    end: null,
    snap: null,
    gaps: [],
  };
  // ⚠ 同一批可能寫了兩次：兩個托盤（安裝版＋開發版）同時接著同一個遊戲時，頁面一次回報
  // 兩邊都收到（binding 同名），兩邊都往同一個檔（檔名由 key 決定）追加。照 seq 只留第一份，
  // 開場／結束也只留第一份 —— 2026-10-23 測試時兩個錄製程序同時接著，整場事件重複了一次。
  const bySeq = new Map<number, KifuEventsLine>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: KifuLine;
    try {
      o = JSON.parse(line) as KifuLine;
    } catch {
      continue;
    }
    switch (o.t) {
      case "start":
        if (rec.start === null) rec.start = o;
        rec.key = rec.start.key;
        break;
      case "orphan":
        if (rec.start === null) rec.key = o.key;
        break;
      case "ev":
        if (Array.isArray(o.ev) && typeof o.seq === "number" && !bySeq.has(o.seq))
          bySeq.set(o.seq, o);
        break;
      case "end":
        if (rec.end === null) rec.end = o;
        break;
      case "snap":
        rec.snap = o;
        break;
    }
  }
  const batches = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  let expect = 0;
  for (const b of batches) {
    for (let s = expect; s < b.seq; s++) rec.gaps.push(s);
    expect = Math.max(expect, b.seq + 1);
    rec.events.push(...b.ev);
  }
  return rec;
}

/** 牌譜檔名：`<開始時間>_<模式>_<座位>_<key>.jsonl`，照時間排就是照檔名排。 */
export function kifuFileName(
  key: string,
  startedAt: number,
  rule: string | null,
  side: string | null,
): string {
  const d = new Date(startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = (s: string | null) => (s ?? "x").replace(/[^A-Za-z0-9-]/g, "");
  return `${stamp}_${safe(rule)}_${safe(side)}_${safe(key)}.jsonl`;
}

/** 物件鍵排序後的 JSON —— 同樣內容一定得到同樣字串（算雜湊用）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** 美術網址去掉 session 專屬的網域 —— 官方的素材網域每次登入都換一個隨機的。 */
export function relativeAssetPath(url: string, baseURL: string | null): string | null {
  if (url.startsWith("data:")) return "canvas";
  if (baseURL !== null && url.startsWith(baseURL)) return url.slice(baseURL.length);
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}

/** 官方 Text 物件的畫布貼圖（key 是 UUID）不必存：重播時自己畫字。 */
export function isGeneratedTextureKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}
