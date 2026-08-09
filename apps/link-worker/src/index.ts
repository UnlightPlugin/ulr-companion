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
import { HEALTH_PATH, parseRoomPath, UPDATE_PATH } from "./guard.js";
import { CURRENT_RELEASE } from "./release.js";

export { LinkRoom } from "./room.js";

interface Env {
  ROOMS: DurableObjectNamespace;
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
        // 一小時 —— 跟 `updater.ts` 的檢查間隔同一個量級。發版後最多晚一小時
        // 才會擴散出去，換來的是不必為每個玩家每小時都跑一次 Worker。
        headers: { "cache-control": "public, max-age=3600" },
      });
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
