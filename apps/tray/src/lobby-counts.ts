/**
 * 「我自己」要算在哪一檔
 * ========================
 * 大廳那四行人數是**問中間人**問來的（`/qn`，最多 15 秒一次），而玩家排進去
 * 或退出來這件事**插件自己第一個知道**。這支就是把這兩個時間點對齊。
 *
 * 少了它的症狀是玩家 2026-08-19 回報的那兩句：
 *
 *     按下快速比賽 → 等待視窗開始跳秒數，而那一檔還寫著「0 位玩家等待中」
 *     按下取消     → 那一檔還寫著 1，要等一輪輪詢才掉下來
 *
 * 兩句都是同一件事：畫面上那個數字比插件手上的事實舊一輪。而亞歷山卓城不會
 * 這樣 —— 那邊是伺服器推的，按下去的當下數字就動了。
 *
 * ## 為什麼不是「按下去就去問一次」
 *
 * 試過，那條路有一個競態贏不了：`q-hello` 還在飛的時候問回來的答案**還沒把我
 * 算進去**，而取消時反過來 —— 線才剛關，對面多半還算著我。兩邊都會得到一個
 * 「看起來沒反應」的畫面，而且是機率性的，最難查的那一種。
 *
 * 這裡改成算的：中間人講的那一份保持原樣，顯示時再把「我」放到對的位置。
 * 中間人只要回答「**其他人**有幾個」這件事就夠了，而那個數字慢 15 秒沒關係。
 */

/** 一檔的身分。`open` 是 `COST90+` 那一種（`tier` 是下限不是上限）。 */
export interface TierRef {
  tier: number;
  open: boolean;
}

/** 一檔的等待人數。跟 `@ulr/cdp-adapter` 的 `LobbyTierCount` 同形狀。 */
export interface TierCount {
  tier: number;
  waiting: number;
  open?: boolean;
}

export function sameTier(a: TierRef | null, b: TierRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tier === b.tier && a.open === b.open;
}

function isTier(count: TierCount, ref: TierRef | null): boolean {
  return ref !== null && count.tier === ref.tier && (count.open === true) === ref.open;
}

export interface DisplayCountsInput {
  /** 中間人上一次講的那一份。`null` = 還沒問到（畫面那幾行要整個不畫）。 */
  counts: readonly TierCount[] | null;
  /** **問那一次的當下**我排在哪一檔。`null` = 那時沒排。 */
  fetchedWhileIn: TierRef | null;
  /** **現在**我排在哪一檔。`null` = 沒排。 */
  nowIn: TierRef | null;
}

/**
 * 畫面上要顯示的數字。
 *
 * ```
 *   問的當下沒排、現在排著   那一檔 +1   ← 剛按下快速比賽
 *   問的當下排著、現在沒排   那一檔 −1   ← 剛按取消
 *   兩邊同一檔               不動        ← 穩定狀態，中間人講什麼就是什麼
 * ```
 *
 * ⚠ **我排著的那一檔至少是 1。** 中間人完全可能還沒處理完我的 `q-hello`
 * （按下去的當下我們就順手問了一次），那時它會誠實地回 0 —— 但「我人就在
 * 裡面」這件事不需要問任何人。
 *
 * ⚠ **不會回負數。** 中間人那份可能比我的動作還新（它已經把我扣掉了），
 * 那時再扣一次就會變 −1，而畫面會出現「-1 位玩家等待中」。
 */
export function displayCounts(input: DisplayCountsInput): TierCount[] | null {
  const { counts, fetchedWhileIn, nowIn } = input;
  if (counts === null) return null;
  if (nowIn === null && fetchedWhileIn === null) return [...counts];

  const moved = !sameTier(nowIn, fetchedWhileIn);
  return counts.map((c) => {
    let n = c.waiting;
    if (moved) {
      if (isTier(c, fetchedWhileIn)) n -= 1;
      if (isTier(c, nowIn)) n += 1;
    }
    if (isTier(c, nowIn)) n = Math.max(n, 1);
    return { ...c, waiting: Math.max(0, n) };
  });
}

/**
 * 玩家按下快速比賽時排進了哪一檔。
 *
 * 兩個入口（大廳按鈕、托盤的配對頁）給的是同一組參數，所以判斷寫在這裡一份。
 * ⚠ 兩個都是 `null` 代表「沒有檔位」—— 那不該發生，回 `null` 讓呼叫端當成
 * 「不知道我在哪一檔」，畫面就完全照中間人講的走。
 */
export function tierOf(args: {
  costLimit: number | null;
  costFloor: number | null;
}): TierRef | null {
  if (args.costLimit !== null) return { tier: args.costLimit, open: false };
  if (args.costFloor !== null) return { tier: args.costFloor, open: true };
  return null;
}
