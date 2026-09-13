/**
 * 渦擊破結算的 OK 面板
 *
 * 假的 Raid 場景只有一件事：原型上有 `raid_reward(list)`，數一數被叫了幾次。
 * 三種模式各驗一次，外加「面板上切模式會回報」「拆掉原型還原」。
 */

import { describe, expect, it } from "vitest";
import {
  buildRaidRewardPatchScript,
  buildRaidRewardSetModeExpression,
  isRaidRewardModeReport,
  isRaidRewardReport,
  parseRaidRewardStatus,
  RAID_REWARD_SCRIPT_VERSION,
  RAID_REWARD_STATUS_EXPRESSION,
  RAID_REWARD_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";

type Handler = (...args: unknown[]) => void;

class Obj {
  scene: Scene | null;
  text = "";
  visible = true;
  width = 30;
  height = 12;
  texture = { key: "" };
  handlers = new Map<string, Handler[]>();
  __mode?: string;
  constructor(
    scene: Scene,
    public kind: string,
  ) {
    this.scene = scene;
  }
  destroy(): void {
    this.scene = null;
  }
  on(name: string, fn: Handler): this {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return this;
  }
  emit(name: string): void {
    for (const h of this.handlers.get(name) ?? []) h();
  }
  chain(): this {
    return this;
  }
  setOrigin = this.chain;
  setDepth = this.chain;
  setInteractive = this.chain;
  setStroke = this.chain;
  setStrokeStyle = this.chain;
  setColor = this.chain;
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setTexture(key: string): this {
    this.texture = { key };
    return this;
  }
}

class Scene {
  made: Obj[] = [];
  itemInfo = {
    cmem: { 3: { name_tcn: "生命的碎片" } },
    avatar: { 1: { name_tcn: "古代妙藥" } },
    other: { 0: { name_tcn: "抽獎券(免費)" } },
  };
  ulse01 = { play: () => undefined };
  textures = { exists: (k: string) => k === "panel_ok" };
  add = {
    text: (_x: number, _y: number, text: string) => {
      const o = this.make("text");
      o.text = text;
      return o;
    },
    image: (_x: number, _y: number, key: string) => this.make("image").setTexture(key),
    zone: () => this.make("zone"),
  };
  rexUI = { add: { roundRectangle: () => this.make("rect") } };
  make(kind: string): Obj {
    const o = new Obj(this, kind);
    this.made.push(o);
    return o;
  }
  alive(): Obj[] {
    return this.made.filter((o) => o.scene !== null);
  }
  /** 官方的：只數次數。 */
  raid_reward(list: unknown[]): Promise<void> {
    officialCalls.push(list);
    return Promise.resolve();
  }
}

let officialCalls: unknown[][] = [];

function makeWindow() {
  const reports: unknown[] = [];
  const raid = new Scene();
  const window: Record<string, unknown> = {
    game: { scene: { keys: { Raid: raid } } },
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  return { window, raid, reports };
}

function run(window: Record<string, unknown>, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`) as (
    ...args: unknown[]
  ) => string;
  return fn(
    window,
    () => 1,
    () => undefined,
  );
}

const REWARD = {
  prf: "H59pGlAk1F2y",
  boss: "黑死獸",
  founder: "無名者EX",
  defeat: "白無垢",
  rank: 21,
  dmg: 8201,
  reward_founder: ["ticket_3"],
  reward_participate: ["avatar_1_2"],
  reward_defeat: [],
  reward_rank: ["cmem_3_1"],
  points: [],
};

const call = (raid: Scene, list: unknown[]) =>
  (Object.getPrototypeOf(raid) as Scene).raid_reward.call(raid, list) as Promise<unknown>;

describe("渦擊破結算的 OK 面板", () => {
  it("all：官方原樣，但照樣回報一行", async () => {
    officialCalls = [];
    const { window, raid, reports } = makeWindow();
    const st = parseRaidRewardStatus(
      run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "all" })),
    );
    expect(st).toEqual({
      installed: true,
      version: RAID_REWARD_SCRIPT_VERSION,
      mode: "all",
      open: false,
      reason: null,
    });
    await call(raid, [REWARD]);
    expect(officialCalls.length).toBe(1);
    expect(reports.length).toBe(1);
    expect(isRaidRewardReport(reports[0])).toBe(true);
    const r = reports[0] as { entries: { rewards: Record<string, string[]>; rank: number }[] };
    expect(r.entries[0]!.rank).toBe(21);
    expect(r.entries[0]!.rewards).toEqual({
      founder: ["抽獎券(免費) x3"],
      participate: ["古代妙藥 x2"],
      defeat: [],
      rank: ["生命的碎片 x1"],
    });
  });

  it("none：什麼都不畫、官方不跑，回報照送", async () => {
    officialCalls = [];
    const { window, raid, reports } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" }));
    await call(raid, [REWARD]);
    expect(officialCalls.length).toBe(0);
    expect(raid.alive().length).toBe(0);
    expect(reports.length).toBe(1);
  });

  it("once：一張摘要、一顆 OK；沒勾詳細就不跑官方", async () => {
    officialCalls = [];
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    const p = call(raid, [REWARD, { ...REWARD, prf: "zzz", boss: "妖精" }]);
    expect(parseRaidRewardStatus(run(window, RAID_REWARD_STATUS_EXPRESSION)).open).toBe(true);
    const texts = raid
      .alive()
      .filter((o) => o.kind === "text")
      .map((o) => o.text);
    expect(texts).toContain("渦擊破結算  (2)");
    expect(texts.some((t) => t.startsWith("「H59pGlAk1F2y」 黑死獸"))).toBe(true);
    expect(texts.some((t) => t.startsWith("「zzz」 妖精"))).toBe(true);
    const ok = raid.alive().find((o) => o.texture.key === "panel_ok")!;
    ok.emit("pointerup");
    await p;
    expect(officialCalls.length).toBe(0);
    expect(raid.alive().length).toBe(0);
  });

  it("once：勾了「顯示官方詳細畫面」按 OK 後跑官方", async () => {
    officialCalls = [];
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    const p = call(raid, [REWARD]);
    // 開關那一格是一個 zone，點一下打勾
    const detailHit = raid.alive().filter((o) => o.kind === "zone")[1]!;
    detailHit.emit("pointerup");
    raid
      .alive()
      .find((o) => o.texture.key === "panel_ok")!
      .emit("pointerup");
    await p;
    expect(officialCalls.length).toBe(1);
  });

  it("面板上切模式：回報托盤、之後的結算照新模式走", async () => {
    officialCalls = [];
    const { window, raid, reports } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    const p = call(raid, [REWARD]);
    const none = raid.alive().find((o) => o.__mode === "none")!;
    none.emit("pointerup");
    expect(reports.some((r) => isRaidRewardModeReport(r) && r.mode === "none")).toBe(true);
    raid
      .alive()
      .find((o) => o.texture.key === "panel_ok")!
      .emit("pointerup");
    await p;
    expect(parseRaidRewardStatus(run(window, RAID_REWARD_STATUS_EXPRESSION)).mode).toBe("none");
    await call(raid, [REWARD]);
    expect(raid.alive().length).toBe(0);
    expect(officialCalls.length).toBe(0);
  });

  it("勾了詳細、又在面板上切成不再通知：OK 後官方不跑", async () => {
    officialCalls = [];
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    const p = call(raid, [REWARD]);
    raid
      .alive()
      .filter((o) => o.kind === "zone")[1]!
      .emit("pointerup");
    raid
      .alive()
      .find((o) => o.__mode === "none")!
      .emit("pointerup");
    raid
      .alive()
      .find((o) => o.texture.key === "panel_ok")!
      .emit("pointerup");
    await p;
    expect(officialCalls.length).toBe(0);
    expect(raid.alive().length).toBe(0);
  });

  it("托盤推模式下來；拆掉原型還原", async () => {
    officialCalls = [];
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    expect(run(window, buildRaidRewardSetModeExpression("all"))).toBe("ok");
    await call(raid, [REWARD]);
    expect(officialCalls.length).toBe(1);
    expect(run(window, RAID_REWARD_UNINSTALL_EXPRESSION)).toBe("ok");
    const proto = Object.getPrototypeOf(raid) as { raid_reward: { __ulrRaidReward?: unknown } };
    expect(proto.raid_reward.__ulrRaidReward).toBeUndefined();
    expect(run(window, buildRaidRewardSetModeExpression("all"))).toBe("not-installed");
  });

  it("空清單直接交給官方（它自己會不畫）", async () => {
    officialCalls = [];
    const { window, raid, reports } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    await call(raid, []);
    expect(officialCalls.length).toBe(1);
    expect(reports.length).toBe(0);
  });
});
