/**
 * 本地牌組庫的資料模型（WP-18）
 * ==============================
 * 伺服器只給三副牌組，而且**擴不出第四副** —— 2026-08-24 實測：客戶端的
 * `DeckIndex` 常數寫死 `[1, 2, 3]`，而 `db_deck4` 伺服器根本不回應（`db_deck1`
 * 48ms 回，`db_deck4` 等 6 秒沒聲音）。伺服器沒有那張表，改客戶端只會讓它去
 * 要一個沒人認得的東西。
 *
 * 所以牌組庫走另一條路：**牌組存在本地，Deck1 當唯一的工作槽**，玩家換牌組時
 * 用 `db_editdeck` 即時覆寫 Deck1。
 *
 * ## ⚠ 換牌組會連帶換掉大廳立繪
 *
 * `Lobby.init` **寫死讀 Deck1**（2026-08-25 實測），而立繪只用第一格：
 *
 * ```js
 *   let r = await this.socket.fetch("db_deck1", this.id);   // ← 不是 player.deck
 *   this.deck = { chara: [r.chara1, r.chara2, r.chara3], … };
 *   // Lobby.loader:
 *   null === this.player.favorite
 *     ? load(get_stand_url(this.deck.chara[0]))          // 用 Deck1 第一格
 *     : (this.deck.chara[0] = this.player.favorite, …)   // 用「最愛」，Deck1 被無視
 * ```
 *
 * Deck1 是工作槽，所以**玩家每換一次牌組，大廳站的人就跟著換**。這不是 bug，
 * 是這個設計的必然結果 —— 玩家要固定立繪的話，去 Library 設「最愛角色」，
 * 設了之後 Deck1 寫什麼都不影響大廳。插件不管大廳，見 `deck-write.ts` 的
 * `DeckSnapshot.favorite`。
 *
 * ⚠ 而且是**進場景時**才讀，之後不重讀 —— 玩家已經站在大廳時寫進去，要等他
 * 離開再回來才看得到。
 *
 * ## 開戰時決定用哪一副的是 `deck_now`
 *
 * 2026-08-25 掃過所有場景，每一個開戰的 emit 都把 `deck_now`（1/2/3）帶上：
 *
 * ```
 *   Quest : emit("quest_start", id, map, region, index, deck_now)
 *   Match : emit("quick_wait", id, deck_now, channel)          ← 亞城快速比賽
 *           emit("room_in",    id, channel, room_id, …, deck_now)  ← 加入其他房
 *           emit("match_room_make", id, channel, …, deck_now)  ← 迪城開房
 *   Raid  : emit("raid_turn", id, raid_id, raid_turn, deck_now)
 * ```
 *
 * 三個場景的 `deck_now` **都在 init 時寫死成 1**，靠 ◀▶ 在 1..3 之間循環 ——
 * 也就是說玩家不去動那兩個箭頭的話，送出去的一直是 1，正好是我們的工作槽。
 * 規格 §13 的「開戰前攔截」就攔在這幾個 emit 上。
 *
 * ⚠ `player.deck` 這個欄位**沒有任何場景讀**，別拿它當「玩家現在用第幾副」。
 *
 * ## 為什麼這樣反而比三副好
 *
 * 卡片庫存是**三副共扣同一個池子**（`card_index.updateQuantity([deck1, deck2,
 * deck3])`）。2026-08-24 在實機上量到的例子：
 *
 * ```
 *   ev6   庫存 2   已放 2   剩 0      ← 兩張都卡在某一副裡，另外兩副用不到
 *   ev20  庫存 1   已放 1   剩 0
 * ```
 *
 * 把 Deck2/Deck3 清空之後，它們佔住的卡全部回到池子裡 —— 那張唯一的 `ev20`
 * 可以出現在本地的**每一副**牌組裡，因為同一時間只有一副真的躺在伺服器上。
 * 這是原版介面給不了的東西。
 *
 * ## ⚠ Deck1 的第一格永遠不能是空的
 *
 * Edit 畫面**兩個出口**（返回 Lobby、去 Compo）都是同一道檢查：
 *
 * ```js
 *   if (null === this.deck1.charaIndex[0]) { 彈錯誤面板，不放行 }
 *   else { scene_end().then(() => socket.emit("db_editdeck", ...)) }
 * ```
 *
 * 注意它**檢查失敗時根本不送 `db_editdeck`** —— 也就是說原版客戶端不可能把
 * 「Deck1 第一格為空」存進伺服器，所以伺服器那邊多半沒有這道檢查。插件繞過
 * 客戶端直接寫，一旦寫空，玩家進 Edit 就**兩個出口全被擋住，卡死在裡面**。
 *
 * 這條規則插件必須自己 100% 守住，不能指望伺服器兜底。見 `guardDeck1()`。
 */

