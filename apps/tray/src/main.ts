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

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
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
import { DEFAULT_DECK_SYNC_URL } from "@ulr/arbiter-link";
import {
  matchKey,
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  queueCountUrl,
  QueueWatcher,
  ruleTag,
} from "@ulr/arbiter-link";
import {
  BrowserNotFoundError,
  browserDebugPort,
  buildBrowserLaunchCmd,
  buildBrowserShortcutArgs,
  canAffordDuel,
  costTiersFor,
  DEBUG_PORT_SWITCH_AUTO,
  detectGameInstall,
  duelApCost,
  ENV_KEYS_TO_STRIP,
  ensureBrowser,
  findBrowser,
  HIDDEN_STAGES,
  loadExtensionArgs,
  isBonusItemOrder,
  isBonusItemPlace,
  isCharaPickerMode,
  isRaidRewardMode,
  resolveDebugPort,
  ROOM_ERROR_AP_SHORT,
  SELECTABLE_STAGES,
  summarizeQuestBonus,
} from "@ulr/cdp-adapter";
import type {
  BonusItemOrder,
  BonusItemPlace,
  QuestBonusStats,
  CardArtStatus,
  CharaPickerMode,
  CharaPickerReport,
  BattleSurrenderOptions,
  LobbyStandReport,
  DeckEditReport,
  DeckSnapshot,
  DuelAffordability,
  HiddenStageStatus,
  ItemPanelStatus,
  QuestTreasureStatus,
  LobbyQuickPressed,
  LobbyTierCount,
  MatchContext,
  RaidRewardMode,
  RaidRewardStatus,
  RaidSurrenderStatus,
  RaidViewStatus,
  RoomGateReport,
} from "@ulr/cdp-adapter";
import type { CharaFiles, DeckContent, Inventory, RoomKind } from "@ulr/deck-library";
import {
  addDeck,
  deckContentFromServer,
  deckContentHash,
  displayName,
  emptyDeckContent,
  favoriteCards,
  favoriteEvents,
  findDeck,
  findSetShortages,
  findShortages,
  guardDeck1,
  hiddenWeapons,
  isEmptyDeck,
  listDecks,
  lobbyStand,
  // ⚠ 「這一房選的是哪一副」是庫裡的**意圖**（開戰前要寫進伺服器的正是它），
  // 跟算出來的 active 不是同一件事。見 ensureRoomDeck()。
  resolveSelected,
  ROOM_KINDS,
  ROOM_LABELS,
  setFavoriteCard,
  setFavoriteEvent,
  setHiddenWeapon,
  setLobbyStandSets,
  setLobbyStandUi,
  stockTable,
  substituteCharas,
  withDeckContent,
} from "@ulr/deck-library";
import {
  bandForTotal,
  MatchPairing,
  ROOM_MULTI,
  teamCostCenti,
  tierForTotal,
} from "@ulr/arbiter-engine";
import type { PairingStatus } from "@ulr/arbiter-engine";
import { deckFromKeys } from "@ulr/cost-engine";
import type { CardCatalog, CompressionRule, CostRule, GapBand } from "@ulr/rule-schema";
import {
  assertCostRule,
  catalogSize,
  contentHash,
  createRulePackage,
  formatCentiCost,
  loadRulePackage,
  parseEquipmentKey,
  parseEventCardKey,
  shortHash,
  toCardIdTable,
  legacyWeaponId,
  legacyEventId,
} from "@ulr/rule-schema";
import { readCatalog, writeCatalog } from "./catalog-store.js";
import type { CardArtFile, CardArtScan, CardNames } from "./card-art.js";
import {
  CARD_ART_BLANKS_DIR,
  countBlanks,
  ensureCardArtDir,
  installBundledBlanks,
  installDefaultMods,
  readCardNames,
  resolveCardFrame,
  scanCardArtDir,
} from "./card-art.js";
import type { ActiveDeckMode, DeckSession } from "./deck-core.js";
import {
  applyLanded,
  applyOfficialReport,
  applyReport,
  autoSave,
  deckEditStateOf,
  enterRoom,
  followDeckOnEdit,
  officialAutoSave,
  officialRoomOf,
  officialSetOf,
  roomDeckPreloadOf,
  expireNotice,
  isApplyDue,
  migrateServerDecks,
  newSession,
  resolveActive,
  resolveAll,
  sameSet,
  seedAllRooms,
  slotWrite,
  withNotice,
} from "./deck-core.js";
import { DeckSeen, worldOf } from "./deck-seen.js";
import { backupOnce, readLibrary, writeLibrary } from "./deck-store.js";
import { syncDeckLibrary, type FetchLike } from "./deck-sync.js";
import { bundledRulePath, resolveDefaultRule } from "./default-rule.js";
import type { TierRef } from "./lobby-counts.js";
import { displayCounts, tierOf } from "./lobby-counts.js";
import { trayIconPng } from "./icon.js";
import type { IconState } from "./icon.js";
import { launchAtLoginEnabled, launchInstance, setLaunchAtLogin } from "./launch.js";
import { openLogFile } from "./log-file.js";
import { readRaidBattles, writeRaidBattles } from "./raid-battle-store.js";
import { readRaidOutcomes, writeRaidOutcomes } from "./raid-outcome-store.js";
import { readRaidLearned, writeRaidLearned } from "./raid-learned-store.js";
import { readQuestBonus, writeQuestBonus } from "./quest-bonus-store.js";
import type {
  ClientKind,
  CostRuleMode,
  DeckMode,
  MatchPrefs,
  Profile,
  ProfileStore,
} from "./profiles.js";
import {
  addProfile,
  clientLabel,
  defaultPortFor,
  isDeckMode,
  EDIT_STEPS,
  EDIT_UNITS,
  loadStore,
  markUsed,
  MAX_APPLY_DELAY_SECONDS,
  MIN_APPLY_DELAY_SECONDS,
  normalizeApplyDelaySeconds,
  normalizeEditStep,
  normalizeEditUnit,
  normalizeMatchPrefs,
  removeProfile,
  resolveProfile,
  updateOptions,
  updateProfile,
  userDataDirFor,
} from "./profiles.js";
import { startRuleFeed } from "./rule-feed.js";
import { TitleButton } from "./title-button.js";
import { BUNDLE_REPORT_INTERVAL_MS, createBundleReporter, readPushToken } from "./bundle-report.js";
import { consumeUpdatedFlag, startAutoUpdate } from "./updater.js";
import { cleanupStaleFiles } from "./zip-update.js";
import {
  BOOT_EXT_DIR,
  bootExtVersion,
  exportBootExtension,
  gameFontDirs,
  USERSCRIPT_GUIDE_URL,
} from "./web-client.js";

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

