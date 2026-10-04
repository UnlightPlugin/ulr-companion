/**
 * 從瀏覽器層級的連線找到遊戲那個分頁
 * ====================================
 * `discoverDebuggerUrl` 給的是**瀏覽器層級**的 WebSocket。要對頁面下命令
 * （`Page.*` / `Runtime.*`）必須先 attach 到 page target 拿一個 sessionId。
 *
 * 為什麼不直接用 `/json/list` 的第一筆（`unlight_crawler` 的 app.py 是那樣做的）：
 * 那個清單的順序沒有保證，而 Electron 會有不只一個 target（devtools、
 * service worker、玩家自己開的分頁）。挑錯的話症狀是「注入成功但畫面沒反應」，
 * 很難查。自己挑一次，把挑選條件寫下來。
 */

import type { CdpClient } from "./client.js";
import { GAME_ORIGIN, GAME_TITLE } from "./constants.js";
import { redactUrl } from "./redact.js";

export interface PageTarget {
  targetId: string;
  /** 已去識別化。**不要**保留原始 URL，遊戲的 URL 帶 steamid 與 token。 */
  safeUrl: string;
  title: string;
}

export interface GamePageSession extends PageTarget {
  sessionId: string;
  /**
   * attach 的是桌面版外殼裡那個 out-of-process 的遊戲 iframe（2026-09-23 起）時，
   * 外殼頁面的 targetId；否則 `null`。
   *
   * ⚠ `Page.reload` 只能對**頂層** target 下（iframe target 回 -32000
   * 「Command can only be executed on top-level targets」），所以重載遊戲要
   * 對外殼下 —— 外殼的 main() 會重新跟 Steam 要票證、換一顆新的 access_token。
   */
  shellTargetId: string | null;
}

export class GamePageNotFoundError extends Error {
  override readonly name = "GamePageNotFoundError";
  constructor(candidates: PageTarget[]) {
    const list =
      candidates.length === 0
        ? "（一個 page target 都沒有）"
        : candidates.map((c) => `  - ${c.title} ${c.safeUrl}`).join("\n");
    super(`找不到遊戲的分頁。目前的 page target：\n${list}`);
  }
}

/**
 * 接到外殼等 Phaser 的時候，外殼旁邊冒出了遊戲 iframe —— 這一輪接錯了，
 * 重新挑一次就會接到 iframe。
 *
 * 會發生在桌面版重載（F5、套用 COST）的空檔：舊 iframe 一消失插件就重連，
 * 新 iframe 要幾秒後才生出來，這時挑得到的只有外殼。2026-09-25 實測不攔的話
 * 要在外殼裡空等滿 30 秒逾時，遊戲 11 秒就載好了、插件 33 秒才接上。
 */
export class GameFrameAppearedError extends Error {
  override readonly name = "GameFrameAppearedError";
  constructor() {
    super("遊戲的 iframe 剛出現，改接它");
  }
}

interface RawTargetInfo {
  targetId?: unknown;
  type?: unknown;
  url?: unknown;
  title?: unknown;
  attached?: unknown;
}

/** 桌面版外殼裡那個 out-of-process 的遊戲 iframe。剛建立時網址是空的，之後才補上。 */
export function isGameFrameTarget(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const t = raw as RawTargetInfo;
  return t.type === "iframe" && typeof t.url === "string" && isGameOriginUrl(t.url);
}

/** devtools 自己、擴充功能、空白頁 —— 都不是遊戲。 */
function isPlausibleGamePage(url: string): boolean {
  if (url === "" || url === "about:blank") return false;
  return !/^(devtools|chrome|chrome-extension|edge):/i.test(url);
}

/** 遊戲本體的網址（不論帶不帶 port）。 */
export function isGameOriginUrl(url: string): boolean {
  try {
    return new URL(url).hostname === new URL(GAME_ORIGIN).hostname;
  } catch {
    return false;
  }
}

