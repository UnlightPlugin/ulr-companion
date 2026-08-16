/**
 * 自動配對：從排隊到開打（WP-16）
 * ==================================
 * 中間人只做一件事 —— 把兩條報了同一個配對鍵的連線湊起來。**「這一場算不算
 * 數」是插件自己判的**，而判準是這個檔案。
 *
 * ```
 *   排隊 ──▶ 湊成一對 ──▶ 規則對得上嗎 ──▶ 我的牌組合法嗎 ──▶ 開房 / 進房
 *                │              │ 不行            │ 不行
 *                │              ▼                 ▼
 *                └──────── 換下一個對手      停止排隊，告訴玩家哪裡要改
 * ```
 *
 * ## 為什麼判斷在客戶端，而這仍然是安全的
 *
 * 舊設計把「規則相同」寫進配對鍵：規則不同的人算出不同的鍵，落在不同的
 * Durable Object，**物理上碰不到**。那個保證很漂亮，但它把「版本不同」誤當成
 * 「不能一起打」（見 `@ulr/cost-engine` 的 `evaluation.ts`）。
 *
 * 換成語義驗算之後，判斷回到客戶端 —— 而客戶端是玩家自己的機器。改過的插件
 * 可以跳過驗算嗎？可以，但**沒有用**：
 *
 *   · 開房的是 host、進房的是 guest，**兩邊都得各自走完自己那半段**
 *   · 對手的插件會獨立算一次，算不過就不會進來
 *
 * 所以要繞過去必須**兩邊都改過**，而那時他們本來就是講好的 —— 兩個講好的人
 * 從來就可以不裝插件直接開房。這跟準備／秒數協商是同一條原則：
 * **會改變勝負的東西一律要雙方都同意才生效**（README「公平性立場」）。
 *
 * ## ⚠ 對手的牌組不會出現在畫面上
 *
 * 跨版本驗算要交換牌組描述子，所以插件**知道**對手帶了哪三隻。它只拿去算
 * 指紋，然後就丟掉：
 *
 *   · 不放進 `PairingStatus`（UI 唯一看得到的東西）
 *   · 不寫進記錄檔
 *   · 沒有任何介面問得到它
 *
 * 這不是隱藏資訊的問題（房間清單本來就把雙方牌組廣播給大廳每一個人，見
 * `@ulr/cdp-adapter` 的 `match-room.ts`），是**運動精神**的問題：看得到對手
 * 帶什麼就能挑對手，而那會讓整個約戰功能失去意義。同一份規則的配對（絕大
 * 多數）根本不會走到交換那一步。
 */

import { contentHash, formatCentiCost, toCentiCost } from "@ulr/rule-schema";
import type { CostRule } from "@ulr/rule-schema";
import {
  calculateTeamCost,
  canonicalDeck,
  crossVerdict,
  deckFromKeys,
  describeDisagreement,
  fingerprint,
  parseDeckDescriptor,
} from "@ulr/cost-engine";
import type { Compatibility, CrossEvaluation, DeckDescriptor } from "@ulr/cost-engine";
import { MatchQueueClient, matchKey, ruleTag } from "@ulr/arbiter-link";
import type {
  DropReason,
  MatchQueueClientOptions,
  QueueRole,
  QueueStatus,
} from "@ulr/arbiter-link";
import { DEFAULT_ROOM_NAME } from "@ulr/cdp-adapter";
import type { MatchDriver, PreflightResult, Sleep } from "./match-session.js";
import { guestJoinRoom, hostOpenRoom, preflight } from "./match-session.js";

/** 沒給 `sleep` 時用的那支。測試一律自己塞一個立刻回來的。 */
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等對手回話的上限。
 *
 * ⚠ 一定要有。對手的插件可能在送出描述子之後就被關掉、或卡在一個沒有回應的
 * CDP 呼叫上 —— 沒有逾時的話我方會停在「對規則中…」直到玩家自己發現不對。
 * 12 秒是「人類會開始懷疑」之前的長度，而正常的一次往返是毫秒級。
 */
export const PEER_REPLY_TIMEOUT_MS = 12_000;

/**
 * host 開好房之後，多久看一次「對手進來了沒」。
 *
 * ⚠ 這一段是**配對任務的終點**，不是附加功能。少了它，host 開完房就永遠停在
 * 「等對手進來」：佇列連線還掛著（會被配給第三個人）、`pairing` 物件還活著
 * （玩家按「開始自動配對」只會收到「已經在配對中了」），而那時他其實已經
 * 打完一場了。2026-08-16 實測就是這樣，要手動按停止才回得去。
 */
export const HANDOFF_POLL_MS = 2_000;

/**
 * 等對手進房的上限。
 *
 * 到了還沒人來就把房收掉並停止 —— 留著的話清單上是一間永遠沒人進的空房，
 * 而下一次配對會被 preflight 擋住。90 秒是「對手的插件正常走完進房流程」
 * （幾秒）的十倍以上餘裕。
 */
