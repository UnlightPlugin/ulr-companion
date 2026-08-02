/**
 * 實測得到的常數
 * ================
 * 這裡的東西不是猜的，是從既有的 Python 研究程式（`Desktop\Unlight` 的
 * ul_sniffer.py、抓戰鬥.py、未來視.py、launch.py）與 5i 的 `unlight_crawler`
 * 實測出來的。接手的人不用從頭再挖一次。
 *
 * 安全邊界（規格書 §12）：
 *   - CDP 埠只允許 127.0.0.1，絕對不可綁到 0.0.0.0
 *   - 不得記錄或上傳 Steam Token、Cookie、完整 CDP URL 或原始封包
 *   - 收到隱藏資訊（例如對手手牌）也不得顯示或上傳
 */

// ---------------------------------------------------------------------------
// 連線
// ---------------------------------------------------------------------------

/**
 * 遊戲的 remote debugging port。
 *
 * 用 9333 不是預設的 9222 —— 9222 常被 Adobe UXP（After Effects）長駐佔走，
 * 連上去會拿到 Adobe 的 debugger 而不是遊戲。
 */
export const DEFAULT_DEBUG_PORT = 9333;

/** 只綁 loopback。§12 明訂不得暴露到區域網路或公網。 */
export const DEBUG_HOST = "127.0.0.1";

export const STEAM_APP_ID = "3247080";

/**
 * 開 debug port 的命令列參數。
 *
 * ⚠ `--remote-debugging-port` **只能在啟動時指定**，不能對已在跑的程序補掛。
 * 所以插件要自己啟動客戶端，不能叫玩家去設 Steam 啟動選項 —— 那個設定是
 * 每個 Steam 帳號各自一份，玩家用小號開遊戲就失效。詳見 docs/launching.md。
 */
export const DEBUG_PORT_SWITCH = `--remote-debugging-port=${DEFAULT_DEBUG_PORT}`;

/**
 * 桌面版可以**直接執行 exe** 帶參數啟動，不必透過 Steam。
 * 2026-07-28 實測：撐過 45 秒、port 第 1 秒就通、URL 帶有效 steamid+token
 * （代表 Steam 驗證也過了，不只是 Electron 起得來）。
 *
 * - `steam_appid.txt` 是官方包裡就有的檔案，Steamworks 因此能在直接執行時
 *   初始化（前提：Steam 客戶端要在跑）
 * - `main.js` 沒有 requestSingleInstanceLock，多開不互擋
 * - 遊戲本來就會讀自訂 switch（x / y / fullscreen），不排斥額外參數
 */
export const GAME_EXECUTABLE = "UNLIGHTRevive.exe";

/**
 * spawn 子程序前一定要從環境變數移除的鍵。
 *
 * `ELECTRON_RUN_AS_NODE=1` 會讓 Electron 的 exe 被當成**純 Node** 執行，
 * Chromium 的參數變成無法辨識的 Node 選項 → `bad option` + exit 9，
 * 症狀是「遊戲一開就立刻關掉」，很容易誤判成 Steam 驗證失敗。
 *
 * VS Code 的 extension host 會設這個變數，子程序會繼承。**Companion 自己
 * 是 Electron app，所以它 spawn 出去的遊戲也會中。**
 */
export const ENV_KEYS_TO_STRIP = ["ELECTRON_RUN_AS_NODE"] as const;

/**
 * 網頁版：用 Chromium 系瀏覽器帶 debug port 啟動。
 *
 * ⚠ `--user-data-dir` 是必要的不是選配。玩家已經開著 Chrome 時，用同一個
 * profile 再啟動只會在既有實例開分頁，**命令列參數整個被忽略**，port 不會開。
 * 用插件專屬 profile 才保證是全新實例，也不影響玩家平常的瀏覽器。
 *
 * 代價：新 profile 沒有 cookie，玩家要在裡面登入一次（之後會記住）。
 *
 * ⚠ **埠號要避開 Windows 的保留範圍。** 原本用 1221，2026-07-30 實測踩雷：
 * 這台機器（有 Hyper-V）把 **1196–1295 整段保留**了，Chrome 與 Edge 都
 * 綁不上去 —— 而且是**中途**才被保留的，症狀是「本來好好的，突然就連不上」。
 *
 * 保留範圍是動態的，重開機或 Hyper-V／WSL／Docker 起動都可能改變。症狀很難認：
 * Chrome 照常啟動、參數也在命令列上，但 `DevToolsActivePort` 不會產生、埠也
 * 沒人在聽，看起來像 Chrome 忽略了參數。診斷指令：
 *
 *     netsh interface ipv4 show excludedportrange protocol=tcp
 *
 * 想確認是不是埠的問題，用 `--remote-debugging-port=0`：Chrome 會自己挑一個
 * free port 並寫進 `DevToolsActivePort`。挑得到就代表 DevTools 沒被停用，
 * 純粹是那個埠號綁不上去。
 */
