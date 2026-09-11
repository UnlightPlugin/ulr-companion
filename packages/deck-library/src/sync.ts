/**
 * 增量同步（WP-18）
 * ==================
 * 規格：**編輯完就上傳，另一端比對牌組 hash，只更新改過的那幾副。**
 *
 * 所以兩端先交換的是「摘要」（每副的 id + hash + updatedAt，外加刪除記錄），
 * 不是牌組本身。一副牌組的內容大約 100 個位元組，但玩家可能有幾十副 × 四種
 * 房 —— 每次開機都整份搬的話，慢還是其次，真正的問題是**分不出誰比較新**，
 * 兩台電腦交替用就會互相覆蓋。
 *
 * ## 刪除靠墓碑，不能靠「有沒有」
 *
 * 「這邊沒有那副牌」有兩種可能：對面新增了，或者這邊刪掉了。**光看有沒有分不
 * 出來。** 所以刪除會留下 {@link Tombstone}（`removeDeck()` 負責），而同步時
 * 把墓碑跟牌組**放在同一個時間軸上比**：
 *
 * ```
 *   本地 entry(10:00)  vs  遠端墓碑(11:00)   →  刪除比較新，本地也刪掉
 *   本地 entry(12:00)  vs  遠端墓碑(11:00)   →  編輯比較新，牌組復活並推上去
 * ```
 *
 * 這樣「A 電腦刪掉、B 電腦沒開機」的情況，B 上線後會跟著刪；而「A 刪掉之後
 * B 又編輯過」則以編輯為準 —— 玩家最後一次動它的意圖贏。
 *
 * ⚠ 墓碑會被 `pruneTombstones()` 清掉（預設 90 天）。一台離線超過那個天數的
 * 電腦上線時，它手上那副沒被刪的牌組會被當成新增推回去 —— 刪除復活。這是
 * 墓碑法固有的取捨，只能靠保留期換。
 */

import { deckEntryHash } from "./hash.js";
import { type DeckLibrary, type RoomKind, type Tombstone, ROOM_KINDS } from "./types.js";

/** 一副牌組在同步時的指紋。**摘要交換的就是這個，不含牌組內容。** */
export interface DeckStamp {
  id: string;
  /** `deckEntryHash()`：名字 + 標籤 + 內容。 */
  hash: string;
  updatedAt: string;
}

/** 一份庫的摘要。每一房的陣列順序**就是**牌組的排列順序（規格 §10）。 */
export interface LibrarySummary {
  account: string;
  rooms: Record<RoomKind, DeckStamp[]>;
  /** 刪除記錄。少了它就沒有刪除同步 —— 見本檔開頭。 */
  tombstones: Record<RoomKind, Tombstone[]>;
}

/** 算出一份庫的摘要。 */
export function summarize(library: DeckLibrary): LibrarySummary {
  const rooms = {} as Record<RoomKind, DeckStamp[]>;
  const graves = {} as Record<RoomKind, Tombstone[]>;
  for (const room of ROOM_KINDS) {
    rooms[room] = (library.collections[room] ?? []).map((d) => ({
      id: d.id,
      hash: deckEntryHash(d),
      updatedAt: d.updatedAt,
    }));
    graves[room] = [...(library.tombstones[room] ?? [])];
  }
  return { account: library.account, rooms, tombstones: graves };
}

/** 指到某一房的某一副。 */
export interface DeckRef {
  room: RoomKind;
  id: string;
}

/** 同步計畫。全部是空的就表示兩邊已經一致。 */
export interface SyncPlan {
  /** 要從雲端拉下來的（遠端較新，或本地沒有）。 */
  pull: DeckRef[];
  /** 要推上去的（本地較新，或雲端沒有）。 */
  push: DeckRef[];
  /** 遠端的刪除比較新 —— **本地要跟著刪掉**。 */
  deleteLocal: DeckRef[];
  /** 本地的刪除比較新 —— **雲端要跟著刪掉**。 */
  deleteRemote: DeckRef[];
  /**
   * 兩邊都動過、時間戳卻**一模一樣**的那幾副。
   *
   * 時間戳判不出勝負時的處置寫在 `planSync()` 裡（編輯衝突本地優先、
   * 編輯對上刪除則刪除優先），但仍然列出來 —— UI 該讓玩家知道有東西被蓋掉了。
   */
  conflicts: DeckRef[];
  /** 牌組內容一致、但**排列順序**不同的房。 */
  reorder: RoomKind[];
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(it.id, it);
  return m;
}

