/**
 * 演出加速（WP-14）—— 只加快「演出」，不碰時鐘、不碰連線。
 * =========================================================
 *
 * 2026-08-05 雙邊實測（一場完整 18 回合，7:06）先確定了兩件事，這支的形狀
 * 完全由那兩件事決定：
 *
 * **① 戰鬥長度主要是伺服器排程，客戶端加速救不到。**
 * `I_am_ok` 送出後到下次可操作的 7.86 秒裡，客戶端一則都沒送出去，全是收端；
 * 六條伺服器固定計時器（全距 ≤0.02s）就佔 63.8 秒。`diceRoll → chara_A`
 * 空檔 7.47s 裡動畫只演 1.03s，其餘是畫面不動的呆等。
 *
 * 所以這支**不會讓一場對戰快一半**。它賺的是另一塊 ——
 *
 * **② 決策窗開頭被殘留動畫擋住約 75 秒／場。**
 * `okVisibleX` 到了、動畫還在演、玩家點不下去。這段加速是真的有效：早幾秒
 * 能操作就早幾秒按 OK，而階段是雙方按 OK 才結束。預期收益約 1 分鐘／場。
 *
 * ⚠ **文案不要寫成「加速對戰」**，玩家會期待減半然後失望。寫「減少等動畫的
 * 時間」才對得上實測。
 *
 * ---
 *
 * ## `scene.time`：**MainA 那顆可以動，階段場景那顆絕對不行**
 *
 * 這兩顆是**不同的 Clock 物件**，這一點是整支的安全基礎（2026-08-06 實測確認
 * `MainA.time` 與 `MovePhaseA.time` 各自有獨立的 `_active` 與 `timeScale`）。
 *
 * ### ⛔ 階段場景的 Clock —— 碰了會害玩家棄權
 *
 * 倒數計時是階段場景（171.js）裡的循環 `TimerEvent`：
 *
 * ```js
 * timer_reset() {
 *   this.timelimit = 30;
 *   this.timer.reset({ delay: 100, repeat: 300, callback: () => { this.timelimit -= 0.1; … } });
 * }
 * ```
 *
 * `MovePhaseA.time.timeScale` 會把**畫面上的倒數一起加速**。兩個後果：
 *
 * 1. 玩家看到假的剩餘秒數（顯示 0 但伺服器還有 20 秒），會被逼著亂出牌
 * 2. WP-12 仲裁讀那個 TIME 算硬底線（battle-events.md「讀 TIME 顯示」那節），
 *    倒數跑快 N 倍 → 硬底線提早 N 倍觸發 → `I_am_ok` 被提早送出
 *
 * 第 2 點特別惡劣：兩個功能各自都對，合起來會讓玩家在移動階段被強制提早
 * 承諾 —— 正是 WP-12 存在的目的的反面。
 *
 * ### ✅ MainA 的 Clock —— 亮牌與出牌卡頓都掛在這裡
 *
 * 玩家回報「看對方的牌一張一張慢慢亮很煩躁」。那不是動畫，是純粹的排隊等待
 * （`./src/helper/battle/CardOpen.ts`）：
 *
 * ```js
 * async showcards(scene) {
 *   for (let i = 0; i < this.array.length; i++) {
 *     scene.card2[…][0].setVisible(false).destroy();
 *     this.card[i].forEach((el) => { el.setVisible(true); });     // ← 瞬間完成
 *     await new Promise((r) => scene.time.addEvent({ delay: 200, callback: r }));
 *   }                                                            // ← 慢的是這個
 * }
 * ```
 *
 * **每張牌 200ms，而且沒有任何 tween** —— 所以 `tweens.timeScale` 對它完全無效，
 * 玩家開了加速還是一樣慢。`CardOpen` 是在 MainA 的 `cardOpen_<對手>` handler 裡
 * `new CardOpen(this, e)` 建的，`scene` 就是 MainA，所以那些 TimerEvent 掛在
 * **`MainA.time`**。
 *
 * 同一顆 Clock 上還有 `player_card_clicked` 的 `await 110ms` —— 每出一張牌整手
 * 牌被鎖住的那段（2026-08-06 實測：RTT 44ms + 鎖 102ms，一場約 20 次）。
 * 一個開關同時解決兩件事。
 *
 * ### 為什麼「不同物件」比「小心一點」強
 *
 * 加速 MainA 的 Clock **在結構上碰不到倒數**，跟心跳那條論據同一個形狀。
 * 佐證：949.js（MainA）裡 15 處 `time.addEvent` 全是一次性的（delay 30~4400ms），
 * **一個 `repeat` / `loop` 都沒有** —— 也就是那顆 Clock 上沒有任何「跟時間有
 * 語意關係」的東西，不需要像循環 tween 那樣補償。
 *
 * ⚠ 名單是 `REVEAL_CLOCK_SCENES`，**用場景鍵做白名單，不是黑名單**。
 * 新增階段場景時黑名單會漏，白名單只會少加速、不會害人。
 *
 * ### ⚠ 加快亮牌**不會讓對戰變短**
 *
 * 亮牌發生在伺服器空檔裡，而且 `card_open_*` 會 `timer.paused = true`。
 * 伺服器的排程紋風不動（本檔 ① 的受控實驗）。它的價值是另外兩個：
 * 治煩躁，以及**把「預先出牌」的可用預算還回來** —— 防禦階段的預算只有
 * 1.94s（中位），攻方出 4 張牌光亮牌就吃掉 800ms。見 docs/battle-preplay.md。
 *
 * ## 為什麼這支不會像 CheatEngine 那樣斷線
 *
 * 心跳在 `WSClient` 裡，是純 `setInterval`：
 *
 * ```js
 * static DEFAULT_HEARTBEAT = 10;          // 秒
 * setInterval(() => {
 *   if (!alive) { socket.close(); return; }   // 上一輪的 __pong_c 沒回來
 *   alive = false; emit("__ping_c", Date.now());
 * }, heartbeat * 1000);
 * ```
 *
 * CheatEngine 那種 process 級加速會把這個 interval 一起壓縮，pong 來不及回來
 * 就必斷。而 Phaser 的 timeScale 只乘進 game loop 的 delta，**結構上碰不到
 * `setInterval`** —— 不是「小心一點就不會斷」，是它沒有辦法斷。
 *
 * ## 骰子不吃這個
 *
 * 擲骰是 three.js + cannon 的 3D 物理骰（807.js 的 `DiceD6AttackA` 那組），
 * 收斂判定是「連續 50 個 postStep 都靜止」—— 是**步數**不是時間。Phaser 的
 * timeScale 對它無效，要另外處理。但實測它只值約 1 秒／次，優先度最低，
 * 所以 v1 不做。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛設定的地方。跟 `__ulrArbiter` / `__ulrWsWatch` 同一族。 */
