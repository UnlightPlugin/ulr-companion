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
import {
  decodeQueue,
  encodeQueue,
  isQueueCompatible,
  MatchQueue,
} from "@ulr/arbiter-link/match-queue";
import { LINK_PROTOCOL_VERSION } from "@ulr/arbiter-link/protocol";
import {
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  CLOSE_WRONG_ROOM,
  COUNT_SUFFIX,
  COUNT_TAG_PARAM,
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
  /**
   * 這條線是「只看不排」的（`q-watch`）。`null` = 不是。
   *
   * ⚠⚠ **看的人永遠不進 `MatchQueue`。** 那個類別是配對規則，把看的人放進去
   * 會讓他被湊成一對 —— 而他人在大廳，根本不知道自己被配走了。
   *
   * ⚠ 要進 attachment：hibernation 醒來時我們得知道哪幾條線是看的人，
   * 不然人數就再也推不出去了（而症狀是「別人排隊我這邊不會動」，
   * 跟輪詢版本壞掉的樣子一模一樣）。
   */
  watch: { tag: string | null } | null;
}

export class MatchQueueRoom extends DurableObject {
  #queue: MatchQueue | null = null;
  #sockets = new Map<string, WebSocket>();
  #buckets = new Map<string, TokenBucket>();
  /** 每個「看的人」上一次收到的數字。只拿來去重，見 `#broadcastCounts`。 */
  #lastCount = new Map<string, number>();
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
        // ⚠ 看的人那一格要原封留著 —— 它不是排隊狀態的一部分，但少了它，
        // 下一次 hibernation 醒來就認不出誰是看的人。
        watch: att.watch ?? null,
      } satisfies QueueAttachment);
    }
  }

  /**
   * 把最新的人數推給**看的人**。
   *
   * ⚠⚠ **每一個看的人拿到的數字可能不一樣**：他們各自帶著自己的規則標籤，
   * 而我們只數同一份規則的人。共用一個數字的話，用別份規則的人會看到一個
   * 他永遠配不到的數字 —— 那比 0 還糟。
   *
   * ⚠ 這支要在**任何會改到排隊人數的事情之後**叫：有人 hello、有人取消、
   * 有人斷線、有人被配走。漏掉任何一條的症狀都是「別人動了我這邊不會動」，
   * 而那正是這整條推播要修掉的東西。
   */
  #broadcastCounts(queue: MatchQueue): void {
    for (const [id, ws] of this.#sockets) {
      const att = this.#read(ws);
      const watch = att?.watch;
      if (watch === null || watch === undefined) continue;
      const waiting = queue.waitingWithTag(watch.tag);
      // ⚠ 沒變就不送。一次 `q-hello` 會連著改好幾件事（進佇列、湊成一對），
      // 每一件都廣播的話，一個人按下快速比賽會讓大廳裡每個人收到三四則
      // **內容一樣**的訊息 —— 那是白付的頻寬，而且畫面會閃。
      //
      // ⚠ 這一格是純記憶體的（不進 attachment）。hibernation 醒來之後它是空的，
      // 於是第一次廣播會重送一個大家已經知道的數字 —— 無害，而把它塞進
      // attachment 反而要為了一個「省一則訊息」的最佳化多寫一次持久化。
      if (this.#lastCount.get(id) === waiting) continue;
      this.#lastCount.set(id, waiting);
      try {
        ws.send(encodeQueue({ t: "q-count", waiting }));
      } catch {
        // 送不出去就算了 —— 那條線多半正在關，close 事件會收拾它。
      }
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
    /**
     * 「這一檔現在幾個人在等」。
     *
     * ⚠⚠ **這是這台伺服器唯一會說出去的佇列狀態，而它是刻意開的例外。**
     * `/health` 那條的規則是「不回任何跟房間有關的東西」，理由是那可以拿來推測
     * 「現在有誰在打」。這一條不一樣，兩點：
     *
     *   1. 它是**一檔的人數**，不是身分、不是誰在跟誰 —— 而且鍵是雜湊，
     *      這台伺服器自己也不知道那一檔屬於哪份規則
     *   2. **遊戲自己就公開這個數字**（亞歷山卓城的「COST54:N 位玩家等待中」）——
     *      我們在迪特赫姆重現的正是那個畫面
     *
     * 少了它，玩家看到的是一顆按下去不知道有沒有人的按鈕 —— 而「沒人排隊」與
     * 「插件壞了」在那個畫面上長得一模一樣。
     */
    if (request.headers.get("Upgrade") !== "websocket") {
      const url = new URL(request.url);
      if (url.pathname.endsWith(COUNT_SUFFIX)) {
        // ⚠ 帶了標籤就**只數同一份規則的人**。少了這一關，畫面上的「1 位玩家
        // 等待中」可能是一個規則對不起來、永遠配不到的人 —— 而玩家會一直等。
        const tag = url.searchParams.get(COUNT_TAG_PARAM);
        return Response.json({ waiting: this.#hydrate().waitingWithTag(tag) });
      }
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
    server.serializeAttachment({ id, key, waiter: null, watch: null } satisfies QueueAttachment);

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
    if ((msg.t === "q-hello" || msg.t === "q-watch") && msg.key !== att.key) {
      ws.close(CLOSE_WRONG_ROOM, "wrong queue");
      return;
    }

    const queue = this.#hydrate();

    /**
     * 「只看不排」。**這條路完全不碰 `MatchQueue`** —— 看的人不參與配對。
     *
     * ⚠ 版本不合也要講，跟 `q-hello` 一樣：不然舊中間人配新插件時，插件會
     * 一直等一則永遠不會來的 `q-count`，而畫面上只是人數不動。
     */
    if (msg.t === "q-watch") {
      if (!isQueueCompatible(msg.v)) {
        ws.send(
          encodeQueue({
            t: "q-incompatible",
            v: LINK_PROTOCOL_VERSION,
            reason: `協定版本 ${msg.v} 與中間人的 ${LINK_PROTOCOL_VERSION} 不相容`,
          }),
        );
        return;
      }
      const tag = msg.tag ?? null;
      // ⚠⚠ **同一條線先 `q-hello` 再 `q-watch`，要真的把他從佇列裡拿掉。**
      // 我們自己的客戶端不會這樣（排隊跟看人數是兩條各自的線），但只把
      // attachment 的 `waiter` 清成 null 而不動 `MatchQueue` 的話，他會留在
      // 佇列裡繼續被湊成一對 —— 而他的對手會等一間永遠不會開的房。
      const left = att.waiter === null ? [] : queue.leave(att.id, "cancel");
      ws.serializeAttachment({
        id: att.id,
        key: att.key,
        waiter: null,
        watch: { tag },
      } satisfies QueueAttachment);
      // 他剛連上，第一個數字要立刻給 —— 不然畫面在第一個人進出之前是空的。
      const waiting = queue.waitingWithTag(tag);
      this.#lastCount.set(att.id, waiting);
      ws.send(encodeQueue({ t: "q-count", waiting }));
      if (left.length > 0) {
        this.#persist(queue);
        this.#send(left);
      }
      // ⚠ 別人也要跟著更新 —— 上面那一段可能剛把一個人從佇列裡拿掉。
      this.#broadcastCounts(queue);
      return;
    }

    const out = msg.t === "q-hello" ? queue.join(att.id, msg) : queue.handle(att.id, msg);

    if (msg.t === "q-hello") {
      // 只數「真的湊成一對」—— 理由同 room.ts：有人連上來不代表這個服務
      // 對他產生了作用。⚠ 鍵是截短過的雜湊，這一行認不出任何人也認不出規則。
      const paired = queue.waiterOf(att.id)?.partner !== null;
      console.log(`  ${att.id} q-hello 鍵=${shortRoom(att.key)}${paired ? " ✓配對成立" : ""}`);
    }

    this.#persist(queue);
    this.#send(out);
    // ⚠⚠ **這一行就是「立即反應」。** `q-hello`／`q-cancel`／`q-reject` 每一則
    // 都會改到「還在等的人有幾個」，而大廳裡看的人得**現在**知道 —— 少了它，
    // 他要等下一輪輪詢（最久 15 秒），那正是玩家 2026-08-20 回報的兩句。
    this.#broadcastCounts(queue);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.#read(ws);
    if (att === null) return;
    const queue = this.#hydrate();
    this.#sockets.delete(att.id);
    this.#buckets.delete(att.id);
    this.#lastCount.delete(att.id);
    // 對手要立刻知道人跑了，否則他會一直等一間永遠不會開的房。
    const out = queue.leave(att.id, "gone");
    this.#persist(queue);
    this.#send(out);
    // ⚠ 關線也要推 —— 玩家直接關掉插件（不送 `q-cancel`）走的就是這條，
    // 而那時大廳裡的人數必須掉下來。
    this.#broadcastCounts(queue);
    console.log(`- ${att.id} 離開佇列 鍵=${shortRoom(att.key)}`);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
