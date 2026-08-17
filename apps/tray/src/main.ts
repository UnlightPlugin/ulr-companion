/**
 * 托盤程式（WP-15）
 * ===================
 * 一個托盤圖示管**一個**遊戲客戶端。要管兩個就開兩份 —— 設定頁的「配置」
 * 那一欄按「開新實例」，或沿用舊的命令列：
 *
 *     npm run tray                      上次用的那份配置
 *     npm run tray -- --profile <id>    指定配置
 *     npm run tray -- --port 59222       相容用法：對得上就用那份，對不上開臨時的
 *
 * ⚠ **兩份要能同時活著，而 Electron 預設會擋。** 兩個關卡：
 *
 * 1. `userData` 預設是同一個目錄，兩個實例會搶同一份 cache 與 LevelDB，
 *    症狀是第二個開起來畫面空白或直接退出。→ 依埠分開。
 * 2. 一般 app 會用 `requestSingleInstanceLock()` 防止重複開啟。這裡**刻意
 *    不用** —— 雙開正是預期用法。要防的是「同一個埠開兩份」，而那由
 *    userData 目錄的鎖自然擋掉。
 *
 * ⚠ **配置清單不能放在 userData 底下**（它已經依埠分開了）。見 `profiles.ts`。
 *
 * UI 只做三件事：畫 `EngineStatus`、呼叫 `setPrefs()`、維護配置清單。
 * 所有仲裁規則都在 `@ulr/arbiter-engine` 裡，跟命令列跑的是同一份。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import type { EngineStatus } from "@ulr/arbiter-engine";
import { ArbiterEngine } from "@ulr/arbiter-engine";
import type { LinkPrefs } from "@ulr/arbiter-link";
import {
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
} from "@ulr/arbiter-link";
import {
  ARCADIA_STAGES,
  CHANNEL_NAMES,
  costTiersFor,
  DEBUG_PORT_SWITCH_AUTO,
  HIDDEN_STAGES,
  resolveDebugPort,
  STAGES,
} from "@ulr/cdp-adapter";
import type { HiddenStageStatus, MatchContext, RoomEntry } from "@ulr/cdp-adapter";
import { buildRoomName, checkOwnDeck, formatBand, MatchPairing } from "@ulr/arbiter-engine";
import type { PairingStatus } from "@ulr/arbiter-engine";
import { deckFromKeys } from "@ulr/cost-engine";
import type { CardCatalog, CompressionRule, CostRule, GapBand } from "@ulr/rule-schema";
import {
  assertCostRule,
  catalogSize,
  createRulePackage,
  loadRulePackage,
  parseEquipmentKey,
  parseEventCardKey,
  shortHash,
  toIndexTable,
} from "@ulr/rule-schema";
import { readCatalog, writeCatalog } from "./catalog-store.js";
import { trayIconPng } from "./icon.js";
import type { IconState } from "./icon.js";
import { launchAtLoginEnabled, launchInstance, setLaunchAtLogin } from "./launch.js";
import { openLogFile } from "./log-file.js";
import type { ClientKind, MatchPrefs, Profile, ProfileStore } from "./profiles.js";
import {
  addProfile,
  defaultPortFor,
  EDIT_STEPS,
  EDIT_UNITS,
  loadStore,
  markUsed,
  normalizeEditStep,
  normalizeEditUnit,
  normalizeMatchPrefs,
  removeProfile,
  resolveProfile,
  updateOptions,
  updateProfile,
  userDataDirFor,
} from "./profiles.js";
import { consumeUpdatedFlag, startAutoUpdate } from "./updater.js";

/**
 * 版本號。**建置時烤進去的**（`scripts/build-tray.mjs` 的 `define`）。
 *
 * ⚠ 不要換成 `app.getVersion()` —— 開發時它回的是 Electron 的版本，
 * 不是我們的。詳見那支的註解。
 */
declare const __ULR_VERSION__: string;
const VERSION = __ULR_VERSION__;

let store: ProfileStore = {
  profiles: [],
  lastUsedId: null,
  launchAtLogin: false,
  startMinimized: false,
  multiProfile: false,
};
let profile: Profile;
/** 這份配置是命令列臨時建的，不在清單裡 —— 改它不落地。 */
let ephemeral = false;

/**
 * 插件自己的資料夾。**記錄檔就直接放在這裡**：
 *
 *     %APPDATA%\ulr-companion\companion.log
 *
 * ⚠ 以前是 `ulr-companion\port-59222\companion.log`。那一層是給多開用的，
 * 但代價落在**所有人**身上：請玩家貼記錄時得先教他那個資料夾叫什麼，而那個
 * 名字裡還有一個他從來沒設過的數字（現在大家都用 `--remote-debugging-port=0`，
 * 那個埠更是連聽都沒人在聽）。一句「打開 %APPDATA%\ulr-companion」就該結束的事，
 * 不值得多一層。
 */
const APP_DIR = join(app.getPath("appData"), "ulr-companion");

// ⚠ 關卡 1：兩份實例不能共用 userData（Windows 的目錄鎖會擋掉第二份）。
// 必須在 app ready 之前設，而且要在讀完配置之後 —— 埠是從配置來的。
{
  // `loadStore()` 會用到 app.getPath，那在 ready 之前就可以呼叫。
  store = loadStore();
  const resolved = resolveProfile(store, process.argv);
  profile = resolved.profile;
  ephemeral = resolved.ephemeral;
  app.setPath("userData", join(APP_DIR, `port-${profile.port}`));
}

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let engine: ArbiterEngine | null = null;
let latest: EngineStatus | null = null;
const logLines: string[] = [];

/**
 * 記錄同時寫進檔案。
 *
 * ⚠ 記憶體那份（`logLines`）上限 200 行、關掉就沒 —— 出事時**查不到任何東西**。
 * 自動更新是靜默的、側通道是背景連的，真的被冒充或大規模斷線時，這份檔案是
 * 唯一能回答「什麼時候開始的」的東西。內容限制見 `log-file.ts`。
 *
 * ⚠ **放 `APP_DIR` 而不是 `userData`**，也就是不分實例。多開時兩份會寫進同一個
 * 檔案 —— 那是刻意的：每一行都有時間戳，而**出事時要看的正是兩份的交錯**
 * （例如兩邊同時斷線）。分成兩個檔案反而要人自己對時間軸。
 * 寫入是 `appendFileSync`（O_APPEND），兩個行程各自 append 不會互相截斷。
 */
const logFile = openLogFile(APP_DIR);

function log(line: string): void {
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  logFile.write(line);
}

/**
 * 每個遊戲埠上有沒有一個開著 debug port 的客戶端在回話。
 *
 * ⚠ **這是配置表唯一能對「別份配置」說的話。** 一個托盤實例只綁一個埠，引擎
 * 也只看自己那一個 —— 它沒有任何辦法知道另一份配置的插件狀態（那是另一個
 * process，甚至可能根本沒開）。但「那個埠上有沒有遊戲」是問得到的：CDP 的
 * `/json/version` 就是拿來回答這件事的。
 *
 * 所以表格裡自己那一列顯示引擎的真實狀態，其他列只敢說「遊戲開著／沒有回應」。
 * 混成同一句話會讓玩家以為插件已經在管另一個客戶端了。
 */
const gamePorts = new Map<number, boolean>();
let probeTimer: ReturnType<typeof setInterval> | null = null;

/** 探測間隔。玩家盯著設定頁看的時候要夠即時，但這是每 N 秒的 HTTP 請求。 */
const PROBE_INTERVAL_MS = 4_000;
/** 單次探測的上限。埠沒人聽的話 loopback 會立刻 ECONNREFUSED，這是防它掛住。 */
const PROBE_TIMEOUT_MS = 800;

const probeFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

/**
 * 把每一份配置的遊戲埠敲一遍。
 *
 * ⚠ **只在設定視窗看得見的時候做。** 托盤程式大部分時間是背景常駐的，
 * 沒人在看的時候每四秒發三個 HTTP 請求是純粹的浪費（而且會出現在防火牆與
 * 資源監視器上，看起來像插件在偷偷做什麼）。
 */
async function probeGamePorts(): Promise<void> {
  if (window === null || !window.isVisible()) return;
  const seen = await Promise.all(
    store.profiles.map(async (p): Promise<readonly [number, boolean]> => {
      // ⚠ 走 `resolveDebugPort` 而不是直接敲設定裡那個埠：客戶端可能挑到別的埠
      // （首選被 Windows 保留時就會這樣）。只敲設定值的話，表格會說「沒有回應」，
      // 而玩家的遊戲明明開著 —— 那正是這一輪要修掉的誤導。
      // 回退範圍限定在這份配置自己的 user-data-dir，不會抓到另一種客戶端。
      const live = await resolveDebugPort({
        port: p.port,
        userDataDir: userDataDirFor(p.kind),
        fetchImpl: probeFetch,
      });
      return [p.port, live !== null];
    }),
  );
  gamePorts.clear();
  for (const [port, alive] of seen) gamePorts.set(port, alive);
  pushState();
}

/**
 * 托盤圖示的顏色語意見 `icon.ts`：綠色只留給「兩邊真的講好了」。
 *
 * ⚠ **打任務／渦時不能是綠的。** 那時功能整組不生效（對手是 NPC），
 * 而綠色的意思是「保護生效中」—— 讓它在那裡亮著，圖示就是在說謊。
 */
function iconState(status: EngineStatus | null): IconState {
  if (status === null || !status.connected) return "idle";
  return status.link === "paired" && status.pvp ? "paired" : "solo";
}

