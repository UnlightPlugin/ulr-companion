/**
 * 在迪特赫姆重現亞歷山卓城的快速比賽
 * ====================================
 * 迪城（duel 頻道）只有「創建對戰室」，亞城（ranked 頻道）有「快速比賽」與
 * 「COST54:N 位玩家等待中」。差別不是介面偷懶，是**伺服器那邊只有 ranked 頻道
 * 有佇列**（`quick_wait` 只在 ranked 有，而且用原版 COST 分檔）——
 * 見 docs/match-making.md §1。
 *
 * 這支把那兩樣東西補回迪城，資料來源換成插件自己的中間人：
 *
 * ```
 *   亞城（官方）                        迪城（這支）
 *   ────────────────────────────        ──────────────────────────────
 *   quick_btn  → emit quick_wait        我們畫的按鈕 → 插件的自動配對
 *   channel_players 推播 → 4 行人數     中間人的佇列人數 → 同樣的 4 行
 *   match_room_error fail:7 → 對話框    同一個對話框、同一句話
 * ```
 *
 * ## 三個「照抄」，一個都不能自己發明
 *
 * 1. **按鈕用遊戲自己的類別與貼圖。** `match_quick_btn` 在迪城的客戶端也載得到
 *    （2026-08-18 實測，frames 有 `tcn_1`/`tcn_2`），所以按鈕跟亞城那顆長得
 *    一模一樣 —— 自己畫一顆會馬上被看出是外掛的東西。類別是從
 *    `channel_panel.room_btn` 的 prototype 取的（模組外面拿不到那個 class）。
 * 2. **人數那幾行用遊戲自己的模板**（`PLAYER_COUNT[lang][1]`）。它長這樣：
 *    `COST__COST1__:__LENGTH1__位玩家等待中。\n…`，我們只把數字填進去。
 *    自己組字串的話換語言就會露出繁中。
 * 3. **牌組不合規則那句話是 `room_error[lang][7]`**（「這個牌組不符合遊戲規則」），
 *    對話框是遊戲自己的那個類別。整段流程照抄 `Match.room_quick()` 的失敗分支：
 *    白色半透明遮罩 + zone 擋點擊 + 對話框 depth 500 + `ulse01` 音效。
 *
 * ## ⚠ 這支不會替玩家操作遊戲
 *
 * 它只是**畫一顆按鈕**並把「玩家按了」回報給 Node。真正會開房、消耗 AP 的是
 * `match-room.ts`，而那條路徑的前提沒有變：**玩家親手按下去**。
 * 一顆畫在遊戲裡的按鈕跟托盤上那顆在這件事上是同一種東西。
 *
 * ## ⚠ 面板是**每次進頻道重新 new 的**
 *
 * `Match.create()` 裡 `this.channel_panel = new k(this)` —— 玩家每換一次頻道
 * 就是一個新物件，我們掛上去的東西會跟著舊物件一起被 destroy。所以這支用
 * 輪詢盯著 `sc.channel_panel` 換人沒有（500ms），換了就重掛一次。
 *
 * ⚠ **不能只在安裝時掛一次**：那樣玩家第一次進頻道（安裝時他多半還在選頻道
 * 的畫面）就看不到按鈕，而症狀是「這功能對我沒作用」。
 */

import { embedJson } from "./embed.js";

/** 一檔的等待人數。`tier` 是那一檔的上限（54、61、77），開口檔則是下限（90）。 */
export interface LobbyTierCount {
  tier: number;
  waiting: number;
  /** 這是 `COST90+` 那一檔嗎。⚠ 最多一個，而且一定排在最後。 */
  open?: boolean;
}

/** Node 推給頁面的狀態。**畫面上的每一個字都由這裡決定。** */
export interface LobbyState {
  /**
   * 各檔的等待人數。`null` = 還不知道（例如中間人連不上）。
   *
   * ⚠ **`null` 與 `[]` 是兩件事**：不知道的時候那幾行要**整個不畫**，
   * 不能畫成「0 位玩家等待中」—— 那是一句假話，而玩家會照它決定要不要排隊。
   */
  counts: LobbyTierCount[] | null;
  /**
   * 正在配對嗎。`true` = 跳出**遊戲自己的等待視窗**（面板 + 逐字波浪 +
   * MM:SS + cancel 鈕），`false` = 收掉它。
   *
   * ⚠ **配對狀態不寫成 INFO 區的一行字。** 亞城按下快速比賽之後跳的就是那個
   * 視窗，而這整個功能的目的就是讓迪城跟那邊一樣 —— 一行小字跟一個會計時的
   * 視窗，在「我到底在不在排隊」這件事上完全不是同一個東西。
   */
  matching: boolean;
}

