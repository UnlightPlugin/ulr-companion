/**
 * 卡面替換（MOD）：把玩家自己的 PNG 換進 CharaCardImages 圖集
 * ============================================================
 * 角色卡的卡面全部住在一張圖集裡（`CharaCardImages`，multiatlas 5 張 source、
 * 816 格 168×240，格子鍵是 `cc034_r01` 那種，怪物 `mc001_01` 也在同一張）。
 * 要換卡面不必碰任何場景 —— **把那一格指到別的圖**就好，之後誰畫這張卡都會
 * 拿到新圖。
 *
 * ⚠ 2026-09-23 改版前圖集叫 `cc_front`（單張 6720×3840、631 格）。改版後那張
 * 不存在了，舊腳本就一直停在「等圖集」（`atlasReady:false`），卡面完全沒換 ——
 * 2026-09-26 玩家回報。格子鍵與尺寸沒變。
 *
 * ⚠ 畫面上的卡**不是** Image：官方一律用
 * `rexUI.add.circleMaskImage(x, y, "CharaCardImages", filename,
 * {maskType:"roundRectangle", radius:4})`（牌組編輯、升級、圖鑑、渦房，四處都是
 * 這組參數）。它把那一格**複製進自己的 canvas** 再切圓角，所以貼圖鍵是一串
 * UUID；記著來源的只有 `_textureKey`／`_frameName`，遮罩參數沒存 —— 重畫時照抄
 * 官方那組。
 *
 * ## 做法：加一個 TextureSource，把 Frame 換掉
 *
 * ```js
 *   var src = new Phaser.Textures.TextureSource(tex, img, 168, 240)  // 上傳到 GPU
 *   tex.source.push(src)
 *   delete tex.frames[name]; tex.frameTotal--
 *   tex.add(name, tex.source.length - 1, 0, 0, 168, 240)           // 新的 Frame
 * ```
 *
 * 2026-09-15 在桌面版（Phaser 3.87、WebGL）實測：牌組編輯、圖鑑、升級畫面
 * 全部換過來。**不改圖集本身** —— 原本的 source 原封不動，只多幾張 168×240 的小圖，
 * 拆掉時把原本的 Frame 物件放回去、多加的 source 銷毀，圖集就回到原樣。
 *
 * 已經畫在畫面上的卡抓著舊的內容，換完要走一遍所有場景的顯示清單：Image 對
 * texture／frame 名字對得上的 `setFrame(name)`；circleMaskImage 對
 * `_textureKey`／`_frameName` 對得上的 `setTexture(...)` 重畫一次 canvas。
 *
 * ## 尺寸
 *
 * 一格就是 168×240，遊戲沒有更高解析度的卡面。給大圖也只會縮成 168×240
 * （長寬比對得上就縮，對不上就拒絕 —— 硬拉會變形，玩家會以為是插件畫壞）。
 *
 * ## 時序
 *
 * 圖集不一定開機就在，所以腳本自己輪詢等圖集出現；
 * 圖片解碼是非同步的（`Image.onload`），裝上的當下只能回「等待中」，結果由
 * status 表達式與一則 report 回報。
 *
 * 跟其他 evaluate 裝的東西一樣，遊戲一重載就沒了，托盤每次接上／重載後都重裝。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段住在 template literal 裡。
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrCardArt";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const CARD_ART_SCRIPT_VERSION = 2;

export const DEFAULT_CARD_ART_POLL_MS = 500;

/** 卡面圖集（2026-09-23 改版後；之前叫 `cc_front`）。 */
export const CARD_ART_ATLAS = "CharaCardImages";

/** 官方建卡面時給 circleMaskImage 的遮罩參數（四處呼叫點都一樣）。重畫要照抄。 */
const CARD_MASK = { maskType: "roundRectangle", radius: 4 };

/** 一張要換的卡面。`frame` 是圖集裡的格子鍵（`cc034_r01`），`dataUrl` 是 PNG。 */
export interface CardArtEntry {
  frame: string;
  dataUrl: string;
}

export interface CardArtFailure {
  frame: string;
  reason: string;
}

export interface CardArtStatus {
  installed: boolean;
  version: number | null;
  /** 圖集已經在頁面上（沒在的話 `applied` 一定是 0，那不是錯）。 */
  atlasReady: boolean;
  /** 要換幾張。 */
  total: number;
  /** 換好幾張。 */
  applied: number;
  /** 圖還在解碼的有幾張。 */
  pending: number;
  failed: CardArtFailure[];
  reason: string | null;
}

/** 一批全部處理完（每張都成功或失敗了）時回報一次。 */
export interface CardArtReport {
  type: "card-art";
  applied: number;
  failed: CardArtFailure[];
}

export function isCardArtReport(value: unknown): value is CardArtReport {
  const o = value as { type?: unknown; applied?: unknown; failed?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "card-art" &&
    typeof o.applied === "number" &&
    Array.isArray(o.failed)
  );
}

