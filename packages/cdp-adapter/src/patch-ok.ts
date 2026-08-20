/**
 * 攔住 `I_am_ok`，等仲裁決定何時真的送出（WP-12 的頁面側）
 * ==========================================================
 * `arbitration.ts` 是決策，這裡是**執行**。兩者分開跑在不同的地方，
 * 而分界是刻意的：
 *
 *     頁面（這個檔案）   攔截、失效保護、重放、改 OK 鈕外觀
 *     Node（arbiter）    策略：取消規則、雙方就緒、硬底線
 *
 * ⚠ **為什麼失效保護一定要在頁面裡：**
 * 插件壓著 `I_am_ok` 不送的期間，如果 CDP 連線斷了、companion 當掉、或 Node
 * 那邊卡住，玩家就會**逾時棄權**。那是不可逆的傷害，而且是我們造成的。
 * 所以頁面必須能在完全失聯的情況下自己把攔到的呼叫送出去 —— Node 的死線
 * 只是「比較早的那一道」，不是唯一的一道。
 *
 * ⚠ **但失效保護不是唯一的答案，而且它的方向是反的。**
 * 2026-08-03 實測：companion 結束之後頁面上的 patch 還活著，於是玩家每個移動
 * 階段都被壓滿 25 秒才送出，而且**按第二次也取消不了**（取消要 Node 下指令）。
 * 「先攔了再靠失效保護兜底」在 Node 活著時是對的，Node 死了就變成單向的鎖。
 * 所以現在多了一道心跳：**Node 沒回應就乾脆不攔**，退回遊戲原本的行為 ——
 * 功能沒生效，但零傷害。失效保護退回它該有的位置：最後一道，不是第一道。
 *
 * 攔截的做法是**原封不動重放**攔到的那次呼叫（`this` 與 `arguments` 都留著），
 * 所以插件永遠不需要知道 `I_am_ok` 的協定長什麼樣。遊戲改版改了參數也不會
 * 送錯東西 —— 實測參數是 `(this.room, this.id)`，但這裡完全不依賴那件事。
 *
 * §12：回報給 Node 的卡片編號是**每場重新編號的流水號**，不是遊戲的卡片 ID。
 * 仲裁只需要「這張是不是同一張」，不需要知道是哪一張 —— 見 `opaqueId`。
 */

import {
  EVENT_INFO_JSON_KEY,
  HAND_ARRAY_FIELD,
  HAND_TEXTURE_KEY,
  OK_BUTTON,
  PVP_RULES,
  STALL_STATE_KEYS,
  STATE_ICON_TEXTURE_KEY,
  WS_CLIENT,
} from "./constants.js";
import { embedJson } from "./embed.js";

export interface OkPatchOptions {
  /** 頁面呼叫這個名字把事件送回 Node。由 `Runtime.addBinding` 建立。 */
  bindingName: string;
  /**
   * 一裝上去就要不要攔 OK（＝準備功能開著沒）。
   *
   * 關掉之後**完全退回遊戲原本的行為** —— 按 OK 立刻送出。但 patch 還在，
   * 因為「準備時間縮減」不需要攔截也要用到它（強制提早結束、讀秒、hazard）。
   * 執行期可以用 `A.setHold(bool)` 切換，不必重裝。
   */
  hold?: boolean;
  /**
   * 失效保護：攔住之後最多壓這麼久，時間到頁面自己送出。
   *
   * 這是**最後一道防線**，不是正常路徑 —— 正常情況下 Node 的硬底線會更早
   * 發出釋放指令，而 Node 死掉的話心跳（`staleMs`）會更早把它放掉。
   * 看到 `failsafe` 就代表連心跳都沒發揮作用，要查。
   */
  failsafeMs?: number;
  /**
   * Node 多久沒心跳就當它死了。
   *
   * 死了之後**這個階段照常撐完**（降級成單邊，見 `OkDegraded`），
   * 到下一個階段才停止攔截。要比 `ArbiterRunner` 的 tick 間隔寬鬆得多 ——
   * 偶爾一次 CDP 往返變慢不該讓功能忽開忽關。
   */
  staleMs?: number;
  /**
   * 降級模式下，剩幾秒就自己把壓著的送出去。
   *
   * ⚠ **這是降級模式唯一的安全網。** Node 死了就沒有人會下釋放指令，而
   * `failsafeMs`（25 秒）是從按下去算起、不是從階段剩餘秒數算起 —— 玩家在
   * 階段後期才按的話，失效保護會晚於階段結束，也就是**逾時棄權**。
   *
   * 預設跟 Node 的 `DEFAULT_DEADLINE_SECONDS` 同一個值，玩家感受不到差別。
   */
  localDeadlineSeconds?: number;
  /**
   * 準備中把 OK 鈕染成什麼顏色。**`null` = 不染色**（官方原本的樣子）。
   *
   * ⚠ 染色原本的用途是「這個階段插件真的有在管」的視覺證明。設成 `null`
   * 之後就沒有這個訊號了 —— 玩家要改看系統匣圖示與設定視窗。這是刻意提供的
   * 選項（有人就是不想讓遊戲畫面被改），預設值由呼叫端決定。
   */
  readyTint?: number | null;
}

/** 降級模式的頁面端硬底線。跟 Node 的 `DEFAULT_DEADLINE_SECONDS` 對齊。 */
export const DEFAULT_LOCAL_DEADLINE_SECONDS = 3;

/** 準備中的琥珀色。跟遊戲原本的灰色鎖定分得開，也跟系統匣圖示同一個值。 */
export const READY_TINT_AMBER = 0xffc247;

/**
 * 把玩家設的顏色夾成合法的 24-bit RGB。壞掉的值一律當成「不染色」。
 *
 * ⚠ 不要讓壞值變成 `0x000000` —— 那會把 OK 鈕染成全黑，看起來像遊戲壞了，
 * 而玩家完全不會聯想到是自己在設定裡填錯了一個顏色。
 */
export function normalizeTint(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n < 0 || n > 0xffffff ? null : n;
}

/** 一個移動階段是 31 秒，25 秒的失效保護留 6 秒給伺服器與網路。 */
export const DEFAULT_FAILSAFE_MS = 25_000;

/**
 * Node 的 tick 是 250ms，容許連掉 12 次才判定它死了。
 *
 * 這個值是「功能忽開忽關」與「Node 死了還壓多久」之間的取捨。往小調會讓
 * 一次網路抖動就把攔截關掉；往大調會讓玩家在 companion 當掉之後多鎖幾秒。
 */
export const DEFAULT_STALE_MS = 3_000;

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

/** 玩家按了 OK，呼叫已經被攔下來。 */
export interface OkIntercepted {
  type: "ok-intercepted";
  at: number;
}

/**
 * 已經壓著一個的情況下玩家又按了 OK。
 *
 * 頁面**沒有**送出，等仲裁決定 —— 它會判成取消準備。
 */
export interface OkPressedAgain {
  type: "ok-pressed-again";
  at: number;
}

/** 攔到的呼叫已經真的送出去了。 */
export interface OkReleased {
  type: "ok-released";
  /**
   * - `arbiter` —— Node 指示，正常路徑
   * - `phase-ended` —— 階段結束了，壓著已無意義（頁面自己判斷）
   * - `local-deadline` —— **降級模式**下由頁面自己顧的硬底線（見 `ok-degraded`）
   * - `failsafe` —— 壓滿上限，**代表連硬底線都沒發揮作用**，看到就要查
   * - `reinstall` / `uninstall` —— 換版或拆掉前先送出去，避免半路丟掉害玩家棄權
   * - `forced` —— 約定秒數到了，**玩家根本沒按 OK**，是我們替他按的
   */
  by:
    | "arbiter"
    | "phase-ended"
    | "local-deadline"
    | "failsafe"
    | "reinstall"
    | "uninstall"
    | "forced";
  /** 從攔截到送出經過多久。替玩家按的那條路是 0。 */
  heldMs: number;
}

/**
 * Node 在這個階段中途失聯了，但**準備功能沒有當場消失**。
 *
 * ⚠ 這則存在的理由是一個真實的傷害情境：玩家按下 OK、看到按鈕變色、
 * 以為「還能再按一次反悔」，而就在這時 Node 死掉。舊的行為是心跳一過期
 * 就把壓著的那次**直接送出去** —— 玩家的反悔窗口在他不知情的狀況下變成
 * 已定案，而畫面上什麼都沒說。
 *
 * 現在改成：**這個階段撐完**。頁面自己接手單邊的部分（再按一次可以取消、
 * 剩 `localDeadlineSeconds` 秒時自己送出），到**下一個階段**才真的關掉功能。
 * 換句話說，功能的開關只在階段邊界改變，永遠不會在玩家操作到一半時變。
 *
 * 單邊的「誤按反悔」本來就不需要對手也不需要 Node —— 頁面自己做得到。
 * 需要 Node 的只有「等對手也好了才一起送」，而那個在降級模式下本來就沒了。
 */
export interface OkDegraded {
  type: "ok-degraded";
  /** 第幾個移動階段降級的。 */
  phaseId: number;
  /** 降級的當下有沒有正壓著玩家的 OK。 */
  holding: boolean;
}

/** 對戰中的操作事件，已經去識別化。 */
export interface OkPatchEvent {
  type: "ok-patch-event";
  event: string;
  /** 每場重新編號的流水號，不是遊戲的卡片 ID（§12）。 */
  cardRef?: number;
  clicked?: boolean;
  at: number;
}

export interface OkPatchInstalled {
  type: "ok-patch-installed";
  /** 從 `MainA.PLAYER` 讀到的座位。讀不到就是 null（還沒進對戰）。 */
  seat: string | null;
  /** 有沒有真的掛到 socket 上。false 代表還沒進遊戲，之後會自己補掛。 */
  armed: boolean;
}

