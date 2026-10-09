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
 * ## 寶箱面板與任務結束的確認框：自動按 OK／不顯示（玩家 2026-10-08）
 *
 * 兩組分開設（玩家：「任務結束的兩個確認框，功能和寶箱確認框選項分開」），各自
 * show（照官方）／auto（看一下就替玩家按）／hide（不顯示直接關），也跟標註分開。
 * 2026-10-08 從 bundle 讀的官方流程：
 *
 * ```js
 *   // 踩到寶箱：Quest.quest_reward()
 *   await update_data("chara_card"), update_data("player")
 *   quest_reward_base  = add.image(380, 330, "quest_result_item").setAlpha(0)   // 淡入 500ms
 *   quest_reward_ok    = add.image(380, 470, "search_ok", 0).setInteractive()
 *   quest_reward_image = $T.create_card(...)                                    // 500ms 後翻開、播 ulse23
 *   await new Promise(r => quest_reward_ok.on("pointerup", () => { 淡出 300ms → 全拆 → r() }))
 *   // 接著 refresh_quest_land：quest_end_result 不是 null 就 await quest_end()
 *
 *   // 任務結束：Quest.quest_end()（「任務成功／失敗」）
 *   quest_end_base = add.image(380, 330, "quest_result_suc" 或 "quest_result_fail").setAlpha(0)
 *   quest_end_ok   = add.image(380, 382, "search_ok", 0)       // 淡入 300ms，onComplete 才 setInteractive
 *   await pointerup → 淡出 300ms → 拆 → 接著 play_quest_story()
 *
 *   // 新任務：socket "quest_added" → show_quest_found_dialog(id)（跟搜尋到任務同一個框）
 *   quest_found_bg / quest_found_dialog / quest_found_ok_btn / quest_found_ok_text   // 沒有 tween，按了就拆
 * ```
 *
 * 三個 OK **都不送任何請求**，只是拆面板。所以跟獎勵遊戲的「結束後直接回去」一樣，
 * 替玩家 emit("pointerup")，走官方同一條路。
 *
 * - 面板是在兩格之間建的（socket 回應後的 microtask），掛 game 的 prestep：下一格的 tween 與
 *   render 之前就看到它
 * - auto：面板照常淡入（結束面板要等官方 setInteractive），rewardAutoMs／endAutoMs 後替玩家按
 * - hide：當格停掉淡入與翻卡（不播音效）、藏起來、按 OK，官方的淡出 tween 當場跑完
 *   （onComplete 拆面板、放行後面的流程）。一格都不會畫出來
 * - 只按「還按得下去」的 OK：玩家自己先按了，官方會 disableInteractive（input 還在、enabled
 *   false），再 emit 一次會讓 onComplete 拆兩次而炸掉。結束面板淡入時 input 是 null，不算按過
 * - 新任務框只跳「任務剛結束時 quest_added 帶來的」：同一刻收到 quest_added（自己在 socket 上
 *   多掛一個 listener 記時間），而且 quest_end 收到不久或結束面板還開著。搜尋找到任務（socket
 *   "quest_found"）同一個框照常顯示
 *
 * ## 打完怪物跳過結算（玩家 2026-10-08：「打完怪物後，跳過結算，直接回到任務地圖」）
 *
 * 任務戰鬥打完，MainA 會 scene.start("Result")。Result（2026-10-08 讀的）：
 *
 * ```js
 *   create() { await call_win/lose/draw/timeup()   // 勝負字樣＋立繪，約 3 秒
 *              await (bonusgame === false ? result_end_nornal() : result_end_bonus())  // 數字逐項淡入，OK
 *              events.once("shutdown", shutdown) }
 *   OK → result_scene_end()：lvup 不是 null 先播升級；鏡頭（含 BackA）淡出 700ms 後 stop；
 *        Quest 在睡就叫醒、fetch db_quest／db_quest_cleared、refresh_quest_land（＝回任務地圖）
 * ```
 *
 * 在 Result 實例上包 create：Quest 在睡（＝任務戰鬥）、沒有獎勵遊戲時，不跑那兩段動畫，
 * 掛好 shutdown 直接叫官方的 result_scene_end —— 回地圖、重拿任務資料都是官方原樣，
 * 不多送請求。沒升級就把 Result 與 BackA 的鏡頭先藏起來（官方本來就淡到 0 再 stop），
 * 地圖在下一格直接露出來；有升級照常看得到升級動畫。
 * 有獎勵遊戲的不碰：Bonus 疊在 Result 上，結束時 result_end_bonus_quit 會改 Result 的
 * gem_card 等欄位，收掉 create 那些欄位就不存在了。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";
