/**
 * 「開著它去玩」的那個東西（WP-15）
 * ===================================
 * CDP 連線、頁面攔截、仲裁規則、側通道 —— 四個零件接起來，而且**永遠不會
 * 因為任何一個掛掉而結束**。命令列與托盤跑的是同一份，差別只有誰在畫 UI。
 *
 * ```
 *   遊戲分頁 ──CDP──▶ CdpAdapter ──▶ ArbiterRunner ──▶ arbitration.step()
 *                                        │  ▲
 *                              announce  │  │  both-ready / force-end
 *                                        ▼  │
 *                                     LinkNode ──▶ 中間人 ──▶ 對手的插件
 * ```
 *
 * ⚠ **為什麼要獨立成一個 package，而不是讓托盤直接抄 CLI 那段：**
 * 這裡面有六個「錯了就整個功能安靜失效」的生命週期細節（重連、換場、換階段、
 * 側通道比 CDP 活得久、runner 每次重連換一個、拆 patch）。抄一份的話兩邊會
 * 各自漂移，而漂移的症狀全部是「在某個時機下什麼都沒發生」——
 * 這個專案已經在 `patch-ok` 與 `ws-events` 上各栽過一次。
 *
 * 五種時機都要成立（WP-12 交接文件列的，加上側通道那條）：
 *
 * | 時機             | 靠什麼                                       |
 * | ---------------- | -------------------------------------------- |
 * | 遊戲還沒開       | 連不上就等，無限重試                         |
 * | 開了還在大廳     | 裝得上去（waiting），頁面自己補掛            |
 * | 對戰中途接手     | `Runtime.evaluate` 注入，不需要 reload        |
 * | 打完重新開房     | 頁面偵測 socket 換了 → 重掛；房號跟著換       |
 * | **關掉遊戲再開** | 整條 CDP 死掉 → 重連、重裝、重開 runner       |
 * | **對手還沒開**   | 側通道是 solo → 秒數自動退回滿版 30 秒        |
 */

import type { MatchDriver } from "./match-session.js";
import type { AgreedSettings, ForceReason, LinkPrefs, LinkStatus } from "@ulr/arbiter-link";
import {
  effectiveCapSeconds,
  endpointOf,
  LinkNode,
  MIN_SPEED_FACTOR,
  MOVE_PHASE_TOTAL_SECONDS,
  normalizePrefs,
  parseLinkTarget,
  roomKey,
  soloSettings,
} from "@ulr/arbiter-link";
import type {
  CancelPolicy,
  CostOverrideTables,
  CostPatchReport,
  CostTableId,
  HiddenStageStatus,
  LobbyQuickPressed,
  LobbyReport,
  LobbyState,
  LobbyStatus,
  OkPatchReport,
  PenaltyBand,
  PenaltyPatchReport,
  Seat,
} from "@ulr/cdp-adapter";
import type { CardCatalog } from "@ulr/rule-schema";
import { buildCatalog } from "@ulr/rule-schema";
import {
  ArbiterRunner,
  COST_TABLE_IDS,
  createCdpAdapter,
  DEFAULT_DEBUG_PORT,
  DEFAULT_SPEED_LEASE_MS,
  explainDebugPort,
  HIDDEN_STAGES,
  normalizeTint,
  resolveDebugPort,
} from "@ulr/cdp-adapter";

/** 連不上就每隔這麼久再試一次。玩家不會為了插件而先開遊戲。 */
export const CONNECT_RETRY_MS = 2_000;

/** 硬底線的預設值：剩這麼多秒就一定送出，不再等任何人。 */
export const DEFAULT_DEADLINE_SECONDS = 3;

/**
 * 重裝攔截之間至少隔這麼久。
 *
 * 遊戲重載那幾秒 tick 會連續看到「patch 不見了」（每秒四次）。不節流的話
 * 會在頁面上連跑十幾次安裝腳本，而每一次都會先拆掉前一次裝好的。
 */
export const REINSTALL_COOLDOWN_MS = 3_000;

/**
 * 多久幫加速續一次約。
 *
 * 租約是 10 秒，這裡取三分之一 —— 連掉兩次都還來得及。續約本身極便宜
 * （一次 `Runtime.evaluate`，頁面那端只是寫一個時間戳），跟 `ArbiterRunner`
 * 的 250ms tick 比根本不算什麼。
 */
export const SPEED_RENEW_MS = Math.floor(DEFAULT_SPEED_LEASE_MS / 3);

export interface EngineOptions {
  /**
   * 遊戲的 CDP 埠。桌面版 59222、網頁版 59223（都是**首選**，不是保證）。
   *
   * 連不上時引擎會去讀 `userDataDir` 裡的 `DevToolsActivePort` 找回實際的埠，
   * 所以這個值錯了不見得會失敗 —— 但**它仍然是實例的身分**（托盤拿它分 userData、
   * 兩份配置不得重複），所以不可以填 0。理由見 `cdp-adapter/debug-port.ts`。
   */
  port?: number;
  /**
   * 這個客戶端的 user-data-dir。給了才有「埠變了也找得回來」這件事。
   *
   * ⚠ **一定要跟這份配置的客戶端種類一致。** 桌面版是
   * `%APPDATA%\UNLIGHT-Revive`、網頁版是瀏覽器 profile 目錄。給錯的症狀是
   * 「我開的是網頁版的插件，它卻接到桌面版的遊戲去」—— 不給比給錯好，
   * 不給只是少一層保險。
   */
  userDataDir?: string;
  /**
   * 中間人在哪。**兩個插件要指到同一個**，預設值就是為了不用設定。
   *
   * 一個字串，`parseLinkTarget()` 看得懂的都收：`local`、`9350`、
   * `wss://ulr-link.xxx.workers.dev`。舊的 `linkPort`（數字）也還吃得下 ——
   * 純數字就是本機的那個埠。
   */
  link?: string;
  /** 完全不接側通道（單邊模式）。 */
  noLink?: boolean;
  policy?: CancelPolicy;
  deadlineSeconds?: number;
  prefs?: Partial<LinkPrefs>;
  /**
   * 準備中把 OK 鈕染成什麼顏色。`null` = 不染色（官方原本的樣子），預設值。
   *
   * ⚠ **這個不進 `LinkPrefs`。** 它只改我自己畫面上的一個顏色，對手看不到、
   * 也拿不到任何好處 —— 跟秒數與加速不同，沒有協商的必要。純本機偏好放進
   * 協定只會讓兩邊為了一個顏色而版本不合。
   */
  readyTint?: number | null;
  onLog?: (line: string) => void;
  onStatus?: (status: EngineStatus) => void;
}

/**
 * 自訂 COST 目前走到哪一步。
 *
 * - `off`      沒有選規則
 * - `pending`  腳本裝上去了，但要等遊戲下一次載入才會改到畫面
 * - `applied`  頁面回報已經改寫了 cc_asset，畫面上的數字就是規則裡的
 * - `error`    注入失敗
 */
export type CostPhase = "off" | "pending" | "applied" | "error";

