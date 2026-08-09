/**
 * 一間房 = 一個 Durable Object
 * ==============================
 * 這一支對應本機的 `broker.ts`，職責一模一樣：**收訊息、解析、交給
 * `RoomRegistry`、把結果送出去**。規則一條都沒有搬過來 —— 那些全部還在
 * `rooms.ts` 裡，兩邊跑的是同一份程式碼，被同一份測試釘住。
 *
 * 差別只有三個，而且都是 Durable Object 的性質造成的：
 *
 * | | 本機 broker | 這裡 |
 * | --- | --- | --- |
 * | 房間怎麼分 | 一個 process 管所有房，靠 `Member.room` 欄位分 | **一個 DO 就是一間房**，`getByName(房號)` 保證全世界同一個房號拿到同一份 |
 * | 連線識別 | 自己遞增的 `c1`、`c2` | 一樣，但**存在 WebSocket 身上** |
 * | 記憶 | process 活著就在 | **會被清掉**，醒來要自己重建 |
 *
 * ## ⚠ Hibernation：這支唯一真正困難的地方
 *
 * 兩條 WebSocket 連著但一陣子沒訊息時，Cloudflare 會把這個物件**移出記憶體**
 * （連線本身由平台保管著，玩家不會斷線）。下一則訊息進來時會建一個**全新的
 * `LinkRoom`** 來處理 —— `#registry` 是空的，兩個人的 prefs 與 ready 全沒了。
 *
 * 不處理的話症狀極難查：對戰前幾分鐘一切正常，玩家想久一點（卡在選牌）之後，
 * 約定秒數突然變回 30 秒 —— 因為醒來的中間人認為這間房是空的。
 *
 * 解法是把每個連線的狀態**存在那條 WebSocket 自己身上**（`serializeAttachment`，
 * 上限 16 KB，我們用不到 200 bytes）—— 那是唯一跨得過 hibernation 的地方。
 * 醒來時從 `ctx.getWebSockets()` 讀回來，用 `RoomRegistry.restore()` 原封不動
 * 塞回去，**不是重新 join**（理由見 `rooms.ts` 那支的註解）。
 */

import { DurableObject } from "cloudflare:workers";
import type { ClientMessage, LinkPrefs } from "@ulr/arbiter-link/protocol";
import { decode, encode } from "@ulr/arbiter-link/protocol";
import { RoomRegistry } from "@ulr/arbiter-link/rooms";
import {
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  CLOSE_WRONG_ROOM,
  MAX_MESSAGE_BYTES,
  shortRoom,
  TokenBucket,
} from "./guard.js";

/** 掛在 WebSocket 上、跨得過 hibernation 的那份狀態。 */
interface Attachment {
  /** 這個連線在 `RoomRegistry` 裡的 id。**必須跨 hibernation 穩定**，所以存這裡。 */
  id: string;
  /** 這條線屬於哪間房。來自網址，不是客戶端說了算。 */
  room: string;
  /**
   * 成員狀態。**還沒送 `hello` 之前是 `null`** —— 那時候他只是一條連著的線，
   * 還不是房裡的成員。分不清這兩者的話，一個連上來就閒置到 hibernation 的
   * 連線會在醒來後變成一個 prefs 是空的「成員」，把對手的協商結果算壞。
   */
  member: { prefs: LinkPrefs; ready: boolean } | null;
}

export class LinkRoom extends DurableObject {
  /** 醒來後才重建。`null` = 這一輪還沒重建過。 */
  #registry: RoomRegistry | null = null;
  #sockets = new Map<string, WebSocket>();
  /** 流量桶。刻意只放記憶體，理由見 `guard.ts` 的 `TokenBucket`。 */
  #buckets = new Map<string, TokenBucket>();
  #nextId = 1;

  /**
   * 把記憶重建成 hibernation 之前的樣子。**每個進入點都要先叫它。**
   *
   * 便宜：一間房最多兩個人（`ROOM_CAPACITY`），而且只有醒來的第一次真的做事。
   */
  #hydrate(): RoomRegistry {
    if (this.#registry !== null) return this.#registry;
    const registry = new RoomRegistry();
    this.#sockets.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.#read(ws);
      if (att === null) continue;
      this.#sockets.set(att.id, ws);
      if (att.member !== null) {
        registry.restore({
          id: att.id,
          room: att.room,
          prefs: att.member.prefs,
          ready: att.member.ready,
        });
      }
      // 醒來後新連線的 id 不能跟既有的撞：`c12` → 下一個從 13 開始。
      const n = Number(att.id.slice(1));
      if (Number.isInteger(n) && n >= this.#nextId) this.#nextId = n + 1;
    }
    this.#registry = registry;
    return registry;
  }

