/**
 * 伺服器沒回、官方把畫面鎖住：自己解開
 * ====================================
 * 2026-09-26 實機：輸入渦碼後整個渦房點不動，只能重載。玩家說「常常遇到」。
 *
 * 官方到處是這個寫法（2026-09-26 掃 bundle：135 處關點擊，其中 48 處緊接著等伺服器 ——
 * 商店購買、用道具、好友、存牌組、開渦、開房、Bonus……）：
 *
 * ```js
 *   this.input.enabled = false
 *   const r = await this.socket.fetch("shop_buy", …)   // 逾時會 reject
 *   ...
 *   this.input.enabled = true                           // reject 了就永遠走不到
 * ```
 *
 * 官方的 `fetch` 等不到同名回覆就 reject `Error("<事件>: timed out (<網址>)")`，
 * 而這些 handler 都沒接，於是變成 `unhandledrejection`（官方自己掛了一個，只
 * `reportError` 加 `preventDefault`，不擋其他監聽）。這支在 window 上聽它：
 * 訊息是「某事件逾時」→ 把**正在跑、點擊被關掉**的場景打開，回報托盤寫一行。
 *
 * - 渦碼那一處（raid_code_input）patch-raid-view 另外會跳官方錯誤框說明原因；
 *   這支**晚一拍**（setTimeout 0）才看，那邊先處理完、點擊已經開了就不重複。
 * - **戰鬥中不動**（MainA 開著）：戰鬥場景會為了演出自己關點擊，那不是卡住。
 * - 解開之後官方那個 handler 的後半段（成功後的重畫）不會跑 —— 請求本身沒成功，
 *   畫面停在送出前的樣子是對的。
 * - 不包 fetch、不多送任何請求。
 *
 * 伺服器回了 `false` 卻沒送錯誤事件的那種卡法（handler 只在成功時才開點擊）這支看不到：
 * 沒有例外可聽。遇到再說。
 *
 * ## 對戰結束留下的暫停階段場景（2026-10-08 實機）
 *
 * 官方 949.js 的 game_result()（對戰結束）：
 *
 * ```js
 *   for (階段場景) if (isActive()) { tweens.killAll(); scene.pause() }      // ① 先暫停
 *   BackA.game_end(...)
 *   for (階段場景) if (isActive()) { 鏡頭淡出 1 秒 → scene.stop() }          // ② 再收掉
 * ```
 *
 * 暫停之後 isActive() 是 false，② 一個都收不到 —— 對手在某個階段中途投降／斷線時，
 * 那個階段場景（實例是 DrawPhaseA）就一直停在 PAUSED。暫停的場景 Phaser 照樣每格畫。
 * 回大廳時 UL_LOADER.clean() 把對戰的貼圖（phase_draw…）卸掉，之後每格畫到它就 throw
 * 「texture error (removed while still in use)」：畫面只畫到一半，最上層的東西（match_error
 * 的「AP不足」框）出不來，框底下吃點擊的全畫面底照樣在 → 玩家看到大廳「卡住」。
 *
 * 這支每秒看一次：對戰主場景（MainA）已經不在了（沒在跑、沒暫停、沒睡）而官方那張名單裡
 * 還有暫停著的，就替官方把 ② 做完（scene.stop）。MainA 還在（含它自己被暫停）一律不動，
 * 對戰中的暫停是官方的事。不多送任何請求。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrInputRescue";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const INPUT_RESCUE_SCRIPT_VERSION = 2;

/** 戰鬥主場景。它開著時不動任何場景的點擊。 */
export const INPUT_RESCUE_BATTLE_SCENE = "MainA";

/**
 * 官方 game_result() 結束時要收掉的那張名單（949.js，2026-10-08 照抄）。
 * 只收這些：名單外的場景暫停著可能是別的功能在用。
 */
export const BATTLE_LEFTOVER_SCENES = [
  "MovePhaseA",
  "DrawPhaseA",
  "AttackPhaseA",
  "AtkDicerollA",
  "AtkResultA",
  "DefensePhaseA",
  "DefDiceRollA",
  "DefResultA",
  "BattlePlayerAvatar",
  "BattleOpponentAvatar",
  "ChangePhaseA",
] as const;

/** 多久看一次殘留的暫停場景。 */
const LEFTOVER_SWEEP_MS = 1000;

/** 解開了一次。 */
export interface InputRescueReport {
  type: "input-rescue";
  /**
   * 沒給＝請求逾時、打開了點擊。
   * `battle-leftover`＝對戰結束後官方沒收掉的暫停階段場景，替它收掉了。
   */
  kind?: "battle-leftover";
  /** 逾時的請求名（raid_code_input、shop_buy…）；battle-leftover 時是 game_result */
  event: string;
  /** 被打開（或被收掉）的場景 */
  scenes: string[];
}

export function isInputRescueReport(value: unknown): value is InputRescueReport {
  const o = value as { type?: unknown; event?: unknown; scenes?: unknown } | null;
  return (
    typeof value === "object" &&
    o !== null &&
    o.type === "input-rescue" &&
    typeof o.event === "string" &&
    Array.isArray(o.scenes)
  );
}

