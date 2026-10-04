/**
 * 首頁立繪：多張、可移動、縮放、旋轉、翻轉
 * ========================================
 * 玩家 2026-10-02：「可以做編輯首頁立繪功能嗎？然後能再增加首頁立繪嗎？Library
 * 可以自訂最愛，希望可以標更多最愛角色，讓首頁能出現更多立繪。每個立繪圖片都能
 * 縮放、轉角度。目前這位已經太靠左超出螢幕，想要能夠編輯。」
 *
 * ## 官方怎麼畫（2026-10-02 讀的原始碼與實機）
 *
 * ```
 *   Lobby.loader   r = player.chara_favorite ?? Deck1 第一格的角色
 *                  檔名 o = r；最愛且是 cc001/003/010/041/046/048 → r_res0；
 *                  cc039 → cc039_{1|2|3} 隨機；cc028 → cc028_ent
 *                  atlas "standchara" ← images/assets/CharaCards/opening/{o}.avif + .json
 *   Lobby.create   stand_chara = add.image(-190, 412, "standchara", r).setAlpha(0)
 *                  setMask(矩形 0,160,760,496 的 GeometryMask)
 *                  tween → x 310、alpha 1、700ms Power1
 *   Library        Characters 分頁每列一顆 library_deco（frame 0 空、1 hover、2 已選）
 *                  點了只改 sc.chara_favorite（單選）；按返回才送
 *                  update_chara_favorite(sc.chara_favorite) 給伺服器
 * ```
 *
 * 圖集是 TexturePacker 的 multiatlas JSON（`textures[0].frames`），一張圖一格，
 * **格名是檔名**（`cc001_res0`），而且裁過透明邊（原畫布 760×680）。
 * ⚠ 官方用角色鍵當格名去取，`_res0` 那幾個角色會取不到、退回 `__BASE`（整張圖
 * 置中）—— 這是官方的行為，我們不改它那張的貼圖。
 *
 * ## 套組（2026-10-03 加的）
 *
 * 玩家：「最愛角色群組，每次進入大廳時隨機使用其中一套，每一套可以用多個登場
 * 角色，可以新增刪減群組」「真正的最愛角色可以一直用同一隻但隱藏，不必使用官方
 * 的，避免一直對伺服器發出請求」。
 *
 * - 每次進首頁（Lobby.create）從**有角色的**那幾套隨機挑一套，不連續挑同一套
 * - 官方那張（伺服器上的最愛）不在這套裡就藏起來；整套空的 = 照官方，只畫那張
 * - 套組在首頁編輯模式的第二排管：[Prev] Set 2/3 [Next] [New] [Del]（玩家選的位置）。
 *   換套、新增、刪除都是草稿，按 OK 才存
 * - 大廳元件所有套共用一份（玩家選的）
 *
 * ## 點立繪說話（2026-10-03 加的）
 *
 * 首頁（非編輯模式）左鍵點到立繪不透明的地方：跳出對戰開場那個 `hukidashi` 對話框，
 * 說一句台詞。台詞表不在客戶端（對戰開場是伺服器開房時才送 room_config.dialogue），
 * 是從原版開源資料產的 lobby-dialogue-data.ts（tools/build-lobby-dialogue.mjs）。
 *
 * - 說什麼（玩家選的）：自己的一般開場台詞＋對「同台角色」的專屬台詞；有招式語音的
 *   再加四招，字幕是招式名（遊戲 Feats 的 name_{lang}）—— 招式語音本身沒有文字
 * - 語音：遊戲快取的 `voice`（= CharaVoice.json）有 `{角色}_dialogue{台詞id}`／
 *   `{角色}_skill{n}` 就播 `images/assets/Voice/{角色}/{檔名}`。官方只在有稀有卡時播，
 *   **玩家選了不看稀有卡**；音量照遊戲的 volume_voice，0 就只出字幕
 *
 * ## Library：同一顆愛心改成可複選
 *
 * 玩家選的（2026-10-02）：不另加標記，官方那顆愛心直接變複選。改的是首頁上次畫的
 * 那一套；改完回首頁先畫這一套（`st.stick`），不然點完愛心回去看到的是別套。
 *
 * - **不動 `sc.chara_favorite`**：官方最愛固定一隻。官方按返回本來就每次都送
 *   `update_chara_favorite`（連同 `update_stamp_favorite`，2026-10-03 讀的原始碼），
 *   送的永遠是同一隻，不多送任何請求。
 * - 換掉的是每顆愛心的 pointerup（官方那支會把別列的愛心清掉）；hover 那兩支留著
 *   （它們只在 frame 不是 2 時換圖，複選也對）。
 *
 * ## 首頁：多張立繪＋編輯模式
 *
 * 這一套裡除了官方那張以外的角色，各自用同一套檔名規則（當作最愛）抓圖、加成
 * Image，跟官方那張共用同一個遮罩、同一層（lobby_bg 正上方，所有按鈕下面）。
 *
 * **旋轉與縮放的中心是人物可見部分的中心**（照裁切資料算 origin），不是 760×680
 * 畫布的中心 —— 不然一轉人就甩出去了。擺法 `(x, y)` 也是這個點的座標。
 *
 * **翻轉用負的 scaleX，不用 flipX。** Phaser 的 flipX 是把整張 760×680 畫布左右翻、
 * origin 還留在原來的數值（3.87 的 batchSprite：x += -realWidth + 2 * displayOriginX），
 * origin 不在 0.5 時人會整個跳到別處 —— 第一版這樣把人甩出畫面，點中判斷也對不上
 * （2026-10-03 小號實機）。負的 scaleX 是繞 origin 鏡像，人留在原地。
 *
 * 人物中心只能擺在遮罩範圍內（0..760 × 160..656），所以至少露一角、一定點得到；
 * 存過的擺法超出範圍也會在套用時拉回來。
 *
 * 進入編輯：**首頁空白處按右鍵**（玩家選的：不加新按鈕）。編輯中：
 *
 * ```
 *   左鍵拖曳     移動（點了只選，不改圖層）
 *   滾輪         縮放      Shift＋滾輪   旋轉
 *   右鍵點立繪   左右翻轉
 *   [Reset]     選中的那張回預設；沒選就全部
 *   [Front]     選中的那張移到最上層      [Back]  移到最下層
 *   [OK]        存檔、離開編輯（套組、立繪與大廳元件一起存）
 *   [UI]        切到編輯大廳元件（見下面）
 *   [Prev] [Next]  換編輯另一套      [New]  新增一套空的      [Del]  刪掉這套
 * ```
 *
 * ## 大廳元件（2026-10-03 加的）
 *
 * 玩家：「想隱藏 Tutorial、縮小 duel quest、編輯大小姐（頭像）位置、縮小或隱藏
 * 排行榜獎勵那堆字、把中間三個過大的圓形按鈕搬去右上」。編輯模式多一顆 [UI]
 * 切過去（再按 [Chara] 切回立繪）：
 *
 * ```
 *   左鍵拖曳     移動整組      滾輪   縮放（繞那組官方外框的中心）
 *   右鍵         隱藏／叫回來（藏起來的組編輯時半透明，點得到）
 *   [Reset]     選中的那組回官方原樣；沒選就全部
 * ```
 *
 * 分組名單是 {@link LOBBY_UI_GROUPS}。存的是相對官方位置的位移，不是絕對座標。
 * 套用在每一幀的 postupdate（理由見 applyUi 上面的註解）；藏起來的元件 visible
 * false —— Phaser 的 inputCandidate 會先看 willRender，所以也點不到了。
 *
 * 編輯立繪時把大廳其他東西全部藏起來（只留 lobby_bg 與立繪），結束時只還原自己藏的；
 * 編輯中官方又畫出來的，輪詢時一樣藏。再蓋一層全畫面的 zone（depth 190）擋住點擊；
 * 點中哪張靠自己算（反轉換＋讀那一點的 alpha，透明的地方點不中），立繪本身不設
 * interactive。按鈕是官方的 btn_gene ＋ font_heavy 12 黑字（照開發者選單那排的寫法）；
 * 字一律英文（見 docs：中文面板也顯示英文）。
 *
 * ⚠ Shift＋滾輪在 Windows 的 Chromium 會變成橫向捲動（deltaY 0、deltaX 有值），
 * 所以兩個方向取有值的那個。
 *
 * ## 貼圖怎麼載
 *
 * 官方的 UL_LOADER 是 fetch 成 blob 再交給 Phaser（跨網域的圖不能直接進 WebGL），
 * 我們照做：fetch JSON 與 avif → blob URL → Image → `textures.addAtlas`。貼圖鍵
 * `ulrStand_{角色}`，載過就留著（下次回首頁不必再抓）。只碰 CDN，不送遊戲伺服器。
 *
 * ## 存在哪
 *
 * 頁面只回報，真相在托盤的牌組庫（`DeckLibrary.lobbyStand`，跟牌組一起上雲）：
 * `{ type: "lobby-stand-sets", sets, ui? }`，每次都是整份（ui 只有按 OK 時帶）。
 * 牌組庫沒接上（`ready: false`）時整支什麼都不做 —— 首頁與 Library 完全是官方的。
 *
 * ## 長命的場景
 *
 * Lobby、Library 的場景實例是長命的，而且是**懶載的**（還在標題畫面時不存在），
 * 所以包方法放在輪詢裡、看到實例才包，拆的時候照 `st.wraps` 還原。「掛過了沒」
 * 記在 GameObject 上（`__ulrStand`），不記在場景上。
 *
 * ⚠⚠ **注入腳本裡的註解不能有反引號，也不要寫反斜線。** 整段腳本住在一個
 * template literal 裡。
 */

import { embedJson } from "./embed.js";
import {
  LOBBY_DIALOGUE_CHARAS,
  LOBBY_DIALOGUE_LANGS,
  LOBBY_DIALOGUE_LINES,
} from "./lobby-dialogue-data.js";

const FLAG = "__ulrLobbyStand";

