/**
 * 播放器要的資料：逐步盤面＋那一場的貼圖快照＋當時的資料表
 * ======================================================
 * 托盤主程序（播放器視窗）與遊戲內復盤共用。圖檔給什麼網址由呼叫端決定（托盤給 file://，
 * 遊戲內給 data: 或 blob:），這裡只給 sha。
 */

import { countDeck } from "./counter.js";
import type { KifuTextureEntry } from "./format.js";
import { PUBLIC_DECKS, type PublicDeck } from "./public-decks.js";
import { mergePerspectives } from "./merge.js";
import { buildReplay, type Replay } from "./replay.js";
import type { KifuFileStore } from "./store.js";

export interface KifuViewerTexture {
  /** 來源圖（呼叫端換成網址；沒存到是 null） */
  sources: (string | null)[];
  frames: Record<string, number[]>;
  bitmapFont: unknown;
}

export interface KifuViewerData {
  file: string;
  replay: Replay;
  textures: Record<string, KifuViewerTexture>;
  /** 當時的資料表（立繪原點、狀態名稱、技能名） */
  tables: Record<string, unknown>;
  /** 字型（BradleyGratis）→ 網址 */
  fonts: Record<string, string>;
  /** 給人看的提醒（沒有快照、中途才錄…） */
  warnings: string[];
  /** 這個地點的公牌表（記牌用；沒有表的地點是 null） */
  deck: PublicDeck | null;
  /** 實際抽到的牌跟公牌表對得上（改版換牌時是 false，記牌不顯示） */
  deckOk: boolean;
}

/**
 * 同一場（roomHash 相同）、另一個座位的牌譜。檔名開頭是開始時間（到秒），兩邊開場只差幾秒，
 * 只讀前後一分鐘內的檔。
 */
function findCounterpart(
  store: KifuFileStore,
  file: string,
  roomHash: string | null,
  side: string | null,
): Replay | null {
  if (roomHash === null) return null;
  const stamp = (f: string) => {
    const m = /^(\d{8})-(\d{6})_/.exec(f);
    return m === null ? null : Number(`${m[1]}${m[2]}`);
  };
  const mine = stamp(file);
  if (mine === null) return null;
  for (const f of store.listFiles()) {
    const t = stamp(f);
    if (f === file || t === null || Math.abs(t - mine) > 100) continue;
    const rec = store.readKifu(f);
    const m = rec.start?.meta;
    if (m && m.roomHash === roomHash && m.side !== side) return buildReplay(m, rec.events);
  }
  return null;
}

/** 播放器要用的資料表。 */
export const VIEWER_TABLES = ["Characters", "State", "Feats", "CharaCards", "EventCards"] as const;

/**
 * @param file 一定要是 `store.listFiles()` 裡的檔名（呼叫端別讓畫面指定任意路徑）
 * @param urlOf blob 的 sha → 給播放器的網址；沒有這個 blob 回 null
 */