/**
 * 非對戰模式的一句話。`null` = 現在是對戰、還沒進去，或認不出這個模式。
 *
 * ⚠ 認不出來時**不要瞎編一句**。遊戲改版多一種模式時，這裡回 null 會讓 UI
 * 退回原本那句「還沒握手」，那雖然不精確但不會誤導；硬掰成「對手是 NPC」
 * 則可能剛好講反。真正的判斷在 `status.pvp`，這個函式只負責措辭。
 */
function npcNote(status: EngineStatus | null): string | null {
  if (status === null || !status.connected || status.pvp || status.rule === null) return null;
  const names: Record<string, string | undefined> = { quest: "任務", raid: "渦", event: "活動" };
  const name = names[status.rule];
  return name === undefined ? null : `${name}中 —— 對手是 NPC，不生效`;
}

/**
 * 視窗標題與提示的開頭。
 *
 * ⚠ **只有多開打開時才寫配置名與埠。** 那兩個東西存在的唯一理由是「兩份實例
 * 同時開著時分得出誰是誰」；只有一份的時候，它們對玩家而言是兩個看不懂的數字。
 */
function heading(): string {
  // ⚠ **不寫埠。** 玩家一律用 `--remote-debugging-port=0`，設定裡那個數字只是
  // 實例身分，沒有人在聽它 —— 掛在標題上只會被當成「我該去設定什麼」。
  // 名字也只在多開時才有意義（只有一份的時候那是他沒取過的名字）。
  return store.multiProfile ? `ULR Companion — ${profile.name}` : "ULR Companion";
}

function tooltip(status: EngineStatus | null): string {
  const head = heading();
  if (status === null) return head;
  const parts = [head];
  parts.push(
    status.connected ? `已接上${status.seat === null ? "" : `（座位 ${status.seat}）`}` : "等遊戲…",
  );
  const npc = npcNote(status);
  parts.push(
    npc !== null
      ? npc
      : status.link === "paired" && status.pvp
        ? `已配對  階段 ${status.capSeconds ?? MOVE_PHASE_TOTAL_SECONDS}s`
        : "還沒握手（準備與秒數都不生效）",
  );
  return parts.join("\n");
}

function refreshTray(): void {
  if (tray === null) return;
  tray.setImage(nativeImage.createFromBuffer(trayIconPng(iconState(latest))));
  tray.setToolTip(tooltip(latest));
  tray.setContextMenu(buildMenu());
}

function buildMenu(): Menu {
  const prefs = engine?.prefs;
  const others = store.profiles.filter((p) => p.id !== profile.id);
  const items: MenuItemConstructorOptions[] = [
    {
      // 只有一份實例時，「配置名 + 兩個埠」對玩家沒有意義 —— 換成他真正在等的
      // 那件事：插件到底接上遊戲了沒。
      label: store.multiProfile
        ? `${profile.name}  ${latest?.connected === true ? "已接上遊戲" : "等遊戲…"}`
        : latest?.connected === true
          ? "已接上遊戲"
          : "等遊戲…",
      enabled: false,
    },
    {
      // ⚠ 三種狀態要分得出來，混成一句話玩家就只會看到「沒反應」：
      //   打任務／渦   對手是 NPC，功能本來就不該生效
      //   對戰但沒握手 對手沒插件（或中間人連不上）
      //   已握手       真的在管
      label:
        npcNote(latest) ??
        (latest?.link === "paired" && latest.pvp === true
          ? `已配到對手  共同階段 ${latest.capSeconds ?? MOVE_PHASE_TOTAL_SECONDS} 秒`
          : "還沒握手到對手（準備與秒數都不生效）"),
      enabled: false,
    },
    { type: "separator" },
    { label: "設定…", click: () => showWindow() },
    {
      label: "準備功能",
      type: "checkbox",
      checked: prefs?.readyEnabled === true,
      click: (item) => applyPrefs({ readyEnabled: item.checked }),
    },
  ];

  // ⚠ 多開沒打開就**整段不出現**。留一個灰掉的「開新實例」只會讓沒聽過多開的
  // 玩家停下來想「我是不是漏了什麼」——那正是這次要拿掉的東西。
  if (store.multiProfile) {
    items.push(
      { type: "separator" },
      {
        label: "開新實例",
        // 只剩自己這一份時就沒有別的可開了 —— 引導玩家去設定頁新增。
        submenu:
          others.length === 0
            ? [{ label: "（沒有其他配置，去設定 › 配置新增）", enabled: false }]
            : others.map((p) => ({
                label: `${p.name}  :${p.port}`,
                click: () => launchInstance(p.id),
              })),
      },
    );
  }

  items.push({ type: "separator" }, { label: "結束", click: () => void quit() });
  return Menu.buildFromTemplate(items);
}

function applyPrefs(next: Partial<LinkPrefs>): void {
  engine?.setPrefs(next);
  const prefs = engine?.prefs;
  if (prefs !== undefined) {
    profile = { ...profile, prefs };
    // 臨時配置不落地：它本來就不在清單裡，寫回去會憑空生出一份。
    if (!ephemeral) store = updateProfile(profile.id, { prefs });
  }
  pushState();
  refreshTray();
}

function pushState(): void {
  window?.webContents.send("ulr:state", snapshot());
}

interface Snapshot {
  profile: Profile;
  ephemeral: boolean;
  store: ProfileStore;
  status: EngineStatus | null;
  log: string[];
  version: string;
  packaged: boolean;
  launchAtLogin: boolean;
  /** 記錄檔在哪。回報問題時要請玩家附上它。 */
  logPath: string;
  /**
   * 要玩家填進 Steam 啟動選項的那一行。
   *
   * ⚠ 放進快照而不是寫死在 HTML 裡：畫面上顯示的字與「複製」按鈕放進剪貼簿的字
   * **必須是同一個來源**。兩邊各寫一份的話，改了一邊沒改另一邊，玩家會複製到一個
   * 跟螢幕上不一樣的東西 —— 而那是他最不可能懷疑的地方。
   */
  debugFlag: string;
  /** 遊戲埠 → 那個埠上有沒有客戶端在回話。見 `gamePorts` 的註解。 */
  gamePorts: Record<number, boolean>;
  /** 目前載入的 COST 規則摘要。`null` = 沒選。 */
  costRule: (CostRuleInfo & { fileName: string }) | null;
  /**
   * 上一次載入規則失敗的原因。`null` = 沒失敗過。
   *
   * ⚠ **這個欄位不能省。** 載入失敗時 `costRule` 是 `null`，而畫面對
   * `null` 的說法是「還沒選規則」—— 跟「選了但被拒絕」長得一模一樣。
   * 2026-08-15 玩家選了一份 Hash 對不上的規則包，畫面完全沒有變化，
   * 回報是「選了沒反應」：錯誤只寫進了記錄，而記錄在另一頁。
   */
  costRuleError: CostRuleFailure | null;
  limits: { minSeconds: number; maxSeconds: number; minSpeed: number; maxSpeed: number };
}

// ---------------------------------------------------------------------------
// 配對頁的狀態
//
// ⚠ 這一份**不放進 `Snapshot`**。Snapshot 是每次狀態變動就整份推給畫面的，
// 而配對狀態要跟遊戲要（兩次 CDP 往返），塞進去等於每個無關的變動都去戳一次
// 遊戲。配對頁自己在開著的時候輪詢。
// ---------------------------------------------------------------------------

interface MatchRuleInfo {
  name: string;
  version: string;
  /** 跟對手核對的 8 碼。`null` = 裸 COST 表，沒有可核對的碼。 */
  shortHash: string | null;
  entries: number;
  /**
   * 規則族（`publisherSlug/ruleSlug`）。
   *
   * ⚠ **配對是照這個分的，不是照 shortHash。** 同一個 ruleSetId 的不同版本
   * 會排在同一條佇列，能不能開打由語義驗算決定 —— UI 要講出這件事，否則
   * 玩家會以為「核對碼不一樣就是配不到」。
   */
  ruleSetId: string;
}

/** 我這副牌在自訂規則下算起來多少。⚠ 跟伺服器算的原版 COST 是兩個數字。 */
interface MyDeckCost {
  /** 自訂規則算的總和，兩位小數字串。讀不到牌組時是 `null`。 */
  total: string | null;
  /** 規則裡沒定價、被當成 99 的卡數。不是 0 就要顯示警告。 */
  unknown: number;
  /**
   * 這副牌在**目前約定的那一檔**裡嗎。沒設檔位、或讀不到牌組時是 `null`。
   *
   * ⚠ 這是「按下去之前就看得到」的那一格。少了它，玩家只能按了開始才知道
   * 自己這副牌不合檔 —— 而那是一個要回遊戲改牌組、再回來按一次的來回。
   */
  fit: "ok" | "over" | "under" | null;
}

