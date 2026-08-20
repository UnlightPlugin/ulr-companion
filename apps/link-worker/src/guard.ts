/**
 * 上線前的四道關卡（純函式，無 I/O）
 * ====================================
 * 階段 4 的東西全部集中在這裡，理由跟 `rooms.ts`／`protocol.ts` 一樣：
 * **這些規則錯了會安靜地壞掉**，所以它們必須是可以單獨測的純函式，
 * 而 `room.ts` 只負責把它們串起來。
 *
 * 本機 broker（`broker.ts`）不需要這一層 —— 它只聽 127.0.0.1，能連上它的
 * 只有你自己。**一放到公網，「誰都連得到」就變成前提**，這四條是那個前提
 * 帶來的最小成本：
 *
 * 1. 房號格式 —— 只收長得像雜湊的東西
 * 2. **大廳一律拒絕** —— 見 `parseRoomPath()`，這是最容易漏掉的一條
 * 3. 訊息大小上限 —— 一則訊息最大就那麼大，超過直接斷
 * 4. 流量上限 —— 令牌桶，防止有人狂送 `ready` 洗對手的反悔窗口
 */

import { LOBBY_ROOM_KEY, ROOM_KEY_LENGTH } from "@ulr/arbiter-link/protocol";

/** 房間的路徑前綴。`wss://……/r/<房號>` */
export const ROOM_PATH_PREFIX = "/r/";

/** 配對佇列的路徑前綴。`wss://……/q/<配對鍵>`（WP-16） */
export const QUEUE_PATH_PREFIX = "/q/";

/** 健康檢查。給 uptime 監控用的，也讓客戶端連線前問得到協定版本。 */
export const HEALTH_PATH = "/health";

/** 自動更新的發布清單。`apps/tray/src/updater.ts` 每小時來要一次。 */
export const UPDATE_PATH = "/update";

/** 預設 COST 表。`apps/tray/src/rule-feed.ts` 每小時來要一次。 */
export const RULES_PATH = "/rules";

/**
 * 從網址路徑取出房號。**不合格一律回 `null`，呼叫端要回 404。**
 *
 * ⚠⚠ **大廳（`lobby`）在雲端版必須拒絕。**
 *
 * 本機版有 `LOBBY_ROOM_KEY`，所有「還在大廳」的插件待在同一間房 —— 在
 * 127.0.0.1 上那完全無害，因為那間房裡只有你自己的實例。放到公網之後同一行
 * 程式碼的意思完全變了：
 *
 *   · 全世界沒在對戰的人都會擠進**同一個** Durable Object（單點瓶頸）
 *   · 而 `ROOM_CAPACITY = 2` 會讓其中兩個**素不相識的人真的被配成一對**，
 *     開始交換 prefs、湊 `both-ready` —— 他們根本不在同一場對戰
 *   · 第三個以後的人一律收到 `room-full`，看起來像插件壞了
 *
 * 這是「同一份程式碼、換個部署位置就從無害變成錯誤」的典型例子。客戶端那邊
 * 對應的規則是：**沒進對戰就不要連上來**（階段 3 要改的事）。
 */
export function parseRoomPath(pathname: string): string | null {
  if (!pathname.startsWith(ROOM_PATH_PREFIX)) return null;
  const key = pathname.slice(ROOM_PATH_PREFIX.length);
  if (key === LOBBY_ROOM_KEY) return null;
  // `roomKey()` 產出的是 SHA-256 的前 16 個十六進位字元。只收長這樣的東西，
  // 順便擋掉「把這裡當成通用聊天中繼」的用法。
  if (key.length !== ROOM_KEY_LENGTH) return null;
  return /^[0-9a-f]+$/.test(key) ? key : null;
}

/**
 * 一則訊息的位元組上限。
 *
 * 協定裡最大的一則是 `hello`（版本 + 房號 + 四個偏好），實測不到 200 bytes。
 * 2 KB 給了十倍以上的餘裕，同時讓「送一則 10 MB 的 JSON 把記憶體吃光」這條
 * 路直接消失。⚠ 是**先量大小再 decode** —— 反過來的話大的那一則已經被
 * `JSON.parse` 過了，擋了等於沒擋。
 */
