/**
 * 返回鈕左邊的直連捷徑列：DUEL／RAID／QUEST／DECK
 * ==============================================
 * 玩家在任務房想去渦房，原本得「返回 → 等大廳整輪載完（register／db_player／
 * db_avatar／三副牌組／成就／排行，兩次 700ms 淡出淡入，實測 5 秒）→ 關掉
 * 大廳跳出來的公告 → 再點渦」。這支把大廳那四顆鈕縮小放到每個房間的返回鈕
 * 左邊，點一下直接跳過去：
 *
 * ```
 *   ┌────────────────────────────────────────── (◎)(◎)(◎)(◎) [BACK] ┐
 *   │  DeckEdit (?) COST [●] 自訂            DUEL RAID QUEST DECK      │
 * ```
 *
 * 圖跟動畫**直接用大廳那一套**（`duel_btn` 的 40 格轉圈、`quest_btn` 的
 * 41 格、渦的旋轉圖示、`deck_btn` 的 16 格），只是縮到直徑 28。DECK 在大廳
 * 是方的，這裡套一個圓形遮罩加黑邊，跟另外三顆一致。
 *
 * ## 跳法：按官方返回鈕，把它最後那句 `scene.start("Lobby")` 改道
 *
 * 大廳那四顆鈕做的事（2026-09-24 從跑著的客戶端讀的，2026-09-23 改版後）：
 *
 * ```js
 *   Lobby.move_scene(t, e) { 淡出 → this.scene.start(t, e) }
 *   duel → move_scene("Match")   quest → move_scene("Quest")
 *   raid → move_scene("Raid")    deck  → move_scene("Edit")
 * ```
 *
 * 一個參數都不帶：每個場景的 `init()` 自己從 registry 拿 player_id、從
 * `UL_CONFIG.domains` 挑伺服器。（改版前要湊 `{id, host, port}`，還得另開
 * 臨時連線跟大廳要 quest_port／raid_port —— 那段已經拿掉。）
 *
 * 所以**不自己淡出、不自己存檔**，而是：
 *
 * ```
 *   1. 把這個場景 ScenePlugin 的 start 蓋成我們的（實例自有屬性）
 *   2. 對官方返回鈕 emit 它吃的那個事件（CFG.backEvent）
 *   3. 官方流程照跑：音效、淡出、Edit 的 deck_update、Item 的 avatar_update、
 *      Library 的 update_chara_favorite、Option 的 option_exit …
 *   4. 它最後叫 this.scene.start("Lobby", …) → 進到我們的：
 *      清掉所有非常駐場景 → game.scene.start(目標, 參數)，然後把 start 還原
 * ```
 *
 * 舊版（同一天早幾個小時）是自己淡出、自己抄每個畫面離開時的副作用 ——
 * 抄到 Library 就抄不下去了：它的返回鈕是 `emit("library_quit")`，回應的
 * handler 直接 `scene.start("Lobby")`，繞不開。改道之後**一個副作用都不用
 * 抄**，遊戲改了離開流程我們也跟著對。
 *
 * 清場走 SceneManager 層的 `game.scene.start(目標)`，之前先把所有**非常駐**
 * 場景 stop 掉（常駐名單在 `scene-jump.ts`，含改版新增的 Session；這些在每個
 * 畫面都在，收掉就是把遊戲拆了）。理由見 `Moon/對戰.py` 的 JS_直達：戰鬥畫面
 * 是一疊 launch 出來的場景，只 stop 一個會留一團疊影。
 *
 * ⚠ 改道有看門狗（`armTimeoutMs`）：官方流程沒走到 start（Edit 的 deck_update
 * 被伺服器退回、伺服器不回…）就把 start 還原、按鈕亮回來。
 *
 * ⚠ 改道**只攔 "Lobby"**。其他的 start（Edit 進合成之類）原樣放行並解除。
 *
 * ⚠ Tutorial 的返回鈕是 `create()` 裡的局部變數，場景身上沒有 `btn_back`，
 * 得從 `children.list` 找 texture 是 `btn_back` 的那顆（`backButtonOf`）。
 * Compo 不放：它的返回是回 Edit，不是回大廳。
 *
 * ## 只在官方返回鈕能按的時候能按
 *
 * 「現在能不能離開這一房」由遊戲決定：返回鈕被 `disableInteractive()` 或藏
 * 起來時（在房裡等人、送出 START 之後…）這一排跟著變暗、點不動。這比自己
 * 判斷每一種狀態可靠得多。任務進行中返回鈕是開的，所以捷徑也開 —— 這是
 * 玩家要的。戰鬥畫面（MainA）沒有返回鈕，這一排根本不會出現。
 *
 * ## 圖是自己載的
 *
 * 大廳的貼圖離開大廳就被 `UL_LOADER.force_clean()` 卸掉了（它按場景登記，
 * 場景 unregister 後下一次載入就 `textures.remove`）。所以這支用自己的 key
 * （`__ulrNav_*`）從 `UL_CONFIG.domains.assets.urls` 抓同一批圖（路徑從
 * `UL_ASSETS.lobby` 查），`fetch` → blob → `textures.addSpriteSheet`／`addAtlas`。
 * 不走場景的 loader：那個跟 UL_LOADER 的
 * `once("complete")` 共用，插隊會讓別人的 callback 提早或延後。用自己的 key
 * 也讓 UL_LOADER 完全看不到我們（它只清它登記過的）。每次頁面載一次，約
 * 10 MB 貼圖，卸載時 `textures.remove`。
 *
 * ## 每個場景進來都重 create
 *
 * 跟 `patch-cost-toggle` 一樣：輪詢盯著「名單裡哪個場景 active、而且我們的
 * 東西已經跟著舊場景死了」，是的話重掛。**「掛過了沒」記在 GameObject 上**
 * （`st.anchor.scene`），場景物件是長命的，記在它身上第二次進房不會重掛。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import { embedJson } from "./embed.js";
import { JUMP_PERSISTENT_SCENES, SCENE_JUMP_SNIPPET } from "./scene-jump.js";

const FLAG = "__ulrNav";

/**
 * 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。
 * 跟 `patch-present` 一樣是「先拆再裝」，版本號是回報用的。
 */
