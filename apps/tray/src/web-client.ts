/**
 * 網頁版（Chrome／Edge）的登入擴充
 * ================================
 * **Steam 登入擴充**（`assets/steam-login-extension/`）—— 在擴充裡登入 Steam 帳號，
 * 它向 Steam 拿 UNLIGHT 的票證、跟遊戲換一顆 access_token，再開官方網址。
 * 原始檔跟著安裝包走，按一下放到固定的資料夾。
 *
 * ⚠ 這是別人寫的擴充，**原樣**收進來（說明：`STEAM_EXT_GUIDE_URL`），上游更新時整包
 * 蓋過去，不要在 repo 裡改它。
 *
 * ⚠ 取代了 ULR Boot（重建官方外殼、只帶 steamid 直開）。2026-10-15 官方開始驗
 * access_token 之後那條路登不進去，見 memory unlight-2026-10-15-access-token。
 *
 * 這條路本身**不需要**除錯埠；插件需要。所以開瀏覽器那一步（`ensureBrowser`、
 * `buildBrowserLaunchCmd`）另外在 cdp-adapter。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 擴充放哪。**固定一個地方**，不讓玩家挑。
 *
 * ⚠ 「載入未封裝項目」記的是**資料夾路徑**：之後插件更新時再放一次，就是原地
 * 蓋過去，玩家到擴充功能頁按一下重新載入即可。每次都挑一個新地方的話，舊的那份
 * 還掛在瀏覽器上、新的沒人載，而兩份看起來一模一樣。
 *
 * ⚠ 不沿用 ULR Boot 的 `~/ulr-boot-extension`：已經載入那個資料夾的瀏覽器重新載入時
 * 會變成另一個擴充（manifest 帶 key，ID 跟著換），舊的那份也還會在 403 頁面搶著動手。
 * 分開放，玩家把 ULR Boot 移除就乾淨了。
 */
export const STEAM_EXT_DIR = join(homedir(), "ulr-steam-login");

/** 擴充的安裝與使用說明（社群維護）。 */
export const STEAM_EXT_GUIDE_URL = "https://hackmd.io/@MhdVPsfqTFK6l2Nfr7s8sg/H1psUhxhMe";

/** 資料夾裡那份擴充的版本。沒裝或讀不懂回 `null`。 */
export function extVersion(dir: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: unknown };
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

export interface ExtExport {
  dir: string;
  version: string | null;
}

/** 整個資料夾照樣複製（含 `icons/`）。原本就有的檔只蓋同名的，資料夾不清空。 */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

/** 把擴充放到 `dest`。 */
export function exportExtension(src: string, dest: string): ExtExport {
  copyTree(src, dest);
  return { dir: dest, version: extVersion(dest) };
}