/**
 * 比出要拉什麼、要推什麼、要刪什麼。
 *
 * ⚠ 純比對，不碰網路也不算 hash —— 摘要進來、計畫出去。這樣它測得到，而
 * 「同步把牌組吃掉了」這種 bug 一定要測得到。
 */
export function planSync(local: LibrarySummary, remote: LibrarySummary): SyncPlan {
  const plan: SyncPlan = {
    pull: [],
    push: [],
    deleteLocal: [],
    deleteRemote: [],
    conflicts: [],
    reorder: [],
  };

  for (const room of ROOM_KINDS) {
    const localDecks = byId(local.rooms[room] ?? []);
    const remoteDecks = byId(remote.rooms[room] ?? []);
    const localGraves = byId(local.tombstones[room] ?? []);
    const remoteGraves = byId(remote.tombstones[room] ?? []);

    const ids = new Set<string>([
      ...localDecks.keys(),
      ...remoteDecks.keys(),
      ...localGraves.keys(),
      ...remoteGraves.keys(),
    ]);

    for (const id of ids) {
      const ld = localDecks.get(id);
      const rd = remoteDecks.get(id);
      const lg = localGraves.get(id);
      const rg = remoteGraves.get(id);
      const ref: DeckRef = { room, id };

      // 兩邊都還在：比 hash，再比誰新
      if (ld !== undefined && rd !== undefined) {
        if (ld.hash === rd.hash) continue;
        if (ld.updatedAt > rd.updatedAt) plan.push.push(ref);
        else if (ld.updatedAt < rd.updatedAt) plan.pull.push(ref);
        else {
          // 同一毫秒各改各的 —— 本地優先，但要說
          plan.conflicts.push(ref);
          plan.push.push(ref);
        }
        continue;
      }

      // 本地還在，遠端刪了：編輯 vs 刪除，誰晚誰贏
      if (ld !== undefined && rg !== undefined) {
        if (ld.updatedAt > rg.deletedAt)
          plan.push.push(ref); // 刪除之後又改過 → 復活
        else {
          // 平手時刪除優先：刪不掉的牌組比誤刪更難解釋，而誤刪救得回來
          if (ld.updatedAt === rg.deletedAt) plan.conflicts.push(ref);
          plan.deleteLocal.push(ref);
        }
        continue;
      }

      // 遠端還在，本地刪了：對稱
      if (rd !== undefined && lg !== undefined) {
        if (rd.updatedAt > lg.deletedAt) plan.pull.push(ref);
        else {
          if (rd.updatedAt === lg.deletedAt) plan.conflicts.push(ref);
          plan.deleteRemote.push(ref);
        }
        continue;
      }

      // 只有本地有 → 推上去；只有遠端有 → 拉下來
      if (ld !== undefined) {
        plan.push.push(ref);
        continue;
      }
      if (rd !== undefined) {
        plan.pull.push(ref);
        continue;
      }
      // 剩下的都是「兩邊都已經沒有了」（墓碑對墓碑、或墓碑對空），不必動
    }

    // 順序：只比兩邊都還在的那些
    const shared = (local.rooms[room] ?? []).filter((s) => remoteDecks.has(s.id)).map((s) => s.id);
    const sharedRemote = (remote.rooms[room] ?? [])
      .filter((s) => localDecks.has(s.id))
      .map((s) => s.id);
    if (shared.length === sharedRemote.length && shared.some((id, i) => id !== sharedRemote[i])) {
      plan.reorder.push(room);
    }
  }

  return plan;
}

/** 這份計畫有東西要做嗎。 */
export function isSyncNeeded(plan: SyncPlan): boolean {
  return (
    plan.pull.length > 0 ||
    plan.push.length > 0 ||
    plan.deleteLocal.length > 0 ||
    plan.deleteRemote.length > 0 ||
    plan.reorder.length > 0
  );
}
