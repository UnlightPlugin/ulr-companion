/**
 * 自動開房／進房（WP-16）
 * =========================
 * 約戰配對湊成之後，這支負責驅動遊戲原本的開房與進房流程。**協定是從跑著的
 * 客戶端挖出來的**，不是猜的。
 *
 * ## 2026-09-23 改版之後的協定（2026-09-27 從 chunk 191／693 讀的）
 *
 * 每個頻道有自己的一條連線（`Match.socket_channel`，網址是頻道物件的 `domain`），
 * 一律走 `fetch`（＝ `once(ev)` ＋ `emit(ev)`，回應就是同名事件）：
 *
 * ```
 *   頻道清單  socket.fetch("get_matching_channel")
 *             → [{ channel, quick, event, cost, required_ap, domain }]
 *   房間清單  sc.channel_room（伺服器推 refresh_room 時整份換掉）
 *   開房      socket_channel.fetch("create_room", deck_now, channel,
 *               { room_name, stage, friend, cost, password, deck_id })
 *             → room_id（字串）；失敗回 null，另外推 match_error(代碼)
 *             成功後官方做：room_wait = true、room_select = id、create_match_wait()
 *   有人進來  推 match_start(房間設定) → on_match_start() → MatchBoot
 *   進房      socket_channel.fetch("enter_room", room_id, deck_now, 密碼或 null)
 *             → 房間設定；官方接著 create_match_loading() ＋ launch("MatchBoot", …)
 *   收房      socket_channel.fetch("cancel_room", room_id)
 * ```
 *
 * 改版前那一套（`match_room_make`／`room_in`／`delete_room`、`sc.id`、
 * `channels_cross`、`channel_panel`）**全部不存在了**，這支整個照新協定重寫。
 *
 * ⚠ 收房現在吃 **room_id**，不再是「整個頻道一起收」—— 舊版那條「插件的取消會把
 * 玩家手動開的房一起收掉」的坑沒有了。
 *
 * ## ⚠ 這支會改變遊戲狀態
 *
 * 開房會**消耗 AP**、會在公開的房間清單裡出現、會讓玩家進入對戰。
 * 跟這個 package 其他的注入不同（那些只改顯示），這裡是真的在替玩家操作。
 * 呼叫端必須是玩家明確按下的動作，絕對不能自動觸發。
 *
 * ## 房間密碼就是配對 token
 *
 * 官方的密碼是客戶端產生的英數字串（6 碼，輸入框收 12 碼以內的英數），當成
 * 普通參數送出。所以插件可以指定成中間人給的那一組（8 碼英數）—— 外人看得到
 * 那間房但進不去。⚠ **房名絕對不能包含 token**，那等於把密碼貼在公開清單上。
 *
 * ## 房間清單是公開資訊
 *
 * `channel_room` 的每一筆都帶著雙方的牌組（`playerA_deck`／`playerB_deck`）——
 * 那是遊戲送給大廳裡**每一個人**的，房間詳細面板也確實會畫出雙方的卡。
 * ⚠ 但**不得**拿它來挑對手（看到不好打的就不配）。那不是 §12 的隱藏資訊問題，
 * 是運動精神問題，而且會讓整個約戰功能失去意義。
 */

import { embedJson } from "./embed.js";

/** 房間清單裡一副公開可見的牌組（改版後的卡片 id）。 */
export interface RoomDeck {
  /** 三個槽位的 `CharaCards[].id`，空槽是 `null`。 */
  charaCardId: (number | null)[];
  /** 伺服器算的 COST（原版規則）。 */
  cost: number;
}

/**
 * 一副牌組的四種規則鍵。空格保留成 `null` —— 呼叫端要分得出「這格是空的」
 * 與「這格有卡但我讀不到它是誰」，後者算出來的 COST 會少一項。
 */
export interface DeckKeySet {
  /** 三個槽位，角色（`cc078_04`）或怪物（`mc001_01`）。 */
  characters: (string | null)[];
  /** 三個槽位各自的武器（`wp001`）。 */
  equipment: (string | null)[];
  /** 18 格事件卡（`ev091`）。 */
  eventCards: (string | null)[];
}

/** 房間清單裡的一筆。只挑我們用得到的欄位。 */
export interface RoomEntry {
  roomId: string;
  name: string;
  /** 房主顯示名稱。host 靠它找出自己開的那間。 */
  playerAName: string | null;
  playerBName: string | null;
  /** 有沒有密碼。 */
  pass: boolean;
  deckA: RoomDeck | null;
  deckB: RoomDeck | null;
}

/** 開一間房要多少 AP —— 頻道物件自己帶的 `required_ap.normal`。 */
export interface RequiredAp {
  single: number;
  multi: number;
}

