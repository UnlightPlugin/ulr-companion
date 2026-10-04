/**
 * 公開渦的 TL 從哪來：ulgg 的 observed_raids
 * ==========================================
 * 渦房右下角 SUPPORT 那份公開渦清單，伺服器只給 7 欄（code/name/mons/founder/
 * hp/member/limit），**沒有 treasure_level**，所以插件自己看不出那些渦的獎勵。
 * 要知道就得加入（不花 AP，但會佔清單格子）—— 或問一個已經加入了的人。
 *
 * ulgg.online 的觀測站就是那個「已經加入了的人」：它用一個帳號把公開渦全部
 * 加進去、每 30 秒讀一次 `db_raid`，再從 `/api/observed_raids.php` 吐出來。
 * 每一筆的 `raid_id` **就是渦碼**（跟 SUPPORT 清單的 `prf_code` 同一個字串），
 * 附 `treasure_level`、`reward.rarity`、`reward.mapLevel`（＝stage）、`monster_code`、
 * `state_raw[{type, expires_at, value}]`。
 *
 * 2026-09-23 改版後（2026-09-25 讀的）：`treasure_level`／`reward` 是 null，改成最上層的
 * `stage_id`、`rarity`、`fragment`、`fragment_source`（stage_sync_report／stage_sync_deferred），
 * 另有 `expires_at`、`founder`。別人開的渦清單上沒有渦碼，頁面拿到期時刻＋發現者對。
 * 實測兩個渦：`stage_id` 套舊公式算出的碎片跟實際結算一致（地圖區塊 map_index 套公式兩個都錯）。
 * ⚠ 觀測站會斷線（`connected: false`、清單是空的），那段時間就只剩插件自己學到的。
 *
 * 這一份只做兩件事：把那個 JSON **整理成頁面端要的形狀**（純函式，可測），
 * 和用一個有逾時的 fetch 去拿。什麼時候拿、多久拿一次是 engine 決定的
 * （只在玩家人在渦房時、30 秒一次 —— 跟 ulgg 自己的頁面一樣頻率）。
 *
 * ⚠ 這是第三方網站，隨時可能改格式或消失。拿不到就是沒有圖示，**不能**
 * 讓渦房其他功能跟著壞：所有失敗都吞掉，回空表。
 */

import type { SharedRaid, SharedRaidUpload } from "@ulr/arbiter-link";
import {
  DEFAULT_RAID_SHARE_URL,
  MAX_RAID_SHARE_KEYS,
  MAX_RAIDS_PER_POST,
  raidRowShareKey,
} from "@ulr/arbiter-link";
import type {
  RaidPublicInfo,
  RaidPublicMap,
  RaidSnapshotRow,
  RaidStateRef,
} from "@ulr/cdp-adapter";

export const ULGG_OBSERVED_RAIDS_URL = "https://ulgg.online/api/observed_raids.php";

/** 拉一次的逾時。ulgg 自己的頁面設 1.8 秒，我們寬一點。 */
export const DEFAULT_RAID_PUBLIC_TIMEOUT_MS = 5_000;

/** 多久拉一次。ulgg 頁面自己也是 30 秒。 */
export const RAID_PUBLIC_REFRESH_MS = 30_000;

function optNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * `state_raw[]`：`{type, expires_at, value}` → 頁面端的 `{type, until, count}`。
 * `type` 是帶等級的整字（`movD9`），`expires_at` 是 ms（詛咒沒有，
 * 層數在 `value`）。認不得的丟掉。
 */
function statesOf(raw: unknown): RaidStateRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RaidStateRef[] = [];
  for (const s of raw) {
    const o = (s ?? null) as { type?: unknown; expires_at?: unknown; value?: unknown } | null;
    if (o === null || typeof o.type !== "string" || o.type === "") continue;
    out.push({ type: o.type, until: optNumber(o.expires_at), count: optNumber(o.value) });
  }
  return out;
}

/**
 * observed_raids 的回應 → 渦碼 → 分類欄位。只收 `status === "active"`
 * 的（結束的渦不會出現在 SUPPORT 清單上），沒有 `raid_id` 的跳過。
 */
