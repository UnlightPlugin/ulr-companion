/**
 * 商店的購買數量 —— 把「最多 20 個」放寬成檔位表
 * ==============================================
 * 玩家在商店按「購買」→ 跳出確認框 → 點數量下拉 → 選 1..20 → ok。
 * 一次最多 20 個，買 500 個白色石楠要重複 25 次。
 *
 * ## ⚠ 伺服器也有 20 了 —— 所以要分批送
 *
 * 2026-09-12（改版前）實測買 21 與 1001 都成功，那時 20 只存在於客戶端。
 * **2026-09-23 改版後伺服器也 clamp 到 20，而且是安靜的**：2026-09-26 送
 * `shop_buy(6622, 21)` 回 `{error: null, rm_process: null}`（＝成功），gem 卻只扣
 * 20×540、持有只 +20。只看回應會以為買了 21。
 *
 * 所以放寬下拉之外，還要把 ok 送出的那一個 `shop_buy` **拆成每批 ≤20 依序送**
 * （使用者 2026-09-26 同意多送請求）。做法見下面「分批」。
 *
 * ## 2026-09-23 改版後的形狀（v2）
 *
 * 改版把 Shop 場景整個重寫了：v1 盯的 `sc.panel`、`get_selected_item`、
 * `V.Create` 全都不見了。現在（2026-09-26 從跑著的客戶端挖的）：
 *
 * ```js
 *   get_max_purchase(t) {
 *     let e = [20];                                  // ← 那刀換成陣列的第一個元素
 *     t.price.gem > 0 && e.push(trunc(money.gem / t.price.gem));
 *     …item_10001..item_10111 同樣各推一個…
 *     …單件頭像零件／貼圖：已有推 0、沒有推 1…
 *     t.upper !== null && e.push(upper - 已買數);
 *     return Math.min(...e);
 *   }
 *   create_purchase_screen(t) {
 *     const i = this.get_max_purchase(t);
 *     for (E = 0; E < max(i, 1); E++) o[E] = { text: "" + (E+1), value: E+1 };
 *     d = this.rexUI.add.dropDownList({ options: o, list: { onButtonClick: …
 *           n.quantity = option.value; 更新餘額預覽 … } });
 *     ok → this.socket.fetch("shop_buy", n.id, n.quantity)
 *   }
 * ```
 *
 * 選項陣列 `o` 是區域變數，但 dropDownList 有 `setOptions()`，清單是點開時才
 * 照 `options` 現建的 —— 所以**在官方建完確認框之後把選項換掉**就好。點選
 * 走的還是官方的 `onButtonClick`，它只讀 `option.value`，數量、餘額預覽、
 * 送出的封包全是官方自己算的。
 *
 * ## 做法：包一層 `create_purchase_screen`
 *
 * 在 Shop 場景的實例上蓋一個同名方法（原型上那支不動），進去先照官方跑完，
 * 再從這次新增的顯示物件裡找出那個 dropDownList 換選項。場景物件是長命的，
 * 但保險起見輪詢檢查「現在那支還是不是我們的」，不是就重包。
 *
 * ## 分批：包一層 `socket.fetch`
 *
 * ok 鈕的 handler 是區域閉包，碰不到；它做的事是
 * `t = await this.socket.fetch("shop_buy", id, quantity)`，然後
 * `error === null && rm_process === null` 就 `show_dialogue_success()`（重抓
 * player / 持有數、跳成功框），否則 `shop_error(error)`。
 *
 * 所以在 socket 物件上蓋一支 `fetch`：只有「`shop_buy`、商品是剛才我們換過
 * 下拉的那件、數量 > 20」才接手，其餘原樣放行。接手後依序送
 * `shop_buy(id, ≤20)`，全部成功就回一個成功形狀給官方 handler，官方自己
 * 重抓資料、跳成功框。
 *
 * - **一定要依序。** 官方的 fetch 用 `once(事件名)` 對回應，同名請求並行會搶。
 * - **任何一批失敗就停。** 一批都沒買到 → 把那個失敗回應原樣交回（官方跳
 *   錯誤框）；買到一部分 → 回成功形狀讓官方重抓資料（畫面上的 GEM 與持有數
 *   才是對的），短少寫進 `reason`。
 * - **數量超過開框時算的上限就一個都不送**，回官方的通用錯誤。
 * - **對帳搭官方的重抓**：成功框重抓 player 之後，輪詢比對 gem 實扣與預期，
 *   結果放在 `lastBuy`。不為了驗證多送請求。
 *
 * ## ⚠ 只放寬「有 GEM 價格」的商品
 *
 * 全店 504 件（2026-09-26 掃的）：`price.gem > 0` 的 141 件、課金
 * `price.rm > 0` 的 158 件、碎片 `price.item_10011 > 0` 的 199 件。
 * 閘門是 `price.gem > 0 && !(price.rm > 0) && !(price.point > 0)`。
 * 課金品、碎片、活動點數商品一律不碰 —— 使用者直接要求的。
 *
 * ## ⚠ 對帳：算出來的上限要跟官方那份對得上
 *
 * 官方算完就砍成 20，原值不在任何地方，所以要自己重算。但只在**官方回 20**
 * 的時候才需要：官方回的數字 < 20 表示那刀沒作用，真正的上限就是它。
 * 回 20 時頭像零件／貼圖那兩條不可能在作用（它們只推 0 或 1），剩下的
 * 就是「各幣別買得起幾個」與「upper − 已買」，照抄重算。
 *
 * 重算出來 < 20 表示官方公式變了 —— **不碰**，原因寫進 `reason`。官方下拉的
 * 選項數也必須正好是 `max(官方上限, 1)`。寧可少放寬，不能放錯 —— GEM 很難賺，
 * 這是使用者的原話。
 *
 * ## 檔位表：`1 2 3 5 7 10 15 20 30 50 100 200 300 500`
 *
 * 只顯示 ≤ 上限的檔位 —— 跟官方一樣，不夠買 20 個就看不到 20。
 *
 * **沒有「最大」鈕**，會誤選。**沒有輸入框** —— 這遊戲全程只用滑鼠，沒有
 * 打字的習慣。兩個都是使用者否決的。
 *
 * ## 專武：「使用場所」那格填角色名
 *
 * 詳細面板左欄的「使用場所」是 `create` 裡建一次的 `this.item_place`（"-"），
 * 官方之後**從來不更新它** —— 武器永遠顯示「-」。2026-10-02 使用者選了把專武
 * 的角色名填在這格（版面、字型、對齊全用官方那個 Text，零改動）。
 *
 * 資料是客戶端自己的：`cache.json.get("WeaponCards")[].chara`（如毒鐵線 →
 * `"cc022"`），對 `cache.json.get("Characters")["cc022"].name_<lang>` 就是
 * 「薩爾卡多」。不送請求。2026-10-02 掃的 238 把：207 把對得到角色、26 把
 * `null`（妖魔短劍那類通用）、5 把 `"cc000"`（魔之刀身那類素材），後兩種照舊「-」。
 *
 * 做法跟購買框一樣：在場景實例上包 `show_detail`（點格子、買完重抓都走它），
 * 官方跑完再補寫 `item_place`。判斷商品是武器照抄官方 `get_item_info`：
 * `item[0].type === TG_SLOT_CARD(2)` 且 `slot === WEAPON_CARD(0)`。常數是從
 * ShopData 反推的，保險起見再對一次**官方顯示出來的名字就是那把武器的名字**，
 * 對不上就留「-」—— 寧可不標，不能標錯。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。詳細的東西寫在這個檔頭。
 */

