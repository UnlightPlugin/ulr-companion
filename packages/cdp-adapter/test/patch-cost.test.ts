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
import type {
  CostPatchApplied,
  CostPatchEnabledResult,
  CostPatchReport,
  CostTableId,
} from "@ulr/cdp-adapter";
import {
  buildCostPatchCoverageExpression,
  buildCostPatchEnabledExpression,
  buildCostPatchScript,
  costsStamp,
  InvalidCostOverrideError,
  isCostPatchReport,
  normalizeCostTables,
  parseCostPatchEnabledResult,
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

interface CardRow {
  id: number;
  filename: string;
  chara: string;
  level: number;
  cost: number;
}

/**
 * 一小段長得像真的 `CharaCards` 的資料（2026-09-23 改版後）：**本身就是陣列**，
 * 角色與怪物在同一份，每筆有 id 與 filename。id 照實機（cc078_04 = 774）。
 */
function charaCards(): CardRow[] {
  return [
    { id: 1, filename: "cc001_01", chara: "cc001", level: 1, cost: 8 },
    { id: 774, filename: "cc078_04", chara: "cc078", level: 4, cost: 19 },
    { id: 779, filename: "cc078_r04", chara: "cc078", level: 4, cost: 21 },
    { id: 1001, filename: "mc001_01", chara: "mc001_01", level: 1, cost: 9 },
    { id: 1002, filename: "mc001_02", chara: "mc001_02", level: 2, cost: 10 },
  ];
}
const costsOf = (rows: { cost: number }[]): number[] => rows.map((r) => r.cost);

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
    it("改寫 CharaCards 的 cost（照 filename），並回報統計", async () => {
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

      const data = charaCards();
      page.makeFile("CharaCards", data).onProcess();

      expect(costsOf(data)).toEqual([8, 30, 40, 9, 10]);

      const report = appliedReport(page);
      expect(report.applied).toBe(2);
      expect(report.totalFrames).toBe(5);
      expect(report.unknownKeys).toEqual([]);
      expect(report.index).toEqual(["cc001_01", "cc078_04", "cc078_r04", "mc001_01", "mc001_02"]);
    });

    it("⚠ 舊的快取鍵（cc_asset）改版後不存在了 —— 就算有同名資料也不碰", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 30 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );
      const old = { frames: [{ filename: "cc078_04", cost: 19 }] };
      page.makeFile("cc_asset", old).onProcess();
      expect(old.frames[0]?.cost).toBe(19);
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

      const data = charaCards();
      page.makeFile("CharaCards", data).onProcess();

      expect(data[1]?.cost).toBe(19); // L4 沒被動到
      expect(data[2]?.cost).toBe(99); // R4 改了
    });

    it("先跑遊戲原本的 onProcess，再做我們的事", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 1 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      page.makeFile("CharaCards", charaCards()).onProcess();

      expect(page.originalCalls).toEqual(["CharaCards"]);
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

      page.makeFile("CharaCards", charaCards()).onProcess();

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

      page.makeFile("CharaCards", charaCards()).onProcess();

      expect(page.originalCalls).toEqual(["CharaCards"]); // 只跑了一次
      expect(page.reports.filter((r) => r.type === "cost-patch")).toHaveLength(1);
    });

    it("CharaCards 不是陣列時回報錯誤，但不讓遊戲炸掉", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({ costs: { cc078_04: 1 }, bindingName: BINDING, pollIntervalMs: 1 }),
      );

      expect(() => page.makeFile("CharaCards", { nope: true }).onProcess()).not.toThrow();
      expect(page.reports.some((r) => r.type === "cost-patch-error")).toBe(true);
      expect(page.originalCalls).toEqual(["CharaCards"]); // 遊戲該做的還是做了
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

      const data = charaCards();
      expect(() => page.makeFile("CharaCards", data).onProcess()).not.toThrow();
      expect(data[1]?.cost).toBe(30); // 改還是有改到
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

      const data = charaCards();
      page.makeFile("CharaCards", data).onProcess();

      const report = appliedReport(page);
      // 被當成一般的鍵列舉出來 → 證明它沒有變成原型
      expect(report.unknownKeys).toContain("__proto__");
      expect(data[1]?.cost).toBe(30);
      expect(({} as Record<string, unknown>)["cost"]).toBeUndefined();
    });
  });

  /**
   * 一副牌組是四張表組合出來的。這一組釘的是「四張表一個 hook」那件事 ——
   * 以及**它們的鍵不是同一套**：角色與怪物用 filename，裝備與事件卡用 id。
   *
   * 2026-09-23 改版後角色與怪物是**同一份** `CharaCards`，一個快取鍵對兩張表。
   */
  describe("四張表", () => {
    /**
     * 改版後的 WeaponCards：本身是陣列、每筆有 id。⚠ **順序刻意跟 id 對不上**
     * （實機就是這樣：WeaponCards[1] 是妖魔彈藥 id 2，勇者短劍 id 6 在後面）——
     * 誰拿陣列位置當 id 就會改錯卡。
     */
    const weaponCards = () => [
      { id: 1, name_tcn: "妖魔短劍", cost: 0 },
      { id: 2, name_tcn: "妖魔彈藥", cost: 0 },
      { id: 6, name_tcn: "勇者短劍", cost: 1 },
    ];
    const eventCards = () => [
      { id: 1, name_tcn: "劍1卡", cost: 0 },
      { id: 40, name_tcn: "聖水", cost: 0 },
      { id: 4, name_tcn: "劍4卡", cost: 1 },
    ];

    it("一個 hook 認得三個快取鍵，四張表各改各的", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: {
            characters: { cc078_04: 30 },
            monsters: { mc001_02: 15 },
            // ⚠ 卡片 id 字串，不是 wp006 —— 規則鍵的轉換是呼叫端的事
            equipment: { "6": 5 },
            eventCards: { "40": 7 },
          },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      const cc = charaCards();
      const wp = weaponCards();
      const ev = eventCards();
      page.makeFile("CharaCards", cc).onProcess();
      page.makeFile("WeaponCards", wp).onProcess();
      page.makeFile("EventCards", ev).onProcess();

      // 角色與怪物在同一份裡，兩張表都要套到 —— 一對一的話後放的會蓋掉前一張
      expect(costsOf(cc)).toEqual([8, 30, 21, 9, 15]);
      expect(costsOf(wp)).toEqual([0, 0, 5]);
      expect(costsOf(ev)).toEqual([0, 7, 1]);
    });

    it("每張表各發一則回報 —— 它們是四個獨立的 load.json，完成時間不同", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc078_04: 30 }, eventCards: { "40": 7 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );

      page.makeFile("CharaCards", charaCards()).onProcess();
      page.makeFile("EventCards", eventCards()).onProcess();

      expect(appliedReport(page, "characters").applied).toBe(1);
      expect(appliedReport(page, "eventCards").applied).toBe(1);
      // 沒給的表連查都不查
      expect(page.reports.filter((r) => r.type === "cost-patch")).toHaveLength(2);
    });

    it("id 型的表不回傳 filename 對照", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          costs: { characters: { cc078_04: 30 }, equipment: { "6": 5 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );
      page.makeFile("CharaCards", charaCards()).onProcess();
      page.makeFile("WeaponCards", weaponCards()).onProcess();

      expect(appliedReport(page, "characters").index).toHaveLength(5);
      expect(appliedReport(page, "equipment").index).toBeNull();
    });

    it("客戶端沒有的 id 進 unknownKeys —— 改版少了一張卡要看得見", async () => {
      const page = createFakePage();
      page.installPhaser();
      await runScript(
        page,
        buildCostPatchScript({
          // ⚠ "2" 是陣列位置 2 上那張的**位置**，不是它的 id（它的 id 是 4）
          costs: { eventCards: { "40": 7, "999": 1, "2": 3 } },
          bindingName: BINDING,
          pollIntervalMs: 1,
        }),
      );
      const ev = eventCards();
      page.makeFile("EventCards", ev).onProcess();

      const report = appliedReport(page, "eventCards");
      expect(report.applied).toBe(1);
      expect([...report.unknownKeys].sort()).toEqual(["2", "999"]);
      expect(costsOf(ev)).toEqual([0, 7, 1]);
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

      const wp = weaponCards();
      page.makeFile("WeaponCards", wp).onProcess();

      expect(costsOf(wp)).toEqual([0, 0, 1]);
      expect(page.reports.some((r) => r.type === "cost-patch")).toBe(false);
      expect(page.originalCalls).toEqual(["WeaponCards"]); // 遊戲該做的還是做了
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
      const cc = charaCards();
      page.makeFile("CharaCards", cc).onProcess();

      expect(cc[0]?.cost).toBe(1);
      expect(cc[3]?.cost).toBe(2);
      expect(appliedReport(page, "characters").unknownKeys).toEqual([]);
      expect(appliedReport(page, "monsters").unknownKeys).toEqual([]);
      // 同一份資料、兩則回報 —— 總數不能重複算到對方頭上
      expect(appliedReport(page, "characters").applied).toBe(1);
      expect(appliedReport(page, "monsters").applied).toBe(1);
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

      const data = [{ id: 1, filename: nasty, cost: 1 }];
      page.makeFile("CharaCards", data).onProcess();

      expect(data[0]?.cost).toBe(7);
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
        game: { cache: { json: { has: (k: string) => k === "CharaCards" } } },
      },
    };
    vm.createContext(sandbox);
    const raw = vm.runInContext(
      buildCostPatchCoverageExpression({ CharaCards: "characters" }, stamp),
      sandbox,
    ) as string;
    return JSON.parse(raw) as { missed: string[]; covered: string[] };
  }

  it("補丁蓋過而且是同一份規則 → 不必重載", () => {
    expect(coverage({ characters: 700, stamp: "abc" }, "abc").missed).toEqual([]);
  });

  it("補丁根本沒跑過 → 只有重載救得回來", () => {
    expect(coverage(undefined, "abc").missed).toEqual(["CharaCards"]);
  });

  it("⚠ 蓋的是**別份**規則 → 也要重載（少了這一關就跟「沒生效」一模一樣）", () => {
    expect(coverage({ characters: 700, stamp: "old" }, "abc").missed).toEqual(["CharaCards"]);
  });

  it("舊版腳本沒有 stamp → 當成別份規則，重載一次", () => {
    expect(coverage({ characters: 700 }, "abc").missed).toEqual(["CharaCards"]);
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

  it("換規則當場套新價、指紋換成新的；舊規則動過而新規則沒動的卡放回官方價", async () => {
    // 2026-09-24 改寫：以前換規則只能重載（掛鉤只在載入那一刻動手）；改版後
    // 大家都當下讀快取，所以直接重擺一次。
    const page = createFakePage();
    page.installPhaser();
    const cc = charaCards();
    page.window["game"] = {
      cache: { json: { has: (k: string) => k === "CharaCards", get: () => cc } },
      scene: { keys: {} },
    };
    const first = { cc078_04: 18, cc001_01: 3 };
    await runScript(
      page,
      buildCostPatchScript({ costs: first, bindingName: BINDING, pollIntervalMs: 1 }),
    );
    expect(costsOf(cc)).toEqual([3, 18, 21, 9, 10]);

    const second = { cc078_04: 22 };
    await runScript(
      page,
      buildCostPatchScript({ costs: second, bindingName: BINDING, pollIntervalMs: 1 }),
    );

    const flag = page.window["__ulrCostPatch"] as { stamp?: string };
    expect(flag.stamp).toBe(costsStamp(second));
    // cc001_01 上一份規則改成 3，這一份沒提 → 回官方的 8
    expect(costsOf(cc)).toEqual([8, 22, 21, 9, 10]);
  });

  it("插件晚接上（資料已經在快取裡）→ 裝上的當下就套好，不必重載", async () => {
    const page = createFakePage();
    page.installPhaser();
    const cc = charaCards();
    page.window["game"] = {
      cache: { json: { has: (k: string) => k === "CharaCards", get: () => cc } },
      scene: { keys: {} },
    };
    await runScript(
      page,
      buildCostPatchScript({ costs: { cc078_04: 30 }, bindingName: BINDING, pollIntervalMs: 1 }),
    );
    expect(costsOf(cc)).toEqual([8, 30, 21, 9, 10]);
    expect(appliedReport(page).applied).toBe(1);
    // 「來得及嗎」那支看的旗標也記上了
    expect((page.window["__ulrCostPatch"] as { characters?: number }).characters).toBe(1);
  });
});

