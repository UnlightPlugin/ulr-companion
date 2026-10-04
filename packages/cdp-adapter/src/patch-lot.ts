/**
 * 暗房（抽卡）的預覽 —— 已有的東西調暗、事件卡標持有數
 * ======================================================
 * 滑過金／銀／銅抽的按鈕，下面會捲出一排獎品預覽。趴頭娃娃、面具、緞帶、
 * 和服這些 Avatar 裝飾，以及專武，**第二份沒有用**，但預覽上看不出哪些
 * 已經有了。使用者 2026-09-26 要的：
 *
 * - 已有的 Avatar 裝飾（銅抽的娃娃／面具／緞帶、銀抽的和服）調暗
 * - 已有的專武調暗（金抽）
 * - 角色卡：**L 卡看整個角色** —— L1〜L5、R1〜R5 任一張有就調暗，整個角色都
 *   沒有才原色；**R 卡只看這一張**，有才調暗
 * - 事件卡、通用武器（銅抽的黑的槍劍那些）標上持有數
 * - 專武標上主人的名字（2026-10-04 加的：金抽的武器圖認不出是誰的）。
 *   `WeaponCards.chara`（"cc046"）→ `Characters.cc046.name_<lang>`（泰瑞爾），
 *   都是客戶端開機就載好的 json，不送請求。名字跟遊戲語言走 —— 是官方資料，
 *   不是插件自己的字。不受「調暗已有」影響，一直標。
 * - 「自動選卡」下面多一個勾選「調暗已有」
 *
 * 規則全照 type／欄位判斷，**不是寫死的 id 清單** —— 暗房每期輪替也適用。
 *
 * ## 預覽是怎麼畫的（2026-09-26 從跑著的客戶端挖的，95.js 的 Lot 場景）
 *
 * ```js
 *   // 按鈕 pointerover：其他抽的 hide_preview，這一抽的 show_preview
 *   show_preview(c, key) { … null === c.preview && (c.preview = this.create_preview(key, c.scroll)); … }
 *   create_preview(key, scroll) {
 *     const i = this.lot_data[key].data;               // [{tier, type, slot, id, amount}]
 *     for (y…) { …每換一個 tier 加一個 lot_frame nineslice 進 r…
 *                e = create_card(this, i[y].id, i[y].type, i[y].slot, …); a.push(e); }
 *     return { sprites: [...r, ...a], … };             // 框在前、卡在後，卡跟 data 同序
 *   }
 *   hide_preview → tween 完整份 destroy、c.preview = null
 * ```
 *
 * 所以**每次顯示都是新建的**。我們在場景實例上包一層 `create_preview`：
 * 官方建完，照 data 的順序把卡（Container）一張張對上去處理。
 *
 * ## type／slot 對照（實測，跟 get_item_name 的分支對得上）
 *
 * | type | slot | 是什麼       | 持有數在哪                         |
 * | ---- | ---- | ------------ | ---------------------------------- |
 * | 1    | 任意 | 角色卡       | registry `chara_card`（card_id）   |
 * | 2    | 0    | 武器卡       | registry `weapon_card`（card_id）  |
 * | 2    | 2    | 事件卡       | registry `event_card`（card_id）   |
 * | 3    | 0    | 道具         | 不處理（消耗品）                   |
 * | 4    | 0    | Avatar 裝飾  | registry `avatar_parts`（parts_id）|
 *
 * 角色卡的「同一角色」＝ `CharaCards` 的 `chara` 一樣（cc034 史塔夏：331〜335
 * 是 L1〜L5、336〜340 是 R1〜R5）。L／R 的分界照官方 `get_item_name`：
 * `rarity < 6` 是 L。Lot 抽到角色卡後官方自己會重抓 `chara_card`，下面那套
 * 「陣列換了就丟記錄」剛好接得上。
 *
 * **專武 ＝ `WeaponCards` 的 `chara` 不是 null**（永恆之棘 → "cc001"）。
 * 銅抽的「黑的槍劍」那種通用武器 `chara` 是 null —— 可以一人一把，重複有用，
 * 不調暗，改成跟事件卡一樣標持有數。
 *
 * ## ⚠ 抽到的東西 registry 不會跟著更新
 *
 * Lot 抽完只重抓 `avatar_item`（抽卡券）與 `chara_card`。`avatar_parts`、
 * `weapon_card`、`event_card` 要等別的場景去更新 —— 抽到一個娃娃之後回頭看
 * 預覽，它還是亮的。
 *
 * 不為這個多送請求（伺服器請求能省則省）。改成**聽官方本來就會收到的回應**：
 * `socket.fetch("lot_start" | "lot_select")` 回來的 `result` 就是抽到的東西
 * （`[{id, type, slot, amount, tier}]`）。記在頁面上，加到 registry 的數字上。
 *
 * registry 被別的場景刷新之後那份就已經含了 —— 再加會重複算。判斷方式是
 * **陣列參考換了沒**：記的時候順便記下當時的陣列，換了就把記錄丟掉。
 *
 * ## 勾選放哪
 *
 * 官方兩個勾選在右邊：十連抽卡 y=406、自動選卡 y=424，間距 18。我們接在
 * 下面 y=442。預覽的框（nineslice）從 y=439 起，但上面一截是透明的，卡從
 * y≈474 才開始，不會蓋到。外觀照抄官方的 rexUI checkbox 設定。
 *
 * 字照官方那兩個勾選走在地語言（它們是 LotUITexts 的在地化字串），
 * 持有數照好友面板那條規矩用英文（Own 2）—— 一眼看得出是插件貼的。
 *
 * 勾選狀態記在遊戲頁面的 localStorage。只是這台機器的顯示偏好，不必經托盤。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。詳細的東西寫在這個檔頭。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。跟 `__ulrShop` / `__ulrPresent` 同一族。 */
