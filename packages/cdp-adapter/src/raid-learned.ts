/**
 * 渦的獎勵表：邊打邊學
 * ===================
 * 2026-09-23 改版後渦清單**沒有 treasure_level、也沒有 stage**（`raid-treasure.ts` 那張
 * TL 表對不上新渦），ulgg 也一樣沒 TL 了。客戶端手上剩下的只有：
 *
 * ```
 *   raid_list[i] = { monster_id, level, rarity, map_index, category, reward(參加獎勵), … }
 * ```
 *
 * `map_index` 是渦房地圖上的區塊（`show_vortex` 拿它當 `p.sR[map_index]` 矩形），不是
 * 以前的 stage。碎片（記憶／時間／…）與渦幣在新客戶端的道具表裡**已經不存在**，排名獎勵
 * 現在會是什麼沒人知道。所以不猜：每收到一次結算（`db_raid_reward`，進渦房時客戶端自己要），
 * 就把那個渦**實際發下來的東西**依「渦鍵」記起來，同一種渦之後直接畫。
 *
 * ```
 *   渦鍵 = m{monster_id}-L{level}-R{rarity}-M{map_index}   （跟 Moon/探渦.py 同一把）
 * ```
 *
 * ## 一次結算學得到什麼
 *
 * | 欄位            | 來源                                   | 看得到的條件            |
 * | --------------- | -------------------------------------- | ----------------------- |
 * | 排名（每一檔）  | `raid_participants[i].reward`          | 永遠（每個人各自那份）  |
 * | 參加            | `raid_reward.participate`              | 永遠                    |
 * | 發現            | `raid_reward.founder`                  | 自己是發現者            |
 * | 擊破            | `raid_reward.defeat`                   | 自己打最後一擊、而且發現者沒把它關掉 |
 *
 * 看不到的那一類記成 `null`（不知道），跟「確定沒有」的空陣列分開。
 *
 * ## 鍵對不對
 *
 * 渦鍵是推測（同怪、同階、同★、同區塊 → 同一張獎勵表）。兩次結算對不上（同一個名次拿到
 * 不同東西、類別不同）就標 `conflict`、改用新的那份 —— 面板上看得到，之後要換鍵時有依據。
 * 排名第一檔的碎片（角色卡）不一樣另外標 `fragConflict`：頁面畫碎片色只看這個 ——
 * 其他獎勵對不上不代表碎片猜錯。
 *
 * 碎片看的是 stage（ulgg 的 stage_id 套舊公式都對），而 stage 看怪＋區塊（見 raid-treasure.ts 的
 * `raidStageByMap`；2026-09-25 回測這把鍵同鍵 16/16 一致）。頁面畫碎片色時自己看到的／ulgg 的
 * stage 優先，再來是這張表，最後才照區塊推。每一筆結算原料（含當時的 stage）另外留一份 `log`，
 * 規則改了可以從它整張重算。
 *
 * ⚠ 看不到不算對不上：參加獎勵空的（2026-09-25 黑死獸 M5 有一筆是空的）當沒看到；
 * 排名最後幾個拿空的（0 分）不算「看過」—— 不然下一筆看到第 11 名拿 x1，
 * 會拿上一筆開到底的那檔（x2）去比，黑死獸 M1 就是這樣被誤標的。
 */

/** 獎勵碼：`{type, id, slot, value}`（type 1 角色、2 武器／事件卡、3 道具、4 部件、5 GEM）。 */
export interface RaidRewardCode {
  type: number;
  id: number;
  slot: number;
  value: number;
}

/** 排名獎勵的一檔：第 from 名到第 to 名（`to` 是 null＝到最後一名）。 */
export interface RaidRankTier {
  from: number;
  to: number | null;
  items: RaidRewardCode[];
}

/** 頁面收到一次結算時回報的原料（不含任何玩家名字）。 */
export interface RaidLearnSample {
  profoundId: string;
  name: string;
  monsterId: number;
  level: number;
  rarity: number;
  mapIndex: number;
  category: string | null;
  /** 自己是發現者才看得到；不是就 null */
  founder: RaidRewardCode[] | null;
  participate: RaidRewardCode[];
  /** 有東西才算看到（沒打最後一擊、或被關掉都是空的）；空的記 null */
  defeat: RaidRewardCode[] | null;
  /** 照名次排的每一個參加者拿到的排名獎勵 */
  ranks: RaidRewardCode[][];
  /** 渦還活著時 ulgg 給的 stage（對不到就 null）—— 找規則用 */
  stage: number | null;
  at: number;
}

