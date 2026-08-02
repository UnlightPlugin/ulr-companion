/**
 * 自己開一個帶 debug port 的瀏覽器
 * ==================================
 * `boot.ts` 的 `openGameTab()` 需要一個已經在聽 CDP 的瀏覽器。這裡負責把它
 * 生出來 —— 有了這一步，**整條路就完全不必經過 Steam**：
 *
 *     ensureBrowser()      ← 開 Chrome（帶 debug port + 專屬 profile）
 *       → openGameTab()    ← 注入外殼、導向 ?steamid=<id>
 *
 * 為什麼這件事值得做（不只是少按一次滑鼠）：
 *
 * - **換帳號**。身分只有網址上的 `steamid`（見 boot-shell.ts 開頭），所以換帳號
 *   就是換一個 `--steamid`，跟 Steam 客戶端登入的是哪個帳號無關。Steam 網頁版
 *   本身沒有換帳號的路，這裡繞過了整個問題。
 * - **不會卡在「正在停止」**。那是 Steam 在等遊戲行程收尾；我們根本沒讓 Steam
 *   參與，也就沒有那個狀態。反過來說，Steam 卡在停止中的時候 `steam://rungameid`
 *   會失效 —— 那正是 `refreshBundles()` 會失敗的時候，更需要這條備援路徑。
 *
 * Steam 只剩下**一個**用途：遊戲改版後重讀 bundle 檔名（`refreshBundles()`）。
 * 那是每週一次的事，不是每次開遊戲的事。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BROWSER_DEBUG_PORT, ENV_KEYS_TO_STRIP } from "./constants.js";
import { discoverDebuggerUrl } from "./transport.js";

/**
 * 插件專屬的瀏覽器 profile。
 *
 * ⚠ `--user-data-dir` 是必要的不是選配：玩家已經開著 Chrome 時，用**同一個**
 * profile 再啟動只會在既有實例開一個分頁，**命令列參數整個被忽略**，port 不會開。
 * 專屬 profile 才保證是全新實例，也完全不影響玩家平常的瀏覽器。
 *
 * 放在家目錄底下而不是暫存區：`ulr-boot` 擴充功能、書籤、視窗大小都存在這裡，
 * 清掉就要重裝一次。
 */
export const DEFAULT_BROWSER_PROFILE_DIR = join(homedir(), "ulr-cdp-profile");

/** 等瀏覽器把 debug port 開起來的上限。冷啟動的 Chrome 大約 1~3 秒。 */
export const DEFAULT_BROWSER_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_POLL_MS = 250;

/**
 * 找得到的 Chromium 系瀏覽器，依偏好排序。
 *
 * 只認 Chromium 系 —— `--remote-debugging-port` 是 Chromium 的參數，Firefox
 * 沒有等價的東西（它走 Remote Agent，協定不同）。
 *
 * 每個 candidate 是「基底目錄的環境變數名 + 相對路徑」。寫死 `C:\Program Files`
 * 在非英文版或改過安裝碟的機器上會失準。
 */