export interface MatchContext {
  /** 讀得到玩家 id 嗎。⚠ id 本身是登入憑證，**不得離開本機**，所以只回有沒有。 */
  hasId: boolean;
  /** 目前所在頻道。沒進頻道是 `null`。 */
  channel: number | null;
  /**
   * 看過的頻道。來源是遊戲自己送的 `get_matching_channel`（順路記下來的，不另外
   * 發請求），再加上玩家目前所在的那一個。一次都沒看過頻道選單時可能缺頻道。
   *
   * | # | 名稱             | type   | crossplay |
   * |---|------------------|--------|-----------|
   * | 1 | 亞歷山卓城       | ranked | false     |
   * | 2 | 迪特赫姆         | duel   | false     |
   * | 3 | 峰亥盧遺跡       | ranked | true      |
   * | 4 | 布萊德克洛伊茲   | duel   | true      |
   */
  channels: Record<string, ChannelInfo> | null;
  /** 目前頻道是不是跨平台頻道。 */
  crossplay: boolean;
  /**
   * 目前頻道開房要多少 AP（頻道物件的 `required_ap.normal`）。讀不到是 `null`，
   * 那時退回 {@link duelApCost}。
   */
  requiredAp: RequiredAp | null;
  /** 目前選的牌組（1/2/3）。 */
  deckNow: number | null;
  /**
   * 目前牌組的 COST，**伺服器存的那個數字**（`registry.deck[].cost`）。
   *
   * ⚠ 客戶端從不自己算它。要判檔位、要顯示總和，一律自己用
   * `calculateTeamCost()` 算（`teamCostCenti()`），這一格只給診斷用。
   */
  deckCost: number | null;
  /**
   * 目前牌組的**規則鍵**，四種卡都有。讀不到牌組時整個是 `null`。
   *
   * 角色與怪物的鍵是 `CharaCards[].filename`；武器與事件卡是**改版前的索引**
   * 組出來的（`wp001`／`ev091`，規則檔一直是用那套寫的），新 id → 舊索引的對照
   * 由安裝時傳進來（見 {@link MatchRoomScriptOptions}）。
   *
   * ⚠ 這是**自己的**牌組。對手的牌組永遠不從這裡來。
   */
  deckKeys: DeckKeySet | null;
  /** 玩家顯示名稱。找自己開的房要用。 */
  playerName: string | null;
  /** 玩家已經有一間開著在等人的房（遊戲自己的 `room_wait`）。 */
  isMatching: boolean;
  /** Match 場景是不是 active。不是的話什麼都不能做。 */
  inMatch: boolean;
  /** 目前 AP。讀不到是 `null`（那時**不要**當成 0，見 {@link canAffordDuel}）。 */
  ap: number | null;
  /** AP 上限。只拿來顯示。 */
  apMax: number | null;
  /**
   * 剩幾顆免費對戰星星（0～3）。
   *
   * 遊戲畫面右下角那三顆 ★：黃的是還有的，灰的是用掉的（`duel_star` 的顏色
   * 就是照這個數字塗的）。**有星星時對戰不吃 AP**，打一場消一顆。
   */
  duelFree: number | null;
}

/**
 * 開一間對戰房要多少 AP —— **讀不到頻道物件時的退路**。
 *
 * 改版後頻道物件自己帶 `required_ap`（迪城實測 `normal: {single: 2, multi: 5}`），
 * 讀得到就用那個（{@link MatchContext.requiredAp}）。這張表是改版前從 bundle 讀的：
 *
 * | 頻道                       | 1vs1 | 3vs3 |
 * | -------------------------- | ---- | ---- |
 * | 一般（亞城／迪城）         | 2    | 5    |
 * | 跨平台（峰亥盧／布萊德）   | 2    | 4    |
 */
export function duelApCost(options: { multi: boolean; crossplay: boolean }): number {
  if (!options.multi) return 2;
  return options.crossplay ? 4 : 5;
}

/** {@link canAffordDuel} 的答案。 */
export type DuelAffordability =
  /** 打得起。`byStar` = 靠星星，不吃 AP。 */
  | { ok: true; byStar: boolean; cost: number }
  /** 打不起 —— AP 不夠而且沒有星星。 */
  | { ok: false; cost: number; ap: number };

/**
 * 這一場排不排得下去。**星星優先，AP 其次。**
 *
 * ```
 *   有星星（duelFree > 0）      → 打得起，而且不吃 AP
 *   沒星星但 AP 夠              → 打得起
 *   沒星星而且 AP 不夠          → ✗ 「AP不足」
 * ```
 *
 * ⚠⚠ **讀不到就當打得起。** `ap` 或 `duelFree` 是 `null` 代表我們沒問到
 * （玩家還沒進大廳、遊戲改版換了欄位）——「不知道」不是「不夠」。擋錯的代價是
 * 玩家完全排不了隊而且看不出原因，放行的代價只是退回原本的行為（伺服器自己會回
 * `NOT_ENOUGH_AP`）。這一條的方向不能反。
 */
export function canAffordDuel(options: {
  ap: number | null;
  duelFree: number | null;
  cost: number;
}): DuelAffordability {
  const { ap, duelFree, cost } = options;
  if (duelFree !== null && duelFree > 0) return { ok: true, byStar: true, cost };
  if (ap === null) return { ok: true, byStar: false, cost };
  if (ap >= cost) return { ok: true, byStar: false, cost };
  return { ok: false, cost, ap };
}

/**
 * 頻道編號 → 顯示名稱（`MatchUITexts.channel_info.channelN.name`）。
 *
 * ⚠ 只拿來**顯示**。判斷一律用編號與 `crossplay`，名稱換了不該影響行為。
 */
export const CHANNEL_NAMES: Readonly<Record<number, string>> = {
  1: "亞歷山卓城",
  2: "迪特赫姆",
  3: "峰亥盧遺跡",
  4: "布萊德克洛伊茲",
};

/**
 * 跨平台頻道（`channel_info` 的說明寫著「跨平台對戰專用頻道」的那兩個）。
 *
 * ⚠ 改版後頻道物件**沒有**分組的欄位了（以前是 `channels`／`channels_cross` 兩張表）。
 * 這張表只拿來決定「duel 頻道借哪一個 ranked 頻道的 COST 檔位」（{@link costTiersFor}）
 * 與 AP 的退路（{@link duelApCost}）。
 */
