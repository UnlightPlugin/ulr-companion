/**
 * 托盤程式（WP-15）
 * ===================
 * 一個托盤圖示管**一個**遊戲客戶端。要管兩個就開兩份 —— 設定頁的「配置」
 * 那一欄按「開新實例」，或沿用舊的命令列：
 *
 *     npm run tray                      上次用的那份配置
 *     npm run tray -- --profile <id>    指定配置
 *     npm run tray -- --port 9333       相容用法：對得上就用那份，對不上開臨時的
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

import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import type { EngineStatus } from "@ulr/arbiter-engine";
import { ArbiterEngine } from "@ulr/arbiter-engine";
import type { LinkPrefs } from "@ulr/arbiter-link";
import {
  describeTarget,
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  parseLinkTarget,
} from "@ulr/arbiter-link";
import { discoverDebuggerUrl } from "@ulr/cdp-adapter";
import { trayIconPng } from "./icon.js";
import type { IconState } from "./icon.js";
import { launchAtLoginEnabled, launchInstance, setLaunchAtLogin } from "./launch.js";
import { openLogFile } from "./log-file.js";
import type { ClientKind, Profile, ProfileStore } from "./profiles.js";
import {
  addProfile,
  defaultPortFor,
  loadStore,
  markUsed,
  removeProfile,
  resolveProfile,
  updateOptions,
  updateProfile,
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

// ⚠ 關卡 1：兩份實例不能共用 userData。必須在 app ready 之前設，而且要在
// 讀完配置之後 —— 埠是從配置來的。
{
  // `loadStore()` 會用到 app.getPath，那在 ready 之前就可以呼叫。
  store = loadStore();
  const resolved = resolveProfile(store, process.argv);
  profile = resolved.profile;
  ephemeral = resolved.ephemeral;
  app.setPath("userData", join(app.getPath("appData"), "ulr-companion", `port-${profile.port}`));
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
 */
const logFile = openLogFile(app.getPath("userData"));

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
  const ports = [...new Set(store.profiles.map((p) => p.port))];
  const seen = await Promise.all(
    ports.map(async (port): Promise<readonly [number, boolean]> => {
      try {
        // 重用 cdp-adapter 那支 —— 它已經處理過「回應裡沒有 webSocketDebuggerUrl」
        // 這種「埠有人聽但不是遊戲」的情況。
        await discoverDebuggerUrl(port, probeFetch);
        return [port, true];
      } catch {
        return [port, false];
      }
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
  return store.multiProfile ? `ULR Companion — ${profile.name} :${profile.port}` : "ULR Companion";
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
        ? `${profile.name}  遊戲 :${profile.port}  中間人 ${describeTarget(parseLinkTarget(profile.link))}`
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
  /** 遊戲埠 → 那個埠上有沒有客戶端在回話。見 `gamePorts` 的註解。 */
  gamePorts: Record<number, boolean>;
  limits: { minSeconds: number; maxSeconds: number; minSpeed: number; maxSpeed: number };
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
    gamePorts: Object.fromEntries(gamePorts),
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
  // ⚠ 一定要等引擎收乾淨：它會把頁面上的攔截拆掉。留著孤兒的話遊戲裡的
  // OK 鈕會有 3 秒（心跳）處在沒人管的狀態。
  await engine?.stop();
  tray?.destroy();
  app.quit();
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