export interface LobbyPatchOptions {
  /** 頁面呼叫這個名字把「玩家按了按鈕」送回 Node。 */
  bindingName: string;
  /** 盯著 `channel_panel` 換人沒有的間隔。 */
  pollIntervalMs?: number;
}

export const DEFAULT_LOBBY_POLL_MS = 500;

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * ⚠ 這支跟 `patch-stage` 一樣是「先拆再裝」，所以不靠版本號決定要不要重裝；
 * 版本號是回報用的 —— 玩家回報怪狀況時一眼看得出他頁面上跑的是哪一版。
 */
export const LOBBY_SCRIPT_VERSION = 3;

const FLAG = "__ulrLobby";

/**
 * 面板中線讀不到時，退回「貼在創建對戰室左邊」的舊算法要留幾 px。
 *
 * ⚠ 這是**後路**，不是正常位置。正常位置見 `panelMidX()`。
 */
const BUTTON_GAP = 10;

export interface LobbyStatus {
  installed: boolean;
  version: number | null;
  /** 目前掛在哪個頻道的面板上。`null` = 沒掛（不在頻道裡，或那是 ranked 面板）。 */
  channel: number | null;
  /**
   * 開口檔（`COST90+`）的下限，**從遊戲自己的模板讀出來的**。
   *
   * ⚠ Node 端要拿它當第四條佇列的鍵，所以**不要在插件裡寫死 90** ——
   * 官方改了那個數字而我們沒跟上時，症狀是兩邊排在不同的佇列上，
   * 而兩個畫面都寫著「排隊中」。`null` = 還沒掛上面板，讀不到。
   */
  openTier: number | null;
  /** 按鈕真的畫出來了沒。 */
  buttonReady: boolean;
  /** 還在等玩家進頻道。**不是錯誤**（見 `patch-stage` 同一個欄位）。 */
  waiting: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

/** 玩家按了那顆按鈕。⚠ 這會一路走到開房，所以**只有真的點擊才會發**。 */
export interface LobbyQuickPressed {
  type: "lobby-quick";
  /** 按下去的當下他在哪個頻道。Node 不要自己再猜一次。 */
  channel: number | null;
  /** 按下去的當下畫面顯示的是「取消」嗎。 */
  matching: boolean;
}

export interface LobbyPatchError {
  type: "lobby-error";
  reason: string;
}

export type LobbyReport = LobbyQuickPressed | LobbyPatchError;

const REPORT_TYPES = new Set(["lobby-quick", "lobby-error"]);

export function isLobbyReport(value: unknown): value is LobbyReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

// ---------------------------------------------------------------------------
// 頁面端共用的那幾支
// ---------------------------------------------------------------------------

const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  function matchScene() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys.Match) || null;
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  /**
   * 這個頻道是不是 duel（迪特赫姆／布萊德克洛伊茲）。
   *
   * ⚠ **要看 type，不要寫死頻道編號。** 官方哪天多開一組頻道，寫死 2/4 的版本
   * 會把按鈕畫到一個 ranked 面板上（那裡已經有官方的快速比賽了）。
   */
  function duelChannel(sc) {
    if (sc === null || sc.channel === undefined || sc.channel === null) return false;
    var key = String(sc.channel);
    var a = sc.channels && sc.channels[key];
    var b = sc.channels_cross && sc.channels_cross[key];
    var info = a || b;
    return !!(info && info.type === "duel");
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 */
export function buildLobbyPatchScript(options: LobbyPatchOptions): string {
  const config = {
    bindingName: options.bindingName,
    version: LOBBY_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_LOBBY_POLL_MS,
    buttonGap: BUTTON_GAP,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  ${SHARED}

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲。
    }
  }

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    detach(st);
    delete window[FLAG];
  }

  function detach(st) {
    // ⚠ 等待視窗也要收。它掛在**場景**上而不是面板上（原版也是這樣），所以
    // 換頻道時面板被 destroy 不會把它帶走 —— 留著的話玩家會看到一個關不掉的框。
    try { hideWaiting(); } catch (e) {}
    // ⚠⚠ **拆的是 st.mine（我們加過的每一個東西），不是幾個具名欄位。**
    //
    // 這支是「先拆再裝」的，而拆的時候手上那個 st 可能是**上一版腳本**留下的
    // —— 它的欄位跟這一版不一樣。2026-08-18 實測踩到：舊版有一個 statusText，
    // 新版沒有那一格，於是那行字永遠留在面板上，看起來像功能壞掉。
    // 具名欄位仍然照拆（舊版沒有 mine 這一格）。
    var items = (st.mine || []).concat([st.button, st.countsText, st.statusText]);
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    st.mine = [];
    st.button = null;
    st.countsText = null;
    st.panel = null;
    st.channel = null;
    st.openTier = null;
  }

  /**
   * 遊戲自己的「確認」對話框類別。
   *
   * 它是模組內的區域變數（Match.room_quick() 裡的 new o.Cw(...)），從場景上
   * 拿不到 —— 只能從 webpack 的模組登錄表撈。找法是「extends Container 而且
   * 原始碼裡有 ok_button 與 panel_gene」，比記住模組 id 耐改版得多。
   *
   * ⚠ 這段註解裡**不能出現反引號** —— 整支腳本住在一個 template literal 裡，
   * 一個沒跳脫的反引號會讓字串提早結束（match-room.ts 也記過同一件事）。
   *
   * ⚠ 找到就快取起來。掃 650 個模組要幾十毫秒，而這支可能在玩家按下去的
   * 那一刻被叫到。
   */
  function uiKit() {
    var st = window[FLAG];
    if (st && st.kit) return st.kit;

    var chunkKey = null;
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      if (/webpack/i.test(keys[i]) && Array.isArray(window[keys[i]])) { chunkKey = keys[i]; break; }
    }
    if (chunkKey === null) return null;

    // ⚠ **每次都要用不一樣的 chunk id。** webpack 5 的 jsonp callback 只在
    // 「這些 id 至少有一個沒安裝過」時才會叫 runtime 回呼 —— 推第二次同一個 id
    // 會安靜地什麼都拿不到（patch-penalty 的檔頭記過這個坑）。
    window.__ulrChunkSeq = (window.__ulrChunkSeq || 0) + 1;
    var req = null;
    try {
      window[chunkKey].push([["__ulr_lobby_" + window.__ulrChunkSeq], {}, function (r) { req = r; }]);
    } catch (e) { return null; }
    if (typeof req !== "function" || !req.m) return null;

    var ids = Object.keys(req.m);
    for (var j = 0; j < ids.length; j++) {
      var mod;
      try { mod = req(ids[j]); } catch (e) { continue; }
      if (!mod) continue;

      var kit = { dialog: null, button: null, labels: null };
      for (var k in mod) {
        var v;
        try { v = mod[k]; } catch (e) { continue; }
        if (v === null || v === undefined) continue;

        // 常數表：認 CANCEL_BUTTON 這個鍵（那是物件的屬性名，不會被壓縮）。
        if (typeof v === "object" && v.CANCEL_BUTTON && v.OK_BUTTON) { kit.labels = v; continue; }
        if (typeof v !== "function") continue;

        var src;
        try { src = String(v.toString()); } catch (e) { continue; }
        if (src.length > 3000) continue;
        // 確認對話框：有 ok_button 又有 panel_gene 的那個。
        if (src.indexOf("ok_button") !== -1 && src.indexOf("panel_gene") !== -1) kit.dialog = v;
        // 文字按鈕（ok / cancel 用的那個）：底圖是 btn_gene，全遊戲只有它。
        else if (src.indexOf("btn_gene") !== -1 && src.indexOf("setText") !== -1) kit.button = v;
      }
      if (kit.dialog !== null) {
        if (st) st.kit = kit;
        return kit;
      }
    }
    return null;
  }

  /**
   * 照抄 room_quick() 失敗時那一段：半透明白幕 + 擋點擊的 zone + 對話框。
   *
   * ⚠ 三個東西的 depth 要對：遮罩與 zone 是 499、對話框 500。差一層的話玩家
   * 點得到底下的房間列表，而對話框還開著。
   */
  function showDialog(message) {
    var sc = matchScene();
    if (sc === null) return "no-scene";
    var kit = uiKit();
    if (kit === null || kit.dialog === null) return "no-dialog-class";

    var w = sc.scale.width;
    var h = sc.scale.height;
    var zone = sc.add.zone(0, 0, w, h).setOrigin(0).setDepth(499).setInteractive();
    var veil = sc.add.rectangle(0, 0, w, h, 16777215, 0.6).setOrigin(0).setDepth(499);
    var dialog = new kit.dialog(sc, w / 2, h / 2, gameLang(), message).setDepth(500);
    dialog.ok_button.on("click", function () {
      // ⚠ 對話框自己會 destroy（它的 ok_button 綁著），但遮罩與 zone 是我們加的。
      try { zone.destroy(); } catch (e) {}
      try { veil.destroy(); } catch (e) {}
    });
    try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
    return "ok";
  }

  /**
   * 等待對手的視窗 —— **照抄遊戲自己那個**（Match 模組裡的 class S，
   * 亞城按下快速比賽之後跳的就是它）。
   *
   * 逐項對齊，因為玩家會把兩邊擺在一起看：
   *
   *   panel        nineslice("panel_gene", 0, 250, 150, 71, 40, 63, 32) 置中
   *   waiting_text WAIT_TEXT[lang] **一個字一個 text**，波浪式淡入（原版的做法）
   *   waiting_timer MM:SS，每秒 +1
   *   cancel       遊戲自己的文字按鈕，字是 ES.CANCEL_BUTTON[lang]
   *
   * ⚠ **那個類別在模組外面拿不到**（它跟 Match 場景同一個模組但沒被匯出），
   * 所以這裡是照它的原始碼重建，用的每一個素材與字串仍然是遊戲自己的。
   *
   * ⚠ 一個字一個 text 不是為了好看才抄的：原版的波浪動畫就是這樣做的，
   * 用一整串字去 tween 出來的效果完全不一樣。
   */
  function showWaiting() {
    var st = window[FLAG];
    if (st === undefined || st === null || st.wait !== null) return;
    var sc = matchScene();
    if (sc === null) return;
    var kit = uiKit();
    if (kit === null || kit.button === null) return;

    var lang = gameLang();
    var label = kit.labels && kit.labels.CANCEL_BUTTON ? kit.labels.CANCEL_BUTTON[lang] : "cancel";
    var message = waitText(sc, lang);
    var w = sc.scale.width;
    var h = sc.scale.height;
    var cx = w / 2;
    var cy = h / 2;
    var STYLE = { fontFamily: "font_light", fontSize: 15, resolution: 2 };

    // 擋點擊的 zone（原版的 room_quick 也是先鋪這個，depth 499）。
    var zone = sc.add.zone(0, 0, w, h).setOrigin(0).setDepth(499).setInteractive();
    var panel = sc.add.nineslice(cx, cy, "panel_gene", 0, 250, 150, 71, 40, 63, 32);

    // 一個字一個 text，先全部透明；下面那個 timer 會逐字 tween 進來。
    var letters = [];
    var total = 0;
    var i;
    for (i = 0; i < message.length; i++) {
      var t = sc.add.text(0, cy - 28, message.charAt(i), STYLE).setOrigin(0.5, 0.5).setAlpha(0);
      letters.push(t);
      total += t.width;
    }
    // ⚠ 原版是「先靠左排好再整排往右推到置中」（那個迴圈每次 +0.1）。這裡直接
    // 算出置中的位置 —— 畫面結果一樣，但不依賴那個寫死的 760。
    var x = cx - total / 2;
    for (i = 0; i < letters.length; i++) {
      letters[i].x = x + letters[i].width / 2;
      x += letters[i].width;
    }

    var timerText = sc.add.text(cx, cy + 10, "00:00", STYLE).setOrigin(0.5, 0.5);
    var cancel = new kit.button(sc, cx, cy + 40, label);

    var box = sc.add.container(0, 0);
    box.add([panel].concat(letters).concat([timerText, cancel]));
    box.setDepth(500);

    var seconds = 0;
    var counter = sc.time.addEvent({
      delay: 1000,
      repeat: -1,
      callback: function () {
        seconds++;
        var mm = String(Math.trunc(seconds / 60));
        var ss = String(seconds % 60);
        while (mm.length < 2) mm = "0" + mm;
        while (ss.length < 2) ss = "0" + ss;
        timerText.setText(mm + ":" + ss);
      }
    });
    // 波浪：每個字晚 100ms 起跳，跑完一輪停一下再來（原版的參數照抄）。
    var wave = sc.time.addEvent({
      delay: 1000,
      callback: function () {
        for (var n = 0; n < letters.length; n++) {
          sc.add.tween({
            targets: letters[n], y: "+=8", alpha: 1, duration: 300, yoyo: true,
            repeat: -1, delay: 100 * n, hold: 100 * letters.length + 1000,
            repeatDelay: 100 * letters.length - 500
          });
        }
      }
    });

    cancel.on("click", function () {
      // ⚠ 走跟按鈕同一條回報：Node 那邊「已經在配對中就是停止」，兩個入口
      // 因此永遠不會有兩套邏輯。
      report({ type: "lobby-quick", channel: sc.channel === undefined ? null : sc.channel,
               matching: true });
    });

    st.wait = { box: box, zone: zone, letters: letters, counter: counter, wave: wave };
  }

  function hideWaiting() {
    var st = window[FLAG];
    if (st === undefined || st === null || st.wait === null) return;
    var sc = matchScene();
    var wait = st.wait;
    st.wait = null;
    // ⚠ 兩個 timer 一定要收 —— 原版的 destroy() 做的就是這件事。不收的話
    // 視窗關了計時器還在跑，而它抓著已經 destroy 的 text。
    try { wait.counter.remove(); } catch (e) {}
    try { wait.wave.remove(); } catch (e) {}
    try {
      if (sc !== null) {
        for (var i = 0; i < wait.letters.length; i++) sc.tweens.killTweensOf(wait.letters[i]);
      }
    } catch (e) {}
    try { wait.box.destroy(); } catch (e) {}
    try { wait.zone.destroy(); } catch (e) {}
  }

  /** 「正在等待對手加入…」—— 遊戲自己那句（Match.WAIT_TEXT）。 */
  function waitText(sc, lang) {
    try {
      var table = sc.constructor && sc.constructor.WAIT_TEXT;
      var text = table && table[lang];
      if (typeof text === "string" && text.length > 0) return text;
    } catch (e) {}
    return "...";
  }

  /** 亞城那幾行的模板 —— PLAYER_COUNT[lang][1]。拿不到就回 null。 */
  function countsTemplate(panel) {
    try {
      var base = Object.getPrototypeOf(panel.constructor);
      var t = base && base.PLAYER_COUNT && base.PLAYER_COUNT[gameLang()];
      return t && t.length > 1 ? t[1] : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 把人數填進遊戲自己的模板。
   *
   * ⚠ 模板寫死 3 個有上限的檔（__COST1~3__）加一個開口檔 —— 那一行的
   * COST90+ 是寫死的字，只有數字是變數（__LENGTH4__）。我們照著填：
   * 前三個是從客戶端現讀的檔位，第四個是開口檔。
   *
   * ⚠ **沒有開口檔的資料時整行拿掉，不要填 0** —— 一條不存在的佇列永遠是
   * 0 個人，而玩家會把它讀成「那一檔沒人排」。
   */
  function renderCounts(panel, counts) {
    if (counts === null || counts.length === 0) return "";
    var tpl = countsTemplate(panel);
    var open = null;
    var band = [];
    for (var n = 0; n < counts.length; n++) {
      if (counts[n].open === true) open = counts[n];
      else band.push(counts[n]);
    }

    if (tpl !== null && band.length >= 3) {
      var out = tpl;
      for (var i = 0; i < 3; i++) {
        out = out.replace("__COST" + (i + 1) + "__", String(band[i].tier));
        out = out.replace("__LENGTH" + (i + 1) + "__", String(band[i].waiting));
      }
      if (open !== null) return out.replace("__LENGTH4__", String(open.waiting));
      // ⚠ 吃掉的是「換行 + 那一整行」。留著沒填的 __LENGTH4__ 會讓玩家在畫面上
      // 看到一串佔位符。
      return out.replace(/\\n?COST[0-9]+\\+:__LENGTH4__[^\\n]*/, "");
    }

    // 模板拿不到（改版了？）→ 自己組，格式照抄那一行。
    var lines = [];
    for (var j = 0; j < counts.length; j++) {
      var label = "COST" + counts[j].tier + (counts[j].open === true ? "+" : "");
      lines.push(label + ":" + counts[j].waiting + "位玩家等待中。");
    }
    return lines.join("\\n");
  }

  /**
   * 開口檔的下限 —— 從遊戲自己的模板裡那個 COST90+ 讀出來。
   *
   * ⚠ **不要在插件裡寫死 90。** 那個數字跟三個檔位一樣是遊戲說了算的，寫死的
   * 症狀是官方改了之後兩邊算出不同的配對鍵：一邊排 90+、一邊排 100+，
   * 而兩個畫面都寫著「排隊中」。
   */
  function openTierOf(panel) {
    var tpl = countsTemplate(panel);
    if (tpl === null) return null;
    var m = /COST([0-9]+)\\+/.exec(tpl);
    return m === null ? null : Number(m[1]);
  }

  /**
   * 那幾行字要接在哪一條線上 —— **每次重算，不要沿用掛上去那一刻的值。**
   *
   * ⚠⚠ 官方那一版（refresh_ranked_players）就是每次 setPosition 重算的，
   * 我們原本只在 attach() 算一次然後一直用。2026-08-20 實測到後果：一台的
   * 快取值卡在 506，而 player_count 的底部是 488 —— 於是 COST54 上面
   * **永遠空一行**，而且怎麼換頻道都不會好（換頻道會重掛，但重掛那一刻
   * 量到的可能又是另一個瞬間值）。
   *
   * 讀不到就退回掛上去時記的那個值 —— 那至少是曾經對過的數字。
   *
   * ⚠ 這段註解裡不能出現反引號（整支腳本住在一個 template literal 裡）。
   */
  function countsY(st) {
    var counter = st.panel && st.panel.player_count;
    if (counter && typeof counter.y === "number" && typeof counter.height === "number") {
      return counter.y + counter.height;
    }
    return st.baseY;
  }

  /**
   * 把狀態畫上去。
   *
   * ⚠ **配對中的狀態不寫在 INFO 那一區**，走的是遊戲自己的等待視窗
   * （showWaiting）—— 亞城按下快速比賽之後跳的就是那個框，而這整個功能
   * 的目的就是讓迪城跟那邊一樣。INFO 這裡只放人數。
   */
  function paint(st) {
    if (st.countsText !== null) {
      st.countsText.setText(renderCounts(st.panel, st.state.counts)).setPosition(10, countsY(st));
    }
    if (st.state.matching) showWaiting();
    else hideWaiting();
  }

  /**
   * 面板的水平中線。**兩顆按鈕左右對稱就靠它。**
   *
   * 官方的面板每一種都只有一顆按鈕，而且三種都放在同一格（實測 296.5, 434：
   * ranked 的 quick_btn、duel 的 room_btn、活動頻道的 room_btn 全都是）。
   * 所以「對稱的另一格」＝把那一格沿中線鏡射過去，而不是自己挑一個左邊距。
   *
   * 中線取 room_page_text（「1 / 1」那一格）—— 那是遊戲自己擺在正中央的
   * 東西（實測 x=185，而面板內容是 0…370），拿它當基準比寫死座標耐改版。
   * 它不在就退回翻頁鍵的兩端（page_first 靠左、page_last 靠右）。
   *
   * ⚠ **兩個都拿不到時回 null**，讓呼叫端走舊的相對位置 —— 猜一個中線
   * 會把按鈕放到面板外面去，而那看起來就是「按鈕不見了」。
   *
   * ⚠ 這段註解裡不能出現反引號（整支腳本住在一個 template literal 裡）。
   */
  function panelMidX(panel) {
    var t = panel.room_page_text;
    if (t && typeof t.x === "number") return t.x;
    var a = panel.page_first;
    var b = panel.page_last;
    if (a && b && typeof a.x === "number" && typeof b.x === "number") return (a.x + b.x) / 2;
    return null;
  }

  /**
   * 把按鈕與那兩行字掛到目前的面板上。
   *
   * ⚠ 按鈕位置是**算出來的**，不是寫死的座標。官方哪天把那顆按鈕移到別的
   * 地方，我們這顆會跟著移 —— 寫死的話會疊在一起。
   */
  function attach(st, sc, panel) {
    var roomBtn = panel.room_btn;
    var counter = panel.player_count;
    if (!roomBtn || !counter) return "面板上沒有 room_btn／player_count";

    var ButtonClass = Object.getPrototypeOf(roomBtn).constructor;
    var lang = gameLang();
    if (!sc.textures.exists("match_quick_btn")) return "客戶端沒有 match_quick_btn 這張圖";

    // 靠左，而且跟創建對戰室左右對稱（見 panelMidX）。讀不到中線才退回
    // 「貼在它左邊」—— 那個版本會擠在畫面中間，是後路不是目標。
    var mid = panelMidX(panel);
    var x = mid === null ? roomBtn.x - roomBtn.width - CFG.buttonGap : 2 * mid - roomBtn.x;
    var btn = new ButtonClass(sc, x, roomBtn.y, "match_quick_btn", {
      frames: { default: lang + "_1", over: lang + "_2" }
    });
    btn.on("click", function () {
      report({ type: "lobby-quick", channel: sc.channel === undefined ? null : sc.channel,
               matching: window[FLAG] ? !!window[FLAG].state.matching : false });
    });

    // ⚠ 樣式逐欄照抄亞城的 ranked_players（font_light / 15 / resolution 2 /
    // wordWrap 360）。差一格的話兩個頻道的同一段字看起來會不一樣。
    var style = { fontFamily: "font_light", fontSize: 15, resolution: 2,
                  wordWrap: { width: 360, useAdvancedWrap: true } };
    var countsText = sc.add.text(10, 0, "", style).setOrigin(0, 0);

    panel.add([btn, countsText]);

    st.panel = panel;
    st.channel = sc.channel === undefined ? null : sc.channel;
    // ⚠ 掛上面板的當下就讀一次。玩家換語言會換掉整份模板，而重掛是唯一
    // 會再讀一次的時機 —— 換語言必然伴隨畫面重建，所以這裡夠。
    st.openTier = openTierOf(panel);
    st.button = btn;
    st.countsText = countsText;
    // 拆的時候照這張清單走（見 detach）。
    st.mine = [btn, countsText];
    // 亞城的那幾行就是接在 player_count 底下。
    st.baseY = counter.y + counter.height;
    paint(st);
    return null;
  }

  /** 一輪檢查：該掛就掛、該拆就拆。**回 true = 現在掛著**。 */
  function sync(st) {
    var sc = matchScene();
    if (sc === null) { st.reason = "還沒載到對戰大廳"; return false; }

    var panel = sc.channel_panel;
    var ok = !!panel && panel.scene !== undefined && duelChannel(sc);
    // ⚠ ranked 面板有官方自己的快速比賽（quick_btn），不要疊上去。
    if (ok && panel.quick_btn) { ok = false; st.reason = "這是官方有快速比賽的頻道"; }

    if (!ok) {
      if (st.panel !== null) detach(st);
      if (st.reason === null) st.reason = "還沒進迪特赫姆";
      return false;
    }
    // 同一個面板而且東西還在 → 什麼都不用做。
    if (st.panel === panel && st.button !== null && st.button.scene !== undefined) return true;

    detach(st);
    var failure = attach(st, sc, panel);
    if (failure !== null) {
      st.reason = failure;
      report({ type: "lobby-error", reason: failure });
      return false;
    }
    st.reason = null;
    return true;
  }

  restore();

  var st = {
    version: CFG.version,
    installed: true,
    panel: null,
    channel: null,
    openTier: null,
    button: null,
    countsText: null,
    /** 我們加到面板上的每一個東西。**拆的時候照這張清單走**（見 detach）。 */
    mine: [],
    baseY: 0,
    /** 遊戲自己那幾個 UI 類別（對話框、文字按鈕、字串表）。第一次用到才去找。 */
    kit: null,
    /** 等待對手的視窗（配對中才有）。⚠ 它掛在場景上，不在面板裡。 */
    wait: null,
    timer: null,
    reason: null,
    state: { counts: null, matching: false }
  };
  window[FLAG] = st;

  /** Node 推狀態進來。**畫面上的每一個字都從這裡來。** */
  st.setState = function (json) {
    try {
      var next = JSON.parse(json);
      st.state = {
        counts: next && next.counts ? next.counts : null,
        matching: !!(next && next.matching)
      };
      paint(st);
      return "ok";
    } catch (e) {
      return "error: " + String((e && e.message) || e);
    }
  };

  /**
   * 跳「這個牌組不符合遊戲規則」。
   *
   * ⚠ 訊息**優先從遊戲自己那份拿**（\`room_error[lang][code]\`）—— 玩家的
   * 客戶端是什麼語言就是什麼語言，而且跟他按官方快速比賽時看到的一模一樣。
   * Node 只送代碼，送字串是後備（規則檔特有的錯，遊戲沒有對應的句子）。
   */
  st.showError = function (json) {
    try {
      var p = JSON.parse(json);
      var sc = matchScene();
      var text = null;
      if (sc !== null && typeof p.code === "number") {
        var table = sc.room_error && sc.room_error[gameLang()];
        if (table && typeof table[p.code] === "string") text = table[p.code];
      }
      if (text === null) text = typeof p.message === "string" ? p.message : "";
      if (text === "") return "no-message";
      return showDialog(text);
    } catch (e) {
      return "error: " + String((e && e.message) || e);
    }
  };

  if (!sync(st)) {
    // ⚠ 玩家多半是「先開插件，再開遊戲，登入，進頻道」—— 等他進去是常態，
    // 不是錯誤。所以這支**沒有上限**地盯著（間隔 500ms，只讀兩個欄位）。
    st.timer = setInterval(function () {
      if (window[FLAG] !== st) { clearInterval(st.timer); return; }
      try { sync(st); } catch (e) { st.reason = String((e && e.message) || e); }
    }, CFG.pollIntervalMs);
  } else {
    // 掛上了也要繼續盯 —— 玩家換頻道時面板會換人。
    st.timer = setInterval(function () {
      if (window[FLAG] !== st) { clearInterval(st.timer); return; }
      try { sync(st); } catch (e) { st.reason = String((e && e.message) || e); }
    }, CFG.pollIntervalMs);
  }

  return JSON.stringify({
    installed: true, version: st.version, channel: st.channel,
    openTier: st.panel === null ? null : openTierOf(st.panel),
    buttonReady: st.button !== null, waiting: st.button === null, reason: st.reason
  });
})()`;
}

/** 把狀態推給頁面。 */
export function buildLobbyStateExpression(state: LobbyState): string {
  return `window.${FLAG} ? window.${FLAG}.setState(${embedJson(state)}) : "not-installed"`;
}

/**
 * 跳出遊戲自己的錯誤對話框。
 *
 * `code` 是 `Match.room_error[lang]` 的索引 —— **7 = 「這個牌組不符合遊戲規則」**
 * （2026-08-18 從跑著的客戶端讀的）。
 */
export function buildLobbyErrorExpression(code: number | null, message?: string): string {
  return `window.${FLAG} ? window.${FLAG}.showError(${embedJson({
    code,
    ...(message === undefined ? {} : { message }),
  })}) : "not-installed"`;
}

/** 「這個牌組不符合遊戲規則」在 `room_error` 裡的位置。 */
export const ROOM_ERROR_DECK_INVALID = 7;

/**
 * 「AP不足」在 `room_error` 裡的位置（2026-08-19 從跑著的客戶端讀的）。
 *
 * 伺服器擋下來時回的也是這個代碼（`fail: 4`），所以玩家看到的那句話跟他自己
 * 手動開房 AP 不夠時**一模一樣** —— 那正是我們要的：這顆按鈕的每一句話都要
 * 是遊戲自己的話。
 */
export const ROOM_ERROR_AP_SHORT = 4;

export const LOBBY_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({ installed: false, version: null, channel: null,
        openTier: null, buttonReady: false, waiting: false, reason: null });
    }
    return JSON.stringify({
      installed: st.installed === true,
      version: st.version,
      channel: st.channel,
      // ⚠ 每次都當場從模板重讀。玩家換遊戲語言時模板會換成另一份，而那一份的
      // COST90+ 完全可能是另一個數字。
      openTier: st.openTier === undefined ? null : st.openTier,
      // ⚠ **當場看物件還在不在**，不要把安裝時記的值唸一遍：玩家換頻道之後
      // 面板連同按鈕會被 destroy，而旗標還在。
      buttonReady: !!(st.button && st.button.scene !== undefined),
      waiting: st.timer !== null && st.timer !== undefined && !st.button,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, channel: null,
      openTier: null, buttonReady: false, waiting: false, reason: String((e && e.message) || e) });
  }
})()`;

