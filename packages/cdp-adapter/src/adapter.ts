/**
 * 把上面那些零件串成一個可用的東西
 * ==================================
 * 連線 → attach 到遊戲分頁 → 開 Runtime/Page → 建 binding → 注入腳本 →
 * 收頁面的回報。
 *
 * 一個刻意的設計決定：**這個類別不會自己 reload 遊戲。**
 * `Page.addScriptToEvaluateOnNewDocument` 只對**之後**載入的 document 生效，
 * 所以在遊戲已經開著的時候套用 COST 規則，要等下一次載入才看得到。
 * 誘惑是「那就順手 reload 一下」—— 不行，玩家可能正在打。
 * `installCostOverrides()` 回傳 `takesEffectOnNextLoad`，由 UI 去問玩家。
 * （docs/launching.md 的「偵測與降級」第 3 點講的是同一件事。）
 */

import type { GameBundles } from "./boot-shell.js";
import { BUNDLE_DISCOVERY_EXPRESSION, parseDiscoveredBundles } from "./boot-shell.js";
import { CdpClient } from "./client.js";
import { DEFAULT_DEBUG_PORT } from "./constants.js";
import type { GameExecutionContext } from "./game-context.js";
import {
  DEFAULT_CONTEXT_TIMEOUT_MS,
  ExecutionContextTracker,
  findGameContext,
} from "./game-context.js";
import type {
  CostOverrides,
  CostOverrideTables,
  CostPatchCoverage,
  CostPatchReport,
} from "./patch-cost.js";
import {
  buildCostPatchCoverageExpression,
  buildCostPatchScript,
  costsStamp,
  costTargetAssetKeys,
  isCostPatchReport,
  parseCostPatchCoverage,
} from "./patch-cost.js";
import type { PenaltyBand, PenaltyPatchReport } from "./patch-penalty.js";
import {
  buildPenaltyPatchScript,
  isPenaltyPatchReport,
  PENALTY_UNINSTALL_EXPRESSION,
} from "./patch-penalty.js";
import type {
  CreateRoomOptions,
  CreateRoomResult,
  JoinRoomResult,
  MatchContext,
  RoomEntry,
} from "./match-room.js";
import {
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  MATCH_ROOM_INSTALL_EXPRESSION,
} from "./match-room.js";
import type { LobbyReport, LobbyState, LobbyStatus } from "./patch-lobby.js";
import {
  buildLobbyErrorExpression,
  buildLobbyPatchScript,
  buildLobbyStateExpression,
  isLobbyReport,
  LOBBY_STATUS_EXPRESSION,
  LOBBY_UNINSTALL_EXPRESSION,
  parseLobbyStatus,
} from "./patch-lobby.js";
import type { HiddenStage, HiddenStageStatus } from "./patch-stage.js";
import {
  buildHiddenStageScript,
  HIDDEN_STAGE_STATUS_EXPRESSION,
  HIDDEN_STAGE_UNINSTALL_EXPRESSION,
  parseHiddenStageStatus,
} from "./patch-stage.js";
import type { CdpTransport } from "./protocol.js";
import type {
  CardProfiles,
  CharacterAssetTable,
  CostPatchState,
  IndexedCardTable,
} from "./read-card-assets.js";
import {
  CC_ASSET_READ_EXPRESSION,
  COST_PATCH_STATE_EXPRESSION,
  EVENT_CARD_READ_EXPRESSION,
  MC_ASSET_READ_EXPRESSION,
  PROFILE_READ_EXPRESSION,
  WEAPON_READ_EXPRESSION,
  parseCharacterAssets,
  parseCostPatchState,
  parseIndexedCards,
  parseProfiles,
} from "./read-card-assets.js";
import type { GamePageSession } from "./session.js";
import { attachToGamePage } from "./session.js";
import { discoverDebuggerUrl, WebSocketTransport } from "./transport.js";
import type { WsWatchReport } from "./ws-events.js";
import { buildWsWatchScript, isWsWatchReport } from "./ws-events.js";
import type { PageBridge } from "./arbiter-runner.js";
import type { OkPatchReport } from "./patch-ok.js";
import {
  buildOkPatchScript,
  isOkPatchReport,
  OK_PATCH_GLOBAL,
  OK_PATCH_UNINSTALL_EXPRESSION,
} from "./patch-ok.js";
import type { SpeedPatchReport } from "./patch-speed.js";
import {
  buildSpeedPatchScript,
  isSpeedPatchReport,
  SPEED_PATCH_RENEW_EXPRESSION,
  SPEED_PATCH_UNINSTALL_EXPRESSION,
} from "./patch-speed.js";

