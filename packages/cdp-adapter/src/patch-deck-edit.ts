/**
 * 牌組庫的遊戲內介面（WP-18）
 * ============================
 * 規格 §3：**全部做在遊戲畫面裡，托盤視窗一個字都不加。**
 *
 * 動到的都是牌組編輯（`Edit`）畫面左下角那一排，以及右邊「排列(升序)」底下：
 *
 * ```
 *   Deck1                      ← deck1_name(5,450)：點一下就地改名（2026-09-12）
 *   ◀ [牌盒] ▶  + -   reset    ← deck_pre(16,644) / edit_icon(32,644) / deck_next(48,644)
 *   ↑ 原本切 Deck1/2/3        ＋我們加的：牌盒點開選單、加減牌組（＋－抄 reset 的樣子）
 *
 *   排列(升序)  [ID    ▾]      ← sort_label_text(448,448) / sort_rect(510,480)
 *   房間        [迪特赫姆 ▾]   ← 我們加的（規格 §7），同一套下拉選單，畫在它正下方
 * ```
 *
 * 牌盒點開的選單（2026-09-12 改版）每一副一列，**三張卡面 + 右邊三行字**：
 *
 * ```
 *   ┌────┬────┬────┐  壓 C 用              ← 名字（套用中的黃字）
 *   │    │    │    │  標籤 海魚            ← 只有渦房
 *   └────┴────┴────┘  官方 110 自訂 106    ← 兩種總 COST 都畫
 * ```
 *
 * ## 三個「照抄」，跟 patch-lobby 同一套規矩
 *
 * 1. **貼圖用遊戲自己的**（`panel_gene`、`edit_reset`、`edit_arrow`、`cc_front`）。
 *    自己畫一個會馬上被看出是外掛的東西。＋－那兩顆是拿 `edit_reset` 的圖
 *    把中間那段「reset」字挖掉重拼的（{@link plainButtonTexture}）。
 * 2. **字型用遊戲自己的**（`font_heavy` / `font_light`），大小抄旁邊的元件。
 *    「房間」那一格連 rexUI 的 roundRectangle / BBCodeText 都照 `sort_rect` 抄。
 * 3. **輸入框用 rexUI 的 `InputText`** —— 遊戲自己就載了這個外掛
 *    （`RexPlugins.UI.InputText`），不必自己處理鍵盤。
 *
 * ## ⚠ 這支不決定任何牌組內容
 *
 * 它只做兩件事：**把 Node 推來的狀態畫出來**、**把玩家點了什麼回報給 Node**。
 * 牌組怎麼存、寫不寫得進去、庫存夠不夠，全部是 Node 那邊的事
 * （`@ulr/deck-library` 與 `deck-write.ts`）。頁面端存了狀態就會有兩份真相，
 * 而它們一定會不同步。
 *
 * 牌組**內容**（三張卡是誰、哪些事件卡）2026-09-12 起會下放到頁面，但**只為了
 * 畫**：卡面縮圖與兩種總 COST 都是從內容算出來的顯示，頁面從不把內容送回去。
 *
 * ## 兩種總 COST 是怎麼算的
 *
 * 官方那個照 `docs/official-cost-rule.md` 算（三個槽位＋武器＋事件卡＋壓 C：
 * 差 7~13 罰 5、14 以上罰 10）。自訂那個用同一條公式，只換兩樣：價格查
 * `window.__ulrCostPatch.customs`（`patch-cost.ts` 放的規則本身），壓 C 區間
 * 用狀態帶來的 {@link DeckEditState.penaltyBands}。沒有 customs 就代表沒選規則
 * —— 那時只畫官方一個數字。
 *
 * ⚠ 不能直接拿遊戲的 `Deck.getCost()`：它讀的是快取裡**此刻**躺著的那種價
 * （開關切到哪邊就是哪邊），一次只算得出一種。
 *
 * ## ⚠ Edit 場景每次進來都是重新 create
 *
 * 跟 `patch-lobby` 盯 `channel_panel` 同樣的問題：玩家離開再進來，我們掛上去的
 * 東西已經跟著舊場景被 destroy。所以這支用輪詢（500ms）盯著「Edit 場景是不是
 * active 而且沒有我們的東西」，是的話就重掛一次。
 *
 * **不能只在安裝時掛一次** —— 那樣玩家第一次進牌組編輯畫面就看不到，而症狀是
 * 「這功能對我沒作用」。
 */

import { createHash } from "node:crypto";
import {
  AVATAR_ITEM_KEY,
  AVATAR_ITEM_WEAPON_FIELD,
  CC_ASSET_KEY,
  EVENT_INFO_JSON_KEY,
  MC_ASSET_KEY,
} from "./constants.js";
import { embedJson } from "./embed.js";
import { COST_PATCH_FLAG } from "./patch-cost.js";
import { SIDE_LABEL } from "./patch-cost-toggle.js";
import type { PenaltyBand } from "./patch-penalty.js";

/**
 * 「房間」那一格的標題，五種語言。
 *
 * ⚠ 原本寫死「房間」兩個字 —— 遊戲的英／日／韓介面裡會突然出現中文。旁邊
 * 「排列(升序)」與「抽出」都是照 `lang` 換的，這一格也得換。
 *
 * 用詞照官方在同一個畫面用的字（`Match` 的房間列表），不要自己音譯。
 */
const ROOM_TITLE: Record<string, string> = {
  ja: "部屋",
  en: "Room",
  kr: "방",
  scn: "房间",
  tcn: "房間",
};

/** 渦 BOSS 標籤那一行的開頭。⚠ 只有渦房會畫。 */
const TAG_TITLE: Record<string, string> = {
  ja: "タグ",
  en: "Tag",
  kr: "태그",
  scn: "标签",
  tcn: "標籤",
};

/** 勾選渦 BOSS 那個面板的標題。 */
const BOSS_TITLE: Record<string, string> = {
  ja: "このデッキで倒せるレイド",
  en: "Raids this deck can beat",
  kr: "이 덱으로 잡을 수 있는 레이드",
  scn: "这副能打哪几种涡",
  tcn: "這副打得動哪幾種渦",
};

/**
 * 一副牌組的內容，**只拿來畫**（卡面縮圖、兩種總 COST）。
 *
 * 形狀跟 `@ulr/deck-library` 的 `DeckContent` 一樣（角色 `cc069`／怪物
 * `mc001_01`、三個槽位的資產索引、三把武器、18 格事件卡），這裡另外宣告是
 * 因為這個 package 不依賴那一邊。
 */
export interface DeckEditContent {
  chara: (string | null)[];
  charaIndex: (number | null)[];
  weapon: (number | null)[];
  eventIndex: (number | null)[];
}

/** 畫在選單裡的一副牌組。**只有畫出來要用的欄位。** */
export interface DeckEditItem {
  id: string;
  /** 已經套過 `displayName()` 的名字，頁面直接畫。 */
  name: string;
  /**
   * 渦 BOSS 標籤，放的是**鍵**（`sea`／`fish`…），不是顯示字。非渦房的恆為空。
   *
   * ⚠ 鍵而不是顯示字，是因為勾選面板要拿它跟 {@link DeckEditState.bossOptions}
   * 的 `key` 比對。畫出來時頁面自己去 `bossOptions` 查標籤。
   */
  bosses: string[];
  /** 三張卡是誰、帶什麼 —— 畫縮圖與算 COST 用。頁面**不會**把它送回來。 */
  content: DeckEditContent;
}

/** Node 推給頁面的狀態。**畫面上的每一個字都由這裡決定。** */
export interface DeckEditState {
  /**
   * 目前的房型鍵（`raid` / `alexandria` / `quest` / `dietherm`）。
   *
   * ⚠ 頁面端**不認得**這些鍵的意思，只拿來比對與回報。牌組進哪個槽是 Node
   * 那邊的事。
   */
  room: string;
  /**
   * 房型的顯示名稱，照 `ROOM_KINDS` 的順序（規格 §4）。
   *
   * ⚠ 「房間」下拉選單就照這個陣列列，**頁面不自己寫死房型清單** —— 寫死的話
   * 之後改房型就得同時改兩個地方，而漏掉的那邊沒有測試會抓到。
   */
  rooms: { key: string; label: string }[];
  /** 這一房的牌組，順序就是玩家排的順序。 */
  decks: DeckEditItem[];
  /** 現在套用中的是哪一副。沒有就是 `null`。 */
  activeId: string | null;
  /** 渦 BOSS 標籤的選項，`{ key, label }`。 */
  bossOptions: { key: string; label: string }[];
  /**
   * 每一副旁邊要畫哪一種總 COST（2026-09-12）：
   *
   * ```
   *   none      不畫（任務／渦是 PVE，沒有 COST 上限）
   *   official  官方 N（亞歷山卓城）
   *   custom    自訂 N（迪特赫姆）—— 沒選規則時退回官方 N
   * ```
   *
   * ⚠ 哪一房用哪一種是 Node 決定的（`@ulr/deck-library` 的 `ROOM_COST_DISPLAY`），
   * 頁面只照著畫 —— 頁面不認得房型鍵的意思。省略時當 `official`（舊呼叫端）。
   */
  costDisplay?: "none" | "official" | "custom";
  /**
   * 自訂規則的壓 C 區間；`null` = 規則沒寫（自訂那一欄用官方的 7→5、14→10）。
   *
   * 算「自訂」總 COST 用。價格從頁面上的 `__ulrCostPatch.customs` 查，區間
   * 卻得從這裡帶：罰則補丁（`patch-penalty.ts`）在開關切到官方時會被**整支
   * 拆掉**，頁面上就沒有地方留著它了。
   *
   * 沒選規則時這個值沒意義（頁面看到沒有 customs 就只畫官方）。
   */
  penaltyBands?: PenaltyBand[] | null;
  /*
   * ⚠ **這裡沒有 `notice`，而且不要加回來。**
   *
   * 曾經有一行紅字畫在 (286,644)，用來說「庫存不足」「正要換成…」之類的。
   * 2026-09-09 移除，兩個理由：
   *
   * 1. 它在渦房會**壓到遊戲自己的「輸入Raid代碼」**（實機量到那顆在 430,646，
   *    而 y=644 這一列在渦房只有 280→340 這一小段是空的 —— 放不下一句話）。
   * 2. 更重要：它說的事情**畫面上本來就看得到**。左下那行字就是套用中那一副
   *    的名字，牌也已經換過去了；再寫一句「正要換成」只是把玩家的注意力拉到
   *    一個他已經知道的事實上。
   *
   * 訊息本身沒有丟掉 —— 改成寫進托盤的記錄（`main.ts` 的 `log()`）。要給玩家
   * 看的東西應該在托盤視窗裡，遊戲畫面上只放「他正在操作的東西」。
   */
}

