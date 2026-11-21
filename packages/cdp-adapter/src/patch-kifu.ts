/**
 * 牌譜錄製（頁面這一半）
 * ======================
 * 每一場戰鬥（對戰、任務、渦、活動都算）把 MainA 那條戰鬥連線上**收到的每一則事件**
 * 原樣記下來，加上自己送出的操作，每則帶毫秒時間戳。整理、存檔、版本快照都在 Node 那邊。
 *
 * ## 為什麼存原始事件，不自己維護戰況
 *
 * 事件流本身就是牌譜。自己再養一份戰況狀態機，會跟遊戲版本一起漂移 —— 2026-09-23 改版
 * 把戰鬥事件全部改名（cardclickedA → card_submit_player/opponent），自己整理過的格式
 * 那天就全部作廢。原始事件留著，整理的程式（`@ulr/kifu`）修好了舊牌譜可以重算。
 *
 * ## 隱藏資訊（§12）
 *
 * **伺服器本來就不送對手手牌**（2026-10-23 讀 949.js / 183.js）：
 *
 *     drawPhase(我的牌[], 對手抽幾張)           ← 對手只有張數
 *     card_submit_opponent(位置, 出/收, 音效)   ← 只有位置
 *     cardOpen_<對手座位>([{cardindex, card}])  ← 翻開了才有牌面
 *
 * 所以「收到什麼存什麼」不會存到畫面上看不到的東西。唯一的例外是開場的 `room_config`：
 * 它**帶著對手整副牌組（含事件卡）**。這支只留對手的角色卡 id（開場就畫在場上、美術也
 * 要靠它快照），武器與事件卡一律不記。
 *
 * 送出的事件裡有房號（`card_submit(room_id, 位置)`）—— 房號與任何長而像 id 的字串
 * 一律換成 `~id`。收到的事件也過同一道，以防萬一。
 *
 * ## 什麼時候掛上
 *
 * 官方 `MainA.init()`（949.js，2026-10-23）：
 *
 *     match_transfer 是 null → this.socket = new WSClient(...)；await fetch("register")；await fetch("join_room")
 *     否則                    → this.socket = match_transfer.socket
 *
 * 兩條路的 socket 都是 init **同步那一段**就設好的，所以這支包 `MainA` 原型的 `init`：
 * 原本的 init 一回來（還在 await register）就掛上監聽，開場的 chara／drawPhase 不會漏。
 * Phaser 每次開場都從實例上讀 `init`，實例沒有自己的那份 → 讀到原型 → 包原型有效。
 *
 * 插件在戰鬥**中途**才接上時走輪詢那條（每 200ms 看 MainA.socket），那份牌譜標 `partial`。
 *
 * 每場是一條新的 socket（`new WSClient`），所以 `onAny` 掛在實例上；送出側包**實例**的
 * `emit`、呼叫時才去原型拿現在那支（見 raid-support.ts —— 包原型會跟 patch-ok 互咬成環）。
 *
 * ## 什麼時候算結束
 *
 * 官方 `game_result()` 第一件事是 `socket.off()`（連 onAny 一起拆掉）→ `emit("leaveRoom")`
 * → `disconnect()`。所以 `result` 那則一定收得到，之後的收不到也不需要。結束的判準照
 * patch-ok 的 battleLive：`socket.readyState >= 2` 或 MainA 的 `status >= 8`，或換了一條 socket。
 *
 * ## 美術快照要的清單
 *
 * - 開場呼叫官方 `MainAAssets.loader({deck, deck_enemy, config, is_player_a})` —— 它只是
 *   **組出**這場要載的清單（立繪、臉、開場圖、特效、場地、共用 UI），不會真的去載。
 * - 戰鬥中每 2 秒走一次戰鬥場景的顯示物件，記下畫過的貼圖 key 與字型（卡面圖集、行動卡、
 *   狀態圖示這些開機就載好的不在 loader 清單裡）。
 *
 * 雜湊與讀檔是 Node 那邊等戰鬥結束才來要（見 `buildKifuTextureInfoExpression` 等），
 * 戰鬥中不碰網路也不做重活。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號，反斜線要寫兩次。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrKifu";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const KIFU_SCRIPT_VERSION = 1;

/** 牌譜格式版本（Node 落地的那份）。頁面送的欄位改了就 +1。 */
export const KIFU_FORMAT_VERSION = 1;

/**
 * 開場時記雜湊的資料表（Phaser JSON 快取的鍵，2026-10-23 實機）。重播時角色卡數值、
 * 技能說明、狀態名稱、戰鬥記錄的文字模板全從這些表來 —— 存當時的版本，改版後才播得對。
 */
