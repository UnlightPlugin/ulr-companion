/**
 * 渦房的獎勵標記：清單圖示、地圖標記、獎勵一覽、更新鈕、自動刪死渦、打渦隊伍
 * ================================================================
 * 官方渦房畫面上**看不出**一個渦打倒後排名獎勵是什麼。這支把它畫出來：
 *
 * ```
 *   ① 清單列（raid_list_displayed[t].raid_name）：名字右邊接碎片色（菱形；渦幣是圓）＋
 *      排名第一檔碎片以外的東西（魔之素材、書籤…用遊戲的道具圖）
 *   ② 地圖渦（raid_vortex[i]）：漩渦換成灰階再上碎片色，**不知道的就是灰色**（不留官方的藍／紅，
 *      會被當成碎片色）；素材等掛在上方；自己開的渦 base 紅框。
 *      順手修官方 bug：滑上別人的渦永遠亮清單第一列（官方拿 null 的 code 對列）
 *   ③ 詳細面板（create_raid_detail）：名字右邊接小圖、右端一顆「獎勵一覽」
 *      → 開一張面板列 發現／參加／排名（每一檔）／擊破；自己現在那一檔亮一點。
 *      底圖用官方結算那張 raid_result_panel，OK 鈕 raid_panel_ok。
 *      「Points」滑上去是分數公式的 tooltip。Rank 換成從榜上算的（伺服器的 player_rank 會錯）
 *   ⑧ 自動刪除死渦：HP 歸零就走官方「放棄」刪掉；自己有份的等結算收到了才刪
 *   ⑨ 打渦隊伍（玩家 2026-09-13：「點玩家可以看得到打渦用的隊伍……新手玩家不知該用
 *      哪個隊伍，該花費多少AP來打」）：
 *      · 記：開打時讀戰鬥設定（渦、回合、牌組），戰鬥中加總自己攻擊的 damage_opponent，回渦房後
 *        讀榜上分數相減，回報 raid-battle（細節在「⑨ 打渦隊伍：記一場」那段）
 *      · 看：托盤把自己的紀錄＋插件互傳查到的別人的推下來（setTeams）。詳細面板排行榜上
 *        有隊伍的名字後面掛 deck_icon、點得下去；一支直接開，多支先列清單
 *   ⑩ 更新鈕：Profound 計數（raid_owned）下面一顆「Refresh」＝重進渦房
 *   ⑪ 渦碼沒回應時解開畫面（官方 bug，見下）
 *   ⑫ SUPPORT 公開清單：名字右邊接碎片色（只看公開渦表，見「⑫ SUPPORT 公開清單」那段）
 *   ⑬ BOSS 被動（硬化／吸收／潛伏／濁濫／夜霧／隱身／收穫／磁暴）：伺服器不送，照規則算（見「BOSS 被動」那段）。
 *      清單列與詳細面板排在 BOSS 狀態前面，SUPPORT 接在 BOSS 名右邊；狗的硬化／吸收帶剩餘時間
 * ```
 *
 * ## ⑪ 輸入渦碼後整個渦房點不動（2026-09-26 實機查到的）
 *
 * 官方渦碼輸入框的送出鈕：
 *
 * ```
 *   this.input.enabled = false
 *   if (await socket.fetch("raid_code_input", 碼) !== false) {
 *     重拿 db_raid、重畫清單與地圖 ... this.input.enabled = true
 *   }
 * ```
 *
 * 伺服器對**自己已經參加的渦**的碼什麼都不回（8 種錯誤碼裡沒有這一種，raid_error 也不送），
 * fetch 等到逾時就 reject，而那個 handler 沒接 —— 點擊就永遠關著，只能重載。
 * 逾時的例外會變成 unhandledrejection（官方自己也掛了一個，只 reportError＋preventDefault，
 * 不擋別的監聽）。所以這支在 window 上聽它：訊息是 raid_code_input 逾時、渦房開著、點擊關著
 * → 用官方自己的 raid_error 跳錯誤框（官方底圖與 OK 鈕，最後一行它自己會把點擊打開）。
 * 錯誤框的字從 RaidUITexts.error 用鍵查，所以先塞一個自己的鍵進去（拆除時拿掉）。
 * 不包 fetch（渦房那顆 socket 的 fetch 已經被 patch-room-gate 包在實例上），也不多送任何請求。
 *
 * ## 碎片色從哪來：ulgg 的 stage 優先，再來是邊打邊學
 *
 * 2026-09-23 改版後清單沒有 treasure_level／stage，舊的 TL 表對不上。碎片與渦幣沒消失，
 * 改成**角色卡**：Characters 的 cmem_0..4（記憶～死亡）、ccoin_0..4（鐵～白金），獎勵碼 type 1。
 *
 * - 自己看到的 stage 最優先：打這個渦時戰鬥設定 MainA.room_config.stage（"002"）、自己發現渦時
 *   伺服器送的 raid_title（raid_stage）。記在 window.__ulrRaidStages（重裝不清，遊戲重載就沒了）
 * - 再來是 ulgg 觀測站給的 stage_id。都套舊公式 (rarity==6 ? stage+1 : stage) % 5。
 *   2026-09-25 兩個實測（龍鯰 stage 1→記憶、誘引之者 stage 3→靈魂）都對；拿 map_index 套則兩個都錯。
 *   別人開的渦清單上沒有渦碼（code 是 null），用到期時刻（limit＝ulgg 的 expires_at）＋發現者對
 * - 沒有就看學到的表（見下）排名第一檔的碎片；第一名的碎片對不上過（fragConflict）就不拿來畫
 * - 再沒有就照怪＋區塊推 stage（raid-treasure.ts 的 raidStageByMap：每隻怪佔連續 5 個區塊、
 *   依序 stage 1～5；只有 Lv1、五隻怪有證據）
 * - 後兩種是推測：清單上畫空心、地圖漩渦半透明，跟 stage 算的分開（玩家 2026-09-25）
 * - 都沒有就不畫 —— 不猜
 *
 * ## 獎勵表：邊打邊學（見 raid-learned.ts）
 *
 * 所以不猜：patch-raid-reward 把每次結算的原始獎勵碼記在
 * window.__ulrRaidRewardSeen（raw），這支拿 profound_id 對回自己記著的清單列
 * （window.__ulrRaidMeta：怪、階、★、區塊），回報 raid-learn 給托盤；托盤併進
 * ~/.ulr-companion/raid-learned.json 再推下來（setLearned）。**還沒學到的渦什麼都不畫**。
 *
 * ## 改版後拿掉的（2026-09-25，資料沒了）
 *
 * 清單不再有 state（BOSS 狀態）、榜上沒有 damage，所以「誰上了狀態」與
 * 傷害統計做不了；BOSS 狀態改成開打那一刻從戰鬥裡讀（MainA._chara1.state，見「BOSS 狀態」
 * 那段），自己看到的＋插件互傳的畫在清單列與詳細面板。打渦隊伍的傷害改成戰鬥中自己加總（⑨）。
 * SUPPORT 公開清單的 raid_support_list 從原型方法變成場景上的陣列，包原型那招失效；
 * 2026-10-04 改成逐幀掛碎片色（⑫），TL／狀態圖示沒移植。
 * 10 秒自動重讀 db_raid 也拿掉：官方不會自己送，要看最新的按 Refresh。
 *
 * ## 資料（2026-09-25 從跑著的客戶端讀的）
 *
 * ```
 *   Raid.raid_list[i] = { name, info, level, limit, rank[{player_name, point, level}], hp, hp_max,
 *                         rarity, ap, founder, code, player_point, player_rank, monster_id,
 *                         pos_index, map_index, category, profound_id, only_friend,
 *                         reward[{type,id,slot,value}]（參加獎勵）, found_at }
 *   Raid.raid_list_displayed[t] = { code, limit, found_at, zone, select, base, raid_name,
 *                         limit_text, point, hp_text, hp_guage, rarity, ap, founder }
 *                         ← 第 t 列是 raid_list[5*(list_page_now-1)+t]，refresh_raid_list 整批重建
 *   Raid.raid_vortex[i] = { base: vortex_{category}_base, icon: vortex_{category}, id: profound_id }
 *                         ← show_vortex 整批重建
 *   create_raid_detail(row) 畫 raid_detail_*；destroy_raid_detail 收掉。哪一列沒記在場景上 →
 *                         包原型記下來（__ulrRaidDetailRow）
 *   道具圖：AvatarItemImages 的 item_{id}（或 AvatarItems 列上的 texture_key/texture_frame）、
 *          WeaponCardImages 的 weapon_{id}、EventCardImages 的 event_{id}
 * ```
 *
 * ## ⑩ 更新鈕送什麼
 *
 * 進渦房是 init（update_data player_ap、fetch db_raid）＋ create（排序、清單、show_vortex、
 * show_raid_reward）。update_data 是模組私有的，照它的做法直接 fetch db_player_ap
 * （純讀取），畫面照官方 socket.on("player_ap") 那支重畫；**不送 ap_recover**（那是
 * 「回復 AP」請求）。db_raid 回來照官方放棄渦那條路重排、重畫；詳細面板開著就照點地圖渦
 * 那條路重開；最後叫官方自己的 show_raid_reward（要結算、演、回報領取）。
 *
 * ## 為什麼逐幀補掛
 *
 * 清單列與地圖渦每次都整批 destroy 重建，拿不到建它們的地方。所以在 Raid 場景的
 * postupdate 看一眼（旗標記在 GameObject 上，場景物件是長命的），沒掛過就補、物件死了就收。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";
import { RAID_STATUS_COLORS, RAID_STATUSES } from "./raid-status.js";
import { RAID_PASSIVE_COLOR, RAID_PASSIVE_RULES } from "./raid-passive.js";
import { RAID_SUPPORT_HOOK_BODY } from "./raid-support.js";
import {
  RAID_FRAGMENTS,
  RAID_MAP_COUNT,
  RAID_OWN_FRAME_TINT,
  RAID_STAGE_START_MAP,
  type RaidFragment,
} from "./raid-treasure.js";
import type { RaidLearnedTable } from "./raid-learned.js";

const FLAG = "__ulrRaidView";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const RAID_VIEW_SCRIPT_VERSION = 31;

/** ⑪ 塞進官方 RaidUITexts.error 的鍵（官方的 raid_error 拿鍵查字）。 */
export const RAID_CODE_NO_REPLY_KEY = "ULR_CODE_NO_REPLY";

export const DEFAULT_RAID_VIEW_POLL_MS = 300;

/**
 * 從哪一版起「發現畫面」記的 stage 才傳出去（互傳、回報 ulgg）。之前的對法在新渦還沒進清單時
 * 會套到同一隻怪的舊渦上（2026-09-25 靈龜記成 3、實際 2）。頁面上的紀錄重裝不清，所以要分版本。
 */
export const RAID_TITLE_TRUSTED_SINCE = 21;

/** 還不知道碎片的漩渦上的灰色。 */
export const RAID_UNKNOWN_TINT = 0x8c8c8c;

/** 更新鈕（⑩）按完多久內再按不算。 */
export const RAID_VIEW_MANUAL_REFRESH_COOLDOWN_MS = 3_000;

/** 結算收到了、清單上卻一直對不到那個渦（渦早就不見了）：多久後放棄學它。 */
export const RAID_LEARN_GIVE_UP_MS = 10 * 60 * 1000;

/** 打渦隊伍（⑨）：開打後多久還沒量到就丟掉（一場戰鬥遠小於這個）。 */
export const RAID_BATTLE_PENDING_MAX_MS = 2 * 60 * 60 * 1000;

/** 打渦隊伍（⑨）：量完之後多久內分數再漲都算那一場（提早離場時分數會晚幾分鐘進帳）。 */
export const RAID_BATTLE_TAIL_MS = 15 * 60 * 1000;

/** 玩家按了渦房的更新鈕（⑩）。托盤要跟著馬上重查 ulgg／插件雲端。 */
export interface RaidRefreshReport {
  type: "raid-refresh";
}

/**
 * 一個渦從清單上消失了（死後到期、被刪、放棄），或消失後結算才到。查「獎勵被吞」用。
 * 時間都是 ms。`deathByLimit` = 死後的 limit − 10 分（伺服器死後把 limit 改成死亡＋10 分）；
 * `deadSeen` = 插件第一次看到 hp 0；`refreshAfterDeath` = 死後清單重拿過幾次
 * （0 次就沒要過結算，「沒結算」不算數）。
 */
export interface RaidTrackReport {
  type: "raid-track";
  name: string;
  level: number | null;
  rarity: number | null;
  /** 跟渦房上畫的同一個 stage（自己看到的 → ulgg → 照怪＋區塊推）；舊版頁面沒有這欄 */
  stage?: number | null;
  // 以下找「沒結算」的規律用，都是最後一次在清單上看到的；舊版頁面沒有
  monsterId?: number | null;
  founder?: string | null;
  hpMax?: number | null;
  /** 榜上幾個人 */
  rankCount?: number | null;
  /** 自己在榜上第幾名（沒分數是 null） */
  myRank?: number | null;
  /** 榜首的分數 */
  topPoint?: number | null;
  /** 死後跟伺服器要過幾次結算（進渦房／Refresh 各一次） */
  asksAfterDeath?: number;
  /** 其中整包空的（伺服器一個渦都沒給）有幾次 */
  emptyAsksAfterDeath?: number;
  /** 渦房上標的預期碎片（道具名）；渦幣時 expectCoin 是 true（名字還是同色碎片的） */
  expectFrag?: string | null;
  expectCoin?: boolean | null;
  /** 預期碎片從哪推的：自己看到的 stage／ulgg／學到的表（learned）／照區塊推（map） */
  expectSrc?: string | null;
  /** 排名第一檔碎片以外的東西（學到的表的） */
  expectItems?: string[];
  category: string | null;
  mapIndex: number | null;
  mine: boolean;
  found: number | null;
  limitAlive: number | null;
  deathByLimit: number | null;
  deadSeen: number | null;
  point: number;
  refreshAfterDeath: number;
  settled: number | null;
  gone: number | null;
}

export function isRaidTrackReport(value: unknown): value is RaidTrackReport {
  const o = value as { type?: unknown; name?: unknown } | null;
  return (
    typeof value === "object" && o !== null && o.type === "raid-track" && typeof o.name === "string"
  );
}

/** 頁面記下了某個渦新的 stage（發現畫面或開打）。托盤要馬上回報 ulgg。 */
export interface RaidStageReport {
  type: "raid-stage";
}

export function isRaidStageReport(value: unknown): value is RaidStageReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "raid-stage"
  );
}

export function isRaidRefreshReport(value: unknown): value is RaidRefreshReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "raid-refresh"
  );
}

/** 面板上的字。照官方 RaidUITexts 的五語；畫進遊戲的字要短，說明放 tooltip。 */
export const RAID_VIEW_LABELS: Record<
  string,
  {
    button: string;
    discovery: string;
    participation: string;
    ranking: string;
    defeat: string;
    /** 這種渦還沒學到 */
    notLearned: string;
    /** 那一類這次結算看不到（不是發現者／沒打最後一擊） */
    unknown: string;
    rank: string;
    rankOpen: string;
    /** 面板底下：學自幾次結算 */
    learned: string;
    conflict: string;
    /** 還沒學到、但知道 stage（打過、自己發現的、或 ulgg）時碎片旁的註記 */
    fromStage: string;
    /** 同上，但 stage 是照怪＋區塊推的（raidStageByMap） */
    fromMap: string;
    refresh: string;
    refreshTip: string;
    /** 詳細面板的「Points」滑上去：渦的分數公式（一行一條） */
    pointsTip: string;
    /** 隊伍面板（⑨）：標題 __NAME__ 換成玩家名；欄名要短 */
    teamsTitle: string;
    colTeam: string;
    colDmg: string;
    colPts: string;
    colBattles: string;
    colTurns: string;
    colAp: string;
    colPerAp: string;
    /** 隊伍詳細的每場平均那一列 */
    avg: string;
    colBest: string;
    /** ⑪ 輸入渦碼後伺服器沒回應：官方錯誤框裡的字（官方那幾句是整句，這裡跟著） */
    codeNoReply: string;
  }
