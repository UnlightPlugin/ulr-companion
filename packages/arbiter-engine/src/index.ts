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
export type { EngineOptions, EngineStatus } from "./engine.js";
