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
import { redactUrl } from "./redact.js";

export interface PageTarget {
  targetId: string;
  /** 已去識別化。**不要**保留原始 URL，遊戲的 URL 帶 steamid 與 token。 */
  safeUrl: string;
  title: string;
}

export interface GamePageSession extends PageTarget {
  sessionId: string;
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

interface RawTargetInfo {
  targetId?: unknown;
  type?: unknown;
  url?: unknown;
  title?: unknown;
  attached?: unknown;
}

/** devtools 自己、擴充功能、空白頁 —— 都不是遊戲。 */
function isPlausibleGamePage(url: string): boolean {
  if (url === "" || url === "about:blank") return false;
  return !/^(devtools|chrome|chrome-extension|edge):/i.test(url);
}

export function selectGamePage(targets: readonly RawTargetInfo[]): PageTarget | null {
  const pages: { raw: RawTargetInfo; url: string }[] = [];
  for (const t of targets) {
    if (t.type !== "page") continue;
    if (typeof t.targetId !== "string") continue;
    const url = typeof t.url === "string" ? t.url : "";
    if (!isPlausibleGamePage(url)) continue;
    pages.push({ raw: t, url });
  }

  if (pages.length === 0) return null;

  // 桌面版的殼是 file://…/index.html，它把遊戲載在 iframe 裡 —— 所以 page
  // target 就是那個殼，不是遊戲網址本身。網頁版則直接是 https 的遊戲頁。
  // 兩種都可能，優先取 file:// 的殼（桌面版），否則取第一個。
  const shell = pages.find((p) => p.url.startsWith("file://"));
  const chosen = shell ?? pages[0];
  if (chosen === undefined) return null;

  return {
    targetId: chosen.raw.targetId as string,
    safeUrl: redactUrl(chosen.url),
    title: typeof chosen.raw.title === "string" ? chosen.raw.title : "",
  };
}

export function toPageTargets(targets: readonly RawTargetInfo[]): PageTarget[] {
  return targets
    .filter((t) => t.type === "page" && typeof t.targetId === "string")
    .map((t) => ({
      targetId: t.targetId as string,
      safeUrl: redactUrl(typeof t.url === "string" ? t.url : ""),
      title: typeof t.title === "string" ? t.title : "",
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

  return { ...page, sessionId: attached.sessionId };
}
