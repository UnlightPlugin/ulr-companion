/**
 * 中間人（本機版）
 * =================
 * 一個只聽 127.0.0.1 的 WebSocket 伺服器，把兩個插件配成一對。
 * **規則不在這裡** —— 全部在 `rooms.ts`，這一層只做四件事：收訊息、解析、
 * 交給 `RoomRegistry`、把結果送出去。
 *
 * ⚠ **只綁 loopback。** §12 明訂不得暴露到區域網路或公網，而且這條在這裡
 * 比在 CDP 那邊更重要：CDP 只是讀，中間人是**會改變勝負的指令通道**。
 * `host` 刻意不開放成參數。
 *
 * ## 之後換成 ulgg 要動什麼
 *
 * **這個檔案整支丟掉，`rooms.ts` 與 `protocol.ts` 原封不動。** Cloudflare
 * Workers + Durable Objects 的形狀跟這裡幾乎一樣（一個 DO 實例 = 一間房，
 * 房號就是 `roomKey()`），差別只有「socket 從哪裡來」。客戶端那邊只換 URL。
 */

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ClientMessage } from "./protocol.js";
import { decode, encode } from "./protocol.js";
import { RoomRegistry } from "./rooms.js";
import { DEFAULT_LINK_PORT } from "./target.js";

// ⚠ 預設埠搬到 `target.ts` 了 —— 那支沒有 I/O，托盤與雲端的解析都要用到它，
// 而從這裡拿的話會連 `ws` 一起拉進去。這裡只負責再匯出，呼叫端不必改。
export { DEFAULT_LINK_PORT } from "./target.js";

/** 只聽本機。**不要**把它變成參數。 */
const LINK_HOST = "127.0.0.1";

/**
 * 埠被佔走了。
 *
 * ⚠ 這**不是錯誤情況**，是雙開的正常路徑：先開的那個插件當中間人，
 * 後開的收到這個就改當客戶端連上去。見 `startOrJoin()`。
 */
export class AddressInUseError extends Error {
  override readonly name = "AddressInUseError";
  constructor(readonly port: number) {
    super(`127.0.0.1:${port} 已經有人在聽了`);
  }
}

export interface BrokerOptions {
  port?: number;
  /** 每一則進出的訊息都丟出來，讓 CLI 可以印。**不含任何遊戲內容。** */
  onLog?: (line: string) => void;
}

export class LinkBroker {
  #server: WebSocketServer;
  #rooms = new RoomRegistry();
  #sockets = new Map<string, WebSocket>();
  #nextId = 1;
  #onLog: ((line: string) => void) | undefined;

  private constructor(server: WebSocketServer, onLog: ((line: string) => void) | undefined) {
    this.#server = server;
    this.#onLog = onLog;
    server.on("connection", (socket) => this.#onConnection(socket));
  }

  get port(): number {
    const address = this.#server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  /** 目前連著幾個插件。托盤要顯示它。 */
  get clients(): number {
    return this.#sockets.size;
  }

  /**
   * 開起來。埠被佔就丟 `AddressInUseError` —— 呼叫端要把它當成
   * 「別人已經是中間人了」，不是失敗。
   */
  static listen(options: BrokerOptions = {}): Promise<LinkBroker> {
    const port = options.port ?? DEFAULT_LINK_PORT;
    return new Promise<LinkBroker>((resolve, reject) => {
      const server = new WebSocketServer({ host: LINK_HOST, port });
      const onError = (err: NodeJS.ErrnoException): void => {
        server.close();
        reject(err.code === "EADDRINUSE" ? new AddressInUseError(port) : err);
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        // 監聽起來之後的錯誤不該讓插件崩掉 —— 中間人掛了只是功能退回單邊。
        server.on("error", (err) => options.onLog?.(`✗ 中間人出錯：${err.message}`));
        resolve(new LinkBroker(server, options.onLog));
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.#sockets.values()) socket.close();
    this.#sockets.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #onConnection(socket: WebSocket): void {
    const id = `c${this.#nextId++}`;
    this.#sockets.set(id, socket);
    this.#onLog?.(`  ＋ ${id} 連上（目前 ${this.#sockets.size} 個）`);

    socket.on("message", (data) => {
      const message = decode(String(data));
      // ⚠ 畸形訊息一律丟掉，不要斷線。側通道是唯一從外面進來的東西，
      // 而一則壞訊息把玩家的保護關掉，代價是他在對戰中失去它。
      if (message === null) return;
      this.#dispatch(id, message as ClientMessage);
    });
    socket.on("close", () => {
      this.#sockets.delete(id);
      this.#onLog?.(`  － ${id} 離線`);
      this.#send(this.#rooms.leave(id));
    });
    socket.on("error", () => {
      // close 會跟著來，統一在那裡收拾。
    });
  }

  #dispatch(id: string, message: ClientMessage): void {
    const out =
      message.t === "hello" ? this.#rooms.join(id, message) : this.#rooms.handle(id, message);
    if (message.t === "hello") this.#onLog?.(`  ${id} hello 房=${message.room.slice(0, 8)}…`);
    this.#send(out);
  }

  #send(out: readonly { to: string; message: unknown }[]): void {
    for (const item of out) {
      const socket = this.#sockets.get(item.to);
      if (socket === undefined || socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(encode(item.message as never));
      } catch {
        // 送不出去就算了 —— 客戶端那邊的硬底線會兜底。
      }
    }
  }
}
