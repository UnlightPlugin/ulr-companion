/**
 * 渦 BOSS 身上的狀態：代碼 → 短標籤
 * ==================================
 * `db_raid` 每一列有 `state: [{type, turn}]`，客戶端**沒有畫出來**。
 * 代碼是戰鬥裡的狀態代碼加上可選的等級數字（`atkB3`、`poison2`）；
 * `turn` 對大多數狀態是**到期時刻（ms）**，對 `curse` 是剩幾回合。
 *
 * 表抄自 `unlight_crawler/src/script/ulr_raid_info.js` 的 `STATE_MAP`
 * （2026-09-13），標籤照 [[ulr-frontend-copy-style]] 縮到兩個字。
 *
 * ⚠ 伺服器**沒有講是誰上的**。`state` 只有 type/turn，要知道「誰上了恐懼」
 * 只能靠輪詢比對推測或另外共享 —— 不在這一份的範圍。
 */

export type RaidStatusKind = "debuff" | "buff" | "neutral";

export interface RaidStatusInfo {
  /** 代碼本體（不含等級數字） */
  code: string;
  /** 全名（tcn） */
  name: string;
  /** 畫在清單上的兩字標籤 */
  short: string;
  /** 對打的人是好是壞：BOSS 被減益是好事（綠）、BOSS 增益是壞事（紅） */
  kind: RaidStatusKind;
}

const S = (code: string, name: string, short: string, kind: RaidStatusKind): RaidStatusInfo => ({
  code,
  name,
  short,
  kind,
});

export const RAID_STATUSES: readonly RaidStatusInfo[] = [
  S("poison", "中毒", "中毒", "debuff"),
  S("poison2", "猛毒", "猛毒", "debuff"),
  S("mahi", "麻痺", "麻痺", "debuff"),
  S("atkB", "攻擊力增加", "攻↑", "buff"),
  S("atkD", "攻擊力減少", "攻↓", "debuff"),
  S("defB", "防禦力增加", "防↑", "buff"),
  S("defD", "防禦力減少", "防↓", "debuff"),
  S("movB", "移動力增加", "移↑", "buff"),
  S("movD", "移動力減少", "移↓", "debuff"),
  S("bers", "狂戰士", "狂戰", "buff"),
  S("stun", "暈眩", "暈眩", "debuff"),
  S("huin", "封印", "封印", "debuff"),
  S("jikai", "自壞", "自壞", "debuff"),
  S("immo", "不死", "不死", "buff"),
  S("scare", "恐懼", "恐懼", "debuff"),
  S("rege", "再生", "再生", "buff"),
  S("bind", "咒縛", "咒縛", "debuff"),
  S("chaos", "混沌", "混沌", "debuff"),
  S("stigma", "聖痕", "聖痕", "neutral"),
  S("dbuff", "能力低下", "低下", "debuff"),
  S("sticka", "棍術(攻)", "棍攻", "buff"),
  S("stickd", "棍術(防)", "棍防", "buff"),
  S("curse", "詛咒", "詛咒", "debuff"),
  S("critical", "臨界", "臨界", "neutral"),
  S("control", "操想", "操想", "debuff"),
  S("target", "標靶", "標靶", "debuff"),
  S("dark", "斷絕", "斷絕", "debuff"),
];

export const RAID_STATUS_BY_CODE: ReadonlyMap<string, RaidStatusInfo> = new Map(
  RAID_STATUSES.map((s) => [s.code, s]),
);

export const RAID_STATUS_COLORS: Record<RaidStatusKind, string> = {
  debuff: "#7ff2a0",
  buff: "#ff7b7b",
  neutral: "#e0e0e0",
};

export interface RaidStatusLabel {
  code: string;
  level: number | null;
  info: RaidStatusInfo | null;
  /** 畫出來的字：`麻痺`、`攻↑3`；認不得的代碼原樣印 */
  text: string;
  color: string;
}

/**
 * `"atkB3"` → 代碼 + 等級。`poison2` 是獨立的一種（猛毒），不是中毒 2 級 ——
 * 先查全名，查不到才拆數字。
 */
export function parseRaidStatusCode(raw: string): RaidStatusLabel {
  const whole = RAID_STATUS_BY_CODE.get(raw);
  if (whole !== undefined) {
    return {
      code: raw,
      level: null,
      info: whole,
      text: whole.short,
      color: RAID_STATUS_COLORS[whole.kind],
    };
  }
  const m = /^([A-Za-z]+)(\d+)$/.exec(raw);
  if (m !== null && m[1] !== undefined) {
    const base = m[1];
    const info = RAID_STATUS_BY_CODE.get(base) ?? null;
    const level = Number(m[2]);
    return {
      code: base,
      level,
      info,
      text: info === null ? raw : `${info.short}${level}`,
      color: info === null ? RAID_STATUS_COLORS.neutral : RAID_STATUS_COLORS[info.kind],
    };
  }
  return { code: raw, level: null, info: null, text: raw, color: RAID_STATUS_COLORS.neutral };
}
