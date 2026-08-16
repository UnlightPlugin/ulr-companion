/**
 * 配對佇列
 *
 * v1 要守住的是「規則不同的人配不到一起」，而且靠的是他們算出不同的配對鍵。
 * **v2 起那條規則刻意放寬了**：同一套規則的不同版本會排在同一條佇列，能不能
 * 開打改由配對成立之後的語義驗算決定。所以這裡要釘的變成兩件事：
 *
 *   1. **不同規則**（不同 ruleSetId／頻道／上限）仍然物理上碰不到
 *   2. 驗算沒過的那一對**不會被立刻重新湊起來**（那是個無窮迴圈）
 */

import { describe, expect, it } from "vitest";
import {
  decodeQueue,
  decodeQueueServer,
  firstPairing,
  matchCriteriaString,
  matchKey,
  MatchQueue,
  MATCH_KEY_LENGTH,
  MATCH_TOKEN_ALPHABET,
  MATCH_TOKEN_LENGTH,
  MAX_RELAY_BODY_LENGTH,
  defaultTokenSource,
  ruleTag,
} from "@ulr/arbiter-link/match-queue";
import type { MatchCriteria, QueueOutgoing, Waiter } from "@ulr/arbiter-link/match-queue";
import { LINK_PROTOCOL_VERSION } from "@ulr/arbiter-link/protocol";

const base: MatchCriteria = {
  ruleSetId: "lampking/arcadia-balance",
  channel: 2,
  multi: true,
  costLimit: 62,
};

/** 確定性的 token，測試才好斷言。 */
let seq = 0;
const fakeToken = () => `TOK${String(++seq).padStart(5, "0")}`;
const queue = () => {
  seq = 0;
  return new MatchQueue(fakeToken);
};

const hello = { t: "q-hello", v: LINK_PROTOCOL_VERSION, key: "x", tag: "same" } as const;
/** 另一個規則版本的人（標籤不同，但仍然排在同一條佇列上）。 */
const helloV2 = { t: "q-hello", v: LINK_PROTOCOL_VERSION, key: "x", tag: "other" } as const;
const to = (out: readonly QueueOutgoing[], id: string) =>
  out.filter((o) => o.to === id).map((o) => o.message);

