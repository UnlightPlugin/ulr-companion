/**
 * 中間人協定（WP-15）
 * =====================
 * 兩個插件之間唯一會交換的東西。**沒有任何 I/O** —— 型別、協商規則、
 * 序列化與驗證。傳輸層（本機 WebSocket、之後的 Cloudflare Workers +
 * Durable Objects）換掉的時候，這個檔案一個字都不用動。
 *
 * 為什麼要先把協定獨立出來：ulgg 作者還沒回覆網站支不支援 WebSocket，
 * 而 `docs/battle-features.md` 的計畫是「先用 localhost 串兩個插件把協定驗完，
 * 協定不變再換傳輸層」。把協定寫成純函式，那個「不變」才有東西保證 ——
 * 現在就能對它寫測試，而不是等伺服器蓋好才發現語意有洞。
 *
 * ⚠ 三條紅線，每一條都有測試釘住：
 *
 * 1. **只發合成訊號。** 中間人**從不**單獨告訴任何一方「對手準備好了」，
 *    只在**兩邊都好**的時候發一則 `both-ready`。遊戲協定本身從不下發對手的
 *    OK 狀態（`constants.ts` 的 `OK_STATE_EVENTS`），這條性質原本是伺服器
 *    保證的；接了側通道之後它降級成**我們的設計選擇**，所以必須釘住。
 * 2. **協商一律取「對雙方都不更嚴格」的那一邊。** 秒數取 `max`、縮減取 `min`、
 *    開關取 `and`。任何一方都不可能被強加自己沒同意的限制。
 * 3. **房號永遠是雜湊過的。** 原始 room id 是 32 字元的高熵字串（§12 的
 *    `VALUE_MAX_STRING_LENGTH` 正是為了擋這類東西），而中間人只需要「兩個人
 *    在不在同一場」，不需要知道那場是哪一場。之後換成 ulgg 的雲端伺服器時，
 *    這條讓「伺服器看得到什麼」從信任問題變成數學問題。
 */

import { createHash } from "node:crypto";

/**
 * 協定版本。**不相容就雙方退回單邊模式，不要嘗試相容。**
 *
 * 理由見 `docs/battle-features.md`：仲裁一旦上線，版本不同的後果不是顯示錯誤
 * 而是**勝負** —— 我方 v1（只有硬底線）碰上對手 v2（等雙方就緒），我方會在
 * 對手還沒好時就送出，又回到「先承諾的人被懲罰」，正是這個功能要消除的東西。
 *
 * 單邊模式本來就是安全的預設，退回去不傷害任何人；維護 N×N 相容矩陣不是。
 */
export const LINK_PROTOCOL_VERSION = 1;

/** 移動階段畫面上顯示的總秒數。協商的秒數是「這個階段要多長」，上限就是它。 */
export const MOVE_PHASE_TOTAL_SECONDS = 30;

/**
 * 秒數的下限。
 *
 * 不是隨手挑的：低於這個值，玩家連把牌拖到場上都來不及，而「強制提早結束」
 * 送出的是**當下的場面**，不是空手。設得太小等於雙方一起亂打。
 */
export const MIN_PHASE_SECONDS = 5;

/** 聖水／聖杯 + 麻痺這組合預設再砍幾秒。玩家指定 5 秒。 */
export const DEFAULT_HAZARD_SHORTEN_SECONDS = 5;

/**
 * 移動階段的預設長度。玩家指定 20 秒。
 *
 * ⚠ **這是「我願意接受」的出價，不是強制值。** 協商取 `max`，所以只有在
 * **雙方都** 提出不超過 20 秒時共同值才會是 20；對手選 30 就是 30。
 * 而且沒配到對手時 `soloSettings()` 一律還原成滿版 —— 預設值改小不會讓任何
 * 單邊的人被縮短。
 *
 * 為什麼預設就縮短是安全的：兩邊拿到的是同一個預設，不對稱不存在。
 * 這跟加速那種「我先開就先賺到」的東西不同。
 */
export const DEFAULT_PHASE_SECONDS = 20;