  #read(ws: WebSocket): Attachment | null {
    try {
      const raw: unknown = ws.deserializeAttachment();
      if (typeof raw !== "object" || raw === null) return null;
      return raw as Attachment;
    } catch {
      return null;
    }
  }

  /**
   * 把 `RoomRegistry` 裡的最新狀態寫回每條 WebSocket 上。
   *
   * ⚠ **任何會改到成員狀態的訊息之後都要叫它**（`prefs`、`room`、`ready` 都會變）。
   * 漏掉的話當下完全正常，要到 hibernation 之後才會用舊狀態醒來 —— 而那時候
   * 已經沒有任何線索指向這裡。
   */
  #persist(registry: RoomRegistry): void {
    for (const [id, ws] of this.#sockets) {
      const att = this.#read(ws);
      if (att === null) continue;
      const member = registry.memberOf(id);
      ws.serializeAttachment({
        id,
        room: att.room,
        member: member === null ? null : { prefs: member.prefs, ready: member.ready },
      } satisfies Attachment);
    }
  }

  #send(out: readonly { to: string; message: unknown }[]): void {
    for (const item of out) {
      const ws = this.#sockets.get(item.to);
      if (ws === undefined) continue;
      try {
        ws.send(encode(item.message as never));
      } catch {
        // 送不出去就算了 —— 客戶端那邊的硬底線會兜底（跟本機 broker 同一條理由）。
      }
    }
  }

  /**
   * 有人要連進來。**只接 WebSocket 升級**，其他一律 426。
   *
   * ⚠ 這裡是 `fetch()` 而不是 RPC：WebSocket 升級必須回一個 101 的 `Response`，
   * 那是 RPC 回不了的東西。
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // 房號來自網址（Worker 已經驗過格式），**不是客戶端自己說了算**。
    const room = new URL(request.url).pathname.split("/").pop() ?? "";

    // 先重建：這個 fetch 可能就是把物件叫醒的那一次，而房裡可能已經有人了。
    this.#hydrate();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // ⚠ 用 `ctx.acceptWebSocket()` 而不是 `server.accept()`。後者不會啟用
    // hibernation，這個物件會一直被留在記憶體裡 —— 玩家在大廳掛著的時間
    // 全部要計費，而那是這個服務絕大部分的時間。
    this.ctx.acceptWebSocket(server);

    const id = `c${this.#nextId++}`;
    this.#sockets.set(id, server);
    this.#buckets.set(id, new TokenBucket(20, 5, Date.now()));
    server.serializeAttachment({ id, room, member: null } satisfies Attachment);

    console.log(`+ ${id} 連上 房=${shortRoom(room)}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.#read(ws);
    if (att === null) return;

    // ⚠ 三道關卡的順序是有意義的：**先量大小，再算流量，最後才 decode**。
    // 反過來的話，那則 10 MB 的東西在被擋掉之前已經 `JSON.parse` 過了。
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

    const decoded = decode(raw);
    // 畸形訊息**丟掉就好，不要斷線** —— 一則壞訊息把玩家的保護關掉，代價是
    // 他在對戰中失去它，而那正是最需要它的時候（跟本機 broker 同一條規則）。
    if (decoded === null) return;
    const msg = decoded as ClientMessage;

    // ⚠ 房號由網址決定，一個 DO 只服務一間房。客戶端說了別間房就是**它連錯了**，
    // 不能默默照做 —— 那會讓兩個不同場次的人被配成一對。正確反應是斷線，
    // 讓它重連到對的網址（階段 3 的客戶端要照這條寫）。
    const claimed = msg.t === "hello" || msg.t === "room" ? msg.room : null;
    if (claimed !== null && claimed !== att.room) {
      ws.close(CLOSE_WRONG_ROOM, "wrong room");
      return;
    }

    const registry = this.#hydrate();
    const out = msg.t === "hello" ? registry.join(att.id, msg) : registry.handle(att.id, msg);
    if (msg.t === "hello") {
      // ⚠ **「配對成功」才是這個服務唯一有意義的使用量指標。**
      //
      // 「有幾個人連上來」會嚴重高估：對手沒裝插件的人也會連上來、也會佔一間房，
      // 但他從頭到尾都是單邊模式，這個服務對他沒有產生任何作用。真正要數的是
      // 「兩個人都在同一間房」的次數 —— 那才是有一場對戰真的被保護到。
      //
      // 房號是截短過的雜湊，這一行認不出任何人（`shortRoom()` 的註解）。
      const paired = registry.membersOf(att.room).length >= 2;
      console.log(`  ${att.id} hello 房=${shortRoom(att.room)}${paired ? " ✓配對成立" : ""}`);
    }
    this.#persist(registry);
    this.#send(out);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.#read(ws);
    if (att === null) return;
    const registry = this.#hydrate();
    this.#sockets.delete(att.id);
    this.#buckets.delete(att.id);
    // 剩下的那個要**立刻**知道自己變回單邊，否則他會一路等一個不會來的
    // `both-ready`，壓到硬底線才送出。
    this.#send(registry.leave(att.id));
    console.log(`- ${att.id} 離線 房=${shortRoom(att.room)}`);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    // close 會跟著來，統一在那裡收拾。
    await this.webSocketClose(ws);
  }
}
