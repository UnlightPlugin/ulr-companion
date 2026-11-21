/**
 * 牌譜 → 逐步盤面、記牌
 *
 * 事件形狀照 2026-10-23 兩個小號對打實錄（地點 003、坐 B）。要抓的坑：
 * 1. 手牌索引整場不變：push 進來、出牌／轉牌／翻開／棄牌都對同一格
 * 2. 對手的牌只有翻開時才有牌面；蓋著的牌分得出是公牌還是事件卡
 * 3. 攻防值照「現在是誰的攻擊階段」分給兩邊（場景名是相對視角）
 * 4. 洗牌：看過的清空，只剩手上看得到的還算在外面
 * 5. 記牌恆等式：沒看過的公牌 = 牌堆剩餘 + 對手蓋著的公牌
 * 6. 表跟實際抽到的牌對不上就標 tableOk=false
 */

import { describe, expect, it } from "vitest";
import type { KifuEvent, KifuMeta } from "@ulr/cdp-adapter";
import {
  buildReplay,
  cardLabel,
  countDeck,
  hiddenDeckCards,
  mergePerspectives,
  PUBLIC_DECKS,
  type KifuCard,
  type PeekSlot,
} from "@ulr/kifu";

const META: KifuMeta = {
  script: 1,
  format: 1,
  side: "B",
  rule: "duel",
  stage: "003",
  turnLimit: 18,
  bgm: null,
  multi: true,
  crossplay: false,
  roomHash: null,
  dialogue: null,
  players: {},
  ownDeck: null,
  opponentCharaIds: [],
  hp: {},
  partial: false,
  attachTurn: 1,
  lang: "tcn",
  client: [],
  baseURL: null,
  tables: {},
  loader: [],
};

/** 地點 003 的第 i 張公牌，照伺服器的形狀 */
function ac(i: number, rotate = false): KifuCard {
  const t = PUBLIC_DECKS["003"]!.cards[i]!;
  const c: KifuCard = {
    swd1: 0,
    gun1: 0,
    shi1: 0,
    mov1: 0,
    spe1: 0,
    swd2: 0,
    gun2: 0,
    shi2: 0,
    mov2: 0,
    spe2: 0,
    index: i,
    type: "ac",
    rotate,
  };
  c[`${t[0]}1`] = t[1];
  c[`${t[2]}2`] = t[3];
  return c;
}
const EV: KifuCard = {
  swd1: 0,
  gun1: 0,
  shi1: 0,
  mov1: 1,
  spe1: 0,
  swd2: 0,
  gun2: 0,
  shi2: 0,
  mov2: 1,
  spe2: 0,
  index: 22,
  type: "event",
};

let clock = 1_000;
const e = (name: string, ...args: unknown[]): KifuEvent => [(clock += 100), "in", name, args];

function opening(): KifuEvent[] {
  return [
    e("game_start"),
    e("phase_start", "DrawPhaseA", null),
    e("add_actioncards", 53),
    e("drawPhase", [ac(46), ac(30), ac(9)], 3),
    e("eventCard", EV, 1),
  ];
}

