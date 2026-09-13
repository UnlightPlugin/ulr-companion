/**
 * 開機資料檔的防護：CDN 回錯時自己補抓
 * ====================================
 * 遊戲開機時 `Initialize` 場景一口氣載二十幾支 JSON（卡片、事件卡、道具…），
 * 載完在 `create()` 裡把其中幾支餵給 unlight-common 的靜態表：
 *
 * ```js
 *   AvatarItem.init(cache.json.get("avatar_item"))
 *   AvatarPart.init(cache.json.get("avatar_parts"))
 *   EventData.init(cache.json.get("event_info"))
 *   Chara.initChara(cache.json.get("cc_asset"), cache.json.get("charaProfile"))
 *   Chara.initMons(cache.json.get("mc_asset"), cache.json.get("mc_boss"), cache.json.get("monsProfile"))
 * ```
 *
 * **官方不重試。** 2026-09-13 實機：Cloudflare 對 `event_asset.json` 回了一次
 * 409，Phaser 把那支當載入失敗、不進快取，`EventData.eventJSON` 就一直是
 * undefined。之後每次進牌組編輯，`Edit.create()` 走到 costcheck →
 * `EventData.get()` 讀 `undefined.frames` 就丟例外，場景卡在 CREATING：
 * 事件卡擠在左上角、Total Cost 空白、直連圖示沒掛上。玩家以為是插件改壞了。
 * 同一支檔當下重抓就是 200。
 *
 * 這支做的事：`Initialize` 跑完之後檢查這些檔在不在快取裡，不在的自己 fetch、
 * `cache.json.add`，是上面那幾支的話再呼叫一次對應的 init。全部補齊就停。
 *
 * ## 靜態表怎麼找
 *
 * 跟 `patch-penalty` 一樣從 webpack 的 chunk 陣列拿 `__webpack_require__`，掃
 * 模組登錄表裡含 `__webpack_exports__EventData` 的那一支（unlight-common 整包
 * 是一個模組）。匯出名是壓縮過的（`RV`、`d1`…），每次重建都會變，所以**看 init
 * 的原始碼認人**：`eventJSON`／`itemJSON`／`partJSON`，Chara 看 `initChara`／
 * `initMons` 這兩個名字（TS 的靜態方法名不會被壓）。
 *
 * ⚠ 已經建壞的場景救不回來（卡在 CREATING 的那一份），補齊之後離開再進一次
 * 就好。所以補到的時候要回報，托盤寫一行告訴玩家。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrAssetGuard";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const ASSET_GUARD_SCRIPT_VERSION = 1;

export const DEFAULT_ASSET_GUARD_POLL_MS = 2_000;

/** 一支檔最多重抓幾次。 */
export const DEFAULT_ASSET_GUARD_MAX_ATTEMPTS = 6;

/**
 * `Initialize.preload()` 載的 JSON（2026-09-13 從跑著的客戶端讀的）。快取鍵 → 路徑。
 * 少了 `shop_event`：它的檔名帶活動日期（event_20260312.json），每期都換，寫死會抓錯。
 */
export const GAME_DATA_FILES: readonly { key: string; path: string }[] = [
  { key: "achievements", path: "images/assets/data/achievements.json" },
  { key: "avatar_item", path: "images/assets/data/avatar_item.json" },
  { key: "avatar_parts", path: "images/assets/data/avatar_parts.json" },
  { key: "cc_asset", path: "images/assets/data/cc_asset.json" },
  { key: "charaProfile", path: "images/assets/data/charaProfile.json" },
  { key: "event_info", path: "images/assets/data/event_asset.json" },
  { key: "exp_table", path: "images/assets/data/exp.json" },
  { key: "lot_bronze", path: "images/assets/data/lot_bronze.json" },
  { key: "lot_gold", path: "images/assets/data/lot_gold.json" },
  { key: "lot_silver", path: "images/assets/data/lot_silver.json" },
  { key: "lot_special", path: "images/assets/data/lot_special.json" },
  { key: "mc_asset", path: "images/assets/data/mc_asset.json" },
  { key: "mc_boss", path: "images/assets/data/mc_boss.json" },
  { key: "monsProfile", path: "images/assets/data/monsProfile.json" },
  { key: "quest", path: "images/assets/data/quest.json" },
  { key: "quest_lands", path: "images/assets/data/quest_lands.json" },
  { key: "queststory", path: "images/assets/data/queststory.json" },
  { key: "shop", path: "images/assets/data/shop.json" },
  { key: "stamp_info", path: "images/assets/data/stamp_info.json" },
  { key: "state_info", path: "images/assets/data/state.json" },
  { key: "passiveskills", path: "images/assets/data/PassiveSkills.json" },
  { key: "lobby_reward", path: "images/assets/data/lobby_reward.json" },
  { key: "lobby_achievement", path: "images/assets/data/lobby_achievement.json" },
];