/** 腳本版本。**改動注入腳本裡任何一行就 +1**，修 bug 也算。先拆再裝。 */
export const LOBBY_STAND_SCRIPT_VERSION = 10;

export const DEFAULT_LOBBY_STAND_POLL_MS = 250;

/** 一套最多標幾個（跟 `@ulr/deck-library` 的 `LOBBY_STAND_MAX` 同一個數）。 */
export const LOBBY_STAND_LIMIT = 20;

/** 最多幾套（跟 `@ulr/deck-library` 的 `LOBBY_STAND_SETS_MAX` 同一個數）。 */
export const LOBBY_STAND_SETS_LIMIT = 10;

const LAYOUT_LIMIT = 200;

/** 一張立繪在首頁的擺法。`(x, y)` 是人物可見部分的中心在畫布上的位置。 */
export interface LobbyStandLayout {
  x: number;
  y: number;
  scale: number;
  angle: number;
  flip: boolean;
  z: number;
}

/** 一組大廳元件的改法。`(x, y)` 是相對官方位置的位移，縮放繞那組官方外框的中心。 */
export interface LobbyUiLayout {
  x: number;
  y: number;
  scale: number;
  hidden: boolean;
}

/** 一套登場角色。 */
export interface LobbyStandSet {
  /** 角色鍵，照加入順序。空的 = 這一套照官方（顯示伺服器上的最愛）。 */
  charas: string[];
  layout: Record<string, LobbyStandLayout>;
}

/** Node 推給頁面的狀態。 */
export interface LobbyStandState {
  /** 牌組庫接上了沒。`false` 時整支不動任何東西。 */
  ready: boolean;
  /** 至少一套；每次進首頁隨機挑一套有角色的。 */
  sets: LobbyStandSet[];
  /** 組名 → 改法。沒列到的組照官方。所有套共用。 */
  ui: Record<string, LobbyUiLayout>;
}

export type LobbyStandReport =
  | {
      /** 整份套組（Library 點愛心、首頁編輯按 OK）。 */
      type: "lobby-stand-sets";
      sets: LobbyStandSet[];
      /** 整份（沒列到的組 = 改回官方）。只有按 OK 時送。 */
      ui?: Record<string, LobbyUiLayout>;
    }
  | { type: "lobby-stand-error"; message: string };

/**
 * 大廳元件怎麼分組（2026-10-03 從跑著的客戶端讀的 Lobby 顯示清單）。一組一起
 * 移動、縮放、隱藏。怎麼認出一個物件屬於哪組：
 *
 * - `names`：場景上的屬性名（`sc.btn_duel_base`）
 * - `arrays`：場景上的陣列屬性，元素是物件（`sc.rank_bp_info[i]`）
 * - `records`：場景上的陣列屬性，元素是「欄位是物件」的紀錄
 *   （`sc.ranking_view[i].number`；refresh_ranking 每次換頁都整批重建）
 * - `textures`：貼圖鍵（排行榜底圖、頭像零件沒掛在場景屬性上）
 * - `types`：物件型別（TUTORIAL 右上的紅點是唯一的 Arc）
 *
 * **順序就是比對順序**，先對到的組算數。
 * 底下 Name／Gem／Exp 那條的底圖不在 Lobby 場景裡，字搬走會跟底圖分家，所以不列。
 */
export const LOBBY_UI_GROUPS = [
  { key: "shop", names: ["btn_shop"] },
  { key: "darkroom", names: ["btn_lot"] },
  { key: "deck", names: ["btn_edit"] },
  { key: "item", names: ["btn_item"] },
  { key: "library", names: ["btn_library"] },
  { key: "duel", names: ["btn_duel_base", "btn_duel_icon"] },
  { key: "quest", names: ["btn_quest"] },
  { key: "raid", names: ["btn_raid_base", "btn_raid_icon"] },
  { key: "option", names: ["btn_option"] },
  { key: "tutorial", names: ["btn_tutorial"], types: ["Arc"] },
  { key: "serial", names: ["btn_serial"] },
  {
    key: "ranking",
    names: [
      "ranking_crown",
      "bp_total",
      "qp_total",
      "ranking_prev",
      "ranking_next",
      "player_rank",
      "player_point",
      "rank_time",
    ],
    textures: ["ranking_base"],
    records: ["ranking_view"],
  },
  { key: "notice", arrays: ["rank_bp_info", "rank_qp_info"] },
  { key: "avatar", textures: ["AvatarPartsImages"] },
  { key: "icons", names: ["icon_item", "icon_friend", "icon_achievement", "icon_info"] },
  {
    key: "ap",
    names: [
      "ap_base_image",
      "ap_fill_image",
      "ap_over_image",
      "ap_slash",
      "ap_value_text",
      "ap_max_text",
      "ap_next_text",
    ],
    arrays: ["duel_star"],
  },
  { key: "boost", records: ["player_boost_images"] },
] as const;

const CHARA_KEY = /^cc\d{3}$/;
const UI_KEY = /^[a-z]{2,16}$/;
const UI_LIMIT = 32;

function isUiLayout(v: unknown): v is LobbyUiLayout {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    ["x", "y", "scale"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k])) &&
    typeof o.hidden === "boolean"
  );
}

function isLayout(v: unknown): v is LobbyStandLayout {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    ["x", "y", "scale", "angle", "z"].every(
      (k) => typeof o[k] === "number" && Number.isFinite(o[k]),
    ) && typeof o.flip === "boolean"
  );
}

function isSet(v: unknown): v is LobbyStandSet {
  if (typeof v !== "object" || v === null) return false;
  const s = v as { charas?: unknown; layout?: unknown };
  if (
    !Array.isArray(s.charas) ||
    s.charas.length > LOBBY_STAND_LIMIT ||
    !s.charas.every((c) => typeof c === "string" && CHARA_KEY.test(c))
  ) {
    return false;
  }
  if (typeof s.layout !== "object" || s.layout === null || Array.isArray(s.layout)) return false;
  // 擺法不跟著角色刪（取消再加回來還在），所以可以比 charas 多；上限只擋灌爆
  const entries = Object.entries(s.layout as Record<string, unknown>);
  return (
    entries.length <= LAYOUT_LIMIT && entries.every(([k, l]) => CHARA_KEY.test(k) && isLayout(l))
  );
}

export function isLobbyStandReport(value: unknown): value is LobbyStandReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; sets?: unknown; ui?: unknown; message?: unknown };
  if (v.type === "lobby-stand-sets") {
    if (!Array.isArray(v.sets) || v.sets.length > LOBBY_STAND_SETS_LIMIT) return false;
    if (!v.sets.every((s) => isSet(s))) return false;
    if (v.ui === undefined) return true;
    if (typeof v.ui !== "object" || v.ui === null || Array.isArray(v.ui)) return false;
    const ui = Object.entries(v.ui as Record<string, unknown>);
    return ui.length <= UI_LIMIT && ui.every(([k, l]) => UI_KEY.test(k) && isUiLayout(l));
  }
  if (v.type === "lobby-stand-error") return typeof v.message === "string";
  return false;
}

export interface LobbyStandStatus {
  installed: boolean;
  version: number | null;
  /** 首頁上接管了幾張立繪（含官方那張）。0 = 不在首頁或還沒接管。 */
  stands: number;
  editing: boolean;
  reason: string | null;
}

/** 點立繪說的台詞表（形狀同 lobby-dialogue-data.ts）。 */
export interface LobbyDialogueTable {
  langs: readonly string[];
  lines: Record<string, readonly string[]>;
  charas: Record<string, { general: readonly number[]; vs: Record<string, readonly number[]> }>;
}

export interface LobbyStandPatchOptions {
  bindingName: string;
  state: LobbyStandState;
  pollIntervalMs?: number;
  /** 預設是內建的那份（原版開源資料產的）；測試用小的。 */
  dialogue?: LobbyDialogueTable;
}

/** 編輯模式的版面與文案。字照官方開發者選單那排（btn_gene 80×25）。 */
const UI = {
  /** 編輯時沒選中的立繪調暗到多少，看得出選的是哪一張。 */
  dim: 0.55,
  depth: 190,
  /**
   * 各排的高度，照模式分：
   * - 編輯立繪：頂端選單列藏起來了，放在那塊黑色區域（y 30..160，立繪遮罩從 160
   *   開始，擋不到人物）—— 玩家 2026-10-03 要的
   * - 編輯大廳元件：選單列要看得到、要能點，放回黑色標題帶下面；沒有套組那排，
   *   說明字緊接在第一排下面
   */
  rows: {
    chara: { btn: 42, set: 72, hint: 104 },
    ui: { btn: 166, set: 196, hint: 196 },
  },
  resetX: 8,
  okX: 260,
  /** 第二排：[Prev] Set 2/3 [Next] [New] [Del] —— 切換、新增、刪除套組。 */
  prevX: 8,
  setLabelX: 132,
  nextX: 176,
  newX: 260,
  delX: 344,
  prev: "Prev",
  next: "Next",
  add: "New",
  del: "Del",
  setLabel: "Set ",
  reset: "Reset",
  ok: "OK",
  frontX: 92,
  backX: 176,
  front: "Front",
  back: "Back",
  /** 切換「編輯立繪／編輯大廳元件」。字是按下去會切到哪一邊。 */
  modeX: 344,
  toUi: "UI",
  toChara: "Chara",
  hint: "Wheel: Size   Shift+Wheel: Turn   Right-click: Flip",
  uiHint: "Drag: Move   Wheel: Size   Right-click: Hide",
  /** 大廳元件：隱藏的組在編輯時半透明顯示（點得到才能叫回來）。 */
  uiHiddenAlpha: 0.3,
  uiScaleMin: 0.3,
  uiScaleMax: 2,
  uiOffsetMax: 800,
  /** 每隔幾幀重新認一次「不屬於任何組」的物件（有些屬性是建好物件之後才掛上場景的）。 */
  reclassifyFrames: 30,
  scaleStep: 1.05,
  angleStep: 3,
  scaleMin: 0.2,
  scaleMax: 3,
  /** 人物中心只能擺在遮罩範圍內（官方 0,160,760,496），至少露一角、點得到。 */
  areaX0: 0,
  areaX1: 760,
  areaY0: 160,
  areaY1: 656,
  /** 官方那張的落點與進場位移（add.image(-190, …) tween 到 310）。 */
  homeX: 310,
  homeY: 412,
  slide: 500,
  slideMs: 700,
};