export const NAV_SCRIPT_VERSION = 4;

export const DEFAULT_NAV_POLL_MS = 500;

/**
 * 按下官方返回鈕之後最多等多久它走到 scene.start。官方淡出 700ms，Edit 還要
 * 等一次存檔回應（實測 4 秒逾時）；時間到就把改道拆掉、按鈕亮回來 ——
 * 這是 Edit「Deck1 空、彈錯誤框不讓走」那條路的收尾。
 */
export const DEFAULT_NAV_ARM_TIMEOUT_MS = 6_000;

/** 目的地。**順序就是畫面上從左到右的順序。** */
export const NAV_TARGETS = ["duel", "raid", "quest", "deck"] as const;
export type NavTarget = (typeof NAV_TARGETS)[number];

/** 目的地 → 場景名。 */
export const NAV_TARGET_SCENE: Record<NavTarget, string> = {
  duel: "Match",
  raid: "Raid",
  quest: "Quest",
  deck: "Edit",
};

/**
 * 會掛這一排的場景。**只放「官方返回鈕就是回大廳、而且離開的副作用抄得
 * 出來」的**。理由見檔頭。
 */
export const NAV_HOST_SCENES: readonly string[] = [
  "Match",
  "Quest",
  "Raid",
  "Edit",
  "Shop",
  "Item",
  "Lot",
  "Library",
  "Option",
  "TutorialNewMenu",
];

/**
 * 每個畫面的返回鈕吃哪個事件（2026-09-24 從跑著的客戶端讀的）。
 *
 * 2026-09-23 改版後全部統一成 `this.btn_back = add.image(760,0,"btn_back")`，
 * 離開寫在 `pointerup`。只有 TutorialNewMenu 還是遊戲自己的 Button 類
 * （局部變數，`once("click")`）。沒列的當 `pointerup`。
 */
export const NAV_BACK_EVENT: Record<string, string> = {
  Match: "pointerup",
  Shop: "pointerup",
  Item: "pointerup",
  Option: "pointerup",
  Quest: "pointerup",
  Raid: "pointerup",
  Edit: "pointerup",
  Lot: "pointerup",
  Library: "pointerup",
  TutorialNewMenu: "click",
};

/** 官方返回鈕的貼圖 key，也是場景身上的欄位名（2026-09-23 前叫 `back_btn`）。 */
export const NAV_BACK_BUTTON = "btn_back";

