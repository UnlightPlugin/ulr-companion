/**
 * 埠是查出來的，不是常數
 * ========================
 * 這個檔案存在的理由，是 2026-08-16 那次「插件為什麼找不到 9334」：
 *
 *     Chrome 帶著 --remote-debugging-port=9334 好好地在跑
 *     但 9334 沒有人在聽，DevToolsActivePort 也沒產生
 *     → 插件只說「連不上」，玩家完全看不出下一步該做什麼
 *
 * 原因是 Windows 把 9277–9876 整段保留了（Hyper-V／WSL／Docker 會從**動態埠
 * 範圍**切 100 埠一段拿走），Chromium 綁不上就靜靜地放棄開 debug server。
 * 同一個病 2026-07-30 已經發生過一次，那次的埠是 1221。
 *
 * ## 為什麼換一個「更好的埠號」不是解法
 *
 * 動態埠範圍本身是可以被改的（`netsh int ipv4 show dynamicport tcp`）：
 *
 *   - Windows 預設      49152–65535   → 高位埠危險，低位埠安全
 *   - 被改過的機器      1024–15000    → 低位埠危險，高位埠安全（開發機就是這樣）
 *
 * 兩種設定的危險區剛好相反，所以**沒有任何常數在兩邊都安全**。挑埠號等於在賭
 * 對方的機器是哪一種。預設值（59222／59223）選的是「好記、一看就知道是一對」，
 * 不是「絕對安全」—— 安全交給下面這層回退，不交給埠號。
 *
 * ## 真正的解法：讓 Chromium 自己挑，我們去讀它挑了什麼
 *
 * `--remote-debugging-port=0` 會讓它挑一個綁得上的埠，並寫進
 * `<user-data-dir>\DevToolsActivePort`（第一行是埠，第二行是 browser ws path）。
 *
 * ⚠ **`0` 只能當啟動參數，不能當設定值。** `127.0.0.1:0` 不是位址，沒有人會
 * 聽它；而且托盤是拿埠當實例身分的（`main.ts` 的 userData 分離、配置不得重複），
 * 存 0 會讓兩份配置撞在一起。所以設定裡永遠是一個真的埠號＝**首選**，0 只在
 * 首選綁不上時出現在命令列上。
 *
 * ⚠ **回退要限定在同一種客戶端。** 兩個客戶端各有各的 user-data-dir，所以各有
 * 各的 DevToolsActivePort：
 *
 *   桌面版  %APPDATA%\UNLIGHT-Revive
 *   網頁版  ~\ulr-cdp-profile（`browser.ts` 的 DEFAULT_BROWSER_PROFILE_DIR）
 *
 * 不分種類地亂讀，症狀會是「我開的是網頁版的插件，它卻接到桌面版去」——
 * 那正是 `profiles-core.ts` 一直在防的那件事。
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEBUG_HOST } from "./constants.js";
import { discoverDebuggerUrl } from "./transport.js";

/** Chromium 把實際埠寫在 user-data-dir 底下的這個檔。 */
export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

/**
 * 桌面版的 user-data-dir。
 *
 * 這是 Electron 的 `app.getPath("userData")`，由 package.json 的 name 決定，
 * 2026-08-16 對著跑著的客戶端確認過（`--user-data-dir=` 出現在它每個子程序的
 * 命令列上）。遊戲改名的話這裡要跟著改 —— 但改名會連存檔位置一起換，
 * 不會是安靜的失敗。
 */
export function desktopUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "UNLIGHT-Revive");
}

/**
 * 讀出客戶端自己記下的埠。讀不到、格式不對、檔案是舊的都回 `null`。
 *
 * ⚠ **讀到的值一定要再驗一次有沒有人在聽。** Chromium 正常結束時會刪掉這個檔，
 * 但**當掉時不會** —— 留下來的那份指向一個早就沒人聽的埠。呼叫端請走
 * `resolveDebugPort()`，它會驗；不要直接拿這裡的回傳值去連。
 */
export function readDevToolsActivePort(userDataDir: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * 這個埠現在是什麼狀況。
 *
 * | 回傳      | 意思                                             |
 * | --------- | ------------------------------------------------ |
 * | `free`    | 綁得上，沒人用                                   |
 * | `in-use`  | 有人在聽（可能就是遊戲，也可能是別的程式）        |
 * | `blocked` | **綁不上** —— Windows 保留範圍，換埠才有救        |
 *
 * `blocked` 是這整個檔案的重點：它跟 `free` 在外觀上完全一樣（沒人在聽），
 * 但結局完全不同，而分辨它們只需要試綁一次。
 */
export type PortState = "free" | "in-use" | "blocked";

export async function probePortState(port: number, host: string = DEBUG_HOST): Promise<PortState> {
  return await new Promise<PortState>((resolve) => {
    const server = createServer();
    const done = (state: PortState): void => {
      server.removeAllListeners();
      server.close(() => resolve(state));
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      // EACCES = WSAEACCES：Windows 保留範圍。EADDRINUSE = 真的有人在聽。
      // 其他錯誤（位址不合法之類）當成 blocked —— 反正都是「這個埠用不了」。
      resolve(err.code === "EADDRINUSE" ? "in-use" : "blocked");
    });
    server.once("listening", () => done("free"));
    server.listen(port, host);
  });
}

