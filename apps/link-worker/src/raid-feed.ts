/**
 * 公開渦通知 = 一個 Durable Object
 * ================================
 * 規則全在 `@ulr/arbiter-link/raid-feed`（驗證、合併、碎片、文字、帳本），這裡只做膠水：
 * 讀 body、限流、存 storage、排 alarm、打 Discord webhook。設計見 `docs/raid-feed.md`。
 *
 * ## 為什麼全世界只有一個實例
 *
 * 「這個渦是不是新的」要在同一份記憶體裡回答，Discord 的一批也要從同一份湊。
 * 量級（SUPPORT 偶爾開一次、渦房裡每 30 秒一次）一個實例綽綽有餘。
 *
 * ## ⚠ 寫 storage，但只寫會變的東西
 *
 * Discord 訊息 id 要撐過 DO 被回收（不然碎片知道了改不了訊息、或同一個渦再發一次）。
 * 帳本只回報「新增、★／stage／到期時刻變了、訊息」要寫；HP 每 30 秒在變，只放記憶體。
 *
 * ```
 *   POST support 帶來新渦 → 存、排 alarm 在第一個新渦＋30 秒
 *   alarm → 該發的那批發出去（?wait=true 拿 message id）→ 存
 *         → 碎片剛知道的訊息整則重畫（改訊息不 ping）
 *         → 刪到期的、再排下一次
 * ```
 *
 * Discord 設定：`DISCORD_WEBHOOK_URL` 用 `wrangler secret put`，`DISCORD_RAID4_ROLE_ID` 放 vars。
 * 沒設 webhook 時照樣收資料、給讀，只是不發。
 */

import { DurableObject } from "cloudflare:workers";
import {
  formatRaidFeedBatch,
  MAX_RAID_FEED_BODY_BYTES,
  normalizeRaidFeedUpload,
  parseRewardLookup,
  RAID_REWARD_LOOKUP_URL,
  RAID_FEED_MAX_ATTEMPTS,
  RaidFeedBook,
  raidFeedId,
  raidFeedTierOf,
  type RaidFeedChanges,
  type RaidFeedEntry,
  type RaidFeedMessage,
  type RewardLookupKey,
} from "@ulr/arbiter-link/raid-feed";
import { TokenBucket } from "./guard.js";

export interface RaidFeedEnv {
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_RAID4_ROLE_ID?: string;
}

/** 同一個來源 IP：最多連傳 10 次，之後每 3 秒補 1 次（正常插件 30 秒傳一次）。 */
const POST_BUCKET_CAPACITY = 10;
const POST_REFILL_PER_SECOND = 1 / 3;
const MAX_BUCKETS = 10_000;

const RAID_PREFIX = "r:";
const MESSAGE_PREFIX = "m:";

