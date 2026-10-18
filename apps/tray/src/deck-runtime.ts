/**
 * 托盤的牌組那一大塊：本地牌組庫、雲端同步、人物篩選／首頁立繪的設定、官方三牌組、
 * 等候套用與開戰閘門（2026-10-18 從 main.ts 整段搬出來，程式照原樣）。
 *
 * 跟 main.ts 的介面只有兩頭：
 *
 * - 進來的：{@link initDeckRuntime} 交進來的 `ctx`（profile／engine／log／pushState，每次讀都是當下的）、
 *   遊戲狀態、卡名表與資料夾。
 * - 出去的：main.ts 在接上／重接遊戲、切換設定、關程式時叫的那幾支（檔尾那一段）。
 *
 * ⚠ 計時器與「推過了沒」的旗標只在這裡改：main.ts 以前直接賦值，現在走檔尾的函式。
 */

import type { ArbiterEngine, EngineStatus } from "@ulr/arbiter-engine";
import { DEFAULT_DECK_SYNC_URL } from "@ulr/arbiter-link";
import type {
  CharaPickerReport,
  LobbyStandReport,
  DeckEditReport,
  DeckSnapshot,
  RoomGateReport,
} from "@ulr/cdp-adapter";
import type { CharaFiles, DeckContent, Inventory, RoomKind } from "@ulr/deck-library";
import {
  addDeck,
  deckContentFromServer,
  deckContentHash,
  displayName,
  emptyDeckContent,
  favoriteCards,
  favoriteEvents,
  findDeck,
  findSetShortages,
  findShortages,
  guardDeck1,
  hiddenWeapons,
  isEmptyDeck,
  listDecks,
  lobbyStand,
  // ⚠ 「這一房選的是哪一副」是庫裡的**意圖**（開戰前要寫進伺服器的正是它），
  // 跟算出來的 active 不是同一件事。見 ensureRoomDeck()。
  resolveSelected,
  ROOM_KINDS,
  ROOM_LABELS,
  setFavoriteCard,
  setFavoriteEvent,
  setHiddenWeapon,
  setLobbyStandSets,
  setLobbyStandSkillVoice,
  setLobbyStandUi,
  stockTable,
  substituteCharas,
  withDeckContent,
} from "@ulr/deck-library";
import type { CardNames } from "./card-art.js";
import { resolveCardFrame } from "./card-art.js";
import type { ActiveDeckMode, DeckSession } from "./deck-core.js";
import {
  applyLanded,
  applyOfficialReport,
  applyReport,
  autoSave,
  deckEditStateOf,
  enterRoom,
  followDeckOnEdit,
  officialAutoSave,
  officialRoomOf,
  officialSetOf,
  roomDeckPreloadOf,
  expireNotice,
  isApplyDue,
  migrateServerDecks,
  newSession,
  resolveActive,
  resolveAll,
  sameSet,
  seedAllRooms,
  slotWrite,
  withNotice,
} from "./deck-core.js";
import { DeckSeen, worldOf } from "./deck-seen.js";
import { backupOnce, readLibrary, writeLibrary } from "./deck-store.js";
import { syncDeckLibrary, type FetchLike } from "./deck-sync.js";
import type { TrayContext } from "./tray-context.js";
/** main.ts 交給牌組這段的東西（見 initDeckRuntime）。 */
export interface DeckDeps {
  ctx: TrayContext;
  /** 插件自己的資料夾（APPDATA 底下的 ulr-companion）：牌組庫與備份放在這底下。 */
  appDir: string;
  /** 引擎最後一次回報的狀態；沒接著遊戲是 null。 */
  latest(): EngineStatus | null;
  /** 卡面替換讀到的卡名表（記錄裡寫卡名用）。 */
  cardNames(): CardNames | null;
}

let deps: DeckDeps;
let ctx: TrayContext;

/** main.ts 一開始叫一次，之後這裡的函式才能用。 */
export function initDeckRuntime(d: DeckDeps): void {
  deps = d;
  ctx = d.ctx;
}

export interface DeckSyncStatus {
  /** `Date.now()`。 */
  at: number;
  ok: boolean;
  /** 給人看的一句話。 */
  text: string;
}

// ---------------------------------------------------------------------------
// 本地牌組庫（WP-18）
//
// 伺服器只給三副而且擴不出第四副，所以牌組存在本地、**Deck1 當唯一的工作槽**，
// 玩家在遊戲的牌組編輯畫面點一副就即時覆寫 Deck1（`@ulr/deck-library` 檔頭）。
//
// ⚠ **托盤視窗一個字都不加**（規格 §3）。這一整段沒有任何一頁、任何一個 IPC
// ——玩家看得到的東西全部畫在遊戲裡。托盤這邊只負責：讀 Deck1、算庫、存檔、
// 把狀態推過去。玩家在托盤唯一會看到的是記錄頁上的那幾行。
// ---------------------------------------------------------------------------

/**
 * 多久看一眼玩家在不在牌組編輯畫面。
 *
 * ⚠ 這一拍**只是一次 `Runtime.evaluate`**（問頁面裝了沒、掛上了沒），不碰
 * 伺服器。真的去讀 Deck1 只發生在玩家人就在那個畫面的時候 —— 見 `deckTick()`。
 */
const DECK_TICK_MS = 4_000;

/**
 * 庫存快取多久重讀一次。
 *
 * 庫存只有在玩家抽到新卡時才會變，而換牌組是連續動作（試三副牌就是三次）——
 * 每次都重讀等於每次換牌組多三趟 WebSocket。
 */
const INVENTORY_TTL_MS = 5 * 60_000;

let deckTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 「排著的那一副等夠久了沒」多久看一眼。
 *
 * ⚠ 一定要比等候秒數密得多，否則玩家設 3 秒實際等到的是這個拍子的倍數。
 * 這一拍沒有 pending 時只是一個布林判斷，不碰網路。
 */
const DECK_APPLY_TICK_MS = 500;
let deckApplyTimer: ReturnType<typeof setInterval> | null = null;
/** 牌組庫的全部狀態。`null` = 還沒讀到帳號指紋（遊戲還沒登入完成）。 */
let deck: DeckSession | null = null;
/** 這份 session 是哪個帳號的。**換帳號登入要整份重來。** */
let deckAccount: string | null = null;
/**
 * 卡片庫存的快取，見 {@link INVENTORY_TTL_MS}。
 *
 * 改版後讀庫存不必送請求（讀的是 registry），快取留著只是省一次 evaluate。
 */
let inventoryCache: {
  at: number;
  data: Inventory;
  /** 玩家角色卡的格子鍵（見 `InventorySnapshot`），臨時換卡用（見 forGame）。 */
  charaFiles: CharaFiles;
} | null = null;
/**
 * 官方三牌組模式：上一次在牌組編輯畫面看到的三副。自動存檔的比較基準
 * （跟插件模式的 `deckSeen` 同一個道理：只存兩次觀察之間真的變了的）。
 * `null` = 還沒觀察過，那時候一律不存。
 */
let officialSeen: DeckContent[] | null = null;

/** 玩家選的牌組替換模式。`null` = 關閉（插件不碰牌組）。 */
function activeDeckMode(): ActiveDeckMode | null {
  return ctx.profile.deckMode === "off" ? null : ctx.profile.deckMode;
}
/**
 * 還沒替這條連線讀過帳號指紋。
 *
 * ⚠ 斷線就要重設 —— 玩家關掉遊戲再開有可能**換一個帳號登入**，而牌組庫是
 * 跟著帳號走的。沿用上一個帳號的庫會把 A 的牌組存進 B 的檔案裡。
 */
let deckPending = true;
/** 「還在等遊戲登入」這句話講過了沒。每條連線只講一次。 */
let deckWaitLogged = false;
/** 上一拍玩家在不在 Edit 畫面。true → false 那一拍要補存一次他剛改的東西。 */
let deckMounted = false;
/**
 * **上一次我們讀到的 Deck1** —— 客戶端與伺服器**各記一份**。自動存檔的比較
 * 基準，見 `autoSave()` 與 `deck-seen.ts` 的檔頭。
 *
 * ⚠ 少了它，「寫入失敗」會被誤判成「玩家改過牌」，然後把玩家那副牌覆蓋掉。
 * `null` = 那個世界還沒觀察過，那時候一律不存。
 *
 * ⚠⚠ 記的時候要**誠實說自己動到哪一邊**：快路徑只動客戶端記憶體（`client`），
 * 只有 `db_editdeck` 寫完讀回來對過那一條才是 `both`。報錯了就等於沒修 ——
 * 2026-09-20「迪城的牌組1 變成渦那副」正是兩邊被當成同一份的後果。
 */
const deckSeen = new DeckSeen();
/** 正在處理一則回報。玩家連點時後面那幾則直接丟掉，不要交錯跑。 */
let deckBusy = false;

/**
 * **把牌組庫整份放掉，下一拍重新認帳號。**
 *
 * 三個時機：斷線、遊戲頁面重載、以及快路徑讀到的帳號指紋跟手上這份庫不一樣。
 *
 * ## ⚠⚠ 為什麼只靠斷線不夠（2026-09-14 實機）
 *
 * 小號在**同一個分頁**裡從 A 導向 B 的網址，CDP 連線一路沒斷；登完直接跳進
 * 對戰大廳，托盤讀 Deck1 一律走快路徑（不讀伺服器、原本也沒有帳號指紋）。
 * 於是它整整一晚都以為還是 A：
 *
 * ```
 *   進房 preload  → 把 A 的牌塞進 B 的 Deck1（「這副牌有 5 張卡你手上沒有」）
 *   B 選第 1 副   → 拿 B 的 id 去 A 的庫找（「那副牌組不見了」），永遠換不過去
 *   自動存檔      → B 的 Deck1 存進 A 的檔案
 * ```
 *
 * ## ⚠ `deck` 要清成 `null`，不能只立 `deckPending`
 *
 * 只立旗標的話 `onRoomGate`／`onDeckReport` 照樣拿舊的那份庫在跑（它們只看
 * `deck === null`），等待重認的那幾秒正好是進房 preload 會發生的時候。
 * 頁面上的 room preload 也要一起清：引擎補裝房間偵測時會把它手上那份推回頁面，
 * 不清就是把上一個人的牌再推一次。
 */
export function resetDeckSession(): void {
  deckPending = true;
  deckMounted = false;
  // ⚠ 比較基準也要丟掉（兩份一起）。留著上一條連線／上一個人看到的 Deck1，
  // 重認後第一次比對會把「這段期間在別處改的牌」誤判成剛剛的編輯。
  deckSeen.reset();
  officialSeen = null;
  inventoryCache = null;
  deck = null;
  deckSyncKey = null;
  if (deckSyncTimer !== null) {
    clearTimeout(deckSyncTimer);
    deckSyncTimer = null;
  }
  // ⚠ 同步清：引擎的 setRoomDecks 在第一個 await 之前就換掉它手上那份，
  // 所以緊接著的補裝推下去的已經是空的。
  if (ctx.engine !== null) {
    void ctx.engine.setRoomDecks({ mode: activeDeckMode() ?? "off", decks: {} });
    gatePendingPushed = null;
    void syncGatePending();
  }
  // 最愛是上一個人的，一起收掉。
  pushCharaPicker();
  pushLobbyStand();
}