/** 結算原料最多留幾筆（每筆幾百 byte）。 */
export const RAID_LEARN_LOG_MAX = 500;

export interface RaidLearnReport {
  type: "raid-learn";
  sample: RaidLearnSample;
}

/** 學到的一種渦。 */
export interface RaidLearnedEntry {
  key: string;
  name: string;
  monsterId: number;
  level: number;
  rarity: number;
  mapIndex: number;
  category: string | null;
  discovery: RaidRewardCode[] | null;
  participation: RaidRewardCode[] | null;
  defeat: RaidRewardCode[] | null;
  ranking: RaidRankTier[];
  /** 排名表是從幾個參加者看出來的（最後一檔的 to 之後可能還有沒看過的檔） */
  rankSeen: number;
  samples: number;
  /** 最近一次學到的時刻（ms） */
  at: number;
  /** 有兩次結算對不上 */
  conflict: boolean;
  /** 有兩次結算第 1 名拿到的碎片（角色卡）不一樣 */
  fragConflict: boolean;
}

export type RaidLearnedTable = Record<string, RaidLearnedEntry>;

export function raidRewardKey(v: {
  monsterId: number;
  level: number;
  rarity: number;
  mapIndex: number;
}): string {
  return `m${v.monsterId}-L${v.level}-R${v.rarity}-M${v.mapIndex}`;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isItem(v: unknown): v is RaidRewardCode {
  const o = v as Record<string, unknown> | null;
  return (
    typeof v === "object" &&
    o !== null &&
    isInt(o.type) &&
    isInt(o.id) &&
    isInt(o.slot) &&
    isInt(o.value)
  );
}

function items(v: unknown): RaidRewardCode[] | null {
  if (!Array.isArray(v) || !v.every(isItem)) return null;
  return v.map((x) => ({ type: x.type, id: x.id, slot: x.slot, value: x.value }));
}

function itemsOrNull(v: unknown): RaidRewardCode[] | null | undefined {
  if (v === null) return null;
  const list = items(v);
  return list === null ? undefined : list;
}

export function isRaidLearnReport(value: unknown): value is RaidLearnReport {
  const o = value as { type?: unknown; sample?: unknown } | null;
  if (typeof value !== "object" || o === null || o.type !== "raid-learn") return false;
  const s = o.sample as Record<string, unknown> | null;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.profoundId === "string" &&
    typeof s.name === "string" &&
    isInt(s.monsterId) &&
    isInt(s.level) &&
    isInt(s.rarity) &&
    isInt(s.mapIndex) &&
    (s.category === null || typeof s.category === "string") &&
    itemsOrNull(s.founder) !== undefined &&
    items(s.participate) !== null &&
    itemsOrNull(s.defeat) !== undefined &&
    Array.isArray(s.ranks) &&
    s.ranks.every((r) => items(r) !== null) &&
    (s.stage === null || isInt(s.stage)) &&
    isInt(s.at)
  );
}

/** 把一筆原料接到 log 尾巴：同一個渦只留一筆、超過上限丟最舊的。 */
export function appendLearnLog(
  log: readonly RaidLearnSample[],
  sample: RaidLearnSample,
): RaidLearnSample[] {
  const out = log.filter((s) => s.profoundId !== sample.profoundId);
  out.push(sample);
  return out.length > RAID_LEARN_LOG_MAX ? out.slice(out.length - RAID_LEARN_LOG_MAX) : out;
}

/**
 * 從 log 整張重算（照時間先後併）。規則改了（例如哪些差異算對不上）時，舊檔上的
 * 表會自己跟著變對；log 沒涵蓋到的舊條目照留。
 */
export function rebuildLearned(
  table: RaidLearnedTable,
  log: readonly RaidLearnSample[],
): RaidLearnedTable {
  let out: RaidLearnedTable = {};
  for (const s of [...log].sort((a, b) => a.at - b.at)) out = mergeLearned(out, s).table;
  for (const [key, e] of Object.entries(table)) if (out[key] === undefined) out[key] = e;
  return out;
}

