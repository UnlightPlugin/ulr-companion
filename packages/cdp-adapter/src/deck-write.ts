/**
 * 讀寫玩家的三副牌組（WP-18）
 * ============================
 * 本地牌組庫要能「瞬間換牌組」，靠的是繞過牌組編輯畫面直接送 `db_editdeck`。
 * 這支負責那條路徑。**協定與服務分池都是 2026-08-24 實機挖出來的**，不是猜的。
 *
 * ## ⚠ 寫 Deck1 會連帶換掉大廳立繪
 *
 * `Lobby.init` **寫死讀 `db_deck1`**（2026-08-25 實測），立繪取它的第一格。
 * Deck1 是牌組庫的工作槽，所以換牌組就會換掉大廳站的人。玩家要固定立繪的話
 * 去 Library 設「最愛角色」—— 設了之後 Deck1 寫什麼都不影響大廳，見
 * {@link DeckSnapshot.favorite}。
 *
 * 而且是**進場景時**才讀，之後不重讀：玩家已經站在大廳時寫進去，要等他離開
 * 再回來才看得到。
 *
 * ## 存牌組只有一個事件，而且一次覆寫三副
 *
 * ```
 *   emit("db_editdeck", id, deck1, deck2, deck3, uiFlag)   → 伺服器回同名事件當 ack
 * ```
 *
 * 原版客戶端只在**離開 Edit 畫面時**送一次（`scene_end().then(...)`）。
 * 第 5 個參數是 `player.deck_check`（游標顯示資訊的 UI 偏好），跟牌組無關 ——
 * 照原值帶回去就不會動到玩家設定。
 *
 * ⚠ 送出去的形狀跟讀回來的**不一樣**：`db_deck*` 讀回來是扁平的
 * `chara1..3 / event1..18`，送出去要的是 `{chara[], charaIndex[], eventIndex[],
 * weapon[], cost}`。
 *
 * ## ⚠⚠ 必須送到 game 服務，不是玩家當下那條 socket
 *
 * 遊戲的服務是**分池**的，每個場景各自 `new WSClient(隨機挑一個)`：
 *
 * ```
 *   game  : playunlight.online:11002-11011   ← db_editdeck 歸這裡
 *   duel  : playunlight.online:11012-11015   ← Match（配對大廳）在這，只管配對
 *   cross : playunlight-dmm.com:20002-20005
 * ```
 *
 * 2026-08-24 實測：從 Match 場景那條 socket（`:11013`）送 `db_editdeck`，
 * **伺服器完全沒反應** —— 沒有 ack，牌組也沒變。換成自己開一條到 game 池的
 * 連線送同樣的東西，立刻 ack 而且生效。
 *
 * 所以這支自己開一條 WSClient。`Edit.init` 就是這樣做的（沒有專用的 Edit
 * 服務，它也是從 game 池隨機挑），而且**不需要 `register`** —— 玩家 id 就是
 * 憑證，直接 `fetch("db_player", id)` 就有東西。
 *
 * ## ⚠ 寫完一定要同步客戶端記憶體
 *
 * 只寫伺服器的話有兩個問題：畫面不會變；更糟的是玩家若停在 Edit 畫面，**他
 * 離開時客戶端會用自己記憶體裡的舊 deck 再送一次 `db_editdeck`，把你寫的蓋掉**。
 * 所以 {@link buildDeckApplyExpression} 會把每個場景的 `deck1/2/3` 一起更新 ——
 * 這樣玩家之後離開 Edit 送出的那一次，帶的正是新內容。
 */

import { embedJson } from "./embed.js";

/** 送給 `db_editdeck` 的一副牌組。**這是送出去的形狀，不是讀回來的。** */
export interface DeckPayload {
  chara: (string | null)[];
  charaIndex: (number | null)[];
  /** 18 格。 */
  eventIndex: (number | null)[];
  weapon: (number | null)[];
  /** 伺服器自己會算，這裡帶什麼都行；帶原值可以少一次畫面跳動。 */
  cost: number;
}

/** `db_deck*` 讀回來的扁平物件（`chara1`、`charaIndex1`、`event1`…）。 */
export type FlatDeck = Record<string, unknown>;

/**
 * 在頁面裡建立（或取回）我們自己的 game 服務連線。
 *
 * 存在 `window.__ulrDeckSock`，跨呼叫重用 —— 每次都開一條新的話，玩家連按
 * 幾下換牌組就會留下一串閒置連線。
 */
