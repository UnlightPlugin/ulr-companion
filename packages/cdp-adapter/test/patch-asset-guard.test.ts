/**
 * 開機資料檔的防護
 *
 * 照 2026-09-13 實機：Cloudflare 對 event_asset.json 回 409，Phaser 不進快取，
 * EventData.eventJSON 一直是 undefined → 牌組編輯 create() 丟例外。
 *
 * 假環境：
 *   game.scene.keys.Initialize.sys.settings.status（5 以上＝create 跑過了）
 *   game.cache.json（exists / get / add）
 *   webpackChunk 陣列：push 時回呼 __webpack_require__，m 裡有 unlight-common 那一支，
 *   匯出名是壓縮過的（RV / d1 / Al）
 *   performance.getEntriesByType("resource")：失敗的那支也留著網址
 *
 * 要抓的：
 * 1. Initialize 還沒跑完不動手（開機中快取本來就是空的）
 * 2. 缺的補抓、進快取、EventData.init 重新餵；靠 init 原始碼認人，不靠匯出名
 * 3. cc_asset 要跟 charaProfile 一起才 initChara
 * 4. 全部補齊就停輪詢；抓不到重試到上限才回報失敗
 */

import { describe, expect, it } from "vitest";
import {
  ASSET_GUARD_UNINSTALL_EXPRESSION,
  buildAssetGuardPatchScript,
  GAME_DATA_FILES,
  isAssetRepairReport,
  parseAssetGuardStatus,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";
const BASE = "https://assets.example/";

interface Env {
  window: Record<string, unknown>;
  cache: Map<string, unknown>;
  reports: Record<string, unknown>[];
  inits: string[];
  fetches: string[];
  status: { value: number };
  tick: () => void;
  flush: () => Promise<void>;
  cleared: { value: boolean };
  run: (expr: string) => string;
}

function setup(opts: { missing: string[]; fetchStatus?: (url: string) => number }): Env {
  const cache = new Map<string, unknown>();
  for (const f of GAME_DATA_FILES)
    if (!opts.missing.includes(f.key)) cache.set(f.key, { from: "boot" });
  const inits: string[] = [];
  const status = { value: 5 };
  // unlight-common 的靜態表：匯出名壓縮過，只能看 init 的原始碼
  const EventData = {
    eventJSON: undefined as unknown,
    init: function (eventJSON: unknown) {
      EventData.eventJSON = eventJSON;
      inits.push("event");
    },
  };
  const AvatarItem = {
    init: function (itemJSON: unknown) {
      void itemJSON;
      inits.push("item");
    },
  };
  const Chara = {
    initChara: (a: unknown, p: unknown) =>
      void inits.push(`chara:${a !== undefined}:${p !== undefined}`),
    initMons: () => void inits.push("mons"),
  };
  const commonExports = {
    RV: EventData,
    d1: AvatarItem,
    Al: Chara,
    WX: { init: (c: unknown) => c },
  };
  const modules: Record<string, unknown> = {
    "100": function other() {
      return "nothing";
    },
    "12919": function common() {
      return "__webpack_exports__EventData";
    },
  };
  const req = Object.assign((id: string) => (id === "12919" ? commonExports : {}), { m: modules });
  const chunk: unknown[] = [];
  (chunk as { push: (x: unknown) => number }).push = (entry: unknown) => {
    (entry as [unknown, unknown, (r: unknown) => void])[2](req);
    return 0;
  };
  const game = {
    scene: { keys: { Initialize: { sys: { settings: { status: 0 } } } } },
    cache: {
      json: {
        exists: (k: string) => cache.has(k),
        get: (k: string) => cache.get(k),
        add: (k: string, v: unknown) => void cache.set(k, v),
      },
    },
  };
  Object.defineProperty(game.scene.keys.Initialize.sys.settings, "status", {
    get: () => status.value,
  });
  const reports: Record<string, unknown>[] = [];
  const window: Record<string, unknown> = {
    game,
    webpackChunkclient: chunk,
    [BINDING]: (p: string) => reports.push(JSON.parse(p)),
  };
  const fetches: string[] = [];
  const pending: Promise<unknown>[] = [];
  const fakeFetch = (url: string) => {
    fetches.push(url);
    const code = opts.fetchStatus?.(url) ?? 200;
    const p = Promise.resolve({
      ok: code === 200,
      status: code,
      json: () => Promise.resolve({ from: "repair", url }),
    });
    pending.push(p);
    return p;
  };
  const performance = {
    getEntriesByType: () => [
      { name: `${BASE}images/assets/lobby/lobby_bg.png` },
      { name: `${BASE}images/assets/data/event_asset.json` },
    ],
  };
  let poll: (() => void) | null = null;
  const cleared = { value: false };
  const run = (expr: string): string => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "window",
      "setInterval",
      "clearInterval",
      "fetch",
      "performance",
      `return ${expr};`,
    ) as (...a: unknown[]) => string;
    return fn(
      window,
      (cb: () => void) => {
        poll = cb;
        cleared.value = false;
        return 1;
      },
      () => {
        cleared.value = true;
      },
      fakeFetch,
      performance,
    );
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all(pending);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return {
    window,
    cache,
    reports,
    inits,
    fetches,
    status,
    tick: () => poll?.(),
    flush,
    cleared,
    run,
  };
}

