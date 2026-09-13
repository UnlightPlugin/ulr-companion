/**
 * 牌組庫在托盤這一端的決策（WP-18）
 * ==================================
 * **這支不碰檔案、不碰 CDP、不碰時間以外的任何外界。** 它只回答兩個問題：
 *
 * ```
 *   現在畫面上該長什麼樣          → deckEditStateOf()
 *   玩家點了那個東西，庫要怎麼變   → applyReport()
 * ```
 *
 * 落地在 `deck-store.ts`，接線在 `main.ts` —— 跟 `profiles-core.ts` /
 * `profiles.ts` 分家同一個理由：**「同步把牌組吃掉了」這種 bug 一定要測得到**，
 * 而混進 fs 與 CDP 的東西測不動。
 *
 * ## ⚠⚠ 「事實」與「意圖」是兩份資料，永遠不要合併
 *
 * 這是這支最容易改壞的地方（2026-09-09 加入延後寫入之後尤其）：
 *
 * ```
 *   active    Deck1 現在**真的**是哪一副   事實。用內容 hash 算出來的
 *   selected  玩家**想**在這一房用哪一副   意圖。存在牌組庫裡
 *   pending   排著隊、還沒寫進伺服器的     意圖正在變成事實的路上
 * ```
 *
 * **三者本來就會有一段時間不相等**，那正是延後寫入的設計：玩家點了 B，
 * 伺服器上還是 A，三秒後（或按下開戰時）才追上。
 *
 * ### 為什麼 `active` 一定要是算出來的
 *
 * 伺服器上只有一副真的躺著（Deck1 是工作槽），所以「現在套用中的是哪一副」
 * 這件事**本來就寫在 Deck1 的內容裡** —— 拿內容 hash 去庫裡找就知道
 * （{@link resolveActive}）。而 {@link autoSave} 靠它決定「玩家剛才的編輯要存
 * 回哪一副」：讓 `active` 跟著點選跳的話，會把 Deck1 的內容存進玩家**還沒換過
 * 去**的那一副 —— 2026-08-27 就是這樣當場毀掉兩副牌。
 *
 * ### 為什麼 `selected` 一定要存下來
 *
 * 「進到任務房就套用任務那一套」需要一個指定對象，而 `active` 給不出來：玩家
 * 一離開任務房去打渦，Deck1 就不再對應任務房的任何一副，那時候「進任務房要套
 * 哪一副」**沒有答案**。所以意圖必須另外存（`DeckLibrary.selected`）。
 *
 * ⚠ 畫面上的黃字跟的是**意圖**（{@link highlightOf}），不是 `active` ——
 * 停在舊的那一副的話，玩家看到的是「我點了沒反應」，然後他會再點一次。
 *
 * ⚠ 玩家一在遊戲裡改牌，`active` 的 hash 就對不上、黃字會掉。所以 `main.ts`
 * 會**先自動存檔再重畫**（{@link autoSave}）—— 那一步把庫裡那一副的內容追上
 * Deck1，hash 就又對上了。少了自動存檔，症狀是「我改了牌，選單裡的黃字不見了，
 * 而且改的東西下次換牌組就沒了」。
 */

import type { DeckEditItem, DeckEditReport, DeckEditState } from "@ulr/cdp-adapter";
import type {
  DeckContent,
  DeckLibrary,
  DeckPayloadShape,
  RaidBoss,
  RoomKind,
} from "@ulr/deck-library";
import {
  addDeck,
  deckContentHash,
  deckContentToPayload,
  displayName,
  findDeck,
  isRaidBoss,
  listDecks,
  moveDeck,
  pickDeckForBoss,
  RAID_BOSS_LABELS,
  RAID_BOSSES,
  removeDeck,
  renameDeck,
  resolveSelected,
  ROOM_COST_DISPLAY,
  ROOM_KINDS,
  ROOM_LABELS,
  setDeckBosses,
  setSelected,
  updateDeckContent,
} from "@ulr/deck-library";

/**
 * 一行訊息在畫面上留多久。
 *
 * 底下那一行是玩家唯一會看到的回饋，太短會來不及讀；但留著不走的話，
 * 十分鐘前那句「庫存不足」會被當成現在的狀態。
 */
export const NOTICE_TTL_MS = 20_000;

/** 預設看哪一房。**迪特赫姆** —— 這個插件的主戰場就是那裡的約戰與配對。 */
export const DEFAULT_ROOM: RoomKind = "dietherm";

/**
 * 切了牌組之後等多久才寫進伺服器（毫秒）。玩家可在托盤改。
 *
 * 3 秒是 2026-09-09 定的預設值。理由見 {@link PendingApply}。
 */
export const DEFAULT_APPLY_DELAY_MS = 3_000;

/** 等候套用的秒數，玩家能設到的範圍。 */
export const MIN_APPLY_DELAY_MS = 0;
export const MAX_APPLY_DELAY_MS = 30_000;

