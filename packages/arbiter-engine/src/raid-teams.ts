/**
 * 打渦隊伍：自己的紀錄怎麼整理、怎麼傳、別人的怎麼查
 * ================================================
 * 玩家 2026-09-13：「點玩家可以看得到打渦用的隊伍，若很多個隊伍，就用隊伍列表……
 * 最好能看到用哪些隊伍造成多少傷害，打了幾回合(花費了幾AP)，進入了戰鬥幾次。」
 * 「預設開啟分享使用的隊伍，因為在對戰房也是看得到其他房間使用的牌組的。」
 *
 * ```
 *   頁面 raid-battle（一場）──▶ 引擎 #raidBattles（托盤存硬碟）
 *                                   │ aggregateTeams：同一副牌合成一支
 *                                   ├──▶ POST /raid-teams（渦、名字都只傳雜湊）
 *   自己渦清單上的名字 ──▶ GET /raid-teams ─┤
 *                                   ▼
 *                     渦 → 名字 → 隊伍 ──▶ setTeams 推回頁面
 * ```
 *
 * 「渦」是發現者＋發現時刻（`raidTeamRef`，頁面拼的是同一個字串）—— 改版後別人開的渦
 * 沒有渦碼。看板與雜湊的理由在 `@ulr/arbiter-link/raid-share`。
 *
 * ## 為什麼自己的紀錄要存硬碟
 *
 * 看板上同一個人同一個渦是**整份取代**。只存記憶體的話，托盤一重開、下一輪上傳就是
 * 一份空的（或只剩重開後打的那幾場），把之前傳上去的蓋掉。
 *
 * ## 自己的名字永遠用本機的
 *
 * 雲端那份最多慢 30 秒，而且關了分享就沒有 —— 自己剛打完就該看得到自己那一場。
 */

import type { SharedTeam, SharedTeamsUpload } from "@ulr/arbiter-link";
import {
  DEFAULT_RAID_TEAMS_URL,
  MAX_RAID_SHARE_KEYS,
  MAX_RAID_TEAM_ENTRIES_PER_POST,
  MAX_RAID_TEAMS_PER_PLAYER,
  raidPlayerKey,
  raidTeamKey,
  raidTeamRef,
} from "@ulr/arbiter-link";
import type {
  RaidBattleReport,
  RaidDeckContent,
  RaidSnapshotRow,
  RaidTeamsMap,
  RaidTeamView,
} from "@ulr/cdp-adapter";
import { DEFAULT_RAID_PUBLIC_TIMEOUT_MS, type FetchLike, withTimeout } from "./raid-public.js";

/** 一場的紀錄（頁面回報的那一則去掉 type）。 */
export type RaidBattleRecord = Omit<RaidBattleReport, "type">;

/** 本機最多留幾場。渦幾個小時就過期，正常玩遠到不了。 */
export const MAX_RAID_BATTLE_RECORDS = 1_000;

export function toBattleRecord(report: RaidBattleReport): RaidBattleRecord {
  const { type: _type, ...rest } = report;
  return rest;
}

/**
 * 檔案讀回來的東西 → 乾淨的紀錄。形狀不對的丟掉（改版前用渦碼 `code` 的舊紀錄也在這裡丟掉，
 * 那些渦早就過期了）。
 */
export function parseBattleRecords(raw: unknown): RaidBattleRecord[] {
  const list = (raw as { battles?: unknown } | null)?.battles;
  if (!Array.isArray(list)) return [];
  const out: RaidBattleRecord[] = [];
  for (const r of list) {
    const o = r as Record<string, unknown> | null;
    const d = o?.deck as Record<string, unknown> | null | undefined;
    if (
      o === null ||
      typeof o !== "object" ||
      typeof o.raid !== "string" ||
      typeof o.player !== "string" ||
      typeof o.limit !== "number" ||
      typeof o.turns !== "number" ||
      typeof o.ap !== "number" ||
      typeof o.damage !== "number" ||
      typeof o.points !== "number" ||
      typeof o.at !== "number" ||
      d === null ||
      d === undefined ||
      !Array.isArray(d.chara) ||
      !Array.isArray(d.charaIndex) ||
      !Array.isArray(d.weapon) ||
      !Array.isArray(d.eventIndex)
    ) {
      continue;
    }
    out.push({
      raid: o.raid,
      player: o.player,
      limit: o.limit,
      turns: o.turns,
      ap: o.ap,
      damage: o.damage,
      points: o.points,
      at: o.at,
      deck: {
        chara: d.chara as (string | null)[],
        charaIndex: d.charaIndex as (number | null)[],
        weapon: d.weapon as (number | null)[],
        eventIndex: d.eventIndex as (number | null)[],
      },
    });
  }
  return out;
}

