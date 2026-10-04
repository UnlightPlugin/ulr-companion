/**
 * 公開渦通知（raid-feed）：托盤這一端
 * ==================================
 * 設計見 `docs/raid-feed.md`，雲端規則見 `@ulr/arbiter-link/raid-feed`。
 *
 * 渦房裡每 30 秒那一輪（engine 的 `#refreshRaidPublic`）順手做三件事，全部**被動**：
 *
 * ```
 *   GET  /raid-feed                    → 公開渦表（取代已經停掉的 ulgg 觀測站）
 *   POST /raid-feed {source:"support"} ← 玩家最後一次打開 SUPPORT 看到的清單（變了才傳）
 *   POST /raid-feed {source:"own"}     ← 自己清單上、帳本還缺 ★／stage 的渦
 * ```
 *
 * - 不送任何遊戲請求：SUPPORT 清單是玩家自己打開時客戶端拿到的（cdp-adapter `raid-support.ts`）
 * - **沒有渦碼**：頁面那邊就丟掉了
 * - `own` 只補帳本上已經有的渦（雲端也會擋），所以先 GET 再決定要補哪些 —— 不靠本機記憶，
 *   上一次沒傳成功或那時帳本還沒有這個渦，下一輪自己會補上
 * - **任何失敗都當沒查到／沒傳**，不丟例外
 */

import { SERVICE_ORIGIN } from "@ulr/arbiter-link";
import {
  MAX_RAID_FEED_PER_POST,
  RAID_FEED_PATH,
  type RaidFeedIn,
  type RaidFeedSource,
  type RaidFeedView,
} from "@ulr/arbiter-link/raid-feed";
import type {
  RaidPublicMap,
  RaidPublishedRow,
  RaidSnapshotRow,
  RaidSupportRow,
} from "@ulr/cdp-adapter";
import { DEFAULT_RAID_PUBLIC_TIMEOUT_MS, type FetchLike, withTimeout } from "./raid-public.js";

export const DEFAULT_RAID_FEED_URL = `${SERVICE_ORIGIN}${RAID_FEED_PATH}`;

const feedKey = (founder: string, foundAt: number) => `${founder}@${foundAt}`;

export function supportToFeed(rows: readonly RaidSupportRow[]): RaidFeedIn[] {
  return rows.map((r) => ({
    ...r,
    rarity: null,
    level: null,
    stage: null,
    mapIndex: null,
    states: null,
    statesAt: null,
  }));
}

/** 自己清單的一列 → 上傳的形狀。沒有發現者／發現時刻的（舊版頁面）丟掉。 */
export function ownToFeed(rows: readonly RaidSnapshotRow[]): RaidFeedIn[] {
  const out: RaidFeedIn[] = [];
  for (const r of rows) {
    if (typeof r.founder !== "string" || r.founder === "" || typeof r.foundAt !== "number")
      continue;
    out.push({
      founder: r.founder,
      foundAt: r.foundAt,
      limit: r.limit,
      name: r.meta?.name || null,
      monsterId: r.meta?.monsterId ?? null,
      mons: r.mons,
      hp: r.hp,
      hpMax: r.hpMax,
      memberLength: null,
      memberLimit: null,
      rarity: r.rarity,
      level: r.meta?.level ?? null,
      stage: r.stage,
      mapIndex: r.meta?.mapIndex ?? null,
      // 開打時看到的 BOSS 狀態；沒打過（statesAt 是 null）就不帶
      states: r.statesAt !== null ? r.states : null,
      statesAt: r.statesAt,
    });
  }
  return out;
}

/** 自己按「送出」公開的渦 → 上傳的形狀（`publish` 能新增渦）。 */
export function publishedToFeed(rows: readonly RaidPublishedRow[]): RaidFeedIn[] {
  return rows.map((r) => ({
    founder: r.founder,
    foundAt: r.foundAt,
    limit: r.limit,
    name: r.name,
    monsterId: r.monsterId,
    mons: r.mons,
    hp: r.hp,
    hpMax: r.hpMax,
    memberLength: null,
    memberLimit: null,
    rarity: r.rarity,
    level: r.level,
    stage: null,
    mapIndex: r.mapIndex,
    states: null,
    statesAt: null,
  }));
}

/**
 * 要補給帳本的：帳本缺了自己知道的 ★／stage／區塊（區塊拿去查 ulrmap 獎勵表）、
 * 自己看到的 BOSS 狀態比帳本上的新、或自己看到它死了而帳本還不知道。
 */
export function pickOwnToFill(
  own: readonly RaidFeedIn[],
  feed: readonly RaidFeedView[],
): RaidFeedIn[] {
  const byKey = new Map(feed.map((v) => [feedKey(v.founder, v.foundAt), v]));
  return own.filter((r) => {
    const v = byKey.get(feedKey(r.founder, r.foundAt));
    if (v === undefined) return false;
    // 只補缺的、不蓋別人的（兩個人看到的 stage 不一樣時，每輪互蓋只會讓訊息一直被改）
    return (
      (r.stage !== null && v.stage === null) ||
      (r.rarity !== null && v.rarity === null) ||
      (r.mapIndex !== null && (v.mapIndex ?? null) === null) ||
      (r.statesAt !== null && r.statesAt > (v.statesAt ?? -1)) ||
      (r.hp !== null && r.hp <= 0 && !(v.hp !== null && v.hp <= 0))
    );
  });
}

