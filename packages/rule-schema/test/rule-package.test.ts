import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRulePackage, loadRulePackage, shortHash } from "@ulr/rule-schema";
import type { CostRule } from "@ulr/rule-schema";

const SAMPLE = new URL("../test-vectors/rules/arcadia-balance-1.2.0.json", import.meta.url);
const rule = () => JSON.parse(readFileSync(SAMPLE, "utf8")) as CostRule;

/** 模擬走一趟 Discord：匯出成檔案文字，對方再讀進來 */
const roundTrip = (pkg: unknown) => loadRulePackage(JSON.parse(JSON.stringify(pkg)));

describe("規則包 .ulrcost.json", () => {
  it("匯出後再匯入，內容與 Hash 都對得上", () => {
    const pkg = createRulePackage(rule(), { exportedBy: "ulr-companion/0.0.0" });
    const r = roundTrip(pkg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.pkg.rule).toEqual(rule());
      expect(r.value.short).toBe(shortHash(pkg.contentHash));
      expect(r.value.short).toHaveLength(8);
    }
  });

  it("雙方拿到同一份規則就算出同一個短碼（§5.4 人工核對）", () => {
    const a = createRulePackage(rule());
    const b = createRulePackage(rule(), { exportedBy: "另一台電腦" });
    expect(shortHash(a.contentHash)).toBe(shortHash(b.contentHash));
  });

  /**
   * ⚠ 這一則以前的期望是相反的（「拒絕載入」）。改掉的理由寫在
   * `rule-package.ts` 的 `loadRulePackage` 註解裡：玩家 fork 規則的方式
   * 就是直接改包，硬擋只會讓檔案變成死檔，而且擋不住任何真的想動手腳的人。
   */
  it("直接改包 → 照載，Hash 重算，而且要講出來", () => {
    const pkg = createRulePackage(rule());
    const before = pkg.contentHash;
    pkg.rule.characters["WOLAND_L4"] = 15; // 直接改數字，contentHash 沒動

    const r = roundTrip(pkg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 內容照收
    expect(r.value.pkg.rule.characters["WOLAND_L4"]).toBe(15);
    // 碼跟著內容走，不是檔案裡宣稱的那個
    expect(r.value.contentHash).not.toBe(before);
    expect(r.value.short).toBe(shortHash(r.value.contentHash));
    // 而且回傳的 pkg 已經自洽 —— 寫回檔案就是一份正常的包
    expect(r.value.pkg.contentHash).toBe(r.value.contentHash);
    // 呼叫端要有辦法提醒「對手手上那份的碼不一樣了」
    expect(r.value.staleHash).not.toBeNull();
    expect(r.value.staleHash?.claimed).toBe(before);
  });

  it("沒改過的包不會被誤報成改過", () => {
    const r = roundTrip(createRulePackage(rule()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.staleHash).toBeNull();
  });

  /**
   * 重算是 private-test 專屬的。帶簽章的發布版一旦重算，簽章就等於被繞過。
   */
  it("非 private-test 的包 Hash 對不上 → 仍然拒絕載入", () => {
    const pkg = { ...createRulePackage(rule()), visibility: "published" as never };
    pkg.rule.characters["WOLAND_L4"] = 15;
    const r = roundTrip(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("hash.mismatch");
  });

  it("規則內容本身不合法 → 在檢查 Hash 之前就擋下", () => {
    const pkg = createRulePackage(rule());
    pkg.rule.version = "not-semver";
    const r = roundTrip(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rule.invalid");
  });

  it("未來版本的規則包 → 明確說不支援，而不是硬吃", () => {
    const pkg = { ...createRulePackage(rule()), packageVersion: 99 };
    const r = roundTrip(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("package.unsupportedVersion");
  });

  it("垃圾輸入不會 crash", () => {
    for (const bad of [null, 42, "字串", [], {}]) {
      expect(loadRulePackage(bad).ok).toBe(false);
    }
  });
});
