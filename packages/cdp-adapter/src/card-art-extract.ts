/**
 * 從跑著的遊戲裡取出「空的卡面」—— 給卡面替換 MOD 當底稿
 * ========================================================
 * 遊戲裡**沒有**無框的卡圖、也沒有無圖的空框：卡面圖集（2026-09-23 改版前叫
 * `cc_front`，之後是 `CharaCardImages`，multiatlas、怪物也在裡面）每一格都是
 * 「插畫 + 框 + 底部 HP/ATK/DEF 標籤」烤在一起的 168×240（2026-08-25 實測，
 * 見 patch-deck-edit.ts 的 cardImage）。玩家要自己做卡面，得有一張只有框的
 * 透明 PNG 可以疊在自己的圖上 —— 這支就是把那張框**從 631 張卡裡統計出來**。
 *
 * 算出來的 15 張放進 repo（`apps/tray/assets/card-frames/168x240`），跟插件一起
 * 打包 —— 2026-09-17 起不再讓玩家自己按鈕取（要開遊戲、要進大廳、頁面卡 3 秒）。
 * 這支現在只給 `scripts/extract-card-frames.ts` 用：遊戲改了框的時候重取一次。
 *
 * ## 統計的原理
 *
 * 同一個等級的卡（例如全部 68 張 R1）框完全一樣、只有插畫不同。逐像素看：
 *
 * ```
 *   觀測 = a·F + (1−a)·B        a = 框的不透明度、F = 框的顏色、B = 底下的插畫
 * ```
 *
 * B 不知道，但**旁邊沒被框蓋到的像素**就是插畫本身，拿它當 B 的估計，對 N 張卡
 * 做一次線性回歸 `觀測 = c + k·B`，就得到 k = 1−a、c = a·F。三種像素：
 *
 * - 跨卡變化跟純插畫區一樣大 → 沒被框蓋到（a = 0）
 * - 跨卡完全不變 → 框是不透明的（a = 1，顏色取中位數）
 * - 中間 → 半透明（左邊那條直條、底部 HP 列都是這種），走回歸
 *
 * 2026-09-15 用 Python 對 281 張 R 卡驗過：拿算出來的框疊回史塔夏的 HD 原圖，
 * 跟官方卡面逐像素差平均 16/255；肉眼看不出差別。
 *
 * ## L 卡不一樣：底下不是插畫，是壁紙
 *
 * L 卡的人物是去背的，站在一張灰色藤蔓壁紙上 —— 而那張壁紙**就是** `ccframe_base`
 * 第 0 格（牌組編輯的空槽底圖），實測逐像素零位移吻合。所以 L 卡給兩層：
 *
 * - `底`：壁紙 + 框，不透明。逐像素取眾數（同一像素大部分卡都露出壁紙，眾數就是
 *   壁紙；人物永遠蓋住的正中央眾數不可靠，那幾格直接用 ccframe_base 補）
 * - `框`：疊在人物**上面**的那層。直條跟同等級的 R 卡完全一樣（實測），拿 R 的；
 *   頂端的銀牌用 底 的像素；底部標籤列 L 跟 R 不同，用全部 350 張 L 卡回歸
 *
 * 十個等級的直條顏色各不相同（L1=R1 銀、L3=R3 藍、L5=R5 金……），所以每個
 * 等級各出一份，共 15 張：R1~R5 各一張框、L1~L5 各一張底一張框。
 *
 * ## 為什麼是 evaluate 而不是 Node 端算
 *
 * 圖集 19 MB 的 webp 在頁面上已經解碼好了（`texture.source[0].image`），
 * 畫進 canvas 就能 getImageData；搬回 Node 要自己解 webp。WebGL 能上傳這張
 * 圖就表示它沒被 CORS 污染，canvas 讀得到。整支在頁面上跑 2~4 秒。
 *
 * ⚠⚠ **腳本裡的註解不能有反引號。** 整段住在 template literal 裡。
 */

/** 卡面的一格。卡面圖集每格都是這個大小。 */
export const CARD_FRAME_WIDTH = 168;
export const CARD_FRAME_HEIGHT = 240;

