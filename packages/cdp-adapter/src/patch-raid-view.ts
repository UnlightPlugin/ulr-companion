/**
 * 渦房的獎勵標記：清單圖示、地圖上色、BOSS 狀態、獎勵一覽
 * ========================================================
 * 官方渦房畫面上**看不出**一個渦的獎勵是什麼：清單只有名字／HP／剩餘時間，
 * 地圖上的渦只分「自己的（紅）」與「別人的（藍）」。渦碼分享頻道講的
 * 「藍龜」「書籤妖」全靠玩家自己背 TL 表。伺服器其實每一列都給了
 * `treasure_level`、`rarity`、`stage`、`state`，只是客戶端沒讀。這支把它們畫出來
 * （分類邏輯在 `raid-treasure.ts`，狀態表在 `raid-status.ts`）：
 *
 * ```
 *   ① 清單列（raid_list[e]）：名字右邊接小圖示 —— 渦IV 徽章、書籤／素材、
 *      抽獎券、碎片（渦I 是硬幣）、妖精星 —— 再接 BOSS 身上的狀態（戰鬥裡那
 *      一套 state_tmp 圖示＋剩餘時間）
 *   ② 地圖渦（vortex[i]）：漩渦換成灰階貼圖再上碎片色；素材黑／書籤白 佔上半、
 *      碎片色佔下半；自己開的渦紅框、渦IV 白框＋外光；上方掛小標記
 *   ③ 詳細面板（raid_info）：名字右邊接 TL 與圖示、名字下方列 BOSS 狀態、
 *      「參加獎勵」那一列右側一顆「獎勵一覽」鈕 → 開一張面板列 發現／參加／排名／擊破。
 *      面板（獎勵一覽、傷害統計）用官方擊破渦通知那張 result_panel 當底圖、
 *      官方的 OK 鈕與 btn_arrow，字色照官方結算頁 —— 玩家要「看起來像是遊戲提供的」
 *   ④ SUPPORT 公開渦清單：RAID 名字右邊接同一套圖示、BOSS 欄右邊接狀態
 *      （兩者分開放，同一欄會太擠）。**這份清單伺服器只給 7 欄、沒有 TL**，
 *      圖示靠托盤從 ulgg 的 observed_raids 對渦碼推來的表（`setPublic`），
 *      對不到的渦就沒有圖示
 *   ⑤ 每 10 秒自己送一次 db_raid：官方只在進房／打完才更新，玩家 2026-09-13
 *      要「有人上新狀態或延長狀態也要更新，血量要更新」。回來後詳細面板開著的話
 *      照點進渦那條路重畫排行榜，翻回原本那一頁
 *   ⑧ 自動刪除死渦：HP 歸零就送官方「放棄」刪掉，不等結算（刪在結算前會不會吃掉
 *      獎勵沒驗過，玩家知情選的）。死渦面板上有開關鈕
 *   ⑦ 插件互傳（見 @ulr/arbiter-link/raid-share）：SUPPORT 畫完回報渦碼、托盤查到
 *      之後 setPublic 下來就地重畫；RAID_VIEW_SNAPSHOT_EXPRESSION 給托盤上傳自己的渦
 *   ⑥ 誰上了狀態（推測）：比對前後兩次 db_raid，狀態新出現／延長／層數變多，
 *      而那段時間只有一個玩家的分數有動，就記在他頭上（ulgg 的「唯一候選」）。
 *      排行榜名字旁掛狀態圖；「傷害統計」面板列出全部參加者的分數、傷害、
 *      佔比與上過的狀態
 *   ⑨ 打渦隊伍（玩家 2026-09-13：「點玩家可以看得到打渦用的隊伍……新手玩家不知該用
 *      哪個隊伍，該花費多少AP來打」）：
 *      · 記：伺服器回 raid_ready（開打）時記下 raid_id、回合（config.turn_limit）、
 *        deck{deck_now} 與榜上自己的 damage／point；人回到渦房、raid_data 換過一份之後
 *        再讀一次相減，回報 raid-battle。AP = ap_spend × 回合（官方回合面板同一條算式）。
 *        之後 15 分鐘內分數再漲（提早離場時晚到）用同一個 at 補報。
 *        還沒量到就又開打（連打時回渦房一秒就按 START）：用開打那一刻的榜先把上一場結算掉
 *        （v16，2026-09-13 實機連打 3 場只記到 1 場）。
 *        量不到（渦不見了）就不回報 —— 不記一筆傷害是猜的
 *      · 看：托盤把自己的紀錄＋插件互傳查到的別人的，整理成「渦碼 → 名字 → 隊伍」推下來
 *        （setTeams）。有隊伍的名字（排行榜、傷害統計）旁掛一顆牌盒 edit_icon、點得下去；
 *        一支就直接開那支，多支先列清單（像牌盒選單：三張卡面＋數字），點一列看整副
 *   ⑩ 更新鈕（玩家 2026-09-13：「玩家有辦法主動更新渦房狀態嗎？之前都要離開渦房重進」）：
 *      Profound 計數下面一顆「Refresh」。照官方打完回渦房送的三則（db_player／db_raid／
 *      db_raid_reward）—— 等於重進渦房：AP、渦清單、死渦的結算都會回來（⑤ 的 10 秒
 *      自動只問 db_raid，AP 與結算不會自己來）。回報 raid-refresh 讓托盤馬上重查雲端。
 *      冷卻 3 秒。「Profound /10」是烤在底圖上的英文，旁邊被角色小人蓋住，只剩底下有空位
 * ```
 *
 * ## ⑨ 為什麼在 raid_ready 記、不在 raid_turn
 *
 * raid_turn 是玩家按 OK 送出去的，伺服器可能不收（AP 不夠、渦剛死）；raid_ready 才是
 * 真的開打。它的第一個參數是伺服器給這場戰鬥的設定：turn_limit（收下的回合數）、
 * room_playerAdeck（拿來打的牌，沒有事件卡）。那一刻 Raid 場景上的 raid_id／deck_now
 * 還是剛才送出去的值，deck1 也已經被 patch-room-gate 換成要用的那副。
 * ⚠ 回合數別只讀 R.raid_turn：不是按鈕送出去的（打渦.py 那種直接 emit）就沒有它。
 *
 * ## ⑨ 傷害為什麼用榜上的差值，不用戰鬥中的 dmgTo
 *
 * 2026-09-13 實測兩場：BOSS 掉 56／96 血（dmgToB 加總），榜上 damage 只漲 20／29。
 * 差的那些是別人掛在 BOSS 身上的狀態跳血、BOSS 自傷（開場還沒出手就先掉 10）——
 * 不是這副牌打的。榜上的數字是伺服器歸屬給這個人的，跟傷害統計面板一致。
 * 監聽掛在 R.socket 的 on（不是包 emit，那是 room-gate 的地盤）；Raid 場景 shutdown
 * 會斷掉 socket、下次進房是新的一顆，所以每輪看一眼換過沒、換過就重掛。
 *
 * 「回到渦房後 raid_data 換過一份」而不是「回到渦房的第一份」：第一眼看到的那份有可能
 * 是開打前送出去的 db_raid 晚到的回應（傷害還是舊的）。多等一份頂多晚 10 秒。
 *
 * ## 資料從哪來（2026-09-13 從跑著的客戶端讀的）
 *
 * ```
 *   Raid.raid_data[i] = { profound_id, pass, profound_mons, name_tcn, rarity,
 *                         stage, treasure_level, hp, hp_max, profound_founder,
 *                         state: [{type, turn}], points: [{name, point, damage}], … }
 *                       state[].turn：大多是到期時刻（ms）；curse 是層數
 *   Raid.raid_list[e] = { base, name, limit, rank, rarity, heart, founder,
 *                         list_rectangle, hp_guage, hp_text, id }   ← 每次 db_raid 重建
 *   Raid.vortex[i]    = { base, icon, id }                          ← 同上，class m 建的
 *   Raid.raid_info    = 詳細面板底圖；raid_idx 是選中的那一列
 *   Raid.raid_support_list(list, y, page) → { texts, timer_event } ← prototype 方法
 *   Raid.itemInfo     = avatar_item.json：cmem[0..4] 五種碎片、ccoin[0..4] 五種幣、
 *                       weapon[217..220] 四種魔之素材、quest[23] 書籤、other[0] 抽獎券
 * ```
 *
 * ## 圖示用遊戲自己的圖（玩家 2026-09-13：「圖示用遊戲的圖」）
 *
 * 道具卡面（`item_cmem` 168×240、`item_weapon` 128×128…）在 `MainAAssets`
 * 一起來就載好、全域都在。第一次進渦房時把每張卡的**中央那一塊**裁進一張
 * canvas 貼圖（碎片只裁寶石、幣只裁那枚幣），縮到 14px 還認得出來。
 * BOSS 狀態直接用戰鬥裡的 `state_tmp`（32×20 的小徽章，frame 名就是狀態代碼）。
 * 哪一張圖找不到就退回自己畫的形狀，功能不會因為缺一張圖整支不動。
 *
 * ## 為什麼是輪詢，不是包 create()
 *
 * 清單列與地圖渦是 `create()` 裡的閉包 `a()` 與模組私有的 `class m` 建的，
 * 每收到一次 `db_raid` 就整批 destroy 重建；我們拿不到那兩個函式。所以照
 * `patch-nav` 那套 300ms 輪詢：看到還沒掛過的 `name`／`icon`（**旗標記在
 * GameObject 上，不是場景上** —— 場景物件是長命的）就補上，物件死了就把
 * 自己掛的也收掉。
 *
 * ## 地圖渦怎麼上色
 *
 * 三張官方漩渦（normal 紅／another 藍／event 綠）都是飽和色，`setTint` 是
 * 乘法，藍色乘黃色是黑的。所以第一次進渦房時把 `vortex_another` 的 8 格
 * 畫進一張 canvas、用 max(r,g,b) 當亮度轉成灰階、註冊成新貼圖與新動畫，
 * 之後 `setTint` 就是乾淨的顏色。`base`（黑色剪影框）乘法也沒用，紅框／白框
 * 用 `setTintFill`。
 *
 * ⚠ 這支只送 `db_raid`（純讀取，客戶端自己進房也送同一則），不碰 `raid_data`，
 * 其餘只加顯示物件與改貼圖／tint。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal
 * 裡，一個沒跳脫的反引號會讓字串提早結束。
 */

import {
  AVATAR_ITEM_KEY,
  AVATAR_ITEM_WEAPON_FIELD,
  CC_ASSET_KEY,
  EVENT_INFO_JSON_KEY,
  MC_ASSET_KEY,
} from "./constants.js";
import { embedJson } from "./embed.js";
import { RAID_STATUS_COLORS, RAID_STATUSES } from "./raid-status.js";
import {
  RAID_COIN_BY_FRAGMENT,
  RAID_FRAGMENTS,
  RAID_OWN_FRAME_TINT,
  RAID_SPECIAL_TINT,
  RAID_TREASURE_TABLE,
  type RaidTreasureEntry,
} from "./raid-treasure.js";

const FLAG = "__ulrRaidView";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const RAID_VIEW_SCRIPT_VERSION = 16;

/**
 * 開打那一場的暫存（⑨）掛在頁面上的地方。**重裝不清**：打到一半插件重裝，
 * 回來還是要量得到那一場。
 */
const BATTLE_FLAG = "__ulrRaidBattle";

/** 開打後多久還沒量到就丟掉（渦最長也就幾個小時，一場戰鬥遠小於這個）。 */
export const RAID_BATTLE_PENDING_MAX_MS = 2 * 60 * 60 * 1000;

/** 結算完的那一場還留著看分數有沒有晚到（同樣重裝不清）。 */
const BATTLE_TAIL_FLAG = "__ulrRaidBattleTail";

/** 結算後多久內分數再漲都算那一場（提早離場時分數會晚幾分鐘進帳）。 */
export const RAID_BATTLE_TAIL_MS = 15 * 60 * 1000;

export const DEFAULT_RAID_VIEW_POLL_MS = 300;

/**
 * 多久自己送一次 `db_raid`。ulgg 的觀測站是 30 秒；我們 10 秒 ——
 * 「誰上了狀態」是比對兩次讀取之間誰的分數有動，間隔越短越常只有一個人動。
 */
export const DEFAULT_RAID_VIEW_REFRESH_MS = 10_000;

/** 更新鈕（⑩）按完多久內再按不算。三則讀取＋托盤重查雲端，連點沒有意義。 */
export const RAID_VIEW_MANUAL_REFRESH_COOLDOWN_MS = 3_000;

/** 玩家按了渦房的更新鈕（⑩）。托盤要跟著馬上重查 ulgg／插件雲端。 */
export interface RaidRefreshReport {
  type: "raid-refresh";
}

export function isRaidRefreshReport(value: unknown): value is RaidRefreshReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "raid-refresh"
  );
}

/** 推測紀錄掛在頁面上的地方。**重裝不清**：換版本時不該把這一輪觀察到的丟掉。 */
const HIST_FLAG = "__ulrRaidStatusLog";

/** 渦IV 的白框。 */
export const RAID_TIER4_FRAME_TINT = 0xffffff;

/**
 * 卡面裁哪一塊（來源貼圖、裁切矩形）。frame 索引正常路徑是用 `itemInfo`
 * 的名字找（官方調整順序時跟著動），找不到才用寫死的後路。
 */
export const RAID_ICON_SOURCES = {
  // 碎片裁寶石那一團、再把卡面平的灰底扣成透明；硬幣裁那枚幣、再用圓形裁掉四角
  fragment: { texture: "item_cmem", crop: [40, 62, 90, 90] },
  coin: { texture: "item_ccoin", crop: [52, 88, 64, 64] },
  weapon: { texture: "item_weapon", crop: [8, 8, 112, 112] },
  quest: { texture: "item_quest", crop: [8, 8, 112, 112] },
  other: { texture: "item_other", crop: [8, 8, 112, 112] },
  status: "state_tmp",
} as const;

/** 素材四樣在 `itemInfo.weapon` 的索引（2026-09-13 讀的），只當後路。 */
export const RAID_MATERIAL_WEAPON_INDEX: Readonly<Record<string, number>> = {
  魔之刀身: 217,
  魔之戒指: 218,
  魔之彈頭: 219,
  魔之手鐲: 220,
};

/** 詳細面板上「獎勵一覽」那顆鈕的字。照官方 `raid_info_reward_lang` 的五語。 */
export const RAID_VIEW_LABELS: Record<
  string,
  {
    button: string;
    discovery: string;
    participation: string;
    ranking: string;
    defeat: string;
    noTable: string;
    rank: string;
    stats: string;
    statsTitle: string;
    colName: string;
    colPts: string;
    colDmg: string;
    colShare: string;
    colStates: string;
    summary: string;
    guess: string;
    autoDeleteOn: string;
    autoDeleteOff: string;
    /** Rank 下面預計獎勵那三列的標籤（要短：跟官方「Rank」同一欄） */
    expRank: string;
    expJoin: string;
    expFind: string;
    /** 隊伍面板（⑨）：標題 __NAME__ 換成玩家名；欄名要短 */
    teamsTitle: string;
    colTeam: string;
    colBattles: string;
    colTurns: string;
    colAp: string;
    colPerAp: string;
    /** 隊伍詳細的每場平均那一列 */
    avg: string;
    colBest: string;
    /**
     * Profound 計數下面那顆更新鈕（⑩）。字跟著旁邊烤在底圖上的「Profound /10」一律英文，
     * 說明放滑上去的提示。
     */
    refresh: string;
    refreshTip: string;
  }
