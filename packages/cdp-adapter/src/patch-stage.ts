/**
 * 把隱藏地圖加進遊戲自己的開房對話框
 * =====================================
 * `match-room.ts` 是**插件替玩家開房**（我們自己送開房請求），所以想開哪張圖
 * 就填哪個代號，遊戲的選單長什麼樣一點關係都沒有。這一支是另一件事：讓玩家用
 * **遊戲原本的「創建對戰房間」對話框**開隱藏地圖 —— 房名、規則、密碼、AP 全部
 * 走官方流程，只是「對戰地點」那個下拉多了四列。
 *
 * ## 2026-09-23 改版之後選單從哪來
 *
 * 從跑著的客戶端挖出來的（chunk 191，2026-09-27）：
 *
 * ```js
 *   class Match extends Phaser.Scene {
 *     preload() { … this.load.json("MatchUITexts", `…/data-${lang}/MatchUITexts.json`) }
 *     create_panel(ch) {                              // ← 「創建對戰房間」
 *       f = this.create_stage_option(x, y)
 *       … R = { room_name, stage: f.value, … }
 *       this.socket_channel.fetch("create_room", this.deck_now, ch.channel, R)
 *     }
 *     create_stage_option(x, y) {
 *       const i = this.cache.json.get("MatchUITexts")
 *       return this.rexUI.add.dropDownList({ options: i.room_config.stage.option, … })
 *     }
 *   }
 * ```
 *
 * `room_config.stage.option` 是 `{text, value}` 的陣列，`value` 是**數字**
 * （0〜9，「隨機」是 999），選了哪一列就直接拿那一列的 `value` 送出去 ——
 * 不再是舊版那種「拿名稱回查代號」、也沒有寫死 11 列的迴圈。所以只要在對話框
 * 建出來**之前**把四筆推進那個陣列就好。
 *
 * ⚠ **不能只推一次。** `preload()` 每次進 Match 都會 `load.json("MatchUITexts")`：
 * 快取裡有那個鍵時 Phaser 會跳過，但換語言、或快取被清掉時會換成一份新的
 * 陣列，我們加的就不見了。所以這支包的是 `create_stage_option` —— 每次開
 * 對話框前檢查一次、少了就補，**活的那一份陣列是誰都無所謂**。
 *
 * ⚠ 改版前（2026-08-15）那一版攔的是 `Match.STAGES`／`room_make`／
 * `create_stage_child`，改版後三個都不存在了，舊腳本會一直停在「等對戰大廳」。
 *
 * ## 這支不改變伺服器判定
 *
 * 送出去的仍然是遊戲自己送的 `create_room`，參數也是玩家自己在對話框上選的。
 * 插件只是讓那四個選項在選單上**出得來**。§12 硬規則 4 講的是「不得改變伺服器
 * 判定」，這裡一個位元都沒有替玩家決定。
 */

import { embedJson } from "./embed.js";

/** 一張要加進選單的地圖。 */
export interface HiddenStage {
  /** 3 位數字串代號，例如 `"011"`。頁面上會轉成數字（改版後選單的 `value` 是數字）。 */
  value: string;
  /** 選單上顯示的名稱。不能跟官方那 11 個撞名（同名兩列玩家分不出來）。 */
  name: string;
}

export interface HiddenStagePatchOptions {
  stages: readonly HiddenStage[];
  /** 還沒載到 Match 那一段時，多久回頭看一次。 */
  pollIntervalMs?: number;
  /** 等這麼久還是沒出現就放棄（玩家可以再按一次啟用）。 */
  maxWaitMs?: number;
}

export const DEFAULT_STAGE_POLL_MS = 500;
/**
 * 等 Match 類別出現的上限。
 *
 * 比 `patch-penalty` 的 60 秒長：那支等的是牌組畫面用的類別，玩家按下去的時候
 * 通常已經在遊戲裡了；這支要撐過「先開插件，再開遊戲，登入，進大廳」整段。
 */
export const DEFAULT_STAGE_MAX_WAIT_MS = 300_000;

