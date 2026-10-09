/**
 * 在迪特赫姆重現亞歷山卓城的快速比賽
 * ====================================
 * 迪城（duel 頻道）只有「創建對戰房間」，亞城（ranked 頻道）有「快速比賽」與
 * 「COST54:N 位玩家等待中」。差別不是介面偷懶，是**伺服器那邊只有 ranked 頻道
 * 有佇列**（`quick_room` 只在有快速比賽的頻道有，而且用原版 COST 分檔）——
 * 見 docs/match-making.md §1。
 *
 * 這支把那兩樣東西補回迪城，資料來源換成插件自己的中間人：
 *
 * ```
 *   亞城（官方）                            迪城（這支）
 *   ──────────────────────────────          ──────────────────────────────
 *   match_quick 鈕 → quick_room             同一張圖的按鈕 → 插件的自動配對
 *   quick_length 推播 → 4 行人數            中間人的佇列人數 → 同一個模板
 *   create_match_wait() 等待視窗            同一支（取消鈕改成通知插件）
 *   match_error(代碼) 錯誤框                同一支、同一份字串表
 * ```
 *
 * ## 2026-09-23 改版之後的大廳（2026-09-27 從跑著的客戶端讀的）
 *
 * 改版前頻道畫面是一個面板物件（`channel_panel`），改版後東西全部直接掛在 Match
 * 場景上，`channel_login(頻道物件)` 建、`channel_logout()` 拆：
 *
 * ```
 *   channel_match      右下那顆鈕：亞城 "match_quick"、迪城 "match_create"
 *                      image(352, 434) origin(1, 0.5)
 *   channel_room_prev  翻頁 ◀ image(143, 400) origin(1, 0)
 *   channel_room_next  翻頁 ▶ image(223, 400) origin(0, 0)
 *   channel_length     「名字:迪特赫姆登入 [參加人數:N]」text(8, 472) font_light 14
 *   channel            頻道物件 { channel, quick, event, cost, required_ap, domain }
 * ```
 *
 * ## 照抄，一個都不能自己發明
 *
 * 1. **按鈕是遊戲自己的 `match_quick` 那張圖**（迪城也載得到，frames 0/1），擺法照
 *    官方那顆（hover 換 frame 1），位置跟「創建對戰房間」沿翻頁鍵的中線左右對稱。
 * 2. **人數那幾行用遊戲自己的模板**（`MatchUITexts.channel_length.quick`，亞城那幾行
 *    就是它填出來的）。自己組字串的話換語言就會露出繁中。
 * 3. **等待視窗就是官方的 `create_match_wait()`**，只把 Cancel 鈕的 pointerup 換成
 *    「通知插件」—— 這時候還沒有房，官方那支會送一個沒有對象的 cancel_room。
 * 4. **錯誤框就是官方的 `match_error(代碼)`**，字串表是 `MatchUITexts.error`。
 *
 * ## ⚠ 這支不會替玩家操作遊戲
 *
 * 它只是**畫一顆按鈕**並把「玩家按了」回報給 Node。真正會開房、消耗 AP 的是
 * `match-room.ts`，而那條路徑的前提沒有變：**玩家親手按下去**。
 *
 * ## ⚠ 按鈕跟著頻道畫面生滅
 *
 * 換頻道／退出頻道時 `channel_match` 會被 destroy、重建。所以這支用輪詢盯著
 * 「那顆鈕還是不是同一顆」（500ms），換了就重掛一次。
 *
 * ## 順路修的兩件事（亞城、迪城都做，2026-10-01 讀原始碼）
 *
 * **1. 等待中可以點房間看牌組。** 官方 `create_match_wait()` 蓋一層全畫面的
 * `wait_zone`（depth 50），排隊時整個大廳都點不動。我們把它的 hitAreaCallback
 * 換掉：**只放行房間列與翻頁鍵**，其餘照擋（快速比賽鈕、換牌組、返回都不能按）。
 * 房間詳情裡的「進入」鈕不用管：官方 `room_wait` 為真時根本不畫它，而且詳情
 * 面板不在放行範圍裡。
 *
 * ⚠ 點房間會把 `room_select` 換成那一間（官方的點擊處理就是這樣寫的），而官方
 * Cancel 送的是 `cancel_room(this.room_select)` —— 不處理的話取消會送錯房號。
 * 所以開等待的那一刻把真正的 id 記在 `sc.__ulrWaitRoom`，Cancel 前先換回來；
 * 插件的 `match-room.ts` 收房也讀這一格。
 *
 * **2. 頁碼疊字（官方 bug）。** `channel_login()` 每次都新建 ◀▶ 與三個頁碼字，
 * `channel_logout()` 卻沒拆 —— 進出頻道幾次就疊幾組「1 / 2」。包 `channel_logout`
 * 一起拆；已經漏掉的那幾組由輪詢照官方座標清掉。
 *
 * 兩支方法都是**包在場景實例上**，拆的時候照 `st.wraps` 還原（Match 場景物件
 * 跟遊戲一樣長命，忘了還原就會一層一層疊上去）。
 */