/** 補抓了一支檔（或放棄了）。 */
export interface AssetRepairReport {
  type: "asset-repair";
  key: string;
  ok: boolean;
  /** 補到之後有沒有重新餵給靜態表（EventData 那幾支才有） */
  reinit: boolean;
  reason: string | null;
}

export function isAssetRepairReport(value: unknown): value is AssetRepairReport {
  const o = value as { type?: unknown; key?: unknown; ok?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "asset-repair" &&
    typeof o.key === "string" &&
    typeof o.ok === "boolean"
  );
}

export interface AssetGuardStatus {
  installed: boolean;
  version: number | null;
  /** 補回來的快取鍵 */
  repaired: string[];
  /** 現在還缺的快取鍵（開機還沒跑完時是空的） */
  missing: string[];
  reason: string | null;
}

export interface AssetGuardPatchOptions {
  bindingName: string;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export function buildAssetGuardPatchScript(options: AssetGuardPatchOptions): string {
  const config = {
    version: ASSET_GUARD_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ASSET_GUARD_POLL_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_ASSET_GUARD_MAX_ATTEMPTS,
    files: GAME_DATA_FILES,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys && window.game.cache ? window.game : null;
  }
  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }

  /** Initialize 的 create 跑過了沒（RUNNING 以上：5 跑著、8 已經收掉）。 */
  function bootDone(G) {
    var s = G.scene.keys.Initialize;
    try { return !!(s && s.sys && s.sys.settings && s.sys.settings.status >= 5); } catch (e) { return false; }
  }

  function missingKeys(G) {
    var out = [];
    for (var i = 0; i < CFG.files.length; i++) if (!G.cache.json.exists(CFG.files[i].key)) out.push(CFG.files[i]);
    return out;
  }

  /** 檔案網址：優先用瀏覽器當初抓那支的網址（失敗的也會留紀錄），不然拿任一支資產的前綴拼。 */
  function urlOf(path) {
    var base = null;
    try {
      var list = performance.getEntriesByType("resource");
      for (var i = 0; i < list.length; i++) {
        var name = list[i].name;
        if (name.indexOf("/" + path) !== -1) return name.split("?")[0];
        var at = name.indexOf("images/assets/");
        if (base === null && at !== -1) base = name.slice(0, at);
      }
    } catch (e) {}
    return base === null ? null : base + path;
  }

