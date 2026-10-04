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

import type { LobbyStand } from "./lobby-stand.js";

/**
 * 一副牌組的內容。就是伺服器 `deck` 那三個陣列（`chara_card_id`／
 * `weapon_card_id`／`event_card_id`），全部是**卡片 id**。
 *
 * ## 2026-09-23 改版前是另一個形狀
 *
 * 舊版存的是資產索引（`chara` 前綴＋`charaIndex`、武器與事件卡的索引），改版後
 * 客戶端與伺服器只認 id，而且武器／事件卡的順序重排過（索引 +1 ≠ id）。存檔裡
 * 的舊格式由 `parseDeckContent()` 查對照表轉過來（`@ulr/rule-schema` 的
 * `legacyCharaId`／`legacyWeaponId`／`legacyEventId`）。改版後才出的新卡沒有
 * 舊索引，只存得進這個新形狀。
 */
export interface DeckContent {
  /**
   * 三個槽位的 `CharaCards[].id`（角色與怪物同一張表），空槽是 `null`。
   */
  charaId: (number | null)[];
  /** 三個槽位的 `WeaponCards[].id`。沒裝是 `null`。 */
  weaponId: (number | null)[];
  /**
   * 18 格 `EventCards[].id`。**每個角色槽底下 6 格**（`Math.floor(格號 / 6)`
   * 就是槽號），所以角色槽是空的時候，它底下那 6 格放不了東西。
   */
  eventId: (number | null)[];
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

/**
 * 四種房型的固定順序 —— 「房間」下拉選單由上而下就是這個順序。
 *
 * 2026-09-12 玩家定的：任務 → 渦 → 亞歷山卓城 → 迪特赫姆（先 PVE 再 PVP，
 * 最常用的迪城在最下面、離牌組列最近）。⚠ 存檔不靠這個順序（`collections`
 * 是按房名的物件），改順序不影響舊存檔。
 */
export const ROOM_KINDS: readonly RoomKind[] = ["quest", "raid", "alexandria", "dietherm"] as const;

/** 房型的顯示名稱（繁中）。 */
export const ROOM_LABELS: Record<RoomKind, string> = {
  raid: "渦",
  alexandria: "亞歷山卓城",
  quest: "任務",
  dietherm: "迪特赫姆",
};

/**
 * 牌組選單裡每一副旁邊要畫哪一種總 COST。
 *
 * ```
 *   quest / raid   none      PVE。沒有 COST 上限，畫一個數字只是噪音。
 *   alexandria     official  頻道 1（ranked）用的是**官方**規則。
 *   dietherm       custom    頻道 2（duel）是插件約戰的地方，用的是**自訂**規則。
 * ```
 *
 * 2026-09-12 玩家定的。原本四房都畫「官方 N 自訂 N」兩個數字，而其中一半
 * 在那一房根本用不到 —— 玩家要對的永遠只有「這一房用的那一種」。
 */
export type RoomCostDisplay = "none" | "official" | "custom";

export const ROOM_COST_DISPLAY: Record<RoomKind, RoomCostDisplay> = {
  quest: "none",
  raid: "none",
  alexandria: "official",
  dietherm: "custom",
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
 * ⚠ `account` 是**玩家名稱**的指紋（SHA-256 的前 8 個 hex），只用來分辨「這份
 * 庫是誰的」、當檔名。2026-09-25 以前是 `player_id` 的指紋 —— 改版後那個值每次
 * 登入都換，一個角色會散成好幾份庫（見 `@ulr/cdp-adapter` 的 `FINGERPRINT_SNIPPET`）。
 * 名稱是公開的，所以這個指紋**不能**拿去當雲端的門票。
 */
export interface DeckLibrary {
  /** 2 = 內容存卡片 id（2026-09-23 改版後）。1 是舊的資產索引，讀的時候轉。 */
  version: 2;
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
  /**
   * **最愛卡片**（牌組編輯畫面「最愛卡片」鈕），見 {@link FavoriteCards}。
   * 舊版存檔沒有這一欄 = 還沒設過（不是「清空了」）—— 同步時沒有這欄的那一邊
   * 不參與比較。
   */
  favorites?: FavoriteCards;
  /**
   * **隱藏的裝備**（牌組編輯 Equipment 分頁的「隱藏裝備」鈕），見 {@link HiddenWeapons}。
   * 沒有這一欄 = 還沒設過，規則跟 `favorites` 一樣。
   */
  hiddenWeapons?: HiddenWeapons;
  /**
   * **最愛的事件卡**（牌組編輯 Event 分頁的「最愛卡片」鈕），見 {@link FavoriteEvents}。
   * 沒有這一欄 = 還沒設過，規則跟 `favorites` 一樣。
   */
  favoriteEvents?: FavoriteEvents;
  /**
   * **首頁立繪**（Library 愛心的複選＋首頁編輯模式的擺法），見 {@link LobbyStand}。
   * 沒有這一欄 = 還沒設過，規則跟 `favorites` 一樣。
   */
  lobbyStand?: LobbyStand;
}

/**
 * 最愛的事件卡。存事件卡 id（`EventCards[].id`，跟 `DeckContent.eventId` 同一種）。
 *
 * **跟角色卡的最愛分開存**：事件卡 id 是 1..125，跟角色卡 id（1..30135）重疊
 * （2026-09-26 查的），放同一個清單會把「劍3卡」跟 id 3 的角色卡搞混。
 * 跟最愛一樣上雲（玩家 2026-09-26：「一樣要存到雲端內」），形狀與合併規則也一樣。
 */
export type FavoriteEvents = FavoriteCards;

/**
 * 隱藏的裝備。存武器卡 id（`WeaponCards[].id`，跟 `DeckContent.weaponId` 同一種）。
 * 只在 Equipment 分頁的 [Chara Weapon] 開著時生效（叮噹星、可可果這類很少用的）。
 *
 * **跟最愛一樣上雲**（玩家 2026-09-26：「手動隱藏的也和最愛卡牌一樣要在雲端儲存」），
 * 形狀與合併規則也一樣：整份一個時間戳、較新的整份贏。
 */
export type HiddenWeapons = FavoriteCards;

/**
 * 最愛卡片。存角色卡的卡片 id（`CharaCards[].id`，跟 `DeckContent.charaId` 同一種），
 * **不存角色鍵** —— 玩家 2026-09-26：「最愛角色指的是最愛卡片」，把 R1 史特靈加進
 * 最愛，就只該看到 R1 史特靈，不是史特靈的每一張。
 *
 * 2026-09-26 當天第一版存的是角色鍵（`charas`）；那一版沒發出去，讀到就當沒設過。
 *
 * **跟牌組一起上雲**（玩家 2026-09-26：「最愛角色和插件牌組一樣也要在雲端存起來」）。
 * 整份一個時間戳、較新的整份贏：玩家一次只會在一台電腦上點這顆鈕，逐筆合併換來
 * 的只有「取消最愛會被另一台救回來」那種要墓碑才解得掉的問題。
 */
export interface FavoriteCards {
  /** 照玩家加入的順序。 */
  cards: number[];
  /** ISO 8601。整份最後一次改動的時間。 */
  updatedAt: string;
}

/** 空的牌組庫。 */
export function emptyLibrary(account: string, accountLabel?: string): DeckLibrary {
  const lib: DeckLibrary = {
    version: 2,
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
    charaId: new Array<number | null>(CHARA_SLOTS).fill(null),
    weaponId: new Array<number | null>(CHARA_SLOTS).fill(null),
    eventId: new Array<number | null>(EVENT_SLOTS).fill(null),
  };
}

/** 這副牌組是不是完全空的（三格角色都沒有）。 */
export function isEmptyDeck(content: DeckContent): boolean {
  return content.charaId.every((x) => x === null || x === undefined);
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
  const first = content.charaId[0];
  if (first === null || first === undefined) {
    return "Deck1 的第一格不能是空的 —— 寫空了會讓你卡死在牌組編輯畫面，兩個出口都出不去。";
  }
  return null;
}
