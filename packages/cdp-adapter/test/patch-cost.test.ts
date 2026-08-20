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
import type { CostPatchApplied, CostPatchReport, CostTableId } from "@ulr/cdp-adapter";
import {
  buildCostPatchCoverageExpression,
  buildCostPatchScript,
  costsStamp,
  InvalidCostOverrideError,
  isCostPatchReport,
  normalizeCostTables,
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

function appliedReport(page: FakePage, table: CostTableId = "characters"): CostPatchApplied {
  const found = page.reports.find(
    (r): r is CostPatchApplied => r.type === "cost-patch" && r.table === table,
  );
  if (found === undefined) {
    throw new Error(
      `沒有收到 ${table} 的 cost-patch 回報，只有：${page.reports
        .map((r) => (r.type === "cost-patch" ? `cost-patch:${r.table}` : r.type))
        .join(", ")}`,
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

  /**
   * 一副牌組是四張表組合出來的。這一組釘的是「四張表一個 hook」那件事 ——
   * 以及**它們的鍵不是同一套**：角色與怪物用 filename，裝備與事件卡用索引。
   */
  describe("四張表", () => {
    const mcAsset = () => ({
      frames: [
        { filename: "mc001_01", chara: "mc001_01", level: 1, cost: 9 },
        { filename: "mc001_02", chara: "mc001_02", level: 2, cost: 10 },
      ],
    });
    /** ⚠ 陣列在 `weapon` 不是 `frames` —— avatar_item 是一份大雜燴。 */
    const avatarItem = () => ({
      avatar: [{ frame: 0, cost: 0 }],
      weapon: [
        { frame: 0, name_tcn: "妖魔短劍", cost: 0 },
        { frame: 1, name_tcn: "勇者短劍", cost: 1 },
        { frame: 2, name_tcn: "詛咒短劍", cost: 1 },
      ],
    });
    const eventInfo = () => ({
      frames: [
        { name_tcn: "劍1卡", cost: 0 },
        { name_tcn: "劍2卡", cost: 0 },
        { name_tcn: "劍3卡", cost: 0 },
        { name_tcn: "劍4卡", cost: 1 },
      ],
    });

    it("一個 hook 認得四個快取鍵，各改各的", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: {
            characters: { cc078_04: 30 },
            monsters: { mc001_02: 15 },
            // ⚠ 索引字串，不是 wp001 —— 規則鍵的轉換是呼叫端的事
            equipment: { "1": 5 },
            eventCards: { "3": 7 },
          },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const cc = ccAsset();
      const mc = mcAsset();
      const item = avatarItem();
      const ev = eventInfo();
      page.makeFile("cc_asset", cc).onProcess();
      page.makeFile("mc_asset", mc).onProcess();
      page.makeFile("avatar_item", item).onProcess();
      page.makeFile("event_info", ev).onProcess();

      expect(cc.frames.map((f) => f.cost)).toEqual([8, 30, 21]);
      expect(mc.frames.map((f) => f.cost)).toEqual([9, 15]);
      expect(item.weapon.map((w) => w.cost)).toEqual([0, 5, 1]);
      expect(ev.frames.map((f) => f.cost)).toEqual([0, 0, 0, 7]);
      // 同一份 avatar_item 的其他段落一個都不能碰
      expect(item.avatar[0]?.cost).toBe(0);
    });

    it("每張表各發一則回報 —— 它們是四個獨立的 load.json，完成時間不同", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc078_04: 30 }, eventCards: { "3": 7 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      page.makeFile("cc_asset", ccAsset()).onProcess();
      page.makeFile("event_info", eventInfo()).onProcess();

      expect(appliedReport(page, "characters").applied).toBe(1);
      expect(appliedReport(page, "eventCards").applied).toBe(1);
      // 沒給的表連查都不查
      expect(page.reports.filter((r) => r.type === "cost-patch")).toHaveLength(2);
    });

    it("索引型的表不回傳 index 對照 —— 它的鍵本來就是索引", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc078_04: 30 }, equipment: { "1": 5 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );
      page.makeFile("cc_asset", ccAsset()).onProcess();
      page.makeFile("avatar_item", avatarItem()).onProcess();

      expect(appliedReport(page, "characters").index).toEqual([
        "cc001_01",
        "cc078_04",
        "cc078_r04",
      ]);
      expect(appliedReport(page, "equipment").index).toBeNull();
    });

    it("索引超出範圍的鍵進 unknownKeys —— 改版少了一張卡要看得見", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { eventCards: { "3": 7, "999": 1 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );
      page.makeFile("event_info", eventInfo()).onProcess();

      const report = appliedReport(page, "eventCards");
      expect(report.applied).toBe(1);
      expect(report.unknownKeys).toEqual(["999"]);
    });

    it("空的表完全不裝 —— 只改角色的規則不該去碰另外三份資料", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc078_04: 30 }, monsters: {}, equipment: {} },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const mc = mcAsset();
      page.makeFile("mc_asset", mc).onProcess();

      expect(mc.frames.map((f) => f.cost)).toEqual([9, 10]);
      expect(page.reports.some((r) => r.type === "cost-patch")).toBe(false);
      expect(page.originalCalls).toEqual(["mc_asset"]); // 遊戲該做的還是做了
    });

    it("怪物與角色的鍵不會互撞 —— cc / mc 前綴分得開", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc001_01: 1 }, monsters: { mc001_01: 2 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );
      const cc = ccAsset();
      const mc = mcAsset();
      page.makeFile("cc_asset", cc).onProcess();
      page.makeFile("mc_asset", mc).onProcess();

      expect(cc.frames[0]?.cost).toBe(1);
      expect(mc.frames[0]?.cost).toBe(2);
      expect(appliedReport(page, "characters").unknownKeys).toEqual([]);
      expect(appliedReport(page, "monsters").unknownKeys).toEqual([]);
    });
  });

  describe("normalizeCostTables", () => {
    it("扁平的表當成角色表 —— 既有的呼叫端與規則檔語意不變", () => {
      expect(normalizeCostTables({ cc078_04: 30 })).toEqual({
        characters: { cc078_04: 30 },
        monsters: {},
        equipment: {},
        eventCards: {},
      });
    });

    it("四張表的寫法照原樣，沒給的補空物件", () => {
      expect(normalizeCostTables({ monsters: { mc001_01: 9 } })).toEqual({
        characters: {},
        monsters: { mc001_01: 9 },
        equipment: {},
        eventCards: {},
      });
    });

    it("⚠ 空物件是角色表不是四張表 —— 兩種解讀的結果一樣，不能靠它分辨", () => {
      expect(normalizeCostTables({})).toEqual({
        characters: {},
        monsters: {},
        equipment: {},
        eventCards: {},
      });
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

// ---------------------------------------------------------------------------
// 「這個頁面來得及嗎」
// ---------------------------------------------------------------------------

describe("costsStamp", () => {
  it("同一份規則的指紋一樣，鍵的順序不算數", () => {
    const a = { cc001_01: 8, cc001_02: 12, cc002_01: 9 };
    const b = { cc002_01: 9, cc001_02: 12, cc001_01: 8 };
    expect(costsStamp(a)).toBe(costsStamp(b));
  });

  it("改一個數字就換一個指紋", () => {
    expect(costsStamp({ cc001_01: 8 })).not.toBe(costsStamp({ cc001_01: 9 }));
  });

  it("值放在不同的表上算不同的規則", () => {
    expect(costsStamp({ characters: { a: 1 } })).not.toBe(costsStamp({ monsters: { a: 1 } }));
  });

  it("扁平寫法等同只有角色表 —— 舊規則檔的語意不能變", () => {
    expect(costsStamp({ cc001_01: 8 })).toBe(costsStamp({ characters: { cc001_01: 8 } }));
  });
});

describe("buildCostPatchCoverageExpression", () => {
  /** 一個「資料已經載進快取」的假頁面。`flag` 就是頁面上那份 `__ulrCostPatch`。 */
  function coverage(flag: unknown, stamp?: string): { missed: string[]; covered: string[] } {
    const sandbox = {
      window: {
        __ulrCostPatch: flag,
        game: { cache: { json: { has: (k: string) => k === "cc_asset" } } },
      },
    };
    vm.createContext(sandbox);
    const raw = vm.runInContext(
      buildCostPatchCoverageExpression({ cc_asset: "characters" }, stamp),
      sandbox,
    ) as string;
    return JSON.parse(raw) as { missed: string[]; covered: string[] };
  }

  it("補丁蓋過而且是同一份規則 → 不必重載", () => {
    expect(coverage({ characters: 700, stamp: "abc" }, "abc").missed).toEqual([]);
  });

  it("補丁根本沒跑過 → 只有重載救得回來", () => {
    expect(coverage(undefined, "abc").missed).toEqual(["cc_asset"]);
  });

  it("⚠ 蓋的是**別份**規則 → 也要重載（少了這一關就跟「沒生效」一模一樣）", () => {
    expect(coverage({ characters: 700, stamp: "old" }, "abc").missed).toEqual(["cc_asset"]);
  });

  it("舊版腳本沒有 stamp → 當成別份規則，重載一次", () => {
    expect(coverage({ characters: 700 }, "abc").missed).toEqual(["cc_asset"]);
  });

  it("沒傳 stamp 時行為跟以前完全一樣", () => {
    expect(coverage({ characters: 700 }).missed).toEqual([]);
  });
});

describe("補丁把指紋留在頁面上", () => {
  it("裝上去之後 __ulrCostPatch.stamp 就是這份規則的指紋", async () => {
    const costs = { cc078_04: 18 };
    const page = createFakePage();
    page.installPhaser();
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));

    const flag = page.window["__ulrCostPatch"] as { stamp?: string };
    expect(flag.stamp).toBe(costsStamp(costs));
  });

  it("⚠ 換規則時早退，而且**留著舊指紋** —— 那是判斷得出「該重載」的唯一依據", async () => {
    const page = createFakePage();
    page.installPhaser();
    const first = { cc078_04: 18 };
    await runScript(
      page,
      buildCostPatchScript({ costs: first, bindingName: BINDING, pollIntervalMs: 1 }),
    );

    const second = { cc078_04: 22 };
    await runScript(
      page,
      buildCostPatchScript({ costs: second, bindingName: BINDING, pollIntervalMs: 1 }),
    );

    const flag = page.window["__ulrCostPatch"] as { stamp?: string };
    expect(flag.stamp).toBe(costsStamp(first));
    expect(flag.stamp).not.toBe(costsStamp(second));
  });
});
