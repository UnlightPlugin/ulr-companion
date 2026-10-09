/**
 * 伺服器沒回、官方把畫面鎖住的解鎖
 *
 * 把 `buildInputRescuePatchScript()` 產出來的那一串字原封不動 `new Function` 起來跑，
 * 假環境照 2026-09-26 實機：官方 fetch 逾時 reject `Error("<事件>: timed out (<網址>)")`，
 * handler 沒接 → window 的 unhandledrejection。
 *
 * 要抓的坑：
 * 1. 只認逾時；別的例外不碰
 * 2. 只開「正在跑、點擊被關掉」的場景；睡著的、沒在跑的不動
 * 3. 戰鬥中（MainA 開著）什麼都不做
 * 4. 晚一拍才看：渦碼那支先開了點擊就不重複、不回報
 * 5. 重裝只留一個監聽；拆掉收監聽
 * 6. 對戰結束留下的暫停階段場景：MainA 不在了才收、只收官方名單裡的、MainA 還在（含暫停）不動
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInputRescuePatchScript,
  INPUT_RESCUE_SCRIPT_VERSION,
  INPUT_RESCUE_STATUS_EXPRESSION,
  INPUT_RESCUE_UNINSTALL_EXPRESSION,
  isInputRescueReport,
  parseInputRescueStatus,
  timedOutEvent,
} from "@ulr/cdp-adapter";

type Handler = (ev: unknown) => void;
const BINDING = "__ulrCompanionReport";

class Scene {
  input = { enabled: true };
  paused = false;
  stopped = 0;
  constructor(
    public active = true,
    public sleeping = false,
  ) {}
  scene = {
    isActive: () => this.active,
    isSleeping: () => this.sleeping,
    isPaused: () => this.paused,
    stop: () => {
      this.stopped++;
      this.paused = false;
      this.active = false;
    },
  };
}

/** 官方 game_result 暫停之後收不到的樣子：沒在跑、暫停著。 */
function pausedScene(): Scene {
  const sc = new Scene(false);
  sc.paused = true;
  return sc;
}