export function buildViewerData(
  store: KifuFileStore,
  file: string,
  urlOf: (sha: string) => string | null,
): KifuViewerData {
  if (!store.listFiles().includes(file)) throw new Error(`沒有這份牌譜：${file}`);
  const rec = store.readKifu(file);
  if (rec.start === null) throw new Error("這份牌譜沒有開場資料（托盤在戰鬥中途重開過）");
  const warnings: string[] = [];
  const meta = rec.start.meta;
  if (meta.partial) warnings.push(`第 ${meta.attachTurn ?? "?"} 回合才開始錄，前面沒有`);
  if (rec.gaps.length > 0) warnings.push(`中間缺了 ${rec.gaps.length} 批事件`);
  let replay = buildReplay(meta, rec.events);
  // 同一場對方座位的牌譜也在這台電腦上（自己的兩個帳號互打）：合併成雙視角
  const other = findCounterpart(store, file, meta.roomHash, meta.side);
  if (other !== null) {
    const m = mergePerspectives(replay, other);
    if (m.ok) {
      replay = m.replay;
      warnings.push(`已合併對方視角：對手當時蓋著的 ${m.filled} 張牌畫在上方（半透明）`);
    } else {
      warnings.push(`有對方視角的牌譜，但合併不起來（${m.reason}）`);
    }
  }

  const textures: Record<string, KifuViewerTexture> = {};
  const fonts: Record<string, string> = {};
  const url = (sha: string | null) => (sha === null ? null : urlOf(sha));
  if (rec.snap === null) {
    warnings.push("這場沒有版本快照（打完前托盤關了），畫面只有文字與色塊");
  } else {
    for (const [key, sha] of Object.entries(rec.snap.textures)) {
      const text = store.readTexture(sha);
      if (text === null) continue;
      const e = JSON.parse(text) as KifuTextureEntry;
      textures[key] = {
        sources: e.sources.map(url),
        frames: e.frames,
        bitmapFont: e.bitmapFont ?? null,
      };
    }
    for (const [name, sha] of Object.entries(rec.snap.fontFiles ?? {})) {
      const u = url(sha);
      if (u !== null) fonts[name.replace(/\.[^.]+$/, "")] = u;
    }
  }
  const tables: Record<string, unknown> = {};
  for (const name of VIEWER_TABLES) {
    const sha = rec.snap?.tables[name] ?? meta.tables[name] ?? null;
    const text = sha === null ? null : store.readTable(sha);
    if (text !== null) tables[name] = JSON.parse(text);
  }
  localizeSteps(replay, tables, meta.lang ?? "tcn");
  const stage = meta.stage;
  const deck = stage !== null ? (PUBLIC_DECKS[stage] ?? null) : null;
  const check = stage !== null ? countDeck(stage, replay.observed, [], 0, 0) : null;
  return { file, replay, textures, tables, fonts, warnings, deck, deckOk: check?.tableOk ?? false };
}

/**
 * 步驟文字裡的代號換成**當時版本**的名稱：技能（Feats 的 effect_image → name）、狀態
 * （State 的 *_clip 開頭「[中毒]」）、換角（第幾位 → 角色名）。表沒有的照舊顯示代號。
 */
export function localizeSteps(replay: Replay, tables: Record<string, unknown>, lang: string): void {
  const feats = Array.isArray(tables.Feats) ? (tables.Feats as Record<string, unknown>[]) : [];
  const featName = new Map<string, string>();
  for (const f of feats) {
    const name = f[`name_${lang}`];
    if (typeof name !== "string") continue;
    for (const k of [f.effect_image, f.texture])
      if (typeof k === "string" && !featName.has(k)) featName.set(k, name);
  }
  const state = (tables.State ?? {}) as Record<string, Record<string, unknown>>;
  const stateName = (key: string): string => {
    const base = key.replace(/_\d+$/, "");
    const clip = state[base]?.[`${lang}_clip`];
    const m = typeof clip === "string" ? /^\[([^\]]+)\]/.exec(clip) : null;
    const turns = /_(\d+)$/.exec(key);
    return m ? `${m[1]}${turns ? `（${turns[1]} 回合）` : ""}` : key;
  };
  const chars = (tables.Characters ?? {}) as Record<string, Record<string, unknown>>;
  for (const s of replay.steps) {
    if (s.kind === "skill") {
      s.text = s.text.replace(/(發動 |技能效果 )([A-Za-z0-9_]+)/, (all, p: string, key: string) => {
        const n = featName.get(key) ?? featName.get(key.replace(/_(player|opponent)$/, ""));
        return n ? `${p}${n}` : all;
      });
    } else if (s.kind === "state") {
      s.text = s.text.replace(/狀態 (\S+)$/, (_all, key: string) => `狀態 ${stateName(key)}`);
    } else if (s.kind === "change" && s.side !== null) {
      const main = s.state.sides[s.side].charas.find((c) => c?.main);
      const n = main?.chara ? chars[main.chara]?.[`name_${lang}`] : null;
      if (typeof n === "string") s.text = s.text.replace(/（第 \d+ 位）/, `（${n}）`);
    }
  }
}