/**
 * 頁面用來把資料送回 Node 的全域函式名。
 *
 * 取一個一看就知道是誰的名字：如果玩家自己裝了別的腳本，衝突時比較好查。
 */
export const REPORT_BINDING_NAME = "__ulrCompanionReport";

export interface CdpAdapterOptions {
  port?: number;
  commandTimeoutMs?: number;
  contextTimeoutMs?: number;
  /**
   * 換掉傳輸層。正式路徑不會用到 —— 這是給測試接假 transport 的。
   */
  transportFactory?: (port: number) => Promise<CdpTransport>;
}

export interface CostPatchInstallation {
  /** `Page.removeScriptToEvaluateOnNewDocument` 要用的識別碼。 */
  scriptIdentifier: string;
  /**
   * 一定是 true —— 注入只影響之後載入的 document。
   *
   * 留成欄位而不是寫在文件裡，是為了讓呼叫端在型別上就被迫面對它，
   * 而不是等玩家回報「設定了但沒反應」。
   */
  takesEffectOnNextLoad: true;
}

export class NotConnectedError extends Error {
  override readonly name = "NotConnectedError";
  constructor() {
    super("還沒 connect()。");
  }
}

/** 發給訂閱者。§9.1：訂閱者出錯不得讓插件或遊戲崩潰，所以每個都各自包起來。 */
function dispatch<T>(handlers: ReadonlySet<(report: T) => void>, report: T): void {
  for (const handler of [...handlers]) {
    try {
      handler(report);
    } catch {
      // 故意吞掉。
    }
  }
}

export class CdpAdapter {
  #options: CdpAdapterOptions;
  #client: CdpClient | null = null;
  #session: GamePageSession | null = null;
  #tracker: ExecutionContextTracker | null = null;
  #context: GameExecutionContext | null = null;
  #reportHandlers = new Set<(report: CostPatchReport) => void>();
  #penaltyHandlers = new Set<(report: PenaltyPatchReport) => void>();
  #wsHandlers = new Set<(report: WsWatchReport) => void>();
  #okHandlers = new Set<(report: OkPatchReport) => void>();
  #speedHandlers = new Set<(report: SpeedPatchReport) => void>();
  #lobbyHandlers = new Set<(report: LobbyReport) => void>();
  #closeHandlers = new Set<(reason: string) => void>();

