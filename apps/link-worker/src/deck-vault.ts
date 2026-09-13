/**
 * 雲端牌組庫 = 一個角色一個 Durable Object
 * ========================================
 * 規則全在 `@ulr/arbiter-link/deck-sync`（`decideDeckSync`），這裡只做膠水：
 * 讀 storage、限流、交給它決定、照它說的寫。
 *
 * ## 為什麼一把鍵一個實例（跟渦看板相反）
 *
 * 渦看板要回答「這把 key 有沒有人傳過」，上傳與查詢得落在同一份記憶體，所以全世界
 * 一個。牌組庫沒有跨角色的查詢，每把鍵各自一份 —— 分開的話 `If-Match` 的讀比寫
 * 天然就是原子的（一個 DO 實例一次只跑一個請求的 storage 交易），不必自己上鎖。
 *
 * ## ⚠ 要寫 storage
 *
 * 價值就在「另一台電腦晚一點才開」。只放記憶體的話實例被回收（沒請求一陣子就會）
 * 整份庫就沒了 —— 那比沒有同步更糟：另一台會拿到 404，把自己那份當成唯一的真相。
 */

import { DurableObject } from "cloudflare:workers";
import { decideDeckSync, type DeckSyncRecord } from "@ulr/arbiter-link/deck-sync";
import { TokenBucket } from "./guard.js";

/** 同一個角色：最多連寫 10 次，之後每 6 秒補 1 次（插件平常幾分鐘才寫一次）。 */
const BUCKET_CAPACITY = 10;
const REFILL_PER_SECOND = 1 / 6;

const RECORD_KEY = "record";

export class DeckVaultRoom extends DurableObject {
  #bucket = new TokenBucket(BUCKET_CAPACITY, REFILL_PER_SECOND, Date.now());

  override async fetch(request: Request): Promise<Response> {
    // ⚠ 先把 body 讀完再決定要不要擋 —— 理由同 raid-board.ts（轉送端還在寫就回的話
    // workerd 會丟例外）。
    const text = await request.text();
    if (request.method !== "GET" && !this.#bucket.take(Date.now())) {
      return new Response("too fast", { status: 429 });
    }
    const current = (await this.ctx.storage.get<DeckSyncRecord>(RECORD_KEY)) ?? null;
    const decision = decideDeckSync(request.method, request.headers, text, current);
    if (decision.write !== null) await this.ctx.storage.put(RECORD_KEY, decision.write);

    const headers: Record<string, string> = { "cache-control": "no-store" };
    const version = decision.write?.version ?? current?.version;
    if (version !== undefined) headers["etag"] = `"${version}"`;
    if (decision.body === null) return new Response(null, { status: decision.status, headers });
    return Response.json(decision.body, { status: decision.status, headers });
  }
}
