/**
 * 自動存檔的比較基準：**客戶端與伺服器各記一份**（WP-19，2026-09-20）
 * ====================================================================
 * `autoSave()` 的整個推論建立在一句話上：
 *
 * ```
 *   這一份 Deck1 跟我上次看到的不一樣  →  玩家在這段期間改了牌
 * ```
 *
 * 而那句話**只有在同一個世界裡才成立**。Deck1 同時存在兩個地方：
 *
 * ```
 *   client   頁面記憶體裡的 sc.deck1   —— Edit／任務／渦／對戰房都讀得到
 *   server   db_deck1                 —— 玩家不在那些畫面時只剩它
 * ```
 *
 * 平常兩邊一樣，所以一份基準就夠用。但**換房那幾秒它們必定不一樣**：
 * `patch-room-gate` 在進房前就把那一房的牌塞進記憶體（preload／front），而
 * 伺服器要等等候秒數到了才被 `commitPending()` 追上。拿同一份基準跨世界比，
 * 就會把「我們自己造成的落差」讀成「玩家改了牌」。
 *
 * ## ⚠⚠ 2026-09-20 實機：從渦房走到對戰房，迪城的牌組1 變成渦的那副
 *
 * ```
 *   渦房          server = 渦Deck3、client = 渦Deck3、基準 = 渦Deck3
 *   點迪城頻道    頁面把 client 換成迪城Deck1 → 基準跟著變成迪城Deck1
 *                 enterRoom 用 client 那份算出 active.dietherm = 迪城Deck1
 *                 ⚠ server 這時候還是渦Deck3，要三秒後才寫
 *   這三秒內只要讀到 server（離開場景、遊戲重載、直連跳牌組編輯…）：
 *                 current(渦Deck3) ≠ 基準(迪城Deck1) → 判成「玩家改了牌」
 *                 → 存進 active[room] = 迪城Deck1
 *   結果          庫裡迪城的牌組1 整副被渦的那副覆蓋，而 autoSave 從不出聲，
 *                 記錄檔一個字都沒有
 * ```
 *
 * 兩份基準之後，那次讀到的 `server` 會跟**伺服器自己的上一份**比 ——
 * 一模一樣，於是什麼都不做。這才是正確答案：伺服器上那副牌從頭到尾沒變過。
 *
 * ⚠ 這跟 `mayAutoSave()` 是兩道不同的閘。那一道擋的是「人在房間場景裡看到的
 * 變動」；這一道擋的是「人已經離開房間場景，但伺服器還沒追上」那一段 ——
 * 2026-09-10 補的是前者，後者一直漏著。
 *
 * ⚠ **寫入端要誠實回報自己動到哪一邊**（見 `main.ts` 的 `writeDeck1`）：
 * 快路徑（Edit 的 `ok`、房間的 `ok-room`）只動客戶端記憶體 → `client`；
 * 走 `db_editdeck` 讀回來對過的那一條才是 `both`。報錯了就等於沒修。
 */

import type { DeckContent } from "@ulr/deck-library";

/** Deck1 這個東西同時存在的兩個地方。 */
export type DeckWorld = "client" | "server";

/** 這一份是從哪個畫面讀來的（`currentDeck1()` 的 `where`）。 */
export type DeckReadSource = "edit" | "room" | "server";

/** 一次記進哪幾份。`both` = 我們剛把兩邊寫成同一副。 */
export type DeckSeenScope = DeckWorld | "both";

/** 讀到的那一份屬於哪個世界。⚠ `edit` 與 `room` 都是客戶端記憶體。 */
export function worldOf(source: DeckReadSource): DeckWorld {
  return source === "server" ? "server" : "client";
}

/**
 * 退回開關。**一行退回：`ULR_DECK_SEEN_SPLIT=0`。**
 *
 * 設 0 時兩份基準退化成一份（`latest`），也就是 2026-09-20 之前的行為 ——
 * 上面那個 bug 會跟著回來，所以只在「新的擋法擋錯了東西」時才用它對照。
 */
export const DECK_SEEN_ENV = "ULR_DECK_SEEN_SPLIT";

export function splitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DECK_SEEN_ENV] !== "0";
}

/**
 * 兩份基準。**除了 `latest` 以外沒有人該直接碰裡面那兩個欄位。**
 *
 * ⚠ `null` = 這個世界還沒觀察過。`autoSave()` 拿到 `null` 一律不存 ——
 * 沒有比較基準時動玩家的牌是這個專案付過代價的事。
 */
export class DeckSeen {
  #client: DeckContent | null = null;
  #server: DeckContent | null = null;
  /** 不分世界、最後讀到的那一份。退回開關與「重算 active」用它。 */
  #latest: DeckContent | null = null;
  readonly #split: boolean;

  constructor(split: boolean = splitEnabled()) {
    this.#split = split;
  }

  /** 退回開關現在是開著的嗎（true = 兩份基準）。 */
  get split(): boolean {
    return this.#split;
  }

  /**
   * 不分世界、最後讀到的那一份。
   *
   * ⚠ 這是給「雲端同步合併完要重算 active」那種**不在乎來源**的地方用的。
   * 自動存檔一律走 {@link forSource}。
   */
  get latest(): DeckContent | null {
    return this.#latest;
  }

  /** 記下「我們在這個（些）世界看到的最後一份」。 */
  remember(scope: DeckSeenScope, content: DeckContent | null): void {
    if (scope !== "server") this.#client = content;
    if (scope !== "client") this.#server = content;
    this.#latest = content;
  }

  /** 全部丟掉（斷線、頁面重載、換帳號）。見 `resetDeckSession()`。 */
  reset(): void {
    this.#client = null;
    this.#server = null;
    this.#latest = null;
  }

  /**
   * 自動存檔的比較基準：**跟同一個來源的上一份比**。
   *
   * 退回開關關掉時回 {@link latest}，等於 2026-09-20 之前那一份共用基準。
   */
  forSource(source: DeckReadSource): DeckContent | null {
    if (!this.#split) return this.#latest;
    return worldOf(source) === "server" ? this.#server : this.#client;
  }
}