  // ---- unlight-common 的靜態表 ---------------------------------------------
  function webpackRequire() {
    var chunkKey = null;
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      if (/webpack/i.test(keys[i]) && Array.isArray(window[keys[i]])) { chunkKey = keys[i]; break; }
    }
    if (chunkKey === null) return null;
    window.__ulrChunkSeq = (window.__ulrChunkSeq || 0) + 1;
    var req = null;
    window[chunkKey].push([["__ulr_" + window.__ulrChunkSeq], {}, function (r) { req = r; }]);
    return typeof req === "function" && req.m ? req : null;
  }
  function tables(st) {
    if (st.tables) return st.tables;
    var req = webpackRequire();
    if (req === null) return null;
    var found = { event: null, item: null, part: null, chara: null };
    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (src.indexOf("__webpack_exports__EventData") === -1) continue;
      var mod;
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var v;
        try { v = mod[k]; } catch (e) { continue; }
        if (!v || (typeof v !== "function" && typeof v !== "object")) continue;
        if (typeof v.initChara === "function" && typeof v.initMons === "function") { found.chara = v; continue; }
        if (typeof v.init !== "function") continue;
        var init = String(v.init);
        if (init.indexOf("eventJSON") !== -1) found.event = v;
        else if (init.indexOf("itemJSON") !== -1) found.item = v;
        else if (init.indexOf("partJSON") !== -1) found.part = v;
      }
      break;
    }
    st.tables = found;
    return found;
  }
  /** 補到一支之後，是靜態表要的就重新餵一次。回 true = 餵了。 */
  function reinit(st, G, key) {
    var T = tables(st);
    if (!T) return false;
    var get = function (k) { return G.cache.json.get(k); };
    var has = function (k) { return G.cache.json.exists(k); };
    if (key === "event_info" && T.event) { T.event.init(get("event_info")); return true; }
    if (key === "avatar_item" && T.item) { T.item.init(get("avatar_item")); return true; }
    if (key === "avatar_parts" && T.part) { T.part.init(get("avatar_parts")); return true; }
    if ((key === "cc_asset" || key === "charaProfile") && T.chara && has("cc_asset") && has("charaProfile")) {
      T.chara.initChara(get("cc_asset"), get("charaProfile"));
      return true;
    }
    if ((key === "mc_asset" || key === "mc_boss" || key === "monsProfile") && T.chara && has("mc_asset") && has("mc_boss") && has("monsProfile")) {
      T.chara.initMons(get("mc_asset"), get("mc_boss"), get("monsProfile"));
      return true;
    }
    return false;
  }

  function repair(st, G, file) {
    var n = (st.attempts[file.key] || 0) + 1;
    st.attempts[file.key] = n;
    st.inflight[file.key] = true;
    var url = urlOf(file.path);
    if (url === null) { st.inflight[file.key] = false; st.reason = "找不到資產網址"; return; }
    fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      if (window[FLAG] !== st) return;
      st.inflight[file.key] = false;
      if (!G.cache.json.exists(file.key)) G.cache.json.add(file.key, data);
      var fed = false;
      try { fed = reinit(st, G, file.key); } catch (e) { st.reason = "reinit " + file.key + ": " + String((e && e.message) || e); }
      st.repaired.push(file.key);
      report({ type: "asset-repair", key: file.key, ok: true, reinit: fed, reason: null });
    }).catch(function (e) {
      if (window[FLAG] !== st) return;
      st.inflight[file.key] = false;
      var why = String((e && e.message) || e);
      st.reason = file.key + ": " + why;
      if (n >= CFG.maxAttempts) report({ type: "asset-repair", key: file.key, ok: false, reinit: false, reason: why });
    });
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      if (!G || !bootDone(G)) return;
      var missing = missingKeys(G);
      if (missing.length === 0) {
        clearInterval(st.timer);
        st.timer = null;
        return;
      }
      for (var i = 0; i < missing.length; i++) {
        var f = missing[i];
        if (st.inflight[f.key] || (st.attempts[f.key] || 0) >= CFG.maxAttempts) continue;
        repair(st, G, f);
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = { version: CFG.version, timer: null, attempts: {}, inflight: {}, repaired: [], tables: null, reason: null };
  window[FLAG] = st;
  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();
  var G0 = gameOf();
  return JSON.stringify({
    installed: true, version: st.version, repaired: st.repaired,
    missing: G0 && bootDone(G0) ? missingKeys(G0).map(function (f) { return f.key; }) : [],
    reason: st.reason
  });
})()`;
}

export const ASSET_GUARD_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, repaired: [], missing: [], reason: null });
    return JSON.stringify({ installed: true, version: st.version, repaired: st.repaired, missing: [], reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, repaired: [], missing: [], reason: String((e && e.message) || e) });
  }
})()`;

/** 拆掉：只停輪詢。補進快取的資料留著 —— 那本來就是遊戲該有的。 */
export const ASSET_GUARD_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseAssetGuardStatus(raw: string): AssetGuardStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      repaired: [],
      missing: [],
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    repaired: strings(o.repaired),
    missing: strings(o.missing),
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
