/**
 * 讀寫玩家的牌組（WP-18，2026-09-24 照改版後的協定重寫）
 * =====================================================
 * 牌組庫要能「瞬間換牌組」，靠的是繞過牌組編輯畫面直接寫。這支負責頁面那一端。
 *
 * ## 2026-09-23 改版後的牌組（實機讀原始碼）
 *
 * ```
 *   registry.deck      [{ deck_id, main, chara_card_id[3], weapon_card_id[3],
 *                         event_card_id[18], card_effect[], cost }]   ← 全部場景共用同一個物件
 *   registry.deck_now  開機時取 main === 1 那一副；牌組編輯離開時寫回
 *   registry.deck_max  3
 * ```
 *
 * - 每個場景 `init()` 都是 `this.deck = registry.get("deck")`（**同一個參照**，
 *   只有教學複製一份），`this.deck_now = registry.get("deck_now")`。房裡的 ◀▶
 *   只改場景自己的 `deck_now` 再 `show_deck()`；Edit 的是 `refresh()`＋
 *   `show_deck_label()`＋`show_cost()`。
 * - 開戰一律帶 `deck_now`：`quest_start(pid, deck_now)`、`raid_start(id, 回合,
 *   deck_now)`、`quick_room(deck_now, ch)`、`create_room(deck_now, ch, R)`、
 *   `enter_room(room, deck_now, t)` —— 伺服器用它**自己存的**那一副。
 * - 寫：lobby 池新開一條連線 → `fetch("register", player_id)` →
 *   `fetch("deck_update", 整份陣列)`，**回 `false` 是成功**。Edit 就是這樣做的，
 *   而且只在離開畫面時送一次（`try_scene_end`）。
 * - 讀：`fetch("db_deck")` 回整份陣列。官方寫完之後會
 *   `update_data(scene, "deck")` → `registry.set("deck", 新陣列)`。
 *
 * ## ⚠ 新版 Edit 寫失敗時不說話
 *
 * `try_scene_end` 的 `deck_update` 被伺服器退回時**不顯示任何錯誤**，只是把
 * 輸入打開、人留在原畫面 —— 玩家看到的是「按返回沒反應」。所以塞進客戶端記憶體
 * 的東西一定要是伺服器會收的（庫存夠、三副合起來不超量）—— 那一關在托盤
 * （`@ulr/deck-library` 的 `findShortages`／`findSetShortages`）。
 *
 * ## 客戶端那份、伺服器那份
 *
 * 新版所有場景讀的都是同一個 `registry.deck`，所以「客戶端那份」只有一份。
 * 「伺服器那份」由頁面自己記著（`window.__ulrDeckMirror`，見
 * {@link DECK_MIRROR_SNIPPET}），不必每次去問伺服器（2026-09-13 玩家定的規矩：
 * 盡量不要多送請求）：
 *
 * ```
 *   registry 的 "deck" 被整份換掉（changedata-deck）  → 那是官方剛從伺服器拉的
 *   我們的 deck_update 回 false                      → 伺服器現在就是我們送的那份
 *   都還沒發生過                                     → 讀一次 db_deck（每次開遊戲一次）
 * ```
 *
 * ## ⚠⚠ 必須送到 lobby 服務
 *
 * 遊戲的服務是分池的（`UL_CONFIG.domains`），Edit 用的是 `lobby`。舊版踩過：
 * 送到別的池伺服器完全沒反應（2026-08-24，當時是 `db_editdeck`）。
 */

import { CHARA_CARDS_KEY } from "./constants.js";
import { embedJson } from "./embed.js";
import { ROOM_COST_SNIPPET } from "./room-cost.js";

/** 伺服器那一副（`registry.deck` 的元素、`db_deck` 與 `deck_update` 的形狀）。 */
export interface ServerDeck {
  deck_id: number;
  /** 1 = 主牌組（開機時 `deck_now` 從它來、大廳立繪用它）。 */
  main: number;
  chara_card_id: (number | null)[];
  weapon_card_id: (number | null)[];
  /** 18 格。 */
  event_card_id: (number | null)[];
  /** 閃卡特效的狀態。牌組庫不管它，寫回去時照原樣帶。 */
  card_effect: unknown[];
  /** 伺服器算的；寫回去時照帶，伺服器會自己重算。 */
  cost: number;
}

/** 換進某一格的內容。`deckId` 是 `deck_id`（1..3），不是陣列位置。 */
export interface DeckSlotWrite {
  deckId: number;
  chara_card_id: (number | null)[];
  weapon_card_id: (number | null)[];
  event_card_id: (number | null)[];
}

