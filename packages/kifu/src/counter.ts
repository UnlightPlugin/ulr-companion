/**
 * 記牌：公牌還剩哪些
 * ==================
 * 每個地點一疊固定的公牌（`public-decks.ts`），每張牌帶 index。整疊減掉「看過的」
 * （自己抽到的、雙方翻開的、被破壞時亮出來的）就是**還沒看過的牌**：它們不是還在牌堆裡，
 * 就是在對手手上蓋著。所以這裡同時給牌堆剩幾張、對手手上蓋著幾張 —— 機率由這兩個數字
 * 與池子的組成決定，不替玩家下結論。
 *
 * 只用畫面上看得到的東西：自己的牌、翻開的牌、張數。對手蓋著的牌從頭到尾不知道是什麼。
 *
 * 洗牌（`add_actioncards` 第二次以後）時，伺服器把棄牌堆洗回去：看過的清空，只剩**雙方手上
 * 看得到的牌**還算在外面（`buildReplay` 已經照這個重算 `seenIndex`）。
 *
 * ⚠ 改版可能換掉某地點的牌。表跟實際抽到的牌（index 一樣、牌面不一樣）對不上時，`tableOk`
 * 是 false，呼叫端應該不顯示 —— 錯的記牌比沒有記牌糟。
 */

import { PUBLIC_DECKS, type PublicCard } from "./public-decks.js";
import { cardHalf, type KifuCard, type Suit } from "./replay.js";

export const SUIT_ORDER: readonly Suit[] = ["swd", "gun", "shi", "mov", "spe"];

export interface SuitCount {
  /** 有這個種類（上半或下半）的牌張數 */
  cards: number;
  /** 這些牌在這個種類上的數字加總（兩半都是同種類取大的） */
  total: number;
}

export interface DeckCount {
  stage: string;
  name: string;
  /** 表跟實際抽到的牌對得上 */
  tableOk: boolean;
  /** 對不上的 index（`7: 表上 劍1/槍1，實際 劍2/防2`） */
  mismatch: string[];
  /** 整疊張數 */
  size: number;
  /** 沒看過的牌（index＋牌面） */
  unseen: { index: number; card: PublicCard }[];
  bySuit: Record<Suit, SuitCount>;
  /** 牌堆剩幾張（伺服器的數字） */
  deckLeft: number;
  /** 對手手上蓋著幾張（沒看過的牌裡有這麼多張在對手手上） */
  opponentHidden: number;
}

/** 這個地點有沒有公牌表（隨機地圖 999 開房時，戰鬥裡的 stage 是實際地點）。 */
export function hasPublicDeck(stage: string | null): boolean {
  return stage !== null && PUBLIC_DECKS[stage] !== undefined;
}

function same(table: PublicCard, card: KifuCard): boolean {
  const a = cardHalf(card, 1);
  const b = cardHalf(card, 2);
  return (
    a !== null &&
    b !== null &&
    a.suit === table[0] &&
    a.value === table[1] &&
    b.suit === table[2] &&
    b.value === table[3]
  );
}

function label(c: PublicCard): string {
  const n: Record<string, string> = { swd: "劍", gun: "槍", shi: "防", mov: "移", spe: "特" };
  return `${n[c[0]] ?? c[0]}${c[1]}/${n[c[2]] ?? c[2]}${c[3]}`;
}

/**
 * @param observed 這場看過的所有行動卡（拿來比對表；同一個 index 出現多次沒關係）
 * @param seenIndex 目前這一疊（最後一次洗牌之後）看過的 index
 */
export function countDeck(
  stage: string,
  observed: readonly KifuCard[],
  seenIndex: readonly number[],
  deckLeft: number,
  opponentHidden: number,
): DeckCount | null {
  const deck = PUBLIC_DECKS[stage];
  if (deck === undefined) return null;
  const mismatch: string[] = [];
  const checked = new Set<number>();
  for (const c of observed) {
    if (c.type !== "ac" || typeof c.index !== "number" || checked.has(c.index)) continue;
    checked.add(c.index);
    const t = deck.cards[c.index];
    if (t === undefined) mismatch.push(`${c.index}: 表上沒有這張`);
    else if (!same(t, c)) {
      const a = cardHalf(c, 1);
      const b = cardHalf(c, 2);
      mismatch.push(
        `${c.index}: 表上 ${label(t)}，實際 ${a?.suit}${a?.value}/${b?.suit}${b?.value}`,
      );
    }
  }
  const seen = new Set(seenIndex);
  const unseen = deck.cards.flatMap((card, index) => (seen.has(index) ? [] : [{ index, card }]));
  const bySuit = Object.fromEntries(SUIT_ORDER.map((s) => [s, { cards: 0, total: 0 }])) as Record<
    Suit,
    SuitCount
  >;
  for (const { card } of unseen) {
    for (const s of SUIT_ORDER) {
      const v = Math.max(card[0] === s ? card[1] : 0, card[2] === s ? card[3] : 0);
      if (v > 0) {
        bySuit[s].cards++;
        bySuit[s].total += v;
      }
    }
  }
  return {
    stage,
    name: deck.name,
    tableOk: mismatch.length === 0,
    mismatch,
    size: deck.cards.length,
    unseen,
    bySuit,
    deckLeft,
    opponentHidden,
  };
}

/** 對手手上（含出在場上還沒翻開的）蓋著、而且是從公牌抽的張數。事件卡不算。 */
export function hiddenDeckCards(side: {
  cards: readonly ({ card: unknown; src: string } | null)[];
}): number {
  return side.cards.filter((c) => c !== null && c.card === null && c.src === "deck").length;
}
