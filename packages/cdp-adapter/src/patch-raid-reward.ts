/**
 * 渦擊破結算的 OK 面板：全部／只一次／不再
 * ========================================
 * 你參加過的渦被打倒之後，下次進渦房（或戰鬥結束回渦房）伺服器會推
 * `db_raid_reward`，客戶端的 `Raid.raid_reward(list)` 把每一個渦的結算
 * **一頁一頁演給你看**，而且每一頁都要按 OK：
 *
 * ```
 *   每個渦：訊息頁（討伐怪獸／發現者／擊破者）        1 次 OK
 *          獎勵頁：發現 3 格＋參加 1 格＋擊破 2 格＋排名 3 格，
 *                  **每一格有東西就各要按一次**            最多 9 次 OK
 *                  再一次總 OK                              1 次
 *          排行頁                                          1 次
 * ```
 *
 * 舔渦一晚十幾個渦，隔天進渦房要按一百多下。玩家 2026-09-13：「通知很煩人」。
 *
 * ## 為什麼可以整段換掉
 *
 * `raid_reward()` 從頭到尾**不送任何封包** —— 獎勵在伺服器推 `db_raid_reward`
 * 的那一刻就已經入帳了，面板純粹是演出（2026-09-13 讀原始碼確認：整個方法
 * 裡沒有 emit／fetch，只有 load 三張圖、畫、等 pointerup、destroy）。所以
 * 不演不會少拿任何東西。
 *
 * ## 三種模式（玩家訂的）
 *
 * | 模式   | 行為                                                       |
 * | ------ | ---------------------------------------------------------- |
 * | `all`  | 官方原樣，一頁一頁按                                       |
 * | `once` | 我們畫**一張**摘要面板列出這一批所有渦的結算與獎勵，一顆 OK；|
 * |        | 面板上有一個「按 OK 後照樣顯示官方詳細畫面」的開關          |
 * | `none` | 什麼都不畫；托盤記錄檔照樣記一行                            |
 *
 * 模式可以在托盤設定，也可以在摘要面板上直接切（三個字樣點一下），切了會
 * 回報托盤存起來。
 *
 * ## 掛法
 *
 * 包 `Raid.prototype.raid_reward`：`create()` 與 `socket.on("db_raid_reward")`
 * 都是 `this.raid_reward(...)` 呼叫，走 prototype，所以包原型就夠、不必等
 * 場景建好。原型是長命的，重裝先拆再包。
 *
 * ⚠ 獎勵代碼長 `cmem_3_2`（類別_索引_數量）或 `ticket_3`，名字要查
 * `this.itemInfo[類別][索引].name_<lang>`（跟官方 `raid_reward_detail` 一樣）。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrRaidReward";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const RAID_REWARD_SCRIPT_VERSION = 4;

export type RaidRewardMode = "all" | "once" | "none";

export const RAID_REWARD_MODES: readonly RaidRewardMode[] = ["all", "once", "none"];

export const DEFAULT_RAID_REWARD_MODE: RaidRewardMode = "once";

export function isRaidRewardMode(v: unknown): v is RaidRewardMode {
  return v === "all" || v === "once" || v === "none";
}

/** 摘要面板上的字。 */
export const RAID_REWARD_LABELS: Record<
  string,
  {
    title: string;
    rank: string;
    founder: string;
    defeat: string;
    rewardFounder: string;
    rewardParticipate: string;
    rewardDefeat: string;
    rewardRank: string;
    detail: string;
    modeAll: string;
    modeOnce: string;
    modeNone: string;
    more: string;
  }
