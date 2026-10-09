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
 * 9. 寶箱面板／任務結束確認框（兩組分開）：auto 等一下才按、hide 當格藏起來按掉、玩家先按了
 *    不再按（官方 onComplete 拆兩次會炸）；搜尋找到任務的框不跳；拆除把 prestep 與 socket 的
 *    listener 拿掉。假的官方流程照 2026-10-08 從 bundle 讀的 quest_reward／quest_end 寫
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendQuestBonusSample,
  buildQuestPanelSetExpression,
  buildQuestSkipResultExpression,
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

type Fn = (...a: unknown[]) => unknown;

class Emitter {
  l: Record<string, Fn[]> = {};
  on(e: string, f: Fn) {
    (this.l[e] ??= []).push(f);
    return this;
  }
  off(e: string, f: Fn) {
    this.l[e] = (this.l[e] ?? []).filter((x) => x !== f);
    return this;
  }
  once(e: string, f: Fn, ctx?: unknown) {
    const w: Fn = (...a) => {
      this.off(e, w);
      return f.apply(ctx, a);
    };
    return this.on(e, w);
  }
  emit(e: string, ...a: unknown[]) {
    for (const f of [...(this.l[e] ?? [])]) f(...a);
    return true;
  }
  count(e: string) {
    return (this.l[e] ?? []).length;
  }
}

/** 面板上的圖（OK 鈕要能 on／emit、有 input）。 */
class Pic extends Obj {
  ev = new Emitter();
  input: { enabled: boolean } | null = null;
  visible = true;
  on(e: string, f: Fn) {
    this.ev.on(e, f);
    return this;
  }
  emit(e: string) {
    return this.ev.emit(e);
  }
  setVisible(v: boolean) {
    this.visible = v;
    return this;
  }
  setInteractive() {
    if (this.input) this.input.enabled = true;
    else this.input = { enabled: true };
    return this;
  }
  disableInteractive() {
    if (this.input) this.input.enabled = false;
    return this;
  }
}

/** Phaser 3.87 的 tween：complete() 沒擋重複、直接叫 onComplete。 */
class FakeTween {
  state: "run" | "pending" | "dead" = "run";
  constructor(
    public targets: unknown[],
    public onComplete?: () => void,
  ) {}
  isPendingRemove() {
    return this.state === "pending";
  }
  isDestroyed() {
    return this.state === "dead";
  }
  complete() {
    this.state = "pending";
    this.onComplete?.();
  }
  destroy() {
    this.state = "dead";
  }
}
class FakeTweens {
  list: FakeTween[] = [];
  add(cfg: { targets: unknown; onComplete?: () => void }) {
    const t = new FakeTween(
      Array.isArray(cfg.targets) ? cfg.targets : [cfg.targets],
      cfg.onComplete,
    );
    this.list.push(t);
    return t;
  }
  of(targets: unknown[]) {
    return this.list.filter(
      (t) => t.state !== "dead" && t.targets.some((x) => targets.includes(x)),
    );
  }
  getTweensOf(targets: unknown[]) {
    return this.of(targets);
  }
  killTweensOf(targets: unknown[]) {
    for (const t of this.of(targets)) t.destroy();
  }
  /** 時間過去、跑著的 tween 都跑完。 */
  finish() {
    for (const t of [...this.list]) if (t.state === "run") t.complete();
  }
  running() {
    return this.list.filter((t) => t.state === "run").length;
  }
}

class Cam {
  alpha = 1;
  setAlpha(a: number) {
    this.alpha = a;
    return this;
  }
}

/** 官方 Result：create 跑勝負字樣與數字動畫，OK 才 result_scene_end（回地圖）。 */
class ResultScene {
  events = new Emitter();
  cameras = { main: new Cam() };
  log: string[] = [];
  result_params: { result: string; bonusgame: boolean; lvup: number | null } = {
    result: "win",
    bonusgame: false,
    lvup: null,
  };
  create() {
    this.log.push("call_win", "result_end_nornal");
    this.events.once("shutdown", this.shutdown, this);
    return Promise.resolve();
  }
  shutdown() {
    this.log.push("shutdown");
  }
  result_scene_end() {
    this.log.push("result_scene_end");
    return Promise.resolve();
  }
}
class BackScene {
  scene = { isActive: () => true };
  cameras = { main: new Cam() };
}

class QuestScene {
  scene = { isActive: () => this.active, isSleeping: () => this.sleeping };
  active = true;
  sleeping = false;
  tweens = new FakeTweens();
  socket = new Emitter();
  sounds: string[] = [];
  quest_reward_base: Pic | null = null;
  quest_reward_ok: Pic | null = null;
  quest_reward_image: Pic | null = null;
  quest_end_result: string | null = null;
  quest_end_base: Pic | null = null;
  quest_end_ok: Pic | null = null;
  quest_found_bg: Pic | null = null;
  quest_found_dialog: Pic | null = null;
  quest_found_ok_btn: Pic | null = null;
  quest_found_ok_text: Pic | null = null;
  found: number[] = [];

