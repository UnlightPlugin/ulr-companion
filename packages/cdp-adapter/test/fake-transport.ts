/**
 * 測試用的假 transport
 * ======================
 * `CdpTransport` 之所以是介面，就是為了這個檔案 —— 協定層真正會出錯的地方
 * （id 對應、錯誤轉譯、事件補送的競態、連線中途斷掉）都不需要活著的遊戲，
 * 但用真 WebSocket 測的話每一項都得靠時序碰運氣。
 */

import type { CdpTransport } from "@ulr/cdp-adapter";

export interface SentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** 收到某個 method 時要怎麼回。回傳 result，或丟出 `{code, message}` 當協定錯誤。 */
export type Responder = (msg: SentMessage) => unknown;

export class FakeTransport implements CdpTransport {
  readonly sent: SentMessage[] = [];
  #messageHandlers: ((data: string) => void)[] = [];
  #closeHandlers: ((reason: string) => void)[] = [];
  #responders = new Map<string, Responder>();
  #closed = false;

  /** 之後收到這個 method 就用 `responder` 回應。 */
  respond(method: string, responder: Responder): this {
    this.#responders.set(method, responder);
    return this;
  }

  send(data: string): void {
    if (this.#closed) throw new Error("transport 已關閉");
    const msg = JSON.parse(data) as SentMessage;
    this.sent.push(msg);

    const responder = this.#responders.get(msg.method);
    if (responder === undefined) return; // 沒設就是不回，用來測逾時

    // 用 queueMicrotask 模擬「回應一定是非同步到達」。同步回覆會讓
    // pending map 還沒寫進去就被查詢，測出來的行為跟真實不一樣。
    queueMicrotask(() => {
      try {
        this.emitResponse(msg.id, responder(msg));
      } catch (err) {
        const e = err as { code?: number; message?: string };
        this.emitError(msg.id, e.code ?? -32000, e.message ?? String(err));
      }
    });
  }

  emitResponse(id: number, result: unknown, sessionId?: string): void {
    this.#deliver({ id, result, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  emitError(id: number, code: number, message: string): void {
    this.#deliver({ id, error: { code, message } });
  }

  emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#deliver({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  /** 直接送一段原始字串，用來測「對方送了不是 JSON 的東西」。 */
  emitRaw(data: string): void {
    for (const h of this.#messageHandlers) h(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    this.dropConnection("測試主動關閉");
  }

  /** 模擬連線斷掉（不是我們關的）。 */
  dropConnection(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const h of this.#closeHandlers) h(reason);
  }

  #deliver(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const h of this.#messageHandlers) h(data);
  }
}