> = {
  ja: {
    title: "渦 撃退結果",
    rank: "__RANK__位 ・ __DMG__ pts.",
    founder: "発見者",
    defeat: "撃破者",
    rewardFounder: "発見",
    rewardParticipate: "参加",
    rewardDefeat: "撃破",
    rewardRank: "順位",
    detail: "OK の後に公式の詳細画面も表示",
    modeAll: "毎回表示",
    modeOnce: "まとめて1回",
    modeNone: "表示しない",
    more: "…他 __N__ 件",
  },
  en: {
    title: "Vortex results",
    rank: "#__RANK__ ・ __DMG__ pts.",
    founder: "Discoverer",
    defeat: "Defeated by",
    rewardFounder: "Discovery",
    rewardParticipate: "Participation",
    rewardDefeat: "Victory",
    rewardRank: "Position",
    detail: "Show the official detail pages after OK",
    modeAll: "Show all",
    modeOnce: "Summary once",
    modeNone: "Never",
    more: "…and __N__ more",
  },
  kr: {
    title: "소용돌이 격퇴 결과",
    rank: "__RANK__위 ・ __DMG__ pts.",
    founder: "발견자",
    defeat: "격퇴자",
    rewardFounder: "발견",
    rewardParticipate: "참가",
    rewardDefeat: "격퇴",
    rewardRank: "랭킹",
    detail: "OK 후 공식 상세 화면도 표시",
    modeAll: "모두 표시",
    modeOnce: "요약 1회",
    modeNone: "표시 안 함",
    more: "…외 __N__건",
  },
  scn: {
    title: "漩涡击破结算",
    rank: "第 __RANK__ 名 ・ __DMG__ pts.",
    founder: "发现者",
    defeat: "击破者",
    rewardFounder: "发现",
    rewardParticipate: "参加",
    rewardDefeat: "击破",
    rewardRank: "排名",
    detail: "按 OK 后照样显示官方详细画面",
    modeAll: "全部通知",
    modeOnce: "只通知一次",
    modeNone: "不再通知",
    more: "…还有 __N__ 个",
  },
  tcn: {
    title: "渦擊破結算",
    rank: "第 __RANK__ 名 ・ __DMG__ pts.",
    founder: "發現者",
    defeat: "擊破者",
    rewardFounder: "發現",
    rewardParticipate: "參加",
    rewardDefeat: "擊破",
    rewardRank: "排名",
    detail: "按 OK 後照樣顯示官方詳細畫面",
    modeAll: "全部通知",
    modeOnce: "只通知一次",
    modeNone: "不再通知",
    more: "…還有 __N__ 個",
  },
};

/** 一個渦的結算（頁面整理好、名字已翻譯）。 */
export interface RaidRewardEntry {
  prf: string;
  boss: string;
  founder: string;
  defeat: string;
  rank: number | null;
  dmg: number | null;
  rewards: {
    founder: string[];
    participate: string[];
    defeat: string[];
    rank: string[];
  };
}

/** 伺服器推了結算：不管哪個模式都回報，托盤記錄檔要記一行。 */
export interface RaidRewardReport {
  type: "raid-reward";
  entries: RaidRewardEntry[];
}

/** 玩家在摘要面板上切了模式。托盤要存起來。 */
export interface RaidRewardModeReport {
  type: "raid-reward-mode";
  mode: RaidRewardMode;
}

export function isRaidRewardReport(value: unknown): value is RaidRewardReport {
  const o = value as { type?: unknown; entries?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-reward" &&
    Array.isArray(o.entries)
  );
}

export function isRaidRewardModeReport(value: unknown): value is RaidRewardModeReport {
  const o = value as { type?: unknown; mode?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-reward-mode" &&
    isRaidRewardMode(o.mode)
  );
}

export interface RaidRewardStatus {
  installed: boolean;
  version: number | null;
  mode: RaidRewardMode | null;
  /** 摘要面板正開著 */
  open: boolean;
  reason: string | null;
}

export interface RaidRewardPatchOptions {
  bindingName: string;
  mode?: RaidRewardMode;
}

