/**
 * 免 Steam 開一個遊戲分頁
 * =========================
 * `boot-shell.ts` 負責產生外殼重建的程式碼，這裡負責把它裝進瀏覽器：
 *
 *     Target.createTarget(about:blank)   ← 開一個乾淨的分頁
 *       → Target.attachToTarget
 *         → Page.addScriptToEvaluateOnNewDocument   ← 注入外殼
 *           → Page.navigate(書籤網址)
 *
 * 順序不能顛倒。`addScriptToEvaluateOnNewDocument` 只對**之後**載入的 document
 * 生效 —— 先導向再注入就永遠來不及，症狀是「分頁開了但停在 403」。
 *
 * 為什麼不用 `CdpAdapter.connect()`：那支會去找**已經存在的**遊戲分頁
 * （`attachToGamePage`）。這裡要做的是憑空開一個新的，還沒有遊戲分頁可找。
 */

import { spawn } from "node:child_process";
import type { GameBundles } from "./boot-shell.js";
import {
  BUNDLE_DISCOVERY_EXPRESSION,
  buildBookmarkUrl,
  buildBootShellScript,
  parseDiscoveredBundles,
} from "./boot-shell.js";
import { CdpClient } from "./client.js";
import { ENV_KEYS_TO_STRIP, GAME_ORIGIN, STEAM_APP_ID } from "./constants.js";
import { detectGameInstall } from "./game-install.js";
import { redactUrl } from "./redact.js";
import { discoverDebuggerUrl, WebSocketTransport } from "./transport.js";

export interface OpenGameTabOptions {
  port: number;
  /** 玩家的 SteamID64。會出現在網址上，**不會**嵌進注入的腳本。 */
  steamId: string;
  bundles: GameBundles;
  /** 指定遊戲的 port（14012~14021）。不給就隨機挑一個。 */
  gamePort?: number;
  origin?: string;
  commandTimeoutMs?: number;
}

export interface OpenGameTabResult {
  targetId: string;
  /** 已去識別化 —— 原始網址帶 steamid。§12：不得記錄。 */
  safeUrl: string;
}

export interface DiscoverBundlesResult {
  bundles: GameBundles;
  /** 是從哪個分頁讀到的，已去識別化。 */
  safeUrl: string;
}

export class BundlesNotFoundError extends Error {
  override readonly name = "BundlesNotFoundError";
  constructor(tried: string[]) {
    const list = tried.length === 0 ? "（沒有任何分頁）" : tried.map((u) => `  - ${u}`).join("\n");
    super(
      `沒有任何分頁載著遊戲。看過這些：\n${list}\n` +
        "  請先從 Steam 正常開一次網頁版，等遊戲畫面出來之後再跑一次。",
    );
  }
}

/**
 * 掃過所有分頁，找出真的載著遊戲的那個，讀回它的 bundle 檔名。
 *
 * 為什麼不用 `attachToGamePage`：那支挑「第一個看起來像遊戲的分頁」，在只有
 * 一個分頁時夠用。但這個指令的使用情境天生就是多分頁 —— 玩家可能同時開著
 * 兩個帳號、幾個 403 的舊分頁、還有我們自己開的測試分頁。挑錯的症狀是
 * 「讀不到 Phaser」，而正確的那個明明就在旁邊。
 *
 * 判準很直接：**誰身上有 `client/` 的 script，誰就是載著遊戲的那個。**
 * 這同時排除了 403 的空頁面，不必等 Phaser 就緒。
 */
export async function discoverBundlesAcrossPages(options: {
  port: number;
  commandTimeoutMs?: number;
}): Promise<DiscoverBundlesResult> {
  const transport = await WebSocketTransport.connect(await discoverDebuggerUrl(options.port));
  const client = new CdpClient(transport, {
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
  });

  const tried: string[] = [];
  try {
    const res = await client.send<{
      targetInfos?: { targetId?: unknown; type?: unknown; url?: unknown }[];
    }>("Target.getTargets");

    for (const target of res.targetInfos ?? []) {
      if (target.type !== "page") continue;
      if (typeof target.targetId !== "string") continue;
      const url = typeof target.url === "string" ? target.url : "";
      if (url === "" || url === "about:blank") continue;
      tried.push(redactUrl(url));

      const attached = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== "string") continue;
      const sessionId = attached.sessionId;

      try {
        const evaluated = await client.send<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: BUNDLE_DISCOVERY_EXPRESSION, returnByValue: true },
          sessionId,
        );
        // 讀不到就換下一個。403 的分頁、擴充功能頁、玩家自己開的網頁都會走到這裡，
        // 一個讀不到不代表整件事失敗。
        return {
          bundles: parseDiscoveredBundles(evaluated.result?.value),
          safeUrl: redactUrl(url),
        };
      } catch {
        continue;
      } finally {
        await client.send("Target.detachFromTarget", { sessionId });
      }
    }

    throw new BundlesNotFoundError(tried);
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// 自己去開一次 Steam 版，把當前版本的檔名讀回來
// ---------------------------------------------------------------------------

export class DesktopClientActiveError extends Error {
  override readonly name = "DesktopClientActiveError";
  constructor(resourcesDir: string, bytes: number) {
    super(
      "目前啟用的是**桌面版**客戶端，從 Steam 開起來不會經過瀏覽器，" +
        "所以讀不到網頁版的 bundle 檔名。\n" +
        `  ${resourcesDir}\\app.asar 是 ${Math.round(bytes / 1024 / 1024)}MB —— ` +
        "網頁版的那個只有 150KB 上下。\n" +
        "  把網頁版的 asar 換成 app.asar 再試，或改接桌面版的 CDP 埠。",
    );
  }
}

