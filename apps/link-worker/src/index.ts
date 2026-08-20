/**
 * 雲端中間人的入口（階段 2）
 * ============================
 * 這一支只做**路由**：看網址、驗房號、把連線交給對應的 Durable Object。
 * 一行協定邏輯都沒有 —— 那些在 `room.ts`（膠水）與 `@ulr/arbiter-link`（規則）。
 *
 * ```
 *   插件 A ─┐                                     ┌─ LinkRoom（房號 abc…）
 *           ├─ wss://…/r/<房號> ─▶ 這支 Worker ──┤
 *   插件 B ─┘                                     └─ LinkRoom（房號 def…）
 * ```
 *
 * ⚠ **Worker 本身是無狀態的。** 每個請求可能落在世界上任何一台機器，記憶體
 * 不共用 —— 所以「A 連進來了，等 B」這件事它記不住。`getByName(房號)` 是
 * 整個設計的關鍵：同一個房號，全世界一定拿到**同一個** DO 實例，兩條連線
 * 因此落在同一份記憶體裡。這就是配對成立的全部原理。
 *
 * ## 為什麼不需要知道誰是誰
 *
 * 中間人**沒有任何身分概念**，也刻意不要有。它要回答的問題只有一個：
 * 「這兩條連線在不在同一場」，而房號已經回答了。至於誰是先手誰是後手，
 * 那是客戶端自己從遊戲讀到的（`cdp-adapter` 的 seat），中間人不需要，
 * 協商規則（max／min／and）也對稱到根本分不出誰是誰。
 */

import { LINK_PROTOCOL_VERSION } from "@ulr/arbiter-link/protocol";
import {
  COUNT_PATH,
  COUNT_SUFFIX,
  COUNT_TAG_PARAM,
  HEALTH_PATH,
  parseCountKeys,
  parseCountTags,
  parseQueuePath,
  parseRoomPath,
  RULES_PATH,
  UPDATE_PATH,
} from "./guard.js";
import { CURRENT_RELEASE } from "./release.js";
import { CURRENT_RULE_SET } from "./rules.js";

export { LinkRoom } from "./room.js";
export { MatchQueueRoom } from "./queue.js";

interface Env {
  ROOMS: DurableObjectNamespace;
  QUEUES: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // uptime 監控與客戶端連線前的版本探詢都打這裡。
    // ⚠ **不回任何跟房間有關的東西**（幾間房、幾個人在線）—— 那是可以拿來
    // 推測「現在有誰在打」的資訊，而這個服務的立場是它什麼都不知道。
    if (url.pathname === HEALTH_PATH) {
      return Response.json({ ok: true, protocol: LINK_PROTOCOL_VERSION });
    }

    // 自動更新的發布清單。**這條路由是純讀取、沒有狀態**，跟中間人完全無關 ——
    // 放在同一個 Worker 只是因為玩家的插件本來就認得這個網址（見 `target.ts`
    // 的 `SERVICE_ORIGIN`），省掉一個要另外維護的網域。
    if (url.pathname === UPDATE_PATH) {
      // ⚠ 還沒發過版就回 404。回一份空的清單會讓客戶端每小時判定一次「有新版」。
      if (CURRENT_RELEASE === null) return new Response("no release", { status: 404 });
      return Response.json(CURRENT_RELEASE, {
        // ⚠⚠ **不要快取。** 這裡原本是 `public, max-age=3600`，看起來很合理
        // （客戶端本來就一小時才問一次），實際上造成兩個問題：
        //
        //   1. 發版之後最久一小時才擴散得出去 —— 而發版最常見的理由正是
        //      「上一版有問題要趕快換掉」
        //   2. **同一時間不同客戶端會拿到不同版本的清單**（各邊緣節點的快取
        //      不同步）。2026-08-09 實測：curl 拿到 0.2.1，同一秒另一個
        //      client 拿到已經被撤掉的 0.2.0，然後對著一個已刪除的資產下載。
        //
        // 這個端點的全部價值就是「它會變」，替它加快取是自相矛盾。量也不是
        // 問題：幾百個玩家每小時問一次，一天幾千個請求，免費額度的零頭。
        headers: { "cache-control": "no-store" },
      });
    }