export const BROWSER_DEBUG_PORT = 9334;

// ---------------------------------------------------------------------------
// 遊戲前端（已實測）
// ---------------------------------------------------------------------------

/**
 * 遊戲是 Phaser 3.87 跑在 Electron 裡，而且包在 iframe 中。
 * window.game 在 iframe 的 execution context，不是頂層 page。
 */
export const GAME_GLOBAL = "window.game";

/**
 * ⚠ iframe 有位移：canvas 在 iframe 內的 getBoundingClientRect() 是 (58, 58)，
 * 但畫面上它是從 (0,0) 開始。DOM 覆蓋層用 `position:fixed; left:0; top:0`
 * 會被推到視窗外看不到，必須拿 canvas 的 rect 當原點算偏移。
 * Phaser 場景內的物件沒這個問題。
 */
export const OVERLAY_ANCHOR_NOTE =
  "以 document.querySelector('canvas').getBoundingClientRect() 為原點";

// ---------------------------------------------------------------------------
// 官方 HTML 外殼（免 Steam 啟動要重建的東西，見 boot-shell.ts）
// ---------------------------------------------------------------------------

/**
 * 網頁版的來源。**不含 port** —— 遊戲每次開在 `GAME_PORTS.quest` 範圍內的
 * 隨機 port，所以 port 是執行期才決定的。
 */
export const GAME_ORIGIN = "https://www.playunlight.online";

/** 三個 webpack bundle 放的目錄（相對於來源）。 */
export const GAME_BUNDLE_DIR = "client/";

/**
 * 載入順序中**最後**那個 bundle 的檔名前綴。
 *
 * 用途不是載入，是**判斷一份清單完不完整**。webpack 的相依順序是
 * runtime → unlight-common → main，所以 `main.` 在場就代表整頁真的載完了。
 *
 * 為什麼需要這個判準（2026-08-02 實際踩到）：外殼重建（CDP 注入或擴充功能的
 * shell.js）是**一個一個非同步接**上去的 —— runtime.onload 才接 common，
 * common.onload 才接 main。所以在重建頁上任何時間點去掃 `document.scripts`，
 * 都可能只看到 1~2 個。把那個當成「伺服器給的真貨」記下來，就會用一份殘缺的
 * 清單蓋掉好的那份，症狀是遊戲從此開不起來（只載了 runtime，畫面全白）。
 *
 * 伺服器給的真頁面則是三個 `<script>` 都寫在 HTML 裡，一次到位。
 */
export const GAME_MAIN_BUNDLE_PREFIX = "main.";

export const GAME_STYLESHEET = "stylesheets/style-steam.css";

export const GAME_TITLE = "UNLIGHT:Revive";

/**
 * 遊戲 canvas。id 與尺寸是**伺服器吐的外殼本來就長這樣**，不是我們挑的 ——
 * 2026-07-30 對照正常 Steam 流程載入的頁面確認過。
 * 尺寸跟 `OVERLAY_ANCHOR_NOTE` 講的 760x680 座標系是同一件事。
 */
export const GAME_CANVAS = {
  id: "myCustomCanvas",
  width: 760,
  height: 680,
} as const;

/**
 * 角色卡資產的 Phaser 快取鍵。
 *
 * 這份 JSON 的 `frames[]` 是**每張角色卡一筆**，欄位有 `filename`
 * （`cc078_04` / `cc078_r04`）、`chara`、`level`、`cost`、`rarity`、
 * hp/atk/def 與四個技能。改自訂 COST 就是攔它的載入、改寫 `frames[].cost`。
 */
