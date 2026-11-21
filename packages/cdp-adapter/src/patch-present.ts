/**
 * 好友面板下方的「今日還能送幾張地圖」
 * ====================================
 * 玩家按任務畫面的 PRESENT 鈕 → 跳出好友面板 → 挑一個人把地圖送出去。
 * 每天有次數上限，而**官方沒有任何地方顯示還剩幾次** —— 送到超過上限才會跳
 * 「今天無法再贈送任務」。Discord 的地圖交換區是照著約定一次換好幾張的，
 * 所以「談好了卻送不出去，只能明天再補」是每天都在發生的事。
 *
 * ## ⚠ 2026-09-23 改版後伺服器**不再告訴我們剩幾次**，只能自己數
 *
 * 改版前 `db_quest` 的回應裡有一個客戶端從沒讀過的 `pre_remain`，v2 就是讀它。
 * 2026-10-09 在小號上實測改版後的客戶端：
 *
 * ```
 *   await Quest.socket.fetch("db_quest")      ← 參數也沒了
 *   → { current_quest_id, current_land_id, deck,
 *       chara1_hp, chara2_hp, chara3_hp, from_id }      ← pre_remain 不見了
 * ```
 *
 * `db_player`、`get_quest_data`、registry 的 player / quest / quest_data、所有
 * socket 推播事件名都掃過，沒有任何地方帶贈送次數。伺服器剩下的只有一句錯誤：
 * `quest_error("PRESENT_LIMIT")` ＝「今天無法再贈送任務」。
 *
 * 所以 v3 改成**插件自己數**，兩件事都搭官方本來就會收到的封包，不多送任何請求：
 *
 * ```
 *   Quest.socket 收到 quest_pre（不是 false）  → 送成了，今天 +1
 *   Quest.socket 收到 quest_error PRESENT_LIMIT → 伺服器說滿了，直接歸零
 * ```
 *
 * 官方送出的那一行（Friend 面板點人 → 確認框 → OK）：
 *
 * ```js
 *   if (!1 === await s.socket.fetch("quest_pre", quest_pid, friend_code, stamp))
 *     return …;                 // 失敗：錯誤另外走 quest_error 事件
 *   e.close();                  // 成功：好友面板直接關掉
 * ```
 *
 * 自己數要先知道兩件客戶端沒有的事：
 *
 * 1. **上限是不是 5** —— 照改版前 `pre_remain` 的滿值（沒有再證實過）。數到超過
 *    5 還送得出去，分母就跟著頂上去。
 * 2. **每日幾點重置** —— **台灣時間 03:00**（UTC 19:00），使用者 2026-10-09 告知。
 *    ⚠ 不是日本時間午夜：伺服器的預設日期 `quest_find: "2023-12-31T15:00:00.000Z"`
 *    看起來像 JST 午夜，但那跟贈送的換日無關，第一版照它猜錯過。
 *    萬一官方改了時間，靠這個自我修正撐著：已經記成「滿了」卻又送成功，
 *    就當作伺服器已經換日、從 1 重新數。
 *
 * 記錄存在遊戲頁的 localStorage，鍵是角色名＋註冊時間（player_id 每次登入都
 * 換，見 unlight-player-id-per-login）。⚠ 所以**別台電腦／另一個客戶端送的不算** ——
 * tooltip 有講。
 *
 * ## 畫面：放在面板下方那條按鈕列的右端
 *
 * 改版後的面板（rexContainerLite，children 用的是**世界座標**）下方那一列是
 * 「顯示方法／排列／搜尋」，搜尋的下拉選單結束在 x≈506，右邊到面板邊緣
 * （644）是空的。使用者要求放在下方，就放在那裡，靠右對齊：
 *
 * ```
 *   ┌───────────────────────────────────────────────────────────┐
 *   │                        ◁  1 / 1  ▷                        │
 *   │ 顯示方法 [網格]  排列 [加入好友日期]  搜尋 [All]  剩餘贈送: 5/5 │
 *   └───────────────────────────────────────────────────────────┘
 *                                                     x = 右緣 - 8
 * ```
 *
 * 照抄的東西：`y` 跟「搜尋」標籤同一條線、字體用面板自己的 `FONT_LABEL`
 * （白字）、左邊距 8 px 鏡到右邊。
 *
 * ⚠ **跟著語言走**。改版前的對照組 `Friends 171/200` 每種語言都是英文，
 * 所以 v2 寫死英文；改版後的對照組變成 `好友人數: 1/15`（FriendUITexts 有翻譯），
 * 旁邊的標籤也都是翻譯過的。格式照抄它：「標籤: N/M」。
 *
 * ⚠⚠ **面板上只放這一行，不放說明。** 說明走 hover tooltip（使用者 2026-09-12
 * 直接要求的）。
 *
 * ## ⚠ 面板與 socket 都會換人
 *
 * - Friend 場景每次 launch 都 new 一個 `friend_panel`，掛上去的東西跟著舊面板
 *   一起 destroy → 輪詢（500ms）盯著換人沒有，換了就重掛。
 * - Quest 場景每次 init 都 new 一條 socket → 同一個輪詢也盯著 socket，換了就
 *   把監聽搬過去（跟 patch-quest-treasure 一樣）。
 * - 只在 `Friend.is_quest_present === true` 時畫。右下角 FRIENDLIST 鈕開的是同一個
 *   面板，那裡沒有東西可以送。
 *
 * ## 收到的任務：任務清單上標贈送者（v5，2026-11-22）
 *
 * 任務清單（`db_quest_data`，客戶端原樣存進 registry 的 `quest_data`）每一筆只有
 * `quest_pid / quest_id / is_present / quest_find / is_check`，**沒有贈送者**。
 * 贈送者只出現在一個地方：進大廳時官方本來就會要的 `achievement_update`，回應存在
 * `Lobby.achievement_data`，裡面的 `quest_pre_notice` 就是大廳那則「某某送了你任務」：
 *
 * ```
 *   quest_pre_notice: [{ player_name: "莫里亞蒂博士", stamp_id: null, quest_id: 478 }, …]
 * ```
 *
 * ⚠ 通知**只來一次**（看過伺服器就不再送），而且**沒有 quest_pid**。所以：
 *
 * 1. 看到新的通知陣列就收進「待配對」（同一個陣列物件只收一次；記在 window 上的
 *    WeakSet，重裝不清 —— 不然每次重裝都多收一份）
 * 2. 拿待配對去對 `quest_data` 裡 `is_present: true`、同一個 `quest_id`、還沒配過的那筆，
 *    照通知順序對發現時刻（`quest_find`）最早的。同一張任務被兩個人各送一次時只能照順序猜
 * 3. 配到了就照 `quest_pid` 記下來；任務從清單上消失（打完、刪掉）就丟。待配對放 7 天
 *
 * 記在遊戲頁的 localStorage（`ulr.gifter.` ＋角色名＋註冊時間）。插件沒開著時收到的
 * 通知補不回來。
 *
 * 畫在清單那一列的空白處：任務名後面到稀有度圖示（x=79）之間，靠右、字體照抄任務名。
 * 太長就截斷加「…」。說明走 hover，掛在那一列官方自己的 `list_zone` 上 —— 我們的字
 * 不 setInteractive，免得搶掉官方的點擊。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。所以詳細的東西寫在這個檔頭。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。跟 `__ulrLobby` / `__ulrRoomGate` 同一族。 */