/** 一副牌組的內容。就是 `db_deck*` 那 27 個欄位，攤成陣列。 */
export interface DeckContent {
  /**
   * 三個槽位放的是誰。角色是 `cc069`、怪物是 `mc001_01`，空槽是 `null`。
   *
   * ⚠ 前綴決定 `charaIndex` 該查哪份資產：`cc` 查 `cc_asset`、`mc` 查
   * `mc_asset`。查錯不會報錯，會拿到一張**存在但不相干**的卡。
   */
  chara: (string | null)[];
  /** 三個槽位在資產 `frames` 裡的索引。 */
  charaIndex: (number | null)[];
  /** 三個槽位的武器索引。沒裝是 `null`。 */
  weapon: (number | null)[];
  /**
   * 18 格事件卡。**每個角色槽底下 6 格**（`Math.floor(格號 / 6)` 就是槽號），
   * 所以角色槽是空的時候，它底下那 6 格放不了東西。
   */
  eventIndex: (number | null)[];
}

/** 角色槽數。 */
export const CHARA_SLOTS = 3;
/** 事件卡格數。 */
export const EVENT_SLOTS = 18;
/** 每個角色槽底下的事件卡格數。 */
export const EVENT_SLOTS_PER_CHARA = 6;

/**
 * 渦（Raid）的 BOSS 種類，玩家的俗稱。
 *
 * ⚠ **這是我們自己的鍵，不是遊戲的 BOSS id。** 標籤是玩家貼在牌組上的
 * （「這副打得動魚」），跟遊戲怎麼編號那隻 BOSS 是兩件事。「點了 BOSS 就切到
 * 對應的牌組」那一步要做的是**遊戲的 BOSS → 這裡的鍵**的映射，做在 UI 層；
 * 映射錯了只是切錯牌組，改一行就好，而如果直接把遊戲的 id 存進玩家的牌組庫，
 * 遊戲改版就會讓存檔裡的標籤全部失效。
 */
export type RaidBoss = "sea" | "fish" | "bug" | "turtle" | "dog";

/** 固定順序 —— 標籤列就照這個順序畫。 */
export const RAID_BOSSES: readonly RaidBoss[] = ["sea", "fish", "bug", "turtle", "dog"] as const;

/** 標籤的顯示字。 */
export const RAID_BOSS_LABELS: Record<RaidBoss, string> = {
  sea: "海",
  fish: "魚",
  bug: "蟲",
  turtle: "龜",
  dog: "狗",
};

/** 這是合法的 BOSS 標籤嗎。 */
export function isRaidBoss(value: unknown): value is RaidBoss {
  return typeof value === "string" && (RAID_BOSSES as readonly string[]).includes(value);
}

/** 牌組庫裡的一副，帶玩家自己取的名字。 */
export interface DeckEntry {
  /** 穩定識別碼。拖曳排序、改名、刪除都認這個，不認陣列位置。 */
  id: string;
  /** 玩家取的名字。空字串會在顯示時退回 `Deck{n}`。 */
  name: string;
  content: DeckContent;
  /** ISO 8601。⚠ 存的是絕對時間，不要存「幾天前」。 */
  updatedAt: string;
  /**
   * 這副打得動哪幾種渦 BOSS。**只有 `raid` 那一房用得到**，其他房恆為空陣列。
   *
   * ⚠ 規格在 2026-08-25 重編號過，這一項現在**不在編號清單裡** —— 別再引
   * 「規格 §12」，那個編號現在指的是三副牌的分工。
   *
   * 一副可以掛多個標籤 —— 同一副牌打得動海也打得動魚是常態。
   */
  bosses: RaidBoss[];
}

/**
 * 四種房型，各自一組牌組（規格 §4）。
 *
 * 對應遊戲裡的去處（2026-08-15 實測的頻道表）：
 *
 * | 這裡的鍵     | 遊戲裡                       |
 * | ------------ | ---------------------------- |
 * | `raid`       | 渦（Raid，raid 服務）        |
 * | `alexandria` | 亞歷山卓城（頻道 1，ranked） |
 * | `quest`      | 任務（Quest 場景）           |
 * | `dietherm`   | 迪特赫姆（頻道 2，duel）     |
 *
 * ⚠ **大廳不是其中一房。** 大廳站誰是玩家在 Library 設「最愛角色」決定的，
 * 插件不碰 —— 見本檔開頭「換牌組會連帶換掉大廳立繪」。
 */
export type RoomKind = "raid" | "alexandria" | "quest" | "dietherm";

/** 四種房型的固定順序 —— 選單與「房間」鈕的循環都照這個順序。 */
export const ROOM_KINDS: readonly RoomKind[] = ["raid", "alexandria", "quest", "dietherm"] as const;