interface MatchPageState {
  connected: boolean;
  context: MatchContext | null;
  rooms: RoomEntry[];
  /** 房間清單的推播序號。0 = 一筆都還沒收到。 */
  seq: number;
  rule: MatchRuleInfo | null;
  /** 用自訂規則算的自己牌組總和。沒選規則時是 `null`。 */
  myCost: MyDeckCost | null;
  /**
   * 目前頻道的官方 COST 階層，**已經處理過 duel 借 ranked 的那層**
   * （見 `@ulr/cdp-adapter` 的 `costTiersFor`）。沒進頻道是 `null`。
   *
   * ⚠ 只是**快速選單**。自訂 COST 配對仍然可以填任何數字 —— 這幾個值只是
   * 「平常對戰最常約的那幾檔」，省得每次自己打。
   *
   * ⚠ **每週二遊戲更新會變**，所以一律現讀，不快取也不寫進設定檔。
   */
  costTiers: number[] | null;
  /** 自動配對的狀態。沒在配對時 phase 是 `idle`。 */
  pairing: PairingStatus;
  /**
   * 玩家記在配置裡的配對設定（地點抽法、約定檔位）。
   *
   * ⚠ 畫面**從這裡取初始值**，不要自己留一份預設 —— 兩份預設一定會漂，
   * 而漂掉的症狀是「我明明改過設定，重開又變回去」。
   */
  match: MatchPrefs;
  /**
   * 配到人時會開出來的房名，**主程序組好的**。沒選規則時是 `null`。
   *
   * ⚠ 畫面**不准自己組一份**。房名同時是 host 在清單裡認出自己那間房的依據
   * （`findOwnRoom` 拿它比對），畫面組的跟開房用的漂掉一個字，症狀是
   * 「開好房卻找不到自己那間」—— 而那看起來完全像是遊戲那邊的問題。
   */
  roomName: string | null;
  /** 目前約定的那一檔收多少（`56.01～57.00`）。沒設檔位是 `null`。 */
  band: string | null;
  /** 頻道編號 → 顯示名稱。遊戲的 `channels` 物件裡沒有名稱。 */
  channelNames: Readonly<Record<number, string>>;
  /**
   * 官方的對戰地點清單、官方選單沒有的那四張、亞城池。
   *
   * ⚠ `stages` 與 `hiddenStages` 現在**只給「這一場抽到哪」那一行查名字**
   * （`stageLabel`），不再是一個下拉選單 —— 玩家選不到地圖了。
   *
   * ⚠ 遊戲的 `COST_RANGES`（±0～±5）**不在這裡**：插件開房永遠不設那一格
   * （`@ulr/arbiter-engine` 的 `ROOM_DECK_COST_BAND`），畫面上沒有東西要列它。
   */
  statics: {
    stages: readonly { value: string; name: string }[];
    hiddenStages: readonly { value: string; name: string }[];
    /** 「亞城隨機」會抽到的那幾張。畫面拿它講清楚池子有多大、含哪幾張。 */
    arcadiaStages: readonly string[];
  };
}

/**
 * `ulr:match-prefs` 回的東西。
 *
 * ⚠ 房名與檔位區間**跟著一起回**，因為它們是從 `match` 算出來的，而畫面必須
 * 在玩家改完的當下就看到新的值。算它們的地方仍然只有主程序（見那支 handler）。
 */
interface MatchPrefsResult {
  match: MatchPrefs;
  roomName: string | null;
  band: string | null;
}

/** 從客戶端抄回來的官方設定。畫面不自己編一份，避免兩邊對不上。 */
const MATCH_STATICS: MatchPageState["statics"] = {
  stages: STAGES,
  hiddenStages: HIDDEN_STAGES,
  arcadiaStages: ARCADIA_STAGES,
};

// ---------------------------------------------------------------------------
// 隱藏地圖那一頁的狀態
//
// ⚠ 跟配對頁一樣**不放進 `Snapshot`**：`status` 要跟遊戲要（一次 CDP 往返），
// 塞進去等於每個無關的狀態變動都去戳一次遊戲。
// ---------------------------------------------------------------------------

interface StagePageState {
  /** 玩家的選擇（配置裡記著的）。 */
  enabled: boolean;
  /** 要加的那四張。畫面不自己編一份，避免兩邊對不上。 */
  stages: readonly { value: string; name: string }[];
  /**
   * 遊戲那端的實際狀態。沒接上遊戲是 `null`。
   *
   * ⚠ 跟 `enabled` **是兩回事**，UI 一定要分開講：`enabled` 是「玩家想不想要」，
   * 這個才是「遊戲那邊真的怎樣」。遊戲還沒開、還沒進大廳、剛重載完都會讓兩者
   * 不一致，而那些全都是正常狀態。
   */
  status: HiddenStageStatus | null;
}

async function stageStatus(): Promise<HiddenStageStatus | null> {
  return (await engine?.hiddenStageStatus().catch(() => null)) ?? null;
}

/**
 * 「開始自動配對」帶的東西。
 *
 * ⚠ `channel` 與**設定裡的約定檔位**進配對鍵（`matchKey`），也就是說：兩邊填得
 * 不一樣就物理上配不到對方。3vs3 那一格也在鍵裡，但它現在是**固定值**
 * （`@ulr/arbiter-engine` 的 `ROOM_MULTI`），沒有人填得到。地點不進 —— 它是配對
 * 成立**之後**才協商的（`negotiateStage`）。房名也不進，那是系統照規則與檔位
 * 組出來的。
 *
 * ⚠ 開房要用的那幾格（地點抽法、約定檔位）**不從這裡送** —— 它們記在配置裡
 * （`profile.match`），主程序自己讀。畫面送過來的話會有兩份真相，而
 * 「我改了設定但開出來的是舊的」這種 bug 完全看不出來。
 */
interface MatchQueueOptions {
  channel: number;
}

function matchRuleInfo(): MatchRuleInfo | null {
  if (costRule === null) return null;
  return {
    name: costRule.name,
    version: costRule.version,
    shortHash: costRule.shortHash,
    entries: costRule.entries,
    ruleSetId: costRule.ruleSetId,
  };
}

/**
 * 自動配對。**同時只會有一個** —— 一個托盤視窗管一個遊戲客戶端，
 * 而一個客戶端同時只能排一條隊。
 */
let pairing: MatchPairing | null = null;
let pairingStatus: PairingStatus = {
  phase: "idle",
  linked: false,
  waiting: 0,
  role: null,
  compatibility: null,
  myTotal: null,
  overLimit: false,
  underLimit: false,
  band: null,
  skipped: 0,
  stage: null,
  message: "沒在配對。",
};

/**
 * 我這副牌用**自訂規則**算起來多少。
 *
 * ⚠ 這跟 `context.deckCost`（伺服器算的原版 COST）是**兩個不同的數字**，
 * 畫面上一定要並排標明白。約戰約定的上限是用這一個判的，遊戲自己的
 * 「牌組Cost限制 ±N」是用另一個判的 —— 混在一起看會做出完全錯誤的決定。
 */
function myDeckCost(context: MatchContext | null): MyDeckCost | null {
  if (costRuleFull === null) return null;
  const keys = context?.deckKeys ?? null;
  if (keys === null) return { total: null, unknown: 0, fit: null };
  const deck = deckFromKeys(keys);
  if (deck.characters.length === 0) return { total: null, unknown: 0, fit: null };
  // ⚠ 算兩次是刻意的：`total` 要的是「這副牌多少 C」（跟檔位無關，沒設檔位時
  // 也要顯示），`fit` 要的是「在不在這一檔」。把上限塞進第一次呼叫的話，沒設
  // 檔位的人就拿不到總和了。
  const check = checkOwnDeck(costRuleFull, deck, null);
  const limit = profile.match.limitOn ? profile.match.limit : null;
  const banded = limit === null ? null : checkOwnDeck(costRuleFull, deck, limit);
  return {
    total: check.total,
    unknown: check.unknown.length,
    fit: banded === null ? null : banded.over ? "over" : banded.under ? "under" : "ok",
  };
}

function snapshot(): Snapshot {
  return {
    profile:
      engine === null ? profile : { ...profile, prefs: engine.prefs, readyTint: engine.readyTint },
    ephemeral,
    store,
    status: latest,
    log: logLines.slice(-40),
    version: VERSION,
    packaged: app.isPackaged,
    launchAtLogin: launchAtLoginEnabled(),
    logPath: logFile.path,
    debugFlag: DEBUG_PORT_SWITCH_AUTO,
    gamePorts: Object.fromEntries(gamePorts),
    costRule: costRule === null ? null : { ...costRule, fileName: basename(costRule.path) },
    costRuleError: costRuleError,
    limits: {
      minSeconds: MIN_PHASE_SECONDS,
      maxSeconds: MOVE_PHASE_TOTAL_SECONDS,
      minSpeed: MIN_SPEED_FACTOR,
      maxSpeed: MAX_SPEED_FACTOR,
    },
  };
}

/**
 * 設定視窗。
 *
 * ⚠ **關掉是收起來，不是結束程式。** 托盤程式關掉視窗還要繼續在背景管仲裁 ——
 * 真的結束只有選單裡那一個入口，否則玩家會在不知情的狀況下失去保護。
 */
