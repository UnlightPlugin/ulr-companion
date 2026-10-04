/**
 * 雲端同步：把遠端那份合進本地（WP-18 的落地）
 * ============================================
 * `sync.ts` 的 `planSync()` 只說**要做什麼**（拉哪幾副、推哪幾副、刪哪幾副），
 * 這裡把計畫**做出來**：吃本地庫與雲端文件，吐一份合併後的庫，外加「本地有沒
 * 有變」「雲端該不該更新」兩個旗標。純函式、不碰網路 —— 「同步把牌組吃掉了」
 * 這種 bug 一定要在測試裡抓得到。
 *
 * ## 雲端上放的是什麼
 *
 * {@link SyncDocument}：四房的牌組與墓碑，**沒有** `account`、`accountLabel`、
 * `selected`。
 *
 * - `account` 是本機的指紋，雲端用另一把鍵分租戶（見托盤的 `deck-sync.ts`）
 * - `accountLabel` 是玩家名字，**可辨識資訊，不上雲**（規格書 §12）
 * - `selected` 是「這台電腦在這一房上次選哪一副」，各台各自的偏好 —— 同步過去
 *   另一台會在玩家沒碰的情況下被換牌組（`DeckLibrary.selected` 的說明）
 *
 * ## 誰贏
 *
 * 一副一副比，規則全在 `planSync()`：hash 一樣就沒事、不一樣比 `updatedAt`、
 * 編輯對刪除也比時間。這裡只多做兩件事：
 *
 * 1. **hash 一樣的那幾副取較新的 `updatedAt`。** 兩邊內容相同、時間戳不同是
 *    常態（自動存檔那邊只在內容變了才動時間）。不取較新的話，這台電腦永遠覺得
 *    自己那份「比較舊」，順序的判定（下面）會一直站在對方那邊。
 * 2. **排列順序整房取「最近有動過」的那一邊。** 順序本身沒有時間戳，所以看那一
 *    房裡最新的一筆時間（牌組的 `updatedAt` 或墓碑的 `deletedAt`）誰新誰的順序
 *    算數；平手本地贏。`moveDeck()` 會把被搬的那副的 `updatedAt` 往前推，所以
 *    「在 A 電腦拖曳排序」會傳到 B —— 沒有那一下的話，兩台會各自堅持自己的順序
 *    輪流推。
 *
 * 合併後的墓碑：兩邊聯集、同 id 取較新的 `deletedAt`，**還活著的牌組不留墓碑**
 * （跟 `parseLibrary()` 同一條規矩，否則同步會反覆橫跳）。
 */

import { copyLobbyStand, newerLobbyStand, type LobbyStand } from "./lobby-stand.js";
import { parseLibrary, serializeLibrary } from "./serialize.js";
import { planSync, summarize, type SyncPlan } from "./sync.js";
import {
  type DeckEntry,
  type DeckLibrary,
  type FavoriteCards,
  type FavoriteEvents,
  type HiddenWeapons,
  type RoomKind,
  type Tombstone,
  ROOM_KINDS,
  emptyLibrary,
} from "./types.js";

/**
 * 雲端上那份。形狀是 `DeckLibrary` 去掉本機專屬的三欄。
 *
 * `favorites`（最愛卡片）是 2026-09-26 加的：雲端 Worker 把 `doc` 當不透明的物件
 * 存，所以不必改伺服器。舊版托盤讀不懂這一欄、推上來的文件會沒有它 —— 那只會
 * 讓新版下一輪再推一次（沒有這欄的那一邊不參與比較），不會把最愛清掉。
 * `hiddenWeapons`（隱藏的裝備）、`favoriteEvents`（最愛的事件卡）同一天加的，同一套規則。
 * `lobbyStand`（首頁立繪）2026-10-02 加的，也是同一套。
 */
export interface SyncDocument {
  version: 2;
  collections: Record<RoomKind, DeckEntry[]>;
  tombstones: Record<RoomKind, Tombstone[]>;
  favorites?: FavoriteCards;
  hiddenWeapons?: HiddenWeapons;
  favoriteEvents?: FavoriteEvents;
  lobbyStand?: LobbyStand;
}

/** 本地庫 → 要上雲的那份。 */
export function toSyncDocument(library: DeckLibrary): SyncDocument {
  const collections = {} as Record<RoomKind, DeckEntry[]>;
  const tombstones = {} as Record<RoomKind, Tombstone[]>;
  for (const room of ROOM_KINDS) {
    collections[room] = [...(library.collections[room] ?? [])];
    tombstones[room] = [...(library.tombstones[room] ?? [])];
  }
  const doc: SyncDocument = { version: 2, collections, tombstones };
  if (library.favorites !== undefined) doc.favorites = copyFavorites(library.favorites);
  if (library.hiddenWeapons !== undefined) {
    doc.hiddenWeapons = copyFavorites(library.hiddenWeapons);
  }
  if (library.favoriteEvents !== undefined) {
    doc.favoriteEvents = copyFavorites(library.favoriteEvents);
  }
  if (library.lobbyStand !== undefined) doc.lobbyStand = copyLobbyStand(library.lobbyStand);
  return doc;
}

