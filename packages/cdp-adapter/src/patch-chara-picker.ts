/**
 * 牌組編輯畫面的「人物篩選」與「最愛卡片」
 * ======================================
 * 玩家 2026-09-26：原版「抽出」下拉一次只看得到五個角色，而角色有 68 個。
 *
 * ```
 *   ┌ 卡片格線（原本 6×3，一張 84×120）──────────────┐
 *   │  按 [Chara] 之後：同一塊換成 12×6、一張縮一半    │ ← 每個持有的角色一張代表卡，
 *   │  （42×60），全部角色一頁放完                       │   點一張 = 勾選／取消那個角色
 *   └──────────────────────────────────────────────────┘
 *   [1] Page [Favorite]        ◀ 1 / 25 ▶  [Chara] 抽出 [--ALL-- ▾]
 *                                                        [複製卡片]      [最愛卡片]
 * ```
 *
 * 三樣東西：
 *
 * 1. **[Chara] 鈕**：在「抽出」左邊。按下去卡片格線換成**手上有的**角色的代表卡，
 *    再按一次收起來。點代表卡跟「抽出」打勾一樣：勾選／取消那個角色，可以勾好幾個
 *    （玩家 2026-09-26：「要能勾選複數個角色，沒持有的角色不要顯示」）。代表卡照
 *    托盤「牌組 › 人物篩選」的設定挑（L1～L5／最高等 R 卡），要是手上有的那張，
 *    沒有就挑等級最接近的（見 {@link PICK_CARD_SNIPPET}）。
 * 2. **「最愛卡片」鈕**：右邊預覽區右下，跟左下的「複製卡片」／「閱讀故事」左右對稱。
 *    貼圖就是「複製卡片」那張，字抹掉重寫（見 favTexture）。點一下把**預覽中的
 *    那一張卡**加入／移出最愛 —— 玩家 2026-09-26：「最愛角色指的是最愛卡片」，
 *    把 R1 史特靈加進去就只該看到 R1 史特靈。
 * 3. **[Favorite] 鈕**：「1 Page」右邊。按下去格線只剩最愛卡片，再按一次回到全部
 *    （玩家 2026-09-26：「直接顯示所有最愛卡片，不要跳出下拉選單」）。
 *
 * ## ⚠ 不動原版的「抽出」
 *
 * 玩家 2026-09-26：「不影響原有程式前端的過濾篩選顯示」。[Chara] 只改
 * `sc.chara_filter`（原版「抽出」用的同一個陣列）再叫 `sc.refresh()` —— 原版下拉
 * 每次打開都照 `chara_filter` 重畫勾選，所以兩邊永遠一致，不必去碰它。
 *
 * [Favorite] 沒有現成的陣列可以借：原版 `refresh()` 每次都先叫 `card_filter()`
 * 從 registry 產出格線要畫的 `chara_card`，我們在它之後再濾一次卡片 id
 * （2026-09-26 讀的原始碼）。只濾 chara 分頁。
 *
 * ## 卡面用遊戲自己的
 *
 * 代表卡是遊戲畫格線用的同一支 `create_card`（webpack 模組裡 `$T.create_card`，
 * 2026-09-26 讀的），縮到 0.25。找不到那支就退回 `CharaCardImages` 那一格圖。
 * 70 張第一次建約 1 秒（要做遮罩貼圖），之後約 0.25 秒。
 *
 * ## 最愛存在哪
 *
 * 頁面只回報 `{ type: "card-favorite", card, on }`，真相在托盤的牌組庫
 * （`DeckLibrary.favorites`，跟牌組一起上雲）。鈕照例先動（樂觀更新），Node
 * 存完再推回來。
 *
 * ## Equipment 分頁：[Chara Weapon] 與「隱藏裝備」
 *
 * 玩家 2026-09-26：
 *
 * ```
 *   [1] Page                   ◀ 1 / 6 ▶          [Chara Weapon]   ← 「抽出」那個位置
 *                                                        [複製卡片]      [隱藏裝備]
 * ```
 *
 * - **格線順序**：通用武（`WeaponCards.chara === null`）一律排最前面，然後專武、
 *   素材（`chara === "cc000"`：異化礦材、魔之系列）最後。原版照 registry 順序
 *   （card_id）畫，冰劍、水擊槍、擀麵棍、除魔面具、可可果這些 id 較大的通用武會
 *   夾在專武後面。
 * - **[Chara Weapon] 開著**：只剩通用武＋目前牌組角色的專武（照牌組槽位順序），
 *   素材與玩家手動隱藏的不顯示。
 * - **「隱藏裝備」鈕**：跟「最愛卡片」同一個位置同一套畫法（武器預覽時這裡原本是空的）。
 *   隱藏清單只在 [Chara Weapon] 開著時生效，存在托盤的牌組庫
 *   （`DeckLibrary.hiddenWeapons`，跟最愛一樣上雲 —— 玩家 2026-09-26 要的）。
 *
 * 原版 Equipment 分頁直接畫 `sc.weapon_card`（Edit 初始化時拿 registry 的那一個
 * 陣列），`weapon_page_max` 也只在初始化算一次（2026-09-26 讀的原始碼）。所以包住
 * `refresh`：weapon 分頁時把 `weapon_card` 換成排好濾好的那份、重算頁數，畫完**換回
 * 原本的陣列**（別處用它查持有數量，不能少東西）。
 *
 * 右邊的武器預覽沒有存卡片 id —— 只有名字（`profile_texts[0]`）與 `event_info` 底圖，
 * 所以拿名字回查 WeaponCards（2026-09-26 查過：有名字的武器沒有重名）。
 *
 * ## Event 分頁：[Favorite] 與「最愛卡片」
 *
 * 玩家 2026-09-26：「事件卡區域，右下和角色的最愛卡片一樣，增加最愛卡片；打開
 * Favorite 時只顯示最愛卡片，一樣要存到雲端內」。
 *
 * ```
 *   [1] Page                   ◀ 1 / 4 ▶              [Favorite]   ← 玩家圈的位置（「抽出」那裡）
 *                                                        [複製卡片]      [最愛卡片]
 * ```
 *
 * - **「最愛卡片」鈕**：同一顆右下角的鈕，預覽的是事件卡時就收／放那張事件卡。
 * - **[Favorite]**：跟角色那顆各記各的開關（切回 Chara 分頁不會被事件的最愛濾掉）。
 * - 存在 `DeckLibrary.favoriteEvents`，**不跟角色卡的最愛共用清單** —— 事件卡 id
 *   1..125 跟角色卡 id 重疊（2026-09-26 查的）。
 *
 * 原版 Event 分頁跟 Equipment 一樣直接畫 `sc.event_card`、`event_page_max` 只在
 * 初始化算，所以用同一招：包住的 refresh 裡暫換陣列、重算頁數、畫完換回。
 *
 * 事件卡預覽也不存 id，但每次預覽都重建 `card_preview`（`create_card(…, 2, 2)`），
 * 裡面那張圖是 `EventCardImages` 的 `event_<id>` —— 從 frame 名讀 id。名字不能用：
 * 「Hp恢復」有五張（2026-09-26 查的）。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";

const FLAG = "__ulrCharaPicker";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 跟 `patch-cost-toggle` 一樣是「先拆再裝」。
 */
