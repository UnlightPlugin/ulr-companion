/**
 * 具名配置的規則（純函式，無 I/O）
 * ==================================
 * 多開的骨架。一份配置 = 「一個遊戲客戶端要怎麼接」，玩家在設定頁維護一張
 * 清單，按「開新實例」就再開一個托盤視窗綁另一份 —— MAA 的「切換配置」是
 * 同一個形狀，理由也一樣：**埠寫在命令列的話，一般玩家永遠開不了第二個。**
 *
 * ⚠ **這個檔案不 import electron。** 落地在 `profiles.ts`，規則在這裡。
 * 分開的理由跟 `arbiter-link/protocol.ts` 一樣：這裡面有三條「錯了會安靜地
 * 壞掉」的規則，而它們必須測得到 ——
 *
 * 1. 兩份配置**不能用同一個遊戲埠**（撞到的話第二份根本開不起來）
 * 2. **最後一份刪不掉**（清單空了視窗沒有東西可綁，而且沒有 UI 救得回來）
 * 3. `--port` 對不上任何配置時要開**臨時配置**，不是拒絕啟動
 */

import type { LinkPrefs } from "@ulr/arbiter-link";
import { DEFAULT_LINK_TARGET, normalizePrefs } from "@ulr/arbiter-link";
import { DEFAULT_STAGE_PICK, RANDOM_STAGE } from "@ulr/arbiter-engine";
import type { StagePick } from "@ulr/arbiter-engine";
import {
  BROWSER_DEBUG_PORT,
  DEFAULT_BROWSER_PROFILE_DIR,
  DEFAULT_DEBUG_PORT,
  desktopUserDataDir,
  normalizeTint,
} from "@ulr/cdp-adapter";

/** 客戶端種類。只影響提示文字與預設埠，不影響接線方式（兩邊都是 CDP）。 */
export type ClientKind = "desktop" | "web";

/**
 * 自動配對開房時要用的設定。
 *
 * ⚠ **一定要記在設定檔裡。** 這些是玩家的約定（常打的檔位、地點抽法），而
 * 自動配對是「按一顆按鈕就開打」的功能 —— 每次重開插件都要重填一輪的話，
 * 那顆按鈕就不是一顆按鈕了。
 *
 * ⚠ 這裡**不記官方的 COST 檔位**（57/66/78 那幾顆），它們每週二會變，插件每次
 * 都現讀。記的是玩家自己填的那個數字 —— 那是他的約定，不是遊戲的狀態。
 *
 * ⚠ **沒有房名這一格了。** 房名改成系統照「規則名 + 檔位」組（`buildRoomName`），
 * 因為自動配對要取代亞歷山卓城的快速比賽，而那邊的房名長這樣：
 * `Quickmatch [COST:57]` —— 大廳裡的人一眼就看得出那是哪一檔。讓玩家自己取的話
 * 那個資訊就沒了，而它正是這個功能能不能取代亞城的關鍵。
 *
 * ⚠ **也沒有「對戰規則」與「牌組Cost限制 ±N」這兩格了**，同一個理由再往下推：
 * 插件開的房固定 3vs3、固定不設 ±N（`@ulr/arbiter-engine` 的 `ROOM_MULTI` 與
 * `ROOM_DECK_COST_BAND`，兩支都寫了為什麼）。3vs3 那格還特別貴 —— 它**進配對鍵**，
 * 留著等於把本來就不多的人潮劈成兩半。
 */
export interface MatchPrefs {
  /**
   * 地點誰來抽 —— `arcadia`（插件從 000~010 抽）或 `official`（伺服器抽）。
   *
   * ⚠ **玩家選不到「哪一張地圖」**，只能選抽法。理由見 `@ulr/arbiter-engine`
   * 的 `StagePick`：開房的只有 host，指定地圖對另一邊永遠是單方面的。
   */
  stage: StagePick;
  /**
   * 要不要設約定的自訂 COST 檔位。**進配對鍵**，由插件自己檢查。
   *
   * ⚠ `limit` 是這一檔的**上限**，實際收的是 `limit − 0.99` 到 `limit`
   * （見 `@ulr/arbiter-engine` 的 `COST_BAND_WIDTH`）—— 跟亞城的 `COST57`
   * 同一個意思。
   */
  limitOn: boolean;
  limit: number;
}

