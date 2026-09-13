/**
 * 渦的獎勵表：Treasure Level → 發現／參加／排名／擊破獎勵
 * =====================================================
 * 渦碼分享頻道講的「藍龜」「紅蟲」「書籤妖」是在講**排名獎勵是哪一種碎片**。
 * 伺服器在 `db_raid` 每一列都給 `treasure_level`（TL），但客戶端**從來沒讀過**
 * 它 —— 畫面上只有名字、HP、剩餘時間、參加人數。獎勵是什麼要等渦被打倒、
 * 結算面板一頁一頁翻出來才看得到。
 *
 * ## 表從哪來
 *
 * ulgg.online 的 raid_observer 頁有 TL 查詢（伺服器端渲染），2026-09-13 整批
 * 掃過 1–3000，**只有 60 個 TL 有資料**：2009–2013、2076–2120、2157–2166，
 * 全是渦II/III。渦I／渦IV 那邊沒有表，所以那些只能退回公式（見下）。
 *
 * 讀出來的規律（跟 `unlight_crawler/src/script/ulr_raid_info.js` 的公式一致）：
 *
 * ```
 *   ★1：碎片 = stage % 5          （1 黃 2 綠 3 藍 4 紅 0 紫）
 *   ★6：碎片 = (stage + 1) % 5    而且排名獎勵多一樣武器素材
 *   妖精（mc1004，★6）：stage 一律 3，公式算出來全是紅 —— **是錯的**，
 *                      五個顏色都有，只能查表；2096–2099 的最大獎是書籤
 * ```
 *
 * 所以 `classifyRaid()` 的順序是：**有表就查表，沒表才套公式**。
 *
 * ## 三種特殊標記
 *
 * | 標記      | 條件                               | 用色 |
 * | --------- | ---------------------------------- | ---- |
 * | 書籤 raid | 排名獎勵裡有 `記憶的書籤(R1)`      | 白   |
 * | 素材 raid | 排名獎勵裡有 `魔之刀身／戒指／彈頭／手鐲` | 黑   |
 * | 妖精      | `profound_mons` 是 `mc1004`        | 另加星號 |
 *
 * 玩家 2026-09-13 訂的：碎片色是主色，素材黑、書籤白「加一部分」碎片色；
 * 自己開的渦另外用紅框。
 *
 * ⚠ 這份表是**快照**，官方換獎勵表時要重抓（`tools/scrape-raid-treasure.mjs`）。
 * 查不到的 TL 不會壞掉，只是退回公式、沒有素材／書籤標記。
 */

/** 五種碎片。`code` 是公式 `% 5` 的餘數（1 黃 … 0 紫）。 */
export type RaidFragment = "memory" | "time" | "soul" | "life" | "death";

export interface RaidFragmentInfo {
  key: RaidFragment;
  /** 公式餘數 */
  code: number;
  /** 道具名（tcn，跟結算面板一樣） */
  item: string;
  /** 渦碼頻道的單字 */
  short: string;
  /** 畫在遊戲裡的顏色（Phaser tint） */
  tint: number;
  /** 網頁端用的 CSS 色 */
  css: string;
}

export const RAID_FRAGMENTS: readonly RaidFragmentInfo[] = [
  { key: "memory", code: 1, item: "記憶的碎片", short: "黃", tint: 0xf5d33a, css: "#f5d33a" },
  { key: "time", code: 2, item: "時間的碎片", short: "綠", tint: 0x3ec95a, css: "#3ec95a" },
  { key: "soul", code: 3, item: "靈魂的碎片", short: "藍", tint: 0x3a8cff, css: "#3a8cff" },
  { key: "life", code: 4, item: "生命的碎片", short: "紅", tint: 0xe63c3c, css: "#e63c3c" },
  { key: "death", code: 0, item: "死亡的碎片", short: "紫", tint: 0xa855f7, css: "#a855f7" },
];

export const FRAGMENT_BY_ITEM: ReadonlyMap<string, RaidFragmentInfo> = new Map(
  RAID_FRAGMENTS.map((f) => [f.item, f]),
);

export const FRAGMENT_BY_CODE: ReadonlyMap<number, RaidFragmentInfo> = new Map(
  RAID_FRAGMENTS.map((f) => [f.code, f]),
);

export const FRAGMENT_BY_KEY: ReadonlyMap<RaidFragment, RaidFragmentInfo> = new Map(
  RAID_FRAGMENTS.map((f) => [f.key, f]),
);

