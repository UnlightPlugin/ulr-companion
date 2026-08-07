import { createContext, Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeedPatchReport } from "../src/patch-speed.js";
import {
  buildSpeedPatchScript,
  DEFAULT_SPEED_FACTOR,
  DEFAULT_SPEED_LEASE_MS,
  isSpeedPatchReport,
  MAX_SPEED_FACTOR,
  SPEED_PATCH_GLOBAL,
  SPEED_PATCH_RENEW_EXPRESSION,
  SPEED_PATCH_UNINSTALL_EXPRESSION,
} from "../src/patch-speed.js";

const BINDING = "__test_binding";

// ---------------------------------------------------------------------------
// 假的 Phaser
// ---------------------------------------------------------------------------

interface FakeTween {
  timeScale: number;
  repeatCounter?: number;
  data?: { repeat: number }[];
}

interface FakeScene {
  scene: { key: string };
  tweens: { timeScale: number; getTweens(): FakeTween[] };
  /**
   * ⚠ **階段場景的這一顆不該被動到** —— 倒數的循環 TimerEvent 住在裡面。
   * MainA 的那一顆則相反：亮牌與出牌卡頓都在上面，加速它才是重點。
   * 兩者是不同的 Clock 物件，這是安全性的全部依據。
   */
  time: { timeScale: number };
  /** 測試用：讓場景裡有幾條 tween。 */
  _tweens: FakeTween[];
}

function makeScene(key: string, tweens: FakeTween[] = []): FakeScene {
  const list = tweens;
  return {
    scene: { key },
    tweens: { timeScale: 1, getTweens: () => list },
    time: { timeScale: 1 },
    _tweens: list,
  };
}

/** 倒數的警示條：`repeat: -1` + `delay: 20000`（171.js 的 limit10Tween）。 */
function makeLoopingTween(): FakeTween {
  return { timeScale: 1, repeatCounter: -1, data: [{ repeat: -1 }] };
}

/** 一般的一次性演出 tween。 */
function makeOneShotTween(): FakeTween {
  return { timeScale: 1, repeatCounter: 0, data: [{ repeat: 0 }] };
}

interface Page {
  status: unknown;
  reports: SpeedPatchReport[];
  scenes: FakeScene[];
  anims: { globalTimeScale: number };
  speed: { uninstall(): string; factor: number } | undefined;
  /** 換一組 active 場景（換階段）。 */
  setScenes(next: FakeScene[]): void;
  /** 再求值一次同一支腳本（換倍率／重裝）。 */
  reinstall(factor?: number): unknown;
  uninstallViaExpression(): unknown;
  /** 插件還活著的訊號。停掉它就等於模擬插件當掉。 */
  renewViaExpression(): unknown;
}