describe("逐步盤面", () => {
  it("出牌、轉牌、翻開、棄牌都對同一格；對手蓋牌分得出來源", () => {
    const evs = [
      ...opening(),
      e("phase_start", "MovePhaseA", null),
      e("card_submit_player", 0, true, true, false),
      e("card_rotate_player", 1, true, true),
      e("card_submit_opponent", 3, true, false),
      e("cardOpen_A", [{ cardindex: 3, card: { ...EV, swd1: 1, swd2: 1, mov1: 0, mov2: 0 } }]),
      e("move_power", 0, -2, "stay", "front"),
      e("initiative", "A"),
      e("distance", 0, false),
      e("goToBochi", [0], [3]),
    ];
    const r = buildReplay(META, evs);
    expect(r.pov).toBe("B");
    expect(r.unknown).toEqual([]);
    const last = r.steps.at(-1)!.state;
    const me = last.sides.B;
    const opp = last.sides.A;
    expect(me.cards[0]).toBeNull(); // 出了、丟了
    expect(me.cards[1]).toMatchObject({ played: false, rotated: true, src: "deck" });
    expect(me.cards[3]).toMatchObject({ src: "event", card: { type: "event" } });
    expect(opp.cards).toHaveLength(4);
    expect(opp.cards[3]).toBeNull();
    expect(opp.cards.slice(0, 3).every((c) => c?.card === null && c.src === "deck")).toBe(true);
    expect(me.moveDir).toBe("stay");
    expect(opp.movePower).toBe(-2);
    expect(last.initiative).toBe("A");
    expect(last.distance).toBe(0);
    expect(last.deckLeft).toBe(53 - 3 - 3);
    const texts = r.steps.map((s) => s.text);
    expect(texts).toContain("對手翻開：事件 劍1/劍1");
    expect(texts).toContain("對手先攻");
    expect(texts).toContain("移動：我方 待機（0）、對手 前進（-2）");
  });

  it("攻防值照誰的攻擊階段分；擲骰、傷害、結果", () => {
    const evs = [
      ...opening(),
      e("phase_start", "AttackPhaseA", null),
      e("attack_value", 15),
      e("defense_value", 6),
      e("atkvalue", 15, "B"),
      e("diceroll", { atkSuc: 4, defSuc: 1, atkArr: [1, 3], defArr: [2] }),
      e("damage_opponent", 3, 8, 11, true, false),
      e("phase_start", "DefensePhaseA", null),
      e("attack_value", 14),
      e("defense_value", 3),
      e("damage_player", 2, 7, 9, false, true),
      e("result", { code: 0 }),
    ];
    const r = buildReplay(META, evs);
    const atk = r.steps.find((s) => s.kind === "damage" && s.side === "A")!.state;
    expect(atk.sides.B.attack).toBe(15);
    expect(atk.sides.A.defense).toBe(6);
    expect(atk.dice).toMatchObject({ atkSuc: 4, defSuc: 1 });
    const last = r.steps.at(-1)!;
    expect(last.state.sides.A.attack).toBe(14);
    expect(last.state.sides.B.defense).toBe(3);
    expect(last.state.dice).toBeNull(); // 換階段清掉
    expect(last.kind).toBe("result");
    expect(last.state.result).toEqual({ code: 0 });
    expect(r.steps.map((s) => s.text)).toContain("對手受到 3 傷害（8/11）");
    expect(r.steps.map((s) => s.text)).toContain("我方受到直接 2 傷害（7/9）");
  });

  it("搶牌：我的牌被搶（對手多一張蓋牌）、我搶到對手的牌（亮出來）", () => {
    const evs = [
      ...opening(),
      e("cardRob_B", [{ cardindex: 0 }]),
      e("cardRob_A", [{ cardindex: 1, card: ac(12) }]),
    ];
    const r = buildReplay(META, evs);
    const last = r.steps.at(-1)!.state;
    expect(last.sides.B.cards[0]).toBeNull();
    expect(last.sides.B.cards.at(-1)).toMatchObject({ src: "rob", card: { index: 12 } });
    expect(last.sides.A.cards[1]).toBeNull();
    expect(last.sides.A.cards.at(-1)).toMatchObject({ src: "rob", card: null });
    expect(last.seenIndex).toContain(12);
  });

  it("洗牌：看過的清空，只剩手上看得到的", () => {
    const evs = [
      ...opening(),
      e("card_submit_player", 0, true, true, false),
      e("goToBochi", [0], []),
      e("add_actioncards", 50),
    ];
    const last = buildReplay(META, evs).steps.at(-1)!.state;
    expect(last.shuffles).toBe(1);
    expect(last.seenIndex).toEqual([9, 30]); // 46 丟掉了、洗回去
    expect(last.deckLeft).toBe(53 - 6 + 50);
  });

  it("官方不為移動階段送 phase_start：endDrawPhase 就是進移動階段；攻防第幾輪", () => {
    const evs = [
      ...opening(),
      e("endDrawPhase"),
      e("move_power", 0, 0, "stay", "stay"),
      e("phase_start", "AttackPhaseA", null),
      e("phase_start", "DefensePhaseA", null),
    ];
    const r = buildReplay(META, evs);
    const move = r.steps.find((s) => s.text === "移動階段")!;
    expect(move.state.phase).toBe("MovePhaseA");
    const phases = r.steps
      .filter((s) => s.kind === "phase")
      .map((s) => [s.state.phase, s.state.battleRound]);
    expect(phases).toEqual([
      ["DrawPhaseA", null],
      ["MovePhaseA", null],
      ["AttackPhaseA", 1],
      ["DefensePhaseA", 2],
    ]);
  });

  it("牌面文字", () => {
    expect(cardLabel(ac(46))).toBe("移1/防2");
    expect(cardLabel(EV)).toBe("事件 移1/移1");
    expect(cardLabel(null)).toBe("？");
  });
});