/**
 * 演出加速的倍率範圍。1 = 原速（關掉）。
 *
 * ⚠ **這是協定層的範圍，`@ulr/cdp-adapter` 的 `MAX_SPEED_FACTOR` 是頁面層的。**
 * 兩邊各自夾一次是刻意的：協定不該 import 一個會開 WebSocket 的 package
 * （這個檔案的全部價值就是「沒有任何 I/O」），而兩處都夾的話，就算哪天兩個
 * 上限漂開了，**比較緊的那個會贏**，不會有人拿到超出頁面能承受的倍率。
 */
export const MIN_SPEED_FACTOR = 1;
export const MAX_SPEED_FACTOR = 10;

// ---------------------------------------------------------------------------
// 偏好與協商
// ---------------------------------------------------------------------------

/**
 * 一邊玩家在托盤裡設的東西。兩邊各自送上來，中間人協商出共同值。
 */
export interface LinkPrefs {
  /**
   * 我希望移動階段有多長（秒）。`MOVE_PHASE_TOTAL_SECONDS` = 不縮短。
   *
   * ⚠ 這是**階段長度**，不是「剩幾秒時送出」。玩家在托盤裡看到的是
   * 「移動階段秒數」，30 → 15 的意思是「本來 30 秒的階段，15 秒就結束」。
   */
  phaseSeconds: number;
  /**
   * 手牌有聖水／聖杯、且場上有麻痺時，再提早幾秒。0 = 關掉這條。
   *
   * 為什麼是「再提早」而不是一個絕對秒數：這是**思考秒數上限的修正項**，
   * 之後要接手牌數、手牌上限、機會 3 抽卡都是同一個機制加一項而已。
   */
  hazardShortenSeconds: number;
  /**
   * 準備功能（雙方都按了 OK 才真的送出）要不要開。
   *
   * 關掉之後這一邊完全不參與同步釋放 —— 但秒數協商仍然有效，
   * 兩者是獨立的開關（玩家可能只想要縮短階段，不想改 OK 鈕的行為）。
   */
  readyEnabled: boolean;
  /**
   * 演出加速倍率。1 = 原速。
   *
   * ⚠ **為什麼這個純本機的東西要放進協商。**
   * `patch-speed` 只加速自己畫面上的亮牌與出牌卡頓，對手看到的畫面一個像素
   * 都沒變 —— 看起來像個本機偏好。但它會**提早把決策窗還給我**
   * （`docs/battle-preplay.md`：防禦階段預算只有 1.94s，光亮牌就吃掉 800ms），
   * 而對手沒開就沒有這塊。那是單方面拿到的時間優勢，跟 `phaseSeconds`
   * 是同一類問題，所以走同一條路：**雙方都勾才算數**。
   */
  speedFactor: number;
}

export const DEFAULT_PREFS: LinkPrefs = {
  phaseSeconds: DEFAULT_PHASE_SECONDS,
  hazardShortenSeconds: DEFAULT_HAZARD_SHORTEN_SECONDS,
  readyEnabled: true,
  // ⚠ 預設關掉。加速改變的是玩家看到的節奏，不該在他沒選過的情況下發生。
  speedFactor: MIN_SPEED_FACTOR,
};

/** 協商出來的共同設定。兩邊拿到的**必須完全相同**。 */
export interface AgreedSettings {
  phaseSeconds: number;
  hazardShortenSeconds: number;
  readyEnabled: boolean;
  speedFactor: number;
}

/** 把秒數夾到合法範圍，並取整。UI 與協定兩邊都用它，才不會有一邊漏夾。 */
export function clampPhaseSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MOVE_PHASE_TOTAL_SECONDS;
  return Math.min(MOVE_PHASE_TOTAL_SECONDS, Math.max(MIN_PHASE_SECONDS, Math.round(seconds)));
}

export function clampHazardShorten(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_HAZARD_SHORTEN_SECONDS;
  // 上限是「不能把整個階段砍光」—— 真正的下限由 effectiveCapSeconds 夾住。
  return Math.min(MOVE_PHASE_TOTAL_SECONDS - MIN_PHASE_SECONDS, Math.max(0, Math.round(seconds)));
}