/** 常駐場景。**一個都不能 stop。** 名單在 `scene-jump.ts`（跟渦戰投降共用）。 */
export const NAV_PERSISTENT_SCENES: readonly string[] = JUMP_PERSISTENT_SCENES;

/** 玩家點了捷徑。`ok: false` 時 `reason` 說為什麼沒走成。 */
export interface NavReport {
  type: "nav";
  from: string;
  to: NavTarget;
  ok: boolean;
  reason: string | null;
}

export function isNavReport(value: unknown): value is NavReport {
  const o = value as { type?: unknown; from?: unknown; to?: unknown; ok?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "nav" &&
    typeof o.from === "string" &&
    typeof o.to === "string" &&
    (NAV_TARGETS as readonly string[]).includes(o.to) &&
    typeof o.ok === "boolean"
  );
}

export interface NavStatus {
  installed: boolean;
  version: number | null;
  /** 貼圖載好了沒。沒載好之前畫不出來，但不是錯。 */
  ready: boolean;
  /** 這一排現在畫在哪個場景上。沒畫是 `null`。 */
  mounted: string | null;
  reason: string | null;
}

export interface NavPatchOptions {
  bindingName: string;
  pollIntervalMs?: number;
  armTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// 資產與文案
// ---------------------------------------------------------------------------

/**
 * 要載的貼圖：我們的 key → 大廳的 key。路徑、種類、切格**執行期**從
 * `UL_ASSETS.lobby.{image,spritesheet,atlas}` 查，接在
 * `UL_CONFIG.domains.assets.urls[0]` 後面。
 *
 * ⚠ 不要把路徑寫死：2026-09-23 改版一口氣把 `images/assets/lobby/*.png`
 * 換成 `images/assets/Lobby/*.avif`（連資料夾大小寫都改），`duel_btn_2` 也從
 * spritesheet 變成 atlas —— 寫死的那版整排按鈕 404、一顆都沒出來。
 */
const ASSETS = [
  { key: "__ulrNav_duel", lobby: "duel_btn" },
  { key: "__ulrNav_duel2", lobby: "duel_btn_2" },
  { key: "__ulrNav_quest", lobby: "quest_btn" },
  { key: "__ulrNav_raid", lobby: "raid_btn_base" },
  { key: "__ulrNav_raidIcon", lobby: "raid_btn_icon" },
  { key: "__ulrNav_deck", lobby: "deck_btn" },
];

/** 動畫。照抄大廳 `loader()` 裡的定義（frameRate／repeat 都一樣）。 */
const ANIMS = [
  {
    key: "__ulrNav_duel_1",
    texture: "__ulrNav_duel",
    start: 1,
    end: 39,
    frameRate: 20,
    repeat: -1,
  },
  // 官方：{ frames: "duel_btn_2" } —— atlas 的全部 frame（名字是 duel_btn_2-0.png…）。
  { key: "__ulrNav_duel_2", texture: "__ulrNav_duel2", all: true, frameRate: 15, repeat: -1 },
  {
    key: "__ulrNav_quest",
    texture: "__ulrNav_quest",
    start: 1,
    end: 40,
    frameRate: 20,
    repeat: -1,
  },
  { key: "__ulrNav_deck_1", texture: "__ulrNav_deck", start: 0, end: 15, frameRate: 20, repeat: 0 },
  {
    key: "__ulrNav_deck_2",
    texture: "__ulrNav_deck",
    start: 1,
    end: 15,
    frameRate: 20,
    repeat: -1,
  },
];

/**
 * hover 說明。**抄大廳 `clip[lang]` 的第一行**（2026-09-13 讀的），去掉句尾
 * 的「。」「.」。畫面上一個字都不畫，只有滑過去才出現 —— 大廳那四顆也是。
 */
const TOOLTIP: Record<string, Record<NavTarget, string>> = {
  ja: { duel: "デュエル", raid: "レイド", quest: "クエスト", deck: "デッキ編集" },
  en: { duel: "Duel", raid: "Raid", quest: "Quest", deck: "Deck Editor" },
  kr: { duel: "듀얼", raid: "레이드", quest: "퀘스트", deck: "덱 편집" },
  scn: { duel: "决斗", raid: "Raid", quest: "任务", deck: "卡组编辑" },
  tcn: { duel: "決鬥", raid: "Raid", quest: "任務", deck: "牌組編輯" },
};

/**
 * 版面。畫布 760×680。
 *
 * 位置**相對於官方返回鈕**算（它在 (736,16)，48×32，Shop／Item 是 origin(1,0)
 * 放在 (760,0)，視覺上同一個地方）：最右那顆貼著返回鈕左緣往左 `gap`，再
 * 一顆一顆往左排。直徑 28 是「塞得進 32 高的標題列、又看得出是哪顆」。
 */
const LAYOUT = {
  d: 28,
  gap: 6,
  /** 返回鈕不在（照理不會）時的後路。 */
  fallbackX: 712,
  fallbackY: 16,
  tipDy: 18,
  depth: 100,
  /** 現在所在／不能按時的透明度。 */
  dimAlpha: 0.4,
  ringColor: 0x111111,
  ringWidth: 2,
};

const SHARED = `
  var FLAG = ${JSON.stringify(FLAG)};

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys ? window.game : null;
  }

  /** 物件還活著（Phaser destroy 之後 scene 會變 undefined）。 */
  function alive(o) {
    return !!(o && o.scene);
  }
  ${SCENE_JUMP_SNIPPET}
`;

/**
 * 產生注入腳本。純函式，可完整測試，不需要活著的遊戲。
 *
 * 重跑一次是安全的：一進去先把上一次掛的東西全部拆掉，再從原狀重來。
 * 貼圖不重載 —— key 一樣、內容一樣，還在就直接用。
 */
export function buildNavPatchScript(options: NavPatchOptions): string {
  const config = {
    version: NAV_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_NAV_POLL_MS,
    armTimeoutMs: options.armTimeoutMs ?? DEFAULT_NAV_ARM_TIMEOUT_MS,
    backEvent: NAV_BACK_EVENT,
    backButton: NAV_BACK_BUTTON,
    targets: NAV_TARGETS,
    targetScene: NAV_TARGET_SCENE,
    hosts: NAV_HOST_SCENES,
    persistent: NAV_PERSISTENT_SCENES,
    assets: ASSETS,
    anims: ANIMS,
    tooltip: TOOLTIP,
    layout: LAYOUT,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var L = CFG.layout;
  ${SHARED}

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function tipFor(target) {
    var t = CFG.tooltip[gameLang()] || CFG.tooltip.en;
    return t[target] || CFG.tooltip.en[target];
  }

  /** 把上一次掛的東西拆乾淨。**重裝一律從原狀開始。** 貼圖留著。 */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    detach(st);
    delete window[FLAG];
  }

  function detach(st) {
    disarm(st);
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    var tw = st.tweens || [];
    for (var j = 0; j < tw.length; j++) {
      try { tw[j].stop(); } catch (e) {}
    }
    st.mine = [];
    st.tweens = [];
    st.buttons = {};
    st.anchor = null;
    st.scene = null;
    st.sceneKey = null;
  }

  // -------------------------------------------------------------------------
  // 貼圖與動畫（自己載，不經過 UL_LOADER）
  // -------------------------------------------------------------------------

  function assetBase() {
    try {
      var urls = window.UL_CONFIG.domains.assets.urls;
      if (urls && urls.length) return String(urls[0]).replace(/\\/+$/, "") + "/";
    } catch (e) {}
    return null;
  }

  /**
   * 大廳那一項在 UL_ASSETS 裡長怎樣：{ kind, url, frame, atlasURL }。
   * 找不到回 null —— 官方又改名的話，原因要講得出是哪一項。
   */
  function lobbyAsset(name) {
    var A = window.UL_ASSETS && window.UL_ASSETS.lobby;
    if (!A) return null;
    var kinds = ["image", "spritesheet", "atlas"];
    for (var k = 0; k < kinds.length; k++) {
      var list = A[kinds[k]] || [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || e.key !== name) continue;
        if (kinds[k] === "atlas") return { kind: "atlas", url: e.textureURL, atlasURL: e.atlasURL };
        return { kind: kinds[k], url: e.url, frame: e.frameConfig || null };
      }
    }
    return null;
  }

