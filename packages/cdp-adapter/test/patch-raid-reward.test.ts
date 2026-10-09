/**
 * 渦擊破結算的 OK 面板
 *
 * 假的 Raid 場景照 2026-09-23 改版後的官方流程：`show_raid_reward()` fetch
 * 清單 → 每個渦三個畫面方法 → `raid_reward_receive` → 重讀玩家資料。
 * 畫面方法只數次數；要驗的是「不演」的時候領取回報一個都不能少。
 */

import { describe, expect, it } from "vitest";
import {
  buildRaidRewardPatchScript,
  buildRaidRewardSetModeExpression,
  isRaidItemDeltaReport,
  isRaidRewardReport,
  parseRaidRewardStatus,
  RAID_REWARD_SCRIPT_VERSION,
  RAID_REWARD_STATUS_EXPRESSION,
  RAID_REWARD_UNINSTALL_EXPRESSION,
  type RaidItemDeltaReport,
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
  setAlpha = this.chain;
  setScale = this.chain;
  setFlipX = this.chain;
  setCrop = this.chain;
  setText(t: string): this {
    this.text = t;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setTexture(key: string): this {
    this.texture = { key };
    return this;
  }
}

const CACHE: Record<string, unknown> = {
  CharaCards: [
    { id: 1, chara: 0, kind: 0, rarity: 1, level: 1 },
    { id: 500, chara: 1, kind: 2, rarity: 1, level: 1 },
    { id: 501, chara: 2, kind: 2, rarity: 1, level: 1 },
  ],
  Characters: [{ name_tcn: "艾伯李斯特" }, { name_tcn: "黑死獸" }, { name_tcn: "妖精" }],
  AvatarItems: [{ id: 7, name_tcn: "古代妙藥" }],
  WeaponCards: [{ id: 6, name_tcn: "勇者短劍" }],
  EventCards: [],
};

class Scene {
  made: Obj[] = [];
  pages: string[] = [];
  sent: unknown[][] = [];
  updated = 0;
  queue: unknown[] = [];
  afterFlow: (() => void) | null = null;
  ulse01 = { play: () => undefined };
  textures = {
    exists: (k: string) =>
      ["raid_panel_ok", "btn_arrow-2", "raid_result_panel", "result_panel_overlay"].includes(k),
  };
  cache = { json: { get: (k: string) => CACHE[k] } };
  socket = {
    fetch: (ev: string, ...args: unknown[]): Promise<unknown> => {
      this.sent.push([ev, ...args]);
      if (ev === "db_raid_reward") return Promise.resolve(this.queue);
      return Promise.resolve(true);
    },
  };
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
  receives(): unknown[] {
    return this.sent.filter((m) => m[0] === "raid_reward_receive").map((m) => m[1]);
  }
  /** 官方流程（照 2026-09-25 讀到的原始碼）。 */
  async show_raid_reward(): Promise<void> {
    const list = (await this.socket.fetch("db_raid_reward")) as { profound_id: number }[];
    if (list.length === 0) return;
    for (const e of list) {
      await this.create_reward_init(e);
      await this.create_reward_image(e);
      await this.create_reward_rank(e);
      await this.socket.fetch("raid_reward_receive", e.profound_id);
    }
    this.updated += 1;
    // 官方最後的 update_data（測試用：重讀道具清單）
    this.afterFlow?.();
  }
  create_reward_init(_e: unknown): Promise<void> {
    this.pages.push("init");
    return Promise.resolve();
  }
  create_reward_image(_e: unknown): Promise<void> {
    this.pages.push("image");
    return Promise.resolve();
  }
  create_reward_rank(_e: unknown): Promise<void> {
    this.pages.push("rank");
    return Promise.resolve();
  }
}

function makeWindow() {
  const reports: unknown[] = [];
  const raid = new Scene();
  const window: Record<string, unknown> = {
    game: { scene: { keys: { Raid: raid } } },
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  return { window, raid, reports };
}

/**
 * 假的 webpack 模組表：官方畫卡的 $T.create_card（特徵字串 create_card( 與 TG_BASE_UP）。
 * 回傳每次畫卡的參數。
 */
function withCards(window: Record<string, unknown>): unknown[][] {
  const calls: unknown[][] = [];
  const T = {
    create_card: (sc: Scene, id: number, type: number, slot: number) => {
      calls.push([id, type, slot]);
      return sc.make("card");
    },
  };
  const req = Object.assign((_id: string) => ({ $T: T }), {
    m: { 42: "function(){ create_card(e){} TG_BASE_UP }" },
  });
  // ulrWebpackRequire 認的是陣列：推進去的 chunk 第三格會拿到 require
  const chunks: unknown[] = [];
  chunks.push = (chunk: unknown) => {
    ((chunk as unknown[])[2] as (r: unknown) => void)(req);
    return 0;
  };
  window.webpackChunkunlight = chunks;
  return calls;
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
  profound_id: 101,
  raid_name: "H59pGlAk1F2y",
  raid_monster_id: 500,
  raid_founder: "無名者EX",
  raid_rank: 21,
  raid_score: 8201,
  raid_participants: [],
  raid_reward: {
    founder: [{ id: 6, type: 2, slot: 0, value: 1 }],
    participate: [{ id: 7, type: 3, slot: 0, value: 2 }],
    defeat: [],
    rank: [
      { id: 1, type: 1, slot: 0, value: 1 },
      { id: 0, type: 5, slot: 0, value: 30 },
    ],
  },
};

const call = (raid: Scene) =>
  (Object.getPrototypeOf(raid) as Scene).show_raid_reward.call(raid) as Promise<unknown>;

const flush = () => new Promise((r) => setTimeout(r, 0));

const okButton = (raid: Scene) => raid.alive().find((o) => o.texture.key === "raid_panel_ok")!;

describe("渦擊破結算的 OK 面板", () => {
  it("all：官方原樣，但照樣回報一行", async () => {
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
    raid.queue = [REWARD];
    await call(raid);
    expect(raid.pages).toEqual(["init", "image", "rank"]);
    expect(raid.receives()).toEqual([101]);
    expect(reports.length).toBe(1);
    expect(isRaidRewardReport(reports[0])).toBe(true);
    const r = reports[0] as {
      entries: { prf: string; boss: string; rewards: Record<string, string[]>; rank: number }[];
    };
    expect(r.entries[0]!.rank).toBe(21);
    expect(r.entries[0]!.prf).toBe("H59pGlAk1F2y");
    expect(r.entries[0]!.boss).toBe("黑死獸");
    expect(r.entries[0]!.rewards).toEqual({
      founder: ["勇者短劍 x1"],
      participate: ["古代妙藥 x2"],
      defeat: [],
      rank: ["L1 艾伯李斯特 x1", "30GEM"],
    });
  });

  it("原始獎勵碼記給 patch-raid-view 學獎勵表：每個參加者的排名獎勵、沒有玩家名字", async () => {
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" }));
    const blade = { id: 5005, type: 2, slot: 0, value: 2 };
    raid.queue = [
      {
        ...REWARD,
        raid_participants: [
          { player_name: "甲", point: 900, reward: [blade] },
          { player_name: "乙", point: 0, reward: [] },
        ],
      },
    ];
    await call(raid);
    const seen = window.__ulrRaidRewardSeen as {
      profound_id: number;
      raw: Record<string, unknown>;
    }[];
    expect(seen).toHaveLength(1);
    expect(seen[0]!.profound_id).toBe(101);
    expect(seen[0]!.raw).toEqual({
      founder: REWARD.raid_reward.founder,
      participate: REWARD.raid_reward.participate,
      defeat: [],
      ranks: [[blade], []],
      founderName: "無名者EX",
    });
    expect(JSON.stringify(seen[0]!.raw)).not.toContain("甲");
  });

  it("none：什麼都不畫，但每個渦的領取照樣回報、玩家資料照樣重讀", async () => {
    const { window, raid, reports } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" }));
    raid.queue = [REWARD, { ...REWARD, profound_id: 102 }];
    await call(raid);
    expect(raid.pages).toEqual([]);
    expect(raid.receives()).toEqual([101, 102]);
    expect(raid.updated).toBe(1);
    expect(raid.alive().length).toBe(0);
    expect(reports.length).toBe(1);
  });

  it("once：官方流程先跑完，再一張官方底圖的摘要、一顆 OK；官方畫面不演", async () => {
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    raid.queue = [REWARD, { ...REWARD, profound_id: 102, raid_name: "zzz", raid_monster_id: 501 }];
    const p = call(raid);
    await flush();
    expect(raid.receives()).toEqual([101, 102]);
    expect(parseRaidRewardStatus(run(window, RAID_REWARD_STATUS_EXPRESSION)).open).toBe(true);
    const keys = raid.alive().map((o) => o.texture.key);
    expect(keys).toContain("raid_result_panel");
    expect(keys).toContain("result_panel_overlay");
    const texts = raid
      .alive()
      .filter((o) => o.kind === "text")
      .map((o) => o.text);
    expect(texts).toContain("｢H59pGlAk1F2y｣黑死獸");
    expect(texts).toContain("｢zzz｣妖精");
    expect(texts).toContain("第 21 名  [8,201Pts.]");
    expect(texts).toContain("發現者  無名者EX");
    // 只有一頁：不畫翻頁鈕；面板上沒有切模式／打勾的東西
    expect(keys).not.toContain("btn_arrow-2");
    expect(raid.alive().filter((o) => o.kind === "zone")).toHaveLength(1);
    okButton(raid).emit("pointerup");
    await p;
    expect(raid.pages).toEqual([]);
    expect(raid.alive().length).toBe(0);
  });

  it("每一樣獎勵都畫官方卡面，數量標在卡上，滑上去出分類與名字", async () => {
    const { window, raid } = makeWindow();
    const cards = withCards(window);
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    raid.queue = [REWARD];
    const p = call(raid);
    await flush();
    // 發現 1＋參加 1＋排行 2，照官方頁的順序
    expect(cards).toEqual([
      [6, 2, 0],
      [7, 3, 0],
      [1, 1, 0],
      [0, 5, 0],
    ]);
    expect(raid.alive().filter((o) => o.kind === "card")).toHaveLength(4);
    const texts = () =>
      raid
        .alive()
        .filter((o) => o.kind === "text")
        .map((o) => o.text);
    expect(texts()).toEqual(expect.arrayContaining(["x2", "x30"]));
    expect(texts()).not.toContain("x1");
    const hits = raid.alive().filter((o) => o.kind === "zone" && o.handlers.has("pointerover"));
    hits[1]!.emit("pointerover");
    expect(texts()).toContain("參加獎勵  古代妙藥 x2");
    hits[1]!.emit("pointerout");
    expect(texts()).not.toContain("參加獎勵  古代妙藥 x2");
    okButton(raid).emit("pointerup");
    await p;
    expect(raid.alive().length).toBe(0);
  });

  it("畫卡的找不到：獎勵改寫名字，一樣都不漏；沒有獎勵的渦寫「-」", async () => {
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    const empty = { founder: [], participate: [], defeat: [], rank: [] };
    raid.queue = [REWARD, { ...REWARD, profound_id: 102, raid_reward: empty }];
    const p = call(raid);
    await flush();
    const texts = raid
      .alive()
      .filter((o) => o.kind === "text")
      .map((o) => o.text);
    expect(texts).toContain("勇者短劍 x1 / 古代妙藥 x2 / L1 艾伯李斯特 x1 / 30GEM");
    expect(texts).toContain("-");
    okButton(raid).emit("pointerup");
    await p;
  });

  it("超過一頁：官方翻頁鈕、到頭繞回去，所有渦都看得到", async () => {
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    raid.queue = [1, 2, 3, 4, 5].map((n) => ({ ...REWARD, profound_id: n, raid_name: `渦${n}` }));
    const p = call(raid);
    await flush();
    const names = () =>
      raid
        .alive()
        .filter((o) => o.kind === "text" && o.text.startsWith("｢"))
        .map((o) => o.text);
    expect(names()).toEqual(["｢渦1｣黑死獸", "｢渦2｣黑死獸", "｢渦3｣黑死獸", "｢渦4｣黑死獸"]);
    const arrows = raid.alive().filter((o) => o.texture.key === "btn_arrow-2");
    expect(arrows).toHaveLength(2);
    arrows[1]!.emit("pointerup");
    expect(names()).toEqual(["｢渦5｣黑死獸"]);
    arrows[1]!.emit("pointerup");
    expect(names()[0]).toBe("｢渦1｣黑死獸");
    arrows[0]!.emit("pointerup");
    expect(names()).toEqual(["｢渦5｣黑死獸"]);
    okButton(raid).emit("pointerup");
    await p;
    expect(raid.alive().length).toBe(0);
  });

  it("托盤推模式下來；拆掉原型還原", async () => {
    const { window, raid } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    expect(run(window, buildRaidRewardSetModeExpression("all"))).toBe("ok");
    raid.queue = [REWARD];
    await call(raid);
    expect(raid.pages).toEqual(["init", "image", "rank"]);
    expect(run(window, RAID_REWARD_UNINSTALL_EXPRESSION)).toBe("ok");
    const proto = Object.getPrototypeOf(raid) as Record<string, { __ulrRaidReward?: unknown }>;
    for (const n of [
      "show_raid_reward",
      "create_reward_init",
      "create_reward_image",
      "create_reward_rank",
    ]) {
      expect(proto[n]!.__ulrRaidReward).toBeUndefined();
    }
    expect(run(window, buildRaidRewardSetModeExpression("all"))).toBe("not-installed");
  });

  it("空清單：官方自己什麼都不畫，也不回報", async () => {
    const { window, raid, reports } = makeWindow();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "once" }));
    raid.queue = [];
    await call(raid);
    expect(raid.sent).toEqual([["db_raid_reward"]]);
    expect(reports.length).toBe(0);
    expect(raid.alive().length).toBe(0);
  });

  it("客戶端改版找不到方法：狀態帶原因，不假裝生效", () => {
    const reports: unknown[] = [];
    const window: Record<string, unknown> = {
      game: { scene: { keys: { Raid: {} } } },
      [BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
    };
    const st = parseRaidRewardStatus(
      run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" })),
    );
    expect(st.installed).toBe(true);
    expect(st.reason).toContain("show_raid_reward");
  });
});