import type { QuestBonusStats } from "./quest-bonus.js";
import { QUEST_TREASURE_TABLE } from "./quest-treasure-data.js";

const FLAG = "__ulrQuestTreasure";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const QUEST_TREASURE_SCRIPT_VERSION = 6;

/** 確認框怎麼處理：`show` 照官方、`auto` 看一下就自動按 OK、`hide` 不顯示直接關。 */
export type QuestPanelMode = "show" | "auto" | "hide";

/** 哪一組確認框：`reward` 寶箱內容、`end` 任務結束（成功／失敗＋新任務）。 */
export type QuestPanelPart = "reward" | "end";

export const QUEST_PANEL_MODES: readonly QuestPanelMode[] = ["show", "auto", "hide"];

export function isQuestPanelMode(v: unknown): v is QuestPanelMode {
  return v === "show" || v === "auto" || v === "hide";
}

export interface QuestTreasurePatchOptions {
  /** 標註開不開。 */
  enabled: boolean;
  /** 寶箱內容面板怎麼處理。預設 `show`（照官方）。 */
  reward?: QuestPanelMode;
  /** 任務結束的確認框（成功／失敗、新任務）怎麼處理。預設 `show`。 */
  end?: QuestPanelMode;
  /** 任務打完怪物跳過結算、直接回任務地圖。預設關。 */
  skipResult?: boolean;
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
  /** 寶箱內容面板的處理方式。 */
  reward: QuestPanelMode;
  /** 任務結束確認框的處理方式。 */
  end: QuestPanelMode;
  /** 這次裝上之後替玩家按了幾次寶箱面板的 OK。 */
  rewardPressed: number;
  /** 這次裝上之後替玩家按了幾次任務結束確認框的 OK。 */
  endPressed: number;
  /** 打完怪物跳過結算開著沒。 */
  skipResult: boolean;
  /** 這次裝上之後跳過了幾次結算。 */
  resultSkips: number;
  reason: string | null;
}

