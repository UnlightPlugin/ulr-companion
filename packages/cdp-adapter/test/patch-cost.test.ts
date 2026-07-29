/**
 * 注入腳本的測試
 * ================
 * 這裡不是只檢查產生出來的字串長什麼樣 —— 那種測試只會鎖住排版。
 * 這裡把腳本**真的跑起來**：用 `node:vm` 建一個假頁面，塞一個假的 Phaser，
 * 然後觸發 `onProcess`，檢查 COST 有沒有被改到、回報對不對。
 *
 * 用 `node:vm` 而不是 `eval` / `new Function`：後兩者被 ESLint 擋掉（§12），
 * 而且 vm 的 context 是乾淨隔離的，可以順便驗證「腳本有沒有污染原型」。
 */

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { CostPatchApplied, CostPatchReport } from "@ulr/cdp-adapter";
import {
  buildCostPatchScript,
  InvalidCostOverrideError,
  isCostPatchReport,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

interface FakeFile {
  key: string;
  data: unknown;
  onProcess(): void;
}

interface FakePage {
  window: Record<string, unknown>;
  reports: CostPatchReport[];
  /** 原始 onProcess 被呼叫時記下 key，用來確認我們沒有把遊戲的邏輯吃掉。 */
  originalCalls: string[];
  makeFile(key: string, data: unknown): FakeFile;
  installPhaser(): void;
}

function createFakePage(): FakePage {
  const reports: CostPatchReport[] = [];
  const originalCalls: string[] = [];

  function OriginalJSONFile(this: FakeFile): void {}
  OriginalJSONFile.prototype.onProcess = function (this: FakeFile): void {
    originalCalls.push(this.key);
  };

  const window: Record<string, unknown> = {
    [BINDING]: (payload: string) => {
      const parsed: unknown = JSON.parse(payload);
      if (isCostPatchReport(parsed)) reports.push(parsed);
    },
  };

  const page: FakePage = {
    window,
    reports,
    originalCalls,
    installPhaser() {
      window["Phaser"] = { Loader: { FileTypes: { JSONFile: OriginalJSONFile } } };
    },
    makeFile(key, data) {
      const file = Object.create(OriginalJSONFile.prototype) as FakeFile;
      file.key = key;
      file.data = data;
      return file;
    },
  };
  return page;
}

/** 跑腳本，等它把 hook 掛上去（或等到放棄）。 */
async function runScript(page: FakePage, script: string, waitMs = 300): Promise<void> {
  const sandbox = { window: page.window, setInterval, clearInterval };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const deadline = Date.now() + waitMs;
  for (;;) {
    const flag = page.window["__ulrCostPatch"] as { installed?: boolean } | undefined;
    if (flag?.installed === true) return;
    if (page.reports.some((r) => r.type === "cost-patch-error")) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 一小段長得像真的 cc_asset 的資料。index 位置刻意跟實測對得上。 */
function ccAsset(): { frames: { filename: string; chara: string; level: number; cost: number }[] } {
  return {
    frames: [
      { filename: "cc001_01", chara: "cc001", level: 1, cost: 8 },
      { filename: "cc078_04", chara: "cc078", level: 4, cost: 19 },
      { filename: "cc078_r04", chara: "cc078", level: 4, cost: 21 },
    ],
  };
}

function appliedReport(page: FakePage): CostPatchApplied {
  const found = page.reports.find((r): r is CostPatchApplied => r.type === "cost-patch");
  if (found === undefined) {
    throw new Error(
      `沒有收到 cost-patch 回報，只有：${page.reports.map((r) => r.type).join(", ")}`,
    );
  }
  return found;
}

describe("buildCostPatchScript", () => {
  describe("實際跑起來", () => {
    it("改寫 cc_asset 的 cost，並回報統計與索引", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { cc078_04: 30, cc078_r04: 40 },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const data = ccAsset();
      const file = page.makeFile("cc_asset", data);
      file.onProcess();

      expect(data.frames.map((f) => f.cost)).toEqual([8, 30, 40]);

      const report = appliedReport(page);
      expect(report.applied).toBe(2);
      expect(report.totalFrames).toBe(3);
      expect(report.unknownKeys).toEqual([]);
      // charaIndex 就是這個索引 —— 封包給的 charaIndex 可以直接查到 filename
      expect(report.index).toEqual(["cc001_01", "cc078_04", "cc078_r04"]);
    });

    it("L4 與 R4 是兩張不同的卡，只改到指定的那張", async () => {
      // 這正是不能用「角色+等級」當鍵的理由：兩者 level 都是 4。
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { cc078_r04: 99 },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const data = ccAsset();
      page.makeFile("cc_asset", data).onProcess();

      expect(data.frames[1]?.cost).toBe(19); // L4 沒被動到
      expect(data.frames[2]?.cost).toBe(99); // R4 改了
    });

    it("先跑遊戲原本的 onProcess，再做我們的事", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 1 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      page.makeFile("cc_asset", ccAsset()).onProcess();

      expect(page.originalCalls).toEqual(["cc_asset"]);
    });

    it("其他 key 的 JSON 完全不碰", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 1 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      const other = { frames: [{ filename: "cc078_04", cost: 19 }] };
      page.makeFile("textures", other).onProcess();

      expect(other.frames[0]?.cost).toBe(19);
      expect(page.reports.some((r) => r.type === "cost-patch")).toBe(false);
      expect(page.originalCalls).toEqual(["textures"]);
    });

    it("回報規則裡有、但客戶端沒有的鍵 —— 不能默默當 0", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { cc078_04: 30, cc999_01: 5 },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      page.makeFile("cc_asset", ccAsset()).onProcess();

      expect(appliedReport(page).unknownKeys).toEqual(["cc999_01"]);
    });

    it("注入兩次不會把 onProcess 疊起來", async () => {
      // addScriptToEvaluateOnNewDocument 每個 frame 都跑，重連時也會再注入。
      const page = createFakePage();
      page.installPhaser();
      const script = buildCostPatchScript({
        costs: { cc078_04: 30 },
        bindingName: BINDING,
        pollIntervalMs: 1,
      });
      await runScript(page, script);
      await runScript(page, script);

      page.makeFile("cc_asset", ccAsset()).onProcess();

      expect(page.originalCalls).toEqual(["cc_asset"]); // 只跑了一次
      expect(page.reports.filter((r) => r.type === "cost-patch")).toHaveLength(1);
    });

    it("cc_asset 沒有 frames 時回報錯誤，但不讓遊戲炸掉", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 1 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      expect(() => page.makeFile("cc_asset", { nope: true }).onProcess()).not.toThrow();
      expect(page.reports.some((r) => r.type === "cost-patch-error")).toBe(true);
      expect(page.originalCalls).toEqual(["cc_asset"]); // 遊戲該做的還是做了
    });

    it("等不到 Phaser 就放棄並回報，不留下永遠不停的計時器", async () => {
      // 頂層 frame 就是這個情況 —— 遊戲在 iframe 裡，頂層永遠沒有 Phaser。
      const page = createFakePage(); // 不裝 Phaser
      await runScript(
        page,
        buildCostPatchScript({
          costs: {},
          bindingName: BINDING,
          pollIntervalMs: 1,
          maxWaitMs: 10,
        }),
      );

      const err = page.reports.find((r) => r.type === "cost-patch-error");
      expect(err).toBeDefined();
      expect((err as { reason: string }).reason).toContain("Phaser");
    });

    it("binding 不存在時安靜降級（玩家沒開插件也要能玩）", async () => {
      const page = createFakePage();
      delete page.window[BINDING];
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 30 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      const data = ccAsset();
      expect(() => page.makeFile("cc_asset", data).onProcess()).not.toThrow();
      expect(data.frames[1]?.cost).toBe(30); // 改還是有改到
    });

    it("__proto__ 當鍵不會污染原型", async () => {
      // 直接寫成物件字面值的話 "__proto__" 會去設原型；走 JSON.parse 才是
      // 一般屬性。規則檔是外部資料，不能有辦法碰到原型。
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: JSON.parse('{"__proto__": 999, "cc078_04": 30}') as Record<string, number>,
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const data = ccAsset();
      page.makeFile("cc_asset", data).onProcess();

      const report = appliedReport(page);
      // 被當成一般的鍵列舉出來 → 證明它沒有變成原型
      expect(report.unknownKeys).toContain("__proto__");
      expect(data.frames[1]?.cost).toBe(30);
      expect(({} as Record<string, unknown>)["cost"]).toBeUndefined();
    });
  });

  describe("輸入檢查", () => {
    it("擋掉 NaN 與 Infinity —— 經過 JSON 會變成 null，畫面會像是遊戲壞了", () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(() =>
          buildCostPatchScript({ costs: { cc078_04: bad }, bindingName: BINDING }),
        ).toThrow(InvalidCostOverrideError);
      }
    });

    it("擋掉空字串的鍵", () => {
      expect(() => buildCostPatchScript({ costs: { "": 1 }, bindingName: BINDING })).toThrow(
        InvalidCostOverrideError,
      );
    });

    it("接受兩位小數 —— 規則的精度是 0.01", () => {
      expect(() =>
        buildCostPatchScript({ costs: { cc078_04: 18.55 }, bindingName: BINDING }),
      ).not.toThrow();
    });
  });

  describe("嵌入資料的安全性", () => {
    it("鍵裡的引號與反斜線不會逃出字串", async () => {
      const nasty = 'cc"078\\_04';
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { [nasty]: 7 },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const data = { frames: [{ filename: nasty, cost: 1 }] };
      page.makeFile("cc_asset", data).onProcess();

      expect(data.frames[0]?.cost).toBe(7);
    });

    it("不留下未跳脫的 U+2028 / U+2029 / <", () => {
      const script = buildCostPatchScript({
        costs: { [`a${String.fromCharCode(0x2028)}b`]: 1, "c<d": 2 },
        bindingName: BINDING,
      });
      expect(script).not.toContain(String.fromCharCode(0x2028));
      expect(script).toContain("\\u2028");
      // `<` 只該出現在我們自己的註解與程式碼裡，不該來自資料
      expect(script).toContain("\\u003c");
    });
  });
});
