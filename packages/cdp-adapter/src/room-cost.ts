/**
 * 房間場景的 `cost:NN` 該顯示哪個數字
 * ===================================
 *
 * 大廳／任務／渦房牌組縮圖下那個 `cost:NN` 讀的是 `deck1.cost`，遊戲**只在載入
 * 時信任這個欄位、從不重算**（`change_deck` 直接 `setText("cost:" + deck.cost)`）。
 * 所以每一個會把 `deck1` 換掉的地方都得自己把這個數字算對 —— 而插件裡有**三個**
 * 這樣的地方：進房預載（`patch-room-gate`）、換牌的快路徑（`deck-write` 的房間
 * 分支）、提交到伺服器之後的記憶體同步（`deck-write` 的慢路徑）。
 *
 * ## 2026-09-12 迪城回報：「COST 不正確，變來變去」
 *
 * 三個地方原本各算各的：
 *
 * ```
 *   進房預載／快路徑   __ulrDeckEdit.costFor(deck, false)   → 官方  91
 *   慢路徑             snapshot 裡上一副的 cost               → 上一副 110
 *   遊戲自己 init()    db_deck1 → 罰則補丁改寫成自訂          → 自訂  92
 * ```
 *
 * 同一副牌在同一個畫面上輪流出現三個數字。
 *
 * ## 正確答案：**跟牌盒上那個數字一樣**，而牌盒是照房型畫的
 *
 * 牌盒（`patch-deck-edit`）每一副旁邊畫哪一種總 COST 由 `@ulr/deck-library` 的
 * `ROOM_COST_DISPLAY` 決定：亞歷山卓城畫「官方 N」（配對與伺服器判定用官方價）、
 * 迪特赫姆畫「自訂 N」（那裡打的是插件規則）、任務／渦不畫（PVE 沒有上限）。
 * 玩家對照的就是牌盒 —— 2026-09-12 同一天兩則回報：迪城「牌盒寫 92、畫面 91」、
 * 亞城「牌盒寫官方 79、畫面 80（自訂）」。所以房間那個 `cost:NN` 就照同一張表：
 *
 * ```
 *   dietherm            自訂價   costFor(deck, true)
 *   其他（含 null）     官方價   costFor(deck, false)
 * ```
 *
 * 用的是牌盒自己的 `costFor()`，所以**兩邊永遠是同一個算法算出來的同一個數字**。
 * 曾經試過「跟遊戲自己顯示的一樣」（罰則補丁的 `Deck.getCost()`）—— 那在亞城
 * 會是自訂價，跟牌盒的「官方 N」對不上，2026-09-12 當天就被打回來。
 *
 * ⚠ 罰則補丁把進站 `db_deck{n}` 的 cost 改寫成自訂價，所以場景 `init()` 剛載進
 * 來那一刻的 `deck1.cost` 是自訂的；這裡只管我們自己換進去的那一副，而玩家在
 * 房裡看到的一定是換過的那份（預載在 `create()` 之前就跑了）。
 *
 * ⚠ 這裡算出來的數字**只進客戶端記憶體**，不上伺服器。出站的 `db_editdeck`
 * 由 `patch-penalty` 還原成原版值（§12 硬規則 4）。
 *
 * ⚠⚠ 這段住在 template literal 裡，**不能出現反引號**。
 */

/**
 * 定義兩支：
 *
 * - `ulrRoomOfScene(name, sc)`：場景 → 房型鍵（`quest`／`raid`／`alexandria`／
 *   `dietherm`），Match 還沒選頻道或不是房間場景回 `null`。頻道看 `type` 不看
 *   編號，跟 `patch-room-gate` 的 `currentRoom()` 同一條規矩。
 * - `ulrRoomCostOf(deck, room)`：算不出來回 `null`，呼叫端自己決定退路。
 */
export const ROOM_COST_SNIPPET = `
  function ulrRoomOfScene(name, sc) {
    if (name === "Quest") return "quest";
    if (name === "Raid") return "raid";
    if (name !== "Match" || !sc) return null;
    if (sc.channel === undefined || sc.channel === null) return null;
    var key = String(sc.channel);
    var info = (sc.channels && sc.channels[key]) || (sc.channels_cross && sc.channels_cross[key]);
    if (!info) return null;
    return info.type === "duel" ? "dietherm" : "alexandria";
  }

  function ulrRoomCostOf(deck, room) {
    var custom = room === "dietherm";
    try {
      var api = window.__ulrDeckEdit;
      if (api && typeof api.costFor === "function") {
        var c = api.costFor(deck, custom);
        if (typeof c === "number" && isFinite(c)) return c;
      }
    } catch (e) {}
    // 牌盒還沒掛上時的退路：罰則補丁留在頁面上的 Deck.getCost()。它裝著時算的
    // 就是自訂價，所以只在要自訂價時才問它 —— 要官方價時問它會拿到自訂的。
    if (custom) {
      try {
        var p = window.__ulrPenaltyPatch;
        if (p && p.installed === true && typeof p.costOf === "function") {
          var c2 = p.costOf(deck);
          if (typeof c2 === "number" && isFinite(c2)) return c2;
        }
      } catch (e) {}
    }
    return null;
  }
`;
