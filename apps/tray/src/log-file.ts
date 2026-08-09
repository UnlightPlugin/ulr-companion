/**
 * 把記錄寫到檔案（事後查得到）
 * ==============================
 * 記錄頁本來只存在**記憶體**裡（`main.ts` 的 `logLines`，上限 200 行）——
 * 關掉插件就什麼都沒了。
 *
 * ⚠ **那讓「事後查證」變成不可能。** 自動更新是靜默的，中間人是背景連的；
 * 真的出事時（更新來源被冒充、簽章驗不過、某天所有人的側通道同時斷掉），
 * 唯一能回答「什麼時候開始的、發生在誰身上」的東西就是這份記錄。留在記憶體
 * 裡等於「出事之後才發現自己沒有任何證據」。
 *
 * ⚠ **§12：這份檔案裡不得出現任何遊戲內容。** 寫進來的每一行都來自
 * `ArbiterEngine` 與 `updater` 的 `onLog`，那兩個來源本來就只講狀態不講內容
 * （房號印出來的也是截短的雜湊）。**要在這裡加新的 log 之前先確認這一點** ——
 * 檔案跟記憶體不同，玩家會把它整個貼給你，而貼出去的東西收不回來。
 *
 * 這也是為什麼 README 敢跟內測者說「設置 › 記錄那一頁可以直接貼」。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 單一檔案的大小上限，超過就輪替一次（`.1` 保留上一份，只留一份）。
 *
 * 1 MB 大約是幾萬行。再多的話對排查沒有幫助，卻會變成一個慢慢長大的檔案 ——
 * 插件是常駐程式，沒有上限的 log 遲早會變成別人磁碟上的問題。
 */
const MAX_BYTES = 1024 * 1024;

export interface LogFile {
  path: string;
  write: (line: string) => void;
}

/**
 * 開一份記錄檔。**任何一步失敗都退回「不寫」，絕不影響仲裁。**
 *
 * 寫 log 失敗（磁碟滿了、防毒鎖住檔案）不該讓玩家在對戰中失去保護 ——
 * 這條跟 `profiles.ts` 存檔失敗時的處理是同一個原則。
 */
export function openLogFile(dir: string): LogFile {
  const path = join(dir, "companion.log");
  let broken = false;

  const rotate = (): void => {
    try {
      if (existsSync(path) && statSync(path).size > MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // 輪替失敗就繼續往同一個檔案寫 —— 比停止記錄好。
    }
  };

  return {
    path,
    write: (line: string): void => {
      if (broken) return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        rotate();
        // ⚠ 一定要有時間戳。沒有的話這份檔案回答不了「什麼時候開始的」，
        // 而那正是出事時第一個要問的問題。
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
      } catch {
        // 一直失敗就別再試了，免得每則 log 都吃一次例外。
        broken = true;
      }
    },
  };
}
