/**
 * 把頁面與仲裁接起來（WP-12 的膠水層）
 * ======================================
 *
 *     頁面 patch-ok  ──回報──▶  translate()  ──▶  arbitration.step()
 *          ▲                                            │
 *          └────────── release / cancel / 改外觀 ◀───────┘
 *
 * 這一層刻意**只有翻譯與排序**，沒有任何規則 —— 規則全在 `arbitration.ts`
 * （純函式、可完整測試），執行全在 `patch-ok.ts`（頁面、含失效保護）。
 * 中間這層要是也開始做決定，三個地方都會需要同一份邏輯。
 *
 * 所以這裡能被測試的部分也是純的：`translate()` 與 `commandsFor()`。
 * 真正碰 CDP 的只有 `ArbiterRunner`，而它薄到幾乎沒有分支。
 */

import type { ArbiterAction, ArbiterConfig, ArbiterInput, ArbiterState } from "./arbitration.js";
import { initialState, resetAfterSend, resetForNextPhase, step } from "./arbitration.js";
import type { Seat } from "./constants.js";
import type { OkPatchReport, OkPatchTick } from "./patch-ok.js";
import { OK_PATCH_GLOBAL } from "./patch-ok.js";

/**
 * 頁面回報 → 仲裁輸入。回 `null` 代表這則不影響仲裁。
 *
 * 「按了 OK」與「已經壓著又按一次」都對到同一個 `press-ok` —— 因為
 * `arbitration.step` 本來就是 toggle：沒準備就準備，已準備就取消。
 * 這一層不需要知道那個規則，也不該知道。
 */
export function translate(report: OkPatchReport): ArbiterInput | null {
  switch (report.type) {
    case "ok-intercepted":
    case "ok-pressed-again":
      return { type: "press-ok" };
    case "ok-patch-event":
      return {
        type: "game-event",
        event: report.event,
        ...(report.cardRef !== undefined ? { cardId: report.cardRef } : {}),
        ...(report.clicked !== undefined ? { clicked: report.clicked } : {}),
      };
    default:
      return null;
  }
}

/** 要在頁面上執行的指令。 */
export type PageCommand =
  /** 把壓著的那次呼叫原封不動送出去。 */
  | { kind: "release" }
  /**
   * 讓這個階段的 `I_am_ok` 送出去，**玩家沒按也算**。
   *
   * 跟 `release` 分開是因為頁面要做的事完全不同：壓著的話重放，沒壓著的話
   * 得**替玩家按一次 OK 鈕**。合成一個指令的話頁面就得自己判斷，而那個判斷
   * 一旦寫錯，症狀是「約定秒數到了卻什麼都沒發生」。
   */
  | { kind: "force-end" }
  | { kind: "cancel" }
  | { kind: "set-frame"; frame: "0" | "2"; interactive: boolean };

/**
 * 仲裁動作 → 頁面指令。
 *
 * ⚠ 兩個容易寫錯的地方：
 *
 * 1. **取消時一定要 `cancel()`**，光把外觀改回去是不夠的 —— 那個被攔下來的
 *    呼叫還壓在頁面裡，失效保護時間到就會把它送出去，玩家會莫名其妙被鎖定。
 * 2. **frame `"2"` 要保持可按。** 準備狀態看起來跟鎖定一樣，但必須能再按一次
 *    取消（V1 規則 1）。只有真的送出去之後才不可按。
 */
export function commandsFor(actions: readonly ArbiterAction[]): PageCommand[] {
  const commands: PageCommand[] = [];
  const cancelling = actions.some((a) => a.type === "announce-ready" && !a.ready);
  const send = actions.find((a) => a.type === "send-ok");

  for (const action of actions) {
    if (action.type !== "set-ok-frame") continue;
    commands.push({
      kind: "set-frame",
      frame: action.frame,
      // 送出之後才真的不能按；準備中一律保持可按。
      interactive: send === undefined,
    });
  }
  if (send !== undefined) commands.push(send.held ? { kind: "release" } : { kind: "force-end" });
  else if (cancelling) commands.push({ kind: "cancel" });
  return commands;
}

// ---------------------------------------------------------------------------
// 真正碰 CDP 的部分
// ---------------------------------------------------------------------------