function showWindow(): void {
  if (window !== null) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    // 遊戲畫布是 760×680，這裡刻意對齊那個比例 —— 兩個視窗並排時看起來
    // 才像同一套東西，而不是「遊戲旁邊掛了一個工具」。
    width: 760,
    height: 640,
    minWidth: 680,
    minHeight: 560,
    show: false,
    // 兩份實例同時開著時，標題是唯一分得出誰是誰的東西 —— 所以只有多開時才寫。
    title: heading(),
    autoHideMenuBar: true,
    backgroundColor: "#12151f",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // §12：渲染層拿不到 Node，也拿不到跨來源的東西。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // ⚠⚠ **這個視窗只能顯示我們自己那一個檔案，不准去任何別的地方。**
  //
  // 它的內容是寫死的本機 HTML，所以正常情況下**永遠不會**有導覽或開新視窗 ——
  // 也就是說，這兩個處理器一旦真的被觸發，那本身就代表出事了（渲染層被塞了
  // 東西）。擋在這裡的代價是零，不擋的代價是那段東西可以把整個視窗換成
  // 一個遠端頁面，而玩家看到的還是同一個標題列。
  //
  // 外部連結有專門的入口（`ulr:open-external`，主程序那端有白名單）。
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // 附掛 webview 這個 app 從來不需要，直接關掉整個攻擊面。
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  // ⚠ 頁面的 <title> 會蓋掉 BrowserWindow 的標題。擋掉它 —— 兩份實例同時開著
  // 時，工作列上的標題是唯一分得出「這個視窗管哪個客戶端」的東西。
  window.on("page-title-updated", (event) => event.preventDefault());
  window.on("close", (event) => {
    // 使用者按 X：收起來就好。真的要結束時 quitting 已經是 true。
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on("closed", () => {
    window = null;
  });
  void window.loadFile(join(__dirname, "renderer", "index.html"));
  window.once("ready-to-show", () => {
    positionNearTray();
    window?.show();
    pushState();
    // 立刻探一次 —— 不要讓玩家對著「檢查中…」乾等一個間隔。
    void probeGamePorts();
  });
  // 從托盤再叫出來時同理。
  window.on("show", () => void probeGamePorts());
}

/** 開在滑鼠附近，不要跳到主螢幕正中央 —— 雙開時那會蓋住另一個。 */
function positionNearTray(): void {
  if (window === null) return;
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const size = window.getSize();
  const w = size[0] ?? 760;
  const h = size[1] ?? 640;
  window.setPosition(
    Math.round(Math.min(Math.max(area.x, cursor.x - w / 2), area.x + area.width - w)),
    Math.round(Math.max(area.y, Math.min(cursor.y - h, area.y + area.height - h))),
  );
}

let quitting = false;
async function quit(): Promise<void> {
  quitting = true;
  if (probeTimer !== null) clearInterval(probeTimer);
  probeTimer = null;
  // ⚠ 排隊中就關掉插件的話，要先把自己從佇列上拿掉、順手收掉開了一半的房 ——
  // 否則對手會一直等一間永遠不會出現的房，而玩家的頻道上留一間空房。
  await pairing?.stop().catch(() => {});
  pairing = null;
  // ⚠ 一定要等引擎收乾淨：它會把頁面上的攔截拆掉。留著孤兒的話遊戲裡的
  // OK 鈕會有 3 秒（心跳）處在沒人管的狀態。
  await engine?.stop();
  tray?.destroy();
  app.quit();
}

// ---------------------------------------------------------------------------
// 自訂 COST
// ---------------------------------------------------------------------------

/**
 * 目前載進來的規則摘要。**只放給畫面看的欄位**，不放整張 700 筆的 COST 表 ——
 * 那會讓每次 pushState 都在 IPC 上搬幾十 KB，而畫面一個都用不到。
 */
export interface CostRuleInfo {
  path: string;
  name: string;
  version: string;
  publisher: string;
  /**
   * 規則包才有。裸規則是 null —— 那也是「不能拿去跟對手核對」的意思。
   *
   * ⚠ 這是**從內容重算**的碼，不是檔案裡寫的那個。配對鍵也用同一個值，
   * 所以「畫面上的碼一樣」與「配得到對方」永遠是同一件事。
   */
  shortHash: string | null;
  /**
   * 這個檔案宣稱的碼跟內容不符，已經重算。`null` = 檔案本來就自洽。
   *
   * 玩家直接改包就會走到這裡（那是支援的做法）。要講出來的原因只有一個：
   * **對手手上那份的碼已經不一樣了**，得把新檔案傳過去。
   */
  rehashedFrom: string | null;
  /** 角色表的筆數。⚠ 只有角色 —— 四張表的細分在 `tableEntries`。 */
  entries: number;
  /** 四張表各幾筆。0 代表這份規則不管那一種卡（遊戲用原版價格）。 */
  tableEntries: {
    characters: number;
    monsters: number;
    equipment: number;
    eventCards: number;
  };
  gameVersion: string;
  /** 規則族。**配對是照這個分的**（見 `@ulr/arbiter-link` 的 `MatchCriteria`）。 */
  ruleSetId: string;
  /** 壓 C 區間，給畫面列表用。`null` = 這份規則不壓 C。 */
  bands: { minGap: number; maxGap: number | null; extraCost: number }[] | null;
  /**
   * 作者寫的說明與更新說明。沒寫是空字串。
   *
   * ⚠ **一定要在「Cost 表」那一頁看得到，不能只有「編輯描述」看得到。**
   * 這兩欄是規則裡唯一「作者對拿到規則的人說話」的地方 —— 定價的理由、
   * 最小單位、哪些卡刻意不動、這一版改了什麼，全部只能寫在這裡（引擎永遠
   * 不解析它們，見 `Restriction.condition` 那條同樣的立場）。
   *
   * 只放在編輯頁的話，收到規則的人要**進到一個編輯畫面**才讀得到自己收到的
   * 東西，而那一頁的每一格都是可以打字的 —— 等於要他為了讀說明去冒改壞的
   * 風險。所以摘要要帶著它們，即使它們比其他欄位長得多。
   *
   * ⚠ 長度有上限（編輯器那邊 `maxlength=2000`），所以放進每次 pushState 的
   * 快照是可接受的 —— 跟 700 筆的 COST 表不是同一個量級。
   */
  description: string;
  changelog: string;
}

/**
 * 載入失敗的規則，留給畫面顯示。
 *
 * 只留「哪個檔、為什麼、怎麼救」三件事 —— 玩家看到這張卡片的時候，他要的
 * 不是錯誤碼，是下一步該做什麼。
 */
export interface CostRuleFailure {
  fileName: string;
  message: string;
  /** 針對這個錯誤的自救步驟。沒有特別建議時是 `null`。 */
  hint: string | null;
}

let costRule: CostRuleInfo | null = null;
let costRuleError: CostRuleFailure | null = null;

/**
 * 目前規則的**完整內容**。配對要用它算牌組（`checkOwnDeck` / 交叉驗算）。
 *
 * ⚠ 跟 `costRule`（摘要）分開放，而且**絕不進 `Snapshot`** —— 那是 700 筆的
 * COST 表，每次狀態變動都在 IPC 上搬一次的話，畫面會一格一格地卡。
 */
let costRuleFull: CostRule | null = null;

// ---------------------------------------------------------------------------
// 編輯 COST
//
// 「規則檔裡是 cc001_01，玩家看到的要是艾伯李斯特」—— 那份對照就是名冊
// （`@ulr/rule-schema` 的 catalog.ts），來源是玩家自己跑著的客戶端。
// ---------------------------------------------------------------------------

/**
 * 卡片名冊。開機時從家目錄的快取讀回來，沒有就是 `null`。
 *
 * ⚠ **不進 `Snapshot`**，理由同 `costRuleFull`：它有一千多筆，而快照每次狀態
 * 變動都整份重送。編輯頁自己用 `ulr:editor-load` 拉一次。
 */
let catalog: CardCatalog | null = readCatalog();

/** 猜一個遊戲版本字串（`2026.08`）。名冊只拿它來提醒「這份是哪一版讀的」。 */
function gameVersionNow(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 四張表的原始鍵值，直接餵給編輯頁。 */
interface EditorTables {
  characters: Record<string, number>;
  monsters: Record<string, number>;
  equipment: Record<string, number>;
  eventCards: Record<string, number>;
}

/**
 * 規則裡**不是 COST 也不是壓 C** 的那些欄位。「編輯描述」那一頁在改的東西。
 *
 * ⚠ `restrictions`（限制條款）不在這裡：schemaVersion 1 的它是
 * `enforcement: "agreement-only"` 的自由文字，**引擎永遠不解析**（§12），
 * 而做一個編輯器給一個沒有任何行為的欄位，只會讓人以為插件會強制它。
 * 要它有意義得先有結構化的條件型別（schemaVersion 2）。
 */
export interface RuleMeta {
  ruleSetId: string;
  version: string;
  name: string;
  description: string;
  publisherId: string;
  publisherName: string;
  publisherContact: string;
  gameVersion: string;
  appliesTo: "duel" | "quest" | "any";
  teamCostLimit: number;
  changelog: string;
}

export interface EditorPayload {
  /** 正在編哪份規則。沒選規則時是 `null`，編輯頁會請玩家先去選。 */
  rule: {
    name: string;
    version: string;
    ruleSetId: string;
    fileName: string;
    shortHash: string | null;
    gameVersion: string;
  } | null;
  tables: EditorTables | null;
  /**
   * 壓 C 規則（「編輯規則」那一頁在改的東西）。
   *
   * ⚠ **沒寫 `compressionRule` 的規則在這裡是 `{ type: "none", bands: [] }`
   * 而不是 `null`。** 兩者在畫面上都畫成「這份規則不壓 C」，但 `null` 會逼
   * 每一段渲染碼各自處理一次「還沒載入 vs 沒有規則」，而那兩件事的差別在這
   * 一頁根本不存在 —— 規則載進來了就一定有一個確定的壓 C 狀態。
   */
  compression: { type: CompressionRule["type"]; bands: GapBand[] } | null;
  /**
   * 規則的「描述」那一半 —— 名稱、作者、版本、適用範圍、更新說明。
   *
   * ⚠ 這些欄位**每一個都會進 contentHash**（整個 rule 物件就是雜湊的對象），
   * 所以改個作者名字核對碼就會變。介面要講出來，否則玩家會以為只有數字算數。
   */
  meta: RuleMeta | null;
  catalog: CardCatalog | null;
  /** 讀名冊失敗的原因。成功或還沒讀過是 `null`。 */
  catalogError: string | null;
  /** 遊戲接上了沒 —— 決定「從遊戲讀取名冊」那顆按不按得下去。 */
  connected: boolean;
  /** 按一下上下鍵動多少。⚠ 真實來源是設定檔，畫面上那個只是它的樣子。 */
  editStep: number;
  /** 幅度的快速鍵。⚠ 從這裡送而不是讓畫面自己寫死 —— 兩份清單會走散。 */
  editSteps: readonly number[];
  /**
   * 最小單位檢查用的值。**0 = 不檢查。**
   *
   * ⚠ 這**不在規則檔裡**，是編輯器的工具設定（見 `profiles-core.ts` 的
   * `normalizeEditUnit`）。所以它跟 `rule` 是兩個獨立的東西 —— 換一份規則來編，
   * 這個值不會跟著換。
   */
  editUnit: number;
  editUnits: readonly number[];
}

export interface EditorSaveResult {
  ok: boolean;
  shortHash?: string;
  version?: string;
  error?: string;
}

function editorPayload(): EditorPayload {
  const rule = costRuleFull;
  return {
    rule:
      costRule === null || rule === null
        ? null
        : {
            name: rule.name,
            version: rule.version,
            ruleSetId: rule.ruleSetId,
            fileName: basename(costRule.path),
            shortHash: costRule.shortHash,
            gameVersion: rule.gameVersion,
          },
    tables:
      rule === null
        ? null
        : {
            characters: { ...rule.characters },
            monsters: { ...(rule.monsters ?? {}) },
            equipment: { ...(rule.equipment ?? {}) },
            eventCards: { ...(rule.eventCards ?? {}) },
          },
    compression:
      rule === null
        ? null
        : rule.compressionRule?.type === "gap-band-v1"
          ? { type: "gap-band-v1", bands: rule.compressionRule.bands.map((b) => ({ ...b })) }
          : { type: "none", bands: [] },
    meta:
      rule === null
        ? null
        : {
            ruleSetId: rule.ruleSetId,
            version: rule.version,
            name: rule.name,
            description: rule.description ?? "",
            publisherId: rule.publisher.id,
            publisherName: rule.publisher.name,
            publisherContact: rule.publisher.contact ?? "",
            gameVersion: rule.gameVersion,
            appliesTo: rule.appliesTo ?? "duel",
            teamCostLimit: rule.teamCostLimit,
            changelog: rule.changelog ?? "",
          },
    catalog,
    catalogError: null,
    connected: latest?.connected ?? false,
    editStep: profile.editStep,
    editSteps: EDIT_STEPS,
    editUnit: profile.editUnit,
    editUnits: EDIT_UNITS,
  };
}

/** 只收有限數字，其餘丟掉。渲染層送來的東西一律當成不可信的輸入。 */
function sanitizeTable(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, cost] of Object.entries(value as Record<string, unknown>)) {
    if (typeof cost === "number" && Number.isFinite(cost)) out[key] = cost;
  }
  return out;
}

/**
 * 一段壓 C 區間。渲染層送來的一律當成不可信的輸入。
 *
 * ⚠ **`maxGap` 空白代表「沒有上界」，不是 0。** 空字串在畫面上就是玩家沒填，
 * 而 `Number("")` 是 0 —— 那會把「差距 30 以上」變成「差距 30 到 0」，一段
 * 不可能命中的區間，然後最大的那些差距靜靜地不罰了。
 *
 * 整段丟掉（回 `null`）而不是硬補一個值：規則是玩家自己在編的東西，猜他的
 * 意思比少存一段更糟。少存的那一段在畫面上看得見。
 */
function sanitizeBand(value: unknown): GapBand | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const minGap = num(b["minGap"]);
  const extraCost = num(b["extraCost"]);
  if (minGap === null || extraCost === null) return null;

  const maxGap = b["maxGap"] === null || b["maxGap"] === undefined ? null : num(b["maxGap"]);
  return maxGap === null ? { minGap, extraCost } : { minGap, maxGap, extraCost };
}

