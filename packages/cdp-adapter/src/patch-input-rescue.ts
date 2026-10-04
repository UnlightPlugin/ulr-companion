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
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrInputRescue";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const INPUT_RESCUE_SCRIPT_VERSION = 1;

/** 戰鬥主場景。它開著時不動任何場景的點擊。 */
export const INPUT_RESCUE_BATTLE_SCENE = "MainA";

/** 解開了一次。 */
export interface InputRescueReport {
  type: "input-rescue";
  /** 逾時的請求名（raid_code_input、shop_buy…） */
  event: string;
  /** 被打開的場景 */
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
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, handler: null, rescues: 0, reason: null };
  if (typeof window.addEventListener === "function") {
    st.handler = function (ev) { try { onRejection(st, ev); } catch (e) {} };
    window.addEventListener("unhandledrejection", st.handler);
  } else {
    st.reason = "window.addEventListener 不存在";
  }
  window[FLAG] = st;
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