import { embedJson } from "./embed.js";

/** 一檔的等待人數。`tier` 是那一檔的上限（54、61、77），開口檔則是下限（90）。 */
export interface LobbyTierCount {
  tier: number;
  waiting: number;
  /** 這是 `COST90+` 那一檔嗎。⚠ 最多一個，而且一定排在最後。 */
  open?: boolean;
  /**
   * 這是**自訂檔**嗎 —— 牌組算出來落在官方三檔之外，插件自己開的那一檔。
   *
   * ⚠ 官方那幾行是遊戲自己的模板填出來的，而自訂檔在那份模板裡**沒有位置**。
   * 所以它自己一行，前面加 `★` 標出來：畫面上一定要分得出「這是官方的檔位」
   * 跟「這是插件照你的牌組算的檔位」。
   *
   * ⚠ **沒有人在等就不要送過來**（送 `waiting: 0` 也一樣會畫）。
   */
  custom?: boolean;
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
   * 正在配對嗎。`true` = 跳出**遊戲自己的等待視窗**（`create_match_wait()`），
   * `false` = 收掉它。
   */
  matching: boolean;
  /**
   * 等待視窗上要多寫的那一行（`★ COST 48 · 夾擠式罰C`）。`null`／沒給 = 不加。
   *
   * ⚠ **這是「這個框不是官方的」那個標記。** 自訂檔在左下那幾行裡沒有數字，
   * 玩家除了這一行之外沒有別的地方看得到自己排的是什麼。
   */
  badge?: string | null;
}

export interface LobbyPatchOptions {
  /** 頁面呼叫這個名字把「玩家按了按鈕」送回 Node。 */
  bindingName: string;
  /** 盯著頻道畫面換人沒有的間隔。 */
  pollIntervalMs?: number;
}

export const DEFAULT_LOBBY_POLL_MS = 500;

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * ⚠ 這支跟 `patch-stage` 一樣是「先拆再裝」，所以不靠版本號決定要不要重裝；
 * 版本號是回報用的 —— 玩家回報怪狀況時一眼看得出他頁面上跑的是哪一版。
 *
 * 6 = 2026-09-23 改版後的大廳（Match 場景上的 channel_match／channel_length）。
 * 7 = 等待中可以點房間看牌組；退頻道時拆掉翻頁鍵與頁碼字（官方漏拆）。
 * 8 = 等待視窗的標記行改成框標題（黑字、標題帶裡），白字壓在白底上看不見。
 */
export const LOBBY_SCRIPT_VERSION = 8;

const FLAG = "__ulrLobby";

/** 翻頁鍵讀不到時的中線（實測 ◀ 右緣 143、▶ 左緣 223）。 */
const FALLBACK_MID_X = 183;

/**
 * 等待視窗的新位置：大廳右下那塊空白，上左下三邊離鄰居各 8px。
 *
 * 鄰居（2026-10-01 在遊戲的 canvas 上逐像素量的（2 倍緩衝），都是官方寫死的位置）：
 *
 * ```
 *   左  房間列面板右緣（含深色描邊）  x 368    ← 烤在背景圖裡，沒有物件可讀
 *   上  房間詳情框 room_detail_frame  y 312    ← (384, 32) 起 352 × 280
 *   下  BattlePoint 那兩行的黑色描邊  y 471.5  ← text(376, 466)，字框上緣有留白
 * ```
 *
 * ⚠ 量要量 canvas 本身（postrender 時 toDataURL），玩家的視窗截圖有縮放與邊框，
 * 差 3px 左右。panel_gene 的黑色外框剛好畫在 bounds 上，所以間距就是 bounds 之差。
 *
 * 間距 16 —— 照左面板與房間詳情框之間那條縫（368 → 384，使用者指定的），所以框的
 * 左緣剛好跟詳情框左緣對成一直線。上下也各 16，框高只剩 127.5（官方 156；緩衝是
 * 2 倍，半像素畫得出來）。
 *
 * 框裡：上面 31.5 是淺色標題帶（九宮格的上切片，壓不掉），底邊 4.5，中間約 91.5 放
 * 三樣東西。照**字形實際高度**（波浪字約 11.5、計時數字約 11、Cancel 25）讓四段間距
 * （標題帶→字→計時→Cancel→底邊）都約 11。偏移量從框的上緣算；Cancel 跟官方一樣
 * origin(0.5, 1)，cancelBottom 是它的下緣離框底多少。
 */
