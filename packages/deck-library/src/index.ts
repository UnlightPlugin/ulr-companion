/**
 * `@ulr/deck-library` —— 本地牌組庫（WP-18）
 * ==========================================
 * 伺服器只有三副牌組而且擴不出第四副（見 `types.ts` 開頭的實測）。這個 package
 * 讓玩家在本地存任意多副，切換時把選中的那副寫進 **Deck1** —— Deck1 是唯一的
 * 工作槽，Deck2/Deck3 清空之後它們佔住的卡片庫存全部回到池子裡。
 *
 * ⚠ **這裡全部是純函式，不碰檔案也不碰 CDP。** 寫進遊戲的部分在
 * `@ulr/cdp-adapter`，落地在托盤。唯一的例外是 `hash.ts` 用了 `node:crypto`。
 */

export {
  CHARA_SLOTS,
  EVENT_SLOTS,
  EVENT_SLOTS_PER_CHARA,
  RAID_BOSSES,
  RAID_BOSS_LABELS,
  ROOM_KINDS,
  ROOM_LABELS,
  emptyDeckContent,
  emptyLibrary,
  guardDeck1,
  isEmptyDeck,
  isRaidBoss,
} from "./types.js";
export type {
  DeckContent,
  DeckEntry,
  DeckLibrary,
  RaidBoss,
  RoomKind,
  Tombstone,
} from "./types.js";

export {
  CHARA_VARIANTS,
  charaNumberOf,
  charaStock,
  charaVariantOf,
  eventStock,
  findShortages,
  isRareVariant,
  weaponStock,
} from "./inventory.js";
export type { Inventory, StockShortage } from "./inventory.js";

export {
  TOMBSTONE_TTL_DAYS,
  addDeck,
  decksForBoss,
  displayName,
  findDeck,
  listDecks,
  listTombstones,
  makeDeckId,
  moveDeck,
  pruneTombstones,
  removeDeck,
  renameDeck,
  resolveSelected,
  setDeckBosses,
  setSelected,
  updateDeckContent,
  upsertDeck,
} from "./library.js";

export { deckContentCanonical, deckContentHash, deckEntryHash } from "./hash.js";

export { isSyncNeeded, planSync, summarize } from "./sync.js";
export type { DeckRef, DeckStamp, LibrarySummary, SyncPlan } from "./sync.js";

export {
  deckContentFromFlat,
  deckContentToPayload,
  isAccountFingerprint,
  libraryFileName,
  parseDeckContent,
  parseLibrary,
  serializeLibrary,
} from "./serialize.js";
export type { DeckPayloadShape, ParseResult } from "./serialize.js";