/** 壓 C 規則。認不得的形狀一律回 `null`（＝呼叫端要沿用原本那份）。 */
function sanitizeCompression(value: unknown): CompressionRule | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c["type"] === "none") return { type: "none" };
  if (c["type"] !== "gap-band-v1") return null;
  const raw = Array.isArray(c["bands"]) ? c["bands"] : [];
  const bands = raw.map(sanitizeBand).filter((b): b is GapBand => b !== null);
  // 空表的 gap-band-v1 跟 none 是同一件事，存成 none 比較誠實（也比較好讀）。
  return bands.length === 0 ? { type: "none" } : { type: "gap-band-v1", bands };
}

/**
 * 「編輯描述」送來的那一包。**認不得的形狀一律回 `null`**（＝沿用原本的）。
 *
 * ⚠ 這裡只做「整理成規則該有的形狀」，**不做驗證** —— 格式（ruleSetId 的
 * pattern、SemVer、gameVersion 的 `2026.08`、publisher.id 要等於 ruleSetId 的
 * 前半段）全部交給 `assertCostRule`，那才是唯一的判準。在這裡再寫一份會漂移，
 * 而漂移的症狀是「介面說可以，存檔卻失敗」。
 *
 * ⚠ 空字串的選填欄位要**整個拿掉**而不是留空字串：`description: ""` 與沒有
 * `description` 是兩份不同的 JSON，也就是兩個不同的 contentHash。
 */
function applyMeta(current: CostRule, value: unknown): CostRule {
  if (typeof value !== "object" || value === null) return current;
  const m = value as Record<string, unknown>;
  /** 有送這個欄位、而且是字串才算數。沒送的一律沿用原本的。 */
  const str = (key: string): string | null => {
    const v = m[key];
    return typeof v === "string" ? v.trim() : null;
  };

  const next: CostRule = { ...current, publisher: { ...current.publisher } };

  const scalars = [
    ["ruleSetId", "ruleSetId"],
    ["version", "version"],
    ["name", "name"],
    ["gameVersion", "gameVersion"],
  ] as const;
  for (const [field, key] of scalars) {
    const v = str(key);
    // 空字串不當成「清空」—— 那幾個欄位是必填的，清空只會讓存檔失敗。
    if (v !== null && v !== "") next[field] = v;
  }

  const appliesTo = str("appliesTo");
  if (appliesTo === "duel" || appliesTo === "quest" || appliesTo === "any") {
    next.appliesTo = appliesTo;
  }

  const limit = m["teamCostLimit"];
  if (typeof limit === "number" && Number.isFinite(limit)) next.teamCostLimit = limit;

  // ⚠ 選填的長文字：空的要**整個刪掉欄位**，不是留一個空字串。
  // `description: ""` 與沒有 `description` 是兩份不同的 JSON，也就是兩個
  // 不同的 contentHash —— 而玩家清空一個欄位的意思是「這份規則沒有這一項」。
  for (const field of ["description", "changelog"] as const) {
    const v = str(field);
    if (v === null) continue;
    if (v === "") delete next[field];
    else next[field] = v;
  }

  const pubId = str("publisherId");
  const pubName = str("publisherName");
  if (pubId !== null && pubId !== "") next.publisher.id = pubId;
  if (pubName !== null && pubName !== "") next.publisher.name = pubName;
  const contact = str("publisherContact");
  if (contact !== null) {
    if (contact === "") delete next.publisher.contact;
    else next.publisher.contact = contact;
  }
  return next;
}

/**
 * 把編輯結果寫回規則檔。
 *
 * ⚠ **一定要過 `assertCostRule`。** 渲染層送來的是外部輸入，直接寫進檔案等於
 * 讓一份不合規格的規則落地，而下次載入才會炸 —— 那時玩家已經不知道是哪一步
 * 弄壞的。精度（0.01）與壓 C 區間重疊也都是在這一關擋的。
 *
 * ⚠⚠ **沒送到的東西一律沿用原本那份，不能當成「清空」。** 有兩頁在寫同一個
 * 檔（編輯 COST 送 `tables`、編輯規則送 `compression`），而這支原本無條件把
 * 四張表換成 `payload.tables` —— 那樣「改個壓 C 存檔」會把 1186 筆價格全部
 * 洗成空的，而且完全不報錯（空表是合法的規則，只是每張卡都變成 99C）。
 */
function saveEditedRule(
  current: CostRule,
  path: string,
  payload: unknown,
): { short: string; version: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const version =
    typeof p["version"] === "string" && p["version"] !== "" ? p["version"] : current.version;

  const tables = typeof p["tables"] === "object" && p["tables"] !== null ? p["tables"] : null;
  const t = (tables ?? {}) as Record<string, unknown>;
  const table = (id: keyof EditorTables, fallback: Record<string, number> | undefined) =>
    tables === null ? (fallback ?? {}) : sanitizeTable(t[id]);

  const compression = sanitizeCompression(p["compression"]);
  // 「編輯描述」那一頁送的東西。沒送就是原封不動。
  const base = applyMeta(current, p["meta"]);

  const next = assertCostRule({
    ...base,
    version,
    characters: table("characters", current.characters),
    monsters: table("monsters", current.monsters),
    equipment: table("equipment", current.equipment),
    eventCards: table("eventCards", current.eventCards),
    ...(compression === null
      ? {}
      : // ⚠ `{ type: "none" }` 要真的寫進去，不能改成刪掉這個欄位 —— 兩者
        // 對引擎是同一件事，但檔案裡看得到 `"type": "none"` 才知道作者是
        // **決定不壓 C**，而不是拿到一份還沒寫完的規則。
        { compressionRule: compression }),
  });

  const pkg = createRulePackage(next, {
    exportedBy:
      p["meta"] !== undefined
        ? "ulr-companion 編輯描述"
        : compression !== null
          ? "ulr-companion 編輯規則"
          : "ulr-companion 編輯 COST",
  });
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  const short = shortHash(pkg.contentHash);
  log(`✓ 已存回 ${basename(path)}（${next.version}，核對碼 ${short}）`);
  return { short, version: next.version };
}

