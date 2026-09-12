/**
 * 好友面板左上角的「今日還能送幾張地圖」
 * ======================================
 * 玩家按任務畫面的 PRESENT 鈕 → 跳出好友面板 → 挑一個人把地圖送出去。
 * 每天有次數上限，而**官方沒有任何地方顯示還剩幾次** —— 送到第六次才會跳
 * 「今天無法再贈送任務」。Discord 的地圖交換區是照著約定一次換好幾張的，
 * 所以「談好了卻送不出去，只能明天再補」是每天都在發生的事。
 *
 * ## ⭐ 這個數字**不用自己數** —— 伺服器早就送過來了
 *
 * 2026-09-12 在跑著的客戶端上挖出來的：
 *
 * ```
 *   await socket.fetch("db_quest", id)
 *   → { 0..19: {…}, map, region, proceed, …, quest_max, deckinfo,
 *       pre_id, pre_remain }          ← 就是它
 * ```
 *
 * `pre_remain` 是**今日剩餘次數**（滿值 5，實測玩家當天還沒送過時就是 5）。
 * 整份 bundle grep `pre_remain` **零命中** —— 伺服器每次 `db_quest` 都送，
 * 客戶端從來沒讀過它。所以這支不是「插件自己算一個估計值」，是**把伺服器
 * 本來就講了、只是沒人聽的那句話顯示出來**。
 *
 * ⚠ 這一點決定了整支的形狀。自己數會踩到兩個沒有答案的問題：上限到底是不是
 * 5（伺服器說了算）、每日重置是幾點幾分哪個時區（客戶端**完全沒有**那個
 * 資訊 —— grep `setHours` / `864e5` / `timeZone` 全是道具到期倒數，沒有一處
 * 在算日界）。讀 `pre_remain` 兩個問題都不存在。
 *
 * ## 為什麼場景裡找不到它
 *
 * `Quest` 場景拿到 `db_quest` 之後只挑欄位複製，其餘當場丟掉 —— 深度掃活著的
 * 物件圖是掃不到 `pre_remain` 的（實測掃過 60128 個物件，零命中）。
 * `Lobby.quest` 存的才是**完整**的回應，所以那裡讀得到。
 *
 * 取值順序因此是：
 *
 * ```
 *   1. Quest.socket.fetch("db_quest", id)   ← 最新，而且送完之後會變
 *   2. Lobby.quest.pre_remain               ← 進任務畫面前的快照，拿來墊檔
 * ```
 *
 * ## 送出之後怎麼更新
 *
 * `Friend` 場景上有現成的事件，不必去包任何方法：
 *
 * ```js
 *   // Quest.create() 裡：
 *   x.events.on("quest_present", async (t, e) => {
 *     const s = await this.socket.fetch("quest_pre", this.id, this.list_select, t, e);
 *     x.events.emit("quest_present_code", s);      ← 我們聽這個
 *   });
 * ```
 *
 * 代碼對應 `PRESENT_CODE[lang]`：0 成功、1 失敗、2 這張不能送、3 AP 不足、
 * 4 對方任務欄滿、5 今天不能再送。
 *
 * ⚠ **只有 0 才扣**。3/4 是「這一次沒送成」，次數沒有被消耗 —— 跟著扣的話
 * 玩家會以為自己少了一次，而那正是這個功能要消滅的那種不確定。
 * 收到 5 就直接把顯示歸零（伺服器的說法優先於我們的計數）。
 *
 * ⚠ 扣完**還是要再 fetch 一次**。本機遞減只是為了讓數字立刻動（送出到
 * 伺服器回話中間有幾百毫秒），真相一律以 `pre_remain` 為準。
 *
 * ## 畫面：跟右邊的好友數對稱，就這樣
 *
 * 面板右上角有遊戲自己的 `friend_max`：
 *
 * ```js
 *   this.friend_max = t.add.text(180, -140,
 *     `Friends ${friends.length}/${friend_max}`,
 *     { fontFamily: "font_light", fontSize: 10, resolution: 2, color: "black",
 *       padding: { bottom: 3 } }).setOrigin(0, 1);
 * ```
 *
 * 我們畫的是它的鏡像：**同一個 y、同一套字體、`x` 取負、origin 改成靠右**，
 * 於是兩個計數各據面板上緣一角。字型與大小完全照抄 —— 自己挑一個會立刻
 * 看出來是外面貼上去的。
 *
 * ⚠⚠ **面板上只放四個字**（`剩5/5`）。說明放 hover tooltip，不放面板上。
 * 好友面板 528×408 裡已經塞了分頁、格線、排序、分頁器，多一句完整說明會
 * 擠掉原本的資訊，而且一眼就像外掛。這是使用者 2026-09-12 直接要求的。
 *
 * ## ⚠ 面板是**每次開都重新 new 的**
 *
 * `open_panel()` 裡 `this.friend_panel = new b(this, i, s)` —— 玩家每開一次
 * 好友面板就是一個新物件，我們掛上去的東西會跟著舊物件一起被 destroy。
 * 跟 `patch-lobby` 盯 `channel_panel` 同一個問題，解法也一樣：輪詢（500ms）
 * 盯著 `friend_panel` 換人沒有，換了就重掛。
 *
 * ⚠ 分頁切換（`refresh_tab`）只重建 `panel.tab`，**不重建 panel**，所以我們
 * 掛在 panel 上的東西撐得過切分頁 —— 這正是要掛在 panel 而不是 tab 上的理由。
 *
 * ## ⚠ 只在 present 分頁顯示
 *
 * `panel.tab_name === "present"` 才畫。玩家從右下角 FRIENDLIST 鈕開的同一個
 * 面板（`tab_name === "friend"`）不該出現贈送次數 —— 那裡沒有東西可以送。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束（`patch-lobby` 與 `match-room` 都
 * 記過同一件事）。所以詳細的東西寫在這個檔頭 —— 它在字串外面。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。跟 `__ulrLobby` / `__ulrRoomGate` 同一族。 */