/** 房型的顯示名稱（繁中）。 */
export const ROOM_LABELS: Record<RoomKind, string> = {
  raid: "渦",
  alexandria: "亞歷山卓城",
  quest: "任務",
  dietherm: "迪特赫姆",
};

/**
 * 一副被刪掉的牌組留下的記錄（墓碑）。
 *
 * **刪除必須留下痕跡，不能只是從陣列裡消失。** 兩台電腦同步時，「這邊沒有那副
 * 牌」有兩種可能：對面新增了，或者這邊刪掉了。光看「有沒有」分不出來 ——
 * 沒有墓碑的話，玩家在 A 電腦刪掉的牌組會被 B 電腦一直救回來。
 */
export interface Tombstone {
  /** 被刪掉的那副的 `id`。 */
  id: string;
  /** ISO 8601。跟牌組的 `updatedAt` 比大小來決定「刪除」與「編輯」誰比較新。 */
  deletedAt: string;
}

/**
 * 一個帳號的牌組庫。
 *
 * ⚠ `account` 是玩家 id 的**指紋**（SHA-256 的前 8 個 hex），不是 id 本身。
 * **規格書** §12（不是牌組庫規格的 §12）：id 是高熵字串，不得離開本機，更不能
 * 上雲。指紋只用來分辨「這份庫是誰的」，反推不回 id。
 */
export interface DeckLibrary {
  version: 1;
  account: string;
  /** 玩家顯示名稱，純粹給人看的（`Lv.129 燈皇` 那個名字）。 */
  accountLabel?: string;
  collections: Record<RoomKind, DeckEntry[]>;
  /** 刪除記錄，見 {@link Tombstone}。舊版存檔沒有這一欄，解析時補成空的。 */
  tombstones: Record<RoomKind, Tombstone[]>;
  /**
   * **每一房上次選了哪一副。** 進到那一房時就套用它（WP-19）。
   *
   * ## ⚠ 這跟 `DeckSession.active` 是兩件不同的事，不要合併
   *
   * ```
   *   selected  「我想在這一房用哪一副」   玩家的意圖，存下來
   *   active    「Deck1 現在真的是哪一副」 事實，用內容 hash 算出來
   * ```
   *
   * 兩者**本來就會有一段時間不相等** —— 那正是延後寫入的設計（玩家點了 B，
   * Deck1 還是 A，三秒後或開戰前才追上）。硬要用 `active` 反推「玩家想用哪一
   * 副」是做不到的：玩家一離開任務房去打渦，Deck1 就不再對應任務房的任何一副，
   * 那時候「進任務房要套哪一副」就沒有答案了。
   *
   * ⚠ **不進同步。** `summarize()` 沒有這一欄，這是每台電腦各自的偏好 ——
   * 同步過去的話，另一台電腦會在玩家沒碰的情況下被換牌組。
   *
   * 指向一副已經被刪掉的牌組是允許的（解析時不驗），呼叫端查不到就退回清單
   * 第一副 —— 見 `resolveSelected()`。
   */
  selected: Record<RoomKind, string | null>;
}

/** 空的牌組庫。 */
export function emptyLibrary(account: string, accountLabel?: string): DeckLibrary {
  const lib: DeckLibrary = {
    version: 1,
    account,
    collections: { raid: [], alexandria: [], quest: [], dietherm: [] },
    tombstones: { raid: [], alexandria: [], quest: [], dietherm: [] },
    selected: { raid: null, alexandria: null, quest: null, dietherm: null },
  };
  if (accountLabel !== undefined) lib.accountLabel = accountLabel;
  return lib;
}

/** 空牌組 —— 三格角色、三把武器、18 格事件卡全 `null`。 */
export function emptyDeckContent(): DeckContent {
  return {
    chara: new Array<string | null>(CHARA_SLOTS).fill(null),
    charaIndex: new Array<number | null>(CHARA_SLOTS).fill(null),
    weapon: new Array<number | null>(CHARA_SLOTS).fill(null),
    eventIndex: new Array<number | null>(EVENT_SLOTS).fill(null),
  };
}

/** 這副牌組是不是完全空的（三格角色都沒有）。 */
export function isEmptyDeck(content: DeckContent): boolean {
  return content.charaIndex.every((x) => x === null || x === undefined);
}

/**
 * **能不能把這副牌組寫進 Deck1。**
 *
 * 回傳 `null` 表示可以，回傳字串是拒絕的理由。呼叫端要把理由顯示出來，
 * **不要自動塞一張卡進去補救** —— 玩家會不知道自己的牌組被動過。
 *
 * 見本檔開頭「Deck1 的第一格永遠不能是空的」。
 */
export function guardDeck1(content: DeckContent): string | null {
  const first = content.charaIndex[0];
  if (first === null || first === undefined) {
    return "Deck1 的第一格不能是空的 —— 寫空了會讓你卡死在牌組編輯畫面，兩個出口都出不去。";
  }
  return null;
}
