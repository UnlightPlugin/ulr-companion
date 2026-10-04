/**
 * 牌組庫的遊戲內介面（WP-18，2026-09-24 照改版後的客戶端重寫）
 * ============================================================
 * 規格 §3：**全部做在遊戲畫面裡，托盤視窗一個字都不加。**
 *
 * 動到的是左下角那一排（牌組編輯畫面與任務／渦／對戰房都一樣），以及牌組編輯
 * 畫面右邊「排序」底下：
 *
 * ```
 *   Deck1                       ← 牌組名。Edit 是 show_deck_label() 每次現建的
 *                                 那行字；房裡是 deck_name(60,644)。改成牌組庫的名字，
 *                                 Edit 裡點一下就地改名
 *   ◀ [牌盒] ▶  + -   reset     ← deck_prev(16,644) / deck_icon(32,644) / deck_next(46,644)
 *                                 牌盒點開選單；＋－只在 Edit、插件模式
 *
 *   排序(升序)  [ID    ▾]       ← sort_label(504,450) / sort_btn_drop（rexUI dropDownList）
 *   房間        [迪特赫姆 ▾]    ← 我們加的，照抄排序那一組，畫在它正下方
 * ```
 *
 * ## 兩種模式（`DeckEditState.mode`，關閉模式時 Node 直接把這支拆掉）
 *
 * ```
 *   plugin    ◀▶ 切的是這一房的自訂牌組（全部經過 Deck1），deck_now 釘 1
 *   official  ◀▶ 照官方（Deck1/2/3）；這一房的前三副就是那三格。選單裡點一副
 *             = 把它換進眼前那一格（兩副交換位置）
 * ```
 *
 * 牌組選單每一副一列，**三張卡面 + 右邊三行字**：
 *
 * ```
 *   ┌────┬────┬────┐  壓 C 用              ← 名字（眼前那副是黃字）
 *   │    │    │    │  標籤 海魚            ← 只有渦房
 *   └────┴────┴────┘  官方 110             ← 照房型畫一種總 COST
 * ```
 *
 * ## 三個「照抄」
 *
 * 1. **貼圖用遊戲自己的**（`deck_icon`、`btn_arrow_deck`、`btn_gene`、`panel_gene`、
 *    `CharaCardImages`）。自己畫一個會馬上被看出是外掛的東西。
 * 2. **字型與元件照抄旁邊的**：房間下拉跟排序下拉是同一個 rexUI `dropDownList`、
 *    同樣的底圖與配色。
 * 3. **輸入框用 rexUI 的 `InputText`**（遊戲自己就載了）。
 *
 * ## ⚠ 這支不決定任何牌組內容
 *
 * 它只做兩件事：**把 Node 推來的狀態畫出來**、**把玩家點了什麼回報給 Node**。
 * 牌組內容（卡片 id）會下放到頁面，但**只為了畫**卡面縮圖與總 COST，頁面從不
 * 把內容送回去。
 *
 * ## 總 COST 怎麼算
 *
 * 照 `Edit.get_chara_card_cost` 等三支（2026-09-24 讀原始碼）：角色＋每一對角色的
 * 壓 C（差 ≥14 罰 10、≥7 罰 5）＋武器＋事件卡。官方與自訂兩種價都要能算，而快取
 * 裡任一時刻只躺著其中一種 —— 另一種從 `patch-cost` 留在頁面的 `originals`／
 * `customs` 查（角色與怪物用 filename、武器與事件卡用 id）。
 *
 * ## ⚠ 場景每次進來都是重新 create
 *
 * 玩家離開再進來，我們掛上去的東西已經跟著舊場景被 destroy。所以這支用輪詢
 * （500ms）盯著「場景是不是 active 而且沒有我們的東西」，是的話就重掛一次。
 */

import { createHash } from "node:crypto";
import { CHARA_CARDS_KEY, EVENT_CARDS_KEY, WEAPON_CARDS_KEY } from "./constants.js";
import { embedJson } from "./embed.js";
import { COST_PATCH_FLAG } from "./patch-cost.js";
import { SIDE_LABEL } from "./patch-cost-toggle.js";
import type { PenaltyBand } from "./patch-penalty.js";

/**
 * 「房間」那一格的標題，五種語言。
 *
 * 旁邊「排序」是照 `lang` 換的，這一格也得換。用詞照官方在同一個畫面用的字
 * （`Match` 的房間列表），不要自己音譯。
 */
const ROOM_TITLE: Record<string, string> = {
  ja: "部屋",
  en: "Room",
  kr: "방",
  scn: "房间",
  tcn: "房間",
};

/** 渦 BOSS 標籤那一行的開頭。⚠ 只有渦房會畫。 */
const TAG_TITLE: Record<string, string> = {
  ja: "タグ",
  en: "Tag",
  kr: "태그",
  scn: "标签",
  tcn: "標籤",
};

/** 勾選渦 BOSS 那個面板的標題。 */
const BOSS_TITLE: Record<string, string> = {
  ja: "このデッキで倒せるレイド",
  en: "Raids this deck can beat",
  kr: "이 덱으로 잡을 수 있는 레이드",
  scn: "这副能打哪几种涡",
  tcn: "這副打得動哪幾種渦",
};

/**
 * 一副牌組的內容，**只拿來畫**（卡面縮圖、總 COST）。
 *
 * 形狀跟 `@ulr/deck-library` 的 `DeckContent` 一樣（全部是卡片 id），這裡另外
 * 宣告是因為這個 package 不依賴那一邊。
 */
export interface DeckEditContent {
  charaId: (number | null)[];
  weaponId: (number | null)[];
  eventId: (number | null)[];
}

/** 畫在選單裡的一副牌組。**只有畫出來要用的欄位。** */
export interface DeckEditItem {
  id: string;
  /** 已經套過 `displayName()` 的名字，頁面直接畫。 */
  name: string;
  /**
   * 渦 BOSS 標籤，放的是**鍵**（`sea`／`fish`…），不是顯示字。非渦房的恆為空。
   * 畫出來時頁面自己去 {@link DeckEditState.bossOptions} 查標籤。
   */
  bosses: string[];
  /** 三張卡是誰、帶什麼 —— 畫縮圖與算 COST 用。頁面**不會**把它送回來。 */
  content: DeckEditContent;
}

/** 某一格（`deck_id`）現在是庫裡哪一副、叫什麼。 */
export interface DeckEditSlot {
  /** 庫裡那一副的 id；對不上任何一副是 `null`（那一格的名字就是 `Deck{n}`）。 */
  id: string | null;
  name: string;
}

