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

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  BrowserNotFoundError,
  browserDebugPort,
  buildBrowserLaunchCmd,
  buildBrowserShortcutArgs,
  DEBUG_PORT_SWITCH_AUTO,
  ENV_KEYS_TO_STRIP,
  ensureBrowser,
  findBrowser,
  HIDDEN_STAGES,
  loadExtensionArgs,
  resolveDebugPort,
  SELECTABLE_STAGES,
} from "@ulr/cdp-adapter";
import type { HiddenStageStatus } from "@ulr/cdp-adapter";
import { ensureCardArtDir } from "./card-art.js";
import { trayIconPng } from "./icon.js";
import type { IconState } from "./icon.js";
import { launchAtLoginEnabled, launchInstance, setLaunchAtLogin } from "./launch.js";
import { openLogFile } from "./log-file.js";
import { readRaidBattles, writeRaidBattles } from "./raid-battle-store.js";
import { readRaidOutcomes, writeRaidOutcomes } from "./raid-outcome-store.js";
import { readRaidLearned, writeRaidLearned } from "./raid-learned-store.js";
import { readQuestBonus, writeQuestBonus } from "./quest-bonus-store.js";
import type { ClientKind, CostRuleMode, MatchPrefs, Profile, ProfileStore } from "./profiles.js";
import {
  addProfile,
  clientLabel,
  kindTaken,
  loadStore,
  markUsed,
  MAX_APPLY_DELAY_SECONDS,
  MIN_APPLY_DELAY_SECONDS,
  normalizeMatchPrefs,
  removeProfile,
  resolveProfile,
  updateOptions,
  updateProfile,
  userDataDirFor,
} from "./profiles.js";
import {
  applyCostRule,
  applyPendingReload,
  COST_FILE_FILTERS,
  costRule,
  costRuleError,
  costRuleFull,
  costRuleOrigin,
  forgetAutoReload,
  initCostRuleRuntime,
} from "./cost-rule-runtime.js";
import type { CostRuleFailure, CostRuleInfo, CostRuleOrigin } from "./cost-rule-runtime.js";
import { APP_DIR } from "./app-dir.js";
import {
  CARD_ART_BLANKS_PATH,
  CARD_ART_DIR,
  cardArtPageState,
  cardNames,
  initCardArtRuntime,
  installBlanks,
  installCardMods,
  reloadCardArt,
  startCardNamesFetch,
  stopCardNamesFetch,
  watchCardArtDir,
} from "./card-art-runtime.js";
import type { CardArtPageState } from "./card-art-runtime.js";
import { initLobbyRuntime, startLobbyRuntime, stopLobbyRuntime } from "./lobby-runtime.js";
import {
  currentDeckSyncStatus,
  initDeckRuntime,
  onDeckPageReload,
  repushDeckOverlays,
  resetDeckSession,
  startDeckRuntime,
  stopDeckRuntime,
} from "./deck-runtime.js";
import type { DeckSyncStatus } from "./deck-runtime.js";
import { registerBonusPage } from "./pages/bonus-page.js";
import { registerCostPage } from "./pages/cost-page.js";
import { registerDeckPage } from "./pages/deck-page.js";
import { battleSurrenderOptions, registerDietPage } from "./pages/diet-page.js";
import { registerQuestPage } from "./pages/quest-page.js";
import {
  describeRaidRewardMode,
  raidDiscoverSetting,
  registerRaidPage,
} from "./pages/raid-page.js";
import { startRuleFeed } from "./rule-feed.js";
import type { TrayContext } from "./tray-context.js";
import { TitleButton } from "./title-button.js";
import type { AutoUpdater } from "./updater.js";
import { consumeUpdatedFlag, startAutoUpdate } from "./updater.js";
import { cleanupStaleFiles, cleanupUpdateLeftovers } from "./zip-update.js";
import { exportExtension, extVersion, STEAM_EXT_DIR, STEAM_EXT_GUIDE_URL } from "./web-client.js";

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

// ⚠ 關卡 1：兩份實例不能共用 userData。
// 必須在 app ready 之前設，而且要在讀完配置之後 —— 資料夾名是從配置來的
// （舊配置沿用以前的 `port-59222`，見 `Profile.dataDir`）。
{
  // `loadStore()` 會用到 app.getPath，那在 ready 之前就可以呼叫。
  store = loadStore();
  const resolved = resolveProfile(store, process.argv);
  profile = resolved.profile;
  ephemeral = resolved.ephemeral;
  app.setPath("userData", join(APP_DIR, profile.dataDir));
}

