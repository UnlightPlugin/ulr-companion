/**
 * 牌組編輯畫面標題列的「自訂 COST ↔ 官方 COST」滑動開關
 * =====================================================
 * 玩家在牌組編輯畫面想看「這副牌在官方規則下是幾 C」，原本得去托盤按停用、
 * 重載遊戲、看完再開回來、再重載一次。這支把它變成畫面上一顆開關：
 *
 * ```
 *   DeckEdit  (?)   COST  [●    ] 官方        ← 往左：官方價格、官方罰則
 *   DeckEdit  (?)   COST  [    ●] 自訂        ← 往右：插件自訂 COST 表（含罰則）
 *   ┌──────────┬──────────┬──────────┬…
 *   │Character │ Monster  │Equipment │
 * ```
 *
 * 位置是標題「DeckEdit」與 (?) 右邊那段空白（2026-09-12 實機量：標題 Text
 * 在 (0,15) 寬 76、tut_icon 在 (96,15)、分頁列在 y=43 —— 中間 y=15 這一列從
 * x≈120 起到 back_btn 之前都是空的）。
 *
 * ## ⚠ 這支只畫開關，**不決定價格**
 *
 * 點下去只回報 `{ type: "cost-toggle", enabled }`。真正把數字換掉的是
 * Node：`patch-cost.ts` 的 `setEnabled()`（價格）＋ `patch-penalty.ts` 的
 * 裝／拆（罰則），兩件事一起切。然後 Node 再把確定的狀態推回來畫。
 * 頁面端不自己存「現在是哪一邊」的真相 —— 存了就有兩份，而它們一定會
 * 不同步（跟 `patch-deck-edit` 同一條規矩）。
 *
 * 不過**旋鈕會先動**（樂觀更新）：點下去到 Node 回推之間有幾十毫秒，旋鈕
 * 不動的話玩家會再點一次，於是切了兩下等於沒切。
 *
 * ## 沒選規則就不畫
 *
 * `available: false` 時整顆開關不出現。沒有自訂表可切的時候，一顆永遠停在
 * 「官方」的開關只會讓人以為插件壞了。
 *
 * ## ⚠ Edit 場景每次進來都重新 create
 *
 * 跟 `patch-deck-edit` 一樣：輪詢（500ms）盯著「Edit 是不是 active 而且我們
 * 的東西已經死了」，是的話重掛。**不能只在安裝時掛一次**。
 *
 * ## 文案
 *
 * 面板上只有兩個字（≤8 字那條規矩），說明走 hover tooltip。左邊的「COST」
 * 每種語言都一樣 —— 遊戲自己在同一個畫面把 Total Cost / CharacterCard Cost
 * 全寫成英文。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrCostToggle";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 *
 * 跟 `patch-present` 一樣是「先拆再裝」，版本號是回報用的。
 */
export const COST_TOGGLE_SCRIPT_VERSION = 2;

export const DEFAULT_COST_TOGGLE_POLL_MS = 500;

/** Node 推給頁面的狀態。**畫面上的每一個字都由這裡決定。** */
export interface CostToggleState {
  /** 有沒有自訂表可以切。`false` = 整顆不畫。 */
  available: boolean;
  /** 現在畫面上套的是自訂表（true，旋鈕在右）還是官方（false，旋鈕在左）。 */
  enabled: boolean;
}

/** 玩家點了開關。`enabled` 是他**想要**的那一邊。 */
export interface CostToggleReport {
  type: "cost-toggle";
  enabled: boolean;
}

export function isCostToggleReport(value: unknown): value is CostToggleReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cost-toggle" &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}

export interface CostToggleStatus {
  installed: boolean;
  version: number | null;
  /** 開關真的畫在畫面上了沒（玩家在 Edit 畫面、而且有規則可切）。 */
  mounted: boolean;
  /** 頁面上現在畫的是哪一邊。沒裝是 `null`。 */
  enabled: boolean | null;
  reason: string | null;
}

