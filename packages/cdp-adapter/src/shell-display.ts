/**
 * 桌面版外殼的畫面大小與全螢幕（2026-09-23 改版後）
 * ====================================================
 *
 * 改版後遊戲 iframe 是跨來源的 out-of-process iframe，iframe 裡的腳本摸不到
 * 外殼（讀 `parent.document` 直接丟例外）。`patch-display` 在那裡只剩解析度
 * 做得到，所以畫面大小／全螢幕改成 **Node 另開一條 session 對外殼下命令**。
 *
 * 2026-09-25 對著跑著的客戶端量過（Electron 44、3440×1440、縮放 100%）：
 *
 * | 手段                              | 結果                                          |
 * | --------------------------------- | --------------------------------------------- |
 * | 外殼 html 的 CSS zoom 1.5         | ✓ 傳進 OOPIF：iframe 內 dpr 1 → 1.5           |
 * | 外殼 `window.resizeTo`            | ✓ 還是吃（官方視窗 resizable:false 也一樣）   |
 * | iframe 裡的高解析度（auto）       | ✓ 自己跟上 dpr，緩衝變 1140×1020              |
 *
 * 所以做法跟改版前的桌面版一樣（見 `patch-display.ts` 檔頭②），只是搬到外殼
 * 的 context 裡跑：
 *
 * ```
 *   ×N        html zoom N ＋ 視窗內容區調成 760N×680N（官方 ×1 正好 776×719 外框）
 *   全螢幕    requestFullscreen（CDP 帶 userGesture，不必等玩家點）
 *             → 回報 display-fullscreen → Node 用 Win32 推滿（window-fill.ts）
 *             → resize → zoom 到塞得下、iframe 位移置中
 *   Esc 離開  退回上一個大小，回報 display-settings 讓配置與 Option 分頁跟上
 * ```
 *
 * ⚠ 置中不能用 body padding：iframe 是 `position:absolute; left:-170px`，
 * 包含區塊是初始包含區塊，padding 推不動它。改動 iframe 的 left／top，原值
 * 記在 iframe 的 data 屬性上（官方原本是 -170px／0px），還原時照抄回去。
 *
 * ⚠ 注入腳本裡的註解不能有反引號。
 */

import { embedJson } from "./embed.js";
import type { DisplayState } from "./patch-display.js";

const FLAG = "__ulrShellDisplay";

/** 外殼腳本版本。**改動注入腳本裡任何一行就 +1**。 */
export const SHELL_DISPLAY_VERSION = 1;

/** 遊戲畫面的邏輯尺寸（外殼讀不到 canvas，照官方寫死的）。 */
const BASE = { w: 760, h: 680 };

/**
 * 視窗框（標題列＋邊框）量不到時用的值：官方 776×719 外框 − 760×680 內容
 * （2026-09-25 縮放 100% 實測）。
 */
const FALLBACK_FRAME = { w: 16, h: 39 };

export interface ShellDisplayStatus {
  installed: boolean;
  version: number | null;
  size: string | null;
  zoom: number | null;
  fullscreen: boolean;
  /** 視窗內容區（CSS px）。 */
  inner: [number, number] | null;
  reason: string | null;
}