/**
 * 收一場進來。同一個渦、同一個人、同一個開打時刻 = 同一場的補報（分數晚到），取代舊的那筆。
 * 回傳新清單與「是不是補報」。
 */
export function upsertBattle(
  records: readonly RaidBattleRecord[],
  record: RaidBattleRecord,
): { records: RaidBattleRecord[]; updated: boolean } {
  const same = (r: RaidBattleRecord) =>
    r.raid === record.raid && r.player === record.player && r.at === record.at;
  const updated = records.some(same);
  return {
    records: updated ? records.map((r) => (same(r) ? record : r)) : [...records, record],
    updated,
  };
}

/** 過期的渦丟掉、超過上限丟最舊的。 */
export function pruneBattles(
  records: readonly RaidBattleRecord[],
  now: number,
): RaidBattleRecord[] {
  const alive = records.filter((r) => r.limit > now);
  return alive.length > MAX_RAID_BATTLE_RECORDS
    ? alive.slice(alive.length - MAX_RAID_BATTLE_RECORDS)
    : alive;
}

/** 同一副牌的判準：27 格全部一樣。 */
function deckSignature(d: RaidDeckContent): string {
  return JSON.stringify([d.chara, d.charaIndex, d.weapon, d.eventIndex]);
}

/** 一個人在一個渦的紀錄 → 隊伍（同一副合成一支），傷害高的在前、最多 12 支。 */
export function aggregateTeams(records: readonly RaidBattleRecord[]): RaidTeamView[] {
  const bySig = new Map<string, RaidTeamView>();
  for (const r of records) {
    const sig = deckSignature(r.deck);
    let t = bySig.get(sig);
    if (t === undefined) {
      t = {
        chara: [...r.deck.chara],
        charaIndex: [...r.deck.charaIndex],
        weapon: [...r.deck.weapon],
        eventIndex: [...r.deck.eventIndex],
        battles: 0,
        turns: 0,
        ap: 0,
        damage: 0,
        best: 0,
        points: 0,
      };
      bySig.set(sig, t);
    }
    t.battles += 1;
    t.turns += r.turns;
    t.ap += r.ap;
    t.damage += r.damage;
    t.points += r.points;
    t.best = Math.max(t.best, r.damage);
  }
  return [...bySig.values()]
    .sort((a, b) => b.damage - a.damage)
    .slice(0, MAX_RAID_TEAMS_PER_PLAYER);
}

/** 本機紀錄 → 渦 → 名字 → 隊伍。 */
export function localTeamsMap(records: readonly RaidBattleRecord[]): RaidTeamsMap {
  const groups = new Map<string, Map<string, RaidBattleRecord[]>>();
  for (const r of records) {
    let byName = groups.get(r.raid);
    if (byName === undefined) groups.set(r.raid, (byName = new Map()));
    const list = byName.get(r.player);
    if (list === undefined) byName.set(r.player, [r]);
    else list.push(r);
  }
  const out: RaidTeamsMap = {};
  for (const [raid, byName] of groups) {
    out[raid] = {};
    for (const [name, list] of byName) out[raid][name] = aggregateTeams(list);
  }
  return out;
}

/** 雲端查到的 ＋ 本機的：本機有的名字用本機的。 */
export function mergeTeamsMaps(cloud: RaidTeamsMap, local: RaidTeamsMap): RaidTeamsMap {
  const out: RaidTeamsMap = {};
  for (const [raid, byName] of Object.entries(cloud)) out[raid] = { ...byName };
  for (const [raid, byName] of Object.entries(local)) out[raid] = { ...out[raid], ...byName };
  return out;
}

/**
 * 要上傳的那幾筆。`retract` 為 true 時每一筆傳空的隊伍 —— 看板收到空的就把那個人拿掉
 * （玩家剛把分享關掉時用）。
 */
