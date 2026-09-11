/**
 * 牌組庫的遊戲內介面（WP-18）
 * ============================
 * 規格 §3：**全部做在遊戲畫面裡，托盤視窗一個字都不加。**
 *
 * 動到的都是牌組編輯（`Edit`）畫面左下角那一排，以及右邊「排列(升序)」底下：
 *
 * ```
 *   ◀ [牌盒] ▶  + -            ← deck_pre(16,644) / edit_icon(32,644) / deck_next(48,644)
 *   ↑ 原本切 Deck1/2/3        ＋我們加的：牌盒點開選單、加減牌組
 *
 *   排列(升序)  [ID    ▾]      ← sort_rect(510,480)
 *   房間        [迪特赫姆 ▾]   ← 我們加的（規格 §7），畫在它正下方
 * ```
 *
 * ## 三個「照抄」，跟 patch-lobby 同一套規矩
 *
 * 1. **貼圖用遊戲自己的**（`panel_gene`、`btn_gene`、`edit_arrow`）。自己畫一個
 *    會馬上被看出是外掛的東西。
 * 2. **字型用遊戲自己的**（`font_heavy` / `font_light`），大小抄旁邊的元件。
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
import { embedJson } from "./embed.js";

/** 畫在選單裡的一副牌組。**只有畫出來要用的欄位**，牌組內容不下放到頁面。 */
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
   * ⚠ 「房間」鈕就照這個陣列循環，**頁面不自己寫死房型清單** —— 寫死的話
   * 之後改房型就得同時改兩個地方，而漏掉的那邊沒有測試會抓到。
   */
  rooms: { key: string; label: string }[];
  /** 這一房的牌組，順序就是玩家排的順序。 */
  decks: DeckEditItem[];
  /** 現在套用中的是哪一副。沒有就是 `null`。 */
  activeId: string | null;
  /** 渦 BOSS 標籤的選項，`{ key, label }`。 */
  bossOptions: { key: string; label: string }[];
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
  return `(function () {
  var BINDING = ${JSON.stringify(options.bindingName)};
  var VERSION = ${JSON.stringify(version)};
  var HOLD_MS = ${holdMs};

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

  function openMenu(sc) {
    // ⚠ 可能被「已經卸載的舊腳本」留在 edit_icon 上的 handler 呼叫到，
    // 那時 mounted 已經是 null。見 mount() 裡對 iconHandler 的處理。
    if (!mounted) return;
    closeMenu();
    var objs = [];
    var rowH = 26;
    var rows = state.decks.length;
    // panel_gene 是 120×96 的九宮格，上邊框 63 下邊框 32 —— 內容不能貼著邊放，
    // 貼上去會被頂部那條裝飾吃掉（第一版的「牌組」標題就是這樣消失的）
    var h = Math.max(rowH * rows + 76, 116);
    // 渦房那一列多一個「標籤」鈕，面板要寬一點才擺得下
    var isRaid = state.room === "raid";
    var w = isRaid ? 252 : 210;
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
      var hit = sc.add.zone(x + 10, ry - 2, w - (isRaid ? 104 : 60), rowH - 2).setOrigin(0)
        .setDepth(1502).setInteractive();
      var isActive = deck.id === state.activeId;
      var name = deck.name + (deck.bosses.length ? "  " + deck.bosses.map(bossLabel).join("") : "");
      var txt = sc.add.text(x + 14, ry, name, {
        fontFamily: isActive ? "font_heavy" : "font_light",
        fontSize: 13,
        color: isActive ? "#ffe08a" : "#ffffff"
      }).setResolution(2).setDepth(1503);
      objs.push(hit, txt);

      // 長按 HOLD_MS 進入拖曳排序（規格 §10）；短按就是選這一副（§5）
      var holdTimer = null, dragging = false, startY = 0;
      hit.on("pointerdown", function (p) {
        startY = p.y; dragging = false;
        holdTimer = setTimeout(function () {
          dragging = true;
          txt.setColor("#7ec8ff");
        }, HOLD_MS);
      });
      hit.on("pointermove", function (p) {
        if (dragging) txt.setY(p.y - 8);
      });
      hit.on("pointerup", function (p) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (dragging) {
          var moved = Math.round((p.y - startY) / rowH);
          var to = Math.max(0, Math.min(state.decks.length - 1, index + moved));
          if (to !== index) report({ type: "deck-move", id: deck.id, toIndex: to });
          else { txt.setY(ry); txt.setColor(isActive ? "#ffe08a" : "#ffffff"); }
        } else {
          report({ type: "deck-select", id: deck.id });
          closeMenu();
        }
      });
      hit.on("pointerout", function () {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      });

      // 改名（規格 §6、§8）
      var ren = sc.add.text(x + w - 44, ry, "改名", {
        fontFamily: "font_light", fontSize: 11, color: "#9fd0ff"
      }).setResolution(2).setDepth(1503).setInteractive();
      ren.on("pointerdown", function () { promptRename(sc, deck); });
      objs.push(ren);

      // 渦 BOSS 標籤 —— 只有渦房才有意義
      if (isRaid) {
        var tag = sc.add.text(x + w - 86, ry, "標籤", {
          fontFamily: "font_light", fontSize: 11, color: "#9fd0ff"
        }).setResolution(2).setDepth(1503).setInteractive();
        tag.on("pointerdown", function () { promptBosses(sc, deck); });
        objs.push(tag);
      }
    });

    if (rows === 0) {
      objs.push(sc.add.text(x + 14, y + 44, "還沒有牌組，按 + 新增", {
        fontFamily: "font_light", fontSize: 12, color: "#cccccc"
      }).setResolution(2).setDepth(1503));
    }

    mounted.panel = own(objs);
  }

  /** 改名用 rexUI 的 InputText —— 遊戲自己載的外掛，不必自己處理鍵盤。 */
  function promptRename(sc, deck) {
    try {
      var Input = window.RexPlugins && window.RexPlugins.UI && window.RexPlugins.UI.InputText;
      if (!Input) { fail("改名", new Error("這個客戶端沒有 rexUI 的 InputText")); return; }
      var box = new Input(sc, 380, 340, 240, 28, {
        type: "text", text: deck.name, fontSize: "14px", color: "#ffffff", maxLength: 24
      });
      sc.add.existing(box);
      box.setDepth(1802);
      var bg = sc.add.nineslice(380, 340, "panel_gene", 0, 300, 120, 71, 40, 63, 32)
        .setDepth(1801);
      var tip = label(sc, 260, 305, "牌組名稱", 13).setDepth(1802);
      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        var value = String(box.text || "").trim();
        try { box.destroy(); } catch (e) {}
        bg.destroy(); tip.destroy(); ok.destroy(); cancel.destroy();
        if (commit) report({ type: "deck-rename", id: deck.id, name: value });
      }
      var ok = button(sc, 340, 380, "ok", function () { finish(true); });
      var cancel = button(sc, 420, 380, "cancel", function () { finish(false); });
      ok.img.setDepth(1802); ok.txt.setDepth(1803);
      cancel.img.setDepth(1802); cancel.txt.setDepth(1803);
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
      objs.push(sc.add.nineslice(380, 340, "panel_gene", 0, 320, 130, 71, 40, 63, 32)
        .setDepth(1801));
      objs.push(label(sc, 250, 300, "這副打得動哪幾種渦", 13).setDepth(1802));

      var opts = state.bossOptions;
      var startX = 380 - (opts.length * 46) / 2 + 23;
      opts.forEach(function (opt, i) {
        var cx = startX + i * 46;
        var box = sc.add.image(cx, 344, "btn_gene", picked[opt.key] ? 1 : 0)
          .setScale(0.5, 1.1).setDepth(1802).setInteractive();
        var txt = sc.add.text(cx, 344, opt.label, {
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
      var ok = button(sc, 340, 388, "ok", function () { finish(true); });
      var cancel = button(sc, 420, 388, "cancel", function () { finish(false); });
      ok.img.setDepth(1802); ok.txt.setDepth(1803);
      cancel.img.setDepth(1802); cancel.txt.setDepth(1803);
    } catch (e) { fail("標籤", e); }
  }

  // ---- 房間切換（規格 §7）------------------------------------------------

  function roomCycle(sc, delta) {
    var keys = state.rooms.map(function (r) { return r.key; });
    var at = keys.indexOf(state.room);
    var next = keys[(at + delta + keys.length) % keys.length];
    if (next) report({ type: "room-switch", room: next });
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
      // 先把掛在遊戲自己物件上的 handler 收回來（見 mount() 的 ⚠）
      if (mounted.icon && mounted.iconHandler) {
        try { mounted.icon.off("pointerdown", mounted.iconHandler); } catch (e) {}
      }
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
    mounted = { scene: sc, objects: objs, panel: null, room: !!isRoom };

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

    // 2. + - （規格 §9），放在 deck_next(48,644) 右邊
    // ⚠ btn_gene 原圖 80 寬，scale 0.34 之後是 27.2 —— 兩顆的中心至少要差 28，
    // 不然會疊在一起（74/96 那版實測是 60→88 疊 82→110）。
    //
    // ⚠ **房裡不畫這兩顆。** 那個位置（x 74/104）在任務房是牌組名那行字
    // （實機量到 Text 在 64,644），畫下去會疊在一起。而且新增／刪除牌組是
    // 管理動作，屬於編輯畫面 —— 站在任務房裡誤按一下「-」不該把一副牌刪掉。
    if (!isRoom) {
      var plus = button(sc, 74, 644, "+", function () { report({ type: "deck-add" }); });
      var minus = button(sc, 104, 644, "-", function () {
        if (state.activeId) report({ type: "deck-remove", id: state.activeId });
      });
      plus.img.setScale(0.34, 0.7); minus.img.setScale(0.34, 0.7);
      objs.push(plus.img, plus.txt, minus.img, minus.txt);
    }

    // 3. 房間切換（規格 §7），畫在 sort_rect 正下方。
    //
    // 尺寸抄實機量到的：sort_rect 佔 x460→560 / 高 18，btn_gene 原圖 80×25，
    // 所以 scale 是 100/80 與 18/25。標籤右對齊到 444 —— 原版「抽出」的右緣
    // 就在 444，而按鈕左緣 448，中間差 4px。⚠ 第一版標籤用左上角對齊放在
    // 448，整個被按鈕蓋掉，畫面上完全看不到那兩個字。
    //
    // ⚠⚠ **房裡不畫這一格**，兩個獨立的理由：
    //
    // 1. (444, 510) 在編輯畫面是「排列(升序)」底下的空位，在任務房那裡是**地圖
    //    正中央** —— 畫下去就是一顆浮在地圖上的按鈕。
    // 2. 更重要：站在任務房裡把它切成「迪特赫姆」之後，房裡那組 ◀▶ 會開始切
    //    迪城的牌組，而玩家按 START 打的是任務 —— 那正是**拿錯牌組上場**。
    //    人在哪一房，就只該看得到那一房的牌（進房時 enterRoom 自己會切）。
    if (!isRoom) {
      objs.push(sc.add.text(444, 510, "房間", {
        fontFamily: "font_heavy", fontSize: 13, color: "#ffffff"
      }).setResolution(2).setOrigin(1, 0.5).setDepth(2));
      var roomBg = sc.add.image(510, 510, "btn_gene", 0).setDepth(2).setInteractive();
      roomBg.setScale(100 / 80, 18 / 25);
      var roomTxt = sc.add.text(510, 510, currentRoomLabel(), {
        fontFamily: "font_light", fontSize: 12, color: "black"
      }).setResolution(2).setOrigin(0.5).setDepth(3);
      roomBg.on("pointerover", function () { roomBg.setTexture("btn_gene", 1); roomTxt.setColor("#ffffff"); });
      roomBg.on("pointerout", function () { roomBg.setTexture("btn_gene", 0); roomTxt.setColor("#000000"); });
      roomBg.on("pointerdown", function () {
        try { if (sc.ulse01) sc.ulse01.play(); } catch (e) {}
        roomCycle(sc, 1);
      });
      objs.push(roomBg, roomTxt);
      mounted.roomTxt = roomTxt;
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
      if (mounted.roomTxt) mounted.roomTxt.setText(currentRoomLabel());
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

  function tick() {
    try {
      var hit = deckScene();
      if (hit === null) { if (mounted) unmount(); return; }
      // 場景重建過的話，我們掛的東西已經跟著舊場景被 destroy
      //
      // ⚠⚠ **不能只比場景物件是不是同一個。** Phaser 的 game.scene.keys.Quest
      // 是一個**長命的 Scene 實例**：玩家離開再進來只是重跑一次 create()，
      // 場景物件本身沒換，但底下的 GameObject 全部是新的。只比場景的話，
      // 第二次進房就不會重掛 —— 症狀是「箭頭又變回遊戲原本的行為了」。
      // 所以下面那個 objects[0].scene 的檢查是**必要條件**，不是保險。
      //
      // ⚠ 圖示的檢查是「**有**但已經死了」，不是「沒有」。寫成 !mounted.icon
      // 的話，任何一個掛得上但找不到圖示的場景都會**每 500ms 重掛一次**
      // ——畫面不會有明顯異狀，但每一拍都在建物件、拆物件。
      if (
        !mounted ||
        mounted.scene !== hit.sc ||
        !mounted.objects[0] ||
        !mounted.objects[0].scene ||
        (mounted.icon && !mounted.icon.scene)
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
