import { describe, expect, it } from "vitest";
import type { DeckContent } from "@ulr/deck-library";
import { emptyDeckContent } from "@ulr/deck-library";
import { DeckSeen, splitEnabled, worldOf } from "../src/deck-seen.js";

function deckOf(first: number): DeckContent {
  const c = emptyDeckContent();
  c.charaId[0] = first;
  return c;
}

describe("讀到的那一份屬於哪個世界", () => {
  it("Edit 與房間場景讀的都是客戶端記憶體", () => {
    expect(worldOf("edit")).toBe("client");
    expect(worldOf("room")).toBe("client");
    expect(worldOf("server")).toBe("server");
  });
});

describe("兩份基準", () => {
  it("記進客戶端不會動到伺服器那一份", () => {
    const seen = new DeckSeen(true);
    seen.remember("both", deckOf(684));
    seen.remember("client", deckOf(115));
    expect(seen.forSource("edit")).toEqual(deckOf(115));
    expect(seen.forSource("server")).toEqual(deckOf(684));
  });

  it("兩個世界都還沒觀察過就是 null —— autoSave 拿到 null 一律不存", () => {
    const seen = new DeckSeen(true);
    expect(seen.forSource("server")).toBeNull();
    seen.remember("client", deckOf(684));
    expect(seen.forSource("server")).toBeNull();
  });

  it("latest 不分世界，永遠是最後讀到的那一份", () => {
    const seen = new DeckSeen(true);
    seen.remember("server", deckOf(684));
    seen.remember("client", deckOf(115));
    expect(seen.latest).toEqual(deckOf(115));
  });

  it("reset 兩份一起丟 —— 換帳號後留著上一個人的是災難", () => {
    const seen = new DeckSeen(true);
    seen.remember("both", deckOf(684));
    seen.reset();
    expect(seen.forSource("edit")).toBeNull();
    expect(seen.forSource("server")).toBeNull();
    expect(seen.latest).toBeNull();
  });

  /**
   * 2026-09-20 實機那一條的**基準這一半**：從渦房走到對戰房，點下迪城頻道之後
   * 頁面把客戶端換成迪城那副，而伺服器上還躺著渦那副。這三秒內讀到伺服器時，
   * 基準必須是**伺服器自己的上一份**（渦那副）—— 一模一樣，所以沒有編輯要存。
   */
  it("⚠ 換房那幾秒讀到伺服器：跟伺服器自己的上一份比，看起來沒變", () => {
    const raid = deckOf(684);
    const dietherm = deckOf(115);
    const seen = new DeckSeen(true);

    seen.remember("both", raid); // 人在渦房，兩邊都是渦那副
    seen.remember("client", dietherm); // 點迪城頻道：只有客戶端被換掉

    expect(seen.forSource("server")).toEqual(raid); // ← 沒變，不會被判成編輯
    expect(seen.forSource("room")).toEqual(dietherm);
  });

  it("退回開關關掉時退化成一份共用基準（＝ 2026-09-20 之前的行為）", () => {
    const raid = deckOf(684);
    const dietherm = deckOf(115);
    const seen = new DeckSeen(false);

    seen.remember("both", raid);
    seen.remember("client", dietherm);

    // 舊制：讀伺服器時拿到的是客戶端那一份 → 判成「玩家改了牌」→ 覆蓋
    expect(seen.forSource("server")).toEqual(dietherm);
  });
});

describe("退回開關", () => {
  it("預設是開的（兩份基準）", () => {
    expect(splitEnabled({})).toBe(true);
    expect(new DeckSeen().split).toBe(true);
  });

  it("ULR_DECK_SEEN_SPLIT=0 才關掉", () => {
    expect(splitEnabled({ ULR_DECK_SEEN_SPLIT: "0" })).toBe(false);
    expect(splitEnabled({ ULR_DECK_SEEN_SPLIT: "1" })).toBe(true);
  });
});