export const CROSSPLAY_CHANNELS: readonly number[] = [3, 4];

/**
 * 官方的「隨機」—— 送給遊戲的是 **999**（`MatchUITexts.room_config.stage.option`
 * 的最後一項）。插件內部一律寫成 3 位數字串，送出去之前才轉數字（{@link stageValue}）。
 *
 * ⚠ 改版前「隨機」是 `014`，而 014 現在是一張真的地圖（聖域的凱旋門）。
 */
export const RANDOM_STAGE_CODE = "999";

/**
 * 對戰地點。**照抄客戶端的 `MatchUITexts.room_config.stage.option`**（tcn，
 * 2026-09-27），不是自己編的。遊戲那邊的 `value` 是數字，這裡寫成 3 位數字串。
 *
 * ⚠ **`999` 才是「隨機」，`000` 是雷德貝魯格城。** 官方對話框畫面上預設顯示
 * 第一項，但下拉的 `value` 一開始是 `undefined`，要玩家點過才有值。
 */
export const STAGES: readonly { value: string; name: string }[] = [
  { value: "000", name: "雷德貝魯格城" },
  { value: "001", name: "誘惑森林" },
  { value: "002", name: "垃圾之街" },
  { value: "003", name: "冰封湖畔" },
  { value: "004", name: "人魂墓地" },
  { value: "005", name: "盡頭之村" },
  { value: "006", name: "風暴荒野" },
  { value: "007", name: "峰亥盧遺跡" },
  { value: "008", name: "魔都羅占布爾克" },
  { value: "009", name: "瘋狂山脈" },
  { value: RANDOM_STAGE_CODE, name: "隨機" },
];

/**
 * 隱藏地圖 —— 官方選單裡**沒有**，但客戶端認得的四張（**2026-09-23 改版後的代號**）。
 *
 * 2026-09-27 從跑著的客戶端逐一驗過：
 *
 * | 代號 | 背景 `Backgrounds/bgNNN.avif` | 房間縮圖 `MatchThumImages` | 畫面            |
 * | ---- | ----------------------------- | -------------------------- | --------------- |
 * | 010  | 沒有（載入器直接借 `bg000`）  | 沒有 `thum10`              | 雷德貝魯格城    |
 * | 011  | 760×680                       | `thum11`                   | 荒漠與岩柱      |
 * | 012  | 760×680                       | `thum12`                   | 霧中的湖與小船  |
 * | 013  | 760×680                       | `thum13`                   | 巨石陣          |
 * | 014  | 3040×2040 **動畫**            | `thum14`                   | 拱門長廊        |
 *
 * 010 只是雷德貝魯格城的另一個代號（背景載入器 `case "000": case "010":` 同一支），
 * 不算一張圖，所以不放。
 *
 * ⚠ 改版前這四張是 010〜013（動畫那張是 013），整段往後挪了一格。名稱是看圖對的：
 * 湖＝烏波斯的黑湖、巨石陣＝白魔的圓環石陣；另外兩張照「整段挪一格」對回舊表
 * （舊 010 魔女山谷 → 011、舊 013 動畫圖聖域的凱旋門 → 014）。舊表把黑湖與石陣
 * 對反了，而且那張表沒有出處 —— 找到官方譯名時以官方為準。
 *
 * ⚠ 還沒有在這四張上**打完一整場**，也還沒實測伺服器收不收這四個代號開房。
 */
export const HIDDEN_STAGES: readonly { value: string; name: string }[] = [
  { value: "011", name: "魔女山谷" },
  { value: "012", name: "烏波斯的黑湖" },
  { value: "013", name: "白魔的圓環石陣" },
  { value: "014", name: "聖域的凱旋門" },
];

/**
 * 「亞城隨機」抽的那幾張 —— 官方選單的 `000`~`009` **再加上 `011`**（魔女山谷）。
 *
 * 放進來是玩家指定的：自動配對要取代亞歷山卓城的快速比賽，而那邊的隨機池就是
 * 這十一張。改版前那一張的代號是 010，改版後是 011（見 {@link HIDDEN_STAGES}）。
 *
 * ⚠ **這一張還沒有在上面打完一整場。** 不想碰的人在配對頁選「官方隨機」，那條路
 * 只會開 {@link RANDOM_STAGE_CODE}。
 *
 * ⚠ 不含 `999`：那不是地圖，是「叫伺服器自己抽」。抽到它等於白抽一次。
 */
export const ARCADIA_STAGES: readonly string[] = [
  "000",
  "001",
  "002",
  "003",
  "004",
  "005",
  "006",
  "007",
  "008",
  "009",
  "011",
];

/**
 * 玩家在插件裡指得到名字的那幾張地圖 —— 官方選單的 `000`~`009` 加上隱藏的
 * `011`~`014`。
 *
 * ⚠ **不含 `999`**：那不是地圖，是「叫伺服器自己抽」。它在配對頁是另一個選項
 * （「官方隨機」），不是這串裡的一張。
 *
 * ⚠ 這是**型別的來源**（`StagePick` 的地圖那一半就是這個 union），所以代號寫在
 * 這裡一份。名字不重寫，一律去 {@link STAGES} / {@link HIDDEN_STAGES} 查 ——
 * 兩處各抄一份的話，改了一邊的譯名另一邊會安靜地留著舊的。
 */