export const LOBBY_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window.${FLAG};
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var items = [st.button, st.countsText,
                 st.wait ? st.wait.box : null, st.wait ? st.wait.zone : null];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    // ⚠ 等待視窗的兩個計時器要收 —— 它們抓著剛剛被 destroy 的 text 物件。
    try { if (st.wait) { st.wait.counter.remove(); st.wait.wave.remove(); } } catch (e) {}
    delete window.${FLAG};
    return "uninstalled";
  } catch (e) { return "error: " + String((e && e.message) || e); }
})()`;

const STATUS_KEYS = ["installed", "buttonReady"] as const;

export function parseLobbyStatus(raw: string): LobbyStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return notInstalled(`頁面回的不是 JSON：${raw.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) return notInstalled("頁面回的不是物件");
  const o = parsed as Record<string, unknown>;
  for (const k of STATUS_KEYS) {
    if (!(k in o)) return notInstalled(`頁面回的物件少了 ${k}`);
  }
  return {
    installed: o["installed"] === true,
    version: typeof o["version"] === "number" ? o["version"] : null,
    channel: typeof o["channel"] === "number" ? o["channel"] : null,
    openTier: typeof o["openTier"] === "number" ? o["openTier"] : null,
    buttonReady: o["buttonReady"] === true,
    waiting: o["waiting"] === true,
    reason: typeof o["reason"] === "string" ? o["reason"] : null,
  };
}

function notInstalled(reason: string): LobbyStatus {
  return {
    installed: false,
    version: null,
    channel: null,
    openTier: null,
    buttonReady: false,
    waiting: false,
    reason,
  };
}