/**
 * 錯誤訊息 → 給玩家的下一步。
 *
 * ⚠ 這裡**沒有** hash.mismatch 那一條了 —— 直接改包是支援的做法，Hash 會
 * 重算（見 `@ulr/rule-schema` 的 `loadRulePackage`）。剩下的都是真的動不了
 * 的錯：內容不合規格、檔案不在。
 */
function costRuleHint(message: string): string | null {
  if (message.includes("rule.invalid")) {
    return "規則內容不合規格，上面那行寫了是哪個欄位。把它改好之後再選一次。";
  }
  if (message.includes("ENOENT")) {
    return "檔案不在了（搬走或刪掉了？）。重新選一次。";
  }
  if (message.includes("JSON")) {
    return "這個檔案不是合法的 JSON —— 編輯時少了逗號或括號？";
  }
  return null;
}

/** 規則包與裸規則都要選得到。`.ulrcost.json` 在 Windows 上被視為副檔名 `json`。 */
const COST_FILE_FILTERS = [
  { name: "COST 規則", extensions: ["json"] },
  { name: "全部檔案", extensions: ["*"] },
];

/**
 * 從檔案讀規則並推給引擎。
 *
 * ⚠ **失敗要講出來並清掉路徑**，不能安靜地當作沒選。玩家把規則檔刪了或搬走
 * 之後，如果 UI 還顯示「已選規則」而數字是原版的，他會以為插件壞了。
 */
