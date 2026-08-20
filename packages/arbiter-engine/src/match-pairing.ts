/**
 * 自動配對：從排隊到開打（WP-16）
 * ==================================
 * 中間人只做一件事 —— 把兩條報了同一個配對鍵的連線湊起來。**「這一場算不算
 * 數」是插件自己判的**，而判準是這個檔案。
 *
 * ```
 *   排隊 ──▶ 湊成一對 ──▶ 規則對得上嗎 ──▶ 我的牌組在這一檔裡嗎 ──▶ 開房 / 進房
 *     │          │              │ 不行            │ 不行
 *     │          │              ▼                 ▼
 *     │          └──────── 換下一個對手      停止排隊，告訴玩家哪裡要改
 *     │
 *     └── 每 5 秒看一次玩家還在不在這個頻道，不在就自己停（`#watchLobby`）
 * ```
 *
 * ## 這是拿來取代亞歷山卓城的
 *
 * 官方的快速比賽只有 ranked 頻道有，而且用**原版 COST** 分檔（`[57,66,78]`）。
 * 自訂規則的約戰只能在 duel 頻道，那裡沒有佇列 —— 這一支就是那條佇列，而它
 * 刻意做成亞城的形狀：
 *
 *   · **檔位有下限**（57 檔收 56.01～57.00，見 {@link COST_BAND_WIDTH}）
 *   · **房名系統取**，標著 `[COST:57]`（見 {@link buildRoomName}）
 *   · **地點玩家選不到**，只有「誰來抽」（見 {@link StagePick}）
 *
 * 那三件事在亞城都不是選項，而它們正是「快速比賽」跟「約戰」的差別：
 * 按一顆按鈕就該打得起來，不該先填一張表。
 *
 * ## 為什麼判斷在客戶端，而這仍然是安全的
 *
 * 舊設計把「規則相同」寫進配對鍵：規則不同的人算出不同的鍵，落在不同的
 * Durable Object，**物理上碰不到**。那個保證很漂亮，但它把「版本不同」誤當成
 * 「不能一起打」（見 `@ulr/cost-engine` 的 `evaluation.ts`）。
 *
 * 換成語義驗算之後，判斷回到客戶端 —— 而客戶端是玩家自己的機器。改過的插件
 * 可以跳過驗算嗎？可以，但**沒有用**：
 *
 *   · 開房的是 host、進房的是 guest，**兩邊都得各自走完自己那半段**
 *   · 對手的插件會獨立算一次，算不過就不會進來
 *
 * 所以要繞過去必須**兩邊都改過**，而那時他們本來就是講好的 —— 兩個講好的人
 * 從來就可以不裝插件直接開房。這跟準備／秒數協商是同一條原則：
 * **會改變勝負的東西一律要雙方都同意才生效**（README「公平性立場」）。
 *
 * ## ⚠ 對手的牌組不會出現在畫面上
 *
 * 跨版本驗算要交換牌組描述子，所以插件**知道**對手帶了哪三隻。它只拿去算
 * 指紋，然後就丟掉：
 *
 *   · 不放進 `PairingStatus`（UI 唯一看得到的東西）
 *   · 不寫進記錄檔
 *   · 沒有任何介面問得到它
 *
 * 這不是隱藏資訊的問題（房間清單本來就把雙方牌組廣播給大廳每一個人，見
 * `@ulr/cdp-adapter` 的 `match-room.ts`），是**運動精神**的問題：看得到對手
 * 帶什麼就能挑對手，而那會讓整個約戰功能失去意義。同一份規則的配對（絕大
 * 多數）根本不會走到交換那一步。
 */

import { contentHash, formatCentiCost, toCentiCost } from "@ulr/rule-schema";
import type { CostRule } from "@ulr/rule-schema";
import {
  calculateTeamCost,
  canonicalDeck,
  crossVerdict,
  deckFromKeys,
  describeDisagreement,
  fingerprint,
  parseDeckDescriptor,
} from "@ulr/cost-engine";
import type { Compatibility, CrossEvaluation, DeckDescriptor } from "@ulr/cost-engine";
import { MatchQueueClient, matchKey, ruleTag } from "@ulr/arbiter-link";
import type {
  DropReason,
  MatchQueueClientOptions,
  QueueRole,
  QueueStatus,
} from "@ulr/arbiter-link";
import { ARCADIA_STAGES, ROOM_NAME_MAX_LENGTH } from "@ulr/cdp-adapter";
import type { MatchContext } from "@ulr/cdp-adapter";
import type { MatchDriver, PreflightResult, Sleep } from "./match-session.js";
import { guestJoinRoom, hostOpenRoom, preflight } from "./match-session.js";

/** 沒給 `sleep` 時用的那支。測試一律自己塞一個立刻回來的。 */
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等對手回話的上限。
 *
 * ⚠ 一定要有。對手的插件可能在送出描述子之後就被關掉、或卡在一個沒有回應的
 * CDP 呼叫上 —— 沒有逾時的話我方會停在「對規則中…」直到玩家自己發現不對。
 * 12 秒是「人類會開始懷疑」之前的長度，而正常的一次往返是毫秒級。
 */
export const PEER_REPLY_TIMEOUT_MS = 12_000;

/**
 * host 開好房之後，多久看一次「對手進來了沒」。
 *
 * ⚠ 這一段是**配對任務的終點**，不是附加功能。少了它，host 開完房就永遠停在
 * 「等對手進來」：佇列連線還掛著（會被配給第三個人）、`pairing` 物件還活著
 * （玩家按「開始自動配對」只會收到「已經在配對中了」），而那時他其實已經
 * 打完一場了。2026-08-16 實測就是這樣，要手動按停止才回得去。
 */
export const HANDOFF_POLL_MS = 2_000;

/**
 * 等對手進房的上限。
 *
 * 到了還沒人來就把房收掉並停止 —— 留著的話清單上是一間永遠沒人進的空房，
 * 而下一次配對會被 preflight 擋住。90 秒是「對手的插件正常走完進房流程」
 * （幾秒）的十倍以上餘裕。
 */
export const HANDOFF_TIMEOUT_MS = 90_000;

/**
 * host 開房前等對手回報地點的上限。
 *
 * ⚠ 等不到就用**自己的**地點開下去，不是停下來 —— 對手可能是舊版插件、
 * 或中間人還沒有 `q-pref` 那條轉發。地點協商是加分，不是開打的前提。
 */
export const STAGE_WAIT_MS = 3_000;

/**
 * 排隊時多久看一次「玩家還在不在約定的頻道」。
 *
 * ⚠ **這一段不是保險，是收尾路徑之一。** 排隊是會等的，而玩家在等的時候會去
 * 做別的事：點進別人的房、被拉進一場對戰、切去別的頻道、回標題畫面。少了它，
 * 那條佇列連線會一直掛著，等玩家打完一場回到大廳，中間人早就把他配給某個人
 * 了 —— 而那個人會開一間房，等一個根本沒在看畫面的對手。
 *
 * ⚠ **只在 `queued` 的時候看。** 對規則、開房、進房那幾段離開 Match 場景是
 * 正常的（進房成功的下一刻就會離開），在那裡判「他不在大廳了」會把剛打起來
 * 的一場自己收掉。
 *
 * 5 秒：這是一次 CDP 往返，而配對頁本身已經每 3 秒問一次了 —— 再密沒有意義，
 * 再疏的話「按了開始就跑去打別場」會留一條佇列連線掛半分鐘。
 */
export const LOBBY_WATCH_MS = 5_000;

/**
 * 官方的「隨機」地點。選它等於把地點交給伺服器。
 *
 * ⚠ 這個值是**遊戲自己的**（`STAGES` 的最後一項），不是我們定的代號。
 */
export const RANDOM_STAGE = "014";

/**
 * 玩家能選的地點 —— **只有兩種，沒有「指定某一張」這回事。**
 *
 * 自動配對是拿來取代亞歷山卓城的快速比賽的，而那邊不讓人挑地圖。挑地圖在
 * 這裡也沒有意義：開房的只有 host，所以「我指定 007」對 guest 而言是單方面
 * 被決定的，而協商（從雙方選的兩張裡抽一張）只是把那個不對稱換成擲骰子。
 *
 * | 值         | 誰抽             | 抽哪些                             |
 * | ---------- | ---------------- | ---------------------------------- |
 * | `arcadia`  | **插件**         | {@link ARCADIA_STAGES}（000~010）  |
 * | `official` | **遊戲伺服器**   | 它自己那份（我們看不到，也管不著） |
 *
 * 兩者的差別**不是**「哪個比較隨機」，是抽的池子不同 —— `arcadia` 一定會抽到
 * 那十一張裡的一張（含官方選單沒有的 010），`official` 抽的是官方那份。
 */
export type StagePick = "arcadia" | "official";

/** 認不得的值一律回這個。取代亞城的預設就是亞城的池子。 */
export const DEFAULT_STAGE_PICK: StagePick = "arcadia";

export function normalizeStagePick(raw: unknown): StagePick {
  return raw === "official" ? "official" : DEFAULT_STAGE_PICK;
}

/**
 * 從「亞城池」抽一張。
 *
 * 純函式（亂數從外面餵）——「隨機」這種東西寫在狀態機裡就永遠測不到了。
 */
export function pickArcadiaStage(roll: () => number = Math.random): string {
  const i = Math.floor(roll() * ARCADIA_STAGES.length);
  // ⚠ 要夾。`roll()` 回 1（或 1.0000001）時 `i` 會落在陣列外，而那個 undefined
  // 會被當成開房參數送出去 —— 伺服器回 fail:20，而錯誤訊息完全看不出原因。
  const clamped = Math.min(Math.max(i, 0), ARCADIA_STAGES.length - 1);
  return ARCADIA_STAGES[clamped] ?? RANDOM_STAGE;
}