> = {
  ja: {
    button: "報酬一覧",
    discovery: "発見報酬",
    participation: "参加報酬",
    ranking: "順位報酬",
    defeat: "撃破報酬",
    notLearned: "まだ記録なし：この種類の渦を一度撃破して結果を受け取ると表示されます",
    unknown: "?",
    rank: "__A__〜__B__位",
    rankOpen: "__A__位〜",
    learned: "撃破結果 __N__ 回から",
    conflict: "結果が食い違ったため最新の分を表示",
    fromStage: "stage __S__ から推定",
    fromMap: "区画から推定（stage __S__）",
    refresh: "Refresh",
    refreshTip: "渦リスト・AP・報酬を読み直す（渦部屋に入り直すのと同じ）",
    pointsTip:
      "キャラが1ターン生き残る +500\nダメージ ×100 ±9\nダメージ0なら0点\nGem 固定 10\nExp 固定 50",
    teamsTitle: "__NAME__ のデッキ",
    colTeam: "デッキ",
    colDmg: "ダメージ",
    colPts: "スコア",
    colBattles: "戦闘数",
    colTurns: "ターン",
    colAp: "AP",
    colPerAp: "ダメ/AP",
    avg: "平均",
    colBest: "1戦最高",
    codeNoReply: "サーバーから応答がありません。\nすでに参加している渦かもしれません。",
  },
  en: {
    button: "Rewards",
    discovery: "Discovery",
    participation: "Participation",
    ranking: "Position",
    defeat: "Victory",
    notLearned: "Not recorded yet: shown after you receive the results of this kind of vortex once",
    unknown: "?",
    rank: "#__A__–__B__",
    rankOpen: "#__A__+",
    learned: "From __N__ result(s)",
    conflict: "Results disagreed; showing the latest",
    fromStage: "from stage __S__",
    fromMap: "guessed from map area (stage __S__)",
    refresh: "Refresh",
    refreshTip: "Reload vortex list, AP and rewards (same as re-entering the room)",
    pointsTip:
      "Character survives a full turn +500\nDamage ×100 ±9\nNo damage: 0 points\nGem: fixed 10\nExp: fixed 50",
    teamsTitle: "__NAME__'s decks",
    colTeam: "Deck",
    colDmg: "Damage",
    colPts: "Score",
    colBattles: "Battles",
    colTurns: "Turns",
    colAp: "AP",
    colPerAp: "Dmg/AP",
    avg: "Avg",
    colBest: "Best",
    codeNoReply: "The server did not respond.\nYou may have already joined this vortex.",
  },
  kr: {
    button: "보상 목록",
    discovery: "발견보상",
    participation: "참가보상",
    ranking: "랭킹보상",
    defeat: "격퇴보상",
    notLearned: "아직 기록 없음: 이 종류의 소용돌이 결과를 한 번 받으면 표시됩니다",
    unknown: "?",
    rank: "__A__~__B__위",
    rankOpen: "__A__위~",
    learned: "결과 __N__회 기준",
    conflict: "결과가 서로 달라 최신 것을 표시",
    fromStage: "stage __S__ 기준 추정",
    fromMap: "구역 기준 추정 (stage __S__)",
    refresh: "Refresh",
    refreshTip: "소용돌이 목록・AP・보상을 다시 읽기 (방에 다시 들어가는 것과 같음)",
    pointsTip:
      "캐릭터가 한 턴 끝까지 생존 +500\n데미지 ×100 ±9\n데미지 없으면 0점\nGem 고정 10\nExp 고정 50",
    teamsTitle: "__NAME__의 덱",
    colTeam: "덱",
    colDmg: "대미지",
    colPts: "점수",
    colBattles: "전투",
    colTurns: "턴",
    colAp: "AP",
    colPerAp: "대미지/AP",
    avg: "평균",
    colBest: "최고",
    codeNoReply: "서버가 응답하지 않습니다.\n이미 참가한 소용돌이일 수 있습니다.",
  },
  scn: {
    button: "奖励一览",
    discovery: "发现奖励",
    participation: "参加奖励",
    ranking: "排名奖励",
    defeat: "击破奖励",
    notLearned: "还没学到：这种涡打倒一次、收到结算后就会记住",
    unknown: "?",
    rank: "__A__–__B__名",
    rankOpen: "__A__名～",
    learned: "学自 __N__ 次结算",
    conflict: "两次结算对不上，显示最新的",
    fromStage: "由 stage __S__ 推算",
    fromMap: "由区块推算（stage __S__）",
    refresh: "Refresh",
    refreshTip: "重读涡清单、AP 与结算（等于重进涡房）",
    pointsTip: "角色完整活一回合 +500\n伤害 ×100 ±9\n没有伤害就没有分数\nGem 固定 10\nExp 固定 50",
    teamsTitle: "__NAME__ 的队伍",
    colTeam: "队伍",
    colDmg: "伤害",
    colPts: "分数",
    colBattles: "场次",
    colTurns: "回合",
    colAp: "AP",
    colPerAp: "伤害/AP",
    avg: "平均",
    colBest: "单场最高",
    codeNoReply: "服务器没有响应。\n可能已经参加过这个涡。",
  },
  tcn: {
    button: "獎勵一覽",
    discovery: "發現獎勵",
    participation: "參加獎勵",
    ranking: "排名獎勵",
    defeat: "擊破獎勵",
    notLearned: "還沒學到：這種渦打倒一次、收到結算後就會記住",
    unknown: "?",
    rank: "__A__–__B__名",
    rankOpen: "__A__名～",
    learned: "學自 __N__ 次結算",
    conflict: "兩次結算對不上，顯示最新的",
    fromStage: "由 stage __S__ 推算",
    fromMap: "由區塊推算（stage __S__）",
    refresh: "Refresh",
    refreshTip: "重讀渦清單、AP 與結算（等於重進渦房）",
    pointsTip: "角色完整活一回合 +500\n傷害 ×100 ±9\n沒有傷害就沒有分數\nGem 固定 10\nExp 固定 50",
    teamsTitle: "__NAME__ 的隊伍",
    colTeam: "隊伍",
    colDmg: "傷害",
    colPts: "分數",
    colBattles: "場次",
    colTurns: "回合",
    colAp: "AP",
    colPerAp: "傷害/AP",
    avg: "平均",
    colBest: "單場最高",
    codeNoReply: "伺服器沒有回應。\n可能已經參加過這個渦。",
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
  /**
   * `states` 是什麼時候看到的（ms）；沒有就是這份不帶狀態。頁面拿它跟自己打渦時看到的比，
   * 取新的。改版後狀態只看得到戰鬥開場那一刻，所以是「某人某次開打時」的時刻。
   */
  statesAt?: number | null;
  /**
   * 渦的到期時刻（ms）與發現者。別人開的渦清單上**沒有渦碼**（code 是 null，只有發現者
   * 看得到），所以頁面拿這兩個去對 —— 跟清單的 limit 一模一樣（2026-09-25 實測）。
   */
  limit?: number | null;
  founder?: string | null;
  /**
   * 公開渦通知（raid-feed）後台算好的碎片：有人看到的 stage 算的，或 ulrmap 獎勵表用怪＋★＋區塊
   * 查的。stage 還沒人看到時只有這個 —— SUPPORT 上的渦（還沒加入）靠它畫。
   */
  fragment?: RaidFragment | null;
}

/**
 * 自動刪除死渦（HP 歸零的渦）的設定。
 *
 * - `enabled`：開著就刪
 * - `prompt`：關著的時候，死渦的詳細面板上要不要出現「自動刪除死渦」那顆鈕
 *   （改版後那顆鈕還沒移植，只有托盤的開關）
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
  /** no-reward：榜上沒分也不是發現者；had-reward：自己有份（結算收到了才刪） */
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

/**
 * 自己渦清單上的一個渦，給插件互傳上傳用（見 `@ulr/arbiter-link/raid-share`）。
 * 改版後別人開的渦 `code` 是 null；互傳用 `founder`＋`limit` 當鍵。
 */
export interface RaidSnapshotRow {
  code: string | null;
  founder: string | null;
  tl: number | null;
  rarity: number | null;
  stage: number | null;
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  limit: number;
  states: RaidStateRef[];
  /** 自己打這個渦開場時看到 `states` 的時刻；沒看過是 null（`states` 也是空的、不代表沒狀態） */
  statesAt: number | null;
  /** 發現時刻（清單的 `found_at`）。隊伍看板的鍵（發現者＋它）用，不會隨渦死掉而變 */
  foundAt: number | null;
  /**
   * 排行榜上的名字（去掉官方加的「Lv.92 」）。**只給托盤查隊伍用**（名字＋渦算玩家 key），
   * `uploadSharedRaids` 不傳這一欄。
   */
  players: string[];
  /** 托盤記結算用（名字、區塊、自己的分數、渦房上標的預期獎勵）。**不上傳**；舊版頁面沒有 */
  meta?: RaidSnapshotMeta;
}

export interface RaidSnapshotMeta {
  name: string;
  monsterId: number | null;
  level: number | null;
  mapIndex: number | null;
  category: string | null;
  point: number | null;
  /** 渦房上畫的 stage（自己看到的 → ulgg → 照區塊推）；上面那個 stage 只有自己看到的 */
  stage: number | null;
  expectFrag: string | null;
  expectCoin: boolean;
  expectSrc: string | null;
  expectItems: string[];
  /**
   * 清單的 `only_friend`（參加資格「僅限好友」）。加入者讀到的也是真的值（2026-10-09：好友讀到
   * Kotoma 沒公開的玄帝是 true）。`false` 只說「不是僅限好友」，沒按送出的也是 false —— 公開渦通知
   * 要配「在 SUPPORT 看過」才當公開。舊版頁面沒有
   */
  onlyFriend?: boolean | null;
}

export type RaidPublicMap = Record<string, RaidPublicInfo>;

/**
 * 一副牌組的 27 格。⚠ **欄位名是改版前的**（隊伍看板 Worker 的形狀驗證沿用），
 * 改版後（2026-09-23）裝的是新 id，從戰鬥設定 `room_config.playerA_deck` 來：
 */
export interface RaidDeckContent {
  /** CharaCards 的 `chara`（"cc035"、"mc1003_02"）；查不到或不像卡片鍵的是 null */
  chara: (string | null)[];
  /** CharaCards 的 `id`（`chara_card_id`） */
  charaIndex: (number | null)[];
  /** WeaponCards 的 `id`（`weapon_card_id`） */
  weapon: (number | null)[];
  /** EventCards 的 `id`（`event_card_id`，每個角色 6 格） */
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

/**
 * 托盤推下來的隊伍表：渦（發現者＋"@"＋發現時刻，`@ulr/arbiter-link` 的 raidTeamRef）
 * → 玩家名字 → 那個人的隊伍。
 */
export type RaidTeamsMap = Record<string, Record<string, RaidTeamView[]>>;

/** 打完一場渦（⑨）。分數晚到時用同一個 `at` 再報一次（補報）。 */
export interface RaidBattleReport {
  type: "raid-battle";
  /** 渦：發現者＋"@"＋發現時刻（raidTeamRef）。托盤拿去算雜湊，不會原樣上雲。 */
  raid: string;
  player: string;
  /** 渦的到期時刻（開打時的；看板拿它決定什麼時候丟） */
  limit: number;
  turns: number;
  ap: number;
  /** 戰鬥中自己攻擊打掉的（damage_opponent 第 4 個參數 true 的加總；狀態跳血、BOSS 自傷不算） */
  damage: number;
  /** 榜上自己的分數漲了多少 */
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
    typeof o.raid === "string" &&
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
  /** 回報用的 binding。沒給就不回報（學不到獎勵表、更新鈕也不通知托盤）。 */
  bindingName?: string;
  pollIntervalMs?: number;
  /** 一開始就推下去的公開渦表（可空） */
  publicMap?: RaidPublicMap;
  autoDelete?: RaidAutoDeleteSetting;
  /** 一開始就推下去的隊伍表（可空） */
  teams?: RaidTeamsMap;
  /** 學到的獎勵表（可空） */
  learned?: RaidLearnedTable;
}

export function buildRaidViewPatchScript(options: RaidViewPatchOptions = {}): string {
  const config = {
    version: RAID_VIEW_SCRIPT_VERSION,
    bindingName: options.bindingName ?? null,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RAID_VIEW_POLL_MS,
    labels: RAID_VIEW_LABELS,
    publicMap: options.publicMap ?? {},
    autoDelete: options.autoDelete ?? DEFAULT_RAID_AUTO_DELETE,
    teams: options.teams ?? {},
    learned: options.learned ?? {},
    manualCooldownMs: RAID_VIEW_MANUAL_REFRESH_COOLDOWN_MS,
    learnGiveUpMs: RAID_LEARN_GIVE_UP_MS,
    battleMaxMs: RAID_BATTLE_PENDING_MAX_MS,
    tailMs: RAID_BATTLE_TAIL_MS,
    ownTint: RAID_OWN_FRAME_TINT,
    /** 還不知道碎片的漩渦（玩家 2026-09-25：不要官方的藍／紅，用灰色） */
    unknownTint: RAID_UNKNOWN_TINT,
    // 順序＝角色卡 cmem_0..4／ccoin_0..4（記憶、時間、靈魂、生命、死亡；鐵銅銀金白金）
    fragments: RAID_FRAGMENTS.map((x) => ({
      key: x.key,
      code: x.code,
      item: x.item,
      tint: x.tint,
      css: x.css,
    })),
    // 照怪＋區塊推 stage（raid-treasure.ts 的 raidStageByMap，頁面裡照抄一份）
    stageStartMap: RAID_STAGE_START_MAP,
    mapCount: RAID_MAP_COUNT,
    statuses: Object.fromEntries(
      RAID_STATUSES.map((s) => [s.code, { short: s.short, kind: s.kind }]),
    ),
    statusColors: RAID_STATUS_COLORS,
    // BOSS 被動什麼時候開（raid-passive.ts；Discord 那份在 arbiter-link）
    passives: RAID_PASSIVE_RULES,
    passiveColor: RAID_PASSIVE_COLOR,
    // 官方獎勵碼（跟 patch-raid-reward 同一份）：1 角色、2 武器／事件卡（slot 0 武器、2 事件）、3 道具、4 部件、5 GEM
    rewardTypes: { chara: 1, slot: 2, avatarItem: 3, avatarPart: 4, gem: 5 },
    slotWeapon: 0,
    slotEvent: 2,
    codeNoReplyKey: RAID_CODE_NO_REPLY_KEY,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};
  var META = "__ulrRaidMeta";
  var STAGES = "__ulrRaidStages";
  var BOSS_STATES = "__ulrRaidBossStates";
  var LEARNED_IDS = "__ulrRaidLearnedIds";
  var SEEN = "__ulrRaidRewardSeen";
  var PANEL_TEX = "__ulrRaidPanel", CHAR_TEX = "__ulrRaidPanelChar";
  var FONT = "font_light";
  var ICON = 14;          // 清單／名字旁的小圖邊長
  var BTN_COLOR = "#ffffff", BTN_HOVER = "#c5c5c5";

  function gameOf() {
    return window.game && window.game.scene && window.game.scene.keys ? window.game : null;
  }
  function alive(o) { return !!(o && o.scene); }
  function langOf() { return typeof lang === "string" && CFG.labels[lang] ? lang : "tcn"; }
  function L() { return CFG.labels[langOf()]; }
  function gameLang() { return typeof lang === "string" ? lang : "tcn"; }
  function safeDestroy(o) { try { if (alive(o)) o.destroy(); } catch (e) {} }
  function destroyAll(list) { for (var i = 0; i < list.length; i++) safeDestroy(list[i]); list.length = 0; }
  function report(payload) {
    if (!CFG.bindingName) return;
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上 */ }
  }
  function sfx(R) { try { if (R.ulse01) R.ulse01.play(); } catch (e) {} }

  // ---- 獎勵碼 → 名字／小圖 ---------------------------------------------------
  function cached(G, key) {
    try { var v = G.cache.json.get(key); return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  function byId(G, key, id) {
    var arr = cached(G, key);
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  function localName(row) {
    if (!row) return "";
    return String(row["name_" + gameLang()] || row.name_tcn || row.name_en || "");
  }
  /** 照官方模組私有的 NR 寫的（跟 patch-raid-reward 的 itemName 同一套）。 */
  function itemName(G, c) {
    var T = CFG.rewardTypes;
    var x = c.value > 0 ? " x" + c.value : "";
    try {
      if (c.type === T.chara) {
        var cc = byId(G, "CharaCards", c.id);
        var chars = G.cache.json.get("Characters");
        var nm = cc && chars && chars[cc.chara] ? localName(chars[cc.chara]) : "";
        if (!cc || !nm) return "---";
        var pre = cc.kind === 0 ? (cc.rarity < 6 ? "L" : "R") + cc.level + " " : cc.kind === 1 ? "M" + cc.level + " " : "";
        return pre + nm + x;
      }
      if (c.type === T.slot) {
        var key = c.slot === CFG.slotWeapon ? "WeaponCards" : c.slot === CFG.slotEvent ? "EventCards" : null;
        var s = key ? byId(G, key, c.id) : null;
        return s ? localName(s) + x : "---";
      }
      if (c.type === T.avatarItem) { var it = byId(G, "AvatarItems", c.id); return it ? localName(it) + x : "---"; }
      if (c.type === T.avatarPart) { var pt = byId(G, "AvatarParts", c.id); return pt ? localName(pt) : "---"; }
      if (c.type === T.gem) return c.value + "GEM";
    } catch (e) {}
    return "---";
  }
  function frameIn(G, key, frame) {
    try {
      if (!G.textures.exists(key)) return false;
      var t = G.textures.get(key);
      return !!(t && t.key !== "__MISSING" && t.has(frame));
    } catch (e) { return false; }
  }
  /** 遊戲自己的道具圖。找不到回 null（就只寫字、不畫圖）。 */
  function itemIcon(G, c) {
    var T = CFG.rewardTypes;
    if (c.type === T.avatarItem) {
      var row = byId(G, "AvatarItems", c.id);
      if (row && row.texture_key && frameIn(G, row.texture_key, row.texture_frame)) return { key: row.texture_key, frame: row.texture_frame };
      if (frameIn(G, "AvatarItemImages", "item_" + c.id)) return { key: "AvatarItemImages", frame: "item_" + c.id };
      return null;
    }
    if (c.type === T.slot && c.slot === CFG.slotWeapon && frameIn(G, "WeaponCardImages", "weapon_" + c.id)) return { key: "WeaponCardImages", frame: "weapon_" + c.id };
    if (c.type === T.slot && c.slot === CFG.slotEvent && frameIn(G, "EventCardImages", "event_" + c.id)) return { key: "EventCardImages", frame: "event_" + c.id };
    return null;
  }
  /** 畫一個道具小圖（縮到 size 見方以內），回傳下一個東西的 x；沒圖就原地。 */
  function addItemIcon(sc, G, x, y, c, size, depth, out) {
    var fc = fragOfCode(G, c);
    if (fc) return addFragIcon(sc, G, x, y, fc, size, depth, out);
    var ref = itemIcon(G, c);
    if (ref === null) return x;
    var im = sc.add.image(x, y, ref.key, ref.frame).setOrigin(0, 0.5).setDepth(depth);
    var w = im.width || size, h = im.height || size;
    var k = size / Math.max(w, h, 1);
    im.setScale(k);
    out.push(im);
    return x + Math.round(w * k) + 2;
  }

  // ---- 學到的表 --------------------------------------------------------------
  function keyOf(r) {
    return "m" + r.monster_id + "-L" + r.level + "-R" + r.rarity + "-M" + r.map_index;
  }
  function entryOf(st, r) {
    if (!r || typeof r.monster_id !== "number") return null;
    var e = st.learned[keyOf(r)];
    return e && typeof e === "object" ? e : null;
  }
  function entrySig(e) { return e ? e.key + "@" + e.at + "/" + e.samples + (e.conflict ? "!" : "") : "-"; }
  /** 對不上過的表不拿來畫標記（鍵多半不對）；面板照樣列、加註。 */
  function usable(e) { return e && !e.conflict ? e : null; }
  /** 清單／地圖上畫哪幾樣：排名第一檔的東西。 */
  function mainItems(e) {
    return e && e.ranking && e.ranking.length && Array.isArray(e.ranking[0].items) ? e.ranking[0].items : [];
  }

  // ---- 碎片與渦幣：改版後是角色卡（cmem_0..4、ccoin_0..4） ------------------------
  /** 獎勵碼是不是碎片／渦幣；是的話回 { frag, coin }。 */
  function fragOfCode(G, c) {
    if (!c || c.type !== CFG.rewardTypes.chara) return null;
    var cc = byId(G, "CharaCards", c.id);
    var m = cc && typeof cc.chara === "string" ? /^(cmem|ccoin)_(\\d)$/.exec(cc.chara) : null;
    if (!m || !CFG.fragments[+m[2]]) return null;
    return { frag: CFG.fragments[+m[2]], coin: m[1] === "ccoin" };
  }
  function fragByFormula(rarity, stage) {
    var code = ((rarity === 6 ? stage + 1 : stage) % 5 + 5) % 5;
    for (var i = 0; i < CFG.fragments.length; i++) if (CFG.fragments[i].code === code) return CFG.fragments[i];
    return null;
  }
  function fragByKey(key) {
    for (var i = 0; i < CFG.fragments.length; i++) if (CFG.fragments[i].key === key) return CFG.fragments[i];
    return null;
  }
  /** 公開渦表上的碎片：有 stage＋★ 就套公式，沒有就用通報後台算好的（ulrmap 查的）。 */
  function pubFrag(pub, rarity) {
    if (!pub) return null;
    if (typeof pub.stage === "number" && typeof rarity === "number") {
      var f = fragByFormula(rarity, pub.stage);
      if (f) return { frag: f, coin: false, source: "ulgg", stage: pub.stage };
    }
    var k = typeof pub.fragment === "string" ? fragByKey(pub.fragment) : null;
    return k ? { frag: k, coin: false, source: "feed", stage: null } : null;
  }
  /**
   * 托盤推下來的 ulgg 表裡找這個渦。別人開的渦清單上沒有渦碼（code 是 null），
   * 所以用到期時刻＋發現者對；自己開的有渦碼就直接查。
   */
  function publicOf(st, r) {
    if (!r) return null;
    if (typeof r.code === "string" && st.publicMap[r.code]) return st.publicMap[r.code];
    if (st.pubIndexOf !== st.publicMap) {
      st.pubIndexOf = st.publicMap;
      st.pubByLimit = {};
      for (var k in st.publicMap) {
        var info = st.publicMap[k];
        if (info && typeof info.limit === "number") (st.pubByLimit[info.limit] || (st.pubByLimit[info.limit] = [])).push(info);
      }
    }
    var list = st.pubByLimit[r.limit] || [];
    for (var i = 0; i < list.length; i++) if (!list[i].founder || list[i].founder === r.founder) return list[i];
    return null;
  }
  /** 自己看到的 stage（打這個渦時的戰鬥設定、或發現它時的 raid_title），重裝不清。 */
  function seenStage(r) {
    var S = window[STAGES];
    var s = S && r ? S[r.profound_id] : null;
    return s && typeof s.stage === "number" ? s : null;
  }
  /** 照怪＋區塊推 stage（跟 raid-treasure.ts 的 raidStageByMap 同一條）；沒證據回 null。 */
  function stageByMap(r) {
    if (!r || r.level !== 1 || typeof r.map_index !== "number") return null;
    var start = CFG.stageStartMap[r.monster_id], n = CFG.mapCount;
    if (typeof start !== "number" || r.map_index < 1 || r.map_index > n || r.map_index % 1) return null;
    var stage = ((r.map_index - start) % n + n) % n + 1;
    return stage <= 5 ? stage : null;
  }
  /**
   * 這個渦掉哪種碎片，stage 套公式：自己看到的 stage 最優先，其次 ulgg 的（2026-09-25 七個實測
   * 全對）、公開渦通報後台算好的碎片；再來是學到的表（碎片沒對不上過的）排名第一檔；最後照怪＋區塊推 stage。
   * 後兩種是推測，畫成空心。都沒有回 null。
   */
  function fragInfo(st, G, r) {
    var own = seenStage(r);
    if (own && typeof r.rarity === "number") {
      var fo = fragByFormula(r.rarity, own.stage);
      if (fo) return { frag: fo, coin: false, source: own.src, stage: own.stage };
    }
    var pub = publicOf(st, r);
    var pf = pubFrag(pub, pub && typeof pub.rarity === "number" ? pub.rarity : r.rarity);
    if (pf) return pf;
    var e = entryOf(st, r);
    // 其他獎勵對不上不擋碎片；舊托盤推下來的沒有 fragConflict，照 conflict
    var fragOk = e && !(typeof e.fragConflict === "boolean" ? e.fragConflict : e.conflict);
    var items = mainItems(fragOk ? e : null);
    for (var i = 0; i < items.length; i++) {
      var x = fragOfCode(G, items[i]);
      if (x) return { frag: x.frag, coin: x.coin, source: "learned", stage: null };
    }
    var ms = typeof r.rarity === "number" ? stageByMap(r) : null;
    if (ms !== null) {
      var fm = fragByFormula(r.rarity, ms);
      if (fm) return { frag: fm, coin: false, source: "map", stage: ms };
    }
    return null;
  }
  /** 推測來的（學到的表、照區塊推）：畫空心／半透明 */
  function guessed(fi) { return fi.source === "learned" || fi.source === "map"; }
  function fragSig(fi) { return fi ? fi.source + ":" + (fi.coin ? "c" : "f") + fi.frag.key : "-"; }
  /** 排名第一檔裡碎片以外的東西（魔之素材、書籤…），用遊戲的道具圖。 */
  function extraItems(G, e) {
    var items = mainItems(usable(e)), out = [];
    for (var i = 0; i < items.length; i++) if (!fragOfCode(G, items[i])) out.push(items[i]);
    return out;
  }

  // 碎片圖示：新客戶端沒有碎片的道具圖（舊的 item_cmem 沒了），畫舊的五色形狀：
  // 碎片是菱形、渦幣是圓。建一次放在 canvas 貼圖裡，縮到 14px 用。
  // 學到的表推的（同怪同區塊以前掉過，不是 stage 算的）畫空心（frame 名加 _learned），
  // 玩家 2026-09-25：實心的看不出是推測
  var ICON_TEX = "__ulrRaidIcons", GRAY_TEX = "__ulrVortexGray", GRAY_ANIM = "__ulrVortexGray";
  var CELL = 28;
  /** 地圖上學到的表推的渦：半透明，跟 stage 算的分開 */
  var LEARNED_ALPHA = 0.5;
  function ensureIcons(G) {
    if (G.textures.exists(ICON_TEX)) return true;
    if (typeof G.textures.createCanvas !== "function") return false;
    var names = [];
    [false, true].forEach(function (hollow) {
      var sfx = hollow ? "_learned" : "";
      CFG.fragments.forEach(function (f) {
        names.push({ name: "frag_" + f.key + sfx, f: f, coin: false, hollow: hollow });
        names.push({ name: "coin_" + f.key + sfx, f: f, coin: true, hollow: hollow });
      });
    });
    var tex = G.textures.createCanvas(ICON_TEX, CELL * names.length, CELL);
    if (!tex) return false;
    var ctx = tex.getContext();
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      ctx.save();
      ctx.translate(i * CELL + CELL / 2, CELL / 2);
      ctx.beginPath();
      if (n.coin) ctx.arc(0, 0, 10, 0, Math.PI * 2);
      else { ctx.moveTo(0, -11); ctx.lineTo(10, 0); ctx.lineTo(0, 11); ctx.lineTo(-10, 0); ctx.closePath(); }
      if (n.hollow) {
        // 空心：黑邊墊底、碎片色描粗框，中間透出底色
        ctx.lineWidth = 6; ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.stroke();
        ctx.lineWidth = 3.5; ctx.strokeStyle = n.f.css; ctx.stroke();
      } else {
        ctx.fillStyle = n.f.css; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.stroke();
      }
      ctx.restore();
    }
    tex.refresh();
    for (var j = 0; j < names.length; j++) tex.add(names[j].name, 0, j * CELL, 0, CELL, CELL);
    return true;
  }
  function addFragIcon(sc, G, x, y, fi, size, depth, out) {
    if (!fi || !ensureIcons(G)) return x;
    var frame = (fi.coin ? "coin_" : "frag_") + fi.frag.key + (guessed(fi) ? "_learned" : "");
    out.push(sc.add.image(x, y, ICON_TEX, frame).setOrigin(0, 0.5).setScale(size / CELL).setDepth(depth));
    return x + size + 2;
  }
  /**
   * 地圖渦上色：三張官方漩渦都是飽和色，setTint 是乘法（藍乘黃是黑的），所以從 vortex_another
   * 的 8 格做一張灰階版（亮度取 max(r,g,b)）、註冊成新動畫，之後 setTint 就是乾淨的碎片色。
   * 新客戶端 frame 名是 "0".."7"。
   */
  function ensureGray(G) {
    if (G.textures.exists(GRAY_TEX)) return !!(G.anims && G.anims.exists(GRAY_ANIM));
    if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof G.textures.addCanvas !== "function") return false;
    var src = G.textures.exists("vortex_another") ? G.textures.get("vortex_another") : null;
    if (!src || src.key === "__MISSING") return false;
    var names = src.getFrameNames().filter(function (n) { return n !== "__BASE"; }).sort(function (a, b) {
      var na = parseInt(String(a).replace(/\\D+/g, ""), 10), nb = parseInt(String(b).replace(/\\D+/g, ""), 10);
      return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb);
    });
    if (!names.length) return false;
    try {
      var f0 = src.get(names[0]);
      var w = f0.width, h = f0.height;
      var c = document.createElement("canvas");
      c.width = w * names.length; c.height = h;
      var ctx = c.getContext("2d");
      for (var i = 0; i < names.length; i++) {
        var f = src.get(names[i]);
        ctx.drawImage(f.source.image, f.cutX, f.cutY, f.width, f.height, i * w, 0, f.width, f.height);
      }
      var img = ctx.getImageData(0, 0, c.width, h), d = img.data;
      for (var p = 0; p < d.length; p += 4) { var l = Math.max(d[p], d[p + 1], d[p + 2]); d[p] = l; d[p + 1] = l; d[p + 2] = l; }
      ctx.putImageData(img, 0, 0);
      var tex = G.textures.addCanvas(GRAY_TEX, c);
      var frames = [];
      for (var j = 0; j < names.length; j++) { tex.add(String(names[j]), 0, j * w, 0, w, h); frames.push({ key: GRAY_TEX, frame: String(names[j]) }); }
      if (!G.anims.exists(GRAY_ANIM)) G.anims.create({ key: GRAY_ANIM, frames: frames, frameRate: 12, repeat: -1 });
      return true;
    } catch (e) { return false; }
  }
  function meMaybe(R) { return R && R.player && typeof R.player.player_name === "string" ? R.player.player_name : null; }
  function raidById(R, id) {
    var list = R.raid_list || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].profound_id === id) return list[i];
    return null;
  }

  // ---- 渦結束紀錄：查「獎勵被吞」用 ------------------------------------------------
  //
  // 2026-09-25 妖精（魔性的鱗粉）與幾隻渦打死了卻沒有結算，玩家懷疑跟每 10 分鐘的刷新時間點
  // 有關。要對照得先有資料：每個渦記發現時刻、死亡時刻、自己的分數、結算到了沒，
  // 渦從清單消失時回報一行（托盤寫進記錄）。
  //
  // 死亡時刻兩個都記：
  //   · deathByLimit：死後伺服器把 limit 改成「死亡＋10 分」（妖精 HP 0 時剩 8:24、
  //     靈龜 43 分就到期），所以 limit − 10 分。還沒驗證過是不是剛好 10 分
  //   · deadSeen：插件第一次看到 hp 0（清單只在進渦房／Refresh 時重拿，會晚）
  // 「沒收到結算」只有在死後清單重拿過（refreshAfterDeath ≥ 1）才算數：客戶端只在進渦房／
  // Refresh 時要結算，跟重拿清單是同一次。
  var TRACK = "__ulrRaidTrack", DEATH_TAIL_MS = 10 * 60 * 1000;
  function trackRaids(st, R) {
    var T = window[TRACK] || (window[TRACK] = {});
    var list = R.raid_list || [];
    // 剛裝上（或重裝）的第一輪不算重拿過清單
    var fresh = st.trackList !== undefined && list !== st.trackList;
    st.trackList = list;
    var now = Date.now(), me = meMaybe(R), here = {};
    // patch-raid-reward 記的是陣列（每個渦一筆 profound_id＋at）。以前這裡當成以
    // profound_id 為鍵的物件讀，永遠對不到，每個渦都報成沒收到結算（2026-09-26 對記錄才發現）
    var seen = {}, seenList = window[SEEN];
    if (Array.isArray(seenList)) {
      for (var s = 0; s < seenList.length; s++) {
        var sv = seenList[s];
        if (sv && typeof sv.profound_id === "string" && typeof sv.at === "number" && !seen[sv.profound_id]) seen[sv.profound_id] = sv;
      }
    }
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.profound_id !== "string") continue;
      var id = r.profound_id;
      here[id] = true;
      var t = T[id];
      if (!t) {
        t = T[id] = { name: String(r.name || ""), level: r.level, rarity: r.rarity, category: typeof r.category === "string" ? r.category : null,
          mapIndex: r.map_index, mine: me !== null && r.founder === me, found: r.found_at, limitAlive: r.hp >= 1 ? r.limit : null,
          deathByLimit: null, deadSeen: null, point: 0, refreshAfterDeath: 0, settled: null, gone: null, reported: false, stage: null };
      }
      // 跟渦房上畫的同一個 stage：自己看到的 → ulgg → 照怪＋區塊推。死了 ulgg 可能對不到，留著活著時的
      var sg = trackStage(st, r);
      if (sg !== null) t.stage = sg;
      // 找沒結算的規律用：怪、發現者、血量、榜（人數／自己名次／榜首分數）照最後一次看到的
      t.monsterId = typeof r.monster_id === "number" ? r.monster_id : null;
      t.founder = typeof r.founder === "string" ? r.founder : null;
      t.hpMax = typeof r.hp_max === "number" ? r.hp_max : null;
      var rk = Array.isArray(r.rank) ? r.rank : [];
      t.rankCount = rk.length;
      t.topPoint = rk[0] && typeof rk[0].point === "number" ? rk[0].point : null;
      t.myRank = myRankOf(R, r);
      // 渦房上標的「預期獎勵」：碎片（或渦幣）＋從哪推的、排名第一檔其他東西。沒推出來留著上次的
      var G = window.game, fi = fragInfo(st, G, r);
      if (fi) { t.expectFrag = fi.frag.item; t.expectCoin = fi.coin; t.expectSrc = fi.source; }
      var ex = extraItems(G, entryOf(st, r));
      if (ex.length) { var exn = []; for (var x = 0; x < ex.length; x++) exn.push(itemName(G, ex[x])); t.expectItems = exn; }
      t.point = typeof r.player_point === "number" ? r.player_point : t.point;
      if (r.hp < 1) {
        // 第一次看到它死了：叫托盤馬上傳（公開渦通知要改成 ☠️）—— 打渦腳本可能很快就把它刪掉
        if (t.deadSeen === null) { t.deadSeen = now; t.deathByLimit = r.limit - DEATH_TAIL_MS; report({ type: "raid-stage" }); }
        else if (fresh) t.refreshAfterDeath++;
      } else t.limitAlive = r.limit;
    }
    for (var k in T) {
      var e = T[k];
      if (e.settled === null && seen[k] && typeof seen[k].at === "number") {
        e.settled = seen[k].at;
        // 渦先從清單消失、結算才到：補報一次
        if (e.reported) report(trackReport(e));
      }
      // 清單重拿過而它不在了：結束了（死後到期、被刪、放棄）。有死過或有結算的才回報
      if (fresh && !here[k] && e.gone === null) {
        e.gone = now;
        if (e.deadSeen !== null || e.settled !== null) { e.reported = true; report(trackReport(e)); }
      }
      if (now - (e.gone || now) > 2 * 24 * 3600 * 1000) delete T[k];
    }
  }
  function trackStage(st, r) {
    var own = seenStage(r);
    if (own) return own.stage;
    var pub = publicOf(st, r);
    if (pub && typeof pub.stage === "number") return pub.stage;
    return stageByMap(r);
  }
  /** 死後跟伺服器要過幾次結算（patch-raid-reward 記的），其中幾次整包是空的。 */
  function asksAfter(since) {
    var asks = window.__ulrRaidRewardAsks, n = 0, empty = 0;
    if (since === null || !Array.isArray(asks)) return { n: 0, empty: 0 };
    for (var i = 0; i < asks.length; i++) {
      var a = asks[i];
      if (!a || typeof a.at !== "number" || a.at < since) continue;
      n++;
      if (a.n === 0) empty++;
    }
    return { n: n, empty: empty };
  }
  function trackReport(e) {
    var nul = function (v) { return v === undefined ? null : v; };
    var asks = asksAfter(e.deathByLimit !== null ? e.deathByLimit : e.deadSeen);
    return { type: "raid-track", name: e.name, level: e.level, rarity: e.rarity, stage: nul(e.stage), category: e.category, mapIndex: e.mapIndex, mine: e.mine,
      found: e.found, limitAlive: e.limitAlive, deathByLimit: e.deathByLimit, deadSeen: e.deadSeen, point: e.point,
      refreshAfterDeath: e.refreshAfterDeath, settled: e.settled, gone: e.gone,
      monsterId: nul(e.monsterId), founder: nul(e.founder), hpMax: nul(e.hpMax), rankCount: nul(e.rankCount), myRank: nul(e.myRank),
      topPoint: nul(e.topPoint), asksAfterDeath: asks.n, emptyAsksAfterDeath: asks.empty,
      expectFrag: nul(e.expectFrag), expectCoin: nul(e.expectCoin), expectSrc: nul(e.expectSrc), expectItems: e.expectItems || [] };
  }

  /** 每一輪把清單上看到的渦記下來（重裝不清）：結算送來時渦可能已經從清單消失了。 */
  function rememberMeta(st, R) {
    // ulgg 表通常晚一步才推下來：清單或 ulgg 表換過都要重記
    if (R.raid_list === st.lastList && st.metaPub === st.publicMap) return;
    st.lastList = R.raid_list;
    st.metaPub = st.publicMap;
    var M = window[META] || (window[META] = {});
    var now = Date.now();
    for (var i = 0; i < R.raid_list.length; i++) {
      var r = R.raid_list[i];
      if (!r || typeof r.profound_id !== "string" || typeof r.monster_id !== "number") continue;
      // 渦還活著時 ulgg 給的 stage 一起記（死了就對不到了）—— 學到的原料帶著它，之後找規則用
      var pub = publicOf(st, r);
      var prev = M[r.profound_id];
      var ss = seenStage(r);
      var stage = ss ? ss.stage : pub && typeof pub.stage === "number" ? pub.stage : prev && typeof prev.stage === "number" ? prev.stage : null;
      // founder／found 給 patch-raid-reward 的結算對回「哪個渦」（發現時刻是托盤那邊的鍵）
      M[r.profound_id] = { name: String(r.name || ""), monsterId: r.monster_id, level: r.level, rarity: r.rarity,
        mapIndex: r.map_index, category: typeof r.category === "string" ? r.category : null, stage: stage, seen: now,
        founder: typeof r.founder === "string" ? r.founder : null, found: typeof r.found_at === "number" ? r.found_at : null };
    }
    for (var id in M) if (now - M[id].seen > 3 * 24 * 3600 * 1000) delete M[id];
  }
  function codes(a) {
    var out = [];
    if (!Array.isArray(a)) return out;
    for (var i = 0; i < a.length; i++) {
      var x = a[i];
      if (!x || typeof x.type !== "number" || typeof x.id !== "number") continue;
      out.push({ type: x.type, id: x.id, slot: typeof x.slot === "number" ? x.slot : 0, value: typeof x.value === "number" ? x.value : 0 });
    }
    return out;
  }
  /**
   * patch-raid-reward 記下的結算（raw）對回清單列 → 回報 raid-learn。
   * 同一個渦只學一次（重裝不清）；對不到清單列的等一陣子，還是對不到就放棄。
   */
  function learnTick(st, me) {
    var seen = window[SEEN];
    if (!Array.isArray(seen)) return;
    var done = window[LEARNED_IDS] || (window[LEARNED_IDS] = {});
    var M = window[META] || {};
    for (var i = 0; i < seen.length; i++) {
      var s = seen[i];
      if (!s || !s.raw || typeof s.profound_id !== "string" || done[s.profound_id]) continue;
      var m = M[s.profound_id];
      if (!m || typeof m.monsterId !== "number" || typeof m.level !== "number" || typeof m.rarity !== "number" || typeof m.mapIndex !== "number") {
        if (Date.now() - (s.at || 0) > CFG.learnGiveUpMs) done[s.profound_id] = "no-meta";
        continue;
      }
      done[s.profound_id] = "sent";
      var ranks = [];
      for (var k = 0; k < (s.raw.ranks || []).length; k++) ranks.push(codes(s.raw.ranks[k]));
      var defeat = codes(s.raw.defeat);
      report({ type: "raid-learn", sample: {
        profoundId: s.profound_id, name: m.name, monsterId: m.monsterId, level: m.level, rarity: m.rarity,
        mapIndex: m.mapIndex, category: m.category,
        founder: me !== null && s.raw.founderName === me ? codes(s.raw.founder) : null,
        participate: codes(s.raw.participate),
        defeat: defeat.length ? defeat : null,
        ranks: ranks, stage: typeof m.stage === "number" ? m.stage : null,
        at: typeof s.at === "number" ? s.at : Date.now()
      } });
    }
  }

  // ---- ① 清單列 -------------------------------------------------------------
  /** 第 t 列是哪個渦：照 refresh_raid_list 的算法，再用 found_at／limit 核對。 */
  function rowRaid(R, t, row) {
    var r = (R.raid_list || [])[5 * ((R.list_page_now || 1) - 1) + t];
    if (r && r.found_at === row.found_at && r.limit === row.limit) return r;
    var list = R.raid_list || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].found_at === row.found_at && list[i].limit === row.limit) return list[i];
    return null;
  }
  function decorateList(st, R, G) {
    var rows = R.raid_list_displayed || [];
    for (var t = 0; t < rows.length; t++) {
      var row = rows[t];
      if (!row || !alive(row.raid_name)) continue;
      var name = row.raid_name;
      var r = rowRaid(R, t, row);
      var e = entryOf(st, r);
      var fi = r ? fragInfo(st, G, r) : null;
      var states = bossStates(st, r);
      var pas = rowPassives(G, r);
      var key = (r ? r.profound_id : "?") + "|" + entrySig(e) + "|" + fragSig(fi) + "|" + stateSig(states) + "|" + passiveSig(pas) + "|" + G.textures.exists(STATE_TEX);
      var deco = name.__ulrRaidView;
      if (deco && deco.key === key) {
        for (var k = 0; k < deco.objs.length; k++) deco.objs[k].setVisible(name.visible);
        tickTimers(deco.timers);
        continue;
      }
      if (deco) destroyAll(deco.objs);
      var objs = [], timers = [];
      var maxX = alive(row.limit_text) ? row.limit_text.x - row.limit_text.width - 4 : 200;
      var x = name.x + name.width + 4;
      if (fi && x + ICON <= maxX) x = addFragIcon(R, G, x, name.y, fi, ICON, name.depth, objs);
      var items = extraItems(G, e);
      for (var j = 0; j < items.length && j < 2; j++) {
        if (x + ICON > maxX) break;
        x = addItemIcon(R, G, x, name.y, items[j], ICON, name.depth, objs);
      }
      if (pas.length) x = addPassiveTags(R, G, x + 2, name.y, pas, name.depth, maxX, objs, timers, null) - 4;
      if (states.length) addStateIcons(R, G, x + 2, name.y, states, name.depth, 12, maxX, objs, timers, null);
      for (var v = 0; v < objs.length; v++) objs[v].setVisible(name.visible);
      if (!deco) st.rows.push(name);
      name.__ulrRaidView = { key: key, objs: objs, timers: timers };
    }
    // 官方重建清單時舊的 raid_name 已經 destroy，我們掛的要跟著收
    st.rows = st.rows.filter(function (n) {
      if (alive(n)) return true;
      if (n.__ulrRaidView) destroyAll(n.__ulrRaidView.objs);
      return false;
    });
  }

  // ---- ⑫ SUPPORT 公開清單 ---------------------------------------------------
  //
  // 2026-10-04 實機：每列是 refresh_raid_support_list 建的普通物件
  //   { raid_name, mons_name, founder, hp, limit, member（Text）, zone, rect, profound_code }
  // 第 i 列 y = 257 + 16i；名字欄 x 123、fixedWidth 96（width 永遠是 96，字寬要自己量）。
  // 開關面板、翻頁時官方拿 Object.values 裡有 destroy 的**全部**一起淡入淡出、銷毀 ——
  // 所以碎片圖示直接掛成那一列的欄位（ulr_frag），收的事交給官方。
  // SUPPORT 上的渦還沒加入，沒有自己看到的 stage、也沒有區塊，只看公開渦表
  // （通報後台的 stage 或 ulrmap 查的碎片）。渦碼只在頁面裡拿來對列，不外流。
  function supportRaid(R, d) {
    var list = R.raid_support || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].profound_code === d.profound_code) return list[i];
    return null;
  }
  /** Text 的實際字寬（fixedWidth 的 Text，width 是欄寬不是字寬）。量不到就退回 width。 */
  function textWidth(t) {
    try {
      var ctx = t.context;
      ctx.save();
      ctx.font = t.style._font;
      var w = ctx.measureText(String(t.text)).width;
      ctx.restore();
      return typeof w === "number" && isFinite(w) ? w : t.width;
    } catch (e) { return t.width; }
  }
  function decorateSupport(st, R, G) {
    var rows = R.raid_support_list;
    if (!Array.isArray(rows)) return;
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      if (!d || !alive(d.raid_name)) continue;
      var n = typeof d.profound_code === "string" ? supportRaid(R, d) : null;
      var fi = n ? pubFrag(publicOf(st, { code: null, limit: n.limit, founder: n.founder_name }), null) : null;
      // BOSS 被動：接在 BOSS 名（mons_name，x 223、寬 96）右邊，只畫一個（每隻 BOSS 同時最多開一個）
      var pas = n ? activePassives(passiveIdsOf(G, n.monster_id), n.hp, n.hp_max, Date.now()).slice(0, 1) : [];
      // 公開渦表 30 秒換一次，碎片晚到也要補上；被動跨門檻／換班也重畫
      var key = fragSig(fi) + "|" + passiveSig(pas);
      if (d.__ulrKey !== key) {
        dropSupportDeco(d);
        d.__ulrKey = key;
        if (fi) {
          var name = d.raid_name, objs = [];
          var x = name.x + Math.min(textWidth(name), name.width - ICON - 4) + 4;
          addFragIcon(R, G, x, name.y, fi, ICON, name.depth, objs);
          d.ulr_frag = objs[0] || null;
        }
        if (pas.length && alive(d.mons_name)) {
          var mons = d.mons_name, pobjs = [], timers = [];
          var maxX = alive(d.founder) ? d.founder.x - 4 : mons.x + mons.width;
          addPassiveTags(R, G, mons.x + Math.min(textWidth(mons), mons.width) + 4, mons.y, pas, mons.depth, maxX, pobjs, timers, null);
          // 官方收列時拿 Object.values 裡有 destroy 的一起收，所以一個物件一個欄位（陣列它不收）
          d.ulr_pas = pobjs[0] || null;
          d.ulr_pas_t = pobjs[1] || null;
          d.__ulrPasUntil = timers.length ? timers[0].until : null;
        }
      }
      // 開面板的淡入是官方先收好名單才跑的，沒有這幾顆：跟著名字的透明度與位置走
      var followers = [d.ulr_frag, d.ulr_pas, d.ulr_pas_t];
      for (var f = 0; f < followers.length; f++) {
        var o = followers[f];
        if (!alive(o)) continue;
        if (o.alpha !== d.raid_name.alpha) o.setAlpha(d.raid_name.alpha);
        o.y = d.raid_name.y + (o === d.ulr_pas_t ? 1 : 0);
      }
      if (alive(d.ulr_pas_t) && typeof d.__ulrPasUntil === "number") tickTimers([{ text: d.ulr_pas_t, until: d.__ulrPasUntil }]);
    }
  }
  function dropSupportDeco(d) {
    if (d.ulr_frag) safeDestroy(d.ulr_frag);
    if (d.ulr_pas) safeDestroy(d.ulr_pas);
    if (d.ulr_pas_t) safeDestroy(d.ulr_pas_t);
    d.ulr_frag = d.ulr_pas = d.ulr_pas_t = null;
    d.__ulrPasUntil = null;
  }
  function clearSupport() {
    var G = gameOf();
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Raid : null;
    var rows = R && Array.isArray(R.raid_support_list) ? R.raid_support_list : [];
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      if (!d) continue;
      dropSupportDeco(d);
      delete d.ulr_frag;
      delete d.ulr_pas;
      delete d.ulr_pas_t;
      delete d.__ulrPasUntil;
      delete d.__ulrKey;
    }
  }

  // ---- ② 地圖渦 -------------------------------------------------------------
  //
  // 滑上渦亮清單列是官方的 bug：show_vortex 的 pointerover／pointerout 拿渦的 code 去
  // raid_list_displayed 找列，改版後別人開的渦 code 是 null（只有發現者看得到），
  // null === null 就對到第一個 code 是 null 的列 —— 滑哪個渦都亮那一列。
  // （反方向滑清單列亮渦是拿 profound_id 對的，沒事。）
  // 包官方那兩支：呼叫的那一下把清單換成「對得上的那一列是真的、其他列是假的」，
  // 官方照舊 findIndex、畫框、記 select，列號與列物件都是真的。
  var NO_CODE = {};
  function fixHover(R, base, id) {
    if (base.__ulrHover || typeof base.listeners !== "function" || typeof base.off !== "function") return;
    var done = [];
    ["pointerover", "pointerout"].forEach(function (ev) {
      base.listeners(ev).forEach(function (orig) {
        var wrapped = function () {
          var real = R.raid_list_displayed;
          var r = raidById(R, id);
          if (!r || !Array.isArray(real)) return orig.apply(this, arguments);
          var view = real.map(function (row) {
            return row && row.found_at === r.found_at && row.limit === r.limit ? row : { code: NO_CODE, select: null };
          });
          R.raid_list_displayed = view;
          try { return orig.apply(this, arguments); } finally { if (R.raid_list_displayed === view) R.raid_list_displayed = real; }
        };
        base.off(ev, orig);
        base.on(ev, wrapped);
        done.push({ ev: ev, orig: orig, wrapped: wrapped });
      });
    });
    base.__ulrHover = done;
  }
  function unfixHover(base) {
    var done = base.__ulrHover;
    base.__ulrHover = null;
    if (!done || !alive(base)) return;
    for (var i = 0; i < done.length; i++) {
      try { base.off(done[i].ev, done[i].wrapped); base.on(done[i].ev, done[i].orig); } catch (e) {}
    }
  }
  function decorateMap(st, R, G) {
    var vs = R.raid_vortex || [];
    var me = meMaybe(R);
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (!v || !alive(v.base)) continue;
      var base = v.base;
      fixHover(R, base, v.id);
      var r = raidById(R, v.id);
      var e = entryOf(st, r);
      var fi = r ? fragInfo(st, G, r) : null;
      var own = !!(r && me !== null && r.founder === me);
      var icon = v.icon;
      var key = v.id + "|" + entrySig(e) + "|" + fragSig(fi) + "|" + own;
      var deco = base.__ulrRaidView;
      // 處理過、而且漩渦還是我們的灰階（死渦不動）才跳過
      var iconOk = !alive(icon) || !icon.anims || (icon.texture && icon.texture.key === GRAY_TEX);
      if (deco && deco.key === key && deco.icon === icon && iconOk) continue;
      if (deco) destroyAll(deco.extras);
      var extras = [];
      // 官方換 frame（滑上去 0↔1）不會清 tint，所以只在這裡上一次
      try { base.clearTint(); } catch (err) {}
      if (own) base.setTintFill(CFG.ownTint);
      // 漩渦上碎片色；**不知道的一律灰色**（玩家 2026-09-25：官方的藍／紅會被當成碎片色）。
      // 活著的渦是 sprite（有 anims），死渦是 _expired 的 image，不動
      if (alive(icon) && icon.anims && ensureGray(G)) {
        if (!(icon.texture && icon.texture.key === GRAY_TEX)) {
          icon.__ulrOrig = icon.texture ? icon.texture.key : null;
          try { icon.anims.stop(); } catch (err) {}
          icon.setTexture(GRAY_TEX, icon.frame ? String(icon.frame.name) : undefined);
          try { icon.play(GRAY_ANIM); } catch (err) {}
        }
        icon.setTint(fi ? fi.frag.tint : CFG.unknownTint);
        icon.setAlpha(fi && guessed(fi) ? LEARNED_ALPHA : 1);
      }
      var items = extraItems(G, e);
      if (items.length) {
        var h = base.displayHeight || base.height || 40;
        addItemIcon(R, G, base.x - ICON / 2, base.y - h / 2 - ICON / 2, items[0], ICON, (base.depth || 0) + 0.0005, extras);
      }
      if (!deco) st.map.push(base);
      base.__ulrRaidView = { key: key, extras: extras, icon: icon };
    }
    st.map = st.map.filter(function (b) {
      if (alive(b)) return true;
      if (b.__ulrRaidView) destroyAll(b.__ulrRaidView.extras);
      return false;
    });
  }
  /** 漩渦換回官方的貼圖與動畫（官方的動畫 key 跟貼圖 key 同名：vortex_{category}）。 */
  function restoreIcon(icon) {
    var key = icon.__ulrOrig;
    icon.__ulrOrig = null;
    if (!alive(icon) || !key) return;
    try { icon.anims.stop(); } catch (e) {}
    try { icon.clearTint(); icon.setAlpha(1); icon.setTexture(key, 0); icon.play(key); } catch (e) {}
  }
  function undoMap(st) {
    for (var i = 0; i < st.map.length; i++) {
      var b = st.map[i];
      var d = b.__ulrRaidView;
      if (d) { destroyAll(d.extras); if (d.icon && d.icon.__ulrOrig) restoreIcon(d.icon); }
      b.__ulrRaidView = null;
      unfixHover(b);
      if (alive(b)) { try { b.clearTint(); } catch (e) {} }
    }
    st.map = [];
  }

  // ---- ③ 詳細面板 -----------------------------------------------------------
  /** 包原型：記下這次點開的是哪一列（官方沒記在場景上）。 */
  function hookDetail(st, R) {
    var proto = Object.getPrototypeOf(R);
    if (!proto || typeof proto.create_raid_detail !== "function") return;
    var cur = proto.create_raid_detail;
    if (cur.__ulrRaidView && st.detailProto === proto) return;
    var orig = cur.__ulrRaidView || cur;
    var wrapped = function (row) {
      this.__ulrRaidDetailRow = row;
      return orig.apply(this, arguments);
    };
    wrapped.__ulrRaidView = orig;
    proto.create_raid_detail = wrapped;
    st.detailProto = proto;
  }
  function unhookDetail(st) {
    var proto = st.detailProto;
    if (proto && proto.create_raid_detail && proto.create_raid_detail.__ulrRaidView) {
      proto.create_raid_detail = proto.create_raid_detail.__ulrRaidView;
    }
    st.detailProto = null;
    var sp = st.startProto;
    if (sp && sp.create_raid_start_panel && sp.create_raid_start_panel.__ulrRaidView) {
      sp.create_raid_start_panel = sp.create_raid_start_panel.__ulrRaidView;
    }
    st.startProto = null;
  }

  // ---- 自己看到的 stage ------------------------------------------------------
  //
  // 2026-09-25 實機：打渦時戰鬥設定 MainA.room_config 有 stage（"002"），發現渦時伺服器送的
  // raid_title（Raid_Title.raid_data）有 raid_stage（2）—— 同一個靈龜兩邊一致，官方拿它挑背景圖。
  // ulgg 的 stage 標著 stage_sync_report，應該也是這樣來的。
  //
  // 開打：官方 create_raid_start_panel(row) 按 OK 才 fetch("raid_start", row.profound_id…)，
  //       包原型記下是哪個渦；戰鬥的 room_config 換了一份（room_id 不同）就記那場的 stage，
  //       BOSS（playerB_deck 第一張）要跟那個渦的怪物一樣才算。
  // 發現：raid_title 沒有 profound_id —— 對「自己開的、同一隻怪、還沒記過 stage、發現時刻在 3 分鐘內的渦」。
  // ⚠ 兩條都只看得到插件接著遊戲時發生的事：接上之前發現／打過的渦，要再打一場才有 stage。
  function hookStart(st, R) {
    var proto = Object.getPrototypeOf(R);
    if (!proto || typeof proto.create_raid_start_panel !== "function") return;
    var cur = proto.create_raid_start_panel;
    if (cur.__ulrRaidView && st.startProto === proto) return;
    var orig = cur.__ulrRaidView || cur;
    var wrapped = function (row) {
      if (row && typeof row.profound_id === "string") this.__ulrRaidStartId = row.profound_id;
      return orig.apply(this, arguments);
    };
    wrapped.__ulrRaidView = orig;
    proto.create_raid_start_panel = wrapped;
    st.startProto = proto;
  }
  function putStage(id, stage, src) {
    var S = window[STAGES] || (window[STAGES] = {});
    var prev = S[id];
    // v：哪一版記的。舊版的「發現」對法會套錯渦，上傳快照不收（見 RAID_TITLE_TRUSTED_SINCE）
    S[id] = { stage: stage, src: src, at: Date.now(), v: CFG.version };
    // 讀到 stage（每場開打都算）：叫托盤馬上回報 ulgg，不等下一輪（戰鬥中那一輪不跑）。
    // stage 沒變也通知：舊版記下的、上次沒報成的，再打一場就補上；報過的托盤自己會跳過
    report({ type: "raid-stage" });
    for (var k in S) if (Date.now() - S[k].at > 3 * 24 * 3600 * 1000) delete S[k];
  }
  /**
   * 這一場打的是哪個渦。戰鬥設定的 expire_limit 就是那個渦的 limit（2026-09-25 實機兩場都一樣），
   * 對上 BOSS 就是它 —— 打渦.py 那種直接 emit、沒經過回合面板的也對得到。
   * 對不到再看回合面板記下的 profound_id（一樣要 BOSS 對得上）。
   */
  function battleRow(R, rc, boss) {
    var list = R && Array.isArray(R.raid_list) ? R.raid_list : [];
    if (typeof rc.expire_limit === "number") {
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].limit === rc.expire_limit && list[i].monster_id === boss) return list[i];
    }
    var id = R && R.__ulrRaidStartId;
    var r = id ? raidById(R, id) : null;
    return r && r.monster_id === boss ? r : null;
  }
  function watchBattleStage(st, G) {
    var M = G.scene.keys.MainA;
    var rc = M && M.room_config;
    if (!rc || rc.rule !== "raid" || rc.room_id === st.lastRoom) return;
    // 剛裝上的第一輪看到的戰鬥設定可能是很久以前那場：stage 照記（不會變），隊伍不記
    var first = !st.primed;
    st.lastRoom = rc.room_id;
    st.battle = null;
    var R = G.scene.keys.Raid;
    var boss = rc.playerB_deck && rc.playerB_deck.chara_card_id ? rc.playerB_deck.chara_card_id[0] : null;
    var r = R ? battleRow(R, rc, boss) : null;
    if (!r) return;
    var id = r.profound_id;
    if (!first) startBattle(G, R, M, rc, r);
    // 這一場打的是哪個渦：BOSS 資料（_chara1）晚一點才到，到了再記狀態
    // chara 記上一輪看到的 _chara1（上一場的）：新的換進來就是這一場的，同一輪到也認得。
    // 剛裝上的第一輪（還沒看過）不記：那時的 room_config 可能是很久以前那場，狀態早就不準
    if (st.seenChara !== undefined) st.battle = { room: rc.room_id, id: id, boss: boss, chara: st.seenChara };
    var stage = parseInt(rc.stage, 10);
    if (isFinite(stage)) putStage(id, stage, "battle");
  }

  // ---- ⑨ 打渦隊伍：記一場 ----------------------------------------------------
  //
  // 開打（上面 watchBattleStage 看到新的戰鬥設定）：記渦、回合 turn_limit、牌組（戰鬥設定裡
  //   自己那副，新 id）、AP＝清單列 ap × 回合（官方回合面板同一條）、開打前的 player_point。
  // 傷害：戰鬥 socket 的 damage_opponent(值, 剩餘HP, HP上限, 攻擊, 非攻擊)，只加第 4 個參數是
  //   true 的（攻擊擲骰打出來的）。改版後榜上沒有 damage，只能自己算。2026-09-25 實機：
  //   · 靈龜（身上沒狀態）1＋15 都是 [.., true, false]，BOSS 6000→5984、榜上 2093 分（16×100＋500 存活）
  //   · 龍鯰身上有別人上的 jikai／poison：回合開頭 [1, .., false, true] 兩下、BOSS 技能後
  //     [51, .., false, true] —— 狀態跳血與 BOSS 自傷，不是自己打的（全加的話記 88、榜上只漲 196 分）
  // 分數：回到渦房、清單換了一份（Raid.init 重拿 db_raid）之後讀 player_point 相減；
  //   之後 15 分鐘內再漲（提早離場時晚到）用同一個 at 補報。
  // 還沒量到又開打（連打）：用開打那一刻的清單先把上一場結算掉。
  // 暫存掛在 window 上、重裝不清：打到一半插件重裝，回來還是要量得到那一場。
  var BATTLE = "__ulrRaidBattle", TAIL = "__ulrRaidBattleTail";
  var CARD_KEY = /^(cc|mc)\\d{3,4}(_\\d{2})?$/;
  /** 隊伍看板上的「渦」：發現者＋發現時刻（跟 @ulr/arbiter-link 的 raidTeamRef 同一個寫法）。 */
  function teamRef(r) {
    return r && typeof r.founder === "string" && typeof r.found_at === "number" ? r.founder + "@" + r.found_at : null;
  }
  /** 排行榜上的名字是「Lv.92 名字」。 */
  function rankName(s) { return typeof s === "string" ? s.replace(/^Lv\\.\\d+\\s+/, "") : null; }
  function idSlots(v, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(v && typeof v[i] === "number" && isFinite(v[i]) ? v[i] : null);
    return out;
  }
  /** 戰鬥設定裡的牌組 → 隊伍看板那 27 格（欄位名是舊的，裝新 id）。一張角色都認不出來回 null。 */
  function deckOf(G, d) {
    if (!d || !Array.isArray(d.chara_card_id)) return null;
    var charaIndex = idSlots(d.chara_card_id, 3), chara = [], any = false;
    for (var i = 0; i < 3; i++) {
      var row = charaIndex[i] === null ? null : byId(G, "CharaCards", charaIndex[i]);
      var key = row && typeof row.chara === "string" && CARD_KEY.test(row.chara) ? row.chara : null;
      if (key !== null) any = true;
      chara.push(key);
    }
    if (!any) return null;
    return { chara: chara, charaIndex: charaIndex, weapon: idSlots(d.weapon_card_id, 3), eventIndex: idSlots(d.event_card_id, 18) };
  }
  function startBattle(G, R, M, rc, r) {
    var prev = window[BATTLE];
    if (prev) settleEarly(prev, R, r.profound_id);
    window[BATTLE] = null;
    // 同一個渦之後才進帳的分數算新這一場的（它的開打前分數已經含進去了），別的渦的補報照留
    window[TAIL] = tails().filter(function (t) { return t.b.id !== r.profound_id; });
    var me = meMaybe(R), ref = teamRef(r);
    var side = M.player_side === "B" ? "B" : "A";
    var deck = deckOf(G, rc["player" + side + "_deck"]);
    var turns = rc.turn_limit;
    if (!me || !ref || !deck || typeof turns !== "number" || turns < 1) return;
    var spend = typeof r.ap === "number" ? r.ap : 1;
    window[BATTLE] = {
      id: r.profound_id, raid: ref, room: rc.room_id, player: me, limit: r.limit, turns: turns, ap: spend * turns,
      deck: deck, before: typeof r.player_point === "number" ? r.player_point : 0, list: R.raid_list,
      at: Date.now(), damage: 0
    };
  }
  /** 戰鬥的 socket 每場換一顆（game_result 會 off() 全部再斷線）：換了就掛到新的上。 */
  function hookDamage(st, G) {
    var b = window[BATTLE];
    var M = G.scene.keys.MainA;
    var s = M && M.socket;
    if (!b || !M || !M.room_config || M.room_config.room_id !== b.room || !s || typeof s.on !== "function") return;
    if (st.dmgSocket === s) return;
    unhookDamage(st);
    var room = b.room;
    var fn = function (v, hp, hpMax, byAttack) {
      var cur = window[BATTLE];
      if (byAttack !== true) return;   // 狀態跳血、BOSS 自傷
      if (cur && cur.room === room && typeof v === "number" && isFinite(v) && v > 0) cur.damage += v;
    };
    s.on("damage_opponent", fn);
    st.dmgSocket = s;
    st.dmgHandler = fn;
  }
  /** 拆的是當初掛上去的那一支（重裝後新腳本的 fn 是另一個函式）。 */
  function unhookDamage(st) {
    try { if (st.dmgSocket && st.dmgHandler && typeof st.dmgSocket.off === "function") st.dmgSocket.off("damage_opponent", st.dmgHandler); } catch (e) {}
    st.dmgSocket = null;
    st.dmgHandler = null;
  }
  function battleReport(b, points) {
    return { type: "raid-battle", raid: b.raid, player: b.player, limit: b.limit, turns: b.turns, ap: b.ap,
      damage: b.damage, points: points, deck: b.deck, at: b.at };
  }
  /** 榜上自己的分數漲了多少。渦不見了算 0（傷害是戰鬥裡量的，照樣記）。 */
  function pointsOf(R, b) {
    var r = raidById(R, b.id);
    return r && typeof r.player_point === "number" ? Math.max(0, r.player_point - b.before) : 0;
  }
  function tails() {
    var t = window[TAIL];
    if (!Array.isArray(t)) t = [];
    window[TAIL] = t;
    return t;
  }
  function addTail(b, points, list) {
    var rest = tails().filter(function (t) { return t.b.id !== b.id; });
    b.list = null;
    rest.push({ b: b, points: points, list: list, until: Date.now() + CFG.tailMs });
    window[TAIL] = rest;
  }
  function settleEarly(prev, R, nextId) {
    if (Date.now() - prev.at > CFG.battleMaxMs) return;
    var points = pointsOf(R, prev);
    report(battleReport(prev, points));
    if (prev.id !== nextId) addTail(prev, points, R.raid_list);
  }
  /** 人在渦房時每一輪：清單換過一份（不是開打前那份）就量。 */
  function settleBattle(R) {
    settleTail(R);
    var b = window[BATTLE];
    if (!b) return;
    if (Date.now() - b.at > CFG.battleMaxMs) { window[BATTLE] = null; return; }
    if (R.raid_list === b.list) return;
    window[BATTLE] = null;
    var points = pointsOf(R, b);
    report(battleReport(b, points));
    addTail(b, points, R.raid_list);
  }
  function settleTail(R) {
    var list = tails().filter(function (t) { return Date.now() <= t.until; });
    window[TAIL] = list;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (R.raid_list === t.list) continue;
      t.list = R.raid_list;
      var points = pointsOf(R, t.b);
      if (points <= t.points) continue;
      t.points = points;
      report(battleReport(t.b, points));
    }
  }

  // ---- BOSS 狀態 ------------------------------------------------------------
  //
  // 改版後渦清單沒有 state、ulgg 的 state_raw 也全空（2026-09-25）。看得到的地方只剩戰鬥：
  // 開場官方 fetch("get_chara_opponent") 把 BOSS 放在 MainA._chara1，
  // state 是 [{type, turn}]，turn 大於 9 是到期時刻（ms），否則是回合數／層數
  // （官方畫狀態圖示的那支就是這樣分的）。記的是**開打那一刻** BOSS 身上的狀態。
  function watchBossStates(st, G) {
    var M = G.scene.keys.MainA;
    var c = M ? M._chara1 || null : null;
    var b = st.battle;
    st.seenChara = c;
    if (!b || !M.room_config || M.room_config.room_id !== b.room) return;
    if (!c || c === b.chara || c.card_id !== b.boss || !Array.isArray(c.state)) return;
    b.chara = c;
    var S = window[BOSS_STATES] || (window[BOSS_STATES] = {});
    S[b.id] = { states: statesOf(c.state), at: Date.now() };
    for (var k in S) if (Date.now() - S[k].at > 24 * 3600 * 1000) delete S[k];
    // 狀態有持續時間：叫托盤馬上傳（公開渦通知），不等打完回渦房那一輪 —— 那時多半已經過期
    report({ type: "raid-stage" });
  }
  // 戰鬥裡 BOSS 的被動框（官方 opponent_passive）：伺服器每次送「這一側開著哪些被動 id」，
  // 官方就把框點亮（skill_passive 第 1 格）或變暗（第 0 格）。亮暗一變就記一筆（時刻、HP、亮著的 id），
  // 拿來驗 raid-passive.ts 的規則 —— 例如狗第 19／49 分到底有沒有硬化（2026-10-04 玩家記得沒有，
  // 原版伺服器碼說有）。記在 window，重裝不清。
  var PASSIVE_LOG = "__ulrRaidPassiveLog";
  function watchBossPassives(st, G) {
    var M = G.scene.keys.MainA;
    var c = M ? M._chara1 || null : null;
    var b = st.battle;
    if (!b || !c || c.card_id !== b.boss || !Array.isArray(M.opponent_passive) || !M.opponent_passive.length) return;
    var on = [];
    for (var i = 0; i < M.opponent_passive.length; i++) {
      var p = M.opponent_passive[i];
      var base = p ? p.passive_base : null;
      var id = p && typeof p.getData === "function" ? p.getData("passive_id") : null;
      if (base && base.frame && String(base.frame.name) === "1" && typeof id === "number") on.push(id);
    }
    var sig = b.id + "|" + on.join(",");
    if (sig === st.passiveSig) return;
    st.passiveSig = sig;
    var hpT = M.opponent_HP, hp = hpT && hpT.text !== undefined ? parseInt(String(hpT.text).split(",").join(""), 10) : NaN;
    var log = window[PASSIVE_LOG] || (window[PASSIVE_LOG] = []);
    log.push({ at: Date.now(), raid: b.id, card: c.card_id, hp: isFinite(hp) ? hp : c.hp, hpMax: c.hp_max, on: on });
    if (log.length > 300) log.shift();
  }
  /** [{type, turn}] → [{type, until, count}]。認不得的丟掉。 */
  function statesOf(raw) {
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (!s || typeof s.type !== "string" || typeof s.turn !== "number") continue;
      out.push(s.turn > 9 ? { type: s.type, until: s.turn, count: null } : { type: s.type, until: null, count: s.turn });
    }
    return out;
  }
  /** 這個渦現在的狀態：自己打的時候看到的、或互傳來的，取新的那份；過期的拿掉。 */
  function bossStates(st, r) {
    if (!r) return [];
    var S = window[BOSS_STATES];
    var own = S ? S[r.profound_id] : null;
    var pub = publicOf(st, r);
    var src = own;
    if (pub && Array.isArray(pub.states) && typeof pub.statesAt === "number" && (!own || pub.statesAt > own.at)) src = { states: pub.states, at: pub.statesAt };
    if (!src) return [];
    var now = Date.now(), out = [];
    for (var i = 0; i < src.states.length; i++) {
      var s = src.states[i];
      if (s && (s.until === null || s.until > now)) out.push(s);
    }
    return out;
  }
  function stateSig(states) {
    var p = [];
    for (var i = 0; i < states.length; i++) p.push(states[i].type + ":" + states[i].until + ":" + states[i].count);
    return p.join(",");
  }
  /** 剩幾秒 → 「4h」「12m」「32s」。 */
  function remainText(until) {
    var s = Math.floor((until - Date.now()) / 1000);
    if (s <= 0) return "";
    if (s >= 3600) return Math.floor(s / 3600) + "h";
    if (s >= 60) return Math.floor(s / 60) + "m";
    return s + "s";
  }
  // 狀態圖示是官方的 StateIcons（frame 名就是狀態代碼），只在戰鬥裡載、離開就卸。
  // 戰鬥時抄一份進自己的 canvas 貼圖。這是官方原圖的複本，重裝不卸（卸了要再打一場才有）。
  var STATE_TEX = "__ulrStateIcons";
  function ensureStateIcons(G) {
    if (G.textures.exists(STATE_TEX) || !G.textures.exists("StateIcons")) return;
    if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof G.textures.addCanvas !== "function") return;
    try {
      var src = G.textures.get("StateIcons");
      var names = src.getFrameNames().filter(function (n) { return n !== "__BASE"; });
      if (!names.length) return;
      var w = 0, h = 0;
      for (var i = 0; i < names.length; i++) { var f = src.get(names[i]); w += f.width + 1; h = Math.max(h, f.height); }
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d"), x = 0, cut = [];
      for (var j = 0; j < names.length; j++) {
        var g = src.get(names[j]);
        ctx.drawImage(g.source.image, g.cutX, g.cutY, g.width, g.height, x, 0, g.width, g.height);
        cut.push([names[j], x, g.width, g.height]);
        x += g.width + 1;
      }
      var tex = G.textures.addCanvas(STATE_TEX, c);
      for (var k = 0; k < cut.length; k++) tex.add(String(cut[k][0]), 0, cut[k][1], 0, cut[k][2], cut[k][3]);
    } catch (e) {}
  }
  function stateFrame(G, code) {
    if (frameIn(G, STATE_TEX, code)) return code;
    var base = code.replace(/\\d+$/, "");
    return base !== code && frameIn(G, STATE_TEX, base) ? base : null;
  }
  function stateLabel(code) {
    var whole = CFG.statuses[code];
    if (whole) return { text: whole.short, color: CFG.statusColors[whole.kind] };
    var m = /^([A-Za-z]+)(\\d+)$/.exec(code);
    if (m && CFG.statuses[m[1]]) return { text: CFG.statuses[m[1]].short + m[2], color: CFG.statusColors[CFG.statuses[m[1]].kind] };
    return { text: code, color: CFG.statusColors.neutral };
  }
  /** 官方的狀態說明（State.json 的 {lang}_clip）；圖示滑上去用。 */
  function stateClip(G, code) {
    try {
      var J = G.cache.json.get("State");
      if (!J) return null;
      var key = code === "poison" ? "poison" : null;
      if (key === null) for (var k in J) if (code.indexOf(k) === 0 && (key === null || k.length > key.length)) key = k;
      var row = key !== null ? J[key] : null;
      return row ? String(row[gameLang() + "_clip"] || row.tcn_clip || "") || null : null;
    } catch (e) { return null; }
  }
  /**
   * 一排狀態：圖示（沒抄到就寫兩字標籤）＋剩餘時間或層數。寬度到 maxX 就停，不畫半個。
   * 剩餘時間的字記進 timers，每幀更新。tip 給了就掛說明（滑上去才出現）。
   */
  function addStateIcons(sc, G, x, y, states, depth, size, maxX, out, timers, tip) {
    var cx = x;
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      var frame = stateFrame(G, s.type);
      var objs = [], w = 0, hit;
      if (frame !== null) {
        hit = sc.add.image(cx, y, STATE_TEX, frame).setOrigin(0, 0.5).setDepth(depth);
        hit.setScale(size / Math.max(hit.width || size, hit.height || size, 1));
        w = hit.displayWidth || size;
      } else {
        var lb = stateLabel(s.type);
        hit = sc.add.text(cx, y, lb.text, { fontFamily: FONT, fontSize: 11, resolution: 2, color: lb.color }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
        w = hit.width;
      }
      objs.push(hit);
      var tail = s.count !== null ? String(s.count) : remainText(s.until);
      var tt = sc.add.text(cx + w + 1, y + 1, tail, { fontFamily: FONT, fontSize: 9, resolution: 2, color: "#ffffff" }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
      objs.push(tt);
      w += 1 + tt.width;
      if (maxX !== null && cx + w > maxX) { destroyAll(objs); break; }
      for (var k = 0; k < objs.length; k++) out.push(objs[k]);
      if (s.until !== null) timers.push({ text: tt, until: s.until });
      if (tip) hangStateTip(sc, G, hit, s.type, depth, tip);
      cx += w + 4;
    }
    return cx;
  }
  function hangStateTip(sc, G, hit, code, depth, tip) {
    hangTip(sc, hit, stateClip(G, code), depth, tip);
  }
  function hangTip(sc, hit, clip, depth, tip) {
    if (!clip) return;
    try {
      hit.setInteractive();
      hit.on("pointerover", function () {
        destroyAll(tip);
        var tt = sc.add.text(hit.x, hit.y + 10, clip, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(0, 0).setDepth(depth + 6);
        var bg = sc.rexUI.add.roundRectangle(tt.x + tt.width / 2, tt.y + tt.height / 2, tt.width + 10, tt.height + 6, 2, 0x000000, 0.85).setDepth(depth + 5);
        tip.push(bg, tt);
      });
      hit.on("pointerout", function () { destroyAll(tip); });
    } catch (e) {}
  }
  function tickTimers(timers) {
    for (var i = 0; i < timers.length; i++) {
      var t = timers[i];
      if (!alive(t.text)) continue;
      var want = remainText(t.until);
      if (t.text.text !== want) t.text.setText(want);
    }
  }

  // ---- BOSS 被動（硬化、吸收、潛伏、濁濫、夜霧、隱身、收穫、磁暴）--------------
  //
  // 伺服器不送「現在開哪個」，但規則固定（raid-passive.ts，抄原版伺服器的 check_*_passive）：
  // 狗看現實時間的分鐘、蟲／海／龜看渦的 HP。帶哪些被動看 CharaCards 那一列的 passive
  // （清單的 monster_id 就是那一列的 id），什麼時候開照 CFG.passives 算。
  // 分鐘直接用 UTC 的（日本／台灣跟 UTC 差整數小時，分鐘一樣）。
  var passiveIdCache = {};
  function passiveIdsOf(G, monsterId) {
    if (typeof monsterId !== "number") return [];
    if (passiveIdCache[monsterId]) return passiveIdCache[monsterId];
    var cards = null;
    try { cards = G.cache.json.get("CharaCards"); } catch (e) {}
    if (!Array.isArray(cards) || !cards.length) return [];
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c || c.id !== monsterId || !Array.isArray(c.passive)) continue;
      for (var j = 0; j < c.passive.length; j++) {
        var p = c.passive[j];
        var id = p && typeof p === "object" ? p.id : p;
        if (typeof id === "number") out.push(id);
      }
      break;
    }
    passiveIdCache[monsterId] = out;
    return out;
  }
  /** 現在開著的被動 [{id, short, until}]（until 是時間制那一段結束的時刻，HP 制是 null）。 */
  function activePassives(ids, hp, hpMax, now) {
    var out = [], on = {};
    if (!ids.length || (typeof hp === "number" && hp <= 0)) return out;
    var minuteNo = Math.floor(now / 60000), min = minuteNo % 60;
    for (var i = 0; i < CFG.passives.length; i++) {
      var rule = CFG.passives[i];
      if (ids.indexOf(rule.id) < 0) continue;
      if (typeof rule.unless === "number" && on[rule.unless]) continue;
      var until = null;
      if (rule.minutes) {
        var span = null;
        for (var k = 0; k < rule.minutes.length; k++) if (min >= rule.minutes[k][0] && min <= rule.minutes[k][1]) span = rule.minutes[k];
        if (!span) continue;
        until = (minuteNo - min + span[1] + 1) * 60000;
      } else {
        if (typeof hp !== "number" || typeof hpMax !== "number" || !rule.hpAtMost) continue;
        if (Math.floor(hpMax * rule.hpAtMost[0] / rule.hpAtMost[1]) < hp) continue;
        if (rule.hpAbove && hp <= Math.floor(hpMax * rule.hpAbove[0] / rule.hpAbove[1])) continue;
      }
      on[rule.id] = true;
      out.push({ id: rule.id, short: rule.short, until: until });
    }
    return out;
  }
  function rowPassives(G, r) {
    return r ? activePassives(passiveIdsOf(G, r.monster_id), r.hp, r.hp_max, Date.now()) : [];
  }
  function passiveSig(list) {
    var p = [];
    for (var i = 0; i < list.length; i++) p.push(list[i].id + ":" + list[i].until);
    return p.join(",");
  }
  /** 官方的被動名稱＋說明（PassiveSkills.json，遊戲語言）；滑上去用。 */
  function passiveClip(G, id) {
    try {
      var J = G.cache.json.get("PassiveSkills") || [];
      for (var i = 0; i < J.length; i++) {
        if (!J[i] || J[i].id !== id) continue;
        var lg = gameLang();
        var name = String(J[i]["name_" + lg] || J[i].name_tcn || "");
        var info = String(J[i]["info_" + lg] || J[i].info_tcn || "").split("|")[0];
        return name + (info ? "\\n" + info : "");
      }
    } catch (e) {}
    return null;
  }
  /** 一排被動：兩字標籤（＋時間制的剩餘時間）。寬度到 maxX 就停。回傳下一個 x。 */
  function addPassiveTags(sc, G, x, y, list, depth, maxX, out, timers, tip) {
    var cx = x;
    for (var i = 0; i < list.length; i++) {
      var p = list[i], objs = [];
      var t = sc.add.text(cx, y, p.short, { fontFamily: FONT, fontSize: 11, resolution: 2, color: CFG.passiveColor }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
      objs.push(t);
      var w = t.width, tt = null;
      if (p.until !== null) {
        tt = sc.add.text(cx + w + 1, y + 1, remainText(p.until), { fontFamily: FONT, fontSize: 9, resolution: 2, color: "#ffffff" }).setOrigin(0, 0.5).setDepth(depth).setStroke("black", 2);
        objs.push(tt);
        w += 1 + tt.width;
      }
      if (maxX !== null && cx + w > maxX) { destroyAll(objs); break; }
      for (var k = 0; k < objs.length; k++) out.push(objs[k]);
      if (tt) timers.push({ text: tt, until: p.until });
      if (tip) hangTip(sc, t, passiveClip(G, p.id), depth, tip);
      cx += w + 4;
    }
    return cx;
  }
  // 發現渦：raid_title 每發現一個就換一份。人不在渦房（還在任務裡）也要先收著 ——
  // 連著發現兩個才進渦房，前一個會被蓋掉。進了渦房、清單上有了再對。
  function noteTitle(st, G) {
    var T = G.scene.keys.Raid_Title;
    var d = T && T.raid_data;
    if (!d || d === st.lastTitle) return;
    st.lastTitle = d;
    var stage = typeof d.raid_stage === "number" ? d.raid_stage : parseInt(d.raid_stage, 10);
    if (!isFinite(stage)) return;
    st.titles.push({ chara: d.raid_chara_id, stage: stage, at: Date.now() });
    if (st.titles.length > 10) st.titles.shift();
  }
  /**
   * 收著的每一筆：對自己開的、同一隻怪、還沒記過 stage、**發現時刻跟看到發現畫面的時刻差在
   * TITLE_MATCH_MS 內**、最接近的那個渦。
   *
   * ⚠ 2026-09-25 實機記錯過：06:02 發現新的靈龜（stage 3），清單還沒拉到它，舊規則
   * （同一隻怪、還沒記過、最新的）就把 3 套到 05:31 開的那隻舊靈龜上 —— 那隻結算掉的是
   * 時間碎片（stage 2）。stage 會上傳互傳，記錯會傳給別人，所以對不上時間的寧可不記。
   */
  var TITLE_MATCH_MS = 3 * 60 * 1000;
  function matchTitles(st, R) {
    var me = meMaybe(R);
    if (me === null || !st.titles.length) return;
    st.titles = st.titles.filter(function (p) {
      var best = null;
      for (var i = 0; i < R.raid_list.length; i++) {
        var r = R.raid_list[i];
        if (!r || r.founder !== me || r.monster_id !== p.chara || seenStage(r)) continue;
        if (typeof r.found_at !== "number" || Math.abs(r.found_at - p.at) > TITLE_MATCH_MS) continue;
        if (best === null || Math.abs(r.found_at - p.at) < Math.abs(best.found_at - p.at)) best = r;
      }
      // 渦清單還沒拉到新渦（剛發現、清單是舊的）：留著下一輪再對，太久就放棄
      if (best === null) return Date.now() - p.at < CFG.learnGiveUpMs;
      putStage(best.profound_id, p.stage, "title");
      return false;
    });
  }
  function detailRow(R) {
    var row = R.__ulrRaidDetailRow;
    if (!row) return null;
    return raidById(R, row.profound_id) || row;
  }
  /**
   * 自己在這個渦的名次。伺服器送的 player_rank 會錯（2026-09-26 龍鯰送 17，同一包 rank[] 裡
   * 自己排第 9；誘引之者送 6、實際第 3），rank[] 照分數排好、包含自己。所以學官方大廳排行
   * 從榜上找自己：名字（去掉 Lv.N）是自己、分數等於 player_point。找不到才退回 player_rank。
   * 沒分數（沒參加）回 null。
   */
  function myRankOf(R, r) {
    if (typeof r.player_point !== "number" || r.player_point <= 0) return null;
    var me = meMaybe(R), list = r.rank || [];
    if (me !== null) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && rankName(list[i].player_name) === me && list[i].point === r.player_point) return i + 1;
      }
    }
    return typeof r.player_rank === "number" ? r.player_rank : null;
  }
  /** 詳細面板的 Rank（官方 raid_detail_ranking_text 畫的是 player_rank）換成榜上算的。 */
  function decorateMyRank(R) {
    var t = R.raid_detail_ranking_text;
    var r = alive(t) && alive(R.raid_detail_name) ? detailRow(R) : null;
    var n = r ? myRankOf(R, r) : null;
    if (n !== null && String(t.text) !== String(n)) t.setText(String(n));
  }
  function dropInfo(st) {
    if (!st.info) return;
    destroyAll(st.info.objs);
    if (st.info.tip) destroyAll(st.info.tip);
    st.info = null;
  }
  /**
   * 「Points」與分數那一塊滑上去：渦的分數公式。官方 create_raid_detail 在 (496, 67) 畫
   * 「Points」（右對齊），分數接在它左邊 4px。蓋一塊 zone，不動官方的字。
   */
  function addPointsTip(R, depth, objs, tip) {
    var lb = R.raid_detail_point_label, pt = R.raid_detail_point_text;
    if (!alive(lb)) return;
    var left = Math.min(lb.x - lb.width, alive(pt) ? pt.x - pt.width : lb.x) - 2;
    var zone = R.add.zone(left, lb.y, lb.x + 2 - left, 16).setOrigin(0, 0.5).setDepth(depth).setInteractive();
    objs.push(zone);
    zone.on("pointerover", function () {
      destroyAll(tip);
      var tt = R.add.text(lb.x, lb.y + 12, L().pointsTip, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(1, 0).setDepth(depth + 6);
      var bg = R.rexUI.add.roundRectangle(tt.x - tt.width / 2, tt.y + tt.height / 2, tt.width + 10, tt.height + 6, 2, 0x000000, 0.85).setDepth(depth + 5);
      tip.push(bg, tt);
    });
    zone.on("pointerout", function () { destroyAll(tip); });
  }
  function decorateInfo(st, R, G) {
    var nameT = R.raid_detail_name;
    var r = alive(nameT) ? detailRow(R) : null;
    if (!r) {
      dropInfo(st);
      return;
    }
    var e = entryOf(st, r);
    var fi = fragInfo(st, G, r);
    var pt = R.raid_detail_point_text;
    var states = bossStates(st, r);
    var pas = rowPassives(G, r);
    var key = r.profound_id + "|" + entrySig(e) + "|" + fragSig(fi) + "|" + nameT.text + "|" + nameT.x + "|" + (alive(pt) ? pt.text : "-") +
      "|" + stateSig(states) + "|" + passiveSig(pas) + "|" + G.textures.exists(STATE_TEX);
    if (st.info && st.info.key === key && st.info.objs.every(alive)) { tickTimers(st.info.timers); return; }
    dropInfo(st);
    var objs = [], tip = [], timers = [];
    var depth = (nameT.depth || 1) + 0.01;
    // 「獎勵一覽」：名字那一列的右端（怪物名 276 右對齊在下一行，這一行右邊是空的）
    var btn = R.add.text(276, nameT.y, L().button, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
      .setOrigin(1, 0.5).setDepth(depth).setStroke("black", 3).setInteractive({ useHandCursor: true });
    btn.on("pointerover", function () { btn.setColor(BTN_HOVER); });
    btn.on("pointerout", function () { btn.setColor(BTN_COLOR); });
    btn.on("pointerup", function () { sfx(R); openPanel(st, R, G, detailRow(R) || r); });
    objs.push(btn);
    var x = nameT.x + nameT.width + 6, maxX = btn.x - btn.width - 6;
    if (fi && x + ICON <= maxX) x = addFragIcon(R, G, x, nameT.y, fi, ICON, depth, objs);
    var items = extraItems(G, e);
    for (var j = 0; j < items.length && j < 2; j++) {
      if (x + ICON > maxX) break;
      x = addItemIcon(R, G, x, nameT.y, items[j], ICON, depth, objs);
    }
    // BOSS 被動與狀態：名字下一行、怪物名（276 右對齊、y 58 起）左邊空著的那一段；被動在前
    if (states.length || pas.length) {
      var mons = R.raid_detail_mons_name;
      var sy = alive(mons) ? mons.y + (mons.height || 16) / 2 : 66;
      var sMax = alive(mons) ? mons.x - mons.width - 6 : 200;
      var sx = pas.length ? addPassiveTags(R, G, 72, sy, pas, depth, sMax, objs, timers, tip) : 72;
      if (states.length) addStateIcons(R, G, sx, sy, states, depth, 14, sMax, objs, timers, tip);
    }
    addPointsTip(R, depth, objs, tip);
    st.info = { key: key, objs: objs, tip: tip, timers: timers };
  }

  // ---- 獎勵一覽面板：官方結算那張底圖 --------------------------------------------
  // 官方 create_reward_init 用 raid_result_panel（渦房場景載、離開就卸）＋ result_panel_overlay
  // （左邊立繪）。人在渦房時抄一份進自己的 canvas 貼圖（卸了也還在）：標題那一塊用同一張圖
  // 下方的素面蓋掉，立繪只留左邊 130px（官方獎勵頁也是這樣 setCrop）。
  // 字照官方結算頁：標籤 font_heavy 12 白、內容 font_light 12 白、格子是白 5%～8% 的圓角條。
  var PANEL_X = 380, PANEL_Y = 340, PANEL_W = 576, PANEL_H = 336;
  var PANEL_L = PANEL_X - PANEL_W / 2, PANEL_T = PANEL_Y - PANEL_H / 2;

  function sourceOf(G, key) {
    try {
      if (!G.textures.exists(key)) return null;
      var img = G.textures.get(key).getSourceImage();
      return img && img.width > 64 ? img : null;
    } catch (e) { return null; }
  }
  function ensureSkin(st, G) {
    if (G.textures.exists(PANEL_TEX)) return true;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
    var panel = sourceOf(G, "raid_result_panel");
    if (!panel) return false;
    try {
      var c = document.createElement("canvas");
      c.width = panel.width; c.height = panel.height;
      var ctx = c.getContext("2d");
      ctx.drawImage(panel, 0, 0);
      if (panel.width === PANEL_W && panel.height === PANEL_H) ctx.drawImage(panel, 150, 100, 276, 32, 150, 3, 276, 32);
      G.textures.addCanvas(PANEL_TEX, c);
      var over = sourceOf(G, "result_panel_overlay");
      if (over && !G.textures.exists(CHAR_TEX)) {
        var c2 = document.createElement("canvas");
        c2.width = 130; c2.height = over.height;
        c2.getContext("2d").drawImage(over, 0, 0, 130, over.height, 0, 0, 130, over.height);
        G.textures.addCanvas(CHAR_TEX, c2);
      }
      return true;
    } catch (e) {
      st.reason = "panel skin: " + String((e && e.message) || e);
      return false;
    }
  }
  function labelStyle() { return { fontFamily: "font_heavy", fontSize: 12, color: "white", resolution: 2 }; }
  function valueStyle() { return { fontFamily: FONT, fontSize: 12, color: "white", resolution: 2 }; }
  function cellBar(R, x, y, w, depth, alpha) {
    return R.rexUI.add.roundRectangle(x, y - 8, w, 16, 2, 0xffffff, alpha === undefined ? 0.05 : alpha).setOrigin(0, 0).setDepth(depth);
  }
  function closePanel(st) {
    // 隊伍清單翻頁重畫的那幾列不在 panel 裡
    if (st.panelBody) { destroyAll(st.panelBody); st.panelBody = null; }
    if (!st.panel) return;
    destroyAll(st.panel);
    st.panel = null;
  }
  /** noChar：不放左邊的立繪（隊伍面板要整片寬度）。 */
  function panelShell(st, R, G, D, title, noChar) {
    var objs = [];
    var zone = R.add.zone(380, 340, 760, 680).setDepth(D).setInteractive();
    zone.on("pointerup", function () { closePanel(st); });
    objs.push(zone);
    if (ensureSkin(st, G)) {
      objs.push(R.add.image(PANEL_X, PANEL_Y, PANEL_TEX).setDepth(D + 1));
      if (!noChar && G.textures.exists(CHAR_TEX)) objs.push(R.add.image(PANEL_L, PANEL_T, CHAR_TEX).setOrigin(0, 0).setDepth(D + 1));
    } else {
      // 退路：底圖抄不到時照渦房橫幅的底色（#313134）畫一塊
      objs.push(R.rexUI.add.roundRectangle(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 2, 0x313134, 1).setDepth(D + 1).setStrokeStyle(1, 0x444447));
    }
    var t = R.add.text(PANEL_X, PANEL_T + 20, title, { fontFamily: "font_heavy", fontSize: 16, color: "#e6e6e6", resolution: 2 }).setOrigin(0.5, 0.5).setDepth(D + 2).setStroke("black", 3);
    objs.push(t);
    var ok;
    if (G.textures.exists("raid_panel_ok")) {
      ok = R.add.image(PANEL_X, PANEL_Y + 148, "raid_panel_ok", 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
      ok.on("pointerover", function () { ok.setTexture("raid_panel_ok", 1); });
      ok.on("pointerout", function () { ok.setTexture("raid_panel_ok", 0); });
      ok.on("pointerdown", function () { ok.setTexture("raid_panel_ok", 0); });
    } else {
      ok = R.add.text(PANEL_X, PANEL_Y + 148, "OK", { fontFamily: "font_heavy", fontSize: 15, color: "white", resolution: 2 }).setOrigin(0.5, 0.5).setDepth(D + 3).setStroke("black", 3).setInteractive({ useHandCursor: true });
    }
    ok.on("pointerup", function () { sfx(R); closePanel(st); });
    objs.push(ok);
    return objs;
  }
  function fadeIn(R, list) {
    if (!R.tweens || typeof R.tweens.add !== "function") return;
    var targets = list.filter(function (o) { return alive(o) && o.type !== "Zone" && o.visible; });
    for (var i = 0; i < targets.length; i++) targets[i].setAlpha(0);
    R.tweens.add({ targets: targets, alpha: 1, duration: 200, ease: "Power1" });
  }
  /** 一格：道具小圖＋名字，放不下就截成「…」。 */
  function itemsLine(R, G, x, y, maxX, list, depth, objs) {
    var cx = x;
    for (var i = 0; i < list.length; i++) {
      var group = [];
      var nx = addItemIcon(R, G, cx, y, list[i], 16, depth, group);
      var t = R.add.text(nx, y, itemName(G, list[i]), valueStyle()).setOrigin(0, 0.5).setDepth(depth);
      group.push(t);
      if (t.x + t.width > maxX) {
        destroyAll(group);
        objs.push(R.add.text(cx, y, "\\u2026", valueStyle()).setOrigin(0, 0.5).setDepth(depth));
        return;
      }
      for (var g = 0; g < group.length; g++) objs.push(group[g]);
      cx = t.x + t.width + 10;
    }
  }
  /**
   * 獎勵一覽：照官方結算的獎勵頁排 —— 左邊立繪、標籤一欄、右邊一條條格子。
   * 還沒學到：寫一句話，參加獎勵照清單上官方給的那份列。
   * 自己現在的名次落在哪一檔，那一檔的格子亮一點（0 分不算上榜）。
   */
  function openPanel(st, R, G, r) {
    closePanel(st);
    var D = 3000;
    var e = entryOf(st, r);
    var objs = panelShell(st, R, G, D, "Lv." + r.level + " " + String(r.name || ""));
    var left = PANEL_L + 140, ix = left + 88, right = PANEL_L + PANEL_W - 20, cellW = right - ix;
    var y = PANEL_T + 58, LINE = 18, BOTTOM = PANEL_T + 280;
    var line = function (list, alpha) {
      objs.push(cellBar(R, ix, y, cellW, D + 2, alpha));
      if (list === null) objs.push(R.add.text(ix + 5, y, L().unknown, valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
      else if (!list.length) objs.push(R.add.text(ix + 5, y, "-", valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
      else itemsLine(R, G, ix + 3, y, right - 4, list, D + 2, objs);
      y += LINE;
    };
    var label = function (t) { objs.push(R.add.text(left, y, t, labelStyle()).setOrigin(0, 0.5).setDepth(D + 2)); };
    if (!e) {
      objs.push(R.add.text(left, y - 8, L().notLearned, { fontFamily: FONT, fontSize: 12, color: "white", resolution: 2, wordWrap: { width: right - left } }).setOrigin(0, 0).setDepth(D + 2));
      y += 48;
      label(L().participation);
      line(codes(r.reward));
      // ulgg 有 stage：排名獎勵的碎片種類推得出來（數量不知道）
      var fi = fragInfo(st, G, r);
      if (fi && fi.source !== "learned") {
        y += 6;
        label(L().ranking);
        objs.push(cellBar(R, ix, y, cellW, D + 2));
        var fx = addFragIcon(R, G, ix + 3, y, fi, 16, D + 2, objs);
        var how = (fi.source === "map" ? L().fromMap : L().fromStage).replace("__S__", fi.stage);
        objs.push(R.add.text(fx, y, fi.frag.item + "  (" + how + ")", valueStyle()).setOrigin(0, 0.5).setDepth(D + 2));
        y += LINE;
      }
    } else {
      var myRank = myRankOf(R, r);
      label(L().discovery); line(e.discovery); y += 6;
      label(L().participation); line(e.participation); y += 6;
      // 標籤自己一行：名次範圍右對齊在格子左邊，跟標籤同一行會疊在一起
      label(L().ranking);
      if (!e.ranking.length) line([]);
      else y += LINE;
      for (var i = 0; i < e.ranking.length && y < BOTTOM - 40; i++) {
        var tier = e.ranking[i];
        var mine = myRank !== null && myRank >= tier.from && (tier.to === null || myRank <= tier.to);
        var range = tier.to === null ? L().rankOpen.replace("__A__", tier.from) : L().rank.replace("__A__", tier.from).replace("__B__", tier.to);
        objs.push(R.add.text(ix - 6, y, range, valueStyle()).setOrigin(1, 0.5).setDepth(D + 2));
        line(tier.items, mine ? 0.16 : undefined);
      }
      y += 6;
      label(L().defeat); line(e.defeat);
      var foot = L().learned.replace("__N__", e.samples) + (e.conflict ? "  \\u30fb " + L().conflict : "");
      objs.push(R.add.text(right, BOTTOM, foot, { fontFamily: FONT, fontSize: 10, color: "#bdbdbd", resolution: 2 }).setOrigin(1, 0.5).setDepth(D + 2));
    }
    fadeIn(R, objs);
    st.panel = objs;
  }

  // ---- ⑨ 打渦隊伍：看 --------------------------------------------------------
  //
  // 托盤把自己的紀錄＋插件互傳查到的別人的，整理成「渦 → 名字 → 隊伍」推下來（setTeams）。
  // 詳細面板右邊官方的排行榜（raid_detail_ranking[e] = {rank, player_name, point}，
  // 名字是「Lv.92 名字」、refresh_raid_ranking 翻頁時整批重建）：有隊伍的名字後面掛一顆
  // 牌組圖示（渦房自己載的 deck_icon）、名字點得下去。一支就直接開，多支先列清單。
  /** 某個渦某個人的隊伍，沒有回 null。 */
  function teamsOf(st, r, name) {
    var ref = teamRef(r);
    var byName = ref && st.teams ? st.teams[ref] : null;
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
  /** 名字後面那顆牌組圖示（渦房左下那顆 deck_icon，縮到 12px 高）。 */
  function teamIcon(R, G, x, y, depth, fn) {
    if (!G.textures.exists("deck_icon")) return null;
    var im = R.add.image(x, y, "deck_icon").setOrigin(0, 0.5);
    im.setScale(12 / (im.height || 12)).setDepth(depth).setInteractive({ useHandCursor: true });
    im.on("pointerup", fn);
    return im;
  }
  function teamsSig(teams) {
    var n = 0;
    for (var i = 0; i < teams.length; i++) n += teams[i].battles || 0;
    return teams.length + ":" + n;
  }
  function dropRank(st) {
    for (var i = 0; i < st.rank.length; i++) {
      var n = st.rank[i], d = n.__ulrRaidTeam;
      if (!d) continue;
      destroyAll(d.objs);
      unclickable(n, d);
      n.__ulrRaidTeam = null;
    }
    st.rank = [];
  }
  function decorateRanking(st, R, G) {
    var list = R.raid_detail_ranking || [];
    var r = alive(R.raid_detail_name) ? detailRow(R) : null;
    for (var e = 0; e < list.length; e++) {
      var it = list[e];
      var nameT = it && it.player_name;
      if (!alive(nameT)) continue;
      var deco = nameT.__ulrRaidTeam;
      var name = deco ? deco.name : rankName(nameT.text);
      var teams = r && name ? teamsOf(st, r, name) : null;
      var key = (name || "") + "|" + (teams ? teamsSig(teams) : "-");
      if (deco && deco.key === key) {
        for (var k = 0; k < deco.objs.length; k++) deco.objs[k].setVisible(nameT.visible);
        continue;
      }
      if (deco) { destroyAll(deco.objs); unclickable(nameT, deco); if (deco.full !== null) nameT.setText(deco.full); }
      var next = { key: key, name: name, objs: [], click: null, full: null };
      if (teams) {
        var open = (function (raid, who) { return function () { sfx(R); openTeams(st, R, G, raid, who); }; })(r, name);
        var pt = it.point;
        var maxX = alive(pt) ? pt.x - pt.width - 16 : nameT.x + 150;
        // 名字太長就截短，留位置給圖示
        if (nameT.x + nameT.width > maxX) {
          var full = String(nameT.text), len = full.length;
          next.full = full;
          while (len > 1 && nameT.x + nameT.width > maxX) { len--; nameT.setText(full.substring(0, len) + "..."); }
        }
        var icon = teamIcon(R, G, nameT.x + nameT.width + 3, nameT.y, (nameT.depth || 1) + 0.01, open);
        if (icon !== null) next.objs.push(icon.setVisible(nameT.visible));
        clickable(nameT, next, open);
      }
      if (!deco) st.rank.push(nameT);
      nameT.__ulrRaidTeam = next;
    }
    st.rank = st.rank.filter(function (n) {
      if (alive(n)) return true;
      if (n.__ulrRaidTeam) destroyAll(n.__ulrRaidTeam.objs);
      return false;
    });
  }

  /**
   * 卡面縮圖：遊戲自己的 CharaCardImages（每格 168×240，格名是 CharaCards 的 filename）。
   * 查不到畫空卡底（card_common_base）。左上角對齊。
   */
  function cardImage(R, G, x, y, h, id, depth) {
    var row = typeof id === "number" ? byId(G, "CharaCards", id) : null;
    var key = null, frame = null;
    if (row && typeof row.filename === "string" && frameIn(G, "CharaCardImages", row.filename)) { key = "CharaCardImages"; frame = row.filename; }
    else if (frameIn(G, "card_common_base", 0)) { key = "card_common_base"; frame = 0; }
    if (key === null) return null;
    return R.add.image(x, y, key, frame).setOrigin(0, 0).setDisplaySize(Math.round(h * 168 / 240), h).setDepth(depth);
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

  /**
   * 面板底部的翻頁列：頁碼＋官方 btn_arrow（沒翻＝指左，flipX＝指右），到頭那一邊藏起來。
   * onPage(頁) 負責重畫內容。
   */
  function addPager(R, G, D, objs, pages, onPage) {
    var cx = PANEL_X, navY = PANEL_T + 278;
    var page = 0, navs = [];
    var pageText = R.add.text(cx, navY, "", valueStyle()).setOrigin(0.5, 0.5).setDepth(D + 2);
    objs.push(pageText);
    var update = function () {
      pageText.setText((page + 1) + " / " + pages);
      for (var n = 0; n < navs.length; n++) navs[n].part.setVisible(navs[n].dir < 0 ? page > 0 : page < pages - 1);
    };
    var hasArrow = !!(G && G.textures.exists("btn_arrow"));
    var navBtn = function (x, dir) {
      var a = hasArrow
        ? R.add.image(x, navY, "btn_arrow", 0).setFlipX(dir > 0)
        : R.add.text(x, navY, dir < 0 ? "\\u2039" : "\\u203a", labelStyle()).setOrigin(0.5, 0.5);
      a.setDepth(D + 3).setInteractive({ useHandCursor: true });
      if (hasArrow) {
        a.on("pointerover", function () { a.setTexture("btn_arrow", 1); });
        a.on("pointerout", function () { a.setTexture("btn_arrow", 0); });
      }
      a.on("pointerup", function () {
        var to = page + dir;
        if (to < 0 || to >= pages) return;
        sfx(R);
        page = to;
        onPage(page);
        update();
      });
      navs.push({ dir: dir, part: a });
      objs.push(a);
    };
    navBtn(cx - 50, -1);
    navBtn(cx + 50, 1);
    return { set: function (p) { page = Math.max(0, Math.min(pages - 1, p)); onPage(page); update(); } };
  }

  /** 點了某人：一支就直接開那支；多支先列清單（傷害高的在前）。 */
  function openTeams(st, R, G, r, name) {
    var teams = teamsOf(st, r, name);
    if (!teams) return;
    teams = teams.slice().sort(function (a, b) { return b.damage - a.damage; });
    if (teams.length === 1) { openTeam(st, R, G, name, teams[0], null); return; }
    openTeamList(st, R, G, name, teams, 0);
  }

  /** 隊伍清單：一列一支 —— 三張卡面（之間不留縫）＋右邊的數字。一頁 4 支，點一列看整副。 */
  function openTeamList(st, R, G, name, teams, startPage) {
    closePanel(st);
    var D = 3000, PER = 4, ROW_H = 46;
    var objs = panelShell(st, R, G, D, L().teamsTitle.replace("__NAME__", name), true), body = [];
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
          var im = cardImage(R, G, col.team + s * cardW, top + 2, cardH, t.charaIndex[s], D + 3);
          if (im !== null) body.push(im);
        }
        var cell = function (x, txt) { body.push(R.add.text(x, cy, txt, valueStyle()).setOrigin(1, 0.5).setDepth(D + 3)); };
        cell(col.dmg, fmtInt(t.damage)); cell(col.pts, fmtInt(t.points)); cell(col.battles, fmtInt(t.battles)); cell(col.turns, fmtInt(t.turns));
        cell(col.ap, fmtInt(t.ap)); cell(col.perAp, perAp(t));
        var hit = R.add.zone(left - 4, top, right - left + 8, ROW_H - 4).setOrigin(0, 0).setDepth(D + 4).setInteractive({ useHandCursor: true });
        hit.on("pointerup", (function (team) {
          return function () {
            sfx(R);
            openTeam(st, R, G, name, team, function () { openTeamList(st, R, G, name, teams, current); });
          };
        })(t));
        body.push(hit);
      }
    };
    addPager(R, G, D, objs, pages, draw).set(startPage || 0);
    fadeIn(R, objs.concat(body));
    st.panel = objs;
    st.panelBody = body;
  }

  /**
   * 一支隊伍的整副：三欄，每欄一張卡面＋卡片正下方的武器（小圖＋名字）＋右邊 3×2 的事件卡；
   * 底下一排累計與每場平均。卡名、事件卡名滑上去才出來（面板字要短）。
   * back 不是 null 時左上角一顆箭頭回清單。
   */
  function openTeam(st, R, G, name, t, back) {
    closePanel(st);
    var D = 3000;
    var objs = panelShell(st, R, G, D, L().teamsTitle.replace("__NAME__", name), true);
    var left = PANEL_L + 20, colW = (PANEL_W - 40) / 3;
    var top = PANEL_T + 46, cardH = 100, cardW = Math.round(cardH * 168 / 240);
    var evH = 48, evW = Math.round(evH * 54 / 84);
    for (var s = 0; s < 3; s++) {
      var x0 = left + s * colW;
      var card = cardImage(R, G, x0, top, cardH, t.charaIndex[s], D + 2);
      if (card !== null) {
        objs.push(card);
        if (typeof t.charaIndex[s] === "number") hoverTip(R, card, itemName(G, { type: CFG.rewardTypes.chara, id: t.charaIndex[s], value: 0 }), D + 2, objs);
      }
      var wi = t.weapon[s];
      if (typeof wi === "number") {
        var wy = top + cardH + 11, wx = x0;
        if (frameIn(G, "WeaponCardImages", "weapon_" + wi)) {
          objs.push(R.add.image(wx, wy, "WeaponCardImages", "weapon_" + wi).setOrigin(0, 0.5).setDisplaySize(18, 18).setDepth(D + 2));
          wx += 21;
        }
        var wname = localName(byId(G, "WeaponCards", wi));
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
        if (typeof ei !== "number" || !frameIn(G, "EventCardImages", "event_" + ei)) continue;
        var ex = x0 + cardW + 4 + (e % 3) * (evW + 3), ey = top + Math.floor(e / 3) * (evH + 4);
        var ev = R.add.image(ex, ey, "EventCardImages", "event_" + ei).setOrigin(0, 0).setDisplaySize(evW, evH).setDepth(D + 2);
        objs.push(ev);
        hoverTip(R, ev, localName(byId(G, "EventCards", ei)), D + 2, objs);
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
    if (back && G.textures.exists("btn_arrow")) {
      var arrow = R.add.image(PANEL_L + 24, PANEL_T + 20, "btn_arrow", 0).setDepth(D + 3).setInteractive({ useHandCursor: true });
      arrow.on("pointerover", function () { arrow.setTexture("btn_arrow", 1); });
      arrow.on("pointerout", function () { arrow.setTexture("btn_arrow", 0); });
      arrow.on("pointerup", function () { sfx(R); back(); });
      objs.push(arrow);
    }
    fadeIn(R, objs);
    st.panel = objs;
  }

  // ---- ⑧ 自動刪除死渦 -------------------------------------------------------
  //
  // 官方「放棄」是 fetch("raid_delete", profound_id) → raid_list = fetch("db_raid") →
  // sort_raid_list／清單重畫／show_vortex。這裡照抄同一串，不多送別的。
  // 自己沒份的 HP 歸零就刪；自己有份的等 raid-reward 補丁記下「這個渦的結算收到了」
  // （window.__ulrRaidRewardSeen 的 profound_id，官方已送 raid_reward_receive）才刪。
  // 一次只刪一個、同一個渦這次安裝只試一次。詳細面板開著或結算正在演的時候不動清單。
  function deadRaidPlan(R, r) {
    if (!r || typeof r.hp !== "number" || r.hp >= 1) return null;
    var me = meMaybe(R);
    var mine = (me !== null && r.founder === me) || r.player_point > 0;
    return mine ? "had-reward" : "no-reward";
  }
  function rewardSeen(id) {
    var seen = window[SEEN];
    if (!Array.isArray(seen)) return false;
    for (var i = 0; i < seen.length; i++) if (seen[i] && seen[i].profound_id === id) return true;
    return false;
  }
  function busy(st, R) {
    return !!(st.refreshing || R.__ulrRaidRewardBatch || alive(R.reward_zone));
  }
  /** db_raid 回來之後照官方重排、重畫；人已經離開（socket 換了）就不碰。 */
  function applyList(R, sock, fresh) {
    if (!Array.isArray(fresh) || R.socket !== sock || !R.scene || !R.scene.isActive()) return false;
    R.raid_list = fresh;
    R.sort_raid_list();
    if (alive(R.raid_list_bg)) R.refresh_raid_list();
    R.show_vortex();
    return true;
  }
  function autoDelete(st, R) {
    if (!st.autoDelete.enabled || st.deleting || busy(st, R)) return;
    if (alive(R.raid_detail_give_up)) return;
    var list = R.raid_list;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var why = deadRaidPlan(R, r);
      if (why === null || !r.profound_id || st.tried[r.profound_id]) continue;
      if (why === "had-reward" && !rewardSeen(r.profound_id)) continue;
      st.tried[r.profound_id] = true;
      st.deleting = { id: r.profound_id, at: Date.now() };
      var sock = R.socket;
      var info = { type: "raid-auto-delete", name: String(r.name || ""), founder: String(r.founder || ""), reason: why };
      Promise.resolve(sock.fetch("raid_delete", r.profound_id)).then(function (ok) {
        if (ok === false) return null;
        report(info);
        return sock.fetch("db_raid");
      }).then(function (fresh) {
        applyList(R, sock, fresh);
      }).catch(function (e) {
        st.reason = "自動刪除失敗：" + String((e && e.message) || e);
      }).then(function () {
        st.deleting = null;
      });
      return;
    }
  }

  // ---- ⑩ 更新鈕 -------------------------------------------------------------
  /** 照官方 socket.on("player_ap") 那支重畫 AP（那支是伺服器推的，fetch 的回應不會經過它）。 */
  function applyAp(R, ap) {
    if (!ap || typeof ap.ap !== "number" || typeof ap.ap_max !== "number") return;
    R.registry.set("player_ap", ap);
    R.player_ap = R.registry.get("player_ap");
    if (alive(R.ap_value_text)) R.ap_value_text.setText(R.player_ap.ap);
    if (alive(R.ap_max_text)) R.ap_max_text.setText(R.player_ap.ap_max);
    if (alive(R.ap_next_text) && R.APUITexts) R.ap_next_text.setText(R.APUITexts.ap_max);
    if (R.ap_recover_timer) { try { R.ap_recover_timer.remove(); } catch (e) {} R.ap_recover_timer = null; }
    if (!alive(R.ap_fill_image)) return;
    if (R.player_ap.ap < R.player_ap.ap_max) {
      var img = R.ap_fill_image, ratio = R.player_ap.ap / R.player_ap.ap_max;
      img.setCrop(0, img.height * (1 - ratio), img.width, img.height * ratio);
      var sock = R.socket;
      R.ap_recover_timer = R.time.delayedCall(new Date(R.player_ap.recover_at).getTime() - Date.now(), function () { sock.emit("ap_recover"); });
    } else {
      R.ap_fill_image.setCrop();
    }
  }
  /**
   * 等於重進渦房：db_player_ap、db_raid（重排、重畫；詳細面板開著就照點地圖渦那條路重開），
   * 最後叫官方自己的 show_raid_reward（要結算、演、回報領取、重讀 GEM／道具）。
   */
  function manualRefresh(st, R) {
    var now = Date.now();
    if (now - st.lastManual < CFG.manualCooldownMs || busy(st, R)) return false;
    var sock = R.socket;
    if (!sock || typeof sock.fetch !== "function") return false;
    st.lastManual = now;
    st.refreshing = true;
    report({ type: "raid-refresh" });
    // AP 讀失敗不擋後面：渦清單與結算才是主菜
    Promise.resolve(sock.fetch("db_player_ap")).then(function (ap) {
      if (R.socket === sock) applyAp(R, ap);
    }, function () {}).then(function () {
      return sock.fetch("db_raid");
    }).then(function (fresh) {
      var openId = alive(R.raid_detail_name) && R.__ulrRaidDetailRow ? R.__ulrRaidDetailRow.profound_id : null;
      if (!applyList(R, sock, fresh)) return null;
      if (openId !== null && alive(R.raid_detail_name)) {
        var row = raidById(R, openId);
        R.destroy_raid_ranking();
        R.destroy_raid_detail();
        if (row) R.create_raid_detail(row);
        else { R.reset_avatar(); R.create_raid_list(); }
      }
      closePanel(st);
      return R.show_raid_reward();
    }).catch(function (e) {
      st.reason = "更新失敗：" + String((e && e.message) || e);
    }).then(function () {
      st.refreshing = false;
    });
    return true;
  }
  /** Profound 計數（raid_owned，右下對齊的大數字）下面、跟烤在底圖上的「/10」同一條左緣。 */
  function decorateRefresh(st, R) {
    var anchor = R.raid_owned;
    if (!alive(anchor)) {
      if (st.refreshBtn) { destroyAll(st.refreshBtn.objs); st.refreshBtn = null; }
      return;
    }
    var x = Math.round(anchor.x + 8), y = Math.round(anchor.y + 9);
    var rb = st.refreshBtn;
    var cooling = st.refreshing || Date.now() - st.lastManual < CFG.manualCooldownMs;
    if (rb && rb.anchor === anchor && rb.x === x && rb.y === y && alive(rb.btn)) {
      if (rb.btn.alpha !== (cooling ? 0.5 : 1)) rb.btn.setAlpha(cooling ? 0.5 : 1);
      return;
    }
    if (rb) destroyAll(rb.objs);
    var objs = [];
    var depth = (anchor.depth || 0) + 1;
    var btn = R.add.text(x, y, L().refresh, { fontFamily: FONT, fontSize: 11, resolution: 2, color: BTN_COLOR })
      .setOrigin(0, 0.5).setDepth(depth).setStroke("black", 3).setInteractive({ useHandCursor: true });
    objs.push(btn);
    var tip = [];
    btn.on("pointerover", function () {
      btn.setColor(BTN_HOVER);
      destroyAll(tip);
      var tt = R.add.text(btn.x, btn.y - 10, L().refreshTip, { fontFamily: FONT, fontSize: 11, color: "white", resolution: 2 }).setOrigin(0, 1).setDepth(depth + 6);
      var bg = R.rexUI.add.roundRectangle(tt.x + tt.width / 2, tt.y - tt.height / 2, tt.width + 10, tt.height + 6, 2, 0x000000, 0.85).setDepth(depth + 5);
      tip.push(bg, tt);
      objs.push(bg, tt);
    });
    btn.on("pointerout", function () { btn.setColor(BTN_COLOR); destroyAll(tip); });
    btn.on("pointerup", function () {
      if (!manualRefresh(st, R)) return;
      sfx(R);
      btn.setAlpha(0.5);
    });
    st.refreshBtn = { anchor: anchor, x: x, y: y, btn: btn, objs: objs };
  }

  // ---- 主迴圈 ---------------------------------------------------------------
  function raidScene(G) {
    var R = G.scene.keys.Raid;
    try {
      if (!R || !R.scene || !R.scene.isActive() || R.scene.isSleeping()) return null;
      if (!Array.isArray(R.raid_list) || !R.player || !R.socket || typeof R.socket.fetch !== "function") return null;
    } catch (e) { return null; }
    return R;
  }
  function clearAll(st) {
    for (var i = 0; i < st.rows.length; i++) if (st.rows[i].__ulrRaidView) { destroyAll(st.rows[i].__ulrRaidView.objs); st.rows[i].__ulrRaidView = null; }
    st.rows = [];
    undoMap(st);
    dropInfo(st);
    if (st.refreshBtn) { destroyAll(st.refreshBtn.objs); st.refreshBtn = null; }
    dropRank(st);
    closePanel(st);
    clearSupport();
  }
  /**
   * 畫面上的標記：**每一幀**在 Raid 場景的 postupdate 跑。官方的點擊處理與重建都在同一幀的
   * update 裡、比 postupdate 早，所以這裡看到的永遠是這一幀的最終狀態。每一步都有 key 快取。
   */
  function decorate(st, R, G) {
    decorateRefresh(st, R);
    decorateList(st, R, G);
    decorateMap(st, R, G);
    decorateInfo(st, R, G);
    decorateMyRank(R);
    decorateRanking(st, R, G);
    decorateSupport(st, R, G);
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
  /** 包過的不再包（旗標在原型上），每拍叫也只是看一下旗標。 */
  function hookSupport() {
    ${RAID_SUPPORT_HOOK_BODY}
  }
  /** 輪詢管進出渦房、學獎勵、刪死渦；逐幀那條還沒在跑時代跑一次畫面標記。 */
  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      var G = gameOf();
      // 戰鬥裡（Raid 睡著）也要看：開打那一刻的戰鬥設定帶著 stage；任務裡發現渦也是
      if (G) {
        try { watchBattleStage(st, G); watchBossStates(st, G); watchBossPassives(st, G); } catch (e) { st.reason = "battle stage: " + String((e && e.message) || e); }
        try { hookDamage(st, G); } catch (e) { st.reason = "battle damage: " + String((e && e.message) || e); }
        st.primed = true;
        try { ensureStateIcons(G); } catch (e) {}
        try { noteTitle(st, G); } catch (e) { st.reason = "title stage: " + String((e && e.message) || e); }
      }
      var R = G ? raidScene(G) : null;
      if (!R) {
        if (st.inRaid) clearAll(st);
        st.inRaid = false;
        return;
      }
      st.inRaid = true;
      // SUPPORT 回應的攔截（raid-support.ts）：進渦房下一拍就裝，不等托盤那一輪
      hookSupport();
      hookDetail(st, R);
      hookStart(st, R);
      matchTitles(st, R);
      rememberMeta(st, R);
      try { trackRaids(st, R); } catch (e) { st.reason = "track: " + String((e && e.message) || e); }
      try { settleBattle(R); } catch (e) { st.reason = "battle: " + String((e && e.message) || e); }
      learnTick(st, meMaybe(R));
      try { autoDelete(st, R); } catch (e) { st.reason = String((e && e.message) || e); }
      ensureSkin(st, G);   // 渦房的貼圖離開就卸，人在渦房時先抄好
      hookFrame(st, R);
      if (Date.now() - st.lastFrame > CFG.pollIntervalMs * 2) decorate(st, R, G);
      st.reason = null;
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }
  // ---- ⑪ 渦碼沒回應：官方把點擊關了等不到回覆（檔頭有細節） ------------------
  function raidTexts(G) {
    try { var t = G.cache.json.get("RaidUITexts"); return t && t.error ? t : null; } catch (e) { return null; }
  }
  function onCodeTimeout(st, ev) {
    var reason = ev ? ev.reason : null;
    var msg = reason && typeof reason.message === "string" ? reason.message : "";
    if (msg.indexOf("raid_code_input: timed out") !== 0) return;
    var G = gameOf();
    var R = G ? raidScene(G) : null;
    if (!R || !R.input || R.input.enabled !== false) return;
    st.codeTimeouts++;
    try {
      var T = raidTexts(G);
      // 官方的錯誤框已經開著（raid_error 有來）就不疊第二個
      if (T && typeof R.raid_error === "function" && !R.error_bg) {
        T.error[CFG.codeNoReplyKey] = L().codeNoReply;
        var p = R.raid_error(CFG.codeNoReplyKey);
        if (p && typeof p.then === "function") p.then(null, function () { R.input.enabled = true; });
      }
    } catch (e) {
      st.reason = "code timeout: " + String((e && e.message) || e);
    }
    // raid_error 最後一行自己會開；它半路出事也不能讓玩家卡著
    R.input.enabled = true;
  }
  function hookCodeTimeout(st) {
    if (typeof window.addEventListener !== "function") return;
    var fn = function (ev) { try { onCodeTimeout(st, ev); } catch (e) {} };
    window.addEventListener("unhandledrejection", fn);
    st.codeHandler = fn;
  }
  function unhookCodeTimeout(st) {
    try { if (st.codeHandler) window.removeEventListener("unhandledrejection", st.codeHandler); } catch (e) {}
    st.codeHandler = null;
    var G = gameOf();
    var T = G ? raidTexts(G) : null;
    try { if (T) delete T.error[CFG.codeNoReplyKey]; } catch (e) {}
  }

  function restore() {
    var st = window[FLAG];
    if (!st) return;
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { unhookFrame(st); } catch (e) {}
    try { if (typeof st.unhookCode === "function") st.unhookCode(); } catch (e) {}
    try { if (typeof st.clearAll === "function") st.clearAll(); else clearAll(st); } catch (e) {}
    try { if (typeof st.unhookDetail === "function") st.unhookDetail(); else unhookDetail(st); } catch (e) {}
    try { if (st.supportProto && st.supportProto.raid_support_list && st.supportProto.raid_support_list.__ulrRaidView) st.supportProto.raid_support_list = st.supportProto.raid_support_list.__ulrRaidView; } catch (e) {}
    try { if (typeof st.unhookDamage === "function") st.unhookDamage(); } catch (e) {}
    dropTextures();
    delete window[FLAG];
  }
  /** 面板底圖是 canvas 貼圖，建一次就留在遊戲裡；重裝不卸的話新版畫法不生效。舊版的也一併卸。 */
  function dropTextures() {
    var G = gameOf();
    if (!G) return;
    try { if (G.anims && G.anims.exists && G.anims.exists("__ulrVortexGray") && G.anims.remove) G.anims.remove("__ulrVortexGray"); } catch (e) {}
    ["__ulrRaidIcons", "__ulrVortexGray", PANEL_TEX, CHAR_TEX].forEach(function (k) {
      try { if (G.textures.exists(k) && G.textures.remove) G.textures.remove(k); } catch (e) {}
    });
  }

  restore();
  var st = {
    version: CFG.version,
    inRaid: false,
    rows: [],
    map: [],
    info: null,
    panel: null,
    panelBody: null,
    rank: [],
    primed: false,
    dmgSocket: null,
    dmgHandler: null,
    publicMap: CFG.publicMap || {},
    teams: CFG.teams || {},
    learned: CFG.learned || {},
    refreshBtn: null,
    refreshing: false,
    lastManual: 0,
    lastList: null,
    metaPub: null,
    pubIndexOf: null,
    pubByLimit: {},
    detailProto: null,
    startProto: null,
    lastRoom: null,
    lastTitle: null,
    titles: [],
    autoDelete: CFG.autoDelete,
    deleting: null,
    tried: {},
    frameScene: null,
    frameHandler: null,
    lastFrame: 0,
    codeHandler: null,
    codeTimeouts: 0,
    timer: null,
    reason: null
  };
  // 拆除時要用這一版的收法（下一版的 restore 叫得到）
  st.clearAll = function () { clearAll(st); };
  st.unhookDetail = function () { unhookDetail(st); };
  st.unhookDamage = function () { unhookDamage(st); };
  st.unhookCode = function () { unhookCodeTimeout(st); };
  window[FLAG] = st;
  hookCodeTimeout(st);
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
 * 自己渦清單上的渦（插件互傳、回報 ulgg 用的那一份）。
 *
 * ⚠ 改版後清單沒有 TL／stage／state，而且 code 有時不是字串：不是字串的當 null
 * （別人開的渦）。stage 與 BOSS 狀態是頁面自己看到的（__ulrRaidStages／__ulrRaidBossStates）。
 * 戰鬥中（Raid 場景睡著）也照讀記憶體裡的清單；從來沒進過渦房就回空的。
 */
export const RAID_VIEW_SNAPSHOT_EXPRESSION = `(function () {
  try {
    var G = window.game;
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Raid : null;
    // 戰鬥中 Raid 場景睡著，清單還在記憶體裡：照讀（開打那一刻記下的 stage 要馬上回報）
    if (!R || !Array.isArray(R.raid_list)) return JSON.stringify({ raids: [], listed: false });
    var now = Date.now();
    var num = function (v) { return typeof v === "number" && isFinite(v) ? v : null; };
    var stages = window.__ulrRaidStages || {}, bosses = window.__ulrRaidBossStates || {};
    var tracks = window.__ulrRaidTrack || {};
    // BOSS 代碼（mc1006_02）：清單只給 monster_id，CharaCards 查得到（公開渦通知判斷渦幾用）
    var cards = []; try { cards = G.cache.json.get("CharaCards") || []; } catch (e) {}
    var monsOf = function (id) { for (var c = 0; c < cards.length; c++) if (cards[c] && cards[c].id === id) return typeof cards[c].chara === "string" ? cards[c].chara : null; return null; };
    var out = [];
    for (var i = 0; i < R.raid_list.length; i++) {
      var r = R.raid_list[i];
      if (!r || typeof r.limit !== "number" || !(r.limit > now)) continue;
      var players = [];
      var rank = r.rank || [];
      // 榜上的名字是「Lv.92 名字」：去掉等級（查隊伍用名字算 key，等級會變）
      for (var p = 0; p < rank.length; p++) if (rank[p] && typeof rank[p].player_name === "string") players.push(rank[p].player_name.replace(/^Lv\\.\\d+\\s+/, ""));
      var sg = stages[r.profound_id], bs = bosses[r.profound_id];
      // 舊版（v${RAID_TITLE_TRUSTED_SINCE} 以前）用發現畫面記的 stage 可能套錯渦：不傳出去
      if (sg && sg.src === "title" && !(sg.v >= ${RAID_TITLE_TRUSTED_SINCE})) sg = null;
      var states = [];
      if (bs && Array.isArray(bs.states)) for (var s = 0; s < bs.states.length; s++) if (bs.states[s].until === null || bs.states[s].until > now) states.push(bs.states[s]);
      // 托盤記「這個渦拿到結算了沒」用的，只放本機（互傳只挑 stage／states 傳）
      var tk = tracks[r.profound_id] || {};
      var meta = { name: String(r.name || ""), monsterId: num(r.monster_id), level: num(r.level), mapIndex: num(r.map_index),
        category: typeof r.category === "string" ? r.category : null, point: num(r.player_point), stage: num(tk.stage),
        expectFrag: typeof tk.expectFrag === "string" ? tk.expectFrag : null, expectCoin: tk.expectCoin === true,
        expectSrc: typeof tk.expectSrc === "string" ? tk.expectSrc : null, expectItems: Array.isArray(tk.expectItems) ? tk.expectItems : [],
        onlyFriend: typeof r.only_friend === "boolean" ? r.only_friend : null };
      out.push({ code: typeof r.code === "string" ? r.code : null, founder: typeof r.founder === "string" ? r.founder : null,
        tl: null, rarity: num(r.rarity), stage: sg && typeof sg.stage === "number" ? sg.stage : null, mons: monsOf(r.monster_id),
        hp: num(r.hp), hpMax: num(r.hp_max), limit: r.limit, states: states, statesAt: bs ? num(bs.at) : null,
        foundAt: num(r.found_at), players: players, meta: meta });
    }
    return JSON.stringify({ raids: out, listed: true });
  } catch (e) {
    return JSON.stringify({ raids: [], listed: false, reason: String((e && e.message) || e) });
  }
})()`;

export function parseRaidViewSnapshot(raw: string): RaidSnapshotRow[] {
  return parseRaidViewSnapshotListed(raw).rows;
}

/**
 * 同上，外加「頁面手上有沒有清單」。`listed` 是 false（渦房還沒建好、剛重載）時清單是空的
 * 不代表渦都不見了 —— 托盤判定「消失沒結算」前要看這個。
 */
export function parseRaidViewSnapshotListed(raw: string): {
  rows: RaidSnapshotRow[];
  listed: boolean;
} {
  try {
    const o = JSON.parse(raw) as { raids?: unknown; listed?: unknown };
    return {
      rows: Array.isArray(o.raids) ? (o.raids as RaidSnapshotRow[]) : [],
      listed: o.listed === true,
    };
  } catch {
    return { rows: [], listed: false };
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

/** 把托盤查到的公開渦表推下去。回 "ok" / "not-installed"。下一幀清單列與 SUPPORT 列照新表重畫。 */
export function buildRaidViewSetPublicExpression(map: RaidPublicMap): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.publicMap = JSON.parse(${embedJson(map)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 把托盤整理好的隊伍表推下去（⑨）。回 "ok" / "not-installed"。 */
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

/**
 * 把學到的獎勵表推下去。回 "ok" / "not-installed"。
 * 標記的 key 含學到的時刻，下一幀就照新表重畫；開著的面板不動。
 */
export function buildRaidViewSetLearnedExpression(table: RaidLearnedTable): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    st.learned = JSON.parse(${embedJson(table)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 拆掉：圖示收掉、地圖渦的紅框清掉、詳細面板的包裝拆掉。 */
export const RAID_VIEW_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer !== null && st.timer !== undefined) clearInterval(st.timer); } catch (e) {}
    try { if (st.frameScene && st.frameHandler) st.frameScene.events.off("postupdate", st.frameHandler); } catch (e) {}
    try { if (typeof st.unhookCode === "function") st.unhookCode(); } catch (e) {}
    try { if (typeof st.clearAll === "function") st.clearAll(); } catch (e) {}
    try { if (typeof st.unhookDetail === "function") st.unhookDetail(); } catch (e) {}
    try {
      var G = window.game;
      ["__ulrRaidIcons", "__ulrVortexGray", "__ulrRaidPanel", "__ulrRaidPanelChar"].forEach(function (k) { if (G && G.textures.exists(k) && G.textures.remove) G.textures.remove(k); });
    } catch (e) {}
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