export function buildRaidRewardPatchScript(options: RaidRewardPatchOptions): string {
  const config = {
    version: RAID_REWARD_SCRIPT_VERSION,
    bindingName: options.bindingName,
    mode: options.mode ?? DEFAULT_RAID_REWARD_MODE,
    labels: RAID_REWARD_LABELS,
    categories: ["avatar", "quest", "battle", "ccoin", "cmem", "weapon"],
    maxShown: 6,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};
  var FONT = "font_light";

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys ? window.game : null;
  }
  function alive(o) { return !!(o && o.scene); }
  function langOf() { return typeof lang === "string" && CFG.labels[lang] ? lang : "tcn"; }
  function L() { return CFG.labels[langOf()]; }
  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  function destroyAll(list) {
    for (var i = 0; i < list.length; i++) { try { if (alive(list[i])) list[i].destroy(); } catch (e) {} }
    list.length = 0;
  }

  /** 獎勵代碼 → 名字（照官方 raid_reward_detail 的查法）。 */
  function itemName(sc, code) {
    if (typeof code !== "string" || code === "") return null;
    var parts = code.split("_");
    var lg = langOf();
    try {
      if (parts[0] === "ticket") {
        return sc.itemInfo.other[0]["name_" + lg] + " x" + parts[1];
      }
      if (CFG.categories.indexOf(parts[0]) !== -1) {
        var info = sc.itemInfo[parts[0]] && sc.itemInfo[parts[0]][+parts[1]];
        return (info ? info["name_" + lg] : code) + " x" + parts[2];
      }
    } catch (e) {}
    return code;
  }
  function names(sc, arr) {
    var out = [];
    if (!arr || !arr.length) return out;
    for (var i = 0; i < arr.length; i++) { var n = itemName(sc, arr[i]); if (n) out.push(n); }
    return out;
  }
  function summarize(sc, list) {
    var out = [];
    for (var a = 0; a < list.length; a++) {
      var t = list[a] || {};
      out.push({
        prf: String(t.prf || ""), boss: String(t.boss || ""),
        founder: String(t.founder || ""), defeat: String(t.defeat || ""),
        rank: typeof t.rank === "number" ? t.rank : null,
        dmg: typeof t.dmg === "number" ? t.dmg : null,
        rewards: {
          founder: names(sc, t.reward_founder),
          participate: names(sc, t.reward_participate),
          defeat: names(sc, t.reward_defeat),
          rank: names(sc, t.reward_rank)
        }
      });
    }
    return out;
  }

  // ---- 摘要面板 -------------------------------------------------------------
  function closePanel(st) {
    if (!st.panel) return;
    destroyAll(st.panel.objs);
    st.panel = null;
  }
  function showSummary(st, sc, entries) {
    return new Promise(function (resolve) {
      closePanel(st);
      var D = 2500;
      var objs = [];
      var zone = sc.add.zone(380, 340, 760, 680).setDepth(D).setInteractive();
      objs.push(zone);
      var W = 520, cx = 380, top = 120, left = cx - W / 2 + 20;
      var y = top;
      objs.push(sc.add.text(left, y, L().title + "  (" + entries.length + ")", { fontFamily: "font_bold", fontSize: 15, resolution: 2, color: "#ffffff" }).setOrigin(0, 0).setDepth(D + 2));
      y += 26;
      var shown = Math.min(entries.length, CFG.maxShown);
      for (var i = 0; i < shown; i++) {
        var e = entries[i];
        var head = "\\u300c" + e.prf + "\\u300d " + e.boss;
        if (e.rank !== null) head += "   " + L().rank.replace("__RANK__", e.rank).replace("__DMG__", (e.dmg === null ? "-" : e.dmg.toLocaleString()));
        objs.push(sc.add.text(left, y, head, { fontFamily: "font_bold", fontSize: 12, resolution: 2, color: "#ffe066" }).setOrigin(0, 0).setDepth(D + 2));
        y += 16;
        var parts = [];
        if (e.rewards.founder.length) parts.push(L().rewardFounder + " " + e.rewards.founder.join(", "));
        if (e.rewards.participate.length) parts.push(L().rewardParticipate + " " + e.rewards.participate.join(", "));
        if (e.rewards.defeat.length) parts.push(L().rewardDefeat + " " + e.rewards.defeat.join(", "));
        if (e.rewards.rank.length) parts.push(L().rewardRank + " " + e.rewards.rank.join(", "));
        var line = sc.add.text(left + 12, y, parts.join("   "), { fontFamily: FONT, fontSize: 11, resolution: 2, color: "#e8e0d0", wordWrap: { width: W - 52 } }).setOrigin(0, 0).setDepth(D + 2);
        objs.push(line);
        y += Math.max(15, line.height + 2);
        var meta = L().founder + " " + e.founder + (e.defeat ? "   " + L().defeat + " " + e.defeat : "");
        objs.push(sc.add.text(left + 12, y, meta, { fontFamily: FONT, fontSize: 10, resolution: 2, color: "#9a9a9a" }).setOrigin(0, 0).setDepth(D + 2));
        y += 18;
      }
      if (entries.length > shown) {
        objs.push(sc.add.text(left, y, L().more.replace("__N__", entries.length - shown), { fontFamily: FONT, fontSize: 11, resolution: 2, color: "#9a9a9a" }).setOrigin(0, 0).setDepth(D + 2));
        y += 18;
      }
      y += 6;
      // 「按 OK 後照樣顯示官方詳細畫面」開關
      var box = sc.rexUI.add.roundRectangle(left + 7, y + 7, 12, 12, 2, 0x000000, 0).setStrokeStyle(1.5, 0xdddddd).setDepth(D + 2);
      var tickT = sc.add.text(left + 7, y + 6, "\\u2713", { fontFamily: "sans-serif", fontSize: 11, resolution: 2, color: "#ffe066" }).setOrigin(0.5, 0.5).setDepth(D + 3).setVisible(st.detail);
      var detailT = sc.add.text(left + 20, y + 7, L().detail, { fontFamily: FONT, fontSize: 11, resolution: 2, color: "#e8e0d0" }).setOrigin(0, 0.5).setDepth(D + 2);
      var hit = sc.add.zone(left, y, 300, 14).setOrigin(0, 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
      hit.on("pointerup", function () { st.detail = !st.detail; tickT.setVisible(st.detail); });
      objs.push(box, tickT, detailT, hit);
      y += 22;
      // 模式切換：三個字樣
      var modes = [["all", L().modeAll], ["once", L().modeOnce], ["none", L().modeNone]];
      var mx = left;
      var modeTexts = [];
      var paint = function () {
        for (var k = 0; k < modeTexts.length; k++) {
          var on = modeTexts[k].__mode === st.mode;
          modeTexts[k].setColor(on ? "#ffe066" : "#8a8a8a");
        }
      };
      for (var m = 0; m < modes.length; m++) {
        var mt = sc.add.text(mx, y, (m === 0 ? "" : "\\u30fb ") + modes[m][1], { fontFamily: FONT, fontSize: 11, resolution: 2, color: "#8a8a8a" }).setOrigin(0, 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
        mt.__mode = modes[m][0];
        mt.on("pointerup", (function (mode) { return function () { st.mode = mode; paint(); report({ type: "raid-reward-mode", mode: mode }); }; })(modes[m][0]));
        modeTexts.push(mt);
        objs.push(mt);
        mx += mt.width + 10;
      }
      paint();
      y += 24;
      var H = (y - top) + 60;
      var cy = top - 16 + H / 2;
      objs.push(sc.rexUI.add.roundRectangle(cx, cy, W, H, 6, 0x0c0c10, 0.95).setDepth(D + 1).setStrokeStyle(2, 0x8a7a55));
      // OK 鈕：回合面板那顆 panel_ok 在渦房一直都在（panel_btn 是 SUPPORT 開了才載、關了就卸）
      var okTex = sc.textures.exists("panel_ok") ? "panel_ok" : null;
      var ok;
      if (okTex !== null) {
        ok = sc.add.image(cx, cy + H / 2 - 24, okTex, 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
        ok.on("pointerover", function () { ok.setTexture(okTex, 1); });
        ok.on("pointerout", function () { ok.setTexture(okTex, 0); });
      } else {
        ok = sc.add.text(cx, cy + H / 2 - 24, "OK", { fontFamily: "font_bold", fontSize: 16, resolution: 2, color: "#ffffff" }).setOrigin(0.5, 0.5).setDepth(D + 3).setStroke("black", 3).setInteractive({ useHandCursor: true });
      }
      ok.on("pointerup", function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        var detail = st.detail;
        closePanel(st);
        resolve(detail);
      });
      objs.push(ok);
      st.panel = { objs: objs };
    });
  }

  // ---- 包 raid_reward --------------------------------------------------------
  function hook(st) {
    var G = gameOf();
    var R = G && G.scene.keys.Raid;
    if (!R) return false;
    var proto = Object.getPrototypeOf(R);
    if (!proto || typeof proto.raid_reward !== "function") return false;
    var cur = proto.raid_reward;
    // 已經是這一份掛的就不動；上一份留下的包裝就從它記的原版重包
    if (cur.__ulrRaidReward && st.proto === proto) return true;
    var orig = cur.__ulrRaidReward || cur;
    var wrapped = function (list) {
      var self = this, args = arguments;
      var st = window[FLAG];
      if (!st || !Array.isArray(list) || list.length === 0) return orig.apply(self, args);
      var entries = [];
      try { entries = summarize(self, list); } catch (e) { entries = []; }
      report({ type: "raid-reward", entries: entries });
      // 記下「這些渦的結算收到了」。自動刪死渦（patch-raid-view）要等這個才刪
      // 有自己一份獎勵的死渦 —— 沒收到結算前刪掉會不會吃掉獎勵，沒人驗過。
      try {
        var seen = window.__ulrRaidRewardSeen || (window.__ulrRaidRewardSeen = []);
        for (var q = 0; q < entries.length; q++) seen.push({ prf: entries[q].prf, boss: entries[q].boss, founder: entries[q].founder, defeat: entries[q].defeat, at: Date.now() });
        if (seen.length > 200) seen.splice(0, seen.length - 200);
      } catch (e) {}
      if (st.mode === "all") return orig.apply(self, args);
      if (st.mode === "none") return Promise.resolve();
      return showSummary(st, self, entries).then(function (detail) {
        // 面板開著時切成「不再通知」要蓋過之前打的勾：勾是記在 st 上跨批留著的，
        // 不看模式的話玩家按了不再通知、OK 後官方面板照樣一頁頁跳（2026-09-13 實機）
        if (st.mode === "none") return undefined;
        if (detail) return orig.apply(self, args);
        return undefined;
      });
    };
    wrapped.__ulrRaidReward = orig;
    proto.raid_reward = wrapped;
    st.proto = proto;
    return true;
  }
  function unhook(st) {
    var proto = st.proto;
    if (proto && proto.raid_reward && proto.raid_reward.__ulrRaidReward) proto.raid_reward = proto.raid_reward.__ulrRaidReward;
    st.proto = null;
  }
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { closePanel(st); } catch (e) {}
    try { unhook(st); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, mode: CFG.mode, detail: false, panel: null, proto: null, timer: null, reason: null };
  window[FLAG] = st;
  // Raid 場景類別在遊戲一起來就註冊了，但「先開插件再開遊戲」時還沒有 —— 等它。
  if (!hook(st)) {
    st.timer = setInterval(function () {
      var s = window[FLAG];
      if (!s) return;
      if (hook(s)) { clearInterval(s.timer); s.timer = null; }
    }, 500);
  }
  return JSON.stringify({ installed: true, version: st.version, mode: st.mode, open: !!st.panel, reason: st.reason });
})()`;
}

export const RAID_REWARD_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, mode: null, open: false, reason: null });
    return JSON.stringify({ installed: true, version: st.version, mode: st.mode, open: !!st.panel, reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, mode: null, open: false, reason: String((e && e.message) || e) });
  }
})()`;

export function buildRaidRewardSetModeExpression(mode: RaidRewardMode): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.mode = ${JSON.stringify(mode)};
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

export const RAID_REWARD_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    if (st.panel) { st.panel.objs.forEach(function (o) { try { if (o && o.scene) o.destroy(); } catch (e) {} }); }
    var proto = st.proto;
    if (proto && proto.raid_reward && proto.raid_reward.__ulrRaidReward) proto.raid_reward = proto.raid_reward.__ulrRaidReward;
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseRaidRewardStatus(raw: string): RaidRewardStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      mode: null,
      open: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    mode: isRaidRewardMode(o.mode) ? o.mode : null,
    open: o.open === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