export type DebugPortSource = "configured" | "devtools-file";

export interface ResolvedDebugPort {
  port: number;
  /** `devtools-file` = 首選埠沒回應，是從客戶端自己記的檔案找回來的。 */
  source: DebugPortSource;
}

export interface ResolveDebugPortOptions {
  /** 設定裡那個埠。永遠先問它 —— 正常情況要走快路，而且結果要可預期。 */
  port: number;
  /**
   * 這個客戶端的 user-data-dir。**不給就不回退** —— 沒有它就沒有辦法確定
   * 找到的埠屬於哪一個客戶端，寧可連不上也不要接到別人的遊戲上。
   */
  userDataDir?: string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * 找出「現在真的可以連的那個埠」。
 *
 * | 設定的埠有回應 | 檔案裡的埠有回應 | 兩者相同 | 選誰       |
 * | -------------- | ---------------- | -------- | ---------- |
 * | ✅             | ❌／沒有檔案     | —        | 設定的埠   |
 * | ✅             | ✅               | ✅       | 設定的埠   |
 * | ✅             | ✅               | ❌       | **檔案**   |
 * | ❌             | ✅               | —        | 檔案       |
 * | ❌             | ❌               | —        | `null`     |
 *
 * ⚠ **第三列是重點，而且它一開始被我寫錯了。** 直覺會說「設定的埠有回應就用它」，
 * 但那條路會在這個情況下把插件接到**別人的程式**上：
 *
 *     設定寫 59222，客戶端其實開在 7141（埠 0 自動挑的）
 *     而 59222 上剛好坐著另一個 Electron app（或另一份開著 debug port 的瀏覽器）
 *     → 連得上、握手成功、但那上面永遠不會出現遊戲分頁
 *     → 症狀是「一直卡在等遊戲…」，而遊戲明明就開著
 *
 * 這不是假想：9222 就是因為常被 Adobe UXP 佔走才改成 59222 的（見 constants.ts）。
 * 而且**建議玩家用 `--remote-debugging-port=0` 之後，這個風險反而變高** ——
 * 設定裡那個埠變成一個我們自己永遠不會用的號碼，被別人坐上去也不奇怪。
 *
 * 判準是：**檔案是那個客戶端自己寫的，它比設定值更知道自己在哪。** 兩邊都活著
 * 又不一樣時，設定的那個必然是別人。
 *
 * ⚠ 讀到的埠**一定要再驗一次**才算數 —— Chromium 當掉時會留下指向死埠的舊檔。
 *
 * ⚠ **已知限制：兩個桌面版客戶端分不開。** 它們共用
 * `%APPDATA%\UNLIGHT-Revive`，所以只有一份 `DevToolsActivePort`（後開的蓋掉先開的），
 * 上表第三列會讓兩份插件都接到同一個客戶端。要那樣多開就得給各自不同的
 * `--user-data-dir`，或不要傳 `userDataDir`（退回純設定值，失去所有回退能力）。
 * 支援的多開組合是**桌面版 + 網頁版**，那是兩個不同的目錄。
 */
export async function resolveDebugPort(
  options: ResolveDebugPortOptions,
): Promise<ResolvedDebugPort | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured: ResolvedDebugPort = { port: options.port, source: "configured" };

  let configuredLive = false;
  try {
    await discoverDebuggerUrl(options.port, fetchImpl);
    configuredLive = true;
  } catch {
    // 可能是遊戲還沒開，也可能是埠變了。下面的檔案會回答。
  }

  const dir = options.userDataDir;
  const recorded = dir === undefined || dir === "" ? null : readDevToolsActivePort(dir);
  // 沒有檔案、或檔案講的就是設定值 —— 沒有第二個候選，設定值說了算。
  if (recorded === null || recorded === options.port) return configuredLive ? configured : null;

  try {
    await discoverDebuggerUrl(recorded, fetchImpl);
    return { port: recorded, source: "devtools-file" };
  } catch {
    // 舊檔。設定的埠若還活著就用它 —— 至少那是玩家自己指定的。
    return configuredLive ? configured : null;
  }
}