/** GET 回來的 → 頁面要的公開渦表（鍵跟插件互傳一樣用 `@發現者@到期時刻`）。 */
export function feedToPublicMap(feed: readonly RaidFeedView[]): RaidPublicMap {
  const out: RaidPublicMap = {};
  for (const v of feed) {
    out[`@${v.founder}@${v.limit}`] = {
      tl: null,
      rarity: v.rarity,
      stage: v.stage,
      mons: null,
      states: v.states ?? [],
      seenAt: v.seenAt,
      statesAt: v.statesAt ?? null,
      limit: v.limit,
      founder: v.founder,
      // stage 還沒人看到時，後台用 ulrmap 查到的碎片（SUPPORT 列與自己清單都靠它畫）
      fragment: v.fragment ?? null,
    };
  }
  return out;
}

function parseFeed(body: unknown): RaidFeedView[] {
  const raids = (body as { raids?: unknown } | null)?.raids;
  if (!Array.isArray(raids)) return [];
  return (raids as RaidFeedView[]).filter(
    (v) =>
      v !== null &&
      typeof v === "object" &&
      typeof v.founder === "string" &&
      typeof v.foundAt === "number" &&
      typeof v.limit === "number",
  );
}

export interface RaidFeedSyncResult {
  map: RaidPublicMap;
  /** 這一輪傳了幾筆 SUPPORT／幾筆自己清單 */
  support: number;
  own: number;
}

/**
 * 一輪同步。記著上一次成功傳出去的 SUPPORT 清單，同一份（玩家沒再打開 SUPPORT）不重傳。
 */
export class RaidFeedSync {
  #lastSupport: string | null = null;
  /** 傳成功過的公開（發現者＋發現時刻） */
  #sentPublished = new Set<string>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly url: string = DEFAULT_RAID_FEED_URL,
    private readonly timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
  ) {}

  /**
   * `upload` 關著（玩家關掉互傳）就只讀不傳。
   */
  async sync(
    support: readonly RaidSupportRow[],
    own: readonly RaidSnapshotRow[],
    upload: boolean,
    published: readonly RaidPublishedRow[] = [],
  ): Promise<RaidFeedSyncResult> {
    let sentSupport = 0;
    let sentOwn = 0;
    // 自己按送出公開的：傳過的不再傳
    const fresh = upload
      ? published.filter((r) => !this.#sentPublished.has(feedKey(r.founder, r.foundAt)))
      : [];
    if (fresh.length > 0 && (await this.#post("publish", publishedToFeed(fresh)))) {
      for (const r of fresh) this.#sentPublished.add(feedKey(r.founder, r.foundAt));
      sentSupport += fresh.length;
    }
    const get = async () => {
      const body = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(this.url, { signal }),
      );
      return body === null ? null : parseFeed(body);
    };
    let fetched = await get();
    if (upload && support.length > 0) {
      const sig = JSON.stringify(support);
      if (sig !== this.#lastSupport) {
        // 整份 SUPPORT 裡沒有的渦，雲端會當作打倒。附上自己清單上還活著、帳本上已經有的渦
        // （不確定 SUPPORT 會不會藏掉自己加入的渦）；GET 失敗不知道帳本上有什麼，就不說是整份
        const inFeed = new Set((fetched ?? []).map((v) => feedKey(v.founder, v.foundAt)));
        const present = ownToFeed(own)
          .filter((r) => !(r.hp !== null && r.hp <= 0) && inFeed.has(feedKey(r.founder, r.foundAt)))
          .map((r) => ({ founder: r.founder, foundAt: r.foundAt }));
        const complete = fetched !== null && support.length <= MAX_RAID_FEED_PER_POST;
        if (await this.#post("support", supportToFeed(support), { complete, present })) {
          this.#lastSupport = sig;
          sentSupport = support.length;
          // 新渦進帳本了，再讀一次，自己清單才補得到它們
          fetched = (await get()) ?? fetched;
        }
      }
    }
    const feed = fetched ?? [];
    if (upload) {
      const fill = pickOwnToFill(ownToFeed(own), feed);
      if (fill.length > 0 && (await this.#post("own", fill))) sentOwn = fill.length;
    }
    return { map: feedToPublicMap(feed), support: sentSupport, own: sentOwn };
  }

  /** 分批 POST；全部成功才算成功。`extra` 只跟第一批送（分批了就不是整份）。 */
  async #post(
    source: RaidFeedSource,
    raids: readonly RaidFeedIn[],
    extra: { complete?: boolean; present?: { founder: string; foundAt: number }[] } = {},
  ): Promise<boolean> {
    for (let i = 0; i < raids.length; i += MAX_RAID_FEED_PER_POST) {
      const body = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(this.url, {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source,
            raids: raids.slice(i, i + MAX_RAID_FEED_PER_POST),
            ...(i === 0 ? extra : {}),
          }),
        }),
      );
      if (typeof (body as { accepted?: unknown } | null)?.accepted !== "number") return false;
    }
    return true;
  }
}
