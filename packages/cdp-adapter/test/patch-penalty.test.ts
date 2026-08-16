/**
 * 壓 C 罰則補丁
 *
 * 最重要的一條：**注入頁面的那份算法，必須跟 `@ulr/cost-engine` 算出同一個
 * 數字。** 兩邊分開實作（一邊是 TypeScript、一邊是要塞進遊戲的 ES5 字串），
 * 分開就會漂移，而漂移的症狀是「插件的明細寫 +1，遊戲畫面寫 +5」——
 * 玩家只會覺得插件在騙人。
 *
 * 所以這裡把注入腳本裡的 `penaltiesFor` 挖出來實際跑，跟引擎交叉比對。
 */

import { describe, expect, it } from "vitest";
import {
  buildPenaltyPatchScript,
  InvalidPenaltyBandError,
  isPenaltyPatchReport,
} from "@ulr/cdp-adapter";
import type { PenaltyBand } from "@ulr/cdp-adapter";
import { calculateTeamCost } from "@ulr/cost-engine";
import type { CostRule } from "@ulr/rule-schema";

const OFFICIAL: PenaltyBand[] = [
  { minGap: 7, maxGap: 13, extraCost: 5 },
  { minGap: 14, extraCost: 10 },
];

/** 你的夾擠式曲線的前幾段，拿來確認多段也對得上。 */
const SQUEEZE: PenaltyBand[] = [
  { minGap: 7, maxGap: 7, extraCost: 1 },
  { minGap: 8, maxGap: 8, extraCost: 2 },
  { minGap: 9, maxGap: 9, extraCost: 3 },
  { minGap: 10, maxGap: 11, extraCost: 4 },
  { minGap: 12, maxGap: 13, extraCost: 5 },
  { minGap: 14, extraCost: 6 },
];

/**
 * 同一條曲線，但區間上界頂到下一段起點的前一刻度。
 *
 * ⚠ 上面那份 `SQUEEZE` 是**點狀區間**（[7,7]、[8,8]…）。角色 COST 一旦帶
 * 小數，差距就是小數，而 13.5 這種值在點狀區間下**一段都不中 → 完全不罰**，
 * 而且是靜悄悄的。2026-08-15 玩家的 `shinon/squeeze-band` 就是這樣：
 * 兩個角色改成 13.2 與 15.5 之後，壓 C 整個消失。
 */
const SQUEEZE_CONTINUOUS: PenaltyBand[] = [
  { minGap: 7, maxGap: 7.99, extraCost: 1 },
  { minGap: 8, maxGap: 8.99, extraCost: 2 },
  { minGap: 9, maxGap: 9.99, extraCost: 3 },
  { minGap: 10, maxGap: 11.99, extraCost: 4 },
  { minGap: 12, maxGap: 13.99, extraCost: 5 },
  { minGap: 14, extraCost: 6 },
];

/**
 * 把注入腳本裡的 `penaltiesFor` 拿出來跑。
 *
 * ⚠ 用**產生出來的腳本本身**，不是重寫一份 —— 重寫的話這個測試就只是在測
 * 我對它的理解，而不是測真正會跑在玩家遊戲裡的那段程式碼。
 */
function penaltiesFromScript(bands: PenaltyBand[], cards: (number | null)[]): (number | null)[] {
  const script = buildPenaltyPatchScript({ bands, bindingName: "__test" });

  // 腳本是一個 IIFE，裡面的函式沒有匯出。挖出這兩支的原始碼直接評估。
  const start = script.indexOf("function extraFor");
  const end = script.indexOf("function install");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = script.slice(start, end);

  // 用 new Function 正是重點：測的是「會被丟進遊戲執行的那段字串」，
  // 不是我重寫的一份等價實作。重寫的話這個測試只證明我看懂了它。
  // eslint-disable-next-line no-new-func
  const make = new Function(
    "BANDS",
    `var CFG = { bands: BANDS };\n${body}\nreturn penaltiesFor;`,
  ) as (b: readonly PenaltyBand[]) => (c: (number | null)[]) => (number | null)[];

  return make(bands)(cards);
}

