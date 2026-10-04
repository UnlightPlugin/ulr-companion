/**
 * 進了哪一房、開戰前先套牌組（WP-19，2026-09-24 照改版後的客戶端重寫）
 * ====================================================================
 * 這支做四件事，全部只能做在頁面裡：
 *
 * ```
 *   1. 玩家現在在哪一房       → 回報給 Node（Node 據此排上那一房的牌組）
 *   2. 進房之前就把牌換好     → 一幀都不閃上一房的牌（RoomDeckPreload）
 *   3. 開戰的那一下先攔下來   → 伺服器那份跟眼前那份不一樣時，Node 寫完才放行
 *   4. deck_now 釘住          → 插件模式只用 Deck1（Deck2/Deck3 是清空的）
 * ```
 *
 * ## 三種模式（2026-09-24 玩家要的）
 *
 * ```
 *   plugin    四房各一組自訂牌組，全部經過 Deck1；Deck2/Deck3 清空、deck_now 釘 1
 *   official  四房各有自己的「官方三牌組」，進房時三格一起換；◀▶ 照官方行為
 *   off       這支只回報房間，不預載、不攔、不釘
 * ```
 *
 * 模式與每一房的牌組由 Node 一起推過來（`setRoomDecks`）。頁面不決定任何東西。
 *
 * ## 開戰的五個入口收斂成一道閘
 *
 * 改版後開戰全部是 `socket.fetch`（2026-09-24 讀原始碼，精確比對）：
 *
 * ```
 *   任務  Quest.quest_start()   this.socket.fetch("quest_start", pid, deck_now)
 *   渦    Raid（確認框的 OK）    this.socket.fetch("raid_start", profound_id, 回合, deck_now)
 *   亞城  Match.quick_match()   this.socket_channel.fetch("quick_room", deck_now, ch)
 *   開房  Match.create_panel()  this.socket_channel.fetch("create_room", deck_now, ch, R)
 *   進房  Match 房間詳情        this.socket_channel.fetch("enter_room", room, deck_now, t)
 * ```
 *
 * 攔在 socket 的 `fetch`（**實例上**的自有屬性，不動 prototype —— 動了會連其他
 * 連線一起攔到，而且拆的時候還原不回去）。被攔下的那一次回一個 Promise，Node
 * 放行時才真的送出去，結果原樣交回給遊戲。
 *
 * ## ⚠⚠ 一定要有看門狗
 *
 * 被攔的時候遊戲已經把輸入關掉（`input.enabled = false`、渦房還蓋了一層全畫面的
 * 吃輸入區）。Node 只要沒回來（斷線、當掉、寫入卡住），玩家就卡死在那個畫面。
 * 所以頁面自己有 {@link RoomGateOptions.holdTimeoutMs}：時間到就**原樣放行**。
 * 用舊牌組開打，比讓玩家卡死好。
 *
 * ## 什麼時候才攔
 *
 * ```
 *   模式是 off、或這一房沒有指派牌組            → 不攔
 *   Node 說有東西排著隊（pending）             → 攔
 *   客戶端那份 ≠ 頁面記著的伺服器那份            → 攔（Node 寫進伺服器再放）
 *   伺服器那份還沒記過                          → 攔（Node 會去讀一次）
 *   其餘                                        → 原樣直通，一趟都不多
 * ```
 *
 * 「伺服器那份」是 `deck-write.ts` 的 `__ulrDeckMirror`（官方整份換掉 registry
 * 時、我們 deck_update 成功時更新）。舊版要每進一房讀一次伺服器才知道；現在頁面
 * 自己比得出來，大部分的開戰一趟網路都不多。
 *
 * ⚠ Node 回報寫不進去（`release(false)`）時，這一房**不再攔**，直到換房 ——
 * 否則每按一次開戰都被攔一下再失敗一次，而且每次都多送一個請求。
 *
 * ## 進房預載
 *
 * 房間場景在 `create()` 裡就把牌畫出來（`show_deck()`），所以要一幀都不閃，只能
 * 在 `create()` **跑之前**把 `registry.deck` 那幾格換掉 —— 包的是實例上的
 * `create`。Match 的亞城／迪城要看選哪個頻道，所以包的是 `channel_login(t)`
 * （改版後選頻道就是它，第一行就 `this.channel = t`）。
 *
 * ⚠ **就地改**那幾格，不要整份換掉 `registry.deck`：每個場景拿的是同一個陣列
 * 參照，而整份換掉會被 `__ulrDeckMirror` 當成「伺服器那份變了」。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在 template literal 裡，
 * 一個反引號就把字串截斷。詳細的東西寫在這個檔頭，腳本裡只留短註解。
 */