> = {
  ja: {
    button: "報酬一覧",
    discovery: "発見報酬",
    participation: "参加報酬",
    ranking: "順位報酬",
    defeat: "撃破報酬",
    noTable: "この TL の報酬表はありません（欠片の色は公式から推定）",
    rank: "__A__〜__B__位",
    stats: "ダメージ統計",
    statsTitle: "ダメージ統計",
    colName: "プレイヤー",
    colPts: "スコア",
    colDmg: "ダメージ",
    colShare: "割合",
    colStates: "付与した状態",
    summary: "参加 __N__ 人・総ダメージ __D__・ボス被ダメ __H__",
    guess: "状態は推定：2回の読み取りの間にスコアが動いたのが1人だけの時に、その人の付与と数える",
    autoDeleteOn: "撃破済みの渦を自動削除",
    autoDeleteOff: "自動削除を止める",
    expRank: "順位",
    expJoin: "参加",
    expFind: "発見",
    teamsTitle: "__NAME__ のデッキ",
    colTeam: "デッキ",
    colBattles: "戦闘数",
    colTurns: "ターン",
    colAp: "AP",
    colPerAp: "ダメ/AP",
    avg: "平均",
    colBest: "1戦最高",
    refresh: "Refresh",
    refreshTip: "渦リスト・AP・報酬を読み直す（渦部屋に入り直すのと同じ）",
  },
  en: {
    button: "Rewards",
    discovery: "Discovery",
    participation: "Participation",
    ranking: "Position",
    defeat: "Victory",
    noTable: "No reward table for this TL (fragment color estimated by formula)",
    rank: "#__A__–__B__",
    stats: "Damage",
    statsTitle: "Damage stats",
    colName: "Player",
    colPts: "Score",
    colDmg: "Damage",
    colShare: "Share",
    colStates: "Statuses applied",
    summary: "__N__ players ・ total damage __D__ ・ boss lost __H__",
    guess:
      "Statuses are inferred: credited when exactly one player's score changed between two reads",
    autoDeleteOn: "Auto-delete defeated",
    autoDeleteOff: "Stop auto-delete",
    expRank: "Pos.",
    expJoin: "Join",
    expFind: "Find",
    teamsTitle: "__NAME__'s decks",
    colTeam: "Deck",
    colBattles: "Battles",
    colTurns: "Turns",
    colAp: "AP",
    colPerAp: "Dmg/AP",
    avg: "Avg",
    colBest: "Best",
    refresh: "Refresh",
    refreshTip: "Reload vortex list, AP and rewards (same as re-entering the room)",
  },
  kr: {
    button: "보상 목록",
    discovery: "발견보상",
    participation: "참가보상",
    ranking: "랭킹보상",
    defeat: "격퇴보상",
    noTable: "이 TL의 보상표가 없습니다 (조각 색은 공식으로 추정)",
    rank: "__A__~__B__위",
    stats: "대미지 통계",
    statsTitle: "대미지 통계",
    colName: "플레이어",
    colPts: "점수",
    colDmg: "대미지",
    colShare: "비율",
    colStates: "부여한 상태",
    summary: "참가 __N__명・총 대미지 __D__・보스 피해 __H__",
    guess: "상태는 추정: 두 번의 읽기 사이에 점수가 변한 사람이 한 명뿐일 때 그 사람 것으로 셈",
    autoDeleteOn: "격퇴된 소용돌이 자동 삭제",
    autoDeleteOff: "자동 삭제 끄기",
    expRank: "랭킹",
    expJoin: "참가",
    expFind: "발견",
    teamsTitle: "__NAME__의 덱",
    colTeam: "덱",
    colBattles: "전투",
    colTurns: "턴",
    colAp: "AP",
    colPerAp: "대미지/AP",
    avg: "평균",
    colBest: "최고",
    refresh: "Refresh",
    refreshTip: "소용돌이 목록・AP・보상을 다시 읽기 (방에 다시 들어가는 것과 같음)",
  },
  scn: {
    button: "奖励一览",
    discovery: "发现奖励",
    participation: "参加奖励",
    ranking: "排名奖励",
    defeat: "击破奖励",
    noTable: "没有这个 TL 的奖励表（碎片颜色由公式推算）",
    rank: "__A__–__B__名",
    stats: "伤害统计",
    statsTitle: "伤害统计",
    colName: "玩家",
    colPts: "分数",
    colDmg: "伤害",
    colShare: "占比",
    colStates: "上过的状态",
    summary: "参加 __N__ 人・总伤害 __D__・BOSS 已损 __H__",
    guess: "状态是推测：两次读取之间只有一个人分数有动时，才算他上的",
    autoDeleteOn: "自动删除死涡",
    autoDeleteOff: "停用自动删除",
    expRank: "排名",
    expJoin: "参加",
    expFind: "发现",
    teamsTitle: "__NAME__ 的队伍",
    colTeam: "队伍",
    colBattles: "场次",
    colTurns: "回合",
    colAp: "AP",
    colPerAp: "伤害/AP",
    avg: "平均",
    colBest: "单场最高",
    refresh: "Refresh",
    refreshTip: "重读涡清单、AP 与结算（等于重进涡房）",
  },
  tcn: {
    button: "獎勵一覽",
    discovery: "發現獎勵",
    participation: "參加獎勵",
    ranking: "排名獎勵",
    defeat: "擊破獎勵",
    noTable: "沒有這個 TL 的獎勵表（碎片顏色由公式推算）",
    rank: "__A__–__B__名",
    stats: "傷害統計",
    statsTitle: "傷害統計",
    colName: "玩家",
    colPts: "分數",
    colDmg: "傷害",
    colShare: "佔比",
    colStates: "上過的狀態",
    summary: "參加 __N__ 人・總傷害 __D__・BOSS 已損 __H__",
    guess: "狀態是推測：兩次讀取之間只有一個人分數有動時，才算他上的",
    autoDeleteOn: "自動刪除死渦",
    autoDeleteOff: "停用自動刪除",
    expRank: "排名",
    expJoin: "參加",
    expFind: "發現",
    teamsTitle: "__NAME__ 的隊伍",
    colTeam: "隊伍",
    colBattles: "場次",
    colTurns: "回合",
    colAp: "AP",
    colPerAp: "傷害/AP",
    avg: "平均",
    colBest: "單場最高",
    refresh: "Refresh",
    refreshTip: "重讀渦清單、AP 與結算（等於重進渦房）",
  },
};

/** BOSS 身上的一個狀態：代碼＋到期時刻（ms；沒有就 null）＋層數（詛咒那種）。 */
export interface RaidStateRef {
  type: string;
  until: number | null;
  count: number | null;
}

/** 托盤推下來的公開渦資料：渦碼 → 分類要用的欄位。來源是 ulgg 的 observed_raids。 */
export interface RaidPublicInfo {
  tl: number | null;
  rarity: number | null;
  stage: number | null;
  mons: string | null;
  states: RaidStateRef[];
  /** 這份資料是什麼時候觀測到的（ms）。合併 ulgg 與插件互傳時取新的那份。 */
  seenAt?: number | null;
}

/**
 * 自動刪除死渦（HP 歸零的渦）的設定。
 *
 * - `enabled`：開著就刪
 * - `prompt`：關著的時候，死渦的詳細面板上要不要出現「自動刪除死渦」那顆鈕
 *
 * 玩家 2026-09-13 訂的：死渦面板上可以打開；**在遊戲裡關掉之後 prompt 也跟著關**，
 * 要再開只能去插件視窗。
 */
export interface RaidAutoDeleteSetting {
  enabled: boolean;
  prompt: boolean;
}

export const DEFAULT_RAID_AUTO_DELETE: RaidAutoDeleteSetting = { enabled: false, prompt: true };

/** 玩家在遊戲裡切了自動刪除的設定。托盤要存起來。 */
export interface RaidAutoDeleteSettingReport extends RaidAutoDeleteSetting {
  type: "raid-auto-delete-setting";
}

/** 刪了一個死渦。 */
export interface RaidAutoDeleteReport {
  type: "raid-auto-delete";
  name: string;
  founder: string;
  /** no-reward：榜上沒分也不是發現者；had-reward：自己有份（HP 歸零就刪，沒等結算） */
  reason: "no-reward" | "had-reward";
}

export function isRaidAutoDeleteSettingReport(
  value: unknown,
): value is RaidAutoDeleteSettingReport {
  const o = value as { type?: unknown; enabled?: unknown; prompt?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-auto-delete-setting" &&
    typeof o.enabled === "boolean" &&
    typeof o.prompt === "boolean"
  );
}

export function isRaidAutoDeleteReport(value: unknown): value is RaidAutoDeleteReport {
  const o = value as { type?: unknown; name?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-auto-delete" &&
    typeof o.name === "string"
  );
}

/** SUPPORT 清單畫出來時回報：這一批公開渦的渦碼。托盤拿去查 TL／狀態。 */
export interface RaidCodesReport {
  type: "raid-codes";
  codes: string[];
}

export function isRaidCodesReport(value: unknown): value is RaidCodesReport {
  const o = value as { type?: unknown; codes?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    o.type === "raid-codes" &&
    Array.isArray(o.codes) &&
    o.codes.every((c) => typeof c === "string")
  );
}

/** 自己渦清單上的一個渦，給插件互傳上傳用（見 `@ulr/arbiter-link/raid-share`）。 */
export interface RaidSnapshotRow {
  code: string;
  tl: number | null;
  rarity: number | null;
  stage: number | null;
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  limit: number;
  states: RaidStateRef[];
  /**
   * 排行榜上的名字。**只給托盤查隊伍用**（名字＋渦碼算玩家 key），
   * `uploadSharedRaids` 不傳這一欄。
   */
  players: string[];
}

export type RaidPublicMap = Record<string, RaidPublicInfo>;

/** 一副牌組的內容（`db_deck*` 那 27 格，跟 `@ulr/deck-library` 的 DeckContent 同形狀）。 */
export interface RaidDeckContent {
  chara: (string | null)[];
  charaIndex: (number | null)[];
  weapon: (number | null)[];
  eventIndex: (number | null)[];
}

/** 隊伍面板上的一支隊伍：牌組內容＋用它打的累計。 */
export interface RaidTeamView extends RaidDeckContent {
  battles: number;
  turns: number;
  ap: number;
  damage: number;
  /** 單場最高傷害 */
  best: number;
  /** 榜上分數加總 */
  points: number;
}

/** 托盤推下來的隊伍表：渦碼 → 玩家名字 → 那個人的隊伍。 */
export type RaidTeamsMap = Record<string, Record<string, RaidTeamView[]>>;

/**
 * 打完一場渦（⑨）。開打（伺服器回 `raid_ready`）時記下渦、回合、牌組與榜上自己的傷害，
 * 回到渦房、清單換過一份之後再讀一次傷害相減。量不到（渦不見了）就不回報。
 */
export interface RaidBattleReport {
  type: "raid-battle";
  /** 渦碼（`pass`）。托盤拿去算雜湊，不會原樣上雲。 */
  code: string;
  player: string;
  /** 渦的到期時刻 */
  limit: number;
  turns: number;
  ap: number;
  /**
   * 榜上自己的 damage 漲了多少 —— 伺服器歸屬給這個人的傷害，跟「傷害統計」同一個數字。
   *
   * ⚠ 不用戰鬥中的 dmgTo對手 加總：那一串是 BOSS 這場掉的**所有**血，包含別人掛在
   * BOSS 身上的狀態跳血與 BOSS 自傷（2026-09-13 實測：一場掉 56 血、榜上記 20；
   * 另一場開場還沒出手就先掉 10）。那些不該算在這副牌頭上。
   */
  damage: number;
  /** 榜上分數漲了多少（排名獎勵看這個）。提早離場時會晚到，之後會用同一個 `at` 補報。 */
  points: number;
  deck: RaidDeckContent;
  /** 開打時刻（ms） */
  at: number;
}

export function isRaidBattleReport(value: unknown): value is RaidBattleReport {
  const o = value as Record<string, unknown> | null;
  if (typeof value !== "object" || o === null || o.type !== "raid-battle") return false;
  const d = o.deck as Record<string, unknown> | null;
  return (
    typeof o.code === "string" &&
    typeof o.player === "string" &&
    typeof o.limit === "number" &&
    typeof o.turns === "number" &&
    typeof o.ap === "number" &&
    typeof o.damage === "number" &&
    typeof o.points === "number" &&
    typeof o.at === "number" &&
    d !== null &&
    typeof d === "object" &&
    Array.isArray(d.chara) &&
    Array.isArray(d.charaIndex) &&
    Array.isArray(d.weapon) &&
    Array.isArray(d.eventIndex)
  );
}

export interface RaidViewStatus {
  installed: boolean;
  version: number | null;
  /** 玩家人在渦房（Raid active 而且不是 sleeping） */
  inRaid: boolean;
  /** 現在畫了幾列清單、幾顆地圖渦 */
  rows: number;
  vortices: number;
  /** 公開渦表上有幾筆 */
  publicCount: number;
  reason: string | null;
}

export interface RaidViewPatchOptions {
  /** 回報用的 binding。沒給就不回報渦碼（SUPPORT 的圖示只能靠一開始推下來的表）。 */
  bindingName?: string;
  pollIntervalMs?: number;
  refreshMs?: number;
  /** 一開始就推下去的公開渦表（可空） */
  publicMap?: RaidPublicMap;
  autoDelete?: RaidAutoDeleteSetting;
  /** 一開始就推下去的隊伍表（可空） */
  teams?: RaidTeamsMap;
}

/** 頁面端要的獎勵表：只留分類用的欄位＋面板要列的清單。 */
function compactTable(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tl, e] of RAID_TREASURE_TABLE) {
    out[String(tl)] = tableRow(e);
  }
  return out;
}

function tableRow(e: RaidTreasureEntry): unknown {
  return {
    d: e.discovery,
    p: e.participation,
    r: e.ranking,
    k: e.defeat,
  };
}