/**
 * 點立繪說話（2026-10-03 加的）。對話框照對戰開場那套（2026-10-03 讀的原始碼）：
 * `hukidashi` 圖、font_heavy 18 黑字、字一個一個出來（每字 50ms）；日文有換行時拆兩行。
 */
const SPEECH = {
  /** UL_ASSETS.game.image 裡的路徑（相對資產根）。 */
  bubbleUrl: "images/assets/Game/hukidashi.avif",
  voiceDir: "images/assets/Voice/",
  /** 對話框在大廳元件上面、編輯模式的擋板（190）下面。 */
  depth: 180,
  font: { fontFamily: "font_heavy", fontSize: 18, color: "black", resolution: 2 },
  /** 字從對話框左右各留多少（照對戰：左 32、右 18）。 */
  padLeft: 32,
  padRight: 18,
  /** 第一行字中心離對話框頂多遠（對戰是 44）；兩行時上下各偏 lineGap/2。 */
  textY: 44,
  lineGap: 22,
  charMs: 50,
  /** 沒語音時字打完後停多久；有語音時語音放完後再停多久。 */
  holdMs: 2200,
  afterVoiceMs: 900,
  fadeMs: 300,
  /** 對話框離人物頭頂多遠。 */
  headGap: 4,
  /** 尾巴尖在對話框寬的哪裡（從左算）。 */
  tailX: 0.7,
};

/** 官方 Lobby.loader 的檔名規則（2026-10-02 讀的）。 */
const VARIANT = {
  res0: ["cc001", "cc003", "cc010", "cc041", "cc046", "cc048"],
  random: { cc039: [1, 2, 3] } as Record<string, number[]>,
  ent: ["cc028"],
};

