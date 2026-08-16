/**
 * 把隱藏地圖加進遊戲自己的開房對話框
 * =====================================
 * `match-room.ts` 是**插件替玩家開房**（我們自己送 `match_room_make`），所以
 * 想開哪張圖就填哪個代號，遊戲的選單長什麼樣一點關係都沒有。這一支是另一件
 * 事：讓玩家用**遊戲原本的「創建對戰房間」對話框**開隱藏地圖 —— 房名、規則、
 * 密碼、AP 全部走官方流程，只是「對戰地點」那個下拉多了四列。
 *
 * ## 兩個地方都要改，缺一個就會壞
 *
 * 2026-08-15 從跑著的客戶端挖出來的（chunk 403）：
 *
 * ```js
 *   class u extends Phaser.Scene {            // ← Match 場景
 *     static STAGES = { …, tcn: [ {name,value} × 11 ] }
 *     async room_make(cross) { … n = new T(this, cross) … }
 *   }
 *
 *   class T extends Phaser.GameObjects.Container {   // ← 開房對話框
 *     constructor(scene, cross) {
 *       scene.add.existing(this)                     // ← ①
 *       this.stage = u.STAGES[lang][0].value
 *       this.stage_dropdown = this.create_dropdown(…, this.create_stage_child())
 *       this.stage_dropdown.on("child.down", (item) => {
 *         this.stage = u.STAGES[lang].find((s) => s.name === item.name)?.value   // ← ②
 *       })
 *     }
 *     create_stage_child() {
 *       for (let i = 0; i < 11; i++) { … u.STAGES[lang][i].name … }              // ← ③
 *     }
 *   }
 * ```
 *
 * - **② 只認 `STAGES`**：選了哪一列是拿**名稱**回去查代號的。沒把地圖加進
 *   `STAGES` 就選不出值，`this.stage` 會是 `undefined`，而伺服器對 `null`／
 *   `undefined` 的回應是 `fail: 20`。
 * - **③ 寫死 11**：`STAGES` 加到 15 筆，選單畫出來的仍然只有前 11 列。
 *
 * 所以兩邊都要動：`STAGES` 加四筆（給 ②），`create_stage_child` 補四列（給 ③）。
 *
 * ## ⚠ 對話框那個類別在模組外面拿不到
 *
 * `T` 是模組內的區域變數，webpack 沒有把它匯出（同一個模組只匯出兩個東西，
 * 都是場景類別）。`req(id)` 拿得到 `STAGES` 那個類別，拿不到對話框。
 *
 * 解法是攔 ① ——「對話框把自己加進場景」那一刻：
 *
 * ```
 *   玩家按開房 → room_make()  ← 我們包在外面，暫時換掉 this.add.existing
 *                    │
 *                    └─ new T(scene) → scene.add.existing(this)   ← 攔到了
 *                                        │  這時 constructor 還沒跑到
 *                                        │  create_stage_child()
 *                                        └─ 從實例拿到 T.prototype，補丁裝上去
 *                              → this.create_stage_child()  ← 已經是補過的版本
 * ```
 *
 * ⚠ **`room_make` 是 async，但這樣攔是安全的**：`new T(...)` 在第一個 `await`
 * 之前就跑完了（它在 `new Promise(executor)` 的 executor 裡，那是同步執行的），
 * 所以 `orig.apply()` 一回到我們手上，對話框早就建好了 —— `finally` 裡還原
 * `add.existing` 不會太早。
 *
 * ⚠ 換掉的是**場景自己那個 factory 實例**上的欄位，不是
 * `GameObjectFactory.prototype`。攔截只在開房對話框的那幾微秒內存在，遊戲其餘
 * 每一次 `add.existing` 都完全沒有被碰過。
 *
 * ## 這支不改變伺服器判定
 *
 * 送出去的仍然是遊戲自己送的 `match_room_make`，參數也是玩家自己在對話框上選
 * 的。伺服器本來就收這四個代號（2026-08-15 實測開房不會被拒），插件只是讓那
 * 四個選項在選單上**出得來**。§12 硬規則 4 講的是「不得改變伺服器判定」，這裡
 * 一個位元都沒有替玩家決定。
 */

import { embedJson } from "./embed.js";