export const MAX_MESSAGE_BYTES = 2048;

/**
 * 令牌桶：每秒補 `refillPerSecond` 個，最多存 `capacity` 個，送一則用一個。
 *
 * 為什麼需要它：`ready` 是**邊緣觸發**的（`rooms.ts` 發完 `both-ready` 會把
 * 兩邊的旗標收掉）。有人用腳本每秒送幾百次 `ready: true`，對手每次按下 OK
 * 都會在同一瞬間被湊成 `both-ready` 送出去 —— 等於**把對手的反悔窗口洗掉**，
 * 而畫面上看不出任何異常。
 *
 * 容量 20、每秒補 5：正常玩家一個階段大概動個位數次，20 是綽綽有餘的突發量；
 * 腳本連續灌的話一秒就見底。
 *
 * ⚠ 桶子刻意**只放在記憶體裡**，不寫進 attachment。hibernation 之後桶子會
 * 滿血復活 —— 但要進 hibernation 得先閒置一段時間，而那段時間本來就足夠把
 * 桶子補滿。多寫一次 attachment 換不到任何東西。
 */
export class TokenBucket {
  #tokens: number;
  #lastMs: number;

  constructor(
    private readonly capacity = 20,
    private readonly refillPerSecond = 5,
    nowMs = 0,
  ) {
    this.#tokens = capacity;
    this.#lastMs = nowMs;
  }

  /** 現在還剩幾個（測試與診斷用）。 */
  get tokens(): number {
    return this.#tokens;
  }

