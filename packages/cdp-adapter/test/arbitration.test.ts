import { describe, expect, it } from "vitest";
import type { ArbiterConfig, ArbiterInput, ArbiterState } from "../src/arbitration.js";
import { initialState, resetForNextPhase, step } from "../src/arbitration.js";

const BASE: ArbiterConfig = { seat: "A", policy: "either", deadlineSeconds: 3 };

/** 連續餵一串輸入，回傳最後的狀態與**全部**動作。 */
function run(
  config: ArbiterConfig,
  inputs: readonly ArbiterInput[],
  from: ArbiterState = initialState(),
): { state: ArbiterState; actions: ReturnType<typeof step>["actions"] } {
  let state = from;
  const actions: ReturnType<typeof step>["actions"][number][] = [];
  for (const input of inputs) {
    const r = step(config, state, input);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions };
}

const sent = (actions: readonly { type: string }[]): unknown[] =>
  actions.filter((a) => a.type === "send-ok");

describe("不變量 1：硬底線優先於一切", () => {
  it("對手沒回應也照樣送出", () => {
    // 這是整個模組最重要的一條。壓著不送 = 棄權，而棄權是不可逆的。
    const { actions, state } = run(BASE, [
      { type: "press-ok" },
      { type: "tick", remainingSeconds: 3 },
    ]);
    expect(sent(actions)).toEqual([{ type: "send-ok", reason: "deadline" }]);
    expect(state.committed).toBe(true);
  });

  it("policy 是 never 也一樣送", () => {
    // C 型的語意是「不被操作取消」，不是「不受時間限制」。
    const { actions } = run({ ...BASE, policy: "never" }, [
      { type: "press-ok" },
      { type: "tick", remainingSeconds: 1 },
    ]);
    expect(sent(actions)).toHaveLength(1);
  });

  it("還沒按 OK 就不會因為時間到而送出", () => {
    // 玩家沒承諾過，插件不能替他承諾。時間到伺服器自己會結束回合。
    const { actions } = run(BASE, [{ type: "tick", remainingSeconds: 0 }]);
    expect(sent(actions)).toHaveLength(0);
  });

  it("時間還夠就不送，繼續等對手", () => {
    const { actions, state } = run(BASE, [
      { type: "press-ok" },
      { type: "tick", remainingSeconds: 3.1 },
    ]);
    expect(sent(actions)).toHaveLength(0);
    expect(state.ready).toBe(true);
  });
});

describe("不變量 2：送出後不可撤銷", () => {
  it("commit 之後任何輸入都不再產生第二次送出", () => {
    const { actions, state } = run(BASE, [
      { type: "press-ok" },
      { type: "opponent-ready", ready: true },
      // 之後這些全都該被忽略
      { type: "press-ok" },
      { type: "opponent-ready", ready: false },
      { type: "tick", remainingSeconds: 0 },
      { type: "game-event", event: "cardclickedB", cardId: 7, clicked: true },
    ]);
    expect(sent(actions)).toHaveLength(1);
    expect(state.committed).toBe(true);
    expect(state.ready).toBe(true);
  });
});

describe("不變量 3：座位從設定來，不寫死", () => {
  it("坐 B 位時，對手是 A", () => {
    // 寫死 "B = 對手" 只對半數玩家成立，而症狀是準備狀態每次被自己的動作
    // 取消 —— 這條測試就是為了讓那個 bug 不可能溜過去。
    const config: ArbiterConfig = { ...BASE, seat: "B", policy: "opponent" };
    const own = run(config, [
      { type: "press-ok" },
      { type: "game-event", event: "cardclickedB", cardId: 1, clicked: true },
    ]);
    expect(own.state.ready).toBe(true); // 自己的動作不取消

    const theirs = run(config, [
      { type: "press-ok" },
      { type: "game-event", event: "cardclickedA", cardId: 1, clicked: true },
    ]);
    expect(theirs.state.ready).toBe(false); // 對手的才取消
  });
});

describe("取消策略", () => {
  const play = (seat: "A" | "B"): ArbiterInput => ({
    type: "game-event",
    event: `cardclicked${seat}`,
    cardId: 5,
    clicked: true,
  });

  it("either：雙方的操作都取消", () => {
    expect(run(BASE, [{ type: "press-ok" }, play("A")]).state.ready).toBe(false);
    expect(run(BASE, [{ type: "press-ok" }, play("B")]).state.ready).toBe(false);
  });

  it("opponent：只有對手的操作取消", () => {
    const c: ArbiterConfig = { ...BASE, policy: "opponent" };
    expect(run(c, [{ type: "press-ok" }, play("A")]).state.ready).toBe(true);
    expect(run(c, [{ type: "press-ok" }, play("B")]).state.ready).toBe(false);
  });

  it("never：誰操作都不取消", () => {
    const c: ArbiterConfig = { ...BASE, policy: "never" };
    expect(run(c, [{ type: "press-ok" }, play("A")]).state.ready).toBe(true);
    expect(run(c, [{ type: "press-ok" }, play("B")]).state.ready).toBe(true);
  });
});