/**
 * 讀到的帳號跟手上這份庫不是同一個人 → 放掉重來，回 `true`。
 *
 * ⚠ `null` 是「這一拍認不出來」（還在登入、場景還沒掛上 socket），不是換人 ——
 * 拿它當換人會讓每次載入中都整份重建一次。
 */
function accountChanged(account: string | null): boolean {
  if (account === null || deckAccount === null || account === deckAccount) return false;
  ctx.log("⟳ 換了帳號登入 —— 牌組庫放掉，重新接上這個帳號的");
  resetDeckSession();
  return true;
}

/**
 * **Deck1（與另外兩格）現在真正的內容。**
 *
 * ```
 *   玩家人在有牌組列的畫面 → 客戶端記憶體 registry.deck（他正在排的、或進房預載的）
 *   不在                    → 伺服器那份（頁面記著的；沒記過才 db_deck 一次）
 * ```
 *
 * ⚠⚠ 這個順序不能顛倒。遊戲要等玩家**離開**編輯畫面才把牌組送上伺服器，所以
 * 他人還在那裡時，伺服器上的是舊的。只讀伺服器的話，「改完牌直接按 ◀▶ 換牌組」
 * 會被判成「沒有編輯要存」，然後目標牌組蓋進 Deck1 —— **他剛排好的牌當場消失**。
 */
async function currentDeck1(): Promise<{
  /** 第 1 格（插件模式的工作槽）。 */
  current: DeckContent;
  /** 三格，照 `deck_id` 排好（官方三牌組模式用）。 */
  set: DeckContent[];
  snap: DeckSnapshot | null;
  /** 這一份是從哪裡讀來的。⚠ 自動存畫要看它，見 {@link mayAutoSave}。 */
  where: "edit" | "room" | "server";
  /** 帳號指紋；認不出來是 `null`。⚠ 換帳號的判斷要看它，見 {@link accountChanged}。 */
  account: string | null;
  /** 玩家眼前是第幾格（場景的 `deck_now`）。 */
  deckNow: number | null;
} | null> {
  if (ctx.engine === null) return null;
  const live = await ctx.engine.readEditDeck();
  // ⚠ 快路徑：拿到記憶體那一份就不必看伺服器那份。
  if (live !== null) {
    const set = live.decks.map((d) => fromGame(deckContentFromServer(d)));
    return {
      current: set[0] ?? emptyDeckContent(),
      set,
      snap: null,
      where: live.where,
      account: live.account,
      deckNow: live.deckNow,
    };
  }
  try {
    const snap = await ctx.engine.readDecks();
    const set = snap.decks.map((d) => fromGame(deckContentFromServer(d)));
    return {
      current: set[0] ?? emptyDeckContent(),
      set,
      snap,
      where: "server",
      account: snap.account,
      deckNow: snap.deckNow,
    };
  } catch {
    return null;
  }
}

/**
 * **這一份 Deck1 可以拿去自動存檔嗎？**
 *
 * ## ⚠⚠ 房間場景裡看到的變動不是玩家的編輯
 *
 * `autoSave()` 的用途是「玩家在牌組編輯畫面改了牌，庫裡那一副要跟上」。但
 * Deck1 會變的地方不只那裡 —— `patch-room-gate` 的 preload **每次進房都會把
 * Deck1 換成那一房的牌**，而那是我們自己做的事。
 *
 * 兩者分不出來的話，會發生這件事（2026-09-10 實機）：
 *
 * ```
 *   人在任務房，Deck1 = 任務那一副
 *   直達跳到渦房 → 頁面 preload 把 Deck1 換成渦房那一副
 *   托盤的 4 秒拍子：Deck1 變了 → 存回 active[session.room]
 *   而 session.room 還停在上一房 → 渦房的牌被存進任務那一副（或反過來）
 * ```
 *
 * 實際災情是庫裡 raid 的第 3 副整個被任務那一副覆蓋，而 autoSave 從不出聲，
 * 記錄檔上一個字都沒有。這也正是 `autoSave` 檔頭那段「2026-08-27 弄丟兩副牌」
 * 的同一類事故 —— 那次補的是 `lastSeen` 那道閘，這次補的是「從哪個畫面讀的」。
 *
 * ## 為什麼 `server` 可以存
 *
 * 讀到伺服器那條路，表示玩家**不在任何一個有牌組列的畫面**（Edit／Quest／Raid／
 * Match 都會走快路徑）。而那正是「他剛離開編輯畫面、遊戲自己把 Deck1 送上伺服器」
 * 的那一刻 —— 玩家最後一次編輯只有在這裡收得到。房間的 preload 碰不到這條路，
 * 因為 preload 只發生在房間場景裡，而那時候一定走快路徑。
 */
function mayAutoSave(where: "edit" | "room" | "server"): boolean {
  return where !== "room";
}