export const WAIT_LAYOUT = {
  left: 384,
  top: 328,
  height: 127.5,
  textY: 49.5,
  timerY: 72,
  cancelBottom: 15.5,
  /**
   * 插件標記那一行（迪城）：當成框的標題，放在淺色標題帶正中。
   * 照官方 Confirm 框（同一張 panel_gene）的標題：靠左、上緣 +16。
   */
  badgeY: 16,
} as const;

export interface LobbyStatus {
  installed: boolean;
  version: number | null;
  /** 目前掛在哪個頻道。`null` = 沒掛（不在頻道裡，或那是有官方快速比賽的頻道）。 */
  channel: number | null;
  /**
   * 開口檔（`COST90+`）的下限，**從遊戲自己的模板讀出來的**。
   *
   * ⚠ Node 端要拿它當第四條佇列的鍵，所以**不要在插件裡寫死 90**。
   * `null` = 讀不到模板。
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

  function activeMatch() {
    var sc = matchScene();
    return sc && sc.scene && sc.scene.isActive() ? sc : null;
  }

  function texts() {
    try {
      var t = window.game.cache.json.get("MatchUITexts");
      return t && typeof t === "object" ? t : null;
    } catch (e) { return null; }
  }

  /**
   * 這是要畫按鈕的頻道嗎：沒有官方快速比賽、也不是活動頻道（＝迪城、布萊德）。
   *
   * ⚠ 看頻道物件的 quick／event，不要寫死頻道編號 —— 官方哪天多開一組頻道，
   * 寫死 2/4 的版本會把按鈕畫到一個已經有官方快速比賽的頻道上。
   */
  function duelChannel(sc) {
    var c = sc && sc.channel;
    return !!(c && typeof c.channel === "number" && c.quick !== true && c.event !== true);
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
    fallbackMidX: FALLBACK_MID_X,
    waitLayout: WAIT_LAYOUT,
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
    try { hideWaiting(st); } catch (e) {}
    try { if (typeof st.unpatch === "function") st.unpatch(); } catch (e) {}
    delete window[FLAG];
  }

  // ---- 等待中點房間看牌組、頁碼疊字（亞城迪城都做，見檔頭）----

  var PAGER = ["channel_room_prev", "channel_room_next",
               "channel_page_text_now", "channel_page_text_slash", "channel_page_text_max"];

  /** 包場景實例上的一支方法，原本那支跑完再跑 after。拆的時候照 st.wraps 還原。 */
  function wrapMethod(st, sc, name, after) {
    var orig = sc[name];
    if (typeof orig !== "function" || orig.__ulrLobby === true) return;
    var rec = { sc: sc, name: name, orig: orig, fn: null, dead: false,
                own: Object.prototype.hasOwnProperty.call(sc, name) };
    rec.fn = function () {
      var r = orig.apply(this, arguments);
      if (!rec.dead) { try { after(this); } catch (e) {} }
      return r;
    };
    rec.fn.__ulrLobby = true;
    sc[name] = rec.fn;
    st.wraps.push(rec);
  }

  function unwrapAll(st) {
    var list = st.wraps || [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      // 別人又包在我們外面的話拿不下來，至少讓它變成直通。
      w.dead = true;
      try {
        if (w.sc[w.name] === w.fn) {
          if (w.own) w.sc[w.name] = w.orig;
          else delete w.sc[w.name];
        }
      } catch (e) {}
    }
    st.wraps = [];
  }

  /** 拆掉翻頁鍵與頁碼字。官方 channel_logout 漏拆的就是這五個。 */
  function dropPager(sc) {
    for (var i = 0; i < PAGER.length; i++) {
      try { if (sc[PAGER[i]] && sc[PAGER[i]].destroy) sc[PAGER[i]].destroy(); } catch (e) {}
      sc[PAGER[i]] = null;
    }
  }

  /** 官方 channel_login 畫翻頁鍵與頁碼字的座標（不是現役那一組的就是漏掉的）。 */
  function isPagerPiece(o) {
    if (!o) return false;
    if (o.type === "Image" && o.texture && o.texture.key === "btn_arrow") {
      return o.y === 400 && (o.x === 143 || o.x === 223);
    }
    if (o.type === "Text") return o.y === 407 && (o.x === 175 || o.x === 183 || o.x === 191);
    return false;
  }