export const CHARA_PICKER_SCRIPT_VERSION = 4;

/** 輪詢間隔。「最愛卡片」鈕要跟著預覽換，500ms 的延遲點得出來。 */
export const DEFAULT_CHARA_PICKER_POLL_MS = 200;

/** 代表卡挑哪一張。`off` = 不畫 [Chara] 鈕（最愛照常）。 */
export type CharaPickerMode = "L1" | "L2" | "L3" | "L4" | "L5" | "R" | "off";

export const CHARA_PICKER_MODES: readonly CharaPickerMode[] = [
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "R",
  "off",
] as const;

/** 玩家訂的預設：L5。 */
export const DEFAULT_CHARA_PICKER_MODE: CharaPickerMode = "L5";

export function isCharaPickerMode(value: unknown): value is CharaPickerMode {
  return typeof value === "string" && (CHARA_PICKER_MODES as readonly string[]).includes(value);
}

/** Node 推給頁面的狀態。 */
export interface CharaPickerState {
  mode: CharaPickerMode;
  /** 最愛的角色卡 id（`CharaCards[].id`），照加入順序。 */
  favorites: number[];
  /** 玩家手動隱藏的武器卡 id（`WeaponCards[].id`），[Chara Weapon] 開著時不顯示。 */
  hiddenWeapons: number[];
  /** 最愛的事件卡 id（`EventCards[].id`），照加入順序。跟 `favorites` 分開（id 會重疊）。 */
  favoriteEvents: number[];
  /**
   * 最愛與隱藏清單存得進去嗎（托盤讀到這個帳號的牌組庫了沒）。`false` 時兩顆最愛鈕
   * 與「隱藏裝備」都不畫 —— 點了存不進去的鈕比沒有鈕更糟。
   */
  favoritesReady: boolean;
}

export type CharaPickerReport =
  | { type: "card-favorite"; card: number; on: boolean }
  | { type: "weapon-hidden"; card: number; on: boolean }
  | { type: "event-favorite"; card: number; on: boolean }
  | { type: "chara-picker-error"; message: string };

export function isCharaPickerReport(value: unknown): value is CharaPickerReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; card?: unknown; on?: unknown; message?: unknown };
  if (v.type === "card-favorite" || v.type === "weapon-hidden" || v.type === "event-favorite") {
    return Number.isSafeInteger(v.card) && (v.card as number) > 0 && typeof v.on === "boolean";
  }
  if (v.type === "chara-picker-error") return typeof v.message === "string";
  return false;
}

export interface CharaPickerStatus {
  installed: boolean;
  version: number | null;
  /** 畫在 Edit 畫面上了沒。 */
  mounted: boolean;
  /** 卡片格線現在是不是角色一覽。 */
  open: boolean;
  reason: string | null;
}