/** 取出來的一個檔案。`dataUrl` 是 PNG。 */
export interface ExtractedCardFrame {
  name: string;
  dataUrl: string;
}

export interface CardFrameExtractResult {
  ok: boolean;
  files: ExtractedCardFrame[];
  /** 沒 ok 時說為什麼；ok 時可能有警告（例如壁紙那格不在，底用眾數硬算）。 */
  reason: string | null;
  /** 頁面上花了幾毫秒。 */
  ms: number;
}

export const CARD_FRAME_EXTRACT_EXPRESSION = `(function () {
  "use strict";
  var W = ${CARD_FRAME_WIDTH}, H = ${CARD_FRAME_HEIGHT}, P = W * H;
  var t0 = Date.now();
  function fail(why) { return JSON.stringify({ ok: false, files: [], reason: why, ms: Date.now() - t0 }); }
  try {
    var g = window.game;
    if (!g || !g.textures || !g.textures.exists("CharaCardImages")) return fail("卡面圖集還沒載進來（先進大廳或牌組編輯）");
    var tex = g.textures.get("CharaCardImages");
    var names = tex.getFrameNames();
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d", { willReadFrequently: true });

    function pixels(frameName) {
      var f = tex.get(frameName);
      if (!f || f.width !== W || f.height !== H) return null;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(f.source.image, f.cutX, f.cutY, W, H, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    }
    function group(suffix) {
      var out = [];
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n.length >= suffix.length && n.slice(-suffix.length) === suffix && /^cc\\d{3}_/.test(n)) {
          var d = pixels(n);
          if (d) out.push(d);
        }
      }
      return out;
    }
    function median(arr) {
      var s = arr.slice().sort(function (a, b) { return a - b; });
      var m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    /* 回歸：回傳 {a: Float32Array(P), F: Float32Array(P*3)} */
    function layer(samples) {
      var N = samples.length;
      var mean = new Float32Array(P * 3), std = new Float32Array(P);
      var p, c, i, v;
      for (p = 0; p < P; p++) {
        var s = 0;
        for (c = 0; c < 3; c++) {
          var m = 0, m2 = 0;
          for (i = 0; i < N; i++) { v = samples[i][p * 4 + c]; m += v; m2 += v * v; }
          m /= N; m2 /= N;
          mean[p * 3 + c] = m;
          s += Math.sqrt(Math.max(0, m2 - m * m));
        }
        std[p] = s / 3;
      }
      /* 純插畫區的整體變異（跨卡、跨像素） */
      var rs = 0, rs2 = 0, rn = 0;
      for (var y = 60; y < 215; y++) for (var x = 40; x < 150; x++) {
        p = y * W + x;
        for (c = 0; c < 3; c++) for (i = 0; i < N; i++) { v = samples[i][p * 4 + c]; rs += v; rs2 += v * v; rn++; }
      }
      rs /= rn; rs2 /= rn;
      var refStd = Math.sqrt(Math.max(1e-6, rs2 - rs * rs));
      var ratio = new Float32Array(P);
      for (p = 0; p < P; p++) ratio[p] = std[p] / refStd;

      /* 純插畫像素：變異夠大，再 opening(2) 去掉零星雜點（4 鄰域） */
      var pure = new Uint8Array(P);
      for (p = 0; p < P; p++) pure[p] = ratio[p] > 0.85 ? 1 : 0;
      function morph(src, erode) {
        var dst = new Uint8Array(P);
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var q = y * W + x, val = src[q];
          var n1 = y > 0 ? src[q - W] : 0, n2 = y < H - 1 ? src[q + W] : 0;
          var n3 = x > 0 ? src[q - 1] : 0, n4 = x < W - 1 ? src[q + 1] : 0;
          if (erode) dst[q] = (val && n1 && n2 && n3 && n4) ? 1 : 0;
          else dst[q] = (val || n1 || n2 || n3 || n4) ? 1 : 0;
        }
        return dst;
      }
      pure = morph(morph(pure, true), true);
      pure = morph(morph(pure, false), false);

      /* 每個像素最近的純插畫像素（多源 BFS） */
      var near = new Int32Array(P);
      var queue = new Int32Array(P), qh = 0, qt = 0;
      for (p = 0; p < P; p++) { near[p] = pure[p] ? p : -1; if (pure[p]) queue[qt++] = p; }
      while (qh < qt) {
        var cur = queue[qh++], cy = (cur / W) | 0, cx = cur - cy * W;
        var nb = [cy > 0 ? cur - W : -1, cy < H - 1 ? cur + W : -1, cx > 0 ? cur - 1 : -1, cx < W - 1 ? cur + 1 : -1];
        for (var k = 0; k < 4; k++) { var q2 = nb[k]; if (q2 >= 0 && near[q2] < 0) { near[q2] = near[cur]; queue[qt++] = q2; } }
      }

      var a = new Float32Array(P), F = new Float32Array(P * 3);
      var B = new Float32Array(N), O = new Float32Array(N), col = new Float32Array(N);
      for (p = 0; p < P; p++) {
        if (pure[p]) continue;
        if (ratio[p] < 0.03 || near[p] < 0) {
          a[p] = 1;
          for (c = 0; c < 3; c++) { for (i = 0; i < N; i++) col[i] = samples[i][p * 4 + c]; F[p * 3 + c] = median(col); }
          continue;
        }
        var py = (p / W) | 0, px = p - py * W;
        var qy = (near[p] / W) | 0, qx = near[p] - qy * W;
        var dy = Math.sign(qy - py), dx = Math.sign(qx - px);
        var pts = [];
        for (var tt = 0; tt < 3; tt++) {
          var yy = Math.min(H - 1, Math.max(0, qy + dy * tt)), xx = Math.min(W - 1, Math.max(0, qx + dx * tt));
          pts.push(yy * W + xx);
        }
        var ksum = 0, cs = [0, 0, 0];
        for (c = 0; c < 3; c++) {
          var mb = 0, mo = 0;
          for (i = 0; i < N; i++) {
            var b = (samples[i][pts[0] * 4 + c] + samples[i][pts[1] * 4 + c] + samples[i][pts[2] * 4 + c]) / 3;
            B[i] = b; O[i] = samples[i][p * 4 + c]; mb += b; mo += O[i];
          }
          mb /= N; mo /= N;
          var cov = 0, varb = 0;
          for (i = 0; i < N; i++) { cov += (B[i] - mb) * (O[i] - mo); varb += (B[i] - mb) * (B[i] - mb); }
          var kk = varb > 1e-6 ? cov / varb : 0;
          ksum += kk; cs[c] = mo - kk * mb;
        }
        var kmean = Math.min(1, Math.max(0, ksum / 3));
        var al = 1 - kmean;
        a[p] = al;
        if (al > 1e-3) for (c = 0; c < 3; c++) F[p * 3 + c] = Math.min(255, Math.max(0, cs[c] / al));
      }
      for (p = 0; p < P; p++) {
        if (a[p] < 0.1) a[p] = 0;
        else if (a[p] > 0.97) a[p] = 1;
      }
      /* 插畫區正中央的半透明像素是回歸的雜訊（很多卡在那裡都暗），不是框：
         框的半透明部分（直條、標籤列）一定貼著不透明的邊。插畫區（銀牌下緣
         y=39、直條右緣 x=16、右邊框 x=163、標籤列上緣 y=218，2026-09-15 量的，
         全部卡片同一套框）往內縮幾格的範圍裡，離不透明像素 6 格以上的一律當成
         透明。 */
      var top = 39, hp = 218, left = 16, right = 163;
      var dist = new Int32Array(P), dq = new Int32Array(P), dh = 0, dt = 0;
      for (p = 0; p < P; p++) { dist[p] = a[p] >= 1 ? 0 : -1; if (a[p] >= 1) dq[dt++] = p; }
      while (dh < dt) {
        var cur2 = dq[dh++], cy2 = (cur2 / W) | 0, cx2 = cur2 - cy2 * W, dd = dist[cur2] + 1;
        var nb2 = [cy2 > 0 ? cur2 - W : -1, cy2 < H - 1 ? cur2 + W : -1, cx2 > 0 ? cur2 - 1 : -1, cx2 < W - 1 ? cur2 + 1 : -1];
        for (var k2 = 0; k2 < 4; k2++) { var q3 = nb2[k2]; if (q3 >= 0 && dist[q3] < 0) { dist[q3] = dd; dq[dt++] = q3; } }
      }
      for (p = 0; p < P; p++) {
        var py2 = (p / W) | 0, px2 = p - py2 * W;
        if (a[p] > 0 && a[p] < 1 && py2 > top + 3 && py2 < hp - 3 && px2 > left + 3 && px2 < right - 3 && (dist[p] < 0 || dist[p] > 6)) a[p] = 0;
        if (a[p] === 0) { F[p * 3] = F[p * 3 + 1] = F[p * 3 + 2] = 0; }
      }
      return { a: a, F: F };
    }

    /* 眾數：回傳 {rgb: Uint8ClampedArray(P*3), count: Uint16Array(P)} */
    function modeImage(samples) {
      var N = samples.length, rgb = new Uint8ClampedArray(P * 3), count = new Uint16Array(P);
      var keys = new Int32Array(N), idx = new Int32Array(N);
      for (var p = 0; p < P; p++) {
        for (var i = 0; i < N; i++) {
          var d = samples[i];
          keys[i] = ((d[p * 4] >> 2) << 12) | ((d[p * 4 + 1] >> 2) << 6) | (d[p * 4 + 2] >> 2);
          idx[i] = i;
        }
        var order = Array.prototype.slice.call(idx).sort(function (x, y) { return keys[x] - keys[y]; });
        var best = -1, bestN = 0, run = 0, runKey = -1, runStart = 0;
        for (var j = 0; j <= N; j++) {
          var kj = j < N ? keys[order[j]] : -2;
          if (kj === runKey) { run++; continue; }
          if (run > bestN) { bestN = run; best = runStart; }
          runKey = kj; run = 1; runStart = j;
        }
        var r = 0, gg = 0, b = 0;
        for (var m = best; m < best + bestN; m++) { var s = samples[order[m]]; r += s[p * 4]; gg += s[p * 4 + 1]; b += s[p * 4 + 2]; }
        rgb[p * 3] = r / bestN; rgb[p * 3 + 1] = gg / bestN; rgb[p * 3 + 2] = b / bestN;
        count[p] = bestN;
      }
      return { rgb: rgb, count: count };
    }

    function toPng(rgba) {
      var img = ctx.createImageData(W, H);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
      return cv.toDataURL("image/png");
    }
    function layerToRgba(L) {
      var out = new Uint8ClampedArray(P * 4);
      for (var p = 0; p < P; p++) {
        out[p * 4] = L.F[p * 3]; out[p * 4 + 1] = L.F[p * 3 + 1]; out[p * 4 + 2] = L.F[p * 3 + 2];
        out[p * 4 + 3] = Math.round(L.a[p] * 255);
      }
      return out;
    }

    /* 壁紙：ccframe_base 第 0 格 */
    var wall = null, warn = null;
    try {
      if (g.textures.exists("ccframe_base")) {
        var wf = g.textures.getFrame("ccframe_base", 0);
        if (wf && wf.width === W && wf.height === H) {
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(wf.source.image, wf.cutX, wf.cutY, W, H, 0, 0, W, H);
          wall = ctx.getImageData(0, 0, W, H).data;
        }
      }
    } catch (e) { wall = null; }
    if (!wall) warn = "空槽底圖（ccframe_base）不在，L 卡的底用眾數硬算，正中央可能有雜點";

    var files = [];
    var lPool = [];
    var rLayers = {};
    var lv;
    for (lv = 1; lv <= 5; lv++) {
      var rs = group("_r0" + lv);
      if (rs.length < 8) return fail("R" + lv + " 只找到 " + rs.length + " 張卡，不夠統計");
      var RL = layer(rs);
      rLayers[lv] = RL;
      files.push({ name: "R" + lv + "_框.png", dataUrl: toPng(layerToRgba(RL)) });
    }
    var lGroups = {};
    for (lv = 1; lv <= 5; lv++) {
      var ls = group("_0" + lv);
      if (ls.length < 8) return fail("L" + lv + " 只找到 " + ls.length + " 張卡，不夠統計");
      lGroups[lv] = ls;
      for (var i2 = 0; i2 < ls.length; i2++) lPool.push(ls[i2]);
    }
    var LL = layer(lPool);
    /* R 框裡「非不透明」的列的範圍：頂端銀牌以上、底部標籤以下都在這之外 */
    var R1 = rLayers[1], rowSemi = new Uint8Array(H);
    for (var y2 = 0; y2 < H; y2++) {
      var n = 0;
      for (var x2 = 0; x2 < W; x2++) if (R1.a[y2 * W + x2] < 1) n++;
      rowSemi[y2] = n > W / 2 ? 1 : 0;
    }
    var TOP = 0; while (TOP < H && !rowSemi[TOP]) TOP++;
    var BOTTOM = 200;
    for (lv = 1; lv <= 5; lv++) {
      /* 眾數：頂端銀牌那幾列永遠露出來，眾數就是它 */
      var M = modeImage(lGroups[lv]);
      /* 框（疊在人物上面那層）：直條拿同等級 R 的、銀牌拿眾數、底部標籤列拿 L 回歸 */
      var RL2 = rLayers[lv];
      var over = layerToRgba(RL2);
      var p3, yy2;
      for (p3 = 0; p3 < P; p3++) {
        yy2 = (p3 / W) | 0;
        if (yy2 < TOP) {
          if (RL2.a[p3] >= 1) { over[p3 * 4] = M.rgb[p3 * 3]; over[p3 * 4 + 1] = M.rgb[p3 * 3 + 1]; over[p3 * 4 + 2] = M.rgb[p3 * 3 + 2]; }
        } else if (yy2 >= BOTTOM) {
          over[p3 * 4] = LL.F[p3 * 3]; over[p3 * 4 + 1] = LL.F[p3 * 3 + 1]; over[p3 * 4 + 2] = LL.F[p3 * 3 + 2];
          over[p3 * 4 + 3] = Math.round(LL.a[p3] * 255);
        }
      }
      files.push({ name: "L" + lv + "_框.png", dataUrl: toPng(over) });
      /* 底（不透明）：銀牌以上用眾數，其餘 = 框疊在壁紙上。壁紙不在就退回眾數
         （人物永遠蓋住的正中央會是雜點，所以上面有 warn）。 */
      var base = new Uint8ClampedArray(P * 4);
      for (p3 = 0; p3 < P; p3++) {
        yy2 = (p3 / W) | 0;
        var al2 = over[p3 * 4 + 3] / 255;
        for (var c2 = 0; c2 < 3; c2++) {
          var under = wall ? wall[p3 * 4 + c2] : M.rgb[p3 * 3 + c2];
          base[p3 * 4 + c2] = (yy2 < TOP || !wall) ? M.rgb[p3 * 3 + c2] : al2 * over[p3 * 4 + c2] + (1 - al2) * under;
        }
        base[p3 * 4 + 3] = 255;
      }
      files.push({ name: "L" + lv + "_底.png", dataUrl: toPng(base) });
    }
    return JSON.stringify({ ok: true, files: files, reason: warn, ms: Date.now() - t0 });
  } catch (e) {
    return fail(String((e && e.stack) || e));
  }
})()`;

export function parseCardFrameExtractResult(raw: string): CardFrameExtractResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, files: [], reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`, ms: 0 };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const files: ExtractedCardFrame[] = [];
  if (Array.isArray(o.files)) {
    for (const f of o.files as Record<string, unknown>[]) {
      if (
        typeof f?.name === "string" &&
        typeof f.dataUrl === "string" &&
        f.dataUrl.startsWith("data:image/png;base64,")
      )
        files.push({ name: f.name, dataUrl: f.dataUrl });
    }
  }
  return {
    ok: o.ok === true && files.length > 0,
    files,
    reason: typeof o.reason === "string" ? o.reason : null,
    ms: typeof o.ms === "number" ? o.ms : 0,
  };
}
