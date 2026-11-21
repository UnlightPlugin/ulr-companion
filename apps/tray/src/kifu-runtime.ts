/**
 * 牌譜（托盤這一半）
 * ==================
 * 錄製本身在引擎與頁面（`@ulr/arbiter-engine` 的 kifu-recorder、cdp-adapter 的 patch-kifu），
 * 這裡管：存在哪、托盤「戰鬥 › 牌譜」頁的清單、播放器視窗。
 *
 *     ~/.ulr-companion/battle/kifu/…jsonl       一場一份
 *     ~/.ulr-companion/battle/store/…           版本快照（資料表、美術），內容定址、跨場共用
 *
 * 放在家目錄而不是 APP_DIR：網頁版與桌面版各開一個托盤時兩個都寫這裡，同一個版本的美術
 * 只存一份。檔名帶 key（隨機）與座位，兩個托盤同時寫不會撞到同一個檔。
 *
 * ## 播放器拿到什麼
 *
 * 主程序把牌譜整理成逐步盤面（`buildReplay`），連同**那一場的**貼圖快照（來源圖的 file:// 網址
 * ＋切法）與當時的資料表一起交給播放器視窗。播放器（renderer/kifu/viewer.js）只畫圖，
 * 不讀檔、不碰遊戲。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";
import type { IpcMain } from "electron";
import {
  buildViewerData,
  KifuFileStore,
  PUBLIC_DECKS,
  type KifuRecord,
  type KifuViewerData,
} from "@ulr/kifu";
import type { CardCountOpponent } from "@ulr/cdp-adapter";
import type { TrayContext } from "./tray-context.js";

export const KIFU_ROOT = join(homedir(), ".ulr-companion", "battle");

let store: KifuFileStore | null = null;

export function kifuStore(): KifuFileStore {
  if (store === null) store = new KifuFileStore(KIFU_ROOT);
  return store;
}

// ── 清單 ─────────────────────────────────────────────────────────────────

export interface KifuListItem {
  file: string;
  startedAt: number;
  rule: string | null;
  stage: string | null;
  stageName: string | null;
  side: string | null;
  me: string | null;
  opponent: string | null;
  /** 打到第幾回合 */
  turns: number | null;
  /** 我方視角：win／lose／draw；沒打完是 null */
  result: string | null;
  partial: boolean;
  /** 有版本快照（能照當時的美術播） */
  snapshot: boolean;
  bytes: number;
  /** 對手的角色卡 id（開場 room_config；武器、事件卡是隱藏資訊） */
  opponentCharas: number[];
  /** 自己的角色卡 id */
  myCharas: number[];
  /**
   * 這一場的骰子實測（驗證骰率模型用，玩家 2026-11-08）：擲了幾顆、成功幾顆、
   * 「傷害＝攻擊成功數−防禦成功數」對得上幾次／比過幾次。
   */
  dice: { n: number; suc: number; gold: number; dmgOk: number; dmgN: number };
}

/** 檔名 → （大小＋修改時間, 摘要）。整理一份要讀整個檔，清單常常重開，記起來。 */
const summaries = new Map<string, { stamp: string; item: KifuListItem }>();