/** `ArbiterRunner` 需要的頁面能力。抽成介面是為了測試不必開瀏覽器。 */
export interface PageBridge {
  /** 在頁面上求值一段 JS，回傳結果。 */
  evaluate<T>(expression: string): Promise<T>;
  /** 訂閱頁面的回報。 */
  onReport(handler: (report: OkPatchReport) => void): () => void;
}

export interface RunnerOptions {
  config: Omit<ArbiterConfig, "seat" | "capSeconds">;
  /**
   * 這個階段約定要在第幾秒結束。`null` = 不強制提早。
   *
   * ⚠ **每個 tick 都重新問**，不是啟動時讀一次。三個理由，每個都會在真實
   * 對戰中發生：
   *
   *   1. 玩家在托盤裡改了秒數
   *   2. 對手上線／離線 → 共同設定在「協商值」與「滿版 30 秒」之間切換
   *   3. `hazard`（手牌有聖水又碰上麻痺）會在一場之內來回變
   *
   * 參數 `hazard` 由**頁面**判斷後帶上來 —— 手牌內容不離開頁面（§12）。
   * 這個 callback 通常就是 `@ulr/arbiter-link` 的 `effectiveCapSeconds()`。
   *
   * 不給就是永遠不強制提早結束，也就是 WP-12 原本的行為。
   */
  capSecondsFor?: (hazard: boolean) => number | null;
  /** 我方準備狀態變了 —— 轉給側通道。 */
  onAnnounceReady?: (ready: boolean) => void;
  /** 我這邊的約定秒數門檻到了 —— 叫對手也收手。 */
  onAnnounceForceEnd?: () => void;
  /** 換場了（新的 room id）。側通道要跟著換房，否則會停在上一場。 */
  onRoomChange?: (roomId: string) => void;
  /**
   * 頁面上的 patch 不見了 —— 幾乎一定是玩家重載了遊戲（或打完一場回大廳時
   * 頁面換了 document）。**一定要接，而且要真的重裝。**
   *
   * ⚠ 不接的後果是**功能永久失效而且完全沒有徵兆**：CDP 連線還好好的，所以
   * 不會走重連那條路；`evaluate` 也照樣成功，只是 `window.__ulrArbiter` 已經
   * 不存在了。玩家看到的是「插件開著，但按 OK 就直接送出去」，而終端機上只有
   * 一行去重過的錯誤訊息。2026-08-06 雙開實測踩到：一邊還好好的，另一邊已經
   * 空了半場。
   */
  onPatchLost?: () => void;
  /**
   * 多久跟頁面往返一次。畫面每秒跳一格，250ms 足以在硬底線前反應。
   *
   * ⚠ 這同時是**心跳**的間隔。頁面用它判斷「還有沒有人在管」，超過
   * `staleMs` 就會停止攔截。調得比 `staleMs` 還慢會讓功能忽開忽關。
   */
  tickIntervalMs?: number;
  /** 每一步的決策都丟出來，讓 CLI／UI 可以顯示。 */
  onStep?: (info: {
    input: ArbiterInput;
    state: ArbiterState;
    actions: readonly ArbiterAction[];
  }) => void;
  /**
   * 輪詢出錯時呼叫。**一定要接**——不接的話硬底線失效會完全沒有徵兆，
   * 只能靠頁面的失效保護兜底（實測會壓滿 25 秒）。
   */
  onError?: (error: Error) => void;
}

export const DEFAULT_TICK_INTERVAL_MS = 250;

/**
 * 驅動一場對戰的仲裁。
 *
 * 座位是**每場重新讀**的 —— 實測同兩個帳號連打兩場，座位會對調
 * （docs/battle-events.md）。快取座位是個只在半數對局出錯的 bug。
 */
export class ArbiterRunner {
  #bridge: PageBridge;
  #options: RunnerOptions;
  #state: ArbiterState = initialState();
  #seat: Seat | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;
  #armed = false;
  /**
   * 上一則報過的錯。
   *
   * tick 是每秒四次，同一個錯（例如「還沒進對戰所以讀不到 TIME」）不去重的話
   * 會把終端機洗掉，反而看不到真正該注意的那一行。
   */
  #lastError: string | null = null;
  /** 上一次看到的移動階段序號。變了就代表換階段，狀態要重置。 */
  #phaseId = -1;
  /** 上一次推給頁面的顯示秒數。一樣就不要再往返一次。 */
  #displayCap: number | null = null;
  /** 上一次看到的 room id 雜湊。變了就代表換場。 */
  #roomId: string | null = null;
  /** 目前這個階段頁面回報的 hazard。 */
  #hazard = false;