export interface CostTogglePatchOptions {
  bindingName: string;
  state: CostToggleState;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 旋鈕右邊那兩個字。
 *
 * 匯出是給 `patch-deck-edit` 的牌組選單用的 —— 那裡每一副牌旁邊寫的
 * 「官方 110 自訂 106」得跟這顆開關用**同一組字**，玩家才對得起來。
 */
export const SIDE_LABEL: Record<string, { on: string; off: string }> = {
  ja: { on: "カスタム", off: "公式" },
  en: { on: "Custom", off: "Official" },
  kr: { on: "커스텀", off: "공식" },
  scn: { on: "自定义", off: "官方" },
  tcn: { on: "自訂", off: "官方" },
};

/** hover 才出現的說明。 */
const TOOLTIP: Record<string, string> = {
  ja: "右：プラグインのカスタムCOST　左：公式COST",
  en: "Right: plugin custom COST   Left: official COST",
  kr: "오른쪽: 플러그인 커스텀 COST   왼쪽: 공식 COST",
  scn: "右：插件自定义COST　左：官方COST",
  tcn: "右：插件自訂COST　左：官方COST",
};

/**
 * 版面。畫布 760×680，標題列 y=15。
 *
 * 軌道 36×14、旋鈕半徑 6，兩端各留 1px。這些不是設計出來的，是「塞得進
 * tut_icon 與分頁列之間、又看得出是一顆開關」的最小尺寸。
 */
const LAYOUT = {
  y: 15,
  labelX: 124,
  trackX: 162,
  trackW: 36,
  trackH: 14,
  knobR: 6,
  sideX: 204,
  /** 點擊範圍：從軌道左緣到側標籤右邊一段。 */
  hitX: 158,
  hitW: 100,
  hitH: 22,
  tipY: 26,
};

/**
 * 開關的顏色。**低彩度的藍綠**，照標題列本身的色（2026-09-12 實機取樣：
 * 標題列 #36464f／#313e46、牌組面板 #212e44）往亮一階調 —— 玩家回報原本那個
 * 金黃色跟整個畫面不搭（「風格不搭」）。⚠ 不要再往高彩度調，整個 Edit 畫面
 * 沒有一塊是飽和色，多一塊就會跳出來。
 */
const COLOR = {
  trackOn: 0x3d5f6e,
  trackOff: 0x4a4a4a,
  strokeOn: 0x7aa0ae,
  strokeOff: 0x9a9a9a,
  knob: 0xf2f2f2,
  /** 旋鈕右邊那兩個字：開著時用同一系的淡藍，關著時灰。 */
  sideOn: "#b7d0da",
  sideOff: "#cccccc",
};

const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  function editScene() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    var sc = keys && keys.Edit;
    return sc && sc.scene && sc.scene.isActive() ? sc : null;
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table, lang) {
    return table[lang] || table.en;
  }
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 */
export function buildCostTogglePatchScript(options: CostTogglePatchOptions): string {
  const config = {
    version: COST_TOGGLE_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_COST_TOGGLE_POLL_MS,
    state: options.state,
    sideLabel: SIDE_LABEL,
    tooltip: TOOLTIP,
    layout: LAYOUT,
    color: COLOR,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var L = CFG.layout, C = CFG.color;
  ${SHARED}

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    detach(st);
    delete window[FLAG];
  }

  function detach(st) {
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    st.mine = [];
    st.scene = null;
    st.track = null;
    st.knob = null;
    st.side = null;
  }

  // -------------------------------------------------------------------------
  // 畫面
  // -------------------------------------------------------------------------

  function paint(st) {
    if (!st.track) return;
    var on = !!st.state.enabled;
    try {
      st.track.clear();
      st.track.fillStyle(on ? C.trackOn : C.trackOff, 1);
      st.track.fillRoundedRect(L.trackX, L.y - L.trackH / 2, L.trackW, L.trackH, L.trackH / 2);
      st.track.lineStyle(1, on ? C.strokeOn : C.strokeOff, 1);
      st.track.strokeRoundedRect(L.trackX, L.y - L.trackH / 2, L.trackW, L.trackH, L.trackH / 2);
      var pad = L.knobR + 1;
      st.knob.setX(on ? L.trackX + L.trackW - pad : L.trackX + pad);
      var labels = pick(CFG.sideLabel, gameLang());
      st.side.setText(on ? labels.on : labels.off);
      st.side.setColor(on ? C.sideOn : C.sideOff);
    } catch (e) {}
  }

  function mount(st, sc) {
    var lang = gameLang();
    var mine = st.mine;

    var label = sc.add.text(L.labelX, L.y, "COST", {
      fontFamily: "font_heavy", fontSize: 12, color: "#ffffff"
    }).setResolution(2).setOrigin(0, 0.5).setDepth(5);
    mine.push(label);

    var track = sc.add.graphics().setDepth(5);
    mine.push(track);

    var knob = sc.add.circle(L.trackX + L.knobR + 1, L.y, L.knobR, C.knob).setDepth(6);
    mine.push(knob);

    var side = sc.add.text(L.sideX, L.y, "", {
      fontFamily: "font_light", fontSize: 12, color: "#cccccc"
    }).setResolution(2).setOrigin(0, 0.5).setDepth(5);
    mine.push(side);

    // hover 說明。壓在分頁列上面一點點也沒關係 —— 只有滑鼠停著時才出現。
    var tip = sc.add.container(L.hitX, L.tipY).setDepth(50).setVisible(false);
    var tipText = sc.add.text(0, 0, pick(CFG.tooltip, lang), {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(0, 0);
    var tipBack = sc.add.rectangle(0, 0, tipText.width, tipText.height, 0, 0.85).setOrigin(0, 0);
    tip.add(tipBack);
    tip.add(tipText);
    mine.push(tip);

    var hit = sc.add.zone(L.hitX, L.y - L.hitH / 2, L.hitW, L.hitH).setOrigin(0, 0).setDepth(7)
      .setInteractive({ useHandCursor: true });
    hit.on("pointerover", function () { try { tip.setVisible(true); } catch (e) {} });
    hit.on("pointerout", function () { try { tip.setVisible(false); } catch (e) {} });
    hit.on("pointerdown", function () {
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      // 旋鈕先動（樂觀更新），真相由 Node 切完再推回來。
      st.state.enabled = !st.state.enabled;
      paint(st);
      report({ type: "cost-toggle", enabled: st.state.enabled });
    });
    mine.push(hit);

    st.scene = sc;
    st.track = track;
    st.knob = knob;
    st.side = side;
    paint(st);
  }

  // -------------------------------------------------------------------------
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var sc = st.state.available ? editScene() : null;
      if (sc === null) {
        if (st.scene !== null) detach(st);
        return;
      }
      // 場景重建過的話，我們的東西已經跟著舊場景被 destroy（knob.scene 變 null）。
      if (st.scene !== sc || !st.knob || !st.knob.scene) {
        detach(st);
        mount(st, sc);
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    state: CFG.state,
    mine: [],
    scene: null,
    track: null,
    knob: null,
    side: null,
    timer: null,
    reason: null,
    setState: function (next) { st.state = next; tick(); paint(st); }
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    mounted: st.scene !== null,
    enabled: !!st.state.enabled,
    reason: st.reason
  });
})()`;
}

/**
 * 把新狀態推給頁面。回 `"not-installed"` 表示呼叫端要重裝。
 *
 * ⚠ 這是切換之後讓旋鈕停在**真相**那一邊的路：玩家點了、Node 切了價格與
 * 罰則之後再推一次。切失敗（例如頁面上根本沒有補丁）也要推 —— 那時旋鈕會
 * 從樂觀更新的位置彈回去，玩家才知道沒切成。
 */
export function buildCostToggleStateExpression(state: CostToggleState): string {
  return `(function () {
  var st = window["${FLAG}"];
  if (!st || typeof st.setState !== "function") return "not-installed";
  st.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

export const COST_TOGGLE_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) {
      return JSON.stringify({ installed: false, version: null, mounted: false, enabled: null, reason: null });
    }
    return JSON.stringify({
      installed: true,
      version: st.version,
      mounted: st.scene !== null && st.scene !== undefined,
      enabled: !!(st.state && st.state.enabled),
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, mounted: false, enabled: null,
      reason: String((e && e.message) || e)
    });
  }
})()`;

export const COST_TOGGLE_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseCostToggleStatus(raw: string): CostToggleStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      mounted: false,
      enabled: null,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    mounted: o.mounted === true,
    enabled: typeof o.enabled === "boolean" ? o.enabled : null,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