function bootPage(
  options: { factor?: number; withGame?: boolean; scenes?: FakeScene[]; leaseMs?: number } = {},
): Page {
  const reports: SpeedPatchReport[] = [];
  let active: FakeScene[] = options.scenes ?? [makeScene("MainA"), makeScene("MovePhaseA")];
  const anims = { globalTimeScale: 1 };

  const sandbox: Record<string, unknown> = {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (t: unknown) => clearInterval(t as ReturnType<typeof setInterval>),
    JSON,
    String,
    Math,
    // 租約靠 Date.now()。vi.useFakeTimers() 會把它一起假掉，所以
    // advanceTimersByTime 能同時推進計時器與時鐘。
    Date,
  };
  const win: Record<string, unknown> = {
    [BINDING]: (json: string) => {
      const parsed: unknown = JSON.parse(json);
      if (isSpeedPatchReport(parsed)) reports.push(parsed);
    },
  };
  if (options.withGame !== false) {
    win["game"] = {
      scene: { getScenes: (_onlyActive: boolean) => active },
      anims,
    };
  }
  sandbox["window"] = win;

  const run = (factor?: number): unknown =>
    new Script(
      buildSpeedPatchScript({
        bindingName: BINDING,
        ...(factor !== undefined ? { factor } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      }),
    ).runInContext(
      // 同一個 context 重複求值，才測得到「先拆再裝」
      contextFor(sandbox),
    );

  const status = run(options.factor);

  return {
    status,
    reports,
    get scenes(): FakeScene[] {
      return active;
    },
    anims,
    get speed(): Page["speed"] {
      return win[SPEED_PATCH_GLOBAL] as Page["speed"];
    },
    setScenes(next: FakeScene[]): void {
      active = next;
    },
    reinstall: run,
    uninstallViaExpression: () =>
      new Script(SPEED_PATCH_UNINSTALL_EXPRESSION).runInContext(contextFor(sandbox)),
    renewViaExpression: () =>
      new Script(SPEED_PATCH_RENEW_EXPRESSION).runInContext(contextFor(sandbox)),
  };
}

/**
 * vm context 要沿用同一顆，否則每次求值都是全新的 window ——
 * 「先拆再裝」那條測試就會永遠是綠的（因為根本沒有舊的可以拆）。
 */
const contexts = new WeakMap<object, Record<string, unknown>>();
function contextFor(sandbox: Record<string, unknown>): Record<string, unknown> {
  let ctx = contexts.get(sandbox);
  if (ctx === undefined) {
    ctx = createContext(sandbox) as Record<string, unknown>;
    contexts.set(sandbox, ctx);
  }
  return ctx;
}

/**
 * 把注入腳本裡的設定解出來。
 *
 * `embedJson` 是雙層的（`JSON.stringify(JSON.stringify(x))`），所以腳本裡長的是
 * `JSON.parse("{\"clockScenes\":[\"MainA\"]}")` —— 直接對腳本字串跑正規表示式
 * 會抓不到跳脫過的引號，而且會安靜地失敗成「找不到 = 通過」。
 */
function configOf(script: string): { clockScenes: string[] } {
  const m = /var CFG = JSON\.parse\((".*?")\);/.exec(script);
  if (m?.[1] === undefined) throw new Error("腳本裡找不到 CFG —— 嵌入方式改了？");
  return JSON.parse(JSON.parse(m[1]) as string) as { clockScenes: string[] };
}

// ---------------------------------------------------------------------------

describe("buildSpeedPatchScript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("產生的是語法正確的 JS", () => {
    expect(() => new Script(buildSpeedPatchScript({ bindingName: BINDING }))).not.toThrow();
  });

  it("⚠ 絕對不能碰階段場景的 scene.time —— 倒數計時器住在那裡", () => {
    // 這是整個檔案最重要的一條。階段場景的 time.timeScale 會讓畫面上的 TIME
    // 跑快，而 WP-12 的硬底線讀的正是那個數字（battle-events.md「讀 TIME 顯示」）。
    // 兩個功能各自都對，合起來會害玩家被強制提早送出 I_am_ok。
    const phases = ["MovePhaseA", "AttackPhaseA", "DefensePhaseA", "DrawPhaseA"].map((k) =>
      makeScene(k),
    );
    const page = bootPage({ factor: 5, scenes: [makeScene("MainA"), ...phases] });
    vi.advanceTimersByTime(1000);
    for (const s of phases) {
      expect(s.time.timeScale).toBe(1);
    }
    // 而 MainA 那一顆**要**被加速 —— 亮牌的 delay:200 與出牌的 await 110ms 在上面
    expect(page.scenes[0]?.time.timeScale).toBe(5);
  });

  it("Clock 白名單裡不能出現任何階段場景", () => {
    // 上面那條測的是行為，這條擋的是「有人以後手滑把階段場景加進白名單」。
    // 用白名單而不是黑名單，是因為遊戲新增階段場景時黑名單會漏 —— 而漏掉的
    // 後果是玩家棄權，不是少加速。
    const scenes = configOf(buildSpeedPatchScript({ bindingName: BINDING })).clockScenes;
    expect(scenes).toEqual(["MainA"]);
    for (const key of scenes) {
      expect(key).not.toMatch(/Phase/);
    }
  });

  it("⚠ 名單外的場景就算叫得再像也不碰它的 Clock", () => {
    // 判準是場景鍵的**完全相符**，不是「包含 Main」之類的模糊比對。
    const lookalike = makeScene("MainAAssets");
    const page = bootPage({ factor: 4, scenes: [makeScene("MainA"), lookalike] });
    vi.advanceTimersByTime(500);
    expect(lookalike.time.timeScale).toBe(1);
    expect(page.scenes[0]?.time.timeScale).toBe(4);
  });

  it("回報會講出哪幾顆 Clock 被加速了", () => {
    // 「我改的東西到底生效了沒」要看得到。階段場景出現在這裡就是嚴重 bug。
    const page = bootPage({
      factor: 3,
      scenes: [makeScene("MainA"), makeScene("MovePhaseA")],
    });
    const first = page.reports[0];
    expect(first?.type).toBe("speed-patch");
    if (first?.type === "speed-patch") {
      expect(first.clockScenes).toEqual(["MainA"]);
    }
  });

  it("拆掉之後 MainA 的 Clock 也還原成 1", () => {
    // 沒還原的話玩家拆掉加速之後亮牌還是快的，而且沒有任何 UI 告訴他。
    const main = makeScene("MainA");
    const page = bootPage({ factor: 6, scenes: [main] });
    expect(main.time.timeScale).toBe(6);

    page.speed?.uninstall();
    expect(main.time.timeScale).toBe(1);
  });

  it("把倍率套到每個 active 場景的 tweens 與全域 anims", () => {
    const page = bootPage({ factor: 4 });
    expect(page.status).toBe("ok");
    for (const s of page.scenes) {
      expect(s.tweens.timeScale).toBe(4);
    }
    expect(page.anims.globalTimeScale).toBe(4);
  });

  it("階段換場景之後，新場景也會被套上", () => {
    // 場景隨階段換（MovePhaseA / DefensePhaseA / AttackPhaseA），只套一次會漏。
    const page = bootPage({ factor: 3 });
    const next = makeScene("DefensePhaseA");
    page.setScenes([next]);
    expect(next.tweens.timeScale).toBe(1);

    vi.advanceTimersByTime(250);
    expect(next.tweens.timeScale).toBe(3);
  });

  it("沒有 game 時回 waiting，之後自己補上", () => {
    // 玩家的順序是「先開插件再開遊戲」。
    const page = bootPage({ withGame: false });
    expect(page.status).toBe("waiting");
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("倍率會被夾在 [1, MAX]", () => {
    const tooHigh = bootPage({ factor: 999 });
    expect(tooHigh.anims.globalTimeScale).toBe(MAX_SPEED_FACTOR);

    const tooLow = bootPage({ factor: 0.1 });
    expect(tooLow.anims.globalTimeScale).toBe(1);
  });

  it("沒給倍率就用預設值", () => {
    const page = bootPage();
    expect(page.anims.globalTimeScale).toBe(DEFAULT_SPEED_FACTOR);
  });

  it("拆掉之後全部還原成 1", () => {
    const page = bootPage({ factor: 6 });
    const scenes = page.scenes;
    expect(page.speed?.uninstall()).toBe("uninstalled");

    for (const s of scenes) {
      expect(s.tweens.timeScale).toBe(1);
    }
    expect(page.anims.globalTimeScale).toBe(1);
    expect(page.speed).toBeUndefined();
  });

  it("拆掉之後不再繼續套 —— 不留孤兒 timer", () => {
    const page = bootPage({ factor: 5 });
    page.speed?.uninstall();

    const next = makeScene("AttackPhaseA");
    page.setScenes([next]);
    vi.advanceTimersByTime(2000);
    expect(next.tweens.timeScale).toBe(1);
  });

  it("重新求值會先還原舊的再裝新的，不會疊起來", () => {
    // ws-events 與 patch-ok 都在「只換設定不換程式碼」上栽過
    // （battle-features.md「兩次犯同一個錯」）。這支一律先拆再裝。
    const page = bootPage({ factor: 8 });
    const scenes = page.scenes;
    expect(scenes[0]?.tweens.timeScale).toBe(8);

    page.reinstall(2);
    expect(scenes[0]?.tweens.timeScale).toBe(2);

    // 舊的 timer 若沒被清掉，會跟新的搶著寫不同的值
    vi.advanceTimersByTime(1000);
    expect(scenes[0]?.tweens.timeScale).toBe(2);
  });

  it("UNINSTALL_EXPRESSION 在沒裝的時候回 not-installed", () => {
    const page = bootPage({ factor: 3 });
    expect(page.uninstallViaExpression()).toBe("uninstalled");
    expect(page.uninstallViaExpression()).toBe("not-installed");
  });

  it("⚠ 無限循環的 tween 要補償回原速 —— 否則讀秒提早變紅", () => {
    // 2026-08-05 玩家實測回報的 bug。倒數的警示條是 repeat:-1 + delay:20000
    // 的循環 tween，被加速之後在還剩 23 秒就開始閃紅。
    const loop = makeLoopingTween();
    const oneShot = makeOneShotTween();
    const scene = makeScene("MovePhaseA", [loop, oneShot]);
    const page = bootPage({ factor: 3, scenes: [scene] });

    // manager ×3，循環 tween 自己 ÷3 → 有效速率 1
    expect(scene.tweens.timeScale).toBe(3);
    expect(loop.timeScale).toBeCloseTo(1 / 3);
    expect(scene.tweens.timeScale * loop.timeScale).toBeCloseTo(1);

    // 一次性演出不補償，維持 ×3
    expect(oneShot.timeScale).toBe(1);
    expect(page.status).toBe("ok");
  });

  it("循環 tween 是晚一點才建立的也會被補償", () => {
    // limit10Tween 在 timer_reset() 時才建立，不是 create() 一次就有。
    const scene = makeScene("MovePhaseA", []);
    bootPage({ factor: 4, scenes: [scene] });

    const late = makeLoopingTween();
    scene._tweens.push(late);
    vi.advanceTimersByTime(250);
    expect(late.timeScale).toBeCloseTo(1 / 4);
  });

  it("拆掉之後循環 tween 也還原成 1", () => {
    const loop = makeLoopingTween();
    const scene = makeScene("MovePhaseA", [loop]);
    const page = bootPage({ factor: 5, scenes: [scene] });
    expect(loop.timeScale).toBeCloseTo(1 / 5);

    page.speed?.uninstall();
    expect(loop.timeScale).toBe(1);
    expect(scene.tweens.timeScale).toBe(1);
  });

  it("回報帶著實際倍率與場景鍵", () => {
    const page = bootPage({ factor: 3 });
    const first = page.reports[0];
    expect(first?.type).toBe("speed-patch");
    if (first?.type === "speed-patch") {
      expect(first.factor).toBe(3);
      expect(first.sceneKeys).toEqual(["MainA", "MovePhaseA"]);
    }
  });

  it("場景組合沒變就不重複回報 —— 不然每 200ms 洗一次畫面", () => {
    const page = bootPage({ factor: 3 });
    const before = page.reports.length;
    vi.advanceTimersByTime(2000);
    expect(page.reports.length).toBe(before);
  });
});