describe("開機資料檔的防護", () => {
  it("Initialize 還沒跑完不動手", async () => {
    const env = setup({ missing: ["event_info"] });
    env.status.value = 4;
    const st = parseAssetGuardStatus(env.run(buildAssetGuardPatchScript({ bindingName: BINDING })));
    expect(st.installed).toBe(true);
    expect(st.missing).toEqual([]);
    await env.flush();
    expect(env.fetches).toEqual([]);
  });

  it("event_info 沒載成：補抓進快取、EventData 重新餵、回報，補齊就停", async () => {
    const env = setup({ missing: ["event_info"] });
    const st = parseAssetGuardStatus(env.run(buildAssetGuardPatchScript({ bindingName: BINDING })));
    expect(st.missing).toEqual(["event_info"]);
    await env.flush();
    // 用瀏覽器當初抓那支的網址（失敗的也會留紀錄）
    expect(env.fetches).toEqual([`${BASE}images/assets/data/event_asset.json`]);
    expect(env.cache.get("event_info")).toMatchObject({ from: "repair" });
    expect(env.inits).toEqual(["event"]);
    expect(env.reports.filter(isAssetRepairReport)).toEqual([
      { type: "asset-repair", key: "event_info", ok: true, reinit: true, reason: null },
    ]);
    env.tick();
    expect(env.cleared.value).toBe(true);
  });

  it("沒有失敗紀錄的檔：拿任一支資產的前綴拼網址；cc_asset 要等 charaProfile 也在才 initChara", async () => {
    const env = setup({ missing: ["cc_asset", "charaProfile", "quest"] });
    env.run(buildAssetGuardPatchScript({ bindingName: BINDING }));
    await env.flush();
    expect(env.fetches.sort()).toEqual(
      [
        `${BASE}images/assets/data/cc_asset.json`,
        `${BASE}images/assets/data/charaProfile.json`,
        `${BASE}images/assets/data/quest.json`,
      ].sort(),
    );
    // 第一支回來時另一支還沒到 → 不餵；第二支回來才餵，而且兩個參數都在
    expect(env.inits).toEqual(["chara:true:true"]);
    const ok = env.reports.filter(isAssetRepairReport);
    expect(ok.map((r) => r.key).sort()).toEqual(["cc_asset", "charaProfile", "quest"]);
    expect(ok.find((r) => r.key === "quest")!.reinit).toBe(false);
  });

  it("一直抓不到：重試到上限才回報失敗，不會無限打", async () => {
    const env = setup({ missing: ["event_info"], fetchStatus: () => 409 });
    env.run(buildAssetGuardPatchScript({ bindingName: BINDING, maxAttempts: 3 }));
    await env.flush();
    for (let i = 0; i < 6; i++) {
      env.tick();
      await env.flush();
    }
    expect(env.fetches.length).toBe(3);
    expect(env.reports.filter(isAssetRepairReport)).toEqual([
      { type: "asset-repair", key: "event_info", ok: false, reinit: false, reason: "HTTP 409" },
    ]);
    expect(env.cache.has("event_info")).toBe(false);
  });

  it("拆掉只停輪詢", () => {
    const env = setup({ missing: [] });
    env.run(buildAssetGuardPatchScript({ bindingName: BINDING }));
    expect(env.run(ASSET_GUARD_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(env.window["__ulrAssetGuard"]).toBeUndefined();
    expect(env.run(ASSET_GUARD_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });
});
