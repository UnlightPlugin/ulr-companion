/**
 * 把「這一版遊戲的程式檔名」回報到雲端
 * ====================================
 *
 * 用書籤／ULR Boot 擴充開網頁版的玩家，要知道這週官方 bundle 叫什麼名字才開得
 * 起遊戲。那串名字**只出現在伺服器真的吐出來的頁面上**（網址帶 token 的那一次，
 * 也就是從 Steam 開的遊戲）。托盤本來就接著那種客戶端，所以順手讀一下、跟雲端
 * 那份不一樣就送上去：
 *
 * ```
 *   讀頁面（只收帶 token 的真頁面）─ null → 什麼都不做
 *     │ 這份已經處理過 → 什麼都不做（不打網路）
 *     ▼
 *   GET  /bundles ─ 一樣 → 記住，之後不再問
 *     ▼
 *   POST /report  → current / promoted / retired：記住，不再送
 *                   pending / busy：一小時後再送
 *                   rejected：六小時後再送
 * ```
 *
 * Worker 那邊自己驗（檔案存在、不准退回舊版、不同來源夠多才升級），所以這裡
 * 不需要金鑰 —— 公開發布的程式也放不住金鑰。
 *
 * ## 請求量
 *
 * 平常是**零**：同一份清單處理過一次就記住（直到托盤重開）。只有官方改版後、
 * 雲端還沒升級的那段時間，每小時一個 GET＋一個 POST。**不對官方伺服器送任何
 * 東西** —— 檔名是從玩家已經載好的頁面讀的。
 *
 * ## 送出去的東西
 *
 * 只有 `{"bundles": ["client/runtime.<hash>.js", …]}`。不含 steamid、token、帳號。
 * （維護者的電腦另外帶推送金鑰當 Authorization，見 `token`。）
 */

/** 維護者的推送金鑰。一般玩家的電腦上沒有這個檔。 */
export function readPushToken(path: string, read: (p: string) => string): string | null {
  try {
    const t = read(path).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** 預設的中繼站（跟 ULR Boot 擴充讀的是同一台）。 */
export const DEFAULT_BUNDLE_RELAY = "https://ulr-hash.lldavuull.workers.dev";

/** 多久看一次頁面。讀頁面是本機 CDP，不打網路。 */
export const BUNDLE_REPORT_INTERVAL_MS = 5 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const RETRY_AFTER: Record<string, number> = {
  pending: HOUR,
  busy: HOUR,
  rejected: 6 * HOUR,
  error: 15 * 60 * 1000,
};
const DEFAULT_TIMEOUT_MS = 8000;

export type BundleReportOutcome =
  /** 讀不到頁面（沒接上、還沒載完）。 */
  | "no-page"
  /** 頁面不是伺服器吐的（書籤、重建過的外殼）。 */
  | "not-served"
  /** 這份處理過了，這次不打網路。 */
  | "skip"
  | "current"
  | "promoted"
  | "pending"
  | "retired"
  | "rejected"
  | "busy"
  | "error";

export interface BundleReporterOptions {
  fetch: FetchLike;
  /** 回伺服器真的吐出來的檔名；不是真頁面回 `null`。會 throw 也沒關係。 */
  read: () => Promise<readonly string[] | null>;
  relay?: string;
  /**
   * 維護者的推送金鑰（`~/.ulr-push-token`，只有他的電腦上有）。帶著回報 Worker
   * 算兩份 —— 門檻 2 時等於直接升級，但照樣要過「檔案存在」「不准退回舊版」。
   * 一般玩家是 `null`。
   */
  token?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface BundleReporter {
  tick(): Promise<BundleReportOutcome>;
}

export function createBundleReporter(options: BundleReporterOptions): BundleReporter {
  const relay = (options.relay ?? DEFAULT_BUNDLE_RELAY).replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  /** 清單鍵 → 在這個時間點之前不要再處理。 */
  const until = new Map<string, number>();
  /** 同一份清單同一種結果只記一行，避免每小時洗版。 */
  const said = new Set<string>();
  let running = false;

  const say = (key: string, outcome: string, line: string): void => {
    const k = `${key}|${outcome}`;
    if (said.has(k)) return;
    said.add(k);
    log(line);
  };

  async function call(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: unknown }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await options.fetch(`${relay}${path}`, { ...init, signal: ctl.signal });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function once(): Promise<BundleReportOutcome> {
    let bundles: readonly string[] | null;
    try {
      bundles = await options.read();
    } catch {
      return "no-page";
    }
    if (bundles === null) return "not-served";
    if (bundles.length === 0) return "no-page";

    const key = bundles.join(",");
    if ((until.get(key) ?? 0) > now()) return "skip";

    try {
      const got = await call("/bundles", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const cloud = (got.body as { bundles?: unknown } | null)?.bundles;
      if (got.status === 200 && Array.isArray(cloud) && cloud.join(",") === key) {
        until.set(key, Number.POSITIVE_INFINITY);
        return "current";
      }

      const token = options.token ?? null;
      const sent = await call("/report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(token !== null && token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ bundles }),
      });
      const status = (sent.body as { status?: unknown } | null)?.status;
      const outcome: BundleReportOutcome =
        status === "current" ||
        status === "promoted" ||
        status === "pending" ||
        status === "retired" ||
        status === "rejected" ||
        status === "busy"
          ? status
          : "error";

      const wait = RETRY_AFTER[outcome];
      until.set(key, wait === undefined ? Number.POSITIVE_INFINITY : now() + wait);

      const main = bundles.find((b) => b.startsWith("client/runtime.")) ?? bundles[0];
      if (outcome === "promoted") say(key, outcome, `✓ 已把這一版遊戲的檔名更新到雲端（${main}）`);
      else if (outcome === "pending")
        say(key, outcome, `· 已回報這一版遊戲的檔名，等其他玩家確認（${main}）`);
      else if (outcome === "rejected")
        say(key, outcome, `✗ 雲端不收這份遊戲檔名：${JSON.stringify(sent.body)}`);
      else if (outcome === "error") say(key, outcome, `✗ 回報遊戲檔名失敗：HTTP ${sent.status}`);
      return outcome;
    } catch (err) {
      until.set(key, now() + (RETRY_AFTER["error"] ?? HOUR));
      say(key, "error", `✗ 回報遊戲檔名失敗：${err instanceof Error ? err.message : String(err)}`);
      return "error";
    }
  }

  return {
    async tick() {
      // 上一拍還在等網路就不要疊第二拍
      if (running) return "skip";
      running = true;
      try {
        return await once();
      } finally {
        running = false;
      }
    },
  };
}
