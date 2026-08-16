/**
 * 中間人在哪（純函式，無 I/O）
 * ==============================
 * 階段 3 的核心：玩家設定裡的「中間人」從**一個埠號**變成**一個字串**，
 * 因為它現在有兩種可能 ——
 *
 *   本機：同一台電腦上的另一個插件（雙開、測試）→ `ws://127.0.0.1:59224`
 *   雲端：Cloudflare 上的 `apps/link-worker`      → `wss://….workers.dev`
 *
 * 這兩件事在使用者眼裡是同一格設定，所以解析要寬鬆到讓他怎麼填都對：
 * `9350`、`local`、`ulr-link.someone.workers.dev`、`wss://…` 全部收。
 *
 * ⚠ **壞掉的值一律退回本機預設，絕不拋例外。** 這一格填錯的代價不該是
 * 「插件開不起來」——那會讓玩家連改回來的介面都看不到。跟 `clampPort()`
 * 同一條原則。
 */

/**
 * 本機中間人的預設埠。避開 CDP 的 59222／59223 與遊戲自己的那幾條。
 *
 * ⚠ **2026-08-16 從 9350 換過來。** 舊值落在 Windows 動態保留的 9277–9876 裡，
 * broker 綁不上 —— 而症狀是「兩份插件都說自己不是中間人、也配不到對」，完全
 * 看不出跟埠有關。同一天 CDP 的 9334 與 broker 測試寫死的 9377 一起中招。
 *
 * 換到 59222 那一帶不是因為那裡「安全」（見 `cdp-adapter/debug-port.ts`：
 * 沒有哪個常數在所有機器上都安全），而是因為**三個埠放在一起，下次再被整段
 * 吃掉時會一起壞，比散在各處一次壞一個容易認**。
 */
export const DEFAULT_LINK_PORT = 59224;

export type LinkTarget =
  /** 同一台電腦。**要先搶著當中間人**（見 `node.ts`）。 */
  | { kind: "local"; port: number }
  /** 別人開的中間人。**永遠不當 host**，只當客戶端。 */
  | { kind: "remote"; endpoint: string };

/**
 * 預設的中間人：**雲端那一個**（`apps/link-worker`，2026-08-09 上線）。
 *
 * ⚠⚠ **預設值必須是雲端，這是整個功能會不會被用到的分水嶺。**
 *
 * 本機中間人只配得到「同一台電腦上的另一個插件」—— 那是雙開測試的情境，
 * 不是玩家的情境。預設留在 `local` 的話，一般玩家裝完之後**永遠是單邊模式**，
 * 而且畫面上看起來一切正常（狀態列寫「還沒配到對手」，那句話在他對手真的
 * 沒裝插件時也是同一句）。要他自己去進階裡填一個網址才會生效，等於這個功能
 * 對 99% 的人不存在。
 *
 * ⚠ 這個網址是**烤進客戶端的**。改網址等於要發一版，所以不要輕易換 ——
 * 舊版的插件會繼續連舊網址，而它們只會安靜地退回單邊模式。
 */
/**
 * 這個專案的雲端服務在哪。**整個 repo 只有這裡寫死這個網址。**
 *
 * 側通道（`wss://…/r/<房號>`）與更新來源（`https://…/update`）是**同一台**
 * Worker，所以兩個常數都從這裡導出來 —— 換網址時只有這一行要改。分開寫死的話
 * 一定會有一天只改到一個，而漏掉的那個**不會報錯**：更新靜靜停掉，或側通道
 * 靜靜退回單邊。
 */
export const SERVICE_ORIGIN = "https://ulr-link.lldavuull.workers.dev";

const CLOUD: LinkTarget = {
  kind: "remote",
  endpoint: SERVICE_ORIGIN.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
};

/** 設定欄位的預設值（空白時就是它）。 */
export const DEFAULT_LINK_TARGET = CLOUD.endpoint;

/**
 * 自動更新的發布清單在哪。
 *
 * ⚠ **一定要有預設值。** `updater.ts` 原本只讀環境變數 `ULR_UPDATE_FEED`，
 * 而**打包版沒有人會去設環境變數** —— 等於自動更新對所有玩家都是關掉的。
 * 症狀是最安靜的那種：發出去的每一份都停在當初那一版，而且你不會收到任何
 * 「更新失敗」的回報，因為它根本沒開始過。
 *
 * 讓 Worker 來回這份清單（而不是直接指向 GitHub Releases）是為了留一層轉向：
 * 之後換檔案的存放位置時改 Worker 就好，**不必為了換網址再發一版**。
 */
