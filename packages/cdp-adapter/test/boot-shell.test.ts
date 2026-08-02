import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildBookmarklet,
  buildBookmarkUrl,
  buildBootShellScript,
  buildExtensionFiles,
  InvalidBundleError,
  isCompleteBundleSet,
  parseDiscoveredBundles,
} from "../src/boot-shell.js";
import { GAME_ORIGIN, GAME_PORTS } from "../src/constants.js";

const BUNDLES = [
  "client/runtime.0e89562b7d68d7d0099f.js",
  "client/unlight-common.bbd5306bbd9422708666.js",
  "client/main.42c288379d1657883b4c.js",
];

describe("parseDiscoveredBundles", () => {
  it("收下正常的清單並保持順序", () => {
    // 順序就是載入順序：runtime 必須先於 common 先於 main。
    expect(parseDiscoveredBundles(BUNDLES)).toEqual(BUNDLES);
  });

  it("也吃 JSON 字串（頁面是用 returnByValue 送回來的）", () => {
    expect(parseDiscoveredBundles(JSON.stringify(BUNDLES))).toEqual(BUNDLES);
  });

  it("擋掉會跳出同源的路徑", () => {
    // 相對路徑會被當成同源資源載入，允許跳脫等於允許載入任意來源的程式碼。
    for (const bad of ["client/../../evil.js", "/client/main.js", "https://evil.example/main.js"]) {
      expect(() => parseDiscoveredBundles([bad])).toThrow(InvalidBundleError);
    }
  });

  it("擋掉不在 client/ 底下的東西", () => {
    expect(() => parseDiscoveredBundles(["assets/main.js"])).toThrow(InvalidBundleError);
  });

  it("擋掉載到一半的清單", () => {
    // 2026-08-02 的實際事故：只有 runtime 的清單被存進擴充功能的 storage，
    // 之後每次用書籤開都只載到 runtime，畫面全白且看不出哪裡壞了。
    // 來源是「被重建過的頁面」—— 重建是一個一個非同步接 script 的。
    expect(() => parseDiscoveredBundles(BUNDLES.slice(0, 1))).toThrow(InvalidBundleError);
    expect(() => parseDiscoveredBundles(BUNDLES.slice(0, 2))).toThrow(InvalidBundleError);
    expect(() => parseDiscoveredBundles(BUNDLES.slice(0, 1))).toThrow(/main\./);
  });

  it("有 main. 就算完整，不看數量", () => {
    // 判準是載入順序的最後一個到齊，不是「剛好三個」—— 數量是會變的實作細節。
    expect(isCompleteBundleSet(BUNDLES)).toBe(true);
    expect(isCompleteBundleSet(["client/main.abc.js"])).toBe(true);
    expect(isCompleteBundleSet(["client/runtime.abc.js"])).toBe(false);
    expect(isCompleteBundleSet([])).toBe(false);
  });

  it("空清單要當成錯誤，不是空集合", () => {
    // 分頁還沒載完或根本不是遊戲頁時會讀到空的。默默存起來會讓之後每次
    // 開遊戲都是白畫面，而且看不出哪裡壞了。
    expect(() => parseDiscoveredBundles([])).toThrow(InvalidBundleError);
  });

  it("擋掉非陣列與非字串元素", () => {
    expect(() => parseDiscoveredBundles({})).toThrow(InvalidBundleError);
    expect(() => parseDiscoveredBundles([123])).toThrow(InvalidBundleError);
  });
});

describe("buildBootShellScript", () => {
  const script = buildBootShellScript({ bundles: BUNDLES });

  it("產生的是語法正確的 JS", () => {
    // 只編譯不執行 —— 語法錯誤在這裡就會炸，而且不必真的跑起來。
    expect(() => new Script(script)).not.toThrow();
  });

  it("bundle 檔名是以資料嵌入，不是拼進程式碼", () => {
    // 走 JSON.parse 而不是物件字面值：外部資料不該有辦法碰到原型。
    expect(script).toContain("JSON.parse(");
    for (const b of BUNDLES) expect(script).toContain(b);
  });

  it("不含任何 steamid —— 身分一律從網址讀", () => {
    // 這是產出物可以安心分享的前提。
    expect(script).toContain('params.get("steamid")');
    expect(script).not.toMatch(/765611\d{11}/);
  });

  it("沒有 steamid 的頁面直接跳過", () => {
    // 注入掛在整個 target 上，玩家其他分頁也會跑到這段。
    expect(script).toContain("if (!authString) return;");
  });

  it("伺服器有正常吐頁面時不動手", () => {
    // 正常 Steam 流程開的分頁也會跑到注入，重建會把載好的遊戲砍掉重來。
    expect(script).toContain("alreadyServed");
    expect(script).toContain('script[src*="/client/"]');
  });

  it("有重複執行的閘", () => {
    expect(script).toContain("__ulrBootShell");
  });

  it("allowPortRedirect=false 時不會自己導向", () => {
    // bookmarklet 用的模式：導向會把它的執行環境整個換掉。
    const manual = buildBootShellScript({ bundles: BUNDLES, allowPortRedirect: false });
    expect(manual).toContain('"allowPortRedirect\\":false');
  });

  it("壞掉的 bundle 清單不會產生腳本", () => {
    expect(() => buildBootShellScript({ bundles: ["../evil.js"] })).toThrow(InvalidBundleError);
  });
});

