/**
 * 進了哪一房、開戰前先套牌組（WP-19）
 * =====================================
 * 這支做三件事，三件都只能做在頁面裡：
 *
 * ```
 *   1. 玩家現在在哪一房       → 回報給 Node（Node 據此排上那一房的牌組）
 *   2. 開戰的那一下先攔下來   → Node 把牌組寫進 Deck1，寫完才放行
 *   3. deck_now 釘回 1        → Deck2/Deck3 是空的，切過去就是拿空牌上場
 * ```
 *
 * ## 四個開戰入口收斂成一道閘
 *
 * 2026-09-09 在跑著的客戶端上逐一挖出來的（`emit("…"` 精確比對，不是子字串）：
 *
 * ```
 *   任務  Quest.create()  quest_start 鈕的 pointerup
 *         → this.input.enabled = false
 *           this.quest_start_clicked()
 *           this.socket.emit("quest_start", id, map, region, index, deck_now)
 *
 *   渦    Raid.create()   raid_turn_ok 的 pointerup
 *         → this.socket.emit("raid_turn", id, raid_id, raid_turn, deck_now)
 *
 *   亞城  Match.room_quick()  → emit("quick_wait", id, deck_now, channel)
 *         Match.room_event()  → emit("room_event", id, deck_now, channel)
 *   迪城  Match.room_in()     → emit("room_in", id, channel, room_id, pass, deck_now)
 *         Match.room_make()   → emit("match_room_make", …, deck_now)
 * ```
 *
 * 四個全部是 `socket.emit`，所以**攔在 socket 這一層**就好，不必去包五個方法
 * ——那五個方法裡有三個是 `async` 而且把 emit 包在 `new Promise` 的 executor
 * 裡，從外面包會連同它們的 `once` 監聽一起錯位。
 *
 * ⚠ 攔的是**實例上的 `emit`**（自有屬性），不是 prototype。動 prototype 會連
 * 同其他場景、其他連線一起攔到，而拆的時候還原不回去。
 *
 * ## ⚠⚠ 一定要有看門狗
 *
 * 被攔下來的那一下，遊戲已經走過 `input.enabled = false` 與
 * `quest_start_clicked()` —— 也就是**按鈕已經變成「已開始」的樣子，而且玩家
 * 點不動任何東西**。Node 那邊只要沒回來（斷線、當掉、寫入卡住），玩家就卡死在
 * 那個畫面，只能重開遊戲。
 *
 * 渦房更徹底。2026-09-09 讀 `Raid.create()` 讀到 `raid_turn_ok` 的 pointerup
 * 在 emit **之前**就做完了這些：
 *
 * ```js
 *   this.raid_zone = this.add.zone(380,340,760,680).setDepth(2e3).setInteractive();
 *   n.setVisible(!1); this.raid_turn_back.setVisible(!1);   // 對話框整組收掉
 *   this.raid_turn_ok.setVisible(!1); …
 *   this.socket.emit("raid_turn", this.id, this.raid_id, this.raid_turn, this.deck_now)
 * ```
 *
 * 那個 `raid_zone` 是**蓋滿整個畫面、depth 2000 的吃輸入區**，而且只有伺服器
 * 回話才會拆掉。攔著不放的話玩家連退出都按不了。
 *
 * 所以頁面自己要有 {@link RoomGateOptions.holdTimeoutMs} 這道保險：時間到就
 * **原樣放行**。用舊牌組開打，比讓玩家卡死好 —— 而且那一局結束就自己修好了。
 *
 * ## 沒有待套用的東西就完全不攔
 *
 * `pending` 是 Node 推過來的旗標。它是 false 時 `emit` 原樣直通，一次額外的
 * 判斷都不會讓開戰變慢 —— 這是常態路徑（玩家早就在這一房待著）。
 *
 * ## 第 3 件事：`deck_now` 釘回 1（`pinDeckSlot`）
 *
 * 遊戲原本在房裡是把 `deck_now` 在 1→2→3 之間繞（2026-09-09 從跑著的客戶端
 * 讀的）：
 *
 * ```js
 *   deck_next.on("pointerup", () => {
 *     this.deck_now++;  if (this.deck_now > 3) this.deck_now = 1;
 *     this.deck_name.setText(`Deck${this.deck_now} `);
 *     this.deck_card(this[`deck${this.deck_now}`]);
 *   })
 * ```
 *
 * 但 **Deck2/Deck3 已經被插件清空了**（那是「三副共扣同一個卡池」的代價，見
 * `@ulr/deck-library` 檔頭）。所以那兩個箭頭只會把玩家帶到一副空牌，而
 * `deck_now` 正是 `quest_start` / `raid_turn` / `room_in` 送出去的那個參數 ——
 * **停在 Deck2 按下 START 就是拿一副空牌打任務**。2026-09-09 實機上量到的正是
 * 這個狀態：`deck_now = 2`、`deck2.charaIndex = [null, null, null]`。
 *
 * ⚠ 這個 bug **開戰閘門救不了**：閘門寫的是 Deck1，而 emit 帶出去的是 2。
 *
 * ## ⚠ 箭頭與選單**不在這支**，在 `patch-deck-edit.ts`
 *
 * 任務房底下那一排跟牌組編輯畫面**一模一樣**（實機量到 `edit_icon(32,644)` ＋
 * 兩顆 `edit_arrow(16/48,644)`），所以整套選單直接沿用那邊的 `mount()` ——
 * 玩家在房裡按那顆棕色牌盒，跳出來的就是同一個選單。
 *
 * ⚠ **渦房少了那顆棕色牌盒**（`Raid.create()` 裡沒有 `edit_icon`，只有箭頭），
 * 所以 `patch-deck-edit` 會自己補一顆上去。細節在那支的檔頭。
 *
 * 這支只留 `pinDeckSlot()` 當**最後一道保險**：那邊還沒掛上、或哪天掛失敗時，
 * 送出去的仍然是工作槽那一副。兩邊都去搶那兩顆箭頭的話會互相拆掉對方的
 * handler，而症狀是「有時候有效有時候沒效」。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在 template literal 裡，
 * 一個反引號就把字串截斷 —— 症狀是一整片指不到真正問題的 TS1005/TS1109。
 * 所以詳細的東西寫在這個檔頭（它在字串外面），腳本裡只留短註解。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。 */
