/**
 * 配對佇列客戶端的重連節奏
 *
 * 這個檔案只測**退避曲線**這一支純函式，因為它是這支唯一一段「錯了不會有人
 * 發現」的邏輯：連不上時的重試間隔決定了插件一天會敲中間人幾次，而那個數字
 * 只有在雲端後台的帳單頁上才看得到 —— 通常是在額度已經燒掉之後。
 *
 * 2026-08-16 的實際數字：固定 2 秒重試、兩個視窗、一個半小時 = 4,706 次請求，
 * 而那台服務前 15 天全部加起來才一百多次。
 */

import { describe, expect, it } from "vitest";
import {
  QUEUE_COLD_ATTEMPTS,
  QUEUE_RECONNECT_MAX_MS,
  QUEUE_RECONNECT_MS,
  queueReconnectDelay,
} from "@ulr/arbiter-link";

describe("重連退避", () => {
  it("每失敗一次翻倍，從 2 秒起跳", () => {
    expect(queueReconnectDelay(1)).toBe(2_000);
    expect(queueReconnectDelay(2)).toBe(4_000);
    expect(queueReconnectDelay(3)).toBe(8_000);
    expect(queueReconnectDelay(4)).toBe(16_000);
    expect(queueReconnectDelay(5)).toBe(32_000);
  });

  it("夾在上限（60 秒）—— 卡住一整天是 1,440 次，不是 43,200 次", () => {
    expect(queueReconnectDelay(6)).toBe(QUEUE_RECONNECT_MAX_MS);
    expect(queueReconnectDelay(50)).toBe(QUEUE_RECONNECT_MAX_MS);
    // ⚠ 2 ** 1000 是 Infinity。斷線一整天之後 failures 會很大，而 Infinity
    // 進了 setTimeout 是「立刻」—— 那會從退避變成全速重試。
    expect(queueReconnectDelay(1_000)).toBe(QUEUE_RECONNECT_MAX_MS);
    expect(Number.isFinite(queueReconnectDelay(1_000))).toBe(true);
  });

  it("0 與負數當成第一次，不會回傳 0 或負的間隔", () => {
    expect(queueReconnectDelay(0)).toBe(QUEUE_RECONNECT_MS);
    expect(queueReconnectDelay(-3)).toBe(QUEUE_RECONNECT_MS);
  });

  it("測試可以換掉基準，上限照樣有效", () => {
    expect(queueReconnectDelay(1, 10)).toBe(10);
    expect(queueReconnectDelay(4, 10)).toBe(80);
    expect(queueReconnectDelay(4, 10, 50)).toBe(50);
  });

  /**
   * ⚠ 這一則釘的是「放棄之前大約等多久」。太短會讓一次慢啟動的網路被判死，
   * 太長就回到「玩家盯著『配對中』等一條不存在的隊伍」那個狀態。
   */
  it("一次都沒連上過的話，五次之內就放棄 —— 加起來大約一分鐘", () => {
    let total = 0;
    for (let n = 1; n < QUEUE_COLD_ATTEMPTS; n++) total += queueReconnectDelay(n);
    expect(total).toBeGreaterThan(20_000);
    expect(total).toBeLessThan(90_000);
  });
});
