/**
 * 任務地圖的寶箱標註
 * ==================
 * 玩家 2026-09-26：任務地圖每一格旁邊標出寶箱**實際是什麼**（可開關）。
 *
 * 官方只畫寶箱的**種類**圖示（紅箱、綠箱、Gem 袋、Exp 泡泡……），內容要踩到才知道 ——
 * 客戶端的 QuestLands 每格只有 treasure_no，內容表在伺服器上，伺服器也只在踩到時送
 * quest_reward。內容表用原版 Unlight 開源碼的 TreasureDatas.csv（見 quest-treasure-data.ts），
 * 2026-09-26 對過客戶端用到的 675 種 treasure_no 只缺 1 種。**不送任何請求。**
 *
 * ## 畫法（2026-09-26 從跑著的客戶端讀的）
 *
 * ```js
 *   // Quest.show_quest_land(quest_id)：5 列 x 3 欄
 *   quest_land_image["列_欄"] = { land_base, land_image, land_mons, land_event, land_next }
 *   land_base = add.image(128 + 96 * 欄, 95 + 72 * 列, "QuestLandImages", "map_base")  // 80x64，origin (0.5, 0)
 *   Quests 那一列的 quest_land_id_列_欄 → QuestLands.treasure_no
 * ```
 *
 * - 卡面用**官方畫獎勵的同一支** `$T.create_card(scene, id, type, slot, x, y, opts)`（quest_reward
 *   翻開獎勵用的就是它），縮到 0.2 倍放在格子右邊。角色卡、武器／事件卡、道具都畫卡面
 * - Gem 與花（白色石楠，道具 5／6／7）改寫字「100Gem」「花3」：縮小的卡面上數字看不清
 *   （玩家 2026-09-27）
 * - 6（OwnCard，官方泡泡是「Exp」）：給**牌頭同角色、等級 -1 的 L 卡**（R 當 L 算，L1／R1 給 L1）。
 *   玩家 2026-09-26 實測：牌頭 R5 史普拉多 → L4 史普拉多、L5 → L4。原版伺服器是「value 那一級」
 *   （OwnCard1 給 L1），ULR 改過，照玩家實測的畫。牌頭＝目前牌組第一張；L 卡＝CharaCards 同 chara、
 *   kind 0、rarity ≤ 5、level 對得上的那張
 * - 7（獎勵遊戲，官方泡泡是「High Low」）：value 是等級。標「Lv4」，學到開始星數的話下一行
 *   標「★27」（學到好幾個不同值就標範圍）。見 quest-bonus.ts
 * - 「分配」格（TreasureDatas 的 allocation_type 1）：原版伺服器看的是**目前牌組的 COST**
 *   （treasure_data.rb 的 get_treasure：1~55 一檔、56~75 一檔、76 以上一檔）。照目前牌組
 *   （scene.deck 裡 deck_id = deck_now 那副的 cost）畫那一檔，卡片下面標 COST 區間；
 *   讀不到 COST 就畫第一檔、標「?」
 * - 走過的格子（quest_cleared）不畫 —— 官方的寶箱圖示在那些格子上也藏起來
 *
 * ## 是哪一個任務
 *
 * 包場景實例的 show_quest_land 記下參數。包之前就開著的地圖退回比名字：地圖上方的任務名
 * 對玩家任務清單（加上進行中的那一個）。
 *
 * ## 找 create_card
 *
 * 模組 id 每次改版都會變，從 webpack 的模組表掃特徵字串（create_card 與 TG_BASE_UP）。
 *
 * ## 學開始星數（不管標註開不開都學）
 *
 * 包 Bonus 場景實例的 initialize（官方 create 的最後叫它，那時 bonus_data 剛從 db_bonusgame
 * 拿到、玩家還沒動）：記下 bonus_data.step。是哪一級看 Quest 場景 —— 任務進行中、人物
 * （unit_chara，站在 128+96*欄, 129+72*列）站的那一格是 HighLow 才算，其他來源的獎勵遊戲
 * （對戰）不記。記到就經 binding 回報 { type: "quest-bonus", sample }。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";
import type { QuestBonusStats } from "./quest-bonus.js";
import { QUEST_TREASURE_TABLE } from "./quest-treasure-data.js";

const FLAG = "__ulrQuestTreasure";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const QUEST_TREASURE_SCRIPT_VERSION = 4;

export interface QuestTreasurePatchOptions {
  /** 標註開不開。 */
  enabled: boolean;
  /** 回報學到的開始星數用的 binding。沒給就只標不學。 */
  bindingName?: string;
  /** 已經學到的開始星數（每個等級的最小／最大 step）。 */
  bonusStats?: QuestBonusStats;
}

