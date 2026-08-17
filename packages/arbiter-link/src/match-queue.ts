/**
 * 約戰配對佇列（WP-16）
 * =======================
 * 「兩個用**同一份規則**的人，自動湊成一場有密碼的自訂房。」
 *
 * 跟 `rooms.ts` 的分工完全一樣：這裡是規則、沒有任何 I/O，輸入是「誰送了
 * 什麼」、輸出是「該回誰什麼」。`apps/link-worker/src/queue.ts` 只是膠水。
 *
 * ## 為什麼不能用遊戲自己的快速比賽
 *
 * 實測 `on_server_status`：
 *
 *     channels = { "1": { type: "ranked", cost: [57,66,78] },   ← 亞歷山卓城
 *                  "2": { type: "duel" } }                       ← 迪特赫姆
 *
 * `quick_wait` 是**伺服器端**的佇列，只有 ranked 頻道有，而且 COST 階層是
 * 伺服器定的。自訂規則的約戰只能發生在 duel 頻道，那裡沒有佇列 —— 所以
 * 配對這一段必須由我們自己做。
 *
 * ## 配對鍵決定「誰有機會碰到誰」，不決定「這場算不算數」
 *
 * 排隊時帶的 `key` 是 `matchKey()` 算出來的。**條件不一樣的人算出來的 key
 * 不一樣，落在不同的 Durable Object，物理上就配不到對方。**
 *
 * ⚠⚠ **v2 起，配對鍵裡是 `ruleSetId` 而不是整份規則的 `contentHash`。**
 * 這是 2026-08-16 改的，理由是 v1 把「版本相同」當成配對的必要條件，而那太
 * 嚴格：兩份規則只差在最新角色的定價、雙方都沒帶那隻上場時，那個差異對這一場
 * 沒有任何可觀測影響，卻讓兩人永遠配不到對方 —— 規則每發一版就把社群切一半。
 *
 * 換成 `ruleSetId` 之後，**同一套規則的不同版本會排在同一條佇列**，能不能真的
 * 開打改由配對成立**之後**的語義驗算決定（`@ulr/cost-engine` 的
 * `crossVerdict`，流程見下面）。不同規則（燈皇 vs 亞城）仍然是物理上碰不到。
 *
 * ⚠ 中間人**看不到也不需要看到**規則內容、玩家身分、牌組。它只知道
 * 「有兩條連線報了同一個不透明字串」，以及後面那兩則訊息的**長度**。
 *
 * ## 湊成之後的握手
 *
 * ```
 *   host                        佇列                        guest
 *    │── q-hello(key) ──────────▶│◀────────── q-hello(key) ──│
 *    │◀── q-matched(host,token,peerTag) ─ q-matched(guest,…) ▶│
 *    │                           │                           │
 *    │  peerTag 跟我的一樣 → EXACT，跳過下面兩步              │
 *    │                           │                           │
 *    │── q-deck(我的牌組描述子) ▶│◀──────── q-deck(描述子) ──│
 *    │◀── q-deck(對手的) ────────│──────── q-deck(對手的) ──▶│
 *    │  各自用**自己那份規則**算兩副牌，得到兩個指紋           │
 *    │── q-eval(host指紋,guest指紋) ─▶│◀───── q-eval(…) ─────│
 *    │  四個指紋兩兩相等 → COMPATIBLE，否則 INCOMPATIBLE      │
 *    │                           │                           │
 *   建房(pass=token)             │                           │
 *    │── q-room(roomId) ────────▶│──────── q-room(roomId) ──▶│
 *    │                           │                        進房(roomId, token)
 * ```
 *
 * `token` 同時是**房間密碼**（遊戲自己的密碼就是 8 碼英數，格式一致），
 * 所以外人看得到那間房卻進不去。
 *
 * ⚠ `roomId` 要**由 host 轉發**而不是讓 guest 去掃房間清單：房名由玩家自訂，
 * 掃清單得靠字串比對，撞名就會進錯房。
 *
 * ## ⚠ 佇列不解讀 `q-deck` / `q-eval` 的內容
 *
 * 兩則都只有一個不透明的 `body` 字串，佇列原封不動轉給對手。這不是偷懶：
 * 描述子的格式屬於**插件與插件之間**的契約（`@ulr/cost-engine`），佇列跟著
 * 認識它的話，格式一改就要連中間人一起發版，而中間人是所有人共用的那一台。
 */

