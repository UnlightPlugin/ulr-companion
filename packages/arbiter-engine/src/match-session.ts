/**
 * 約戰的一次配對（WP-16）
 * ========================
 * 中間人把兩個人配起來之後，這支負責在**遊戲裡**把他們湊進同一間房：
 *
 * ```
 *   host   preflight → createRoom → 等自己那間房出現在清單 → 交出 room_id
 *   guest  preflight → 等那間房出現在清單 → joinRoom
 *                                              ↓
 *                                         duel_standby
 * ```
 *
 * 抽出來的理由是**這段沒辦法用測試以外的方式驗**：真的跑一次要兩個帳號、
 * 消耗 AP、而且會把人丟進對戰。所以這裡只依賴一個很窄的介面，測試餵假的。
 *
 * ## 為什麼 preflight 不能省
 *
 * `delete_room` 是**頻道層級**的 —— 它只吃 channel、不吃 room_id。玩家如果
 * 自己手動開了一間房，插件再開一間，之後「取消配對」會把**兩間一起收掉**。
 * 所以開房前一定要先確認玩家沒有自己的房，有的話直接不開。
 * 2026-08-15 實測：按一次取消，兩間一起消失。
 */

import { findOwnRoom } from "@ulr/cdp-adapter";
import type { CreateRoomOptions, MatchContext, RoomEntry } from "@ulr/cdp-adapter";

/** 這支需要遊戲做到的事。真的實作是 `CdpAdapter`，測試餵假的。 */
export interface MatchDriver {
  matchContext(): Promise<MatchContext>;
  /** `live` = 這份是遊戲當下手上的清單（不是等推播來的舊快取）。 */
  roomSnapshot(): Promise<{ seq: number; live: boolean; rooms: RoomEntry[] }>;
  createRoom(
    options: CreateRoomOptions,
  ): Promise<{ ok: true; roomId: string | null } | { ok: false; reason: string; fail?: number }>;
  joinRoom(
    roomId: string,
    pass: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; fail?: number }>;
  cancelRoom(): Promise<string>;
}

export type PreflightBlock =
  | { code: "not-in-match"; message: string }
  | { code: "no-channel"; message: string }
  | { code: "wrong-channel"; message: string }
  | { code: "already-matching"; message: string }
  | { code: "has-own-room"; message: string }
  | { code: "no-room-list"; message: string };

export type PreflightResult =
  { ok: true; context: MatchContext } | { ok: false; block: PreflightBlock };

export interface PreflightOptions {
  /** 約定的頻道。玩家不在這個頻道就不能配 —— 房間清單是分頻道推播的。 */
  expectChannel: number;
}

/**
 * 開房／進房之前的檢查。**唯讀，不改變任何遊戲狀態。**
 *
 * 回傳的 block 是要**直接顯示給玩家**的，所以訊息要講「該怎麼辦」而不是
 * 「哪裡錯了」。
 */
export async function preflight(
  driver: MatchDriver,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const context = await driver.matchContext();

  if (!context.inMatch) {
    return { ok: false, block: { code: "not-in-match", message: "請先回到對戰大廳。" } };
  }
  if (context.channel === null) {
    return { ok: false, block: { code: "no-channel", message: "請先進入一個頻道。" } };
  }
  if (context.channel !== options.expectChannel) {
    return {
      ok: false,
      block: {
        code: "wrong-channel",
        message: `你在頻道 ${context.channel}，約定的是頻道 ${options.expectChannel}。請換到同一個頻道。`,
      },
    };
  }
  if (context.isMatching) {
    return {
      ok: false,
      block: { code: "already-matching", message: "你已經在配對中了，請先在遊戲裡取消。" },
    };
  }

  const snapshot = await driver.roomSnapshot();
  // ⚠ 空清單有兩種意思：「這個頻道沒有房」跟「我還不知道」。分不出來就會在
  // 後者上判定「玩家沒有自己的房」，直接踩到 delete_room 是頻道層級的坑。
  //
  // `live` = 讀的是遊戲當下手上那份（channel_panel.match_room_data），那就是
  // 大廳正在畫的東西，空的就是真的空。讀不到 live 才退回推播快取，而推播是
  // **有變動才來**的 —— 一次都沒收到時（seq 0）只能說「還不知道」。
  if (!snapshot.live && snapshot.seq === 0) {
    return {
      ok: false,
      block: { code: "no-room-list", message: "還讀不到房間清單，請回大廳的頻道畫面再試。" },
    };
  }
  if (context.playerName !== null) {
    const own = snapshot.rooms.filter((r) => r.playerAName === context.playerName);
    if (own.length > 0) {
      return {
        ok: false,
        block: {
          code: "has-own-room",
          message:
            "你已經有一間自己開的房了。請先在遊戲裡收掉 —— " +
            "插件的「取消配對」會連你手動開的那間一起收掉（那個指令是整個頻道一起收的）。",
        },
      };
    }
  }
  return { ok: true, context };
}

// ---------------------------------------------------------------------------

/**
 * 兩邊的條件對不對得起來。中間人只保證配對鍵相同，**頻道要再對一次** ——
 * 鍵相同代表雙方「宣稱」的頻道相同，不代表他們此刻真的都還在那裡（有人
 * 可能在排隊途中換了頻道）。
 */
export function channelsAgree(mine: MatchContext, theirChannel: number): boolean {
  return mine.channel !== null && mine.channel === theirChannel;
}

// ---------------------------------------------------------------------------
// host：開房並找出 room_id
// ---------------------------------------------------------------------------

