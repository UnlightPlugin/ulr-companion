/**
 * 任務地圖的寶箱標註
 *
 * 把 `buildQuestTreasurePatchScript()` 產出來的那一串字原封不動 `new Function` 起來跑，
 * 假環境照 2026-09-26 實機讀到的形狀：Quest.show_quest_land(quest_id) 生
 * quest_land_image["列_欄"].land_base（origin 0.5,0，在 128+96*欄, 95+72*列）；
 * 卡面走 webpack 模組表裡那支 $T.create_card(scene, id, type, slot, x, y, opts)。
 *
 * 要抓的坑：
 * 1. treasure_no 照 TreasureDatas 解：角色卡／事件卡／道具畫卡面，Gem 與花寫字；表裡沒有的不畫
 * 2. 分配格看**目前牌組的 COST**（不是隨機），卡片下面標區間
 * 3. 走過的格子不畫；走了一格就重畫
 * 4. 任務 id 從包起來的 show_quest_land 記；包之前就開著的地圖退回比任務名
 * 5. 關掉／地圖關了就拆；拆除把 show_quest_land 還原
 * 6. Exp（OwnCard）：牌頭同角色、等級 -1 的 L 卡，R 當 L，最低 L1（玩家實測）
 * 7. High Low：標等級，學到的開始星數標在下一行
 * 8. 學開始星數：Bonus.initialize 之前記 bonus_data.step，等級看人物站的那一格；非 HighLow 不記
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendQuestBonusSample,
  buildQuestTreasurePatchScript,
  buildQuestTreasureSetBonusExpression,
  buildQuestTreasureSetExpression,
  isQuestBonusReport,
  parseQuestBonusSamples,
  summarizeQuestBonus,
  parseQuestTreasureStatus,
  QUEST_TREASURE_SCRIPT_VERSION,
  QUEST_TREASURE_STATUS_EXPRESSION,
  QUEST_TREASURE_TABLE,
  QUEST_TREASURE_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

class Obj {
  scene: QuestScene | undefined;
  depth = 0;
  scale = 1;
  text: string | undefined;
  constructor(
    scene: QuestScene,
    public x = 0,
    public y = 0,
  ) {
    this.scene = scene;
  }
  setScale(s: number) {
    this.scale = s;
    return this;
  }
  setDepth(d: number) {
    this.depth = d;
    return this;
  }
  setOrigin() {
    return this;
  }
  setStroke() {
    return this;
  }
  destroy() {
    this.scene = undefined;
  }
}

/** create_card 回來的卡片（官方是 Container）。記下參數好驗。 */
class Card extends Obj {
  constructor(
    scene: QuestScene,
    public args: { id: number; type: number; slot: number; qty: number },
    x: number,
    y: number,
  ) {
    super(scene, x, y);
  }
}

const createCard = vi.fn(
  (
    sc: QuestScene,
    id: number,
    type: number,
    slot: number,
    x: number,
    y: number,
    opts: { quantity: number },
  ) => new Card(sc, { id, type, slot, qty: opts.quantity }, x, y),
);

// 一張 5 格的任務：
//   0_0 白色石楠3（道具 6，寫「花3」）  0_1 白金幣（角色卡 10005）
//   1_0 槍6卡（事件卡）  1_1 時間沙漏（道具 11）  1_2 50Gem（寫字）
//   2_0 OwnCard1（牌頭的 L 卡）  2_1 表裡沒有（不畫）  2_2 分配 90001（30/50/100 Gem 看 COST）
//   3_1 BonusGame4（標 Lv4）
const QUEST = {
  id: 777,
  name_tcn: "測試任務",
  quest_land_id_0_0: 9,
  quest_land_id_0_1: 1,
  quest_land_id_0_2: 0,
  quest_land_id_1_0: 2,
  quest_land_id_1_1: 3,
  quest_land_id_1_2: 4,
  quest_land_id_2_0: 5,
  quest_land_id_2_1: 6,
  quest_land_id_2_2: 7,
  quest_land_id_3_0: 0,
  quest_land_id_3_1: 8,
  quest_land_id_3_2: 0,
};
const LANDS = [
  { id: 1, treasure_no: 10005 },
  { id: 2, treasure_no: 20014 },
  { id: 3, treasure_no: 30011 },
  { id: 4, treasure_no: 50002 },
  { id: 5, treasure_no: 60001 },
  { id: 6, treasure_no: 30223 },
  { id: 7, treasure_no: 90001 },
  { id: 8, treasure_no: 70004 },
  { id: 9, treasure_no: 30006 },
];

