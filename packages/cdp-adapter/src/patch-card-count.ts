/**
 * 記牌面板（遊戲內）
 * ==================
 * 戰鬥中在畫面上顯示**公牌還剩哪些**：這個地點整疊（@ulr/kifu 的 public-decks，每張帶 index）
 * 扣掉看過的（自己抽到的、雙方翻開的、被破壞亮出來的）。剩下的牌不是在牌堆裡、就是在對手手上
 * 蓋著。每一種旁邊的百分比＝「沒看過的牌裡隨便一張是這種」的機率（玩家 2026-11-08 要的抽牌機率；
 * 對手蓋著的牌也是從同一疊隨機抽的，所以這就是下一張抽到它的機率）。
 *
 * 2026-11-08 加的另外兩段（同一個面板）：
 * - **骰率**：攻防階段雙方數值都出來之後算傷害分布 —— 每點攻擊／防禦各擲一顆骰，一顆成功的
 *   機率 {@link CardCountPatchOptions.diceP}（Moon 的經驗值 1/3），傷害＝攻擊成功數 − 防禦成功數。
 *   顯示平均傷害、至少 1 點的機率；防守方血量知道時加上擊殺率。⚠ 這個模型還沒驗證：
 *   伺服器的 diceroll 帶每顆骰的點數與成功數，牌譜存著，托盤「戰鬥 › 戰績」有實測成功率。
 *   血量：開場 room_config 的 *_chara1_hp，之後跟 damage_*（帶剩餘血量）走；換角後不知道就不顯示擊殺率。
 * - **對手紀錄**：托盤從牌譜整理「這個名字打過幾場、幾勝幾敗、上次用哪三隻」推下來
 *   （{@link buildCardCountSetHistoryExpression}），開場時在面板底下顯示兩行。
 *
 * 跟 @ulr/kifu 的 replay.ts／counter.ts 同一套語意（那邊有完整說明與測試），這裡是頁面裡的
 * 精簡版：只追「看過的 index」與「對手蓋著的公牌張數」。
 *
 * - 只用畫面上看得到的東西：伺服器本來就不送對手蓋著的牌（drawPhase 只給張數）。
 * - 洗牌（第二次以後的 add_actioncards）：看過的清空，只剩雙方手上看得到的牌還算在外面。
 * - **表跟實際抽到的牌對不上就不顯示**（改版換牌）：錯的記牌比沒有記牌糟。回報托盤寫一行。
 * - 中途才接上（看不到開場）就不顯示這一場 —— 前面抽過什麼不知道，算出來是錯的。
 * - 所有模式都顯示（玩家 2026-10-23），托盤可關。
 *
 * 監聽跟牌譜錄製各自掛（`onAny` 掛在每場新的 socket 實例上）：錄製關掉時記牌照樣要能用。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號，反斜線要寫兩次。**
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrCardCount";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**。 */
export const CARD_COUNT_SCRIPT_VERSION = 2;

/** 一張公牌：`[上半種類, 數字, 下半種類, 數字]`（同 @ulr/kifu 的 PublicCard）。 */
export type CardCountCard = readonly [string, number, string, number];

/** 對手紀錄（托盤從牌譜整理的）：名字 → 戰績與上次用的角色卡。 */
export interface CardCountOpponent {
  win: number;
  lose: number;
  draw: number;
  /** 上一場對手的角色卡 id（頁面自己查名字） */
  lastCharas: number[];
}

export interface CardCountPatchOptions {
  bindingName: string;
  /** 地點 → 整疊公牌（陣列索引＝伺服器給的 index） */
  decks: Readonly<Record<string, readonly CardCountCard[]>>;
  enabled: boolean;
  /** 對手名字 → 紀錄。省略＝沒有 */
  history?: Readonly<Record<string, CardCountOpponent>>;
  /** 一顆骰子成功的機率（預設 1/3） */
  diceP?: number;
}

/** 表跟實際的牌對不上（改版換牌）—— 這一場不顯示。 */
export interface CardCountReport {
  type: "card-count";
  kind: "mismatch";
  stage: string;
  /** `index: 表上 … 實際 …` */
  detail: string;
}