/**
 * **排著隊、還沒寫進伺服器的那一副。**（WP-19）
 *
 * ## 為什麼要排隊
 *
 * 寫進伺服器是 `db_editdeck` 一來一回再讀回來對過，實測要一秒以上。而玩家在
 * 選單裡連按 ◀▶ 找牌組時，**每一下都寫一次**的話，他等的是「按幾下 × 一秒」，
 * 而且中間每一副都真的躺到伺服器上過 —— 那些他只是路過的牌組。
 *
 * 所以規則改成（2026-09-09 定）：
 *
 * ```
 *   點一副          → 只動前端（人在 Edit 畫面就即時換，一次網路都不跑）
 *                     並排進這裡
 *   停在這副滿 N 秒 → 才寫伺服器
 *   按下開戰        → 立刻寫，寫完才放行（`patch-room-gate.ts`）
 * ```
 *
 * ⚠ **`since` 每換一副就重算。** 玩家連按五下，只有最後停住的那一副會被寫出去
 * —— 中間四副連排隊都不算數。少了這個重算，第一副排上之後三秒就會被寫出去，
 * 而那正好是玩家最不想要的那一副。
 *
 * ⚠ **人在 Edit 畫面時，隊伍在換到眼前的那一刻就清掉**（2026-09-12）。那裡
 * 沒有「N 秒後寫伺服器」這一步 —— 遊戲會在玩家離開畫面時自己送，而三秒後再
 * 寫一次記憶體只會把他這三秒排的牌蓋回去。見 `main.ts` 的 `frontApplyPending`。
 */
export interface PendingApply {
  /** 庫裡那一副的 id。 */
  id: string;
  /** 要寫進 Deck1 的內容。 */
  content: DeckContent;
  /** 哪一房要的 —— 玩家排了隊之後又切去別房看時要認得出來。 */
  room: RoomKind;
  /** 排上（或換人）的時間，`Date.now()`。 */
  since: number;
  /**
   * 前端已經套好了沒（人在 Edit 畫面時的即時換牌）。
   *
   * 只影響訊息措辭：`true` 時玩家眼睛已經看到新的牌了，`false` 時他還沒。
   */
  fronted: boolean;
}

/** 托盤這邊關於牌組庫的全部狀態。**除了 `library` 以外都不落地。** */
export interface DeckSession {
  library: DeckLibrary;
  /** 選單現在看的是哪一房。 */
  room: RoomKind;
  /**
   * 每一房各自「套用中的是哪一副」。**算出來的**，見檔頭。
   *
   * 只有現在這一房的那個值會被畫出來；其他房的留著是為了換房時不必重算。
   */
  active: Record<RoomKind, string | null>;
  /**
   * 最後一則要告訴玩家的訊息。
   *
   * ⚠ 2026-09-09 起這**不會畫在遊戲畫面上**（那行紅字已經移除，理由在
   * `DeckEditState`）。它現在的用途是讓 `applyReport()` 這種純函式有地方把
   * 訊息交出來，由呼叫端寫進托盤的記錄。
   */
  notice: string | null;
  /** 訊息是什麼時候放上去的（`Date.now()`）。 */
  noticeAt: number;
  /** 排著隊、還沒寫進伺服器的那一副。見 {@link PendingApply}。 */
  pending: PendingApply | null;
  /**
   * 玩家人**實際上**在哪一房（`patch-room-gate.ts` 回報的）。
   *
   * ⚠ 跟 {@link DeckSession.room} 不是同一件事：那個是「選單現在看哪一房」。
   * 兩者平常一致（選單會自動跟隨），但玩家可以在渦房裡打開選單去看迪城的牌組
   * —— 那時候看的是迪城，人還在渦房，而**自動套用要認人在哪裡，不是認選單**。
   */
  here: RoomKind | null;
}

/** 開一份新的（載入存檔之後就呼叫這支）。 */
export function newSession(library: DeckLibrary, room: RoomKind = DEFAULT_ROOM): DeckSession {
  return {
    library,
    room,
    active: { raid: null, alexandria: null, quest: null, dietherm: null },
    notice: null,
    noticeAt: 0,
    pending: null,
    here: null,
  };
}

/**
 * Deck1 現在的內容對應到這一房的哪一副。找不到回 `null`。
 *
 * ⚠ 內容一模一樣的兩副會撞在一起，這裡取**排在前面**的那一副。這不是缺陷：
 * 兩副內容完全相同時，選哪一個寫進 Deck1 的結果都一樣。
 */
export function resolveActive(
  library: DeckLibrary,
  room: RoomKind,
  current: DeckContent,
): string | null {
  const want = deckContentHash(current);
  return listDecks(library, room).find((d) => deckContentHash(d.content) === want)?.id ?? null;
}

/** 四房一起算。載入存檔、重新接上遊戲時用。 */
export function resolveAll(
  library: DeckLibrary,
  current: DeckContent,
): Record<RoomKind, string | null> {
  return {
    raid: resolveActive(library, "raid", current),
    alexandria: resolveActive(library, "alexandria", current),
    quest: resolveActive(library, "quest", current),
    dietherm: resolveActive(library, "dietherm", current),
  };
}

