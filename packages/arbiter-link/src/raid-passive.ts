/**
 * 渦 BOSS 的被動：現在開著哪一個
 * ===============================
 * 六隻 BOSS 的被動不是一直開著，是看**現實時間**或**渦的 HP** 決定（玩家 2026-10-04 要
 * Discord 與渦房都標出來）。伺服器不送「現在開哪個」，但規則是固定的，照算就知道。
 *
 * 規則抄原版 Unlight 開源伺服器（open-unlight/Unlight `app/server/src/model/chara_card.rb`
 * 的 `check_*_passive`），跟 fbtw wiki（w.atwiki.jp/unlight-fbtw/pages/310）的表一致：
 *
 * | 被動（PassiveSkills id）| BOSS        | 什麼時候開                                                  |
 * | ----------------------- | ----------- | ----------------------------------------------------------- |
 * | 硬化 11                 | 狗 mc1003   | `Time.now.min` 10–19、40–49                                 |
 * | 吸收 12                 | 狗 mc1003   | 分鐘 20–29、50–59（硬化開著就不開，兩段本來就不重疊）       |
 * | 潛伏地中 18             | 蟲 mc1006   | `max*3/5 >= hp && hp > max*2/5`（整數除法）                  |
 * | 濁濫的盡頭 19           | 蟲 mc1006   | `max*2/5 >= hp`（pow 7 那一支；pow 5 的是別的條件）         |
 * | 籠罩的夜霧 27           | 海 mc1007   | `max/2 >= hp`                                               |
 * | 隱身 35                 | 龜 mc1008   | `max/3 >= hp`                                               |
 * | 收穫 105                | W.M. mc1009 | `max/2 >= hp`（每回合抽 4 張，槍卡自己留、其他發給對手）    |
 * | 磁氣暴風 140            | 翔蟲 mc1013 | `max/2 >= hp` **而且對手也 ≤ 1/2**（同 19 的 pow 5 那一支） |
 *
 * 分鐘是伺服器本地時間的分鐘；日本／台灣與 UTC 差整數小時，所以直接拿 UTC 的分鐘。
 * 潛伏地中「受到一定傷害以後解除」是一場戰鬥裡的事，下一場開打又會開 —— 這裡標的是「開打會遇到的」。
 * 磁氣暴風只算得到 BOSS 那一半：標出來的意思是「你的角色 HP 也過半就會開」。
 *
 * 其他渦 BOSS 的被動不標（2026-10-04 全部看過）：千古不朽／連動是一直開著的；史萊姆外皮、海魔的心臟、
 * 神威、耐病抵抗、裝甲板、凝聚的精靈石、藍玉的龍麟、光冠是狀態抗性，也一直開著；
 * A.W.C.S.（惡魔之角）每回合隨機換防禦的距離，渦外看不出來。
 *
 * ⚠ 這一份**不 import 任何 Node 模組**：Worker 與插件共用。
 * ⚠ 渦房畫面（cdp-adapter `raid-passive.ts`）有一份同樣的表，改這裡要一起改（arbiter-engine 有測試對兩份）。
 */

/** 一條被動規則。`hpAtMost`／`hpAbove` 是 [分子, 分母]：`floor(max*分子/分母)` 跟 HP 比。 */
export interface RaidPassiveRule {
  /** PassiveSkills 的 id（CharaCards 的 `passive` 列的就是它） */
  id: number;
  /** Discord／渦房上的短字（≤2 字） */
  short: string;
  /** 現實時間制：分鐘落在這些 [起, 迄]（含兩端）時開 */
  minutes?: readonly (readonly [number, number])[];
  /** HP 制：`floor(max*分子/分母) >= hp` 時開 */
  hpAtMost?: readonly [number, number];
  /** 而且 `hp > floor(max*分子/分母)` */
  hpAbove?: readonly [number, number];
  /** 這個 id 開著時不開（吸收讓給硬化） */
  unless?: number;
}

export const RAID_PASSIVE_RULES: readonly RaidPassiveRule[] = [
  {
    id: 11,
    short: "硬化",
    minutes: [
      [10, 19],
      [40, 49],
    ],
  },
  {
    id: 12,
    short: "吸收",
    minutes: [
      [20, 29],
      [50, 59],
    ],
    unless: 11,
  },
  { id: 18, short: "潛伏", hpAtMost: [3, 5], hpAbove: [2, 5] },
  { id: 19, short: "濁濫", hpAtMost: [2, 5] },
  { id: 27, short: "夜霧", hpAtMost: [1, 2] },
  { id: 35, short: "隱身", hpAtMost: [1, 3] },
  { id: 105, short: "收穫", hpAtMost: [1, 2] },
  { id: 140, short: "磁暴", hpAtMost: [1, 2] },
];