/** 一張要加進選單的地圖。跟 `HIDDEN_STAGES` 同形狀。 */
export interface HiddenStage {
  /** 3 位數字串代號，例如 `"010"`。 */
  value: string;
  /** 選單上顯示的名稱。⚠ 遊戲是**用名稱回查代號**的，不能跟官方那 11 個撞名。 */
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
  /** 遊戲目前的語言（`STAGES` 是按語言分的）。 */
  lang: string | null;
  /** 已經加進 `STAGES[lang]` 的代號。 */
  added: string[];
  /**
   * 選單本身補上了沒。
   *
   * ⚠ **`false` 不是錯誤**，是「玩家還沒開過一次『創建對戰房間』」—— 對話框
   * 那個類別要等它第一次被 new 出來才碰得到（見檔頭）。而補丁是在同一次
   * constructor 裡、畫選單**之前**裝上的，所以玩家第一次開對話框就看得到
   * 那四列，不必開兩次。
   *
   * UI 要照實說，不要因為「反正下次就會生效」就寫成已生效。
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
 * ⚠ **這支不靠版本號決定要不要重裝** —— 跟 `match-room` 那支不同，這裡每次
 * 安裝都先 `restore()` 再從原狀重來，所以「頁面上跑著舊版」這個坑在設計上就
 * 不存在。版本號純粹是回報用的：玩家回報怪狀況時，`status()` 帶回來的這個數字
 * 能一眼看出他頁面上跑的是哪一版。
 */
export const HIDDEN_STAGE_SCRIPT_VERSION = 1;

const FLAG = "__ulrStages";

/** 頁面端共用的那幾支函式。install 與 status 都要用，所以抽出來。 */
const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  /**
   * 帶 STAGES 的那個類別（＝ Match 場景）。
   *
   * ⚠ **不要求場景是 active 的** —— 玩家在對戰中、在牌組畫面時 Match 都不是
   * active，但類別一直都在，補丁也一直有效。要求 active 會讓「先裝好再去大廳」
   * 這個最自然的順序失敗。
   */
  function stageClass() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    if (!keys) return null;
    var direct = keys.Match;
    if (direct && direct.constructor && direct.constructor.STAGES) return direct.constructor;
    // 場景鍵換名字的話從全部場景裡找。找的是「有 STAGES 這個 static」的類別。
    for (var k in keys) {
      var sc = keys[k];
      if (sc && sc.constructor && sc.constructor.STAGES) return sc.constructor;
    }
    return null;
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : null;
  }

  /** 目前語言那一份地圖清單。⚠ 是**活的陣列**，push 進去就是改到遊戲本體。 */
  function stageList(K, lang) {
    var t = K && K.STAGES && K.STAGES[lang];
    return t && typeof t.length === "number" ? t : null;
  }

  /** 我們加進去的那幾筆（靠自己蓋的記號認，不靠位置）。 */
  function isOurs(entry) {
    return !!(entry && entry.__ulr === true);
  }
