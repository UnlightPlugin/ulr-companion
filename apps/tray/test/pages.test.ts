import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArbiterEngine } from "@ulr/arbiter-engine";
import { describe, expect, it, vi } from "vitest";
import { registerBonusPage } from "../src/pages/bonus-page.js";
import { registerDietPage } from "../src/pages/diet-page.js";
import { registerQuestPage } from "../src/pages/quest-page.js";
import { raidDiscoverSetting, registerRaidPage } from "../src/pages/raid-page.js";
import type { Profile } from "../src/profiles-core.js";
import { defaultProfile } from "../src/profiles-core.js";
import type { IpcHandle, TrayContext } from "../src/tray-context.js";

const SRC = join(__dirname, "..", "src");

/** preload 叫的、main.ts 與 pages/*.ts 註冊的 `ulr:*` 頻道。 */
function channels(text: string, call: RegExp): string[] {
  return [...text.matchAll(call)].map((m) => m[1] as string);
}

describe("IPC 頻道（處理器從 main.ts 拆到 pages/*.ts、*-runtime.ts 之後）", () => {
  const preload = readFileSync(join(SRC, "preload.ts"), "utf8");
  // src 底下每一支都掃（處理器可能在 main.ts、pages/、web-runtime.ts…），preload 自己除外
  const mains = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && f !== "preload.ts")
    .map((f) => readFileSync(join(SRC, f), "utf8"))
    .join("\n");
  const invoked = channels(preload, /ipcRenderer\.invoke\(\s*"(ulr:[a-z-]+)"/g);
  const handled = channels(mains, /\.handle\(\s*"(ulr:[a-z-]+)"/g);

  it("preload 叫的每一個都有人接（漏搬一支的症狀是畫面上那顆鈕按了沒反應）", () => {
    expect(invoked.length).toBeGreaterThan(50);
    expect(invoked.filter((c) => !handled.includes(c))).toEqual([]);
  });

  it("沒有頻道被註冊兩次（Electron 第二次 handle 會直接 throw，托盤起不來）", () => {
    expect(handled.filter((c, i) => handled.indexOf(c) !== i)).toEqual([]);
  });
});

/** 假的 ipcMain：收下處理器，測試直接叫。 */
function fakeIpc(): { ipc: IpcHandle; call: (ch: string, ...args: unknown[]) => Promise<unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn),
  } as unknown as IpcHandle;
  return {
    ipc,
    call: async (ch, ...args) => {
      const fn = handlers.get(ch);
      if (fn === undefined) throw new Error(`沒有註冊 ${ch}`);
      return await fn({}, ...args);
    },
  };
}

function fakeCtx(): {
  ctx: TrayContext;
  engine: Record<string, ReturnType<typeof vi.fn>>;
  saved: Partial<Profile>[];
  logs: string[];
  pushes: () => number;
} {
  let profile = defaultProfile("desktop");
  const saved: Partial<Profile>[] = [];
  const logs: string[] = [];
  let pushes = 0;
  const engine: Record<string, ReturnType<typeof vi.fn>> = {};
  const engineProxy = new Proxy(engine, {
    // 方法都是回 null 的 mock；questBonusSamples 是屬性（任務頁拿來算統計）
    get: (t, k: string) => (k === "questBonusSamples" ? [] : (t[k] ??= vi.fn(async () => null))),
  });
  const ctx: TrayContext = {
    get profile() {
      return profile;
    },
    engine: engineProxy as unknown as ArbiterEngine,
    patchProfile(patch) {
      profile = { ...profile, ...patch };
      saved.push(patch);
    },
    log: (l) => void logs.push(l),
    pushState: () => void pushes++,
  };
  return { ctx, engine, saved, logs, pushes: () => pushes };
}