/**
 * 快取的連線多久沒連上就換一條新的（毫秒）。
 *
 * 新開的連線從 new 到伺服器回 `__connected` 實測不到一秒；WSClient 自己斷線
 * 重連的間隔是 1 秒起跳。10 秒夠它們各自走完，又遠短於 `fetch` 的 30 秒逾時
 * —— 所以玩家最多只會吃到一次失敗，下一次點就換新連線了。
 */
export const DECK_SOCKET_STALE_MS = 10_000;

/**
 * 「伺服器那份」的記錄。**全頁只裝一次**，之後每一支讀寫都拿它比對。
 *
 * ⚠ 聽的是 registry 的 `changedata-deck`：官方只有兩個地方會整份換掉
 * `registry.deck` —— 開機（`PreBoot`）與離開牌組編輯（`deck_update` 成功之後
 * `update_data`），兩個都是剛從伺服器拉回來的。我們自己寫記憶體一律**就地改**，
 * 不會觸發它 —— 所以這個事件等於「伺服器那份變了」。
 *
 * ⚠ 存的是**拷貝**。存參照的話，玩家在 Edit 裡拖卡（就地改 registry）會連這份
 * 一起改掉，於是「伺服器那份」永遠等於客戶端那份，開戰前的比對就廢了。
 */
const DECK_MIRROR_SNIPPET = `
  var g = window.game;
  if (!g) throw new Error("遊戲還沒起來");
  var M = window.__ulrDeckMirror;
  if (!M || M.v !== 1 || M.game !== g) {
    M = window.__ulrDeckMirror = { v: 1, game: g, server: null, at: 0, source: null };
    try {
      g.registry.events.on("changedata-deck", function (_p, value) {
        try {
          M.server = JSON.parse(JSON.stringify(value));
          M.at = Date.now();
          M.source = "game";
        } catch (e) {}
      });
    } catch (e) {}
  }
`;

/**
 * 在頁面裡建立（或取回）我們自己的 lobby 連線，並確定已經 `register`。
 *
 * 存在 `window.__ulrDeckSock`，跨呼叫重用 —— 每次都開一條新的話，玩家連按幾下
 * 換牌組就會留下一串閒置連線。
 *
 * ## ⚠⚠ 重用之前要確認它真的連著（2026-09-13）
 *
 * 遊戲斷線（code 1006）後 WSClient 會自己重連，WebSocket `readyState=1` 看起來
 * 正常，但 WSClient 卡在 REGISTERING、永遠等不到 `__connected`；送出去的東西全
 * 堆在 `#outBuffer`，每次 `fetch` 都等到 30 秒逾時。遊戲自己不受影響（每進一個
 * 場景都 new 一條），只有我們這條是永遠重用的。
 *
 * 所以用 WSClient **自己的事件**記「這條真的連上了」（`connect` 是收到
 * `__connected` 才發的，`close` 是斷線）：連著就重用；沒連著而且超過
 * {@link DECK_SOCKET_STALE_MS} 就拆掉換一條新的。
 *
 * ## `register` 每條連線（每個玩家）只做一次
 *
 * 改版後 `fetch` 不再帶玩家 id，連線要先 `register` 才認得人（`Edit.init` 一進來
 * 就做）。記的是「哪一條連線、哪個玩家、有沒有斷過」—— 斷線重連、換帳號都要
 * 重做一次。
 */