`;

/**
 * 產生要注入的 JS。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去就先把上一次加的東西全部拆掉，再從**原始**的
 * `room_make` 重新包 —— 不會疊補丁，也不會重複加地圖。
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
  //
  // 回傳上一次攔到的對話框 prototype —— 那個東西只有在對話框被 new 出來的時候
  // 才拿得到，丟掉的話玩家得再開一次對話框才會恢復。重連時會重裝，所以這條路
  // 一點都不罕見。
  function restore() {
    var st = window[FLAG];
    if (!st) return null;
    // ⚠ 上一次那支等待中的 timer 一定要停掉。不停的話它會照著**舊的**設定
    // 繼續往頁面上裝，而且兩支都在跑，誰後到誰贏。
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try {
      if (st.sceneProto && st.sceneProto.__ulrOrigRoomMake) {
        st.sceneProto.room_make = st.sceneProto.__ulrOrigRoomMake;
        delete st.sceneProto.__ulrOrigRoomMake;
      }
    } catch (e) {}
    var prevDialog = null;
    try {
      if (st.dialogProto && st.dialogProto.__ulrOrigStageChild) {
        st.dialogProto.create_stage_child = st.dialogProto.__ulrOrigStageChild;
        delete st.dialogProto.__ulrOrigStageChild;
        prevDialog = st.dialogProto;
      }
    } catch (e) {}
    try {
      var K = stageClass();
      var list = stageList(K, gameLang());
      if (list) {
        for (var i = list.length - 1; i >= 0; i--) if (isOurs(list[i])) list.splice(i, 1);
      }
    } catch (e) {}
    return prevDialog;
  }

  /**
   * 照抄原版 create_stage_child() 裡那一段的樣式（2026-08-15 的 bundle）。
   *
   * ⚠⚠ **底圖一定要比文字先建出來。**
   *
   * rexUI 的 label 不管誰畫在上面 —— 這兩個都是直接進場景的 display list
   * （parentContainer 是 null，實測過），而 display list 是**後建的畫在上面**。
   * 原版是寫在物件字面值裡的：background 那一行在前、text 那一行在後，
   * 而字面值的屬性是**照原始碼順序求值**的，所以原版剛好是對的。
   *
   * 這裡為了量寬度得先把 text 存進變數 —— 一不小心就把順序反過來，於是
   * **白色底圖蓋住字**。2026-08-15 實測踩過：那四列變成純白，而物件的每一個
   * 欄位（text、color、visible、座標、尺寸）跟官方那 11 列**逐欄比對完全一樣**，
   * 只有 display list 的索引差一位。看屬性是查不出來的。
   *
   * ⚠ 原版還會呼叫模組內的 fit_single() 把太長的名稱縮到 141px 寬。那支在模組
   * 外面拿不到，所以這裡自己縮 —— 不縮的話長名稱會壓到捲軸上。
   */
  function makeLabel(scene, name) {
    var background = scene.rexUI.add.roundRectangle({ color: 16777215 });
    var text = scene.add.text(0, 0, name, {
      fontFamily: "font_light", color: "black", fontSize: 13
    }).setResolution(2);
    // 縮到 9 為止 —— 再小就看不清楚了，寧可讓它稍微超出去。
    var size = 13;
    while (size > 9 && text.width > 141) { size--; text.setFontSize(size); }
    return scene.rexUI.add.label({
      background: background,
      text: text,
      space: { left: 3, right: 3, top: 5, bottom: 5 },
      // ⚠ name 就是遊戲回查代號的鍵（child.down 拿 item.name 去 STAGES 裡 find）。
      // 這一格填錯的症狀是「選得到但開房被拒 fail:20」。
      name: name
    });
  }

  /** 把我們加的那幾張補到選單的 sizer 尾巴。原版那 11 列完全沒有動到。 */
  function appendRows(scene, sizer) {
    var st = window[FLAG];
    if (!st || !sizer || typeof sizer.add !== "function") return;
    for (var i = 0; i < CFG.stages.length; i++) {
      var s = CFG.stages[i];
      // 只補**真的加進 STAGES** 的那幾張。加不進去的（撞名之類）補了也選不出值。
      if (st.added.indexOf(s.value) === -1) continue;
      sizer.add(makeLabel(scene, s.name), { expand: true });
    }
  }

  /**
   * 從對話框實例拿到它的 prototype，把 create_stage_child 包起來。
   *
   * 這支是在 constructor 進行到一半時被叫的（見檔頭），所以包完之後**同一次**
   * constructor 才會去叫 create_stage_child —— 玩家第一次開對話框就看得到。
   */
  function patchDialog(child) {
    if (!child) return;
    patchDialogProto(Object.getPrototypeOf(child));
  }

  function patchDialogProto(proto) {
    var st = window[FLAG];
    if (!st || !proto || typeof proto.create_stage_child !== "function") return;

    var orig = proto.__ulrOrigStageChild || proto.create_stage_child;
    proto.create_stage_child = function () {
      var sizer = orig.apply(this, arguments);
      try {
        appendRows(this.scene, sizer);
      } catch (e) {
        // 補不上就只是少那四列，官方的 11 列仍然正常 ——
        // 絕不能因為這個讓玩家的開房對話框爆掉。
      }
      return sizer;
    };
    proto.__ulrOrigStageChild = orig;
    st.dialogProto = proto;
    st.dropdownPatched = true;
  }

  /**
   * 包住 room_make：只在它跑的那一瞬間換掉場景的 add.existing，攔下對話框。
   *
   * ⚠ 換的是場景自己那個 factory **實例**上的欄位，用完就刪掉，
   * Phaser 的 GameObjectFactory.prototype 一個字都沒改。
   */
  function hookRoomMake(K) {
    var proto = K.prototype;
    var orig = proto.__ulrOrigRoomMake || proto.room_make;
    if (typeof orig !== "function") return false;

    proto.room_make = function () {
      var factory = this.add;
      var hadOwn = Object.prototype.hasOwnProperty.call(factory, "existing");
      var prev = factory.existing;
      factory.existing = function (obj) {
        try {
          patchDialog(obj);
        } catch (e) {
          // 攔不到就是選單少四列，開房本身照舊。
        }
        return prev.apply(this, arguments);
      };
      try {
        return orig.apply(this, arguments);
      } finally {
        // ⚠ 一定要還原，而且這裡還原**不會太早**：room_make 雖然是 async，
        // new <對話框>() 在第一個 await 之前就跑完了（見檔頭）。
        if (hadOwn) factory.existing = prev;
        else delete factory.existing;
      }
    };
    proto.__ulrOrigRoomMake = orig;
    return true;
  }

  /** 真正做事的那一段。回 false = 這次還不行，等一下再來。 */
  function apply() {
    var K = stageClass();
    if (K === null) {
      st.reason = "遊戲還沒載到對戰大廳那一段（找不到帶 STAGES 的場景類別）";
      return false;
    }
    var lang = gameLang();
    if (lang === null) { st.reason = "讀不到遊戲語言（window.lang）"; return false; }
    var list = stageList(K, lang);
    if (list === null) { st.reason = "Match.STAGES 裡沒有語言 " + lang; return false; }

    st.sceneProto = K.prototype;
    st.added = [];
    for (var i = 0; i < CFG.stages.length; i++) {
      var s = CFG.stages[i];
      var clash = false;
      for (var j = 0; j < list.length; j++) {
        // 代號重複 = 官方後來把它放進選單了，不必再加。
        // 名稱重複 = 更嚴重：遊戲是拿名稱回查代號的，撞名會讓官方那張選不出正確的值。
        if (list[j] && (list[j].value === s.value || list[j].name === s.name)) { clash = true; break; }
      }
      if (clash) continue;
      list.push({ name: s.name, value: s.value, __ulr: true });
      st.added.push(s.value);
    }

    // 這一輪如果是重裝，上一輪攔到的對話框 prototype 直接接回去 —— 不必等玩家
    // 再開一次對話框。
    if (prevDialog !== null) { patchDialogProto(prevDialog); prevDialog = null; }

    var hooked = hookRoomMake(K);
    st.installed = true;
    st.reason = hooked ? null : "場景上沒有 room_make —— 地圖加進去了，但選單補不上";
    return true;
  }

  function report() {
    return JSON.stringify({
      installed: st.installed, version: st.version, lang: gameLang(),
      added: st.added, dropdownPatched: st.dropdownPatched,
      waiting: st.timer !== null, reason: st.reason
    });
  }

  var prevDialog = restore();

  // ⚠ 狀態物件**先建起來**，即使這次裝不上 —— 它要掛住重試的 timer，而且
  // status() 得靠它分辨「還在等」跟「根本沒裝」。
  var st = {
    version: CFG.version, installed: false, added: [], dropdownPatched: false,
    sceneProto: null, dialogProto: null, timer: null, reason: null
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
 * 那種情況兩邊一致；但玩家換語言時 `STAGES[lang]` 會換成另一份陣列，旗標還在、
 * 地圖卻不在選單裡了。所以這裡回報的 `added` 是**當場從 `STAGES` 數出來的**，
 * 不是把安裝當時記的數字唸一遍。
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
    // ⚠ 這裡**當場從 STAGES 數**，不是把安裝時記的數字唸一遍 —— 玩家換遊戲
    // 語言時 STAGES[lang] 會換成另一份陣列，旗標還在、地圖卻已經不在選單裡。
    var list = stageList(stageClass(), lang);
    var added = [];
    if (list) {
      for (var i = 0; i < list.length; i++) if (isOurs(list[i])) added.push(list[i].value);
    }
    return JSON.stringify({
      installed: true, version: st.version, lang: lang, added: added,
      dropdownPatched: st.dropdownPatched === true, waiting: false,
      // 旗標在、地圖卻不在清單裡 —— 多半是玩家換了遊戲語言。
      reason: added.length === 0 ? "地圖不在目前語言的清單裡（換過語言？）—— 重新啟用一次" : st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, lang: null, added: [], dropdownPatched: false,
      waiting: false, reason: String((e && e.message) || e)
    });
  }
})()`;

