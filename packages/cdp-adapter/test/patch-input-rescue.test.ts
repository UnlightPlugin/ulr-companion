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
  constructor(
    public active = true,
    public sleeping = false,
  ) {}
  scene = {
    isActive: () => this.active,
    isSleeping: () => this.sleeping,
  };
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
    vi.runAllTimers();
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
    vi.runAllTimers();
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
    vi.runAllTimers();
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
    vi.runAllTimers();
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
    vi.runAllTimers();
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
    vi.runAllTimers();
    expect(shop.input.enabled).toBe(false);
    expect(reports).toEqual([]);
  });

  it("認逾時訊息的規則跟官方 fetch 的字一樣", () => {
    expect(timedOutEvent(TIMEOUT("raid_code_input"))).toBe("raid_code_input");
    expect(timedOutEvent("raid_code_input: timed out")).toBeNull();
    expect(timedOutEvent("boom")).toBeNull();
  });
});
