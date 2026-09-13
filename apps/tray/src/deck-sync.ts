/**
 * 雲端牌組庫：拉、合併、推
 * ========================
 * 玩家 2026-09-13：「使用的牌組要存到雲端，不同電腦登入同個角色時，要同步。用角色 ID。」
 *
 * ```
 *   GET  /decks/<key>  ──▶ 雲端那份（或 404 = 還沒有）
 *        mergeLibraries(本地, 雲端)          ← @ulr/deck-library/merge.ts，純函式
 *   PUT  /decks/<key>  If-Match: 雲端版本  ──▶ 200 新版本
 *                                          └─▶ 409 別台先寫了 → 拿它回的那份重新合併、再推
 * ```
 *
 * 這支**不碰 Electron、不碰檔案**，fetch 由呼叫端給 —— 測試拿
 * `decideDeckSync()` 當假雲端，整條路（含 409 重試）跑得到。
 *
 * ## ⚠ 失敗一律安靜退回本機
 *
 * 雲端掛了、斷網、Worker 還沒部署：牌組庫照常用本機那份，這一輪什麼都不改。
 * **絕不**因為拿不到雲端就把本地當成「雲端是空的」去合併 —— 那只會多推一次，
 * 還不致命；但反過來把一個讀壞的雲端回應當成真相合併進來，就是吃掉牌組。
 * 所以只有 200（讀得懂的文件）與 404 會進合併，其他狀態一律 `error`。
 */

import {
  type DeckLibrary,
  type SyncDocument,
  mergeLibraries,
  parseSyncDocument,
} from "@ulr/deck-library";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface DeckSyncOptions {
  /** `https://…/decks`，不含鍵。 */
  baseUrl: string;
  /** 64 hex，見 `DeckSnapshot.syncKey`。 */
  key: string;
  fetch: FetchLike;
  /** 單次請求逾時。 */
  timeoutMs?: number;
  /** 409 之後最多重來幾次。 */
  maxAttempts?: number;
}

export type DeckSyncResult =
  | {
      ok: true;
      /** 合併後的本地庫。`localChanged` 是 false 時跟傳進來的是同一份內容。 */
      library: DeckLibrary;
      localChanged: boolean;
      /** 這一輪有推上去。 */
      pushed: boolean;
      /** 雲端現在的版本。 */
      version: number;
      /** 拉下來／刪掉了幾副，給記錄用。 */
      pulled: number;
      deleted: number;
    }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 8000;

async function call(
  opts: DeckSyncOptions,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown } | { error: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await opts.fetch(`${opts.baseUrl}/${opts.key}`, { ...init, signal: ctl.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 雲端回的 `{version, doc}` → 版本與文件。讀不懂回 `null`。 */
function readRecord(body: unknown): { version: number; doc: SyncDocument | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as { version?: unknown; doc?: unknown };
  if (typeof rec.version !== "number" || !Number.isSafeInteger(rec.version) || rec.version < 0) {
    return null;
  }
  if (rec.version === 0) return { version: 0, doc: null };
  const doc = parseSyncDocument(rec.doc);
  return doc === null ? null : { version: rec.version, doc };
}

/**
 * 做一輪同步。回傳合併後的庫；呼叫端在 `localChanged` 時存檔、重畫。
 *
 * ⚠ `local` 的 `account`、`accountLabel`、`selected` 原樣保留（文件裡沒有那三欄）。
 */
export async function syncDeckLibrary(
  local: DeckLibrary,
  opts: DeckSyncOptions,
): Promise<DeckSyncResult> {
  const got = await call(opts, { method: "GET" });
  if ("error" in got) return { ok: false, reason: `讀雲端失敗：${got.error}` };

  let remote: { version: number; doc: SyncDocument | null };
  if (got.status === 404) remote = { version: 0, doc: null };
  else if (got.status === 200) {
    const rec = readRecord(got.body);
    if (rec === null) return { ok: false, reason: "雲端那份讀不懂（可能是新版格式），這一輪不動" };
    remote = rec;
  } else {
    return { ok: false, reason: `讀雲端失敗：HTTP ${got.status}` };
  }

  let base = local;
  let localChanged = false;
  let pulled = 0;
  let deleted = 0;
  const attempts = opts.maxAttempts ?? 3;

  for (let i = 0; i < attempts; i++) {
    const merged = mergeLibraries(base, remote.doc);
    pulled += merged.plan.pull.length;
    deleted += merged.plan.deleteLocal.length;
    if (merged.localChanged) {
      base = merged.library;
      localChanged = true;
    }
    if (!merged.remoteChanged) {
      return {
        ok: true,
        library: base,
        localChanged,
        pushed: false,
        version: remote.version,
        pulled,
        deleted,
      };
    }

    const put = await call(opts, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": `"${remote.version}"` },
      body: JSON.stringify({ doc: merged.document }),
    });
    if ("error" in put) return { ok: false, reason: `推上雲端失敗：${put.error}` };
    if (put.status === 200) {
      const v = (put.body as { version?: unknown } | null)?.version;
      const version = typeof v === "number" ? v : remote.version + 1;
      return { ok: true, library: base, localChanged, pushed: true, version, pulled, deleted };
    }
    if (put.status === 409) {
      // 別台電腦剛好先寫了：拿它那份重來。本地已經合進去的東西（base）留著。
      const rec = readRecord(put.body);
      if (rec === null) return { ok: false, reason: "雲端衝突回應讀不懂，這一輪不動" };
      remote = rec;
      continue;
    }
    return { ok: false, reason: `推上雲端失敗：HTTP ${put.status}` };
  }
  return { ok: false, reason: `連續 ${attempts} 次撞到別台電腦同時在寫，下一輪再試` };
}