const FLAG = "__ulrPresent";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * 這支跟 `patch-lobby` 一樣是「先拆再裝」，所以不靠版本號決定要不要重裝；
 * 版本號是回報用的 —— 玩家回報怪狀況時一眼看得出他頁面上跑的是哪一版。
 */
export const PRESENT_SCRIPT_VERSION = 1;

/** 盯著 `friend_panel` 換人沒有的間隔。跟 patch-lobby 一樣 500ms。 */
export const DEFAULT_PRESENT_POLL_MS = 500;

/**
 * 顯示用的分母預設值。
 *
 * ⚠ **這只是「伺服器還沒講話時拿來墊的數字」，不是真相。** 真相是
 * `pre_remain`，而分母伺服器沒有明講 —— 所以腳本看到 `pre_remain` 比它大時
 * 會把分母頂上去（官方哪天調成 10，畫面會自己變成 `剩10/10` 而不是
 * 一個永遠說謊的 `/5`）。
 */
export const DEFAULT_PRESENT_MAX = 5;

export interface PresentPatchOptions {
  pollIntervalMs?: number;
  /** 分母的起始值。見 {@link DEFAULT_PRESENT_MAX}。 */
  max?: number;
}

export interface PresentStatus {
  installed: boolean;
  version: number | null;
  /** 目前讀到的剩餘次數。`null` = 還沒讀到（不在任務畫面、或 fetch 還沒回來）。 */
  remain: number | null;
  /** 目前用的分母。 */
  max: number;
  /** 字真的畫出來了沒（＝面板開著而且在 present 分頁）。 */
  mounted: boolean;
  /** 還在等玩家打開贈送面板。**不是錯誤**（跟 `patch-lobby` 同一個欄位）。 */
  waiting: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 面板上那四個字。`__N__` 是剩餘、`__MAX__` 是上限。
 *
 * ⚠ **不要加標點、不要加單位、不要超過四個字。** 對照組是遊戲自己的
 * `Friends 171/200` —— 一行、無說明、無標點。
 */
const LABEL: Record<string, string> = {
  ja: "残__N__/__MAX__",
  en: "__N__/__MAX__",
  kr: "남__N__/__MAX__",
  scn: "剩__N__/__MAX__",
  tcn: "剩__N__/__MAX__",
};

/** hover 才出現的說明。面板上放不下的話都放這裡。 */
const TOOLTIP: Record<string, string> = {
  ja: "本日残りのクエスト送信回数",
  en: "Quest gifts left today",
  kr: "오늘 남은 퀘스트 전송 횟수",
  scn: "今日剩余赠送任务次数",
  tcn: "今日剩餘贈送任務次數",
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
    var panel = sc && sc.friend_panel;
    if (!panel || panel.active === false) return null;
    return panel.tab_name === "present" ? panel : null;
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
    label: LABEL,
    tooltip: TOOLTIP,
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
    try {
      // ⚠ Friend 場景是長命的（換畫面不會 destroy），監聽留著會在下一次安裝時
      // 變成兩份，於是送一次扣兩次。
      if (st.codeHandler) {
        var fs = sceneOf("Friend");
        if (fs && fs.events) fs.events.off("quest_present_code", st.codeHandler);
      }
    } catch (e) {}
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
  // 取值
  // -------------------------------------------------------------------------

  /** 進任務畫面前的快照。Lobby 存的是完整的 db_quest 回應。 */
  function cachedRemain() {
    try {
      var lb = sceneOf("Lobby");
      var q = lb && lb.quest;
      var v = q && q.pre_remain;
      return typeof v === "number" ? v : null;
    } catch (e) { return null; }
  }

  /** 跟伺服器要最新的。read-only，跟遊戲自己載入時做的是同一個 fetch。 */
  function refresh(st) {
    if (st.fetching) return;
    var q = sceneOf("Quest");
    var sock = q && q.socket;
    if (!sock || typeof sock.fetch !== "function" || !q.id) {
      // 還沒進任務畫面 —— 先用大廳那份快照墊著，不算錯誤。
      if (st.remain === null) {
        var c = cachedRemain();
        if (c !== null) { adopt(st, c); paint(st); }
      }
      return;
    }
    st.fetching = true;
    try {
      Promise.resolve(sock.fetch("db_quest", q.id)).then(function (r) {
        st.fetching = false;
        var v = r && r.pre_remain;
        if (typeof v === "number") { adopt(st, v); st.reason = null; }
        else st.reason = "db_quest 回應裡沒有 pre_remain";
        paint(st);
      }, function (e) {
        st.fetching = false;
        st.reason = "db_quest 問不到：" + String((e && e.message) || e);
      });
    } catch (e) {
      st.fetching = false;
      st.reason = String((e && e.message) || e);
    }
  }

  /** 收下一個剩餘值。⚠ 分母跟著頂上去，見 DEFAULT_PRESENT_MAX 的說明。 */
  function adopt(st, remain) {
    st.remain = remain < 0 ? 0 : remain;
    if (st.remain > st.max) st.max = st.remain;
  }

  // -------------------------------------------------------------------------
  // 畫面
  // -------------------------------------------------------------------------

  function labelText(st) {
    var lang = gameLang();
    return pick(CFG.label, lang)
      .replace("__N__", String(st.remain))
      .replace("__MAX__", String(st.max));
  }

  function paint(st) {
    if (!st.text) return;
    try {
      st.text.setText(st.remain === null ? "" : labelText(st));
      // 送完了就變紅。這是唯一的額外資訊，而且不佔字數。
      st.text.setColor(st.remain === 0 ? "#a01010" : "black");
    } catch (e) {}
  }

  /**
   * 把字掛到面板上。
   *
   * ⚠ 位置是 friend_max 的鏡像：同一個 y、x 取負、origin 改成靠右。
   * 字體那幾個值是從遊戲自己的 friend_max 抄的，不要自己挑。
   */
  function mount(st, panel) {
    var sc = sceneOf("Friend");
    if (!sc) return;
    var src = panel.friend_max;
    var style = {
      fontFamily: "font_light",
      fontSize: 10,
      resolution: 2,
      color: "black",
      padding: { bottom: 3 }
    };
    if (src && src.style) {
      // 官方哪天改了字體，跟著改 —— 對稱才成立。
      if (src.style.fontFamily) style.fontFamily = src.style.fontFamily;
      if (src.style.fontSize) style.fontSize = src.style.fontSize;
    }
    var x = src && typeof src.x === "number" ? -src.x : -180;
    var y = src && typeof src.y === "number" ? src.y : -140;

    var text = sc.add.text(x, y, "", style).setOrigin(1, 1);
    panel.add(text);
    st.mine.push(text);
    st.text = text;

    mountTooltip(st, panel, text, x, y);
    paint(st);
  }

  /** hover 才出現的說明。面板上不留任何常駐說明文字。 */
  function mountTooltip(st, panel, text, x, y) {
    var sc = sceneOf("Friend");
    var lang = gameLang();
    var tip = sc.add.container(x, y + 4);
    var label = sc.add.text(0, 0, pick(CFG.tooltip, lang), {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(0, 0);
    var back = sc.add.rectangle(0, 0, label.width, label.height, 0, 0.85).setOrigin(0, 0);
    tip.add(back);
    tip.add(label);
    tip.setVisible(false);
    panel.add(tip);
    // ⚠ 要壓在好友格線上面，否則會被下一頁重畫的卡片蓋掉。
    try { panel.bringToTop(tip); } catch (e) {}
    st.mine.push(tip);
    st.tip = tip;

    try {
      text.setInteractive({ useHandCursor: false });
      text.on("pointerover", function () {
        try { tip.setVisible(true); panel.bringToTop(tip); } catch (e) {}
      });
      text.on("pointerout", function () {
        try { tip.setVisible(false); } catch (e) {}
      });
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 送出之後
  // -------------------------------------------------------------------------

  /**
   * Quest 把伺服器的回覆轉發到 Friend 的事件上，我們順便聽一耳朵。
   *
   * ⚠ 只有 0（成功）才扣。3/4 是「這一次根本沒送成」，次數沒有被消耗。
   */
  function onCode(st, code) {
    if (code === 0 && typeof st.remain === "number" && st.remain > 0) {
      st.remain -= 1;
      paint(st);
    } else if (code === 5) {
      st.remain = 0;
      paint(st);
    }
    // 本機遞減只是為了讓數字立刻動。真相一律回去問伺服器。
    refresh(st);
  }

  // -------------------------------------------------------------------------
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var panel = presentPanel();
      if (panel === null) {
        // 面板關了、或切到別的分頁 —— 收掉，但**留著 st.remain**，下次開得快。
        if (st.panel !== null) detach(st);
        return;
      }
      if (st.panel !== panel) {
        detach(st);
        st.panel = panel;
        mount(st, panel);
        // 每次開面板都重問一次 —— 玩家可能在別台機器上送過。
        refresh(st);
      }
      if (st.remain === null && !st.fetching) refresh(st);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    max: CFG.max,
    remain: null,
    fetching: false,
    mine: [],
    text: null,
    tip: null,
    panel: null,
    timer: null,
    codeHandler: null,
    reason: null
  };
  window[FLAG] = st;

  // 先用大廳那份快照墊著，玩家一開面板就有數字。
  var cached = cachedRemain();
  if (cached !== null) adopt(st, cached);

  try {
    var fs = sceneOf("Friend");
    if (fs && fs.events) {
      st.codeHandler = function (code) { onCode(st, code); };
      fs.events.on("quest_present_code", st.codeHandler);
    }
  } catch (e) {}

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
    try {
      if (st.codeHandler) {
        var fs = sceneOf("Friend");
        if (fs && fs.events) fs.events.off("quest_present_code", st.codeHandler);
      }
    } catch (e) {}
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