export interface CharaPickerPatchOptions {
  bindingName: string;
  state: CharaPickerState;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 「最愛卡片」鈕上的字：[還不是最愛時, 已經是最愛時]。
 *
 * 跟「複製卡片」一樣照遊戲語言。⚠ 原圖上的字是烤進去的，換語言要整張重畫。
 */
const FAV_BUTTON: Record<string, [string, string]> = {
  ja: ["お気に入り", "解除"],
  en: ["Favorite", "Unfavorite"],
  kr: ["즐겨찾기", "해제"],
  scn: ["最爱卡片", "取消最爱"],
  tcn: ["最愛卡片", "取消最愛"],
};

/** 「隱藏裝備」鈕上的字：[還沒隱藏時, 已經隱藏時]。 */
const HIDE_BUTTON: Record<string, [string, string]> = {
  ja: ["非表示", "再表示"],
  en: ["Hide", "Unhide"],
  kr: ["숨기기", "숨김 해제"],
  scn: ["隐藏装备", "取消隐藏"],
  tcn: ["隱藏裝備", "取消隱藏"],
};

/** [Chara Weapon] 鈕 hover 的說明。 */
const WEAPON_TIP: Record<string, string> = {
  ja: "汎用武器と、デッキのキャラの専用武器だけ表示（素材・非表示は除く）",
  en: "Show only generic weapons and your deck characters' weapons (no materials or hidden)",
  kr: "범용 무기와 덱 캐릭터 전용 무기만 표시 (재료·숨김 제외)",
  scn: "只显示通用武与牌组角色的专武（素材与隐藏的不显示）",
  tcn: "只顯示通用武與牌組角色的專武（素材與隱藏的不顯示）",
};

/** [Chara] 鈕 hover 的說明（走遊戲自己的 card_infomation 浮框）。 */
const PICKER_TIP: Record<string, string> = {
  ja: "所持キャラ一覧。クリックで選択（複数可）",
  en: "Owned characters. Click to select (multiple OK)",
  kr: "보유 캐릭터. 클릭해서 선택 (여러 명 가능)",
  scn: "持有角色一览，点选可复选",
  tcn: "持有角色一覽，點選可複選",
};

/** [Favorite] 鈕 hover 的說明。 */
const FAV_TIP: Record<string, string> = {
  ja: "お気に入りのカードだけ表示",
  en: "Show favorite cards only",
  kr: "즐겨찾기 카드만 표시",
  scn: "只显示最爱卡片",
  tcn: "只顯示最愛卡片",
};

/**
 * 版面。畫布 760×680。2026-09-26 實機量：
 *
 * - 卡片格線 6×3，中心 (66 + 88c, 115 + 122r)、卡 84×120 → 佔 x 24..548、y 55..419
 * - 「1 Page」：page_btn_base (8,431) 32×20、page_btn_label「Page」接在右邊
 * - ◀ arrow_prev (232,431)、▶ arrow_next (340,431)
 * - 「抽出」：filter_label 右對齊在 filter_btn_drop 左緣 −2（x 442），下拉 104×20 右緣 548
 * - 右邊預覽區的資料面板 chara_info x 580..748（中心 664）
 * - 「複製卡片」btn_copy (616,612) 64×56 → x 584..648，離面板左緣 4（R 卡是同位置的
 *   btn_story）。「最愛卡片」鈕照面板中心鏡射過去：x 680..744、中心 712
 */
const LAYOUT = {
  gridX: 24,
  gridY: 55,
  gridW: 528,
  gridH: 366,
  cols: 12,
  /** 一張縮一半（玩家 2026-09-26：「縮小一半 12x6」）。 */
  cardScale: 0.25,
  rowY: 431,
  pickerW: 52,
  pickerH: 20,
  favW: 104,
  favBtnX: 712,
  favBtnY: 612,
  /** [Chara Weapon] 與 Event 分頁的 [Favorite]：右緣切齊「抽出」下拉的右緣（格線右緣 548）。 */
  weaponW: 96,
  weaponRight: 548,
};

// ---------------------------------------------------------------------------
// Equipment 分頁的順序與過濾
// ---------------------------------------------------------------------------

/**
 * Equipment 格線要畫哪幾把、什麼順序。**同時給頁面與測試用**（ES5、不碰頁面）。
 *
 * - `list`：原版的 `weapon_card`（`{ card_id, quantity }`），照 card_id 排
 * - `rows`：`{ id: WeaponCards 那一列 }`
 * - `opt.charaOnly`：[Chara Weapon] 開著
 * - `opt.deckCharas`：目前牌組的角色鍵（照槽位順序），`opt.hidden`：手動隱藏的 id
 *
 * ```
 *   順序    通用武（chara null）→ 專武 → 查不到的 → 素材（chara "cc000"）
 *           同一組裡照原本順序；charaOnly 時專武照牌組槽位順序
 *   charaOnly  只留通用武＋牌組角色的專武；素材、手動隱藏的拿掉
 * ```
 *
 * 回傳新陣列，元素是原本那幾個物件（原版拿它們查持有數量）。
 */
export const WEAPON_VIEW_SNIPPET = `function ulrWeaponView(list, rows, opt) {
    var MATERIAL = "cc000";
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w) continue;
      var r = rows[w.card_id];
      var chara = r ? r.chara : undefined;
      var group = !r ? 2 : chara === null ? 0 : chara === MATERIAL ? 3 : 1;
      var slot = 0;
      if (opt.charaOnly) {
        if (group === 3 || opt.hidden.indexOf(w.card_id) !== -1) continue;
        if (group === 1) {
          slot = opt.deckCharas.indexOf(chara);
          if (slot === -1) continue;
        }
      }
      out.push({ w: w, group: group, slot: slot, at: i });
    }
    out.sort(function (a, b) {
      return a.group - b.group || a.slot - b.slot || a.at - b.at;
    });
    return out.map(function (x) { return x.w; });
  }`;

// ---------------------------------------------------------------------------
// 代表卡
// ---------------------------------------------------------------------------

/**
 * 一個角色要拿哪一張卡代表。**這一段同時給頁面與測試用**（測試用 `new Function`
 * 把它跑起來），所以寫成 ES5、不依賴頁面上任何東西。
 *
 * - `rows`：這個角色的 `CharaCards`（kind 0）。L 卡 rarity 5（level 1..5），
 *   R 卡 rarity 6..10、檔名帶 `_r`
 * - `owned`：`{ card_id: true }`，手上有（quantity > 0）的
 * - `mode`：`L1`..`L5` 或 `R`
 *
 * 挑法（玩家 2026-09-26 訂的：「要擁有此卡，沒有就顯示最接近的，例如 L4」）：
 *
 * ```
 *   Ln  手上的 L 卡裡等級最接近 n（平手取高）→ 沒有 L 就手上的 R 卡最接近 n
 *   R   手上的 R 卡最高等               → 沒有 R 就照 L5 挑
 *   都沒有 → 照同樣規則從全部卡裡挑，owned: false（一覽不畫這個角色）
 * ```
 */
export const PICK_CARD_SNIPPET = `function ulrPickCard(rows, owned, mode) {
    var L = [], R = [];
    for (var i = 0; i < rows.length; i++) (rows[i].rarity >= 6 ? R : L).push(rows[i]);
    var target = mode === "R" ? 99 : Number(String(mode).slice(1)) || 5;
    function has(r) { return owned[r.id] === true; }
    function nearest(list, t) {
      var best = null;
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        if (best === null) { best = r; continue; }
        var d = Math.abs(r.level - t), bd = Math.abs(best.level - t);
        if (d < bd || (d === bd && r.level > best.level)) best = r;
      }
      return best;
    }
    var oL = L.filter(has), oR = R.filter(has);
    var hit = mode === "R"
      ? (nearest(oR, 99) || nearest(oL, 5))
      : (nearest(oL, target) || nearest(oR, target));
    if (hit) return { id: hit.id, owned: true };
    var any = mode === "R" ? (nearest(R, 99) || nearest(L, 5)) : (nearest(L, target) || nearest(R, target));
    return any ? { id: any.id, owned: false } : null;
  }`;

// ---------------------------------------------------------------------------
// 腳本
// ---------------------------------------------------------------------------

/**
 * 產生注入腳本。重跑一次是安全的：一進去先把上一次掛的東西全部拆掉。
 */
export function buildCharaPickerPatchScript(options: CharaPickerPatchOptions): string {
  const config = {
    version: CHARA_PICKER_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CHARA_PICKER_POLL_MS,
    state: options.state,
    favButton: FAV_BUTTON,
    pickerTip: PICKER_TIP,
    favTip: FAV_TIP,
    hideButton: HIDE_BUTTON,
    weaponTip: WEAPON_TIP,
    layout: LAYOUT,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var L = CFG.layout;
  var FLAG = ${JSON.stringify(FLAG)};
  ${WEBPACK_REQUIRE_SNIPPET}
  ${PICK_CARD_SNIPPET}
  ${WEAPON_VIEW_SNIPPET}

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table, lang) { return table[lang] || table.en; }

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  function alive(o) { return !!(o && o.scene); }

  function editScene() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    var sc = keys && keys.Edit;
    return sc && sc.scene && sc.scene.isActive() ? sc : null;
  }

  function play(sc) { try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {} }

  function redraw(sc) {
    try { sc.refresh(); } catch (e) { report({ type: "chara-picker-error", message: "重畫：" + String((e && e.message) || e) }); }
  }

  // -------------------------------------------------------------------------
  // 資料
  // -------------------------------------------------------------------------

  function json(sc, key) {
    try { return sc.cache.json.get(key) || null; } catch (e) { return null; }
  }

  /** 角色名（照遊戲語言），查不到回鍵本身。 */
  function charaName(sc, key) {
    var ch = json(sc, "Characters");
    var row = ch && ch[key];
    var name = row && row["name_" + gameLang()];
    return typeof name === "string" && name.length > 0 ? name : key;
  }

  /**
   * 角色一覽，順序與範圍照原版「抽出」下拉（Edit.create_filter_drop）：
   * Characters 的鍵依序，第一張 CharaCards 是 kind 0 的才算。
   */
  function charaKeys(sc) {
    var cc = json(sc, "CharaCards"), ch = json(sc, "Characters");
    if (!Array.isArray(cc) || !ch) return [];
    var first = {};
    for (var i = 0; i < cc.length; i++) {
      var r = cc[i];
      if (r && typeof r.chara === "string" && !first.hasOwnProperty(r.chara)) first[r.chara] = r;
    }
    return Object.keys(ch).filter(function (k) { return first[k] && first[k].kind === 0; });
  }

