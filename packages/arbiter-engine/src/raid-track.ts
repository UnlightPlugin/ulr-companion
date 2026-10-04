/**
 * 渦結束紀錄 → 托盤記錄的一行
 * ==========================
 * 2026-09-25 妖精（魔性的鱗粉）等幾隻渦打死了卻沒有結算，玩家懷疑跟每 10 分鐘的刷新時間點
 * 有關。頁面在渦從清單消失時回報一則 raid-track（見 patch-raid-view 的 trackRaids），
 * 這裡排成一行寫進 companion.log，累積起來拿去對照「發現／死亡時刻的分鐘」跟「有沒有結算」。
 *
 * 「沒收到」只有在死後清單重拿過（進渦房／Refresh，同一次會要結算）才算數，
 * 沒重拿過的另外標出來，分析時別算進去。
 */

import { RAID_LEDGER_WATCH } from "@ulr/cdp-adapter";
import type { RaidRewardEntry, RaidSnapshotRow, RaidTrackReport } from "@ulr/cdp-adapter";

/** ms → 本機時間 HH:MM:SS。`utcOffsetMin` 給測試用；沒給就用這台電腦的時區。 */
export function clockOf(ms: number, utcOffsetMin?: number): string {
  const offset = utcOffsetMin ?? -new Date(ms).getTimezoneOffset();
  return new Date(ms + offset * 60_000).toISOString().slice(11, 19);
}

export function formatRaidTrack(r: RaidTrackReport, utcOffsetMin?: number): string {
  const t = (ms: number | null) => (ms === null ? "?" : clockOf(ms, utcOffsetMin));
  const who = r.mine ? "自己開的" : "別人開的";
  const head = `${r.name} Lv${r.level ?? "?"} ★${r.rarity ?? "?"} stage ${r.stage ?? "?"} ${r.category ?? "?"} 區塊${r.mapIndex ?? "?"} ${who}`;
  const death =
    r.deadSeen === null
      ? "死亡 —（沒看到 HP 0）"
      : `死亡≈${t(r.deathByLimit)}（到期−10分）／看到 ${t(r.deadSeen)}`;
  let settle: string;
  if (r.settled !== null) {
    settle = `結算 ${t(r.settled)}${r.gone !== null && r.settled > r.gone ? "（消失後才到）" : ""}`;
  } else if (r.deadSeen !== null && r.refreshAfterDeath === 0) {
    // 它消失的那次重拿清單就是進渦房／Refresh，同一次也要過結算
    settle = "結算 沒收到（死後沒重拿過清單，消失那次才要）";
  } else {
    settle = `結算 沒收到（死後重拿清單 ${r.refreshAfterDeath} 次）`;
  }
  if (raidOutcome(r) === "none") settle += "（0 分又不是發現者，本來就沒份）";
  return `· 渦結束：${head}｜發現 ${t(r.found)}｜${death}｜分數 ${r.point.toLocaleString("en-US")}｜${settle}｜消失 ${t(r.gone)}`;
}

// ---------------------------------------------------------------------------
// 每個渦拿到結算了沒（離線也追得到）
// ---------------------------------------------------------------------------
//
// 道具是**客戶端領結算那一刻**才入帳的（官方 show_raid_reward：拿清單 → 每個渦回報
// raid_reward_receive；2026-09-26 對過 update_at）。沒上線時什麼都不會發，下次進渦房
// 那一批結算才會列出這段時間死掉的渦。所以：
//
//   打一場 → 馬上記一筆 pending（落地，托盤重開、離線都在）
//   結算列了它 → got
//   人在渦房、清單上已經沒有它、等了一下結算也沒來 → lost（0 分又不是發現者 → none）
//
// 頁面看到渦結束（raid-track）時也會補上細節。鍵是發現時刻（ms），三條路都對得上。