export function buildRaidViewPatchScript(options: RaidViewPatchOptions = {}): string {
  const config = {
    version: RAID_VIEW_SCRIPT_VERSION,
    bindingName: options.bindingName ?? null,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RAID_VIEW_POLL_MS,
    refreshMs: options.refreshMs ?? DEFAULT_RAID_VIEW_REFRESH_MS,
    table: compactTable(),
    fragments: RAID_FRAGMENTS.map((f) => ({
      key: f.key,
      code: f.code,
      item: f.item,
      short: f.short,
      tint: f.tint,
      css: f.css,
    })),
    coins: RAID_COIN_BY_FRAGMENT,
    materials: Object.keys(RAID_MATERIAL_WEAPON_INDEX),
    materialIndex: RAID_MATERIAL_WEAPON_INDEX,
    bookmark: "記憶的書籤(R1)",
    bookmarkIndex: 23,
    ticketPrefix: "抽獎券",
    fairyMons: "mc1004",
    sources: RAID_ICON_SOURCES,
    statuses: Object.fromEntries(
      RAID_STATUSES.map((s) => [s.code, { short: s.short, kind: s.kind }]),
    ),
    statusColors: RAID_STATUS_COLORS,
    tints: {
      material: RAID_SPECIAL_TINT.material,
      bookmark: RAID_SPECIAL_TINT.bookmark,
      own: RAID_OWN_FRAME_TINT,
      tier4: RAID_TIER4_FRAME_TINT,
    },
    labels: RAID_VIEW_LABELS,
    publicMap: options.publicMap ?? {},
    autoDelete: options.autoDelete ?? DEFAULT_RAID_AUTO_DELETE,
    teams: options.teams ?? {},
    battleMaxMs: RAID_BATTLE_PENDING_MAX_MS,
    manualCooldownMs: RAID_VIEW_MANUAL_REFRESH_COOLDOWN_MS,
    tailMs: RAID_BATTLE_TAIL_MS,
    assets: {
      cc: CC_ASSET_KEY,
      mc: MC_ASSET_KEY,
      event: EVENT_INFO_JSON_KEY,
      item: AVATAR_ITEM_KEY,
      weapon: AVATAR_ITEM_WEAPON_FIELD,
    },
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};
  var HIST = ${JSON.stringify(HIST_FLAG)};
  var BATTLE = ${JSON.stringify(BATTLE_FLAG)};
  var TAIL = ${JSON.stringify(BATTLE_TAIL_FLAG)};
  var st_repaintSupport = null;
  var ICON_TEX = "__ulrRaidIcons";
  var GRAY_TEX = "__ulrVortexGray";
  var GRAY_ANIM = "__ulrVortexGray";
  var CELL = 28;          // 圖示畫在 28px 的格子裡，顯示時 0.5 倍 → 14px
  var FONT = "font_light";

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys ? window.game : null;
  }
  function alive(o) { return !!(o && o.scene); }
  function langOf() { return typeof lang === "string" && CFG.labels[lang] ? lang : "tcn"; }
  function L() { return CFG.labels[langOf()]; }
  function safeDestroy(o) { try { if (alive(o)) o.destroy(); } catch (e) {} }
  function destroyAll(list) { for (var i = 0; i < list.length; i++) safeDestroy(list[i]); list.length = 0; }

  // ---- 分類（照 raid-treasure.ts 的 classifyRaid） ---------------------------
  var FRAG_BY_CODE = {}, FRAG_BY_ITEM = {}, FRAG_BY_KEY = {};
  CFG.fragments.forEach(function (f) { FRAG_BY_CODE[f.code] = f; FRAG_BY_ITEM[f.item] = f; FRAG_BY_KEY[f.key] = f; });

  function tierOf(mons, rarity) {
    if (typeof mons !== "string") return null;
    var parts = mons.split("_");
    if (parts[0] === CFG.fairyMons) return rarity === 5 ? 4 : 23;
    if (parts[0] === "mc1005") return 1;
    if (parts[1] === "01") return 1;
    if (parts[1] === "02") return 23;
    if (parts[1] === "03") return 4;
    return null;
  }
  function fragByFormula(rarity, stage) {
    if (typeof rarity !== "number" || typeof stage !== "number") return null;
    return FRAG_BY_CODE[((rarity === 6 ? stage + 1 : stage) % 5)] || null;
  }
  function classify(r) {
    var mons = r.profound_mons, rarity = r.rarity, stage = r.stage, tl = r.treasure_level;
    var fairy = typeof mons === "string" && mons.indexOf(CFG.fairyMons) === 0;
    var tier = tierOf(mons, rarity);
    var entry = typeof tl === "number" ? CFG.table[String(tl)] || null : null;
    var cls = { tl: tl, fragment: null, special: null, material: null, ticket: false, fairy: fairy, tier: tier,
                coin: tier === 1, source: "none", entry: entry };
    if (entry) {
      cls.source = "table";
      for (var i = 0; i < entry.r.length; i++) {
        var it = entry.r[i].item;
        if (!cls.fragment && FRAG_BY_ITEM[it]) cls.fragment = FRAG_BY_ITEM[it];
        if (it === CFG.bookmark) cls.special = "bookmark";
        else if (CFG.materials.indexOf(it) !== -1) { cls.material = it; if (cls.special !== "bookmark") cls.special = "material"; }
        if (it.indexOf(CFG.ticketPrefix) === 0) cls.ticket = true;
      }
      return cls;
    }
    if (fairy) return cls;
    cls.fragment = fragByFormula(rarity, stage);
    cls.source = cls.fragment ? "formula" : "none";
    return cls;
  }
  /** 清單列上要畫哪些圖示（frame 名），順序固定。 */
  function iconFrames(cls) {
    var f = [];
    if (cls.tier === 4) f.push("tier4");
    if (cls.special === "bookmark") f.push("bookmark");
    if (cls.material) f.push("material_" + cls.material);
    if (cls.ticket) f.push("ticket");
    if (cls.fragment) f.push((cls.coin ? "coin_" : "frag_") + cls.fragment.key);
    if (cls.fairy) f.push("fairy");
    return f;
  }
  /** 某個道具名該用哪個圖示 frame（獎勵一覽面板用）。 */
  function iconForItem(item) {
    if (FRAG_BY_ITEM[item]) return "frag_" + FRAG_BY_ITEM[item].key;
    for (var k in CFG.coins) if (CFG.coins[k] === item) return "coin_" + k;
    if (CFG.materials.indexOf(item) !== -1) return "material_" + item;
    if (item === CFG.bookmark) return "bookmark";
    if (item.indexOf(CFG.ticketPrefix) === 0) return "ticket";
    return null;
  }

  /** 碎片、硬幣、魔之素材、書籤、券以外的道具去 itemInfo 找（按名字），用遊戲的道具圖。 */
  var ITEM_ICON_CATS = ["avatar", "quest", "battle", "weapon", "raid", "other"];
  /**
   * 道具名 → 小圖。碎片／硬幣／書籤／券／魔之素材用裁好的格子（卡面太大，要裁中間）；
   * 其餘（魔女秘藥、古代妙藥、異化礦材…）直接用 item_<類別> 那一格 128px 的道具圖縮小。
   */
  function itemIconRef(R, item) {
    var fr = iconForItem(item);
    if (fr !== null) return { key: ICON_TEX, frame: fr, scale: 0.5 };
    var G = gameOf();
    var info = R && R.itemInfo;
    if (!G || !info) return null;
    for (var c = 0; c < ITEM_ICON_CATS.length; c++) {
      var list = info[ITEM_ICON_CATS[c]];
      if (!list) continue;
      for (var k in list) {
        var it = list[k];
        if (!it || it.name_tcn !== item) continue;
        var key = "item_" + ITEM_ICON_CATS[c];
        var frame = it.frame !== undefined ? it.frame : +k;
        var tex = G.textures.get(key);
        if (!tex || tex.key === "__MISSING" || !tex.has(frame)) return null;
        var f = tex.get(frame);
        return { key: key, frame: frame, scale: (CELL * 0.5) / Math.max(f.width, f.height) };
      }
    }
    return null;
  }
  /** 畫一個道具小圖，回傳下一個東西該從哪個 x 開始（沒圖就原地）。 */
  function addItemIcon(sc, x, y, item, depth, out) {
    var ref = itemIconRef(sc, item);
    if (ref === null) return x;
    out.push(sc.add.image(x, y, ref.key, ref.frame).setOrigin(0, 0.5).setScale(ref.scale).setDepth(depth));
    return x + CELL * 0.5 + 1;
  }

  // ---- BOSS 狀態 ------------------------------------------------------------
  /** raid_data 那種 state[{type, turn}] → [{type, until, count}]。 */
  function statesOf(r, keepExpired) {
    var out = [];
    var st = r && r.state;
    if (!st || !st.length) return out;
    var now = Date.now();
    for (var i = 0; i < st.length; i++) {
      var s = st[i];
      if (!s || typeof s.type !== "string") continue;
      var turn = typeof s.turn === "number" ? s.turn : null;
      // 到期時刻是 13 位的 ms；小數字是層數
      var timed = turn !== null && turn > 1e11;
      // 伺服器要等下一次讀才會拿掉過期的；畫面上先收掉（key 跟著變，會重畫）
      if (timed && !keepExpired && turn <= now) continue;
      out.push({ type: s.type, until: timed ? turn : null, count: timed || turn === null ? null : turn });
    }
    return out;
  }
  function stateKey(states) {
    var p = [];
    for (var i = 0; i < states.length; i++) p.push(states[i].type + ":" + states[i].until + ":" + states[i].count);
    return p.join(",");
  }
  /** 剩幾秒 → 「4m」「32s」；過期回 null。 */
  function remainText(until) {
    if (until === null) return null;
    var s = Math.floor((until - Date.now()) / 1000);
    if (s <= 0) return null;
    if (s >= 3600) return Math.floor(s / 3600) + "h";
    if (s >= 60) return Math.floor(s / 60) + "m";
    return s + "s";
  }
  function statusFrame(G, code) {
    var tex = G.textures.get(CFG.sources.status);
    if (!tex || tex.key === "__MISSING") return null;
    if (tex.has(code)) return code;
    var base = code.replace(/\\d+$/, "");
    if (base !== code && tex.has(base)) return base;
    return null;
  }
  function statusLabel(code) {
    var whole = CFG.statuses[code];
    if (whole) return { text: whole.short, color: CFG.statusColors[whole.kind] };
    var m = /^([A-Za-z]+)(\\d+)$/.exec(code);
    if (m && CFG.statuses[m[1]]) return { text: CFG.statuses[m[1]].short + m[2], color: CFG.statusColors[CFG.statuses[m[1]].kind] };
    return { text: code, color: CFG.statusColors.neutral };
  }
  /**
   * 一排狀態：戰鬥的 state_tmp 徽章＋剩餘時間。回傳 timers 讓 tick 每秒更新字。
   * 寬度到 maxX 就停，不畫半個。
   */
  function addStatusIcons(sc, G, x, y, states, depth, scale, maxX, out, timers) {
    var cx = x;
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      var frame = statusFrame(G, s.type);
      var w = 0, objs = [];
      if (frame !== null) {
        var im = sc.add.image(cx, y, CFG.sources.status, frame).setOrigin(0, 0.5).setScale(scale).setDepth(depth);
        objs.push(im); w = im.displayWidth;
      } else {
        var lb = statusLabel(s.type);
        var t = sc.add.text(cx, y, lb.text, { fontFamily: FONT, fontSize: Math.round(16 * scale), resolution: 2, color: lb.color }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
        objs.push(t); w = t.width;
      }
      var tail = s.count !== null ? String(s.count) : remainText(s.until);
      var tt = null;
      if (tail !== null || s.until !== null) {
        tt = sc.add.text(cx + w + 1, y + 1, tail || "", { fontFamily: FONT, fontSize: 9, resolution: 2, color: "#ffffff" }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
        objs.push(tt); w += 1 + tt.width;
      }
      if (maxX !== null && cx + w > maxX) { destroyAll(objs); break; }
      for (var k = 0; k < objs.length; k++) out.push(objs[k]);
      if (tt !== null && s.until !== null) timers.push({ text: tt, until: s.until });
      cx += w + 4;
    }
    return cx;
  }
  function tickTimers(timers) {
    for (var i = 0; i < timers.length; i++) {
      var t = timers[i];
      if (!alive(t.text)) continue;
      var s = remainText(t.until);
      var want = s === null ? "" : s;
      if (t.text.text !== want) t.text.setText(want);
    }
  }

  // ---- 貼圖：圖示格（裁遊戲的卡面）與灰階漩渦 -------------------------------
  function drawFallback(ctx, name) {
    ctx.save();
    ctx.translate(CELL / 2, CELL / 2);
    ctx.lineJoin = "round";
    if (name.indexOf("frag_") === 0 || name.indexOf("coin_") === 0) {
      var f = FRAG_BY_KEY[name.slice(5)];
      ctx.beginPath();
      if (name.indexOf("coin_") === 0) ctx.arc(0, 0, 10, 0, Math.PI * 2);
      else { ctx.moveTo(0, -11); ctx.lineTo(10, 0); ctx.lineTo(0, 11); ctx.lineTo(-10, 0); ctx.closePath(); }
      ctx.fillStyle = f ? f.css : "#999"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.stroke();
    } else if (name.indexOf("material_") === 0) {
      ctx.beginPath();
      for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i - Math.PI / 6; var px = Math.cos(a) * 11, py = Math.sin(a) * 11; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath(); ctx.fillStyle = "#101010"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#e6e6e6"; ctx.stroke();
    } else if (name === "bookmark") {
      ctx.beginPath(); ctx.moveTo(-7, -12); ctx.lineTo(7, -12); ctx.lineTo(7, 12); ctx.lineTo(0, 6); ctx.lineTo(-7, 12); ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#333333"; ctx.stroke();
    } else if (name === "ticket") {
      ctx.beginPath(); ctx.rect(-12, -6, 24, 12); ctx.fillStyle = "#ff9f1c"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#5a2e00"; ctx.stroke();
    } else if (name === "fairy") {
      ctx.beginPath();
      for (var k = 0; k < 10; k++) { var rr = k % 2 === 0 ? 12 : 5; var ang = -Math.PI / 2 + Math.PI / 5 * k; var sx = Math.cos(ang) * rr, sy = Math.sin(ang) * rr; if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
      ctx.closePath(); ctx.fillStyle = "#ffe066"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#8a5a00"; ctx.stroke();
    } else if (name === "tier4") {
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fillStyle = "#1b1b2a"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("IV", 0, 1);
    }
    ctx.restore();
  }
  /** 把某張卡面的一塊裁進格子。回 false = 貼圖或 frame 不在。 */
  /**
   * 把某張卡面的一塊裁進格子。回 false = 貼圖或 frame 不在。
   * mode "round" 圓形裁（硬幣）；"key" 把平的灰底扣掉（碎片）。
   * ax 是這一格在整張 canvas 上的絕對 x —— getImageData 不吃 translate。
   */
  function drawCrop(G, ctx, texKey, frame, crop, mode, ax) {
    var tex = G.textures.get(texKey);
    if (!tex || tex.key === "__MISSING" || !tex.has(frame)) return false;
    var f = tex.get(frame);
    var cx = Math.max(0, Math.min(crop[0], f.width - 1)), cy = Math.max(0, Math.min(crop[1], f.height - 1));
    var cw = Math.min(crop[2], f.width - cx), ch = Math.min(crop[3], f.height - cy);
    try {
      ctx.save();
      if (mode === "round") { ctx.beginPath(); ctx.arc(CELL / 2, CELL / 2, CELL / 2 - 1, 0, Math.PI * 2); ctx.clip(); }
      ctx.drawImage(f.source.image, f.cutX + cx, f.cutY + cy, cw, ch, 1, 1, CELL - 2, CELL - 2);
      ctx.restore();
      if (mode === "key") {
        var img = ctx.getImageData(ax, 0, CELL, CELL);
        var d = img.data;
        for (var i = 0; i < d.length; i += 4) {
          var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          if (mx - mn < 14 && mx >= 55 && mx <= 125) d[i + 3] = 0;
        }
        ctx.putImageData(img, ax, 0);
      }
    } catch (e) { return false; }
    return true;
  }
  /** 用 itemInfo 的名字找 frame 索引；找不到用寫死的後路。 */
  function indexByName(R, category, name, fallback) {
    try {
      var list = R && R.itemInfo && R.itemInfo[category];
      if (list) for (var k in list) if (list[k] && list[k].name_tcn === name) return +k;
    } catch (e) {}
    return fallback;
  }
  function iconFrameList() {
    var list = ["bookmark", "ticket", "fairy", "tier4"];
    CFG.materials.forEach(function (m) { list.push("material_" + m); });
    CFG.fragments.forEach(function (f) { list.push("frag_" + f.key); list.push("coin_" + f.key); });
    return list;
  }
  function ensureIcons(G, R) {
    if (G.textures.exists(ICON_TEX)) return true;
    var frames = iconFrameList();
    var tex = G.textures.createCanvas(ICON_TEX, CELL * frames.length, CELL);
    if (!tex) return false;
    var ctx = tex.getContext();
    var S = CFG.sources;
    for (var i = 0; i < frames.length; i++) {
      var name = frames[i], ok = false;
      ctx.save(); ctx.translate(i * CELL, 0);
      if (name.indexOf("frag_") === 0) {
        var f = FRAG_BY_KEY[name.slice(5)];
        ok = drawCrop(G, ctx, S.fragment.texture, indexByName(R, "cmem", f.item, f.code === 0 ? 4 : f.code - 1), S.fragment.crop, "key", i * CELL);
      } else if (name.indexOf("coin_") === 0) {
        var c = FRAG_BY_KEY[name.slice(5)];
        ok = drawCrop(G, ctx, S.coin.texture, indexByName(R, "ccoin", CFG.coins[c.key], c.code === 0 ? 4 : c.code - 1), S.coin.crop, "round", i * CELL);
      } else if (name.indexOf("material_") === 0) {
        var m = name.slice(9);
        ok = drawCrop(G, ctx, S.weapon.texture, indexByName(R, "weapon", m, CFG.materialIndex[m]), S.weapon.crop);
      } else if (name === "bookmark") {
        ok = drawCrop(G, ctx, S.quest.texture, indexByName(R, "quest", CFG.bookmark, CFG.bookmarkIndex), S.quest.crop);
      } else if (name === "ticket") {
        ok = drawCrop(G, ctx, S.other.texture, 0, S.other.crop);
      }
      if (!ok) drawFallback(ctx, name);
      ctx.restore();
    }
    tex.refresh();
    for (var j = 0; j < frames.length; j++) tex.add(frames[j], 0, j * CELL, 0, CELL, CELL);
    return true;
  }

  /** 從 vortex_another 的 8 格做一張灰階版。亮度取 max(r,g,b)，藍色才不會變暗。 */
  function ensureGray(G) {
    if (G.textures.exists(GRAY_TEX)) return G.anims.exists(GRAY_ANIM);
    var src = G.textures.get("vortex_another");
    if (!src || src.key === "__MISSING") return false;
    var names = src.getFrameNames().slice().sort(function (a, b) {
      return (parseInt((/\\[(\\d+)\\]/.exec(a) || [0, 0])[1], 10)) - (parseInt((/\\[(\\d+)\\]/.exec(b) || [0, 0])[1], 10));
    });
    if (!names.length) return false;
    var f0 = src.get(names[0]);
    var w = f0.width, h = f0.height;
    var tex = G.textures.createCanvas(GRAY_TEX, w * names.length, h);
    if (!tex) return false;
    var ctx = tex.getContext();
    for (var i = 0; i < names.length; i++) {
      var f = src.get(names[i]);
      ctx.drawImage(f.source.image, f.cutX, f.cutY, f.width, f.height, i * w, 0, f.width, f.height);
    }
    var img = ctx.getImageData(0, 0, w * names.length, h);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var l = Math.max(d[p], d[p + 1], d[p + 2]);
      d[p] = l; d[p + 1] = l; d[p + 2] = l;
    }
    ctx.putImageData(img, 0, 0);
    tex.refresh();
    var frames = [];
    for (var j = 0; j < names.length; j++) {
      tex.add(names[j], 0, j * w, 0, w, h);
      frames.push({ key: GRAY_TEX, frame: names[j] });
    }
    if (!G.anims.exists(GRAY_ANIM)) G.anims.create({ key: GRAY_ANIM, frames: frames, frameRate: 20, repeat: -1 });
    return true;
  }

  // ---- 共用：一排圖示 -------------------------------------------------------
  function addIcons(sc, x, y, frames, depth, scale, out) {
    var s = scale || 0.5;
    for (var i = 0; i < frames.length; i++) {
      var im = sc.add.image(x + i * (CELL * s + 1), y, ICON_TEX, frames[i]).setOrigin(0, 0.5).setScale(s).setDepth(depth);
      out.push(im);
    }
    return x + frames.length * (CELL * s + 1);
  }
  function raidById(R, id) {
    var d = R.raid_data || [];
    for (var i = 0; i < d.length; i++) if (d[i] && d[i].profound_id === id) return d[i];
    return null;
  }

  // ---- ① 清單列 -------------------------------------------------------------
  function decorateList(st, R, G) {
    var rows = R.raid_list || [];
    for (var e = 0; e < rows.length; e++) {
      var row = rows[e];
      if (!row || !alive(row.name)) continue;
      var name = row.name;
      var r = raidById(R, row.id);
      if (!r) continue;
      var states = statesOf(r);
      var key = row.id + "|" + stateKey(states);
      var deco = name.__ulrRaidView;
      if (deco && deco.key === key) {
        for (var k = 0; k < deco.objs.length; k++) deco.objs[k].setVisible(name.visible);
        tickTimers(deco.timers);
        continue;
      }
      if (deco) destroyAll(deco.objs);
      var objs = [], timers = [];
      var cls = classify(r);
      var x = name.x + name.width + 4;
      x = addIcons(R, x, name.y, iconFrames(cls), name.depth, 0.5, objs);
      addStatusIcons(R, G, x + 3, name.y, states, name.depth, 0.55, 199, objs, timers);
      for (var v = 0; v < objs.length; v++) objs[v].setVisible(name.visible);
      if (!deco) st.rows.push(name);
      name.__ulrRaidView = { key: key, objs: objs, timers: timers };
    }
    // 官方重建清單時舊的 name 已經 destroy，我們掛的要跟著收
    st.rows = st.rows.filter(function (n) {
      if (alive(n)) return true;
      if (n.__ulrRaidView) destroyAll(n.__ulrRaidView.objs);
      return false;
    });
  }

  // ---- ② 地圖渦 -------------------------------------------------------------
  function decorateMap(st, R, G) {
    var vs = R.vortex || [];
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (!v || !alive(v.icon) || !alive(v.base)) continue;
      var icon = v.icon, base = v.base;
      var texKey = icon.texture && icon.texture.key;
      // 處理過又還是我們的樣子才跳過。官方會在同一顆 sprite 上把貼圖換回自己的（變回藍色），
      // 只看旗標的話會一直藍著（玩家 2026-09-13：「渦也偶爾會變成藍的」）。
      if (icon.__ulrRaidView === v.id && (!icon.__ulrOrig || texKey === GRAY_TEX)) continue;
      var r = raidById(R, v.id);
      if (!r) continue;
      // 同一顆重畫：上一次掛的外光／標記先收掉
      for (var old = 0; old < st.map.length; old++) {
        if (st.map[old].icon === icon) { destroyAll(st.map[old].extras); st.map.splice(old, 1); break; }
      }
      icon.__ulrOrig = null;
      var expired = !texKey || texKey.indexOf("_expired") !== -1;
      if (expired) { try { icon.clearTint(); } catch (e) {} }
      var cls = classify(r);
      var extras = [];
      var own = r.profound_founder === R.player.name;
      if (!expired && ensureGray(G)) {
        icon.__ulrOrig = { key: texKey, frame: icon.frame && icon.frame.name, anim: texKey };
        try { icon.anims.stop(); } catch (e) {}
        icon.setTexture(GRAY_TEX, icon.__ulrOrig.frame);
        try { icon.play(GRAY_ANIM); } catch (e) {}
        var fragTint = cls.fragment ? cls.fragment.tint : 0x9a9a9a;
        if (cls.special === "material") icon.setTint(CFG.tints.material, CFG.tints.material, fragTint, fragTint);
        else if (cls.special === "bookmark") icon.setTint(CFG.tints.bookmark, CFG.tints.bookmark, fragTint, fragTint);
        else icon.setTint(fragTint);
        if (cls.tier === 4) {
          var glow = R.add.sprite(icon.x, icon.y, GRAY_TEX, icon.__ulrOrig.frame).setScale(1.4).setAlpha(0.45).setDepth(icon.depth - 0.5).setBlendMode(1).setTint(fragTint);
          try { glow.play(GRAY_ANIM); } catch (e) {}
          extras.push(glow);
        }
      }
      try { base.clearTint(); } catch (e) {}
      if (own) base.setTintFill(CFG.tints.own);
      else if (cls.tier === 4) base.setTintFill(CFG.tints.tier4);
      var marks = [];
      if (cls.special === "bookmark") marks.push("bookmark");
      if (cls.material) marks.push("material_" + cls.material);
      if (cls.ticket) marks.push("ticket");
      if (cls.fairy) marks.push("fairy");
      if (marks.length) addIcons(R, base.x - marks.length * 7.5, base.y - 46, marks, base.depth + 0.5, 0.5, extras);
      icon.__ulrRaidView = v.id;
      st.map.push({ icon: icon, base: base, extras: extras });
    }
    st.map = st.map.filter(function (m) {
      if (alive(m.icon)) return true;
      destroyAll(m.extras);
      return false;
    });
  }
  function undoMap(st) {
    for (var i = 0; i < st.map.length; i++) {
      var m = st.map[i];
      destroyAll(m.extras);
      if (alive(m.icon) && m.icon.__ulrOrig) {
        try { m.icon.anims.stop(); } catch (e) {}
        try { m.icon.clearTint(); m.icon.setTexture(m.icon.__ulrOrig.key, m.icon.__ulrOrig.frame); m.icon.play(m.icon.__ulrOrig.anim); } catch (e) {}
        m.icon.__ulrOrig = null;
      }
      if (alive(m.icon)) m.icon.__ulrRaidView = null;
      if (alive(m.base)) { try { m.base.clearTint(); } catch (e) {} }
    }
    st.map = [];
  }

  // ---- 推測誰上了狀態（ulgg 同款「唯一候選」） --------------------------------
  //
  // 伺服器的 state 沒有施放者。兩次讀取之間：某個狀態新出現、到期時刻往後推、
  // 或層數變多，而那段時間只有一個玩家的分數有動 —— 就記在他頭上。
  // 多人同時動就不記（寧可少記，不要記錯人）。
  function hist() {
    var h = window[HIST];
    if (!h || !h.raids) { h = { raids: {} }; window[HIST] = h; }
    return h;
  }
  function observe(st, R) {
    if (R.raid_data === st.lastData) return false;
    st.lastData = R.raid_data;
    var H = hist(), seen = {};
    var data = R.raid_data || [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r || !r.profound_id) continue;
      seen[r.profound_id] = true;
      var cur = { states: {}, pts: {} };
      var ss = statesOf(r, true);
      for (var k = 0; k < ss.length; k++) cur.states[ss[k].type] = ss[k];
      var pts = r.points || [];
      for (var q = 0; q < pts.length; q++) if (pts[q] && typeof pts[q].name === "string") cur.pts[pts[q].name] = pts[q].point;
      var h = H.raids[r.profound_id];
      if (!h) { h = { prev: null, credit: {}, events: 0, unique: 0 }; H.raids[r.profound_id] = h; }
      if (h.prev) {
        var events = [];
        for (var t in cur.states) {
          var c = cur.states[t], p = h.prev.states[t];
          if (!p) events.push(t);
          else if (c.until !== null && p.until !== null && c.until > p.until + 3000) events.push(t);
          else if (c.count !== null && p.count !== null && c.count > p.count) events.push(t);
        }
        var changed = [];
        for (var n in cur.pts) {
          var before = h.prev.pts[n] === undefined ? 0 : h.prev.pts[n];
          if (cur.pts[n] !== before) changed.push(n);
        }
        if (events.length) {
          h.events += events.length;
          if (changed.length === 1) {
            h.unique += events.length;
            var who = h.credit[changed[0]] || (h.credit[changed[0]] = {});
            for (var e = 0; e < events.length; e++) who[events[e]] = (who[events[e]] || 0) + 1;
          }
        }
      }
      h.prev = cur;
    }
    for (var id in H.raids) if (!seen[id]) delete H.raids[id];
    return true;
  }
  /** 某玩家在某渦被記了哪些狀態，次數多的在前。 */
  function creditOf(raidId, name, max) {
    var h = hist().raids[raidId];
    var c = h && h.credit[name];
    if (!c) return [];
    var list = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; });
    return max ? list.slice(0, max) : list;
  }

  /**
   * 官方排行榜（詳細面板右側那 5 名）的名字與分數之間掛狀態圖；有隊伍的人再掛一顆牌盒、
   * 名字點得下去（⑨）。名字太長就再截短一點。
   */
  function decorateRanking(st, R, G) {
    var list = R.raid_info_points || [];
    var r = R.raid_idx !== null && R.raid_idx !== undefined && R.raid_data ? R.raid_data[R.raid_idx] : null;
    for (var e = 0; e < list.length; e++) {
      var it = list[e];
      if (!it || !alive(it.name) || !alive(it.point)) continue;
      var pname = r && r.points && r.points[e] ? r.points[e].name : null;
      var codes = pname && r ? creditOf(r.profound_id, pname, 3) : [];
      var teams = pname && r ? teamsOf(st, r, pname) : null;
      var key = (pname || "") + "|" + codes.join(",") + "|t" + (teams ? teams.length : 0);
      var deco = it.name.__ulrRaidRank;
      if (deco && deco.key === key) {
        for (var k = 0; k < deco.objs.length; k++) deco.objs[k].setVisible(it.name.visible);
        continue;
      }
      if (deco) { destroyAll(deco.objs); unclickable(it.name, deco); }
      var objs = [];
      var right = it.point.x - it.point.width - 3;
      var x = right - codes.length * 13;
      for (var c = 0; c < codes.length; c++) {
        var fr = statusFrame(G, codes[c]);
        if (fr === null) continue;
        objs.push(R.add.image(x + c * 13, it.name.y, CFG.sources.status, fr).setOrigin(0, 0.5).setScale(0.4).setDepth(it.name.depth + 1).setVisible(it.name.visible));
      }
      var next = { key: key, objs: objs, click: null };
      if (teams) {
        x -= 11;
        var open = (function (raid, who) { return function () { openTeams(st, R, raid, who); }; })(r, pname);
        var icon = teamIcon(R, G, x, it.name.y, it.name.depth + 1, open);
        if (icon !== null) objs.push(icon.setVisible(it.name.visible));
        clickable(it.name, next, open);
      }
      var maxW = x - 2 - it.name.x;
      if ((codes.length || teams) && it.name.width > maxW && typeof pname === "string") {
        var len = pname.length;
        while (len > 1 && it.name.width > maxW) { len--; it.name.setText(pname.substring(0, len) + "..."); }
      }
      if (!deco) st.rank.push(it.name);
      it.name.__ulrRaidRank = next;
    }
    st.rank = st.rank.filter(function (n) {
      if (alive(n)) return true;
      if (n.__ulrRaidRank) destroyAll(n.__ulrRaidRank.objs);
      return false;
    });
  }

  /**
   * 自己重讀回來的 db_raid，官方不會重畫排行榜（只在點進渦時畫一次）。
   * 詳細面板開著、回合面板沒開時，照點進渦的那條路重畫一次，再翻回原本那一頁。
   */
  function rebuildRanking(R) {
    try {
      if (!R.raid_info || !R.raid_info.visible || R.raid_idx === null || R.raid_idx === undefined) return;
      if (R.raid_turn_back && R.raid_turn_back.visible) return;
      if (typeof R.raid_list_pointerup !== "function" || typeof R.raid_info_func !== "function") return;
      var page = R.raid_info_page || 1;
      R.raid_list_pointerup();
      var max = Math.max(1, Math.ceil((R.raid_info_points || []).length / 5));
      R.raid_info_page = Math.min(page, max);
      R.raid_info_func();
    } catch (e) {}
  }

  // ---- 面板：用擊破渦通知那一張底圖（玩家 2026-09-13：「要看起來像是遊戲提供的」）----
  //
  // 官方 raid_reward 用 images/assets/raid/result_panel.webp（576x336，標題
  // DEFEATED CORE ! 烤在圖上）＋ result_panel_overlay.webp（左邊立繪），畫完就
  // textures.remove。我們自己抓一份做成 canvas 貼圖：標題那一塊用同一張圖下方的
  // 素面蓋掉（實測看不出接縫），立繪只留左邊 130px（官方獎勵頁也是這樣 setCrop）。
  // 不走 Phaser loader：官方的 load.on("complete") 沒有 once，搶著用會提早放行它的 await。
  // 字照官方結算頁：標籤 font_heavy 12 白、內容 font_light 12 白、格子是白 5% 的圓角條。
  var PANEL_TEX = "__ulrRaidPanel", CHAR_TEX = "__ulrRaidPanelChar";
  var PANEL_X = 380, PANEL_Y = 340, PANEL_W = 576, PANEL_H = 336;
  var PANEL_L = PANEL_X - PANEL_W / 2, PANEL_T = PANEL_Y - PANEL_H / 2;
  /**
   * 詳細面板上我們加的字鈕：跟官方「参加獎勵」「Rank」同一套（font_light 11 白、黑邊 3）。
   * 滑上去變成官方星星那種灰，當作「點得到」的提示。
   */
  var BTN_COLOR = "#ffffff", BTN_HOVER = "#c5c5c5";

  function assetBase() {
    try {
      var list = performance.getEntriesByType("resource");
      for (var i = 0; i < list.length; i++) {
        var at = list[i].name.indexOf("images/assets/");
        if (at !== -1) return list[i].name.slice(0, at);
      }
    } catch (e) {}
    return null;
  }
  /** 底圖好了回 true；還沒就開始抓（這次先用退路畫，下次開就是底圖）。 */
  function ensureSkin(st, G) {
    if (G.textures.exists(PANEL_TEX)) return true;
    if (st.skin) return false;
    if (typeof Image === "undefined" || typeof document === "undefined" || typeof document.createElement !== "function") { st.skin = "unsupported"; return false; }
    var base = assetBase();
    if (base === null) return false;
    st.skin = "loading";
    var load = function (path) {
      return new Promise(function (res) {
        var im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = function () { res(im); };
        im.onerror = function () { res(null); };
        im.src = base + path;
      });
    };
    Promise.all([load("images/assets/raid/result_panel.webp"), load("images/assets/raid/result_panel_overlay.webp")]).then(function (imgs) {
      if (window[FLAG] !== st) return;
      var panel = imgs[0], over = imgs[1];
      if (!panel) { st.skin = "failed"; return; }
      try {
        var c = document.createElement("canvas");
        c.width = panel.width; c.height = panel.height;
        var ctx = c.getContext("2d");
        ctx.drawImage(panel, 0, 0);
        ctx.drawImage(panel, 150, 100, 276, 32, 150, 3, 276, 32);
        if (!G.textures.exists(PANEL_TEX)) G.textures.addCanvas(PANEL_TEX, c);
        if (over && !G.textures.exists(CHAR_TEX)) {
          var c2 = document.createElement("canvas");
          c2.width = 130; c2.height = over.height;
          c2.getContext("2d").drawImage(over, 0, 0, 130, over.height, 0, 0, 130, over.height);
          G.textures.addCanvas(CHAR_TEX, c2);
        }
        st.skin = "ready";
      } catch (e) {
        st.skin = "failed";
        st.reason = "panel skin: " + String((e && e.message) || e);
      }
    });
    return false;
  }
  function labelStyle() { return { fontFamily: "font_heavy", fontSize: 12, color: "white", resolution: 2 }; }
  function valueStyle() { return { fontFamily: FONT, fontSize: 12, color: "white", resolution: 2 }; }
  /** 官方結算頁那種格子：白 5% 的圓角條。y 是這一行的中線。 */
  function cellBar(R, x, y, w, depth, alpha) {
    return R.rexUI.add.roundRectangle(x, y - 8, w, 16, 2, 0xffffff, alpha === undefined ? 0.05 : alpha).setOrigin(0, 0).setDepth(depth);
  }
  /** 底圖＋標題＋OK 鈕。點面板外面或按 OK 都關。 */
  function panelShell(st, R, D, withChar, title) {
    var G = gameOf();
    var objs = [];
    var zone = R.add.zone(380, 340, 760, 680).setDepth(D).setInteractive();
    zone.on("pointerup", function () { closePanel(st); });
    objs.push(zone);
    if (G && ensureSkin(st, G)) {
      objs.push(R.add.image(PANEL_X, PANEL_Y, PANEL_TEX).setDepth(D + 1));
      if (withChar && G.textures.exists(CHAR_TEX)) objs.push(R.add.image(PANEL_L, PANEL_T, CHAR_TEX).setOrigin(0, 0).setDepth(D + 1));
    } else {
      // 退路：底圖抓不到時照渦房橫幅的底色（#313134）畫一塊
      objs.push(R.rexUI.add.roundRectangle(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 2, 0x313134, 1).setDepth(D + 1).setStrokeStyle(1, 0x444447));
    }
    var t = R.add.text(PANEL_X, PANEL_T + 20, title, { fontFamily: "font_heavy", fontSize: 16, color: "#e6e6e6", resolution: 2 }).setOrigin(0.5, 0.5).setDepth(D + 2).setStroke("black", 3);
    objs.push(t);
    var ok;
    if (G && G.textures.exists("panel_ok")) {
      ok = R.add.image(PANEL_X, PANEL_Y + 148, "panel_ok", 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
      ok.on("pointerover", function () { ok.setTexture("panel_ok", 1); });
      ok.on("pointerout", function () { ok.setTexture("panel_ok", 0); });
      ok.on("pointerdown", function () { ok.setTexture("panel_ok", 0); });
    } else {
      ok = R.add.text(PANEL_X, PANEL_Y + 148, "OK", { fontFamily: "font_heavy", fontSize: 15, color: "white", resolution: 2 }).setOrigin(0.5, 0.5).setDepth(D + 3).setStroke("black", 3).setInteractive({ useHandCursor: true });
    }
    ok.on("pointerup", function () {
      try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
      closePanel(st);
    });
    objs.push(ok);
    return { objs: objs, title: t };
  }
  /** 官方面板出場是 200ms 淡入；我們也淡入，不要啪一下蓋上來。 */
  function fadeIn(R, list) {
    if (!R.tweens || typeof R.tweens.add !== "function") return;
    var targets = list.filter(function (o) { return alive(o) && o.type !== "Zone" && o.visible; });
    for (var i = 0; i < targets.length; i++) targets[i].setAlpha(0);
    R.tweens.add({ targets: targets, alpha: 1, duration: 200, ease: "Power1" });
  }

  /**
   * 面板底部的翻頁列：頁碼＋官方 btn_arrow（沒翻＝指左，flipX＝指右；到第一頁／最後一頁
   * 是兩個疊在一起），到頭那一邊藏起來。onPage(頁) 負責重畫內容。
   */
  function addPager(R, G, D, objs, pages, onPage) {
    var cx = PANEL_X, navY = PANEL_T + 278;
    var page = 0, navs = [];
    var pageText = R.add.text(cx, navY, "", valueStyle()).setOrigin(0.5, 0.5).setDepth(D + 2);
    objs.push(pageText);
    var update = function () {
      pageText.setText((page + 1) + " / " + pages);
      for (var n = 0; n < navs.length; n++) {
        var show = navs[n].dir < 0 ? page > 0 : page < pages - 1;
        for (var q = 0; q < navs[n].parts.length; q++) {
          var part = navs[n].parts[q];
          if (!show && part.texture && part.texture.key === "btn_arrow") part.setTexture("btn_arrow", 0);
          part.setVisible(show);
        }
      }
    };
    var hasArrow = !!(G && G.textures.exists("btn_arrow"));
    var navBtn = function (x, dir, jump) {
      var parts = [];
      var offs = jump ? [-4, 4] : [0];
      for (var k = 0; k < offs.length; k++) {
        var a = hasArrow
          ? R.add.image(x + offs[k], navY, "btn_arrow", 0).setFlipX(dir > 0)
          : R.add.text(x + offs[k], navY, dir < 0 ? "\\u2039" : "\\u203a", labelStyle()).setOrigin(0.5, 0.5);
        parts.push(a.setDepth(D + 3).setInteractive({ useHandCursor: true }));
      }
      var hover = function (f) { if (hasArrow) for (var i2 = 0; i2 < parts.length; i2++) parts[i2].setTexture("btn_arrow", f); };
      for (var k2 = 0; k2 < parts.length; k2++) {
        parts[k2].on("pointerover", function () { hover(1); });
        parts[k2].on("pointerout", function () { hover(0); });
        parts[k2].on("pointerup", function () {
          var to = jump ? (dir < 0 ? 0 : pages - 1) : page + dir;
          if (to < 0 || to >= pages || to === page) return;
          try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
          page = to;
          onPage(page);
          update();
        });
      }
      navs.push({ dir: dir, jump: jump, parts: parts });
      for (var k3 = 0; k3 < parts.length; k3++) objs.push(parts[k3]);
    };
    navBtn(cx - 78, -1, true);
    navBtn(cx - 50, -1, false);
    navBtn(cx + 50, 1, false);
    navBtn(cx + 78, 1, true);
    return { set: function (p) { page = Math.max(0, Math.min(pages - 1, p)); onPage(page); update(); } };
  }

  // ---- ⑨ 打渦隊伍 -----------------------------------------------------------
  /** 某個渦某個人的隊伍（托盤推下來的表），沒有回 null。 */
  function teamsOf(st, r, name) {
    var byName = r && typeof r.pass === "string" && st.teams ? st.teams[r.pass] : null;
    var list = byName && typeof name === "string" && Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : null;
    return list && list.length ? list : null;
  }
  /** 讓一行官方的字點得下去：滑上去變灰（跟我們的字鈕同一套）。拆的時候 unclickable。 */
  function clickable(text, holder, fn) {
    try {
      var color = text.style && text.style.color ? text.style.color : BTN_COLOR;
      var over = function () { try { text.setColor(BTN_HOVER); } catch (e) {} };
      var out = function () { try { text.setColor(color); } catch (e) {} };
      var up = function () { out(); fn(); };
      text.setInteractive({ useHandCursor: true });
      text.on("pointerover", over);
      text.on("pointerout", out);
      text.on("pointerup", up);
      holder.click = { over: over, out: out, up: up, color: color };
    } catch (e) {}
  }
  function unclickable(text, holder) {
    var c = holder && holder.click;
    if (!c) return;
    holder.click = null;
    if (!alive(text)) return;
    try {
      text.off("pointerover", c.over);
      text.off("pointerout", c.out);
      text.off("pointerup", c.up);
      text.setColor(c.color);
      if (typeof text.disableInteractive === "function") text.disableInteractive();
    } catch (e) {}
  }
  /** 名字旁那顆牌盒（遊戲自己的 edit_icon 16×24，縮一半）。 */
  function teamIcon(R, G, x, y, depth, fn) {
    if (!G || !G.textures.exists("edit_icon")) return null;
    var im = R.add.image(x, y, "edit_icon").setOrigin(0, 0.5).setScale(0.5).setDepth(depth).setInteractive({ useHandCursor: true });
    im.on("pointerup", fn);
    return im;
  }
  function jsonRow(key, field, index) {
    try {
      var G = gameOf();
      var cache = G && G.cache && G.cache.json;
      if (!cache || typeof index !== "number" || !cache.has(key)) return null;
      var rows = cache.get(key)[field];
      return rows && index >= 0 && index < rows.length ? rows[index] || null : null;
    } catch (e) { return null; }
  }
  /**
   * 卡面縮圖，跟牌盒選單同一套：cc_front／mc_front 圖集，格子鍵是 cc_asset 的 filename
   * （不能用 charaIndex 算格子，圖集只有畫出來的那幾張）。查不到畫空槽底圖。左上角對齊。
   */
  function cardImage(R, G, x, y, h, chara, index, depth) {
    var key = null, frame = null;
    if (typeof chara === "string") {
      var mons = chara.indexOf("mc") === 0;
      var row = jsonRow(mons ? CFG.assets.mc : CFG.assets.cc, "frames", index);
      var atlas = mons ? "mc_front" : "cc_front";
      if (row && row.filename && G.textures.exists(atlas) && G.textures.get(atlas).has(row.filename)) { key = atlas; frame = row.filename; }
    }
    if (key === null) {
      if (!G.textures.exists("ccframe_base")) return null;
      key = "ccframe_base"; frame = 0;
    }
    return R.add.image(x, y, key, frame).setOrigin(0, 0).setDisplaySize(Math.round(h * 168 / 240), h).setDepth(depth);
  }
  function localName(row) {
    if (!row) return "";
    return String(row["name_" + langOf()] || row.name_tcn || "");
  }
  /** 滑上去才出來的說明（卡名、武器名）。 */
  function hoverTip(R, target, text, depth, objs) {
    if (!text) return;
    var tip = [];
    target.setInteractive();
    target.on("pointerover", function () {
      destroyAll(tip);
      var tt = R.add.text(target.x, target.y - 3, text, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(0, 1).setDepth(depth + 6);
      var bg = R.rexUI.add.roundRectangle(tt.x + tt.width / 2, tt.y - tt.height / 2, tt.width + 10, tt.height + 6, 2, 0x000000, 0.85).setDepth(depth + 5);
      tip.push(bg, tt);
      objs.push(bg, tt);
    });
    target.on("pointerout", function () { destroyAll(tip); });
  }
  function fmtInt(n) { return (Math.round(n) || 0).toLocaleString(); }
  function perAp(t) { return t.ap > 0 ? fmtInt(t.damage / t.ap) : "-"; }

  /** 點了某人：一支就直接開那支；多支先列清單（傷害高的在前）。 */
  function openTeams(st, R, r, name) {
    var teams = teamsOf(st, r, name);
    if (!teams) return;
    try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
    teams = teams.slice().sort(function (a, b) { return b.damage - a.damage; });
    if (teams.length === 1) { openTeam(st, R, r, name, teams[0], null); return; }
    openTeamList(st, R, r, name, teams, 0);
  }

  /**
   * 隊伍清單：像牌盒選單，一列一支 —— 三張卡面（之間不留縫）＋右邊的數字。
   * 一頁 4 支，翻頁跟傷害統計同一套。點一列看整副。
   */
  function openTeamList(st, R, r, name, teams, startPage) {
    closePanel(st);
    var G = gameOf();
    var D = 3000, PER = 4, ROW_H = 46;
    var shell = panelShell(st, R, D, false, L().teamsTitle.replace("__NAME__", name));
    var objs = shell.objs, body = [];
    var left = PANEL_L + 20, right = PANEL_L + PANEL_W - 20;
    var col = { team: left, dmg: left + 200, pts: left + 285, battles: left + 340, turns: left + 390, ap: left + 440, perAp: right };
    var hy = PANEL_T + 56;
    var head = function (x, t, o) { objs.push(R.add.text(x, hy, t, labelStyle()).setOrigin(o, 0.5).setDepth(D + 2)); };
    head(col.team, L().colTeam, 0); head(col.dmg, L().colDmg, 1); head(col.pts, L().colPts, 1); head(col.battles, L().colBattles, 1);
    head(col.turns, L().colTurns, 1); head(col.ap, L().colAp, 1); head(col.perAp, L().colPerAp, 1);
    var pages = Math.max(1, Math.ceil(teams.length / PER));
    var current = 0;
    var draw = function (page) {
      current = page;
      destroyAll(body);
      for (var j = 0; j < PER; j++) {
        var t = teams[page * PER + j];
        if (!t) break;
        var top = PANEL_T + 72 + j * ROW_H, cy = top + (ROW_H - 4) / 2;
        body.push(R.rexUI.add.roundRectangle(left - 4, top, right - left + 8, ROW_H - 4, 2, 0xffffff, 0.05).setOrigin(0, 0).setDepth(D + 2));
        var cardH = ROW_H - 8, cardW = Math.round(cardH * 168 / 240);
        for (var s = 0; s < 3; s++) {
          var im = cardImage(R, G, col.team + s * cardW, top + 2, cardH, t.chara[s], t.charaIndex[s], D + 3);
          if (im !== null) body.push(im);
        }
        var cell = function (x, txt) { body.push(R.add.text(x, cy, txt, valueStyle()).setOrigin(1, 0.5).setDepth(D + 3)); };
        cell(col.dmg, fmtInt(t.damage)); cell(col.pts, fmtInt(t.points)); cell(col.battles, fmtInt(t.battles)); cell(col.turns, fmtInt(t.turns));
        cell(col.ap, fmtInt(t.ap)); cell(col.perAp, perAp(t));
        var hit = R.add.zone(left - 4, top, right - left + 8, ROW_H - 4).setOrigin(0, 0).setDepth(D + 4).setInteractive({ useHandCursor: true });
        hit.on("pointerup", (function (team) {
          return function () {
            try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
            openTeam(st, R, r, name, team, function () { openTeamList(st, R, r, name, teams, current); });
          };
        })(t));
        body.push(hit);
      }
    };
    st.panelBody = body;
    addPager(R, G, D, objs, pages, draw).set(startPage || 0);
    fadeIn(R, objs.concat(body));
    st.panel = objs;
  }

  /**
   * 一支隊伍的整副：三欄，每欄一張卡面（左下角壓武器）＋右邊 3×2 的事件卡；
   * 底下一排累計與每場平均。卡名、武器名、事件卡名滑上去才出來（面板字要短）。
   * back 不是 null 時左上角一顆箭頭回清單。
   */
  function openTeam(st, R, r, name, t, back) {
    closePanel(st);
    var G = gameOf();
    var D = 3000;
    var shell = panelShell(st, R, D, false, L().teamsTitle.replace("__NAME__", name));
    var objs = shell.objs;
    var left = PANEL_L + 20, colW = (PANEL_W - 40) / 3;
    var top = PANEL_T + 46, cardH = 100, cardW = Math.round(cardH * 168 / 240);
    var evH = 48, evW = Math.round(evH * 54 / 84);
    for (var s = 0; s < 3; s++) {
      var x0 = left + s * colW;
      var card = cardImage(R, G, x0, top, cardH, t.chara[s], t.charaIndex[s], D + 2);
      if (card !== null) {
        objs.push(card);
        var crow = typeof t.chara[s] === "string" ? jsonRow(t.chara[s].indexOf("mc") === 0 ? CFG.assets.mc : CFG.assets.cc, "frames", t.charaIndex[s]) : null;
        hoverTip(R, card, localName(crow), D + 2, objs);
      }
      // 武器放卡片正下方：小圖＋名字。壓在卡面上的話 128px 的道具圖縮到看不見（實機截圖確認過）
      var wi = t.weapon[s];
      if (typeof wi === "number") {
        var wrow = jsonRow(CFG.assets.item, CFG.assets.weapon, wi);
        var wframe = wrow && typeof wrow.frame === "number" ? wrow.frame : wi;
        var wy = top + cardH + 11, wx = x0;
        if (G.textures.exists("item_weapon") && G.textures.get("item_weapon").has(wframe)) {
          objs.push(R.add.image(wx, wy, "item_weapon", wframe).setOrigin(0, 0.5).setDisplaySize(18, 18).setDepth(D + 2));
          wx += 21;
        }
        var wname = localName(wrow);
        if (wname) {
          var wt = R.add.text(wx, wy, wname, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(0, 0.5).setDepth(D + 2);
          var maxW = x0 + colW - 8 - wx;
          if (wt.width > maxW) {
            var n = wname.length;
            while (n > 1 && wt.width > maxW) { n--; wt.setText(wname.substring(0, n) + "..."); }
            hoverTip(R, wt, wname, D + 2, objs);
          }
          objs.push(wt);
        }
      }
      for (var e = 0; e < 6; e++) {
        var ei = t.eventIndex[s * 6 + e];
        if (typeof ei !== "number" || !G.textures.exists("event_asset") || !G.textures.get("event_asset").has(ei)) continue;
        var ex = x0 + cardW + 4 + (e % 3) * (evW + 3), ey = top + Math.floor(e / 3) * (evH + 4);
        var ev = R.add.image(ex, ey, "event_asset", ei).setOrigin(0, 0).setDisplaySize(evW, evH).setDepth(D + 2);
        objs.push(ev);
        hoverTip(R, ev, localName(jsonRow(CFG.assets.event, "frames", ei)), D + 2, objs);
      }
    }
    var cells = [
      [L().colDmg, fmtInt(t.damage)], [L().colPts, fmtInt(t.points)], [L().colBattles, fmtInt(t.battles)],
      [L().colTurns, fmtInt(t.turns)], [L().colAp, fmtInt(t.ap)], [L().colPerAp, perAp(t)], [L().colBest, fmtInt(t.best)]
    ];
    var cw = (PANEL_W - 40) / cells.length;
    var ly = PANEL_T + 176, vy = PANEL_T + 196;
    for (var c = 0; c < cells.length; c++) {
      var cx = left + c * cw;
      objs.push(R.add.text(cx + 4, ly, cells[c][0], labelStyle()).setOrigin(0, 0.5).setDepth(D + 2));
      objs.push(cellBar(R, cx, vy, cw - 6, D + 2));
      objs.push(R.add.text(cx + cw - 10, vy, cells[c][1], valueStyle()).setOrigin(1, 0.5).setDepth(D + 2));
    }
    // 每場平均：新手要的是「一場該花多少 AP、大概打掉多少」
    var avg = t.battles > 0 ? [[L().colDmg, fmtInt(t.damage / t.battles)], [L().colPts, fmtInt(t.points / t.battles)], [L().colTurns, (t.turns / t.battles).toFixed(1)], [L().colAp, (t.ap / t.battles).toFixed(1)]] : [];
    var ay = PANEL_T + 226;
    if (avg.length) objs.push(R.add.text(left + 4, ay, L().avg, labelStyle()).setOrigin(0, 0.5).setDepth(D + 2));
    for (var a = 0; a < avg.length; a++) {
      var ax = left + (a + 1) * cw;
      objs.push(cellBar(R, ax, ay, cw - 6, D + 2));
      objs.push(R.add.text(ax + 4, ay, avg[a][0], valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
      objs.push(R.add.text(ax + cw - 10, ay, avg[a][1], valueStyle()).setOrigin(1, 0.5).setDepth(D + 2));
    }
    if (back && G && G.textures.exists("btn_arrow")) {
      var arrow = R.add.image(PANEL_L + 24, PANEL_T + 20, "btn_arrow", 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
      arrow.on("pointerover", function () { arrow.setTexture("btn_arrow", 1); });
      arrow.on("pointerout", function () { arrow.setTexture("btn_arrow", 0); });
      arrow.on("pointerup", function () {
        try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
        back();
      });
      objs.push(arrow);
    }
    fadeIn(R, objs);
    st.panel = objs;
  }

  function openStats(st, R, r, G) {
    closePanel(st);
    var D = 3000, PER = 10, ROW_H = 18;
    var shell = panelShell(st, R, D, false, L().statsTitle + "  Lv." + r.level + " " + (r["name_" + langOf()] || r.name_tcn || ""));
    var objs = shell.objs, body = [];
    var cx = PANEL_X, left = PANEL_L + 20, right = PANEL_L + PANEL_W - 20;
    var pts = (r.points || []).slice();
    var total = 0;
    for (var i = 0; i < pts.length; i++) total += pts[i].damage || 0;
    var lost = Math.max(0, (r.hp_max || 0) - (r.hp || 0));
    var h = hist().raids[r.profound_id];
    objs.push(R.add.text(left, PANEL_T + 52, L().summary.replace("__N__", pts.length).replace("__D__", total.toLocaleString()).replace("__H__", lost.toLocaleString()), valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
    var colX = { rank: left + 22, name: left + 30, pts: left + 280, dmg: left + 360, share: left + 410, states: left + 422 };
    var hy = PANEL_T + 74;
    var head = function (x, t, o) { var ht = R.add.text(x, hy, t, labelStyle()).setOrigin(o, 0.5).setDepth(D + 2); objs.push(ht); return ht; };
    head(colX.rank, "#", 1); head(colX.name, L().colName, 0); head(colX.pts, L().colPts, 1); head(colX.dmg, L().colDmg, 1); head(colX.share, L().colShare, 1);
    // 推測的說明放 tooltip（面板字要短）：滑到「上過的狀態」才出來
    var statesHead = head(colX.states, L().colStates, 0).setInteractive({ useHandCursor: true });
    var note = L().guess + (h ? " (" + h.unique + "/" + h.events + ")" : "");
    var tip = [];
    statesHead.on("pointerover", function () {
      destroyAll(tip);
      var tt = R.add.text(right, hy - 12, note, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2, wordWrap: { width: 300 } }).setOrigin(1, 1).setDepth(D + 6);
      var bg = R.rexUI.add.roundRectangle(tt.x - tt.width / 2, tt.y - tt.height / 2, tt.width + 12, tt.height + 8, 2, 0x000000, 0.85).setDepth(D + 5);
      tip.push(bg, tt);
      objs.push(bg, tt);
    });
    statesHead.on("pointerout", function () { destroyAll(tip); });
    var rowsTop = PANEL_T + 94;
    var pages = Math.max(1, Math.ceil(pts.length / PER));
    var page = 0;
    // 自己那一列排在哪一頁就先翻到那一頁
    for (var m = 0; m < pts.length; m++) if (pts[m].name === R.player.name) { page = Math.floor(m / PER); break; }
    var draw = function (to) {
      page = to;
      destroyAll(body);
      for (var j = 0; j < PER; j++) {
        var idx = page * PER + j;
        var p = pts[idx];
        if (!p) break;
        var y = rowsTop + j * ROW_H;
        var mine = p.name === R.player.name;
        // 自己那一列：格子亮一點，不另外上色
        body.push(cellBar(R, left - 4, y, right - left + 8, D + 2, mine ? 0.14 : 0.05));
        var cell = function (x, t, o) { body.push(R.add.text(x, y, t, valueStyle()).setOrigin(o, 0.5).setDepth(D + 2)); };
        cell(colX.rank, String(idx + 1), 1);
        cell(colX.name, p.name, 0);
        // 有隊伍的人：名字點得下去，名字後面一顆牌盒（⑨）
        if (teamsOf(st, r, p.name)) {
          var nameCell = body[body.length - 1];
          var open = (function (who) { return function () { openTeams(st, R, r, who); }; })(p.name);
          clickable(nameCell, {}, open);
          var tic = teamIcon(R, G, nameCell.x + nameCell.width + 4, y, D + 2, open);
          if (tic !== null) body.push(tic);
        }
        cell(colX.pts, (p.point || 0).toLocaleString(), 1);
        cell(colX.dmg, (p.damage || 0).toLocaleString(), 1);
        cell(colX.share, total > 0 ? (100 * (p.damage || 0) / total).toFixed(1) + "%" : "-", 1);
        var codes = creditOf(r.profound_id, p.name, 5);
        var credit = h && h.credit[p.name];
        var sx = colX.states;
        for (var c = 0; c < codes.length; c++) {
          var fr = statusFrame(G, codes[c]);
          if (fr !== null) body.push(R.add.image(sx, y, CFG.sources.status, fr).setOrigin(0, 0.5).setScale(0.45).setDepth(D + 2));
          else body.push(R.add.text(sx, y, statusLabel(codes[c]).text, { fontFamily: FONT, fontSize: 10, color: "white", resolution: 2 }).setOrigin(0, 0.5).setDepth(D + 2));
          var times = credit ? credit[codes[c]] : 0;
          var tx = sx + 15;
          if (times > 1) {
            var tt = R.add.text(tx, y + 1, "x" + times, { fontFamily: FONT, fontSize: 9, color: "white", resolution: 2 }).setOrigin(0, 0.5).setDepth(D + 2);
            body.push(tt);
            tx += tt.width + 1;
          }
          sx = tx + 3;
        }
      }
    };
    st.panelBody = body;
    addPager(R, G, D, objs, pages, draw).set(page);
    fadeIn(R, objs.concat(body));
    st.panel = objs;
  }

  // ---- 自動刪除死渦 ---------------------------------------------------------
  //
  // 刪渦走官方「放棄」那一則：socket.emit("db_raid_delete", id, profound_id)。
  // HP 歸零就刪，不等結算、也不為了等結算去問伺服器（玩家 2026-09-13 訂的：不要為這個
  // 多送請求）。⚠ 刪在結算之前會不會吃掉那個渦的獎勵**沒驗過**，玩家知情選的。
  // reason 只是給托盤記錄檔分辨「自己有沒有份」。
  // 一次只刪一個，等 db_raid 回來（raid_data 換了一份）才刪下一個。
  function deadRaidPlan(R, r) {
    if (!r || typeof r.hp !== "number" || r.hp >= 1) return null;
    var me = R.player && R.player.name;
    var mine = r.profound_founder === me;
    var pts = r.points || [];
    for (var i = 0; i < pts.length; i++) if (pts[i] && pts[i].name === me && pts[i].point > 0) mine = true;
    return mine ? "had-reward" : "no-reward";
  }
  function autoDelete(st, R) {
    if (!st.autoDelete.enabled || !R.socket || !R.id) return;
    if (st.deleting && st.deleting.data === R.raid_data && Date.now() - st.deleting.at < 10000) return;
    if (R.raid_turn_back && R.raid_turn_back.visible) return;
    var data = R.raid_data || [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var why = deadRaidPlan(R, r);
      if (why === null) continue;
      // 官方 update() 用 raid_list_page 取 raid_data[i]，人停在第二頁而渦被刪到不夠一頁時
      // 會每一幀丟例外（打渦.py 踩過）。先翻回第一頁。
      R.raid_list_page = 1;
      R.socket.emit("db_raid_delete", R.id, r.profound_id);
      st.deleting = { data: R.raid_data, at: Date.now() };
      report({ type: "raid-auto-delete", name: String(r.name_tcn || ""), founder: String(r.profound_founder || ""), reason: why });
      return;
    }
  }
  function setAutoDelete(st, enabled, prompt) {
    st.autoDelete = { enabled: enabled, prompt: prompt };
    report({ type: "raid-auto-delete-setting", enabled: enabled, prompt: prompt });
  }

  // ---- ③ 詳細面板 -----------------------------------------------------------
  /** 自己在榜上第幾名。**0 分不算上榜**：0 分拿不到排名與參加獎勵（玩家 2026-09-13）。 */
  function myRank(R, r) {
    var pts = (r && r.points) || [];
    var me = R.player && R.player.name;
    for (var i = 0; i < pts.length; i++) if (pts[i] && pts[i].name === me) return pts[i].point > 0 ? i + 1 : null;
    return null;
  }
  /**
   * 官方「Rank / pts.」下面那片空白：這個渦打倒後自己拿得到的。
   * 排名（照自己現在的名次挑那一檔）、參加，自己是發現者再加發現（玩家 2026-09-13）。
   * 擊破獎勵給最後一擊的人，事先不知道是誰，不列。
   * 字照官方那一列：font_light 11 白、黑邊 3，x 對齊「Rank」。
   */
  function addExpected(R, r, cls, depth, objs) {
    var rows = [];
    var rank = myRank(R, r);
    // 0 分（或不在榜上）→ 排名、參加兩列都不畫；發現獎勵只看是不是發現者
    if (cls.entry) {
      if (rank !== null) {
        var hit = [];
        for (var i = 0; i < cls.entry.r.length; i++) {
          var it = cls.entry.r[i];
          if (typeof it.rankMin === "number" && rank >= it.rankMin && rank <= it.rankMax) hit.push(it);
        }
        rows.push([L().expRank, hit]);
        rows.push([L().expJoin, cls.entry.p]);
      }
      if (r.profound_founder === R.player.name) rows.push([L().expFind, cls.entry.d]);
    } else if (cls.fragment && rank !== null) {
      // 沒有 TL 表：只知道碎片（或硬幣）是哪一種，數量不知道
      rows.push([L().expRank, [{ item: cls.coin ? CFG.coins[cls.fragment.key] : cls.fragment.item, qty: null }]]);
    }
    var style = { fontFamily: FONT, fontSize: 11, resolution: 2 };
    var MAX_X = 505;
    for (var j = 0; j < rows.length; j++) {
      var y = 83 + j * 18;
      objs.push(R.add.text(291, y, rows[j][0], style).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 3));
      var items = rows[j][1];
      var x = 330;
      if (!items.length) {
        objs.push(R.add.text(x, y, "-", style).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 3));
        continue;
      }
      for (var k = 0; k < items.length; k++) {
        var group = [];
        var nx = addItemIcon(R, x, y, items[k].item, depth, group);
        var label = items[k].qty === null ? items[k].item : items[k].item + " ×" + items[k].qty;
        var t = R.add.text(nx, y, label, style).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 3);
        group.push(t);
        if (t.x + t.width > MAX_X) {
          destroyAll(group);
          objs.push(R.add.text(x, y, "\\u2026", style).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 3));
          break;
        }
        for (var g = 0; g < group.length; g++) objs.push(group[g]);
        x = t.x + t.width + 8;
      }
    }
  }

  function decorateInfo(st, R, G) {
    var info = R.raid_info;
    var show = alive(info) && info.visible && R.raid_idx !== null && R.raid_idx !== undefined && R.raid_data && R.raid_data[R.raid_idx];
    if (!show) {
      if (st.info) { destroyAll(st.info.objs); st.info = null; }
      return;
    }
    var r = R.raid_data[R.raid_idx];
    var states = statesOf(r);
    var key = r.profound_id + "|" + stateKey(states) + "|" + (alive(R.raid_info_name) ? R.raid_info_name.text : "");
    key = key + "|ad:" + st.autoDelete.enabled + st.autoDelete.prompt + "|rank:" + myRank(R, r) + "|founder:" + (r.profound_founder === R.player.name);
    if (st.info && st.info.key === key && st.info.objs.every(alive)) { tickTimers(st.info.timers); return; }
    if (st.info) destroyAll(st.info.objs);
    var objs = [], timers = [];
    var cls = classify(r);
    var nameT = R.raid_info_name;
    var depth = alive(nameT) ? nameT.depth + 1 : 3;
    if (alive(nameT)) {
      var x = nameT.x + nameT.width + 6;
      x = addIcons(R, x, nameT.y, iconFrames(cls), depth, 0.5, objs);
      if (typeof cls.tl === "number") {
        objs.push(R.add.text(x + 2, nameT.y, "TL " + cls.tl, { fontFamily: FONT, fontSize: 10, resolution: 2, color: "#d8d8d8" }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2));
      }
      // 名字下方那一帶（y 58–78）左半是空的：BOSS 狀態放這裡，右邊是官方的怪物名
      var monsLeft = alive(R.raid_info_mons) ? R.raid_info_mons.x - R.raid_info_mons.width - 6 : 200;
      addStatusIcons(R, G, 72, 68, states, depth, 0.65, monsLeft, objs, timers);
    }
    // 「獎勵一覽」鈕：參加獎勵那一列的右端（raid_info_point 是 470 右對齊，同一欄）
    var btn = R.add.text(470, 47, L().button, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
      .setOrigin(1, 0.5).setDepth(depth).setStroke("black", 3).setInteractive({ useHandCursor: true });
    btn.on("pointerover", function () { btn.setColor(BTN_HOVER); });
    btn.on("pointerout", function () { btn.setColor(BTN_COLOR); });
    btn.on("pointerup", function () { openPanel(st, R, r, cls); });
    objs.push(btn);
    var sbtn = R.add.text(btn.x - btn.width - 12, 47, L().stats, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
      .setOrigin(1, 0.5).setDepth(depth).setStroke("black", 3).setInteractive({ useHandCursor: true });
    sbtn.on("pointerover", function () { sbtn.setColor(BTN_HOVER); });
    sbtn.on("pointerout", function () { sbtn.setColor(BTN_COLOR); });
    sbtn.on("pointerup", function () {
      // 面板開著時資料可能又刷新過了：用現在這一份
      var cur = R.raid_data && R.raid_idx !== null ? R.raid_data[R.raid_idx] : r;
      openStats(st, R, cur || r, G);
    });
    objs.push(sbtn);
    addExpected(R, r, cls, depth, objs);
    // 死渦：自動刪除的開關鈕。Rank 下面那片放了預計獎勵，這顆移到橫幅正下方（右邊那一帶是地圖）
    if (typeof r.hp === "number" && r.hp < 1) {
      var ad = st.autoDelete;
      var label = ad.enabled ? L().autoDeleteOff : ad.prompt ? L().autoDeleteOn : null;
      if (label !== null) {
        var abtn = R.add.text(470, 140, label, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
          .setOrigin(1, 0.5).setDepth(depth).setStroke("black", 3).setInteractive({ useHandCursor: true });
        abtn.on("pointerover", function () { abtn.setColor(BTN_HOVER); });
        abtn.on("pointerout", function () { abtn.setColor(BTN_COLOR); });
        abtn.on("pointerup", function () {
          // 在遊戲裡關掉 → 鈕也收起來，要再開去插件視窗（玩家訂的）
          if (st.autoDelete.enabled) setAutoDelete(st, false, false);
          else setAutoDelete(st, true, true);
          if (st.info) { destroyAll(st.info.objs); st.info = null; }
        });
        objs.push(abtn);
      }
    }
    st.info = { key: key, objs: objs, timers: timers };
  }

  function closePanel(st) {
    if (st.panelBody) { destroyAll(st.panelBody); st.panelBody = null; }
    if (!st.panel) return;
    destroyAll(st.panel);
    st.panel = null;
  }
  /**
   * 獎勵一覽：照官方結算的獎勵頁排 —— 左邊立繪、標籤一欄、右邊一條條格子。
   * 字一律白色，顏色只留在道具小圖上（玩家 2026-09-13：自己上的色彩度太高）。
   */
  function openPanel(st, R, r, cls) {
    closePanel(st);
    var D = 3000;
    var shell = panelShell(st, R, D, true, "Lv." + r.level + " " + (r["name_" + langOf()] || r.name_tcn || "") + "   TL " + (typeof cls.tl === "number" ? cls.tl : "?"));
    var objs = shell.objs;
    addIcons(R, shell.title.x + shell.title.width / 2 + 6, shell.title.y, iconFrames(cls), D + 2, 0.5, objs);
    var left = PANEL_L + 140, ix = left + 88, cellW = PANEL_L + PANEL_W - 20 - ix;
    var y = PANEL_T + 58, LINE = 18;
    var line = function (lineY, item, txt) {
      objs.push(cellBar(R, ix, lineY, cellW, D + 2));
      var tx = ix + 5;
      if (item !== null) {
        var nx = addItemIcon(R, ix + 3, lineY, item, D + 2, objs);
        if (nx !== ix + 3) tx = nx + 2;
      }
      objs.push(R.add.text(tx, lineY, txt, valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
    };
    if (!cls.entry) {
      objs.push(R.add.text(left, y - 8, L().noTable, { fontFamily: FONT, fontSize: 12, color: "white", resolution: 2, wordWrap: { width: PANEL_L + PANEL_W - 20 - left } }).setOrigin(0, 0).setDepth(D + 2));
      if (cls.fragment) {
        y += 48;
        objs.push(R.add.text(left, y, L().ranking, labelStyle()).setOrigin(0, 0.5).setDepth(D + 2));
        line(y, cls.fragment.item, cls.coin ? CFG.coins[cls.fragment.key] : cls.fragment.item);
      }
    } else {
      var sections = [["discovery", cls.entry.d], ["participation", cls.entry.p], ["ranking", cls.entry.r], ["defeat", cls.entry.k]];
      for (var s = 0; s < sections.length; s++) {
        var items = sections[s][1];
        objs.push(R.add.text(left, y, L()[sections[s][0]], labelStyle()).setOrigin(0, 0.5).setDepth(D + 2));
        // 沒有的那一類照官方畫一格「-」
        if (!items.length) { line(y, null, "-"); y += LINE; }
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var txt = it.item + " ×" + it.qty;
          if (typeof it.rankMin === "number") txt = L().rank.replace("__A__", it.rankMin).replace("__B__", it.rankMax) + "  " + txt;
          line(y, it.item, txt);
          y += LINE;
        }
        y += 6;
      }
    }
    fadeIn(R, objs);
    st.panel = objs;
  }

  // ---- ④ SUPPORT 公開渦清單 -------------------------------------------------
  function report(payload) {
    if (!CFG.bindingName) return;
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  /**
   * 官方畫完一頁 SUPPORT 之後叫這支。記下這一頁（公開表晚一步到的時候要就地重畫），
   * 並回報整份清單的渦碼 —— 托盤拿去問 ulgg／插件互傳，查到就推 setPublic 下來。
   */
  function decorateSupport(st, sc, list, page, texts) {
    if (!alive(sc) || !texts) return;
    var draw = { sc: sc, list: list, page: page, texts: texts, ours: [] };
    st.lastSupport = draw;
    paintSupport(st, draw, 0);
    var codes = [];
    for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].prf_code === "string") codes.push(list[i].prf_code);
    if (codes.length) report({ type: "raid-codes", codes: codes });
  }
  /** 把我們畫在那一頁上的東西清掉重畫。alpha 0 = 官方正要淡入（它的 tween 會連我們一起帶）。 */
  function paintSupport(st, draw, alpha) {
    var sc = draw.sc, list = draw.list, page = draw.page, texts = draw.texts;
    for (var d = 0; d < draw.ours.length; d++) {
      var at = texts.indexOf(draw.ours[d]);
      if (at !== -1) texts.splice(at, 1);
      safeDestroy(draw.ours[d]);
    }
    draw.ours = [];
    var G = gameOf();
    if (!G || !alive(sc) || !ensureIcons(G, sc)) return;
    for (var n = 0; n < 12; n++) {
      var a = n + 12 * (page - 1);
      var row = list[a];
      var nameT = texts[6 * n], boss = texts[6 * n + 1];
      if (!row || !alive(nameT) || !alive(boss)) continue;
      var info = st.publicMap[row.prf_code];
      if (!info) continue;
      var cls = classify({ treasure_level: info.tl, rarity: info.rarity, stage: info.stage, profound_mons: info.mons || row.prf_mons });
      var out = [];
      // 玩家 2026-09-13：「排名獎勵和狀態類型分開，不然太擠」——
      // 圖示接在左欄 RAID 名字後面，狀態接在 BOSS 欄後面（發現者欄 321 起）。
      addIcons(sc, nameT.x + nameT.width + 4, nameT.y, iconFrames(cls), nameT.depth, 0.5, out);
      if (info.states && info.states.length) addStatusIcons(sc, G, boss.x + boss.width + 4, boss.y, info.states, boss.depth, 0.55, 318, out, st.supportTimers);
      for (var i = 0; i < out.length; i++) { out[i].setAlpha(alpha); texts.push(out[i]); draw.ours.push(out[i]); }
    }
    st.supportTimers = st.supportTimers.filter(function (t) { return alive(t.text); });
  }
  st_repaintSupport = function (st) {
    var d = st.lastSupport;
    if (!d || !d.texts.some(alive)) { st.lastSupport = null; return; }
    paintSupport(st, d, 1);
  };
  function hookSupport(st, R) {
    var proto = Object.getPrototypeOf(R);
    if (!proto || typeof proto.raid_support_list !== "function") return;
    var cur = proto.raid_support_list;
    // 已經是這一份掛的就不動；是上一份留下的包裝（沒拆乾淨）就從它記的原版重包
    if (cur.__ulrRaidView && st.supportProto === proto) return;
    var orig = cur.__ulrRaidView || cur;
    var wrapped = function (list, y, page) {
      var out = orig.apply(this, arguments);
      try { decorateSupport(window[FLAG], this, list, page, out && out.texts); }
      catch (e) { var s = window[FLAG]; if (s) s.reason = "support: " + String((e && e.message) || e); }
      return out;
    };
    wrapped.__ulrRaidView = orig;
    proto.raid_support_list = wrapped;
    st.supportProto = proto;
  }
  function unhookSupport(st) {
    var proto = st.supportProto;
    if (proto && proto.raid_support_list && proto.raid_support_list.__ulrRaidView) {
      proto.raid_support_list = proto.raid_support_list.__ulrRaidView;
    }
    st.supportProto = null;
  }

  // ---- ⑤ 定時重讀 db_raid ---------------------------------------------------
  /** 官方只在進房與打完才更新清單；狀態被延長、血被打掉都要自己問。分頁藏著就不問。 */
  function refresh(st, R) {
    var now = Date.now();
    if (now - st.lastRefresh < CFG.refreshMs) return;
    if (document.hidden) return;
    st.lastRefresh = now;
    try { if (R.socket && R.id) { R.socket.emit("db_raid", R.id); st.awaitRebuild = true; } } catch (e) {}
  }

  // ---- ⑩ 更新鈕 -------------------------------------------------------------
  /**
   * 照官方打完回渦房（Result.result_exit）送的那三則：db_player（AP）、db_raid（渦清單）、
   * db_raid_reward（結算）。等於離開重進渦房，不多送官方沒有的東西。
   * 回報 raid-refresh 讓托盤同時重查 ulgg／插件雲端。冷卻中按了不算。
   */
  function manualRefresh(st, R) {
    var now = Date.now();
    if (now - st.lastManual < CFG.manualCooldownMs) return false;
    if (!R.socket || !R.id) return false;
    st.lastManual = now;
    st.lastRefresh = now;   // 自動那一輪從現在重新算，不要剛按完又馬上補問
    try {
      R.socket.emit("db_player", R.id);
      R.socket.emit("db_raid", R.id);
      R.socket.emit("db_raid_reward", R.id);
      st.awaitRebuild = true;
    } catch (e) { return false; }
    report({ type: "raid-refresh" });
    return true;
  }
  /** Profound 計數（profound_text，右下對齊的大數字）下面、跟「/10」同一條左緣。 */
  function decorateRefresh(st, R) {
    var anchor = R.profound_text;
    if (!alive(anchor)) {
      if (st.refreshBtn) { destroyAll(st.refreshBtn.objs); st.refreshBtn = null; }
      return;
    }
    var x = Math.round(anchor.x + 8), y = Math.round(anchor.y + 9);
    var rb = st.refreshBtn;
    if (rb && rb.anchor === anchor && rb.x === x && rb.y === y && alive(rb.btn)) {
      var cooling = Date.now() - st.lastManual < CFG.manualCooldownMs;
      if (rb.btn.alpha !== (cooling ? 0.5 : 1)) rb.btn.setAlpha(cooling ? 0.5 : 1);
      return;
    }
    if (rb) destroyAll(rb.objs);
    var objs = [];
    var btn = R.add.text(x, y, L().refresh, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
      .setOrigin(0, 0.5).setDepth((anchor.depth || 0) + 1).setStroke("black", 3);
    objs.push(btn);
    hoverTip(R, btn, L().refreshTip, (anchor.depth || 0) + 1, objs);
    btn.setInteractive({ useHandCursor: true });
    btn.on("pointerover", function () { btn.setColor(BTN_HOVER); });
    btn.on("pointerout", function () { btn.setColor(BTN_COLOR); });
    btn.on("pointerup", function () {
      if (!manualRefresh(st, R)) return;
      try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
      btn.setAlpha(0.5);
    });
    st.refreshBtn = { anchor: anchor, x: x, y: y, btn: btn, objs: objs };
  }

  // ---- ⑨ 記一場：raid_ready 開打 → 回渦房後量傷害 ----------------------------
  function slotsOf(v, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var x = v && v[i] !== undefined ? v[i] : null;
      out.push(x === null || typeof x === "string" || typeof x === "number" ? x : null);
    }
    return out;
  }
  function deckCopy(d) {
    if (!d || !d.chara || !d.charaIndex) return null;
    var deck = { chara: slotsOf(d.chara, 3), charaIndex: slotsOf(d.charaIndex, 3), weapon: slotsOf(d.weapon, 3), eventIndex: slotsOf(d.eventIndex, 18) };
    for (var i = 0; i < 3; i++) if (typeof deck.chara[i] === "string") return deck;
    return null;
  }
  /** 榜上某人那一列的 damage／point（不在榜上當 0）。 */
  function scoreOf(r, name) {
    var pts = (r && r.points) || [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p && p.name === name) return { damage: typeof p.damage === "number" ? p.damage : 0, point: typeof p.point === "number" ? p.point : 0 };
    }
    return { damage: 0, point: 0 };
  }
  function sameSlots(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  /**
   * 伺服器說開打了：記下這一場。config 是伺服器給這場戰鬥的設定（2026-09-13 實機讀的）：
   * turn_limit 是伺服器收下的回合數、room_playerAdeck 是它拿來打的牌（沒有事件卡）。
   * 回合數以 turn_limit 為準；牌組用場景上的 deck{deck_now}（有 18 格事件卡），
   * 角色跟伺服器那份對不上就改用伺服器的、事件卡留空 —— 寧可少畫，不要畫錯。
   */
  function onRaidReady(config) {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      var R = G && G.scene.keys.Raid;
      if (!R || !R.player || typeof R.player.name !== "string") return;
      var r = raidById(R, R.raid_id);
      var prev = window[BATTLE];
      if (prev && prev.away) settleEarly(prev, R, r ? r.profound_id : R.raid_id);
      window[BATTLE] = null;
      // 同一個渦之後才進帳的分數算新這一場的（它的「開打前」已經讀不到了），
      // 別的渦的補報照留
      window[TAIL] = tails().filter(function (t) { return t.b.id !== (r ? r.profound_id : R.raid_id); });
      var deck = deckCopy(R["deck" + R.deck_now]);
      var sv = config && config.room_playerAdeck;
      if (sv && sv.chara && sv.charaIndex) {
        var same = deck && sameSlots(deck.chara, slotsOf(sv.chara, 3)) && sameSlots(deck.charaIndex, slotsOf(sv.charaIndex, 3));
        if (!same) deck = deckCopy({ chara: sv.chara, charaIndex: sv.charaIndex, weapon: sv.weapon, eventIndex: [] });
      }
      var turns = config && typeof config.turn_limit === "number" ? config.turn_limit : R.raid_turn;
      if (!r || typeof r.pass !== "string" || !deck || typeof turns !== "number" || turns < 1) return;
      var spend = typeof r.ap_spend === "number" ? r.ap_spend : 1;
      window[BATTLE] = {
        id: r.profound_id, code: r.pass, player: R.player.name, limit: r.limit,
        turns: turns, ap: spend * turns, deck: deck, before: scoreOf(r, R.player.name),
        at: Date.now(), away: false, seen: null
      };
    } catch (e) { st.reason = "raid_ready: " + String((e && e.message) || e); }
  }
  /**
   * 上一場還沒量完就又開打了：用這一刻的榜把它結算掉，不要被新的蓋掉。
   *
   * ⚠ 2026-09-13 實機（打渦.py 直連回渦房、一秒內再按 START）：同一個渦連打 3 場只記到
   * 1 場。原本要等「回渦房後清單換過一份」才量，而連打時清單還沒換、下一場的 raid_ready
   * 就先到，把上一場整格蓋掉。那一刻的榜其實是新的（三場的開打前分數 3600→7106→14231），
   * 拿它結算就對得上。之後才進帳的分數：同一個渦算下一場的，別的渦留一條補報。
   */
  function settleEarly(prev, R, nextId) {
    if (Date.now() - prev.at > CFG.battleMaxMs) return;
    var r = raidById(R, prev.id);
    if (!r) return;
    var now = scoreOf(r, prev.player);
    var points = Math.max(0, now.point - prev.before.point);
    var damage = Math.max(0, now.damage - prev.before.damage);
    report(battleReport(prev, damage, points));
    if (prev.id !== nextId) addTail(prev, damage, points, R.raid_data);
  }
  /** 補報清單。上一版是單一物件，重裝接手時轉成清單。 */
  function tails() {
    var t = window[TAIL];
    if (!t) t = [];
    else if (!Array.isArray(t)) t = [t];
    window[TAIL] = t;
    return t;
  }
  function addTail(b, damage, points, data) {
    var list = tails().filter(function (t) { return t.b.id !== b.id; });
    list.push({ b: b, damage: damage, points: points, data: data, until: Date.now() + CFG.tailMs });
    window[TAIL] = list;
  }
  /** Raid 場景 shutdown 會斷掉 socket，下次進房是新的一顆：換過就重掛。 */
  function hookReady(st, R) {
    var s = R.socket;
    if (!s || typeof s.on !== "function" || st.readySocket === s) return;
    unhookReady(st);
    s.on("raid_ready", onRaidReady);
    st.readySocket = s;
    st.readyHandler = onRaidReady;
  }
  /** 拆的是**當初掛上去的那一支**（記在 st 上）：重裝後新腳本的 onRaidReady 是另一個函式。 */
  function unhookReady(st) {
    try { if (st.readySocket && st.readyHandler && typeof st.readySocket.off === "function") st.readySocket.off("raid_ready", st.readyHandler); } catch (e) {}
    st.readySocket = null;
    st.readyHandler = null;
  }
  /**
   * 回到渦房之後：第一眼看到的 raid_data 先記著（可能是開打前那一問晚到的），
   * 換過一份才量。渦不見了就不記（量不到的傷害不猜）。
   */
  function battleReport(b, damage, points) {
    return { type: "raid-battle", code: b.code, player: b.player, limit: b.limit, turns: b.turns, ap: b.ap,
      damage: damage, points: points, deck: b.deck, at: b.at };
  }
  function settleBattle(st, R) {
    settleTail(R);
    var b = window[BATTLE];
    if (!b) return;
    if (Date.now() - b.at > CFG.battleMaxMs) { window[BATTLE] = null; return; }
    if (!b.away) return;
    if (b.seen === null) { b.seen = R.raid_data; return; }
    if (R.raid_data === b.seen) return;
    window[BATTLE] = null;
    var r = raidById(R, b.id);
    if (!r) return;
    var now = scoreOf(r, b.player);
    var points = Math.max(0, now.point - b.before.point);
    var damage = Math.max(0, now.damage - b.before.damage);
    report(battleReport(b, damage, points));
    // 提早離場的話分數會晚幾分鐘才進帳（打渦.py 實測）：之後漲的都算這一場，補一次更新
    addTail(b, damage, points, R.raid_data);
  }
  function settleTail(R) {
    var list = tails().filter(function (t) { return Date.now() <= t.until; });
    window[TAIL] = list;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (R.raid_data === t.data) continue;
      t.data = R.raid_data;
      var r = raidById(R, t.b.id);
      if (!r) continue;
      var now = scoreOf(r, t.b.player);
      var points = Math.max(0, now.point - t.b.before.point);
      var damage = Math.max(0, now.damage - t.b.before.damage);
      if (points <= t.points && damage <= t.damage) continue;
      t.points = points;
      t.damage = damage;
      report(battleReport(t.b, damage, points));
    }
  }

  // ---- 主迴圈 ---------------------------------------------------------------
  function raidScene(G) {
    var R = G.scene.keys.Raid;
    try {
      if (!R || !R.scene || !R.scene.isActive() || R.scene.isSleeping()) return null;
      if (!R.raid_data || !R.player) return null;
    } catch (e) { return null; }
    return R;
  }
  function clearAll(st) {
    for (var i = 0; i < st.rows.length; i++) if (st.rows[i].__ulrRaidView) { destroyAll(st.rows[i].__ulrRaidView.objs); st.rows[i].__ulrRaidView = null; }
    st.rows = [];
    undoMap(st);
    if (st.info) { destroyAll(st.info.objs); st.info = null; }
    if (st.refreshBtn) { destroyAll(st.refreshBtn.objs); st.refreshBtn = null; }
    closePanel(st);
    st.supportTimers = [];
    for (var j = 0; j < st.rank.length; j++) if (st.rank[j].__ulrRaidRank) { destroyAll(st.rank[j].__ulrRaidRank.objs); unclickable(st.rank[j], st.rank[j].__ulrRaidRank); st.rank[j].__ulrRaidRank = null; }
    st.rank = [];
    st.lastData = null;
  }
  /**
   * 畫面上的標記：**每一幀**在 Raid 場景的 postupdate 跑（玩家 2026-09-13：「畫面更新能做到
   * 不延遲嗎」）。官方的點擊處理（開／關詳細面板、翻頁）與 db_raid 回來後的重建都在同一幀
   * 的 update 裡、比 postupdate 早，所以這裡看到的永遠是這一幀的最終狀態，畫出去之前就
   * 補好或收掉 —— 不會有「回到清單後按鈕殘留一下」「渦閃一下藍色」。
   * 每一步都有 key 快取，沒變就只比字串，一幀的成本很小。
   */
  function decorate(st, R, G) {
    if (!G.textures.exists(ICON_TEX)) return;
    if (observe(st, R) && st.awaitRebuild) { st.awaitRebuild = false; rebuildRanking(R); }
    settleBattle(st, R);
    decorateRefresh(st, R);
    decorateList(st, R, G);
    decorateMap(st, R, G);
    decorateInfo(st, R, G);
    decorateRanking(st, R, G);
  }
  function hookFrame(st, R) {
    if (st.frameScene === R && st.frameHandler) return;
    unhookFrame(st);
    if (!R.events || typeof R.events.on !== "function") return;
    var handler = function () {
      if (window[FLAG] !== st) return;
      try {
        var G = gameOf();
        if (!G || raidScene(G) !== R) return;
        st.lastFrame = Date.now();
        decorate(st, R, G);
      } catch (e) {
        st.reason = String((e && e.message) || e);
      }
    };
    R.events.on("postupdate", handler);
    st.frameScene = R;
    st.frameHandler = handler;
  }
  function unhookFrame(st) {
    try { if (st.frameScene && st.frameHandler) st.frameScene.events.off("postupdate", st.frameHandler); } catch (e) {}
    st.frameScene = null;
    st.frameHandler = null;
  }
  /**
   * 輪詢只管「進出渦房」與不必逐幀的事（掛上逐幀、刪死渦、重讀 db_raid、SUPPORT 的倒數）。
   * 逐幀那條還沒在跑（剛進房、或環境沒有 scene events）時由這裡代跑一次畫面標記。
   */
  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      var R = G ? raidScene(G) : null;
      if (!R) {
        if (st.inRaid) clearAll(st);
        st.inRaid = false;
        st.lastRefresh = Date.now();   // 進房後先等一輪，不要一進來就補問
        var b = window[BATTLE];
        if (b && !b.away) b.away = true;   // 開打了、人離開渦房：回來之後才量
        return;
      }
      st.inRaid = true;
      hookReady(st, R);
      if (!ensureIcons(G, R)) return;
      ensureSkin(st, G);   // 面板底圖先抓好，第一次開面板就是遊戲的樣子
      hookSupport(st, R);
      hookFrame(st, R);
      if (Date.now() - st.lastFrame > CFG.pollIntervalMs * 2) decorate(st, R, G);
      autoDelete(st, R);
      tickTimers(st.supportTimers);
      refresh(st, R);
      st.reason = null;
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }
  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { unhookFrame(st); } catch (e) {}
    try { clearAll(st); } catch (e) {}
    try { unhookSupport(st); } catch (e) {}
    try { unhookReady(st); } catch (e) {}
    dropTextures();
    delete window[FLAG];
  }
  /**
   * 圖示格與灰階漩渦是 canvas 貼圖，建一次就留在遊戲裡。重裝時不卸掉的話
   * ensureIcons 看到鍵已存在就跳過，新版的畫法永遠不會生效（v3 換成遊戲圖示時
   * 就這樣：頁面上還是 v1 自己畫的菱形）。先收掉用到它們的物件（clearAll）再卸。
   */
  function dropTextures() {
    var G = gameOf();
    if (!G) return;
    try { if (G.anims && G.anims.exists && G.anims.exists(GRAY_ANIM) && G.anims.remove) G.anims.remove(GRAY_ANIM); } catch (e) {}
    try { if (G.textures.exists(ICON_TEX) && G.textures.remove) G.textures.remove(ICON_TEX); } catch (e) {}
    try { if (G.textures.exists(GRAY_TEX) && G.textures.remove) G.textures.remove(GRAY_TEX); } catch (e) {}
    try { if (G.textures.exists(PANEL_TEX) && G.textures.remove) G.textures.remove(PANEL_TEX); } catch (e) {}
    try { if (G.textures.exists(CHAR_TEX) && G.textures.remove) G.textures.remove(CHAR_TEX); } catch (e) {}
  }

  restore();
  var st = {
    version: CFG.version,
    inRaid: false,
    rows: [],
    map: [],
    info: null,
    panel: null,
    publicMap: CFG.publicMap || {},
    teams: CFG.teams || {},
    refreshBtn: null,
    lastManual: 0,
    readySocket: null,
    readyHandler: null,
    supportProto: null,
    supportTimers: [],
    rank: [],
    lastSupport: null,
    autoDelete: CFG.autoDelete,
    deleting: null,
    repaintSupport: function () { try { st_repaintSupport(st); } catch (e) {} },
    lastData: null,
    awaitRebuild: false,
    panelBody: null,
    skin: null,
    frameScene: null,
    frameHandler: null,
    lastFrame: 0,
    lastRefresh: Date.now(),
    timer: null,
    reason: null
  };
  window[FLAG] = st;
  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();
  return JSON.stringify({
    installed: true, version: st.version, inRaid: st.inRaid,
    rows: st.rows.length, vortices: st.map.length,
    publicCount: Object.keys(st.publicMap).length, reason: st.reason
  });
})()`;
}

export const RAID_VIEW_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, inRaid: false, rows: 0, vortices: 0, publicCount: 0, reason: null });
    return JSON.stringify({
      installed: true, version: st.version, inRaid: !!st.inRaid,
      rows: st.rows.length, vortices: st.map.length,
      publicCount: Object.keys(st.publicMap || {}).length, reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, inRaid: false, rows: 0, vortices: 0, publicCount: 0, reason: String((e && e.message) || e) });
  }
})()`;