function summarize(file: string, rec: KifuRecord, bytes: number): KifuListItem {
  const meta = rec.start?.meta ?? null;
  const side = meta?.side ?? null;
  const oppSide = side === "A" ? "B" : side === "B" ? "A" : null;
  let turns: number | null = null;
  let result: string | null = null;
  const dice = { n: 0, suc: 0, gold: 0, dmgOk: 0, dmgN: 0 };
  // 擲完骰之後的第一則戰鬥傷害（damage_* 第 4 參數 true）拿來對「攻擊成功數−防禦成功數」
  let pending: number | null = null;
  for (const [, dir, name, args] of rec.events) {
    if (dir !== "in") continue;
    if (name === "turn_end" && typeof args[0] === "number") turns = args[0];
    if (name === "result") {
      const r = (args[0] as { result?: unknown } | null)?.result;
      result = typeof r === "string" ? r : null;
    }
    if (name === "diceroll") {
      const d = args[0] as {
        atkSuc?: unknown;
        defSuc?: unknown;
        atkArr?: unknown;
        defArr?: unknown;
      } | null;
      const all = [
        ...(Array.isArray(d?.atkArr) ? d.atkArr : []),
        ...(Array.isArray(d?.defArr) ? d.defArr : []),
      ];
      const plain = all.filter((x) => x !== 7);
      dice.gold += all.length - plain.length;
      if (
        typeof d?.atkSuc === "number" &&
        typeof d.defSuc === "number" &&
        all.length === plain.length
      ) {
        dice.n += plain.length;
        dice.suc += d.atkSuc + d.defSuc;
        pending = Math.max(0, d.atkSuc - d.defSuc);
      } else pending = null;
    }
    if (
      (name === "damage_player" || name === "damage_opponent") &&
      args[3] === true &&
      pending !== null
    ) {
      dice.dmgN++;
      if (args[0] === pending) dice.dmgOk++;
      pending = null;
    }
  }
  const ids = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  const own = meta?.ownDeck as { chara_card_id?: unknown } | null | undefined;
  return {
    file,
    startedAt: rec.start?.startedAt ?? 0,
    rule: meta?.rule ?? null,
    stage: meta?.stage ?? null,
    stageName: meta?.stage ? (PUBLIC_DECKS[meta.stage]?.name ?? null) : null,
    side,
    me: side ? (meta?.players[side]?.name ?? null) : null,
    opponent: oppSide ? (meta?.players[oppSide]?.name ?? null) : null,
    turns,
    result,
    partial: meta?.partial === true,
    snapshot: rec.snap !== null,
    bytes,
    opponentCharas: ids(meta?.opponentCharaIds),
    myCharas: ids(own?.chara_card_id),
    dice,
  };
}

/**
 * 對手紀錄：名字 → 幾勝幾敗、上一場用的角色卡（記牌面板開場時顯示，玩家 2026-11-08）。
 * 只算打完的對戰（有結果的）；任務、渦的對手是 NPC，不算。
 */
export function opponentHistory(items: readonly KifuListItem[]): Record<string, CardCountOpponent> {
  const out: Record<string, CardCountOpponent> = {};
  const sorted = [...items].sort((a, b) => a.startedAt - b.startedAt);
  for (const k of sorted) {
    if (k.opponent === null || k.result === null) continue;
    if (k.rule !== null && k.rule !== "duel" && k.rule !== "ranked") continue;
    const o = (out[k.opponent] ??= { win: 0, lose: 0, draw: 0, lastCharas: [] });
    if (k.result === "win") o.win++;
    else if (k.result === "lose") o.lose++;
    else o.draw++;
    if (k.opponentCharas.length > 0) o.lastCharas = k.opponentCharas;
  }
  return out;
}

let historyTimer: ReturnType<typeof setInterval> | null = null;
let historyPushed = "";

/** 每分鐘看一次牌譜清單，對手紀錄變了就推給引擎（清單有快取，沒新牌譜時不讀檔）。 */
export function startOpponentHistory(engine: {
  setOpponentHistory(h: Record<string, CardCountOpponent>): void;
}): void {
  const tick = (): void => {
    try {
      const h = opponentHistory(listKifu(1000));
      const key = JSON.stringify(h);
      if (key === historyPushed) return;
      historyPushed = key;
      engine.setOpponentHistory(h);
    } catch {
      // 讀不到就下一分鐘再試
    }
  };
  tick();
  if (historyTimer === null) historyTimer = setInterval(tick, 60_000);
}

export function listKifu(limit = 200): KifuListItem[] {
  const s = kifuStore();
  const out: KifuListItem[] = [];
  for (const file of s.listFiles().slice(0, limit)) {
    try {
      const st = statSync(join(s.kifuDir, file));
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = summaries.get(file);
      if (hit !== undefined && hit.stamp === stamp) {
        out.push(hit.item);
        continue;
      }
      const item = summarize(file, s.readKifu(file), st.size);
      summaries.set(file, { stamp, item });
      out.push(item);
    } catch {
      // 寫到一半、被刪掉 —— 跳過
    }
  }
  return out;
}