export const SPEED_PATCH_GLOBAL = "__ulrSpeed";

/** 預設倍率。3 倍已經吃掉大部分等待，又不至於快到看不懂發生什麼事。 */
export const DEFAULT_SPEED_FACTOR = 3;

/**
 * 倍率上限。
 *
 * 不設限的話會有人填 50，而遊戲的演出鏈是 tween 的 `onComplete` 串起來的
 * （495.js 裡 224 處 `tweens.add`）—— 極端倍率下同一幀跑完好幾層 callback，
 * 出過「牌還沒飛到位就被判定已出」這類視覺錯亂。10 倍是實測還看得懂的上限。
 */
export const MAX_SPEED_FACTOR = 10;

/** 場景會隨階段換（MovePhaseA / DefensePhaseA / AttackPhaseA / MainA），要持續補上。 */
const REAPPLY_INTERVAL_MS = 200;

/**
 * ⚠ **租約：Node 死了，頁面自己把加速還原。**
 *
 * `patch-ok` 早就有心跳（`DEFAULT_STALE_MS`），因為壓著 `I_am_ok` 不放是會
 * 害玩家棄權的。加速沒有那麼危險，但少了同一道機制會留下一個安靜的錯誤狀態：
 *
 *   插件當掉 → 頁面上的 `setInterval` 還在跑 → **加速一直留著，直到玩家自己
 *   重載遊戲**，而且沒有任何 UI 講得出這件事。
 *
 * 後果不只是「怎麼還在快」。加速是**協商出來的**（雙方都勾才生效），插件死掉
 * 之後那個協商就不存在了 —— 對手可能已經斷線、可能已經改成 1×，而我這邊還在
 * 享受提早拿回決策窗的好處。那正是 `negotiate` 取 min 要防的事。
 *
 * 所以：頁面每輪自己看時間，過期就 `uninstall()`。Node 活著就定期續約。
 *
 * 為什麼比 `patch-ok` 的 3 秒寬鬆：這裡過期的代價是「少加速幾秒」，而 patch-ok
 * 過期的代價是「玩家被鎖住」。抖一下就把功能關掉反而更擾人。
 */