const DECK_SOCKET_SETUP = `
  var pid = g.registry.get("player_id");
  if (!pid) throw new Error("還沒登入");
  var host = null, names = Object.keys(g.scene.keys);
  for (var i = 0; i < names.length; i++) {
    var s = g.scene.keys[names[i]];
    if (s && s.socket && typeof s.socket.fetch === "function") { host = s; break; }
  }
  if (!host) throw new Error("找不到可借用 WSClient 的場景");
  var old = window.__ulrDeckSock;
  if (old && window.__ulrDeckSockLive !== old &&
      !(Date.now() - (window.__ulrDeckSockAt || 0) < ${DECK_SOCKET_STALE_MS})) {
    try { old.disconnect(); } catch (e) { /* 已經斷了 */ }
    window.__ulrDeckSock = null;
  }
  if (!window.__ulrDeckSock) {
    var cfg = UL_CONFIG.domains.lobby;
    var url = cfg.urls[Math.floor(Math.random() * cfg.urls.length)] + ":" +
      cfg.ports[Math.floor(Math.random() * cfg.ports.length)];
    var fresh = new (host.socket.constructor)(url);
    window.__ulrDeckSock = fresh;
    window.__ulrDeckSockUrl = url;
    window.__ulrDeckSockAt = Date.now();
    window.__ulrDeckSockLive = null;
    window.__ulrDeckSockReg = null;
    fresh.on("connect", function () {
      if (window.__ulrDeckSock === fresh) window.__ulrDeckSockLive = fresh;
    });
    // 斷線後從這一刻重新起算寬限時間：WSClient 自己重連得上就繼續用它，
    // 但伺服器那邊的 register 跟著連線沒了，要重做。
    fresh.on("close", function () {
      if (window.__ulrDeckSock !== fresh) return;
      window.__ulrDeckSockLive = null;
      window.__ulrDeckSockAt = Date.now();
      window.__ulrDeckSockReg = null;
    });
  }
  var sock = window.__ulrDeckSock;
  // ⚠ id 每次都從 registry 重讀，不快取 —— 玩家換帳號登入時快取的會是上一個人的
  if (window.__ulrDeckSockReg !== String(pid)) {
    await sock.fetch("register", pid);
    window.__ulrDeckSockReg = String(pid);
  }
`;

/**
 * 帳號指紋：**玩家名稱**的 SHA-256 前 8 個 hex。
 *
 * ## ⚠⚠ 不要再用 `player_id`（2026-09-25）
 *
 * 2026-09-23 改版後 `registry.player_id` 是頁面全域 `player_id`（`Unlight_Init`
 * 抄進 registry），**每次登入都發一個新的 UUID** —— 它是這次登入拿去 `register`
 * 各條 socket 的憑證，不是角色 id。拿它算指紋的結果是每次開遊戲都是「新帳號」：
 * 找不到上次的牌組庫 → 當成第一次用 → 把 Deck1 各收一份進四房（插件模式的
 * Deck2／Deck3 早已清空），玩家看到的是「牌組只剩一副，全部都是昨天用的那副」。
 * 實機：同一個角色一天拿到三個指紋，遊戲每重載一次換一個。
 *
 * 名稱在遊戲裡改不了、`registry.player` 本來就有（不必多送請求），而舊存檔的
 * `accountLabel` 也是它 —— 換過來時托盤靠它把舊指紋的那幾份庫找回來
 * （`deck-store.ts` 的 `readLibrary`）。
 *
 * ## 雲端鍵：名稱 ＋ 註冊時間（`player.regist_at`）
 *
 * 雲端的規矩是「知道鍵就能讀寫那份庫」（`@ulr/arbiter-link` 的 `deck-sync.ts`），
 * 所以鍵的材料要**固定**又**只有本人拿得到**。2026-09-25 對著客戶端查過：
 *
 * ```
 *   player_id、access_token     每次登入都換                  ✗
 *   名稱、好友代碼、Steam ID    固定，但公開（好友清單、排行榜） ✗ 單獨用
 *   regist_at                   固定；好友清單、好友個人資料、    ✓
 *                               排行榜都沒有，客戶端程式碼也從不讀它
 * ```
 *
 * `regist_at` 是精確到毫秒的時間，外人只能對雲端一個一個猜。名稱放進去是讓兩個
 * 角色不會因為同一毫秒註冊而撞鍵。⚠ 還沒查過的管道：對戰時對手收到的房間資料、
 * 房間列表、渦列表 —— 哪天發現那裡帶了 `regist_at`，這把鍵就要換。
 *
 * 讀不到 `regist_at` 時 `__sync` 是 `null`：托盤看到 `null` 就不同步，**絕不能
 * 退回只用名稱算**（那等於把門票公開）。
 */
const FINGERPRINT_SNIPPET = `
  var __pl = g.registry.get("player") || {};
  var __name = typeof __pl.player_name === "string" ? __pl.player_name : "";
  var __reg = typeof __pl.regist_at === "string" ? __pl.regist_at : "";
  var __fp = null, __sync = null;
  if (__name) {
    var __buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(__name));
    __fp = Array.from(new Uint8Array(__buf)).slice(0, 4)
      .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    if (__reg) {
      var __sbuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(${JSON.stringify(
        "ulr-deck-sync\n",
      )} + __name + "\\n" + __reg));
      __sync = Array.from(new Uint8Array(__sbuf))
        .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }
  }
`;

/**
 * 雲端牌組庫的鍵用的前綴。**必須**跟 `@ulr/arbiter-link` 的 `DECK_SYNC_KEY_SALT`
 * 一字不差（托盤的測試會對一次）—— 兩邊不同的話每台電腦都拿到一份空的雲端庫，
 * 而且沒有任何錯誤訊息。這個 package 不依賴 arbiter-link，所以抄一份。
 */