function setup(scenes: Record<string, Scene>) {
  const listeners = new Set<Handler>();
  const reports: { type: string; [k: string]: unknown }[] = [];
  const window: Record<string, unknown> = {
    game: { scene: { keys: scenes } },
    addEventListener: (name: string, fn: Handler) => {
      if (name === "unhandledrejection") listeners.add(fn);
    },
    removeEventListener: (name: string, fn: Handler) => {
      if (name === "unhandledrejection") listeners.delete(fn);
    },
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  const run = (expression: string): string =>
    // eslint-disable-next-line no-new-func
    (new Function("window", "setTimeout", `return ${expression};`) as (...a: unknown[]) => string)(
      window,
      setTimeout,
    );
  const reject = (message: string) => {
    for (const fn of [...listeners]) fn({ reason: new Error(message) });
  };
  return { window, listeners, reports, run, reject };
}

const TIMEOUT = (ev: string) => `${ev}: timed out (https://www.playunlight.online:15005)`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("畫面解鎖", () => {
  it("逾時：正在跑、點擊關著的場景打開，回報是哪個請求與哪些場景", () => {
    const shop = new Scene();
    const session = new Scene();
    const quest = new Scene(false);
    const sleepy = new Scene(true, true);
    shop.input.enabled = false;
    quest.input.enabled = false;
    sleepy.input.enabled = false;
    const { run, reject, reports } = setup({
      Shop: shop,
      Session: session,
      Quest: quest,
      Edit: sleepy,
    });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    reject(TIMEOUT("shop_buy"));
    // 晚一拍才動
    expect(shop.input.enabled).toBe(false);
    vi.runOnlyPendingTimers();
    expect(shop.input.enabled).toBe(true);
    expect(quest.input.enabled).toBe(false);
    expect(sleepy.input.enabled).toBe(false);
    expect(reports).toEqual([{ type: "input-rescue", event: "shop_buy", scenes: ["Shop"] }]);
    expect(isInputRescueReport(reports[0])).toBe(true);
  });

  it("別的例外不碰", () => {
    const raid = new Scene();
    raid.input.enabled = false;
    const { run, reject, reports } = setup({ Raid: raid });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    reject("Cannot read properties of undefined (reading 'clear')");
    vi.runOnlyPendingTimers();
    expect(raid.input.enabled).toBe(false);
    expect(reports).toEqual([]);
  });

  it("戰鬥中（MainA 開著）什麼都不做", () => {
    const main = new Scene();
    const phase = new Scene();
    phase.input.enabled = false;
    const { run, reject, reports } = setup({ MainA: main, MovePhaseA: phase });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    reject(TIMEOUT("raid_start"));
    vi.runOnlyPendingTimers();
    expect(phase.input.enabled).toBe(false);
    expect(reports).toEqual([]);
  });

  it("別人（渦碼的錯誤框）在同一拍先打開了：不重複、不回報", () => {
    const raid = new Scene();
    raid.input.enabled = false;
    const { run, reject, reports, listeners } = setup({ Raid: raid });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    // patch-raid-view 的監聽：同步就把點擊打開
    listeners.add(() => {
      raid.input.enabled = true;
    });
    reject(TIMEOUT("raid_code_input"));
    vi.runOnlyPendingTimers();
    expect(reports).toEqual([]);
  });

  it("重裝只留一個監聽；拆掉收監聽；狀態算次數", () => {
    const shop = new Scene();
    const { run, reject, listeners } = setup({ Shop: shop });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    expect(listeners.size).toBe(1);
    shop.input.enabled = false;
    reject(TIMEOUT("shop_buy"));
    vi.runOnlyPendingTimers();
    expect(parseInputRescueStatus(run(INPUT_RESCUE_STATUS_EXPRESSION))).toEqual({
      installed: true,
      version: INPUT_RESCUE_SCRIPT_VERSION,
      rescues: 1,
      reason: null,
    });
    expect(run(INPUT_RESCUE_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(listeners.size).toBe(0);
    expect(parseInputRescueStatus(run(INPUT_RESCUE_STATUS_EXPRESSION)).installed).toBe(false);
  });

  it("拆掉之前排好的那一拍也不動", () => {
    const shop = new Scene();
    shop.input.enabled = false;
    const { run, reject, reports } = setup({ Shop: shop });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    reject(TIMEOUT("shop_buy"));
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
    vi.runOnlyPendingTimers();
    expect(shop.input.enabled).toBe(false);
    expect(reports).toEqual([]);
  });

  it("對戰結束（MainA 收掉了）還暫停著的階段場景：替官方收掉，回報收了哪些", () => {
    const main = new Scene(false);
    const draw = pausedScene();
    const move = new Scene(false);
    const { run, reports } = setup({
      MainA: main,
      DrawPhaseA: draw,
      MovePhaseA: move,
      Match: new Scene(),
    });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    // 裝上當下就看一次
    expect(draw.stopped).toBe(1);
    expect(move.stopped).toBe(0);
    expect(reports).toEqual([
      {
        type: "input-rescue",
        kind: "battle-leftover",
        event: "game_result",
        scenes: ["DrawPhaseA"],
      },
    ]);
    expect(isInputRescueReport(reports[0])).toBe(true);
    // 收過了就不再回報
    vi.advanceTimersByTime(3000);
    expect(reports).toHaveLength(1);
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
  });

  it("下一場結束又留下來：巡查一秒內收掉", () => {
    const main = new Scene(false);
    const atk = new Scene(false);
    const { run, reports } = setup({ MainA: main, AttackPhaseA: atk });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    expect(reports).toEqual([]);
    atk.paused = true;
    vi.advanceTimersByTime(1000);
    expect(atk.stopped).toBe(1);
    expect(reports).toHaveLength(1);
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
  });

  it("⚠ MainA 還在（跑著、或自己也被暫停）：階段場景暫停是官方的事，不動", () => {
    const main = new Scene();
    const draw = pausedScene();
    const { run, reports } = setup({ MainA: main, DrawPhaseA: draw });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    vi.advanceTimersByTime(3000);
    expect(draw.stopped).toBe(0);
    main.active = false;
    main.paused = true;
    vi.advanceTimersByTime(3000);
    expect(draw.stopped).toBe(0);
    expect(reports).toEqual([]);
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
  });

  it("名單外的暫停場景不動；還沒載入對戰（沒有 MainA）也不動", () => {
    const other = pausedScene();
    const draw = pausedScene();
    const { run } = setup({ Bonus: other, DrawPhaseA: draw });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    vi.advanceTimersByTime(3000);
    expect([other.stopped, draw.stopped]).toEqual([0, 0]);
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
  });

  it("拆掉之後巡查停掉", () => {
    const main = new Scene(false);
    const draw = new Scene(false);
    const { run } = setup({ MainA: main, DrawPhaseA: draw });
    run(buildInputRescuePatchScript({ bindingName: BINDING }));
    run(INPUT_RESCUE_UNINSTALL_EXPRESSION);
    draw.paused = true;
    vi.advanceTimersByTime(3000);
    expect(draw.stopped).toBe(0);
  });

  it("認逾時訊息的規則跟官方 fetch 的字一樣", () => {
    expect(timedOutEvent(TIMEOUT("raid_code_input"))).toBe("raid_code_input");
    expect(timedOutEvent("raid_code_input: timed out")).toBeNull();
    expect(timedOutEvent("boom")).toBeNull();
  });
});