/**
 * 把 Deck1 的現況存回「套用中的那一副」。
 *
 * **玩家在遊戲裡改牌，改的是 Deck1；庫裡那一副要跟上。** 這支在每一次要重畫
 * 畫面之前跑，所以玩家眼裡是「改完就存好了」，不必按任何東西。
 *
 * ## ⚠⚠ 只存「我親眼看著它變的」—— `lastSeen` 不是可有可無的參數
 *
 * `lastSeen` 是**上一次我們讀到的 Deck1**。只有 `current !== lastSeen` 才存 ——
 * 也就是「這副牌在我們兩次觀察之間被改過」。
 *
 * 少了這道閘門，只要 Deck1 跟套用中那一副對不起來就會存，而**寫入失敗正好會
 * 產生那個狀態**：玩家選了 B、寫入沒生效、Deck1 還是 A，下一拍就把 A 存進 B
 * —— B 原本的內容當場消失。2026-08-27 實機上就這樣弄丟了兩副牌（庫裡六副全
 * 變成同一副），而且因為寫入回報「成功」，記錄檔裡一行錯誤都沒有。
 *
 * 所以規則是：**「對不起來」不代表玩家改過牌，只代表我們的世界觀壞了**，
 * 那時候該做的是什麼都不做，不是拿手上的東西去覆蓋。
 *
 * ⚠ `lastSeen` 是 `null` 時一律不存 —— 那表示我們還沒觀察過，沒有比較基準。
 *
 * ⚠ 只有 hash 真的不同才動 `updatedAt`。不比就存的話，每一次輪詢都會讓
 * 這副牌變成「剛改過」，而同步那邊會據此判定「本地比較新」→ 每台電腦都在
 * 互相推自己那份，永遠停不下來。
 */
export function autoSave(
  session: DeckSession,
  current: DeckContent,
  lastSeen: DeckContent | null,
  now: Date = new Date(),
): { session: DeckSession; saved: boolean } {
  const id = session.active[session.room];
  if (id === null) return { session, saved: false };
  if (lastSeen === null) return { session, saved: false };
  // 玩家在兩次觀察之間動了牌嗎？沒有的話這裡沒有他的編輯可以存。
  if (deckContentHash(lastSeen) === deckContentHash(current)) return { session, saved: false };
  const entry = findDeck(session.library, session.room, id);
  if (entry === null) return { session, saved: false };
  if (deckContentHash(entry.content) === deckContentHash(current)) return { session, saved: false };
  return {
    session: {
      ...session,
      library: updateDeckContent(session.library, session.room, id, current, now),
    },
    saved: true,
  };
}

/**
 * 把伺服器的 Deck2／Deck3 收進自訂牌組的**第 2、3 格**，**四房都放一份**。
 *
 * 規格（2026-08-28 決定）：伺服器那三格之後只有 Deck1 是工作槽，Deck2/Deck3
 * 由插件清空 —— 但清空之前那兩副的內容得先搬進來，否則玩家的牌就沒了。
 * 「第 2、3 格」是位置，不是新增：庫裡本來就有東西的話**覆蓋**它。
 *
 * ## ⚠ 為什麼是四房都放，不是只放現在這一房
 *
 * 原本只收進 `session.room`（預設迪特赫姆），結果是**其他三房一副牌都沒有**。
 * 那會讓「進到任務房就自動套用任務那一套」整個功能在第一次使用時完全沒有東西
 * 可以套 —— 玩家看到的是「這功能對我沒作用」，而他不會知道原因是庫是空的
 * （2026-09-09 回報：「原本只有迪特房有牌組」）。
 *
 * 四房各拿一份複本之後，玩家在哪一房都馬上有得選，再自己去改成那一房要用的。
 * ⚠ 是**複本**不是共用：每一副有自己的 id，在任務房改牌不會動到迪城那一副。
 *
 * ⚠ 位置不夠就往後補。庫是空的時候（第一次用）補出來的順序正好是
 * Deck1／Deck2／Deck3，跟玩家原本在遊戲裡看到的一樣。
 *
 * ⚠ Deck2 空、Deck3 有東西時，Deck3 會**往前補到第 2 格**，不會為了對齊位置
 * 塞一副空牌進去 —— 空牌在房間裡選不動（`guardDeck1` 擋著）、在 Edit 裡選了
 * 等於按 reset，清單裡多一副只會把牌清掉的東西比位置對不上更糟。
 */
export function migrateServerDecks(
  session: DeckSession,
  deck2: DeckContent | null,
  deck3: DeckContent | null,
  now: Date = new Date(),
): DeckSession {
  let library = session.library;
  const pairs: [number, DeckContent | null][] = [
    [1, deck2],
    [2, deck3],
  ];
  for (const room of ROOM_KINDS) {
    for (const [index, content] of pairs) {
      if (content === null) continue;
      const list = listDecks(library, room);
      const existing = list[index];
      if (existing === undefined) {
        library = addDeck(library, room, { content, now }).library;
      } else if (deckContentHash(existing.content) !== deckContentHash(content)) {
        library = updateDeckContent(library, room, existing.id, content, now);
      }
    }
  }
  return { ...session, library };
}

/**
 * 第一次用這個帳號時，把伺服器的 Deck1 收進**四房**。
 *
 * ⚠ 跟 {@link migrateServerDecks} 同一個理由：只放一房的話，其他三房是空的，
 * 而空的那三房「進房自動套用」完全不會有動作。
 *
 * ⚠ 空牌組不收 —— 空的那一副在房間裡選不動（`guardDeck1` 擋著）、在 Edit 裡
 * 選了等於按 reset，放進去只是讓每一房都多一個沒有牌的東西。
 */