export const CC_ASSET_KEY = "cc_asset";

// ---------------------------------------------------------------------------
// WebSocket 連線埠（遊戲同時開好幾條，各管各的）
// ---------------------------------------------------------------------------

export const GAME_PORTS = {
  /** 任務／主遊戲，:14012~14021 之間浮動 */
  quest: [14012, 14021] as const,
  /** PvP 對戰房 */
  duel: 14003,
  /** 獎勵遊戲 */
  bonus: 14002,
  /** 玩家資料（牌組） */
  player: 11011,
  /** 頻道／房間 */
  channel: 11013,
  /** 戰鬥結算 */
  result: 13008,
} as const;

// ---------------------------------------------------------------------------
// 事件名（實測，非完整清單）
// ---------------------------------------------------------------------------

/** 牌組。收到時 args[0] 是牌組內容，送出時 args[0] 是 session token（不可記錄）。 */
export const DECK_EVENTS = ["db_deck1", "db_deck2", "db_deck3"] as const;

/** 房間／配對 */
export const ROOM_EVENTS = [
  "match_waiting",
  "match_room_make",
  "match_room_error",
  "joinRoom",
  "room_in",
] as const;

/** 戰鬥結算 */
export const RESULT_EVENTS = ["result", "duel_end", "quest_finish"] as const;

/**
 * 我方按下 OK。
 *
 * 社群最痛的「拖條」議題想做的「假 OK」就是攔這個事件 —— 前端按下去不直接送，
 * 由插件判斷雙方狀態後才真的送出。可行性見 OK_BUTTON 與 WS_CLIENT 的說明。
 */
export const OK_EVENT = "I_am_ok";

/**
 * 伺服器控制 OK 鈕可用狀態的事件。
 *
 * ⚠ B 側**不是**「對手按了 OK」。實測前後文顯示 `okVisibleB` 出現在階段開始
 * （啟用對手的 OK 鈕）、`okInvisibleB` 出現在 `timerPause` 之後（凍結期間
 * 雙方 OK 鈕都停用）。它們反映的是階段與凍結狀態。
 *
 * **伺服器從不告訴客戶端對手按了 OK** —— 所有 log 裡 `I_am_ok` 出現 90 次
 * 全部是 →送出，收到 0 次。所以「對手沒開插件時我方也看不到對方 OK」這個
 * fairplay 性質是協定本身保證的，不是靠自律。
 *
 * `okInvisibleA` 會在階段自然結束前約 1.0 秒觸發，可當「伺服器要收了」的
 * 預告訊號。
 */
export const OK_STATE_EVENTS = [
  "okVisibleA",
  "okInvisibleA",
  "okVisibleB",
  "okInvisibleB",
] as const;

/**
 * 回合倒數 —— 安全邊際要從這裡算。
 *
 * ⚠ 不要用 `timerReset` → `timerstop` 當倒數區間。那是**整個階段**，
 * 裡面包含好幾個回合加上動畫與非互動空檔（實測有一次 `okVisibleA` 在
 * `timerReset` 之後 48 秒才出現，那 48 秒根本不能按 OK），量出來會是
 * 80 秒上下，跟實際可操作時間差很多。
 *
 * 真正的倒數是 **`okVisibleA` → `okInvisibleA`**：實測 31.0 秒，
 * 對應遊戲顯示的 30 秒加上約 1 秒的伺服器回報延遲。
 *
 * 歸零時是**伺服器**結束回合，客戶端不會自動補送 `I_am_ok` —— 所以插件
 * 攔下 OK 之後一定要自己送出，否則等於棄權。
 *
 * 不同階段（抽牌／移動／攻擊／防禦）的秒數可能不同，樣本還在累積。
 * 量測工具：`Desktop\Unlight\拖條量測.py`
 */