describe("buildBookmarkUrl", () => {
  it("帶 port，落在遊戲的範圍內", () => {
    // 不帶 port 會拿到 403，而 bookmarklet 沒辦法在導向後自己再跑一次。
    for (let i = 0; i < 50; i++) {
      const url = new URL(buildBookmarkUrl("76561199854644708", GAME_ORIGIN));
      const port = Number(url.port);
      expect(port).toBeGreaterThanOrEqual(GAME_PORTS.quest[0]);
      expect(port).toBeLessThanOrEqual(GAME_PORTS.quest[1]);
    }
  });

  it("指定 port 就用指定的", () => {
    const url = new URL(buildBookmarkUrl("123", GAME_ORIGIN, 14017));
    expect(url.port).toBe("14017");
    expect(url.searchParams.get("steamid")).toBe("123");
  });
});

describe("buildBookmarklet", () => {
  it("是 javascript: 開頭而且經過編碼", () => {
    const b = buildBookmarklet(BUNDLES);
    expect(b.startsWith("javascript:")).toBe(true);
    expect(b).not.toContain(" ");
    expect(decodeURIComponent(b.slice("javascript:".length))).toContain("__ulrBootShell");
  });
});

describe("buildBootShellScript（dataset 模式）", () => {
  const script = buildBootShellScript({ bundlesSource: "dataset" });

  it("不必給 bundles 也能產生", () => {
    // 擴充功能打包時還不知道檔名 —— 那是執行期才從 chrome.storage 讀出來的。
    expect(() => new Script(script)).not.toThrow();
  });

  it("檔名從 dataset 讀，不是嵌進去的", () => {
    expect(script).toContain("document.documentElement.dataset.ulrBundles");
    for (const b of BUNDLES) expect(script).not.toContain(b);
  });

  it("讀不到檔名時不動頁面", () => {
    // 清空 body 卻沒東西可載，只會留下白畫面，比原本的 403 更難懂。
    expect(script).toContain("if (BUNDLES.length === 0) return;");
  });
});