describe("不重載切換自訂價 ↔ 原價", () => {
  /**
   * 把「已經載進快取的資料」與 Edit 場景擺好，再跑切換運算式。
   *
   * 2026-09-23 改版後 Edit 沒有自己的副本了（每次都讀 cache.json），換完價
   * 叫 refresh()（照快取重排、重建格線）與 show_cost()（重算下面那排）。
   */
  function setup(opts: { emptyCache?: boolean } = {}) {
    const page = createFakePage();
    page.installPhaser();
    const cc = charaCards();
    const wp = [
      { id: 1, cost: 0 },
      { id: 6, cost: 1 },
    ];
    // 預設：資料已經在快取裡（插件晚接上）。emptyCache：還沒載（插件先接上）。
    const cache = new Map<string, unknown>(
      opts.emptyCache
        ? []
        : [
            ["CharaCards", cc],
            ["WeaponCards", wp],
          ],
    );
    const redraws: string[] = [];
    page.window["game"] = {
      cache: { json: { has: (k: string) => cache.has(k), get: (k: string) => cache.get(k) } },
      scene: {
        keys: {
          Edit: {
            scene: { isActive: () => true },
            refresh: () => redraws.push("refresh"),
            show_cost: () => redraws.push("show_cost"),
          },
        },
      },
    };
    return { page, cc, wp, redraws, cache };
  }

  function toggle(page: FakePage, enabled: boolean): CostPatchEnabledResult {
    const sandbox = { window: page.window };
    vm.createContext(sandbox);
    const raw = vm.runInContext(buildCostPatchEnabledExpression(enabled), sandbox) as string;
    return parseCostPatchEnabledResult(raw);
  }

  const costs = { characters: { cc078_04: 30, cc078_r04: 33 }, equipment: { "6": 5 } };

  it("補丁記下原價；切到官方就換回去，再切回來又是自訂價；Edit 開著就重畫", async () => {
    const { page, cc, wp, redraws } = setup();
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));
    // 資料已經在快取裡 → 裝上的當下就套好，Edit 開著也當場重畫一次
    expect(costsOf(cc)).toEqual([8, 30, 33, 9, 10]);
    expect(costsOf(wp)).toEqual([0, 5]);
    expect(redraws).toEqual(["refresh", "show_cost"]);
    redraws.length = 0;
    // 之後再載一次（例如切語言）也一樣
    page.makeFile("CharaCards", cc).onProcess();
    page.makeFile("WeaponCards", wp).onProcess();
    expect(costsOf(cc)).toEqual([8, 30, 33, 9, 10]);

    const off = toggle(page, false);
    expect(off).toEqual({ installed: true, enabled: false, swapped: 3, redrawn: true });
    expect(costsOf(cc)).toEqual([8, 19, 21, 9, 10]);
    expect(costsOf(wp)).toEqual([0, 1]);
    // refresh 會照快取裡的 cost 重排（「排列：成本」自動跟上），show_cost 重算總和
    expect(redraws).toEqual(["refresh", "show_cost"]);

    const on = toggle(page, true);
    expect(on.enabled).toBe(true);
    expect(costsOf(cc)).toEqual([8, 30, 33, 9, 10]);
    expect(redraws).toHaveLength(4);
  });

  it("enabled:false 裝上去 → 掛鉤照攔、照記原價，但數字不動；之後切得回自訂", async () => {
    const { page, cc, cache } = setup({ emptyCache: true });
    await runScript(
      page,
      buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1, enabled: false }),
    );
    page.makeFile("CharaCards", cc).onProcess();
    cache.set("CharaCards", cc); // 載完就在快取裡了
    expect(costsOf(cc)).toEqual([8, 19, 21, 9, 10]);
    // 回報與旗標跟開著時一樣 —— 「來得及嗎」那支才不會把它判成沒蓋到
    expect(appliedReport(page).applied).toBe(2);
    const flag = page.window["__ulrCostPatch"] as { characters?: number; enabled?: boolean };
    expect(flag.characters).toBe(2);
    expect(flag.enabled).toBe(false);

    expect(toggle(page, true).swapped).toBe(2);
    expect(costsOf(cc)).toEqual([8, 30, 33, 9, 10]);
  });

  it("規則沒動到的卡一律不碰（原價表裡沒有它）", async () => {
    const { page, cc } = setup();
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));
    page.makeFile("CharaCards", cc).onProcess();
    cc[0]!.cost = 99; // 遊戲自己（或別的補丁）改了一張我們不管的
    toggle(page, false);
    expect(cc[0]!.cost).toBe(99);
    toggle(page, true);
    expect(cc[0]!.cost).toBe(99);
  });

  it("掛鉤還沒攔到任何一張表 → installed 但 swapped 0（頁面本來就是原價）", async () => {
    const { page } = setup({ emptyCache: true });
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));
    expect(toggle(page, false)).toEqual({
      installed: true,
      enabled: false,
      swapped: 0,
      redrawn: true,
    });
  });

  it("頁面上沒有補丁 → installed:false，什麼都不動", () => {
    const { page } = setup();
    expect(toggle(page, false)).toEqual({
      installed: false,
      enabled: false,
      swapped: 0,
      redrawn: false,
    });
  });

  describe("右邊大卡的 COST 格跟著切（refresh／show_cost 不碰它）", () => {
    /** 仿 show_info() 畫出來的 profile_texts：只擺得到座標與 setText 就夠了。 */
    function fakeText(x: number, y: number, text: string) {
      return {
        x,
        y,
        text,
        setText(v: string) {
          this.text = v;
          return this;
        },
      };
    }
    function charaPanel(cardId: number, cost: string) {
      const texts = Array.from({ length: 12 }, (_, i) => fakeText(684, 300 + i, "-"));
      texts[9] = fakeText(729, 462, cost);
      return { front: { card_id: cardId, image: { frame: { name: "__BASE" } } }, texts };
    }
    function slotPanel(frame: string, cost: string, costXY: [number, number] = [697, 386]) {
      const texts = Array.from({ length: 7 }, (_, i) => fakeText(697, 350 + 18 * i, "-"));
      texts[2] = fakeText(costXY[0], costXY[1], cost);
      return { front: { image: { frame: { name: frame } } }, texts };
    }
    function show(page: FakePage, panel: { front: unknown; texts: unknown[] }) {
      const game = page.window["game"] as {
        cache: unknown;
        scene: { keys: Record<string, Record<string, unknown>> };
      };
      const edit = game.scene.keys["Edit"]!;
      edit["cache"] = game.cache;
      edit["card_preview"] = { front: panel.front };
      edit["profile_texts"] = panel.texts;
    }

    it("角色卡：切到官方變原價、切回來又是自訂價", async () => {
      const { page } = setup();
      await runScript(
        page,
        buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }),
      );
      const panel = charaPanel(774, "30");
      show(page, panel);
      toggle(page, false);
      expect(panel.texts[9]!.text).toBe("19");
      toggle(page, true);
      expect(panel.texts[9]!.text).toBe("30");
    });

    it("武器卡：id 從圖的 frame 名來、COST 在第 2 格", async () => {
      const { page } = setup();
      await runScript(
        page,
        buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }),
      );
      const panel = slotPanel("weapon_6", "5");
      show(page, panel);
      toggle(page, false);
      expect(panel.texts[2]!.text).toBe("1");
    });

    it("⚠ 座標對不上（遊戲改版挪了版面）→ 不動，免得寫進別的欄位", async () => {
      const { page } = setup();
      await runScript(
        page,
        buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }),
      );
      const panel = slotPanel("weapon_6", "5", [697, 404]);
      show(page, panel);
      expect(toggle(page, false).redrawn).toBe(true);
      expect(panel.texts[2]!.text).toBe("5");
    });
  });

  it("Edit 沒有 refresh（遊戲又改版）→ 快取照換、回報沒重畫，不炸", async () => {
    const { page, cc } = setup();
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));
    page.makeFile("CharaCards", cc).onProcess();
    const keys = (page.window["game"] as { scene: { keys: Record<string, unknown> } }).scene.keys;
    keys["Edit"] = { scene: { isActive: () => true } };
    const r = toggle(page, false);
    expect(r.redrawn).toBe(false);
    expect(costsOf(cc)).toEqual([8, 19, 21, 9, 10]);
  });

  it("不在 Edit 畫面 → 快取照換、只是不重畫", async () => {
    const { page, cc } = setup();
    await runScript(page, buildCostPatchScript({ costs, bindingName: BINDING, pollIntervalMs: 1 }));
    page.makeFile("CharaCards", cc).onProcess();
    (page.window["game"] as { scene: { keys: Record<string, unknown> } }).scene.keys = {};
    const r = toggle(page, false);
    expect(r.redrawn).toBe(false);
    expect(r.swapped).toBe(3); // 角色 2 張 + 裝備 1 張
    expect(costsOf(cc)).toEqual([8, 19, 21, 9, 10]);
  });

  it("parseCostPatchEnabledResult 讀不懂就當成沒裝", () => {
    expect(parseCostPatchEnabledResult("nope")).toEqual({
      installed: false,
      enabled: false,
      swapped: 0,
      redrawn: false,
    });
    expect(parseCostPatchEnabledResult(undefined).installed).toBe(false);
  });
});
