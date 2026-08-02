/**
 * 即時看遊戲的 WebSocket 事件（WP-09 的最小形態）
 * ================================================
 * 牌譜、未出現手牌、移動階段仲裁、實況轉播 —— 四個戰鬥功能全部靠這一層。
 * 這個檔案先做「只看不動」的版本：把事件名與時間戳撈出來，不改任何行為。
 *
 * 兩條路（open-questions §4 已實測，這裡直接用）：
 *
 *     送出   換掉 WSClient.prototype.emit —— 原型未凍結，6 條連線共用同一份，
 *            patch 一次全包
 *     收到   對每個實例掛 onAny —— 不必 patch
 *
 * ⚠ **跟 patch-cost 不同，這支用 `Runtime.evaluate` 裝，不需要 reload。**
 * cc_asset 必須搶在載入前攔截，所以那邊非得用
 * `addScriptToEvaluateOnNewDocument` 不可。這裡不一樣：WSClient 的原型與實例
 * 在遊戲跑起來之後一直都在，隨時掛得上去。這個差別很重要 —— 它讓插件可以在
 * **玩家正在對戰時**接上來看，而不必先把人踢出戰鬥。
 *
 * §12 的處理：**只回報事件名、參數的「形狀」與時間戳，永遠不回報值。**
 *
 *   - `db_deck1/2/3` 送出時 `args[0]` 是 session token（constants.ts 有註記），
 *     回報成 `str(32)` 就不會外洩
 *   - 收到的封包可能含對手手牌這類隱藏資訊，§12 明訂不得顯示或上傳
 *
 * 物件只列**鍵**不列值。鍵是結構（正是我們要建的事件目錄需要的東西），
 * 值才是機密。這樣「安全」是由這一層的形狀保證的，不是靠呼叫端自律。
 */

import { WS_CLIENT } from "./constants.js";
import { embedJson } from "./embed.js";

export interface WsWatchOptions {
  /** 頁面呼叫這個名字把事件送回 Node。由 `Runtime.addBinding` 建立。 */
  bindingName: string;
  /**
   * 物件最多列幾個鍵。列太多會把終端機洗掉，而且長事件的鍵大多重複。
   */
  maxKeys?: number;
  /**
   * 多久重掃一次有沒有新的連線。
   *
   * 遊戲同時開 6 條（任務／對戰／獎勵／玩家／頻道／結算），而且不是一次
   * 建好 —— 進對戰房才會多一條。掛上去之後就不管的話會漏掉後來的。
   */
  rescanIntervalMs?: number;
  /**
   * 這些事件的**數字與布林會連值一起回報**。預設 `DEFAULT_VALUE_EVENTS`。
   *
   * ⚠ **超過 `VALUE_MAX_STRING_LENGTH` 的字串永遠只有長度**，不受這個清單
   * 影響。這條是硬規則不是預設值 —— session token（`str(32)`）與 match id
   * （`str(36)`）都是字串，§12 明訂不得記錄。
   *
   * 為什麼要有這個東西：光看形狀答不出「正骰率是不是 1/3」「扣了幾滴血」
   * 這種問題 —— 那些**就是**值。但也不能全開，因為有些數字是隱藏資訊
   * （見 `DEFAULT_VALUE_EVENTS` 的說明）。
   */
  valueEvents?: readonly string[];
}

export const DEFAULT_MAX_KEYS = 12;
export const DEFAULT_RESCAN_INTERVAL_MS = 2_000;

/** 巢狀物件挖多深。太深會把整個 chara 物件搬回 Node。 */
export const VALUE_MAX_DEPTH = 3;

/**
 * 允許取值的字串長度上限。**超過就只給長度，任何允許清單都覆蓋不了。**
 *
 * 這個數字是有意義的，不是隨手挑的：
 *
 *     session token   str(32)    ← 必須擋掉
 *     match / room id str(36)    ← 必須擋掉
 *     移動選擇        str(4~6)   ← 前進／後退／待機／換角，要取得到
 *     階段名          str(4~8)
 *     技能效果名      str(17)
 *
 * 24 剛好把上面兩類分開。判準是**機密是長而高熵的，列舉標籤是短的** ——
 * 而這道上限在 `move_select` 身上真的在做事：它的送出格式是
 * `str(32) str(36) str(4)`，同一則裡既有 token 也有我們要的選擇。
 */
export const VALUE_MAX_STRING_LENGTH = 24;