/** 首頁常駐的腳本。重複注入會先拆舊的。 */
export function buildLobbyStandPatchScript(options: LobbyStandPatchOptions): string {
  const config = {
    version: LOBBY_STAND_SCRIPT_VERSION,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_LOBBY_STAND_POLL_MS,
    state: options.state,
    max: LOBBY_STAND_LIMIT,
    setsMax: LOBBY_STAND_SETS_LIMIT,
    ui: UI,
    variant: VARIANT,
    groups: LOBBY_UI_GROUPS,
    dialogue: options.dialogue ?? {
      langs: LOBBY_DIALOGUE_LANGS,
      lines: LOBBY_DIALOGUE_LINES,
      charas: LOBBY_DIALOGUE_CHARAS,
    },
    speech: SPEECH,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var U = CFG.ui;
  var FLAG = ${JSON.stringify(FLAG)};
  var TEX_PREFIX = "ulrStand_";
  var OPENING = "images/assets/CharaCards/opening/";
  /** Library 一頁幾列（官方寫死 20）。 */
  var LIB_PAGE = 20;

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  function fail(where, e) {
    var msg = where + ": " + String((e && e.message) || e);
    var st = window[FLAG];
    if (st) st.reason = msg;
    report({ type: "lobby-stand-error", message: msg });
  }

  function alive(o) { return !!(o && o.scene); }

  function sceneOf(key) {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    return (keys && keys[key]) || null;
  }

  function activeScene(key) {
    var sc = sceneOf(key);
    return sc && sc.scene && sc.scene.isActive() ? sc : null;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function isKey(c) {
    return typeof c === "string" && c.length === 5 && c.indexOf("cc") === 0 &&
      !isNaN(Number(c.slice(2)));
  }

  // -------------------------------------------------------------------------
  // 貼圖
  // -------------------------------------------------------------------------

  function variantName(chara) {
    var V = CFG.variant;
    if (V.ent.indexOf(chara) !== -1) return chara + "_ent";
    var frames = V.random[chara];
    if (frames) return chara + "_" + frames[Math.floor(Math.random() * frames.length)];
    if (V.res0.indexOf(chara) !== -1) return chara + "_res0";
    return chara;
  }

  function firstFrame(tex) {
    var names = tex.getFrameNames();
    return names.length > 0 ? names[0] : "__BASE";
  }

  function getOk(r) {
    if (!r.ok) throw new Error("HTTP " + r.status + " " + r.url);
    return r;
  }

  /** 抓一個角色的立繪，回 Promise(格名)。載過就直接回。 */
  function loadStand(st, sc, chara) {
    var T = window.game.textures;
    var key = TEX_PREFIX + chara;
    if (T.exists(key)) return Promise.resolve(firstFrame(T.get(key)));
    if (st.loading[key]) return st.loading[key];
    var url = String(sc.load.baseURL || "") + OPENING + variantName(chara);
    var p = Promise.all([
      fetch(url + ".json").then(getOk).then(function (r) { return r.json(); }),
      fetch(url + ".avif").then(getOk).then(function (r) { return r.blob(); })
    ]).then(function (res) {
      return new Promise(function (ok, no) {
        var img = new Image();
        img.onload = function () { ok([res[0], img]); };
        img.onerror = function () { no(new Error("圖解不開 " + url)); };
        img.src = URL.createObjectURL(res[1]);
      });
    }).then(function (r) {
      var data = r[0] && Array.isArray(r[0].textures) ? r[0].textures[0] : r[0];
      if (!T.exists(key)) T.addAtlas(key, r[1], data);
      delete st.loading[key];
      return firstFrame(T.get(key));
    }, function (e) {
      delete st.loading[key];
      throw e;
    });
    st.loading[key] = p;
    return p;
  }

  // -------------------------------------------------------------------------
  // 擺法
  // -------------------------------------------------------------------------

  /** 畫面上那一格在 760×680 畫布裡的可見範圍。沒裁過就是整張。 */
  function frameBox(img) {
    var f = img.frame;
    var d = f.data || {};
    var s = d.trim && d.spriteSourceSize ? d.spriteSourceSize : null;
    return {
      rw: f.realWidth, rh: f.realHeight,
      sx: s ? s.x : 0, sy: s ? s.y : 0,
      w: s ? s.w : f.realWidth, h: s ? s.h : f.realHeight
    };
  }

  /** origin 移到人物可見部分的中心：旋轉縮放都繞著它。 */
  function centerOrigin(img) {
    var b = frameBox(img);
    img.setOrigin((b.sx + b.w / 2) / b.rw, (b.sy + b.h / 2) / b.rh);
  }

  /** 官方那張原本的位置（畫布中心在 (310, 412)），換算成可見部分中心。 */
  function officialDefault(img) {
    var b = frameBox(img);
    return {
      x: Math.round(U.homeX - b.rw / 2 + b.sx + b.w / 2),
      y: Math.round(U.homeY - b.rh / 2 + b.sy + b.h / 2),
      scale: 1, angle: 0, flip: false, z: 0
    };
  }

  /** 多出來的第 k 張（1 起）沒存過擺法時：往右排開，疊在官方那張上面。 */
  function extraDefault(k) {
    return { x: 160 + ((120 * k) % 480), y: 440, scale: 1, angle: 0, flip: false, z: k };
  }

  // -------------------------------------------------------------------------
  // 套組：st.state.sets 是存著的，st.cur 是現在畫的那套；編輯中改的是草稿
  // （lb.edit.sets／lb.edit.cur），按 OK 才寫回
  // -------------------------------------------------------------------------

  function clampIdx(i, n) { return i < 0 || n <= 0 ? 0 : i >= n ? n - 1 : i; }

  function setsOf(st) {
    var lb = st.lobby;
    return lb && lb.edit ? lb.edit.sets : st.state.sets;
  }

  function curSet(st) {
    var lb = st.lobby;
    var sets = setsOf(st);
    var i = lb && lb.edit ? lb.edit.cur : st.cur;
    return sets[clampIdx(i, sets.length)] || { charas: [], layout: {} };
  }

  /** 這一套要畫哪些角色。空的那套照官方：只畫伺服器上的最愛那張。 */
  function shown(st, lb) {
    var c = curSet(st).charas.filter(isKey).slice(0, CFG.max);
    return c.length > 0 ? c : [lb.items[0].chara];
  }

  /**
   * 進首頁時挑一套：有角色的那幾套隨機挑、不連續同一套；剛在 Library 改過的那套
   * 先給它看一次（不然點完愛心回來看到的是別套）。
   */
  function pickSet(st) {
    var sets = st.state.sets;
    if (st.stick) { st.stick = false; st.cur = clampIdx(st.cur, sets.length); return; }
    var pool = [];
    for (var i = 0; i < sets.length; i++) if (sets[i].charas.length > 0) pool.push(i);
    if (pool.length > 1) pool = pool.filter(function (k) { return k !== st.cur; });
    st.cur = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : clampIdx(st.cur, sets.length);
  }

  function savedOr(st, item) {
    var L = curSet(st).layout[item.chara];
    return L || item.def;
  }

  function clampX(x) { return clamp(Math.round(x), U.areaX0, U.areaX1); }
  function clampY(y) { return clamp(Math.round(y), U.areaY0, U.areaY1); }

  /** 翻轉用負的 scaleX，不用 flipX（見檔頭）。 */
  function setSize(img, size, flip) {
    img.setScale(flip ? -size : size, size);
  }

  function applyLayout(item, L) {
    item.img.setPosition(clampX(L.x), clampY(L.y));
    item.img.setFlipX(false);
    setSize(item.img, L.scale, !!L.flip);
    item.img.setAngle(L.angle);
    item.z = L.z;
  }

  function readLayout(item) {
    var img = item.img;
    return {
      x: Math.round(img.x),
      y: Math.round(img.y),
      scale: Math.round(Math.abs(img.scaleX) * 1000) / 1000,
      angle: Math.round(img.angle * 10) / 10,
      flip: img.scaleX < 0,
      z: item.z
    };
  }

  /** 立繪照 z 排在 lobby_bg 正上方（同 depth 0，照顯示清單的順序畫）。 */
  function reorder(lb) {
    var sc = lb.scene;
    var list = sc.children && sc.children.list;
    if (!list) return;
    var items = lb.items.filter(function (it) { return alive(it.img); });
    items.sort(function (a, b) { return a.z - b.z || a.order - b.order; });
    for (var i = 0; i < items.length; i++) {
      var at = list.indexOf(items[i].img);
      if (at !== -1) list.splice(at, 1);
    }
    var base = alive(sc.lobby_bg) ? list.indexOf(sc.lobby_bg) + 1 : 0;
    for (var j = 0; j < items.length; j++) list.splice(base + j, 0, items[j].img);
  }

  /** 翻轉過的（臉朝左）從右邊滑進來。 */
  function slideIn(lb, item) {
    var img = item.img;
    var x = img.x;
    img.x = img.scaleX < 0 ? x + U.slide : x - U.slide;
    img.setAlpha(0);
    lb.scene.tweens.add({ targets: img, x: x, alpha: 1, duration: U.slideMs, ease: "Power1" });
  }

  // -------------------------------------------------------------------------
  // 首頁
  // -------------------------------------------------------------------------

  function mountLobby(st, sc, fresh) {
    var off = sc.stand_chara;
    if (!alive(off) || off.__ulrStand) return;
    off.__ulrStand = true;
    if (st.lobby) unmountLobby(st, false);
    var lb = { scene: sc, items: [], pending: {}, edit: null, sel: null,
      pivots: {}, members: {}, frame: 0, post: null };
    if (fresh) pickSet(st); else st.cur = clampIdx(st.cur, st.state.sets.length);
    st.lobby = lb;
    mountUi(st, lb);
    try { sc.tweens.killTweensOf(off); } catch (e) {}
    var item = { chara: String(sc.lobby_chara), img: off, official: true, def: null, order: 0, z: 0 };
    item.def = officialDefault(off);
    centerOrigin(off);
    lb.items.push(item);
    applyLayout(item, savedOr(st, item));
    if (fresh) slideIn(lb, item); else off.setAlpha(1);
    reorder(lb);
    hookRightClick(st, sc);
    syncExtras(st, lb);
  }

  /**
   * 照現在這套補上／拿掉立繪。官方那張（伺服器上的最愛）不在這套裡就藏起來 ——
   * 玩家要的：官方最愛固定一隻不動，免得每換一套就對伺服器送一次。
   */
  function syncExtras(st, lb) {
    var sc = lb.scene;
    var official = lb.items[0];
    var list = shown(st, lb);
    var want = list.filter(function (c) { return c !== official.chara; });
    official.img.setVisible(list.indexOf(official.chara) !== -1);
    lb.items = lb.items.filter(function (it) {
      if (it.official || want.indexOf(it.chara) !== -1) return true;
      if (lb.sel === it) lb.sel = null;
      try { it.img.destroy(); } catch (e) {}
      return false;
    });
    // 換套之後順序與預設位置跟著這一套
    lb.items.forEach(function (it) {
      var k = want.indexOf(it.chara);
      if (k !== -1) { it.order = k + 1; it.def = extraDefault(k + 1); }
    });
    want.forEach(function (c, k) {
      var has = lb.items.some(function (it) { return it.chara === c; });
      if (has || lb.pending[c]) return;
      lb.pending[c] = true;
      loadStand(st, sc, c).then(function (frame) {
        delete lb.pending[c];
        if (st.lobby !== lb || window[FLAG] !== st || !alive(lb.items[0].img)) return;
        k = shown(st, lb).filter(function (x) { return x !== official.chara; }).indexOf(c);
        if (k === -1) return;
        if (lb.items.some(function (it) { return it.chara === c; })) return;
        var img = sc.add.image(0, 0, TEX_PREFIX + c, frame).setDepth(0);
        var mask = lb.items[0].img.mask;
        if (mask) img.setMask(mask);
        centerOrigin(img);
        var item = { chara: c, img: img, official: false, def: extraDefault(k + 1), order: k + 1, z: 0 };
        lb.items.push(item);
        applyLayout(item, savedOr(st, item));
        // 第一次要從網路抓，晚官方那張一點到：一樣滑進來
        if (lb.edit) dimOthers(lb);
        else slideIn(lb, item);
        reorder(lb);
      }, function (e) {
        delete lb.pending[c];
        fail("立繪 " + c, e);
      });
    });
  }

  /** 拿掉多出來的、官方那張放回原位。 */
  function unmountLobby(st, restore) {
    var lb = st.lobby;
    if (!lb) return;
    st.lobby = null;
    stopSpeech(lb);
    exitEdit(st, lb);
    unmountUi(lb);
    for (var i = 0; i < lb.items.length; i++) {
      var it = lb.items[i];
      if (!alive(it.img)) continue;
      if (!it.official) { try { it.img.destroy(); } catch (e) {} continue; }
      if (!restore) continue;
      try { lb.scene.tweens.killTweensOf(it.img); } catch (e) {}
      it.img.setOrigin(0.5, 0.5).setPosition(U.homeX, U.homeY).setScale(1).setAngle(0)
        .setFlipX(false).setAlpha(1).setVisible(true);
      it.img.__ulrStand = false;
    }
  }

  // -------------------------------------------------------------------------
  // 大廳元件（按鈕、排行榜、公告、頭像…）
  //
  // 每一幀（場景的 postupdate，官方 update 跑完、畫面畫出來之前）把每個組員擺到
  // 「官方位置 + 位移、繞組中心縮放」。官方自己改了某個值（refresh_ranking 切
  // 公告的 visible、AP 圖示換透明度…）怎麼認：跟上一幀我們寫進去的不一樣 = 官方
  // 動的，那就是新的官方值。這樣不必知道官方哪裡會動它。
  // -------------------------------------------------------------------------

  var UI_ID = { x: 0, y: 0, scale: 1, hidden: false };

  function hasGo(v, o) {
    if (v === o) return true;
    if (!v || typeof v !== "object" || v.type) return false;
    for (var k in v) if (v[k] === o) return true;
    return false;
  }

  /** 這個物件屬於哪組；都不是回 null。 */
  function classify(sc, o) {
    var G = CFG.groups;
    for (var i = 0; i < G.length; i++) {
      var g = G[i], j;
      if (g.names) for (j = 0; j < g.names.length; j++) if (sc[g.names[j]] === o) return g.key;
      if (g.arrays) for (j = 0; j < g.arrays.length; j++) {
        var a = sc[g.arrays[j]];
        if (Array.isArray(a) && a.indexOf(o) !== -1) return g.key;
      }
      if (g.records) for (j = 0; j < g.records.length; j++) {
        var r = sc[g.records[j]];
        if (Array.isArray(r) && r.some(function (e) { return hasGo(e, o); })) return g.key;
      }
      if (g.textures && o.texture && g.textures.indexOf(o.texture.key) !== -1) return g.key;
      if (g.types && g.types.indexOf(o.type) !== -1) return g.key;
    }
    return null;
  }

  function uiOf(st, lb, key) {
    var src = lb.edit ? lb.edit.ui : st.state.ui;
    return src[key] || UI_ID;
  }

  /** 組中心：第一次看到這組時、官方原樣的外框中心。之後固定。 */
  function pivotOf(lb, key, list) {
    var p = lb.pivots[key];
    if (p) return p;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < list.length; i++) {
      try {
        var b = list[i].getBounds();
        if (b.x < x0) x0 = b.x;
        if (b.y < y0) y0 = b.y;
        if (b.right > x1) x1 = b.right;
        if (b.bottom > y1) y1 = b.bottom;
      } catch (e) {}
    }
    if (x0 === Infinity) return null;
    p = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    lb.pivots[key] = p;
    return p;
  }

  function applyUi(st, lb) {
    var sc = lb.scene;
    var list = sc.children && sc.children.list;
    if (!list) return;
    lb.frame++;
    var again = lb.frame % U.reclassifyFrames === 0;
    var members = {};
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || o.__ulrStandUi) continue;
      var g = o.__ulrUiG;
      if (g === undefined || (g === null && again)) { g = classify(sc, o); o.__ulrUiG = g; }
      if (!g) continue;
      (members[g] || (members[g] = [])).push(o);
    }
    lb.members = members;
    var ed = lb.edit;
    var editUi = !!(ed && ed.mode === "ui");
    var editChara = !!(ed && ed.mode !== "ui");
    for (var key in members) {
      var mem = members[key];
      var p = pivotOf(lb, key, mem);
      if (!p) continue;
      var L = uiOf(st, lb, key);
      var s = L.scale;
      for (var k = 0; k < mem.length; k++) {
        var m = mem[k];
        var r = m.__ulrUiR;
        if (!r) {
          r = m.__ulrUiR = { bx: m.x, by: m.y, bsx: m.scaleX, bsy: m.scaleY, bv: m.visible, ba: m.alpha };
        } else {
          if (m.x !== r.ax) r.bx = m.x;
          if (m.y !== r.ay) r.by = m.y;
          if (m.scaleX !== r.asx) r.bsx = m.scaleX;
          if (m.scaleY !== r.asy) r.bsy = m.scaleY;
          if (m.visible !== r.av) r.bv = m.visible;
          if (m.alpha !== r.aa) r.ba = m.alpha;
        }
        var a = r.ba;
        if (editUi && L.hidden) a = r.ba * U.uiHiddenAlpha;
        else if (editUi && ed.uiSel && ed.uiSel !== key) a = r.ba * U.dim;
        m.x = p.x + (r.bx - p.x) * s + L.x;
        m.y = p.y + (r.by - p.y) * s + L.y;
        m.scaleX = r.bsx * s;
        m.scaleY = r.bsy * s;
        m.visible = editChara ? false : L.hidden && !editUi ? false : r.bv;
        m.alpha = a;
        r.ax = m.x; r.ay = m.y; r.asx = m.scaleX; r.asy = m.scaleY; r.av = m.visible; r.aa = m.alpha;
      }
    }
  }

  function mountUi(st, lb) {
    var sc = lb.scene;
    lb.post = function () {
      if (st.lobby !== lb) return;
      try { applyUi(st, lb); } catch (e) { fail("大廳元件", e); }
    };
    sc.events.on("postupdate", lb.post);
    lb.post();
  }

  /** 放回官方原樣（還活著的才放）。 */
  function unmountUi(lb) {
    var sc = lb.scene;
    if (lb.post) { try { sc.events.off("postupdate", lb.post); } catch (e) {} lb.post = null; }
    var list = (sc.children && sc.children.list) || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m) continue;
      var r = m.__ulrUiR;
      if (r) {
        if (m.x === r.ax) m.x = r.bx;
        if (m.y === r.ay) m.y = r.by;
        if (m.scaleX === r.asx) m.scaleX = r.bsx;
        if (m.scaleY === r.asy) m.scaleY = r.bsy;
        if (m.visible === r.av) m.visible = r.bv;
        if (m.alpha === r.aa) m.alpha = r.ba;
      }
      delete m.__ulrUiR;
      delete m.__ulrUiG;
    }
  }

  /** 編輯大廳元件時，那一點的組。重疊時取外框最小的（大面板裡的小按鈕點得到）。 */
  function pickUi(lb, x, y) {
    var best = null, area = Infinity;
    for (var key in lb.members) {
      var mem = lb.members[key];
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < mem.length; i++) {
        if (!mem[i].visible) continue;
        try {
          var b = mem[i].getBounds();
          if (b.x < x0) x0 = b.x;
          if (b.y < y0) y0 = b.y;
          if (b.right > x1) x1 = b.right;
          if (b.bottom > y1) y1 = b.bottom;
        } catch (e) {}
      }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      var a = (x1 - x0) * (y1 - y0);
      if (a < area) { area = a; best = key; }
    }
    return best;
  }

  function draftOf(ed, key) {
    var L = ed.ui[key];
    if (!L) { L = { x: 0, y: 0, scale: 1, hidden: false }; ed.ui[key] = L; }
    return L;
  }

  /** 跟官方一模一樣的組不送。 */
  function uiChanged(ui) {
    var out = {};
    for (var k in ui) {
      var L = ui[k];
      if (L.x !== 0 || L.y !== 0 || L.scale !== 1 || L.hidden) {
        out[k] = { x: Math.round(L.x), y: Math.round(L.y), scale: Math.round(L.scale * 1000) / 1000, hidden: !!L.hidden };
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 點立繪說話
  //
  // 台詞：這個角色的一般開場台詞＋對「同台的角色」說的那幾句（玩家選的），有招式
  // 語音的再加四招（字幕是招式名，從遊戲自己的 Feats 讀，跟著遊戲語言）。
  // 語音：CharaVoice 有那一句就播（玩家選的：不看有沒有稀有卡），音量照遊戲的
  // volume_voice，0 就不播。音檔與對話框圖都只碰 CDN，不送遊戲伺服器。
  // -------------------------------------------------------------------------

  var SP = CFG.speech;
  var BUBBLE_KEY = "ulrStandBubble";

  function assetBase(sc) { return String((sc.load && sc.load.baseURL) || ""); }

  /** 對話框圖：fetch 成 blob 再進貼圖（跨網域的圖不能直接進 WebGL）。載過就留著。 */
  function loadBubble(st, sc) {
    var T = window.game.textures;
    if (T.exists(BUBBLE_KEY)) return Promise.resolve(true);
    if (st.bubbleLoading) return st.bubbleLoading;
    st.bubbleLoading = fetch(assetBase(sc) + SP.bubbleUrl).then(getOk).then(function (r) { return r.blob(); })
      .then(function (blob) {
        return new Promise(function (ok, no) {
          var img = new Image();
          img.onload = function () { if (!T.exists(BUBBLE_KEY)) T.addImage(BUBBLE_KEY, img); ok(true); };
          img.onerror = function () { no(new Error("對話框圖解不開")); };
          img.src = URL.createObjectURL(blob);
        });
      }).then(function (v) { st.bubbleLoading = null; return v; }, function (e) {
        st.bubbleLoading = null;
        throw e;
      });
    return st.bubbleLoading;
  }

  function lineText(id) {
    var D = CFG.dialogue;
    var row = D.lines[String(id)];
    if (!row) return "";
    var at = D.langs.indexOf(String(window.lang));
    return (at !== -1 && row[at]) || row[D.langs.indexOf("tcn")] || row[0] || "";
  }

  function voiceOf(chara, name) {
    var V = window.game.cache.json.get("voice");
    var list = V && V[chara];
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i].voice === chara + "_" + name) return list[i].data;
    return null;
  }

  function skillName(chara, n) {
    var F = window.game.cache.json.get("Feats");
    if (!Array.isArray(F)) return "";
    var eff = chara + "_sk0" + n;
    for (var i = 0; i < F.length; i++) {
      var f = F[i];
      if (f && f.effect_image === eff) return String(f["name_" + window.lang] || f.name_tcn || f.name_ja || "");
    }
    return "";
  }

  /** 這個角色現在能說的話：{ text, voice }。 */
  function linesFor(lb, chara) {
    var out = [];
    var D = CFG.dialogue.charas[chara];
    function add(ids) {
      for (var i = 0; i < ids.length; i++) {
        var t = lineText(ids[i]);
        if (t) out.push({ key: "d" + ids[i], text: t, voice: voiceOf(chara, "dialogue" + ids[i]) });
      }
    }
    if (D) {
      add(D.general || []);
      for (var j = 0; j < lb.items.length; j++) {
        var it = lb.items[j];
        if (it.chara === chara || !alive(it.img) || !it.img.visible) continue;
        if (D.vs && D.vs[it.chara]) add(D.vs[it.chara]);
      }
    }
    for (var n = 1; n <= 4; n++) {
      var v = voiceOf(chara, "skill" + n);
      var name = v && skillName(chara, n);
      if (name) out.push({ key: "s" + n, text: name, voice: v });
    }
    return out;
  }

  /** 照對戰：有換行就拆兩行；單行太長就從最靠中間的標點（沒有就正中間）拆。 */
  function splitLines(sc, text, maxW) {
    var NL = String.fromCharCode(10);
    if (text.indexOf(NL) !== -1) return text.split(NL).slice(0, 2);
    var probe = sc.add.text(0, 0, text, SP.font).setVisible(false);
    var w = probe.width;
    probe.destroy();
    if (w <= maxW || text.length < 4) return [text];
    var mid = Math.floor(text.length / 2), best = -1;
    // 最後一個是全形空白（直接寫在原始碼裡 lint 會擋）
    var marks = "，、。！？…．,!? " + String.fromCharCode(0x3000);
    for (var i = 1; i < text.length - 1; i++) {
      if (marks.indexOf(text.charAt(i)) === -1) continue;
      if (best === -1 || Math.abs(i + 1 - mid) < Math.abs(best - mid)) best = i + 1;
    }
    var cut = best > 0 && Math.abs(best - mid) <= text.length / 4 ? best : mid;
    return [text.slice(0, cut), text.slice(cut)];
  }

  function stopSpeech(lb) {
    var s = lb && lb.speech;
    if (!s) return;
    lb.speech = null;
    if (s.timer) { try { s.timer.remove(false); } catch (e) {} }
    if (s.audio) { try { s.audio.pause(); } catch (e) {} }
    for (var i = 0; i < s.parts.length; i++) {
      var p = s.parts[i];
      try { lb.scene.tweens.killTweensOf(p); } catch (e) {}
      try { p.destroy(); } catch (e) {}
    }
  }

  /** 對話框擺在人物頭頂（可見部分的上緣），夾在畫面裡。 */
  function bubbleAt(item, w, h) {
    var img = item.img;
    var b = frameBox(img);
    var top = img.y - (b.h / 2) * Math.abs(img.scaleY);
    // 尾巴尖對準人物（尾巴在圖寬約 7 成處，2026-10-03 截圖量的）。靠邊被夾住時尾巴
    // 會偏掉，所以翻與不翻都算，取尾巴離人物近的那個
    function place(flip) {
      var tail = w * (flip ? 1 - SP.tailX : SP.tailX);
      var x = clamp(Math.round(img.x - tail), 4, 756 - w);
      return { x: x, flip: flip, miss: Math.abs(x + tail - img.x) };
    }
    var a = place(false), f = place(true);
    var best = f.miss < a.miss ? f : a;
    var y = clamp(Math.round(top - h - SP.headGap), 4, 676 - h);
    return { x: best.x, y: y, flip: best.flip };
  }

  function speak(st, lb, item) {
    var sc = lb.scene;
    var all = linesFor(lb, item.chara);
    if (all.length === 0) return;
    // 不連說同一句
    var pool = all.length > 1 ? all.filter(function (l) { return l.key !== lb.lastLine; }) : all;
    var line = pool[Math.floor(Math.random() * pool.length)];
    lb.lastLine = line.key;
    stopSpeech(lb);
    var s = { parts: [], timer: null, audio: null };
    lb.speech = s;
    loadBubble(st, sc).then(function () {
      if (lb.speech !== s || st.lobby !== lb) return;
      showBubble(lb, item, line, s);
    }, function (e) { fail("對話框", e); });
  }

  function showBubble(lb, item, line, s) {
    var sc = lb.scene;
    var bg = sc.add.image(0, 0, BUBBLE_KEY).setOrigin(0, 0).setDepth(SP.depth).setAlpha(0);
    bg.__ulrStandUi = true;
    s.parts.push(bg);
    var at = bubbleAt(item, bg.width, bg.height);
    bg.setPosition(at.x, at.y).setFlipX(at.flip);
    var rows = splitLines(sc, line.text, bg.width - SP.padLeft - SP.padRight);
    var texts = rows.map(function (r, i) {
      var y = at.y + SP.textY + (rows.length === 2 ? (i === 0 ? -SP.lineGap / 2 : SP.lineGap / 2) : 0);
      var t = sc.add.text(at.x + SP.padLeft, y, "", SP.font).setOrigin(0, 0.5).setDepth(SP.depth);
      t.__ulrStandUi = true;
      s.parts.push(t);
      return t;
    });
    // 單行時置中（照對戰）
    if (rows.length === 1) {
      var probe = sc.add.text(0, 0, rows[0], SP.font).setVisible(false);
      texts[0].x = Math.round(at.x + (bg.width - probe.width) / 2);
      probe.destroy();
    }
    sc.tweens.add({ targets: bg, alpha: 1, duration: 200, ease: "Power3" });

    var vol = Number(window.volume_voice);
    var muted = window.game.sound && window.game.sound.mute;
    var voiceDone = !line.voice || !(vol > 0) || muted;
    if (!voiceDone) {
      try {
        var a = new Audio(assetBase(sc) + SP.voiceDir + item.chara + "/" + line.voice);
        a.volume = Math.min(1, vol);
        s.audio = a;
        a.addEventListener("ended", function () { if (lb.speech === s) { voiceDone = true; maybeEnd(); } });
        a.addEventListener("error", function () { if (lb.speech === s) { s.audio = null; voiceDone = true; maybeEnd(); } });
        a.play().catch(function () { s.audio = null; voiceDone = true; maybeEnd(); });
      } catch (e) { s.audio = null; voiceDone = true; }
    }

    // 字一個一個出來
    var total = rows.join("").length, shown = 0, typed = false;
    s.timer = sc.time.addEvent({
      delay: SP.charMs,
      repeat: total - 1,
      callback: function () {
        if (lb.speech !== s) return;
        shown++;
        var left = shown;
        for (var i = 0; i < rows.length; i++) {
          var n = Math.max(0, Math.min(rows[i].length, left));
          texts[i].setText(rows[i].slice(0, n));
          left -= rows[i].length;
        }
        if (shown >= total) { typed = true; maybeEnd(); }
      }
    });

    var ending = false;
    function maybeEnd() {
      if (ending || lb.speech !== s || !typed || !voiceDone) return;
      ending = true;
      var wait = line.voice && s.audio ? SP.afterVoiceMs : SP.holdMs;
      sc.time.delayedCall(wait, function () {
        if (lb.speech !== s) return;
        sc.tweens.add({
          targets: s.parts, alpha: 0, duration: SP.fadeMs,
          onComplete: function () { if (lb.speech === s) stopSpeech(lb); }
        });
      });
    }
  }

  /**
   * 首頁的點擊：右鍵空白處 → 編輯；左鍵點到立繪（不透明的地方）→ 說話。
   * listener 掛在場景的 InputPlugin 上（它跟場景一樣長命）。點到按鈕（over 有東西）都不管。
   */
  function hookRightClick(st, sc) {
    unhookRightClick(st);
    var fn = function (pointer, over) {
      var lb = st.lobby;
      if (!lb || lb.scene !== sc || lb.edit || !st.state.ready) return;
      if (over && over.length > 0) return;
      if (sc.input.enabled === false) return;
      if (!pointer.rightButtonDown()) {
        var hit = pick(lb, pointer.worldX, pointer.worldY);
        if (hit) speak(st, lb, hit);
        return;
      }
      stopSpeech(lb);
      enterEdit(st, lb);
    };
    sc.input.on("pointerdown", fn);
    st.rc = { input: sc.input, fn: fn };
  }

  function unhookRightClick(st) {
    if (!st.rc) return;
    try { st.rc.input.off("pointerdown", st.rc.fn); } catch (e) {}
    st.rc = null;
  }

  // -------------------------------------------------------------------------
  // 編輯模式
  // -------------------------------------------------------------------------

  var probe = null;

  /** 那一點有沒有畫到東西（讀來源圖的 alpha）。讀不到就當有。 */
  function opaqueAt(img, fx, fy) {
    try {
      var f = img.frame;
      var src = f.source && f.source.image;
      if (!src) return true;
      if (!probe) {
        probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
      }
      var ctx = probe.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.drawImage(src, f.cutX + fx, f.cutY + fy, 1, 1, 0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3] > 24;
    } catch (e) {
      return true;
    }
  }

  /** 世界座標那一點最上面的那張立繪。翻轉是負的 scaleX，除下去就鏡回來了。 */
  function pick(lb, x, y) {
    var items = lb.items.filter(function (it) { return alive(it.img) && it.img.visible; });
    items.sort(function (a, b) { return b.z - a.z || b.order - a.order; });
    for (var i = 0; i < items.length; i++) {
      var img = items[i].img;
      var dx = x - img.x;
      var dy = y - img.y;
      var r = -img.rotation;
      var c = Math.cos(r);
      var s = Math.sin(r);
      var ux = (dx * c - dy * s) / img.scaleX;
      var uy = (dx * s + dy * c) / img.scaleY;
      var b = frameBox(img);
      var fx = Math.floor(ux + img.displayOriginX - b.sx);
      var fy = Math.floor(uy + img.displayOriginY - b.sy);
      if (fx < 0 || fy < 0 || fx >= b.w || fy >= b.h) continue;
      if (opaqueAt(img, fx, fy)) return items[i];
    }
    return null;
  }

  function dimOthers(lb) {
    for (var i = 0; i < lb.items.length; i++) {
      var it = lb.items[i];
      if (alive(it.img)) it.img.setAlpha(lb.sel === null || lb.sel === it ? 1 : U.dim);
    }
  }

  function select(lb, it) {
    lb.sel = it;
    dimOthers(lb);
  }

  function toFront(lb, it) {
    var top = 0;
    for (var i = 0; i < lb.items.length; i++) {
      if (lb.items[i] !== it && lb.items[i].z >= top) top = lb.items[i].z + 1;
    }
    if (it.z < top) it.z = top;
    reorder(lb);
  }

  function toBack(lb, it) {
    var bottom = 0;
    for (var i = 0; i < lb.items.length; i++) {
      if (lb.items[i] !== it && lb.items[i].z <= bottom) bottom = lb.items[i].z - 1;
    }
    if (it.z > bottom) it.z = bottom;
    reorder(lb);
  }

  /**
   * 編輯立繪時把大廳其他東西藏起來，結束時只還原自己藏的。有分組的那些由
   * applyUi 藏（它記著官方的 visible），這裡只管沒分組的（底下狀態列的字…）。
   */
  function hideLobbyUi(lb) {
    var ed = lb.edit;
    var sc = lb.scene;
    var list = sc.children && sc.children.list;
    if (!ed || ed.mode === "ui" || !list) return;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || !o.visible || o === sc.lobby_bg || o.__ulrStandUi || o.__ulrUiG) continue;
      if (lb.items.some(function (it) { return it.img === o; })) continue;
      o.setVisible(false);
      ed.hidden.push(o);
    }
  }

  function showLobbyUi(ed) {
    for (var i = 0; i < ed.hidden.length; i++) {
      var o = ed.hidden[i];
      if (alive(o) && !o.visible) o.setVisible(true);
    }
    ed.hidden = [];
  }

  /** row：哪一排（"btn"／"set"），高度照模式由 placeEdit 擺。 */
  function makeButton(sc, x, row, label, onUp) {
    var b = sc.add.image(x, U.rows.chara[row], "btn_gene", 0).setOrigin(0, 0).setDepth(U.depth + 1)
      .setInteractive();
    var t = sc.add.text(b.x + b.width / 2, b.y + b.height / 2, label, {
      fontFamily: "font_heavy", fontSize: 12, color: "black", resolution: 2
    }).setOrigin(0.5, 0.5).setDepth(U.depth + 1);
    b.__ulrRow = row;
    t.__ulrRow = row;
    t.__ulrDy = b.height / 2;
    b.on("pointerover", function () { b.setTexture("btn_gene", 1); });
    b.on("pointerout", function () { b.setTexture("btn_gene", 0); });
    b.on("pointerdown", function () { b.setTexture("btn_gene", 0); });
    b.on("pointerup", function (pointer) {
      if (pointer && pointer.rightButtonReleased && pointer.rightButtonReleased()) return;
      onUp();
    });
    b.__ulrStandUi = true;
    t.__ulrStandUi = true;
    return [b, t];
  }

  /** 照模式把編輯用的按鈕、套組標籤、說明字擺到該在的那一排。 */
  function placeEdit(ed) {
    var R = U.rows[ed.mode === "ui" ? "ui" : "chara"];
    for (var i = 0; i < ed.parts.length; i++) {
      var p = ed.parts[i];
      if (p.__ulrRow) p.y = R[p.__ulrRow] + (p.__ulrDy || 0);
    }
  }

  function enterEdit(st, lb) {
    var sc = lb.scene;
    for (var i = 0; i < lb.items.length; i++) {
      var it = lb.items[i];
      if (!alive(it.img)) continue;
      try { sc.tweens.killTweensOf(it.img); } catch (e) {}
      applyLayout(it, savedOr(st, it));
      it.img.setAlpha(1);
    }
    reorder(lb);
    // ed.ui 是這次編輯的大廳元件草稿（OK 才寫回 st.state.ui）；ed.parts 是編輯用的按鈕等
    var draft = {};
    for (var key in st.state.ui) {
      var S = st.state.ui[key];
      draft[key] = { x: S.x, y: S.y, scale: S.scale, hidden: !!S.hidden };
    }
    // ed.sets／ed.cur 是套組的草稿：換套、新增、刪除都先改這份
    var ed = { mode: "chara", ui: draft, uiSel: null, parts: [], hidden: [], drag: null,
      zone: null, up: null, standBtns: [], modeText: null, hint: null, setText: null,
      sets: copySets(st.state.sets), cur: clampIdx(st.cur, st.state.sets.length) };
    lb.edit = ed;
    lb.sel = null;

    var zone = sc.add.zone(380, 340, 760, 680).setDepth(U.depth).setInteractive();
    zone.__ulrStandUi = true;
    ed.zone = zone;
    ed.parts.push(zone);
    zone.on("pointerdown", function (pointer) {
      if (ed.mode === "ui") { uiDown(ed, lb, pointer); return; }
      var hit = pick(lb, pointer.worldX, pointer.worldY);
      if (pointer.rightButtonDown()) {
        if (hit) { hit.img.setScale(-hit.img.scaleX, hit.img.scaleY); select(lb, hit); }
        return;
      }
      // 點了只選、不改圖層；圖層用 Front／Back
      select(lb, hit);
      if (!hit) return;
      ed.drag = { it: hit, dx: hit.img.x - pointer.worldX, dy: hit.img.y - pointer.worldY };
    });
    zone.on("pointermove", function (pointer) {
      var d = ed.drag;
      if (!d || !pointer.isDown) return;
      if (d.key) {
        var L = draftOf(ed, d.key);
        L.x = clamp(Math.round(pointer.worldX + d.dx), -U.uiOffsetMax, U.uiOffsetMax);
        L.y = clamp(Math.round(pointer.worldY + d.dy), -U.uiOffsetMax, U.uiOffsetMax);
        return;
      }
      if (!alive(d.it.img)) return;
      d.it.img.setPosition(clampX(pointer.worldX + d.dx), clampY(pointer.worldY + d.dy));
    });
    zone.on("wheel", function (pointer, dx, dy) {
      if (ed.mode === "ui") { uiWheel(ed, lb, pointer, dy || dx); return; }
      var it = pick(lb, pointer.worldX, pointer.worldY) || lb.sel;
      if (!it || !alive(it.img)) return;
      if (lb.sel !== it) select(lb, it);
      var d = dy || dx;
      if (!d) return;
      var ev = pointer.event;
      if (ev && ev.shiftKey) {
        it.img.setAngle(it.img.angle + (d > 0 ? U.angleStep : -U.angleStep));
      } else {
        var k = d > 0 ? 1 / U.scaleStep : U.scaleStep;
        setSize(it.img, clamp(Math.abs(it.img.scaleX) * k, U.scaleMin, U.scaleMax), it.img.scaleX < 0);
      }
    });
    ed.up = function () { ed.drag = null; };
    sc.input.on("pointerup", ed.up);
    sc.input.on("pointerupoutside", ed.up);

    ed.parts = ed.parts.concat(makeButton(sc, U.resetX, "btn", U.reset, function () {
      if (ed.mode === "ui") {
        if (ed.uiSel) delete ed.ui[ed.uiSel];
        else ed.ui = {};
        return;
      }
      var list = lb.sel ? [lb.sel] : lb.items;
      for (var j = 0; j < list.length; j++) {
        if (alive(list[j].img)) applyLayout(list[j], list[j].def);
      }
      reorder(lb);
    }));
    var front = makeButton(sc, U.frontX, "btn", U.front, function () {
      if (lb.sel && alive(lb.sel.img)) toFront(lb, lb.sel);
    });
    var back = makeButton(sc, U.backX, "btn", U.back, function () {
      if (lb.sel && alive(lb.sel.img)) toBack(lb, lb.sel);
    });
    // 第二排：套組
    var prev = makeButton(sc, U.prevX, "set", U.prev, function () {
      switchSet(st, lb, (ed.cur + ed.sets.length - 1) % ed.sets.length, true);
    });
    var next = makeButton(sc, U.nextX, "set", U.next, function () {
      switchSet(st, lb, (ed.cur + 1) % ed.sets.length, true);
    });
    var add = makeButton(sc, U.newX, "set", U.add, function () {
      if (ed.sets.length >= CFG.setsMax) return;
      captureSet(st, lb);
      ed.sets.push({ charas: [], layout: {} });
      switchSet(st, lb, ed.sets.length - 1, false);
    });
    var del = makeButton(sc, U.delX, "set", U.del, function () {
      // 刪光也留一套空的（照官方）
      if (ed.sets.length <= 1) ed.sets = [{ charas: [], layout: {} }];
      else ed.sets.splice(ed.cur, 1);
      switchSet(st, lb, Math.min(ed.cur, ed.sets.length - 1), false);
    });
    var label = sc.add.text(U.setLabelX, 0, "", {
      fontFamily: "font_heavy", fontSize: 12, color: "white", resolution: 2
    }).setOrigin(0.5, 0.5).setStroke("black", 3).setDepth(U.depth + 1);
    label.__ulrStandUi = true;
    label.__ulrRow = "set";
    label.__ulrDy = 12;
    ed.setText = label;
    ed.standBtns = front.concat(back, prev, next, add, del, [label]);
    ed.parts = ed.parts.concat(ed.standBtns);
    ed.parts = ed.parts.concat(makeButton(sc, U.okX, "btn", U.ok, function () { saveEdit(st, lb); }));
    var mode = makeButton(sc, U.modeX, "btn", U.toUi, function () {
      setMode(st, lb, ed.mode === "ui" ? "chara" : "ui");
    });
    ed.modeText = mode[1];
    ed.parts = ed.parts.concat(mode);
    var hint = sc.add.text(U.resetX, 0, U.hint, {
      fontFamily: "font_light", fontSize: 12, color: "white", resolution: 2
    }).setStroke("black", 3).setDepth(U.depth + 1);
    hint.__ulrStandUi = true;
    hint.__ulrRow = "hint";
    ed.hint = hint;
    ed.parts.push(hint);
    setLabel(ed);
    placeEdit(ed);
    hideLobbyUi(lb);
    if (lb.post) lb.post();
  }

  function copySets(sets) {
    return sets.map(function (s) {
      var layout = {};
      for (var k in s.layout) {
        var L = s.layout[k];
        layout[k] = { x: L.x, y: L.y, scale: L.scale, angle: L.angle, flip: !!L.flip, z: L.z };
      }
      return { charas: s.charas.slice(), layout: layout };
    });
  }

  function setLabel(ed) {
    ed.setText.setText(U.setLabel + (ed.cur + 1) + "/" + ed.sets.length);
  }

  /** 畫面上這一套的擺法寫回草稿。 */
  function captureSet(st, lb) {
    var ed = lb.edit;
    var set = ed && ed.sets[ed.cur];
    if (!set) return;
    var list = shown(st, lb);
    for (var i = 0; i < lb.items.length; i++) {
      var it = lb.items[i];
      if (alive(it.img) && list.indexOf(it.chara) !== -1) set.layout[it.chara] = readLayout(it);
    }
  }

  /** 換畫另一套（編輯中）。capture：先把現在這套的擺法記下來（刪掉的那套不必）。 */
  function switchSet(st, lb, idx, capture) {
    var ed = lb.edit;
    if (!ed) return;
    if (capture) captureSet(st, lb);
    ed.cur = clampIdx(idx, ed.sets.length);
    lb.sel = null;
    ed.drag = null;
    syncExtras(st, lb);
    for (var i = 0; i < lb.items.length; i++) {
      var it = lb.items[i];
      if (!alive(it.img)) continue;
      try { lb.scene.tweens.killTweensOf(it.img); } catch (e) {}
      applyLayout(it, savedOr(st, it));
    }
    reorder(lb);
    dimOthers(lb);
    setLabel(ed);
  }

  /** 切換「編輯立繪」與「編輯大廳元件」。 */
  function setMode(st, lb, mode) {
    var ed = lb.edit;
    if (!ed || ed.mode === mode) return;
    ed.mode = mode;
    ed.drag = null;
    ed.uiSel = null;
    lb.sel = null;
    dimOthers(lb);
    var ui = mode === "ui";
    if (ui) showLobbyUi(ed); else hideLobbyUi(lb);
    for (var i = 0; i < ed.standBtns.length; i++) ed.standBtns[i].setVisible(!ui);
    ed.modeText.setText(ui ? U.toChara : U.toUi);
    ed.hint.setText(ui ? U.uiHint : U.hint);
    placeEdit(ed);
    if (lb.post) lb.post();
  }

  function uiDown(ed, lb, pointer) {
    var key = pickUi(lb, pointer.worldX, pointer.worldY);
    if (pointer.rightButtonDown()) {
      if (key) { var H = draftOf(ed, key); H.hidden = !H.hidden; ed.uiSel = key; }
      return;
    }
    ed.uiSel = key;
    if (!key) return;
    var L = draftOf(ed, key);
    ed.drag = { key: key, dx: L.x - pointer.worldX, dy: L.y - pointer.worldY };
  }

  function uiWheel(ed, lb, pointer, d) {
    var key = pickUi(lb, pointer.worldX, pointer.worldY) || ed.uiSel;
    if (!key || !d) return;
    ed.uiSel = key;
    var L = draftOf(ed, key);
    var k = d > 0 ? 1 / U.scaleStep : U.scaleStep;
    L.scale = clamp(L.scale * k, U.uiScaleMin, U.uiScaleMax);
  }

  function saveEdit(st, lb) {
    var ed = lb.edit;
    var list = shown(st, lb);
    var items = lb.items.filter(function (it) { return alive(it.img) && list.indexOf(it.chara) !== -1; });
    items.sort(function (a, b) { return a.z - b.z || a.order - b.order; });
    for (var i = 0; i < items.length; i++) items[i].z = i;
    captureSet(st, lb);
    // 先動（樂觀更新），Node 存完會推回同一份
    st.state.sets = ed.sets;
    st.cur = ed.cur;
    var ui = uiChanged(ed.ui);
    st.state.ui = ui;
    exitEdit(st, lb);
    report({ type: "lobby-stand-sets", sets: copySets(st.state.sets), ui: ui });
  }

  function exitEdit(st, lb) {
    var ed = lb.edit;
    if (!ed) return;
    lb.edit = null;
    lb.sel = null;
    try {
      lb.scene.input.off("pointerup", ed.up);
      lb.scene.input.off("pointerupoutside", ed.up);
    } catch (e) {}
    for (var i = 0; i < ed.parts.length; i++) { try { ed.parts[i].destroy(); } catch (e) {} }
    showLobbyUi(ed);
    // 沒按 OK 就離開（換場景、拆掉）：草稿丟掉，照存著的那套擺回去
    if (st.lobby === lb && alive(lb.items[0].img)) {
      syncExtras(st, lb);
      for (var k = 0; k < lb.items.length; k++) {
        if (alive(lb.items[k].img)) applyLayout(lb.items[k], savedOr(st, lb.items[k]));
      }
      reorder(lb);
    }
    for (var j = 0; j < lb.items.length; j++) {
      if (alive(lb.items[j].img)) lb.items[j].img.setAlpha(1);
    }
    if (lb.post) lb.post();
  }

  // -------------------------------------------------------------------------
  // Library：愛心複選
  // -------------------------------------------------------------------------

  function charaKeyById(C, id) {
    for (var k in C) if (C[k] && C[k].id === id) return k;
    return null;
  }

  /** Library 改的是首頁上次畫的那一套（首頁編輯模式切過去的也算）。 */
  function libSet(st) {
    var sets = st.state.sets;
    return sets[clampIdx(st.cur, sets.length)];
  }

  function setCharas(st, list) {
    var sets = copySets(st.state.sets);
    sets[clampIdx(st.cur, sets.length)].charas = list;
    st.state.sets = sets;
    // 回首頁先畫這一套（不然點完愛心回去看到的是隨機的別套）
    st.stick = true;
    report({ type: "lobby-stand-sets", sets: copySets(sets) });
  }

  function heartFrame(st, p, key) {
    var on = libSet(st).charas.indexOf(key) !== -1;
    var cur = String(p.frame && p.frame.name);
    var want = on ? 2 : cur === "1" ? 1 : 0;
    if (cur !== String(want)) p.setTexture("library_deco", want);
  }

  function retrofitLibrary(st, sc) {
    var rows = sc.chara_card_list;
    if (!rows || !rows.length) return;
    var C = sc.cache && sc.cache.json.get("Characters");
    if (!C) return;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var p = row && row.chara_favorite;
      if (!alive(p)) continue;
      if (p.__ulrStand) { heartFrame(st, p, p.__ulrStand); continue; }
      var key = charaKeyById(C, sc.chara_card_index[LIB_PAGE * (sc.chara_card_page - 1) + i]);
      if (!key) continue;
      p.__ulrStand = key;
      p.removeAllListeners("pointerup");
      p.on("pointerup", toggleHeart(st, sc, p, key));
      heartFrame(st, p, key);
      st.libRows.push(p);
    }
  }

  function toggleHeart(st, sc, p, key) {
    return function () {
      var cur = window[FLAG];
      if (cur !== st) return;
      var list = libSet(st).charas.slice();
      var at = list.indexOf(key);
      if (at !== -1) list.splice(at, 1);
      else if (list.length >= CFG.max) return;
      else list.push(key);
      // 官方取消時換成 hover 那格（滑鼠還在上面）
      p.setTexture("library_deco", at !== -1 ? 1 : 2);
      // sc.chara_favorite 不動：官方最愛固定一隻（玩家要的）。官方按返回本來就
      // 每次都送 update_chara_favorite，送的是同一隻，請求不會變多
      setCharas(st, list);
    };
  }

  /** 把官方的愛心找回來：叫官方自己重畫那一頁。 */
  function unretrofitLibrary(st) {
    var had = st.libRows.some(function (p) { return alive(p); });
    st.libRows = [];
    var sc = activeScene("Library");
    if (!had || !sc || typeof sc.refresh !== "function") return;
    try { sc.refresh(sc.category_main); } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 包方法（場景懶載，看到實例才包）
  // -------------------------------------------------------------------------

  function wrapAfter(st, obj, name, after) {
    var had = Object.prototype.hasOwnProperty.call(obj, name);
    var orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function () {
      var r = orig.apply(this, arguments);
      try { after(this); } catch (e) { fail(name, e); }
      return r;
    };
    st.wraps.push(function () {
      if (had) obj[name] = orig; else delete obj[name];
    });
  }

  function ensureWraps(st) {
    var lob = sceneOf("Lobby");
    if (lob && !st.wrapped.Lobby) {
      st.wrapped.Lobby = true;
      wrapAfter(st, lob, "create", function (sc) {
        if (window[FLAG] === st && st.state.ready) mountLobby(st, sc, true);
      });
    }
    var lib = sceneOf("Library");
    if (lib && !st.wrapped.Library) {
      st.wrapped.Library = true;
      wrapAfter(st, lib, "show_chara_card", function (sc) {
        if (window[FLAG] === st && st.state.ready) retrofitLibrary(st, sc);
      });
    }
  }

  function tick() {
    var st = window[FLAG];
    if (!st) return;
    try {
      ensureWraps(st);
      var lob = activeScene("Lobby");
      if (st.lobby && (st.lobby.scene !== lob || !alive(st.lobby.items[0].img))) {
        unmountLobby(st, false);
      }
      if (st.state.ready && lob && alive(lob.stand_chara) && !lob.stand_chara.__ulrStand) {
        mountLobby(st, lob, false);
      }
      // 編輯中官方又畫出來的（通知、計時器切換的）一樣藏
      if (st.lobby && st.lobby.edit) hideLobbyUi(st.lobby);
      var lib = activeScene("Library");
      if (lib && st.state.ready) retrofitLibrary(st, lib);
      st.libRows = st.libRows.filter(function (p) { return alive(p); });
      st.reason = null;
    } catch (e) {
      st.reason = String((e && e.message) || e);
    }
  }

  function normalize(s) {
    s.ready = s.ready === true;
    if (!Array.isArray(s.sets)) s.sets = [];
    s.sets = s.sets.filter(function (x) { return x && typeof x === "object"; }).map(function (x) {
      return {
        charas: Array.isArray(x.charas) ? x.charas.filter(isKey) : [],
        layout: x.layout && typeof x.layout === "object" ? x.layout : {}
      };
    });
    if (s.sets.length === 0) s.sets = [{ charas: [], layout: {} }];
    if (!s.ui || typeof s.ui !== "object") s.ui = {};
    return s;
  }

  function detach(st) {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    unmountLobby(st, true);
    unhookRightClick(st);
    for (var i = st.wraps.length - 1; i >= 0; i--) { try { st.wraps[i](); } catch (e) {} }
    st.wraps = [];
    st.wrapped = {};
    unretrofitLibrary(st);
  }

  (function () {
    var old = window[FLAG];
    if (!old) return;
    try { if (typeof old.detach === "function") old.detach(); } catch (e) {}
    delete window[FLAG];
  })();

  var st = {
    version: CFG.version,
    state: normalize(CFG.state),
    /** 現在畫的是第幾套；stick：下次進首頁先不要換（剛在 Library 改過這套）。 */
    cur: 0,
    stick: false,
    lobby: null,
    loading: {},
    libRows: [],
    rc: null,
    wraps: [],
    wrapped: {},
    timer: null,
    reason: null,
    detach: function () { detach(st); },
    setState: function (next) {
      normalize(next);
      st.state = next;
      st.cur = clampIdx(st.cur, next.sets.length);
      if (!next.ready) {
        unmountLobby(st, true);
        unhookRightClick(st);
        unretrofitLibrary(st);
        return;
      }
      var lb = st.lobby;
      // 編輯中畫的是草稿，不動
      if (lb && !lb.edit) {
        syncExtras(st, lb);
        for (var i = 0; i < lb.items.length; i++) {
          var it = lb.items[i];
          if (!alive(it.img)) continue;
          try { lb.scene.tweens.killTweensOf(it.img); } catch (e) {}
          applyLayout(it, savedOr(st, it));
          it.img.setAlpha(1);
        }
        reorder(lb);
      }
      for (var j = 0; j < st.libRows.length; j++) {
        var p = st.libRows[j];
        if (alive(p)) heartFrame(st, p, p.__ulrStand);
      }
      tick();
    }
  };
  window[FLAG] = st;
  st.timer = setInterval(tick, CFG.pollIntervalMs);
  tick();

  return JSON.stringify({
    installed: true,
    version: st.version,
    stands: st.lobby ? st.lobby.items.length : 0,
    editing: !!(st.lobby && st.lobby.edit),
    reason: st.reason
  });
})()`;
}

/** 推新狀態。回 `"not-installed"` 表示呼叫端要重裝。 */
export function buildLobbyStandStateExpression(state: LobbyStandState): string {
  return `(function () {
  var st = window["${FLAG}"];
  if (!st || typeof st.setState !== "function") return "not-installed";
  st.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

export const LOBBY_STAND_STATUS_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return JSON.stringify({ installed: false, version: null, stands: 0, editing: false, reason: null });
    return JSON.stringify({
      installed: true,
      version: st.version,
      stands: st.lobby ? st.lobby.items.length : 0,
      editing: !!(st.lobby && st.lobby.edit),
      reason: st.reason
    });
  } catch (e) {
    return JSON.stringify({ installed: false, version: null, stands: 0, editing: false, reason: String((e && e.message) || e) });
  }
})()`;

export const LOBBY_STAND_UNINSTALL_EXPRESSION = `(function () {
  try {
    var st = window["${FLAG}"];
    if (!st) return "not-installed";
    try { if (typeof st.detach === "function") st.detach(); } catch (e) {}
    delete window["${FLAG}"];
    return "ok";
  } catch (e) {
    return "error:" + String((e && e.message) || e);
  }
})()`;

/** 讀不懂就當成「沒裝」並把原文帶在 `reason` 裡。 */
export function parseLobbyStandStatus(raw: string): LobbyStandStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      installed: false,
      version: null,
      stands: 0,
      editing: false,
      reason: `頁面回了讀不懂的東西：${raw.slice(0, 120)}`,
    };
  }
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    version: typeof o.version === "number" ? o.version : null,
    stands: typeof o.stands === "number" ? o.stands : 0,
    editing: o.editing === true,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}
