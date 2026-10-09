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
 * ## 對人戰的投降與「鈕放外面」（玩家 2026-10-05，兩個開關）
 *
 * 這支是對戰 MENU 的**唯一擁有者**：MainA 是長命的，`menu_buttons` 上只能有一個
 * accessor —— 另一支再掛一個，拆的時候會把這支的一起拆掉，渦的投降鈕就安靜消失。
 * 所以對人戰的投降也住在這裡。
 *
 * 官方流程（2026-10-05 讀的）：MENU 裡的投降鈕圖示 `surrender_out`，click 叫模組
 * 3480 的 `XF`：確認框（surrender_confirm）→ ok 才 `socket.emit("surrender", room_id)`，
 * 之後等 game_result 自己畫結果。只有 PvPBattleRule（duel、ranked）有它。
 *
 * ```
 *   dietNoConfirm  迪城的 duel：投降不跳確認，直接 emit 那一個（跟按 ok 送的一樣）；
 *                  之後的「你投降了」框不跳、結算 OK 自動按（見下）
 *   outside        投降鈕放到 MENU 正下方（同一個類別），MENU 裡不列
 *                  渦：我們那顆（直接回渦房）
 *                  對人戰：官方確認流程（迪城＋不確認就直接送）
 * ```
 *
 * - 迪城＝Match 場景的 channel（對戰中 Match 不 active，但 channel 留著進來那個頻道）。
 *   ⚠ 打渦時 channel 也還是上次的迪城，所以另外要 `rule === "duel"`。
 * - 官方確認那支是模組內部函式、匯出是唯讀 getter：從 webpack 模組表掃
 *   surrender_confirm ＋ emit("surrender") 找到它直接呼叫（只 require 命中的模組）。
 *   找不到就不畫外面那顆、MENU 照官方。
 * - MENU 裡不列：官方逐顆 push、push 完才排版，所以在 push 上把投降鈕當場拆掉，選單不留空格。
 *
 * ## 不確認送出之後：跳過「你投降了」與結算 OK（玩家 2026-10-06）
 *
 * 伺服器回 game_result 之後（2026-10-06 從網頁版讀的）：
 *
 * ```js
 *   MainA.game_result(e) {
 *     … 收連線 …
 *     e.code === SURRENDER && await this.show_surrender_result(e.result)
 *        // 原型方法："win" 以外 → 確認框「你投降了。終止比賽。」等按 ok
 *     … 淡出 … this.scene.start("Result", { params: e, … })
 *   }
 *   Result：OK 淡入完 events.emit("result_ok_shown")；OK 的 pointerup 在有獎勵遊戲時
 *           scene.launch("Bonus")，沒有就 result_scene_end() 回大廳
 * ```
 *
 * - 「你投降了」：MainA 實例上蓋一個 show_surrender_result —— 只有我們剛送出
 *   surrender 的那一房（room_id 對得上）、結果不是 win 才直接 resolve，其餘交回原型。
 * - 之後直接到獎勵遊戲：真的跳過了那個框（＝確定是這一場以投降收尾）才動手 ——
 *   MainA 收尾（淡出＋等 1.5 秒）快轉；Result 一建好藏鏡頭＋快轉＋靜音，
 *   result_ok_shown 一出來就替玩家 emit pointerup（＝官方 launch("Bonus")；沒有獎勵
 *   遊戲就是回大廳）。⚠ 獎勵遊戲是疊在 Result 上的（後面的立繪、下方 Gem/Exp 欄
 *   都是 Result 的），所以 Bonus 一 start 就把 Result 的鏡頭與速度還原。
 *   只按第一顆 —— 獎勵遊戲結束後那顆 OK 照常由玩家按。
 * - 都只在「不確認」送出的那一次；經官方確認框送的照官方。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";
import { JUMP_PERSISTENT_SCENES, SCENE_JUMP_SNIPPET } from "./scene-jump.js";

const FLAG = "__ulrRaidSurrender";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 跟 `patch-nav` 一樣是「先拆再裝」，版本號是回報用的。
 *
 * 2：2026-09-23 改版後的選單鈕（白旗沒了、Raid 不必問路）。
 * 3：對人戰的投降（迪城不確認、投降鈕放 MENU 外面，渦也算）。
 * 4：不確認送出之後跳過「你投降了」框、結算 OK 自動按。
 */