export interface CostState {
  /** **卡片價格**的狀態。要重載遊戲才會變。 */
  phase: CostPhase;
  /** 規則裡有幾個角色鍵。`null` = 沒選規則。 */
  entries: number | null;
  /** 實際改到幾張卡。只有 `applied` 之後才有值。 */
  applied: number | null;
  /**
   * 規則有、但這個客戶端的 cc_asset 沒有的鍵數。
   *
   * ⚠ 不是零就要顯示 —— 那代表規則跟遊戲版本對不上，而少掉的那些卡會被
   * 算成 `UNKNOWN_COST` 99，讓超標的隊伍看起來合法。
   */
  unknownKeys: number;
  /**
   * **壓 C 罰則**的狀態。
   *
   * ⚠ 跟 `phase` 分開，因為兩者的生效時機不同：價格走
   * `addScriptToEvaluateOnNewDocument`（要重載），罰則走 `Runtime.evaluate`
   * 攔 `Deck.prototype.getCost`（**立刻生效**，還會順手把牌組畫面重畫）。
   * 混成一個狀態的話，UI 一定會對其中一邊說謊。
   */
  penalty: "off" | "applied" | "error";
  /**
   * 罰則是不是**整個遊戲**都生效。
   *
   * `false` = 只有牌組編輯畫面 —— 對戰大廳那類畫面顯示的是伺服器存的 cost，
   * 要攔 WSClient 的 `db_deck{n}` 回應才會跟著變。遊戲還在載入時會是 false。
   */
  penaltyEverywhere: boolean;
  /** 罰則區間數。`null` = 這份規則不壓 C 或沒選規則。 */
  bands: number | null;
  /**
   * 這個頁面**在補丁裝上之前就把卡片資料載進去了**。
   *
   * ⚠ 這是「玩家從 Steam 開遊戲、插件事後才接上」的常態，不是異常狀況。
   * 掛鉤攔的是 `JSONFile.prototype.onProcess`，只改之後才載入的資料 ——
   * 已經在快取裡的那幾張，只有重載一次才會套上規則的價格。
   *
   * `true` 時畫面上的數字**還是原版的**，托盤會等一個不在對戰中的時機重載。
   */
  stale: boolean;
  /** 出錯時的原因。 */
  error: string | null;
}

const COST_OFF: CostState = {
  phase: "off",
  entries: null,
  applied: null,
  unknownKeys: 0,
  penalty: "off",
  penaltyEverywhere: false,
  bands: null,
  stale: false,
  error: null,
};

/** 四張表的中文名。log 與 UI 都用它 —— 玩家看不懂 `eventCards`。 */
const COST_TABLE_LABEL: Readonly<Record<CostTableId, string>> = {
  characters: "角色",
  monsters: "怪物",
  equipment: "裝備",
  eventCards: "事件卡",
};

/** 四張表加起來幾筆。沒選規則是 `null`（跟「選了但是空的」要分得出來）。 */
function countEntries(tables: CostOverrideTables | null): number | null {
  if (tables === null) return null;
  let n = 0;
  for (const id of COST_TABLE_IDS) n += Object.keys(tables[id] ?? {}).length;
  return n;
}

/** UI 要畫的東西。**每次變動都會整份重發**，畫的人不必自己合併。 */
export interface EngineStatus {
  /** CDP 接上了沒。 */
  connected: boolean;
  /** 遊戲分頁標題（已去識別化）。 */
  title: string | null;
  /** 這一場的座位。每場重新分配。 */
  seat: Seat | null;
  /** 頁面上的攔截真的掛在 socket 上了。還在大廳時是 false。 */
  armed: boolean;
  /**
   * **實際**接上的 CDP 埠。`null` = 還沒接上。
   *
   * ⚠ 這跟設定裡那個埠有可能不一樣（首選埠綁不上時，客戶端會挑別的，我們從
   * `DevToolsActivePort` 讀回來）。UI 要顯示**這個** —— 顯示設定值的話，玩家
   * 會拿一個沒有人在聽的埠去 CLI 或 arbiter 上用，然後以為那些工具壞了。
   */
  port: number | null;
  /** 側通道狀態。 */
  link: LinkStatus;
  /** 我是不是那個中間人。行為上沒差別，只是給玩家看。 */
  hosting: boolean;
  /** 協商後的共同設定。**沒配對到人時秒數會是滿版 30**。 */
  agreed: AgreedSettings;
  /**
   * 對手是**真人**（`duel` / `ranked`）。任務、渦、活動、還沒進對戰都是 `false`。
   *
   * ⚠ 為 `false` 時**準備與約定秒數整組不生效**，而且那是刻意的 ——
   * UI 一定要講出來，否則玩家看到「已接上、已配對」卻沒有任何反應，
   * 只會以為插件壞了。
   */
  pvp: boolean;
  /** 這一場是哪種戰鬥（`duel` / `quest` / `raid` …）。不在對戰中是 `null`。 */
  rule: string | null;
  /** 這個階段有沒有「聖水＋麻痺」。 */
  hazard: boolean;
  /** 目前實際生效的階段秒數（已含 hazard 修正）。null = 不縮短。 */
  capSeconds: number | null;
  /** 最後一次送出 `I_am_ok` 的原因。給玩家看「剛剛發生了什麼」。 */
  lastSend: string | null;
  /**
   * 頁面上**實際生效**的加速倍率。`null` = 沒裝（原速）。
   *
   * ⚠ 跟 `agreed.speedFactor` 分開是必要的：協商完成到頁面真的裝上去之間
   * 有一段 `Runtime.evaluate` 的時間，而且遊戲還在大廳時根本裝不上。
   * UI 只顯示 `agreed` 的話，玩家會看到「已生效」但畫面沒變。
   */
  speedApplied: number | null;
  /**
   * 自訂 COST 在頁面上的狀態。
   *
   * ⚠ 跟「有沒有選規則」是兩回事。`installCostOverrides` 走的是
   * `addScriptToEvaluateOnNewDocument`，**只對之後載入的 document 生效** ——
   * 選好規則到玩家重載遊戲之間，這裡會是 `"pending"`。UI 一定要把這段講出來，
   * 否則玩家會看到「已選規則」但畫面上的數字沒變，然後以為插件壞了。
   */
  cost: CostState;
  /** 最後一個錯誤。修好之後會被清成 null。 */
  error: string | null;
}