  constructor() {
    this.socket.on("quest_end", (r) => (this.quest_end_result = r as string));
    this.socket.on("quest_added", (id) => {
      if (id !== null) void this.show_quest_found_dialog(id as number);
    });
    this.socket.on("quest_found", (id) => void this.show_quest_found_dialog(id as number));
  }

  /** 官方 quest_reward（update_data 那段省略）：淡入、翻卡，等 OK 淡出 300ms 後全拆。 */
  quest_reward(): Promise<boolean> {
    const base = (this.quest_reward_base = new Pic(this, 380, 330));
    const ok = (this.quest_reward_ok = new Pic(this, 380, 470).setInteractive());
    const image = (this.quest_reward_image = new Pic(this, 380, 332));
    this.tweens.add({ targets: [base, ok] });
    this.tweens.add({ targets: image, onComplete: () => this.sounds.push("ulse23") });
    return new Promise((res) => {
      ok.disableInteractive();
      ok.on("pointerup", () => {
        ok.disableInteractive();
        this.tweens.add({
          targets: [base, ok, image],
          onComplete: () => {
            // 官方直接 this.quest_reward_base.destroy()：拆兩次會炸
            this.quest_reward_base!.destroy();
            this.quest_reward_ok!.destroy();
            this.quest_reward_image!.destroy();
            this.quest_reward_base = this.quest_reward_ok = this.quest_reward_image = null;
            res(true);
          },
        });
      });
      ok.setInteractive();
    });
  }

  /** 官方 quest_end：淡入完才 setInteractive，等 OK 淡出後拆。 */
  quest_end(): Promise<boolean> {
    const base = (this.quest_end_base = new Pic(this, 380, 330));
    const ok = (this.quest_end_ok = new Pic(this, 380, 382));
    this.tweens.add({ targets: [base, ok], onComplete: () => ok.setInteractive() });
    return new Promise((res) => {
      ok.on("pointerup", () => {
        ok.disableInteractive();
        this.tweens.add({
          targets: [base, ok],
          onComplete: () => {
            this.quest_end_base!.destroy();
            this.quest_end_ok!.destroy();
            this.quest_end_base = this.quest_end_ok = null;
            res(true);
          },
        });
      });
    });
  }