export interface HiddenStageStatus {
  /** 補丁在頁面上還在不在。遊戲重載過就會是 `false`（evaluate 裝的東西會被沖掉）。 */
  installed: boolean;
  /** 頁面上那支腳本的版本。跟 {@link HIDDEN_STAGE_SCRIPT_VERSION} 對不上就是舊版。 */
  version: number | null;
  /** 遊戲目前的語言。 */
  lang: string | null;
  /** 已經（或下次開對話框時會）出現在選單裡的代號，3 位數字串。 */
  added: string[];
  /**
   * 選單本身補上了沒。
   *
   * 改版後的選單每次開對話框都從快取的陣列現建，而補丁包的是建選單那一支，
   * 所以裝上去就等於補上了 —— 跟 `installed` 同步。欄位留著是給 UI 的舊判斷用。
   */
  dropdownPatched: boolean;
  /**
   * 還在等遊戲載到對戰大廳那一段。
   *
   * ⚠ 「先開插件再開遊戲」是玩家實際的順序，而那時候 Match 場景的類別根本還
   * 沒載進來 —— 這個狀態是**常態，不是錯誤**。頁面上那支腳本會自己等，
   * 等到了就補上，UI 不必叫玩家做任何事。
   */
  waiting: boolean;
  /** 裝不上去的原因。`null` = 沒問題。 */
  reason: string | null;
}

/**
 * 腳本版本。改動注入腳本就 +1。
 *
 * ⚠ **這支不靠版本號決定要不要重裝** —— 每次安裝都先 `restore()` 再從原狀重來。
 * 版本號純粹是回報用的：玩家回報怪狀況時，`status()` 帶回來的這個數字能一眼
 * 看出他頁面上跑的是哪一版。
 *
 * 2 = 2026-09-23 改版後的做法（包 `create_stage_option`、推進 `MatchUITexts`）。
 */
export const HIDDEN_STAGE_SCRIPT_VERSION = 2;

const FLAG = "__ulrStages";

/** 頁面端共用的那幾支函式。install、status、uninstall 都要用，所以抽出來。 */
const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  /**
   * 有 create_stage_option 的那個場景類別（＝ Match）。
   *
   * ⚠ **不要求場景是 active 的** —— 玩家在對戰中、在牌組畫面時 Match 都不是
   * active，但類別一直都在，補丁也一直有效。
   */
  function matchClass() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    if (!keys) return null;
    var direct = keys.Match;
    if (direct && direct.constructor && typeof direct.constructor.prototype.create_stage_option === "function") {
      return direct.constructor;
    }
    for (var k in keys) {
      var sc = keys[k];
      if (sc && sc.constructor && sc.constructor.prototype &&
          typeof sc.constructor.prototype.create_stage_option === "function") return sc.constructor;
    }
    return null;
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : null;
  }

  /**
   * 選單的來源陣列。⚠ 是**活的陣列**，push 進去就是改到遊戲本體。
   * 還沒載進快取時是 null —— 那不是錯誤，補丁會在開對話框那一刻補。
   */
  function optionList() {
    var c = window.game && window.game.cache && window.game.cache.json;
    var t = c && typeof c.get === "function" ? c.get("MatchUITexts") : null;
    var o = t && t.room_config && t.room_config.stage && t.room_config.stage.option;
    return o && typeof o.length === "number" ? o : null;
  }

  /** 我們加進去的那幾筆（靠自己蓋的記號認，不靠位置）。 */
  function isOurs(entry) {
    return !!(entry && entry.__ulr === true);
  }

  /** 選單的數字代號 → 插件用的 3 位數字串。 */
  function code(v) {
    return ("00" + v).slice(-3);
  }

  function oursIn(list) {
    var out = [];
    if (list) for (var i = 0; i < list.length; i++) if (isOurs(list[i])) out.push(code(list[i].value));
    return out;
  }
