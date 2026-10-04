/**
 * SUPPORT 公開渦清單（給公開渦通知 raid-feed 用）
 * ==============================================
 * 2026-10-03 實機：按 SUPPORT（`Raid.raid_support_btn` 的 `click`）→ `create_raid_support()` →
 * `this.raid_support = await this.socket.fetch("db_raid_support")`。原始列放在場景的
 * `Raid.raid_support`，**關掉面板也不會清掉**（`close_raid_support` 只清畫面用的
 * `raid_support_list`），下次打開才整批換掉。
 *
 * ```
 *   Raid.raid_support[i] = { profound_code, raid_name, monster_id, founder_name,
 *                            hp, hp_max, limit, profound_date, member_length, member_limit }
 * ```
 *
 * ## ⚠ 那份陣列可能放了很久
 *
 * 關掉面板也不清，所以它是「最後一次打開 SUPPORT 時」的樣子 —— 可能是一小時前，裡面的渦
 * 早就死了。2026-10-03 就這樣把一個死掉的渦當新渦發到 Discord（桌面版很早以前開過 SUPPORT，
 * 換上新版插件後第一輪就把那份舊清單傳上去了）。
 *
 * 所以不讀 `Raid.raid_support`，改成**看回應**：只交插件包上之後、{@link RAID_SUPPORT_MAX_AGE_MS}
 * 內收到的那份 `db_raid_support` 回應（記在 `window.__ulrSupportLatest`）。
 *
 * ## 包在哪：連線類別的 `once`
 *
 * 官方連線類別的 `fetch(ev)` 是 `this.once(ev, 回呼)` 等回應、`this.emit(ev)` 送出（2026-10-03 讀的原始碼）。
 * 要抓的人不只 SUPPORT 那顆鈕：Moon/打渦.py 在渦房裡直接 `R.socket.fetch("db_raid_support")`、
 * 渦房外還**自己開一條新連線**問 —— 都不經過 `create_raid_support`。它們都是同一個類別，所以包
 * **原型上的 `once`**：誰在等 `db_raid_support` 的回應，回應來的時候順手記一份。
 * （`fetch`／`emit` 每條連線身上另有一份被別的 patch 包過的，蓋掉了原型的；`once` 沒有。）
 *
 * 收到的那一刻也**當場通知托盤**（跟 patch-raid-view 記下 stage 時同一種回報 `raid-stage`），
 * 托盤馬上傳，不等 30 秒那一輪 —— 跟著玩家（或腳本）的操作走。
 *
 * 不送任何請求：只記別人本來就在問的那份回應。
 *
 * ## 自己開、自己公開的渦（2026-10-03）
 *
 * 發現者按渦碼視窗的「送出」→ 確認 OK，官方送 `socket.emit("raid_code_send", profound_id)`
 * （「要對能參加的玩家送出 Raid 的邀請嗎？」）。參加資格（`only_friend`，渦碼視窗的下拉選單
 * 「無限制／僅限好友」）是「無限制」時這就是公開給所有人 —— 不必等別人打開 SUPPORT。
 * 讀的時候順手包目前渦房那條連線的 `emit`：看到 `raid_code_send` 而且那個渦
 * **不是**僅限好友，就記下來（`window.__ulrRaidPublished`，同一個渦只記一次）、叫托盤馬上傳。
 * 僅限好友的一律不記。換了連線，raid-view 下一拍（300ms）就包到新的上。
 *
 * ⚠ **`emit` 不能包在原型上**（2026-10-04 事故）。patch-ok 每 200ms 看原型的 `emit`，
 * 不是它自己那支就把**當下那支**存成 originalEmit 再換回自己 —— 我們包在它上面的那層
 * （裡面叫的是它）就被它存走，變成 patchedEmit → 我們 → patchedEmit → … 繞成環。
 * 打完一場（patch-ok 裝上）再進渦房，之後這頁**每一個** emit（fetch 底下也是）都
 * Maximum call stack size exceeded，SUPPORT、加入、開打全失敗，直到遊戲重載。
 * 所以只包在連線實例上，而且每次呼叫才去原型拿**現在的** `emit`，不存舊的。
 *
 * ## BOSS 代碼（判斷渦幾）
 *
 * 清單只給 `monster_id`，`CharaCards` 查得到它的 `chara`（`mc1006_02`）——官方 SUPPORT 畫 BOSS 名
 * 也是這樣查的。代碼尾碼 `_01/_02/_03` 是渦I／渦II·III／渦IV（照 Moon/打渦.py 的 渦階()）。
 *
 * ⚠ **`profound_code` 是渦碼＝門票，在頁面裡就丟掉**，不會進到托盤。
 */

