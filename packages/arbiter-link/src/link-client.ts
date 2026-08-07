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
import { encode, decode, LINK_PROTOCOL_VERSION, normalizePrefs, soloSettings } from "./protocol.js";

/** 斷線後多久重連。中間人可能只是被玩家關掉又開起來。 */
export const DEFAULT_RECONNECT_MS = 2_000;

export type LinkStatus =
  /** 還沒連上（或斷了，正在重試） */
  | "offline"
  /** 連上了，但房裡只有我 —— 對手沒插件、或還沒進同一場 */
  | "solo"
  /** 連上了而且配到對手 */
  | "paired"
  /** 對方協定版本不合，已退回單邊模式，**不會**重試 */
  | "incompatible";

export interface LinkClientOptions {
  /** 中間人的位址。 */
  url: string;
  prefs: LinkPrefs;
  /** 一開始待的房。還沒進對戰就給 `LOBBY_ROOM_KEY`。 */
  room: string;
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
  #room: string;
  #status: LinkStatus = "offline";
  #agreed: AgreedSettings;
  /** 最後一次送出去的準備狀態。重連之後要重送，否則中間人那邊是舊的。 */
  #ready = false;

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
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus("offline");
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
   * 換場了。
   *
   * ⚠ **一定要叫。** 房號沒跟著換，兩個插件就會停在上一場的房裡 ——
   * 症狀是「打第二場之後準備同步就失效了」，而且完全沒有錯誤訊息。
   */
  setRoom(room: string): void {
    if (room === this.#room) return;
    this.#room = room;
    this.#ready = false;
    this.#send({ t: "room", room });
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
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#options.url);
    } catch (err) {
      this.#options.onLog?.(`✗ 連不上中間人：${err instanceof Error ? err.message : String(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.on("open", () => {
      this.#send({ t: "hello", v: LINK_PROTOCOL_VERSION, room: this.#room, prefs: this.#prefs });
      // 重連之後中間人那邊是全新的成員，準備狀態要重送 —— 否則我方明明壓著
      // OK，對手按下去卻永遠湊不成 both-ready。
      if (this.#ready) this.#send({ t: "ready", ready: true });
    });

    socket.on("message", (data) => {
      const message = decode(String(data));
      if (message === null) return;
      this.#onMessage(message as ServerMessage);
    });

    socket.on("close", () => {
      this.#socket = null;
      // ⚠ 退回單邊，不是沿用最後一次協商的結果（見檔頭）。
      this.#agreed = soloSettings(this.#prefs);
      if (this.#status !== "incompatible") this.#setStatus("offline");
      else this.#emit();
      this.#scheduleReconnect();
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

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, this.#options.reconnectMs ?? DEFAULT_RECONNECT_MS);
  }
}
