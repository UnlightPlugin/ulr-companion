/**
 * 商店的購買數量 —— 把「最多 20 個」放寬成檔位表
 * ==============================================
 * 玩家在商店按「購買」→ 跳出確認框 → 點數量鈕 → 下拉選 1..20 → Yes。
 * 一次最多 20 個，買 500 個白色石楠要重複 25 次。
 *
 * ## ⭐ 那個 20 **只存在於客戶端**
 *
 * 2026-09-12 在跑著的客戶端上挖出來的。確認框開啟時的上限算法
 * （`755.js`，`V.Create` 呼叫點前）本來算得很完整：
 *
 * ```js
 *   t = Math.trunc(this.gem / i.price.gem);          // 買得起幾個
 *   for (const s of p.hs) { … 取各種 ccoin 的最小值 … }
 *   null !== i.upper && t > i.upper && (t = i.upper); // 購買上限
 *   …item/other 的特殊上限…
 *   t > 20 && (t = 20);                              // ← 就這一刀
 *   null !== i && "rm" in i && … && (t = 10, …);     // 課金品：另一套，在那刀之後
 *   this.panel = V.Create(this, 430, 309, t);
 * ```
 *
 * 送出的封包是 `socket.emit("shop_buy_steam", id, cate1, cate2, index, buy_quantity)`
 * —— 數量就是一個普通數字。**實測買 21 與 1001 都成功**（gem 與持有數的差額
 * 完全對得上），伺服器沒有 clamp、沒有分批。
 *
 * ## 做法：把 `sc.panel` 換成我們的
 *
 * 官方對數量面板只做三件事：建（`this.panel = V.Create(...)`）、顯
 * （數量鈕 `this.panel.setVisible(true)`）、藏（No / 關閉 `setVisible(false)`）。
 * **換掉 `sc.panel` 這個參考**，後面兩件事就自動操作我們的面板。
 *
 * 點選檔位時**不自己改任何東西** —— 對官方那個面板 `emit("child.down", {name})`，
 * 讓官方自己的 handler 去改 `buy_quantity`、更新 gem/ccoin/cmem 的餘額預覽、
 * 發 `test_quantity_select`。官方 handler 只讀 `e.name`（實測），所以一個
 * `{name: "500"}` 就夠。官方哪天改了預覽邏輯，我們跟著對。
 *
 * ## ⚠ 只放寬「有 GEM 價格」的商品
 *
 * 全店 506 件商品分四種計價（2026-09-12 掃的）：
 *
 * | 計價           | 件數 | 處理                                   |
 * | -------------- | ---- | -------------------------------------- |
 * | GEM            | 133  | 換檔位表                               |
 * | GEM + ccoin    | 9    | 換檔位表（官方已取各幣別最小值）       |
 * | 課金（`rm`）   | 157  | **完全不碰**（`t=10`、單次日幣十萬）   |
 * | 純 cmem（碎片）| 207  | **完全不碰**（`t` 從常數 20 起算）     |
 *
 * 閘門是 `price.gem > 0 && !("rm" in item)`。課金品其實有雙重保險 —— `t=10`
 * 本來就在那刀之後覆寫 —— 但**檔位表若無差別套用仍會動到它**（1..10 會變成
 * 1,2,3,5,7,10），所以閘門不能省。這是使用者直接要求的。
 *
 * ## ⚠ 對帳：算出來的上限要跟官方那份對得上
 *
 * 我們得自己重算 `t`（官方算完就砍成 20，原值不在任何地方）。重算的公式是
 * 照抄的，但官方哪天改了公式我們會靜靜地算錯 —— 所以換面板之前先對帳：
 * 官方面板裡的數字個數必須正好是 `min(t, 20)`。對不上就**不碰**，原因寫進
 * `reason`。寧可少放寬，不能放錯 —— GEM 很難賺，這是使用者的原話。
 *
 * ## 檔位表：`1 2 3 5 7 10 15 20 30 50 100 200 300 500`
 *
 * 只顯示 ≤ `t` 的檔位 —— 跟官方一樣，不夠買 20 個就看不到 20。
 *
 * **沒有「最大」鈕**，會誤選。**沒有輸入框** —— 這遊戲全程只用滑鼠，沒有
 * 打字的習慣。兩個都是使用者否決的。清單最多 14 項，比官方的 20 項短，
 * 面板高度規則照抄（≥10 項就 220px 加捲軸），只會比現在更不需要捲。
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
 */
export const SHOP_SCRIPT_VERSION = 1;

/**
 * 盯著 `sc.panel` 換人沒有的間隔。
 *
 * 比其他補丁的 500ms 短：確認框一開，玩家的下一個動作就是點數量鈕，中間
 * 只有幾百毫秒。就算沒趕上（官方面板先亮了），下一輪會連同「正在顯示」
 * 一起換過去，玩家看到的是清單當場變了一下，不會壞。
 */
export const DEFAULT_SHOP_POLL_MS = 200;

