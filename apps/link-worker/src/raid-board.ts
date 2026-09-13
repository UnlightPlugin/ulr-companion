/**
 * 共享渦狀態的看板 = 一個 Durable Object
 * ======================================
 * 規則全在 `@ulr/arbiter-link/raid-share`（驗證、合併、到期），這裡只做膠水：
 * 讀 body、限流、交給 `RaidBoard`、回 JSON。
 *
 * ## 為什麼全世界只有一個實例
 *
 * 看板要回答的是「這把 key 有沒有人傳過」—— 上傳與查詢必須落在同一份記憶體。
 * 用 key 分片的話一次 GET 問 12 把 key 就是 12 次 DO 往返；量級（幾十到幾百個
 * 插件、每 30 秒一次）一個實例綽綽有餘。真的撐不住時再按 key 的第一個字元分 16 片。
 *
 * ## ⚠ 渦狀態不寫 storage，隊伍要寫
 *
 * 渦狀態（`/raids`）見 `RaidBoard` 的註解：幾分鐘就過期，被移出記憶體時整份丟掉只是
 * 空一下，下一個插件傳上來就補回來了。
 *
 * 隊伍（`/raid-teams`）不一樣：它的價值在**分享的人不在線的時候**—— 新手晚上才來查，
 * 白天打過的人早就下線了。只放記憶體的話，看板一被回收（沒有請求一陣子就會）那些隊伍
 * 就沒了，要等那個人再進渦房才補得回來。所以：
 *
 * ```
 *   POST  內容真的變了才寫（upsertChanges）：同一份每 30 秒重傳不會每次寫
 *   GET   這把渦 key 這次開機還沒讀過 → 先從 storage 讀回來（hydrate），之後不再讀
 *   alarm 每 6 小時掃一次，刪掉渦已經到期的（渦最長一天，storage 不會一直長）
 * ```
 *
 * 寫入量只跟「打完一場」有關，幾十個玩家一天也是幾百次，遠在免費額度內。
 */

import { DurableObject } from "cloudflare:workers";
import {
  MAX_RAID_SHARE_BODY_BYTES,
  MAX_RAID_TEAMS_BODY_BYTES,
  normalizeRaidUpload,
  normalizeTeamsUpload,
  parseRaidShareKeys,
  RAID_TEAMS_PATH,
  RaidBoard,
  RaidTeamBoard,
  type SharedTeam,
  type SharedTeamsUpload,
} from "@ulr/arbiter-link/raid-share";
import { TokenBucket } from "./guard.js";

/** 同一個來源 IP：最多連傳 10 次，之後每 3 秒補 1 次（正常插件 30 秒傳一次）。 */
const POST_BUCKET_CAPACITY = 10;
const POST_REFILL_PER_SECOND = 1 / 3;
/** 令牌桶表的上限。超過就整張清掉 —— 寧可短暫放寬，不要讓記憶體無限長。 */
const MAX_BUCKETS = 10_000;

/** storage 裡隊伍的鍵：`t:<渦 key>:<玩家 key>`。 */
const TEAM_PREFIX = "t:";
/** 多久掃一次到期的隊伍。 */
const TEAM_PURGE_MS = 6 * 60 * 60 * 1000;

interface StoredTeams {
  limit: number;
  seenAt: number;
  teams: SharedTeam[];
}

export class RaidBoardRoom extends DurableObject {
  #board = new RaidBoard();
  /** 打渦隊伍（`/raid-teams`）。同一個實例、同一組令牌桶：一輪上傳是渦＋隊伍兩次 POST。 */
  #teams = new RaidTeamBoard();
  /** 這次開機已經從 storage 讀過的渦 key。 */
  #loaded = new Set<string>();
  #buckets = new Map<string, TokenBucket>();