/**
 * ⚠⚠ 關卡 2：**同一份配置不能開兩份。**
 *
 * 這裡原本什麼都沒有，檔頭寫著「userData 目錄的鎖會自然擋掉」。**那是錯的**，
 * 而且錯得很安靜：Electron 不會替 userData 上鎖（那是 Chrome 自己的
 * ProcessSingleton，不是 Electron 的行為）。2026-08-19 實測抓到安裝版
 * （開機自動啟動）與開發版**同時**綁在 `port-59222` 上跑了一整天。
 *
 * 症狀不是「跳出兩個視窗」那麼明顯 —— 兩份都會接上**同一個**遊戲：
 *
 *   - 每一段注入都裝兩次，記錄檔裡每一行出現兩次
 *   - 頁面上的補丁是「先拆再裝」的，於是兩份會**互相拆掉對方的東西**
 *     （大廳那顆按鈕「有時候沒出現」就有這一份）
 *   - 兩個引擎各自跟中間人連線、各自算配對
 *
 * `requestSingleInstanceLock()` 是**依 userData 分開**的，而上面那一段已經把
 * userData 依配置分開了 —— 所以多開（不同配置）完全不受影響，被擋掉的
 * 剛好只有「同一份配置開兩份」這一種，也就是我們本來就想擋的那一種。
 *
 * ⚠ 第二份不是安靜地死掉：它會把第一份的視窗叫出來，因為玩家按下「開新實例」
 * 或再點一次捷徑時想看到的就是那個視窗。**但開機自動啟動那次不叫**
 * （`--startup`）—— 開機跳視窗正是 `startMinimized` 要避免的事。
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on("second-instance", (_event, argv) => {
  if (!argv.includes("--startup")) showWindow();
});

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let engine: ArbiterEngine | null = null;
/** 自動更新的把手。「檢查更新」鈕靠它的 `checkNow`。 */
let updater: AutoUpdater | null = null;
let latest: EngineStatus | null = null;
/** 桌面版遊戲視窗標題列上的重新整理鈕（見 title-button.ts）。app ready 之後才建。 */
let titleButton: TitleButton | null = null;
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
 * 每份配置（id）的客戶端有沒有一個開著 debug port 的在回話。
 *
 * ⚠ **這是配置表唯一能對「別份配置」說的話。** 一個托盤實例只綁一個客戶端，
 * 引擎也只看自己那一個 —— 它沒有任何辦法知道另一份配置的插件狀態（那是另一個
 * process，甚至可能根本沒開）。但「那個客戶端有沒有開著」是問得到的：讀它的
 * `DevToolsActivePort`、再問 CDP 的 `/json/version`。
 *
 * 所以表格裡自己那一列顯示引擎的真實狀態，其他列只敢說「遊戲開著／沒有回應」。
 * 混成同一句話會讓玩家以為插件已經在管另一個客戶端了。
 */
const gameAlive = new Map<string, boolean>();
let probeTimer: ReturnType<typeof setInterval> | null = null;

/** 探測間隔。玩家盯著設定頁看的時候要夠即時，但這是每 N 秒的 HTTP 請求。 */
const PROBE_INTERVAL_MS = 4_000;
/** 單次探測的上限。埠沒人聽的話 loopback 會立刻 ECONNREFUSED，這是防它掛住。 */
const PROBE_TIMEOUT_MS = 800;

const probeFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

/**
 * 把每一份配置的客戶端問一遍。
 *
 * ⚠ **只在設定視窗看得見的時候做。** 托盤程式大部分時間是背景常駐的，
 * 沒人在看的時候每四秒發三個 HTTP 請求是純粹的浪費（而且會出現在防火牆與
 * 資源監視器上，看起來像插件在偷偷做什麼）。
 */
async function probeGamePorts(): Promise<void> {
  if (window === null || !window.isVisible()) return;
  const seen = await Promise.all(
    store.profiles.map(async (p): Promise<readonly [string, boolean]> => {
      // 讀這份配置自己那種客戶端的 DevToolsActivePort（`=0` 挑到哪就是哪），
      // 不會抓到另一種客戶端。
      const live = await resolveDebugPort({
        userDataDir: userDataDirFor(p.kind),
        fetchImpl: probeFetch,
      });
      return [p.id, live !== null];
    }),
  );
  gameAlive.clear();
  for (const [id, alive] of seen) gameAlive.set(id, alive);
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
    // 遊戲畫面被蓋住、白畫面、斷線時的後路。不必已經接上遊戲（見 reloadGamePage）。
    { label: "重新整理遊戲", click: () => void refreshGame("托盤選單") },
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
                label:
                  p.name === clientLabel(p.kind) ? p.name : `${p.name}（${clientLabel(p.kind)}）`,
                click: () => launchInstance(p.id),
              })),
      },
    );
  }

  items.push({ type: "separator" }, { label: "結束", click: () => void quit() });
  return Menu.buildFromTemplate(items);
}

/**
 * 玩家自己按的重新整理（標題列鈕、托盤選單）。**不問、不等對戰結束** —— 玩家按
 * 下去多半就是因為畫面卡住了；跟 `applyPendingReload` 那種插件自己想重載的不同。
 */
async function refreshGame(from: string): Promise<void> {
  if (engine === null) return;
  try {
    await engine.reloadGamePage();
    log(`⟳ 重新整理遊戲（${from}）`);
  } catch (err) {
    log(`✗ 重新整理不了：${err instanceof Error ? err.message : String(err)}（遊戲開著嗎？）`);
  }
  pushState();
}

/** 接上桌面版就把標題列鈕貼上去。同一個遊戲程序重複呼叫不做事。 */
async function attachTitleButton(): Promise<void> {
  if (engine === null || titleButton === null) return;
  try {
    const pid = await engine.desktopProcessId();
    if (pid !== null) titleButton.attach(pid);
  } catch {
    // 連線正在死；下次接上再試。
  }
}

function applyPrefs(next: Partial<LinkPrefs>): void {
  engine?.setPrefs(next);
  const prefs = engine?.prefs;
  if (prefs !== undefined) patchProfile({ prefs });
  pushState();
  refreshTray();
}

function pushState(): void {
  window?.webContents.send("ulr:state", snapshot());
}

/**
 * 改這份配置：先改記憶體，不是命令列臨時建的配置（`ephemeral`）才寫回設定檔 ——
 * 臨時配置本來就不在清單裡，寫回去會憑空生出一份。
 */
function patchProfile(patch: Partial<Omit<Profile, "id">>): void {
  profile = { ...profile, ...patch };
  if (!ephemeral) store = updateProfile(profile.id, patch);
}

