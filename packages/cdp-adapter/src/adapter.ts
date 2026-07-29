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

import { CdpClient } from "./client.js";
import { DEFAULT_DEBUG_PORT } from "./constants.js";
import type { GameExecutionContext } from "./game-context.js";
import {
  DEFAULT_CONTEXT_TIMEOUT_MS,
  ExecutionContextTracker,
  findGameContext,
} from "./game-context.js";
import type { CostOverrides, CostPatchReport } from "./patch-cost.js";
import { buildCostPatchScript, isCostPatchReport } from "./patch-cost.js";
import type { CdpTransport } from "./protocol.js";
import type { GamePageSession } from "./session.js";
import { attachToGamePage } from "./session.js";
import { discoverDebuggerUrl, WebSocketTransport } from "./transport.js";

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

export class CdpAdapter {
  #options: CdpAdapterOptions;
  #client: CdpClient | null = null;
  #session: GamePageSession | null = null;
  #tracker: ExecutionContextTracker | null = null;
  #context: GameExecutionContext | null = null;
  #reportHandlers = new Set<(report: CostPatchReport) => void>();

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
   * 裝上自訂 COST。
   *
   * 鍵必須是 cc_asset 的 `filename`（`cc078_04` / `cc078_r04`），
   * 理由見 `patch-cost.ts` 的說明與 docs/open-questions.md 第 1 題。
   */
  async installCostOverrides(costs: CostOverrides): Promise<CostPatchInstallation> {
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

  /** 訂閱注入腳本回報的結果。回傳的函式呼叫一次即取消訂閱。 */
  onCostPatchReport(handler: (report: CostPatchReport) => void): () => void {
    this.#reportHandlers.add(handler);
    return () => this.#reportHandlers.delete(handler);
  }

  async disconnect(): Promise<void> {
    this.#tracker?.dispose();
    this.#tracker = null;
    this.#context = null;
    this.#session = null;
    this.#reportHandlers.clear();
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
    if (!isCostPatchReport(parsed)) return;

    for (const handler of [...this.#reportHandlers]) {
      try {
        handler(parsed);
      } catch {
        // §9.1：訂閱者出錯不得讓插件或遊戲崩潰。
      }
    }
  }
}

export function createCdpAdapter(options: CdpAdapterOptions = {}): CdpAdapter {
  return new CdpAdapter(options);
}