const BROWSER_CANDIDATES: readonly { env: string; rel: string; name: string }[] = [
  { env: "ProgramFiles", rel: "Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
  { env: "ProgramFiles(x86)", rel: "Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
  { env: "LOCALAPPDATA", rel: "Google\\Chrome\\Application\\chrome.exe", name: "Chrome" },
  { env: "ProgramFiles(x86)", rel: "Microsoft\\Edge\\Application\\msedge.exe", name: "Edge" },
  { env: "ProgramFiles", rel: "Microsoft\\Edge\\Application\\msedge.exe", name: "Edge" },
  {
    env: "ProgramFiles",
    rel: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    name: "Brave",
  },
  {
    env: "LOCALAPPDATA",
    rel: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    name: "Brave",
  },
];

export interface FoundBrowser {
  path: string;
  /** `Chrome` / `Edge` / `Brave`。只拿來顯示。 */
  name: string;
}

export class BrowserNotFoundError extends Error {
  override readonly name = "BrowserNotFoundError";
  constructor() {
    super(
      "找不到 Chromium 系的瀏覽器（Chrome / Edge / Brave）。\n" +
        "  用 --browser <chrome.exe 的完整路徑> 指定，或裝一個。\n" +
        "  Firefox 不行 —— `--remote-debugging-port` 是 Chromium 的參數。",
    );
  }
}

export class BrowserPortTimeoutError extends Error {
  override readonly name = "BrowserPortTimeoutError";
  constructor(port: number, profileDir: string, seconds: number) {
    super(
      `瀏覽器開起來了，但 ${seconds} 秒內沒有在 127.0.0.1:${port} 聽。\n` +
        "  兩個最可能的原因：\n" +
        `  1. 這個 profile 已經有另一個**沒帶 debug port** 的實例在跑，新的參數被忽略了。\n` +
        `     關掉用 ${profileDir} 的瀏覽器視窗再試。\n` +
        "  2. 這個埠落在 Windows 的保留範圍（Hyper-V／WSL／Docker 會動態佔走整段）。\n" +
        "     症狀特別像「參數被忽略」—— 瀏覽器照常開，但不會產生 DevToolsActivePort。\n" +
        "     查：netsh interface ipv4 show excludedportrange protocol=tcp\n" +
        "     換一個埠：--port <N>",
    );
  }
}

/**
 * 找一個能用的瀏覽器。找不到回 `null` —— 由呼叫端決定要報錯還是換做法。
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): FoundBrowser | null {
  for (const candidate of BROWSER_CANDIDATES) {
    const base = env[candidate.env];
    if (base === undefined || base === "") continue;
    const path = join(base, candidate.rel);
    if (existsSync(path)) return { path, name: candidate.name };
  }
  return null;
}

export interface BrowserArgsOptions {
  port: number;
  profileDir: string;
  /** 玩家自己的偏好，例如 `--force-device-scale-factor=1.5`。原樣接在後面。 */
  extraArgs?: readonly string[];
}

/**
 * 組出啟動參數。純函式，所以可以完整測試。
 *
 * 開在 `about:blank` 而不是直接開遊戲網址：外殼注入要用
 * `Page.addScriptToEvaluateOnNewDocument`，那只對**之後**載入的 document 生效。
 * 啟動時就導過去的話，等我們連上 CDP 時頁面早就載完了，注入永遠來不及
 * （症狀是「分頁開了但停在 403」）。導向那一步交給 `openGameTab()`。
 */
export function buildBrowserArgs(options: BrowserArgsOptions): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    `--remote-debugging-port=${options.port}`,
    // 專屬 profile 每次都是「新使用者」，這三個橫幅會擋在遊戲前面。
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    ...(options.extraArgs ?? []),
    "about:blank",
  ];
}

/** debug port 現在有沒有人在聽。 */
export async function isDebugPortLive(port: number): Promise<boolean> {
  try {
    await discoverDebuggerUrl(port);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchBrowserOptions {
  port?: number;
  profileDir?: string;
  /** 不給就自己找（`findBrowser`）。 */
  browserPath?: string;
  extraArgs?: readonly string[];
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface LaunchBrowserResult {
  browser: FoundBrowser;
  port: number;
  profileDir: string;
  /** 已經在跑就沒有重開。 */
  launched: boolean;
}

/**
 * 確保有一個帶 debug port 的瀏覽器在跑，然後回報它是哪一個。
 *
 * 已經在聽就**直接沿用**，不重開 —— 玩家可能正開著另一個帳號的分頁在打，
 * 或手動開了同一個 profile。插件不該替他做關閉的決定（docs/launching.md §偵測與降級）。
 */
export async function ensureBrowser(
  options: LaunchBrowserOptions = {},
): Promise<LaunchBrowserResult> {
  const port = options.port ?? BROWSER_DEBUG_PORT;
  const profileDir = options.profileDir ?? DEFAULT_BROWSER_PROFILE_DIR;

  if (await isDebugPortLive(port)) {
    return {
      browser: { path: "(已在跑)", name: "既有實例" },
      port,
      profileDir,
      launched: false,
    };
  }

  const browser =
    options.browserPath !== undefined
      ? { path: options.browserPath, name: "(指定)" }
      : findBrowser();
  if (browser === null) throw new BrowserNotFoundError();

  const env: NodeJS.ProcessEnv = { ...process.env };
  // §launching 陷阱 1：companion 自己是 Electron app，`ELECTRON_RUN_AS_NODE`
  // 會傳染給子程序。Chrome 不吃這個變數，但同一份規則對所有 spawn 都適用，
  // 而且 VS Code 的終端機也會設 —— 少一個以後才會踩到的地雷。
  for (const key of ENV_KEYS_TO_STRIP) delete env[key];

  const args = buildBrowserArgs({
    port,
    profileDir,
    ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
  });

  // detached + unref：companion 結束時不要把玩家的遊戲一起帶走。
  spawn(browser.path, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env,
  }).unref();

  const timeoutMs = options.readyTimeoutMs ?? DEFAULT_BROWSER_READY_TIMEOUT_MS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_BROWSER_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (await isDebugPortLive(port)) {
      return { browser, port, profileDir, launched: true };
    }
  }

  throw new BrowserPortTimeoutError(port, profileDir, Math.round(timeoutMs / 1000));
}