export const RAID_SURRENDER_SCRIPT_VERSION = 4;

/**
 * 官方 MENU 裡有投降鈕的房型（unlight-common 的 PvPBattleRule，2026-10-05 讀的）。
 * 渦、任務不在裡面。
 */
export const PVP_BATTLE_RULES = ["duel", "ranked"] as const;

/** 外面那顆貼在 MENU（734,98，48x32）正下方，間距跟右下角 FRIENDLIST／ITEM 一樣。 */
export const SURRENDER_OUTSIDE_DY = 34;

/** 投降之後收尾與結算畫面的快轉倍率（時間與補間的 timeScale）。 */
export const SURRENDER_SKIP_SPEED = 50;

/** 投降的兩個開關。 */
export interface BattleSurrenderOptions {
  /** 迪城的 duel：投降不跳確認框。 */
  dietNoConfirm: boolean;
  /** 投降鈕放 MENU 外面（渦、迪城、亞城都算）。 */
  outside: boolean;
}

export const DEFAULT_BATTLE_SURRENDER: BattleSurrenderOptions = {
  dietNoConfirm: false,
  outside: false,
};

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
  dietNoConfirm: boolean;
  outside: boolean;
  /** 外面那顆投降鈕現在畫著。 */
  outsideShown: boolean;
  reason: string | null;
}

export interface RaidSurrenderPatchOptions {
  bindingName: string;
  pollIntervalMs?: number;
  /** 投降的兩個開關。沒給＝都關（照官方＋渦的鈕在 MENU 裡）。 */
  surrender?: BattleSurrenderOptions;
}

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西拆掉（屬性還原），再從原狀重來。
 */