export function clampSpeedFactor(factor: number): number {
  if (!Number.isFinite(factor)) return MIN_SPEED_FACTOR;
  // 半格（1.5x、2.5x）是有意義的選項，所以取到小數一位而不是整數。
  const rounded = Math.round(factor * 10) / 10;
  return Math.min(MAX_SPEED_FACTOR, Math.max(MIN_SPEED_FACTOR, rounded));
}

export function normalizePrefs(prefs: Partial<LinkPrefs> | undefined): LinkPrefs {
  return {
    phaseSeconds: clampPhaseSeconds(prefs?.phaseSeconds ?? DEFAULT_PREFS.phaseSeconds),
    hazardShortenSeconds: clampHazardShorten(
      prefs?.hazardShortenSeconds ?? DEFAULT_PREFS.hazardShortenSeconds,
    ),
    readyEnabled: prefs?.readyEnabled ?? DEFAULT_PREFS.readyEnabled,
    // ⚠ 缺欄位一律當成「沒開」。舊版插件的 `hello` 不帶這個欄位，於是
    // `negotiate` 的 min 會算出 1 —— 對手是舊版時加速自動失效，正確且安全。
    speedFactor: clampSpeedFactor(prefs?.speedFactor ?? DEFAULT_PREFS.speedFactor),
  };
}

/**
 * 協商：**永遠取對雙方都不更嚴格的那一邊。**
 *
 * | 項目           | 取法  | 為什麼                                       |
 * | -------------- | ----- | -------------------------------------------- |
 * | `phaseSeconds` | `max` | 玩家原話：我選 10、對方選 15 → 用 15         |
 * | `hazardShorten`| `min` | 一方關掉這條 → 共同值就是 0，不能硬加給他    |
 * | `readyEnabled` | `and` | 同步釋放要兩邊都參與才成立                   |
 * | `speedFactor`  | `min` | 一方沒勾（1）→ 共同值 1，兩邊都不加速        |
 *
 * ⚠ **不要改成「我方優先」。** 這個功能存在的理由就是消除「先承諾的人被
 * 懲罰」的不對稱；讓任何一方能單方面把對手的思考時間砍掉，等於把不對稱換了
 * 個方向再裝回去。
 */
export function negotiate(a: LinkPrefs, b: LinkPrefs): AgreedSettings {
  return {
    phaseSeconds: Math.max(a.phaseSeconds, b.phaseSeconds),
    hazardShortenSeconds: Math.min(a.hazardShortenSeconds, b.hazardShortenSeconds),
    readyEnabled: a.readyEnabled && b.readyEnabled,
    speedFactor: Math.min(a.speedFactor, b.speedFactor),
  };
}

/**
 * 只有自己在線（還沒配對到對手）時的「共同設定」。
 *
 * ⚠ **秒數一律還原成滿版。** 對手沒有插件的話，我單方面在 15 秒送出
 * `I_am_ok` 只是讓自己更早承諾、對手照樣想滿 30 秒 —— 那是純粹的自損。
 * 縮短階段這件事**只在雙方都同意時才有意義**（`battle-features.md` 規則 3
 * 的末節講的是同一件事）。
 *
 * ⚠ **加速也一律關掉**，理由同秒數：它提早把決策窗還給我，對手沒有。
 * 這會讓加速在對手沒裝插件時完全用不到 —— 那是刻意的代價，不是遺漏。
 *
 * ⚠⚠ **準備功能 2026-08-09 起也一律關掉**（玩家指定：「是玩家的話，只有握手
 * 成功時才生效」）。這推翻了先前「單邊保留誤按反悔窗口」的設計，理由是那個
 * 窗口在單邊時**只有成本沒有收益**：
 *
 *   - 收益（對手也停下來等）需要對手也有插件，那正是 `paired` 的定義
 *   - 成本卻是單邊就要付的：我按下 OK 之後被壓著不送，對手照樣在動
 *
 * 換句話說，單邊模式下它只是把我自己的 OK 延後，沒有任何人因此受益。
 * 所以這裡四個欄位現在是同一個意思：**沒握手就什麼都不做。**
 */