function copyFavorites(f: FavoriteCards): FavoriteCards {
  return { cards: [...f.cards], updatedAt: f.updatedAt };
}

/** 兩邊的最愛卡片取較新的一份；只有一邊有就是那一邊，平手本地贏。 */
function newerFavorites(
  local: FavoriteCards | undefined,
  remote: FavoriteCards | undefined,
): FavoriteCards | undefined {
  if (remote === undefined) return local;
  if (local === undefined || remote.updatedAt > local.updatedAt) return copyFavorites(remote);
  return local;
}

/**
 * 雲端文件 → 一份「帳號指紋是 `account`」的庫。合併時當遠端那一邊用。
 * ⚠ 這裡**不做解析**，呼叫端先用 `parseLibrary()` 把網路上收到的東西過一次。
 */
export function libraryFromSyncDocument(doc: SyncDocument, account: string): DeckLibrary {
  const lib = emptyLibrary(account);
  for (const room of ROOM_KINDS) {
    lib.collections[room] = [...(doc.collections[room] ?? [])];
    lib.tombstones[room] = [...(doc.tombstones[room] ?? [])];
  }
  if (doc.favorites !== undefined) lib.favorites = copyFavorites(doc.favorites);
  if (doc.hiddenWeapons !== undefined) lib.hiddenWeapons = copyFavorites(doc.hiddenWeapons);
  if (doc.favoriteEvents !== undefined) lib.favoriteEvents = copyFavorites(doc.favoriteEvents);
  if (doc.lobbyStand !== undefined) lib.lobbyStand = copyLobbyStand(doc.lobbyStand);
  return lib;
}

/**
 * 同一份內容永遠是同一串字 —— 「雲端要不要更新」靠比這個，不比物件。
 * `serializeLibrary()` 的 key 順序是固定的；把本機三欄拿掉之後就是文件的正規形。
 */
export function syncDocumentText(doc: SyncDocument): string {
  const lib = libraryFromSyncDocument(doc, "00000000");
  return serializeLibrary(lib);
}

export interface MergeResult {
  /** 合併後的本地庫（`account`、`accountLabel`、`selected` 照本地的）。 */
  library: DeckLibrary;
  /** 合併後該上雲的那份。 */
  document: SyncDocument;
  /** 本地跟合併前不一樣 —— 呼叫端要存檔、重畫。 */
  localChanged: boolean;
  /** 雲端跟合併後不一樣 —— 呼叫端要推上去。 */
  remoteChanged: boolean;
  plan: SyncPlan;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(it.id, it);
  return m;
}

/** 這一房最近一次動作的時間（牌組改動或刪除）。空房是空字串，比誰都小。 */
function latestStamp(decks: readonly DeckEntry[], graves: readonly Tombstone[]): string {
  let best = "";
  for (const d of decks) if (d.updatedAt > best) best = d.updatedAt;
  for (const t of graves) if (t.deletedAt > best) best = t.deletedAt;
  return best;
}

/**
 * 照 `winner` 的順序排 `alive`，`winner` 沒有的接在後面（照另一邊的相對順序）。
 */
function orderLike(
  alive: Map<string, DeckEntry>,
  winner: readonly DeckEntry[],
  loser: readonly DeckEntry[],
): DeckEntry[] {
  const out: DeckEntry[] = [];
  const placed = new Set<string>();
  for (const d of winner) {
    const hit = alive.get(d.id);
    if (hit === undefined || placed.has(d.id)) continue;
    out.push(hit);
    placed.add(d.id);
  }
  for (const d of loser) {
    const hit = alive.get(d.id);
    if (hit === undefined || placed.has(d.id)) continue;
    out.push(hit);
    placed.add(d.id);
  }
  return out;
}

/**
 * 把雲端那份合進本地。
 *
 * 不動 `local` 與 `remote` 本身；回傳的庫是新物件。`remote` 是 `null` 代表雲端
 * 還沒有這個帳號的東西 —— 那就是本地整份上雲。
 */