export class SteamLaunchUnsupportedError extends Error {
  override readonly name = "SteamLaunchUnsupportedError";
  constructor(platform: string) {
    super(`只有 Windows 能用 steam:// 協定啟動遊戲（目前是 ${platform}）。`);
  }
}

/**
 * 用 `steam://rungameid/<appid>` 叫 Steam 啟動遊戲。
 *
 * 走 shell 而不是直接 spawn 遊戲執行檔，有兩個理由：
 *   - Steam 得自己處理登入態與 app ticket，直接跑 exe 的話拿不到 token
 *   - shell 啟動的行程不會掛在 companion 的行程樹底下，companion 結束時
 *     不會把遊戲一起帶走
 */
export function launchGameViaSteam(appId: string = STEAM_APP_ID): void {
  if (process.platform !== "win32") {
    throw new SteamLaunchUnsupportedError(process.platform);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // §launching：ELECTRON_RUN_AS_NODE 會讓 Electron 的 exe 被當成純 Node 跑，
  // 症狀是「遊戲一開就立刻關掉」。companion 自己是 Electron app，會傳染。
  for (const key of ENV_KEYS_TO_STRIP) delete env[key];

  spawn("cmd", ["/c", "start", "", `steam://rungameid/${appId}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  }).unref();
}

export interface RefreshBundlesOptions {
  port: number;
  /** 找不到活著的遊戲時，要不要自己開一次 Steam 版。預設 true。 */
  launch?: boolean;
  /** 等遊戲載完的上限。冷啟動要過 Steam、Electron、瀏覽器三關。 */
  launchTimeoutMs?: number;
  pollIntervalMs?: number;
  /** 讓呼叫端把進度顯示出來 —— 這支會跑很久，靜默太久看起來像當掉。 */
  onProgress?: (message: string) => void;
  appId?: string;
}

export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;
export const DEFAULT_LAUNCH_POLL_MS = 3_000;

/**
 * 取得**當前版本**的 bundle 檔名。
 *
 * 已經有分頁載著遊戲就直接讀；沒有的話自己去開一次 Steam 版再讀。
 *
 * 為什麼非得這樣不可：伺服器沒有提供任何可以查詢當前版本的公開端點，而且
 * 舊的 bundle 不會被刪除，所以也沒辦法靠「檔案還在不在」判斷有沒有過期
 * （`boot-shell.ts` 開頭有完整的實測記錄）。唯一可靠的真相來源，就是讓遊戲
 * 自己正常載入一次，然後看它實際載了哪些檔案。
 */
export async function refreshBundles(
  options: RefreshBundlesOptions,
): Promise<DiscoverBundlesResult> {
  const report = options.onProgress ?? ((): void => {});

  try {
    return await discoverBundlesAcrossPages({ port: options.port });
  } catch (err) {
    if (!(err instanceof BundlesNotFoundError)) throw err;
    if (options.launch === false) throw err;
  }

  // 先確認 Steam 開起來的會是網頁版。目前是桌面版的話遊戲不經過瀏覽器，
  // 這裡會傻等到逾時才失敗，而且訊息看起來像網路問題 —— 不如立刻講清楚。
  const install = detectGameInstall();
  if (install !== null && install.mode === "desktop") {
    throw new DesktopClientActiveError(install.resourcesDir, install.activeAsarBytes);
  }

  report("沒有分頁載著遊戲，改由 Steam 啟動一次…");
  launchGameViaSteam(options.appId ?? STEAM_APP_ID);

  const timeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_LAUNCH_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      return await discoverBundlesAcrossPages({ port: options.port });
    } catch (err) {
      if (!(err instanceof BundlesNotFoundError)) throw err;
      if (!announced) {
        // 只講一次。每 3 秒印一行會把真正有用的訊息洗掉。
        report("等遊戲載入…（Steam → Electron → 瀏覽器，冷啟動要一段時間）");
        announced = true;
      }
    }
  }

  // 走到這裡代表 Steam 開了但瀏覽器始終沒載到遊戲。上面已經擋掉「啟用的是
  // 桌面版」這個最常見的原因，剩下的多半是 Steam 沒登入、遊戲更新中，
  // 或是 launcher 把網址交給了另一個瀏覽器（見 unlight-web-client-cdp）。
  throw new BundlesNotFoundError([
    `等了 ${Math.round(timeoutMs / 1000)} 秒都沒有分頁載入遊戲`,
    "確認 Steam 已登入、遊戲不在更新，且 launcher 會把網址交給這個瀏覽器。",
  ]);
}

export async function openGameTab(options: OpenGameTabOptions): Promise<OpenGameTabResult> {
  const origin = options.origin ?? GAME_ORIGIN;
  const url = buildBookmarkUrl(options.steamId, origin, options.gamePort);
  const source = buildBootShellScript({ bundles: options.bundles, allowPortRedirect: true });

  const transport = await WebSocketTransport.connect(await discoverDebuggerUrl(options.port));
  const client = new CdpClient(transport, {
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
  });

  try {
    const created = await client.send<{ targetId?: unknown }>("Target.createTarget", {
      url: "about:blank",
    });
    if (typeof created.targetId !== "string") {
      throw new Error("Target.createTarget 沒有回傳 targetId");
    }

    const attached = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") {
      throw new Error("Target.attachToTarget 沒有回傳 sessionId");
    }
    const sessionId = attached.sessionId;

    await client.send("Page.enable", undefined, sessionId);
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    await client.send("Page.navigate", { url }, sessionId);

    return { targetId: created.targetId, safeUrl: redactUrl(url) };
  } finally {
    client.close();
  }
}