export const DEFAULT_UPDATE_FEED = `${SERVICE_ORIGIN}/update`;

/**
 * 開發者用的關鍵字：不要雲端，改用同一台電腦上的 broker。
 *
 * 留著的理由只有一個：**雙開測試**（`packages/arbiter-link/test/broker.test.ts`
 * 與「兩個實例互相配對」那條路）。玩家沒有任何理由填它。
 */
export const LOCAL_KEYWORD = "local";

function clampPort(value: number): number {
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_LINK_PORT;
}

/**
 * 把設定欄位的字串解析成「要連去哪」。
 *
 * | 玩家填的                       | 結果                                |
 * | ------------------------------ | ----------------------------------- |
 * | 空白                           | **雲端（預設）**                    |
 * | `local`                        | 本機 :59224（開發者用）             |
 * | `9351` / `local:9351`          | 本機 :9351（開發者用）              |
 * | `wss://x.workers.dev`          | 雲端，照用                          |
 * | `https://x.workers.dev`        | 雲端，自動換成 `wss://`             |
 * | `x.workers.dev`                | 雲端，自動補 `wss://`               |
 * | 其他看不懂的東西               | **雲端（預設）**                    |
 *
 * ⚠ 看不懂的值退回**雲端**而不是本機：填錯的人想連的是外面，把他丟回一個
 * 只有自己的房間等於安靜地把功能關掉。
 *
 * ⚠ **裸網域自動補的是 `wss://` 不是 `ws://`。** 補錯的話玩家的側通道會用
 * 明文跑在公網上，而且他不會發現 —— 那條通道傳的是「兩邊都準備好了」，
 * 中間有人插手就能操縱勝負。要明文只能自己完整打出 `ws://`。
 */
export function parseLinkTarget(raw: string | undefined | null): LinkTarget {
  const value = (raw ?? "").trim();
  if (value === "") return CLOUD;
  if (value.toLowerCase() === LOCAL_KEYWORD) {
    return { kind: "local", port: DEFAULT_LINK_PORT };
  }

  // 純數字 = 本機的某個埠（開發者用，也相容舊設定檔裡的 linkPort）
  if (/^\d+$/.test(value)) return { kind: "local", port: clampPort(Number(value)) };

  const local = /^local:(\d+)$/i.exec(value);
  if (local?.[1] !== undefined) return { kind: "local", port: clampPort(Number(local[1])) };

  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `wss://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return CLOUD;
  }
  const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[url.protocol];
  if (scheme === undefined) return CLOUD;

  // 127.0.0.1 也走 remote —— 玩家自己打出完整網址時，他要的就是那個位址，
  // 不是「順便幫他當 host」。要當 host 得填 `local`。
  url.protocol = scheme;
  // 路徑由 `roomUrl()` 接上去，這裡只留主機部分（尾巴的 / 會變成 `//r/…`）。
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  return { kind: "remote", endpoint };
}

/** 連線用的位址。`endpoint` 是主機，房號在路徑上。 */
export function endpointOf(target: LinkTarget): string {
  return target.kind === "local" ? `ws://127.0.0.1:${target.port}` : target.endpoint;
}

/**
 * 某一間房的完整網址。
 *
 * ⚠ **房號放在路徑上，不是只放在 `hello` 裡。** 雲端版靠它決定要把這條連線
 * 交給哪一個 Durable Object（一個 DO = 一間房），沒有路徑就沒有辦法路由。
 * 本機 broker 完全不看路徑，所以同一份程式碼兩邊都對 —— 這正是可以只留
 * 一條程式碼路徑的原因。
 */
export function roomUrl(endpoint: string, room: string): string {
  return `${endpoint}/r/${room}`;
}

/**
 * 某一條配對佇列的完整網址（WP-16）。
 *
 * 跟 `roomUrl()` 同一個道理，只是換一個前綴：一個配對鍵 = 一條佇列 =
 * 一個 Durable Object。**兩者共用同一台中間人**，玩家設定裡只有一格。
 */
export function queueUrl(endpoint: string, key: string): string {
  return `${endpoint}/q/${key}`;
}

/** 給 UI 顯示用的一行字。 */
export function describeTarget(target: LinkTarget): string {
  return target.kind === "local" ? `本機 :${target.port}` : target.endpoint;
}