/** 拆到 pages/*.ts 的設定處理器用的（見 tray-context.ts）。profile／engine 每次讀都是當下的。 */
const trayCtx: TrayContext = {
  get profile() {
    return profile;
  },
  get engine() {
    return engine;
  },
  patchProfile: (patch) => patchProfile(patch),
  log: (line) => log(line),
  pushState: () => pushState(),
};

// 牌組那一大塊（deck-runtime.ts）。latest／cardNames 每次讀當下的值。
initDeckRuntime({
  ctx: trayCtx,
  appDir: APP_DIR,
  latest: () => latest,
  cardNames: () => cardNames,
});
// 迪特赫姆的快速比賽（lobby-runtime.ts）。
initLobbyRuntime({ ctx: trayCtx, appDir: APP_DIR });
// 模組 › 卡面替換（card-art-runtime.ts）。
initCardArtRuntime({ ctx: trayCtx, latest: () => latest });
// 自訂 COST（cost-rule-runtime.ts）。
initCostRuleRuntime({
  ctx: trayCtx,
  appDir: APP_DIR,
  latest: () => latest,
  editProfile: (id, patch) => editProfile(id, patch),
});

/** 一族瀏覽器帶除錯埠開的方式。`target` = 捷徑「目標」欄整行；沒裝就是 `null`。 */
interface BrowserSetup {
  exe: string | null;
  profileDir: string;
  args: string;
  target: string | null;
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
  /**
   * Steam 登入擴充：放在哪、那裡現在是哪一版、安裝包帶的是哪一版。
   * `installed` 跟 `bundled` 不一樣 = 按一下「放好」就會更新。
   */
  steamExt: { dir: string; installed: string | null; bundled: string | null; guideUrl: string };
  /** 網頁版教學頁用：這台機器上的 Chrome／Edge 怎麼帶除錯埠開。 */
  browsers: { chrome: BrowserSetup; edge: BrowserSetup };
  /** 配置 id → 那份的客戶端有沒有在回話。見 `gameAlive` 的註解。 */
  gameAlive: Record<string, boolean>;
  /** 目前載入的 COST 規則摘要。`null` = 沒選。 */
  costRule: (CostRuleInfo & { fileName: string }) | null;
  /**
   * 規則從哪來（`default` 插件附的／`file` 玩家選的／`off` 停用）與實際載到的
   * 是哪一份。
   *
   * ⚠ `mode` 與 `origin` 是兩件事：`mode: "default"` 的人可能載著安裝包那份
   * （`bundled`），也可能載著中間人發下來的新版（`feed`）。畫面要說得出是哪
   * 一種 —— 「我的規則跟對手不一樣」最常見的原因就是一邊還沒收到更新。
   */
  costRuleMode: CostRuleMode;
  costRuleOrigin: CostRuleOrigin | null;
  /**
   * 上一次載入規則失敗的原因。`null` = 沒失敗過。
   *
   * ⚠ **這個欄位不能省。** 載入失敗時 `costRule` 是 `null`，而畫面對
   * `null` 的說法是「還沒選規則」—— 跟「選了但被拒絕」長得一模一樣。
   * 2026-08-15 玩家選了一份 Hash 對不上的規則包，畫面完全沒有變化，
   * 回報是「選了沒反應」：錯誤只寫進了記錄，而記錄在另一頁。
   */
  costRuleError: CostRuleFailure | null;
  limits: {
    minSeconds: number;
    maxSeconds: number;
    minSpeed: number;
    maxSpeed: number;
    /** 「等候套用」秒數的上下限。**畫面不自己寫死**，跟其他限制同一個理由。 */
    minApplyDelay: number;
    maxApplyDelay: number;
  };
  /**
   * 「對戰地點」那個下拉選單裡的地圖（`000`~`013`，含官方選單沒有的四張）。
   *
   * ⚠ **畫面不自己編一份。** 代號與名字住在 `@ulr/cdp-adapter`
   * （`SELECTABLE_STAGES`），而那個代號會被送進開房封包 —— 兩份清單漂開的話，
   * 玩家選的跟開出來的會是不同的地圖，而畫面上完全看不出來。
   *
   * ⚠ 它是常數，卻放進每次都整份重送的快照裡：14 個小物件，跟 COST 表那 1186
   * 筆不是同一個量級（見 `preload.ts` 對 `editor.load` 的說明）。
   */
  selectableStages: readonly { value: string; name: string }[];
  /** 雲端牌組庫上一輪的結果。`null` = 這次開機還沒同步過。 */
  deckSync: DeckSyncStatus | null;
}

// ---------------------------------------------------------------------------
// 對戰地點那一頁（WP-18）
//
// ⚠ **這一頁沒有狀態要跟遊戲要了。** 它只有一格「這一場開在哪」，而那一格
// 記在配置裡（`profile.match.stage`），跟著 `Snapshot` 一起走。
//
// 以前這裡是「自動配對」頁：排隊狀態、房間清單、頻道資訊、兩份 COST 對照、
// 開始／停止。那一整套搬回遊戲裡了 —— 迪特赫姆大廳那顆「快速比賽」按鈕
// （WP-17）跟亞城那顆是同一種東西，而玩家人本來就在遊戲畫面上。托盤這邊
// 留一張要滑三頁的表，只是讓「按一顆按鈕就開打」看起來像要先填一張表。
// ---------------------------------------------------------------------------

/** `ulr:match-prefs` 回的東西。**只有設定** —— 這一頁沒有別的要算了。 */
interface MatchPrefsResult {
  match: MatchPrefs;
}

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

// 模組 › 卡面替換 → card-art-runtime.ts（2026-10-18 搬出去）

// 迪特赫姆的快速比賽與等待人數 → lobby-runtime.ts（2026-10-18 搬出去）

