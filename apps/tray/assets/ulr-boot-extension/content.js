(function () {
  "use strict";
  var CFG = {
    storageKey: "ulrBundles",
    datasetKey: "ulrBundles",
    authDatasetKey: "ulrAuth",
    bundleDir: "client/",
    deployWeekday: 2,
    deployUtcHour: 2,
    steamUrl: "steam://rungameid/3247080",
    waitAfterLaunchMs: 90000,
  };
  /** 清單夠新時，多久還是要再問一次雲端（抓週中熱修）。 */
  var CFG_RECHECK_MS = 6 * 60 * 60 * 1000;

  function currentBundles() {
    var out = [];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (!src) continue;
      var u;
      try {
        u = new URL(src);
      } catch {
        continue;
      }
      if (u.origin !== location.origin) continue;
      var p = u.pathname.replace(/^\//, "");
      if (p.indexOf(CFG.bundleDir) !== 0) continue;
      out.push(p);
    }
    return out;
  }

  /** 最近一次「應該已經部署」的時間點。 */
  function lastDeploy(now) {
    var d = new Date(now.getTime());
    d.setUTCHours(CFG.deployUtcHour, 5, 0, 0);
    while (d.getUTCDay() !== CFG.deployWeekday || d.getTime() > now.getTime()) {
      d.setUTCDate(d.getUTCDate() - 1);
      d.setUTCHours(CFG.deployUtcHour, 5, 0, 0);
    }
    return d;
  }

  /**
   * 黃條。可以帶一顆「開啟 Steam」按鈕。
   *
   * ⚠ 為什麼一定要按鈕、不能自動導向 steam://：瀏覽器對外部協定強制要求
   * user gesture，這是防止網頁隨意啟動本機程式的安全機制，擴充功能沒有豁免。
   * 沒有點擊的話 Chrome 會直接吞掉，而且不會有任何錯誤 —— 那比要求點一下更糟。
   */
  function notice(text, withButton) {
    var el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:8px 12px;" +
      "background:#3a2a00;color:#ffd479;font:13px/1.5 sans-serif;white-space:pre-wrap";
    var span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);

    if (withButton) {
      var btn = document.createElement("button");
      btn.textContent = "開啟 Steam 更新";
      btn.style.cssText =
        "margin-left:12px;padding:3px 10px;border:1px solid #ffd479;border-radius:4px;" +
        "background:transparent;color:#ffd479;font:inherit;cursor:pointer";
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "已送出，等遊戲載入…";
        location.href = CFG.steamUrl;
        setTimeout(function () {
          span.textContent =
            "等不到更新。若你目前啟用的是桌面版客戶端（遊戲開在自己的視窗、" +
            "不經過瀏覽器），這條路就收不到檔案清單 —— 要先換成網頁版客戶端。";
          btn.disabled = false;
          btn.textContent = "再試一次";
        }, CFG.waitAfterLaunchMs);
      });
      el.appendChild(btn);
    }
    document.body.appendChild(el);
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  /**
   * 問 cloud.js 去雲端拿一份清單。拿不到就回 null —— 呼叫端照舊走原本那條路。
   *
   * ⚠ 一定要檢查 chrome.runtime.lastError：service worker 剛好在休眠、擴充剛
   *   重載、或訊息沒人接的時候，callback 還是會被叫到，只是 lastError 有值。
   *   不讀它的話 Chrome 會在 console 印一條沒人看得懂的紅字。
   */
  function 問雲端(好了) {
    var 回過 = false;
    function 一次(值) {
      if (!回過) {
        回過 = true;
        好了(值);
      }
    }
    try {
      chrome.runtime.sendMessage({ 要: "雲端清單" }, function (答) {
        if (chrome.runtime.lastError) return 一次(null);
        一次(答 && 答.ok ? 答 : null);
      });
    } catch {
      一次(null);
    }
    // service worker 起不來的話 sendMessage 有機會連 callback 都不叫。
    setTimeout(function () {
      一次(null);
    }, 6000);
  }

  ready(function () {
    var params = new URLSearchParams(location.search);
    // platform_id 是 2026-09-23 改版後 Steam 流程網址上的 SteamID（之前叫 steamid）。
    var urlAuth =
      params.get("platform_id") || params.get("steamid") || params.get("stove_id") || "";

    var served = currentBundles();
    if (served.length > 0) {
      // 伺服器給了真的頁面 —— 這是唯一可靠的真相來源，記下來就好，不要動畫面。
      // 身分也一起記：這樣書籤不必寫死 steamid，換一台機器、換個人都能用。
      //
      // 這一刻同時也是**唯一**值得推上雲端的一刻，但推的動作不在這裡：推要金鑰，
      // 而未封裝擴充是一疊明文檔案，金鑰放進來等於公開。推交給 雲端清單.py。
      var rec = {};
      rec[CFG.storageKey] = {
        bundles: served,
        auth: urlAuth,
        discoveredAt: new Date().toISOString(),
      };
      chrome.storage.local.set(rec);
      return;
    }

    chrome.storage.local.get(CFG.storageKey, function (data) {
      var rec = data && data[CFG.storageKey];
      var known = rec && rec.bundles ? rec.bundles.join(",") : "";

      // 按了按鈕之後，遊戲會在另一個分頁載入、由那邊的 content script 記下
      // 新檔名。這裡等 storage 一變就自己重載 —— 使用者不必回來手動 F5。
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes[CFG.storageKey]) return;
        var next = changes[CFG.storageKey].newValue;
        if (!next || !next.bundles) return;
        if (next.bundles.join(",") === known) return;
        location.reload();
      });

      var 有本地 = !!(rec && rec.bundles && rec.bundles.length > 0);
      var 本地夠新 =
        有本地 && rec.discoveredAt && new Date(rec.discoveredAt) >= lastDeploy(new Date());
      var 最近問過 =
        有本地 && rec.checkedAt && Date.now() - Date.parse(rec.checkedAt) < CFG_RECHECK_MS;

      // 本地那份還在這一輪改版之內、而且最近問過雲端，就直接用。
      // ⚠ 只看「比上週二新」不夠：官方週中也會熱修（2026-09-13 只換了 runtime
      //   與兩個延遲 chunk，main 沒變），只看例行時程的話要等到下週才會問。
      //   所以夠新也每幾個小時問一次 —— 問的是自己的 Worker，不是官方伺服器。
      if (本地夠新 && 最近問過) return 上場(rec);

      問雲端(function (雲) {
        var 雲時 = 雲 ? Date.parse(雲.discoveredAt || 雲.publishedAt || "") : NaN;
        var 本時 = 有本地 && rec.discoveredAt ? Date.parse(rec.discoveredAt) : NaN;
        // 比的是「誰**看到**得比較晚」，不是誰比較晚被推上去：publishedAt 只
        // 說明什麼時候被上傳，同一份舊清單重推一次也會刷新它。
        var 用雲端 = !!雲 && (isNaN(本時) || (!isNaN(雲時) && 雲時 > 本時));

        if (用雲端) {
          var 新 = {
            bundles: 雲.bundles,
            auth: (rec && rec.auth) || urlAuth || "",
            discoveredAt: 雲.discoveredAt || 雲.publishedAt || new Date().toISOString(),
            checkedAt: new Date().toISOString(),
            來源: "雲端",
          };
          // ⚠ 先把 known 設成即將寫進去的值，再寫。不然上面那個 onChanged
          //   會看到「清單變了」而重載頁面 —— 而重載後又走到這裡，變成每次
          //   開頁都白重載一次。
          known = 新.bundles.join(",");
          var 包 = {};
          包[CFG.storageKey] = 新;
          chrome.storage.local.set(包);
          rec = 新;
          有本地 = true;
        } else if (雲 && 有本地) {
          // 問到了、本機那份不比較舊：記下問過的時間，幾個小時內不再問。
          // 清單沒變，上面那個 onChanged 比對 known 之後不會重載。
          var 記 = {};
          rec.checkedAt = new Date().toISOString();
          記[CFG.storageKey] = rec;
          chrome.storage.local.set(記);
        }
        上場(rec);
      });

      function 上場(rec) {
        var auth = urlAuth || (rec && rec.auth) || "";

        // 這兩個是**不同**的失敗，訊息不能混在一起：沒清單要去開 Steam，沒身分
        // 是網址不對，去開 Steam 一百次也不會變好。原本混成同一句，於是「書籤忘了
        // 帶 steamid」會被指去做一件完全沒用的事。
        if (!rec || !rec.bundles || rec.bundles.length === 0) {
          notice(
            "ULR Boot：還沒有這個版本的檔案清單，雲端也沒有。" +
              "需要有人從 Steam 開一次遊戲（開著 ULR Companion 的話會自動回報到雲端）。",
            true,
          );
          return;
        }
        if (!auth) {
          notice(
            "ULR Boot：檔案清單有，但這個網址沒帶 steamid，不知道要登入誰。" +
              "請從書籤列的 ul 資料夾點帳號進來。",
            false,
          );
          return;
        }

        if (rec.discoveredAt && new Date(rec.discoveredAt) < lastDeploy(new Date())) {
          // 措辭要保守：我們無法驗證是否過期，只知道記錄的時間早於上一次
          // 例行部署時間。舊 bundle 伺服器不會刪，所以真的過期也不會報錯。
          notice(
            "ULR Boot：這份檔案清單（" +
              (rec.來源 === "雲端" ? "來自雲端" : "本機") +
              "）記錄於上一次例行更新之前，可能是舊版。" +
              "（無法確認 —— 舊版檔案伺服器仍會供應。）",
            true,
          );
        }

        document.documentElement.dataset[CFG.datasetKey] = JSON.stringify(rec.bundles);
        document.documentElement.dataset[CFG.authDatasetKey] = auth;
        // 字型：shell.js 把 ulfont://app/fonts/ 改指到這裡（見 shell.js 的說明）。
        document.documentElement.dataset.ulrFonts = chrome.runtime.getURL("fonts/");
        var s = document.createElement("script");
        s.src = chrome.runtime.getURL("shell.js");
        s.onload = function () {
          s.remove();
        };
        (document.head || document.documentElement).appendChild(s);
      }
    });
  });
})();
