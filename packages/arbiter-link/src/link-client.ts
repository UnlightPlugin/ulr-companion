/**
 * 連上中間人的客戶端
 * ====================
 * 唯一跟傳輸有關的東西是**一個 URL**。本機是 `ws://127.0.0.1:9350`，
 * 之後 ulgg 換成 Cloudflare Workers + Durable Objects 就是 `wss://…/room` ——
 * 這個檔案不用改。（Durable Objects 本來就講 WebSocket，形狀完全一樣。）
 *
 * ⚠ **失聯的預設一定要是「單邊模式」，不是「沿用上一次的共同設定」。**
 * 共同設定裡的縮短秒數是**雙方同意**才成立的；連線斷了之後對手還是用滿
 * 30 秒，我方繼續照 15 秒送出就是純粹的自損。所以斷線時 `agreed` 立刻
 * 退回 `soloSettings()`，而不是保留最後一次協商的結果。
 *
 * 這跟 `patch-ok.ts` 的心跳是同一條原則：**沒人管的時候要停手，不是繼續照舊。**
 */

import { WebSocket } from "ws";
import type { AgreedSettings, ForceReason, LinkPrefs, ServerMessage } from "./protocol.js";
import {
  CLOSE_TOO_FAST,
  CLOSE_WRONG_ROOM,
  encode,
  decode,
  LINK_PROTOCOL_VERSION,
  normalizePrefs,
  soloSettings,
} from "./protocol.js";
import { roomUrl } from "./target.js";

/** 斷線後多久重連。中間人可能只是被玩家關掉又開起來。 */
export const DEFAULT_RECONNECT_MS = 2_000;

/**
 * 被中間人以「你送太快」踢掉之後要等多久。
 *
 * ⚠ **不能用一般的重連間隔。** 4008 的意思是「問題出在我這邊」，兩秒後回去
 * 只會再被踢一次，然後變成一個每兩秒敲一次的迴圈 —— 對伺服器是攻擊，對玩家
 * 是側通道永遠不會好。等一分鐘讓令牌桶補滿才有意義。
 */
export const THROTTLED_RECONNECT_MS = 60_000;

export type LinkStatus =
  /** **還沒進對戰，刻意不連線。** 不是錯誤，也不需要重試。 */
  | "idle"
  /** 還沒連上（或斷了，正在重試） */
  | "offline"
  /** 連上了，但房裡只有我 —— 對手沒插件、或還沒進同一場 */
  | "solo"
  /** 連上了而且配到對手 */
  | "paired"
  /** 對方協定版本不合，已退回單邊模式，**不會**重試 */
  | "incompatible";

/**
 * 斷線之後該等多久再連。**純函式，因為這裡錯了會變成打伺服器的迴圈。**
 */
export function reconnectDelayFor(code: number, baseMs: number): number {
  // 房號對不上：我方的 `#room` 已經是新的了，用對的網址馬上重連就好。
  if (code === CLOSE_WRONG_ROOM) return 0;
  if (code === CLOSE_TOO_FAST) return THROTTLED_RECONNECT_MS;
  return baseMs;
}

export interface LinkClientOptions {
  /**
   * 中間人的位址，**不含房間路徑**（房號由 `roomUrl()` 接上去）。
   * 本機是 `ws://127.0.0.1:9350`，雲端是 `wss://….workers.dev`。
   */
  endpoint: string;
  prefs: LinkPrefs;
  /**
   * 一開始在哪一場。**還沒進對戰就給 `null`** —— 那時候完全不連線。
   *
   * ⚠ 舊版這裡給的是 `LOBBY_ROOM_KEY`，在本機無害；接上公網之後那會變成
   * 「全世界沒在對戰的人擠進同一間房」，而且其中兩個會被真的配成一對。
   * 見 `apps/link-worker/src/guard.ts` 的 `parseRoomPath()`。
   */
  room: string | null;
  reconnectMs?: number;
  /** 狀態或共同設定變了。UI 直接畫這個。 */
  onChange?: (state: { status: LinkStatus; agreed: AgreedSettings }) => void;
  /** ⚠ 兩邊都準備好了 —— **這是唯一會透露對手狀態的回呼**。 */
  onBothReady?: () => void;
  /** 對手那邊的秒數門檻到了。 */
  onForceEnd?: (reason: ForceReason) => void;
  /** 給 CLI 印用的。不含遊戲內容。 */
  onLog?: (line: string) => void;
}