  function fetchImage(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var u = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { try { URL.revokeObjectURL(u); } catch (e) {} resolve(img); };
        img.onerror = function () { try { URL.revokeObjectURL(u); } catch (e) {} reject(new Error(url + " 解不開")); };
        img.src = u;
      });
    });
  }

  function loadOne(G, base, a) {
    if (G.textures.exists(a.key)) return Promise.resolve();
    var src = lobbyAsset(a.lobby);
    if (!src || !src.url) return Promise.reject(new Error("UL_ASSETS.lobby 裡沒有 " + a.lobby));
    var json = src.kind === "atlas"
      ? fetch(base + src.atlasURL).then(function (r) {
          if (!r.ok) throw new Error(src.atlasURL + " -> HTTP " + r.status);
          return r.json();
        })
      : Promise.resolve(null);
    return Promise.all([fetchImage(base + src.url), json]).then(function (got) {
      if (G.textures.exists(a.key)) return;
      var img = got[0];
      if (src.kind === "atlas") G.textures.addAtlas(a.key, img, got[1]);
      else if (src.kind === "spritesheet" && src.frame) G.textures.addSpriteSheet(a.key, img, src.frame);
      else G.textures.addImage(a.key, img);
    });
  }

  function ensureAnims(G) {
    for (var i = 0; i < CFG.anims.length; i++) {
      var a = CFG.anims[i];
      if (G.anims.exists(a.key)) continue;
      G.anims.create({
        key: a.key,
        // all：跟官方 frames: "貼圖 key" 一樣，整張貼圖的 frame 照名字排。
        frames: a.all ? a.texture : G.anims.generateFrameNumbers(a.texture, { start: a.start, end: a.end }),
        frameRate: a.frameRate,
        repeat: a.repeat
      });
    }
  }

  function loadAssets(st) {
    var G = gameOf();
    if (!G) return;
    var base = assetBase();
    if (!base) { st.reason = "讀不到 UL_CONFIG.domains.assets"; st.retryAt = Date.now() + 5000; return; }
    st.loading = true;
    var ps = [];
    for (var i = 0; i < CFG.assets.length; i++) ps.push(loadOne(G, base, CFG.assets[i]));
    Promise.all(ps).then(function () {
      ensureAnims(G);
      st.loading = false;
      st.ready = true;
      st.reason = null;
      tick();
    }, function (e) {
      st.loading = false;
      st.reason = "貼圖載不下來：" + String((e && e.message) || e);
      st.retryAt = Date.now() + 5000;
    });
  }

  // -------------------------------------------------------------------------
  // 哪個場景、能不能按
  // -------------------------------------------------------------------------

  /** 官方返回鈕。多半是 sc.btn_back；Tutorial 那顆是局部變數，只能從 children 找。 */
  function backButtonOf(sc) {
    if (alive(sc[CFG.backButton])) return sc[CFG.backButton];
    try {
      var list = sc.children && sc.children.list;
      if (!list) return null;
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o && o.texture && o.texture.key === CFG.backButton && alive(o)) return o;
      }
    } catch (e) {}
    return null;
  }

  function hostScene(G) {
    var K = G.scene.keys;
    for (var i = 0; i < CFG.hosts.length; i++) {
      var sc = K[CFG.hosts[i]];
      try {
        if (sc && sc.scene && sc.scene.isActive() && backButtonOf(sc) !== null) return sc;
      } catch (e) {}
    }
    return null;
  }

  /** 官方返回鈕現在能按嗎。它不能按，我們也不能 —— 見檔頭。 */
  function canLeave(sc) {
    var b = backButtonOf(sc);
    if (b === null || b.visible === false) return false;
    if (!b.input || b.input.enabled === false) return false;
    return true;
  }

  function currentTarget(sceneKey) {
    for (var i = 0; i < CFG.targets.length; i++) {
      if (CFG.targetScene[CFG.targets[i]] === sceneKey) return CFG.targets[i];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 跳：問路 → 改道 → 按官方返回鈕
  // -------------------------------------------------------------------------

  // 清場（ulrStopContentScenes）在 scene-jump.ts，跟渦戰投降共用。

  /** 把改道拆掉，ScenePlugin 還原。armed 是 st.armed。 */
  function disarm(st) {
    var a = st.armed;
    if (!a) return;
    st.armed = null;
    try { if (a.timer) clearTimeout(a.timer); } catch (e) {}
    try {
      if (a.plugin.start === a.redirect) {
        if (a.hadOwn) a.plugin.start = a.orig; else delete a.plugin.start;
      }
    } catch (e) {}
  }

  /**
   * 改道：官方返回鈕最後那句 this.scene.start("Lobby", …) 改成清場 → 開目標。
   * 其他的 start（例如 Edit 進合成）原樣放行、順便解除。
   */
  function arm(st, sc, key, target, targetScene, params) {
    var plugin = sc.scene;
    var hadOwn = Object.prototype.hasOwnProperty.call(plugin, "start");
    var orig = plugin.start;
    var a = { plugin: plugin, orig: orig, hadOwn: hadOwn, redirect: null, timer: null, sc: sc };
    a.redirect = function (k, data) {
      if (k !== "Lobby") {
        disarm(st);
        return orig.call(plugin, k, data);
      }
      disarm(st);
      var G = gameOf();
      var stopped = ulrStopContentScenes(G, CFG.persistent, targetScene);
      G.scene.start(targetScene, params);
      st.busy = false;
      st.reason = null;
      report({ type: "nav", from: key, to: target, ok: true, reason: null, stopped: stopped });
      return plugin;
    };
    plugin.start = a.redirect;
    // 看門狗：官方流程沒走到 start（Edit 的 Deck1 空錯誤框、伺服器不回…）
    // 就把改道拆掉、按鈕亮回來。
    a.timer = setTimeout(function () {
      if (st.armed !== a) return;
      disarm(st);
      st.busy = false;
      paint(st);
    }, CFG.armTimeoutMs);
    st.armed = a;
  }

  function go(st, target) {
    var G = gameOf();
    var sc = st.scene, key = st.sceneKey;
    if (!G || !sc || st.busy) return;
    if (!canLeave(sc)) return;
    var targetScene = CFG.targetScene[target];
    if (!targetScene || targetScene === key) return;

    // ⚠ 2026-09-23 改版後大廳四顆鈕都是 move_scene(目標) —— 不帶任何參數：
    // 各場景的 init() 自己從 registry 拿 player_id、從 UL_CONFIG.domains 挑伺服器。
    // 以前要湊的 {id, host, port}（跟大廳問 quest_port／raid_port）全都不用了。
    //
    // Edit 離開前會送 deck_update，伺服器不收就留在原地（input 重開）、不走
    // scene.start —— 那條路由看門狗收尾。
    var b = backButtonOf(sc);
    if (b === null) return fail(st, target, "來源畫面已經不能離開了");
    st.busy = true;
    paint(st);
    try {
      arm(st, sc, key, target, targetScene, undefined);
      // 按官方返回鈕：音效、淡出、存檔全是它做的。哪個事件見 CFG.backEvent。
      var ev = CFG.backEvent[key] || "pointerup";
      try { if (ev === "click" && "clicked" in b) b.clicked = false; } catch (e) {}
      b.emit(ev);
    } catch (e) {
      disarm(st);
      fail(st, target, String((e && e.message) || e));
    }
  }

  function fail(st, target, why) {
    st.busy = false;
    st.reason = why;
    paint(st);
    report({ type: "nav", from: st.sceneKey || "?", to: target, ok: false, reason: why });
  }

  // -------------------------------------------------------------------------
  // 畫面
  // -------------------------------------------------------------------------

  function circleHit(size) {
    var P = window.Phaser;
    if (P && P.Geom && P.Geom.Circle) {
      return [new P.Geom.Circle(size / 2, size / 2, size / 2), P.Geom.Circle.Contains];
    }
    return [];
  }

  function makeTip(sc, x, y, text) {
    var tip = sc.add.container(0, 0).setDepth(L.depth + 20).setVisible(false);
    var t = sc.add.text(0, 0, text, {
      fontFamily: "font_light", fontSize: 11, resolution: 2, color: "#ffffff",
      padding: { left: 5, right: 5, top: 3, bottom: 4 }
    }).setOrigin(0.5, 0);
    var bg = sc.add.rectangle(0, 0, t.width, t.height, 0, 0.85).setOrigin(0.5, 0);
    tip.add(bg);
    tip.add(t);
    // 靠右邊界就往左推，不要出畫面。
    var W = sc.game.scale.width;
    var half = t.width / 2;
    tip.setPosition(Math.min(x, W - half - 2), y);
    return tip;
  }

  function mount(st, sc) {
    var G = gameOf();
    var mine = st.mine;
    var key = (sc.sys && sc.sys.settings && sc.sys.settings.key) || sc.scene.key;
    var here = currentTarget(key);

    // 位置：相對於官方返回鈕。
    var b = backButtonOf(sc);
    var left = L.fallbackX, cy = L.fallbackY;
    try {
      left = b.x - b.displayWidth * b.originX;
      cy = b.y + b.displayHeight * (0.5 - b.originY);
    } catch (e) {}
    var r = L.d / 2;
    var pitch = L.d + L.gap;
    var n = CFG.targets.length;
    var rightCenter = left - L.gap - r;

    st.buttons = {};
    for (var i = 0; i < n; i++) {
      var target = CFG.targets[i];
      var cx = rightCenter - (n - 1 - i) * pitch;
      var btn = { target: target, objs: [], hit: null, over: null, out: null };
      var s = L.d / 160;

      if (target === "duel") {
        var duel = sc.add.sprite(cx, cy, "__ulrNav_duel", 0).setScale(s).setDepth(L.depth);
        var duel2 = sc.add.sprite(cx, cy, "__ulrNav_duel2", null).setScale(s).setDepth(L.depth + 1).setVisible(false);
        btn.objs.push(duel, duel2);
        btn.hit = duel;
        btn.over = function () {
          try { duel.play("__ulrNav_duel_1"); duel2.play("__ulrNav_duel_2").setVisible(true); } catch (e) {}
        };
        btn.out = function () {
          try { duel.stop().setTexture("__ulrNav_duel", 0); duel2.stop().setVisible(false); } catch (e) {}
        };
      } else if (target === "raid") {
        var base = sc.add.image(cx, cy, "__ulrNav_raid").setScale(s).setDepth(L.depth);
        var icon = sc.add.sprite(cx + 0.5 * s, cy - 26.5 * s, "__ulrNav_raidIcon", 0).setScale(s).setDepth(L.depth + 1);
        btn.objs.push(base, icon);
        btn.hit = base;
        var spin = null;
        btn.over = function () {
          try {
            icon.setTexture("__ulrNav_raidIcon", 1);
            spin = sc.tweens.add({ targets: icon, angle: "+=360", duration: 2000, repeat: -1 });
            st.tweens.push(spin);
          } catch (e) {}
        };
        btn.out = function () {
          try { if (spin) { spin.stop(); spin = null; } icon.setTexture("__ulrNav_raidIcon", 0).setAngle(0); } catch (e) {}
        };
      } else if (target === "quest") {
        var quest = sc.add.sprite(cx, cy, "__ulrNav_quest", 0).setScale(s).setDepth(L.depth);
        btn.objs.push(quest);
        btn.hit = quest;
        btn.over = function () { try { quest.play("__ulrNav_quest"); } catch (e) {} };
        btn.out = function () { try { quest.stop().setTexture("__ulrNav_quest", 0); } catch (e) {} };
      } else {
        // DECK：大廳是方的，套圓形遮罩＋黑邊跟另外三顆一致。
        var sd = L.d / 112;
        var deck = sc.add.sprite(cx, cy, "__ulrNav_deck", 0).setScale(sd).setDepth(L.depth);
        var maskG = sc.make.graphics({ x: 0, y: 0, add: false });
        maskG.fillStyle(0xffffff, 1);
        maskG.fillCircle(cx, cy, r - L.ringWidth / 2);
        deck.setMask(maskG.createGeometryMask());
        var ring = sc.add.graphics().setDepth(L.depth + 1);
        ring.lineStyle(L.ringWidth, L.ringColor, 1);
        ring.strokeCircle(cx, cy, r - L.ringWidth / 2);
        btn.objs.push(deck, maskG, ring);
        btn.hit = deck;
        btn.over = function () {
          try { deck.play("__ulrNav_deck_1"); deck.anims.playAfterRepeat("__ulrNav_deck_2"); } catch (e) {}
        };
        btn.out = function () { try { deck.stop().setTexture("__ulrNav_deck", 0); } catch (e) {} };
      }

      var tip = makeTip(sc, cx, cy + L.tipDy, tipFor(target));
      btn.objs.push(tip);
      btn.tip = tip;

      var hitArgs = circleHit(target === "deck" ? 112 : 160);
      var hit = btn.hit;
      hit.setInteractive.apply(hit, hitArgs);
      try { hit.input.cursor = "pointer"; } catch (e) {}
      (function (btn) {
        hit.on("pointerover", function () {
          if (!btn.enabled) return;
          try { btn.tip.setVisible(true); } catch (e) {}
          btn.over();
        });
        hit.on("pointerout", function () {
          try { btn.tip.setVisible(false); } catch (e) {}
          btn.out();
        });
        hit.on("pointerdown", function () {
          if (!btn.enabled) return;
          try { btn.tip.setVisible(false); } catch (e) {}
          btn.out();
          go(st, btn.target);
        });
      })(btn);

      btn.here = here === target;
      btn.enabled = false;
      for (var k = 0; k < btn.objs.length; k++) mine.push(btn.objs[k]);
      st.buttons[target] = btn;
    }

    st.scene = sc;
    st.sceneKey = key;
    st.anchor = st.buttons[CFG.targets[0]].hit;
    paint(st);
  }

  /** 依「現在能不能離開」把每顆調亮／調暗。 */
  function paint(st) {
    var sc = st.scene;
    if (!sc) return;
    var can = !st.busy && canLeave(sc);
    for (var i = 0; i < CFG.targets.length; i++) {
      var btn = st.buttons[CFG.targets[i]];
      if (!btn) continue;
      var on = can && !btn.here;
      btn.enabled = on;
      var a = on ? 1 : L.dimAlpha;
      for (var k = 0; k < btn.objs.length; k++) {
        var o = btn.objs[k];
        if (o === btn.tip || !o.setAlpha || o.type === "Graphics") continue;
        try { o.setAlpha(a); } catch (e) {}
      }
      try {
        if (btn.hit.input) btn.hit.input.enabled = on;
        if (!on) { btn.out(); btn.tip.setVisible(false); }
      } catch (e) {}
    }
  }

  // -------------------------------------------------------------------------
  // 主迴圈
  // -------------------------------------------------------------------------

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      if (!st.ready) {
        if (!st.loading && Date.now() >= st.retryAt) loadAssets(st);
        return;
      }
      var G = gameOf();
      var sc = G ? hostScene(G) : null;
      if (sc === null) {
        if (st.scene !== null) detach(st);
        return;
      }
      // 場景重建過的話，我們的東西已經跟著舊場景被 destroy（anchor.scene 變 null）。
      if (st.scene !== sc || !alive(st.anchor)) {
        detach(st);
        st.busy = false;
        mount(st, sc);
        return;
      }
      paint(st);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    ready: false,
    loading: false,
    retryAt: 0,
    busy: false,
    armed: null,
    mine: [],
    tweens: [],
    buttons: {},
    anchor: null,
    scene: null,
    sceneKey: null,
    timer: null,
    reason: null
  };
  window[FLAG] = st;

  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    ready: st.ready,
    mounted: st.sceneKey,
    reason: st.reason
  });
})()`;
}

export const NAV_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) {
      return JSON.stringify({ installed: false, version: null, ready: false, mounted: null, reason: null });
    }
    return JSON.stringify({
      installed: true,
      version: st.version,
      ready: !!st.ready,
      mounted: st.scene && st.scene.scene ? st.sceneKey : null,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, ready: false, mounted: null,
      reason: String((e && e.message) || e)
    });
  }
})()`;

