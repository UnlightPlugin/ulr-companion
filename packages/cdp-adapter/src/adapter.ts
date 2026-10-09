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
import {
  BUNDLE_DISCOVERY_EXPRESSION,
  parseDiscoveredBundles,
  SERVED_BUNDLES_EXPRESSION,
} from "./boot-shell.js";
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
  CostPatchEnabledResult,
  CostPatchReport,
} from "./patch-cost.js";
import {
  buildCostPatchCoverageExpression,
  buildCostPatchEnabledExpression,
  buildCostPatchScript,
  costsStamp,
  costTargetAssetKeys,
  isCostPatchReport,
  parseCostPatchCoverage,
  parseCostPatchEnabledResult,
} from "./patch-cost.js";
import type { CostToggleReport, CostToggleState, CostToggleStatus } from "./patch-cost-toggle.js";
import {
  buildCostTogglePatchScript,
  buildCostToggleStateExpression,
  COST_TOGGLE_STATUS_EXPRESSION,
  COST_TOGGLE_UNINSTALL_EXPRESSION,
  isCostToggleReport,
  parseCostToggleStatus,
} from "./patch-cost-toggle.js";
import type {
  CharaPickerReport,
  CharaPickerState,
  CharaPickerStatus,
} from "./patch-chara-picker.js";
import {
  buildCharaPickerPatchScript,
  buildCharaPickerStateExpression,
  CHARA_PICKER_STATUS_EXPRESSION,
  CHARA_PICKER_UNINSTALL_EXPRESSION,
  isCharaPickerReport,
  parseCharaPickerStatus,
} from "./patch-chara-picker.js";
import type { LobbyStandReport, LobbyStandState, LobbyStandStatus } from "./patch-lobby-stand.js";
import {
  buildLobbyStandPatchScript,
  buildLobbyStandStateExpression,
  isLobbyStandReport,
  LOBBY_STAND_STATUS_EXPRESSION,
  LOBBY_STAND_UNINSTALL_EXPRESSION,
  parseLobbyStandStatus,
} from "./patch-lobby-stand.js";
import type {
  DisplayFullscreenReport,
  DisplaySettingsReport,
  DisplayState,
  DisplayStatus,
  DisplayWindowReport,
} from "./patch-display.js";
import {
  buildDisplayPatchScript,
  buildDisplayStateExpression,
  DISPLAY_STATUS_EXPRESSION,
  DISPLAY_UNINSTALL_EXPRESSION,
  isDisplayFullscreenReport,
  isDisplaySettingsReport,
  isDisplayWindowReport,
  parseDisplayStatus,
} from "./patch-display.js";
import type { BrowserWindowResult, WindowBounds } from "./browser-window.js";
import { planBrowserWindow, sameSize } from "./browser-window.js";
import type { WindowFillResult } from "./window-fill.js";
import { fillGameWindow } from "./window-fill.js";
import type { ShellDisplayStatus } from "./shell-display.js";
import {
  buildShellDisplayScript,
  parseShellDisplayStatus,
  SHELL_DISPLAY_RESET_EXPRESSION,
} from "./shell-display.js";
import type { NavReport, NavStatus } from "./patch-nav.js";
import {
  buildNavPatchScript,
  isNavReport,
  NAV_STATUS_EXPRESSION,
  NAV_UNINSTALL_EXPRESSION,
  parseNavStatus,
} from "./patch-nav.js";
import type { AssetGuardStatus, AssetRepairReport } from "./patch-asset-guard.js";
import {
  ASSET_GUARD_STATUS_EXPRESSION,
  ASSET_GUARD_UNINSTALL_EXPRESSION,
  buildAssetGuardPatchScript,
  isAssetRepairReport,
  parseAssetGuardStatus,
} from "./patch-asset-guard.js";
import type { InputRescueReport, InputRescueStatus } from "./patch-input-rescue.js";
import {
  buildInputRescuePatchScript,
  INPUT_RESCUE_STATUS_EXPRESSION,
  INPUT_RESCUE_UNINSTALL_EXPRESSION,
  isInputRescueReport,
  parseInputRescueStatus,
} from "./patch-input-rescue.js";
import type {
  BonusItemOrder,
  BonusItemPlace,
  ItemPanelPart,
  ItemPanelPatchOptions,
  ItemPanelStatus,
} from "./patch-item-panel.js";
import {
  buildItemPanelPatchScript,
  buildItemPanelSetBonusOrderExpression,
  buildItemPanelSetBonusPlaceExpression,
  buildItemPanelSetPartExpression,
  buildItemPanelSetShortcutExpression,
  ITEM_PANEL_STATUS_EXPRESSION,
  ITEM_PANEL_UNINSTALL_EXPRESSION,
  parseItemPanelStatus,
} from "./patch-item-panel.js";
import type { QuestTreasureStatus } from "./patch-quest-treasure.js";
import type { QuestBonusReport, QuestBonusStats } from "./quest-bonus.js";
import { isQuestBonusReport } from "./quest-bonus.js";
import {
  buildQuestTreasurePatchScript,
  buildQuestTreasureSetBonusExpression,
  buildQuestTreasureSetExpression,
  parseQuestTreasureStatus,
  QUEST_TREASURE_STATUS_EXPRESSION,
  QUEST_TREASURE_UNINSTALL_EXPRESSION,
} from "./patch-quest-treasure.js";
import type { CardArtEntry, CardArtReport, CardArtStatus } from "./patch-card-art.js";
import {
  buildCardArtPatchScript,
  CARD_ART_STATUS_EXPRESSION,
  CARD_ART_UNINSTALL_EXPRESSION,
  isCardArtReport,
  parseCardArtStatus,
} from "./patch-card-art.js";
import type {
  BattleSurrenderOptions,
  RaidSurrenderReport,
  RaidSurrenderStatus,
} from "./patch-raid-surrender.js";
import {
  buildRaidSurrenderPatchScript,
  buildRaidSurrenderSetOptionsExpression,
  DEFAULT_BATTLE_SURRENDER,
  isRaidSurrenderReport,
  parseRaidSurrenderStatus,
  RAID_SURRENDER_STATUS_EXPRESSION,
  RAID_SURRENDER_UNINSTALL_EXPRESSION,
} from "./patch-raid-surrender.js";
import type {
  RaidAutoDeleteReport,
  RaidAutoDeleteSetting,
  RaidAutoDeleteSettingReport,
  RaidBattleReport,
  RaidCodesReport,
  RaidPublicMap,
  RaidRefreshReport,
  RaidSnapshotRow,
  RaidStageReport,
  RaidTeamsMap,
  RaidTrackReport,
  RaidViewStatus,
} from "./patch-raid-view.js";
import {
  parseRaidPublishedSnapshot,
  parseRaidSupportSnapshot,
  RAID_PUBLISHED_SNAPSHOT_EXPRESSION,
  RAID_SUPPORT_SNAPSHOT_EXPRESSION,
  type RaidPublishedRow,
  type RaidSupportRow,
} from "./raid-support.js";
import type {
  RaidRewardMode,
  RaidRewardModeReport,
  RaidItemDeltaReport,
  RaidRewardReport,
  RaidRewardStatus,
} from "./patch-raid-reward.js";
import {
  buildRaidRewardPatchScript,
  buildRaidRewardSetModeExpression,
  isRaidItemDeltaReport,
  isRaidRewardModeReport,
  isRaidRewardReport,
  parseRaidRewardStatus,
  RAID_REWARD_STATUS_EXPRESSION,
  RAID_REWARD_UNINSTALL_EXPRESSION,
} from "./patch-raid-reward.js";
import {
  buildRaidViewPatchScript,
  buildRaidViewSetAutoDeleteExpression,
  buildRaidViewSetPublicExpression,
  buildRaidViewSetTeamsExpression,
  buildRaidViewSetLearnedExpression,
  isRaidAutoDeleteReport,
  isRaidAutoDeleteSettingReport,
  isRaidBattleReport,
  isRaidCodesReport,
  isRaidRefreshReport,
  isRaidStageReport,
  isRaidTrackReport,
  parseRaidViewSnapshot,
  parseRaidViewSnapshotListed,
  parseRaidViewStatus,
  RAID_VIEW_SNAPSHOT_EXPRESSION,
  RAID_VIEW_STATUS_EXPRESSION,
  RAID_VIEW_UNINSTALL_EXPRESSION,
} from "./patch-raid-view.js";
import { isRaidLearnReport } from "./raid-learned.js";
import type { RaidLearnedTable, RaidLearnReport } from "./raid-learned.js";
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
  MatchRoomScriptOptions,
  RoomEntry,
} from "./match-room.js";
import {
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  buildMatchRoomScript,
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
import type { PresentStatus } from "./patch-present.js";
import {
  buildPresentPatchScript,
  parsePresentStatus,
  PRESENT_STATUS_EXPRESSION,
  PRESENT_UNINSTALL_EXPRESSION,
} from "./patch-present.js";
import type { ShopStatus } from "./patch-shop.js";
import {
  buildShopPatchScript,
  parseShopStatus,
  SHOP_STATUS_EXPRESSION,
  SHOP_UNINSTALL_EXPRESSION,
} from "./patch-shop.js";
import type { LotStatus } from "./patch-lot.js";
import {
  buildLotPatchScript,
  LOT_STATUS_EXPRESSION,
  LOT_UNINSTALL_EXPRESSION,
  parseLotStatus,
} from "./patch-lot.js";
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
import type { DeckEditReport, DeckEditState, DeckEditStatus } from "./patch-deck-edit.js";
import {
  buildDeckEditPatchScript,
  buildDeckEditStateExpression,
  DECK_EDIT_STATUS_EXPRESSION,
  DECK_EDIT_UNINSTALL_EXPRESSION,
  isDeckEditReport,
  parseDeckEditStatus,
} from "./patch-deck-edit.js";
import type { RoomGateDecks, RoomGateReport, RoomGateStatus } from "./patch-room-gate.js";
import {
  buildRoomGatePendingExpression,
  buildRoomGateDecksExpression,
  buildRoomGateScript,
  isRoomGateReport,
  parseRoomGateStatus,
  buildRoomGateReleaseExpression,
  ROOM_GATE_STATUS_EXPRESSION,
  ROOM_GATE_UNINSTALL_EXPRESSION,
} from "./patch-room-gate.js";
import type {
  DeckApplyResult,
  DeckSlotWrite,
  DeckSnapshot,
  EditDeckRead,
  InventorySnapshot,
  ServerDeck,
} from "./deck-write.js";
import {
  DECK_READ_EXPRESSION,
  DECK_SOCKET_CLOSE_EXPRESSION,
  EDIT_DECK_READ_EXPRESSION,
  INVENTORY_READ_EXPRESSION,
  buildDeckApplyExpression,
  buildEditDeckWriteExpression,
  parseDeckApplyResult,
  parseDeckSnapshot,
  parseEditDeck,
  parseInventorySnapshot,
} from "./deck-write.js";
import type { GamePageSession } from "./session.js";
import { attachToGamePage, GameFrameAppearedError, isGameFrameTarget } from "./session.js";
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
  /** 對桌面版外殼頁面的 session（要用時才 attach，見 {@link applyShellDisplay}）。 */
  #shellSessionId: string | null = null;
  #reportHandlers = new Set<(report: CostPatchReport) => void>();
  #penaltyHandlers = new Set<(report: PenaltyPatchReport) => void>();
  #wsHandlers = new Set<(report: WsWatchReport) => void>();
  #okHandlers = new Set<(report: OkPatchReport) => void>();
  #speedHandlers = new Set<(report: SpeedPatchReport) => void>();
  #lobbyHandlers = new Set<(report: LobbyReport) => void>();
  #deckEditHandlers = new Set<(report: DeckEditReport) => void>();
  #costToggleHandlers = new Set<(report: CostToggleReport) => void>();
  #charaPickerHandlers = new Set<(report: CharaPickerReport) => void>();
  #lobbyStandHandlers = new Set<(report: LobbyStandReport) => void>();
  #displayHandlers = new Set<(report: DisplaySettingsReport) => void>();
  #displayFullscreenHandlers = new Set<(report: DisplayFullscreenReport) => void>();
  #displayWindowHandlers = new Set<(report: DisplayWindowReport) => void>();
  #navHandlers = new Set<(report: NavReport) => void>();
  #raidSurrenderHandlers = new Set<(report: RaidSurrenderReport) => void>();
  #cardArtHandlers = new Set<(report: CardArtReport) => void>();
  #assetRepairHandlers = new Set<(report: AssetRepairReport) => void>();
  #inputRescueHandlers = new Set<(report: InputRescueReport) => void>();
  #raidRewardHandlers = new Set<(report: RaidRewardReport) => void>();
  #raidItemDeltaHandlers = new Set<(report: RaidItemDeltaReport) => void>();
  #raidCodesHandlers = new Set<(report: RaidCodesReport) => void>();
  #raidBattleHandlers = new Set<(report: RaidBattleReport) => void>();
  #raidRefreshHandlers = new Set<(report: RaidRefreshReport) => void>();
  #raidStageHandlers = new Set<(report: RaidStageReport) => void>();
  #raidTrackHandlers = new Set<(report: RaidTrackReport) => void>();
  #raidLearnHandlers = new Set<(report: RaidLearnReport) => void>();
  #questBonusHandlers = new Set<(report: QuestBonusReport) => void>();
  #raidAutoDeleteHandlers = new Set<(report: RaidAutoDeleteReport) => void>();
  #raidAutoDeleteSettingHandlers = new Set<(report: RaidAutoDeleteSettingReport) => void>();
  #raidRewardModeHandlers = new Set<(report: RaidRewardModeReport) => void>();
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
    this.#shellSessionId = null;

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

    // ⚠ attach 的是遊戲的 out-of-process iframe 時（2026-09-23 起的桌面版），殼
    // 重建 iframe 會讓那個 target 消失，但 WebSocket 還連著 —— transport 的
    // onClose 不會響，插件會安靜地對一個不存在的 session 下命令。把它當斷線。
    client.on("Target.detachedFromTarget", (params) => {
      const sid = (params as { sessionId?: unknown }).sessionId;
      if (sid !== undefined && sid === this.#shellSessionId) {
        this.#shellSessionId = null;
        return;
      }
      if (sid !== session.sessionId) return;
      this.#context = null;
      dispatch(this.#closeHandlers, "遊戲的 iframe target 消失了（detachedFromTarget）");
    });
    client.on("Runtime.executionContextsCleared", (_params, sid) => {
      if (sid === session.sessionId) this.#context = null;
    });
    // 外殼的腳本也用同一個 binding 回報（全螢幕、Esc 退回上一個大小）
    client.on("Runtime.bindingCalled", (params, sid) => {
      if (sid !== session.sessionId && (sid === undefined || sid !== this.#shellSessionId)) return;
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

    // ⚠ 接的是 file:// 外殼、旁邊卻沒有遊戲 iframe：可能是舊客戶端（iframe 跟外殼
    // 同一個程序，外殼裡等得到 Phaser），也可能是桌面版重載的空檔（新 iframe 還沒
    // 生出來，外殼裡永遠等不到）。兩種在這一刻分不出來，所以邊等邊看 target 清單，
    // 遊戲 iframe 一冒出來就丟 `GameFrameAppearedError` 讓呼叫端重挑。
    // `setDiscoverTargets` 會把已經存在的 target 補送一次，所以不會漏掉剛好在
    // attach 之後才出現的那個。
    const watchFrame = session.shellTargetId === null && session.safeUrl.startsWith("file://");
    const abort = new AbortController();
    const offs: (() => void)[] = [];
    if (watchFrame) {
      const check = (params: Record<string, unknown>): void => {
        if (isGameFrameTarget(params["targetInfo"])) abort.abort(new GameFrameAppearedError());
      };
      offs.push(
        client.on("Target.targetCreated", check),
        client.on("Target.targetInfoChanged", check),
      );
      void client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    }
    try {
      const context = await findGameContext(client, tracker, {
        sessionId: session.sessionId,
        timeoutMs: timeoutMs ?? this.#options.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS,
        signal: abort.signal,
      });
      this.#context = context;
      return context;
    } finally {
      for (const off of offs) off();
      if (watchFrame)
        void client.send("Target.setDiscoverTargets", { discover: false }).catch(() => {});
    }
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

  /**
   * 伺服器真的吐了頁面（網址帶 token）才回清單，重建過的外殼、還沒載完的頁面
   * 都回 `null`。理由見 `SERVED_BUNDLES_EXPRESSION`。**永遠不 throw 清單格式錯**
   * —— 讀不到就是讀不到，呼叫端只是這次不回報。
   */
  async readServedBundles(): Promise<GameBundles | null> {
    const raw = await this.evaluate<string>(SERVED_BUNDLES_EXPRESSION);
    if (raw === "null") return null;
    try {
      return parseDiscoveredBundles(raw);
    } catch {
      return null;
    }
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
  async installMatchRoom(options: MatchRoomScriptOptions): Promise<string> {
    return await this.evaluate<string>(buildMatchRoomScript(options));
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
  async roomSnapshot(): Promise<{
    seq: number;
    live: boolean;
    started: boolean;
    rooms: RoomEntry[];
  }> {
    const raw = await this.evaluate<string>("window.__ulrMatch.rooms_snapshot()");
    return JSON.parse(raw) as { seq: number; live: boolean; started: boolean; rooms: RoomEntry[] };
  }

  /**
   * 開一間房。⚠ **會消耗 AP**，而且會出現在公開的房間清單上。
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

  /** 收掉自己開著的那一間房。取消配對時一定要叫，否則清單上會留空房。 */
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
   * 角色與怪物的**中文名**（改版後是 `Characters`；之前 `charaProfile` / `monsProfile`）。
   *
   * 編輯 COST 的介面靠這個活著 —— 玩家看得懂「艾伯李斯特」，看不懂 `cc001_01`。
   */
  async readProfiles(): Promise<CardProfiles> {
    const raw = await this.evaluate<string>(PROFILE_READ_EXPRESSION);
    return parseProfiles(raw);
  }

  /**
   * 讀**伺服器那份**牌組與帳號指紋（WP-18）。
   *
   * 頁面記過伺服器那份就直接用，一趟網路都不跑；這次開遊戲還沒記過才 `db_deck`
   * 一次（走自己開的 lobby 連線）。見 `deck-write.ts` 檔頭。
   */
  async readDecks(): Promise<DeckSnapshot> {
    const raw = await this.evaluate<string>(DECK_READ_EXPRESSION);
    return parseDeckSnapshot(raw);
  }

  /**
   * **把整份牌組寫進伺服器**（`deck_update`），成功後客戶端記憶體就地跟上。
   *
   * ⚠ 這支會改變玩家的帳號狀態，而且原版介面沒有「復原」。呼叫端要先有備份，
   * 並且先驗過庫存（三副共用一個卡池）。
   *
   * ⚠ `answer !== "ok"` 時**不要**把本地狀態當成已寫入。
   */
  async applyDecks(decks: ServerDeck[]): Promise<DeckApplyResult> {
    const raw = await this.evaluate<string>(buildDeckApplyExpression(decks));
    return parseDeckApplyResult(raw);
  }

  /**
   * 讀**玩家眼前那份**（客戶端記憶體）＋頁面記著的伺服器那份。不在有牌組列的
   * 畫面時回 `null`。見 `deck-write.ts` 的 {@link EDIT_DECK_READ_EXPRESSION}。
   */
  async readEditDeck(): Promise<EditDeckRead | null> {
    const raw = await this.evaluate<string>(EDIT_DECK_READ_EXPRESSION);
    return parseEditDeck(raw);
  }

  /**
   * 把幾格牌組畫到玩家**現在看得到的那個畫面**上（牌組編輯畫面，或任務／渦／
   * 對戰房）。⚠ 只動客戶端記憶體，**不碰伺服器**。
   *
   * 回 `ok` / `ok-room` / `not-active` / `empty-room`，意思見
   * {@link buildEditDeckWriteExpression}。
   */
  async writeEditDeck(slots: DeckSlotWrite[], pin: number | null): Promise<string> {
    return await this.evaluate<string>(buildEditDeckWriteExpression(slots, pin));
  }

  /** 讀玩家的卡片庫存。「只用真的有的卡」那條線靠它。 */
  async readInventory(): Promise<InventorySnapshot> {
    const raw = await this.evaluate<string>(INVENTORY_READ_EXPRESSION);
    return parseInventorySnapshot(raw);
  }

  /** 關掉牌組用的那條連線。 */
  async closeDeckSocket(): Promise<string> {
    return await this.evaluate<string>(DECK_SOCKET_CLOSE_EXPRESSION);
  }

  // -------------------------------------------------------------------------
  // 牌組庫的遊戲內介面（WP-18）
  //
  // ⚠ 這一組**只畫畫面、只收點擊**。牌組怎麼存、寫不寫得進去、庫存夠不夠，
  // 全部在呼叫端（`@ulr/deck-library` 與 `applyDecks()`）—— 見
  // `patch-deck-edit.ts` 檔頭的「這支不決定任何牌組內容」。
  // -------------------------------------------------------------------------

  /** 訂閱「玩家在牌組編輯畫面點了什麼」。 */
  onDeckEditReport(handler: (report: DeckEditReport) => void): () => void {
    this.#deckEditHandlers.add(handler);
    return () => this.#deckEditHandlers.delete(handler);
  }

  /**
   * 把牌組庫的介面裝到牌組編輯畫面上。**不需要 reload。**
   *
   * ⚠ 跟大廳那顆按鈕同一種東西：`evaluate` 裝的，**遊戲一重載就沒了**，
   * 重連或重載之後要再裝一次。
   *
   * ⚠ 玩家不在 Edit 畫面時裝也是對的 —— 腳本自己輪詢等他進去（見
   * `patch-deck-edit.ts` 的「Edit 場景每次進來都是重新 create」）。所以回傳
   * `installed` 不代表畫面上已經看得到東西，那要問 `deckEditStatus().mounted`。
   */
  async installDeckEdit(state: DeckEditState): Promise<string> {
    return await this.evaluate<string>(
      buildDeckEditPatchScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
  }

  /** 裝了沒、玩家人是不是就在 Edit 畫面。 */
  async deckEditStatus(): Promise<DeckEditStatus> {
    const raw = await this.evaluate<string>(DECK_EDIT_STATUS_EXPRESSION);
    return parseDeckEditStatus(raw);
  }

  /**
   * 把新狀態推給畫面。**選單上的每一個字都由這支決定。**
   *
   * 回 `not-installed` 表示頁面上根本沒有那支腳本（多半是遊戲重載過），
   * 呼叫端該改叫 `installDeckEdit()`。
   */
  async setDeckEditState(state: DeckEditState): Promise<string> {
    return await this.evaluate<string>(buildDeckEditStateExpression(state));
  }

  async uninstallDeckEdit(): Promise<string> {
    return await this.evaluate<string>(DECK_EDIT_UNINSTALL_EXPRESSION);
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
    options: { enabled?: boolean } = {},
  ): Promise<CostPatchInstallation> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();

    const source = buildCostPatchScript({
      costs,
      bindingName: REPORT_BINDING_NAME,
      enabled: options.enabled ?? true,
    });
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
  async installCostOverridesLive(
    costs: CostOverrides | CostOverrideTables,
    options: { enabled?: boolean } = {},
  ): Promise<void> {
    const source = buildCostPatchScript({
      costs,
      bindingName: REPORT_BINDING_NAME,
      enabled: options.enabled ?? true,
    });
    await this.evaluate<unknown>(source);
  }

  /**
   * 不重載，把畫面上的價格切成自訂表（true）或原價（false）。
   *
   * 靠的是補丁改寫時記下的原價，所以只對「掛鉤真的攔到過」的表有效；
   * `installed: false` 或 `swapped: 0` 都代表這個頁面上沒有東西可切 ——
   * 畫面本來就是原價，要自訂價得先重載（走 `costPatchCoverage()` 那條路）。
   *
   * ⚠ **不動罰則。** 呼叫端要一起切 `installPenaltyOverrides` ／
   * `uninstallPenaltyOverrides`，否則會變成「官方價格配自訂罰則」。
   */
  async setCostOverridesEnabled(enabled: boolean): Promise<CostPatchEnabledResult> {
    const raw = await this.evaluate<string>(buildCostPatchEnabledExpression(enabled));
    return parseCostPatchEnabledResult(raw);
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
    if (session.shellTargetId === null) {
      await client.send("Page.reload", undefined, session.sessionId);
      return;
    }
    // 遊戲在外殼的 out-of-process iframe 裡：Page.reload 只收頂層 target，
    // 對外殼下（它會重新拿 Steam 票證、換新 token）。遊戲 iframe 那個 target
    // 會跟著換掉 → Target.detachedFromTarget → 引擎重連。
    const shell = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId: session.shellTargetId,
      flatten: true,
    });
    if (typeof shell.sessionId !== "string") throw new Error("attach 不到外殼頁面");
    try {
      await client.send("Page.reload", undefined, shell.sessionId);
    } finally {
      await client.send("Target.detachFromTarget", { sessionId: shell.sessionId }).catch(() => {});
    }
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

  // ── 進了哪一房、開戰前先套牌組（WP-19） ──────────────────────────────────

  #roomGateHandlers = new Set<(report: RoomGateReport) => void>();

  /**
   * 訂閱「換房了」與「開戰被攔下來了」。
   *
   * ⚠ 收到 `room-gate-hold` 就**一定要**在幾秒內呼叫 `releaseRoomGate()` ——
   * 那一下開戰正被壓著，而玩家的畫面已經是「已開始」的樣子。頁面自己有看門狗
   * 兜底（8 秒），但那條路會讓玩家用舊牌組開打。
   */
  onRoomGateReport(handler: (report: RoomGateReport) => void): () => void {
    this.#roomGateHandlers.add(handler);
    return () => this.#roomGateHandlers.delete(handler);
  }

  /**
   * 裝上房間偵測與開戰閘門。
   *
   * ⚠ 跟其他 `Runtime.evaluate` 的注入一樣，**遊戲一重載就會被沖掉** ——
   * 重連時要再裝一次。
   */
  async installRoomGate(): Promise<RoomGateStatus> {
    const raw = await this.evaluate<string>(
      buildRoomGateScript({ bindingName: REPORT_BINDING_NAME }),
    );
    return parseRoomGateStatus(raw);
  }

  async roomGateStatus(): Promise<RoomGateStatus> {
    const raw = await this.evaluate<string>(ROOM_GATE_STATUS_EXPRESSION);
    return parseRoomGateStatus(raw);
  }

  /**
   * 告訴頁面「有沒有一副牌還沒寫進 Deck1」。
   *
   * `false` 時閘門完全不作用（開戰的 emit 原樣直通），所以**寫完一定要記得推
   * `false` 回去** —— 忘了的話每一次開戰都會被攔一下，然後靠看門狗放行。
   */
  async setRoomGatePending(pending: boolean): Promise<string> {
    return await this.evaluate<string>(buildRoomGatePendingExpression(pending));
  }

  /**
   * 把模式與「每一房進去要用哪幾格」事先推給頁面，讓房間場景**第一幀就畫對的牌**。
   *
   * 見 `patch-room-gate.ts` 的 {@link RoomDeckPreload} —— 只為了時序，決定權
   * 仍然整個在 Node。
   */
  async setRoomDecks(payload: RoomGateDecks): Promise<string> {
    return await this.evaluate<string>(buildRoomGateDecksExpression(payload));
  }

  /**
   * 放行被攔下來的那一下開戰。
   *
   * `ok` = 伺服器上現在躺的就是這一房該用的那副。`false` 時頁面不會把這一房
   * 記成驗過，下一場開戰會再攔一次 —— 見 `needGate()`。
   */
  async releaseRoomGate(ok: boolean = true): Promise<string> {
    return await this.evaluate<string>(buildRoomGateReleaseExpression(ok));
  }

  async uninstallRoomGate(): Promise<string> {
    return await this.evaluate<string>(ROOM_GATE_UNINSTALL_EXPRESSION);
  }

  /** 把等待人數與配對狀態推到畫面上。**畫面上的每一個字都由這支決定。** */
  async setLobbyState(state: LobbyState): Promise<string> {
    return await this.evaluate<string>(buildLobbyStateExpression(state));
  }

  /**
   * 跳出遊戲自己的錯誤對話框（「這個牌組不符合遊戲規則」）。
   *
   * `code` 是 `MatchUITexts.error` 的鍵（`NOT_ENOUGH_AP` 之類）—— 用代碼而不是字串，
   * 玩家的客戶端是什麼語言就顯示什麼語言。
   */
  async showLobbyError(code: string | null, message?: string): Promise<string> {
    return await this.evaluate<string>(buildLobbyErrorExpression(code, message));
  }

  async uninstallLobbyPatch(): Promise<string> {
    return await this.evaluate<string>(LOBBY_UNINSTALL_EXPRESSION);
  }

  // ── 好友面板的「今日還能送幾張地圖」 ─────────────────────────────────────

  /**
   * 把贈送次數畫到好友面板左上角。
   *
   * ⚠ 這支**不回報任何東西給 Node**，也不需要 Node 推狀態 —— 數字是伺服器
   * 自己送的（`db_quest.pre_remain`），頁面問得到。所以沒有 binding。
   *
   * ⚠ 跟大廳那支一樣走 `Runtime.evaluate`：不必重載遊戲，但**遊戲一重載就會
   * 被沖掉**，重連時要再裝一次。
   *
   * ⚠ 回傳的 `mounted` 常常是 `false`，那**不是失敗**：玩家沒開贈送面板時
   * 面板根本不存在。腳本會自己盯著，開了就掛上。
   */
  async installPresentPatch(): Promise<PresentStatus> {
    const raw = await this.evaluate<string>(buildPresentPatchScript());
    return parsePresentStatus(raw);
  }

  async presentStatus(): Promise<PresentStatus> {
    const raw = await this.evaluate<string>(PRESENT_STATUS_EXPRESSION);
    return parsePresentStatus(raw);
  }

  async uninstallPresentPatch(): Promise<string> {
    return await this.evaluate<string>(PRESENT_UNINSTALL_EXPRESSION);
  }

  // ── 牌組編輯畫面的「自訂 COST ↔ 官方」開關 ────────────────────────────────

  /** 訂閱「玩家點了開關」。`enabled` 是他想要的那一邊；真的切不切是呼叫端的事。 */
  onCostToggle(handler: (report: CostToggleReport) => void): () => void {
    this.#costToggleHandlers.add(handler);
    return () => this.#costToggleHandlers.delete(handler);
  }

  /**
   * 把開關畫到牌組編輯畫面的標題列。
   *
   * 跟其他 `Runtime.evaluate` 裝的東西一樣：不必重載，但**遊戲一重載就沒了**。
   * `mounted: false` 常常是正常的 —— 玩家不在 Edit 畫面、或 `available` 是 false。
   */
  async installCostToggle(state: CostToggleState): Promise<CostToggleStatus> {
    const raw = await this.evaluate<string>(
      buildCostTogglePatchScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
    return parseCostToggleStatus(raw);
  }

  /** 推新狀態。回 `"not-installed"` 就要改叫 `installCostToggle`。 */
  async setCostToggleState(state: CostToggleState): Promise<string> {
    return await this.evaluate<string>(buildCostToggleStateExpression(state));
  }

  async costToggleStatus(): Promise<CostToggleStatus> {
    const raw = await this.evaluate<string>(COST_TOGGLE_STATUS_EXPRESSION);
    return parseCostToggleStatus(raw);
  }

  async uninstallCostToggle(): Promise<string> {
    return await this.evaluate<string>(COST_TOGGLE_UNINSTALL_EXPRESSION);
  }

  // ── 牌組編輯畫面的「人物篩選」與「最愛卡片」 ─────────────────────────────

  /** 訂閱「玩家按了最愛卡片鈕」。存不存、存到哪是呼叫端的事。 */
  onCharaPicker(handler: (report: CharaPickerReport) => void): () => void {
    this.#charaPickerHandlers.add(handler);
    return () => this.#charaPickerHandlers.delete(handler);
  }

  /**
   * 把 [Chara] 鈕、Favorite 鈕與最愛卡片鈕裝到牌組編輯畫面。`Runtime.evaluate` 裝的：
   * 不必重載，但**遊戲一重載就沒了**。
   */
  async installCharaPicker(state: CharaPickerState): Promise<CharaPickerStatus> {
    const raw = await this.evaluate<string>(
      buildCharaPickerPatchScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
    return parseCharaPickerStatus(raw);
  }

  /** 推新狀態。回 `"not-installed"` 就要改叫 `installCharaPicker`。 */
  async setCharaPickerState(state: CharaPickerState): Promise<string> {
    return await this.evaluate<string>(buildCharaPickerStateExpression(state));
  }

  async charaPickerStatus(): Promise<CharaPickerStatus> {
    const raw = await this.evaluate<string>(CHARA_PICKER_STATUS_EXPRESSION);
    return parseCharaPickerStatus(raw);
  }

  async uninstallCharaPicker(): Promise<string> {
    return await this.evaluate<string>(CHARA_PICKER_UNINSTALL_EXPRESSION);
  }

  // ── 首頁立繪（多張、編輯模式）與 Library 愛心複選 ───────────────────────────

  /** 訂閱「玩家改了最愛角色／存了首頁擺法」。存不存、存到哪是呼叫端的事。 */
  onLobbyStand(handler: (report: LobbyStandReport) => void): () => void {
    this.#lobbyStandHandlers.add(handler);
    return () => this.#lobbyStandHandlers.delete(handler);
  }

  /** `Runtime.evaluate` 裝的：不必重載，但**遊戲一重載就沒了**。 */
  async installLobbyStand(state: LobbyStandState): Promise<LobbyStandStatus> {
    const raw = await this.evaluate<string>(
      buildLobbyStandPatchScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
    return parseLobbyStandStatus(raw);
  }

  /** 推新狀態。回 `"not-installed"` 就要改叫 `installLobbyStand`。 */
  async setLobbyStandState(state: LobbyStandState): Promise<string> {
    return await this.evaluate<string>(buildLobbyStandStateExpression(state));
  }

  async lobbyStandStatus(): Promise<LobbyStandStatus> {
    const raw = await this.evaluate<string>(LOBBY_STAND_STATUS_EXPRESSION);
    return parseLobbyStandStatus(raw);
  }

  async uninstallLobbyStand(): Promise<string> {
    return await this.evaluate<string>(LOBBY_STAND_UNINSTALL_EXPRESSION);
  }

  // ── 畫面設定（解析度／畫面大小／全螢幕）＋ Option 的 plugin 分頁 ──────────

  /** 玩家在 Option 的 plugin 分頁改了畫面設定（頁面已經自己套用了，這裡只是要存）。 */
  onDisplaySettings(handler: (report: DisplaySettingsReport) => void): () => void {
    this.#displayHandlers.add(handler);
    return () => this.#displayHandlers.delete(handler);
  }

  /**
   * 繪圖緩衝放大、畫面縮放／全螢幕，並在 Option 加 plugin 分頁。
   * 不必重載，遊戲一重載就沒了。還沒進遊戲也裝得上（腳本等 game 建好）。
   */
  async installDisplayPatch(state: DisplayState): Promise<DisplayStatus> {
    const raw = await this.evaluate<string>(
      buildDisplayPatchScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
    return parseDisplayStatus(raw);
  }

  /** 推新狀態。回 `"not-installed"` 就要改叫 `installDisplayPatch`。 */
  async setDisplayState(state: DisplayState): Promise<string> {
    return await this.evaluate<string>(buildDisplayStateExpression(state));
  }

  async displayStatus(): Promise<DisplayStatus> {
    return parseDisplayStatus(await this.evaluate<string>(DISPLAY_STATUS_EXPRESSION));
  }

  async uninstallDisplayPatch(): Promise<string> {
    return await this.evaluate<string>(DISPLAY_UNINSTALL_EXPRESSION);
  }

  /**
   * 遊戲在外殼的 out-of-process iframe 裡（2026-09-23 起的桌面版）→ 畫面大小與
   * 全螢幕要對外殼下，見 `shell-display.ts`。網頁版（遊戲就是頂層頁面）是 false。
   */
  get hasShell(): boolean {
    return this.#session?.shellTargetId != null;
  }

  /** 照設定調外殼的 zoom 與視窗大小（或進出全螢幕）。沒有外殼回 `null`。 */
  async applyShellDisplay(state: DisplayState): Promise<ShellDisplayStatus | null> {
    const raw = await this.#evaluateInShell(
      buildShellDisplayScript({ bindingName: REPORT_BINDING_NAME, state }),
    );
    return raw === undefined ? null : parseShellDisplayStatus(raw);
  }

  /**
   * 接到的就是 file:// 外殼本身（桌面版重載的空檔，遊戲 iframe 還沒生出來）時，
   * 直接在它身上套畫面大小。不是這種情況回 `null`。
   *
   * ⚠ 重載會把外殼的 zoom 洗掉，視窗卻還是插件調過的大小 —— 遊戲縮在左上角、
   * 外殼在 iframe 底下的官方教學圖整片露出來（玩家 2026-09-25 回報）。等遊戲載完
   * 才套要好幾秒，外殼腳本又不需要遊戲，所以一接上就先套。之後接到 iframe 時
   * `applyShellDisplay` 會再套一次（同版本只 apply，不重裝）。
   */
  async applyDisplayToAttachedShell(state: DisplayState): Promise<ShellDisplayStatus | null> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();
    if (session.shellTargetId !== null || !session.safeUrl.startsWith("file://")) return null;
    const res = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        expression: buildShellDisplayScript({ bindingName: REPORT_BINDING_NAME, state }),
        returnByValue: true,
        userGesture: true,
      },
      session.sessionId,
    );
    return res.exceptionDetails === undefined ? parseShellDisplayStatus(res.result?.value) : null;
  }

  /** 外殼還原成官方的 ×1（插件拆掉時）。沒有外殼或沒裝過都回 `"not-installed"`。 */
  async resetShellDisplay(): Promise<string> {
    const raw = await this.#evaluateInShell(SHELL_DISPLAY_RESET_EXPRESSION);
    return typeof raw === "string" ? raw : "not-installed";
  }

  /**
   * 在外殼頁面執行。第一次用時才 attach，之後沿用（外殼重載時 target 不變，
   * binding 也還在）。
   *
   * ⚠ 帶 `userGesture`：全螢幕要使用者手勢，玩家是在 iframe 裡點的，手勢不會
   * 傳到這條命令上。
   */
  async #evaluateInShell(expression: string): Promise<unknown> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();
    if (session.shellTargetId === null) return undefined;
    if (this.#shellSessionId === null) {
      const attached = await client.send<{ sessionId?: unknown }>("Target.attachToTarget", {
        targetId: session.shellTargetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== "string") throw new Error("attach 不到外殼頁面");
      this.#shellSessionId = attached.sessionId;
      await client.send("Runtime.addBinding", { name: REPORT_BINDING_NAME }, attached.sessionId);
    }
    const res = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.#shellSessionId,
    );
    if (res.exceptionDetails !== undefined) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`注入外殼的程式拋例外：${detail ?? "(沒有細節)"}`);
    }
    return res.result?.value;
  }

  /** 頁面進了／出了 HTML 全螢幕（桌面版進去之後要靠 {@link fillGameWindow} 推滿螢幕）。 */
  onDisplayFullscreen(handler: (report: DisplayFullscreenReport) => void): () => void {
    this.#displayFullscreenHandlers.add(handler);
    return () => this.#displayFullscreenHandlers.delete(handler);
  }

  /** 網頁版要把瀏覽器視窗調成剛好裝下畫面（交給 {@link resizeBrowserWindow}）。 */
  onDisplayWindow(handler: (report: DisplayWindowReport) => void): () => void {
    this.#displayWindowHandlers.add(handler);
    return () => this.#displayWindowHandlers.delete(handler);
  }

  /**
   * 照頁面的回報調整遊戲分頁所在的瀏覽器視窗。理由與算法見 `browser-window.ts`。
   * 全螢幕中不動；最大化／最小化先設回一般再調。
   */
  async resizeBrowserWindow(report: DisplayWindowReport): Promise<BrowserWindowResult> {
    const client = this.#client;
    const session = this.#session;
    if (client === null || session === null) throw new NotConnectedError();
    const win = await client.send<{ windowId?: unknown; bounds?: Partial<WindowBounds> }>(
      "Browser.getWindowForTarget",
      { targetId: session.targetId },
    );
    if (typeof win.windowId !== "number" || win.bounds === undefined) {
      return { ok: false, bounds: null, reason: "查不到遊戲分頁所在的視窗" };
    }
    const windowId = win.windowId;
    let bounds = win.bounds;
    if (bounds.windowState === "fullscreen") {
      return { ok: false, bounds: null, reason: "全螢幕中，不調視窗" };
    }
    if (bounds.windowState === "maximized" || bounds.windowState === "minimized") {
      await client.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      const again = await client.send<{ bounds?: Partial<WindowBounds> }>(
        "Browser.getWindowBounds",
        { windowId },
      );
      if (again.bounds === undefined)
        return { ok: false, bounds: null, reason: "還原視窗後讀不到大小" };
      bounds = again.bounds;
    }
    const { left, top, width, height } = bounds;
    if (
      typeof left !== "number" ||
      typeof top !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number"
    ) {
      return { ok: false, bounds: null, reason: "視窗大小讀不懂" };
    }
    const current = { left, top, width, height };
    const next = planBrowserWindow(current, report);
    if (sameSize(current, next)) return { ok: true, bounds: current, reason: null };
    await client.send("Browser.setWindowBounds", { windowId, bounds: next });
    return { ok: true, bounds: next, reason: null };
  }

  /** 客戶端主程序的 pid（`SystemInfo.getProcessInfo`，browser 層級）。 */
  async browserProcessId(): Promise<number | null> {
    const client = this.#client;
    if (client === null) throw new NotConnectedError();
    const raw = await client.send<{ processInfo?: { type?: unknown; id?: unknown }[] }>(
      "SystemInfo.getProcessInfo",
    );
    const browser = raw.processInfo?.find((p) => p.type === "browser");
    return typeof browser?.id === "number" ? browser.id : null;
  }

  /**
   * 把桌面版的視窗推成整個螢幕。**頁面要先進 HTML 全螢幕**，理由見
   * `window-fill.ts` 檔頭。
   */
  async fillGameWindow(): Promise<WindowFillResult> {
    const pid = await this.browserProcessId();
    if (pid === null) return { ok: false, rect: null, reason: "查不到客戶端的 pid" };
    return await fillGameWindow(pid);
  }

  // ── 商店的購買數量檔位 ───────────────────────────────────────────────────

  /**
   * 把商店確認框的數量下拉（1..20）換成檔位表（1 2 3 5 7 … 500）。
   *
   * ⚠ 跟贈送次數那支一樣走 `Runtime.evaluate`、不回報、不需要 Node 推狀態：
   * 上限是頁面自己算的（照抄官方公式），點選也是交給官方 handler。
   * **遊戲一重載就會被沖掉**，重連時要再裝一次。
   *
   * ⚠ `active` 幾乎一定是 `false`（玩家沒開確認框時沒有東西可換），那
   * **不是失敗**。腳本會自己盯著。
   */
  async installShopPatch(): Promise<ShopStatus> {
    const raw = await this.evaluate<string>(buildShopPatchScript());
    return parseShopStatus(raw);
  }

  async shopStatus(): Promise<ShopStatus> {
    const raw = await this.evaluate<string>(SHOP_STATUS_EXPRESSION);
    return parseShopStatus(raw);
  }

  async uninstallShopPatch(): Promise<string> {
    return await this.evaluate<string>(SHOP_UNINSTALL_EXPRESSION);
  }

  // ── 暗房（抽卡）預覽：已有的調暗、事件卡標持有數 ────────────────────

  /**
   * 暗房預覽的補丁。跟商店那支一樣走 `Runtime.evaluate`、不回報：持有數是
   * 頁面自己從 registry 與官方抽卡回應算的，勾選狀態存在頁面 localStorage。
   * **遊戲一重載就會被沖掉**，重連時要再裝一次。
   *
   * ⚠ `mounted: false` 只代表玩家不在暗房，**不是失敗**。腳本會自己盯著。
   */
  async installLotPatch(): Promise<LotStatus> {
    const raw = await this.evaluate<string>(buildLotPatchScript());
    return parseLotStatus(raw);
  }

  async lotStatus(): Promise<LotStatus> {
    const raw = await this.evaluate<string>(LOT_STATUS_EXPRESSION);
    return parseLotStatus(raw);
  }

  async uninstallLotPatch(): Promise<string> {
    return await this.evaluate<string>(LOT_UNINSTALL_EXPRESSION);
  }

  // ── 返回鈕左邊的直連捷徑列（DUEL／RAID／QUEST／DECK） ─────────────────

  /** 訂閱「玩家點了捷徑」。成功失敗都會來一則，`ok: false` 時看 `reason`。 */
  onNav(handler: (report: NavReport) => void): () => void {
    this.#navHandlers.add(handler);
    return () => this.#navHandlers.delete(handler);
  }

  /**
   * 把大廳那四顆鈕縮小放到每個房間的返回鈕左邊，點一下直接跳房間。
   *
   * 跟其他 `Runtime.evaluate` 裝的東西一樣：不必重載，但**遊戲一重載就沒了**。
   * 貼圖是腳本自己非同步抓的，所以剛裝完 `ready` 幾乎一定是 `false`，
   * `mounted` 也常是 `null`（玩家在大廳或戰鬥裡）—— 都不是失敗。
   */
  async installNavPatch(): Promise<NavStatus> {
    const raw = await this.evaluate<string>(
      buildNavPatchScript({ bindingName: REPORT_BINDING_NAME }),
    );
    return parseNavStatus(raw);
  }

  async navStatus(): Promise<NavStatus> {
    const raw = await this.evaluate<string>(NAV_STATUS_EXPRESSION);
    return parseNavStatus(raw);
  }

  async uninstallNavPatch(): Promise<string> {
    return await this.evaluate<string>(NAV_UNINSTALL_EXPRESSION);
  }

  // ── 渦戰裡的投降鈕 ──────────────────────────────────────────────────────

  /** 訂閱「玩家在渦戰按了投降」。成功失敗都會來一則，`ok: false` 時看 `reason`。 */
  onRaidSurrender(handler: (report: RaidSurrenderReport) => void): () => void {
    this.#raidSurrenderHandlers.add(handler);
    return () => this.#raidSurrenderHandlers.delete(handler);
  }

  /**
   * 把渦戰裡官方藏起來的白旗顯示出來，按下去不開確認面板、直接回渦房。
   *
   * 跟其他 `Runtime.evaluate` 裝的東西一樣：不必重載，但**遊戲一重載就沒了**。
   * `mounted` 幾乎一定是 `false`（玩家不在渦戰裡），那不是失敗 —— 腳本自己
   * 輪詢等玩家開打。
   */
  async installRaidSurrenderPatch(
    surrender: BattleSurrenderOptions = DEFAULT_BATTLE_SURRENDER,
  ): Promise<RaidSurrenderStatus> {
    const raw = await this.evaluate<string>(
      buildRaidSurrenderPatchScript({ bindingName: REPORT_BINDING_NAME, surrender }),
    );
    return parseRaidSurrenderStatus(raw);
  }

  /** 換投降的兩個開關（迪城不確認、鈕放外面）。回 `"ok"` 或 `"not-installed"`。 */
  async setRaidSurrenderOptions(surrender: BattleSurrenderOptions): Promise<string> {
    return await this.evaluate<string>(buildRaidSurrenderSetOptionsExpression(surrender));
  }

  async raidSurrenderStatus(): Promise<RaidSurrenderStatus> {
    const raw = await this.evaluate<string>(RAID_SURRENDER_STATUS_EXPRESSION);
    return parseRaidSurrenderStatus(raw);
  }

  async uninstallRaidSurrenderPatch(): Promise<string> {
    return await this.evaluate<string>(RAID_SURRENDER_UNINSTALL_EXPRESSION);
  }

  // ── 卡面替換（MOD） ─────────────────────────────────────────────────────

  /** 訂閱「這一批卡面全部處理完了」（每張都成功或失敗）。 */
  onCardArt(handler: (report: CardArtReport) => void): () => void {
    this.#cardArtHandlers.add(handler);
    return () => this.#cardArtHandlers.delete(handler);
  }

  /**
   * 把玩家的 PNG 換進卡面圖集（`CharaCardImages`）。先拆再裝，所以拿新的清單再叫一次就是
   * 「重新載入」。圖片解碼是非同步的，剛裝完 `applied` 多半是 0、`pending`
   * 是張數 —— 結果看 status 或 `onCardArt`。
   *
   * 跟其他 `Runtime.evaluate` 裝的東西一樣：不必重載，但**遊戲一重載就沒了**。
   */
  async installCardArtPatch(entries: readonly CardArtEntry[]): Promise<CardArtStatus> {
    const raw = await this.evaluate<string>(
      buildCardArtPatchScript({ bindingName: REPORT_BINDING_NAME, entries }),
    );
    return parseCardArtStatus(raw);
  }

  async cardArtStatus(): Promise<CardArtStatus> {
    const raw = await this.evaluate<string>(CARD_ART_STATUS_EXPRESSION);
    return parseCardArtStatus(raw);
  }

  async uninstallCardArtPatch(): Promise<string> {
    return await this.evaluate<string>(CARD_ART_UNINSTALL_EXPRESSION);
  }

  // ── 開機資料檔的防護 ────────────────────────────────────────────────────

  /** 訂閱「補抓了一支開機資料檔」（或重試到放棄）。 */
  onAssetRepair(handler: (report: AssetRepairReport) => void): () => void {
    this.#assetRepairHandlers.add(handler);
    return () => this.#assetRepairHandlers.delete(handler);
  }

  /**
   * 盯著遊戲開機載的 JSON：CDN 回錯沒進快取的就自己補抓、重新餵給靜態表。
   * 全部都在就自己停。遊戲一重載就沒了，每次接上都要裝。
   */
  async installAssetGuard(): Promise<AssetGuardStatus> {
    const raw = await this.evaluate<string>(
      buildAssetGuardPatchScript({ bindingName: REPORT_BINDING_NAME }),
    );
    return parseAssetGuardStatus(raw);
  }

  async assetGuardStatus(): Promise<AssetGuardStatus> {
    const raw = await this.evaluate<string>(ASSET_GUARD_STATUS_EXPRESSION);
    return parseAssetGuardStatus(raw);
  }

  async uninstallAssetGuard(): Promise<string> {
    return await this.evaluate<string>(ASSET_GUARD_UNINSTALL_EXPRESSION);
  }

  // ── 伺服器沒回、官方鎖住畫面的解鎖 ────────────────────────────────────────

  /** 訂閱「官方某個請求逾時、鎖住的畫面被我們解開了」。 */
  onInputRescue(handler: (report: InputRescueReport) => void): () => void {
    this.#inputRescueHandlers.add(handler);
    return () => this.#inputRescueHandlers.delete(handler);
  }

  /**
   * 盯著官方請求的逾時：逾時後還關著點擊的場景就打開（戰鬥中不動）。
   * 遊戲一重載就沒了，每次接上都要裝。
   */
  async installInputRescue(): Promise<InputRescueStatus> {
    const raw = await this.evaluate<string>(
      buildInputRescuePatchScript({ bindingName: REPORT_BINDING_NAME }),
    );
    return parseInputRescueStatus(raw);
  }

  async inputRescueStatus(): Promise<InputRescueStatus> {
    const raw = await this.evaluate<string>(INPUT_RESCUE_STATUS_EXPRESSION);
    return parseInputRescueStatus(raw);
  }

  async uninstallInputRescue(): Promise<string> {
    return await this.evaluate<string>(INPUT_RESCUE_UNINSTALL_EXPRESSION);
  }

  // ── 物品欄：點得到外面、渦房／任務房排序、兩房的物品捷徑 ─────────────────

  /**
   * 包物品欄面板類別（開窗不再擋整個畫面、渦房／任務房的排序、搜索框蓋在物品欄上）
   * ＋渦房與任務房的物品捷徑。腳本自己輪詢等面板類別載進來、等玩家進房。
   * 遊戲一重載就沒了，每次接上都要裝。
   */
  async installItemPanelPatch(options: ItemPanelPatchOptions): Promise<ItemPanelStatus> {
    const raw = await this.evaluate<string>(buildItemPanelPatchScript(options));
    return parseItemPanelStatus(raw);
  }

  async itemPanelStatus(): Promise<ItemPanelStatus> {
    return parseItemPanelStatus(await this.evaluate<string>(ITEM_PANEL_STATUS_EXPRESSION));
  }

  /** 開關渦房的物品捷徑。回 `"ok"` 或 `"not-installed"`。 */
  async setItemShortcut(on: boolean): Promise<string> {
    return await this.evaluate<string>(buildItemPanelSetShortcutExpression(on));
  }

  /**
   * 開關任務房（水沙／通行證）、迪城（水／GEM UP）或獎勵遊戲的其中一塊。
   * 回 `"ok"` 或 `"not-installed"`。
   */
  async setItemPanelPart(part: ItemPanelPart, on: boolean): Promise<string> {
    return await this.evaluate<string>(buildItemPanelSetPartExpression(part, on));
  }

  /** 換獎勵遊戲差距大時先用哪一種道具。回 `"ok"` 或 `"not-installed"`。 */
  async setBonusItemOrder(order: BonusItemOrder): Promise<string> {
    return await this.evaluate<string>(buildItemPanelSetBonusOrderExpression(order));
  }

  /** 換獎勵遊戲的捷徑畫在哪（上方／蓋在使用物品上）。回 `"ok"` 或 `"not-installed"`。 */
  async setBonusItemPlace(place: BonusItemPlace): Promise<string> {
    return await this.evaluate<string>(buildItemPanelSetBonusPlaceExpression(place));
  }

  async uninstallItemPanelPatch(): Promise<string> {
    return await this.evaluate<string>(ITEM_PANEL_UNINSTALL_EXPRESSION);
  }

  // ── 任務地圖的寶箱標註 ──────────────────────────────────────────────────

  /**
   * 任務地圖每格旁邊畫寶箱的實際內容；順便學 HighLow 格的開始星數（`onQuestBonus`）。
   * 腳本自己輪詢等玩家開任務地圖；不送請求。
   */
  async installQuestTreasurePatch(
    enabled: boolean,
    bonusStats: QuestBonusStats = {},
  ): Promise<QuestTreasureStatus> {
    const raw = await this.evaluate<string>(
      buildQuestTreasurePatchScript({ enabled, bindingName: REPORT_BINDING_NAME, bonusStats }),
    );
    return parseQuestTreasureStatus(raw);
  }

  /** 推學到的開始星數下去。回 `"ok"` 或 `"not-installed"`。 */
  async setQuestBonusStats(stats: QuestBonusStats): Promise<string> {
    return await this.evaluate<string>(buildQuestTreasureSetBonusExpression(stats));
  }

  /** 進了一次任務 HighLow 格的獎勵遊戲（學開始星數的原料）。 */
  onQuestBonus(handler: (report: QuestBonusReport) => void): () => void {
    this.#questBonusHandlers.add(handler);
    return () => this.#questBonusHandlers.delete(handler);
  }

  async questTreasureStatus(): Promise<QuestTreasureStatus> {
    return parseQuestTreasureStatus(await this.evaluate<string>(QUEST_TREASURE_STATUS_EXPRESSION));
  }

  /** 開關標註。回 `"ok"` 或 `"not-installed"`。 */
  async setQuestTreasure(on: boolean): Promise<string> {
    return await this.evaluate<string>(buildQuestTreasureSetExpression(on));
  }

  async uninstallQuestTreasurePatch(): Promise<string> {
    return await this.evaluate<string>(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  }

  // ── 渦房的獎勵標記 ──────────────────────────────────────────────────────

  /**
   * 渦房清單／地圖／詳細面板／SUPPORT 清單上的碎片色與獎勵標記。
   *
   * 跟其他 `Runtime.evaluate` 裝的東西一樣：不必重載，遊戲一重載就沒了。
   * `inRaid: false` 不是失敗 —— 腳本自己輪詢等玩家進渦房。
   */
  async installRaidViewPatch(
    publicMap?: RaidPublicMap,
    autoDelete?: RaidAutoDeleteSetting,
    teams?: RaidTeamsMap,
    learned?: RaidLearnedTable,
  ): Promise<RaidViewStatus> {
    const raw = await this.evaluate<string>(
      buildRaidViewPatchScript({
        bindingName: REPORT_BINDING_NAME,
        ...(publicMap === undefined ? {} : { publicMap }),
        ...(autoDelete === undefined ? {} : { autoDelete }),
        ...(teams === undefined ? {} : { teams }),
        ...(learned === undefined ? {} : { learned }),
      }),
    );
    return parseRaidViewStatus(raw);
  }

  /** 推「渦碼 → 名字 → 隊伍」表下去。回 `"ok"` 或 `"not-installed"`。 */
  async setRaidViewTeams(teams: RaidTeamsMap): Promise<string> {
    return await this.evaluate<string>(buildRaidViewSetTeamsExpression(teams));
  }

  /** 推學到的渦獎勵表下去。回 `"ok"` 或 `"not-installed"`。 */
  async setRaidViewLearned(table: RaidLearnedTable): Promise<string> {
    return await this.evaluate<string>(buildRaidViewSetLearnedExpression(table));
  }

  /** 收到一次渦結算、對得回清單上的渦（學獎勵表的原料）。 */
  onRaidLearn(handler: (report: RaidLearnReport) => void): () => void {
    this.#raidLearnHandlers.add(handler);
    return () => this.#raidLearnHandlers.delete(handler);
  }

  /** 玩家按了渦房的更新鈕（⑩）。 */
  onRaidRefresh(handler: (report: RaidRefreshReport) => void): () => void {
    this.#raidRefreshHandlers.add(handler);
    return () => this.#raidRefreshHandlers.delete(handler);
  }

  /** 頁面記下了某個渦新的 stage（發現畫面或開打）。 */
  onRaidStage(handler: (report: RaidStageReport) => void): () => void {
    this.#raidStageHandlers.add(handler);
    return () => this.#raidStageHandlers.delete(handler);
  }

  /** 官方重讀了一份道具清單（變多的列出來）。對結算有沒有真的入帳用。 */
  onRaidItemDelta(handler: (report: RaidItemDeltaReport) => void): () => void {
    this.#raidItemDeltaHandlers.add(handler);
    return () => this.#raidItemDeltaHandlers.delete(handler);
  }

  /** 一個渦從清單上結束了（或結束後結算才到）。查「獎勵被吞」用。 */
  onRaidTrack(handler: (report: RaidTrackReport) => void): () => void {
    this.#raidTrackHandlers.add(handler);
    return () => this.#raidTrackHandlers.delete(handler);
  }

  /** 打完一場渦、量到了傷害（⑨）。 */
  onRaidBattle(handler: (report: RaidBattleReport) => void): () => void {
    this.#raidBattleHandlers.add(handler);
    return () => this.#raidBattleHandlers.delete(handler);
  }

  async raidViewStatus(): Promise<RaidViewStatus> {
    const raw = await this.evaluate<string>(RAID_VIEW_STATUS_EXPRESSION);
    return parseRaidViewStatus(raw);
  }

  /** 把「渦碼 → TL／狀態」的公開渦表推下去。回 `"ok"` 或 `"not-installed"`。 */
  async setRaidViewPublic(map: RaidPublicMap): Promise<string> {
    return await this.evaluate<string>(buildRaidViewSetPublicExpression(map));
  }

  /** 自動刪了一個死渦。 */
  onRaidAutoDelete(handler: (report: RaidAutoDeleteReport) => void): () => void {
    this.#raidAutoDeleteHandlers.add(handler);
    return () => this.#raidAutoDeleteHandlers.delete(handler);
  }

  /** 玩家在遊戲裡的死渦面板上切了自動刪除。 */
  onRaidAutoDeleteSetting(handler: (report: RaidAutoDeleteSettingReport) => void): () => void {
    this.#raidAutoDeleteSettingHandlers.add(handler);
    return () => this.#raidAutoDeleteSettingHandlers.delete(handler);
  }

  async setRaidAutoDelete(setting: RaidAutoDeleteSetting): Promise<string> {
    return await this.evaluate<string>(buildRaidViewSetAutoDeleteExpression(setting));
  }

  /** SUPPORT 清單畫出來了：那一批公開渦的渦碼。 */
  onRaidCodes(handler: (report: RaidCodesReport) => void): () => void {
    this.#raidCodesHandlers.add(handler);
    return () => this.#raidCodesHandlers.delete(handler);
  }

  /** 自己渦清單上的渦（插件互傳要上傳的）。人不在渦房是空陣列。 */
  /** 同 {@link raidViewSnapshot}，外加頁面手上有沒有清單（沒有時空清單不代表渦都不見了）。 */
  async raidViewSnapshotListed(): Promise<{ rows: RaidSnapshotRow[]; listed: boolean }> {
    return parseRaidViewSnapshotListed(await this.evaluate<string>(RAID_VIEW_SNAPSHOT_EXPRESSION));
  }

  async raidViewSnapshot(): Promise<RaidSnapshotRow[]> {
    return parseRaidViewSnapshot(await this.evaluate<string>(RAID_VIEW_SNAPSHOT_EXPRESSION));
  }

  /** SUPPORT 公開清單（玩家最後一次打開 SUPPORT 時拿到的，沒有渦碼）。不送請求。見 raid-support.ts。 */
  async raidSupportSnapshot(): Promise<RaidSupportRow[]> {
    return parseRaidSupportSnapshot(await this.evaluate<string>(RAID_SUPPORT_SNAPSHOT_EXPRESSION));
  }

  /** 自己按「送出」公開的渦（只有參加資格「無限制」的）。不送請求。見 raid-support.ts。 */
  async raidPublishedSnapshot(): Promise<RaidPublishedRow[]> {
    return parseRaidPublishedSnapshot(
      await this.evaluate<string>(RAID_PUBLISHED_SNAPSHOT_EXPRESSION),
    );
  }

  async uninstallRaidViewPatch(): Promise<string> {
    return await this.evaluate<string>(RAID_VIEW_UNINSTALL_EXPRESSION);
  }

  // ── 渦擊破結算的 OK 面板 ────────────────────────────────────────────────

  /** 伺服器推了渦的結算（不管哪個模式都會來）。 */
  onRaidReward(handler: (report: RaidRewardReport) => void): () => void {
    this.#raidRewardHandlers.add(handler);
    return () => this.#raidRewardHandlers.delete(handler);
  }

  /** 玩家在摘要面板上切了模式。 */
  onRaidRewardMode(handler: (report: RaidRewardModeReport) => void): () => void {
    this.#raidRewardModeHandlers.add(handler);
    return () => this.#raidRewardModeHandlers.delete(handler);
  }

  /**
   * 把渦擊破結算的 OK 面板換成三段式（全部／只一次／不再）。
   * 包的是 `Raid.prototype.raid_reward`，不必等場景建好。
   */
  async installRaidRewardPatch(mode: RaidRewardMode): Promise<RaidRewardStatus> {
    const raw = await this.evaluate<string>(
      buildRaidRewardPatchScript({ bindingName: REPORT_BINDING_NAME, mode }),
    );
    return parseRaidRewardStatus(raw);
  }

  async raidRewardStatus(): Promise<RaidRewardStatus> {
    const raw = await this.evaluate<string>(RAID_REWARD_STATUS_EXPRESSION);
    return parseRaidRewardStatus(raw);
  }

  async setRaidRewardMode(mode: RaidRewardMode): Promise<string> {
    return await this.evaluate<string>(buildRaidRewardSetModeExpression(mode));
  }

  async uninstallRaidRewardPatch(): Promise<string> {
    return await this.evaluate<string>(RAID_REWARD_UNINSTALL_EXPRESSION);
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
    this.#shellSessionId = null;
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
      return;
    }
    if (isDeckEditReport(parsed)) {
      dispatch(this.#deckEditHandlers, parsed);
      return;
    }
    if (isCostToggleReport(parsed)) {
      dispatch(this.#costToggleHandlers, parsed);
      return;
    }
    if (isCharaPickerReport(parsed)) {
      dispatch(this.#charaPickerHandlers, parsed);
      return;
    }
    if (isLobbyStandReport(parsed)) {
      dispatch(this.#lobbyStandHandlers, parsed);
      return;
    }
    if (isDisplaySettingsReport(parsed)) {
      dispatch(this.#displayHandlers, parsed);
      return;
    }
    if (isDisplayFullscreenReport(parsed)) {
      dispatch(this.#displayFullscreenHandlers, parsed);
      return;
    }
    if (isDisplayWindowReport(parsed)) {
      dispatch(this.#displayWindowHandlers, parsed);
      return;
    }
    if (isNavReport(parsed)) {
      dispatch(this.#navHandlers, parsed);
      return;
    }
    if (isRaidAutoDeleteReport(parsed)) {
      dispatch(this.#raidAutoDeleteHandlers, parsed);
      return;
    }
    if (isRaidAutoDeleteSettingReport(parsed)) {
      dispatch(this.#raidAutoDeleteSettingHandlers, parsed);
      return;
    }
    if (isRaidCodesReport(parsed)) {
      dispatch(this.#raidCodesHandlers, parsed);
      return;
    }
    if (isRaidBattleReport(parsed)) {
      dispatch(this.#raidBattleHandlers, parsed);
      return;
    }
    if (isRaidRefreshReport(parsed)) {
      dispatch(this.#raidRefreshHandlers, parsed);
      return;
    }
    if (isRaidStageReport(parsed)) {
      dispatch(this.#raidStageHandlers, parsed);
      return;
    }
    if (isRaidTrackReport(parsed)) {
      dispatch(this.#raidTrackHandlers, parsed);
      return;
    }
    if (isRaidLearnReport(parsed)) {
      dispatch(this.#raidLearnHandlers, parsed);
      return;
    }
    if (isQuestBonusReport(parsed)) {
      dispatch(this.#questBonusHandlers, parsed);
      return;
    }
    if (isRaidRewardReport(parsed)) {
      dispatch(this.#raidRewardHandlers, parsed);
      return;
    }
    if (isRaidItemDeltaReport(parsed)) {
      dispatch(this.#raidItemDeltaHandlers, parsed);
      return;
    }
    if (isRaidRewardModeReport(parsed)) {
      dispatch(this.#raidRewardModeHandlers, parsed);
      return;
    }
    if (isRaidSurrenderReport(parsed)) {
      dispatch(this.#raidSurrenderHandlers, parsed);
      return;
    }
    if (isCardArtReport(parsed)) {
      dispatch(this.#cardArtHandlers, parsed);
      return;
    }
    if (isAssetRepairReport(parsed)) {
      dispatch(this.#assetRepairHandlers, parsed);
      return;
    }
    if (isInputRescueReport(parsed)) {
      dispatch(this.#inputRescueHandlers, parsed);
      return;
    }
    if (isRoomGateReport(parsed)) {
      dispatch(this.#roomGateHandlers, parsed);
    }
  }
}

export function createCdpAdapter(options: CdpAdapterOptions = {}): CdpAdapter {
  return new CdpAdapter(options);
}