describe("渦那幾頁", () => {
  it("開關：改配置、推給引擎、寫記錄、推快照；回的是新的頁面狀態", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerRaidPage(ipc, f.ctx);
    const s = (await call("ulr:raid-share", false)) as { share: boolean };
    expect(s.share).toBe(false);
    expect(f.saved).toEqual([{ raidShare: false }]);
    expect(f.engine["setRaidShare"]).toHaveBeenCalledWith(false);
    expect(f.logs).toHaveLength(1);
    expect(f.pushes()).toBe(1);
  });

  it("型別不對的值不動配置（畫面送錯東西不能把設定洗掉）", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerRaidPage(ipc, f.ctx);
    await call("ulr:raid-share", "yes");
    await call("ulr:raid-reward-mode", "bogus");
    await call("ulr:raid-discover-rule", ["mc1008_02:soul"], "nuke");
    expect(f.saved).toEqual([]);
    expect(f.pushes()).toBe(0);
  });

  it("發現渦規則：改格子、keep 是刪掉那格；規則表關著推給頁面的是空表", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerRaidPage(ipc, f.ctx);
    await call("ulr:raid-discover-rule", ["mc1008_02:soul", "mc1008_02:memory"], "public");
    expect(f.ctx.profile.raidDiscoverRules).toEqual({
      "mc1008_02:soul": "public",
      "mc1008_02:memory": "public",
    });
    // 預設總開關關著：規則留在配置裡，推下去的是空的
    expect(f.engine["setRaidDiscover"]).toHaveBeenLastCalledWith({ skipOpening: false, rules: {} });
    await call("ulr:raid-discover-rules-on", true);
    expect(f.engine["setRaidDiscover"]).toHaveBeenLastCalledWith(
      raidDiscoverSetting(f.ctx.profile),
    );
    expect(raidDiscoverSetting(f.ctx.profile).rules["mc1008_02:soul"]).toBe("public");
    await call("ulr:raid-discover-rule", ["mc1008_02:soul"], "keep");
    expect(f.ctx.profile.raidDiscoverRules).toEqual({ "mc1008_02:memory": "public" });
  });

  it("打開自動刪除時，遊戲內的提示鈕也一起恢復", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    f.ctx.patchProfile({ raidAutoDelete: false, raidAutoDeletePrompt: false });
    registerRaidPage(ipc, f.ctx);
    await call("ulr:raid-auto-delete", true);
    expect(f.engine["setRaidAutoDelete"]).toHaveBeenCalledWith({ enabled: true, prompt: true });
  });
});

describe("任務／迪城／獎勵那幾頁", () => {
  it("任務：水沙與通行證各自開關；確認框的模式要是認得的", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerQuestPage(ipc, f.ctx);
    await call("ulr:quest-item-shortcut", "passes", true);
    expect(f.saved).toEqual([{ questPassShortcut: true }]);
    expect(f.engine["setQuestItemShortcut"]).toHaveBeenCalledWith("passes", true);
    await call("ulr:quest-panel", "end", "nope");
    expect(f.saved).toHaveLength(1);
  });

  it("迪城投降：推給引擎的是改完之後的整組選項", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerDietPage(ipc, f.ctx);
    await call("ulr:surrender-option", "winSkip", true);
    expect(f.engine["setBattleSurrender"]).toHaveBeenCalledWith(
      expect.objectContaining({ dietWinSkip: true }),
    );
  });

  it("獎勵：捷徑關掉時位置不動；自動爬星整份設定經過 normalize", async () => {
    const { ipc, call } = fakeIpc();
    const f = fakeCtx();
    registerBonusPage(ipc, f.ctx);
    const place = f.ctx.profile.bonusItemPlace;
    await call("ulr:bonus-mode", "off");
    expect(f.ctx.profile.bonusItemShortcut).toBe(false);
    expect(f.ctx.profile.bonusItemPlace).toBe(place);
    await call("ulr:bonus-climb", { on: true, win: { raid2Max: 99999 } });
    expect(f.ctx.profile.bonusClimb.on).toBe(true);
    expect(f.ctx.profile.bonusClimb.win.raid2Max).toBeLessThanOrEqual(500);
    expect(f.logs.at(-1)).toContain("自動爬星開啟");
  });
});
