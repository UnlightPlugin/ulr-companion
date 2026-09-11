import { describe, expect, it } from "vitest";
import { deckContentCanonical, deckContentHash, deckEntryHash } from "../src/hash.js";
import { isSyncNeeded, planSync, summarize } from "../src/sync.js";
import type { DeckStamp, LibrarySummary } from "../src/sync.js";
import {
  addDeck,
  moveDeck,
  removeDeck,
  renameDeck,
  setDeckBosses,
  updateDeckContent,
} from "../src/library.js";
import { emptyDeckContent, emptyLibrary } from "../src/types.js";
import type { DeckLibrary, Tombstone } from "../src/types.js";

function deckWith(charaIndex: number): ReturnType<typeof emptyDeckContent> {
  const c = emptyDeckContent();
  c.chara[0] = "cc069";
  c.charaIndex[0] = charaIndex;
  return c;
}

describe("hash", () => {
  it("同樣的內容算出同樣的 hash", () => {
    expect(deckContentHash(deckWith(684))).toBe(deckContentHash(deckWith(684)));
  });

  it("內容不同就不同", () => {
    expect(deckContentHash(deckWith(684))).not.toBe(deckContentHash(deckWith(685)));
  });

  it("null 與 undefined 的空格算成同一個 —— 存檔往返不該算成有變動", () => {
    const a = emptyDeckContent();
    const b = emptyDeckContent();
    b.charaIndex[1] = undefined as unknown as null;
    expect(deckContentCanonical(a)).toBe(deckContentCanonical(b));
  });

  it("同步用的 hash 要把名字算進去 —— 不然只改名的話另一端永遠拉不到", () => {
    const content = deckWith(684);
    expect(deckEntryHash({ name: "壓 C 用", content, bosses: [] })).not.toBe(
      deckEntryHash({ name: "改了名字", content, bosses: [] }),
    );
  });

  it("渦 BOSS 標籤也要算進去 —— 只改標籤也是改過（規格 §12）", () => {
    const content = deckWith(684);
    expect(deckEntryHash({ name: "甲", content, bosses: [] })).not.toBe(
      deckEntryHash({ name: "甲", content, bosses: ["fish"] }),
    );
    expect(deckEntryHash({ name: "甲", content, bosses: ["sea", "fish"] })).not.toBe(
      deckEntryHash({ name: "甲", content, bosses: ["sea"] }),
    );
  });

  it("updatedAt 不算進 hash —— 算進去的話增量同步會退化成每次全拉", () => {
    const h = deckEntryHash({ name: "甲", content: deckWith(684), bosses: [] });
    expect(deckEntryHash({ name: "甲", content: deckWith(684), bosses: [] })).toBe(h);
  });

  it("格式跟規則 hash 對齊：sha256: 前綴", () => {
    expect(deckContentHash(deckWith(684))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("planSync", () => {
  const T1 = "2026-08-24T10:00:00.000Z";
  const T2 = "2026-08-24T11:00:00.000Z";

  function sum(decks: DeckStamp[] = [], graves: Tombstone[] = []): LibrarySummary {
    return {
      account: "4858c81f",
      rooms: { raid: [], alexandria: [], quest: [], dietherm: decks },
      tombstones: { raid: [], alexandria: [], quest: [], dietherm: graves },
    };
  }
  const ref = { room: "dietherm" as const, id: "a" };

  it("兩邊一樣就什麼都不做", () => {
    const s = sum([{ id: "a", hash: "sha256:aa", updatedAt: T1 }]);
    expect(isSyncNeeded(planSync(s, s))).toBe(false);
  });

  it("本地新增的要推上去", () => {
    expect(planSync(sum([{ id: "a", hash: "sha256:aa", updatedAt: T1 }]), sum()).push).toEqual([
      ref,
    ]);
  });

  it("雲端有而本地沒有的要拉下來", () => {
    expect(planSync(sum(), sum([{ id: "a", hash: "sha256:aa", updatedAt: T1 }])).pull).toEqual([
      ref,
    ]);
  });

  it("內容不同時比 updatedAt，新的贏", () => {
    const older = { id: "a", hash: "sha256:old", updatedAt: T1 };
    const newer = { id: "a", hash: "sha256:new", updatedAt: T2 };
    expect(planSync(sum([older]), sum([newer])).pull).toEqual([ref]);
    expect(planSync(sum([newer]), sum([older])).push).toEqual([ref]);
  });

  it("時間戳平手但內容不同 = 衝突，本地優先但要列出來", () => {
    const plan = planSync(
      sum([{ id: "a", hash: "sha256:l", updatedAt: T1 }]),
      sum([{ id: "a", hash: "sha256:r", updatedAt: T1 }]),
    );
    expect(plan.conflicts).toEqual([ref]);
    expect(plan.push).toEqual([ref]);
  });

  it("只有順序不同時標記 reorder，不會誤判成內容有變", () => {
    const a = { id: "a", hash: "sha256:aa", updatedAt: T1 };
    const b = { id: "b", hash: "sha256:bb", updatedAt: T1 };
    const plan = planSync(sum([a, b]), sum([b, a]));
    expect(plan.reorder).toEqual(["dietherm"]);
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual([]);
    expect(isSyncNeeded(plan)).toBe(true);
  });
});

describe("刪除同步（墓碑）", () => {
  const EARLY = "2026-08-24T10:00:00.000Z";
  const LATE = "2026-08-24T11:00:00.000Z";

  function sum(decks: DeckStamp[] = [], graves: Tombstone[] = []): LibrarySummary {
    return {
      account: "4858c81f",
      rooms: { raid: [], alexandria: [], quest: [], dietherm: decks },
      tombstones: { raid: [], alexandria: [], quest: [], dietherm: graves },
    };
  }
  const ref = { room: "dietherm" as const, id: "a" };
  const deck = (at: string): DeckStamp => ({ id: "a", hash: "sha256:aa", updatedAt: at });
  const grave = (at: string): Tombstone => ({ id: "a", deletedAt: at });

  it("遠端刪掉的，本地要跟著刪 —— 不是把它推回去", () => {
    const plan = planSync(sum([deck(EARLY)]), sum([], [grave(LATE)]));
    expect(plan.deleteLocal).toEqual([ref]);
    expect(plan.push).toEqual([]);
  });

  it("本地刪掉的，雲端要跟著刪", () => {
    const plan = planSync(sum([], [grave(LATE)]), sum([deck(EARLY)]));
    expect(plan.deleteRemote).toEqual([ref]);
    expect(plan.pull).toEqual([]);
  });

  it("刪除之後又編輯過的話，編輯贏 —— 牌組復活", () => {
    const plan = planSync(sum([deck(LATE)]), sum([], [grave(EARLY)]));
    expect(plan.push).toEqual([ref]);
    expect(plan.deleteLocal).toEqual([]);
  });

  it("對稱：遠端在本地刪除之後才編輯的，拉下來復活", () => {
    const plan = planSync(sum([], [grave(EARLY)]), sum([deck(LATE)]));
    expect(plan.pull).toEqual([ref]);
    expect(plan.deleteRemote).toEqual([]);
  });

  it("編輯與刪除同一時刻 —— 刪除優先，但列進衝突", () => {
    const plan = planSync(sum([deck(EARLY)]), sum([], [grave(EARLY)]));
    expect(plan.deleteLocal).toEqual([ref]);
    expect(plan.conflicts).toEqual([ref]);
  });

  it("兩邊都刪了就什麼都不用做", () => {
    const plan = planSync(sum([], [grave(EARLY)]), sum([], [grave(LATE)]));
    expect(isSyncNeeded(plan)).toBe(false);
  });

  it("沒有墓碑的話刪除會被推回來 —— 這正是墓碑要解決的事", () => {
    // 本地刪了但「忘了」留墓碑：對遠端來說看起來就像本地沒有這副
    const plan = planSync(sum(), sum([deck(EARLY)]));
    expect(plan.pull).toEqual([ref]); // 牌組復活
    // 有墓碑就不會
    const withGrave = planSync(sum([], [grave(LATE)]), sum([deck(EARLY)]));
    expect(withGrave.pull).toEqual([]);
    expect(withGrave.deleteRemote).toEqual([ref]);
  });
});

describe("summarize 與真實的編輯流程", () => {
  function seeded(): { lib: DeckLibrary; id: string } {
    const r = addDeck(emptyLibrary("4858c81f"), "dietherm", {
      name: "壓 C 用",
      content: deckWith(684),
      now: new Date("2026-08-24T10:00:00Z"),
    });
    return { lib: r.library, id: r.entry.id };
  }

  it("改了內容之後，摘要比出那一副要推上去", () => {
    const { lib, id } = seeded();
    const remote = summarize(lib);
    const edited = updateDeckContent(
      lib,
      "dietherm",
      id,
      deckWith(685),
      new Date("2026-08-24T11:00:00Z"),
    );
    expect(planSync(summarize(edited), remote).push).toEqual([{ room: "dietherm", id }]);
  });

  it("只改名字也要推上去", () => {
    const { lib, id } = seeded();
    const remote = summarize(lib);
    const renamed = renameDeck(lib, "dietherm", id, "新名字", new Date("2026-08-24T11:00:00Z"));
    expect(planSync(summarize(renamed), remote).push).toEqual([{ room: "dietherm", id }]);
  });

  it("只改渦標籤也要推上去", () => {
    const r = addDeck(emptyLibrary("4858c81f"), "raid", {
      name: "渦用",
      content: deckWith(684),
      now: new Date("2026-08-24T10:00:00Z"),
    });
    const remote = summarize(r.library);
    const tagged = setDeckBosses(
      r.library,
      "raid",
      r.entry.id,
      ["fish"],
      new Date("2026-08-24T11:00:00Z"),
    );
    expect(planSync(summarize(tagged), remote).push).toEqual([{ room: "raid", id: r.entry.id }]);
  });

  it("刪掉一副之後，摘要比出雲端也要刪", () => {
    const { lib, id } = seeded();
    const remote = summarize(lib);
    const deleted = removeDeck(lib, "dietherm", id, new Date("2026-08-24T11:00:00Z"));
    const plan = planSync(summarize(deleted), remote);
    expect(plan.deleteRemote).toEqual([{ room: "dietherm", id }]);
    expect(plan.pull).toEqual([]);
  });

  it("拖曳排序之後只會標 reorder，不會把每一副都當成改過", () => {
    let lib = emptyLibrary("4858c81f");
    const now = new Date("2026-08-24T10:00:00Z");
    const a = addDeck(lib, "dietherm", { name: "甲", content: deckWith(684), now });
    lib = a.library;
    const b = addDeck(lib, "dietherm", { name: "乙", content: deckWith(685), now });
    lib = b.library;

    const remote = summarize(lib);
    const plan = planSync(summarize(moveDeck(lib, "dietherm", a.entry.id, 1)), remote);

    expect(plan.reorder).toEqual(["dietherm"]);
    expect(plan.push).toEqual([]);
    expect(plan.pull).toEqual([]);
  });
});