  /** 清掉之前漏下來的那幾組（這一版裝上之前進出過頻道的話會有）。 */
  function sweepPager(sc) {
    if (!sc.channel) {
      for (var k = 0; k < PAGER.length; k++) {
        if (sc[PAGER[k]]) { dropPager(sc); break; }
      }
    }
    var list = sc.children && sc.children.list;
    if (!list || typeof list.length !== "number") return;
    var keep = [];
    for (var j = 0; j < PAGER.length; j++) keep.push(sc[PAGER[j]]);
    var dead = [];
    for (var i = 0; i < list.length; i++) {
      if (keep.indexOf(list[i]) === -1 && isPagerPiece(list[i])) dead.push(list[i]);
    }
    for (var d = 0; d < dead.length; d++) {
      try { dead[d].destroy(); } catch (e) {}
    }
  }

  /** 等待中放行的地方：房間列與翻頁鍵，但被等待面板蓋住的那一塊照擋。 */
  function letThrough(sc, x, y) {
    function hit(o) {
      try { return !!(o && o.scene && o.getBounds().contains(x, y)); } catch (e) { return false; }
    }
    if (hit(sc.wait_panel)) return false;
    var rooms = sc.channel_room_images || [];
    for (var i = 0; i < rooms.length; i++) if (hit(rooms[i])) return true;
    return hit(sc.channel_room_prev) || hit(sc.channel_room_next);
  }

  /** 把全畫面的 wait_zone 挖洞。hitArea 是區域座標，換回世界座標再比。 */
  function openZone(sc) {
    var z = sc.wait_zone;
    if (!z || !z.input || typeof z.input.hitAreaCallback !== "function") return;
    if (z.input.__ulrInside) return;
    var inside = z.input.hitAreaCallback;
    z.input.__ulrInside = inside;
    z.input.hitAreaCallback = function (area, x, y, obj) {
      if (!inside(area, x, y, obj)) return false;
      var wx = x - (obj.displayOriginX || 0) + obj.x;
      var wy = y - (obj.displayOriginY || 0) + obj.y;
      return !letThrough(sc, wx, wy);
    };
  }

  function closeZone(sc) {
    var z = sc && sc.wait_zone;
    if (!z || !z.input || !z.input.__ulrInside) return;
    z.input.hitAreaCallback = z.input.__ulrInside;
    delete z.input.__ulrInside;
  }

  /**
   * 官方 Cancel 送 cancel_room(this.room_select)，而等待中點過房間的話 room_select
   * 已經換成那一間。在官方那支前面插一支把它換回真正的 id。
   */
  function keepCancelRoom(sc) {
    var btn = sc.btn_cancel;
    if (!btn || btn.__ulrKeep || typeof btn.listeners !== "function") return;
    var official = btn.listeners("pointerup").slice();
    btn.off("pointerup");
    btn.on("pointerup", function () {
      if (typeof sc.__ulrWaitRoom === "string") sc.room_select = sc.__ulrWaitRoom;
    });
    for (var i = 0; i < official.length; i++) btn.on("pointerup", official[i]);
    btn.__ulrKeep = true;
  }

  /**
   * 等待視窗剛開。room_wait 為真（官方快速比賽、官方或插件開房）時 room_select 就是
   * 那一間；迪城插件排隊時還沒有房，記 null（插件開好房時 match-room 會補上）。
   */
  function onWaitOpened(sc) {
    sc.__ulrWaitRoom = sc.room_wait === true && typeof sc.room_select === "string"
      ? sc.room_select : null;
    try { placeWait(sc); } catch (e) {}
    openZone(sc);
    if (sc.__ulrWaitRoom !== null) keepCancelRoom(sc);
  }

