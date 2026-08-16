/**
 * 規則包信封（.ulrcost.json）
 * =============================
 * 規格書 §5.4 私人約測策略：
 *   - 副檔名 .ulrcost.json
 *   - 檔案內含 ruleSetId、testVersion、作者、內容、Hash 與適用遊戲版本
 *   - 雙方透過 Discord 傳同一檔案；插件顯示 Hash 前 8～12 碼供人工核對
 *
 * 為什麼要有信封：Hash 是「對規則內容算出來的」，把 Hash 塞進規則內容本身
 * 會變成雞生蛋。所以分兩層 —— 內層 rule 是被雜湊的對象，外層信封帶 Hash
 * 和傳輸用的中繼資料。
 */

import { contentHash, hashEquals, shortHash } from "./hash.js";
import type { CostRule } from "./types.js";
import { validateCostRule } from "./validate.js";

export const RULE_PACKAGE_EXTENSION = ".ulrcost.json";

export interface RulePackage {
  /** 信封格式版本，跟 rule.schemaVersion 是兩回事 */
  packageVersion: 1;
  /** 私人測試包標記。公開發布版由 ULGG 給 ruleVersionId，這裡沒有。 */
  visibility: "private-test";
  rule: CostRule;
  /** rule 的 canonical JSON 之 SHA-256，格式 "sha256:…" */
  contentHash: string;
  exportedAt: string;
  /** 匯出這個檔案的插件版本，方便追診斷 */
  exportedBy?: string;
}

/** 檔案裡宣稱的 Hash 跟內容對不上 —— 這個包被直接編輯過。 */
export interface StaleHash {
  /** 檔案裡原本寫的（完整格式） */
  claimed: string;
  /** 原本寫的那個的前 8 碼，給訊息用 */
  claimedShort: string;
}

export interface LoadedRulePackage {
  /**
   * ⚠ `contentHash` 已經**換成重算的值**，不是檔案裡那個。要把它寫回檔案的
   * 話直接序列化這個物件就對了。
   */
  pkg: RulePackage;
  /** 給人眼核對用，例如 "7c91a23f"。**一律重算**，見下面 `loadRulePackage`。 */
  short: string;
  /** 重算出來的完整 contentHash */
  contentHash: string;
  /** 檔案宣稱的 Hash 跟內容不符時的原值。`null` = 本來就相符。 */
  staleHash: StaleHash | null;
}

export type LoadResult =
  { ok: true; value: LoadedRulePackage } | { ok: false; code: LoadErrorCode; message: string };

export type LoadErrorCode =
  "package.malformed" | "package.unsupportedVersion" | "rule.invalid" | "hash.mismatch";

/** 把一份已驗證的規則打包成可以丟 Discord 的檔案內容 */
export function createRulePackage(
  rule: CostRule,
  options: { exportedBy?: string; now?: Date } = {},
): RulePackage {
  const pkg: RulePackage = {
    packageVersion: 1,
    visibility: "private-test",
    rule,
    contentHash: contentHash(rule),
    exportedAt: (options.now ?? new Date()).toISOString(),
  };
  if (options.exportedBy !== undefined) pkg.exportedBy = options.exportedBy;
  return pkg;
}

/**
 * 讀取規則包。**Hash 一律從內容重算，不採信檔案裡宣稱的那個。**
 *
 * ## 為什麼從「不符就拒絕」改成「重算」
 *
 * 這支原本的規矩是：宣稱的 Hash 跟內容對不上就硬失敗（§9「內容不符 Hash
 * 時拒絕載入」）。實際跑起來之後那條規矩是**反效果**的，理由有兩層：
 *
 * **1. 玩家改 COST 的方式就是直接改包。** 規則包是一個攤開的 JSON，700 個
 * 角色的數字全在裡面 —— 拿到一份就 fork 一版來改是唯一自然的做法，沒有人
 * 會先去 unpack 一個「沒有 Hash 的裸規則」再改。舊行為讓這件事的結果是
 * 「檔案再也打不開」，而且 unpack 跟 pack 也一起拒收，等於玩家的心血變成
 * 死檔。2026-08-15 就是這樣被回報的（「選了沒反應」）。
 *
 * **2. 拒絕載入根本擋不住它想擋的東西。** private-test 的包沒有簽章，
 * `contentHash` 是自己寫給自己的 —— 真要動手腳的人改完內容再 `pack` 一次
 * 就有一個「自洽」的包，硬檢查一秒都攔不住。它唯一攔得住的是**手滑**，
 * 而攔的方式是讓檔案作廢。
 *
 * 那「假 VALID」的疑慮怎麼辦？**把宣稱值整個丟掉就沒有了。** 真正危險的
 * 是相反的方向 —— 採信宣稱值：`ruleHash` 是配對鍵（`@ulr/arbiter-link` 的
 * `matchCriteria`），一份被改過的規則若頂著原版的 Hash 去排隊，就會跟拿著
 * **原版**的人配在一起，兩邊的數字其實不同，那才是貨真價實的假 VALID。
 * 重算之後，改過的規則自然得到自己的鍵，只配得到內容逐位元相同的人。
 *
 * 所以：內容驗證（schema）仍然是硬失敗，Hash 則是**衍生值**，永遠跟著內容走。
 * 呼叫端要提醒玩家「這份包被改過、核對碼變了」就看 `staleHash`。
 *
 * ⚠ 例外：`visibility` 不是 `private-test` 的包（未來 ULGG 發布、帶簽章的
 * 版本）**不能重算** —— 那時候 Hash 是簽章蓋住的東西，重算等於把簽章繞過去。
 */
export function loadRulePackage(input: unknown): LoadResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "package.malformed", message: "規則包必須是 JSON 物件" };
  }

  const pkg = input as Partial<RulePackage>;

  if (pkg.packageVersion !== 1) {
    return {
      ok: false,
      code: "package.unsupportedVersion",
      message: `不支援的規則包版本 ${String(pkg.packageVersion)}，這個插件只認得 1`,
    };
  }

  if (typeof pkg.contentHash !== "string") {
    return { ok: false, code: "package.malformed", message: "缺少 contentHash" };
  }

  const validation = validateCostRule(pkg.rule);
  if (!validation.valid) {
    const lines = validation.issues.map((i) => `${i.path}: ${i.message}`).join("；");
    return { ok: false, code: "rule.invalid", message: `規則內容不合法 —— ${lines}` };
  }

  const computed = contentHash(validation.rule);
  const matches = hashEquals(computed, pkg.contentHash);

  // 帶簽章的發布版不在重算的適用範圍內 —— 見上面最後那段。
  if (!matches && pkg.visibility !== "private-test") {
    return {
      ok: false,
      code: "hash.mismatch",
      message:
        `這是 ${String(pkg.visibility)} 的規則包，內容與宣稱的 Hash 不符` +
        `（宣稱 ${shortHash(pkg.contentHash)}，實際 ${shortHash(computed)}）。` +
        `發布版的 Hash 不會重算，請跟發布者要一份完整的檔案。`,
    };
  }

  return {
    ok: true,
    value: {
      // ⚠ 回去的 pkg 帶的是**重算後**的 Hash。呼叫端把它寫回檔案，
      // 檔案就自洽了 —— 這正是「改完自動重算」的落點。
      pkg: { ...(pkg as RulePackage), rule: validation.rule, contentHash: computed },
      short: shortHash(computed),
      contentHash: computed,
      staleHash: matches
        ? null
        : { claimed: pkg.contentHash, claimedShort: shortHash(pkg.contentHash) },
    },
  };
}