export const DEFAULT_SPEED_LEASE_MS = 10_000;

/**
 * ⚠ **唯一可以加速 `scene.time` 的場景。白名單，不是黑名單。**
 *
 * MainA 的 Clock 上是亮牌的 `delay: 200`（CardOpen.showcards）與出牌後的
 * `await 110ms`（player_card_clicked）—— 兩個都是純等待，加速它們沒有副作用。
 *
 * 階段場景（`MovePhaseA` / `AttackPhaseA` / `DefensePhaseA` / `DrawPhaseA`）的
 * Clock 上住著倒數的循環 `TimerEvent`，**碰了會讓 WP-12 的硬底線提早觸發、
 * 玩家被強制提早送出 `I_am_ok`**。詳見檔頭。
 *
 * 用白名單是刻意的：以後遊戲新增階段場景，黑名單會漏掉而直接造成傷害，
 * 白名單頂多是少加速一個場景。
 */
const REVEAL_CLOCK_SCENES = ["MainA"] as const;

/**
 * ⚠ **無限循環的 tween 一律補償回原速。**
 *
 * 2026-08-05 玩家實測回報「讀秒會提早變紅」。原因是倒數的警示條就是一條
 * 無限循環 tween（171.js）：
 *
 * ```js
 * this.limit10Tween = this.tweens.add({
 *   targets: this.time_base2, alpha: 1,
 *   repeat: -1, duration: 500, yoyo: true,
 *   delay: 2e4,          // 20 秒後開始閃 ＝ 剩 10 秒
 * });
 * ```
 *
 * `tweens.timeScale = 3` 會把那個 `delay: 20000` 也壓成 6.7 真實秒，於是紅色
 * 警告在**還剩 23 秒**時就亮起來。倒數數字本身是對的（那個在 `scene.time`，
 * 我們不碰），但條跟數字脫節，而且是往「更慌」的方向誤導玩家。
 *
 * 通則比寫死 `limit10Tween` 好：無限循環的 tween 都是待機動畫、狀態指示、
 * 警示閃爍這類**跟時間有語意關係**的東西，不是一次性的演出。而且實測那
 * 75 秒的收益本來就是只數非循環 tween 量出來的 —— 不加速循環 tween 跟
 * 量測範圍一致，不會少賺。
 */
const COMPENSATE_LOOPING_TWEENS = true;

export interface SpeedPatchOptions {
  /** 回報用的 binding 名稱。 */
  bindingName: string;
  /** 倍率。1 = 原速，會被夾在 [1, MAX_SPEED_FACTOR]。 */
  factor?: number;
  /** 多久沒續約就自己還原。見 `DEFAULT_SPEED_LEASE_MS`。 */
  leaseMs?: number;
}

/** 頁面回報。 */
export type SpeedPatchReport =
  | {
      type: "speed-patch";
      /** 實際套用的倍率（已夾過）。 */
      factor: number;
      /** 這一輪套到幾個場景。 */
      scenes: number;
      /** 場景鍵，方便確認有沒有漏掉階段場景。 */
      sceneKeys: string[];
      /** 這一則是不是「租約到期，已自己還原」。 */
      expired?: boolean;
      /**
       * 哪些場景的 `scene.time` 被加速了（亮牌與出牌卡頓）。
       *
       * ⚠ 這裡出現階段場景就是**嚴重的 bug** —— 代表倒數被加速了。
       * 白名單見 `REVEAL_CLOCK_SCENES`。
       */
      clockScenes: string[];
    }
  | { type: "speed-patch-error"; reason: string };

const REPORT_TYPES = new Set(["speed-patch", "speed-patch-error"]);

export function isSpeedPatchReport(value: unknown): value is SpeedPatchReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

/** 拆掉加速，把所有 timeScale 還原成 1。結束前一定要跑。 */
export const SPEED_PATCH_UNINSTALL_EXPRESSION = `(function () {
  try {
    var S = window.${SPEED_PATCH_GLOBAL};
    if (!S || typeof S.uninstall !== "function") return "not-installed";
    return S.uninstall();
  } catch (e) { return "error:" + String((e && e.message) || e); }
})()`;