`;

/**
 * 產生要注入的 JS。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去就先把上一次加的東西全部拆掉，再從**原始**的
 * `create_stage_option` 重新包 —— 不會疊補丁，也不會重複加地圖。
 */
export function buildHiddenStageScript(options: HiddenStagePatchOptions): string {
  assertValidStages(options.stages);

  // ⚠ 地圖清單是**資料**。它只會被 JSON.parse，永遠不會被當程式碼執行（§12）。
  const config = {
    stages: options.stages,
    version: HIDDEN_STAGE_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_STAGE_POLL_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_STAGE_MAX_WAIT_MS,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  ${SHARED}

  // 先把上一次裝的拆乾淨。**重裝一律從原狀開始**，這樣「改了腳本再跑一次」
  // 跟「第一次跑」的結果完全一樣。
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    // ⚠ 上一次那支等待中的 timer 一定要停掉。不停的話它會照著**舊的**設定
    // 繼續往頁面上裝，而且兩支都在跑，誰後到誰贏。
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try {
      if (st.sceneProto && st.sceneProto.__ulrOrigStageOption) {
        st.sceneProto.create_stage_option = st.sceneProto.__ulrOrigStageOption;
        delete st.sceneProto.__ulrOrigStageOption;
      }
    } catch (e) {}
    try {
      var list = optionList();
      if (list) for (var i = list.length - 1; i >= 0; i--) if (isOurs(list[i])) list.splice(i, 1);
    } catch (e) {}
  }

  /**
   * 把四張補進選單的來源陣列。已經在的不重複加 —— 每次開對話框都會叫。
   *
   * 代號已經在官方清單裡 = 官方後來把它放進選單了，不必再加。
   * 名稱跟官方的撞 = 同名兩列玩家分不出來，也不加。
   */
  function ensure(list) {
    var added = [];
    if (!list) return added;
    for (var i = 0; i < CFG.stages.length; i++) {
      var s = CFG.stages[i];
      var v = Number(s.value);
      var mine = false, clash = false;
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (!e) continue;
        if (e.value === v || e.text === s.name) {
          if (isOurs(e)) mine = true; else clash = true;
          break;
        }
      }
      if (clash) continue;
      if (!mine) list.push({ text: s.name, value: v, __ulr: true });
      added.push(s.value);
    }
    return added;
  }

  /** 包住 create_stage_option：建選單之前先補一次。 */
  function hook(K) {
    var proto = K.prototype;
    var orig = proto.__ulrOrigStageOption || proto.create_stage_option;
    proto.create_stage_option = function () {
      try {
        var st = window[FLAG];
        var got = ensure(optionList());
        if (st && got.length > 0) st.added = got;
      } catch (e) {
        // 補不上就只是少那四列，官方的 11 列仍然正常 ——
        // 絕不能因為這個讓玩家的開房對話框爆掉。
      }
      return orig.apply(this, arguments);
    };
    proto.__ulrOrigStageOption = orig;
    st.sceneProto = proto;
  }

  /**
   * 還沒進過 Match（快取裡沒有 MatchUITexts）時，就先照設定算出「開對話框時
   * 會補上的那幾張」—— 撞不撞得到官方要等真的陣列在才知道，那時 hook 會更新。
   */
  function planned() {
    var out = [];
    for (var i = 0; i < CFG.stages.length; i++) out.push(CFG.stages[i].value);
    return out;
  }

  /** 真正做事的那一段。回 false = 這次還不行，等一下再來。 */
  function apply() {
    var K = matchClass();
    if (K === null) {
      st.reason = "遊戲還沒載到對戰大廳那一段（找不到 Match 場景類別）";
      return false;
    }
    hook(K);
    var list = optionList();
    st.added = list ? ensure(list) : planned();
    st.installed = true;
    st.dropdownPatched = true;
    st.reason = null;
    return true;
  }

  function report() {
    return JSON.stringify({
      installed: st.installed, version: st.version, lang: gameLang(),
      added: st.added, dropdownPatched: st.dropdownPatched,
      waiting: st.timer !== null, reason: st.reason
    });
  }

  restore();

  // ⚠ 狀態物件**先建起來**，即使這次裝不上 —— 它要掛住重試的 timer，而且
  // status() 得靠它分辨「還在等」跟「根本沒裝」。
  var st = {
    version: CFG.version, installed: false, added: [], dropdownPatched: false,
    sceneProto: null, timer: null, reason: null
  };
  window[FLAG] = st;

  if (!apply()) {
    // 還沒載到那一段就等它出現。⚠ **「先開插件再開遊戲」才是玩家實際的順序**，
    // 這條路是常態不是例外 —— 一次就放棄的話，功能會在「開著卻沒作用」的狀態
    // 停在那裡，而畫面上看起來一切正常。
    var waited = 0;
    st.timer = setInterval(function () {
      // 已經被重裝或拆掉了 —— 那一次有它自己的 timer，這支該退場。
      if (window[FLAG] !== st) { clearInterval(st.timer); return; }
      waited += CFG.pollIntervalMs;
      if (apply() || waited >= CFG.maxWaitMs) {
        clearInterval(st.timer);
        st.timer = null;
        if (!st.installed) st.reason = "等了 " + Math.round(CFG.maxWaitMs / 1000) + " 秒還是沒等到對戰大廳";
      }
    }, CFG.pollIntervalMs);
  }

  return report();
})()`;
}