  constructor(bridge: PageBridge, options: RunnerOptions) {
    this.#bridge = bridge;
    this.#options = options;
  }

  get state(): ArbiterState {
    return this.#state;
  }

  get seat(): Seat | null {
    return this.#seat;
  }

  /** 頁面上的攔截有沒有真的掛到 socket 上。還在大廳時是 false。 */
  get armed(): boolean {
    return this.#armed;
  }

  /** 手牌有聖水／聖杯又碰上麻痺。托盤顯示用。 */
  get hazard(): boolean {
    return this.#hazard;
  }

  /**
   * 側通道說**兩邊都準備好了**。
   *
   * ⚠ 這是唯一從外面進來的就緒訊號，而且是合成的 —— 中間人不存在一則
   * 「對手準備好了」可以發（`@ulr/arbiter-link` 的紅線 1）。
   */
  peerBothReady(): void {
    void this.#apply({ type: "opponent-ready", ready: true });
  }

  /** 對手那邊的約定秒數門檻先到了，跟著收手。 */
  peerForceEnd(): void {
    void this.#apply({ type: "peer-force-end" });
  }

  /**
   * 開關「準備」功能（攔 OK）。
   *
   * ⚠ **不是拆掉 patch。** 約定秒數那條路不需要攔截也要用到頁面（讀秒、
   * 階段判斷、hazard、替玩家按 OK），拆掉會把另一個功能一起關掉。
   */
  async setHold(on: boolean): Promise<void> {
    await this.#bridge.evaluate(`window.${OK_PATCH_GLOBAL}.setHold(${on ? "true" : "false"})`);
  }