export const HANDOFF_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// 兩邊交換的東西（純函式，可完整測試）
// ---------------------------------------------------------------------------

/** `q-deck` 的內容。**只有牌組**，沒有身分、沒有規則內容。 */
export function encodeDeckBody(deck: DeckDescriptor): string {
  return JSON.stringify(canonicalDeck(deck));
}

/** 解析對手的 `q-deck`。壞掉一律 `null`。 */
export function parseDeckBody(body: string): DeckDescriptor | null {
  try {
    return parseDeckDescriptor(JSON.parse(body));
  } catch {
    return null;
  }
}

/** `q-eval` 的內容：兩個指紋，`h` 是 host 那副牌、`g` 是 guest 那副。 */
export function encodeEvalBody(cross: CrossEvaluation): string {
  return JSON.stringify({ h: cross.host, g: cross.guest });
}

/**
 * 解析對手的 `q-eval`。
 *
 * ⚠ 兩個欄位都要是字串才算數。少驗一個的話，`undefined === undefined` 會讓
 * 一則空訊息通過比對 —— 那是把「規則相容」判成 true 的最短路徑。
 */
export function parseEvalBody(body: string): CrossEvaluation | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    if (typeof m["h"] !== "string" || m["h"] === "") return null;
    if (typeof m["g"] !== "string" || m["g"] === "") return null;
    return { host: m["h"], guest: m["g"] };
  } catch {
    return null;
  }
}

/**
 * 用**我的**規則算兩副牌的指紋。
 *
 * 名字用 host/guest 而不是「我／對手」：兩邊要比對的是同一組標籤，用相對
 * 稱呼的話 A 的「我」是 B 的「對手」，永遠對不起來。
 */
export function crossEvaluate(
  rule: CostRule,
  decks: { host: DeckDescriptor; guest: DeckDescriptor },
): CrossEvaluation {
  return { host: fingerprint(rule, decks.host), guest: fingerprint(rule, decks.guest) };
}

export interface LimitCheck {
  /** 這副牌在這份規則下的總和，顯示用字串。 */
  total: string;
  /** 超過約定上限了沒。沒有約定上限時永遠 `false`。 */
  over: boolean;
  /** 規則裡沒有定價的鍵。不是空的就代表算出來的數字含 99 這個代替值。 */
  unknown: string[];
}

/**
 * 我這副牌在約定的規則與上限下合不合法。**只看自己那副。**
 *
 * ⚠ 對手那副由**對手自己**檢查。這不是偷懶，是同一條紅線：兩邊都會拒絕
 * 不合法的自己，所以不需要任何一方去審對方 —— 也就不需要把對手的總和顯示
 * 出來（那會變成「先看看對手多少 C 再決定要不要打」）。
 */
export function checkOwnDeck(
  rule: CostRule,
  deck: DeckDescriptor,
  costLimit: number | null,
): LimitCheck {
  const members = canonicalDeck(deck).characters.map((characterId) => ({ characterId }));
  const result = calculateTeamCost(rule, { members });
  return {
    total: formatCentiCost(result.total),
    // ⚠ 上限也要走 `toCentiCost` 轉成整數再比。`total / 100 > limit` 那種寫法
    // 會讓剛好卡滿上限的隊伍被浮點尾巴判成超標 —— 那是 `cost-number.ts`
    // 整支檔案存在的理由。
    //
    // ⚠ 先 `toFixed(2)`：`toCentiCost` 對超過兩位小數的值會**拋例外**，而這個
    // 數字是玩家在輸入框打的。配對鍵那邊（`matchCriteriaString`）也是 toFixed(2)，
    // 兩處要用同一個表示法，否則「畫面上寫 62、實際比 62.001」對不起來。
    over: costLimit !== null && result.total > toCentiCost(Number(costLimit.toFixed(2))),
    unknown: result.unknownIds,
  };
}

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------

export type PairingPhase =
  /** 沒在配對。 */
  | "idle"
  /** 排隊中。 */
  | "queued"
  /** 配到人了，正在對規則。 */
  | "checking"
  /** 我是 host，正在開房。 */
  | "opening"
  /** 我是 guest，正在等房 / 進房。 */
  | "joining"
  /** 成了 —— host 開好房在等人，或 guest 已經進去了。 */
  | "ready"
  /** 停下來了，而且要玩家做點什麼（改牌組、改頻道…）。 */
  | "blocked";