export function mergeLibraries(local: DeckLibrary, remote: SyncDocument | null): MergeResult {
  const remoteLib =
    remote === null ? emptyLibrary(local.account) : libraryFromSyncDocument(remote, local.account);
  const plan = planSync(summarize(local), summarize(remoteLib));

  const merged: DeckLibrary = {
    ...local,
    collections: { ...local.collections },
    tombstones: { ...local.tombstones },
  };

  for (const room of ROOM_KINDS) {
    const localDecks = local.collections[room] ?? [];
    const remoteDecks = remoteLib.collections[room] ?? [];
    const localGraves = local.tombstones[room] ?? [];
    const remoteGraves = remoteLib.tombstones[room] ?? [];
    const rd = byId(remoteDecks);

    const pull = new Set(plan.pull.filter((r) => r.room === room).map((r) => r.id));
    const deleteLocal = new Set(plan.deleteLocal.filter((r) => r.room === room).map((r) => r.id));

    // 1. 活著的牌組：本地的 + 遠端要拉的，去掉遠端刪得比較新的
    const alive = new Map<string, DeckEntry>();
    for (const d of localDecks) {
      if (deleteLocal.has(d.id)) continue;
      if (pull.has(d.id)) continue; // 下面用遠端那份
      const twin = rd.get(d.id);
      // hash 一樣、時間不同：取較新的時間（理由見檔頭）
      if (twin !== undefined && twin.updatedAt > d.updatedAt && !pull.has(d.id)) {
        alive.set(d.id, { ...d, updatedAt: twin.updatedAt });
      } else {
        alive.set(d.id, d);
      }
    }
    for (const id of pull) {
      const entry = rd.get(id);
      if (entry !== undefined) alive.set(id, entry);
    }

    // 2. 順序：最近有動過的那一邊說了算，平手本地
    const remoteNewer =
      latestStamp(remoteDecks, remoteGraves) > latestStamp(localDecks, localGraves);
    merged.collections[room] = remoteNewer
      ? orderLike(alive, remoteDecks, localDecks)
      : orderLike(alive, localDecks, remoteDecks);

    // 3. 墓碑：聯集、同 id 取較新、活著的不留
    const graves = new Map<string, Tombstone>();
    for (const t of [...localGraves, ...remoteGraves]) {
      if (alive.has(t.id)) continue;
      const cur = graves.get(t.id);
      if (cur === undefined || t.deletedAt > cur.deletedAt) graves.set(t.id, t);
    }
    merged.tombstones[room] = [...graves.values()];
  }

  // 4. 最愛卡片：整份比時間（理由見 FavoriteCards）
  const favorites = newerFavorites(local.favorites, remoteLib.favorites);
  if (favorites === undefined) delete merged.favorites;
  else merged.favorites = favorites;
  // 5. 隱藏的裝備：同一套
  const hiddenWeapons = newerFavorites(local.hiddenWeapons, remoteLib.hiddenWeapons);
  if (hiddenWeapons === undefined) delete merged.hiddenWeapons;
  else merged.hiddenWeapons = hiddenWeapons;
  // 6. 最愛的事件卡：同一套
  const favoriteEvents = newerFavorites(local.favoriteEvents, remoteLib.favoriteEvents);
  if (favoriteEvents === undefined) delete merged.favoriteEvents;
  else merged.favoriteEvents = favoriteEvents;
  // 7. 首頁立繪：同一套
  const stand = newerLobbyStand(local.lobbyStand, remoteLib.lobbyStand);
  if (stand === undefined) delete merged.lobbyStand;
  else merged.lobbyStand = stand;

  const document = toSyncDocument(merged);
  const localChanged = serializeLibrary(merged) !== serializeLibrary(local);
  // 雲端還沒有東西、本地也是空的 → 沒東西可推（新帳號第一次開，不必為此寫一筆）
  const remoteChanged =
    remote === null
      ? document.favorites !== undefined ||
        document.hiddenWeapons !== undefined ||
        document.favoriteEvents !== undefined ||
        document.lobbyStand !== undefined ||
        ROOM_KINDS.some(
          (room) => document.collections[room].length > 0 || document.tombstones[room].length > 0,
        )
      : syncDocumentText(document) !== syncDocumentText(remote);
  return { library: merged, document, localChanged, remoteChanged, plan };
}

/**
 * 網路上收到的東西 → 文件。**容錯**：壞掉的那幾副丟掉，其他照收（跟存檔同一
 * 支解析）。整份不是物件、或 `version` 不是 1 → `null`，呼叫端當作「雲端那份
 * 讀不懂」**不要合併也不要覆蓋** —— 蓋掉一份讀不懂的東西，可能就是蓋掉另一台
 * 電腦用新版格式寫的庫。
 */
export function parseSyncDocument(raw: unknown): SyncDocument | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  // 1 = 改版前的舊格式（內容是資產索引），2 = 卡片 id。兩種都收 —— 另一台電腦
  // 還沒更新時推上來的是 1，parseLibrary() 會把內容轉成新卡號。
  const version = (raw as { version?: unknown }).version;
  if (version !== 1 && version !== 2) return null;
  const { library } = parseLibrary(raw, "00000000");
  return toSyncDocument(library);
}
