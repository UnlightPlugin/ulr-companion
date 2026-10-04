/**
 * 物品欄：點得到外面、渦房／任務房的排序、兩房的物品捷徑
 * ======================================================
 * 玩家 2026-09-26 的幾件事：
 *
 * ```
 *   ① 物品欄開著時，面板以外的地方也要點得到（官方整個畫面都點不動）
 *   ② 渦房的物品欄：渦二、渦一排在回 AP 的水後面（官方排在最後一頁），增益類藏起來
 *   ③ 渦房的「物品捷徑」（可開關）：藏 FRIENDLIST／ITEM 兩顆鈕，改放水；渦探知機放「輸入Raid代碼」上方
 *   ④ 任務房的物品欄：增益類藏起來（順序照官方）
 *   ⑤ 任務房的「物品捷徑」（可開關）：FRIENDLIST 正上方貼著疊 水 x3、沙漏 x2；通行證放下方中間
 *   ⑥ 任務房物品欄開著時點地圖開「開始搜索」：整組疊到物品欄上面，右上的 X 才按得到
 *   ⑦ 迪城（Match 場景、迪特赫姆頻道）的「物品捷徑」（可開關）：FRIENDLIST 正上方疊三種水
 *   ⑧ 迪城的 GEM UP（可開關）：跟大廳同一張圖、同一個倒數，上面多一行加成百分比
 *   ⑨ 獎勵遊戲的「物品捷徑」（可開關，玩家 2026-09-27）：猜錯時只畫一顆建議用的道具，一點就用
 * ```
 *
 * ## ① 為什麼點不動（2026-09-26 從跑著的客戶端讀的）
 *
 * 物品鈕（大廳／任務房／渦房／對戰房共用的那顆 ITEM）按下去：
 *
 * ```js
 *   const zone = scene.add.zone(0, 0, 760, 680).setOrigin(0, 0).setDepth(900).setInteractive()
 *   const panel = new ItemPanel(scene, 630, 428, 種類, 30)
 *   panel.once("close", () => zone.destroy())
 *   panel.setDepth(900).panel_open()
 * ```
 *
 * 全畫面一層會吃點擊的 zone，面板關掉才拆。這支包面板類別的 panel_open：
 * 開窗的當下往回找「剛剛那層 760x680、同 depth 的 zone」把點擊關掉（zone 留著，關窗時
 * 官方照樣拆）。找不到那層就什麼都不做 —— 不是從物品鈕開的開法不碰。
 *
 * 外面點得到之後，物品鈕本身也點得到了：再按一次會疊第二張面板。所以已經有一張開著
 * （不是正在關）時，新的那張當場拆掉、舊的走官方 panel_close ＝ 再按一次就是關。
 *
 * ## ② 排序：包 get_item_data
 *
 * 官方 get_item_data() 從 registry 的 avatar_item 撈、先照 id 再照 priority 排。渦房
 * （面板的場景是 Raid）才動：
 *
 * - 增益類不列：AvatarItems 列上有 boost_type 的（髮冠、耳環、權杖、妖精、戒指）＋日記本
 * - 回 AP 的水（官方 APRestoreID：精靈、古代、魔女、蘑菇、聖杯碎片）排最前、接渦二、渦一，
 *   其他照官方順序
 *
 * 任務房（④）只藏增益類、不重排。大廳的物品欄不動 —— 增益類要用還是從那裡用。
 *
 * ## ③ 物品捷徑
 *
 * ```
 *   右列：SUPPORT（官方，不動）/ 古代（FRIENDLIST 的位置）/ 精靈（ITEM 的位置）
 *   「輸入Raid代碼」上方：渦探知機，有才畫；渦一、渦二在前，其他照官方 priority。
 *                        由下往上、一列 3 顆
 * ```
 *
 * 第一版在 SUPPORT 上面疊了三瓶水，玩家回報「SUPPORT 很常用，很容易誤按到水」，
 * 改成只佔官方兩顆鈕的位置、不放魔女（2026-09-26）。
 *
 * - 鈕是**官方那顆右下角鈕的類別**（拿 icon_item 的 constructor 生），只把圖換成道具圖、
 *   加一行數量（字型照物品欄格子的 font_light）。滑上發光、按下判定都是官方的
 * - 按下去叫場景自己的 use_avatar_item —— 跟物品欄的「使用」同一條路：官方確認框、
 *   官方的 use_avatar_item 請求、用完官方自己重讀渦清單。**不多送任何請求**
 * - 數量是 0 的水：半透明、點不下去（固定在那兩格）；探知機沒有就不畫
 * - 關掉＝拆掉自己的鈕、官方兩顆放回來
 *
 * ## ⑤ 任務房的物品捷徑
 *
 * ```
 *   FRIENDLIST（734,558）正上方、間距跟 FRIENDLIST／ITEM 一樣（34），由上往下：
 *     精靈 / 古代 / 魔女 / 時間沙漏 / 超時空沙漏    —— 固定五格，數量 0 半透明
 *   牌組與人物中間那塊空地：通行證，有才畫，一列 4 顆（5 顆會蓋到人物腳邊的小人）
 *     鈕上多一行名字（影1、月2、風1、天1、活1）—— 通行證的圖都長一樣，看圖分不出來
 * ```
 *
 * 兩塊各自開關（玩家 2026-09-26：「分成通行證捷徑和水沙捷徑……兩者分開」）。
 *
 * 官方 FRIENDLIST／ITEM 兩顆不動。按下去一樣叫場景自己的 use_avatar_item
 * （任務房那支多帶 region_id，用完官方自己重讀任務清單）。
 *
 * ## ⑥ 開始搜索蓋在物品欄上面
 *
 * 官方的搜索框（search_*）depth 50、物品欄 900：① 讓外面點得到之後，開著物品欄點地圖，
 * 搜索框會被物品欄蓋住半邊、右上的 X 按不到。物品欄開著（沒在關）時把 search_* 抬到面板
 * 上面（保持彼此的前後），物品欄關了放回原本的 depth。搜索框底下那層半透明的全畫面遮罩
 * （search_zone）不動 —— 抬上去的話物品欄就點不到了。
 *
 * ## ⑦⑧ 迪城
 *
 * 玩家 2026-09-26：在迪城和小號互刷賺 GEM 獎勵，要在迪城看得到 GEM 加成、順手喝水。
 *
 * 迪城＝Match 場景、`channel` 是迪特赫姆的那個頻道物件（`{ channel: 2, quick: false,
 * event: false, domain }`，2026-09-26 實機讀的）。判斷跟 room-cost 一樣：有 `type` 看
 * `type === "duel"`，沒有就看「不是快速比賽（亞城）、也不是活動頻道」。還在選頻道
 * （`channel` 是 null）時什麼都不畫。
 *
 * - 水：FRIENDLIST（734,558）正上方貼著疊，由上往下 精靈 / 古代 / 魔女，跟任務房的前三格
 *   一樣。官方兩顆鈕不動。Match 的 use_avatar_item 跟渦房同一支（官方確認框＋請求＋重讀）
 * - GEM UP：大廳在右側畫 `PlayerBoostIcons` 的 `boost_<type>`（760, 370 靠右下）、倒數字
 *   （693, 353，BradleyGratis 18）。這裡在同一個位置畫同一張圖、同一種倒數，圖上方多一行
 *   「+50%」（AvatarItems 幸運的權杖：boost_type 1 ＝ GEM，boost_value 就是百分比；結算的
 *   gem_boost 是 100 ＋ 它）。沒有生效中的 GEM 加成就不畫。資料是 registry 的 player_boost
 *   —— Match 自己進頻道時就會 emit player_boost_check、收到推播會寫回 registry，不多送請求
 * - `PlayerBoostIcons` 是大廳的貼圖，離開大廳就被 UL_LOADER 卸掉（Match 裡 exists 是
 *   false）。跟 patch-nav 一樣用自己的 key 從資產主機抓同一張（54x169，五格），拆除時移掉
 *
 * ## ⑨ 獎勵遊戲（Bonus 場景）
 *
 * 官方流程（2026-09-27 從跑著的客戶端讀的）：猜錯 → bonus_fail 畫「使用物品」
 * （btn_item）與「結束遊戲」（btn_quit）→ 物品欄只列 BATTLE 類、能不能用是
 * can_use_bonus_item：道具的 value 小於 0 永遠能用，不然要
 * |dice_current − dice_previous| ≤ value。選了就 use_bonus_item(id)：送
 * use_avatar_item、重讀物品、拆兩顆鈕；之後伺服器推 bonus_skip（算猜對）或
 * bonus_restart（重投），場景自己接。
 *
 * ```
 *   白色石楠1  id 5  value 1      白色石楠3  id 6  value 3      白色石楠5  id 7  value 5
 *   幸運四葉草 id 4  value -1（重投）                          跳越星     id 8  value 12
 * ```
 *
 * 只畫**一顆**：差距夠小就用剛好夠的那朵（石楠1 → 石楠3），不然照玩家選的優先順序
 * （預設 石楠5 → 四葉草 → 跳越星）挑第一個有、而且用得了的。例：5 猜大出 2（差 3）
 * → 石楠3；8 猜小出 12（差 4）→ 石楠5，沒有就四葉草，再沒有就跳越星。
 *
 * 樣子是官方 bonus_item（111x94 兩格：0 灰、1 滑上的紅）**抹掉字**的圓鈕，圓裡放道具圖、
 * 圓底放「x數量」。官方沒有不帶字的圖，字烤在裡面（2026-10-03 讀的：第 0 格的字是圓裡唯一
 * 亮過 150 的像素，約 x20..72、y39..51）；圓裡是上暗下亮的直向漸層，所以字的範圍外擴幾格、
 * 用上下緣的顏色直向內插蓋掉就看不出來。透明度每格跟著官方的使用物品鈕（淡入、按過淡出都跟）。
 * 畫在哪有兩種（玩家選，2026-10-03）：
 *
 * - **上方**：四顆大鈕組成的菱形左上那塊空地（玩家畫的紅框），縮 0.75、轉 45 度讓尾巴跟
 *   另外四顆一樣指向中心，五顆圍成一圈。點擊只認圓（轉過的方框四角會伸進 HIGH 與使用物品）。
 * - **覆蓋**：直接蓋在「使用物品」鈕上（同位置、同大小），按同一個地方就用。挑不出能用的
 *   道具時不蓋，「使用物品」照官方開物品欄。
 *
 * 抹字的底圖做不出來（沒有原圖之類）時退回物品欄格子的樣子畫在上方：item_base
 * （0 一般／1 滑上）＋道具圖＋「x數量」，縮 0.67。
 *
 * 按下去叫場景自己的 use_bonus_item —— 跟物品欄選了道具同一條路，**不多送請求**。
 * 那支會碰 item_zone／item_panel（官方是開著物品欄才呼叫它），沒開物品欄時先墊兩個
 * 什麼都不做的替身。按過一次就不再畫（同一顆 btn_item；蓋著的那顆留著跟官方鈕一起淡出），
 * 伺服器說不能用（回 false、場景沒鎖輸入）才放回來。
 *
 * ## 找面板類別
 *
 * 模組 id 每次改版都會變，跟 patch-penalty 一樣從 webpack 的模組表掃特徵字串
 * （prototype 上同時有 get_item_data 與 panel_open）。它住在大廳之後才載的 chunk，
 * 所以找不到就隔一段時間再掃。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號。** 整段腳本住在一個 template literal 裡。
 */