  /**
   * 等待視窗搬到右下那塊空白（數字見 WAIT_LAYOUT）。框的左緣釘住，寬度照官方算的
   * （字寬 + 32），所以框變寬時往右長。
   *
   * 第一次搬：連高度與裡面的 y 一起排。之後（標記那一行把框撐寬）只跟著修 x ——
   * 逐字波浪的 tween 在動 y，開始跑之後就不要再碰它的 y。
   */
  function placeWait(sc) {
    var L = CFG.waitLayout;
    var p = sc.wait_panel;
    if (!p || !p.scene) return;
    var first = p.__ulrPlaced !== true;
    if (first) {
      if (typeof p.setSize === "function") p.setSize(p.width, L.height);
      else p.height = L.height;
    }
    var cx = L.left + p.width / 2;
    var dx = cx - p.x;
    p.setPosition(cx, L.top + L.height / 2);
    var letters = sc.wait_text || [];
    for (var i = 0; i < letters.length; i++) {
      letters[i].x += dx;
      if (first) letters[i].y = L.top + L.textY;
    }
    var t = sc.wait_time_text;
    if (t) t.setPosition(t.x + dx, first ? L.top + L.timerY : t.y);
    var b = sc.btn_cancel;
    if (b) b.setPosition(b.x + dx, first ? L.top + L.height - L.cancelBottom : b.y);
    var bt = sc.btn_cancel_text;
    if (bt) bt.setPosition(bt.x + dx, first && b ? b.getCenter().y : bt.y);
    p.__ulrPlaced = true;
  }

  /** 每一輪：包好兩支方法、補挖已經開著的等待視窗、清漏掉的頁碼。 */
  function lobbyFixes(st) {
    var sc = matchScene();
    if (sc === null) return;
    wrapMethod(st, sc, "create_match_wait", onWaitOpened);
    wrapMethod(st, sc, "remove_match_wait", function (s) { s.__ulrWaitRoom = null; });
    wrapMethod(st, sc, "channel_logout", dropPager);
    if (sc.wait_zone) {
      // 這一版裝上之前就開著的視窗：那時點不到房間，room_select 一定還是對的。
      if (sc.__ulrWaitRoom === undefined) onWaitOpened(sc);
      else {
        try { placeWait(sc); } catch (e) {}
        openZone(sc);
      }
    }
    sweepPager(sc);
  }

  function detach(st) {
    // ⚠ 拆的是 st.mine（我們加過的每一個東西），不是幾個具名欄位 —— 拆的時候手上
    // 那個 st 可能是**上一版腳本**留下的，欄位跟這一版不一樣。具名欄位仍然照拆。
    var items = (st.mine || []).concat([st.button, st.countsText, st.statusText]);
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    st.mine = [];
    st.button = null;
    st.countsText = null;
    st.anchor = null;
    st.channel = null;
  }

  /**
   * 遊戲自己的等待視窗（create_match_wait）。取消鈕改成通知插件。
   *
   * ⚠ 三種情況不開：已經有視窗（插件開好房之後沿用同一個）、對戰已經開始
   * （player_side 有值，Match 正要 sleep）、玩家自己開著一間房（room_wait，那是
   * 官方的視窗，取消鈕要留給官方）。
   */
  function showWaiting(st) {
    var sc = activeMatch();
    if (sc === null) return;
    if (sc.player_side !== null && sc.player_side !== undefined) return;
    if (!sc.wait_zone) {
      if (sc.room_wait === true) return;
      if (typeof sc.create_match_wait !== "function") return;
      sc.create_match_wait();
      st.ownsWait = true;
      rebindCancel(st, sc);
    }
    ensureBadge(st, sc);
  }

  /** 官方的 Cancel 會送 cancel_room(room_select)，排隊時還沒有房 —— 換成通知插件。 */
  function rebindCancel(st, sc) {
    var btn = sc.btn_cancel;
    if (!btn || typeof btn.off !== "function") return;
    btn.off("pointerup");
    btn.on("pointerup", function () {
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      btn.setTexture("btn_gene", 1);
      report({ type: "lobby-quick", channel: sc.channel ? sc.channel.channel : null, matching: true });
    });
  }

  /**
   * 等待視窗上那一行（★ COST 48 · 規則名）。
   *
   * 當成框的標題，畫在淺色標題帶裡（上緣 + badgeY）。字型、黑字、左邊 padding 10、
   * 靠左都照官方 Confirm 框的標題 —— ⚠ 標題帶是白的，白字會看不見（以前是
   * font_light 白字置中在 +30，剛好壓在標題帶與深色底的交界上）。
   * 框被搬過（placeWait），所以位置跟著框算。
   */
  function ensureBadge(st, sc) {
    var text = st.state && typeof st.state.badge === "string" && st.state.badge.length > 0
      ? st.state.badge : null;
    var p = sc.wait_panel;
    if (text === null || !p) { dropBadge(st); return; }
    if (st.badge && st.badge.scene && st.badge.text === text) return;
    dropBadge(st);
    st.badge = sc.add.text(0, 0, text, {
      fontFamily: "font_heavy", fontSize: 15, resolution: 2, color: "black", padding: { left: 10 },
    }).setOrigin(0, 0.5).setDepth(51);
    try {
      var need = st.badge.width + 32;
      if (p.width < need) { p.width = need; placeWait(sc); }
    } catch (e) {}
    st.badge.setPosition(p.x - p.width / 2, p.y - p.height / 2 + CFG.waitLayout.badgeY);
  }