/**
 * 這一組回答的是「插件當掉了會怎樣」。
 *
 * ⚠ 頁面上的 `setInterval` 跑在**遊戲的頁面裡**，插件死掉它照樣活著 ——
 * 少了租約，加速會留到玩家自己重載遊戲為止，而且沒有任何 UI 講得出這件事。
 * 這比「功能沒生效」嚴重：加速是協商出來的，插件死後那個協商已經不存在了。
 */
describe("租約：插件死掉就自己還原", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⚠ 沒人續約，過期後 timeScale 全部回到 1", () => {
    const page = bootPage({ factor: 3, leaseMs: 1000 });
    const scene = page.scenes[0];
    expect(scene?.tweens.timeScale).toBe(3);
    expect(page.anims.globalTimeScale).toBe(3);

    vi.advanceTimersByTime(1500);

    expect(scene?.tweens.timeScale).toBe(1);
    expect(scene?.time.timeScale).toBe(1);
    expect(page.anims.globalTimeScale).toBe(1);
    // 拆乾淨 = 全域也不見了，下次裝的時候不會撞到殘骸。
    expect(page.speed).toBeUndefined();
  });

  it("過期時會回報一則 expired，讓 UI 講得出原因", () => {
    const page = bootPage({ factor: 3, leaseMs: 1000 });
    vi.advanceTimersByTime(1500);
    const last = page.reports.at(-1);
    expect(last?.type).toBe("speed-patch");
    if (last?.type === "speed-patch") {
      expect(last.expired).toBe(true);
      expect(last.factor).toBe(1);
    }
  });

  it("有人續約就一直活著 —— 續約推遲的是過期時間，不是重裝", () => {
    const page = bootPage({ factor: 3, leaseMs: 1000 });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600);
      expect(page.renewViaExpression()).toBe("renewed");
    }
    expect(page.scenes[0]?.tweens.timeScale).toBe(3);
    expect(page.speed).toBeDefined();
  });

  it("⚠ 過期之後 timer 也停掉，不留孤兒", () => {
    const page = bootPage({ factor: 3, leaseMs: 1000 });
    vi.advanceTimersByTime(1500);
    const after = page.reports.length;
    // 還原之後就算場景換了也不該再有動作 —— timer 已經 clearInterval 掉了。
    page.setScenes([makeScene("MainA")]);
    vi.advanceTimersByTime(5000);
    expect(page.reports.length).toBe(after);
    expect(page.scenes[0]?.tweens.timeScale).toBe(1);
  });

  it("沒裝的時候續約回 not-installed —— 呼叫的人靠這個知道要重裝", () => {
    const page = bootPage({ factor: 3, leaseMs: 1000 });
    page.uninstallViaExpression();
    expect(page.renewViaExpression()).toBe("not-installed");
  });

  it("預設租約遠大於補套間隔，正常使用不會誤觸發", () => {
    expect(DEFAULT_SPEED_LEASE_MS).toBeGreaterThan(2000);
    const page = bootPage({ factor: 3 });
    vi.advanceTimersByTime(DEFAULT_SPEED_LEASE_MS - 500);
    expect(page.scenes[0]?.tweens.timeScale).toBe(3);
  });
});