function loadCostRule(path: string | null): void {
  if (path === null) {
    costRule = null;
    costRuleFull = null;
    costRuleError = null;
    engine?.setCostRule(null);
    return;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    let rule: CostRule;
    let short: string | null = null;
    let rehashedFrom: string | null = null;

    if (typeof raw === "object" && raw !== null && "packageVersion" in raw) {
      const result = loadRulePackage(raw);
      if (!result.ok) throw new Error(`[${result.code}] ${result.message}`);
      rule = result.value.pkg.rule;
      // ⚠ 這個 short 是**重算**的。直接改過的包在這裡是正常輸入，
      // 只是核對碼會跟檔案裡寫的那個不一樣 —— 要講給玩家聽。
      short = result.value.short;
      rehashedFrom = result.value.staleHash?.claimedShort ?? null;
    } else {
      rule = assertCostRule(raw);
    }

    const bands = rule.compressionRule?.type === "gap-band-v1" ? rule.compressionRule.bands : null;

    costRule = {
      path,
      name: rule.name,
      version: rule.version,
      publisher: rule.publisher.name,
      shortHash: short,
      rehashedFrom,
      entries: Object.keys(rule.characters).length,
      // 四張表分開報。一個總數看不出「這份規則有沒有管裝備」，而那正是玩家
      // 拿到別人的規則檔時第一個要知道的事。
      tableEntries: {
        characters: Object.keys(rule.characters).length,
        monsters: Object.keys(rule.monsters ?? {}).length,
        equipment: Object.keys(rule.equipment ?? {}).length,
        eventCards: Object.keys(rule.eventCards ?? {}).length,
      },
      gameVersion: rule.gameVersion,
      ruleSetId: rule.ruleSetId,
      bands:
        bands === null
          ? null
          : bands.map((b) => ({
              minGap: b.minGap,
              maxGap: b.maxGap ?? null,
              extraCost: b.extraCost,
            })),
      // 作者對「拿到這份規則的人」說的話。⚠ 摘要要帶著 —— 理由見型別那邊。
      description: rule.description ?? "",
      changelog: rule.changelog ?? "",
    };
    // ⚠ 罰則跟價格要一起送。只送價格的話，自訂規則的 compressionRule 對
    // 遊戲畫面完全沒有作用 —— 罰則的公式是寫死在客戶端裡的。
    //
    // ⚠ 裝備與事件卡要**先把規則鍵換成陣列索引**（`wp001` → `"1"`）。注入的
    // 腳本刻意不認得 `wp` / `ev` 這套命名，見 patch-cost.ts 的說明。
    const equipment = toIndexTable(rule.equipment, parseEquipmentKey);
    const eventCards = toIndexTable(rule.eventCards, parseEventCardKey);
    engine?.setCostRule({
      characters: rule.characters,
      monsters: rule.monsters,
      equipment: equipment.byIndex,
      eventCards: eventCards.byIndex,
      bands,
    });
    costRuleFull = rule;
    costRuleError = null;
    const t = costRule.tableEntries;
    const summary = [
      `角色 ${t.characters}`,
      t.monsters > 0 ? `怪物 ${t.monsters}` : null,
      t.equipment > 0 ? `裝備 ${t.equipment}` : null,
      t.eventCards > 0 ? `事件卡 ${t.eventCards}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join("、");
    log(`✓ 載入 COST 規則「${rule.name} ${rule.version}」（${summary}）`);
    // ⚠ 認不得的鍵要講出來，不能默默丟掉。`wp1`（沒補零）這種寫法很容易手滑，
    // 而症狀是「那張卡的價格就是沒變」—— 沒有這一行的話玩家查不到原因。
    for (const [label, bad] of [
      ["裝備", equipment.unmapped],
      ["事件卡", eventCards.unmapped],
    ] as const) {
      if (bad.length === 0) continue;
      log(`⚠ ${label}有 ${bad.length} 個鍵格式不對，已略過：${bad.slice(0, 5).join(", ")}`);
    }
    if (rehashedFrom !== null) {
      log(`· 這個檔案被直接改過，核對碼已重算：${rehashedFrom} → ${short ?? "?"}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    costRule = null;
    costRuleFull = null;
    engine?.setCostRule(null);
    // ⚠ 記錄**不夠**。記錄在「戰鬥」頁，玩家人在「牌組 › Cost 表」頁，
    // 那一頁只會說「還沒選規則」—— 看起來就是按了沒反應。所以同時留一份
    // 給畫面，由 Cost 頁自己顯示。
    costRuleError = { fileName: basename(path), message, hint: costRuleHint(message) };
    log(`✗ COST 規則載入失敗，已停用：${message}`);
    // 路徑留在設定檔裡只會每次開機再失敗一次。清掉，讓玩家重選。
    // ⚠ editProfile 會 pushState，而那要在 costRuleError 設好之後 ——
    // 反過來的話畫面會先收到一份「沒選規則、也沒有錯誤」的狀態。
    if (profile.costRulePath !== null) editProfile(profile.id, { costRulePath: null });
  }
}

/** 改配置的連線設定。**埠變了要重開實例才會生效** —— 引擎綁在啟動時的埠上。 */
function editProfile(id: string, patch: Partial<Omit<Profile, "id">>): void {
  store = updateProfile(id, patch);
  const mine = store.profiles.find((p) => p.id === profile.id);
  if (mine !== undefined) profile = mine;
  pushState();
  refreshTray();
}

app.whenReady().then(() => {
  markUsed(profile.id);

  engine = new ArbiterEngine({
    port: profile.port,
    // 埠只是首選。連不上時引擎會從這個目錄的 DevToolsActivePort 找回實際的埠 ——
    // 目錄跟著 kind 走，所以救回來的一定是這份配置要管的那個客戶端。
    userDataDir: userDataDirFor(profile.kind),
    link: profile.link,
    prefs: profile.prefs,
    readyTint: profile.readyTint,
    onLog: (line) => {
      log(line);
      pushState();
    },
    onStatus: (status) => {
      latest = status;
      pushState();
      refreshTray();
    },
  });

  // ⚠ 要在 engine 建好之後 —— loadCostRule 會呼叫 engine.setCostOverrides()。
  loadCostRule(profile.costRulePath);
  // ⚠ 同樣要在 engine 建好之後。這裡只是把玩家上次的選擇交給引擎，真正裝到
  // 頁面上是接上遊戲之後的事（`#syncHiddenStages`）。
  engine.setHiddenStages(profile.hiddenStages);

  tray = new Tray(nativeImage.createFromBuffer(trayIconPng("idle")));
  refreshTray();
  tray.on("click", () => showWindow());

  ipcMain.handle("ulr:state", () => snapshot());
  ipcMain.handle("ulr:set-prefs", (_event, next: Partial<LinkPrefs>) => {
    applyPrefs(next);
    return snapshot();
  });

  /**
   * 換準備中的染色。走引擎的 setReadyTint()，**不重裝 patch** ——
   * 重裝會把正壓著的 I_am_ok 送出去，為了改一個顏色讓玩家的 OK 定案。
   */
  ipcMain.handle("ulr:set-tint", (_event, tint: number | null) => {
    engine?.setReadyTint(tint);
    const applied = engine?.readyTint ?? null;
    profile = { ...profile, readyTint: applied };
    if (!ephemeral) store = updateProfile(profile.id, { readyTint: applied });
    pushState();
    return snapshot();
  });

  ipcMain.handle("ulr:profile-add", (_event, from?: string) => {
    const source = store.profiles.find((p) => p.id === from);
    store = addProfile(source);
    pushState();
    refreshTray();
    return snapshot();
  });
  ipcMain.handle("ulr:profile-remove", (_event, id: string) => {
    store = removeProfile(id);
    pushState();
    refreshTray();
    return snapshot();
  });
  ipcMain.handle(
    "ulr:profile-edit",
    (
      _event,
      id: string,
      patch: { name?: string; port?: number; link?: string; kind?: ClientKind },
    ) => {
      editProfile(id, patch);
      return snapshot();
    },
  );
  /**
   * 選一份 COST 規則檔。
   *
   * ⚠ 檔案選擇框開在**主程序**，渲染層永遠碰不到路徑字串以外的東西 ——
   * `preload.ts` 的介面刻意小，這裡不能為了方便就把 fs 攤出去。
   */
  ipcMain.handle("ulr:cost-pick", async () => {
    const owner = window;
    const result = await (owner === null
      ? dialog.showOpenDialog({ properties: ["openFile"], filters: COST_FILE_FILTERS })
      : dialog.showOpenDialog(owner, { properties: ["openFile"], filters: COST_FILE_FILTERS }));

    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return snapshot();

    editProfile(profile.id, { costRulePath: picked });
    loadCostRule(picked);
    pushState();
    return snapshot();
  });

  /** 取消套用，回到原版數字。一樣要等下次載入才會變回去。 */
  ipcMain.handle("ulr:cost-clear", () => {
    editProfile(profile.id, { costRulePath: null });
    loadCostRule(null);
    log("· 自訂 COST 已停用（要重載遊戲才會變回原版數字）");
    pushState();
    return snapshot();
  });

  /**
   * 重載遊戲讓注入生效。
   *
   * ⚠ **會打斷對戰。** 按鈕文案要講明白 —— 這是玩家自己的決定，插件不該
   * 在選好規則之後自動重載。
   */
  ipcMain.handle("ulr:cost-reload", async () => {
    try {
      await engine?.reloadGame();
      log("⟳ 已請遊戲重新載入，自訂 COST 會在載完後生效");
    } catch (err) {
      log(`✗ 重載失敗：${err instanceof Error ? err.message : String(err)}`);
    }
    pushState();
    return snapshot();
  });

  // -------------------------------------------------------------------------
  // 編輯 COST
  // -------------------------------------------------------------------------

  ipcMain.handle("ulr:editor-load", (): EditorPayload => editorPayload());

  /**
   * 改上下鍵的幅度並**記進配置**。不碰遊戲、不碰規則檔，只是偏好。
   *
   * ⚠ 走 `profile = {...}` 而不是 `editProfile`：臨時配置（`--port` 對不上任何
   * 一份時建的）不在清單裡，`editProfile` 對它是完全的空操作 —— 症狀是「改了
   * 幅度，下一次重畫又跳回去」。跟 `ulr:set-tint`、`ulr:match-prefs` 同一招。
   */
  ipcMain.handle("ulr:editor-step", (_event, raw: unknown): number => {
    const next = normalizeEditStep(raw);
    profile = { ...profile, editStep: next };
    if (!ephemeral) store = updateProfile(profile.id, { editStep: next });
    return next;
  });

  /**
   * 改「最小單位」檢查的值並記進配置。**0 = 不檢查。**
   *
   * ⚠ 這**不會動到規則檔**。最小單位不是規則的欄位，是編輯器的工具設定 ——
   * 作者要讓拿到規則的人知道，得自己寫進「編輯描述」的說明欄（那一欄現在在
   * 「Cost 表」那一頁讀得到）。完整理由見 `profiles-core.ts` 的
   * `normalizeEditUnit`。
   */
  ipcMain.handle("ulr:editor-unit", (_event, raw: unknown): number => {
    const next = normalizeEditUnit(raw);
    profile = { ...profile, editUnit: next };
    if (!ephemeral) store = updateProfile(profile.id, { editUnit: next });
    return next;
  });

  /**
   * 從跑著的遊戲重讀名冊。
   *
   * ⚠ **套用中的客戶端讀不得。** `patch-cost` 是就地改寫 Phaser 快取，套過之後
   * 讀回來的「原價」會是上一份規則的數字 —— 而編輯器的「改回原價」與價差色階
   * 正是拿它當基準，於是玩家按下去會改回一個他從來沒設過的值。
   *
   * ⚠ 下面這道閘**只是快路**（省一趟 CDP 往返，訊息也講得清楚一點）。它問的是
   * 插件記著的狀態，而那擋不住「停用了但沒重載」「剛換一份規則」「托盤重開過」
   * 這三種頁面仍然是髒的情況 —— 真正的判斷在 `readCardCatalog` 裡問頁面自己。
   * **不要**因為這裡有檢查就把那邊的拿掉。
   */
  ipcMain.handle("ulr:editor-catalog", async (): Promise<EditorPayload> => {
    if (engine === null) return { ...editorPayload(), catalogError: "還沒接上遊戲。" };
    if (latest?.cost.phase === "applied") {
      return {
        ...editorPayload(),
        catalogError:
          "目前的客戶端正套著自訂 COST，讀回來的「原價」會是改過的數字。" +
          "請先在「Cost 表」按停用、重載遊戲，再回來讀一次。",
      };
    }
    try {
      const fresh = await engine.readCardCatalog(costRule?.gameVersion ?? gameVersionNow());
      writeCatalog(fresh);
      catalog = fresh;
      const n = catalogSize(fresh);
      log(
        `✓ 已讀取卡片名冊：角色 ${n.characters}、怪物 ${n.monsters}、` +
          `裝備 ${n.equipment}、事件卡 ${n.eventCards}`,
      );
      return editorPayload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ 讀取卡片名冊失敗：${message}`);
      return { ...editorPayload(), catalogError: message };
    }
  });

  /**
   * 把編輯好的東西寫回**目前選著的那個檔**。
   *
   * 兩頁共用這一支：編輯 COST 送 `tables`、編輯規則送 `compression`。
   * ⚠ **沒送到的部分會沿用檔案裡原本那份**（見 `saveEditedRule`）——
   * 一頁存檔不該把另一頁的東西洗掉。
   *
   * ⚠ 就地覆寫、**不改檔名**。之前 `unpack` 的產物留在同一個資料夾裡，造成
   * 「同一份規則有兩個檔」的困惑；每存一次就多一個檔會把同樣的問題放大。
   * 版本號要不要動由作者自己決定（`version` 欄位），核對碼一律重算。
   */
  ipcMain.handle("ulr:editor-save", (_e, payload: unknown): EditorSaveResult => {
    if (costRule === null || costRuleFull === null) {
      return { ok: false, error: "還沒選規則檔。請先到「Cost 表」選一份。" };
    }
    try {
      const saved = saveEditedRule(costRuleFull, costRule.path, payload);
      // 存完立刻重新載入 —— 不重載的話畫面顯示的核對碼還是舊的，而那正是
      // 玩家要拿去跟對手核對的東西。
      loadCostRule(costRule.path);
      pushState();
      return { ok: true, shortHash: saved.short, version: saved.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ 儲存 COST 表失敗：${message}`);
      return { ok: false, error: message };
    }
  });

  // -------------------------------------------------------------------------
  // 配對（WP-16）
  //
  // ⚠ 這一組跟其他 handler 不一樣：**它們會替玩家操作遊戲**（開房會消耗 AP、
  // 進房會直接開打）。所以每一支都必須是玩家明確按下去才會走到，絕不能放進
  // 任何輪詢或自動重試裡。
  // -------------------------------------------------------------------------

  ipcMain.handle("ulr:match-state", async (): Promise<MatchPageState> => {
    const limit = profile.match.limitOn ? profile.match.limit : null;
    const base = {
      rule: matchRuleInfo(),
      pairing: pairingStatus,
      channelNames: CHANNEL_NAMES,
      statics: MATCH_STATICS,
      match: profile.match,
      // ⚠ 沒選規則就沒有房名可組 —— 而沒選規則本來就開始不了配對，畫面那邊
      // 已經有一句更該講的話（「先去選一份規則」）。
      roomName: costRuleFull === null ? null : buildRoomName(costRuleFull.name, limit),
      band: formatBand(limit),
    };
    const off = {
      connected: false as const,
      context: null,
      rooms: [],
      seq: 0,
      myCost: null,
      costTiers: null,
    };
    const driver = await engine?.matchDriver().catch(() => null);
    if (!driver) return { ...off, ...base };
    try {
      const [context, snap] = await Promise.all([driver.matchContext(), driver.roomSnapshot()]);
      return {
        connected: true,
        context,
        rooms: snap.rooms,
        seq: snap.seq,
        myCost: myDeckCost(context),
        // ⚠ **現讀，不快取。** 這幾個數字每週二遊戲更新會變，存起來的話玩家會
        // 照著上週的數字去約戰，而對手的插件讀的是這週的 —— 兩邊算出不同的
        // 配對鍵，症狀是「明明都選 57 卻永遠配不到」。
        costTiers: costTiersFor(context.channels, context.channel),
        ...base,
      };
    } catch {
      return { ...off, ...base };
    }
  });

  /**
   * 開始自動配對（WP-16）。
   *
   * ⚠ 這一支會一路走到**開房**（消耗 AP）或**進房**（直接開打）。它只能綁在
   * 玩家親手按下的按鈕上 —— 任何輪詢、重試、狀態同步都不准叫它。
   */
  ipcMain.handle("ulr:match-queue-start", async (_event, options: MatchQueueOptions) => {
    if (pairing !== null) return { ok: false as const, reason: "已經在配對中了。" };
    if (costRuleFull === null) {
      // 沒有規則就沒有「約定」可言 —— 那正是這個功能存在的理由。
      return { ok: false as const, reason: "自動配對要先選一份 COST 規則（牌組 › Cost 表）。" };
    }
    const driver = await engine?.matchDriver().catch(() => null);
    if (!driver) return { ok: false as const, reason: "還沒連上遊戲" };

    // ⚠ 開房設定**從配置讀**，不從畫面收。畫面送過來的話會有兩份真相，而
    // 「我改了設定但開出來的是舊的」這種 bug 完全看不出來。
    const m = profile.match;
    const p = new MatchPairing({
      endpoint: engine?.linkEndpoint ?? "",
      rule: costRuleFull,
      channel: options.channel,
      costLimit: m.limitOn ? m.limit : null,
      room: {
        // ⚠ 房名不在這裡 —— 引擎照「規則名 + 檔位」自己組（`buildRoomName`）。
        // 3vs3 與遊戲自己的 ±N 也不在：兩個都是固定的（`ROOM_MULTI`、
        // `ROOM_DECK_COST_BAND`）。
        stage: m.stage,
        friend: false,
      },
      driver,
      onStatus: (s) => {
        pairingStatus = s;
        // ⚠ 停下來就把物件放掉。留著的話玩家再按「開始配對」只會收到
        // 「已經在配對中了」，而畫面上明明寫著已停止 —— 那是最讓人以為插件
        // 壞掉的一種狀態。
        //
        // `idle` 跟 `blocked` 都要放：配對成功走到底（對手進房、對戰開始）
        // 之後狀態機會自己回到 idle，而那正是玩家最可能馬上想再排一次的時候。
        if (s.phase === "blocked" || s.phase === "idle") pairing = null;
        // ⚠ 配對頁是**自己輪詢**的（見 `MatchPageState` 的說明），所以這裡
        // 不 pushState —— 那會把整份 Snapshot 推給畫面，而配對狀態不在裡面。
      },
      onLog: (line) => log(line),
    });
    pairing = p;
    await p.start();
    // ⚠ **`start()` 期間推出去的狀態不算數，回來時的 `phase` 才是真的。**
    // 這行原本只在被擋下來時清掉（`if (…) pairing = null`），於是 `start()`
    // 中途只要推出一次 idle，上面 `onStatus` 就把 `pairing` 設成 null 而**沒有
    // 人補回來** —— 排隊照跑，但玩家按「停止」是空操作（`pairing?.stop()`
    // 打在 null 上），畫面永遠停在「排隊中」。改成整個重指派，那條路就不存在。
    //
    // 開場就被擋下來（沒在大廳、牌組超標…）的話不要留著一個死掉的物件，
    // 否則玩家改好之後再按會收到「已經在配對中了」。
    pairing = p.status.phase === "idle" || p.status.phase === "blocked" ? null : p;
    return { ok: true as const, status: p.status };
  });

  ipcMain.handle("ulr:match-queue-stop", async () => {
    await pairing?.stop();
    pairing = null;
    return { ok: true as const, status: pairingStatus };
  });

  /**
   * 改配對設定（地點抽法、約定檔位）並**記進配置**。
   *
   * ⚠ 這一支跟上面兩支不一樣：它**不碰遊戲**，只是存偏好。所以畫面可以在
   * 每一次輸入之後就叫它，不必等玩家按什麼按鈕。
   *
   * ⚠ 走 `profile = {...}` 而不是 `editProfile`：臨時配置（`--port` 對不上
   * 任何一份時建的）不在清單裡，`editProfile` 對它是完全的空操作 —— 症狀是
   * 「改了設定，下一次重畫又跳回去」。跟 `ulr:set-tint` 同一招。
   *
   * ⚠ **回的不只是 `MatchPrefs`。** 房名與檔位區間是從這幾格算出來的，而畫面
   * 一改就要看到新的 —— 只回 prefs 的話那兩行會停在舊值直到下一次輪詢（3 秒），
   * 而玩家會以為「我改了檔位，房名卻沒跟著改」。算的地方仍然只有主程序一處。
   */
  ipcMain.handle("ulr:match-prefs", (_event, patch: unknown): MatchPrefsResult => {
    const next = normalizeMatchPrefs({ ...profile.match, ...(patch as object) });
    profile = { ...profile, match: next };
    if (!ephemeral) store = updateProfile(profile.id, { match: next });
    const limit = next.limitOn ? next.limit : null;
    return {
      match: next,
      roomName: costRuleFull === null ? null : buildRoomName(costRuleFull.name, limit),
      band: formatBand(limit),
    };
  });

  // -------------------------------------------------------------------------
  // 隱藏地圖
  //
  // ⚠ 這一組**不會替玩家操作遊戲**（跟配對那一組相反）：它只是把官方選單裡沒有
  // 的四張地圖放回下拉選單。開房仍然是玩家自己在遊戲的對話框上按的。
  // -------------------------------------------------------------------------

  ipcMain.handle("ulr:stages-state", async (): Promise<StagePageState> => {
    return { enabled: profile.hiddenStages, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

  ipcMain.handle("ulr:stages-set", async (_event, on: boolean): Promise<StagePageState> => {
    // ⚠ 先改記憶體裡那份、落地只在非臨時配置時做 —— 跟 `ulr:set-tint` 同一招，
    // **不能用 `editProfile`**。臨時配置（`--port` 對不上任何一份時建的）不在
    // 清單裡，`editProfile` 對它是完全的空操作：開關會在下一次重畫時彈回去，
    // 而畫面上看起來就是「按了沒反應」。
    profile = { ...profile, hiddenStages: on };
    if (!ephemeral) store = updateProfile(profile.id, { hiddenStages: on });
    engine?.setHiddenStages(on);
    log(on ? "· 隱藏地圖已啟用（開房選單會多四張）" : "· 隱藏地圖已停用，選單回官方那 11 項");
    pushState();
    return { enabled: on, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

  /** 重新推一次。給「等太久放棄了」那個收尾狀態用的按鈕。 */
  ipcMain.handle("ulr:stages-retry", async (): Promise<StagePageState> => {
    await engine?.applyHiddenStages();
    return { enabled: profile.hiddenStages, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

  ipcMain.handle("ulr:profile-default-port", (_event, kind: ClientKind) => defaultPortFor(kind));
  ipcMain.handle("ulr:profile-launch", (_event, id: string) => {
    launchInstance(id);
    return snapshot();
  });

  ipcMain.handle(
    "ulr:options",
    (
      _event,
      patch: { launchAtLogin?: boolean; startMinimized?: boolean; multiProfile?: boolean },
    ) => {
      store = updateOptions(patch);
      // 登錄檔是真實來源，設定檔只是記錄玩家的意圖。兩個都要動。
      if (patch.launchAtLogin !== undefined) setLaunchAtLogin(patch.launchAtLogin);
      // 多開開關會改變標題與托盤選單的內容，兩個都要當場跟上。
      if (patch.multiProfile !== undefined) {
        window?.setTitle(heading());
        refreshTray();
      }
      pushState();
      return snapshot();
    },
  );

  /**
   * 把啟動參數放進剪貼簿。
   *
   * ⚠ **不收參數。** 渲染層只能說「複製那一行」，不能說「複製這串字」——
   * 跟 `open-external` 的白名單是同一條原則（preload 的檔頭）：畫面被塞了一段
   * 腳本時，它能對外面做的事要盡可能少。剪貼簿是使用者會直接貼進別處的東西。
   *
   * ⚠ 用 Electron 的 `clipboard` 而不是渲染層的 `navigator.clipboard`：後者要
   * 安全脈絡與權限處理器，在 `file://` 的視窗裡會**安靜地失敗** —— 而按鈕沒反應
   * 正是這一整輪要消滅的那種症狀。
   */
  ipcMain.handle("ulr:copy-debug-flag", () => {
    clipboard.writeText(DEBUG_PORT_SWITCH_AUTO);
    return DEBUG_PORT_SWITCH_AUTO;
  });

  ipcMain.handle("ulr:open-external", async (_event, url: string) => {
    // ⚠ 白名單，不是「開啟渲染層給的任何東西」。渲染層被塞了一段腳本時，
    // `shell.openExternal` 是它唯一能碰到外面的東西。
    if (!/^https:\/\/(github\.com|ulgg\.online)\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  probeTimer = setInterval(() => void probeGamePorts(), PROBE_INTERVAL_MS);

  void engine.start();
  // 靜默下載、安全的時機才套用。細節與那個「安全」的定義見 updater.ts。
  startAutoUpdate({
    currentVersion: VERSION,
    isBusy: () => latest?.armed === true,
    onLog: (l) => log(l),
  });

  // ⚠ 更新後由安裝檔叫起來的那一次**不要跳視窗**。玩家可能正在打字、
  // 正在看牌組 —— 更新本來就該是他察覺不到的事，跳一個視窗出來剛好相反。
  const fromUpdate = consumeUpdatedFlag();
  if (fromUpdate) log(`✓ 已更新到 ${VERSION}`);
  // `--startup` 是開機自動啟動帶的旗標。那個情境下也不要跳視窗。
  // ⚠ `--show` 是「玩家剛剛親手按了開新實例」，要勝過 startMinimized 這個偏好，
  // 否則新實例會安靜地縮進托盤，看起來就是按了沒反應（見 launch.ts）。
  const askedToShow = process.argv.includes("--show");
  if (askedToShow) showWindow();
  else if (!fromUpdate && !process.argv.includes("--startup") && !store.startMinimized)
    showWindow();
});

// ⚠ 托盤程式沒有視窗時**不能結束**。這是 Electron 在 Windows/Linux 上的預設行為，
// 而它對這個 app 是錯的：關掉設定視窗之後仲裁還要繼續跑。
app.on("window-all-closed", () => {});
