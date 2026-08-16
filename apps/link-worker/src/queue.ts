/**
 * 一條配對佇列 = 一個 Durable Object
 * ====================================
 * 跟 `room.ts` 同一個模式，職責也一樣：**收訊息、解析、交給 `MatchQueue`、
 * 把結果送出去**。規則一條都不在這裡。
 *
 * ## 配對鍵就是路由
 *
 * `getByName(配對鍵)` 保證全世界同一個鍵拿到同一個實例。而配對鍵是
 * `matchKey(規則 hash, 頻道, 3vs3, COST 上限)` 算出來的 ——
 * **規則不一樣的人算出不同的鍵，落在不同的物件，物理上就配不到對方**。
 * 中間人不需要比對任何東西，也看不到規則內容。
 *
 * ## ⚠ Hibernation
 *
 * 排隊等對手是**天生會閒置很久**的（比對戰中的房間久得多），所以這裡比
 * `LinkRoom` 更容易被移出記憶體。狀態一樣掛在各自的 WebSocket 上
 * （`serializeAttachment`），醒來用 `MatchQueue.restore()` 原封不動塞回去。
 *
 * 漏掉的話症狀是：兩個人明明都在排隊，卻永遠配不到 —— 因為醒來的佇列
 * 認為自己是空的，而兩邊都不會再送一次 `q-hello`。
 */

import { DurableObject } from "cloudflare:workers";
import type { Waiter } from "@ulr/arbiter-link/match-queue";
import { decodeQueue, encodeQueue, MatchQueue } from "@ulr/arbiter-link/match-queue";
import {
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  CLOSE_WRONG_ROOM,
  MAX_MESSAGE_BYTES,
  shortRoom,
  TokenBucket,
} from "./guard.js";

interface QueueAttachment {
  id: string;
  /** 這條線屬於哪條佇列。來自網址，不是客戶端說了算。 */
  key: string;
  /**
   * 還沒送 `q-hello` 之前是 `null` —— 那時只是一條連著的線，還不是排隊的人。
   *
   * ⚠ `tried`（驗算沒過、不要再配的對象）**也要進來**。漏掉它的話，
   * hibernation 醒來之後那張清單是空的，兩個規則對不起來的人會立刻被重新
   * 湊成一對 —— 而那正是無窮重配迴圈。
   */
  waiter: {
    partner: string | null;
    role: Waiter["role"];
    token: string | null;
    tag: string;
    tried: string[];
  } | null;
}

export class MatchQueueRoom extends DurableObject {
  #queue: MatchQueue | null = null;
  #sockets = new Map<string, WebSocket>();
  #buckets = new Map<string, TokenBucket>();
  #nextId = 1;

  #hydrate(): MatchQueue {
    if (this.#queue !== null) return this.#queue;

    const queue = new MatchQueue();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.#read(ws);
      if (att === null) continue;
      this.#sockets.set(att.id, ws);
      if (!this.#buckets.has(att.id)) {
        this.#buckets.set(att.id, new TokenBucket(20, 5, Date.now()));
      }
      if (att.waiter !== null) {
        queue.restore({
          id: att.id,
          partner: att.waiter.partner,
          role: att.waiter.role,
          token: att.waiter.token,
          // 舊格式的 attachment 沒有這兩個欄位（醒來時可能還在）。
          tag: att.waiter.tag ?? "",
          tried: att.waiter.tried ?? [],
        });
      }
      const n = Number(att.id.slice(1));
      if (Number.isInteger(n) && n >= this.#nextId) this.#nextId = n + 1;
    }
    this.#queue = queue;
    return queue;
  }

  #read(ws: WebSocket): QueueAttachment | null {
    try {
      const raw: unknown = ws.deserializeAttachment();
      if (typeof raw !== "object" || raw === null) return null;
      return raw as QueueAttachment;
    } catch {
      return null;
    }
  }

  /** ⚠ 任何會改到排隊狀態的訊息之後都要叫，理由同 `room.ts` 的 `#persist`。 */
  #persist(queue: MatchQueue): void {
    for (const [id, ws] of this.#sockets) {
      const att = this.#read(ws);
      if (att === null) continue;
      const w = queue.waiterOf(id);
      ws.serializeAttachment({
        id,
        key: att.key,
        waiter:
          w === null
            ? null
            : { partner: w.partner, role: w.role, token: w.token, tag: w.tag, tried: w.tried },
      } satisfies QueueAttachment);
    }
  }

  #send(out: readonly { to: string; message: unknown }[]): void {
    for (const item of out) {
      const ws = this.#sockets.get(item.to);
      if (ws === undefined) continue;
      try {
        ws.send(encodeQueue(item.message as never));
      } catch {
        // 送不出去就算了 —— 客戶端有自己的逾時。
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const key = new URL(request.url).pathname.split("/").pop() ?? "";
    this.#hydrate();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const id = `c${this.#nextId++}`;
    this.#sockets.set(id, server);
    this.#buckets.set(id, new TokenBucket(20, 5, Date.now()));
    server.serializeAttachment({ id, key, waiter: null } satisfies QueueAttachment);

    console.log(`+ ${id} 排隊 鍵=${shortRoom(key)}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.#read(ws);
    if (att === null) return;

    // 先量大小、再算流量、最後才 decode（順序的理由見 room.ts）
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (raw.length > MAX_MESSAGE_BYTES) {
      ws.close(CLOSE_TOO_BIG, "message too large");
      return;
    }
    const bucket = this.#buckets.get(att.id);
    if (bucket !== undefined && !bucket.take(Date.now())) {
      ws.close(CLOSE_TOO_FAST, "too many messages");
      return;
    }

    const msg = decodeQueue(raw);
    if (msg === null) return;

    // 佇列鍵由網址決定。客戶端說了別條佇列就是它連錯了 —— 斷線讓它重連，
    // 不能默默照做（否則規則不同的人會被配在一起，那正是這整套要防的事）。
    if (msg.t === "q-hello" && msg.key !== att.key) {
      ws.close(CLOSE_WRONG_ROOM, "wrong queue");
      return;
    }

    const queue = this.#hydrate();
    const out = msg.t === "q-hello" ? queue.join(att.id, msg) : queue.handle(att.id, msg);

    if (msg.t === "q-hello") {
      // 只數「真的湊成一對」—— 理由同 room.ts：有人連上來不代表這個服務
      // 對他產生了作用。⚠ 鍵是截短過的雜湊，這一行認不出任何人也認不出規則。
      const paired = queue.waiterOf(att.id)?.partner !== null;
      console.log(`  ${att.id} q-hello 鍵=${shortRoom(att.key)}${paired ? " ✓配對成立" : ""}`);
    }

    this.#persist(queue);
    this.#send(out);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.#read(ws);
    if (att === null) return;
    const queue = this.#hydrate();
    this.#sockets.delete(att.id);
    this.#buckets.delete(att.id);
    // 對手要立刻知道人跑了，否則他會一直等一間永遠不會開的房。
    const out = queue.leave(att.id, "gone");
    this.#persist(queue);
    this.#send(out);
    console.log(`- ${att.id} 離開佇列 鍵=${shortRoom(att.key)}`);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