describe("記牌", () => {
  it("沒看過的 = 牌堆剩餘 + 對手蓋著的公牌（事件卡不算）", () => {
    const r = buildReplay(META, opening());
    const last = r.steps.at(-1)!.state;
    const hidden = hiddenDeckCards(last.sides.A);
    expect(hidden).toBe(3);
    const d = countDeck("003", r.observed, last.seenIndex, last.deckLeft, hidden)!;
    expect(d.tableOk).toBe(true);
    expect(d.size).toBe(53);
    expect(d.unseen).toHaveLength(53 - 3);
    expect(d.unseen.length).toBe(last.deckLeft + hidden);
    const total = d.unseen.length;
    expect(d.bySuit.swd.cards).toBeGreaterThan(0);
    expect(d.bySuit.swd.cards).toBeLessThanOrEqual(total);
  });

  it("表跟實際的牌對不上：tableOk=false", () => {
    const wrong = { ...ac(0), swd1: 9, gun1: 0 };
    const d = countDeck("003", [wrong], [0], 52, 0)!;
    expect(d.tableOk).toBe(false);
    expect(d.mismatch[0]).toMatch(/^0: 表上/);
  });

  it("沒有表的地點回 null", () => {
    expect(countDeck("999", [], [], 0, 0)).toBeNull();
  });
});

describe("雙視角合併", () => {
  // 同一場：A 抽 0、1 號牌，B 抽 2、3 號；B 出了 3 號、翻開
  const roomHash = "0123456789abcdef";
  const metaA = { ...META, side: "A", roomHash };
  const metaB = { ...META, side: "B", roomHash };
  const evA = [
    e("add_actioncards", 53),
    e("drawPhase", [ac(0), ac(1)], 2),
    e("card_submit_opponent", 1, true, false),
    e("cardOpen_B", [{ cardindex: 1, card: ac(3) }]),
  ];
  const evB = [
    e("add_actioncards", 53),
    e("drawPhase", [ac(2), ac(3)], 2),
    e("card_submit_player", 1, true, true, false),
  ];

  it("對手蓋著的牌補上牌面、標 peek；翻開過的那張先驗過", () => {
    const m = mergePerspectives(buildReplay(metaA, evA), buildReplay(metaB, evB));
    expect(m.ok).toBe(true);
    expect(m.filled).toBe(2); // 1 號在翻開之前也是蓋著的
    const opp = m.replay.steps.at(-1)!.state.sides.B.cards as (PeekSlot | null)[];
    expect(opp[0]).toMatchObject({ peek: true, card: { index: 2 } });
    expect(opp[1]?.peek).toBeUndefined(); // 當時就翻開了
    // 抽牌那一步就看得到（整場同一格同一張）
    const atDraw = m.replay.steps.find((s) => s.text.startsWith("抽牌"))!.state.sides.B
      .cards as PeekSlot[];
    expect(atDraw[0]!.peek).toBe(true);
  });

  it("翻開的牌跟對方記的不一樣：不合併", () => {
    const wrong = [...evA.slice(0, 3), e("cardOpen_B", [{ cardindex: 1, card: ac(9) }])];
    const m = mergePerspectives(buildReplay(metaA, wrong), buildReplay(metaB, evB));
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/對不上/);
  });

  it("不同場、同座位：不合併", () => {
    expect(
      mergePerspectives(buildReplay(metaA, evA), buildReplay({ ...metaB, roomHash: "x" }, evB)).ok,
    ).toBe(false);
    expect(mergePerspectives(buildReplay(metaA, evA), buildReplay(metaA, evA)).ok).toBe(false);
  });
});