/** Node 推給頁面的狀態。**畫面上的每一個字都由這裡決定。** */
export interface DeckEditState {
  /**
   * 牌組替換模式。省略當 `plugin`（舊呼叫端）。關閉模式時 Node 不推狀態，而是
   * 整支拆掉。
   */
  mode?: "plugin" | "official";
  /**
   * 目前的房型鍵（`raid` / `alexandria` / `quest` / `dietherm`）。
   * ⚠ 頁面端**不認得**這些鍵的意思，只拿來比對與回報。
   */
  room: string;
  /** 房型的顯示名稱，照 `ROOM_KINDS` 的順序。「房間」下拉就照這個陣列列。 */
  rooms: { key: string; label: string }[];
  /** 這一房的牌組，順序就是玩家排的順序。 */
  decks: DeckEditItem[];
  /** 眼前那一副（黃字）。沒有就是 `null`。 */
  activeId: string | null;
  /** 渦 BOSS 標籤的選項，`{ key, label }`。 */
  bossOptions: { key: string; label: string }[];
  /**
   * 每一副旁邊要畫哪一種總 COST：`none`（任務／渦）、`official`（亞城）、
   * `custom`（迪城；沒選規則時退回官方）。省略時當 `official`。
   */
  costDisplay?: "none" | "official" | "custom";
  /**
   * 自訂規則的壓 C 區間；`null` = 規則沒寫（自訂那一欄用官方的 7→5、14→10）。
   */
  penaltyBands?: PenaltyBand[] | null;
  /**
   * 每一格左下那行字與改名對象，鍵是 `deck_id`（`"1"`..`"3"`）。插件模式只有
   * `"1"`（工作槽）；官方三牌組模式三格都有。沒有的格子畫原版的 `Deck{n}`。
   */
  slots?: Record<string, DeckEditSlot>;
  /*
   * ⚠ **這裡沒有 `notice`，而且不要加回來。** 訊息寫進托盤的記錄；遊戲畫面上
   * 只放「玩家正在操作的東西」（2026-09-09：那行紅字在渦房會壓到「輸入Raid代碼」）。
   */
}

/** 玩家在畫面上做了什麼。 */
export type DeckEditReport =
  | { type: "deck-select"; id: string }
  /**
   * ◀▶ 切上／下一副（插件模式才會回報；官方模式的箭頭照原版）。
   *
   * `from` 說的是**哪一組箭頭**：`menu` 是牌組編輯畫面裡那組（預設），`room` 是
   * 任務／渦／對戰房左下角那組。選單那組切「選單現在看的那一房」，房裡那組切
   * 「玩家人在的那一房」—— 切錯就是拿錯牌組上場。
   */
  | { type: "deck-cycle"; delta: number; from?: "menu" | "room" }
  | { type: "deck-add" }
  | { type: "deck-remove"; id: string }
  | { type: "deck-rename"; id: string; name: string }
  | { type: "deck-move"; id: string; toIndex: number }
  | { type: "deck-bosses"; id: string; bosses: string[] }
  | { type: "deck-save-current"; id: string }
  | { type: "room-switch"; room: string }
  /**
   * 渦房裡選中了一個渦。`mons` 是那隻 BOSS 的 `profound_mons`（`mc1008_02`）。
   * ⚠ 頁面**不翻成標籤鍵**，同一個渦只報一次。
   */
  | { type: "raid-pick"; mons: string }
  | { type: "deck-ui-error"; message: string };

const REPORT_TYPES = new Set([
  "deck-select",
  "deck-cycle",
  "deck-add",
  "deck-remove",
  "deck-rename",
  "deck-move",
  "deck-bosses",
  "deck-save-current",
  "room-switch",
  "raid-pick",
  "deck-ui-error",
]);

export function isDeckEditReport(value: unknown): value is DeckEditReport {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && REPORT_TYPES.has(t);
}

/**
 * 除了牌組編輯畫面以外，還有哪些場景畫著同一排牌組列。
 *
 * 2026-09-24 讀改版後的原始碼：四個場景這一排擺法完全一樣 ——
 * `deck_prev(16,644)`、`deck_next(46,644)`（貼圖 `btn_arrow_deck`，行為掛在
 * `pointerup`）、`deck_icon(32,644)`（純裝飾，連 input 都沒有）。房間場景另有
 * `deck_name(60,644)`，重畫是 `show_deck()`。
 */
const ROOM_SCENES = ["Quest", "Raid", "Match"] as const;

const FLAG = "__ulrDeckEdit";

/** 輪詢間隔。玩家進畫面到看見東西不會超過半秒。 */
export const DEFAULT_DECK_EDIT_POLL_MS = 500;

export interface DeckEditPatchOptions {
  /** 回報用的 binding 名稱。 */
  bindingName: string;
  /** 初始狀態。 */
  state: DeckEditState;
  pollMs?: number;
  /** 長按幾毫秒才進入拖曳（規格 §10 說 1 秒）。 */
  dragHoldMs?: number;
}

/** 產生要注入的腳本。 */
export function buildDeckEditPatchScript(options: DeckEditPatchOptions): string {
  return buildScript(options, DECK_EDIT_SCRIPT_VERSION);
}

/**
 * 雜湊用的固定狀態。**只有形狀重要，值不重要** —— 它存在的唯一理由是把
 * 「玩家的牌組」從指紋裡拿掉。
 */
const FINGERPRINT_STATE: DeckEditState = {
  room: "",
  rooms: [],
  decks: [],
  activeId: null,
  bossOptions: [],
};

