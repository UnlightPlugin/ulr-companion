/**
 * 渦擊破結算的 OK 面板：全部／只一次／不再
 * ========================================
 * 你參加過的渦被打倒之後，每次進渦房 `Raid.create()` 會叫
 * `show_raid_reward()`，它自己 `socket.fetch("db_raid_reward")` 拿清單，把每一個
 * 渦的結算**一頁一頁演給你看**，而且每一頁都要按 OK：
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
 * ## 只換畫面，不換流程
 *
 * 2026-09-23 改版後（2026-09-25 讀原始碼）：
 *
 * ```
 * show_raid_reward():
 *   list = await fetch("db_raid_reward")
 *   每個渦 e：await create_reward_init(e)    訊息頁
 *            await create_reward_image(e)   獎勵頁（一格一個 OK）
 *            await create_reward_rank(e)    排行頁
 *            await fetch("raid_reward_receive", e.profound_id)   ← 告訴伺服器「領了」
 *   update_data("player")、update_data("avatar_item")            ← GEM／道具重讀
 * ```
 *
 * 跟改版前不一樣：**演完每個渦會回報伺服器**，而 update_data 是模組私有的摸不到。
 * 所以整段換掉會漏回報；做法是官方流程照跑，只把那三個畫面方法換成空的
 * （`__ulrRaidRewardBatch` 在場景上的那段期間）。回報與重讀一個不少，也沒多送。
 *
 * 舊版的 `Raid.prototype.raid_reward` 已經不存在 —— 補丁找不到它就一直等，
 * 托盤照樣顯示「生效中」，玩家勾了不再通知還是一頁頁跳（2026-09-25 回報）。
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
 * 包 `Raid.prototype` 上的 `show_raid_reward` 與三個畫面方法：都是
 * `this.xxx(...)` 呼叫，走 prototype，所以包原型就夠、不必等場景建好。
 * 原型是長命的，重裝先拆再包。
 *
 * - `all`：畫面方法照跑，演完回報一行。
 * - `none`：畫面方法變空的，官方一路 fetch → 回報領取 → 重讀，一閃就過。
 * - `once`：同 none，官方跑完後畫摘要；勾了詳細就把收集到的渦用官方畫面方法
 *   再演一次（純演出，領取早就回報過了）。
 *
 * ⚠ 獎勵長 `{ id, type, slot, value }`，名字照官方模組私有的 `NR()` 自己查
 * （`CharaCards`／`WeaponCards`／`EventCards`／`AvatarItems`／`AvatarParts`）。
 * webpack 模組編號每次發版都會變，不要去 require 它。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrRaidReward";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const RAID_REWARD_SCRIPT_VERSION = 7;

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
  // 以下舊版頁面沒有
  /** 渦的發現時刻（對回托盤的渦結束紀錄用；渦房清單上沒看過這個渦就是 null） */
  found?: number | null;
  /** 官方回報「領了」（raid_reward_receive）的結果；false＝伺服器說失敗，下次進渦房會再列一次 */
  received?: boolean | null;
  /** 每樣獎勵落在哪份道具清單（對帳用）：`chara_card:10010`、`avatar_item:2`…；數量沒寫的算 1 */
  items?: RaidLedgerItem[];
}

export interface RaidLedgerItem {
  key: string;
  name: string;
  value: number;
}

/**
 * 道具清單（avatar_item／chara_card／weapon_card／event_card）被官方重讀過一次。
 * `changes` 只列變多的（用掉、合成掉的不列）。清單是空的也報 —— 托盤要知道「重讀過了卻沒入帳」。
 */
export interface RaidItemDeltaReport {
  type: "raid-item-delta";
  registry: string;
  at: number;
  changes: { key: string; name: string; before: number; after: number; updateAt: string | null }[];
  /** 對帳道具（{@link RaidRewardPatchOptions.ledgerWatch}）在這份清單裡的數量；沒有的是 0 */
  levels?: Record<string, number>;
  names?: Record<string, string>;
  /** 剛裝上時報的起點（沒有變動可言，changes 是空的） */
  initial?: boolean;
}

