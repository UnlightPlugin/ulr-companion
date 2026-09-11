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

import {
  CHARA_SLOTS,
  EVENT_SLOTS,
  type DeckContent,
  type DeckEntry,
  type DeckLibrary,
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

export function parseDeckContent(raw: unknown): DeckContent {
  const r = isRecord(raw) ? raw : {};
  return {
    chara: fixed(r.chara, CHARA_SLOTS, cellString),
    charaIndex: fixed(r.charaIndex, CHARA_SLOTS, cellNumber),
    weapon: fixed(r.weapon, CHARA_SLOTS, cellNumber),
    eventIndex: fixed(r.eventIndex, EVENT_SLOTS, cellNumber),
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
      return { library: emptyLibrary(fallbackAccount), dropped: 0 };
    }
  }
  if (!isRecord(data)) return { library: emptyLibrary(fallbackAccount), dropped: 0 };

  const account = isAccountFingerprint(data.account) ? data.account : fallbackAccount;
  const label = typeof data.accountLabel === "string" ? data.accountLabel : undefined;
  const lib = emptyLibrary(account, label);

  const collections = isRecord(data.collections) ? data.collections : {};
  let dropped = 0;
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
  return { library: lib, dropped };
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
        chara: d.content.chara,
        charaIndex: d.content.charaIndex,
        weapon: d.content.weapon,
        eventIndex: d.content.eventIndex,
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

  const out: Record<string, unknown> = { version: 1, account: library.account };
  if (library.accountLabel !== undefined) out.accountLabel = library.accountLabel;
  out.collections = collections;
  out.tombstones = tombstones;
  out.selected = selected;
  return JSON.stringify(out, null, 2);
}

/** 存檔的檔名。⚠ 只用指紋，**不要**把玩家名稱放進檔名（那是可辨識資訊）。 */
export function libraryFileName(account: string): string {
  return `decks-${account}.json`;
}

/** 把 `db_deck*` 的扁平回傳攤成 `DeckContent`。 */
export function deckContentFromFlat(flat: Record<string, unknown>): DeckContent {
  const chara: (string | null)[] = [];
  const charaIndex: (number | null)[] = [];
  const weapon: (number | null)[] = [];
  for (let i = 1; i <= CHARA_SLOTS; i++) {
    chara.push(cellString(flat[`chara${i}`]));
    charaIndex.push(cellNumber(flat[`charaIndex${i}`]));
    weapon.push(cellNumber(flat[`weapon${i}`]));
  }
  const eventIndex: (number | null)[] = [];
  for (let i = 1; i <= EVENT_SLOTS; i++) eventIndex.push(cellNumber(flat[`event${i}`]));
  return { chara, charaIndex, weapon, eventIndex };
}

/**
 * `db_editdeck` 送出去的那個形狀。
 *
 * ⚠ 這裡**故意不 import `@ulr/cdp-adapter` 的 `DeckPayload`** —— 這個 package
 * 是純函式，不該依賴 CDP 那一層。兩邊的欄位一模一樣，結構型別讓它直接餵得
 * 進去；哪天形狀漂移了，托盤那邊會在型別上當場紅起來，正是我們要的。
 */
export interface DeckPayloadShape {
  chara: (string | null)[];
  charaIndex: (number | null)[];
  /** 18 格。 */
  eventIndex: (number | null)[];
  weapon: (number | null)[];
  cost: number;
}

/**
 * 反過來：`DeckContent` → `db_editdeck` 要送的那個物件。
 *
 * ⚠ 欄位名是 `eventIndex` 不是 `event` —— 送出去的形狀跟 `db_deck*` **收回來的
 * 不一樣**（收回來是扁平的 `event1..event18`，送出去是陣列）。2026-08-24 實測
 * 確認過這個形狀伺服器會 ack 並生效。
 */
export function deckContentToPayload(content: DeckContent, cost = 0): DeckPayloadShape {
  return {
    chara: [...content.chara],
    charaIndex: [...content.charaIndex],
    eventIndex: [...content.eventIndex],
    weapon: [...content.weapon],
    cost,
  };
}