export class ArbiterEngine {
  #options: EngineOptions;
  #prefs: LinkPrefs;
  /** 準備中的染色。純本機顯示偏好，不進協商 —— 見 EngineOptions.readyTint。 */
  #readyTint: number | null;
  #link: LinkNode | null = null;
  #runner: ArbiterRunner | null = null;
  /** 這一輪連線用的 adapter。加速要在協商變動時重下，所以得留著。 */
  #adapter: ReturnType<typeof createCdpAdapter> | null = null;
  /** 目前選的自訂 COST 表（四張）。`null` = 沒選。重連時要重裝，所以留著。 */
  #costs: CostOverrideTables | null = null;
  /**
   * 頁面上那支 COST 注入腳本的 identifier。
   *
   * ⚠ **換規則一定要先把舊的拆掉。** `addScriptToEvaluateOnNewDocument` 是
   * 累加的，而 `patch-cost` 的 `__ulrCostPatch` 閘只讓**第一支**跑成功 ——
   * 不拆就直接裝新的，下次載入生效的會是**舊規則**，而且完全沒有錯誤訊息。
   */
  #costScriptId: string | null = null;
  /**
   * 每張表最後一次回報的結果。
   *
   * ⚠ **換規則或重載時要清掉。** 不清的話，新規則沒有的那張表會留著舊數字，
   * UI 顯示的「已改寫 N 張」就會包含一張根本沒再套用的表。
   */
  #costReports = new Map<CostTableId, { applied: number; unknownKeys: number }>();
  /** 目前的壓 C 區間表。`null` = 不改罰則（用遊戲原本的算法）。 */
  #bands: readonly PenaltyBand[] | null = null;
  /**
   * 隱藏地圖開著沒。
   *
   * ⚠ 補丁是 `Runtime.evaluate` 裝的，**遊戲重載就沒了** —— 所以這個布林值要
   * 留著，接上／重裝時才補得回去。不留的話症狀是「昨天開的，今天打開遊戲選單
   * 又只剩 11 項」，而玩家不會把它跟重載連在一起。
   */
  #hiddenStages = false;
  /** 誰在等「玩家按了大廳那顆快速比賽」。 */
  #lobbyHandlers = new Set<(press: LobbyQuickPressed) => void>();
  #stopping = false;
  #loop: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;
  #status: EngineStatus;

  constructor(options: EngineOptions = {}) {
    this.#options = options;
    this.#prefs = normalizePrefs(options.prefs);
    this.#readyTint = normalizeTint(options.readyTint ?? null);
    this.#status = {
      connected: false,
      title: null,
      seat: null,
      armed: false,
      port: null,
      // 還沒進對戰 —— 這不是「連不上」，是「還不需要連」。
      link: "idle",
      hosting: false,
      // ⚠ 起始值是**單邊**設定，不是玩家自己選的秒數。沒配對到人就不縮短，
      // 而 UI 從第一幀起就該顯示這個事實。
      agreed: soloSettings(this.#prefs),
      pvp: false,
      rule: null,
      hazard: false,
      capSeconds: null,
      lastSend: null,
      speedApplied: null,
      cost: COST_OFF,
      error: null,
    };
  }

  get status(): EngineStatus {
    return this.#status;
  }

  get prefs(): LinkPrefs {
    return this.#prefs;
  }

  get readyTint(): number | null {
    return this.#readyTint;
  }

