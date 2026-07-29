/**
 * 找出遊戲真正跑在哪個 execution context
 * =========================================
 * 遊戲被包在 iframe 裡，`window.game` / `window.Phaser` **不在頂層 page 的
 * context**。`Runtime.evaluate` 不指定 `contextId` 會打到頂層，結果是
 * 「指令都成功、什麼都沒發生」—— 這是這一塊最容易浪費時間的坑。
 *
 * ⚠ 有一個競態必須處理：`Runtime.enable` 會把**已經存在**的 context 以
 * `Runtime.executionContextCreated` 事件補送一次。所以訂閱一定要在
 * `Runtime.enable` **之前**掛好，否則遊戲早就載完的情況下會一個都收不到，
 * 然後永遠等在那裡。`unlight_crawler` 的 app.py 是先 enable 再往後聽，
 * 剛啟動時可以動，接上已經在跑的遊戲就會卡住。
 *
 * 選擇條件用「這個 context 裡有沒有 Phaser」直接驗證，而不是猜 frame 的
 * 順序或網址。猜錯的症狀是「注入成功但畫面沒反應」，驗證只要一次 evaluate。
 */

import type { CdpClient } from "./client.js";
import { CdpTimeoutError } from "./protocol.js";
import { redactUrl } from "./redact.js";

export interface GameExecutionContext {
  contextId: number;
  frameId: string;
  /** 已去識別化。遊戲的 URL 帶 steamid 與 token。 */
  safeOrigin: string;
  /** 探測當下 `window.game` 是否已經建立。false 代表還在載入。 */
  gameReady: boolean;
}

interface TrackedContext {
  contextId: number;
  frameId: string;
  origin: string;
  isDefault: boolean;
}

/** 預設等多久。冷啟動時 Electron 開視窗到 Phaser 就緒實測要數秒。 */
export const DEFAULT_CONTEXT_TIMEOUT_MS = 30_000;

/** 兩次探測之間的間隔。太密只是白花 CDP 往返。 */
const PROBE_INTERVAL_MS = 250;

/**
 * 訂閱 execution context 的生滅。
 *
 * **必須在 `Runtime.enable` 之前建立**，理由見檔頭。
 */
export class ExecutionContextTracker {
  #contexts = new Map<number, TrackedContext>();
  #offs: (() => void)[] = [];
  #changed: (() => void)[] = [];

  constructor(client: CdpClient, sessionId?: string) {
    const sameSession = (incoming?: string): boolean =>
      sessionId === undefined || incoming === sessionId;

    this.#offs.push(
      client.on("Runtime.executionContextCreated", (params, incoming) => {
        if (!sameSession(incoming)) return;
        const ctx = parseContext(params["context"]);
        if (ctx === null) return;
        this.#contexts.set(ctx.contextId, ctx);
        this.#notify();
      }),
      client.on("Runtime.executionContextDestroyed", (params, incoming) => {
        if (!sameSession(incoming)) return;
        const id = params["executionContextId"];
        if (typeof id === "number") this.#contexts.delete(id);
      }),
      client.on("Runtime.executionContextsCleared", (_params, incoming) => {
        // 導航了。舊的 contextId 全部作廢，繼續用會拿到
        // "Cannot find context with specified id"。
        if (!sameSession(incoming)) return;
        this.#contexts.clear();
      }),
    );
  }

  get contexts(): TrackedContext[] {
    return [...this.#contexts.values()];
  }

  /** 等到有新的 context 出現，或超時。用來避免忙碌輪詢。 */
  waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      const listener = (): void => {
        clearTimeout(timer);
        finish();
      };
      this.#changed.push(listener);
      function finish(): void {
        resolve();
      }
    });
  }

  dispose(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#changed = [];
    this.#contexts.clear();
  }

  #notify(): void {
    const listeners = this.#changed;
    this.#changed = [];
    for (const l of listeners) l();
  }
}

function parseContext(raw: unknown): TrackedContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const id = obj["id"];
  if (typeof id !== "number") return null;

  const auxData = (obj["auxData"] ?? {}) as Record<string, unknown>;
  return {
    contextId: id,
    frameId: typeof auxData["frameId"] === "string" ? auxData["frameId"] : "",
    origin: typeof obj["origin"] === "string" ? obj["origin"] : "",
    // isDefault 為 false 的是擴充功能／isolated world，遊戲不在那裡。
    isDefault: auxData["isDefault"] !== false,
  };
}

/** 頂層 frame 的 id。拿不到就回 null —— 它只用來排序候選，不是必要條件。 */
async function getTopFrameId(client: CdpClient, sessionId?: string): Promise<string | null> {
  try {
    const res = await client.send<{ frameTree?: { frame?: { id?: unknown } } }>(
      "Page.getFrameTree",
      undefined,
      sessionId,
    );
    const id = res.frameTree?.frame?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * 在某個 context 裡問「Phaser 在不在」。
 *
 * 刻意只回傳布林值，不把物件搬回 Node —— 遊戲物件很大，而且裡面就有
 * token 那類東西（§12）。
 */
async function probeForGame(
  client: CdpClient,
  contextId: number,
  sessionId?: string,
): Promise<{ hasPhaser: boolean; hasGame: boolean } | null> {
  try {
    const res = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>(
      "Runtime.evaluate",
      {
        expression:
          '({hasPhaser: typeof window.Phaser !== "undefined", hasGame: typeof window.game !== "undefined"})',
        contextId,
        returnByValue: true,
      },
      sessionId,
    );
    if (res.exceptionDetails !== undefined) return null;
    const value = res.result?.value;
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    return { hasPhaser: v["hasPhaser"] === true, hasGame: v["hasGame"] === true };
  } catch {
    // context 可能在我們問的空檔被銷毀（換場景／導航）。這不是錯誤，
    // 下一輪重新挑就好。
    return null;
  }
}

export interface FindGameContextOptions {
  sessionId?: string;
  timeoutMs?: number;
  /** 測試用：注入假的等待，避免真的睡。 */
  now?: () => number;
}

/**
 * 一路等到「有一個 context 裡看得到 Phaser」為止。
 *
 * 呼叫前必須已經送過 `Runtime.enable`，而 tracker 必須在那之前就建立好。
 * `connect()` 已經按這個順序做完，一般不需要自己組。
 */
export async function findGameContext(
  client: CdpClient,
  tracker: ExecutionContextTracker,
  options: FindGameContextOptions = {},
): Promise<GameExecutionContext> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  const topFrameId = await getTopFrameId(client, options.sessionId);

  for (;;) {
    // 非頂層 frame 優先 —— 桌面版的遊戲一定在 iframe。但頂層也要試，
    // 網頁版就是直接載在頂層。
    const candidates = tracker.contexts
      .filter((c) => c.isDefault)
      .sort((a, b) => rank(a, topFrameId) - rank(b, topFrameId));

    for (const candidate of candidates) {
      const probe = await probeForGame(client, candidate.contextId, options.sessionId);
      if (probe === null || !probe.hasPhaser) continue;
      return {
        contextId: candidate.contextId,
        frameId: candidate.frameId,
        safeOrigin: redactUrl(candidate.origin),
        gameReady: probe.hasGame,
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new CdpTimeoutError(
        `找遊戲的 execution context（試過 ${candidates.length} 個都沒有 Phaser）`,
        timeoutMs,
      );
    }
    await tracker.waitForChange(Math.min(PROBE_INTERVAL_MS, remaining));
  }
}

function rank(ctx: TrackedContext, topFrameId: string | null): number {
  if (topFrameId !== null && ctx.frameId === topFrameId) return 1;
  return 0;
}