/** 等待用。測試餵一個立刻回來的版本，不然一個 case 要跑 20 秒。 */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 兩邊等房間清單的節奏。
 *
 * ⚠⚠ **這個數字直接就是玩家感覺到的「按下去多久才開打」。** 從按鈕到進房的
 * 時間幾乎全部花在這裡：host 等自己那間房出現、guest 等同一間房出現在他的
 * 清單裡，兩段各等一次。原本是 1000ms，於是最好的情況也要兩秒起跳。
 *
 * 調得動的理由是 `roomSnapshot()` **是一次本機 CDP 讀取**（讀客戶端自己收下來
 * 的那份清單），不是一個伺服器請求 —— 問得密一點不會多產生任何流量，只是多幾次
 * 幾毫秒的往返。真正決定快慢的是伺服器什麼時候把清單推下來，我們只是別在它
 * 推下來之後還睡著。
 *
 * ⚠ `attempts × intervalMs` 是**總等待上限**，兩個一起改才不會把它縮短：
 * 300 × 40 = 12 秒，跟原本的 1000 × 20 = 20 秒同一個量級，而閒置時房間清單
 * 45 秒才推一次的情況本來就是靠開房自己觸發那一次推播（見上面那段註解）。
 */
const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_ATTEMPTS = 40;

export interface HostOptions {
  room: CreateRoomOptions;
  /** 房名。找自己那間房要靠它，所以必須跟 `room.name` 一致。 */
  playerName: string;
  /**
   * 最多等幾次推播輪詢。⚠ 閒置時房間清單**約 20 秒才推一次**（2026-08-15 實測），
   * 但開房本身會立刻觸發一次，所以正常情況 1~2 秒就找得到。
   */
  attempts?: number;
  intervalMs?: number;
  sleep?: Sleep;
}

export type HostResult =
  { ok: true; roomId: string } | { ok: false; reason: string; fail?: number; needsCancel: boolean };

/**
 * 開房，然後等自己那間房出現在清單裡，把 room_id 交出來。
 *
 * ⚠ **一定要等序號變大才採信清單。** 用開房前的快取會找到玩家上一場的房，
 * 於是把**上一場的 room_id** 交給對手 —— 伺服器會正確地回 `fail:9`
 * （那間房早就配對過了），而錯誤訊息看起來完全像是別的問題。2026-08-15 踩過。
 *
 * `needsCancel` = 房已經開起來了但沒拿到 room_id，呼叫端**必須**收房，
 * 否則清單上會留一間永遠不會有人進來的空房。
 */
export async function hostOpenRoom(driver: MatchDriver, options: HostOptions): Promise<HostResult> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    sleep = realSleep,
  } = options;

  const before = await driver.roomSnapshot();
  const created = await driver.createRoom(options.room);
  if (!created.ok) {
    // ⚠ `fail` 是 optional，不能塞 undefined（exactOptionalPropertyTypes）。
    return created.fail === undefined
      ? { ok: false, reason: created.reason, needsCancel: false }
      : { ok: false, reason: created.reason, fail: created.fail, needsCancel: false };
  }

  // ⚠ 開房**之前**清單上有哪些房。要靠它認出「這間是新的」——
  // 原本是比對推播序號，但房間清單是「有變動才推」而不是定時推
  // （2026-08-15 實測：沒人開關房時 45 秒一次都收不到），序號守衛會讓
  // 正常流程整個卡住。比對 room_id 不依賴推播時機，而且更直接。
  const beforeIds = new Set(before.rooms.map((r) => r.roomId));

  for (let i = 0; i < attempts; i++) {
    // ⚠ **先看再睡。** 原本是先 `sleep(1000)`，於是開房到交出 room_id 之間
    // **一定**多一秒，即使推播早就到了 —— 而那一秒兩邊都在乾等（對手要等我們
    // 送 `q-room` 才動得了）。`roomSnapshot()` 是一次本機 CDP 讀取，不打伺服器，
    // 先看一眼不花任何東西。
    if (i > 0) await sleep(intervalMs);
    const snapshot = await driver.roomSnapshot();
    const fresh = snapshot.rooms.filter((r) => !beforeIds.has(r.roomId));
    const own = findOwnRoom(fresh, options.playerName, options.room.name);
    if (own === null) continue;
    if (!own.pass) {
      // 房沒鎖 = 密碼沒生效 = 任何人都進得來。這種房不能拿去配對。
      return { ok: false, reason: "開出來的房沒有密碼保護", needsCancel: true };
    }
    return { ok: true, roomId: own.roomId };
  }
  return { ok: false, reason: "等不到自己那間房出現在清單裡", needsCancel: true };
}

// ---------------------------------------------------------------------------
// guest：等房出現然後進去
// ---------------------------------------------------------------------------

export interface GuestOptions {
  roomId: string;
  pass: string;
  attempts?: number;
  intervalMs?: number;
  sleep?: Sleep;
}

export type GuestResult = { ok: true } | { ok: false; reason: string; fail?: number };

/**
 * 等 host 那間房出現在自己的清單裡，然後進去。
 *
 * ⚠ 要等它出現，不能直接進 —— guest 的清單是獨立推播的，host 開房的那一刻
 * guest 手上還是舊清單。
 */
export async function guestJoinRoom(
  driver: MatchDriver,
  options: GuestOptions,
): Promise<GuestResult> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    sleep = realSleep,
  } = options;

  for (let i = 0; i < attempts; i++) {
    const snapshot = await driver.roomSnapshot();
    if (snapshot.rooms.some((r) => r.roomId === options.roomId)) {
      return await driver.joinRoom(options.roomId, options.pass);
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: "對方的房間沒有出現在清單裡" };
}