/** 新裝就是這樣：亞城池抽地點、不設約定檔位。 */
export const DEFAULT_MATCH_PREFS: MatchPrefs = {
  stage: DEFAULT_STAGE_PICK,
  limitOn: false,
  limit: 62,
};

/**
 * 舊設定檔那格是三位數的地點代號（`000`~`014`），現在是抽法。
 *
 * ⚠ **要搬，不能直接丟。** 直接丟的話每個既有使用者升級之後都會被拉回預設，
 * 而選過「隨機」的那些人是明確表示過「不要插件替我抽」的 —— `014` 對應
 * `official`，其餘（他指定了某一張）對應預設的亞城池，因為「指定某一張」
 * 這個選項已經沒有了。
 */
function normalizeStage(raw: unknown): StagePick {
  if (raw === "arcadia" || raw === "official") return raw;
  if (raw === RANDOM_STAGE) return "official";
  return DEFAULT_STAGE_PICK;
}

function normalizeNumber(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) return fallback;
  // ⚠ 夾到兩位小數：約定上限**進配對鍵**（`matchCriteriaString` 用 toFixed(2)），
  // 三位小數會讓「畫面上的數字」跟「實際比的數字」不一樣。
  return Math.round(n * 100) / 100;
}

export function normalizeMatchPrefs(raw: unknown): MatchPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_MATCH_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    // ⚠ 舊設定檔的 `roomName`、`multi`、`bandOn`/`band` 刻意**不搬過來**（連讀
    // 都不讀）。這三樣現在都是系統決定的，留一個沒人用的欄位在設定檔裡只會讓
    // 下一個讀這支的人以為它還有效。
    //
    // ⚠ 這對**選過 1vs1 的人是一次行為改變**：他下次排隊會排進 3vs3 那條佇列。
    // 那是刻意的（見 `MatchPrefs` 的說明），而且是**唯一**誠實的做法 —— 悄悄
    // 沿用舊值的話，他會排在一條沒有 UI 顯示、也沒有 UI 改得掉的隊伍上。
    stage: normalizeStage(r["stage"]),
    limitOn: r["limitOn"] === true,
    limit: normalizeNumber(r["limit"], DEFAULT_MATCH_PREFS.limit, 999),
  };
}

export interface Profile {
  /** 穩定識別。改名不會換 id —— 命令列參數帶的是它。 */
  id: string;
  name: string;
  /** 遊戲的 CDP 埠。**這也是實例的身分**（見 `main.ts` 的 userData 分離）。 */
  port: number;
  /**
   * 中間人在哪。**要跟對手指到同一個**，預設值就是為了不用設定。
   *
   * 一個字串而不是埠號，因為它現在有兩種可能（階段 3）：
   * `local` = 同一台電腦上的另一個插件（雙開）；`wss://…` = 雲端的中間人，
   * 那才配得到真正的對手。解析在 `parseLinkTarget()`，怎麼填都對。
   */
  link: string;
  kind: ClientKind;
  prefs: LinkPrefs;
  /**
   * 準備中把 OK 鈕染成什麼顏色。`null` = 不染色（官方原本的樣子），預設。
   *
   * ⚠ **跟 `prefs` 分開放。** `prefs` 是 `LinkPrefs`，那是會送給對手協商的
   * 東西；顏色只改我自己畫面上的一個像素，對手看不到也拿不到好處。混在一起
   * 的話，改個顏色就會觸發一次協商廣播。
   */
  readyTint: number | null;
  /**
   * 自訂 COST 規則檔的路徑。`null` = 不套用（原版數字）。
   *
   * ⚠ 存**路徑**而不是規則內容。理由有兩個：規則檔有 700 個鍵，塞進設定檔
   * 會讓它膨脹到幾十 KB 且每次存檔都重寫；而且玩家在外面改了那個檔之後，
   * 存路徑的話重開就是新的，存內容的話會安靜地跑舊規則。
   *
   * 代價是檔案被刪或搬走時要處理 —— `main.ts` 載入失敗時會清成 `null`
   * 並在記錄裡講一句，不是安靜地當作沒選。
   */
  costRulePath: string | null;
  /**
   * 把隱藏地圖（010~013）加進遊戲自己的開房選單。預設**關閉**。
   *
   * ⚠ 一定要記在配置裡。補丁是 `Runtime.evaluate` 裝的，**遊戲一重載就沒了**
   * —— 不記的話玩家隔天開遊戲會發現選單又只剩官方那 11 項，而他不會把這件事
   * 跟「重載過」連在一起，只會覺得功能壞了。
   *
   * ⚠ 這是**每一份配置各自的**，跟 `launchAtLogin` 那種全域選項不同：兩個
   * 客戶端可以一個開一個關。
   */
  hiddenStages: boolean;
  /**
   * 自動配對的開房設定（房名、地點、上限…）。
   *
   * ⚠ 跟 `prefs`（會送給對手協商的那些）分開放：這裡的東西**只影響我這一邊
   * 怎麼開房**，對手看到的是開好的房。地點是唯一會被協商的，而協商發生在
   * 配對成立之後，不是在這裡。
   */
  match: MatchPrefs;
  /**
   * 「編輯 COST」裡按一下上下鍵動多少（解析度）。
   *
   * ⚠ 預設是 **1**，不是 0.01。`step` 同時決定上下鍵與滾輪的幅度，而 COST 幾乎
   * 都是整數 —— 0.01 的意思是「把一張卡從 13 調到 14 要按一百次」。要小數的
   * 場合真的有（壓 C 邊界那種 x.99），所以做成可調而不是寫死。
   *
   * ⚠ 一定要記在配置裡。這是每次開編輯器都會用到的東西，每次都要重設一遍的
   * 偏好等於沒有這個功能。
   */
  editStep: number;
  /**
   * 「最小單位」檢查用的值。**0 = 不檢查**，預設。
   *
   * ⚠ 這**不是規則檔的欄位**，是編輯器的工具設定 —— 完整理由見
   * {@link normalizeEditUnit}。作者要讓別人知道自己用什麼單位，寫進**描述**。
   */
  editUnit: number;
}