const FLAG = "__ulrPresent";

/**
 * 收過的 `quest_pre_notice` 陣列（WeakSet）。**重裝不清**：大廳的通知陣列在頁面上一直
 * 留著，重裝後再收一次就變成兩份待配對。遊戲重載才清（那時陣列也沒了）。
 */
const NOTICE_SEEN = "__ulrPresentNoticeSeen";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * engine 看到頁面上的版本跟這個不一樣就重裝，所以這個數字一定要跟著動。
 */
export const PRESENT_SCRIPT_VERSION = 5;

/** 盯著 `friend_panel` 與 Quest socket 換人沒有的間隔。跟 patch-lobby 一樣 500ms。 */
export const DEFAULT_PRESENT_POLL_MS = 500;

/**
 * 每日上限。
 *
 * ⚠ **這是改版前 `pre_remain` 的滿值，改版後伺服器沒有再講過。** 數到超過它
 * 還送得出去，腳本會把分母頂上去。
 */
export const DEFAULT_PRESENT_MAX = 5;

/**
 * 每日重置：台灣時間（UTC+8）03:00，見檔頭。
 *
 * 腳本把「現在」平移 `8 - 3 = 5` 小時再取 UTC 日期 —— 台灣 03:00（UTC 19:00）
 * 平移後剛好是 UTC 午夜，日期就在那一刻跳。
 */