const DECK_SOCKET_SETUP = `
  var g = window.game;
  if (!g) throw new Error("遊戲還沒起來");
  var host = null, names = Object.keys(g.scene.keys);
  for (var i = 0; i < names.length; i++) {
    var s = g.scene.keys[names[i]];
    if (s.socket && s.id) { host = s; break; }
  }
  if (!host) throw new Error("找不到可借用 WSClient 與玩家 id 的場景");
  if (!window.__ulrDeckSock) {
    var cfg = UL_CONFIG.domains.game;
    var url = cfg.urls[0] + ":" + cfg.ports[Math.floor(Math.random() * cfg.ports.length)];
    window.__ulrDeckSock = new (host.socket.constructor)(url);
    window.__ulrDeckSockUrl = url;
  }
  // ⚠ id 每次都從場景重讀，不快取 —— 玩家換帳號登入時快取的會是上一個人的
  var sock = window.__ulrDeckSock, pid = host.id;
`;

/**
 * 帳號指紋：玩家 id 的 SHA-256 前 8 個 hex。
 *
 * ⚠ 規格書 §12：id 是高熵字串，**不得離開本機**。牌組庫要分辨「這份庫是誰
 * 的」、雲端要分租戶，靠的都是這個指紋 —— 它反推不回 id。
 */
const FINGERPRINT_SNIPPET = `
  var __enc = new TextEncoder().encode(String(pid));
  var __buf = await crypto.subtle.digest("SHA-256", __enc);
  var __fp = Array.from(new Uint8Array(__buf)).slice(0, 4)
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
`;

/** 讀回來的一份快照。 */
export interface DeckSnapshot {
  /** 帳號指紋（8 hex）。 */
  account: string;
  /** 玩家顯示名稱，給人看的。讀不到是 `null`。 */
  accountLabel: string | null;
  /**
   * `player.deck` 的原值。
   *
   * ⚠ **這個欄位沒有任何場景會讀**（2026-08-25 掃過全部場景，只有
   * `player.deck_check` 被讀）。真正決定開戰用哪一副的是各場景自己的
   * `deck_now`，跟著開戰的 emit 送出去 —— 別拿這個欄位當「玩家現在用第幾副」。
   */
  deckNow: number | null;
  /**
   * `player.favorite`（`"cc069"` 這種字串，沒設是 `null`）。玩家在 Library
   * 設的「最愛角色」。
   *
   * ⚠ **這個欄位決定了換牌組會不會動到大廳立繪。** `Lobby.loader` 在
   * `favorite !== null` 時直接用它覆寫 `deck.chara[0]`：
   *
   * - `null` → 大廳站的是 Deck1 第一格，**換牌組就會換人**
   * - 有值   → 大廳站的固定是那個角色，Deck1 寫什麼都不影響畫面
   *
   * 玩家抱怨「換牌組害我大廳的人一直變」時，答案是去 Library 設一個。
   */
  favorite: string | null;
  /** `player.deck_check`，寫回去時要照原值帶。 */
  deckCheck: boolean;
  /** 三副的原樣內容，索引 0 是 Deck1。 */
  decks: FlatDeck[];
  /** 這次用的是哪個 game 端點，診斷用。 */
  endpoint: string;
}

/** 讀出三副牌組與帳號指紋。 */
export const DECK_READ_EXPRESSION = `(async function () {
  try {
    ${DECK_SOCKET_SETUP}
    ${FINGERPRINT_SNIPPET}
    var player = await sock.fetch("db_player", pid);
    var decks = [];
    for (var n = 1; n <= 3; n++) decks.push(await sock.fetch("db_deck" + n, pid));
    return JSON.stringify({
      account: __fp,
      accountLabel: (player && player.name) || null,
      deckNow: player && typeof player.deck === "number" ? player.deck : null,
      favorite: (player && player.favorite) || null,
      deckCheck: !(player && player.deck_check === 0),
      decks: decks,
      endpoint: window.__ulrDeckSockUrl
    });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

function parseOrThrow(raw: string, what: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${what}：頁面回傳的不是 JSON`);
  }
  if (typeof data !== "object" || data === null) throw new Error(`${what}：頁面回傳的不是物件`);
  const rec = data as Record<string, unknown>;
  if (typeof rec.error === "string") throw new Error(`${what}：${rec.error}`);
  return rec;
}