export interface QuestTreasureStatus {
  installed: boolean;
  version: number | null;
  enabled: boolean;
  /** 找到官方的 create_card 了沒。 */
  found: boolean;
  /** 任務地圖現在開著、標上了。 */
  onMap: boolean;
  /** 標了幾格。 */
  marks: number;
  /** 這次裝上之後回報了幾筆開始星數。 */
  learned: number;
  reason: string | null;
}

export function buildQuestTreasurePatchScript(options: QuestTreasurePatchOptions): string {
  const config = {
    version: QUEST_TREASURE_SCRIPT_VERSION,
    enabled: options.enabled,
    pollMs: 500,
    findEveryMs: 2000,
    // 格子（map_base，origin 0.5,0）的右邊：卡片中心相對 land_base 的位置。
    // 官方的泡泡（Exp、High Low、寶箱）在 land_base 上方 +17 以內，卡片頂在 +16 才不蓋到它
    dx: 34,
    dy: 40,
    scale: 0.2,
    depth: 18,
    // 分配格的 COST 區間字：卡片（0.2 倍約 34x48）正下方
    tagDy: 24,
    tagFont: 10,
    // HighLow 格的「Lv4 / ★27」：兩行字，中心在卡片的位置
    lvFont: 12,
    lvDy: -8,
    starDy: 8,
    // 白色石楠（道具 5／6／7）→ 標「花1／花3／花5」
    flowers: { 5: 1, 6: 3, 7: 5 },
    table: QUEST_TREASURE_TABLE,
    bindingName: options.bindingName ?? null,
    bonusStats: options.bonusStats ?? {},
    // 人物（unit_chara）站的位置 → 格子
    unitX0: 128,
    unitY0: 129,
    landW: 96,
    landH: 72,
  };

  return `(function () {
  "use strict";
  ${WEBPACK_REQUIRE_SNIPPET}
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function alive(o) { return !!(o && o.scene); }
  function safeDestroy(o) { try { if (alive(o)) o.destroy(); } catch (e) {} }
  function running(sc) {
    try { return !!(sc && sc.scene && sc.scene.isActive() && !sc.scene.isSleeping()); } catch (e) { return false; }
  }
  function questScene() {
    var G = window.game;
    var Q = G && G.scene && G.scene.keys ? G.scene.keys.Quest : null;
    return running(Q) ? Q : null;
  }
  function json(Q, key) { try { return Q.cache.json.get(key); } catch (e) { return null; } }
  function findRow(arr, id) {
    if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }

  // ---- 官方的 create_card ----------------------------------------------------
  function findCards() {
    var req = ulrWebpackRequire();
    if (req === null) return null;
    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (src.indexOf("create_card(") === -1 || src.indexOf("TG_BASE_UP") === -1) continue;
      var mod;
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var v = mod[k];
        if (v && typeof v === "object" && typeof v.create_card === "function") return v;
      }
    }
    return null;
  }

  // ---- 是哪一個任務 ------------------------------------------------------------
  function hook(st, Q) {
    var cur = Q.show_quest_land;
    if (typeof cur !== "function" || cur.__ulrQuestTreasure === st) return;
    var had = Object.prototype.hasOwnProperty.call(Q, "show_quest_land");
    var w = function (questId) {
      if (window[FLAG] === st) st.questId = questId;
      return cur.apply(this, arguments);
    };
    w.__ulrQuestTreasure = st;
    w.__ulrOrig = cur;
    w.__ulrHad = had;
    Q.show_quest_land = w;
    st.hooked = Q;
  }
  function unhook(st) {
    var Q = st.hooked;
    st.hooked = null;
    if (!Q) return;
    var w = Q.show_quest_land;
    if (!w || w.__ulrQuestTreasure !== st) return;
    if (w.__ulrHad) Q.show_quest_land = w.__ulrOrig; else delete Q.show_quest_land;
  }
  function questIdOf(st, Q) {
    if (typeof st.questId === "number") return st.questId;
    // 包之前就開著的地圖：地圖上方的任務名對玩家的任務
    var name = alive(Q.quest_land_name) ? Q.quest_land_name.text : null;
    if (!name) return null;
    var Qs = json(Q, "Quests");
    var ids = [];
    try { if (Q.quest && Q.quest.current_quest_id) ids.push(Q.quest.current_quest_id); } catch (e) {}
    try { (Q.quest_data || []).forEach(function (q) { if (q && q.quest_id) ids.push(q.quest_id); }); } catch (e) {}
    for (var i = 0; i < ids.length; i++) {
      var row = findRow(Qs, ids[i]);
      if (row && row.name_tcn === name) return ids[i];
      for (var k in row || {}) if (k.indexOf("name_") === 0 && row[k] === name) return ids[i];
    }
    return null;
  }

  // ---- 畫 --------------------------------------------------------------------
  /** 目前牌組的 COST。讀不到是 null。 */
  function deckCost(Q) {
    try {
      var list = Q.deck;
      if (!Array.isArray(list)) return null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].deck_id === Q.deck_now && typeof list[i].cost === "number") return list[i].cost;
      }
    } catch (e) {}
    return null;
  }
  /** 分配格：照 COST 挑那一檔，回 [treasure_no, 標在卡片下面的字]。 */
  function pickAlloc(opts, cost) {
    if (cost === null) return [opts[0][1], "?"];
    var lo = 1;
    for (var i = 0; i < opts.length; i++) {
      var hi = opts[i][0];
      if (cost <= hi || i === opts.length - 1) {
        var tag = i === opts.length - 1 ? "C" + lo + "+" : "C" + lo + "-" + hi;
        return [opts[i][1], tag];
      }
      lo = hi + 1;
    }
    return [opts[0][1], "?"];
  }
  function resolve(tno, cost) {
    var e = CFG.table[tno];
    if (!e) return null;
    if (e[3] && e[3].length) {
      var pick = pickAlloc(e[3], cost);
      var inner = CFG.table[pick[0]];
      if (!inner || inner[3]) return null;
      return { type: inner[0], value: inner[1], slot: inner[2], tag: pick[1] };
    }
    return { type: e[0], value: e[1], slot: e[2], tag: null };
  }
  /** 目前牌組的第一張角色卡（牌頭）。 */
  function leaderCard(Q) {
    try {
      var list = Q.deck;
      for (var i = 0; list && i < list.length; i++) {
        if (list[i] && list[i].deck_id === Q.deck_now) return findRow(json(Q, "CharaCards"), list[i].chara_card_id[0]);
      }
    } catch (e) {}
    return null;
  }
  /** OwnCard（Exp 格）會給的卡：牌頭同角色、等級 -1（最低 1）的 L 卡。找不到是 null。 */
  function ownCardId(Q) {
    var lead = leaderCard(Q);
    if (!lead) return null;
    var lv = Math.max(1, lead.level - 1);
    var all = json(Q, "CharaCards") || [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c && c.chara === lead.chara && c.kind === 0 && c.rarity <= 5 && c.level === lv) return c.id;
    }
    return null;
  }
  function drawable(Q, info) {
    if (info.type === 1) return findRow(json(Q, "CharaCards"), info.value) !== null;
    if (info.type === 6) return ownCardId(Q) !== null;
    return info.type === 2 || info.type === 3 || info.type === 5 || info.type === 7;
  }
  function label(Q, x, y, text, size) {
    return Q.add.text(x, y, text, { fontFamily: "font_light", fontSize: size, resolution: 2 })
      .setOrigin(0.5, 0.5).setStroke("black", 3).setDepth(CFG.depth + 1);
  }
  function textMark(Q, info, x, y, text) {
    // 分配格的 COST 區間排第二行，跟 HighLow 的兩行同位置
    if (!info.tag) return [label(Q, x, y, text, CFG.lvFont)];
    return [label(Q, x, y + CFG.lvDy, text, CFG.lvFont), label(Q, x, y + CFG.starDy, info.tag, CFG.tagFont)];
  }
  function makeMark(st, Q, info, x, y) {
    // Gem 與花：卡面縮小後數字看不清，直接寫字
    if (info.type === 5) return textMark(Q, info, x, y, info.value + "Gem");
    if (info.type === 3 && CFG.flowers[info.value]) return textMark(Q, info, x, y, "花" + CFG.flowers[info.value]);
    if (info.type === 7) {
      // HighLow：等級，學到的話下一行開始星數
      var out7 = [label(Q, x, y + CFG.lvDy, "Lv" + info.value, CFG.lvFont)];
      var s = st.bonus[info.value];
      if (s && s.n > 0) {
        out7.push(label(Q, x, y + CFG.starDy, s.min === s.max ? "★" + s.min : "★" + s.min + "-" + s.max, CFG.lvFont));
      }
      return out7;
    }
    var id = info.type === 6 ? ownCardId(Q) : info.value;
    var type = info.type === 6 ? 1 : info.type;
    var slot = info.type === 6 ? 1 : info.slot;
    var opts = { quantity: info.type === 5 ? info.value : 1 };
    var card = st.T.create_card(Q, id, type, slot, x, y, opts);
    if (!card) return [];
    card.setScale(CFG.scale).setDepth(CFG.depth);
    var out = [card];
    if (info.tag) {
      // 分配格：卡片正下方標 COST 區間
      out.push(Q.add.text(x, y + CFG.tagDy, info.tag, { fontFamily: "font_light", fontSize: CFG.tagFont, resolution: 2 })
        .setOrigin(0.5, 0).setStroke("black", 3).setDepth(CFG.depth + 1));
    }
    return out;
  }

  function clear(st) {
    for (var i = 0; i < st.mine.length; i++) safeDestroy(st.mine[i]);
    st.mine = [];
    st.marks = 0;
    st.anchor = null;
    st.sig = null;
  }

  function lands(Q) {
    var out = [];
    var img = Q.quest_land_image;
    if (!img || typeof img !== "object") return out;
    for (var key in img) {
      var rec = img[key];
      if (rec && alive(rec.land_base)) out.push({ key: key, base: rec.land_base });
    }
    return out;
  }
  function clearedSet(Q) {
    var s = {};
    try {
      (Q.quest_cleared || []).forEach(function (c) { s[c.land_row + "_" + c.land_column] = true; });
    } catch (e) {}
    return s;
  }

  function sync(st) {
    var Q = st.enabled && st.T ? questScene() : null;
    if (Q !== null) hook(st, Q);
    var ls = Q !== null ? lands(Q) : [];
    if (ls.length === 0) { if (st.mine.length || st.anchor) clear(st); return; }
    var qid = questIdOf(st, Q);
    var quest = qid !== null ? findRow(json(Q, "Quests"), qid) : null;
    if (quest === null) { if (st.mine.length) clear(st); return; }
    var done = clearedSet(Q);
    var cost = deckCost(Q);
    var lead = leaderCard(Q);
    var sig = qid + "|" + cost + "|" + (lead ? lead.id : "-") + "|" + JSON.stringify(st.bonus) + "|" +
      Object.keys(done).sort().join(",");
    var intact = st.mine.every(alive);
    if (st.anchor === ls[0].base && st.sig === sig && intact) return;
    clear(st);
    var L = json(Q, "QuestLands");
    for (var i = 0; i < ls.length; i++) {
      var key = ls[i].key;
      if (done[key]) continue;
      var land = findRow(L, quest["quest_land_id_" + key]);
      if (!land || !(land.treasure_no > 0)) continue;
      var info = resolve(land.treasure_no, cost);
      if (info === null || !drawable(Q, info)) continue;
      try {
        var made = makeMark(st, Q, info, ls[i].base.x + CFG.dx, ls[i].base.y + CFG.dy);
        if (made.length) { st.mine = st.mine.concat(made); st.marks++; }
      } catch (e) {
        st.reason = "畫不出 " + land.treasure_no + "：" + String((e && e.message) || e);
      }
    }
    st.anchor = ls[0].base;
    st.sig = sig;
  }

  // ---- 學開始星數 --------------------------------------------------------------
  function report(payload) {
    try {
      var fn = CFG.bindingName ? window[CFG.bindingName] : null;
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  /** 人物站的那一格是 HighLow 的話回 { level, quest, land }，不然 null。 */
  function bonusLand() {
    var G = window.game;
    var Q = G && G.scene && G.scene.keys ? G.scene.keys.Quest : null;
    if (!Q || !alive(Q.unit_chara)) return null;
    var qid = Q.quest && Q.quest.current_quest_id;
    if (typeof qid !== "number") return null;
    var col = Math.round((Q.unit_chara.x - CFG.unitX0) / CFG.landW);
    var row = Math.round((Q.unit_chara.y - CFG.unitY0) / CFG.landH);
    if (col < 0 || col > 2 || row < 0 || row > 4) return null;
    var key = row + "_" + col;
    var quest = findRow(json(Q, "Quests"), qid);
    var land = quest ? findRow(json(Q, "QuestLands"), quest["quest_land_id_" + key]) : null;
    var e = land ? CFG.table[land.treasure_no] : null;
    if (!e || e[0] !== 7 || !(e[1] >= 1 && e[1] <= 8)) return null;
    return { level: e[1], quest: qid, land: key };
  }
  function learnBonus(st, B) {
    var data = B.bonus_data;
    if (!data || typeof data.step !== "number" || st.lastBonus === data) return;
    st.lastBonus = data;
    var where = bonusLand();
    if (where === null) return;
    st.learned++;
    report({ type: "quest-bonus", sample: { level: where.level, step: data.step, quest: where.quest,
      land: where.land, at: Date.now() } });
  }
  function hookBonus(st) {
    var G = window.game;
    var B = G && G.scene && G.scene.keys ? G.scene.keys.Bonus : null;
    if (!B) return;
    var cur = B.initialize;
    if (typeof cur !== "function" || cur.__ulrQuestTreasure === st) return;
    var had = Object.prototype.hasOwnProperty.call(B, "initialize");
    var w = function () {
      // 官方 initialize 之前：bonus_data 剛拿到、玩家還沒動，step 就是開始的星數
      try { if (window[FLAG] === st) learnBonus(st, this); } catch (e) {}
      return cur.apply(this, arguments);
    };
    w.__ulrQuestTreasure = st;
    w.__ulrOrig = cur;
    w.__ulrHad = had;
    B.initialize = w;
    st.bonusHooked = B;
  }
  function unhookBonus(st) {
    var B = st.bonusHooked;
    st.bonusHooked = null;
    if (!B) return;
    var w = B.initialize;
    if (!w || w.__ulrQuestTreasure !== st) return;
    if (w.__ulrHad) B.initialize = w.__ulrOrig; else delete B.initialize;
  }

  function tick(st) {
    if (window[FLAG] !== st) return;
    try {
      if (st.T === null && Date.now() >= st.nextFind) {
        st.nextFind = Date.now() + CFG.findEveryMs;
        st.T = findCards();
      }
      hookBonus(st);
      sync(st);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  function restore() {
    var old = window[FLAG];
    if (!old) return;
    try { if (old.timer) clearInterval(old.timer); } catch (e) {}
    try { clear(old); } catch (e) {}
    try { unhook(old); } catch (e) {}
    try { unhookBonus(old); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = {
    version: CFG.version,
    enabled: CFG.enabled,
    T: null,
    nextFind: 0,
    timer: null,
    hooked: null,
    questId: null,
    anchor: null,
    sig: null,
    mine: [],
    marks: 0,
    bonus: CFG.bonusStats,
    bonusHooked: null,
    lastBonus: null,
    learned: 0,
    reason: null
  };
  window[FLAG] = st;
  st.clear = function () { clear(st); };
  st.unhook = function () { unhook(st); unhookBonus(st); };
  tick(st);
  st.timer = setInterval(function () { tick(st); }, CFG.pollMs);
  return JSON.stringify({ installed: true, version: st.version, enabled: st.enabled, found: st.T !== null,
    onMap: st.anchor !== null, marks: st.marks, learned: st.learned, reason: st.reason });
})()`;
}