/** 讀硬碟上那份的 log：壞掉的那一筆丟掉。 */
export function parseLearnLog(value: unknown): RaidLearnSample[] {
  const o = value as { log?: unknown } | null;
  const src = typeof value === "object" && o !== null ? o.log : null;
  if (!Array.isArray(src)) return [];
  return src.filter((s): s is RaidLearnSample =>
    isRaidLearnReport({ type: "raid-learn", sample: s }),
  );
}

function itemsKey(list: readonly RaidRewardCode[]): string {
  return list
    .map((i) => `${i.type}:${i.id}:${i.slot}:${i.value}`)
    .sort()
    .join(",");
}

/**
 * 參加者的獎勵 → 一檔一檔。相鄰拿一樣的併成一檔；中間有人拿空的（0 分之類）不切斷，
 * 算進前一檔。最後一檔開到底（`to: null`）。
 */
export function rankTiers(ranks: readonly (readonly RaidRewardCode[])[]): RaidRankTier[] {
  const tiers: RaidRankTier[] = [];
  let last = "";
  for (let i = 0; i < ranks.length; i++) {
    const got = ranks[i] ?? [];
    if (got.length === 0) continue;
    const k = itemsKey(got);
    if (tiers.length > 0 && k === last) continue;
    tiers.push({ from: i + 1, to: null, items: got.map((x) => ({ ...x })) });
    last = k;
  }
  for (let t = 0; t < tiers.length - 1; t++) tiers[t]!.to = tiers[t + 1]!.from - 1;
  return tiers;
}

/** 第 rank 名那一檔拿什麼；沒有那一檔回 null。 */
export function tierAt(tiers: readonly RaidRankTier[], rank: number): RaidRankTier | null {
  for (const t of tiers) {
    if (rank >= t.from && (t.to === null || rank <= t.to)) return t;
  }
  return null;
}

export function learnedFromSample(sample: RaidLearnSample): RaidLearnedEntry {
  // 排名看到第幾個：最後拿空的（0 分）不算
  let seen = sample.ranks.length;
  while (seen > 0 && (sample.ranks[seen - 1] ?? []).length === 0) seen--;
  return {
    key: raidRewardKey(sample),
    name: sample.name,
    monsterId: sample.monsterId,
    level: sample.level,
    rarity: sample.rarity,
    mapIndex: sample.mapIndex,
    category: sample.category,
    discovery: sample.founder,
    participation: sample.participate.length > 0 ? sample.participate : null,
    defeat: sample.defeat !== null && sample.defeat.length > 0 ? sample.defeat : null,
    ranking: rankTiers(sample.ranks),
    rankSeen: seen,
    samples: 1,
    at: sample.at,
    conflict: false,
    fragConflict: false,
  };
}

/** 第 1 名拿到的角色卡（碎片／渦幣）id；沒看到回空字串。 */
function topCharaKey(e: RaidLearnedEntry): string {
  const tier = tierAt(e.ranking, 1);
  if (tier === null) return "";
  return tier.items
    .filter((i) => i.type === 1)
    .map((i) => i.id)
    .sort((a, b) => a - b)
    .join(",");
}

function sameList(a: RaidRewardCode[] | null, b: RaidRewardCode[] | null): boolean {
  if (a === null || b === null) return true;
  return itemsKey(a) === itemsKey(b);
}

/** 兩份排名表在兩邊都看過的名次上是不是一致。 */
function sameRanking(a: RaidLearnedEntry, b: RaidLearnedEntry): boolean {
  const upto = Math.min(a.rankSeen, b.rankSeen);
  for (let r = 1; r <= upto; r++) {
    const ta = tierAt(a.ranking, r);
    const tb = tierAt(b.ranking, r);
    if (ta === null || tb === null) continue;
    if (itemsKey(ta.items) !== itemsKey(tb.items)) return false;
  }
  return true;
}

/**
 * 把一次結算併進表裡。回傳新表（不改原本那份）與這次是不是對不上。
 *
 * - 各類：兩邊都看得到又不一樣 → conflict，用新的；只有一邊看得到就用看得到的那份
 * - 排名：兩邊都看過的名次不一樣 → conflict，用新的；一樣就留看過比較多人的那份
 */
