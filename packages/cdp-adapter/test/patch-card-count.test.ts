/**
 * 記牌面板（遊戲內）
 *
 * 把 `buildCardCountPatchScript()` 產出的字串跑起來：假 MainA（init 同步設 socket）、假 socket
 * （onAny）、假 Phaser 的 add.container／text／image。要抓的坑：
 * 1. 包原型 init：開場就掛上；看得到開場才顯示，中途接上不顯示
 * 2. 沒看過的 = 整疊扣掉自己抽的、對手翻開的；對手蓋牌分公牌／事件卡
 * 3. 洗牌：看過的清空，只剩手上看得到的
 * 4. 表跟實際的牌對不上：不顯示、回報一次
 * 5. 托盤關掉：面板藏起來；拆掉還原 init、拆監聽
 * 6. 骰率：攻防值出來才算；防守方血量從 room_config 開場、damage_* 更新；擲完骰清掉
 * 7. 對手紀錄：開場照對手名字顯示；托盤換紀錄當場更新
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCardCountPatchScript,
  buildCardCountSetEnabledExpression,
  buildCardCountSetHistoryExpression,
  CARD_COUNT_STATUS_EXPRESSION,
  CARD_COUNT_UNINSTALL_EXPRESSION,
  isCardCountReport,
  parseCardCountStatus,
  type CardCountCard,
  type CardCountOpponent,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";
/** 地點 "003" 的假公牌：0 劍1/槍1、1 防2/移1、2 槍3/特1、3 移1/劍2 */
const DECK: CardCountCard[] = [
  ["swd", 1, "gun", 1],
  ["shi", 2, "mov", 1],
  ["gun", 3, "spe", 1],
  ["mov", 1, "swd", 2],
];

function card(i: number): Record<string, unknown> {
  const t = DECK[i]!;
  const c: Record<string, unknown> = { index: i, type: "ac" };
  for (const s of ["swd", "gun", "shi", "mov", "spe"]) {
    c[`${s}1`] = 0;
    c[`${s}2`] = 0;
  }
  c[`${t[0]}1`] = t[1];
  c[`${t[2]}2`] = t[3];
  return c;
}

class FakeSocket {
  any: ((...a: unknown[]) => void)[] = [];
  readyState = 1;
  onAny(fn: (...a: unknown[]) => void) {
    this.any.push(fn);
  }
  offAny(fn: (...a: unknown[]) => void) {
    this.any = this.any.filter((f) => f !== fn);
  }
  push(name: string, ...args: unknown[]) {
    for (const f of [...this.any]) f(name, ...args);
  }
}

interface FakeText {
  text: string;
  setText(t: string): FakeText;
}
function fakeObj(): Record<string, unknown> {
  const o: Record<string, unknown> = { scene: {} };
  for (const m of ["setStroke", "setOrigin", "setScale", "setDepth"]) o[m] = () => o;
  return o;
}

class MainA {
  socket: FakeSocket | null = null;
  room_config: Record<string, unknown> = {};
  player_side = "A";
  is_complete = false;
  sys = { settings: { status: 8 } };
  texts: FakeText[] = [];
  root: { visible: boolean; scene: unknown; destroyed: boolean } | null = null;
  textures = { exists: () => false, get: () => ({ has: () => false }) };
  add = {
    container: () => {
      const r: { visible: boolean; scene: unknown; destroyed: boolean; [k: string]: unknown } = {
        visible: true,
        scene: {},
        destroyed: false,
        add: () => r,
        setDepth: () => r,
        setVisible: (v: boolean) => ((r.visible = v), r),
        destroy: () => ((r.destroyed = true), (r.scene = undefined)),
      };
      this.root = r;
      return r;
    },
    text: () => {
      const t = fakeObj() as unknown as FakeText;
      t.text = "";
      t.setText = (s: string) => ((t.text = s), t);
      this.texts.push(t);
      return t;
    },
    image: () => fakeObj(),
  };
}
const proto = {
  init(this: MainA, e: { side: string; stage: string; rc?: Record<string, unknown> }) {
    this.player_side = e.side;
    this.room_config = { stage: e.stage, ...(e.rc ?? {}) };
    this.socket = new FakeSocket();
    return Promise.resolve();
  },
};
Object.setPrototypeOf(MainA.prototype, proto);

