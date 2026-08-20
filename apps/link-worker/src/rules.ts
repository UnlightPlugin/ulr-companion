/**
 * 目前發布的預設 COST 表（發規則時**只改這一支**與它 import 的資料檔）
 * ======================================================================
 * `release.ts` 的同胞：形狀刻意做得一樣，因為插件那邊的信任鏈是同一條
 * （同一把 Ed25519 公鑰、同一套 RFC 8785 正規化、同樣「只往新版走」）。
 *
 * 差別只有一個，而且是刻意的：**規則包整份帶在清單裡**，不是 url + sha256。
 * 安裝檔有 82 MB 所以只能給網址；規則包 30 KB，帶著走就少掉一整條路徑
 * ——下載、網址白名單、雜湊比對，以及「清單發出去了但檔案還沒上傳」那個
 * 順序陷阱（見 `release.ts` 檔頭那個 ⚠）。
 *
 * ## 發一份新規則的完整流程
 *
 * 1. 用插件的「編輯 COST」改 `rules/tomorin-squeeze-band-1C.ulrcost.json`
 * 2. **把 `version` 往上跳** —— 客戶端只往新版走，版本沒動的話發了也不會擴散
 * 3. 簽它：
 *
 *    ```
 *    npm run rules:sign -- --file rules/tomorin-squeeze-band-1C.ulrcost.json \
 *      [--notes "一行說明"]
 *    ```
 *
 * 4. 它會直接寫好 `rule-data.ts`，然後 `npm --workspace apps/link-worker run deploy`
 *
 * ⚠ **安裝包裡那份也是同一個檔案**（`scripts/build-tray.mjs` 複製過去的）。
 * 所以「發布的規則」與「新玩家裝到的規則」不會漂移 —— 那種漂移的症狀是
 * 兩個玩家的預設規則內容不同、版本號卻一樣，而畫面上完全看不出來。
 */

import { SIGNED_RULE } from "./rule-data.js";

export interface RuleManifest {
  /** 規則族 —— `publisherSlug/ruleSlug`。⚠ 客戶端**只收同一族**的更新。 */
  ruleSetId: string;
  version: string;
  /** 規則包本體（`.ulrcost.json` 的內容）。簽章蓋的就是它。 */
  package: unknown;
  /** 會被寫進玩家的記錄頁，一行就好。 */
  notes?: string;
}

/**
 * 清單 + 它的 Ed25519 簽章。
 *
 * ⚠⚠ **這個 Worker 完全不碰私鑰**（同 `release.ts`）。它只是把在本機簽好的
 * 東西原封不動端出去 —— 整套簽章的價值就在於「這台被入侵也推不出規則」。
 */
export interface SignedRuleSet {
  manifest: RuleManifest;
  signature: string;
}

/**
 * 目前發布的預設規則。**`null` = 還沒發過**，那時 `/rules` 要回 404。
 *
 * ⚠ 回一份空清單會讓客戶端每小時判定一次「有新規則」然後失敗一次。404 是
 * 正常狀態，客戶端看到非 2xx 就安靜結束 —— 那正是我們要的行為。
 */
export const CURRENT_RULE_SET: SignedRuleSet | null = SIGNED_RULE;
