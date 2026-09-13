/**
 * 目前發布的是哪一版（發版時**只改這一支**）
 * ============================================
 * `apps/tray/src/updater.ts` 每小時來要一次這份清單，比對版本號決定要不要
 * 下載。它的形狀刻意做得很小 —— 欄位越多，壞掉的方式越多。
 *
 * ## 發一版的完整流程
 *
 * 1. `apps/tray/package.json` 的 `version` 往上跳
 * 2. `npm run dist` → `out/release/ULR Companion-<版本>-win.zip`
 * 3. 複製成 `ULR-Companion-<版本>-win.zip`（不帶空白）上傳到 GitHub Releases。
 *    ⚠ **只發 zip，不再附 exe**（2026-09-14 起）。
 * 4. 簽它（順便算 SHA-256）：
 *
 *    ```
 *    npm run release:sign -- --version 2.1.0 \
 *      --file out/release/ULR-Companion-2.1.0-win.zip \
 *      --url  "https://github.com/…/releases/download/v2.1.0/ULR-Companion-2.1.0-win.zip"
 *    ```
 *
 * 5. 把它印出來的那一段貼到下面，`npm --workspace apps/link-worker run deploy`
 *
 * ⚠ **順序不能顛倒。** 先改這裡再上傳的話，中間那段時間所有玩家會下載到 404，
 * 而 `updater.ts` 只會安靜地當作「這次沒更新」—— 你不會知道有這回事。
 *
 * ⚠ **`sha256` 不是選填的。** 少了它 `fetchManifest()` 會整份丟掉。下載回來的
 * 是**會被執行的東西**，「來源是 HTTPS」不足以當作它沒被換過的理由。
 */

export interface ReleaseManifest {
  version: string;
  /** 發布檔的網址（2.0.0 起是 zip；客戶端照副檔名選套用方式）。 */
  url: string;
  /** 發布檔的 SHA-256（64 個十六進位字元，小寫）。 */
  sha256: string;
  /** 會被寫進玩家的記錄頁，一行就好。 */
  notes?: string;
}

/**
 * 清單 + 它的 Ed25519 簽章。
 *
 * ⚠ **簽章放在清單外面。** 放進去的話「簽章要不要算進被簽的內容」會變成先有雞
 * 還是先有蛋的問題，而每個實作都會給出不一樣的答案。
 *
 * ⚠⚠ **這個 Worker 完全不碰私鑰。** 它只是把你在本機簽好的東西原封不動端出去。
 * 整套簽章的價值就在於「這台被入侵也推不出更新」—— 私鑰只要出現在這裡，
 * 那個價值就歸零。
 */
export interface SignedRelease {
  manifest: ReleaseManifest;
  /** base64 的 Ed25519 簽章。 */
  signature: string;
}

/**
 * 目前發布的版本。**`null` = 還沒發過任何一版。**
 *
 * ⚠ 這時候 `/update` 要回 404，不是回一份假的清單。`updater.ts` 看到非 2xx
 * 就當作「這次沒更新」然後安靜結束 —— 那正是我們要的行為。回一份 version 是
 * 空字串的清單反而會讓它每小時判定一次「有新版」。
 */
// ⚠ **2.0.0 起 url 指 .zip。** 1.1.0 起的客戶端照副檔名選路，兩種都吃；而指 exe
// 的話，解 zip 安裝的人會被 NSIS 裝到 %LOCALAPPDATA% 另一份、原本那份永遠停在舊版。
// 代價是還停在 1.0.0 的人（只認得 exe）收不到這一版、要手動下載一次 ——
// Release notes 有寫。詳見 docs/release.md §2。
export const CURRENT_RELEASE: SignedRelease | null = {
  manifest: {
    version: "2.0.0",
    url: "https://github.com/UnlightPlugin/ulr-companion/releases/download/v2.0.0/ULR-Companion-2.0.0-win.zip",
    sha256: "e12e7b69c60cdc0429c8569f5f5f8d8a878ccccaf41ac747c5f409a906432892",
    notes: "牌組庫與雲端同步、渦的獎勵標記與結算通知、畫面設定、Chrome／Edge 網頁版",
  },
  signature:
    "nluXDZehbblBkBmXsdbcJbSaX36Y/ZCV0vyAXGBIavloJR+gz7+UYBESpadzsTcXDzzvX2k5HJAuJgPEsWXBDw==",
};

// 發版時把上面那行換成 `npm run release:sign` 印出來的那一段（形狀如下，
// 保留這段當範本，不要刪）：
//
// export const CURRENT_RELEASE: SignedRelease | null = {
//   manifest: {
//     version: "2.1.0",
//     url: "https://github.com/UnlightPlugin/ulr-companion/releases/download/v2.1.0/ULR-Companion-2.1.0-win.zip",
//     sha256: "……64 個十六進位字元……",
//     notes: "中間人改用雲端；Steam 啟動選項教學",
//   },
//   signature: "……base64……",
// };