describe("轉牌：手牌不算操作，場上才算", () => {
  it("牌還在手上時轉牌不取消準備", () => {
    // 手牌中轉牌只是在挑要用哪一面，還沒承諾出去。
    const { state } = run(BASE, [
      { type: "press-ok" },
      { type: "game-event", event: "cardrotateB", cardId: 9 },
    ]);
    expect(state.ready).toBe(true);
  });

  it("牌打出去之後轉牌就算操作", () => {
    const { state } = run(BASE, [
      { type: "game-event", event: "cardclickedB", cardId: 9, clicked: true },
      { type: "press-ok" },
      { type: "game-event", event: "cardrotateB", cardId: 9 },
    ]);
    expect(state.ready).toBe(false);
  });

  it("收回手牌之後，轉它又不算操作了", () => {
    const { state } = run(BASE, [
      { type: "game-event", event: "cardclickedB", cardId: 9, clicked: true },
      { type: "game-event", event: "cardclickedB", cardId: 9, clicked: false },
      { type: "press-ok" },
      { type: "game-event", event: "cardrotateB", cardId: 9 },
    ]);
    expect(state.ready).toBe(true);
  });

  it("兩邊的場上集合互不干擾", () => {
    // A 出了 9 號，不代表 B 的 9 號也在場上 —— 兩人的牌各自編號。
    const { state } = run(BASE, [
      { type: "game-event", event: "cardclickedA", cardId: 9, clicked: true },
      { type: "press-ok" },
      { type: "game-event", event: "cardrotateB", cardId: 9 },
    ]);
    expect(state.ready).toBe(true);
  });
});

describe("準備的開關", () => {
  it("再按一次取消準備，OK 鈕變回可按", () => {
    const { state, actions } = run(BASE, [{ type: "press-ok" }, { type: "press-ok" }]);
    expect(state.ready).toBe(false);
    expect(actions.filter((a) => a.type === "set-ok-frame")).toEqual([
      { type: "set-ok-frame", frame: "2" },
      { type: "set-ok-frame", frame: "0" },
    ]);
  });

  it("每次狀態變化都通知側通道", () => {
    const { actions } = run(BASE, [{ type: "press-ok" }, { type: "press-ok" }]);
    expect(actions.filter((a) => a.type === "announce-ready")).toEqual([
      { type: "announce-ready", ready: true },
      { type: "announce-ready", ready: false },
    ]);
  });

  it("對手先好、我方後按 → 立刻放行", () => {
    const { actions } = run(BASE, [{ type: "opponent-ready", ready: true }, { type: "press-ok" }]);
    expect(sent(actions)).toEqual([{ type: "send-ok", reason: "both-ready" }]);
  });

  it("對手好了但我方還沒按 → 什麼都不做", () => {
    // 這裡若送出就等於插件替玩家承諾了，絕對不行。
    const { actions, state } = run(BASE, [{ type: "opponent-ready", ready: true }]);
    expect(sent(actions)).toHaveLength(0);
    expect(state.ready).toBe(false);
  });

  it("對手收回準備 → 不送", () => {
    const { actions } = run(BASE, [
      { type: "press-ok" },
      { type: "opponent-ready", ready: true },
      { type: "opponent-ready", ready: false },
    ]);
    // 第一次 opponent-ready 時雙方就緒就已經送出了，之後 commit 凍住。
    expect(sent(actions)).toHaveLength(1);
  });
});

describe("沒有側通道時（對手沒插件）", () => {
  it("只會走硬底線那條路", () => {
    // 公平性是自動的：沒有側通道就永遠等不到 opponent-ready，
    // 退化成「接近逾時才送出」，不需要額外的偵測或自律機制。
    const { actions, state } = run(BASE, [
      { type: "press-ok" },
      { type: "tick", remainingSeconds: 20 },
      { type: "tick", remainingSeconds: 10 },
      { type: "tick", remainingSeconds: 2.5 },
    ]);
    expect(sent(actions)).toEqual([{ type: "send-ok", reason: "deadline" }]);
    expect(state.committed).toBe(true);
  });
});

describe("階段與回合的重置", () => {
  it("換階段清掉準備，但保留場上的牌", () => {
    const played = run(BASE, [
      { type: "game-event", event: "cardclickedA", cardId: 3, clicked: true },
      { type: "press-ok" },
      { type: "opponent-ready", ready: true },
    ]).state;
    const next = resetForNextPhase(played);
    expect(next.ready).toBe(false);
    expect(next.committed).toBe(false);
    expect(next.opponentReady).toBe(false);
    expect(next.played.A.has(3)).toBe(true);
  });
});

describe("move_select 預設不算操作", () => {
  const ms: ArbiterInput = { type: "game-event", event: "move_select" };

  it("預設不取消（V1 規則 2 只列了出牌/收牌/旋轉）", () => {
    expect(run(BASE, [{ type: "press-ok" }, ms]).state.ready).toBe(true);
  });

  it("打開選項後才取消", () => {
    const c: ArbiterConfig = { ...BASE, moveSelectCounts: true };
    expect(run(c, [{ type: "press-ok" }, ms]).state.ready).toBe(false);
  });
});
