/**
 * 遊戲裡的復盤畫面
 * ================
 * 托盤播放器（apps/tray/renderer/kifu/viewer.js）原封不動注入遊戲頁面，蓋在遊戲畫布正上方播放。
 * 同一支繪圖程式，所以兩邊看到的一模一樣；圖是牌譜當時的版本快照（data URL 一起送進來），
 * 不碰網路、不碰遊戲本身的狀態（Phaser 照跑，只是被蓋住、點不到）。
 *
 * 操作：← → 上一步／下一步、PageUp／PageDown 跳回合、空白鍵播放、Esc 或右上 ✕ 關掉；
 * 點畫面左半邊／右半邊也是上一步／下一步。
 *
 * ⚠ 戰鬥中不開（呼叫端擋）：蓋住畫面會害玩家錯過出牌。
 * ⚠⚠ **注入腳本裡的註解不能有反引號，反斜線要寫兩次。**
 */

import { embedJson } from "./embed.js";

const FLAG = "__ulrKifuOverlay";

export interface KifuOverlayOptions {
  /** viewer.js 的原始碼（定義 window.KifuViewer） */
  viewerSource: string;
  /** 播放資料（`@ulr/kifu` 的 KifuViewerData；圖與字型已經換成 data URL） */
  data: unknown;
}

export function buildKifuOverlayScript(options: KifuOverlayOptions): string {
  return `(async function () {
  "use strict";
  var FLAG = ${JSON.stringify(FLAG)};
  try {
    if (window[FLAG] && typeof window[FLAG].close === "function") window[FLAG].close();
    if (!window.KifuViewer) {
      ${options.viewerSource}
    }
    var data = JSON.parse(${embedJson(options.data)});
    var K = window.game && window.game.scene && window.game.scene.keys;
    var m = K && K.MainA;
    try {
      if (m && m.sys.settings.status === 5 && m.socket && m.socket.readyState === 1) return "in-battle";
    } catch (e) {}
    var game = document.querySelector("canvas");
    if (!game) return "no-canvas";

    var root = document.createElement("div");
    root.style.cssText = "position:fixed;z-index:2147483000;background:#000;display:flex;flex-direction:column;";
    var board = document.createElement("canvas");
    board.style.cssText = "width:100%;flex:1;min-height:0;object-fit:contain;cursor:pointer;";
    var bar = document.createElement("div");
    bar.style.cssText = "height:22px;display:flex;align-items:center;gap:8px;padding:0 8px;background:rgba(12,14,22,.92);color:#dfe2ea;font:12px sans-serif;";
    var pos = document.createElement("span");
    var text = document.createElement("span");
    text.style.cssText = "flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;";
    var close = document.createElement("span");
    close.textContent = "\\u2715";
    close.style.cssText = "cursor:pointer;padding:0 4px;";
    bar.appendChild(pos); bar.appendChild(text); bar.appendChild(close);
    root.appendChild(board); root.appendChild(bar);
    document.body.appendChild(root);
    function place() {
      var r = game.getBoundingClientRect();
      root.style.left = r.left + "px"; root.style.top = r.top + "px";
      root.style.width = r.width + "px"; root.style.height = r.height + "px";
    }
    place();

    for (var fam in (data.fonts || {})) {
      try { var f = new FontFace(fam, "url(" + data.fonts[fam] + ")"); await f.load(); document.fonts.add(f); } catch (e) {}
    }
    var textures = await window.KifuViewer.loadTextures(data.textures, function (u) { return u; });
    var v = window.KifuViewer.create(board, { replay: data.replay, textures: textures, tables: data.tables });
    var steps = data.replay.steps, cur = 0, timer = null;
    function go(i) {
      cur = Math.max(0, Math.min(i, steps.length - 1));
      v.show(cur);
      pos.textContent = (cur + 1) + "/" + steps.length + "  T" + steps[cur].state.turn;
      text.textContent = steps[cur].text;
    }
    function turn(dir) {
      var i = cur + dir;
      while (i > 0 && i < steps.length - 1 && steps[i].kind !== "turn") i += dir;
      go(i);
    }
    function play() {
      if (timer) { clearInterval(timer); timer = null; return; }
      timer = setInterval(function () { if (cur >= steps.length - 1) { clearInterval(timer); timer = null; return; } go(cur + 1); }, 900);
    }
    function onKey(e) {
      var k = e.key;
      if (k === "ArrowRight") go(cur + 1);
      else if (k === "ArrowLeft") go(cur - 1);
      else if (k === "PageDown") turn(1);
      else if (k === "PageUp") turn(-1);
      else if (k === " ") play();
      else if (k === "Escape") shut();
      else return;
      e.preventDefault(); e.stopPropagation();
    }
    function onClick(e) {
      var r = board.getBoundingClientRect();
      go(e.clientX - r.left < r.width / 2 ? cur - 1 : cur + 1);
      e.stopPropagation();
    }
    function shut() {
      try { if (timer) clearInterval(timer); } catch (e) {}
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      try { root.remove(); } catch (e) {}
      delete window[FLAG];
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    board.addEventListener("click", onClick);
    close.addEventListener("click", shut);
    window[FLAG] = { close: shut };
    go(0);
    return "ok " + steps.length;
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

export const KIFU_OVERLAY_CLOSE_EXPRESSION = `(function () {
  try { var o = window["${FLAG}"]; if (!o) return "not-open"; o.close(); return "ok"; }
  catch (e) { return "error:" + String((e && e.message) || e); }
})()`;