/**
 * 續約。**Node 活著的證明，就只有這個。**
 *
 * 刻意做得極小 —— 它會每隔幾秒跑一次，任何在這裡做的事都會乘上頻率。
 * 沒裝就回 `not-installed`，讓 Node 知道要重裝（例如玩家重載過遊戲）。
 */
export const SPEED_PATCH_RENEW_EXPRESSION = `(function () {
  try {
    var S = window.${SPEED_PATCH_GLOBAL};
    if (!S || typeof S.renew !== "function") return "not-installed";
    return S.renew();
  } catch (e) { return "error:" + String((e && e.message) || e); }
})()`;

/**
 * 產生注入腳本。純函式，可完整測試。
 *
 * 跟 `ws-events.ts` / `patch-ok.ts` 一樣用 `Runtime.evaluate` 裝，**不需要
 * reload**，對戰中也能接上。還沒進遊戲也裝得起來（回 `waiting`），
 * 每 200ms 自己補上 —— 玩家的順序是「先開插件再開遊戲」。
 *
 * ⚠ 重複求值會**先還原再重裝**，不是早退。理由跟 `installOkPatch()` 一樣：
 * 只換設定不換程式碼的話，改了這裡的邏輯會「測試綠但實際跑起來沒反應」
 * （ws-events 與 patch-ok 都在這裡栽過，見 battle-features.md）。
 */