/**
 * 兩邊各選了一種抽法，這一場開在哪（回傳的是**具體的地點代號**）。
 *
 * | 我       | 對手               | 結果                     |
 * | -------- | ------------------ | ------------------------ |
 * | arcadia  | arcadia            | 從 000~010 抽一張        |
 * | arcadia  | **沒說**（舊版）   | 從 000~010 抽一張        |
 * | arcadia  | official           | **`014`**（官方隨機）    |
 * | official | 任何               | **`014`**                |
 *
 * ⚠ **只要有一邊選了「官方隨機」就走官方隨機。** 那一邊等於說了「我不要插件
 * 替我抽」—— 而亞城池裡有一張官方選單沒有的 010（見 {@link ARCADIA_STAGES}），
 * 硬把他丟過去是拿他沒同意的東西去改變這一場。反過來則沒有這個問題：官方隨機
 * 抽到的一定是官方認得的地圖。
 *
 * ⚠ 對手沒說（舊版插件、或中間人不轉發 `q-pref`）時用**我的** —— 地點協商是
 * 加分，不是開打的前提。
 */
export function negotiateStage(
  mine: StagePick,
  theirs: StagePick | null,
  roll: () => number = Math.random,
): string {
  if (mine === "arcadia" && theirs !== "official") return pickArcadiaStage(roll);
  return RANDOM_STAGE;
}

/**
 * `q-pref` 的內容。**只有開房偏好**，沒有身分、沒有牌組、沒有規則。
 *
 * ⚠ `official` 送的是舊版認得的 `"014"` 而不是 `"official"`。舊版插件的
 * `parsePrefBody` 只收三位數字，收到 `"official"` 會當成「他沒說」——
 * 而 `"014"` 它讀得懂，於是舊版當 host 時也會開隨機房。`arcadia` 沒有這種
 * 對應值（舊版沒有那個概念），送過去被當成沒說，舊版就用他自己的 —— 那是
 * 正確的退化。
 */
export function encodePrefBody(pref: { stage: StagePick }): string {
  return JSON.stringify({ s: pref.stage === "official" ? RANDOM_STAGE : "arcadia" });
}

/**
 * 解析對手的 `q-pref`。壞掉一律 `null` —— 那等同「他沒說」，用我自己的抽法。
 *
 * ⚠ 要驗格式。這個值會決定開房參數，而開房參數是送進遊戲封包的東西。
 *
 * ⚠ **舊版送來的三位數字一律當成 `official`。** 新版沒有「指定某一張」這個
 * 概念了，照著他指定的那張開等於讓一個舊版客戶端單方面決定地點；退回官方隨機
 * 是雙方都沒挑的中立結果，而且他那版看得懂 `014`。
 */
export function parsePrefBody(body: string): { stage: StagePick } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const stage = (parsed as Record<string, unknown>)["s"];
    if (typeof stage !== "string") return null;
    if (stage === "arcadia") return { stage: "arcadia" };
    if (/^\d{3}$/.test(stage)) return { stage: "official" };
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 房名
// ---------------------------------------------------------------------------

/**
 * 房名的**規則那一段**塞不下時用這個。
 *
 * 抄的是官方快速比賽（`Quickmatch [COST:57]`）—— 自動配對就是要取代它，
 * 大廳上看起來一樣是刻意的。
 */
export const ROOM_NAME_FALLBACK = "Quickmatch";

/** `57` → `"57"`、`57.5` → `"57.5"`。⚠ 房名要短，`.00` 是白佔兩格。 */
function trimCost(limit: number): string {
  return String(Math.round(limit * 100) / 100);
}

/**
 * 這一檔在大廳上叫什麼 —— `[COST:57]`。
 *
 * ⚠ 標的是**這一檔的上限**，跟亞城的 `[COST:57]` 同一個意思：那不是「剛好 57」，
 * 是「57 這一檔」，實際收的區間見 {@link costBand}。
 */
export function formatCostTag(costLimit: number | null, openFloor: number | null = null): string {
  if (costLimit !== null) return `[COST:${trimCost(costLimit)}]`;
  // 開口檔照抄遊戲畫面上的寫法（`COST90+`）—— 大廳裡的人一眼認得出那是哪一檔，
  // 而那正是這個標籤存在的理由。
  if (openFloor !== null) return `[COST:${trimCost(openFloor)}+]`;
  return "[COST:自由]";
}

/**
 * 自動配對開出來的房叫什麼。**玩家取不到房名，這支說了算。**
 *
 * ```
 *   夾擠式罰C [COST:57]
 *   └── 規則名 ──┘└ 這一檔 ┘
 * ```
 *
 * ⚠ **`[COST:n]` 那一段永遠完整，被截的只會是前面的規則名。** 房名的功能是
 * 讓大廳裡的人一眼看出「這是哪一檔」—— 那正是亞城的房間列在做的事，而自動
 * 配對是要取代它。截到 COST 那一段的話這個功能就沒了。
 *
 * ### 為什麼是規則**名稱**而不是規則族
 *
 * 規則族（`tomorin/squeeze-band`）本身就 20 個字，跟 `[COST:57]` 併不進同一個
 * 房名；截成 `squeeze-ba` 之後既不好讀、也不再是識別碼，兩邊都沒了。
 *
 * 而房名**本來就不是識別碼** —— 決定誰配得到誰的是配對鍵（裡面放的正是規則族），
 * 那個玩家改不了也看不到，房名寫什麼都不會讓錯的人配進來。既然它只是給大廳
 * 看的招牌，就該用玩家在「牌組 › Cost 表」看到的那個名字，兩邊對照得起來。
 *
 * ⚠ 代價講清楚：同一族的不同版本可以改名字，所以大廳上可能出現兩個標籤不同、
 * 卻排在同一條佇列的房。那隻影響觀感，不影響配對。
 */
export function buildRoomName(
  ruleName: string,
  costLimit: number | null,
  openFloor: number | null = null,
): string {
  const tag = formatCostTag(costLimit, openFloor);
  // ⚠ 換行與連續空白要壓掉 —— 規則名是規則檔裡的自由文字，帶著換行送進房名
  // 等於把一個沒人看得懂的東西貼在公開清單上。
  let label = ruleName.replace(/\s+/gu, " ").trim();
  if (label === "") label = ROOM_NAME_FALLBACK;

  const budget = ROOM_NAME_MAX_LENGTH - tag.length - 1;
  // 連一個字都放不下（上限是個超長的數字）→ 只留 COST 那一段。
  if (budget < 1) return tag.slice(0, ROOM_NAME_MAX_LENGTH);
  if (label.length > budget) label = `${label.slice(0, budget - 1)}…`;
  return `${label} ${tag}`;
}

// ---------------------------------------------------------------------------
// 兩邊交換的東西（純函式，可完整測試）
// ---------------------------------------------------------------------------

/** `q-deck` 的內容。**只有牌組**，沒有身分、沒有規則內容。 */
export function encodeDeckBody(deck: DeckDescriptor): string {
  return JSON.stringify(canonicalDeck(deck));
}

/** 解析對手的 `q-deck`。壞掉一律 `null`。 */
export function parseDeckBody(body: string): DeckDescriptor | null {
  try {
    return parseDeckDescriptor(JSON.parse(body));
  } catch {
    return null;
  }
}

/** `q-eval` 的內容：兩個指紋，`h` 是 host 那副牌、`g` 是 guest 那副。 */
export function encodeEvalBody(cross: CrossEvaluation): string {
  return JSON.stringify({ h: cross.host, g: cross.guest });
}

/**
 * 解析對手的 `q-eval`。
 *
 * ⚠ 兩個欄位都要是字串才算數。少驗一個的話，`undefined === undefined` 會讓
 * 一則空訊息通過比對 —— 那是把「規則相容」判成 true 的最短路徑。
 */
export function parseEvalBody(body: string): CrossEvaluation | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    if (typeof m["h"] !== "string" || m["h"] === "") return null;
    if (typeof m["g"] !== "string" || m["g"] === "") return null;
    return { host: m["h"], guest: m["g"] };
  } catch {
    return null;
  }
}

/**
 * 用**我的**規則算兩副牌的指紋。
 *
 * 名字用 host/guest 而不是「我／對手」：兩邊要比對的是同一組標籤，用相對
 * 稱呼的話 A 的「我」是 B 的「對手」，永遠對不起來。
 */
export function crossEvaluate(
  rule: CostRule,
  decks: { host: DeckDescriptor; guest: DeckDescriptor },
): CrossEvaluation {
  return { host: fingerprint(rule, decks.host), guest: fingerprint(rule, decks.guest) };
}

// ---------------------------------------------------------------------------
// COST 檔位
// ---------------------------------------------------------------------------

/**
 * 一檔有多寬。**1.00 C。**
 *
 * 約定上限 57 收的不是「57 以下」，是 **56.01～57.00** —— 跟亞歷山卓城的
 * `COST57` 是同一個意思，而自動配對就是要取代那個。
 *
 * ### 為什麼要有下限
 *
 * 沒有下限的話「57 檔」會收下 40C 的隊伍，而 40C 打 57C 不是一場比賽。
 * 自訂 COST 規則整套東西的重點是**壓 C**（把隊伍擠到剛好卡滿那一檔），
 * 而「壓到剛好」只有在下限存在時才是一件要花心思的事 —— 沒有下限的話
 * 帶什麼都合法，那個設計空間整個消失。
 *
 * ⚠ 下限是 `上限 − 1.00 + 0.01`，不是 `上限 − 1.00`：56.00 屬於 56 那一檔，
 * 不是 57 那一檔。兩檔不重疊，一副牌永遠只落在一檔裡。
 */
export const COST_BAND_WIDTH = 1;