export function soloSettings(_prefs: LinkPrefs): AgreedSettings {
  return {
    phaseSeconds: MOVE_PHASE_TOTAL_SECONDS,
    hazardShortenSeconds: 0,
    readyEnabled: false,
    speedFactor: MIN_SPEED_FACTOR,
  };
}

/**
 * 算出這個階段實際要在第幾秒強制結束。
 *
 * `hazard` 為真（手牌有聖水／聖杯且場上有麻痺）時再減 `hazardShortenSeconds`，
 * 但**不會低於 `MIN_PHASE_SECONDS`** —— 修正項可以疊，下限不行。
 */
export function effectiveCapSeconds(agreed: AgreedSettings, hazard: boolean): number {
  const raw = hazard ? agreed.phaseSeconds - agreed.hazardShortenSeconds : agreed.phaseSeconds;
  return Math.max(MIN_PHASE_SECONDS, raw);
}

// ---------------------------------------------------------------------------
// 房號
// ---------------------------------------------------------------------------

/** `roomKey()` 取雜湊的前幾個位元組。16 個十六進位字元 = 64 bit，碰撞可忽略。 */
export const ROOM_KEY_LENGTH = 16;

/**
 * 把遊戲的 room id 變成中間人用的房號。
 *
 * ⚠ **原始 room id 絕對不能離開這台機器。** 它是 32 字元的高熵字串，跟 session
 * token 同一個量級（§12 的 `VALUE_MAX_STRING_LENGTH = 24` 就是為了擋這類東西）。
 * 中間人要回答的問題只有「這兩個人在不在同一場」，那用雜湊就夠了。
 *
 * 兩邊算出來的值相同，是因為 room id 兩邊本來就一樣 —— 2026-08-06 雙開實測：
 * `MainA.room` 在 :9333 與 :1221 上是同一個字串。這也順帶回答了
 * `battle-features.md` 那四個 probe 問題的第 4 條（match id 可不可觀測）。
 */
export function roomKey(roomId: string): string {
  return createHash("sha256").update(roomId, "utf8").digest("hex").slice(0, ROOM_KEY_LENGTH);
}

/** 還沒進對戰時用的房號。所有「還在大廳」的人待在同一間，配不到對。 */
export const LOBBY_ROOM_KEY = "lobby";

// ---------------------------------------------------------------------------
// 訊息
// ---------------------------------------------------------------------------

/** 強制提早結束的原因。純粹是給 UI 與 log 用的，不影響行為。 */
export type ForceReason = "agreed-cap" | "hazard-cap";

export type ClientMessage =
  /** 第一則。版本不合就會被回 `incompatible`。 */
  | { t: "hello"; v: number; room: string; prefs: LinkPrefs }
  /** 玩家在托盤裡改了設定。 */
  | { t: "prefs"; prefs: LinkPrefs }
  /** 換場了 —— 房號要跟著換，否則會跟上一場的對手配在一起。 */
  | { t: "room"; room: string }
  /** 我方準備狀態變了。中間人**不會**把這則轉給對手。 */
  | { t: "ready"; ready: boolean }
  /** 我這邊的秒數門檻到了。中間人轉給對手，讓兩邊同一瞬間收手。 */
  | { t: "force-end"; reason: ForceReason };

export type ServerMessage =
  /** `hello` 的回覆。 */
  | { t: "welcome"; v: number; paired: boolean; agreed: AgreedSettings }
  /** 配對狀態或協商結果變了（對手上線、對手改設定、對手離線）。 */
  | { t: "agreed"; paired: boolean; agreed: AgreedSettings }
  /**
   * ⚠ **唯一會透露對手狀態的訊息，而且是合成的。**
   *
   * 只有在**兩邊都是 ready** 的那一瞬間才發，所以收到的人自己一定也已經
   * 準備好了 —— 他當下就要送出 `I_am_ok`，這則訊息不可能被拿來當情報用。
   * 中間人**不存在**一則「對手準備好了」的訊息可發。
   */
  | { t: "both-ready" }
  /** 對手那邊的秒數門檻到了。 */
  | { t: "force-end"; reason: ForceReason }
  /** 版本不合。收到的一方要退回單邊模式，不要重試。 */
  | { t: "incompatible"; v: number; reason: string }
  /** 這間房已經有兩個人了。第三個連進來的會收到這則。 */
  | { t: "room-full" };

