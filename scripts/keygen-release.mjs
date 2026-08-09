/**
 * 產生發布簽章金鑰（**只做一次**）
 * ==================================
 *
 *     node scripts/keygen-release.mjs [輸出目錄]
 *
 * 產生一對 Ed25519 金鑰：
 *
 *   私鑰 → 寫到你指定的目錄（預設 `%USERPROFILE%\.ulr-release-key\`）
 *   公鑰 → 印出來，貼進 `apps/tray/src/update-key.ts`
 *
 * ⚠⚠ **私鑰不要放進專案資料夾。** `.gitignore` 雖然擋掉 `*.pem`，但那只是
 * 最後一道；真正的規則是它根本不該在那裡。它也**不該進 CI、不該上
 * Cloudflare** —— 整套簽章的價值就在於「伺服器被入侵也推不出更新」，
 * 私鑰只要出現在伺服器上，那個價值就歸零。
 *
 * ⚠⚠ **備份它，離線備份。** 私鑰遺失 = 所有已經裝好的插件永遠收不到更新
 * （它們帶的是舊公鑰，驗不過新金鑰簽的任何一份清單），而且畫面上什麼都不會說。
 * 唯一的救法是叫每個玩家手動重新下載。
 *
 * ⚠ 這支**不會覆寫**已經存在的私鑰。要換金鑰得自己先把舊的移走 ——
 * 那是一個不可逆的決定，不該由一個手滑的指令完成。
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), ".ulr-release-key");
const privatePath = join(dir, "ulr-release.private.pem");
const publicPath = join(dir, "ulr-release.public.pem");

if (existsSync(privatePath)) {
  console.error(`✗ 已經有一把私鑰了：${privatePath}`);
  console.error("");
  console.error("  這支不會覆寫它 —— 換金鑰會讓所有既有安裝永遠收不到更新。");
  console.error("  真的要換的話，先自己把舊的移到別的地方。");
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), {
  encoding: "utf8",
  // 0o600：只有自己讀得到。Windows 上 Node 對這個支援有限，所以下面還是要提醒。
  mode: 0o600,
});
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
writeFileSync(publicPath, publicPem, "utf8");

console.log(`✓ 私鑰  ${privatePath}`);
console.log(`✓ 公鑰  ${publicPath}`);
console.log("");
console.log("下一步：把下面這一行貼進 apps/tray/src/update-key.ts");
console.log("");
console.log(`export const UPDATE_PUBLIC_KEY = ${JSON.stringify(publicPem)};`);
console.log("");
console.log("⚠ 私鑰請離線備份。遺失 = 所有既有安裝永遠收不到更新。");
console.log("⚠ 不要把它放進專案資料夾、CI 或 Cloudflare。");