  function dropBadge(st) {
    try { if (st.badge && st.badge.destroy) st.badge.destroy(); } catch (e) {}
    st.badge = null;
  }

  function hideWaiting(st) {
    dropBadge(st);
    if (!st.ownsWait) return;
    st.ownsWait = false;
    var sc = matchScene();
    // ⚠ 只收還在的那個。對手進房時官方的 on_match_start() 已經收過了。
    try { if (sc && sc.wait_zone) sc.remove_match_wait(); } catch (e) {}
  }

  /** 亞城那幾行的模板（MatchUITexts.channel_length.quick）。拿不到就回 null。 */
  function countsTemplate() {
    var t = texts();
    var q = t && t.channel_length && t.channel_length.quick;
    return typeof q === "string" && q.length > 0 ? q : null;
  }

  /**
   * 把人數填進遊戲自己的模板。
   *
   * ⚠ 模板寫死 3 個有上限的檔（__COST1~3__）加一個開口檔 —— 那一行的 COST90+
   * 是寫死的字，只有數字是變數（__LENGTH4__）。
   *
   * ⚠ **沒有開口檔的資料時整行拿掉，不要填 0** —— 一條不存在的佇列永遠是
   * 0 個人，而玩家會把它讀成「那一檔沒人排」。
   */
  function renderCounts(counts) {
    if (counts === null || counts.length === 0) return "";
    var tpl = countsTemplate();
    var open = null;
    var band = [];
    var custom = [];
    for (var n = 0; n < counts.length; n++) {
      if (counts[n].custom === true) custom.push(counts[n]);
      else if (counts[n].open === true) open = counts[n];
      else band.push(counts[n]);
    }

    var out = null;
    if (tpl !== null && band.length >= 3) {
      out = tpl;
      for (var i = 0; i < 3; i++) {
        out = out.replace("__COST" + (i + 1) + "__", String(band[i].tier));
        out = out.replace("__LENGTH" + (i + 1) + "__", String(band[i].waiting));
      }
      out = open !== null
        ? out.replace("__LENGTH4__", String(open.waiting))
        : out.replace(/\\n?COST[0-9]+\\+:__LENGTH4__[^\\n]*/, "");
    } else {
      // 模板拿不到（改版了？）或官方檔位讀不到 → 自己組，格式照抄那一行。
      var lines = [];
      for (var j = 0; j < band.length; j++) {
        lines.push("COST" + band[j].tier + ":" + band[j].waiting + "位玩家等待中。");
      }
      if (open !== null) lines.push("COST" + open.tier + "+:" + open.waiting + "位玩家等待中。");
      out = lines.join("\\n");
    }

    for (var c = 0; c < custom.length; c++) {
      var line = customLine(tpl, custom[c]);
      if (line !== null) out = out === "" ? line : out + "\\n" + line;
    }
    return out;
  }

  /**
   * 自訂檔那一行 —— ★COST48:1位玩家等待中。句型從模板的**第一行**借。
   *
   * ⚠ 那顆 ★ 是**我們加的**，而且一定要加：這一檔不是遊戲的檔位。
   */
  function customLine(tpl, count) {
    var body = null;
    if (tpl !== null) {
      var first = String(tpl).split("\\n")[0];
      if (first && first.indexOf("__COST1__") !== -1 && first.indexOf("__LENGTH1__") !== -1) {
        body = first
          .replace("__COST1__", String(count.tier))
          .replace("__LENGTH1__", String(count.waiting));
      }
    }
    if (body === null) body = "COST" + count.tier + ":" + count.waiting + "位玩家等待中。";
    return "★" + body;
  }

  /**
   * 開口檔的下限 —— 從遊戲自己的模板裡那個 COST90+ 讀出來。
   *
   * ⚠ **不要在插件裡寫死 90。** 寫死的症狀是官方改了之後兩邊算出不同的配對鍵，
   * 而兩個畫面都寫著「排隊中」。
   */
  function openTierOf() {
    var tpl = countsTemplate();
    if (tpl === null) return null;
    var m = /COST([0-9]+)\\+/.exec(tpl);
    return m === null ? null : Number(m[1]);
  }

  /** 人數那幾行接在「參加人數」那一行底下 —— **每次重算**，那一行的高度會變。 */
  function countsY(sc) {
    var l = sc.channel_length;
    if (l && typeof l.y === "number" && typeof l.height === "number") return l.y + l.height;
    return 489;
  }