  /**
   * 換準備中的染色。**不重裝 patch** —— 重裝會把正壓著的 `I_am_ok` 送出去，
   * 為了改一個顏色讓玩家這回合的 OK 定案完全不值得。
   */
  setReadyTint(tint: number | null): void {
    this.#readyTint = normalizeTint(tint);
    void this.#adapter?.setReadyTint(this.#readyTint).catch(() => {
      // 還沒接上或正在重連。下次 installOkPatch 會帶著新值上去。
    });
  }

  /**
   * 換一份自訂 COST 規則（`null` = 不套用）。
   *
   * `characters` 的鍵必須是 cc_asset 的 `filename`（`cc078_04`）—— 規則檔的
   * `characters` 可以直接丟進來，那正是同一種鍵。
   *
   * 兩件事的生效時機**不一樣**，這是 UI 一定要講清楚的：
   *
   * | 改什麼   | 怎麼裝                              | 何時生效       |
   * | -------- | ----------------------------------- | -------------- |
   * | 卡片價格 | addScriptToEvaluateOnNewDocument    | **下次載入**   |
   * | 壓 C 罰則 | evaluate 攔 Deck.prototype.getCost | **立刻**       |
   *
   * **不會自己重載遊戲。** 玩家可能正在對戰中，什麼時候重載是他的決定。
   */
  setCostRule(rule: (CostOverrideTables & { bands: readonly PenaltyBand[] | null }) | null): void {
    this.#costs =
      rule === null
        ? null
        : {
            characters: rule.characters,
            monsters: rule.monsters,
            equipment: rule.equipment,
            eventCards: rule.eventCards,
          };
    this.#bands = rule === null ? null : rule.bands;
    this.#emit({
      cost:
        rule === null
          ? COST_OFF
          : {
              phase: "pending",
              entries: countEntries(this.#costs),
              applied: null,
              unknownKeys: 0,
              penalty: "off",
              penaltyEverywhere: false,
              bands: rule.bands === null ? null : rule.bands.length,
              // 換規則的當下還不知道趕不趕得上 —— `#syncCosts()` 問過頁面
              // 之後才會把這格改成真的答案。
              stale: false,
              error: null,
            },
    });
    void this.#syncCosts();
    void this.#syncPenalty();
  }

  /** 目前選的四張表。托盤重畫時要對照。 */
  get costOverrides(): CostOverrideTables | null {
    return this.#costs;
  }

  /**
   * 請遊戲重新載入，讓 `addScriptToEvaluateOnNewDocument` 那些注入生效。
   *
   * ⚠ **會打斷正在進行的對戰。** 引擎自己絕對不會呼叫它 —— 只有玩家按了
   * 按鈕才會走到這裡。
   */
  /**
   * 配對用的驅動。沒連上遊戲時是 `null`。
   *
   * ⚠ **每次取用都重裝一次 `__ulrMatch`。** 注入的東西在遊戲重載之後就沒了，
   * 而配對是玩家按下去才跑的 —— 不能假設上次裝的還在。重裝很便宜（只換函式，
   * 不重掛 listener，也不動已經收到的房間清單）。
   */
  async matchDriver(): Promise<MatchDriver | null> {
    const adapter = this.#adapter;
    if (adapter === null) return null;
    await adapter.installMatchRoom();
    return adapter;
  }

  /**
   * 中間人的連線位址（不含路徑）。配對佇列跟側通道**共用同一台**。
   *
   * ⚠ 讀的是玩家設定的那個字串，不是 `LinkNode` 當下連著的那條 —— 佇列可以
   * 在側通道還沒連上時就用（那時玩家還在大廳，本來就沒有側通道）。
   *
   * ⚠ 玩家把中間人設成 `local` 時，這裡回的是本機 broker 的位址；而本機
   * broker（`broker.ts`）**只認得房間協定、沒有佇列**。那個組合是雙開測試用的，
   * 自動配對在那底下連不上是預期行為，不是壞掉。
   */
  get linkEndpoint(): string {
    return endpointOf(parseLinkTarget(this.#options.link));
  }

  // -------------------------------------------------------------------------
  // 隱藏地圖
  //
  // ⚠ 這一組跟 COST 那一組不一樣：**它不改任何數字，只是把官方選單裡沒有的
  // 四張地圖放回下拉選單**。開房仍然是玩家自己在遊戲的對話框上按的，送出去的
  // 封包也是遊戲自己送的。
  // -------------------------------------------------------------------------

  get hiddenStages(): boolean {
    return this.#hiddenStages;
  }

  /**
   * 開關隱藏地圖。**立刻生效**（攔的是活著的類別），不必重載遊戲。
   *
   * 關掉會把選單還原成官方的 11 項 —— 同樣立刻生效。
   */
  setHiddenStages(on: boolean): void {
    this.#hiddenStages = on;
    void this.#syncHiddenStages();
  }

  /**
   * 把目前的設定再推一次。
   *
   * 給 UI 的「重試」用。頁面那支腳本自己會等大廳出現（見 `patch-stage.ts`），
   * 所以正常情況下不必叫這支 —— 它是給「等太久放棄了」與「玩家換了遊戲語言」
   * 那兩種收尾狀態的。
   */
  async applyHiddenStages(): Promise<void> {
    await this.#syncHiddenStages();
  }

  /**
   * 隱藏地圖現在在頁面上的狀態。沒接上遊戲時是 `null`。
   *
   * ⚠ UI 要**問這個**而不是問 `hiddenStages` —— 後者只是「玩家想不想要」，
   * 前者才是「遊戲那邊真的怎樣」。兩者會不一樣的時機很常見：玩家開著開關但
   * 遊戲還沒開、剛重載完還沒補上、還沒開過一次開房對話框。
   */
  async hiddenStageStatus(): Promise<HiddenStageStatus | null> {
    const adapter = this.#adapter;
    if (adapter === null) return null;
    try {
      return await adapter.hiddenStageStatus();
    } catch {
      // 連線正在死。下一輪重連會重裝，這裡不必吵。
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 迪特赫姆的快速比賽（WP-17）
  //
  // ⚠ 這一組跟隱藏地圖一樣**不改任何數字**：它在 duel 頻道的大廳畫一顆按鈕、
  // 一段等待人數，然後把「玩家按了」交給呼叫端。真正會開房（消耗 AP）的仍然
  // 是 `MatchPairing`，而它的前提沒有變 —— 玩家親手按下去。
  // -------------------------------------------------------------------------

  /**
   * 玩家按了大廳那顆快速比賽。**呼叫端負責決定要開始還是停止配對。**
   *
   * ⚠ 引擎自己不做那件事：開房會消耗 AP、進房會直接開打，那條路徑一定要留在
   * 「有規則、有配置」的那一層（`main.ts`），引擎這裡只知道有人按了按鈕。
   */
  onLobbyQuick(handler: (press: LobbyQuickPressed) => void): () => void {
    this.#lobbyHandlers.add(handler);
    return () => this.#lobbyHandlers.delete(handler);
  }

  /**
   * 把等待人數與配對狀態推到遊戲畫面上。沒接上遊戲時安靜地什麼都不做。
   *
   * ⚠ **不要在這裡加「跟上次一樣就不送」的最佳化。** 面板每次換頻道都是新的
   * 物件，而新面板上的字是空的 —— 省掉那一次推送的症狀是「換個頻道回來，
   * 人數就不見了」。
   */
  async setLobbyState(state: LobbyState): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    try {
      await adapter.setLobbyState(state);
    } catch {
      // 連線正在死。下一輪重連會重裝，這裡不必吵。
    }
  }

  /** 跳出遊戲自己的錯誤對話框（「這個牌組不符合遊戲規則」）。 */
  async showLobbyError(code: number | null, message?: string): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    try {
      await adapter.showLobbyError(code, message);
    } catch {
      /* 同上 */
    }
  }

  /**
   * 大廳按鈕現在在頁面上的狀態。沒接上遊戲時是 `null`。
   *
   * ⚠⚠ **頁面說「沒裝」就當場補裝。** 這支是 `evaluate` 裝的，遊戲一重載就
   * 整份消失，而重載**不會**斷 CDP 連線 —— 沒有人會來重跑 `#syncLobby()`。
   * 而且我們自己就會重載（卡片價格套用那條路），所以這不是罕見狀況：
   * 症狀是玩家回報的「快速比賽按鈕有時候沒出現」，而且要等到他把遊戲關掉
   * 再開才會回來。
   *
   * 托盤每 15 秒問一次這支，所以補裝最慢 15 秒內發生；`#reinstall()` 那條路
   * 更快（幾秒），兩條都留是因為它們偵測到的是不同的東西。
   */
  async lobbyStatus(): Promise<LobbyStatus | null> {
    const adapter = this.#adapter;
    if (adapter === null) return null;
    try {
      const status = await adapter.lobbyStatus();
      if (status.installed) return status;
      return await adapter.installLobbyPatch();
    } catch {
      return null;
    }
  }

  /**
   * 把大廳補丁裝上去。**每次接上遊戲都會自己叫一次**，這支是給「重試」用的。
   *
   * ⚠ 跟隱藏地圖同一種東西：`evaluate` 裝的，**遊戲一重載就沒了**。
   */
  async #syncLobby(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    try {
      const status = await adapter.installLobbyPatch();
      // ⚠ `buttonReady: false` 幾乎一定會發生（這時玩家還在標題畫面），
      // 那**不是錯誤** —— 腳本會自己盯著他進頻道。所以這裡不寫 log。
      if (!status.installed) this.#log(`· 大廳快速比賽還沒裝上：${status.reason ?? "原因不明"}`);
    } catch (err) {
      this.#log(`✗ 大廳快速比賽注入失敗：${describe(err)}`);
    }
  }

  async reloadGame(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) throw new Error("還沒接上遊戲");
    await adapter.reloadGame();
  }

  /**
   * 從跑著的客戶端讀一份**卡片名冊**（四張表的原價 + 中文名）。
   *
   * 編輯 COST 的介面靠它把 `cc001_01` 顯示成「艾伯李斯特 L1」。呼叫端負責
   * 把結果存起來重複使用 —— 玩家調表時多半沒開遊戲。
   *
   * ⚠⚠ **被改寫過的客戶端讀不得，而這件事由這支自己擋。** `baseCost` 讀的是
   * Phaser 快取裡的值，而 `patch-cost` 正是就地改寫那份資料 —— 套過之後讀回來
   * 的「原價」會是被改過的數字，於是編輯器的「改回原價」會把玩家改回**上一份
   * 規則**，價差色階連方向都可能是反的。
   *
   * ⚠ 判斷**只能問頁面**（`costPatchState`），不能問插件記著的狀態。「插件現在
   * 選著哪份規則」跟「頁面上那份資料現在長什麼樣」是兩件事：按了停用還沒重載、
   * 剛換一份規則、托盤自己重開過 —— 這三種情況插件都會說「沒在套」，而頁面
   * 上的數字仍然是改過的。2026-08-16 就是這樣讓三格假原價進了名冊。
   */
  async readCardCatalog(gameVersion: string): Promise<CardCatalog> {
    const adapter = this.#adapter;
    if (adapter === null) throw new Error("還沒接上遊戲");
    const patch = await adapter.costPatchState();
    if (patch.patched) {
      throw new Error(
        `這個客戶端的卡表已經被改寫過了（${patch.applied} 張），現在讀回來的「原價」` +
          `會是改過的數字。請先在「Cost 表」按停用、重載遊戲，再回來讀一次 ——` +
          `停用之後不重載是沒有用的，頁面上那份資料還是改過的。`,
      );
    }
    // 五次 evaluate，各自只帶需要的欄位回來（§9.1「不搬大物件」）。
    const [characters, monsters, equipment, eventCards, profiles] = [
      await adapter.readCharacterAssets(),
      await adapter.readMonsterAssets(),
      await adapter.readWeaponAssets(),
      await adapter.readEventCardAssets(),
      await adapter.readProfiles(),
    ];
    return buildCatalog({
      gameVersion,
      characters: characters.assets,
      monsters: monsters.assets,
      equipment: equipment.cards,
      eventCards: eventCards.cards,
      profiles,
      // ⚠ 一定要一起送。少了它，名冊會把**每一張**卡都判成「官方還沒出」
      // （`upgradeTarget` 全 false 卻沒有旗標說「這份沒有升級圖」）。
      hasUpgradeGraph: {
        characters: characters.hasUpgradeGraph,
        monsters: monsters.hasUpgradeGraph,
      },
    });
  }

  /**
   * 把 `#costs` 推到頁面上。連上、換規則、重連都會走這裡。
   *
   * 先拆後裝的理由見 `#costScriptId`。
   */
  async #syncCosts(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;

    try {
      // 舊規則的每表統計不能留 —— 見 `#costReports`。
      this.#costReports.clear();
      if (this.#costScriptId !== null) {
        await adapter.removeCostOverrides(this.#costScriptId);
        this.#costScriptId = null;
      }
      if (this.#costs === null) return;

      const { scriptIdentifier } = await adapter.installCostOverrides(this.#costs);
      this.#costScriptId = scriptIdentifier;

      // ⚠ **上面那支只管「之後」載入的 document。** 玩家從 Steam 開遊戲時，
      // 插件是在遊戲已經建好 document 之後才接上的 —— 只走那支的話掛鉤這一輪
      // 永遠不會跑到，症狀就是玩家回報的「插件開著、規則也載了，遊戲裡卻還是
      // 原版價格」。所以同一份腳本**也要立刻裝到現在這個頁面上**。
      //
      // 趕不趕得上要看快取：已經載進去的資料掛鉤碰不到，那才需要重載。
      // 先問再裝，順序不能顛倒 —— 反過來的話會把自己剛剛救回來的那幾張
      // 也算成「來不及」，於是每次接上都白白重載一次。
      await adapter.installCostOverridesLive(this.#costs);
      const coverage = await adapter.costPatchCoverage(this.#costs);
      this.#emit({
        cost: { ...this.#status.cost, stale: coverage.missed.length > 0 },
      });
    } catch (err) {
      // 連線多半正在死 —— 重連時會再走一次 #syncCosts，不必在這裡吵。
      this.#emit({
        cost: { ...this.#status.cost, phase: "error", error: `注入失敗：${describe(err)}` },
      });
    }
  }

  /**
   * 把 `#bands` 推到頁面上。
   *
   * ⚠ 跟 `#syncCosts` 不同，這支**立刻生效**（攔的是活著的 `Deck` 類別），
   * 所以連上遊戲之後就該叫一次，換規則時也要叫。頁面端會從**原始**的
   * `getCost` 重新包，不會疊補丁。
   */
  async #syncPenalty(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;

    try {
      if (this.#bands === null) {
        await adapter.uninstallPenaltyOverrides();
        this.#emit({
          cost: { ...this.#status.cost, penalty: "off", penaltyEverywhere: false, bands: null },
        });
        return;
      }
      await adapter.installPenaltyOverrides(this.#bands);
      // 真正的 applied 由頁面回報帶回來（#onPenaltyReport），這裡不先報成功。
    } catch (err) {
      this.#emit({
        cost: { ...this.#status.cost, penalty: "error", error: `罰則注入失敗：${describe(err)}` },
      });
    }
  }

  /**
   * 把 `#hiddenStages` 推到頁面上。
   *
   * ⚠ 跟 `#syncPenalty` 一樣是 `evaluate` 裝的，**重載會被沖掉** —— 接上與重裝
   * 兩條路都要叫。
   */
  async #syncHiddenStages(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;

    try {
      if (!this.#hiddenStages) {
        await adapter.uninstallHiddenStages();
        return;
      }
      const status = await adapter.installHiddenStages(HIDDEN_STAGES);
      if (!status.installed) {
        // ⚠ 這通常不是壞掉，是**遊戲還沒載到對戰大廳那一段**。講出來，但不要
        // 講成錯誤 —— 玩家去大廳晃一圈再回來按一次就好。
        this.#log(`· 隱藏地圖還沒裝上：${status.reason ?? "原因不明"}`);
      }
    } catch (err) {
      this.#log(`✗ 隱藏地圖注入失敗：${describe(err)}`);
    }
  }

  /** 頁面回報大廳那顆按鈕的事。 */
  #onLobbyReport(report: LobbyReport): void {
    if (report.type === "lobby-error") {
      this.#log(`· 大廳快速比賽掛不上：${report.reason}`);
      return;
    }
    // ⚠ 一個 handler 拋例外不該讓其他人收不到 —— 這條路徑上的 handler 會去
    // 開房，而那是玩家按了按鈕之後唯一會發生的事。
    for (const handler of [...this.#lobbyHandlers]) {
      try {
        handler(report);
      } catch (err) {
        this.#log(`✗ 處理大廳快速比賽時出錯：${describe(err)}`);
      }
    }
  }

  /** 頁面回報罰則補丁的結果。 */
  #onPenaltyReport(report: PenaltyPatchReport): void {
    if (report.type === "penalty-patch-error") {
      this.#emit({ cost: { ...this.#status.cost, penalty: "error", error: report.reason } });
      return;
    }
    this.#emit({
      cost: {
        ...this.#status.cost,
        penalty: "applied",
        penaltyEverywhere: report.socketPatched,
        bands: report.bands,
        error: null,
      },
    });
    this.#log(
      `✓ 壓 C 罰則已改寫（${report.bands} 段區間，立即生效` +
        `${report.socketPatched ? "，全遊戲" : "，⚠ 目前只有牌組畫面"}）`,
    );
  }

  /**
   * 頁面回報 COST 改寫的結果。
   *
   * ⚠ **四張表各發一則**（它們是四個獨立的 `load.json`，完成時間不同），所以
   * 這裡要**累加**而不是覆寫。直接覆寫的話 UI 上的「已改寫 N 張卡」會是最後
   * 抵達的那張表的數字，而那通常是最小的一張。
   */
  #onCostReport(report: CostPatchReport): void {
    if (report.type === "cost-patch-error") {
      const where = report.table === null ? "" : `（${COST_TABLE_LABEL[report.table]}）`;
      this.#emit({
        cost: { ...this.#status.cost, phase: "error", error: `${report.reason}${where}` },
      });
      return;
    }
    if (report.type === "cost-patch-installed") return; // hook 掛好了，還沒攔到任何一張表

    this.#costReports.set(report.table, {
      applied: report.applied,
      unknownKeys: report.unknownKeys.length,
    });
    let applied = 0;
    let unknownKeys = 0;
    for (const r of this.#costReports.values()) {
      applied += r.applied;
      unknownKeys += r.unknownKeys;
    }

    this.#emit({
      cost: {
        ...this.#status.cost,
        // 攔到了就代表補丁在**這個**頁面上真的跑了 —— 不管之前判成怎樣。
        // ⚠ 少了這一行，重載完成之後 `stale` 會一直留著 true，而托盤看到
        // true 就重載 —— 那是一個停不下來的迴圈。
        stale: false,
        phase: "applied",
        entries: countEntries(this.#costs),
        applied,
        unknownKeys,
        error: null,
      },
    });
    this.#log(
      `✓ 自訂 COST 已套用（${COST_TABLE_LABEL[report.table]}）：` +
        `改了 ${report.applied} / ${report.totalFrames} 張`,
    );
    if (report.unknownKeys.length > 0) {
      this.#log(
        `⚠ ${COST_TABLE_LABEL[report.table]}有 ${report.unknownKeys.length} 個鍵這個客戶端沒有 —— 規則可能對不上遊戲版本`,
      );
    }
  }

  /**
   * 玩家在托盤裡改了設定。
   *
   * 立刻生效，不必重開 —— `capSecondsFor` 每個 tick 重新問，
   * `setHold` 直接下給頁面。
   */
  setPrefs(next: Partial<LinkPrefs>): void {
    this.#prefs = normalizePrefs({ ...this.#prefs, ...next });
    if (this.#link !== null) {
      // 協商結果會從 onChange 回來，加速也在那裡才同步 —— 這裡先動的話
      // 會用到還沒協商過的值，等於單方面加速。
      this.#link.client.setPrefs(this.#prefs);
    } else {
      // ⚠ `--no-link` 就是「永遠不會握手」。setHold 一定要走 agreed 而不是
      // prefs —— 直接讀玩家的偏好會讓單邊模式下準備照樣攔，正是 2026-08-09
      // 要修掉的行為（見 `soloSettings`）。
      const agreed = soloSettings(this.#prefs);
      this.#emit({ agreed });
      void this.#runner?.setHold(agreed.readyEnabled);
      void this.#syncSpeed();
    }
  }

  /** 開始。**不會 throw** —— 連不上只是狀態，不是錯誤。 */
  async start(): Promise<void> {
    if (this.#loop !== null) return;
    this.#stopping = false;

    if (this.#options.noLink !== true) {
      this.#link = await LinkNode.start({
        target: parseLinkTarget(this.#options.link),
        // ⚠ **不是 LOBBY_ROOM_KEY。** `null` = 還沒進對戰 → 根本不連線。
        // 大廳那個房號在本機無害，接上公網之後會變成「所有沒在對戰的人擠進
        // 同一間房」，而且其中兩個會被真的配成一對。見 link-worker 的
        // `parseRoomPath()`。
        room: null,
        prefs: this.#prefs,
        onLog: (line) => this.#log(line),
        onChange: ({ status, agreed }) => {
          this.#emit({ link: status, agreed, hosting: this.#link?.hosting === true });
          // 準備功能要兩邊都同意 —— 對手關掉時我方也要停止攔截。
          void this.#runner?.setHold(agreed.readyEnabled);
          // 加速同理：對手離線或改成 1x，共同值就是 1，這裡要把它拆掉。
          void this.#syncSpeed();
        },
        // ⚠ 唯一從外面進來的就緒訊號，而且是合成的（協定紅線 1）。
        onBothReady: () => this.#runner?.peerBothReady(),
        onForceEnd: () => this.#runner?.peerForceEnd(),
      });
      this.#emit({ hosting: this.#link.hosting });
    }

    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopSpeedLease();
    this.#resolveStop?.();
    await this.#loop;
    this.#loop = null;
    await this.#link?.close();
    this.#link = null;
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }

  #emit(patch: Partial<EngineStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#options.onStatus?.(this.#status);
  }

  /** 目前該用的階段秒數。`null` = 不強制提早結束。 */
  #capFor(hazard: boolean): number | null {
    // ⚠ 對 NPC 一律不縮短。`ArbiterRunner` 在非對戰時本來就不會走到這裡，
    // 但這個函式也被 `onStep` 拿去算要顯示的秒數 —— 兩條路要給同一個答案，
    // 否則 UI 會顯示一個根本不會被執行的門檻。
    if (!this.#status.pvp) return null;
    const cap = effectiveCapSeconds(this.#status.agreed, hazard);
    return cap >= MOVE_PHASE_TOTAL_SECONDS ? null : cap;
  }

  /**
   * 把頁面上的加速調成協商出來的倍率。
   *
   * ⚠ **來源一定是 `agreed.speedFactor`，不是 `prefs.speedFactor`。**
   * 玩家自己勾的那個只是他的出價；生效的是雙方的 min。用錯來源的症狀不是
   * 報錯，是「對手明明沒開，我這邊卻在加速」—— 也就是這條協商要防的事。
   *
   * 失敗不算錯誤：還在大廳、剛斷線、遊戲正在重載都會拿不到頁面，而下一次
   * 協商變動或重新接上時會再跑一次。
   */
  async #syncSpeed(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    const want = this.#status.agreed.speedFactor;
    try {
      if (want <= MIN_SPEED_FACTOR) {
        this.#stopSpeedLease();
        const gone = await adapter.uninstallSpeedPatch();
        if (gone === "uninstalled") this.#log("→ 加速已關閉（回到原速）");
        this.#emit({ speedApplied: null });
        return;
      }
      const state = await adapter.installSpeedPatch({ factor: want });
      // `waiting` = 腳本裝好了但遊戲場景還沒起來，它自己會補上。
      this.#emit({ speedApplied: state === "ok" ? want : null });
      if (state === "ok") this.#log(`→ 加速 ${want}× 已生效（雙方共同值）`);
      this.#startSpeedLease();
    } catch {
      // 連線正在死或頁面正在重載。重連那條路會再叫一次，這裡安靜退場。
      this.#emit({ speedApplied: null });
    }
  }

  /** 續約的計時器。只在加速真的開著時跑。 */
  #speedLease: ReturnType<typeof setInterval> | null = null;

  #startSpeedLease(): void {
    if (this.#speedLease !== null) return;
    this.#speedLease = setInterval(() => void this.#renewSpeed(), SPEED_RENEW_MS);
    // ⚠ Node 端的計時器不該讓程式活著。少了這行，命令列版本會在使用者
    // Ctrl-C 之後不肯結束。
    this.#speedLease.unref?.();
  }

  #stopSpeedLease(): void {
    if (this.#speedLease === null) return;
    clearInterval(this.#speedLease);
    this.#speedLease = null;
  }

  async #renewSpeed(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null || this.#status.agreed.speedFactor <= MIN_SPEED_FACTOR) {
      this.#stopSpeedLease();
      return;
    }
    try {
      // ⚠ 回 `not-installed` 就要重裝。玩家重載遊戲會把頁面上那份沖掉，
      // 而 `onPatchLost` 只看得到 patch-ok 不見了 —— 遊戲在大廳重載時
      // 那條路根本不會觸發，只有這裡救得回來。
      if ((await adapter.renewSpeedLease()) === "not-installed") await this.#syncSpeed();
    } catch {
      // 連線死了。重連那條路會重裝，這裡不必吵。
    }
  }

  /**
   * 主迴圈。每一輪 = 一次 CDP 連線的生命週期。
   *
   * ⚠ **連線斷掉不算結束**，那是要重連的訊號。只有 `stop()` 會離開這個迴圈。
   */
  async #run(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      this.#resolveStop = resolve;
      if (this.#stopping) resolve();
    });

    for (let attach = 1; !this.#stopping; attach++) {
      // ⚠ 每次都用**全新的** adapter。重連是新的 target、新的 execution
      // context，沿用舊實例只會把上一條連線的殘留狀態帶進來。
      // 埠也一樣每次重新解析 —— 玩家關掉遊戲再開時，客戶端可能挑到另一個埠。
      const opened = await this.#openWhenReady();
      if (opened === null) break;
      const { adapter, title, port } = opened;
      this.#adapter = adapter;

      try {
        this.#emit({ connected: true, title, port, error: null });
        this.#log(attach === 1 ? `✓ 接上「${title}」` : `✓ 重新接上「${title}」`);

        const lost = new Promise<string>((resolve) => adapter.onDisconnect(resolve));
        adapter.onOkPatchReport((r) => this.#onPageReport(r));
        adapter.onCostPatchReport((r) => this.#onCostReport(r));
        adapter.onPenaltyPatchReport((r) => this.#onPenaltyReport(r));

        // ⚠ 新的 target = 頁面上一支腳本都沒有。舊的 identifier 屬於上一條
        // 連線，留著會讓 #syncCosts 去拆一個不存在的東西。
        this.#costScriptId = null;
        await this.#syncCosts();
        // 罰則補丁是 evaluate 裝的，重載會被沖掉 —— 每次接上都要重裝。
        await this.#syncPenalty();
        // 隱藏地圖同理。⚠ 這時候遊戲多半還在標題畫面，Match 類別還沒載進來，
        // 所以裝不上很正常 —— 玩家進大廳後由配對頁那邊補裝（見 main.ts）。
        await this.#syncHiddenStages();
        // 迪城的快速比賽同理，而且它**自己會等**（腳本裡有輪詢），所以這裡
        // 裝一次就夠 —— 玩家進頻道時按鈕會自己出現。
        adapter.onLobbyReport((r) => this.#onLobbyReport(r));
        await this.#syncLobby();

        // ⚠ 不必等到進對戰。沒有 socket 也裝得上（回 waiting），頁面每 200ms
        // 自己補掛 —— 「先開插件再開遊戲」才是玩家實際的順序。
        await adapter.installOkPatch({
          hold: this.#status.agreed.readyEnabled,
          readyTint: this.#readyTint,
        });
        // 重新接上時協商結果可能已經是 3×，頁面卻是全新的 —— 這裡補上。
        await this.#syncSpeed();

        const runner = new ArbiterRunner(adapter.asPageBridge(), {
          config: {
            policy: this.#options.policy ?? "either",
            deadlineSeconds: this.#options.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS,
          },
          capSecondsFor: (hazard) => this.#capFor(hazard),
          onAnnounceReady: (ready) => this.#link?.client.announceReady(ready),
          onAnnounceForceEnd: () => {
            const reason: ForceReason = this.#status.hazard ? "hazard-cap" : "agreed-cap";
            this.#link?.client.announceForceEnd(reason);
          },
          // ⚠ 原始 room id 到這裡為止 —— 送出去的只有雜湊（§12）。
          // `null` = 離開對戰（回大廳，或去打任務／渦）→ 直接退出那間房，
          // 否則會沿用上一場的配對，讓 NPC 戰也拿到 both-ready。
          onRoomChange: (room) => {
            this.#link?.client.setRoom(room === null ? null : roomKey(room));
            // ⚠ 這一行是玩家唯一看得到「握手真的解除了」的證據。2026-08-20
            // 修的正是它沒發生：戰鬥打完了，側通道還停在上一場的房裡。
            // **不要寫房號**（§12），只講事件本身。
            if (room === null) this.#log("· 離開對戰 —— 已退出側通道的房間（握手解除）");
          },
          onModeChange: ({ pvp, rule }) => {
            this.#emit({ pvp, rule });
            // 只在**進**了非對戰時講一句。玩家看到「已配對」卻沒反應時，
            // 這一行是唯一告訴他原因的東西。
            if (!pvp && rule !== null) {
              this.#log(`· ${describeRule(rule)}—— 準備與秒數都不生效（只對真人對戰）`);
            }
          },
          /**
           * 遊戲重載把 patch 沖掉了 → 重裝。
           *
           * ⚠ 這條路**不會**觸發重連（CDP 連線還好好的），所以沒有別人會來救。
           * 節流是必要的：tick 每秒四次，不擋的話重載的那幾秒會連發十幾次
           * `Runtime.evaluate`，而每一次都在頁面上重跑一次安裝腳本。
           */
          onPatchLost: () => void this.#reinstall(adapter),
          onError: (err) => this.#emit({ error: err.message }),
          onStep: () => {
            const runnerNow = this.#runner;
            if (runnerNow === null) return;
            this.#emit({
              seat: runnerNow.seat,
              armed: runnerNow.armed,
              hazard: runnerNow.hazard,
              capSeconds: this.#capFor(runnerNow.hazard),
            });
          },
        });
        this.#runner = runner;
        await runner.start();
        this.#emit({ seat: runner.seat, armed: runner.armed });

        const reason = await Promise.race([lost, stopped.then(() => null)]);
        runner.stop();
        this.#runner = null;
        // ⚠ 模式也要清掉。留著「上一次是對戰」會讓重連後的第一段時間 UI 說
        // 功能生效中，而那時根本還沒問過頁面。
        this.#emit({
          connected: false,
          armed: false,
          seat: null,
          speedApplied: null,
          pvp: false,
          rule: null,
          // 埠也要清掉：關掉遊戲再開有可能換一個，留著舊的會讓玩家拿它去 CLI 用。
          port: null,
        });

        if (reason !== null) {
          // ⚠ 這裡**不要**試著拆攔截 —— 連線已經死了，evaluate 只會再拋一次錯。
          // 頁面那邊心跳 3 秒就過期，攔截自己會停手。
          this.#log(`⟳ 連線斷了（${reason}）—— 遊戲關掉了嗎？重新連…`);
          continue;
        }

        // ⚠ **一定要拆。** 留著的話頁面上會有一個沒有鑰匙的鎖。
        try {
          const gone = await adapter.uninstallOkPatch();
          this.#log(gone === "uninstalled" ? "✓ 攔截已拆除，遊戲回到原本行為" : "（本來就沒裝）");
          // 加速沒有心跳，不拆就會一直留在頁面上直到玩家自己重載遊戲。
          await adapter.uninstallSpeedPatch();
        } catch (err) {
          this.#log(`✗ 拆不掉攔截：${describe(err)}（遊戲重載一次就會乾淨）`);
        }
      } catch (err) {
        this.#runner?.stop();
        this.#runner = null;
        this.#emit({ connected: false, error: describe(err), speedApplied: null });
        if (this.#stopping) break;
        await sleep(CONNECT_RETRY_MS);
      } finally {
        this.#adapter = null;
        await adapter.disconnect();
      }
    }
  }

  /** 同一時間只重裝一次，而且兩次之間至少隔這麼久。 */
  #reinstalling = false;
  #lastReinstall = 0;

  async #reinstall(adapter: ReturnType<typeof createCdpAdapter>): Promise<void> {
    const now = Date.now();
    if (this.#reinstalling || now - this.#lastReinstall < REINSTALL_COOLDOWN_MS) return;
    this.#reinstalling = true;
    this.#lastReinstall = now;
    try {
      const status = await adapter.installOkPatch({
        hold: this.#status.agreed.readyEnabled,
        readyTint: this.#readyTint,
      });
      this.#log(`⟳ 遊戲重載過，攔截已重新裝上（${status}）`);
      this.#emit({ error: null });
      // ⚠ 重載把罰則補丁也沖掉了（它是 evaluate 裝的）。不補的話症狀是
      // 「牌組畫面的罰 C 突然變回原版」，而玩家不會把它跟重載連在一起。
      await this.#syncPenalty();
      // ⚠ 重載把加速也沖掉了。不補的話症狀是「打到一半突然變回原速」，
      // 而玩家完全不會把它跟「剛剛重載過」連在一起。
      await this.#syncSpeed();
      // ⚠ 隱藏地圖也是。症狀是「開房選單又只剩官方那 11 項」。
      await this.#syncHiddenStages();
      // ⚠ 大廳的快速比賽也是 `evaluate` 裝的。少了這一行，症狀是「按鈕有時候
      // 沒出現」—— 而「有時候」正好就是**我們自己重載過**的那些時候
      // （卡片價格要套用時會重載一次），所以它比看起來常見得多。
      await this.#syncLobby();
    } catch (err) {
      // 連線多半也快死了 —— 那條路會走重連，這裡安靜退場就好。
      this.#emit({ error: `重裝攔截失敗：${describe(err)}` });
    } finally {
      this.#reinstalling = false;
    }
  }

  #onPageReport(report: OkPatchReport): void {
    if (report.type === "ok-patch-error") {
      this.#emit({ error: report.reason });
      return;
    }
    if (report.type === "ok-patch-rearmed") {
      this.#log(`⟳ 換場，攔截已重新掛上  座位=${report.seat ?? "(還不知道)"}`);
      return;
    }
    if (report.type === "ok-released") {
      // ⚠ `failsafe` 代表連心跳都沒發揮作用 —— 最後一道防線，不該常發生。
      const label: Record<string, string> = {
        arbiter: "仲裁放行",
        forced: "約定秒數到了（替你按的）",
        "phase-ended": "階段結束",
        "node-gone": "⚠ 心跳過期",
        failsafe: "⚠ 失效保護",
        reinstall: "換版",
        uninstall: "拆除",
      };
      const what = label[report.by] ?? report.by;
      this.#emit({ lastSend: what });
      this.#log(`→ 送出 I_am_ok（${what}，壓了 ${(report.heldMs / 1000).toFixed(1)}s）`);
    }
  }

  /**
   * 一直等到連得上為止。回傳分頁標題；被 `stop()` 打斷就回 `null`。
   *
   * ⚠ 沒有次數上限是刻意的：玩家什麼時候開遊戲、開幾次、中途關掉再開，
   * 都不該讓插件自己結束。
   */
  async #openWhenReady(): Promise<{
    adapter: ReturnType<typeof createCdpAdapter>;
    title: string;
    port: number;
  } | null> {
    const preferred = this.#options.port ?? DEFAULT_DEBUG_PORT;
    const userDataDir = this.#options.userDataDir;

    for (let attempt = 1; !this.#stopping; attempt++) {
      // ⚠ **解析要在迴圈裡面。** 玩家的順序常常是「先開插件、再開遊戲」，
      // 而遊戲挑到哪個埠是它啟動時才決定的 —— 在迴圈外面解析一次，就等於
      // 用「遊戲還沒開」那一刻的答案connect一輩子。
      const resolved = await resolveDebugPort({ port: preferred, userDataDir });
      const port = resolved?.port ?? preferred;
      const adapter = createCdpAdapter({ port });

      try {
        const session = await adapter.connect();
        await adapter.waitForGame();
        if (port !== preferred) {
          // 這件事一定要講。玩家設定裡看到的是 preferred，而之後所有指令
          // （CLI 的 --port、arbiter、probe）要接的是這一個。
          this.#log(
            `ℹ :${preferred} 沒有回應，改用客戶端自己記下的 :${port}（DevToolsActivePort）`,
          );
        }
        return { adapter, title: session.title, port };
      } catch (err) {
        // 連不上就把這一輪的 adapter 收乾淨，不要留著等 GC。
        await adapter.disconnect().catch(() => {});
        // ⚠ 不能安靜地等。埠打錯的症狀會是「跑起來之後什麼都沒發生」，
        // 而真正的原因只在第一行閃過去。
        if (attempt === 1) this.#emit({ connected: false, error: `等遊戲…（${describe(err)}）` });

        // 「沒人在聽」「這個埠根本綁不上」「被別的程式佔走了」在原始錯誤訊息裡
        // 長得一模一樣，但玩家要做的事完全不同（等 / 換埠 / 關掉那支程式）。
        //
        // ⚠ **算出來的話要放進 `error`，不能只寫進記錄。** 玩家看的是狀態列上
        // 那句話；只寫記錄等於沒講 —— 會去翻記錄的人本來就查得出來。
        //
        // 每 30 次（約一分鐘）重算一次而不是只算一次：埠的狀況會變（別的程式
        // 剛好在這段時間起來或關掉），而停在一句過期的診斷比不講更誤導。
        if (attempt === 1 || attempt % 30 === 0) {
          void explainDebugPort({ port: preferred, userDataDir })
            .then((hint) => {
              if (this.#status.connected) return; // 這幾毫秒內接上了，別蓋掉。
              this.#log(`ℹ ${hint}`);
              this.#emit({ error: hint });
            })
            .catch(() => {});
        }
        await sleep(CONNECT_RETRY_MS);
      }
    }
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * rule 字串 → 玩家看得懂的名字。
 *
 * 認不出來的照原樣印出來，**不要吞掉** —— 遊戲改版多一種模式時，那一行就是
 * 唯一的線索（而症狀會是「這個模式底下插件突然不動了」）。
 */
function describeRule(rule: string): string {
  const names: Record<string, string> = {
    quest: "任務",
    raid: "渦",
    event: "活動",
    duel: "對戰",
    ranked: "排名戰",
  };
  const name = names[rule];
  return name === undefined ? `非對戰模式（${rule}）` : `${name}（對手是 NPC）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