  function ownedMap(sc) {
    var out = {};
    try {
      var reg = sc.registry.get("chara_card") || [];
      for (var i = 0; i < reg.length; i++) {
        if (reg[i] && reg[i].quantity > 0) out[reg[i].card_id] = true;
      }
    } catch (e) {}
    return out;
  }

  function cardRow(sc, id) {
    var cc = json(sc, "CharaCards");
    if (!Array.isArray(cc)) return null;
    for (var i = 0; i < cc.length; i++) if (cc[i] && cc[i].id === id) return cc[i];
    return null;
  }

  /**
   * 遊戲畫卡的那支（webpack 模組裡帶 create_card 的類別）。找一次記著。
   * 特徵字串：create_card 與 level_guage_（卡面左上的等級槽）在同一個模組。
   */
  function cardFactory(st) {
    if (st.factory !== undefined) return st.factory;
    st.factory = null;
    try {
      var req = ulrWebpackRequire();
      if (req === null) return null;
      for (var id in req.m) {
        var src;
        try { src = String(req.m[id]); } catch (e) { continue; }
        if (src.indexOf("create_card") === -1 || src.indexOf("level_guage_") === -1) continue;
        var mod;
        try { mod = req(id); } catch (e) { continue; }
        for (var k in mod) {
          if (mod[k] && typeof mod[k].create_card === "function") { st.factory = mod[k]; return st.factory; }
        }
      }
    } catch (e) {}
    return st.factory;
  }

  // -------------------------------------------------------------------------
  // 角色一覽（蓋在卡片格線上）
  // -------------------------------------------------------------------------

  /** 格線上原本那 18 張的所有零件。 */
  function gridParts(sc) {
    var out = [];
    (sc.card_displayed || []).forEach(function (d) {
      if (!d) return;
      [d.card_base, d.card, d.stock_label, d.stock_max, d.stock_now]
        .concat(d.penalty || [])
        .forEach(function (o) { if (o) out.push(o); });
    });
    return out;
  }

  function hideInfo(sc) {
    try { sc.card_infomation.setVisible(false).setText("").setResolution(0); } catch (e) {}
  }

  function showInfo(sc, text) {
    if (sc.show_info === false) return;
    try { sc.card_infomation.setText(text).setResolution(2).setVisible(true); } catch (e) {}
  }

  /**
   * 原本那 18 張：藏起來、關掉點擊（Container 藏起來裡面的 zone 還點得到）。
   * 一覽開著時勾選會 refresh，新畫的那 18 張也要再藏一次。
   */
  function hideGrid(sc, ov) {
    gridParts(sc).forEach(function (o) {
      if (o.visible) { o.setVisible(false); ov.hidden.push(o); }
    });
    (sc.card_displayed || []).forEach(function (d) {
      var c = d && d.card;
      if (c && c.zone && c.zone.input && c.zone.input.enabled && typeof c.disableInteractive === "function") {
        c.disableInteractive();
        ov.disabled.push(c);
      }
    });
  }

  function openPicker(st, sc) {
    closePicker(st);
    var ov = { hidden: [], disabled: [], tiles: [], marks: [] };
    st.overlay = ov;
    hideGrid(sc, ov);

    var cc = json(sc, "CharaCards") || [];
    var owned = ownedMap(sc);
    // 只畫手上有卡的角色（玩家 2026-09-26：「沒持有的角色不要顯示」）。
    var list = [];
    charaKeys(sc).forEach(function (key) {
      var mine = cc.filter(function (r) { return r && r.chara === key && r.kind === 0; });
      var rep = ulrPickCard(mine, owned, st.state.mode);
      if (rep !== null && rep.owned) list.push({ key: key, id: rep.id });
    });

    var T = cardFactory(st);
    var rows = Math.max(1, Math.ceil(list.length / L.cols));
    var cellW = L.gridW / L.cols;
    var cellH = Math.min(L.gridH / rows, 240 * L.cardScale + 1);
    var scale = Math.min(L.cardScale, (cellH - 1) / 240);

    list.forEach(function (item, i) {
      var key = item.key;
      var x = Math.round(L.gridX + cellW * (i % L.cols) + cellW / 2);
      var y = Math.round(L.gridY + cellH * Math.floor(i / L.cols) + cellH / 2);
      var card = null, hit = null;
      if (T !== null) {
        try {
          card = T.create_card(sc, item.id, 1, 1, x, y);
          card.setScale(scale).setDepth(12);
          hit = card.zone;
        } catch (e) { card = null; }
      }
      if (card === null) {
        var row = cardRow(sc, item.id);
        var frame = row && row.filename;
        if (!frame || !sc.textures.exists("CharaCardImages") || !sc.textures.get("CharaCardImages").has(frame)) return;
        card = sc.add.image(x, y, "CharaCardImages", frame).setDepth(12);
        card.setDisplaySize(Math.round(168 * scale), Math.round(240 * scale));
        hit = card;
      }
      // 勾選中的角色：遊戲自己的 card_click 框（卡片 hover 用的那一格）。
      var m = { key: key, img: null, hover: false };
      try {
        m.img = sc.add.image(x, y, "CharaCardBaseImages", "card_click").setScale(scale).setDepth(13);
      } catch (e) { m.img = null; }
      var name = charaName(sc, key);
      hit.setInteractive();
      hit.on("pointerover", function () {
        m.hover = true;
        paintMarks(st, sc);
        showInfo(sc, "[b]" + name + "[/b]");
      });
      hit.on("pointerout", function () {
        m.hover = false;
        paintMarks(st, sc);
        hideInfo(sc);
      });
      hit.on("pointerup", function () { toggleChara(st, sc, key); });
      ov.tiles.push(card);
      if (m.img) { ov.tiles.push(m.img); ov.marks.push(m); }
    });
    paintMarks(st, sc);
    paintPicker(st);
  }

  function paintMarks(st, sc) {
    var ov = st.overlay;
    if (!ov) return;
    var picked = sc.chara_filter || [];
    ov.marks.forEach(function (m) {
      try { if (alive(m.img)) m.img.setVisible(m.hover || picked.indexOf(m.key) !== -1); } catch (e) {}
    });
  }

  /** 收起角色一覽。原本那 18 張放回來（refresh 已經換掉的就不管了）。 */
  function closePicker(st) {
    var ov = st.overlay;
    if (!ov) return;
    st.overlay = null;
    ov.tiles.forEach(function (o) { try { o.destroy(); } catch (e) {} });
    ov.hidden.forEach(function (o) { try { if (alive(o)) o.setVisible(true); } catch (e) {} });
    ov.disabled.forEach(function (c) { try { if (alive(c)) c.setInteractive(); } catch (e) {} });
    if (st.scene) hideInfo(st.scene);
    paintPicker(st);
  }