const FLAG = "__ulrRoomGate";

/**
 * 腳本版本。**改了注入邏輯就要加一。**
 *
 * 判斷「頁面上跑的是不是新版」只能靠它 —— 看行為會讓你去改本來正確的程式碼
 * （這個專案在 `ws-events` 與 `patch-ok` 上各栽過一次）。
 */
export const ROOM_GATE_SCRIPT_VERSION = 4;

/** 多久看一眼玩家換房沒有。 */
export const DEFAULT_ROOM_GATE_POLL_MS = 500;

/**
 * 攔下來最多等多久（毫秒）。時間到就原樣放行，見檔頭「一定要有看門狗」。
 *
 * 8 秒是這樣來的：慢路徑寫一次 Deck1 是「`db_editdeck` + 讀回來對過」，實測
 * 各 4 秒逾時，所以最壞情況約 8 秒。設更短會在伺服器慢的時候放掉本來寫得完的
 * 那一次，設更長則是玩家盯著一個沒反應的畫面。
 */
export const DEFAULT_HOLD_TIMEOUT_MS = 8_000;

/**
 * 要攔的開戰事件。
 *
 * ⚠ `room_event`（活動房）跟 `quick_wait` 一樣帶 `deck_now`，一起攔 ——
 * 漏掉它的症狀是「活動房打起來用的是上一房的牌」，而那種 bug 玩家只會在
 * 輸掉之後才發現。
 */