export type RaidOutcome = "pending" | "got" | "lost" | "none";
/** 這筆是從哪來的：頁面的渦結束紀錄／自己打的那場／結算／舊記錄檔補的 */
export type RaidOutcomeSource = "track" | "battle" | "settlement" | "log";

export function raidOutcome(r: RaidTrackReport): Exclude<RaidOutcome, "pending"> {
  if (!r.mine && r.point === 0) return "none";
  return r.settled !== null ? "got" : "lost";
}

/**
 * 一個渦。除了分類，其餘欄位是拿來找「哪種渦沒結算」的規律用的
 * （怪、stage、渦房上標的預期獎勵、發現者、榜、死後問過伺服器幾次、自己最後一場離死亡多久……）。
 * 只存本機的 raid-outcomes.json，不寫進記錄檔、不上傳。
 */
export interface RaidOutcomeRecord {
  /** 發現時刻（ms）；不知道時是「名字@?」 */
  key: string;
  name: string;
  monsterId: number | null;
  level: number | null;
  rarity: number | null;
  /** 渦房上畫的那個 stage（1～5）；推不出來是 null */
  stage: number | null;
  category: string | null;
  mapIndex: number | null;
  founder: string | null;
  mine: boolean;
  point: number;
  outcome: RaidOutcome;
  source: RaidOutcomeSource;
  /** 渦房上標的預期碎片（道具名）、是不是渦幣、從哪推的、排名第一檔其他東西 */
  expectFrag: string | null;
  expectCoin: boolean | null;
  expectSrc: string | null;
  expectItems: string[];
  /** 發現／原本的到期／死亡（到期−10分推的）／插件看到死／消失／結算到的時刻，ms */
  found: number | null;
  limit: number | null;
  death: number | null;
  deadSeen: number | null;
  gone: number | null;
  settled: number | null;
  hpMax: number | null;
  /** 榜上幾個人、自己第幾名、榜首幾分 */
  rankCount: number | null;
  myRank: number | null;
  topPoint: number | null;
  /** 死後清單重拿幾次；死後跟伺服器要結算幾次、其中整包空的幾次 */
  refreshAfterDeath: number;
  asksAfterDeath: number | null;
  emptyAsksAfterDeath: number | null;
  /** 自己在這個渦打了幾場、第一場／最後一場的時刻 */
  battles: number;
  firstBattleAt: number | null;
  lastBattleAt: number | null;
  /** 結算上的名次、實際拿到的東西、官方回報「領了」成功沒 */
  rank: number | null;
  rewards: string[];
  received: boolean | null;
  /** 判定（結束）的時刻；還在等的是建立時刻。算「哪一天」用 */
  at: number;
}

export function outcomeKey(found: number | null, name: string): string {
  return found !== null ? String(found) : `${name}@?`;
}

function blankRecord(key: string, name: string, now: number): RaidOutcomeRecord {
  return {
    key,
    name,
    monsterId: null,
    level: null,
    rarity: null,
    stage: null,
    category: null,
    mapIndex: null,
    founder: null,
    mine: false,
    point: 0,
    outcome: "pending",
    source: "battle",
    expectFrag: null,
    expectCoin: null,
    expectSrc: null,
    expectItems: [],
    found: null,
    limit: null,
    death: null,
    deadSeen: null,
    gone: null,
    settled: null,
    hpMax: null,
    rankCount: null,
    myRank: null,
    topPoint: null,
    refreshAfterDeath: 0,
    asksAfterDeath: null,
    emptyAsksAfterDeath: null,
    battles: 0,
    firstBattleAt: null,
    lastBattleAt: null,
    rank: null,
    rewards: [],
    received: null,
    at: now,
  };
}

function replaceAt(
  records: readonly RaidOutcomeRecord[],
  i: number,
  rec: RaidOutcomeRecord,
): RaidOutcomeRecord[] {
  if (i < 0) return [...records, rec];
  const next = [...records];
  next[i] = rec;
  return next;
}