  /** 拿一個。拿得到回 `true`，桶子空了回 `false`（呼叫端要丟掉那則訊息）。 */
  take(nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.#lastMs);
    this.#lastMs = nowMs;
    this.#tokens = Math.min(this.capacity, this.#tokens + (elapsed / 1000) * this.refillPerSecond);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/**
 * 關閉連線用的代碼。**1000～2999 是保留給協定本身的**，自訂一律用 4000 以上。
 *
 * 為什麼要分這麼細：客戶端看到 4001 要知道「我連錯房間了，換個網址重連」，
 * 看到 4008 要知道「我送太快了，不要立刻重連」。全部用同一個代碼的話，
 * 客戶端唯一能做的就是無腦重連，而那對 4008 剛好是最糟的反應。
 */
export const CLOSE_WRONG_ROOM = 4001;
export const CLOSE_TOO_BIG = 4009;
export const CLOSE_TOO_FAST = 4008;

/**
 * 寫進 log 的房號一律截短。
 *
 * 房號已經是雜湊過的（`protocol.ts` 紅線 3），本身不含身分；截短是第二層 ——
 * log 會被送去 Cloudflare 的觀測後台，而完整房號加上時間戳記足以把兩個人
 * 「在同一場」這件事連起來。診斷只需要分辨得出是不是同一間房，8 個字元夠了。
 * 本機 broker 也是這樣印的。
 */
export function shortRoom(room: string): string {
  return room.slice(0, 8);
}

/**
 * 從網址路徑取出配對鍵。
 *
 * 驗證規則跟房號**刻意一模一樣**（16 個十六進位字元）—— `matchKey()` 與
 * `roomKey()` 都是 SHA-256 的前 16 個字元。這也順便擋掉「把這裡當成通用
 * 聊天中繼」的用法。
 *
 * ⚠ 沒有「大廳」的對應概念要擋：配對鍵一定含規則 hash，不存在一個所有人
 * 都會算出來的預設值。
 */
export function parseQueuePath(pathname: string): string | null {
  if (!pathname.startsWith(QUEUE_PATH_PREFIX)) return null;
  const key = pathname.slice(QUEUE_PATH_PREFIX.length);
  if (key.length !== ROOM_KEY_LENGTH) return null;
  return /^[0-9a-f]+$/.test(key) ? key : null;
}

/** 等待人數的路由：`/qn?k=<鍵>&k=<鍵>…[&t=<規則標籤>]`。 */
export const COUNT_PATH = "/qn";

/**
 * 只數這一份規則的人。查詢字串的參數名。
 *
 * ⚠ **這是「幾個人在等」跟「幾個人我打得到」的差別。** 配對鍵裡沒有規則版本
 * （那是刻意的，見 `matchCriteriaString`），所以同一條佇列上會站著規則內容
 * 不同的人 —— 他們配得到彼此的機率要看驗算過不過。畫面上寫「1 位玩家等待中」
 * 而那個人永遠配不到，比寫 0 還糟。
 *
 * ⚠ 標籤是 `ruleTag(配對鍵, contentHash)` —— **拌過配對鍵**，所以中間人拿它
 * 串不起「同一個人在不同頻道用的是不是同一份規則」（見 `ruleTag` 的說明）。
 */
export const COUNT_TAG_PARAM = "t";

/** Worker 轉給 DO 時加在路徑尾巴的記號。DO 靠它分辨「這是要人數不是要連線」。 */
export const COUNT_SUFFIX = "/count";

/**
 * 一次最多問幾條佇列。
 *
 * ⚠ **一定要有上限。** 每一個鍵都是一次 DO 的往返，而這條路由是**沒有身分、
 * 誰都打得到**的 —— 沒有上限的話一個請求就能叫醒任意多個 Durable Object，
 * 那是一條免費的放大攻擊。四是實際需要的數字（亞城也只有四檔），留 8 是餘裕。
 */
export const MAX_COUNT_KEYS = 8;

/**
 * 取出要問的那幾條佇列。**格式不對一律回 `null`，呼叫端要回 400。**
 *
 * 驗證跟 `parseQueuePath` 完全一樣（16 個十六進位字元）—— 兩邊的判準要是同一
 * 個，否則會出現「連得上但問不到人數」這種只在其中一條路上發生的怪狀況。
 */
export function parseCountKeys(url: URL): string[] | null {
  if (url.pathname !== COUNT_PATH) return null;
  const keys = url.searchParams.getAll("k");
  if (keys.length === 0 || keys.length > MAX_COUNT_KEYS) return null;
  for (const key of keys) {
    if (!isCountToken(key)) return null;
  }
  return keys;
}

/**
 * 每一條佇列要數的是哪一份規則。**沒帶就是全部都數**（舊版插件會這樣）。
 *
 * ⚠⚠ **位置對位置**：第 i 個 `t` 配第 i 個 `k`。標籤是拌過配對鍵的
 * （`ruleTag(配對鍵, contentHash)`），所以同一份規則在四個檔位上是四個不同的
 * 字串 —— 不能只帶一個。數量對不上就是呼叫端組錯了，直接 400。
 *
 * ⚠ 格式不對回 `null` 而不是「當成沒帶」—— 兩者的差別是一個回 400、一個
 * 安靜地回一個比較大的數字，而後者查起來會是「人數怎麼有時候對有時候不對」。
 *
 * | 回傳        | 意思                           |
 * | ----------- | ------------------------------ |
 * | `undefined` | 沒帶 → 不挑規則，全部都數      |
 * | `null`      | 帶了但不合法 → 呼叫端要回 400  |
 * | `string[]`  | 跟 `keys` 一樣長的標籤清單     |
 */
export function parseCountTags(url: URL, keyCount: number): string[] | null | undefined {
  const tags = url.searchParams.getAll(COUNT_TAG_PARAM);
  if (tags.length === 0) return undefined;
  if (tags.length !== keyCount) return null;
  for (const tag of tags) {
    if (!isCountToken(tag)) return null;
  }
  return tags;
}

/** 配對鍵與規則標籤是同一種東西：16 個十六進位字元。 */
function isCountToken(value: string): boolean {
  return value.length === ROOM_KEY_LENGTH && /^[0-9a-f]+$/.test(value);
}