// 本地牌組庫、雲端同步、官方三牌組、等候套用與開戰閘門 → deck-runtime.ts（2026-10-18 搬出去）

/** 安裝包帶的 Steam 登入擴充原始檔（`scripts/build-tray.mjs` 把 assets 整包複製過去）。 */
const STEAM_EXT_SRC = join(__dirname, "assets", "steam-login-extension");
const STEAM_EXT_BUNDLED = extVersion(STEAM_EXT_SRC);
/** 玩家那邊放著哪一版。快照很常送，不每次讀檔 —— 開機讀一次、放好之後更新。 */
let steamExtInstalled = extVersion(STEAM_EXT_DIR);

/**
 * 哪一族啟動時要臨時掛 Steam 登入擴充：只有 Edge，而且要已經放好。理由見 `loadExtensionArgs`。
 * manifest 帶 key，臨時掛上的 ID 跟手動載入的一樣，存的 Steam 帳號不會因此不見。
 */
function autoLoadExtDir(family: "chrome" | "edge"): string | null {
  return family === "edge" && steamExtInstalled !== null ? STEAM_EXT_DIR : null;
}

/**
 * 這一族瀏覽器在這台機器上怎麼帶除錯埠開：網頁版教學頁照這個畫「捷徑目標」，
 * 桌面捷徑也照這個寫。`exe === null` = 沒裝（或裝在找不到的地方）。
 *
 * 執行檔開機找一次就好 —— 快照很常送，而裝新瀏覽器之後重開插件不算過分。
 */
const browserExe = {
  chrome: findBrowser(process.env, "chrome")?.path ?? null,
  edge: findBrowser(process.env, "edge")?.path ?? null,
};