/** 官方 registry 的樣子：set 已有的鍵發 changedata-鍵，第一次放發 setdata */
class Registry {
  data = new Map<string, unknown>();
  handlers = new Map<string, Handler[]>();
  events = {
    on: (name: string, fn: Handler) => {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    },
    off: (name: string, fn: Handler) => {
      this.handlers.set(
        name,
        (this.handlers.get(name) ?? []).filter((h) => h !== fn),
      );
    },
  };
  get(k: string): unknown {
    return this.data.get(k);
  }
  set(k: string, v: unknown): void {
    const had = this.data.has(k);
    this.data.set(k, v);
    const name = had ? `changedata-${k}` : "setdata";
    for (const h of this.handlers.get(name) ?? []) {
      if (had) h(this, v);
      else h(this, k, v);
    }
  }
  count(): number {
    return [...this.handlers.values()].reduce((s, l) => s + l.length, 0);
  }
}

describe("結算對帳：領了沒、哪個渦、道具真的進了沒", () => {
  const FRAG = { card_id: 10010, quantity: 320, update_at: "2026-09-26T13:00:00.000Z" };
  const setup = () => {
    const made = makeWindow();
    const registry = new Registry();
    registry.data.set("chara_card", [FRAG]);
    (made.window.game as { registry?: Registry }).registry = registry;
    CACHE.CharaCards = [
      ...(CACHE.CharaCards as unknown[]),
      { id: 10010, chara: 2, kind: 10, rarity: 1, level: 1 },
    ];
    return { ...made, registry };
  };

  it("回報「領了」的結果、發現時刻（從清單記的）、每樣獎勵落在哪份清單", async () => {
    const { window, raid, reports } = setup();
    window.__ulrRaidMeta = { "101": { found: 1790000000000 } };
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" }));
    const own = raid.socket.fetch;
    raid.socket.fetch = (ev: string, ...args: unknown[]) =>
      ev === "raid_reward_receive" && args[0] === 102 ? Promise.resolve(false) : own(ev, ...args);
    raid.queue = [REWARD, { ...REWARD, profound_id: 102 }];
    await call(raid);
    const rep = reports.find((r) => isRaidRewardReport(r)) as {
      entries: { found: number | null; received: boolean | null; items: unknown[] }[];
    };
    expect(rep.entries.map((e) => [e.found, e.received])).toEqual([
      [1790000000000, true],
      [null, false],
    ]);
    expect(rep.entries[0]!.items).toEqual([
      { key: "weapon_card:6", name: "勇者短劍", value: 1 },
      { key: "avatar_item:7", name: "古代妙藥", value: 2 },
      { key: "chara_card:1", name: "L1 艾伯李斯特", value: 1 },
    ]);
    // 包的那層收掉了，官方的 socket.fetch 原樣
    expect(Object.prototype.hasOwnProperty.call(raid.socket, "fetch")).toBe(true);
    raid.socket.fetch = own;
  });

  it("裝上就報一次起點；結算途中官方重讀的道具等結算報完才報；拆掉聽的全收", async () => {
    const { window, raid, reports, registry } = setup();
    run(window, buildRaidRewardPatchScript({ bindingName: BINDING, mode: "none" }));
    const deltas = () => reports.filter((r) => isRaidItemDeltaReport(r)) as RaidItemDeltaReport[];
    expect(deltas()).toHaveLength(1);
    expect(deltas()[0]).toMatchObject({
      registry: "chara_card",
      initial: true,
      changes: [],
      levels: { "chara_card:10006": 0, "chara_card:10010": 320 },
    });
    // 官方結算流程裡重讀 chara_card（假的：真的是在別處重讀）
    raid.afterFlow = () => registry.set("chara_card", [{ ...FRAG, quantity: 322 }]);
    reports.length = 0;
    raid.queue = [REWARD];
    await call(raid);
    expect(reports.map((r) => (r as { type: string }).type)).toEqual([
      "raid-reward",
      "raid-item-delta",
    ]);
    expect(deltas()[0]!.changes).toMatchObject([
      { key: "chara_card:10010", before: 320, after: 322 },
    ]);
    // 第一次放進 registry（登入）也聽得到
    registry.set("weapon_card", [{ card_id: 5000, quantity: 203 }]);
    expect(deltas().at(-1)).toMatchObject({
      registry: "weapon_card",
      levels: { "weapon_card:5000": 203 },
    });
    expect(registry.count()).toBeGreaterThan(0);
    run(window, RAID_REWARD_UNINSTALL_EXPRESSION);
    expect(registry.count()).toBe(0);
  });
});