describe("配對鍵", () => {
  it("同樣條件 → 同樣的鍵", () => {
    expect(matchKey(base)).toBe(matchKey({ ...base }));
  });

  it.each([
    ["規則族", { ruleSetId: "lampking/other" }],
    ["頻道", { channel: 1 }],
    ["3vs3", { multi: false }],
    ["COST 上限", { costLimit: 57 }],
  ])("%s 不一樣 → 鍵不一樣（配不到對方）", (_label, patch) => {
    expect(matchKey({ ...base, ...patch })).not.toBe(matchKey(base));
  });

  it("不設限與設 0 是不同的條件", () => {
    expect(matchKey({ ...base, costLimit: null })).not.toBe(matchKey({ ...base, costLimit: 0 }));
  });

  it("62 與 62.00 是同一個條件 —— 小數表示法不該影響配對", () => {
    expect(matchKey({ ...base, costLimit: 62 })).toBe(matchKey({ ...base, costLimit: 62.0 }));
  });

  it("長度固定，且是十六進位（跟房號共用路由驗證）", () => {
    const k = matchKey(base);
    expect(k).toHaveLength(MATCH_KEY_LENGTH);
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  it("⚠ v2：版本前綴換掉了，舊版插件算出來的鍵不會跟新版撞在一起", () => {
    expect(matchCriteriaString(base)).toContain("ulr-match-v2");
  });

  it("⚠ 同一套規則的不同版本落在同一條佇列 —— 這正是 v2 要的", () => {
    // 兩個人的 contentHash 不同，但 ruleSetId 一樣 → 同一個鍵 → 配得到。
    expect(matchKey(base)).toBe(matchKey({ ...base }));
    expect(ruleTag(matchKey(base), "sha256:aaaa")).not.toBe(ruleTag(matchKey(base), "sha256:bbbb"));
  });
});

describe("規則標籤", () => {
  it("同一份規則、同一條佇列 → 同一個標籤（快路靠它）", () => {
    expect(ruleTag("key1", "sha256:abcd")).toBe(ruleTag("key1", "abcd"));
  });

  it("⚠ 換一條佇列就是另一個標籤 —— 中間人串不起兩場對局", () => {
    expect(ruleTag("key1", "abcd")).not.toBe(ruleTag("key2", "abcd"));
  });

  it("⚠ 標籤裡看不到規則的 hash", () => {
    expect(ruleTag("key1", "abcd")).not.toContain("abcd");
  });
});

describe("湊對", () => {
  it("一個人進來只會收到 welcome，不會被配對", () => {
    const q = queue();
    const out = q.join("a", hello);
    expect(out).toEqual([
      { to: "a", message: { t: "q-welcome", v: LINK_PROTOCOL_VERSION, waiting: 1 } },
    ]);
    expect(q.waiting).toBe(1);
  });

  it("第二個人進來就湊成一對，先到的當 host", () => {
    const q = queue();
    q.join("a", hello);
    const out = q.join("b", hello);

    expect(to(out, "a")).toEqual([
      { t: "q-matched", role: "host", token: "TOK00001", peerTag: "same" },
    ]);
    expect(to(out, "b")).toContainEqual({
      t: "q-matched",
      role: "guest",
      token: "TOK00001",
      peerTag: "same",
    });
    expect(q.waiting).toBe(0);
  });

  it("⚠ 規則版本不同的人也照配 —— 相不相容是插件驗算的事", () => {
    const q = queue();
    q.join("a", hello);
    const out = q.join("b", helloV2);

    // 對手的標籤要原封轉過去，插件靠它決定要不要走整段牌組交換。
    expect(to(out, "a")).toContainEqual({
      t: "q-matched",
      role: "host",
      token: "TOK00001",
      peerTag: "other",
    });
    expect(to(out, "b")).toContainEqual({
      t: "q-matched",
      role: "guest",
      token: "TOK00001",
      peerTag: "same",
    });
  });

  it("兩邊拿到的 token 一樣 —— 那同時是房間密碼", () => {
    const q = queue();
    q.join("a", hello);
    const out = q.join("b", hello);
    const ma = to(out, "a").find((m) => m.t === "q-matched") as { token: string };
    const mb = to(out, "b").find((m) => m.t === "q-matched") as { token: string };
    expect(ma.token).toBe(mb.token);
  });

  it("四個人一次湊兩對，不會讓後兩個乾等", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    q.join("c", hello);
    const out = q.join("d", hello);
    expect(to(out, "c")).toContainEqual({
      t: "q-matched",
      role: "host",
      token: "TOK00002",
      peerTag: "same",
    });
    expect(to(out, "d")).toContainEqual({
      t: "q-matched",
      role: "guest",
      token: "TOK00002",
      peerTag: "same",
    });
    expect(q.waiting).toBe(0);
  });
});

describe("轉發牌組與指紋", () => {
  it.each(["q-deck", "q-eval", "q-pref"] as const)("%s 原封不動轉給對手，內容不被解讀", (t) => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    const body = '{"v":1,"characters":["cc001_04"]}';
    expect(q.handle("a", { t, body })).toEqual([{ to: "b", message: { t, body } }]);
  });

  it("⚠ 還沒配到人就送 → 沒有對手可轉，直接丟掉", () => {
    const q = queue();
    q.join("a", hello);
    expect(q.handle("a", { t: "q-deck", body: "x" })).toEqual([]);
  });

  it("⚠ 只會轉給自己的對手，不會廣播給佇列上的其他人", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello); // a/b 配成一對
    q.join("c", hello); // c 還在等
    const out = q.handle("a", { t: "q-deck", body: "x" });
    expect(out.map((o) => o.to)).toEqual(["b"]);
  });

  it("body 太長就整則不收 —— 中間人的訊息上限只有 2 KB", () => {
    const long = "x".repeat(MAX_RELAY_BODY_LENGTH + 1);
    expect(decodeQueue(JSON.stringify({ t: "q-deck", body: long }))).toBeNull();
    expect(decodeQueue(JSON.stringify({ t: "q-deck", body: "x" }))).toEqual({
      t: "q-deck",
      body: "x",
    });
  });

  /**
   * ⚠ `q-pref`（開房偏好）跟另外兩則走**完全一樣**的路：不解讀、只轉給對手、
   * 同一個長度上限。中間人多認得一個欄位就是多一個要跟著發版的理由，而它是
   * 所有人共用的那一台。
   */
  it("q-pref 兩個方向都解析得出來，長度上限一樣", () => {
    const body = JSON.stringify({ s: "014" });
    expect(decodeQueue(JSON.stringify({ t: "q-pref", body }))).toEqual({ t: "q-pref", body });
    expect(decodeQueueServer(JSON.stringify({ t: "q-pref", body }))).toEqual({ t: "q-pref", body });
    const long = "x".repeat(MAX_RELAY_BODY_LENGTH + 1);
    expect(decodeQueue(JSON.stringify({ t: "q-pref", body: long }))).toBeNull();
  });
});

