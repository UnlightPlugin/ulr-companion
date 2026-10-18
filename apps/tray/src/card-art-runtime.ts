/**
 * 托盤的「模組 › 卡面替換」：玩家的卡面資料夾、內建空框與 MOD、卡名表（2026-10-18 從 main.ts
 * 整段搬出來，程式照原樣）。
 *
 * 進來的是 {@link initCardArtRuntime} 交進來的 `ctx`（engine／log／pushState，每次讀都是當下的）
 * 與遊戲狀態；`cardNames` 是即時綁定，main.ts 與 deck-runtime.ts 讀到的是當下的值。
 */
/**
 * 托盤程式（WP-15）
 * ===================
 * 一個托盤圖示管**一個**遊戲客戶端。要管兩個就開兩份 —— 設定頁的「配置」
 * 那一欄按「開新實例」，或沿用舊的命令列：
 *
 *     npm run tray                      開發時預設接 **Chrome**（見 `scripts/run-tray.mjs`）
 *     npm run tray -- --kind edge       第一份 Edge 的配置
 *     npm run tray -- --kind desktop    第一份桌面版的配置
 *     npm run tray -- --profile <id>    指定配置
 *     npm run tray -- --port 9334        客戶端用固定埠啟動時（不寫 DevToolsActivePort）開臨時配置
 *
 * ⚠ **兩份要能同時活著，而 Electron 預設會擋。** 兩個關卡：
 *
 * 1. `userData` 預設是同一個目錄，兩個實例會搶同一份 cache 與 LevelDB，
 *    症狀是第二個開起來畫面空白或直接退出。→ 依配置分開（`Profile.dataDir`）。
 * 2. `requestSingleInstanceLock()` 依 userData 分開，所以擋掉的只有「同一份
 *    配置開兩份」（見下面關卡 2 的說明）。
 *
 * ⚠ **配置清單不能放在 userData 底下**（它已經依配置分開了）。見 `profiles.ts`。
 *
 * UI 只做三件事：畫 `EngineStatus`、呼叫 `setPrefs()`、維護配置清單。
 * 所有仲裁規則都在 `@ulr/arbiter-engine` 裡，跟命令列跑的是同一份。
 */

import { mkdirSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineStatus } from "@ulr/arbiter-engine";
import type { CardArtStatus } from "@ulr/cdp-adapter";
import type { CardArtFile, CardArtScan, CardNames } from "./card-art.js";
import {
  CARD_ART_BLANKS_DIR,
  countBlanks,
  ensureCardArtDir,
  installBundledBlanks,
  installDefaultMods,
  readCardNames,
  scanCardArtDir,
} from "./card-art.js";
import { APP_DIR } from "./app-dir.js";
import type { TrayContext } from "./tray-context.js";
/** main.ts 交給卡面這段的東西（見 initCardArtRuntime）。 */
export interface CardArtDeps {
  ctx: TrayContext;
  /** 引擎最後一次回報的狀態；沒接著遊戲是 null。 */
  latest(): EngineStatus | null;
}

let deps: CardArtDeps;
let ctx: TrayContext;

/** main.ts 一開始叫一次，之後這裡的函式才能用。 */
export function initCardArtRuntime(d: CardArtDeps): void {
  deps = d;
  ctx = d.ctx;
}

// ---------------------------------------------------------------------------
// 模組 › 卡面替換
// ---------------------------------------------------------------------------

/**
 * 玩家的卡面放這裡。**不分實例**（跟記錄檔一樣放 `APP_DIR`）：卡面是玩家的
 * 美術，多開的兩份客戶端本來就該看到同一套。
 */
export const CARD_ART_DIR = join(APP_DIR, "mods", "cards");
/** 角色代號 → 中文名。第一次接上遊戲時讀的，之後離線也能對檔名。 */
const CARD_NAMES_PATH = join(APP_DIR, "mods", "card-names.json");

export let cardNames: CardNames | null = readCardNames(CARD_NAMES_PATH);
let cardArtScan: CardArtScan = { files: [], entries: [] };
let cardArtWatcher: FSWatcher | null = null;
let cardArtDebounce: ReturnType<typeof setTimeout> | null = null;
/** 接上遊戲後每隔幾秒試著讀名字表，讀到就停（標題畫面時 profile 還沒載）。 */
let cardNamesTimer: ReturnType<typeof setInterval> | null = null;

/** 重讀資料夾並推給引擎。`quiet` 時不寫 log（開機那一次、檔案監看的抖動）。 */
export function reloadCardArt(quiet = false): void {
  ensureCardArtDir(CARD_ART_DIR);
  cardArtScan = scanCardArtDir(CARD_ART_DIR, cardNames);
  ctx.engine?.setCardArt(cardArtScan.entries);
  if (!quiet || cardArtScan.files.length > 0) {
    const skipped = cardArtScan.files.length - cardArtScan.entries.length;
    ctx.log(
      `· 卡面替換：資料夾裡 ${cardArtScan.files.length} 張 PNG，送出 ${cardArtScan.entries.length} 張` +
        (skipped > 0 ? `（${skipped} 張對不到或不合規格，見 模組 › 卡面替換）` : ""),
    );
  }
}