/**
 * 換到了一顆新的 socket，攔截已經重新掛好。
 *
 * ⚠ **這代表換場了**（重新開房、進任務）。Node 那邊的場上牌組集合、座位、
 * 準備狀態全部要重來 —— 沿用舊的會讓敵我判斷錯半數。見 `SOCKET_LIFETIME_NOTE`。
 */
export interface OkPatchRearmed {
  type: "ok-patch-rearmed";
  seat: string | null;
}

export interface OkPatchError {
  type: "ok-patch-error";
  reason: string;
}

export type OkPatchReport =
  | OkIntercepted
  | OkPressedAgain
  | OkReleased
  | OkDegraded
  | OkPatchEvent
  | OkPatchInstalled
  | OkPatchRearmed
  | OkPatchError;

const REPORT_TYPES = new Set([
  "ok-intercepted",
  "ok-pressed-again",
  "ok-released",
  "ok-degraded",
  "ok-patch-event",
  "ok-patch-installed",
  "ok-patch-rearmed",
  "ok-patch-error",
]);

export function isOkPatchReport(value: unknown): value is OkPatchReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

/** 頁面上掛控制介面的全域名稱。Node 用 `Runtime.evaluate` 呼叫它。 */
export const OK_PATCH_GLOBAL = "__ulrArbiter";

/** `state.tick()` 的回傳。一次往返同時做心跳、讀秒、報階段與 hazard。 */
export interface OkPatchTick {
  /** 畫面上的剩餘秒數。讀不到（不在有倒數的階段）就是 null。 */
  remaining: number | null;
  /**
   * 攔截掛在 socket 上，**而且這一場還在進行中**。
   *
   * ⚠ 後半段不是多餘的：戰鬥結束後 Phaser 的場景物件與那顆（已關閉的）
   * socket 都還留著，只問「掛上了沒」的話托盤會在結算畫面上繼續寫
   * 「對戰中」。托盤直接拿這個欄位當「在不在對戰」用。
   */
  armed: boolean;
  /** 目前這場的座位。**每場重新分配，不能快取。** */
  seat: string | null;
  /** 現在是不是在該仲裁的階段（移動階段）。 */
  inPhase: boolean;
  /**
   * 對手是**真人**（`duel` / `ranked`）。任務、渦、活動都是 `false`。
   *
   * ⚠ **這是頁面回報的，不是 Node 推的。** 硬閘門在頁面裡（`inPvpMatch()`），
   * 這個欄位只是讓 Node 少做白工、並且讓托盤講得出「為什麼沒生效」。
   * Node 少判一次只是多幾次 CDP 往返；頁面少判一次就是打渦時被替按 OK。
   */
  pvp: boolean;
  /**
   * 這一場的 rule 字串（`duel` / `ranked` / `quest` / `raid` / `event`）。
   * 不在對戰中、或值長得不像模式名就是 `null`。
   *
   * ⚠ 只給 UI 與記錄用，**判斷一律看 `pvp`** —— 兩邊各自解析同一個字串
   * 就是在等它們哪天漂開。
   */
  rule: string | null;
  /**
   * 第幾個移動階段。每進入一次就 +1。
   *
   * ⚠ **重置仲裁狀態要看它，不要看 `ok-released`。** 送出之後重置是對的，
   * 但「約定秒數」那條路在同一個階段裡可能沒有任何 `ok-released`（玩家根本
   * 沒按），只看送出事件會讓 `committed` 在階段之間漏掉重置。
   */
  phaseId: number;
  /**
   * 手牌有聖水／聖杯，而且場上有麻痺／降低移動／自壞。
   *
   * 這是「準備時間縮減」的修正項，為真時約定秒數再減 5 秒。
   * 判斷完全在頁面做，**Node 只拿到一個布林** —— 手牌內容不離開頁面（§12）。
   */
  hazard: boolean;
  /** 攔截功能開著沒。托盤切換之後用它確認頁面真的收到了。 */
  hold: boolean;
  /** 這個階段已經送出過 `I_am_ok` 了。 */
  sent: boolean;
  /**
   * 這一場的 room id（`MainA.room`）。不在對戰中就是 null。
   *
   * ⚠ **這是高熵字串，不得記錄也不得上傳**（§12）。側通道要用它把兩個玩家
   * 配在一起，但**只送雜湊過的**版本 —— `@ulr/arbiter-link` 的 `roomKey()`。
   * 2026-08-06 雙開實測：同一場對戰兩個客戶端的 `MainA.room` 完全相同，
   * 這也回答了 `battle-features.md` 那四個 probe 問題的第 4 條。
   */
  room: string | null;
}

/** 把 OK 送出去、不管玩家按了沒。回傳頁面做了什麼。 */
export type ForceEndResult =
  /** 壓著玩家按的那次 → 原封不動重放 */
  | "released"
  /** 玩家沒按 → 替他按了一次 OK 鈕 */
  | "pressed"
  /** 這個階段已經送過了 */
  | "already-sent"
  /** **對手是 NPC**（任務／渦／活動）—— 這個功能整組不生效 */
  | "not-pvp"
  /** 不在移動階段，或找不到按鈕 */
  | "not-in-phase"
  | "no-button";

/** 拆掉頁面上的 patch。Node 結束前一定要跑這句，否則會留下孤兒。 */
export const OK_PATCH_UNINSTALL_EXPRESSION = `(function () {
  try {
    var A = window.${OK_PATCH_GLOBAL};
    if (!A || typeof A.uninstall !== "function") return "not-installed";
    return A.uninstall("uninstall");
  } catch (e) { return "error:" + String((e && e.message) || e); }
})()`;

// ---------------------------------------------------------------------------
// 產生注入腳本
// ---------------------------------------------------------------------------

/**
 * 產生要在遊戲 context 裡求值的 JS。純函式，可完整測試。
 *
 * 跟 `ws-events.ts` 一樣用 `Runtime.evaluate` 裝，**不需要 reload** ——
 * 玩家對戰中也能接上。而且**還沒進遊戲也裝得上**：裝的時候沒有 socket 就先
 * 空轉，`phaseTick` 每 200ms 會自己去補掛。所以三種時機都成立：遊戲還沒開、
 * 開了還沒進對戰、對戰中途接手。
 */