import { embedJson } from "./embed.js";

/** 頁面上掛狀態的地方。跟 `__ulrPresent` / `__ulrLobby` 同一族。 */
const FLAG = "__ulrShop";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 跟 `patch-present` 一樣是「先拆再裝」，版本號是回報用的。
 *
 * 2：2026-09-23 改版後重寫，改包 `create_purchase_screen`。
 * 3：伺服器也截在 20，改成分批送（包 `socket.fetch`）。
 * 4：專武 —— 包 `show_detail`，「使用場所」填角色名。
 */
export const SHOP_SCRIPT_VERSION = 4;

/**
 * 商品 `item[0]` 是武器卡的 type / slot（官方 `p.Nt.TG_SLOT_CARD` 與
 * `p.x$[slot] === "WEAPON_CARD"`）。模組常數碰不到，2026-10-02 從 ShopData
 * 反推：type 2 slot 0 的 15 件全是武器、type 2 slot 2 的 36 件全是事件卡。
 */
export const SHOP_WEAPON_ITEM = { type: 2, slot: 0 } as const;

/**
 * 檢查「Shop 場景上那支 `create_purchase_screen` 還是不是我們包的」的間隔。
 *
 * 包裝是裝在方法上的，玩家按購買時一定走得到，不用搶時間。這個輪詢只是
 * 應付場景還沒建（剛接上遊戲時可能還在登入畫面）或被換掉的情況。
 */