export async function buildTeamUploads(
  records: readonly RaidBattleRecord[],
  retract = false,
): Promise<SharedTeamsUpload[]> {
  const out: SharedTeamsUpload[] = [];
  const local = localTeamsMap(records);
  for (const [raid, byName] of Object.entries(local)) {
    const key = await raidTeamKey(raid);
    for (const [name, teams] of Object.entries(byName)) {
      const limit = Math.max(
        ...records.filter((r) => r.raid === raid && r.player === name).map((r) => r.limit),
      );
      out.push({
        key,
        player: await raidPlayerKey(raid, name),
        limit,
        teams: retract ? [] : (teams as SharedTeam[]),
      });
    }
  }
  return out;
}

/** 傳上去，分批。回傳雲端收下幾筆；失敗的那批算 0。 */
export async function uploadRaidTeams(
  entries: readonly SharedTeamsUpload[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = DEFAULT_RAID_TEAMS_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < entries.length; i += MAX_RAID_TEAM_ENTRIES_PER_POST) {
    const body = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(url, {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: entries.slice(i, i + MAX_RAID_TEAM_ENTRIES_PER_POST) }),
      }),
    );
    const n = (body as { accepted?: unknown } | null)?.accepted;
    if (typeof n === "number") accepted += n;
  }
  return accepted;
}

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 拿自己渦清單上的渦去查：發現者＋發現時刻算渦 key、榜上每個名字算玩家 key，對得上的才收。
 * 查回來的表以 `raidTeamRef` 當鍵（頁面拼同一個字串去找）。**任何失敗都回空表**。
 */
export async function lookupRaidTeams(
  rows: readonly Pick<RaidSnapshotRow, "founder" | "foundAt" | "players">[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  url: string = DEFAULT_RAID_TEAMS_URL,
  timeoutMs: number = DEFAULT_RAID_PUBLIC_TIMEOUT_MS,
): Promise<RaidTeamsMap> {
  const out: RaidTeamsMap = {};
  const byKey = new Map<string, { raid: string; names: Map<string, string> }>();
  for (const r of rows) {
    if (typeof r.founder !== "string" || typeof r.foundAt !== "number" || r.players.length === 0) {
      continue;
    }
    const raid = raidTeamRef(r.founder, r.foundAt);
    const names = new Map<string, string>();
    for (const n of r.players) names.set(await raidPlayerKey(raid, n), n);
    byKey.set(await raidTeamKey(raid), { raid, names });
  }
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += MAX_RAID_SHARE_KEYS) {
    const chunk = keys.slice(i, i + MAX_RAID_SHARE_KEYS);
    const body = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${url}?keys=${chunk.join(",")}`, { signal }),
    );
    const raids = (body as { raids?: unknown } | null)?.raids;
    if (!Array.isArray(raids)) continue;
    for (const raw of raids) {
      const raid = raw as { key?: unknown; players?: unknown } | null;
      const hit = typeof raid?.key === "string" ? byKey.get(raid.key) : undefined;
      if (hit === undefined || !Array.isArray(raid?.players)) continue;
      for (const p of raid.players as { player?: unknown; teams?: unknown }[]) {
        const name = typeof p?.player === "string" ? hit.names.get(p.player) : undefined;
        if (name === undefined || !Array.isArray(p.teams) || p.teams.length === 0) continue;
        const teams: RaidTeamView[] = [];
        for (const t of p.teams as Record<string, unknown>[]) {
          if (
            !Array.isArray(t?.chara) ||
            !Array.isArray(t.charaIndex) ||
            !Array.isArray(t.weapon) ||
            !Array.isArray(t.eventIndex)
          ) {
            continue;
          }
          teams.push({
            chara: t.chara as (string | null)[],
            charaIndex: t.charaIndex as (number | null)[],
            weapon: t.weapon as (number | null)[],
            eventIndex: t.eventIndex as (number | null)[],
            battles: numberOr0(t.battles),
            turns: numberOr0(t.turns),
            ap: numberOr0(t.ap),
            damage: numberOr0(t.damage),
            best: numberOr0(t.best),
            points: numberOr0(t.points),
          });
        }
        if (teams.length === 0) continue;
        (out[hit.raid] ??= {})[name] = teams;
      }
    }
  }
  return out;
}
