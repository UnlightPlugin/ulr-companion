/**
 * 牌譜 → 逐步盤面（重播與記牌共用）
 * ================================
 * 原始事件逐則套進一份盤面，每則「看得出變化」的事件產出一步（含完整盤面的拷貝）。
 * 播放器拿步驟畫畫面、拖時間軸；記牌拿盤面裡「看過的公牌」算剩下的牌。
 *
 * 語意全部照官方客戶端的 handler（2026-10-23 讀 949.js / 183.js）：
 *
 * | 事件 | 官方做的事 |
 * | --- | --- |
 * | `drawPhase`/`cardDraw(我的牌[], 對手張數)` | 我方逐張 push 進 player_card、對手 push 蓋牌；牌堆各減一 |
 * | `eventCard(牌或 null, 對手張數)` | 同上但不動牌堆（事件卡是角色自己那疊） |
 * | `card_back_player(牌[])`／`card_back_opponent(張數)` | 回到手上（push，不動牌堆） |
 * | `card_submit_player(i, 出?, …)`／`_opponent(i, 出?, …)` | 那張變成出牌／收回手上 |
 * | `card_rotate_player(i, 轉?, …)`／`_opponent(i, 轉?)` | 轉到 180 度＝下半生效 |
 * | `cardOpen_<對手座位>([{cardindex, card}])` | 對手出的牌翻開 |
 * | `goToBochi(我的 i[], 對手 i[])`／`card_remove_*`／`card_break_*` | 那格清空（索引不壓縮） |
 * | `cardRob_<我的座位>([{cardindex}])` | 我的牌被搶：我這格清空、對手多一張蓋牌 |
 * | `cardRob_<對手座位>([{cardindex, card}])` | 我搶到對手的牌：對手那格清空、我多一張 |
 * | `actioncard_changed([{cardindex, card}])` | 我手上那張的數值被改 |
 * | `add_actioncards(n)` | 牌堆 +n（開場與洗牌） |
 * | `move_power(我, 對手, 我的方向, 對手方向)` | 相對順序（我方在前） |
 * | `initiative(座位)`、`distance(距離, 隱藏?)` | 座位是絕對的；距離 0 近、1 中、2 遠 |
 * | `damage_player/opponent(扣血, 剩, 上限, 攻擊?, 非攻擊?)` | 第 4 參數 true＝戰鬥傷害 |
 *
 * **手牌陣列的索引整場不變**：官方只 push、棄牌是把那格設成 null。所以「第 7 張」從抽到、
 * 出牌、轉牌到丟掉都是同一個 7。
 *
 * 這支是純函式、不碰 Node —— 瀏覽器裡的播放器直接用。
 */

import type { KifuEvent, KifuMeta } from "@ulr/cdp-adapter";

export type Seat = "A" | "B";

/** 伺服器送的牌（行動卡與事件卡同一種形狀，多的欄位原樣留著）。 */
export interface KifuCard {
  type?: string;
  index?: number;
  swd1?: number;
  gun1?: number;
  shi1?: number;
  mov1?: number;
  spe1?: number;
  swd2?: number;
  gun2?: number;
  shi2?: number;
  mov2?: number;
  spe2?: number;
  rotate?: boolean;
  [k: string]: unknown;
}

export interface HandSlot {
  /** 從哪來：公牌（抽的）、事件卡、回到手上、搶來的。對手蓋著的牌只有 deck 那些是公牌 */
  src: "deck" | "event" | "back" | "rob";
  /** 牌面；對手沒翻開的是 null */
  card: KifuCard | null;
  /** 出在場上（true）或在手上 */
  played: boolean;
  /** 轉了 180 度（下半生效） */
  rotated: boolean;
}

export interface CharaState {
  card_id?: number;
  chara?: string;
  filename?: string;
  main?: boolean;
  hp?: number;
  hp_max?: number;
  atk?: number;
  def?: number;
  level?: number;
  known?: boolean;
  state?: { type?: string; turn?: number; [k: string]: unknown }[];
  skill?: number[];
  weapon?: unknown;
  [k: string]: unknown;
}

