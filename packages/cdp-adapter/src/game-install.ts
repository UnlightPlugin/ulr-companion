/**
 * 找出遊戲裝在哪，以及目前是哪一種客戶端
 * ==========================================
 * 遊戲有兩種客戶端，靠**換掉 `resources\app.asar`** 切換，一次只有一種生效：
 *
 *     網頁版（約 150KB）—— 拿 Steam ticket 換 token，丟給瀏覽器後自己退出
 *     桌面版（約 400MB）—— Electron 自己把遊戲開在視窗裡
 *
 * 沒啟用的那個通常被改名放在同一個目錄（社群的切換腳本各有各的命名，
 * 所以這裡**只認體積、不認檔名**）。
 *
 * 為什麼要偵測：`refreshBundles()` 靠「從 Steam 開一次、看瀏覽器載了什麼」來取得
 * 當前版本的檔名。目前是桌面版的話，遊戲**根本不經過瀏覽器**，那支會傻等到逾時
 * 才失敗，而且訊息看起來像網路問題。先檢查一下就能立刻講清楚。
 *
 * 這裡只做**唯讀**判斷。切換模式會動到遊戲檔案，那是另一回事，不該藏在
 * 「讀個檔名」這種操作底下。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 網頁版與桌面版的體積差三個數量級，用大小分辨綽綽有餘。 */
const WEB_ASAR_MAX_BYTES = 10 * 1024 * 1024;

export type ClientMode = "web" | "desktop";

export interface GameInstall {
  /** `…\UNLIGHTRevive\win-unpacked\resources` */
  resourcesDir: string;
  mode: ClientMode;
  activeAsarBytes: number;
}

/** Steam 的預設安裝位置與 `libraryfolders.vdf` 裡列出的其他磁碟。 */
function steamLibraryRoots(): string[] {
  const roots = new Set<string>();
  for (const base of [
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    process.env["ProgramFiles"] ?? "C:\\Program Files",
  ]) {
    roots.add(join(base, "Steam"));
  }

  // libraryfolders.vdf 是純文字，只要把 "path" 的值撈出來就夠了 ——
  // 為了一個檔案引入 VDF parser 不划算。
  for (const root of [...roots]) {
    const vdf = join(root, "steamapps", "libraryfolders.vdf");
    if (!existsSync(vdf)) continue;
    try {
      const text = readFileSync(vdf, "utf8");
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const p = m[1];
        if (p !== undefined) roots.add(p.replace(/\\\\/g, "\\"));
      }
    } catch {
      // 讀不到就跳過。找不到安裝位置不是致命錯誤，呼叫端會處理 null。
    }
  }
  return [...roots];
}

/**
 * 找出遊戲的 `resources` 目錄並判斷目前是哪一種客戶端。
 *
 * 找不到就回 `null` —— 玩家可能裝在非標準位置，那不該讓整個指令失敗，
 * 頂多是少了一個提早報錯的機會。
 */
export function detectGameInstall(): GameInstall | null {
  for (const root of steamLibraryRoots()) {
    const resourcesDir = join(
      root,
      "steamapps",
      "common",
      "UNLIGHTRevive",
      "win-unpacked",
      "resources",
    );
    const asar = join(resourcesDir, "app.asar");
    if (!existsSync(asar)) continue;
    try {
      const bytes = statSync(asar).size;
      return {
        resourcesDir,
        mode: bytes <= WEB_ASAR_MAX_BYTES ? "web" : "desktop",
        activeAsarBytes: bytes,
      };
    } catch {
      continue;
    }
  }
  return null;
}