/**
 * 上下鍵的幅度只收這幾個 —— 但**不是下拉選單的全部**：畫面另外讓玩家自己打
 * 一個數字（見編輯 COST 那一頁）。這幾個只是快速鍵。
 */
export const EDIT_STEPS = [1, 0.5, 0.1, 0.05, 0.01] as const;
export const DEFAULT_EDIT_STEP = 1;

/**
 * 「最小單位」的快速鍵。同樣**不是全部** —— 畫面讓作者自己打一個數字。
 *
 * 為什麼是這幾個：它們都**除得盡 1**（2×0.5、4×0.25、5×0.2、10×0.1），所以
 * 一份用它們定價的表湊得出整數。0.33 那種除不盡的也填得進去（自己打），
 * 檢查照樣跑 —— 只是那時 `0.33 × 3 = 0.99`，畫面會誠實地說這件事。
 */
export const EDIT_UNITS = [1, 0.5, 0.25, 0.2, 0.1] as const;

/**
 * 檢查用的最小單位。**0 = 不檢查**，那也是預設。
 *
 * ⚠ 這是**編輯器的工具設定，不是規則檔的欄位**。規則檔裡沒有這個東西，理由
 * 有兩層：
 *
 * 1. 它是**作者端的約束**，不是比賽規則。兩份規則把這一場的每張卡定成一樣的
 *    價就是打得起來，跟作者宣告自己用 0.5 還是 0.01 無關 —— 寫進規則檔會讓
 *    它進 contentHash，於是「顆粒度改了但價格一格沒動」的兩版看起來是不同的
 *    規則（docs/match-making.md §2 整節在反對的那件事）。
 * 2. 真要讓別人知道，作者寫進**描述**就好（「編輯描述」那一頁）—— 那是給人
 *    看的自由文字，引擎永遠不解析它。
 *
 * 所以這個值跟著**玩家**走而不是跟著規則走：換一份規則來編要自己重設。
 *
 * ⚠ 跟 `editStep`（上下鍵幅度）**是兩個不同的東西**，不要合併。幅度是「我想
 * 按幾下」，單位是「這份表允許出現什麼值」—— 作者完全可能用 0.01 的幅度去微調
 * 一張最小單位 0.5 的表（然後靠檢查抓回來）。
 */
export function normalizeEditUnit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 0;
  // 夾到兩位小數：COST 值本身就只到兩位（`toCentiCost` 對三位小數會拋例外），
  // 一個三位小數的單位會讓每一格都判成不合，而那個結果沒有意義。
  const rounded = Math.round(n * 100) / 100;
  return rounded <= 0 ? 0 : rounded;
}