  /**
   * 勾選／取消一個角色，跟原版「抽出」打勾一樣（一覽不收，可以接著勾別的）。
   * 格線在底下照新的篩選重畫、再藏起來 —— 收起一覽時看到的就是篩好的。
   * 用了 [Chara] 就不是在看最愛了，順手關掉 [Favorite]。
   */
  function toggleChara(st, sc, key) {
    play(sc);
    var cur = (sc.chara_filter || []).slice();
    var at = cur.indexOf(key);
    if (at === -1) cur.push(key); else cur.splice(at, 1);
    sc.chara_filter = cur;
    sc.chara_page = 1;
    st.favOn = false;
    paintFav(st);
    st.keepOpen = true;
    try { redraw(sc); } finally { st.keepOpen = false; }
    if (st.overlay) hideGrid(sc, st.overlay);
    paintMarks(st, sc);
  }

  // -------------------------------------------------------------------------
  // [Chara] 鈕
  // -------------------------------------------------------------------------

  function mountPicker(st, sc) {
    if (st.state.mode === "off") return;
    var right = 412;
    try { right = Math.round(sc.filter_label.getTopLeft().x) - 6; } catch (e) {}
    var left = 360;
    try { left = Math.round(sc.arrow_next.x) + 14; } catch (e) {}
    var w = Math.max(40, Math.min(L.pickerW, right - left));
    var cx = right - w / 2;
    var base = sc.add.nineslice(cx, L.rowY, "btn_gene", 0, w, L.pickerH, 4, 4, 4, 4).setDepth(20);
    var text = sc.add.text(cx, L.rowY, "Chara", {
      fontFamily: "font_medium", fontSize: 12, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5).setDepth(21);
    base.setInteractive();
    base.on("pointerover", function () {
      base.setTexture("btn_gene", 1);
      showInfo(sc, pick(CFG.pickerTip, gameLang()));
    });
    base.on("pointerout", function () { paintPicker(st); hideInfo(sc); });
    base.on("pointerdown", function () { base.setTexture("btn_gene", 0); });
    base.on("pointerup", function () {
      play(sc);
      hideInfo(sc);
      if (st.overlay) closePicker(st); else openPicker(st, sc);
    });
    st.picker = { base: base, text: text };
    st.mine.push(base, text);
  }

  /** 一覽開著時鈕停在按下去的樣子。 */
  function paintPicker(st) {
    var p = st.picker;
    if (!p || !alive(p.base)) return;
    try { p.base.setTexture("btn_gene", st.overlay ? 1 : 0); } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // [Favorite] 鈕（「1 Page」右邊）
  // -------------------------------------------------------------------------

  function mountFav(st, sc) {
    var x = 76;
    try { x = Math.round(sc.page_btn_label.getTopRight().x) + 8; } catch (e) {}
    var cx = x + L.favW / 2;
    var base = sc.add.nineslice(cx, L.rowY, "btn_gene", 0, L.favW, 20, 4, 4, 4, 4).setDepth(20);
    var text = sc.add.text(cx, L.rowY, "Favorite", {
      fontFamily: "font_medium", fontSize: 12, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5).setDepth(21);
    base.setInteractive();
    base.on("pointerover", function () {
      base.setTexture("btn_gene", 1);
      showInfo(sc, pick(CFG.favTip, gameLang()));
    });
    base.on("pointerout", function () { paintFav(st); hideInfo(sc); });
    base.on("pointerdown", function () { base.setTexture("btn_gene", 0); });
    base.on("pointerup", function () {
      play(sc);
      hideInfo(sc);
      setFavOn(st, sc, !st.favOn);
    });
    st.fav = { base: base, text: text };
    st.mine.push(base, text);
  }

  /** 開著時鈕停在按下去的樣子。 */
  function paintFav(st) {
    var f = st.fav;
    if (!f || !alive(f.base)) return;
    try { f.base.setTexture("btn_gene", st.favOn ? 1 : 0); } catch (e) {}
  }

  /** 打開 = 格線只剩最愛卡片（清掉人物篩選，「顯示所有最愛卡片」）。 */
  function setFavOn(st, sc, on) {
    st.favOn = on;
    if (on) sc.chara_filter = [];
    sc.chara_page = 1;
    closePicker(st);
    paintFav(st);
    redraw(sc);
  }

  /**
   * 包住 sc.card_filter：原版 refresh 每次都先叫它從 registry 產出格線要畫的
   * chara_card。[Favorite] 開著時在它之後再濾一次卡片 id。
   */
  function favFilter(orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try {
        var cur = window[FLAG];
        if (cur && cur.favOn && this.category === "chara" && Array.isArray(this.chara_card)) {
          var fav = cur.state.favorites;
          this.chara_card = this.chara_card.filter(function (c) { return c && fav.indexOf(c.card_id) !== -1; });
        }
      } catch (e) {}
      return r;
    };
  }

  // -------------------------------------------------------------------------
  // Event 分頁：[Favorite]（玩家圈的位置：格線右下、「抽出」那裡）
  // -------------------------------------------------------------------------

  function mountEventFav(st, sc) {
    var cx = L.weaponRight - L.favW / 2;
    var base = sc.add.nineslice(cx, L.rowY, "btn_gene", 0, L.favW, 20, 4, 4, 4, 4).setDepth(20);
    var text = sc.add.text(cx, L.rowY, "Favorite", {
      fontFamily: "font_medium", fontSize: 12, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5).setDepth(21);
    base.setInteractive();
    base.on("pointerover", function () {
      base.setTexture("btn_gene", 1);
      showInfo(sc, pick(CFG.favTip, gameLang()));
    });
    base.on("pointerout", function () { paintEventFav(st); hideInfo(sc); });
    base.on("pointerdown", function () { base.setTexture("btn_gene", 0); });
    base.on("pointerup", function () {
      play(sc);
      hideInfo(sc);
      st.eventFavOn = !st.eventFavOn;
      sc.event_page = 1;
      paintEventFav(st);
      redraw(sc);
    });
    st.eventFav = { base: base, text: text };
    st.mine.push(base, text);
    paintEventFav(st);
  }

  /** 開著時鈕停在按下去的樣子。 */
  function paintEventFav(st) {
    var f = st.eventFav;
    if (!f || !alive(f.base)) return;
    try { f.base.setTexture("btn_gene", st.eventFavOn ? 1 : 0); } catch (e) {}
  }

  /**
   * event 分頁重畫前：[Favorite] 開著就把 sc.event_card 換成只剩最愛的那份；
   * 頁數照要畫的那份重算（關著時就是原版的算法）。回傳原本的陣列，畫完要換回去。
   */
  function applyEventView(st, sc) {
    var all = sc.event_card;
    var fav = st.state.favoriteEvents;
    var view = st.eventFavOn
      ? all.filter(function (c) { return c && fav.indexOf(c.card_id) !== -1; })
      : all;
    sc.event_card = view;
    sc.event_page_max = Math.max(1, Math.ceil(view.length / 18));
    sc.event_page = Math.min(Math.max(1, sc.event_page || 1), sc.event_page_max);
    return all;
  }

  /**
   * 右邊預覽區現在是哪一張事件卡。事件卡預覽每次重建 card_preview，裡面那張圖是
   * EventCardImages 的 event_<id>（名字會重複，不能拿名字查）。
   */
  function previewEvent(sc) {
    var base = sc.chara_profile_base;
    if (!alive(base) || !base.texture || base.texture.key !== "event_info") return null;
    var cp = sc.card_preview;
    if (!alive(cp) || !Array.isArray(cp.list)) return null;
    for (var i = 0; i < cp.list.length; i++) {
      var o = cp.list[i];
      if (!o || !o.texture || o.texture.key !== "EventCardImages" || !o.frame) continue;
      // 不用正規式：整段腳本住在 template literal 裡，反斜線會被吃掉。
      var name = String(o.frame.name);
      var id = name.indexOf("event_") === 0 ? Number(name.slice(6)) : NaN;
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Equipment 分頁：順序、[Chara Weapon]
  // -------------------------------------------------------------------------

  function weaponRows(sc) {
    var W = json(sc, "WeaponCards");
    var out = {};
    if (!Array.isArray(W)) return out;
    for (var i = 0; i < W.length; i++) if (W[i]) out[W[i].id] = W[i];
    return out;
  }

  /** 目前牌組的角色鍵，照槽位順序（空槽跳過）。 */
  function deckCharaKeys(sc) {
    var out = [];
    var decks = sc.deck || [];
    for (var i = 0; i < decks.length; i++) {
      var d = decks[i];
      if (!d || d.deck_id !== sc.deck_now) continue;
      (d.chara_card_id || []).forEach(function (id) {
        if (id === null || id === undefined) return;
        var row = cardRow(sc, id);
        if (row && typeof row.chara === "string" && out.indexOf(row.chara) === -1) out.push(row.chara);
      });
    }
    return out;
  }

  /**
   * weapon 分頁重畫前：把 sc.weapon_card 換成排好濾好的那份、重算頁數。
   * 回傳原本的陣列，畫完要換回去。
   */
  function applyWeaponView(st, sc) {
    var all = sc.weapon_card;
    var view = ulrWeaponView(all, weaponRows(sc), {
      charaOnly: st.weaponOn,
      deckCharas: st.weaponOn ? deckCharaKeys(sc) : [],
      hidden: st.state.hiddenWeapons
    });
    sc.weapon_card = view;
    sc.weapon_page_max = Math.max(1, Math.ceil(view.length / 18));
    sc.weapon_page = Math.min(Math.max(1, sc.weapon_page || 1), sc.weapon_page_max);
    return all;
  }

  function mountWeapon(st, sc) {
    var cx = L.weaponRight - L.weaponW / 2;
    var base = sc.add.nineslice(cx, L.rowY, "btn_gene", 0, L.weaponW, 20, 4, 4, 4, 4).setDepth(20);
    var text = sc.add.text(cx, L.rowY, "Chara Weapon", {
      fontFamily: "font_medium", fontSize: 12, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5).setDepth(21);
    base.setInteractive();
    base.on("pointerover", function () {
      base.setTexture("btn_gene", 1);
      showInfo(sc, pick(CFG.weaponTip, gameLang()));
    });
    base.on("pointerout", function () { paintWeapon(st); hideInfo(sc); });
    base.on("pointerdown", function () { base.setTexture("btn_gene", 0); });
    base.on("pointerup", function () {
      play(sc);
      hideInfo(sc);
      st.weaponOn = !st.weaponOn;
      sc.weapon_page = 1;
      paintWeapon(st);
      redraw(sc);
    });
    st.weapon = { base: base, text: text };
    st.mine.push(base, text);
    paintWeapon(st);
  }

  /** 開著時鈕停在按下去的樣子。 */
  function paintWeapon(st) {
    var w = st.weapon;
    if (!w || !alive(w.base)) return;
    try { w.base.setTexture("btn_gene", st.weaponOn ? 1 : 0); } catch (e) {}
  }

  /**
   * 右邊預覽區現在是哪一把武器。原版武器預覽不存 id，只有 event_info 底圖與
   * profile_texts[0] 的名字；拿名字回查，查到剛好一把才算（沒名字的未實裝武器會重名）。
   */
  function previewWeapon(sc) {
    var base = sc.chara_profile_base;
    if (!alive(base) || !base.texture || base.texture.key !== "event_info") return null;
    var nameText = sc.profile_texts && sc.profile_texts[0];
    if (!alive(nameText)) return null;
    var name = String(nameText.text);
    if (name === "" || name === "-") return null;
    var W = json(sc, "WeaponCards");
    if (!Array.isArray(W)) return null;
    var key = "name_" + gameLang();
    var hit = null;
    for (var i = 0; i < W.length; i++) {
      if (!W[i] || W[i][key] !== name) continue;
      if (hit !== null) return null;
      hit = W[i].id;
    }
    return hit;
  }

  // -------------------------------------------------------------------------
  // 「最愛卡片」鈕（右邊預覽區右下）
  // -------------------------------------------------------------------------

  /**
   * 拿「複製卡片」那張圖（64×112，上下兩格 64×56：常態、hover）抹掉字重寫。
   *
   * 2026-09-26 量的：字在每格的 y 21..35、x 8..58；底色只有上下漸層、左右一致，
   * 所以每一列拿 x 4..5 那兩格橫向鋪過去就抹乾淨了（跟 patch-display 的
   * HD_BUTTONS 同一招）。畫在 4 倍的畫布上，畫面放大時字才不糊。
   */
  var K = 4;
  function favTexture(sc, label) {
    var key = "ulr_fav_btn_" + label;
    var tm = sc.textures;
    if (tm.exists(key)) return key;
    if (!tm.exists("btn_copy")) return null;
    var src = tm.get("btn_copy").getSourceImage();
    if (!src || src.width !== 64 || src.height !== 112) return null;
    var base = document.createElement("canvas");
    base.width = 64; base.height = 112;
    var b = base.getContext("2d");
    b.drawImage(src, 0, 0);
    for (var cy = 0; cy < 112; cy += 56) {
      for (var x = 6; x <= 59; x += 2) b.drawImage(base, 4, cy + 19, 2, 19, x, cy + 19, 2, 19);
    }
    var cv = tm.createCanvas(key, 64 * K, 112 * K);
    var h = cv.getContext();
    h.imageSmoothingEnabled = true;
    h.drawImage(base, 0, 0, 64 * K, 112 * K);
    var looks = [
      { color: "#ffffff", shadow: "#000000", blur: 2, offset: 0.5, passes: 2 },
      { color: "#f4fbff", shadow: "#8fe3ff", blur: 3, offset: 0, passes: 2 }
    ];
    for (var f = 0; f < 2; f++) {
      var look = looks[f];
      var size = 12;
      h.save();
      h.font = (size * K) + "px font_bold";
      while (h.measureText(label).width > 50 * K && size > 7) { size -= 0.5; h.font = (size * K) + "px font_bold"; }
      h.textAlign = "center";
      h.textBaseline = "middle";
      h.fillStyle = look.color;
      h.shadowColor = look.shadow;
      h.shadowBlur = look.blur * K;
      h.shadowOffsetX = look.offset * K;
      h.shadowOffsetY = look.offset * K;
      for (var p = 0; p < look.passes; p++) h.fillText(label, 32 * K, (f * 56 + 28.5) * K);
      h.restore();
    }
    cv.add(0, 0, 0, 0, 64 * K, 56 * K);
    cv.add(1, 0, 0, 56 * K, 64 * K, 56 * K);
    cv.refresh();
    return key;
  }

  /** 右邊預覽區現在是哪一張角色卡（只認有「複製卡片」或「閱讀故事」鈕的那種）。 */
  function previewCard(sc) {
    var hasBtn = (sc.btn_copy && alive(sc.btn_copy.image)) || alive(sc.btn_story);
    if (!hasBtn) return null;
    var idText = sc.profile_texts && sc.profile_texts[10];
    if (!alive(idText)) return null;
    var row = cardRow(sc, Number(idText.text));
    return row && row.kind === 0 ? row.id : null;
  }

  /**
   * 右下那顆鈕現在該做什麼：預覽事件卡 = 最愛卡片（事件）、預覽武器 = 隱藏裝備、
   * 預覽角色卡 = 最愛卡片。list 是 st.state 裡對應的那個欄位名。
   * 事件卡先認：它跟武器共用 event_info 底圖，武器那邊是拿名字查的。
   */
  function cornerTarget(sc) {
    var ev = previewEvent(sc);
    if (ev !== null) {
      return { card: ev, list: "favoriteEvents", report: "event-favorite", labels: CFG.favButton };
    }
    var weapon = previewWeapon(sc);
    if (weapon !== null) {
      return { card: weapon, list: "hiddenWeapons", report: "weapon-hidden", labels: CFG.hideButton };
    }
    var card = previewCard(sc);
    if (card !== null) {
      return { card: card, list: "favorites", report: "card-favorite", labels: CFG.favButton };
    }
    return null;
  }

  function syncFavButton(st, sc) {
    var target = st.state.favoritesReady ? cornerTarget(sc) : null;
    var fb = st.favBtn;
    if (target === null) {
      if (fb && alive(fb.img)) fb.img.setVisible(false);
      return;
    }
    var on = st.state[target.list].indexOf(target.card) !== -1;
    var label = pick(target.labels, gameLang())[on ? 1 : 0];
    var key = favTexture(sc, label);
    if (key === null) return;
    if (!fb || !alive(fb.img)) {
      var img = sc.add.image(L.favBtnX, L.favBtnY, key, 0).setScale(1 / K).setInteractive();
      fb = { img: img, key: key, target: target, hover: false };
      img.on("pointerover", function () { fb.hover = true; img.setFrame(1); });
      img.on("pointerout", function () { fb.hover = false; img.setFrame(0); });
      img.on("pointerdown", function () { img.setFrame(0); });
      img.on("pointerup", function () {
        img.setFrame(1);
        var t = fb.target;
        if (!t) return;
        play(sc);
        var c = t.card;
        var cur = st.state[t.list];
        var now = cur.indexOf(c) === -1;
        // 先動（樂觀更新），真相由 Node 存完再推回來。
        st.state[t.list] = now ? cur.concat([c]) : cur.filter(function (k) { return k !== c; });
        report({ type: t.report, card: c, on: now });
        syncFavButton(st, sc);
        // 正在看最愛／只看角色武器：拿掉（藏起來）的那張要從格線上換掉。
        if (t.list === "favorites" && st.favOn) redraw(sc);
        if (t.list === "hiddenWeapons" && st.weaponOn && sc.category === "weapon") redraw(sc);
        if (t.list === "favoriteEvents" && st.eventFavOn && sc.category === "event") redraw(sc);
      });
      st.favBtn = fb;
      st.mine.push(img);
    }
    fb.target = target;
    if (fb.key !== key) { fb.key = key; fb.img.setTexture(key, fb.hover ? 1 : 0); }
    fb.img.setVisible(true);
  }

  // -------------------------------------------------------------------------
  // 掛載
  // -------------------------------------------------------------------------

  /**
   * 在場景實例上包一支方法。⚠ 場景實例是長命的：包在實例上的自有屬性，拆的時候
   * 要刪掉（露出 prototype 那支）。
   */
  function wrapMethod(st, sc, name, make) {
    var orig = sc[name];
    if (typeof orig !== "function" || orig.__ulrPickerWrap) return;
    var own = Object.prototype.hasOwnProperty.call(sc, name);
    var patched = make(orig);
    patched.__ulrPickerWrap = true;
    sc[name] = patched;
    st.wraps.push({ sc: sc, name: name, patched: patched, orig: orig, own: own });
  }

  function unwrapAll(st) {
    var list = st.wraps;
    st.wraps = [];
    for (var i = list.length - 1; i >= 0; i--) {
      var w = list[i];
      try {
        if (w.sc[w.name] !== w.patched) continue;
        if (w.own) w.sc[w.name] = w.orig; else delete w.sc[w.name];
      } catch (e) {}
    }
  }

  function mount(st, sc) {
    st.scene = sc;
    mountPicker(st, sc);
    if (st.state.favoritesReady) { mountFav(st, sc); mountEventFav(st, sc); }
    mountWeapon(st, sc);
    // 原版每次重畫格線（翻頁、切分頁、原版「抽出」、換牌組）之前先把角色一覽收起來
    // —— 否則新畫的 18 張會露在一覽底下，而且點得到。一覽裡勾選自己叫的不算。
    // weapon／event 分頁：畫的時候換成排好濾好的那份，畫完換回原本的陣列。
    wrapMethod(st, sc, "refresh", function (orig) {
      return function () {
        var cur = window[FLAG];
        try { if (cur && cur.overlay && !cur.keepOpen) closePicker(cur); } catch (e) {}
        var field = null, all = null;
        if (cur && this.category === "weapon" && Array.isArray(this.weapon_card)) {
          field = "weapon_card";
          all = this.weapon_card;
          try { applyWeaponView(cur, this); } catch (e) { this.weapon_card = all; }
        } else if (cur && this.category === "event" && Array.isArray(this.event_card)) {
          field = "event_card";
          all = this.event_card;
          try { applyEventView(cur, this); } catch (e) { this.event_card = all; }
        }
        try {
          return orig.apply(this, arguments);
        } finally {
          if (field !== null) this[field] = all;
        }
      };
    });
    wrapMethod(st, sc, "card_filter", favFilter);
    // 錨：跟著場景重建一起死的東西。[Chara] 鈕可能沒有（off），退回 [Chara Weapon]。
    st.anchor = (st.picker && st.picker.base) || (st.weapon && st.weapon.base) || sc.page_now || null;
  }

  function detach(st) {
    var sc = st.scene;
    var wasFav = st.favOn;
    var wasEventFav = st.eventFavOn;
    st.favOn = false;
    st.eventFavOn = false;
    closePicker(st);
    unwrapAll(st);
    (st.mine || []).forEach(function (o) { try { if (o && o.destroy) o.destroy(); } catch (e) {} });
    st.mine = [];
    st.scene = null;
    st.picker = null;
    st.fav = null;
    st.eventFav = null;
    st.weapon = null;
    st.favBtn = null;
    st.anchor = null;
    if (!sc || !sc.scene || !sc.scene.isActive()) return;
    // Equipment 的頁數是我們照過濾後算的：還原成原版的算法（全部幾把）。
    var weaponTab = sc.category === "weapon";
    if (Array.isArray(sc.weapon_card)) {
      sc.weapon_page_max = Math.max(1, Math.ceil(sc.weapon_card.length / 18));
      sc.weapon_page = Math.min(Math.max(1, sc.weapon_page || 1), sc.weapon_page_max);
    }
    // Event 的頁數也一樣（[Favorite] 開著時是照最愛算的）。
    if (Array.isArray(sc.event_card)) {
      sc.event_page_max = Math.max(1, Math.ceil(sc.event_card.length / 18));
      sc.event_page = Math.min(Math.max(1, sc.event_page || 1), sc.event_page_max);
    }
    // 格線還停在「只有最愛」或我們排的武器順序：場景還在就照原版重畫回來。
    if (wasFav || weaponTab || (wasEventFav && sc.category === "event")) redraw(sc);
  }

  /** 原版只在 chara 分頁畫「抽出」；我們的鈕跟著它出現／消失。 */
  function onCharaTab(sc) {
    return sc.category === "chara" && !!(sc.filter_btn_drop && sc.filter_btn_drop.visible);
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var sc = editScene();
      if (sc === null) {
        if (st.scene !== null) detach(st);
        return;
      }
      if (st.scene !== sc || !alive(st.anchor)) {
        detach(st);
        mount(st, sc);
        // 裝上時已經停在 Equipment：照我們的順序重畫一次。
        if (sc.category === "weapon") redraw(sc);
      }
      var tab = onCharaTab(sc);
      if (!tab && st.overlay) closePicker(st);
      if (st.picker) { st.picker.base.setVisible(tab); st.picker.text.setVisible(tab); }
      if (st.fav) { st.fav.base.setVisible(tab); st.fav.text.setVisible(tab); }
      var eventTab = sc.category === "event";
      if (st.eventFav) { st.eventFav.base.setVisible(eventTab); st.eventFav.text.setVisible(eventTab); }
      var weaponTab = sc.category === "weapon";
      if (st.weapon) { st.weapon.base.setVisible(weaponTab); st.weapon.text.setVisible(weaponTab); }
      syncFavButton(st, sc);
      st.reason = null;
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  // 隱藏清單、事件卡最愛舊版托盤不會送：當成空的。
  function normalize(s) {
    if (!Array.isArray(s.hiddenWeapons)) s.hiddenWeapons = [];
    if (!Array.isArray(s.favoriteEvents)) s.favoriteEvents = [];
    return s;
  }

  // 先拆上一版。[Chara Weapon] 開著就接著開（托盤重裝不該把玩家的選擇關掉）。
  var keepWeaponOn = false;
  (function () {
    var old = window[FLAG];
    if (!old) return;
    keepWeaponOn = old.weaponOn === true;
    try { if (old.timer) clearInterval(old.timer); } catch (e) {}
    try { if (typeof old.detach === "function") old.detach(); } catch (e) {}
    delete window[FLAG];
  })();

  var st = {
    version: CFG.version,
    state: normalize(CFG.state),
    mine: [],
    scene: null,
    overlay: null,
    picker: null,
    fav: null,
    favOn: false,
    eventFav: null,
    eventFavOn: false,
    weapon: null,
    weaponOn: keepWeaponOn,
    favBtn: null,
    keepOpen: false,
    wraps: [],
    anchor: null,
    factory: undefined,
    timer: null,
    reason: null,
    detach: function () { detach(st); },
    setState: function (next) {
      normalize(next);
      var remount = next.mode !== st.state.mode || next.favoritesReady !== st.state.favoritesReady;
      var favChanged = JSON.stringify(next.favorites) !== JSON.stringify(st.state.favorites);
      var hiddenChanged = JSON.stringify(next.hiddenWeapons) !== JSON.stringify(st.state.hiddenWeapons);
      var eventChanged = JSON.stringify(next.favoriteEvents) !== JSON.stringify(st.state.favoriteEvents);
      st.state = next;
      var sc = st.scene;
      if (remount) detach(st);
      // 清單被別處改了（雲端同步、存不進去被扳回）：正在用它篩的格線跟著換。
      else if (sc && ((favChanged && st.favOn) ||
        (hiddenChanged && st.weaponOn && sc.category === "weapon") ||
        (eventChanged && st.eventFavOn && sc.category === "event"))) redraw(sc);
      tick();
    }
  };
  window[FLAG] = st;
  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    mounted: st.scene !== null,
    open: st.overlay !== null,
    reason: st.reason
  });
})()`;
}

/** 推新狀態。回 `"not-installed"` 表示呼叫端要重裝。 */
export function buildCharaPickerStateExpression(state: CharaPickerState): string {
  return `(function () {
  var st = window["${FLAG}"];
  if (!st || typeof st.setState !== "function") return "not-installed";
  st.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

export const CHARA_PICKER_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, mounted: false, open: false, reason: null });
    return JSON.stringify({
      installed: true,
      version: st.version,
      mounted: st.scene !== null && st.scene !== undefined,
      open: !!st.overlay,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, mounted: false, open: false, reason: String((e && e.message) || e) });
  }
})()`;

export const CHARA_PICKER_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    try { if (typeof st.detach === "function") st.detach(); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseCharaPickerStatus(raw: string): CharaPickerStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      mounted: false,
      open: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    mounted: o.mounted === true,
    open: o.open === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