/** UI 唯一看得到的東西。⚠ **裡面沒有任何對手的資訊**，理由見檔頭。 */
export interface PairingStatus {
  phase: PairingPhase;
  /**
   * **中間人那條線真的接上了嗎。**
   *
   * ⚠⚠ 少了這個欄位，「排隊中」是一句謊話。`phase` 在 `start()` 裡就被設成
   * `queued` 了 —— 那時 WebSocket 才剛開始連，而它可能永遠連不上（中間人沒
   * 部署配對佇列、網路不通、位址填錯）。畫面上會是「排隊中 · 只有你」，跟
   * 「連上了但還沒人」**一模一樣**，於是玩家會一直等一條根本不存在的隊伍。
   *
   * 2026-08-16 實測踩到：雲端中間人的 `/q/` 路由回 404（那台還沒更新到有佇列
   * 的版本），兩個客戶端條件完全相同，畫面兩邊都寫「排隊中」，等多久都不會配到。
   *
   * `true` 的意思很窄：**收到過 `q-welcome`**，也就是佇列真的認得我們。
   */
  linked: boolean;
  /** 中間人回報的排隊人數（含自己）。 */
  waiting: number;
  role: QueueRole | null;
  /** 這一對的規則關係。還沒配到人是 `null`。 */
  compatibility: Compatibility | null;
  /** 我這副牌在約定規則下的總和。 */
  myTotal: string | null;
  /** 我這副牌超過約定上限了。 */
  overLimit: boolean;
  /** 規則版本對不起來、換下一個對手的次數。 */
  skipped: number;
  /** 直接顯示給玩家的一句話。 */
  message: string;
}

/**
 * 這支需要中間人做到的事。真的實作是 `MatchQueueClient`，測試餵假的。
 *
 * ⚠ 抽出來是因為**這個狀態機沒辦法用測試以外的方式驗**：真的跑一次要兩個
 * 帳號、兩份不同版本的規則、消耗 AP，而且會把人丟進對戰。而它裡面的每一條
 * 分支錯了都是安靜的 —— 「配到人之後就不動了」看起來跟「還沒配到人」一樣。
 */
export interface QueueLink {
  start(): void;
  stop(): void;
  reject(): void;
  sendDeck(body: string): void;
  sendEval(body: string): void;
  sendRoom(roomId: string): void;
}

export interface PairingOptions {
  /** 中間人的位址（不含路徑）。跟側通道同一台。 */
  endpoint: string;
  /** 約定的規則。**配對一定要有規則** —— 沒有的話不知道在約定什麼。 */
  rule: CostRule;
  channel: number;
  multi: boolean;
  /** 約定的隊伍 COST 上限（用這份規則算）。`null` = 不設限。 */
  costLimit: number | null;
  /** 開房用的欄位。guest 端不會用到，但兩邊的設定要一致才配得到。 */
  room: { name: string; stage: string; friend: boolean; deckCostBand: number | null };
  driver: MatchDriver;
  onStatus?: (status: PairingStatus) => void;
  onLog?: (line: string) => void;
  /** 測試用。 */
  sleep?: Sleep;
  timeoutMs?: number;
  /** host 等對手進房的輪詢間隔與上限。測試會塞很小的值。 */
  handoffPollMs?: number;
  handoffTimeoutMs?: number;
  /** 測試用：換掉中間人的連線。預設是真的 `MatchQueueClient`。 */
  link?: (options: MatchQueueClientOptions) => QueueLink;
}

const IDLE: PairingStatus = {
  phase: "idle",
  linked: false,
  waiting: 0,
  role: null,
  compatibility: null,
  myTotal: null,
  overLimit: false,
  skipped: 0,
  message: "沒在配對。",
};

/**
 * 一次「開始配對」的完整生命週期。
 *
 * ⚠ **`start()` 只能由玩家明確按下的動作觸發**，而且它會走到開房（消耗 AP）
 * 與進房（直接開打）。任何自動重試、輪詢、狀態同步都不准叫它。
 */
export class MatchPairing {
  #options: PairingOptions;
  #client: QueueLink | null = null;
  #status: PairingStatus = IDLE;

  /** 這一對的狀態。每次重新配對都整組清掉。 */
  #role: QueueRole | null = null;
  #token: string | null = null;
  #myDeck: DeckDescriptor | null = null;
  #peerDeck: DeckDescriptor | null = null;
  #myEval: CrossEvaluation | null = null;
  #peerEval: CrossEvaluation | null = null;
  #compatibility: Compatibility | null = null;
  /** guest 收到房號的時間可能早於自己驗算完 —— 先收著。 */
  #pendingRoomId: string | null = null;
  /** host 已經真的開了一間房。對手跑掉時要收掉它。 */
  #openedRoom = false;
  /** host 自己那間房的 room_id。等對手進來要靠它在清單裡認人。 */
  #myRoomId: string | null = null;
  /**
   * host 已經把房號交出去了。
   *
   * ⚠ 這之後收到的 `q-dropped(cancel)` **多半是對手進房成功**：他的插件一進去
   * 就會離開佇列，而離開佇列送的正是 `q-cancel`。照原本的處理（收房 + 退回排隊）
   * 等於在對手剛進門的瞬間把房拆了，而畫面上寫「對手取消了，繼續排隊」。
   */
  #handedOff = false;
  /** 等對手進房的輪詢。跟 `#timer`（等對手回話）是兩件事，不能共用一個。 */
  #watch: ReturnType<typeof setTimeout> | null = null;
  #skipped = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 已經在跑開房／進房了，不要重入。 */
  #committing = false;
  /** 我這份規則在這條佇列上的標籤。`start()` 算一次。 */
  #myTag = "";
  /** 上一次讀牌組時玩家在哪個頻道。`null` = 沒進頻道或讀不到。 */
  #currentChannel: number | null = null;