/**
 * 渦I 的排名獎勵是硬幣不是碎片，顏色對應照玩家 2026-09-13 訂的：
 * 鐵幣＝黃、銅幣＝綠、銀幣＝藍、金幣＝紅、白金幣＝紫 —— 跟渦II/III 表上
 * 31–60 名那一格的硬幣完全一致（黃碎的渦給鐵幣、紫碎的渦給白金幣），
 * 所以公式的餘數可以直接共用，只是畫成硬幣而不是碎片。
 */
export const RAID_COIN_BY_FRAGMENT: Readonly<Record<RaidFragment, string>> = {
  memory: "鐵幣",
  time: "銅幣",
  soul: "銀幣",
  life: "金幣",
  death: "白金幣",
};

/** 排名獎勵裡會出現的武器素材。有其中一樣就是「素材渦」。 */
export const RAID_MATERIAL_ITEMS: readonly string[] = [
  "魔之刀身",
  "魔之戒指",
  "魔之彈頭",
  "魔之手鐲",
];

/** 書籤。有這個就是「書籤渦」—— 頻道裡的最大獎。 */
export const RAID_BOOKMARK_ITEM = "記憶的書籤(R1)";

/** 妖精（魔性的鱗粉）的 mons 代號前綴。 */
export const RAID_FAIRY_MONS = "mc1004";

/** 素材渦／書籤渦的用色（玩家訂的：素材黑、書籤白）。 */
export const RAID_SPECIAL_TINT = {
  material: 0x1a1a1a,
  bookmark: 0xffffff,
} as const;

/** 自己開的渦：紅框。 */
export const RAID_OWN_FRAME_TINT = 0xe62020;

export interface RaidRewardItem {
  item: string;
  qty: number;
  /** 只有排名獎勵有 */
  rankMin?: number;
  rankMax?: number;
}

export interface RaidTreasureEntry {
  tl: number;
  /** `profound_mons`；妖精只有前綴 `mc1004` */
  mons: string;
  rarity: number;
  /** = `db_raid` 的 `stage` */
  stage: number;
  discovery: RaidRewardItem[];
  participation: RaidRewardItem[];
  ranking: RaidRewardItem[];
  defeat: RaidRewardItem[];
}

/**
 * 一列 = `[tl, mons, rarity, stage, 發現, 參加, 排名, 擊破]`，
 * 獎勵欄的格式是 `道具×數量[@名次起-名次迄]`，逗號分隔。
 *
 * 來源：ulgg.online/pages/raid_observer.php?raid_lookup=<TL>，2026-09-13 抓的。
 */
type Row = readonly [number, string, number, number, string, string, string, string];

