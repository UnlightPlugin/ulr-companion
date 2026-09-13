/**
 * @ulr/cdp-adapter — WP-07
 * ==========================
 * 透過 CDP 連上遊戲、注入畫面、收頁面回報。
 *
 * 狀態：
 *   ✅ 連線、attach 分頁、取得遊戲 iframe 的 execution context
 *   ✅ 注入自訂 COST（移植自 `unlight_crawler` 的 patch_cost.js）
 *   ⬜ 監聽 WebSocket 事件（`WSClient.onAny`）—— 下一步
 *   ⬜ 攔截 `I_am_ok` 做誤按反悔窗口 —— 要先有上面那個
 *
 * 典型用法：
 *
 * ```ts
 * const adapter = createCdpAdapter({ port: DEFAULT_DEBUG_PORT });
 * adapter.onCostPatchReport((r) => console.log(r));
 * await adapter.connect();
 * const { takesEffectOnNextLoad } = await adapter.installCostOverrides({
 *   cc078_04: 19,
 *   cc078_r04: 21,
 * });
 * // takesEffectOnNextLoad 永遠是 true —— 問過玩家再 adapter.reloadGame()
 * ```
 *
 * 安全邊界（規格書 §12，細節見 CONTRIBUTING）：
 *   - CDP 只允許 127.0.0.1，`transport.ts` 會強制檢查
 *   - 不得記錄 Steam Token、Cookie、完整 CDP URL、原始封包 → 用 `redact.ts`
 *   - 收到隱藏資訊（例如對手手牌）也不得顯示或上傳
 *   - 遠端規則只能是資料，永遠不會被當程式碼執行 → 見 `patch-cost.ts`
 */

export * from "./constants.js";
export * from "./protocol.js";
export * from "./redact.js";

export { CdpClient, DEFAULT_COMMAND_TIMEOUT_MS } from "./client.js";
export type { CdpClientOptions } from "./client.js";

export {
  assertLoopback,
  DebuggerNotFoundError,
  discoverDebuggerUrl,
  NonLoopbackTargetError,
  WebSocketTransport,
} from "./transport.js";

export {
  attachToGamePage,
  GamePageNotFoundError,
  selectGamePage,
  toPageTargets,
} from "./session.js";
export type { GamePageSession, PageTarget } from "./session.js";

export {
  DEFAULT_CONTEXT_TIMEOUT_MS,
  ExecutionContextTracker,
  findGameContext,
} from "./game-context.js";
export type { FindGameContextOptions, GameExecutionContext } from "./game-context.js";

export {
  buildCostPatchCoverageExpression,
  buildCostPatchEnabledExpression,
  buildCostPatchScript,
  COST_TABLE_IDS,
  COST_TABLE_TARGETS,
  costsStamp,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  EDIT_SCENE_CLONES,
  InvalidCostOverrideError,
  isCostPatchReport,
  normalizeCostTables,
  parseCostPatchEnabledResult,
} from "./patch-cost.js";
export type {
  CostOverrides,
  CostOverrideTables,
  CostPatchApplied,
  CostPatchEnabledResult,
  CostPatchError,
  CostPatchInstalled,
  CostPatchOptions,
  CostPatchReport,
  CostTableId,
} from "./patch-cost.js";

export {
  buildCostTogglePatchScript,
  buildCostToggleStateExpression,
  COST_TOGGLE_SCRIPT_VERSION,
  COST_TOGGLE_STATUS_EXPRESSION,
  COST_TOGGLE_UNINSTALL_EXPRESSION,
  DEFAULT_COST_TOGGLE_POLL_MS,
  isCostToggleReport,
  parseCostToggleStatus,
} from "./patch-cost-toggle.js";
export type {
  CostTogglePatchOptions,
  CostToggleReport,
  CostToggleState,
  CostToggleStatus,
} from "./patch-cost-toggle.js";

export {
  buildDisplayPatchScript,
  buildDisplayStateExpression,
  DEFAULT_DISPLAY_POLL_MS,
  DEFAULT_DISPLAY_STATE,
  DISPLAY_SCRIPT_VERSION,
  DISPLAY_STATUS_EXPRESSION,
  DISPLAY_UNINSTALL_EXPRESSION,
  isDisplayFullscreenReport,
  isDisplaySettingsReport,
  isDisplayWindowReport,
  isRenderMode,
  isSizeMode,
  MAX_RENDER_SCALE,
  parseDisplayStatus,
  RENDER_MODES,
  MAX_SIZE_ZOOM,
  MIN_SIZE_ZOOM,
  SIZE_PRESETS,
} from "./patch-display.js";
export { fillGameWindow, parseWindowFillOutput } from "./window-fill.js";
export type { WindowFillResult } from "./window-fill.js";
export { planBrowserWindow, sameSize } from "./browser-window.js";
export type { BrowserWindowResult, WindowBounds } from "./browser-window.js";
export type {
  DisplayFullscreenReport,
  DisplayPatchOptions,
  DisplaySettingsReport,
  DisplayWindowReport,
  DisplayState,
  DisplayStatus,
  RenderMode,
  SizeMode,
} from "./patch-display.js";