/** BOSS 代碼的本體（`mc1003_02` → `mc1003`）→ 帶的被動（只列上面有規則的）。2026-10-04 實機 CharaCards。 */
const PASSIVES_BY_MONS: Record<string, readonly number[]> = {
  mc1003: [11, 12],
  mc1006: [18, 19],
  mc1007: [27],
  mc1008: [35],
  mc1009: [105],
  mc1013: [140],
};

/** 沒有代碼時（舊版插件傳的 SUPPORT）用名字認。繁簡都收。 */
const MONS_BY_NAME: Record<string, string> = {
  赤死獸: "mc1003",
  黑死獸: "mc1003",
  赤死兽: "mc1003",
  黑死兽: "mc1003",
  瘟疫: "mc1003",
  啃食者: "mc1006",
  屠殺者: "mc1006",
  屠杀者: "mc1006",
  爬行者: "mc1006",
  深沉之者: "mc1007",
  誘引之者: "mc1007",
  诱引之者: "mc1007",
  深奧之者: "mc1007",
  深奥之者: "mc1007",
  贔屭: "mc1008",
  赑屃: "mc1008",
  贔屓: "mc1008",
  靈龜: "mc1008",
  灵龟: "mc1008",
  玄帝: "mc1008",
  "W.M.貴族": "mc1009",
  "W.M.贵族": "mc1009",
  "W.M.公主": "mc1009",
  "W.M.王后": "mc1009",
  翔空蟲: "mc1013",
  翔空虫: "mc1013",
  翔天蟲: "mc1013",
  翔天虫: "mc1013",
  翔星蟲: "mc1013",
  翔星虫: "mc1013",
};

/** 這隻 BOSS 帶哪些有規則的被動。認不得回 `[]`。 */
export function raidPassiveIdsOf(r: { mons?: string | null; name: string | null }): number[] {
  const kind = r.mons?.split("_")[0] ?? (r.name !== null ? MONS_BY_NAME[r.name] : undefined);
  return [...((kind !== undefined ? PASSIVES_BY_MONS[kind] : undefined) ?? [])];
}

/** 開著的一個被動。`until` 是時間制的那一段結束的時刻（HP 制是 null）。 */
export interface RaidPassiveNow {
  id: number;
  short: string;
  until: number | null;
}

const MINUTE_MS = 60_000;

/** `now` 是第幾分（0–59，UTC；跟日本／台灣同一個分鐘）。 */
function minuteOf(now: number): number {
  return Math.floor(now / MINUTE_MS) % 60;
}

/**
 * 現在開著的被動（規則順序）。HP 不知道就不判斷 HP 制的；`now` 沒給就不判斷時間制的。
 * 死了（HP 0）什麼都不開。
 */
export function activeRaidPassives(
  ids: readonly number[],
  hp: number | null,
  hpMax: number | null,
  now?: number,
): RaidPassiveNow[] {
  if (hp !== null && hp <= 0) return [];
  const on = new Map<number, RaidPassiveNow>();
  for (const rule of RAID_PASSIVE_RULES) {
    if (!ids.includes(rule.id)) continue;
    if (rule.unless !== undefined && on.has(rule.unless)) continue;
    if (rule.minutes !== undefined) {
      if (now === undefined) continue;
      const min = minuteOf(now);
      const span = rule.minutes.find(([a, b]) => min >= a && min <= b);
      if (span === undefined) continue;
      const until = (Math.floor(now / MINUTE_MS) - min + span[1] + 1) * MINUTE_MS;
      on.set(rule.id, { id: rule.id, short: rule.short, until });
      continue;
    }
    if (hp === null || hpMax === null || rule.hpAtMost === undefined) continue;
    if (Math.floor((hpMax * rule.hpAtMost[0]) / rule.hpAtMost[1]) < hp) continue;
    if (
      rule.hpAbove !== undefined &&
      hp <= Math.floor((hpMax * rule.hpAbove[0]) / rule.hpAbove[1])
    ) {
      continue;
    }
    on.set(rule.id, { id: rule.id, short: rule.short, until: null });
  }
  return [...on.values()];
}

/**
 * 時間制的被動下一次換（開、關、換成另一個）的時刻；這隻 BOSS 沒有時間制的回 null。
 * Discord 訊息排在這一刻重畫。
 */
export function nextRaidPassiveChange(ids: readonly number[], now: number): number | null {
  const edges = new Set<number>();
  for (const rule of RAID_PASSIVE_RULES) {
    if (!ids.includes(rule.id) || rule.minutes === undefined) continue;
    for (const [a, b] of rule.minutes) edges.add(a).add((b + 1) % 60);
  }
  if (edges.size === 0) return null;
  const min = minuteOf(now);
  const hourStart = (Math.floor(now / MINUTE_MS) - min) * MINUTE_MS;
  let best: number | null = null;
  for (const e of edges) {
    const at = hourStart + (e > min ? e : e + 60) * MINUTE_MS;
    if (best === null || at < best) best = at;
  }
  return best;
}