export const PRESENT_RESET_TAIPEI_HOUR = 3;
const TAIPEI_UTC_OFFSET_HOURS = 8;

/** localStorage 鍵的前綴。後面接角色名與註冊時間。 */
export const PRESENT_STORAGE_PREFIX = "ulr.present.";

/** 收到的任務的贈送者記錄（見檔頭 v5）。後面接角色名與註冊時間。 */
export const GIFTER_STORAGE_PREFIX = "ulr.gifter.";

/** 還沒對上任務的通知留幾天。 */
const GIFTER_PENDING_DAYS = 7;

/** 贈送者名字的右緣：清單列裡稀有度圖示（x=79、寬 16）的左緣再空 4 px。讀不到圖示時用。 */
const GIFTER_FALLBACK_RIGHT = 67;

/** 面板右緣往內縮多少。照抄左邊「顯示方法」離面板左緣的距離（124 - 116）。 */
const RIGHT_MARGIN = 8;

/**
 * 量好的後路（2026-10-09 實測）：面板右緣 644、按鈕列 y=527。
 *
 * ⚠ 正常路徑是當場去讀 `panel_base` 與 `panel_filter_label` —— 官方調整時跟著動。
 */
const FALLBACK_RIGHT = 644;
const FALLBACK_ROW_Y = 527;

export interface PresentPatchOptions {
  pollIntervalMs?: number;
  /** 分母的起始值。見 {@link DEFAULT_PRESENT_MAX}。 */
  max?: number;
}

