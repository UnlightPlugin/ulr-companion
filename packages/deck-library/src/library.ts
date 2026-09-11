/**
 * 牌組庫的增刪改排序（WP-18）
 * ============================
 * 全部是**不可變**操作：回傳新的 `DeckLibrary`，不動傳進來的那份。牌組庫會
 * 同時被遊戲內 UI 與存檔兩邊碰，就地改很容易寫出「畫面已經變了但檔案沒存到」
 * 這種狀態。
 *
 * 牌組認的是 `id` 不是陣列位置 —— 拖曳排序（規格 §10）會讓位置一直變，
 * 用位置當識別的話，玩家排序完再改名就會改到別副。
 */

import {
  type DeckContent,
  type DeckEntry,
  type DeckLibrary,
  type RaidBoss,
  type RoomKind,
  type Tombstone,
  RAID_BOSSES,
  ROOM_KINDS,
  emptyDeckContent,
} from "./types.js";

/**
 * 產生一個牌組 id。
 *
 * 用時間戳 + 隨機尾巴，不用流水號 —— 流水號在「刪掉中間一副再新增」之後會
 * 撞號，而撞號的症狀是拖曳排序時兩副一起動。
 */
export function makeDeckId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const tail = Math.random().toString(36).slice(2, 8);
  return `d${stamp}${tail}`;
}

/** 這一房有哪些牌組。回傳的是複本，改它不會動到庫。 */
export function listDecks(library: DeckLibrary, room: RoomKind): DeckEntry[] {
  return [...(library.collections[room] ?? [])];
}

/** 找一副。找不到回 `null`。 */
export function findDeck(library: DeckLibrary, room: RoomKind, id: string): DeckEntry | null {
  return (library.collections[room] ?? []).find((d) => d.id === id) ?? null;
}

/**
 * 畫面上要顯示的名字。
 *
 * 玩家沒取名字（或取了空白）就退回 `Deck{n}` —— **n 是它在清單裡的位置**，
 * 不是 id，這樣看起來跟原版一致。
 */
export function displayName(entry: DeckEntry, index: number): string {
  const trimmed = entry.name.trim();
  return trimmed === "" ? `Deck${index + 1}` : trimmed;
}

function replaceRoom(library: DeckLibrary, room: RoomKind, next: DeckEntry[]): DeckLibrary {
  return {
    ...library,
    collections: { ...library.collections, [room]: next },
  };
}

/** 新增一副（規格 §9 的 `+`）。放在清單最後。 */
export function addDeck(
  library: DeckLibrary,
  room: RoomKind,
  options: { name?: string; content?: DeckContent; bosses?: RaidBoss[]; now?: Date } = {},
): { library: DeckLibrary; entry: DeckEntry } {
  const now = options.now ?? new Date();
  const entry: DeckEntry = {
    id: makeDeckId(now),
    name: options.name ?? "",
    content: options.content ?? emptyDeckContent(),
    updatedAt: now.toISOString(),
    bosses: options.bosses ?? [],
  };
  return {
    library: replaceRoom(library, room, [...(library.collections[room] ?? []), entry]),
    entry,
  };
}

/**
 * 刪掉一副（規格 §9 的 `-`），**並且留下墓碑**。
 *
 * ⚠ 墓碑不是可選的。少了它，這次刪除傳不到另一台電腦，那邊的牌組下次同步
 * 就會把它推回來 —— 症狀是「我刪掉的牌組自己長回來了」。
 *
 * ⚠ 這支**不管刪到剩幾副**。「至少要留一副」這種規則屬於 UI 層 —— 那裡才知道
 * 玩家現在選著哪一副、刪掉之後要跳到哪一副。
 */
export function removeDeck(
  library: DeckLibrary,
  room: RoomKind,
  id: string,
  now: Date = new Date(),
): DeckLibrary {
  const next = (library.collections[room] ?? []).filter((d) => d.id !== id);
  const graves = (library.tombstones[room] ?? []).filter((t) => t.id !== id);
  graves.push({ id, deletedAt: now.toISOString() });
  return {
    ...library,
    collections: { ...library.collections, [room]: next },
    tombstones: { ...library.tombstones, [room]: graves },
  };
}

/**
 * 把一副牌組放回庫裡（同步從雲端拉下來時用），**並清掉它的墓碑**。
 *
 * 沒清墓碑的話，這副牌會在下一輪同步被自己的墓碑再刪一次 —— 而且因為墓碑的
 * `deletedAt` 比拉下來的 `updatedAt` 舊，判定還會反覆橫跳。
 */
export function upsertDeck(library: DeckLibrary, room: RoomKind, entry: DeckEntry): DeckLibrary {
  const list = [...(library.collections[room] ?? [])];
  const at = list.findIndex((d) => d.id === entry.id);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  return {
    ...library,
    collections: { ...library.collections, [room]: list },
    tombstones: {
      ...library.tombstones,
      [room]: (library.tombstones[room] ?? []).filter((t) => t.id !== entry.id),
    },
  };
}

/** 這一房的刪除記錄。 */
export function listTombstones(library: DeckLibrary, room: RoomKind): Tombstone[] {
  return [...(library.tombstones[room] ?? [])];
}

/**
 * 墓碑的預設保留天數。
 *
 * ⚠ **這個值是在跟「離線很久的電腦」賭。** 墓碑清掉之後，一台離線超過這個天數
 * 的電腦再上線，它手上那副（沒被刪的）牌組會被當成「新增」推回雲端 ——
 * 刪除復活。調短會讓復活更常發生，調長只是讓存檔大一點點（一筆墓碑幾十位元組），
 * 所以寧可長。
 */