export class LinkClient {
  #options: LinkClientOptions;
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #prefs: LinkPrefs;
  #room: string | null;
  #status: LinkStatus = "idle";
  #agreed: AgreedSettings;
  /** 最後一次送出去的準備狀態。重連之後要重送，否則中間人那邊是舊的。 */
  #ready = false;
  /**
   * 連線的代數。
   *
   * ⚠ 換房時我們會**主動**關掉舊連線，而 `ws` 的 `close` 事件是非同步來的 ——
   * 那時新連線已經建好了，舊的事件處理器一跑就會把它當成「斷線」而排一次重連，
   * 於是連線每換一次房就多一條。用代數把過期的事件擋在門外。
   */
  #generation = 0;

  constructor(options: LinkClientOptions) {
    this.#options = options;
    this.#prefs = normalizePrefs(options.prefs);
    this.#room = options.room;
    this.#agreed = soloSettings(this.#prefs);
  }

  get status(): LinkStatus {
    return this.#status;
  }

  /**
   * 目前生效的共同設定。
   *
   * ⚠ 失聯或沒配對到人時這裡是 `soloSettings()` —— **秒數不縮短**。
   * 呼叫端不需要自己判斷有沒有配對，照著這個值做就是對的。
   */
  get agreed(): AgreedSettings {
    return this.#agreed;
  }

  get prefs(): LinkPrefs {
    return this.#prefs;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus("offline");
  }

  /** 現在在哪一場（`null` = 還沒進對戰）。 */
  get room(): string | null {
    return this.#room;
  }

  /** 玩家在托盤裡改了設定。沒連上也照樣記住，連上時會一起送。 */
  setPrefs(prefs: Partial<LinkPrefs>): void {
    this.#prefs = normalizePrefs({ ...this.#prefs, ...prefs });
    if (this.#status === "solo" || this.#status === "paired") {
      this.#send({ t: "prefs", prefs: this.#prefs });
    } else {
      // 沒連上時共同設定就是自己的單邊版本，UI 要立刻看到變化。
      this.#agreed = soloSettings(this.#prefs);
      this.#emit();
    }
  }

