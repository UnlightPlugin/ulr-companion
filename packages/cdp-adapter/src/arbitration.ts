/**
 * 移動階段仲裁的核心邏輯（WP-12）
 * ==================================
 * 這個檔案**沒有任何 I/O** —— 不碰 CDP、不碰網路、不碰 Phaser。輸入是事件，
 * 輸出是決策。所以它可以被完整測試，而那正是重點：這是整個插件裡唯一會
 * **改變勝負**的部分，出錯的代價是玩家逾時棄權。
 *
 * 要解決的原始問題（社群原話）：
 *
 * > 按下 OK 後就會鎖定，對方操作時也無法解除我的鎖定，這是這遊戲的不良設計。
 *
 * 也就是「先承諾的人被懲罰」這個不對稱。功能定位是**消除不對稱**，
 * 不是「禁止慢慢想」—— 文案要照這個講（docs/open-questions.md §4 末節）。
 *
 * 三個不變量，每一個都有測試釘住：
 *
 * 1. **硬底線優先於一切。** 不管側通道說什麼，剩餘時間不足就立刻送出真 OK。
 *    伺服器時間到會自己結束回合，但插件壓著不送 = 棄權。
 * 2. **送出後不可撤銷。** commit 之後任何輸入都不再改變結果。
 * 3. **座位要從外面給。** 事件名尾巴的 A/B 是**絕對座位**不是敵我
 *    （docs/battle-events.md）。寫死 "B = 對手" 只對半數玩家成立，
 *    而症狀是準備狀態每次被自己的動作取消 —— 極難查。
 */

import type { Seat } from "./constants.js";
import { otherSeat, seatOfEvent } from "./constants.js";

/**
 * 準備被什麼取消。對應 V1 規則 2 的 A / B / C 三型。
 *
 * ⚠ `never` 等同遊戲原本的鎖定行為。混搭時（我 `never`、對手 `either`）
 * 我先準備好之後對手可以無限磨我 —— **那正是這個功能要消除的不對稱**。
 * UI 要標明代價，不要跟另外兩個平列成中性選項。
 */
export type CancelPolicy =
  /** A：我方或對手操作都取消（預設） */
  | "either"
  /** B：只有對手操作才取消 */
  | "opponent"
  /** C：都不取消 —— 等同原本的鎖定 */
  | "never";

export type CardId = number;

export interface ArbiterConfig {
  /** 本地玩家的座位。來源：`game.scene.keys.MainA.PLAYER`（客戶端自己用它組事件名）。 */
  seat: Seat;
  policy: CancelPolicy;
  /**
   * 剩餘秒數低於這個值就**強制送出**，不再等對手。
   *
   * 讀畫面上的 TIME（`TIMER_DISPLAY`）—— 那是遊戲自己維護的倒數，凍結時會自己停。
   * 不要用 `okVisible`/`okInvisible` 去推剩餘量，凍結解除時 `okVisible` 會重發
   * 但倒數是接續的（見 `OK_WINDOW_NOTE`）。
   *
   * 邊際要涵蓋：側通道往返 + 送出到伺服器收到。顯示 30 秒但伺服器 31 秒才收，
   * 那 1 秒是額外的緩衝，不要拿來用。
   */
  deadlineSeconds: number;
  /**
   * 方向選擇（`move_select`）算不算「操作」。
   *
   * V1 規則 2 只列了出牌、收牌、旋轉三種，所以**預設不算**。但方向選擇同樣
   * 發生在移動階段、同樣改變結果 —— 這是還沒拍板的設計問題，先做成選項。
   */
  moveSelectCounts?: boolean;
}

export interface ArbiterState {
  /** 目前打在場上的牌，依座位分開。用來分辨手牌轉牌與場上轉牌。 */
  readonly played: Readonly<Record<Seat, ReadonlySet<CardId>>>;
  /** 我方是否處於「準備」狀態（已按下 OK，但真的 OK 還沒送出去）。 */
  readonly ready: boolean;
  /** 對手是否回報準備好了。**只能由側通道提供** —— 遊戲協定不下發這個。 */
  readonly opponentReady: boolean;
  /** 真的 `I_am_ok` 已經送出。之後不可撤銷。 */
  readonly committed: boolean;
}

export type ArbiterInput =
  /** 從 `WSClient.onAny` 收到的遊戲事件。 */
  | { type: "game-event"; event: string; cardId?: CardId; clicked?: boolean }
  /** 玩家按了 OK 鈕（在這個設計裡它是「準備」）。 */
  | { type: "press-ok" }
  /** 側通道回報對手的準備狀態。 */
  | { type: "opponent-ready"; ready: boolean }
  /** 讀到的剩餘秒數（來自畫面上的 TIME）。 */
  | { type: "tick"; remainingSeconds: number };

export type SendReason =
  /** 雙方都準備好了 —— 正常路徑 */
  | "both-ready"
  /** 時間不夠了，不等了 —— 硬底線 */
  | "deadline";

export type ArbiterAction =
  /** 用**原始 emit 重放攔到的那次呼叫**送出真的 `I_am_ok`。 */
  | { type: "send-ok"; reason: SendReason }
  /** OK 鈕的外觀。`"0"` 可按、`"2"` 灰掉 —— 遊戲自己就是用這兩個 frame。 */
  | { type: "set-ok-frame"; frame: "0" | "2" }
  /** 告訴側通道我方的準備狀態變了。 */
  | { type: "announce-ready"; ready: boolean };

export interface StepResult {
  state: ArbiterState;
  actions: readonly ArbiterAction[];
}