export function buildSpeedPatchScript(options: SpeedPatchOptions): string {
  const raw = options.factor ?? DEFAULT_SPEED_FACTOR;
  const factor = Math.min(MAX_SPEED_FACTOR, Math.max(1, raw));

  const config = {
    bindingName: options.bindingName,
    global: SPEED_PATCH_GLOBAL,
    factor,
    reapplyMs: REAPPLY_INTERVAL_MS,
    leaseMs: Math.max(REAPPLY_INTERVAL_MS * 2, options.leaseMs ?? DEFAULT_SPEED_LEASE_MS),
    clockScenes: [...REVEAL_CLOCK_SCENES],
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var G = CFG.global;

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲（CONTRIBUTING §9.1）。
    }
  }

  // 先拆再裝。半途改倍率也走這條，還原乾淨才不會疊出奇怪的狀態。
  try {
    if (window[G] && typeof window[G].uninstall === "function") window[G].uninstall();
  } catch (e) {}

  var state = {
    factor: CFG.factor,
    timer: null,
    /** 動過的 TweenManager，拆的時候要一個個還原。 */
    touched: [],
    /** 補償過的循環 tween，拆的時候也要還原。 */
    scaledTweens: [],
    /** 動過的 Clock（只會有 MainA 那顆），拆的時候要還原。 */
    touchedClocks: [],
    /** 最近一輪真的被加速的 Clock 場景鍵，回報用。 */
    lastClockKeys: [],
    /** ⚠ Node 沒在這個時間點前續約，這個 patch 就自己還原。 */
    expiresAt: Date.now() + CFG.leaseMs,
    uninstall: null,
    renew: null
  };

  function game() {
    return window.game || null;
  }

  /** 這條 tween 是不是無限循環（待機／警示閃爍那類）。 */
  function isLooping(t) {
    try {
      if (t.repeatCounter === -1 || t.loopCounter === -1) return true;
      if (t.data) {
        for (var i = 0; i < t.data.length; i++) if (t.data[i].repeat === -1) return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * 把無限循環的 tween 補償回原速。
   *
   * manager 的 timeScale 是整個場景一起吃的，沒辦法只排除某幾條，所以改用
   * 每條 tween 自己的 timeScale 去抵銷（有效速率 = manager × tween）。
   *
   * ⚠ 倒數的警示條就靠這條活著 —— 見檔案上方 COMPENSATE_LOOPING_TWEENS。
   */
  function compensateLoops(s) {
    if (!s.tweens || typeof s.tweens.getTweens !== "function") return;
    var list;
    try { list = s.tweens.getTweens(); } catch (e) { return; }
    var want = 1 / state.factor;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      try {
        if (!isLooping(t)) continue;
        if (t.timeScale !== want) {
          if (state.scaledTweens.indexOf(t) === -1) state.scaledTweens.push(t);
          t.timeScale = want;
        }
      } catch (e) {}
    }
  }

  /**
   * 把倍率套到目前 active 的每個場景。
   *
   * tweens 每個場景都套；**scene.time 只套白名單裡的那幾個**（實際上只有
   * MainA）。階段場景的 Clock 住著倒數，而 WP-12 的硬底線讀的就是那個數字
   * —— 加速它等於強迫玩家提早送出 I_am_ok。見檔頭。
   */
  function apply() {
    var g = game();
    if (!g || !g.scene) return null;

    var scenes;
    try { scenes = g.scene.getScenes(true); } catch (e) { return null; }
    if (!scenes || scenes.length === 0) return null;

    var keys = [];
    var clockKeys = [];
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      var key = "?";
      try { key = (s.scene && s.scene.key) || "?"; } catch (e) {}
      try {
        if (s.tweens && s.tweens.timeScale !== state.factor) {
          if (state.touched.indexOf(s.tweens) === -1) state.touched.push(s.tweens);
          s.tweens.timeScale = state.factor;
        }
        if (${String(COMPENSATE_LOOPING_TWEENS)}) compensateLoops(s);

        // ⚠ 白名單。名單外的場景，它的 Clock 一個字都不准碰。
        if (CFG.clockScenes.indexOf(key) !== -1 && s.time) {
          if (s.time.timeScale !== state.factor) {
            if (state.touchedClocks.indexOf(s.time) === -1) state.touchedClocks.push(s.time);
            s.time.timeScale = state.factor;
          }
          clockKeys.push(key);
        }
        keys.push(key);
      } catch (e) {
        // 單一場景失敗不該讓整輪停掉
      }
    }
    state.lastClockKeys = clockKeys;

    // sprite 的逐格動畫是全域的，設一次就好（但場景重建後可能被重設，
    // 所以每輪都確認）。
    try {
      if (g.anims && g.anims.globalTimeScale !== state.factor) {
        g.anims.globalTimeScale = state.factor;
      }
    } catch (e) {}

    return keys;
  }

  state.uninstall = function () {
    try { if (state.timer !== null) clearInterval(state.timer); } catch (e) {}
    state.timer = null;
    for (var i = 0; i < state.touched.length; i++) {
      try { state.touched[i].timeScale = 1; } catch (e) {}
    }
    state.touched = [];
    for (var j = 0; j < state.scaledTweens.length; j++) {
      try { state.scaledTweens[j].timeScale = 1; } catch (e) {}
    }
    state.scaledTweens = [];
    // ⚠ Clock 沒還原的話，玩家拆掉加速之後亮牌還是快的，而且**沒有任何 UI
    // 告訴他** —— 之後回報「怎麼有時候快有時候慢」會完全查不出原因。
    for (var k = 0; k < state.touchedClocks.length; k++) {
      try { state.touchedClocks[k].timeScale = 1; } catch (e) {}
    }
    state.touchedClocks = [];
    try {
      var g = game();
      if (g && g.anims) g.anims.globalTimeScale = 1;
    } catch (e) {}
    try { delete window[G]; } catch (e) { window[G] = undefined; }
    return "uninstalled";
  };

  state.renew = function () {
    state.expiresAt = Date.now() + CFG.leaseMs;
    return "renewed";
  };

  window[G] = state;

  /**
   * 場景每個階段都會換，所以要一直補。順便回報，讓 Node 看得到真的套上了。
   *
   * ⚠ **這一輪的第一件事是看租約，不是套倍率。** Node 死掉時這個 interval
   * 仍然活著（它跑在遊戲的頁面裡，不是插件裡）—— 沒有這一段的話，加速會
   * 留到玩家自己重載遊戲為止。見 DEFAULT_SPEED_LEASE_MS。
   */
  var lastSignature = "";
  state.timer = setInterval(function () {
    try {
      if (Date.now() > state.expiresAt) {
        report({
          type: "speed-patch", factor: 1, scenes: 0,
          sceneKeys: [], clockScenes: [], expired: true
        });
        state.uninstall();
        return;
      }
      var keys = apply();
      if (keys === null) return;
      var sig = keys.join("|");
      if (sig !== lastSignature) {
        lastSignature = sig;
        report({
          type: "speed-patch", factor: state.factor, scenes: keys.length,
          sceneKeys: keys, clockScenes: state.lastClockKeys || []
        });
      }
    } catch (e) {
      report({ type: "speed-patch-error", reason: String((e && e.message) || e) });
    }
  }, CFG.reapplyMs);

  var first = apply();
  if (first === null) return "waiting";
  lastSignature = first.join("|");
  report({
    type: "speed-patch", factor: state.factor, scenes: first.length,
    sceneKeys: first, clockScenes: state.lastClockKeys || []
  });
  return "ok";
})()`;
}