  /** 官方 show_quest_found_dialog：沒有 tween，按了就拆。 */
  show_quest_found_dialog(id: number): Promise<boolean> {
    this.found.push(id);
    this.quest_found_bg = new Pic(this).setInteractive();
    this.quest_found_dialog = new Pic(this);
    const btn = (this.quest_found_ok_btn = new Pic(this).setInteractive());
    this.quest_found_ok_text = new Pic(this);
    return new Promise((res) => {
      btn.on("pointerup", () => {
        this.sounds.push("ulse01");
        this.quest_found_bg!.destroy();
        this.quest_found_dialog!.destroy();
        this.quest_found_ok_btn!.destroy();
        this.quest_found_ok_text!.destroy();
        res(true);
      });
    });
  }
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

function setup(
  Q: QuestScene,
  B: BonusScene = new BonusScene(),
  more: Record<string, unknown> = {},
) {
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
  const events = new Emitter();
  const window: Record<string, unknown> = {
    webpackChunkunlight: chunks,
    game: { scene: { keys: { Quest: Q, Bonus: B, ...more } }, events },
    __ulrReport: (s: string) => reports.push(JSON.parse(s)),
  };
  /** 下一格開始（Phaser 的 game.step 先發 prestep）。 */
  const frame = () => events.emit("prestep");
  type Runner = (...a: unknown[]) => string;
  const run = (expression: string): string => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", "setInterval", "clearInterval", `return ${expression};`);
    return (fn as Runner)(window, setInterval, clearInterval);
  };
  const st = () => window["__ulrQuestTreasure"] as { mine: Obj[]; marks: number };
  return { run, st, reports, B, frame, events };
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

describe("寶箱面板與任務結束的確認框", () => {
  const status = (run: (e: string) => string) =>
    parseQuestTreasureStatus(run(QUEST_TREASURE_STATUS_EXPRESSION));

  it("預設照官方：什麼都不按", async () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false }));
    void Q.quest_reward();
    Q.socket.emit("quest_end", "win");
    void Q.quest_end();
    vi.advanceTimersByTime(5000);
    frame();
    expect(Q.quest_reward_ok?.scene).toBe(Q);
    expect(Q.quest_end_ok?.scene).toBe(Q);
    expect(status(run)).toMatchObject({ reward: "show", end: "show", rewardPressed: 0 });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("寶箱 hide：下一格前就停掉淡入與翻卡、藏起來、按掉，淡出當場跑完、放行後面", async () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, reward: "hide" }));
    const done = vi.fn();
    void Q.quest_reward().then(done);
    const parts = [Q.quest_reward_base!, Q.quest_reward_ok!, Q.quest_reward_image!];
    frame();
    expect(parts.every((o) => !o.visible && o.scene === undefined)).toBe(true);
    expect(Q.quest_reward_ok).toBeNull();
    // 翻卡的 tween 被停掉：不播 ulse23
    expect(Q.sounds).toEqual([]);
    expect(Q.tweens.running()).toBe(0);
    await Promise.resolve();
    expect(done).toHaveBeenCalledWith(true);
    expect(status(run).rewardPressed).toBe(1);
    // 任務結束那組沒開：不碰
    Q.socket.emit("quest_end", "win");
    void Q.quest_end();
    frame();
    expect(Q.quest_end_ok?.scene).toBe(Q);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("寶箱 auto：照常顯示，1.5 秒後才按；官方的淡出照跑", () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, reward: "auto" }));
    void Q.quest_reward();
    const ok = Q.quest_reward_ok!;
    frame();
    vi.advanceTimersByTime(1400);
    frame();
    expect(ok.input?.enabled).toBe(true);
    vi.advanceTimersByTime(200);
    frame();
    expect(ok.input?.enabled).toBe(false);
    expect(ok.visible).toBe(true);
    // 淡出還在跑（看得到收起來），跑完才拆
    expect(Q.quest_reward_ok).toBe(ok);
    Q.tweens.finish();
    expect(Q.quest_reward_ok).toBeNull();
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("玩家自己先按了就不再按（官方 onComplete 拆兩次會炸）", () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, reward: "auto" }));
    void Q.quest_reward();
    frame();
    Q.quest_reward_ok!.emit("pointerup");
    vi.advanceTimersByTime(2000);
    expect(() => frame()).not.toThrow();
    expect(() => Q.tweens.finish()).not.toThrow();
    expect(Q.quest_reward_ok).toBeNull();
    expect(status(run)).toMatchObject({ rewardPressed: 0, reason: null });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("任務結束 hide：QUEST CLEAR 與結束時 quest_added 給的新任務框都不顯示", async () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, end: "hide" }));
    vi.advanceTimersByTime(600);
    Q.socket.emit("quest_end", "win");
    Q.socket.emit("quest_added", 12);
    const done = vi.fn();
    void Q.quest_end().then(done);
    const base = Q.quest_end_base!;
    frame();
    expect(base.visible).toBe(false);
    expect(Q.quest_end_ok).toBeNull();
    expect(Q.quest_found_ok_btn?.scene).toBeUndefined();
    await Promise.resolve();
    expect(done).toHaveBeenCalledWith(true);
    expect(status(run)).toMatchObject({ end: "hide", endPressed: 2, rewardPressed: 0 });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("任務結束 auto：等官方淡入完能按了，再 1.2 秒才按", () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, end: "auto" }));
    Q.socket.emit("quest_end", "win");
    void Q.quest_end();
    const ok = Q.quest_end_ok!;
    vi.advanceTimersByTime(3000);
    frame();
    // 淡入還沒完：input 是 null，不算按過也不按
    expect(ok.input).toBeNull();
    Q.tweens.finish();
    expect(ok.input?.enabled).toBe(true);
    frame();
    vi.advanceTimersByTime(1100);
    frame();
    expect(ok.input?.enabled).toBe(true);
    vi.advanceTimersByTime(200);
    frame();
    expect(ok.input?.enabled).toBe(false);
    expect(status(run).endPressed).toBe(1);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("搜尋找到任務的框照常顯示；沒在結束任務時的 quest_added 也不跳", () => {
    const Q = new QuestScene();
    const { run, frame } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false, end: "hide" }));
    vi.advanceTimersByTime(600);
    Q.socket.emit("quest_found", 33);
    frame();
    expect(Q.quest_found_ok_btn?.scene).toBe(Q);
    Q.quest_found_ok_btn!.emit("pointerup");
    Q.socket.emit("quest_added", 34);
    frame();
    expect(Q.quest_found_ok_btn?.scene).toBe(Q);
    Q.quest_found_ok_btn!.emit("pointerup");
    // 任務結束超過一分鐘後才來的也不跳
    Q.socket.emit("quest_end", "win");
    vi.advanceTimersByTime(61_000);
    Q.socket.emit("quest_added", 35);
    frame();
    expect(Q.quest_found_ok_btn?.scene).toBe(Q);
    expect(Q.found).toEqual([33, 34, 35]);
    expect(status(run).endPressed).toBe(0);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("執行期換模式；拆除拿掉 prestep 與 socket 的 listener；換了新 socket 跟著換", () => {
    const Q = new QuestScene();
    const { run, frame, events } = setup(Q);
    run(buildQuestTreasurePatchScript({ enabled: false }));
    expect(events.count("prestep")).toBe(1);
    expect(Q.socket.count("quest_added")).toBe(2);
    expect(run(buildQuestPanelSetExpression("reward", "hide"))).toBe("ok");
    void Q.quest_reward();
    frame();
    expect(Q.quest_reward_ok).toBeNull();
    // Quest 場景重進：init 會 new 一條 socket
    const oldSock = Q.socket;
    Q.socket = new Emitter();
    vi.advanceTimersByTime(600);
    expect(oldSock.count("quest_added")).toBe(1);
    expect(Q.socket.count("quest_added")).toBe(1);
    // 重裝只留一份
    run(buildQuestTreasurePatchScript({ enabled: false, end: "auto" }));
    expect(events.count("prestep")).toBe(1);
    expect(status(run)).toMatchObject({ reward: "show", end: "auto" });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
    expect(events.count("prestep")).toBe(0);
    expect(Q.socket.count("quest_added")).toBe(0);
    expect(run(buildQuestPanelSetExpression("end", "hide"))).toBe("not-installed");
  });
});

