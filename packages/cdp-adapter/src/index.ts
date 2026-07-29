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
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  InvalidCostOverrideError,
  isCostPatchReport,
} from "./patch-cost.js";
export type {
  CostOverrides,
  CostPatchApplied,
  CostPatchError,
  CostPatchInstalled,
  CostPatchOptions,
  CostPatchReport,
} from "./patch-cost.js";

export { CdpAdapter, createCdpAdapter, NotConnectedError, REPORT_BINDING_NAME } from "./adapter.js";
export type { CdpAdapterOptions, CostPatchInstallation } from "./adapter.js";