export const TOMBSTONE_TTL_DAYS = 90;

/** 清掉太舊的墓碑。存檔不會無限長大，代價見 {@link TOMBSTONE_TTL_DAYS}。 */
export function pruneTombstones(
  library: DeckLibrary,
  now: Date = new Date(),
  ttlDays: number = TOMBSTONE_TTL_DAYS,
): DeckLibrary {
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  const next = {} as Record<RoomKind, Tombstone[]>;
  let changed = false;
  for (const room of ROOM_KINDS) {
    const graves = library.tombstones[room] ?? [];
    const kept = graves.filter((t) => {
      const at = Date.parse(t.deletedAt);
      // 日期壞掉的墓碑留著 —— 丟掉它等於讓那副牌復活
      return !Number.isFinite(at) || at >= cutoff;
    });
    if (kept.length !== graves.length) changed = true;
    next[room] = kept;
  }
  return changed ? { ...library, tombstones: next } : library;
}

/** 改名（規格 §6、§8）。找不到就原樣回傳。 */
export function renameDeck(
  library: DeckLibrary,
  room: RoomKind,
  id: string,
  name: string,
  now: Date = new Date(),
): DeckLibrary {
  const next = (library.collections[room] ?? []).map((d) =>
    d.id === id ? { ...d, name, updatedAt: now.toISOString() } : d,
  );
  return replaceRoom(library, room, next);
}

/** 換內容（玩家在 Edit 畫面改完牌，存回這一副）。 */
export function updateDeckContent(
  library: DeckLibrary,
  room: RoomKind,
  id: string,
  content: DeckContent,
  now: Date = new Date(),
): DeckLibrary {
  const next = (library.collections[room] ?? []).map((d) =>
    d.id === id ? { ...d, content, updatedAt: now.toISOString() } : d,
  );
  return replaceRoom(library, room, next);
}

/**
 * 換這副的渦 BOSS 標籤。
 *
 * 傳進來的清單會去重並照 `RAID_BOSSES` 的順序排好 —— 標籤列的畫法才不會
 * 跟著玩家點選的先後順序跳來跳去，而且同一組標籤永遠算出同一個 hash。
 */
export function setDeckBosses(
  library: DeckLibrary,
  room: RoomKind,
  id: string,
  bosses: RaidBoss[],
  now: Date = new Date(),
): DeckLibrary {
  const picked = new Set(bosses);
  const normalized = RAID_BOSSES.filter((b) => picked.has(b));
  const next = (library.collections[room] ?? []).map((d) =>
    d.id === id ? { ...d, bosses: normalized, updatedAt: now.toISOString() } : d,
  );
  return replaceRoom(library, room, next);
}

/**
 * 這一房裡掛了某個 BOSS 標籤的牌組，照現在的排列順序。
 *
 * 「點了 BOSS 自動切牌組」就是拿第一副 —— 玩家用拖曳排序決定優先順序
 * （規格 §10），所以這裡**不要**自作聰明排序。
 */
export function decksForBoss(library: DeckLibrary, boss: RaidBoss): DeckEntry[] {
  return (library.collections.raid ?? []).filter((d) => d.bosses.includes(boss));
}

/**
 * 搬動一副到第 `toIndex` 個位置（規格 §10 的長按拖曳）。
 *
 * `toIndex` 是**搬完之後**它該在的位置，會夾在 `0..長度-1`。找不到 id 就原樣
 * 回傳。
 */
export function moveDeck(
  library: DeckLibrary,
  room: RoomKind,
  id: string,
  toIndex: number,
): DeckLibrary {
  const current = [...(library.collections[room] ?? [])];
  const from = current.findIndex((d) => d.id === id);
  if (from < 0) return library;

  const moved = current[from];
  if (moved === undefined) return library;

  current.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, current.length));
  current.splice(clamped, 0, moved);
  return replaceRoom(library, room, current);
}

/**
 * 記住「這一房我要用哪一副」（WP-19）。
 *
 * 玩家在選單裡點一副就記，**跟寫不寫得進 Deck1 無關** —— 意圖跟事實是兩件事，
 * 見 {@link DeckLibrary.selected}。`null` 是清掉。
 */
export function setSelected(library: DeckLibrary, room: RoomKind, id: string | null): DeckLibrary {
  return {
    ...library,
    selected: { ...(library.selected ?? emptySelected()), [room]: id },
  };
}

function emptySelected(): Record<RoomKind, string | null> {
  return { raid: null, alexandria: null, quest: null, dietherm: null };
}

/**
 * **進到這一房要套用哪一副。** 找不到就退回清單第一副，整房空的才回 `null`。
 *
 * ⚠ 退回第一副是刻意的，不是防呆：`selected` 指向的那副可能在另一台電腦被刪掉
 * 了（同步回來就會這樣）。那時候「這一房沒有牌組可用」是錯的答案 —— 玩家明明
 * 還有別副。回 `null` 的話進房就什麼都不會發生，而玩家看不出原因。
 */
export function resolveSelected(library: DeckLibrary, room: RoomKind): DeckEntry | null {
  const list = library.collections[room] ?? [];
  const want = library.selected?.[room] ?? null;
  if (want !== null) {
    const hit = list.find((d) => d.id === want);
    if (hit !== undefined) return hit;
  }
  return list[0] ?? null;
}