/**
 * 夾一個合法的幅度。
 *
 * ⚠ **0 與負數一定要擋掉。** `<input step="0">` 在 Chromium 裡等於「上下鍵完全
 * 不動」，而那看起來就是鍵盤壞了；負數則會讓上鍵變成往下。壞值一律退回 1。
 *
 * 上限 100：再大就不是「調價格」而是誤觸了。夾到兩位小數的理由跟價格一樣 ——
 * 三位小數的 step 會產生 `toCentiCost` 收不下的值。
 */
export function normalizeEditStep(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return DEFAULT_EDIT_STEP;
  const rounded = Math.round(n * 100) / 100;
  return rounded <= 0 ? DEFAULT_EDIT_STEP : rounded;
}

export interface ProfileStore {
  profiles: Profile[];
  /** 最後一次開的那份。下次不帶參數啟動就用它。 */
  lastUsedId: string | null;
  /**
   * 隨 Windows 開機啟動。
   *
   * ⚠ 這是**整個程式**的設定，不是某一份配置的。放在配置裡的話，玩家會遇到
   * 「我在小號那份關掉了，主帳號那份又把它打開」。
   */
  launchAtLogin: boolean;
  /** 啟動時不要跳視窗，只留托盤圖示。 */
  startMinimized: boolean;
  /**
   * 進階：同時管兩個遊戲客戶端（多開）。**預設關閉。**
   *
   * ⚠ 這是給**完全不知道有多開這回事**的玩家設計的。關著的時候整套多開的
   * 概念都不出現：沒有「配置」那一頁、托盤沒有「開新實例」、狀態列與視窗
   * 標題不寫埠號。一個玩家裝完就是一個視窗管一個遊戲，不必知道埠是什麼。
   *
   * 打開之後「配置」才出現，而且**放在設置的最後一格（關於的下面）** ——
   * 它是整個介面裡優先級最低的東西：只有已經知道自己要多開的人才會去找它。
   */
  multiProfile: boolean;
}

const DESKTOP_PORT = DEFAULT_DEBUG_PORT;
/**
 * 網頁版的預設埠 —— 桌面版 +1，一眼看得出是一對。
 *
 * ⚠ 這兩個值都是**首選**，不是「一定會用這個」。連不上時引擎會去讀客戶端自己
 * 寫的 `DevToolsActivePort`（見 `cdp-adapter/debug-port.ts`），所以玩家看到的
 * 埠與實際接上的埠有可能不同 —— UI 要顯示的是**實際**那個。
 */
const WEB_PORT = BROWSER_DEBUG_PORT;

export function defaultPortFor(kind: ClientKind): number {
  return kind === "web" ? WEB_PORT : DESKTOP_PORT;
}

/**
 * 這種客戶端把 `DevToolsActivePort` 寫在哪裡。
 *
 * ⚠ **這是「埠變了還找得回來」的唯一依據，也是唯一防止接錯客戶端的東西。**
 * 兩種客戶端各有各的 user-data-dir，所以各有各的檔案；拿桌面版的目錄去救網頁版
 * 的連線，救回來的會是另一個帳號的遊戲。所以它跟著 `kind` 走，不是一個全域常數。
 */