// ── 播放資料 ─────────────────────────────────────────────────────────────

/** 一份牌譜的播放資料。圖與字型給 file:// 網址。 */
export function openKifuData(file: string): KifuViewerData {
  const s = kifuStore();
  return buildViewerData(s, file, (sha) => {
    const p = s.blobPath(sha);
    return p === null ? null : pathToFileURL(p).href;
  });
}

// ── 播放器視窗 ───────────────────────────────────────────────────────────

let viewer: BrowserWindow | null = null;
let viewerFile: string | null = null;

/** 開播放器視窗（已經開著就換牌譜、拉到前面）。 */
export function openKifuViewer(file: string, preload: string, rendererDir: string): void {
  viewerFile = file;
  if (viewer !== null && !viewer.isDestroyed()) {
    viewer.webContents.send("ulr:kifu-file", file);
    if (viewer.isMinimized()) viewer.restore();
    viewer.focus();
    return;
  }
  viewer = new BrowserWindow({
    // 戰鬥畫布 760×680 ＋ 下面的控制列
    width: 1100,
    height: 790,
    minWidth: 780,
    minHeight: 600,
    title: "牌譜",
    autoHideMenuBar: true,
    backgroundColor: "#11131a",
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  viewer.on("closed", () => {
    viewer = null;
    viewerFile = null;
  });
  void viewer.loadFile(join(rendererDir, "kifu.html"));
}

const MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  avif: "image/avif",
  jpg: "image/jpeg",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** 遊戲裡播：圖與字型換成 data URL（遊戲頁面讀不到本機檔案） */
export function kifuDataInline(file: string): KifuViewerData {
  const s = kifuStore();
  return buildViewerData(s, file, (sha) => {
    const p = s.blobPath(sha);
    if (p === null) return null;
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    return `data:${MIME[ext] ?? "application/octet-stream"};base64,${readFileSync(p).toString("base64")}`;
  });
}

export function registerKifuPage(
  ipc: Pick<IpcMain, "handle">,
  ctx: TrayContext,
  open: (file: string) => void,
  rendererDir: string,
): void {
  ipc.handle("ulr:kifu-play-ingame", async (_e, file: unknown): Promise<string> => {
    if (typeof file !== "string") return "bad-file";
    const engine = ctx.engine;
    if (engine === null) return "not-connected";
    const source = readFileSync(join(rendererDir, "kifu", "viewer.js"), "utf8");
    const r = await engine.showKifuInGame(source, kifuDataInline(file));
    if (r === "in-battle") ctx.log("· 戰鬥中不開復盤畫面（會蓋住遊戲），打完再開");
    else if (r.startsWith("ok")) ctx.log("· 復盤畫面開在遊戲裡了（← → 換步、空白鍵播放、Esc 關）");
    else ctx.log(`✗ 遊戲裡的復盤畫面開不起來：${r}`);
    return r;
  });
  ipc.handle("ulr:kifu-list", () => listKifu());
  ipc.handle("ulr:kifu-play", (_e, file: unknown) => {
    if (typeof file !== "string") return false;
    open(file);
    return true;
  });
  ipc.handle("ulr:kifu-current", () => viewerFile);
  ipc.handle("ulr:kifu-data", (_e, file: unknown) => {
    if (typeof file !== "string") throw new Error("要給牌譜檔名");
    return openKifuData(file);
  });
  ipc.handle("ulr:kifu-record", async (_e, on: unknown) => {
    if (typeof on !== "boolean") return;
    ctx.patchProfile({ kifuRecord: on });
    await ctx.engine?.setKifuEnabled(on);
    ctx.log(on ? "· 牌譜錄製已開啟" : "· 牌譜錄製已關閉");
    ctx.pushState();
  });
  ipc.handle("ulr:card-counter", (_e, on: unknown) => {
    if (typeof on !== "boolean") return;
    ctx.patchProfile({ cardCounter: on });
    ctx.engine?.setCardCounter(on);
    ctx.log(on ? "· 記牌面板已開啟" : "· 記牌面板已關閉");
    ctx.pushState();
  });
}