  async start(): Promise<void> {
    this.#seat = await this.#readSeat();
    this.#unsubscribe = this.#bridge.onReport((report) => {
      void this.#onReport(report);
    });
    const interval = this.#options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.#timer = setInterval(() => void this.#tick(), interval);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** 新的階段開始。保留場上的牌，清掉準備狀態。 */
  nextPhase(): void {
    this.#state = resetForNextPhase(this.#state);
  }

  async #readSeat(): Promise<Seat | null> {
    // ⚠ 一律先確認 patch 還在。玩家可能重載了遊戲、或 patch 被拆過 ——
    // 直接 `.seat()` 會拋 TypeError，而那個錯訊完全看不出真正的原因。
    const raw = await this.#bridge.evaluate<string | null>(
      `(window.${OK_PATCH_GLOBAL} && window.${OK_PATCH_GLOBAL}.seat()) || null`,
    );
    return raw === "A" || raw === "B" ? raw : null;
  }

  /** 同一個錯訊只報一次，換了才再報。tick 每秒四次，不去重會把終端機洗掉。 */
  #reportError(message: string): void {
    if (this.#lastError === message) return;
    this.#lastError = message;
    this.#options.onError?.(new Error(message));
  }

  async #onReport(report: OkPatchReport): Promise<void> {
    if (report.type === "ok-patch-installed") {
      // 座位可能在裝上去之後才知道（還沒進對戰時是 null）。
      if (report.seat === "A" || report.seat === "B") this.#seat = report.seat;
      this.#armed = report.armed;
      return;
    }
    if (report.type === "ok-patch-rearmed") {
      // ⚠ **換場了。**（重新開房、進任務都會換一顆 socket。）
      //
      // 座位每場重新分配，場上的牌屬於上一場 —— 兩者都必須整組丟掉。
      // 沿用舊座位的症狀是「對手動作不取消準備、自己動作反而取消」，
      // 完全不像座位問題（docs/battle-events.md）。
      this.#seat = report.seat === "A" || report.seat === "B" ? report.seat : null;
      this.#state = initialState();
      this.#armed = true;
      return;
    }
    if (report.type === "ok-released") {
      // ⚠ 送出之後一定要重置，否則 committed 會永遠是 true —— 整場剩下的
      // 階段全部不再仲裁，而且完全沒有錯誤訊息（2026-08-02 實測踩到：
      // 第一次按 OK 之後就再也沒反應了）。
      //
      // 這裡也涵蓋失效保護那條路 —— 它不經過 Node，但頁面照樣會回報 released。
      //
      // ⚠ **是 resetAfterSend 不是 resetForNextPhase。** 差別只有 `sent`
      // 留不留，而那個欄位擋的是「約定秒數在同一個階段裡重複觸發」。
      this.#state = resetAfterSend(this.#state);
      this.#options.onAnnounceReady?.(false);
      return;
    }
    if (report.type === "ok-intercepted") {
      // ⚠ **每次按下都重讀座位。**
      //
      // 座位是每場對戰重新分配的，實測同兩個帳號連打兩場會對調
      // （docs/battle-events.md）。啟動時讀一次就快取的話，玩家換一間房
      // 之後敵我就反了 —— 而症狀是「對手動作不會取消準備、自己動作反而會」，
      // 完全不像座位問題。
      //
      // 成本是每次按 OK 多一次 CDP 往返（不是每個 tick），可以忽略。
      const fresh = await this.#readSeat();
      if (fresh !== null && fresh !== this.#seat) {
        this.#seat = fresh;
        this.#state = initialState(); // 換場了，場上的牌也要清掉
      }
    }

    const input = translate(report);
    if (input === null) return;
    await this.#apply(input);
  }

  /**
   * 心跳 + 讀秒，一次 CDP 往返做完。
   *
   * ⚠ **心跳每次都要送，不能只在壓著東西的時候送。** 頁面靠它判斷「還有沒有
   * 人在管」，超過 `staleMs` 沒收到就會停止攔截。舊版為了省往返而寫成
   * 「沒 ready 就直接 return」—— 那在有心跳之後會變成致命的：玩家還沒按 OK
   * 的那段期間頁面收不到心跳，於是第一次按下去根本不會被攔。
   */
  async #tick(): Promise<void> {
    let beat: OkPatchTick | null;
    try {
      beat = await this.#bridge.evaluate<OkPatchTick | null>(
        `(window.${OK_PATCH_GLOBAL} && window.${OK_PATCH_GLOBAL}.tick()) || null`,
      );
    } catch (err) {
      // ⚠ 這裡以前是裸的 await，錯誤變成無人處理的 rejection 被靜默吞掉。
      // 症狀：硬底線從來不觸發，每次都壓滿到失效保護（實測 25 秒），
      // 而且**完全沒有訊息** —— 看起來像邏輯寫錯，其實是讀秒一直在拋例外。
      this.#reportError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (beat === null || beat === undefined) {
      // patch 不在頁面上了 —— 幾乎一定是玩家重載了遊戲。
      this.#armed = false;
      this.#reportError("頁面上的攔截不見了（遊戲重載過？）—— 重新裝一次");
      // ⚠ **要真的重裝，不能只印錯誤。** 見 `onPatchLost` 的說明：
      // 這條路不會觸發重連，所以沒有別人會來救。
      this.#options.onPatchLost?.();
      return;
    }
    // 裝回來了 → 階段序號是新的一份，重新對齊，不要當成「換階段」而誤觸重置。
    if (this.#phaseId !== -1 && beat.phaseId < this.#phaseId) this.#phaseId = beat.phaseId;
    this.#armed = beat.armed;

    // ⚠ 座位每場重新分配（實測：同兩個客戶端連打兩場，:9334 從 B 變成 A）。
    // 換房時 socket 比 MainA 早一步換好，所以 rearmed 當下 MainA.PLAYER 可能
    // 還是上一場的 side。tick 本來就把座位帶回來了，順手校正。
    //
    // ⚠ 只在**沒有東西壓著**的時候採納 —— 準備中途把座位換掉，敵我會當場
    // 反過來，而症狀是「對手動作不取消準備、自己動作反而取消」。
    if ((beat.seat === "A" || beat.seat === "B") && beat.seat !== this.#seat) {
      if (!this.#state.ready) this.#seat = beat.seat;
    }

    this.#hazard = beat.hazard === true;

    // ⚠ **換場一定要通知側通道。** 房號沒跟著換的話，兩個插件會停在上一場的
    // 房裡 —— 症狀是「打第二場之後準備同步就失效了」，而且沒有任何錯誤訊息。
    const room = typeof beat.room === "string" ? beat.room : null;
    if (room !== null && room !== this.#roomId) {
      this.#roomId = room;
      this.#options.onRoomChange?.(room);
    }

    // ⚠ **換階段就重置，而且要看 phaseId 不是 `ok-released`。**
    // 約定秒數那條路在整個階段裡可能一則 `ok-released` 都沒有（玩家根本沒按
    // OK，是我們替他按的），只靠送出事件重置的話 `committed` 會卡在 true，
    // 之後每個階段都不再仲裁 —— 而且完全沒有錯誤訊息（WP-12 的坑 #5 換了個
    // 方式復發）。
    if (typeof beat.phaseId === "number" && beat.phaseId !== this.#phaseId) {
      const first = this.#phaseId === -1;
      this.#phaseId = beat.phaseId;
      if (!first) {
        this.#state = resetForNextPhase(this.#state);
        // 新階段一開始一定是「沒準備」。不明講的話中間人那邊還留著上一個
        // 階段的旗標，下一次對手按下去就會立刻湊成 both-ready。
        this.#options.onAnnounceReady?.(false);
      }
    }

    await this.#syncDisplayCap();

    if (this.#state.committed) {
      this.#lastError = null;
      return;
    }
    if (beat.remaining === null) {
      // 讀不到秒數 = 硬底線與約定秒數都失效，只剩頁面的失效保護。
      // ⚠ 只有在**壓著東西**的時候才吵 —— 不在有倒數的階段時讀不到是正常的。
      if (this.#state.ready) this.#reportError("讀不到剩餘秒數（TIME 找不到）—— 硬底線失效");
      return;
    }
    this.#lastError = null;
    await this.#apply({ type: "tick", remainingSeconds: beat.remaining });
  }

  /**
   * 把「這個階段其實只有幾秒」推給頁面，讓中間的數字與讀秒條跟著改。
   *
   * ⚠ 值沒變就不要往返 —— tick 是每秒四次，每次都送等於白花四次 CDP 呼叫。
   */
  async #syncDisplayCap(): Promise<void> {
    const cap = this.#options.capSecondsFor?.(this.#hazard) ?? null;
    if (cap === this.#displayCap) return;
    this.#displayCap = cap;
    await this.#bridge.evaluate(
      `window.${OK_PATCH_GLOBAL}.setDisplayCap(${cap === null ? "null" : String(cap)})`,
    );
  }

  async #apply(input: ArbiterInput): Promise<void> {
    // 座位還沒讀到就不能判斷敵我 —— 寧可什麼都不做，也不要用錯的座位取消準備。
    if (this.#seat === null) {
      this.#seat = await this.#readSeat();
      if (this.#seat === null) return;
    }

    const config: ArbiterConfig = {
      ...this.#options.config,
      seat: this.#seat,
      capSeconds: this.#options.capSecondsFor?.(this.#hazard) ?? null,
    };
    const result = step(config, this.#state, input);
    this.#state = result.state;
    this.#options.onStep?.({ input, state: result.state, actions: result.actions });

    // ⚠ 側通道的通知要**在頁面指令之前**發。兩邊的門檻是各自算的，理論上
    // 同時到，但實際上一定有幾十毫秒的差 —— 先講出去，對手才有機會跟上。
    for (const action of result.actions) {
      if (action.type === "announce-ready") this.#options.onAnnounceReady?.(action.ready);
      else if (action.type === "announce-force-end") this.#options.onAnnounceForceEnd?.();
    }

    for (const command of commandsFor(result.actions)) {
      await this.#run(command);
    }
  }

  async #run(command: PageCommand): Promise<void> {
    switch (command.kind) {
      case "release":
        await this.#bridge.evaluate(`window.${OK_PATCH_GLOBAL}.release("arbiter")`);
        return;
      case "force-end":
        await this.#bridge.evaluate(`window.${OK_PATCH_GLOBAL}.forceEnd("arbiter")`);
        return;
      case "cancel":
        await this.#bridge.evaluate(`window.${OK_PATCH_GLOBAL}.cancel()`);
        return;
      case "set-frame":
        await this.#bridge.evaluate(
          `window.__ulrArbiter.setOkFrame(${JSON.stringify(command.frame)}, ${command.interactive})`,
        );
        return;
    }
  }
}