export function userDataDirFor(kind: ClientKind): string {
  return kind === "web" ? DEFAULT_BROWSER_PROFILE_DIR : desktopUserDataDir();
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 埠要是合法的 TCP 埠。壞掉的值一律退回預設，不讓實例開不起來。 */
export function clampPort(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/**
 * 中間人那一格。空的、壞的一律回預設（**雲端**）—— 這格填錯不該讓插件開不起來。
 *
 * ⚠ 只收字串。舊設定檔那個 `linkPort`（數字）**刻意不搬過來** —— 見
 * `normalizeProfile()`。
 */
export function normalizeLink(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_LINK_TARGET;
  const trimmed = raw.trim();
  return trimmed === "" ? DEFAULT_LINK_TARGET : trimmed;
}

export function normalizeProfile(raw: unknown): Profile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" && r["id"].length > 0 ? r["id"] : newId();
  const kind: ClientKind = r["kind"] === "web" ? "web" : "desktop";
  const raw2 = typeof r["name"] === "string" ? r["name"].trim() : "";
  return {
    id,
    name: raw2 === "" ? (kind === "web" ? "網頁版" : "桌面版") : raw2,
    port: clampPort(r["port"], defaultPortFor(kind)),
    // ⚠ **舊設定檔的 `linkPort` 刻意丟掉，不搬過來。**
    //
    // 它一定是某個本機的埠（那時候只有本機中間人），而本機中間人只配得到
    // 同一台電腦上的另一個插件。搬過來的話，每個既有使用者升級之後都會停在
    // 一個永遠配不到對手的中間人上，而畫面上完全看不出來 —— 狀態列寫
    // 「還沒配到對手」，那句話在對手真的沒裝插件時也是同一句。
    //
    // 開發者要本機的話，在 進階 › 配置 那一格填 `local` 就有了。
    link: normalizeLink(r["link"]),
    kind,
    prefs: normalizePrefs(r["prefs"] as Partial<LinkPrefs> | undefined),
    readyTint: normalizeTint(typeof r["readyTint"] === "number" ? r["readyTint"] : null),
    costRulePath: normalizeCostRulePath(r["costRulePath"]),
    // ⚠ `=== true` 而不是「有值就算」：舊設定檔沒有這一欄，那時候的預設就該是
    // 關閉。插件裝上去不該改變玩家在遊戲裡看到的選單。
    hiddenStages: r["hiddenStages"] === true,
    match: normalizeMatchPrefs(r["match"]),
    // 舊設定檔沒有這一欄 → 1。那也是新裝的預設。
    editStep: normalizeEditStep(r["editStep"]),
    // 舊設定檔沒有這一欄 → 0（不檢查）。插件裝上去不該憑空替作者宣告一個單位。
    editUnit: normalizeEditUnit(r["editUnit"]),
  };
}

/** 空字串一律當成「沒選」，避免 UI 出現一個看不見的假選擇。 */
function normalizeCostRulePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function defaultProfile(kind: ClientKind = "desktop"): Profile {
  return {
    id: newId(),
    name: kind === "web" ? "網頁版" : "桌面版",
    port: defaultPortFor(kind),
    link: DEFAULT_LINK_TARGET,
    kind,
    prefs: normalizePrefs(undefined),
    // 預設不染色 —— 玩家指定「官方原本的白色」是預設值。
    readyTint: null,
    // 預設不套用自訂 COST。插件裝上去不該改變玩家看到的數字。
    costRulePath: null,
    // 同理，預設不動遊戲的開房選單。
    hiddenStages: false,
    match: { ...DEFAULT_MATCH_PREFS },
    // 整數 —— COST 幾乎都是整數，要小數的人自己調。
    editStep: DEFAULT_EDIT_STEP,
    // 不檢查。這是作者才會用到的東西，而大多數人不編規則。
    editUnit: 0,
  };
}

export function emptyStore(): ProfileStore {
  return {
    profiles: [defaultProfile("desktop")],
    lastUsedId: null,
    launchAtLogin: false,
    startMinimized: false,
    multiProfile: false,
  };
}

/**
 * 把讀進來的東西整理成一份能用的清單。
 *
 * **壞掉、缺欄位、空清單一律回一份可用的預設，絕不拋例外。** 這裡拋例外的
 * 代價是托盤根本開不起來，而玩家看不到任何原因（沒有視窗可以顯示錯誤）。
 */
export function normalizeStore(raw: unknown): ProfileStore {
  if (typeof raw !== "object" || raw === null) return emptyStore();
  const r = raw as Record<string, unknown>;

  const profiles = (Array.isArray(r["profiles"]) ? r["profiles"] : [])
    .map(normalizeProfile)
    .filter((p): p is Profile => p !== null);
  // 一份都沒有的話清單是不能用的 —— 視窗會沒有東西可綁。
  if (profiles.length === 0) return emptyStore();

  const ids = new Set(profiles.map((p) => p.id));
  const lastUsedId = typeof r["lastUsedId"] === "string" ? r["lastUsedId"] : null;
  return {
    profiles,
    lastUsedId: lastUsedId !== null && ids.has(lastUsedId) ? lastUsedId : null,
    launchAtLogin: r["launchAtLogin"] === true,
    startMinimized: r["startMinimized"] === true,
    // ⚠ `=== true` 而不是「有值就算」：舊的設定檔沒有這個欄位，那時候的預設
    // 就該是關閉。多開是使用者要**明確打開**的東西，不是繼承來的。
    multiProfile: r["multiProfile"] === true,
  };
}

/**
 * 新增一份（`source` 有給就是「複製」）。
 *
 * ⚠ **埠撞在一起的兩份配置不能同時跑** —— userData 的目錄鎖會擋掉第二個，
 * 而症狀是「按了開新實例但什麼都沒發生」，完全查不出原因。所以新增的當下
 * 就先挑一個沒人用的埠，不要把這個問題留到玩家按下去才爆。
 */
export function addTo(store: ProfileStore, source?: Profile): ProfileStore {
  const base = source ?? defaultProfile(store.profiles.length === 0 ? "desktop" : "web");

  const used = new Set(store.profiles.map((p) => p.port));
  let port = base.port;
  while (used.has(port)) port += 1;

  const names = new Set(store.profiles.map((p) => p.name));
  const stem = source === undefined ? base.name : `${base.name} 複本`;
  let name = stem;
  for (let i = 2; names.has(name); i++) name = `${stem} ${i}`;

  const created: Profile = { ...base, id: newId(), name, port };
  return { ...store, profiles: [...store.profiles, created] };
}

/**
 * 刪一份。**最後一份刪不掉** —— 清單空了視窗就沒有東西可綁，
 * 而那個狀態沒有任何 UI 可以救回來。
 */
export function removeFrom(store: ProfileStore, id: string): ProfileStore {
  if (store.profiles.length <= 1) return store;
  return {
    ...store,
    profiles: store.profiles.filter((p) => p.id !== id),
    lastUsedId: store.lastUsedId === id ? null : store.lastUsedId,
  };
}

/** 改一份，其餘照舊。`prefs` 是合併的，不是整份換掉。 */
export function updateIn(
  store: ProfileStore,
  id: string,
  patch: Partial<Omit<Profile, "id">>,
): ProfileStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => {
      if (p.id !== id) return p;
      const merged = { ...p, ...patch, id, prefs: { ...p.prefs, ...(patch.prefs ?? {}) } };
      return normalizeProfile(merged) ?? p;
    }),
  };
}

