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
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import type { EngineStatus } from "@ulr/arbiter-engine";
import { ArbiterEngine } from "@ulr/arbiter-engine";
import type { LinkPrefs } from "@ulr/arbiter-link";
import {
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
} from "@ulr/arbiter-link";
import { trayIconPng } from "./icon.js";
import type { IconState } from "./icon.js";
import { launchAtLoginEnabled, launchInstance, setLaunchAtLogin } from "./launch.js";
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

/** 托盤圖示的顏色語意見 `icon.ts`：綠色只留給「兩邊真的講好了」。 */
function iconState(status: EngineStatus | null): IconState {
  if (status === null || !status.connected) return "idle";
  return status.link === "paired" ? "paired" : "solo";
}

function tooltip(status: EngineStatus | null): string {
  const head = `ULR Companion — ${profile.name} :${profile.port}`;
  if (status === null) return head;
  const parts = [head];
  parts.push(
    status.connected ? `已接上${status.seat === null ? "" : `（座位 ${status.seat}）`}` : "等遊戲…",
  );
  parts.push(
    status.link === "paired"
      ? `已配對  階段 ${status.capSeconds ?? MOVE_PHASE_TOTAL_SECONDS}s`
      : "單邊模式（秒數不縮短）",
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
  return Menu.buildFromTemplate([
    {
      label: `${profile.name}  遊戲 :${profile.port}  中間人 :${profile.linkPort}`,
      enabled: false,
    },
    {
      label:
        latest?.link === "paired"
          ? `已配到對手  共同階段 ${latest.capSeconds ?? MOVE_PHASE_TOTAL_SECONDS} 秒`
          : "還沒配到對手（秒數不縮短）",
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
    { type: "separator" },
    { label: "結束", click: () => void quit() },
  ]);
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
    // 兩份實例同時開著時，標題是唯一分得出誰是誰的東西。
    title: `ULR Companion — ${profile.name} :${profile.port}`,
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
  });
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
    linkPort: profile.linkPort,
    prefs: profile.prefs,
    readyTint: profile.readyTint,
    onLog: (line) => {
      logLines.push(line);
      if (logLines.length > 200) logLines.shift();
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
      patch: { name?: string; port?: number; linkPort?: number; kind?: ClientKind },
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
    (_event, patch: { launchAtLogin?: boolean; startMinimized?: boolean }) => {
      store = updateOptions(patch);
      // 登錄檔是真實來源，設定檔只是記錄玩家的意圖。兩個都要動。
      if (patch.launchAtLogin !== undefined) setLaunchAtLogin(patch.launchAtLogin);
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

  void engine.start();
  // 靜默下載、安全的時機才套用。細節與那個「安全」的定義見 updater.ts。
  startAutoUpdate({
    currentVersion: VERSION,
    isBusy: () => latest?.armed === true,
    onLog: (l) => logLines.push(l),
  });

  // ⚠ 更新後由安裝檔叫起來的那一次**不要跳視窗**。玩家可能正在打字、
  // 正在看牌組 —— 更新本來就該是他察覺不到的事，跳一個視窗出來剛好相反。
  const fromUpdate = consumeUpdatedFlag();
  if (fromUpdate) logLines.push(`✓ 已更新到 ${VERSION}`);
  // `--startup` 是開機自動啟動帶的旗標。那個情境下也不要跳視窗。
  if (!fromUpdate && !process.argv.includes("--startup") && !store.startMinimized) showWindow();
});

// ⚠ 托盤程式沒有視窗時**不能結束**。這是 Electron 在 Windows/Linux 上的預設行為，
// 而它對這個 app 是錯的：關掉設定視窗之後仲裁還要繼續跑。
app.on("window-all-closed", () => {});
