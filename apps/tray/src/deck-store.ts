/**
 * 牌組庫的落地（WP-18）
 * ======================
 * 一個帳號一個檔，放在插件自己的資料夾底下：
 *
 * ```
 *   %APPDATA%\ulr-companion\decks\decks-3f2a1c04.json          ← 牌組庫
 *   %APPDATA%\ulr-companion\decks\decks-3f2a1c04.backup-v2.json ← 第一次接上時的原樣三副（改版後）
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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckSnapshot } from "@ulr/cdp-adapter";
import type { DeckLibrary } from "@ulr/deck-library";
import {
  absorbLibrary,
  emptyLibrary,
  libraryFileName,
  parseLibrary,
  serializeLibrary,
} from "@ulr/deck-library";

/** 牌組庫放哪。 */
export function deckDir(appDir: string): string {
  return join(appDir, "decks");
}

export function libraryPath(appDir: string, account: string): string {
  return join(deckDir(appDir), libraryFileName(account));
}

/**
 * 備份檔的路徑。
 *
 * ⚠ 2026-09-23 改版後另存一份（`.backup-v2.json`）：改版前的備份每個帳號都已經
 * 有了，照「只寫一次」的規矩就再也不會備份改版後的三副 —— 而插件模式第一次接上
 * 仍然會把 Deck2／Deck3 收進庫裡並清空。兩份格式也不一樣（索引 vs 卡片 id）。
 */
export function backupPath(appDir: string, account: string): string {
  return join(deckDir(appDir), libraryFileName(account).replace(/\.json$/, ".backup-v2.json"));
}

/** 牌組庫本體的檔名（不含備份、`.v1`、手動備份）。 */
const LIBRARY_FILE_RE = /^decks-([0-9a-f]{8})\.json$/;

/**
 * **同一個角色、舊指紋存下的那幾份庫**，新的在前。
 *
 * 2026-09-25 以前指紋是 `player_id` 的雜湊，而改版後 `player_id` 每次登入都換
 * （見 `@ulr/cdp-adapter` 的 `FINGERPRINT_SNIPPET`）—— 一個角色散成好幾個檔：
 * 改版前的那一份、改版後每登入一次一份。認人靠檔裡的 `accountLabel`（玩家名稱，
 * 遊戲裡改不了）。
 *
 * 「新」看檔案的修改時間：最後一次被存的那一份，就是玩家最後在用的那一份。
 */
export function findOrphanLibraries(
  appDir: string,
  account: string,
  accountLabel: string,
): { file: string; library: DeckLibrary; dropped: number; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(deckDir(appDir));
  } catch {
    return [];
  }
  const out: { file: string; library: DeckLibrary; dropped: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const m = LIBRARY_FILE_RE.exec(name);
    if (m === null || m[1] === account) continue;
    const path = join(deckDir(appDir), name);
    try {
      const parsed = parseLibrary(readFileSync(path, "utf8"), m[1] ?? account);
      if (parsed.library.accountLabel !== accountLabel) continue;
      out.push({
        file: name,
        library: parsed.library,
        dropped: parsed.dropped,
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch {
      // 讀不動的那一份跳過 —— 最壞是少收一份，不該擋住開機。
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 讀這個帳號的牌組庫。
 *
 * **沒有檔案不是錯誤**，那是這個帳號第一次用 —— 回一份空的庫。`dropped` 是
 * 解析時丟掉幾副（壞掉的那幾副），呼叫端該把它講出來，不要安靜地吞掉。
 *
 * ## ⚠ 沒有檔案時先找舊指紋的庫（`adopted`）
 *
 * 指紋在 2026-09-25 從 `player_id` 換成玩家名稱。換過來的第一次，新指紋一定沒有
 * 檔 —— 當成「第一次用」的話，玩家的牌組就全部不見了（被 Deck1 的四份複本取代）。
 * 所以先把同名的舊庫（{@link findOrphanLibraries}）併進來，**有併到東西就算
 * `existed`**：呼叫端不必再把 Deck1 收進四房（它多半已經在裡面了）。
 *
 * 舊檔原樣留著不動 —— 併錯了還有東西可以對照。
 */
export function readLibrary(
  appDir: string,
  account: string,
  accountLabel?: string,
): {
  library: DeckLibrary;
  dropped: number;
  migrated: number;
  existed: boolean;
  /** 從舊指紋的庫併進來的：幾個檔、幾副。沒併是 `null`。 */
  adopted: { files: string[]; decks: number } | null;
} {
  const path = libraryPath(appDir, account);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    const empty =
      accountLabel === undefined ? emptyLibrary(account) : emptyLibrary(account, accountLabel);
    if (accountLabel === undefined || accountLabel === "") {
      return { library: empty, dropped: 0, migrated: 0, existed: false, adopted: null };
    }
    let library = empty;
    let decks = 0;
    let dropped = 0;
    const files: string[] = [];
    for (const orphan of findOrphanLibraries(appDir, account, accountLabel)) {
      const r = absorbLibrary(library, orphan.library);
      library = r.library;
      decks += r.added;
      dropped += orphan.dropped;
      files.push(orphan.file);
    }
    if (decks === 0) {
      return { library: empty, dropped: 0, migrated: 0, existed: false, adopted: null };
    }
    return { library, dropped, migrated: 0, existed: true, adopted: { files, decks } };
  }
  const parsed = parseLibrary(raw, account);
  // 改版前的格式（資產索引）第一次被轉成新卡號時，原檔原樣留一份：轉完存回去
  // 就是新格式，舊版插件讀不懂，而轉換要是有錯也要有東西可以對照。只寫一次。
  if (parsed.migrated > 0) {
    const v1 = path.replace(/\.json$/, ".v1.json");
    try {
      if (!existsSync(v1)) writeFileSync(v1, raw, "utf8");
    } catch {
      // 備份失敗不擋讀檔 —— 最壞是少一份對照，牌組本身照常可用。
    }
  }
  // 玩家改過名字的話跟上 —— 這一欄純粹給人看，不參與任何判斷。
  if (accountLabel !== undefined) parsed.library.accountLabel = accountLabel;
  return { ...parsed, existed: true, adopted: null };
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
    note: "插件第一次接上這個帳號時（2026-09-23 改版後），伺服器上原本的三副牌組。插件不會再動這個檔。",
    deckNow: snapshot.deckNow,
    decks: snapshot.decks,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return true;
}