export function initialState(): ArbiterState {
  return {
    played: { A: new Set<CardId>(), B: new Set<CardId>() },
    ready: false,
    opponentReady: false,
    committed: false,
  };
}

/**
 * 這則事件算不算一次「操作」（會取消準備的那種）。
 *
 * ⚠ **轉牌要看牌在哪裡。** 手牌中轉牌只是在挑要用哪一面，牌還沒承諾出去，
 * 不算操作；場上轉牌才算。事件層面兩者完全相同（都是 `cardrotateX(id)`），
 * 所以只能靠「這個 id 現在在不在場上」來分 —— 那份集合由 `cardclickedX`
 * 維護。這個做法**不需要知道那張牌是什麼**，只是對不透明 ID 做狀態追蹤。
 */
export function isOperation(
  state: ArbiterState,
  input: Extract<ArbiterInput, { type: "game-event" }>,
  config: ArbiterConfig,
): { operation: boolean; actor: Seat | null } {
  const actor = seatOfEvent(input.event);

  if (input.event.startsWith("cardclicked")) {
    // 出牌與收牌都算操作（V1 規則 2）。
    return { operation: actor !== null, actor };
  }
  if (input.event.startsWith("cardrotate")) {
    if (actor === null || input.cardId === undefined) return { operation: false, actor };
    return { operation: state.played[actor].has(input.cardId), actor };
  }
  if (input.event === "move_select") {
    // 沒有座位後綴 —— 這是我方自己的選擇（伺服器只回給本人）。
    return { operation: config.moveSelectCounts === true, actor: config.seat };
  }
  return { operation: false, actor };
}

/** 依取消策略判斷這次操作要不要取消我方的準備。 */
function cancels(config: ArbiterConfig, actor: Seat | null): boolean {
  if (actor === null) return false;
  switch (config.policy) {
    case "either":
      return true;
    case "opponent":
      return actor === otherSeat(config.seat);
    case "never":
      return false;
  }
}

function withPlayed(
  state: ArbiterState,
  seat: Seat,
  cardId: CardId,
  clicked: boolean,
): ArbiterState {
  const next = new Set(state.played[seat]);
  if (clicked) next.add(cardId);
  else next.delete(cardId);
  return { ...state, played: { ...state.played, [seat]: next } };
}

/**
 * 推進一步。純函式：同樣的 (config, state, input) 永遠得到同樣的結果。
 *
 * commit 之後就凍住 —— 這是不變量 2，也是為什麼每個分支都先檢查 `committed`。
 */
export function step(config: ArbiterConfig, state: ArbiterState, input: ArbiterInput): StepResult {
  const actions: ArbiterAction[] = [];

  switch (input.type) {
    case "game-event": {
      // 場上集合要**一直維護**，即使已經 commit —— 下一個階段還要用。
      let next = state;
      const actor = seatOfEvent(input.event);
      if (
        input.event.startsWith("cardclicked") &&
        actor !== null &&
        input.cardId !== undefined &&
        input.clicked !== undefined
      ) {
        next = withPlayed(next, actor, input.cardId, input.clicked);
      }

      if (next.committed || !next.ready) return { state: next, actions };

      const { operation, actor: opActor } = isOperation(next, input, config);
      if (!operation || !cancels(config, opActor)) return { state: next, actions };

      // 取消準備：OK 鈕變回可按，並告訴側通道我方不再是就緒狀態。
      return {
        state: { ...next, ready: false },
        actions: [
          { type: "set-ok-frame", frame: "0" },
          { type: "announce-ready", ready: false },
        ],
      };
    }

    case "press-ok": {
      if (state.committed) return { state, actions };

      if (state.ready) {
        // 再按一次 = 取消準備。V1 規則 1：「準備後再按一次可以取消」。
        return {
          state: { ...state, ready: false },
          actions: [
            { type: "set-ok-frame", frame: "0" },
            { type: "announce-ready", ready: false },
          ],
        };
      }

      const readyState: ArbiterState = { ...state, ready: true };
      actions.push({ type: "set-ok-frame", frame: "2" }, { type: "announce-ready", ready: true });

      // 對手早就好了 → 這一按就是雙方就緒，直接放行。
      if (readyState.opponentReady) {
        actions.push({ type: "send-ok", reason: "both-ready" });
        return { state: { ...readyState, committed: true }, actions };
      }
      return { state: readyState, actions };
    }

    case "opponent-ready": {
      if (state.committed) return { state, actions };
      const next: ArbiterState = { ...state, opponentReady: input.ready };
      if (input.ready && next.ready) {
        return {
          state: { ...next, committed: true },
          actions: [{ type: "send-ok", reason: "both-ready" }],
        };
      }
      return { state: next, actions };
    }

    case "tick": {
      if (state.committed) return { state, actions };
      // ⚠ 不變量 1：硬底線不看 opponentReady、不看策略、不看任何東西。
      // 只要玩家已經按過 OK 而時間快到了，就一定要送出去，否則等於棄權。
      if (state.ready && input.remainingSeconds <= config.deadlineSeconds) {
        return {
          state: { ...state, committed: true },
          actions: [{ type: "send-ok", reason: "deadline" }],
        };
      }
      return { state, actions };
    }
  }
}

/** 新的階段開始 —— 清掉準備與 commit，但**保留**場上的牌。 */
export function resetForNextPhase(state: ArbiterState): ArbiterState {
  return { ...state, ready: false, opponentReady: false, committed: false };
}

/** 新的一輪（牌全部收走）—— 場上集合也要清空。 */
export function resetForNextTurn(): ArbiterState {
  return initialState();
}