export interface CardArtPatchOptions {
  bindingName: string;
  entries: readonly CardArtEntry[];
  pollIntervalMs?: number;
}

/**
 * 產生注入腳本。純函式，可完整測試。
 *
 * 重跑一次是安全的：一進去先把上一次換的全部還原（原本的 Frame 放回去、
 * 多加的 source 銷毀），再從原狀重來 —— 玩家改了圖、刪了圖都靠這條路生效。
 */
export function buildCardArtPatchScript(options: CardArtPatchOptions): string {
  const config = {
    version: CARD_ART_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CARD_ART_POLL_MS,
    atlas: CARD_ART_ATLAS,
    mask: CARD_MASK,
    entries: options.entries.map((e) => ({ frame: e.frame, dataUrl: e.dataUrl })),
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function gameOf() {
    var g = window.game;
    return g && g.textures && g.scene && g.scene.scenes ? g : null;
  }

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  /**
   * 走遍所有場景的顯示清單（含 Container），把抓著這一格的物件重畫：
   * Image 換成新 Frame；circleMaskImage（官方卡面）照官方參數重畫自己的 canvas。
   */
  function refresh(G, name) {
    var n = 0;
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        try {
          if (o && o.type === "rexCircleMaskImage") {
            if (o._textureKey === CFG.atlas && o._frameName === name && typeof o.setTexture === "function") { o.setTexture(CFG.atlas, name, CFG.mask); n++; }
          } else if (o && o.texture && o.texture.key === CFG.atlas && o.frame && o.frame.name === name && typeof o.setFrame === "function") { o.setFrame(name); n++; }
          if (o && o.list && o.list.length) walk(o.list);
        } catch (e) {}
      }
    }
    var scenes = G.scene.scenes;
    for (var s = 0; s < scenes.length; s++) {
      var sc = scenes[s];
      if (sc && sc.children && sc.children.list) walk(sc.children.list);
    }
    return n;
  }

  /** 全部還原。**重裝一律從原狀開始。** */
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var G = gameOf();
    var tex = G && G.textures.exists(CFG.atlas) ? G.textures.get(CFG.atlas) : null;
    if (tex) {
      var names = Object.keys(st.orig);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        try {
          var cur = tex.frames[name];
          if (cur && cur !== st.orig[name]) { tex.frames[name] = st.orig[name]; refresh(G, name); }
        } catch (e) {}
      }
      /* 多加的 source 都在尾端，倒著拆 */
      for (var j = st.sources.length - 1; j >= 0; j--) {
        try {
          var src = st.sources[j];
          var at = tex.source.indexOf(src);
          if (at > 0) tex.source.splice(at, 1);
          if (src && typeof src.destroy === "function") src.destroy();
        } catch (e) {}
      }
    }
    delete window[FLAG];
  }

  /** 把一張解碼好的圖換進去。回 null 表示成功，否則是原因。 */
  function swap(st, G, tex, entry, img) {
    var old = tex.get(entry.frame);
    if (!old || old.name !== entry.frame) return "圖集裡沒有這一格";
    var w = old.width, h = old.height;
    var source = img;
    if (img.width !== w || img.height !== h) {
      if (Math.abs(img.width * h - img.height * w) > 0.015 * img.width * h) {
        return "尺寸 " + img.width + "x" + img.height + " 的比例不對，要 " + w + "x" + h + "（或等比例放大）";
      }
      var cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      var ctx = cv.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      source = cv;
    }
    var src = new Phaser.Textures.TextureSource(tex, source, w, h);
    tex.source.push(src);
    st.sources.push(src);
    if (!(entry.frame in st.orig)) st.orig[entry.frame] = old;
    delete tex.frames[entry.frame];
    tex.frameTotal--;
    var nf = tex.add(entry.frame, tex.source.length - 1, 0, 0, w, h);
    if (!nf) { tex.frames[entry.frame] = old; tex.frameTotal++; return "圖集不收新的 Frame"; }
    st.frames[entry.frame] = nf;
    refresh(G, entry.frame);
    return null;
  }

  function settle(st) {
    if (st.pending !== 0 || st.reported) return;
    st.reported = true;
    report({ type: "card-art", applied: st.applied, failed: st.failed.slice() });
  }

  function apply(st, G, tex) {
    st.atlasReady = true;
    for (var i = 0; i < CFG.entries.length; i++) {
      (function (entry) {
        if (!tex.has(entry.frame)) {
          st.failed.push({ frame: entry.frame, reason: "圖集裡沒有這一格" });
          return;
        }
        st.pending++;
        var img = new Image();
        img.onload = function () {
          st.pending--;
          try {
            var G2 = gameOf();
            var tex2 = G2 && G2.textures.exists(CFG.atlas) ? G2.textures.get(CFG.atlas) : null;
            if (!tex2 || window[FLAG] !== st) return settle(st);
            var why = swap(st, G2, tex2, entry, img);
            if (why === null) st.applied++; else st.failed.push({ frame: entry.frame, reason: why });
          } catch (e) {
            st.failed.push({ frame: entry.frame, reason: String((e && e.message) || e) });
          }
          settle(st);
        };
        img.onerror = function () {
          st.pending--;
          st.failed.push({ frame: entry.frame, reason: "PNG 解碼失敗" });
          settle(st);
        };
        img.src = entry.dataUrl;
      })(CFG.entries[i]);
    }
    settle(st);
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      if (!G || !G.textures.exists(CFG.atlas)) return;
      var tex = G.textures.get(CFG.atlas);
      if (!st.atlasReady) { apply(st, G, tex); return; }
      /* 圖集被換掉（理論上不會，但重載以外的路徑重建 texture 時會）→ 重來 */
      var names = Object.keys(st.frames);
      for (var i = 0; i < names.length; i++) {
        if (tex.frames[names[i]] !== st.frames[names[i]]) {
          st.atlasReady = false; st.applied = 0; st.pending = 0; st.failed = []; st.reported = false;
          st.orig = {}; st.sources = []; st.frames = {};
          apply(st, G, tex);
          return;
        }
      }
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  restore();

  var st = {
    version: CFG.version,
    total: CFG.entries.length,
    atlasReady: false,
    applied: 0,
    pending: 0,
    failed: [],
    reported: false,
    orig: {},
    sources: [],
    frames: {},
    timer: null,
    reason: null
  };
  window[FLAG] = st;
  if (CFG.entries.length > 0) {
    st.timer = setInterval(tick, CFG.pollIntervalMs);
    tick();
  }

  return JSON.stringify({
    installed: true,
    version: st.version,
    atlasReady: st.atlasReady,
    total: st.total,
    applied: st.applied,
    pending: st.pending,
    failed: st.failed,
    reason: st.reason
  });
})()`;
}

export const CARD_ART_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, atlasReady: false, total: 0, applied: 0, pending: 0, failed: [], reason: null });
    return JSON.stringify({
      installed: true,
      version: st.version,
      atlasReady: st.atlasReady,
      total: st.total,
      applied: st.applied,
      pending: st.pending,
      failed: st.failed,
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({
      installed: false, version: null, atlasReady: false, total: 0, applied: 0, pending: 0, failed: [],
      reason: String((e && e.message) || e)
    });
  }
})()`;

