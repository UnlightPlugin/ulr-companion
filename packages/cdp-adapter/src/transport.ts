/**
 * 真正的傳輸：HTTP 探索 + WebSocket
 * ===================================
 * 這個檔案是整包唯一碰到網路的地方，也是唯一不容易單元測試的地方 ——
 * 所以它刻意只做「接上去」，不含任何判斷邏輯。
 *
 * §12：CDP 只允許 127.0.0.1。`assertLoopback` 會擋掉任何非 loopback 的位址，
 * 包含從 `/json/version` 回來的 `webSocketDebuggerUrl` —— 那是遠端給的字串，
 * 不能因為「是遊戲回的」就當成可信。
 */

import { WebSocket } from "ws";
import { DEBUG_HOST } from "./constants.js";
import type { CdpTransport } from "./protocol.js";

/** 只有這些主機名算 loopback。IPv6 的 ::1 在 URL 裡會寫成 [::1]。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class NonLoopbackTargetError extends Error {
  override readonly name = "NonLoopbackTargetError";
  constructor(url: string) {
    // ⚠ 不要把完整 URL 放進訊息 —— CDP URL 含可用來接管瀏覽器的 token，
    // §12 明訂不得記錄。只留主機名，排查夠用了。
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = "(無法解析)";
    }
    super(`CDP 目標不是 loopback：${host}。§12 只允許 127.0.0.1。`);
  }
}

export class DebuggerNotFoundError extends Error {
  override readonly name = "DebuggerNotFoundError";
  constructor(port: number, cause: string) {
    super(
      `連不上 127.0.0.1:${port} 的 debug port（${cause}）。` +
        `檢查順序：spawn 時有沒有清掉 ELECTRON_RUN_AS_NODE → ` +
        `app.asar 是不是視窗版（153KB 那個是網頁版，開完瀏覽器就自己退出）→ port 有沒有被佔 → ` +
        `這個埠有沒有落在 Windows 的保留範圍（netsh interface ipv4 show excludedportrange protocol=tcp）。` +
        `最後那項的症狀特別像「參數被忽略」：瀏覽器照常開，但完全不會產生 DevToolsActivePort。`,
    );
  }
}

export function assertLoopback(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NonLoopbackTargetError(url);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && !LOOPBACK_HOSTS.has(parsed.host)) {
    throw new NonLoopbackTargetError(url);
  }
}

/**
 * 問 debug port 要瀏覽器層級的 WebSocket 位址。
 *
 * 用 `/json/version` 而不是 `/json/list` 的第一筆：後者是分頁清單，順序不保證，
 * 而且遊戲的 Electron 會有多個 target。我們要的是瀏覽器層級的連線，之後再用
 * `Target.*` 自己挑，這樣才不會挑到 devtools 或別人開的分頁。
 */
export async function discoverDebuggerUrl(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let payload: unknown;
  try {
    const res = await fetchImpl(`http://${DEBUG_HOST}:${port}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    throw new DebuggerNotFoundError(port, err instanceof Error ? err.message : String(err));
  }

  const url =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)["webSocketDebuggerUrl"]
      : undefined;

  if (typeof url !== "string" || url.length === 0) {
    throw new DebuggerNotFoundError(port, "回應裡沒有 webSocketDebuggerUrl");
  }

  assertLoopback(url);
  return url;
}

/**
 * `ws` 的薄包裝。
 *
 * 用 `ws` 而不是 Node 的全域 `WebSocket`：全域版本要到 Node 22 才穩定，
 * 而這個 repo 的最低支援版是 20.19（CI 就跑那版）。
 */
export class WebSocketTransport implements CdpTransport {
  #ws: WebSocket;
  #messageHandlers: ((data: string) => void)[] = [];
  #closeHandlers: ((reason: string) => void)[] = [];
  #closedReason: string | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : String(data);
      for (const h of this.#messageHandlers) h(text);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.#fireClose(`code ${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}`);
    });
    ws.on("error", (err: Error) => {
      this.#fireClose(err.message);
    });
  }

  static async connect(debuggerUrl: string): Promise<WebSocketTransport> {
    assertLoopback(debuggerUrl);
    const ws = new WebSocket(debuggerUrl, {
      // 遊戲的封包不大，但 CDP 的 Runtime.evaluate 回應（例如整張 cc_asset）
      // 可以很大。預設上限會直接砍掉連線。
      maxPayload: 256 * 1024 * 1024,
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    return new WebSocketTransport(ws);
  }

  send(data: string): void {
    this.#ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.#closedReason !== null) {
      handler(this.#closedReason);
      return;
    }
    this.#closeHandlers.push(handler);
  }

  close(): void {
    this.#ws.close();
  }

  #fireClose(reason: string): void {
    // close 與 error 兩個事件都可能來，只認第一次。
    if (this.#closedReason !== null) return;
    this.#closedReason = reason;
    for (const h of this.#closeHandlers) h(reason);
    this.#closeHandlers = [];
  }
}