import { embedJson } from "./embed.js";
import { WEBPACK_REQUIRE_SNIPPET } from "./patch-penalty.js";

const FLAG = "__ulrItemPanel";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const ITEM_PANEL_SCRIPT_VERSION = 8;

/** 官方 AvatarItem.APRestoreID（2026-09-26）：精靈、古代、魔女、特製蘑菇萃取液、聖杯的碎片。 */
export const AP_RESTORE_ITEM_IDS = [1, 2, 3, 38, 133] as const;

/** 捷徑放在 FRIENDLIST 鈕位置的：古代妙藥。 */
export const SHORTCUT_FRIEND_SLOT_ID = 2;
/** 捷徑放在 ITEM 鈕位置的：精靈之藥。（魔女、蘑菇不放 —— 玩家 2026-09-26） */
export const SHORTCUT_ITEM_SLOT_ID = 1;

/** β型渦探知機Ⅰ（玩家叫「渦一」）。捷徑排在探知機那一區的最前面。 */
export const RAID_DETECTOR_1 = 366;
/** β型渦探知機Ⅱ（「渦二」）。捷徑排在渦一後面。 */
export const RAID_DETECTOR_2 = 367;

/** AvatarItems 的 kind：4 = 渦（官方 AvatarItem.Type.RAID）。 */
export const RAID_ITEM_KIND = 4;

/** 沒有 boost_type 但也算增益類、渦房物品欄不列的：人偶的日記本、追憶的日記本。 */
export const HIDDEN_RAID_ITEM_IDS = [27, 28] as const;

/** 任務房捷徑疊在 FRIENDLIST 上方的五格，由上往下：精靈、古代、魔女、時間沙漏、超時空沙漏。 */
export const QUEST_STACK_ITEM_IDS = [1, 2, 3, 11, 12] as const;

/**
 * 通行證與鈕上的名字（AvatarItems 的 id，2026-09-26）。通行證的圖都長一樣，看圖分不出來。
 * 安妮莫娜叫「風」、天使大陸叫「天」是玩家訂的；活動（ExEventLand）的叫「活」。
 */
export const QUEST_PASS_LABELS: Readonly<Record<number, string>> = {
  31: "影1",
  32: "影2",
  33: "影3",
  34: "月1",
  35: "月2",
  36: "月3",
  47: "風1",
  48: "風2",
  49: "風3",
  66: "天1",
  67: "天2",
  68: "天3",
  73: "活1",
  74: "活2",
  75: "活3",
};

/** 迪城捷徑疊在 FRIENDLIST 上方的三格，由上往下：精靈、古代、魔女。 */
export const DIET_STACK_ITEM_IDS = [1, 2, 3] as const;

/** player_boost 的 boost_type：1 = GEM 加成（幸運的權杖）。 */
export const GEM_BOOST_TYPE = 1;

/** 獎勵遊戲的道具（AvatarItems 的 id，2026-09-27）。 */
export const BONUS_CLOVER = 4;
export const BONUS_HEATHER_1 = 5;
export const BONUS_HEATHER_3 = 6;
export const BONUS_HEATHER_5 = 7;
export const BONUS_STAR = 8;

/** 差距小時先看的：剛好夠用的那朵，小的先。 */
export const BONUS_PRECISE_ITEM_IDS = [BONUS_HEATHER_1, BONUS_HEATHER_3] as const;

/** 差距大於 3（或小石楠沒了）時先用哪一種：石楠5、四葉草、跳越星。 */
export type BonusItemOrder = "heather5" | "clover" | "star";

export const DEFAULT_BONUS_ITEM_ORDER: BonusItemOrder = "heather5";

/** 每種選法的完整順序：選的那種排第一，其餘照預設（石楠5 → 四葉草 → 跳越星）。 */
export const BONUS_ITEM_ORDERS: Readonly<Record<BonusItemOrder, readonly number[]>> = {
  heather5: [BONUS_HEATHER_5, BONUS_CLOVER, BONUS_STAR],
  clover: [BONUS_CLOVER, BONUS_HEATHER_5, BONUS_STAR],
  star: [BONUS_STAR, BONUS_HEATHER_5, BONUS_CLOVER],
};

export function isBonusItemOrder(v: unknown): v is BonusItemOrder {
  return v === "heather5" || v === "clover" || v === "star";
}

/** 獎勵遊戲的捷徑畫在哪：「使用物品」鈕上方那塊空地，或直接蓋在鈕上。 */
export type BonusItemPlace = "above" | "cover";

export const DEFAULT_BONUS_ITEM_PLACE: BonusItemPlace = "above";

export function isBonusItemPlace(v: unknown): v is BonusItemPlace {
  return v === "above" || v === "cover";
}

export interface ItemPanelPatchOptions {
  /** 渦房的物品捷徑開不開。 */
  shortcut: boolean;
  /** 任務房的水沙捷徑（FRIENDLIST 上方那五格）開不開。 */
  questStack: boolean;
  /** 任務房的通行證捷徑（下方中間那排）開不開。 */
  questPasses: boolean;
  /** 迪城的水捷徑（FRIENDLIST 上方那三格）開不開。沒給＝關。 */
  dietStack?: boolean;
  /** 迪城的 GEM UP 開不開。沒給＝關。 */
  gemUp?: boolean;
  /** 獎勵遊戲的物品捷徑開不開。沒給＝關。 */
  bonusItem?: boolean;
  /** 獎勵遊戲差距大時先用哪一種。沒給＝石楠5。 */
  bonusOrder?: BonusItemOrder;
  /** 獎勵遊戲的捷徑畫在哪。沒給＝上方。 */
  bonusPlace?: BonusItemPlace;
}