/** 玩家在畫面上做了什麼。 */
export type DeckEditReport =
  | { type: "deck-select"; id: string }
  /**
   * 按了左下角原版那兩個 ◀▶。**切的是自訂牌組，不是伺服器的 Deck1/2/3。**
   *
   * `delta` 是 -1 或 +1，「上一副／下一副」由呼叫端在清單上算 —— 頁面不知道
   * 有幾副，也不該知道。
   */
  /**
   * ◀▶ 切上／下一副。
   *
   * `from` 說的是**哪一組箭頭**：`menu` 是牌組編輯畫面裡那組（預設），
   * `room` 是任務／渦／對戰房左下角那組（`patch-room-gate.ts` 接管的）。
   *
   * ⚠ 這個區分不是裝飾。選單那組切的是「選單現在看的那一房」，房裡那組切的
   * 必須是「玩家人在的那一房」—— 玩家可以人在任務房卻把選單切去看迪城的牌組，
   * 那時候按房裡的箭頭要切任務房的，不是迪城的。切錯的後果是拿錯牌組上場。
   */
  | { type: "deck-cycle"; delta: number; from?: "menu" | "room" }
  | { type: "deck-add" }
  | { type: "deck-remove"; id: string }
  | { type: "deck-rename"; id: string; name: string }
  | { type: "deck-move"; id: string; toIndex: number }
  | { type: "deck-bosses"; id: string; bosses: string[] }
  | { type: "deck-save-current"; id: string }
  | { type: "room-switch"; room: string }
  /**
   * 渦房裡選中了一個渦（詳細面板打開、或換成另一個渦）。`mons` 是那隻 BOSS 的
   * `profound_mons`（`mc1008_02`）。
   *
   * ⚠ 頁面**不翻成標籤鍵**：「mc1008 是龜」跟「哪一副掛了龜」都是 Node 的事，
   * 頁面只說看到了什麼（跟 `bossOptions` 同一個理由）。同一個渦只報一次。
   */
  | { type: "raid-pick"; mons: string }
  | { type: "deck-ui-error"; message: string };

const REPORT_TYPES = new Set([
  "deck-select",
  "deck-cycle",
  "deck-add",
  "deck-remove",
  "deck-rename",
  "deck-move",
  "deck-bosses",
  "deck-save-current",
  "room-switch",
  "raid-pick",
  "deck-ui-error",
]);

export function isDeckEditReport(value: unknown): value is DeckEditReport {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && REPORT_TYPES.has(t);
}

/**
 * 除了牌組編輯畫面以外，還有哪些場景畫著同一排牌組列。
 *
 * 2026-09-09 實機量到任務房底下那一排跟 Edit **一模一樣**：
 * `edit_icon(32,644)` + 兩顆 `edit_arrow(16/48, 644)` + 牌組名 `Text(64,644)`。
 * 所以同一套 `mount()` 原樣掛得上去 —— 玩家在房裡按那顆棕色牌盒，跳出來的是
 * 跟編輯畫面完全一樣的選單。
 *
 * ## ⚠⚠ 渦房（Raid）**沒有那顆棕色牌盒**
 *
 * 2026-09-09 從跑著的客戶端讀 `create()` 的原始碼，四個場景擺法並不一致：
 *
 * ```
 *   Edit    this.add.image (32,644,"edit_icon")    箭頭 16 / 48
 *   Quest   this.add.sprite(32,644,"edit_icon")    箭頭 16 / 48
 *   Match   this.add.sprite(412,644,"edit_icon")   箭頭 396 / 428
 *   Raid    ——  沒有 ——                            箭頭 16 / 48
 * ```
 *
 * （`Raid.create()` 裡 `indexOf("edit_icon") === -1`；它只有 `deckcase`，而那
 * 是牌組卡片後面那張框，在 (28,482)，不是這一排。）
 *
 * 這害了兩件事，而症狀都是「渦房完全沒反應」：
 *
 * 1. `hasDeckRow()` 原本認的是 `edit_icon` → 渦房永遠回 false → **這支從來
 *    沒有掛上過渦房**（實機量到 `__ulrDeckEdit` 是 `v9 mounted=false`）。
 * 2. 就算掛上了，`mount()` 找不到圖示 → 沒有東西可以點開選單。
 *
 * 所以現在：認的是**箭頭**（四個場景都有），而圖示找不到時就**自己補一顆**，
 * 位置取兩顆箭頭的正中間（渦房算出來就是 32，正好是其他三個場景的擺法）。
 * 貼圖用遊戲自己的 `edit_icon`（16×24，Phaser 的貼圖管理是全域的，實機確認
 * `textures.exists("edit_icon") === true`），所以玩家看到的跟任務房一模一樣。
 */
const ROOM_SCENES = ["Quest", "Raid", "Match"] as const;

const FLAG = "__ulrDeckEdit";

/** 輪詢間隔。跟 patch-lobby 一樣 500ms —— 玩家進畫面到看見東西不會超過半秒。 */
export const DEFAULT_DECK_EDIT_POLL_MS = 500;

export interface DeckEditPatchOptions {
  /** 回報用的 binding 名稱。 */
  bindingName: string;
  /** 初始狀態。 */
  state: DeckEditState;
  pollMs?: number;
  /** 長按幾毫秒才進入拖曳（規格 §10 說 1 秒）。 */
  dragHoldMs?: number;
}

/**
 * 產生要注入的腳本。
 *
 * 座標全部是 2026-08-24 從實機量的（畫布 760×680）：
 * `edit_icon(32,644)`、`deck_pre(16,644)`、`deck_next(48,644)`、
 * `sort_rect(510,480)`。
 */
export function buildDeckEditPatchScript(options: DeckEditPatchOptions): string {
  return buildScript(options, DECK_EDIT_SCRIPT_VERSION);
}

/**
 * 雜湊用的固定狀態。**只有形狀重要，值不重要** —— 它存在的唯一理由是把
 * 「玩家的牌組」從指紋裡拿掉。
 */
const FINGERPRINT_STATE: DeckEditState = {
  room: "",
  rooms: [],
  decks: [],
  activeId: null,
  bossOptions: [],
};