/** SUPPORT 的一列（沒有渦碼）。 */
export interface RaidSupportRow {
  founder: string;
  /** 發現時刻（`profound_date`，跟自己清單的 `found_at` 同一個值） */
  foundAt: number;
  limit: number;
  name: string | null;
  monsterId: number | null;
  /** BOSS 代碼（`CharaCards` 的 `chara`，例如 `mc1006_02`）；查不到是 null */
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  memberLength: number | null;
  memberLimit: number | null;
}

/** 發現者自己按「送出」公開的渦（只有參加資格「無限制」的）。 */
export interface RaidPublishedRow {
  founder: string;
  foundAt: number;
  limit: number;
  name: string | null;
  monsterId: number | null;
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  rarity: number | null;
  level: number | null;
  mapIndex: number | null;
  /** 按下送出的時刻 */
  at: number;
}

/** 頁面通知托盤用的 binding（跟 adapter.ts 的 `REPORT_BINDING_NAME` 同一個，測試會對）。 */
export const RAID_SUPPORT_REPORT_BINDING = "__ulrCompanionReport";

/** SUPPORT 清單拿到多久以內才算新的。 */
export const RAID_SUPPORT_MAX_AGE_MS = 60 * 1000;

/** 公開的紀錄留多久（托盤會在這之內傳掉；之後就丟）。 */
export const RAID_PUBLISHED_KEEP_MS = 10 * 60 * 1000;

/** 頁面上的共用小工具：BOSS 代碼查詢、叫托盤。兩支運算式都塞這一段。 */
const PAGE_HELPERS = `
    var G = window.game;
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Raid : null;
    var num = function (v) { return typeof v === "number" && isFinite(v) ? v : null; };
    var tell = function () {
      try {
        var fn = window["${RAID_SUPPORT_REPORT_BINDING}"];
        if (typeof fn === "function") fn(JSON.stringify({ type: "raid-stage" }));
      } catch (e) {}
    };
    var monsOf = function (id) {
      try {
        var cards = G.cache.json.get("CharaCards") || [];
        for (var i = 0; i < cards.length; i++) if (cards[i] && cards[i].id === id) return typeof cards[i].chara === "string" ? cards[i].chara : null;
      } catch (e) {}
      return null;
    };`;

/**
 * 包連線類別原型的 `once`（看 `db_raid_support` 的回應；只有這支包 `once`）與目前渦房那條連線
 * 實例的 `emit`（自己按送出公開；為什麼不包原型見檔頭）。包過的不再包。
 * 舊版包在原型上的 `emit` 順手拆掉。
 */
const PAGE_INSTALL = `
    var sock = R ? R.socket : null;
    var SP = sock ? Object.getPrototypeOf(sock) : null;
    if (SP && typeof SP.once === "function" && !SP.once.__ulrFeed) {
      var origOnce = SP.once;
      var wrappedOnce = function (ev, cb) {
        if (ev === "db_raid_support" && typeof cb === "function") {
          var cb2 = function (rows) {
            try {
              if (Array.isArray(rows)) { window.__ulrSupportLatest = { at: Date.now(), rows: rows }; tell(); }
            } catch (e) {}
            return cb.apply(this, arguments);
          };
          return origOnce.call(this, ev, cb2);
        }
        return origOnce.apply(this, arguments);
      };
      wrappedOnce.__ulrFeed = origOnce;
      SP.once = wrappedOnce;
    }
    var onSend = function (ev, id) {
      try {
        if (ev !== "raid_code_send") return;
        var RR = window.game && window.game.scene && window.game.scene.keys ? window.game.scene.keys.Raid : null;
        var list = RR && Array.isArray(RR.raid_list) ? RR.raid_list : [];
        var r = null;
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].profound_id === id) r = list[i];
        // 僅限好友的不算公開
        if (!r || r.only_friend === true || typeof r.founder !== "string" || typeof r.found_at !== "number") return;
        var P = window.__ulrRaidPublished || (window.__ulrRaidPublished = []);
        // 同一個渦只記一次（重按送出、或連線身上另有一層也包了）
        for (var j = 0; j < P.length; j++) if (P[j].founder === r.founder && P[j].foundAt === r.found_at) return;
        P.push({ founder: r.founder, foundAt: r.found_at, limit: r.limit, name: typeof r.name === "string" ? r.name : null,
          monsterId: num(r.monster_id), mons: monsOf(r.monster_id), hp: num(r.hp), hpMax: num(r.hp_max),
          rarity: num(r.rarity), level: num(r.level), mapIndex: num(r.map_index), at: Date.now() });
        tell();
      } catch (e) {}
    };
    // 舊版包在原型上的那層拆掉（已經被 patch-ok 存走的救不回來，要等遊戲重載）
    if (SP && Object.prototype.hasOwnProperty.call(SP, "emit") && SP.emit && typeof SP.emit.__ulrFeedEmit === "function") {
      SP.emit = SP.emit.__ulrFeedEmit;
    }
    if (sock && typeof sock.emit === "function" && !sock.emit.__ulrFeedEmit) {
      // 連線身上本來就有一份（別的 patch 包的）就叫那份；沒有就每次去原型拿現在的
      var own = Object.prototype.hasOwnProperty.call(sock, "emit") ? sock.emit : null;
      var w = function (ev, id) {
        onSend(ev, id);
        var f = own || Object.getPrototypeOf(sock).emit;
        return f.apply(this, arguments);
      };
      w.__ulrFeedEmit = true;
      sock.emit = w;
    }`;

