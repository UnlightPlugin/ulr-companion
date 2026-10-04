/**
 * 渦戰裡的投降鈕：按下去立刻回渦房
 * ==================================
 * 渦戰（`room_config.rule === "raid"`）打到一半想走，官方沒有出口。
 *
 * ## 2026-09-23 改版後的戰鬥畫面（從跑著的客戶端讀的）
 *
 * 右上角的白旗 `btn_surrender` 沒了，換成一顆選單鈕（`MainA.menu_button`，
 * 734,98）。按下去才現場建一排按鈕：
 *
 * ```js
 *   menu_button.on("click", () => {
 *     e.menu_buttons = []
 *     help（永遠有）
 *     Ll.check(room_config.rule) && surrender → 確認框 → socket.emit("surrender", room_id)
 *     Ll.check(room_config.rule) && friend
 *     Ll.check(room_config.rule) && stamp
 *     e.menu_list = new 清單類別(e, x, y, e.menu_buttons)
 *   })
 *   // 按鈕類別：new I(scene, 0, 0, name) —— Container，圖示是 MenuIcons 圖集的
 *   //           name + "_out"，按完 emit("click")
 * ```
 *
 * `Ll.check` 只放 PVP 過，渦戰的清單只有 help。這支做的事：
 *
 * ```
 *   1. 在 MainA 的 menu_buttons 上掛 setter —— 官方每次按選單都會先指派一個
 *      空陣列，渦戰時我們在那個陣列的 push 上動手腳：help 一推進去，緊接著
 *      推一顆我們的 surrender（同一個類別、同一張 MenuIcons 圖示）
 *   2. 按下去不跳確認，立刻走人（玩家 2026-09-13：「按下去時立刻投降返回渦，
 *      不跳出確認。」）
 *   3. 走人 = 照 game_result 原文收戰鬥連線 → 清場（連 sleeping 的 Raid）→
 *      start("Raid")
 * ```
 *
 * ⚠ 不改 `Ll.check`：它同時管 friend／stamp，而且官方的 surrender 會送
 * `socket.emit("surrender")` 給伺服器 —— 渦戰伺服器吃不吃那個**沒驗過**。
 *
 * ## 「投降」在渦戰是什麼
 *
 * 渦戰沒有我們能依賴的伺服器端投降 —— 結算是伺服器排程算的，走人只是**不看
 * 演出**。這一場已經送出去的攻擊照樣進帳，AP 也已經在按 START 那一刻扣掉了。
 * `Moon/打渦.py` 的「提早閃人」走的就是這條路。
 *
 * ## 走法
 *
 * ```
 *   ① socket.off() / emit("leaveRoom", room_id) / disconnect()
 *                                       照 MainA.game_result 原文收戰鬥連線
 *   ② ulrStopContentScenes(G, …, null)  MainA 跟它那一疊子場景、sleeping 的 Raid 全收
 *   ③ G.scene.start("Raid")
 * ```
 *
 * ⚠ 改版後 `Raid.init()` **不收參數**，自己從 `UL_CONFIG.domains.raid` 挑
 * 伺服器 —— 以前要先問 `raid_port` 拿 `{id, host, port}`，現在不用，所以也
 * 沒有「問不到路」這種失敗了。
 *
 * ⚠ ② 連 `Raid` 一起收（`keep = null`）：戰鬥期間渦房是 sleeping 的
 * （`Raid_MatchBoot.shutdown` 把它 sleep），`Raid.shutdown()` 會
 * `socket.disconnect()`，再 start 就是乾淨的一房。直接 start 一個 sleeping
 * 的場景 Phaser 不會先 shutdown，舊的顯示物件與舊的連線都會留著。
 *
 * ## 每一場都要掛
 *
 * MainA 場景物件是長命的（每場重用同一個實例），所以 setter 掛一次就一直在；
 * 用輪詢只是為了「插件比 MainA 先裝」的情形 —— MainA 什麼時候被建出來
 * 我們不知道。setter 自己看 rule，所以 PVP、任務戰的選單照原樣。拆的時候把
 * 屬性還原成普通的資料屬性。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";
import { JUMP_PERSISTENT_SCENES, SCENE_JUMP_SNIPPET } from "./scene-jump.js";

const FLAG = "__ulrRaidSurrender";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 跟 `patch-nav` 一樣是「先拆再裝」，版本號是回報用的。
 *
 * 2：2026-09-23 改版後的選單鈕（白旗沒了、Raid 不必問路）。
 */
export const RAID_SURRENDER_SCRIPT_VERSION = 2;

export const DEFAULT_RAID_SURRENDER_POLL_MS = 500;

/** 只在這種戰鬥加投降。任務／活動戰照官方。 */
export const RAID_SURRENDER_RULE = "raid";

/** 選單鈕的圖示：`MenuIcons` 圖集裡的 `surrender_out`（官方 PVP 那顆同一張）。 */
export const RAID_SURRENDER_ICON = "surrender";

/** 玩家按了投降。`ok: false` 時 `reason` 說為什麼沒走成（人還在戰鬥裡）。 */
export interface RaidSurrenderReport {
  type: "raid-surrender";
  ok: boolean;
  reason: string | null;
}

export function isRaidSurrenderReport(value: unknown): value is RaidSurrenderReport {
  const o = value as { type?: unknown; ok?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-surrender" &&
    typeof o.ok === "boolean"
  );
}

export interface RaidSurrenderStatus {
  installed: boolean;
  version: number | null;
  /** 選單鉤子現在掛在一場渦戰上。沒掛（不在渦戰裡）不是錯。 */
  mounted: boolean;
  reason: string | null;
}

export interface RaidSurrenderPatchOptions {
  bindingName: string;
  pollIntervalMs?: number;
}

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西拆掉（屬性還原），再從原狀重來。
 */
