/**
 * 連上配對佇列的客戶端（WP-16）
 * ================================
 * `link-client.ts` 的姊妹。兩者刻意**不共用同一個類別**，因為它們的失聯語義
 * 完全相反：
 *
 * | | 側通道（`LinkClient`） | 配對佇列（這支） |
 * | --- | --- | --- |
 * | 什麼時候連 | 對戰中 | **玩家按下「開始配對」之後** |
 * | 斷線了怎麼辦 | 一直重連，退回單邊模式繼續玩 | 重連，但**排隊要重新排** |
 * | 掉線的代價 | 少一些功能 | 沒有代價，還沒開房 |
 *
 * ⚠⚠ **這支連上去就代表玩家在排隊，所以絕對不能自己連。** 側通道是「進對戰
 * 就連」，這支是「玩家明確按了按鈕才連」—— 自動連上去的後果是玩家在不知情
 * 的狀況下被配到對手、被開房、被扣 AP。
 *
 * ## 這支不做決定
 *
 * 它只負責「把訊息送出去、把訊息交出來」。要不要接受這個對手、規則對不對得
 * 起來、要不要開房，全部在 `@ulr/arbiter-engine` 的 `match-pairing.ts` ——
 * 那些是**會改變勝負**的判斷，必須是可以單獨測的純邏輯，不能埋在一個要開
 * WebSocket 才跑得起來的類別裡。
 */

import { WebSocket } from "ws";
import type { DropReason, QueueRole, QueueServerMessage } from "./match-queue.js";
import { decodeQueueServer, encodeQueue } from "./match-queue.js";
import { LINK_PROTOCOL_VERSION } from "./protocol.js";
import { queueUrl } from "./target.js";

/** 斷線後多久重連。跟側通道同一個節奏。 */
export const QUEUE_RECONNECT_MS = 2_000;

export type QueueStatus =
  /** 沒在排隊。**這是預設值**，而且只有玩家按下按鈕才會離開它。 */
  | "idle"
  /** 連線中／斷線重試中。 */
  | "connecting"
  /** 排隊中，還沒配到人。 */
  | "waiting"
  /** 配到人了，正在對規則、開房。 */
  | "matched"
  /** 中間人的協定版本不合。**不重試。** */
  | "incompatible";

export interface MatchQueueClientOptions {
  /** 中間人的位址（不含路徑），跟側通道同一台。 */
  endpoint: string;
  /** 配對鍵，`matchKey()` 算出來的。 */
  key: string;
  /** 我的規則標籤，`ruleTag(key, contentHash)`。 */
  tag: string;
  reconnectMs?: number;
  onStatus?: (status: QueueStatus, waiting: number) => void;
  /** 湊成一對了。**這裡不會自動做任何事**，由呼叫端決定下一步。 */
  onMatched?: (info: { role: QueueRole; token: string; peerTag: string }) => void;
  /** 對手的牌組描述子／指紋。內容這支不解讀。 */
  onPeerDeck?: (body: string) => void;
  onPeerEval?: (body: string) => void;
  /** host 的房開好了（只有 guest 會收到）。 */
  onRoom?: (roomId: string) => void;
  /** 配對對象沒了 —— 取消、斷線、或規則對不起來。 */
  onDropped?: (reason: DropReason) => void;
  onLog?: (line: string) => void;
}

export class MatchQueueClient {
  #options: MatchQueueClientOptions;
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #status: QueueStatus = "idle";
  #waiting = 0;
  /** 同 `LinkClient`：換連線時擋掉過期事件處理器排出來的重連。 */
  #generation = 0;
  /**
   * 收到過 `q-welcome` 沒。
   *
   * ⚠ 用它來分辨「連不上」與「連上了但沒人」—— 這兩件事在畫面上原本長得
   * 一模一樣（都是「排隊中」），而它們要玩家做的事完全相反：一個是等，
   * 一個是去看設定。
   */
  #welcomed = false;
  /** 連不上而重試了幾次。只拿來決定「這一則要不要印」，不進任何判斷。 */
  #failures = 0;

  constructor(options: MatchQueueClientOptions) {
    this.#options = options;
  }

  get status(): QueueStatus {
    return this.#status;
  }

  /** 含自己在排隊的人數。中間人給的，只是給玩家看的參考值。 */
  get waiting(): number {
    return this.#waiting;
  }

