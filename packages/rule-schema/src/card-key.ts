/**
 * 四種卡的正規鍵
 * ================
 * 一副牌組是四張表組合出來的，而**只有兩張表的卡片自帶名字**：
 *
 * | 卡種 | 客戶端資料             | 自帶唯一鍵                        |
 * | ---- | ---------------------- | --------------------------------- |
 * | 角色 | `cc_asset.frames[]`    | ✅ `filename` —— `cc078_04`        |
 * | 怪物 | `mc_asset.frames[]`    | ✅ `filename` —— `mc001_01`        |
 * | 裝備 | `avatar_item.weapon[]` | ❌ 只有陣列索引                    |
 * | 事件 | `event_info.frames[]`  | ❌ 只有陣列索引                    |
 *
 * 客戶端自己也是照索引查的（實測 2026-08-16 的 `unlight-common` bundle）：
 *
 * ```js
 * EventData.get = function (index) { return EventData.eventJSON.frames[index] ?? null; };
 * AvatarItem.get = function (type, index) { return AvatarItem.itemJSON[type][index]; };
 * ```
 *
 * 所以裝備與事件卡的鍵只能從索引來。這支負責那個轉換，**而且是唯一的一份** ——
 * 兩處各寫一次 pad 的話，某天有人改成 4 位數，症狀會是「規則明明一樣卻說不相容」。
 *
 * ## 為什麼索引當鍵是可以接受的
 *
 * 索引不只是陣列位置，**它同時是材質的 frame 名**（2026-08-16 實測）：
 *
 * ```
 * event_info.frames  110 筆  ←→  event_asset 材質 110 格，名字 "0"…"109"
 * avatar_item.weapon 238 筆  ←→  item_weapon 材質 240 格，且 weapon[i].frame === i
 * ```
 *
 * 官方要在中間插一張卡，就得連美術圖集一起重新編號 —— 換句話說，索引的穩定性
 * 是被遊戲自己的資產綁住的，不是我們的一廂情願。新卡歷來都是往後接。
 *
 * ⚠ 但這不是保證。改版後鍵對不上會由 `patch-cost` 的 `unknownKeys` 報出來
 * （UI 有警告），那是刻意的降級路徑：查不到的卡算 99C，很醒目，不會靜靜地
 * 讓一副超標的隊伍看起來合法。
 */

/** 裝備鍵的前綴。`avatar_item.weapon[1]` → `wp001` */
export const EQUIPMENT_KEY_PREFIX = "wp";

/** 事件卡鍵的前綴。`event_info.frames[91]`（聖水）→ `ev091` */
export const EVENT_CARD_KEY_PREFIX = "ev";

/**
 * 索引補零到幾位。
 *
 * 3 位 = 0…999，而目前是 238 件裝備、110 張事件卡，留了四倍以上餘裕。
 * ⚠ 超過 999 的索引**不截斷也不改補法**，直接變成 4 位（`wp1000`）——
 * 改補零位數會讓所有既有的鍵一次全部失效，那比多一位數難處理得多。
 */
export const CARD_INDEX_PAD = 3;

/** 前綴 + 補零的索引。負數或非整數一律拋錯 —— 那代表呼叫端拿到的不是索引。 */
function indexKey(prefix: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`卡片索引必須是非負整數，收到 ${String(index)}`);
  }
  return prefix + String(index).padStart(CARD_INDEX_PAD, "0");
}

/** `avatar_item.weapon` 的陣列索引 → 規則鍵。 */
export function equipmentKey(index: number): string {
  return indexKey(EQUIPMENT_KEY_PREFIX, index);
}

/** `event_info.frames` 的陣列索引 → 規則鍵。 */
export function eventCardKey(index: number): string {
  return indexKey(EVENT_CARD_KEY_PREFIX, index);
}

/**
 * 規則鍵 → 陣列索引。認不得就回 `null`。
 *
 * ⚠ **不接受沒補零的寫法**（`wp1`）。手改規則檔的人一定會漏補，而兩種寫法
 * 都收的話，同一張卡會有兩個鍵 —— 一份規則裡同時出現 `wp1` 與 `wp001` 時，
 * 誰蓋掉誰取決於物件的鍵順序，而那正是「兩台電腦算出不同數字」的來源。
 * 回 `null` 會讓它變成 `unknownKeys` 裡的一筆，玩家看得到。
 */
function parseIndexKey(prefix: string, key: string): number | null {
  if (!key.startsWith(prefix)) return null;
  const digits = key.slice(prefix.length);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < CARD_INDEX_PAD) return null;
  // 補零之外的前導零同樣不接受（`wp0001`）—— 理由同上，一張卡一個鍵。
  if (digits.length > CARD_INDEX_PAD && digits.startsWith("0")) return null;
  return Number(digits);
}

export function parseEquipmentKey(key: string): number | null {
  return parseIndexKey(EQUIPMENT_KEY_PREFIX, key);
}

export function parseEventCardKey(key: string): number | null {
  return parseIndexKey(EVENT_CARD_KEY_PREFIX, key);
}

/**
 * 把「鍵 → COST」的表換成「陣列索引 → COST」。
 *
 * 給 `patch-cost` 用：注入到頁面裡的腳本只認得索引，**刻意不讓它知道
 * `wp`／`ev` 這套命名**（同 `patch-cost.ts` 對角色表的做法 —— 規則鍵到
 * 客戶端鍵的轉換一律在呼叫端做完）。
 *
 * 認不得的鍵**不是丟掉，而是收進 `unmapped`**。丟掉等於靜靜地少算，
 * 而規格書 §9 明訂不得靜默產生錯誤資料。
 */
export function toIndexTable(
  table: Readonly<Record<string, number>> | undefined,
  parse: (key: string) => number | null,
): { byIndex: Record<string, number>; unmapped: string[] } {
  const byIndex: Record<string, number> = {};
  const unmapped: string[] = [];
  for (const [key, cost] of Object.entries(table ?? {})) {
    const index = parse(key);
    if (index === null) {
      unmapped.push(key);
      continue;
    }
    byIndex[String(index)] = cost;
  }
  return { byIndex, unmapped };
}