function browserSetup(family: "chrome" | "edge"): BrowserSetup {
  const exe = browserExe[family];
  const profileDir = userDataDirFor(family);
  const args = buildBrowserShortcutArgs(profileDir, autoLoadExtDir(family));
  return { exe, profileDir, args, target: exe === null ? null : `"${exe}" ${args}` };
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
    steamExt: {
      dir: STEAM_EXT_DIR,
      installed: steamExtInstalled,
      bundled: STEAM_EXT_BUNDLED,
      guideUrl: STEAM_EXT_GUIDE_URL,
    },
    browsers: { chrome: browserSetup("chrome"), edge: browserSetup("edge") },
    gameAlive: Object.fromEntries(gameAlive),
    costRule: costRule === null ? null : { ...costRule, fileName: basename(costRule.path) },
    costRuleError: costRuleError,
    costRuleMode: profile.costRuleMode,
    costRuleOrigin: costRuleOrigin,
    limits: {
      minSeconds: MIN_PHASE_SECONDS,
      maxSeconds: MOVE_PHASE_TOTAL_SECONDS,
      minSpeed: MIN_SPEED_FACTOR,
      maxSpeed: MAX_SPEED_FACTOR,
      minApplyDelay: MIN_APPLY_DELAY_SECONDS,
      maxApplyDelay: MAX_APPLY_DELAY_SECONDS,
    },
    selectableStages: SELECTABLE_STAGES,
    deckSync: currentDeckSyncStatus(),
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
    // 2026-09-17 字級整體放大 2px（原本照遊戲面板的密度，實際讀起來太小），
    // 視窗跟著等比例放大，比例不變。
    width: 860,
    height: 724,
    minWidth: 760,
    minHeight: 620,
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
/** 收完之後用同一份配置再開一次自己。見 `restart()`。 */
let relaunchAfterQuit = false;

/**
 * 換客戶端種類要重開：引擎綁在啟動時的埠與 user-data-dir 上（跟改埠一樣）。
 *
 * ⚠ 新的那份要等舊的**整個收完**才開：`quit()` 會等引擎把頁面上的攔截拆乾淨，
 * 而單一實例鎖也要先放掉，否則新的那份一起來就撞鎖、安靜地退出。
 */
async function restart(): Promise<void> {
  relaunchAfterQuit = true;
  await quit();
}

async function quit(): Promise<void> {
  quitting = true;
  if (probeTimer !== null) clearInterval(probeTimer);
  probeTimer = null;
  stopDeckRuntime();
  // 人數那一拍、推播線、排隊中的話把自己從佇列上拿掉（見 stopLobbyRuntime）。
  await stopLobbyRuntime();
  // ⚠ 一定要等引擎收乾淨：它會把頁面上的攔截拆掉。留著孤兒的話遊戲裡的
  // OK 鈕會有 3 秒（心跳）處在沒人管的狀態。
  await engine?.stop();
  titleButton?.dispose();
  tray?.destroy();
  if (relaunchAfterQuit) {
    app.releaseSingleInstanceLock();
    launchInstance(profile.id);
  }
  app.quit();
}

// 自訂 COST（載入規則、推給引擎、編輯器）→ cost-rule-runtime.ts（2026-10-18 搬出去）

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
    // 不給埠 = 只讀這個目錄的 DevToolsActivePort（標準作業流程是 `=0`）。目錄跟著
    // kind 走，所以找到的一定是這份配置要管的那個客戶端。命令列 `--port` 才帶埠。
    ...(profile.cliPort !== undefined ? { port: profile.cliPort } : {}),
    userDataDir: userDataDirFor(profile.kind),
    link: profile.link,
    prefs: profile.prefs,
    readyTint: profile.readyTint,
    onLog: (line) => {
      log(line);
      pushState();
    },
    onStatus: (status) => {
      // ⚠ 斷線就把「這條連線自動重載過了」忘掉。玩家關掉遊戲再開是家常便飯，
      // 而那是一個全新的頁面 —— 沿用上一條連線的旗標會讓新的那次救不回來。
      if (latest?.connected === true && !status.connected) {
        forgetAutoReload();
        stopCardNamesFetch();
        // ⚠ 牌組庫也要重新確認帳號。玩家關掉遊戲再開很可能**換一個帳號登入**，
        // 而牌組庫是跟著帳號走的 —— 沿用上一個人的庫會把 A 的牌組存進 B 的檔案。
        resetDeckSession();
      }
      const justConnected = latest?.connected !== true && status.connected;
      latest = status;
      pushState();
      refreshTray();
      // 卡面替換要用中文檔名對卡，名字表只有客戶端知道 —— 接上就去讀一份。
      if (justConnected) startCardNamesFetch();
      if (justConnected) void attachTitleButton();
      // 有規則等著套用的話，這裡是唯一會知道「對戰結束了」的地方。
      void applyPendingReload();
    },
    // ⚠⚠ 同一個分頁換帳號**不會斷線**，只會重載 —— 見 onDeckPageReload。
    onPageReload: () => onDeckPageReload(),
  });

  // ⚠ 要在 engine 建好之後 —— loadCostRule 會呼叫 engine.setCostOverrides()。
  applyCostRule();
  // ⚠ 同樣要在 engine 建好之後。這裡只是把玩家上次的選擇交給引擎，真正裝到
  // 頁面上是接上遊戲之後的事（`#syncHiddenStages`）。
  engine.setHiddenStages(profile.hiddenStages);
  // 人物篩選同理（新的引擎 = 還沒推過）。最愛要等牌組庫接上才有。
  repushDeckOverlays();
  // 卡面替換：資料夾裡的 PNG 交給引擎，接上遊戲時裝；之後盯著資料夾。
  installCardMods();
  reloadCardArt(true);
  installBlanks();
  watchCardArtDir();
  // 渦擊破結算的 OK 面板模式同理；玩家在遊戲裡的面板上切了也要記回配置。
  engine.setRaidRewardMode(profile.raidRewardMode);
  engine.setRaidShare(profile.raidShare);
  engine.setRaidTeamShare(profile.raidTeamShare);
  // 自己打渦的紀錄：讀硬碟交給引擎，每多一場就回寫（見 raid-battle-store.ts）
  engine.setRaidBattles(readRaidBattles());
  engine.onRaidBattlesChanged((records) => {
    if (ephemeral) return;
    try {
      writeRaidBattles(records);
    } catch (err) {
      log(`✗ 打渦紀錄存檔失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // 結束的渦拿到獎勵了沒：同理，托盤重開後「今天」的數字接得上（見 raid-outcome-store.ts）
  engine.setRaidOutcomeState(readRaidOutcomes());
  engine.onRaidOutcomesChanged((state) => {
    if (ephemeral) return;
    try {
      writeRaidOutcomes(state);
    } catch (err) {
      log(`✗ 渦結算紀錄存檔失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // HighLow 的開始星數同理（見 quest-bonus-store.ts）
  engine.setQuestBonusSamples(readQuestBonus());
  engine.onQuestBonusChanged((samples) => {
    if (ephemeral) return;
    try {
      writeQuestBonus(samples);
    } catch (err) {
      log(`✗ HighLow 開始星數存檔失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // 學到的渦獎勵表同理：讀硬碟交給引擎，每學到一次就回寫（見 raid-learned-store.ts）
  const learnedOnDisk = readRaidLearned();
  engine.setRaidLearned(learnedOnDisk.table, learnedOnDisk.log);
  engine.onRaidLearnedChanged((table, learnLog) => {
    if (ephemeral) return;
    try {
      writeRaidLearned(table, learnLog);
    } catch (err) {
      log(`✗ 渦獎勵表存檔失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  engine.setRaidAutoDelete({
    enabled: profile.raidAutoDelete,
    prompt: profile.raidAutoDeletePrompt,
  });
  engine.setItemShortcut(profile.raidItemShortcut);
  engine.setRaidHistoryButton(profile.raidHistoryButton);
  engine.setRaidDiscover(raidDiscoverSetting(profile));
  engine.setQuestItemShortcut("stack", profile.questStackShortcut);
  engine.setQuestItemShortcut("passes", profile.questPassShortcut);
  engine.setDietOverlay("dietStack", profile.dietItemShortcut);
  engine.setDietOverlay("gemUp", profile.dietGemUp);
  engine.setBattleSurrender(battleSurrenderOptions(profile));
  engine.setBonusItemShortcut(profile.bonusItemShortcut);
  engine.setBonusItemOrder(profile.bonusItemOrder);
  engine.setBonusItemPlace(profile.bonusItemPlace);
  engine.setBonusHighLow(profile.bonusHighLow);
  engine.setBonusFast(profile.bonusFast);
  engine.setBonusRescueFast(profile.bonusRescueFast);
  engine.setBonusSkipEnd(profile.bonusSkipEnd);
  engine.setBonusClimb(profile.bonusClimb);
  engine.setQuestTreasure(profile.questTreasureMarks);
  engine.setQuestPanel("reward", profile.questRewardPanel);
  engine.setQuestPanel("end", profile.questEndPanel);
  engine.setQuestSkipResult(profile.questSkipResult);
  engine.onRaidAutoDeleteChanged((setting) => {
    patchProfile({ raidAutoDelete: setting.enabled, raidAutoDeletePrompt: setting.prompt });
    log(
      setting.enabled
        ? "· 自動刪除死渦已開啟（在遊戲裡開的）"
        : "· 自動刪除死渦已停用（在遊戲裡關的；要再開請到 渦 › 結算通知）",
    );
    pushState();
  });
  engine.onRaidRewardModeChanged((mode) => {
    patchProfile({ raidRewardMode: mode });
    log(`· 渦結算通知改為「${describeRaidRewardMode(mode)}」（在遊戲裡切的）`);
    pushState();
  });
  // 畫面設定（解析度／畫面大小）：只在遊戲的 Option › plugin 分頁改，托盤只負責記住。
  engine.setDisplay(profile.display);
  engine.onDisplayChanged((display) => {
    patchProfile({ display });
    log(`· 畫面設定改為 解析度 ${display.render}、畫面大小 ${display.size}（在遊戲裡改的）`);
  });

  titleButton = new TitleButton({
    onClick: () => void refreshGame("標題列按鈕"),
    log,
    env: (() => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ENV_KEYS_TO_STRIP) delete env[key];
      return env;
    })(),
  });

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
    patchProfile({ readyTint: applied });
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
    (_event, id: string, patch: { name?: string; kind?: ClientKind }) => {
      // 只挑這兩格。中間人不給改（見 Profile.link）、埠已經沒有了（2026-10-10），
      // 渲染層送什麼來都不收。種類撞到別份的話 `updateIn` 不收那一格。
      const { name, kind } = patch;
      editProfile(id, {
        ...(name !== undefined ? { name } : {}),
        ...(kind !== undefined ? { kind } : {}),
      });
      return snapshot();
    },
  );
  /**
   * 設置 › 關於 的「檢查更新」：現在就問一次，不必等每小時那一輪。
   *
   * 跟自動的同一條路（updater.ts 的 `checkNow`）：有新版就下載，不在對戰中就當場
   * 套用、插件自己重開；對戰中就等打完。回一句給畫面看的話。
   */
  ipcMain.handle("ulr:update-check", async (): Promise<string> => {
    if (updater === null) return "自動更新還沒啟動";
    log("· 手動檢查更新");
    return await updater.checkNow();
  });

  // 自訂COST 與 牌組 那幾頁（pages/cost-page.ts、pages/deck-page.ts）
  registerCostPage(ipcMain, trayCtx, {
    pickCostFile: async () => {
      const owner = window;
      const result = await (owner === null
        ? dialog.showOpenDialog({ properties: ["openFile"], filters: COST_FILE_FILTERS })
        : dialog.showOpenDialog(owner, { properties: ["openFile"], filters: COST_FILE_FILTERS }));
      return result.canceled ? undefined : result.filePaths[0];
    },
    editProfile: (id, patch) => editProfile(id, patch),
    snapshot: () => snapshot(),
    latest: () => latest,
  });
  registerDeckPage(ipcMain, trayCtx);

  // -------------------------------------------------------------------------
  // 對戰地點（WP-18）
  //
  // ⚠ **只剩一支，而且它不碰遊戲。** `match-state` 與 `match-queue-start`／`stop`
  // 拿掉了：排隊的入口在**遊戲大廳那顆按鈕**（WP-17），而那條路從頭到尾
  // 都在主程序裡（`onLobbyQuick`）。畫面這邊只剩下「這一場開在哪」一格。
  // -------------------------------------------------------------------------

  /**
   * 改「這一場開在哪」並**記進配置**。
   *
   * ⚠ 它**不碰遊戲**，只是存偏好。所以畫面可以在玩家一改就叫，不必等按什麼
   * 按鈕（改完就生效，下一次配對用的就是新的）。
   *
   * ⚠ 走 `profile = {...}` 而不是 `editProfile`：臨時配置（`--port` 對不上
   * 任何一份時建的）不在清單裡，`editProfile` 對它是完全的空操作 —— 症狀是
   * 「改了設定，下一次重畫又跳回去」。跟 `ulr:set-tint` 同一招。
   *
   * ⚠ 回主程序整理過的那一份，畫面拿它蓋回去 —— 認不得的值會被夾成預設，
   * 而畫面自己留一份的話會跟設定檔漂開。
   */
  ipcMain.handle("ulr:match-prefs", (_event, patch: unknown): MatchPrefsResult => {
    const next = normalizeMatchPrefs({ ...profile.match, ...(patch as object) });
    patchProfile({ match: next });
    pushState();
    return { match: next };
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
    patchProfile({ hiddenStages: on });
    engine?.setHiddenStages(on);
    log(on ? "· 隱藏地圖已啟用（開房選單會多四張）" : "· 隱藏地圖已停用，選單回官方那 11 項");
    pushState();
    return { enabled: on, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

  // -------------------------------------------------------------------------
  // 模組：卡面替換
  // -------------------------------------------------------------------------

  ipcMain.handle("ulr:mods-cards-state", async (): Promise<CardArtPageState> => cardArtPageState());

  /**
   * 開資料夾。⚠ 路徑是主程序定的，渲染層只能說「開那個資料夾」——
   * 跟 `open-external` 的白名單同一條原則。
   */
  ipcMain.handle("ulr:mods-cards-open", async (): Promise<CardArtPageState> => {
    ensureCardArtDir(CARD_ART_DIR);
    const err = await shell.openPath(CARD_ART_DIR);
    if (err !== "") log(`✗ 開不了卡面資料夾：${err}`);
    return cardArtPageState();
  });

  ipcMain.handle("ulr:mods-cards-reload", async (): Promise<CardArtPageState> => {
    reloadCardArt();
    pushState();
    return cardArtPageState();
  });

  /** 開空框資料夾。玩家整個刪掉過的話先補回來。 */
  ipcMain.handle("ulr:mods-cards-open-blanks", async (): Promise<CardArtPageState> => {
    installBlanks();
    const err = await shell.openPath(CARD_ART_BLANKS_PATH);
    if (err !== "") log(`✗ 開不了空框資料夾：${err}`);
    return cardArtPageState();
  });

  // 渦／任務／迪城／獎勵那幾頁的開關（pages/*.ts）
  registerRaidPage(ipcMain, trayCtx);
  registerQuestPage(ipcMain, trayCtx);
  registerDietPage(ipcMain, trayCtx);
  registerBonusPage(ipcMain, trayCtx);

  /** 重新推一次。給「等太久放棄了」那個收尾狀態用的按鈕。 */
  ipcMain.handle("ulr:stages-retry", async (): Promise<StagePageState> => {
    await engine?.applyHiddenStages();
    return { enabled: profile.hiddenStages, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

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

  /**
   * 換這份配置的客戶端種類，然後重開自己（見 `restart()`）。
   *
   * ⚠ 命令列開的臨時配置不收：它不在清單裡，重開時 `--profile <id>` 找不到它，
   * 會落到別份配置上。
   */
  ipcMain.handle("ulr:client-kind", async (_event, raw: unknown) => {
    if (raw !== "desktop" && raw !== "chrome" && raw !== "edge") return snapshot();
    if (ephemeral || raw === profile.kind) return snapshot();
    // 別份已經是這一種：`updateIn` 不會收，重開只是白重開一次。
    if (kindTaken(store, raw, profile.id)) {
      log(`⚠ 已經有一份 ${clientLabel(raw)} 的配置了，同一種客戶端只能有一份`);
      pushState();
      return snapshot();
    }
    log(`· 客戶端改為 ${raw}，重開插件`);
    editProfile(profile.id, { kind: raw });
    await restart();
    return snapshot();
  });

  /** 瀏覽器那一族。桌面版沒有這些按鈕，按到了也不做事。 */
  const browserFamily = (): "chrome" | "edge" | null =>
    profile.kind === "chrome" || profile.kind === "edge" ? profile.kind : null;

  /**
   * 用插件專用的 profile 開瀏覽器，帶 `--remote-debugging-port=0`。
   * 已經開著（而且有除錯埠）就不重開 —— 玩家可能正在裡面打。
   *
   * `family` 可以跟這份配置接的客戶端不同（設置 › 啟動 那兩顆鈕）：開出來的是
   * 那一族自己的 profile，插件不一定接它，給 Moon 之類的外部腳本用。
   */
  async function openBrowser(family: "chrome" | "edge", extPage: string | null) {
    try {
      const r = await ensureBrowser({
        family,
        // 只拿來問「是不是已經開著」—— `alwaysAutoPort` 一律用 `=0` 開，而判斷
        // 「開著」時檔案（profileDir 的 DevToolsActivePort）優先於這個埠。
        port: browserDebugPort(family),
        profileDir: userDataDirFor(family),
        alwaysAutoPort: true,
        // Edge 每次啟動都臨時掛上 Steam 登入擴充（見 loadExtensionArgs）。資料夾裡沒有
        // 擴充就不帶，照常開。
        ...(autoLoadExtDir(family) !== null ? { extraArgs: loadExtensionArgs(STEAM_EXT_DIR) } : {}),
        startUrl: extPage,
        onNotice: (m) => log(`· ${m}`),
      });
      // 已經開著：再叫一次同一個 profile，網址會交給那個實例開成新分頁。
      if (!r.launched && extPage !== null) {
        const exe = findBrowser(process.env, family);
        if (exe !== null) {
          const env = { ...process.env };
          delete env["ELECTRON_RUN_AS_NODE"];
          spawn(exe.path, [`--user-data-dir=${r.profileDir}`, extPage], {
            detached: true,
            stdio: "ignore",
            env,
          }).unref();
        }
      }
      const label = clientLabel(family);
      log(`· ${label}${r.launched ? "已開啟" : "已經開著"}（除錯埠 :${r.port}）`);
      return { ok: true, text: `${label} ${r.launched ? "已開啟" : "已經開著"}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`⚠ 開 ${clientLabel(family)} 失敗：${msg.split("\n")[0]}`);
      return {
        ok: false,
        text:
          e instanceof BrowserNotFoundError
            ? `找不到 ${clientLabel(family)}`
            : "開了，但沒有除錯埠 —— 這個設定檔的視窗可能已經開著。全部關掉再按一次。",
      };
    }
  }

  ipcMain.handle("ulr:browser-open", async (_event, page?: unknown) => {
    const family = browserFamily();
    if (family === null) return { ok: false, text: "" };
    // 只收一個固定值：渲染層不能叫我們開任意網址（同 open-external 的原則）。
    return openBrowser(family, page === "extensions" ? `${family}://extensions` : null);
  });

  /**
   * 指定哪一族開，跟這份配置接哪種客戶端無關。只收 chrome／edge；
   * `page` 只收 `"extensions"`（裝 Steam 登入擴充那一步）。
   */
  ipcMain.handle("ulr:browser-launch", async (_event, raw: unknown, page?: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    return openBrowser(raw, page === "extensions" ? `${raw}://extensions` : null);
  });

  /**
   * 在桌面放一個帶除錯埠的捷徑。內容跟教學頁上那行「目標」一字不差
   * （同一個 `browserSetup()`）。同名的直接蓋掉 —— 旗標改了再按一次就是更新。
   */
  ipcMain.handle("ulr:browser-shortcut", async (_event, raw: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    const s = browserSetup(raw);
    if (s.exe === null) return { ok: false, text: `找不到 ${clientLabel(raw)}` };
    const name = `ULR ${clientLabel(raw)}`;
    const lnk = join(app.getPath("desktop"), `${name}.lnk`);
    const ok = shell.writeShortcutLink(lnk, "create", {
      target: s.exe,
      args: s.args,
      cwd: dirname(s.exe),
      icon: s.exe,
      iconIndex: 0,
      description: `${clientLabel(raw)}（帶除錯埠，ULR Companion 用）`,
    });
    log(ok ? `· 桌面捷徑：${lnk}` : `⚠ 寫不出桌面捷徑：${lnk}`);
    return ok
      ? { ok: true, text: `桌面多了「${name}」` }
      : { ok: false, text: "寫不出捷徑 —— 桌面資料夾可能被防毒或權限擋住。" };
  });

  /** 把捷徑「目標」整行放進剪貼簿。字串由主程序決定（同 `copy-debug-flag`）。 */
  ipcMain.handle("ulr:browser-copy-target", async (_event, raw: unknown) => {
    if (raw !== "chrome" && raw !== "edge") return { ok: false, text: "" };
    const t = browserSetup(raw).target;
    if (t === null) return { ok: false, text: `找不到 ${clientLabel(raw)}` };
    clipboard.writeText(t);
    return { ok: true, text: "已複製" };
  });

  /** 同一件事存成 .cmd，給想放捷徑、或不開插件也要開的人。 */
  ipcMain.handle("ulr:browser-save-cmd", async () => {
    const family = browserFamily();
    if (family === null) return { ok: false, text: "" };
    const owner = window;
    const opts = {
      defaultPath: join(app.getPath("desktop"), `ULR-${clientLabel(profile.kind)}.cmd`),
      filters: [{ name: "cmd", extensions: ["cmd"] }],
    };
    const r = await (owner === null
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(owner, opts));
    if (r.canceled || r.filePath === undefined) return { ok: false, text: "" };
    writeFileSync(r.filePath, buildBrowserLaunchCmd(family), "ascii");
    return { ok: true, text: `已存到 ${r.filePath}` };
  });

  /** 把 Steam 登入擴充放到 `STEAM_EXT_DIR`，打開那個資料夾。 */
  ipcMain.handle("ulr:steam-ext-install", async () => {
    try {
      const r = exportExtension(STEAM_EXT_SRC, STEAM_EXT_DIR);
      steamExtInstalled = r.version;
      log(`· Steam 登入擴充 ${r.version ?? "?"} 放到 ${r.dir}`);
      void shell.openPath(r.dir);
      pushState();
      return { ok: true, text: "已放好" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`⚠ 放 Steam 登入擴充失敗：${msg}`);
      return { ok: false, text: msg };
    }
  });

  ipcMain.handle("ulr:open-external", async (_event, url: string) => {
    // ⚠ 白名單，不是「開啟渲染層給的任何東西」。渲染層被塞了一段腳本時，
    // `shell.openExternal` 是它唯一能碰到外面的東西。
    if (!/^https:\/\/(github\.com|ulgg\.online|hackmd\.io)\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  probeTimer = setInterval(() => void probeGamePorts(), PROBE_INTERVAL_MS);

  // 迪特赫姆大廳那顆「快速比賽」與人數那幾行（lobby-runtime.ts）。
  startLobbyRuntime(engine);

  // 牌組庫、最愛、首頁立繪、開戰前套牌組：事件與兩個計時器（deck-runtime.ts）。
  startDeckRuntime(engine);

  void engine.start();
  // 靜默下載、安全的時機才套用。細節與那個「安全」的定義見 updater.ts。
  updater = startAutoUpdate({
    currentVersion: VERSION,
    isBusy: () => latest?.armed === true,
    quit: () => void quit(),
    onLog: (l) => log(l),
  });

  /**
   * 預設 COST 表的自動更新。**只在預設模式下做事** —— 玩家自己選了檔的話，
   * 我們一個位元組都不該碰他的規則。
   *
   * ⚠ 收到新規則之後**不重載遊戲**：引擎當場改快取（跟「Cost 表」換規則同一條路，
   * 見 `changeCostRule`）。
   */
  startRuleFeed({
    appDir: APP_DIR,
    ruleSetId: costRuleFull?.ruleSetId ?? null,
    currentVersion: costRule?.version ?? null,
    onLog: (l) => log(l),
    onRule: (next) => {
      if (profile.costRuleMode !== "default") {
        log(`· 收到新的預設 COST 表 ${next.version}，但你現在用的是自己選的規則，沒有套用`);
        return;
      }
      applyCostRule();
      pushState();
    },
  });

  // 上一次換檔（zip 版）留下來的 `*.ulrold`。**執行中的檔案只能改名不能刪**，
  // 所以清理一定得等到下一次啟動 —— 也就是現在。
  {
    const stale = cleanupStaleFiles(dirname(process.execPath));
    if (stale > 0) log(`· 已清掉上次更新留下的 ${stale} 個舊檔`);
    // 暫存區同理：下載的 zip 與解開的那一份，重開之後沒有一樣還用得到。
    // 開發模式不碰（更新那條線在開發模式整支沒啟動，見 updater.ts）。
    if (app.isPackaged) cleanupUpdateLeftovers(join(app.getPath("userData"), "updates"));
  }

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

// ⚠ 任何一條路叫了 `app.quit()`，設定視窗的 `close` 都要放行。少了這一行，
// 沒有先把 `quitting` 設起來的 `app.quit()` 會被那個處理器**安靜地取消**
// （它以為是使用者按了 X）—— 自動更新就這樣卡了一版，見 `UpdaterOptions.quit`。
app.on("before-quit", () => {
  quitting = true;
});