export {
  buildPenaltyPatchScript,
  DEFAULT_PENALTY_MAX_WAIT_MS,
  DEFAULT_PENALTY_POLL_MS,
  InvalidPenaltyBandError,
  isPenaltyPatchReport,
  PENALTY_UNINSTALL_EXPRESSION,
} from "./patch-penalty.js";
export type {
  PenaltyBand,
  PenaltyPatchApplied,
  PenaltyPatchError,
  PenaltyPatchOptions,
  PenaltyPatchReport,
} from "./patch-penalty.js";

export {
  buildHiddenStageScript,
  DEFAULT_STAGE_MAX_WAIT_MS,
  DEFAULT_STAGE_POLL_MS,
  HIDDEN_STAGE_SCRIPT_VERSION,
  HIDDEN_STAGE_STATUS_EXPRESSION,
  HIDDEN_STAGE_UNINSTALL_EXPRESSION,
  InvalidHiddenStageError,
  parseHiddenStageStatus,
} from "./patch-stage.js";
export type { HiddenStage, HiddenStagePatchOptions, HiddenStageStatus } from "./patch-stage.js";

export {
  buildLobbyErrorExpression,
  buildLobbyPatchScript,
  buildLobbyStateExpression,
  DEFAULT_LOBBY_POLL_MS,
  isLobbyReport,
  LOBBY_SCRIPT_VERSION,
  LOBBY_STATUS_EXPRESSION,
  LOBBY_UNINSTALL_EXPRESSION,
  parseLobbyStatus,
  ROOM_ERROR_AP_SHORT,
  ROOM_ERROR_DECK_INVALID,
} from "./patch-lobby.js";
export type {
  LobbyPatchOptions,
  LobbyQuickPressed,
  LobbyReport,
  LobbyState,
  LobbyStatus,
  LobbyTierCount,
} from "./patch-lobby.js";

export {
  buildPresentPatchScript,
  DEFAULT_PRESENT_MAX,
  DEFAULT_PRESENT_POLL_MS,
  parsePresentStatus,
  PRESENT_SCRIPT_VERSION,
  PRESENT_STATUS_EXPRESSION,
  PRESENT_UNINSTALL_EXPRESSION,
} from "./patch-present.js";
export type { PresentPatchOptions, PresentStatus } from "./patch-present.js";

export {
  buildShopPatchScript,
  DEFAULT_SHOP_POLL_MS,
  OFFICIAL_QUANTITY_CAP,
  parseShopStatus,
  QUANTITY_TIERS,
  SHOP_SCRIPT_VERSION,
  SHOP_STATUS_EXPRESSION,
  SHOP_UNINSTALL_EXPRESSION,
} from "./patch-shop.js";
export type { ShopPatchOptions, ShopStatus } from "./patch-shop.js";

export {
  buildNavPatchScript,
  DEFAULT_NAV_ARM_TIMEOUT_MS,
  DEFAULT_NAV_POLL_MS,
  DEFAULT_NAV_PORT_TIMEOUT_MS,
  isNavReport,
  NAV_BACK_EVENT,
  NAV_HOST_SCENES,
  NAV_PERSISTENT_SCENES,
  NAV_SCRIPT_VERSION,
  NAV_STATUS_EXPRESSION,
  NAV_TARGET_SCENE,
  NAV_TARGETS,
  NAV_UNINSTALL_EXPRESSION,
  parseNavStatus,
} from "./patch-nav.js";
export type { NavPatchOptions, NavReport, NavStatus, NavTarget } from "./patch-nav.js";

export {
  ASSET_GUARD_SCRIPT_VERSION,
  ASSET_GUARD_STATUS_EXPRESSION,
  ASSET_GUARD_UNINSTALL_EXPRESSION,
  buildAssetGuardPatchScript,
  DEFAULT_ASSET_GUARD_MAX_ATTEMPTS,
  DEFAULT_ASSET_GUARD_POLL_MS,
  GAME_DATA_FILES,
  isAssetRepairReport,
  parseAssetGuardStatus,
} from "./patch-asset-guard.js";
export type {
  AssetGuardPatchOptions,
  AssetGuardStatus,
  AssetRepairReport,
} from "./patch-asset-guard.js";

