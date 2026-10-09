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
 * | `once` | 我們畫**一張**摘要面板列出這一批所有渦的結算與獎勵，一顆 OK  |
 * | `none` | 什麼都不畫；托盤記錄檔照樣記一行                            |
 *
 * 模式只在托盤設定。摘要面板 2026-10-05 照玩家要求重做：照官方結算頁的底圖、立繪、
 * 字型與格子條排，每個渦的**每一樣**獎勵都畫官方卡面（不截「還有幾個」），超過一頁
 * 用官方翻頁鈕。舊版面板上的模式切換與「OK 後顯示官方詳細畫面」開關拿掉了 ——
 * 「不像遊戲裡的東西」，而且一次性通知本來就是要按一下就結束。
 *
 * ## 掛法
 *
 * 包 `Raid.prototype` 上的 `show_raid_reward` 與三個畫面方法：都是
 * `this.xxx(...)` 呼叫，走 prototype，所以包原型就夠、不必等場景建好。
 * 原型是長命的，重裝先拆再包。
 *
 * - `all`：畫面方法照跑，演完回報一行。
 * - `none`：畫面方法變空的，官方一路 fetch → 回報領取 → 重讀，一閃就過。
 * - `once`：同 none，官方跑完後畫摘要。
 *
 * ⚠ 獎勵長 `{ id, type, slot, value }`，名字照官方模組私有的 `NR()` 自己查
 * （`CharaCards`／`WeaponCards`／`EventCards`／`AvatarItems`／`AvatarParts`）。
 * webpack 模組編號每次發版都會變，不要去 require 它。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";

const FLAG = "__ulrRaidReward";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const RAID_REWARD_SCRIPT_VERSION = 8;

export type RaidRewardMode = "all" | "once" | "none";

export const RAID_REWARD_MODES: readonly RaidRewardMode[] = ["all", "once", "none"];

export const DEFAULT_RAID_REWARD_MODE: RaidRewardMode = "once";

export function isRaidRewardMode(v: unknown): v is RaidRewardMode {
  return v === "all" || v === "once" || v === "none";
}

/**
 * 摘要面板上的字。獎勵分類與「發現者」優先用官方 RaidUITexts.result 的（label_reward_founder…），
 * 這裡的是讀不到時的退路。名次照官方排行頁的「[N Pts.]」。
 */
export const RAID_REWARD_LABELS: Record<
  string,
  {
    rank: string;
    founder: string;
    rewardFounder: string;
    rewardParticipate: string;
    rewardDefeat: string;
    rewardRank: string;
  }