/** 同一組 band 用引擎算出來的罰則總和。 */
function enginePenalty(bands: PenaltyBand[], costs: number[]): number {
  const characters: Record<string, number> = {};
  const members = costs.map((c, i) => {
    characters[`s${i}`] = c;
    return { characterId: `s${i}` };
  });
  const rule: CostRule = {
    schemaVersion: 1,
    ruleSetId: "t/t",
    version: "1.0.0",
    name: "t",
    publisher: { id: "t", name: "t" },
    gameVersion: "2026.08",
    teamCostLimit: 0,
    characters,
    compressionRule: { type: "gap-band-v1", bands: bands as never },
  };
  const res = calculateTeamCost(rule, { members });
  return (res.total - costs.reduce((a, b) => a + b, 0) * 100) / 100;
}

const sum = (p: (number | null)[]) => p.reduce<number>((a, b) => a + (b ?? 0), 0);

describe("注入頁面的罰則算法 vs Cost Engine", () => {
  // ⚠ 每一列要包成陣列。`it.each([OFFICIAL, SQUEEZE])` 會把 OFFICIAL 這個
  // 陣列**攤開成參數**，於是 bands 收到的是第一個 band 物件而不是整張表。
  it.each([[OFFICIAL], [SQUEEZE]])("窮舉 0~30 的三元組，總和完全一致（%#）", (bands) => {
    const mismatches: string[] = [];
    for (let a = 0; a <= 30; a++) {
      for (let b = a; b <= 30; b++) {
        for (let c = b; c <= 30; c++) {
          const page = sum(penaltiesFromScript(bands as PenaltyBand[], [a, b, c]));
          const engine = enginePenalty(bands as PenaltyBand[], [a, b, c]);
          if (page !== engine) mismatches.push(`[${a},${b},${c}] 頁面 ${page} / 引擎 ${engine}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * 小數 COST 的交叉比對。
   *
   * 上面那個窮舉只跑整數 —— 而規則格式允許兩位小數（`cost-number.ts`），
   * 玩家真的會用。小數的差距在頁面端是 IEEE 754 的減法（`13.2 - 8` =
   * 5.199999999999999），引擎端是整數分（520），兩邊各自逼近邊界時最容易漂。
   */
  it.each([[SQUEEZE_CONTINUOUS], [OFFICIAL]])("小數 COST 也對得上（%#）", (bands) => {
    const values = [8, 8.99, 9, 13.2, 15.5, 15.99, 16, 21.35, 22.5, 30.01];
    const mismatches: string[] = [];
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          const page = sum(penaltiesFromScript(bands as PenaltyBand[], [a, b, c]));
          const engine = enginePenalty(bands as PenaltyBand[], [a, b, c]);
          // 頁面端是浮點加總，引擎端是整數分還原 —— 比到 0.01 就夠，
          // 再嚴會抓到 IEEE 754 的尾巴而不是真正的語義差異。
          if (Math.abs(page - engine) > 0.005) {
            mismatches.push(`[${a},${b},${c}] 頁面 ${page} / 引擎 ${engine}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * 這一則就是玩家撞到的那個坑，把它釘住。
   *
   * 點狀區間配上小數 COST = 靜默不罰。這不是實作的錯（兩邊都照著表算），
   * 是**規則寫法**的陷阱 —— 所以規則檔要把上界寫成 x.99。
   */
  it("點狀區間遇到小數差距會整段落空 —— 上界頂到下一段才補得起來", () => {
    // 差距 7.5：落在 [7,7] 與 [8,8] 之間，一段都不中。
    // ⚠ 玩家那份完整的曲線 22 段**每一段都是點**，所以連 24.8 這種大差距
    // 也會落空 —— 這裡的表只到 14 就開放，縫隙僅存在於 7~14 之間。
    expect(sum(penaltiesFromScript(SQUEEZE, [8, 15.5, null]))).toBe(0);
    expect(sum(penaltiesFromScript(SQUEEZE_CONTINUOUS, [8, 15.5, null]))).toBe(1);

    // 整數的判定必須完全不受影響 —— 補縫隙不能改變原本的曲線
    for (const trio of [
      [9, 13, 20],
      [8, 15, 30],
      [17, 17, 99],
    ] as const) {
      expect(sum(penaltiesFromScript(SQUEEZE_CONTINUOUS, [...trio]))).toBe(
        sum(penaltiesFromScript(SQUEEZE, [...trio])),
      );
    }
  });

  it("原版 band 重現遊戲實際顯示的那三筆", () => {
    // 這三筆是 2026-08-15 在牌組畫面上截到的
    expect(sum(penaltiesFromScript(OFFICIAL, [15, 13, 20]))).toBe(5);
    expect(sum(penaltiesFromScript(OFFICIAL, [9, 13, 20]))).toBe(10);
    expect(sum(penaltiesFromScript(OFFICIAL, [17, 17, 99]))).toBe(20);
  });

  it("夾擠式對同一副牌組比原版寬鬆 —— 這正是它的效果", () => {
    expect(sum(penaltiesFromScript(OFFICIAL, [9, 13, 20]))).toBe(10);
    expect(sum(penaltiesFromScript(SQUEEZE, [9, 13, 20]))).toBe(5); // 差 7 → +1、差 11 → +4
  });
});

describe("空槽與兩人隊伍", () => {
  it("null 的槽不參與配對", () => {
    expect(sum(penaltiesFromScript(OFFICIAL, [8, 30, null]))).toBe(10);
    expect(sum(penaltiesFromScript(OFFICIAL, [8, null, null]))).toBe(0);
  });

  it("罰則格子最多三個，不會溢位", () => {
    const p = penaltiesFromScript(OFFICIAL, [8, 22, 40]);
    expect(p).toHaveLength(3);
    expect(p.every((x) => x === null || typeof x === "number")).toBe(true);
  });
});

/**
 * 罰則貼在哪一格。
 *
 * ⚠ 這一組是 2026-08-16 修掉的那個 bug 的圍欄。原本的實作把命中的罰則**由大
 * 到小填進 0、1、2 格**，跟「是哪張卡造成的」完全無關 —— 而遊戲畫的是
 * `cost_penalty_text[i]` 配 `cost_text[i]`（同一個 i），所以 `+N` 會長在一張
 * 根本沒參與那一對的卡底下。實測 `19 / 13 / 22` 配夾擠式規則：罰則來自
 * 13↔22，`+3` 卻貼在 19 那張。
 */
describe("罰則貼在造成它的那張卡上", () => {
  it("貼在這一對裡比較便宜的那張 —— 換牌組排序，徽章跟著那張卡跑", () => {
    // 13↔22 差 9 → +3（19 跟誰都不到 7）
    expect(penaltiesFromScript(SQUEEZE_CONTINUOUS, [13, 19, 22])).toEqual([3, null, null]);
    // 同一副牌換個排法，徽章要跟著 13 那張走到第二格
    expect(penaltiesFromScript(SQUEEZE_CONTINUOUS, [19, 13, 22])).toEqual([null, 3, null]);
    expect(penaltiesFromScript(SQUEEZE_CONTINUOUS, [19, 22, 13])).toEqual([null, null, 3]);
  });

  it("一張卡踩到兩對就加起來 —— 三格的和永遠等於總罰則", () => {
    // 8/15/30：8↔15 差 7 → +5、8↔30 差 22 → +10 都算在 8 頭上；
    // 15↔30 差 15 → +10 算在 15 頭上。
    expect(penaltiesFromScript(OFFICIAL, [8, 15, 30])).toEqual([15, 10, null]);
    expect(sum(penaltiesFromScript(OFFICIAL, [8, 15, 30]))).toBe(25);
  });

  it("空槽不佔位 —— 罰則跟著實際有卡的那一格", () => {
    expect(penaltiesFromScript(OFFICIAL, [null, 8, 30])).toEqual([null, 10, null]);
    expect(penaltiesFromScript(OFFICIAL, [30, null, 8])).toEqual([null, null, 10]);
  });

  it("一樣貴時貼前面那格 —— 要有確定性", () => {
    // 17/17/99：兩對都是差 82 → +10，兩個 17 各拿一份
    expect(penaltiesFromScript(OFFICIAL, [17, 17, 99])).toEqual([10, 10, null]);
  });
});

describe("空的 band 表", () => {
  it("完全不罰 —— 那是「這份規則不壓 C」，不是「用原版」", () => {
    expect(sum(penaltiesFromScript([], [8, 22, 40]))).toBe(0);
  });
});

describe("腳本本身", () => {
  it("區間表只以 JSON 資料嵌入，不是程式碼（§12）", () => {
    const script = buildPenaltyPatchScript({ bands: OFFICIAL, bindingName: "__test" });
    expect(script).toContain("JSON.parse(");
    // 數值不該以裸物件字面值出現在腳本裡
    expect(script).not.toContain("bands: [{");
  });

  it("不寫死 webpack 模組 id —— 改版就會換", () => {
    const script = buildPenaltyPatchScript({ bands: OFFICIAL, bindingName: "__test" });
    expect(script).not.toContain("12919");
    expect(script).toContain("prototype.getCost");
  });

  it("壞掉的 band 在產生腳本時就擋下來，不是等頁面爆炸", () => {
    expect(() =>
      buildPenaltyPatchScript({
        bands: [{ minGap: Number.NaN, extraCost: 1 }],
        bindingName: "x",
      }),
    ).toThrow(InvalidPenaltyBandError);

    expect(() =>
      buildPenaltyPatchScript({
        bands: [{ minGap: 10, maxGap: 3, extraCost: 1 }],
        bindingName: "x",
      }),
    ).toThrow(/maxGap/);
  });
});

describe("⚠ 出站封包必須是原版數字（§12 硬規則 4）", () => {
  /**
   * 牌組存檔送的是整個 deck 物件、含 `cost`：
   *
   *     socket.emit("db_editdeck", id, deck1, deck2, deck3, checked)
   *
   * 而 `refresh_penalties` 會把我們算的 total 寫回 `deck.cost`。少了出站還原，
   * 我們的數字就會被送上伺服器 —— 那是這整個功能唯一會踩到 §12 的地方。
   */
  it("腳本裡有 db_editdeck 的攔截，而且會還原成原始 getCost 的值", () => {
    const script = buildPenaltyPatchScript({ bands: OFFICIAL, bindingName: "x" });
    expect(script).toContain("db_editdeck");
    expect(script).toContain("__ulrOriginalGetCost");
  });

  it("還原時是淺拷貝，不會就地改場景還在用的那份", () => {
    // 就地改的話，畫面上的數字會在存檔那一瞬間跳回原版。
    const script = buildPenaltyPatchScript({ bands: OFFICIAL, bindingName: "x" });
    const at = script.indexOf('event !== "db_editdeck"');
    expect(at).toBeGreaterThan(-1);
    const body = script.slice(at, at + 900);
    expect(body).toContain("var clone = {}");
    expect(body).not.toMatch(/args\[i\]\.cost\s*=/);
  });

  it("進站只動 db_deck，不會誤傷 db_editdeck", () => {
    const script = buildPenaltyPatchScript({ bands: OFFICIAL, bindingName: "x" });
    expect(script).toContain('event.indexOf("db_deck") !== 0');
    // "db_editdeck" 不是以 "db_deck" 開頭 —— 這一條是這個判斷成立的前提
    expect("db_editdeck".indexOf("db_deck")).not.toBe(0);
  });
});

describe("回報辨識", () => {
  it("認得自己的回報，不認得別人的", () => {
    expect(isPenaltyPatchReport({ type: "penalty-patch", moduleId: "1", bands: 2 })).toBe(true);
    expect(isPenaltyPatchReport({ type: "penalty-patch-error", reason: "x" })).toBe(true);
    expect(isPenaltyPatchReport({ type: "cost-patch" })).toBe(false);
    expect(isPenaltyPatchReport(null)).toBe(false);
  });
});