export const DECK_SYNC_SALT = "ulr-deck-sync\n";

/**
 * 把一副整理成乾淨的純資料（固定長度、只留我們認得的欄位）。
 *
 * ⚠ registry 裡的物件是遊戲活著的東西，直接 `JSON.stringify` 帶回來沒問題，但
 * 送 `deck_update` 時送的是這個形狀 —— 跟 Edit 自己送的 `this.deck` 一樣。
 */
const DECK_CLEAN_SNIPPET = `
  function ulrCells(src, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var v = src && src[i];
      out.push(typeof v === "number" && isFinite(v) ? v : null);
    }
    return out;
  }
  function ulrCleanDeck(d) {
    return {
      deck_id: d.deck_id,
      main: d.main === 1 ? 1 : 0,
      chara_card_id: ulrCells(d.chara_card_id, 3),
      weapon_card_id: ulrCells(d.weapon_card_id, 3),
      event_card_id: ulrCells(d.event_card_id, 18),
      card_effect: Array.isArray(d.card_effect) ? d.card_effect : [],
      cost: typeof d.cost === "number" && isFinite(d.cost) ? d.cost : 0
    };
  }
  function ulrCleanDecks(list) {
    if (!Array.isArray(list)) return null;
    return list.map(ulrCleanDeck).sort(function (a, b) { return a.deck_id - b.deck_id; });
  }
`;

/**
 * 重畫玩家眼前那個有牌組列的場景。回傳重畫了哪一個（沒有就 `null`）。
 *
 * ```
 *   Edit                 refresh() ＋ show_deck_label() ＋ show_cost()   原版 ◀▶ 就是這三下
 *   Quest／Raid／Match   show_deck()
 * ```
 */
const REDRAW_SNIPPET = `
  function ulrDeckScene(g) {
    var ed = g.scene.keys.Edit;
    if (ed && ed.scene.isActive() && typeof ed.refresh === "function") return { name: "Edit", sc: ed };
    var rooms = ["Quest", "Raid", "Match"];
    for (var i = 0; i < rooms.length; i++) {
      var sc = g.scene.keys[rooms[i]];
      if (sc && sc.scene.isActive() && typeof sc.show_deck === "function" && sc.deck_card) {
        return { name: rooms[i], sc: sc };
      }
    }
    return null;
  }
  function ulrRedraw(hit) {
    if (!hit) return null;
    if (hit.name === "Edit") {
      hit.sc.refresh();
      try { hit.sc.show_deck_label(); } catch (e) {}
      try { hit.sc.show_cost(); } catch (e) {}
      return "Edit";
    }
    hit.sc.show_deck();
    return hit.name;
  }
`;

/** 讀回來的一份快照：**伺服器那份**加上帳號資訊。 */
export interface DeckSnapshot {
  /** 帳號指紋（8 hex）。 */
  account: string;
  /** 玩家顯示名稱，給人看的。讀不到是 `null`。 */
  accountLabel: string | null;
  /** `registry.deck_now`：開戰時用哪一副（場景各自會改，這是全域那一份）。 */
  deckNow: number | null;
  /**
   * 伺服器上的牌組，照 `deck_id` 排好。
   *
   * ⚠ 這是「伺服器那份」，不是玩家眼前那份 —— 兩者在換房、在 Edit 裡排牌時本來
   * 就會不一樣。眼前那份用 {@link EDIT_DECK_READ_EXPRESSION}。
   */
  decks: ServerDeck[];
  /** 這次的伺服器那份是怎麼來的：頁面記著的（`mirror`）或剛查的（`server`）。 */
  source: "mirror" | "server";
  /** 用哪個 lobby 端點（只有真的連過才有），診斷用。 */
  endpoint: string;
  /**
   * 雲端牌組庫的鍵：`SHA-256(DECK_SYNC_SALT + 角色 id)` 的 64 hex。同一個角色在
   * 哪台電腦都一樣，反推不回 id（見 `@ulr/arbiter-link` 的 `deck-sync.ts`）。
   */
  syncKey: string | null;
}

/**
 * 讀伺服器那份與帳號指紋。
 *
 * 頁面記過伺服器那份就直接用（**一趟網路都不跑**）；還沒記過（這次開遊戲第一次）
 * 才 `db_deck` 一次，順手記下。
 */
