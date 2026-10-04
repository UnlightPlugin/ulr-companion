/**
 * 牌組庫的存檔格式（WP-18）
 * ==========================
 * **這個檔案不碰檔案系統。** 序列化與容錯解析在這裡，落地在托盤那邊 ——
 * 跟 `profiles-core.ts` / `profiles.ts` 分開的理由一樣：解析要測得到。
 *
 * ## 解析一律容錯，永遠不丟例外
 *
 * 這份檔案會被雲端同步蓋寫、會被玩家手動編輯、會跨版本。**壞掉的那一副丟掉，
 * 其他的照常載入** —— 整份 parse 失敗會讓玩家一次弄丟所有牌組，而症狀是
 * 「插件把我的牌組吃了」。
 */

import { legacyCharaId, legacyEventId, legacyWeaponId } from "@ulr/rule-schema";
import { parseLobbyStand, serializeLobbyStand } from "./lobby-stand.js";
import {
  CHARA_SLOTS,
  EVENT_SLOTS,
  type DeckContent,
  type DeckEntry,
  type DeckLibrary,
  type FavoriteCards,
  type Tombstone,
  RAID_BOSSES,
  ROOM_KINDS,
  emptyLibrary,
  isRaidBoss,
} from "./types.js";

/** 帳號指紋的樣子：SHA-256 的前 8 個 hex。 */
const ACCOUNT_RE = /^[0-9a-f]{8}$/;

/** 這是合法的帳號指紋嗎。⚠ 不合法的話**不要**拿玩家 id 去補。 */
export function isAccountFingerprint(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_RE.test(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 讀一格「卡片索引或空」。任何不是有限數字的東西一律當空格。 */
function cellNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function cellString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 補齊或截斷到固定長度 —— 存檔裡的陣列長度不對時不要整副丟掉。 */
function fixed<T>(src: unknown, length: number, read: (v: unknown) => T): T[] {
  const arr = Array.isArray(src) ? src : [];
  const out: T[] = [];
  for (let i = 0; i < length; i++) out.push(read(arr[i]));
  return out;
}

/**
 * 這一份是不是 2026-09-23 改版前的舊格式（資產索引，不是卡片 id）。
 *
 * 認的是 `charaIndex`／`eventIndex` 這兩個欄位名 —— 新格式沒有它們。
 */
export function isLegacyDeckContent(raw: unknown): boolean {
  return isRecord(raw) && ("charaIndex" in raw || "eventIndex" in raw);
}

/**
 * 讀一副的內容。新舊兩種形狀都收：
 *
 * ```
 *   新（v2）  { charaId, weaponId, eventId }            直接讀
 *   舊（v1）  { chara, charaIndex, weapon, eventIndex }  查對照表轉成 id
 * ```
 *
 * ⚠ 舊格式的角色槽要**同時**看 `chara`（前綴 `mc` 是怪物）與 `charaIndex` ——
 * 兩張資產表的索引是各自從 0 數的，只看數字會把怪物讀成不相干的角色。
 *
 * ⚠ 對照表查不到的格子會變成空的。現有的對照表涵蓋改版前的每一張卡（角色 700、
 * 怪物 138、武器 238、事件卡 110），所以實際上不會發生；真的發生時寧可空著，
 * 也不要留一個會被當成新 id 的舊索引 —— 那會變成一張不相干的卡。
 */
export function parseDeckContent(raw: unknown): DeckContent {
  const r = isRecord(raw) ? raw : {};
  if (isLegacyDeckContent(r)) {
    const chara = fixed(r.chara, CHARA_SLOTS, cellString);
    const charaIndex = fixed(r.charaIndex, CHARA_SLOTS, cellNumber);
    const convert = (index: number | null, to: (n: number) => number | null): number | null =>
      index === null ? null : to(index);
    return {
      charaId: charaIndex.map((index, slot) =>
        convert(index, (n) => legacyCharaId(chara[slot] ?? null, n)),
      ),
      weaponId: fixed(r.weapon, CHARA_SLOTS, cellNumber).map((i) => convert(i, legacyWeaponId)),
      eventId: fixed(r.eventIndex, EVENT_SLOTS, cellNumber).map((i) => convert(i, legacyEventId)),
    };
  }
  return {
    charaId: fixed(r.charaId, CHARA_SLOTS, cellNumber),
    weaponId: fixed(r.weaponId, CHARA_SLOTS, cellNumber),
    eventId: fixed(r.eventId, EVENT_SLOTS, cellNumber),
  };
}

/** 壞掉（沒 id）的回 `null`，呼叫端會把它丟掉。 */
function parseEntry(raw: unknown): DeckEntry | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (id === null) return null;
  // 標籤去重並照固定順序排 —— 存檔可能是手改的，順序亂掉會讓 hash 每次不同
  const picked = new Set(Array.isArray(raw.bosses) ? raw.bosses.filter(isRaidBoss) : []);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    content: parseDeckContent(raw.content),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    bosses: RAID_BOSSES.filter((b) => picked.has(b)),
  };
}