export type LinkMessage = ClientMessage | ServerMessage;

// ---------------------------------------------------------------------------
// 關閉代碼
// ---------------------------------------------------------------------------

/**
 * 中間人主動斷線時用的代碼。**1000～2999 是 WebSocket 規格保留的**，
 * 自訂一律 4000 以上。
 *
 * ⚠ **這是協定的一部分，不是伺服器的內部細節。** 客戶端必須分得出來 ——
 * 4001 要立刻用新網址重連，4008 要**停下來**。全部混成同一個代碼的話，
 * 客戶端唯一能做的就是無腦重連，而那對 4008 剛好是最糟的反應（它會一直
 * 被踢，而且是自己造成的）。
 */

/** 你連的那間房不是你說的那間 —— 換個網址重連。 */
export const CLOSE_WRONG_ROOM = 4001;
/** 你送太快了。**不要立刻重連。** */
export const CLOSE_TOO_FAST = 4008;
/** 那則訊息太大。協定裡不存在這麼大的訊息，所以這通常代表有東西壞了。 */
export const CLOSE_TOO_BIG = 4009;

export function encode(message: LinkMessage): string {
  return JSON.stringify(message);
}

/**
 * 解析一則訊息。**壞掉的一律回 `null`，絕不拋例外。**
 *
 * 側通道是唯一從機器外面進來的東西（之後接上 ulgg 更是如此）。一則畸形訊息
 * 讓插件崩掉，代價是玩家在對戰中失去保護 —— 而那正是最需要它的時候。
 */
export function decode(raw: string): LinkMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;

  const m = parsed as Record<string, unknown>;
  switch (t) {
    case "hello":
      if (typeof m["v"] !== "number" || typeof m["room"] !== "string") return null;
      return {
        t: "hello",
        v: m["v"],
        room: m["room"],
        prefs: normalizePrefs(m["prefs"] as Partial<LinkPrefs> | undefined),
      };
    case "prefs":
      return { t: "prefs", prefs: normalizePrefs(m["prefs"] as Partial<LinkPrefs> | undefined) };
    case "room":
      if (typeof m["room"] !== "string") return null;
      return { t: "room", room: m["room"] };
    case "ready":
      if (typeof m["ready"] !== "boolean") return null;
      return { t: "ready", ready: m["ready"] };
    case "force-end":
      return { t: "force-end", reason: m["reason"] === "hazard-cap" ? "hazard-cap" : "agreed-cap" };
    case "welcome":
      if (typeof m["v"] !== "number") return null;
      return {
        t: "welcome",
        v: m["v"],
        paired: m["paired"] === true,
        agreed: normalizePrefs(m["agreed"] as Partial<LinkPrefs> | undefined),
      };
    case "agreed":
      return {
        t: "agreed",
        paired: m["paired"] === true,
        agreed: normalizePrefs(m["agreed"] as Partial<LinkPrefs> | undefined),
      };
    case "both-ready":
      return { t: "both-ready" };
    case "incompatible":
      return {
        t: "incompatible",
        v: typeof m["v"] === "number" ? m["v"] : 0,
        reason: typeof m["reason"] === "string" ? m["reason"] : "",
      };
    case "room-full":
      return { t: "room-full" };
    default:
      return null;
  }
}

/**
 * 版本相容嗎。
 *
 * 目前是嚴格相等 —— 只有一個版本，任何「大概可以」的判斷都只是在替未來的
 * 自己挖坑。等真的有 v2 時，這裡會變成一張明確的表，而不是一個 `>=`。
 */
export function isCompatible(theirVersion: number): boolean {
  return theirVersion === LINK_PROTOCOL_VERSION;
}