export const DECK_READ_EXPRESSION = `(async function () {
  try {
    ${DECK_MIRROR_SNIPPET}
    ${DECK_CLEAN_SNIPPET}
    ${FINGERPRINT_SNIPPET}
    if (!__fp) return JSON.stringify({ error: "還沒登入" });
    var source = "mirror";
    if (!M.server) {
      ${DECK_SOCKET_SETUP}
      var got = await sock.fetch("db_deck");
      if (!Array.isArray(got)) return JSON.stringify({ error: "db_deck 回的不是陣列" });
      M.server = JSON.parse(JSON.stringify(got));
      M.at = Date.now();
      M.source = "db_deck";
      source = "server";
    }
    var player = g.registry.get("player") || {};
    return JSON.stringify({
      account: __fp,
      syncKey: __sync,
      accountLabel: player.player_name || player.name || null,
      deckNow: g.registry.get("deck_now"),
      decks: ulrCleanDecks(M.server),
      source: source,
      endpoint: window.__ulrDeckSockUrl || ""
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

function cells(src: unknown, n: number): (number | null)[] {
  const arr = Array.isArray(src) ? src : [];
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v: unknown = arr[i];
    out.push(typeof v === "number" && Number.isFinite(v) ? v : null);
  }
  return out;
}

/** 頁面帶回來的一副 → {@link ServerDeck}。`deck_id` 不是數字的丟掉。 */
function parseServerDeck(raw: unknown): ServerDeck | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deck_id !== "number") return null;
  return {
    deck_id: d.deck_id,
    main: d.main === 1 ? 1 : 0,
    chara_card_id: cells(d.chara_card_id, 3),
    weapon_card_id: cells(d.weapon_card_id, 3),
    event_card_id: cells(d.event_card_id, 18),
    card_effect: Array.isArray(d.card_effect) ? (d.card_effect as unknown[]) : [],
    cost: typeof d.cost === "number" && Number.isFinite(d.cost) ? d.cost : 0,
  };
}

/** 一串 → 照 `deck_id` 排好的 {@link ServerDeck}。不是陣列回 `null`。 */
function parseServerDecks(raw: unknown): ServerDeck[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map(parseServerDeck)
    .filter((d): d is ServerDeck => d !== null)
    .sort((a, b) => a.deck_id - b.deck_id);
}

export function parseDeckSnapshot(raw: string): DeckSnapshot {
  const rec = parseOrThrow(raw, "讀牌組");
  const decks = parseServerDecks(rec.decks);
  if (decks === null || decks.length === 0) throw new Error("讀牌組：伺服器那份是空的");
  const account = typeof rec.account === "string" ? rec.account : "";
  if (!/^[0-9a-f]{8}$/.test(account)) throw new Error("讀牌組：帳號指紋的格式不對");
  return {
    account,
    accountLabel: typeof rec.accountLabel === "string" ? rec.accountLabel : null,
    deckNow: typeof rec.deckNow === "number" ? rec.deckNow : null,
    decks,
    source: rec.source === "server" ? "server" : "mirror",
    endpoint: typeof rec.endpoint === "string" ? rec.endpoint : "",
    syncKey:
      typeof rec.syncKey === "string" && /^[0-9a-f]{64}$/.test(rec.syncKey) ? rec.syncKey : null,
  };
}

/** 寫入的結果。 */
export interface DeckApplyResult {
  /**
   * 伺服器怎麼回：
   *
   * ```
   *   ok         回 false —— 收下了（官方的慣例：false = 沒有錯誤）
   *   rejected   回 true  —— 退回（多半是庫存超量：三副共用一個卡池）
   *   no-answer  逾時或丟例外 —— 不知道有沒有寫進去
   * ```
   */
  answer: "ok" | "rejected" | "no-answer";
  /** 重畫了哪個場景。沒有就是 `null`。 */
  refreshed: string | null;
}

/**
 * 建立「把整份牌組寫進伺服器」的表達式。
 *
 * @param decks 整份（三副），跟 Edit 離開時送的 `this.deck` 同一個形狀。
 *
 * 成功之後三件事：
 *
 * 1. 伺服器那份（mirror）記成我們送的這份。
 * 2. **客戶端記憶體就地改成同一份** —— 不改的話玩家停在 Edit 時，他離開那一下
 *    遊戲會拿記憶體裡的舊內容再送一次，把我們寫的蓋掉。就地改（不是整份換掉）
 *    是因為每個場景手上拿的都是同一個陣列參照。
 * 3. 重畫眼前那個場景。
 *
 * ⚠ 頁面端**還有一道「整份是空的就不送」**：呼叫端已經擋過，這裡再擋一次是故意
 * 的 —— 把玩家三副全部清空的後果不值得只靠一道鎖。
 */
export function buildDeckApplyExpression(decks: ServerDeck[]): string {
  return `(async function () {
  try {
    ${DECK_MIRROR_SNIPPET}
    ${DECK_CLEAN_SNIPPET}
    ${REDRAW_SNIPPET}
    ${ROOM_COST_SNIPPET}
    var D = JSON.parse(${embedJson(decks)});
    if (!Array.isArray(D) || D.length === 0) return JSON.stringify({ error: "沒有牌組可以寫" });
    var any = D.some(function (d) {
      return (d.chara_card_id || []).some(function (x) { return x !== null && x !== undefined; });
    });
    if (!any) return JSON.stringify({ error: "拒絕寫入：三副全是空的" });
    ${DECK_SOCKET_SETUP}

    var res;
    try {
      res = await Promise.race([
        sock.fetch("deck_update", D),
        new Promise(function (resolve) { setTimeout(function () { resolve("__timeout"); }, 6000); })
      ]);
    } catch (e) { res = "__error"; }
    if (res === "__timeout" || res === "__error") {
      return JSON.stringify({ answer: "no-answer", refreshed: null });
    }
    if (res !== false) return JSON.stringify({ answer: "rejected", refreshed: null });

    M.server = JSON.parse(JSON.stringify(D));
    M.at = Date.now();
    M.source = "ulr";

    // 客戶端記憶體就地跟上（見上面第 2 點）。
    var hit = ulrDeckScene(g);
    var lists = [g.registry.get("deck")];
    if (hit && hit.sc.deck && lists.indexOf(hit.sc.deck) < 0) lists.push(hit.sc.deck);
    var room = hit ? ulrRoomOfScene(hit.name, hit.sc) : null;
    lists.forEach(function (list) {
      if (!Array.isArray(list)) return;
      D.forEach(function (src) {
        for (var i = 0; i < list.length; i++) {
          var cur = list[i];
          if (!cur || cur.deck_id !== src.deck_id) continue;
          cur.chara_card_id = src.chara_card_id.slice();
          cur.weapon_card_id = src.weapon_card_id.slice();
          cur.event_card_id = src.event_card_id.slice();
          var c = ulrRoomCostOf(cur, room);
          if (c !== null) cur.cost = c;
        }
      });
    });
    var refreshed = null;
    try { refreshed = ulrRedraw(hit); } catch (e) { refreshed = "重畫失敗：" + String(e && e.message); }
    return JSON.stringify({ answer: "ok", refreshed: refreshed });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;
}

export function parseDeckApplyResult(raw: string): DeckApplyResult {
  const rec = parseOrThrow(raw, "寫牌組");
  return {
    answer: rec.answer === "ok" ? "ok" : rec.answer === "rejected" ? "rejected" : "no-answer",
    refreshed: typeof rec.refreshed === "string" ? rec.refreshed : null,
  };
}

/** 玩家的卡片庫存：registry 的原樣（`[{card_id, quantity}]`），三種卡各一份。 */
export interface InventorySnapshot {
  chara: unknown[];
  weapon: unknown[];
  event: unknown[];
  /**
   * 玩家角色卡（`CharaCards` 裡 `kind` 0 的）：卡片 id → 格子鍵（`cc035_r02`）。
   * 讀不到卡片資料時是空的。
   *
   * 格子鍵裡就有「哪個角色、L 還是 R、第幾級」—— 牌組裡的角色卡手上沒有了
   * （多半是合成掉了），托盤靠它臨時換成同一個角色的另一張。怪物卡不列：
   * 同一個代號底下有好幾張同等級的，也不會被合成。
   */
  charaFiles: Record<string, string>;
}

/**
 * 讀庫存 —— 「只用玩家真的有的卡」那條線靠它。
 *
 * **一趟網路都不跑**：讀的是 registry 裡遊戲自己維護的那份（開機與進牌組編輯時
 * 官方會更新），角色卡的格子鍵讀的是遊戲開機載好的 `CharaCards`。
 */
export const INVENTORY_READ_EXPRESSION = `(function () {
  try {
    var g = window.game;
    if (!g) return JSON.stringify({ error: "遊戲還沒起來" });
    var c = g.registry.get("chara_card"), w = g.registry.get("weapon_card"), e = g.registry.get("event_card");
    if (!Array.isArray(c) || !Array.isArray(w) || !Array.isArray(e)) {
      return JSON.stringify({ error: "庫存還沒載入" });
    }
    function slim(list) {
      return list.map(function (r) { return { card_id: r.card_id, quantity: r.quantity }; });
    }
    var charaFiles = {};
    try {
      var cards = g.cache && g.cache.json && g.cache.json.get(${JSON.stringify(CHARA_CARDS_KEY)});
      if (Array.isArray(cards)) {
        cards.forEach(function (x) {
          if (x && typeof x.id === "number" && x.kind === 0 && typeof x.filename === "string") {
            charaFiles[x.id] = x.filename;
          }
        });
      }
    } catch (err) { charaFiles = {}; }
    return JSON.stringify({ chara: slim(c), weapon: slim(w), event: slim(e), charaFiles: charaFiles });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

export function parseInventorySnapshot(raw: string): InventorySnapshot {
  const rec = parseOrThrow(raw, "讀庫存");
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const charaFiles: Record<string, string> = {};
  if (typeof rec.charaFiles === "object" && rec.charaFiles !== null) {
    for (const [k, v] of Object.entries(rec.charaFiles as Record<string, unknown>)) {
      if (/^\d+$/.test(k) && typeof v === "string") charaFiles[k] = v;
    }
  }
  return { chara: list(rec.chara), weapon: list(rec.weapon), event: list(rec.event), charaFiles };
}

/**
 * 讀**玩家眼前那份**（客戶端記憶體 `registry.deck`）＋頁面記著的伺服器那份。
 *
 * 回傳 `active: false` 表示玩家不在任何有牌組列的畫面（Edit／任務／渦／對戰房）。
 * 那時候呼叫端該用伺服器那份（{@link DECK_READ_EXPRESSION}）。
 *
 * ## 為什麼 `where` 不能省
 *
 * 只有 Edit 裡的變動是「玩家自己改的牌」；房間場景裡的變動是我們的進房預載
 * （`patch-room-gate`）做的。分不出來的話自動存檔會把上一房的牌存進這一房
 * （2026-09-10 實機災情），見托盤 `main.ts` 的 `mayAutoSave`。
 *
 * ⚠ 帳號指紋跟著一起帶回去：人一直待在有牌組列的畫面時托盤只走這條，換帳號
 * 要從這裡看出來（2026-09-14）。
 */
export const EDIT_DECK_READ_EXPRESSION = `(async function () {
  try {
    ${DECK_MIRROR_SNIPPET}
    ${DECK_CLEAN_SNIPPET}
    ${REDRAW_SNIPPET}
    var __acct = null;
    try {
      ${FINGERPRINT_SNIPPET}
      __acct = __fp;
    } catch (e) { __acct = null; /* 認不出帳號就當不知道，不要擋住讀牌組 */ }
    var hit = ulrDeckScene(g);
    if (!hit) return JSON.stringify({ active: false, account: __acct });
    var list = hit.sc.deck || g.registry.get("deck");
    return JSON.stringify({
      active: true,
      where: hit.name === "Edit" ? "edit" : "room",
      scene: hit.name,
      account: __acct,
      deckNow: typeof hit.sc.deck_now === "number" ? hit.sc.deck_now : null,
      decks: ulrCleanDecks(list),
      server: M.server ? ulrCleanDecks(M.server) : null
    });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

/**
 * 「玩家眼前那份」讀回來的東西。
 *
 * ⚠⚠ `where` **不是裝飾，是自動存檔的閘門**：`edit` 裡的變動是玩家的編輯，
 * `room` 裡的變動是我們自己的進房預載。
 */
export interface EditDeckRead {
  /** 客戶端記憶體的整份，照 `deck_id` 排好。 */
  decks: ServerDeck[];
  /** 頁面記著的伺服器那份；還沒記過是 `null`。 */
  server: ServerDeck[] | null;
  /** `edit` = 牌組編輯畫面；`room` = 任務／渦／對戰房。 */
  where: "edit" | "room";
  /** 那個場景自己的 `deck_now`（玩家眼前是第幾副）。 */
  deckNow: number | null;
  /**
   * 帳號指紋（8 hex，跟 `DeckSnapshot.account` 同一套）。認不出來是 `null` ——
   * 呼叫端**不能**把 `null` 當成「換帳號了」，那只是這一拍不知道。
   */
  account: string | null;
}

/** 畫面沒開著、或讀不懂，一律回 `null` —— 呼叫端該退回去讀伺服器那份。 */
export function parseEditDeck(raw: string): EditDeckRead | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.active !== true) return null;
    const decks = parseServerDecks(data.decks);
    if (decks === null || decks.length === 0) return null;
    return {
      decks,
      server: parseServerDecks(data.server),
      // ⚠ 認不出來時當成 `room`（保守的那一邊）：猜錯成 edit 會吃掉牌組，
      //   猜錯成 room 只是少存一次玩家的編輯，而下一拍就補回來了。
      where: data.where === "edit" ? "edit" : "room",
      deckNow: typeof data.deckNow === "number" ? data.deckNow : null,
      account:
        typeof data.account === "string" && /^[0-9a-f]{8}$/.test(data.account)
          ? data.account
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * **換牌組的快路徑：只動客戶端記憶體，一次網路都不跑。**
 *
 * 原版 ◀▶ 就是這樣：換的是「畫面在畫哪一副」，等玩家離開編輯畫面才送一次
 * `deck_update`。自訂牌組要跟它一樣順，就走同一條路 —— 把內容就地寫進
 * `registry.deck` 的那幾格，然後照原版的方式重畫。
 *
 * @param slots 要換的格子（`deckId` 1..3）。插件模式只換第 1 格；官方三牌組模式
 *   三格一起換。
 * @param pin 寫完把場景的 `deck_now` 釘在第幾副（插件模式是 1）；`null` 不動。
 *
 * 回傳：
 *
 * ```
 *   ok          編輯畫面 —— 遊戲會在玩家離開時自己送上伺服器，不必補寫
 *   ok-room     房間場景 —— **沒有人會送**，要提交的話呼叫端得自己寫伺服器
 *   not-active  玩家不在有牌組列的畫面，什麼都沒動
 *   empty-room  房間場景裡要釘的那一副是空的 —— 拒絕（開戰會拿空牌上場）
 * ```
 *
 * ⚠ 空牌組**只有 Edit 收**（那等於幫玩家按 reset，出口的檢查是遊戲自己的）。
 *
 * ⚠ 房間的 `cost:NN` 讀的是那一副的 `cost`，而遊戲**不重算**。寫完照房型算好填
 * 進去（跟牌盒同一張表，見 `room-cost.ts`）。
 */
export function buildEditDeckWriteExpression(slots: DeckSlotWrite[], pin: number | null): string {
  return `(function () {
  try {
    var g = window.game;
    if (!g) return "not-active";
    ${REDRAW_SNIPPET}
    ${ROOM_COST_SNIPPET}
    var S = JSON.parse(${embedJson(slots)});
    var PIN = JSON.parse(${embedJson(pin)});
    var hit = ulrDeckScene(g);
    if (!hit) return "not-active";
    var isRoom = hit.name !== "Edit";
    if (isRoom && PIN !== null) {
      for (var k = 0; k < S.length; k++) {
        if (S[k].deckId === PIN && (S[k].chara_card_id[0] === null || S[k].chara_card_id[0] === undefined)) {
          return "empty-room";
        }
      }
    }
    var room = ulrRoomOfScene(hit.name, hit.sc);
    var lists = [g.registry.get("deck")];
    if (hit.sc.deck && lists.indexOf(hit.sc.deck) < 0) lists.push(hit.sc.deck);
    var touched = 0;
    lists.forEach(function (list) {
      if (!Array.isArray(list)) return;
      S.forEach(function (src) {
        for (var i = 0; i < list.length; i++) {
          var cur = list[i];
          if (!cur || cur.deck_id !== src.deckId) continue;
          cur.chara_card_id = src.chara_card_id.slice();
          cur.weapon_card_id = src.weapon_card_id.slice();
          cur.event_card_id = src.event_card_id.slice();
          var c = ulrRoomCostOf(cur, room);
          if (c !== null) cur.cost = c;
          touched++;
        }
      });
    });
    if (touched === 0) return "錯誤：記憶體裡找不到要換的那幾格";
    if (PIN !== null) hit.sc.deck_now = PIN;
    ulrRedraw(hit);
    return isRoom ? "ok-room" : "ok";
  } catch (e) { return "錯誤：" + String((e && e.message) || e); }
})()`;
}

/** 關掉我們自己那條連線。玩家關插件時用，免得留一條閒置的 WebSocket。 */
export const DECK_SOCKET_CLOSE_EXPRESSION = `(function () {
  try {
    if (window.__ulrDeckSock) {
      try { window.__ulrDeckSock.disconnect(); } catch (e) { /* 已經斷了 */ }
      window.__ulrDeckSock = null;
      window.__ulrDeckSockLive = null;
      window.__ulrDeckSockReg = null;
      return "closed";
    }
    return "none";
  } catch (e) { return "錯誤：" + String((e && e.message) || e); }
})()`;