/**
 * 檔位表。使用者 2026-09-12 給的，不要自己增減。
 *
 * ⚠ 沒有「最大」。買得起 4999 個的時候一次誤點就是 999,800 GEM。
 */
export const QUANTITY_TIERS: readonly number[] = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 100, 200, 300, 500,
];

/** 官方那刀的值。對帳用：官方面板裡的數字個數應該正好是 `min(t, 這個)`。 */
export const OFFICIAL_QUANTITY_CAP = 20;

/**
 * 官方數量面板的座標（`V.Create(this, 430, 309, t)`）。
 *
 * ⚠ 這只是**後路**。正常路徑是讀官方那個面板的 `x` / `y` —— 官方挪了位置
 * 我們跟著挪。
 */
const PANEL_X = 430;
const PANEL_Y = 309;

export interface ShopPatchOptions {
  pollIntervalMs?: number;
  /** 檔位表。預設 {@link QUANTITY_TIERS}。 */
  tiers?: readonly number[];
}

export interface ShopStatus {
  installed: boolean;
  version: number | null;
  /** 我們的面板現在掛在 `sc.panel` 上（＝確認框開著而且是 GEM 商品）。 */
  active: boolean;
  /** 最近一次提供的檔位。`[]` = 還沒換過。 */
  tiers: number[];
  /** 最近一次算出的上限（買得起 ∩ 購買上限）。`null` = 還沒算過。 */
  max: number | null;
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
    x: PANEL_X,
    y: PANEL_Y,
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
    putBack(st);
    delete window[FLAG];
  }

  /** 把 sc.panel 還給官方那份，我們的銷毀。 */
  function putBack(st) {
    try {
      var sc = sceneOf("Shop");
      if (sc && st.mine && sc.panel === st.mine && st.orig) sc.panel = st.orig;
    } catch (e) {}
    try { if (st.mine && st.mine.destroy) st.mine.destroy(); } catch (e) {}
    st.mine = null;
    st.orig = null;
  }

  // -------------------------------------------------------------------------
  // 閘門與上限
  // -------------------------------------------------------------------------

  function selectedItem(sc) {
    try { return sc.get_selected_item(); } catch (e) { return null; }
  }

  /**
   * 只放寬「有 GEM 價格」的商品。
   *
   * ⚠ 課金品（rm）、碎片（純 cmem）、活動商店（cate1 === "event"）一律不碰。
   * 課金品的 t=10 其實在官方那刀之後才覆寫，但檔位表若無差別套用仍會把
   * 1..10 變成 1,2,3,5,7,10 —— 閘門不能省。
   */
  function eligible(sc, item) {
    if (!item || !item.price) return false;
    if (sc.select && sc.select.cate1 === "event") return false;
    if (("rm" in item) && item.rm !== undefined && item.rm !== null) return false;
    return item.price.gem > 0;
  }

  /**
   * 官方的上限算法（GEM 分支），照抄，只少了最後那刀 t>20。
   *
   * ccoin 那段跟官方一樣不檢查價格是否為 0：除以 0 得 Infinity，
   * Infinity < t 永遠 false，等於沒限制。
   */
  function officialMax(sc, item) {
    var t = Math.trunc(sc.gem / item.price.gem);
    var coins = sc.data_ccoin || {};
    var ks = Object.keys(coins);
    for (var i = 0; i < ks.length; i++) {
      var e = Math.trunc(coins[ks[i]] / item.price["ccoin" + ks[i]]);
      if (e < t) t = e;
    }
    if (item.upper !== null && item.upper !== undefined && t > item.upper) t = item.upper;
    try {
      var sel = sc.select;
      if (sel && sel.cate1 === "item" && sel.cate2 === "other" &&
          sc.shop.item.other[sel.index].upper !== null) {
        var u = sc.item_other[sel.index].upper;
        if (t > u) t = u;
      }
    } catch (e) {}
    return t;
  }

  /**
   * 官方面板裡有幾個數字。官方用 getByName(name, true) 找子項，我們照用。
   * 名字是 "1".."n" 連號，數到第一個找不到的為止。
   */
  function officialRows(panel) {
    var n = 0;
    try {
      for (var i = 1; i <= CFG.officialCap + 5; i++) {
        if (!panel.getByName(String(i), true)) break;
        n = i;
      }
    } catch (e) { return -1; }
    return n;
  }

  // -------------------------------------------------------------------------
  // 我們的面板 —— 外觀照抄官方的 V.Create / T.Create
  // -------------------------------------------------------------------------

  function build(sc, tiers, orig) {
    var count = tiers.length;
    // 官方：s<10 ? 22*s : 220（超過就加捲軸）
    var h = count < 10 ? 22 * count : 220;
    var scroll = count >= 10;

    var list = sc.rexUI.add.sizer({ width: 20, orientation: "y", space: { item: 0 } });
    for (var i = 0; i < count; i++) {
      var name = String(tiers[i]);
      var label = sc.rexUI.add.label({
        background: sc.rexUI.add.roundRectangle({ color: 16777215 }),
        text: sc.add.text(0, 0, name, { fontStyle: "font_light", color: "black", fontSize: 13 })
          .setResolution(2),
        space: { left: 5, right: 5, top: 5, bottom: 5 },
        name: name
      });
      list.add(label, { expand: true });
    }

    var x = orig && typeof orig.x === "number" ? orig.x : CFG.x;
    var y = orig && typeof orig.y === "number" ? orig.y : CFG.y;

    var panel = sc.rexUI.add.scrollablePanel({
      x: x, y: y, height: h, scrollMode: 0,
      background: sc.rexUI.add.roundRectangle({ strokeColor: 12040892, strokeWidth: 2 }),
      panel: { child: list },
      slider: {
        track: sc.rexUI.add.roundRectangle({ width: 13, height: 20, radius: 5, color: 7895676 }),
        thumb: sc.add.sprite(400, 300, "scrollbar").setVisible(scroll)
      },
      space: { panel: 0 },
      mouseWheelScroller: { focus: false, speed: 0.5 }
    }).setOrigin(0.5, 0).setDepth(2001).layout();

    try { panel.scrollToChild(panel.getByName(String(tiers[0]), true)); } catch (e) {}
    panel.setChildrenInteractive({});
    panel.on("child.over", function (c) {
      try { var bg = c.getElement("background"); bg.setStrokeStyle(1, 16711680); bg.fillColor = 16744319; } catch (e) {}
    });
    panel.on("child.out", function (c) {
      try { var bg = c.getElement("background"); bg.setStrokeStyle(); bg.fillColor = 16777215; } catch (e) {}
    });
    panel.on("child.down", function (c) {
      pick(sc, panel, c && c.name);
    });
    return panel;
  }

  /**
   * 玩家點了一個檔位。
   *
   * 交給官方那個面板的 handler：它會改 buy_quantity、更新餘額預覽、
   * 發 test_quantity_select，還會把它自己藏起來（本來就藏著，無妨）。
   * 我們只負責把自己收起來。
   */
  function pick(sc, mine, name) {
    var st = window[FLAG];
    if (!st || name === undefined || name === null) return;
    var handed = false;
    try {
      if (st.orig && typeof st.orig.emit === "function") {
        st.orig.emit("child.down", { name: String(name) });
        handed = true;
      }
    } catch (e) {
      st.reason = "官方的數量 handler 丟例外：" + String((e && e.message) || e);
    }
    if (!handed) {
      // 後路：官方面板不在了。只改最低限度的兩樣，預覽不動。
      try { sc.buy_quantity = Number(name); } catch (e) {}
      try { if (sc.btn_panel_text) sc.btn_panel_text.setText(String(name)); } catch (e) {}
    }
    try { mine.setVisible(false); } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var sc = sceneOf("Shop");
      if (!sc) return;
      var p = sc.panel;
      if (!p || p === st.mine || p === st.seen) return;
      if (!alive(p)) return;
      st.seen = p;

      // 官方剛建了一個新的（＝玩家剛按了購買）。我們上一份收掉。
      if (st.mine) {
        try { st.mine.destroy(); } catch (e) {}
        st.mine = null;
        st.orig = null;
      }

      var item = selectedItem(sc);
      if (!eligible(sc, item)) {
        st.reason = null;
        return;
      }

      var t = officialMax(sc, item);
      var rows = officialRows(p);
      var expect = Math.min(t, CFG.officialCap);
      if (rows !== expect) {
        // 對不上就不碰 —— 寧可少放寬，不能放錯。
        st.reason = "上限對帳不符：官方面板 " + rows + " 個，我們算 " + t + "（預期 " + expect + "）";
        return;
      }

      var tiers = [];
      for (var i = 0; i < CFG.tiers.length; i++) {
        if (CFG.tiers[i] <= t) tiers.push(CFG.tiers[i]);
      }
      if (tiers.length === 0) return;

      var mine = build(sc, tiers, p);
      mine.setVisible(!!p.visible);
      p.setVisible(false);
      sc.panel = mine;
      st.mine = mine;
      st.orig = p;
      st.tiers = tiers;
      st.max = t;
      st.reason = null;
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    mine: null,
    orig: null,
    seen: null,
    tiers: [],
    max: null,
    timer: null,
    reason: null
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    active: alive(st.mine),
    tiers: st.tiers,
    max: st.max,
    reason: st.reason
  });
})()`;
}

export const SHOP_STATUS_EXPRESSION = `(function () {
  "use strict";
  ${SHARED}
  try {
    var st = window[FLAG];
    if (!st) {
      return JSON.stringify({
        installed: false, version: null, active: false, tiers: [], max: null, reason: null
      });
    }
    return JSON.stringify({
      installed: true,
      version: st.version,
      active: alive(st.mine),
      tiers: st.tiers || [],
      max: st.max,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, active: false, tiers: [], max: null,
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
    try {
      var sc = sceneOf("Shop");
      if (sc && st.mine && sc.panel === st.mine && st.orig) sc.panel = st.orig;
    } catch (e) {}
    try { if (st.mine && st.mine.destroy) st.mine.destroy(); } catch (e) {}
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
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