export function seedAllRooms(
  library: DeckLibrary,
  content: DeckContent,
  now: Date = new Date(),
): DeckLibrary {
  let next = library;
  for (const room of ROOM_KINDS) {
    next = addDeck(next, room, { content, now }).library;
  }
  return next;
}

/** 過期的訊息清掉。回傳有沒有變動 —— 沒變就不必重畫。 */
export function expireNotice(
  session: DeckSession,
  now: number = Date.now(),
): { session: DeckSession; changed: boolean } {
  if (session.notice === null || now - session.noticeAt < NOTICE_TTL_MS) {
    return { session, changed: false };
  }
  return { session: { ...session, notice: null, noticeAt: 0 }, changed: true };
}

/** 換一行訊息。 */
export function withNotice(
  session: DeckSession,
  notice: string | null,
  now: number = Date.now(),
): DeckSession {
  return { ...session, notice, noticeAt: notice === null ? 0 : now };
}

// ---------------------------------------------------------------------------
// 排隊與進房自動套用（WP-19）
// ---------------------------------------------------------------------------

/**
 * 把一副排進隊伍（或換掉已經排著的那一副）。
 *
 * ⚠ **內容跟 Deck1 現況一樣就不排。** 那種情況沒有東西要寫，排上去只會讓
 * 三秒後跑一趟白工，而且開戰時還要多攔一下。
 */
export function queueApply(
  session: DeckSession,
  room: RoomKind,
  id: string,
  content: DeckContent,
  current: DeckContent,
  now: number = Date.now(),
  options: { force?: boolean; fronted?: boolean } = {},
): DeckSession {
  // ⚠⚠ `force` 是給「頁面已經自己把牌換進客戶端記憶體了」那條路用的
  // （進房前的預載，見 `RoomDeckPreload`）。那時候 `current` 就是我們要的那一副
  // ——「一樣所以不必排」在這裡是**錯的結論**：客戶端記憶體一樣了，但**伺服器
  // 還是上一副**，而開戰時 `deck_now=1` 指的是伺服器那一格。
  //
  // 少了這個旗標，症狀是「畫面完全正常，但打起來用的是上一房的牌」。
  if (options.force !== true && deckContentHash(content) === deckContentHash(current)) {
    return { ...session, pending: null };
  }
  return {
    ...session,
    pending: { id, content, room, since: now, fronted: options.fronted === true },
  };
}

/**
 * 排著的那一副等夠久了沒。
 *
 * `delayMs` 是 0 時等於「馬上寫」—— 玩家把等候秒數設成 0 就是要這個行為。
 */
export function isApplyDue(
  session: DeckSession,
  delayMs: number = DEFAULT_APPLY_DELAY_MS,
  now: number = Date.now(),
): boolean {
  if (session.pending === null) return false;
  return now - session.pending.since >= delayMs;
}

/** 寫成功之後把隊伍清掉，並把 active 記成那一副。 */
export function applyLanded(session: DeckSession, pending: PendingApply): DeckSession {
  return {
    ...session,
    pending: session.pending === null || session.pending.id !== pending.id ? session.pending : null,
    active: { ...session.active, [pending.room]: pending.id },
  };
}

/**
 * **玩家進到某一房了。**（規格：Quest 房套任務牌組集合、Raid 房套渦牌組集合…）
 *
 * ```
 *   選單跟著切過去  →  把那一房「上次選的那副」排進隊伍
 * ```
 *
 * ⚠ 排隊而不是直接寫，是刻意的：玩家常常只是**路過**（進迪城看一眼房間列表就
 * 走）。直接寫的話，那一眼就換掉了他手上的牌，而他根本沒有要打。等候秒數過了
 * 才寫，等於「真的待下來才算數」。
 *
 * ⚠ 同一房重複回報不重排 —— 頁面每 500ms 回報一次，重排的話 `since` 會一直
 * 被推後，永遠等不到那三秒。
 */
export function enterRoom(
  session: DeckSession,
  room: RoomKind | null,
  current: DeckContent,
  now: number = Date.now(),
  options: { preloaded?: boolean } = {},
): DeckSession {
  if (room === null) return { ...session, here: null };
  if (session.here === room) return session;

  const entry = resolveSelected(session.library, room);
  const moved: DeckSession = {
    ...session,
    here: room,
    // 選單自動跟隨（2026-09-09 決定）。⚠ active 要**重算**，理由跟
    // `room-switch` 同一個：手上這副對不對得上那一房，是內容說了算。
    room,
    active: { ...session.active, [room]: resolveActive(session.library, room, current) },
  };
  if (entry === null) return { ...moved, pending: null };
  // ⚠⚠ `preloaded` = 頁面在 create() 之前就把這一副塞進客戶端記憶體了。
  // 那時候 `current` 已經等於 `entry.content`，而「一樣就不必排」在這裡會得出
  // **錯的結論** —— 伺服器上還是上一副，不排隊就永遠不會被寫。見 `queueApply`。
  //
  // `fronted` 一併帶 true：玩家眼睛已經看到新的牌了，托盤不必再寫一次前端。
  return queueApply(moved, room, entry.id, entry.content, current, now, {
    force: options.preloaded === true,
    fronted: options.preloaded === true,
  });
}