export const QUEST_TREASURE_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false });
    return JSON.stringify({ installed: true, version: st.version, enabled: st.enabled, found: st.T !== null,
      onMap: st.anchor !== null, marks: st.marks, learned: st.learned || 0, reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, reason: String((e && e.message) || e) });
  }
})()`;

/** 開關標註。下一輪（0.5 秒內）畫上或拆掉。回 `"ok"` 或 `"not-installed"`。 */
export function buildQuestTreasureSetExpression(on: boolean): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.enabled = ${on ? "true" : "false"};
    if (!st.enabled && typeof st.clear === "function") st.clear();
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 推學到的開始星數下去，下一輪重畫。回 `"ok"` 或 `"not-installed"`。 */
export function buildQuestTreasureSetBonusExpression(stats: QuestBonusStats): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.bonus = JSON.parse(${embedJson(stats)});
    st.sig = null;
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 拆掉：停輪詢、拆標註、show_quest_land 與 Bonus.initialize 還原。 */
export const QUEST_TREASURE_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    try { if (typeof st.clear === "function") st.clear(); } catch (e) {}
    try { if (typeof st.unhook === "function") st.unhook(); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseQuestTreasureStatus(raw: string): QuestTreasureStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      enabled: false,
      found: false,
      onMap: false,
      marks: 0,
      learned: 0,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    enabled: o.enabled === true,
    found: o.found === true,
    onMap: o.onMap === true,
    marks: typeof o.marks === "number" ? o.marks : 0,
    learned: typeof o.learned === "number" ? o.learned : 0,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