/** 把庫存讀出來（有快取）。讀不到回 `null` —— 呼叫端**必須**當成「不准寫」。 */
async function deckInventory(): Promise<Inventory | null> {
  if (ctx.engine === null) return null;
  const now = Date.now();
  if (inventoryCache !== null && now - inventoryCache.at < INVENTORY_TTL_MS) {
    return inventoryCache.data;
  }
  try {
    const raw = await ctx.engine.readInventory();
    const data: Inventory = {
      chara: stockTable(raw.chara),
      weapon: stockTable(raw.weapon),
      event: stockTable(raw.event),
    };
    const hadSwaps = librarySwaps();
    inventoryCache = { at: now, data, charaFiles: raw.charaFiles };
    // 換卡的結果變了（第一次讀到、或玩家剛合成完）→ 頁面的預載與選單卡面要跟上。
    if (librarySwaps() !== hadSwaps) void pushDeckState().catch(() => {});
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 手上沒有的角色卡：寫進遊戲時臨時換成同一個角色的另一張
//
// 2026-09-25 迪城：玩家把沃蘭德 R2 合成成 R5，庫裡那副還寫著 R2，於是每點一次
// 都「有 1 張卡你手上沒有」。玩家定的規則：**換牌時臨時用最接近的，角色一樣就
// 行，最好是上位高等的**（`substituteCharas`）。牌組庫裡照舊是 R2。
//
// ⚠⚠ 兩個方向都要做，只做一邊會壞：
//
//   往遊戲寫（forGame）   Deck1／預載／選單卡面都用換過的
//   從遊戲讀（fromGame）  讀回 R5 那一副時認回庫裡的 R2 那一副
//
// 「Deck1 現在是哪一副」與「伺服器上是不是這一副」全是拿內容 hash 跟庫比的。
// 少了 fromGame，遊戲裡的 R5 對不上庫裡的 R2：選單失去黃字、開戰前每次都判成
// 「伺服器上不是它」而重寫一次，自動存檔的比較基準也會混進兩種寫法。
// ---------------------------------------------------------------------------

/** 已經在記錄裡講過的替換（`from→to`），同一組只講一次。 */
const swapsLogged = new Set<string>();

function cardLabel(id: number): string {
  const file = inventoryCache?.charaFiles[String(id)];
  if (file === undefined) return `#${id}`;
  return resolveCardFrame(file, deps.cardNames())?.label ?? file;
}

/** 寫進遊戲的樣子。`quiet` = 只是拿來畫（選單、預載），不寫記錄。 */
function forGame(content: DeckContent, quiet = false): DeckContent {
  if (inventoryCache === null) return content;
  const out = substituteCharas(content, inventoryCache.data, inventoryCache.charaFiles);
  if (!quiet) {
    for (const s of out.swaps) {
      const key = `${s.from}→${s.to}`;
      if (swapsLogged.has(key)) continue;
      swapsLogged.add(key);
      ctx.log(
        `· 手上沒有 ${cardLabel(s.from)}，臨時用 ${cardLabel(s.to)} 代替（牌組庫裡照舊是 ${cardLabel(s.from)}）`,
      );
    }
  }
  return out.content;
}

/** 從遊戲讀回來的一副：正好是庫裡某一副換過卡的樣子，就認回那一副。 */
function fromGame(content: DeckContent): DeckContent {
  if (deck === null || inventoryCache === null) return content;
  const want = deckContentHash(content);
  const rooms = [deck.room, ...ROOM_KINDS.filter((r) => r !== deck!.room)];
  const all = rooms.flatMap((r) => listDecks(deck!.library, r));
  if (all.some((d) => deckContentHash(d.content) === want)) return content;
  for (const d of all) {
    const out = substituteCharas(d.content, inventoryCache.data, inventoryCache.charaFiles);
    if (out.swaps.length > 0 && deckContentHash(out.content) === want) return d.content;
  }
  return content;
}

/** 庫裡現在有哪幾副需要換卡、換成什麼（拿來判斷「結果變了沒」）。 */
function librarySwaps(): string {
  if (deck === null || inventoryCache === null) return "";
  const cache = inventoryCache;
  return ROOM_KINDS.flatMap((r) => listDecks(deck!.library, r))
    .map((d) => substituteCharas(d.content, cache.data, cache.charaFiles).swaps)
    .filter((s) => s.length > 0)
    .map((s) => s.map((x) => `${x.from}>${x.to}`).join(","))
    .join("|");
}

/** 一格預載（`slotWrite` 的形狀）換成寫進遊戲的樣子。 */
function slotForGame<
  T extends {
    chara_card_id: (number | null)[];
    weapon_card_id: (number | null)[];
    event_card_id: (number | null)[];
  },
>(slot: T): T {
  const content = forGame(
    { charaId: slot.chara_card_id, weaponId: slot.weapon_card_id, eventId: slot.event_card_id },
    true,
  );
  return { ...slot, chara_card_id: [...content.charaId] };
}

function saveDeckLibrary(options: { sync?: boolean } = {}): void {
  if (deck === null) return;
  try {
    writeLibrary(deps.appDir, deck.library);
  } catch (err) {
    ctx.log(`✗ 牌組庫存檔失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  // 本機動過就排一次雲端同步（同步自己落地的那次不排，否則會自己追自己）。
  if (options.sync !== false) scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// 雲端牌組庫（見 deck-sync.ts）
// ---------------------------------------------------------------------------

/** 本機存檔之後停多久才推 —— 玩家在編輯畫面連續改牌時只推最後那一次。 */
const DECK_SYNC_DEBOUNCE_MS = 8_000;
/** 沒動靜時多久去雲端看一次（另一台電腦改的東西要靠這一拍過來）。 */
const DECK_SYNC_INTERVAL_MS = 2 * 60_000;
/** 這個角色的雲端鍵。`null` = 還沒讀到（或頁面是舊版腳本）。 */
let deckSyncKey: string | null = null;
let deckSyncTimer: ReturnType<typeof setTimeout> | null = null;
let deckSyncRunning = false;
let deckSyncStatus: DeckSyncStatus | null = null;
/** 上一輪失敗過 —— 失敗只講一次，恢復時再講一次。 */
let deckSyncFailing = false;

function scheduleDeckSync(delayMs: number): void {
  if (!ctx.profile.deckCloudSync || deckSyncKey === null) return;
  if (deckSyncTimer !== null) clearTimeout(deckSyncTimer);
  deckSyncTimer = setTimeout(() => {
    deckSyncTimer = null;
    void runDeckSync();
  }, delayMs);
}

/**
 * 跟雲端同步一輪。
 *
 * ⚠ 三種情況這一輪不落地、晚點再來：
 * - 有一副排著隊還沒寫進伺服器（`pending`）—— 合併可能把它刪掉，隊伍會指向空氣
 * - 同步進行中玩家又改了牌（`deck.library` 換了一份）—— 合併結果是舊的基準算的
 * - 等待期間換了帳號 —— 結果屬於上一個人
 */
export async function runDeckSync(): Promise<void> {
  if (!ctx.profile.deckCloudSync || deckSyncRunning) return;
  const key = deckSyncKey;
  const start = deck;
  if (key === null || start === null) return;
  if (start.pending !== null) {
    scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
    return;
  }
  deckSyncRunning = true;
  const account = deckAccount;
  try {
    const r = await syncDeckLibrary(start.library, {
      baseUrl: DEFAULT_DECK_SYNC_URL,
      key,
      fetch: globalThis.fetch as unknown as FetchLike,
    });
    if (!r.ok) {
      deckSyncStatus = { at: Date.now(), ok: false, text: r.reason };
      if (!deckSyncFailing) ctx.log(`⚠ 牌組跨電腦同步：${r.reason}（先用本機的，稍後再試）`);
      deckSyncFailing = true;
      ctx.pushState();
      return;
    }
    if (deckSyncFailing) ctx.log("✓ 牌組跨電腦同步恢復了");
    deckSyncFailing = false;

    const now = deck;
    if (now === null || deckAccount !== account || deckSyncKey !== key) return;
    if (now.library !== start.library || now.pending !== null) {
      // 同步期間本機又動了：下一輪用新的基準重來（雲端那份已經推上去也無妨）。
      scheduleDeckSync(DECK_SYNC_DEBOUNCE_MS);
      return;
    }

    const parts: string[] = [];
    if (r.pulled > 0) parts.push(`拉下 ${r.pulled} 副`);
    if (r.deleted > 0) parts.push(`刪掉 ${r.deleted} 副`);
    if (r.pushed) parts.push("已推上 Cloudflare Workers");
    deckSyncStatus = {
      at: Date.now(),
      ok: true,
      text: parts.length > 0 ? parts.join("、") : "跟 Cloudflare Workers 上的一致",
    };

    if (r.localChanged) {
      // active 是用內容算的，合併之後重算；還沒觀察過 Deck1 就只清掉被刪掉的那幾副。
      const active =
        deckSeen.latest !== null
          ? resolveAll(r.library, deckSeen.latest)
          : (Object.fromEntries(
              ROOM_KINDS.map((room) => {
                const id = now.active[room];
                return [room, id !== null && findDeck(r.library, room, id) !== null ? id : null];
              }),
            ) as DeckSession["active"]);
      deck = { ...now, library: r.library, active };
      saveDeckLibrary({ sync: false });
      ctx.log(`· 牌組跨電腦同步：${deckSyncStatus.text}（另一台電腦改過的已經合進來）`);
      await pushDeckState();
    }
    ctx.pushState();
  } catch (err) {
    deckSyncStatus = {
      at: Date.now(),
      ok: false,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    deckSyncRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 牌組編輯畫面的人物篩選與最愛卡片（patch-chara-picker）
// ---------------------------------------------------------------------------

/** 上一次推給引擎的那份（一樣就不推：pushDeckState 很常跑）。 */
let charaPickerPushed: string | null = null;

/**
 * 把 [Chara] 鈕的設定與最愛清單推給引擎。
 *
 * 最愛與隱藏的裝備存在牌組庫裡（跟牌組一起上雲），所以牌組庫還沒接上（`deck === null`，
 * 包括牌組替換關閉時）就是 `favoritesReady: false` —— 最愛鈕與「隱藏裝備」不畫，
 * 免得點了存不進去。
 */
export function pushCharaPicker(): void {
  if (ctx.engine === null) return;
  const state = {
    mode: ctx.profile.charaPicker,
    favorites: deck === null ? [] : favoriteCards(deck.library),
    hiddenWeapons: deck === null ? [] : hiddenWeapons(deck.library),
    favoriteEvents: deck === null ? [] : favoriteEvents(deck.library),
    favoritesReady: deck !== null,
  };
  const text = JSON.stringify(state);
  if (text === charaPickerPushed) return;
  charaPickerPushed = text;
  ctx.engine.setCharaPicker(state);
}

/**
 * 玩家在牌組編輯畫面按了「最愛卡片」（角色卡或事件卡）或「隱藏裝備」。
 * 存進牌組庫、排雲端同步、推回畫面。
 */
function onCharaPicker(report: CharaPickerReport): void {
  if (report.type === "chara-picker-error") return;
  if (deck !== null) {
    const toggle =
      report.type === "card-favorite"
        ? setFavoriteCard
        : report.type === "event-favorite"
          ? setFavoriteEvent
          : setHiddenWeapon;
    const library = toggle(deck.library, report.card, report.on);
    if (library !== deck.library) {
      deck = { ...deck, library };
      saveDeckLibrary();
    }
  }
  // 頁面已經先動了（樂觀更新）；存不進去（庫還沒接上）時這一推會把它扳回來。
  charaPickerPushed = null;
  pushCharaPicker();
}

// ---------------------------------------------------------------------------
// 首頁立繪與 Library 愛心複選（patch-lobby-stand）
// ---------------------------------------------------------------------------

/** 上一次推給引擎的那份（一樣就不推）。 */
let lobbyStandPushed: string | null = null;

/**
 * 把最愛角色套組、擺法與大廳元件推給引擎。跟最愛卡片一樣存在牌組庫裡（上雲），所以
 * 牌組庫還沒接上就是 `ready: false` —— 首頁與 Library 維持官方原樣，免得點了存不進去。
 */
function pushLobbyStand(): void {
  if (ctx.engine === null) return;
  const stand = deck === null ? null : lobbyStand(deck.library);
  const state = {
    ready: deck !== null,
    sets: stand?.sets ?? [],
    ui: stand?.ui ?? {},
    skillVoice: stand?.skillVoice ?? true,
  };
  const text = JSON.stringify(state);
  if (text === lobbyStandPushed) return;
  lobbyStandPushed = text;
  ctx.engine.setLobbyStand(state);
}

/** 玩家點了 Library 的愛心、或在首頁編輯模式按了 OK。存進牌組庫、排雲端同步、推回畫面。 */
function onLobbyStand(report: LobbyStandReport): void {
  if (report.type === "lobby-stand-error") return;
  if (deck !== null) {
    let library = setLobbyStandSets(deck.library, report.sets);
    if (report.ui !== undefined) library = setLobbyStandUi(library, report.ui);
    if (report.skillVoice !== undefined) {
      library = setLobbyStandSkillVoice(library, report.skillVoice);
    }
    if (library !== deck.library) {
      deck = { ...deck, library };
      saveDeckLibrary();
    }
  }
  // 頁面已經先動了；存不進去（庫還沒接上）時這一推會把它扳回來。
  lobbyStandPushed = null;
  pushLobbyStand();
}

export async function pushDeckState(): Promise<void> {
  if (ctx.engine === null) return;
  // 最愛也在牌組庫裡：庫換了（接上、同步合併、換帳號）就跟著推。
  pushCharaPicker();
  pushLobbyStand();
  const mode = activeDeckMode();
  if (mode === null) {
    // 關閉模式：選單拆掉、房間不預載不攔不釘。
    await ctx.engine.clearDeckEdit();
    await ctx.engine.setRoomDecks({ mode: "off", decks: {} });
    return;
  }
  if (deck === null) return;
  // 選單的卡面與總 COST、進房預載都用寫進遊戲的樣子（手上沒有的角色卡已經
  // 臨時換過，見 forGame）—— 畫出來的就是實際會用的那一副。
  const state = deckEditStateOf(deck, mode);
  await ctx.engine.setDeckEditState({
    ...state,
    decks: state.decks.map((d) => ({ ...d, content: forGame(d.content, true) })),
  });
  // ⚠ 每一房「進去要用哪幾格」也要跟著更新。玩家換了選擇之後不重推的話，
  // 進房時頁面塞的還是上一次那副 —— 而它會**贏過**托盤隨後寫進來的那一份
  // （頁面是在 create() 之前動手的，比較早）。見 `RoomDeckPreload`。
  const preload = roomDeckPreloadOf(deck, mode);
  for (const room of ROOM_KINDS) {
    const p = preload[room];
    if (p !== undefined) preload[room] = { ...p, slots: p.slots.map(slotForGame) };
  }
  await ctx.engine.setRoomDecks({ mode, decks: preload });
}

/**
 * 第一次接上（或換了帳號）時把牌組庫準備好。
 *
 * ```
 *   讀三副 + 帳號指紋 → 沒有存檔就把原本那三副收進庫裡 → 備份 → 推到畫面上
 * ```
 *
 * ⚠ **讀不到不是錯誤。** 遊戲還在標題畫面時沒有任何場景有 socket + 玩家 id，
 * 那正是玩家的正常開機順序（先開插件再開遊戲）。所以這裡安靜重試，只講一次。
 */
async function initDeckLibrary(): Promise<void> {
  if (ctx.engine === null) return;
  let snap: DeckSnapshot;
  try {
    snap = await ctx.engine.readDecks();
  } catch {
    if (!deckWaitLogged) {
      deckWaitLogged = true;
      ctx.log("· 牌組庫在等遊戲登入完成 —— 進到大廳就會自己接上");
    }
    return;
  }
  deckWaitLogged = false;
  deckPending = false;

  const current = deckContentFromServer(snap.decks[0]);
  const label = snap.accountLabel ?? undefined;
  const { library, dropped, migrated, existed, adopted } = readLibrary(
    deps.appDir,
    snap.account,
    label,
  );
  let lib = library;
  if (adopted !== null) {
    // 指紋換成玩家名稱之後的第一次：舊指紋存下的那幾份庫併進來（見 readLibrary）。
    ctx.log(
      `· 牌組庫：把這個角色先前分散的 ${adopted.files.length} 份存檔併回來了（${adopted.decks} 副，一樣的只留一副；舊檔沒動）`,
    );
  }
  if (migrated > 0) {
    // 改版前的存檔（資產索引）在讀的時候就轉成新卡號了，下面那次存檔會把它寫回新格式。
    ctx.log(`· 牌組庫裡 ${migrated} 副改版前的牌組已轉成新的卡片編號`);
  }

  if (!existed) {
    // 第一次用這個帳號：先把 Deck1 收進來（Deck2/Deck3 由下面的搬遷處理，
    // 它們要落在**固定的第 2、3 格**）。
    //
    // ⚠ **四房各收一份**（2026-09-09 改）。原本只收進迪特赫姆，結果其他三房
    // 一副都沒有 —— 而「進到那一房就自動套用那一套」在空的房間裡完全不會有
    // 動作，玩家看到的是「這功能對我沒作用」。四房各一份複本之後，他在哪一房
    // 都馬上有得選，再自己改成那一房要用的。
    if (!isEmptyDeck(current)) lib = seedAllRooms(lib, current);
  }

  deckAccount = snap.account;
  deckSyncKey = snap.syncKey;
  if (deckSyncKey === null && ctx.profile.deckCloudSync) {
    // 頁面讀不到註冊時間就不給雲端鍵（`@ulr/cdp-adapter` 的 `FINGERPRINT_SNIPPET`）
    // —— 講清楚是暫停，不然狀態欄空著，玩家會以為同步還在跑。
    deckSyncStatus = {
      at: Date.now(),
      ok: false,
      text: "暫停：讀不到角色的註冊時間，算不出同步用的鑰匙",
    };
  }
  // 接上的這一刻剛讀完伺服器，而頁面記憶體就是從它來的 —— 兩邊同一份。
  deckSeen.remember("both", current);
  officialSeen = null;
  deck = {
    ...newSession(lib),
    active: resolveAll(lib, current),
    slotNow: snap.deckNow ?? 1,
  };

  try {
    if (backupOnce(deps.appDir, snap))
      ctx.log("· 已把你原本的三副牌組備份起來（decks 資料夾，插件不會再動它）");
  } catch (err) {
    ctx.log(`✗ 牌組備份失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // ⚠ 搬遷要在存檔之前，這樣第一次跑就只寫一次檔。
  // 只有插件模式要清 Deck2／Deck3（官方三牌組模式三格都是玩家的牌）。
  if (activeDeckMode() === "plugin") await adoptServerDecks(snap, existed);

  // ⚠ 上面那個 await 中間可能斷線（`deck` 會被重設）。重讀一次，不要沿用
  // await 之前的那個參照。
  const settled = deck;
  if (settled === null) return;
  // ⚠ 先把卡片庫存暖起來。換牌組要驗庫存，而冷的快取是三趟 WebSocket ——
  // 不暖的話「開遊戲之後第一次切換」會比之後每一次都慢上一秒，而玩家只會
  // 記得「這東西有時候很慢」。這裡不等它，失敗也無所謂（換牌組時會再讀）。
  void deckInventory();

  const total = ROOM_KINDS.reduce((n, r) => n + listDecks(settled.library, r).length, 0);
  ctx.log(
    activeDeckMode() === "official"
      ? `✓ 牌組庫已接上（${total} 副，官方三牌組模式：每一房用那一房的前三副）`
      : `✓ 牌組庫已接上（${total} 副）—— 在遊戲的牌組編輯畫面點左下角那個牌盒`,
  );
  if (dropped > 0) ctx.log(`⚠ 存檔裡有 ${dropped} 副壞掉的記錄，已跳過`);
  saveDeckLibrary({ sync: false });
  await pushDeckState();
  // 一接上就跟雲端對一次：另一台電腦在這段期間改的牌組要馬上過來。
  if (ctx.profile.deckCloudSync && deckSyncKey !== null) void runDeckSync();
}

/**
 * **把伺服器的 Deck2／Deck3 收進牌組庫，然後在伺服器上清空它們。**
 *
 * 2026-08-28 的決定：伺服器那三格只留 Deck1 當工作槽。
 *
 * ```
 *   伺服器 Deck2 ─▶ 自訂牌組第 2 格 ─┐
 *   伺服器 Deck3 ─▶ 自訂牌組第 3 格 ─┴─▶ 伺服器只剩 Deck1
 * ```
 *
 * ## ⚠ 為什麼「清空」不只是整理
 *
 * 卡片庫存是**三副共扣同一個池子**。Deck2/Deck3 佔著卡的時候，把同一張卡再
 * 寫進 Deck1 就是同一張用兩次 —— 改版後伺服器會直接退回 `deck_update`，而
 * 牌組編輯畫面退回時**不說話**，只是按返回沒反應。清空之後那些卡回到池子，
 * 每一副自訂牌組才都用得到它們（玩家要的「可用所有事件卡」就是這個）。
 *
 * ## 第一次 vs 之後
 *
 * - 這個帳號第一次接上（`existed === false`）：照 2026-08-28 的規則放進四房的
 *   **第 2、3 格**，順序跟玩家在遊戲裡看到的一樣。
 * - 之後（例如剛從官方三牌組模式切回來、或改版後在官方介面排了新牌）：**接在
 *   後面**，不覆蓋任何一副。已經在庫裡某一房的（內容一樣）就不再收。
 *
 * ## ⚠ 順序不能顛倒
 *
 * **先搬進庫、存檔，再清伺服器。** 反過來的話，清完到存檔之間任何一個閃失
 * （斷線、當掉）都會讓那兩副牌同時從伺服器和庫裡消失。備份檔是最後一道網。
 */
async function adoptServerDecks(snap: DeckSnapshot, existed: boolean): Promise<void> {
  if (ctx.engine === null || deck === null) return;

  const deck2 = deckContentFromServer(snap.decks[1]);
  const deck3 = deckContentFromServer(snap.decks[2]);
  const has2 = !isEmptyDeck(deck2);
  const has3 = !isEmptyDeck(deck3);
  if (!has2 && !has3) return;

  // 1. 先搬進庫並落地（已經在庫裡的就不再收）
  const known = (c: DeckContent): boolean =>
    deck !== null && ROOM_KINDS.some((r) => resolveActive(deck!.library, r, c) !== null);
  const take = [has2 && !known(deck2) ? deck2 : null, has3 && !known(deck3) ? deck3 : null];
  if (!existed) {
    deck = migrateServerDecks(deck, take[0] ?? null, take[1] ?? null);
  } else {
    let library = deck.library;
    for (const content of take) {
      if (content === null) continue;
      for (const room of ROOM_KINDS) library = addDeck(library, room, { content }).library;
    }
    deck = { ...deck, library };
  }
  saveDeckLibrary();

  // 2. 再清伺服器。Deck1 原樣帶回去 —— `deck_update` 一次覆寫整份。
  const next = snap.decks.map((d) =>
    d.deck_id === 1 ? d : withDeckContent(d, emptyDeckContent()),
  );
  try {
    const result = await ctx.engine.applyDecks(next);
    if (result.answer !== "ok") {
      ctx.log(
        result.answer === "rejected"
          ? "⚠ 想清空伺服器的 Deck2／Deck3，伺服器不收 —— 牌組已經收進庫裡了，下次再試"
          : "⚠ 想清空伺服器的 Deck2／Deck3，但伺服器沒回應 —— 牌組已經收進庫裡了，下次再試",
      );
      return;
    }
    // deck_update 成功 = 伺服器與記憶體都是這一份（頁面已經就地同步）。
    deckSeen.remember("both", fromGame(deckContentFromServer(snap.decks[0])));
    inventoryCache = null;
    const added = take.filter((c) => c !== null).length;
    ctx.log(
      `✓ 伺服器的 Deck${has2 && has3 ? "2、Deck3" : has2 ? "2" : "3"} 已清空` +
        (added > 0 ? `（${added} 副收進了牌組庫的每一房）` : "（庫裡本來就有）") +
        " —— 那些卡回到池子，現在每一副自訂牌組都用得到",
    );
  } catch (err) {
    ctx.log(`⚠ 清空 Deck2／Deck3 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 真的把一副牌寫進 Deck1。回 `null` = 成功，回字串 = 拒絕或失敗的理由。
 *
 * 三道關卡，順序不能換：
 *
 * ```
 *   1. guardDeck1  —— 第一格空的：房間與伺服器那條都不收（開戰會拿空牌上場）
 *                     ⚠ 人在 Edit 時寫空 = 幫他按 reset，那條放行
 *   2. 庫存        —— 只送玩家真的有的卡。讀不到庫存就**不寫**
 *   3. 伺服器的回答 —— deck_update 回 false 才算寫進去
 * ```
 *
 * ## 改版前的「讀回來對過」那一道拿掉了
 *
 * 舊協定（`db_editdeck`）的 ack 只證明伺服器回了話，2026-08-27 撞過「ack 了卻
 * 沒寫進去」，所以當時每次都要再讀一次。改版後的 `deck_update` 有明確的回答
 * （`false` = 成功、`true` = 退回），跟官方牌組編輯畫面認的是同一個 —— 不必再多
 * 送一次請求去驗（2026-09-13 的規矩：盡量不要多送）。
 */
/**
 * 寫到哪裡為止。
 *
 * ```
 *   front   只寫客戶端記憶體（玩家人在 Edit 畫面時）。**一次網路都不跑。**
 *           寫不到就回 `none` 當成功 —— 那不是失敗，只是他不在那個畫面。
 *   commit  一路寫到伺服器。等候秒數到了、或開戰前才走這條。
 * ```
 *
 * ⚠ 這個分法就是「只在前端看得到，不套用給後端」那條規格（2026-09-09）。
 */
type WriteMode = "front" | "commit";

/**
 * 寫到了哪裡 —— 呼叫端靠它決定「這一副算不算已經落地」。
 *
 * ```
 *   edit    寫進 Edit 畫面的記憶體。⚠ 對牌組庫而言**這就是落地**：遊戲會在玩家
 *           離開畫面時自己送上伺服器，沒有第二步要做（見 frontApplyPending）。
 *   room    只寫了房間場景的記憶體（front 模式）。伺服器還是舊的，還得提交。
 *   none    front 模式、沒有畫面可寫。那一副還排在隊伍裡。
 *   server  寫進伺服器並讀回對過。
 * ```
 */
type WriteDone = "edit" | "room" | "none" | "server";
type WriteResult = { done: WriteDone; failure?: undefined } | { done?: undefined; failure: string };

const failed = (failure: string): WriteResult => ({ failure });
const wrote = (done: WriteDone): WriteResult => ({ done });

async function writeDeck1(
  requested: DeckContent,
  snapshot: DeckSnapshot | null,
  mode: WriteMode = "commit",
): Promise<WriteResult> {
  if (ctx.engine === null) return failed("還沒接上遊戲。");
  let content = requested;

  // ⚠ 空牌組**不在這裡擋死**（2026-09-12 改）。玩家人在 Edit 畫面時選一副空的，
  // 等於幫他按 reset —— 寫進記憶體的狀態跟遊戲 reset 鈕產生的一模一樣，出口
  // 那道「第一格不能空」是遊戲自己擋、玩家看得到原因。原本一律拒絕的症狀是
  // 「選了空牌組，舊的那副還在畫面上」，得自己再按一次 reset。
  //
  // 擋的地方往下移：快路徑只有 Edit 收（房間場景回 `empty-room`），沒收到就照
  // 原本的理由拒絕 —— **伺服器那條路永遠不會拿到空的**，那才是卡死的來源。
  const guard = guardDeck1(content);

  // ⚠ 讀不到庫存時**拒絕**而不是放行。放行的代價是可能送出玩家沒有的卡，
  // 而拒絕的代價只是玩家再點一次 —— 兩邊不對等。（空牌組沒有卡可查，跳過。）
  if (guard === null) {
    const inventory = await deckInventory();
    if (inventory === null) return failed("讀不到你的卡片庫存，先不換 —— 再點一次試試。");
    // 手上沒有的角色卡臨時換成同角色的另一張（見 forGame）。⚠ 底下記進 deckSeen
    // 的是 `requested`（庫裡的寫法），跟 currentDeck1() 讀回來認的是同一套。
    content = forGame(content);
    const shortages = findShortages(content, inventory);
    if (shortages.length > 0) {
      return failed(`這副牌有 ${shortages.length} 張卡你手上沒有，沒有換過去。`);
    }
  }

  // ── 快路徑：玩家人就在編輯畫面 → 只換記憶體並重畫，一次網路都不跑 ────────
  //
  // 這是原版 ◀▶ 的做法（見 `deck-write.ts` 的 buildEditDeckWriteExpression）。
  // 走伺服器的話一次切換是 8~11 趟 WebSocket，玩家按下去要等一秒以上；
  // 走這裡是一次 `Runtime.evaluate`，跟原版一樣即時。
  //
  // ⚠ 這裡**不寫伺服器**，而那是對的：遊戲在玩家離開編輯畫面時會自己送
  // `deck_update`，帶的就是我們剛換進去的那一份。
  try {
    const fast = await ctx.engine.writeEditDeck([slotWrite(1, content)], 1);
    // 編輯畫面：寫完就結束。遊戲會在玩家離開時自己把它送上伺服器。
    if (fast === "ok") {
      // ⚠ **只有客戶端**。伺服器上還是舊的那一副，要等玩家離開 Edit 時遊戲
      // 自己送 —— 而那一趟正是自動存檔唯一收得到他最後一次編輯的機會。
      deckSeen.remember("client", requested);
      return wrote("edit");
    }
    // 空的那一副只有 Edit 收得下（上面 "ok" 那條）。走到這裡表示玩家不在
    // Edit —— 房間場景頁面端已經拒絕（`empty-room`）、不在畫面上更不能寫伺服器。
    // ⚠ 這裡 return 的是 guardDeck1 的理由，而且 `front` 模式也一樣：空牌組
    // 留在隊伍裡沒有意義，等候秒數到了只會在提交那一步再失敗一次。
    if (guard !== null) return failed(guard);
    // ⚠⚠ 房間場景（任務／渦／對戰房）：畫面已經換好了，但**沒有人會把它送上
    // 伺服器** —— 遊戲只在離開 Edit 時送。所以只有 `front` 模式可以在這裡收工；
    // `commit` 模式一定要繼續走下去，否則開戰時伺服器上還是舊的那一副，
    // 而畫面看起來完全正常。
    if (fast === "ok-room") {
      // ⚠⚠ **只有客戶端**，而且房間場景裡沒有人會把它送上伺服器。這一行就是
      // 2026-09-20「迪城的牌組1 變成渦那副」的起點：舊制把它記成唯一一份基準，
      // 於是三秒內讀到伺服器（還躺著上一房那副）就被判成「玩家改了牌」。
      deckSeen.remember("client", requested);
      if (mode === "front") return wrote("room");
    } else if (fast !== "not-active") {
      return failed(`換不過去：${fast}`);
    } else if (mode === "front") {
      // 玩家不在任何有牌組列的畫面，沒有記憶體可以換。**這不是失敗**：
      // 那一副還排在隊伍裡，等候秒數到了或他按開戰時才會真的寫出去。
      return wrote("none");
    }
  } catch (err) {
    return failed(`換不過去：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 慢路徑：寫伺服器 ──────────────────────────────────────────────────────
  const snap = snapshot ?? (await ctx.engine.readDecks());

  // ⚠ Deck2/Deck3 照原樣帶回去 —— `deck_update` 一次覆寫整份，不帶就是清空。
  const next = snap.decks.map((d) => (d.deck_id === 1 ? withDeckContent(d, content) : d));
  // 三副共用一個卡池：Deck2／Deck3 還沒清掉的話，要合起來塞得下才送。
  if (guard === null) {
    const inventory = await deckInventory();
    const others = snap.decks.filter((d) => d.deck_id !== 1).map((d) => deckContentFromServer(d));
    if (inventory !== null && findSetShortages([content, ...others], inventory).length > 0) {
      return failed("這副牌跟 Deck2／Deck3 搶同一張卡，沒有換過去 —— 伺服器上那兩副要先清空。");
    }
  }
  const result = await ctx.engine.applyDecks(next);
  if (result.answer === "no-answer") {
    return failed("伺服器沒有回應，牌組沒有換過去 —— 再點一次試試。");
  }
  if (result.answer === "rejected") {
    ctx.log("✗ 換牌組：伺服器退回了（多半是 Deck2／Deck3 還佔著同一張卡）");
    return failed("伺服器不收這副 —— 多半是 Deck2／Deck3 還佔著同一張卡。");
  }
  // deck_update 回 false：伺服器與記憶體都是這一份（頁面已經就地同步）。
  deckSeen.remember("both", requested);
  return wrote("server");
}

/**
 * 玩家在牌組編輯畫面點了什麼。
 *
 * ⚠ **先讀一次 Deck1 現況**，理由是自動存檔：玩家很可能剛排完牌就直接按 ◀▶，
 * 那些改動只存在客戶端記憶體裡。不先存回去的話，下一副牌一換進來就沒了 ——
 * 而症狀是「我排的牌自己不見了」。
 *
 * ⚠ **不要在這裡讀伺服器。** 人就在編輯畫面時 `currentDeck1()` 走記憶體，
 * 整條路徑只剩三次 `Runtime.evaluate`；換成讀伺服器的話每按一次 ◀▶ 都是
 * 八到十一趟 WebSocket，而那正是玩家回報的「換自訂牌組好慢」。
 * 換帳號的偵測交給輪詢那一拍（它離開畫面時本來就會讀伺服器）。
 */
async function onDeckReport(report: DeckEditReport): Promise<void> {
  if (ctx.engine === null || deck === null) return;
  // 玩家連點時忙著就丟掉後面幾則 —— 但 raid-pick 同一個渦頁面只報一次，丟了
  // 就不會再來（常見的撞法：剛進渦房、進房換牌還在寫就點了渦），所以等它讓出來。
  if (deckBusy && !(report.type === "raid-pick" && (await waitForDeckIdle(2_000)))) return;
  if (deckBusy || ctx.engine === null || deck === null) return;
  deckBusy = true;
  try {
    const now = await currentDeck1();
    if (now === null) {
      deck = withNotice(deck, "讀不到你的牌組 —— 再點一次試試。");
      await pushDeckState();
      return;
    }
    const { current, snap } = now;
    // 換帳號登入了 —— 這一則屬於上一個人的庫，丟掉，下一拍整份重來。
    // ⚠ 快路徑也驗（`now.account`），不是只有讀伺服器那條：見 resetDeckSession。
    if (accountChanged(now.account)) return;

    if (activeDeckMode() === "official") {
      await onOfficialReport(report, now);
      return;
    }

    // ⚠ 房間場景看到的變動是 preload 做的，不是玩家的編輯 —— 見 mayAutoSave。
    // ⚠ 基準要跟**同一個來源**的上一份比（`deckSeen.forSource`），見 deck-seen.ts。
    const saved = mayAutoSave(now.where)
      ? autoSave(deck, current, deckSeen.forSource(now.where))
      : { session: deck, saved: false };
    deckSeen.remember(worldOf(now.where), current);

    // ⚠ 房裡那組 ◀▶ 切的是**玩家人在的那一房**，不是選單看的那一房。
    //
    // 兩者平常一致（進房時選單會自動跟隨），但玩家可以人在任務房、卻把選單
    // 切去看迪城的牌組 —— 那時候按房裡的箭頭必須切任務房的那幾副。少了這一
    // 步的後果是**拿錯牌組上場**，而畫面上完全看不出來。
    let base = saved.session;
    if (
      report.type === "deck-cycle" &&
      report.from === "room" &&
      base.here !== null &&
      base.here !== base.room
    ) {
      base = { ...base, room: base.here };
    }

    const outcome = applyReport(base, report, current);
    // ⚠ 訊息要自己寫進記錄。遊戲畫面上那行紅字移掉之後（見 `DeckEditState`），
    // `applyReport()` 交出來的訊息就只剩這一個出口 —— 少了這一步，「這一房還
    // 沒有牌組」「已刪除…」這些話會完全消失。
    if (outcome.session.notice !== null && outcome.session.notice !== base.notice) {
      ctx.log(`· ${outcome.session.notice}`);
    }
    deck = outcome.session;

    // ⚠⚠ **只寫前端**（2026-09-09 起）。伺服器那一份等等候秒數到了、或者
    // 玩家按下開戰時才寫 —— 見 `PendingApply` 與 `patch-room-gate.ts`。
    await frontApplyPending(current, snap);
    saveDeckLibrary();
    await syncGatePending();
    await pushDeckState();
  } finally {
    deckBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 官方三牌組模式（2026-09-24）
//
// 每一房的前三副就是那一房的 Deck1..3。進房時三格一起換進客戶端記憶體（頁面
// 預載），開戰前閘門確認伺服器上是這三副；◀▶ 照官方行為。跟插件模式最大的差別：
// 三副同時躺在伺服器上，所以**庫存要三副合起來算**（findSetShortages）。
// ---------------------------------------------------------------------------

type DeckRead = NonNullable<Awaited<ReturnType<typeof currentDeck1>>>;

/**
 * 把 `room` 那一房的三副換進客戶端記憶體（只動記憶體，一趟網路都不跑）。
 * 回 `null` = 換好了（或那一房沒有牌組、玩家不在有牌組列的畫面，都不必換）；
 * 回字串 = 為什麼沒換。
 */
async function loadOfficialSet(room: RoomKind): Promise<string | null> {
  if (ctx.engine === null || deck === null) return "還沒接上遊戲。";
  const set = officialSetOf(deck.library, room);
  if (set.every((s) => s.entry === null)) return null;
  const inventory = await deckInventory();
  if (inventory === null) return "讀不到你的卡片庫存，先不換。";
  // 手上沒有的角色卡臨時換掉（見 forGame）。三副各自換，合起來還是要塞得下。
  const contents = set.map((s) => forGame(s.content));
  const short = findSetShortages(contents, inventory);
  if (short.length > 0) {
    return `${ROOM_LABELS[room]}那三副合起來有 ${short.length} 種卡不夠（三副共用一個卡池），沒有換過去。`;
  }
  const res = await ctx.engine.writeEditDeck(
    set.map((s, i) => slotWrite(s.deckId, contents[i] ?? s.content)),
    null,
  );
  if (res === "ok" || res === "ok-room" || res === "not-active") return null;
  return `換不過去：${res}`;
}

/** 官方三牌組模式的選單回報。`now` 是呼叫端剛讀的那一份。 */
async function onOfficialReport(report: DeckEditReport, now: DeckRead): Promise<void> {
  if (deck === null) return;
  // 先把玩家在 Edit 裡排的存回去（跟插件模式一樣：先存再動，不然換進來的會蓋掉他的牌）。
  if (now.where !== "room") {
    const saved = officialAutoSave(deck, now.set, officialSeen);
    if (saved.saved > 0) deck = saved.session;
  }
  officialSeen = now.set;
  // 官方模式不照渦 BOSS 換牌（那是插件模式「一房很多副」才有的功能）。
  if (report.type === "raid-pick") return;
  deck = { ...deck, slotNow: now.deckNow ?? deck.slotNow };
  const out = applyOfficialReport(deck, report);
  if (out.session.notice !== null && out.session.notice !== deck.notice) {
    ctx.log(`· ${out.session.notice}`);
  }
  deck = out.session;
  if (out.load) {
    const why = await loadOfficialSet(deck.room);
    if (why !== null) {
      ctx.log(`✗ ${why}`);
    } else {
      // 剛換進去的就是新的比較基準，不是玩家的編輯。
      officialSeen = officialSetOf(deck.library, deck.room).map((s) => s.content);
      if (report.type === "room-switch") ctx.log(`· 換上${ROOM_LABELS[deck.room]}的三副`);
    }
  }
  saveDeckLibrary();
  await pushDeckState();
}

/**
 * 官方三牌組模式的開戰前那一道：伺服器上躺的一定要是這一房的三副。
 * 回 `true` 表示可以放心開打（包含「這一房沒有指派牌組，不歸我們管」）。
 */
async function ensureOfficialSet(room: RoomKind | null): Promise<boolean> {
  if (ctx.engine === null || deck === null) return false;
  if (room === null) return true;
  // 先讀庫存：伺服器那三副要用它認回庫裡的寫法（fromGame），寫的時候也要換卡。
  const inventory = await deckInventory();
  if (deck === null) return false;
  const set = officialSetOf(deck.library, room);
  if (set.every((s) => s.entry === null)) return true;
  let snap: DeckSnapshot;
  try {
    snap = await ctx.engine.readDecks();
  } catch (err) {
    logReadDecksFailure("battle", err);
    return false;
  }
  const server = snap.decks.map((d) => fromGame(deckContentFromServer(d)));
  const target = set.map((s) => s.content);
  if (sameSet(server, target)) return true;
  const effective = set.map((s) => forGame(s.content));
  if (inventory === null || findSetShortages(effective, inventory).length > 0) {
    ctx.log(`✗ 開戰前換牌組：${ROOM_LABELS[room]}那三副合起來庫存不夠，照伺服器上原本的打`);
    return false;
  }
  const next = snap.decks.map((d) => {
    const i = set.findIndex((x) => x.deckId === d.deck_id);
    return i < 0 ? d : withDeckContent(d, effective[i] ?? set[i]!.content);
  });
  const result = await ctx.engine.applyDecks(next);
  if (result.answer !== "ok") {
    ctx.log(
      `✗ 開戰前換牌組：${result.answer === "rejected" ? "伺服器不收" : "伺服器沒有回應"}` +
        `（${ROOM_LABELS[room]}的三副），照伺服器上原本的打`,
    );
    return false;
  }
  ctx.log(`✓ 開戰前已換上${ROOM_LABELS[room]}的三副`);
  return true;
}

// ---------------------------------------------------------------------------
// 等候套用與開戰閘門（WP-19）
// ---------------------------------------------------------------------------

/** 上一次推給頁面的 pending 旗標。**只在變動時推**，不然每 500ms 一次 evaluate。 */
let gatePendingPushed: boolean | null = null;

/** 一副牌在記錄與訊息裡要叫什麼。找不到就用位置編號（跟選單裡一致）。 */
function deckLabel(session: DeckSession, room: RoomKind, id: string): string {
  const entry = findDeck(session.library, room, id);
  if (entry === null) return "那一副";
  const index = listDecks(session.library, room).findIndex((d) => d.id === id);
  return displayName(entry, index < 0 ? 0 : index);
}

/**
 * 把「有沒有東西還沒寫進伺服器」推給頁面的閘門。
 *
 * ⚠ 旗標是 `false` 時閘門完全不作用，開戰的 emit 原樣直通 —— 那是常態路徑，
 * 一次額外的延遲都沒有。
 */
async function syncGatePending(): Promise<void> {
  if (ctx.engine === null) return;
  const want = deck !== null && deck.pending !== null;
  if (want === gatePendingPushed) return;
  gatePendingPushed = want;
  await ctx.engine.setRoomGatePending(want);
}

/**
 * **把排著隊的那一副立刻換到玩家眼前。** 只動客戶端記憶體，一次網路都不跑。
 *
 * ## 為什麼「排隊」跟「看得見」要分開
 *
 * 排隊那三秒（{@link PendingApply}）擋的是**寫伺服器** —— 玩家連按 ◀▶ 找牌組
 * 時每一下都上傳一次的話，他等的是「按幾下 × 一秒」。但**畫面**沒有理由跟著
 * 等：換記憶體是一次 `Runtime.evaluate`，跟原版那兩個箭頭一樣即時。
 *
 * ⚠⚠ 2026-09-09 回報：**進了任務房，畫面上還是渦房那副牌，要等三秒才換。**
 * 原因就是進房那條路（`onRoomGate` 的 `room-changed`）只排隊、沒有走這裡，
 * 於是玩家看到的是三秒後伺服器那條慢路徑把畫面換過去。人在哪一房就該看到
 * 那一房的牌，這件事不能有延遲 —— 延遲期間他看到的是**上一房**的牌，而那正
 * 是他最容易誤按 START 打下去的東西。
 *
 * ⚠ 寫不進去（庫存不足、第一格是空的…）就**把隊伍清掉**，不要留著等三秒後
 * 再失敗一次。同時把 `active` 重算回來 —— 那一副沒有換成，黃字不該指著它。
 *
 * ⚠ `fronted` 記的是「已經換到眼前了」，這支靠它避免重複寫。它**不表示**已經
 * 寫進伺服器 —— 那是 {@link commitPending} 的事。
 *
 * ## ⚠⚠ 在 Edit 畫面換到眼前 = 落地，隊伍當場清掉（2026-09-12）
 *
 * 人在牌組編輯畫面時，這一步之後**沒有第二步**：遊戲會在玩家離開畫面時自己把
 * deck1 送上伺服器，等候秒數到了再「提交」一次是多餘的 —— 而且有害。提交走
 * 的是同一條快路徑，會把**庫裡那份快照**再寫進記憶體一次，玩家在那三秒裡排
 * 的牌當場被蓋回去（選了空牌組的話，是剛放進去的卡又被清掉）。2026-09-12
 * 回報：「三秒套用牌組已經干擾了手牌編輯，把手牌清空，或是把手牌復原」。
 *
 * 所以 `edit` 這個結果直接 {@link applyLanded}：active 指到那一副（接下來的
 * 編輯由自動存檔存進它），pending 清掉（等候秒數與開戰閘門都不會再碰它）。
 * 房間場景（`room`）不在此列 —— 那裡沒有人會把記憶體送上去，非提交不可。
 */
async function frontApplyPending(
  current: DeckContent,
  snapshot: DeckSnapshot | null,
): Promise<void> {
  if (deck === null) return;
  const pending = deck.pending;
  if (pending === null || pending.fronted) return;

  // 左下那行字由頁面照狀態畫（`DeckEditState.slots`），這裡只拿名字寫記錄。
  const label = deckLabel(deck, pending.room, pending.id);
  const result = await writeDeck1(pending.content, snapshot, "front");
  if (result.failure !== undefined) {
    deck = withNotice(
      {
        ...deck,
        pending: null,
        active: {
          ...deck.active,
          [pending.room]: resolveActive(deck.library, pending.room, current),
        },
      },
      result.failure,
    );
    ctx.log(`✗ 換牌組：${result.failure}`);
    return;
  }
  if (result.done === "edit") {
    // 編輯畫面：到此為止（見上面 ⚠⚠）。
    deck = applyLanded(deck, pending);
    ctx.log(`✓ 已換成「${label}」（${ROOM_LABELS[pending.room]}，離開編輯畫面時遊戲自己會存）`);
    return;
  }
  // 前端換好了，玩家眼睛已經看到新的牌。
  if (deck.pending !== null) deck = { ...deck, pending: { ...deck.pending, fronted: true } };
}

/**
 * **把排著隊的那一副真的寫進伺服器。** 回 `true` 表示寫成了（或本來就不必寫）。
 *
 * ⚠ 這支是唯一會走慢路徑的地方。它有三個呼叫端：等候秒數到了、玩家按下開戰、
 * 以及玩家離開遊戲前的收尾。
 */
async function commitPending(reason: "dwell" | "battle"): Promise<boolean> {
  if (ctx.engine === null || deck === null) return true;
  const pending = deck.pending;
  if (pending === null) return true;

  // ⚠⚠ **這裡一定要看伺服器，不能用 `currentDeck1()`。**
  //
  // `currentDeck1()` 回的是「玩家眼前那一副」，而在房間場景那正是我們自己剛
  // 寫進去的 pending —— 拿它來判斷「要不要提交」的話**永遠都會相等**，於是
  // 一次都不會真的寫到伺服器，而開戰時用的是舊的那一副。畫面看起來完全正常，
  // 這是最難發現的那一種。
  let snap: DeckSnapshot;
  try {
    snap = await ctx.engine.readDecks();
  } catch (err) {
    // 讀不到就不寫 —— 沒有比較基準時動 Deck1 是這個專案付過代價的事。
    //
    // ⚠⚠ **但一定要說出來**（2026-09-20）。這條路原本一個字都不寫，而它會
    // 一直失敗下去（`readDecks` 走頁面裡自己開的那條池連線，遊戲剛重載完
    // 那個東西還不存在）。症狀是「插件說換好了、打起來卻是上一房的牌」，
    // 而記錄檔完全空白 —— 月的腳本 2026-09-10 就是在這裡卡了 35 秒。
    logReadDecksFailure(reason, err);
    return false;
  }
  // fromGame 要用庫存；斷線重連後快取是空的，先讀一次（不送請求）。
  if (inventoryCache === null) await deckInventory();
  const server = fromGame(deckContentFromServer(snap.decks[0]));

  // 伺服器上已經是那一副了（玩家自己在遊戲裡換的、或離開 Edit 時遊戲自己送上
  // 去的）→ 沒有東西要做。
  if (deckContentHash(server) === deckContentHash(pending.content)) {
    deck = applyLanded(deck, pending);
    // ⚠ 只記伺服器那一份。客戶端記憶體我們沒碰（玩家可能根本不在有牌組列的
    // 畫面上），拿這一份去蓋客戶端基準等於替一個沒看過的世界作證。
    deckSeen.remember("server", server);
    saveDeckLibrary();
    await syncGatePending();
    await pushDeckState();
    return true;
  }

  const result = await writeDeck1(pending.content, snap, "commit");
  if (result.failure !== undefined) {
    // ⚠ 寫不進去就把隊伍清掉，**不要留著反覆重試**。留著的話玩家每按一次
    // 開戰都會被攔一下再失敗一次，而他看到的是「這遊戲卡卡的」。
    //
    // ⚠⚠ **`active` 要照伺服器現況重算**（2026-09-20）。寫失敗的意思是伺服器
    // 上躺的還是上一房那副，而 `enterRoom` 早就把 `active[room]` 指到玩家想換
    // 的那一副了 —— 兩者兜在一起，下一次讀到伺服器就會把上一房那副存進他這
    // 一副（實機：從渦房走到對戰房，迪城的牌組1 整副變成渦那副）。隊伍清掉
    // 之後 `pending` 那道閘也不再擋，所以這裡非重算不可。
    // 這跟 `frontApplyPending` 失敗時做的是同一件事。
    deck = withNotice(
      {
        ...deck,
        pending: null,
        active: {
          ...deck.active,
          [pending.room]: resolveActive(deck.library, pending.room, server),
        },
      },
      result.failure,
    );
    // 伺服器那一份基準也要追上：我們剛親眼看到它還是 `server`。
    deckSeen.remember("server", server);
    ctx.log(`✗ ${reason === "battle" ? "開戰前換牌組" : "套用牌組"}：${result.failure}`);
    await syncGatePending();
    await pushDeckState();
    return false;
  }

  deck = applyLanded(deck, pending);
  const label = deckLabel(deck, pending.room, pending.id);
  ctx.log(
    reason === "battle"
      ? `✓ 開戰前已套用「${label}」（${ROOM_LABELS[pending.room]}）`
      : `✓ 已套用「${label}」（${ROOM_LABELS[pending.room]}）`,
  );
  saveDeckLibrary();
  await syncGatePending();
  await pushDeckState();
  return true;
}

/**
 * 每半秒看一眼排著的那一副等夠久了沒。
 *
 * ⚠ 這一拍**不碰網路**，除非真的到期要寫 —— 沒有 pending 時它只是一個
 * 布林判斷。
 */
async function deckApplyTick(): Promise<void> {
  if (ctx.engine === null || deck === null || deckBusy) return;
  if (deck.pending === null) return;
  if (!isApplyDue(deck, applyDelayMs())) return;
  deckBusy = true;
  try {
    await commitPending("dwell");
  } finally {
    deckBusy = false;
  }
}

/** 玩家設的等候秒數，換算成毫秒。 */
function applyDelayMs(): number {
  return Math.round(ctx.profile.applyDelaySeconds * 1000);
}

/**
 * 頁面回報：換房了，或者開戰被攔下來了。
 *
 * ⚠⚠ **`room-gate-hold` 一定要放行。** 玩家的畫面在被攔的那一刻已經是「已
 * 開始」而且點不動任何東西 —— 這裡每一條路徑（包含失敗）都必須走到
 * `releaseRoomGate()`。頁面自己有 8 秒的看門狗兜底，但那條路會讓玩家用舊牌組
 * 上場。
 */
async function onRoomGate(report: RoomGateReport): Promise<void> {
  if (ctx.engine === null) return;
  const mode = activeDeckMode();
  // 關閉模式、或牌組庫還沒接上：攔到的一律立刻放行（頁面理應不會攔，這是保險）。
  if (mode === null || deck === null) {
    if (report.type === "room-gate-hold") await ctx.engine.releaseRoomGate(true);
    return;
  }

  if (report.type === "room-changed") {
    const now = await currentDeck1();
    if (now === null) return;
    // ⚠⚠ 這裡最要緊：換了帳號還往下走的話，enterRoom 會拿上一個人的庫排隊、
    // frontApplyPending 把那副牌塞進這個人的 Deck1（2026-09-14 實機）。
    if (accountChanged(now.account) || deck === null) return;

    if (mode === "official") {
      // 官方三牌組模式：選單跟著人走；頁面沒預載到的話（這一房剛有牌組、腳本
      // 晚裝上）托盤自己換。伺服器那份等開戰前的閘門寫。
      if (report.room !== null) {
        deck = { ...deck, here: report.room, room: report.room, slotNow: now.deckNow ?? 1 };
        if (report.preloaded !== true) {
          const why = await loadOfficialSet(report.room);
          if (why !== null) ctx.log(`✗ 進了${ROOM_LABELS[report.room]}：${why}`);
        }
      } else {
        deck = { ...deck, here: null };
      }
      await pushDeckState();
      return;
    }

    const before = deck.pending?.id ?? null;
    // ⚠ `preloaded` 一定要傳下去。它是 true 時客戶端記憶體已經是新的、而伺服器
    // 還是舊的 —— 不傳的話 `queueApply` 會判定「一樣，不必寫」，於是開戰時用的
    // 是上一房的牌，而畫面完全正常。見 `RoomChangedReport`。
    deck = enterRoom(deck, report.room, now.current, Date.now(), {
      preloaded: report.preloaded === true,
    });
    if (report.room !== null && deck.pending !== null && deck.pending.id !== before) {
      // ⚠ 這裡**只寫記錄，不放訊息到畫面上**。原本會在遊戲畫面印一行紅字
      // 「正要換成「X」」，2026-09-09 移除：它會壓到渦房的「輸入Raid代碼」，
      // 而且左下那行字本來就寫著同一個名字。
      ctx.log(
        `· 進了${ROOM_LABELS[report.room]} —— 排上「${deckLabel(deck, report.room, deck.pending.id)}」`,
      );
    }

    // ⚠⚠ **畫面要當場換過去，不能等等候秒數。**
    //
    // 排隊那幾秒擋的是寫伺服器；畫面沒有理由跟著等（見 frontApplyPending）。
    // 少了這一步，玩家進了任務房看到的是**渦房那副牌**，三秒後才變 —— 而那
    // 三秒裡他按 START 打下去的正是上一房的牌組。
    //
    // ⚠ 要拿 `deckBusy`：這支是頁面輪詢叫進來的，而 `onDeckReport` 可能正在
    // 寫。等不到就算了 —— 那一副還排在隊伍裡，等候秒數到了或按開戰時照樣會
    // 寫出去，只是畫面晚一點換。
    if (deck.pending !== null && !deck.pending.fronted && (await waitForDeckIdle(1_000))) {
      deckBusy = true;
      try {
        await frontApplyPending(now.current, now.snap);
        saveDeckLibrary();
      } catch (err) {
        ctx.log(`✗ 進房換牌組出錯：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        deckBusy = false;
      }
    }

    await syncGatePending();
    await pushDeckState();
    return;
  }

  if (report.type === "room-gate-hold") {
    // ⚠ 這條路徑**不能被 `deckBusy` 擋掉**（那是「玩家連點時丟掉後面幾則」用
    // 的）。開戰只有這一次機會，丟掉的話玩家就是用舊牌組上場。所以這裡是等它
    // 讓出來，不是直接放棄 —— 但也不能無限等，頁面的看門狗只給 8 秒。
    const waited = await waitForDeckIdle(3_000);
    deckBusy = true;
    let ok = false;
    try {
      if (!waited) ctx.log("⚠ 開戰前換牌組：上一個動作還沒做完，先照現在的牌組打");
      // 開戰前這一次一定要寫到伺服器，等候秒數在這裡不算數。
      else if (mode === "official") ok = await ensureOfficialSet(report.room);
      else ok = await ensureRoomDeck(report.room);
    } catch (err) {
      ctx.log(`✗ 開戰前換牌組出錯：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      deckBusy = false;
      // ⚠ **無論如何都要放行。** 見這支的檔頭。
      // ⚠ `ok` 要照實傳：false 時頁面下一場會再攔一次（見 `needGate()`）。
      await ctx.engine?.releaseRoomGate(ok);
    }
    return;
  }

  if (report.type === "room-gate-timeout") {
    // 頁面的看門狗放行了 —— 我們沒有在 8 秒內回去，這一場用的是伺服器上原本
    // 那副。⚠ 這件事一定要留下一行，它正是「怎麼又用錯牌組」的唯一線索。
    ctx.log(
      `⚠ 開戰前換牌組等太久（${report.event}）—— 頁面自己放行了，這一場用的是伺服器上原本那副`,
    );
  }
}

/**
 * **開戰前的最後一道：伺服器上躺的，一定要是這一房選的那一副。**（2026-09-20）
 *
 * 回 `true` 表示「現在可以放心開打」。
 *
 * ## ⚠⚠ 為什麼不能只 `commitPending()`
 *
 * 那支只處理「托盤自己知道有東西要寫」的情況，而漏掉的那幾條全都會讓玩家拿
 * 上一房的牌上場，且畫面完全正常：
 *
 * ```
 *   腳本在牌組編輯畫面選完就 scene.start 跳走  遊戲沒機會送 db_editdeck，
 *                                              而托盤已經當成「換好了」
 *   提交那一趟失敗                             隊伍被清掉，沒有人會再試
 *   客戶端記憶體剛好已經是那一副                托盤判「不必排隊」，
 *                                              伺服器卻還是上一房那副
 * ```
 *
 * 所以這裡**不看任何旗標**：直接讀伺服器，跟這一房 `selected` 的那副比，
 * 不一樣就當場寫。一次進房只會走到這裡一次（頁面的 `st.verified`）。
 *
 * ⚠ 讀不到伺服器時回 `false` 而不是 `true`：那表示我們根本不知道上面躺的是
 * 什麼，記成「驗過了」等於把之後每一場都放掉。
 */
async function ensureRoomDeck(room: RoomKind | null): Promise<boolean> {
  if (ctx.engine === null || deck === null) return false;
  // 有東西排著隊 → 那條路本來就會讀伺服器、寫進去、對過。
  if (deck.pending !== null) return await commitPending("battle");
  if (room === null) return true; // 認不出在哪一房（還在選頻道）→ 不插手
  const entry = resolveSelected(deck.library, room);
  if (entry === null) return true; // 這一房沒有指派牌組 → 不是我們該管的

  let snap: DeckSnapshot;
  try {
    snap = await ctx.engine.readDecks();
  } catch (err) {
    logReadDecksFailure("battle", err);
    return false;
  }
  // fromGame 要用庫存；斷線重連後快取是空的，先讀一次（不送請求）。
  if (inventoryCache === null) await deckInventory();
  const server = fromGame(deckContentFromServer(snap.decks[0]));
  deckSeen.remember("server", server);
  const label = deckLabel(deck, room, entry.id);
  if (deckContentHash(server) === deckContentHash(entry.content)) {
    // 本來就是它 —— 順手把 active 對好（伺服器親口說的，這是最硬的證據）。
    deck = { ...deck, active: { ...deck.active, [room]: entry.id } };
    return true;
  }

  ctx.log(`· 開戰前發現伺服器上不是「${label}」（${ROOM_LABELS[room]}）—— 現在寫進去`);
  const result = await writeDeck1(entry.content, snap, "commit");
  if (result.failure !== undefined) {
    ctx.log(`✗ 開戰前換牌組：${result.failure}`);
    deck = withNotice(
      {
        ...deck,
        // ⚠ 寫不進去 → active 照伺服器現況重算，不要留著一個假的「套用中」。
        active: { ...deck.active, [room]: resolveActive(deck.library, room, server) },
      },
      result.failure,
    );
    await pushDeckState();
    return false;
  }
  deck = { ...deck, active: { ...deck.active, [room]: entry.id } };
  ctx.log(`✓ 開戰前已套用「${label}」（${ROOM_LABELS[room]}）`);
  await pushDeckState();
  return true;
}

/** 上一次抱怨「讀不到伺服器上的牌組」是什麼時候。等候那條路每半秒重試一次。 */
let readDecksFailLoggedAt = 0;

/** 讀不到伺服器上的牌組。開戰那一次一定要說，等候那條路節流。 */
function logReadDecksFailure(reason: "dwell" | "battle", err: unknown): void {
  const now = Date.now();
  if (reason === "dwell" && now - readDecksFailLoggedAt < 30_000) return;
  readDecksFailLoggedAt = now;
  const why = err instanceof Error ? err.message : String(err);
  ctx.log(
    `✗ ${reason === "battle" ? "開戰前" : "套用牌組"}：讀不到伺服器上的牌組，先不寫（${why}）` +
      "　—— 牌組沒換成，打起來會是上一次那副",
  );
}

/** 等 `deckBusy` 讓出來。逾時回 `false` —— 呼叫端要自己決定怎麼辦。 */
async function waitForDeckIdle(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (deckBusy) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * 每一拍：把介面補回去、把玩家剛改的牌存起來、把過期的訊息清掉。
 *
 * ⚠ **只有玩家人就在牌組編輯畫面（或剛離開）時才去讀 Deck1。** 那是唯一會有
 * 變動的時機，而每一次讀都是四趟 WebSocket。剛離開那一拍也要讀，是因為遊戲
 * 自己會在離開 Edit 時把 Deck1 存回伺服器 —— 那正是玩家最後一次改動。
 */
async function deckTick(): Promise<void> {
  // ⚠ 上一拍還沒跑完就不要疊第二拍（2026-09-13）。牌組連線卡住時每一次讀都要
  // 等 30 秒逾時，而拍子是 4 秒 —— 疊起來的 initDeckLibrary 之後各自回來，
  // 成功的那幾個會把 session 整份重建好幾次，失敗的那幾個則在「已接上」之後
  // 又印一句「在等遊戲登入」。
  if (deckTickRunning) return;
  deckTickRunning = true;
  try {
    await deckTickOnce();
  } finally {
    deckTickRunning = false;
  }
}

let deckTickRunning = false;

async function deckTickOnce(): Promise<void> {
  if (ctx.engine === null || deps.latest()?.connected !== true) return;
  // 關閉模式：插件不碰牌組，連讀都不讀。切回來時 `resetDeckSession()` 會讓下一拍重新接上。
  const mode = activeDeckMode();
  if (mode === null) return;
  if (deckPending) {
    await initDeckLibrary();
    return;
  }
  if (deck === null || deckBusy) return;

  // 雲端牌組庫：沒動靜時也要定期看一眼（另一台電腦改的東西靠這一拍過來）。
  if (
    ctx.profile.deckCloudSync &&
    deckSyncTimer === null &&
    !deckSyncRunning &&
    Date.now() - (deckSyncStatus?.at ?? 0) > DECK_SYNC_INTERVAL_MS
  ) {
    void runDeckSync();
  }

  // ⚠ 這支順便把「遊戲重載過、介面被沖掉了」補回來（見 engine 的 deckEditStatus）。
  const status = await ctx.engine.deckEditStatus();
  const mounted = status?.mounted === true;
  const wasMounted = deckMounted;
  deckMounted = mounted;

  let dirty = false;
  const aged = expireNotice(deck);
  if (aged.changed) {
    deck = aged.session;
    dirty = true;
  }

  if (mounted || wasMounted) {
    try {
      const now = await currentDeck1();
      if (now !== null) {
        // 換帳號：快路徑現在也帶帳號指紋（2026-09-14 前只有伺服器那條路驗得到，
        // 而同一個分頁換帳號、登完直接進房的話永遠走不到那條路）。
        if (accountChanged(now.account)) return;
        if (mode === "official") {
          if (officialTick(now, mounted && !wasMounted)) dirty = true;
          if (dirty) await pushDeckState();
          return;
        }
        // ⚠ 同上：房間場景那一份不能拿來存（見 mayAutoSave）。這一拍是災情
        //   最常發生的地方 —— 玩家什麼都沒做，光是換房就會走到這裡。
        const saved = mayAutoSave(now.where)
          ? autoSave(deck, now.current, deckSeen.forSource(now.where))
          : { session: deck, saved: false };
        deckSeen.remember(worldOf(now.where), now.current);
        if (saved.saved) {
          deck = saved.session;
          saveDeckLibrary();
          dirty = true;
        }
        // 剛進編輯畫面那一拍：選單跟著「手上這副是哪一房的」走，見
        // `followDeckOnEdit`。⚠ 只在進來那一拍做 —— 之後玩家在裡面改牌，
        // 內容跟每一副都對不上是常態，每拍都算的話選單會跳來跳去。
        if (mounted && !wasMounted && now.where === "edit") {
          const followed = followDeckOnEdit(deck, now.current);
          if (followed !== deck) {
            const label =
              followed.active[followed.room] === null
                ? "？"
                : deckLabel(followed, followed.room, followed.active[followed.room] ?? "");
            ctx.log(
              `· 進了牌組編輯 —— 手上是「${label}」（${ROOM_LABELS[followed.room]}），選單跟過去`,
            );
            deck = followed;
            saveDeckLibrary();
            dirty = true;
          }
        }
      }
    } catch {
      // 連線正在死。下一拍再說。
    }
  }

  if (dirty) await pushDeckState();
}

/**
 * 官方三牌組模式的一拍。回 `true` = 狀態變了，要重推畫面。
 *
 * ```
 *   剛進牌組編輯   認出手上這三副是哪一房的 → 選單跟過去；比較基準重設
 *   在編輯畫面裡   第 n 格變了 → 存回那一房的第 n 副（officialAutoSave）
 *   剛離開         遊戲自己把牌組送上伺服器了，最後那幾下編輯在伺服器那份裡
 * ```
 *
 * ⚠ 房間場景裡看到的變動不存（那是進房預載換的），跟插件模式的 `mayAutoSave` 同一條。
 */
function officialTick(now: DeckRead, entered: boolean): boolean {
  if (deck === null) return false;
  let dirty = false;
  if (now.deckNow !== null && now.deckNow !== deck.slotNow) {
    deck = { ...deck, slotNow: now.deckNow };
    dirty = true;
  }
  if (entered && now.where === "edit") {
    const room = officialRoomOf(deck.library, now.set, deck.room);
    if (room !== null && room !== deck.room) {
      ctx.log(`· 進了牌組編輯 —— 手上是${ROOM_LABELS[room]}的三副，選單跟過去`);
      deck = { ...deck, room };
      dirty = true;
    }
    // 剛進來：以眼前這三副當基準，之後的變動才是玩家的編輯。
    officialSeen = now.set;
    return dirty;
  }
  if (now.where === "room") return dirty;
  const saved = officialAutoSave(deck, now.set, officialSeen);
  officialSeen = now.set;
  if (saved.saved > 0) {
    deck = saved.session;
    saveDeckLibrary();
    dirty = true;
  }
  return dirty;
}

// ---------------------------------------------------------------------------
// main.ts 叫的那幾支（以前它直接改這裡的計時器與旗標）
// ---------------------------------------------------------------------------

/**
 * 新的引擎建好了：掛上牌組的事件與兩個計時器。
 *
 * ⚠ 牌組庫跟大廳那顆按鈕一樣，**點下去的是玩家**：`onDeckEdit` 收到的每一則都是他親手點的，
 * 而寫進 Deck1 只發生在他點了某一副牌組的時候。
 * ⚠ 套用那一拍要比 `DECK_TICK_MS`（4 秒）密 —— 等候秒數預設 3 秒，用 4 秒的拍子去量
 * 「停了 3 秒沒」，玩家實際等到的會是 4 到 8 秒。
 */
export function startDeckRuntime(engine: ArbiterEngine): void {
  engine.onDeckEdit((report) => void onDeckReport(report));
  deckTimer = setInterval(() => void deckTick(), DECK_TICK_MS);
  // 最愛卡片鈕（存進牌組庫，跟牌組一起上雲）。
  engine.onCharaPicker((report) => onCharaPicker(report));
  // Library 愛心複選與首頁立繪的擺法（同樣存進牌組庫）。
  engine.onLobbyStand((report) => onLobbyStand(report));
  // 進了哪一房、開戰前先套牌組（WP-19）。
  engine.onRoomGate((report) => void onRoomGate(report));
  deckApplyTimer = setInterval(() => void deckApplyTick(), DECK_APPLY_TICK_MS);
}

/** 關程式：停掉兩個計時器。 */
export function stopDeckRuntime(): void {
  if (deckTimer !== null) clearInterval(deckTimer);
  deckTimer = null;
  if (deckApplyTimer !== null) clearInterval(deckApplyTimer);
  deckApplyTimer = null;
}

/** 雲端同步關掉：排著的那一輪收掉。 */
export function stopDeckCloudSync(): void {
  if (deckSyncTimer !== null) clearTimeout(deckSyncTimer);
  deckSyncTimer = null;
}

/** 新的引擎 = 人物篩選與首頁立繪都還沒推過：歸零重推。 */
export function repushDeckOverlays(): void {
  charaPickerPushed = null;
  pushCharaPicker();
  lobbyStandPushed = null;
  pushLobbyStand();
}

/**
 * 頁面重載了。⚠⚠ 同一個分頁換帳號**不會斷線**，只會重載 —— 見 resetDeckSession。
 * 同一個帳號重載也一樣放掉：頁面上的記憶體本來就沒了，重認一次只多讀一趟。
 */
export function onDeckPageReload(): void {
  if (!deckPending || deck !== null) resetDeckSession();
}

/** 給快照用：雲端同步最後一次的結果。 */
export function currentDeckSyncStatus(): DeckSyncStatus | null {
  return deckSyncStatus;
}