/** 腳本內容的指紋。前 12 個 hex 就夠認人，而且塞進頁面與記錄裡還讀得下去。 */
function fingerprint(): string {
  const canonical = buildScript({ bindingName: "__ulrFingerprint", state: FINGERPRINT_STATE }, "");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * 頁面端腳本的版本。**這是算出來的，不要手改。**
 *
 * ## 為什麼不是一個手動維護的號碼
 *
 * 原本這裡寫著「改了腳本一定要 +1」。那句話有兩個問題，而 2026-09-09 兩個
 * 都撞到了：
 *
 * 1. **忘了加的話，症狀是沉默的**。頁面上那份舊腳本會一直活著，而版本號說
 *    它是新的 —— 功能「沒生效」，但檔案時間、發版記錄、版本號全部是新的。
 * 2. 就算記得加，也要有人**真的去比**那個號碼。那天沒有任何一處在比
 *    （見 `arbiter-engine` 的 `deckEditStatus()`）。
 *
 * 所以現在版本 = **腳本內容的指紋**。改了腳本它自己就變了，忘不掉。
 *
 * ⚠ 指紋算的是**腳本的程式碼**，不含玩家狀態（牌組名字改一下就換一個指紋的
 * 話，每次改名都會整份重裝）—— 所以雜湊前先把狀態換成一份固定的空狀態。
 * 同理，`bindingName` 與輪詢間隔這些設定值也不在指紋裡：它們是「怎麼裝」，
 * 不是「裝什麼」，而且實際上只有 `adapter.ts` 一個呼叫端、永遠是同一組值。
 *
 * ⚠⚠ **這一行要放在它用到的東西後面。** `fingerprint()` 在模組載入時就跑，
 * 而 `FINGERPRINT_STATE` 與 `DEFAULT_DECK_EDIT_POLL_MS` 是 `const` —— 宣告
 * 提到它們前面的話是 TDZ 錯誤（「Cannot access before initialization」），
 * 而那會讓整個 package 匯入失敗，不只是這支。
 */
export const DECK_EDIT_SCRIPT_VERSION: string = fingerprint();

/**
 * 真正的腳本本體。
 *
 * ⚠ `version` 是參數而不是直接讀 {@link DECK_EDIT_SCRIPT_VERSION}：那個常數
 * 正是**由這支算出來的**，直接讀會變成迴圈。算指紋時傳空字串。
 */
function buildScript(options: DeckEditPatchOptions, version: string): string {
  const pollMs = options.pollMs ?? DEFAULT_DECK_EDIT_POLL_MS;
  const holdMs = options.dragHoldMs ?? 1000;
  const config = {
    ccAsset: CC_ASSET_KEY,
    mcAsset: MC_ASSET_KEY,
    itemAsset: AVATAR_ITEM_KEY,
    itemField: AVATAR_ITEM_WEAPON_FIELD,
    eventAsset: EVENT_INFO_JSON_KEY,
    /** 查不到價格的卡算 99，**而且照常參與壓 C** —— 照客戶端自己的常數。 */
    unknownCost: 99,
    /** 原版壓 C：差 7~13 罰 5、14 以上罰 10。沒有第三級。 */
    officialBands: [
      { minGap: 7, maxGap: 13, extraCost: 5 },
      { minGap: 14, extraCost: 10 },
    ],
    /** 「官方 ／ 自訂」那兩個字，**跟標題列那顆開關共用同一組**。 */
    sideLabel: SIDE_LABEL,
    roomTitle: ROOM_TITLE,
    tagTitle: TAG_TITLE,
    bossTitle: BOSS_TITLE,
  };
  return `(function () {
  var BINDING = ${JSON.stringify(options.bindingName)};
  var VERSION = ${JSON.stringify(version)};
  var HOLD_MS = ${holdMs};
  var CFG = JSON.parse(${embedJson(config)});
  var HAS = Object.prototype.hasOwnProperty;

  /**
   * 選單的版面。
   *
   * ROW_H 一列的高度 ＝ 卡面高度 ＋ 4，也就是規格說的「三張卡牌的高度加
   * 一點點」。PANEL_PAD 是 panel_gene 九宮格上下邊框吃掉的量（63＋32 再留
   * 一點）。TEXT_W 是卡右邊那三行字的寬度 —— 夠放「官方 110 自訂 106」。
   */
  var ROW_H = 46;
  var PANEL_PAD = 76;
  var TEXT_W = 150;

  /**
   * 「房間」那一格的座標。
   *
   * 照抄旁邊「排列(升序)」的擺法（2026-09-12 實機量：標題 add.text(448,448)
   * origin(0,0) font_heavy 15 斜體，白底圓角 roundRectangle(510,480,100,18)）
   * —— 標題在上、值在下差 32px。我們這一格就接在它底下一組。
   */
  var ROOM_LABEL_XY = [448, 500];
  var ROOM_RECT_XY = [510, 532];

  /** 遊戲現在的語言。⚠ 認不得就退 en，不要留空字串 —— 那會畫成空白。 */
  function gameLang() {
    return typeof window.lang === "string" && window.lang.length > 0 ? window.lang : "en";
  }

  function pick(table, lang) {
    return table[lang] || table.en;
  }

  var api = window.${FLAG};
  if (api && api.version === VERSION) {
    api.setState(JSON.parse(${embedJson(options.state)}));
    return "already-installed";
  }
  if (api && typeof api.uninstall === "function") { try { api.uninstall(); } catch (e) {} }

  // ⚠ 舊版的 uninstall 不一定收得乾淨（v1 就把選單面板留成了孤兒，畫面上疊出
  // 兩套）。所以裝新版之前先自己掃一次場景，把任何版本留下的東西清光。
  try {
    var g0 = window.game;
    if (g0) {
      // ⚠ 房間場景也要掃。選單現在也掛在任務／渦／對戰房，孤兒留在那裡的話
      // 玩家一進房就看到兩套疊在一起。
      // ⚠ 同上：一定要 JSON.parse，否則 concat 接上去的是一個字串。
      var purgeAll = ["Edit"].concat(JSON.parse(${embedJson([...ROOM_SCENES])}));
      purgeAll.forEach(function (n) {
        if (g0.scene.keys[n]) purge(g0.scene.keys[n]);
      });
    }
  } catch (e) {}

  var state = JSON.parse(${embedJson(options.state)});
  var mounted = null;   // { scene, objects: [], panel }
  var timer = null;

  function report(payload) {
    try {
      var fn = window[BINDING];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) { /* binding 還沒掛上，丟掉就好 */ }
  }

  function fail(where, e) {
    report({ type: "deck-ui-error", message: where + "：" + String((e && e.message) || e) });
  }

  // ---- 畫面元件（全部用遊戲自己的貼圖與字型）----------------------------

  function label(sc, x, y, text, size, color) {
    return sc.add.text(x, y, text, {
      fontFamily: "font_heavy", fontSize: size || 13, color: color || "#ffffff"
    }).setResolution(2).setDepth(1502);
  }

  /** 小按鈕：用遊戲的 btn_gene，hover 換 frame —— 跟 Edit 畫面其他按鈕一致。 */
  function button(sc, x, y, text, onClick) {
    var img = sc.add.image(x, y, "btn_gene", 0).setDepth(1502).setInteractive();
    var txt = sc.add.text(x, y, text, { fontFamily: "font_heavy", fontSize: 12, color: "black" })
      .setResolution(2).setOrigin(0.5).setDepth(1503);
    img.on("pointerover", function () { img.setTexture("btn_gene", 1); txt.setColor("#ffffff"); });
    img.on("pointerout", function () { img.setTexture("btn_gene", 0); txt.setColor("#000000"); });
    img.on("pointerdown", function () {
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      onClick();
    });
    return { img: img, txt: txt, destroy: function () { img.destroy(); txt.destroy(); } };
  }

  /**
   * 「reset」那顆的樣子，但中間**沒有字**。
   *
   * edit_reset 是 64×48（上下兩格 64×24，hover 換第二格），而「reset」那幾個
   * 字是**烤在圖裡**的（2026-09-12 量：不透明範圍 x6..57，字佔 x18..45）——
   * 所以疊字上去會看到兩層字。這裡自己拼一張：左邊框那段（x6..17）接右邊框
   * 那段（x46..57），得到 24px 寬的純邊框按鈕，兩格一起拼。
   *
   * ⚠ 貼圖管理是**全域**的，同一個鍵只能建一次 —— 第二次 createCanvas 會回
   * null 並在 console 抱怨。所以先問 exists()。
   *
   * ⚠ 拼不出來就回 null，呼叫端退回 btn_gene。少了這個退路，任何沒有
   * textures／canvas 的環境（測試用的假場景）會讓整個 mount 炸掉。
   */
  function plainButtonTexture(sc) {
    var KEY = "ulr_btn_plain";
    try {
      var tm = sc.textures;
      if (!tm || typeof tm.createCanvas !== "function" || typeof tm.exists !== "function") {
        return null;
      }
      if (tm.exists(KEY)) return KEY;
      if (!tm.exists("edit_reset")) return null;
      var src = tm.get("edit_reset").getSourceImage();
      var cv = tm.createCanvas(KEY, 24, 48);
      if (!cv) return null;
      var ctx = cv.getContext();
      ctx.clearRect(0, 0, 24, 48);
      ctx.drawImage(src, 6, 0, 12, 48, 0, 0, 12, 48);
      ctx.drawImage(src, 46, 0, 12, 48, 12, 0, 12, 48);
      cv.refresh();
      // 上格＝常態、下格＝hover，跟 edit_reset 自己的兩格一樣。
      cv.add(0, 0, 0, 0, 24, 24);
      cv.add(1, 0, 0, 24, 24, 24);
      return KEY;
    } catch (e) { return null; }
  }

  /**
   * ＋－那兩顆。**樣子照抄 reset**（規格：2026-09-12 玩家要求），字是我們疊的。
   *
   * 深度刻意壓在 4／5 而不是 1502 —— 那一排是遊戲自己的東西（深度 0），而
   * 選單打開時的擋點擊罩是 1500：放在 1502 的話罩不住它，玩家在選單開著的
   * 時候還按得到「－」把一副牌刪掉。
   */
  function plainButton(sc, x, y, text, onClick) {
    var key = plainButtonTexture(sc);
    var img = sc.add.image(x, y, key === null ? "btn_gene" : key, 0).setDepth(4);
    // 退路：btn_gene 原圖 80×25，縮到跟拼出來那顆一樣的 24×17。
    if (key === null) img.setScale(24 / 80, 17 / 25);
    img.setInteractive();
    var txt = sc.add.text(x, y, text, { fontFamily: "font_heavy", fontSize: 13, color: "#000000" })
      .setResolution(2).setOrigin(0.5).setDepth(5);
    var tex = key === null ? "btn_gene" : key;
    img.on("pointerover", function () { img.setTexture(tex, 1); txt.setColor("#eeeeee"); });
    img.on("pointerout", function () { img.setTexture(tex, 0); txt.setColor("#000000"); });
    img.on("pointerdown", function () {
      img.setTexture(tex, 0);
      try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
      onClick();
    });
    return { img: img, txt: txt, destroy: function () { img.destroy(); txt.destroy(); } };
  }

  /**
   * 下拉選單，**整套照抄遊戲自己的**（sort_rect ＋ CreatePanel）。
   *
   * 2026-09-12 從實機讀到的原版寫法：白底 roundRectangle 100×18 半徑 2、
   * alpha 0.8（hover 1）、值是 font_medium 10 的 BBCodeText；展開的是
   * rexUI 的 scrollablePanel，外框 strokeColor 12040892 寬 2，每一列是白底
   * label（font_light 10 黑字），hover 換紅框＋桃紅底。
   *
   * ## ⚠ 深度：關著的那一列要**低於**遊戲的面板
   *
   * 原版 sort_rect 是深度 0、sort_panel 是 1。我們這一格畫在
   * (448,500)，正好落在 sort_panel 展開後蓋住的範圍裡（實機：面板從 y=490
   * 往下 150）。所以關著的那一列一律 0 —— 放 2 的話**它會浮在遊戲的排列選單
   * 上面**，而那正是 2026-09-12 回報的第 1 條。展開時才升到 1，並且同時把
   * 遊戲那兩個面板關掉（原版彼此之間就是這樣互斥的）。
   *
   * ⚠ 沒有 rexUI 就回 null（測試的假場景）。呼叫端要能接受「這一格沒畫出來」。
   */
  function dropdown(sc, opts) {
    var rexUI = sc.rexUI;
    if (!rexUI || !rexUI.add || typeof rexUI.add.roundRectangle !== "function") return null;
    if (typeof rexUI.add.scrollablePanel !== "function") return null;

    var objs = [];
    var rect = rexUI.add.roundRectangle(opts.x, opts.y, 100, 18, 2, 16777215)
      .setOrigin(0.5, 0.5).setAlpha(0.8).setInteractive().setDepth(0);
    var value = rexUI.add.BBCodeText(opts.x, opts.y, opts.value, {
      fontFamily: "font_medium", fontSize: 10, resolution: 2, color: "black"
    }).setOrigin(0.5, 0.5).setDepth(0);
    objs.push(rect, value);

    var child = rexUI.add.sizer({ width: 87, orientation: "y", space: { item: 0 } });
    var texts = [];
    opts.options.forEach(function (opt) {
      // ⚠⚠ **先建底、再建字。** 同一個深度裡誰後進顯示清單誰在上面 —— 字先建
      // 的話會被自己那列的白底蓋掉，畫面上是一個空白的下拉（2026-09-12 實機
      // 撞到：文字物件都在、位置也對、就是看不見）。底下 setDepth 那段還會
      // 再把字抬高一層，兩道保險。
      var bg = rexUI.add.roundRectangle({ color: 16777215 });
      var text = sc.add.text(0, 0, opt.label, {
        fontFamily: "font_light", color: "black", fontSize: 10, resolution: 2
      }).setResolution(2);
      // 每一列的字會進場景的顯示清單。面板被 destroy 時 rexUI 會一起收，但
      // **孤兒清理（purge）認的是我們自己的標記** —— 不記進 objs 的話，舊版
      // 留下的那幾行字誰都收不掉。
      objs.push(text);
      texts.push(text);
      child.add(rexUI.add.label({
        background: bg,
        text: text,
        space: { left: 5, right: 5, top: 5, bottom: 5 },
        name: opt.key
      }), { expand: true });
    });
    var panel = rexUI.add.scrollablePanel({
      x: opts.x, y: opts.y + 14,
      height: 24 * opts.options.length,
      scrollMode: 0,
      background: rexUI.add.roundRectangle({ strokeColor: 12040892, strokeWidth: 2 }),
      panel: { child: child },
      space: { panel: 0 }
    }).setOrigin(0.5, 0).layout();
    // rexUI 的 setDepth 會把整棵樹（含每一列的白底）都設成 1；字要再高一層。
    panel.setDepth(1).setVisible(false);
    texts.forEach(function (t) { try { t.setDepth(2); } catch (e) {} });
    panel.setChildrenInteractive({});
    objs.push(panel);

    function close() { try { panel.setVisible(false); } catch (e) {} }

    panel.on("child.over", function (c) {
      var bg = c.getElement("background");
      bg.setStrokeStyle(1, 16711680); bg.fillColor = 16744319;
    });
    panel.on("child.out", function (c) {
      var bg = c.getElement("background");
      bg.setStrokeStyle(); bg.fillColor = 16777215;
    });
    panel.on("child.up", function (c) {
      var bg = c.getElement("background");
      bg.setStrokeStyle(); bg.fillColor = 16777215;
      close();
      opts.onPick(c.name);
    });

    rect.on("pointerover", function () { rect.setAlpha(1); });
    rect.on("pointerout", function () { rect.setAlpha(0.8); });
    rect.on("pointerup", function () { rect.setAlpha(1); });
    rect.on("pointerdown", function () {
      rect.setAlpha(0.8);
      // 原版的互斥：開一個就把另外兩個關掉。
      try { sc.sort_panel.visible = false; sc.filter_panel.visible = false; } catch (e) {}
      panel.setVisible(!panel.visible);
    });

    return {
      objects: objs,
      close: close,
      setValue: function (text) { try { value.setText(text); } catch (e) {} }
    };
  }

  // ---- 兩種總 COST（只為了畫，不參與任何判定）---------------------------

  /**
   * 一張卡在「官方」或「自訂」下的價格。
   *
   * 資料表裡此刻躺著的那個 cost **只是其中一種** —— patch-cost.ts 的開關
   * 切到哪邊就是哪邊。另一種只能從它留在頁面上的兩份對照查：
   *
   *     originals[表][鍵]   規則動過的那幾筆的**原價**
   *     customs[表][鍵]     規則本身（自訂價）
   *
   * 規則沒動到的卡兩邊相同，cost 就是答案。⚠ 沒有補丁（沒選規則）時一律
   * 回 cost —— 那時畫面上只會畫官方那一個數字。
   */
  function priceOf(table, key, cost, custom) {
    var st = window.${COST_PATCH_FLAG};
    if (!st) return cost;
    var orig = st.originals && st.originals[table];
    var cust = st.customs && st.customs[table];
    var official = orig && HAS.call(orig, key) ? orig[key] : cost;
    if (!custom) return official;
    return cust && HAS.call(cust, key) ? cust[key] : official;
  }

  /** 某張表的某一筆。查不到回 null —— 呼叫端要把它算成 UNKNOWN_COST。 */
  function assetRow(cacheKey, field, index) {
    try {
      var cache = window.game && window.game.cache && window.game.cache.json;
      if (!cache || !cache.has(cacheKey)) return null;
      var data = cache.get(cacheKey);
      var rows = data ? data[field] : null;
      if (!rows || typeof index !== "number" || index < 0 || index >= rows.length) return null;
      return rows[index] || null;
    } catch (e) { return null; }
  }

  /** 一個角色槽的資產鍵與表。前綴決定查哪一份 —— 查錯會撈到不相干的卡。 */
  function slotAsset(chara, index) {
    if (typeof chara !== "string" || typeof index !== "number") return null;
    var mons = chara.indexOf("mc") === 0;
    var row = assetRow(mons ? CFG.mcAsset : CFG.ccAsset, "frames", index);
    if (row === null) return null;
    return { row: row, table: mons ? "monsters" : "characters", key: String(row.filename || "") };
  }

  /**
   * 這副牌的總 COST。**公式照 docs/official-cost-rule.md**：
   * 三個槽位 ＋ 武器 ＋ 事件卡 ＋ 每一對槽位各判一次的壓 C。
   *
   * custom 為 true 時價格查自訂表、壓 C 用 state.penaltyBands；否則兩者
   * 都用官方的（原價、7~13 罰 5、14 以上罰 10）。
   *
   * ⚠ 不能改成叫遊戲自己的 Deck.getCost()：它讀的是快取裡**此刻**躺著的
   * 那種價，一次只算得出一種，而這裡要同時畫兩種。
   */
  function totalCost(content, custom) {
    if (!content) return null;
    var bands = custom && state.penaltyBands ? state.penaltyBands : CFG.officialBands;
    var slots = [];
    var total = 0;
    for (var i = 0; i < 3; i++) {
      var chara = content.chara ? content.chara[i] : null;
      if (chara === null || chara === undefined) continue;
      var hit = slotAsset(chara, content.charaIndex ? content.charaIndex[i] : null);
      var cost = hit === null
        ? CFG.unknownCost
        : priceOf(hit.table, hit.key, typeof hit.row.cost === "number" ? hit.row.cost : CFG.unknownCost, custom);
      slots.push(cost);
      total += cost;
    }
    for (var w = 0; w < 3; w++) {
      var wi = content.weapon ? content.weapon[w] : null;
      if (typeof wi !== "number") continue;
      var wrow = assetRow(CFG.itemAsset, CFG.itemField, wi);
      total += wrow === null
        ? CFG.unknownCost
        : priceOf("equipment", String(wi), typeof wrow.cost === "number" ? wrow.cost : CFG.unknownCost, custom);
    }
    for (var e = 0; e < (content.eventIndex ? content.eventIndex.length : 0); e++) {
      var ei = content.eventIndex[e];
      if (typeof ei !== "number") continue;
      var erow = assetRow(CFG.eventAsset, "frames", ei);
      total += erow === null
        ? CFG.unknownCost
        : priceOf("eventCards", String(ei), typeof erow.cost === "number" ? erow.cost : CFG.unknownCost, custom);
    }
    // 壓 C：**隊內每一對**各判一次，所以三個槽位最多罰三次。
    for (var a = 0; a < slots.length; a++) {
      for (var b = a + 1; b < slots.length; b++) {
        total += extraFor(bands, Math.abs(slots[a] - slots[b]));
      }
    }
    // ⚠ 自訂價可以是小數（13.2），浮點相加會得到 62.00000000000001。
    return Math.round(total * 100) / 100;
  }

  function extraFor(bands, gap) {
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      if (gap < band.minGap) continue;
      if (band.maxGap !== undefined && band.maxGap !== null && gap > band.maxGap) continue;
      return band.extraCost;
    }
    return 0;
  }

  /** 有沒有自訂表可以拿來算第二個數字。沒有就只畫官方那一個。 */
  function hasCustomCosts() {
    try {
      var st = window.${COST_PATCH_FLAG};
      if (!st || !st.customs) return false;
      for (var k in st.customs) {
        if (HAS.call(st.customs, k)) {
          for (var _ in st.customs[k]) return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * 一張卡面縮圖。**用遊戲自己的圖集**（cc_front / mc_front，每格
   * 168×240，框與底部那排標籤都烤在裡面）。
   *
   * ⚠ 格子**不能用 charaIndex 算** —— 圖集只有畫出來的那幾張（631 格 vs
   * cc_asset 的 781 筆）。鍵是 cc_asset.frames[charaIndex].filename，也就是
   * 規則用的同一個鍵。查不到就畫空槽底圖（ccframe_base 第 0 格）。
   */
  function cardThumb(sc, x, y, height, chara, index) {
    var hit = slotAsset(chara, index);
    var tm = sc.textures;
    var key = null, frame = null;
    if (hit !== null && tm && typeof tm.exists === "function") {
      var atlas = hit.table === "monsters" ? "mc_front" : "cc_front";
      if (tm.exists(atlas) && tm.get(atlas).has(hit.key)) { key = atlas; frame = hit.key; }
    }
    if (key === null) {
      if (!tm || typeof tm.exists !== "function" || !tm.exists("ccframe_base")) return null;
      key = "ccframe_base"; frame = 0;
    }
    var img = sc.add.image(x, y, key, frame).setOrigin(0, 0.5).setDepth(1502);
    // 168×240 的原圖照高度等比縮 —— 卡面比例不能歪，歪了一眼就看得出。
    img.setDisplaySize(Math.round(height * 168 / 240), height);
    return img;
  }

  /**
   * 幫我們建立的物件打標記。
   *
   * ⚠ 卸載時**不能只靠自己記的那份清單** —— 舊版腳本留下的孤兒物件不在新版的
   * 清單裡，畫面上就會疊出兩套選單（2026-08-24 實際撞到）。打了標記之後，
   * purge() 掃一次場景就能把任何版本留下的東西一起收掉。
   */
  function own(list) {
    list.forEach(function (o) { try { o.__ulrDeckOwned = true; } catch (e) {} });
    return list;
  }

  /** 掃掉場景裡所有屬於這個功能的物件，不管是哪個版本留下的。 */
  function purge(sc) {
    if (!sc || !sc.children) return 0;
    var doomed = sc.children.list.filter(function (o) { return o.__ulrDeckOwned; });
    doomed.forEach(function (o) { try { o.destroy(); } catch (e) {} });
    return doomed.length;
  }

  // ---- 牌組選單（規格 §5、§9、§10）--------------------------------------

  function closeMenu() {
    if (mounted && mounted.panel) {
      mounted.panel.forEach(function (o) { try { o.destroy(); } catch (e) {} });
      mounted.panel = null;
    }
  }

  /**
   * 標籤鍵 → 顯示字。
   *
   * ⚠ 牌組帶的是**鍵**（sea/fish/…），因為 promptBosses 要拿它跟 bossOptions
   * 的 key 比對才知道哪幾格是勾起來的。直接把鍵畫出來的話選單上會出現
   * 「seafish」，所以顯示一律走這支。對照表在狀態裡 —— 頁面不認得那些鍵。
   */
  function bossLabel(key) {
    for (var i = 0; i < state.bossOptions.length; i++) {
      if (state.bossOptions[i].key === key) return state.bossOptions[i].label;
    }
    return key;
  }

  /**
   * 一副牌在選單裡的樣子（2026-09-12 改版）。
   *
   *     ┌────┬────┬────┐  壓 C 用              ← 名字（套用中是黃的）
   *     │ 卡 │ 卡 │ 卡 │  標籤 海魚            ← 只有渦房
   *     └────┴────┴────┘  官方 110 自訂 106    ← 兩種總 COST
   *
   * 規格（玩家 2026-09-12 定）：**改名鈕拿掉**（改名改成點左下那行字就地
   * 改）、三張卡**之間不留間隙**、名字／標籤／COST 三行**全部擺在卡的右邊**，
   * 而且**一列最多就是卡的高度加一點點** —— 任何一行字都不准自己佔一列。
   */
  function openMenu(sc) {
    // ⚠ 可能被「已經卸載的舊腳本」留在 edit_icon 上的 handler 呼叫到，
    // 那時 mounted 已經是 null。見 mount() 裡對 iconHandler 的處理。
    if (!mounted) return;
    closeMenu();
    var objs = [];
    var rows = state.decks.length;
    var lang = gameLang();
    var isRaid = state.room === "raid";
    var showCustom = hasCustomCosts();

    // panel_gene 是 120×96 的九宮格，上邊框 63 下邊框 32 —— 內容不能貼著邊放，
    // 貼上去會被頂部那條裝飾吃掉（第一版的「牌組」標題就是這樣消失的）
    var rowH = ROW_H;
    // ⚠ 牌組一多就會頂出畫面上緣。那時候**把每一列縮小**，不要另開一頁或
    // 默默少畫幾副 —— 少畫的那幾副玩家永遠找不到，而他不會知道原因。
    var fits = 630 - 8 - PANEL_PAD;
    if (rows > 0 && rowH * rows > fits) rowH = Math.max(22, Math.floor(fits / rows));
    var cardH = rowH - 4;
    var cardW = Math.round(cardH * 168 / 240);
    var textX = 14 + cardW * 3 + 8;
    var w = textX + TEXT_W + 10;
    var h = Math.max(rowH * rows + PANEL_PAD, 116);
    var x = 8, y = 630 - h;

    // 擋住底下的點擊，跟遊戲自己的對話框一樣
    var blocker = sc.add.zone(0, 0, sc.scale.width, sc.scale.height)
      .setOrigin(0).setDepth(1500).setInteractive();
    blocker.on("pointerdown", function () { closeMenu(); });
    objs.push(blocker);

    var bg = sc.add.nineslice(x, y, "panel_gene", 0, w, h, 71, 40, 63, 32)
      .setOrigin(0).setDepth(1501);
    objs.push(bg);

    // 一列一副
    state.decks.forEach(function (deck, index) {
      var ry = y + 40 + index * rowH;
      var cy = ry + Math.floor(cardH / 2);
      var isActive = deck.id === state.activeId;
      var mine = [];

      // ⚠ 點擊範圍整列（卡片也算），但**不含標籤那一行** —— 那一行是另一顆
      // 按鈕，深度比較高，Phaser 只把事件給最上面那個，所以不會互吃。
      var hit = sc.add.zone(x + 10, ry, w - 20, rowH - 2).setOrigin(0)
        .setDepth(1502).setInteractive();
      mine.push(hit);

      // 三張卡，**之間不留間隙**（規格）。空槽畫遊戲自己的空槽底圖。
      var content = deck.content || null;
      for (var s = 0; s < 3; s++) {
        var thumb = cardThumb(
          sc,
          x + 14 + s * cardW,
          cy,
          cardH,
          content && content.chara ? content.chara[s] : null,
          content && content.charaIndex ? content.charaIndex[s] : null
        );
        if (thumb !== null) mine.push(thumb);
      }

      var lines = [];
      lines.push({
        text: deck.name,
        size: 12,
        font: isActive ? "font_heavy" : "font_light",
        color: isActive ? "#ffe08a" : "#ffffff"
      });
      if (isRaid) {
        lines.push({
          text: pick(CFG.tagTitle, lang) + " " +
            (deck.bosses.length ? deck.bosses.map(bossLabel).join("") : "—"),
          size: 10, font: "font_light", color: "#9fd0ff", tag: true
        });
      }
      // 哪一種 COST 是 Node 說的（見 DeckEditState.costDisplay）：PVE 房不畫，
      // 亞城畫官方，迪城畫自訂 —— 沒選規則時迪城退回官方，但**標籤照實寫**
      // 「官方」，不能寫著自訂卻給官方的數字。
      var mode = state.costDisplay || "official";
      if (mode !== "none") {
        var side = pick(CFG.sideLabel, lang);
        var useCustom = mode === "custom" && showCustom;
        var total = totalCost(content, useCustom);
        if (total !== null) {
          lines.push({
            text: (useCustom ? side.on : side.off) + " " + fmtCost(total),
            size: 10, font: "font_light", color: "#b9c6cf"
          });
        }
      }

      // 三行（渦房）或兩行，**垂直塞在這一列裡** —— 不另開一列。
      var step = lines.length > 2 ? 14 : 16;
      var top = cy - ((lines.length - 1) * step) / 2;
      lines.forEach(function (line, li) {
        var t = sc.add.text(x + textX, top + li * step, line.text, {
          fontFamily: line.font, fontSize: line.size, color: line.color
        }).setResolution(2).setOrigin(0, 0.5).setDepth(1503);
        if (line.tag) {
          t.setInteractive();
          t.on("pointerdown", function () { promptBosses(sc, deck); });
        }
        mine.push(t);
      });

      // 長按 HOLD_MS 進入拖曳排序（規格 §10）；短按就是選這一副（§5）
      //
      // ⚠ 拖的時候**整列一起動**（卡片也是）。只動那行字的話，玩家看到的是
      // 名字飄出了自己的卡片，看起來像畫壞了。
      var holdTimer = null, dragging = false, startY = 0;
      var baseY = mine.map(function (o) { return o.y; });
      function moveRow(dy) {
        mine.forEach(function (o, i) { try { o.setY(baseY[i] + dy); } catch (e) {} });
      }
      hit.on("pointerdown", function (p) {
        startY = p.y; dragging = false;
        holdTimer = setTimeout(function () { dragging = true; }, HOLD_MS);
      });
      hit.on("pointermove", function (p) {
        if (dragging) moveRow(p.y - startY);
      });
      hit.on("pointerup", function (p) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (dragging) {
          var moved = Math.round((p.y - startY) / rowH);
          var to = Math.max(0, Math.min(state.decks.length - 1, index + moved));
          if (to !== index) report({ type: "deck-move", id: deck.id, toIndex: to });
          else moveRow(0);
        } else {
          report({ type: "deck-select", id: deck.id });
          closeMenu();
        }
      });
      hit.on("pointerout", function () {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      });

      mine.forEach(function (o) { objs.push(o); });
    });

    // ⚠ 一副都沒有時才有這一行字。空面板看起來就是壞掉的，而「不准有字自己
    // 佔一列」說的是**牌組列**的版面 —— 這裡根本沒有牌組列。
    if (rows === 0) {
      objs.push(sc.add.text(x + 14, y + 44, "還沒有牌組，按 + 新增", {
        fontFamily: "font_light", fontSize: 12, color: "#cccccc"
      }).setResolution(2).setDepth(1503));
    }

    mounted.panel = own(objs);
  }

  /** 小數不要拖著一串零：13.20 → 13.2、110.00 → 110。 */
  function fmtCost(value) {
    return String(Math.round(value * 100) / 100);
  }

  /**
   * **就地改牌組名稱**：點左下那行字（原版的 deck1_name）直接編輯。
   *
   * 規格（玩家 2026-09-12）：「直接編輯 Deck1 來改牌組名稱，因為這是前世修改
   * 牌組名稱的方式」。所以選單裡那顆「改名」鈕拿掉了，改名只有這一條路。
   *
   * 樣子是**透明無框**、字型與大小照抄原版那行字（font_heavy 20 斜體），
   * 玩家看起來就是那行字變成可以打的。輸入時把原版那行字藏起來，不然兩份
   * 疊在一起。
   *
   * ⚠ 改的是**套用中那一副**（activeId）—— 那行字寫的就是它。沒有套用中的
   * 那一副時什麼都不做：沒有東西可以改名，開一個輸入框只會讓玩家打了半天
   * 之後發現沒有存進任何地方。
   */
  function startInlineRename(sc) {
    if (!mounted || mounted.rename) return;
    var target = null;
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === state.activeId) target = state.decks[i];
    }
    if (target === null) return;
    var name = sc.deck1_name;
    if (!name) return;
    try {
      var Input = window.RexPlugins && window.RexPlugins.UI && window.RexPlugins.UI.InputText;
      if (!Input) { fail("改名", new Error("這個客戶端沒有 rexUI 的 InputText")); return; }
      var box = new Input(sc, name.x, name.y, 200, 26, {
        type: "text",
        text: target.name,
        fontFamily: "font_heavy",
        fontSize: "20px",
        fontStyle: "italic",
        color: "#ffffff",
        // 透明無框 —— 規格要「沒框透明背景那種」。
        backgroundColor: "transparent",
        border: 0,
        align: "left",
        maxLength: 24
      });
      sc.add.existing(box);
      box.setOrigin(0, 0).setDepth(1600);
      name.setVisible(false);
      mounted.rename = box;
      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        var value = String(box.text || "").trim();
        try { box.destroy(); } catch (e) {}
        if (mounted) mounted.rename = null;
        try { name.setVisible(true); } catch (e) {}
        // ⚠ 空白不送。送過去會變成一副沒有名字的牌，而選單上就是一列空的。
        if (commit && value.length > 0 && value !== target.name) {
          report({ type: "deck-rename", id: target.id, name: value });
        }
      }
      // Enter 收下、Esc 放棄、點到別的地方（blur）也收下 —— 沒有 blur 這條路
      // 的話玩家打完去點別的東西，輸入框會留在畫面上。
      box.on("keydown", function (_box, e) {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      box.on("blur", function () { finish(true); });
      box.setFocus();
    } catch (e) { fail("改名", e); }
  }

  /**
   * 渦 BOSS 標籤：勾這副打得動哪幾種。
   *
   * 一副可以掛多個 —— 同一副牌打得動海也打得動魚是常態，所以是多選不是單選。
   */
  function promptBosses(sc, deck) {
    try {
      var picked = {};
      deck.bosses.forEach(function (b) { picked[b] = true; });
      var objs = [];
      // ⚠⚠ panel_gene 的上邊框 63px、下邊框 32px 是**不縮放**的（九宮格），所以
      // 130 高的面板深色可用區只有 35px —— 第一版的標題落在白色的上邊框裡
      // （白字配白底，看不見），ok/cancel 又壓在下邊框上（2026-09-12 回報）。
      // 現在：面板 200 高，深色區 = 240+63 → 303 到 408，三排東西都放在裡面。
      var PH = 200, top = 340 - PH / 2, body = top + 63;
      objs.push(sc.add.nineslice(380, 340, "panel_gene", 0, 320, PH, 71, 40, 63, 32)
        .setDepth(1801));
      objs.push(sc.add.text(380, body + 14, pick(CFG.bossTitle, gameLang()), {
        fontFamily: "font_heavy", fontSize: 13, color: "#ffffff"
      }).setResolution(2).setOrigin(0.5).setDepth(1802));

      var opts = state.bossOptions;
      var rowY = body + 46;
      var startX = 380 - (opts.length * 46) / 2 + 23;
      opts.forEach(function (opt, i) {
        var cx = startX + i * 46;
        var box = sc.add.image(cx, rowY, "btn_gene", picked[opt.key] ? 1 : 0)
          .setScale(0.5, 1.1).setDepth(1802).setInteractive();
        var txt = sc.add.text(cx, rowY, opt.label, {
          fontFamily: "font_heavy", fontSize: 15, color: picked[opt.key] ? "#ffffff" : "#000000"
        }).setResolution(2).setOrigin(0.5).setDepth(1803);
        box.on("pointerdown", function () {
          picked[opt.key] = !picked[opt.key];
          box.setTexture("btn_gene", picked[opt.key] ? 1 : 0);
          txt.setColor(picked[opt.key] ? "#ffffff" : "#000000");
          try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        });
        objs.push(box, txt);
      });

      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        objs.forEach(function (o) { try { o.destroy(); } catch (e) {} });
        ok.destroy(); cancel.destroy();
        if (!commit) return;
        var out = [];
        opts.forEach(function (o) { if (picked[o.key]) out.push(o.key); });
        report({ type: "deck-bosses", id: deck.id, bosses: out });
      }
      var btnY = body + 86;
      var ok = button(sc, 340, btnY, "ok", function () { finish(true); });
      var cancel = button(sc, 420, btnY, "cancel", function () { finish(false); });
      ok.img.setDepth(1802); ok.txt.setDepth(1803);
      cancel.img.setDepth(1802); cancel.txt.setDepth(1803);
    } catch (e) { fail("標籤", e); }
  }

  // ---- 掛載 ---------------------------------------------------------------

  function currentRoomLabel() {
    for (var i = 0; i < state.rooms.length; i++) {
      if (state.rooms[i].key === state.room) return state.rooms[i].label;
    }
    return state.room;
  }

  /**
   * 把原版 ◀▶ 的行為裝回去。
   *
   * ⚠ **照抄 2026-08-28 從實機讀到的 create() 那兩段**：換 deck_now（1..3 循環）
   * → switch_decks 播動畫 → edit_reflesh 重畫。少了這一步，插件關掉之後那兩個
   * 箭頭是死的，而且要等玩家離開牌組畫面再進來（場景重建）才會回來。
   */
  function restoreArrows(sc) {
    [["deck_pre", -1], ["deck_next", 1]].forEach(function (pair) {
      var obj = sc[pair[0]];
      if (!obj || typeof obj.off !== "function") return;
      try { obj.off("pointerdown"); } catch (e) {}
      obj.on("pointerdown", function () {
        try {
          sc.sort_panel.visible = false;
          sc.filter_panel.visible = false;
          if (sc.ulse01) sc.ulse01.play();
          obj.setTexture("edit_arrow", 0);
          var t = sc.deck_now + pair[1];
          if (t < 1) t = 3;
          if (t > 3) t = 1;
          sc.switch_decks(t);
          sc.deck_now = t;
          sc.edit_reflesh();
        } catch (e) {}
      });
    });
  }

  function unmount() {
    closeMenu();
    if (mounted) {
      // 就地改名的輸入框收掉，並把原版那行字放回來 —— 少了這一步，切場景時
      // 會留下一個浮在畫面上、打字沒有人收的輸入框，而那行字永遠是隱形的。
      if (mounted.rename) {
        try { mounted.rename.destroy(); } catch (e) {}
        mounted.rename = null;
      }
      try {
        if (mounted.scene && mounted.scene.deck1_name) mounted.scene.deck1_name.setVisible(true);
      } catch (e) {}
      // 先把掛在遊戲自己物件上的 handler 收回來（見 mount() 的 ⚠）
      if (mounted.icon && mounted.iconHandler) {
        try { mounted.icon.off("pointerdown", mounted.iconHandler); } catch (e) {}
      }
      // ⚠ 同理：掛在 deck1_name／sort_rect／filter_rect 上的那幾個。它們都是
      // **遊戲自己的**物件，活得比我們久 —— 不收的話每重掛一次就多一個，而
      // 舊的那些持有已經是 null 的 mounted。
      (mounted.foreign || []).forEach(function (f) {
        try { f.obj.off(f.event, f.handler); } catch (e) {}
      });
      // ◀▶ 原本就有行為，要還回去，不能留成死鈕。
      //
      // ⚠ **只有編輯畫面要還原。** restoreArrows() 裝回去的是 Edit 的行為
      // （switch_decks / edit_reflesh），而房間場景根本沒有那些方法；更重要的
      // 是房裡的原版行為就是那個 bug 本身（切到已經被清空的 Deck2/Deck3），
      // 還原回去等於把它裝回來。房裡的箭頭跟著場景 shutdown 一起消失，
      // 不會留下死鈕。
      if (mounted.arrows && mounted.scene && !mounted.room) {
        try { restoreArrows(mounted.scene); } catch (e) {}
      }
      mounted.objects.forEach(function (o) { try { o.destroy(); } catch (e) {} });
      // 再掃一次場景，收掉沒記在清單裡的（含舊版腳本留下的孤兒）
      try { purge(mounted.scene); } catch (e) {}
      mounted = null;
    }
  }

  // isRoom = 掛在任務／渦／對戰房，不是牌組編輯畫面。
  function mount(sc, isRoom) {
    unmount();
    var objs = [];
    // foreign 記的是掛在**遊戲自己的**物件上的 handler（牌盒、那行牌組名、
    // 遊戲的兩個下拉）。它們不會跟著我們的物件被 destroy，卸載時要逐個收回。
    mounted = { scene: sc, objects: objs, panel: null, room: !!isRoom, foreign: [], rename: null };

    // 1. 棕色皮牌盒圖示變成可點（規格 §5）。它原本沒有 input。
    var icon = null;
    sc.children.list.forEach(function (o) {
      if (o.texture && o.texture.key === "edit_icon" && Math.round(o.y) === 644) icon = o;
    });

    // ⚠⚠ 渦房那一排**沒有這顆圖示**（Raid.create() 裡根本沒有 edit_icon，
    // 2026-09-09 讀原始碼確認），所以找不到就自己補一顆 —— 不補的話渦房沒有
    // 任何地方點得開選單。位置取兩顆箭頭的正中間：渦房是 (16+48)/2 = 32，
    // 跟任務房與編輯畫面擺的位置一樣；Match 是 (396+428)/2 = 412，而那裡本來
    // 就有一顆，所以走不到這裡。
    //
    // ⚠ 補出來的這顆是**我們的**，要進 objs 跟著卸載一起收掉；下面那段
    // icon.off("pointerdown") 對它是空操作（剛建出來，還沒有任何 handler）。
    if (icon === null) {
      try {
        var pre = sc.deck_pre, nxt = sc.deck_next;
        if (pre && nxt && typeof pre.x === "number" && typeof nxt.x === "number") {
          icon = sc.add.sprite(Math.round((pre.x + nxt.x) / 2), 644, "edit_icon");
          objs.push(icon);
        }
      } catch (e) {
        // 貼圖不在、或場景正在拆 —— 沒有圖示就是沒有選單，其餘功能照常。
        icon = null;
      }
    }

    if (icon) {
      if (!icon.input) icon.setInteractive();
      // ⚠ edit_icon 是**遊戲自己的**物件，不會跟著我們的東西被 destroy ——
      // 掛上去的 handler 得自己收。少了這一步，每重掛一次就多一個 handler，
      // 而卸載後留下的那些拿到的 mounted 是 null。
      // ⚠ 這整段是 template literal，註解裡**不能出現反引號**（會提前收尾）。
      //
      // 這裡連「別人留下的」一起清：舊版腳本卸載時沒收乾淨的 handler 會活到
      // 下次重載遊戲，而它們持有自己那份已經是 null 的 mounted，一點就炸。
      // 原版的 edit_icon 是純裝飾（連 input 都沒有），所以清光不會誤刪遊戲的東西。
      try { icon.off("pointerdown"); } catch (e) {}
      var iconHandler = function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        if (mounted && mounted.panel) closeMenu(); else openMenu(sc);
      };
      icon.on("pointerdown", iconHandler);
      mounted.icon = icon;
      mounted.iconHandler = iconHandler;
    }

    // 2. + - （規格 §9），放在 deck_next(48,644) 右邊。
    //
    // 樣子**照抄 reset**（規格：2026-09-12 玩家要求），見 {@link plainButton}。
    // 拼出來那顆是 24 寬，所以兩顆的中心差 26 —— 差 24 以下會黏在一起。
    //
    // ⚠ **房裡不畫這兩顆。** 那個位置（x 74/100）在任務房是牌組名那行字
    // （實機量到 Text 在 64,644），畫下去會疊在一起。而且新增／刪除牌組是
    // 管理動作，屬於編輯畫面 —— 站在任務房裡誤按一下「-」不該把一副牌刪掉。
    if (!isRoom) {
      var plus = plainButton(sc, 74, 644, "+", function () { report({ type: "deck-add" }); });
      var minus = plainButton(sc, 100, 644, "-", function () {
        if (state.activeId) report({ type: "deck-remove", id: state.activeId });
      });
      objs.push(plus.img, plus.txt, minus.img, minus.txt);
    }

    // 3. 房間切換（規格 §7），接在「排列(升序)」底下，**同一套下拉選單**。
    //
    // 2026-09-12 改版：原本是一顆 btn_gene，按一下換下一房（roomCycle）。
    // 玩家要的是跟旁邊那格一樣的下拉 —— 一顆循環鈕看不出總共有哪幾房，
    // 要切到第三房得按三次，而且每一次都真的換了一次牌組。
    //
    // ⚠⚠ **房裡不畫這一格**，兩個獨立的理由：
    //
    // 1. (448, 500) 在編輯畫面是「排列(升序)」底下的空位，在任務房那裡是**地圖
    //    正中央** —— 畫下去就是一顆浮在地圖上的按鈕。
    // 2. 更重要：站在任務房裡把它切成「迪特赫姆」之後，房裡那組 ◀▶ 會開始切
    //    迪城的牌組，而玩家按 START 打的是任務 —— 那正是**拿錯牌組上場**。
    //    人在哪一房，就只該看得到那一房的牌（進房時 enterRoom 自己會切）。
    if (!isRoom) {
      // ⚠ padding.right 不能省：斜體會往右斜出量測寬度，Phaser 的文字畫布照
      // 量測寬度裁，於是最後那個字的右邊被切掉（2026-09-12 回報「間」少一截）。
      // 旁邊「排列(升序)」同樣的設定看不出來，是因為它最後一個字是半形括號。
      objs.push(sc.add.text(ROOM_LABEL_XY[0], ROOM_LABEL_XY[1], pick(CFG.roomTitle, gameLang()), {
        fontFamily: "font_heavy", fontSize: 15, resolution: 2, fontStyle: "Italic",
        padding: { right: 6 }
      }).setResolution(2).setOrigin(0, 0).setDepth(0));
      var dd = dropdown(sc, {
        x: ROOM_RECT_XY[0],
        y: ROOM_RECT_XY[1],
        value: currentRoomLabel(),
        options: state.rooms,
        onPick: function (key) {
          try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
          if (key !== state.room) report({ type: "room-switch", room: key });
        }
      });
      if (dd !== null) {
        dd.objects.forEach(function (o) { objs.push(o); });
        mounted.roomDrop = dd;
      }
      // 遊戲自己那兩格被點開時，我們這一格要收起來 —— 原版三格彼此互斥，
      // 少了這一步會有兩個面板同時攤在同一塊地方。
      [sc.sort_rect, sc.filter_rect].forEach(function (r) {
        if (!r || typeof r.on !== "function" || dd === null) return;
        var h = function () { dd.close(); };
        r.on("pointerdown", h);
        mounted.foreign.push({ obj: r, event: "pointerdown", handler: h });
      });
    }

    // 3.2 左下那行牌組名變成**可以點的**（規格：2026-09-12 就地改名）。
    //
    // ⚠ 房裡不給點。那行字在房裡是 deck_name，而房間場景沒有 rexUI 的
    // InputText 的擺放空間（那一排右邊就是「輸入Raid代碼」），而且改名是管理
    // 動作 —— 跟 +／- 同一個理由。
    if (!isRoom && sc.deck1_name && typeof sc.deck1_name.setInteractive === "function") {
      var nameObj = sc.deck1_name;
      if (!nameObj.input) nameObj.setInteractive();
      // ⚠ 這是**遊戲自己的**物件，handler 不會跟著我們的東西被 destroy ——
      // 得自己收，否則每重掛一次就多一個（見底下 edit_icon 那段的說明）。
      var nameHandler = function () { startInlineRename(sc); };
      nameObj.on("pointerdown", nameHandler);
      mounted.foreign.push({ obj: nameObj, event: "pointerdown", handler: nameHandler });
    }

    // 3.5 ◀▶ 改成切**自訂**牌組
    //
    // ⚠ 原版那兩個箭頭在 1/2/3 之間換 this.deck_now，而 deck_now 決定兩件事：
    // Edit 畫面正在編輯哪一副、以及開戰時送出去的是哪一副。牌組庫把 **Deck1
    // 當唯一的工作槽**（伺服器那三格之後只會有第一格有東西），所以讓玩家切到
    // 2/3 只會讓他編輯一副即將被清空的牌 —— 那些編輯之後會無聲消失。
    //
    // ⚠ 這兩個箭頭跟 edit_icon 不一樣：**它們原本就有行為**，不是純裝飾。
    // 所以卸載時要把原版行為裝回去（unmount 裡那段），不能就這樣讓它變成死鈕。
    var arrows = [];
    [["deck_pre", -1], ["deck_next", 1]].forEach(function (pair) {
      var obj = sc[pair[0]];
      if (!obj || typeof obj.off !== "function") return;
      // ⚠⚠ **pointerup 也要拆，不能只拆 pointerdown。**
      //
      // 編輯畫面的箭頭把行為掛在 pointerdown，但**任務房掛的是 pointerup**
      // （2026-09-09 實機讀到的）。只拆 pointerdown 的話，房裡會變成兩邊同時
      // 觸發：我們的換牌組跑了，遊戲原本那個 deck_now++ 也跑了 —— 玩家看到的
      // 就是「標籤跳成 Deck2／Deck3、牌卻沒換」。
      //
      // ⚠ pointerover / pointerout 不能拆，那是箭頭的 hover 換圖。
      try { obj.off("pointerdown"); } catch (e) {}
      try { obj.off("pointerup"); } catch (e) {}
      var handler = function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        try { obj.setTexture("edit_arrow", 0); } catch (e) {}
        // 原版會順手收起這兩個面板，照抄 —— 少了它，換牌組時面板會浮在上面
        // （房間場景沒有這兩個面板，try 吞掉就好）
        try { sc.sort_panel.visible = false; sc.filter_panel.visible = false; } catch (e) {}
        // ⚠ from 要帶。房裡那組切的是「玩家人在的那一房」，編輯畫面那組切的是
        // 「選單現在看的那一房」，兩者可以不一樣，切錯就是拿錯牌組上場。
        report({ type: "deck-cycle", delta: pair[1], from: isRoom ? "room" : "menu" });
      };
      obj.on("pointerdown", handler);
      arrows.push({ obj: obj, handler: handler });
    });
    mounted.arrows = arrows;

    // ⚠ 釘死在 1。玩家可能在我們掛上去之前就用原版箭頭切到 2 或 3 了，那時
    // 畫面上顯示與編輯的都是 Deck2 —— 而我們寫的一直是 Deck1。
    try { sc.deck_now = 1; } catch (e) {}
    // ⚠ 標籤也要跟著回來。原版箭頭改的是 deck_now **和**那行字，只把數字釘回
    // 去的話，畫面上會留著一個「Deck2」指著其實是 Deck1 的內容。
    // 真正的牌組名之後會由 buildEditDeckWriteExpression() 覆蓋上去。
    try {
      if (isRoom && sc.deck_name && typeof sc.deck_name.setText === "function") {
        sc.deck_name.setText("Deck1 ");
      }
    } catch (e) {}

    // ⚠ 這裡原本有第 4 項：一行紅字訊息，畫在 (286,644)。**已經移除，不要
    // 加回來** —— 它在渦房會壓到遊戲的「輸入Raid代碼」，而且說的事情畫面上
    // 本來就看得到。理由完整寫在 DeckEditState 那邊。訊息改走托盤的記錄。

    // 「這個場景還是不是掛上去時那一代」的錨。輪詢拿它判斷要不要重掛。
    //
    // ⚠⚠ **不能拿 objs[0] 當錨。** 任務房／對戰房裡 objs 是**空的**（牌盒是遊戲
    // 的、＋－與房間那一格房裡不畫），於是「objs[0] 還活著嗎」永遠答不了 →
    // 每 500ms 重掛一次 → 玩家一打開選單半秒就被 unmount 收掉。2026-09-12
    // 回報「任務房／對戰房的牌盒只顯示 0.5 秒」就是這個；渦房沒事只是因為
    // 我們在那裡補了一顆牌盒進清單。
    //
    // 牌盒四個場景都有（渦房是我們補的），它跟著場景重建一起死，正好當錨。
    // 沒有牌盒的話退回箭頭（遊戲的物件，同樣跟著場景死），再沒有才用 objs[0]。
    mounted.anchor = icon || sc.deck_pre || objs[0] || null;

    own(objs);
    redraw();
  }

  /** 套用中那一副的名字。沒有就退回原版的「Deck1」。 */
  function activeName() {
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === state.activeId) return state.decks[i].name;
    }
    return "Deck1";
  }

  function redraw() {
    if (!mounted) return;
    try {
      if (mounted.roomDrop) mounted.roomDrop.setValue(currentRoomLabel());
      // 牌組名那一格改成顯示**自訂牌組**的名字（原版寫死「Deck1」）。
      // ⚠ 這是玩家唯一看得出「◀▶ 現在切的是我的牌組」的地方 —— 少了它，
      // 按箭頭時畫面上的牌變了、標題卻永遠寫著 Deck1，看起來像壞掉。
      //
      // ⚠⚠ 編輯畫面是 deck1_name，**房裡是 deck_name** —— 兩個不同的物件
      // （房間場景沒有 deck1_name，實機確認）。原本只改前者，所以任務房／渦房
      // 那行字永遠停在「Deck1」，而底下擺的其實是別副牌：2026-09-09 回報的
      // 「顯示牌組一、但這副在渦房是牌組三」就是這個。
      //
      // ⚠ 這裡是**唯一**該負責那行字的地方。原本它靠寫入端順手帶一個 label
      // 過去，於是沒帶名字的那條路（三秒後的提交）就把字留在舊的 —— 顯示跟
      // 著狀態走才不會有這種「看哪條路徑跑過」的差別。尾巴那個空格是照抄原版
      // 的格式（遊戲自己寫的是 "Deck1 "）。
      try {
        var sc = mounted.scene;
        if (sc && sc.deck1_name) sc.deck1_name.setText(activeName());
        if (mounted.room && sc && sc.deck_name && typeof sc.deck_name.setText === "function") {
          sc.deck_name.setText(activeName() + " ");
        }
      } catch (e) { /* 場景正在拆 */ }
      if (mounted.panel) openMenu(mounted.scene); // 選單開著就重畫
    } catch (e) { fail("重畫", e); }
  }

  // 這個場景有沒有畫著那一排牌組列。
  // ⚠ 認的是**物件在不在**，不是場景叫什麼名字：場景還在載入時 children 是空的，
  // 那時候掛上去會找不到東西，然後那一次 mount 就白做了。
  //
  // ⚠⚠ 認的是**箭頭**，不是棕色牌盒 —— 渦房只有箭頭，沒有牌盒（見檔頭）。
  // 原本只認牌盒的版本在渦房永遠回 false，於是那一房從來沒掛上過。
  // edit_icon 也一起認，是為了不讓 Match 出現回歸：它的箭頭是遊戲自訂的按鈕
  // 類別（new o.ae(...)），不保證以 edit_arrow 的身分出現在 children.list 裡，
  // 而它的牌盒 (412,644) 是確定在的。
  function hasDeckRow(sc) {
    if (!sc || !sc.children) return false;
    var list = sc.children.list;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o.texture || Math.round(o.y) !== 644) continue;
      if (o.texture.key === "edit_icon" || o.texture.key === "edit_arrow") return true;
    }
    return false;
  }

  // 現在該把選單掛在哪個場景上。回 null = 玩家不在任何有牌組列的畫面。
  // ⚠ Edit 優先：玩家人在編輯畫面時，那裡才是他在操作的地方。
  function deckScene() {
    var g = window.game;
    if (!g) return null;
    var ed = g.scene.keys.Edit;
    if (ed && ed.scene.isActive()) return { sc: ed, room: false };
    // ⚠⚠ 一定要 JSON.parse。embedJson() 給的是「要餵給 JSON.parse 的字串字面
    // 值」—— 直接用的話 rooms 是一個**字串**，rooms[i] 取到的是單一字元，
    // 於是永遠找不到場景、選單永遠掛不上，而且完全不會報錯。
    var rooms = JSON.parse(${embedJson([...ROOM_SCENES])});
    for (var i = 0; i < rooms.length; i++) {
      var sc = g.scene.keys[rooms[i]];
      if (sc && sc.scene.isActive() && hasDeckRow(sc)) return { sc: sc, room: true };
    }
    return null;
  }

  /**
   * 渦房裡「現在選中哪個渦」—— 換了就回報 raid-pick，托盤照 BOSS 標籤換牌組
   * （玩家 2026-09-13 要的）。
   *
   * 選中 = 詳細面板 raid_info 開著、raid_idx 指著 raid_data 的那一列（點清單
   * 列與點地圖渦都走同一個 raid_list_pointerup，2026-09-13 實機讀的）。沒有
   * 可以包的函式（見 patch-raid-view 檔頭：閉包建的），所以跟著輪詢看。
   *
   * ⚠ 只在**換了一個渦**時報一次，不是每一拍都報：面板開著的時候每拍都報的
   * 話，玩家選中龜之後手動換成別副，半秒後就被換回去。面板關掉時
   * 記憶清成 null，所以關掉再點同一個渦會再套一次 —— 那是玩家又點了一次。
   *
   * ⚠ 認的是**場景上有沒有 raid_info／raid_data**，不是場景鍵叫 Raid：
   * 跟 hasDeckRow 同一個理由，認物件不認名字。
   */
  var lastRaidPick = null;
  function watchRaidPick(sc) {
    if (!sc || !sc.raid_info || !sc.raid_data || typeof sc.raid_data.length !== "number") return;
    var row = null;
    if (sc.raid_info.visible && typeof sc.raid_idx === "number") row = sc.raid_data[sc.raid_idx] || null;
    var mons = row && typeof row.profound_mons === "string" ? row.profound_mons : null;
    var key = mons === null ? null : String(row.profound_id) + "|" + mons;
    if (key === lastRaidPick) return;
    lastRaidPick = key;
    if (mons !== null) report({ type: "raid-pick", mons: mons });
  }

  function tick() {
    try {
      var hit = deckScene();
      if (hit === null) { if (mounted) unmount(); return; }
      if (hit.room) watchRaidPick(hit.sc);
      // 場景重建過的話，我們掛的東西已經跟著舊場景被 destroy
      //
      // ⚠⚠ **不能只比場景物件是不是同一個。** Phaser 的 game.scene.keys.Quest
      // 是一個**長命的 Scene 實例**：玩家離開再進來只是重跑一次 create()，
      // 場景物件本身沒換，但底下的 GameObject 全部是新的。只比場景的話，
      // 第二次進房就不會重掛 —— 症狀是「箭頭又變回遊戲原本的行為了」。
      // 所以下面那個 anchor.scene 的檢查是**必要條件**，不是保險。
      //
      // ⚠ 檢查的是「錨**有**但已經死了」，不是「沒有錨」。寫成 !mounted.anchor
      // 的話，任何一個掛得上但找不到錨的場景都會**每 500ms 重掛一次** ——
      // 而重掛會把打開的選單收掉（見 mount() 裡 anchor 那段的 2026-09-12 回報）。
      if (
        !mounted ||
        mounted.scene !== hit.sc ||
        (mounted.anchor && !mounted.anchor.scene)
      ) {
        mount(hit.sc, hit.room);
      }
    } catch (e) { fail("輪詢", e); }
  }

  timer = setInterval(tick, ${pollMs});
  tick();

  window.${FLAG} = {
    version: VERSION,
    setState: function (next) { state = next; redraw(); },
    isMounted: function () { return mounted !== null; },
    // 一副牌的總 COST（官方或自訂），從遊戲快取算 —— 見 totalCost。
    // 房間場景（Match/Quest/Raid）的 cost:NN 讀的是 deck.cost，而托盤換牌時
    // 那一格被填 0，所以 deck-write 換完會回來叫這支把真的數字補上。
    // 算不出來回 null，呼叫端就維持原本的值。
    costFor: function (content, custom) {
      try { return totalCost(content, custom === true); } catch (e) { return null; }
    },
    uninstall: function () {
      if (timer) { clearInterval(timer); timer = null; }
      unmount();
      window.${FLAG} = undefined;
    }
  };
  return "installed";
})()`;
}

/**
 * 把新狀態推給頁面。
 *
 * 回 `"ok"` 才算推成功。另外兩種都表示**呼叫端要重裝**：
 *
 * ```
 *   not-installed        頁面上沒有腳本（遊戲重載過）
 *   stale:<頁面的版本>   有，但不是這一版 —— 托盤換了新版而遊戲沒重載
 * ```
 *
 * ⚠ `stale` 這條路是 2026-09-09 加的，而它擋下的正是那天最難認的一個 bug：
 * 發了新版、程式碼也確實換了，但頁面上活著的是**上一個托盤**裝的腳本，於是
 * 功能整個沒生效而所有版本號看起來都是新的。細節在
 * {@link DECK_EDIT_SCRIPT_VERSION}。
 *
 * ⚠ 版本不對時**不推狀態就直接回報**：那份狀態馬上要被重裝蓋掉，推過去只是
 * 讓舊腳本多畫一次。
 */
export function buildDeckEditStateExpression(state: DeckEditState): string {
  return `(function () {
  var api = window.${FLAG};
  if (!api) return "not-installed";
  if (String(api.version) !== ${JSON.stringify(DECK_EDIT_SCRIPT_VERSION)}) {
    return "stale:" + String(api.version);
  }
  api.setState(JSON.parse(${embedJson(state)}));
  return "ok";
})()`;
}

/** 拆掉。 */
export const DECK_EDIT_UNINSTALL_EXPRESSION = `(function () {
  var api = window.${FLAG};
  if (!api) return "not-installed";
  api.uninstall();
  return "uninstalled";
})()`;

/** 現在裝了沒、掛上去了沒。 */
export const DECK_EDIT_STATUS_EXPRESSION = `(function () {
  var api = window.${FLAG};
  if (!api) return JSON.stringify({ installed: false, mounted: false, version: null });
  return JSON.stringify({
    installed: true,
    mounted: api.isMounted(),
    version: api.version
  });
})()`;

export interface DeckEditStatus {
  installed: boolean;
  /** UI 是不是真的畫在畫面上（玩家在 Edit 畫面才會是 true）。 */
  mounted: boolean;
  /**
   * 頁面上那份腳本的指紋。呼叫端拿它跟 {@link DECK_EDIT_SCRIPT_VERSION} 比
   * —— **不一樣就要重裝**，否則托盤換了新版而遊戲沒重載時，頁面會一直跑舊的。
   *
   * ⚠ 舊版腳本回的是數字（手動維護的那個號碼）。那也算「不一樣」，會被重裝
   * 掉，正是我們要的 —— 所以這裡不擋型別，非字串一律當 `null`。
   */
  version: string | null;
}

export function parseDeckEditStatus(raw: string): DeckEditStatus {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      installed: data.installed === true,
      mounted: data.mounted === true,
      version: typeof data.version === "string" ? data.version : null,
    };
  } catch {
    return { installed: false, mounted: false, version: null };
  }
}