/**
 * **進了牌組編輯畫面：選單要跟著「手上這副牌是哪一房的」。**
 *
 * 2026-09-12 回報：人剛從亞城出來進 Edit，手上是亞城那副，選單卻停在迪特赫姆
 * 、黃字指著迪城的 Deck2 —— 而那副的內容跟畫面上的牌對不上（92 vs 79）。
 * 玩家看到的是「插件記的牌跟我手上的不一樣」。
 *
 * 選單的 `room` 平常靠 {@link enterRoom} 跟著人走，但托盤重開過、或玩家從沒
 * 進過任何一房（選頻道前 `room-changed` 是 null）時，它就停在預設值。這時
 * **內容是唯一可靠的線索**：Deck1 現在裝的是哪一房的哪一副，選單就該看那一房、
 * 黃字就該指著那一副。
 *
 * 挑的順序（前面的比後面的更像「他剛剛在用的」）：
 *
 * ```
 *   1. 選單這一房「記住的那副」就是它      → 不動
 *   2. 別房「記住的那副」就是它            → 換到那一房
 *   3. 選單這一房任何一副是它              → 不動房，黃字對到它
 *   4. 別房任何一副是它                    → 換到那一房
 *   對不上任何一副                         → 什麼都不動
 * ```
 *
 * 「記住的那副」（`selected`）排在「任何一副」前面，是因為四房一開始都是同一
 * 副的複本（`seedAllRooms`）—— 光看內容分不出他是從哪一房出來的，而他在那一
 * 房點過的那一副才是線索。
 *
 * ⚠ 對上的那副同時寫進 `selected`：畫面上正在用的就是他要的。少了這一步，
 * 換到亞城之後黃字可能還指著亞城「記住」的另一副，同一個抱怨再來一次。
 *
 * ⚠ 有東西排著隊時不動 —— 那時候黃字跟的是隊伍（{@link highlightOf}），而且
 * 隊伍落地時會自己把 active 對好。
 */
export function followDeckOnEdit(session: DeckSession, current: DeckContent): DeckSession {
  if (session.pending !== null) return session;
  const hash = deckContentHash(current);
  const selectedMatch = (room: RoomKind): string | null => {
    const entry = resolveSelected(session.library, room);
    return entry !== null && deckContentHash(entry.content) === hash ? entry.id : null;
  };
  const anyMatch = (room: RoomKind): string | null => resolveActive(session.library, room, current);

  // 選單這一房排最前面，四個層級各掃一輪。
  const order: RoomKind[] = [session.room, ...ROOM_KINDS.filter((r) => r !== session.room)];
  const candidates: [RoomKind, string | null][] = [
    ...order.map((r): [RoomKind, string | null] => [r, selectedMatch(r)]),
    ...order.map((r): [RoomKind, string | null] => [r, anyMatch(r)]),
  ];
  const found = candidates.find(([, hit]) => hit !== null);
  if (found === undefined) return session;
  const room = found[0];
  const id = found[1];
  if (id === null) return session;

  const same =
    room === session.room &&
    session.active[room] === id &&
    (session.library.selected?.[room] ?? null) === id;
  if (same) return session;
  return {
    ...session,
    room,
    library: setSelected(session.library, room, id),
    active: { ...session.active, [room]: id },
  };
}

/**
 * **每一房「進去就該用的那一副」，事先給頁面。**
 *
 * 這是「進房不閃上一房的牌」那條路的資料來源 —— 頁面在房間場景的 `create()`
 * 跑之前就把 `deck1` 換掉，而那個時間點沒有機會來問托盤，所以要先給。
 * 完整理由在 `@ulr/cdp-adapter` 的 `RoomDeckPreload`。
 *
 * ⚠ 挑的規則跟 {@link enterRoom} **必須一樣**（都是 `resolveSelected`）。
 * 兩邊挑不一樣的話，頁面塞一副、托盤隨後寫另一副，玩家會看到牌閃兩次。
 *
 * ⚠ cost 帶 0：伺服器自己會算，而這裡沒有可靠的原值可以帶。
 */
export function roomDeckPreloadOf(
  session: DeckSession,
): Partial<Record<RoomKind, { deck: DeckPayloadShape; name: string }>> {
  const out: Partial<Record<RoomKind, { deck: DeckPayloadShape; name: string }>> = {};
  for (const room of ROOM_KINDS) {
    const entry = resolveSelected(session.library, room);
    if (entry === null) continue;
    const index = listDecks(session.library, room).findIndex((d) => d.id === entry.id);
    out[room] = {
      deck: deckContentToPayload(entry.content, 0),
      name: displayName(entry, index < 0 ? 0 : index),
    };
  }
  return out;
}

/**
 * 選單上要用黃字指著哪一副。
 *
 * ⚠ 指的是**意圖**（排隊中的 → 記住的 → 才輪到事實），不是 `active`。玩家點
 * 一副之後要三秒才會真的寫出去，這三秒裡黃字必須已經在他點的那一副上 ——
 * 停在舊的那一副的話，玩家看到的是「我點了沒反應」，然後他會再點一次。
 */