/**
 * 自己渦清單上的渦（插件互傳要上傳的那一份）。人不在渦房就回空的 ——
 * 離開渦房後場景上的 raid_data 還留著，但那是舊的。
 */
export const RAID_VIEW_SNAPSHOT_EXPRESSION = `(function () {
  try {
    var G = window.game;
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Raid : null;
    if (!R || !R.scene || !R.scene.isActive() || R.scene.isSleeping() || !R.raid_data) return JSON.stringify({ raids: [] });
    var now = Date.now();
    var num = function (v) { return typeof v === "number" && isFinite(v) ? v : null; };
    var out = [];
    for (var i = 0; i < R.raid_data.length; i++) {
      var r = R.raid_data[i];
      if (!r || typeof r.pass !== "string" || !(r.limit > now)) continue;
      var states = [];
      var ss = r.state || [];
      for (var k = 0; k < ss.length; k++) {
        var s = ss[k];
        if (!s || typeof s.type !== "string") continue;
        var t = typeof s.turn === "number" ? s.turn : null;
        var timed = t !== null && t > 1e11;
        if (timed && t <= now) continue;
        states.push({ type: s.type, until: timed ? t : null, count: timed || t === null ? null : t });
      }
      var players = [];
      var pts = r.points || [];
      for (var p = 0; p < pts.length; p++) if (pts[p] && typeof pts[p].name === "string") players.push(pts[p].name);
      out.push({ code: r.pass, tl: num(r.treasure_level), rarity: num(r.rarity), stage: num(r.stage),
        mons: typeof r.profound_mons === "string" ? r.profound_mons : null,
        hp: num(r.hp), hpMax: num(r.hp_max), limit: r.limit, states: states, players: players });
    }
    return JSON.stringify({ raids: out });
  } catch (e) {
    return JSON.stringify({ raids: [], reason: String((e && e.message) || e) });
  }
})()`;