export function isRaidItemDeltaReport(value: unknown): value is RaidItemDeltaReport {
  const o = value as { type?: unknown; registry?: unknown; changes?: unknown } | null;
  return (
    typeof value === "object" &&
    o !== null &&
    o.type === "raid-item-delta" &&
    typeof o.registry === "string" &&
    Array.isArray(o.changes)
  );
}

/** 伺服器推了結算：不管哪個模式都回報，托盤記錄檔要記一行。 */
export interface RaidRewardReport {
  type: "raid-reward";
  entries: RaidRewardEntry[];
  /** 整理內容失敗的渦數（entries 會是空的；獎勵照樣領了） */
  failed?: number;
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

/**
 * 跨離線對帳的道具（`清單:id`）：玩家不消耗、只會變多的。chara_card 10001–10005 渦幣、
 * 10006–10010 碎片；avatar_item 9 抽獎券(免費)；weapon_card 5000 異化礦材（2026-09-26 實機讀的）。
 * 古代妙藥這類 AP 水會被用掉，不放。
 */
export const RAID_LEDGER_WATCH: readonly string[] = [
  ...Array.from({ length: 10 }, (_, i) => `chara_card:${10001 + i}`),
  "avatar_item:9",
  "weapon_card:5000",
];

export interface RaidRewardPatchOptions {
  bindingName: string;
  mode?: RaidRewardMode;
  /** 要報數量的道具（`chara_card:10010` 這種）。托盤拿去跨離線對帳 */
  ledgerWatch?: readonly string[];
}

export function buildRaidRewardPatchScript(options: RaidRewardPatchOptions): string {
  const config = {
    version: RAID_REWARD_SCRIPT_VERSION,
    bindingName: options.bindingName,
    mode: options.mode ?? DEFAULT_RAID_REWARD_MODE,
    labels: RAID_REWARD_LABELS,
    // 官方 Nt 列舉（TG_CHARA_CARD…）與 x$ 的槽位（WEAPON_CARD=0、EVENT_CARD=2），2026-09-25 實機讀的
    rewardTypes: { chara: 1, slot: 2, avatarItem: 3, avatarPart: 4, gem: 5 },
    slotWeapon: 0,
    slotEvent: 2,
    maxShown: 6,
    ledgerWatch: options.ledgerWatch ?? RAID_LEDGER_WATCH,
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

  function gameLang() { return typeof lang === "string" ? lang : "tcn"; }
  function cached(sc, key) {
    try { var v = sc.cache.json.get(key); return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  function byId(sc, key, id) {
    var arr = cached(sc, key);
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  function charaName(sc, id) {
    var c = byId(sc, "CharaCards", id);
    var chars = null;
    try { chars = sc.cache.json.get("Characters"); } catch (e) {}
    return c && chars && chars[c.chara] ? String(chars[c.chara]["name_" + gameLang()] || "") : "";
  }
  /** 獎勵 {id,type,slot,value} → 名字（照官方模組私有的 NR 寫的）。 */
  function itemName(sc, r) {
    if (!r || typeof r !== "object") return null;
    var lg = gameLang();
    var x = r.value > 0 ? " x" + r.value : "";
    try {
      switch (r.type) {
        case CFG.rewardTypes.chara: {
          var c = byId(sc, "CharaCards", r.id);
          var nm = charaName(sc, r.id);
          if (!c || !nm) return "---";
          var pre = c.kind === 0 ? (c.rarity < 6 ? "L" : "R") + c.level + " " : c.kind === 1 ? "M" + c.level + " " : "";
          return pre + nm + x;
        }
        case CFG.rewardTypes.slot: {
          var key = r.slot === CFG.slotWeapon ? "WeaponCards" : r.slot === CFG.slotEvent ? "EventCards" : null;
          var s = key ? byId(sc, key, r.id) : null;
          return s ? s["name_" + lg] + x : "---";
        }
        case CFG.rewardTypes.avatarItem: {
          var it = byId(sc, "AvatarItems", r.id);
          return it ? it["name_" + lg] + x : "---";
        }
        case CFG.rewardTypes.avatarPart: {
          var pt = byId(sc, "AvatarParts", r.id);
          return pt ? String(pt["name_" + lg]) : "---";
        }
        case CFG.rewardTypes.gem:
          return r.value + "GEM";
      }
    } catch (e) {}
    return "---";
  }
  function names(sc, arr) {
    var out = [];
    if (!arr || !arr.length) return out;
    for (var i = 0; i < arr.length; i++) { var n = itemName(sc, arr[i]); if (n) out.push(n); }
    return out;
  }
  /** 獎勵碼 → 它落在哪份道具清單（跟 registry 的鍵同名）；GEM、頭像零件不對帳 */
  function itemKey(r) {
    if (!r || typeof r.id !== "number") return null;
    if (r.type === CFG.rewardTypes.chara) return "chara_card:" + r.id;
    if (r.type === CFG.rewardTypes.avatarItem) return "avatar_item:" + r.id;
    if (r.type === CFG.rewardTypes.slot) return r.slot === CFG.slotWeapon ? "weapon_card:" + r.id : r.slot === CFG.slotEvent ? "event_card:" + r.id : null;
    return null;
  }
  function ledgerItems(sc, rw) {
    var out = [];
    ["founder", "participate", "defeat", "rank"].forEach(function (k) {
      var arr = rw[k];
      if (!Array.isArray(arr)) return;
      for (var i = 0; i < arr.length; i++) {
        var key = itemKey(arr[i]);
        if (key === null) continue;
        var nm = itemName(sc, { type: arr[i].type, id: arr[i].id, slot: arr[i].slot, value: 0 });
        out.push({ key: key, name: nm || key, value: arr[i].value > 0 ? arr[i].value : 1 });
      }
    });
    return out;
  }
  function summarize(sc, list, received) {
    var out = [];
    var M = window.__ulrRaidMeta || {};
    for (var a = 0; a < list.length; a++) {
      var t = list[a] || {};
      var rw = t.raid_reward || {};
      var pid = t.profound_id !== null && t.profound_id !== undefined ? String(t.profound_id) : null;
      var meta = pid !== null ? M[pid] : null;
      var found = typeof t.found_at === "number" ? t.found_at : meta && typeof meta.found === "number" ? meta.found : null;
      var rc = received && pid !== null ? received[pid] : undefined;
      out.push({
        prf: String(t.raid_name || ""), boss: charaName(sc, t.raid_monster_id),
        founder: String(t.raid_founder || ""), defeat: "",
        rank: typeof t.raid_rank === "number" ? t.raid_rank : null,
        dmg: typeof t.raid_score === "number" ? t.raid_score : null,
        rewards: {
          founder: names(sc, rw.founder),
          participate: names(sc, rw.participate),
          defeat: names(sc, rw.defeat),
          rank: names(sc, rw.rank)
        },
        found: found,
        received: typeof rc === "boolean" ? rc : null,
        items: ledgerItems(sc, rw)
      });
    }
    return out;
  }

  // ---- 道具對帳：官方重讀道具清單時比數量 --------------------------------------------
  //
  // 官方 update_data 只抓上次之後變動的、合併後 registry.set 回去（會發 changedata-鍵）。
  // 結算流程最後只重讀 player 與 avatar_item；碎片、渦幣（chara_card）與異化礦材
  // （weapon_card）要等官方別處重讀（牌組編輯、商店…）才看得到。不多送任何請求，只聽。
  // 結算正在跑時先收著，等 raid-reward 報完再報 —— 托盤要先知道「結算列了什麼」才對得上。
  var LEDGER_KEYS = ["avatar_item", "chara_card", "weapon_card", "event_card"];
  function ledgerId(regKey, row) {
    return regKey === "avatar_item" ? row.item_id : row.card_id;
  }
  function ledgerSnap(regKey, arr) {
    var out = {};
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!r) continue;
      var id = ledgerId(regKey, r);
      if (typeof id === "number") out[id] = { q: typeof r.quantity === "number" ? r.quantity : 0, u: typeof r.update_at === "string" ? r.update_at : null };
    }
    return out;
  }
  function ledgerName(sc, regKey, id) {
    var T = CFG.rewardTypes;
    var r = regKey === "avatar_item" ? { type: T.avatarItem, id: id } : regKey === "chara_card" ? { type: T.chara, id: id }
      : { type: T.slot, id: id, slot: regKey === "weapon_card" ? CFG.slotWeapon : CFG.slotEvent };
    r.value = 0;
    return itemName(sc, r);
  }
  /** 對帳道具在這份清單裡的數量（沒有的是 0：官方把數量 0 的列濾掉了）與名字 */
  function ledgerLevels(sc, k, snap) {
    var levels = {}, nm = {};
    for (var i = 0; i < CFG.ledgerWatch.length; i++) {
      var key = CFG.ledgerWatch[i], p = key.indexOf(":");
      if (key.slice(0, p) !== k) continue;
      var id = +key.slice(p + 1);
      levels[key] = snap[id] ? snap[id].q : 0;
      nm[key] = ledgerName(sc, k, id) || key;
    }
    return { levels: levels, names: nm };
  }
  function ledgerOn(st) {
    var G = gameOf();
    if (!G || !G.registry || st.ledger) return;
    var L = { handlers: {}, snap: {}, pending: [], setHandler: null };
    var sceneOf = function () { return G.scene.keys.Raid || G; };
    var handle = function (k, value) {
      try {
        if (!Array.isArray(value)) return;
        var next = ledgerSnap(k, value), prev = L.snap[k], changes = [];
        var sc = sceneOf();
        if (prev) {
          for (var id in next) {
            var b = prev[id] ? prev[id].q : 0, a = next[id].q;
            if (a > b) changes.push({ key: k + ":" + id, name: ledgerName(sc, k, +id) || k + ":" + id, before: b, after: a, updateAt: next[id].u });
          }
        }
        L.snap[k] = next;
        var lv = ledgerLevels(sc, k, next);
        var rep = { type: "raid-item-delta", registry: k, at: Date.now(), changes: changes, levels: lv.levels, names: lv.names, initial: !prev };
        if (st.batching) L.pending.push(rep); else report(rep);
      } catch (e) {}
    };
    LEDGER_KEYS.forEach(function (k) {
      var h = function (parent, value) { handle(k, value); };
      L.handlers[k] = h;
      G.registry.events.on("changedata-" + k, h);
    });
    // 第一次放進 registry（登入時）發的是 setdata，不是 changedata-鍵
    L.setHandler = function (parent, key, value) { if (LEDGER_KEYS.indexOf(key) !== -1) handle(key, value); };
    G.registry.events.on("setdata", L.setHandler);
    st.ledger = L;
    // 起點：已經讀好的清單現在就報一次，托盤拿去跟上次（可能是離線前）的數量比
    LEDGER_KEYS.forEach(function (k) { handle(k, G.registry.get(k)); });
  }
  function ledgerFlush(st) {
    var L = st.ledger;
    if (!L) return;
    var p = L.pending;
    L.pending = [];
    for (var i = 0; i < p.length; i++) report(p[i]);
  }
  function ledgerOff(st) {
    var L = st.ledger, G = gameOf();
    st.ledger = null;
    if (!L || !G || !G.registry) return;
    for (var k in L.handlers) { try { G.registry.events.off("changedata-" + k, L.handlers[k]); } catch (e) {} }
    try { if (L.setHandler) G.registry.events.off("setdata", L.setHandler); } catch (e) {}
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
      // OK 鈕：用官方結算頁那顆 raid_panel_ok（改版前是 panel_ok）
      var okTex = sc.textures.exists("raid_panel_ok") ? "raid_panel_ok" : sc.textures.exists("panel_ok") ? "panel_ok" : null;
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

  // ---- 包 show_raid_reward 與三個畫面方法 -----------------------------------
  var MAIN = "show_raid_reward";
  var PAGES = ["create_reward_init", "create_reward_image", "create_reward_rank"];
  var METHODS = [MAIN].concat(PAGES);

  /** 官方流程跑完之後：回報一行、記下收到了、照模式畫摘要／重播官方畫面。 */
  function afterBatch(st, sc, batch, orig) {
    if (batch.list.length === 0) { ledgerFlush(st); return Promise.resolve(); }
    var entries = [], failed = 0;
    try { entries = summarize(sc, batch.list, batch.received); } catch (e) { entries = []; failed = batch.list.length; }
    // 整理失敗也要留一筆「收到幾個」—— 不然不再通知模式下完全看不出來領過
    report({ type: "raid-reward", entries: entries, failed: failed });
    ledgerFlush(st);
    // 記下「這些渦的結算收到了」。自動刪死渦（patch-raid-view）要等這個才刪
    // 有自己一份獎勵的死渦 —— 沒收到結算前刪掉會不會吃掉獎勵，沒人驗過。
    // raw 是原始獎勵碼（不含玩家名字）：patch-raid-view 拿去依渦鍵學獎勵表。
    try {
      var seen = window.__ulrRaidRewardSeen || (window.__ulrRaidRewardSeen = []);
      for (var q = 0; q < entries.length; q++) {
        var src = batch.list[q] || {};
        var rw = src.raid_reward || {};
        var ranks = [];
        var ps = Array.isArray(src.raid_participants) ? src.raid_participants : [];
        for (var p = 0; p < ps.length; p++) ranks.push(ps[p] && Array.isArray(ps[p].reward) ? ps[p].reward : []);
        seen.push({ prf: entries[q].prf, boss: entries[q].boss, founder: entries[q].founder, defeat: entries[q].defeat, profound_id: src.profound_id, at: Date.now(),
          raw: { founder: rw.founder || [], participate: rw.participate || [], defeat: rw.defeat || [], ranks: ranks, founderName: String(src.raid_founder || "") } });
      }
      if (seen.length > 200) seen.splice(0, seen.length - 200);
    } catch (e) {}
    if (batch.mode !== "once") return Promise.resolve();
    return showSummary(st, sc, entries).then(function (detail) {
      // 面板開著時切成「不再通知」要蓋過之前打的勾：勾是記在 st 上跨批留著的，
      // 不看模式的話玩家按了不再通知、OK 後官方面板照樣一頁頁跳（2026-09-13 實機）
      if (st.mode === "none" || !detail) return undefined;
      // 重播官方畫面。領取在官方流程裡已經回報過了，這裡純演出、不送東西
      var chain = Promise.resolve();
      batch.list.forEach(function (e) {
        PAGES.forEach(function (name) { chain = chain.then(function () { return orig[name].call(sc, e); }); });
      });
      return chain.then(function () { return undefined; });
    });
  }

  function hook(st) {
    var G = gameOf();
    var R = G && G.scene.keys.Raid;
    if (!R) return false;
    var proto = Object.getPrototypeOf(R);
    if (!proto) return false;
    for (var i = 0; i < METHODS.length; i++) {
      if (typeof proto[METHODS[i]] !== "function") { st.reason = "Raid 場景沒有 " + METHODS[i] + "（客戶端改版了？）"; return false; }
    }
    st.reason = null;
    // 已經是這一份掛的就不動；上一份留下的包裝就從它記的原版重包
    if (proto[MAIN].__ulrRaidReward && st.proto === proto) return true;
    var orig = {};
    for (var j = 0; j < METHODS.length; j++) { var f = proto[METHODS[j]]; orig[METHODS[j]] = f.__ulrRaidReward || f; }

    // 畫面方法：批次進行中就記下這個渦；模式是 all 才真的演
    PAGES.forEach(function (name) {
      var o = orig[name];
      var w = function (e) {
        var batch = this.__ulrRaidRewardBatch;
        if (!batch) return o.apply(this, arguments);
        if (name === PAGES[0]) batch.list.push(e);
        if (batch.mode === "all") return o.apply(this, arguments);
        return Promise.resolve();
      };
      w.__ulrRaidReward = o;
      proto[name] = w;
    });

    var main = function () {
      var self = this;
      var st = window[FLAG];
      if (!st) return orig[MAIN].apply(self, arguments);
      // 場景物件是長命的：每一批都換新的，收尾只清自己那一份
      var batch = { list: [], mode: st.mode, received: {} };
      self.__ulrRaidRewardBatch = batch;
      // 官方回報「領了」失敗只在主控台印一行（伺服器下次會再列一次）。這一批期間包一層
      // socket.fetch 聽結果 —— 只看回應，不多送
      var sock = self.socket, ownFetch = null, hadOwn = false;
      try {
        if (sock && typeof sock.fetch === "function") {
          hadOwn = Object.prototype.hasOwnProperty.call(sock, "fetch");
          ownFetch = sock.fetch;
          sock.fetch = function (name, arg) {
            var q = ownFetch.apply(this, arguments);
            if (name === "raid_reward_receive" && arg !== null && arg !== undefined) {
              var pid = String(arg);
              Promise.resolve(q).then(function (v) { batch.received[pid] = v !== false; }, function () { batch.received[pid] = false; });
            }
            return q;
          };
        }
      } catch (e) { ownFetch = null; }
      st.batching = true;
      var done = function () {
        if (self.__ulrRaidRewardBatch === batch) delete self.__ulrRaidRewardBatch;
        st.batching = false;
        try {
          if (ownFetch !== null) { if (hadOwn) sock.fetch = ownFetch; else delete sock.fetch; }
        } catch (e) {}
      };
      var p;
      try { p = Promise.resolve(orig[MAIN].apply(self, arguments)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (r) {
        done();
        // 每次跟伺服器要結算都記一筆（連空的也記）：patch-raid-view 的渦結束紀錄拿去算
        // 「死後要過幾次、幾次是空的」，分得出沒問過還是問了伺服器沒給
        try {
          var asks = window.__ulrRaidRewardAsks || (window.__ulrRaidRewardAsks = []);
          asks.push({ at: Date.now(), n: batch.list.length });
          if (asks.length > 300) asks.splice(0, asks.length - 300);
        } catch (e) {}
        return afterBatch(st, self, batch, orig).then(function () { return r; });
      }, function (err) {
        done();
        ledgerFlush(st);
        throw err;
      });
    };
    main.__ulrRaidReward = orig[MAIN];
    proto[MAIN] = main;
    st.proto = proto;
    return true;
  }
  function unhook(st) {
    var proto = st.proto;
    if (proto) {
      for (var i = 0; i < METHODS.length; i++) {
        var f = proto[METHODS[i]];
        if (f && f.__ulrRaidReward) proto[METHODS[i]] = f.__ulrRaidReward;
      }
    }
    st.proto = null;
  }
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { closePanel(st); } catch (e) {}
    try { unhook(st); } catch (e) {}
    try { ledgerOff(st); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, mode: CFG.mode, detail: false, panel: null, proto: null, timer: null, reason: null, ledger: null, batching: false };
  window[FLAG] = st;
  // Raid 場景類別在遊戲一起來就註冊了，但「先開插件再開遊戲」時還沒有 —— 等它。
  var hooked = hook(st);
  if (hooked) ledgerOn(st);
  if (!hooked) {
    st.timer = setInterval(function () {
      var s = window[FLAG];
      if (!s) return;
      if (hook(s)) { ledgerOn(s); clearInterval(s.timer); s.timer = null; }
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
    var L = st.ledger, G = window.game;
    if (L && G && G.registry) {
      for (var k in L.handlers) { try { G.registry.events.off("changedata-" + k, L.handlers[k]); } catch (e) {} }
      try { if (L.setHandler) G.registry.events.off("setdata", L.setHandler); } catch (e) {}
    }
    var proto = st.proto;
    if (proto) {
      ["show_raid_reward", "create_reward_init", "create_reward_image", "create_reward_rank"].forEach(function (n) {
        var f = proto[n];
        if (f && f.__ulrRaidReward) proto[n] = f.__ulrRaidReward;
      });
    }
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