import { embedJson } from "./embed.js";
import { ROOM_COST_SNIPPET } from "./room-cost.js";

/** 頁面上掛狀態的地方。 */
const FLAG = "__ulrRoomGate";

/**
 * 腳本版本。**改了注入邏輯就要加一。**
 *
 * 判斷「頁面上跑的是不是新版」只能靠它 —— 看行為會讓你去改本來正確的程式碼
 * （這個專案在 `ws-events` 與 `patch-ok` 上各栽過一次）。
 */
export const ROOM_GATE_SCRIPT_VERSION = 8;

/** 多久看一眼玩家換房沒有。 */
export const DEFAULT_ROOM_GATE_POLL_MS = 500;

/**
 * 攔下來最多等多久（毫秒）。時間到就原樣放行，見檔頭「一定要有看門狗」。
 *
 * 改版後寫一次是一趟 `deck_update`（頁面那邊 6 秒逾時），8 秒夠它走完又不會讓
 * 玩家盯著沒反應的畫面太久。
 */
export const DEFAULT_HOLD_TIMEOUT_MS = 8_000;

/** 要攔的開戰請求（`socket.fetch` 的第一個參數）。 */
export const GATED_EVENTS: readonly string[] = [
  "quest_start",
  "raid_start",
  "quick_room",
  "create_room",
  "enter_room",
] as const;

/** 頁面認得的房型鍵。跟 `@ulr/deck-library` 的 `RoomKind` 同一組字。 */
export type GateRoom = "raid" | "alexandria" | "quest" | "dietherm";

/** 牌組替換模式。跟托盤設定裡那三個選項一一對應。 */
export type DeckMode = "plugin" | "official" | "off";

export interface RoomGateOptions {
  bindingName: string;
  pollIntervalMs?: number;
  holdTimeoutMs?: number;
}

/** 玩家換房了。 */
export interface RoomChangedReport {
  type: "room-changed";
  /** `null` = 不在任何一房（大廳、標題、還在選頻道）。 */
  room: GateRoom | null;
  /**
   * 頁面**已經自己把這一房的牌組換進客戶端記憶體了**（見 {@link RoomDeckPreload}）。
   *
   * ⚠⚠ 這個旗標是 Node 的**必要**資訊：它是 true 時客戶端記憶體 = 這一房的牌、
   * 伺服器 = 還是上一副。Node 拿客戶端那份判斷「要不要寫伺服器」的話會得出
   * 「一樣，不必寫」—— 於是開戰用的是上一房的牌，而畫面完全正常。
   */
  preloaded?: boolean;
}

/**
 * 每一房「進去就該用的那幾格」，Node 事先推給頁面。
 *
 * ⚠ 頁面不自己挑、不自己存、不寫伺服器。這裡放的是**畫面來得及畫**所需的資料：
 * 房間場景在 `create()` 裡就把牌畫出來，那個時間點沒有機會去問 Node。
 */
export interface RoomDeckPreload {
  /** 要換的格子。插件模式只有第 1 格，官方三牌組模式三格都有。 */
  slots: {
    deckId: number;
    chara_card_id: (number | null)[];
    weapon_card_id: (number | null)[];
    event_card_id: (number | null)[];
  }[];
  /** 進房後把 `deck_now` 釘在第幾副；`null` = 不動（官方三牌組模式）。 */
  pin: number | null;
  /** 每一格左下那行字要寫什麼（原版寫 `Deck1`）。鍵是 `deck_id`。 */
  names: Record<string, string>;
}