// 史普拉多（cc017）：L1～L5 rarity 5、R1～R5 rarity 6～10；另一個角色的 L4 混淆用
const CHARA_CARDS = [
  { id: 10005, chara: "cc10005", level: 1, rarity: 1, kind: 1 },
  ...[1, 2, 3, 4, 5].map((lv) => ({ id: 160 + lv, chara: "cc017", level: lv, rarity: 5, kind: 0 })),
  ...[1, 2, 3, 4, 5].map((lv) => ({
    id: 165 + lv,
    chara: "cc017",
    level: lv,
    rarity: 5 + lv,
    kind: 0,
  })),
  { id: 24, chara: "cc003", level: 4, rarity: 5, kind: 0 },
];

class QuestScene {
  scene = { isActive: () => this.active, isSleeping: () => false };
  active = true;
  cache = {
    json: {
      get: (k: string) =>
        k === "Quests"
          ? [QUEST]
          : k === "QuestLands"
            ? LANDS
            : k === "CharaCards"
              ? CHARA_CARDS
              : undefined,
    },
  };
  add = {
    text: (x: number, y: number, text: string) => {
      const o = new Obj(this, x, y);
      o.text = text;
      return o;
    },
  };
  quest_land_image: Record<string, { land_base: Obj | null }> = {};
  quest_land_name: Obj | null = null;
  quest_cleared: { land_row: number; land_column: number }[] | null = null;
  quest_data = [{ quest_pid: "p", quest_id: 777 }];
  quest = { current_quest_id: null as number | null };
  unit_chara: Obj | null = null;
  // 牌頭 R5 史普拉多（170）
  deck = [{ deck_id: 1, cost: 60, chara_card_id: [170, 24, 10005] }];
  deck_now = 1;

  /** 開始任務、人物走到某一格（官方：tween 到 128+96*欄, 129+72*列 才送 quest_land_start）。 */
  walkTo(row: number, col: number) {
    this.quest.current_quest_id = 777;
    this.unit_chara ??= new Obj(this);
    this.unit_chara.x = 128 + 96 * col;
    this.unit_chara.y = 129 + 72 * row;
  }

  /** 官方：清掉舊的、照 Quests 那一列生格子。 */
  show_quest_land(questId: number) {
    this.close_quest_land();
    const q = [QUEST].find((x) => x.id === questId)!;
    for (let n = 0; n < 5; n++)
      for (let e = 0; e < 3; e++) {
        const id = (q as Record<string, unknown>)[`quest_land_id_${n}_${e}`];
        this.quest_land_image[`${n}_${e}`] = {
          land_base: id ? new Obj(this, 128 + 96 * e, 95 + 72 * n) : null,
        };
      }
    this.quest_land_name = new Obj(this);
    this.quest_land_name.text = q.name_tcn;
  }
  close_quest_land() {
    for (const k in this.quest_land_image) this.quest_land_image[k]!.land_base?.destroy();
    this.quest_land_image = {};
  }
}

/** 獎勵遊戲場景：官方 create 的最後叫 initialize，那時 bonus_data 剛從 db_bonusgame 拿到。 */
class BonusScene {
  bonus_data: { step: number; dice_current: number } | null = null;
  shown: number[] = [];
  initialize() {
    this.shown.push(this.bonus_data!.step);
  }
  /** 官方：init 拿資料 → create → initialize */
  start(step: number) {
    this.bonus_data = { step, dice_current: 3 };
    this.initialize();
  }
}

