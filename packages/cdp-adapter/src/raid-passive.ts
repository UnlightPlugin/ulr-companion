/**
 * 渦 BOSS 的被動規則（渦房畫面用的那一份）
 * ========================================
 * 規則、出處、為什麼分鐘直接用 UTC 的，都寫在 `@ulr/arbiter-link` 的 `raid-passive.ts`
 * （Discord 那一份）。這裡是同一張表的複本：cdp-adapter 不依賴 arbiter-link，表要嵌進注入腳本。
 * **改一邊就要改另一邊**，arbiter-engine 的 `raid-passive-parity.test.ts` 會對兩份。
 *
 * 渦房不靠 BOSS 名認被動：清單列有 `monster_id`，`CharaCards` 那一列的 `passive` 就是它帶的
 * 被動 id，這裡只管「每個 id 什麼時候開」。
 */

export interface RaidPassiveRule {
  id: number;
  short: string;
  minutes?: readonly (readonly [number, number])[];
  hpAtMost?: readonly [number, number];
  hpAbove?: readonly [number, number];
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
  // 磁氣暴風：還要對手（打的那個人）的 HP 也 ≤ 1/2，這裡只算得到 BOSS 那一半
  { id: 140, short: "磁暴", hpAtMost: [1, 2] },
];

/** 被動標籤的字色（跟 BOSS 狀態的紅／綠分開：被動是固定的，不是誰上的）。 */
export const RAID_PASSIVE_COLOR = "#ffd166";