export function parseDeckSnapshot(raw: string): DeckSnapshot {
  const rec = parseOrThrow(raw, "讀牌組");
  const decks = Array.isArray(rec.decks) ? (rec.decks as FlatDeck[]) : [];
  if (decks.length !== 3) throw new Error(`讀牌組：預期三副，拿到 ${decks.length} 副`);
  const account = typeof rec.account === "string" ? rec.account : "";
  if (!/^[0-9a-f]{8}$/.test(account)) throw new Error("讀牌組：帳號指紋的格式不對");
  return {
    account,
    accountLabel: typeof rec.accountLabel === "string" ? rec.accountLabel : null,
    deckNow: typeof rec.deckNow === "number" ? rec.deckNow : null,
    favorite: typeof rec.favorite === "string" && rec.favorite !== "" ? rec.favorite : null,
    deckCheck: rec.deckCheck !== false,
    decks,
    endpoint: typeof rec.endpoint === "string" ? rec.endpoint : "",
  };
}

/** 寫入的結果。 */
export interface DeckApplyResult {
  /** 伺服器有沒有回 ack。**沒有 ack 就是沒寫進去**（見檔頭的服務分池）。 */
  ack: boolean;
  /** 記憶體被同步到的場景名。空的表示沒有場景載入過牌組。 */
  synced: string[];
  /** 畫面刷新做了什麼，沒做是 `null`。 */
  refreshed: string | null;
}

/**
 * 建立「寫入三副牌組」的表達式。
 *
 * @param decks 三副，索引 0 是 Deck1。
 * @param deckCheck `player.deck_check` 的原值，照帶回去。
 *
 * ⚠ 頁面端**還有一道 Deck1 非空的閘門**。呼叫端（`@ulr/deck-library` 的
 * `guardDeck1`）已經擋過一次，這裡再擋一次是故意的：寫空了會讓玩家在牌組
 * 編輯畫面的**兩個出口都出不去**，卡死在裡面。這種等級的後果值得兩道鎖。
 */