/** Discord 發不出去時多久後再試。 */
const RETRY_MS = 60_000;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export class RaidFeedRoom extends DurableObject<RaidFeedEnv> {
  #book: RaidFeedBook | null = null;
  #buckets = new Map<string, TokenBucket>();
  /** 這一批連續發失敗幾次（只放記憶體：DO 被回收就從頭算，最多多試幾次） */
  #attempts = 0;

  async #load(): Promise<RaidFeedBook> {
    if (this.#book !== null) return this.#book;
    const raids = await this.ctx.storage.list<RaidFeedEntry>({ prefix: RAID_PREFIX });
    const messages = await this.ctx.storage.list<RaidFeedMessage>({ prefix: MESSAGE_PREFIX });
    this.#book = new RaidFeedBook([...raids.values()], [...messages.values()]);
    return this.#book;
  }

  async #save(book: RaidFeedBook, changes: RaidFeedChanges): Promise<void> {
    const puts: Record<string, RaidFeedEntry | RaidFeedMessage> = {};
    for (const id of changes.raids) {
      const r = book.raid(id);
      if (r !== undefined) puts[`${RAID_PREFIX}${id}`] = r;
    }
    for (const id of changes.messages) {
      const m = book.message(id);
      if (m !== undefined) puts[`${MESSAGE_PREFIX}${id}`] = m;
    }
    // storage.put 一次最多 128 把
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 128) {
      await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
  }

  /** 照帳本排下一次 alarm；已經排了更早的就不動。 */
  async #schedule(book: RaidFeedBook, now: number): Promise<void> {
    const next = book.nextWake(now);
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(Math.max(next, now));
  }

  #roleId(): string | null {
    const id = (this.env.DISCORD_RAID4_ROLE_ID ?? "").trim();
    return /^\d+$/.test(id) ? id : null;
  }

  override async alarm(): Promise<void> {
    const book = await this.#load();
    const now = Date.now();
    const webhook = (this.env.DISCORD_WEBHOOK_URL ?? "").trim();
    const role = this.#roleId();

    // 先查 ulrmap 獎勵表：這一批還沒發的話，發出去的那一行直接帶碎片
    const asked = book.needsLookup(now);
    if (asked.length > 0) {
      const found = parseRewardLookup(await lookupRewards(asked));
      await this.#save(book, book.applyLookup(asked, found, now));
    }

    const batch = book.dueBatch(now);
    // ⚠ 只印「有沒有設」，不印 webhook 本身
    console.log(
      `raid-feed: alarm 一批 ${batch.length} 個，webhook ${webhook === "" ? "沒設" : "有設"}`,
    );
    if (batch.length > 0) {
      const ids = batch.map(raidFeedId);
      const mention = role !== null && batch.some((r) => raidFeedTierOf(r) === "IV");
      const messageId =
        webhook === ""
          ? null
          : await postDiscord(
              webhook,
              formatRaidFeedBatch(batch, mention ? role : null, now),
              mention && role !== null ? [role] : [],
            );
      if (messageId !== null) {
        this.#attempts = 0;
        const m = book.markPosted(ids, messageId, mention, now);
        await this.#save(book, { raids: ids, messages: [m.id] });
      } else if (webhook === "" || ++this.#attempts >= RAID_FEED_MAX_ATTEMPTS) {
        // 沒設 webhook、或試了幾次都不行：這一批不發了，免得每次 alarm 都卡在它
        if (webhook !== "") console.log(`raid-feed: Discord 發不出去，放棄 ${ids.length} 個渦`);
        this.#attempts = 0;
        book.markSkipped(ids);
        await this.#save(book, { raids: ids, messages: [] });
      } else {
        await this.ctx.storage.setAlarm(now + RETRY_MS);
        return;
      }
    }

    // 狀態到期的訊息也要重畫（沒人帶新的狀態來，就把過期的拿掉）
    await this.#save(book, book.expireStates(now));
    for (const m of book.dirtyMessages()) {
      const content = book.renderMessage(m, role, now);
      // 改不了（訊息被刪、webhook 換了）就算了：碎片只是少標一個
      if (content !== null && webhook !== "") await editDiscord(webhook, m.id, content);
      book.rendered(m, now);
      await this.#save(book, { raids: [], messages: [m.id] });
    }

    const pruned = book.prune(now);
    const dels = [
      ...pruned.raids.map((id) => `${RAID_PREFIX}${id}`),
      ...pruned.messages.map((id) => `${MESSAGE_PREFIX}${id}`),
    ];
    // storage.delete 一次最多 128 把
    for (let i = 0; i < dels.length; i += 128)
      await this.ctx.storage.delete(dels.slice(i, i + 128));

    await this.#schedule(book, now);
  }

  override async fetch(request: Request): Promise<Response> {
    const now = Date.now();

    if (request.method === "GET") {
      const book = await this.#load();
      return Response.json({ raids: book.list(now), now }, NO_STORE);
    }

    if (request.method === "POST") {
      // ⚠ 先把 body 讀完再決定要不要擋（理由見 raid-board.ts 同一段）。
      const text = await request.text();
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!this.#bucket(ip, now).take(now)) return new Response("too fast", { status: 429 });
      if (new TextEncoder().encode(text).length > MAX_RAID_FEED_BODY_BYTES) {
        return new Response("too big", { status: 413 });
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const upload = normalizeRaidFeedUpload(body, now);
      if (upload === null) return new Response("bad body", { status: 400 });
      const book = await this.#load();
      await this.#save(book, book.ingest(upload, now));
      await this.#schedule(book, now);
      return Response.json({ accepted: upload.raids.length }, NO_STORE);
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

/** 發一則；成功回 message id，失敗回 null。只允許 mention 指定的 role。 */
async function postDiscord(
  webhook: string,
  content: string,
  roles: string[],
): Promise<string | null> {
  try {
    const url = new URL(webhook);
    url.searchParams.set("wait", "true");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [], roles } }),
    });
    if (!res.ok) {
      console.log(`raid-feed: Discord POST ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch (e) {
    console.log(`raid-feed: Discord POST 失敗 ${e instanceof Error ? e.name : "?"}`);
    return null;
  }
}

/** 改一則。⚠ 不 mention 任何人：改訊息不能再 ping 一次。 */
async function editDiscord(webhook: string, messageId: string, content: string): Promise<void> {
  try {
    const url = new URL(webhook);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/messages/${messageId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [], roles: [] } }),
    });
    if (!res.ok) console.log(`raid-feed: Discord PATCH ${res.status}`);
  } catch (e) {
    console.log(`raid-feed: Discord PATCH 失敗 ${e instanceof Error ? e.name : "?"}`);
  }
}

/** 查 ulrmap 獎勵表；失敗回 null（帳本會記成這次沒查到，過一陣子再查）。 */
async function lookupRewards(keys: readonly RewardLookupKey[]): Promise<unknown> {
  try {
    const res = await fetch(RAID_REWARD_LOOKUP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(keys),
    });
    if (!res.ok) {
      console.log(`raid-feed: ulrmap ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.log(`raid-feed: ulrmap 失敗 ${e instanceof Error ? e.name : "?"}`);
    return null;
  }
}