> = {
  ja: {
    rank: "__RANK__位  [__DMG__Pts.]",
    founder: "発見者",
    rewardFounder: "発見報酬",
    rewardParticipate: "参加報酬",
    rewardDefeat: "撃破報酬",
    rewardRank: "ランキング報酬",
  },
  en: {
    rank: "#__RANK__  [__DMG__Pts.]",
    founder: "Discoverer",
    rewardFounder: "Discovery",
    rewardParticipate: "Participation",
    rewardDefeat: "Victory",
    rewardRank: "Ranking",
  },
  kr: {
    rank: "__RANK__위  [__DMG__Pts.]",
    founder: "발견자",
    rewardFounder: "발견 보상",
    rewardParticipate: "참가 보상",
    rewardDefeat: "격퇴 보상",
    rewardRank: "랭킹 보상",
  },
  scn: {
    rank: "第 __RANK__ 名  [__DMG__Pts.]",
    founder: "发现者",
    rewardFounder: "发现奖励",
    rewardParticipate: "参加奖励",
    rewardDefeat: "击破奖励",
    rewardRank: "排行榜奖励",
  },
  tcn: {
    rank: "第 __RANK__ 名  [__DMG__Pts.]",
    founder: "發現者",
    rewardFounder: "發現獎勵",
    rewardParticipate: "參加獎勵",
    rewardDefeat: "擊破獎勵",
    rewardRank: "排行榜獎勵",
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
    ledgerWatch: options.ledgerWatch ?? RAID_LEDGER_WATCH,
  };

  return `(function () {
  "use strict";
  ${WEBPACK_REQUIRE_SNIPPET}
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

  // ---- 摘要面板：官方結算頁的底圖與排法 ---------------------------------------
  //
  // 2026-10-05 讀的官方 create_reward_init／image／rank：
  //   底圖 raid_result_panel（576x336，標題 DEFEATED CORE! 烤在圖上）、立繪 result_panel_overlay
  //   （獎勵頁 setCrop(0,0,116,336) 只留左邊人物）、OK raid_panel_ok 在 (380,488)；
  //   標籤 font_heavy 12 黑描邊 3、內容 font_light 12、格子白 8% 圓角條；
  //   獎勵卡用 $T.create_card(scene, id, type, slot, x, y)；翻頁 btn_arrow-2 在 (320,456)/(440,456)，
  //   中間「1 / N」，到頭繞回去。
  // 一列一個渦：左邊渦名／名次／發現者，右邊這個渦拿到的每一樣獎勵的卡面（縮小、數量標在右下），
  // 卡面滑上去出分類＋名字。一頁 4 個渦，全部都列 —— 不截「還有幾個」。
  var P = { x: 380, y: 340, w: 576, h: 336 };
  var PL = P.x - P.w / 2, PT = P.y - P.h / 2;
  var ROW = { left: PL + 120, right: PL + P.w - 16, top: PT + 44, h: 56, gap: 2, per: 4 };
  var INFO_X = PL + 128, INFO_W = 168;
  var CARD = { x0: PL + 304, h: 48, step: 36, gap: 6 };
  var REWARD_KEYS = ["founder", "participate", "defeat", "rank"];

  /** 官方畫卡的那一支（webpack 模組裡的 $T）。模組 id 每次發版都變，掃特徵字串；找一次記著。 */
  function cardFactory(st) {
    if (st.T !== undefined) return st.T;
    st.T = null;
    try {
      var req = typeof ulrWebpackRequire === "function" ? ulrWebpackRequire() : null;
      if (req === null) return null;
      for (var id in req.m) {
        var src;
        try { src = String(req.m[id]); } catch (e) { continue; }
        if (src.indexOf("create_card(") === -1 || src.indexOf("TG_BASE_UP") === -1) continue;
        var mod;
        try { mod = req(id); } catch (e) { continue; }
        for (var k in mod) {
          if (mod[k] && typeof mod[k] === "object" && typeof mod[k].create_card === "function") { st.T = mod[k]; return st.T; }
        }
      }
    } catch (e) {}
    return null;
  }
  /** 官方 RaidUITexts.result 的字（獎勵分類、發現者）；讀不到用自己的。 */
  function uiText(sc, key, fallback) {
    try {
      var t = sc.cache.json.get("RaidUITexts");
      var v = t && t.result ? t.result[key] : null;
      if (typeof v === "string" && v) return v;
    } catch (e) {}
    return fallback;
  }
  function labelStyle() { return { fontFamily: "font_heavy", fontSize: 12, resolution: 2 }; }
  function valueStyle() { return { fontFamily: FONT, fontSize: 12, resolution: 2 }; }
  /** 放不下就截成「...」（官方是捲動字，面板上捲來捲去太吵） */
  function fit(t, maxW) {
    var full = String(t.text), n = full.length;
    while (n > 1 && t.width > maxW) { n--; t.setText(full.substring(0, n) + "..."); }
    return t;
  }
  function closePanel(st) {
    if (!st.panel) return;
    destroyAll(st.panel.body);
    destroyAll(st.panel.objs);
    st.panel = null;
  }
  /** 滑上去才出來的說明：黑底小字，貼在目標上方。 */
  function hoverTip(sc, target, text, depth, holder) {
    var tip = [];
    target.on("pointerover", function () {
      destroyAll(tip);
      var tt = sc.add.text(target.x, target.y - target.height / 2 - 3, text, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(0.5, 1).setDepth(depth + 1);
      var bg = sc.rexUI.add.roundRectangle(tt.x, tt.y - tt.height / 2, tt.width + 10, tt.height + 6, 2, 0x000000, 0.85).setDepth(depth);
      tip.push(bg, tt);
      holder.push(bg, tt);
    });
    target.on("pointerout", function () { destroyAll(tip); });
  }
  /** 一個渦的獎勵攤平：[{ code, label }]，照官方頁的順序（發現→參加→擊破→排行）。 */
  function rewardList(sc, rw) {
    var labels = {
      founder: uiText(sc, "label_reward_founder", L().rewardFounder),
      participate: uiText(sc, "label_reward_participate", L().rewardParticipate),
      defeat: uiText(sc, "label_reward_defeat", L().rewardDefeat),
      rank: uiText(sc, "label_reward_rank", L().rewardRank)
    };
    var out = [];
    for (var k = 0; k < REWARD_KEYS.length; k++) {
      var arr = rw && Array.isArray(rw[REWARD_KEYS[k]]) ? rw[REWARD_KEYS[k]] : [];
      for (var i = 0; i < arr.length; i++) if (arr[i] && typeof arr[i] === "object") out.push({ code: arr[i], label: labels[REWARD_KEYS[k]], group: k });
    }
    return out;
  }
  /** 一列的卡面。官方 create_card 找不到時退回寫名字（獎勵一樣都不能漏）。 */
  function drawRewards(st, sc, list, cy, D, body) {
    var right = ROW.right - 6;
    if (!list.length) {
      body.push(sc.add.text(CARD.x0, cy, "-", valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
      return;
    }
    var T = cardFactory(st);
    if (T === null) {
      var names = list.map(function (r) { return itemName(sc, r.code); });
      body.push(sc.add.text(CARD.x0, cy, names.join(" / "), { fontFamily: FONT, fontSize: 11, resolution: 2, wordWrap: { width: right - CARD.x0 } }).setOrigin(0, 0.5).setDepth(D + 2));
      return;
    }
    var scale = CARD.h / 240, cw = Math.round(168 * scale);
    // 分類之間多空一點；放不下就把間距縮到疊在一起（像手牌）
    var groups = 0;
    for (var g = 1; g < list.length; g++) if (list[g].group !== list[g - 1].group) groups++;
    var room = right - CARD.x0 - cw - groups * CARD.gap;
    var step = list.length > 1 ? Math.min(CARD.step, room / (list.length - 1)) : CARD.step;
    var x = CARD.x0 + cw / 2;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (i > 0) x += step + (r.group !== list[i - 1].group ? CARD.gap : 0);
      var c = r.code, card = null;
      try { card = T.create_card(sc, c.id, c.type, c.slot, x, cy, {}); } catch (e) { card = null; }
      var name = itemName(sc, c);
      if (card) {
        card.setScale(scale).setDepth(D + 2 + i * 0.01);
        body.push(card);
        // 數量標在卡的右下角（縮小的卡面上看不清）
        if (c.value > 1 || c.type === CFG.rewardTypes.gem) {
          body.push(sc.add.text(x + cw / 2 + 1, cy + CARD.h / 2 + 1, "x" + c.value, valueStyle()).setOrigin(1, 1).setStroke("black", 3).setDepth(D + 3));
        }
      } else {
        body.push(sc.add.text(x, cy, name, { fontFamily: FONT, fontSize: 10, resolution: 2, wordWrap: { width: cw } }).setOrigin(0.5, 0.5).setDepth(D + 2));
      }
      var hit = sc.add.zone(x, cy, cw, CARD.h).setDepth(D + 4).setInteractive();
      hoverTip(sc, hit, r.label + "  " + name, D + 6, body);
      body.push(hit);
    }
  }
  function drawRow(st, sc, e, raw, top, D, body) {
    var cy = top + ROW.h / 2;
    body.push(sc.rexUI.add.roundRectangle(ROW.left, top, ROW.right - ROW.left, ROW.h, 2, 0xffffff, 0.08).setOrigin(0, 0).setDepth(D + 2));
    var name = e.prf && e.prf !== e.boss ? "\\uff62" + e.prf + "\\uff63" + e.boss : e.boss || e.prf;
    body.push(fit(sc.add.text(INFO_X, top + 12, name, labelStyle()).setStroke("black", 3).setOrigin(0, 0.5).setDepth(D + 3), INFO_W));
    var rank = e.rank === null ? "-" : L().rank.replace("__RANK__", e.rank.toLocaleString()).replace("__DMG__", e.dmg === null ? "-" : e.dmg.toLocaleString());
    body.push(fit(sc.add.text(INFO_X, top + 29, rank, valueStyle()).setOrigin(0, 0.5).setDepth(D + 3), INFO_W));
    var founder = uiText(sc, "label_founder", L().founder) + "  " + e.founder;
    body.push(fit(sc.add.text(INFO_X, top + 45, founder, { fontFamily: FONT, fontSize: 10, color: "#bdbdbd", resolution: 2 }).setOrigin(0, 0.5).setDepth(D + 3), INFO_W));
    drawRewards(st, sc, rewardList(sc, raw && raw.raid_reward), cy, D, body);
  }
  /** 底下的翻頁列：照官方排行頁（btn_arrow-2、「1 / N」、到頭繞回去）。只有一頁就不畫。 */
  function addPager(sc, D, objs, pages, onPage) {
    if (pages <= 1) return;
    var y = PT + 284, page = 0;
    var cur = sc.add.text(P.x - 20, y, "1", valueStyle()).setOrigin(0.5, 0.5).setDepth(D + 2);
    objs.push(sc.add.text(P.x, y, "/", valueStyle()).setOrigin(0.5, 0.5).setDepth(D + 2), cur,
      sc.add.text(P.x + 20, y, String(pages), valueStyle()).setOrigin(0.5, 0.5).setDepth(D + 2));
    var tex = sc.textures.exists("btn_arrow-2") ? "btn_arrow-2" : sc.textures.exists("btn_arrow") ? "btn_arrow" : null;
    [[-1, P.x - 60, 1], [1, P.x + 60, 0]].forEach(function (a) {
      var dir = a[0], btn;
      if (tex !== null) {
        btn = sc.add.image(a[1], y, tex, 0).setOrigin(a[2], 0.5).setFlipX(dir > 0);
        btn.on("pointerover", function () { btn.setTexture(tex, 1); });
        btn.on("pointerout", function () { btn.setTexture(tex, 0); });
      } else {
        btn = sc.add.text(a[1], y, dir < 0 ? "\\u2039" : "\\u203a", labelStyle()).setOrigin(a[2], 0.5);
      }
      btn.setDepth(D + 3).setInteractive({ useHandCursor: true });
      btn.on("pointerup", function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        page = (page + dir + pages) % pages;
        cur.setText(String(page + 1));
        onPage(page);
      });
      objs.push(btn);
    });
  }
  function fadeIn(sc, list) {
    if (!sc.tweens || typeof sc.tweens.add !== "function") return;
    var targets = list.filter(function (o) { return alive(o) && o.type !== "Zone"; });
    for (var i = 0; i < targets.length; i++) { targets[i].y -= 8; targets[i].setAlpha(0); }
    sc.tweens.add({ targets: targets, alpha: 1, y: "+=8", duration: 300, ease: "Power3" });
  }
  /** 一張面板列完這一批所有渦，一顆 OK。raw 是官方給的原始清單（獎勵碼畫卡面用）。 */
  function showSummary(st, sc, entries, raw) {
    return new Promise(function (resolve) {
      closePanel(st);
      var D = 2500;
      var objs = [], body = [];
      objs.push(sc.add.zone(380, 340, 760, 680).setDepth(D).setInteractive());
      if (sc.textures.exists("raid_result_panel")) objs.push(sc.add.image(P.x, P.y, "raid_result_panel").setDepth(D + 1));
      else objs.push(sc.rexUI.add.roundRectangle(P.x, P.y, P.w, P.h, 2, 0x313134, 1).setDepth(D + 1).setStrokeStyle(1, 0x444447));
      if (sc.textures.exists("result_panel_overlay")) {
        var over = sc.add.image(P.x, P.y, "result_panel_overlay").setDepth(D + 1);
        if (typeof over.setCrop === "function") over.setCrop(0, 0, 116, P.h);
        objs.push(over);
      }
      var pages = Math.max(1, Math.ceil(entries.length / ROW.per));
      var draw = function (page) {
        destroyAll(body);
        for (var j = 0; j < ROW.per; j++) {
          var q = page * ROW.per + j;
          if (q >= entries.length) break;
          drawRow(st, sc, entries[q], raw[q], ROW.top + j * (ROW.h + ROW.gap), D, body);
        }
      };
      var ok;
      if (sc.textures.exists("raid_panel_ok")) {
        ok = sc.add.image(P.x, PT + 316, "raid_panel_ok", 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
        ok.on("pointerover", function () { ok.setTexture("raid_panel_ok", 1); });
        ok.on("pointerout", function () { ok.setTexture("raid_panel_ok", 0); });
        ok.on("pointerdown", function () { ok.setTexture("raid_panel_ok", 0); });
      } else {
        ok = sc.add.text(P.x, PT + 316, "OK", { fontFamily: "font_heavy", fontSize: 15, color: "white", resolution: 2 }).setOrigin(0.5, 0.5).setDepth(D + 3).setStroke("black", 3).setInteractive({ useHandCursor: true });
      }
      ok.on("pointerup", function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        closePanel(st);
        resolve();
      });
      objs.push(ok);
      st.panel = { objs: objs, body: body };
      draw(0);
      addPager(sc, D, objs, pages, draw);
      fadeIn(sc, objs.concat(body));
    });
  }

  // ---- 包 show_raid_reward 與三個畫面方法 -----------------------------------
  var MAIN = "show_raid_reward";
  var PAGES = ["create_reward_init", "create_reward_image", "create_reward_rank"];
  var METHODS = [MAIN].concat(PAGES);

  /** 官方流程跑完之後：回報一行、記下收到了、照模式畫摘要／重播官方畫面。 */
  function afterBatch(st, sc, batch) {
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
    // 整理失敗（entries 是空的）就不畫：領取早就回報了，記錄檔也有一行
    if (entries.length !== batch.list.length) return Promise.resolve();
    return showSummary(st, sc, entries, batch.list);
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
        return afterBatch(st, self, batch).then(function () { return r; });
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
  var st = { version: CFG.version, mode: CFG.mode, panel: null, proto: null, timer: null, reason: null, ledger: null, batching: false, T: undefined };
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
    if (st.panel) {
      (st.panel.body || []).concat(st.panel.objs).forEach(function (o) { try { if (o && o.scene) o.destroy(); } catch (e) {} });
    }
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