/** 從 pending 變成有結果：判定時刻記現在；本來就有結果的不動 */
function decidedAt(prev: RaidOutcomeRecord | null, now: number): number {
  return prev !== null && prev.outcome !== "pending" ? prev.at : now;
}

/** 本機打渦紀錄裡用得到的部分（鍵是「發現者@發現時刻」，發現者可能是 ???） */
export interface OwnBattle {
  raid: string;
  at: number;
  player?: string;
  points?: number;
  limit?: number;
}

export function foundOfBattle(raid: string): number | null {
  const n = Number(raid.slice(raid.lastIndexOf("@") + 1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ownBattlesOf(battles: readonly OwnBattle[], found: number | null) {
  const mine = found === null ? [] : battles.filter((b) => foundOfBattle(b.raid) === found);
  const at = mine.map((b) => b.at).sort((a, b) => a - b);
  return {
    battles: at.length,
    firstBattleAt: at[0] ?? null,
    lastBattleAt: at.at(-1) ?? null,
    points: mine.reduce((s, b) => s + (b.points ?? 0), 0),
  };
}

/**
 * 打了一場：還沒記過這個渦就記一筆 pending（離線、托盤重開都在）。
 * `battles` 是全部的打渦紀錄（場數、第一／最後一場從這裡算）。
 */
export function addBattle(
  records: readonly RaidOutcomeRecord[],
  battles: readonly OwnBattle[],
  b: OwnBattle,
  now: number,
): RaidOutcomeRecord[] {
  const found = foundOfBattle(b.raid);
  if (found === null) return [...records];
  const key = String(found);
  const i = records.findIndex((x) => x.key === key);
  const prev = i < 0 ? null : records[i]!;
  const own = ownBattlesOf(battles, found);
  const founder = b.raid.slice(0, b.raid.lastIndexOf("@"));
  const base = prev ?? {
    ...blankRecord(key, "?", now),
    found,
    limit: b.limit ?? null,
    founder: founder === "???" ? null : founder,
    mine: founder !== "???" && b.player !== undefined && founder === b.player,
  };
  const { points, ...counts } = own;
  return replaceAt(records, i, {
    ...base,
    ...counts,
    point: Math.max(base.point, points),
  });
}

/** 頁面的渦結束紀錄（raid-track）。同一個渦再報就更新；結算那邊記的名次／獎勵留著。 */
export function upsertOutcome(
  records: readonly RaidOutcomeRecord[],
  r: RaidTrackReport,
  now: number,
  battles: readonly OwnBattle[] = [],
): RaidOutcomeRecord[] {
  const key = outcomeKey(r.found, r.name);
  const i = records.findIndex((x) => x.key === key);
  const prev = i < 0 ? null : records[i]!;
  const base = prev ?? blankRecord(key, r.name, now);
  const own = ownBattlesOf(battles, r.found);
  // 先被結算翻成拿到的，渦結束紀錄晚到也不翻回去
  const keepGot = prev?.outcome === "got" && raidOutcome(r) === "lost";
  const outcome = keepGot ? "got" : raidOutcome(r);
  return replaceAt(records, i, {
    ...base,
    name: r.name,
    monsterId: r.monsterId ?? base.monsterId,
    level: r.level,
    rarity: r.rarity,
    stage: r.stage ?? base.stage,
    category: r.category,
    mapIndex: r.mapIndex,
    founder: r.founder ?? base.founder,
    mine: r.mine,
    point: r.point,
    outcome,
    source: prev?.source ?? "track",
    expectFrag: r.expectFrag ?? base.expectFrag,
    expectCoin: r.expectCoin ?? base.expectCoin,
    expectSrc: r.expectSrc ?? base.expectSrc,
    expectItems: r.expectItems && r.expectItems.length > 0 ? r.expectItems : base.expectItems,
    found: r.found,
    death: r.deathByLimit,
    deadSeen: r.deadSeen,
    gone: r.gone,
    settled: keepGot ? base.settled : (r.settled ?? base.settled),
    hpMax: r.hpMax ?? base.hpMax,
    rankCount: r.rankCount ?? base.rankCount,
    myRank: r.myRank ?? base.myRank,
    topPoint: r.topPoint ?? base.topPoint,
    refreshAfterDeath: r.refreshAfterDeath,
    asksAfterDeath: r.asksAfterDeath ?? base.asksAfterDeath,
    emptyAsksAfterDeath: r.emptyAsksAfterDeath ?? base.emptyAsksAfterDeath,
    // 補報時打渦紀錄可能已經過期丟掉了：沒對到就留先前的
    ...(own.battles > 0
      ? { battles: own.battles, firstBattleAt: own.firstBattleAt, lastBattleAt: own.lastBattleAt }
      : {}),
    at: decidedAt(prev, now),
  });
}

/** 清單消失後等多久沒結算才算沒拿到：結算跟清單是同一次進渦房拿的，晚幾秒到 */
export const RAID_VANISH_GRACE_MS = 60_000;

/**
 * 人在渦房時讀到的清單：還在的渦補上名字、stage、預期獎勵；還在等結算、清單上卻已經
 * 沒有的，等 {@link RAID_VANISH_GRACE_MS} 還沒結算就判定。`goneSince` 是呼叫端留著的狀態。
 * `listed` 是 false（頁面的清單還沒拿到）時只補資料、不判定。
 */
export function applySnapshot(
  records: readonly RaidOutcomeRecord[],
  rows: readonly RaidSnapshotRow[],
  listed: boolean,
  goneSince: Map<string, number>,
  now: number,
): { records: RaidOutcomeRecord[]; decided: RaidOutcomeRecord[] } {
  const byKey = new Map<string, RaidSnapshotRow>();
  for (const r of rows) if (r.foundAt !== null) byKey.set(String(r.foundAt), r);
  const decided: RaidOutcomeRecord[] = [];
  const next = records.map((x) => {
    const row = byKey.get(x.key);
    if (row !== undefined) {
      goneSince.delete(x.key);
      const m = row.meta;
      return {
        ...x,
        name: m && m.name !== "" ? m.name : x.name,
        monsterId: m?.monsterId ?? x.monsterId,
        level: m?.level ?? x.level,
        rarity: row.rarity ?? x.rarity,
        stage: m?.stage ?? x.stage,
        category: m?.category ?? x.category,
        mapIndex: m?.mapIndex ?? x.mapIndex,
        founder: row.founder ?? x.founder,
        point: m?.point ?? x.point,
        expectFrag: m?.expectFrag ?? x.expectFrag,
        expectCoin: m?.expectFrag ? m.expectCoin : x.expectCoin,
        expectSrc: m?.expectSrc ?? x.expectSrc,
        expectItems: m && m.expectItems.length > 0 ? m.expectItems : x.expectItems,
        hpMax: row.hpMax ?? x.hpMax,
        deadSeen: x.deadSeen ?? (row.hp !== null && row.hp < 1 ? now : null),
      };
    }
    if (x.outcome !== "pending" || !listed) return x;
    const since = goneSince.get(x.key);
    if (since === undefined) {
      goneSince.set(x.key, now);
      return x;
    }
    if (now - since < RAID_VANISH_GRACE_MS) return x;
    goneSince.delete(x.key);
    const rec: RaidOutcomeRecord = {
      ...x,
      outcome: !x.mine && x.point === 0 ? "none" : "lost",
      gone: x.gone ?? since,
      at: now,
    };
    decided.push(rec);
    return rec;
  });
  return { records: next, decided };
}

function flatRewards(e: RaidRewardEntry): string[] {
  return [...e.rewards.founder, ...e.rewards.participate, ...e.rewards.defeat, ...e.rewards.rank];
}

/**
 * 結算到了：有發現時刻的直接對鍵（沒記過就新開一筆）；沒有的（舊版頁面、清單上沒看過）
 * 退回名字＋發現者＋分數對還在等／沒拿到的。官方回報「領了」失敗的不算拿到 ——
 * 伺服器下次會再列一次。
 */
export function settleOutcomes(
  records: readonly RaidOutcomeRecord[],
  entries: readonly RaidRewardEntry[],
  now: number,
): { records: RaidOutcomeRecord[]; changed: number } {
  let next = [...records];
  let changed = 0;
  for (const e of entries) {
    const got = e.received !== false;
    const found = e.found ?? null;
    const i =
      found !== null
        ? next.findIndex((x) => x.key === String(found))
        : next.findIndex(
            (x) =>
              (x.outcome === "lost" || x.outcome === "pending") &&
              (e.prf === x.name || e.boss === x.name) &&
              (x.founder === null || e.founder === x.founder) &&
              e.dmg === x.point,
          );
    if (i < 0 && found === null) continue;
    const prev = i < 0 ? null : next[i]!;
    const base = prev ?? {
      ...blankRecord(outcomeKey(found, e.prf), e.prf, now),
      found,
      source: "settlement" as const,
      founder: e.founder === "" ? null : e.founder,
    };
    const rec: RaidOutcomeRecord = {
      ...base,
      name: base.name === "?" ? e.prf : base.name,
      founder: base.founder ?? (e.founder === "" ? null : e.founder),
      point: e.dmg ?? base.point,
      outcome: got ? "got" : base.outcome === "pending" ? "pending" : "lost",
      rank: e.rank,
      rewards: flatRewards(e),
      received: e.received ?? null,
      settled: got ? now : base.settled,
      at: got ? decidedAt(prev, now) : base.at,
    };
    next = replaceAt(next, i, rec);
    changed++;
  }
  return { records: next, changed };
}

/** 留一個月：找規律要累積樣本，一天十幾筆，檔案不大。 */
const OUTCOME_KEEP_MS = 30 * 24 * 3600 * 1000;

export function pruneOutcomes(
  records: readonly RaidOutcomeRecord[],
  now: number,
): RaidOutcomeRecord[] {
  return records.filter((x) => now - x.at < OUTCOME_KEEP_MS);
}

/** 讀硬碟的一列：壞掉的回 null；少了的欄位（舊版寫的）當不知道。 */
function parseOutcomeRecord(x: Partial<Record<keyof RaidOutcomeRecord, unknown>>) {
  if (
    typeof x !== "object" ||
    x === null ||
    typeof x.key !== "string" ||
    typeof x.name !== "string" ||
    typeof x.point !== "number" ||
    (x.outcome !== "got" &&
      x.outcome !== "lost" &&
      x.outcome !== "none" &&
      x.outcome !== "pending") ||
    typeof x.at !== "number"
  ) {
    return null;
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  const found = num(x.found);
  const source = x.source;
  return {
    // 舊版的鍵是「名字@發現時刻」，換成發現時刻
    key: found !== null ? String(found) : x.key,
    name: x.name,
    monsterId: num(x.monsterId),
    level: num(x.level),
    rarity: num(x.rarity),
    stage: num(x.stage),
    category: str(x.category),
    mapIndex: num(x.mapIndex),
    founder: str(x.founder),
    mine: x.mine === true,
    point: x.point,
    outcome: x.outcome,
    source: source === "battle" || source === "settlement" || source === "log" ? source : "track",
    expectFrag: str(x.expectFrag),
    expectCoin: typeof x.expectCoin === "boolean" ? x.expectCoin : null,
    expectSrc: str(x.expectSrc),
    expectItems: strs(x.expectItems),
    found,
    limit: num(x.limit),
    death: num(x.death),
    deadSeen: num(x.deadSeen),
    gone: num(x.gone),
    settled: num(x.settled),
    hpMax: num(x.hpMax),
    rankCount: num(x.rankCount),
    myRank: num(x.myRank),
    topPoint: num(x.topPoint),
    refreshAfterDeath: num(x.refreshAfterDeath) ?? 0,
    asksAfterDeath: num(x.asksAfterDeath),
    emptyAsksAfterDeath: num(x.emptyAsksAfterDeath),
    battles: num(x.battles) ?? 0,
    firstBattleAt: num(x.firstBattleAt),
    lastBattleAt: num(x.lastBattleAt),
    rank: num(x.rank),
    rewards: strs(x.rewards),
    received: typeof x.received === "boolean" ? x.received : null,
    at: x.at,
  } satisfies RaidOutcomeRecord;
}

export function parseOutcomeRecords(value: unknown): RaidOutcomeRecord[] {
  const list = (value as { outcomes?: unknown } | null)?.outcomes;
  if (!Array.isArray(list)) return [];
  const out: RaidOutcomeRecord[] = [];
  for (const x of list as Partial<Record<keyof RaidOutcomeRecord, unknown>>[]) {
    const rec = parseOutcomeRecord(x);
    if (rec !== null) out.push(rec);
  }
  return out;
}

export interface RaidOutcomeTally {
  got: number;
  lost: number;
  none: number;
  /** 還在等結算的（不分哪天） */
  pending: number;
  /** 有分卻沒拿到的那幾個（看等級用） */
  lostRaids: RaidOutcomeRecord[];
}

/** 本機時區的「今天」（`now` 那一天）結束的渦各有幾個。 */
export function tallyToday(
  records: readonly RaidOutcomeRecord[],
  now: number,
  utcOffsetMin?: number,
): RaidOutcomeTally {
  const dayOf = (ms: number) => {
    const offset = utcOffsetMin ?? -new Date(ms).getTimezoneOffset();
    return new Date(ms + offset * 60_000).toISOString().slice(0, 10);
  };
  const today = dayOf(now);
  const t: RaidOutcomeTally = { got: 0, lost: 0, none: 0, pending: 0, lostRaids: [] };
  for (const x of records) {
    if (x.outcome === "pending") {
      t.pending++;
      continue;
    }
    if (dayOf(x.at) !== today) continue;
    t[x.outcome]++;
    if (x.outcome === "lost") t.lostRaids.push(x);
  }
  return t;
}

/**
 * 碎片對應的渦幣（渦I 排名給硬幣，顏色跟碎片一一對應，見 raid-treasure.ts）。
 */
const COIN_OF_FRAGMENT: Readonly<Record<string, string>> = {
  記憶的碎片: "鐵幣",
  時間的碎片: "銅幣",
  靈魂的碎片: "銀幣",
  生命的碎片: "金幣",
  死亡的碎片: "白金幣",
};

/** 渦房上標的預期獎勵：「死亡的碎片」／「白金幣」＋其他東西 */
export function expectLabel(
  x: Pick<RaidOutcomeRecord, "expectFrag" | "expectCoin" | "expectItems">,
): string {
  const frag =
    x.expectFrag === null
      ? null
      : x.expectCoin === true
        ? (COIN_OF_FRAGMENT[x.expectFrag] ?? `${x.expectFrag}（幣）`)
        : x.expectFrag;
  return [frag, ...x.expectItems].filter((s): s is string => s !== null && s !== "").join("＋");
}

/** 龍鯰 Lv1★1 stage 3（區塊7）預期 死亡的碎片 */
export function raidLabel(
  x: Pick<
    RaidOutcomeRecord,
    "name" | "level" | "rarity" | "stage" | "mapIndex" | "expectFrag" | "expectCoin" | "expectItems"
  >,
): string {
  const ex = expectLabel(x);
  return `${x.name} Lv${x.level ?? "?"}★${x.rarity ?? "?"} stage ${x.stage ?? "?"}（區塊${x.mapIndex ?? "?"}）${ex === "" ? "" : ` 預期 ${ex}`}`;
}

const EXPECT_SOURCE: Readonly<Record<string, string>> = {
  battle: "自己打時看到",
  title: "發現時看到",
  ulgg: "ulgg",
  feed: "公開渦通報",
  learned: "學到的表",
  map: "照區塊推",
};

/**
 * 渦結束那行後面接的：預期獎勵、榜、死後問過伺服器幾次、自己最後一場離死亡多久。
 * 沒有名字（發現者只存在 raid-outcomes.json）。
 */
export function formatOutcomeDetail(x: RaidOutcomeRecord): string {
  const parts: string[] = [];
  const ex = expectLabel(x);
  if (ex !== "") {
    const src = x.expectSrc === null ? "" : `（${EXPECT_SOURCE[x.expectSrc] ?? x.expectSrc}）`;
    parts.push(`預期 ${ex}${src}`);
  }
  if (x.rankCount !== null) {
    parts.push(`榜 ${x.rankCount} 人${x.myRank === null ? "" : `・自己第 ${x.myRank} 名`}`);
  }
  if (x.asksAfterDeath !== null) {
    parts.push(`死後要結算 ${x.asksAfterDeath} 次（整包空 ${x.emptyAsksAfterDeath ?? "?"} 次）`);
  }
  if (x.battles > 0) {
    const gap =
      x.death !== null && x.lastBattleAt !== null
        ? `、最後一場在死亡${x.lastBattleAt <= x.death ? "前" : "後"} ${Math.round(Math.abs(x.death - x.lastBattleAt) / 60_000)} 分`
        : "";
    parts.push(`自己打 ${x.battles} 場${gap}`);
  }
  return parts.length > 0 ? `｜${parts.join("｜")}` : "";
}

export function formatRaidTally(t: RaidOutcomeTally): string {
  const lost = t.lostRaids.map((x) => `${raidLabel(x)} ${x.point.toLocaleString("en-US")} 分`);
  return (
    `· 今天結束的渦：拿到獎勵 ${t.got}｜有分卻沒拿到 ${t.lost}｜本來就沒份 ${t.none}｜等結算 ${t.pending}` +
    (lost.length > 0 ? `（沒拿到：${lost.join("、")}）` : "")
  );
}

/** 判定為沒拿到的那一筆（打過的渦從清單消失又沒結算） */
export function formatVanished(x: RaidOutcomeRecord): string {
  const what = x.outcome === "none" ? "0 分又不是發現者，本來就沒份" : "有分卻沒等到結算";
  return `· 渦消失沒結算：${raidLabel(x)}｜${x.mine ? "自己開的" : "別人開的"}｜分數 ${x.point.toLocaleString("en-US")}｜自己打 ${x.battles} 場｜${what}`;
}

// ---------------------------------------------------------------------------
// 道具對帳：碎片、渦幣、抽獎券、異化礦材只會變多（玩家不消耗），數量落地跨離線比
// ---------------------------------------------------------------------------
//
// 頁面每次官方重讀道具清單（或剛裝上）就報一次這幾樣的數量（levels）。托盤記著上次的
// 數量，加上這段期間結算列了多少（expect），兩個一比：
//   進的 = 列的  → 對得上
//   進的 < 列的  → 結算列了卻沒入帳
//   進的 > 列的  → 有插件沒看到的結算（別台登入領的？）或別的來源
// 古代妙藥這類 AP 水玩家會用掉，不對帳。

export interface ItemLedger {
  /** 上次看到的數量 */
  levels: Record<string, { q: number; at: number }>;
  /** 上次看到之後，結算列了多少（還沒對過帳的） */
  expect: Record<string, number>;
  names: Record<string, string>;
}

export function emptyLedger(): ItemLedger {
  return { levels: {}, expect: {}, names: {} };
}

/** 結算到了：列的東西記進 expect（回報「領了」失敗的不算，伺服器還沒發） */
export function ledgerExpect(ledger: ItemLedger, entries: readonly RaidRewardEntry[]): ItemLedger {
  const expect = { ...ledger.expect };
  const names = { ...ledger.names };
  for (const e of entries) {
    if (e.received === false) continue;
    for (const it of e.items ?? []) {
      if (!RAID_LEDGER_WATCH.includes(it.key)) continue;
      expect[it.key] = (expect[it.key] ?? 0) + it.value;
      names[it.key] = it.name;
    }
  }
  return { ...ledger, expect, names };
}

export interface LedgerLine {
  key: string;
  name: string;
  /** 實際進了多少、結算列了多少 */
  got: number;
  listed: number;
}

/**
 * 頁面報了一份清單（`registry`）的數量：跟上次比。第一次看到的道具只記下來當起點。
 * 清單裡沒有的道具是 0（官方把數量 0 的列濾掉了）。
 */
export function ledgerLevels(
  ledger: ItemLedger,
  registry: string,
  levels: Readonly<Record<string, number>>,
  names: Readonly<Record<string, string>>,
  now: number,
): { ledger: ItemLedger; lines: LedgerLine[] } {
  const next: ItemLedger = {
    levels: { ...ledger.levels },
    expect: { ...ledger.expect },
    names: { ...ledger.names, ...names },
  };
  const lines: LedgerLine[] = [];
  for (const key of RAID_LEDGER_WATCH) {
    if (!key.startsWith(`${registry}:`)) continue;
    const q = levels[key] ?? 0;
    const prev = next.levels[key];
    next.levels[key] = { q, at: now };
    if (prev === undefined) continue;
    const got = q - prev.q;
    const listed = next.expect[key] ?? 0;
    delete next.expect[key];
    if (got !== 0 || listed !== 0) {
      lines.push({ key, name: next.names[key] ?? key, got, listed });
    }
  }
  return { ledger: next, lines };
}

export function formatLedger(registry: string, lines: readonly LedgerLine[]): string[] {
  if (lines.length === 0) return [];
  const ok = lines.filter((l) => l.got === l.listed);
  const out: string[] = [];
  if (ok.length > 0) {
    out.push(
      `· 道具對帳（${registry}）：${ok.map((l) => `${l.name} +${l.got}`).join("、")}，跟結算列的一樣`,
    );
  }
  for (const l of lines) {
    if (l.got === l.listed) continue;
    out.push(
      l.got < l.listed
        ? `⚠ 道具對帳（${registry}）：${l.name} 結算列了 ${l.listed}、只進了 ${l.got} —— 結算列了卻沒入帳`
        : `· 道具對帳（${registry}）：${l.name} 進了 ${l.got}、插件看到的結算只列 ${l.listed} —— 多的是別處來的（別台登入領的結算？）`,
    );
  }
  return out;
}

/** raid-outcomes.json 整份：每個渦的結果＋道具對帳 */
export interface RaidOutcomeState {
  outcomes: RaidOutcomeRecord[];
  ledger: ItemLedger;
}

export function parseOutcomeState(value: unknown): RaidOutcomeState {
  return { outcomes: parseOutcomeRecords(value), ledger: parseLedger(value) };
}

/** 讀硬碟的對帳狀態；壞掉的當沒有（下次重讀清單重新當起點）。 */
export function parseLedger(value: unknown): ItemLedger {
  const o = (value as { ledger?: unknown } | null)?.ledger as Partial<ItemLedger> | undefined;
  const out = emptyLedger();
  if (typeof o !== "object" || o === null) return out;
  for (const [k, v] of Object.entries(o.levels ?? {})) {
    const e = v as { q?: unknown; at?: unknown } | null;
    if (e && typeof e.q === "number" && typeof e.at === "number")
      out.levels[k] = { q: e.q, at: e.at };
  }
  for (const [k, v] of Object.entries(o.expect ?? {})) if (typeof v === "number") out.expect[k] = v;
  for (const [k, v] of Object.entries(o.names ?? {})) if (typeof v === "string") out.names[k] = v;
  return out;
}