export const KIFU_TABLES = [
  "CharaCards",
  "Characters",
  "Feats",
  "PassiveSkills",
  "State",
  "WeaponCards",
  "EventCards",
  "LogUITexts",
  "BattleUITexts",
  "Stamps",
] as const;

/** 戰鬥中會畫東西的場景。每 2 秒走一次它們的顯示物件記貼圖。 */
export const KIFU_SCENES = [
  "MainA",
  "BackA",
  "DrawPhaseA",
  "MovePhaseA",
  "AttackPhaseA",
  "DefensePhaseA",
  "AtkDicerollA",
  "AtkResultA",
  "DefDiceRollA",
  "DefResultA",
  "ChangePhaseA",
  "BattlePlayerAvatar",
  "BattleOpponentAvatar",
] as const;

/** 不記的事件（心跳）。 */
export const KIFU_SKIP_EVENTS = ["__ping_c", "__pong_s", "__ping_s", "__pong_c"] as const;

/** 這麼長而且只有英數的字串一律當成 id（房號、token）換掉。 */
export const KIFU_ID_MIN_LENGTH = 20;

/** 多久把累積的事件送回 Node 一次。送得勤，頁面重載或當掉時掉的少。 */
const FLUSH_MS = 1000;
/** 多久看一次 socket（中途接上、結束）。 */
const POLL_MS = 200;
/** 多久走一次顯示物件記貼圖。 */
const TEXTURE_SWEEP_MS = 2000;

/** 一則事件：`[時間戳 ms, 方向, 事件名, 參數]`。 */
export type KifuEvent = [t: number, dir: "in" | "out", name: string, args: unknown[]];

export interface KifuPlayerInfo {
  name: string | null;
  level: number | null;
  bp: number | null;
  win: number | null;
  lose: number | null;
  draw: number | null;
  /** 頭像部件（重播畫頭像用）。`[{parts_id, parts_type}]` */
  avatar: unknown[];
}

/** loader 組出來的一筆美術（網址是相對 `baseURL` 的）。 */
export interface KifuLoaderAsset {
  kind: "image" | "spritesheet" | "atlas";
  key: string;
  url: string;
  /** atlas 的 JSON */
  atlasURL?: string;
  /** spritesheet 的切法 */
  frameConfig?: unknown;
}

export interface KifuMeta {
  /** 頁面錄製器版本 */
  script: number;
  format: number;
  /** 我坐哪一位（事件名的 A/B 是座位，不是敵我） */
  side: string | null;
  rule: string | null;
  stage: string | null;
  turnLimit: number | null;
  bgm: string | null;
  multi: boolean | null;
  crossplay: boolean | null;
  /** 房號 SHA-256 前 16 hex。兩個客戶端算出來一樣 —— 合併雙視角用；原始房號不出頁面。 */
  roomHash: string | null;
  /** 開場台詞 */
  dialogue: unknown;
  players: Record<string, KifuPlayerInfo>;
  /** 自己的整副牌組（原樣） */
  ownDeck: unknown;
  /** 對手只留角色卡 id（武器、事件卡是隱藏資訊） */
  opponentCharaIds: unknown[];
  /** 開場時雙方角色 HP（`player_chara1_hp`…） */
  hp: Record<string, number>;
  /** 中途才接上 —— 前面的事件沒有 */
  partial: boolean;
  /** 開始錄的回合（中途接上時才有意義） */
  attachTurn: number | null;
  lang: string | null;
  /** 遊戲 bundle 檔名（版本指紋：改版時這些雜湊會換） */
  client: string[];
  /** 美術的基底網址（`MainA.load.baseURL`） */
  baseURL: string | null;
  /** 資料表 → SHA-256（算不出來是 null） */
  tables: Record<string, string | null>;
  loader: KifuLoaderAsset[];
}

export interface KifuStartReport {
  type: "kifu-start";
  key: string;
  startedAt: number;
  meta: KifuMeta;
}

export interface KifuEventsReport {
  type: "kifu-events";
  key: string;
  /** 第幾批（從 0 起）。Node 用它認出漏批。 */
  seq: number;
  events: KifuEvent[];
}