export function parseRaidViewSnapshot(raw: string): RaidSnapshotRow[] {
  try {
    const o = JSON.parse(raw) as { raids?: unknown };
    return Array.isArray(o.raids) ? (o.raids as RaidSnapshotRow[]) : [];
  } catch {
    return [];
  }
}

/** 托盤推自動刪除的設定下來。回 "ok" / "not-installed"。 */
export function buildRaidViewSetAutoDeleteExpression(setting: RaidAutoDeleteSetting): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.autoDelete = JSON.parse(${embedJson({ enabled: setting.enabled, prompt: setting.prompt })});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 把托盤查到的公開渦表推下去。回 "ok" / "not-installed"。 */
export function buildRaidViewSetPublicExpression(map: RaidPublicMap): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.publicMap = JSON.parse(${embedJson(map)});
    // SUPPORT 那一頁已經畫出來了的話就地重畫（查詢是畫完才開始的，一定晚一步）
    if (typeof st.repaintSupport === "function") st.repaintSupport();
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/**
 * 把托盤整理好的隊伍表推下去（⑨）。回 "ok" / "not-installed"。
 * 排行榜的標記下一幀就照新表重畫（key 含隊伍數）；開著的面板不動。
 */
export function buildRaidViewSetTeamsExpression(teams: RaidTeamsMap): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.teams = JSON.parse(${embedJson(teams)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 拆掉：圖示收掉、地圖渦換回官方貼圖、SUPPORT 的包裝拆掉。 */
export const RAID_VIEW_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    var kill = function (o) { try { if (o && o.scene) o.destroy(); } catch (e) {} };
    for (var i = 0; i < st.rows.length; i++) {
      var d = st.rows[i].__ulrRaidView;
      if (d) { d.objs.forEach(kill); st.rows[i].__ulrRaidView = null; }
    }
    for (var j = 0; j < st.map.length; j++) {
      var m = st.map[j];
      m.extras.forEach(kill);
      if (m.icon && m.icon.scene && m.icon.__ulrOrig) {
        try { m.icon.anims.stop(); m.icon.clearTint(); m.icon.setTexture(m.icon.__ulrOrig.key, m.icon.__ulrOrig.frame); m.icon.play(m.icon.__ulrOrig.anim); } catch (e) {}
      }
      if (m.base && m.base.scene) { try { m.base.clearTint(); } catch (e) {} }
    }
    if (st.info) st.info.objs.forEach(kill);
    if (st.refreshBtn) st.refreshBtn.objs.forEach(kill);
    try { if (st.frameScene && st.frameHandler) st.frameScene.events.off("postupdate", st.frameHandler); } catch (e) {}
    if (st.panel) st.panel.forEach(kill);
    if (st.panelBody) st.panelBody.forEach(kill);
    (st.rank || []).forEach(function (n) {
      var d = n.__ulrRaidRank;
      if (!d) return;
      d.objs.forEach(kill);
      var c = d.click;
      if (c && n.scene) {
        try { n.off("pointerover", c.over); n.off("pointerout", c.out); n.off("pointerup", c.up); n.setColor(c.color); if (n.disableInteractive) n.disableInteractive(); } catch (e) {}
      }
      n.__ulrRaidRank = null;
    });
    try { if (st.readySocket && st.readyHandler) st.readySocket.off("raid_ready", st.readyHandler); } catch (e) {}
    try {
      var G = window.game;
      if (G && G.anims && G.anims.exists && G.anims.exists("__ulrVortexGray") && G.anims.remove) G.anims.remove("__ulrVortexGray");
      ["__ulrRaidIcons", "__ulrVortexGray", "__ulrRaidPanel", "__ulrRaidPanelChar"].forEach(function (k) { if (G && G.textures.exists(k) && G.textures.remove) G.textures.remove(k); });
    } catch (e) {}
    var proto = st.supportProto;
    if (proto && proto.raid_support_list && proto.raid_support_list.__ulrRaidView) proto.raid_support_list = proto.raid_support_list.__ulrRaidView;
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseRaidViewStatus(raw: string): RaidViewStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      inRaid: false,
      rows: 0,
      vortices: 0,
      publicCount: 0,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    inRaid: o.inRaid === true,
    rows: num(o.rows),
    vortices: num(o.vortices),
    publicCount: num(o.publicCount),
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
