/**
 * 簽一份預設 COST 表
 * ====================
 *
 *     npm run rules:sign -- --file rules/tomorin-squeeze-band-1C.ulrcost.json \
 *       [--notes "一行說明"] [--key <私鑰路徑>]
 *
 * 它會驗規則包、用私鑰簽名，然後**直接寫好** `apps/link-worker/src/rule-data.ts`。
 * 接著 `npm --workspace apps/link-worker run deploy` 就發出去了。
 *
 * ⚠ **簽的是 `canonicalize(manifest)` 的 UTF-8 位元組**，跟發布清單同一套
 * （WP-01 的 JCS）。客戶端 `update-verify.ts` 的 `verifySignedRuleFeed()` 用
 * 同一支重算一次 —— 兩邊對不上時**不會報錯，只會安靜地驗不過**。
 *
 * ⚠ **版本沒往上跳就發不出去。** 客戶端只往新版走（那是防重播的那一道），
 * 所以版本相同的規則發了也不會擴散，而且完全沒有錯誤訊息。這支會擋下來。
 *
 * ⚠ **要用 tsx 跑**（`npm run rules:sign`），才 import 得動 .ts。
 */

import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes } from "../packages/rule-schema/src/canonical.ts";
import { loadRulePackage } from "../packages/rule-schema/src/rule-package.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const file = flag("file") ?? "rules/tomorin-squeeze-band-1C.ulrcost.json";
const notes = flag("notes");
const keyPath = flag("key") ?? join(homedir(), ".ulr-release-key", "ulr-release.private.pem");
const target = join(root, "apps", "link-worker", "src", "rule-data.ts");

if (!existsSync(keyPath)) {
  console.error(`✗ 找不到私鑰：${keyPath}`);
  console.error("  還沒產生的話先跑：node scripts/keygen-release.mjs");
  process.exit(1);
}
const rulePath = join(root, file);
if (!existsSync(rulePath)) {
  console.error(`✗ 找不到規則檔：${rulePath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(rulePath, "utf8"));

// ⚠ 先驗規則包本身。簽章保證「這是我們發的」，不保證「這是對的」——
// 一份簽對了但內容壞掉的規則發出去，玩家端會每小時載入失敗一次。
const parsed = loadRulePackage(pkg);
if (!parsed.ok) {
  console.error(`✗ 規則包不合規格：[${parsed.code}] ${parsed.message}`);
  process.exit(1);
}
const rule = parsed.value.pkg.rule;

// ⚠ 版本要比正在發布的那份新。少了這一關，最常見的手滑是「改了 cost 卻忘了
// 跳版本」—— 發布成功、玩家永遠收不到，而且兩邊都沒有錯誤訊息。
if (existsSync(target)) {
  // ⚠ 鍵是**帶引號**的（那段是 JSON.stringify 出來的）。寫成 `version:\s*"` 的話
  // 永遠配不到，`current` 一直是 undefined —— 整個 if 被跳過，這道關卡等於不存在。
  // 2026-08-20 發現時它已經這樣很久了，而症狀正是它自己要防的那個：安靜地沒作用。
  const current = /"version":\s*"([^"]+)"/.exec(readFileSync(target, "utf8"))?.[1];
  if (current !== undefined && !isNewer(rule.version, current)) {
    console.error(`✗ 版本沒有往上跳：正在發布的是 ${current}，這份是 ${rule.version}`);
    console.error("  客戶端只往新版走（防重播），版本沒動的話發了也不會擴散。");
    process.exit(1);
  }
}

function isNewer(candidate, current) {
  const parse = (v) => {
    const core = String(v).trim().split("-")[0] ?? "";
    const parts = core.split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const manifest = {
  ruleSetId: rule.ruleSetId,
  version: rule.version,
  package: pkg,
  ...(notes === undefined ? {} : { notes }),
};

const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
// ⚠ Ed25519 的演算法參數必須是 null —— 它自己就規定了雜湊函式。
const signature = sign(null, Buffer.from(canonicalBytes(manifest)), privateKey).toString("base64");

const header = `/**
 * **這個檔案是產生出來的，不要手改。**
 *
 *     npm run rules:sign -- --file ${file}
 *
 * 手改的話簽章就對不上了，而症狀是玩家端安靜地收不到規則（驗章失敗只會在
 * 他的記錄檔留一行）。要改規則請改 ${file} 再重簽一次。
 */

import type { SignedRuleSet } from "./rules.js";

export const SIGNED_RULE: SignedRuleSet = ${JSON.stringify({ manifest, signature }, null, 2)};
`;

writeFileSync(target, header, "utf8");

console.log(`  規則    ${rule.name} ${rule.version}（${rule.ruleSetId}）`);
console.log(`  角色    ${Object.keys(rule.characters).length} 筆`);
console.log(`  核對碼  ${parsed.value.short}`);
console.log(`  大小    ${(JSON.stringify(manifest).length / 1024).toFixed(1)} KB`);
console.log("");
console.log(`✓ 已寫入 ${target}`);
console.log("  接著：npm --workspace apps/link-worker run deploy");
