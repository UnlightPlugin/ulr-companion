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

import { OK_BUTTON, WS_CLIENT } from "./constants.js";
import { embedJson } from "./embed.js";

export interface OkPatchOptions {
  /** 頁面呼叫這個名字把事件送回 Node。由 `Runtime.addBinding` 建立。 */
  bindingName: string;
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
   * 死了之後頁面**停止攔截**（退回遊戲原本行為），而且會立刻放掉正壓著的
   * 呼叫。要比 `ArbiterRunner` 的 tick 間隔寬鬆得多 —— 偶爾一次 CDP 往返
   * 變慢不該讓功能忽開忽關。
   */
  staleMs?: number;
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
   * - `node-gone` —— Node 心跳過期，不再等它（頁面自己判斷）
   * - `failsafe` —— 壓滿上限，**代表連心跳都沒發揮作用**，看到就要查
   * - `reinstall` / `uninstall` —— 換版或拆掉前先送出去，避免半路丟掉害玩家棄權
   */
  by: "arbiter" | "phase-ended" | "node-gone" | "failsafe" | "reinstall" | "uninstall";
  /** 從攔截到送出經過多久。 */
  heldMs: number;
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
  | OkPatchEvent
  | OkPatchInstalled
  | OkPatchRearmed
  | OkPatchError;

const REPORT_TYPES = new Set([
  "ok-intercepted",
  "ok-pressed-again",
  "ok-released",
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

/** `state.tick()` 的回傳。一次往返同時做心跳與讀秒。 */
export interface OkPatchTick {
  /** 畫面上的剩餘秒數。讀不到（不在有倒數的階段）就是 null。 */
  remaining: number | null;
  /** 攔截有沒有掛在 socket 上。 */
  armed: boolean;
  /** 目前這場的座位。**每場重新分配，不能快取。** */
  seat: string | null;
}

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
    global: OK_PATCH_GLOBAL,
    okEvent: "I_am_ok",
    sendMethod: WS_CLIENT.sendMethod,
    listenAllMethod: WS_CLIENT.listenAllMethod,
    unlistenAllMethod: WS_CLIENT.unlistenAllMethod,
    okScene: OK_BUTTON.scene,
    okTexture: OK_BUTTON.textureKey,
    /** 準備中的染色。琥珀色 —— 跟遊戲原本的灰色鎖定分得開。 */
    readyTint: 0xffc247,
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
    try {
      var scenes = window.game.scene.keys;
      for (var i = 0; i < CFG.interceptScenes.length; i++) {
        var sc = scenes[CFG.interceptScenes[i]];
        if (sc && sc.sys && sc.sys.settings && sc.sys.settings.active) return true;
      }
      return false;
    } catch (e) {
      // 判斷不出來就**不要攔** —— 放行是安全的，攔錯階段會拖慢玩家。
      return false;
    }
  }

  /** Node 還在不在。沒心跳就當它死了。 */
  function nodeAlive() {
    return (Date.now() - state.lastBeat) <= CFG.staleMs;
  }

  /**
   * 這一次 emit 該不該攔。
   *
   * ⚠ **三個條件缺一不可**，而且 nodeAlive() 是後來補的那個：
   * 沒有它的話，companion 一結束，頁面就變成一把沒有鑰匙的鎖 ——
   * 照攔不誤，但沒有人能下 cancel／release，玩家每個移動階段被壓滿 25 秒
   * （2026-08-03 實測）。不攔只是功能沒生效，攔了沒人管是實質傷害。
   */
  function shouldIntercept() {
    return state.armed && nodeAlive() && inInterceptPhase();
  }

  var state = {
    cfg: CFG,
    held: null,          // { self, args, at, timer }
    /** 目前有沒有上琥珀色。由 phaseTick 維護，代表「這個階段插件有介入」。 */
    tinted: false,
    phaseTick: null,
    /** Node 最後一次 tick() 的時間。0 = 從來沒有過，也就是還沒有人在管。 */
    lastBeat: 0,
    /** 攔截有沒有掛在 socket 上。 */
    armed: false,
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
      return { remaining: state.remaining(), armed: state.armed, seat: state.seat() };
    },
    /** 把攔到的呼叫真的送出去。 */
    release: function (by) {
      var h = state.held;
      if (!h) return "nothing-held";
      state.held = null;
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
    /** 剩餘秒數：當前 active 階段場景裡 (380,318) 的 BitmapText。 */
    remaining: function () {
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

  /** 操作事件：轉成去識別化的形式送回 Node。 */
  function onAnyHandler(name) {
    try {
      var n = String(name);
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
   * 一直在跑的監看，管四件事。**它是這個 patch 唯一的自我修復機制**，
   * 所以裝的時候沒有 socket 也照樣要跑起來。
   *
   * 1. **socket 換了就重掛。** 重新開房、進任務都會換一顆。
   * 2. **Node 沒心跳就放掉壓著的。** 3 秒，而不是失效保護的 25 秒。
   * 3. **階段一結束就把壓著的送出去。** 那個 I_am_ok 屬於已經結束的階段。
   * 4. **染色 = 這個階段插件真的有在管。** 移動階段整段琥珀色（不管有沒有
   *    按下去），其他階段完全還原 —— 而 Node 死掉時也要還原，否則畫面在
   *    宣稱一個已經不存在的保護。
   */
  state.phaseTick = setInterval(function () {
    try {
      arm();

      var inPhase = inInterceptPhase();
      var alive = nodeAlive();

      if (state.held && !alive) state.release("node-gone");
      else if (state.held && !inPhase) state.release("phase-ended");

      var sc = mainScene();
      if (!sc || !sc.ok) return;
      var engaged = inPhase && state.armed && alive;
      if (engaged && !state.tinted) {
        sc.ok.setTint(CFG.readyTint);
        state.tinted = true;
      } else if (!engaged && state.tinted) {
        // 不再介入 → 完全還原，包括可能還掛著的 hover 收納。
        state.pinFrame(null);
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
