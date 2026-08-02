/**
 * 把資料安全地嵌進要注入的腳本
 * ==============================
 * 原本住在 `patch-cost.ts`，`boot-shell.ts` 也要用，所以抽出來。
 *
 * 做法：先 `JSON.stringify` 成字串，再包成 JS 字串字面值，頁面端用
 * `JSON.parse` 讀回來。
 *
 * 為什麼不直接寫成物件字面值（原版 patch_cost.js 的 `__JSON_DATA__` 做法）：
 * 在 JS **物件字面值**裡 `"__proto__": x` 會去設原型而不是新增屬性，
 * `JSON.parse` 則會當成一般屬性。嵌進去的是外部資料，不該有辦法碰到原型。
 */

/**
 * 要在嵌入時改寫成跳脫序列的字元。
 *
 * - U+2028 / U+2029：在 ES2019 之前的 JS 字串字面值裡不合法
 * - `<`：萬一有人把產生出來的腳本塞進 `<script>` 標籤
 *
 * 用 `fromCharCode` 產生那兩個 code point，原始碼裡不出現字面字元 ——
 * 它們在編輯器裡完全看不見，被剪貼簿或 Unicode 正規化弄掉的話這道保險
 * 會靜默失效。`packages/rule-schema/test/canonical.test.ts` 為了同樣的
 * 理由也是這樣寫。
 */
const NEEDS_ESCAPE = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}<]`, "g");

export function embedJson(value: unknown): string {
  const literal = JSON.stringify(JSON.stringify(value));
  return literal.replace(
    NEEDS_ESCAPE,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