export const OK_WINDOW_SECONDS = {
  /**
   * `okVisibleX` → `okInvisibleX` 的實測值。
   *
   * 2026-08-02 雙邊重測確認：**未受凍結干擾**的三次分別是
   * 31.07 / 31.00 / 31.04 秒，全距 0.07 秒。滿足「每階段 ≥3 次、全距 <1.5 秒」
   * 的標準，而且與 open-questions §4 早先量到的 31.0 完全一致。
   */
  observed: 31.0,
  /** 遊戲畫面顯示的秒數 */
  displayed: 30,
  /** 觀測值與顯示值的差，視為伺服器回報延遲 */
  reportingLagSeconds: 1.0,
} as const;

/**
 * ⚠ **不要用 `okVisibleX` 當「新的 30 秒開始了」。**
 *
 * 2026-08-02 實測：同一批樣本裡有一次區間只有 26.15 秒，而那次的
 * `okVisibleA` **正好與 `timerResume` 同一瞬間**。凍結解除時 OK 鈕會重新啟用、
 * 再發一次 `okVisibleX`，但倒數是**接續**的，不是重新計時。
 *
 * 同一場 19 個區間裡有 15 個受凍結影響，長度從 0.20 秒到 13.75 秒都有 ——
 * 換句話說，光看事件去推剩餘秒數，多數情況下都會算錯。
 *
 * **正確做法是讀畫面上的 TIME 值**（玩家提出的做法，資料支持它）：
 *
 *   - 那是遊戲自己維護的倒數，凍結時它自己會停，不必我們做加減
 *   - 事件量到的 31.0 秒改當**校準值**用 —— 顯示 30 但伺服器 31 收，
 *     那 1 秒是安全邊際的來源
 *
 * 凍結由**消耗型卡牌**觸發（玩家提供）：聖水、聖杯（＝聖水＋機會1）、
 * 機會1（抽1張）、機會3（抽3張）、詛咒卡、重新洗牌 —— 打出去就消失的那些。
 */
export const OK_WINDOW_NOTE =
  "okVisibleX 在凍結解除時會重發，倒數接續而非重置。剩餘秒數請讀畫面上的 TIME。";

/**
 * 畫面上那個 TIME 倒數的位置（2026-08-02 實測定位）。
 *
 * 它是**當前階段場景**裡位於 (380, 318) 的 `BitmapText` —— 380 正好是 760 寬
 * 畫布的水平中心。場景會隨階段換：`MovePhaseA` / `DefensePhaseA` /
 * `AttackPhaseA` / `MainA`，所以要找**目前 active 的那個**，不能寫死場景名。
 *
 * 怎麼定位出來的：畫面上有 23 個數字（HP、手牌強度、回合數…），猜座標很脆弱。
 * 改成**取樣兩次、找唯一在遞減的那個** —— 這個判準跟版面改版無關，
 * 也可以拿來當自我驗證（讀到的東西如果不會往下跑，就是抓錯了）。
 *
 * 兩個實測到的性質：
 *
 * 1. **每秒 1 格**，與遊戲顯示一致。
 * 2. **低於 10 秒會變成一位小數**（`9.2` → `8.2` → `7.1`），正好在安全邊際
 *    最需要精度的地方給了次秒解析度。所以要用 `parseFloat` 不是 `parseInt`。
 */
export const TIMER_DISPLAY = {
  type: "BitmapText",
  x: 380,
  y: 318,
  /** 只在剩餘 10 秒以下出現小數，解析一律用 parseFloat。 */
  fractionalBelowSeconds: 10,
} as const;

/**
 * ⚠ **Phaser 場景名的 A/B 跟事件名的 A/B 意思相反。**
 *
 * | 來源            | A/B 是什麼                                  |
 * | --------------- | ------------------------------------------- |
 * | WS 事件名       | **絕對座位** —— 兩個客戶端看到相同標籤      |
 * | Phaser 場景名   | **相對視角** —— 每個客戶端自己永遠是 A      |
 *
 * 實測：坐 B 位的客戶端，倒數也在 `MovePhaseA` 裡；坐 A 位的在 `DefensePhaseA`。
 * 兩邊都是 `...A`。
 *
 * 這也是為什麼 `OK_BUTTON.scene = "MainA"` 對兩個座位都能用 —— UI 層一律以
 * 本地玩家為 A。**但同一支程式裡混用兩套慣例極容易出錯**，碰到 A/B 一定要先
 * 問清楚「這是事件名還是場景名」。
 */
