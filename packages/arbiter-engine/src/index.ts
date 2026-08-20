/**
 * @ulr/arbiter-engine — 把四個零件接成一個「開著它去玩」的物件
 * =============================================================
 * `ArbiterEngine` 是命令列與托盤**共用的同一份**執行核心。UI 只做兩件事：
 * 畫 `EngineStatus`、呼叫 `setPrefs()`。
 *
 * 生命週期的六個細節全部在 `engine.ts` 的檔頭 —— 動它之前先讀那段。
 */

export {
  ArbiterEngine,
  CONNECT_RETRY_MS,
  DEFAULT_DEADLINE_SECONDS,
  SPEED_RENEW_MS,
} from "./engine.js";
export type { CostPhase, CostState, EngineOptions, EngineStatus } from "./engine.js";

export {
  buildRoomName,
  checkOwnDeck,
  COST_BAND_WIDTH,
  costBand,
  crossEvaluate,
  DEFAULT_STAGE_PICK,
  encodeDeckBody,
  encodeEvalBody,
  encodePrefBody,
  formatBand,
  formatCostTag,
  HANDOFF_POLL_MS,
  HANDOFF_TIMEOUT_MS,
  LOBBY_WATCH_MS,
  MatchPairing,
  negotiateStage,
  normalizeStagePick,
  OPEN_TIER_WINDOW,
  outOfBand,
  parseDeckBody,
  parseEvalBody,
  parsePrefBody,
  PEER_REPLY_TIMEOUT_MS,
  pickArcadiaStage,
  RANDOM_STAGE,
  ROOM_MULTI,
  ROOM_NAME_FALLBACK,
  STAGE_WAIT_MS,
  teamCostCenti,
  tierForTotal,
} from "./match-pairing.js";
export type {
  CostBand,
  CostTierPick,
  LimitCheck,
  PairingOptions,
  PairingPhase,
  PairingStatus,
  StagePick,
} from "./match-pairing.js";

export { channelsAgree, guestJoinRoom, hostOpenRoom, preflight } from "./match-session.js";
export type {
  GuestOptions,
  GuestResult,
  HostOptions,
  HostResult,
  MatchDriver,
  PreflightBlock,
  PreflightOptions,
  PreflightResult,
  Sleep,
} from "./match-session.js";