  constructor(options: CdpAdapterOptions = {}) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#client !== null && !this.#client.closed;
  }

  /** 已去識別化的遊戲分頁資訊。連線後才有值。 */
  get session(): GamePageSession | null {
    return this.#session;
  }

  async connect(): Promise<GamePageSession> {
    const port = this.#options.port ?? DEFAULT_DEBUG_PORT;
    const transport =
      this.#options.transportFactory !== undefined
        ? await this.#options.transportFactory(port)
        : await WebSocketTransport.connect(await discoverDebuggerUrl(port));

    // ⚠ 玩家關掉遊戲再開，是**新的** Electron／瀏覽器實例：新的 debugger URL、
    // 新的 target、新的 execution context。舊的 contextId 留著會讓重連後每次
    // evaluate 都撞 "Session with given id not found"。
    this.#context = null;

    transport.onClose((reason) => {
      this.#context = null;
      dispatch(this.#closeHandlers, reason);
    });

    const client = new CdpClient(transport, {
      ...(this.#options.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: this.#options.commandTimeoutMs }
        : {}),
    });
    this.#client = client;

    const session = await attachToGamePage(client);
    this.#session = session;

    // ⚠ 順序要緊：tracker 必須在 Runtime.enable 之前建立。
    // Runtime.enable 會把已經存在的 context 以事件補送一次，晚一步掛就收不到，
    // 接上「已經在跑的遊戲」時會永遠等不到 context。
    this.#tracker = new ExecutionContextTracker(client, session.sessionId);

    client.on("Runtime.executionContextsCleared", (_params, sid) => {
      if (sid === session.sessionId) this.#context = null;
    });
    client.on("Runtime.bindingCalled", (params, sid) => {
      if (sid !== session.sessionId) return;
      this.#onBindingCalled(params);
    });

    await client.send("Page.enable", undefined, session.sessionId);
    await client.send("Runtime.enable", undefined, session.sessionId);

    // 不指定 executionContextId：對「所有現有與之後建立的 context」都加，
    // 這樣 iframe 重新建立時 binding 還在。
    await client.send("Runtime.addBinding", { name: REPORT_BINDING_NAME }, session.sessionId);

    return session;
  }

  /**
   * 等到遊戲的 execution context 就緒。
   *
   * 冷啟動時 Electron 從開視窗到 Phaser 就緒要數秒，所以這支跟 `connect()`
   * 分開 —— 沒必要讓「連上去」這件事被「遊戲還在載」擋住。
   */
  async waitForGame(timeoutMs?: number): Promise<GameExecutionContext> {
    const client = this.#client;
    const tracker = this.#tracker;
    const session = this.#session;
    if (client === null || tracker === null || session === null) throw new NotConnectedError();

    if (this.#context !== null) return this.#context;

    const context = await findGameContext(client, tracker, {
      sessionId: session.sessionId,
      timeoutMs: timeoutMs ?? this.#options.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS,
    });
    this.#context = context;
    return context;
  }

  /**
   * 在遊戲的 context 裡執行 JS。
   *
   * §12：回傳值會被搬回 Node，所以**不要**把整個遊戲物件或原始封包撈回來。
   * 只取需要的欄位，而且不要取隱藏資訊。
   */
  async evaluate<T>(expression: string): Promise<T> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();

    const context = await this.waitForGame();
    const res = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        contextId: context.contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      session.sessionId,
    );

    if (res.exceptionDetails !== undefined) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`注入的程式在遊戲裡拋例外：${detail ?? "(沒有細節)"}`);
    }
    return res.result?.value as T;
  }

  /**
   * 讀出這個客戶端正在跑的三個 webpack bundle 檔名。
   *
   * 這是「免 Steam 啟動」不會因為遊戲改版而壞掉的關鍵：檔名帶 content hash，
   * 每次改版都會變。上游那支 Greasyfork 腳本把檔名寫死，所以得靠作者每週發
   * 新版；我們改成從**玩家自己跑著的客戶端**讀，正常從 Steam 開一次遊戲就
   * 自己更新了。
   *
   * 要在正常 Steam 流程開起來的分頁上呼叫 —— 免 Steam 開的分頁是我們自己
   * 用舊檔名重建的，從它身上讀只會讀回同一份舊資料。
   */
  async discoverBundles(): Promise<GameBundles> {
    const raw = await this.evaluate<string>(BUNDLE_DISCOVERY_EXPRESSION);
    return parseDiscoveredBundles(raw);
  }

  // -------------------------------------------------------------------------
  // 約戰：開房 / 進房（WP-16）
  // -------------------------------------------------------------------------

  /**
   * 裝上開房／進房的操作介面。**不需要 reload。**
   *
   * ⚠ 只是裝介面，本身不會動到任何東西。真正會改變遊戲狀態的是
   * `createRoom()` / `joinRoom()`，那兩支必須由玩家明確觸發。
   */
  async installMatchRoom(): Promise<string> {
    return await this.evaluate<string>(MATCH_ROOM_INSTALL_EXPRESSION);
  }

  /** 現在在哪個頻道、選了哪副牌組、叫什麼名字。 */
  async matchContext(): Promise<MatchContext> {
    const raw = await this.evaluate<string>("window.__ulrMatch.context()");
    return JSON.parse(raw) as MatchContext;
  }

  /**
   * 最後一次收到的房間清單。
   *
   * ⚠ 這是遊戲廣播給大廳**每一個人**的公開資料（MatchingLobby 的房間列就是
   * 用它畫的，含雙方牌組縮圖），不是隱藏資訊。但**不得**拿來挑對手。
   */
  async roomSnapshot(): Promise<{ seq: number; live: boolean; rooms: RoomEntry[] }> {
    const raw = await this.evaluate<string>("window.__ulrMatch.rooms_snapshot()");
    return JSON.parse(raw) as { seq: number; live: boolean; rooms: RoomEntry[] };
  }

  /**
   * 開一間房。⚠ **會消耗 AP 5**，而且會出現在公開的房間清單上。
   */
  async createRoom(options: CreateRoomOptions): Promise<CreateRoomResult> {
    const raw = await this.evaluate<string>(buildCreateRoomExpression(options));
    return JSON.parse(raw) as CreateRoomResult;
  }

  /** 進別人的房。⚠ 成功就直接進對戰了。 */
  async joinRoom(roomId: string, pass: string): Promise<JoinRoomResult> {
    const raw = await this.evaluate<string>(buildJoinRoomExpression(roomId, pass));
    return JSON.parse(raw) as JoinRoomResult;
  }

  /** 收掉自己開的房。取消配對時一定要叫，否則清單上會留空房。 */
  async cancelRoom(): Promise<string> {
    return await this.evaluate<string>("window.__ulrMatch.cancel()");
  }

  /**
   * 這一份文件的卡表被改寫過了嗎 —— **讀名冊之前要問這個**。
   *
   * 問的是頁面自己的旗標，不是插件記的狀態。兩者分開的三種時機（停用沒重載、
   * 換規則、托盤重開）見 `COST_PATCH_STATE_EXPRESSION` 的說明。
   */
  async costPatchState(): Promise<CostPatchState> {
    const raw = await this.evaluate<string>(COST_PATCH_STATE_EXPRESSION);
    return parseCostPatchState(raw);
  }

  /**
   * 讀回這個客戶端的原版角色卡資料（`cc_asset`）。
   *
   * ⚠ 要在**沒有套自訂 COST**的客戶端上呼叫 —— `installCostOverrides` 是就地
   * 改寫同一份快取資料，套過之後讀回來的是被改過的數字。先問
   * {@link costPatchState}。詳見 `read-card-assets.ts`。
   */
  async readCharacterAssets(): Promise<CharacterAssetTable> {
    const raw = await this.evaluate<string>(CC_ASSET_READ_EXPRESSION);
    return parseCharacterAssets(raw);
  }

  /**
   * 怪物卡（`mc_asset`）。形狀跟角色一模一樣，所以共用同一個解析器。
   *
   * ⚠ 怪物**跟角色共用同樣那三個槽位、照樣參與壓 C** —— 它不是第四種加項。
   */
  async readMonsterAssets(): Promise<CharacterAssetTable> {
    const raw = await this.evaluate<string>(MC_ASSET_READ_EXPRESSION);
    return parseCharacterAssets(raw);
  }

  /**
   * 裝備（`avatar_item.weapon`）。**回傳的是陣列索引，不是 `wp001`** ——
   * 規則鍵的命名是 `@ulr/rule-schema` 的事，見 `read-card-assets.ts`。
   */
  async readWeaponAssets(): Promise<IndexedCardTable> {
    const raw = await this.evaluate<string>(WEAPON_READ_EXPRESSION);
    return parseIndexedCards(raw);
  }

  /** 事件卡（`event_info.frames`）。同樣回傳陣列索引。 */
  async readEventCardAssets(): Promise<IndexedCardTable> {
    const raw = await this.evaluate<string>(EVENT_CARD_READ_EXPRESSION);
    return parseIndexedCards(raw);
  }

  /**
   * 角色與怪物的**中文名**（`charaProfile` / `monsProfile`）。
   *
   * 編輯 COST 的介面靠這個活著 —— 玩家看得懂「艾伯李斯特」，看不懂 `cc001_01`。
   */
  async readProfiles(): Promise<CardProfiles> {
    const raw = await this.evaluate<string>(PROFILE_READ_EXPRESSION);
    return parseProfiles(raw);
  }

  /**
   * 裝上自訂 COST。
   *
   * 吃四張表（`{ characters, monsters, equipment, eventCards }`），也吃只有
   * 角色的舊寫法（一個扁平的 `Record<string, number>`）。
   *
   * 鍵：角色與怪物用資產的 `filename`（`cc078_04` / `mc001_01`），裝備與
   * 事件卡用**陣列索引字串**。理由見 `patch-cost.ts` 與 docs/open-questions.md 第 1 題。
   */
  async installCostOverrides(
    costs: CostOverrides | CostOverrideTables,
  ): Promise<CostPatchInstallation> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();

    const source = buildCostPatchScript({ costs, bindingName: REPORT_BINDING_NAME });
    const res = await client.send<{ identifier?: unknown }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      session.sessionId,
    );

    if (typeof res.identifier !== "string") {
      throw new Error("Page.addScriptToEvaluateOnNewDocument 沒有回傳 identifier");
    }
    return { scriptIdentifier: res.identifier, takesEffectOnNextLoad: true };
  }

  /**
   * 把同一份 COST 補丁**直接裝到現在這個頁面上**，不等下一次載入。
   *
   * ⚠ **這不是 `installCostOverrides()` 的替代品，是它的搭檔。**
   * 那支負責「之後每一次載入」（重載、玩家自己按 F5 都靠它），這支負責
   * 「現在這個已經開著的頁面」。玩家從 Steam 開遊戲時，插件是在遊戲**已經
   * 建好 document 之後**才接上的 —— 只走那支的話，掛鉤永遠不會在這一輪跑到，
   * 症狀就是「插件開著、規則也載了，但遊戲裡還是原版價格」。
   *
   * 趕不趕得上要看 `costAssetsLoaded()`：已經在快取裡的資料這條路救不回來。
   */
  async installCostOverridesLive(costs: CostOverrides | CostOverrideTables): Promise<void> {
    const source = buildCostPatchScript({ costs, bindingName: REPORT_BINDING_NAME });
    await this.evaluate<unknown>(source);
  }

  /**
   * 補丁有沒有蓋到這個頁面上**已經載入**的卡片資料。
   *
   * 回傳的 `missed` 不是空的 = 那幾張是在補丁裝上之前就載進來的，掛鉤碰不到，
   * 只有重載才會套上新價格。判準為什麼是「載了卻沒改到」而不是「載了」，
   * 見 `buildCostPatchCoverageExpression`。
   */
  async costPatchCoverage(costs: CostOverrides | CostOverrideTables): Promise<CostPatchCoverage> {
    const targets = costTargetAssetKeys(costs);
    if (Object.keys(targets).length === 0) return { missed: [], covered: [] };
    // ⚠ 指紋一定要一起送。少了它，「頁面上蓋的是上一份規則」會被判成沒事，
    // 而那個症狀跟「插件完全沒生效」在畫面上分不出來。
    const raw = await this.evaluate<string>(
      buildCostPatchCoverageExpression(targets, costsStamp(costs)),
    );
    return parseCostPatchCoverage(raw);
  }

  /** 拆掉之前裝的腳本。同樣要等下次載入才會真的消失。 */
  async removeCostOverrides(scriptIdentifier: string): Promise<void> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();
    await client.send(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: scriptIdentifier },
      session.sessionId,
    );
  }

  /**
   * 重新載入遊戲，讓注入生效。
   *
   * ⚠ **這會打斷玩家。** 只在玩家自己按下按鈕時呼叫，絕不要在偵測到
   * 「規則還沒生效」時自動做 —— 他可能正在對戰中。
   */
  async reloadGame(): Promise<void> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();
    this.#context = null;
    await client.send("Page.reload", undefined, session.sessionId);
  }

  /**
   * 連線斷掉時通知。回傳的函式呼叫一次即取消訂閱。
   *
   * ⚠ 長時間掛著的功能（例如仲裁）**一定要接這個**。玩家關掉遊戲再開是
   * 家常便飯，而症狀不是「插件報錯」而是「插件安靜地不再作用」——
   * 每次 evaluate 都拿到 `Session with given id not found`，然後就沒了。
   * 要玩家自己發現並重跑插件是不合理的。
   */
  onDisconnect(handler: (reason: string) => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  /** 訂閱注入腳本回報的結果。回傳的函式呼叫一次即取消訂閱。 */
  onCostPatchReport(handler: (report: CostPatchReport) => void): () => void {
    this.#reportHandlers.add(handler);
    return () => this.#reportHandlers.delete(handler);
  }

  /** 訂閱壓 C 罰則補丁的回報。 */
  onPenaltyPatchReport(handler: (report: PenaltyPatchReport) => void): () => void {
    this.#penaltyHandlers.add(handler);
    return () => this.#penaltyHandlers.delete(handler);
  }

  /**
   * 改寫遊戲內顯示的壓 C 罰則。
   *
   * ⚠ 跟 `installCostOverrides()` 不同，這支**不需要 reload** —— `Deck` 類別
   * 在遊戲跑起來之後一直都在，`Runtime.evaluate` 隨時掛得上去，而且會順手把
   * 牌組畫面重畫一次。玩家改了規則就當場看到新數字。
   *
   * 換規則時直接再呼叫一次即可：頁面端會從**原始**的 `getCost` 重新包，
   * 不會疊補丁。
   */
  async installPenaltyOverrides(bands: readonly PenaltyBand[]): Promise<void> {
    const source = buildPenaltyPatchScript({ bands, bindingName: REPORT_BINDING_NAME });
    await this.evaluate<unknown>(source);
  }

  /** 把罰則還原成遊戲原本的算法。 */
  async uninstallPenaltyOverrides(): Promise<string> {
    return await this.evaluate<string>(PENALTY_UNINSTALL_EXPRESSION);
  }

  // -------------------------------------------------------------------------
  // 隱藏地圖
  // -------------------------------------------------------------------------

  /**
   * 把隱藏地圖加進遊戲自己的開房對話框。
   *
   * ⚠ 跟 `installCostOverrides()` 不同，這支**不需要 reload**（走
   * `Runtime.evaluate`）—— 但也因此**遊戲重載就會被沖掉**，接上時要重裝一次。
   *
   * ⚠ 回傳的 `dropdownPatched` 幾乎一定是 `false`：選單那個類別要等玩家第一次
   * 開「創建對戰房間」才碰得到（見 `patch-stage.ts` 的檔頭）。那不是失敗，
   * UI 要照實說。
   */
  async installHiddenStages(stages: readonly HiddenStage[]): Promise<HiddenStageStatus> {
    const raw = await this.evaluate<string>(buildHiddenStageScript({ stages }));
    return parseHiddenStageStatus(raw);
  }

  /** 隱藏地圖現在的狀態。頁面上沒裝（或被重載沖掉）會回 `installed: false`。 */
  async hiddenStageStatus(): Promise<HiddenStageStatus> {
    const raw = await this.evaluate<string>(HIDDEN_STAGE_STATUS_EXPRESSION);
    return parseHiddenStageStatus(raw);
  }

  /** 把選單還原成官方的 11 項。 */
  async uninstallHiddenStages(): Promise<string> {
    return await this.evaluate<string>(HIDDEN_STAGE_UNINSTALL_EXPRESSION);
  }

  // -------------------------------------------------------------------------
  // 迪特赫姆的快速比賽（WP-17）
  // -------------------------------------------------------------------------

  /** 訂閱「玩家按了大廳那顆快速比賽」。 */
  onLobbyReport(handler: (report: LobbyReport) => void): () => void {
    this.#lobbyHandlers.add(handler);
    return () => this.#lobbyHandlers.delete(handler);
  }

  /**
   * 在 duel 頻道的大廳畫一顆「快速比賽」。
   *
   * ⚠ 跟 `installCostOverrides()` 不同，這支走 `Runtime.evaluate`，**不需要
   * 重載遊戲** —— 但同樣地，**遊戲一重載就會被沖掉**，重連時要再裝一次。
   *
   * ⚠ 回傳的 `buttonReady` 常常是 `false`，那**不是失敗**：玩家還沒進頻道時
   * 面板根本不存在。腳本會自己盯著，進去了就掛上。
   */
  async installLobbyPatch(): Promise<LobbyStatus> {
    const raw = await this.evaluate<string>(
      buildLobbyPatchScript({ bindingName: REPORT_BINDING_NAME }),
    );
    return parseLobbyStatus(raw);
  }

  async lobbyStatus(): Promise<LobbyStatus> {
    const raw = await this.evaluate<string>(LOBBY_STATUS_EXPRESSION);
    return parseLobbyStatus(raw);
  }

  /** 把等待人數與配對狀態推到畫面上。**畫面上的每一個字都由這支決定。** */
  async setLobbyState(state: LobbyState): Promise<string> {
    return await this.evaluate<string>(buildLobbyStateExpression(state));
  }

  /**
   * 跳出遊戲自己的錯誤對話框（「這個牌組不符合遊戲規則」）。
   *
   * `code` 是 `Match.room_error[lang]` 的索引 —— 用代碼而不是字串，玩家的
   * 客戶端是什麼語言就顯示什麼語言。
   */
  async showLobbyError(code: number | null, message?: string): Promise<string> {
    return await this.evaluate<string>(buildLobbyErrorExpression(code, message));
  }

  async uninstallLobbyPatch(): Promise<string> {
    return await this.evaluate<string>(LOBBY_UNINSTALL_EXPRESSION);
  }

  /**
   * 開始監看 WebSocket 事件（WP-09）。
   *
   * ⚠ 跟 `installCostOverrides()` 不同，這支**不需要 reload** —— WSClient 的
   * 原型與實例在遊戲跑起來之後一直都在，用 `Runtime.evaluate` 隨時掛得上去。
   * 所以玩家正在對戰中也能接上來看，不必先把人踢出戰鬥。
   *
   * 回傳頁面給的狀態：`ok`（新裝好）／`updated`（本來就掛著，換了設定）／
   * `no-socket`（還沒進遊戲或連線還沒建好，等一下再試）。
   *
   * ⚠ `updated` 只換**設定**，不換程式碼。改了 `ws-events.ts` 的邏輯要重載
   * 遊戲才會生效 —— 症狀是「測試綠了但實際跑起來沒反應」。
   * （`installOkPatch()` 沒有這個問題，它會先把舊 patch 拆掉再重裝。）
   *
   * §12：預設只收到事件名、參數形狀與時間戳。`valueEvents` 清單上的事件
   * 才會帶值，而且**超長字串永遠只有長度** —— 界線在 `ws-events.ts` 的
   * `shapeOf()` 與 `VALUE_MAX_STRING_LENGTH`。
   */
  async installWsWatch(
    options: { valueEvents?: readonly string[] } = {},
  ): Promise<"ok" | "updated" | "no-socket"> {
    const source = buildWsWatchScript({
      bindingName: REPORT_BINDING_NAME,
      ...(options.valueEvents !== undefined ? { valueEvents: options.valueEvents } : {}),
    });
    const status = await this.evaluate<string>(source);
    if (status === "ok" || status === "updated" || status === "no-socket") return status;
    throw new Error(`監看腳本回傳了預期外的狀態：${String(status)}`);
  }

  /** 訂閱 WebSocket 事件。回傳的函式呼叫一次即取消訂閱。 */
  onWsEvent(handler: (report: WsWatchReport) => void): () => void {
    this.#wsHandlers.add(handler);
    return () => this.#wsHandlers.delete(handler);
  }

  /**
   * 裝上 `I_am_ok` 的攔截（WP-12）。
   *
   * ⚠ **這會改變遊戲行為** —— 玩家按下 OK 之後不會立刻送出。裝上去的同時
   * 頁面會自己啟動失效保護（見 `patch-ok.ts`），所以就算這條 CDP 連線之後
   * 斷掉，攔到的呼叫仍然會被送出去，玩家不會逾時棄權。
   *
   * 跟 `installWsWatch()` 一樣不需要 reload，而且**不需要先進對戰**：
   *
   * - `ok` —— 已經掛到 socket 上了
   * - `waiting` —— 還沒進遊戲／還在大廳，頁面會自己補掛（不是錯誤）
   *
   * ⚠ **裝了就一定要有人餵心跳**（`ArbiterRunner` 的 tick 在做這件事），
   * 否則頁面 3 秒後就會停止攔截。這是刻意的 —— 見 `patch-ok.ts` 開頭。
   */
  async installOkPatch(
    options: {
      failsafeMs?: number;
      staleMs?: number;
      hold?: boolean;
      /** 準備中的染色。`null` = 不染色（官方原本的樣子），也是預設。 */
      readyTint?: number | null;
    } = {},
  ): Promise<"ok" | "waiting"> {
    const source = buildOkPatchScript({
      bindingName: REPORT_BINDING_NAME,
      ...(options.failsafeMs !== undefined ? { failsafeMs: options.failsafeMs } : {}),
      ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
      ...(options.hold !== undefined ? { hold: options.hold } : {}),
      ...(options.readyTint !== undefined ? { readyTint: options.readyTint } : {}),
    });
    const status = await this.evaluate<string>(source);
    if (status === "ok" || status === "waiting") return status;
    throw new Error(`OK 攔截腳本回傳了預期外的狀態：${String(status)}`);
  }

  /**
   * 換準備中的染色，不重裝 patch。
   *
   * ⚠ **一定要走這條，不要為了改顏色重裝。** `installOkPatch()` 會先拆再裝，
   * 而拆的時候會把正壓著的 `I_am_ok` 送出去 —— 玩家只是在設定裡挑了個顏色，
   * 卻讓他這回合的 OK 定案了。
   */
  async setReadyTint(tint: number | null): Promise<number | null> {
    return this.evaluate<number | null>(
      `(function () {
        try {
          var A = window.${OK_PATCH_GLOBAL};
          if (!A || typeof A.setReadyTint !== "function") return null;
          return A.setReadyTint(${tint === null ? "null" : String(Math.trunc(tint))});
        } catch (e) { return null; }
      })()`,
    );
  }

  /**
   * 拆掉 `I_am_ok` 的攔截。
   *
   * ⚠ **結束前一定要跑這支。** 2026-08-03 實測：companion 結束時只
   * `disconnect()`，頁面上的 patch 原封不動留著，於是玩家每個移動階段都被
   * 壓滿 25 秒才送出、而且按第二次也取消不了（取消要 Node 下指令）。
   * 心跳讓這件事不再是災難（3 秒後就停止攔截），但留著孤兒沒有任何好處。
   *
   * 拆的時候會**先把壓著的呼叫送出去**，不會害玩家棄權。
   */
  async uninstallOkPatch(): Promise<"uninstalled" | "not-installed"> {
    const status = await this.evaluate<string>(OK_PATCH_UNINSTALL_EXPRESSION);
    if (status === "uninstalled" || status === "not-installed") return status;
    throw new Error(`拆 OK 攔截時回傳了預期外的狀態：${String(status)}`);
  }

  /** 訂閱 OK 攔截的回報。 */
  onOkPatchReport(handler: (report: OkPatchReport) => void): () => void {
    this.#okHandlers.add(handler);
    return () => this.#okHandlers.delete(handler);
  }

  /**
   * 裝上演出加速（WP-14）。
   *
   * 跟 `installWsWatch()` / `installOkPatch()` 一樣不需要 reload，對戰中也能
   * 接上；還沒進遊戲也裝得起來（回 `waiting`），頁面每 200ms 自己補上。
   *
   * ⚠ **只加速 tween 與 sprite 動畫，不碰 `scene.time`。** 倒數計時器住在
   * `scene.time` 裡，加速它會讓畫面上的 TIME 跑快，而 WP-12 的硬底線讀的正是
   * 那個數字 —— 兩個功能各自都對，合起來會害玩家被強制提早送出 `I_am_ok`。
   * 理由與實測見 `patch-speed.ts` 檔頭。
   *
   * ⚠ 收益的期望值要講實話：實測約 **1 分鐘／場**（省的是決策窗開頭被殘留
   * 動畫擋住的那 75 秒），不是「對戰快一半」。伺服器排程的部分動不了。
   */
  async installSpeedPatch(
    options: { factor?: number; leaseMs?: number } = {},
  ): Promise<"ok" | "waiting"> {
    const source = buildSpeedPatchScript({
      bindingName: REPORT_BINDING_NAME,
      ...(options.factor !== undefined ? { factor: options.factor } : {}),
      // ⚠ 一定要往下傳。漏掉的話呼叫端指定的租約會被安靜地換成預設值 ——
      // 而症狀是「測試裡設 3 秒過期，實際等 3 秒卻沒過期」，看起來像租約壞了。
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    });
    const status = await this.evaluate<string>(source);
    if (status === "ok" || status === "waiting") return status;
    throw new Error(`加速腳本回傳了預期外的狀態：${String(status)}`);
  }

  /**
   * 拆掉演出加速，把 `timeScale` 全部還原成 1。
   *
   * ⚠ 結束前一定要跑。留著孤兒的話玩家會一直在加速狀態，而且**沒有任何 UI
   * 告訴他**（跟 patch-ok 的孤兒不同，這個不會痛，只會讓人以為遊戲本來就這樣，
   * 之後回報「動畫怎麼變快了」而查不出原因）。
   *
   * 正常關閉走這條。**插件當掉時走的是租約**（`renewSpeedLease`）——
   * 那條路不需要任何人還活著。
   */
  async uninstallSpeedPatch(): Promise<"uninstalled" | "not-installed"> {
    const status = await this.evaluate<string>(SPEED_PATCH_UNINSTALL_EXPRESSION);
    if (status === "uninstalled" || status === "not-installed") return status;
    throw new Error(`拆加速時回傳了預期外的狀態：${String(status)}`);
  }

  /**
   * 續一次租約 —— 「插件還活著」的唯一證明。
   *
   * 回 `not-installed` 代表頁面上那份不見了（多半是玩家重載過遊戲），
   * 呼叫的人要重裝。**這個回傳值不能忽略**，否則症狀是「重載之後加速再也
   * 沒回來」，而且完全沒有錯誤訊息。
   */
  async renewSpeedLease(): Promise<"renewed" | "not-installed"> {
    const status = await this.evaluate<string>(SPEED_PATCH_RENEW_EXPRESSION);
    if (status === "renewed" || status === "not-installed") return status;
    throw new Error(`續約時回傳了預期外的狀態：${String(status)}`);
  }

  /** 訂閱加速的回報。 */
  onSpeedPatchReport(handler: (report: SpeedPatchReport) => void): () => void {
    this.#speedHandlers.add(handler);
    return () => this.#speedHandlers.delete(handler);
  }

  /** 把這個 adapter 當成 `ArbiterRunner` 的頁面橋接。 */
  asPageBridge(): PageBridge {
    return {
      evaluate: <T>(expression: string): Promise<T> => this.evaluate<T>(expression),
      onReport: (handler: (report: OkPatchReport) => void): (() => void) =>
        this.onOkPatchReport(handler),
    };
  }

  async disconnect(): Promise<void> {
    this.#tracker?.dispose();
    this.#tracker = null;
    this.#context = null;
    this.#session = null;
    this.#reportHandlers.clear();
    this.#penaltyHandlers.clear();
    this.#wsHandlers.clear();
    this.#okHandlers.clear();
    this.#speedHandlers.clear();
    this.#closeHandlers.clear();
    this.#client?.close();
    this.#client = null;
    await Promise.resolve();
  }

  #onBindingCalled(params: Record<string, unknown>): void {
    if (params["name"] !== REPORT_BINDING_NAME) return;
    const payload = params["payload"];
    if (typeof payload !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // 頁面上可能有別人的腳本也在呼叫同名 binding。不是我們的就忽略。
      return;
    }

    // 兩種回報共用同一個 binding，用 type 分流。
    if (isCostPatchReport(parsed)) {
      dispatch(this.#reportHandlers, parsed);
      return;
    }
    if (isPenaltyPatchReport(parsed)) {
      dispatch(this.#penaltyHandlers, parsed);
      return;
    }
    if (isWsWatchReport(parsed)) {
      dispatch(this.#wsHandlers, parsed);
      return;
    }
    if (isOkPatchReport(parsed)) {
      dispatch(this.#okHandlers, parsed);
      return;
    }
    if (isSpeedPatchReport(parsed)) {
      dispatch(this.#speedHandlers, parsed);
      return;
    }
    if (isLobbyReport(parsed)) {
      dispatch(this.#lobbyHandlers, parsed);
    }
  }
}

export function createCdpAdapter(options: CdpAdapterOptions = {}): CdpAdapter {
  return new CdpAdapter(options);
}