/**
 * 預設允許取值的事件 —— **只有雙方在畫面上都看得到的東西**。
 *
 * 判準不是「這個數字有沒有用」，是「對手知不知道」。§12 禁止使用隱藏資訊，
 * 而且是硬規則：即使封包裡有，也不得顯示或上傳。
 *
 * ❌ **刻意不在清單裡的**，每個都有具體理由：
 *
 *   - `cardclickedA` / `cardclickedB` —— 移動階段的牌是**蓋著的**，
 *     要到 `cardOpen_X` 才翻開。那個 `num` 在翻牌前就是隱藏資訊。
 *     （出牌／收牌的區分很可能在那兩個 bool 裡，但拿不到就是拿不到 ——
 *     要解那題得另外想只取 bool、不取 num 的辦法。）
 *   - `chara_A` / `chara_B` / `charachange_X` —— 物件很大（每則 3 個），
 *     而且裡面有 `known` 欄位，暗示遊戲自己在追蹤「哪些資訊已公開」。
 *     在搞清楚那個欄位的語意之前不碰。
 *   - `drawPhase` —— 抽到什麼牌是自己的私有資訊，記了對牌譜有用，
 *     但那要等有「只記我方」的座位判斷之後再開。
 */
export const DEFAULT_VALUE_EVENTS: readonly string[] = [
  // 擲骰：atkArr/defArr 是骰面、atkSuc/defSuc 是正骰數。雙方都看得到結果。
  "diceRoll",
  // 傷害與治療：畫面上就有數字
  "dmgToA",
  "dmgToB",
  "healA",
  "healB",
  // 場面狀態
  "distance",
  "movepower",
  "atkvalue",
  "playerAtkA",
  "playerAtkB",
  "playerDefA",
  "playerDefB",
  "bonus",
  "endTurn",
  "endDefensePhase",
  // 狀態效果與技能：都會顯示在角色身上
  "state",
  "skillbase",
  "passivebase",
  // 翻牌 —— 這是「公開」這件事本身
  "cardOpen_A",
  "cardOpen_B",
  // 移動選擇（前進／後退／待機／換角）。送出側同名，一併涵蓋。
  // 送出格式是 str(32) str(36) str(4) —— token 與 match id 靠長度上限擋掉。
  "move_select",
  "endMovePhase",
  "endPhase",
  "phaselabel_A",
  "phaselabel_B",
  // 換角
  "change_A",
  "change_B",
  "changeReady",
  // 技能與訊息（都是會顯示在畫面上的名稱）
  "skill_effect_A",
  "skill_effect_B",
  "msg_skill",
  // 獎勵階段：盤面與擲骰，戰鬥已經結束，沒有隱藏資訊可言
  "db_bonusgame",
  "bonusgame",
  "throwResultDice",
  "resultSuccess",
  "bonus_end",
];

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

export type WsDirection = "in" | "out";

export interface WsEventReport {
  type: "ws-event";
  dir: WsDirection;
  /** 事件名。 */
  event: string;
  /**
   * 每個參數的形狀，**不是值**。例：`["obj{chara,charaIndex,level}", "num"]`
   *
   * §12：這裡永遠不會出現實際內容。看形狀就足以建事件目錄。
   */
  shape: string[];
  /** 頁面上的 `Date.now()`。用頁面的時鐘，跟遊戲事件同一個時間軸。 */
  at: number;
}

export interface WsWatchInstalled {
  type: "ws-watch-installed";
  /** 送出側的原型 patch 成功了沒。 */
  emitPatched: boolean;
  /** 掛上 onAny 的連線數。 */
  sockets: number;
}

export interface WsWatchError {
  type: "ws-watch-error";
  reason: string;
}

export type WsWatchReport = WsEventReport | WsWatchInstalled | WsWatchError;

const REPORT_TYPES = new Set(["ws-event", "ws-watch-installed", "ws-watch-error"]);

/** 判斷一則 binding 回報是不是這個模組發的。頁面上可能有別的 binding。 */
export function isWsWatchReport(value: unknown): value is WsWatchReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

// ---------------------------------------------------------------------------
// 產生注入腳本
// ---------------------------------------------------------------------------

/**
 * 產生要在遊戲 context 裡求值的 JS。純函式，可以完整測試，不需要活著的遊戲。
 *
 * 回傳值是一句 IIFE，求值後會回傳一個狀態字串給呼叫端（`already` / `ok` /
 * `no-socket`），這樣 `installWsWatch()` 不必等 binding 就知道有沒有掛上。
 */