/**
 * 拆掉。貼圖與動畫一起卸：留著沒壞處，但插件關掉就該什麼都不留。
 */
export const NAV_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var items = st.mine || [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i] && items[i].destroy) items[i].destroy(); } catch (e) {}
    }
    var tw = st.tweens || [];
    for (var j = 0; j < tw.length; j++) { try { tw[j].stop(); } catch (e) {} }
    try {
      var a = st.armed;
      if (a) {
        if (a.timer) clearTimeout(a.timer);
        if (a.plugin.start === a.redirect) { if (a.hadOwn) a.plugin.start = a.orig; else delete a.plugin.start; }
      }
    } catch (e) {}
    delete window["${FLAG}"];
    try {
      var G = window.game;
      var anims = ${embedJson(ANIMS.map((a) => a.key))};
      var keys = ${embedJson(ASSETS.map((a) => a.key))};
      var A = JSON.parse(anims), T = JSON.parse(keys);
      for (var a = 0; a < A.length; a++) { try { if (G.anims.exists(A[a])) G.anims.remove(A[a]); } catch (e) {} }
      for (var t = 0; t < T.length; t++) { try { if (G.textures.exists(T[t])) G.textures.remove(T[t]); } catch (e) {} }
    } catch (e) {}
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseNavStatus(raw: string): NavStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      ready: false,
      mounted: null,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    ready: o.ready === true,
    mounted: typeof o.mounted === "string" ? o.mounted : null,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