/** Node 推給頁面的整包。 */
export interface RoomGateDecks {
  mode: DeckMode;
  decks: Partial<Record<GateRoom, RoomDeckPreload>>;
}

/**
 * 開戰被攔下來了，**Node 必須回應**（`release`），否則看門狗接手。
 */
export interface RoomGateHoldReport {
  type: "room-gate-hold";
  /** 被攔下來的請求名。 */
  event: string;
  room: GateRoom | null;
}

/** 看門狗放行了 —— 代表 Node 沒有及時回來，牌組**沒有**換成。 */
export interface RoomGateTimeoutReport {
  type: "room-gate-timeout";
  event: string;
}

export type RoomGateReport = RoomChangedReport | RoomGateHoldReport | RoomGateTimeoutReport;

const REPORT_TYPES = new Set(["room-changed", "room-gate-hold", "room-gate-timeout"]);

export function isRoomGateReport(value: unknown): value is RoomGateReport {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && REPORT_TYPES.has(type);
}

/** 房間偵測的共用片段（安裝腳本與狀態查詢都用）。 */
const SHARED = `
  var FLAG = "${FLAG}";
  var GATED = JSON.parse(${embedJson([...GATED_EVENTS])});
  ${ROOM_COST_SNIPPET}

  function scenes() {
    var g = window.game;
    return (g && g.scene && g.scene.keys) || null;
  }

  function activeScene(K, name) {
    var sc = K[name];
    try { return sc && sc.scene.isActive() ? sc : null; } catch (e) { return null; }
  }

  /** 玩家現在在哪一房。認不出來回 null（還在選頻道也是 null）。 */
  function currentRoom() {
    var K = scenes();
    if (K === null) return null;
    if (activeScene(K, "Quest") !== null) return "quest";
    if (activeScene(K, "Raid") !== null) return "raid";
    var m = activeScene(K, "Match");
    if (m !== null) return ulrRoomOfChannel(m.channel);
    return null;
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西拆乾淨，再從原狀重來。
 */
export function buildRoomGateScript(options: RoomGateOptions): string {
  const config = {
    bindingName: options.bindingName,
    version: ROOM_GATE_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ROOM_GATE_POLL_MS,
    holdTimeoutMs: options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
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

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** 舊版的欄位不一定在，逐一擋。 */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== undefined && st.timer !== null) clearInterval(st.timer); } catch (e) {}
    try { if (st.hold !== null) st.hold.release(); } catch (e) {}
    var ws = st.wrapped || [];
    for (var i = 0; i < ws.length; i++) {
      try {
        var w = ws[i];
        if (w.method && w.socket[w.method] === w.patched) delete w.socket[w.method];
        else if (!w.method && w.socket.emit === w.patched) delete w.socket.emit;
      } catch (e) {}
    }
    var cs = st.creates || [];
    for (var j = 0; j < cs.length; j++) {
      try { if (cs[j].scene.create === cs[j].patched) delete cs[j].scene.create; } catch (e) {}
    }
    var ls = st.logins || [];
    for (var k = 0; k < ls.length; k++) {
      try { if (ls[k].scene.channel_login === ls[k].patched) delete ls[k].scene.channel_login; } catch (e) {}
    }
    // 舊版（v7 以前）包的是頻道列表的 emit。
    var hs = st.channelHooks || [];
    for (var h = 0; h < hs.length; h++) {
      try { if (hs[h].list.emit === hs[h].patched) delete hs[h].list.emit; } catch (e) {}
    }
    delete window[FLAG];
  }

  restore();

  var st = {
    version: CFG.version,
    installed: true,
    mode: "off",
    /** Node 說「有東西還沒寫進伺服器」。 */
    pending: false,
    /** 上一次回報出去的房型，用來只在變動時回報。 */
    room: null,
    /** Node 在這一房寫不進去過 —— 換房之前不再攔。見檔頭。 */
    gaveUp: null,
    /** 正被攔著的那一下。同一時間只會有一個。 */
    hold: null,
    wrapped: [],
    creates: [],
    logins: [],
    /** 每一房「進去就該用的那幾格」，Node 推來的。見 RoomDeckPreload。 */
    decks: {},
    timer: null,
    holds: 0,
    timeouts: 0
  };
  window[FLAG] = st;

  function wantFor(room) {
    if (st.mode === "off" || room === null) return null;
    return (st.decks && st.decks[room]) || null;
  }

  /** 客戶端那份（registry）跟頁面記著的伺服器那份一不一樣。沒記過算不一樣。 */
  function clientDiffersFromServer() {
    var g = window.game;
    var M = window.__ulrDeckMirror;
    if (!g || !M || !Array.isArray(M.server)) return true;
    var list = g.registry.get("deck");
    if (!Array.isArray(list)) return false;
    function key(d) {
      return JSON.stringify([d.chara_card_id, d.weapon_card_id, d.event_card_id]);
    }
    for (var i = 0; i < list.length; i++) {
      var cur = list[i];
      var srv = null;
      for (var j = 0; j < M.server.length; j++) {
        if (M.server[j] && M.server[j].deck_id === cur.deck_id) srv = M.server[j];
      }
      if (srv === null || key(cur) !== key(srv)) return true;
    }
    return false;
  }

  /** 這一下開戰要不要攔。完整規則在檔頭「什麼時候才攔」。 */
  function needGate() {
    var room = currentRoom();
    if (wantFor(room) === null) return false;
    if (st.gaveUp === room) return false;
    if (st.pending === true) return true;
    return clientDiffersFromServer();
  }

  function roomChanged(room, preloaded) {
    if (st.room === room) return;
    st.room = room;
    st.gaveUp = null;
    report({ type: "room-changed", room: room, preloaded: preloaded === true });
  }

  /*
   * 把一顆 socket 的 fetch 換成帶閘門的版本。
   * 被攔的那一次回一個 Promise，放行時才真的送，結果原樣交回給遊戲。
   */
  function wrap(socket) {
    if (!socket || typeof socket.fetch !== "function") return;
    for (var i = 0; i < st.wrapped.length; i++) {
      if (st.wrapped[i].socket === socket) return;
    }
    var orig = socket.fetch;
    var patched = function (ev) {
      var self = this;
      var args = arguments;
      try {
        if (st.hold === null && GATED.indexOf(ev) >= 0 && needGate()) {
          return new Promise(function (resolve, reject) {
            var done = false;
            var t = null;
            var fire = function () {
              if (done) return "already";
              done = true;
              st.hold = null;
              try { if (t !== null) clearTimeout(t); } catch (e) {}
              // 用 orig，不要再走一次 patched —— 那會再攔一次，變成無窮迴圈。
              try { orig.apply(self, args).then(resolve, reject); } catch (e) { reject(e); }
              return "released";
            };
            t = setTimeout(function () {
              if (done) return;
              st.timeouts++;
              report({ type: "room-gate-timeout", event: String(ev) });
              fire();
            }, CFG.holdTimeoutMs);
            st.hold = { event: String(ev), at: Date.now(), release: fire };
            st.holds++;
            report({ type: "room-gate-hold", event: String(ev), room: currentRoom() });
          });
        }
      } catch (e) {
        // 閘門自己出事的話一律放行 —— 絕不能因為我們的東西讓玩家開不了戰。
      }
      return orig.apply(self, args);
    };
    socket.fetch = patched;
    st.wrapped.push({ socket: socket, method: "fetch", patched: patched });
  }

  /** 現在有哪些 socket 值得攔。Match 的開戰走的是頻道那條（socket_channel）。 */
  function gateTargets() {
    var K = scenes();
    if (K === null) return [];
    var out = [];
    if (K.Quest && K.Quest.socket) out.push(K.Quest.socket);
    if (K.Raid && K.Raid.socket) out.push(K.Raid.socket);
    if (K.Match && K.Match.socket_channel) out.push(K.Match.socket_channel);
    return out;
  }

  /*
   * 把 Node 推來的那幾格就地寫進 registry（和場景手上那份，萬一不是同一個陣列）。
   * COST 照房型算好填進去：房間的 cost:NN 讀的是那一副的 cost，遊戲不重算。
   */
  function preload(sc, want, room) {
    var g = window.game;
    var lists = [g.registry.get("deck")];
    if (sc && sc.deck && lists.indexOf(sc.deck) < 0) lists.push(sc.deck);
    lists.forEach(function (list) {
      if (!Array.isArray(list)) return;
      want.slots.forEach(function (src) {
        for (var i = 0; i < list.length; i++) {
          var cur = list[i];
          if (!cur || cur.deck_id !== src.deckId) continue;
          cur.chara_card_id = src.chara_card_id.slice();
          cur.weapon_card_id = src.weapon_card_id.slice();
          cur.event_card_id = src.event_card_id.slice();
          var c = ulrRoomCostOf(cur, room);
          if (c !== null) cur.cost = c;
        }
      });
    });
    if (sc && want.pin !== null && want.pin !== undefined) sc.deck_now = want.pin;
  }

  /** 左下那行字 —— 原版寫 Deck1，牌組庫裡那一副有自己的名字。 */
  function setDeckLabel(sc, want) {
    try {
      var name = want.names && want.names[String(sc.deck_now)];
      if (name && sc.deck_name && typeof sc.deck_name.setText === "function") sc.deck_name.setText(name);
    } catch (e) {}
  }

  /*
   * 任務／渦：進房前就把牌換好。包的是實例上的 create（遮蔽 prototype 那顆）。
   * create 可能是 async；回傳值像 Promise 就把收尾接在後面。
   * 換房回報也在這裡就地發，不是只靠 500ms 的輪詢（直達跳房時差那半秒就會錯）。
   */
  var PRELOAD = { Quest: "quest", Raid: "raid" };
  function wrapCreate(name, sc) {
    for (var i = 0; i < st.creates.length; i++) {
      if (st.creates[i].scene === sc) return;
    }
    var orig = sc.create;
    if (typeof orig !== "function") return;
    var key = PRELOAD[name];
    var patched = function () {
      var want = null;
      try {
        want = wantFor(key);
        if (want !== null) preload(this, want, key);
      } catch (e) {
        want = null;
      }
      var self = this;
      var out = orig.apply(this, arguments);
      var after = function () {
        try { roomChanged(key, want !== null); } catch (e) {}
        if (want !== null) setDeckLabel(self, want);
      };
      if (out !== null && out !== undefined && typeof out.then === "function") {
        try { out.then(after, after); } catch (e) { after(); }
      } else {
        after();
      }
      return out;
    };
    sc.create = patched;
    st.creates.push({ scene: sc, patched: patched });
  }

  /*
   * 亞城／迪城：選頻道那一下就把牌換好。包的是實例上的 channel_login(t)，
   * 在遊戲的處理跑之前先換牌、重畫、回報。
   */
  function wrapChannelLogin(sc) {
    for (var i = 0; i < st.logins.length; i++) {
      if (st.logins[i].scene === sc) return;
    }
    var orig = sc.channel_login;
    if (typeof orig !== "function") return;
    var patched = function (info) {
      try {
        var key = ulrRoomOfChannel(info);
        var want = wantFor(key);
        if (want !== null) {
          preload(this, want, key);
          try { if (typeof this.show_deck === "function") this.show_deck(); } catch (e) {}
          setDeckLabel(this, want);
        }
        if (key !== null) roomChanged(key, want !== null);
      } catch (e) { /* 換不了牌也不能擋玩家進頻道 */ }
      return orig.apply(this, arguments);
    };
    sc.channel_login = patched;
    st.logins.push({ scene: sc, patched: patched });
  }

  /*
   * deck_now 釘住（插件模式 = 1）。最後一道保險：箭頭本身由 patch-deck-edit 接管，
   * 萬一那邊還沒掛上，送出去的仍然是工作槽那一副。沒有指派牌組就不碰官方的 ◀▶。
   */
  function pinDeckSlot() {
    var K = scenes();
    if (K === null) return;
    var room = currentRoom();
    var want = wantFor(room);
    if (want === null || want.pin === null || want.pin === undefined) return;
    ["Quest", "Raid", "Match"].forEach(function (n) {
      var sc = activeScene(K, n);
      if (sc === null) return;
      if (sc.deck_now === undefined || sc.deck_now === want.pin) return;
      sc.deck_now = want.pin;
      try { if (typeof sc.show_deck === "function") sc.show_deck(); } catch (e) {}
      setDeckLabel(sc, want);
    });
  }

  /** 每一拍：補掛 socket、補包 create／channel_login、看房間換了沒。 */
  function sync() {
    st.wrapped = st.wrapped.filter(function (w) { return w.socket[w.method] === w.patched; });
    var targets = gateTargets();
    for (var i = 0; i < targets.length; i++) wrap(targets[i]);

    var K = scenes();
    if (K !== null) {
      for (var n in PRELOAD) {
        if (Object.prototype.hasOwnProperty.call(PRELOAD, n) && K[n]) wrapCreate(n, K[n]);
      }
      if (K.Match) wrapChannelLogin(K.Match);
    }

    pinDeckSlot();

    var room = currentRoom();
    if (room !== st.room) roomChanged(room, wantFor(room) !== null);
  }

  /**
   * Node 處理完了，放行。ok === false 表示寫不進去：這一房換房之前不再攔。
   */
  st.release = function (ok) {
    if (st.hold === null) return "no-hold";
    if (ok === false) st.gaveUp = currentRoom();
    return st.hold.release();
  };

  /** Node 推「還有沒有東西沒寫」。 */
  st.setPending = function (value) {
    st.pending = value === true;
    return "ok";
  };

  /**
   * Node 推模式與「每一房進去要用哪幾格」。見 RoomDeckPreload。
   * 整份換掉，不要合併 —— 刪掉的那副不該留著被套用。
   */
  st.setRoomDecks = function (json) {
    try {
      var data = JSON.parse(json) || {};
      st.mode = data.mode === "plugin" || data.mode === "official" ? data.mode : "off";
      st.decks = data.decks || {};
      return "ok";
    } catch (e) {
      return "error:" + String((e && e.message) || e);
    }
  };

  try { sync(); } catch (e) { st.reason = String((e && e.message) || e); }

  st.timer = setInterval(function () {
    if (window[FLAG] !== st) { clearInterval(st.timer); return; }
    try { sync(); } catch (e) { st.reason = String((e && e.message) || e); }
  }, CFG.pollIntervalMs);

  return JSON.stringify({
    installed: true, version: st.version, room: st.room, sockets: st.wrapped.length
  });
})()`;
}