export function isCardCountReport(value: unknown): value is CardCountReport {
  const o = value as { type?: unknown } | null;
  return typeof value === "object" && o !== null && o.type === "card-count";
}

export interface CardCountStatus {
  installed: boolean;
  version: number | null;
  enabled: boolean;
  /** 這一場在算（看得到開場、有表、表對得上） */
  active: boolean;
  stage: string | null;
  unseen: number | null;
  reason: string | null;
}

export function buildCardCountPatchScript(options: CardCountPatchOptions): string {
  const config = {
    version: CARD_COUNT_SCRIPT_VERSION,
    bindingName: options.bindingName,
    decks: options.decks,
    enabled: options.enabled,
    history: options.history ?? {},
    diceP:
      typeof options.diceP === "number" && options.diceP > 0 && options.diceP < 1
        ? options.diceP
        : 1 / 3,
  };
  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};
  var SUITS = ["swd", "gun", "shi", "mov", "spe"];

  function report(payload) {
    try { var fn = window[CFG.bindingName]; if (typeof fn === "function") fn(JSON.stringify(payload)); } catch (e) {}
  }
  function keys() { var G = window.game; return G && G.scene && G.scene.keys ? G.scene.keys : null; }
  function status(sc) { try { return sc.sys.settings.status; } catch (e) { return -1; } }
  function half(c, h) {
    for (var i = 0; i < SUITS.length; i++) { var v = c[SUITS[i] + h]; if (typeof v === "number" && v > 0) return [SUITS[i], v]; }
    return null;
  }

  /** 一場的記牌狀態 */
  function newMatch(stage, partial) {
    return { stage: stage, deck: CFG.decks[stage] || null, partial: partial, opened: false, bad: null,
      seen: {}, deckLeft: 0, mine: [], theirs: [],
      atk: null, def: null, hp: { A: null, B: null }, max: { A: null, B: null }, opp: null };
  }
  function see(M, c) {
    if (!c || c.type !== "ac" || typeof c.index !== "number") return;
    M.seen[c.index] = 1;
    if (!M.deck || M.bad) return;
    var t = M.deck[c.index], a = half(c, 1), b = half(c, 2);
    if (!t || !a || !b || t[0] !== a[0] || t[1] !== a[1] || t[2] !== b[0] || t[3] !== b[1]) {
      M.bad = c.index + ": " + (t ? t.join("") : "none") + " / " + (a ? a.join("") : "-") + (b ? b.join("") : "-");
      report({ type: "card-count", kind: "mismatch", stage: M.stage, detail: M.bad });
    }
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clear(list, i) { if (typeof i === "number" && i >= 0 && i < list.length) list[i] = null; }

  /** 伺服器一則事件 → 狀態（語意見 @ulr/kifu replay.ts） */
  function apply(M, side, name, a) {
    var opp = side === "A" ? "B" : "A";
    switch (name) {
      case "add_actioncards":
        if (M.opened || M.deckLeft > 0) {
          M.seen = {};
          M.mine.forEach(function (s) { if (s && s.card) see(M, s.card); });
          M.theirs.forEach(function (s) { if (s && s.card) see(M, s.card); });
        }
        M.opened = true;
        M.deckLeft += typeof a[0] === "number" ? a[0] : 0;
        return true;
      case "drawPhase": case "cardDraw": {
        var mine = arr(a[0]), n = typeof a[1] === "number" ? a[1] : 0;
        mine.forEach(function (c) { M.mine.push({ card: c, deck: true }); see(M, c); });
        for (var k = 0; k < n; k++) M.theirs.push({ card: null, deck: true });
        M.deckLeft = Math.max(0, M.deckLeft - mine.length - n);
        return true;
      }
      case "eventCard": {
        if (a[0] && typeof a[0] === "object") M.mine.push({ card: a[0], deck: false });
        var ne = typeof a[1] === "number" ? a[1] : 0;
        for (var j = 0; j < ne; j++) M.theirs.push({ card: null, deck: false });
        return true;
      }
      case "card_back_player": arr(a[0]).forEach(function (c) { M.mine.push({ card: c, deck: false }); }); return true;
      case "card_back_opponent": for (var b2 = 0; b2 < (a[0] || 0); b2++) M.theirs.push({ card: null, deck: false }); return true;
      case "goToBochi": arr(a[0]).forEach(function (i) { clear(M.mine, i); }); arr(a[1]).forEach(function (i) { clear(M.theirs, i); }); return true;
      case "card_remove_player": arr(a[0]).forEach(function (i) { clear(M.mine, i); }); return true;
      case "card_remove_opponent": arr(a[0]).forEach(function (i) { clear(M.theirs, i); }); return true;
      case "card_break_player": arr(a[0]).forEach(function (o) { clear(M.mine, o && o.cardindex); }); return true;
      case "card_break_opponent": arr(a[0]).forEach(function (o) { if (o) { see(M, o.card); clear(M.theirs, o.cardindex); } }); return true;
      // 骰率要的：攻防值、血量
      case "attack_value": M.atk = typeof a[0] === "number" ? a[0] : null; return true;
      case "defense_value": M.def = typeof a[0] === "number" ? a[0] : null; return true;
      case "diceroll": case "turn_end": M.atk = null; M.def = null; return true;
      case "damage_player": case "damage_opponent": {
        var who = name === "damage_player" ? side : opp;
        if (who && typeof a[1] === "number") M.hp[who] = a[1];
        if (who && typeof a[2] === "number") M.max[who] = a[2];
        return true;
      }
      case "heal_player": case "heal_opponent": {
        var hw = name === "heal_player" ? side : opp;
        if (hw && M.hp[hw] !== null && typeof a[0] === "number") {
          M.hp[hw] += a[0];
          if (M.max[hw] !== null) M.hp[hw] = Math.min(M.hp[hw], M.max[hw]);
        }
        return true;
      }
      case "change_player": if (side) { M.hp[side] = null; M.max[side] = null; } return true;
      case "change_opponent": if (opp) { M.hp[opp] = null; M.max[opp] = null; } return true;
    }
    if (name === "cardOpen_" + opp) {
      arr(a[0]).forEach(function (o) { if (!o) return; var s = M.theirs[o.cardindex]; if (s) s.card = o.card; see(M, o.card); });
      return true;
    }
    if (name === "cardRob_" + side) {
      arr(a[0]).forEach(function (o) { clear(M.mine, o && o.cardindex); M.theirs.push({ card: null, deck: false }); });
      return true;
    }
    if (name === "cardRob_" + opp) {
      arr(a[0]).forEach(function (o) { if (!o) return; clear(M.theirs, o.cardindex); M.mine.push({ card: o.card, deck: false }); see(M, o.card); });
      return true;
    }
    return false;
  }

  function counts(M) {
    var out = { unseen: 0, hidden: 0, suits: {} };
    SUITS.forEach(function (s) { out.suits[s] = { n: 0, total: 0 }; });
    if (!M.deck) return out;
    for (var i = 0; i < M.deck.length; i++) {
      if (M.seen[i]) continue;
      var c = M.deck[i];
      out.unseen++;
      SUITS.forEach(function (s) {
        var v = Math.max(c[0] === s ? c[1] : 0, c[2] === s ? c[3] : 0);
        if (v > 0) { out.suits[s].n++; out.suits[s].total += v; }
      });
    }
    M.theirs.forEach(function (s) { if (s && s.card === null && s.deck) out.hidden++; });
    return out;
  }
  function usable(M) { return !!(M && M.deck && !M.partial && !M.bad && M.opened); }

  /** 二項分布 B(n, p) 的機率表 */
  function binom(n, p) {
    var out = [Math.pow(1 - p, n)];
    for (var k = 1; k <= n; k++) out.push(out[k - 1] * (n - k + 1) / k * p / (1 - p));
    return out;
  }
  /** 傷害分布：攻擊成功數 − 防禦成功數（不到 0 算 0）。回 {avg, hit, kill} */
  function dice(atk, def, hp) {
    var p = CFG.diceP, A = binom(Math.max(0, Math.min(atk, 200)), p), D = binom(Math.max(0, Math.min(def, 200)), p);
    var dist = [];
    for (var i = 0; i < A.length; i++) for (var j = 0; j < D.length; j++) {
      var d = Math.max(0, i - j);
      dist[d] = (dist[d] || 0) + A[i] * D[j];
    }
    var avg = 0, hit = 0, kill = null;
    for (var k = 0; k < dist.length; k++) { var q = dist[k] || 0; avg += k * q; if (k >= 1) hit += q; }
    if (typeof hp === "number" && hp > 0) { kill = 0; for (var h = hp; h < dist.length; h++) kill += dist[h] || 0; }
    return { avg: avg, hit: hit, kill: kill };
  }
  /** 現在誰在防守（攻防階段場景是相對視角：AttackPhaseA＝我方攻擊） */
  function defender(st) {
    var K = keys(), opp = st.side === "A" ? "B" : st.side === "B" ? "A" : null;
    if (!K || !st.side) return null;
    if (K.AttackPhaseA && status(K.AttackPhaseA) === 5) return opp;
    if (K.DefensePhaseA && status(K.DefensePhaseA) === 5) return st.side;
    return null;
  }
  function pct(x) { return Math.round(x * 100) + "%"; }
  function charaNames(ids) {
    try {
      var J = window.game.cache.json, CC = J.get("CharaCards") || [], CH = J.get("Characters") || {};
      return ids.map(function (id) {
        var c = CC.filter(function (x) { return x.id === id; })[0];
        if (!c) return "?";
        var n = CH[c.chara] || {};
        return (n.name_tcn || n.name || c.chara) + (c.level ? " L" + c.level : "");
      }).join(" / ");
    } catch (e) { return ""; }
  }

  // ── 畫面 ──────────────────────────────────────────────────────────────
  //
  // 畫在 MainA 裡、depth 夠高；每場 MainA 的 GameObject 都是新的，所以掛過的旗標記在面板物件上。

  function draw(st) {
    var K = keys(), m = K && K.MainA, M = st.match;
    var show = CFG.enabled && m && status(m) >= 5 && status(m) < 8 && !!M;
    var P = st.panel;
    if (P && (!P.root.scene || P.scene !== m)) { try { P.root.destroy(); } catch (e) {} P = st.panel = null; }
    var ok = show && usable(M), c = ok ? counts(M) : null;
    var dfd = show ? defender(st) : null, roll = null;
    if (dfd && typeof M.atk === "number" && typeof M.def === "number") roll = dice(M.atk, M.def, M.hp[dfd]);
    var h = show && M.opp && CFG.history ? CFG.history[M.opp] || null : null;
    // 三段都沒東西（例如表對不上、又不在攻防階段）就整個藏起來
    if (!show || (!ok && !roll && !h)) { if (P) P.root.setVisible(false); return; }
    if (!P) P = st.panel = build(m);
    if (!P) return;
    P.root.setVisible(true);
    var key = JSON.stringify([c, M.deckLeft, roll, M.atk, M.def, h]);
    if (P.last === key) return;
    P.last = key;
    P.head.setText(ok ? "Unseen " + c.unseen : "");
    SUITS.forEach(function (s, i) {
      var n = ok ? c.suits[s].n : 0;
      P.rows[i].setText(ok ? n + "  " + c.suits[s].total + "  " + (c.unseen > 0 ? pct(n / c.unseen) : "-") : "");
      if (P.icons[i]) P.icons[i].setVisible(ok);
    });
    if (roll) {
      P.dice[0].setText("ATK " + M.atk + " vs DEF " + M.def);
      P.dice[1].setText("Avg " + roll.avg.toFixed(1) + "  Hit " + pct(roll.hit));
      P.dice[2].setText(roll.kill === null ? "" : "Kill " + pct(roll.kill) + "  (HP " + M.hp[dfd] + ")");
    } else {
      P.dice[0].setText(""); P.dice[1].setText(""); P.dice[2].setText("");
    }
    if (h) {
      P.hist[0].setText("vs " + M.opp + "  " + h.win + "W " + h.lose + "L" + (h.draw ? " " + h.draw + "D" : ""));
      P.hist[1].setText(h.lastCharas && h.lastCharas.length ? "Last: " + charaNames(h.lastCharas) : "");
    } else { P.hist[0].setText(""); P.hist[1].setText(""); }
  }

  /**
   * 面板：左上牌堆張數與「Bonus」下面（官方那兩行在 (3,54)～(60,115)），字照官方 Bonus 那行
   * （BradleyGratis、黑描邊）。標籤英文（插件畫在遊戲裡的字一律照官方對照元件，見 patch-present）。
   * 種類圖示用官方行動卡的半邊圖（ActionCardImages 的 swd／gun…）縮小。
   * 不放在右下：手牌一頁 9 張會排到 x=682，那裡會被蓋住。
   */
  var PANEL = { x: 10, y: 124 };
  function build(m) {
    try {
      var root = m.add.container(PANEL.x, PANEL.y).setDepth(9);
      var font = { fontFamily: "BradleyGratis", fontSize: 17, resolution: 2 };
      var head = m.add.text(0, 0, "", font).setStroke("black", 3).setOrigin(0, 0);
      root.add(head);
      var rows = [], icons = [];
      SUITS.forEach(function (s, i) {
        var yy = 22 + i * 18, ic = null;
        if (m.textures.exists("ActionCardImages") && m.textures.get("ActionCardImages").has(s)) {
          ic = m.add.image(8, yy + 9, "ActionCardImages", s).setScale(0.3).setOrigin(0.5, 0.5);
          root.add(ic);
        }
        icons.push(ic);
        var t = m.add.text(22, yy, "", font).setStroke("black", 3).setOrigin(0, 0);
        root.add(t);
        rows.push(t);
      });
      // 骰率三行、對手紀錄兩行，接在五種下面（對手名字可能是中文，那兩行用官方的一般字型）
      var line = function (y, f) { var t = m.add.text(0, y, "", f).setStroke("black", 3).setOrigin(0, 0); root.add(t); return t; };
      var small = { fontFamily: "font_light", fontSize: 13, resolution: 2 };
      var dice = [line(118, font), line(136, font), line(154, font)];
      var hist = [line(178, small), line(194, small)];
      return { root: root, head: head, rows: rows, icons: icons, dice: dice, hist: hist, scene: m, last: null };
    } catch (e) { return null; }
  }

  // ── 監聽 ──────────────────────────────────────────────────────────────

  function attach(st, m, how) {
    var sock = m.socket;
    if (!sock || sock.__ulrCardCount === st || typeof sock.onAny !== "function") return;
    detach(st);
    var rc = m.room_config || {};
    var stage = typeof rc.stage === "string" ? rc.stage : null;
    var side = m.player_side === "A" || m.player_side === "B" ? m.player_side : null;
    st.match = newMatch(stage, how !== "init");
    st.side = side;
    // 開場血量（room_config 的 *_chara1_hp）與對手名字
    try {
      for (var k in rc) {
        var hm = /([AB])_chara1_hp$/.exec(k);
        if (hm && typeof rc[k] === "number") { st.match.hp[hm[1]] = rc[k]; st.match.max[hm[1]] = rc[k]; }
      }
      var os = side === "A" ? "B" : side === "B" ? "A" : null, oi = os ? rc["player" + os + "_info"] : null;
      st.match.opp = oi && typeof oi.player_name === "string" ? oi.player_name : null;
    } catch (e) {}
    st.sock = sock;
    st.onAny = function (name) {
      try {
        if (!st.match || st.sock !== sock) return;
        var a = Array.prototype.slice.call(arguments, 1);
        if (apply(st.match, st.side, String(name), a)) draw(st);
      } catch (e) { st.reason = String((e && e.message) || e); }
    };
    sock.onAny(st.onAny);
    sock.__ulrCardCount = st;
  }
  function detach(st) {
    try { if (st.sock && st.onAny && typeof st.sock.offAny === "function") st.sock.offAny(st.onAny); } catch (e) {}
    try { if (st.sock) delete st.sock.__ulrCardCount; } catch (e) {}
    st.sock = null; st.onAny = null;
  }

  function hookInit(st) {
    var K = keys(), m = K ? K.MainA : null;
    if (!m) return false;
    var P = Object.getPrototypeOf(m);
    if (!P || typeof P.init !== "function") return false;
    if (P.init.__ulrCardCount) P.init = P.init.__ulrCardCount;
    var orig = P.init;
    var w = function () {
      var r = orig.apply(this, arguments);
      try { var s2 = w.__ulrCardCountState; if (s2 && window[FLAG] === s2 && this.socket) attach(s2, this, "init"); } catch (e) {}
      return r;
    };
    w.__ulrCardCount = orig;
    w.__ulrCardCountState = st;
    P.init = w;
    return true;
  }

  function tick(st) {
    if (window[FLAG] !== st) return;
    try {
      if (!st.hooked) st.hooked = hookInit(st);
      var K = keys(), m = K ? K.MainA : null;
      if (m && m.socket && m.socket !== st.sock && status(m) >= 5 && status(m) < 8 && m.is_complete !== true) attach(st, m, "poll");
      draw(st);
    } catch (e) { st.reason = String((e && e.message) || e); }
  }

  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { clearInterval(st.timer); } catch (e) {}
    detach(st);
    try { if (st.panel) st.panel.root.destroy(); } catch (e) {}
    try {
      var K = keys(), m = K ? K.MainA : null, P = m ? Object.getPrototypeOf(m) : null;
      if (P && P.init && P.init.__ulrCardCount) P.init = P.init.__ulrCardCount;
    } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, match: null, side: null, sock: null, onAny: null, panel: null, hooked: false, reason: null, timer: null };
  st.restore = restore;
  st.setEnabled = function (on) { CFG.enabled = !!on; draw(st); };
  st.setHistory = function (json) {
    try { CFG.history = JSON.parse(json) || {}; if (st.panel) st.panel.last = null; draw(st); return "ok"; }
    catch (e) { return "error:" + String((e && e.message) || e); }
  };
  st.status = function () {
    var M = st.match;
    return { installed: true, version: st.version, enabled: CFG.enabled, active: usable(M), stage: M ? M.stage : null,
      unseen: usable(M) ? counts(M).unseen : null, reason: M && M.bad ? "表對不上：" + M.bad : (M && M.partial ? "這場中途才接上" : st.reason) };
  };
  window[FLAG] = st;
  st.timer = setInterval(function () { tick(st); }, 250);
  tick(st);
  return JSON.stringify(st.status());
})()`;
}

export const CARD_COUNT_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, enabled: false, active: false, stage: null, unseen: null, reason: null });
    return JSON.stringify(st.status());
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, enabled: false, active: false, stage: null, unseen: null, reason: String((e && e.message) || e) });
  }
})()`;

