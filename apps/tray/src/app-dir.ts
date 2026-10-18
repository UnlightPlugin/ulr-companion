import { join } from "node:path";
import { app } from "electron";

/**
 * 插件自己的資料夾。**記錄檔就直接放在這裡**：
 *
 *     %APPDATA%\ulr-companion\companion.log
 *
 * ⚠ 以前是 `ulr-companion\port-59222\companion.log`。那一層是給多開用的，
 * 但代價落在**所有人**身上：請玩家貼記錄時得先教他那個資料夾叫什麼，而那個
 * 名字裡還有一個他從來沒設過的數字（現在大家都用 `--remote-debugging-port=0`，
 * 那個埠更是連聽都沒人在聽）。一句「打開 %APPDATA%\ulr-companion」就該結束的事，
 * 不值得多一層。
 *
 * 獨立成一支（2026-10-18）：卡面那段在模組載入時就要用它組路徑。`appData` 不受
 * main.ts 設的 userData 影響，所以比 main.ts 本體早算出來也一樣。
 */
export const APP_DIR = join(app.getPath("appData"), "ulr-companion");