export {
  buildRaidSurrenderPatchScript,
  DEFAULT_RAID_SURRENDER_POLL_MS,
  DEFAULT_RAID_SURRENDER_PORT_TIMEOUT_MS,
  isRaidSurrenderReport,
  parseRaidSurrenderStatus,
  RAID_SURRENDER_RULE,
  RAID_SURRENDER_SCRIPT_VERSION,
  RAID_SURRENDER_STATUS_EXPRESSION,
  RAID_SURRENDER_UNINSTALL_EXPRESSION,
} from "./patch-raid-surrender.js";
export type {
  RaidSurrenderPatchOptions,
  RaidSurrenderReport,
  RaidSurrenderStatus,
} from "./patch-raid-surrender.js";

export {
  classifyRaid,
  describeRaidClass,
  FRAGMENT_BY_CODE,
  FRAGMENT_BY_ITEM,
  FRAGMENT_BY_KEY,
  fragmentByFormula,
  fragmentOfEntry,
  isFairyMons,
  lookupRaidTreasure,
  RAID_BOOKMARK_ITEM,
  RAID_FAIRY_MONS,
  RAID_FRAGMENTS,
  RAID_MATERIAL_ITEMS,
  RAID_OWN_FRAME_TINT,
  RAID_SPECIAL_TINT,
  RAID_TICKET_PREFIX,
  RAID_TREASURE_TABLE,
  raidTierOf,
  specialOfEntry,
  ticketOfEntry,
} from "./raid-treasure.js";
export type {
  RaidClass,
  RaidClassifyInput,
  RaidFragment,
  RaidFragmentInfo,
  RaidRewardItem,
  RaidTier,
  RaidTreasureEntry,
} from "./raid-treasure.js";

export {
  parseRaidStatusCode,
  RAID_STATUS_BY_CODE,
  RAID_STATUS_COLORS,
  RAID_STATUSES,
} from "./raid-status.js";
export type { RaidStatusInfo, RaidStatusKind, RaidStatusLabel } from "./raid-status.js";

export {
  buildRaidViewPatchScript,
  buildRaidViewSetAutoDeleteExpression,
  buildRaidViewSetPublicExpression,
  buildRaidViewSetTeamsExpression,
  isRaidBattleReport,
  isRaidRefreshReport,
  RAID_BATTLE_PENDING_MAX_MS,
  RAID_BATTLE_TAIL_MS,
  RAID_VIEW_MANUAL_REFRESH_COOLDOWN_MS,
  DEFAULT_RAID_AUTO_DELETE,
  DEFAULT_RAID_VIEW_POLL_MS,
  DEFAULT_RAID_VIEW_REFRESH_MS,
  isRaidAutoDeleteReport,
  isRaidAutoDeleteSettingReport,
  isRaidCodesReport,
  parseRaidViewSnapshot,
  parseRaidViewStatus,
  RAID_VIEW_SNAPSHOT_EXPRESSION,
  RAID_ICON_SOURCES,
  RAID_MATERIAL_WEAPON_INDEX,
  RAID_TIER4_FRAME_TINT,
  RAID_VIEW_LABELS,
  RAID_VIEW_SCRIPT_VERSION,
  RAID_VIEW_STATUS_EXPRESSION,
  RAID_VIEW_UNINSTALL_EXPRESSION,
} from "./patch-raid-view.js";
export type {
  RaidAutoDeleteReport,
  RaidAutoDeleteSetting,
  RaidAutoDeleteSettingReport,
  RaidBattleReport,
  RaidCodesReport,
  RaidDeckContent,
  RaidPublicInfo,
  RaidPublicMap,
  RaidRefreshReport,
  RaidSnapshotRow,
  RaidStateRef,
  RaidTeamsMap,
  RaidTeamView,
  RaidViewPatchOptions,
  RaidViewStatus,
} from "./patch-raid-view.js";

export {
  buildRaidRewardPatchScript,
  buildRaidRewardSetModeExpression,
  DEFAULT_RAID_REWARD_MODE,
  isRaidRewardMode,
  isRaidRewardModeReport,
  isRaidRewardReport,
  parseRaidRewardStatus,
  RAID_REWARD_LABELS,
  RAID_REWARD_MODES,
  RAID_REWARD_SCRIPT_VERSION,
  RAID_REWARD_STATUS_EXPRESSION,
  RAID_REWARD_UNINSTALL_EXPRESSION,
} from "./patch-raid-reward.js";
export type {
  RaidRewardEntry,
  RaidRewardMode,
  RaidRewardModeReport,
  RaidRewardPatchOptions,
  RaidRewardReport,
  RaidRewardStatus,
} from "./patch-raid-reward.js";

