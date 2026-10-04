/**
 * 不管插件接沒接上遊戲，都重新整理遊戲頁面
 * ======================================
 * `adapter.reloadGame()` 要先有一條接好的連線 —— 而玩家最需要重新整理的時候
 * （白畫面、斷線、重載的空檔）正是引擎還在「等 Phaser」、`adapter` 是 `null`
 * 的時候。這支自己開一條瀏覽器層級的連線，挑**頂層**頁面下 `Page.reload`，
 * 下完就收。
 *
 * 挑哪一頁：
 *
 * - 桌面版：`file://` 的外殼。遊戲 iframe 那個 target 收不了 `Page.reload`
 *   （-32000「only top-level targets」），而且重載外殼才會重新跟 Steam 要票證。
 * - 網頁版：網址是遊戲來源的那一頁。**不要**拿第一個 page —— 玩家可能開著
 *   別的分頁，重整錯了比沒反應更糟。
 */

import { CdpClient } from "./client.js";
import { isGameOriginUrl } from "./session.js";
import { discoverDebuggerUrl, WebSocketTransport } from "./transport.js";

interface RawTarget {
  targetId?: unknown;
  type?: unknown;
  url?: unknown;
}

/** 要重整的那一頁。桌面版外殼優先，其次是遊戲來源的頁面；都沒有回 `null`。 */
export function pickReloadTarget(targets: readonly RawTarget[]): string | null {
  const pages = targets.filter(
    (t): t is RawTarget & { targetId: string; url: string } =>
      t.type === "page" && typeof t.targetId === "string" && typeof t.url === "string",
  );
  const shell = pages.find((p) => p.url.startsWith("file://"));
  if (shell !== undefined) return shell.targetId;
  const game = pages.find((p) => isGameOriginUrl(p.url));
  return game?.targetId ?? null;
}

export class ReloadTargetNotFoundError extends Error {
  override readonly name = "ReloadTargetNotFoundError";
  constructor() {
    super("找不到遊戲的頁面可以重新整理");
  }
}

/** 對 `port` 上的遊戲頂層頁面下 `Page.reload`。 */
export async function reloadGamePage(options: {
  port: number;
  commandTimeoutMs?: number;
}): Promise<void> {
  const transport = await WebSocketTransport.connect(await discoverDebuggerUrl(options.port));
  const client = new CdpClient(transport, {
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
  });
  try {
    const res = await client.send<{ targetInfos?: RawTarget[] }>("Target.getTargets");
    const targetId = pickReloadTarget(res.targetInfos ?? []);
    if (targetId === null) throw new ReloadTargetNotFoundError();
    const attached = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new ReloadTargetNotFoundError();
    try {
      await client.send("Page.reload", undefined, attached.sessionId);
    } finally {
      await client
        .send("Target.detachFromTarget", { sessionId: attached.sessionId })
        .catch(() => {});
    }
  } finally {
    client.close();
  }
}