/** 一檔的上下限，單位是**整數百分之一**（`cost-number.ts` 的表示法）。 */
export interface CostBand {
  /** 下限，**含**。57 檔是 5601。 */
  floor: number;
  /** 上限，**含**。57 檔是 5700。 */
  cap: number;
}

/**
 * 約定上限 → 這一檔收的區間。沒有約定上限是 `null`（什麼牌組都收）。
 *
 * ⚠ 一律走 `toCentiCost` 轉成整數再算。`limit - 1` 那種寫法在浮點上是
 * `56.00000000000001`，而那會讓剛好卡在下限的隊伍被判成太低 —— 那是
 * `cost-number.ts` 整支檔案存在的理由。
 *
 * ⚠ 先 `toFixed(2)`：`toCentiCost` 對超過兩位小數的值會**拋例外**，而這個
 * 數字是玩家在輸入框打的。配對鍵那邊（`matchCriteriaString`）也是 toFixed(2)，
 * 兩處要用同一個表示法，否則「畫面上寫 57、實際比 57.001」對不起來。
 */
export function costBand(costLimit: number | null): CostBand | null {
  if (costLimit === null) return null;
  const cap = toCentiCost(Number(costLimit.toFixed(2)));
  // ⚠ 夾到 0。上限小於一檔寬（例如 0.5）時算出來是負的，而負的下限會讓
  // 「太低」這個判斷永遠成立不了 —— 那正是我們要的（那種上限本來就沒有下限
  // 可言），但寫成負數會在畫面上印出 `-49.00` 這種東西。
  return { floor: Math.max(0, cap - toCentiCost(COST_BAND_WIDTH) + 1), cap };
}

/**
 * 這一檔在畫面上長什麼樣 —— `56.01～57.00`，開口檔是 `90.00 以上`。
 *
 * ⚠ `openFloor` **只在 `costLimit === null` 時才看**。兩個都給是矛盾的輸入
 * （一檔不會既有上限又是開口的），這裡以 `costLimit` 為準。
 */
export function formatBand(
  costLimit: number | null,
  openFloor: number | null = null,
): string | null {
  const band = costBand(costLimit);
  if (band !== null) return `${formatCentiCost(band.floor)}～${formatCentiCost(band.cap)}`;
  if (openFloor === null) return null;
  return `${formatCentiCost(toCentiCost(Number(openFloor.toFixed(2))))} 以上`;
}

/**
 * 開口檔（`COST90+`）配對的窗口 —— **±5.00 C**。
 *
 * 最高檔以上沒有上限可言，所以那一檔不能用「上限 − 0.99」那套：95C 的隊伍要
 * 配得到 90～100C 的人。作法因此不一樣 ——
 *
 * ```
 *   有上限的檔（54/61/77）   檔位進配對鍵 → 同一檔的人才在同一條佇列
 *   開口檔（90+）            全部排同一條佇列 → 配到之後各自看差幾 C
 * ```
 *
 * ⚠ **窗口是在客戶端判的，而且兩邊都會判。** 差太多時送 `q-reject`，兩個人
 * 都留在佇列裡而中間人會記得「這一對試過了」（跟規則不相容走同一條路，見
 * docs/match-making.md「驗算沒過會怎樣」）—— 少了那張清單，兩個差 8C 的人會
 * 在 FIFO 裡被立刻重新湊成同一對，變成毫秒級的無窮迴圈。
 *
 * ⚠⚠ **這個窗口需要對手的總和，所以開口檔一定要交換牌組**，即使兩邊的規則
 * 完全相同（`EXACT` 快路在這一檔不能走）。算出來的數字**只拿來當閘門**，
 * 不進畫面、不進記錄檔 —— 那是 docs/match-making.md §7 那條線，理由是運動
 * 精神：看得到對手多少 C 就能挑對手。
 */
export const OPEN_TIER_WINDOW = 5;

/**
 * 這副牌**自己落在哪一檔**（WP-17）。
 *
 * 亞歷山卓城的快速比賽不讓玩家挑檔位 —— 你按下去，伺服器照你的牌組把你放進
 * 某一檔的佇列。迪特赫姆那顆按鈕要一樣：**檔位由牌組決定，不是由設定決定**。
 *
 * ```
 *   檔位 [54, 61, 77] + 開口檔 90
 *
 *   53.01～54.00 → COST54        48.00 → ✗（不在任何一檔裡）
 *   60.01～61.00 → COST61        61.50 → ✗
 *   76.01～77.00 → COST77        80.00 → ✗
 *   90.00 以上   → COST90+       95.00 → COST90+（配 90～100，見 OPEN_TIER_WINDOW）
 * ```
 *
 * ⚠⚠ **不落在任何一檔就是不合法，不是「幫他挑最接近的」。** 每一檔都有下限
 * （見 {@link COST_BAND_WIDTH}），而下限正是「壓 C」這件事存在的理由 ——
 * 自動幫一副 48C 的牌挑 COST54 等於把下限拿掉。玩家看到的是遊戲自己那句
 * 「這個牌組不符合遊戲規則」，跟他在亞城帶一副不合檔的牌時看到的一模一樣。
 *
 * ⚠ 檔位清單是從**玩家自己的客戶端**現讀的（`costTiersFor`），每週二會變。
 * 開口檔那個數字也是（從遊戲自己的 `PLAYER_COUNT` 模板裡的 `COST90+` 讀出來）。
 * 這支不快取、也不接受呼叫端寫死的清單。
 *
 * @param totalCenti 這副牌在約定規則下的總和，**整數百分之一**
 * @param openTier 開口檔的下限（90）。`null` = 這個頻道沒有開口檔
 */
export function tierForTotal(
  totalCenti: number,
  tiers: readonly number[],
  openTier: number | null = null,
): CostTierPick | null {
  for (const tier of tiers) {
    const band = costBand(tier);
    if (band === null) continue;
    if (totalCenti >= band.floor && totalCenti <= band.cap) return { kind: "band", tier };
  }
  // ⚠ 開口檔**最後才看**。它跟有上限的檔位在數線上不重疊（90 以上 vs 77 以下），
  // 但順序寫反的話，之後有人把開口檔調到 77 時會安靜地吃掉 COST77 那一檔。
  if (openTier !== null && totalCenti >= toCentiCost(Number(openTier.toFixed(2)))) {
    return { kind: "open", tier: openTier };
  }
  return null;
}

/** 命中的檔位。`band` = 有上限的那幾檔，`open` = `COST90+`。 */
export interface CostTierPick {
  kind: "band" | "open";
  /** `band` 是那一檔的上限（57），`open` 是它的下限（90）。 */
  tier: number;
}

export interface LimitCheck {
  /** 這副牌在這份規則下的總和，顯示用字串。 */
  total: string;
  /** 超過這一檔的上限了沒。沒有約定上限時永遠 `false`。 */
  over: boolean;
  /** 低於這一檔的下限了沒。沒有約定上限時永遠 `false`。 */
  under: boolean;
  /** 這一檔收的區間，顯示用（`56.01～57.00`）。沒有約定上限是 `null`。 */
  band: string | null;
  /** 規則裡沒有定價的鍵。不是空的就代表算出來的數字含 99 這個代替值。 */
  unknown: string[];
}

/** `over` 或 `under` —— 這副牌不在這一檔裡。 */
export function outOfBand(check: LimitCheck): boolean {
  return check.over || check.under;
}

/**
 * 我這副牌在約定的規則與檔位下合不合法。**只看自己那副。**
 *
 * ⚠ 對手那副由**對手自己**檢查。這不是偷懶，是同一條紅線：兩邊都會拒絕
 * 不合法的自己，所以不需要任何一方去審對方 —— 也就不需要把對手的總和顯示
 * 出來（那會變成「先看看對手多少 C 再決定要不要打」）。
 */
export function checkOwnDeck(
  rule: CostRule,
  deck: DeckDescriptor,
  costLimit: number | null,
  /**
   * 開口檔（`COST90+`）的下限。**只在 `costLimit === null` 時才看。**
   *
   * ⚠ 開口檔**沒有上限**（`over` 永遠 false）—— 上面那一檔配不配得到由 ±5 的
   * 窗口決定，而那是配到人之後兩邊各自算的，不是這裡。
   */
  openFloor: number | null = null,
): LimitCheck {
  const result = calculateTeamCost(rule, teamOf(deck));
  const band = costBand(costLimit);
  const floor =
    band !== null
      ? band.floor
      : openFloor === null
        ? null
        : toCentiCost(Number(openFloor.toFixed(2)));
  return {
    total: formatCentiCost(result.total),
    over: band !== null && result.total > band.cap,
    under: floor !== null && result.total < floor,
    band: formatBand(costLimit, openFloor),
    unknown: result.unknownIds,
  };
}

/**
 * 一份描述子 → `calculateTeamCost()` 吃的形狀。
 *
 * ⚠⚠ **武器與事件卡一定要一起送。** 這裡原本只送三個槽位，而症狀完全不像
 * 少算了東西：玩家 2026-08-19 帶著遊戲畫面上寫 92C 的牌組按快速比賽，插件
 * 算出 84C，於是判成「不在任何一檔裡」跳出「這個牌組不符合遊戲規則」——
 * 差的 8C 就是他那三把武器。
 *
 * 遊戲自己的 `Deck.getCost()` 把三格槽位、三把武器、18 張事件卡全部加起來，
 * 而玩家看的是那個數字。**只要我們算的跟他看的不一樣，任何一句話都會變成
 * 謊話** —— 檔位判斷、±5 窗口、配對頁上的總和，全部同一個來源。
 */
function teamOf(deck: DeckDescriptor): Parameters<typeof calculateTeamCost>[1] {
  const canonical = canonicalDeck(deck);
  return {
    members: canonical.characters.map((characterId) => ({ characterId })),
    equipment: canonical.equipment,
    eventCards: canonical.eventCards,
  };
}

