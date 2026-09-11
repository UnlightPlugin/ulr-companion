import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserDebugPort,
  browserProfileDir,
  buildBrowserArgs,
  findBrowser,
} from "../src/browser.js";

const PROFILE = "C:\\Users\\someone\\ulr-cdp-profile";

describe("buildBrowserArgs", () => {
  const args = buildBrowserArgs({ port: 9334, profileDir: PROFILE });

  it("一定要帶 --user-data-dir", () => {
    // 少了它，玩家已經開著 Chrome 時新的實例不會誕生，命令列參數整個被忽略，
    // port 不會開 —— 而且看起來像 Chrome 忽略了 --remote-debugging-port。
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
  });

  it("帶上指定的 debug port", () => {
    expect(args).toContain("--remote-debugging-port=9334");
  });

  it("開在 about:blank，不是遊戲網址", () => {
    // 外殼注入用的是 addScriptToEvaluateOnNewDocument，只對之後載入的 document
    // 生效。啟動時就導過去的話注入永遠來不及，症狀是「分頁開了但停在 403」。
    expect(args.at(-1)).toBe("about:blank");
    expect(args.join(" ")).not.toContain("playunlight");
  });

  it("玩家的偏好接在 about:blank 之前", () => {
    const withPref = buildBrowserArgs({
      port: 9334,
      profileDir: PROFILE,
      extraArgs: ["--force-device-scale-factor=1.5"],
    });
    expect(withPref).toContain("--force-device-scale-factor=1.5");
    expect(withPref.at(-1)).toBe("about:blank");
  });

  it("不含任何身分資訊", () => {
    // steamid 只出現在 openGameTab 導向的網址上。啟動參數會進工作管理員、
    // 也會被其他程序讀到，§12 不得外洩。
    expect(args.join(" ")).not.toMatch(/765611\d+/);
  });
});

describe("findBrowser", () => {
  /** 在暫存目錄裡假造一個瀏覽器，這樣測試不依賴這台機器裝了什麼。 */
  function fakeInstall(rel: string): string {
    const root = mkdtempSync(join(tmpdir(), "ulr-browser-"));
    const exe = join(root, rel);
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    return root;
  }

  it("找得到 Chrome", () => {
    const rel = "Google\\Chrome\\Application\\chrome.exe";
    const root = fakeInstall(rel);
    const found = findBrowser({ ProgramFiles: root } as NodeJS.ProcessEnv);
    expect(found?.name).toBe("Chrome");
    // ⚠ 期望值要跟 findBrowser 一樣用 join(root, rel) 組，不能拆成四段再 join：
    // CI 跑在 Linux，那裡反斜線不是分隔符，拆段 join 出來的是 `/`、findBrowser
    // 拿到的是原樣的 `\`，兩者永遠不相等。Windows 上兩種寫法結果一樣。
    expect(found?.path).toBe(join(root, rel));
  });

  it("兩個都在時 Chrome 優先於 Edge", () => {
    // 順序不是隨便排的：擴充功能與書籤都裝在 Chrome 的 profile 裡，
    // 換一個瀏覽器等於換一份空 profile。
    const chrome = fakeInstall("Google\\Chrome\\Application\\chrome.exe");
    const edge = fakeInstall("Microsoft\\Edge\\Application\\msedge.exe");
    const found = findBrowser({
      ProgramFiles: chrome,
      "ProgramFiles(x86)": edge,
    } as NodeJS.ProcessEnv);
    expect(found?.name).toBe("Chrome");
  });

  it("⚠ 指名 edge 時只找 Edge，不會退而求其次拿 Chrome", () => {
    // 沉默地換掉玩家指名的瀏覽器比報錯糟得多：他的 profile、書籤、登入的帳號
    // 全都不是他要的那些，而畫面上只會寫「已開 Chrome」。
    const chrome = fakeInstall("Google\\Chrome\\Application\\chrome.exe");
    const edge = fakeInstall("Microsoft\\Edge\\Application\\msedge.exe");
    const env = { ProgramFiles: chrome, "ProgramFiles(x86)": edge } as NodeJS.ProcessEnv;
    expect(findBrowser(env, "edge")?.name).toBe("Edge");
    expect(findBrowser(env, "edge")?.family).toBe("edge");
    expect(findBrowser(env, "chrome")?.name).toBe("Chrome");
    // 那一族沒裝就回 null（呼叫端報錯），不是拿另一族頂替。
    expect(findBrowser({ ProgramFiles: chrome } as NodeJS.ProcessEnv, "edge")).toBeNull();
  });

  it("Brave 算 chrome 這一族 —— 它是備援，不是玩家會去挑的選項", () => {
    const brave = fakeInstall("BraveSoftware\\Brave-Browser\\Application\\brave.exe");
    const found = findBrowser({ ProgramFiles: brave } as NodeJS.ProcessEnv, "chrome");
    expect(found?.name).toBe("Brave");
    expect(found?.family).toBe("chrome");
  });

  it("Chrome 與 Edge 的 profile 目錄與首選埠一定要不同", () => {
    // 共用的話：後開的瀏覽器只會在前一個裡開分頁（--remote-debugging-port
    // 整個被忽略），而埠回退會從同一個 DevToolsActivePort 讀 —— Edge 那份
    // 配置於是接到 Chrome 的遊戲去，畫面上完全看不出來。
    expect(browserProfileDir("edge")).not.toBe(browserProfileDir("chrome"));
    expect(browserDebugPort("edge")).not.toBe(browserDebugPort("chrome"));
    // 不給就是 Chrome 那一份（舊行為）。
    expect(browserProfileDir()).toBe(browserProfileDir("chrome"));
    expect(browserDebugPort()).toBe(browserDebugPort("chrome"));
  });

  it("環境變數全空時回 null，不是丟例外", () => {
    // 找不到瀏覽器是可以降級的情況（玩家可以用 --browser 指定），
    // 不該讓整個指令在這裡炸掉。
    expect(findBrowser({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("路徑指向不存在的檔案時不算找到", () => {
    expect(findBrowser({ ProgramFiles: join(tmpdir(), "nope-1a2b3c") } as NodeJS.ProcessEnv)).toBe(
      null,
    );
  });
});