import { createHash } from "node:crypto";
import { LINK_PROTOCOL_VERSION } from "./protocol.js";

/** 配對鍵的長度。跟 `ROOM_KEY_LENGTH` 一致 —— 兩者都是 SHA-256 的前 16 個字元。 */
export const MATCH_KEY_LENGTH = 16;

/** 房間密碼／握手 token 的長度。遊戲自己產生的也是 8 碼，格式對齊。 */
export const MATCH_TOKEN_LENGTH = 8;

/** 遊戲密碼用的字元集，照抄它自己的。 */
export const MATCH_TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// ---------------------------------------------------------------------------
// 訊息
// ---------------------------------------------------------------------------

export type QueueRole = "host" | "guest";

/**
 * 轉發訊息裡 `body` 的長度上限。
 *
 * ⚠ 這是**佇列唯一對 `body` 做的檢查**。上限存在的理由不是省流量，是
 * `apps/link-worker` 的 `MAX_MESSAGE_BYTES`（2048）—— 而 `body` 本身是一段
 * JSON，包進外層信封時每個引號都會被跳脫，**最壞情況長度會翻倍**。900 翻倍
 * 之後加上信封仍在 2048 以內；反過來訂 1200 的話，一則塞滿引號的 body 會讓
 * 中間人以「訊息太大」直接斷線，而那看起來完全像是網路問題。
 *
 * 三隻角色的描述子實測不到 100 字元，所以 900 仍是九倍以上的餘裕，同時讓
 * 「把這裡當成通用檔案中繼」這條路直接消失。
 */
export const MAX_RELAY_BODY_LENGTH = 900;

export type QueueClientMessage =
  /** 第一則。`key` 是 `matchKey()` 算出來的，佇列不解讀它。 */
  | { t: "q-hello"; v: number; key: string; tag: string }
  /** 我的牌組描述子。**佇列不解讀 `body`**，原封不動轉給對手。 */
  | { t: "q-deck"; body: string }
  /** 我用自己那份規則算出來的兩個指紋。同樣不被解讀。 */
  | { t: "q-eval"; body: string }
  /**
   * 我的開房偏好（目前只有對戰地點）。同樣是不透明的 `body`。
   *
   * ⚠ 這則是**插件與插件之間**的約定：雙方選不同地點時要協商出一個
   * （見 `@ulr/arbiter-engine` 的 `negotiateStage`），而開房的只有 host ——
   * 他需要知道對手想打哪裡。佇列照樣一個字都不解讀。
   */
  | { t: "q-pref"; body: string }
  /** host 建好房了，把 room_id 轉給對手。 */
  | { t: "q-room"; roomId: string }
  /**
   * 這一對配不成（規則語義對不起來），把我放回佇列。
   *
   * ⚠ 跟 `q-cancel` 的差別是**佇列會記住這一對試過了**，否則兩個人會在
   * FIFO 裡立刻再被湊成同一對，變成一個永遠不會結束的迴圈。
   */
  | { t: "q-reject" }
  /** 我不等了。對手會收到 `q-dropped`，回到排隊狀態。 */
  | { t: "q-cancel" };

export type QueueServerMessage =
  /** `q-hello` 的回覆。`waiting` 是**含自己**在排隊的人數。 */
  | { t: "q-welcome"; v: number; waiting: number }
  /**
   * 湊成了。兩邊各自拿到自己的角色、共用的 token，以及**對手的規則標籤**。
   *
   * `peerTag` 跟自己的一樣就是同一份規則（`exact`），可以跳過整段語義驗算。
   */
  | { t: "q-matched"; role: QueueRole; token: string; peerTag: string }
  /** 對手的牌組描述子／指紋／開房偏好，原封不動。 */
  | { t: "q-deck"; body: string }
  | { t: "q-eval"; body: string }
  | { t: "q-pref"; body: string }
  /** host 的房開好了（只有 guest 會收到）。 */
  | { t: "q-room"; roomId: string }
  /** 配對對象跑掉了 —— 取消、關掉插件、連線斷了、或規則對不起來。要退回排隊。 */
  | { t: "q-dropped"; reason: DropReason }
  /** 版本不合。收到的一方不要重試。 */
  | { t: "q-incompatible"; v: number; reason: string };