/** 這副牌的總和，**整數百分之一**。⚠ 只給閘門用（±5 窗口），不進畫面。 */
export function teamCostCenti(rule: CostRule, deck: DeckDescriptor): number {
  return calculateTeamCost(rule, teamOf(deck)).total;
}

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------

export type PairingPhase =
  /** 沒在配對。 */
  | "idle"
  /** 排隊中。 */
  | "queued"
  /** 配到人了，正在對規則。 */
  | "checking"
  /** 我是 host，正在開房。 */
  | "opening"
  /** 我是 guest，正在等房 / 進房。 */
  | "joining"
  /** 成了 —— host 開好房在等人，或 guest 已經進去了。 */
  | "ready"
  /** 停下來了，而且要玩家做點什麼（改牌組、改頻道…）。 */
  | "blocked";

/** UI 唯一看得到的東西。⚠ **裡面沒有任何對手的資訊**，理由見檔頭。 */
export interface PairingStatus {
  phase: PairingPhase;
  /**
   * **中間人那條線真的接上了嗎。**
   *
   * ⚠⚠ 少了這個欄位，「排隊中」是一句謊話。`phase` 在 `start()` 裡就被設成
   * `queued` 了 —— 那時 WebSocket 才剛開始連，而它可能永遠連不上（中間人沒
   * 部署配對佇列、網路不通、位址填錯）。畫面上會是「排隊中 · 只有你」，跟
   * 「連上了但還沒人」**一模一樣**，於是玩家會一直等一條根本不存在的隊伍。
   *
   * 2026-08-16 實測踩到：雲端中間人的 `/q/` 路由回 404（那台還沒更新到有佇列
   * 的版本），兩個客戶端條件完全相同，畫面兩邊都寫「排隊中」，等多久都不會配到。
   *
   * `true` 的意思很窄：**收到過 `q-welcome`**，也就是佇列真的認得我們。
   */
  linked: boolean;
  /** 中間人回報的排隊人數（含自己）。 */
  waiting: number;
  role: QueueRole | null;
  /** 這一對的規則關係。還沒配到人是 `null`。 */
  compatibility: Compatibility | null;
  /** 我這副牌在約定規則下的總和。 */
  myTotal: string | null;
  /** 我這副牌超過這一檔的上限了。 */
  overLimit: boolean;
  /**
   * 我這副牌低於這一檔的下限了。
   *
   * ⚠ 跟 `overLimit` **要分開**，兩者要玩家做的事相反（一個是減、一個是加）。
   * 併成一個 `outOfBand` 的話畫面只能說「不在這一檔」，而那句話沒有方向。
   */
  underLimit: boolean;
  /** 這一檔收的區間（`56.01～57.00`）。沒有約定上限是 `null`。 */
  band: string | null;
  /** 規則版本對不起來、換下一個對手的次數。 */
  skipped: number;
  /**
   * 這一場協商出來的對戰地點。還沒協商是 `null`。
   *
   * ⚠ 只有 host 會有值 —— 開房的是他。guest 看到的是開好的房。
   */
  stage: string | null;
  /** 直接顯示給玩家的一句話。 */
  message: string;
}

/**
 * 這支需要中間人做到的事。真的實作是 `MatchQueueClient`，測試餵假的。
 *
 * ⚠ 抽出來是因為**這個狀態機沒辦法用測試以外的方式驗**：真的跑一次要兩個
 * 帳號、兩份不同版本的規則、消耗 AP，而且會把人丟進對戰。而它裡面的每一條
 * 分支錯了都是安靜的 —— 「配到人之後就不動了」看起來跟「還沒配到人」一樣。
 */
export interface QueueLink {
  start(): void;
  stop(): void;
  reject(): void;
  sendDeck(body: string): void;
  sendEval(body: string): void;
  sendPref(body: string): void;
  sendRoom(roomId: string): void;
}

/**
 * 插件開的房**永遠是 3vs3**。
 *
 * ⚠ 這曾經是玩家可以選的一格，拿掉了 —— 理由跟房名與地圖同一個：自動配對是要
 * 取代亞歷山卓城的快速比賽，而那邊按一顆按鈕就開打，不先填一張表。多一個選項
 * 的代價還特別高：`multi` **進配對鍵**，所以那一格會把本來就不多的人潮劈成兩半，
 * 而排不到的那一半在畫面上看到的只有「排隊中·只有你」。
 *
 * ⚠ **值一定要是 `true`（3vs3），不能改。** 它進 `matchCriteriaString`，改成
 * 別的值等於換掉整個社群的配對鍵 —— 舊版插件與新版永遠配不到，而症狀是安靜的。
 */
export const ROOM_MULTI = true;

/**
 * 遊戲自己的「牌組Cost限制 ±N」，插件開房時**永遠不設**。
 *
 * ⚠ 它是**伺服器用原版 COST 判**的，而這整個功能約定的是自訂規則算出來的數字
 * —— 兩個是不同的數字（見 docs/match-making.md 的 §「兩個 COST 限制」）。開著
 * 它只會讓一副「照約定的規則完全合法」的牌組被官方的數字擋在門外，而玩家看到的
 * 是進不了房，不是為什麼。約定的那一檔由**雙方各自**用約定的規則檢查
 * （`checkOwnDeck`），那才是這裡唯一該生效的限制。
 */
const ROOM_DECK_COST_BAND = null;

export interface PairingOptions {
  /** 中間人的位址（不含路徑）。跟側通道同一台。 */
  endpoint: string;
  /** 約定的規則。**配對一定要有規則** —— 沒有的話不知道在約定什麼。 */
  rule: CostRule;
  channel: number;
  /**
   * 約定的這一檔（用這份規則算）。`null` = 不設限。
   *
   * ⚠ 這是**檔位的上限**，不是「小於等於它就好」—— 實際收的區間是
   * `上限 − 0.99` 到 `上限`，見 {@link COST_BAND_WIDTH}。
   */
  costLimit: number | null;
  /**
   * 開口檔（`COST90+`）的下限。**只在 `costLimit === null` 時有意義。**
   *
   * 那一檔沒有上限，所以配對條件換成「都在這條佇列上，配到之後看兩副牌差
   * 幾 C」—— 窗口是 ±{@link OPEN_TIER_WINDOW}。詳見那個常數。
   */
  costFloor?: number | null;
  /**
   * 開房用的欄位。
   *
   * ⚠ **房名不在這裡** —— 它是系統照規則名與檔位組出來的（`buildRoomName`），
   * 玩家取不到。理由見那支的說明：房名要讓大廳一眼看出這是哪一檔。
   *
   * ⚠ 只有配到人之後**當上 host 的那一邊**會真的用到地點。guest 這邊
   * `stage` 一樣有意義 —— 它會被送給對手參與地點協商（見 `negotiateStage`）。
   *
   * ⚠ 遊戲自己的「牌組Cost限制 ±N」**不在這裡**，因為插件永遠不設它
   * （見 {@link ROOM_DECK_COST_BAND}）。3vs3 同理（{@link ROOM_MULTI}）。
   */
  room: { stage: StagePick; friend: boolean };
  driver: MatchDriver;
  onStatus?: (status: PairingStatus) => void;
  onLog?: (line: string) => void;
  /** 測試用。 */
  sleep?: Sleep;
  timeoutMs?: number;
  /** host 等對手進房的輪詢間隔與上限。測試會塞很小的值。 */
  handoffPollMs?: number;
  handoffTimeoutMs?: number;
  /** host 等對手回報地點的上限。 */
  stageWaitMs?: number;
  /** 排隊時多久看一次玩家還在不在大廳。0 = 不看（測試用）。 */
  lobbyWatchMs?: number;
  /** 地點抽籤用的亂數。⚠ 測試一定要塞確定性的，不然那條分支測不了。 */
  roll?: () => number;
  /** 測試用：換掉中間人的連線。預設是真的 `MatchQueueClient`。 */
  link?: (options: MatchQueueClientOptions) => QueueLink;
}

const IDLE: PairingStatus = {
  phase: "idle",
  linked: false,
  waiting: 0,
  role: null,
  compatibility: null,
  myTotal: null,
  overLimit: false,
  underLimit: false,
  band: null,
  skipped: 0,
  stage: null,
  message: "沒在配對。",
};

/**
 * 一次「開始配對」的完整生命週期。
 *
 * ⚠ **`start()` 只能由玩家明確按下的動作觸發**，而且它會走到開房（消耗 AP）
 * 與進房（直接開打）。任何自動重試、輪詢、狀態同步都不准叫它。
 */
export class MatchPairing {
  #options: PairingOptions;
  #client: QueueLink | null = null;
  #status: PairingStatus = IDLE;

  /** 這一對的狀態。每次重新配對都整組清掉。 */
  #role: QueueRole | null = null;
  #token: string | null = null;
  #myDeck: DeckDescriptor | null = null;
  #peerDeck: DeckDescriptor | null = null;
  #myEval: CrossEvaluation | null = null;
  #peerEval: CrossEvaluation | null = null;
  #compatibility: Compatibility | null = null;
  /** guest 收到房號的時間可能早於自己驗算完 —— 先收著。 */
  #pendingRoomId: string | null = null;
  /** host 已經真的開了一間房。對手跑掉時要收掉它。 */
  #openedRoom = false;
  /** host 自己那間房的 room_id。等對手進來要靠它在清單裡認人。 */
  #myRoomId: string | null = null;
  /**
   * host 已經把房號交出去了。
   *
   * ⚠ 這之後收到的 `q-dropped(cancel)` **多半是對手進房成功**：他的插件一進去
   * 就會離開佇列，而離開佇列送的正是 `q-cancel`。照原本的處理（收房 + 退回排隊）
   * 等於在對手剛進門的瞬間把房拆了，而畫面上寫「對手取消了，繼續排隊」。
   */
  #handedOff = false;
  /** 等對手進房的輪詢。跟 `#timer`（等對手回話）是兩件事，不能共用一個。 */
  #watch: ReturnType<typeof setTimeout> | null = null;
  /** 排隊時盯著「玩家還在不在大廳」的輪詢。⚠ 跟上面兩個都不一樣，別共用。 */
  #lobby: ReturnType<typeof setTimeout> | null = null;
  /** 對手選的抽法。`null` = 還沒說（或他那版沒有這個功能）。 */
  #peerStage: StagePick | null = null;
  /** 收到對手地點時要叫醒誰（host 在開房前等它）。 */
  #stageWaiter: (() => void) | null = null;
  #skipped = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 已經在跑開房／進房了，不要重入。 */
  #committing = false;
  /** 我這份規則在這條佇列上的標籤。`start()` 算一次。 */
  #myTag = "";
  /** 上一次讀牌組時玩家在哪個頻道。`null` = 沒進頻道或讀不到。 */
  #currentChannel: number | null = null;

