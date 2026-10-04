/**
 * 去雲端拿 bundle 清單。
 *
 * 為什麼要有這顆 service worker
 * ────────────────────────────
 * MV3 的 content script 發 fetch 是**以頁面的身分**發的，會吃頁面的 CORS 跟
 * CSP —— 遊戲那一頁的 403 錯誤頁擋不擋得住不好說，而且未來改了我們也管不到。
 * service worker 這邊有 host_permissions，跨網域是它自己的權限，跟頁面無關。
 *
 * 為什麼**只讀不寫**
 * ─────────────────
 * 推清單上去要金鑰。金鑰放進擴充等於放在一個誰都讀得到的資料夾裡（未封裝擴充
 * 就是一疊明文檔案），而擴充自己並不需要推 —— 推的時機是「Steam 開了一次遊戲、
 * 伺服器吐了真頁面」，那是電腦上的 Python 那條線在盯的事。所以推留給
 * 雲端清單.py，這裡連 token 都沒有，外流也沒東西可流。
 */
const 雲端 = "https://ulr-hash.lldavuull.workers.dev/bundles";
const 逾時毫秒 = 4000;

// ⚠ 跟 Worker 那邊同一份規則，兩邊各驗一次。這串檔名的下場是變成遊戲頁面上的
//   <script src>，而 "//evil.example/x.js" 是合法的相對網址 —— 瀏覽器會當成
//   protocol-relative 跑去別的網域抓。所以只收 client/ 底下一層的 .js。
const 合法檔名 = /^client\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

function 乾淨(清單) {
  return (
    Array.isArray(清單) &&
    清單.length > 0 &&
    清單.length <= 20 &&
    清單.every(function (x) {
      return typeof x === "string" && x.length <= 200 && 合法檔名.test(x) && x.indexOf("..") === -1;
    })
  );
}

async function 拉() {
  const 中止 = new AbortController();
  // 拿不到就算了，頁面照舊走「請從 Steam 開一次」那條路。讓它卡在這裡等，
  // 只會把一個本來就有解的狀況變成白畫面。
  const 計時 = setTimeout(function () {
    中止.abort();
  }, 逾時毫秒);
  try {
    const r = await fetch(雲端, { signal: 中止.signal, cache: "no-store" });
    if (!r.ok) return { ok: false, 為什麼: "HTTP " + r.status };
    const d = await r.json();
    if (!乾淨(d && d.bundles)) return { ok: false, 為什麼: "清單格式不對" };
    return {
      ok: true,
      bundles: d.bundles,
      discoveredAt: typeof d.discoveredAt === "string" ? d.discoveredAt : null,
      publishedAt: typeof d.publishedAt === "string" ? d.publishedAt : null,
    };
  } catch (e) {
    return { ok: false, 為什麼: String((e && e.message) || e) };
  } finally {
    clearTimeout(計時);
  }
}

chrome.runtime.onMessage.addListener(function (訊息, _寄件者, 回覆) {
  if (!訊息 || 訊息.要 !== "雲端清單") return false;
  拉().then(回覆);
  return true; // 非同步回覆，一定要回 true，不然 channel 直接關掉
});