export interface SideState {
  charas: CharaState[];
  /** 索引＝官方 player_card／opponent_card 的索引；丟掉的那格是 null */
  cards: (HandSlot | null)[];
  moveDir: string | null;
  movePower: number | null;
  /** 這個攻防階段的攻擊／防禦值（畫面上那兩個數字） */
  attack: number | null;
  defense: number | null;
}

export interface DiceRoll {
  atkSuc: number;
  defSuc: number;
  atkArr: number[];
  defArr: number[];
  [k: string]: unknown;
}

export interface ReplayState {
  t: number;
  turn: number;
  /** 官方的階段場景名（相對視角：AttackPhaseA＝我方攻擊） */
  phase: string | null;
  /** 攻擊／防禦是這回合的第幾個戰鬥階段（1 或 2；官方階段列 a1/d1 與 a2/d2 的分別） */
  battleRound: number | null;
  distance: number | null;
  initiative: Seat | null;
  deckLeft: number;
  /** 這一疊公牌（洗牌後重算）看過的 index */
  seenIndex: number[];
  /** 洗了幾次牌 */
  shuffles: number;
  sides: Record<Seat, SideState>;
  dice: DiceRoll | null;
  /** 最近一次攻擊結算：攻擊方與攻擊力（0＝攻擊取消） */
  atkValue: { side: Seat; value: number } | null;
  result: unknown;
}

export type StepKind =
  | "start"
  | "draw"
  | "play"
  | "unplay"
  | "rotate"
  | "reveal"
  | "discard"
  | "move"
  | "initiative"
  | "distance"
  | "phase"
  | "attack"
  | "dice"
  | "damage"
  | "heal"
  | "skill"
  | "state"
  | "change"
  | "turn"
  | "bonus"
  | "result"
  | "other";

export interface ReplayStep {
  /** 第幾則原始事件 */
  i: number;
  /** 距開場毫秒 */
  ms: number;
  kind: StepKind;
  /** 哪一邊（絕對座位）；跟哪邊都無關的是 null */
  side: Seat | null;
  /** 給人看的一行 */
  text: string;
  /** 套完這則之後的盤面 */
  state: ReplayState;
}

export interface Replay {
  pov: Seat;
  opp: Seat;
  meta: KifuMeta;
  steps: ReplayStep[];
  /** 沒認得的事件名（新版多了什麼一眼看得到） */
  unknown: string[];
  /** 這場看過的所有行動卡（記牌拿來比對公牌表） */
  observed: KifuCard[];
}

const KIND_NAMES: Record<string, string> = {
  swd: "劍",
  gun: "槍",
  shi: "防",
  mov: "移",
  spe: "特",
};
const SUITS = ["swd", "gun", "shi", "mov", "spe"] as const;
export type Suit = (typeof SUITS)[number];

/** 一張牌的某一半：`{suit, value}`；沒有數字的半邊（全 0）回 null。 */
export function cardHalf(card: KifuCard, half: 1 | 2): { suit: Suit; value: number } | null {
  for (const s of SUITS) {
    const v = card[`${s}${half}`];
    if (typeof v === "number" && v > 0) return { suit: s, value: v };
  }
  return null;
}

/** `劍3/槍1`（上半/下半）。 */
export function cardLabel(card: KifuCard | null): string {
  if (card === null) return "？";
  const a = cardHalf(card, 1);
  const b = cardHalf(card, 2);
  const f = (h: { suit: Suit; value: number } | null) =>
    h === null ? "-" : `${KIND_NAMES[h.suit]}${h.value}`;
  const label = `${f(a)}/${f(b)}`;
  return card.type === "event" ? `事件 ${label}` : label;
}

/** 目前生效的那一半（轉過就是下半）。 */
export function activeHalf(slot: HandSlot): { suit: Suit; value: number } | null {
  if (slot.card === null) return null;
  return cardHalf(slot.card, slot.rotated ? 2 : 1);
}

function emptySide(): SideState {
  return { charas: [], cards: [], moveDir: null, movePower: null, attack: null, defense: null };
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function asCard(v: unknown): KifuCard | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as KifuCard) : null;
}

