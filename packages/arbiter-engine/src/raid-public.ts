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
  raidShareKey,
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
    const info: RaidPublicInfo = {
      tl: optNumber(r.treasure_level) ?? optNumber(reward?.treasureLevel),
      rarity: optNumber(reward?.rarity),
      stage: optNumber(reward?.mapLevel),
      mons: optString(r.monster_code),
      states: statesOf(r.state_raw),
      // ulgg 給的是秒（有小數）
      seenAt:
        optNumber(r.last_seen_at) === null ? null : Math.round((r.last_seen_at as number) * 1000),
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

/**
 * 拿渦碼去看板查。渦碼先雜湊（看板上沒有渦碼），一次最多問 24 把、分批。
 * **任何失敗都回空表**。
 */
export async function lookupSharedRaids(
  codes: readonly string[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = DEFAULT_RAID_SHARE_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<RaidPublicMap> {
  const out: RaidPublicMap = {};
  const byKey = new Map<string, string>();
  for (const code of new Set(codes)) byKey.set(await raidShareKey(code), code);
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += MAX_RAID_SHARE_KEYS) {
    const chunk = keys.slice(i, i + MAX_RAID_SHARE_KEYS);
    const body = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${url}?keys=${chunk.join(",")}`, { signal }),
    );
    const raids = (body as { raids?: unknown } | null)?.raids;
    if (!Array.isArray(raids)) continue;
    for (const raw of raids as SharedRaid[]) {
      const code = byKey.get(raw?.key);
      if (code === undefined) continue;
      out[code] = {
        tl: optNumber(raw.tl),
        rarity: optNumber(raw.rarity),
        stage: optNumber(raw.stage),
        mons: optString(raw.mons),
        states: Array.isArray(raw.states)
          ? raw.states.map((s) => ({
              type: String(s.type),
              until: optNumber(s.until),
              count: optNumber(s.count),
            }))
          : [],
        seenAt: optNumber(raw.seenAt),
      };
    }
  }
  return out;
}

/**
 * 把自己渦清單上的渦傳上去。渦碼換成雜湊、只傳畫圖示要的欄位。
 * 回傳雲端收下幾筆；失敗回 0。
 */
export async function uploadSharedRaids(
  rows: readonly RaidSnapshotRow[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = DEFAULT_RAID_SHARE_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<number> {
  const payload: SharedRaidUpload[] = [];
  for (const r of rows) {
    if (typeof r.code !== "string" || r.code === "") continue;
    payload.push({
      key: await raidShareKey(r.code),
      tl: r.tl,
      rarity: r.rarity,
      stage: r.stage,
      mons: r.mons,
      hp: r.hp,
      hpMax: r.hpMax,
      limit: r.limit,
      states: r.states,
    });
  }
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
 * 從另一份補。沒有 `seenAt` 的當作最舊。
 */
export function mergePublicMaps(a: RaidPublicMap, b: RaidPublicMap): RaidPublicMap {
  const out: RaidPublicMap = { ...a };
  for (const [code, info] of Object.entries(b)) {
    const other = out[code];
    if (other === undefined) {
      out[code] = info;
      continue;
    }
    const [newer, older] =
      (info.seenAt ?? -1) > (other.seenAt ?? -1) ? [info, other] : [other, info];
    out[code] = {
      tl: newer.tl ?? older.tl,
      rarity: newer.rarity ?? older.rarity,
      stage: newer.stage ?? older.stage,
      mons: newer.mons ?? older.mons,
      states: newer.states,
      seenAt: newer.seenAt ?? older.seenAt ?? null,
    };
  }
  return out;
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