export interface KifuEndReport {
  type: "kifu-end";
  key: string;
  endedAt: number;
  /** `socket-closed` / `scene-shutdown` / `socket-replaced` / `uninstall` */
  reason: string;
  /** 戰鬥中畫過的貼圖 key */
  textures: string[];
  /** 戰鬥中畫過的格（貼圖 key → 格名）。巨型圖集只匯出這些（見 KifuTextureInfo） */
  frames: Record<string, string[]>;
  /** 戰鬥中用過的字型 */
  fonts: string[];
  /** 最後一批的 seq（Node 拿來確認有沒有漏） */
  lastSeq: number;
}

export type KifuReport = KifuStartReport | KifuEventsReport | KifuEndReport;

export function isKifuReport(value: unknown): value is KifuReport {
  const o = value as { type?: unknown; key?: unknown } | null;
  if (typeof value !== "object" || o === null || typeof o.key !== "string") return false;
  return o.type === "kifu-start" || o.type === "kifu-events" || o.type === "kifu-end";
}

export interface KifuStatus {
  installed: boolean;
  version: number | null;
  /** 正在錄的那場（沒有是 null） */
  recording: string | null;
  /** 裝上之後錄了幾場 */
  matches: number;
  /** 原型的 init 包上了沒（沒包上的話開場事件會漏，只能靠輪詢） */
  initHooked: boolean;
  reason: string | null;
}

export interface KifuPatchOptions {
  bindingName: string;
}

/**
 * 房號、token、UUID 這類 id：長、只有英數與 -、字母數字都有。頁面裡照抄一份。
 *
 * ⚠ 不收底線：技能與特效的名字（`cc012_sk03_ex_a_1`、`cc052_sk04_opponent`）也長，
 * 但都帶底線 —— 收了的話會把要記的資料換成 ~id。
 */