  constructor(options: PairingOptions) {
    this.#options = options;
  }

  get status(): PairingStatus {
    return this.#status;
  }

  /**
   * 開始排隊。
   *
   * 排隊之前先做三件事，**每一件失敗都要停在 `blocked` 而不是硬排下去**：
   * 讀得到牌組、牌組在約定上限之內、玩家人在約定的頻道且沒有自己的房。
   */
  async start(): Promise<void> {
    if (this.#client !== null) return;

    const pre = await this.#preflight();
    if (!pre.ok) {
      this.#block(pre.block.message);
      return;
    }

    const deck = await this.#readOwnDeck();
    if (deck === null) return;

    const check = checkOwnDeck(this.#options.rule, deck, this.#options.costLimit);
    this.#patch({ myTotal: check.total, overLimit: check.over });
    if (check.over) {
      this.#block(
        `你的隊伍在這份規則下是 ${check.total}，超過約定的 ${String(this.#options.costLimit)}。` +
          `改牌組或把上限調高再排。`,
      );
      return;
    }
    if (check.unknown.length > 0) {
      // ⚠ 不是硬錯誤（對手用同一份規則的話兩邊都算 99，指紋還是對得起來），
      // 但一定要講：99 是代替值，玩家看到的總和不是他以為的那個。
      this.#log(
        `⚠ 這份規則沒有替 ${check.unknown.length} 張卡定價，那些卡一律算 99 —— ` +
          `總和 ${check.total} 不能當真。`,
      );
    }

    const key = matchKey({
      ruleSetId: this.#options.rule.ruleSetId,
      channel: this.#options.channel,
      multi: this.#options.multi,
      costLimit: this.#options.costLimit,
    });
    // ⚠ 算一次就留著。`contentHash` 要把整份規則（700 筆）正規化過一遍，
    // 而配對成立時要拿它跟對手的標籤比 —— 每配到一個人就重算一次是白費的，
    // 而且規則在排隊期間不會變（換規則要先停止配對）。
    this.#myTag = ruleTag(key, contentHash(this.#options.rule));

    const link = this.#options.link ?? ((o) => new MatchQueueClient(o));
    this.#client = link({
      endpoint: this.#options.endpoint,
      key,
      tag: this.#myTag,
      onStatus: (s, waiting) => this.#onQueueStatus(s, waiting),
      onMatched: (info) => void this.#onMatched(info),
      onPeerDeck: (body) => void this.#onPeerDeck(body),
      onPeerEval: (body) => void this.#onPeerEval(body),
      onRoom: (roomId) => void this.#onRoom(roomId),
      onDropped: (reason) => void this.#onDropped(reason),
      ...(this.#options.onLog === undefined ? {} : { onLog: this.#options.onLog }),
    });
    this.#client.start();
    // ⚠ 這裡還**沒有**連上中間人 —— 上面那行只是開始連。所以訊息要說的是
    // 「正在連」，`linked` 要等 `q-welcome` 才會變 true（見 `#onQueueStatus`）。
    this.#patch({
      phase: "queued",
      linked: false,
      message: "正在連中間人…",
    });
  }

  /**
   * 開房／進房前的檢查，**而且會自己把擋路的舊房收掉**。
   *
   * preflight 本身是唯讀的（那是對的，它也給手動那條路用）。但自動配對的
   * 情況不一樣：玩家按下「開始自動配對」，而畫面上跳一句「你已經有一間自己
   * 開的房，請先去遊戲裡收掉」對他沒有意義 —— 那間房**多半就是插件上一輪
   * 自己開的**（對手沒進來、或上一場打完了）。所以這裡直接收掉再檢查一次。
   *
   * ⚠ `delete_room` 是**頻道層級**的：它會把玩家在這個頻道的房**全部**收掉，
   * 包含他自己手動開的那間。所以這件事一定要寫進記錄檔 —— 玩家要知道剛剛
   * 那間房是被誰收的（見 match-session.ts 的檔頭）。
   */
  async #preflight(): Promise<PreflightResult> {
    const first = await preflight(this.#options.driver, { expectChannel: this.#options.channel });
    if (first.ok) return first;
    if (first.block.code !== "has-own-room" && first.block.code !== "already-matching") {
      return first;
    }

    this.#log("· 你在這個頻道已經有一間開著的房，先收掉再排隊（收的是整個頻道的房）");
    await this.#options.driver.cancelRoom().catch(() => "");
    // 收房之後清單要一點時間才更新。等一拍再問，否則會讀到剛剛那間還在。
    await (this.#options.sleep ?? defaultSleep)(1_000);
    return await preflight(this.#options.driver, { expectChannel: this.#options.channel });
  }

  /**
   * 停止配對。
   *
   * ⚠ **開過房就要收掉。** 留著的話清單上會有一間永遠不會有人進來的空房，
   * 而且玩家下一次配對會被 preflight 擋下來（「你已經有一間自己開的房」）。
   */
  async stop(reason = "已停止配對。"): Promise<void> {
    this.#clearTimer();
    this.#clearWatch();
    this.#client?.stop();
    this.#client = null;
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#log("· 已收掉剛剛開的房");
    }
    this.#resetPair();
    this.#skipped = 0;
    this.#patch({ ...IDLE, message: reason });
  }

  /**
   * **配對成功地結束了** —— 對戰已經開始，這個任務沒事做了。
   *
   * 跟 `stop()` 的差別只有一個，但那一個很重要：**不收房**。房裡有人了，
   * 收掉就是把對手踢出去。所以先把 `#openedRoom` 清掉再走同一條收尾路徑。
   *
   * ⚠ 一定要回到 `idle`。留在 `ready` 的話托盤那邊的 `pairing` 物件不會被
   * 放掉，玩家打完這一場想再排一次只會收到「已經在配對中了」。
   */
  #finish(message: string): void {
    this.#clearTimer();
    this.#clearWatch();
    this.#openedRoom = false;
    this.#handedOff = false;
    this.#client?.stop();
    this.#client = null;
    this.#resetPair();
    this.#skipped = 0;
    this.#log(`· ${message}`);
    this.#patch({ ...IDLE, message });
  }

  // -------------------------------------------------------------------------
  // 佇列事件
  // -------------------------------------------------------------------------

  #onQueueStatus(status: QueueStatus, waiting: number): void {
    if (status === "incompatible") {
      void this.stop("中間人的協定版本跟這個插件不合，請更新。");
      return;
    }
    if (status === "unreachable") {
      // ⚠ 停在 `blocked` 而不是 `idle`：這是**要玩家去做點什麼**的狀態
      // （檢查位址、檢查網路），不是「配對正常結束了」。停在 idle 的話畫面
      // 上跟「還沒開始配對」一模一樣，而玩家剛剛明明按了開始。
      //
      // ⚠ 走 `#block` 是安全的 —— 會走到這裡就代表連線**一次都沒成立過**，
      // 所以不可能已經開了房（開房要先配到人）。
      this.#block(
        "連不上中間人的配對佇列，已經停止排隊。這不是沒人跟你排 —— 是那條線根本沒接上。" +
          "檢查網路，或到「設置 › 連線」看中間人的位址；「設置 › 記錄」有每一次失敗的原因。",
      );
      return;
    }
    // ⚠ 只更新人數與「線上了沒」。phase 是**這支**在管的（對規則、開房…），
    // 讓連線層去覆寫它的話，一次重連就會把「正在開房」打回「排隊中」。
    const linked = status === "waiting" || status === "matched";
    // 已經在對規則／開房了就不要再改訊息 —— 那幾句是這支自己在管的。
    const stillQueueing = this.#status.phase === "queued";
    this.#patch({
      waiting,
      linked,
      ...(stillQueueing
        ? {
            message: linked
              ? "排隊中，等一個用同一份規則的人。"
              : // ⚠ 這句要指得出下一步。「連線中」對玩家沒有用 —— 他要知道的是
                // 「這不是在等對手，是根本還沒連上」。
                "連不上中間人的配對佇列，還在重試 —— 這不是在等對手。" +
                "檢查網路，或到「設置 › 連線」看中間人的位址。",
          }
        : {}),
    });
  }

  async #onMatched(info: { role: QueueRole; token: string; peerTag: string }): Promise<void> {
    this.#resetPair();
    this.#role = info.role;
    this.#token = info.token;

    // 每一次配對都重讀牌組 —— 玩家在排隊時換牌組是很正常的事。
    const deck = await this.#readOwnDeck();
    if (deck === null) return;

    // ⚠ **頻道也要重看一次。** 配對鍵裡的頻道是按下「開始配對」那一刻的，而排隊
    // 是會等的 —— 玩家完全可能在等的時候切去別的頻道。少了這一關的症狀分兩種，
    // 兩種都很難懂：host 會在新頻道開一間房（對手在舊頻道看不到它），guest 會
    // 在新頻道的清單裡找一個不存在的 room_id 找到逾時。
    //
    // 房間清單是**分頻道推播**的，所以「兩個人都在同一個頻道」不是設定問題，
    // 是這件事成不成立的前提。
    if (this.#currentChannel !== null && this.#currentChannel !== this.#options.channel) {
      await this.stop(
        `你已經換到頻道 ${this.#currentChannel} 了，配對約定的是頻道 ${this.#options.channel}。` +
          `回到那個頻道再排一次。`,
      );
      return;
    }

    const check = checkOwnDeck(this.#options.rule, deck, this.#options.costLimit);
    this.#patch({ myTotal: check.total, overLimit: check.over, role: info.role });
    if (check.over) {
      await this.stop(`你的隊伍變成 ${check.total} 了，超過約定的上限。改好再排一次。`);
      return;
    }

    if (info.peerTag === this.#myTag) {
      // 快路：同一份規則，連牌組都不用交換 —— 對手帶什麼我們永遠不會知道。
      this.#compatibility = "exact";
      this.#patch({
        compatibility: "exact",
        phase: "checking",
        message: "規則版本相同，準備開房。",
      });
      await this.#commit();
      return;
    }

    this.#patch({
      phase: "checking",
      message: "對手的規則是另一個版本，正在確認這一場算出來的東西一不一樣…",
    });
    this.#client?.sendDeck(encodeDeckBody(deck));
    this.#armTimeout("對手沒有在時限內回應，換下一位。");
    // ⚠ 一定要在這裡再叫一次。讀牌組是 `await`（一次 CDP 往返），對手的
    // `q-deck` 完全可能在那幾十毫秒裡就到了 —— 那時 `#tryCross` 因為
    // 「我的牌組還沒讀到」而提早 return，之後就**沒有任何東西會再觸發它**，
    // 兩邊一起等到逾時。
    await this.#tryCross();
  }

  async #onPeerDeck(body: string): Promise<void> {
    const peer = parseDeckBody(body);
    if (peer === null) {
      await this.#nextOpponent("對手送來的牌組描述子看不懂（版本不同？），換下一位。");
      return;
    }
    this.#peerDeck = peer;
    await this.#tryCross();
  }

  async #onPeerEval(body: string): Promise<void> {
    const peer = parseEvalBody(body);
    if (peer === null) {
      await this.#nextOpponent("對手送來的指紋看不懂，換下一位。");
      return;
    }
    this.#peerEval = peer;
    await this.#tryCross();
  }

  /**
   * 兩副牌都在手上就算指紋；兩邊的指紋都在手上就下判決。
   *
   * ⚠ 寫成「湊齊了就往下走」而不是照順序等：訊息的到達順序不保證 ——
   * 對手可能在我還沒送出描述子時就把他的送過來了。
   */
  async #tryCross(): Promise<void> {
    const mine = this.#myDeck;
    const peer = this.#peerDeck;
    if (mine === null || peer === null) return;

    if (this.#myEval === null) {
      const decks =
        this.#role === "host" ? { host: mine, guest: peer } : { host: peer, guest: mine };
      this.#myEval = crossEvaluate(this.#options.rule, decks);
      this.#client?.sendEval(encodeEvalBody(this.#myEval));
    }

    if (this.#peerEval === null) return;

    const verdict = crossVerdict(this.#myEval, this.#peerEval);
    if (verdict === "incompatible") {
      const why = describeDisagreement(this.#myEval, this.#peerEval);
      await this.#nextOpponent(`規則版本不相容 —— ${why}換下一位。`);
      return;
    }

    this.#compatibility = "compatible";
    this.#clearTimer();
    this.#patch({
      compatibility: "compatible",
      message: "版本不同，但這一場算出來的東西完全一樣 —— 可以打。",
    });
    await this.#commit();
  }

  // -------------------------------------------------------------------------
  // 開房 / 進房
  // -------------------------------------------------------------------------

  /** 驗算過了，真的去動遊戲。⚠ 這之後才會消耗 AP。 */
  async #commit(): Promise<void> {
    if (this.#committing) return;
    this.#committing = true;
    try {
      if (this.#role === "host") await this.#openRoom();
      else await this.#joinWhenReady();
    } finally {
      this.#committing = false;
    }
  }

  async #openRoom(): Promise<void> {
    const token = this.#token;
    if (token === null) return;

    // ⚠ 這裡也要走會收舊房的那支。配到人之後才被「你已經有一間房」擋下來的話，
    // 對手已經在等我開房了 —— 而擋住我們的那間房多半是上一輪自己留下的。
    const pre = await this.#preflight();
    if (!pre.ok || pre.context.playerName === null) {
      await this.stop(pre.ok ? "讀不到玩家名稱。" : pre.block.message);
      return;
    }

    this.#patch({ phase: "opening", message: "開房中…" });
    const result = await hostOpenRoom(this.#options.driver, {
      playerName: pre.context.playerName,
      room: {
        name: this.#options.room.name === "" ? DEFAULT_ROOM_NAME : this.#options.room.name,
        stage: this.#options.room.stage,
        multi: this.#options.multi,
        friend: this.#options.room.friend,
        // ⚠ 房間密碼就是配對 token。**房名絕對不能帶它**，房名是公開的。
        pass: token,
        // ⚠ 這是遊戲自己的「牌組Cost限制 ±N」，伺服器用**原版 COST** 判，
        // 跟約定的自訂上限是兩回事 —— 那個是我們自己在上面查過的。
        cost: this.#options.room.deckCostBand,
      },
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    });

    if (!result.ok) {
      if (result.needsCancel) await this.#options.driver.cancelRoom().catch(() => "");
      await this.stop(`開房失敗：${result.reason}`);
      return;
    }

    this.#openedRoom = true;
    this.#myRoomId = result.roomId;
    this.#client?.sendRoom(result.roomId);
    this.#handedOff = true;
    this.#patch({ phase: "ready", message: "房開好了，等對手進來。" });
    // 從這裡開始，判斷「成了沒」的依據是**遊戲**而不是佇列 —— 對手的插件
    // 進了房就會離開佇列，那在佇列眼裡跟「他取消了」長得一模一樣。
    this.#watchHandoff(result.roomId);
  }

  /**
   * host：等對手真的進來，然後結束這個配對任務。
   *
   * 判準是房間清單（遊戲自己的狀態，不是佇列的）：
   *
   * | 看到什麼                     | 意思                             |
   * | ---------------------------- | -------------------------------- |
   * | 我那間房多了 playerB         | 對手進來了                       |
   * | 我那間房從清單上消失         | 已經開打（對戰中的房不在清單上） |
   * | 逾時還是只有我               | 沒人來 —— 收房、停止             |
   *
   * ⚠ 清單「空的」與「還不知道」要分開。剛連上時 `seq === 0` 且沒有 live 快照，
   * 那時什麼都不能推論 —— 把它當成「房不見了」會在對手還沒進來時就宣告開打。
   */
  #watchHandoff(roomId: string): void {
    const pollMs = this.#options.handoffPollMs ?? HANDOFF_POLL_MS;
    const deadline = Date.now() + (this.#options.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);

    const poll = async (): Promise<void> => {
      this.#watch = null;
      // 中途被停掉／被拆對了就不要再看下去。
      if (!this.#handedOff || this.#myRoomId !== roomId) return;

      let joined = false;
      let gone = false;
      try {
        const snapshot = await this.#options.driver.roomSnapshot();
        const mine = snapshot.rooms.find((r) => r.roomId === roomId);
        if (mine === undefined) gone = snapshot.live || snapshot.seq > 0;
        else joined = mine.playerBName !== null;
      } catch {
        // 讀不到就當這一輪沒看到，下一輪再問。連線斷了的話 stop() 會收掉這個迴圈。
      }
      if (!this.#handedOff || this.#myRoomId !== roomId) return;

      if (joined || gone) {
        this.#finish(joined ? "對手進房了，對戰開始 —— 配對結束。" : "房間已經開打，配對結束。");
        return;
      }
      if (Date.now() >= deadline) {
        await this.stop("等不到對手進房，已經把房收掉。要再排一次請按「開始自動配對」。");
        return;
      }
      this.#watch = setTimeout(() => void poll(), pollMs);
    };

    this.#clearWatch();
    this.#watch = setTimeout(() => void poll(), pollMs);
  }

  async #onRoom(roomId: string): Promise<void> {
    this.#pendingRoomId = roomId;
    // ⚠ 走 `#commit()` 而不是直接叫 `#joinWhenReady()`：那支會 await 一段長達
    // 二十秒的輪詢，而房號可能在它跑到一半時又來一次（重連、host 重送）。
    // 沒有那道重入鎖的話會同時送出兩次 `room_in`。
    await this.#commit();
  }

  /**
   * guest 端：驗算過了**而且**房號到手才進去。
   *
   * ⚠ 兩個條件的順序不固定 —— host 可能在我收到他的指紋之前就把房開好了
   * （他只需要**我的**指紋就能下判決）。所以兩邊都要能觸發這一支。
   */
  async #joinWhenReady(): Promise<void> {
    const roomId = this.#pendingRoomId;
    const token = this.#token;
    if (roomId === null || token === null || this.#compatibility === null) return;

    this.#clearTimer();
    this.#patch({ phase: "joining", message: "對手的房開好了，進房中…" });
    const result = await guestJoinRoom(this.#options.driver, {
      roomId,
      pass: token,
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    });

    if (!result.ok) {
      await this.stop(`進房失敗：${result.reason}`);
      return;
    }
    // 進房成功 = 這次配對的任務結束。留在佇列上只會被配給下一個人，而留在
    // `ready` 會讓玩家打完之後按不了「開始自動配對」。
    this.#finish("已進房，對戰開始 —— 配對結束。");
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  async #onDropped(reason: DropReason): Promise<void> {
    // ⚠⚠ **房號已經交出去、而對手是「取消」的話，那多半是他進房成功了。**
    //
    // 對手的插件一進房就會離開佇列，而離開佇列送的正是 `q-cancel` —— 在佇列
    // 眼裡跟玩家自己按停止一模一樣。照下面那段處理（收房 + 退回排隊）等於在
    // 對手剛進門的瞬間把房拆掉，然後去排下一個人，而畫面上寫「對手取消了」。
    // 2026-08-16 實測：host 那邊確實就是這句話，而那一場其實已經打起來了。
    //
    // `gone`（連線斷了）不一樣 —— 那是真的走了，照舊收房退回佇列。
    // 分不出「他取消了」與「他進去了」的那個灰區交給 `#watchHandoff` 用**遊戲
    // 的狀態**判：房裡有沒有人，那是唯一的事實來源。
    if (this.#handedOff && reason === "cancel") {
      this.#log("· 對手離開佇列了（多半是進房成功）—— 看房間裡有沒有人再決定");
      return;
    }

    this.#clearTimer();
    this.#clearWatch();
    // ⚠ 對手在我開好房之後跑掉 —— 房要收掉，否則會留一間空房，而且下一次
    // 配對會被 preflight 擋住。
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#log("· 對手跑掉了，已收掉剛剛開的房");
    }
    this.#resetPair();
    this.#patch({
      phase: "queued",
      role: null,
      compatibility: null,
      message:
        reason === "rejected"
          ? "跟剛剛那位的規則版本算出來的東西不一樣，繼續找下一位。"
          : "對手取消了，繼續排隊。",
    });
  }

  /** 這一對不算數，但我還要繼續排。 */
  async #nextOpponent(message: string): Promise<void> {
    this.#clearTimer();
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#openedRoom = false;
    }
    this.#skipped += 1;
    this.#log(`· ${message}`);
    this.#resetPair();
    this.#client?.reject();
    this.#patch({
      phase: "queued",
      role: null,
      compatibility: null,
      skipped: this.#skipped,
      message,
    });
  }

  /**
   * 讀自己的牌組。讀不到就停在 `blocked` —— 猜一副牌是絕對不行的。
   *
   * 順便把**當下的頻道**記下來（`#currentChannel`），呼叫端要靠它確認玩家
   * 還在約定的頻道裡。同一次 CDP 往返就拿得到，不必再問一次。
   */
  async #readOwnDeck(): Promise<DeckDescriptor | null> {
    const context = await this.#options.driver.matchContext().catch(() => null);
    this.#currentChannel = context?.channel ?? null;
    const keys = context?.deckKeys ?? null;
    if (keys === null) {
      this.#block("讀不到你的牌組。請在遊戲裡回大廳、確認選好了出戰牌組再試。");
      return null;
    }
    const deck = deckFromKeys(keys);
    if (deck.characters.length === 0) {
      this.#block("你的出戰牌組是空的。先去編一副再配對。");
      return null;
    }
    this.#myDeck = deck;
    return deck;
  }

  #armTimeout(message: string): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#nextOpponent(message);
    }, this.#options.timeoutMs ?? PEER_REPLY_TIMEOUT_MS);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** 停掉「等對手進房」的輪詢。⚠ 每一條收尾路徑都要叫，否則它會繼續看一間 */
  /** 已經不屬於這次配對的房。 */
  #clearWatch(): void {
    if (this.#watch !== null) clearTimeout(this.#watch);
    this.#watch = null;
  }

  #resetPair(): void {
    this.#role = null;
    this.#token = null;
    // ⚠ 自己的牌組也要清掉。留著上一對讀到的那副，而對手的 `q-deck` 在我
    // 重讀牌組（一次 CDP 往返）之前就到的話，`#tryCross` 會拿**上一場的**
    // 牌組去算指紋 —— 算出來的東西是自洽的，只是跟等一下真的要打的那副
    // 沒有關係。這種錯誤不會有任何錯誤訊息。
    this.#myDeck = null;
    this.#peerDeck = null;
    this.#myEval = null;
    this.#peerEval = null;
    this.#compatibility = null;
    this.#pendingRoomId = null;
    this.#openedRoom = false;
    this.#myRoomId = null;
    this.#handedOff = false;
    this.#clearWatch();
  }

  #block(message: string): void {
    this.#client?.stop();
    this.#client = null;
    this.#clearTimer();
    this.#clearWatch();
    this.#patch({ phase: "blocked", role: null, compatibility: null, message });
  }

  #patch(patch: Partial<PairingStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#options.onStatus?.(this.#status);
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }
}
