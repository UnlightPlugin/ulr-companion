/**
 * 大廳那幾行人數的推播通道（WP-17）
 * ====================================
 * 「只看不排」的客戶端。連上每一條佇列、送一則 `q-watch`，之後**中間人一有人
 * 進出就把新數字推過來**。
 *
 * ## 為什麼不是輪詢
 *
 * 輪詢版本（`/qn`，15 秒一次）有一個結構上治不好的毛病，而它就是玩家
 * 2026-08-20 回報的那兩句：
 *
 *     一邊開始匹配後，另一邊要等 15 秒才會看到人數變成 1
 *     按下取消後，也是要等 15 秒
 *
 * ⚠ **注意那兩句講的都是「另一邊」。** 自己那一邊早就是即時的了
 * （`lobby-counts.ts` 把「我」算進去），慢的永遠是**別人的動作**傳到我畫面上
 * 這條路 —— 而輪詢的間隔就是那條路的長度，把它調短只是把帳單調高：
 *
 * ```
 *   15 秒一次   一小時 240 次   ← 現況
 *    3 秒一次   一小時 1,200 次 ← 還是會慢 3 秒
 *    推播       接上去一次，之後只有真的有人動才有訊息
 * ```
 *
 * 亞歷山卓城的那個畫面是伺服器推的，所以它按下去就動。這支就是把同一件事
 * 做出來。
 *
 * ## ⚠ 看的人不排隊
 *
 * `q-watch` 跟 `q-hello` 是**兩條各自的線**，而且刻意不共用：連上排隊佇列
 * 就代表玩家要打一場（會被配對、會被開房、會扣 AP），而看人數的人只是站在
 * 大廳。一條線兼兩件事的話，「打開大廳」跟「按下快速比賽」在中間人眼裡會
 * 變成同一件事。
 *
 * ## ⚠ 舊中間人不會回話，所以要有逾時
 *
 * 舊版的中間人**收得下這條連線**（那是同一個 `/q/<鍵>`），但 `q-watch` 它
 * 解不出來 —— 於是它什麼都不做，線就這樣開著。少了逾時的話插件會安靜地等
 * 一則永遠不會來的 `q-count`，而畫面上的人數**整個不見**（比慢 15 秒糟）。
 *
 * 所以：送出去之後 {@link WATCH_COUNT_TIMEOUT_MS} 內沒收到 `q-count` 就判定
 * 這台不支援，關線、不重試，讓呼叫端退回輪詢。
 */

import { WebSocket } from "ws";
import { QUEUE_COLD_ATTEMPTS, queueReconnectDelay } from "./match-client.js";
import { decodeQueueServer, encodeQueue } from "./match-queue.js";
import { LINK_PROTOCOL_VERSION } from "./protocol.js";
import { queueUrl } from "./target.js";

/**
 * 送出 `q-watch` 之後等第一則 `q-count` 等多久。
 *
 * ⚠ 這個值同時是「舊中間人多久會被認出來」與「網路慢的時候會不會被誤判」。
 * 10 秒對前者夠短（玩家最多看到十秒的空白就會退回輪詢），對後者夠長 ——
 * 中間人回這一則不需要做任何事，它就是一個記憶體裡的計數。
 */
export const WATCH_COUNT_TIMEOUT_MS = 10_000;

/** 一條佇列的推播狀態。 */
export type WatchState =
  /** 連線中／重試中。還沒有數字。 */
  | "connecting"
  /** 收到過 `q-count`，數字是新的。 */
  | "live"
  /**
   * 這台中間人推不了（舊版、或連不上）。**不再重試** ——
   * 呼叫端要退回輪詢，見檔頭。
   */
  | "unsupported";

/** 要看的一條佇列。`tag` 省略／`null` = 全部都數。 */
export interface QueueWatchTarget {
  key: string;
  tag?: string | null;
}

/**
 * 一條 WebSocket 的最小介面。
 *
 * 抽出來是為了測試：這支的邏輯（逾時判定、退避、換標籤要不要重連）全部
 * 是「錯了不會有人發現」的那一種 —— 而要真的開一條 WebSocket 才跑得起來的
 * 東西沒有人會測。
 */
export interface WatchSocketLike {
  send(data: string): void;
  close(): void;
}

/**
 * ⚠ **`onOpen` 不可以在 factory 還沒回傳之前叫。** 真的 WebSocket 不會
 * （`open` 至少要等一個 event loop），但假的很容易寫成同步的 —— 那時
 * `watch.socket` 還是 `null`，`q-watch` 送不出去，而症狀是「測試裡永遠拿不到
 * 人數」，看起來像邏輯錯。
 */
export interface WatchSocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number) => void;
}

export type WatchSocketFactory = (url: string, handlers: WatchSocketHandlers) => WatchSocketLike;