export function buildDeckApplyExpression(decks: DeckPayload[], deckCheck: boolean): string {
  return `(async function () {
  try {
    ${DECK_SOCKET_SETUP}
    var D = JSON.parse(${embedJson(decks)});
    if (D.length !== 3) return JSON.stringify({ error: "要三副，拿到 " + D.length + " 副" });
    if (D[0].charaIndex[0] === null || D[0].charaIndex[0] === undefined) {
      return JSON.stringify({ error: "拒絕寫入：Deck1 第一格是空的，會讓玩家卡死在牌組編輯畫面" });
    }

    var ackP = new Promise(function (resolve) {
      sock.once("db_editdeck", function () { resolve(true); });
      setTimeout(function () { resolve(false); }, 4000);
    });
    sock.emit("db_editdeck", pid, D[0], D[1], D[2], ${deckCheck ? "true" : "false"});
    var ack = await ackP;

    // 同步客戶端記憶體，見檔頭「寫完一定要同步客戶端記憶體」
    var synced = [];
    Object.keys(g.scene.keys).forEach(function (k) {
      var sc = g.scene.keys[k];
      for (var n = 1; n <= 3; n++) {
        var cur = sc["deck" + n];
        if (!cur || typeof cur !== "object" || cur.chara === undefined) continue;
        var src = D[n - 1];
        cur.chara = src.chara.slice();
        cur.charaIndex = src.charaIndex.slice();
        if (cur.eventIndex !== undefined) cur.eventIndex = src.eventIndex.slice();
        if (cur.weapon !== undefined) cur.weapon = src.weapon.slice();
        cur.cost = src.cost;
        if (synced.indexOf(k) < 0) synced.push(k);
      }
    });

    // 畫面刷新：Match 的大廳縮圖用遊戲自己的重繪
    var refreshed = null;
    var m = g.scene.keys.Match;
    if (m && m.scene.isActive() && typeof m.change_deck === "function" && m.deckCard) {
      try { m.change_deck(0); refreshed = "Match.change_deck"; }
      catch (e) { refreshed = "刷新失敗：" + String(e && e.message); }
    }

    // ⚠⚠ **牌組編輯畫面一定要重畫，而且它是最重要的那一個。**
    //
    // 換牌組的入口就開在這個畫面上，所以玩家幾乎一定正站在這裡 —— 而這裡是
    // 唯一「記憶體換了、畫面還是舊的」會被直接看見的地方。2026-08-27 玩家回報
    // 的「選了牌組，牌也沒變化」有一半是這個：牌其實換了，畫面沒重畫。
    //
    // edit_reflesh() 是遊戲自己的重繪（原版 ◀▶ 換牌組時呼叫的就是它），
    // 它照 deck_now 讀，所以要先確定 deck_now 是 1 —— 我們寫的一直是 Deck1。
    var ed = g.scene.keys.Edit;
    if (ed && ed.scene.isActive() && typeof ed.edit_reflesh === "function") {
      try {
        ed.deck_now = 1;
        ed.edit_reflesh();
        refreshed = (refreshed ? refreshed + " + " : "") + "Edit.edit_reflesh";
      } catch (e) {
        refreshed = (refreshed ? refreshed + " + " : "") + "Edit 刷新失敗：" + String(e && e.message);
      }
    }
    return JSON.stringify({ ack: ack, synced: synced, refreshed: refreshed });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;
}

export function parseDeckApplyResult(raw: string): DeckApplyResult {
  const rec = parseOrThrow(raw, "寫牌組");
  return {
    ack: rec.ack === true,
    synced: Array.isArray(rec.synced) ? (rec.synced as string[]) : [],
    refreshed: typeof rec.refreshed === "string" ? rec.refreshed : null,
  };
}

/** 玩家的卡片庫存，形狀就是那幾個 `db_*` 的原樣回傳。 */
export interface InventorySnapshot {
  chara: Record<string, string>;
  event: Record<string, number | string>;
  weapon: Record<string, number | string>;
}

/**
 * 讀庫存 —— 「只用玩家真的有的卡」那條線靠它。
 *
 * ⚠ 這裡讀的是**整個庫存**，沒有扣掉三副牌組正在用的。牌組庫的前提是
 * Deck2/Deck3 已經清空、同時只有一副躺在伺服器上，所以整個庫存都是可用的。
 */
export const INVENTORY_READ_EXPRESSION = `(async function () {
  try {
    ${DECK_SOCKET_SETUP}
    return JSON.stringify({
      chara: await sock.fetch("db_characard", pid),
      event: await sock.fetch("db_eventcard", pid),
      weapon: await sock.fetch("db_item_weapon", pid)
    });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

export function parseInventorySnapshot(raw: string): InventorySnapshot {
  const rec = parseOrThrow(raw, "讀庫存");
  const table = (v: unknown): Record<string, never> =>
    typeof v === "object" && v !== null ? (v as Record<string, never>) : {};
  return {
    chara: table(rec.chara),
    event: table(rec.event),
    weapon: table(rec.weapon),
  };
}

/**
 * 讀**牌組編輯畫面正在編輯的那一副**（客戶端記憶體裡的 `Edit.deck1`）。
 *
 * ## ⚠ 為什麼不能只讀伺服器
 *
 * 玩家在編輯畫面拖卡片時，改的是**客戶端記憶體**；遊戲要等他**離開畫面**才
 * 送 `db_editdeck`（`scene_end().then(...)`，2026-08-28 從實機讀到）。所以人
 * 還站在那個畫面時，伺服器上的 Deck1 是**舊的**。
 *
 * 只讀伺服器的後果不是「晚一點才存到」那麼輕：玩家改完牌直接按 ◀▶ 換牌組時，
 * 插件看到的 Deck1 還是舊內容 → 判定「沒有編輯要存」→ 接著把目標牌組寫進
 * Deck1 並同步記憶體 —— **他剛剛排的牌當場消失，而且沒有任何訊息**。
 *
 * 回傳 `null` 表示牌組編輯畫面沒開著（那時候伺服器才是真相）。
 *
 * ⚠ 形狀是**陣列版**（`{chara, charaIndex, eventIndex, weapon, cost}`），
 * 跟 `db_deck*` 讀回來的扁平版不一樣 —— 用 `parseDeckContent()` 讀它，
 * 不要用 `deckContentFromFlat()`。
 */
export const EDIT_DECK_READ_EXPRESSION = `(function () {
  try {
    var g = window.game;
    if (!g) return JSON.stringify({ active: false });

    // ⚠⚠ **這支要跟 buildEditDeckWriteExpression() 認得一樣多的場景。**
    //
    // 它回答的是「玩家**現在眼前**那一副是什麼」，而那是所有比對的基準：
    // 「選的這副跟手上這副一不一樣」、自動存檔要不要存。
    //
    // 2026-09-09 踩過：寫入端教會了它認房間場景、讀取端沒有 —— 於是在任務房裡
    // 這支回 active:false，呼叫端退回去讀**伺服器**的 Deck1。而伺服器那份是
    // 刻意延後、還沒更新的舊資料，於是「選 Deck1」被拿去跟舊內容比，判成
    // 「一模一樣」→ 不寫、不重畫 → **玩家永遠換不到那一副**。
    //
    // 讀寫兩邊認的場景一旦不一致，症狀就是這種「有時候換不過去」。
    var order = ["Edit", "Quest", "Raid", "Match"];
    for (var i = 0; i < order.length; i++) {
      var sc = g.scene.keys[order[i]];
      if (!sc || !sc.scene.isActive()) continue;
      // ⚠ 一律讀 deck1：牌組庫把 Deck1 當唯一工作槽，而且頁面補丁把 deck_now
      // 釘死在 1。讀 deck_now 的話，玩家在補丁掛上之前切到過 2 就會讀錯一副。
      var d = sc.deck1;
      if (!d || d.chara === undefined) continue;
      return JSON.stringify({
        active: true,
        where: order[i] === "Edit" ? "edit" : "room",
        deck: {
          chara: d.chara, charaIndex: d.charaIndex,
          eventIndex: d.eventIndex, weapon: d.weapon,
          cost: typeof d.cost === "number" ? d.cost : 0
        }
      });
    }
    return JSON.stringify({ active: false });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

/**
 * **換牌組的快路徑：只動客戶端記憶體，一次網路都不跑。**
 *
 * ## 為什麼要有這條路
 *
 * 走伺服器的話，換一副牌要 8~11 趟 WebSocket（讀三副 → emit → 等 ack 最多
 * 4 秒 → 再讀回來驗證）。而原版左下角那兩個 ◀▶ **完全不碰網路**：
 *
 * ```js
 *   let t = this.deck_now - 1; if (t < 1) t = 3;
 *   this.switch_decks(t); this.deck_now = t; this.edit_reflesh();
 * ```
 *
 * 它換的是「畫面在畫哪一個記憶體物件」，等玩家**離開編輯畫面**才送一次
 * `db_editdeck`。自訂牌組要跟它一樣順，就得走同一條路。
 *
 * ## 照抄 reset 鈕（2026-08-28 從實機讀到）
 *
 * ```js
 *   this[`deck${this.deck_now}`] = { charaIndex:[…], chara:[…], eventIndex:[…],
 *                                    weapon:[…], cost:null };
 *   this.edit_reflesh();
 * ```
 *
 * ⚠ **整個物件換掉，不要就地改欄位。** 遊戲自己就是這樣做的，而 `edit_reflesh()`
 * 會把卡片、槽位與三個 cost 標籤全部重畫 —— cost 不必自己算。
 *
 * ⚠ 寫完**不上伺服器**。玩家離開編輯畫面時遊戲會自己送 `this.deck1`，而那時
 * 它裝的正是我們寫進去的內容。這也表示：遊戲被強制關掉（沒有正常離開畫面）時
 * 這次切換不會留在伺服器上 —— 跟玩家自己排牌沒存就關掉是同一種結果。
 *
 * 回 `not-active` 表示編輯畫面沒開著，呼叫端要退回走伺服器那條路。
 */
export function buildEditDeckWriteExpression(deck: DeckPayload, label?: string): string {
  return `(function () {
  try {
    var g = window.game;
    if (!g) return "not-active";
    var d = JSON.parse(${embedJson(deck)});
    // ⚠ 一定要 JSON.parse。embedJson() 給的是「要餵給 JSON.parse 的字串字面
    // 值」，直接用的話 label 會變成字串 "null" 而不是 null —— 症狀是遊戲裡
    // 那行小字真的印出「null」。
    var label = JSON.parse(${embedJson(label ?? null)});

    function load(sc) {
      // ⚠ 整個換掉，跟 reset 鈕一樣；deck_now 釘 1（牌組庫只用 Deck1 這個工作槽）
      sc.deck1 = {
        chara: d.chara, charaIndex: d.charaIndex,
        eventIndex: d.eventIndex, weapon: d.weapon, cost: d.cost
      };
      sc.deck_now = 1;
    }

    // ── 牌組編輯畫面 ────────────────────────────────────────────────────
    var ed = g.scene.keys.Edit;
    if (ed && ed.scene.isActive() && typeof ed.edit_reflesh === "function") {
      load(ed);
      ed.edit_reflesh();
      // ⚠ "ok" 專指**編輯畫面**。呼叫端靠它決定「還要不要寫伺服器」：遊戲會在
      // 玩家離開 Edit 時自己把它送上伺服器，所以那條路不必補寫。
      return "ok";
    }

    // ── 房間場景（任務／渦／對戰）──────────────────────────────────────
    //
    // ⚠⚠ **這一段不是可有可無的。** 玩家在任務房按左下角的 ◀▶ 換牌組時，
    // Edit 畫面根本沒開著 —— 少了這裡，畫面上那三張卡完全不會變，而症狀是
    // 「按了箭頭沒反應」。2026-09-09 回報的「牌組二看不到」就是這一塊
    // （那時候箭頭切的還是遊戲自己那兩格空的 Deck2/Deck3）。
    var names = ["Quest", "Raid", "Match"];
    for (var i = 0; i < names.length; i++) {
      var sc = g.scene.keys[names[i]];
      if (!sc || !sc.scene.isActive()) continue;
      // 這個場景有在畫牌組嗎？沒有 deck1 就不是（例如還在載入）。
      if (!sc.deck1) continue;
      load(sc);
      // 名字：⚠ 遊戲原本寫死 "Deck1 "，但牌組庫裡那一副有自己的名字，而
      // 「Deck1」對玩家已經沒有意義了（工作槽永遠是 1）。
      try {
        if (label !== null && sc.deck_name && typeof sc.deck_name.setText === "function") {
          sc.deck_name.setText(label + " ");
        }
      } catch (e) { /* 標籤畫不出來不影響換牌 */ }
      // 重畫：Match 有自己的 change_deck，任務／渦用 deck_card。
      try {
        if (typeof sc.change_deck === "function") sc.change_deck(0);
        else if (typeof sc.deck_card === "function") sc.deck_card(sc.deck1);
      } catch (e) {
        return "錯誤：重畫失敗 " + String((e && e.message) || e);
      }
      // ⚠⚠ **回 "ok-room" 而不是 "ok"。**
      //
      // 兩者的差別是「還要不要寫伺服器」：
      //   ok       編輯畫面 —— 遊戲會在玩家離開時自己把它送上去，不必補寫
      //   ok-room  房間場景 —— **沒有人會送**，要提交的話呼叫端得自己走慢路徑
      //
      // 混成同一個值的話，開戰前的提交會在這裡就 return 掉，伺服器上還是舊的
      // 那一副 —— 而畫面看起來完全正常。
      return "ok-room";
    }

    return "not-active";
  } catch (e) { return "錯誤：" + String((e && e.message) || e); }
})()`;
}

/** 讀不到、或畫面沒開著，一律回 `null` —— 呼叫端該退回去讀伺服器。 */
/**
 * 「玩家眼前那一副」讀回來的東西。
 *
 * ⚠⚠ `where` **不是裝飾，是自動存檔的閘門。** 這支認四個場景（Edit／Quest／
 * Raid／Match），而其中只有 Edit 裡的變動是「玩家自己改的牌」；房間場景裡
 * Deck1 會被 `patch-room-gate` 的 preload 換掉（進哪一房就換成那一房的牌），
 * 那是**我們自己做的事，不是玩家的編輯**。
 *
 * 2026-09-10 實機災情：分不出這兩者的時候，玩家從任務房跳到渦房，autoSave 把
 * 任務房那一副存進了渦房那一副（庫裡 raid 的第 3 副整個被覆蓋），而且因為
 * autoSave 從不出聲，記錄檔上一個字都沒有。
 */
export interface EditDeckRead {
  deck: Record<string, unknown>;
  /** `edit` = 牌組編輯畫面；`room` = 任務／渦／對戰房。 */
  where: "edit" | "room";
}

export function parseEditDeck(raw: string): EditDeckRead | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.active !== true) return null;
    const deck = data.deck;
    if (typeof deck !== "object" || deck === null) return null;
    return {
      deck: deck as Record<string, unknown>,
      // ⚠ 認不出來時當成 `room`（保守的那一邊）：猜錯成 edit 會吃掉牌組，
      //   猜錯成 room 只是少存一次玩家的編輯，而下一拍就補回來了。
      where: data.where === "edit" ? "edit" : "room",
    };
  } catch {
    return null;
  }
}

/** 關掉我們自己那條連線。玩家關插件時用，免得留一條閒置的 WebSocket。 */
export const DECK_SOCKET_CLOSE_EXPRESSION = `(function () {
  try {
    if (window.__ulrDeckSock) {
      try { window.__ulrDeckSock.disconnect(); } catch (e) { /* 已經斷了 */ }
      window.__ulrDeckSock = null;
      return "closed";
    }
    return "none";
  } catch (e) { return "錯誤：" + String((e && e.message) || e); }
})()`;
