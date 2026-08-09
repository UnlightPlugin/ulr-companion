/**
 * @ulr/arbiter-link — WP-15：移動階段仲裁的側通道
 * ================================================
 * 兩個插件之間的中間人。**第一版只有兩個功能**（玩家定的）：
 *
 *   1. **準備按鈕** —— 雙方都按了 OK 才真的送出，先按的人不再被懲罰
 *   2. **準備時間縮減** —— 雙方各自設一個「移動階段要多長」，取比較長的
 *      那個當共同值；手牌有聖水／聖杯又碰上麻痺時再提早 5 秒
 *
 * ```
 *   插件 A ─┐                   ┌─ ws://127.0.0.1:9350
 *           ├─ LinkNode ── 中間人 ─── RoomRegistry（規則）
 *   插件 B ─┘                   └─ 之後換成 Workers + Durable Objects
 * ```
 *
 * | 檔案            | 跑在哪 | 職責                                       |
 * | --------------- | ------ | ------------------------------------------ |
 * | `protocol.ts`   | 兩邊   | 訊息型別、協商規則、房號雜湊（**純函式**） |
 * | `rooms.ts`      | 中間人 | 配對與合成訊號（**純函式**）               |
 * | `broker.ts`     | 中間人 | WebSocket 膠水，只聽 127.0.0.1             |
 * | `link-client.ts`| 插件   | 連線、重連、失聯退回單邊                   |
 * | `node.ts`       | 插件   | 先搶著當中間人，佔不到就當客戶端           |
 *
 * 換成 ulgg 的雲端版時，**只有 `broker.ts` 會被丟掉**，客戶端只換 URL。
 *
 * ⚠ 三條紅線寫在 `protocol.ts` 的檔頭，每一條都有測試釘住。最重要的是
 * 第一條：**中間人從不單獨告訴任何一方「對手準備好了」。**
 */

export {
  clampHazardShorten,
  clampPhaseSeconds,
  clampSpeedFactor,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  CLOSE_WRONG_ROOM,
  DEFAULT_HAZARD_SHORTEN_SECONDS,
  DEFAULT_PHASE_SECONDS,
  DEFAULT_PREFS,
  decode,
  effectiveCapSeconds,
  encode,
  isCompatible,
  LINK_PROTOCOL_VERSION,
  LOBBY_ROOM_KEY,
  MAX_SPEED_FACTOR,
  MIN_PHASE_SECONDS,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  negotiate,
  normalizePrefs,
  ROOM_KEY_LENGTH,
  roomKey,
  soloSettings,
} from "./protocol.js";
export type {
  AgreedSettings,
  ClientMessage,
  ForceReason,
  LinkMessage,
  LinkPrefs,
  ServerMessage,
} from "./protocol.js";

export { ROOM_CAPACITY, RoomRegistry } from "./rooms.js";
export type { Member, Outgoing } from "./rooms.js";

export { AddressInUseError, DEFAULT_LINK_PORT, LinkBroker } from "./broker.js";
export type { BrokerOptions } from "./broker.js";

export {
  DEFAULT_RECONNECT_MS,
  LinkClient,
  reconnectDelayFor,
  THROTTLED_RECONNECT_MS,
} from "./link-client.js";
export type { LinkClientOptions, LinkStatus } from "./link-client.js";

// 階段 3：中間人的位址從「一個埠號」變成「一個字串」，兩種傳輸共用同一份解析。
export {
  DEFAULT_LINK_TARGET,
  DEFAULT_UPDATE_FEED,
  describeTarget,
  endpointOf,
  parseLinkTarget,
  roomUrl,
  SERVICE_ORIGIN,
} from "./target.js";
export type { LinkTarget } from "./target.js";

export { LinkNode } from "./node.js";
export type { LinkNodeOptions } from "./node.js";