export interface QueueWatcherOptions {
  /** 中間人的位址（不含路徑），跟排隊、側通道同一台。 */
  endpoint: string;
  /** 某一條佇列的人數變了。**只有真的變了才會叫**（中間人自己也會去重）。 */
  onCount: (key: string, waiting: number) => void;
  onLog?: (line: string) => void;
  reconnectMs?: number;
  countTimeoutMs?: number;
  socketFactory?: WatchSocketFactory;
}

interface Watch {
  key: string;
  tag: string | null;
  socket: WatchSocketLike | null;
  state: WatchState;
  /**
   * 這一條**曾經**推過數字沒。
   *
   * ⚠ 拿來分辨「一次都沒成功過」（位址錯／服務沒部署 → 放棄）與「連上過又
   * 斷線」（網路抖一下 → 繼續退避重試）。整個 watcher 共用一個判斷的話，
   * 一條壞掉的佇列會因為**別條**是好的而永遠重試下去。
   */
  everLive: boolean;
  failures: number;
  /** 換連線時擋掉過期事件處理器排出來的重連，同 `MatchQueueClient`。 */
  generation: number;
  reconnect: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
}

function nodeSocket(url: string, handlers: WatchSocketHandlers): WatchSocketLike {
  const socket = new WebSocket(url);
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data) => handlers.onMessage(String(data)));
  socket.on("close", (code: number) => handlers.onClose(code));
  // error 之後 close 一定會跟著來，統一在那裡處理（同 `MatchQueueClient`）。
  socket.on("error", () => {});
  return {
    send: (data) => {
      try {
        socket.send(data);
      } catch {
        // 送不出去就算了 —— 逾時那一關會接住它。
      }
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // 關不掉就算了，代數已經讓它的事件失效了。
      }
    },
  };
}

/**
 * 一組佇列的人數推播。
 *
 * 一條佇列 = 一個 Durable Object = **一條連線**，所以四檔就是四條線。看起來
 * 比一個 HTTP 請求貴，實際上反過來：那四條線接上去之後**沒有人動就完全沒有
 * 訊息**，而輪詢是不管有沒有人動都要付錢的。
 */
export class QueueWatcher {
  #options: QueueWatcherOptions;
  #watches = new Map<string, Watch>();
  #counts = new Map<string, number>();
  #factory: WatchSocketFactory;
  #stopped = false;

  constructor(options: QueueWatcherOptions) {
    this.#options = options;
    this.#factory = options.socketFactory ?? nodeSocket;
  }

  /** 每一條佇列最新的人數。沒收到過的就不在裡面。 */
  get counts(): ReadonlyMap<string, number> {
    return this.#counts;
  }

  /**
   * 現在看的每一條都推得動嗎。
   *
   * ⚠ 呼叫端用它決定**還要不要輪詢**。有任何一條不是 `live`（連線中、或這台
   * 中間人根本不支援）就要繼續問 `/qn`，否則那一檔會整個沒有數字。
   */
  get allLive(): boolean {
    if (this.#watches.size === 0) return false;
    for (const w of this.#watches.values()) if (w.state !== "live") return false;
    return true;
  }

  stateOf(key: string): WatchState | null {
    return this.#watches.get(key)?.state ?? null;
  }

  /**
   * 要看的變成這幾條。**這支就是全部的生命週期** —— 玩家進大廳時給四條，
   * 離開時給空陣列。
   *
   * ```
   *   多出來的   關掉（連著不看是白付的連線）
   *   新的       連上去
   *   標籤變了   ⚠ 不重連，直接再送一則 `q-watch` —— 中間人會換掉那條線的
   *              標籤並立刻回一個新數字
   * ```
   *
   * ⚠ 標籤會變的時機是「玩家換了 COST 規則」。整條線重連的話，那幾秒裡
   * 畫面上沒有任何數字，而重送一則的成本是零。
   */
  setTargets(targets: readonly QueueWatchTarget[]): void {
    this.#stopped = false;
    const wanted = new Map<string, string | null>();
    for (const t of targets) wanted.set(t.key, t.tag ?? null);

    for (const [key, watch] of this.#watches) {
      if (wanted.has(key)) continue;
      this.#drop(watch);
      this.#watches.delete(key);
      this.#counts.delete(key);
    }

    for (const [key, tag] of wanted) {
      const existing = this.#watches.get(key);
      if (existing === undefined) {
        const watch: Watch = {
          key,
          tag,
          socket: null,
          state: "connecting",
          everLive: false,
          failures: 0,
          generation: 0,
          reconnect: null,
          deadline: null,
        };
        this.#watches.set(key, watch);
        this.#connect(watch);
        continue;
      }
      if (existing.tag === tag) continue;
      existing.tag = tag;
      // 線還開著就換標籤，沒開的話下一次連上時自然帶新的。
      if (existing.socket !== null) this.#sendWatch(existing);
    }
  }

  /** 全部關掉。玩家離開大廳、或插件要收工時叫。 */
  stop(): void {
    this.#stopped = true;
    for (const watch of this.#watches.values()) this.#drop(watch);
    this.#watches.clear();
    this.#counts.clear();
  }

  #drop(watch: Watch): void {
    watch.generation += 1;
    if (watch.reconnect !== null) clearTimeout(watch.reconnect);
    if (watch.deadline !== null) clearTimeout(watch.deadline);
    watch.reconnect = null;
    watch.deadline = null;
    watch.socket?.close();
    watch.socket = null;
  }

  #sendWatch(watch: Watch): void {
    watch.socket?.send(
      encodeQueue(
        watch.tag === null
          ? { t: "q-watch", v: LINK_PROTOCOL_VERSION, key: watch.key }
          : { t: "q-watch", v: LINK_PROTOCOL_VERSION, key: watch.key, tag: watch.tag },
      ),
    );
    this.#armDeadline(watch);
  }

  /**
   * 開始等第一則 `q-count`。
   *
   * ⚠ 這一關擋的是「線開著但對面不回話」—— 舊中間人、或路由改了之後那條
   * 路徑落到別的地方。連不上是看得出來的（會有 close），這個看不出來。
   */
  #armDeadline(watch: Watch): void {
    if (watch.deadline !== null) clearTimeout(watch.deadline);
    const gen = watch.generation;
    const ms = this.#options.countTimeoutMs ?? WATCH_COUNT_TIMEOUT_MS;
    watch.deadline = setTimeout(() => {
      if (gen !== watch.generation) return;
      watch.deadline = null;
      this.#giveUp(watch, "中間人沒有回人數（多半是舊版），改用輪詢。");
    }, ms);
  }