/** 任務房捷徑的兩塊：水沙、通行證。 */
export type QuestShortcutPart = "stack" | "passes";

/** 迪城的兩塊：水捷徑、GEM UP。 */
export type DietPart = "dietStack" | "gemUp";

/** 獎勵遊戲那一塊。 */
export type BonusPart = "bonusItem";

/** 可以單獨開關的每一塊（渦房那個另有一支）。 */
export type ItemPanelPart = QuestShortcutPart | DietPart | BonusPart;

export interface ItemPanelStatus {
  installed: boolean;
  version: number | null;
  /** 找到物品欄面板類別了沒（①② 要靠它）。 */
  found: boolean;
  shortcut: boolean;
  /** 捷徑現在畫在渦房上。 */
  inRaid: boolean;
  /** 畫了幾顆捷徑。 */
  buttons: number;
  questStack: boolean;
  questPasses: boolean;
  /** 任務房捷徑現在畫在任務房上。 */
  inQuest: boolean;
  /** 任務房畫了幾顆捷徑。 */
  questButtons: number;
  dietStack: boolean;
  gemUp: boolean;
  /** 人在迪城（Match 場景、迪特赫姆頻道）。 */
  inDiet: boolean;
  /** 迪城畫了幾顆水。 */
  dietButtons: number;
  /** GEM UP 現在畫在迪城上。 */
  gemShown: boolean;
  /** 生效中的 GEM 加成百分比；沒有就是 null（跟開關、在不在迪城無關）。 */
  gemPct: number | null;
  bonusItem: boolean;
  bonusOrder: BonusItemOrder;
  bonusPlace: BonusItemPlace;
  /** 獎勵遊戲上現在畫著捷徑。 */
  inBonus: boolean;
  /** 畫著的那一顆是哪個道具；沒畫就是 null。 */
  bonusPick: number | null;
  reason: string | null;
}