export function buildRaidSurrenderPatchScript(options: RaidSurrenderPatchOptions): string {
  const config = {
    version: RAID_SURRENDER_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RAID_SURRENDER_POLL_MS,
    rule: RAID_SURRENDER_RULE,
    icon: RAID_SURRENDER_ICON,
    persistent: JUMP_PERSISTENT_SCENES,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys ? window.game : null;
  }

  /** 物件還活著（Phaser destroy 之後 scene 會變 undefined）。 */
  function alive(o) {
    return !!(o && o.scene);
  }
  ${SCENE_JUMP_SNIPPET}

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  /** 這個 MainA 現在打的是還沒結束的渦戰。 */
  function isRaid(m) {
    try {
      return !!(m && m.room_config && m.room_config.rule === CFG.rule && !m.is_complete);
    } catch (e) { return false; }
  }

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var old = window[FLAG];
    if (!old) return;
    try { if (old.timer !== null && old.timer !== undefined) clearInterval(old.timer); } catch (e) {}
    try { if (typeof old.unhook === "function") old.unhook(); } catch (e) {}
    delete window[FLAG];
  }

  /**
   * MainA 的 menu_buttons 換成 accessor。官方每次開選單都先指派一個空陣列；
   * 渦戰時在那個陣列的 push 上動手腳，help 一推進去就接著推我們那顆。
   */
  function hook(st, m) {
    if (st.scene === m) return;
    unhook(st);
    var value = m.menu_buttons;
    Object.defineProperty(m, "menu_buttons", {
      configurable: true,
      enumerable: true,
      get: function () { return value; },
      set: function (v) {
        value = v;
        try { if (Array.isArray(v) && v.length === 0 && isRaid(m)) arm(st, m, v); } catch (e) { st.reason = String((e && e.message) || e); }
      }
    });
    st.scene = m;
    st.current = function () { return value; };
  }

  /** 屬性還原成普通的資料屬性，值留著（官方下一次指派照常）。 */
  function unhook(st) {
    var m = st.scene;
    if (!m) return;
    var v;
    try { v = st.current ? st.current() : undefined; } catch (e) {}
    try {
      Object.defineProperty(m, "menu_buttons", { configurable: true, enumerable: true, writable: true, value: v });
    } catch (e) {}
    st.scene = null;
    st.current = null;
  }

  function arm(st, m, arr) {
    var added = false;
    arr.push = function () {
      Array.prototype.push.apply(this, arguments);
      if (!added) {
        added = true;
        var first = arguments[0];
        var btn = makeButton(st, m, first && first.constructor);
        if (btn) Array.prototype.push.call(this, btn);
      }
      return this.length;
    };
  }

  function makeButton(st, m, Ctor) {
    if (typeof Ctor !== "function") { st.reason = "選單鈕的類別拿不到"; return null; }
    try {
      var tex = m.textures && m.textures.get("MenuIcons");
      if (!tex || !tex.has || !tex.has(CFG.icon + "_out")) { st.reason = "MenuIcons 圖集沒有 " + CFG.icon + "_out"; return null; }
    } catch (e) { st.reason = "讀不到 MenuIcons 圖集"; return null; }
    var btn = new Ctor(m, 0, 0, CFG.icon);
    btn.on("click", function () {
      try { if (m.ulse01 && m.ulse01.play) m.ulse01.play(); } catch (e) {}
      try { if (m.menu_list && m.menu_list.menu_remove) m.menu_list.menu_remove(); } catch (e) {}
      leave(st, m);
    });
    st.reason = null;
    return btn;
  }

  function leave(st, m) {
    var G = gameOf();
    if (!G || st.busy) return;
    if (!isRaid(m)) return fail(st, "這一場已經結束了");
    st.busy = true;
    try {
      // ① 照 game_result 原文收戰鬥連線。一定在 stop 之前。
      m.is_complete = true;
      try {
        var s = m.socket;
        if (s) { s.off(); s.emit("leaveRoom", m.room_id); s.disconnect(); }
      } catch (e) {}
      // ② 清場：MainA、它那一疊子場景、sleeping 的 Raid 全收。
      var stopped = ulrStopContentScenes(G, CFG.persistent, null);
      // ③ 開一房乾淨的渦房（改版後 Raid.init 不收參數）。
      G.scene.start("Raid");
      st.busy = false;
      st.reason = null;
      report({ type: "raid-surrender", ok: true, reason: null, stopped: stopped });
    } catch (e) {
      fail(st, String((e && e.message) || e));
    }
  }

  function fail(st, why) {
    st.busy = false;
    st.reason = why;
    report({ type: "raid-surrender", ok: false, reason: why });
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      var m = G ? G.scene.keys.MainA : null;
      if (!m) return;
      hook(st, m);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    scene: null,
    current: null,
    busy: false,
    timer: null,
    reason: null,
    unhook: null
  };
  st.unhook = function () { unhook(st); };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    mounted: isRaid(st.scene),
    reason: st.reason
  });
})()`;
}

export const RAID_SURRENDER_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, mounted: false, reason: null });
    var m = st.scene;
    var raid = !!(m && m.room_config && m.room_config.rule === "${RAID_SURRENDER_RULE}" && !m.is_complete);
    return JSON.stringify({
      installed: true,
      version: st.version,
      mounted: raid,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, mounted: false,
      reason: String((e && e.message) || e)
    });
  }
})()`;

/** 拆掉：menu_buttons 還原成資料屬性。插件關掉就該什麼都不留。 */
export const RAID_SURRENDER_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { if (typeof st.unhook === "function") st.unhook(); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseRaidSurrenderStatus(raw: string): RaidSurrenderStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      mounted: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    mounted: o.mounted === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