/** 推「有沒有待寫入的牌組」給頁面。 */
export function buildRoomGatePendingExpression(pending: boolean): string {
  return `window.${FLAG} ? window.${FLAG}.setPending(${pending ? "true" : "false"}) : "not-installed"`;
}

/**
 * 推模式與「每一房進去要用哪幾格」給頁面。見 {@link RoomDeckPreload}。
 *
 * ⚠ 每次牌組庫、選擇或模式變動都要重推，否則進房時頁面塞的還是上一次那副 ——
 * 而它會**贏過** Node 隨後寫進來的那一份（頁面是在 create() 之前動手的）。
 */
export function buildRoomGateDecksExpression(payload: RoomGateDecks): string {
  return `window.${FLAG} ? window.${FLAG}.setRoomDecks(${embedJson(payload)}) : "not-installed"`;
}

/** 放行被攔下來的那一下開戰（＝ `buildRoomGateReleaseExpression(true)`）。 */
export const ROOM_GATE_RELEASE_EXPRESSION = `window.${FLAG} ? window.${FLAG}.release(true) : "not-installed"`;

/**
 * 放行，並告訴頁面寫成了沒。
 *
 * `ok === false` 時頁面在這一房**不再攔**，直到換房 —— 否則每按一次開戰都被
 * 攔一下再失敗一次。
 */