const PHASE_NAMES: Record<string, string> = {
  DrawPhaseA: "抽牌階段",
  MovePhaseA: "移動階段",
  AttackPhaseA: "攻擊階段",
  DefensePhaseA: "防禦階段",
  ChangePhaseA: "換角",
  AtkDicerollA: "擲骰",
  DefDiceRollA: "擲骰",
};
const DIR_NAMES: Record<string, string> = {
  front: "前進",
  back: "後退",
  stay: "待機",
  change: "換角",
};
const DIST_NAMES = ["近距離", "中距離", "遠距離"];
const RULE_NAMES: Record<string, string> = {
  duel: "對戰",
  ranked: "排名戰",
  quest: "任務",
  raid: "渦",
  event: "活動",
};

/** 只改盤面、不成為一步的事件（畫面細節、UI 開關）。 */
const SILENT = new Set([
  "card_interactive",
  "decide_btn_visible",
  "timer_stop",
  "timerPause",
  "timerResume",
  "phase_defense_start",
  "skillbase",
  "passivebase",
  "restrict_action",
  "restrict_action_player",
  "restrict_action_opponent",
  "attack_value",
  "defense_value",
  "endMovePhase",
  "endPhase",
  "defense_phase_end",
  "turn_refresh",
  "draw_additional",
  "draw_delete",
  "move_select",
  "game_ready",
  "get_chara_player",
  "get_chara_opponent",
  "player_ready",
  "card_submit",
  "card_rotate",
  "leaveRoom",
  "friend_apply_update",
  "stamp_use_player",
  "stamp_use_opponent",
  "mist_effect_create",
  "mist_effect_destroy",
]);