/** 壞掉（沒 id 或沒時間）的墓碑丟掉 —— 留著會變成永遠判不出勝負的刪除記錄。 */
function parseTombstone(raw: unknown): Tombstone | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (id === null) return null;
  const deletedAt = typeof raw.deletedAt === "string" ? raw.deletedAt : null;
  if (deletedAt === null) return null;
  return { id, deletedAt };
}

/** 解析結果。`dropped` 是丟掉幾副 —— 呼叫端該把它顯示出來，不要安靜地吞掉。 */
export interface ParseResult {
  library: DeckLibrary;
  dropped: number;
  /**
   * 有幾副是從改版前的舊格式轉過來的（見 {@link parseDeckContent}）。
   * 呼叫端拿它決定要不要寫一行「已轉成新卡號」並立刻存回新格式。
   */
  migrated: number;
}

/**
 * 從存檔字串或物件還原牌組庫。
 *
 * `fallbackAccount` 是檔案裡讀不到帳號指紋時要用的（通常就是當下這個帳號）。
 */
export function parseLibrary(raw: string | unknown, fallbackAccount: string): ParseResult {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { library: emptyLibrary(fallbackAccount), dropped: 0, migrated: 0 };
    }
  }
  if (!isRecord(data)) return { library: emptyLibrary(fallbackAccount), dropped: 0, migrated: 0 };

  const account = isAccountFingerprint(data.account) ? data.account : fallbackAccount;
  const label = typeof data.accountLabel === "string" ? data.accountLabel : undefined;
  const lib = emptyLibrary(account, label);

  const collections = isRecord(data.collections) ? data.collections : {};
  let dropped = 0;
  let migrated = 0;
  for (const room of ROOM_KINDS) {
    const list = collections[room];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const item of list) {
      const entry = parseEntry(item);
      if (entry === null) {
        dropped++;
        continue;
      }
      // 撞 id 的話只留第一副 —— 兩副同 id 會讓改名/刪除同時動到兩個。
      if (seen.has(entry.id)) {
        dropped++;
        continue;
      }
      seen.add(entry.id);
      if (isRecord(item) && isLegacyDeckContent(item.content)) migrated++;
      lib.collections[room].push(entry);
    }
  }

  // 墓碑。舊版存檔沒有這一欄，那就是空的（不是錯誤）。
  const graves = isRecord(data.tombstones) ? data.tombstones : {};
  for (const room of ROOM_KINDS) {
    const list = graves[room];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const item of list) {
      const grave = parseTombstone(item);
      if (grave === null || seen.has(grave.id)) continue;
      // 牌組還在就不留墓碑 —— 兩者同時存在的話同步會反覆橫跳
      if (lib.collections[room].some((d) => d.id === grave.id)) continue;
      seen.add(grave.id);
      lib.tombstones[room].push(grave);
    }
  }

  // 每一房上次選了哪一副。舊版存檔沒有這一欄 → 全部 null（不是錯誤）。
  // ⚠ **不驗那個 id 還在不在。** 牌組可能是在另一台電腦刪掉的，同步回來之後
  // 這裡會指向一副不存在的牌 —— 那不是壞掉的存檔，呼叫端查不到自己會退回
  // 第一副（`resolveSelected()`）。在這裡清掉的話，玩家只是同步一次就會發現
  // 每一房的選擇都被重設了。
  const selected = isRecord(data.selected) ? data.selected : {};
  for (const room of ROOM_KINDS) {
    const id = selected[room];
    if (typeof id === "string" && id !== "") lib.selected[room] = id;
  }

  // 最愛卡片。舊版存檔沒有這一欄 → 不設（跟「清空了」不一樣，見 DeckLibrary.favorites）。
  const favorites = parseFavorites(data.favorites);
  if (favorites !== null) lib.favorites = favorites;
  // 隱藏的裝備：同一個形狀、同一套規則。
  const hiddenWeapons = parseFavorites(data.hiddenWeapons);
  if (hiddenWeapons !== null) lib.hiddenWeapons = hiddenWeapons;
  const favoriteEvents = parseFavorites(data.favoriteEvents);
  if (favoriteEvents !== null) lib.favoriteEvents = favoriteEvents;
  // 首頁立繪：同一套「沒有這欄 = 沒設過」。
  const stand = parseLobbyStand(data.lobbyStand);
  if (stand !== null) lib.lobbyStand = stand;
  return { library: lib, dropped, migrated };
}

