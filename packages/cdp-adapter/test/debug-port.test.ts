/**
 * 埠解析
 * ========
 * 這一整包的存在理由是 2026-08-16 那個「Chrome 帶著參數在跑，但沒有人聽那個埠」
 * 的事故。測試要釘住的是**回退不能亂救**：救錯客戶端比救不到更糟。
 */

import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopUserDataDir,
  DEVTOOLS_ACTIVE_PORT_FILE,
  explainDebugPort,
  probePortState,
  readDevToolsActivePort,
  resolveDebugPort,
} from "../src/debug-port.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function userDataDir(devToolsActivePort?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ulr-udd-"));
  dirs.push(dir);
  if (devToolsActivePort !== undefined) {
    writeFileSync(join(dir, DEVTOOLS_ACTIVE_PORT_FILE), devToolsActivePort, "utf8");
  }
  return dir;
}

/** 假裝某個埠上有 debug server。回傳的 fetch 只認這些埠。 */
function fetchAnswering(...ports: number[]): typeof fetch {
  return (async (input: unknown) => {
    const url = new URL(String(input));
    if (!ports.includes(Number(url.port))) throw new Error("ECONNREFUSED");
    return {
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${url.port}/devtools/browser/x` }),
    };
  }) as unknown as typeof fetch;
}

describe("readDevToolsActivePort", () => {
  it("讀第一行的埠（第二行是 ws path，不能一起吃進來）", () => {
    expect(
      readDevToolsActivePort(userDataDir("59223\n/devtools/browser/d264be60-582e-4f6a\n")),
    ).toBe(59223);
  });

  it("沒有那個檔就回 null —— 客戶端沒開、或它根本沒開 debug port", () => {
    expect(readDevToolsActivePort(userDataDir())).toBeNull();
  });

  it("內容壞掉時回 null，不是丟例外或回 NaN", () => {
    // 這個檔是 Chromium 寫的，但它當掉在寫到一半也是可能的。
    expect(readDevToolsActivePort(userDataDir("\n/devtools/browser/x"))).toBeNull();
    expect(readDevToolsActivePort(userDataDir("不是數字"))).toBeNull();
    expect(readDevToolsActivePort(userDataDir("70000"))).toBeNull();
    expect(readDevToolsActivePort(userDataDir("0"))).toBeNull();
  });
});

describe("probePortState", () => {
  it("沒人用的埠是 free", async () => {
    // 借一個現在確定綁得上的埠再放掉 —— 寫死埠號正是這個檔案要防的病。
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probePortState(port)).toBe("free");
  });

  it("有人在聽的埠是 in-use，不是 blocked", async () => {
    // 這兩個要分得開：in-use 是「可能就是遊戲」，blocked 是「換埠才有救」。
    const server = createServer();
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    expect(await probePortState(port)).toBe("in-use");
  });
});

describe("resolveDebugPort", () => {
  it("設定裡的埠有回應、檔案講的也是同一個 → 用設定值", async () => {
    const dir = userDataDir("59222");
    expect(
      await resolveDebugPort({ port: 59222, userDataDir: dir, fetchImpl: fetchAnswering(59222) }),
    ).toEqual({ port: 59222, source: "configured" });
  });

  it("沒有 DevToolsActivePort 檔時，設定的埠有回應就用它", async () => {
    const dir = userDataDir();
    expect(
      await resolveDebugPort({ port: 59222, userDataDir: dir, fetchImpl: fetchAnswering(59222) }),
    ).toEqual({ port: 59222, source: "configured" });
  });

  it("⚠ 兩個埠都活著且不一樣時，要選檔案那個 —— 設定的那個必然是別人的程式", async () => {
    // 這條防的是最惡毒的失敗：接得上、握手成功、但那上面永遠不會有遊戲分頁，
    // 症狀只是「一直卡在等遊戲…」。9222 被 Adobe UXP 佔走就是這個形狀，
    // 而建議玩家用 --remote-debugging-port=0 之後風險更高（設定值我們自己不用）。
    const dir = userDataDir("40000");
    expect(
      await resolveDebugPort({
        port: 59222,
        userDataDir: dir,
        fetchImpl: fetchAnswering(59222, 40000),
      }),
    ).toEqual({ port: 40000, source: "devtools-file" });
  });

  it("檔案是舊的（那個埠死了）但設定的埠活著 → 用設定值", async () => {
    const dir = userDataDir("40000");
    expect(
      await resolveDebugPort({ port: 59222, userDataDir: dir, fetchImpl: fetchAnswering(59222) }),
    ).toEqual({ port: 59222, source: "configured" });
  });

  it("設定的埠沒回應時，改用客戶端自己記下的埠", async () => {
    const dir = userDataDir("40000");
    expect(
      await resolveDebugPort({ port: 59223, userDataDir: dir, fetchImpl: fetchAnswering(40000) }),
    ).toEqual({ port: 40000, source: "devtools-file" });
  });

  it("檔案裡的埠也沒回應就回 null —— 當掉留下的舊檔不能拿來連", async () => {
    // Chromium 正常結束會刪掉這個檔，當掉不會。信它而不驗證的話，
    // 我們會去連一個早就換人用的埠。
    const dir = userDataDir("40000");
    expect(
      await resolveDebugPort({ port: 59223, userDataDir: dir, fetchImpl: fetchAnswering() }),
    ).toBeNull();
  });

  it("⚠ 沒給 user-data-dir 就不回退 —— 寧可連不上，也不要接到另一個客戶端", async () => {
    // 這是整個檔案最重要的一條。不分種類地亂找，症狀會是「我開的是網頁版的
    // 插件，它卻接到桌面版的遊戲去」，而且兩邊看起來都正常。
    expect(await resolveDebugPort({ port: 59223, fetchImpl: fetchAnswering(40000) })).toBeNull();
  });
});

describe("explainDebugPort", () => {
  /** 開一個真的在聽的 socket，拿它當「別的程式佔走了」。 */
  async function occupied(): Promise<number> {
    const server = createServer();
    servers.push(server);
    return await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
  }

  it("有別的程式在聽、但不是 CDP → 說被佔用，並告訴玩家怎麼查是誰", async () => {
    const port = await occupied();
    const msg = await explainDebugPort({ port, fetchImpl: fetchAnswering() });
    expect(msg).toContain("已經被別的程式佔用");
    expect(msg).toContain("Get-NetTCPConnection");
    // ⚠ 不能叫玩家去開遊戲 —— 遊戲開一百次也不會拿到這個埠。
    expect(msg).not.toContain("遊戲開了沒");
  });

  it("在聽的是另一個 Chromium → 講出它是誰，並說再等也不會變成遊戲", async () => {
    const port = await occupied();
    const asChromium = (async () => ({
      ok: true,
      json: async () => ({ Browser: "Electron/32.1.2" }),
    })) as unknown as typeof fetch;
    const msg = await explainDebugPort({ port, fetchImpl: asChromium });
    expect(msg).toContain("Electron/32.1.2");
    expect(msg).toContain("換一個埠");
  });

  it("沒人在聽 → 講「遊戲開了沒」，不要叫玩家換埠", async () => {
    // 這是最常見的狀況（玩家先開插件再開遊戲）。這裡講錯話的代價最大：
    // 叫他去改一個本來就正確的設定。
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    await new Promise<void>((r) => server.close(() => r()));

    const msg = await explainDebugPort({ port, fetchImpl: fetchAnswering() });
    expect(msg).toContain("沒有人在聽");
    expect(msg).toContain("遊戲開了沒");
    expect(msg).not.toContain("換一個埠");
  });

  it("客戶端記的埠是舊的 → 叫玩家重開遊戲，不是換埠", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });
    await new Promise<void>((r) => server.close(() => r()));

    const msg = await explainDebugPort({
      port,
      userDataDir: userDataDir("40000"),
      fetchImpl: fetchAnswering(),
    });
    expect(msg).toContain(":40000");
    expect(msg).toContain("完全關掉再開");
  });
});

describe("desktopUserDataDir", () => {
  it("跟著 APPDATA 走，不寫死 C:\\Users", () => {
    expect(desktopUserDataDir({ APPDATA: "D:\\Roaming" } as NodeJS.ProcessEnv)).toBe(
      join("D:\\Roaming", "UNLIGHT-Revive"),
    );
  });
});