/**
 * 這個實例要用哪一份配置。
 *
 * 優先序：`--profile <id>` → `--port <n>` 對得上的那份 → **清單第一份**。
 *
 * ⚠ **不看「上次用的那份」。** 那個行為在多開的人身上很方便，但在其他人身上
 * 是「我只是想開插件，它卻綁到我上次測試用的網頁版」—— 而畫面上只寫「等遊戲…」，
 * 完全看不出來是綁錯了客戶端。不帶參數的啟動要是**可預測的**：
 * 清單第一份（新安裝就是桌面版 :59222）。
 *
 * 要開別份的人本來就有明確的入口 —— 托盤的「開新實例」帶的是 `--profile <id>`，
 * 不受這條影響。`lastUsedId` 仍然記著（`profiles.json` 裡看得到最後開的是哪一份，
 * 玩家回報問題時有用），只是不再拿來決定啟動。
 *
 * ⚠ `--port` 那條是為了**相容舊的用法**（`npm run tray -- --port 59222`）。
 * 對不上任何配置時不要當作錯誤：那多半是玩家在試一個新埠，直接臨時建一份
 * 不落地的配置給他用，比拒絕啟動有用得多。
 */
export function resolveProfile(
  store: ProfileStore,
  argv: readonly string[],
): { profile: Profile; ephemeral: boolean } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const wantId = flag("profile");
  if (wantId !== undefined) {
    const hit = store.profiles.find((p) => p.id === wantId);
    if (hit !== undefined) return { profile: hit, ephemeral: false };
  }

  const wantPort = flag("port");
  if (wantPort !== undefined) {
    const port = clampPort(wantPort, 0);
    const hit = store.profiles.find((p) => p.port === port);
    if (hit !== undefined) return { profile: hit, ephemeral: false };
    if (port > 0) {
      const link = normalizeLink(flag("link") ?? flag("link-port"));
      // 名字裡不要放埠 —— 視窗標題與狀態列本來就會補上，會變成「臨時 :9334 :9334」。
      return {
        profile: { ...defaultProfile("desktop"), name: "臨時", port, link },
        ephemeral: true,
      };
    }
  }

  // `profiles` 保證非空（`normalizeStore` 會補一份），所以那個 ?? 只是給型別看的。
  return { profile: store.profiles[0] ?? defaultProfile("desktop"), ephemeral: false };
}