export function buildReplay(meta: KifuMeta, events: readonly KifuEvent[]): Replay {
  const pov: Seat = meta.side === "B" ? "B" : "A";
  const opp: Seat = pov === "A" ? "B" : "A";
  const t0 = events.length > 0 ? events[0]![0] : 0;
  const st: ReplayState = {
    t: t0,
    turn: meta.attachTurn ?? 1,
    phase: null,
    battleRound: null,
    distance: null,
    initiative: null,
    deckLeft: 0,
    seenIndex: [],
    shuffles: 0,
    sides: { A: emptySide(), B: emptySide() },
    dice: null,
    atkValue: null,
    result: null,
  };
  const steps: ReplayStep[] = [];
  const unknown = new Set<string>();
  const seen = new Set<number>();
  const observed: KifuCard[] = [];
  let opened = false;

  const me = () => st.sides[pov];
  const them = () => st.sides[opp];
  const snapshot = (): ReplayState => ({
    ...structuredClone(st),
    seenIndex: [...seen].sort((a, b) => a - b),
  });
  const push = (i: number, kind: StepKind, side: Seat | null, text: string) => {
    steps.push({ i, ms: st.t - t0, kind, side, text, state: snapshot() });
  };
  const see = (c: KifuCard | null) => {
    if (c !== null && c.type === "ac" && typeof c.index === "number") {
      seen.add(c.index);
      observed.push(c);
    }
  };
  const who = (s: Seat) => (s === pov ? "我方" : "對手");
  const addCards = (side: SideState, cards: (KifuCard | null)[], src: HandSlot["src"]) => {
    for (const c of cards)
      side.cards.push({ card: c, played: false, rotated: c?.rotate === true, src });
  };
  const slotAt = (side: SideState, i: unknown): HandSlot | null =>
    typeof i === "number" ? (side.cards[i] ?? null) : null;
  const clear = (side: SideState, i: unknown) => {
    if (typeof i === "number" && i >= 0 && i < side.cards.length) side.cards[i] = null;
  };

  push(
    -1,
    "start",
    null,
    `${RULE_NAMES[meta.rule ?? ""] ?? meta.rule ?? "戰鬥"}開始（地點 ${meta.stage ?? "?"}，我方坐 ${pov}）${meta.partial ? `；第 ${meta.attachTurn ?? "?"} 回合才開始錄` : ""}`,
  );

  events.forEach((ev, i) => {
    const [t, dir, name, rawArgs] = ev;
    const a = Array.isArray(rawArgs) ? rawArgs : [];
    st.t = t;
    if (dir === "out") return; // 自己送的操作：結果伺服器會再推一則，以那則為準
    if (SILENT.has(name)) {
      applySilent(name, a);
      return;
    }
    switch (name) {
      case "game_start":
        push(i, "start", null, "對戰開始");
        return;
      case "chara_A":
      case "chara_B": {
        const s = name === "chara_A" ? "A" : "B";
        st.sides[s].charas = a.map((c) => (asCard(c) ?? {}) as CharaState);
        return; // 每個階段都推一次，不當成一步（變化另外由傷害／狀態事件說）
      }
      case "add_actioncards": {
        const n = num(a[0]);
        if (opened || st.deckLeft > 0) {
          st.shuffles++;
          seen.clear();
          // 手上（雙方看得到的）那些牌不在新的牌堆裡
          for (const sd of [me(), them()]) for (const sl of sd.cards) if (sl !== null) see(sl.card);
        }
        opened = true;
        st.deckLeft += n;
        push(
          i,
          "draw",
          null,
          st.shuffles > 0 ? `洗牌：公牌補到 ${st.deckLeft} 張` : `公牌 ${n} 張`,
        );
        return;
      }
      case "drawPhase":
      case "cardDraw": {
        const mine = (Array.isArray(a[0]) ? a[0] : []).map(asCard);
        const n = num(a[1]);
        addCards(me(), mine, "deck");
        for (const c of mine) see(c);
        addCards(them(), new Array<null>(n).fill(null), "deck");
        st.deckLeft = Math.max(0, st.deckLeft - mine.length - n);
        push(
          i,
          "draw",
          null,
          `抽牌：我方 ${mine.map(cardLabel).join("、") || "0 張"}；對手 ${n} 張`,
        );
        return;
      }
      case "eventCard": {
        const c = asCard(a[0]);
        const n = num(a[1]);
        if (c !== null) addCards(me(), [c], "event");
        addCards(them(), new Array<null>(n).fill(null), "event");
        push(i, "draw", null, `事件卡：我方 ${c === null ? "沒有" : cardLabel(c)}；對手 ${n} 張`);
        return;
      }
      case "card_back_player": {
        const cs = (Array.isArray(a[0]) ? a[0] : []).map(asCard);
        addCards(me(), cs, "back");
        push(i, "draw", pov, `回到我方手上：${cs.map(cardLabel).join("、")}`);
        return;
      }
      case "card_back_opponent": {
        const n = num(a[0]);
        addCards(them(), new Array<null>(n).fill(null), "back");
        push(i, "draw", opp, `回到對手手上 ${n} 張`);
        return;
      }
      case "card_submit_player":
      case "card_submit_opponent": {
        const s = name === "card_submit_player" ? pov : opp;
        const sl = slotAt(st.sides[s], a[0]);
        const play = a[1] === true;
        if (sl !== null) sl.played = play;
        push(
          i,
          play ? "play" : "unplay",
          s,
          `${who(s)}${play ? "出牌" : "收回"}${sl?.card ? ` ${cardLabel(sl.card)}` : ""}`,
        );
        return;
      }
      case "card_rotate_player":
      case "card_rotate_opponent": {
        const s = name === "card_rotate_player" ? pov : opp;
        const sl = slotAt(st.sides[s], a[0]);
        if (sl !== null) sl.rotated = a[1] === true;
        push(
          i,
          "rotate",
          s,
          `${who(s)}轉牌${sl?.played ? "（場上）" : "（手上）"}${sl?.card ? ` → ${activeLabel(sl)}` : ""}`,
        );
        return;
      }
      case "actioncard_changed": {
        const list = Array.isArray(a[0]) ? a[0] : [];
        for (const x of list) {
          const o = asCard(x);
          const sl = slotAt(me(), o?.cardindex);
          const c = asCard(o?.card);
          if (sl !== null && c !== null) sl.card = c;
        }
        if (list.length > 0) push(i, "other", pov, `我方 ${list.length} 張牌的數值變了`);
        return;
      }
      case "goToBochi": {
        const mine = Array.isArray(a[0]) ? a[0] : [];
        const theirs = Array.isArray(a[1]) ? a[1] : [];
        for (const x of mine) clear(me(), x);
        for (const x of theirs) clear(them(), x);
        if (mine.length + theirs.length > 0)
          push(i, "discard", null, `棄牌：我方 ${mine.length} 張、對手 ${theirs.length} 張`);
        return;
      }
      case "card_remove_player":
      case "card_remove_opponent": {
        const s = name === "card_remove_player" ? pov : opp;
        const list = Array.isArray(a[0]) ? a[0] : [];
        for (const x of list) clear(st.sides[s], x);
        push(i, "discard", s, `${who(s)}失去 ${list.length} 張牌`);
        return;
      }
      case "card_break_player":
      case "card_break_opponent": {
        const s = name === "card_break_player" ? pov : opp;
        const list = Array.isArray(a[0]) ? a[0] : [];
        const labels: string[] = [];
        for (const x of list) {
          const o = asCard(x);
          const c = asCard(o?.card);
          see(c);
          const sl = slotAt(st.sides[s], o?.cardindex);
          labels.push(cardLabel(c ?? sl?.card ?? null));
          clear(st.sides[s], o?.cardindex);
        }
        push(i, "discard", s, `${who(s)}的牌被破壞：${labels.join("、")}`);
        return;
      }
      case "result":
        st.result = a[0] ?? null;
        push(i, "result", null, "戰鬥結束");
        return;
      case "endDrawPhase":
        // 官方不為移動階段送 phase_start：DrawPhaseA.phase_end() 自己切過去（949.js）
        st.phase = "MovePhaseA";
        st.battleRound = null;
        st.dice = null;
        st.atkValue = null;
        for (const s of [me(), them()]) {
          s.moveDir = null;
          s.movePower = null;
          s.attack = null;
          s.defense = null;
        }
        push(i, "phase", null, PHASE_NAMES.MovePhaseA!);
        return;
      case "phase_start": {
        const prev = st.phase;
        st.phase = typeof a[0] === "string" ? a[0] : null;
        if (st.phase === "AttackPhaseA" || st.phase === "DefensePhaseA")
          st.battleRound = prev === "AttackPhaseA" || prev === "DefensePhaseA" ? 2 : 1;
        else st.battleRound = null;
        if (st.phase === "MovePhaseA" || st.phase === "DrawPhaseA") {
          for (const s of [me(), them()]) {
            s.moveDir = null;
            s.movePower = null;
          }
        }
        if (st.phase === "AttackPhaseA" || st.phase === "DefensePhaseA") {
          for (const s of [me(), them()]) {
            s.attack = null;
            s.defense = null;
          }
          st.dice = null;
          st.atkValue = null;
        }
        push(i, "phase", null, PHASE_NAMES[st.phase ?? ""] ?? String(st.phase));
        return;
      }
      case "move_power":
        me().movePower = num(a[0]);
        them().movePower = num(a[1]);
        me().moveDir = typeof a[2] === "string" ? a[2] : null;
        them().moveDir = typeof a[3] === "string" ? a[3] : null;
        push(
          i,
          "move",
          null,
          `移動：我方 ${DIR_NAMES[me().moveDir ?? ""] ?? me().moveDir}（${me().movePower}）、對手 ${DIR_NAMES[them().moveDir ?? ""] ?? them().moveDir}（${them().movePower}）`,
        );
        return;
      case "initiative":
        st.initiative = a[0] === "A" || a[0] === "B" ? a[0] : null;
        push(
          i,
          "initiative",
          st.initiative,
          st.initiative === null ? "先攻？" : `${who(st.initiative)}先攻`,
        );
        return;
      case "distance":
        st.distance = typeof a[0] === "number" ? a[0] : null;
        push(
          i,
          "distance",
          null,
          `距離：${DIST_NAMES[st.distance ?? -1] ?? st.distance}${a[1] === true ? "（隱藏）" : ""}`,
        );
        return;
      case "atkvalue": {
        const s: Seat = a[1] === "A" || a[1] === "B" ? a[1] : opp;
        st.atkValue = { side: s, value: num(a[0]) };
        push(i, "attack", s, num(a[0]) > 0 ? `${who(s)}攻擊力 ${num(a[0])}` : `${who(s)}攻擊取消`);
        return;
      }
      case "diceroll": {
        const d = asCard(a[0]) as DiceRoll | null;
        st.dice = d;
        push(
          i,
          "dice",
          null,
          d === null
            ? "擲骰"
            : `擲骰：攻 ${num(d.atkSuc)} 成功（${(d.atkArr ?? []).length} 顆）、防 ${num(d.defSuc)} 成功（${(d.defArr ?? []).length} 顆）`,
        );
        return;
      }
      case "damage_player":
      case "damage_opponent": {
        const s = name === "damage_player" ? pov : opp;
        push(
          i,
          "damage",
          s,
          `${who(s)}${a[3] === true ? "受到" : "受到直接"} ${num(a[0])} 傷害（${num(a[1])}/${num(a[2])}）`,
        );
        return;
      }
      case "heal_player":
      case "heal_opponent": {
        const s = name === "heal_player" ? pov : opp;
        push(i, "heal", s, `${who(s)}回復 ${num(a[0])}`);
        return;
      }
      case "skill_effect_player":
      case "skill_effect_opponent": {
        const s = name === "skill_effect_player" ? pov : opp;
        push(i, "skill", s, `${who(s)}發動 ${String(a[0])}`);
        return;
      }
      case "log_skill_activate":
        return; // 跟 skill_effect 同一件事，記錄文字用那則
      case "state": {
        const s: Seat | null = a[1] === "A" || a[1] === "B" ? a[1] : null;
        push(i, "state", s, `${s === null ? "" : who(s)}狀態 ${String(a[0])}`);
        return;
      }
      case "change_player":
      case "change_opponent": {
        const s = name === "change_player" ? pov : opp;
        push(i, "change", s, `${who(s)}換角（第 ${num(a[0])} 位）`);
        return;
      }
      case "turn_end":
        st.turn = num(a[0], st.turn);
        st.dice = null;
        st.atkValue = null;
        for (const s of [me(), them()]) {
          s.attack = null;
          s.defense = null;
        }
        push(i, "turn", null, `第 ${st.turn} 回合`);
        return;
      case "bonus":
        push(i, "bonus", null, `骰子加成 ${a.map(String).join("/")}`);
        return;
    }
    if (name === `cardOpen_${opp}` || name === `cardOpen_${pov}`) {
      const s: Seat = name === `cardOpen_${opp}` ? opp : pov;
      const list = Array.isArray(a[0]) ? a[0] : [];
      const labels: string[] = [];
      for (const x of list) {
        const o = asCard(x);
        const c = asCard(o?.card);
        const sl = slotAt(st.sides[s], o?.cardindex);
        if (sl !== null && c !== null) {
          sl.card = c;
          sl.played = true;
        }
        see(c);
        labels.push(cardLabel(c));
      }
      if (list.length > 0) push(i, "reveal", s, `${who(s)}翻開：${labels.join("、")}`);
      return;
    }
    if (name === `cardRob_${pov}`) {
      const list = Array.isArray(a[0]) ? a[0] : [];
      for (const x of list) {
        clear(me(), asCard(x)?.cardindex);
        them().cards.push({ card: null, played: false, rotated: false, src: "rob" });
      }
      push(i, "discard", pov, `我方被搶走 ${list.length} 張牌`);
      return;
    }
    if (name === `cardRob_${opp}`) {
      const list = Array.isArray(a[0]) ? a[0] : [];
      const labels: string[] = [];
      for (const x of list) {
        const o = asCard(x);
        const c = asCard(o?.card);
        clear(them(), o?.cardindex);
        me().cards.push({ card: c, played: false, rotated: false, src: "rob" });
        see(c);
        labels.push(cardLabel(c));
      }
      push(i, "draw", pov, `我方搶到：${labels.join("、")}`);
      return;
    }
    if (/^phaselabel_[AB]$/.test(name)) return;
    if (/^cc\d+_sk/.test(name)) {
      push(i, "skill", null, `技能效果 ${name}`);
      return;
    }
    unknown.add(name);
  });

  function applySilent(name: string, a: unknown[]): void {
    const atk = st.phase === "AttackPhaseA";
    const def = st.phase === "DefensePhaseA";
    if (name === "attack_value") {
      if (atk) me().attack = num(a[0]);
      else if (def) them().attack = num(a[0]);
    } else if (name === "defense_value") {
      if (atk) them().defense = num(a[0]);
      else if (def) me().defense = num(a[0]);
    } else if (name === "turn_refresh") {
      st.turn = num(a[0], st.turn);
    }
  }

  return { pov, opp, meta, steps, unknown: [...unknown].sort(), observed };
}

function activeLabel(slot: HandSlot): string {
  const h = activeHalf(slot);
  return h === null ? cardLabel(slot.card) : `${KIND_NAMES[h.suit]}${h.value}`;
}
