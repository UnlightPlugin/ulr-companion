/**
 * 「誰當中間人」這件事不該要玩家決定
 * ====================================
 * 雙開的實際情況是：玩家開兩個插件，各接一個客戶端。要求他先開一個
 * broker 再開兩個插件，等於三個視窗、三個步驟，而且忘了開的症狀是
 * 「準備同步沒作用」—— 沒有任何錯誤訊息。
 *
 * 所以每個插件都**先試著當中間人，佔不到就當客戶端**。誰先開誰當，
 * 兩邊的行為完全一樣，玩家不需要知道這件事存在。
 *
 * ⚠ **當中間人的那個關掉之後，另一個要接手。** 否則第一個玩家退出遊戲，
 * 第二個就永遠停在 offline —— 而他什麼都沒做錯。所以斷線期間會一直重試
 * 搶那個埠。
 */

import type { LinkPrefs } from "./protocol.js";
import { DEFAULT_LINK_PORT, AddressInUseError, LinkBroker } from "./broker.js";
import type { LinkClientOptions } from "./link-client.js";
import { LinkClient } from "./link-client.js";

export interface LinkNodeOptions extends Omit<LinkClientOptions, "url"> {
  port?: number;
  prefs: LinkPrefs;
}

/** 多久重搶一次中間人的位置。跟重連同一個量級就好。 */
const HOST_RETRY_MS = 3_000;

export class LinkNode {
  #broker: LinkBroker | null = null;
  #client: LinkClient;
  #timer: ReturnType<typeof setInterval> | null = null;
  #port: number;
  #onLog: ((line: string) => void) | undefined;
  #stopped = false;

  private constructor(
    client: LinkClient,
    port: number,
    onLog: ((line: string) => void) | undefined,
  ) {
    this.#client = client;
    this.#port = port;
    this.#onLog = onLog;
  }

  get client(): LinkClient {
    return this.#client;
  }

  /** 我是不是那個中間人。托盤顯示用，行為上沒有差別。 */
  get hosting(): boolean {
    return this.#broker !== null;
  }

  static async start(options: LinkNodeOptions): Promise<LinkNode> {
    const port = options.port ?? DEFAULT_LINK_PORT;
    const { port: _port, ...clientOptions } = options;
    const client = new LinkClient({ ...clientOptions, url: `ws://127.0.0.1:${port}` });
    const node = new LinkNode(client, port, options.onLog);

    await node.#tryHost();
    client.start();
    node.#timer = setInterval(() => void node.#tick(), HOST_RETRY_MS);
    return node;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#client.stop();
    await this.#broker?.close();
    this.#broker = null;
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    // 只有在**自己沒在當中間人、而且也連不上別人**的時候才搶。連得上就代表
    // 有人在當，搶了只會把現有的連線打斷。
    if (this.#broker !== null || this.#client.status !== "offline") return;
    await this.#tryHost();
  }

  async #tryHost(): Promise<void> {
    const onLog = this.#onLog;
    try {
      this.#broker = await LinkBroker.listen({
        port: this.#port,
        ...(onLog !== undefined ? { onLog } : {}),
      });
      onLog?.(`  這個插件是中間人（127.0.0.1:${this.#port}）`);
    } catch (err) {
      this.#broker = null;
      if (err instanceof AddressInUseError) {
        onLog?.(`  中間人已經有人在當了（:${this.#port}），這邊當客戶端`);
        return;
      }
      onLog?.(`✗ 開不了中間人：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