export function highlightOf(session: DeckSession, room: RoomKind): string | null {
  if (session.pending !== null && session.pending.room === room) return session.pending.id;
  const want = session.library.selected?.[room] ?? null;
  if (want !== null && findDeck(session.library, room, want) !== null) return want;
  return session.active[room];
}

/** 現在畫面上該長什麼樣。**選單上的每一個字都由這支決定。** */
export function deckEditStateOf(session: DeckSession): DeckEditState {
  const room = session.room;
  const decks: DeckEditItem[] = listDecks(session.library, room).map((d, i) => ({
    id: d.id,
    name: displayName(d, i),
    // ⚠ 標籤只有渦房有意義（`DeckEntry.bosses` 在其他房恆為空，這裡再擋一次
    // 是為了讓手改過的存檔也畫得乾淨）。送的是**鍵**，頁面自己查 bossOptions。
    bosses: room === "raid" ? [...d.bosses] : [],
    // 內容下放到頁面，但**只為了畫**：選單裡每一副要有三張卡面縮圖與兩種總
    // COST，而那些只能從內容算。⚠ 頁面永遠不會把它送回來 —— 回報裡沒有任何
    // 帶內容的種類（見 `DeckEditReport`）。
    content: {
      chara: [...d.content.chara],
      charaIndex: [...d.content.charaIndex],
      weapon: [...d.content.weapon],
      eventIndex: [...d.content.eventIndex],
    },
  }));
  return {
    room,
    rooms: ROOM_KINDS.map((k) => ({ key: k, label: ROOM_LABELS[k] })),
    decks,
    activeId: highlightOf(session, room),
    bossOptions: RAID_BOSSES.map((b) => ({ key: b, label: RAID_BOSS_LABELS[b] })),
    // 這一房該畫哪一種總 COST（PVE 不畫、亞城官方、迪城自訂）—— 房型的意思
    // 只有這邊知道，頁面照著畫就好。
    costDisplay: ROOM_COST_DISPLAY[room],
    // ⚠ 訊息**不送給頁面**（2026-09-09 起）。遊戲畫面上不再有那行紅字，
    // 訊息走托盤的記錄 —— 見 `DeckEditState` 那邊的說明。
  };
}

/**
 * 遊戲的渦 BOSS（`profound_mons` 底線前那段）→ 玩家貼的標籤。
 *
 * 名字是 2026-09-13 從跑著的客戶端 `monsProfile` 讀的（`_01/_02/_03` 是同一
 * 隻的渦I／II·III／IV，所以只認前綴）。放在這裡而不是牌組庫，理由見
 * `RaidBoss` 的說明：存檔只存我們的鍵，映射錯了改這一行就好。
 *
 * ```
 *   mc1003  赤死獸／黑死獸／瘟疫         狗
 *   mc1006  啃食者／屠殺者／爬行者       蟲
 *   mc1007  深沉之者／誘引之者／深奧之者 海
 *   mc1008  贔屭／靈龜／玄帝             龜
 *   mc1012  龍魚／龍鯰／龍鯉             魚
 * ```
 *
 * 妖精（mc1004）、吸血女王（mc1005）、活動 BOSS 沒有標籤 → 選了不換牌。
 */
export const RAID_MONS_BOSS: Readonly<Record<string, RaidBoss>> = {
  mc1003: "dog",
  mc1006: "bug",
  mc1007: "sea",
  mc1008: "turtle",
  mc1012: "fish",
};

/** `mc1008_02` → `turtle`。認不得回 `null`。 */
export function raidBossOfMons(mons: string): RaidBoss | null {
  const prefix = mons.split("_")[0] ?? "";
  return Object.prototype.hasOwnProperty.call(RAID_MONS_BOSS, prefix)
    ? (RAID_MONS_BOSS[prefix] ?? null)
    : null;
}

/**
 * 「在這一房用這副」：記住意圖、內容不同就排隊。點選單與渦房自動換牌共用。
 */
function selectDeck(
  session: DeckSession,
  room: RoomKind,
  entry: { id: string; content: DeckContent },
  current: DeckContent,
  at: number,
): { session: DeckSession; write: DeckContent | null } {
  // 「我要在這一房用這副」先記下來 —— 跟寫不寫得進去無關，見
  // `DeckLibrary.selected`。下次進這一房就是套它。
  session = { ...session, library: setSelected(session.library, room, entry.id) };
  // 內容一樣就不必送出去 —— 沒有任何東西會變。
  //
  // ⚠ **不要在這裡放訊息。** 底下那一行是紅字，玩家會把它讀成錯誤，而這
  // 根本不是錯誤（2026-09-09 回報：「請不要出現這種紅字的錯誤提示詞」）。
  //
  // 2026-08-27 當初加那句話是因為「選了完全沒反應」看起來像功能壞了 ——
  // 但那個理由已經不成立：選單的黃字現在跟的是**意圖**（`highlightOf`），
  // 玩家一點下去它就跳過去了，回饋在那裡，不需要再說一次。
  if (deckContentHash(entry.content) === deckContentHash(current)) {
    return {
      session: {
        ...withNotice(session, null, at),
        pending: null,
        active: { ...session.active, [room]: entry.id },
      },
      write: null,
    };
  }
  // ⚠⚠ **這裡不再直接寫伺服器**（2026-09-09 改）。只排隊 —— 真正寫出去
  // 是「停滿等候秒數」或「按下開戰」，見 {@link PendingApply}。
  //
  // ⚠ active **不動**。它的意思是「Deck1 現在真的是哪一副」，而現在還不是。
  // 動了它的話，自動存檔會把 Deck1 的內容存進玩家還沒換過去的那一副
  // —— 那正是 2026-08-27 弄丟兩副牌的那條路。黃字改用 `highlightOf()`。
  //
  // `write` 仍然回傳內容，但呼叫端只拿它做**前端即時換牌**（人在 Edit
  // 畫面時寫客戶端記憶體，一次網路都不跑）。
  return {
    session: queueApply(withNotice(session, null, at), room, entry.id, entry.content, current, at),
    write: entry.content,
  };
}