/**
 * 為什麼被放回佇列。
 *
 * `rejected` 要跟另外兩個分開，因為玩家看到的訊息完全不同：前兩個是「對方
 * 走了」，這個是「你們兩位的規則版本算出來的東西不一樣，繼續找下一位」——
 * 後者若寫成「對方取消了」，玩家會以為自己一直被人挑掉。
 */
export type DropReason = "cancel" | "gone" | "rejected";

export type QueueMessage = QueueClientMessage | QueueServerMessage;

export interface QueueOutgoing {
  to: string;
  message: QueueServerMessage;
}

// ---------------------------------------------------------------------------
// 配對鍵
// ---------------------------------------------------------------------------

export interface MatchCriteria {
  /**
   * 規則族 —— `publisherSlug/ruleSlug`，例如 `lampking/arcadia-balance`。
   *
   * ⚠⚠ **這裡放的是 `ruleSetId` 而不是 `contentHash`，而且那是整個 v2 的
   * 重點。** 放整份規則的 hash 等於宣告「版本不同就不准打」，而版本不同不
   * 蘊含這一場會算出不同的結果 —— 那個判斷要留給配對成立之後的語義驗算。
   *
   * 代價要講清楚：同一條佇列上現在會有**真的不相容**的人，他們會配成一對
   * 然後被驗算擋下來、各自退回佇列（`q-reject`）。這是刻意的取捨 ——
   * 多一次握手，換掉「規則作者一發新版，社群就分裂成兩半」。
   *
   * 拿別人的 `ruleSetId` 亂填也只能污染那條佇列一次：驗算過不了就配不成。
   */
  ruleSetId: string;
  /** 遊戲頻道編號。不同頻道的房間互相看不到，配在一起沒有意義。 */
  channel: number;
  /**
   * `3vs3` 之類。遊戲的 `multi` 旗標。
   *
   * ⚠ **插件現在永遠送 `true`**（3vs3，見 `@ulr/arbiter-engine` 的 `ROOM_MULTI`）
   * —— 玩家選不到，所以實務上這一格是常數。欄位留著是因為
   * {@link matchCriteriaString} 的格式**發布之後就不能改**。
   */
  multi: boolean;
  /**
   * 約定的隊伍 COST 上限。`null` = 不設限。
   *
   * ⚠ 這個值**不會**送進遊戲的「牌組 Cost 限制」欄位 —— 那個欄位是伺服器
   * 用**原版 COST** 判的，跟自訂規則對不上。它只用來把「約定同一個上限」
   * 的人配在一起，實際檢查由**雙方各自**在開打前對自己那副牌做
   * （見 docs/match-making.md）。
   */
  costLimit: number | null;
}

/**
 * 配對鍵的原始字串。**發布之後這個格式就不能改了** —— 改了會讓新舊版本的
 * 插件算出不同的鍵，症狀是「明明條件一樣卻永遠配不到對方」。
 *
 * ⚠ 版本前綴從 `ulr-match-v1` 換成 `v2`，因為第二個欄位的意思整個變了
 * （整表 hash → 規則族）。**不換前綴的話最糟**：舊版插件用 hash、新版用
 * ruleSetId，兩者長得都像一串字，於是各自算出合法但不同的鍵，症狀又是
 * 「安靜地配不到人」。前綴換掉，至少兩個版本是乾淨地互相看不見。
 */
export function matchCriteriaString(c: MatchCriteria): string {
  // 固定順序、固定分隔符。任何一個欄位的表示法變了，配對鍵就會變，
  // 所以這裡的格式一旦發布就不能改。
  return [
    "ulr-match-v2",
    c.ruleSetId,
    String(c.channel),
    c.multi ? "multi" : "single",
    c.costLimit === null ? "nolimit" : c.costLimit.toFixed(2),
  ].join("|");
}