export const DEFAULT_SHOP_POLL_MS = 500;

/**
 * 檔位表。使用者 2026-09-12 給的，不要自己增減。
 *
 * ⚠ 沒有「最大」。買得起 4999 個的時候一次誤點就是 999,800 GEM。
 */
export const QUANTITY_TIERS: readonly number[] = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 100, 200, 300, 500,
];

/**
 * 官方那刀的值，也是伺服器一次肯給的上限。對帳用（官方上限應該正好是
 * `min(我們算的, 這個)`），也是分批時每批的大小。
 */
export const OFFICIAL_QUANTITY_CAP = 20;

export interface ShopPatchOptions {
  pollIntervalMs?: number;
  /** 檔位表。預設 {@link QUANTITY_TIERS}。 */
  tiers?: readonly number[];
}

export interface ShopStatus {
  installed: boolean;
  version: number | null;
  /** 我們換過選項的那個數量下拉還活著（＝確認框開著而且是 GEM 商品）。 */
  active: boolean;
  /** 最近一次提供的檔位。`[]` = 還沒換過。 */
  tiers: number[];
  /** 最近一次算出的上限（買得起 ∩ 購買上限）。`null` = 還沒算過。 */
  max: number | null;
  /** 最近一次分批購買。`null` = 還沒分批買過。 */
  lastBuy: ShopBatchResult | null;
  reason: string | null;
}

export interface ShopBatchResult {
  /** 玩家選的數量。 */
  requested: number;
  /** 伺服器回成功的批次加起來的數量。 */
  bought: number;
  /** 送了幾批。 */
  batches: number;
  /** 照 `bought` 算的預期 gem 變化（負數）。 */
  expectedGemDelta: number;
  /** 官方重抓 player 之後看到的實際 gem 變化。`null` = 還沒重抓到。 */
  gemDelta: number | null;
  /** `gemDelta === expectedGemDelta`。`null` = 還沒重抓到。 */
  verified: boolean | null;
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