export const GATED_EVENTS: readonly string[] = [
  "quest_start",
  "raid_turn",
  "quick_wait",
  "room_event",
  "room_in",
  "match_room_make",
] as const;

/** 頁面認得的房型鍵。跟 `@ulr/deck-library` 的 `RoomKind` 同一組字。 */
export type GateRoom = "raid" | "alexandria" | "quest" | "dietherm";

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
   * ⚠⚠ 這個旗標是 Node 的**必要**資訊，不是裝飾。它是 true 時：
   *
   * ```
   *   客戶端記憶體  = 這一房的牌組（頁面剛換的）
   *   伺服器        = 還是上一副
   * ```
   *
   * 而 Node 判斷「要不要排隊寫伺服器」的基準是客戶端記憶體 —— 兩邊相等就不排。
   * 少了這個旗標，Node 會判定「已經是那一副了，不必寫」，於是**伺服器永遠停在
   * 上一副，而畫面完全正常**。開戰時送出去的 `deck_now=1` 指的是伺服器那一格，
   * 所以玩家會拿上一房的牌上場。這正是這個專案反覆踩到的那一種
   * 「客戶端記憶體 vs 伺服器」的錯位。
   */
  preloaded?: boolean;
}

/**
 * 每一房「進去就該用的那一副」，Node 事先推給頁面。
 *
 * ## ⚠ 這是唯一會把牌組內容下放到頁面的東西
 *
 * `patch-deck-edit.ts`（選單）刻意**不知道**任何牌組內容 —— 它只畫名字，決定
 * 權整個在 Node。那條規矩沒有改：這裡放的不是決定權，是**畫面來得及畫**所需的
 * 資料。
 *
 * 理由是時序，不是偏好。原本的流程是「頁面每 500ms 發現換房了 → 回報 Node →
 * Node 寫回客戶端記憶體」，所以玩家進房後會先看到**上一房的牌**約半秒。而房間
 * 場景是在 `create()` 裡就把三張卡畫出來的（實機讀到 Quest 直接 inline 讀
 * `this.deck1.chara[i]`、Raid 是 `this.deck_card(this.deck1)`、Match 是
 * `this.deck1.cost`）—— 要一幀都不閃，只能在 `create()` **跑之前**就把
 * `this.deck1` 換掉，而那個時間點沒有機會去問 Node。
 *
 * ⚠ Node 仍然是唯一的真相：頁面只認得「這一房用這一份」，不會自己挑、不會自己
 * 存、也不寫伺服器。庫、選擇、寫入全部還在 Node。
 */
export interface RoomDeckPreload {
  /** 要塞進 `scene.deck1` 的東西。形狀跟遊戲自己的一樣。 */
  deck: {
    chara: (string | null)[];
    charaIndex: (number | null)[];
    eventIndex: (number | null)[];
    weapon: (number | null)[];
    cost: number;
  };
  /** 左下那行字要寫什麼（原版寫死「Deck1」）。 */
  name: string;
}

/**
 * 開戰被攔下來了，**Node 必須回應**（`release` 或 `cancel`），否則看門狗接手。
 */
