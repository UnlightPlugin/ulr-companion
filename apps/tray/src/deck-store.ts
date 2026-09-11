/**
 * 牌組庫的落地（WP-18）
 * ======================
 * 一個帳號一個檔，放在插件自己的資料夾底下：
 *
 * ```
 *   %APPDATA%\ulr-companion\decks\decks-3f2a1c04.json          ← 牌組庫
 *   %APPDATA%\ulr-companion\decks\decks-3f2a1c04.backup.json   ← 第一次接上時的原樣三副
 * ```
 *
 * ⚠ 檔名裡的是**帳號指紋**（玩家 id 的 SHA-256 前 8 個 hex），不是 id 也不是
 * 玩家名稱 —— 規格書 §12。`libraryFileName()` 已經替我們決定了這件事，這裡
 * 不要自己組檔名。
 *
 * ⚠ **不放 userData 底下。** 那一層是依埠分開的（多開用），而牌組庫是跟著
 * **帳號**走的東西：同一個帳號從桌面版換到網頁版，看到的該是同一份牌組。
 *
 * ## 備份只寫一次，而且永遠不覆蓋
 *
 * `applyDecks()` 會覆寫玩家的三副牌組，而原版介面沒有「復原」。所以第一次
 * 讀到這個帳號時先把原樣的三副抄一份下來 —— **之後不再動它**。每次都覆蓋的話,
 * 玩家發現不對勁時，備份裡裝的已經是插件寫進去的東西了。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckSnapshot } from "@ulr/cdp-adapter";
import type { DeckLibrary } from "@ulr/deck-library";
import { emptyLibrary, libraryFileName, parseLibrary, serializeLibrary } from "@ulr/deck-library";

/** 牌組庫放哪。 */
export function deckDir(appDir: string): string {
  return join(appDir, "decks");
}

export function libraryPath(appDir: string, account: string): string {
  return join(deckDir(appDir), libraryFileName(account));
}

export function backupPath(appDir: string, account: string): string {
  return join(deckDir(appDir), libraryFileName(account).replace(/\.json$/, ".backup.json"));
}

/**
 * 讀這個帳號的牌組庫。
 *
 * **沒有檔案不是錯誤**，那是這個帳號第一次用 —— 回一份空的庫。`dropped` 是
 * 解析時丟掉幾副（壞掉的那幾副），呼叫端該把它講出來，不要安靜地吞掉。
 */
export function readLibrary(
  appDir: string,
  account: string,
  accountLabel?: string,
): { library: DeckLibrary; dropped: number; existed: boolean } {
  const path = libraryPath(appDir, account);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      library:
        accountLabel === undefined ? emptyLibrary(account) : emptyLibrary(account, accountLabel),
      dropped: 0,
      existed: false,
    };
  }
  const parsed = parseLibrary(raw, account);
  // 玩家改過名字的話跟上 —— 這一欄純粹給人看，不參與任何判斷。
  if (accountLabel !== undefined) parsed.library.accountLabel = accountLabel;
  return { ...parsed, existed: true };
}

export function writeLibrary(appDir: string, library: DeckLibrary): void {
  mkdirSync(deckDir(appDir), { recursive: true });
  writeFileSync(libraryPath(appDir, library.account), `${serializeLibrary(library)}\n`, "utf8");
}

/**
 * 把原樣的三副抄一份下來。**已經有備份就什麼都不做**（見檔頭）。
 *
 * 回傳有沒有真的寫 —— 呼叫端拿它決定要不要在記錄裡講一句。
 */
export function backupOnce(appDir: string, snapshot: DeckSnapshot): boolean {
  const path = backupPath(appDir, snapshot.account);
  if (existsSync(path)) return false;
  mkdirSync(deckDir(appDir), { recursive: true });
  const body = {
    account: snapshot.account,
    accountLabel: snapshot.accountLabel,
    savedAt: new Date().toISOString(),
    note: "插件第一次接上這個帳號時，伺服器上原本的三副牌組。插件不會再動這個檔。",
    deckCheck: snapshot.deckCheck,
    favorite: snapshot.favorite,
    decks: snapshot.decks,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return true;
}