const FLAG = "__ulrLot";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 先拆再裝，版本號是回報用的。
 */
export const LOT_SCRIPT_VERSION = 2;

/** 輪詢間隔：等玩家進暗房、等 Lot 場景重建勾選。 */
export const DEFAULT_LOT_POLL_MS = 300;

/** 勾選狀態存在遊戲頁面 localStorage 的哪個鍵。 */
export const LOT_DIM_STORAGE_KEY = "ulr.lot.dimOwned";

/** 調暗用的 tint。子物件逐一乘上這個色。 */
export const LOT_DIM_TINT = 0x505050;

/** 勾選旁邊的字。官方那兩個勾選是在地化的，這個跟著。 */
export const DIM_LABEL: Record<string, string> = {
  ja: "所持済を暗く",
  en: "Dim owned",
  kr: "보유 어둡게",
  scn: "调暗已有",
  tcn: "調暗已有",
};

/** 滑過勾選時的說明框。規則寫全，勾選本身只放四個字。 */
export const DIM_TOOLTIP: Record<string, string> = {
  ja: [
    "所持済みを暗く表示：",
    "・アバターパーツ、専用武器、R カード",
    "・L カード：同じキャラを 1 枚でも持っていれば",
    "（L1〜L5、R1〜R5 のどれか）",
    "イベントカードと汎用武器には所持数を表示",
  ].join("\n"),
  en: [
    "Dims prizes you already own:",
    "- Avatar parts, exclusive weapons, R cards",
    "- L cards: if you own any card of that character",
    "  (any of L1-L5, R1-R5)",
    "Event cards and common weapons show how many you own",
  ].join("\n"),
  kr: [
    "보유한 상품을 어둡게 표시:",
    "- 아바타 파츠, 전용 무기, R 카드",
    "- L 카드: 같은 캐릭터 카드를 한 장이라도 보유 시",
    "  (L1~L5, R1~R5 중 아무거나)",
    "이벤트 카드와 일반 무기는 보유 수 표시",
  ].join("\n"),
  scn: [
    "已有的奖品调暗：",
    "・Avatar 装饰、专武、R 卡",
    "・L 卡：同角色有任一张就调暗",
    "（L1〜L5、R1〜R5 任一张）",
    "事件卡与通用武器显示持有数",
  ].join("\n"),
  tcn: [
    "已有的獎品調暗：",
    "・Avatar 裝飾、專武、R 卡",
    "・L 卡：同角色有任一張就調暗",
    "（L1〜L5、R1〜R5 任一張）",
    "事件卡與通用武器顯示持有數",
  ].join("\n"),
};

