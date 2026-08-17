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
  buildCostPatchScript,
  COST_TABLE_IDS,
  COST_TABLE_TARGETS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  InvalidCostOverrideError,
  isCostPatchReport,
  normalizeCostTables,
} from "./patch-cost.js";
export type {
  CostOverrides,
  CostOverrideTables,
  CostPatchApplied,
  CostPatchError,
  CostPatchInstalled,
  CostPatchOptions,
  CostPatchReport,
  CostTableId,
} from "./patch-cost.js";

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
  buildCreateRoomExpression,
  buildJoinRoomExpression,
  CHANNEL_NAMES,
  COST_RANGES,
  costTiersFor,
  DEFAULT_ROOM_NAME,
  findOwnRoom,
  HIDDEN_STAGES,
  STAGES,
  MATCH_ROOM_INSTALL_EXPRESSION,
  MATCH_ROOM_UNINSTALL_EXPRESSION,
} from "./match-room.js";
export type {
  ChannelInfo,
  CreateRoomOptions,
  CreateRoomResult,
  JoinRoomResult,
  MatchContext,
  RoomDeck,
  RoomEntry,
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
  BrowserNotFoundError,
  BrowserPortTimeoutError,
  buildBrowserArgs,
  DEFAULT_BROWSER_POLL_MS,
  DEFAULT_BROWSER_PROFILE_DIR,
  DEFAULT_BROWSER_READY_TIMEOUT_MS,
  ensureBrowser,
  findBrowser,
  isDebugPortLive,
} from "./browser.js";
export type {
  BrowserArgsOptions,
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

export { CdpAdapter, createCdpAdapter, NotConnectedError, REPORT_BINDING_NAME } from "./adapter.js";
export type { CdpAdapterOptions, CostPatchInstallation } from "./adapter.js";