export function buildShellDisplayScript(options: {
  bindingName: string;
  state: DisplayState;
}): string {
  const config = {
    version: SHELL_DISPLAY_VERSION,
    bindingName: options.bindingName,
    state: options.state,
    base: BASE,
    fallbackFrame: FALLBACK_FRAME,
  };
  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};
  var st = window[FLAG];
  if (!st || st.version !== CFG.version) {
    // 換版：舊的只拆監聽，視窗留給新的接手
    if (st && typeof st.uninstall === "function") { try { st.uninstall(true); } catch (e) {} }
    st = install();
  }
  try { st.apply(CFG.state); } catch (e) { st.reason = String((e && e.message) || e); }
  return JSON.stringify(st.status());

  function install() {
    var doc = window.document;
    var s = {
      version: CFG.version,
      state: { render: "off", size: "x1" },
      lastSize: "x1",
      zoom: 1,
      frame: null,
      leaving: false,
      pending: null,
      reason: null
    };

    function report(payload) {
      try {
        var fn = window[CFG.bindingName];
        if (typeof fn === "function") fn(JSON.stringify(payload));
      } catch (e) {}
    }

    /**
     * 視窗框多寬。只量一次：resize 期間 outer 與 inner 各自非同步更新，只有
     * 視窗沒在動時量到的那一對可信 —— 裝上的當下就是那一刻。
     */
    function frame() {
      if (s.frame) return s.frame;
      var w = window.outerWidth - window.innerWidth, h = window.outerHeight - window.innerHeight;
      if (!(w >= 0 && w < 200 && h > 0 && h < 200) || doc.fullscreenElement) {
        w = CFG.fallbackFrame.w; h = CFG.fallbackFrame.h;
      }
      s.frame = { w: w, h: h };
      return s.frame;
    }

    function zoomOf(mode) {
      var n = parseFloat(String(mode).slice(1));
      return n > 0 ? n : 1;
    }

    function setZoom(z) {
      var el = doc.documentElement;
      var v = Math.abs(z - 1) < 0.001 ? "" : String(Math.round(z * 1000) / 1000);
      if (el.style.zoom !== v) el.style.zoom = v;
      s.zoom = z;
    }

    function gameFrame() {
      return doc.getElementById("frame_game");
    }

    /** 全螢幕置中：iframe 在官方位置上再位移（zoom 之後的座標系）。 */
    function place(dx, dy) {
      var f = gameFrame();
      if (!f) return;
      if (!f.hasAttribute("data-ulr-left")) {
        f.setAttribute("data-ulr-left", f.style.left || "");
        f.setAttribute("data-ulr-top", f.style.top || "");
      }
      var left = parseFloat(f.getAttribute("data-ulr-left")) || 0;
      var top = parseFloat(f.getAttribute("data-ulr-top")) || 0;
      f.style.left = (left + dx) + "px";
      f.style.top = (top + dy) + "px";
    }

    function unplace() {
      var f = gameFrame();
      if (!f || !f.hasAttribute("data-ulr-left")) return;
      f.style.left = f.getAttribute("data-ulr-left");
      f.style.top = f.getAttribute("data-ulr-top");
      f.removeAttribute("data-ulr-left");
      f.removeAttribute("data-ulr-top");
    }

    /** 視窗內容區調成 760z×680z（resizeTo 吃外框），並別讓視窗跑出工作區。 */
    function windowed(mode) {
      var z = zoomOf(mode);
      unplace();
      setZoom(z);
      var f = frame();
      var w = Math.round(CFG.base.w * z) + f.w, h = Math.round(CFG.base.h * z) + f.h;
      if (window.outerWidth !== w || window.outerHeight !== h) window.resizeTo(w, h);
      // ⚠ 用實際拿到的尺寸算：要的比工作區大時 Chromium 會夾小
      var sc = window.screen;
      var ax = sc.availLeft || 0, ay = sc.availTop || 0;
      var ow = window.outerWidth > 0 ? Math.min(w, window.outerWidth) : w;
      var oh = window.outerHeight > 0 ? Math.min(h, window.outerHeight) : h;
      var x = Math.max(ax, Math.min(window.screenX, ax + sc.availWidth - ow));
      var y = Math.max(ay, Math.min(window.screenY, ay + sc.availHeight - oh));
      if (x !== window.screenX || y !== window.screenY) window.moveTo(x, y);
    }

    /** 全螢幕：視窗多大就放多大、置中。 */
    function fit() {
      var W = window.innerWidth, H = window.innerHeight;
      var z = Math.min(W / CFG.base.w, H / CFG.base.h);
      if (!(z > 0)) return;
      setZoom(z);
      place(Math.max(0, Math.floor((W / z - CFG.base.w) / 2)), Math.max(0, Math.floor((H / z - CFG.base.h) / 2)));
    }

    s.onFullscreen = function () {
      try {
        if (doc.fullscreenElement) {
          fit();
          report({ type: "display-fullscreen", active: true, host: "desktop" });
          return;
        }
        var byUs = s.leaving;
        s.leaving = false;
        unplace();
        var next = s.pending;
        s.pending = null;
        if (next) { windowed(next); return; }
        // 玩家按 Esc 離開：退回上一個大小，回報讓配置與 Option 分頁跟上
        if (!byUs && s.state.size === "fullscreen") {
          var back = s.lastSize;
          s.state = { render: s.state.render, size: back };
          windowed(back);
          report({ type: "display-settings", render: s.state.render, size: back });
        }
      } catch (e) { s.reason = String((e && e.message) || e); }
    };
    s.onResize = function () {
      try { if (doc.fullscreenElement) fit(); } catch (e) {}
    };
    doc.addEventListener("fullscreenchange", s.onFullscreen);
    window.addEventListener("resize", s.onResize);
    // 裝上的當下視窗沒在動，框在這一刻量
    frame();

    s.apply = function (state) {
      s.state = { render: state.render, size: state.size };
      s.reason = null;
      if (state.size === "fullscreen") {
        if (doc.fullscreenElement) { fit(); return; }
        // ⚠ 桌面版不先 resizeTo：會被夾在工作區，Electron 還會把夾過的尺寸記成
        // 還原目標。進去之後由 Node 用 SetWindowPos 推滿。
        var p = doc.documentElement.requestFullscreen();
        if (p && typeof p.then === "function") {
          p.then(null, function (e) { s.reason = String((e && e.message) || e); });
        }
        return;
      }
      s.lastSize = state.size;
      if (doc.fullscreenElement) {
        // 等退出完成（Electron 在還原視窗）再調大小，否則會被還原蓋掉
        s.pending = state.size;
        s.leaving = true;
        doc.exitFullscreen();
        return;
      }
      windowed(state.size);
    };

    s.status = function () {
      return {
        installed: true,
        version: s.version,
        size: s.state.size,
        zoom: s.zoom,
        fullscreen: !!doc.fullscreenElement,
        inner: [window.innerWidth, window.innerHeight],
        reason: s.reason
      };
    };

    /** keep = 換版重裝，視窗留著；否則還原成官方的 ×1。 */
    s.uninstall = function (keep) {
      try { doc.removeEventListener("fullscreenchange", s.onFullscreen); } catch (e) {}
      try { window.removeEventListener("resize", s.onResize); } catch (e) {}
      if (window[FLAG] === s) { try { delete window[FLAG]; } catch (e) { window[FLAG] = undefined; } }
      if (keep) return;
      if (doc.fullscreenElement) {
        unplace();
        setZoom(1);
        doc.exitFullscreen();
        setTimeout(function () { try { windowed("x1"); } catch (e) {} }, 500);
        return;
      }
      windowed("x1");
    };

    window[FLAG] = s;
    return s;
  }
})()`;
}

export const SHELL_DISPLAY_RESET_EXPRESSION = `(function () {
  var st = window[${JSON.stringify(FLAG)}];
  if (!st || typeof st.uninstall !== "function") return "not-installed";
  st.uninstall(false);
  return "ok";
})()`;

const EMPTY: ShellDisplayStatus = {
  installed: false,
  version: null,
  size: null,
  zoom: null,
  fullscreen: false,
  inner: null,
  reason: null,
};

export function parseShellDisplayStatus(raw: unknown): ShellDisplayStatus {
  if (typeof raw !== "string") return { ...EMPTY };
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
    o = parsed as Record<string, unknown>;
  } catch {
    return { ...EMPTY };
  }
  const inner = o["inner"];
  return {
    installed: o["installed"] === true,
    version: typeof o["version"] === "number" ? o["version"] : null,
    size: typeof o["size"] === "string" ? o["size"] : null,
    zoom: typeof o["zoom"] === "number" ? o["zoom"] : null,
    fullscreen: o["fullscreen"] === true,
    inner:
      Array.isArray(inner) &&
      inner.length === 2 &&
      typeof inner[0] === "number" &&
      typeof inner[1] === "number"
        ? [inner[0], inner[1]]
        : null,
    reason: typeof o["reason"] === "string" ? o["reason"] : null,
  };
}