export function buildQuestTreasurePatchScript(options: QuestTreasurePatchOptions): string {
  const config = {
    version: QUEST_TREASURE_SCRIPT_VERSION,
    enabled: options.enabled,
    reward: options.reward ?? "show",
    end: options.end ?? "show",
    skipResult: options.skipResult === true,
    // auto：面板淡入 500ms、卡片 500ms 後翻開 250ms，翻完再留一下才按
    rewardAutoMs: 1500,
    // auto：結束面板從可以按（淡入完）起算、新任務框從出現起算
    endAutoMs: 1200,
    // 新任務框：quest_added 跟框出現差多少內算同一件事；quest_end 收到後多久內算「剛結束」
    addedMs: 2000,
    endWindowMs: 60000,
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

  // ---- 寶箱面板與任務結束的確認框：自動按 OK／不顯示 ------------------------------
  /** 官方的 tween 一支只跑完一次（complete 沒擋重複，onComplete 跑兩次會拆兩次）。 */
  function finishTweens(Q, parts) {
    var done = [];
    var list = [];
    try { list = Q.tweens.getTweensOf(parts) || []; } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || done.indexOf(t) !== -1) continue;
      done.push(t);
      try { if (!(t.isPendingRemove && t.isPendingRemove()) && !(t.isDestroyed && t.isDestroyed())) t.complete(); } catch (e) {}
    }
  }
  /** 這顆 OK 還沒被按過。玩家按過的話官方已經 disableInteractive（input 還在、enabled false）。 */
  function pressable(ok) {
    return alive(ok) && !ok.__ulrQuestPressed && !(ok.input && ok.input.enabled === false);
  }
  /** 第一次看到這顆 OK 的時刻。 */
  function firstSeen(st, key, ok) {
    var s = st.seen[key];
    if (!s || s.ok !== ok) s = st.seen[key] = { ok: ok, at: Date.now() };
    return s.at;
  }
  function press(Q, mode, ok, parts) {
    var hide = mode === "hide";
    if (hide) {
      // 淡入、翻卡（含 ulse23）當格停掉，藏起來
      try { Q.tweens.killTweensOf(parts); } catch (e) {}
      for (var i = 0; i < parts.length; i++) { try { parts[i].setVisible(false); } catch (e) {} }
    }
    ok.__ulrQuestPressed = true;
    ok.emit("pointerup");
    // 官方的淡出：看不到的話直接跑完（onComplete 拆面板、放行後面的流程）
    if (hide) finishTweens(Q, parts);
  }
  function rewardStep(st, Q) {
    var ok = Q.quest_reward_ok;
    if (!pressable(ok)) return;
    var at = firstSeen(st, "reward", ok);
    if (st.reward === "auto" && Date.now() - at < CFG.rewardAutoMs) return;
    press(Q, st.reward, ok, [Q.quest_reward_base, ok, Q.quest_reward_image].filter(alive));
    st.rewardPressed++;
  }
  function endStep(st, Q) {
    var ok = Q.quest_end_ok;
    if (pressable(ok)) {
      // auto：等官方淡入完 setInteractive 才開始算
      var ready = !!(ok.input && ok.input.enabled);
      var at = firstSeen(st, ready ? "endReady" : "end", ok);
      if (st.end !== "auto" || (ready && Date.now() - at >= CFG.endAutoMs)) {
        press(Q, st.end, ok, [Q.quest_end_base, ok].filter(alive));
        st.endPressed++;
      }
    }
    // 新任務框疊在結束面板上面：同一格也看（hide 才不會閃一格）
    var btn = Q.quest_found_ok_btn;
    if (!pressable(btn)) return;
    var seenAt = firstSeen(st, "found", btn);
    // 只跳任務剛結束時 quest_added 帶來的那個；搜尋到任務的同一個框照常顯示
    var added = st.addedAt > 0 && Math.abs(seenAt - st.addedAt) <= CFG.addedMs;
    var ended = alive(Q.quest_end_ok) || (st.endAt > 0 && Date.now() - st.endAt <= CFG.endWindowMs);
    if (!added || !ended) return;
    if (st.end === "auto" && Date.now() - seenAt < CFG.endAutoMs) return;
    press(Q, st.end, btn, [Q.quest_found_bg, Q.quest_found_dialog, btn, Q.quest_found_ok_text].filter(alive));
    st.endPressed++;
  }
  function panelStep(st) {
    if (window[FLAG] !== st || (st.reward === "show" && st.end === "show")) return;
    var Q = questScene();
    if (Q === null) return;
    if (st.reward !== "show") rewardStep(st, Q);
    if (st.end !== "show") endStep(st, Q);
  }
  function hookStep(st) {
    var G = window.game;
    if (!G || !G.events || st.stepGame === G) return;
    unhookStep(st);
    G.events.on("prestep", st.onStep);
    st.stepGame = G;
  }
  function unhookStep(st) {
    var G = st.stepGame;
    st.stepGame = null;
    try { if (G && G.events) G.events.off("prestep", st.onStep); } catch (e) {}
  }
  // Quest 場景每次 init 都 new 一條 socket：跟著換
  function hookSocket(st) {
    var G = window.game;
    var Q = G && G.scene && G.scene.keys ? G.scene.keys.Quest : null;
    var S = Q ? Q.socket : null;
    if (!S || typeof S.on !== "function" || st.sock === S) return;
    unhookSocket(st);
    S.on("quest_added", st.onAdded);
    S.on("quest_end", st.onEnded);
    st.sock = S;
  }
  function unhookSocket(st) {
    var S = st.sock;
    st.sock = null;
    try { if (S) { S.off("quest_added", st.onAdded); S.off("quest_end", st.onEnded); } } catch (e) {}
  }

  // ---- 打完怪物跳過結算 ------------------------------------------------------------
  function camAlpha(sc, a) {
    try { if (sc && sc.cameras && sc.cameras.main) sc.cameras.main.setAlpha(a); } catch (e) {}
  }
  /** 任務戰鬥（Quest 在睡）、沒有獎勵遊戲。 */
  function questResult(R) {
    var K = window.game.scene.keys;
    var p = R.result_params;
    try { return !!(p && p.bonusgame === false && K.Quest && K.Quest.scene.isSleeping()); } catch (e) { return false; }
  }
  function skipResult(st, R) {
    // 官方 create 最後掛的那一個；result_scene_end 最後會 stop 自己
    R.events.once("shutdown", R.shutdown, R);
    var lv = R.result_params.lvup !== null && R.result_params.lvup !== undefined;
    if (!lv) {
      camAlpha(R, 0);
      var back = window.game.scene.keys.BackA;
      try { if (back && back.scene.isActive()) camAlpha(back, 0); } catch (e) {}
    }
    st.resultSkips++;
    return R.result_scene_end();
  }
  function hookResult(st) {
    var G = window.game;
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Result : null;
    if (!R) return;
    var cur = R.create;
    if (typeof cur !== "function" || cur.__ulrQuestTreasure === st) return;
    var had = Object.prototype.hasOwnProperty.call(R, "create");
    var w = function () {
      try {
        if (window[FLAG] === st && st.skipResult && typeof this.result_scene_end === "function" && questResult(this)) {
          return skipResult(st, this);
        }
      } catch (e) {
        st.reason = "跳過結算：" + String((e && e.message) || e);
      }
      return cur.apply(this, arguments);
    };
    w.__ulrQuestTreasure = st;
    w.__ulrOrig = cur;
    w.__ulrHad = had;
    R.create = w;
    st.resultHooked = R;
  }
  function unhookResult(st) {
    var R = st.resultHooked;
    st.resultHooked = null;
    if (!R) return;
    var w = R.create;
    if (!w || w.__ulrQuestTreasure !== st) return;
    if (w.__ulrHad) R.create = w.__ulrOrig; else delete R.create;
  }

  function tick(st) {
    if (window[FLAG] !== st) return;
    try {
      if (st.T === null && Date.now() >= st.nextFind) {
        st.nextFind = Date.now() + CFG.findEveryMs;
        st.T = findCards();
      }
      hookBonus(st);
      hookStep(st);
      hookSocket(st);
      hookResult(st);
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
    try { unhookStep(old); } catch (e) {}
    try { unhookSocket(old); } catch (e) {}
    try { unhookResult(old); } catch (e) {}
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
    reward: CFG.reward,
    end: CFG.end,
    seen: {},
    rewardPressed: 0,
    endPressed: 0,
    skipResult: CFG.skipResult,
    resultSkips: 0,
    resultHooked: null,
    addedAt: 0,
    endAt: 0,
    stepGame: null,
    onStep: null,
    sock: null,
    onAdded: null,
    onEnded: null,
    reason: null
  };
  st.onStep = function () {
    try { panelStep(st); } catch (e) { st.reason = "確認框：" + String((e && e.message) || e); }
  };
  st.onAdded = function (id) { if (id !== null && id !== undefined) st.addedAt = Date.now(); };
  st.onEnded = function () { st.endAt = Date.now(); };
  window[FLAG] = st;
  st.clear = function () { clear(st); };
  st.unhook = function () { unhook(st); unhookBonus(st); unhookStep(st); unhookSocket(st); unhookResult(st); };
  tick(st);
  st.timer = setInterval(function () { tick(st); }, CFG.pollMs);
  return JSON.stringify({ installed: true, version: st.version, enabled: st.enabled, found: st.T !== null,
    onMap: st.anchor !== null, marks: st.marks, learned: st.learned, reward: st.reward, end: st.end,
    rewardPressed: st.rewardPressed, endPressed: st.endPressed, skipResult: st.skipResult,
    resultSkips: st.resultSkips, reason: st.reason });
})()`;
}

export const QUEST_TREASURE_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false });
    return JSON.stringify({ installed: true, version: st.version, enabled: st.enabled, found: st.T !== null,
      onMap: st.anchor !== null, marks: st.marks, learned: st.learned || 0, reward: st.reward || "show",
      end: st.end || "show", rewardPressed: st.rewardPressed || 0, endPressed: st.endPressed || 0,
      skipResult: st.skipResult === true, resultSkips: st.resultSkips || 0, reason: st.reason });
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

/** 換一組確認框的處理方式，下一格生效。回 `"ok"` 或 `"not-installed"`。 */
export function buildQuestPanelSetExpression(part: QuestPanelPart, mode: QuestPanelMode): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st[${JSON.stringify(part)}] = ${JSON.stringify(mode)};
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 開關「打完怪物跳過結算」，下一場生效。回 `"ok"` 或 `"not-installed"`。 */
export function buildQuestSkipResultExpression(on: boolean): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.skipResult = ${on ? "true" : "false"};
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
      reward: "show",
      end: "show",
      rewardPressed: 0,
      endPressed: 0,
      skipResult: false,
      resultSkips: 0,
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
    reward: isQuestPanelMode(o.reward) ? o.reward : "show",
    end: isQuestPanelMode(o.end) ? o.end : "show",
    rewardPressed: typeof o.rewardPressed === "number" ? o.rewardPressed : 0,
    endPressed: typeof o.endPressed === "number" ? o.endPressed : 0,
    skipResult: o.skipResult === true,
    resultSkips: typeof o.resultSkips === "number" ? o.resultSkips : 0,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