  /**
   * 開口檔（`COST90+`）的下限。`null` = 這一場約的是有上限的檔（或不設限）。
   *
   * ⚠ **`costLimit` 有值時一律回 `null`。** 兩者互斥，而讓「上限」贏是因為
   * 那是玩家看得到的那一格 —— 兩個都填是呼叫端的錯，靜靜地照開口檔跑會讓
   * 房名、檢查、配對鍵三個地方各說各話。
   */
  get #openFloor(): number | null {
    if (this.#options.costLimit !== null) return null;
    return this.#options.costFloor ?? null;
  }

  constructor(options: PairingOptions) {
    this.#options = options;
  }

  get status(): PairingStatus {
    return this.#status;
  }

  /**
   * 開始排隊。
   *
   * 排隊之前先做三件事，**每一件失敗都要停在 `blocked` 而不是硬排下去**：
   * 玩家人在約定的頻道、讀得到牌組、**牌組落在約定的那一檔裡**。
   *
   * ⚠ 第三件是「換牌組」等級的要求，不是警告。排下去的話配到人才發現不合法，
   * 而那時對手已經開好房在等了 —— 他要重排一輪，而那一輪是我們害的。
   */
  async start(): Promise<void> {
    if (this.#client !== null) return;

    // ⚠⚠ **第一件事就是離開 `idle`，而且要在其他任何 `#patch` 之前。**
    //
    // 托盤靠「狀態變成 idle／blocked」來放掉手上的這個物件（main.ts 的
    // `onStatus`）—— 那個約定的前提是「回到 idle ＝ 這個任務結束了」。而下面
    // 那句 `#patch({ myTotal … })` 在 phase 還停在 idle 的時候就把狀態推出去，
    // 於是托盤在**排隊才剛要開始**的瞬間就把物件丟了：排隊照跑（客戶端還在
    // 佇列上，配到人一樣會開房消耗 AP），但畫面上按「停止」是打在 null 上，
    // 怎麼按都停不掉，也不能重按開始（會被「已經在配對中了」擋住）。
    // 2026-08-16 實測踩到。測試在 match-pairing.test.ts 那條「不准推出 idle」。
    this.#patch({ ...IDLE, phase: "queued", message: "準備中…" });

    const pre = await this.#preflight();
    if (!pre.ok) {
      this.#block(pre.block.message);
      return;
    }

    const deck = await this.#readOwnDeck();
    if (deck === null) return;

    const check = checkOwnDeck(this.#options.rule, deck, this.#options.costLimit, this.#openFloor);
    this.#patch({
      myTotal: check.total,
      overLimit: check.over,
      underLimit: check.under,
      band: check.band,
    });
    if (outOfBand(check)) {
      this.#block(this.#bandMessage(check, "換一副牌組再按開始，或改約別的檔位。"));
      return;
    }
    if (check.unknown.length > 0) {
      // ⚠ 不是硬錯誤（對手用同一份規則的話兩邊都算 99，指紋還是對得起來），
      // 但一定要講：99 是代替值，玩家看到的總和不是他以為的那個。
      this.#log(
        `⚠ 這份規則沒有替 ${check.unknown.length} 張卡定價，那些卡一律算 99 —— ` +
          `總和 ${check.total} 不能當真。`,
      );
    }

    const key = matchKey({
      ruleSetId: this.#options.rule.ruleSetId,
      channel: this.#options.channel,
      // ⚠ 固定 3vs3（見 `ROOM_MULTI`）。這一格仍然在鍵裡是**刻意**的：
      // 格式一旦發布就不能改，而拿掉它會讓舊版插件與新版算出不同的鍵。
      multi: ROOM_MULTI,
      costLimit: this.#options.costLimit,
      // ⚠ 開口檔要自己一條佇列（見 `MatchCriteria.costFloor`）。不是開口檔時
      // 這一格是 null，算出來的鍵跟舊版一個位元都不差。
      costFloor: this.#openFloor,
    });
    // ⚠ 算一次就留著。`contentHash` 要把整份規則（700 筆）正規化過一遍，
    // 而配對成立時要拿它跟對手的標籤比 —— 每配到一個人就重算一次是白費的，
    // 而且規則在排隊期間不會變（換規則要先停止配對）。
    this.#myTag = ruleTag(key, contentHash(this.#options.rule));