describe("驗算沒過（q-reject）", () => {
  it("兩邊都收到 q-dropped，而且都留在佇列裡", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", helloV2);
    const out = q.handle("a", { t: "q-reject" });

    expect(to(out, "a")).toContainEqual({ t: "q-dropped", reason: "rejected" });
    expect(to(out, "b")).toContainEqual({ t: "q-dropped", reason: "rejected" });
    expect(q.waiting).toBe(2);
  });

  it("⚠⚠ 同一對不會被立刻重新湊起來（否則是無窮迴圈）", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", helloV2);
    const out = q.handle("a", { t: "q-reject" });

    // 兩個人都還在排，但誰都沒有再收到 q-matched
    expect(out.filter((o) => o.message.t === "q-matched")).toEqual([]);
    expect(q.waiterOf("a")?.partner).toBeNull();
    expect(q.waiterOf("b")?.partner).toBeNull();
  });

  it("第三個人進來時，被拒的兩位仍配得到他", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", helloV2);
    q.handle("a", { t: "q-reject" });
    const out = q.join("c", hello);

    // a 排在最前面，所以是 a 跟 c 配 —— b 繼續等下一位
    expect(to(out, "a")).toContainEqual({
      t: "q-matched",
      role: "host",
      token: "TOK00002",
      peerTag: "same",
    });
    expect(to(out, "c").some((m) => m.t === "q-matched")).toBe(true);
    expect(q.waiterOf("b")?.partner).toBeNull();
  });

  it("⚠ 重送 q-hello（重連）不會把「試過了」洗掉", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", helloV2);
    q.handle("a", { t: "q-reject" });
    const out = q.join("a", hello);
    expect(out.filter((o) => o.message.t === "q-matched")).toEqual([]);
  });

  it("⚠⚠ 配對中的人又送一次 q-hello → 對手要被放回佇列，不能凍在那裡", () => {
    // 我們自己的客戶端不會這樣做（重連會拿到新的 id），但少了這一段，
    // 送兩次 q-hello 就能把別人永遠卡在「已配對」——他不在 free 裡、
    // 也不會再收到任何訊息。
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    const out = q.join("a", hello);

    expect(to(out, "b")).toContainEqual({ t: "q-dropped", reason: "gone" });
    // 兩個人都還在，而且立刻又被湊起來（他們並沒有做錯什麼）
    expect(q.waiterOf("b")?.partner).toBe("a");
    expect(q.waiterOf("a")?.partner).toBe("b");
  });
});

