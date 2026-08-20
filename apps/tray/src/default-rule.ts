/**
 * 預設 COST 規則
 * ================
 * 插件裝上去就**已經套好一份規則**，玩家不必先去選檔。這跟這個專案原本的
 * 立場（「插件裝上去不該改變玩家在遊戲裡看到的數字」）是相反的，而那是刻意
 * 改掉的：自訂 COST 規則要成為一個環境，就不能要求每個人先做一次設定 ——
 * 那一步是絕大多數人不會做的那一步。
 *
 * ## 兩份檔案，兩個角色
 *
 * ```
 *   烤進安裝包的     dist/rules/default.ulrcost.json     ← 一定存在，離線也有
 *   中間人發下來的   %APPDATA%\ulr-companion\rules\default.ulrcost.json
 * ```
 *
 * 有快取就用快取（那是比較新的那份），沒有就用烤進去的。**兩份都壞掉才算
 * 沒有預設規則** —— 那時退回「沒選規則」，不是讓插件開不起來。
 *
 * ⚠ 快取那份是 `rule-feed.ts` 驗過簽章之後才寫下來的。**這裡不再驗一次**，
 * 因為它已經在我們自己的 `%APPDATA%` 底下 —— 能改它的人也能改插件本體，
 * 再驗一次擋不到任何人。真正的信任邊界在「下載回來的東西寫不寫進去」。
 *
 * ## ⚠ 為什麼不是「複製一份到玩家的資料夾然後當成他選的檔」
 *
 * 那樣做的話規則更新永遠推不動：玩家的 `costRulePath` 指著他自己那一份，
 * 而我們發新版時**不敢覆寫玩家的檔案**（那可能是他自己編過的）。分成
 * 「預設」與「玩家選的檔」兩種模式之後，這件事就沒有歧義：
 * 預設模式跟著我們發的版本走，選了檔的人完全不受影響。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 烤進安裝包的那一份。**永遠存在** —— `scripts/build-tray.mjs` 會複製過去。
 *
 * ⚠ 路徑是相對 `__dirname`（打包後是 `dist/`，跟 `main.cjs` 同一層），不是相對
 * `process.cwd()` —— 玩家從開始功能表點開時 cwd 是 `C:\Windows\system32`。
 */
export function bundledRulePath(): string {
  return join(__dirname, "rules", "default.ulrcost.json");
}

/**
 * 中間人發下來的那一份存在哪。
 *
 * ⚠ **不在 `userData` 底下。** `userData` 是依埠分開的（多開），而規則跟著
 * 「這台電腦」走不跟著「哪一個遊戲客戶端」走 —— 放進去的話雙開的人會下載
 * 兩次、而且兩邊可能停在不同版本。
 */
export function cachedRulePath(appDir: string): string {
  return join(appDir, "rules", "default.ulrcost.json");
}

export function ensureRuleDir(appDir: string): string {
  const dir = join(appDir, "rules");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface DefaultRuleChoice {
  path: string;
  /** `feed` = 中間人發的（比較新），`bundled` = 安裝包裡那份。 */
  source: "feed" | "bundled";
}

/**
 * 現在該用哪一份預設規則。**兩份都不在就回 `null`**（不拋例外）。
 *
 * ⚠ 只看「檔案在不在」，不解析內容。內容壞掉的處理在 `loadCostRule()` ——
 * 那支已經有一整套「壞掉要講出來」的流程，這裡再寫一份會漂移。
 */
export function resolveDefaultRule(appDir: string): DefaultRuleChoice | null {
  const cached = cachedRulePath(appDir);
  if (existsSync(cached)) return { path: cached, source: "feed" };
  const bundled = bundledRulePath();
  if (existsSync(bundled)) return { path: bundled, source: "bundled" };
  return null;
}

/**
 * 快取那份宣稱的版本。比對「中間人發的是不是比較新」時要用。
 *
 * ⚠ 讀不到、壞掉、沒有版本一律回 `null` = 「當作沒有」。那會讓下一次檢查
 * 直接覆寫它，而那正是我們要的：一份讀不出版本的快取沒有任何保留價值。
 */
export function cachedRuleVersion(appDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachedRulePath(appDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const pkg = raw as Record<string, unknown>;
    const rule = pkg["rule"];
    if (typeof rule !== "object" || rule === null) return null;
    const version = (rule as Record<string, unknown>)["version"];
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