export function buildItemPanelPatchScript(options: ItemPanelPatchOptions): string {
  const config = {
    version: ITEM_PANEL_SCRIPT_VERSION,
    shortcut: options.shortcut,
    pollMs: 500,
    findEveryMs: 2000,
    screenW: 760,
    screenH: 680,
    // 官方先 add.zone 再 new 面板；面板建構時生的子物件會被收進容器，往回幾格就夠
    zoneLookBack: 8,
    apIds: AP_RESTORE_ITEM_IDS,
    raidFirst: [RAID_DETECTOR_2, RAID_DETECTOR_1],
    hideIds: HIDDEN_RAID_ITEM_IDS,
    friendSlot: SHORTCUT_FRIEND_SLOT_ID,
    itemSlot: SHORTCUT_ITEM_SLOT_ID,
    detectorFirst: [RAID_DETECTOR_1, RAID_DETECTOR_2],
    detectorKind: RAID_ITEM_KIND,
    extraPerRow: 3,
    extraMax: 6,
    gap: 4,
    // 48x32 的官方鈕裡：圖靠左、數量右下
    iconX: -10,
    iconW: 26,
    iconH: 28,
    qtyX: 23,
    qtyY: 16,
    qtyFont: 12,
    // ⑤ 任務房
    questStackOn: options.questStack,
    questPassesOn: options.questPasses,
    questStack: QUEST_STACK_ITEM_IDS,
    // FRIENDLIST 與 ITEM 中心差 34（鈕高 32 ＋ 2）
    stackStep: 34,
    passLabels: QUEST_PASS_LABELS,
    passIds: Object.keys(QUEST_PASS_LABELS).map(Number),
    // 牌組框（28..341）與人物中間、下方那塊空地（482..628）。一列 4 顆、右緣停在 550：
    // 人物腳邊的小人約從 560 起，一列 5 顆會蓋到它（玩家 2026-09-26）
    passX: 370,
    passY: 502,
    passStepX: 52,
    passStepY: 36,
    passPerRow: 4,
    passMax: 16,
    // ⑥ 官方搜索框的 depth，抬的時候保持彼此前後
    searchDepth: 50,
    searchParts: [
      "search_bg",
      "search_thum",
      "search_ap",
      "search_guage",
      "search_time_text",
      "search_slider",
      "search_close",
      "search_ok",
    ],
    // ⑦ 迪城的水
    dietStackOn: options.dietStack === true,
    dietStack: DIET_STACK_ITEM_IDS,
    // ⑧ GEM UP：座標、字型照大廳（圖 54x33 靠右下貼在 760,370；倒數在 693,353）
    gemUpOn: options.gemUp === true,
    gemBoostType: GEM_BOOST_TYPE,
    boostTex: "__ulrItemPanel_boost",
    boostAsset: "PlayerBoostIcons",
    gemX: 760,
    gemY: 370,
    gemTimerX: 693,
    gemTimerY: 353,
    gemDepth: 20,
    // 百分比那行：圖上緣（370 - 33）再往上 1
    gemPctX: 757,
    gemPctY: 336,
    boostRetryMs: 30000,
    // ⑨ 獎勵遊戲：四顆大鈕（HIGH 334,74／使用物品 265,143，各約 95x110）圍出來的左上空地
    bonusOn: options.bonusItem === true,
    bonusOrder: options.bonusOrder ?? DEFAULT_BONUS_ITEM_ORDER,
    bonusOrders: BONUS_ITEM_ORDERS,
    bonusPrecise: BONUS_PRECISE_ITEM_IDS,
    // 做不出抹字的底圖時退回物品欄格子的樣子，畫在上方
    bonusX: 298,
    bonusY: 108,
    // 物品欄格子的縮放、道具圖與數量字照格子
    bonusScale: 0.67,
    bonusIconScale: 0.5,
    bonusQtyX: 44,
    bonusQtyY: 47,
    bonusQtyFont: 18,
    // 在場景的鈕（depth 0）上面、官方物品欄（depth 10）下面
    bonusDepth: 1,
    // 覆蓋：抹掉字的 bonus_item（一格 111x94），字＝第 0 格亮過 150 的像素、外擴 4 格
    bonusPlace: options.bonusPlace ?? DEFAULT_BONUS_ITEM_PLACE,
    bonusBtnTex: "__ulrItemPanel_bonusBtn",
    bonusBtnAsset: "bonus_item",
    bonusBtnW: 111,
    bonusBtnH: 94,
    bonusTextLum: 150,
    bonusErasePad: 4,
    // 圓心在一格的 (45.5, 45.5)、半徑 42、尾巴朝右。道具圖邊長 50 往上偏一點，數量置中貼圓底
    bonusCircleX: 45.5,
    bonusCircleY: 45.5,
    bonusCircleR: 42,
    bonusIconY: -5.5,
    bonusIconSize: 50,
    bonusQtyBottom: 38.5,
    bonusBubbleQtyFont: 15,
    // 上方：四顆大鈕的圓心圍著 (381, 188.5)、半徑約 70；左上那格縮 0.75、貼著 HIGH 與
    // 使用物品，轉 45 度讓尾巴跟另外四顆一樣指向中心
    bonusAboveX: 304,
    bonusAboveY: 111,
    bonusAboveScale: 0.75,
    bonusAboveAngle: 45,
  };

  return `(function () {
  "use strict";
  ${WEBPACK_REQUIRE_SNIPPET}
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = ${JSON.stringify(FLAG)};

  function alive(o) { return !!(o && o.scene); }
  function safeDestroy(o) { try { if (alive(o)) o.destroy(); } catch (e) {} }
  function running(sc) {
    try { return !!(sc && sc.scene && sc.scene.isActive() && !sc.scene.isSleeping()); } catch (e) { return false; }
  }
  function sceneKey(sc) { try { return sc.sys.settings.key; } catch (e) { return null; } }
  function itemRow(id) {
    try {
      var arr = window.game.cache.json.get("AvatarItems");
      if (!Array.isArray(arr)) return null;
      for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    } catch (e) {}
    return null;
  }
  function owned() {
    var out = {};
    try {
      var arr = window.game.registry.get("avatar_item");
      if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) if (arr[i]) out[arr[i].item_id] = arr[i].quantity || 0;
    } catch (e) {}
    return out;
  }

  // ---- 面板類別 ---------------------------------------------------------------
  function findPanel() {
    var req = ulrWebpackRequire();
    if (req === null) return null;
    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (src.indexOf("get_item_data(") === -1 || src.indexOf("panel_open(") === -1) continue;
      var mod;
      // 只 require 命中的那一個
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var v = mod[k];
        if (typeof v === "function" && v.prototype && typeof v.prototype.get_item_data === "function" &&
            typeof v.prototype.panel_open === "function") return v;
      }
    }
    return null;
  }

  function unpatchPanel(Panel) {
    var p = Panel && Panel.prototype;
    if (!p || !p.__ulrItemPanelOrig) return;
    p.get_item_data = p.__ulrItemPanelOrig.get_item_data;
    p.panel_open = p.__ulrItemPanelOrig.panel_open;
    delete p.__ulrItemPanelOrig;
  }

  function patchPanel(st, Panel) {
    unpatchPanel(Panel);
    var p = Panel.prototype;
    var orig = { get_item_data: p.get_item_data, panel_open: p.panel_open };
    p.__ulrItemPanelOrig = orig;
    p.get_item_data = function () {
      var list = orig.get_item_data.apply(this, arguments);
      try {
        if (window[FLAG] === st && Array.isArray(list) && this.panel_base) {
          var key = sceneKey(this.panel_base.scene);
          if (key === "Raid") return raidOrder(list);
          if (key === "Quest") return list.filter(function (x) { return x && !hiddenBoost(x.item_id); });
        }
      } catch (e) { st.reason = "排序失敗：" + String((e && e.message) || e); }
      return list;
    };
    p.panel_open = function () {
      var r = orig.panel_open.apply(this, arguments);
      try { if (window[FLAG] === st) afterOpen(st, this); } catch (e) { st.reason = "開窗處理失敗：" + String((e && e.message) || e); }
      return r;
    };
    st.Panel = Panel;
  }

  // ② 渦房的順序（④ 任務房也藏增益類）
  function hiddenBoost(id) {
    if (CFG.hideIds.indexOf(id) !== -1) return true;
    var row = itemRow(id);
    return !!(row && row.boost_type !== undefined && row.boost_type !== null);
  }
  function rankOf(id) {
    if (CFG.apIds.indexOf(id) !== -1) return 0;
    var k = CFG.raidFirst.indexOf(id);
    return k === -1 ? 100 : 1 + k;
  }
  function raidOrder(list) {
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !hiddenBoost(list[i].item_id)) kept.push({ item: list[i], at: i });
    }
    kept.sort(function (a, b) { return rankOf(a.item.item_id) - rankOf(b.item.item_id) || a.at - b.at; });
    return kept.map(function (x) { return x.item; });
  }

  // ① 開窗：拿掉全畫面那層；已經有一張開著就是「再按一次＝關」
  function closing(panel) {
    var b = panel.panel_base;
    return !!(b && b.input && b.input.enabled === false);
  }
  function openPanels(st, sc, except) {
    var out = [];
    var list = sc.children.list;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o !== except && st.Panel && o instanceof st.Panel && alive(o) && !closing(o)) out.push(o);
    }
    return out;
  }
  function afterOpen(st, panel) {
    var sc = panel.scene;
    if (!sc || !sc.children || !Array.isArray(sc.children.list)) return;
    var list = sc.children.list;
    var at = list.indexOf(panel);
    if (at < 0) return;
    var zone = null;
    for (var i = at - 1; i >= 0 && i >= at - CFG.zoneLookBack; i--) {
      var o = list[i];
      if (o && o.type === "Zone" && o.width === CFG.screenW && o.height === CFG.screenH && o.depth === panel.depth) { zone = o; break; }
    }
    if (zone === null) return;
    var others = openPanels(st, sc, panel);
    if (others.length > 0) {
      try { if (sc.tweens) sc.tweens.killTweensOf(panel); } catch (e) {}
      safeDestroy(zone);
      safeDestroy(panel);
      for (var j = 0; j < others.length; j++) others[j].panel_close();
      st.toggled++;
      return;
    }
    if (zone.input) zone.disableInteractive();
    st.passThrough++;
  }

  // ---- ③ 物品捷徑 -------------------------------------------------------------
  function raidScene() {
    var G = window.game;
    var R = G && G.scene && G.scene.keys ? G.scene.keys.Raid : null;
    if (!running(R)) return null;
    if (!alive(R.icon_item) || !alive(R.icon_friend) || !alive(R.raid_support_btn)) return null;
    if (typeof R.use_avatar_item !== "function") return null;
    return R;
  }
  function textureOf(R, id) {
    try {
      var t = R.textures.get("AvatarItemImages");
      if (t && t.has("item_" + id)) return { key: "AvatarItemImages", frame: "item_" + id };
      var row = itemRow(id);
      if (row && row.texture_key && R.textures.exists(row.texture_key)) return { key: row.texture_key, frame: row.texture_frame };
    } catch (e) {}
    return null;
  }
  function priorityOf(id) { var row = itemRow(id); return row && typeof row.priority === "number" ? row.priority : 0; }
  function boundsOf(o) {
    var w = o.displayWidth || o.width || 0, h = o.displayHeight || o.height || 0;
    return { x: o.x - w * (o.originX === undefined ? 0.5 : o.originX), y: o.y - h * (o.originY === undefined ? 0.5 : o.originY) };
  }

  function detectorRank(id) {
    var k = CFG.detectorFirst.indexOf(id);
    return k === -1 ? CFG.detectorFirst.length : k;
  }

  /** 要畫哪些、畫在哪。 */
  function plan(R, have) {
    // 右列只佔官方兩顆鈕的位置；SUPPORT 上面不放（玩家常按 SUPPORT，放水會誤按）
    var slots = [
      { id: CFG.friendSlot, x: R.icon_friend.x, y: R.icon_friend.y },
      { id: CFG.itemSlot, x: R.icon_item.x, y: R.icon_item.y }
    ];

    var extras = [];
    for (var k in have) {
      var id = Number(k);
      if (!(have[k] > 0)) continue;
      var row = itemRow(id);
      if (row && row.kind === CFG.detectorKind) extras.push(id);
    }
    extras.sort(function (a, b) {
      return detectorRank(a) - detectorRank(b) || priorityOf(a) - priorityOf(b) || a - b;
    });
    var anchor = R.btn_raid_code;
    if (alive(anchor)) {
      var b = boundsOf(anchor);
      var n = Math.min(extras.length, CFG.extraMax);
      for (var j = 0; j < n; j++) {
        var row2 = Math.floor(j / CFG.extraPerRow), col = j % CFG.extraPerRow;
        slots.push({
          id: extras[j],
          x: Math.round(b.x + 24 + col * (48 + CFG.gap)),
          y: Math.round(b.y - CFG.gap - 16 - row2 * (32 + CFG.gap))
        });
      }
    }
    return slots;
  }

  function useItem(st, R, id) {
    if (R.input && R.input.enabled === false) return;
    try { if (R.ulse01) R.ulse01.play(); } catch (e) {}
    // 官方物品欄「使用」鈕送的就是這一條（select 事件 → 場景的 use_avatar_item）。
    // 第一個參數是面板：用完它會叫 show_item() 重畫 —— 這裡拿來重畫開著的面板與捷徑。
    var redraw = function () { st.sig = null; st.q.sig = null; st.d.sig = null; };
    var stub = {
      scene: R,
      show_item: function () {
        try {
          if (st.Panel) {
            var list = openPanels(st, R, null);
            for (var i = 0; i < list.length; i++) list[i].show_item();
          }
        } catch (e) {}
        redraw();
      }
    };
    st.uses++;
    var p = R.use_avatar_item(stub, id);
    if (p && typeof p.then === "function") p.then(redraw, redraw);
  }

  function makeButton(st, R, Btn, slot, qty) {
    var tex = textureOf(R, slot.id);
    if (tex === null) return null;
    var btn = new Btn(R, slot.x, slot.y, "item");
    var icon = btn.button_icon;
    icon.setTexture(tex.key, tex.frame);
    var s = Math.min(CFG.iconW / (icon.width || CFG.iconW), CFG.iconH / (icon.height || CFG.iconH));
    icon.setScale(s).setPosition(CFG.iconX, 0);
    var q = R.add.text(CFG.qtyX, CFG.qtyY, "x" + qty, { fontFamily: "font_light", fontSize: CFG.qtyFont, resolution: 2 })
      .setOrigin(1, 1).setStroke("black", 3);
    btn.add(q);
    if (slot.label) {
      // 通行證：圖都一樣，右上多一行名字
      btn.add(R.add.text(CFG.qtyX, -CFG.qtyY, slot.label, { fontFamily: "font_light", fontSize: CFG.qtyFont, resolution: 2 })
        .setOrigin(1, 0).setStroke("black", 3));
    }
    btn.setDepth(R.icon_item.depth);
    if (qty > 0) {
      btn.on("click", function () { useItem(st, R, slot.id); });
    } else {
      btn.setAlpha(0.5);
      if (btn.button_base && btn.button_base.input) btn.button_base.disableInteractive();
    }
    return btn;
  }

  function hideOfficial(st, R) {
    var list = [R.icon_friend, R.icon_item];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      b.setVisible(false);
      if (b.button_base && b.button_base.input) b.button_base.disableInteractive();
      st.hidden.push(b);
    }
  }
  function showOfficial(st) {
    for (var i = 0; i < st.hidden.length; i++) {
      var b = st.hidden[i];
      if (!alive(b)) continue;
      b.setVisible(true);
      if (b.button_base && typeof b.button_base.setInteractive === "function") b.button_base.setInteractive();
    }
    st.hidden = [];
  }
  function detach(st) {
    for (var i = 0; i < st.mine.length; i++) safeDestroy(st.mine[i]);
    st.mine = [];
    showOfficial(st);
    st.scene = null;
    st.anchor = null;
    st.sig = null;
  }

  function syncShortcut(st) {
    var R = st.shortcut ? raidScene() : null;
    if (R === null) { if (st.scene !== null || st.hidden.length) detach(st); return; }
    var have = owned();
    var slots = plan(R, have);
    var sig = slots.map(function (s) { return s.id + ":" + (have[s.id] || 0) + "@" + s.x + "," + s.y; }).join("|");
    var intact = st.mine.every(alive);
    if (st.scene === R && st.anchor === R.icon_item && st.sig === sig && intact) return;
    detach(st);
    var Btn = Object.getPrototypeOf(R.icon_item).constructor;
    hideOfficial(st, R);
    for (var i = 0; i < slots.length; i++) {
      var b = makeButton(st, R, Btn, slots[i], have[slots[i].id] || 0);
      if (b !== null) st.mine.push(b);
    }
    st.scene = R;
    st.anchor = R.icon_item;
    st.sig = sig;
  }

  // ---- ⑤ 任務房的物品捷徑 -----------------------------------------------------
  function questScene() {
    var G = window.game;
    var Q = G && G.scene && G.scene.keys ? G.scene.keys.Quest : null;
    if (!running(Q)) return null;
    if (!alive(Q.icon_item) || !alive(Q.icon_friend)) return null;
    if (typeof Q.use_avatar_item !== "function") return null;
    return Q;
  }
  function questPlan(st, Q, have) {
    var slots = [];
    // 水沙：FRIENDLIST 正上方貼著疊，最後一格緊鄰 FRIENDLIST
    var n = st.questStack ? CFG.questStack.length : 0;
    for (var i = 0; i < n; i++) {
      slots.push({ id: CFG.questStack[i], x: Q.icon_friend.x, y: Q.icon_friend.y - (n - i) * CFG.stackStep });
    }
    if (!st.questPasses) return slots;
    var passes = CFG.passIds.filter(function (id) { return have[id] > 0; });
    var m = Math.min(passes.length, CFG.passMax);
    for (var j = 0; j < m; j++) {
      slots.push({
        id: passes[j],
        x: CFG.passX + (j % CFG.passPerRow) * CFG.passStepX,
        y: CFG.passY + Math.floor(j / CFG.passPerRow) * CFG.passStepY,
        label: CFG.passLabels[passes[j]]
      });
    }
    return slots;
  }
  // 任務房與迪城共用：一組自己畫的鈕（box ＝ st.q／st.d）
  function detachBox(box) {
    for (var i = 0; i < box.mine.length; i++) safeDestroy(box.mine[i]);
    box.mine = [];
    box.scene = null;
    box.anchor = null;
    box.sig = null;
  }
  function syncBox(st, box, sc, slots, have) {
    var sig = slots.map(function (s) { return s.id + ":" + (have[s.id] || 0) + "@" + s.x + "," + s.y; }).join("|");
    var intact = box.mine.every(alive);
    if (box.scene === sc && box.anchor === sc.icon_item && box.sig === sig && intact) return;
    detachBox(box);
    var Btn = Object.getPrototypeOf(sc.icon_item).constructor;
    for (var i = 0; i < slots.length; i++) {
      var b = makeButton(st, sc, Btn, slots[i], have[slots[i].id] || 0);
      if (b !== null) box.mine.push(b);
    }
    box.scene = sc;
    box.anchor = sc.icon_item;
    box.sig = sig;
  }
  function detachQuest(st) { detachBox(st.q); }
  function syncQuestShortcut(st) {
    var Q = st.questStack || st.questPasses ? questScene() : null;
    if (Q === null) { if (st.q.scene !== null || st.q.mine.length) detachQuest(st); return; }
    var have = owned();
    syncBox(st, st.q, Q, questPlan(st, Q, have), have);
  }

  // ---- ⑦ 迪城的水 ---------------------------------------------------------------
  // 頻道物件有 type 就看 type；沒有就是「不是快速比賽（亞城）也不是活動頻道」
  function isDiet(ch) {
    if (!ch || typeof ch !== "object") return false;
    if (typeof ch.type === "string") return ch.type === "duel";
    return ch.quick !== true && ch.event !== true;
  }
  function dietScene() {
    var G = window.game;
    var M = G && G.scene && G.scene.keys ? G.scene.keys.Match : null;
    if (!running(M) || !isDiet(M.channel)) return null;
    return M;
  }
  function syncDietShortcut(st) {
    var M = st.dietStack ? dietScene() : null;
    if (M !== null && (!alive(M.icon_item) || !alive(M.icon_friend) || typeof M.use_avatar_item !== "function")) M = null;
    if (M === null) { if (st.d.scene !== null || st.d.mine.length) detachBox(st.d); return; }
    var have = owned();
    var slots = [];
    var n = CFG.dietStack.length;
    for (var i = 0; i < n; i++) {
      slots.push({ id: CFG.dietStack[i], x: M.icon_friend.x, y: M.icon_friend.y - (n - i) * CFG.stackStep });
    }
    syncBox(st, st.d, M, slots, have);
  }

  // ---- ⑧ 迪城的 GEM UP --------------------------------------------------------------
  function gemBoost() {
    try {
      var arr = window.game.registry.get("player_boost");
      if (!Array.isArray(arr)) return null;
      var now = Date.now();
      for (var i = 0; i < arr.length; i++) {
        var b = arr[i];
        if (b && b.boost_type === CFG.gemBoostType && now <= new Date(b.expire_at).getTime()) return b;
      }
    } catch (e) {}
    return null;
  }
  // 大廳那個倒數：日:時:分:秒，各兩位
  function countdown(ms) {
    if (!(ms > 0)) ms = 0;
    var two = function (n) { return ("00" + n).slice(-2); };
    return two(Math.trunc(ms / 864e5)) + ":" + two(Math.trunc(ms % 864e5 / 36e5)) + ":" +
      two(Math.trunc(ms % 36e5 / 6e4)) + ":" + two(Math.trunc(ms % 6e4 / 1e3));
  }
  function assetBase() {
    try {
      var urls = window.UL_CONFIG.domains.assets.urls;
      if (urls && urls.length) return String(urls[0]).replace(/\\/+$/, "") + "/";
    } catch (e) {}
    return null;
  }
  function lobbyAtlas(name) {
    try {
      var list = window.UL_ASSETS.lobby.atlas || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === name) return list[i];
    } catch (e) {}
    return null;
  }
  function fetchImage(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var u = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { try { URL.revokeObjectURL(u); } catch (e) {} resolve(img); };
        img.onerror = function () { try { URL.revokeObjectURL(u); } catch (e) {} reject(new Error(url + " 解不開")); };
        img.src = u;
      });
    });
  }
  // 圖在不在；不在就開始抓（一次只抓一份，失敗隔一段時間再試）
  function boostTexture(st) {
    var G = window.game;
    if (G.textures.exists(CFG.boostTex)) return true;
    if (st.g.loading || Date.now() < st.g.nextLoad) return false;
    var base = assetBase(), src = lobbyAtlas(CFG.boostAsset);
    if (base === null || src === null) {
      st.g.nextLoad = Date.now() + CFG.boostRetryMs;
      st.reason = "GEM UP 的圖：UL_ASSETS.lobby 裡沒有 " + CFG.boostAsset;
      return false;
    }
    st.g.loading = true;
    var json = fetch(base + src.atlasURL).then(function (r) {
      if (!r.ok) throw new Error(src.atlasURL + " -> HTTP " + r.status);
      return r.json();
    });
    Promise.all([fetchImage(base + src.textureURL), json]).then(function (got) {
      st.g.loading = false;
      if (window[FLAG] !== st || G.textures.exists(CFG.boostTex)) return;
      G.textures.addAtlas(CFG.boostTex, got[0], got[1]);
      tick(st);
    }, function (e) {
      st.g.loading = false;
      st.g.nextLoad = Date.now() + CFG.boostRetryMs;
      st.reason = "GEM UP 的圖載不到：" + String((e && e.message) || e);
    });
    return false;
  }
  function detachGem(st) {
    for (var i = 0; i < st.g.mine.length; i++) safeDestroy(st.g.mine[i]);
    st.g.mine = [];
    st.g.scene = null;
    st.g.value = null;
  }
  function syncGem(st) {
    var M = st.gemUp ? dietScene() : null;
    var b = M !== null ? gemBoost() : null;
    if (b === null || !boostTexture(st)) { if (st.g.scene !== null || st.g.mine.length) detachGem(st); return; }
    var intact = st.g.mine.length === 3 && st.g.mine.every(alive);
    if (st.g.scene !== M || st.g.value !== b.boost_value || !intact) {
      detachGem(st);
      var style = { fontFamily: "BradleyGratis", fontSize: 18, resolution: 2 };
      var icon = M.add.image(CFG.gemX, CFG.gemY, CFG.boostTex, "boost_" + CFG.gemBoostType)
        .setOrigin(1, 1).setDepth(CFG.gemDepth);
      var timer = M.add.text(CFG.gemTimerX, CFG.gemTimerY, "", style)
        .setOrigin(0, 0).setStroke("black", 2).setDepth(CFG.gemDepth);
      var pct = M.add.text(CFG.gemPctX, CFG.gemPctY, "+" + b.boost_value + "%", style)
        .setOrigin(1, 1).setStroke("black", 2).setDepth(CFG.gemDepth);
      st.g.mine = [icon, timer, pct];
      st.g.scene = M;
      st.g.value = b.boost_value;
    }
    var t = countdown(new Date(b.expire_at).getTime() - Date.now());
    if (st.g.mine[1].text !== t) st.g.mine[1].setText(t);
  }
  // ---- ⑨ 獎勵遊戲的物品捷徑 ------------------------------------------------------
  // 猜錯了（使用物品、結束遊戲兩顆鈕在）才畫
  function bonusScene() {
    var G = window.game;
    var B = G && G.scene && G.scene.keys ? G.scene.keys.Bonus : null;
    if (!running(B)) return null;
    if (!alive(B.btn_item) || !alive(B.btn_quit)) return null;
    if (typeof B.use_bonus_item !== "function") return null;
    var d = B.bonus_data;
    if (!d || typeof d.dice_current !== "number" || typeof d.dice_previous !== "number") return null;
    return B;
  }
  // 官方 can_use_bonus_item：value 小於 0 永遠能用，不然差距不超過 value
  function bonusUsable(id, diff) {
    var row = itemRow(id);
    if (!row || typeof row.value !== "number") return false;
    return row.value < 0 || diff <= row.value;
  }
  function bonusPick(st, diff, have) {
    var lists = [CFG.bonusPrecise, CFG.bonusOrders[st.bonusOrder] || CFG.bonusOrders.heather5];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        var id = lists[i][j];
        if (have[id] > 0 && bonusUsable(id, diff)) return id;
      }
    }
    return null;
  }
  function detachBonus(st) {
    if (st.b.follow) {
      try { st.b.follow.events.off("update", st.b.follow.fn); } catch (e) {}
      st.b.follow = null;
    }
    for (var i = 0; i < st.b.mine.length; i++) safeDestroy(st.b.mine[i]);
    st.b.mine = [];
    st.b.scene = null;
    st.b.anchor = null;
    st.b.sig = null;
    st.b.cover = false;
    st.b.hit = null;
  }
  // 官方 bonus_item 抹掉字的版本（每格一樣大、格子照原圖）。做不出來回 null
  function bonusBubbleTexture(B) {
    var T = B.textures;
    if (T.exists(CFG.bonusBtnTex)) return CFG.bonusBtnTex;
    if (!T.exists(CFG.bonusBtnAsset) || typeof T.addCanvas !== "function") return null;
    var src = T.get(CFG.bonusBtnAsset).getSourceImage();
    var W = CFG.bonusBtnW, H = CFG.bonusBtnH;
    var n = src ? Math.floor(src.width / W) : 0;
    if (n < 1 || src.height < H) return null;
    var cv = window.document.createElement("canvas");
    cv.width = src.width;
    cv.height = src.height;
    var g = cv.getContext("2d");
    g.drawImage(src, 0, 0);
    var box = bonusTextBox(g.getImageData(0, 0, W, H).data, W, H);
    if (box === null) return null;
    for (var f = 0; f < n; f++) {
      var img = g.getImageData(f * W, 0, W, H);
      eraseBand(img.data, W, box);
      g.putImageData(img, f * W, 0);
    }
    var tex = T.addCanvas(CFG.bonusBtnTex, cv);
    if (!tex) return null;
    for (var k = 0; k < n; k++) tex.add(k, 0, k * W, 0, W, H);
    return CFG.bonusBtnTex;
  }
  // 字的範圍：第 0 格（灰底白字）不透明又亮過門檻的像素，外擴幾格
  function bonusTextBox(d, W, H) {
    var x0 = W, x1 = -1, y0 = H, y1 = -1, lum = CFG.bonusTextLum * 3;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        if (d[i + 3] <= 200 || d[i] + d[i + 1] + d[i + 2] <= lum) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    var p = CFG.bonusErasePad;
    return { x0: Math.max(0, x0 - p), x1: Math.min(W - 1, x1 + p), y0: Math.max(0, y0 - p), y1: Math.min(H - 1, y1 + p) };
  }
  // 範圍裡每一欄用上下緣的顏色直向內插（圓裡是上暗下亮的直向漸層）；透明度不動
  function eraseBand(d, W, box) {
    for (var x = box.x0; x <= box.x1; x++) {
      var a = (box.y0 * W + x) * 4, b = (box.y1 * W + x) * 4;
      for (var y = box.y0 + 1; y < box.y1; y++) {
        var t = (y - box.y0) / (box.y1 - box.y0), i = (y * W + x) * 4;
        for (var k = 0; k < 3; k++) d[i + k] = Math.round(d[a + k] * (1 - t) + d[b + k] * t);
      }
    }
  }
  function removeBubbleTexture() {
    try {
      var G = window.game;
      if (G.textures.exists(CFG.bonusBtnTex)) G.textures.remove(CFG.bonusBtnTex);
    } catch (e) {}
  }
  function useBonus(st, B, id) {
    if (B.input && B.input.enabled === false) return;
    var btn = B.btn_item;
    if (st.b.used === btn) return;
    st.b.used = btn;
    // 蓋著的那顆留著（不能再按），跟官方鈕一起淡出；其他的當場拆
    if (st.b.cover) { try { if (st.b.hit) st.b.hit.disableInteractive(); } catch (e) {} }
    else detachBonus(st);
    try { if (B.ulse17) B.ulse17.play(); } catch (e) {}
    // use_bonus_item 會 item_zone.destroy()、item_panel.show_item()／panel_close()／destroy()。
    // 官方是開著物品欄才叫它；沒開就墊替身，開著就照官方
    var noop = function () {};
    if (!alive(B.item_zone)) B.item_zone = { destroy: noop };
    if (!alive(B.item_panel)) B.item_panel = { show_item: noop, panel_close: noop, destroy: noop };
    st.uses++;
    // 伺服器說不能用（回 false）時官方什麼都不做、輸入沒鎖：放回來（拆掉讓下一輪重畫）
    var again = function () {
      if (st.b.used === btn && alive(btn) && !(B.input && B.input.enabled === false)) {
        st.b.used = null;
        detachBonus(st);
      }
    };
    var p = B.use_bonus_item(id);
    if (p && typeof p.then === "function") p.then(again, again);
  }
  // 抹字的圓鈕＋道具圖＋數量。蓋在使用物品上（同位置、同大小），或縮小轉向放在左上
  function drawBonusBubble(st, B, id, qty, cover) {
    var tex = textureOf(B, id);
    var key = tex === null ? null : bonusBubbleTexture(B);
    if (key === null) return null;
    var btn = B.btn_item;
    var c = cover
      ? B.add.container(btn.x + CFG.bonusCircleX, btn.y + CFG.bonusCircleY)
      : B.add.container(CFG.bonusAboveX, CFG.bonusAboveY).setScale(CFG.bonusAboveScale);
    c.setDepth(CFG.bonusDepth);
    var base = B.add.image(0, 0, key, 0).setOrigin(CFG.bonusCircleX / CFG.bonusBtnW, CFG.bonusCircleY / CFG.bonusBtnH);
    if (!cover) base.setAngle(CFG.bonusAboveAngle);
    var icon = B.add.image(0, CFG.bonusIconY, tex.key, tex.frame);
    icon.setScale(CFG.bonusIconSize / Math.max(icon.width || 1, icon.height || 1));
    var q = B.add.text(0, CFG.bonusQtyBottom, "x" + qty, { fontFamily: "font_light", fontSize: CFG.bonusBubbleQtyFont, resolution: 2 })
      .setOrigin(0.5, 1).setStroke("black", 3);
    c.add(base);
    c.add(icon);
    c.add(q);
    if (cover) base.setInteractive();
    else {
      // 轉過的方框四角會伸進旁邊兩顆鈕，只認圓
      var r2 = CFG.bonusCircleR * CFG.bonusCircleR;
      base.setInteractive({ x: CFG.bonusCircleX, y: CFG.bonusCircleY, radius: CFG.bonusCircleR }, function (s, x, y) {
        var dx = x - s.x, dy = y - s.y;
        return dx * dx + dy * dy <= r2;
      });
    }
    // 跟官方的鈕一樣：滑上換紅、按下換回、放開才算按
    base.on("pointerover", function () { base.setFrame(1); });
    base.on("pointerout", function () { base.setFrame(0); });
    base.on("pointerdown", function () { base.setFrame(0); });
    base.on("pointerup", function () { base.setFrame(1); useBonus(st, B, id); });
    // 透明度、顯示跟著官方鈕（淡入、按過淡出）
    var follow = function () {
      if (!alive(btn) || !alive(c)) return;
      if (c.alpha !== btn.alpha) c.setAlpha(btn.alpha);
      if (c.visible !== btn.visible) c.setVisible(btn.visible);
    };
    follow();
    if (B.events && typeof B.events.on === "function") {
      B.events.on("update", follow);
      st.b.follow = { events: B.events, fn: follow };
    }
    st.b.hit = base;
    return c;
  }
  // 退路：做不出抹字的底圖時照物品欄格子畫在上方
  function drawBonusSlot(st, B, id, qty) {
    var tex = textureOf(B, id);
    if (tex === null) return null;
    var c = B.add.container(CFG.bonusX, CFG.bonusY).setScale(CFG.bonusScale).setDepth(CFG.bonusDepth);
    var base = B.textures.exists("item_base") ? B.add.sprite(0, 0, "item_base", 0) : null;
    var icon = B.add.image(0, 0, tex.key, tex.frame).setScale(CFG.bonusIconScale);
    var q = B.add.text(CFG.bonusQtyX, CFG.bonusQtyY, "x" + qty, { fontFamily: "font_light", fontSize: CFG.bonusQtyFont, resolution: 2 })
      .setOrigin(1, 1).setStroke("black", 3);
    if (base !== null) c.add(base);
    c.add(icon);
    c.add(q);
    var hit = base !== null ? base : icon;
    hit.setInteractive();
    // 跟官方的鈕一樣：滑上換格、放開才算按
    hit.on("pointerover", function () { if (base !== null) base.setFrame(1); });
    hit.on("pointerout", function () { if (base !== null) base.setFrame(0); });
    hit.on("pointerup", function () { useBonus(st, B, id); });
    return c;
  }
  function syncBonus(st) {
    var B = st.bonusItem ? bonusScene() : null;
    if (B !== null && st.b.used === B.btn_item) {
      // 按過了：蓋著的那顆跟官方鈕一起淡出，鈕拆了（bonusScene 回 null）才跟著拆
      if (st.b.cover && st.b.anchor === B.btn_item && st.b.mine.length && st.b.mine.every(alive)) return;
      B = null;
    }
    var have = B !== null ? owned() : null;
    var d = B !== null ? B.bonus_data : null;
    var id = B !== null ? bonusPick(st, Math.abs(d.dice_current - d.dice_previous), have) : null;
    st.b.pick = id;
    if (id === null) { if (st.b.scene !== null || st.b.mine.length) detachBonus(st); return; }
    var sig = id + ":" + have[id] + ":" + st.bonusPlace;
    if (st.b.scene === B && st.b.anchor === B.btn_item && st.b.sig === sig && st.b.mine.every(alive)) return;
    detachBonus(st);
    var cover = st.bonusPlace === "cover";
    var c = drawBonusBubble(st, B, id, have[id], cover);
    if (c === null) { cover = false; c = drawBonusSlot(st, B, id, have[id]); }
    if (c === null) return;
    st.b.mine.push(c);
    st.b.scene = B;
    st.b.anchor = B.btn_item;
    st.b.sig = sig;
    st.b.cover = cover;
  }

  function removeBoostTexture() {
    try {
      var G = window.game;
      if (G.textures.exists(CFG.boostTex)) G.textures.remove(CFG.boostTex);
    } catch (e) {}
  }

  // ---- ⑥ 開始搜索蓋在物品欄上面 -------------------------------------------------
  function restoreSearch(st) {
    for (var i = 0; i < st.raised.length; i++) {
      var r = st.raised[i];
      try { if (alive(r.o) && r.o.depth !== r.d) r.o.setDepth(r.d); } catch (e) {}
    }
    st.raised = [];
  }
  // 包場景實例的 show_search：搜索框一開就抬，不等下一輪（不然會先被蓋住一下）
  function hookSearch(st, Q) {
    var cur = Q.show_search;
    if (typeof cur !== "function" || cur.__ulrItemPanel === st) return;
    var had = Object.prototype.hasOwnProperty.call(Q, "show_search");
    var w = function () {
      var r = cur.apply(this, arguments);
      try { if (window[FLAG] === st) syncSearch(st); } catch (e) {}
      return r;
    };
    w.__ulrItemPanel = st;
    w.__ulrOrig = cur;
    w.__ulrHad = had;
    Q.show_search = w;
    st.searchHooked = Q;
  }
  function unhookSearch(st) {
    var Q = st.searchHooked;
    st.searchHooked = null;
    if (!Q) return;
    var w = Q.show_search;
    if (!w || w.__ulrItemPanel !== st) return;
    if (w.__ulrHad) Q.show_search = w.__ulrOrig; else delete Q.show_search;
  }
  function syncSearch(st) {
    var G = window.game;
    var Q = G && G.scene && G.scene.keys ? G.scene.keys.Quest : null;
    if (running(Q)) hookSearch(st, Q);
    var panel = null;
    if (st.Panel && running(Q) && alive(Q.search_bg)) {
      var open = openPanels(st, Q, null);
      if (open.length > 0) panel = open[0];
    }
    if (panel === null) { if (st.raised.length) restoreSearch(st); return; }
    // 死掉的（搜索框關了）先丟掉
    st.raised = st.raised.filter(function (r) { return alive(r.o); });
    var lift = panel.depth + 1 - CFG.searchDepth;
    for (var i = 0; i < CFG.searchParts.length; i++) {
      var o = Q[CFG.searchParts[i]];
      if (!alive(o)) continue;
      var rec = null;
      for (var j = 0; j < st.raised.length; j++) if (st.raised[j].o === o) { rec = st.raised[j]; break; }
      if (rec === null) { rec = { o: o, d: o.depth }; st.raised.push(rec); }
      if (o.depth !== rec.d + lift) o.setDepth(rec.d + lift);
    }
  }

  function tick(st) {
    if (window[FLAG] !== st) return;
    try {
      if (st.Panel === null && Date.now() >= st.nextFind) {
        st.nextFind = Date.now() + CFG.findEveryMs;
        var P = findPanel();
        if (P !== null) patchPanel(st, P);
      }
      syncShortcut(st);
      syncQuestShortcut(st);
      syncDietShortcut(st);
      syncGem(st);
      syncBonus(st);
      syncSearch(st);
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  function restore() {
    var old = window[FLAG];
    if (!old) return;
    try { if (old.timer) clearInterval(old.timer); } catch (e) {}
    try { detach(old); } catch (e) {}
    try { if (old.q) detachQuest(old); } catch (e) {}
    try { if (old.d) detachBox(old.d); } catch (e) {}
    try { if (old.g) detachGem(old); } catch (e) {}
    try { if (old.b) detachBonus(old); } catch (e) {}
    // 抹字的底圖也丟掉：新版的抹法可能不一樣
    removeBubbleTexture();
    try { if (old.raised) restoreSearch(old); } catch (e) {}
    try { unhookSearch(old); } catch (e) {}
    try { unpatchPanel(old.Panel); } catch (e) {}
    delete window[FLAG];
  }

  restore();
  var st = {
    version: CFG.version,
    shortcut: CFG.shortcut,
    questStack: CFG.questStackOn,
    questPasses: CFG.questPassesOn,
    dietStack: CFG.dietStackOn,
    gemUp: CFG.gemUpOn,
    bonusItem: CFG.bonusOn,
    bonusOrder: CFG.bonusOrder,
    bonusPlace: CFG.bonusPlace,
    Panel: null,
    nextFind: 0,
    timer: null,
    scene: null,
    anchor: null,
    sig: null,
    mine: [],
    hidden: [],
    q: { scene: null, anchor: null, sig: null, mine: [] },
    d: { scene: null, anchor: null, sig: null, mine: [] },
    g: { scene: null, value: null, mine: [], loading: false, nextLoad: 0 },
    b: { scene: null, anchor: null, sig: null, mine: [], used: null, pick: null, cover: false, hit: null, follow: null },
    raised: [],
    searchHooked: null,
    passThrough: 0,
    toggled: 0,
    uses: 0,
    reason: null
  };
  window[FLAG] = st;
  st.detach = function () {
    detach(st); detachQuest(st); detachBox(st.d); detachGem(st); detachBonus(st); removeBoostTexture(); removeBubbleTexture();
    restoreSearch(st); unhookSearch(st);
  };
  st.detachRaid = function () { detach(st); };
  // 任務房／迪城的其中一塊開關了：當場拆掉重畫（同一房的另一塊一起重畫，位置不變）
  st.setPart = function (part, on) {
    if (part === "stack" || part === "passes") {
      if (part === "stack") st.questStack = on; else st.questPasses = on;
      detachQuest(st);
      try { syncQuestShortcut(st); } catch (e) { st.reason = String((e && e.message) || e); }
      return true;
    }
    if (part === "dietStack") {
      st.dietStack = on;
      detachBox(st.d);
      try { syncDietShortcut(st); } catch (e) { st.reason = String((e && e.message) || e); }
      return true;
    }
    if (part === "gemUp") {
      st.gemUp = on;
      detachGem(st);
      try { syncGem(st); } catch (e) { st.reason = String((e && e.message) || e); }
      return true;
    }
    if (part === "bonusItem") {
      st.bonusItem = on;
      detachBonus(st);
      try { syncBonus(st); } catch (e) { st.reason = String((e && e.message) || e); }
      return true;
    }
    return false;
  };
  st.setBonusOrder = function (order) {
    if (!CFG.bonusOrders[order]) return false;
    st.bonusOrder = order;
    detachBonus(st);
    try { syncBonus(st); } catch (e) { st.reason = String((e && e.message) || e); }
    return true;
  };
  st.setBonusPlace = function (place) {
    if (place !== "above" && place !== "cover") return false;
    st.bonusPlace = place;
    detachBonus(st);
    try { syncBonus(st); } catch (e) { st.reason = String((e && e.message) || e); }
    return true;
  };
  st.report = function () {
    var gem = gemBoost();
    return { installed: true, version: st.version, found: st.Panel !== null, shortcut: st.shortcut,
      inRaid: st.scene !== null, buttons: st.mine.length, questStack: st.questStack, questPasses: st.questPasses,
      inQuest: st.q.scene !== null, questButtons: st.q.mine.length, dietStack: st.dietStack, gemUp: st.gemUp,
      inDiet: dietScene() !== null, dietButtons: st.d.mine.length, gemShown: st.g.mine.length > 0,
      gemPct: gem === null ? null : gem.boost_value, bonusItem: st.bonusItem, bonusOrder: st.bonusOrder, bonusPlace: st.bonusPlace,
      inBonus: st.b.mine.length > 0, bonusPick: st.b.mine.length > 0 ? st.b.pick : null, reason: st.reason };
  };
  st.unpatch = function () { unpatchPanel(st.Panel); };
  tick(st);
  st.timer = setInterval(function () { tick(st); }, CFG.pollMs);
  return JSON.stringify(st.report());
})()`;
}