  /**
   * 換場了。`null` = 離開對戰，斷線並停在 `idle`。
   *
   * ⚠ **一定要叫。** 房號沒跟著換，兩個插件就會停在上一場的房裡 ——
   * 症狀是「打第二場之後準備同步就失效了」，而且完全沒有錯誤訊息。
   *
   * ⚠⚠ **換房 = 換連線，不是送一則 `{t:"room"}`。** 雲端版一個 Durable Object
   * 就是一間房，房號在網址裡 —— 同一條連線改房號在那邊根本做不到（伺服器會
   * 用 4001 把你踢掉）。所以這裡重連。協定裡那則 `room` 留著給本機 broker
   * 相容，但客戶端不再送它：**兩種傳輸只留一條程式碼路徑**。
   */
  setRoom(room: string | null): void {
    if (room === this.#room) return;
    this.#room = room;
    this.#ready = false;
    this.#reconnectNow();
  }

  /** 立刻丟掉現在的連線，改用目前的房號重連（房號是 `null` 就停在 idle）。 */
  #reconnectNow(): void {
    this.#generation += 1;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close();
    } catch {
      // 關不掉就算了，代數已經讓它的事件失效了。
    }
    // 連上之前一律是單邊 —— 換場的空窗期不該沿用上一場的共同設定。
    this.#agreed = soloSettings(this.#prefs);
    this.#connect();
  }

  /** 我方準備狀態變了。中間人**不會**把這則轉給對手。 */
  announceReady(ready: boolean): void {
    if (this.#ready === ready) return;
    this.#ready = ready;
    this.#send({ t: "ready", ready });
  }

  /** 我這邊的秒數門檻到了，讓對手也收手。 */
  announceForceEnd(reason: ForceReason): void {
    this.#send({ t: "force-end", reason });
  }

  #send(message: object): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(encode(message as never));
    } catch {
      // 送不出去不是災難 —— 硬底線與本機門檻都還在。
    }
  }

  #setStatus(status: LinkStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit();
  }

  #emit(): void {
    this.#options.onChange?.({ status: this.#status, agreed: this.#agreed });
  }

  #connect(): void {
    if (this.#stopped) return;

    // ⚠ **還沒進對戰就不連。** 沒有對手可以配，連上去只是佔著伺服器的一間房；
    // 而且在雲端版那會變成「所有在大廳的人擠進同一個 Durable Object」。
    const room = this.#room;
    if (room === null) {
      this.#agreed = soloSettings(this.#prefs);
      this.#setStatus("idle");
      return;
    }

    const gen = ++this.#generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(roomUrl(this.#options.endpoint, room));
    } catch (err) {
      this.#options.onLog?.(`✗ 連不上中間人：${err instanceof Error ? err.message : String(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.on("open", () => {
      if (gen !== this.#generation) return;
      this.#send({ t: "hello", v: LINK_PROTOCOL_VERSION, room, prefs: this.#prefs });
      // 重連之後中間人那邊是全新的成員，準備狀態要重送 —— 否則我方明明壓著
      // OK，對手按下去卻永遠湊不成 both-ready。
      if (this.#ready) this.#send({ t: "ready", ready: true });
    });

    socket.on("message", (data) => {
      if (gen !== this.#generation) return;
      const message = decode(String(data));
      if (message === null) return;
      this.#onMessage(message as ServerMessage);
    });

    socket.on("close", (code: number) => {
      // 過期的連線（換房時我們自己關掉的那條）不該觸發重連。
      if (gen !== this.#generation) return;
      this.#socket = null;
      // ⚠ 退回單邊，不是沿用最後一次協商的結果（見檔頭）。
      this.#agreed = soloSettings(this.#prefs);
      if (this.#status !== "incompatible") this.#setStatus("offline");
      else this.#emit();
      if (code === CLOSE_TOO_FAST) {
        this.#options.onLog?.("⚠ 側通道被中間人限流，一分鐘後再試");
      }
      this.#scheduleReconnect(
        reconnectDelayFor(code, this.#options.reconnectMs ?? DEFAULT_RECONNECT_MS),
      );
    });

    socket.on("error", () => {
      // close 一定會跟著來，統一在那裡處理。這裡吞掉是為了不讓 ws 把
      // 「連不上」變成未處理的例外把插件帶走。
    });
  }

  #onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
      case "agreed":
        this.#agreed = message.agreed;
        this.#setStatus(message.paired ? "paired" : "solo");
        this.#emit();
        return;
      case "both-ready":
        this.#options.onBothReady?.();
        return;
      case "force-end":
        this.#options.onForceEnd?.(message.reason);
        return;
      case "incompatible":
        // ⚠ **不要重試。** 版本不合是個穩定的事實，重連只會每兩秒再確認一次。
        this.#agreed = soloSettings(this.#prefs);
        this.#setStatus("incompatible");
        this.#options.onLog?.(`⚠ 側通道版本不合（${message.reason}）—— 退回單邊模式`);
        this.#stopped = true;
        this.#socket?.close();
        return;
      case "room-full":
        this.#options.onLog?.("⚠ 這間房已經有兩個插件了 —— 退回單邊模式");
        this.#agreed = soloSettings(this.#prefs);
        this.#setStatus("solo");
        return;
    }
  }

  #scheduleReconnect(delayMs?: number): void {
    if (this.#stopped || this.#timer !== null) return;
    // 不在對戰裡就沒有東西要重連 —— 排一個每兩秒醒來一次的計時器只是白費電。
    if (this.#room === null) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#connect();
      },
      delayMs ?? this.#options.reconnectMs ?? DEFAULT_RECONNECT_MS,
    );
  }
}