/**
 * 盯著資料夾：玩家丟一張圖進去，一秒內就換上。
 *
 * ⚠ Windows 的 `fs.watch` 一次存檔會連發好幾個事件（建檔、寫入、改時間），
 * 而且寫到一半就會來 —— 所以等 800ms 沒新事件才重讀，讀到半張檔會被
 * `pngSize` 當成不是 PNG 而跳過，下一次事件再補。
 */
export function watchCardArtDir(): void {
  if (cardArtWatcher !== null) return;
  try {
    ensureCardArtDir(CARD_ART_DIR);
    cardArtWatcher = watch(CARD_ART_DIR, { persistent: false }, () => {
      if (cardArtDebounce !== null) clearTimeout(cardArtDebounce);
      cardArtDebounce = setTimeout(() => {
        cardArtDebounce = null;
        reloadCardArt();
        ctx.pushState();
      }, 800);
    });
    cardArtWatcher.on("error", () => {
      cardArtWatcher = null;
    });
  } catch {
    cardArtWatcher = null;
  }
}

/** 接上遊戲就去讀名字表；讀到之後名字有變的話重對一次檔名。 */
export function startCardNamesFetch(): void {
  if (cardNamesTimer !== null) return;
  const attempt = async (): Promise<void> => {
    if (ctx.engine === null || deps.latest()?.connected !== true) return;
    try {
      const fresh = await ctx.engine.readCardNames();
      stopCardNamesFetch();
      const changed = JSON.stringify(fresh) !== JSON.stringify(cardNames);
      cardNames = fresh;
      if (changed) {
        try {
          mkdirSync(dirname(CARD_NAMES_PATH), { recursive: true });
          writeFileSync(CARD_NAMES_PATH, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
        } catch {
          // 存不了只是下次開機沒有中文名可對，不是壞
        }
        if (cardArtScan.files.some((f) => f.frame === null)) reloadCardArt();
      }
    } catch {
      // 標題畫面 profile 還沒載；下一拍再試
    }
  };
  cardNamesTimer = setInterval(() => void attempt(), 10_000);
  void attempt();
}

export function stopCardNamesFetch(): void {
  if (cardNamesTimer !== null) clearInterval(cardNamesTimer);
  cardNamesTimer = null;
}

/** 卡面替換那一頁要畫的東西。 */
export interface CardArtPageState {
  dir: string;
  files: CardArtFile[];
  /** 送去頁面的張數。 */
  sent: number;
  /** 有沒有中文名可以對檔名。 */
  names: boolean;
  /** 空框資料夾裡每種尺寸各有幾張（`168x240` → 15）。 */
  blanks: Record<string, number>;
  /** 遊戲那端的狀態。沒接上是 null。 */
  status: CardArtStatus | null;
}

export const CARD_ART_BLANKS_PATH = join(CARD_ART_DIR, CARD_ART_BLANKS_DIR);

/**
 * 內建空框複製到玩家資料夾。開機一次、按「開空框資料夾」時再補一次
 * （玩家可能整個刪掉過）。build-tray.mjs 把 `apps/tray/assets` 搬到 `dist/assets`。
 */
export function installBlanks(): void {
  try {
    const r = installBundledBlanks(join(__dirname, "assets", "card-frames"), CARD_ART_BLANKS_PATH);
    if (r.bundled === 0) ctx.log("✗ 插件裡找不到內建的空框（assets/card-frames）");
    else if (r.written > 0)
      ctx.log(`· 卡面替換：空框放好 ${r.written} 張（${CARD_ART_BLANKS_PATH}）`);
  } catch (err) {
    ctx.log(`✗ 空框寫不進資料夾：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 內建的預設卡面 MOD 複製到玩家資料夾。開機一次；玩家刪掉的不補回來
 * （規則見 `installDefaultMods`）。要在第一次 `reloadCardArt` 之前跑。
 */
export function installCardMods(): void {
  try {
    const r = installDefaultMods(join(__dirname, "assets", "card-mods"), CARD_ART_DIR);
    if (r.bundled === 0) ctx.log("✗ 插件裡找不到內建的卡面 MOD（assets/card-mods）");
    else if (r.written > 0) ctx.log(`· 卡面替換：預設 MOD 放好 ${r.written} 張（${CARD_ART_DIR}）`);
  } catch (err) {
    ctx.log(`✗ 預設卡面 MOD 寫不進資料夾：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function cardArtPageState(): Promise<CardArtPageState> {
  return {
    dir: CARD_ART_DIR,
    files: cardArtScan.files,
    sent: cardArtScan.entries.length,
    names: cardNames !== null,
    blanks: countBlanks(CARD_ART_BLANKS_PATH),
    status: (await ctx.engine?.cardArtStatus().catch(() => null)) ?? null,
  };
}