/**
 * 只收正整數 id（這是從網路上收來的）。當天第一版存角色鍵的 `{ charas }` 沒有
 * `cards` → 當沒設過（見 FavoriteCards）。
 */
function parseFavorites(raw: unknown): FavoriteCards | null {
  if (!isRecord(raw) || typeof raw.updatedAt !== "string" || !Array.isArray(raw.cards)) {
    return null;
  }
  const cards: number[] = [];
  for (const c of raw.cards) {
    if (Number.isSafeInteger(c) && (c as number) > 0 && !cards.includes(c as number)) {
      cards.push(c as number);
    }
  }
  return { cards, updatedAt: raw.updatedAt };
}

/**
 * 存檔字串。key 順序固定，這樣同樣的內容永遠是同一串位元組 —— 雲端同步要靠
 * 它比對「有沒有變」，用 `JSON.stringify(物件)` 的話 key 順序跟著建構過程跑，
 * 會一直誤判成有變動。
 */
export function serializeLibrary(library: DeckLibrary): string {
  const collections: Record<string, unknown[]> = {};
  const tombstones: Record<string, unknown[]> = {};
  for (const room of ROOM_KINDS) {
    collections[room] = (library.collections[room] ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      content: {
        charaId: d.content.charaId,
        weaponId: d.content.weaponId,
        eventId: d.content.eventId,
      },
      updatedAt: d.updatedAt,
      bosses: d.bosses,
    }));
    tombstones[room] = (library.tombstones[room] ?? []).map((t) => ({
      id: t.id,
      deletedAt: t.deletedAt,
    }));
  }
  const selected: Record<string, string | null> = {};
  for (const room of ROOM_KINDS) selected[room] = library.selected?.[room] ?? null;

  const out: Record<string, unknown> = { version: 2, account: library.account };
  if (library.accountLabel !== undefined) out.accountLabel = library.accountLabel;
  out.collections = collections;
  out.tombstones = tombstones;
  out.selected = selected;
  if (library.favorites !== undefined) {
    out.favorites = { cards: library.favorites.cards, updatedAt: library.favorites.updatedAt };
  }
  if (library.hiddenWeapons !== undefined) {
    out.hiddenWeapons = {
      cards: library.hiddenWeapons.cards,
      updatedAt: library.hiddenWeapons.updatedAt,
    };
  }
  if (library.favoriteEvents !== undefined) {
    out.favoriteEvents = {
      cards: library.favoriteEvents.cards,
      updatedAt: library.favoriteEvents.updatedAt,
    };
  }
  if (library.lobbyStand !== undefined) out.lobbyStand = serializeLobbyStand(library.lobbyStand);
  return JSON.stringify(out, null, 2);
}

/** 存檔的檔名。⚠ 只用指紋，**不要**把玩家名稱放進檔名（那是可辨識資訊）。 */
export function libraryFileName(account: string): string {
  return `decks-${account}.json`;
}

/**
 * 伺服器那一副的樣子（`registry.deck` 的元素、`db_deck` 與 `deck_update` 的形狀）。
 *
 * ⚠ 這裡**故意不 import `@ulr/cdp-adapter` 的型別** —— 這個 package 是純函式，
 * 不該依賴 CDP 那一層。結構型別讓兩邊直接互通；形狀漂移了托盤那邊會當場紅。
 */
export interface ServerDeckShape {
  deck_id: number;
  /** 1 = 這一副是「主牌組」（開機時 `deck_now` 從它來、大廳立繪用它）。 */
  main: number;
  chara_card_id: (number | null)[];
  weapon_card_id: (number | null)[];
  event_card_id: (number | null)[];
  /** 閃卡特效的狀態。牌組庫不管它，寫回去時照原樣帶。 */
  card_effect: unknown[];
  /** 伺服器算的。寫回去時照原樣帶，伺服器會自己重算。 */
  cost: number;
}

/** 伺服器那一副 → `DeckContent`。 */
export function deckContentFromServer(
  deck: Partial<ServerDeckShape> | null | undefined,
): DeckContent {
  const d = isRecord(deck) ? deck : {};
  return {
    charaId: fixed(d.chara_card_id, CHARA_SLOTS, cellNumber),
    weaponId: fixed(d.weapon_card_id, CHARA_SLOTS, cellNumber),
    eventId: fixed(d.event_card_id, EVENT_SLOTS, cellNumber),
  };
}

/**
 * 把 `content` 換進伺服器那一副，其餘欄位（`deck_id`、`main`、`card_effect`、
 * `cost`）照原樣留著。回傳新物件，不動 `base`。
 */
export function withDeckContent<T extends ServerDeckShape>(base: T, content: DeckContent): T {
  return {
    ...base,
    chara_card_id: [...content.charaId],
    weapon_card_id: [...content.weaponId],
    event_card_id: [...content.eventId],
  };
}