  /** 翻頁鍵的中線。兩顆按鈕左右對稱就靠它。 */
  function midX(sc) {
    var a = sc.channel_room_prev;
    var b = sc.channel_room_next;
    if (a && b && typeof a.x === "number" && typeof b.x === "number") return (a.x + b.x) / 2;
    return CFG.fallbackMidX;
  }

  function paint(st) {
    var sc = activeMatch();
    if (st.countsText !== null && sc !== null) {
      st.countsText.setText(renderCounts(st.state.counts)).setPosition(8, countsY(sc));
    }
    if (st.state.matching) showWaiting(st);
    else hideWaiting(st);
  }

  /**
   * 把按鈕與那幾行字掛到目前的頻道畫面上。
   *
   * ⚠ 按鈕位置是**算出來的**：官方那顆的右緣沿翻頁鍵的中線鏡射過來當我們的左緣。
   * 官方哪天把那顆鈕移走，我們這顆會跟著移。
   */
  function attach(st, sc) {
    var anchor = sc.channel_match;
    if (!sc.textures.exists("match_quick")) return "客戶端沒有 match_quick 這張圖";

    var right = anchor.x + (1 - anchor.originX) * anchor.width;
    var x = 2 * midX(sc) - right;
    var btn = sc.add.image(x, anchor.y, "match_quick", 0).setOrigin(0, 0.5).setInteractive();
    btn.on("pointerover", function () { btn.setTexture("match_quick", 1); });
    btn.on("pointerout", function () { btn.setTexture("match_quick", 0); });
    btn.on("pointerdown", function () { btn.setTexture("match_quick", 0); });
    btn.on("pointerup", function () {
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      btn.setTexture("match_quick", 1);
      report({ type: "lobby-quick", channel: sc.channel ? sc.channel.channel : null,
               matching: window[FLAG] ? !!window[FLAG].state.matching : false });
    });

    // ⚠ 樣式逐欄照抄 channel_length（font_light / 14 / resolution 2 / wordWrap 352）。
    var countsText = sc.add.text(8, countsY(sc), "", {
      fontFamily: "font_light", fontSize: 14, resolution: 2,
      wordWrap: { width: 352, useAdvancedWrap: true }
    }).setOrigin(0, 0);

    st.anchor = anchor;
    st.channel = sc.channel.channel;
    st.button = btn;
    st.countsText = countsText;
    st.mine = [btn, countsText];
    paint(st);
    return null;
  }

  /** 一輪檢查：該掛就掛、該拆就拆。**回 true = 現在掛著**。 */
  function sync(st) {
    var sc = activeMatch();
    if (sc === null) {
      if (st.button !== null) detach(st);
      st.reason = "還沒在對戰大廳";
      return false;
    }
    var anchor = sc.channel_match;
    var ok = duelChannel(sc) && !!anchor && anchor.scene !== undefined && anchor.scene !== null;
    if (!ok) {
      if (st.button !== null) detach(st);
      st.reason = sc.channel && sc.channel.quick === true ? "這是官方有快速比賽的頻道" : "還沒進迪特赫姆";
      return false;
    }
    // 排隊中而官方的視窗被別的東西收掉了（例如插件收房之後繼續排）→ 補回來。
    if (st.state.matching) showWaiting(st);
    // 同一顆錨、東西都還在 → 什麼都不用做。
    if (st.anchor === anchor && st.button !== null && st.button.scene) {
      st.countsText.setPosition(8, countsY(sc));
      return true;
    }

    detach(st);
    var failure = attach(st, sc);
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
    anchor: null,
    channel: null,
    button: null,
    countsText: null,
    /** 我們加到畫面上的每一個東西。**拆的時候照這張清單走**（見 detach）。 */
    mine: [],
    /** 官方的等待視窗是我們開的嗎（是的話收也由我們收）。 */
    ownsWait: false,
    badge: null,
    timer: null,
    reason: null,
    /** 包在 Match 場景實例上的方法（見 wrapMethod）。 */
    wraps: [],
    state: { counts: null, matching: false, badge: null }
  };
  window[FLAG] = st;

  /** 拆掉包過的方法、還原挖過洞的等待視窗。uninstall 與下一次重裝都走這裡。 */
  st.unpatch = function () {
    unwrapAll(st);
    try { closeZone(matchScene()); } catch (e) {}
  };