export const ITEM_PANEL_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false });
    if (typeof st.report === "function") return JSON.stringify(st.report());
    // 舊版（沒有 report）：版本號對不上，呼叫端會整支重裝
    return JSON.stringify({ installed: true, version: st.version, reason: st.reason });
  } catch (e) {
    return JSON.stringify({ installed: false, reason: String((e && e.message) || e) });
  }
})()`;

/**
 * 開關渦房的捷徑。下一輪（0.5 秒內）畫上或拆掉。回 `"ok"` 或 `"not-installed"`。
 * 頁面上是舊版（沒有 detachRaid）就回 `"not-installed"`，讓呼叫端整支重裝。
 */
export function buildItemPanelSetShortcutExpression(on: boolean): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.detachRaid !== "function") return "not-installed";
    st.shortcut = ${on ? "true" : "false"};
    if (!st.shortcut) st.detachRaid();
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/**
 * 開關任務房（水沙／通行證）或迪城（水／GEM UP）的其中一塊，當場重畫。
 * 回 `"ok"` 或 `"not-installed"`（頁面上是沒有 setPart 的舊版也算）。
 */
export function buildItemPanelSetPartExpression(part: ItemPanelPart, on: boolean): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.setPart !== "function") return "not-installed";
    st.setPart(${JSON.stringify(part)}, ${on ? "true" : "false"});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/**
 * 換獎勵遊戲差距大時先用哪一種，當場重畫。
 * 回 `"ok"` 或 `"not-installed"`（頁面上是沒有 setBonusOrder 的舊版也算）。
 */
export function buildItemPanelSetBonusOrderExpression(order: BonusItemOrder): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.setBonusOrder !== "function") return "not-installed";
    st.setBonusOrder(${JSON.stringify(order)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/**
 * 換獎勵遊戲的捷徑畫在哪（上方／蓋在使用物品上），當場重畫。
 * 回 `"ok"` 或 `"not-installed"`（頁面上是沒有 setBonusPlace 的舊版也算）。
 */
export function buildItemPanelSetBonusPlaceExpression(place: BonusItemPlace): string {
  return `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st || typeof st.setBonusPlace !== "function") return "not-installed";
    st.setBonusPlace(${JSON.stringify(place)});
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;
}