export function selectGamePage(targets: readonly RawTargetInfo[]): PageTarget | null {
  const pages: { raw: RawTargetInfo; url: string }[] = [];
  const gameFrames: { raw: RawTargetInfo; url: string }[] = [];
  for (const t of targets) {
    if (typeof t.targetId !== "string") continue;
    const url = typeof t.url === "string" ? t.url : "";
    if (t.type === "iframe") {
      if (isGameFrameTarget(t)) gameFrames.push({ raw: t, url });
      continue;
    }
    if (t.type !== "page") continue;
    if (!isPlausibleGamePage(url)) continue;
    pages.push({ raw: t, url });
  }

  // ⚠ 2026-09-23 的客戶端（Electron 44）把跨來源的遊戲 iframe 放進**自己的程序**
  // （out-of-process iframe），它在 CDP 上是一個獨立的 `type: "iframe"` target。
  // attach 到 file:// 的殼只看得到殼自己那一個 execution context，永遠等不到
  // Phaser —— 症狀是「接上遊戲分頁」之後卡在「試過 1 個都沒有 Phaser」。
  // 所以遊戲來源的 iframe target 存在時直接 attach 它。
  const chosen =
    gameFrames[0] ??
    // 桌面版的殼是 file://…/index.html，它把遊戲載在 iframe 裡 —— 舊客戶端的
    // iframe 跟殼同一個程序，attach 殼就找得到。網頁版則直接是 https 的遊戲頁。
    // 兩種都可能，優先取 file:// 的殼（桌面版），否則取第一個。
    pages.find((p) => p.url.startsWith("file://")) ??
    pages[0];
  if (chosen === undefined) return null;

  return {
    targetId: chosen.raw.targetId as string,
    safeUrl: redactUrl(chosen.url),
    title: safeTitle(chosen.raw.title),
  };
}

/** 選到的是遊戲 iframe 時，它的外殼（file:// 的 page target）。 */
function shellOf(targets: readonly RawTargetInfo[], picked: PageTarget): string | null {
  const self = targets.find((t) => t.targetId === picked.targetId);
  if (self?.type !== "iframe") return null;
  const shell = targets.find(
    (t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith("file://"),
  );
  return typeof shell?.targetId === "string" ? shell.targetId : null;
}

/**
 * 分頁標題也可能是憑證。
 *
 * ⚠ 沒有 `<title>` 的 frame，CDP 拿**整串網址**當標題 —— 遊戲 iframe 正是如此，
 * 標題就是 `https://…?platform_id=…&access_token=…`，而且 `&` 有時會被寫成
 * `&amp;`，`redactUrl` 會把鍵名認成 `amp;access_token` 而漏掉。標題只拿來給人看，
 * 所以看起來像網址就整個換成遊戲名，不去賭遮蔽規則。
 */
function safeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return /:\/\//.test(raw) || raw.includes("?") ? GAME_TITLE : raw;
}

export function toPageTargets(targets: readonly RawTargetInfo[]): PageTarget[] {
  return targets
    .filter((t) => t.type === "page" && typeof t.targetId === "string")
    .map((t) => ({
      targetId: t.targetId as string,
      safeUrl: redactUrl(typeof t.url === "string" ? t.url : ""),
      title: safeTitle(t.title),
    }));
}

/** attach 到遊戲分頁，拿到之後所有 `Page.*` / `Runtime.*` 要帶的 sessionId。 */
export async function attachToGamePage(client: CdpClient): Promise<GamePageSession> {
  const res = await client.send<{ targetInfos?: RawTargetInfo[] }>("Target.getTargets");
  const targets = res.targetInfos ?? [];

  const page = selectGamePage(targets);
  if (page === null) {
    throw new GamePageNotFoundError(toPageTargets(targets));
  }

  // flatten:true 讓子 session 的訊息走同一條 WebSocket，只是多帶 sessionId。
  // 沒有它就得處理 Target.receivedMessageFromTarget 的巢狀包裝，沒有好處。
  const attached = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });

  if (typeof attached.sessionId !== "string") {
    throw new GamePageNotFoundError([page]);
  }

  return { ...page, sessionId: attached.sessionId, shellTargetId: shellOf(targets, page) };
}
