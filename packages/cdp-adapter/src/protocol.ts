/**
 * CDP 線路格式與傳輸抽象
 * ========================
 * 這裡只有「線上跑的是什麼形狀」與「怎麼把位元組送出去」，沒有任何遊戲知識。
 *
 * 傳輸被抽成介面而不是直接用 WebSocket，是為了讓上面的協定邏輯（id 對應、
 * session 路由、錯誤轉譯）可以完全用假 transport 測 —— 那些才是會出錯的地方，
 * 而它們不該需要一個活著的遊戲才能驗證。
 */

/** 送出去的一則命令。`sessionId` 只在 flatten 模式下對子 target 發話時才有。 */
export interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** 收回來的一則訊息：命令的回應（有 `id`），或是事件（有 `method`）。 */
export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
  sessionId?: string;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export type CdpIncoming = CdpResponse | CdpEvent;

export function isCdpResponse(msg: CdpIncoming): msg is CdpResponse {
  return typeof (msg as CdpResponse).id === "number";
}

/**
 * 傳輸層。實作只要能雙向送字串、並在斷線時通知即可。
 *
 * 約定：`close()` 之後必須觸發一次 close handler（不論是誰關的），否則
 * `CdpClient` 等在那裡的 Promise 會永遠不 settle。
 */
export interface CdpTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** 對方回了 `error` 欄位。保留 CDP 自己的錯誤碼，排查時比字串好用。 */
export class CdpProtocolError extends Error {
  override readonly name = "CdpProtocolError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: string,
  ) {
    super(`${method} 失敗 [${code}] ${message}${data === undefined ? "" : ` (${data})`}`);
  }
}

/** 連線在命令還沒回來之前就斷了。 */
export class CdpConnectionClosedError extends Error {
  override readonly name = "CdpConnectionClosedError";
  constructor(reason: string) {
    super(`CDP 連線已關閉：${reason}`);
  }
}

/** 命令送出後超過期限沒有回應。 */
export class CdpTimeoutError extends Error {
  override readonly name = "CdpTimeoutError";
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} 超過 ${timeoutMs}ms 沒有回應`);
  }
}