function setup(Q: QuestScene, B: BonusScene = new BonusScene()) {
  const chunks: unknown[] = [];
  const req = Object.assign(
    (id: string) => (id === "9" ? { $T: { create_card: createCard } } : {}),
    {
      m: {
        "3": function other() {
          return "nothing";
        },
        "9": function cardModule() {
          return "create_card( TG_BASE_UP";
        },
      },
    },
  );
  chunks.push = (entry: unknown) => {
    (entry as [unknown, unknown, (r: unknown) => void])[2](req);
    return 0;
  };
  const reports: unknown[] = [];
  const window: Record<string, unknown> = {
    webpackChunkunlight: chunks,
    game: { scene: { keys: { Quest: Q, Bonus: B } } },
    __ulrReport: (s: string) => reports.push(JSON.parse(s)),
  };
  type Runner = (...a: unknown[]) => string;
  const run = (expression: string): string => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`);
    return (fn as Runner)(window, setInterval, clearInterval);
  };
  const st = () => window["__ulrQuestTreasure"] as { mine: Obj[]; marks: number };
  return { run, st, reports, B };
}

const BINDING = { bindingName: "__ulrReport" };

const cards = (st: () => { mine: Obj[] }) =>
  st()
    .mine.filter((o): o is Card => o instanceof Card)
    .map((c) => `${c.args.type}:${c.args.id}:${c.args.slot}:${c.args.qty}@${c.x},${c.y}`);
const tags = (st: () => { mine: Obj[] }) =>
  st()
    .mine.filter((o) => !(o instanceof Card))
    .map((o) => o.text);
const textsAt = (st: () => { mine: Obj[] }) =>
  st()
    .mine.filter((o) => !(o instanceof Card))
    .map((o) => `${o.text}@${o.x},${o.y}`);

beforeEach(() => {
  vi.useFakeTimers();
  createCard.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("寶箱表", () => {
  it("原版 TreasureDatas：Gem 的 value 是數量、事件卡帶 slot 2、分配格是 COST 區間", () => {
    expect(QUEST_TREASURE_TABLE[50001]).toEqual([5, 30, 1]);
    expect(QUEST_TREASURE_TABLE[20014]).toEqual([2, 14, 2]);
    expect(QUEST_TREASURE_TABLE[85005]).toEqual([2, 5005, 0]);
    expect(QUEST_TREASURE_TABLE[90001]).toEqual([
      5,
      0,
      1,
      [
        [55, 50001],
        [75, 50002],
        [999, 50003],
      ],
    ]);
  });
});

describe("任務地圖的寶箱標註", () => {
  it("開地圖就在每格右邊畫官方卡面；Gem／花寫字；Exp 畫牌頭的 L 卡、High Low 標等級；表裡沒有的不畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    expect(cards(st)).toEqual([
      "1:10005:1:1@258,135",
      "2:14:2:1@162,207",
      "3:11:1:1@258,207",
      // Exp：牌頭 R5 史普拉多 → L4 史普拉多（164），當角色卡畫
      "1:164:1:1@162,279",
    ]);
    // Gem 與花不畫卡面（縮小後數字看不清）；分配格的 COST 區間排第二行
    expect(textsAt(st)).toEqual([
      "花3@162,135",
      "50Gem@354,207",
      "50Gem@354,271",
      "C56-75@354,287",
      "Lv4@258,343",
    ]);
    expect(
      st()
        .mine.filter((o) => o instanceof Card)
        .every((c) => c.scale === 0.2 && c.depth === 18),
    ).toBe(true);
    const status = parseQuestTreasureStatus(run(QUEST_TREASURE_STATUS_EXPRESSION));
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      found: true,
      onMap: true,
      marks: 8,
    });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("Exp：牌頭等級 -1 的 L 卡，R 當 L 算；L1／R1 給 L1；換牌頭就重畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    const own = () => cards(st).find((c) => c.endsWith("@162,279"));
    const cases: [number, number][] = [
      [170, 164], // R5 → L4
      [165, 164], // L5 → L4
      [168, 162], // R3 → L2
      [166, 161], // R1 → L1
      [161, 161], // L1 → L1
    ];
    for (const [leader, got] of cases) {
      Q.deck[0]!.chara_card_id[0] = leader;
      vi.advanceTimersByTime(600);
      expect(own()).toBe(`1:${got}:1:1@162,279`);
    }
    // 牌頭是查不到 L 卡的角色（這裡是 10005）：不畫
    Q.deck[0]!.chara_card_id[0] = 10005;
    vi.advanceTimersByTime(600);
    expect(own()).toBeUndefined();
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("High Low：學到的開始星數標在等級下一行；一個值標一個、多個標範圍；推新的就重畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(
      buildQuestTreasurePatchScript({
        enabled: true,
        bonusStats: { 4: { min: 27, max: 27, n: 2 } },
      }),
    );
    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "50Gem", "C56-75", "Lv4", "★27"]);
    expect(run(buildQuestTreasureSetBonusExpression({ 4: { min: 25, max: 29, n: 5 } }))).toBe("ok");
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "50Gem", "C56-75", "Lv4", "★25-29"]);
    // 別的等級學到了不影響這一格
    run(buildQuestTreasureSetBonusExpression({ 3: { min: 20, max: 20, n: 1 } }));
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "50Gem", "C56-75", "Lv4"]);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("分配格跟著牌組 COST 換；讀不到 COST 畫第一檔、標 ?", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    Q.deck[0]!.cost = 96;
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "100Gem", "C76+", "Lv4"]);
    Q.deck[0]!.cost = 40;
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "30Gem", "C1-55", "Lv4"]);
    // 讀不到牌組（deck_now 對不到）：分配畫第一檔、標 ?；Exp 也沒有牌頭可畫
    Q.deck_now = 2;
    vi.advanceTimersByTime(600);
    expect(tags(st)).toEqual(["花3", "50Gem", "30Gem", "?", "Lv4"]);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("走過的格子不畫，走了一格就重畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    Q.quest_cleared = [{ land_row: 0, land_column: 1 }];
    vi.advanceTimersByTime(600);
    expect(st().marks).toBe(7);
    const before = [...st().mine];
    Q.quest_cleared.push({ land_row: 1, land_column: 1 });
    vi.advanceTimersByTime(600);
    expect(st().marks).toBe(6);
    expect(before.every((o) => o.scene === undefined)).toBe(true);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("包之前就開著的地圖：比任務名找出是哪一個任務", () => {
    const Q = new QuestScene();
    Q.show_quest_land(777);
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    expect(st().marks).toBe(8);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("地圖關了就拆；關掉開關就拆、打開再畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    const drawn = [...st().mine];
    Q.close_quest_land();
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(0);
    expect(drawn.every((o) => o.scene === undefined)).toBe(true);

    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    expect(st().marks).toBe(8);
    expect(run(buildQuestTreasureSetExpression(false))).toBe("ok");
    expect(st().mine).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(0);
    run(buildQuestTreasureSetExpression(true));
    vi.advanceTimersByTime(600);
    expect(st().marks).toBe(8);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("預設關著：裝上也不畫", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false }));
    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(0);
    expect(createCard).not.toHaveBeenCalled();
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });
});

describe("學 High Low 的開始星數", () => {
  it("站在 High Low 格進獎勵遊戲：官方 initialize 之前記下 step、回報等級（標註關著也記）", () => {
    const Q = new QuestScene();
    const { run, reports, B } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, ...BINDING }));
    Q.walkTo(3, 1);
    B.start(27);
    // 官方 initialize 照常跑
    expect(B.shown).toEqual([27]);
    expect(reports).toHaveLength(1);
    expect(isQuestBonusReport(reports[0])).toBe(true);
    expect(reports[0]).toMatchObject({
      type: "quest-bonus",
      sample: { level: 4, step: 27, quest: 777, land: "3_1" },
    });
    const s = parseQuestTreasureStatus(run(QUEST_TREASURE_STATUS_EXPRESSION));
    expect(s.learned).toBe(1);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("不是 High Low 格、沒在任務裡、同一份 bonus_data 都不記", () => {
    const Q = new QuestScene();
    const { run, reports, B } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true, ...BINDING }));
    // 沒在任務裡（對戰的獎勵遊戲）
    B.start(30);
    // 站在 Exp 格
    Q.walkTo(2, 0);
    B.start(31);
    // 同一份資料再叫一次 initialize
    Q.walkTo(3, 1);
    B.start(27);
    B.initialize();
    expect(reports.map((r) => (r as { sample: { step: number } }).sample.step)).toEqual([27]);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("拆除把 Bonus.initialize 還原", () => {
    const Q = new QuestScene();
    const B = new BonusScene();
    const orig = B.initialize;
    const { run } = setup(Q, B);
    run(buildQuestTreasurePatchScript({ enabled: true, ...BINDING }));
    expect(B.initialize).not.toBe(orig);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
    expect(B.initialize).toBe(orig);
    expect(Object.prototype.hasOwnProperty.call(B, "initialize")).toBe(false);
  });

  it("樣本：統計每一級的最小／最大；超過上限丟最舊的；壞掉的丟掉", () => {
    const at = 1;
    const mk = (level: number, step: number) => ({ level, step, quest: 1, land: "0_0", at });
    let samples = [mk(4, 27), mk(4, 25), mk(3, 20)];
    expect(summarizeQuestBonus(samples)).toEqual({
      3: { min: 20, max: 20, n: 1 },
      4: { min: 25, max: 27, n: 2 },
    });
    samples = appendQuestBonusSample(samples, mk(4, 29), 3);
    expect(samples.map((s) => s.step)).toEqual([25, 20, 29]);
    expect(
      parseQuestBonusSamples({ samples: [mk(4, 27), { level: 9, step: 1 }, "x", mk(1, 5)] }),
    ).toEqual([mk(4, 27), mk(1, 5)]);
    expect(parseQuestBonusSamples(null)).toEqual([]);
  });
});

describe("狀態與拆除", () => {
  it("重裝只留一份；拆除把 show_quest_land 還原、卡面拆掉", () => {
    const Q = new QuestScene();
    const { run, st } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    expect(Object.prototype.hasOwnProperty.call(Q, "show_quest_land")).toBe(true);
    run(buildQuestTreasurePatchScript({ enabled: true }));
    Q.show_quest_land(777);
    vi.advanceTimersByTime(600);
    expect(st().marks).toBe(8);
    const drawn = [...st().mine];
    const s = parseQuestTreasureStatus(run(QUEST_TREASURE_STATUS_EXPRESSION));
    expect(s.version).toBe(QUEST_TREASURE_SCRIPT_VERSION);
    expect(run(QUEST_TREASURE_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(Q, "show_quest_land")).toBe(false);
    expect(drawn.every((o) => o.scene === undefined)).toBe(true);
    expect(run(QUEST_TREASURE_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("讀不懂的回應不丟例外", () => {
    expect(parseQuestTreasureStatus("<html>").installed).toBe(false);
    expect(parseQuestTreasureStatus(JSON.stringify({ installed: false })).installed).toBe(false);
  });
});