describe("firstPairing", () => {
  const w = (id: string, tried: string[] = []): Waiter => ({
    id,
    partner: null,
    role: null,
    token: null,
    tag: "t",
    tried,
  });

  it("先到先配", () => {
    expect(firstPairing([w("a"), w("b"), w("c")])?.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("⚠ 試過的組合要跳過，而且是往後找 —— 不能只看前兩個", () => {
    // a 跟 b 試過了，但 a 跟 c 沒有
    expect(firstPairing([w("a", ["b"]), w("b"), w("c")])?.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("只有一邊記著也算試過", () => {
    expect(firstPairing([w("a"), w("b", ["a"])])).toBeNull();
  });

  it("湊不出來就回 null", () => {
    expect(firstPairing([w("a")])).toBeNull();
    expect(firstPairing([])).toBeNull();
  });
});

describe("轉交 room_id", () => {
  it("host 轉的 roomId 只送給它的對手", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    const out = q.handle("a", { t: "q-room", roomId: "12345" });
    expect(out).toEqual([{ to: "b", message: { t: "q-room", roomId: "12345" } }]);
  });

  it("⚠ guest 轉 roomId 一律忽略", () => {
    // 少了這個檢查，佇列上任何人都能把別人騙進任意房間
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    expect(q.handle("b", { t: "q-room", roomId: "壞的" })).toEqual([]);
  });

  it("⚠ 還沒配對到人就轉 roomId 也一律忽略", () => {
    const q = queue();
    q.join("a", hello);
    expect(q.handle("a", { t: "q-room", roomId: "12345" })).toEqual([]);
  });
});

describe("有人跑掉", () => {
  it("對手取消 → 我收到 q-dropped 並退回排隊", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    const out = q.leave("b", "cancel");

    expect(to(out, "a")).toContainEqual({ t: "q-dropped", reason: "cancel" });
    expect(q.waiterOf("a")?.partner).toBeNull();
    expect(q.waiting).toBe(1);
  });

  it("退回佇列的人排在最前面 —— 他已經等過一輪了", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello);
    q.leave("b"); // a 退回佇列
    // ⚠ 下一個人一進來就會跟 a 配掉，不必等到第四個人
    const out = q.join("c", hello);

    expect(to(out, "a")).toContainEqual({
      t: "q-matched",
      role: "host",
      token: "TOK00002",
      peerTag: "same",
    });
    expect(to(out, "c")).toContainEqual({
      t: "q-matched",
      role: "guest",
      token: "TOK00002",
      peerTag: "same",
    });
  });

  it("排在前面的先配 —— 三個人時最後進來的繼續等", () => {
    const q = queue();
    q.join("a", hello);
    q.join("b", hello); // a/b 配掉
    const out = q.join("c", hello);

    expect(to(out, "c")).toEqual([{ t: "q-welcome", v: LINK_PROTOCOL_VERSION, waiting: 1 }]);
    expect(q.waiterOf("c")?.partner).toBeNull();
  });

  it("斷線的人被清掉，不會佔著位子", () => {
    const q = queue();
    q.join("a", hello);
    q.leave("a");
    expect(q.size).toBe(0);
    expect(q.waiterOf("a")).toBeNull();
  });

  it("沒 join 過的 id 做任何事都不會炸", () => {
    const q = queue();
    expect(q.leave("沒這個人")).toEqual([]);
    expect(q.handle("沒這個人", { t: "q-cancel" })).toEqual([]);
  });
});

describe("協定版本", () => {
  it("版本不合 → 回 incompatible，而且不進佇列", () => {
    const q = queue();
    const out = q.join("a", {
      t: "q-hello",
      v: LINK_PROTOCOL_VERSION + 99,
      key: "x",
      tag: "same",
    });
    expect(out[0]?.message.t).toBe("q-incompatible");
    expect(q.size).toBe(0);
  });
});

describe("解析", () => {
  it("⚠ 中間人不認得 q-matched —— 那則會決定誰開房", () => {
    const raw = JSON.stringify({ t: "q-matched", role: "host", token: "x", peerTag: "y" });
    expect(decodeQueue(raw)).toBeNull();
    expect(decodeQueueServer(raw)).not.toBeNull();
  });

  it("⚠ 插件不認得 q-hello —— 兩支方向相反", () => {
    expect(decodeQueueServer(JSON.stringify(hello))).toBeNull();
    expect(decodeQueue(JSON.stringify(hello))).toEqual(hello);
  });

  it("q-matched 少了任何一個欄位就整則不收", () => {
    for (const bad of [
      { t: "q-matched", role: "spectator", token: "x", peerTag: "y" },
      { t: "q-matched", role: "host", token: "", peerTag: "y" },
      { t: "q-matched", role: "host", token: "x" },
    ]) {
      expect(decodeQueueServer(JSON.stringify(bad))).toBeNull();
    }
  });

  it("壞掉的 JSON 一律 null，不拋例外", () => {
    expect(decodeQueue("{{{")).toBeNull();
    expect(decodeQueueServer("{{{")).toBeNull();
    expect(decodeQueueServer("null")).toBeNull();
  });
});

describe("token", () => {
  it("長度與字元集跟遊戲自己的密碼一致", () => {
    const t = defaultTokenSource();
    expect(t).toHaveLength(MATCH_TOKEN_LENGTH);
    for (const ch of t) expect(MATCH_TOKEN_ALPHABET).toContain(ch);
  });

  it("⚠ 不是 Math.random —— 這個字串就是房間密碼", () => {
    // 連續取樣不該重複。真正的保證在 crypto.getRandomValues，這裡只是煙霧測試。
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(defaultTokenSource());
    expect(seen.size).toBe(200);
  });
});