/**
 * 那個埠上在聽的是誰。**只用來寫錯誤訊息，不要拿來做判斷。**
 *
 * `/json/version` 的 `Browser` 欄位長得像 `Chrome/151.0.7922.138` 或
 * `Electron/32.1.2`。認不出來就回 `null` —— 猜錯會讓訊息把玩家帶到錯的方向。
 */
async function describeListener(port: number, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`http://${DEBUG_HOST}:${port}/json/version`);
    if (!res.ok) return null;
    const payload: unknown = await res.json();
    if (typeof payload !== "object" || payload === null) return null;
    const browser = (payload as Record<string, unknown>)["Browser"];
    return typeof browser === "string" && browser.length > 0 ? browser : null;
  } catch {
    return null;
  }
}

/**
 * 連不上的時候，講一句**指向下一步**的話。
 *
 * 這支的存在理由：`DebuggerNotFoundError` 只能說「連不上」，而連不上有五種
 * 完全不同的原因、四種不同的下一步，玩家從錯誤訊息上一種都分不出來，於是
 * 全部變成「插件壞了」。
 *
 * | 狀況                        | 玩家要做的事                       |
 * | --------------------------- | ---------------------------------- |
 * | 埠被 Windows 保留           | **換埠**（或改用 `=0`）            |
 * | 有別的程式在聽（不是 CDP）  | **換埠**（或關掉那支程式）         |
 * | 在聽的是別的 Chromium 程式  | **換埠** —— 不然會接到別人的程式上 |
 * | 客戶端記的埠是舊的          | 把遊戲完全關掉再開                 |
 * | 沒人在聽                    | 遊戲沒開，或啟動參數沒帶           |
 *
 * ⚠ **「有人在聽」不等於「被佔用」。** 遊戲自己在聽時也是 `in-use`，那是正常
 * 狀態不是錯誤 —— 所以這支只在**已經連不上**的前提下被呼叫，而且會先確認
 * 那個聽眾到底是不是一個 Chromium debugger。分不清楚就會對著正常運作的遊戲
 * 叫玩家換埠。
 */
export async function explainDebugPort(options: {
  port: number;
  userDataDir?: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = await probePortState(options.port);

  if (state === "blocked") {
    return (
      `127.0.0.1:${options.port} **綁不上** —— 這個埠落在 Windows 的保留範圍裡` +
      `（Hyper-V／WSL／Docker 會整段拿走）。客戶端就算帶著參數啟動也開不了 debug port，` +
      `而且不會有任何錯誤。查：netsh interface ipv4 show excludedportrange protocol=tcp  ` +
      `解法：在設置裡換一個埠，或把啟動選項改成 --remote-debugging-port=0 ` +
      `讓客戶端自己挑一個，插件會從 DevToolsActivePort 讀回來。`
    );
  }

  if (state === "in-use") {
    // 走到這裡代表「有人在聽，但那個人給不出我們要的東西」——
    // 遊戲自己在聽的話根本不會呼叫這支。
    const who = await describeListener(options.port, fetchImpl);
    return who === null
      ? `127.0.0.1:${options.port} **已經被別的程式佔用了**，而且它不是 Chromium 的 ` +
          `debug port（問 /json/version 沒有得到像樣的回答）。這個埠給不了遊戲用 —— ` +
          `在設置裡換一個埠，或關掉佔著它的那支程式。` +
          `查是誰：Get-NetTCPConnection -LocalPort ${options.port} | Select OwningProcess`
      : `127.0.0.1:${options.port} 上聽著的是 **${who}**，但那上面找不到 UNLIGHT 的分頁 —— ` +
          `這個埠被**另一個** Chromium 程式佔走了（Electron app 與開著 debug port 的 ` +
          `瀏覽器都會這樣）。再等下去也不會變成遊戲：在設置裡換一個埠，` +
          `或關掉那支程式再從 Steam 開一次遊戲。`;
  }

  const dir = options.userDataDir;
  const recorded = dir === undefined || dir === "" ? null : readDevToolsActivePort(dir);
  if (recorded !== null && recorded !== options.port) {
    return (
      `127.0.0.1:${options.port} 沒有人在聽，但客戶端記下的是 :${recorded}` +
      `（${join(dir ?? "", DEVTOOLS_ACTIVE_PORT_FILE)}），而那個埠現在也連不上 —— ` +
      `多半是上次當掉留下的舊檔。把遊戲完全關掉再開一次。`
    );
  }

  return (
    `127.0.0.1:${options.port} 沒有人在聽。檢查順序：遊戲開了沒 → ` +
    `啟動時有沒有帶 --remote-debugging-port（這個參數不能對已經在跑的程序補掛）→ ` +
    `spawn 時有沒有清掉 ELECTRON_RUN_AS_NODE → ` +
    `app.asar 是不是視窗版（153KB 那個是網頁版，開完瀏覽器就自己退出）。`
  );
}
