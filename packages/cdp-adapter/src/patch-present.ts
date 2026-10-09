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
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。所以詳細的東西寫在這個檔頭。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。跟 `__ulrLobby` / `__ulrRoomGate` 同一族。 */
const FLAG = "__ulrPresent";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * engine 看到頁面上的版本跟這個不一樣就重裝，所以這個數字一定要跟著動。
 */
export const PRESENT_SCRIPT_VERSION = 4;

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
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      hookSocket(st);
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
        mounted: false, waiting: false, reason: null
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
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, remain: null, max: ${DEFAULT_PRESENT_MAX},
      mounted: false, waiting: false, reason: String((e && e.message) || e)
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
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