/**
 * 玩家點了東西之後庫要變成什麼樣。
 *
 * `write` 不是 `null` 就表示**要把那份內容寫進 Deck1**（呼叫端負責 `guardDeck1`、
 * 庫存檢查與真正的 `applyDecks()`）。這支自己**不決定寫不寫得成功** ——
 * 失敗的善後（訊息、把 active 收回去）也在呼叫端。
 *
 * @param current 現在 Deck1 的內容。新增牌組時拿它當種子。
 */
export function applyReport(
  session: DeckSession,
  report: DeckEditReport,
  current: DeckContent,
  now: Date = new Date(),
): { session: DeckSession; write: DeckContent | null } {
  const room = session.room;
  const at = now.getTime();
  const none = (s: DeckSession): { session: DeckSession; write: null } => ({
    session: s,
    write: null,
  });

  switch (report.type) {
    case "raid-pick": {
      // 渦房選中一個渦 → 換成掛了那隻 BOSS 標籤的牌組（玩家 2026-09-13 要的）。
      // 認不得的 BOSS、或沒有任何一副掛那個標籤 → **不換**（玩家同日補充）。
      const boss = raidBossOfMons(report.mons);
      if (boss === null) return none(session);
      const entry = pickDeckForBoss(session.library, boss);
      if (entry === null) return none(session);
      // ⚠ 牌組一律從**渦房**那一組挑，不管選單此刻看哪一房 —— 人就站在渦房。
      // 選單順手切回渦房，理由跟 `room-switch` 一樣：active 要照內容重算。
      const raid: DeckSession =
        room === "raid"
          ? session
          : {
              ...session,
              room: "raid",
              active: { ...session.active, raid: resolveActive(session.library, "raid", current) },
            };
      // 已經是它了（排著隊的、記住的都算）→ 不動，免得每點一次渦就重排一次隊。
      if (highlightOf(raid, "raid") === entry.id) return none(raid);
      const picked = selectDeck(raid, "raid", entry, current, at);
      const index = listDecks(raid.library, "raid").findIndex((d) => d.id === entry.id);
      return {
        ...picked,
        session: withNotice(
          picked.session,
          `渦 BOSS 是「${RAID_BOSS_LABELS[boss]}」—— 換成「${displayName(entry, index < 0 ? 0 : index)}」`,
          at,
        ),
      };
    }

    case "deck-select": {
      const entry = findDeck(session.library, room, report.id);
      if (entry === null) {
        return none(withNotice(session, "那副牌組不見了 —— 重開選單看看。", at));
      }
      return selectDeck(session, room, entry, current, at);
    }

    case "deck-cycle": {
      // 原版左下角那兩個 ◀▶。**切的是自訂牌組**，伺服器永遠只用 Deck1。
      const list = listDecks(session.library, room);
      if (list.length === 0) {
        return none(withNotice(session, "這一房還沒有牌組，按 + 新增。", at));
      }
      // ⚠⚠ **從「黃字現在在哪一副」往下走，不是從 `active`。**
      //
      // `active` 是「Deck1 現在真的是哪一副」，而延後寫入之後它在按下 ▶ 的
      // 那三秒裡**不會動** —— 拿它當起點的話，玩家連按 ▶ 會一直從同一個位置
      // 往前一格，也就是**永遠停在第二副**，怎麼按都出不去。
      const at0 = list.findIndex((d) => d.id === highlightOf(session, room));
      // ⚠ 找不到「套用中」時（手上這副不在庫裡）從第一副開始，**不要當成 -1
      // 去做取餘數** —— 那樣按 ◀ 會跳到最後一副，按 ▶ 會跳到第一副，玩家看到
      // 的是兩個方向都亂跳。
      const from = at0 < 0 ? 0 : at0;
      const step = report.delta < 0 ? -1 : 1;
      const next = at0 < 0 ? list[from] : list[(from + step + list.length) % list.length];
      if (next === undefined) return none(session);
      // ◀▶ 跟點選同一條規矩：記住意圖、排隊、不直接寫伺服器。**連按時排隊的
      // 那一副會一直被換掉**，只有停住的那一副會被寫出去。
      const cycled = { ...session, library: setSelected(session.library, room, next.id) };
      if (deckContentHash(next.content) === deckContentHash(current)) {
        return none({
          ...withNotice(cycled, null, at),
          pending: null,
          active: { ...cycled.active, [room]: next.id },
        });
      }
      return {
        session: queueApply(withNotice(cycled, null, at), room, next.id, next.content, current, at),
        write: next.content,
      };
    }

    case "deck-add": {
      // 種子是**現在的 Deck1**，不是空牌組。空的那一副在房間裡選不動
      // （`guardDeck1` 會擋）、在 Edit 裡選了等於按 reset —— 玩家按了 + 卻看到
      // 牌被清空，那不是他要的。
      const { library, entry } = addDeck(session.library, room, { content: current, now });
      return none({
        ...withNotice(session, "新增了一副 —— 內容是你現在這副，改完就自動存好。", at),
        // 剛新增的那副就是玩家接下來要用的，順手記成這一房的選擇。
        library: setSelected(library, room, entry.id),
        // 內容跟 Deck1 一樣，所以它本來就是「套用中」的那一副，不必寫入。
        pending: null,
        active: { ...session.active, [room]: entry.id },
      });
    }

    case "deck-remove": {
      const entry = findDeck(session.library, room, report.id);
      if (entry === null) return none(session);
      const index = listDecks(session.library, room).findIndex((d) => d.id === report.id);
      const label = displayName(entry, index < 0 ? 0 : index);
      // ⚠ **Deck1 不動。** 刪掉的是庫裡的記錄，玩家手上那副牌還在遊戲裡 ——
      // 順手把伺服器上的牌組也清掉的話，誤按一下就沒了。
      return none({
        ...withNotice(session, `已刪除「${label}」—— 手上這副牌沒有動。`, at),
        // ⚠ 記住的選擇也要一起清掉，否則下次進這一房會去套一副已經不存在的牌
        // （`resolveSelected()` 會退回第一副，但那不是玩家的意思）。
        library: setSelected(
          removeDeck(session.library, room, report.id, now),
          room,
          session.library.selected?.[room] === report.id
            ? null
            : (session.library.selected?.[room] ?? null),
        ),
        // 排著隊的正好是被刪的那副 → 取消，不要寫一副玩家剛刪掉的牌。
        pending:
          session.pending !== null && session.pending.id === report.id ? null : session.pending,
        active: {
          ...session.active,
          [room]: session.active[room] === report.id ? null : session.active[room],
        },
      });
    }

    case "deck-rename": {
      const name = report.name.trim();
      return none({
        ...withNotice(session, null, at),
        library: renameDeck(session.library, room, report.id, name, now),
      });
    }

    case "deck-move":
      return none({
        ...withNotice(session, null, at),
        library: moveDeck(session.library, room, report.id, report.toIndex),
      });

    case "deck-bosses": {
      // 頁面送什麼都當成不可信的輸入 —— 認不得的鍵直接丟掉。
      const bosses = report.bosses.filter((b): b is RaidBoss => isRaidBoss(b));
      return none({
        ...withNotice(session, null, at),
        library: setDeckBosses(session.library, room, report.id, bosses, now),
      });
    }

    case "deck-save-current": {
      // 頁面目前沒有這顆按鈕（存檔是自動的），留著是因為協定上有它。
      const entry = findDeck(session.library, room, report.id);
      if (entry === null) return none(session);
      return none({
        ...withNotice(session, "已存回這一副。", at),
        library: updateDeckContent(session.library, room, report.id, current, now),
        active: { ...session.active, [room]: report.id },
      });
    }

    case "room-switch": {
      const next = ROOM_KINDS.find((k) => k === report.room);
      if (next === undefined) return none(session);
      // 換房要**重算**那一房的 active：手上這副牌對不對得上那一房的某一副，
      // 是內容說了算（見檔頭）。
      const moved: DeckSession = {
        ...withNotice(session, null, at),
        room: next,
        active: { ...session.active, [next]: resolveActive(session.library, next, current) },
      };
      // ⚠⚠ **牌組要跟著換**（2026-09-12 玩家要求）。原本只換「選單看哪一房」，
      // 手上的牌不動 —— 於是切到任務房之後，選單列的是任務的牌，畫面上擺的
      // 卻還是渦房那副，而玩家會以為自己已經換過去了。
      //
      // 挑哪一副跟 `enterRoom` 同一條規矩（`resolveSelected`），兩邊挑不一樣
      // 的話進房時會再閃一次牌。那一房還沒有牌組時什麼都不換 —— 沒有東西可
      // 以換，清掉排隊就好。
      const entry = resolveSelected(session.library, next);
      if (entry === null) return none({ ...moved, pending: null });
      // ⚠ 只排隊、不直接寫伺服器（跟點選同一條路）。呼叫端會拿 `write` 去做
      // 前端即時換牌，三秒後（或開戰前）才真的寫出去 —— 玩家在幾房之間來回
      // 看一眼不該各上傳一次。
      return {
        session: queueApply(moved, next, entry.id, entry.content, current, at),
        write: entry.content,
      };
    }

    case "deck-ui-error":
      // 引擎已經寫過記錄了，這裡只把它顯示在玩家看得到的地方。
      return none(withNotice(session, `介面出錯：${report.message}`, at));
  }
}