export function parseObservedRaids(payload: unknown): RaidPublicMap {
  const out: RaidPublicMap = {};
  const p = payload as { ok?: unknown; raids?: unknown } | null;
  if (p === null || typeof p !== "object" || !Array.isArray(p.raids)) return out;
  for (const raw of p.raids) {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") continue;
    const code = optString(r.raid_id);
    if (code === null) continue;
    if (r.status !== undefined && r.status !== "active") continue;
    const reward = (r.reward ?? null) as Record<string, unknown> | null;
    // ulgg 給的是秒（有小數）
    const seenAt =
      optNumber(r.last_seen_at) === null ? null : Math.round((r.last_seen_at as number) * 1000);
    const states = statesOf(r.state_raw);
    const info: RaidPublicInfo = {
      tl: optNumber(r.treasure_level) ?? optNumber(reward?.treasureLevel),
      rarity: optNumber(reward?.rarity) ?? optNumber(r.rarity),
      stage: optNumber(reward?.mapLevel) ?? optNumber(r.stage_id),
      mons: optString(r.monster_code),
      states,
      seenAt,
      // 改版後 state_raw 永遠是空的（看不到，不是沒有）：空的不算「看過狀態」
      statesAt: states.length > 0 ? seenAt : null,
      limit: optNumber(r.expires_at),
      founder: optString(r.founder),
    };
    out[code] = info;
  }
  return out;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// 插件互傳（ulgg 的備援）
//
// 玩家 2026-09-13：「網站的資料來源作為備份，當網站掛點時，可用插件玩家之間
// 共享訊息。」兩邊都問，**同一個渦取觀測時間比較新的那一份**：ulgg 活著時
// 通常是它（30 秒一輪），掛了或還沒掃到的渦就是插件互傳的。
// 看板與雜湊的理由見 `@ulr/arbiter-link/raid-share`。
// ---------------------------------------------------------------------------

/** 互傳一輪的結果：查回來的表（鍵見 {@link sharedRaidMapKey}）＋這次傳上去幾筆。 */
export interface SharedRaidSync {
  map: RaidPublicMap;
  uploaded: number;
}

/**
 * 查回來的表用什麼當鍵：有渦碼（自己開的）用渦碼，跟 ulgg 同一把；沒有就用發現者＋到期時刻。
 * 頁面拿 limit／founder 對渦（`publicOf`），鍵本身只是不重複就好。
 */
export function sharedRaidMapKey(row: Pick<RaidSnapshotRow, "code" | "founder" | "limit">): string {
  return typeof row.code === "string" && row.code !== ""
    ? row.code
    : `@${row.founder ?? ""}@${row.limit}`;
}

function sharedStates(raw: SharedRaid): RaidStateRef[] {
  return Array.isArray(raw.states)
    ? raw.states.map((s) => ({
        type: String(s.type),
        until: optNumber(s.until),
        count: optNumber(s.count),
      }))
    : [];
}

/**
 * 插件互傳一輪：自己渦清單上的每一個渦，先查看板、再把自己知道而看板上沒有（或比較舊）的傳上去。
 *
 * - 鍵是「種類＋發現者＋到期時刻」的雜湊（{@link raidRowShareKey}），清單上每個人都算得出來
 * - stage：自己知道、看板上沒有才傳
 * - BOSS 狀態：自己開打時看到的（`statesAt`）比看板上那份收到的時刻新才傳 ——
 *   看板同一把 key 後到的為準，每輪都傳的話托盤一重開就把別人新的蓋回舊的
 *
 * **任何失敗都當沒查到／沒傳**，不丟例外。
 */
export async function syncSharedRaids(
  rows: readonly RaidSnapshotRow[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = DEFAULT_RAID_SHARE_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<SharedRaidSync> {
  const withFounder = rows.filter(
    (r): r is RaidSnapshotRow & { founder: string } =>
      typeof r.founder === "string" && r.founder !== "",
  );
  const keyed = await Promise.all(
    withFounder.map(async (r) => ({
      row: r,
      stageKey: await raidRowShareKey(r.founder, r.limit, "stage"),
      statesKey: await raidRowShareKey(r.founder, r.limit, "states"),
    })),
  );
  const found = new Map<string, SharedRaid>();
  const keys = keyed.flatMap((k) => [k.stageKey, k.statesKey]);
  for (let i = 0; i < keys.length; i += MAX_RAID_SHARE_KEYS) {
    const chunk = keys.slice(i, i + MAX_RAID_SHARE_KEYS);
    const body = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${url}?keys=${chunk.join(",")}`, { signal }),
    );
    const raids = (body as { raids?: unknown } | null)?.raids;
    if (!Array.isArray(raids)) continue;
    for (const raw of raids as SharedRaid[]) {
      if (raw !== null && typeof raw === "object" && typeof raw.key === "string")
        found.set(raw.key, raw);
    }
  }

  const map: RaidPublicMap = {};
  const payload: SharedRaidUpload[] = [];
  for (const { row, stageKey, statesKey } of keyed) {
    const sg = found.get(stageKey);
    const ss = found.get(statesKey);
    if (sg !== undefined || ss !== undefined) {
      map[sharedRaidMapKey(row)] = {
        tl: null,
        rarity: optNumber(sg?.rarity),
        stage: optNumber(sg?.stage),
        mons: null,
        states: ss === undefined ? [] : sharedStates(ss),
        seenAt: optNumber(ss?.seenAt) ?? optNumber(sg?.seenAt),
        statesAt: ss === undefined ? null : optNumber(ss.seenAt),
        limit: row.limit,
        founder: row.founder,
      };
    }
    const base = { tl: null, mons: null, hp: row.hp, hpMax: row.hpMax, limit: row.limit };
    if (row.stage !== null && optNumber(sg?.stage) === null) {
      payload.push({ ...base, key: stageKey, rarity: row.rarity, stage: row.stage, states: [] });
    }
    if (row.statesAt !== null && row.statesAt > (optNumber(ss?.seenAt) ?? -1)) {
      payload.push({ ...base, key: statesKey, rarity: null, stage: null, states: row.states });
    }
  }
  return { map, uploaded: await postSharedRaids(payload, fetchImpl, url, timeoutMs) };
}

/** 分批 POST。回傳雲端收下幾筆；失敗回 0。 */
async function postSharedRaids(
  payload: readonly SharedRaidUpload[],
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < payload.length; i += MAX_RAIDS_PER_POST) {
    const body = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(url, {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raids: payload.slice(i, i + MAX_RAIDS_PER_POST) }),
      }),
    );
    const n = (body as { accepted?: unknown } | null)?.accepted;
    if (typeof n === "number") accepted += n;
  }
  return accepted;
}

/**
 * 合併兩份公開渦表：同一個渦取 `seenAt` 比較新的那份當底，缺的欄位（TL 那些）
 * 從另一份補；BOSS 狀態取 `statesAt` 比較新的那份。沒有時刻的當作最舊。
 *
 * 「同一個渦」是同一個鍵，或到期時刻＋發現者都一樣（ulgg 用渦碼當鍵，互傳查回來的
 * 別人的渦沒有渦碼）—— 對上了就併進 a 那一把，頁面才不會先找到缺 stage 的那份。
 */
export function mergePublicMaps(a: RaidPublicMap, b: RaidPublicMap): RaidPublicMap {
  const out: RaidPublicMap = { ...a };
  const byRaid = new Map<string, string>();
  for (const [code, info] of Object.entries(a)) {
    if (typeof info.limit === "number" && typeof info.founder === "string")
      byRaid.set(`${info.founder}@${info.limit}`, code);
  }
  for (const [key, info] of Object.entries(b)) {
    const code =
      out[key] === undefined && typeof info.limit === "number" && typeof info.founder === "string"
        ? (byRaid.get(`${info.founder}@${info.limit}`) ?? key)
        : key;
    const other = out[code];
    if (other === undefined) {
      out[code] = info;
      continue;
    }
    const [newer, older] =
      (info.seenAt ?? -1) > (other.seenAt ?? -1) ? [info, other] : [other, info];
    // 沒有 statesAt 欄位（舊的形狀）的狀態時刻當作 seenAt
    const statesTime = (x: RaidPublicInfo) =>
      x.statesAt !== undefined ? (x.statesAt ?? -1) : (x.seenAt ?? -1);
    const [statesNew, statesOld] =
      statesTime(info) > statesTime(other) ? [info, other] : [other, info];
    const merged: RaidPublicInfo = {
      tl: newer.tl ?? older.tl,
      rarity: newer.rarity ?? older.rarity,
      stage: newer.stage ?? older.stage,
      mons: newer.mons ?? older.mons,
      states: statesNew.states,
      seenAt: newer.seenAt ?? older.seenAt ?? null,
      limit: newer.limit ?? older.limit ?? null,
      founder: newer.founder ?? older.founder ?? null,
    };
    const statesAt = statesNew.statesAt ?? statesOld.statesAt;
    if (statesAt !== undefined) merged.statesAt = statesAt;
    // 只有公開渦通報那份有（ulgg、插件互傳沒有），哪份新都要留著
    const fragment = newer.fragment ?? older.fragment;
    if (fragment !== undefined) merged.fragment = fragment;
    out[code] = merged;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 回報 stage 給 ulgg（2026-09-25 ulgg 作者開的 community API）
//
// ulgg 用渦碼認渦，改版後渦碼只有發現者看得到。
// ulgg 自己的來源（fragment_source: stage_sync_report）是小號加房、進戰鬥讀 stage：
// 要花時間跟 AP。發現者開渦當下就知道，能搶在小號前面 —— 這是回報的價值所在。
// 別人開的渦（清單上沒有渦碼）打過一場也知道 stage；ulgg 的小號沒體力就加不了渦、讀不到
// （2026-09-25 實例：別人開的屠殺者掛了幾小時 stage 都是 null）—— 拿發現者＋到期時刻
// 對上 ulgg 列出的那一筆，用 **ulgg 公開的渦碼**回報。
// 三條線：
//   · 只報 ulgg 已經列出來的渦碼：observed_raids 本來就公開那些渦碼，不會把沒公開的渦碼送出去
//   · 只報 ulgg 還沒有 stage 的：不蓋別人的回報
//   · 只報自己看到的 stage（發現畫面的 raid_stage、戰鬥設定的 stage），一個渦一次
// ---------------------------------------------------------------------------

export const ULGG_FRAGMENT_REPORT_URL = "https://ulgg.online/api/raid_fragment_report.php";

export interface UlggStageReport {
  raid_code: string;
  stage: number;
  rarity: number;
}

/** ulgg 的回應（2026-09-25 作者給的樣本）。 */
export interface UlggStageReportResult {
  ok?: boolean;
  accepted?: boolean;
  matched?: boolean;
  persisted?: boolean;
  reason?: string;
}

/**
 * 清單上這個渦在 ulgg 的渦碼；ulgg 沒列出就是 null。
 * 自己開的直接用渦碼；別人開的（沒有渦碼）拿到期時刻＋發現者對（跟頁面的 pubFor 一樣）。
 */
export function ulggCodeOf(row: RaidSnapshotRow, ulgg: RaidPublicMap): string | null {
  if (typeof row.code === "string" && row.code !== "")
    return ulgg[row.code] === undefined ? null : row.code;
  if (row.founder === null) return null;
  for (const [code, info] of Object.entries(ulgg)) {
    if (info.limit === row.limit && info.founder === row.founder) return code;
  }
  return null;
}

/** 這一輪要回報哪些。`done` 是已經報過（拿到回應）的渦碼。 */
export function pickUlggReports(
  mine: readonly RaidSnapshotRow[],
  ulgg: RaidPublicMap,
  done: ReadonlySet<string>,
): UlggStageReport[] {
  const out: UlggStageReport[] = [];
  for (const r of mine) {
    if (r.stage === null || r.rarity === null) continue;
    const code = ulggCodeOf(r, ulgg);
    if (code === null || done.has(code) || ulgg[code]?.stage !== null) continue;
    out.push({ raid_code: code, stage: r.stage, rarity: r.rarity });
  }
  return out;
}

/** 送一筆。網路／逾時／非 2xx 回 null（下一輪再試）；有回應就回它。 */
export async function reportStageToUlgg(
  report: UlggStageReport,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = ULGG_FRAGMENT_REPORT_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<UlggStageReportResult | null> {
  const body = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(url, {
      signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    }),
  );
  return body !== null && typeof body === "object" ? (body as UlggStageReportResult) : null;
}

/** 一次請求＋逾時，回 JSON；失敗（網路、逾時、非 2xx、壞 JSON）回 null。 */
export async function withTimeout(
  timeoutMs: number,
  run: (signal: AbortSignal) => ReturnType<FetchLike>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await run(controller.signal);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉一次並整理。**任何失敗都回空表**（網路、逾時、格式、非 2xx），
 * 呼叫端不必 try/catch。
 */
export async function fetchObservedRaids(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
  url: string = ULGG_OBSERVED_RAIDS_URL,
): Promise<RaidPublicMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return {};
    return parseObservedRaids(await res.json());
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