describe("打完怪物跳過結算", () => {
  const make = () => {
    const Q = new QuestScene();
    Q.sleeping = true; // 任務戰鬥中 Quest 在睡
    const R = new ResultScene();
    const back = new BackScene();
    const env = setup(Q, new BonusScene(), { Result: R, BackA: back });
    return { Q, R, back, ...env };
  };

  it("任務戰鬥、沒有獎勵遊戲：不跑動畫，直接走官方 result_scene_end，鏡頭先藏", async () => {
    const { R, back, run } = make();
    run(buildQuestTreasurePatchScript({ enabled: false, skipResult: true }));
    await R.create();
    expect(R.log).toEqual(["result_scene_end"]);
    expect(R.cameras.main.alpha).toBe(0);
    expect(back.cameras.main.alpha).toBe(0);
    // 官方 create 最後掛的 shutdown 照掛
    R.events.emit("shutdown");
    expect(R.log).toEqual(["result_scene_end", "shutdown"]);
    expect(parseQuestTreasureStatus(run(QUEST_TREASURE_STATUS_EXPRESSION))).toMatchObject({
      skipResult: true,
      resultSkips: 1,
    });
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("有升級：一樣跳過，但鏡頭不藏（升級動畫看得到）", async () => {
    const { R, back, run } = make();
    R.result_params.lvup = 138;
    run(buildQuestTreasurePatchScript({ enabled: false, skipResult: true }));
    await R.create();
    expect(R.log).toEqual(["result_scene_end"]);
    expect(R.cameras.main.alpha).toBe(1);
    expect(back.cameras.main.alpha).toBe(1);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("有獎勵遊戲、不是任務戰鬥（Quest 沒在睡）、開關關著：照官方", async () => {
    const { Q, R, run } = make();
    run(buildQuestTreasurePatchScript({ enabled: false, skipResult: true }));
    R.result_params.bonusgame = true;
    await R.create();
    expect(R.log).toEqual(["call_win", "result_end_nornal"]);
    R.log = [];
    R.result_params.bonusgame = false;
    Q.sleeping = false;
    await R.create();
    expect(R.log).toEqual(["call_win", "result_end_nornal"]);
    R.log = [];
    Q.sleeping = true;
    expect(run(buildQuestSkipResultExpression(false))).toBe("ok");
    await R.create();
    expect(R.log).toEqual(["call_win", "result_end_nornal"]);
    R.log = [];
    run(buildQuestSkipResultExpression(true));
    await R.create();
    expect(R.log).toEqual(["result_scene_end"]);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
  });

  it("拆除把 Result.create 還原；重裝只包一層", () => {
    const { R, run } = make();
    const orig = R.create;
    run(buildQuestTreasurePatchScript({ enabled: false, skipResult: true }));
    run(buildQuestTreasurePatchScript({ enabled: false, skipResult: true }));
    const w = R.create as unknown as { __ulrOrig: unknown };
    expect(w.__ulrOrig).toBe(orig);
    run(QUEST_TREASURE_UNINSTALL_EXPRESSION);
    expect(R.create).toBe(orig);
    expect(Object.prototype.hasOwnProperty.call(R, "create")).toBe(false);
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