export interface LotPatchOptions {
  pollIntervalMs?: number;
}

export interface LotStatus {
  installed: boolean;
  version: number | null;
  /** 「調暗已有」勾著沒。 */
  dimOwned: boolean;
  /** 勾選現在畫在暗房裡（＝玩家在暗房）。 */
  mounted: boolean;
  /** 從官方回應記下、registry 還沒反映的獎品件數。 */
  won: number;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 頁面端共用的那幾支
// ---------------------------------------------------------------------------

const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  function sceneOf(key) {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys[key]) || null;
  }

  /** 物件還活著（Phaser destroy 之後 scene 會變 undefined）。 */
  function alive(o) {
    return !!(o && o.scene);
  }

  /** 把官方的 create_preview 與 socket.fetch 還回去、我們畫的東西拆掉。 */
  function teardown(st) {
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    st.timer = null;
    var sc = sceneOf("Lot");
    try {
      if (sc && Object.prototype.hasOwnProperty.call(sc, "create_preview") &&
          sc.create_preview && sc.create_preview.__ulrLot) {
        delete sc.create_preview;
      }
    } catch (e) {}
    try {
      var sock = st.sock;
      if (sock && sock.fetch && sock.fetch.__ulrLot) {
        if (sock.fetch.__ulrOwn) sock.fetch = sock.fetch.__ulrOrig;
        else delete sock.fetch;
      }
    } catch (e) {}
    st.sock = null;
    try {
      if (sc && sc.lot_contents) {
        var ks = Object.keys(sc.lot_contents);
        for (var i = 0; i < ks.length; i++) {
          var p = sc.lot_contents[ks[i]] && sc.lot_contents[ks[i]].preview;
          if (!p || !p.sprites) continue;
          for (var j = 0; j < p.sprites.length; j++) {
            var c = p.sprites[j];
            if (!c || !c.__ulrLot) continue;
            if (c.__ulrLot.dim) tintAll(c, null);
            if (alive(c.__ulrLot.own)) c.__ulrLot.own.destroy();
            c.__ulrLot = null;
          }
        }
      }
    } catch (e) {}
    try { if (alive(st.check)) st.check.destroy(); } catch (e) {}
    try { if (alive(st.label)) st.label.destroy(); } catch (e) {}
    try { if (st.tipTween) st.tipTween.destroy(); } catch (e) {}
    try { if (alive(st.tip)) st.tip.destroy(); } catch (e) {}
    st.check = null;
    st.label = null;
    st.tip = null;
    st.tipTween = null;
    st.anchor = null;
  }

  /** Container 底下每個能 tint 的子物件都乘上 color；null ＝ 清掉。 */
  function tintAll(c, color) {
    var list = c.list || [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || (c.__ulrLot && o === c.__ulrLot.own)) continue;
      try {
        if (color === null) { if (typeof o.clearTint === "function") o.clearTint(); }
        else if (typeof o.setTint === "function") o.setTint(color);
      } catch (e) {}
    }
  }

  function wonCount(st) {
    var n = 0;
    var kinds = Object.keys(st.won || {});
    for (var i = 0; i < kinds.length; i++) {
      var add = st.won[kinds[i]].add;
      var ids = Object.keys(add);
      for (var j = 0; j < ids.length; j++) n += add[ids[j]];
    }
    return n;
  }

  function statusOf(st) {
    return {
      installed: true,
      version: st.version,
      dimOwned: !!st.dim,
      mounted: alive(st.check),
      won: wonCount(st),
      reason: st.reason
    };
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 * 從官方回應記下的獎品（`won`）會帶過去 —— 那是事實，不是我們畫的東西。
 */
export function buildLotPatchScript(options: LotPatchOptions = {}): string {
  const config = {
    version: LOT_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_LOT_POLL_MS,
    storageKey: LOT_DIM_STORAGE_KEY,
    tint: LOT_DIM_TINT,
    label: DIM_LABEL,
    tooltip: DIM_TOOLTIP,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  ${SHARED}

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function loadDim() {
    try {
      var v = window.localStorage.getItem(CFG.storageKey);
      return v === null ? true : v !== "0";
    } catch (e) { return true; }
  }

  function saveDim(on) {
    try { window.localStorage.setItem(CFG.storageKey, on ? "1" : "0"); } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 持有數
  // -------------------------------------------------------------------------

  /** 獎品對到哪一份 registry 清單。道具不處理，回 null。 */
  function kindOf(item) {
    if (!item) return null;
    if (item.type === 1) return { list: "chara_card", key: "card_id" };
    if (item.type === 2 && item.slot === 0) return { list: "weapon_card", key: "card_id" };
    if (item.type === 2 && item.slot === 2) return { list: "event_card", key: "card_id" };
    if (item.type === 4) return { list: "avatar_parts", key: "parts_id" };
    return null;
  }

  function owned(sc, item) {
    var k = kindOf(item);
    if (!k) return 0;
    var list = null;
    try { list = sc.registry.get(k.list); } catch (e) {}
    var n = 0;
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o && o[k.key] === item.id) {
          n = typeof o.quantity === "number" ? o.quantity : 1;
          break;
        }
      }
    }
    var st = window[FLAG];
    var w = st && st.won[k.list];
    // registry 換過陣列 ＝ 別的場景刷新過，裡面已經含了。
    if (w && w.ref === list) n += w.add[item.id] || 0;
    return n;
  }

  /** 官方回應裡的 result 記下來。 */
  function record(res) {
    var st = window[FLAG];
    if (!st || !res || !res.result || !res.result.length) return;
    var sc = sceneOf("Lot");
    for (var i = 0; i < res.result.length; i++) {
      var item = res.result[i];
      var k = kindOf(item);
      if (!k) continue;
      var list = null;
      try { list = sc ? sc.registry.get(k.list) : null; } catch (e) {}
      var w = st.won[k.list];
      if (!w || w.ref !== list) w = st.won[k.list] = { ref: list, add: {} };
      var amt = typeof item.amount === "number" && item.amount > 0 ? item.amount : 1;
      w.add[item.id] = (w.add[item.id] || 0) + amt;
    }
  }

  function isExclusiveWeapon(sc, id) {
    try {
      var wc = sc.cache.json.get("WeaponCards");
      for (var i = 0; i < wc.length; i++) {
        if (wc[i].id === id) return wc[i].chara !== null && wc[i].chara !== undefined;
      }
    } catch (e) {}
    return false;
  }

  /** CharaCards 的索引：id 找卡、chara 找同一角色的全部卡。json 換了就重建。 */
  function charaIndex(sc) {
    var st = window[FLAG];
    var cc = null;
    try { cc = sc.cache.json.get("CharaCards"); } catch (e) {}
    if (!cc || !cc.length) return null;
    if (st.cc && st.cc.src === cc) return st.cc;
    var byId = {};
    var byChara = {};
    for (var i = 0; i < cc.length; i++) {
      var c = cc[i];
      if (!c) continue;
      byId[c.id] = c;
      (byChara[c.chara] = byChara[c.chara] || []).push(c.id);
    }
    st.cc = { src: cc, byId: byId, byChara: byChara };
    return st.cc;
  }

  /**
   * 角色卡：L 卡（rarity < 6，跟官方 get_item_name 的 card_normal 同一刀）
   * 看整個角色 —— L1..L5、R1..R5 任一張有就調暗。R 卡只看這一張本身。
   */
  function charaDim(sc, item) {
    var ix = charaIndex(sc);
    var card = ix && ix.byId[item.id];
    if (!card) return false;
    if (!(card.rarity < 6)) return owned(sc, item) > 0;
    var ids = ix.byChara[card.chara] || [];
    for (var i = 0; i < ids.length; i++) {
      if (owned(sc, { type: 1, slot: 0, id: ids[i] }) > 0) return true;
    }
    return false;
  }

  function shouldDim(sc, item) {
    if (item.type === 1) return charaDim(sc, item);
    if (item.type === 4) return owned(sc, item) > 0;
    if (item.type === 2 && item.slot === 0) return isExclusiveWeapon(sc, item.id) && owned(sc, item) > 0;
    return false;
  }

  // -------------------------------------------------------------------------
  // 預覽
  // -------------------------------------------------------------------------

  /** 專武的主人 —— WeaponCards.chara（"cc046"）對到 Characters 的在地名字。 */
  function ownerName(sc, id) {
    var chara = null;
    try {
      var wc = sc.cache.json.get("WeaponCards");
      for (var i = 0; i < wc.length; i++) {
        if (wc[i].id === id) { chara = wc[i].chara; break; }
      }
    } catch (e) {}
    if (!chara) return null;
    var ch = null;
    try { ch = sc.cache.json.get("Characters"); } catch (e) {}
    var c = ch && ch[chara];
    if (!c) return null;
    var name = c["name_" + gameLang()];
    if (typeof name === "string" && name.length > 0) return name;
    var ks = Object.keys(c);
    for (var j = 0; j < ks.length; j++) {
      if (ks[j].indexOf("name_") === 0 && ks[j] !== "name_another" &&
          typeof c[ks[j]] === "string" && c[ks[j]].length > 0) return c[ks[j]];
    }
    return null;
  }

  /**
   * 卡右上角的標籤：事件卡與通用武器（黑的槍劍那種，一人一把、重複有用）
   * 標持有數；專武標主人的名字。其他不標，回 null。
   */
  function tagText(sc, item) {
    if (item.type !== 2) return null;
    if (item.slot === 2) return "Own " + owned(sc, item);
    if (item.slot !== 0) return null;
    if (!isExclusiveWeapon(sc, item.id)) return "Own " + owned(sc, item);
    return ownerName(sc, item.id);
  }

  /** 標籤畫在卡名下面、圖的右上角。太寬就縮，不超出卡面。 */
  function ownLabel(sc, c, text) {
    var tag = c.__ulrLot.own;
    if (alive(tag)) {
      if (tag.text !== text) tag.setText(text);
      return;
    }
    tag = sc.add.text(76, -88, text, {
      fontFamily: "font_light",
      fontSize: 18,
      resolution: 2,
      color: "#ffffff"
    }).setOrigin(1, 0);
    try { tag.setPadding(3, 1, 3, 1).setBackgroundColor("rgba(0, 0, 0, 0.75)"); } catch (e) {}
    try { if (tag.width > 150) tag.setScale(150 / tag.width); } catch (e) {}
    c.add(tag);
    c.__ulrLot.own = tag;
  }

  function decorate(sc, key, preview) {
    var st = window[FLAG];
    if (!st || !preview || !preview.sprites) return;
    var data = sc.lot_data && sc.lot_data[key] && sc.lot_data[key].data;
    if (!data) return;
    var cards = [];
    for (var i = 0; i < preview.sprites.length; i++) {
      if (preview.sprites[i] && preview.sprites[i].type === "Container") cards.push(preview.sprites[i]);
    }
    if (cards.length !== data.length) {
      // 對不上就不碰 —— 標錯比不標糟。
      st.reason = key + " 的預覽有 " + cards.length + " 張卡、資料有 " + data.length + " 筆";
      return;
    }
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      var item = data[j];
      if (!c.__ulrLot) c.__ulrLot = { dim: false, own: null };
      var dim = !!st.dim && shouldDim(sc, item);
      if (dim !== c.__ulrLot.dim) {
        c.__ulrLot.dim = dim;
        tintAll(c, dim ? CFG.tint : null);
      }
      var tag = tagText(sc, item);
      if (tag !== null) ownLabel(sc, c, tag);
    }
  }

  /** 目前畫著的預覽全部重來一次（勾選切換時）。 */
  function redecorate(sc) {
    if (!sc || !sc.lot_contents) return;
    var ks = Object.keys(sc.lot_contents);
    for (var i = 0; i < ks.length; i++) {
      var ct = sc.lot_contents[ks[i]];
      if (ct && ct.preview) decorate(sc, ks[i], ct.preview);
    }
  }

  // -------------------------------------------------------------------------
  // 掛鉤
  // -------------------------------------------------------------------------

  /** 場景實例上包一層 create_preview。場景是長命的，裝一次就好。 */
  function hookPreview(sc) {
    if (sc.create_preview && sc.create_preview.__ulrLot) return;
    var orig = sc.create_preview;
    if (typeof orig !== "function") return;
    var wrap = function (key) {
      var res = orig.apply(this, arguments);
      try { decorate(this, key, res); } catch (e) {
        var st = window[FLAG];
        if (st) st.reason = String((e && e.message) || e);
      }
      return res;
    };
    wrap.__ulrLot = true;
    sc.create_preview = wrap;
  }

  /** 每次進暗房官方都開一條新的 socket；抽卡的回應從這裡聽。 */
  function hookSocket(st, sc) {
    var sock = sc.socket;
    if (!sock || typeof sock.fetch !== "function" || sock.fetch.__ulrLot) return;
    var own = Object.prototype.hasOwnProperty.call(sock, "fetch");
    var orig = sock.fetch;
    var wrap = function (name) {
      var p = orig.apply(this, arguments);
      if (name === "lot_start" || name === "lot_select") {
        try {
          p.then(function (r) { try { record(r); } catch (e) {} }, function () {});
        } catch (e) {}
      }
      return p;
    };
    wrap.__ulrLot = true;
    wrap.__ulrOwn = own;
    wrap.__ulrOrig = orig;
    sock.fetch = wrap;
    st.sock = sock;
  }

  /** 「自動選卡」下面那一個勾選。外觀照抄官方的十連抽卡。 */
  function mount(st, sc) {
    var auto = sc.option_auto_check;
    try { if (alive(st.check)) st.check.destroy(); } catch (e) {}
    try { if (alive(st.label)) st.label.destroy(); } catch (e) {}
    try { if (st.tipTween) st.tipTween.destroy(); } catch (e) {}
    try { if (alive(st.tip)) st.tip.destroy(); } catch (e) {}
    st.tip = null;
    st.tipTween = null;
    var cx = auto.getCenter().x;
    var cy = auto.getCenter().y + 18;
    var check = sc.rexUI.add.checkbox({
      x: cx,
      y: cy,
      width: 14,
      height: 14,
      color: 1136286,
      uncheckedColor: 16777215,
      uncheckedBoxFillAlpha: 0.8,
      boxLineWidth: 2,
      animationDuration: 100,
      checked: !!st.dim
    }).setDepth(5).setOrigin(0.5, 0.5);
    var lg = gameLang();
    var label = sc.add.text(check.getTopRight().x + 2, check.getCenter().y,
      CFG.label[lg] || CFG.label.en,
      { fontFamily: "font_light", fontSize: 13, resolution: 2 }).setDepth(5).setOrigin(0, 0.5);
    check.on("valuechange", function (v) {
      var s = window[FLAG];
      if (!s) return;
      s.dim = !!v;
      saveDim(s.dim);
      try { redecorate(sceneOf("Lot")); } catch (e) { s.reason = String((e && e.message) || e); }
    });
    st.check = check;
    st.label = label;
    st.anchor = auto;
    try { label.setInteractive(); } catch (e) {}
    var over = function () { showTip(st, sc, lg); };
    var out = function () { hideTip(st, sc); };
    check.on("pointerover", over);
    check.on("pointerout", out);
    label.on("pointerover", over);
    label.on("pointerout", out);
  }

  /**
   * 滑過勾選或字時的說明框。樣式照抄官方抽卡券 STOCK 的那個
   * （font_light 12、黑底 0.8、padding 2、淡入淡出 300ms），靠右貼在勾選上方。
   */
  function showTip(st, sc, lg) {
    if (!alive(st.check)) return;
    if (!alive(st.tip)) {
      st.tip = sc.add.text(st.label.getTopRight().x, st.check.getTopLeft().y - 4,
        CFG.tooltip[lg] || CFG.tooltip.en,
        { fontFamily: "font_light", fontSize: 12, resolution: 2 }).setOrigin(1, 1).setDepth(6).setAlpha(0);
      try { st.tip.setPadding(2, 2, 2, 2).setBackgroundColor("rgba(0, 0, 0, 0.8)"); } catch (e) {}
    }
    fadeTip(st, sc, 1);
  }

  function hideTip(st, sc) {
    if (alive(st.tip)) fadeTip(st, sc, 0);
  }

  function fadeTip(st, sc, to) {
    try { if (st.tipTween) st.tipTween.destroy(); } catch (e) {}
    st.tipTween = null;
    var tip = st.tip;
    var done = function () {
      st.tipTween = null;
      if (to === 0 && alive(tip)) { tip.destroy(); if (st.tip === tip) st.tip = null; }
    };
    if (sc.tweens && typeof sc.tweens.add === "function") {
      st.tipTween = sc.tweens.add({ targets: tip, alpha: to, duration: 300, ease: "Power3", onComplete: done });
    } else {
      tip.setAlpha(to);
      done();
    }
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var sc = sceneOf("Lot");
      if (!sc) return;
      hookPreview(sc);
      if (!sc.sys || !sc.sys.isActive || !sc.sys.isActive()) return;
      hookSocket(st, sc);
      // 官方的勾選換了一個（＝重新進暗房）就重掛。旗標記在官方物件上的參考，
      // 不記在場景上 —— 場景是長命的。
      if (alive(sc.option_auto_check) && (st.anchor !== sc.option_auto_check || !alive(st.check))) {
        mount(st, sc);
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  var prev = window[FLAG];
  var keepWon = {};
  if (prev) {
    keepWon = prev.won || {};
    teardown(prev);
    delete window[FLAG];
  }

  var st = {
    version: CFG.version,
    dim: loadDim(),
    won: keepWon,
    cc: null,
    check: null,
    label: null,
    tip: null,
    tipTween: null,
    anchor: null,
    sock: null,
    timer: null,
    reason: null
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();
  // 重裝時畫面上可能正開著預覽（上一版的標記剛被拆掉），當場補畫。
  try { redecorate(sceneOf("Lot")); } catch (e) { st.reason = String((e && e.message) || e); }

  return JSON.stringify(statusOf(st));
})()`;
}

export const LOT_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({
        installed: false, version: null, dimOwned: false, mounted: false, won: 0, reason: null
      });
    }
    return JSON.stringify(statusOf(st));
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, dimOwned: false, mounted: false, won: 0,
      reason: String((e && e.message) || e)
    });
  }
})()`;

export const LOT_UNINSTALL_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) return "not-installed";
    teardown(st);
    delete window[FLAG];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/**
 * 把頁面回來的 JSON 讀成 {@link LotStatus}。
 *
 * 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。
 */
export function parseLotStatus(raw: string): LotStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      dimOwned: false,
      mounted: false,
      won: 0,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    dimOwned: o.dimOwned === true,
    mounted: o.mounted === true,
    won: typeof o.won === "number" ? o.won : 0,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
