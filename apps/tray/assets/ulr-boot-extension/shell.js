(function () {
  "use strict";
  // 2026-09-23 改版：遊戲不再開在 :14012~14021（那幾個 port 已經連不上），頁面就在
  // 沒有 port 的 https://www.playunlight.online/ 上，所以不再導向。真頁面用的
  // 樣式表也從 style-steam.css 換成 style-dmm.css。
  var CFG = JSON.parse(
    '{"canvasId":"myCustomCanvas","canvasWidth":760,"canvasHeight":680,"stylesheet":"stylesheets/style-dmm.css","title":"UNLIGHT:Revive","portMin":14012,"portMax":14021,"allowPortRedirect":false}',
  );
  var BUNDLES = JSON.parse(document.documentElement.dataset.ulrBundles || "[]");
  var FLAG = "__ulrBootShell";

  // 注入會在這個 target 的每個 document 跑，導向之後也會再跑一次。
  // 沒有這道閘就會重複建 canvas、重複注入 bundle。
  if (window[FLAG]) return;

  var params = new URLSearchParams(location.search);
  // 網址沒帶身分時退回擴充功能記下來的那個，這樣書籤不必寫死 steamid。
  var authString =
    params.get("platform_id") ||
    params.get("steamid") ||
    params.get("stove_id") ||
    document.documentElement.dataset.ulrAuth ||
    "";

  // 兩邊都沒有就別碰這個頁面。
  if (!authString) return;

  window[FLAG] = { rebuilt: false };

  // 遊戲實際跑在 :14012~14021 的其中一個 port，沒帶 port 的網址會拿到 403。
  if (location.port === "" && CFG.allowPortRedirect) {
    var span = CFG.portMax - CFG.portMin + 1;
    var port = CFG.portMin + Math.trunc(Math.random() * span);
    location.href =
      location.protocol +
      "//" +
      location.hostname +
      ":" +
      port +
      location.pathname +
      location.search +
      location.hash;
    return;
  }

  window.SERVER = "steam";
  window.platform_type = location.pathname.indexOf("stove") !== -1 ? "stove" : "steam";
  window.auth_string = authString;
  // 2026-09-23 起遊戲登入讀的是這個（connection_socket.fetch("getid", platform_config)），
  // 不再讀 auth_string。真頁面的內嵌腳本就是這三個欄位 —— 沒有 access_token，
  // 那顆 token 只是拿來讓伺服器吐 HTML 的。
  window.platform_config = {
    platform_id: authString,
    platform_key: "unlight",
    platform_type: window.SERVER,
  };

  // 2026-09-23 起 main.js（SERVER 不是 dmm 時）會先 await 五個 FontFace，來源是
  // ulfont://app/fonts/… —— 那是桌面版 Electron 自訂的協定，一般 Chrome 載不到，
  // 一個失敗整條啟動鏈就停在那裡，window.game 永遠不會出現（症狀：白畫面）。
  // 所以把來源改到擴充自己的 fonts/（content.js 給路徑），而且載入失敗也放行，
  // 最壞就是字型退回系統字，遊戲照樣起得來。
  var FONT_BASE = document.documentElement.dataset.ulrFonts || "";
  var RealFontFace = window.FontFace;
  if (RealFontFace && !RealFontFace.__ulrBoot) {
    var PatchedFontFace = function (family, source, descriptors) {
      if (typeof source === "string" && FONT_BASE) {
        source = source.replace(/ulfont:\/\/app\/fonts\//g, FONT_BASE);
      }
      var face = new RealFontFace(family, source, descriptors);
      var load = face.load.bind(face);
      face.load = function () {
        return load().catch(function () {
          return face;
        });
      };
      return face;
    };
    PatchedFontFace.prototype = RealFontFace.prototype;
    PatchedFontFace.__ulrBoot = true;
    window.FontFace = PatchedFontFace;
  }

  function alreadyServed() {
    // 伺服器有正常吐頁面的時候（正常 Steam 流程），文件裡本來就有 client/ 的
    // script。這時候動手會把已經載好的遊戲砍掉重來。
    return (
      document.querySelector('script[src*="' + BUNDLES[0] + '"]') !== null ||
      document.querySelector('script[src*="/client/"]') !== null
    );
  }

  function loadNext(i) {
    if (i >= BUNDLES.length) return;
    var s = document.createElement("script");
    s.src = BUNDLES[i];
    s.onload = function () {
      loadNext(i + 1);
    };
    s.onerror = function () {
      // ⚠ 這裡**不要**宣稱「遊戲改版了」。onerror 只在檔案真的不存在時觸發，
      // 而伺服器會保留舊的 bundle（社群實測），所以改版後最可能的結果是
      // 靜默跑在舊版，根本不會走到這裡。詳見檔案開頭的說明。
      var msg = document.createElement("div");
      msg.style.cssText = "color:#f66;font:14px/1.6 monospace;padding:16px";
      msg.style.whiteSpace = "pre-wrap";
      msg.textContent = "載入失敗：" + BUNDLES[i] + "\n請重新同步 bundle 檔名後再試。";
      document.body.appendChild(msg);
    };
    document.head.appendChild(s);
  }

  function rebuild() {
    if (alreadyServed()) return;
    // dataset 模式下檔名是執行期給的。給不出來就什麼都別做 —— 清空 body 卻又
    // 沒有東西可載，只會留下一片白畫面，比原本的 403 更難懂。
    if (BUNDLES.length === 0) return;

    document.body.textContent = "";
    document.title = CFG.title;

    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = CFG.stylesheet;
    document.head.appendChild(css);

    // 照 2026-09-23 版真頁面的骨架：body > audio#audio、div#Unlight.gamepart > canvas。
    // Phaser 的 config 是 parent:"Unlight"。
    // ⚠ 真頁面還有一張 img.top_bg（遊戲介紹／新手教學的大圖），**刻意不放**：桌面版
    //   視窗剛好 760x680 所以看不到它，瀏覽器裡它會整張排在遊戲下面、還撐出捲軸。
    document.body.style.margin = "0";
    var audio = document.createElement("audio");
    audio.id = "audio";
    document.body.appendChild(audio);
    var part = document.createElement("div");
    part.id = "Unlight";
    part.className = "gamepart";
    document.body.appendChild(part);

    var canvas = document.createElement("canvas");
    canvas.id = CFG.canvasId;
    canvas.width = CFG.canvasWidth;
    canvas.height = CFG.canvasHeight;
    part.appendChild(canvas);

    window[FLAG].rebuilt = true;
    loadNext(0);
    setInterval(kickStuckAudio, 1000);
  }

  // 遊戲設定是 disableWebAudio:true，音效全走 HTML5 <audio>。Chrome 對**看不見**的
  // 分頁（最小化、被別的視窗整個蓋住）會延後載入媒體，於是 Unlight_Init 永遠卡在
  // 三個 ulse*.mp3 上、停在黑畫面（2026-09-23 實測；桌面版 Electron 視窗一直算看得見，
  // 所以從來沒踩到）。卡超過 3 秒就替它發 canplaythrough 讓載入器往下走 —— 真的
  // 音檔等分頁看得見時照樣會載，最壞只是那幾聲沒響。
  function kickStuckAudio() {
    var G = window.game;
    if (!G || !G.scene || !G.scene.keys) return;
    var now = Date.now();
    Object.keys(G.scene.keys).forEach(function (k) {
      var L = G.scene.keys[k] && G.scene.keys[k].load;
      if (!L || !L.inflight || !L.inflight.size || !L.inflight.each) return;
      L.inflight.each(function (f) {
        if (!Array.isArray(f.data)) return;
        f.__ulrSince = f.__ulrSince || now;
        if (now - f.__ulrSince < 3000) return;
        f.data.forEach(function (a) {
          if (!(a instanceof HTMLMediaElement) || a.dataset.ulrKicked) return;
          a.dataset.ulrKicked = "1";
          a.dispatchEvent(new Event("canplaythrough"));
        });
      });
    });
  }

  // document-start 時 body 還不存在。403 的錯誤頁也要等解析完才知道有沒有
  // client/ 的 script，所以一律等 DOMContentLoaded。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rebuild);
  } else {
    rebuild();
  }
})();
