/**
 * 網頁版（Chrome／Edge）要用到的兩件東西
 * ==========================================
 * 1. **ULR Boot 擴充功能** —— 用書籤開網頁版。原始檔跟著安裝包走
 *    （`assets/ulr-boot-extension/`），按一下放到固定的資料夾。
 * 2. **竄改猴的說明** —— 那條路的腳本不是我們的，只給連結。
 *
 * 兩條路都**不需要**除錯埠；插件需要。所以開瀏覽器那一步（`ensureBrowser`、
 * `buildBrowserLaunchCmd`）另外在 cdp-adapter。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 擴充放哪。**固定一個地方**，不讓玩家挑。
 *
 * ⚠ 「載入未封裝項目」記的是**資料夾路徑**：之後插件更新時再放一次，就是原地
 * 蓋過去，玩家到擴充功能頁按一下重新載入即可。每次都挑一個新地方的話，舊的那份
 * 還掛在瀏覽器上、新的沒人載，而兩份看起來一模一樣。
 *
 * 跟 ulr-boot-dist 那支 .cmd 用的是同一個位置，已經照那份裝好的人不用重裝。
 */
export const BOOT_EXT_DIR = join(homedir(), "ulr-boot-extension");

/** 竄改猴那條路的安裝說明（社群維護）。 */
export const USERSCRIPT_GUIDE_URL = "https://hackmd.io/@MhdVPsfqTFK6l2Nfr7s8sg/B1ReQ8w_ee";

/** 資料夾裡那份擴充的版本。沒裝或讀不懂回 `null`。 */
export function bootExtVersion(dir: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: unknown };
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

/**
 * 遊戲字型可能在哪。
 *
 * 2026-09-23 起 main.js 會先等五個 `ulfont://app/fonts/…` 載完（`shell.js` 把它改指到
 * 擴充自己的 `fonts/`）。那五個檔 96MB，**不跟安裝包走**：玩家裝著桌面版的話直接
 * 從他自己的遊戲裡拿。拿不到也沒關係 —— `shell.js` 讓載入失敗放行，只是退回系統字。
 *
 * ⚠ 路徑穿進 `app.asar` 裡面是故意的：Electron 主程序的 `fs` 讀得進 asar。
 * 舊版客戶端放在 `public/fonts`，新版在 `fonts`，兩個都看。
 */
export function gameFontDirs(resourcesDir: string): string[] {
  return [
    join(resourcesDir, "app.asar", "fonts"),
    join(resourcesDir, "app.asar", "public", "fonts"),
    join(resourcesDir, "app", "fonts"),
    join(resourcesDir, "app", "public", "fonts"),
  ];
}

export interface BootExtExport {
  dir: string;
  version: string | null;
  /** 字型目錄裡現在有幾個檔（含之前就放好的）。0 = 會用系統字。 */
  fonts: number;
}

/**
 * 把擴充放到 `dest`。原本就有的檔**只蓋我們自己的那幾個**，資料夾不清空。
 *
 * 字型只在缺檔或大小不同時才複製 —— 96MB，每按一次就重寫一次沒有意義。
 * `fontSources` 依序找，第一個有檔的就用。
 */
export function exportBootExtension(
  src: string,
  dest: string,
  fontSources: readonly string[] = [],
): BootExtExport {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!statSync(from).isFile()) continue;
    writeFileSync(join(dest, name), readFileSync(from));
  }

  const fontDest = join(dest, "fonts");
  const fontSrc = fontSources.find((d) => {
    try {
      return readdirSync(d).some((f) => /\.(otf|ttf|ttc|woff2?)$/i.test(f));
    } catch {
      return false;
    }
  });
  if (fontSrc !== undefined) {
    mkdirSync(fontDest, { recursive: true });
    for (const name of readdirSync(fontSrc)) {
      if (!/\.(otf|ttf|ttc|woff2?)$/i.test(name)) continue;
      const from = join(fontSrc, name);
      const to = join(fontDest, name);
      if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
      writeFileSync(to, readFileSync(from));
    }
  }

  let fonts = 0;
  try {
    fonts = readdirSync(fontDest).length;
  } catch {
    // 沒有字型資料夾 = 0
  }
  return { dir: dest, version: bootExtVersion(dest), fonts };
}