export function buildOkPatchScript(options: OkPatchOptions): string {
  const config = {
    bindingName: options.bindingName,
    failsafeMs: options.failsafeMs ?? DEFAULT_FAILSAFE_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    hold: options.hold ?? true,
    global: OK_PATCH_GLOBAL,
    okEvent: "I_am_ok",
    /** hazard 判斷要用的三個東西，全部從 constants.ts 帶進來。 */
    eventInfoKey: EVENT_INFO_JSON_KEY,
    handTexture: HAND_TEXTURE_KEY,
    handField: HAND_ARRAY_FIELD,
    stallStates: STALL_STATE_KEYS,
    /**
     * 狀態圖示的材質鍵。**frame 名就是狀態鍵**（`jikai` / `atkD3` / `defD3`），
     * 同一個容器裡的 BitmapText 是剩餘回合數。2026-08-10 對著跑著的客戶端實測。
     */
    stateTexture: STATE_ICON_TEXTURE_KEY,
    sendMethod: WS_CLIENT.sendMethod,
    listenAllMethod: WS_CLIENT.listenAllMethod,
    unlistenAllMethod: WS_CLIENT.unlistenAllMethod,
    okScene: OK_BUTTON.scene,
    okTexture: OK_BUTTON.textureKey,
    /**
     * 只有這兩種 rule 底下對手才是真人。**白名單，不是黑名單** ——
     * 理由見 `constants.ts` 的 `NPC_RULES`。
     */
    pvpRules: PVP_RULES,
    /**
     * 準備中的染色。**預設 `null` = 不染色，維持官方原本的樣子。**
     *
     * ⚠ 預設不染色是玩家指定的。代價是少了「這個階段插件有在管」的畫面訊號，
     * 所以系統匣圖示的三色語意變得更重要 —— 不要為了「畫面乾淨」也把它拿掉。
     */
    readyTint: options.readyTint === undefined ? null : normalizeTint(options.readyTint),
    localDeadlineSeconds: options.localDeadlineSeconds ?? DEFAULT_LOCAL_DEADLINE_SECONDS,
    /**
     * 只在這些場景 active 時攔截。
     *
     * ⚠ **攻擊與防禦階段不要仲裁**（玩家要求）。那兩個階段沒有「先承諾被
     * 懲罰」的問題 —— 出手順序是先攻決定的，不是誰先按 OK。在那裡壓住 OK
     * 只會拖慢節奏，沒有任何好處。
     *
     * 場景名的 A 是**相對視角**（本地玩家永遠是 A），所以兩個座位都用同一個
     * 名字。跟事件名的絕對座位是兩套相反的慣例 —— 見 `SCENE_NAMING_NOTE`。
     */
    interceptScenes: ["MovePhaseA"],
    /** 多久檢查一次階段、socket 與心跳。 */
    phaseCheckMs: 200,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var G = CFG.global;
  var has = Object.prototype.hasOwnProperty;

  /**
   * ⚠ 重新求值時要**先把舊的 patch 拆掉**，不能只換設定。
   *
   * 原本這裡寫的是「已經裝過就只更新 cfg」。那對改設定沒問題，但**改了程式碼
   * 就完全無效** —— 頁面上跑的還是舊的函式，而症狀是「明明改好了、測試也綠，
   * 實際跑起來卻沒反應」。2026-08-02 在 pinFrame 上踩到，而更早在 ws-events
   * 的取值模式上踩過同一個坑。
   */
  var prev = window[G];
  if (prev) {
    try {
      if (typeof prev.uninstall === "function") {
        prev.uninstall("reinstall");
      } else {
        // 舊版沒有 uninstall()。拆的順序很重要：
        //   1. 先把壓著的呼叫送出去 —— 半路換掉而把它丟掉的話，玩家會棄權
        //   2. 還原 emit，否則新的 patch 會包在舊的外面，變成兩層攔截
        //   3. 拆掉釘 frame 的 listener 與染色，不然會留下孤兒
        try { if (prev.held) prev.release("reinstall"); } catch (e) {}
        try { clearInterval(prev.phaseTick); } catch (e) {}
        try { if (prev.pinFrame) prev.pinFrame(null); } catch (e) {}
        try {
          var psc = window.game.scene.keys[CFG.okScene];
          if (psc && psc.ok) psc.ok.clearTint();
        } catch (e) {}
        try {
          if (prev.proto && prev.originalEmit) prev.proto[CFG.sendMethod] = prev.originalEmit;
        } catch (e) {}
      }
    } catch (e) {}
    window[G] = null;
  }

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {}
  }

  /**
   * 遊戲的卡片 ID → 每場重新編號的流水號。
   *
   * §12：仲裁只需要判斷「這張是不是剛才那張」，不需要知道是哪一張。
   * 對手的卡片 ID 在翻牌前是隱藏資訊，所以**不讓它離開頁面**。
   */
  var refs = { A: {}, B: {} }, refNext = { A: 1, B: 1 };
  function opaqueId(seat, id) {
    if (!refs[seat]) { refs[seat] = {}; refNext[seat] = 1; }
    var k = String(id);
    if (!refs[seat][k]) refs[seat][k] = refNext[seat]++;
    return refs[seat][k];
  }
  function seatOf(name) {
    var s = String(name).slice(-1);
    return (s === "A" || s === "B") ? s : null;
  }

  function mainScene() {
    try {
      var sc = window.game && window.game.scene && window.game.scene.keys;
      return (sc && sc[CFG.okScene]) || null;
    } catch (e) { return null; }
  }

  /**
   * 現在是不是該仲裁的階段。
   *
   * 攻擊／防禦階段不是 —— 那裡沒有「先承諾被懲罰」的不對稱（出手順序由
   * 先攻決定），壓住 OK 只會拖慢節奏。
   */
  function inInterceptPhase() {
    return movePhase() !== null;
  }

  /**
   * ⚠⚠ **這一場對戰還在進行中嗎。戰鬥結束不等於場景消失。**
   *
   * 玩家 2026-08-20 回報：戰鬥打完了，握手卻還留著，而且會影響到下一場
   * （下一場的對手沒插件）。成因是 Phaser 的場景物件**建一次就一直留著** ——
   * 結算畫面出現之後，MainA 上的 room、config.rule、socket、ok 全部原封不動
   * 還在。只讀那些欄位的話，插件會在結算、回大廳、下一輪配對的整段時間裡
   * 一直宣稱「還在對戰、房號是上一場那個」，於是側通道停在上一場的房裡
   * 繼續握手（2026-08-20 對兩個跑著的客戶端實測：MainA 已經 shutdown，
   * tick() 仍然回 pvp=true、room=上一場）。
   *
   * 權威來源是客戶端自己的 MainA.on_result（同日從跑著的客戶端讀出來的）：
   *
   *     this.socket.off()
   *     this.socket.emit("leaveRoom", this.room)
   *     this.socket.disconnect()          ← 最早、也最明確的結束訊號
   *     … 等結束語音播完，可能好幾秒 …
   *     this.scene.stop(); this.scene.start("Result")
   *
   * 所以兩個訊號都收：**連線關了**（早幾秒）或**場景收掉了**（保險，
   * 改版把 disconnect 拿掉時還有這一道）。
   *
   * ⚠ socket 是遊戲自己的 WSClient，**沒有 connected 這個欄位** ——
   * 它把底下那顆 WebSocket 的 readyState 透出來（實測結束後兩個客戶端都是 3）。
   * 用的是標準的 0 連線中 / 1 開著 / 2 關閉中 / 3 已關閉，所以只有 >= 2 才算
   * 結束：還沒建好時是 undefined，那是「還不知道」不是「結束了」，
   * 當成結束會讓每一場的開頭判錯。
   *
   * ⚠ 場景那道看的是 **status 而不是 active**。Phaser 的
   * status：5 RUNNING / 6 PAUSED / 7 SLEEPING / 8 SHUTDOWN / 9 DESTROYED，
   * 而 active 只有 RUNNING 時是 true —— 也就是**暫停也會被當成結束**。
   * 目前沒有任何場景會 pause／sleep MainA（2026-08-20 掃過客戶端全部場景的
   * 原始碼），但雙開時永遠有一邊沒有焦點，把某條暫停路徑誤判成「戰鬥結束」
   * 的代價是那一邊整場不生效。只認 >= 8（收掉了）就沒有這個風險。
   *
   * ⚠ 反過來，還沒開始的那一頭**不需要**這裡管：status 是 0 的時候
   * MainA 上根本還沒有 config 與 room，battleRule() 與 room() 自然回 null。
   *
   * （注入腳本是 TS 的樣板字串，這段註解裡不能用反引號。）
   */
  function battleLive() {
    try {
      var sc = mainScene();
      if (!sc) return false;
      var st = sc.sys && sc.sys.settings;
      if (!st) return false;
      if (typeof st.status === "number" && st.status >= 8) return false;
      var rs = sc.socket && sc.socket.readyState;
      if (typeof rs === "number" && rs >= 2) return false;
      return true;
    } catch (e) {
      // 判斷不出來就當成不在對戰。跟這個檔案其他地方一樣：不確定時停手。
      return false;
    }
  }

  /**
   * 這一場的 rule（quest / raid / event / duel / ranked）。讀不到就 null。
   *
   * 值在 MainA.config.rule，2026-08-09 對著跑著的客戶端實測：
   * 打渦讀到 "raid"、打任務讀到 "quest"。
   *
   * ⚠ **戰鬥結束後要回 null，不是回上一場的 rule。** config 會留在場景上，
   * 而這個函式是 inPvpMatch() 的唯一輸入 —— 見 battleLive()。
   */
  function battleRule() {
    try {
      if (!battleLive()) return null;
      var sc = mainScene();
      var r = sc && sc.config && sc.config.rule;
      // 只收像模式名的短小寫字串 —— 別的東西一律當成「不知道」。
      return (typeof r === "string" && /^[a-z_]{1,16}$/.test(r)) ? r : null;
    } catch (e) { return null; }
  }

  /**
   * ⚠⚠ **對手是真人嗎。這是整個 patch 的總開關。**
   *
   * 玩家 2026-08-09 回報：打渦、打任務時「準備」與「約定秒數」照樣生效。
   * 成因是這個檔案原本只問「在不在移動階段」—— 而任務與渦的移動階段
   * 跟對戰長得一模一樣（實測兩者都會讓 MovePhaseA active）。
   *
   * 對 NPC 生效不只是多餘，是**有害**的：
   *
   *   準備   對面是程式，永遠不會「也按 OK」→ 每個移動階段都壓到底線才送出
   *   秒數   替玩家按 OK，而他正在打王、正想多看兩秒
   *
   * ⚠ **讀不到 rule 一律當成不是 PvP。** 方向是刻意的：不介入只是功能沒開，
   * 介入錯了是替玩家做了他沒要求的決定。跟 movePhase() 讀不到就放行、
   * 跟心跳過期就停手是同一條原則。
   *
   * （注入腳本是 TS 的樣板字串，這段註解裡不能用反引號。）
   */
  function inPvpMatch() {
    var r = battleRule();
    return r !== null && CFG.pvpRules.indexOf(r) !== -1;
  }

  /** 目前 active 的移動階段場景，不在就 null。 */
  function movePhase() {
    try {
      var scenes = window.game.scene.keys;
      for (var i = 0; i < CFG.interceptScenes.length; i++) {
        var sc = scenes[CFG.interceptScenes[i]];
        if (sc && sc.sys && sc.sys.settings && sc.sys.settings.active) return sc;
      }
      return null;
    } catch (e) {
      // 判斷不出來就**不要攔** —— 放行是安全的，攔錯階段會拖慢玩家。
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 讀秒顯示：約定秒數要讓玩家看得見（玩家要求，2026-08-06）
  //
  // 遊戲的倒數**整段都是客戶端算的**（實測原始碼）：
  //
  //     this.timelimit = 30;                                   ← create()
  //     this.time.addEvent({ delay: 100, ... timelimit -= .1 })
  //     // update() 每一幀從 timelimit 重算三樣東西：
  //     text.setText(timelimit.toPrecision(...))
  //     colorIdx = trunc(timelimit / 30 * 240)   ← 240=藍 0=紅
  //     guage.scaleX = timelimit / 30 * .934 + .066
  //
  // 三樣東西**全部是 timelimit 的純函式**，而且分母是寫死的 30。所以要讓
  // 「約定 15 秒」看起來像真的只有 15 秒，只要在 update() 之後用
  // (timelimit - (30 - cap)) / cap 重算同樣三樣東西就好。
  //
  // ⚠ **不要去改 this.timelimit 本身。** 那是伺服器那 31 秒的本機影子，
  // 硬底線、hazard 判斷、失效保護全部靠它。改了它等於同時改掉三個安全機制，
  // 而症狀會是「插件在還有很多時間的時候就把 OK 送出去」。
  // 我們只覆蓋**畫出來的東西**。
  //
  // ⚠ 也因此 state.remaining() 改成直接讀 timelimit，不再解析畫面上的字 ——
  // 那個字現在是我們自己寫的，拿它回推剩餘秒數會變成自己騙自己。
  // -------------------------------------------------------------------------

  /** 遊戲自己的分母。改版動到它的話畫面會歪，但不影響安全機制。 */
  var GAME_PHASE_SECONDS = 30;

  /** 照遊戲原本的規則把秒數格式化成畫面上那個字。 */
  function formatTime(v) {
    if (v > 10.1 || (v <= 10 && v >= 1)) return v.toPrecision(2);
    if (v < 1 && v > 0.1) return v.toPrecision(1);
    return (0).toPrecision(1);
  }

  /**
   * 把 MovePhaseA 的 update() 包起來，畫成「這個階段只有 cap 秒」的樣子。
   *
   * ⚠⚠ **只換原型完全沒有效果。**（2026-08-06 對著真的遊戲實測踩到）
   *
   * Phaser 的 Systems 在 init 就把 scene.update 抄了一份：
   *
   *     // Systems.init
   *     if (this.scene.update) this.sceneUpdate = this.scene.update;
   *     // Systems.step —— 每一幀呼叫的是**那份抄本**
   *     this.sceneUpdate.call(this.scene, time, delta);
   *
   * 所以場景建立**之後**才換原型，跑的還是舊的那份。症狀極度誤導：
   * Object.getPrototypeOf(mp).update 檢查起來是新版、__ulrTimerPatched
   * 也是 true，**但畫面完全沒變** —— 看起來像我們算錯了，其實是根本沒被呼叫。
   *
   * 所以兩邊都要換：
   *
   *   原型          → 場景之後重新 init 時會抄到新版（換場、重開對戰）
   *   sys.sceneUpdate → 現在這一顆場景實例，立刻生效
   *
   * 這跟 SOCKET_LIFETIME_NOTE 是同一個形狀的坑：**原型上的東西跨場活著，
   * 實例上的抄本每場重來。** 這個檔案裡已經有第二個了。
   */
  function patchDisplay(sc) {
    try {
      var proto = Object.getPrototypeOf(sc);
      if (!proto || typeof proto.update !== "function") return false;
      if (proto.__ulrTimerPatched) {
        // 原型已經是新版了，但這一顆實例的抄本可能還是舊的。
        adoptSceneUpdate(sc, proto);
        return true;
      }

      var original = proto.update;
      proto.update = function () {
        var result = original.apply(this, arguments);
        try {
          var cap = state.displayCap;
          if (cap === null || cap >= GAME_PHASE_SECONDS) return result;
          // ⚠ 對 NPC 不改讀秒。放在 cap 判斷**之後**是為了成本：非對戰時
          // Node 本來就會把 cap 設成 null，上面那行早退，這裡每幀不用再問一次。
          if (!inPvpMatch()) return result;
          if (typeof this.timelimit !== "number") return result;

          var shown = this.timelimit - (GAME_PHASE_SECONDS - cap);
          if (shown < 0) shown = 0;
          var ratio = shown / cap;
          if (this.text) this.text.setText(formatTime(shown));
          if (this.hsv && this.guage) {
            var ci = Math.trunc(ratio * 240);
            if (ci < 0) ci = 0;
            if (ci > 240) ci = 240;
            this.colorIdx = ci;
            this.guage.setFillStyle(this.hsv[ci].color);
            // 0.066 是遊戲留的最小長度，照抄才不會在最後一刻整條消失。
            this.guage.scaleX = ratio * 0.934 + 0.066;
          }
        } catch (e) {
          // 畫壞了不能影響遊戲，也不能影響仲裁。
        }
        return result;
      };
      proto.__ulrTimerPatched = true;
      state.displayProto = proto;
      state.originalUpdate = original;
      adoptSceneUpdate(sc, proto);
      return true;
    } catch (e) { return false; }
  }

  /**
   * 讓**這一顆場景實例**改用原型上的新版 update。
   *
   * 見 patchDisplay 開頭：Phaser 每一幀跑的是 init 當時抄下來的
   * sys.sceneUpdate，不是原型上那個。
   */
  function adoptSceneUpdate(sc, proto) {
    try {
      if (!sc.sys || sc.sys.sceneUpdate === proto.update) return;
      if (state.displayScene !== sc) {
        state.displayScene = sc;
        state.originalSceneUpdate = sc.sys.sceneUpdate;
      }
      sc.sys.sceneUpdate = proto.update;
    } catch (e) {}
  }

  /** 還原讀秒顯示。**拆 patch 前一定要跑**，否則玩家會看到一個沒人維護的假倒數。 */
  function unpatchDisplay() {
    try {
      if (state.displayProto && state.originalUpdate) {
        state.displayProto.update = state.originalUpdate;
        delete state.displayProto.__ulrTimerPatched;
      }
    } catch (e) {}
    // ⚠ 實例上的抄本也要還原，不然原型換回去了、這一顆場景照樣跑新版。
    try {
      if (state.displayScene && state.originalSceneUpdate) {
        state.displayScene.sys.sceneUpdate = state.originalSceneUpdate;
      }
    } catch (e) {}
    state.displayProto = null;
    state.originalUpdate = null;
    state.displayScene = null;
    state.originalSceneUpdate = null;
  }

  /** Node 還在不在。沒心跳就當它死了。 */
  function nodeAlive() {
    return (Date.now() - state.lastBeat) <= CFG.staleMs;
  }

  // -------------------------------------------------------------------------
  // hazard：手牌有聖水／聖杯 + 場上有麻痺（WP-15 的「再提早 5 秒」）
  //
  // ⚠ 整段**只回傳一個布林給 Node**。手牌是我方自己的資訊，不是隱藏資訊，
  // 但沒有理由讓它離開頁面 —— §12 的做法一律是「邊界擋一次」。
  // -------------------------------------------------------------------------

  /** 行動卡定義表。取不到就當沒有 hazard（不縮短，安全的方向）。 */
  function eventInfo() {
    try {
      var raw = window.game.cache.json.get(CFG.eventInfoKey);
      if (!raw) return null;
      return Array.isArray(raw) ? raw : (raw.frames || null);
    } catch (e) { return null; }
  }

  /**
   * 手牌裡有沒有聖水／聖杯（holy）或毒杯（holy_enemy）。
   *
   * （注入腳本是 TS 的樣板字串，這段註解裡不能用反引號。）
   *
   * ⚠ **走 arr1 而不是畫面上的物件。** 手牌會分頁，沒翻到的那頁在顯示清單裡
   * 根本不存在 —— 只看畫面會漏掉一半，而漏掉的方向是「以為沒有聖水」，
   * 也就是這條規則安靜地失效。
   */
  function handHolyCount() {
    try {
      var info = eventInfo();
      var sc = mainScene();
      var hand = sc && sc[CFG.handField];
      if (!info || !hand) return 0;

      var n = 0;
      (function walk(o, d) {
        if (!o || d > 3) return;
        if (Array.isArray(o)) {
          for (var i = 0; i < o.length; i++) walk(o[i], d + 1);
          return;
        }
        if (typeof o !== "object") return;
        if (o.texture && o.texture.key === CFG.handTexture && o.frame && o.visible) {
          var card = info[Number(o.frame.name)];
          if (card && (card.holy === true || card.holy_enemy === true)) n++;
        }
      })(hand, 0);
      return n;
    } catch (e) { return 0; }
  }

  function handHasHoly() {
    return handHolyCount() > 0;
  }

  /**
   * 聖水／聖杯離開手牌了 → 當成「我把狀態解掉了」，清掉我這一側的計數器。
   *
   * ⚠ **這是繞路，不是正解。** 正解是從遊戲現況重讀狀態，但伺服器解除時
   * 一則事件都不送（2026-08-09 錄 441 秒實證），而遊戲把「誰中了什麼」放在
   * 哪裡目前還沒找到。在那之前，用「聖水從手上消失了」當代理訊號。
   *
   * 為什麼是數手上的聖水，而不是去解析 cardclicked 的那個 num：
   * num 要反查卡片種類得先建一張 num → 卡種的表，而 arr1 的格子上**沒有**任何
   * 識別欄位（實測：Sprite 只有 acframe/acspe/acbow 幾張材質，data 是空的）。
   * 數手上還剩幾張反而是直接觀察得到的事實。
   *
   * （注入腳本是 TS 的樣板字串，這段註解裡不能用反引號。）
   *
   * ⚠ **只清自己這一側。** 聖水解的是自己身上的狀態，對手的不歸我管。
   *
   * ⚠ 誤判的方向是安全的：多清了 → hazard 變 false → **不縮短**，不會從玩家
   * 手上偷走 5 秒。反過來（該清沒清）才是玩家回報的那個問題。
   * 手牌翻頁會讓沒翻到的那頁變 invisible、數字下降，也會走到這裡 —— 同樣是
   * 往安全的方向錯。
   */
  /**
   * ⚠⚠ **2026-08-09 暫時停用，為了把兩個症狀分開。**
   *
   * 玩家在裝了這段之後回報：自壞剩 2 回合會縮短、剩 1 回合反而不縮短 ——
   * 也就是插件的計數器比畫面**少 1**。而這段程式碼是嫌疑最大的一個：
   *
   *   1. 它會**整組清空**我方的狀態計數器
   *   2. 它的觸發條件是「手上的聖水少了一張」，而手牌掃描實測出現過
   *      **畫面有 9 張、掃描回報 0 張**的情況 —— 那會被當成聖水用掉了
   *   3. 而且它清掉的東西包含自壞，但**聖水根本解不了自壞**
   *
   * 三件事湊起來，症狀會跟真正的 off-by-one 長得一模一樣。所以先停掉，
   * 讓玩家重測一輪：
   *
   *   停掉後症狀消失 → 成因是這段（要改成只清聖水真的解得掉的狀態，
   *                     而且要先修好手牌掃描的間歇性 0）
   *   停掉後症狀還在 → 成因在別處，這段可以照原樣裝回來
   *
   * ⚠ 停用期間「聖水解掉麻痺、5 秒沒加回來」那個原始問題會回來 ——
   * 那是刻意的取捨：一次只動一個變因，否則兩個症狀會互相掩蓋。
   */
  var HOLY_CLEAR_ENABLED = false;

  function noticeHolyUsed() {
    try {
      var now = handHolyCount();
      var before = state.holyCount;
      state.holyCount = now;
      if (!HOLY_CLEAR_ENABLED) return;
      if (before === null || now >= before) return;
      var seat = state.seat();
      if (seat !== "A" && seat !== "B") return;
      // ⚠ 裝回來的時候**不要再清 jikai**：聖水解不了自壞。
      for (var key in state.states[seat]) {
        if (!has.call(state.states[seat], key) || key === "jikai") continue;
        delete state.states[seat][key];
        delete state.statesAt[seat + ":" + key];
      }
    } catch (e) {}
  }

  /**
   * 自壞**只有剩最後一回合**才算拖時間。
   *
   * ⚠ 玩家 2026-08-09 指定，而這其實是把規格書原本的寫法補回來 ——
   * battle-features.md 規則 3 寫的是「剩一回自壞」，實作時漏掉了「剩一回」
   * 這三個字，變成只要身上有自壞就算。
   *
   * 語意上也只有這樣才對：自壞還有 2~4 回合的時候，它跟拖時間完全無關；
   * 要到剩最後一回合，那一回合的決策才真的變重（下一回合就爆了）。
   * 麻痺與降低移動沒有這個分別 —— 它們一生效就在拖。
   */
  function stallCounts(key, turns) {
    if (turns <= 0) return false;
    return key === "jikai" ? turns === 1 : true;
  }

  /**
   * 場上有沒有拖時間型的狀態（麻痺／降低移動／剩一回的自壞）。
   *
   * 資料來自 state("mahi_2","A","B") 事件：<鍵>_<剩餘回合數>、誰中了、
   * 誰施加的。伺服器**只在施加時通知一次**，所以剩餘回合要自己數 ——
   * 每收到一次 endTurn 就全部減一。
   *
   * ⚠⚠ **自己數是會留下幽靈的**（2026-08-09 錄 441 秒的事件流證實）：
   * 玩家用聖水把麻痺解掉時，伺服器**一則事件都不送**。7 則 state 全部是
   * 「施加」，沒有任何一則是「解除」。所以這個計數器只會在回合數自然歸零時
   * 才消失，中途被解除的話它會一直留著。
   *
   * 後果正是玩家回報的那個：解完麻痺，秒數卻沒加回去（只要手上還有另一張
   * 聖水／聖杯，hazard 的另一個條件仍然成立）。真正的修法是改成從遊戲的
   * 現況重讀，不要自己數 —— 那需要先找到狀態的即時來源，還沒做。
   *
   * ⚠ 不用畫面上的圖示是因為分不出哪個圖示是哪個狀態（27 種共用一張圖集，
   * 而 frame 對應關係沒有實測過）。事件這條至少每個欄位都有實測依據。
   */
  /**
   * 一張狀態圖示的 frame 名對不對得上我們在意的那三個鍵。
   *
   * 實測 frame 名**就是狀態鍵本身**，有時後面接一個數值：
   *
   *     frame=jikai    自壞
   *     frame=atkD3    攻擊力 -3
   *     frame=defD3    防禦力 -3
   *
   * 所以用前綴比對。⚠ 不要用 indexOf(k) !== -1（包含），那會讓 movB 之類的
   * 鍵互相誤中。
   */
  function stallMatches(frameName, turns) {
    for (var i = 0; i < CFG.stallStates.length; i++) {
      var k = CFG.stallStates[i];
      if (frameName === k || frameName.indexOf(k) === 0) return stallCounts(k, turns);
    }
    return false;
  }

  /**
   * ⚠⚠ **直接讀畫面上的狀態圖示，不再自己數回合。**（2026-08-10 改）
   *
   * 舊版靠 state 事件自己數，而那條路**結構上就不可能正確**：
   *
   *   - 伺服器**解除狀態時什麼都不送**（錄 441 秒實證），被解掉的會變成幽靈
   *   - 自壞在移動階段結束時減，其他狀態在回合結束後減，我們只有一個 endTurn
   *   - 只要漏收一次事件，計數器就永遠偏掉，而且再也回不來
   *
   * 症狀是玩家連續回報的「剩 2 回合會縮短、剩 1 回合反而不縮短」，而我照著
   * 單次快照推了三次因果、三次方向都不一樣 —— 那正是在量一個不可信的東西。
   *
   * 現在讀的是**遊戲自己畫出來的那個數字**：
   *
   *     Image       tex=state_tmp   frame=jikai    ← 狀態種類
   *     BitmapText  tex=state_font  text="2"       ← 剩餘回合，同一個容器裡
   *
   * 這是遊戲的真相，所以解除、時機差、漏事件三個問題一起消失。
   *
   * ⚠ 讀不到就回 false（不縮短）。跟這個檔案其他地方一樣：不確定時停手。
   */
  function stallStateActive() {
    try {
      var sc = mainScene();
      if (!sc) return false;
      var found = false;
      (function walk(o, d) {
        if (found || !o || d > 6 || o.visible === false) return;
        // ⚠ **Scene 的子物件在 children.list，容器的在 list。**
        // 只看 list 的話從 Scene 起步第一層就結束了 —— 而假頁面若剛好給了
        // list，測試會全綠而實際頁面一個狀態都讀不到（2026-08-10 實測踩到）。
        // remaining() 早就有這個 fallback，這裡漏抄了。
        var kids =
          o.list && o.list.length
            ? o.list
            : o.children && o.children.list
              ? o.children.list
              : null;
        if (!kids) return;

        // 一個狀態 = 同一個容器裡「一張 state_tmp 圖 + 一個 BitmapText」
        var key = null;
        var turns = null;
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i];
          if (!c || c.visible === false) continue;
          if (c.texture && c.texture.key === CFG.stateTexture && c.frame) {
            key = String(c.frame.name);
          } else if (c.type === "BitmapText") {
            var v = parseInt(String(c.text), 10);
            if (isFinite(v)) turns = v;
          }
        }
        if (key !== null && turns !== null && stallMatches(key, turns)) {
          found = true;
          return;
        }
        for (var j = 0; j < kids.length && j < 150; j++) walk(kids[j], d + 1);
      })(sc, 0);
      return found;
    } catch (e) {
      return false;
    }
  }

  function hazardNow() {
    return stallStateActive() && handHasHoly();
  }

  /**
   * 這一次 emit 該不該攔。
   *
   * ⚠ **三個條件缺一不可**，而且 nodeAlive() 是後來補的那個：
   * 沒有它的話，companion 一結束，頁面就變成一把沒有鑰匙的鎖 ——
   * 照攔不誤，但沒有人能下 cancel／release，玩家每個移動階段被壓滿 25 秒
   * （2026-08-03 實測）。不攔只是功能沒生效，攔了沒人管是實質傷害。
   */
  /**
   * ⚠ **看的是 holdThisPhase，不是 hold && nodeAlive()。**
   *
   * holdThisPhase 在**進入移動階段的那一刻**定案，整個階段不再改變。
   * 這是刻意的：玩家按下 OK 之後，這次按壓會不會被壓著、能不能反悔，
   * 從階段一開始就決定好了，不會因為中途 Node 死掉而在他手上改變。
   *
   * 舊版直接看 nodeAlive()，於是心跳一過期就當場停止攔截並把壓著的送出 ——
   * 玩家以為還在反悔窗口裡，實際上已經定案了。見 OkDegraded 的說明。
   *
   * armed（攔截有沒有掛在 socket 上）仍然是即時的：那是「有沒有能力攔」，
   * 不是「要不要攔」，沒有 socket 的時候根本沒有東西可以壓。
   */
  /**
   * ⚠ inPvpMatch() 是**即時**的，跟 holdThisPhase 那套「階段邊界才改」不同。
   *
   * 那條規則存在的理由是「玩家按下去之後，遊戲規則不可以在他手上變」。模式
   * 不是那種東西 —— 它在一場戰鬥裡不會變，跨場才變，而跨場本來就是邊界。
   */
  function shouldIntercept() {
    return state.holdThisPhase && state.armed && inInterceptPhase() && inPvpMatch();
  }

  var state = {
    cfg: CFG,
    held: null,          // { self, args, at, timer }
    /**
     * 準備功能開著沒。關掉就完全不攔，退回遊戲原本行為。
     *
     * ⚠ patch 本身**不會**跟著拆掉 —— 「準備時間縮減」不需要攔截也要用到
     * 讀秒、階段判斷與 hazard。兩個功能是獨立的開關（玩家可能只要其中一個）。
     */
    hold: CFG.hold !== false,
    /**
     * **這個階段**到底攔不攔。進入移動階段的那一刻由 hold && nodeAlive()
     * 定案，整個階段不再改變 —— 見 shouldIntercept() 的說明。
     */
    holdThisPhase: false,
    /**
     * 這個階段中途 Node 死掉了，正在用單邊模式撐完。
     *
     * 進入下一個階段時會連同 holdThisPhase 一起重算，所以它自然歸零。
     */
    degraded: false,
    /** 目前有沒有處在「插件正在管這個階段」的外觀。由 phaseTick 維護。 */
    tinted: false,
    phaseTick: null,
    /** Node 最後一次 tick() 的時間。0 = 從來沒有過，也就是還沒有人在管。 */
    lastBeat: 0,
    /** 攔截有沒有掛在 socket 上。 */
    armed: false,
    /** 第幾個移動階段。每進入一次 +1 —— Node 用它判斷「換階段了」。 */
    phaseId: 0,
    /** 上一次 phaseTick 看到的階段狀態。用來抓「剛進入」那一刻。 */
    wasInPhase: false,
    /** 上一次真的送出 I_am_ok 是在第幾個階段。用來擋掉重複的強制送出。 */
    sentPhase: -1,
    /**
     * 這一次 emit 直接放行。
     *
     * ⚠ **只在 forceEnd() 替玩家按 OK 的那一瞬間為真。** 我們按下去之後遊戲
     * 自己會 emit I_am_ok，而那則會撞到我們自己的攔截 —— 沒有這個旗標的話，
     * 「強制送出」會變成「強制壓住」，剛好反過來。
     */
    passthrough: false,
    /**
     * 目前的狀態效果剩餘回合數：{ A: { mahi: 2 }, B: {} }。
     * 由 state 事件加、由 endTurn 減。
     */
    states: { A: {}, B: {} },
    /** "座位:鍵" → 施加的時刻。只給 decayStates 判斷同一瞬間用。 */
    statesAt: {},
    /** 上一次看到手上有幾張聖水／聖杯。null = 還沒看過。見 noticeHolyUsed。 */
    holyCount: null,
    /**
     * 畫面上的倒數要當成「只有這麼多秒」來畫。null = 照遊戲原本的。
     *
     * ⚠ 這**只影響顯示**。真正的剩餘秒數仍然是 this.timelimit，
     * 硬底線與強制送出都讀它。
     */
    displayCap: null,
    displayProto: null,
    originalUpdate: null,
    /** 目前接管了 sys.sceneUpdate 的那顆場景實例，以及它原本的抄本。 */
    displayScene: null,
    originalSceneUpdate: null,
    /** 目前掛著的那顆 socket 實例。**換房會換一顆** —— 見 SOCKET_LIFETIME_NOTE。 */
    socket: null,
    proto: null,
    originalEmit: null,
    /**
     * Node 的心跳 + 讀秒，一次往返做完。
     *
     * 合成一支是刻意的：心跳必須**每個 tick 都發**（否則玩家還沒按 OK 的期間
     * 就會被判定成 Node 死了而停止攔截），但讀秒只有壓著東西的時候有意義。
     * 分成兩支就會變成每秒八次 CDP 往返。
     */
    tick: function () {
      state.lastBeat = Date.now();
      return {
        remaining: state.remaining(),
        // ⚠ 要**連這一場還活著**才算 armed —— state.armed 只講「掛在 socket 上」，
        // 而那顆 socket 在結算畫面上還在（只是已經關了）。差別是托盤會不會在
        // 打完之後繼續寫「對戰中」。見 battleLive()。
        armed: state.armed && battleLive(),
        seat: state.seat(),
        inPhase: inInterceptPhase(),
        pvp: inPvpMatch(),
        rule: battleRule(),
        phaseId: state.phaseId,
        hazard: hazardNow(),
        hold: state.hold,
        sent: state.sentPhase === state.phaseId,
        room: state.room()
      };
    },
    /**
     * 告訴頁面「這個階段其實只有 n 秒」，讓中間那個數字與讀秒條跟著改。
     *
     * 傳 null（或 >= 30）就還原成遊戲原本的畫法。Node 每個 tick 都會叫，
     * 所以值一樣時要便宜地早退 —— 不然每秒四次 CDP 往返都在做白工。
     */
    setDisplayCap: function (n) {
      var next = (typeof n === "number" && n > 0 && n < GAME_PHASE_SECONDS) ? n : null;
      if (state.displayCap === next) return next;
      state.displayCap = next;
      return next;
    },
    /**
     * 開關準備功能。托盤切一下就會走到這裡，不必重裝 patch。
     *
     * **立刻生效**，包括同步 holdThisPhase。這跟「Node 死掉要等下一階段」
     * 不衝突，兩者的差別是**誰下的令**：
     *
     * | 來源                 | 何時生效 | 為什麼                                   |
     * | -------------------- | -------- | ---------------------------------------- |
     * | 這個函式（Node 活著）| 立刻     | 是有人明確下的令，而且 UI 同步反映得出來 |
     * | 心跳過期（沒人下令） | 下一階段 | 玩家不知情，當場改變會讓他以為還能反悔   |
     *
     * ⚠ 不要為了「一致」把這條也改成延後。玩家在托盤把準備關掉卻要等下一個
     * 階段才有反應，那是「按了沒反應」，跟這次要修的問題一樣糟，只是反過來。
     */
    setHold: function (on) {
      state.hold = on !== false;
      state.holdThisPhase = state.hold && nodeAlive();
      // ⚠ 關掉的當下如果正壓著東西，一定要立刻放掉 —— 否則那次 OK 會卡到
      // 失效保護才送出，而玩家剛剛做的動作正是「把這個功能關掉」。
      if (!state.hold && state.held) state.release("arbiter");
      return state.hold;
    },
    /**
     * 換準備中的染色。null = 不染色（官方原本的樣子）。
     *
     * 執行期就能換，不必重裝 —— 重裝會先把壓著的送出去，為了改一個顏色
     * 讓玩家的 OK 定案完全不值得。
     */
    setReadyTint: function (v) {
      var next = (typeof v === "number" && isFinite(v) && v >= 0 && v <= 0xffffff)
        ? Math.floor(v) : null;
      state.cfg.readyTint = next;
      var sc = mainScene();
      if (sc && sc.ok) {
        // 正在染色中就立刻換過去；換成 null 或沒在染色都是清掉。
        if (state.tinted && next !== null) sc.ok.setTint(next);
        else sc.ok.clearTint();
      }
      return next;
    },
    /**
     * 不管玩家按了沒，讓這個階段的 I_am_ok 送出去（WP-15 的約定秒數）。
     *
     * 兩條路，**都不需要知道 I_am_ok 的協定長什麼樣**（不變量 3）：
     *
     *   壓著玩家按的那次  → 原封不動重放
     *   玩家根本沒按      → **替他按一次 OK 鈕**，讓遊戲自己去組那個封包
     *
     * ⚠ 第二條為什麼不是「自己 emit 一個 I_am_ok」：那要寫死參數
     * （實測是 (this.room, this.id)），遊戲改版就會送出錯誤封包。
     * 而 OK 鈕的 pointerdown handler 本來就是
     * () => { this.ok.setTexture("ok",2).disableInteractive(),
     *          this.socket.emit(<OK 事件名>, this.room, this.id) }
     * —— 觸發它連送出後的按鈕外觀都一起對了（2026-08-06 實測）。
     */
    forceEnd: function (why) {
      if (state.sentPhase === state.phaseId) return "already-sent";
      // ⚠ **對 NPC 絕對不要替玩家按 OK。** 這條是玩家 2026-08-09 回報的
      // 「打渦、打任務時秒數照樣生效」裡最有感的那一半 —— 他在打王，
      // 而插件替他結束了移動階段。Node 那邊也有一道，但這道是最後的保證。
      if (!inPvpMatch()) return "not-pvp";
      if (!inInterceptPhase()) return "not-in-phase";
      if (state.held) return state.release(why || "arbiter");

      var sc = mainScene();
      if (!sc || !sc.ok) return "no-button";
      // 遊戲的 handler 會 disableInteractive()，之後 pinFrame 就沒有意義了。
      state.pinFrame(null);
      state.sentPhase = state.phaseId;
      state.passthrough = true;
      try {
        sc.ok.emit("pointerdown");
        report({ type: "ok-released", by: "forced", heldMs: 0 });
      } catch (e) {
        report({ type: "ok-patch-error", reason: "替玩家按 OK 失敗：" + String((e && e.message) || e) });
      } finally {
        state.passthrough = false;
      }
      return "pressed";
    },
    /** 把攔到的呼叫真的送出去。 */
    release: function (by) {
      var h = state.held;
      if (!h) return "nothing-held";
      state.held = null;
      state.sentPhase = state.phaseId;
      try { clearTimeout(h.timer); } catch (e) {}
      // ⚠ 一定要在這裡收拾外觀，不能指望 Node 下指令。
      // 失效保護與心跳過期那兩條路完全沒有 Node 參與；而硬底線那條路 step()
      // 只回 send-ok、不回 set-ok-frame，所以 commandsFor 裡那個
      // interactive:false 永遠輪不到。
      //
      // ⚠ **只拆 pin 是不夠的**（2026-08-03 實測）。拆掉 pin 之後遊戲自己的
      // hover handler 就回來了，而按鈕還停在 frame 2 且仍然 setInteractive()
      // —— 滑鼠一移開就被 pointerout 改回 frame 0，看起來像「準備被取消」，
      // 其實 I_am_ok 早就送出去了。而且它還能按：再按一次 state.held 已經是
      // null，於是**攔到第二個 I_am_ok** 再壓一輪。
      //
      // 送出後的正確外觀是 frame 2 且**不可按** —— 那正好是遊戲原本按完 OK
      // 的樣子（frame 2 + disableInteractive），所以下個階段遊戲會自己還原。
      //
      // ⚠ 但階段已經結束就不要碰。那時 OK 鈕已經屬於下一個階段、遊戲可能
      // 早就設回可按了，stomp 過去會把玩家的 OK 鈕鎖死在攻擊／防禦階段。
      if (inInterceptPhase()) state.setOkFrame("2", false);
      else state.pinFrame(null);
      try {
        // 原封不動重放 —— 不解析、不重建參數。
        state.originalEmit.apply(h.self, h.args);
        report({ type: "ok-released", by: by, heldMs: Date.now() - h.at });
      } catch (e) {
        report({ type: "ok-patch-error", reason: "重放失敗：" + String((e && e.message) || e) });
      }
      return "released";
    },
    /** 取消準備：丟掉攔到的呼叫，把 OK 鈕變回可按。 */
    cancel: function () {
      var h = state.held;
      if (!h) return "nothing-held";
      state.held = null;
      try { clearTimeout(h.timer); } catch (e) {}
      state.setOkFrame("0");
      return "cancelled";
    },
    /**
     * 設定 OK 鈕外觀。
     *
     * ⚠ interactive 跟 frame 是**分開**的。遊戲原本按下 OK 之後會
     * setTexture("ok", 2).disableInteractive() —— 外觀灰掉、而且不能再按。
     * 但「準備」需要**看起來已鎖定、卻還能再按一次取消**（V1 規則 1：
     * 外觀仍然相同，再按一次可以取消）。所以 frame 2 也要保持可按。
     *
     * （注入腳本是 TS 的樣板字串，註解裡不能用反引號。）
     */
    setOkFrame: function (frame, interactive) {
      try {
        var sc = mainScene();
        if (!sc || !sc.ok) return false;
        sc.ok.setTexture(CFG.okTexture, Number(frame));
        if (interactive === false) sc.ok.disableInteractive();
        else sc.ok.setInteractive();

        // ⚠ **遊戲自己的 hover handler 會把我們設的 frame 蓋掉。**
        //
        //     .on("pointerover", () => this.ok.setTexture("ok", 1))
        //     .on("pointerout",  () => this.ok.setTexture("ok", 0))
        //
        // 為了「再按一次取消」我們必須保持 setInteractive()，於是滑鼠一移開
        // 就被改回 frame 0。壓著的時候要把 hover 收起來（見 pinFrame）。
        state.pinFrame(frame === "2" && interactive !== false ? 2 : null);

        // ⚠ 染色**不在這裡管**，由 phaseTick 依階段維護。
        //
        // 語意是「顏色 = 這個階段插件有沒有介入」，不是「狀態」：
        //
        //     移動階段      OK 與鎖頭都是琥珀色（整個階段一致）
        //     攻擊／防禦    完全是遊戲原本的樣子，插件不碰
        //
        // 早期版本把染色綁在「準備中」上，結果取消之後變回白色 OK ——
        // 同一個階段裡按下去是琥珀、取消回來變白色，顏色語意自己打架。
        return true;
      } catch (e) { return false; }
    },
    /**
     * 把 OK 鈕的 frame 釘住，不讓遊戲的 hover handler 改掉。傳 null 解除。
     *
     * 做法是**把遊戲的 hover handler 暫時收起來**，不是再掛一組去搶。
     *
     * ⚠ 先前的版本是「後註冊一組 handler 把 frame 設回去」（Phaser 依註冊
     * 順序呼叫，後掛的最後生效）。那個做法可以動，但有兩個問題：
     *
     *   1. 只在 hover 事件發生時才修正，中間那一瞬間會閃。
     *   2. **萬一沒拆乾淨，滑鼠滑過去就會顯示成準備狀態** —— 玩家根本沒按。
     *      2026-08-02 實測就是這樣壞的：release 沒有解除 pin，之後每次
     *      hover 都變成假的準備 UI。
     *
     * 收起來的版本，漏拆的後果只是「hover 沒反應」，不會假裝成別的狀態。
     */
    pinned: null,
    pinFrame: function (frame) {
      try {
        var sc = mainScene();
        if (!sc || !sc.ok) return;
        var ok = sc.ok;

        if (state.pinned !== null) {
          var p = state.pinned;
          state.pinned = null;
          for (var i = 0; i < p.over.length; i++) ok.on("pointerover", p.over[i]);
          for (var j = 0; j < p.out.length; j++) ok.on("pointerout", p.out[j]);
        }
        if (frame === null) return;

        state.pinned = {
          over: ok.listeners("pointerover").slice(),
          out: ok.listeners("pointerout").slice()
        };
        ok.off("pointerover");
        ok.off("pointerout");
      } catch (e) {}
    },
    seat: function () {
      var sc = mainScene();
      return (sc && typeof sc.PLAYER === "string") ? sc.PLAYER : null;
    },
    /**
     * 這一場的 room id。⚠ 高熵字串，出了這個函式就只能雜湊過再用（§12）。
     *
     * ⚠ **戰鬥結束就回 null。** sc.room 會一直留在場景上（Phaser 不丟場景
     * 物件），照著它報下去的話側通道會停在上一場的房裡繼續握手 ——
     * 見 battleLive()。Node 那邊在 pvp=false 時本來就會清房，這裡是同一件事
     * 的第二道：兩個欄位講的話要一致，不然「為什麼沒生效」會查不出來。
     */
    room: function () {
      if (!battleLive()) return null;
      var sc = mainScene();
      return (sc && typeof sc.room === "string" && sc.room.length > 0) ? sc.room : null;
    },
    /**
     * 剩餘秒數。
     *
     * ⚠ **移動階段一律讀 timelimit 這個欄位，不要讀畫面上的字。**
     * 約定秒數生效時那個字是我們自己覆寫的（見 patchDisplay），拿它回推
     * 剩餘量會變成自己騙自己 —— 而且錯的方向是「以為時間比實際少」，
     * 硬底線會提早觸發。
     *
     * 其他階段（攻擊／防禦）沒有這個欄位可讀，仍然走原本的 BitmapText 掃描。
     * 那條路 2026-08-02 實測定位過：(380,318)、每秒 1 格、10 秒以下有小數。
     */
    remaining: function () {
      try {
        var mp = movePhase();
        if (mp && typeof mp.timelimit === "number") return mp.timelimit;
      } catch (e) {}
      try {
        var found = null;
        function walk(o, d) {
          if (!o || d > 6 || found !== null) return;
          if (o.type === "BitmapText" && Math.round(o.x) === 380 && Math.round(o.y) === 318 && o.visible) {
            var v = parseFloat(String(o.text));
            if (!isNaN(v)) { found = v; return; }
          }
          var kids = (o.list && o.list.length) ? o.list
                   : (o.children && o.children.list) ? o.children.list : null;
          if (!kids) return;
          for (var i = 0; i < kids.length && i < 200; i++) walk(kids[i], d + 1);
        }
        var scenes = window.game.scene.keys;
        for (var k in scenes) {
          var sc = scenes[k];
          if (!sc || !sc.sys || !sc.sys.settings || !sc.sys.settings.active) continue;
          walk(sc, 0);
          if (found !== null) break;
        }
        return found;
      } catch (e) { return null; }
    },
    /**
     * 把自己拆乾淨。**Node 結束前一定要呼叫。**
     *
     * 不拆的後果不是「功能停用」，是留下一個沒有鑰匙的鎖：原型上的 patch
     * 還在攔 I_am_ok，但沒有人能下 cancel／release。心跳讓這件事不再是災難
     * （3 秒後就停止攔截），但留著孤兒仍然沒有任何好處。
     */
    uninstall: function (why) {
      try { if (state.held) state.release(why || "uninstall"); } catch (e) {}
      try { clearInterval(state.phaseTick); } catch (e) {}
      state.phaseTick = null;
      try { state.pinFrame(null); } catch (e) {}
      // ⚠ 讀秒顯示一定要還原。留著的話玩家會看到一個沒人在維護的假倒數 ——
      // 而且它會停在錯的地方，比什麼都不做更糟。
      state.displayCap = null;
      try { unpatchDisplay(); } catch (e) {}
      try {
        var sc = mainScene();
        if (sc && sc.ok) sc.ok.clearTint();
      } catch (e) {}
      state.tinted = false;
      // ⚠ onAny 掛在**實例**上。不拆的話舊的那份會留在 socket 上繼續回報，
      // 重灌幾次就有幾份，同一則事件送回 Node 好幾次。
      try {
        if (state.socket && state.socket[CFG.unlistenAllMethod]) {
          state.socket[CFG.unlistenAllMethod](onAnyHandler);
        }
      } catch (e) {}
      state.socket = null;
      try {
        if (state.proto && state.originalEmit) state.proto[CFG.sendMethod] = state.originalEmit;
      } catch (e) {}
      state.armed = false;
      if (window[G] === state) window[G] = null;
      return "uninstalled";
    }
  };

  function patchedEmit(name) {
    // ⚠ **這是我們自己按下去的那一次，一定要放行。**
    // forceEnd() 替玩家按 OK 鈕之後，遊戲自己會 emit I_am_ok —— 沒有這個
    // 旗標的話它會撞到下面的攔截，「強制送出」變成「強制壓住」，剛好相反。
    if (state.passthrough) return state.originalEmit.apply(this, arguments);

    if (String(name) === CFG.okEvent && shouldIntercept()) {
      // 已經壓著一個 → 這是「再按一次」。**不要送出**，也不要疊第二個 ——
      // 交給仲裁決定（它會判成取消準備，然後叫我們 cancel()）。
      // 若在這裡直接送出，玩家就永遠取消不了，等於功能不存在。
      if (state.held) {
        report({ type: "ok-pressed-again", at: Date.now() });
        return undefined;
      }

      var h = { self: this, args: arguments, at: Date.now(), timer: null };
      // ⚠ 失效保護：最後一道防線。正常情況下 Node 的硬底線或心跳過期會更早。
      h.timer = setTimeout(function () { state.release("failsafe"); }, CFG.failsafeMs);
      state.held = h;

      // 遊戲的 pointerdown handler 剛剛把鈕 disableInteractive() 了。
      // 保持灰色外觀，但要能再按 —— 否則取消不了。
      state.setOkFrame("2", true);

      report({ type: "ok-intercepted", at: h.at });
      return undefined;
    }
    return state.originalEmit.apply(this, arguments);
  }

  /**
   * 狀態效果的剩餘回合數。
   *
   *     state("mahi_2", "A", "B")   ← <鍵>_<回合數>、誰中了、誰施加的
   *
   * ⚠ 伺服器**只在施加時通知一次**，之後不會再告訴你還剩幾回合。所以要自己
   * 數：每收到一次 endTurn 就全部減一。這也表示中途接上插件的那一場算不出來
   * （沒看到施加的那一刻）—— 那只會讓 hazard 判成 false，也就是**不縮短**，
   * 方向是安全的。
   */
  function trackState(args) {
    try {
      // ⚠ args[0] 是**事件名**（"state"），參數從 1 開始 —— onAny 的簽章是
      // (name, ...args)。從 0 讀的話 key 會是 "stat"，永遠對不上任何狀態，
      // 而症狀是「hazard 永遠不成立」，也就是這條規則安靜地不存在。
      var raw = String(args[1] || "");
      var cut = raw.lastIndexOf("_");
      if (cut <= 0) return;
      var key = raw.slice(0, cut);
      var turns = parseInt(raw.slice(cut + 1), 10);
      if (!isFinite(turns) || turns <= 0) return;
      if (CFG.stallStates.indexOf(key) === -1) return;
      var seat = (args[2] === "A" || args[2] === "B") ? args[2] : null;
      if (seat === null) return;
      state.states[seat][key] = turns;
      // ⚠ 記下施加的時刻，給 decayStates 判斷「這是同一瞬間的 endTurn」。
      state.statesAt[seat + ":" + key] = Date.now();
    } catch (e) {}
  }

  /**
   * 剛施加的狀態，多久內收到的 endTurn 不算它頭上。
   *
   * ⚠ 2026-08-09 錄事件流時發現的：state 與 endTurn 是**同一個時間戳**到的
   *
   *     t=385.5  state  mahi_2
   *     t=385.5  endTurn
   *
   * 於是 mahi_2 一到就被扣成 1 —— 每一個狀態都少算一回合，而症狀是
   * 「hazard 提早一回合消失」。方向雖然安全（不縮短），但它是錯的，
   * 而且會讓「自壞剩一回」這條規則整個錯開一回合。
   */
  var APPLIED_GRACE_MS = 300;

  function decayStates() {
    var now = Date.now();
    for (var seat in state.states) {
      if (!has.call(state.states, seat)) continue;
      var byKey = state.states[seat];
      for (var key in byKey) {
        if (!has.call(byKey, key)) continue;
        // 同一瞬間才剛施加的，這一次的 endTurn 不算它頭上。
        var at = state.statesAt[seat + ":" + key];
        if (at !== undefined && now - at < APPLIED_GRACE_MS) continue;
        byKey[key] -= 1;
        if (byKey[key] <= 0) {
          delete byKey[key];
          delete state.statesAt[seat + ":" + key];
        }
      }
    }
  }

  /** 操作事件：轉成去識別化的形式送回 Node。 */
  function onAnyHandler(name) {
    try {
      var n = String(name);
      // 狀態效果只留在頁面裡（hazard 用），**不回報給 Node**。
      if (n === "state") { trackState(arguments); return; }
      if (n === "endTurn") { decayStates(); return; }

      var isClick = n.indexOf("cardclicked") === 0;
      var isRotate = n.indexOf("cardrotate") === 0;
      if (!isClick && !isRotate && n !== "move_select") return;
      var seat = seatOf(n);
      var payload = { type: "ok-patch-event", event: n, at: Date.now() };
      if (seat !== null && typeof arguments[1] === "number") {
        payload.cardRef = opaqueId(seat, arguments[1]);
      }
      if (isClick && typeof arguments[2] === "boolean") payload.clicked = arguments[2];
      report(payload);
    } catch (e) {}
  }

  var everArmed = false;

  /**
   * 把攔截掛到**目前這顆** socket 上。可以重複呼叫 —— phaseTick 每 200ms 叫。
   *
   * ⚠ 兩種掛法的壽命完全不同（見 constants.ts 的 SOCKET_LIFETIME_NOTE）：
   *
   *     WSClient.prototype.emit   六條連線共用一份，patch 一次跨場活著
   *     socket.onAny(...)         掛在實例上，**每次重新開房就沒了**
   *
   * 只 patch 原型的話，換房之後會變成：攔截照常（壓住你的 OK），但出牌、
   * 轉牌不再回報 → **取消準備永遠不會觸發**。也就是又一個單向的鎖。
   */
  function arm() {
    try {
      var sc = mainScene();
      var socket = sc && sc.socket;
      if (!socket) { state.armed = false; return false; }

      var proto = Object.getPrototypeOf(socket);
      if (!proto || typeof proto[CFG.sendMethod] !== "function") {
        state.armed = false;
        return false;
      }

      // ⚠ 只有在它還不是我們這一版時才包。少了這個判斷，重複呼叫會讓
      // originalEmit 變成 patchedEmit 自己 —— 下一次 release 就無限遞迴。
      if (proto[CFG.sendMethod] !== patchedEmit) {
        state.proto = proto;
        state.originalEmit = proto[CFG.sendMethod];
        proto[CFG.sendMethod] = patchedEmit;
      }

      if (state.socket !== socket) {
        try {
          if (state.socket && state.socket[CFG.unlistenAllMethod]) {
            state.socket[CFG.unlistenAllMethod](onAnyHandler);
          }
        } catch (e) {}
        state.socket = socket;
        socket[CFG.listenAllMethod](onAnyHandler);
        // 新的一場 → 流水號重編。舊場的對應留著會讓兩場的牌撞號。
        refs = { A: {}, B: {} };
        refNext = { A: 1, B: 1 };
        // 狀態效果也是上一場的。留著會讓新的一場一開始就以為有人被麻痺。
        state.states = { A: {}, B: {} };
        state.statesAt = {};
        state.holyCount = null;
        state.armed = true;
        if (everArmed) report({ type: "ok-patch-rearmed", seat: state.seat() });
        everArmed = true;
        return true;
      }

      state.armed = true;
      return true;
    } catch (e) {
      state.armed = false;
      return false;
    }
  }

  /**
   * 一直在跑的監看，管六件事。**它是這個 patch 唯一的自我修復機制**，
   * 所以裝的時候沒有 socket 也照樣要跑起來。
   *
   * 1. **socket 換了就重掛。** 重新開房、進任務都會換一顆。
   * 2. **Node 沒心跳就放掉壓著的。** 3 秒，而不是失效保護的 25 秒。
   * 3. **階段一結束就把壓著的送出去。** 那個 I_am_ok 屬於已經結束的階段。
   * 4. **染色 = 這個階段插件真的有在管。** 移動階段整段琥珀色（不管有沒有
   *    按下去），其他階段完全還原 —— 而 Node 死掉時也要還原，否則畫面在
   *    宣稱一個已經不存在的保護。
   * 5. **數階段。** 每進入一次移動階段 phaseId +1，Node 靠它判斷「換階段了」。
   * 6. **讀秒顯示的 patch 要補掛。** 場景是進對戰才建立的，裝插件的當下
   *    多半還沒有 —— 跟 socket 完全一樣的問題，所以用同一個機制解。
   */
  state.phaseTick = setInterval(function () {
    try {
      arm();
      // 聖水從手上消失 → 當成狀態被解掉了（伺服器不會通知，見 noticeHolyUsed）
      noticeHolyUsed();

      var mp = movePhase();
      var inPhase = mp !== null;
      var alive = nodeAlive();

      // ⚠ 進入移動階段的**那一刻**才 +1。用「現在在不在」當條件會每 200ms 加一次。
      if (inPhase && !state.wasInPhase) {
        state.phaseId++;
        // ⚠⚠ **這是唯一會把 holdThisPhase 變成 false 的地方**（setHold 除外）。
        // 先歸零，由下面那行決定要不要開 —— 也就是「取消要等下一回」。
        state.holdThisPhase = false;
        state.degraded = false;
      }
      state.wasInPhase = inPhase;
      if (mp !== null) patchDisplay(mp);

      /**
       * ⚠ **開啟隨時生效，關閉只在階段邊界。** 這個不對稱是刻意的：
       *
       *   關閉 → 玩家以為還能反悔，那次按壓卻定案了。**有傷害**，所以要等邊界。
       *   開啟 → 他只是多拿到一個反悔窗口。**沒有傷害**，所以可以立刻。
       *
       * 少了這一行，「對戰中途才接上插件」會整個階段都沒有準備功能 ——
       * 因為第一輪 phaseTick 跑在 Node 的第一次 tick() 之前，那時 alive 還是
       * false，而不離開階段就永遠沒有下一個邊界可以翻正。
       */
      if (state.hold && alive) state.holdThisPhase = true;

      // 這個階段本來在攔，中途 Node 卻死了 → 降級成單邊，不要當場取消。
      if (inPhase && state.holdThisPhase && !alive && !state.degraded) {
        state.degraded = true;
        report({ type: "ok-degraded", phaseId: state.phaseId, holding: !!state.held });
      } else if (state.degraded && alive) {
        // 心跳在同一個階段內回來了 —— 回到正常模式，硬底線交還給 Node。
        state.degraded = false;
      }

      if (state.held && !inPhase) {
        state.release("phase-ended");
      } else if (state.held && state.degraded) {
        /**
         * ⚠ **降級模式下沒有人會來救，硬底線得自己顧。**
         *
         * failsafeMs 不夠用：它是從「按下去」算起的 25 秒，而玩家可能在
         * 階段剩 8 秒時才按 —— 那樣失效保護會落在階段結束之後，也就是
         * **逾時棄權**。所以這裡改看階段還剩幾秒。
         */
        var left = state.remaining();
        // 讀不到剩餘秒數就沒有安全網可言 —— 這種時候寧可早一點送出去。
        if (left === null || left <= CFG.localDeadlineSeconds) state.release("local-deadline");
      }

      var sc = mainScene();
      if (!sc || !sc.ok) return;
      // ⚠ 用 holdThisPhase 而不是 alive：降級中準備功能**仍然在運作**
      // （單邊的反悔窗口還在），外觀就不該說它已經沒了。
      //
      // ⚠ 而 inPvpMatch() 一定要跟 shouldIntercept() 用同一個判準：染色的語意是
      // 「這個階段插件真的有在管」。打渦時染了色卻不會攔，那個顏色就是在說謊，
      // 而玩家會照著它去按 OK。
      var engaged = inPhase && state.armed && state.holdThisPhase && inPvpMatch();
      if (engaged && !state.tinted) {
        if (CFG.readyTint !== null) sc.ok.setTint(CFG.readyTint);
        state.tinted = true;
      } else if (!engaged && state.tinted) {
        // 不再介入 → 完全還原，包括可能還掛著的 hover 收納。
        state.pinFrame(null);
        // ⚠ 無條件 clearTint：玩家可能在染色期間把顏色改成「不染色」，
        // 只在 readyTint !== null 時清的話那次的染色會永遠留在按鈕上。
        sc.ok.clearTint();
        state.tinted = false;
      }
    } catch (e) {}
  }, CFG.phaseCheckMs);

  var armed = arm();
  window[G] = state;
  report({ type: "ok-patch-installed", seat: state.seat(), armed: armed });
  // ⚠ 沒有 socket 也是成功 —— 回 waiting 而不是失敗。玩家可能還沒開遊戲、
  // 或還在大廳，phaseTick 會自己把它補掛上去。早期版本在這裡直接放棄，
  // 於是「先開 companion 再開遊戲」這個最自然的順序反而不能用。
  return armed ? "ok" : "waiting";
})();`;
}