export const STAGE_CODES = [
  "000",
  "001",
  "002",
  "003",
  "004",
  "005",
  "006",
  "007",
  "008",
  "009",
  "011",
  "012",
  "013",
  "014",
] as const;

/** 三位數的地點代號。`"999"`（隨機）**不在**裡面（見 {@link STAGE_CODES}）。 */
export type StageCode = (typeof STAGE_CODES)[number];

/** 這個字串是認得的地點代號嗎。⚠ 開房參數會用它，所以一律驗過再送。 */
export function isStageCode(value: unknown): value is StageCode {
  return typeof value === "string" && (STAGE_CODES as readonly string[]).includes(value);
}

/**
 * 3 位數字串 → 遊戲選單的 `value`（數字）。`"011"` → 11、`"999"` → 999。
 *
 * ⚠ 認不得的一律丟例外，不要送出去 —— 開房參數錯了伺服器只會回一個代碼。
 */
export function stageValue(code: string): number {
  if (!/^\d{3}$/.test(code))
    throw new Error(`地點代號必須是 3 位數字，收到 ${JSON.stringify(code)}`);
  return Number(code);
}

/**
 * 配對頁那個下拉選單的地圖那一段 —— 代號 + 名字。
 *
 * 名字是**查出來的**，不是這裡編的（見 {@link STAGE_CODES}）。查不到就退回
 * 代號本身 —— 少一個譯名不該讓整個選單少一張圖。
 */
export const SELECTABLE_STAGES: readonly { value: StageCode; name: string }[] = STAGE_CODES.map(
  (value) => ({
    value,
    name: [...STAGES, ...HIDDEN_STAGES].find((s) => s.value === value)?.name ?? value,
  }),
);

/**
 * 「牌組Cost限制」可以填的值（容差 ±N）。
 *
 * ⚠ 它是**容差**不是上限，而且伺服器用**原版 COST** 判。官方下拉的「±3」那一項
 * 送的值寫成了 5（客戶端的筆誤，2026-09-27 讀到的），插件不用這一格。
 */
export const COST_RANGES: readonly number[] = [0, 1, 2, 3, 4, 5];

/** 官方預設房名（`MatchUITexts.room_config.default_name`）。 */
export const DEFAULT_ROOM_NAME = "請多關照";

/**
 * 房名最多幾個字。
 *
 * ⚠ **這是插件自己的上限，不是實測出來的伺服器上限。** 依據是官方快速比賽
 * 開出來的房名 —— `Quickmatch [COST:57]` 剛好 20 個字，而那是遊戲自己產的，
 * 所以 20 一定塞得下。再長會不會被截、被拒，沒有驗過。
 */
export const ROOM_NAME_MAX_LENGTH = 20;

export interface ChannelInfo {
  /** `ranked` = 有 COST 檔位與快速比賽，`duel` = 一般約戰，`event` = 活動頻道。 */
  type: string;
  /**
   * COST 階層。**只有 ranked 頻道有**，其餘是 `null`。
   * duel 頻道要拿階層得走 {@link costTiersFor}。
   */
  cost: (number | null)[] | null;
  /** 跨平台頻道（見 {@link CROSSPLAY_CHANNELS}）。 */
  crossplay: boolean;
}

/**
 * 這個頻道的 COST 階層。**duel 頻道借用同一組（同為跨平台或同為一般）的 ranked 頻道。**
 *
 * 玩家給的規則（2026-08-16）：
 *
 * > 頻道二（迪特赫姆）的 COST 限制用亞歷山卓城（頻道一）的 COST，
 * > 頻道四（布萊德克洛伊茲）用峰亥盧遺跡（頻道三）的。**每週二遊戲更新時會跟著變。**
 *
 * ⚠ 1 與 3 的數字**真的不一樣**（改版前實測 `[57,66,78]` 與 `[56,69,71]`），拿錯組
 * 不會報錯只會配錯。
 *
 * ⚠ **每週二會變，所以不能烤進插件裡。** 這支只從客戶端當下送來的頻道清單讀。
 * 那一個 ranked 頻道沒看過（玩家這次還沒經過頻道選單）時回 `null`。
 */
export function costTiersFor(
  channels: Readonly<Record<string, ChannelInfo>> | null,
  channel: number | null,
): number[] | null {
  if (channels === null || channel === null) return null;
  const mine = channels[String(channel)];
  if (mine === undefined) return null;

  const tiers = (info: ChannelInfo): number[] | null => {
    if (info.cost === null || info.cost === undefined) return null;
    const clean = info.cost.filter((n): n is number => typeof n === "number");
    return clean.length > 0 ? clean : null;
  };

  const own = tiers(mine);
  if (own !== null) return own;

  // 自己沒有 → 找同一組的 ranked 頻道。
  for (const info of Object.values(channels)) {
    if (info.crossplay !== mine.crossplay) continue;
    const borrowed = tiers(info);
    if (borrowed !== null) return borrowed;
  }
  return null;
}

export interface CreateRoomOptions {
  name: string;
  /**
   * 對戰地點代號。**3 位數字串**（見 {@link STAGES}），不是地圖名稱。
   * 隨機是 {@link RANDOM_STAGE_CODE}。送出去之前轉成數字（{@link stageValue}）。
   */
  stage: string;
  friend: boolean;
  /** 房間密碼。約戰一律要有。 */
  pass: string;
  /**
   * 遊戲的「牌組 Cost 限制」—— **是容差不是上限**（「對手的牌組 COST 要在我的
   * ±N 之內」）。不限制傳 `null`。
   *
   * ⚠ 伺服器用**原版 COST** 判，跟自訂規則的總和對不上。
   *
   * ⚠ 3vs3 不在這裡：改版後的開房參數沒有那一格，伺服器看牌組張數決定。
   */
  cost: number | null;
}