/** 拆掉：地圖從 `STAGES` 移除、`room_make` 與選單還原。 */
export const HIDDEN_STAGE_UNINSTALL_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) return "not-installed";
    // ⚠ 還在等大廳的那支 timer 要先停。不停的話玩家關掉功能之後，等他進了大廳
    // 地圖又自己冒出來 —— 而且畫面上寫著「未啟用」。
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    if (st.sceneProto && st.sceneProto.__ulrOrigRoomMake) {
      st.sceneProto.room_make = st.sceneProto.__ulrOrigRoomMake;
      delete st.sceneProto.__ulrOrigRoomMake;
    }
    if (st.dialogProto && st.dialogProto.__ulrOrigStageChild) {
      st.dialogProto.create_stage_child = st.dialogProto.__ulrOrigStageChild;
      delete st.dialogProto.__ulrOrigStageChild;
    }
    // ⚠ 每一種語言都要掃過。玩家可能在啟用之後換過語言，那樣會有兩份清單被加過。
    var K = stageClass();
    var removed = 0;
    if (K && K.STAGES) {
      for (var lg in K.STAGES) {
        var list = stageList(K, lg);
        if (!list) continue;
        for (var i = list.length - 1; i >= 0; i--) {
          if (isOurs(list[i])) { list.splice(i, 1); removed++; }
        }
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
 * ⚠ 這不是防呆而已：代號是原封不動送進 `match_room_make` 的，格式錯了伺服器
 * 回的是 `fail: 20`，而那個代碼在這個專案裡被誤判成「AP 不足」很久。
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