/**
 * 問頁面現在的狀態。
 *
 * ⚠ **不能只看 `window.__ulrStages` 在不在。** 遊戲重載會把旗標跟補丁一起沖掉，
 * 那種情況兩邊一致；但補丁本身也可能被別的東西換掉（另一份腳本、舊版插件），
 * 所以這裡確認 `create_stage_option` 真的還是包過的那一支。
 */
export const HIDDEN_STAGE_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    var lang = gameLang();
    if (!st || !st.installed) {
      return JSON.stringify({
        installed: false, version: st ? st.version : null, lang: lang,
        added: [], dropdownPatched: false,
        // 腳本在頁面上等著（還沒進大廳）跟「根本沒裝」是兩件事，UI 的說法完全
        // 不一樣：前者不必叫玩家做任何事。
        waiting: !!(st && st.timer !== null && st.timer !== undefined),
        reason: st ? st.reason : null
      });
    }
    var K = matchClass();
    var hooked = !!(K && K.prototype.__ulrOrigStageOption);
    // 陣列在、裡面也有我們的 → 照實數；陣列被遊戲換掉了（換語言）→ 下次開
    // 對話框時 hook 會補回去，報安裝時算好的那份。
    var live = oursIn(optionList());
    return JSON.stringify({
      installed: hooked, version: st.version, lang: lang,
      added: live.length > 0 ? live : st.added,
      dropdownPatched: hooked, waiting: false,
      reason: hooked ? st.reason : "開房選單的補丁被換掉了（遊戲重載過？）—— 重新啟用一次"
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, lang: null, added: [], dropdownPatched: false,
      waiting: false, reason: String((e && e.message) || e)
    });
  }
})()`;

/** 拆掉：地圖從選單的來源陣列移除、`create_stage_option` 還原。 */
export const HIDDEN_STAGE_UNINSTALL_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) return "not-installed";
    // ⚠ 還在等大廳的那支 timer 要先停。不停的話玩家關掉功能之後，等他進了大廳
    // 地圖又自己冒出來 —— 而且畫面上寫著「未啟用」。
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    if (st.sceneProto && st.sceneProto.__ulrOrigStageOption) {
      st.sceneProto.create_stage_option = st.sceneProto.__ulrOrigStageOption;
      delete st.sceneProto.__ulrOrigStageOption;
    }
    var removed = 0;
    var list = optionList();
    if (list) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (isOurs(list[i])) { list.splice(i, 1); removed++; }
      }
    }
    delete window[FLAG];
    return "uninstalled:" + removed;
  } catch (e) { return "error: " + String((e && e.message) || e); }
})()`;

// ---------------------------------------------------------------------------

export class InvalidHiddenStageError extends Error {
  override readonly name = "InvalidHiddenStageError";
}

/**
 * 代號必須是 3 位數字、名稱不得空白。
 *
 * ⚠ 這不是防呆而已：代號會原封不動變成選單的 `value` 送進 `create_room`，
 * 格式錯了伺服器會拒絕開房。
 */
function assertValidStages(stages: readonly HiddenStage[]): void {
  const seen = new Set<string>();
  for (const s of stages) {
    if (!/^\d{3}$/.test(s.value)) {
      throw new InvalidHiddenStageError(`地圖代號必須是 3 位數字，收到 ${JSON.stringify(s.value)}`);
    }
    if (typeof s.name !== "string" || s.name.trim() === "") {
      throw new InvalidHiddenStageError(`地圖 ${s.value} 沒有名稱`);
    }
    if (seen.has(s.value)) {
      throw new InvalidHiddenStageError(`地圖代號 ${s.value} 重複`);
    }
    seen.add(s.value);
  }
}

const STATUS_KEYS = ["installed", "added", "dropdownPatched"] as const;

/** 頁面回的 JSON 字串 → `HiddenStageStatus`。形狀不對就當成沒裝上。 */
export function parseHiddenStageStatus(raw: string): HiddenStageStatus {
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
    lang: typeof o["lang"] === "string" ? o["lang"] : null,
    added: Array.isArray(o["added"])
      ? o["added"].filter((v): v is string => typeof v === "string")
      : [],
    dropdownPatched: o["dropdownPatched"] === true,
    waiting: o["waiting"] === true,
    reason: typeof o["reason"] === "string" ? o["reason"] : null,
  };
}

function notInstalled(reason: string): HiddenStageStatus {
  return {
    installed: false,
    version: null,
    lang: null,
    added: [],
    dropdownPatched: false,
    waiting: false,
    reason,
  };
}