export { JUMP_PERSISTENT_SCENES, SCENE_JUMP_SNIPPET } from "./scene-jump.js";

export {
  ARCADIA_STAGES,
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  canAffordDuel,
  CHANNEL_NAMES,
  COST_RANGES,
  costTiersFor,
  DEFAULT_ROOM_NAME,
  duelApCost,
  findOwnRoom,
  HIDDEN_STAGES,
  isStageCode,
  ROOM_NAME_MAX_LENGTH,
  SELECTABLE_STAGES,
  STAGE_CODES,
  STAGES,
  MATCH_ROOM_INSTALL_EXPRESSION,
  MATCH_ROOM_UNINSTALL_EXPRESSION,
} from "./match-room.js";
export type {
  ChannelInfo,
  CreateRoomOptions,
  CreateRoomResult,
  DuelAffordability,
  JoinRoomResult,
  MatchContext,
  RoomDeck,
  RoomEntry,
  StageCode,
} from "./match-room.js";

export {
  cardAssetReadExpression,
  CC_ASSET_READ_EXPRESSION,
  CcAssetReadError,
  COST_PATCH_STATE_EXPRESSION,
  EVENT_CARD_READ_EXPRESSION,
  indexedCardReadExpression,
  MC_ASSET_READ_EXPRESSION,
  parseCharacterAssets,
  parseCostPatchState,
  parseIndexedCards,
  parseProfiles,
  PROFILE_READ_EXPRESSION,
  toCostTable,
  WEAPON_READ_EXPRESSION,
} from "./read-card-assets.js";
export type {
  CardProfiles,
  CharacterAsset,
  CharacterAssetTable,
  CostPatchState,
  IndexedCardAsset,
  IndexedCardTable,
} from "./read-card-assets.js";

export {
  BUNDLE_DISCOVERY_EXPRESSION,
  SERVED_BUNDLES_EXPRESSION,
  buildBookmarklet,
  buildBookmarkUrl,
  buildBootShellScript,
  AUTH_DATASET_KEY,
  buildExtensionContentScript,
  buildExtensionFiles,
  buildExtensionReadme,
  BUNDLES_DATASET_KEY,
  InvalidBundleError,
  isCompleteBundleSet,
  parseDiscoveredBundles,
  STORAGE_KEY,
} from "./boot-shell.js";
export type {
  BootShellOptions,
  BundlesSource,
  ExtensionOptions,
  GameBundles,
} from "./boot-shell.js";

export { detectGameInstall } from "./game-install.js";
export type { ClientMode, GameInstall } from "./game-install.js";

export {
  desktopUserDataDir,
  DEVTOOLS_ACTIVE_PORT_FILE,
  explainDebugPort,
  probePortState,
  readDevToolsActivePort,
  resolveDebugPort,
} from "./debug-port.js";
export type {
  DebugPortSource,
  PortState,
  ResolvedDebugPort,
  ResolveDebugPortOptions,
} from "./debug-port.js";

export {
  browserDebugPort,
  BrowserNotFoundError,
  BrowserPortTimeoutError,
  browserProfileDir,
  buildBrowserArgs,
  DEFAULT_BROWSER_POLL_MS,
  DEFAULT_BROWSER_PROFILE_DIR,
  DEFAULT_BROWSER_READY_TIMEOUT_MS,
  EDGE_BROWSER_PROFILE_DIR,
  ensureBrowser,
  findBrowser,
  isDebugPortLive,
} from "./browser.js";
export type {
  BrowserArgsOptions,
  BrowserFamily,
  FoundBrowser,
  LaunchBrowserOptions,
  LaunchBrowserResult,
} from "./browser.js";

export {
  BundlesNotFoundError,
  DEFAULT_LAUNCH_POLL_MS,
  DesktopClientActiveError,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  discoverBundlesAcrossPages,
  launchGameViaSteam,
  openGameTab,
  refreshBundles,
  SteamLaunchUnsupportedError,
} from "./boot.js";
export type {
  DiscoverBundlesResult,
  OpenGameTabOptions,
  OpenGameTabResult,
  RefreshBundlesOptions,
} from "./boot.js";

export {
  buildWsWatchScript,
  DEFAULT_MAX_KEYS,
  DEFAULT_RESCAN_INTERVAL_MS,
  DEFAULT_VALUE_EVENTS,
  isWsWatchReport,
  VALUE_MAX_DEPTH,
  VALUE_MAX_STRING_LENGTH,
} from "./ws-events.js";
export type {
  WsDirection,
  WsEventReport,
  WsWatchError,
  WsWatchInstalled,
  WsWatchOptions,
  WsWatchReport,
} from "./ws-events.js";