export interface PresentStatus {
  installed: boolean;
  version: number | null;
  /** 目前算出來的剩餘次數。`null` = 還認不出是哪個角色（沒登入）。 */
  remain: number | null;
  /** 目前用的分母。 */
  max: number;
  /** 字真的畫出來了沒（＝贈送用的好友面板開著）。 */
  mounted: boolean;
  /** 還在等玩家打開贈送面板。**不是錯誤**（跟 `patch-lobby` 同一個欄位）。 */
  waiting: boolean;
  /** 記著贈送者的收到的任務有幾筆（見檔頭 v5）。 */
  gifters: number;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 面板上那一行的標籤。後面接 ` N/M`。
 *
 * 格式照抄對照組 `好友人數: 1/15`（FriendUITexts.friend_length 是「好友人數:」）。
 * ≤8 字，說明在 {@link TOOLTIP}。
 */
const LABEL: Record<string, string> = {
  ja: "残り送信:",
  en: "Gifts left:",
  kr: "남은 선물:",
  scn: "剩余赠送:",
  tcn: "剩餘贈送:",
};

/**
 * hover 才出現的說明。⚠ 要講清楚是插件在本機自己數的、**不是官方伺服器給的數字**
 * （改版後伺服器不講了，見檔頭）—— 別台裝置送的不算。兩行，第一行說是什麼。
 */
const TOOLTIP: Record<string, string> = {
  ja: "本日の残り送信回数（この端末で記録）\n公式サーバーの値ではなく、他の端末で送った分は含みません",
  en: "Quest gifts left today, counted on this device.\nNot from the official server; gifts sent elsewhere are not included.",
  kr: "오늘 남은 퀘스트 전송 횟수 (이 기기에서 기록)\n공식 서버 값이 아니며, 다른 기기에서 보낸 것은 포함되지 않습니다",
  scn: "今日剩余赠送次数（本机记录）\n不是官方服务器提供的数字，其他设备送出的不计入",
  tcn: "今日剩餘贈送次數（本機記錄）\n不是官方伺服器提供的數字，其他裝置送出的不計入",
};

/**
 * 任務清單上贈送者名字的 hover 說明。`__NAME__` 換成名字。第二行講來源：
 * 官方清單不帶這個，是進大廳那則通知插件記下的（沒開插件時收到的就沒有）。
 */
const GIFTER_TOOLTIP: Record<string, string> = {
  ja: "送り主: __NAME__\nロビーの通知からこの端末で記録（公式のリストには表示されません）",
  en: "Gifted by __NAME__\nRecorded on this device from the lobby notice (not shown in the official list).",
  kr: "보낸 사람: __NAME__\n로비 알림에서 이 기기에 기록 (공식 목록에는 표시되지 않음)",
  scn: "赠送者：__NAME__\n进大厅时的通知由本机记录（官方列表不显示）",
  tcn: "贈送者：__NAME__\n進大廳時的通知由本機記錄（官方清單不顯示）",
};

// ---------------------------------------------------------------------------
// 頁面端共用的那幾支
// ---------------------------------------------------------------------------

const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  function sceneOf(key) {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys[key]) || null;
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table, lang) {
    return table[lang] || table.en;
  }

  /** 開著的好友面板，而且是從 PRESENT 鈕進來的那一種。其餘一律 null。 */
  function presentPanel() {
    var sc = sceneOf("Friend");
    if (!sc || sc.is_quest_present !== true) return null;
    var panel = sc.friend_panel;
    if (!panel || panel.active === false) return null;
    return panel;
  }

  function unhookSocket(st) {
    var S = st.sock;
    st.sock = null;
    try {
      if (S && typeof S.off === "function") {
        S.off("quest_pre", st.onPre);
        S.off("quest_error", st.onError);
      }
    } catch (e) {}
  }

  /** 拆掉任務清單上一個贈送者名字：字、說明、掛在官方 list_zone 上的 hover。 */
  function dropGift(g) {
    try {
      if (g.zone && g.over) {
        g.zone.off("pointerover", g.over);
        g.zone.off("pointerout", g.out);
      }
    } catch (e) {}
    try { if (g.text && g.text.destroy) g.text.destroy(); } catch (e) {}
    try { if (g.tip && g.tip.destroy) g.tip.destroy(); } catch (e) {}
  }

  function dropAllGifts(st) {
    var list = st.gift || [];
    for (var i = 0; i < list.length; i++) dropGift(list[i]);
    st.gift = [];
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 */
export function buildPresentPatchScript(options: PresentPatchOptions = {}): string {
  const config = {
    version: PRESENT_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_PRESENT_POLL_MS,
    max: options.max ?? DEFAULT_PRESENT_MAX,
    dayOffsetMs: (TAIPEI_UTC_OFFSET_HOURS - PRESENT_RESET_TAIPEI_HOUR) * 3600 * 1000,
    storagePrefix: PRESENT_STORAGE_PREFIX,
    label: LABEL,
    tooltip: TOOLTIP,
    margin: RIGHT_MARGIN,
    fallbackRight: FALLBACK_RIGHT,
    fallbackRowY: FALLBACK_ROW_Y,
    gifterPrefix: GIFTER_STORAGE_PREFIX,
    gifterTooltip: GIFTER_TOOLTIP,
    gifterPendingMs: GIFTER_PENDING_DAYS * 24 * 3600 * 1000,
    gifterFallbackRight: GIFTER_FALLBACK_RIGHT,
    noticeSeen: NOTICE_SEEN,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  ${SHARED}

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    // ⚠ 不拆的話重裝後監聽變兩份，送一次記兩次。
    unhookSocket(st);
    detach(st);
    dropAllGifts(st);
    delete window[FLAG];
  }

  /** 拆的是 st.mine（我們加過的每一個東西），不是幾個具名欄位。 */
  function detach(st) {
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    st.mine = [];
    st.text = null;
    st.tip = null;
    st.panel = null;
  }

  // -------------------------------------------------------------------------
  // 記錄（localStorage，一個角色一筆）
  // -------------------------------------------------------------------------

  /** 伺服器的「今天」。台灣時間 03:00 換日，見檔頭。 */
  function today() {
    return new Date(Date.now() + CFG.dayOffsetMs).toISOString().slice(0, 10);
  }

  /** 角色名＋註冊時間。player_id 每次登入都換，不能拿來當鍵。 */
  function accountKey() {
    try {
      var reg = window.game && window.game.registry;
      var p = reg && (typeof reg.get === "function" ? reg.get("player") : reg.list && reg.list.player);
      if (!p || typeof p.player_name !== "string" || p.player_name.length === 0) return null;
      return CFG.storagePrefix + p.player_name + "|" + String(p.regist_at || "");
    } catch (e) { return null; }
  }

  /** 讀出今天的記錄。換日了就是一筆新的。 */
  function load(key) {
    var rec = null;
    try {
      var raw = window.localStorage.getItem(key);
      if (raw) rec = JSON.parse(raw);
    } catch (e) { rec = null; }
    var day = today();
    if (!rec || rec.day !== day || typeof rec.sent !== "number") {
      return { day: day, sent: 0, full: false };
    }
    return { day: day, sent: rec.sent, full: rec.full === true };
  }

  function save(key, rec) {
    try { window.localStorage.setItem(key, JSON.stringify(rec)); } catch (e) {}
  }

  /** 從記錄算出要顯示的數字。 */
  function compute(st) {
    var key = accountKey();
    if (key === null) { st.remain = null; return; }
    var rec = load(key);
    if (rec.sent > st.max) st.max = rec.sent;
    st.remain = rec.full ? 0 : Math.max(0, st.max - rec.sent);
  }

  // -------------------------------------------------------------------------
  // 聽官方本來就會收到的兩個封包
  // -------------------------------------------------------------------------

  /** quest_pre 的回覆。false 是沒送成（原因另外走 quest_error），其餘都是送成了。 */
  function onPre(st, ok) {
    if (ok === false) return;
    var key = accountKey();
    if (key === null) return;
    var rec = load(key);
    if (rec.full) {
      // 記成滿了卻又送得出去 —— 伺服器已經換日了，從這一次重新數。
      rec.sent = 1;
      rec.full = false;
    } else {
      rec.sent += 1;
    }
    save(key, rec);
    compute(st);
    paint(st);
  }

  /** 伺服器說今天不能再送了 —— 以它為準，直接歸零。 */
  function onError(st, code) {
    if (code !== "PRESENT_LIMIT") return;
    var key = accountKey();
    if (key === null) return;
    var rec = load(key);
    rec.full = true;
    save(key, rec);
    compute(st);
    paint(st);
  }

  /** Quest 場景每次 init 都 new 一條 socket：跟著換。 */
  function hookSocket(st) {
    var Q = sceneOf("Quest");
    var S = Q ? Q.socket : null;
    if (!S || typeof S.on !== "function" || st.sock === S) return;
    unhookSocket(st);
    S.on("quest_pre", st.onPre);
    S.on("quest_error", st.onError);
    st.sock = S;
  }

  // -------------------------------------------------------------------------
  // 畫面
  // -------------------------------------------------------------------------

  function labelText(st) {
    return pick(CFG.label, gameLang()) + " " + st.remain + "/" + st.max;
  }

  function paint(st) {
    if (!st.text) return;
    try {
      st.text.setText(st.remain === null ? "" : labelText(st));
      // 送完了就變紅。這是唯一的額外資訊，而且不佔字數。底是深色的，紅要亮一點。
      st.text.setColor(st.remain === 0 ? "#ff7070" : "#ffffff");
    } catch (e) {}
  }

  /** 面板右緣與按鈕列的 y。讀得到就讀，讀不到才用量好的數字。 */
  function anchor(panel) {
    var right = CFG.fallbackRight;
    var y = CFG.fallbackRowY;
    try {
      var pb = panel.panel_base;
      if (pb && typeof pb.getBottomRight === "function") right = pb.getBottomRight().x;
    } catch (e) {}
    try {
      var lb = panel.panel_filter_label || panel.panel_sort_label || panel.panel_display_label;
      if (lb && typeof lb.y === "number") y = lb.y;
    } catch (e) {}
    return { x: right - CFG.margin, y: y };
  }

  /**
   * 把字掛到面板下方那條按鈕列的右端。
   *
   * ⚠ 面板是 rexContainerLite，add 會保留物件現在的世界座標 —— 所以直接用
   * 世界座標建立再 add（2026-10-09 實測：建在 636,527，add 之後還是 636,527）。
   */
  function mount(st, panel) {
    var sc = sceneOf("Friend");
    if (!sc) return;
    var style = { fontFamily: "font_light", fontSize: 12, resolution: 2 };
    var src = panel.FONT_LABEL;
    if (src && typeof src === "object") {
      // 字體照抄旁邊的「顯示方法／排列／搜尋」，不自己挑。
      style = { fontFamily: src.fontFamily || style.fontFamily, fontSize: src.fontSize || style.fontSize, resolution: src.resolution || 2 };
    }
    var at = anchor(panel);

    var text = sc.add.text(at.x, at.y, "", style).setOrigin(1, 0.5);
    panel.add(text);
    st.mine.push(text);
    st.text = text;

    mountTooltip(st, panel, text, at.x, at.y);
    paint(st);
  }

  /** hover 才出現的說明，開在字的上方（下面就是面板邊緣）。 */
  function mountTooltip(st, panel, text, x, y) {
    var sc = sceneOf("Friend");
    var tip = sc.add.container(x, y - 10);
    var label = sc.add.text(0, 0, pick(CFG.tooltip, gameLang()), {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(1, 1);
    var back = sc.add.rectangle(0, 0, label.width, label.height, 0, 0.85).setOrigin(1, 1);
    tip.add(back);
    tip.add(label);
    tip.setVisible(false);
    try { tip.setDepth(10); } catch (e) {}
    panel.add(tip);
    st.mine.push(tip);
    st.tip = tip;

    try {
      text.setInteractive({ useHandCursor: false });
      text.on("pointerover", function () {
        try { tip.setVisible(true); } catch (e) {}
      });
      text.on("pointerout", function () {
        try { tip.setVisible(false); } catch (e) {}
      });
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 收到的任務：贈送者（見檔頭 v5）
  // -------------------------------------------------------------------------

  function gifterKey() {
    var k = accountKey();
    return k === null ? null : CFG.gifterPrefix + k.slice(CFG.storagePrefix.length);
  }

  function loadGifts(key) {
    try {
      var r = JSON.parse(window.localStorage.getItem(key) || "null");
      if (r && typeof r === "object" && r.byPid && typeof r.byPid === "object" && Array.isArray(r.pending)) return r;
    } catch (e) {}
    return { byPid: {}, pending: [] };
  }

  function questData() {
    try {
      var v = window.game.registry.get("quest_data");
      return Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  }

  /** 大廳那份 achievement_update 回應裡的贈送通知。進大廳才有。 */
  function noticeList() {
    var L = sceneOf("Lobby");
    var a = L && L.achievement_data;
    return a && Array.isArray(a.quest_pre_notice) ? a.quest_pre_notice : null;
  }

  /** 收新的通知、拿待配對去對任務清單、丟掉已經不在清單上的。 */
  function syncGifts(st) {
    var key = gifterKey();
    if (key === null) return;
    var seen = window[CFG.noticeSeen];
    if (!seen) { seen = new WeakSet(); window[CFG.noticeSeen] = seen; }
    var list = noticeList();
    var fresh = list !== null && !seen.has(list);
    var quests = questData();
    if (!fresh && quests === st.giftQuests && key === st.giftKey) return;

    var rec = loadGifts(key);
    var now = Date.now();
    if (fresh) {
      seen.add(list);
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n && typeof n.player_name === "string" && n.player_name.length > 0 && typeof n.quest_id === "number") {
          rec.pending.push({ quest_id: n.quest_id, name: n.player_name, at: now });
        }
      }
    }
    if (quests !== null) {
      var live = {};
      for (var q = 0; q < quests.length; q++) if (quests[q] && quests[q].quest_pid) live[quests[q].quest_pid] = true;
      for (var pid in rec.byPid) if (!live[pid]) delete rec.byPid[pid];
      // 照通知順序配發現時刻最早、還沒配過的那筆
      var free = quests.filter(function (x) { return x && x.is_present === true && !rec.byPid[x.quest_pid]; })
        .sort(function (a, b) { return String(a.quest_find).localeCompare(String(b.quest_find)); });
      var left = [];
      for (var p = 0; p < rec.pending.length; p++) {
        var pe = rec.pending[p], hit = -1;
        for (var f = 0; f < free.length; f++) if (free[f].quest_id === pe.quest_id) { hit = f; break; }
        if (hit >= 0) {
          rec.byPid[free[hit].quest_pid] = { name: pe.name, at: pe.at };
          free.splice(hit, 1);
        } else if (now - pe.at < CFG.gifterPendingMs) {
          left.push(pe);
        }
      }
      rec.pending = left;
    }
    try { window.localStorage.setItem(key, JSON.stringify(rec)); } catch (e) {}
    st.gifts = rec.byPid;
    st.giftQuests = quests;
    st.giftKey = key;
  }

  /** 任務清單每一列：收到的、記著贈送者的，在稀有度圖示左邊寫名字。 */
  function paintGifts(st) {
    // 官方換頁／重排會把整列拆掉重建，我們的字跟著列一起走了：說明與 hover 也收掉
    st.gift = st.gift.filter(function (g) {
      if (g.row && g.row.scene && g.text && g.text.scene) return true;
      dropGift(g);
      return false;
    });
    var Q = sceneOf("Quest");
    if (!Q || !Array.isArray(Q.quest_list) || !st.gifts) return;
    for (var i = 0; i < Q.quest_list.length; i++) {
      var row = Q.quest_list[i];
      var d = row && row.quest_list_data;
      if (!row || !row.scene || !d || d.is_present !== true) continue;
      var info = st.gifts[d.quest_pid];
      if (!info || typeof info.name !== "string") continue;
      var had = null;
      for (var g = 0; g < st.gift.length; g++) if (st.gift[g].row === row) had = st.gift[g];
      if (had && had.name === info.name) continue;
      if (had) { dropGift(had); st.gift.splice(st.gift.indexOf(had), 1); }
      mountGift(st, Q, row, info.name);
    }
  }

  function mountGift(st, Q, row, name) {
    var ref = row.list_name;
    var rs = ref && ref.style;
    // 字體照抄同一列的任務名
    var style = rs
      ? { fontFamily: rs.fontFamily, fontSize: rs.fontSize, color: rs.color, resolution: rs.resolution || 2 }
      : { fontFamily: "font_light", fontSize: 11, color: "#ffffff", resolution: 2 };
    var icon = row.list_rarity_icon;
    var right = icon && typeof icon.x === "number"
      ? icon.x - (icon.displayWidth || 16) * (typeof icon.originX === "number" ? icon.originX : 0.5) - 4
      : CFG.gifterFallbackRight;
    var y = ref && typeof ref.y === "number" ? ref.y : 0;
    var oy = ref && typeof ref.originY === "number" ? ref.originY : 0.5;
    var text = Q.add.text(right, y, name, style).setOrigin(1, oy);
    // 不能蓋到任務名：放不下就截斷加省略號
    var left = ref && typeof ref.x === "number"
      ? ref.x + (ref.width || 0) * (1 - (typeof ref.originX === "number" ? ref.originX : 0)) + 6
      : right - 70;
    var room = right - left;
    var s = name;
    while (s.length > 1 && text.width > room) {
      s = s.slice(0, -1);
      text.setText(s + "…");
    }
    if (room < 12) text.setVisible(false);
    row.add(text);

    var tip = Q.add.container(row.x + right, row.y - 10);
    var label = Q.add.text(0, 0, pick(CFG.gifterTooltip, gameLang()).replace("__NAME__", name), {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(1, 1);
    var back = Q.add.rectangle(0, 0, label.width, label.height, 0, 0.85).setOrigin(1, 1);
    tip.add(back);
    tip.add(label);
    tip.setVisible(false);
    try { tip.setDepth(100); } catch (e) {}

    // hover 掛在官方那一列的 list_zone 上；我們的字不 setInteractive（不搶點擊）
    var zone = row.list_zone || null;
    var over = function () { try { tip.setVisible(true); } catch (e) {} };
    var out = function () { try { tip.setVisible(false); } catch (e) {} };
    try {
      if (zone && typeof zone.on === "function") {
        zone.on("pointerover", over);
        zone.on("pointerout", out);
      }
    } catch (e) {}
    st.gift.push({ row: row, name: name, text: text, tip: tip, zone: zone, over: over, out: out });
  }

  // -------------------------------------------------------------------------
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      hookSocket(st);
      syncGifts(st);
      paintGifts(st);
      var panel = presentPanel();
      if (panel === null) {
        if (st.panel !== null) detach(st);
        return;
      }
      if (st.panel !== panel) {
        detach(st);
        st.panel = panel;
        // 每次開面板都重讀一次 —— 可能已經換日了。
        compute(st);
        mount(st, panel);
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    max: CFG.max,
    remain: null,
    mine: [],
    text: null,
    tip: null,
    panel: null,
    sock: null,
    timer: null,
    onPre: null,
    onError: null,
    gift: [],
    gifts: null,
    giftQuests: undefined,
    giftKey: null,
    reason: null
  };
  st.onPre = function (ok) { onPre(st, ok); };
  st.onError = function (code) { onError(st, code); };
  window[FLAG] = st;

  compute(st);
  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    remain: st.remain,
    max: st.max,
    mounted: st.text !== null,
    waiting: st.text === null,
    gifters: st.gifts ? Object.keys(st.gifts).length : 0,
    reason: st.reason
  });
})()`;
}

export const PRESENT_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({
        installed: false, version: null, remain: null, max: ${DEFAULT_PRESENT_MAX},
        mounted: false, waiting: false, gifters: 0, reason: null
      });
    }
    return JSON.stringify({
      installed: true,
      version: st.version,
      remain: st.remain,
      max: st.max,
      mounted: st.text !== null && st.text !== undefined,
      // 腳本裝著、等玩家打開贈送面板 —— 不是錯誤，UI 不要報紅。
      waiting: st.text === null || st.text === undefined,
      gifters: st.gifts ? Object.keys(st.gifts).length : 0,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, remain: null, max: ${DEFAULT_PRESENT_MAX},
      mounted: false, waiting: false, gifters: 0, reason: String((e && e.message) || e)
    });
  }
})()`;

export const PRESENT_UNINSTALL_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    unhookSocket(st);
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    dropAllGifts(st);
    delete window[FLAG];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/**
 * 把頁面回來的 JSON 讀成 {@link PresentStatus}。
 *
 * 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡 —— 丟例外的話呼叫端拿到的是
 * 一個跟贈送次數毫無關係的錯誤訊息。
 */
export function parsePresentStatus(raw: string): PresentStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      remain: null,
      max: DEFAULT_PRESENT_MAX,
      mounted: false,
      waiting: false,
      gifters: 0,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    remain: typeof o.remain === "number" ? o.remain : null,
    max: typeof o.max === "number" ? o.max : DEFAULT_PRESENT_MAX,
    mounted: o.mounted === true,
    waiting: o.waiting === true,
    gifters: typeof o.gifters === "number" ? o.gifters : 0,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