    // 預設 COST 表。跟 `/update` 一樣是**純讀取、沒有狀態**的路由，放在同一台
    // 只是因為玩家的插件本來就認得這個網域。
    if (url.pathname === RULES_PATH) {
      if (CURRENT_RULE_SET === null) return new Response("no rule set", { status: 404 });
      return Response.json(CURRENT_RULE_SET, {
        // ⚠ **不要快取**，理由跟 `/update` 一模一樣：這個端點的全部價值就是
        // 「它會變」，而各邊緣節點的快取不同步會讓**同一時間不同玩家拿到不同
        // 版本的規則** —— 那正是配對驗算會擋下來、畫面上卻看不出原因的狀況。
        headers: { "cache-control": "no-store" },
      });
    }

    /**
     * 各檔的等待人數（WP-17）。插件在迪特赫姆的大廳上畫「COST54:N 位玩家
     * 等待中」要用它 —— 那是亞歷山卓城本來就有、duel 頻道沒有的東西。
     *
     * ⚠ 為什麼一個請求問多把鍵：玩家坐在大廳時這條路由會被定期問到，而
     * 一檔一個請求等於把量乘以四。四條佇列在這裡是四次 DO 往返，但對免費
     * 額度而言**只算一個 Worker 請求**。
     */
    if (url.pathname === COUNT_PATH) {
      const keys = parseCountKeys(url);
      if (keys === null) return new Response("bad keys", { status: 400 });
      // ⚠ 格式不對（含數量對不上）要回 400，不能「當成沒帶」—— 後者會安靜地
      // 回一個比較大的數字，症狀是「人數有時候對有時候不對」，而那查不出來。
      const tags = parseCountTags(url, keys.length);
      if (tags === null) return new Response("bad tag", { status: 400 });
      const counts = await Promise.all(
        keys.map(async (key, i) => {
          // ⚠ 第 i 個標籤配第 i 把鍵 —— 標籤是拌過配對鍵的，四個檔位不共用。
          const tag = tags?.[i];
          const query = tag === undefined ? "" : `?${COUNT_TAG_PARAM}=${tag}`;
          try {
            const res = await env.QUEUES.getByName(key).fetch(
              `https://queue.invalid/${key}${COUNT_SUFFIX}${query}`,
            );
            const body = (await res.json()) as { waiting?: unknown };
            return typeof body.waiting === "number" ? body.waiting : 0;
          } catch {
            // 問不到就當 0。**這條路由永遠不該讓大廳畫面壞掉** —— 它只是
            // 一個數字，而拿不到數字時畫面那邊自己會退回「不顯示」。
            return 0;
          }
        }),
      );
      return Response.json(
        { counts: keys.map((key, i) => ({ key, waiting: counts[i] ?? 0 })) },
        // ⚠ 不快取：人數的全部價值就是它是現在的。
        { headers: { "cache-control": "no-store" } },
      );
    }

    // 約戰配對佇列（WP-16）。跟房間走同一套驗證與同一個模式，只是換一個
    // namespace —— 一條佇列 = 一個配對鍵 = 一個 DO 實例。
    const queue = parseQueuePath(url.pathname);
    if (queue !== null) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.QUEUES.getByName(queue).fetch(request);
    }

    const room = parseRoomPath(url.pathname);
    if (room === null) return new Response("not found", { status: 404 });

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // `getByName(房號)` = 「取名字叫這個的那個物件」。它其實是
    // `idFromName()` + `get()` 的縮寫，而 `idFromName` 是純粹的雜湊 ——
    // 不查表、不需要協調，所以世界另一端的那個人算出來的是同一個 id。
    return env.ROOMS.getByName(room).fetch(request);
  },
} satisfies ExportedHandler<Env>;