export function buildRoomGateReleaseExpression(ok: boolean): string {
  return `window.${FLAG} ? window.${FLAG}.release(${ok ? "true" : "false"}) : "not-installed"`;
}

export interface RoomGateStatus {
  installed: boolean;
  version: number | null;
  mode: DeckMode;
  room: GateRoom | null;
  /** 現在有沒有正攔著一下開戰。 */
  holding: boolean;
  /** 攔著的那個請求名。沒攔就是 `null`。 */
  heldEvent: string | null;
  pending: boolean;
  sockets: number;
  timeouts: number;
}

export const ROOM_GATE_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  var EMPTY = { installed: false, version: null, mode: "off", room: null,
    holding: false, heldEvent: null, pending: false, sockets: 0, timeouts: 0 };
  try {
    var st = window[FLAG];
    if (!st) return JSON.stringify(EMPTY);
    return JSON.stringify({
      installed: st.installed === true,
      version: st.version,
      mode: st.mode,
      // 當場重算，不要唸 st.room —— 那是「上次回報的」，玩家可能剛換房而輪詢還沒跑到。
      room: currentRoom(),
      holding: st.hold !== null,
      heldEvent: st.hold === null ? null : st.hold.event,
      pending: st.pending === true,
      sockets: (st.wrapped || []).length,
      timeouts: st.timeouts
    });
  } catch (e) {
    return JSON.stringify(EMPTY);
  }
})()`;

export function parseRoomGateStatus(raw: string): RoomGateStatus {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  const o = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const room = o["room"];
  const mode = o["mode"];
  return {
    installed: o["installed"] === true,
    version: typeof o["version"] === "number" ? o["version"] : null,
    mode: mode === "plugin" || mode === "official" ? mode : "off",
    room:
      room === "raid" || room === "alexandria" || room === "quest" || room === "dietherm"
        ? room
        : null,
    holding: o["holding"] === true,
    heldEvent: typeof o["heldEvent"] === "string" ? o["heldEvent"] : null,
    pending: o["pending"] === true,
    sockets: typeof o["sockets"] === "number" ? o["sockets"] : 0,
    timeouts: typeof o["timeouts"] === "number" ? o["timeouts"] : 0,
  };
}

export const ROOM_GATE_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window.${FLAG};
    if (!st) return "not-installed";
    try { if (st.timer !== undefined && st.timer !== null) clearInterval(st.timer); } catch (e) {}
    // ⚠ 拆之前一定要放行 —— 攔著的時候拆掉，那一下開戰就永遠不會送出去，
    // 而玩家的畫面已經是「已開始」了。
    try { if (st.hold !== null) st.hold.release(); } catch (e) {}
    var ws = st.wrapped || [];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      try {
        if (w.method && w.socket[w.method] === w.patched) delete w.socket[w.method];
        else if (!w.method && w.socket.emit === w.patched) delete w.socket.emit;
      } catch (e) {}
    }
    // 包住的 create／channel_login 也要還回去，否則拆掉插件之後進房還是會被塞牌。
    var cs = st.creates || [];
    for (var j = 0; j < cs.length; j++) {
      try { if (cs[j].scene.create === cs[j].patched) delete cs[j].scene.create; } catch (e) {}
    }
    var ls = st.logins || [];
    for (var k = 0; k < ls.length; k++) {
      try { if (ls[k].scene.channel_login === ls[k].patched) delete ls[k].scene.channel_login; } catch (e) {}
    }
    // 舊版（v7 以前）包的是頻道列表的 emit。
    var hs = st.channelHooks || [];
    for (var h = 0; h < hs.length; h++) {
      try { if (hs[h].list.emit === hs[h].patched) delete hs[h].list.emit; } catch (e) {}
    }
    delete window.${FLAG};
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