/** 拆掉：原本的 Frame 放回去、多加的 source 銷毀、畫面上的卡換回官方。 */
export const CARD_ART_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var G = window.game;
    var tex = G && G.textures && G.textures.exists("${CARD_ART_ATLAS}") ? G.textures.get("${CARD_ART_ATLAS}") : null;
    if (tex) {
      var names = Object.keys(st.orig);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        try {
          if (tex.frames[name] !== st.orig[name]) {
            tex.frames[name] = st.orig[name];
            var scenes = G.scene.scenes;
            for (var s = 0; s < scenes.length; s++) {
              var list = scenes[s] && scenes[s].children && scenes[s].children.list;
              if (!list) continue;
              (function walk(l) {
                for (var k = 0; k < l.length; k++) {
                  var o = l[k];
                  try {
                    if (o && o.type === "rexCircleMaskImage") {
                      if (o._textureKey === "${CARD_ART_ATLAS}" && o._frameName === name && typeof o.setTexture === "function") o.setTexture("${CARD_ART_ATLAS}", name, ${JSON.stringify(CARD_MASK)});
                    } else if (o && o.texture && o.texture.key === "${CARD_ART_ATLAS}" && o.frame && o.frame.name === name && typeof o.setFrame === "function") o.setFrame(name);
                    if (o && o.list && o.list.length) walk(o.list);
                  } catch (e) {}
                }
              })(list);
            }
          }
        } catch (e) {}
      }
      for (var j = st.sources.length - 1; j >= 0; j--) {
        try {
          var src = st.sources[j];
          var at = tex.source.indexOf(src);
          if (at > 0) tex.source.splice(at, 1);
          if (src && typeof src.destroy === "function") src.destroy();
        } catch (e) {}
      }
    }
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseCardArtStatus(raw: string): CardArtStatus {
  const empty: CardArtStatus = {
    installed: false,
    version: null,
    atlasReady: false,
    total: 0,
    applied: 0,
    pending: 0,
    failed: [],
    reason: null,
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...empty, reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}` };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const failed: CardArtFailure[] = [];
  if (Array.isArray(o.failed)) {
    for (const f of o.failed as Record<string, unknown>[]) {
      if (typeof f?.frame === "string")
        failed.push({
          frame: f.frame,
          reason: typeof f.reason === "string" ? f.reason : "原因不明",
        });
    }
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    atlasReady: o.atlasReady === true,
    total: num(o.total),
    applied: num(o.applied),
    pending: num(o.pending),
    failed,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
