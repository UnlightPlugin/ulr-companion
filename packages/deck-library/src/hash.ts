/**
 * 牌組的內容 hash（WP-18）
 * =========================
 * 同步靠它：**編輯完就上傳，另一端比對 hash，只拉改過的那幾副**。整份庫塞來
 * 塞去的話，兩台電腦交替使用時每次都要搬全部的牌組，而且「誰比較新」會變成
 * 猜的。
 *
 * 格式跟 `@ulr/rule-schema` 的規則 hash 對齊：`sha256:` 前綴 + hex。
 *
 * ⚠ **這支用 `node:crypto`，只能在托盤跑。** 雲端那頭（`apps/link-worker`）
 * 不算 hash，它只存客戶端算好的那個字串 —— 這樣 Worker 不必碰 crypto，也
 * 不必理解牌組的格式。
 */

import { createHash } from "node:crypto";
import type { DeckContent, DeckEntry } from "./types.js";

/**
 * 牌組內容的確定性字串。
 *
 * 自己攤平而不是 `JSON.stringify(物件)`，理由跟 `serializeLibrary` 一樣：
 * key 順序跟著建構過程跑，同一副牌組會算出不同的 hash，然後每次同步都誤判
 * 成「改過了」。
 *
 * 空格一律寫成 `-`，這樣 `null` 跟 `undefined` 算出來是同一個東西 ——
 * 存檔往返之後空格的表示法可能會變，那不該算成內容有變動。
 */
export function deckContentCanonical(content: DeckContent): string {
  const cell = (v: unknown): string => (v === null || v === undefined ? "-" : String(v));
  return [
    content.chara.map(cell).join(","),
    content.charaIndex.map(cell).join(","),
    content.weapon.map(cell).join(","),
    content.eventIndex.map(cell).join(","),
  ].join("|");
}

function sha256(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/**
 * **只看內容**的 hash。兩副牌一不一樣就看這個 —— 拿來擋「新增了一副跟現有
 * 完全一樣的牌組」很好用。
 */
export function deckContentHash(content: DeckContent): string {
  return sha256(deckContentCanonical(content));
}

/**
 * **同步用**的 hash：名字 + 渦 BOSS 標籤 + 內容。
 *
 * ⚠ 名字一定要算進去。只改名不改牌的話 `deckContentHash` 不會變，那另一端
 * 永遠拉不到新名字 —— 而症狀是「我在家裡改的名字，公司這台沒跟上」。標籤
 * （規格 §12）同理：只改標籤也算改過。
 *
 * ⚠ `updatedAt` **不算進去**。它是拿來判斷誰比較新的，算進 hash 的話同一副
 * 牌組每存一次就變一個 hash，增量同步就退化成每次全拉。
 *
 * ⚠ 標籤進來之前就該排好序（`setDeckBosses` 與 `parseEntry` 都會排）。這裡
 * **不排** —— 在這裡補排的話，「上游忘了正規化」這個 bug 就永遠看不出來。
 */
export function deckEntryHash(entry: Pick<DeckEntry, "name" | "content" | "bosses">): string {
  return sha256(`${entry.name} ${entry.bosses.join(",")} ${deckContentCanonical(entry.content)}`);
}