/** 拆掉：停輪詢、拆各房的捷徑與 GEM UP、官方兩顆鈕放回來、搜索框放回原 depth、面板類別還原。 */
export const ITEM_PANEL_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (st.timer) clearInterval(st.timer); } catch (e) {}
    try { if (typeof st.detach === "function") st.detach(); } catch (e) {}
    try { if (typeof st.unpatch === "function") st.unpatch(); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

export function parseItemPanelStatus(raw: string): ItemPanelStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = { reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}` };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    found: o.found === true,
    shortcut: o.shortcut === true,
    inRaid: o.inRaid === true,
    buttons: num(o.buttons),
    questStack: o.questStack === true,
    questPasses: o.questPasses === true,
    inQuest: o.inQuest === true,
    questButtons: num(o.questButtons),
    dietStack: o.dietStack === true,
    gemUp: o.gemUp === true,
    inDiet: o.inDiet === true,
    dietButtons: num(o.dietButtons),
    gemShown: o.gemShown === true,
    gemPct: typeof o.gemPct === "number" ? o.gemPct : null,
    bonusItem: o.bonusItem === true,
    bonusOrder: isBonusItemOrder(o.bonusOrder) ? o.bonusOrder : DEFAULT_BONUS_ITEM_ORDER,
    bonusPlace: isBonusItemPlace(o.bonusPlace) ? o.bonusPlace : DEFAULT_BONUS_ITEM_PLACE,
    inBonus: o.inBonus === true,
    bonusPick: typeof o.bonusPick === "number" ? o.bonusPick : null,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
