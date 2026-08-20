/**
 * 目前發布的是哪一版（發版時**只改這一支**）
 * ============================================
 * `apps/tray/src/updater.ts` 每小時來要一次這份清單，比對版本號決定要不要
 * 下載。它的形狀刻意做得很小 —— 欄位越多，壞掉的方式越多。
 *
 * ## 發一版的完整流程
 *
 * 1. `apps/tray/package.json` 的 `version` 往上跳
 * 2. `npm run dist` → `out/release/ULR Companion Setup <版本>.exe`
 * 3. 把安裝檔上傳到 GitHub Releases
 * 4. 簽它（順便算 SHA-256）：
 *
 *    ```
 *    npm run release:sign -- --version 0.2.0 \
 *      --file "out/release/ULR Companion Setup 0.2.0.exe" \
 *      --url  "https://github.com/…/ULR.Companion.Setup.0.2.0.exe"
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
  /** 安裝檔的網址。 */
  url: string;
  /** 安裝檔的 SHA-256（64 個十六進位字元，小寫）。 */
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
// ⚠ **1.1.0 的 url 還是 .exe，即使這一版的主力下載是 zip。** 1.0.0 的客戶端
// 只認得 exe（它會把 zip 下載回來、驗完雜湊，然後 `spawn(zip, ["/S"])` 失敗），
// 而那批人正是要靠這份清單升上來的人。zip 給新玩家從 Release 頁自己抓。
// 等大家都在 1.1.0 以上之後，下一版才可以只發 zip。詳見 docs/release.md §2。
export const CURRENT_RELEASE: SignedRelease | null = {
  manifest: {
    version: "1.1.0",
    url: "https://github.com/UnlightPlugin/ulr-companion/releases/download/v1.1.0/ULR-Companion-Setup-1.1.0.exe",
    sha256: "3fae8df48ddd5c42a8440909cc27ea0fd4a4d0ebb623ec5a4ea8a288eb7941a8",
    notes: "迪城大廳多一顆快速比賽、裝上就有預設 COST 表、戰鬥結束後不再留著握手",
  },
  signature:
    "WpsowY7hNoCAPD1oeVAS4kYhY0kc9WInUktmJre4sa9WOAGtG0tZ238POiq38TRc91UdsHWD2S2R4dA2x1CbAg==",
};

// 發版時把上面那行換成 `npm run release:sign` 印出來的那一段（形狀如下，
// 保留這段當範本，不要刪）：
//
// export const CURRENT_RELEASE: SignedRelease | null = {
//   manifest: {
//     version: "0.2.0",
//     url: "https://github.com/UnlightPlugin/ulr-companion/releases/download/v0.2.0/ULR.Companion.Setup.0.2.0.exe",
//     sha256: "……64 個十六進位字元……",
//     notes: "中間人改用雲端；Steam 啟動選項教學",
//   },
//   signature: "……base64……",
// };