export const SCENE_NAMING_NOTE =
  "場景名的 A 永遠是本地玩家（相對），事件名的 A 是固定座位（絕對）。";

/**
 * 「誤按反悔」窗口：按下 OK 後先本地鎖定幾秒，對手期間有動作就解除，
 * 沒動作就送出真 OK。第一期只做這個 —— 完整的雙邊方案要側通道。
 *
 * ⚠ 若按 OK 時視窗已所剩無幾，必須縮短這個窗口，否則會逾時棄權。
 */
export const UNDO_WINDOW_SECONDS = 3;

// ---------------------------------------------------------------------------
// 座位（2026-08-02 雙邊實測，見 docs/battle-events.md）
// ---------------------------------------------------------------------------

/**
 * ⚠ **事件名尾巴的 A/B 是座位，不是「我方/對手」。**
 *
 * 這是雙邊同時錄同一場對戰才看得出來的事。A 位送出 53 次 `card`，**兩個
 * 客戶端**都收到 `cardclickedA`；B 位送出 39 次，兩邊都收到 `cardclickedB`。
 * 標籤在整場固定，跟誰在看無關。
 *
 * 之前這裡寫著 `OPPONENT_ACTION_EVENTS = ["cardclickedB", "cardrotateB"]`，
 * 那只對**坐 A 位的人**成立。坐 B 位的玩家跑起來會把自己的動作判成「對手
 * 動了」—— 移動階段仲裁的準備狀態每次都被自己取消，而且症狀只在半數玩家
 * 身上出現，極難查。
 *
 * 所以：**任何跟敵我有關的邏輯都必須先知道自己坐哪一位**，用
 * `opponentActionEvents(seat)` 這類函式取得事件名，不要寫死。
 */
export type Seat = "A" | "B";

/**
 * 座位偵測用的事件。
 *
 * `okVisibleX` **只發給該座位本人** —— 實測 A 位收到 12 次 `okVisibleA`、
 * `okVisibleB` 整場 0 次，B 位剛好相反。所以收到哪一個，就是坐哪一位。
 *
 * 選它而不選別的座位私有事件（`cardController1X`、`defensePhaseX`、
 * `deleteDraw_X`）的理由：它在抽牌階段一開始就出現，是最早可用的訊號。
 */
export const SEAT_DETECTION_EVENTS = {
  A: "okVisibleA",
  B: "okVisibleB",
} as const satisfies Record<Seat, string>;

/** 從一則事件名推出它屬於哪個座位。不帶座位後綴的回 `null`。 */
export function seatOfEvent(event: string): Seat | null {
  if (event.endsWith("A") || event.endsWith("_A")) return "A";
  if (event.endsWith("B") || event.endsWith("_B")) return "B";
  return null;
}

export function otherSeat(seat: Seat): Seat {
  return seat === "A" ? "B" : "A";
}

/**
 * 對手的動作事件。用來在對手一動時自動解除我方的準備狀態。
 *
 * 一定要帶自己的座位進來 —— 見上面的說明。
 */
export function opponentActionEvents(mySeat: Seat): readonly string[] {
  const them = otherSeat(mySeat);
  return [`cardclicked${them}`, `cardrotate${them}`];
}

/**
 * 我方送出操作時用的事件名（不分座位 —— 送出側沒有 A/B 後綴）。
 *
 * ⚠ **出牌與收牌是同一個事件。** 兩者都是 `card`，差別只可能在回來的
 * `cardclickedX(num, bool, bool)` 那兩個布林裡。這影響移動規則 V1 的規則 2：
 * 事件層面分不出「出牌」與「收牌」。
 */
export const ACTION_EVENTS = {
  /** 出牌與收牌共用 */
  card: "card",
  rotate: "rotate",
  /** 唯一會回送給自己的操作事件 */
  moveSelect: "move_select",
} as const;