describe("buildExtensionFiles", () => {
  const files = buildExtensionFiles();

  it("四個檔案都在", () => {
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "content.js",
      "manifest.json",
      "shell.js",
    ]);
  });

  it("說明是 Windows 上雙擊就打得開的純文字", () => {
    // .md 在 Windows 沒有預設程式，雙擊會跳「要用什麼開啟」。
    // 而且既然不會被算繪，就不該留 Markdown 語法。
    const readme = files["README.txt"] ?? "";
    expect(readme.startsWith("﻿")).toBe(true); // BOM：中文才不會變亂碼
    expect(readme).toContain("\r\n"); // CRLF：舊記事本才不會擠成一行
    expect(readme).not.toMatch(/^#{1,6} /m); // 沒有 Markdown 標題
    expect(readme).not.toContain("```");
  });

  it("說明涵蓋安裝、第一次使用、更新後怎麼辦", () => {
    // 說明要跟著產物走 —— 別人拿到資料夾就該知道怎麼用，不必回頭問。
    const readme = files["README.txt"] ?? "";
    expect(readme).toContain("開發人員模式");
    expect(readme).toContain("載入未封裝項目");
    expect(readme).toContain("先從 Steam 正常開一次遊戲");
    expect(readme).toContain("開啟 Steam 更新");
    expect(readme).toContain("chrome.storage.local");
  });

  it("說明不宣稱能偵測過期", () => {
    // 舊版檔案伺服器不會刪，所以真的過期也不會報錯。說明必須講清楚，
    // 不能讓人以為沒看到黃條就代表是最新版。
    const readme = files["README.txt"] ?? "";
    expect(readme).toContain("沒辦法真正偵測版本過期");
    expect(readme).toContain("沒看到黃條不代表你一定是最新版");
  });

  it("manifest 是 MV3，content script 在 document_start", () => {
    const manifest = JSON.parse(files["manifest.json"] ?? "") as {
      manifest_version: number;
      permissions: string[];
      content_scripts: { run_at: string; matches: string[]; js: string[] }[];
      web_accessible_resources: { resources: string[] }[];
    };
    expect(manifest.manifest_version).toBe(3);
    // storage 是自我更新的前提：從 Steam 頁面記下的檔名要存得住。
    expect(manifest.permissions).toContain("storage");

    const cs = manifest.content_scripts[0];
    expect(cs?.run_at).toBe("document_start");
    expect(cs?.js).toEqual(["content.js"]);
    // Chrome 的 match pattern 不比對 port，這條要涵蓋 14012~14021 全部。
    expect(cs?.matches).toEqual(["https://www.playunlight.online/*"]);

    // shell.js 要能被頁面用 <script src> 載入。
    expect(manifest.web_accessible_resources[0]?.resources).toEqual(["shell.js"]);
  });

  it("content script 不宣告 MAIN world", () => {
    // 反過來才對：MAIN world 裡沒有 chrome.* API，讀不到 storage。
    // 所以 content.js 跑在 isolated world，再用 <script src> 注入 shell.js。
    const manifest = JSON.parse(files["manifest.json"] ?? "") as {
      content_scripts: Record<string, unknown>[];
    };
    expect(manifest.content_scripts[0]?.["world"]).toBeUndefined();
  });

  it("content.js 會在真頁面上記錄、在 403 上重建", () => {
    const content = files["content.js"] ?? "";
    expect(content).toContain("chrome.storage.local.set");
    expect(content).toContain("chrome.storage.local.get");
    expect(content).toContain("chrome.runtime.getURL");
    expect(() => new Script(content)).not.toThrow();
  });

  it("過期提示措辭保守 —— 不宣稱驗證過", () => {
    // 舊 bundle 伺服器不會刪，所以我們無法確認是否過期，只能依部署時程推算。
    const content = files["content.js"] ?? "";
    expect(content).toContain("可能是舊版");
    expect(content).toContain("無法確認");
  });

  it("shell.js 是 dataset 模式的外殼腳本", () => {
    expect(files["shell.js"]).toContain("__ulrBootShell");
    expect(files["shell.js"]).toContain("dataset.ulrBundles");
  });

  it("用按鈕觸發 steam://，不是自動導向", () => {
    // 瀏覽器對外部協定強制要求 user gesture。沒有點擊會被靜默吞掉，
    // 那比要求按一下更糟 —— 使用者會以為壞了。
    const content = files["content.js"] ?? "";
    expect(content).toContain("steam://rungameid/3247080");
    expect(content).toContain('btn.addEventListener("click"');
  });

  it("檔案清單一更新就自己重載", () => {
    // 遊戲在另一個分頁載入、由那邊記下檔名；這個分頁要自己跟上。
    const content = files["content.js"] ?? "";
    expect(content).toContain("chrome.storage.onChanged.addListener");
    expect(content).toContain("location.reload()");
  });

  it("身分也記進 storage —— 書籤才不必寫死 steamid", () => {
    // 這是「別人也能用」的關鍵：多數人不知道自己的 SteamID64 在哪裡找。
    const content = files["content.js"] ?? "";
    expect(content).toContain("auth: urlAuth");
    expect(content).toContain("dataset[CFG.authDatasetKey]");
  });

  it("產生的檔案不含任何本機資訊", () => {
    // 三個檔案要能原封不動給別人用：不能有路徑、profile 或任何人的 steamid。
    for (const [name, content] of Object.entries(files)) {
      expect(name + ":" + content).not.toMatch(/[A-Z]:\\\\|ulr-cdp-profile|765611\d{11}/);
    }
  });

  it("等不到更新時會提示桌面版的可能", () => {
    // 啟用桌面版客戶端時遊戲不經過瀏覽器，這條路收不到檔案清單。
    // 用「客戶端型態」描述，不要提到任何切換腳本的檔名 —— 那些是社群各自
    // 放的，命名不一，別人的機器上不會有。
    const content = files["content.js"] ?? "";
    expect(content).toContain("桌面版客戶端");
    expect(content).not.toMatch(/換名|\.bat/);
  });
});