  /** 還沒讀過的渦 key 先從 storage 讀回來。 */
  async #loadTeams(keys: readonly string[], now: number): Promise<void> {
    for (const key of keys) {
      if (this.#loaded.has(key)) continue;
      this.#loaded.add(key);
      const rows = await this.ctx.storage.list<StoredTeams>({ prefix: `${TEAM_PREFIX}${key}:` });
      const alive: (SharedTeamsUpload & { seenAt: number })[] = [];
      const expired: string[] = [];
      for (const [id, v] of rows) {
        if (v.limit <= now) expired.push(id);
        else alive.push({ key, player: id.slice(TEAM_PREFIX.length + key.length + 1), ...v });
      }
      if (expired.length > 0) await this.ctx.storage.delete(expired);
      this.#teams.hydrate(alive, now);
    }
  }

  async #saveTeams(changed: readonly SharedTeamsUpload[], now: number): Promise<void> {
    if (changed.length === 0) return;
    const puts: Record<string, StoredTeams> = {};
    const dels: string[] = [];
    for (const e of changed) {
      const id = `${TEAM_PREFIX}${e.key}:${e.player}`;
      if (e.teams.length === 0) dels.push(id);
      else puts[id] = { limit: e.limit, seenAt: now, teams: e.teams };
    }
    if (Object.keys(puts).length > 0) await this.ctx.storage.put(puts);
    if (dels.length > 0) await this.ctx.storage.delete(dels);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + TEAM_PURGE_MS);
    }
  }

  /** 刪掉渦已經到期的隊伍；還有剩就再排一次。 */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const rows = await this.ctx.storage.list<StoredTeams>({ prefix: TEAM_PREFIX });
    const expired: string[] = [];
    for (const [id, v] of rows) if (v.limit <= now) expired.push(id);
    // storage.delete 一次最多 1000 把
    for (let i = 0; i < expired.length; i += 1000) {
      await this.ctx.storage.delete(expired.slice(i, i + 1000));
    }
    if (rows.size > expired.length) await this.ctx.storage.setAlarm(now + TEAM_PURGE_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const teams = url.pathname === RAID_TEAMS_PATH;

    if (request.method === "GET") {
      const keys = parseRaidShareKeys(url);
      if (keys === null) return new Response("bad keys", { status: 400 });
      if (teams) await this.#loadTeams(keys, now);
      return Response.json(
        teams
          ? { raids: this.#teams.lookup(keys, now), now }
          : { raids: this.#board.lookup(keys, now), now },
        // ⚠ 不快取：狀態的全部價值就是它是現在的。
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (request.method === "POST") {
      // ⚠ **先把 body 讀完再決定要不要擋。** 入口 Worker 是把 request 串流轉過來的，
      // 這裡沒讀就先回 429 的話，轉送那一端還在寫 body —— workerd 實測當場丟例外、
      // 回 500 還把 dev server 弄掛。body 的大小入口那邊已經先用 content-length 擋過。
      const text = await request.text();
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!this.#bucket(ip, now).take(now)) return new Response("too fast", { status: 429 });
      // ⚠ 先量大小再 parse —— 反過來的話大的那一份已經被 JSON.parse 過了。
      const limit = teams ? MAX_RAID_TEAMS_BODY_BYTES : MAX_RAID_SHARE_BODY_BYTES;
      if (new TextEncoder().encode(text).length > limit) {
        return new Response("too big", { status: 413 });
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (teams) {
        const entries = normalizeTeamsUpload(body, now);
        if (entries === null) return new Response("bad body", { status: 400 });
        await this.#saveTeams(this.#teams.upsertChanges(entries, now), now);
        return Response.json(
          { accepted: entries.length },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const list = normalizeRaidUpload(body, now);
      if (list === null) return new Response("bad body", { status: 400 });
      const accepted = this.#board.upsert(list, now);
      return Response.json({ accepted }, { headers: { "cache-control": "no-store" } });
    }

    await request.text();
    return new Response("method not allowed", { status: 405 });
  }

  #bucket(ip: string, now: number): TokenBucket {
    let b = this.#buckets.get(ip);
    if (b === undefined) {
      if (this.#buckets.size >= MAX_BUCKETS) this.#buckets.clear();
      b = new TokenBucket(POST_BUCKET_CAPACITY, POST_REFILL_PER_SECOND, now);
      this.#buckets.set(ip, b);
    }
    return b;
  }
}
