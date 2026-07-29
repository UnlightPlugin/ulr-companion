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
 */
export const BROWSER_DEBUG_PORT = 1221;

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
  /** okVisibleA → okInvisibleA 的實測值 */
  observed: 31.0,
  /** 遊戲畫面顯示的秒數 */
  displayed: 30,
  /** 觀測值與顯示值的差，視為伺服器回報延遲 */
  reportingLagSeconds: 1.0,
} as const;

/**
 * 「誤按反悔」窗口：按下 OK 後先本地鎖定幾秒，對手期間有動作就解除，
 * 沒動作就送出真 OK。第一期只做這個 —— 完整的雙邊方案要側通道。
 *
 * ⚠ 若按 OK 時視窗已所剩無幾，必須縮短這個窗口，否則會逾時棄權。
 */
export const UNDO_WINDOW_SECONDS = 3;

/** 對手動作。用來在對手一動時自動解除我方的假鎖定。 */
export const OPPONENT_ACTION_EVENTS = ["cardclickedB", "cardrotateB"] as const;

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
  /** 遊戲把 WSClient 實例掛在這裡 */
  instancePath: "game.scene.keys.Unlight_Init.socket",
} as const;