function setup(enabled = true, history: Record<string, CardCountOpponent> = {}) {
  const m = new MainA();
  const reports: unknown[] = [];
  /** 攻防階段場景（相對視角）：status 5＝正在跑 */
  const atkPhase = { sys: { settings: { status: 0 } } };
  const defPhase = { sys: { settings: { status: 0 } } };
  const window: Record<string, unknown> = {
    game: { scene: { keys: { MainA: m, AttackPhaseA: atkPhase, DefensePhaseA: defPhase } } },
    [BINDING]: (p: string) => reports.push(JSON.parse(p)),
  };
  const run = (expr: string): string =>
    // eslint-disable-next-line no-new-func
    (new Function("window", `return ${expr};`) as (w: unknown) => string)(window);
  run(
    buildCardCountPatchScript({ bindingName: BINDING, decks: { "003": DECK }, enabled, history }),
  );
  const start = (stage = "003", rc: Record<string, unknown> = {}) => {
    m.sys.settings.status = 1;
    void (Object.getPrototypeOf(m) as typeof proto).init.call(m, { side: "A", stage, rc });
    m.sys.settings.status = 5;
  };
  return { m, reports, run, start, atkPhase, defPhase };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("記牌面板", () => {
  it("骰率：每顆 1/3、傷害＝攻擊成功−防禦成功；擊殺率看防守方血量", () => {
    const { m, start, atkPhase, defPhase } = setup();
    start("003", { playerA_chara1_hp: 10, playerB_chara1_hp: 1 });
    const s = m.socket!;
    s.push("add_actioncards", 4);
    // 我方攻擊（A），攻 3 防 0：至少 1 點 = 1 − (2/3)^3 ≈ 70%，平均 1.0，對手 1 血 → 打死 70%
    atkPhase.sys.settings.status = 5;
    s.push("attack_value", 3);
    s.push("defense_value", 0);
    expect(m.texts[6]!.text).toBe("ATK 3 vs DEF 0");
    expect(m.texts[7]!.text).toBe("Avg 1.0  Hit 70%");
    expect(m.texts[8]!.text).toBe("Kill 70%  (HP 1)");
    // 擲完骰清掉
    s.push("diceroll", { atkSuc: 1, defSuc: 0, atkArr: [1, 5, 2], defArr: [] });
    expect(m.texts[6]!.text).toBe("");
    // 我方防守：防守方是自己，血量跟著 damage_player 走
    atkPhase.sys.settings.status = 0;
    defPhase.sys.settings.status = 5;
    s.push("damage_player", 2, 8, 10, true, false);
    s.push("attack_value", 0);
    s.push("defense_value", 2);
    expect(m.texts[7]!.text).toBe("Avg 0.0  Hit 0%");
    expect(m.texts[8]!.text).toBe("Kill 0%  (HP 8)");
    // 換角之後血量不知道 → 不顯示擊殺率
    s.push("change_player", 1);
    s.push("attack_value", 4);
    expect(m.texts[8]!.text).toBe("");
  });

  it("對手紀錄：開場照名字顯示，托盤換紀錄當場更新", () => {
    const { m, run, start } = setup(true, {
      阿明: { win: 2, lose: 1, draw: 0, lastCharas: [] },
    });
    start("003", { playerB_info: { player_name: "阿明" } });
    m.socket!.push("add_actioncards", 4);
    expect(m.texts[9]!.text).toBe("vs 阿明  2W 1L");
    expect(
      run(
        buildCardCountSetHistoryExpression({ 阿明: { win: 3, lose: 1, draw: 1, lastCharas: [] } }),
      ),
    ).toBe("ok");
    expect(m.texts[9]!.text).toBe("vs 阿明  3W 1L 1D");
  });

  it("沒看過的＝整疊扣掉看過的；對手蓋牌只算公牌", () => {
    const { m, run, start } = setup();
    start();
    const s = m.socket!;
    s.push("add_actioncards", 4);
    s.push("drawPhase", [card(0)], 2);
    s.push("eventCard", null, 1);
    vi.advanceTimersByTime(300);
    const st = parseCardCountStatus(run(CARD_COUNT_STATUS_EXPRESSION));
    expect(st.active).toBe(true);
    expect(st.unseen).toBe(3);
    // 標題：沒看過 3 張（整疊 4 − 自己抽的 1）
    expect(m.texts[0]!.text).toBe("Unseen 3");
    // 劍：1/槍1 看過了 → 剩 3 號（移1/劍2）→ 1 張、合計 2
    // 種類、點數合計、下一張是這種的機率（1/3）
    expect(m.texts[1]!.text).toBe("1  2  33%");
    s.push("cardOpen_B", [{ cardindex: 0, card: card(2) }]);
    vi.advanceTimersByTime(300);
    expect(parseCardCountStatus(run(CARD_COUNT_STATUS_EXPRESSION)).unseen).toBe(2);
    expect(m.texts[0]!.text).toBe("Unseen 2");
  });

  it("洗牌：看過的清空，只剩手上看得到的", () => {
    const { m, run, start } = setup();
    start();
    const s = m.socket!;
    s.push("add_actioncards", 4);
    s.push("drawPhase", [card(0), card(1)], 0);
    s.push("goToBochi", [0], []);
    s.push("add_actioncards", 3);
    vi.advanceTimersByTime(300);
    // 0 丟掉洗回去了，1 還在手上 → 沒看過 3 張
    expect(parseCardCountStatus(run(CARD_COUNT_STATUS_EXPRESSION)).unseen).toBe(3);
  });

  it("中途接上不顯示；沒有表的地點不顯示", () => {
    const a = setup();
    a.m.sys.settings.status = 1;
    void proto.init.call(a.m, { side: "A", stage: "003" }); // 原版 init（沒包）→ 走輪詢
    a.m.sys.settings.status = 5;
    vi.advanceTimersByTime(300);
    a.m.socket!.push("add_actioncards", 4);
    vi.advanceTimersByTime(300);
    expect(parseCardCountStatus(a.run(CARD_COUNT_STATUS_EXPRESSION))).toMatchObject({
      active: false,
      reason: "這場中途才接上",
    });

    const b = setup();
    b.start("999");
    b.m.socket!.push("add_actioncards", 4);
    vi.advanceTimersByTime(300);
    expect(parseCardCountStatus(b.run(CARD_COUNT_STATUS_EXPRESSION)).active).toBe(false);
  });

  it("表對不上：不顯示、回報", () => {
    const { m, run, reports, start } = setup();
    start();
    m.socket!.push("add_actioncards", 4);
    m.socket!.push("drawPhase", [{ ...card(0), swd1: 9 }], 0);
    vi.advanceTimersByTime(300);
    expect(parseCardCountStatus(run(CARD_COUNT_STATUS_EXPRESSION)).active).toBe(false);
    expect(reports.filter(isCardCountReport)).toHaveLength(1);
    expect(m.root?.visible).toBe(false);
  });

  it("托盤關掉：藏起來；拆掉還原 init、拆監聽", () => {
    const { m, run, start } = setup();
    start();
    m.socket!.push("add_actioncards", 4);
    vi.advanceTimersByTime(300);
    expect(m.root?.visible).toBe(true);
    expect(run(buildCardCountSetEnabledExpression(false))).toBe("ok");
    expect(m.root?.visible).toBe(false);
    expect(run(CARD_COUNT_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(m.socket!.any).toHaveLength(0);
    expect(Object.getPrototypeOf(m).init).toBe(proto.init);
    expect(m.root?.destroyed).toBe(true);
  });
});
