import { describe, expect, it } from "vitest";
import { LOBBY_ROOM_KEY, roomKey } from "@ulr/arbiter-link/protocol";
import { MAX_MESSAGE_BYTES, parseRoomPath, shortRoom, TokenBucket } from "../src/guard.js";

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