/**
 * OK 鈕在畫面上的位置（實測）。
 *
 * 遊戲用「切 frame + 關 input」來做不可按狀態：
 *   frame "2" + input.enabled === false  → 灰色不可按
 * 所以要做「假鎖定」的視覺，切 frame 就夠，不必自己畫。
 *
 * 它只有 1 個 pointerdown listener，也就是送出 I_am_ok 的那個 handler。
 */
export const OK_BUTTON = {
  scene: "MainA",
  textureKey: "ok",
  /** Phaser 座標（canvas 760x680 座標系，不是螢幕座標） */
  position: { x: 570, y: 630 },
  disabledFrame: "2",
} as const;

/**
 * 遊戲的 WebSocket 客戶端類別（實測）。
 *
 *   class WSClient          // webpack://wsclient/./src/web-socket-client.ts
 *   methods:    connect, emit, fetch, disconnect, onAny, onceAny, offAny, on, once, off
 *   accessors:  readyState, state, id
 *
 * 兩個對「假 OK」很關鍵的性質：
 *
 * 1. `emit` 是**原型方法**且 writable + configurable，prototype 沒有凍結。
 *    這個 class 用了 private field（#socket），從外面讀不到，但**換掉原型
 *    方法完全不受影響** —— 只要用原本的 this 呼叫原函式即可。
 *    遊戲同時開 6 條連線，全部共用同一個 prototype，patch 一次全包。
 *    （`unlight_crawler` 的 `ulr_wsclient.js`／`ulr_multiple_launch.js`
 *    分別 patch 了 `fetch` 與 `once`，是這條性質的獨立佐證。）
 *
 * 2. `onAny` 可以攔全部進來的事件，不必 patch 就能監聽。
 *
 * ⚠ 攔截 I_am_ok 的正確做法是**原封不動保留攔到的參數**，稍後用原始 emit
 *   重放。這樣插件完全不需要知道 I_am_ok 的協定長什麼樣，也就不會因為
 *   遊戲改版改了參數而送出錯誤封包。
 */
export const WS_CLIENT = {
  className: "WSClient",
  sendMethod: "emit",
  /** 攔全部進來的事件，不必 patch */
  listenAllMethod: "onAny",
  /**
   * 拆掉 `onAny` 掛上去的監聽。
   *
   * ⚠ 監聽是掛在**實例**上的，不是原型 —— 換一顆 socket 就得重掛，而重灌
   * 腳本時舊的那份不拆就會留在實例上，同一則事件回報兩次。
   * 見 `SOCKET_LIFETIME_NOTE`。
   */
  unlistenAllMethod: "offAny",
  /** 遊戲把 WSClient 實例掛在這裡 */
  instancePath: "game.scene.keys.Unlight_Init.socket",
} as const;

/**
 * ⚠ **socket 是每場對戰換一顆的，`WSClient.prototype` 才是永久的。**（實測）
 *
 * `MainA` 的原始碼：
 *
 * ```js
 * "quest" !== rule && "raid" !== rule && "event" !== rule
 *   ? this.socket = this.scene.get("MatchBoot").socket   // 對戰：跟 MatchBoot 借
 *   : this.socket = new WSClient(...)                    // 任務／raid／活動：自己 new
 * ```
 *
 * 而 `MatchBoot` 自己是 `this.socket = new WSClient(...)`，**每次進配對就 new
 * 一顆**。實測對戰中 `MainA.socket` 與 `MatchBoot.socket` 是同一個 id。
 *
 * 這對改前端的東西是個陷阱，因為兩種掛法的壽命完全不同：
 *
 * | 掛在哪                     | 跨場活得下來嗎 |
 * | -------------------------- | -------------- |
 * | `WSClient.prototype.emit`  | ✅ 六條連線共用一份 |
 * | `socket.onAny(...)`（實例）| ❌ 換房就沒了       |
 *
 * 最糟的是**兩者會一起用**：攔截（原型）活著、解除攔截的觸發源（實例）死了，
 * 於是插件變成單向的鎖。任何同時用到這兩種掛法的功能都必須自己偵測 socket
 * 換過了沒 —— `patch-ok.ts` 的 `arm()` 就是在做這件事。
 */
export const SOCKET_LIFETIME_NOTE =
  "原型的 patch 跨場活著，實例上的 onAny 每場重來 —— 換房後要自己重掛。";