// ⚠ 關卡 1：兩份實例不能共用 userData。
// 必須在 app ready 之前設，而且要在讀完配置之後 —— 埠是從配置來的。
{
  // `loadStore()` 會用到 app.getPath，那在 ready 之前就可以呼叫。
  store = loadStore();
  const resolved = resolveProfile(store, process.argv);
  profile = resolved.profile;
  ephemeral = resolved.ephemeral;
  app.setPath("userData", join(APP_DIR, `port-${profile.port}`));
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
 * userData 依埠分開了 —— 所以多開（不同配置＝不同埠）完全不受影響，被擋掉的
 * 剛好只有「同一個埠開兩份」這一種，也就是我們本來就想擋的那一種。
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
                label: `${p.name}  :${p.port}`,
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
   * ULR Boot 擴充：放在哪、那裡現在是哪一版、安裝包帶的是哪一版。
   * `installed` 跟 `bundled` 不一樣 = 按一下「放好」就會更新。
   */
  bootExt: { dir: string; installed: string | null; bundled: string | null; guideUrl: string };
  /** 網頁版教學頁用：這台機器上的 Chrome／Edge 怎麼帶除錯埠開。 */
  browsers: { chrome: BrowserSetup; edge: BrowserSetup };
  /** 遊戲埠 → 那個埠上有沒有客戶端在回話。見 `gamePorts` 的註解。 */
  gamePorts: Record<number, boolean>;
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

interface DeckSyncStatus {
  /** `Date.now()`。 */
  at: number;
  ok: boolean;
  /** 給人看的一句話。 */
  text: string;
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

function describeRaidRewardMode(mode: RaidRewardMode): string {
  return mode === "all" ? "全部通知" : mode === "none" ? "不再通知" : "只通知一次";
}

// ---------------------------------------------------------------------------
// 模組 › 卡面替換
// ---------------------------------------------------------------------------

/**
 * 玩家的卡面放這裡。**不分實例**（跟記錄檔一樣放 `APP_DIR`）：卡面是玩家的
 * 美術，多開的兩份客戶端本來就該看到同一套。
 */
const CARD_ART_DIR = join(APP_DIR, "mods", "cards");
/** 角色代號 → 中文名。第一次接上遊戲時讀的，之後離線也能對檔名。 */
const CARD_NAMES_PATH = join(APP_DIR, "mods", "card-names.json");

let cardNames: CardNames | null = readCardNames(CARD_NAMES_PATH);
let cardArtScan: CardArtScan = { files: [], entries: [] };
let cardArtWatcher: FSWatcher | null = null;
let cardArtDebounce: ReturnType<typeof setTimeout> | null = null;
/** 接上遊戲後每隔幾秒試著讀名字表，讀到就停（標題畫面時 profile 還沒載）。 */
let cardNamesTimer: ReturnType<typeof setInterval> | null = null;

/** 重讀資料夾並推給引擎。`quiet` 時不寫 log（開機那一次、檔案監看的抖動）。 */
function reloadCardArt(quiet = false): void {
  ensureCardArtDir(CARD_ART_DIR);
  cardArtScan = scanCardArtDir(CARD_ART_DIR, cardNames);
  engine?.setCardArt(cardArtScan.entries);
  if (!quiet || cardArtScan.files.length > 0) {
    const skipped = cardArtScan.files.length - cardArtScan.entries.length;
    log(
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
function watchCardArtDir(): void {
  if (cardArtWatcher !== null) return;
  try {
    ensureCardArtDir(CARD_ART_DIR);
    cardArtWatcher = watch(CARD_ART_DIR, { persistent: false }, () => {
      if (cardArtDebounce !== null) clearTimeout(cardArtDebounce);
      cardArtDebounce = setTimeout(() => {
        cardArtDebounce = null;
        reloadCardArt();
        pushState();
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
function startCardNamesFetch(): void {
  if (cardNamesTimer !== null) return;
  const attempt = async (): Promise<void> => {
    if (engine === null || latest?.connected !== true) return;
    try {
      const fresh = await engine.readCardNames();
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

function stopCardNamesFetch(): void {
  if (cardNamesTimer !== null) clearInterval(cardNamesTimer);
  cardNamesTimer = null;
}

/** 卡面替換那一頁要畫的東西。 */
interface CardArtPageState {
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

const CARD_ART_BLANKS_PATH = join(CARD_ART_DIR, CARD_ART_BLANKS_DIR);

/**
 * 內建空框複製到玩家資料夾。開機一次、按「開空框資料夾」時再補一次
 * （玩家可能整個刪掉過）。build-tray.mjs 把 `apps/tray/assets` 搬到 `dist/assets`。
 */
function installBlanks(): void {
  try {
    const r = installBundledBlanks(join(__dirname, "assets", "card-frames"), CARD_ART_BLANKS_PATH);
    if (r.bundled === 0) log("✗ 插件裡找不到內建的空框（assets/card-frames）");
    else if (r.written > 0) log(`· 卡面替換：空框放好 ${r.written} 張（${CARD_ART_BLANKS_PATH}）`);
  } catch (err) {
    log(`✗ 空框寫不進資料夾：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 內建的預設卡面 MOD 複製到玩家資料夾。開機一次；玩家刪掉的不補回來
 * （規則見 `installDefaultMods`）。要在第一次 `reloadCardArt` 之前跑。
 */
function installCardMods(): void {
  try {
    const r = installDefaultMods(join(__dirname, "assets", "card-mods"), CARD_ART_DIR);
    if (r.bundled === 0) log("✗ 插件裡找不到內建的卡面 MOD（assets/card-mods）");
    else if (r.written > 0) log(`· 卡面替換：預設 MOD 放好 ${r.written} 張（${CARD_ART_DIR}）`);
  } catch (err) {
    log(`✗ 預設卡面 MOD 寫不進資料夾：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cardArtPageState(): Promise<CardArtPageState> {
  return {
    dir: CARD_ART_DIR,
    files: cardArtScan.files,
    sent: cardArtScan.entries.length,
    names: cardNames !== null,
    blanks: countBlanks(CARD_ART_BLANKS_PATH),
    status: (await engine?.cardArtStatus().catch(() => null)) ?? null,
  };
}

/** 渦那一頁要畫的東西：兩支注入腳本的狀態＋結算面板的模式。 */
interface RaidPageState {
  rewardMode: RaidRewardMode;
  share: boolean;
  teamShare: boolean;
  autoDelete: boolean;
  autoDeletePrompt: boolean;
  itemShortcut: boolean;
  view: RaidViewStatus | null;
  reward: RaidRewardStatus | null;
  items: ItemPanelStatus | null;
}

async function raidPageState(): Promise<RaidPageState> {
  return {
    rewardMode: profile.raidRewardMode,
    share: profile.raidShare,
    teamShare: profile.raidTeamShare,
    autoDelete: profile.raidAutoDelete,
    autoDeletePrompt: profile.raidAutoDeletePrompt,
    itemShortcut: profile.raidItemShortcut,
    view: (await engine?.raidViewStatus().catch(() => null)) ?? null,
    reward: (await engine?.raidRewardStatus().catch(() => null)) ?? null,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
  };
}

/** 任務那一頁要畫的東西：物品捷徑與寶箱標註的開關＋兩支注入腳本的狀態。 */
interface QuestPageState {
  stackShortcut: boolean;
  passShortcut: boolean;
  treasureMarks: boolean;
  items: ItemPanelStatus | null;
  treasure: QuestTreasureStatus | null;
  /** 學到的 HighLow 開始星數：每一級的最小／最大 step、幾筆。 */
  bonus: QuestBonusStats;
}

async function questPageState(): Promise<QuestPageState> {
  return {
    stackShortcut: profile.questStackShortcut,
    passShortcut: profile.questPassShortcut,
    treasureMarks: profile.questTreasureMarks,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
    treasure: (await engine?.questTreasureStatus().catch(() => null)) ?? null,
    bonus: summarizeQuestBonus(engine?.questBonusSamples ?? readQuestBonus()),
  };
}

/**
 * 迪特赫姆那幾頁（物品捷徑、GEM UP、投降）要畫的東西：開關＋物品欄那支的狀態＋
 * 投降那支（渦戰投降鈕的注入腳本，對戰 MENU 歸它管）的狀態。
 */
interface DietPageState {
  itemShortcut: boolean;
  gemUp: boolean;
  surrenderNoConfirm: boolean;
  surrenderOutside: boolean;
  items: ItemPanelStatus | null;
  surrender: RaidSurrenderStatus | null;
}

function battleSurrenderOptions(): BattleSurrenderOptions {
  return { dietNoConfirm: profile.dietSurrenderNoConfirm, outside: profile.surrenderOutside };
}

async function dietPageState(): Promise<DietPageState> {
  return {
    itemShortcut: profile.dietItemShortcut,
    gemUp: profile.dietGemUp,
    surrenderNoConfirm: profile.dietSurrenderNoConfirm,
    surrenderOutside: profile.surrenderOutside,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
    surrender: (await engine?.raidSurrenderStatus().catch(() => null)) ?? null,
  };
}

/** 獎勵 › 物品捷徑要畫的東西：開關、畫在哪、差距大時先用哪一種＋物品欄那支的狀態。 */
interface BonusPageState {
  itemShortcut: boolean;
  place: BonusItemPlace;
  order: BonusItemOrder;
  /** High／Low 跟下一個卡片、得到卡片一起顯示。 */
  highLow: boolean;
  /** 跳過擲骰動畫。 */
  fast: boolean;
  /** 用道具救起來之後快轉。 */
  rescueFast: boolean;
  /** 結束後不看第二次結算。 */
  skipEnd: boolean;
  items: ItemPanelStatus | null;
}

async function bonusPageState(): Promise<BonusPageState> {
  return {
    itemShortcut: profile.bonusItemShortcut,
    place: profile.bonusItemPlace,
    order: profile.bonusItemOrder,
    highLow: profile.bonusHighLow,
    fast: profile.bonusFast,
    rescueFast: profile.bonusRescueFast,
    skipEnd: profile.bonusSkipEnd,
    items: (await engine?.itemPanelStatus().catch(() => null)) ?? null,
  };
}

/**
 * 自動配對。**同時只會有一個** —— 一個托盤視窗管一個遊戲客戶端，
 * 而一個客戶端同時只能排一條隊。
 *
 * ⚠ **沒有一份 `pairingStatus` 快取了**（WP-18）。它以前存在只是為了餵托盤那
 * 一頁，而那一頁沒有配對狀態了 —— 玩家看的是遊戲裡的等待視窗。狀態的去處現在
 * 只有兩個：記錄檔（`onLog`）與遊戲畫面（`pushLobbyState`）。留一份沒有人讀的
 * 快取，下一個人會以為它是真相來源。
 */
let pairing: MatchPairing | null = null;

/** 我這副牌排進哪一檔。`custom` = 官方檔位裡沒有它，插件自己算的。 */
interface DeckTier {
  /** 這副牌在自訂規則下的總和，**整數百分之一**。 */
  totalCenti: number;
  /** 有上限的那一檔（官方檔位或自訂檔）。開口檔時是 `null`。 */
  costLimit: number | null;
  /** 開口檔（`COST90+`）的下限。其餘一律 `null`。 */
  costFloor: number | null;
  /** 這一檔是照牌組算出來的，官方那三檔／開口檔裡沒有它。 */
  custom: boolean;
}

/**
 * 我這副牌排進哪一檔（WP-18）。**大廳那顆按鈕與左下那幾行共用這一支。**
 *
 * ```
 *   落在官方三檔／開口檔裡 → 那一檔（跟亞城一樣，左下本來就有那一行）
 *   落在外面               → 這副牌自己那一檔（bandForTotal），左下多一行標 ★
 * ```
 *
 * ⚠ **兩個呼叫端一定要用同一支。** 一個決定「我排進哪條佇列」，另一個決定
 * 「畫面上那一行寫的是哪一檔」—— 各算各的話，症狀是人已經在排隊，而畫面上
 * 那一行永遠寫著 0。
 *
 * ⚠ 這跟 `context.deckCost`（伺服器算的原版 COST）是**兩個不同的數字**。
 * 遊戲自己的「牌組Cost限制 ±N」判的是那一個，這裡算的是自訂規則那一個。
 *
 * ⚠ 讀不到牌組回 `null`，**不是回一個 0C 的檔** —— 一個算錯的檔位會把玩家
 * 排進一條沒有人的佇列，而畫面上看起來完全正常。
 */
function myDeckTier(context: MatchContext | null, openTier: number | null): DeckTier | null {
  if (costRuleFull === null || context === null) return null;
  const keys = context.deckKeys;
  if (keys === null) return null;
  const deck = deckFromKeys(keys);
  if (deck.characters.length === 0) return null;

  const totalCenti = teamCostCenti(costRuleFull, deck);
  // ⚠ 現讀，不快取 —— 每週二遊戲更新會變（見 `costTiersFor`）。
  const tiers =
    context.channel === null ? [] : (costTiersFor(context.channels, context.channel) ?? []);
  const pick = tierForTotal(totalCenti, tiers, openTier);
  if (pick === null) {
    // 官方檔位對不上 —— 用這副牌自己那一檔。以前這裡是把玩家擋下來，理由與
    // 取捨見 `@ulr/arbiter-engine` 的 `bandForTotal`。
    return { totalCenti, costLimit: bandForTotal(totalCenti), costFloor: null, custom: true };
  }
  return {
    totalCenti,
    costLimit: pick.kind === "band" ? pick.tier : null,
    costFloor: pick.kind === "open" ? pick.tier : null,
    custom: false,
  };
}

/** 一檔在記錄檔與畫面上叫什麼 —— `COST57`、`COST90+`。 */
function tierLabel(t: { costLimit: number | null; costFloor: number | null }): string {
  if (t.costLimit !== null) return `COST${t.costLimit}`;
  if (t.costFloor !== null) return `COST${t.costFloor}+`;
  return "COST自由";
}

/**
 * 這一場排不排得下去（AP／免費對戰星星）。
 *
 * 兩個入口（大廳按鈕、托盤的配對頁）共用這一支，差別只有怎麼把答案講出來 ——
 * 大廳那條走遊戲自己的對話框（`ROOM_ERROR_AP_SHORT`），托盤那條回一句話。
 * 判準寫在 `@ulr/cdp-adapter`，兩邊都不自己算。
 */
function affordDuel(context: MatchContext): DuelAffordability {
  return canAffordDuel({
    ap: context.ap,
    duelFree: context.duelFree,
    // ⚠ 費用跟著頻道與 3vs3 走，不是常數。頻道物件自己帶（`required_ap`），
    // 讀不到才退回 `duelApCost` 那張表。
    cost:
      (ROOM_MULTI ? context.requiredAp?.multi : context.requiredAp?.single) ??
      duelApCost({ multi: ROOM_MULTI, crossplay: context.crossplay }),
  });
}

/**
 * 開始一次自動配對。**托盤的按鈕與遊戲大廳裡那顆走的是這同一支。**
 *
 * ⚠⚠ 這支會一路走到**開房**（消耗 AP 5）或**進房**（直接開打），所以它只能
 * 由玩家親手按下的動作觸發 —— 任何輪詢、重試、狀態同步都不准叫它。
 *
 * ⚠ **入口只剩一個了**（WP-18）：遊戲大廳裡那顆「快速比賽」。托盤那一頁不再
 * 有開始／停止 —— 玩家人在遊戲畫面上，而亞城那顆按鈕就在那裡。
 *
 * 檔位一律**照牌組算**（`myDeckTier`），玩家填不到。理由見
 * `profiles-core.ts` 的 `MatchPrefs`：填得跟對手不一樣會物理上配不到人。
 */
async function startPairing(args: {
  channel: number;
  costLimit: number | null;
  costFloor: number | null;
}): Promise<{ ok: true; status: PairingStatus } | { ok: false; reason: string }> {
  if (pairing !== null) return { ok: false as const, reason: "已經在配對中了。" };
  if (costRuleFull === null) {
    // 沒有規則就沒有「約定」可言 —— 那正是這個功能存在的理由。
    return { ok: false as const, reason: "自動配對要先選一份 COST 規則（自訂COST › Cost 表）。" };
  }
  const driver = await engine?.matchDriver().catch(() => null);
  if (!driver) return { ok: false as const, reason: "還沒連上遊戲" };

  // ⚠⚠ **AP 要在排隊之前擋。** 排下去之後才發現不夠的話，對手已經被配給我們、
  // 已經在等一間永遠不會開的房 —— 而玩家看到的是配對走到一半跳出「AP不足」。
  // 大廳那顆按鈕自己也擋一次（那條路要用遊戲的對話框），這裡擋的是托盤那一頁。
  const context = await driver.matchContext().catch(() => null);
  if (context !== null) {
    const afford = affordDuel(context);
    if (!afford.ok) {
      return {
        ok: false as const,
        reason: `AP 不足：現在 ${afford.ap}，開一場要 ${afford.cost}（也沒有免費對戰星星）。`,
      };
    }
  }

  // ⚠ 記下排的是哪一檔 —— 大廳那幾行要**立刻**把自己算進去（`displayCounts`），
  // 不能等下一輪去問中間人。這裡是唯一知道答案的地方。
  pairingTier = tierOf(args);

  const m = profile.match;
  const p = new MatchPairing({
    endpoint: engine?.linkEndpoint ?? "",
    rule: costRuleFull,
    channel: args.channel,
    costLimit: args.costLimit,
    costFloor: args.costFloor,
    room: {
      // ⚠ 房名不在這裡 —— 引擎照「規則名 + 檔位」自己組（`buildRoomName`）。
      // 3vs3 與遊戲自己的 ±N 也不在：兩個都是固定的（`ROOM_MULTI`、
      // `ROOM_DECK_COST_BAND`）。
      stage: m.stage,
      friend: false,
    },
    driver,
    onStatus: (s) => {
      // ⚠ 停下來就把物件放掉。留著的話玩家再按一次大廳那顆按鈕只會被當成
      // 「取消」，而他其實是想重新排一次 —— 那是最讓人以為插件壞掉的狀態。
      //
      // `idle` 跟 `blocked` 都要放：配對成功走到底（對手進房、對戰開始）
      // 之後狀態機會自己回到 idle，而那正是玩家最可能馬上想再排一次的時候。
      if (s.phase === "blocked" || s.phase === "idle") pairing = null;
      // ⚠ **遊戲畫面要立刻跟上。** 玩家人在遊戲裡，托盤視窗多半是收著的 ——
      // 而托盤那一頁本來就沒有配對狀態可以更新了（WP-18）。
      void pushLobbyState();
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
}

// ---------------------------------------------------------------------------
// 迪特赫姆的快速比賽（WP-17）
// ---------------------------------------------------------------------------

/**
 * 看一眼玩家在不在大廳的節奏。**這一拍不發任何網路請求** —— 它只問頁面
 * （兩次 CDP evaluate），成本跟中間人無關。
 *
 * ⚠ 這個數字決定的是「剛進頻道多久看得到人數」與「按下去多久看得到自己」。
 * 15 秒那個是**問中間人**的節奏，兩者刻意分開：玩家抱怨的「不像亞城那樣
 * 立即反應」全部落在這一拍上，而把中間人那一拍一起調快是要付錢的。
 */
const LOBBY_TICK_MS = 3_000;

/**
 * **問中間人**「各檔幾個人在等」的最短間隔。
 *
 * ⚠ **這是輪詢，所以它的成本是「玩家坐在大廳的時間 ÷ 這個數字」**，跟對戰
 * 次數無關 —— docs/match-making.md 那張 43,200 vs 1,440 的表就是這件事。
 * 15 秒 = 一小時 240 次，而一個請求就問完所有檔位（`queueCountUrl`）。
 *
 * ⚠ 只有在**玩家真的在 duel 頻道的大廳裡**才會發（`buttonReady`），
 * 打牌中、選單裡、沒開遊戲都不會。
 */
const LOBBY_COUNT_MS = 15_000;

/**
 * **推播接得上的時候**，多久還是去問一次 `/qn`。
 *
 * ⚠ 推播已經是即時的了，這一拍純粹是保險：一條**開著但對面已經不在**的
 * WebSocket 在 Windows 上是真的會發生的（DO 被搬走、NAT 把連線收掉），而它
 * 的症狀是人數停在某個數字不動 —— 跟「真的沒人」長得一模一樣。
 *
 * 兩分鐘一次 = 一小時 30 次，是輪詢版本（240 次）的八分之一。
 */
const LOBBY_COUNT_PUSH_MS = 120_000;

/**
 * 推播來了之後多久換一次畫面。**合併用的，不是延遲。**
 *
 * 四檔會各自推自己的，而一個人從 COST54 換到 COST61 會讓兩檔同時變 ——
 * 每一則都換一次畫面等於兩趟 CDP 白跑。
 */
const LOBBY_PUSH_DEBOUNCE_MS = 120;

let lobbyTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 每一條佇列最新的人數（**兩條來源共用這一格**：推播與輪詢）。
 *
 * ⚠ 只拿來在「這次問不到」時**不要**把畫面洗成空的 —— 舊數字比沒有數字好。
 */
const lobbyByKey = new Map<string, number>();
/** 現在畫面上是哪幾檔（順序就是畫面的順序）。 */
let lobbySpecs: TierSpec[] = [];
/** 推播的線。`null` = 還沒開過（進大廳才會開）。 */
let lobbyWatcher: QueueWatcher | null = null;
/** `lobbyWatcher` 是連著哪一台中間人開的。玩家改了位址就要整組重來。 */
let lobbyWatchEndpoint = "";
/** 合併推播用的計時器，見 `lobbyPushSoon()`。 */
let lobbyPushTimer: ReturnType<typeof setTimeout> | null = null;
/** 上一次真的問中間人是什麼時候。0 = 還沒問過。 */
let lobbyCountsAt = 0;
/**
 * **問那一次的當下，我自己排在哪一檔。** `null` = 那時沒在排。
 *
 * 拿來跟現在比對 —— 差別就是「這個數字還沒把我算進去／已經不該算我了」，
 * 見 `countsForDisplay()`。
 */
let lobbyCountsSelf: TierRef | null = null;
/** 上一拍玩家在不在 duel 大廳。false → true 就是「他剛進頻道」。 */
let lobbyReady = false;

/**
 * 最近一次排的是哪一檔。**只有 `pairing !== null` 的時候才算數**，
 * 所以永遠透過 `selfTier()` 讀，不要直接讀這一格。
 */
let pairingTier: TierRef | null = null;

/**
 * 我**現在**排在哪一檔。`null` = 沒在排。
 *
 * ⚠ 寫成函式而不是一格變數，是因為 `pairing` 有四個地方會被設成 null
 * （按取消、狀態機回到 idle、被擋下來、關掉插件）。多一格要自己同步的狀態
 * 就是多一個會忘記清的地方，而忘了清的症狀是「明明沒排隊，那一檔卻永遠
 * 多一個人」—— 那正是這整段要修掉的那種假數字。
 */
function selfTier(): TierRef | null {
  return pairing === null ? null : pairingTier;
}

/**
 * 把等待人數與配對狀態推到遊戲畫面上。
 *
 * ⚠ **問不到人數時要保留上一次的數字，不要推 `null`。** 中間人抖一下就把
 * 那三行清掉的話，玩家看到的是「人數忽有忽無」—— 而那比慢個 15 秒難懂得多。
 *
 * ⚠⚠ **不是每一拍都去問中間人。** 這支同時掛在配對狀態的 `onStatus` 上，而
 * 一次配對從按下去到開打會推十幾次狀態 —— 每一次都問的話，那十幾個 HTTP
 * 請求全部發生在最不需要更新人數的那幾秒。真的發請求只有三種時候：
 *
 * ```
 *   force        玩家剛按下快速比賽／取消 —— 那一檔的數字馬上就不一樣了
 *   剛進大廳     ⚠ 少了這條，玩家進頻道會先看到**空白**，最久等 15 秒
 *   距上次 15 秒 穩定狀態的節奏
 * ```
 */
async function pushLobbyState(options: { refreshCounts?: boolean } = {}): Promise<void> {
  if (engine === null) return;
  const status = await engine.lobbyStatus();
  if (status === null || !status.buttonReady) {
    lobbyReady = false;
    // ⚠ 人不在大廳就把推播的線收掉。連著不看是**白付的連線** —— 而且玩家
    // 打一場牌可以是二十分鐘，那二十分鐘裡沒有任何人會看那幾行字。
    stopLobbyWatch();
    return;
  }
  // ⚠ 「剛進頻道」要當場問一次。這是玩家回報的第二句：進頻道時那幾行是空的，
  // 要等一陣子才出現 —— 因為第一次問是排在下一個 15 秒的節拍上。
  const entered = !lobbyReady;
  lobbyReady = true;

  // ⚠ 用的不是預設那份 COST 表就不顯示，理由見這一段的段首註解。
  if (costRuleHash === null || costRuleHash !== defaultRuleHash()) {
    stopLobbyWatch();
    lobbySpecs = [];
    lobbyByKey.clear();
    // ⚠ 人數藏起來，**標記還是要送** —— 排隊中的那個框在哪一檔，跟「這台機器
    // 該不該看到人數」是兩件事。
    await engine.setLobbyState({
      counts: null,
      matching: pairing !== null,
      badge: matchingBadge(),
    });
    return;
  }

  // ⚠ 算不出來（CDP 逾時、還沒讀到頻道）時**留著上一組** —— 那幾行不該因為
  // 一次讀取失敗就消失。真的換頻道時下一拍就會算出新的一組。
  const specs = await tierSpecs(status.openTier);
  if (specs !== null) setLobbySpecs(specs);

  // ⚠⚠ **推播接得上就不必一直問。** 這一格就是這次改動省下來的錢：接得上時
  // 兩分鐘問一次（純保險），接不上時退回原本的 15 秒。
  const interval = lobbyWatcher?.allLive === true ? LOBBY_COUNT_PUSH_MS : LOBBY_COUNT_MS;
  const due = Date.now() - lobbyCountsAt >= interval;
  if (lobbySpecs.length > 0 && (options.refreshCounts === true || entered || due)) {
    const self = selfTier();
    const byKey = await fetchTierCounts(lobbySpecs);
    if (byKey !== null) {
      for (const spec of lobbySpecs) {
        const waiting = byKey.get(spec.key);
        if (waiting !== undefined) lobbyByKey.set(spec.key, waiting);
      }
      lobbyCountsAt = Date.now();
      // ⚠ 記的是**發出請求那一刻**的狀態，不是回來時的 —— 玩家可能在這幾百
      // 毫秒之間按了取消，那樣這份數字裡的「我」就該被扣掉。
      lobbyCountsSelf = self;
    }
  }

  await engine.setLobbyState({
    // ⚠ 推出去的不是中間人那份原始數字，是**把「我自己」放到對的位置之後**
    // 的那一份。理由整段寫在 `lobby-counts.ts` 的檔頭。
    counts: withoutEmptyCustom(
      displayCounts({
        counts: currentCounts(),
        fetchedWhileIn: lobbyCountsSelf,
        nowIn: selfTier(),
      }),
    ),
    // ⚠ 配對中就跳**遊戲自己的等待視窗**（有計時、有 cancel），不是在 INFO
    // 那一區多寫一行字 —— 亞城按下快速比賽之後跳的就是那個框。
    matching: pairing !== null,
    badge: matchingBadge(),
  });
}

/**
 * 自訂檔那一行**沒有人在等就拿掉**（玩家 2026-08-21 的決定）。
 *
 * 官方那幾行寫 0 是有意義的（「這一檔現在沒人」是一句關於頻道的話），自訂檔
 * 不是 —— 它是「**我**這副牌這一檔」，而那一檔本來就只有壓到同一格的人排得
 * 進來。一行永遠寫著 0 的字只是把玩家的注意力留在一個他改不了的數字上。
 *
 * ⚠ 我自己排著的時候一定 ≥ 1（`displayCounts` 保證），所以這條規則不會把
 * 「我正在排隊」那一行藏掉。
 */
function withoutEmptyCustom(counts: LobbyTierCount[] | null): LobbyTierCount[] | null {
  if (counts === null) return null;
  return counts.filter((c) => c.custom !== true || c.waiting > 0);
}

/**
 * 等待視窗上那一行標記 —— `★ COST48 · 夾擠式罰C`。沒在排隊是 `null`。
 *
 * ⚠ **這是自訂檔唯一看得見的地方。** 左下那幾行寫的是官方階層，而自訂檔在
 * 那份模板裡沒有位置（見 `patch-lobby.ts` 的 `LobbyState.badge`）。少了這一行，
 * 玩家排在一個他從頭到尾沒看過的數字上。
 *
 * 規則名跟著一起寫：同一台機器可以換規則，而換了規則就是換一條佇列。
 */
function matchingBadge(): string | null {
  if (pairing === null || pairingTier === null) return null;
  const tier = pairingTier.open ? `COST${pairingTier.tier}+` : `COST${pairingTier.tier}`;
  const name = costRule?.name ?? null;
  return name === null ? `★ ${tier}` : `★ ${tier} · ${name}`;
}

// ---------------------------------------------------------------------------
// 「COST54:N 位玩家等待中」那幾行
//
// ⚠⚠ **只有用預設 COST 表的人才有這幾行數字**（玩家 2026-08-20 的決定）。
// 用別份規則的人看不到 —— 那不是壞掉，是那個數字對他沒有意義：他排的是
// 一條只有他自己那份規則算得出來的隊，而中間人數的是「跟預設表同一份」的人。
//
// ⚠⚠ **判準是「內容一不一樣」，不是「他從哪裡選的」。** 2026-08-20 實測到
// 差別：玩家的 `costRuleMode` 是 `file`，指著 `rules/…-1C.ulrcost.json`，
// 而那個檔的 contentHash 跟安裝包裡那份**一模一樣** —— 他排的是同一條佇列、
// 數的是同一群人，用「來源」去擋只會把一個完全正常的玩家的人數藏起來。
//
// ⚠ 數的範圍也跟著窄了一層：中間人只數**規則內容跟我一模一樣**的人
// （`ruleTag`）。同一條佇列上站著別份規則的人是常態（配對鍵裡沒有版本），
// 而他們配不配得到要看驗算 —— 寫「1 位玩家等待中」卻永遠配不到，比寫 0 還糟。
//
// 數字有兩條來源，**推播是主要的、輪詢是退路**：
//
//   QueueWatcher   `q-watch` → 中間人一有人進出就推 `q-count`（即時）
//   /qn            接不上推播時的退路，外加一個很慢的保險節奏
// ---------------------------------------------------------------------------

/**
 * 「插件附的預設 COST 表」的 contentHash。**兩份都不在就回 `null`。**
 *
 * ⚠ 用 mtime 當快取鍵：這支每三秒會被叫一次，而每次重讀 28KB 再 hash 一遍
 * 是白做的。中間人發下新的一份時（`rule-feed.ts` 寫檔）mtime 會變，快取自己
 * 就過期了 —— 少了這一格的話，玩家會停在「舊的預設表」的判斷上，而症狀是
 * 更新之後人數突然消失。
 */
let defaultRuleHashCache: { path: string; mtimeMs: number; hash: string } | null = null;
function defaultRuleHash(): string | null {
  const choice = resolveDefaultRule(APP_DIR);
  if (choice === null) return null;
  try {
    const mtimeMs = statSync(choice.path).mtimeMs;
    const cached = defaultRuleHashCache;
    if (cached !== null && cached.path === choice.path && cached.mtimeMs === mtimeMs) {
      return cached.hash;
    }
    const result = loadRulePackage(JSON.parse(readFileSync(choice.path, "utf8")));
    if (!result.ok) return null;
    defaultRuleHashCache = { path: choice.path, mtimeMs, hash: result.value.contentHash };
    return result.value.contentHash;
  } catch {
    // 讀不到就當成「沒有預設表可比」= 不顯示人數。⚠ 不能反過來當成「都算」——
    // 那會讓一台讀不到規則的機器把所有人的數字都畫出來。
    return null;
  }
}

/** 一檔在中間人那邊的身分：配對鍵，加上「我這份規則」在那條佇列上的標籤。 */
interface TierSpec {
  tier: number;
  open: boolean;
  /**
   * 這是**自訂檔**嗎 —— 我這副牌算出來落在官方階層之外，插件自己開的那一檔。
   *
   * ⚠ 它跟官方那幾檔**不是同一種東西**：官方那三檔是「這個頻道有這幾條佇列」，
   * 自訂檔是「**我**這副牌現在排在這一條」。換一副牌就換一條，所以它會跟著
   * 牌組變（`setLobbySpecs` 認鍵，換了就重訂閱）。
   *
   * ⚠ 成本：它是**第五把鍵**，也就是大廳裡多一條推播連線（`QueueWatcher` 一把
   * 鍵一條），而玩家在遊戲裡換牌組時那條會重連一次。`/qn` 那邊沒問題 ——
   * 一個請求問完所有鍵，而中間人的上限是 8（`MAX_COUNT_KEYS`）。
   */
  custom: boolean;
  key: string;
  /** `ruleTag(key, contentHash(規則))`。⚠ **拌過配對鍵，所以一檔一個。** */
  tag: string;
}

/**
 * 這個頻道現在有哪幾檔，各自的配對鍵與規則標籤是什麼。
 *
 * ⚠ 鍵是**這裡自己算的**（`matchKey`），跟真的去排隊時算的是同一支函式 ——
 * 兩邊各算一次的話，某一天其中一邊改了欄位就會變成「人數永遠 0，但排得到人」。
 *
 * ⚠ 回 `null` 是**這一次算不出來**（還沒接上遊戲、讀不到頻道），不是「這個
 * 玩家不該看到人數」—— 後者由呼叫端先擋掉（規則內容跟預設那份不一樣）。
 * 兩者混在一起的話，遊戲畫面會在一次 CDP 逾時之後把那幾行清空。
 *
 * ⚠ **最後可能多一檔**：我這副牌落在官方階層之外時（WP-18），那一檔在畫面上
 * 沒有自己的一行 —— 而那正是玩家要看的那一行。見 `myDeckTier`。
 */
async function tierSpecs(openTier: number | null): Promise<TierSpec[] | null> {
  if (costRuleFull === null || engine === null) return null;
  const driver = await engine.matchDriver().catch(() => null);
  if (!driver) return null;

  let context: MatchContext;
  try {
    context = await driver.matchContext();
  } catch {
    return null;
  }
  const channel = context.channel;
  if (channel === null) return null;
  // ⚠ 現讀，不快取 —— 每週二遊戲更新會變（見 `costTiersFor`）。
  const tiers = costTiersFor(context.channels, channel) ?? [];

  // 我這副牌排在哪一檔。官方階層裡有的話下面那幾行本來就會畫到它，只有落在
  // 外面時才要多開一條。
  const mine = myDeckTier(context, openTier);
  const custom = mine !== null && mine.custom && mine.costLimit !== null ? mine.costLimit : null;
  if (tiers.length === 0 && openTier === null && custom === null) return null;

  const ruleSetId = costRuleFull.ruleSetId;
  const ruleHash = costRuleHash ?? contentHash(costRuleFull);
  const keyed = [
    ...tiers.map((tier) => ({
      tier,
      open: false,
      custom: false,
      key: matchKey({ ruleSetId, channel, multi: ROOM_MULTI, costLimit: tier }),
    })),
    ...(openTier === null
      ? []
      : [
          {
            tier: openTier,
            open: true,
            custom: false,
            key: matchKey({
              ruleSetId,
              channel,
              multi: ROOM_MULTI,
              costLimit: null,
              costFloor: openTier,
            }),
          },
        ]),
    ...(custom === null
      ? []
      : [
          {
            tier: custom,
            open: false,
            custom: true,
            key: matchKey({ ruleSetId, channel, multi: ROOM_MULTI, costLimit: custom }),
          },
        ]),
  ];
  return keyed.map((s) => ({ ...s, tag: ruleTag(s.key, ruleHash) }));
}

/**
 * 問中間人「這幾檔各有幾個人在等」。**這是退路，不是主要的路** ——
 * 主要的路是推播（`QueueWatcher`），這支只在推播接不上時撐著。
 *
 * ⚠ 回傳是「鍵 → 人數」而不是畫面用的那個陣列：推播來的也是一次一個鍵，
 * 兩條路要餵進同一格狀態，否則畫面會在兩份數字之間跳。
 */
async function fetchTierCounts(specs: readonly TierSpec[]): Promise<Map<string, number> | null> {
  if (engine === null || specs.length === 0) return null;
  try {
    // ⚠ 標籤是**一把鍵一個**（`ruleTag` 拌過配對鍵），不是共用一個 —— 傳一個
    // 配四把的話三檔會永遠數到 0，而且沒有任何錯誤訊息。
    const url = queueCountUrl(engine.linkEndpoint, {
      keys: specs.map((s) => s.key),
      tags: specs.map((s) => s.tag),
    });
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { counts?: { key?: string; waiting?: number }[] };
    return new Map((body.counts ?? []).map((c) => [c.key ?? "", c.waiting ?? 0]));
  } catch {
    // 中間人連不上／舊版沒有這條路由 → 這次沒有人數。**不是錯誤**，
    // 按鈕照樣能按（配對本身走的是另一條路）。
    return null;
  }
}

/**
 * 現在畫面上那幾行的數字（**還沒把「我」算進去**，那是 `displayCounts` 的事）。
 *
 * ⚠ 一個鍵都還沒有答案時回 `null`（= 那幾行整個不畫）。有部分答案就照畫、
 * 缺的當 0 —— 一檔問不到就把四檔全部藏起來，比顯示一個 0 難懂得多。
 */
function currentCounts(): LobbyTierCount[] | null {
  if (lobbySpecs.length === 0) return null;
  if (!lobbySpecs.some((s) => lobbyByKey.has(s.key))) return null;
  return lobbySpecs.map((s) => ({
    tier: s.tier,
    waiting: lobbyByKey.get(s.key) ?? 0,
    ...(s.open ? { open: true } : {}),
    ...(s.custom ? { custom: true } : {}),
  }));
}

/** 現在要看哪幾檔。**一樣就什麼都不做** —— 這支每三秒會被叫一次。 */
function setLobbySpecs(specs: readonly TierSpec[]): void {
  const same =
    lobbySpecs.length === specs.length &&
    lobbySpecs.every((s, i) => {
      const t = specs[i];
      return t !== undefined && s.key === t.key && s.tag === t.tag && s.tier === t.tier;
    });
  if (same) {
    startLobbyWatch();
    return;
  }
  lobbySpecs = [...specs];
  // ⚠ 換頻道／換規則之後，舊鍵的數字對現在這個畫面沒有意義。留著的話玩家會
  // 在切頻道的瞬間看到上一個頻道的人數，而那個數字看起來完全合理。
  const keys = new Set(lobbySpecs.map((s) => s.key));
  for (const key of [...lobbyByKey.keys()]) if (!keys.has(key)) lobbyByKey.delete(key);
  // 逼下一拍去問一次（推播接得上的話它會先到，這只是保險）。
  lobbyCountsAt = 0;
  startLobbyWatch();
}

/**
 * 把推播的線接上（或換成新的一組鍵）。
 *
 * ⚠ 中間人的位址換了就要整個重來 —— `QueueWatcher` 的 endpoint 是建構時
 * 決定的，而玩家在設定裡改位址之後，舊的那幾條線還連在舊的中間人上。
 */
function startLobbyWatch(): void {
  if (engine === null || lobbySpecs.length === 0) return;
  const endpoint = engine.linkEndpoint;
  if (lobbyWatcher !== null && lobbyWatchEndpoint !== endpoint) {
    lobbyWatcher.stop();
    lobbyWatcher = null;
  }
  if (lobbyWatcher === null) {
    lobbyWatchEndpoint = endpoint;
    lobbyWatcher = new QueueWatcher({
      endpoint,
      onCount: (key, waiting) => {
        lobbyByKey.set(key, waiting);
        // ⚠ 記下「收到這個數字的當下我排在哪一檔」，理由同輪詢那條路：
        // 這一份可能還沒把我算進去（我的 `q-hello` 還在飛）。
        lobbyCountsSelf = selfTier();
        lobbyPushSoon();
      },
      onLog: (line) => log(line),
    });
  }
  lobbyWatcher.setTargets(lobbySpecs.map((s) => ({ key: s.key, tag: s.tag })));
}

/** 離開大廳、或不該顯示人數了。**連著不看是白付的連線。** */
function stopLobbyWatch(): void {
  lobbyWatcher?.stop();
  if (lobbyPushTimer !== null) clearTimeout(lobbyPushTimer);
  lobbyPushTimer = null;
}

/**
 * 推播來了 → 盡快把畫面更新一次。
 *
 * ⚠ 要合併：四檔同時變（一個人從 COST54 換到 COST61）會連著來兩三則，而
 * `pushLobbyState()` 每一次都是兩趟 CDP。合併之後那一串只換一次畫面，
 * 而玩家眼裡仍然是「立刻」。
 */
function lobbyPushSoon(): void {
  if (lobbyPushTimer !== null) return;
  lobbyPushTimer = setTimeout(() => {
    lobbyPushTimer = null;
    void pushLobbyState();
  }, LOBBY_PUSH_DEBOUNCE_MS);
}

/**
 * 玩家按了遊戲大廳裡那顆「快速比賽」。
 *
 * ```
 *   在配對中 → 停止（那顆按鈕同時是取消鍵，亞城的等待視窗也是這樣）
 *   否則     → 讀牌組 → 算它落在哪一檔 → 排進那一檔
 *              算不出來 → 跳遊戲自己的「這個牌組不符合遊戲規則」
 * ```
 *
 * ⚠ **檔位是算出來的，不是玩家選的。** 亞歷山卓城的快速比賽就是這樣：按下去
 * 之後伺服器照你的牌組把你放進某一檔。托盤那一頁**也沒有那一格了**（WP-18）
 * —— 兩個入口填出不一樣的數字時，兩邊都只寫著「排隊中」而永遠配不到。
 */
async function onLobbyQuick(press: LobbyQuickPressed): Promise<void> {
  if (engine === null) return;

  // 再按一次 = 取消。⚠ 一定要有這條路：玩家人在遊戲裡，托盤視窗多半收著，
  // 而「排了隊之後只能去托盤按停止」等於這顆按鈕只做了一半。
  if (pairing !== null) {
    await pairing.stop();
    pairing = null;
    log("· 已停止自動配對（大廳按鈕）");
    // ⚠ **這裡刻意不重問中間人。** 我剛剛才把線關掉，而那條線在對面消失是
    // 非同步的 —— 馬上問回來的答案有很高機率**還把我算在裡面**，於是畫面會
    // 從「1」跳成「1」，看起來就是按了取消卻沒反應。
    //
    // 推播接得上時這件事更乾淨：`q-cancel` 一到中間人就會推一則新的 `q-count`
    // 回來，而那一則是**真的**已經把我扣掉的數字。
    //
    // 不問反而是對的：`countsForDisplay()` 知道「上一次問的時候我在那一檔、
    // 現在不在了」，直接扣掉 —— 那個數字立刻正確，而且下一輪（最多 15 秒）
    // 拿到的新答案會接手。
    await pushLobbyState();
    return;
  }

  if (costRuleFull === null) {
    await engine.showLobbyError(null, "插件還沒載入 COST 表，先到托盤的「Cost 表」看一下。");
    return;
  }

  const driver = await engine.matchDriver().catch(() => null);
  if (!driver) return;
  const context = await driver.matchContext().catch(() => null);
  if (context === null) return;

  const channel = press.channel ?? context.channel;
  if (channel === null) {
    await engine.showLobbyError(null, "請先進入一個頻道。");
    return;
  }

  // ⚠ 迪城借亞城的 COST 檔位（布萊德借峰亥盧），而那份頻道清單只在玩家經過頻道
  // 選單時看得到（插件搭遊戲自己那一次請求記下來，不另外問）。插件比遊戲晚接上時
  // 就會缺 —— 缺著排下去會排進自訂檔，跟同一副牌、知道檔位的人配不到，而兩邊都
  // 只寫著「排隊中」。所以擋下來、講清楚怎麼補。
  if (costTiersFor(context.channels, channel) === null) {
    await engine.showLobbyError(null, "讀不到這個頻道的 COST 檔位 —— 退回頻道選單再進來一次。");
    return;
  }

  // ⚠⚠ **AP 要在排隊之前擋，不是等開房才知道。** 排下去之後才發現不夠的話，
  // 對手已經被配給我們、已經在等一間永遠不會開的房 —— 而玩家看到的是配對
  // 走到一半跳出「AP不足」。這一關擋掉的正是玩家 2026-08-19 回報的那個畫面。
  //
  // 有星星就不吃 AP（右下角那三顆 ★），所以兩個條件是「或」不是「且」。
  const afford = affordDuel(context);
  if (!afford.ok) {
    // 遊戲自己那句「AP不足」—— 跟他手動開房不夠時看到的一模一樣。
    await engine.showLobbyError(ROOM_ERROR_AP_SHORT);
    log(`· 大廳快速比賽被擋下：AP ${afford.ap}／需要 ${afford.cost}，而且沒有免費對戰星星`);
    return;
  }

  const status = await engine.lobbyStatus();
  const mine = myDeckTier(context, status?.openTier ?? null);
  if (mine === null) {
    // ⚠ 這裡**只剩「讀不到牌組」**這一種擋法了。以前還有「牌組不在任何一檔裡」
    // （`room_error[7]`），而那條路現在走 `bandForTotal` —— 自訂規則算出來的
    // 數字本來就沒有義務落在伺服器的官方階層上。
    await engine.showLobbyError(null, "讀不到你的牌組，切一次牌組再試。");
    return;
  }

  const result = await startPairing({
    channel,
    costLimit: mine.costLimit,
    costFloor: mine.costFloor,
  });
  if (!result.ok) {
    await engine.showLobbyError(null, result.reason);
    return;
  }
  log(
    `▶ 大廳快速比賽：牌組 ${formatCentiCost(mine.totalCenti)}C → ${tierLabel(mine)}` +
      `${mine.custom ? "（自訂檔）" : ""}` +
      `（${afford.byStar ? "用免費對戰星星" : `AP ${context.ap ?? "?"}／需要 ${afford.cost}`}）`,
  );
  // 剛排進去，這一檔的人數就多了自己一個。
  // ⚠ 推播接得上時**不必重問** —— 我的 `q-hello` 會讓中間人立刻推一則新的
  // `q-count` 回來（我自己也是那條佇列的「看的人」）。多問這一次不只是白花
  // 一個請求，還很可能問在 `q-hello` 還在飛的那一刻，答案裡沒有我。
  await pushLobbyState({ refreshCounts: lobbyWatcher?.allLive !== true });
}

// ---------------------------------------------------------------------------
// 本地牌組庫（WP-18）
//
// 伺服器只給三副而且擴不出第四副，所以牌組存在本地、**Deck1 當唯一的工作槽**，
// 玩家在遊戲的牌組編輯畫面點一副就即時覆寫 Deck1（`@ulr/deck-library` 檔頭）。
//
// ⚠ **托盤視窗一個字都不加**（規格 §3）。這一整段沒有任何一頁、任何一個 IPC
// ——玩家看得到的東西全部畫在遊戲裡。托盤這邊只負責：讀 Deck1、算庫、存檔、
// 把狀態推過去。玩家在托盤唯一會看到的是記錄頁上的那幾行。
// ---------------------------------------------------------------------------

/**
 * 多久看一眼玩家在不在牌組編輯畫面。
 *
 * ⚠ 這一拍**只是一次 `Runtime.evaluate`**（問頁面裝了沒、掛上了沒），不碰
 * 伺服器。真的去讀 Deck1 只發生在玩家人就在那個畫面的時候 —— 見 `deckTick()`。
 */
const DECK_TICK_MS = 4_000;

/**
 * 庫存快取多久重讀一次。
 *
 * 庫存只有在玩家抽到新卡時才會變，而換牌組是連續動作（試三副牌就是三次）——
 * 每次都重讀等於每次換牌組多三趟 WebSocket。
 */
const INVENTORY_TTL_MS = 5 * 60_000;

let deckTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 「排著的那一副等夠久了沒」多久看一眼。
 *
 * ⚠ 一定要比等候秒數密得多，否則玩家設 3 秒實際等到的是這個拍子的倍數。
 * 這一拍沒有 pending 時只是一個布林判斷，不碰網路。
 */
const DECK_APPLY_TICK_MS = 500;
let deckApplyTimer: ReturnType<typeof setInterval> | null = null;
/** 回報遊戲檔名給書籤玩家用（`bundle-report.ts`）。 */
let bundleReportTimer: ReturnType<typeof setInterval> | null = null;
/** 牌組庫的全部狀態。`null` = 還沒讀到帳號指紋（遊戲還沒登入完成）。 */
let deck: DeckSession | null = null;
/** 這份 session 是哪個帳號的。**換帳號登入要整份重來。** */
let deckAccount: string | null = null;
/**
 * 卡片庫存的快取，見 {@link INVENTORY_TTL_MS}。
 *
 * 改版後讀庫存不必送請求（讀的是 registry），快取留著只是省一次 evaluate。
 */
let inventoryCache: {
  at: number;
  data: Inventory;
  /** 玩家角色卡的格子鍵（見 `InventorySnapshot`），臨時換卡用（見 forGame）。 */
  charaFiles: CharaFiles;
} | null = null;
/**
 * 官方三牌組模式：上一次在牌組編輯畫面看到的三副。自動存檔的比較基準
 * （跟插件模式的 `deckSeen` 同一個道理：只存兩次觀察之間真的變了的）。
 * `null` = 還沒觀察過，那時候一律不存。
 */
let officialSeen: DeckContent[] | null = null;

/** 玩家選的牌組替換模式。`null` = 關閉（插件不碰牌組）。 */
function activeDeckMode(): ActiveDeckMode | null {
  return profile.deckMode === "off" ? null : profile.deckMode;
}
/**
 * 還沒替這條連線讀過帳號指紋。
 *
 * ⚠ 斷線就要重設 —— 玩家關掉遊戲再開有可能**換一個帳號登入**，而牌組庫是
 * 跟著帳號走的。沿用上一個帳號的庫會把 A 的牌組存進 B 的檔案裡。
 */
let deckPending = true;
/** 「還在等遊戲登入」這句話講過了沒。每條連線只講一次。 */
let deckWaitLogged = false;
/** 上一拍玩家在不在 Edit 畫面。true → false 那一拍要補存一次他剛改的東西。 */
let deckMounted = false;
/**
 * **上一次我們讀到的 Deck1** —— 客戶端與伺服器**各記一份**。自動存檔的比較
 * 基準，見 `autoSave()` 與 `deck-seen.ts` 的檔頭。
 *
 * ⚠ 少了它，「寫入失敗」會被誤判成「玩家改過牌」，然後把玩家那副牌覆蓋掉。
 * `null` = 那個世界還沒觀察過，那時候一律不存。
 *
 * ⚠⚠ 記的時候要**誠實說自己動到哪一邊**：快路徑只動客戶端記憶體（`client`），
 * 只有 `db_editdeck` 寫完讀回來對過那一條才是 `both`。報錯了就等於沒修 ——
 * 2026-09-20「迪城的牌組1 變成渦那副」正是兩邊被當成同一份的後果。
 */
const deckSeen = new DeckSeen();
/** 正在處理一則回報。玩家連點時後面那幾則直接丟掉，不要交錯跑。 */
let deckBusy = false;

/**
 * **把牌組庫整份放掉，下一拍重新認帳號。**
 *
 * 三個時機：斷線、遊戲頁面重載、以及快路徑讀到的帳號指紋跟手上這份庫不一樣。
 *
 * ## ⚠⚠ 為什麼只靠斷線不夠（2026-09-14 實機）
 *
 * 小號在**同一個分頁**裡從 A 導向 B 的網址，CDP 連線一路沒斷；登完直接跳進
 * 對戰大廳，托盤讀 Deck1 一律走快路徑（不讀伺服器、原本也沒有帳號指紋）。
 * 於是它整整一晚都以為還是 A：
 *
 * ```
 *   進房 preload  → 把 A 的牌塞進 B 的 Deck1（「這副牌有 5 張卡你手上沒有」）
 *   B 選第 1 副   → 拿 B 的 id 去 A 的庫找（「那副牌組不見了」），永遠換不過去
 *   自動存檔      → B 的 Deck1 存進 A 的檔案
 * ```
 *
 * ## ⚠ `deck` 要清成 `null`，不能只立 `deckPending`
 *
 * 只立旗標的話 `onRoomGate`／`onDeckReport` 照樣拿舊的那份庫在跑（它們只看
 * `deck === null`），等待重認的那幾秒正好是進房 preload 會發生的時候。
 * 頁面上的 room preload 也要一起清：引擎補裝房間偵測時會把它手上那份推回頁面，
 * 不清就是把上一個人的牌再推一次。
 */
function resetDeckSession(): void {
  deckPending = true;
  deckMounted = false;
  // ⚠ 比較基準也要丟掉（兩份一起）。留著上一條連線／上一個人看到的 Deck1，
  // 重認後第一次比對會把「這段期間在別處改的牌」誤判成剛剛的編輯。
  deckSeen.reset();
  officialSeen = null;
  inventoryCache = null;
  deck = null;
  deckSyncKey = null;
  if (deckSyncTimer !== null) {
    clearTimeout(deckSyncTimer);
    deckSyncTimer = null;
  }
  // ⚠ 同步清：引擎的 setRoomDecks 在第一個 await 之前就換掉它手上那份，
  // 所以緊接著的補裝推下去的已經是空的。
  if (engine !== null) {
    void engine.setRoomDecks({ mode: activeDeckMode() ?? "off", decks: {} });
    gatePendingPushed = null;
    void syncGatePending();
  }
  // 最愛是上一個人的，一起收掉。
  pushCharaPicker();
  pushLobbyStand();
}

/**
 * 讀到的帳號跟手上這份庫不是同一個人 → 放掉重來，回 `true`。
 *
 * ⚠ `null` 是「這一拍認不出來」（還在登入、場景還沒掛上 socket），不是換人 ——
 * 拿它當換人會讓每次載入中都整份重建一次。
 */
function accountChanged(account: string | null): boolean {
  if (account === null || deckAccount === null || account === deckAccount) return false;
  log("⟳ 換了帳號登入 —— 牌組庫放掉，重新接上這個帳號的");
  resetDeckSession();
  return true;
}

/**
 * **Deck1（與另外兩格）現在真正的內容。**
 *
 * ```
 *   玩家人在有牌組列的畫面 → 客戶端記憶體 registry.deck（他正在排的、或進房預載的）
 *   不在                    → 伺服器那份（頁面記著的；沒記過才 db_deck 一次）
 * ```
 *
 * ⚠⚠ 這個順序不能顛倒。遊戲要等玩家**離開**編輯畫面才把牌組送上伺服器，所以
 * 他人還在那裡時，伺服器上的是舊的。只讀伺服器的話，「改完牌直接按 ◀▶ 換牌組」
 * 會被判成「沒有編輯要存」，然後目標牌組蓋進 Deck1 —— **他剛排好的牌當場消失**。
 */
async function currentDeck1(): Promise<{
  /** 第 1 格（插件模式的工作槽）。 */
  current: DeckContent;
  /** 三格，照 `deck_id` 排好（官方三牌組模式用）。 */
  set: DeckContent[];
  snap: DeckSnapshot | null;
  /** 這一份是從哪裡讀來的。⚠ 自動存畫要看它，見 {@link mayAutoSave}。 */
  where: "edit" | "room" | "server";
  /** 帳號指紋；認不出來是 `null`。⚠ 換帳號的判斷要看它，見 {@link accountChanged}。 */
  account: string | null;
  /** 玩家眼前是第幾格（場景的 `deck_now`）。 */
  deckNow: number | null;
} | null> {
  if (engine === null) return null;
  const live = await engine.readEditDeck();
  // ⚠ 快路徑：拿到記憶體那一份就不必看伺服器那份。
  if (live !== null) {
    const set = live.decks.map((d) => fromGame(deckContentFromServer(d)));
    return {
      current: set[0] ?? emptyDeckContent(),
      set,
      snap: null,
      where: live.where,
      account: live.account,
      deckNow: live.deckNow,
    };
  }
  try {
    const snap = await engine.readDecks();
    const set = snap.decks.map((d) => fromGame(deckContentFromServer(d)));
    return {
      current: set[0] ?? emptyDeckContent(),
      set,
      snap,
      where: "server",
      account: snap.account,
      deckNow: snap.deckNow,
    };
  } catch {
    return null;
  }
}

/**
 * **這一份 Deck1 可以拿去自動存檔嗎？**
 *
 * ## ⚠⚠ 房間場景裡看到的變動不是玩家的編輯
 *
 * `autoSave()` 的用途是「玩家在牌組編輯畫面改了牌，庫裡那一副要跟上」。但
 * Deck1 會變的地方不只那裡 —— `patch-room-gate` 的 preload **每次進房都會把
 * Deck1 換成那一房的牌**，而那是我們自己做的事。
 *
 * 兩者分不出來的話，會發生這件事（2026-09-10 實機）：
 *
 * ```
 *   人在任務房，Deck1 = 任務那一副
 *   直達跳到渦房 → 頁面 preload 把 Deck1 換成渦房那一副
 *   托盤的 4 秒拍子：Deck1 變了 → 存回 active[session.room]
 *   而 session.room 還停在上一房 → 渦房的牌被存進任務那一副（或反過來）
 * ```
 *
 * 實際災情是庫裡 raid 的第 3 副整個被任務那一副覆蓋，而 autoSave 從不出聲，
 * 記錄檔上一個字都沒有。這也正是 `autoSave` 檔頭那段「2026-08-27 弄丟兩副牌」
 * 的同一類事故 —— 那次補的是 `lastSeen` 那道閘，這次補的是「從哪個畫面讀的」。
 *
 * ## 為什麼 `server` 可以存
 *
 * 讀到伺服器那條路，表示玩家**不在任何一個有牌組列的畫面**（Edit／Quest／Raid／
 * Match 都會走快路徑）。而那正是「他剛離開編輯畫面、遊戲自己把 Deck1 送上伺服器」
 * 的那一刻 —— 玩家最後一次編輯只有在這裡收得到。房間的 preload 碰不到這條路，
 * 因為 preload 只發生在房間場景裡，而那時候一定走快路徑。
 */
function mayAutoSave(where: "edit" | "room" | "server"): boolean {
  return where !== "room";
}

/** 把庫存讀出來（有快取）。讀不到回 `null` —— 呼叫端**必須**當成「不准寫」。 */
async function deckInventory(): Promise<Inventory | null> {
  if (engine === null) return null;
  const now = Date.now();
  if (inventoryCache !== null && now - inventoryCache.at < INVENTORY_TTL_MS) {
    return inventoryCache.data;
  }
  try {
    const raw = await engine.readInventory();
    const data: Inventory = {
      chara: stockTable(raw.chara),
      weapon: stockTable(raw.weapon),
      event: stockTable(raw.event),
    };
    const hadSwaps = librarySwaps();
    inventoryCache = { at: now, data, charaFiles: raw.charaFiles };
    // 換卡的結果變了（第一次讀到、或玩家剛合成完）→ 頁面的預載與選單卡面要跟上。
    if (librarySwaps() !== hadSwaps) void pushDeckState().catch(() => {});
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 手上沒有的角色卡：寫進遊戲時臨時換成同一個角色的另一張
//
// 2026-09-25 迪城：玩家把沃蘭德 R2 合成成 R5，庫裡那副還寫著 R2，於是每點一次
// 都「有 1 張卡你手上沒有」。玩家定的規則：**換牌時臨時用最接近的，角色一樣就
// 行，最好是上位高等的**（`substituteCharas`）。牌組庫裡照舊是 R2。
//
// ⚠⚠ 兩個方向都要做，只做一邊會壞：
//
//   往遊戲寫（forGame）   Deck1／預載／選單卡面都用換過的
//   從遊戲讀（fromGame）  讀回 R5 那一副時認回庫裡的 R2 那一副
//
// 「Deck1 現在是哪一副」與「伺服器上是不是這一副」全是拿內容 hash 跟庫比的。
// 少了 fromGame，遊戲裡的 R5 對不上庫裡的 R2：選單失去黃字、開戰前每次都判成
// 「伺服器上不是它」而重寫一次，自動存檔的比較基準也會混進兩種寫法。
// ---------------------------------------------------------------------------

/** 已經在記錄裡講過的替換（`from→to`），同一組只講一次。 */
const swapsLogged = new Set<string>();

function cardLabel(id: number): string {
  const file = inventoryCache?.charaFiles[String(id)];
  if (file === undefined) return `#${id}`;
  return resolveCardFrame(file, cardNames)?.label ?? file;
}

/** 寫進遊戲的樣子。`quiet` = 只是拿來畫（選單、預載），不寫記錄。 */
function forGame(content: DeckContent, quiet = false): DeckContent {
  if (inventoryCache === null) return content;
  const out = substituteCharas(content, inventoryCache.data, inventoryCache.charaFiles);
  if (!quiet) {
    for (const s of out.swaps) {
      const key = `${s.from}→${s.to}`;
      if (swapsLogged.has(key)) continue;
      swapsLogged.add(key);
      log(
        `· 手上沒有 ${cardLabel(s.from)}，臨時用 ${cardLabel(s.to)} 代替（牌組庫裡照舊是 ${cardLabel(s.from)}）`,
      );
    }
  }
  return out.content;
}

/** 從遊戲讀回來的一副：正好是庫裡某一副換過卡的樣子，就認回那一副。 */
function fromGame(content: DeckContent): DeckContent {
  if (deck === null || inventoryCache === null) return content;
  const want = deckContentHash(content);
  const rooms = [deck.room, ...ROOM_KINDS.filter((r) => r !== deck!.room)];
  const all = rooms.flatMap((r) => listDecks(deck!.library, r));
  if (all.some((d) => deckContentHash(d.content) === want)) return content;
  for (const d of all) {
    const out = substituteCharas(d.content, inventoryCache.data, inventoryCache.charaFiles);
    if (out.swaps.length > 0 && deckContentHash(out.content) === want) return d.content;
  }
  return content;
}

/** 庫裡現在有哪幾副需要換卡、換成什麼（拿來判斷「結果變了沒」）。 */
function librarySwaps(): string {
  if (deck === null || inventoryCache === null) return "";
  const cache = inventoryCache;
  return ROOM_KINDS.flatMap((r) => listDecks(deck!.library, r))
    .map((d) => substituteCharas(d.content, cache.data, cache.charaFiles).swaps)
    .filter((s) => s.length > 0)
    .map((s) => s.map((x) => `${x.from}>${x.to}`).join(","))
    .join("|");
}

/** 一格預載（`slotWrite` 的形狀）換成寫進遊戲的樣子。 */
function slotForGame<
  T extends {
    chara_card_id: (number | null)[];
    weapon_card_id: (number | null)[];
    event_card_id: (number | null)[];
  },
>(slot: T): T {
  const content = forGame(
    { charaId: slot.chara_card_id, weaponId: slot.weapon_card_id, eventId: slot.event_card_id },
    true,
  );
  return { ...slot, chara_card_id: [...content.charaId] };
}

function saveDeckLibrary(options: { sync?: boolean } = {}): void {
  if (deck === null) return;
  try {
    writeLibrary(APP_DIR, deck.library);
  } catch (err) {
    log(`✗ 牌組庫存檔失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  // 本機動過就排一次雲端同步（同步自己落地的那次不排，否則會自己追自己）。
  if (options.sync !== false) scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// 雲端牌組庫（見 deck-sync.ts）
// ---------------------------------------------------------------------------

/** 本機存檔之後停多久才推 —— 玩家在編輯畫面連續改牌時只推最後那一次。 */
const DECK_SYNC_DEBOUNCE_MS = 8_000;
/** 沒動靜時多久去雲端看一次（另一台電腦改的東西要靠這一拍過來）。 */
const DECK_SYNC_INTERVAL_MS = 2 * 60_000;
/** 這個角色的雲端鍵。`null` = 還沒讀到（或頁面是舊版腳本）。 */
let deckSyncKey: string | null = null;
let deckSyncTimer: ReturnType<typeof setTimeout> | null = null;
let deckSyncRunning = false;
let deckSyncStatus: DeckSyncStatus | null = null;
/** 上一輪失敗過 —— 失敗只講一次，恢復時再講一次。 */
let deckSyncFailing = false;

function scheduleDeckSync(delayMs: number): void {
  if (!profile.deckCloudSync || deckSyncKey === null) return;
  if (deckSyncTimer !== null) clearTimeout(deckSyncTimer);
  deckSyncTimer = setTimeout(() => {
    deckSyncTimer = null;
    void runDeckSync();
  }, delayMs);
}

/**
 * 跟雲端同步一輪。
 *
 * ⚠ 三種情況這一輪不落地、晚點再來：
 * - 有一副排著隊還沒寫進伺服器（`pending`）—— 合併可能把它刪掉，隊伍會指向空氣
 * - 同步進行中玩家又改了牌（`deck.library` 換了一份）—— 合併結果是舊的基準算的
 * - 等待期間換了帳號 —— 結果屬於上一個人
 */
async function runDeckSync(): Promise<void> {
  if (!profile.deckCloudSync || deckSyncRunning) return;
  const key = deckSyncKey;
  const start = deck;
  if (key === null || start === null) return;
  if (start.pending !== null) {
    scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
    return;
  }
  deckSyncRunning = true;
  const account = deckAccount;
  try {
    const r = await syncDeckLibrary(start.library, {
      baseUrl: DEFAULT_DECK_SYNC_URL,
      key,
      fetch: globalThis.fetch as unknown as FetchLike,
    });
    if (!r.ok) {
      deckSyncStatus = { at: Date.now(), ok: false, text: r.reason };
      if (!deckSyncFailing) log(`⚠ 牌組跨電腦同步：${r.reason}（先用本機的，稍後再試）`);
      deckSyncFailing = true;
      pushState();
      return;
    }
    if (deckSyncFailing) log("✓ 牌組跨電腦同步恢復了");
    deckSyncFailing = false;

    const now = deck;
    if (now === null || deckAccount !== account || deckSyncKey !== key) return;
    if (now.library !== start.library || now.pending !== null) {
      // 同步期間本機又動了：下一輪用新的基準重來（雲端那份已經推上去也無妨）。
      scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
      return;
    }

    const parts: string[] = [];
    if (r.pulled > 0) parts.push(`拉下 ${r.pulled} 副`);
    if (r.deleted > 0) parts.push(`刪掉 ${r.deleted} 副`);
    if (r.pushed) parts.push("已推上 Cloudflare Workers");
    deckSyncStatus = {
      at: Date.now(),
      ok: true,
      text: parts.length > 0 ? parts.join("、") : "跟 Cloudflare Workers 上的一致",
    };

    if (r.localChanged) {
      // active 是用內容算的，合併之後重算；還沒觀察過 Deck1 就只清掉被刪掉的那幾副。
      const active =
        deckSeen.latest !== null
          ? resolveAll(r.library, deckSeen.latest)
          : (Object.fromEntries(
              ROOM_KINDS.map((room) => {
                const id = now.active[room];
                return [room, id !== null && findDeck(r.library, room, id) !== null ? id : null];
              }),
            ) as DeckSession["active"]);
      deck = { ...now, library: r.library, active };
      saveDeckLibrary({ sync: false });
      log(`· 牌組跨電腦同步：${deckSyncStatus.text}（另一台電腦改過的已經合進來）`);
      await pushDeckState();
    }
    pushState();
  } catch (err) {
    deckSyncStatus = {
      at: Date.now(),
      ok: false,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    deckSyncRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 牌組編輯畫面的人物篩選與最愛卡片（patch-chara-picker）
// ---------------------------------------------------------------------------

/** 上一次推給引擎的那份（一樣就不推：pushDeckState 很常跑）。 */
let charaPickerPushed: string | null = null;

/**
 * 把 [Chara] 鈕的設定與最愛清單推給引擎。
 *
 * 最愛與隱藏的裝備存在牌組庫裡（跟牌組一起上雲），所以牌組庫還沒接上（`deck === null`，
 * 包括牌組替換關閉時）就是 `favoritesReady: false` —— 最愛鈕與「隱藏裝備」不畫，
 * 免得點了存不進去。
 */
function pushCharaPicker(): void {
  if (engine === null) return;
  const state = {
    mode: profile.charaPicker,
    favorites: deck === null ? [] : favoriteCards(deck.library),
    hiddenWeapons: deck === null ? [] : hiddenWeapons(deck.library),
    favoriteEvents: deck === null ? [] : favoriteEvents(deck.library),
    favoritesReady: deck !== null,
  };
  const text = JSON.stringify(state);
  if (text === charaPickerPushed) return;
  charaPickerPushed = text;
  engine.setCharaPicker(state);
}

/**
 * 玩家在牌組編輯畫面按了「最愛卡片」（角色卡或事件卡）或「隱藏裝備」。
 * 存進牌組庫、排雲端同步、推回畫面。
 */
function onCharaPicker(report: CharaPickerReport): void {
  if (report.type === "chara-picker-error") return;
  if (deck !== null) {
    const toggle =
      report.type === "card-favorite"
        ? setFavoriteCard
        : report.type === "event-favorite"
          ? setFavoriteEvent
          : setHiddenWeapon;
    const library = toggle(deck.library, report.card, report.on);
    if (library !== deck.library) {
      deck = { ...deck, library };
      saveDeckLibrary();
    }
  }
  // 頁面已經先動了（樂觀更新）；存不進去（庫還沒接上）時這一推會把它扳回來。
  charaPickerPushed = null;
  pushCharaPicker();
}

// ---------------------------------------------------------------------------
// 首頁立繪與 Library 愛心複選（patch-lobby-stand）
// ---------------------------------------------------------------------------

/** 上一次推給引擎的那份（一樣就不推）。 */
let lobbyStandPushed: string | null = null;

/**
 * 把最愛角色套組、擺法與大廳元件推給引擎。跟最愛卡片一樣存在牌組庫裡（上雲），所以
 * 牌組庫還沒接上就是 `ready: false` —— 首頁與 Library 維持官方原樣，免得點了存不進去。
 */
function pushLobbyStand(): void {
  if (engine === null) return;
  const stand = deck === null ? null : lobbyStand(deck.library);
  const state = {
    ready: deck !== null,
    sets: stand?.sets ?? [],
    ui: stand?.ui ?? {},
  };
  const text = JSON.stringify(state);
  if (text === lobbyStandPushed) return;
  lobbyStandPushed = text;
  engine.setLobbyStand(state);
}

/** 玩家點了 Library 的愛心、或在首頁編輯模式按了 OK。存進牌組庫、排雲端同步、推回畫面。 */
function onLobbyStand(report: LobbyStandReport): void {
  if (report.type === "lobby-stand-error") return;
  if (deck !== null) {
    let library = setLobbyStandSets(deck.library, report.sets);
    if (report.ui !== undefined) library = setLobbyStandUi(library, report.ui);
    if (library !== deck.library) {
      deck = { ...deck, library };
      saveDeckLibrary();
    }
  }
  // 頁面已經先動了；存不進去（庫還沒接上）時這一推會把它扳回來。
  lobbyStandPushed = null;
  pushLobbyStand();
}

async function pushDeckState(): Promise<void> {
  if (engine === null) return;
  // 最愛也在牌組庫裡：庫換了（接上、同步合併、換帳號）就跟著推。
  pushCharaPicker();
  pushLobbyStand();
  const mode = activeDeckMode();
  if (mode === null) {
    // 關閉模式：選單拆掉、房間不預載不攔不釘。
    await engine.clearDeckEdit();
    await engine.setRoomDecks({ mode: "off", decks: {} });
    return;
  }
  if (deck === null) return;
  // 選單的卡面與總 COST、進房預載都用寫進遊戲的樣子（手上沒有的角色卡已經
  // 臨時換過，見 forGame）—— 畫出來的就是實際會用的那一副。
  const state = deckEditStateOf(deck, mode);
  await engine.setDeckEditState({
    ...state,
    decks: state.decks.map((d) => ({ ...d, content: forGame(d.content, true) })),
  });
  // ⚠ 每一房「進去要用哪幾格」也要跟著更新。玩家換了選擇之後不重推的話，
  // 進房時頁面塞的還是上一次那副 —— 而它會**贏過**托盤隨後寫進來的那一份
  // （頁面是在 create() 之前動手的，比較早）。見 `RoomDeckPreload`。
  const preload = roomDeckPreloadOf(deck, mode);
  for (const room of ROOM_KINDS) {
    const p = preload[room];
    if (p !== undefined) preload[room] = { ...p, slots: p.slots.map(slotForGame) };
  }
  await engine.setRoomDecks({ mode, decks: preload });
}

/**
 * 第一次接上（或換了帳號）時把牌組庫準備好。
 *
 * ```
 *   讀三副 + 帳號指紋 → 沒有存檔就把原本那三副收進庫裡 → 備份 → 推到畫面上
 * ```
 *
 * ⚠ **讀不到不是錯誤。** 遊戲還在標題畫面時沒有任何場景有 socket + 玩家 id，
 * 那正是玩家的正常開機順序（先開插件再開遊戲）。所以這裡安靜重試，只講一次。
 */
async function initDeckLibrary(): Promise<void> {
  if (engine === null) return;
  let snap: DeckSnapshot;
  try {
    snap = await engine.readDecks();
  } catch {
    if (!deckWaitLogged) {
      deckWaitLogged = true;
      log("· 牌組庫在等遊戲登入完成 —— 進到大廳就會自己接上");
    }
    return;
  }
  deckWaitLogged = false;
  deckPending = false;

  const current = deckContentFromServer(snap.decks[0]);
  const label = snap.accountLabel ?? undefined;
  const { library, dropped, migrated, existed, adopted } = readLibrary(
    APP_DIR,
    snap.account,
    label,
  );
  let lib = library;
  if (adopted !== null) {
    // 指紋換成玩家名稱之後的第一次：舊指紋存下的那幾份庫併進來（見 readLibrary）。
    log(
      `· 牌組庫：把這個角色先前分散的 ${adopted.files.length} 份存檔併回來了（${adopted.decks} 副，一樣的只留一副；舊檔沒動）`,
    );
  }
  if (migrated > 0) {
    // 改版前的存檔（資產索引）在讀的時候就轉成新卡號了，下面那次存檔會把它寫回新格式。
    log(`· 牌組庫裡 ${migrated} 副改版前的牌組已轉成新的卡片編號`);
  }

  if (!existed) {
    // 第一次用這個帳號：先把 Deck1 收進來（Deck2/Deck3 由下面的搬遷處理，
    // 它們要落在**固定的第 2、3 格**）。
    //
    // ⚠ **四房各收一份**（2026-09-09 改）。原本只收進迪特赫姆，結果其他三房
    // 一副都沒有 —— 而「進到那一房就自動套用那一套」在空的房間裡完全不會有
    // 動作，玩家看到的是「這功能對我沒作用」。四房各一份複本之後，他在哪一房
    // 都馬上有得選，再自己改成那一房要用的。
    if (!isEmptyDeck(current)) lib = seedAllRooms(lib, current);
  }

  deckAccount = snap.account;
  deckSyncKey = snap.syncKey;
  if (deckSyncKey === null && profile.deckCloudSync) {
    // 頁面讀不到註冊時間就不給雲端鍵（`@ulr/cdp-adapter` 的 `FINGERPRINT_SNIPPET`）
    // —— 講清楚是暫停，不然狀態欄空著，玩家會以為同步還在跑。
    deckSyncStatus = {
      at: Date.now(),
      ok: false,
      text: "暫停：讀不到角色的註冊時間，算不出同步用的鑰匙",
    };
  }
  // 接上的這一刻剛讀完伺服器，而頁面記憶體就是從它來的 —— 兩邊同一份。
  deckSeen.remember("both", current);
  officialSeen = null;
  deck = {
    ...newSession(lib),
    active: resolveAll(lib, current),
    slotNow: snap.deckNow ?? 1,
  };

  try {
    if (backupOnce(APP_DIR, snap))
      log("· 已把你原本的三副牌組備份起來（decks 資料夾，插件不會再動它）");
  } catch (err) {
    log(`✗ 牌組備份失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // ⚠ 搬遷要在存檔之前，這樣第一次跑就只寫一次檔。
  // 只有插件模式要清 Deck2／Deck3（官方三牌組模式三格都是玩家的牌）。
  if (activeDeckMode() === "plugin") await adoptServerDecks(snap, existed);

  // ⚠ 上面那個 await 中間可能斷線（`deck` 會被重設）。重讀一次，不要沿用
  // await 之前的那個參照。
  const settled = deck;
  if (settled === null) return;
  // ⚠ 先把卡片庫存暖起來。換牌組要驗庫存，而冷的快取是三趟 WebSocket ——
  // 不暖的話「開遊戲之後第一次切換」會比之後每一次都慢上一秒，而玩家只會
  // 記得「這東西有時候很慢」。這裡不等它，失敗也無所謂（換牌組時會再讀）。
  void deckInventory();

  const total = ROOM_KINDS.reduce((n, r) => n + listDecks(settled.library, r).length, 0);
  log(
    activeDeckMode() === "official"
      ? `✓ 牌組庫已接上（${total} 副，官方三牌組模式：每一房用那一房的前三副）`
      : `✓ 牌組庫已接上（${total} 副）—— 在遊戲的牌組編輯畫面點左下角那個牌盒`,
  );
  if (dropped > 0) log(`⚠ 存檔裡有 ${dropped} 副壞掉的記錄，已跳過`);
  saveDeckLibrary({ sync: false });
  await pushDeckState();
  // 一接上就跟雲端對一次：另一台電腦在這段期間改的牌組要馬上過來。
  if (profile.deckCloudSync && deckSyncKey !== null) void runDeckSync();
}

/**
 * **把伺服器的 Deck2／Deck3 收進牌組庫，然後在伺服器上清空它們。**
 *
 * 2026-08-28 的決定：伺服器那三格只留 Deck1 當工作槽。
 *
 * ```
 *   伺服器 Deck2 ─▶ 自訂牌組第 2 格 ─┐
 *   伺服器 Deck3 ─▶ 自訂牌組第 3 格 ─┴─▶ 伺服器只剩 Deck1
 * ```
 *
 * ## ⚠ 為什麼「清空」不只是整理
 *
 * 卡片庫存是**三副共扣同一個池子**。Deck2/Deck3 佔著卡的時候，把同一張卡再
 * 寫進 Deck1 就是同一張用兩次 —— 改版後伺服器會直接退回 `deck_update`，而
 * 牌組編輯畫面退回時**不說話**，只是按返回沒反應。清空之後那些卡回到池子，
 * 每一副自訂牌組才都用得到它們（玩家要的「可用所有事件卡」就是這個）。
 *
 * ## 第一次 vs 之後
 *
 * - 這個帳號第一次接上（`existed === false`）：照 2026-08-28 的規則放進四房的
 *   **第 2、3 格**，順序跟玩家在遊戲裡看到的一樣。
 * - 之後（例如剛從官方三牌組模式切回來、或改版後在官方介面排了新牌）：**接在
 *   後面**，不覆蓋任何一副。已經在庫裡某一房的（內容一樣）就不再收。
 *
 * ## ⚠ 順序不能顛倒
 *
 * **先搬進庫、存檔，再清伺服器。** 反過來的話，清完到存檔之間任何一個閃失
 * （斷線、當掉）都會讓那兩副牌同時從伺服器和庫裡消失。備份檔是最後一道網。
 */
async function adoptServerDecks(snap: DeckSnapshot, existed: boolean): Promise<void> {
  if (engine === null || deck === null) return;

  const deck2 = deckContentFromServer(snap.decks[1]);
  const deck3 = deckContentFromServer(snap.decks[2]);
  const has2 = !isEmptyDeck(deck2);
  const has3 = !isEmptyDeck(deck3);
  if (!has2 && !has3) return;

  // 1. 先搬進庫並落地（已經在庫裡的就不再收）
  const known = (c: DeckContent): boolean =>
    deck !== null && ROOM_KINDS.some((r) => resolveActive(deck!.library, r, c) !== null);
  const take = [has2 && !known(deck2) ? deck2 : null, has3 && !known(deck3) ? deck3 : null];
  if (!existed) {
    deck = migrateServerDecks(deck, take[0] ?? null, take[1] ?? null);
  } else {
    let library = deck.library;
    for (const content of take) {
      if (content === null) continue;
      for (const room of ROOM_KINDS) library = addDeck(library, room, { content }).library;
    }
    deck = { ...deck, library };
  }
  saveDeckLibrary();

  // 2. 再清伺服器。Deck1 原樣帶回去 —— `deck_update` 一次覆寫整份。
  const next = snap.decks.map((d) =>
    d.deck_id === 1 ? d : withDeckContent(d, emptyDeckContent()),
  );
  try {
    const result = await engine.applyDecks(next);
    if (result.answer !== "ok") {
      log(
        result.answer === "rejected"
          ? "⚠ 想清空伺服器的 Deck2／Deck3，伺服器不收 —— 牌組已經收進庫裡了，下次再試"
          : "⚠ 想清空伺服器的 Deck2／Deck3，但伺服器沒回應 —— 牌組已經收進庫裡了，下次再試",
      );
      return;
    }
    // deck_update 成功 = 伺服器與記憶體都是這一份（頁面已經就地同步）。
    deckSeen.remember("both", fromGame(deckContentFromServer(snap.decks[0])));
    inventoryCache = null;
    const added = take.filter((c) => c !== null).length;
    log(
      `✓ 伺服器的 Deck${has2 && has3 ? "2、Deck3" : has2 ? "2" : "3"} 已清空` +
        (added > 0 ? `（${added} 副收進了牌組庫的每一房）` : "（庫裡本來就有）") +
        " —— 那些卡回到池子，現在每一副自訂牌組都用得到",
    );
  } catch (err) {
    log(`⚠ 清空 Deck2／Deck3 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 真的把一副牌寫進 Deck1。回 `null` = 成功，回字串 = 拒絕或失敗的理由。
 *
 * 三道關卡，順序不能換：
 *
 * ```
 *   1. guardDeck1  —— 第一格空的：房間與伺服器那條都不收（開戰會拿空牌上場）
 *                     ⚠ 人在 Edit 時寫空 = 幫他按 reset，那條放行
 *   2. 庫存        —— 只送玩家真的有的卡。讀不到庫存就**不寫**
 *   3. 伺服器的回答 —— deck_update 回 false 才算寫進去
 * ```
 *
 * ## 改版前的「讀回來對過」那一道拿掉了
 *
 * 舊協定（`db_editdeck`）的 ack 只證明伺服器回了話，2026-08-27 撞過「ack 了卻
 * 沒寫進去」，所以當時每次都要再讀一次。改版後的 `deck_update` 有明確的回答
 * （`false` = 成功、`true` = 退回），跟官方牌組編輯畫面認的是同一個 —— 不必再多
 * 送一次請求去驗（2026-09-13 的規矩：盡量不要多送）。
 */
/**
 * 寫到哪裡為止。
 *
 * ```
 *   front   只寫客戶端記憶體（玩家人在 Edit 畫面時）。**一次網路都不跑。**
 *           寫不到就回 `none` 當成功 —— 那不是失敗，只是他不在那個畫面。
 *   commit  一路寫到伺服器。等候秒數到了、或開戰前才走這條。
 * ```
 *
 * ⚠ 這個分法就是「只在前端看得到，不套用給後端」那條規格（2026-09-09）。
 */
type WriteMode = "front" | "commit";

/**
 * 寫到了哪裡 —— 呼叫端靠它決定「這一副算不算已經落地」。
 *
 * ```
 *   edit    寫進 Edit 畫面的記憶體。⚠ 對牌組庫而言**這就是落地**：遊戲會在玩家
 *           離開畫面時自己送上伺服器，沒有第二步要做（見 frontApplyPending）。
 *   room    只寫了房間場景的記憶體（front 模式）。伺服器還是舊的，還得提交。
 *   none    front 模式、沒有畫面可寫。那一副還排在隊伍裡。
 *   server  寫進伺服器並讀回對過。
 * ```
 */
type WriteDone = "edit" | "room" | "none" | "server";
type WriteResult = { done: WriteDone; failure?: undefined } | { done?: undefined; failure: string };

const failed = (failure: string): WriteResult => ({ failure });
const wrote = (done: WriteDone): WriteResult => ({ done });

async function writeDeck1(
  requested: DeckContent,
  snapshot: DeckSnapshot | null,
  mode: WriteMode = "commit",
): Promise<WriteResult> {
  if (engine === null) return failed("還沒接上遊戲。");
  let content = requested;

  // ⚠ 空牌組**不在這裡擋死**（2026-09-12 改）。玩家人在 Edit 畫面時選一副空的，
  // 等於幫他按 reset —— 寫進記憶體的狀態跟遊戲 reset 鈕產生的一模一樣，出口
  // 那道「第一格不能空」是遊戲自己擋、玩家看得到原因。原本一律拒絕的症狀是
  // 「選了空牌組，舊的那副還在畫面上」，得自己再按一次 reset。
  //
  // 擋的地方往下移：快路徑只有 Edit 收（房間場景回 `empty-room`），沒收到就照
  // 原本的理由拒絕 —— **伺服器那條路永遠不會拿到空的**，那才是卡死的來源。
  const guard = guardDeck1(content);

  // ⚠ 讀不到庫存時**拒絕**而不是放行。放行的代價是可能送出玩家沒有的卡，
  // 而拒絕的代價只是玩家再點一次 —— 兩邊不對等。（空牌組沒有卡可查，跳過。）
  if (guard === null) {
    const inventory = await deckInventory();
    if (inventory === null) return failed("讀不到你的卡片庫存，先不換 —— 再點一次試試。");
    // 手上沒有的角色卡臨時換成同角色的另一張（見 forGame）。⚠ 底下記進 deckSeen
    // 的是 `requested`（庫裡的寫法），跟 currentDeck1() 讀回來認的是同一套。
    content = forGame(content);
    const shortages = findShortages(content, inventory);
    if (shortages.length > 0) {
      return failed(`這副牌有 ${shortages.length} 張卡你手上沒有，沒有換過去。`);
    }
  }

  // ── 快路徑：玩家人就在編輯畫面 → 只換記憶體並重畫，一次網路都不跑 ────────
  //
  // 這是原版 ◀▶ 的做法（見 `deck-write.ts` 的 buildEditDeckWriteExpression）。
  // 走伺服器的話一次切換是 8~11 趟 WebSocket，玩家按下去要等一秒以上；
  // 走這裡是一次 `Runtime.evaluate`，跟原版一樣即時。
  //
  // ⚠ 這裡**不寫伺服器**，而那是對的：遊戲在玩家離開編輯畫面時會自己送
  // `deck_update`，帶的就是我們剛換進去的那一份。
  try {
    const fast = await engine.writeEditDeck([slotWrite(1, content)], 1);
    // 編輯畫面：寫完就結束。遊戲會在玩家離開時自己把它送上伺服器。
    if (fast === "ok") {
      // ⚠ **只有客戶端**。伺服器上還是舊的那一副，要等玩家離開 Edit 時遊戲
      // 自己送 —— 而那一趟正是自動存檔唯一收得到他最後一次編輯的機會。
      deckSeen.remember("client", requested);
      return wrote("edit");
    }
    // 空的那一副只有 Edit 收得下（上面 "ok" 那條）。走到這裡表示玩家不在
    // Edit —— 房間場景頁面端已經拒絕（`empty-room`）、不在畫面上更不能寫伺服器。
    // ⚠ 這裡 return 的是 guardDeck1 的理由，而且 `front` 模式也一樣：空牌組
    // 留在隊伍裡沒有意義，等候秒數到了只會在提交那一步再失敗一次。
    if (guard !== null) return failed(guard);
    // ⚠⚠ 房間場景（任務／渦／對戰房）：畫面已經換好了，但**沒有人會把它送上
    // 伺服器** —— 遊戲只在離開 Edit 時送。所以只有 `front` 模式可以在這裡收工；
    // `commit` 模式一定要繼續走下去，否則開戰時伺服器上還是舊的那一副，
    // 而畫面看起來完全正常。
    if (fast === "ok-room") {
      // ⚠⚠ **只有客戶端**，而且房間場景裡沒有人會把它送上伺服器。這一行就是
      // 2026-09-20「迪城的牌組1 變成渦那副」的起點：舊制把它記成唯一一份基準，
      // 於是三秒內讀到伺服器（還躺著上一房那副）就被判成「玩家改了牌」。
      deckSeen.remember("client", requested);
      if (mode === "front") return wrote("room");
    } else if (fast !== "not-active") {
      return failed(`換不過去：${fast}`);
    } else if (mode === "front") {
      // 玩家不在任何有牌組列的畫面，沒有記憶體可以換。**這不是失敗**：
      // 那一副還排在隊伍裡，等候秒數到了或他按開戰時才會真的寫出去。
      return wrote("none");
    }
  } catch (err) {
    return failed(`換不過去：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 慢路徑：寫伺服器 ──────────────────────────────────────────────────────
  const snap = snapshot ?? (await engine.readDecks());

  // ⚠ Deck2/Deck3 照原樣帶回去 —— `deck_update` 一次覆寫整份，不帶就是清空。
  const next = snap.decks.map((d) => (d.deck_id === 1 ? withDeckContent(d, content) : d));
  // 三副共用一個卡池：Deck2／Deck3 還沒清掉的話，要合起來塞得下才送。
  if (guard === null) {
    const inventory = await deckInventory();
    const others = snap.decks.filter((d) => d.deck_id !== 1).map((d) => deckContentFromServer(d));
    if (inventory !== null && findSetShortages([content, ...others], inventory).length > 0) {
      return failed("這副牌跟 Deck2／Deck3 搶同一張卡，沒有換過去 —— 伺服器上那兩副要先清空。");
    }
  }
  const result = await engine.applyDecks(next);
  if (result.answer === "no-answer") {
    return failed("伺服器沒有回應，牌組沒有換過去 —— 再點一次試試。");
  }
  if (result.answer === "rejected") {
    log("✗ 換牌組：伺服器退回了（多半是 Deck2／Deck3 還佔著同一張卡）");
    return failed("伺服器不收這副 —— 多半是 Deck2／Deck3 還佔著同一張卡。");
  }
  // deck_update 回 false：伺服器與記憶體都是這一份（頁面已經就地同步）。
  deckSeen.remember("both", requested);
  return wrote("server");
}

/**
 * 玩家在牌組編輯畫面點了什麼。
 *
 * ⚠ **先讀一次 Deck1 現況**，理由是自動存檔：玩家很可能剛排完牌就直接按 ◀▶，
 * 那些改動只存在客戶端記憶體裡。不先存回去的話，下一副牌一換進來就沒了 ——
 * 而症狀是「我排的牌自己不見了」。
 *
 * ⚠ **不要在這裡讀伺服器。** 人就在編輯畫面時 `currentDeck1()` 走記憶體，
 * 整條路徑只剩三次 `Runtime.evaluate`；換成讀伺服器的話每按一次 ◀▶ 都是
 * 八到十一趟 WebSocket，而那正是玩家回報的「換自訂牌組好慢」。
 * 換帳號的偵測交給輪詢那一拍（它離開畫面時本來就會讀伺服器）。
 */
async function onDeckReport(report: DeckEditReport): Promise<void> {
  if (engine === null || deck === null) return;
  // 玩家連點時忙著就丟掉後面幾則 —— 但 raid-pick 同一個渦頁面只報一次，丟了
  // 就不會再來（常見的撞法：剛進渦房、進房換牌還在寫就點了渦），所以等它讓出來。
  if (deckBusy && !(report.type === "raid-pick" && (await waitForDeckIdle(2_000)))) return;
  if (deckBusy || engine === null || deck === null) return;
  deckBusy = true;
  try {
    const now = await currentDeck1();
    if (now === null) {
      deck = withNotice(deck, "讀不到你的牌組 —— 再點一次試試。");
      await pushDeckState();
      return;
    }
    const { current, snap } = now;
    // 換帳號登入了 —— 這一則屬於上一個人的庫，丟掉，下一拍整份重來。
    // ⚠ 快路徑也驗（`now.account`），不是只有讀伺服器那條：見 resetDeckSession。
    if (accountChanged(now.account)) return;

    if (activeDeckMode() === "official") {
      await onOfficialReport(report, now);
      return;
    }

    // ⚠ 房間場景看到的變動是 preload 做的，不是玩家的編輯 —— 見 mayAutoSave。
    // ⚠ 基準要跟**同一個來源**的上一份比（`deckSeen.forSource`），見 deck-seen.ts。
    const saved = mayAutoSave(now.where)
      ? autoSave(deck, current, deckSeen.forSource(now.where))
      : { session: deck, saved: false };
    deckSeen.remember(worldOf(now.where), current);

    // ⚠ 房裡那組 ◀▶ 切的是**玩家人在的那一房**，不是選單看的那一房。
    //
    // 兩者平常一致（進房時選單會自動跟隨），但玩家可以人在任務房、卻把選單
    // 切去看迪城的牌組 —— 那時候按房裡的箭頭必須切任務房的那幾副。少了這一
    // 步的後果是**拿錯牌組上場**，而畫面上完全看不出來。
    let base = saved.session;
    if (
      report.type === "deck-cycle" &&
      report.from === "room" &&
      base.here !== null &&
      base.here !== base.room
    ) {
      base = { ...base, room: base.here };
    }

    const outcome = applyReport(base, report, current);
    // ⚠ 訊息要自己寫進記錄。遊戲畫面上那行紅字移掉之後（見 `DeckEditState`），
    // `applyReport()` 交出來的訊息就只剩這一個出口 —— 少了這一步，「這一房還
    // 沒有牌組」「已刪除…」這些話會完全消失。
    if (outcome.session.notice !== null && outcome.session.notice !== base.notice) {
      log(`· ${outcome.session.notice}`);
    }
    deck = outcome.session;

    // ⚠⚠ **只寫前端**（2026-09-09 起）。伺服器那一份等等候秒數到了、或者
    // 玩家按下開戰時才寫 —— 見 `PendingApply` 與 `patch-room-gate.ts`。
    await frontApplyPending(current, snap);
    saveDeckLibrary();
    await syncGatePending();
    await pushDeckState();
  } finally {
    deckBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 官方三牌組模式（2026-09-24）
//
// 每一房的前三副就是那一房的 Deck1..3。進房時三格一起換進客戶端記憶體（頁面
// 預載），開戰前閘門確認伺服器上是這三副；◀▶ 照官方行為。跟插件模式最大的差別：
// 三副同時躺在伺服器上，所以**庫存要三副合起來算**（findSetShortages）。
// ---------------------------------------------------------------------------

type DeckRead = NonNullable<Awaited<ReturnType<typeof currentDeck1>>>;

/**
 * 把 `room` 那一房的三副換進客戶端記憶體（只動記憶體，一趟網路都不跑）。
 * 回 `null` = 換好了（或那一房沒有牌組、玩家不在有牌組列的畫面，都不必換）；
 * 回字串 = 為什麼沒換。
 */
async function loadOfficialSet(room: RoomKind): Promise<string | null> {
  if (engine === null || deck === null) return "還沒接上遊戲。";
  const set = officialSetOf(deck.library, room);
  if (set.every((s) => s.entry === null)) return null;
  const inventory = await deckInventory();
  if (inventory === null) return "讀不到你的卡片庫存，先不換。";
  // 手上沒有的角色卡臨時換掉（見 forGame）。三副各自換，合起來還是要塞得下。
  const contents = set.map((s) => forGame(s.content));
  const short = findSetShortages(contents, inventory);
  if (short.length > 0) {
    return `${ROOM_LABELS[room]}那三副合起來有 ${short.length} 種卡不夠（三副共用一個卡池），沒有換過去。`;
  }
  const res = await engine.writeEditDeck(
    set.map((s, i) => slotWrite(s.deckId, contents[i] ?? s.content)),
    null,
  );
  if (res === "ok" || res === "ok-room" || res === "not-active") return null;
  return `換不過去：${res}`;
}

/** 官方三牌組模式的選單回報。`now` 是呼叫端剛讀的那一份。 */
async function onOfficialReport(report: DeckEditReport, now: DeckRead): Promise<void> {
  if (deck === null) return;
  // 先把玩家在 Edit 裡排的存回去（跟插件模式一樣：先存再動，不然換進來的會蓋掉他的牌）。
  if (now.where !== "room") {
    const saved = officialAutoSave(deck, now.set, officialSeen);
    if (saved.saved > 0) deck = saved.session;
  }
  officialSeen = now.set;
  // 官方模式不照渦 BOSS 換牌（那是插件模式「一房很多副」才有的功能）。
  if (report.type === "raid-pick") return;
  deck = { ...deck, slotNow: now.deckNow ?? deck.slotNow };
  const out = applyOfficialReport(deck, report);
  if (out.session.notice !== null && out.session.notice !== deck.notice) {
    log(`· ${out.session.notice}`);
  }
  deck = out.session;
  if (out.load) {
    const why = await loadOfficialSet(deck.room);
    if (why !== null) {
      log(`✗ ${why}`);
    } else {
      // 剛換進去的就是新的比較基準，不是玩家的編輯。
      officialSeen = officialSetOf(deck.library, deck.room).map((s) => s.content);
      if (report.type === "room-switch") log(`· 換上${ROOM_LABELS[deck.room]}的三副`);
    }
  }
  saveDeckLibrary();
  await pushDeckState();
}

/**
 * 官方三牌組模式的開戰前那一道：伺服器上躺的一定要是這一房的三副。
 * 回 `true` 表示可以放心開打（包含「這一房沒有指派牌組，不歸我們管」）。
 */
async function ensureOfficialSet(room: RoomKind | null): Promise<boolean> {
  if (engine === null || deck === null) return false;
  if (room === null) return true;
  // 先讀庫存：伺服器那三副要用它認回庫裡的寫法（fromGame），寫的時候也要換卡。
  const inventory = await deckInventory();
  if (deck === null) return false;
  const set = officialSetOf(deck.library, room);
  if (set.every((s) => s.entry === null)) return true;
  let snap: DeckSnapshot;
  try {
    snap = await engine.readDecks();
  } catch (err) {
    logReadDecksFailure("battle", err);
    return false;
  }
  const server = snap.decks.map((d) => fromGame(deckContentFromServer(d)));
  const target = set.map((s) => s.content);
  if (sameSet(server, target)) return true;
  const effective = set.map((s) => forGame(s.content));
  if (inventory === null || findSetShortages(effective, inventory).length > 0) {
    log(`✗ 開戰前換牌組：${ROOM_LABELS[room]}那三副合起來庫存不夠，照伺服器上原本的打`);
    return false;
  }
  const next = snap.decks.map((d) => {
    const i = set.findIndex((x) => x.deckId === d.deck_id);
    return i < 0 ? d : withDeckContent(d, effective[i] ?? set[i]!.content);
  });
  const result = await engine.applyDecks(next);
  if (result.answer !== "ok") {
    log(
      `✗ 開戰前換牌組：${result.answer === "rejected" ? "伺服器不收" : "伺服器沒有回應"}` +
        `（${ROOM_LABELS[room]}的三副），照伺服器上原本的打`,
    );
    return false;
  }
  log(`✓ 開戰前已換上${ROOM_LABELS[room]}的三副`);
  return true;
}

// ---------------------------------------------------------------------------
// 等候套用與開戰閘門（WP-19）
// ---------------------------------------------------------------------------

/** 上一次推給頁面的 pending 旗標。**只在變動時推**，不然每 500ms 一次 evaluate。 */
let gatePendingPushed: boolean | null = null;

/** 一副牌在記錄與訊息裡要叫什麼。找不到就用位置編號（跟選單裡一致）。 */
function deckLabel(session: DeckSession, room: RoomKind, id: string): string {
  const entry = findDeck(session.library, room, id);
  if (entry === null) return "那一副";
  const index = listDecks(session.library, room).findIndex((d) => d.id === id);
  return displayName(entry, index < 0 ? 0 : index);
}

/**
 * 把「有沒有東西還沒寫進伺服器」推給頁面的閘門。
 *
 * ⚠ 旗標是 `false` 時閘門完全不作用，開戰的 emit 原樣直通 —— 那是常態路徑，
 * 一次額外的延遲都沒有。
 */
async function syncGatePending(): Promise<void> {
  if (engine === null) return;
  const want = deck !== null && deck.pending !== null;
  if (want === gatePendingPushed) return;
  gatePendingPushed = want;
  await engine.setRoomGatePending(want);
}

/**
 * **把排著隊的那一副立刻換到玩家眼前。** 只動客戶端記憶體，一次網路都不跑。
 *
 * ## 為什麼「排隊」跟「看得見」要分開
 *
 * 排隊那三秒（{@link PendingApply}）擋的是**寫伺服器** —— 玩家連按 ◀▶ 找牌組
 * 時每一下都上傳一次的話，他等的是「按幾下 × 一秒」。但**畫面**沒有理由跟著
 * 等：換記憶體是一次 `Runtime.evaluate`，跟原版那兩個箭頭一樣即時。
 *
 * ⚠⚠ 2026-09-09 回報：**進了任務房，畫面上還是渦房那副牌，要等三秒才換。**
 * 原因就是進房那條路（`onRoomGate` 的 `room-changed`）只排隊、沒有走這裡，
 * 於是玩家看到的是三秒後伺服器那條慢路徑把畫面換過去。人在哪一房就該看到
 * 那一房的牌，這件事不能有延遲 —— 延遲期間他看到的是**上一房**的牌，而那正
 * 是他最容易誤按 START 打下去的東西。
 *
 * ⚠ 寫不進去（庫存不足、第一格是空的…）就**把隊伍清掉**，不要留著等三秒後
 * 再失敗一次。同時把 `active` 重算回來 —— 那一副沒有換成，黃字不該指著它。
 *
 * ⚠ `fronted` 記的是「已經換到眼前了」，這支靠它避免重複寫。它**不表示**已經
 * 寫進伺服器 —— 那是 {@link commitPending} 的事。
 *
 * ## ⚠⚠ 在 Edit 畫面換到眼前 = 落地，隊伍當場清掉（2026-09-12）
 *
 * 人在牌組編輯畫面時，這一步之後**沒有第二步**：遊戲會在玩家離開畫面時自己把
 * deck1 送上伺服器，等候秒數到了再「提交」一次是多餘的 —— 而且有害。提交走
 * 的是同一條快路徑，會把**庫裡那份快照**再寫進記憶體一次，玩家在那三秒裡排
 * 的牌當場被蓋回去（選了空牌組的話，是剛放進去的卡又被清掉）。2026-09-12
 * 回報：「三秒套用牌組已經干擾了手牌編輯，把手牌清空，或是把手牌復原」。
 *
 * 所以 `edit` 這個結果直接 {@link applyLanded}：active 指到那一副（接下來的
 * 編輯由自動存檔存進它），pending 清掉（等候秒數與開戰閘門都不會再碰它）。
 * 房間場景（`room`）不在此列 —— 那裡沒有人會把記憶體送上去，非提交不可。
 */
async function frontApplyPending(
  current: DeckContent,
  snapshot: DeckSnapshot | null,
): Promise<void> {
  if (deck === null) return;
  const pending = deck.pending;
  if (pending === null || pending.fronted) return;

  // 左下那行字由頁面照狀態畫（`DeckEditState.slots`），這裡只拿名字寫記錄。
  const label = deckLabel(deck, pending.room, pending.id);
  const result = await writeDeck1(pending.content, snapshot, "front");
  if (result.failure !== undefined) {
    deck = withNotice(
      {
        ...deck,
        pending: null,
        active: {
          ...deck.active,
          [pending.room]: resolveActive(deck.library, pending.room, current),
        },
      },
      result.failure,
    );
    log(`✗ 換牌組：${result.failure}`);
    return;
  }
  if (result.done === "edit") {
    // 編輯畫面：到此為止（見上面 ⚠⚠）。
    deck = applyLanded(deck, pending);
    log(`✓ 已換成「${label}」（${ROOM_LABELS[pending.room]}，離開編輯畫面時遊戲自己會存）`);
    return;
  }
  // 前端換好了，玩家眼睛已經看到新的牌。
  if (deck.pending !== null) deck = { ...deck, pending: { ...deck.pending, fronted: true } };
}

/**
 * **把排著隊的那一副真的寫進伺服器。** 回 `true` 表示寫成了（或本來就不必寫）。
 *
 * ⚠ 這支是唯一會走慢路徑的地方。它有三個呼叫端：等候秒數到了、玩家按下開戰、
 * 以及玩家離開遊戲前的收尾。
 */
async function commitPending(reason: "dwell" | "battle"): Promise<boolean> {
  if (engine === null || deck === null) return true;
  const pending = deck.pending;
  if (pending === null) return true;

  // ⚠⚠ **這裡一定要看伺服器，不能用 `currentDeck1()`。**
  //
  // `currentDeck1()` 回的是「玩家眼前那一副」，而在房間場景那正是我們自己剛
  // 寫進去的 pending —— 拿它來判斷「要不要提交」的話**永遠都會相等**，於是
  // 一次都不會真的寫到伺服器，而開戰時用的是舊的那一副。畫面看起來完全正常，
  // 這是最難發現的那一種。
  let snap: DeckSnapshot;
  try {
    snap = await engine.readDecks();
  } catch (err) {
    // 讀不到就不寫 —— 沒有比較基準時動 Deck1 是這個專案付過代價的事。
    //
    // ⚠⚠ **但一定要說出來**（2026-09-20）。這條路原本一個字都不寫，而它會
    // 一直失敗下去（`readDecks` 走頁面裡自己開的那條池連線，遊戲剛重載完
    // 那個東西還不存在）。症狀是「插件說換好了、打起來卻是上一房的牌」，
    // 而記錄檔完全空白 —— 月的腳本 2026-09-10 就是在這裡卡了 35 秒。
    logReadDecksFailure(reason, err);
    return false;
  }
  // fromGame 要用庫存；斷線重連後快取是空的，先讀一次（不送請求）。
  if (inventoryCache === null) await deckInventory();
  const server = fromGame(deckContentFromServer(snap.decks[0]));

  // 伺服器上已經是那一副了（玩家自己在遊戲裡換的、或離開 Edit 時遊戲自己送上
  // 去的）→ 沒有東西要做。
  if (deckContentHash(server) === deckContentHash(pending.content)) {
    deck = applyLanded(deck, pending);
    // ⚠ 只記伺服器那一份。客戶端記憶體我們沒碰（玩家可能根本不在有牌組列的
    // 畫面上），拿這一份去蓋客戶端基準等於替一個沒看過的世界作證。
    deckSeen.remember("server", server);
    saveDeckLibrary();
    await syncGatePending();
    await pushDeckState();
    return true;
  }

  const result = await writeDeck1(pending.content, snap, "commit");
  if (result.failure !== undefined) {
    // ⚠ 寫不進去就把隊伍清掉，**不要留著反覆重試**。留著的話玩家每按一次
    // 開戰都會被攔一下再失敗一次，而他看到的是「這遊戲卡卡的」。
    //
    // ⚠⚠ **`active` 要照伺服器現況重算**（2026-09-20）。寫失敗的意思是伺服器
    // 上躺的還是上一房那副，而 `enterRoom` 早就把 `active[room]` 指到玩家想換
    // 的那一副了 —— 兩者兜在一起，下一次讀到伺服器就會把上一房那副存進他這
    // 一副（實機：從渦房走到對戰房，迪城的牌組1 整副變成渦那副）。隊伍清掉
    // 之後 `pending` 那道閘也不再擋，所以這裡非重算不可。
    // 這跟 `frontApplyPending` 失敗時做的是同一件事。
    deck = withNotice(
      {
        ...deck,
        pending: null,
        active: {
          ...deck.active,
          [pending.room]: resolveActive(deck.library, pending.room, server),
        },
      },
      result.failure,
    );
    // 伺服器那一份基準也要追上：我們剛親眼看到它還是 `server`。
    deckSeen.remember("server", server);
    log(`✗ ${reason === "battle" ? "開戰前換牌組" : "套用牌組"}：${result.failure}`);
    await syncGatePending();
    await pushDeckState();
    return false;
  }

  deck = applyLanded(deck, pending);
  const label = deckLabel(deck, pending.room, pending.id);
  log(
    reason === "battle"
      ? `✓ 開戰前已套用「${label}」（${ROOM_LABELS[pending.room]}）`
      : `✓ 已套用「${label}」（${ROOM_LABELS[pending.room]}）`,
  );
  saveDeckLibrary();
  await syncGatePending();
  await pushDeckState();
  return true;
}

/**
 * 每半秒看一眼排著的那一副等夠久了沒。
 *
 * ⚠ 這一拍**不碰網路**，除非真的到期要寫 —— 沒有 pending 時它只是一個
 * 布林判斷。
 */
async function deckApplyTick(): Promise<void> {
  if (engine === null || deck === null || deckBusy) return;
  if (deck.pending === null) return;
  if (!isApplyDue(deck, applyDelayMs())) return;
  deckBusy = true;
  try {
    await commitPending("dwell");
  } finally {
    deckBusy = false;
  }
}

/** 玩家設的等候秒數，換算成毫秒。 */
function applyDelayMs(): number {
  return Math.round(profile.applyDelaySeconds * 1000);
}

/**
 * 頁面回報：換房了，或者開戰被攔下來了。
 *
 * ⚠⚠ **`room-gate-hold` 一定要放行。** 玩家的畫面在被攔的那一刻已經是「已
 * 開始」而且點不動任何東西 —— 這裡每一條路徑（包含失敗）都必須走到
 * `releaseRoomGate()`。頁面自己有 8 秒的看門狗兜底，但那條路會讓玩家用舊牌組
 * 上場。
 */
async function onRoomGate(report: RoomGateReport): Promise<void> {
  if (engine === null) return;
  const mode = activeDeckMode();
  // 關閉模式、或牌組庫還沒接上：攔到的一律立刻放行（頁面理應不會攔，這是保險）。
  if (mode === null || deck === null) {
    if (report.type === "room-gate-hold") await engine.releaseRoomGate(true);
    return;
  }

  if (report.type === "room-changed") {
    const now = await currentDeck1();
    if (now === null) return;
    // ⚠⚠ 這裡最要緊：換了帳號還往下走的話，enterRoom 會拿上一個人的庫排隊、
    // frontApplyPending 把那副牌塞進這個人的 Deck1（2026-09-14 實機）。
    if (accountChanged(now.account) || deck === null) return;

    if (mode === "official") {
      // 官方三牌組模式：選單跟著人走；頁面沒預載到的話（這一房剛有牌組、腳本
      // 晚裝上）托盤自己換。伺服器那份等開戰前的閘門寫。
      if (report.room !== null) {
        deck = { ...deck, here: report.room, room: report.room, slotNow: now.deckNow ?? 1 };
        if (report.preloaded !== true) {
          const why = await loadOfficialSet(report.room);
          if (why !== null) log(`✗ 進了${ROOM_LABELS[report.room]}：${why}`);
        }
      } else {
        deck = { ...deck, here: null };
      }
      await pushDeckState();
      return;
    }

    const before = deck.pending?.id ?? null;
    // ⚠ `preloaded` 一定要傳下去。它是 true 時客戶端記憶體已經是新的、而伺服器
    // 還是舊的 —— 不傳的話 `queueApply` 會判定「一樣，不必寫」，於是開戰時用的
    // 是上一房的牌，而畫面完全正常。見 `RoomChangedReport`。
    deck = enterRoom(deck, report.room, now.current, Date.now(), {
      preloaded: report.preloaded === true,
    });
    if (report.room !== null && deck.pending !== null && deck.pending.id !== before) {
      // ⚠ 這裡**只寫記錄，不放訊息到畫面上**。原本會在遊戲畫面印一行紅字
      // 「正要換成「X」」，2026-09-09 移除：它會壓到渦房的「輸入Raid代碼」，
      // 而且左下那行字本來就寫著同一個名字。
      log(
        `· 進了${ROOM_LABELS[report.room]} —— 排上「${deckLabel(deck, report.room, deck.pending.id)}」`,
      );
    }

    // ⚠⚠ **畫面要當場換過去，不能等等候秒數。**
    //
    // 排隊那幾秒擋的是寫伺服器；畫面沒有理由跟著等（見 frontApplyPending）。
    // 少了這一步，玩家進了任務房看到的是**渦房那副牌**，三秒後才變 —— 而那
    // 三秒裡他按 START 打下去的正是上一房的牌組。
    //
    // ⚠ 要拿 `deckBusy`：這支是頁面輪詢叫進來的，而 `onDeckReport` 可能正在
    // 寫。等不到就算了 —— 那一副還排在隊伍裡，等候秒數到了或按開戰時照樣會
    // 寫出去，只是畫面晚一點換。
    if (deck.pending !== null && !deck.pending.fronted && (await waitForDeckIdle(1_000))) {
      deckBusy = true;
      try {
        await frontApplyPending(now.current, now.snap);
        saveDeckLibrary();
      } catch (err) {
        log(`✗ 進房換牌組出錯：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        deckBusy = false;
      }
    }

    await syncGatePending();
    await pushDeckState();
    return;
  }

  if (report.type === "room-gate-hold") {
    // ⚠ 這條路徑**不能被 `deckBusy` 擋掉**（那是「玩家連點時丟掉後面幾則」用
    // 的）。開戰只有這一次機會，丟掉的話玩家就是用舊牌組上場。所以這裡是等它
    // 讓出來，不是直接放棄 —— 但也不能無限等，頁面的看門狗只給 8 秒。
    const waited = await waitForDeckIdle(3_000);
    deckBusy = true;
    let ok = false;
    try {
      if (!waited) log("⚠ 開戰前換牌組：上一個動作還沒做完，先照現在的牌組打");
      // 開戰前這一次一定要寫到伺服器，等候秒數在這裡不算數。
      else if (mode === "official") ok = await ensureOfficialSet(report.room);
      else ok = await ensureRoomDeck(report.room);
    } catch (err) {
      log(`✗ 開戰前換牌組出錯：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      deckBusy = false;
      // ⚠ **無論如何都要放行。** 見這支的檔頭。
      // ⚠ `ok` 要照實傳：false 時頁面下一場會再攔一次（見 `needGate()`）。
      await engine?.releaseRoomGate(ok);
    }
    return;
  }

  if (report.type === "room-gate-timeout") {
    // 頁面的看門狗放行了 —— 我們沒有在 8 秒內回去，這一場用的是伺服器上原本
    // 那副。⚠ 這件事一定要留下一行，它正是「怎麼又用錯牌組」的唯一線索。
    log(`⚠ 開戰前換牌組等太久（${report.event}）—— 頁面自己放行了，這一場用的是伺服器上原本那副`);
  }
}

/**
 * **開戰前的最後一道：伺服器上躺的，一定要是這一房選的那一副。**（2026-09-20）
 *
 * 回 `true` 表示「現在可以放心開打」。
 *
 * ## ⚠⚠ 為什麼不能只 `commitPending()`
 *
 * 那支只處理「托盤自己知道有東西要寫」的情況，而漏掉的那幾條全都會讓玩家拿
 * 上一房的牌上場，且畫面完全正常：
 *
 * ```
 *   腳本在牌組編輯畫面選完就 scene.start 跳走  遊戲沒機會送 db_editdeck，
 *                                              而托盤已經當成「換好了」
 *   提交那一趟失敗                             隊伍被清掉，沒有人會再試
 *   客戶端記憶體剛好已經是那一副                托盤判「不必排隊」，
 *                                              伺服器卻還是上一房那副
 * ```
 *
 * 所以這裡**不看任何旗標**：直接讀伺服器，跟這一房 `selected` 的那副比，
 * 不一樣就當場寫。一次進房只會走到這裡一次（頁面的 `st.verified`）。
 *
 * ⚠ 讀不到伺服器時回 `false` 而不是 `true`：那表示我們根本不知道上面躺的是
 * 什麼，記成「驗過了」等於把之後每一場都放掉。
 */
async function ensureRoomDeck(room: RoomKind | null): Promise<boolean> {
  if (engine === null || deck === null) return false;
  // 有東西排著隊 → 那條路本來就會讀伺服器、寫進去、對過。
  if (deck.pending !== null) return await commitPending("battle");
  if (room === null) return true; // 認不出在哪一房（還在選頻道）→ 不插手
  const entry = resolveSelected(deck.library, room);
  if (entry === null) return true; // 這一房沒有指派牌組 → 不是我們該管的

  let snap: DeckSnapshot;
  try {
    snap = await engine.readDecks();
  } catch (err) {
    logReadDecksFailure("battle", err);
    return false;
  }
  // fromGame 要用庫存；斷線重連後快取是空的，先讀一次（不送請求）。
  if (inventoryCache === null) await deckInventory();
  const server = fromGame(deckContentFromServer(snap.decks[0]));
  deckSeen.remember("server", server);
  const label = deckLabel(deck, room, entry.id);
  if (deckContentHash(server) === deckContentHash(entry.content)) {
    // 本來就是它 —— 順手把 active 對好（伺服器親口說的，這是最硬的證據）。
    deck = { ...deck, active: { ...deck.active, [room]: entry.id } };
    return true;
  }

  log(`· 開戰前發現伺服器上不是「${label}」（${ROOM_LABELS[room]}）—— 現在寫進去`);
  const result = await writeDeck1(entry.content, snap, "commit");
  if (result.failure !== undefined) {
    log(`✗ 開戰前換牌組：${result.failure}`);
    deck = withNotice(
      {
        ...deck,
        // ⚠ 寫不進去 → active 照伺服器現況重算，不要留著一個假的「套用中」。
        active: { ...deck.active, [room]: resolveActive(deck.library, room, server) },
      },
      result.failure,
    );
    await pushDeckState();
    return false;
  }
  deck = { ...deck, active: { ...deck.active, [room]: entry.id } };
  log(`✓ 開戰前已套用「${label}」（${ROOM_LABELS[room]}）`);
  await pushDeckState();
  return true;
}

/** 上一次抱怨「讀不到伺服器上的牌組」是什麼時候。等候那條路每半秒重試一次。 */
let readDecksFailLoggedAt = 0;

/** 讀不到伺服器上的牌組。開戰那一次一定要說，等候那條路節流。 */
function logReadDecksFailure(reason: "dwell" | "battle", err: unknown): void {
  const now = Date.now();
  if (reason === "dwell" && now - readDecksFailLoggedAt < 30_000) return;
  readDecksFailLoggedAt = now;
  const why = err instanceof Error ? err.message : String(err);
  log(
    `✗ ${reason === "battle" ? "開戰前" : "套用牌組"}：讀不到伺服器上的牌組，先不寫（${why}）` +
      "　—— 牌組沒換成，打起來會是上一次那副",
  );
}

/** 等 `deckBusy` 讓出來。逾時回 `false` —— 呼叫端要自己決定怎麼辦。 */
async function waitForDeckIdle(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (deckBusy) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * 每一拍：把介面補回去、把玩家剛改的牌存起來、把過期的訊息清掉。
 *
 * ⚠ **只有玩家人就在牌組編輯畫面（或剛離開）時才去讀 Deck1。** 那是唯一會有
 * 變動的時機，而每一次讀都是四趟 WebSocket。剛離開那一拍也要讀，是因為遊戲
 * 自己會在離開 Edit 時把 Deck1 存回伺服器 —— 那正是玩家最後一次改動。
 */
async function deckTick(): Promise<void> {
  // ⚠ 上一拍還沒跑完就不要疊第二拍（2026-09-13）。牌組連線卡住時每一次讀都要
  // 等 30 秒逾時，而拍子是 4 秒 —— 疊起來的 initDeckLibrary 之後各自回來，
  // 成功的那幾個會把 session 整份重建好幾次，失敗的那幾個則在「已接上」之後
  // 又印一句「在等遊戲登入」。
  if (deckTickRunning) return;
  deckTickRunning = true;
  try {
    await deckTickOnce();
  } finally {
    deckTickRunning = false;
  }
}

let deckTickRunning = false;

async function deckTickOnce(): Promise<void> {
  if (engine === null || latest?.connected !== true) return;
  // 關閉模式：插件不碰牌組，連讀都不讀。切回來時 `resetDeckSession()` 會讓下一拍重新接上。
  const mode = activeDeckMode();
  if (mode === null) return;
  if (deckPending) {
    await initDeckLibrary();
    return;
  }
  if (deck === null || deckBusy) return;

  // 雲端牌組庫：沒動靜時也要定期看一眼（另一台電腦改的東西靠這一拍過來）。
  if (
    profile.deckCloudSync &&
    deckSyncTimer === null &&
    !deckSyncRunning &&
    Date.now() - (deckSyncStatus?.at ?? 0) > DECK_SYNC_INTERVAL_MS
  ) {
    void runDeckSync();
  }

  // ⚠ 這支順便把「遊戲重載過、介面被沖掉了」補回來（見 engine 的 deckEditStatus）。
  const status = await engine.deckEditStatus();
  const mounted = status?.mounted === true;
  const wasMounted = deckMounted;
  deckMounted = mounted;

  let dirty = false;
  const aged = expireNotice(deck);
  if (aged.changed) {
    deck = aged.session;
    dirty = true;
  }

  if (mounted || wasMounted) {
    try {
      const now = await currentDeck1();
      if (now !== null) {
        // 換帳號：快路徑現在也帶帳號指紋（2026-09-14 前只有伺服器那條路驗得到，
        // 而同一個分頁換帳號、登完直接進房的話永遠走不到那條路）。
        if (accountChanged(now.account)) return;
        if (mode === "official") {
          if (officialTick(now, mounted && !wasMounted)) dirty = true;
          if (dirty) await pushDeckState();
          return;
        }
        // ⚠ 同上：房間場景那一份不能拿來存（見 mayAutoSave）。這一拍是災情
        //   最常發生的地方 —— 玩家什麼都沒做，光是換房就會走到這裡。
        const saved = mayAutoSave(now.where)
          ? autoSave(deck, now.current, deckSeen.forSource(now.where))
          : { session: deck, saved: false };
        deckSeen.remember(worldOf(now.where), now.current);
        if (saved.saved) {
          deck = saved.session;
          saveDeckLibrary();
          dirty = true;
        }
        // 剛進編輯畫面那一拍：選單跟著「手上這副是哪一房的」走，見
        // `followDeckOnEdit`。⚠ 只在進來那一拍做 —— 之後玩家在裡面改牌，
        // 內容跟每一副都對不上是常態，每拍都算的話選單會跳來跳去。
        if (mounted && !wasMounted && now.where === "edit") {
          const followed = followDeckOnEdit(deck, now.current);
          if (followed !== deck) {
            const label =
              followed.active[followed.room] === null
                ? "？"
                : deckLabel(followed, followed.room, followed.active[followed.room] ?? "");
            log(
              `· 進了牌組編輯 —— 手上是「${label}」（${ROOM_LABELS[followed.room]}），選單跟過去`,
            );
            deck = followed;
            saveDeckLibrary();
            dirty = true;
          }
        }
      }
    } catch {
      // 連線正在死。下一拍再說。
    }
  }

  if (dirty) await pushDeckState();
}

/**
 * 官方三牌組模式的一拍。回 `true` = 狀態變了，要重推畫面。
 *
 * ```
 *   剛進牌組編輯   認出手上這三副是哪一房的 → 選單跟過去；比較基準重設
 *   在編輯畫面裡   第 n 格變了 → 存回那一房的第 n 副（officialAutoSave）
 *   剛離開         遊戲自己把牌組送上伺服器了，最後那幾下編輯在伺服器那份裡
 * ```
 *
 * ⚠ 房間場景裡看到的變動不存（那是進房預載換的），跟插件模式的 `mayAutoSave` 同一條。
 */
function officialTick(now: DeckRead, entered: boolean): boolean {
  if (deck === null) return false;
  let dirty = false;
  if (now.deckNow !== null && now.deckNow !== deck.slotNow) {
    deck = { ...deck, slotNow: now.deckNow };
    dirty = true;
  }
  if (entered && now.where === "edit") {
    const room = officialRoomOf(deck.library, now.set, deck.room);
    if (room !== null && room !== deck.room) {
      log(`· 進了牌組編輯 —— 手上是${ROOM_LABELS[room]}的三副，選單跟過去`);
      deck = { ...deck, room };
      dirty = true;
    }
    // 剛進來：以眼前這三副當基準，之後的變動才是玩家的編輯。
    officialSeen = now.set;
    return dirty;
  }
  if (now.where === "room") return dirty;
  const saved = officialAutoSave(deck, now.set, officialSeen);
  officialSeen = now.set;
  if (saved.saved > 0) {
    deck = saved.session;
    saveDeckLibrary();
    dirty = true;
  }
  return dirty;
}

/** 安裝包帶的 ULR Boot 原始檔（`scripts/build-tray.mjs` 把 assets 整包複製過去）。 */
const BOOT_EXT_SRC = join(__dirname, "assets", "ulr-boot-extension");
const BOOT_EXT_BUNDLED = bootExtVersion(BOOT_EXT_SRC);
/** 玩家那邊放著哪一版。快照很常送，不每次讀檔 —— 開機讀一次、放好之後更新。 */
let bootExtInstalled = bootExtVersion(BOOT_EXT_DIR);

/** 哪一族啟動時要臨時掛 ULR Boot：只有 Edge，而且要已經放好。理由見 `loadExtensionArgs`。 */
function autoLoadExtDir(family: "chrome" | "edge"): string | null {
  return family === "edge" && bootExtInstalled !== null ? BOOT_EXT_DIR : null;
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
    bootExt: {
      dir: BOOT_EXT_DIR,
      installed: bootExtInstalled,
      bundled: BOOT_EXT_BUNDLED,
      guideUrl: USERSCRIPT_GUIDE_URL,
    },
    browsers: { chrome: browserSetup("chrome"), edge: browserSetup("edge") },
    gamePorts: Object.fromEntries(gamePorts),
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
    deckSync: deckSyncStatus,
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
  if (lobbyTimer !== null) clearInterval(lobbyTimer);
  lobbyTimer = null;
  if (deckTimer !== null) clearInterval(deckTimer);
  deckTimer = null;
  if (deckApplyTimer !== null) clearInterval(deckApplyTimer);
  deckApplyTimer = null;
  if (bundleReportTimer !== null) clearInterval(bundleReportTimer);
  bundleReportTimer = null;
  // 大廳人數的推播線。⚠ 不收的話 Electron 退不乾淨（那幾條 socket 還活著）。
  stopLobbyWatch();
  // ⚠ 排隊中就關掉插件的話，要先把自己從佇列上拿掉、順手收掉開了一半的房 ——
  // 否則對手會一直等一間永遠不會出現的房，而玩家的頻道上留一間空房。
  await pairing?.stop().catch(() => {});
  pairing = null;
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
 * 這份規則是從哪裡來的。**畫面一定要分得出來** —— 「插件附的預設規則」與
 * 「我自己選的檔」在玩家心裡是兩件完全不同的事，而它們在 `costRule` 裡長得
 * 一模一樣（都只是一個路徑）。
 */
export type CostRuleOrigin = "bundled" | "feed" | "file";
let costRuleOrigin: CostRuleOrigin | null = null;

/**
 * 目前規則的**完整內容**。配對要用它算牌組（`checkOwnDeck` / 交叉驗算）。
 *
 * ⚠ 跟 `costRule`（摘要）分開放，而且**絕不進 `Snapshot`** —— 那是 700 筆的
 * COST 表，每次狀態變動都在 IPC 上搬一次的話，畫面會一格一格地卡。
 */
let costRuleFull: CostRule | null = null;
/**
 * `costRuleFull` 的 contentHash。**跟著它一起設，不要用到的時候現算。**
 *
 * 現算不是慢的問題，是**會漂移**：規則標籤（`ruleTag`）跟大廳人數的判準都靠
 * 這個值，散在三個地方各算一次的話，總有一天其中一個會拿到不同步的那一份。
 */
let costRuleHash: string | null = null;

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
function loadCostRule(path: string | null, origin: CostRuleOrigin = "file"): void {
  if (path === null) {
    costRule = null;
    costRuleFull = null;
    costRuleHash = null;
    costRuleError = null;
    costRuleOrigin = null;
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
    // ⚠ 裝備與事件卡要**先把規則鍵換成卡片 id**（`wp001` → `"6"`）。注入的
    // 腳本刻意不認得 `wp` / `ev` 這套命名，見 patch-cost.ts 的說明。
    // 2026-09-23 改版後客戶端只認 id，而且順序重排過 —— 不是索引 +1。
    const equipment = toCardIdTable(rule.equipment, parseEquipmentKey, legacyWeaponId);
    const eventCards = toCardIdTable(rule.eventCards, parseEventCardKey, legacyEventId);
    engine?.setCostRule({
      characters: rule.characters,
      monsters: rule.monsters,
      equipment: equipment.byId,
      eventCards: eventCards.byId,
      bands,
    });
    costRuleFull = rule;
    costRuleHash = contentHash(rule);
    costRuleError = null;
    costRuleOrigin = origin;
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
    costRuleHash = null;
    costRuleOrigin = null;
    engine?.setCostRule(null);
    // ⚠ 記錄**不夠**。記錄在「戰鬥」頁，玩家人在「自訂COST › Cost 表」頁，
    // 那一頁只會說「還沒選規則」—— 看起來就是按了沒反應。所以同時留一份
    // 給畫面，由 Cost 頁自己顯示。
    costRuleError = { fileName: basename(path), message, hint: costRuleHint(message) };
    log(`✗ COST 規則載入失敗，已停用：${message}`);
    // 玩家自己選的檔壞掉／不在了 → 清掉路徑讓他重選，否則每次開機再失敗一次。
    //
    // ⚠ **預設規則不走這條。** 它的路徑不是玩家填的，清掉沒有任何意義，而且
    // `applyCostRule()` 已經幫它處理過退路了（快取壞掉退回安裝包那份）。
    // ⚠ editProfile 會 pushState，而那要在 costRuleError 設好之後 ——
    // 反過來的話畫面會先收到一份「沒選規則、也沒有錯誤」的狀態。
    if (origin === "file" && profile.costRulePath !== null) {
      editProfile(profile.id, { costRulePath: null });
    }
  }
}

/**
 * 有一份新的預設規則載進來了，但**遊戲那邊還是舊價格**。
 *
 * 卡片價格是 `Page.addScriptToEvaluateOnNewDocument` 裝的 —— 它只對之後載入
 * 的 document 生效，所以規則換了之後遊戲得重載一次才看得到新數字。
 */
let pendingRuleReload = false;

/**
 * 這一條連線已經為了「頁面比插件早載入」自動重載過了嗎。
 *
 * ⚠ 防的是無窮重載：判斷 `stale` 要問頁面，而問回來的答案不保證永遠正確。
 * 斷線重連會重置（`onStatus`）—— 玩家關掉遊戲再開仍然救得回來。
 */
let autoReloadedThisAttach = false;

/**
 * 等一個安全的時機把新規則套到遊戲上。
 *
 * ⚠ **這是 `updater.ts` 那條線的同一條原則**：下載可以完全靜默，
 * **換版的那一刻不能落在對戰進行中**。判準也是同一個（`status.armed` ——
 * 攔截真的掛在 socket 上），因為「連上但還在大廳」正是最安全、也最常見的
 * 停留點。
 *
 * ⚠ 套用**一定要留一行 log**。玩家事後要查得到「今天的數字為什麼跟昨天不同」，
 * 而那是靜默更新唯一不能省的義務。
 */
async function applyPendingReload(): Promise<void> {
  if (engine === null) return;

  // 兩種要重載的理由，判準與時機**完全一樣**，所以走同一支：
  //
  //   pendingRuleReload  規則換了（玩家自己選的，或中間人推下來一份新的）
  //   cost.stale         頁面上那份卡片資料**不是這一份規則**改出來的
  //
  // ⚠ 後者有兩種情形，而且都是常態不是異常：
  //
  //   1. 玩家從 Steam 開遊戲 —— 遊戲先跑起來、插件兩秒後才接上，而
  //      `addScriptToEvaluateOnNewDocument` 只管之後載入的 document
  //   2. 插件重開之後載到**另一份**規則 —— 頁面上留著上一份的數字
  //
  // 兩種的症狀是同一句「插件開著，cost 沒生效」，而第 2 種一度判不出來
  // （見 `costsStamp`：判準原本只問「改過嗎」，不問「改的是哪一份」）。
  const stale = latest?.cost.stale === true;
  if (!pendingRuleReload && !stale) return;
  // 對戰中：留著旗標，下一次狀態推播時再試（`onStatus` 會叫這支）。
  if (latest?.armed === true) return;
  // 還沒連上遊戲就不必重載 —— 遊戲一啟動就會帶著新規則載入，那才是常態。
  if (latest?.connected !== true) {
    pendingRuleReload = false;
    return;
  }
  // ⚠ **一條連線只自動重載一次。** `stale` 是從頁面問回來的，而「問回來的
  // 東西一定有一天會回錯」—— 沒有這道閘的話，一個永遠回 true 的答案會讓
  // 遊戲無限重載，而玩家完全無法把它跟插件連在一起。旗標在斷線時重置
  // （見 `onStatus`），所以下一次接上仍然救得回來。
  if (stale && !pendingRuleReload) {
    if (autoReloadedThisAttach) return;
    autoReloadedThisAttach = true;
  }

  const why = pendingRuleReload;
  pendingRuleReload = false;
  try {
    await engine.reloadGame();
    log(
      why
        ? "⟳ 新的 COST 表已套用（不在對戰中，已請遊戲重新載入）"
        : "⟳ 遊戲畫面上的價格不是現在這份規則（遊戲比插件早開，或剛換過規則）—— 已請遊戲重新載入",
    );
  } catch (err) {
    log(`✗ 套用新 COST 表時重載失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  pushState();
}

/**
 * 照配置把規則載進來。**開機、換模式、規則更新下來時都走這一支。**
 *
 * ```
 *   off     → 不載（原版數字）
 *   file    → 玩家選的那個檔
 *   default → 中間人發下來的那份；壞掉或沒有 → 安裝包裡那份
 * ```
 *
 * ⚠ **`default` 的退路一定要有。** 快取那份是下載來的，而下載來的東西總有
 * 一天會壞（磁碟滿、防毒攔一半、手動改壞）。沒有退路的話症狀是「插件昨天
 * 好好的，今天所有卡都變回原版價格」，而玩家完全不知道發生什麼事。
 */
function applyCostRule(): void {
  if (profile.costRuleMode === "off") {
    loadCostRule(null);
    return;
  }
  if (profile.costRuleMode === "file") {
    loadCostRule(profile.costRulePath);
    return;
  }

  const choice = resolveDefaultRule(APP_DIR);
  if (choice === null) {
    // 兩份都不在 —— 打包時漏掉了規則檔才會走到這裡。
    loadCostRule(null);
    costRuleError = {
      fileName: "default.ulrcost.json",
      message: "找不到插件附的預設 COST 表",
      hint: "重新安裝一次插件；或到「Cost 表」自己選一份規則檔。",
    };
    log("✗ 找不到預設 COST 表（安裝包裡那份也不在）");
    return;
  }

  loadCostRule(choice.path, choice.source === "feed" ? "feed" : "bundled");
  // 下載來的那份載不起來 → 退回安裝包裡那份，而且要講出來。
  if (costRuleFull === null && choice.source === "feed") {
    log("⚠ 下載來的預設 COST 表載不起來，改用插件附的那一份");
    loadCostRule(bundledRulePath(), "bundled");
  }
}

/**
 * 玩家在「Cost 表」那一頁換了規則（選檔、換模式、停用）。
 *
 * ⚠ **換完要自己重載，不能只換記憶體裡那份。** 卡片價格是
 * `addScriptToEvaluateOnNewDocument` 裝的，只對**之後**載入的 document 生效 ——
 * 頁面上那份資料早就在快取裡，換規則對它一點作用都沒有。這裡原本只換不重載，
 * 而症狀是「我明明選了規則，數字沒變」（記錄檔還會說載入成功）。
 *
 * ⚠ **這裡不直接呼叫 `reloadGame()`。** 走 `applyPendingReload()` 那條線的
 * 理由跟自動更新完全一樣：它只在**不在對戰中**時動手，正在打的話留著旗標，
 * 等這一場結束（`onStatus`）再做。玩家在對戰中打開設定換規則不該被踢出去。
 */
function changeCostRule(): void {
  applyCostRule();
  pendingRuleReload = true;
  void applyPendingReload();
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
      // ⚠ 斷線就把「這條連線自動重載過了」忘掉。玩家關掉遊戲再開是家常便飯，
      // 而那是一個全新的頁面 —— 沿用上一條連線的旗標會讓新的那次救不回來。
      if (latest?.connected === true && !status.connected) {
        autoReloadedThisAttach = false;
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
    // ⚠⚠ 同一個分頁換帳號**不會斷線**，只會重載 —— 見 resetDeckSession。
    // 同一個帳號重載也一樣放掉：頁面上的記憶體本來就沒了，重認一次只多讀一趟。
    onPageReload: () => {
      if (!deckPending || deck !== null) resetDeckSession();
    },
  });

  // ⚠ 要在 engine 建好之後 —— loadCostRule 會呼叫 engine.setCostOverrides()。
  applyCostRule();
  // ⚠ 同樣要在 engine 建好之後。這裡只是把玩家上次的選擇交給引擎，真正裝到
  // 頁面上是接上遊戲之後的事（`#syncHiddenStages`）。
  engine.setHiddenStages(profile.hiddenStages);
  // 人物篩選同理（新的引擎 = 還沒推過）。最愛要等牌組庫接上才有。
  charaPickerPushed = null;
  pushCharaPicker();
  lobbyStandPushed = null;
  pushLobbyStand();
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
  engine.setQuestItemShortcut("stack", profile.questStackShortcut);
  engine.setQuestItemShortcut("passes", profile.questPassShortcut);
  engine.setDietOverlay("dietStack", profile.dietItemShortcut);
  engine.setDietOverlay("gemUp", profile.dietGemUp);
  engine.setBattleSurrender(battleSurrenderOptions());
  engine.setBonusItemShortcut(profile.bonusItemShortcut);
  engine.setBonusItemOrder(profile.bonusItemOrder);
  engine.setBonusItemPlace(profile.bonusItemPlace);
  engine.setBonusHighLow(profile.bonusHighLow);
  engine.setBonusFast(profile.bonusFast);
  engine.setBonusRescueFast(profile.bonusRescueFast);
  engine.setBonusSkipEnd(profile.bonusSkipEnd);
  engine.setQuestTreasure(profile.questTreasureMarks);
  engine.setQuestPanel("reward", profile.questRewardPanel);
  engine.setQuestPanel("end", profile.questEndPanel);
  engine.setQuestSkipResult(profile.questSkipResult);
  engine.onRaidAutoDeleteChanged((setting) => {
    profile = { ...profile, raidAutoDelete: setting.enabled, raidAutoDeletePrompt: setting.prompt };
    if (!ephemeral) {
      store = updateProfile(profile.id, {
        raidAutoDelete: setting.enabled,
        raidAutoDeletePrompt: setting.prompt,
      });
    }
    log(
      setting.enabled
        ? "· 自動刪除死渦已開啟（在遊戲裡開的）"
        : "· 自動刪除死渦已停用（在遊戲裡關的；要再開請到 渦 › 結算通知）",
    );
    pushState();
  });
  engine.onRaidRewardModeChanged((mode) => {
    profile = { ...profile, raidRewardMode: mode };
    if (!ephemeral) store = updateProfile(profile.id, { raidRewardMode: mode });
    log(`· 渦結算通知改為「${describeRaidRewardMode(mode)}」（在遊戲裡切的）`);
    pushState();
  });
  // 畫面設定（解析度／畫面大小）：只在遊戲的 Option › plugin 分頁改，托盤只負責記住。
  engine.setDisplay(profile.display);
  engine.onDisplayChanged((display) => {
    profile = { ...profile, display };
    if (!ephemeral) store = updateProfile(profile.id, { display });
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
    (_event, id: string, patch: { name?: string; port?: number; kind?: ClientKind }) => {
      // 只挑這三格。中間人不給改（見 Profile.link），渲染層送什麼來都不收。
      const { name, port, kind } = patch;
      editProfile(id, {
        ...(name !== undefined ? { name } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(kind !== undefined ? { kind } : {}),
      });
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

    // ⚠ 選了檔就等於離開預設模式。少了 `costRuleMode` 這一格的話，下次開機
    // 會被預設規則蓋回去 —— 而畫面上寫著他選的那個檔名。
    editProfile(profile.id, { costRulePath: picked, costRuleMode: "file" });
    changeCostRule();
    pushState();
    return snapshot();
  });

  /**
   * 換 COST 規則的來源（預設／自己的檔／停用）。
   *
   * ⚠ 切回 `file` 時**沿用上次選過的路徑**，沒選過就什麼都不載 —— 畫面那邊
   * 會顯示「還沒選檔」並附上選檔按鈕。這比「切過去就跳檔案選擇框」好：
   * 玩家可能只是想看看有哪些選項。
   */
  ipcMain.handle("ulr:cost-mode", (_event, raw: unknown) => {
    const mode: CostRuleMode = raw === "file" || raw === "off" ? raw : "default";
    editProfile(profile.id, { costRuleMode: mode });
    changeCostRule();
    if (mode === "off") log("· 自訂 COST 已停用（不在對戰中的話會自己重載一次）");
    pushState();
    return snapshot();
  });

  /** 取消套用，回到原版數字。 */
  ipcMain.handle("ulr:cost-clear", () => {
    editProfile(profile.id, { costRuleMode: "off" });
    changeCostRule();
    log("· 自訂 COST 已停用（不在對戰中的話會自己重載一次）");
    pushState();
    return snapshot();
  });

  /**
   * 重載遊戲讓注入生效。
   *
   * ⚠ **會打斷對戰**，所以按鈕文案要講明白 —— 按下去是玩家自己的決定。
   * 換規則本身已經**不需要**按它了（`changeCostRule()` 會挑一個不在對戰中的
   * 時機自己重載），這顆留著是給「我就是要現在」與那條路沒生效時用的。
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
  /**
   * 改「等候套用」的秒數並記進配置。
   *
   * ⚠ 跟 `ulr:editor-step` 同一招（`profile = {...}` 而不是 `editProfile`）：
   * 臨時配置不在清單裡，`editProfile` 對它是空操作 —— 症狀是「改了秒數，下一次
   * 重畫又跳回去」。
   *
   * ⚠ **不必去通知頁面**。閘門那邊只認「有沒有東西沒寫」這個布林，秒數是托盤
   * 這一端在算的（`deckApplyTick`）。
   */
  ipcMain.handle("ulr:deck-apply-delay", (_event, raw: unknown): number => {
    const next = normalizeApplyDelaySeconds(raw);
    profile = { ...profile, applyDelaySeconds: next };
    if (!ephemeral) store = updateProfile(profile.id, { applyDelaySeconds: next });
    pushState();
    return next;
  });

  /**
   * 牌組替換模式（插件／官方三牌組／關閉）。
   *
   * 切換時牌組庫**整份重新接上**（`resetDeckSession()`，下一拍 `initDeckLibrary()`）：
   * 兩種模式對伺服器三格的用法不一樣 —— 插件模式要把 Deck2／Deck3 收進庫裡清空，
   * 官方模式三格都是玩家的牌 —— 而接上那一步正是分流的地方。關閉就把選單拆掉、
   * 房間不再預載不再攔。
   */
  ipcMain.handle("ulr:deck-mode", async (_event, raw: unknown): Promise<DeckMode> => {
    if (!isDeckMode(raw) || raw === profile.deckMode) return profile.deckMode;
    profile = { ...profile, deckMode: raw };
    if (!ephemeral) store = updateProfile(profile.id, { deckMode: raw });
    log(
      raw === "plugin"
        ? "· 牌組替換：插件模式（四房各存牌組、只用 Deck1；Deck2／Deck3 會收進庫裡清空）"
        : raw === "official"
          ? "· 牌組替換：官方三牌組（進房換上那一房的前三副）"
          : "· 牌組替換：關閉（插件不碰牌組）",
    );
    resetDeckSession();
    await pushDeckState();
    pushState();
    return profile.deckMode;
  });

  /**
   * 牌組編輯畫面 [Chara] 鈕的代表卡（`L1`..`L5`／`R`），`off` = 不畫那顆鈕。
   * 立刻生效：只是推新狀態，頁面下次打開角色一覽就用新的挑法。
   */
  ipcMain.handle("ulr:chara-picker", (_event, raw: unknown): CharaPickerMode => {
    if (!isCharaPickerMode(raw) || raw === profile.charaPicker) return profile.charaPicker;
    profile = { ...profile, charaPicker: raw };
    if (!ephemeral) store = updateProfile(profile.id, { charaPicker: raw });
    pushCharaPicker();
    pushState();
    return profile.charaPicker;
  });

  /** 雲端牌組同步開關。打開時馬上同步一輪。 */
  ipcMain.handle("ulr:deck-cloud-sync", (_event, on: unknown): boolean => {
    if (typeof on === "boolean") {
      // 跟 `ulr:stages-set` 同一招：先改記憶體、非臨時配置才落地。
      profile = { ...profile, deckCloudSync: on };
      if (!ephemeral) store = updateProfile(profile.id, { deckCloudSync: on });
      if (on) {
        log("· 牌組跨電腦同步已開啟");
        void runDeckSync();
      } else {
        if (deckSyncTimer !== null) clearTimeout(deckSyncTimer);
        deckSyncTimer = null;
        log("· 牌組跨電腦同步已關閉（只用這台電腦的）");
      }
      pushState();
    }
    return profile.deckCloudSync;
  });

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
    profile = { ...profile, match: next };
    if (!ephemeral) store = updateProfile(profile.id, { match: next });
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
    profile = { ...profile, hiddenStages: on };
    if (!ephemeral) store = updateProfile(profile.id, { hiddenStages: on });
    engine?.setHiddenStages(on);
    log(on ? "· 隱藏地圖已啟用（開房選單會多四張）" : "· 隱藏地圖已停用，選單回官方那 11 項");
    pushState();
    return { enabled: on, stages: HIDDEN_STAGES, status: await stageStatus() };
  });

  // -------------------------------------------------------------------------
  // 渦：獎勵標記與結算通知
  // -------------------------------------------------------------------------

  ipcMain.handle("ulr:raid-state", async (): Promise<RaidPageState> => raidPageState());

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

  ipcMain.handle("ulr:raid-reward-mode", async (_event, raw: unknown): Promise<RaidPageState> => {
    if (isRaidRewardMode(raw)) {
      // 跟 `ulr:stages-set` 同一招：先改記憶體、非臨時配置才落地。
      profile = { ...profile, raidRewardMode: raw };
      if (!ephemeral) store = updateProfile(profile.id, { raidRewardMode: raw });
      engine?.setRaidRewardMode(raw);
      log(`· 渦結算通知改為「${describeRaidRewardMode(raw)}」`);
      pushState();
    }
    return raidPageState();
  });

  ipcMain.handle("ulr:raid-share", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, raidShare: on };
      if (!ephemeral) store = updateProfile(profile.id, { raidShare: on });
      engine?.setRaidShare(on);
      log(on ? "· 插件互傳渦狀態已開啟" : "· 插件互傳渦狀態已關閉（只用 ulgg）");
      pushState();
    }
    return raidPageState();
  });

  ipcMain.handle("ulr:raid-team-share", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, raidTeamShare: on };
      if (!ephemeral) store = updateProfile(profile.id, { raidTeamShare: on });
      engine?.setRaidTeamShare(on);
      log(
        on
          ? "· 分享打渦隊伍已開啟"
          : "· 分享打渦隊伍已關閉（下一輪會把 Cloudflare Workers 上自己的隊伍撤掉）",
      );
      pushState();
    }
    return raidPageState();
  });

  /** 插件視窗這邊打開自動刪除時，遊戲內的提示鈕也一起恢復。 */
  ipcMain.handle("ulr:raid-auto-delete", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      const prompt = on ? true : profile.raidAutoDeletePrompt;
      profile = { ...profile, raidAutoDelete: on, raidAutoDeletePrompt: prompt };
      if (!ephemeral)
        store = updateProfile(profile.id, { raidAutoDelete: on, raidAutoDeletePrompt: prompt });
      engine?.setRaidAutoDelete({ enabled: on, prompt });
      log(on ? "· 自動刪除死渦已開啟" : "· 自動刪除死渦已停用");
      pushState();
    }
    return raidPageState();
  });

  ipcMain.handle("ulr:raid-item-shortcut", async (_event, on: unknown): Promise<RaidPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, raidItemShortcut: on };
      if (!ephemeral) store = updateProfile(profile.id, { raidItemShortcut: on });
      engine?.setItemShortcut(on);
      log(on ? "· 渦房物品捷徑已開啟" : "· 渦房物品捷徑已關閉（好友與物品鈕放回來）");
      pushState();
    }
    return raidPageState();
  });

  ipcMain.handle("ulr:quest-state", (): Promise<QuestPageState> => questPageState());

  ipcMain.handle(
    "ulr:quest-item-shortcut",
    // `part`：`stack` 水沙捷徑、`passes` 通行證捷徑，各自開關。
    async (_event, part: unknown, on: unknown): Promise<QuestPageState> => {
      if ((part === "stack" || part === "passes") && typeof on === "boolean") {
        const key = part === "stack" ? "questStackShortcut" : "questPassShortcut";
        profile = { ...profile, [key]: on };
        if (!ephemeral) store = updateProfile(profile.id, { [key]: on });
        engine?.setQuestItemShortcut(part, on);
        const name = part === "stack" ? "水沙捷徑" : "通行證捷徑";
        log(on ? `· 任務房${name}已開啟` : `· 任務房${name}已關閉`);
        pushState();
      }
      return questPageState();
    },
  );

  ipcMain.handle("ulr:diet-state", (): Promise<DietPageState> => dietPageState());

  ipcMain.handle(
    "ulr:diet-toggle",
    // `part`：`dietStack` 水捷徑、`gemUp` GEM UP，各自開關。
    async (_event, part: unknown, on: unknown): Promise<DietPageState> => {
      if ((part === "dietStack" || part === "gemUp") && typeof on === "boolean") {
        const key = part === "dietStack" ? "dietItemShortcut" : "dietGemUp";
        profile = { ...profile, [key]: on };
        if (!ephemeral) store = updateProfile(profile.id, { [key]: on });
        engine?.setDietOverlay(part, on);
        const name = part === "dietStack" ? "物品捷徑" : "GEM UP";
        log(on ? `· 迪城${name}已開啟` : `· 迪城${name}已關閉`);
        pushState();
      }
      return dietPageState();
    },
  );

  ipcMain.handle(
    "ulr:surrender-option",
    // `part`：`noConfirm` 迪城投降不確認、`outside` 投降鈕放 MENU 外面（渦、亞城也算）。
    async (_event, part: unknown, on: unknown): Promise<DietPageState> => {
      if ((part === "noConfirm" || part === "outside") && typeof on === "boolean") {
        const key = part === "noConfirm" ? "dietSurrenderNoConfirm" : "surrenderOutside";
        profile = { ...profile, [key]: on };
        if (!ephemeral) store = updateProfile(profile.id, { [key]: on });
        engine?.setBattleSurrender(battleSurrenderOptions());
        if (part === "noConfirm") log(on ? "· 迪城投降改成直接投降" : "· 迪城投降照官方跳確認");
        else log(on ? "· 投降鈕放到 MENU 外面" : "· 投降鈕收回 MENU 裡");
        pushState();
      }
      return dietPageState();
    },
  );

  ipcMain.handle("ulr:bonus-state", (): Promise<BonusPageState> => bonusPageState());

  // 三選一：無捷徑（off）、按鈕左上（above）、蓋在使用物品上（cover）。關的時候位置不動，
  // 下次打開還是上次選的地方
  ipcMain.handle("ulr:bonus-mode", async (_event, mode: unknown): Promise<BonusPageState> => {
    if (mode === "off" || isBonusItemPlace(mode)) {
      const on = mode !== "off";
      const place = mode === "off" ? profile.bonusItemPlace : mode;
      profile = { ...profile, bonusItemShortcut: on, bonusItemPlace: place };
      if (!ephemeral)
        store = updateProfile(profile.id, { bonusItemShortcut: on, bonusItemPlace: place });
      engine?.setBonusItemPlace(place);
      engine?.setBonusItemShortcut(on);
      log(
        mode === "off"
          ? "· 獎勵遊戲物品捷徑已關閉"
          : mode === "cover"
            ? "· 獎勵遊戲物品捷徑：蓋在使用物品上"
            : "· 獎勵遊戲物品捷徑：畫在按鈕左上",
      );
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:bonus-order", async (_event, order: unknown): Promise<BonusPageState> => {
    if (isBonusItemOrder(order)) {
      profile = { ...profile, bonusItemOrder: order };
      if (!ephemeral) store = updateProfile(profile.id, { bonusItemOrder: order });
      engine?.setBonusItemOrder(order);
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:bonus-highlow", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, bonusHighLow: on };
      if (!ephemeral) store = updateProfile(profile.id, { bonusHighLow: on });
      engine?.setBonusHighLow(on);
      log(on ? "· 獎勵遊戲 High Low：跟下一個卡片一起顯示" : "· 獎勵遊戲 High Low：照官方");
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:bonus-fast", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, bonusFast: on };
      if (!ephemeral) store = updateProfile(profile.id, { bonusFast: on });
      engine?.setBonusFast(on);
      log(on ? "· 獎勵遊戲：跳過擲骰動畫" : "· 獎勵遊戲：擲骰動畫照官方");
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:bonus-rescue-fast", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, bonusRescueFast: on };
      if (!ephemeral) store = updateProfile(profile.id, { bonusRescueFast: on });
      engine?.setBonusRescueFast(on);
      log(on ? "· 獎勵遊戲：用道具救起來之後快轉" : "· 獎勵遊戲：用道具之後照官方");
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:bonus-skip-end", async (_event, on: unknown): Promise<BonusPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, bonusSkipEnd: on };
      if (!ephemeral) store = updateProfile(profile.id, { bonusSkipEnd: on });
      engine?.setBonusSkipEnd(on);
      log(on ? "· 獎勵遊戲：結束後直接回房間" : "· 獎勵遊戲：結束後照官方看結算");
      pushState();
    }
    return bonusPageState();
  });

  ipcMain.handle("ulr:quest-treasure", async (_event, on: unknown): Promise<QuestPageState> => {
    if (typeof on === "boolean") {
      profile = { ...profile, questTreasureMarks: on };
      if (!ephemeral) store = updateProfile(profile.id, { questTreasureMarks: on });
      engine?.setQuestTreasure(on);
      log(on ? "· 任務地圖寶箱標註已開啟" : "· 任務地圖寶箱標註已關閉");
      pushState();
    }
    return questPageState();
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

  /**
   * 換這份配置的客戶端種類，然後重開自己（見 `restart()`）。
   *
   * ⚠ 命令列開的臨時配置不收：它不在清單裡，重開時 `--profile <id>` 找不到它，
   * 會落到別份配置上。
   */
  ipcMain.handle("ulr:client-kind", async (_event, raw: unknown) => {
    if (raw !== "desktop" && raw !== "chrome" && raw !== "edge") return snapshot();
    if (ephemeral || raw === profile.kind) return snapshot();
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
        // ⚠ 別族不能用 profile.port：桌面版配置的埠上坐著桌面版遊戲，問得到
        // 就會被當成「這個瀏覽器已經開著」，然後什麼都沒開。
        port: family === profile.kind ? profile.port : browserDebugPort(family),
        profileDir: userDataDirFor(family),
        alwaysAutoPort: true,
        // Edge 每次啟動都臨時掛上 ULR Boot（見 loadExtensionArgs）。資料夾裡沒有
        // 擴充就不帶，照常開。
        ...(autoLoadExtDir(family) !== null ? { extraArgs: loadExtensionArgs(BOOT_EXT_DIR) } : {}),
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
   * `page` 只收 `"extensions"`（裝 ULR Boot 那一步）。
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

  /**
   * 把 ULR Boot 放到 `BOOT_EXT_DIR`，打開那個資料夾。字型從玩家的桌面版遊戲拿
   * （見 `gameFontDirs`），拿不到就只放程式。
   */
  ipcMain.handle("ulr:boot-ext-install", async () => {
    try {
      const install = detectGameInstall();
      const fontDirs = install === null ? [] : gameFontDirs(install.resourcesDir);
      const r = exportBootExtension(BOOT_EXT_SRC, BOOT_EXT_DIR, fontDirs);
      bootExtInstalled = r.version;
      log(`· ULR Boot ${r.version ?? "?"} 放到 ${r.dir}（字型 ${r.fonts} 個）`);
      void shell.openPath(r.dir);
      pushState();
      return { ok: true, text: r.fonts > 0 ? "已放好" : "已放好（沒找到遊戲字型，會用系統字）" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`⚠ 放 ULR Boot 失敗：${msg}`);
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

  // 迪特赫姆大廳那顆「快速比賽」。⚠ 這是**玩家親手按的**，跟托盤上那顆一樣
  // 會開房消耗 AP —— 所以它掛在點擊事件上，不掛在任何輪詢裡。
  engine.onLobbyQuick((press) => void onLobbyQuick(press));
  // 人數那幾行。⚠ **這一拍只是「看一眼」，不等於一個 HTTP 請求** —— 真的去問
  // 中間人的節奏由 `pushLobbyState()` 自己把關（`LOBBY_COUNT_MS`，外加「剛進
  // 頻道」那一次）。只有玩家真的坐在 duel 頻道的大廳時才會送請求。
  lobbyTimer = setInterval(() => void pushLobbyState(), LOBBY_TICK_MS);

  // 牌組庫。⚠ 跟大廳那顆按鈕一樣，**點下去的是玩家**：`onDeckEdit` 收到的
  // 每一則都是他親手點的，而寫進 Deck1 只發生在他點了某一副牌組的時候。
  engine.onDeckEdit((report) => void onDeckReport(report));
  deckTimer = setInterval(() => void deckTick(), DECK_TICK_MS);
  // 最愛卡片鈕（存進牌組庫，跟牌組一起上雲）。
  engine.onCharaPicker((report) => onCharaPicker(report));
  // Library 愛心複選與首頁立繪的擺法（同樣存進牌組庫）。
  engine.onLobbyStand((report) => onLobbyStand(report));

  // 進了哪一房、開戰前先套牌組（WP-19）。
  // ⚠ 這一拍要比 `DECK_TICK_MS`（4 秒）密 —— 等候秒數預設 3 秒，用 4 秒的拍子
  // 去量「停了 3 秒沒」，玩家實際等到的會是 4 到 8 秒。
  engine.onRoomGate((report) => void onRoomGate(report));
  deckApplyTimer = setInterval(() => void deckApplyTick(), DECK_APPLY_TICK_MS);

  // 接著 Steam 開的遊戲時，把這一版的程式檔名回報到雲端，給用書籤開網頁版的
  // 玩家用。⚠ 平常一次網路都不打：同一份清單處理過就記住，只有雲端還沒跟上
  // 改版的那段時間才每小時問一次。書籤開的頁面（網址沒 token）直接跳過。
  const bundleReporter = createBundleReporter({
    fetch: (url, init) => fetch(url, init),
    read: async () =>
      engine !== null && latest?.connected === true ? await engine.readServedBundles() : null,
    // 維護者自己的電腦才有這個檔（雲端清單.py 用的同一把）；有的話回報算兩份
    token: readPushToken(join(homedir(), ".ulr-push-token"), (p) => readFileSync(p, "utf8")),
    log: (l) => log(l),
  });
  bundleReportTimer = setInterval(() => void bundleReporter.tick(), BUNDLE_REPORT_INTERVAL_MS);

  void engine.start();
  // 靜默下載、安全的時機才套用。細節與那個「安全」的定義見 updater.ts。
  startAutoUpdate({
    currentVersion: VERSION,
    isBusy: () => latest?.armed === true,
    onLog: (l) => log(l),
  });

  /**
   * 預設 COST 表的自動更新。**只在預設模式下做事** —— 玩家自己選了檔的話，
   * 我們一個位元組都不該碰他的規則。
   *
   * ⚠ 收到新規則之後**不重載遊戲**。卡片價格是 `addScriptToEvaluateOnNewDocument`
   * 裝的，要下次載入才生效（見 `engine.ts` 的那張表），而重載會打斷對戰 ——
   * 這裡照 `updater.ts` 同一條線：等一個安全的時機，由 `#applyPendingReload()`
   * 在玩家不在對戰中時自己做掉。
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
      pendingRuleReload = true;
      void applyPendingReload();
    },
  });

  // 上一次換檔（zip 版）留下來的 `*.ulrold`。**執行中的檔案只能改名不能刪**，
  // 所以清理一定得等到下一次啟動 —— 也就是現在。
  {
    const stale = cleanupStaleFiles(dirname(process.execPath));
    if (stale > 0) log(`· 已清掉上次更新留下的 ${stale} 個舊檔`);
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
