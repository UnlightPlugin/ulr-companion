/**
 * @ulr/cdp-adapter — WP-07
 * ==========================
 * 狀態：**只有已知常數與介面，實作待補。**
 *
 * 這裡的常數不是猜的，是從既有的 Python 研究程式（ul_sniffer.py、抓戰鬥.py、
 * 未來視.py）實測出來的。接手的人不用從頭再挖一次。
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
 * 玩家端必須自己設好的 Steam 啟動選項。插件偵測不到 CDP 時要顯示這行。
 *
 * 注意：一定要「透過 Steam」啟動。直接跑 exe 的話 greenworks 拿不到 Steam
 * 環境，遊戲的 main.js catch 會 app.quit()，視窗會秒退。
 */
export const REQUIRED_LAUNCH_OPTION = `--remote-debugging-port=${DEFAULT_DEBUG_PORT}`;

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
 * 階段倒數上限（實測 80.03s / 83.4s，樣本還少）。
 *
 * 倒數歸零時是**伺服器**結束階段，客戶端不會自動補送 `I_am_ok`。
 * 所以插件攔下 OK 之後，一定要在歸零前自己送出，否則等於放棄該回合。
 */
export const PHASE_TIMEOUT_SECONDS = { observedMin: 80.0, observedMax: 83.4 } as const;

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
} as const;

// ---------------------------------------------------------------------------
// 介面
// ---------------------------------------------------------------------------

export interface GameFrame {
  direction: "sent" | "received";
  event: string;
  args: unknown[];
  /** 這條 frame 來自哪個埠，用來區分 PvE / PvP */
  port: number;
}

export interface CdpAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onFrame(handler: (frame: GameFrame) => void): () => void;
  /** 在遊戲 context 執行 JS。注入失敗必須降級，不得讓遊戲崩潰（§9.1）。 */
  evaluate<T>(expression: string): Promise<T>;
}

export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

export function createCdpAdapter(_options?: { port?: number }): CdpAdapter {
  throw new NotImplementedError("WP-07 CDP Adapter 尚未實作。");
}
