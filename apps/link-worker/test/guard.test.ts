import { describe, expect, it } from "vitest";
import { LOBBY_ROOM_KEY, roomKey } from "@ulr/arbiter-link/protocol";
import {
  MAX_COUNT_KEYS,
  MAX_MESSAGE_BYTES,
  parseCountKeys,
  parseCountTags,
  parseRoomPath,
  shortRoom,
  TokenBucket,
} from "../src/guard.js";

describe("房號路徑", () => {
  it("收 roomKey() 真的產出來的那種字串", () => {
    const key = roomKey("MainA-room-32-chars-high-entropy");
    expect(parseRoomPath(`/r/${key}`)).toBe(key);
  });

  it("⚠ 大廳一律拒絕 —— 公網上那會變成一個所有人擠進去的房間", () => {
    // 本機版無害（房裡只有你自己的實例），公網上會讓兩個素不相識的人被配成
    // 一對，第三個以後全部收到 room-full。同一份程式碼，換個位置就變成錯的。
    expect(parseRoomPath(`/r/${LOBBY_ROOM_KEY}`)).toBeNull();
  });

  it("長度或字元不對就拒絕", () => {
    for (const bad of [
      "/r/", // 空的
      "/r/abc", // 太短
      "/r/0123456789abcdef0", // 太長
      "/r/0123456789ABCDEF", // 大寫（roomKey 產出的是小寫）
      "/r/0123456789abcdeg", // g 不是十六進位
      "/r/../../etc/passwd",
      "/health",
      "/",
    ]) {
      expect(parseRoomPath(bad), bad).toBeNull();
    }
  });
});

describe("令牌桶", () => {
  it("正常玩家的節奏一路都拿得到", () => {
    const bucket = new TokenBucket(20, 5, 0);
    // 一個階段裡改設定、按 OK、取消……個位數次，中間都有秒級的間隔。
    for (let i = 0; i < 10; i++) expect(bucket.take(i * 1000)).toBe(true);
  });

  it("⚠ 連續灌會見底 —— 這條是為了保護對手的反悔窗口", () => {
    // 有人用腳本狂送 ready:true 的話，對手每次按下 OK 都會在同一瞬間被湊成
    // both-ready 送出去，畫面上完全看不出異常。
    const bucket = new TokenBucket(20, 5, 0);
    for (let i = 0; i < 20; i++) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
  });

  it("等一秒補 5 個，而且不會超過容量", () => {
    const bucket = new TokenBucket(20, 5, 0);
    for (let i = 0; i < 20; i++) bucket.take(0);
    expect(bucket.take(1000)).toBe(true); // 補了 5 個
    expect(bucket.take(999_999)).toBe(true);
    expect(bucket.tokens).toBeLessThanOrEqual(20);
  });

  it("時間倒退不會憑空生出令牌", () => {
    const bucket = new TokenBucket(3, 1, 10_000);
    bucket.take(10_000);
    bucket.take(5_000); // 比上一次還早
    expect(bucket.tokens).toBeLessThanOrEqual(1);
  });
});

describe("其餘關卡", () => {
  it("訊息上限比最大的一則協定訊息大一個數量級以上", () => {
    const hello = JSON.stringify({
      t: "hello",
      v: 1,
      room: roomKey("x"),
      prefs: { phaseSeconds: 20, hazardShortenSeconds: 5, readyEnabled: true, speedFactor: 1 },
    });
    expect(hello.length).toBeLessThan(MAX_MESSAGE_BYTES / 10);
  });

  it("log 裡的房號要截短", () => {
    expect(shortRoom("0123456789abcdef")).toBe("01234567");
  });
});

/**
 * 等待人數的路由（WP-17）。
 *
 * ⚠ 這條是**沒有身分、誰都打得到**的，而每一把鍵都是一次 DO 往返 ——
 * 上限那一關是防「一個請求叫醒任意多個 Durable Object」的。
 */
describe("等待人數的路由", () => {
  const key = (n: string) => n.repeat(16).slice(0, 16);

  it("收合法的鍵", () => {
    const url = new URL(`https://x/qn?k=${key("a")}&k=${key("b")}`);
    expect(parseCountKeys(url)).toEqual([key("a"), key("b")]);
  });

  it("路徑不對就不是這條路由", () => {
    expect(parseCountKeys(new URL(`https://x/other?k=${key("a")}`))).toBeNull();
  });

  it("一把鍵都沒有就不收", () => {
    expect(parseCountKeys(new URL("https://x/qn"))).toBeNull();
  });

  it("⚠ 超過上限就整個拒絕，不是截斷", () => {
    const many = Array.from({ length: MAX_COUNT_KEYS + 1 }, (_, i) => `k=${key(String(i % 10))}`);
    expect(parseCountKeys(new URL(`https://x/qn?${many.join("&")}`))).toBeNull();
  });

  it("鍵的格式跟房號同一套（16 個十六進位字元）", () => {
    expect(parseCountKeys(new URL("https://x/qn?k=short"))).toBeNull();
    expect(parseCountKeys(new URL(`https://x/qn?k=${"Z".repeat(16)}`))).toBeNull();
    // 大寫十六進位也不收 —— `matchKey()` 產的一律是小寫。
    expect(parseCountKeys(new URL(`https://x/qn?k=${"A".repeat(16)}`))).toBeNull();
  });
});

/**
 * 只數同一份規則的人（2026-08-20）。
 *
 * ⚠ 標籤是 `ruleTag(配對鍵, contentHash)` —— **拌過配對鍵**，所以同一份規則
 * 在四個檔位上是四個不同的字串。位置錯開的話每一檔都會拿到不屬於它的標籤，
 * 結果全部數到 0，而且沒有任何錯誤訊息。
 */
describe("parseCountTags", () => {
  const url = (q: string): URL => new URL(`https://x/qn?${q}`);
  const tag = (c: string): string => c.repeat(16);

  it("沒帶 → undefined（不挑規則，全部都數）", () => {
    expect(parseCountTags(url(`k=${tag("a")}`), 1)).toBeUndefined();
  });

  it("帶得剛好 → 照順序回", () => {
    expect(
      parseCountTags(url(`k=${tag("a")}&k=${tag("b")}&t=${tag("c")}&t=${tag("d")}`), 2),
    ).toEqual([tag("c"), tag("d")]);
  });

  it("⚠ 數量對不上 → null（呼叫端要回 400，不能當成沒帶）", () => {
    expect(parseCountTags(url(`k=${tag("a")}&k=${tag("b")}&t=${tag("c")}`), 2)).toBeNull();
    expect(parseCountTags(url(`k=${tag("a")}&t=${tag("c")}&t=${tag("d")}`), 1)).toBeNull();
  });

  it("格式不對 → null", () => {
    expect(parseCountTags(url("k=" + tag("a") + "&t=short"), 1)).toBeNull();
    expect(parseCountTags(url(`k=${tag("a")}&t=${"Z".repeat(16)}`), 1)).toBeNull();
  });
});