  /** Node 推狀態進來。**畫面上的每一個字都從這裡來。** */
  st.setState = function (json) {
    try {
      var next = JSON.parse(json);
      st.state = {
        counts: next && next.counts ? next.counts : null,
        matching: !!(next && next.matching),
        badge: next && typeof next.badge === "string" ? next.badge : null
      };
      paint(st);
      return "ok";
    } catch (e) {
      return "error: " + String((e && e.message) || e);
    }
  };

  /**
   * 跳遊戲自己的錯誤框（match_error）。
   *
   * ⚠ 訊息**優先用遊戲自己的字串表**（MatchUITexts.error[代碼]）—— 玩家的客戶端
   * 是什麼語言就是什麼語言。Node 送來的字串是後備（規則檔特有的錯，遊戲沒有對應
   * 的句子）：暫時塞一格進字串表再叫 match_error，它在第一個 await 之前就讀完了，
   * 叫完立刻拿掉。
   */
  st.showError = function (json) {
    try {
      var p = JSON.parse(json);
      var sc = activeMatch();
      if (sc === null) return "no-scene";
      if (typeof sc.match_error !== "function") return "no-dialog";
      var t = texts();
      if (!t || !t.error) return "no-texts";
      if (typeof p.code === "string" && typeof t.error[p.code] === "string") {
        sc.match_error(p.code);
        return "ok";
      }
      var msg = typeof p.message === "string" ? p.message : "";
      if (msg === "") return "no-message";
      var KEY = "__ulr_message";
      t.error[KEY] = msg;
      try { sc.match_error(KEY); } finally { delete t.error[KEY]; }
      return "ok";
    } catch (e) {
      return "error: " + String((e && e.message) || e);
    }
  };

  st.openTier = openTierOf;

  // ⚠ 玩家多半是「先開插件，再開遊戲，登入，進頻道」—— 等他進去是常態，
  // 不是錯誤。所以這支**沒有上限**地盯著（間隔 500ms，只讀幾個欄位）；掛上了
  // 也要繼續盯，換頻道時那顆錨會換人。
  try { lobbyFixes(st); } catch (e) {}
  try { sync(st); } catch (e) { st.reason = String((e && e.message) || e); }
  st.timer = setInterval(function () {
    if (window[FLAG] !== st) { clearInterval(st.timer); return; }
    try { lobbyFixes(st); } catch (e) {}
    try { sync(st); } catch (e) { st.reason = String((e && e.message) || e); }
  }, CFG.pollIntervalMs);

  return JSON.stringify({
    installed: true, version: st.version, channel: st.channel,
    openTier: openTierOf(),
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
 * `code` 是 `MatchUITexts.error` 的鍵（見 {@link ROOM_ERROR_AP_SHORT}）；認不得或
 * 是 `null` 時顯示 `message`。
 */
export function buildLobbyErrorExpression(code: string | null, message?: string): string {
  return `window.${FLAG} ? window.${FLAG}.showError(${embedJson({
    code,
    ...(message === undefined ? {} : { message }),
  })}) : "not-installed"`;
}

/** 「這個牌組不符合遊戲規則。」（`MatchUITexts.error.INVALID_DECK_ENTER`）。 */
export const ROOM_ERROR_DECK_INVALID = "INVALID_DECK_ENTER";

/**
 * 「AP不足。」（`MatchUITexts.error.NOT_ENOUGH_AP`）。
 *
 * 伺服器擋下來時推的也是這個代碼，所以玩家看到的那句話跟他自己手動開房 AP 不夠時
 * **一模一樣** —— 這顆按鈕的每一句話都要是遊戲自己的話。
 */
export const ROOM_ERROR_AP_SHORT = "NOT_ENOUGH_AP";

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
      channel: st.channel === undefined ? null : st.channel,
      // ⚠ 每次都當場從模板重讀。玩家換遊戲語言時模板會換成另一份。
      openTier: typeof st.openTier === "function" ? st.openTier() : null,
      // ⚠ **當場看物件還在不在**：玩家換頻道之後按鈕會被拆掉，而旗標還在。
      buttonReady: !!(st.button && st.button.scene),
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
    try { if (typeof st.unpatch === "function") st.unpatch(); } catch (e) {}
    var items = (st.mine || []).concat([st.button, st.countsText, st.badge]);
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    // 我們開的等待視窗一起收（它的取消鈕已經被換成通知插件，留著會變成關不掉的框）。
    try {
      var keys = window.game && window.game.scene && window.game.scene.keys;
      var sc = keys && keys.Match;
      if (st.ownsWait && sc && sc.wait_zone) sc.remove_match_wait();
    } catch (e) {}
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