export type CreateRoomResult =
  { ok: true; roomId: string | null } | { ok: false; reason: string; fail?: string };

export type JoinRoomResult = { ok: true } | { ok: false; reason: string; fail?: string };

/** {@link buildMatchRoomScript} 要的東西。 */
export interface MatchRoomScriptOptions {
  /**
   * 改版後的 `WeaponCards[].id` → 改版前的武器索引（規則鍵 `wpNNN` 的那個數字）。
   * 由呼叫端用 `@ulr/rule-schema` 的 `LEGACY_WEAPON_IDS` 反查出來（這個 package
   * 不依賴 rule-schema）。
   */
  weaponIndexById: Readonly<Record<string, number>>;
  /** 同上，事件卡（`evNNN`）。 */
  eventIndexById: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。 */
export const MATCH_ROOM_SCRIPT_VERSION = 9;

/**
 * 注入的腳本：在頁面上裝一組 `window.__ulrMatch` 的操作介面，並在遊戲的 socket
 * 類別上順路記下頻道清單。
 *
 * 用 `Runtime.evaluate` 裝就好，**不需要重載**。重裝一律整份換掉（這一版沒有掛
 * 任何會留下來的 listener，除了頻道清單那一個包裝 —— 它認得自己，不會包兩層）。
 *
 * ⚠ 每個函式都回傳 JSON 字串而不是物件：序列化失敗的錯誤沒有上下文，
 * 而這支要在真的對戰流程裡跑，出錯時必須看得懂。
 *
 * ⚠ 整支住在 template literal 裡：**不能出現反引號**，也不要寫反斜線（正規式
 * 裡的 \d 之類會被吃掉一層）。
 */
export function buildMatchRoomScript(options: MatchRoomScriptOptions): string {
  const config = {
    version: MATCH_ROOM_SCRIPT_VERSION,
    weaponIndex: options.weaponIndexById,
    eventIndex: options.eventIndexById,
    crossplay: CROSSPLAY_CHANNELS,
  };
  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = "__ulrMatch";
  var CHANNELS = "__ulrMatchChannels";

  function matchScene() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys.Match) || null;
  }

  /** Match 而且是 active 的（玩家人在對戰大廳）。對戰中 Match 是 sleep。 */
  function scene() {
    var sc = matchScene();
    return sc && sc.scene && sc.scene.isActive() ? sc : null;
  }

  // ---- 頻道清單 ------------------------------------------------------------
  //
  // 頻道物件只在頻道選單那一刻出現（get_matching_channel 的回應），進了頻道之後
  // 場景上只留玩家選的那一個。迪城要借亞城的 COST 檔位，所以得把整份記下來。
  //
  // ⚠ 搭遊戲自己送的那一次（包在 socket 類別的 fetch 上，只看回應、不改任何東西），
  // 不另外發請求。遊戲裡每個場景的 socket 都是同一個類別，所以開機時就包得到。

  function pickChannel(c) {
    var ap = c.required_ap && c.required_ap.normal;
    return {
      channel: c.channel,
      quick: c.quick === true,
      event: c.event === true,
      cost: c.cost && c.cost.length !== undefined ? Array.prototype.slice.call(c.cost) : null,
      requiredAp: ap && typeof ap.single === "number" && typeof ap.multi === "number"
        ? { single: ap.single, multi: ap.multi } : null
    };
  }

  function remember(c) {
    if (!c || typeof c.channel !== "number") return;
    if (!window[CHANNELS]) window[CHANNELS] = {};
    window[CHANNELS][String(c.channel)] = pickChannel(c);
  }

  function tapChannels() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    if (!keys) return false;
    for (var k in keys) {
      var so = keys[k] && keys[k].socket;
      if (!so || typeof so.fetch !== "function") continue;
      var P = Object.getPrototypeOf(so);
      if (!P || typeof P.fetch !== "function") continue;
      if (P.__ulrChannelTap) return true;
      var orig = P.fetch;
      P.fetch = function (ev) {
        var p = orig.apply(this, arguments);
        if (ev === "get_matching_channel" && p && typeof p.then === "function") {
          p.then(function (list) {
            try {
              if (list && list.length !== undefined) {
                for (var i = 0; i < list.length; i++) remember(list[i]);
              }
            } catch (e) {}
          }, function () {});
        }
        return p;
      };
      P.__ulrChannelTap = orig;
      return true;
    }
    return false;
  }

  function isCross(n) { return CFG.crossplay.indexOf(n) !== -1; }

  function channelTable() {
    var src = window[CHANNELS] || {};
    var out = {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var c = src[k];
      out[k] = {
        type: c.quick ? "ranked" : c.event ? "event" : "duel",
        cost: c.cost,
        crossplay: isCross(c.channel)
      };
    }
    return out;
  }

  // ---- 牌組 ----------------------------------------------------------------

  function currentDeck(sc) {
    var list = sc.deck || (window.game.registry && window.game.registry.get("deck"));
    if (!list || list.length === undefined) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].deck_id === sc.deck_now) return list[i];
    }
    return null;
  }

  function padIndex(i) {
    var s = String(i);
    while (s.length < 3) s = "0" + s;
    return s;
  }

  /**
   * 牌組的四種規則鍵。
   *
   * 角色（含怪物）：CharaCards 裡那張的 filename。武器／事件卡：改版後的 id 先換回
   * 改版前的索引（安裝時傳進來的對照），再組成 wpNNN／evNNN —— 規則檔一直是用
   * 那套寫的。
   *
   * ⚠ 查不到就給 null，不要用空字串頂替 —— 呼叫端要分得出「這格是空的」與
   * 「這格有卡但我讀不到它是誰」，後者算出來的 COST 會少一項。
   */
  function deckKeysOf(d) {
    if (!d || !d.chara_card_id || d.chara_card_id.length === undefined) return null;
    var cards = window.game.cache && window.game.cache.json && window.game.cache.json.get("CharaCards");
    if (!cards || cards.length === undefined) return null;
    var fileById = {};
    for (var n = 0; n < cards.length; n++) {
      if (cards[n] && typeof cards[n].id === "number") fileById[cards[n].id] = cards[n].filename;
    }

    var characters = [];
    for (var i = 0; i < d.chara_card_id.length; i++) {
      var id = d.chara_card_id[i];
      var f = typeof id === "number" ? fileById[id] : null;
      characters.push(typeof f === "string" && f !== "" ? f : null);
    }

    function keys(ids, table, prefix) {
      var out = [];
      var list = ids && ids.length !== undefined ? ids : [];
      for (var j = 0; j < list.length; j++) {
        var v = list[j];
        var idx = typeof v === "number" ? table[String(v)] : undefined;
        out.push(typeof idx === "number" ? prefix + padIndex(idx) : null);
      }
      return out;
    }

    return {
      characters: characters,
      equipment: keys(d.weapon_card_id, CFG.weaponIndex, "wp"),
      eventCards: keys(d.event_card_id, CFG.eventIndex, "ev")
    };
  }

  // ---- 房間清單 ------------------------------------------------------------

  function pickDeck(d) {
    if (!d || !d.chara_card_id) return null;
    return { charaCardId: Array.prototype.slice.call(d.chara_card_id), cost: d.cost };
  }

  // ⚠ 只挑需要的欄位。房間清單一筆就有兩份 avatar，整份搬回 Node 又大又全是
  // 跟我們無關的東西。
  function pickRoom(r) {
    return {
      roomId: r.room_id,
      name: r.room_name,
      playerAName: r.playerA_info ? r.playerA_info.player_name : null,
      playerBName: r.playerB_info ? r.playerB_info.player_name : null,
      pass: r.password === true,
      deckA: pickDeck(r.playerA_deck),
      deckB: pickDeck(r.playerB_deck)
    };
  }

  /** 玩家目前所在的頻道物件。沒進頻道是 null。 */
  function channelOf(sc) {
    return sc && sc.channel && typeof sc.channel.channel === "number" ? sc.channel : null;
  }

  /**
   * 對戰已經開始了嗎（有人進了我的房、或我進了別人的房）。
   *
   * 官方在兩條路上都會先設 player_side 再 launch MatchBoot，回到大廳時 wake()
   * 把它清回 null。對戰中 Match 是 sleep 的，房間清單也停止更新 —— 所以「房還在
   * 不在清單上」在那時候不能拿來判斷，要看這個。
   */
  function started(sc) {
    return !!(sc && sc.player_side !== null && sc.player_side !== undefined);
  }

  var state = { installed: true, version: CFG.version };
  window[FLAG] = state;
  tapChannels();

  state.context = function () {
    tapChannels();
    var sc = scene();
    if (sc === null) {
      return JSON.stringify({
        hasId: false, channel: null, channels: null, crossplay: false, requiredAp: null,
        deckNow: null, deckCost: null, deckKeys: null,
        playerName: null, isMatching: false, inMatch: false,
        ap: null, apMax: null, duelFree: null
      });
    }
    var ch = channelOf(sc);
    if (ch !== null) remember(ch);
    var picked = ch === null ? null : pickChannel(ch);
    var deck = currentDeck(sc);
    var ap = sc.player_ap;
    return JSON.stringify({
      hasId: typeof sc.player_id === "string" && sc.player_id.length > 0,
      channel: ch === null ? null : ch.channel,
      channels: channelTable(),
      crossplay: ch === null ? false : isCross(ch.channel),
      requiredAp: picked === null ? null : picked.requiredAp,
      deckNow: typeof sc.deck_now === "number" ? sc.deck_now : null,
      deckCost: deck && typeof deck.cost === "number" ? deck.cost : null,
      deckKeys: deckKeysOf(deck),
      playerName: sc.player && typeof sc.player.player_name === "string" ? sc.player.player_name : null,
      isMatching: sc.room_wait === true,
      inMatch: true,
      ap: ap && typeof ap.ap === "number" ? ap.ap : null,
      apMax: ap && typeof ap.ap_max === "number" ? ap.ap_max : null,
      // 免費對戰星星（0～3）。⚠ 有星星就不吃 AP，所以它是判斷「排不排得了」的另一半。
      duelFree: sc.player && typeof sc.player.duel_free === "number" ? sc.player.duel_free : null
    });
  };

  /**
   * 目前頻道的房間清單 —— **遊戲自己手上那份**（channel_room），大廳正在畫的就是它。
   *
   * live = 讀得到那一份（人在頻道裡、大廳是 active 的）。對戰中 Match 是 sleep，
   * 清單不再更新，那時 live 是 false，要看 started。
   */
  state.rooms_snapshot = function () {
    var any = matchScene();
    var st = started(any);
    var sc = scene();
    var list = sc && channelOf(sc) !== null && sc.channel_room && sc.channel_room.length !== undefined
      ? sc.channel_room : null;
    if (list === null) return JSON.stringify({ seq: 0, live: false, started: st, rooms: [] });
    var rooms = [];
    for (var i = 0; i < list.length; i++) if (list[i]) rooms.push(pickRoom(list[i]));
    return JSON.stringify({ seq: 0, live: true, started: st, rooms: rooms });
  };

  /**
   * 開房。照官方 create_panel() 按下 ok 之後那一段：送 create_room，拿到 room_id
   * 就 room_wait = true、room_select = id、跳等待視窗。
   *
   * ⚠ 等待視窗**一定要有**：有人進來時官方的 on_match_start() 會先 remove_match_wait()，
   * 那支假設視窗存在，沒有的話直接丟例外、對戰開不起來。大廳補丁排隊時已經開了
   * 同一個視窗的話就沿用。
   *
   * 失敗時伺服器回 null，代碼另外用 match_error 推（官方自己的 listener 會跳錯誤框，
   * 那是遊戲自己的話，留著）。我們另掛一個 once 把代碼接回來報給 Node。
   */
  state.create = function (optsJson) {
    var o = JSON.parse(optsJson);
    var sc = scene();
    if (sc === null) return Promise.resolve(JSON.stringify({ ok: false, reason: "不在對戰大廳" }));
    var ch = channelOf(sc);
    if (ch === null || !sc.socket_channel) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "還沒進頻道" }));
    }
    if (sc.room_wait === true) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "你已經有一間開著的房" }));
    }
    var so = sc.socket_channel;
    return new Promise(function (resolve) {
      var done = false;
      var code = null;
      function finish(v) { if (!done) { done = true; resolve(JSON.stringify(v)); } }
      try { so.once("match_error", function (c) { code = c; }); } catch (e) {}

      var R = {
        room_name: o.name,
        stage: o.stage,
        friend: o.friend === true,
        cost: typeof o.cost === "number" ? o.cost : null,
        password: o.pass,
        deck_id: sc.deck_now
      };
      var p;
      try { p = so.fetch("create_room", sc.deck_now, ch.channel, R); }
      catch (e) { finish({ ok: false, reason: String((e && e.message) || e) }); return; }

      Promise.resolve(p).then(function (id) {
        if (typeof id !== "string" || id.length === 0) {
          // 代碼可能比回應晚一拍到。
          setTimeout(function () {
            finish(code === null
              ? { ok: false, reason: "伺服器拒絕開房" }
              : { ok: false, reason: "伺服器拒絕開房", fail: String(code) });
          }, 300);
          return;
        }
        try {
          sc.room_wait = true;
          sc.room_select = id;
          // 等待中玩家點房間看牌組會改掉 room_select，收房要讀這一格（見 patch-lobby）。
          sc.__ulrWaitRoom = id;
          if (!sc.wait_zone) sc.create_match_wait();
        } catch (e) {}
        finish({ ok: true, roomId: id });
      }, function (e) {
        finish({ ok: false, reason: String((e && e.message) || e) });
      });
      setTimeout(function () { finish({ ok: false, reason: "等 create_room 回應逾時" }); }, 15000);
    });
  };

  /**
   * 進房。照官方房間詳細面板的進房鈕那一段：送 enter_room，拿到房間設定就
   * player_side、讀取畫面、launch MatchBoot。
   *
   * ⚠ 參數是**一包 JSON 字串**，進來第一件事就是 parse（embedJson 產的是 JSON 的
   * 字面值，設計上就是要 parse 一次）。
   */
  state.join = function (payloadJson) {
    var p = JSON.parse(payloadJson);
    var sc = scene();
    if (sc === null) return Promise.resolve(JSON.stringify({ ok: false, reason: "不在對戰大廳" }));
    if (channelOf(sc) === null || !sc.socket_channel) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "還沒進頻道" }));
    }
    var list = sc.channel_room && sc.channel_room.length !== undefined ? sc.channel_room : [];
    var entry = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].room_id === p.roomId) { entry = list[i]; break; }
    }
    if (entry === null) {
      return Promise.resolve(JSON.stringify({ ok: false, reason: "房間清單裡沒有這個 room_id" }));
    }

    var so = sc.socket_channel;
    return new Promise(function (resolve) {
      var done = false;
      var code = null;
      function finish(v) { if (!done) { done = true; resolve(JSON.stringify(v)); } }
      try { so.once("match_error", function (c) { code = c; }); } catch (e) {}

      sc.input.enabled = false;
      sc.room_wait = true;
      var pass = entry.password === true ? p.pass : null;
      var q;
      try { q = so.fetch("enter_room", entry.room_id, sc.deck_now, pass); }
      catch (e) {
        sc.room_wait = false;
        sc.input.enabled = true;
        finish({ ok: false, reason: String((e && e.message) || e) });
        return;
      }

      Promise.resolve(q).then(function (a) {
        if (a === null || typeof a !== "object") {
          sc.room_wait = false;
          sc.input.enabled = true;
          setTimeout(function () {
            finish(code === null
              ? { ok: false, reason: "進房被拒" }
              : { ok: false, reason: "進房被拒", fail: String(code) });
          }, 300);
          return;
        }
        try {
          sc.player_side = a.player_side;
          // 大廳補丁排隊時開的等待視窗 —— 官方進房那條路沒有它，要自己收。
          if (sc.wait_zone) sc.remove_match_wait();
          sc.create_match_loading();
          sc.scene.launch("MatchBoot", {
            is_tutorial: false, host: a.domain, port: a.port,
            room_config: a, player_side: a.player_side
          });
        } catch (e) {
          finish({ ok: false, reason: "進房之後開不了對戰：" + String((e && e.message) || e) });
          return;
        }
        finish({ ok: true });
      }, function (e) {
        sc.room_wait = false;
        sc.input.enabled = true;
        finish({ ok: false, reason: String((e && e.message) || e) });
      });
      setTimeout(function () { finish({ ok: false, reason: "等 enter_room 回應逾時" }); }, 25000);
    });
  };

  /**
   * 收掉自己開著的那一間房（遊戲的 room_select）。照官方等待視窗的 Cancel 那一段。
   *
   * ⚠ 收的是**那一間**（cancel_room 吃 room_id），不是整個頻道。
   *
   * ⚠ 優先讀 __ulrWaitRoom：等待中玩家可以點房間看牌組（patch-lobby），點了
   * room_select 就變成那一間，拿它去收會收錯房。
   */
  state.cancel = function () {
    var sc = matchScene();
    if (sc === null) return Promise.resolve("不在對戰大廳");
    if (!sc.socket_channel) return Promise.resolve("沒有頻道連線");
    var id = typeof sc.__ulrWaitRoom === "string" ? sc.__ulrWaitRoom : sc.room_select;
    if (sc.room_wait !== true || typeof id !== "string") return Promise.resolve("沒有開著的房");
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      function tidy() {
        sc.room_wait = false;
        sc.room_select = null;
        sc.__ulrWaitRoom = null;
        try { if (sc.room_detail) { sc.room_detail.destroy(); sc.room_detail = null; } } catch (e) {}
        try { if (sc.wait_zone) sc.remove_match_wait(); } catch (e) {}
      }
      try {
        Promise.resolve(sc.socket_channel.fetch("cancel_room", id)).then(function () {
          tidy();
          finish("ok");
        }, function (e) { finish(String((e && e.message) || e)); });
      } catch (e) { finish(String((e && e.message) || e)); }
      setTimeout(function () { finish("等 cancel_room 回應逾時"); }, 8000);
    });
  };

  return "installed:" + CFG.version;
})()`;
}

/**
 * 拆掉。頻道清單那一層包裝也還原（它掛在遊戲的 socket 類別上）。
 * 記下來的頻道清單留著 —— 那只是資料，重裝時還用得到。
 */
export const MATCH_ROOM_UNINSTALL_EXPRESSION = `(function () {
  try {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    if (keys) {
      for (var k in keys) {
        var so = keys[k] && keys[k].socket;
        var P = so && Object.getPrototypeOf(so);
        if (P && P.__ulrChannelTap) { P.fetch = P.__ulrChannelTap; delete P.__ulrChannelTap; break; }
      }
    }
    delete window.__ulrMatch;
    return "ok";
  } catch (e) { return String(e); }
})()`;

// ---------------------------------------------------------------------------

/**
 * 產生「開房」的呼叫。參數走 `embedJson`，永遠不會被當程式碼執行（§12）。
 * 地點在這裡轉成遊戲要的數字。
 */
export function buildCreateRoomExpression(options: CreateRoomOptions): string {
  const payload = {
    name: options.name,
    stage: stageValue(options.stage),
    friend: options.friend,
    pass: options.pass,
    cost: options.cost,
  };
  return `window.__ulrMatch.create(${embedJson(payload)})`;
}

/**
 * 產生「進房」的呼叫。
 *
 * ⚠ 一定要包成**一包 JSON** 傳，不要拆成兩個字串參數。`embedJson` 產出的是
 * 「JSON 的 JS 字面值」，頁面端不 parse 就會拿到多一對引號的值。
 */
export function buildJoinRoomExpression(roomId: string, pass: string): string {
  return `window.__ulrMatch.join(${embedJson({ roomId, pass })})`;
}

/**
 * 從房間清單裡找出「我自己開的那一間」。
 *
 * 改版後開房直接回 room_id，這支只剩「回應沒帶 id」時的退路。
 *
 * ⚠ 靠房主名稱比對，不是靠房名 —— 房名是玩家自訂的，撞名就會拿到別人的 roomId
 * 然後把對手送進陌生人的房間。
 *
 * ⚠ **房名不能拿來當識別碼的另一個理由**：房名會出現在公開清單上，而我們
 * 唯一能用來識別的祕密是 token —— 那是密碼，貼上去就等於沒有密碼。
 */
export function findOwnRoom(
  rooms: readonly RoomEntry[],
  playerName: string,
  expectedName?: string,
): RoomEntry | null {
  let mine = rooms.filter((r) => r.playerAName === playerName);

  // ⚠ 指定了房名就**只認那個名字**，找不到一律回 null。退讓的預設值在這裡是危險的：
  // 清單還沒更新時會挑到玩家的舊房，把上一場的 room_id 交出去。
  if (expectedName !== undefined) {
    mine = mine.filter((r) => r.name === expectedName);
  }
  const empty = mine.filter((r) => r.playerBName === null);
  if (empty.length > 0) mine = empty;

  // 還是分不出來就回 null。猜錯會把對手送進別的房間，寧可讓呼叫端再等一輪。
  return mine.length === 1 ? (mine[0] ?? null) : null;
}