export interface InputRescueStatus {
  installed: boolean;
  version: number | null;
  /** 裝上之後解開過幾次 */
  rescues: number;
  reason: string | null;
}

export interface InputRescuePatchOptions {
  bindingName: string;
}

/** 從 reject 的訊息認出是哪個請求逾時。認不出來回 null。頁面裡照抄一份。 */
export function timedOutEvent(message: string): string | null {
  const m = /^(\w+): timed out \(/.exec(message);
  return m === null ? null : m[1]!;
}

export function buildInputRescuePatchScript(options: InputRescuePatchOptions): string {
  const config = {
    version: INPUT_RESCUE_SCRIPT_VERSION,
    bindingName: options.bindingName,
    battleScene: INPUT_RESCUE_BATTLE_SCENE,
    leftoverScenes: [...BATTLE_LEFTOVER_SCENES],
    sweepMs: LEFTOVER_SWEEP_MS,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  function running(sc) {
    try { return !!(sc && sc.scene && sc.scene.isActive() && !sc.scene.isSleeping()); } catch (e) { return false; }
  }
  function timedOutEvent(reason) {
    var msg = reason && typeof reason.message === "string" ? reason.message : "";
    var m = /^(\\w+): timed out \\(/.exec(msg);
    return m === null ? null : m[1];
  }

  /** 正在跑、點擊被關掉的場景全部打開。戰鬥中什麼都不做。回打開了哪些。 */
  function rescue() {
    var G = window.game;
    if (!G || !G.scene || !G.scene.keys) return [];
    if (running(G.scene.keys[CFG.battleScene])) return [];
    var out = [];
    var keys = Object.keys(G.scene.keys);
    for (var i = 0; i < keys.length; i++) {
      var sc = G.scene.keys[keys[i]];
      if (!running(sc) || !sc.input || sc.input.enabled !== false) continue;
      sc.input.enabled = true;
      out.push(keys[i]);
    }
    return out;
  }

  function paused(sc) {
    try { return !!(sc && sc.scene && sc.scene.isPaused()); } catch (e) { return false; }
  }
  /** 對戰主場景還在（跑著、暫停、睡著都算）。 */
  function battleAlive(sc) {
    try { return !!(sc && sc.scene && (sc.scene.isActive() || sc.scene.isPaused() || sc.scene.isSleeping())); } catch (e) { return true; }
  }
  /** 對戰已經結束、官方名單裡還暫停著的場景替官方收掉。回收掉了哪些。 */
  function sweepLeftovers() {
    var G = window.game;
    if (!G || !G.scene || !G.scene.keys) return [];
    var K = G.scene.keys;
    if (!K[CFG.battleScene] || battleAlive(K[CFG.battleScene])) return [];
    var out = [];
    for (var i = 0; i < CFG.leftoverScenes.length; i++) {
      var key = CFG.leftoverScenes[i];
      var sc = K[key];
      if (!paused(sc)) continue;
      try { sc.scene.stop(); out.push(key); } catch (e) {}
    }
    return out;
  }
  function onSweep(st) {
    if (window[FLAG] !== st) return;
    try {
      var stopped = sweepLeftovers();
      if (stopped.length === 0) return;
      st.leftovers++;
      report({ type: "input-rescue", kind: "battle-leftover", event: "game_result", scenes: stopped });
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  function onRejection(st, ev) {
    var name = timedOutEvent(ev ? ev.reason : null);
    if (name === null) return;
    // 晚一拍：專門處理某個請求的腳本（渦碼的錯誤框）先跑完
    setTimeout(function () {
      if (window[FLAG] !== st) return;
      try {
        var opened = rescue();
        if (opened.length === 0) return;
        st.rescues++;
        report({ type: "input-rescue", event: name, scenes: opened });
      } catch (e) {
        st.reason = String((e && e.message) || e);
      }
    }, 0);
  }

  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.handler) window.removeEventListener("unhandledrejection", st.handler); } catch (e) {}
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, handler: null, timer: null, rescues: 0, leftovers: 0, reason: null };
  if (typeof window.addEventListener === "function") {
    st.handler = function (ev) { try { onRejection(st, ev); } catch (e) {} };
    window.addEventListener("unhandledrejection", st.handler);
  } else {
    st.reason = "window.addEventListener 不存在";
  }
  window[FLAG] = st;
  st.timer = setInterval(function () { onSweep(st); }, CFG.sweepMs);
  onSweep(st);
  return JSON.stringify({ installed: true, version: st.version, rescues: st.rescues, reason: st.reason });
})()`;
}

export const INPUT_RESCUE_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, rescues: 0, reason: null });
    return JSON.stringify({ installed: true, version: st.version, rescues: st.rescues, reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, rescues: 0, reason: String((e && e.message) || e) });
  }
})()`;

/** 拆掉：收監聽。 */
export const INPUT_RESCUE_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.handler) window.removeEventListener("unhandledrejection", st.handler); } catch (e) {}
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseInputRescueStatus(raw: string): InputRescueStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      rescues: 0,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    rescues: typeof o.rescues === "number" ? o.rescues : 0,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
