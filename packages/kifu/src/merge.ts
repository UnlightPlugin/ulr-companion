/**
 * 雙視角合併：同一場兩個座位各錄一份，把對方蓋著的牌補上牌面
 * ===========================================================
 * 兩份牌譜靠 `meta.roomHash`（房號 SHA-256 前 16 hex，兩個客戶端算出來一樣）認出是同一場，
 * 座位一個 A 一個 B。
 *
 * **索引怎麼對**：官方客戶端的 `opponent_card` 跟對方客戶端的 `player_card` 是同一串伺服器事件
 * 依序 push 出來的（抽牌、事件卡、回到手上、搶牌），所以「我這邊對手的第 i 張」就是「對方那邊
 * 自己的第 i 張」。合併前先檢查：兩邊都看得到牌面的那幾張（對手翻開過的）必須一致，
 * 有一張對不上就不合併（`ok: false`）—— 對錯牌比不補糟。
 *
 * 只在戰鬥結束後用（播放、上傳都在打完之後）。合併出來的牌標 `peek: true`，畫面上跟
 * 「當時就看得到的」分開畫。
 */

import { cardLabel, type HandSlot, type KifuCard, type Replay } from "./replay.js";

export interface MergeResult {
  ok: boolean;
  /** 對不上的原因（`ok: false` 時） */
  reason: string | null;
  /** 補上牌面的張數 */
  filled: number;
  replay: Replay;
}

/** 合併後的手牌格多一個標記：這張是從對方的牌譜補來的（當時看不到） */
export interface PeekSlot extends HandSlot {
  peek?: boolean;
}

function sameCard(a: KifuCard, b: KifuCard): boolean {
  return cardLabel(a) === cardLabel(b) && a.index === b.index && a.type === b.type;
}

/** 對方視角裡「自己的第 i 張」最後是哪張牌（同一格的牌面整場不變，除了 actioncard_changed）。 */
function ownCards(r: Replay): Map<number, KifuCard> {
  const out = new Map<number, KifuCard>();
  for (const s of r.steps) {
    s.state.sides[r.pov].cards.forEach((slot, i) => {
      if (slot?.card && !out.has(i)) out.set(i, slot.card);
    });
  }
  return out;
}

export function mergePerspectives(primary: Replay, other: Replay): MergeResult {
  const fail = (reason: string): MergeResult => ({ ok: false, reason, filled: 0, replay: primary });
  const a = primary.meta;
  const b = other.meta;
  if (a.roomHash === null || a.roomHash !== b.roomHash) return fail("不是同一場（房號雜湊不同）");
  if (primary.pov === other.pov) return fail("兩份是同一個座位");
  const theirs = ownCards(other);

  // 先驗：我這邊看過牌面的對手牌，必須跟對方自己的那張一樣
  for (const s of primary.steps) {
    const slots = s.state.sides[primary.opp].cards;
    for (let i = 0; i < slots.length; i++) {
      const c = slots[i]?.card;
      if (!c) continue;
      const t = theirs.get(i);
      if (t === undefined) return fail(`對手第 ${i} 張：對方的牌譜裡沒有這張`);
      if (!sameCard(c, t))
        return fail(`對手第 ${i} 張對不上：我看到 ${cardLabel(c)}、對方是 ${cardLabel(t)}`);
    }
  }

  let filled = 0;
  const seen = new Set<number>();
  const steps = primary.steps.map((s) => {
    const st = structuredClone(s.state);
    st.sides[primary.opp].cards = st.sides[primary.opp].cards.map((slot, i) => {
      if (slot === null || slot.card !== null) return slot;
      const t = theirs.get(i);
      if (t === undefined) return slot;
      if (!seen.has(i)) {
        seen.add(i);
        filled++;
      }
      const p: PeekSlot = { ...slot, card: t, peek: true };
      return p;
    });
    return { ...s, state: st };
  });
  return { ok: true, reason: null, filled, replay: { ...primary, steps } };
}