/**
 * 規則版本在**這一條佇列**裡的代號。`q-hello` 帶上來，湊成一對時原封轉給對手。
 *
 * 兩邊要有辦法判斷「我們是不是同一份規則」才能走 `exact` 快路（省掉整段
 * 牌組交換）。但直接把 `contentHash` 送上去等於告訴中間人「這個人在玩燈皇
 * 1.2.0」—— contentHash 是公開規則的識別碼，查得到。
 *
 * 拌上**配對鍵**之後，同一份規則在不同佇列裡是不同的字串，所以中間人的記錄
 * 串不起「這個人在頻道 2 用的規則，跟他在頻道 4 用的是同一份」。
 *
 * ⚠ **這不是保密，是去連結（unlinkability）。** 中間人知道那條佇列的鍵，
 * 真要查的話仍可以拿公開規則清單逐一試算標籤。它擋掉的是「打開 log 就看到
 * 版本號」這種被動的洩漏，擋不掉一個主動想查的中間人 —— 那件事的保證只有
 * 一個：**中間人不需要這個值，所以它不存**。這一段跟房號雜湊是同樣的立場，
 * 差別在房號能做到數學保證，這裡做不到，所以要講清楚而不是假裝做得到。
 */
export function ruleTag(salt: string, ruleHash: string): string {
  const bare = ruleHash.startsWith("sha256:") ? ruleHash.slice(7) : ruleHash;
  return createHash("sha256")
    .update(`ulr-rule-tag-v1|${salt}|${bare}`, "utf8")
    .digest("hex")
    .slice(0, MATCH_KEY_LENGTH);
}

/**
 * 條件 → 配對鍵。**同樣的條件一定得到同樣的字串**，這是配對成立的全部原理。
 *
 * ⚠ 取雜湊而不是直接把條件放進網址，有兩個理由：
 *
 * 1. **中間人不該知道玩家在用哪份規則。** contentHash 是公開規則的識別碼，
 *    直接送上去等於告訴伺服器「這個人在玩燈皇 1.2.0」。雜湊過之後它只是
 *    一個不透明字串。
 * 2. 長度固定，路由的驗證跟房號共用同一條規則。
 */
export function matchKey(c: MatchCriteria): string {
  return createHash("sha256")
    .update(matchCriteriaString(c), "utf8")
    .digest("hex")
    .slice(0, MATCH_KEY_LENGTH);
}

// ---------------------------------------------------------------------------
// 佇列
// ---------------------------------------------------------------------------

export interface Waiter {
  readonly id: string;
  /** 已經配到誰。`null` = 還在排隊。 */
  partner: string | null;
  role: QueueRole | null;
  token: string | null;
  /**
   * 這個人的規則標籤（`ruleTag()`）。湊成對時轉給對手，佇列自己**不比對它** ——
   * 標籤相同或不同都一樣配，能不能開打是插件那邊驗算的事。
   */
  tag: string;
  /**
   * 已經試過、驗算沒過的對手。**不會再跟這些人配**。
   *
   * ⚠ 少了這張清單，兩個規則對不起來的人會在 FIFO 裡被立刻重新湊成同一對，
   * 然後再次驗算失敗、再次退回 —— 一個以毫秒為單位的無窮迴圈，而且兩邊的
   * 畫面上只會看到「配對中」一直閃。
   *
   * ⚠ 記的是連線 id，所以對方重連之後會拿到新 id、可以再配一次。這是刻意的
   * 折衷：記久一點要有跨連線的身分，而中間人**刻意沒有身分概念**。
   */
  tried: string[];
}

/** 產生 token 用的亂數來源。測試會塞一個確定性的。 */
export type TokenSource = () => string;

/**
 * 預設的 token 產生器。
 *
 * ⚠ 用 `crypto.getRandomValues` 而不是 `Math.random()` —— 這個字串**就是房間
 * 密碼**，猜得到就等於別人可以插進你的約戰房。`Math.random` 在 V8 上是
 * xorshift128+，看過幾個輸出就能推出後續。（遊戲自己用的是 `Math.random`，
 * 那是它的選擇，我們不必跟著。）
 */