    const link = this.#options.link ?? ((o) => new MatchQueueClient(o));
    this.#client = link({
      endpoint: this.#options.endpoint,
      key,
      tag: this.#myTag,
      onStatus: (s, waiting) => this.#onQueueStatus(s, waiting),
      onMatched: (info) => void this.#onMatched(info),
      onPeerDeck: (body) => void this.#onPeerDeck(body),
      onPeerEval: (body) => void this.#onPeerEval(body),
      onPeerPref: (body) => this.#onPeerPref(body),
      onRoom: (roomId) => void this.#onRoom(roomId),
      onDropped: (reason) => void this.#onDropped(reason),
      ...(this.#options.onLog === undefined ? {} : { onLog: this.#options.onLog }),
    });
    this.#client.start();
    // ⚠ 這裡還**沒有**連上中間人 —— 上面那行只是開始連。所以訊息要說的是
    // 「正在連」，`linked` 要等 `q-welcome` 才會變 true（見 `#onQueueStatus`）。
    this.#patch({
      phase: "queued",
      linked: false,
      message: "正在連中間人…",
    });
    this.#watchLobby();
  }

  /**
   * 牌組不在這一檔裡要說的那句話。
   *
   * ⚠ **一定要分「太高」與「太低」。** 兩者要玩家做的事完全相反，而
   * 「不符合這一檔」那種寫法會讓一個帶 40C 的人以為自己超標，然後往下改。
   */
  #bandMessage(check: LimitCheck, tail: string): string {
    const tier = String(this.#options.costLimit);
    const range = check.band ?? "";
    return check.over
      ? `你的隊伍在這份規則下是 ${check.total}，超過 COST ${tier} 這一檔的上限。` +
          `這一檔收 ${range}。${tail}`
      : `你的隊伍在這份規則下是 ${check.total}，低於 COST ${tier} 這一檔的下限。` +
          `這一檔收 ${range} —— 要再壓高一點，或改約低一檔。${tail}`;
  }

  /**
   * 排隊時盯著玩家還在不在約定的頻道，不在就自己停。
   *
   * ⚠ **只在 `queued` 的時候判。** 開房、進房那幾段離開 Match 場景是正常的
   * （進房成功的下一刻遊戲就切到對戰畫面了），在那裡判「不在大廳」等於把剛
   * 打起來的一場自己收掉。
   *
   * ⚠ **「玩家自己開了一間房」不是停止的理由。** 那是他的事，而且他多半就是
   * 想同時碰運氣。真的配到人時會替他把那間收掉（`#clearOwnRoom`）。
   */
  #watchLobby(): void {
    const every = this.#options.lobbyWatchMs ?? LOBBY_WATCH_MS;
    this.#clearLobby();
    if (every <= 0) return;

    const tick = async (): Promise<void> => {
      this.#lobby = null;
      // 已經停掉、或走到開房／進房那幾段了就不看這一輪。
      if (this.#client === null) return;
      if (this.#status.phase === "queued") {
        const context = await this.#options.driver.matchContext().catch(() => null);
        // ⚠ 那一次 CDP 往返之間可能已經被停掉了。回來要重看一次，否則會在一個
        // 已經結束的任務上呼叫 stop()，把下一次配對的狀態打回 idle。
        if (this.#client === null) return;
        // 讀不到就當這一輪沒看到 —— 遊戲重載中、CDP 剛斷都會這樣，而那些會自己
        // 好。把「問不到」當成「他走了」的話，每一次重載都會靜靜地停掉配對。
        if (context !== null) {
          const gone = this.#lobbyExit(context);
          if (gone !== null) {
            await this.stop(gone);
            return;
          }
          this.#currentChannel = context.channel;
        }
      }
      this.#lobby = setTimeout(() => void tick(), every);
    };

    this.#lobby = setTimeout(() => void tick(), every);
  }

  /** 玩家離開了嗎。`null` = 還在，字串 = 要顯示給他的理由。 */
  #lobbyExit(context: MatchContext): string | null {
    if (!context.inMatch) {
      return (
        "你已經不在對戰大廳了（進了一場對戰？），配對自動停止 —— " +
        "留在佇列上的話，你打完回來會發現有人開好房在等你。回大廳再按一次開始。"
      );
    }
    if (context.channel === null) {
      return "你已經退出頻道了，配對自動停止。回到頻道再按一次開始。";
    }
    if (context.channel !== this.#options.channel) {
      return (
        `你換到頻道 ${context.channel} 了，配對約定的是頻道 ${this.#options.channel} —— ` +
        `已自動停止。房間清單是分頻道推播的，兩個人不在同一個頻道就看不到對方的房。`
      );
    }
    return null;
  }

  /**
   * 把玩家自己開的那間房收掉。**guest 這半段專用**，而且只在真的要進房前叫。
   *
   * host 那半段不需要它 —— `#openRoom` 的 `#preflight()` 做的就是同一件事。
   * guest 這條路**沒有 preflight**，少了這一句，玩家人進了對手的房，自己那間
   * 會留在清單上等一個永遠不會來的人。
   *
   * ⚠ 排隊途中不叫 —— 玩家開房不是停止配對的理由（他可能想兩邊碰運氣），
   * 而在他還沒配到人的時候把房拆了，等於插件擅自取消了他的另一條路。
   *
   * ⚠ `delete_room` 是**頻道層級**的：收的是他在這個頻道的**所有**房。所以
   * 一定要先確認真的有房才叫，而且一定要寫進記錄檔 —— 玩家要知道那間房是被
   * 誰收的（見 match-session.ts 的檔頭）。
   */
  async #clearOwnRoom(): Promise<void> {
    const context = await this.#options.driver.matchContext().catch(() => null);
    if (context === null) return;

    let has = context.isMatching;
    if (!has && context.playerName !== null) {
      const snapshot = await this.#options.driver.roomSnapshot().catch(() => null);
      has = snapshot?.rooms.some((r) => r.playerAName === context.playerName) === true;
    }
    if (!has) return;

    this.#log("· 配到人了 —— 先幫你收掉自己開的那間房（那個指令是整個頻道一起收的）");
    await this.#options.driver.cancelRoom().catch(() => "");
    // 收房之後清單要一點時間才更新。等一拍，否則接下來的 preflight 會讀到
    // 剛剛那間還在，然後判定「你已經有一間自己開的房」。
    await (this.#options.sleep ?? defaultSleep)(1_000);
  }

  /**
   * 開房／進房前的檢查，**而且會自己把擋路的舊房收掉**。
   *
   * preflight 本身是唯讀的（那是對的，它也給手動那條路用）。但自動配對的
   * 情況不一樣：玩家按下「開始自動配對」，而畫面上跳一句「你已經有一間自己
   * 開的房，請先去遊戲裡收掉」對他沒有意義 —— 那間房**多半就是插件上一輪
   * 自己開的**（對手沒進來、或上一場打完了）。所以這裡直接收掉再檢查一次。
   *
   * ⚠ 這支同時是 host 那半段的 `#clearOwnRoom` —— 玩家在排隊途中自己開的那間
   * 房會在 `#openRoom` 叫它的時候被收掉。guest 那半段沒有 preflight，所以要
   * 自己叫一次 `#clearOwnRoom`。
   *
   * ⚠ `delete_room` 是**頻道層級**的：它會把玩家在這個頻道的房**全部**收掉，
   * 包含他自己手動開的那間。所以這件事一定要寫進記錄檔 —— 玩家要知道剛剛
   * 那間房是被誰收的（見 match-session.ts 的檔頭）。
   */
  async #preflight(): Promise<PreflightResult> {
    const first = await preflight(this.#options.driver, { expectChannel: this.#options.channel });
    if (first.ok) return first;
    if (first.block.code !== "has-own-room" && first.block.code !== "already-matching") {
      return first;
    }

    this.#log("· 你在這個頻道已經有一間開著的房，先幫你收掉（收的是整個頻道的房）");
    await this.#options.driver.cancelRoom().catch(() => "");
    // 收房之後清單要一點時間才更新。等一拍再問，否則會讀到剛剛那間還在。
    await (this.#options.sleep ?? defaultSleep)(1_000);
    return await preflight(this.#options.driver, { expectChannel: this.#options.channel });
  }

  /**
   * 停止配對。
   *
   * ⚠ **開過房就要收掉。** 留著的話清單上會有一間永遠不會有人進來的空房，
   * 而且玩家下一次配對會被 preflight 擋下來（「你已經有一間自己開的房」）。
   */
  async stop(reason = "已停止配對。"): Promise<void> {
    this.#clearTimer();
    this.#clearWatch();
    this.#clearLobby();
    this.#client?.stop();
    this.#client = null;
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#log("· 已收掉剛剛開的房");
    }
    this.#resetPair();
    this.#skipped = 0;
    this.#patch({ ...IDLE, message: reason });
  }

  /**
   * **配對成功地結束了** —— 對戰已經開始，這個任務沒事做了。
   *
   * 跟 `stop()` 的差別只有一個，但那一個很重要：**不收房**。房裡有人了，
   * 收掉就是把對手踢出去。所以先把 `#openedRoom` 清掉再走同一條收尾路徑。
   *
   * ⚠ 一定要回到 `idle`。留在 `ready` 的話托盤那邊的 `pairing` 物件不會被
   * 放掉，玩家打完這一場想再排一次只會收到「已經在配對中了」。
   */
  #finish(message: string): void {
    this.#clearTimer();
    this.#clearWatch();
    this.#clearLobby();
    this.#openedRoom = false;
    this.#handedOff = false;
    this.#client?.stop();
    this.#client = null;
    this.#resetPair();
    this.#skipped = 0;
    this.#log(`· ${message}`);
    this.#patch({ ...IDLE, message });
  }

  // -------------------------------------------------------------------------
  // 佇列事件
  // -------------------------------------------------------------------------

  #onQueueStatus(status: QueueStatus, waiting: number): void {
    if (status === "incompatible") {
      void this.stop("中間人的協定版本跟這個插件不合，請更新。");
      return;
    }
    if (status === "unreachable") {
      // ⚠ 停在 `blocked` 而不是 `idle`：這是**要玩家去做點什麼**的狀態
      // （檢查位址、檢查網路），不是「配對正常結束了」。停在 idle 的話畫面
      // 上跟「還沒開始配對」一模一樣，而玩家剛剛明明按了開始。
      //
      // ⚠ 走 `#block` 是安全的 —— 會走到這裡就代表連線**一次都沒成立過**，
      // 所以不可能已經開了房（開房要先配到人）。
      this.#block(
        "連不上中間人的配對佇列，已經停止排隊。這不是沒人跟你排 —— 是那條線根本沒接上。" +
          "檢查網路，或到「設置 › 連線」看中間人的位址；「設置 › 記錄」有每一次失敗的原因。",
      );
      return;
    }
    // ⚠ 只更新人數與「線上了沒」。phase 是**這支**在管的（對規則、開房…），
    // 讓連線層去覆寫它的話，一次重連就會把「正在開房」打回「排隊中」。
    const linked = status === "waiting" || status === "matched";
    // 已經在對規則／開房了就不要再改訊息 —— 那幾句是這支自己在管的。
    const stillQueueing = this.#status.phase === "queued";
    this.#patch({
      waiting,
      linked,
      ...(stillQueueing
        ? {
            message: linked
              ? "排隊中，等一個用同一份規則的人。"
              : // ⚠ 這句要指得出下一步。「連線中」對玩家沒有用 —— 他要知道的是
                // 「這不是在等對手，是根本還沒連上」。
                "連不上中間人的配對佇列，還在重試 —— 這不是在等對手。" +
                "檢查網路，或到「設置 › 連線」看中間人的位址。",
          }
        : {}),
    });
  }

  async #onMatched(info: { role: QueueRole; token: string; peerTag: string }): Promise<void> {
    this.#resetPair();
    this.#role = info.role;
    this.#token = info.token;

    // ⚠ **兩邊都要送，而且要在最前面送。** 開房的是 host，但誰是 host 是中間人
    // 剛剛才決定的 —— guest 不送的話，host 永遠只看得到自己那個地點。
    // 這一則在 EXACT 快路上也要送（那條路連牌組都不交換）。
    this.#client?.sendPref(encodePrefBody({ stage: this.#options.room.stage }));

    // 每一次配對都重讀牌組 —— 玩家在排隊時換牌組是很正常的事。
    const deck = await this.#readOwnDeck();
    if (deck === null) return;

    // ⚠ **頻道也要重看一次。** 配對鍵裡的頻道是按下「開始配對」那一刻的，而排隊
    // 是會等的 —— 玩家完全可能在等的時候切去別的頻道。少了這一關的症狀分兩種，
    // 兩種都很難懂：host 會在新頻道開一間房（對手在舊頻道看不到它），guest 會
    // 在新頻道的清單裡找一個不存在的 room_id 找到逾時。
    //
    // 房間清單是**分頻道推播**的，所以「兩個人都在同一個頻道」不是設定問題，
    // 是這件事成不成立的前提。
    if (this.#currentChannel !== null && this.#currentChannel !== this.#options.channel) {
      await this.stop(
        `你已經換到頻道 ${this.#currentChannel} 了，配對約定的是頻道 ${this.#options.channel}。` +
          `回到那個頻道再排一次。`,
      );
      return;
    }

    const check = checkOwnDeck(this.#options.rule, deck, this.#options.costLimit, this.#openFloor);
    this.#patch({
      myTotal: check.total,
      overLimit: check.over,
      underLimit: check.under,
      band: check.band,
      role: info.role,
    });
    if (outOfBand(check)) {
      // 排隊時檢查過了，所以會走到這裡只有一種可能：玩家在等的時候換了牌組。
      await this.stop(this.#bandMessage(check, "改好再按一次開始。"));
      return;
    }

    if (info.peerTag === this.#myTag && this.#openFloor === null) {
      // 快路：同一份規則，連牌組都不用交換 —— 對手帶什麼我們永遠不會知道。
      //
      // ⚠⚠ **開口檔（COST90+）走不了這條。** 那一檔的條件是「兩副牌差 ±5 C」，
      // 而那個判斷需要對手的總和 —— 不交換牌組就算不出來。規則相同時仍然標成
      // `exact`（那是事實），只是多走一趟交換。
      this.#compatibility = "exact";
      this.#patch({
        compatibility: "exact",
        phase: "checking",
        message: "規則版本相同，準備開房。",
      });
      await this.#commit();
      return;
    }

    // 開口檔走到這裡時標籤可能是一樣的（快路被 ±5 窗口擋掉了）—— 先記下來，
    // 驗算過了之後才判得出要說「版本相同」還是「版本不同但相容」。
    if (info.peerTag === this.#myTag) this.#compatibility = "exact";
    this.#patch({
      phase: "checking",
      message:
        info.peerTag === this.#myTag
          ? "正在確認兩邊的 COST 差距在範圍內…"
          : "對手的規則是另一個版本，正在確認這一場算出來的東西一不一樣…",
    });
    this.#client?.sendDeck(encodeDeckBody(deck));
    this.#armTimeout("對手沒有在時限內回應，換下一位。");
    // ⚠ 一定要在這裡再叫一次。讀牌組是 `await`（一次 CDP 往返），對手的
    // `q-deck` 完全可能在那幾十毫秒裡就到了 —— 那時 `#tryCross` 因為
    // 「我的牌組還沒讀到」而提早 return，之後就**沒有任何東西會再觸發它**，
    // 兩邊一起等到逾時。
    await this.#tryCross();
  }

  async #onPeerDeck(body: string): Promise<void> {
    const peer = parseDeckBody(body);
    if (peer === null) {
      await this.#nextOpponent("對手送來的牌組描述子看不懂（版本不同？），換下一位。");
      return;
    }
    this.#peerDeck = peer;
    await this.#tryCross();
  }

  /**
   * 對手說了他要哪一種抽法。
   *
   * ⚠ 看不懂就當他沒說（`#peerStage` 保持 `null` → 用我自己的）。這一則壞掉
   * 不該影響開房 —— 地點協商是加分，不是開打的前提。
   */
  #onPeerPref(body: string): void {
    const pref = parsePrefBody(body);
    if (pref !== null) this.#peerStage = pref.stage;
    // host 可能正卡在 `#resolveStage()` 上等這一則。
    const wake = this.#stageWaiter;
    this.#stageWaiter = null;
    wake?.();
  }

  async #onPeerEval(body: string): Promise<void> {
    const peer = parseEvalBody(body);
    if (peer === null) {
      await this.#nextOpponent("對手送來的指紋看不懂，換下一位。");
      return;
    }
    this.#peerEval = peer;
    await this.#tryCross();
  }

  /**
   * 兩副牌都在手上就算指紋；兩邊的指紋都在手上就下判決。
   *
   * ⚠ 寫成「湊齊了就往下走」而不是照順序等：訊息的到達順序不保證 ——
   * 對手可能在我還沒送出描述子時就把他的送過來了。
   */
  async #tryCross(): Promise<void> {
    const mine = this.#myDeck;
    const peer = this.#peerDeck;
    if (mine === null || peer === null) return;

    if (this.#myEval === null) {
      const decks =
        this.#role === "host" ? { host: mine, guest: peer } : { host: peer, guest: mine };
      this.#myEval = crossEvaluate(this.#options.rule, decks);
      this.#client?.sendEval(encodeEvalBody(this.#myEval));
    }

    if (this.#peerEval === null) return;

    const verdict = crossVerdict(this.#myEval, this.#peerEval);
    if (verdict === "incompatible") {
      const why = describeDisagreement(this.#myEval, this.#peerEval);
      await this.#nextOpponent(`規則版本不相容 —— ${why}換下一位。`);
      return;
    }

    /**
     * 開口檔（`COST90+`）的 ±5 窗口。
     *
     * ⚠ **要在驗算過了之後才判。** 順序反過來的話，我們會拿「我的規則算出來的
     * 對手總和」去做決定，而那個數字在規則不相容時根本不成立 —— 兩邊會得到
     * 不同的答案，於是一邊開了房、另一邊不進來。
     *
     * ⚠ 差距**只當閘門**：不 `#patch` 進畫面、不寫進記錄檔（§7 那條線）。
     * 訊息也只說「差太多」，不說對手幾 C。
     */
    if (this.#openFloor !== null) {
      const mineCenti = teamCostCenti(this.#options.rule, mine);
      const peerCenti = teamCostCenti(this.#options.rule, peer);
      const window = toCentiCost(OPEN_TIER_WINDOW);
      if (Math.abs(mineCenti - peerCenti) > window) {
        await this.#nextOpponent(
          `對手的 COST 跟你差超過 ${OPEN_TIER_WINDOW}C（${formatCostTag(null, this.#openFloor)} 的配對範圍），換下一位。`,
        );
        return;
      }
    }

    // ⚠ 標籤一樣就是 `exact`，即使我們剛剛交換過牌組（開口檔一定會交換）。
    // 寫成 `compatible` 會讓畫面說「版本不同」，而那是假的。
    const exact = this.#compatibility === "exact";
    this.#compatibility = exact ? "exact" : "compatible";
    this.#clearTimer();
    this.#patch({
      compatibility: this.#compatibility,
      message: exact
        ? "規則版本相同、COST 差距也在範圍內 —— 可以打。"
        : "版本不同，但這一場算出來的東西完全一樣 —— 可以打。",
    });
    await this.#commit();
  }

  // -------------------------------------------------------------------------
  // 開房 / 進房
  // -------------------------------------------------------------------------

  /** 驗算過了，真的去動遊戲。⚠ 這之後才會消耗 AP。 */
  async #commit(): Promise<void> {
    if (this.#committing) return;
    this.#committing = true;
    try {
      if (this.#role === "host") await this.#openRoom();
      else await this.#joinWhenReady();
    } finally {
      this.#committing = false;
    }
  }

  async #openRoom(): Promise<void> {
    const token = this.#token;
    if (token === null) return;

    // ⚠ 這裡也要走會收舊房的那支 —— 它同時是 host 這半段的 `#clearOwnRoom`：
    // 玩家在排隊途中自己開的那間房會被它收掉。配到人之後才被「你已經有一間房」
    // 擋下來的話，對手已經在等我開房了。
    const pre = await this.#preflight();
    if (!pre.ok || pre.context.playerName === null) {
      await this.stop(pre.ok ? "讀不到玩家名稱。" : pre.block.message);
      return;
    }

    // ⚠ 地點要在開房**之前**談完 —— 房一開出去就改不了了。
    const stage = await this.#resolveStage();
    this.#patch({ phase: "opening", stage, message: "開房中…" });
    const result = await hostOpenRoom(this.#options.driver, {
      playerName: pre.context.playerName,
      room: {
        // ⚠ 房名是**系統組的**，玩家取不到（見 `buildRoomName`）。它同時是
        // `hostOpenRoom` 在清單裡認出「哪一間是我剛開的」的依據之一，所以這裡
        // 跟那邊一定要是同一個字串 —— 傳同一個表達式就不會漂。
        name: buildRoomName(this.#options.rule.name, this.#options.costLimit, this.#openFloor),
        stage,
        multi: ROOM_MULTI,
        friend: this.#options.room.friend,
        // ⚠ 房間密碼就是配對 token。**房名絕對不能帶它**，房名是公開的。
        pass: token,
        // ⚠ 遊戲自己的「牌組Cost限制 ±N」永遠不設（見 `ROOM_DECK_COST_BAND`）
        // —— 它判的是伺服器算的原版 COST，跟約定的自訂上限是兩回事，而後者
        // 我們自己在上面查過了。
        cost: ROOM_DECK_COST_BAND,
      },
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    });

    if (!result.ok) {
      if (result.needsCancel) await this.#options.driver.cancelRoom().catch(() => "");
      await this.stop(`開房失敗：${result.reason}`);
      return;
    }

    this.#openedRoom = true;
    this.#myRoomId = result.roomId;
    this.#client?.sendRoom(result.roomId);
    this.#handedOff = true;
    this.#patch({ phase: "ready", message: "房開好了，等對手進來。" });
    // 從這裡開始，判斷「成了沒」的依據是**遊戲**而不是佇列 —— 對手的插件
    // 進了房就會離開佇列，那在佇列眼裡跟「他取消了」長得一模一樣。
    this.#watchHandoff(result.roomId);
  }

  /**
   * host：這一場開在哪。等對手回報他的抽法（最多 `STAGE_WAIT_MS`），然後協商。
   *
   * ⚠ **等不到就用自己的，不是停下來。** 對手可能是舊版插件，或中間人還沒有
   * `q-pref` 那條轉發 —— 那時協商不成立，但這一場照樣要打得起來。
   */
  async #resolveStage(): Promise<string> {
    const mine = this.#options.room.stage;
    const wait = this.#options.stageWaitMs ?? STAGE_WAIT_MS;
    // ⚠ `wait <= 0` 要**完全不等**，不是等 0 毫秒。等 0 仍然是一個 macrotask，
    // 而那會讓「配到人」到「開房」之間多一次事件迴圈 —— 測試裡看得到，真的
    // 跑起來也只是白等一拍。
    if (this.#peerStage === null && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#stageWaiter = null;
          resolve();
        }, wait);
        this.#stageWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    const theirs = this.#peerStage;
    const stage = negotiateStage(mine, theirs, this.#options.roll ?? Math.random);
    const label = (pick: StagePick): string => (pick === "arcadia" ? "亞城隨機" : "官方隨機");
    if (theirs === null) {
      this.#log(`· 對手沒有回報抽法（舊版插件？），用我選的${label(mine)}`);
    } else if (theirs === mine) {
      this.#log(`· 雙方都選${label(mine)}`);
    } else {
      this.#log(`· 抽法不同（我${label(mine)} / 對手${label(theirs)}）→ 走官方隨機`);
    }
    this.#log(
      stage === RANDOM_STAGE
        ? "· 這一場的地點交給伺服器抽"
        : `· 這一場抽到地點 ${stage}（亞城池 ${ARCADIA_STAGES.length} 張）`,
    );
    return stage;
  }

  /**
   * host：等對手真的進來，然後結束這個配對任務。
   *
   * 判準是房間清單（遊戲自己的狀態，不是佇列的）：
   *
   * | 看到什麼                     | 意思                             |
   * | ---------------------------- | -------------------------------- |
   * | 我那間房多了 playerB         | 對手進來了                       |
   * | 我那間房從清單上消失         | 已經開打（對戰中的房不在清單上） |
   * | 逾時還是只有我               | 沒人來 —— 收房、停止             |
   *
   * ⚠ 清單「空的」與「還不知道」要分開。剛連上時 `seq === 0` 且沒有 live 快照，
   * 那時什麼都不能推論 —— 把它當成「房不見了」會在對手還沒進來時就宣告開打。
   */
  #watchHandoff(roomId: string): void {
    const pollMs = this.#options.handoffPollMs ?? HANDOFF_POLL_MS;
    const deadline = Date.now() + (this.#options.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);

    const poll = async (): Promise<void> => {
      this.#watch = null;
      // 中途被停掉／被拆對了就不要再看下去。
      if (!this.#handedOff || this.#myRoomId !== roomId) return;

      let joined = false;
      let gone = false;
      try {
        const snapshot = await this.#options.driver.roomSnapshot();
        const mine = snapshot.rooms.find((r) => r.roomId === roomId);
        if (mine === undefined) gone = snapshot.live || snapshot.seq > 0;
        else joined = mine.playerBName !== null;
      } catch {
        // 讀不到就當這一輪沒看到，下一輪再問。連線斷了的話 stop() 會收掉這個迴圈。
      }
      if (!this.#handedOff || this.#myRoomId !== roomId) return;

      if (joined || gone) {
        this.#finish(joined ? "對手進房了，對戰開始 —— 配對結束。" : "房間已經開打，配對結束。");
        return;
      }
      if (Date.now() >= deadline) {
        await this.stop("等不到對手進房，已經把房收掉。要再排一次請按「開始自動配對」。");
        return;
      }
      this.#watch = setTimeout(() => void poll(), pollMs);
    };

    this.#clearWatch();
    this.#watch = setTimeout(() => void poll(), pollMs);
  }

  async #onRoom(roomId: string): Promise<void> {
    this.#pendingRoomId = roomId;
    // ⚠ 走 `#commit()` 而不是直接叫 `#joinWhenReady()`：那支會 await 一段長達
    // 二十秒的輪詢，而房號可能在它跑到一半時又來一次（重連、host 重送）。
    // 沒有那道重入鎖的話會同時送出兩次 `room_in`。
    await this.#commit();
  }

  /**
   * guest 端：驗算過了**而且**房號到手才進去。
   *
   * ⚠ 兩個條件的順序不固定 —— host 可能在我收到他的指紋之前就把房開好了
   * （他只需要**我的**指紋就能下判決）。所以兩邊都要能觸發這一支。
   */
  async #joinWhenReady(): Promise<void> {
    const roomId = this.#pendingRoomId;
    const token = this.#token;
    if (roomId === null || token === null || this.#compatibility === null) return;

    this.#clearTimer();
    this.#patch({ phase: "joining", message: "對手的房開好了，進房中…" });
    // ⚠ guest 這邊也要收自己的房。host 那條路是 `#preflight()` 順手收掉的，
    // 而這條路**沒有 preflight** —— 少了這一句，玩家在排隊途中自己開的那間房
    // 會一直留在清單上（他人已經進了對手的房，那間永遠不會有人來），而下一次
    // 配對會被「你已經有一間自己開的房」擋住，症狀完全看不出跟這一場有關。
    await this.#clearOwnRoom();
    const result = await guestJoinRoom(this.#options.driver, {
      roomId,
      pass: token,
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    });

    if (!result.ok) {
      await this.stop(`進房失敗：${result.reason}`);
      return;
    }
    // 進房成功 = 這次配對的任務結束。留在佇列上只會被配給下一個人，而留在
    // `ready` 會讓玩家打完之後按不了「開始自動配對」。
    this.#finish("已進房，對戰開始 —— 配對結束。");
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  async #onDropped(reason: DropReason): Promise<void> {
    // ⚠⚠ **房號已經交出去、而對手是「取消」的話，那多半是他進房成功了。**
    //
    // 對手的插件一進房就會離開佇列，而離開佇列送的正是 `q-cancel` —— 在佇列
    // 眼裡跟玩家自己按停止一模一樣。照下面那段處理（收房 + 退回排隊）等於在
    // 對手剛進門的瞬間把房拆掉，然後去排下一個人，而畫面上寫「對手取消了」。
    // 2026-08-16 實測：host 那邊確實就是這句話，而那一場其實已經打起來了。
    //
    // `gone`（連線斷了）不一樣 —— 那是真的走了，照舊收房退回佇列。
    // 分不出「他取消了」與「他進去了」的那個灰區交給 `#watchHandoff` 用**遊戲
    // 的狀態**判：房裡有沒有人，那是唯一的事實來源。
    if (this.#handedOff && reason === "cancel") {
      this.#log("· 對手離開佇列了（多半是進房成功）—— 看房間裡有沒有人再決定");
      return;
    }

    this.#clearTimer();
    this.#clearWatch();
    // ⚠ 對手在我開好房之後跑掉 —— 房要收掉，否則會留一間空房，而且下一次
    // 配對會被 preflight 擋住。
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#log("· 對手跑掉了，已收掉剛剛開的房");
    }
    this.#resetPair();
    this.#patch({
      phase: "queued",
      role: null,
      compatibility: null,
      message:
        reason === "rejected"
          ? "跟剛剛那位的規則版本算出來的東西不一樣，繼續找下一位。"
          : "對手取消了，繼續排隊。",
    });
  }

  /** 這一對不算數，但我還要繼續排。 */
  async #nextOpponent(message: string): Promise<void> {
    this.#clearTimer();
    if (this.#openedRoom) {
      await this.#options.driver.cancelRoom().catch(() => "");
      this.#openedRoom = false;
    }
    this.#skipped += 1;
    this.#log(`· ${message}`);
    this.#resetPair();
    this.#client?.reject();
    this.#patch({
      phase: "queued",
      role: null,
      compatibility: null,
      skipped: this.#skipped,
      message,
    });
  }

  /**
   * 讀自己的牌組。讀不到就停在 `blocked` —— 猜一副牌是絕對不行的。
   *
   * 順便把**當下的頻道**記下來（`#currentChannel`），呼叫端要靠它確認玩家
   * 還在約定的頻道裡。同一次 CDP 往返就拿得到，不必再問一次。
   */
  async #readOwnDeck(): Promise<DeckDescriptor | null> {
    const context = await this.#options.driver.matchContext().catch(() => null);
    this.#currentChannel = context?.channel ?? null;
    const keys = context?.deckKeys ?? null;
    if (keys === null) {
      this.#block("讀不到你的牌組。請在遊戲裡回大廳、確認選好了出戰牌組再試。");
      return null;
    }
    const deck = deckFromKeys(keys);
    if (deck.characters.length === 0) {
      this.#block("你的出戰牌組是空的。先去編一副再配對。");
      return null;
    }
    this.#myDeck = deck;
    return deck;
  }

  #armTimeout(message: string): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#nextOpponent(message);
    }, this.#options.timeoutMs ?? PEER_REPLY_TIMEOUT_MS);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** 停掉「等對手進房」的輪詢。⚠ 每一條收尾路徑都要叫，否則它會繼續看一間 */
  /** 已經不屬於這次配對的房。 */
  #clearWatch(): void {
    if (this.#watch !== null) clearTimeout(this.#watch);
    this.#watch = null;
  }

  /**
   * 停掉「玩家還在不在大廳」的輪詢。
   *
   * ⚠ 每一條收尾路徑都要叫。留著的話它會在任務結束之後繼續每 5 秒戳一次遊戲，
   * 而且下一次配對開始時會有兩個迴圈在跑（第二個 `#watchLobby` 覆蓋不掉第一個
   * 排好的 timer —— 那個 handle 已經被換掉了）。
   */
  #clearLobby(): void {
    if (this.#lobby !== null) clearTimeout(this.#lobby);
    this.#lobby = null;
  }

  #resetPair(): void {
    this.#role = null;
    this.#token = null;
    // ⚠ 自己的牌組也要清掉。留著上一對讀到的那副，而對手的 `q-deck` 在我
    // 重讀牌組（一次 CDP 往返）之前就到的話，`#tryCross` 會拿**上一場的**
    // 牌組去算指紋 —— 算出來的東西是自洽的，只是跟等一下真的要打的那副
    // 沒有關係。這種錯誤不會有任何錯誤訊息。
    this.#myDeck = null;
    this.#peerDeck = null;
    this.#myEval = null;
    this.#peerEval = null;
    this.#compatibility = null;
    this.#pendingRoomId = null;
    this.#openedRoom = false;
    this.#myRoomId = null;
    this.#handedOff = false;
    // ⚠ 對手的地點也要清掉 —— 留著上一位的偏好，下一場會用一個從來沒有人
    // 在這一對裡說過的地點開房。
    this.#peerStage = null;
    // 卡在等地點的那個 await 要放掉，否則它會等到逾時才醒（而那時這一對
    // 早就換人了）。
    const wake = this.#stageWaiter;
    this.#stageWaiter = null;
    wake?.();
    this.#clearWatch();
  }

  #block(message: string): void {
    this.#client?.stop();
    this.#client = null;
    this.#clearTimer();
    this.#clearWatch();
    this.#clearLobby();
    this.#patch({ phase: "blocked", role: null, compatibility: null, message });
  }

  #patch(patch: Partial<PairingStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#options.onStatus?.(this.#status);
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }
}
