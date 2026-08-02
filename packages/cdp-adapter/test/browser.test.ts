import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrowserArgs, findBrowser } from "../src/browser.js";

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
    const root = fakeInstall("Google\\Chrome\\Application\\chrome.exe");
    const found = findBrowser({ ProgramFiles: root } as NodeJS.ProcessEnv);
    expect(found?.name).toBe("Chrome");
    expect(found?.path).toBe(join(root, "Google", "Chrome", "Application", "chrome.exe"));
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
