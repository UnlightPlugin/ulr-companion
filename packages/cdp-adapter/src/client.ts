/**
 * CDP 客戶端 —— id 對應、事件派送、session 路由
 * ================================================
 * 刻意不依賴任何 CDP 函式庫。我們只用到協定的一小塊（Runtime / Page 各幾個
 * 方法），而 puppeteer/playwright 那類套件會把整個瀏覽器下載與 target 管理
 * 一起拖進來 —— 對一個要打包給玩家的 Electron app 來說太肥。
 * 5i 在 `unlight_crawler` 用純 requests + websockets 也是同一個判斷。
 */

import type { CdpEvent, CdpIncoming, CdpResponse, CdpTransport } from "./protocol.js";
import {
  CdpConnectionClosedError,
  CdpProtocolError,
  CdpTimeoutError,
  isCdpResponse,
} from "./protocol.js";

/** 命令預設等多久。遊戲載入時 CDP 有時會鈍幾秒，10 秒是實測留的餘裕。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpClientOptions {
  /** 每則命令的逾時。設 0 表示不設限（測試用）。 */
  commandTimeoutMs?: number;
}

export class CdpClient {
  #transport: CdpTransport;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<EventHandler>>();
  #closed: string | null = null;
  #timeoutMs: number;

  constructor(transport: CdpTransport, options: CdpClientOptions = {}) {
    this.#transport = transport;
    this.#timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    transport.onMessage((data) => {
      this.#receive(data);
    });
    transport.onClose((reason) => {
      this.#onClose(reason);
    });
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /**
   * 送一則命令並等回應。
   *
   * 回傳型別是呼叫端宣告的 —— CDP 的回應形狀由協定版本決定，我們沒有辦法在
   * 編譯期驗證，所以取用欄位前一律要自己檢查（見 `game-context.ts` 的做法）。
   */
  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed !== null) {
      throw new CdpConnectionClosedError(this.#closed);
    }

    const id = this.#nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message["params"] = params;
    if (sessionId !== undefined) message["sessionId"] = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer =
        this.#timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new CdpTimeoutError(method, this.#timeoutMs));
            }, this.#timeoutMs)
          : (undefined as unknown as ReturnType<typeof setTimeout>);

      // Node 的 timer 會讓 process 活著；CDP 只是我們在等的東西之一，
      // 不該因為有個逾時計時器就讓 CLI 停不下來。
      timer?.unref?.();

      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.#transport.send(JSON.stringify(message));
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 訂閱一種事件。回傳的函式呼叫一次即取消訂閱。 */
  on(method: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#handlers.delete(method);
    };
  }

  /**
   * 等某個事件出現，可加條件過濾。
   *
   * ⚠ 只在「確定事件還沒發生」時才用得對。要等的東西可能**已經**送過來時
   * （例如 `Runtime.enable` 之前就存在的 execution context），必須改成
   * 先掛 `on()` 蒐集、再觸發動作 —— `game-context.ts` 就是因為這個競態
   * 才不能直接用這支。
   */
  waitFor(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      const off = this.on(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    this.#transport.close();
  }

  #receive(data: string): void {
    let msg: CdpIncoming;
    try {
      msg = JSON.parse(data) as CdpIncoming;
    } catch {
      // 對方送了不是 JSON 的東西。丟掉比讓整條連線倒掉好 —— 我們不是唯一
      // 可能連上這個 port 的程式。
      return;
    }

    if (isCdpResponse(msg)) {
      this.#settle(msg);
      return;
    }
    this.#dispatch(msg as CdpEvent);
  }

  #settle(msg: CdpResponse): void {
    const pending = this.#pending.get(msg.id);
    if (pending === undefined) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error !== undefined) {
      pending.reject(
        new CdpProtocolError(pending.method, msg.error.code, msg.error.message, msg.error.data),
      );
      return;
    }
    pending.resolve(msg.result ?? {});
  }

  #dispatch(msg: CdpEvent): void {
    const handlers = this.#handlers.get(msg.method);
    if (handlers === undefined) return;
    const params = msg.params ?? {};
    // 複製一份再走訪：handler 內部很可能會取消自己的訂閱（waitFor 就是），
    // 直接迭代原 Set 會漏掉後面的 handler。
    for (const handler of [...handlers]) {
      try {
        handler(params, msg.sessionId);
      } catch {
        // 單一訂閱者出錯不該影響其他訂閱者，也不該讓整條連線停擺。
        // §9.1：注入相關的失敗一律降級，不得讓遊戲或插件崩潰。
      }
    }
  }

  #onClose(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new CdpConnectionClosedError(reason));
    }
    this.#handlers.clear();
  }
}
