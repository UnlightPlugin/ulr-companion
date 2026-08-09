/**
 * 簽一份發布清單
 * ================
 *
 *     npm run release:sign -- --version 0.2.0 \
 *       --file "out/release/ULR Companion Setup 0.2.0.exe" \
 *       --url  "https://github.com/UnlightPlugin/ulr-companion/releases/download/v0.2.0/ULR.Companion.Setup.0.2.0.exe" \
 *       [--notes "一行說明"] [--key <私鑰路徑>]
 *
 * 它會算安裝檔的 SHA-256、用私鑰簽名，然後把整段印出來讓你貼進
 * `apps/link-worker/src/release.ts`。
 *
 * ⚠ **簽的是 `canonicalize(manifest)` 的 UTF-8 位元組** —— WP-01 那套 JCS 正規化
 * （`@ulr/rule-schema`）。客戶端 `update-verify.ts` 用同一支重算一次。重用它
 * 而不是自己定序列化格式，理由跟當初一樣：**兩邊對不上時不會報錯，只會安靜
 * 驗不過**，而那種 bug 極難查。
 *
 * ⚠ **要用 tsx 跑**（`npm run release:sign`），才 import 得動 .ts。
 */

import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalBytes } from "../packages/rule-schema/src/canonical.ts";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const version = flag("version");
const file = flag("file");
const url = flag("url");
const notes = flag("notes");
const keyPath = flag("key") ?? join(homedir(), ".ulr-release-key", "ulr-release.private.pem");

const missing = [
  version === undefined ? "--version" : null,
  file === undefined ? "--file" : null,
  url === undefined ? "--url" : null,
].filter((x) => x !== null);
if (missing.length > 0) {
  console.error(`✗ 缺少參數：${missing.join(" ")}`);
  console.error("  用法見這支的檔頭。");
  process.exit(1);
}

if (!existsSync(keyPath)) {
  console.error(`✗ 找不到私鑰：${keyPath}`);
  console.error("  還沒產生的話先跑：node scripts/keygen-release.mjs");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`✗ 找不到安裝檔：${file}`);
  console.error("  先跑 npm run dist。");
  process.exit(1);
}

// ⚠ 網址必須是 https。客戶端那邊也會擋一次（`updater.ts` 的白名單），
// 這裡先擋是為了讓錯誤在發版當下就看得見，而不是等玩家更新失敗。
if (!url.startsWith("https://")) {
  console.error(`✗ 安裝檔網址必須是 https://，收到 ${url}`);
  process.exit(1);
}

const bytes = readFileSync(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");

const manifest = {
  version,
  url,
  sha256,
  ...(notes === undefined ? {} : { notes }),
};

const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
// ⚠ Ed25519 的演算法參數必須是 null —— 它自己就規定了雜湊函式。
const signature = sign(null, Buffer.from(canonicalBytes(manifest)), privateKey).toString("base64");

console.log(`  安裝檔  ${file}`);
console.log(`  大小    ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`  SHA-256 ${sha256}`);
console.log("");
console.log("貼進 apps/link-worker/src/release.ts：");
console.log("");
console.log(
  `export const CURRENT_RELEASE: SignedRelease | null = ${JSON.stringify(
    { manifest, signature },
    null,
    2,
  )};`,
);
console.log("");
console.log("然後 npm --workspace apps/link-worker run deploy");
console.log("⚠ 先把安裝檔上傳到上面那個網址，再部署 —— 順序顛倒的話玩家會下載到 404。");