  /** ⚠ 只能由玩家明確的動作觸發。 */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    // 每次重新排隊都是新的一輪：上一輪連不上不代表這一輪也連不上（玩家很可能
    // 就是去改了中間人的位址才回來按的）。
    this.#welcomed = false;
    this.#failures = 0;
    this.#connect();
  }

  /**
   * 停止排隊。
   *
   * ⚠ **要先送 `q-cancel` 再關**，不能直接關掉連線。直接關的話對手要等到
   * 中間人偵測到斷線才知道，而那可能是好幾秒 —— 那幾秒裡他的畫面寫著
   * 「配對成功，等對方開房」，而那間房永遠不會出現。
   */
  stop(): void {
    if (this.#stopped) return;
    this.#send({ t: "q-cancel" });
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      this.#socket?.close();
    } catch {
      // 關不掉就算了，代數已經讓它的事件失效了。
    }
    this.#socket = null;
    this.#waiting = 0;
    this.#setStatus("idle");
  }

  /** 把我的牌組描述子送給對手。內容由呼叫端組好。 */
  sendDeck(body: string): void {
    this.#send({ t: "q-deck", body });
  }

  /** 把我算出來的兩個指紋送給對手。 */
  sendEval(body: string): void {
    this.#send({ t: "q-eval", body });
  }

  /** host 專用：把開好的房號轉給對手。 */
  sendRoom(roomId: string): void {
    this.#send({ t: "q-room", roomId });
  }

  /**
   * 這一對配不成，但我還要繼續排。
   *
   * ⚠ 跟 `stop()` 不一樣：這支**留在佇列裡**，而且中間人會記住這一對試過了。
   */
  reject(): void {
    this.#send({ t: "q-reject" });
    this.#setStatus("waiting");
  }

  #send(message: object): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(encodeQueue(message as never));
    } catch {
      // 送不出去就算了 —— 最壞的情況是對手等到逾時，而那條路本來就要有。
    }
  }

  #setStatus(status: QueueStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatus?.(status, this.#waiting);
  }

  #connect(): void {
    if (this.#stopped) return;

    const gen = ++this.#generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(queueUrl(this.#options.endpoint, this.#options.key));
    } catch (err) {
      this.#options.onLog?.(
        `✗ 連不上配對佇列：${err instanceof Error ? err.message : String(err)}`,
      );
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    this.#setStatus("connecting");

    socket.on("open", () => {
      if (gen !== this.#generation) return;
      this.#send({
        t: "q-hello",
        v: LINK_PROTOCOL_VERSION,
        key: this.#options.key,
        tag: this.#options.tag,
      });
    });

    socket.on("message", (data) => {
      if (gen !== this.#generation) return;
      const message = decodeQueueServer(String(data));
      if (message === null) return;
      this.#onMessage(message);
    });

    socket.on("close", (code: number) => {
      if (gen !== this.#generation) return;
      this.#socket = null;
      if (this.#status !== "incompatible") this.#setStatus("connecting");
      // ⚠ **連不上一定要講出來。** 這支原本只在 `new WebSocket()` 當場拋例外時
      // 記一行，而那條路幾乎不會走到 —— 位址合法但對方回 404（中間人還沒部署
      // 配對佇列）、DNS 不通、被防火牆擋掉，全部都是「開了連線然後被關掉」。
      // 於是插件安靜地每兩秒重試，而畫面上寫著「排隊中」。
      //
      // 只在第一次與每十次印，重試是無限的，不能把記錄檔洗掉。
      if (!this.#welcomed) {
        this.#failures += 1;
        if (this.#failures === 1 || this.#failures % 10 === 0) {
          this.#options.onLog?.(
            `✗ 連不上配對佇列（第 ${this.#failures} 次，close=${code}）：` +
              `${queueUrl(this.#options.endpoint, this.#options.key)} —— 還在重試。`,
          );
        }
      }
      this.#scheduleReconnect();
    });

    socket.on("error", () => {
      // close 一定會跟著來，統一在那裡處理。
    });
  }

  #onMessage(message: QueueServerMessage): void {
    switch (message.t) {
      case "q-welcome":
        if (!this.#welcomed) {
          this.#welcomed = true;
          // 前面印過「連不上」的話要收尾 —— 只有失敗的那一半會讓人以為插件壞了。
          if (this.#failures > 0) this.#options.onLog?.("✓ 配對佇列連上了，開始排隊。");
        }
        this.#waiting = message.waiting;
        this.#setStatus("waiting");
        // 狀態沒變（本來就在 waiting）時 setStatus 不會發，但人數變了要讓 UI 知道。
        this.#options.onStatus?.(this.#status, this.#waiting);
        return;
      case "q-matched":
        this.#setStatus("matched");
        this.#options.onMatched?.({
          role: message.role,
          token: message.token,
          peerTag: message.peerTag,
        });
        return;
      case "q-deck":
        this.#options.onPeerDeck?.(message.body);
        return;
      case "q-eval":
        this.#options.onPeerEval?.(message.body);
        return;
      case "q-room":
        this.#options.onRoom?.(message.roomId);
        return;
      case "q-dropped":
        this.#setStatus("waiting");
        this.#options.onDropped?.(message.reason);
        return;
      case "q-incompatible":
        // ⚠ 不要重試。版本不合是穩定的事實。
        this.#stopped = true;
        this.#setStatus("incompatible");
        this.#options.onLog?.(`⚠ 配對佇列版本不合（${message.reason}）`);
        try {
          this.#socket?.close();
        } catch {
          // 同上。
        }
        return;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, this.#options.reconnectMs ?? QUEUE_RECONNECT_MS);
  }
}