export function mergeLearned(
  table: RaidLearnedTable,
  sample: RaidLearnSample,
): { table: RaidLearnedTable; entry: RaidLearnedEntry; conflict: boolean; isNew: boolean } {
  const next = learnedFromSample(sample);
  const prev = table[next.key];
  if (prev === undefined) {
    return { table: { ...table, [next.key]: next }, entry: next, conflict: false, isNew: true };
  }
  // ⚠ category 不比：自己開的渦是 normal、別人的是 another（2026-09-25 同一種龍鯰兩筆實測），
  // 是看的角度，不是渦的屬性
  const clash =
    !sameList(prev.discovery, next.discovery) ||
    !sameList(prev.participation, next.participation) ||
    !sameList(prev.defeat, next.defeat) ||
    !sameRanking(prev, next);
  const pa = topCharaKey(prev);
  const pb = topCharaKey(next);
  const fragClash = pa !== "" && pb !== "" && pa !== pb;
  const newer = next.at >= prev.at;
  const pick = (a: RaidRewardCode[] | null, b: RaidRewardCode[] | null): RaidRewardCode[] | null =>
    a === null ? b : b === null ? a : newer ? a : b;
  const rankFromNext = clash ? newer : next.rankSeen > prev.rankSeen;
  const merged: RaidLearnedEntry = {
    ...(newer ? next : prev),
    discovery: pick(next.discovery, prev.discovery),
    participation: pick(next.participation, prev.participation),
    defeat: pick(next.defeat, prev.defeat),
    ranking: rankFromNext ? next.ranking : prev.ranking,
    rankSeen: rankFromNext ? next.rankSeen : prev.rankSeen,
    samples: prev.samples + 1,
    at: Math.max(prev.at, next.at),
    conflict: prev.conflict || clash,
    fragConflict: prev.fragConflict || fragClash,
  };
  return { table: { ...table, [next.key]: merged }, entry: merged, conflict: clash, isNew: false };
}

function parseTier(v: unknown): RaidRankTier | null {
  const o = v as Record<string, unknown> | null;
  if (typeof v !== "object" || o === null || !isInt(o.from)) return null;
  if (!(o.to === null || isInt(o.to))) return null;
  const list = items(o.items);
  return list === null ? null : { from: o.from, to: o.to, items: list };
}

function parseEntry(key: string, v: unknown): RaidLearnedEntry | null {
  const o = v as Record<string, unknown> | null;
  if (typeof v !== "object" || o === null) return null;
  if (
    !isInt(o.monsterId) ||
    !isInt(o.level) ||
    !isInt(o.rarity) ||
    !isInt(o.mapIndex) ||
    !isInt(o.rankSeen) ||
    !isInt(o.samples) ||
    !isInt(o.at) ||
    typeof o.name !== "string" ||
    !(o.category === null || typeof o.category === "string") ||
    !Array.isArray(o.ranking)
  ) {
    return null;
  }
  const discovery = itemsOrNull(o.discovery);
  const participation = itemsOrNull(o.participation);
  const defeat = itemsOrNull(o.defeat);
  if (discovery === undefined || participation === undefined || defeat === undefined) return null;
  const ranking: RaidRankTier[] = [];
  for (const t of o.ranking) {
    const tier = parseTier(t);
    if (tier === null) return null;
    ranking.push(tier);
  }
  return {
    key,
    name: o.name,
    monsterId: o.monsterId,
    level: o.level,
    rarity: o.rarity,
    mapIndex: o.mapIndex,
    category: o.category,
    discovery,
    participation,
    defeat,
    ranking,
    rankSeen: o.rankSeen,
    samples: o.samples,
    at: o.at,
    conflict: o.conflict === true,
    // 舊檔沒有這欄：保守當成跟 conflict 一樣（log 涵蓋到的會被整張重算）
    fragConflict: typeof o.fragConflict === "boolean" ? o.fragConflict : o.conflict === true,
  };
}

/** 讀硬碟上那份：壞掉的那一筆丟掉，其他照收。 */
export function parseLearnedTable(value: unknown): RaidLearnedTable {
  const o = value as { entries?: unknown } | null;
  const src = typeof value === "object" && o !== null ? o.entries : null;
  const out: RaidLearnedTable = {};
  if (typeof src !== "object" || src === null) return out;
  for (const [key, v] of Object.entries(src as Record<string, unknown>)) {
    const e = parseEntry(key, v);
    if (e !== null) out[key] = e;
  }
  return out;
}