export function isIdLike(value: unknown, room: string | null): boolean {
  if (typeof value !== "string") return false;
  if (room !== null && value === room) return true;
  return (
    value.length >= KIFU_ID_MIN_LENGTH &&
    /^[A-Za-z0-9-]+$/.test(value) &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

export function buildKifuPatchScript(options: KifuPatchOptions): string {
  const config = {
    version: KIFU_SCRIPT_VERSION,
    format: KIFU_FORMAT_VERSION,
    bindingName: options.bindingName,
    tables: [...KIFU_TABLES],
    scenes: [...KIFU_SCENES],
    skip: [...KIFU_SKIP_EVENTS],
    idMin: KIFU_ID_MIN_LENGTH,
    flushMs: FLUSH_MS,
    pollMs: POLL_MS,
    sweepMs: TEXTURE_SWEEP_MS,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  function keys() {
    var G = window.game;
    return G && G.scene && G.scene.keys ? G.scene.keys : null;
  }
  function status(sc) {
    try { return sc.sys.settings.status; } catch (e) { return -1; }
  }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function str(v) { return typeof v === "string" ? v : null; }

  var ID_CHARS = /^[A-Za-z0-9-]+$/, HAS_DIGIT = /[0-9]/, HAS_ALPHA = /[A-Za-z]/;
  /** 官方 Text 物件的畫布貼圖 key（重播自己畫字，不存） */
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function idLike(v, room) {
    if (typeof v !== "string") return false;
    if (room && v === room) return true;
    return v.length >= CFG.idMin && ID_CHARS.test(v) && HAS_DIGIT.test(v) && HAS_ALPHA.test(v);
  }
  /** 深拷貝（JSON 能表示的部分），順手把 id 換掉。 */
  function scrub(v, room, depth) {
    if (v === null || v === undefined) return v === undefined ? null : v;
    var t = typeof v;
    if (t === "string") return idLike(v, room) ? "~id" : v;
    if (t === "number") return isFinite(v) ? v : null;
    if (t === "boolean") return v;
    if (t !== "object" || depth > 8) return null;
    if (Array.isArray(v)) {
      var a = new Array(v.length);
      for (var i = 0; i < v.length; i++) a[i] = scrub(v[i], room, depth + 1);
      return a;
    }
    var o = {};
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      var x = v[k];
      if (typeof x === "function") continue;
      o[k] = scrub(x, room, depth + 1);
    }
    return o;
  }

  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }
  function sha(text) {
    try {
      var c = window.crypto && window.crypto.subtle;
      if (!c || typeof TextEncoder !== "function") return Promise.resolve(null);
      return c.digest("SHA-256", new TextEncoder().encode(text)).then(hex, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function clientFiles() {
    try {
      var out = [];
      var list = performance.getEntriesByType("resource");
      for (var i = 0; i < list.length; i++) {
        var u = String(list[i].name || "");
        var at = u.indexOf("/client/");
        if (at < 0 || u.indexOf(".js") < 0) continue;
        var f = u.slice(at + 8).split("?")[0];
        if (out.indexOf(f) < 0) out.push(f);
      }
      return out.sort();
    } catch (e) { return []; }
  }

  function playerInfo(i) {
    i = i || {};
    var av = [];
    if (Array.isArray(i.avatar)) for (var k = 0; k < i.avatar.length; k++) {
      var p = i.avatar[k];
      if (p && typeof p === "object") av.push({ parts_id: num(p.parts_id), parts_type: num(p.parts_type) });
    }
    return { name: str(i.player_name), level: num(i.level), bp: num(i.bp), win: num(i.win), lose: num(i.lose), draw: num(i.draw), avatar: av };
  }

  /** 官方 loader 組出這場的美術清單（只組清單、不載）。 */
  function loaderList(m, rc, side, opp) {
    var out = [];
    try {
      var A = keys().MainAAssets;
      if (!A || typeof A.loader !== "function") return out;
      var r = A.loader({ deck: rc["player" + side + "_deck"], deck_enemy: rc["player" + opp + "_deck"], config: rc, is_player_a: side === "A" });
      var kinds = ["image", "spritesheet", "atlas"];
      for (var k = 0; k < kinds.length; k++) {
        var arr = r && Array.isArray(r[kinds[k]]) ? r[kinds[k]] : [];
        for (var j = 0; j < arr.length; j++) {
          var e = arr[j];
          if (!e || typeof e.key !== "string") continue;
          var url = typeof e.url === "string" ? e.url : typeof e.textureURL === "string" ? e.textureURL : null;
          if (url === null) continue;
          var x = { kind: kinds[k], key: e.key, url: url };
          if (typeof e.atlasURL === "string") x.atlasURL = e.atlasURL;
          if (e.frameConfig && typeof e.frameConfig === "object") x.frameConfig = scrub(e.frameConfig, null, 0);
          out.push(x);
        }
      }
    } catch (e) {}
    return out;
  }

  function newKey(side) {
    return Date.now().toString(36) + "-" + (side || "x") + "-" + Math.random().toString(36).slice(2, 8);
  }

  // ── 一場 ──────────────────────────────────────────────────────────────

  function attach(st, m, how) {
    var sock = m.socket;
    if (!sock || sock.__ulrKifu === st || typeof sock.onAny !== "function") return;
    if (st.cur) finish(st, "socket-replaced");
    var rc = m.room_config || {};
    var room = typeof m.room_id === "string" ? m.room_id : (typeof rc.room_id === "string" ? rc.room_id : null);
    var side = str(m.player_side) || str(rc.player_side);
    var opp = side === "A" ? "B" : side === "B" ? "A" : null;
    var turn = null;
    try { turn = m.turn_text && m.turn_text.text ? Number(m.turn_text.text) : null; } catch (e) {}
    var cur = {
      key: newKey(side), sock: sock, room: room, seq: 0, buf: [], textures: {}, frames: {}, fonts: {},
      startedAt: Date.now(), started: false, startBuf: true,
    };
    cur.onAny = function (name) {
      try {
        if (st.cur !== cur || CFG.skip.indexOf(name) >= 0) return;
        if (name === "result") { if (cur.sawResult) return; cur.sawResult = true; }
        var a = [];
        for (var i = 1; i < arguments.length; i++) a.push(scrub(arguments[i], cur.room, 0));
        cur.buf.push([Date.now(), "in", String(name), a]);
      } catch (e) {}
    };
    sock.onAny(cur.onAny);
    var own = Object.prototype.hasOwnProperty.call(sock, "emit") ? sock.emit : null;
    var w = function (name) {
      try {
        if (st.cur === cur && CFG.skip.indexOf(name) < 0) {
          var a = [];
          for (var i = 1; i < arguments.length; i++) a.push(scrub(arguments[i], cur.room, 0));
          cur.buf.push([Date.now(), "out", String(name), a]);
        }
      } catch (e) {}
      var f = own || Object.getPrototypeOf(sock).emit;
      return f.apply(this, arguments);
    };
    w.__ulrKifuOwn = own;
    sock.emit = w;
    cur.emitWrap = w;
    sock.__ulrKifu = st;
    st.cur = cur;
    st.matches++;

    var oppDeck = rc["player" + opp + "_deck"];
    var hp = {};
    for (var k in rc) if (Object.prototype.hasOwnProperty.call(rc, k) && /_chara[0-9]_hp$/.test(k) && typeof rc[k] === "number") hp[k] = rc[k];
    var players = {};
    if (rc.playerA_info) players.A = playerInfo(rc.playerA_info);
    if (rc.playerB_info) players.B = playerInfo(rc.playerB_info);
    var meta = {
      script: CFG.version, format: CFG.format, side: side, rule: str(rc.rule), stage: str(rc.stage),
      turnLimit: num(rc.turn_limit), bgm: str(rc.bgm),
      multi: typeof rc.multi === "boolean" ? rc.multi : null,
      crossplay: typeof rc.crossplay === "boolean" ? rc.crossplay : null,
      roomHash: null,
      dialogue: scrub(rc.dialogue, room, 0),
      players: players,
      ownDeck: scrub(rc["player" + side + "_deck"], room, 0),
      opponentCharaIds: oppDeck && Array.isArray(oppDeck.chara_card_id) ? scrub(oppDeck.chara_card_id, room, 0) : [],
      hp: hp,
      partial: how !== "init",
      attachTurn: how === "init" ? 1 : (isFinite(turn) ? turn : null),
      lang: str(window.lang),
      client: clientFiles(),
      baseURL: m.load && typeof m.load.baseURL === "string" ? m.load.baseURL : null,
      tables: {},
      loader: loaderList(m, rc, side, opp),
    };
    var C = window.game.cache.json, jobs = [];
    CFG.tables.forEach(function (name) {
      var text = null;
      try { var v = C.get(name); text = v === undefined ? null : JSON.stringify(v); } catch (e) {}
      if (text === null) { meta.tables[name] = null; return; }
      jobs.push(sha(text).then(function (h) { meta.tables[name] = h; }));
    });
    jobs.push(room ? sha(room).then(function (h) { meta.roomHash = h ? h.slice(0, 16) : null; }) : Promise.resolve());
    Promise.all(jobs).then(function () {
      if (st.cur !== cur && !cur.done) return;
      cur.started = true;
      report({ type: "kifu-start", key: cur.key, startedAt: cur.startedAt, meta: meta });
      flush(st, cur);
      if (cur.done) report(cur.done);
    });
  }

  function flush(st, cur) {
    if (!cur || !cur.started || cur.buf.length === 0) return;
    var ev = cur.buf;
    cur.buf = [];
    report({ type: "kifu-events", key: cur.key, seq: cur.seq++, events: ev });
  }

  function sweepTextures(cur) {
    var K = keys();
    if (!K) return;
    function walk(list, depth) {
      if (!list || depth > 6) return;
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o) continue;
        try {
          var tk = o.texture && o.texture.key;
          if (typeof tk === "string" && tk.indexOf("__") !== 0 && o.type !== "Text" && !UUID.test(tk)) {
            cur.textures[tk] = 1;
            var fn = o.frame && o.frame.name;
            if (fn !== undefined && fn !== null) (cur.frames[tk] || (cur.frames[tk] = {}))[String(fn)] = 1;
          }
          var ff = o.style && o.style.fontFamily;
          if (typeof ff === "string" && ff) cur.fonts[ff] = 1;
          if (o.list && o.list !== list) walk(o.list, depth + 1);
        } catch (e) {}
      }
    }
    for (var s = 0; s < CFG.scenes.length; s++) {
      var sc = K[CFG.scenes[s]];
      try { if (sc && sc.children && status(sc) >= 5 && status(sc) < 8) walk(sc.children.list, 0); } catch (e) {}
    }
  }

  function detach(cur) {
    try { if (cur.sock && typeof cur.sock.offAny === "function") cur.sock.offAny(cur.onAny); } catch (e) {}
    try {
      if (cur.sock && cur.sock.emit === cur.emitWrap) {
        if (cur.emitWrap.__ulrKifuOwn) cur.sock.emit = cur.emitWrap.__ulrKifuOwn;
        else delete cur.sock.emit;
      }
    } catch (e) {}
    try { if (cur.sock) delete cur.sock.__ulrKifu; } catch (e) {}
  }

  function finish(st, reason) {
    var cur = st.cur;
    if (!cur) return;
    try { sweepTextures(cur); } catch (e) {}
    flush(st, cur);
    detach(cur);
    st.cur = null;
    var usedFrames = {};
    for (var fk in cur.frames) usedFrames[fk] = Object.keys(cur.frames[fk]).sort();
    var end = { type: "kifu-end", key: cur.key, endedAt: Date.now(), reason: reason,
      textures: Object.keys(cur.textures).sort(), frames: usedFrames, fonts: Object.keys(cur.fonts).sort(), lastSeq: cur.seq - 1 };
    if (cur.started) report(end);
    else { cur.done = end; }
  }

  function tick(st) {
    if (window[FLAG] !== st) return;
    try {
      var K = keys();
      var m = K ? K.MainA : null;
      var cur = st.cur;
      if (cur) {
        var rs = cur.sock ? cur.sock.readyState : 3;
        var s = m ? status(m) : 9;
        if (!m || m.socket !== cur.sock) finish(st, "socket-replaced");
        else if (typeof rs === "number" && rs >= 2) finish(st, "socket-closed");
        else if (s >= 8) finish(st, "scene-shutdown");
      }
      if (!st.cur && m && m.socket && status(m) >= 5 && status(m) < 8 && m.is_complete !== true) {
        var rs2 = m.socket.readyState;
        if (!(typeof rs2 === "number" && rs2 >= 2)) attach(st, m, "poll");
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  /** 官方 game_result 的參數記成一則 result（onAny 被官方的 off() 拆掉，那一則收不到）。 */
  function onResult(st, m, args) {
    var cur = st.cur;
    if (!cur || cur.sock !== m.socket || cur.sawResult) return;
    cur.sawResult = true;
    var a = [];
    for (var i = 0; i < args.length; i++) a.push(scrub(args[i], cur.room, 0));
    cur.buf.push([Date.now(), "in", "result", a]);
  }

  function hookProto(st) {
    var K = keys();
    var m = K ? K.MainA : null;
    if (!m) return false;
    var P = Object.getPrototypeOf(m);
    if (!P || typeof P.init !== "function" || typeof P.game_result !== "function") return false;
    // 已經包過（上一版沒拆乾淨）：先拆回原版再包 —— 只換狀態不換程式碼的話，跑的還是舊版的 attach
    if (P.init.__ulrKifu) P.init = P.init.__ulrKifu;
    if (P.game_result.__ulrKifu) P.game_result = P.game_result.__ulrKifu;
    {
      var origInit = P.init;
      var wi = function () {
        var r = origInit.apply(this, arguments);
        try {
          var s2 = wi.__ulrKifuState;
          if (s2 && window[FLAG] === s2 && this.socket) attach(s2, this, "init");
        } catch (e) {}
        return r;
      };
      wi.__ulrKifu = origInit;
      wi.__ulrKifuState = st;
      P.init = wi;
    }
    {
      var origResult = P.game_result;
      var wr = function () {
        try {
          var s3 = wr.__ulrKifuState;
          if (s3 && window[FLAG] === s3) onResult(s3, this, arguments);
        } catch (e) {}
        return origResult.apply(this, arguments);
      };
      wr.__ulrKifu = origResult;
      wr.__ulrKifuState = st;
      P.game_result = wr;
    }
    return true;
  }

  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    try { if (st.flushTimer) clearInterval(st.flushTimer); } catch (e) {}
    try { if (st.sweepTimer) clearInterval(st.sweepTimer); } catch (e) {}
    try { if (st.cur) finish(st, "uninstall"); } catch (e) {}
    try {
      var K = keys(), m = K ? K.MainA : null, P = m ? Object.getPrototypeOf(m) : null;
      if (P && P.init && P.init.__ulrKifu) P.init = P.init.__ulrKifu;
      if (P && P.game_result && P.game_result.__ulrKifu) P.game_result = P.game_result.__ulrKifu;
    } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, cur: null, matches: 0, initHooked: false, reason: null, timer: null, flushTimer: null, sweepTimer: null };
  window[FLAG] = st;
  st.restore = restore;
  st.timer = setInterval(function () {
    if (!st.initHooked) { try { st.initHooked = hookProto(st); } catch (e) {} }
    tick(st);
  }, CFG.pollMs);
  st.flushTimer = setInterval(function () { if (window[FLAG] === st) flush(st, st.cur); }, CFG.flushMs);
  st.sweepTimer = setInterval(function () { if (window[FLAG] === st && st.cur) { try { sweepTextures(st.cur); } catch (e) {} } }, CFG.sweepMs);
  try { st.initHooked = hookProto(st); } catch (e) {}
  tick(st);
  return JSON.stringify({ installed: true, version: st.version, recording: st.cur ? st.cur.key : null,
    matches: st.matches, initHooked: st.initHooked, reason: st.reason });
})()`;
}

export const KIFU_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, recording: null, matches: 0, initHooked: false, reason: null });
    return JSON.stringify({ installed: true, version: st.version, recording: st.cur ? st.cur.key : null,
      matches: st.matches, initHooked: st.initHooked, reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, recording: null, matches: 0, initHooked: false, reason: String((e && e.message) || e) });
  }
})()`;

/** 拆掉：正在錄的那場先收尾送出，再還原 init、拆監聽。 */
export const KIFU_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    if (typeof st.restore === "function") st.restore();
    else delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseKifuStatus(raw: string): KifuStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      recording: null,
      matches: 0,
      initHooked: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    recording: typeof o.recording === "string" ? o.recording : null,
    matches: typeof o.matches === "number" ? o.matches : 0,
    initHooked: o.initHooked === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

// ── 版本快照：Node 在戰鬥結束後來要 ─────────────────────────────────────────

/** 讀一份資料表的 JSON 文字。表不存在回 `null`。 */
export function buildKifuReadTableExpression(name: string): string {
  return `(function () {
  try {
    var v = window.game.cache.json.get(${JSON.stringify(name)});
    return v === undefined ? null : JSON.stringify(v);
  } catch (e) { return null; }
})()`;
}

/**
 * 一張貼圖在 Phaser 裡的樣子：來源圖（從遊戲記憶體裡解碼好的那份用畫布匯出成**無損 WebP**
 * data URL），加上每一格的切法。跟檔案格式無關 —— atlas、spritesheet、單張圖、官方自己
 * 拼出來的畫布全部同一種形狀，重播那邊照著畫就好。
 *
 * ## 為什麼不拿原檔
 *
 * 2026-10-23 實機：官方把每個檔 fetch 成 blob、解碼完就 revoke，`img.src` 的 `blob:` 已經讀不到；
 * 原始網址的網域是從 `UL_CONFIG.domains.assets.urls` 兩個裡隨機挑的（而且每次登入都換），
 * 猜錯那一個就會變成**真的向官方伺服器發請求**。從記憶體匯出完全不碰網路。
 *
 * WebP 品質 1 在 Chrome 是無損（實測解回來像素全等），大小約 PNG 的一半；同樣的像素每次編出來
 * 一樣，跨場、跨 session 照樣靠雜湊去重。
 *
 * ## 巨型共用圖集只匯出用到的格
 *
 * 頭像部件（2048×2048×4）、卡背、卡面這種一張裝幾百上千格的圖集，整張匯出動輒十幾 MB，而一場只畫
 * 其中幾格。來源圖面積超過 `KIFU_WHOLE_TEXTURE_MAX_PIXELS` 而且呼叫端給了用到的格名時，每格各自
 * 切成一張小圖（`sources` 一格一個，`frames` 裡的切法改成指向那張小圖的整張）。
 */
export interface KifuTextureInfo {
  key: string;
  /** 每個 source 一個 data URL；拿不到的是 null */
  sources: (string | null)[];
  /**
   * 格名 → `[source, cutX, cutY, cutW, cutH, trimX, trimY, realW, realH, rotated(0/1)]`。
   * 含 `__BASE`（整張圖；單張圖只有這一格）。只匯出用到的格時，只列那些格。
   */
  frames: Record<string, number[]>;
  /**
   * 這張貼圖同時是點陣字（狀態數字、傷害數字那些）時，Phaser 解析好的字形資料
   * （`cache.bitmapFont.get(key).data`：chars／lineHeight／kerning…）原樣。
   */
  bitmapFont?: unknown;
  /** 只匯出了用到的格（巨型圖集） */
  partial?: boolean;
}

/** 來源圖面積（所有 source 加總）超過這個就只匯出用到的格。 */
export const KIFU_WHOLE_TEXTURE_MAX_PIXELS = 1_500_000;

/**
 * 一次問多張貼圖。不存在的 key 不列。
 * @param usedFrames 戰鬥中畫過的格（`KifuEndReport.frames`）；巨型圖集只匯出這些
 */
export function buildKifuTextureInfoExpression(
  textureKeys: readonly string[],
  usedFrames: Readonly<Record<string, readonly string[]>> = {},
): string {
  return `(function () {
  try {
    var want = JSON.parse(${embedJson(textureKeys)});
    var used = JSON.parse(${embedJson(usedFrames)});
    var MAX = ${KIFU_WHOLE_TEXTURE_MAX_PIXELS};
    var T = window.game.textures, out = [];
    function exportRect(img, x, y, w, h) {
      try {
        if (!img || !w || !h) return null;
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
        return c.toDataURL("image/webp", 1);
      } catch (e) { return null; }
    }
    function cut(f) {
      return [f.sourceIndex, f.cutX, f.cutY, f.cutWidth, f.cutHeight, f.x, f.y, f.realWidth, f.realHeight, f.rotated ? 1 : 0];
    }
    for (var i = 0; i < want.length; i++) {
      var k = want[i];
      if (!T.exists(k)) continue;
      var t = T.get(k), sources = [], frames = {}, area = 0, item;
      for (var j = 0; j < t.source.length; j++) area += (t.source[j].width || 0) * (t.source[j].height || 0);
      var only = used[k];
      if (area > MAX && Array.isArray(only) && only.length > 0) {
        for (var u = 0; u < only.length; u++) {
          var f0 = t.frames[only[u]];
          if (!f0) continue;
          var src0 = t.source[f0.sourceIndex];
          sources.push(exportRect(src0 && (src0.image || src0.source), f0.cutX, f0.cutY, f0.cutWidth, f0.cutHeight));
          var row = cut(f0);
          row[0] = sources.length - 1; row[1] = 0; row[2] = 0;
          frames[only[u]] = row;
        }
        item = { key: k, sources: sources, frames: frames, partial: true };
      } else {
        for (var s = 0; s < t.source.length; s++) {
          var sr = t.source[s];
          sources.push(exportRect(sr.image || sr.source, 0, 0, sr.width, sr.height));
        }
        var names = t.getFrameNames(true);
        for (var n = 0; n < names.length; n++) {
          var f = t.frames[names[n]];
          if (f) frames[names[n]] = cut(f);
        }
        item = { key: k, sources: sources, frames: frames };
      }
      try {
        var bf = window.game.cache.bitmapFont.get(k);
        if (bf && bf.data) item.bitmapFont = bf.data;
      } catch (e) {}
      out.push(item);
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;
}

export interface KifuUrlHash {
  url: string;
  sha: string | null;
  size: number;
  type: string | null;
  error?: string;
}

/**
 * 對每個網址：從瀏覽器快取讀（`force-cache`：遊戲剛載過的檔不會再問伺服器）、算 SHA-256。
 * 只回雜湊不回內容 —— Node 手上已經有的就不必搬。
 */
export function buildKifuHashUrlsExpression(urls: readonly string[]): string {
  return `(async function () {
  var want = JSON.parse(${embedJson(urls)});
  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }
  var out = [];
  for (var i = 0; i < want.length; i++) {
    var u = want[i];
    try {
      var r = await fetch(u, { cache: "force-cache", credentials: "same-origin" });
      if (!r.ok) { out.push({ url: u, sha: null, size: 0, type: null, error: "HTTP " + r.status }); continue; }
      var buf = await r.arrayBuffer();
      var h = await crypto.subtle.digest("SHA-256", buf);
      out.push({ url: u, sha: hex(h), size: buf.byteLength, type: r.headers.get("content-type") });
    } catch (e) {
      out.push({ url: u, sha: null, size: 0, type: null, error: String((e && e.message) || e) });
    }
  }
  return JSON.stringify(out);
})()`;
}

/**
 * 遊戲從美術目錄載入的字型檔網址（2026-10-23：只有 BradleyGratis.otf —— 數字用的那套）。
 *
 * 中文字的 font_light／font_heavy… 是思源宋體 `.ttc`（每個幾十 MB、從 `ulfont://` 自訂協定載，
 * 跟遊戲版本無關），不存；重播用系統的思源／Noto 宋體。
 */
export const KIFU_FONT_FILES_EXPRESSION = `(function () {
  try {
    var out = [];
    var list = performance.getEntriesByType("resource");
    for (var i = 0; i < list.length; i++) {
      var u = String(list[i].name || "");
      if (u.indexOf("/Fonts/") < 0) continue;
      var m = /\\/([^\\/?#]+)\\.(otf|ttf|woff2?)(?:[?#]|$)/.exec(u);
      if (m && out.indexOf(u) < 0) out.push(u);
    }
    return JSON.stringify(out);
  } catch (e) { return "[]"; }
})()`;

/** 讀一個網址的內容，回 base64（同樣走瀏覽器快取）。失敗回 `null`。 */
export function buildKifuReadUrlExpression(url: string): string {
  return `(async function () {
  try {
    var r = await fetch(${JSON.stringify(url)}, { cache: "force-cache", credentials: "same-origin" });
    if (!r.ok) return null;
    var blob = await r.blob();
    return await new Promise(function (ok) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ""); var at = s.indexOf(","); ok(at < 0 ? null : s.slice(at + 1)); };
      fr.onerror = function () { ok(null); };
      fr.readAsDataURL(blob);
    });
  } catch (e) { return null; }
})()`;
}