export function defaultTokenSource(): string {
  const bytes = new Uint8Array(MATCH_TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += MATCH_TOKEN_ALPHABET[b % MATCH_TOKEN_ALPHABET.length];
  return out;
}

/**
 * 一個配對鍵底下的佇列。
 *
 * 一個 Durable Object 實例 = 一個配對鍵 = 一條佇列，跟 `LinkRoom` 的
 * 「一個實例 = 一間房」是同一個模式。
 */
export class MatchQueue {
  #waiters = new Map<string, Waiter>();
  #order: string[] = [];
  #token: TokenSource;

  constructor(tokenSource: TokenSource = defaultTokenSource) {
    this.#token = tokenSource;
  }

  get size(): number {
    return this.#waiters.size;
  }

  /** 還在排隊（沒配到人）的數量。 */
  get waiting(): number {
    return [...this.#waiters.values()].filter((w) => w.partner === null).length;
  }

  waiterOf(id: string): Waiter | null {
    return this.#waiters.get(id) ?? null;
  }

  /** 給雲端版 hibernation 醒來後重建狀態用，**不產生任何訊息**。 */
  restore(waiter: Waiter): void {
    this.#waiters.set(waiter.id, { ...waiter, tried: [...waiter.tried] });
    if (!this.#order.includes(waiter.id)) this.#order.push(waiter.id);
  }

  join(id: string, message: QueueClientMessage & { t: "q-hello" }): QueueOutgoing[] {
    if (!isQueueCompatible(message.v)) {
      return [
        {
          to: id,
          message: {
            t: "q-incompatible",
            v: LINK_PROTOCOL_VERSION,
            reason: `協定版本 ${message.v} 與中間人的 ${LINK_PROTOCOL_VERSION} 不相容`,
          },
        },
      ];
    }

    // ⚠ 重送 `q-hello`（重連）時要**留著 tried**，否則剛剛驗算失敗的那一對
    // 會馬上又被湊起來 —— 那正是 tried 要防的迴圈。
    const previous = this.#waiters.get(id);

    // ⚠⚠ 已經配到人的時候又送一次 `q-hello`，**對手要被放回佇列**。
    // 少了這一段，對手會停在「已配對」而它的對象已經不認得它了 —— 它不在
    // `free` 裡（湊不到新的人），也不會收到任何訊息，於是永遠卡著。
    // 我們自己的客戶端不會走到這條（重連會拿到新的 id，舊的走 `leave()`），
    // 但一個壞掉或惡意的客戶端只要送兩次 `q-hello` 就能把別人凍在那裡。
    const out: QueueOutgoing[] = [];
    if (previous !== undefined) out.push(...this.#detachPartner(previous, "gone"));

    this.#waiters.set(id, {
      id,
      partner: null,
      role: null,
      token: null,
      tag: message.tag,
      tried: previous?.tried ?? [],
    });
    if (!this.#order.includes(id)) this.#order.push(id);

    out.push({
      to: id,
      message: { t: "q-welcome", v: LINK_PROTOCOL_VERSION, waiting: this.waiting },
    });
    out.push(...this.#tryPair());
    return out;
  }

  handle(id: string, message: QueueClientMessage): QueueOutgoing[] {
    const me = this.#waiters.get(id);
    if (me === undefined) return [];

    switch (message.t) {
      case "q-hello":
        return this.join(id, message);

      case "q-room": {
        // ⚠ 只有 host 能轉 roomId，而且只轉給它自己的對手。少了這兩個檢查，
        // 同一條佇列上的任何人都能把別人騙進任意房間。
        if (me.role !== "host" || me.partner === null) return [];
        const partner = this.#waiters.get(me.partner);
        if (partner === undefined) return [];
        return [{ to: partner.id, message: { t: "q-room", roomId: message.roomId } }];
      }

      // 牌組描述子、指紋與開房偏好：**只轉給自己的對手，內容一個字都不解讀**。
      // ⚠ 還沒配到人就送 = 沒有對手可以轉，直接丟掉（不是錯誤：連線競態下
      // 對手可能剛好在同一刻斷線）。
      case "q-deck":
      case "q-eval":
      case "q-pref": {
        if (me.partner === null) return [];
        const partner = this.#waiters.get(me.partner);
        if (partner === undefined) return [];
        return [{ to: partner.id, message: { t: message.t, body: message.body } }];
      }

      case "q-reject":
        return this.#unpair(id, "rejected");

      case "q-cancel":
        return this.leave(id, "cancel");
    }
  }

  /** 連線斷了或主動取消。對手會被放回佇列，可以再配下一個。 */
  leave(id: string, reason: Exclude<DropReason, "rejected"> = "gone"): QueueOutgoing[] {
    const me = this.#waiters.get(id);
    if (me === undefined) return [];

    this.#waiters.delete(id);
    this.#order = this.#order.filter((x) => x !== id);

    const out = this.#detachPartner(me, reason);
    out.push(...this.#tryPair());
    return out;
  }

  /**
   * 把某個人的對手放回佇列並通知他。**不動這個人自己的狀態。**
   *
   * 抽出來是因為有兩個入口（斷線／取消，以及重送 `q-hello`），而漏掉任何一個
   * 的症狀都一樣：有人停在「已配對」等一場永遠不會開始的對局。
   */
  #detachPartner(me: Waiter, reason: DropReason): QueueOutgoing[] {
    if (me.partner === null) return [];
    const partner = this.#waiters.get(me.partner);
    if (partner === undefined) return [];

    this.#release(partner);
    // 對手退回佇列頭 —— 他已經等過一輪了，不該再排到最後面。
    this.#order = [partner.id, ...this.#order.filter((x) => x !== partner.id)];
    return [{ to: partner.id, message: { t: "q-dropped", reason } }];
  }

  /**
   * 拆對但**兩個人都留在佇列裡**。驗算沒過走這條。
   *
   * ⚠ 兩邊都要記下對方，而且**兩邊都要收到 `q-dropped`** —— 只通知一邊的話，
   * 另一邊會一直等一場永遠不會開始的對局。
   */
  #unpair(id: string, reason: DropReason): QueueOutgoing[] {
    const me = this.#waiters.get(id);
    if (me === undefined || me.partner === null) return [];
    const partner = this.#waiters.get(me.partner);

    this.#release(me);
    if (partner !== undefined) {
      this.#release(partner);
      if (!partner.tried.includes(id)) partner.tried.push(id);
      if (!me.tried.includes(partner.id)) me.tried.push(partner.id);
    }

    const out: QueueOutgoing[] = [{ to: me.id, message: { t: "q-dropped", reason } }];
    if (partner !== undefined) out.push({ to: partner.id, message: { t: "q-dropped", reason } });
    out.push(...this.#tryPair());
    return out;
  }

  /** 把一個人的配對狀態清乾淨（`tried` 要留著）。 */
  #release(waiter: Waiter): void {
    waiter.partner = null;
    waiter.role = null;
    waiter.token = null;
  }

  /**
   * 有兩個以上在等就湊一對。**先到先配**（FIFO），跳過已經試過的組合。
   *
   * ⚠ 一次只湊一對就好嗎 —— 不，要湊到湊不動為止。一條佇列上可能同時有四個人
   * （例如中間人剛從 hibernation 醒來、大家一起重連），只湊一對會讓另外兩個
   * 明明可以配卻繼續等。
   *
   * ⚠ 有了 `tried` 之後就**不能只看前兩個**：隊伍前面那兩位可能剛剛才驗算
   * 失敗，而第三位跟他們任何一位都配得起來。所以是「第一個沒配到的人，往後
   * 找第一個沒試過的」。
   */
  #tryPair(): QueueOutgoing[] {
    const out: QueueOutgoing[] = [];

    for (;;) {
      const free = this.#order
        .map((id) => this.#waiters.get(id))
        .filter((w): w is Waiter => w !== undefined && w.partner === null);

      const pair = firstPairing(free);
      if (pair === null) break;

      const [a, b] = pair;
      const token = this.#token();

      a.partner = b.id;
      a.role = "host";
      a.token = token;
      b.partner = a.id;
      b.role = "guest";
      b.token = token;

      // ⚠ 對手的規則標籤要在這裡就給 —— 插件靠它決定要不要走整段牌組交換，
      // 少了它每一場都得多兩趟往返（而絕大多數的配對是同一份規則）。
      out.push({ to: a.id, message: { t: "q-matched", role: "host", token, peerTag: b.tag } });
      out.push({ to: b.id, message: { t: "q-matched", role: "guest", token, peerTag: a.tag } });
    }

    return out;
  }
}

/**
 * 從等待中的人裡挑出第一組**沒試過**的組合。先到的當 host。
 *
 * 抽成純函式是因為它是整條佇列裡唯一有分支的規則，而它錯了的症狀
 * （某些人永遠配不到、或兩個人無限重配）在真的跑起來時很難分辨。
 */
export function firstPairing(free: readonly Waiter[]): [Waiter, Waiter] | null {
  for (let i = 0; i < free.length; i++) {
    const a = free[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < free.length; j++) {
      const b = free[j];
      if (b === undefined) continue;
      if (a.tried.includes(b.id) || b.tried.includes(a.id)) continue;
      return [a, b];
    }
  }
  return null;
}

/** 佇列的協定相容性。目前跟中間人共用同一個版本號。 */
export function isQueueCompatible(v: number): boolean {
  return v === LINK_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// 編碼
// ---------------------------------------------------------------------------

export function encodeQueue(message: QueueMessage): string {
  return JSON.stringify(message);
}

/**
 * 解析一則佇列訊息。**壞掉的一律回 `null`，絕不拋例外。**
 *
 * ⚠ 不共用 `protocol.ts` 的 `decode()`：那支只認得房間協定的訊息型別，
 * 硬轉型會讓一則 `{"t":"room-full"}` 被當成佇列訊息傳下去。兩套協定跑在
 * 不同的網址上，各自驗各自的。
 */
export function decodeQueue(raw: string): QueueClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  switch (m["t"]) {
    case "q-hello":
      if (typeof m["v"] !== "number" || typeof m["key"] !== "string") return null;
      // ⚠ 標籤也要驗長度：它會被原封轉給對手，而對手拿它跟自己的比。放一個
      // 一百萬字的字串進去只是浪費兩邊的頻寬與記憶體。
      if (typeof m["tag"] !== "string" || m["tag"].length > 64) return null;
      return { t: "q-hello", v: m["v"], key: m["key"], tag: m["tag"] };
    case "q-deck":
    case "q-eval":
    case "q-pref": {
      const body = m["body"];
      if (typeof body !== "string" || body.length === 0) return null;
      if (body.length > MAX_RELAY_BODY_LENGTH) return null;
      return { t: m["t"], body };
    }
    case "q-room":
      if (typeof m["roomId"] !== "string" || m["roomId"].length === 0) return null;
      return { t: "q-room", roomId: m["roomId"] };
    case "q-reject":
      return { t: "q-reject" };
    case "q-cancel":
      return { t: "q-cancel" };
    default:
      return null;
  }
}

/**
 * 解析中間人送來的一則。**壞掉一律回 `null`。**
 *
 * ⚠ 跟 `decodeQueue()` 是兩支不同的函式，方向相反：那支給中間人用（只認
 * 客戶端會送的），這支給插件用（只認中間人會送的）。合成一支的話，
 * 一則 `q-matched` 會被中間人當成合法輸入 —— 而那則訊息會決定誰開房。
 */
export function decodeQueueServer(raw: string): QueueServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  switch (m["t"]) {
    case "q-welcome":
      if (typeof m["v"] !== "number" || typeof m["waiting"] !== "number") return null;
      return { t: "q-welcome", v: m["v"], waiting: m["waiting"] };
    case "q-matched": {
      const role = m["role"];
      if (role !== "host" && role !== "guest") return null;
      if (typeof m["token"] !== "string" || m["token"].length === 0) return null;
      if (typeof m["peerTag"] !== "string" || m["peerTag"].length > 64) return null;
      return { t: "q-matched", role, token: m["token"], peerTag: m["peerTag"] };
    }
    case "q-deck":
    case "q-eval":
    case "q-pref": {
      const body = m["body"];
      if (typeof body !== "string" || body.length === 0) return null;
      if (body.length > MAX_RELAY_BODY_LENGTH) return null;
      return { t: m["t"], body };
    }
    case "q-room":
      if (typeof m["roomId"] !== "string" || m["roomId"].length === 0) return null;
      return { t: "q-room", roomId: m["roomId"] };
    case "q-dropped": {
      const reason = m["reason"];
      if (reason !== "cancel" && reason !== "gone" && reason !== "rejected") return null;
      return { t: "q-dropped", reason };
    }
    case "q-incompatible":
      if (typeof m["v"] !== "number" || typeof m["reason"] !== "string") return null;
      return { t: "q-incompatible", v: m["v"], reason: m["reason"] };
    default:
      return null;
  }
}