// prettier-ignore
const ROWS: readonly Row[] = [
  [2009, "mc1004", 6, 3, "抽獎券(免費)×3,魔之刀身×1", "跳越星×1", "記憶的碎片×2@1-15,魔之刀身×2@1-15,記憶的碎片×1@16-30,鐵幣×1@31-60", "特製蘑菇萃取液×1"],
  [2010, "mc1004", 6, 3, "魔之戒指×1,抽獎券(免費)×3", "跳越星×1", "時間的碎片×2@1-15,魔之戒指×2@1-15,時間的碎片×1@16-30,銅幣×1@31-60", "特製蘑菇萃取液×1"],
  [2011, "mc1004", 6, 3, "魔之彈頭×1,抽獎券(免費)×3", "跳越星×1", "靈魂的碎片×2@1-15,靈魂的碎片×1@16-30,銀幣×1@31-60,魔之彈頭×2@1-15", "特製蘑菇萃取液×1"],
  [2012, "mc1004", 6, 3, "魔之手鐲×1,抽獎券(免費)×3", "跳越星×1", "生命的碎片×2@1-15,魔之手鐲×2@1-15,生命的碎片×1@16-30,金幣×1@31-60", "特製蘑菇萃取液×1"],
  [2013, "mc1004", 6, 3, "魔之手鐲×1,抽獎券(免費)×3", "跳越星×1", "死亡的碎片×2@1-15,魔之手鐲×2@1-15,死亡的碎片×1@16-30,白金幣×1@31-60", "特製蘑菇萃取液×1"],
  [2076, "mc1003_02", 1, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,記憶的碎片×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2077, "mc1003_02", 1, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,時間的碎片×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2078, "mc1003_02", 1, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,靈魂的碎片×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2079, "mc1003_02", 1, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,生命的碎片×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2080, "mc1003_02", 1, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,死亡的碎片×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2081, "mc1006_02", 1, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,記憶的碎片×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2082, "mc1006_02", 1, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,時間的碎片×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2083, "mc1006_02", 1, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,靈魂的碎片×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2084, "mc1006_02", 1, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,生命的碎片×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2085, "mc1006_02", 1, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,死亡的碎片×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2086, "mc1007_02", 1, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,記憶的碎片×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2087, "mc1007_02", 1, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,時間的碎片×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2088, "mc1007_02", 1, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,靈魂的碎片×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2089, "mc1007_02", 1, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,生命的碎片×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2090, "mc1007_02", 1, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,死亡的碎片×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2091, "mc1008_02", 1, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,記憶的碎片×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2092, "mc1008_02", 1, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,時間的碎片×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2093, "mc1008_02", 1, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,靈魂的碎片×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2094, "mc1008_02", 1, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,生命的碎片×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2095, "mc1008_02", 1, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,死亡的碎片×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2096, "mc1004", 6, 3, "魔之刀身×2,抽獎券(免費)×3", "跳越星×1", "記憶的碎片×1@1-15,記憶的書籤(R1)×1@1-15,記憶的碎片×1@16-50", "特製蘑菇萃取液×1"],
  [2097, "mc1004", 6, 3, "魔之戒指×1,抽獎券(免費)×3", "跳越星×1", "時間的碎片×1@1-15,記憶的書籤(R1)×1@1-15,時間的碎片×1@16-50", "特製蘑菇萃取液×1"],
  [2098, "mc1004", 6, 3, "魔之彈頭×1,抽獎券(免費)×3", "幸運四葉草×1", "記憶的書籤(R1)×1@1-15,靈魂的碎片×1@1-15,靈魂的碎片×1@16-50", "魔女秘藥×3"],
  [2099, "mc1004", 6, 3, "魔之手鐲×1,抽獎券(免費)×3", "跳越星×1", "生命的碎片×1@1-50,記憶的書籤(R1)×1@1-15", "特製蘑菇萃取液×1"],
  [2100, "mc1004", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之刀身×2@1-10,記憶的碎片×1@11-30,魔之刀身×1@11-30", "魔女秘藥×1"],
  [2101, "mc1003_02", 6, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,魔之刀身×2@1-10,時間的碎片×1@11-30,魔之刀身×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2102, "mc1003_02", 6, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,魔之刀身×2@1-10,靈魂的碎片×1@11-30,魔之刀身×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2103, "mc1003_02", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,魔之刀身×2@1-10,生命的碎片×1@11-30,魔之刀身×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2104, "mc1003_02", 6, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,魔之刀身×2@1-10,死亡的碎片×1@11-30,魔之刀身×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2105, "mc1003_02", 6, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之刀身×2@1-10,記憶的碎片×1@11-30,魔之刀身×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2106, "mc1006_02", 6, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,魔之戒指×2@1-10,時間的碎片×1@11-30,魔之戒指×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2107, "mc1006_02", 6, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,魔之戒指×2@1-10,靈魂的碎片×1@11-30,魔之戒指×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2108, "mc1006_02", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,魔之戒指×2@1-10,生命的碎片×1@11-30,魔之戒指×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2109, "mc1006_02", 6, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,魔之戒指×2@1-10,死亡的碎片×1@11-30,魔之戒指×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2110, "mc1006_02", 6, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之戒指×2@1-10,記憶的碎片×1@11-30,魔之戒指×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2111, "mc1007_02", 6, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,魔之彈頭×2@1-10,時間的碎片×1@11-30,魔之彈頭×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2112, "mc1007_02", 6, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,魔之彈頭×2@1-10,靈魂的碎片×1@11-30,魔之彈頭×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2113, "mc1007_02", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,魔之彈頭×2@1-10,生命的碎片×1@11-30,魔之彈頭×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2114, "mc1007_02", 6, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,魔之彈頭×2@1-10,死亡的碎片×1@11-30,魔之彈頭×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2115, "mc1007_02", 6, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之彈頭×2@1-10,記憶的碎片×1@11-30,魔之彈頭×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2116, "mc1008_02", 6, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,魔之手鐲×2@1-10,時間的碎片×1@11-30,魔之手鐲×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2117, "mc1008_02", 6, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,魔之手鐲×2@1-10,靈魂的碎片×1@11-30,魔之手鐲×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2118, "mc1008_02", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,魔之手鐲×2@1-10,生命的碎片×1@11-30,魔之手鐲×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2119, "mc1008_02", 6, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,魔之手鐲×2@1-10,死亡的碎片×1@11-30,魔之手鐲×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2120, "mc1008_02", 6, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之手鐲×2@1-10,記憶的碎片×1@11-30,魔之手鐲×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2157, "mc1012_02", 1, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,記憶的碎片×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
  [2158, "mc1012_02", 1, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,時間的碎片×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2159, "mc1012_02", 1, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,靈魂的碎片×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2160, "mc1012_02", 1, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,生命的碎片×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2161, "mc1012_02", 1, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,死亡的碎片×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2162, "mc1012_02", 6, 1, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "時間的碎片×2@1-10,魔之手鐲×2@1-10,時間的碎片×1@11-30,魔之手鐲×1@11-30,銅幣×1@31-60", "魔女秘藥×1"],
  [2163, "mc1012_02", 6, 2, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "靈魂的碎片×2@1-10,魔之手鐲×2@1-10,靈魂的碎片×1@11-30,魔之手鐲×1@11-30,銀幣×1@31-60", "魔女秘藥×1"],
  [2164, "mc1012_02", 6, 3, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "生命的碎片×2@1-10,魔之手鐲×2@1-10,生命的碎片×1@11-30,魔之手鐲×1@11-30,金幣×1@31-60", "魔女秘藥×1"],
  [2165, "mc1012_02", 6, 4, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "死亡的碎片×2@1-10,魔之手鐲×2@1-10,死亡的碎片×1@11-30,魔之手鐲×1@11-30,白金幣×1@31-60", "魔女秘藥×1"],
  [2166, "mc1012_02", 6, 5, "異化礦材×1,抽獎券(免費)×3", "古代妙藥×2", "記憶的碎片×2@1-10,魔之手鐲×2@1-10,記憶的碎片×1@11-30,魔之手鐲×1@11-30,鐵幣×1@31-60", "魔女秘藥×1"],
];

function parseItems(field: string): RaidRewardItem[] {
  if (field === "") return [];
  return field.split(",").map((raw) => {
    const m = /^(.+?)×(\d+)(?:@(\d+)-(\d+))?$/.exec(raw);
    if (m === null || m[1] === undefined) throw new Error(`獎勵欄格式不對：${raw}`);
    const item: RaidRewardItem = { item: m[1], qty: Number(m[2]) };
    if (m[3] !== undefined) {
      item.rankMin = Number(m[3]);
      item.rankMax = Number(m[4]);
    }
    return item;
  });
}

function parseRow(row: Row): RaidTreasureEntry {
  return {
    tl: row[0],
    mons: row[1],
    rarity: row[2],
    stage: row[3],
    discovery: parseItems(row[4]),
    participation: parseItems(row[5]),
    ranking: parseItems(row[6]),
    defeat: parseItems(row[7]),
  };
}

export const RAID_TREASURE_TABLE: ReadonlyMap<number, RaidTreasureEntry> = new Map(
  ROWS.map((row) => {
    const entry = parseRow(row);
    return [entry.tl, entry];
  }),
);

export function lookupRaidTreasure(tl: number | null | undefined): RaidTreasureEntry | null {
  if (typeof tl !== "number") return null;
  return RAID_TREASURE_TABLE.get(tl) ?? null;
}

/** 分類要看的欄位 —— 全都是 `db_raid` 每一列本來就有的。 */
export interface RaidClassifyInput {
  treasure_level?: number | null;
  rarity?: number | null;
  stage?: number | null;
  profound_mons?: string | null;
}

export interface RaidClass {
  /** 排名獎勵的碎片。查不出來是 null。 */
  fragment: RaidFragmentInfo | null;
  /** 素材渦／書籤渦。兩者都有時書籤優先（最大獎）。 */
  special: "material" | "bookmark" | null;
  /** 排名獎勵裡有抽獎券（玩家 2026-09-13：也要標） */
  ticket: boolean;
  /** 渦I 畫硬幣，其餘畫碎片；顏色共用 `fragment` */
  rewardKind: "fragment" | "coin";
  /** 妖精（魔性的鱗粉） */
  fairy: boolean;
  /** 渦I／渦II·III／渦IV。認不出來是 null。渦IV 要加亮、白框。 */
  tier: RaidTier | null;
  /** 碎片是查表得來、還是套公式、還是完全不知道 */
  source: "table" | "formula" | "none";
  entry: RaidTreasureEntry | null;
}

export type RaidTier = 1 | 23 | 4;

/** 排名獎勵裡的抽獎券。表裡目前只出現在發現獎勵，渦IV 的排名獎勵才有。 */
export const RAID_TICKET_PREFIX = "抽獎券";

/**
 * 這是渦幾。抄 `Moon/打渦.py` 的 渦階()：`profound_mons` 的 `_01/_02/_03`
 * 是 渦I／渦II·III／渦IV；妖精兩邊都會出現，靠 rarity 分（II/III 是 ★6、
 * IV 是 ★5）；吸血女王（mc1005）只有渦I。
 */
export function raidTierOf(
  mons: string | null | undefined,
  rarity: number | null | undefined,
): RaidTier | null {
  if (typeof mons !== "string") return null;
  const [kind, stageRaw] = mons.split("_");
  if (kind === RAID_FAIRY_MONS) return rarity === 5 ? 4 : 23;
  if (kind === "mc1005") return 1;
  switch (stageRaw) {
    case "01":
      return 1;
    case "02":
      return 23;
    case "03":
      return 4;
    default:
      return null;
  }
}

export function ticketOfEntry(entry: RaidTreasureEntry): boolean {
  return entry.ranking.some((r) => r.item.startsWith(RAID_TICKET_PREFIX));
}

/** 公式：★6 是 `(stage+1) % 5`，其餘 `stage % 5`。對妖精是錯的，呼叫端要擋。 */
export function fragmentByFormula(
  rarity: number | null | undefined,
  stage: number | null | undefined,
): RaidFragmentInfo | null {
  if (typeof rarity !== "number" || typeof stage !== "number") return null;
  const code = (rarity === 6 ? stage + 1 : stage) % 5;
  return FRAGMENT_BY_CODE.get(code) ?? null;
}

/** 排名獎勵裡第一個碎片。表裡每個 TL 都只有一種碎片。 */
export function fragmentOfEntry(entry: RaidTreasureEntry): RaidFragmentInfo | null {
  for (const r of entry.ranking) {
    const f = FRAGMENT_BY_ITEM.get(r.item);
    if (f !== undefined) return f;
  }
  return null;
}

export function specialOfEntry(entry: RaidTreasureEntry): "material" | "bookmark" | null {
  if (entry.ranking.some((r) => r.item === RAID_BOOKMARK_ITEM)) return "bookmark";
  if (entry.ranking.some((r) => RAID_MATERIAL_ITEMS.includes(r.item))) return "material";
  return null;
}

export function isFairyMons(mons: string | null | undefined): boolean {
  return typeof mons === "string" && mons.startsWith(RAID_FAIRY_MONS);
}

/**
 * 一列 `db_raid` → 該畫什麼。**有表查表，沒表才套公式**；妖精沒表就是不知道
 * （公式對牠是錯的，寧可不畫也不要畫錯色）。
 */
export function classifyRaid(input: RaidClassifyInput): RaidClass {
  const fairy = isFairyMons(input.profound_mons);
  const tier = raidTierOf(input.profound_mons, input.rarity);
  const entry = lookupRaidTreasure(input.treasure_level);
  const rewardKind = tier === 1 ? "coin" : "fragment";
  if (entry !== null) {
    return {
      fragment: fragmentOfEntry(entry),
      special: specialOfEntry(entry),
      ticket: ticketOfEntry(entry),
      rewardKind,
      fairy,
      tier,
      source: "table",
      entry,
    };
  }
  if (fairy) {
    return {
      fragment: null,
      special: null,
      ticket: false,
      rewardKind,
      fairy,
      tier,
      source: "none",
      entry: null,
    };
  }
  const fragment = fragmentByFormula(input.rarity, input.stage);
  return {
    fragment,
    special: null,
    ticket: false,
    rewardKind,
    fairy,
    tier,
    source: fragment === null ? "none" : "formula",
    entry: null,
  };
}

/** 渦碼頻道那種「藍龜」的說法。查不到碎片就只有種類。 */
export function describeRaidClass(cls: RaidClass): string {
  const parts: string[] = [];
  if (cls.tier === 4) parts.push("渦IV");
  if (cls.special === "bookmark") parts.push("書籤");
  if (cls.special === "material") parts.push("素材");
  if (cls.ticket) parts.push("券");
  if (cls.fragment !== null) {
    parts.push(
      cls.rewardKind === "coin" ? RAID_COIN_BY_FRAGMENT[cls.fragment.key] : cls.fragment.short,
    );
  }
  if (cls.fairy) parts.push("妖");
  return parts.join("");
}