/** 腳本內容的指紋。前 12 個 hex 就夠認人。 */
function fingerprint(): string {
  const canonical = buildScript({ bindingName: "__ulrFingerprint", state: FINGERPRINT_STATE }, "");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * 頁面端腳本的版本。**這是算出來的，不要手改** —— 版本 = 腳本內容的指紋，改了
 * 腳本它自己就變了（2026-09-09：手動維護的號碼忘了加，頁面上的舊腳本一直活著）。
 *
 * ⚠⚠ **這一行要放在它用到的東西後面**（`FINGERPRINT_STATE` 是 `const`，提到
 * 前面是 TDZ 錯誤，整個 package 會匯入失敗）。
 */
export const DECK_EDIT_SCRIPT_VERSION: string = fingerprint();

/**
 * 真正的腳本本體。
 *
 * ⚠ `version` 是參數而不是直接讀 {@link DECK_EDIT_SCRIPT_VERSION}：那個常數正是
 * **由這支算出來的**。算指紋時傳空字串。
 */
function buildScript(options: DeckEditPatchOptions, version: string): string {
  const pollMs = options.pollMs ?? DEFAULT_DECK_EDIT_POLL_MS;
  const holdMs = options.dragHoldMs ?? 1000;
  const config = {
    charaCards: CHARA_CARDS_KEY,
    weaponCards: WEAPON_CARDS_KEY,
    eventCards: EVENT_CARDS_KEY,
    /** 查不到價格的卡算 99，**而且照常參與壓 C** —— 照客戶端自己的常數。 */
    unknownCost: 99,
    /** 原版壓 C：差 7~13 罰 5、14 以上罰 10。沒有第三級。 */
    officialBands: [
      { minGap: 7, maxGap: 13, extraCost: 5 },
      { minGap: 14, extraCost: 10 },
    ],
    /** 「官方 ／ 自訂」那兩個字，**跟標題列那顆開關共用同一組**。 */
    sideLabel: SIDE_LABEL,
    roomTitle: ROOM_TITLE,
    tagTitle: TAG_TITLE,
    bossTitle: BOSS_TITLE,
  };
  return `(function () {
  var BINDING = ${JSON.stringify(options.bindingName)};
  var VERSION = ${JSON.stringify(version)};
  var HOLD_MS = ${holdMs};
  var CFG = JSON.parse(${embedJson(config)});
  var HAS = Object.prototype.hasOwnProperty;
  var ROOMS = JSON.parse(${embedJson([...ROOM_SCENES])});

  /**
   * 選單的版面。ROW_H 一列的高度 ＝ 卡面高度 ＋ 4。PANEL_PAD 是 panel_gene 九宮格
   * 上下邊框吃掉的量。TEXT_W 是卡右邊那三行字的寬度。
   */
  var ROW_H = 46;
  var PANEL_PAD = 76;
  var TEXT_W = 150;

  /**
   * 「房間」那一格：照抄旁邊「排序」的擺法（標題 sort_label 在 504,450、字 14
   * 斜體、置中；下拉 104x20 接在標題正下方）。我們這一組整個往下挪 48。
   */
  var ROOM_LABEL_XY = [504, 498];

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table, lang) {
    return table[lang] || table.en;
  }

  var api = window.${FLAG};
  if (api && api.version === VERSION) {
    api.setState(JSON.parse(${embedJson(options.state)}));
    return "already-installed";
  }
  if (api && typeof api.uninstall === "function") { try { api.uninstall(); } catch (e) {} }

  // 舊版的 uninstall 不一定收得乾淨，裝新版之前先自己掃一次場景。
  try {
    var g0 = window.game;
    if (g0) {
      ["Edit"].concat(ROOMS).forEach(function (n) {
        if (g0.scene.keys[n]) purge(g0.scene.keys[n]);
      });
    }
  } catch (e) {}

  var state = JSON.parse(${embedJson(options.state)});
  var mounted = null;
  var timer = null;

  function mode() { return state.mode === "official" ? "official" : "plugin"; }

  function report(payload) {
    try {
      var fn = window[BINDING];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  function fail(where, e) {
    report({ type: "deck-ui-error", message: where + "：" + String((e && e.message) || e) });
  }

  // ---- 畫面元件（全部用遊戲自己的貼圖與字型）----------------------------

  /** 小按鈕：用遊戲的 btn_gene，hover 換 frame —— 跟 Edit 畫面其他按鈕一致。 */
  function button(sc, x, y, text, onClick) {
    var img = sc.add.image(x, y, "btn_gene", 0).setDepth(1502).setInteractive();
    var txt = sc.add.text(x, y, text, { fontFamily: "font_heavy", fontSize: 12, color: "black" })
      .setResolution(2).setOrigin(0.5).setDepth(1503);
    img.on("pointerover", function () { img.setTexture("btn_gene", 1); txt.setColor("#ffffff"); });
    img.on("pointerout", function () { img.setTexture("btn_gene", 0); txt.setColor("#000000"); });
    img.on("pointerdown", function () {
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      onClick();
    });
    return { img: img, txt: txt, destroy: function () { img.destroy(); txt.destroy(); } };
  }

  /**
   * 「reset」那顆的樣子，但中間**沒有字**（字是烤在圖裡的）。拿 deck_reset 的
   * 左右框拼一張 24 寬的純邊框按鈕。尺寸不是當初量過的 64x48 就不拼，退回
   * btn_gene —— 裁錯位置會拼出一個半截字。
   */
  function plainButtonTexture(sc) {
    var KEY = "ulr_btn_plain";
    try {
      var tm = sc.textures;
      if (!tm || typeof tm.createCanvas !== "function" || typeof tm.exists !== "function") return null;
      if (tm.exists(KEY)) return KEY;
      if (!tm.exists("deck_reset")) return null;
      var src = tm.get("deck_reset").getSourceImage();
      if (!src || src.width !== 64 || src.height !== 48) return null;
      var cv = tm.createCanvas(KEY, 24, 48);
      if (!cv) return null;
      var ctx = cv.getContext();
      ctx.clearRect(0, 0, 24, 48);
      ctx.drawImage(src, 6, 0, 12, 48, 0, 0, 12, 48);
      ctx.drawImage(src, 46, 0, 12, 48, 12, 0, 12, 48);
      cv.refresh();
      cv.add(0, 0, 0, 0, 24, 24);
      cv.add(1, 0, 0, 24, 24, 24);
      return KEY;
    } catch (e) { return null; }
  }

  /**
   * ＋－那兩顆。深度刻意壓在 4／5：選單打開時的擋點擊罩是 1500，放太高的話
   * 選單開著時還按得到「－」把一副牌刪掉。
   */
  function plainButton(sc, x, y, text, onClick) {
    var key = plainButtonTexture(sc);
    var img = sc.add.image(x, y, key === null ? "btn_gene" : key, 0).setDepth(4);
    if (key === null) img.setScale(24 / 80, 17 / 25);
    img.setInteractive();
    var txt = sc.add.text(x, y, text, { fontFamily: "font_heavy", fontSize: 13, color: "#000000" })
      .setResolution(2).setOrigin(0.5).setDepth(5);
    var tex = key === null ? "btn_gene" : key;
    img.on("pointerover", function () { img.setTexture(tex, 1); txt.setColor("#eeeeee"); });
    img.on("pointerout", function () { img.setTexture(tex, 0); txt.setColor("#000000"); });
    img.on("pointerdown", function () {
      img.setTexture(tex, 0);
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      onClick();
    });
    return { img: img, txt: txt, destroy: function () { img.destroy(); txt.destroy(); } };
  }

  /**
   * 下拉選單，**整套照抄遊戲的排序下拉**（Edit.create_sort_drop，2026-09-24 讀的）：
   * rexUI dropDownList、btn_gene 九宮格底 104x20、列表每一列白底 label（font_light
   * 10 黑字），hover 16757426、按下 16744318。值是蓋在上面的 BBCodeText
   * （font_medium 12），跟 sort_btn_text 一樣。
   *
   * ⚠ 沒有 rexUI 的 dropDownList 就回 null（測試的假場景）。
   */
  function dropdown(sc, opts) {
    var rexUI = sc.rexUI;
    if (!rexUI || !rexUI.add || typeof rexUI.add.dropDownList !== "function") return null;
    var objs = [];
    var options = opts.options.map(function (o) { return { text: o.label, value: o.key }; });
    var drop = rexUI.add.dropDownList({
      x: opts.x, y: opts.y, width: 104, height: 20,
      background: sc.add.nineslice(0, 0, "btn_gene", 0, 104, 20, 4, 4, 4, 4),
      text: sc.add.text(0, 0, ""),
      options: options,
      list: {
        createButtonCallback: function (_scene, option) {
          return rexUI.add.label({
            width: 88, height: 20,
            background: rexUI.add.roundRectangle(0, 0, 85, 20, 0, 16777215, 1),
            text: rexUI.add.BBCodeText(0, 0, String(option.text), {
              fontFamily: "font_light", fontSize: 10, resolution: 2, color: "black"
            }).setOrigin(0, 0.5),
            value: option.value
          });
        },
        onButtonOver: function (b) { try { b.getElement("background").setFillStyle(16757426, 1); } catch (e) {} },
        onButtonOut: function (b) { try { b.getElement("background").setFillStyle(16777215, 1); } catch (e) {} },
        onButtonClick: function (b) {
          try { b.getElement("background").setFillStyle(16744318, 1); } catch (e) {}
          try { drop.closeListPanel(); } catch (e) {}
          opts.onPick(b.value);
        },
        maxHeight: 100,
        easeIn: 100,
        easeOut: 100
      },
      space: { left: 1 },
      value: undefined
    }).setOrigin(0.5, 0);
    drop.layout();
    var value = rexUI.add.BBCodeText(drop.getCenter().x, drop.getCenter().y, opts.value, {
      fontFamily: "font_medium", fontSize: 12, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5);
    drop.setInteractive();
    try {
      var bg = drop.getElement("background");
      drop.on("pointerover", function () { bg.setTexture("btn_gene", 1); });
      drop.on("pointerout", function () { bg.setTexture("btn_gene", 0); });
      drop.on("pointerdown", function () { bg.setTexture("btn_gene", 0); });
      drop.on("pointerup", function () { bg.setTexture("btn_gene", 1); });
    } catch (e) {}
    objs.push(drop, value);
    return {
      objects: objs,
      close: function () { try { drop.closeListPanel(); } catch (e) {} },
      setValue: function (text) { try { value.setText(text); } catch (e) {} }
    };
  }

  // ---- 卡片資料（只為了畫，不參與任何判定）------------------------------

  function cacheRows(key) {
    try {
      var cache = window.game && window.game.cache && window.game.cache.json;
      if (!cache || !cache.has(key)) return null;
      var rows = cache.get(key);
      return Array.isArray(rows) ? rows : null;
    } catch (e) { return null; }
  }

  function rowById(key, id) {
    if (typeof id !== "number") return null;
    var rows = cacheRows(key);
    if (rows === null) return null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].id === id) return rows[i];
    }
    return null;
  }

  /**
   * 一張卡在「官方」或「自訂」下的價格。快取裡此刻躺著的只是其中一種，另一種從
   * patch-cost 留在頁面的 originals／customs 查。規則沒動到的卡兩邊相同。
   */
  function priceOf(tables, key, cost, custom) {
    var st = window.${COST_PATCH_FLAG};
    if (!st) return cost;
    var official = cost;
    for (var i = 0; i < tables.length; i++) {
      var orig = st.originals && st.originals[tables[i]];
      if (orig && HAS.call(orig, key)) { official = orig[key]; break; }
    }
    if (!custom) return official;
    for (var j = 0; j < tables.length; j++) {
      var cust = st.customs && st.customs[tables[j]];
      if (cust && HAS.call(cust, key)) return cust[key];
    }
    return official;
  }

  function extraFor(bands, gap) {
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      if (gap < band.minGap) continue;
      if (band.maxGap !== undefined && band.maxGap !== null && gap > band.maxGap) continue;
      return band.extraCost;
    }
    return 0;
  }

  /** 內容的兩種形狀都收：選單的 {charaId…} 與遊戲的 {chara_card_id…}。 */
  function idsOf(content, a, b) {
    var v = content ? (content[a] || content[b]) : null;
    return Array.isArray(v) ? v : [];
  }

  /**
   * 這副牌的總 COST（官方或自訂）。算法照 Edit 的 get_*_cost（見檔頭）。
   * custom 為 true 時價格查自訂表、壓 C 用 state.penaltyBands。
   */
  function totalCost(content, custom) {
    if (!content) return null;
    var bands = custom && state.penaltyBands ? state.penaltyBands : CFG.officialBands;
    var slots = [];
    var total = 0;
    idsOf(content, "charaId", "chara_card_id").forEach(function (id) {
      if (typeof id !== "number") return;
      var row = rowById(CFG.charaCards, id);
      var cost = row === null || typeof row.cost !== "number"
        ? CFG.unknownCost
        : priceOf(["characters", "monsters"], String(row.filename || ""), row.cost, custom);
      slots.push(cost);
      total += cost;
    });
    idsOf(content, "weaponId", "weapon_card_id").forEach(function (id) {
      if (typeof id !== "number") return;
      var row = rowById(CFG.weaponCards, id);
      total += row === null || typeof row.cost !== "number"
        ? CFG.unknownCost
        : priceOf(["equipment"], String(id), row.cost, custom);
    });
    idsOf(content, "eventId", "event_card_id").forEach(function (id) {
      if (typeof id !== "number") return;
      var row = rowById(CFG.eventCards, id);
      total += row === null || typeof row.cost !== "number"
        ? CFG.unknownCost
        : priceOf(["eventCards"], String(id), row.cost, custom);
    });
    // 壓 C：隊內每一對各判一次。
    for (var a = 0; a < slots.length; a++) {
      for (var b = a + 1; b < slots.length; b++) total += extraFor(bands, Math.abs(slots[a] - slots[b]));
    }
    // 自訂價可以是小數，浮點相加會拖一串尾巴。
    return Math.round(total * 100) / 100;
  }

  /** 有沒有自訂表可以拿來算第二種價。沒有就只畫官方。 */
  function hasCustomCosts() {
    try {
      var st = window.${COST_PATCH_FLAG};
      if (!st || !st.customs) return false;
      for (var k in st.customs) {
        if (HAS.call(st.customs, k)) {
          for (var _ in st.customs[k]) return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * 一張卡面縮圖：遊戲自己的 CharaCardImages 圖集（每格 168x240，格名就是
   * CharaCards 的 filename）。查不到就畫 cc000 那一格（空槽）。
   */
  function cardThumb(sc, x, y, height, charaId) {
    var tm = sc.textures;
    if (!tm || typeof tm.exists !== "function" || !tm.exists("CharaCardImages")) return null;
    var atlas = tm.get("CharaCardImages");
    var frame = "cc000";
    var row = rowById(CFG.charaCards, charaId);
    if (row !== null && row.filename && atlas.has(String(row.filename))) frame = String(row.filename);
    if (!atlas.has(frame)) return null;
    var img = sc.add.image(x, y, "CharaCardImages", frame).setOrigin(0, 0.5).setDepth(1502);
    img.setDisplaySize(Math.round(height * 168 / 240), height);
    return img;
  }

  /** 幫我們建立的物件打標記，purge() 靠它收掉任何版本留下的孤兒。 */
  function own(list) {
    list.forEach(function (o) { try { o.__ulrDeckOwned = true; } catch (e) {} });
    return list;
  }

  function purge(sc) {
    if (!sc || !sc.children) return 0;
    var doomed = sc.children.list.filter(function (o) { return o.__ulrDeckOwned; });
    doomed.forEach(function (o) { try { o.destroy(); } catch (e) {} });
    return doomed.length;
  }

  // ---- 牌組選單 ------------------------------------------------------------

  function closeMenu() {
    if (mounted && mounted.panel) {
      mounted.panel.forEach(function (o) { try { o.destroy(); } catch (e) {} });
      mounted.panel = null;
    }
  }

  function bossLabel(key) {
    for (var i = 0; i < state.bossOptions.length; i++) {
      if (state.bossOptions[i].key === key) return state.bossOptions[i].label;
    }
    return key;
  }

  function fmtCost(value) {
    return String(Math.round(value * 100) / 100);
  }

  function openMenu(sc) {
    if (!mounted) return;
    closeMenu();
    var objs = [];
    var rows = state.decks.length;
    var lang = gameLang();
    var isRaid = state.room === "raid";
    var showCustom = hasCustomCosts();

    var rowH = ROW_H;
    // 牌組一多就會頂出畫面上緣：**把每一列縮小**，不要另開一頁或默默少畫幾副。
    var fits = 630 - 8 - PANEL_PAD;
    if (rows > 0 && rowH * rows > fits) rowH = Math.max(22, Math.floor(fits / rows));
    var cardH = rowH - 4;
    var cardW = Math.round(cardH * 168 / 240);
    var textX = 14 + cardW * 3 + 8;
    var w = textX + TEXT_W + 10;
    var h = Math.max(rowH * rows + PANEL_PAD, 116);
    var x = 8, y = 630 - h;

    var blocker = sc.add.zone(0, 0, sc.scale.width, sc.scale.height)
      .setOrigin(0).setDepth(1500).setInteractive();
    blocker.on("pointerdown", function () { closeMenu(); });
    objs.push(blocker);

    objs.push(sc.add.nineslice(x, y, "panel_gene", 0, w, h, 71, 40, 63, 32).setOrigin(0).setDepth(1501));

    state.decks.forEach(function (deck, index) {
      var ry = y + 40 + index * rowH;
      var cy = ry + Math.floor(cardH / 2);
      var isActive = deck.id === state.activeId;
      var mine = [];

      var hit = sc.add.zone(x + 10, ry, w - 20, rowH - 2).setOrigin(0).setDepth(1502).setInteractive();
      mine.push(hit);

      var content = deck.content || null;
      for (var s = 0; s < 3; s++) {
        var thumb = cardThumb(sc, x + 14 + s * cardW, cy, cardH,
          content && content.charaId ? content.charaId[s] : null);
        if (thumb !== null) mine.push(thumb);
      }

      var lines = [];
      // 官方三牌組模式：前三副就是 Deck1..3，名字前面標格號。
      var prefix = mode() === "official" && index < 3 ? (index + 1) + " " : "";
      lines.push({
        text: prefix + deck.name,
        size: 12,
        font: isActive ? "font_heavy" : "font_light",
        color: isActive ? "#ffe08a" : (mode() === "official" && index >= 3 ? "#9aa3ab" : "#ffffff")
      });
      if (isRaid) {
        lines.push({
          text: pick(CFG.tagTitle, lang) + " " + (deck.bosses.length ? deck.bosses.map(bossLabel).join("") : "—"),
          size: 10, font: "font_light", color: "#9fd0ff", tag: true
        });
      }
      var costMode = state.costDisplay || "official";
      if (costMode !== "none") {
        var side = pick(CFG.sideLabel, lang);
        var useCustom = costMode === "custom" && showCustom;
        var total = totalCost(content, useCustom);
        if (total !== null) {
          lines.push({
            text: (useCustom ? side.on : side.off) + " " + fmtCost(total),
            size: 10, font: "font_light", color: "#b9c6cf"
          });
        }
      }

      var step = lines.length > 2 ? 14 : 16;
      var top = cy - ((lines.length - 1) * step) / 2;
      lines.forEach(function (line, li) {
        var t = sc.add.text(x + textX, top + li * step, line.text, {
          fontFamily: line.font, fontSize: line.size, color: line.color
        }).setResolution(2).setOrigin(0, 0.5).setDepth(1503);
        if (line.tag) {
          t.setInteractive();
          t.on("pointerdown", function () { promptBosses(sc, deck); });
        }
        mine.push(t);
      });

      // 長按進入拖曳排序；短按就是選這一副。拖的時候整列一起動。
      var holdTimer = null, dragging = false, startY = 0;
      var baseY = mine.map(function (o) { return o.y; });
      function moveRow(dy) {
        mine.forEach(function (o, i) { try { o.setY(baseY[i] + dy); } catch (e) {} });
      }
      hit.on("pointerdown", function (p) {
        startY = p.y; dragging = false;
        holdTimer = setTimeout(function () { dragging = true; }, HOLD_MS);
      });
      hit.on("pointermove", function (p) { if (dragging) moveRow(p.y - startY); });
      hit.on("pointerup", function (p) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (dragging) {
          var moved = Math.round((p.y - startY) / rowH);
          var to = Math.max(0, Math.min(state.decks.length - 1, index + moved));
          if (to !== index) report({ type: "deck-move", id: deck.id, toIndex: to });
          else moveRow(0);
        } else {
          report({ type: "deck-select", id: deck.id });
          closeMenu();
        }
      });
      hit.on("pointerout", function () {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      });

      mine.forEach(function (o) { objs.push(o); });
    });

    if (rows === 0) {
      objs.push(sc.add.text(x + 14, y + 44, "還沒有牌組，按 + 新增", {
        fontFamily: "font_light", fontSize: 12, color: "#cccccc"
      }).setResolution(2).setDepth(1503));
    }

    mounted.panel = own(objs);
  }

  // ---- 牌組名：左下那行字 ------------------------------------------------

  function slotOf(n) {
    var s = state.slots && state.slots[String(n)];
    return s && typeof s.name === "string" ? s : null;
  }

  /** Edit 那行字是 show_deck_label() 每次現建的，最後一個才是畫面上那個。 */
  function editLabel(sc) {
    var list = sc.deck_label;
    if (!list || !list.length) return null;
    var last = list[list.length - 1];
    return last && last.name && typeof last.name.setText === "function" ? last.name : null;
  }

  /** 把左下那行字換成牌組庫的名字。 */
  function applyLabel(sc, isRoom) {
    var slot = slotOf(sc.deck_now);
    if (slot === null) return;
    if (isRoom) {
      if (sc.deck_name && typeof sc.deck_name.setText === "function") sc.deck_name.setText(slot.name);
      return;
    }
    var t = editLabel(sc);
    if (t === null) return;
    t.setText(slot.name);
    // 就地改名：點那行字。每次重建都是新物件，所以每次都要掛。
    if (!t.__ulrRename) {
      t.__ulrRename = true;
      try {
        t.setInteractive();
        t.on("pointerdown", function () { startInlineRename(sc); });
      } catch (e) {}
    }
  }

  /**
   * 包住場景的重畫函式（實例上的自有屬性，遮蔽 prototype 那顆）：原版畫完之後把
   * 名字換掉。Edit 包 show_deck_label，房裡包 show_deck。
   */
  function wrapRedraw(sc, method, isRoom) {
    var orig = sc[method];
    if (typeof orig !== "function") return null;
    if (orig.__ulrDeckWrap) return null;
    var patched = function () {
      var out = orig.apply(this, arguments);
      try { applyLabel(this, isRoom); } catch (e) {}
      return out;
    };
    patched.__ulrDeckWrap = true;
    // 原本是不是實例上的自有屬性：是的話拆的時候要放回去，不是的話刪掉我們這顆
    // 就會露出 prototype 那顆。一律 delete 的話前者會連原版一起不見。
    var own = HAS.call(sc, method);
    sc[method] = patched;
    return { obj: sc, method: method, patched: patched, orig: orig, own: own };
  }

  /**
   * **就地改牌組名稱**：點左下那行字直接編輯（2026-09-12 玩家要的：「前世就是
   * 這樣改名的」）。改的是**眼前那一格**對應的那一副；對不上任何一副時什麼都不做。
   */
  function startInlineRename(sc) {
    if (!mounted || mounted.rename || mounted.room) return;
    var slot = slotOf(sc.deck_now);
    if (slot === null || slot.id === null) return;
    var name = editLabel(sc);
    if (name === null) return;
    try {
      var Input = window.RexPlugins && window.RexPlugins.UI && window.RexPlugins.UI.InputText;
      if (!Input) { fail("改名", new Error("這個客戶端沒有 rexUI 的 InputText")); return; }
      var box = new Input(sc, name.x, name.y, 200, 26, {
        type: "text",
        text: slot.name,
        fontFamily: "font_heavy",
        fontSize: "20px",
        fontStyle: "italic",
        color: "#ffffff",
        backgroundColor: "transparent",
        border: 0,
        align: "left",
        maxLength: 24
      });
      sc.add.existing(box);
      box.setOrigin(0, 0).setDepth(1600);
      name.setVisible(false);
      mounted.rename = box;
      var done = false;
      var targetId = slot.id, oldName = slot.name;
      function finish(commit) {
        if (done) return;
        done = true;
        var value = String(box.text || "").trim();
        try { box.destroy(); } catch (e) {}
        if (mounted) mounted.rename = null;
        try { name.setVisible(true); } catch (e) {}
        if (commit && value.length > 0 && value !== oldName) {
          report({ type: "deck-rename", id: targetId, name: value });
        }
      }
      box.on("keydown", function (_box, e) {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      box.on("blur", function () { finish(true); });
      box.setFocus();
    } catch (e) { fail("改名", e); }
  }

  /** 渦 BOSS 標籤：勾這副打得動哪幾種（多選）。 */
  function promptBosses(sc, deck) {
    try {
      var picked = {};
      deck.bosses.forEach(function (b) { picked[b] = true; });
      var objs = [];
      // panel_gene 的上邊框 63px、下邊框 32px 不縮放，內容要放在深色區裡。
      var PH = 200, top = 340 - PH / 2, body = top + 63;
      objs.push(sc.add.nineslice(380, 340, "panel_gene", 0, 320, PH, 71, 40, 63, 32).setDepth(1801));
      objs.push(sc.add.text(380, body + 14, pick(CFG.bossTitle, gameLang()), {
        fontFamily: "font_heavy", fontSize: 13, color: "#ffffff"
      }).setResolution(2).setOrigin(0.5).setDepth(1802));

      var opts = state.bossOptions;
      var rowY = body + 46;
      var startX = 380 - (opts.length * 46) / 2 + 23;
      opts.forEach(function (opt, i) {
        var cx = startX + i * 46;
        var box = sc.add.image(cx, rowY, "btn_gene", picked[opt.key] ? 1 : 0)
          .setScale(0.5, 1.1).setDepth(1802).setInteractive();
        var txt = sc.add.text(cx, rowY, opt.label, {
          fontFamily: "font_heavy", fontSize: 15, color: picked[opt.key] ? "#ffffff" : "#000000"
        }).setResolution(2).setOrigin(0.5).setDepth(1803);
        box.on("pointerdown", function () {
          picked[opt.key] = !picked[opt.key];
          box.setTexture("btn_gene", picked[opt.key] ? 1 : 0);
          txt.setColor(picked[opt.key] ? "#ffffff" : "#000000");
          try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        });
        objs.push(box, txt);
      });

      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        objs.forEach(function (o) { try { o.destroy(); } catch (e) {} });
        ok.destroy(); cancel.destroy();
        if (!commit) return;
        var out = [];
        opts.forEach(function (o) { if (picked[o.key]) out.push(o.key); });
        report({ type: "deck-bosses", id: deck.id, bosses: out });
      }
      var btnY = body + 86;
      var ok = button(sc, 340, btnY, "ok", function () { finish(true); });
      var cancel = button(sc, 420, btnY, "cancel", function () { finish(false); });
      ok.img.setDepth(1802); ok.txt.setDepth(1803);
      cancel.img.setDepth(1802); cancel.txt.setDepth(1803);
    } catch (e) { fail("標籤", e); }
  }

  // ---- 掛載 ---------------------------------------------------------------

  function currentRoomLabel() {
    for (var i = 0; i < state.rooms.length; i++) {
      if (state.rooms[i].key === state.room) return state.rooms[i].label;
    }
    return state.room;
  }

  /** 原版 ◀▶ 的行為（2026-09-24 讀的 create()），卸載或換成官方模式時裝回去。 */
  function officialArrow(sc, obj, delta, isRoom) {
    return function () {
      try {
        obj.setTexture("btn_arrow_deck", 0);
        var max = typeof sc.deck_max === "number" && sc.deck_max > 0 ? sc.deck_max : 3;
        if (delta < 0) sc.deck_now = sc.deck_now === 1 ? max : sc.deck_now - 1;
        else sc.deck_now = sc.deck_now === max ? 1 : sc.deck_now + 1;
        if (isRoom) sc.show_deck();
        else { sc.refresh(); sc.show_deck_label(); sc.show_cost(); }
      } catch (e) {}
    };
  }

  function arrowPairs(sc) {
    return [["deck_prev", -1], ["deck_next", 1]].filter(function (p) {
      var o = sc[p[0]];
      return o && typeof o.off === "function" && typeof o.on === "function";
    });
  }

  function unmount() {
    closeMenu();
    if (!mounted) return;
    if (mounted.rename) {
      try { mounted.rename.destroy(); } catch (e) {}
      mounted.rename = null;
    }
    var sc = mounted.scene;
    if (mounted.icon && mounted.iconHandler) {
      try { mounted.icon.off("pointerdown", mounted.iconHandler); } catch (e) {}
    }
    (mounted.foreign || []).forEach(function (f) {
      try { f.obj.off(f.event, f.handler); } catch (e) {}
    });
    // 包住的重畫函式還回去（只還原還是我們裝的那一顆）。
    (mounted.wraps || []).forEach(function (w) {
      try {
        if (w.obj[w.method] !== w.patched) return;
        if (w.own) w.obj[w.method] = w.orig; else delete w.obj[w.method];
      } catch (e) {}
    });
    // ◀▶ 原本就有行為，要還回去，不能留成死鈕。
    if (mounted.arrows && sc) {
      mounted.arrows.forEach(function (a) {
        try {
          a.obj.off("pointerup", a.handler);
          a.obj.on("pointerup", officialArrow(sc, a.obj, a.delta, mounted.room));
        } catch (e) {}
      });
    }
    mounted.objects.forEach(function (o) { try { o.destroy(); } catch (e) {} });
    try { purge(sc); } catch (e) {}
    mounted = null;
  }

  // isRoom = 掛在任務／渦／對戰房，不是牌組編輯畫面。
  function mount(sc, isRoom) {
    unmount();
    var objs = [];
    var plugin = mode() === "plugin";
    mounted = {
      scene: sc, objects: objs, panel: null, room: !!isRoom, mode: mode(),
      foreign: [], wraps: [], arrows: null, rename: null
    };

    // 1. 牌盒圖示變成可點。四個場景都有 deck_icon（原版連 input 都沒有，純裝飾），
    //    萬一找不到就在兩顆箭頭正中間補一顆。
    var icon = null;
    sc.children.list.forEach(function (o) {
      if (o.texture && o.texture.key === "deck_icon" && Math.round(o.y) === 644) icon = o;
    });
    if (icon === null) {
      try {
        var pre = sc.deck_prev, nxt = sc.deck_next;
        if (pre && nxt && sc.textures.exists("deck_icon")) {
          icon = sc.add.image(Math.round((pre.x + nxt.x) / 2), 644, "deck_icon");
          objs.push(icon);
        }
      } catch (e) { icon = null; }
    }
    if (icon) {
      if (!icon.input) icon.setInteractive();
      try { icon.off("pointerdown"); } catch (e) {}
      var iconHandler = function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        if (mounted && mounted.panel) closeMenu(); else openMenu(sc);
      };
      icon.on("pointerdown", iconHandler);
      mounted.icon = icon;
      mounted.iconHandler = iconHandler;
    }

    // 2. ＋－：只在 Edit、插件模式。管理動作不該在房裡誤按；官方模式一房就是三格。
    if (!isRoom && plugin) {
      var plus = plainButton(sc, 74, 644, "+", function () { report({ type: "deck-add" }); });
      var minus = plainButton(sc, 100, 644, "-", function () {
        if (state.activeId) report({ type: "deck-remove", id: state.activeId });
      });
      objs.push(plus.img, plus.txt, minus.img, minus.txt);
    }

    // 3. 房間下拉：只在 Edit（房裡那個位置是地圖正中央，而且切了會拿錯牌組上場）。
    if (!isRoom) {
      objs.push(sc.add.text(ROOM_LABEL_XY[0], ROOM_LABEL_XY[1], pick(CFG.roomTitle, gameLang()), {
        fontFamily: "font_heavy", fontSize: 14, resolution: 2, fontStyle: "Italic",
        padding: { right: 6 }
      }).setOrigin(0.5, 0).setDepth(0));
      var dd = dropdown(sc, {
        x: ROOM_LABEL_XY[0],
        y: ROOM_LABEL_XY[1] + 17,
        value: currentRoomLabel(),
        options: state.rooms,
        onPick: function (key) {
          try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
          if (key !== state.room) report({ type: "room-switch", room: key });
        }
      });
      if (dd !== null) {
        dd.objects.forEach(function (o) { objs.push(o); });
        mounted.roomDrop = dd;
      }
    }

    // 4. 牌組名：原版畫完之後換成牌組庫的名字。
    var w1 = wrapRedraw(sc, isRoom ? "show_deck" : "show_deck_label", isRoom);
    if (w1 !== null) mounted.wraps.push(w1);

    // 5. ◀▶：插件模式切的是**這一房的自訂牌組**，由 Node 決定下一副；官方模式不碰。
    if (plugin) {
      var arrows = [];
      arrowPairs(sc).forEach(function (pair) {
        var obj = sc[pair[0]];
        // 原版的行為掛在 pointerup；pointerover/out/down 是 hover 換圖，不能拆。
        try { obj.off("pointerup"); } catch (e) {}
        var handler = function () {
          try { obj.setTexture("btn_arrow_deck", 0); } catch (e) {}
          try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
          report({ type: "deck-cycle", delta: pair[1], from: isRoom ? "room" : "menu" });
        };
        obj.on("pointerup", handler);
        arrows.push({ obj: obj, handler: handler, delta: pair[1] });
      });
      mounted.arrows = arrows;
      // 釘在 1：玩家可能在我們掛上之前就用原版箭頭切到 2 或 3 了。
      if (sc.deck_now !== 1) {
        try {
          sc.deck_now = 1;
          if (isRoom) sc.show_deck();
          else { sc.refresh(); sc.show_deck_label(); sc.show_cost(); }
        } catch (e) {}
      }
    }

    // 「這個場景還是不是掛上去時那一代」的錨：牌盒（跟著場景重建一起死）。
    mounted.anchor = icon || sc.deck_prev || objs[0] || null;

    own(objs);
    redraw();
  }

  function redraw() {
    if (!mounted) return;
    try {
      if (mounted.roomDrop) mounted.roomDrop.setValue(currentRoomLabel());
      try { applyLabel(mounted.scene, mounted.room); } catch (e) {}
      if (mounted.panel) openMenu(mounted.scene);
    } catch (e) { fail("重畫", e); }
  }

  // 這個場景有沒有畫著那一排牌組列（認物件，不認場景名：載入中 children 是空的）。
  function hasDeckRow(sc) {
    if (!sc || !sc.children) return false;
    var list = sc.children.list;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o.texture || Math.round(o.y) !== 644) continue;
      if (o.texture.key === "deck_icon" || o.texture.key === "btn_arrow_deck") return true;
    }
    return false;
  }

  // 現在該把選單掛在哪個場景上。Edit 優先。
  function deckScene() {
    var g = window.game;
    if (!g) return null;
    var ed = g.scene.keys.Edit;
    if (ed && ed.scene.isActive() && hasDeckRow(ed)) return { sc: ed, room: false };
    for (var i = 0; i < ROOMS.length; i++) {
      var sc = g.scene.keys[ROOMS[i]];
      if (sc && sc.scene.isActive() && hasDeckRow(sc)) return { sc: sc, room: true };
    }
    return null;
  }

  /**
   * 渦房裡「現在選中哪個渦」—— 換了就回報 raid-pick，托盤照 BOSS 標籤換牌組。
   * 認的是場景上有沒有 raid_info／raid_data（改版後欄位還沒對過，沒有就不報）。
   */
  var lastRaidPick = null;
  function watchRaidPick(sc) {
    if (mode() !== "plugin") return;
    if (!sc || !sc.raid_info || !sc.raid_data || typeof sc.raid_data.length !== "number") return;
    var row = null;
    if (sc.raid_info.visible && typeof sc.raid_idx === "number") row = sc.raid_data[sc.raid_idx] || null;
    var mons = row && typeof row.profound_mons === "string" ? row.profound_mons : null;
    var key = mons === null ? null : String(row.profound_id) + "|" + mons;
    if (key === lastRaidPick) return;
    lastRaidPick = key;
    if (mons !== null) report({ type: "raid-pick", mons: mons });
  }

  function tick() {
    try {
      var hit = deckScene();
      if (hit === null) { if (mounted) unmount(); return; }
      if (hit.room) watchRaidPick(hit.sc);
      // 場景實例是長命的：同一個 scene 物件重跑 create() 之後底下全是新的，
      // 所以要看錨死了沒，不能只比場景。模式換了也要重掛（箭頭歸屬不同）。
      if (
        !mounted ||
        mounted.scene !== hit.sc ||
        mounted.mode !== mode() ||
        (mounted.anchor && !mounted.anchor.scene)
      ) {
        mount(hit.sc, hit.room);
      }
    } catch (e) { fail("輪詢", e); }
  }

  timer = setInterval(tick, ${pollMs});
  tick();

  window.${FLAG} = {
    version: VERSION,
    setState: function (next) {
      state = next;
      if (mounted && mounted.mode !== mode()) { tick(); return; }
      redraw();
    },
    isMounted: function () { return mounted !== null; },
    // 一副牌的總 COST（官方或自訂），從遊戲快取算 —— 見 totalCost。房間場景的
    // cost:NN 讀的是那一副的 cost，換牌之後由 deck-write 回來叫這支補上。
    costFor: function (content, custom) {
      try { return totalCost(content, custom === true); } catch (e) { return null; }
    },
    uninstall: function () {
      if (timer) { clearInterval(timer); timer = null; }
      unmount();
      window.${FLAG} = undefined;
    }
  };
  return "installed";
})()`;
}

/**
 * 把新狀態推給頁面。
 *
 * 回 `"ok"` 才算推成功。另外兩種都表示**呼叫端要重裝**：
 *
 * ```
 *   not-installed        頁面上沒有腳本（遊戲重載過）
 *   stale:<頁面的版本>   有，但不是這一版 —— 托盤換了新版而遊戲沒重載
 * ```
 */
export function buildDeckEditStateExpression(state: DeckEditState): string {
  return `(function () {
  var api = window.${FLAG};
  if (!api) return "not-installed";
  if (String(api.version) !== ${JSON.stringify(DECK_EDIT_SCRIPT_VERSION)}) {
    return "stale:" + String(api.version);
  }
  api.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

/** 拆掉。 */
export const DECK_EDIT_UNINSTALL_EXPRESSION = `(function () {
  var api = window.${FLAG};
  if (!api) return "not-installed";
  api.uninstall();
  return "uninstalled";
})()`;

/** 現在裝了沒、掛上去了沒。 */
export const DECK_EDIT_STATUS_EXPRESSION = `(function () {
  var api = window.${FLAG};
  if (!api) return JSON.stringify({ installed: false, mounted: false, version: null });
  return JSON.stringify({
    installed: true,
    mounted: api.isMounted(),
    version: api.version
  });
})()`;

export interface DeckEditStatus {
  installed: boolean;
  /** UI 是不是真的畫在畫面上（玩家在有牌組列的畫面才會是 true）。 */
  mounted: boolean;
  /**
   * 頁面上那份腳本的指紋。呼叫端拿它跟 {@link DECK_EDIT_SCRIPT_VERSION} 比 ——
   * **不一樣就要重裝**。舊版腳本回的是數字，也算不一樣。
   */
  version: string | null;
}

export function parseDeckEditStatus(raw: string): DeckEditStatus {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      installed: data.installed === true,
      mounted: data.mounted === true,
      version: typeof data.version === "string" ? data.version : null,
    };
  } catch {
    return { installed: false, mounted: false, version: null };
  }
}