export function buildCardCountSetEnabledExpression(enabled: boolean): string {
  return `(function () {
  try { var st = window["${FLAG}"]; if (!st) return "not-installed"; st.setEnabled(${enabled ? "true" : "false"}); return "ok"; }
  catch (e) { return "error:" + String((e && e.message) || e); }
})()`;
}

/** 換掉對手紀錄（托盤牌譜清單變了就推一次）。回 "ok" 或 "not-installed"。 */
export function buildCardCountSetHistoryExpression(
  history: Readonly<Record<string, CardCountOpponent>>,
): string {
  return `(function () {
  try { var st = window["${FLAG}"]; if (!st || !st.setHistory) return "not-installed"; return st.setHistory(${embedJson(history)}); }
  catch (e) { return "error:" + String((e && e.message) || e); }
})()`;
}

export const CARD_COUNT_UNINSTALL_EXPRESSION = `(function () {
  try { var st = window["${FLAG}"]; if (!st) return "not-installed"; st.restore(); return "ok"; }
  catch (e) { return "error:" + String((e && e.message) || e); }
})()`;

export function parseCardCountStatus(raw: string): CardCountStatus {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      installed: o.installed === true,
      version: typeof o.version === "number" ? o.version : null,
      enabled: o.enabled === true,
      active: o.active === true,
      stage: typeof o.stage === "string" ? o.stage : null,
      unseen: typeof o.unseen === "number" ? o.unseen : null,
      reason: typeof o.reason === "string" ? o.reason : null,
    };
  } catch {
    return {
      installed: false,
      version: null,
      enabled: false,
      active: false,
      stage: null,
      unseen: null,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
}
