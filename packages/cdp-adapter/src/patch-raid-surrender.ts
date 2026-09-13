/**
 * 渦戰裡的投降鈕：按下去立刻回渦房
 * ==================================
 * 渦戰（rule === "raid"）打到一半想走，官方沒有出口：白旗在 `MainA.create()`
 * 裡寫死藏起來（2026-09-13 從跑著的客戶端讀的）——
 *
 * ```js
 *   this.btn_surrender = this.add.image(760,118,"btn_surrender",0).setOrigin(1,0).setInteractive()
 *   this.btn_surrender.on("pointerdown", () => { …開確認面板… })
 *   "quest"!=this.config.rule && "raid"!=this.config.rule && "event"!=this.config.rule
 *     || (this.btn_surrender.visible = false)
 *   // 確認鈕：("duel"===rule || "ranked"===rule) && socket.emit("match_surrender", id, room)
 * ```
 *
 * 所以那顆鈕在渦戰**存在、可互動、只是看不見**，而它的確認鈕就算按了也不會
 * 送任何封包（`match_surrender` 只認 duel／ranked）。這支做的事：
 *
 * ```
 *   1. 把 btn_surrender 顯示出來 —— 跟 PVP 那顆同一個物件、同一張圖、同一個位置
 *   2. 拆掉它的 pointerdown（開確認面板那個），換成我們的：按下去立刻走人
 *   3. 走人 = 問路 raid_port → 照 on_result 收戰鬥連線 → 清場 → start("Raid")
 * ```
 *
 * 玩家 2026-09-13：「按下去時立刻投降返回渦，不跳出確認。」
 *
 * ## 「投降」在渦戰是什麼
 *
 * 渦戰沒有伺服器端的投降 —— 結算是伺服器排程算的（`atkvalue`／`diceRoll`／
 * `dmgTo` 全是伺服器推給客戶端的，客戶端只負責演），走人只是**不看演出**。
 * 這一場已經送出去的攻擊照樣進帳，AP 也已經在按 START 那一刻扣掉了。
 * `Moon/打渦.py` 的「提早閃人」走的就是這條路，2026-08-30 起每一場都這樣走，
 * 下一回合照樣開得起來。
 *
 * ## 走法：照 `Moon/打渦.py` 的 出完傷害就閃，順序有講究
 *
 * ```
 *   ① ulrAskPort("raid_port")          問不到就放棄：按鈕彈回來，人還在戰鬥裡
 *   ② socket.off() / emit("leaveRoom", room) / disconnect()
 *                                       照 MainA.on_result 原文收戰鬥連線
 *   ③ ulrStopContentScenes(G, …, null)  MainA 跟它那一疊子場景、sleeping 的 Raid 全收
 *   ④ G.scene.start("Raid", {id, host, port})
 * ```
 *
 * ⚠ ① 一定要在 ② 之前：② 之後就回不了頭了（連線一收，伺服器再也不會推東西
 * 過來，畫面停在戰鬥）。所有「湊不齊就放棄」的檢查都做在 ① 那一步。
 *
 * ⚠ ② 一定要在 ③ 之前：`MainA` 掛了 `events.once("shutdown", …)` →
 * `socket.disconnect(); socket.off()`，stop 之後再 emit `leaveRoom` 送不出去。
 *
 * ⚠ ③ 連 `Raid` 一起收（`keep = null`），理由見 `scene-jump.ts` 檔頭：戰鬥期間
 * 渦房是 sleeping 的，不先 stop 就 start，舊的顯示物件跟舊的渦伺服器連線都會
 * 留著。
 *
 * ## 每一場都重掛
 *
 * 跟 `patch-nav` 一樣輪詢：MainA active、rule 是 raid、`btn_surrender` 活著、
 * 而且不是我們掛過的那一顆（**「掛過了沒」記在 GameObject 上**，場景物件是
 * 長命的，記在它身上第二場就不會重掛）。原本的 pointerdown handler 留著，
 * 拆的時候原樣掛回去、按鈕藏回去 —— 插件關掉就該什麼都不留。
 *
 * ⚠ pointerover／pointerout 不動：那兩個只是換 hover 的圖，跟 PVP 一模一樣
 * 正是要的。
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
 */
export const RAID_SURRENDER_SCRIPT_VERSION = 1;

export const DEFAULT_RAID_SURRENDER_POLL_MS = 500;

/** 問路（raid_port）最多等多久。實測 250ms 就回。 */
export const DEFAULT_RAID_SURRENDER_PORT_TIMEOUT_MS = 4_000;

/** 只在這種戰鬥顯示。任務／活動戰的白旗照官方藏著。 */
export const RAID_SURRENDER_RULE = "raid";

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
  /** 白旗現在掛在一場渦戰上。沒掛（不在渦戰裡）不是錯。 */
  mounted: boolean;
  reason: string | null;
}

export interface RaidSurrenderPatchOptions {
  bindingName: string;
  pollIntervalMs?: number;
  portTimeoutMs?: number;
}

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西拆掉（handler 還原、按鈕藏回去），
 * 再從原狀重來。
 */