export function buildWsWatchScript(options: WsWatchOptions): string {
  const config = {
    bindingName: options.bindingName,
    maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
    rescanIntervalMs: options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS,
    valueEvents: options.valueEvents ?? DEFAULT_VALUE_EVENTS,
    maxDepth: VALUE_MAX_DEPTH,
    maxStr: VALUE_MAX_STRING_LENGTH,
    // 從常數帶進來，不寫死在腳本裡 —— 遊戲改版換路徑時只要改 constants.ts。
    instancePath: WS_CLIENT.instancePath,
    sendMethod: WS_CLIENT.sendMethod,
    listenAllMethod: WS_CLIENT.listenAllMethod,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = "__ulrWsWatch";
  var WATCHED = "__ulrWsWatched";
  var PATCHED = "__ulrWsEmitPatched";
  var has = Object.prototype.hasOwnProperty;

  // 重複求值（重連、玩家按兩次）不能把 emit 疊好幾層 —— 那會讓每個送出的
  // 事件被回報 N 次，而牌譜靠的就是次數。
  //
  // 但也不能單純早退：呼叫端可能是想**換設定**（例如把某個事件加進取值
  // 允許清單）。設定放在 window[FLAG] 上、handler 每次都重新去讀，
  // 就能只換設定不動 patch。
  //
  // ⚠ handler 一定要走 window[FLAG] 取設定，不可以用閉包變數 —— 重新求值時
  // 跑的是**新的**閉包，舊 handler 抓著的還是舊的那份，設定永遠換不掉。
  if (window[FLAG]) {
    window[FLAG].cfg = CFG;
    window[FLAG].valueEvents = buildValueSet(CFG.valueEvents);
    return "updated";
  }

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲（CONTRIBUTING §9.1）。
    }
  }

  function buildValueSet(list) {
    var set = {};
    for (var vi = 0; vi < list.length; vi++) set[list[vi]] = true;
    return set;
  }

  /** 目前生效的設定。永遠從 window[FLAG] 取，理由見上面的閘。 */
  function live() {
    return window[FLAG] || { cfg: CFG, valueEvents: buildValueSet(CFG.valueEvents) };
  }

  /**
   * 把一個值描述成字串。
   *
   * withValues 為假（預設）時**只看結構，不看內容** —— 物件列鍵不列值、
   * 字串只給長度、數字只說是數字。事件目錄需要的是結構，機密的是值。
   *
   * 為真（該事件在允許清單裡）時才會帶出數字、布林與**短**字串。
   *
   * ⚠ 長字串的上限**不受 withValues 影響**，那是硬規則：token 與 match id
   * 都是字串，一旦讓允許清單能覆蓋它，這條界線就形同虛設。
   *
   * （這段註解裡不能用反引號 —— 整個腳本是 TS 的樣板字串。）
   */
  function shapeOf(v, withValues, depth) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    var t = typeof v;

    if (t === "string") {
      // 這一行是整個檔案裡最重要的一行。
      if (withValues && v.length <= CFG.maxStr) return JSON.stringify(v);
      return "str(" + v.length + ")";
    }
    if (t === "number") return withValues ? String(v) : "num";
    if (t === "boolean") return withValues ? String(v) : "bool";
    if (t === "function") return "fn";

    var d = depth || 0;
    if (Array.isArray(v)) {
      if (!withValues || d >= CFG.maxDepth) return "arr(" + v.length + ")";
      var items = [];
      for (var i = 0; i < v.length && i < 32; i++) items.push(shapeOf(v[i], true, d + 1));
      if (v.length > 32) items.push("…");
      return "[" + items.join(",") + "]";
    }
    if (t !== "object") return t;

    var parts = [];
    try {
      for (var k in v) {
        if (!has.call(v, k)) continue;
        if (parts.length >= CFG.maxKeys) { parts.push("…"); break; }
        parts.push(
          withValues && d < CFG.maxDepth ? k + ":" + shapeOf(v[k], true, d + 1) : k
        );
      }
    } catch (e) {
      return "obj(?)";
    }
    return "obj{" + parts.join(",") + "}";
  }

  function shapesFrom(argsLike, from, withValues) {
    var out = [];
    for (var i = from; i < argsLike.length; i++) {
      out.push(shapeOf(argsLike[i], withValues, 0));
    }
    return out;
  }

  /**
   * 描述一則事件並回報。
   *
   * 取值與否在**這裡**決定，而且是從 live() 讀的 —— 這樣熱更新設定之後，
   * 早就掛好的 handler 也會立刻改用新的允許清單。
   */
  function emitEvent(dir, name, argsLike, from) {
    var st = live();
    var withValues = !!st.valueEvents[String(name)];
    // shapeOf 讀 CFG，所以要把生效的那份塞回同名變數可見的位置。
    CFG = st.cfg;
    report({
      type: "ws-event",
      dir: dir,
      event: String(name),
      shape: shapesFrom(argsLike, from, withValues),
      at: Date.now()
    });
  }

  // -------------------------------------------------------------------------
  // 找出所有連線
  // -------------------------------------------------------------------------

  /**
   * 遊戲把 WSClient 掛在場景上（已知一條是 ${WS_CLIENT.instancePath}）。
   * 掃過所有場景收集，而不是只認那一條 —— 對戰／獎勵／結算各有各的連線，
   * 只看已知路徑會漏掉一大半事件。
   */
  function findSockets() {
    var out = [];
    try {
      var game = window.game;
      var keys = game && game.scene && game.scene.keys;
      if (!keys) return out;
      for (var k in keys) {
        if (!has.call(keys, k)) continue;
        var scene = keys[k];
        if (!scene) continue;
        var s = scene.socket;
        if (!s || typeof s[CFG.listenAllMethod] !== "function") continue;
        if (out.indexOf(s) === -1) out.push(s);
      }
    } catch (e) {
      // 場景還沒建好就會走到這裡。下一次重掃會補上。
    }
    return out;
  }

  function watchSocket(s) {
    if (s[WATCHED]) return false;
    try {
      s[CFG.listenAllMethod](function (name) {
        try {
          emitEvent("in", name, arguments, 1);
        } catch (e) {
          // 單一事件描述失敗不能讓監聽器死掉。
        }
      });
      s[WATCHED] = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 送出側只要 patch 一次原型就全包 —— 6 條連線共用同一份原型
   * （open-questions §4 實測）。
   */
  function patchEmit(proto) {
    if (proto[PATCHED]) return false;
    var original = proto[CFG.sendMethod];
    if (typeof original !== "function") return false;

    proto[CFG.sendMethod] = function (name) {
      // 先讓遊戲把事情做完，再做我們的 —— 我們炸掉時遊戲狀態仍然完整
      // （跟 patch-cost.ts 同一條規則）。
      var result = original.apply(this, arguments);
      try {
        emitEvent("out", name, arguments, 1);
      } catch (e) {
        // 同上。
      }
      return result;
    };
    proto[PATCHED] = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // 裝上去
  // -------------------------------------------------------------------------

  var sockets = findSockets();
  if (sockets.length === 0) {
    // 還沒進遊戲、或還沒建好連線。不要留下 FLAG —— 呼叫端等一下重試就好。
    return "no-socket";
  }

  window[FLAG] = {
    sockets: 0,
    emitPatched: false,
    cfg: CFG,
    valueEvents: buildValueSet(CFG.valueEvents)
  };

  var emitPatched = false;
  try {
    emitPatched = patchEmit(Object.getPrototypeOf(sockets[0]));
  } catch (e) {
    report({ type: "ws-watch-error", reason: "patch emit 失敗：" + String((e && e.message) || e) });
  }

  var watched = 0;
  for (var i = 0; i < sockets.length; i++) if (watchSocket(sockets[i])) watched++;

  window[FLAG].sockets = watched;
  window[FLAG].emitPatched = emitPatched;

  // 進對戰房之後才會多開連線，所以要持續補掛。
  window[FLAG].timer = setInterval(function () {
    try {
      var found = findSockets();
      for (var j = 0; j < found.length; j++) {
        if (watchSocket(found[j])) window[FLAG].sockets++;
      }
    } catch (e) {
      // 重掃失敗不影響已經掛上的。
    }
  }, CFG.rescanIntervalMs);

  // 讓呼叫端可以收手。不提供的話唯一的停法是重載遊戲。
  window[FLAG].stop = function () {
    try { clearInterval(window[FLAG].timer); } catch (e) {}
  };

  report({ type: "ws-watch-installed", emitPatched: emitPatched, sockets: watched });
  return "ok";
})();`;
}