/**
 * 只裝攔截、不讀（函式本體，給 patch-raid-view 的輪詢塞進去用）。
 *
 * 2026-10-03 漏掉一隻妖精：遊戲重整完、一進渦房就按 SUPPORT 加入了。這兩支運算式只在托盤
 * 30 秒那一輪（人在渦房時）才跑，攔截還沒裝上，那份清單就沒攔到；加入之後 SUPPORT 不再列它，
 * 之後也補不回來。raid-view 連上就裝、每 300ms 看一次，進渦房的下一拍就裝好。
 */
export const RAID_SUPPORT_HOOK_BODY = `try {${PAGE_HELPERS}${PAGE_INSTALL}
    } catch (e) {}`;

export const RAID_SUPPORT_SNAPSHOT_EXPRESSION = `(function () {
  try {${PAGE_HELPERS}${PAGE_INSTALL}
    var latest = window.__ulrSupportLatest;
    if (!latest || !Array.isArray(latest.rows)) return JSON.stringify({ rows: [] });
    var at = latest.at;
    if (typeof at !== "number" || Date.now() - at > ${RAID_SUPPORT_MAX_AGE_MS}) return JSON.stringify({ rows: [], stale: true });
    var list = latest.rows;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.founder_name !== "string" || typeof r.profound_date !== "number" || typeof r.limit !== "number") continue;
      // 渦碼（profound_code）不拿
      out.push({ founder: r.founder_name, foundAt: r.profound_date, limit: r.limit,
        name: typeof r.raid_name === "string" ? r.raid_name : null, monsterId: num(r.monster_id), mons: monsOf(r.monster_id),
        hp: num(r.hp), hpMax: num(r.hp_max), memberLength: num(r.member_length), memberLimit: num(r.member_limit) });
    }
    return JSON.stringify({ rows: out, fetchedAt: at });
  } catch (e) {
    return JSON.stringify({ rows: [], reason: String((e && e.message) || e) });
  }
})()`;

/** 自己按送出公開的渦（{@link RAID_PUBLISHED_KEEP_MS} 內的）。不清掉：托盤自己記傳過哪些。 */
export const RAID_PUBLISHED_SNAPSHOT_EXPRESSION = `(function () {
  try {${PAGE_HELPERS}${PAGE_INSTALL}
    var P = window.__ulrRaidPublished || [];
    var now = Date.now();
    for (var i = P.length - 1; i >= 0; i--) if (!P[i] || now - P[i].at > ${RAID_PUBLISHED_KEEP_MS}) P.splice(i, 1);
    return JSON.stringify({ rows: P });
  } catch (e) {
    return JSON.stringify({ rows: [], reason: String((e && e.message) || e) });
  }
})()`;

function rowsOf<T extends { founder: string; foundAt: number; limit: number }>(raw: string): T[] {
  try {
    const o = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(o.rows)) return [];
    return (o.rows as T[]).filter(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        typeof r.founder === "string" &&
        typeof r.foundAt === "number" &&
        typeof r.limit === "number",
    );
  } catch {
    return [];
  }
}

export function parseRaidSupportSnapshot(raw: string): RaidSupportRow[] {
  return rowsOf<RaidSupportRow>(raw);
}

export function parseRaidPublishedSnapshot(raw: string): RaidPublishedRow[] {
  return rowsOf<RaidPublishedRow>(raw);
}