export function buildRaidSurrenderPatchScript(options: RaidSurrenderPatchOptions): string {
  const surrender = options.surrender ?? DEFAULT_BATTLE_SURRENDER;
  const config = {
    version: RAID_SURRENDER_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RAID_SURRENDER_POLL_MS,
    rule: RAID_SURRENDER_RULE,
    icon: RAID_SURRENDER_ICON,
    persistent: JUMP_PERSISTENT_SCENES,
    pvpRules: PVP_BATTLE_RULES,
    outsideDy: SURRENDER_OUTSIDE_DY,
    findEveryMs: 2000,
    resultSpeed: SURRENDER_SKIP_SPEED,
    dietNoConfirm: surrender.dietNoConfirm,
    outside: surrender.outside,
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
  function running(m) {
    try { return !!(m && m.scene && m.scene.isActive()); } catch (e) { return false; }
  }
  ${SCENE_JUMP_SNIPPET}
  ${WEBPACK_REQUIRE_SNIPPET}

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

  /** 還沒結束的對人戰（官方 MENU 有投降的房型）。 */
  function isPvp(m) {
    try {
      return !!(m && m.room_config && CFG.pvpRules.indexOf(m.room_config.rule) !== -1 && !m.is_complete);
    } catch (e) { return false; }
  }

  /** 迪城的 duel。頻道物件有 type 看 type，沒有就是「不是快速比賽（亞城）也不是活動頻道」。 */
  function dietDuel(m) {
    var G = gameOf();
    var M = G ? G.scene.keys.Match : null;
    var ch = M ? M.channel : null;
    if (!ch || typeof ch !== "object") return false;
    var diet = typeof ch.type === "string" ? ch.type === "duel" : ch.quick !== true && ch.event !== true;
    return diet && !!(m.room_config && m.room_config.rule === "duel");
  }

  function isSurrenderBtn(b) {
    var icon = b && b.button_icon;
    return !!(icon && icon.frame && icon.frame.name === CFG.icon + "_out");
  }

  function playSe(m) {
    try { if (m.ulse01 && m.ulse01.play) m.ulse01.play(); } catch (e) {}
  }
  /** 選單開著才收（從外面那顆按的時候選單多半是關著的）。 */
  function closeMenu(m) {
    try {
      var l = m.menu_list;
      if (!l || typeof l.menu_remove !== "function") return;
      if (l.menu_base && !l.menu_base.scene) return;
      l.menu_remove();
    } catch (e) {}
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
   * 渦戰與對人戰時在那個陣列的 push 上動手腳。
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
        try { if (Array.isArray(v) && v.length === 0) arm(st, m, v); } catch (e) { st.reason = String((e && e.message) || e); }
      }
    });
    st.scene = m;
    st.current = function () { return value; };
    hookSurrenderResult(st, m);
  }

  /**
   * 「你投降了」框：我們剛送出 surrender 的那一房、不是 win 就不畫，並約好替玩家按結算 OK。
   * 其餘交回原型（對手投降、經官方確認框送的都照官方）。
   */
  function hookSurrenderResult(st, m) {
    var orig = Object.getPrototypeOf(m).show_surrender_result;
    if (typeof orig !== "function") return;
    var fn = function (result) {
      if (window[FLAG] === st && result !== "win" && st.skipRoom !== null && st.skipRoom === this.room_id) {
        st.skipRoom = null;
        armResultSkip(st, this);
        return Promise.resolve();
      }
      return orig.apply(this, arguments);
    };
    m.show_surrender_result = fn;
    st.surrenderResult = fn;
  }

  function speedScene(sc, k) {
    try { if (sc && sc.time) sc.time.timeScale = k; } catch (e) {}
    try { if (sc && sc.tweens) sc.tweens.timeScale = k; } catch (e) {}
  }
  function camAlpha(sc, a) {
    try { if (sc && sc.cameras && sc.cameras.main) sc.cameras.main.setAlpha(a); } catch (e) {}
  }

  /**
   * 投降之後直接到獎勵遊戲：
   *   MainA 收尾（淡出＋等 1.5 秒才 start Result）加速，Result 開始就還原；
   *   Result 一建好藏鏡頭、加速、靜音，OK 一出來就按（有獎勵遊戲就進、沒有就回大廳）；
   *   獎勵遊戲一開始 Result 還原速度與鏡頭 —— 獎勵遊戲畫面後面的立繪與下方
   *   Gem/Exp 欄是 Result 的，要看得到；LOSE 字樣在按 OK 時已經淡掉了。
   *   獎勵遊戲結束後那顆 OK 照常由玩家按。
   */
  function armResultSkip(st, m) {
    dropResultSkip(st);
    var G = gameOf();
    var R = G ? G.scene.keys.Result : null;
    if (!R || !R.events || typeof R.events.once !== "function") return;
    var B = G.scene.keys.Bonus;
    var offs = [];
    function once(em, name, fn) {
      if (!em || typeof em.once !== "function") return;
      em.once(name, fn);
      offs.push(function () { try { em.off(name, fn); } catch (e) {} });
    }
    function cleanup() {
      if (st.resultSkip === cleanup) st.resultSkip = null;
      for (var i = 0; i < offs.length; i++) offs[i]();
      offs = [];
      speedScene(m, 1);
      speedScene(R, 1);
      camAlpha(R, 1);
    }
    speedScene(m, CFG.resultSpeed);
    once(R.events, "start", function () { speedScene(m, 1); });
    once(R.events, "create", function () {
      if (window[FLAG] !== st) return;
      camAlpha(R, 0);
      speedScene(R, CFG.resultSpeed);
      try { if (R.ulse15 && R.ulse15.stop) R.ulse15.stop(); } catch (e) {}
      try { if (R.ulse16 && R.ulse16.stop) R.ulse16.stop(); } catch (e) {}
    });
    once(R.events, "result_ok_shown", function () {
      if (window[FLAG] !== st) return;
      var ok = R.result_ok;
      if (alive(ok) && typeof ok.emit === "function") { ok.emit("pointerup"); st.autoOks++; }
    });
    once(B && B.events, "start", function () { speedScene(R, 1); camAlpha(R, 1); });
    once(R.events, "shutdown", cleanup);
    st.resultSkip = cleanup;
  }
  function dropResultSkip(st) {
    var f = st.resultSkip;
    st.resultSkip = null;
    if (typeof f === "function") f();
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
    try { if (m.show_surrender_result === st.surrenderResult) delete m.show_surrender_result; } catch (e) {}
    st.surrenderResult = null;
    st.skipRoom = null;
    dropResultSkip(st);
    st.scene = null;
    st.current = null;
  }

  /**
   * 渦戰：help 一推進去就接著推我們那顆（鈕放外面時不推）。
   * 對人戰：官方的投降鈕 —— 放外面就當場拆掉不放進去；迪城＋不確認就把 click 換掉
   * （官方先 on click 再 push，所以這裡換得到）。
   */
  function arm(st, m, arr) {
    var raid = isRaid(m);
    var pvp = isPvp(m);
    if (!raid && !pvp) return;
    var added = false;
    arr.push = function () {
      for (var i = 0; i < arguments.length; i++) {
        var b = arguments[i];
        if (pvp && isSurrenderBtn(b)) {
          if (st.opts.outside && confirmFn(st) !== null) { try { b.destroy(); } catch (e) {} continue; }
          if (st.opts.dietNoConfirm && dietDuel(m)) toDirect(st, m, b);
        }
        Array.prototype.push.call(this, b);
      }
      if (raid && !added && this.length > 0) {
        added = true;
        if (!st.opts.outside) {
          var btn = makeButton(st, m, this[0] && this[0].constructor);
          if (btn) {
            btn.on("click", function () { playSe(m); closeMenu(m); leave(st, m); });
            Array.prototype.push.call(this, btn);
          }
        }
      }
      return this.length;
    };
  }

  function iconOk(st, m) {
    try {
      var tex = m.textures && m.textures.get("MenuIcons");
      if (!tex || !tex.has || !tex.has(CFG.icon + "_out")) { st.reason = "MenuIcons 圖集沒有 " + CFG.icon + "_out"; return false; }
    } catch (e) { st.reason = "讀不到 MenuIcons 圖集"; return false; }
    return true;
  }

  /** 一顆跟選單鈕同類別、同一張 surrender 圖示的鈕。click 由呼叫端掛。 */
  function makeButton(st, m, Ctor) {
    if (typeof Ctor !== "function") { st.reason = "選單鈕的類別拿不到"; return null; }
    if (!iconOk(st, m)) return null;
    var btn = new Ctor(m, 0, 0, CFG.icon);
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

  // ---- 對人戰 ----------------------------------------------------------------
  /**
   * 官方確認框按 ok 之後送的就是這一個；結果畫面等伺服器回 game_result 由場景自己畫
   * （「你投降了」框由 show_surrender_result 那層跳過）。
   */
  function surrenderNow(st, m) {
    playSe(m);
    closeMenu(m);
    if (!isPvp(m) || !m.socket || typeof m.socket.emit !== "function" || !m.room_id) return;
    st.skipRoom = m.room_id;
    m.socket.emit("surrender", m.room_id);
    st.surrenders++;
  }
  function toDirect(st, m, b) {
    if (typeof b.off !== "function" || typeof b.on !== "function") return;
    b.off("click");
    b.on("click", function () { surrenderNow(st, m); });
  }

  /** 官方「確認框 → ok 才送」那支。模組 id 每次改版會變，掃特徵字串、只 require 命中的那一個。 */
  function findConfirm() {
    var req = ulrWebpackRequire();
    if (req === null) return null;
    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (src.indexOf("surrender_confirm") === -1 || src.indexOf('emit("surrender"') === -1) continue;
      var mod;
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var v;
        try { v = mod[k]; } catch (e) { continue; }
        if (typeof v !== "function") continue;
        var s = String(v);
        if (s.indexOf("surrender_confirm") !== -1 && s.indexOf('emit("surrender"') !== -1) return v;
      }
    }
    return null;
  }
  function confirmFn(st) {
    if (st.confirm === null && Date.now() >= st.nextFind) {
      st.nextFind = Date.now() + CFG.findEveryMs;
      try { st.confirm = findConfirm(); } catch (e) { st.confirm = null; }
    }
    return st.confirm;
  }

  // ---- 鈕放外面 ----------------------------------------------------------------
  function dropOutside(st) {
    try { if (alive(st.out)) st.out.destroy(); } catch (e) {}
    st.out = null;
    st.outFor = null;
    st.outKind = null;
  }
  function outsideClick(st, m, kind) {
    if (window[FLAG] !== st) return;
    if (kind === "raid") { playSe(m); closeMenu(m); leave(st, m); return; }
    if (st.opts.dietNoConfirm && dietDuel(m)) { surrenderNow(st, m); return; }
    var fn = confirmFn(st);
    if (fn === null || !isPvp(m)) return;
    playSe(m);
    closeMenu(m);
    try { Promise.resolve(fn(m)).catch(function (e) { st.reason = String((e && e.message) || e); }); }
    catch (e) { st.reason = String((e && e.message) || e); }
  }
  /** MENU 正下方那顆：渦戰是我們那顆、對人戰走官方確認；結束了、不在對戰裡就收。 */
  function syncOutside(st, m) {
    var mb = st.opts.outside && running(m) && alive(m.menu_button) ? m.menu_button : null;
    var kind = null;
    if (mb !== null) {
      if (isRaid(m)) kind = iconOk(st, m) ? "raid" : null;
      else if (isPvp(m)) kind = confirmFn(st) !== null ? "pvp" : null;
    }
    if (kind === null) { if (st.out !== null) dropOutside(st); return; }
    if (alive(st.out) && st.outFor === mb && st.outKind === kind) return;
    dropOutside(st);
    var Ctor = Object.getPrototypeOf(mb).constructor;
    var b = new Ctor(m, mb.x, mb.y + CFG.outsideDy, CFG.icon);
    if (typeof b.setDepth === "function") b.setDepth(mb.depth);
    b.on("click", function () { outsideClick(st, m, kind); });
    st.out = b;
    st.outFor = mb;
    st.outKind = kind;
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      var m = G ? G.scene.keys.MainA : null;
      if (!m) return;
      hook(st, m);
      syncOutside(st, m);
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
    unhook: null,
    opts: { dietNoConfirm: CFG.dietNoConfirm === true, outside: CFG.outside === true },
    confirm: null,
    nextFind: 0,
    out: null,
    outFor: null,
    outKind: null,
    surrenders: 0,
    skipRoom: null,
    surrenderResult: null,
    resultSkip: null,
    autoOks: 0
  };
  st.unhook = function () { unhook(st); dropOutside(st); };
  st.setOptions = function (o) {
    st.opts = { dietNoConfirm: o.dietNoConfirm === true, outside: o.outside === true };
    tick();
  };
  st.report = function () {
    return {
      installed: true,
      version: st.version,
      mounted: isRaid(st.scene),
      dietNoConfirm: st.opts.dietNoConfirm,
      outside: st.opts.outside,
      outsideShown: alive(st.out),
      reason: st.reason
    };
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify(st.report());
})()`;
}

export const RAID_SURRENDER_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, mounted: false, reason: null });
    if (typeof st.report === "function") return JSON.stringify(st.report());
    // 舊版（沒有 report）：版本號對不上，呼叫端會整支重裝
    return JSON.stringify({ installed: true, version: st.version, mounted: false, reason: st.reason });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, mounted: false,
      reason: String((e && e.message) || e)
    });
  }
})()`;

/**
 * 換投降的兩個開關，當場生效（外面那顆下一輪就畫上或拆掉；MENU 下次打開照新的）。
 * 回 `"ok"` 或 `"not-installed"`（頁面上是沒有 setOptions 的舊版也算）。
 */
export function buildRaidSurrenderSetOptionsExpression(options: BattleSurrenderOptions): string {
  const o = { dietNoConfirm: options.dietNoConfirm, outside: options.outside };
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.setOptions !== "function") return "not-installed";
    st.setOptions(${JSON.stringify(o)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 拆掉：menu_buttons 還原成資料屬性、外面那顆拆掉。插件關掉就該什麼都不留。 */
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
      dietNoConfirm: false,
      outside: false,
      outsideShown: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    mounted: o.mounted === true,
    dietNoConfirm: o.dietNoConfirm === true,
    outside: o.outside === true,
    outsideShown: o.outsideShown === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
