/**
 * 卡片名冊的快取
 * ================
 * 編輯 COST 的介面要顯示的是「艾伯李斯特 L4」而不是 `cc078_04`，而那份對照
 * 只有玩家自己跑著的客戶端知道（見 `@ulr/rule-schema` 的 catalog.ts）。
 *
 * 這支負責它的壽命：
 *
 * ```
 *   遊戲開著 ──讀四張表 + 兩份 profile──▶ buildCatalog() ──▶ 家目錄的快取檔
 *                                                                │
 *   遊戲沒開 ───────────────────────────────────────────────────┘
 *                                              編輯器照樣打得開
 * ```
 *
 * **為什麼一定要能離線用**：玩家調 COST 表是坐下來慢慢改的事，不會為了改一個
 * 數字先開遊戲。第一次接上遊戲時自動抓一份，之後就一直有得用。
 *
 * 放家目錄而不是專案裡：這是**這台機器上這個遊戲版本**的狀態，跟 bundle 快取
 * 同一個道理（`apps/companion/src/bundle-cache.ts`）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CardCatalog } from "@ulr/rule-schema";
import { parseCatalog } from "@ulr/rule-schema";

export const CATALOG_PATH = join(homedir(), ".ulr-companion", "catalog.json");

/**
 * 讀快取。**沒有、壞掉、版本不對一律回 `null`** —— 那時該做的是重讀，
 * 不是讓插件開不起來。名冊是純顯示用的資料，缺了只是變得難用，不是壞掉。
 */
export function readCatalog(path: string = CATALOG_PATH): CardCatalog | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseCatalog(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeCatalog(catalog: CardCatalog, path: string = CATALOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}