export {
  ArbiterRunner,
  commandsFor,
  DEFAULT_TICK_INTERVAL_MS,
  translate,
} from "./arbiter-runner.js";
export type { PageBridge, PageCommand, RunnerOptions } from "./arbiter-runner.js";

export {
  buildOkPatchScript,
  DEFAULT_FAILSAFE_MS,
  DEFAULT_LOCAL_DEADLINE_SECONDS,
  DEFAULT_STALE_MS,
  isOkPatchReport,
  normalizeTint,
  OK_PATCH_GLOBAL,
  OK_PATCH_UNINSTALL_EXPRESSION,
  READY_TINT_AMBER,
} from "./patch-ok.js";
export type {
  ForceEndResult,
  OkIntercepted,
  OkPressedAgain,
  OkPatchError,
  OkPatchEvent,
  OkPatchInstalled,
  OkPatchOptions,
  OkDegraded,
  OkPatchRearmed,
  OkPatchReport,
  OkPatchTick,
  OkReleased,
} from "./patch-ok.js";

export {
  buildSpeedPatchScript,
  DEFAULT_SPEED_FACTOR,
  DEFAULT_SPEED_LEASE_MS,
  isSpeedPatchReport,
  MAX_SPEED_FACTOR,
  SPEED_PATCH_GLOBAL,
  SPEED_PATCH_RENEW_EXPRESSION,
  SPEED_PATCH_UNINSTALL_EXPRESSION,
} from "./patch-speed.js";
export type { SpeedPatchOptions, SpeedPatchReport } from "./patch-speed.js";

export {
  capThreshold,
  DEFAULT_PHASE_TOTAL_SECONDS,
  initialState,
  isOperation,
  resetAfterSend,
  resetForNextPhase,
  resetForNextTurn,
  step,
} from "./arbitration.js";
export type {
  ArbiterAction,
  ArbiterConfig,
  ArbiterInput,
  ArbiterState,
  CancelPolicy,
  CardId,
  SendReason,
  StepResult,
} from "./arbitration.js";

export {
  buildDeckEditPatchScript,
  buildDeckEditStateExpression,
  DECK_EDIT_SCRIPT_VERSION,
  DECK_EDIT_STATUS_EXPRESSION,
  DECK_EDIT_UNINSTALL_EXPRESSION,
  DEFAULT_DECK_EDIT_POLL_MS,
  isDeckEditReport,
  parseDeckEditStatus,
} from "./patch-deck-edit.js";
export type {
  DeckEditContent,
  DeckEditItem,
  DeckEditPatchOptions,
  DeckEditReport,
  DeckEditState,
  DeckEditStatus,
} from "./patch-deck-edit.js";

export {
  buildRoomGateDecksExpression,
  buildRoomGatePendingExpression,
  buildRoomGateScript,
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_ROOM_GATE_POLL_MS,
  GATED_EVENTS,
  isRoomGateReport,
  parseRoomGateStatus,
  ROOM_GATE_RELEASE_EXPRESSION,
  ROOM_GATE_SCRIPT_VERSION,
  ROOM_GATE_STATUS_EXPRESSION,
  ROOM_GATE_UNINSTALL_EXPRESSION,
} from "./patch-room-gate.js";
export type {
  GateRoom,
  RoomChangedReport,
  RoomDeckPreload,
  RoomGateHoldReport,
  RoomGateOptions,
  RoomGateReport,
  RoomGateStatus,
  RoomGateTimeoutReport,
} from "./patch-room-gate.js";

export {
  buildDeckApplyExpression,
  buildEditDeckWriteExpression,
  DECK_READ_EXPRESSION,
  DECK_SYNC_SALT,
  DECK_SOCKET_CLOSE_EXPRESSION,
  EDIT_DECK_READ_EXPRESSION,
  INVENTORY_READ_EXPRESSION,
  parseDeckApplyResult,
  parseEditDeck,
  parseDeckSnapshot,
  parseInventorySnapshot,
} from "./deck-write.js";
export type {
  DeckApplyResult,
  DeckPayload,
  DeckSnapshot,
  EditDeckRead,
  FlatDeck,
  InventorySnapshot,
} from "./deck-write.js";

export { CdpAdapter, createCdpAdapter, NotConnectedError, REPORT_BINDING_NAME } from "./adapter.js";
export type { CdpAdapterOptions, CostPatchInstallation } from "./adapter.js";