  #giveUp(watch: Watch, why: string): void {
    this.#drop(watch);
    watch.state = "unsupported";
    this.#options.onLog?.(`⚠ 大廳人數推播停用：${why}`);
  }

  #connect(watch: Watch): void {
    if (this.#stopped) return;
    const gen = ++watch.generation;

    let socket: WatchSocketLike;
    try {
      socket = this.#factory(queueUrl(this.#options.endpoint, watch.key), {
        onOpen: () => {
          if (gen !== watch.generation) return;
          this.#sendWatch(watch);
        },
        onMessage: (data) => {
          if (gen !== watch.generation) return;
          this.#onMessage(watch, data);
        },
        onClose: () => {
          if (gen !== watch.generation) return;
          watch.socket = null;
          if (watch.deadline !== null) clearTimeout(watch.deadline);
          watch.deadline = null;
          if (watch.state === "unsupported") return;
          watch.state = "connecting";
          watch.failures += 1;
          this.#scheduleReconnect(watch);
        },
      });
    } catch {
      watch.failures += 1;
      this.#scheduleReconnect(watch);
      return;
    }
    watch.socket = socket;
    watch.state = "connecting";
  }

  #onMessage(watch: Watch, raw: string): void {
    const message = decodeQueueServer(raw);
    if (message === null) return;
    if (message.t === "q-incompatible") {
      // ⚠ 不要重試。版本不合是穩定的事實 —— 同 `MatchQueueClient`。
      this.#giveUp(watch, `協定版本不合（${message.reason}）`);
      return;
    }
    if (message.t !== "q-count") return;

    if (watch.deadline !== null) clearTimeout(watch.deadline);
    watch.deadline = null;
    watch.state = "live";
    watch.everLive = true;
    // ⚠ 退避要歸零，否則一次長斷線之後就算恢復了，下一次抖動也要等一分鐘。
    watch.failures = 0;
    if (this.#counts.get(watch.key) === message.waiting) return;
    this.#counts.set(watch.key, message.waiting);
    this.#options.onCount(watch.key, message.waiting);
  }

  #scheduleReconnect(watch: Watch): void {
    if (this.#stopped || watch.reconnect !== null) return;
    // ⚠ 一次都沒推過就連不上 = 位址錯或服務沒部署，再試也一樣。放棄之後
    // 呼叫端會退回輪詢，而輪詢那條路自己有退避（`QUEUE_RECONNECT_MAX_MS`
    // 那段的帳單教訓對這裡一樣有效）。
    if (!watch.everLive && watch.failures >= QUEUE_COLD_ATTEMPTS) {
      this.#giveUp(watch, `連不上（試了 ${watch.failures} 次），改用輪詢。`);
      return;
    }
    const delay = queueReconnectDelay(watch.failures, this.#options.reconnectMs);
    watch.reconnect = setTimeout(() => {
      watch.reconnect = null;
      this.#connect(watch);
    }, delay);
  }
}