export interface RoomGateHoldReport {
  type: "room-gate-hold";
  /** 被攔下來的事件名。 */
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

/**
 * 房間偵測與 socket 包裝的共用片段。
 *
 * ⚠ **頻道看 `type`，不寫死編號。** 亞城是 1(ranked)、迪城是 2(duel)、
 * 布萊德克洛伊茲是 4(duel, crossplay)，但官方多開一組頻道時寫死的版本會把
 * 新頻道判成「不是任何一房」，然後那裡永遠不會自動套牌組。這條規矩跟
 * `patch-lobby.ts` 的 `duelChannel()` 是同一條。
 */
const SHARED = `
  var FLAG = "${FLAG}";
  var GATED = ${embedJson([...GATED_EVENTS])};

  function scenes() {
    var g = window.game;
    return (g && g.scene && g.scene.keys) || null;
  }

  function activeScene(K, name) {
    var sc = K[name];
    try { return sc && sc.scene.isActive() ? sc : null; } catch (e) { return null; }
  }

  /** 玩家現在在哪一房。認不出來回 null。 */
  function currentRoom() {
    var K = scenes();
    if (K === null) return null;
    if (activeScene(K, "Quest") !== null) return "quest";
    if (activeScene(K, "Raid") !== null) return "raid";
    var m = activeScene(K, "Match");
    if (m !== null) {
      // 還在選頻道 → 還沒進任何一房。這時候套牌組是錯的：玩家可能正要去
      // 另一個頻道，而換牌組會連帶換掉他看到的房間列表（COST 篩選）。
      if (m.channel === undefined || m.channel === null) return null;
      var key = String(m.channel);
      var info = (m.channels && m.channels[key]) || (m.channels_cross && m.channels_cross[key]);
      if (!info) return null;
      return info.type === "duel" ? "dietherm" : "alexandria";
    }
    return null;
  }

  /*
   * 哪些場景可以「進去之前就把牌換好」（見檔外的 RoomDeckPreload）。
   *
   * ⚠ Match 不在裡面，而且不能加：亞城與迪城是同一個 Match 場景，是哪一房要看
   * 玩家選了哪個頻道 —— 而 create() 跑的時候他還沒選（currentRoom 在那個當下
   * 回的正是 null）。硬要在那裡挑一副，就是有一半機率把錯房的牌塞進去。
   * Match 走原本那條路：回報換房 → Node 寫回來。
   */
  var PRELOAD = { Quest: "quest", Raid: "raid" };

  /** 現在有哪些 socket 值得攔（開戰的 emit 都從這幾個場景出去）。 */
  function gateTargets() {
    var K = scenes();
    if (K === null) return [];
    var out = [];
    ["Quest", "Raid", "Match"].forEach(function (n) {
      var sc = K[n];
      if (!sc) return;
      [sc.socket, sc.socket_cross].forEach(function (s) {
        if (s && typeof s.emit === "function" && out.indexOf(s) < 0) out.push(s);
      });
    });
    return out;
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

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== undefined && st.timer !== null) clearInterval(st.timer); } catch (e) {}
    try { if (st.hold !== null) st.hold.release(); } catch (e) {}
    unwrapAll(st);
    // ⚠ 舊版沒有 creates，所以要擋一下 —— 不擋的話重裝會在這裡丟例外，
    // 而整支腳本就裝不上去了。
    try { if (st.creates) unwrapCreates(st); } catch (e) {}
    delete window[FLAG];
  }

  function unwrapAll(st) {
    for (var i = 0; i < st.wrapped.length; i++) {
      var w = st.wrapped[i];
      try {
        // ⚠ 只有那顆 emit 還是我們裝的那一顆才還原。遊戲自己換過一次 socket
        // 的話，把舊的還原上去會蓋掉新的。
        if (w.socket.emit === w.patched) delete w.socket.emit;
      } catch (e) {}
    }
    st.wrapped = [];
  }

  restore();

  var st = {
    version: CFG.version,
    installed: true,
    /** Node 說「有一副牌還沒寫進 Deck1」。false 時 emit 原樣直通。 */
    pending: false,
    /** 上一次回報出去的房型，用來只在變動時回報。 */
    room: null,
    /** 正被攔著的那一下。同一時間只會有一個。 */
    hold: null,
    wrapped: [],
    /** 被我們包住 create 的場景（見 wrapCreate）。 */
    creates: [],
    /** 每一房「進去就該用的那一副」，Node 推來的。見 RoomDeckPreload。 */
    decks: {},
    timer: null,
    holds: 0,
    timeouts: 0
  };
  window[FLAG] = st;

  /**
   * 把一顆 socket 的 emit 換成帶閘門的版本。
   *
   * ⚠ 回傳值原樣傳回去。實測那四個呼叫端都沒有用它，但**攔下來的那一次沒有
   * 回傳值可傳** —— 這是這道閘唯一改變的東西，所以只在真的攔下來時回
   * undefined。
   */
  function wrap(socket) {
    for (var i = 0; i < st.wrapped.length; i++) {
      if (st.wrapped[i].socket === socket) return;
    }
    var orig = socket.emit;
    var patched = function (ev) {
      try {
        if (st.pending === true && st.hold === null && GATED.indexOf(ev) >= 0) {
          var self = this;
          var args = Array.prototype.slice.call(arguments);
          var done = false;

          var fire = function (why) {
            if (done) return "already";
            done = true;
            st.hold = null;
            try { if (t !== null) clearTimeout(t); } catch (e) {}
            if (why === "cancel") return "cancelled";
            // ⚠ 用 orig，不要再走一次 patched —— 那會再攔一次，變成無窮迴圈。
            try { orig.apply(self, args); } catch (e) {}
            return "released";
          };

          var t = setTimeout(function () {
            if (done) return;
            st.timeouts++;
            report({ type: "room-gate-timeout", event: String(ev) });
            fire("timeout");
          }, CFG.holdTimeoutMs);

          st.hold = { event: String(ev), at: Date.now(), release: fire };
          st.holds++;
          report({ type: "room-gate-hold", event: String(ev), room: currentRoom() });
          return undefined;
        }
      } catch (e) {
        // 閘門自己出事的話一律放行 —— 絕不能因為我們的東西讓玩家開不了戰。
      }
      return orig.apply(this, arguments);
    };
    socket.emit = patched;
    st.wrapped.push({ socket: socket, patched: patched, orig: orig });
  }

  /*
   * 進房前就把牌換好 —— **這是「一幀都不閃」的唯一辦法**。
   *
   * ⚠⚠ 這一段住在 template literal 裡，**不能出現反引號**。完整說明在檔頭與
   * RoomDeckPreload 的註解。
   *
   * 包的是**實例上的 create**（自有屬性遮蔽 prototype 上那顆，實機確認三個房
   * 的 create/init 都在 prototype 上）。動 prototype 會連別的東西一起改到，
   * 而且還原不回去。
   *
   * 時序（實機讀 create() 的原始碼定出來的）：
   *
   *   init()      非同步，把 deck1/deck2/deck3 抓回來
   *   create()    ← 我們在這裡最前面把 this.deck1 換掉
   *                 接著遊戲自己把三張卡畫出來，用的就是我們那一份
   *
   * ⚠ create 可能是 async。回傳值像 Promise 就把收尾接在後面 —— 直接跑收尾的話
   * deck_name 還沒被建出來，那行字就改不到。
   *
   * ## ⚠⚠ 換房回報也在這裡發，不是只靠那 500ms 的輪詢
   *
   * 腳本外面有人**直接用 game.scene.start("Raid") 跳房間**（不繞大廳；
   * 月的自動化就是這樣走的，它叫「直達」）。輪詢當然也看得到，但那是
   * **最多晚半秒**才看得到，而直達的呼叫端往往跳完就立刻動作 —— 那半秒
   * 裡托盤還以為玩家在上一房，於是：
   *
   *     · 進房要套的那一副晚半秒才排進隊伍（等候秒數從那時候才開始算）
   *     · 這半秒內任何一則牌組回報，autoSave 用的都是**上一房**的身分
   *
   * 而 create() 正是「這一房開始了」最早、也最準的那一刻 —— preload 就是在
   * 這裡做的，回報跟它擺在一起才不會有時間差。
   *
   * ⚠ want 是 null（這一房還沒有牌組可套）**也要回報**。房型換了是事實，
   * 跟有沒有牌可套是兩件事；只在有牌時回報的話，玩家在空的那一房裡，托盤會
   * 一直以為他還在上一房。
   */
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
        want = st.decks[key] || null;
        // ⚠ 整個物件換掉，跟遊戲自己的 reset 鈕一樣 —— 就地改欄位的話，畫面上
        // 的 cost 標籤不會跟著重算。
        if (want !== null) this.deck1 = want.deck;
      } catch (e) {
        want = null;
      }
      var self = this;
      var out = orig.apply(this, arguments);
      var after = function () {
        // 換房要就地回報，preload 有沒有東西可套都一樣 —— 見下面那段 ⚠⚠。
        try {
          if (st.room !== key) {
            st.room = key;
            report({ type: "room-changed", room: key, preloaded: want !== null });
          }
        } catch (e) {}
        if (want === null) return;
        try {
          self.deck_now = 1;
          if (self.deck_name && typeof self.deck_name.setText === "function") {
            self.deck_name.setText(want.name + " ");
          }
        } catch (e) {}
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

  /** 把 create 還原回去。⚠ 只還原還是我們裝的那一顆。 */
  function unwrapCreates(state) {
    for (var i = 0; i < state.creates.length; i++) {
      var c = state.creates[i];
      try { if (c.scene.create === c.patched) delete c.scene.create; } catch (e) {}
    }
    state.creates = [];
  }

  /*
   * deck_now 釘回 1 —— **最後一道保險**。
   *
   * ⚠⚠ 這一段住在 template literal 裡，所以**整段不能出現反引號**（會直接把
   * 字串截斷，症狀是一整片看不懂的 TS1005/TS1109）。完整說明寫在檔頭。
   *
   * 箭頭本身由 patch-deck-edit 接管（它把整排牌組列連同選單一起掛上去）。
   * 這裡只負責：萬一那邊還沒掛上、或哪天掛失敗了，送出去的仍然是工作槽那一副。
   * 標籤也要一起改回去，不然畫面上會留著一個「Deck2」指著其實是 Deck1 的內容。
   */
  function pinDeckSlot() {
    var K = scenes();
    if (K === null) return;
    ["Quest", "Raid", "Match"].forEach(function (n) {
      var sc = activeScene(K, n);
      if (sc === null) return;
      if (sc.deck_now === undefined || sc.deck_now === 1) return;
      sc.deck_now = 1;
      try {
        if (sc.deck_name && typeof sc.deck_name.setText === "function") {
          sc.deck_name.setText("Deck1 ");
        }
      } catch (e) {}
      try {
        if (typeof sc.change_deck === "function") sc.change_deck(0);
        else if (typeof sc.deck_card === "function" && sc.deck1) sc.deck_card(sc.deck1);
      } catch (e) { /* 重畫失敗不影響 deck_now 已經被釘回去 */ }
    });
  }

  /** 每一拍：補掛 socket、看房間換了沒、把房裡的 ◀▶ 接過來。 */
  function sync() {
    // 遊戲換過 socket（重連、換場）時舊的那筆就不再是我們裝的那顆了，清掉，
    // 否則 wrapped 會無限長大。
    st.wrapped = st.wrapped.filter(function (w) { return w.socket.emit === w.patched; });
    var targets = gateTargets();
    for (var i = 0; i < targets.length; i++) wrap(targets[i]);

    // ⚠ 每一拍都補包一次。場景實例是長命的（Phaser 的 game.scene.keys.Raid
    // 從開機就在），所以通常第一拍就包完了 —— 但遊戲重載之後那些實例是全新的，
    // 而重載不會斷 CDP 連線。少了補包，重載後進房又會閃一下舊牌。
    var K = scenes();
    if (K !== null) {
      for (var n in PRELOAD) {
        if (Object.prototype.hasOwnProperty.call(PRELOAD, n) && K[n]) wrapCreate(n, K[n]);
      }
    }

    pinDeckSlot();

    var room = currentRoom();
    if (room !== st.room) {
      st.room = room;
      // ⚠ preloaded 一定要帶。Node 靠它知道「客戶端記憶體已經是新的、但伺服器
      // 還是舊的」—— 少了它，伺服器那一份永遠不會被寫。見 RoomChangedReport。
      report({
        type: "room-changed",
        room: room,
        preloaded: room !== null && !!st.decks[room]
      });
    }
  }

  /** Node 寫完牌組了，放行。 */
  st.release = function () {
    if (st.hold === null) return "no-hold";
    return st.hold.release("ok");
  };

  /** Node 決定不放行（寫入失敗且不該開打）。⚠ 目前沒有呼叫端，留著是為了對稱。 */
  st.cancel = function () {
    if (st.hold === null) return "no-hold";
    return st.hold.release("cancel");
  };

  /** Node 推「還有沒有東西沒寫」。 */
  st.setPending = function (value) {
    st.pending = value === true;
    return "ok";
  };

  /**
   * Node 推「每一房進去要用哪一副」。見 RoomDeckPreload。
   *
   * ⚠ 整份換掉，不要合併 —— 玩家刪掉一副之後那一房該變成沒有，而合併會把
   * 刪掉的那份留著，於是進房套用的是一副已經不存在的牌。
   */
  st.setRoomDecks = function (json) {
    try {
      st.decks = JSON.parse(json) || {};
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
 * 推「每一房進去要用哪一副」給頁面。見 {@link RoomDeckPreload}。
 *
 * ⚠ 每次牌組庫或選擇變動都要重推，否則玩家換了選擇之後，進房時頁面塞的還是
 * 上一次那副 —— 而它會**贏過** Node 隨後寫進來的那一份（頁面是在 create()
 * 之前動手的，比較早）。
 */
export function buildRoomGateDecksExpression(
  decks: Partial<Record<GateRoom, RoomDeckPreload>>,
): string {
  return `window.${FLAG} ? window.${FLAG}.setRoomDecks(${embedJson(decks)}) : "not-installed"`;
}

/** 放行被攔下來的那一下開戰。 */
export const ROOM_GATE_RELEASE_EXPRESSION = `window.${FLAG} ? window.${FLAG}.release() : "not-installed"`;

export interface RoomGateStatus {
  installed: boolean;
  version: number | null;
  room: GateRoom | null;
  /** 現在有沒有正攔著一下開戰。 */
  holding: boolean;
  /** 攔著的那個事件名。沒攔就是 `null`。 */
  heldEvent: string | null;
  pending: boolean;
  sockets: number;
  timeouts: number;
}

export const ROOM_GATE_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({ installed: false, version: null, room: null,
        holding: false, heldEvent: null, pending: false, sockets: 0, timeouts: 0 });
    }
    return JSON.stringify({
      installed: st.installed === true,
      version: st.version,
      // ⚠ **當場重算**，不要唸 st.room —— 那是「上次回報的」，玩家可能剛換房
      // 而輪詢還沒跑到。
      room: currentRoom(),
      holding: st.hold !== null,
      heldEvent: st.hold === null ? null : st.hold.event,
      pending: st.pending === true,
      sockets: st.wrapped.length,
      timeouts: st.timeouts
    });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, room: null,
      holding: false, heldEvent: null, pending: false, sockets: 0, timeouts: 0 });
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
  return {
    installed: o["installed"] === true,
    version: typeof o["version"] === "number" ? o["version"] : null,
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
    try { if (st.hold !== null) st.hold.release("ok"); } catch (e) {}
    for (var i = 0; i < st.wrapped.length; i++) {
      var w = st.wrapped[i];
      try { if (w.socket.emit === w.patched) delete w.socket.emit; } catch (e) {}
    }
    // 包住的 create 也要還回去，否則拆掉插件之後進房還是會被塞牌。
    // ⚠ 只還原還是我們裝的那一顆；舊版沒有 creates，所以要擋一下。
    var cs = st.creates || [];
    for (var j = 0; j < cs.length; j++) {
      try { if (cs[j].scene.create === cs[j].patched) delete cs[j].scene.create; } catch (e) {}
    }
    delete window.${FLAG};
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
