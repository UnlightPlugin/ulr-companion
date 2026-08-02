import { describe, expect, it } from "vitest";
import {
  opponentActionEvents,
  otherSeat,
  SEAT_DETECTION_EVENTS,
  seatOfEvent,
} from "../src/constants.js";

describe("seatOfEvent", () => {
  it("認得帶座位後綴的事件", () => {
    expect(seatOfEvent("cardclickedA")).toBe("A");
    expect(seatOfEvent("cardclickedB")).toBe("B");
    expect(seatOfEvent("okVisibleA")).toBe("A");
    // 底線形式也有（chara_A、deleteDraw_B、skill_effect_A）
    expect(seatOfEvent("chara_A")).toBe("A");
    expect(seatOfEvent("deleteDraw_B")).toBe("B");
  });

  it("不帶座位的回 null", () => {
    for (const e of ["card", "rotate", "I_am_ok", "skillbase", "diceRoll", "timerReset"]) {
      expect(seatOfEvent(e)).toBeNull();
    }
  });
});

describe("opponentActionEvents", () => {
  it("坐 A 位時對手是 B", () => {
    expect(opponentActionEvents("A")).toEqual(["cardclickedB", "cardrotateB"]);
  });

  it("坐 B 位時對手是 A", () => {
    // 這正是舊常數寫死 B 會壞掉的那半數玩家：坐 B 位的人會把自己的動作
    // 判成「對手動了」，準備狀態每次都被自己取消。
    expect(opponentActionEvents("B")).toEqual(["cardclickedA", "cardrotateA"]);
  });

  it("永遠不會把自己的動作算成對手的", () => {
    for (const seat of ["A", "B"] as const) {
      expect(opponentActionEvents(seat)).not.toContain(`cardclicked${seat}`);
      expect(opponentActionEvents(seat)).not.toContain(`cardrotate${seat}`);
    }
  });
});

describe("座位偵測", () => {
  it("兩個座位各有一個專屬的偵測事件", () => {
    // 實測：okVisibleX 只發給該座位本人（A 位整場收到 0 次 okVisibleB）。
    expect(SEAT_DETECTION_EVENTS.A).toBe("okVisibleA");
    expect(SEAT_DETECTION_EVENTS.B).toBe("okVisibleB");
    expect(seatOfEvent(SEAT_DETECTION_EVENTS.A)).toBe("A");
    expect(seatOfEvent(SEAT_DETECTION_EVENTS.B)).toBe("B");
  });

  it("otherSeat 是對合的", () => {
    expect(otherSeat("A")).toBe("B");
    expect(otherSeat(otherSeat("A"))).toBe("A");
  });
});