  /** 物件自己身上的 key 是我們蓋的包裝，就還原（原本沒有自己的就刪掉）。 */
  function unhook(obj, key, ownOrig) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key) &&
        obj[key] && obj[key].__ulrShopWrap) {
      if (ownOrig) obj[key] = ownOrig;
      else delete obj[key];
    }
  }

  /**
   * 把我們蓋的 create_purchase_screen、show_detail 與 socket.fetch 拿掉，露出原型
   * 上那支。使用場所那格還原成官方的「-」。
   */
  function unwrap(st) {
    try { unhook(st.scene, "create_purchase_screen", st.ownOrig); } catch (e) {}
    try { unhook(st.scene, "show_detail", st.detailOwnOrig); } catch (e) {}
    try {
      var place = st.scene && st.scene.item_place;
      if (alive(place) && place.text !== "-") place.setText("-");
    } catch (e) {}
    try { unhook(st.socket, "fetch", st.socketOwnOrig); } catch (e) {}
    st.scene = null;
    st.ownOrig = null;
    st.detailOwnOrig = null;
    st.socket = null;
    st.socketOwnOrig = null;
    st.pending = null;
  }

  function statusOf(st) {
    return JSON.stringify({
      installed: true,
      version: st.version,
      active: alive(st.dd),
      tiers: st.tiers || [],
      max: st.max,
      lastBuy: st.lastBuy ? {
        requested: st.lastBuy.requested,
        bought: st.lastBuy.bought,
        batches: st.lastBuy.batches,
        expectedGemDelta: st.lastBuy.expectedGemDelta,
        gemDelta: st.lastBuy.gemDelta,
        verified: st.lastBuy.verified
      } : null,
      reason: st.reason
    });
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 */
export function buildShopPatchScript(options: ShopPatchOptions = {}): string {
  const tiers = [...(options.tiers ?? QUANTITY_TIERS)]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  const config = {
    version: SHOP_SCRIPT_VERSION,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_SHOP_POLL_MS,
    tiers,
    officialCap: OFFICIAL_QUANTITY_CAP,
    weaponItem: SHOP_WEAPON_ITEM,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  ${SHARED}

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** v1 留下的也拆得掉。 */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    unwrap(st);
    delete window[FLAG];
  }

  // -------------------------------------------------------------------------
  // 閘門與上限
  // -------------------------------------------------------------------------

  /** 只放寬「有 GEM 價格」的商品。課金、碎片、活動點數一律不碰。 */
  function eligible(item) {
    var p = item && item.price;
    if (!p) return false;
    if (p.rm > 0) return false;
    if (p.point > 0) return false;
    return p.gem > 0;
  }

  /**
   * 官方回 20 時的真正上限：各幣別買得起幾個、upper 減已買，取最小。
   * 算不出來（缺餘額欄位）回 null。
   */
  function realMax(sc, item) {
    var money = sc.get_money();
    var t = Infinity;
    var ks = Object.keys(item.price);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      if (k === "rm" || k === "point") continue;
      var price = item.price[k];
      if (!(price > 0)) continue;
      if (typeof money[k] !== "number") return null;
      var n = Math.trunc(money[k] / price);
      if (n < t) t = n;
    }
    if (item.upper !== null && item.upper !== undefined) {
      var u = item.upper;
      var cfg = sc.shop_config || [];
      for (var j = 0; j < cfg.length; j++) {
        if (cfg[j] && cfg[j].shop_id === item.id) { u -= cfg[j].quantity; break; }
      }
      if (u < t) t = u;
    }
    return t === Infinity ? null : t;
  }

  /** 這次新增的顯示物件裡找數量下拉：有 setOptions、有 options 陣列的那個。 */
  function findDropDown(sc, before) {
    var list = (sc.children && sc.children.list) || [];
    var found = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (before.indexOf(o) !== -1) continue;
      if (o && typeof o.setOptions === "function" && Array.isArray(o.options)) found.push(o);
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // 包裝
  // -------------------------------------------------------------------------

  /**
   * 官方先跑完，再把數量下拉的選項換成檔位。任何一步對不上就維持官方原樣。
   * 點選走的是官方的 onButtonClick，它只讀 option.value。
   */
  function wrap(orig) {
    var w = function (item) {
      var st = window[FLAG];
      var sc = this;
      if (st) st.pending = null;
      if (!st || !eligible(item)) return orig.apply(sc, arguments);

      var official, real = null;
      try {
        official = sc.get_max_purchase(item);
        if (official === CFG.officialCap) real = realMax(sc, item);
        else real = official;
      } catch (e) {
        st.reason = "算上限時丟例外：" + String((e && e.message) || e);
        return orig.apply(sc, arguments);
      }

      var before = ((sc.children && sc.children.list) || []).slice();
      var ret = orig.apply(sc, arguments);

      try {
        if (typeof real !== "number" || Math.min(real, CFG.officialCap) !== official) {
          // 對不上就不碰 —— 寧可少放寬，不能放錯。
          st.reason = "上限對帳不符：官方 " + official + "，我們算 " + real;
          return ret;
        }
        var dds = findDropDown(sc, before);
        if (dds.length !== 1) {
          st.reason = "找數量下拉：這次新增了 " + dds.length + " 個";
          return ret;
        }
        var dd = dds[0];
        if (dd.options.length !== Math.max(official, 1)) {
          st.reason = "官方下拉有 " + dd.options.length + " 個選項，預期 " + Math.max(official, 1);
          return ret;
        }
        var tiers = [];
        for (var i = 0; i < CFG.tiers.length; i++) {
          if (CFG.tiers[i] <= real) tiers.push(CFG.tiers[i]);
        }
        if (tiers.length === 0) { st.reason = null; return ret; }
        dd.setOptions(tiers.map(function (n) { return { text: String(n), value: n }; }));
        // 這個確認框按 ok 送出的 shop_buy 由分批接手
        st.pending = { id: item.id, max: real, gem: item.price.gem };
        st.dd = dd;
        st.tiers = tiers;
        st.max = real;
        st.reason = null;
      } catch (e) {
        st.reason = String((e && e.message) || e);
      }
      return ret;
    };
    w.__ulrShopWrap = CFG.version;
    return w;
  }

  /** 官方 ok 的通用失敗：shop_error 找不到這個鍵就顯示 DEFAULT 訊息。 */
  function refusal() {
    return { error: "DEFAULT", rm_process: null };
  }

  /**
   * 包 socket.fetch：只接手「剛換過下拉的那件商品、數量 > 20」的 shop_buy，
   * 拆成每批 ≤20 依序送。其餘原樣放行。
   */
  function wrapFetch(orig) {
    var w = function (name, id, qty) {
      var st = window[FLAG];
      var p = st && st.pending;
      if (!p || name !== "shop_buy" || id !== p.id || !(qty > CFG.officialCap)) {
        return orig.apply(this, arguments);
      }
      st.pending = null; // 一個確認框只接手一次
      if (Math.floor(qty) !== qty || qty > p.max) {
        st.reason = "數量 " + qty + " 超過開框時算的上限 " + p.max + "，一個都沒送";
        return Promise.resolve(refusal());
      }
      return batch(this, orig, st, p, qty);
    };
    w.__ulrShopWrap = CFG.version;
    return w;
  }

  async function batch(sock, orig, st, p, total) {
    var sc = st.scene;
    var player = sc && sc.player;
    var rec = {
      requested: total,
      bought: 0,
      batches: 0,
      expectedGemDelta: 0,
      gemDelta: null,
      verified: null,
      gemBefore: player ? player.gem : null,
      playerRef: player || null
    };
    st.lastBuy = rec;
    st.reason = null;
    var fail = null, thrown = null;
    while (rec.bought < total) {
      var n = Math.min(CFG.officialCap, total - rec.bought);
      var res;
      try {
        res = await orig.call(sock, "shop_buy", p.id, n);
      } catch (e) {
        thrown = e;
        break;
      }
      rec.batches++;
      if (!res || res.error !== null || res.rm_process !== null) { fail = res; break; }
      rec.bought += n;
      rec.expectedGemDelta = -p.gem * rec.bought;
    }
    if (rec.bought === total) return { error: null, rm_process: null };
    if (rec.bought === 0) {
      st.lastBuy = null;
      if (thrown) throw thrown;
      return fail || refusal();
    }
    // 買到一部分：回成功形狀，讓官方重抓 GEM 與持有數，畫面才是對的
    var why = thrown ? String((thrown && thrown.message) || thrown) : JSON.stringify(fail);
    st.reason = "分批只買到 " + rec.bought + " / " + total + " 個就停了：" + why;
    return { error: null, rm_process: null };
  }

  /** 官方成功框重抓 player 之後，比對 gem 實扣與預期。不多送請求。 */
  function verify(st, sc) {
    var rec = st.lastBuy;
    if (!rec || rec.verified !== null || rec.gemBefore === null) return;
    var player = sc.player;
    if (!player || typeof player.gem !== "number") return;
    if (player === rec.playerRef && player.gem === rec.gemBefore) return; // 還沒重抓
    rec.gemDelta = player.gem - rec.gemBefore;
    rec.verified = rec.gemDelta === rec.expectedGemDelta;
    if (!rec.verified) {
      st.reason = "分批對帳不符：gem 實際 " + rec.gemDelta + "，預期 " + rec.expectedGemDelta;
    }
  }

  // -------------------------------------------------------------------------
  // 專武：使用場所那格填角色名
  // -------------------------------------------------------------------------

  /** 商品是一把武器就回那把的 WeaponCards 資料，否則 null。照抄官方 get_item_info 的判斷。 */
  function weaponOf(sc, item) {
    var it = item && item.item && item.item[0];
    if (!it || it.type !== CFG.weaponItem.type || it.slot !== CFG.weaponItem.slot) return null;
    var cards = sc.cache.json.get("WeaponCards") || [];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] && cards[i].id === it.id) return cards[i];
    }
    return null;
  }

  /** 使用場所該顯示的字：專武是角色名，其餘一律官方的「-」。 */
  function placeText(sc, item) {
    var w = weaponOf(sc, item);
    if (!w || !w.chara) return "-";
    var key = "name_" + window.lang;
    var chara = (sc.cache.json.get("Characters") || {})[w.chara];
    var name = chara && chara[key];
    if (typeof name !== "string" || name === "") return "-";
    // 常數是反推的：官方顯示的名字必須就是這把武器（數量大於 1 會接 " xN"）
    var shown = sc.get_item_info(item).item_name;
    if (typeof w[key] !== "string" || w[key] === "" || String(shown).indexOf(w[key]) !== 0) return "-";
    return name;
  }

  function applyPlace(sc) {
    var place = sc.item_place;
    if (!alive(place)) return;
    var shop = window.game.registry && window.game.registry.get("ShopData");
    var item = null;
    for (var i = 0; shop && i < shop.length; i++) {
      if (shop[i] && shop[i].id === sc.shop_select) { item = shop[i]; break; }
    }
    var s = item ? placeText(sc, item) : "-";
    if (place.text !== s) place.setText(s);
  }

  /** 官方先跑完，再補寫使用場所。我們這段出錯不影響官方。 */
  function wrapDetail(orig) {
    var w = function () {
      var ret = orig.apply(this, arguments);
      try {
        applyPlace(this);
      } catch (e) {
        var st = window[FLAG];
        if (st) st.reason = "專武：" + String((e && e.message) || e);
      }
      return ret;
    };
    w.__ulrShopWrap = CFG.version;
    return w;
  }

  function hookDetail(st, sc) {
    var f = sc.show_detail;
    if (typeof f !== "function" || f.__ulrShopWrap) return;
    st.detailOwnOrig = Object.prototype.hasOwnProperty.call(sc, "show_detail") ? f : null;
    sc.show_detail = wrapDetail(f);
    // 裝上時面板可能已經停在某把武器上（重裝會先被拆成「-」）
    if (sc.shop_select !== null && sc.shop_select !== undefined) applyPlace(sc);
  }

  // -------------------------------------------------------------------------
  // 主迴圈：確保 Shop 場景上那幾支是我們包的
  // -------------------------------------------------------------------------

  function hookSocket(st, sc) {
    var s = sc.socket;
    if (!s || typeof s.fetch !== "function") return;
    if (st.socket === s && s.fetch.__ulrShopWrap) return;
    if (s.fetch.__ulrShopWrap) return; // 舊的我們包的，restore 應該已經拆了；不疊第二層
    if (st.socket && st.socket !== s) {
      try { unhook(st.socket, "fetch", st.socketOwnOrig); } catch (e) {}
    }
    st.socketOwnOrig = Object.prototype.hasOwnProperty.call(s, "fetch") ? s.fetch : null;
    st.socket = s;
    s.fetch = wrapFetch(s.fetch);
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var sc = sceneOf("Shop");
      if (!sc) return;
      verify(st, sc);
      var f = sc.create_purchase_screen;
      if (!(f && f.__ulrShopWrap && st.scene === sc)) {
        if (typeof f !== "function" || typeof sc.get_max_purchase !== "function" ||
            typeof sc.get_money !== "function") {
          st.reason = "Shop 場景的形狀變了：找不到 create_purchase_screen / get_max_purchase / get_money";
          return;
        }
        if (f.__ulrShopWrap) return; // 別人（舊的我們）包的，restore 應該已經拆了；不疊第二層
        if (st.scene && st.scene !== sc) unwrap(st);
        st.ownOrig = Object.prototype.hasOwnProperty.call(sc, "create_purchase_screen") ? f : null;
        st.scene = sc;
        sc.create_purchase_screen = wrap(f);
      }
      hookSocket(st, sc);
      hookDetail(st, sc);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    scene: null,
    ownOrig: null,
    detailOwnOrig: null,
    socket: null,
    socketOwnOrig: null,
    pending: null,
    dd: null,
    tiers: [],
    max: null,
    lastBuy: null,
    timer: null,
    reason: null
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return statusOf(st);
})()`;
}

export const SHOP_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({
        installed: false, version: null, active: false, tiers: [], max: null, lastBuy: null,
        reason: null
      });
    }
    return statusOf(st);
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, active: false, tiers: [], max: null, lastBuy: null,
      reason: String((e && e.message) || e)
    });
  }
})()`;

export const SHOP_UNINSTALL_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    unwrap(st);
    delete window[FLAG];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/**
 * 把頁面回來的 JSON 讀成 {@link ShopStatus}。
 *
 * 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。
 */
export function parseShopStatus(raw: string): ShopStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      active: false,
      tiers: [],
      max: null,
      lastBuy: null,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const tiers = Array.isArray(o.tiers)
    ? o.tiers.filter((n): n is number => typeof n === "number")
    : [];
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    active: o.active === true,
    tiers,
    max: typeof o.max === "number" ? o.max : null,
    lastBuy: parseBatch(o.lastBuy),
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

function parseBatch(value: unknown): ShopBatchResult | null {
  if (value === null || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const requested = num(b.requested);
  const bought = num(b.bought);
  if (requested === null || bought === null) return null;
  return {
    requested,
    bought,
    batches: num(b.batches) ?? 0,
    expectedGemDelta: num(b.expectedGemDelta) ?? 0,
    gemDelta: num(b.gemDelta),
    verified: typeof b.verified === "boolean" ? b.verified : null,
  };
}