export function buildRaidSurrenderPatchScript(options: RaidSurrenderPatchOptions): string {
  const config = {
    version: RAID_SURRENDER_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RAID_SURRENDER_POLL_MS,
    portTimeoutMs: options.portTimeoutMs ?? DEFAULT_RAID_SURRENDER_PORT_TIMEOUT_MS,
    rule: RAID_SURRENDER_RULE,
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

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    detach(st);
    delete window[FLAG];
  }

  /** 白旗還原：我們的 handler 拆掉、官方的掛回去、藏回去。按鈕死了就只清狀態。 */
  function detach(st) {
    var b = st.btn;
    if (alive(b)) {
      try { b.off("pointerdown", st.handler); } catch (e) {}
      try {
        for (var i = 0; i < st.orig.length; i++) b.on("pointerdown", st.orig[i]);
      } catch (e) {}
      try { b.setVisible(false); } catch (e) {}
    }
    st.btn = null;
    st.scene = null;
    st.orig = [];
    st.handler = null;
    st.busy = false;
  }

  /** 現在正在打的渦戰。不是渦戰、不在戰鬥畫面、白旗還沒建好都回 null。 */
  function raidBattle(G) {
    var m = G.scene.keys.MainA;
    try {
      if (!m || !m.scene || !m.scene.isActive()) return null;
      if (!m.config || m.config.rule !== CFG.rule) return null;
      if (!alive(m.btn_surrender)) return null;
    } catch (e) { return null; }
    return m;
  }

  function mount(st, m) {
    var b = m.btn_surrender;
    var orig = [];
    try { orig = b.listeners("pointerdown").slice(); } catch (e) {}
    try { b.off("pointerdown"); } catch (e) {}
    var handler = function () { leave(st); };
    b.on("pointerdown", handler);
    try { b.setTexture("btn_surrender", 0); } catch (e) {}
    b.setVisible(true);
    st.btn = b;
    st.scene = m;
    st.orig = orig;
    st.handler = handler;
    st.busy = false;
    st.reason = null;
  }

  function leave(st) {
    var G = gameOf();
    var m = st.scene, b = st.btn;
    if (!G || !m || !alive(b) || st.busy) return;
    st.busy = true;
    try { b.setTexture("btn_surrender", 0).disableInteractive(); } catch (e) {}

    var id = m.id;
    if (!id) return fail(st, "挖不到玩家 id");

    // ① 先問路。問不到就放棄 —— 這一步之後才是回不了頭的。
    ulrAskPort(G, "raid_port", CFG.portTimeoutMs).then(function (addr) {
      if (!alive(b) || st.scene !== m) throw new Error("戰鬥畫面已經換掉了");
      // ② 照 on_result 原文收戰鬥連線。一定在 stop 之前：MainA 的 shutdown 會 disconnect。
      try {
        var s = m.socket;
        if (s) { s.off(); s.emit("leaveRoom", m.room); s.disconnect(); }
      } catch (e) {}
      // ③ 清場：MainA、它那一疊子場景、sleeping 的 Raid 全收。
      var stopped = ulrStopContentScenes(G, CFG.persistent, null);
      // ④ 開一房乾淨的渦房。
      G.scene.start("Raid", { id: id, host: addr.host, port: addr.port });
      st.busy = false;
      st.reason = null;
      report({ type: "raid-surrender", ok: true, reason: null, stopped: stopped });
    }).catch(function (e) {
      fail(st, String((e && e.message) || e));
    });
  }

  function fail(st, why) {
    st.busy = false;
    st.reason = why;
    try { if (alive(st.btn)) st.btn.setInteractive(); } catch (e) {}
    report({ type: "raid-surrender", ok: false, reason: why });
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      var m = G ? raidBattle(G) : null;
      if (m === null) {
        if (st.btn !== null) detach(st);
        return;
      }
      // 場景重建過的話白旗是新的一顆（舊的跟著舊場景 destroy 了）。
      if (st.btn !== m.btn_surrender || !alive(st.btn)) {
        detach(st);
        mount(st, m);
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    btn: null,
    scene: null,
    orig: [],
    handler: null,
    busy: false,
    timer: null,
    reason: null
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    mounted: alive(st.btn),
    reason: st.reason
  });
})()`;
}

export const RAID_SURRENDER_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, mounted: false, reason: null });
    return JSON.stringify({
      installed: true,
      version: st.version,
      mounted: !!(st.btn && st.btn.scene),
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, mounted: false,
      reason: String((e && e.message) || e)
    });
  }
})()`;

/** 拆掉：官方 handler 掛回去、白旗藏回去。插件關掉就該什麼都不留。 */
export const RAID_SURRENDER_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var b = st.btn;
    if (b && b.scene) {
      try { b.off("pointerdown", st.handler); } catch (e) {}
      try { for (var i = 0; i < st.orig.length; i++) b.on("pointerdown", st.orig[i]); } catch (e) {}
      try { b.setVisible(false); } catch (e) {}
    }
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
