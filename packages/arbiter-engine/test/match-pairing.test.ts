/**
 * 配對的判斷（純函式那半邊）
 *
 * `MatchPairing` 本身要一條 WebSocket 與一個活著的遊戲才跑得起來，所以會
 * 改變勝負的判斷全部抽成純函式放在這裡測 —— 那些是「這一場算不算數」的
 * 全部依據。
 */

import { describe, expect, it, vi } from "vitest";
import type { CostRule } from "@ulr/rule-schema";
import { crossVerdict, deckFromKeys, fingerprint } from "@ulr/cost-engine";
import type { CreateRoomOptions, MatchContext, RoomEntry } from "@ulr/cdp-adapter";
import type { MatchQueueClientOptions, QueueStatus } from "@ulr/arbiter-link";
import { ARCADIA_STAGES } from "@ulr/cdp-adapter";
import {
  buildRoomName,
  checkOwnDeck,
  costBand,
  crossEvaluate,
  encodeDeckBody,
  encodeEvalBody,
  encodePrefBody,
  formatCostTag,
  MatchPairing,
  negotiateStage,
  parseDeckBody,
  parseEvalBody,
  parsePrefBody,
  pickArcadiaStage,
  RANDOM_STAGE,
  teamCostCenti,
  tierForTotal,
  type PairingOptions,
  type QueueLink,
  type StagePick,
} from "../src/match-pairing.js";

/** 開房設定，只有抽法會變。 */
const ROOM = (stage: StagePick): PairingOptions["room"] => ({
  stage,
  friend: false,
});
import type { MatchDriver } from "../src/match-session.js";

function rule(over: Partial<CostRule> = {}): CostRule {
  return {
    schemaVersion: 1,
    ruleSetId: "lampking/arcadia-balance",
    version: "1.5.0",
    name: "亞城平衡",
    publisher: { id: "lampking", name: "燈皇" },
    gameVersion: "2026.08",
    teamCostLimit: 0,
    characters: { leon: 22, abel: 17, evarist: 18, newbie: 25 },
    ...over,
  };
}

/** 只給角色的簡寫。這一份的 case 都不在乎裝備與事件卡。 */
const slots = (...characters: string[]) => deckFromKeys({ characters });

/** 22 + 17 + 18 = 57.00 —— 剛好卡滿 57 那一檔的上限。 */
const hostDeck = slots("leon", "abel", "evarist");
const guestDeck = slots("leon", "leon", "abel");

/**
 * 這一組 case 約的是 **COST 57 檔**，而 `hostDeck` 剛好 57.00。
 *
 * ⚠ 換這個數字之前先想清楚：檔位是**有下限的**（56.01～57.00），所以隨便改成
 * 62 的話 `hostDeck` 會變成「太低」，而整組狀態機的 case 會在配到人之前就被
 * 擋下來 —— 症狀是一堆「為什麼 phase 停在 blocked」。
 */
const TIER = 57;

/** 自動配對開出來的房名。⚠ 系統組的，`findOwnRoom` 拿它認自己那間。 */
const ROOM_NAME = buildRoomName(rule().name, TIER);

describe("交換的東西", () => {
  it("描述子送出去再收回來是同一份", () => {
    expect(parseDeckBody(encodeDeckBody(hostDeck))).toEqual(hostDeck);
  });

  it("指紋送出去再收回來是同一份", () => {
    const cross = { host: "sha256:aaa", guest: "sha256:bbb" };
    expect(parseEvalBody(encodeEvalBody(cross))).toEqual(cross);
  });

  it("⚠ 壞掉的一律 null，不拋例外", () => {
    expect(parseDeckBody("{{{")).toBeNull();
    expect(parseEvalBody("{{{")).toBeNull();
    expect(parseDeckBody('{"v":9,"characters":["x"]}')).toBeNull();
  });

  it("⚠⚠ 少了欄位的指紋訊息不算數 —— 那是把「相容」判成 true 的最短路徑", () => {
    // undefined === undefined 會讓一則空訊息通過比對
    expect(parseEvalBody("{}")).toBeNull();
    expect(parseEvalBody('{"h":"x"}')).toBeNull();
    expect(parseEvalBody('{"h":"","g":"y"}')).toBeNull();
  });
});

describe("交叉驗算", () => {
  const v150 = rule({ characters: { ...rule().characters, newbie: 25 } });
  const v151 = rule({ version: "1.5.1", characters: { ...rule().characters, newbie: 26 } });

  it("兩邊的標籤是 host/guest 而不是「我／對手」—— 相對稱呼永遠對不起來", () => {
    // host 端看到的：自己是 host
    const asHost = crossEvaluate(v150, { host: hostDeck, guest: guestDeck });
    // guest 端看到的：自己是 guest，但**標籤跟著角色走**
    const asGuest = crossEvaluate(v151, { host: hostDeck, guest: guestDeck });
    expect(crossVerdict(asHost, asGuest)).toBe("compatible");
  });

  it("有人帶了定價不同的那隻角色 → incompatible", () => {
    const withNew = slots("leon", "abel", "newbie");
    const a = crossEvaluate(v150, { host: hostDeck, guest: withNew });
    const b = crossEvaluate(v151, { host: hostDeck, guest: withNew });
    expect(crossVerdict(a, b)).toBe("incompatible");
  });

  it("⚠ 只驗自己那副會漏掉的情況", () => {
    // 甲的牌兩份規則算起來一樣，乙的牌不一樣 —— 只看自己那副的話兩邊都覺得沒問題
    const withNew = slots("newbie", "abel");
    const a = crossEvaluate(v150, { host: hostDeck, guest: withNew });
    const b = crossEvaluate(v151, { host: hostDeck, guest: withNew });
    expect(a.host).toBe(b.host); // 自己那副：一樣
    expect(crossVerdict(a, b)).toBe("incompatible"); // 但整場不成立
  });
});

/**
 * COST 檔位。
 *
 * ⚠ 這一組釘的是「**檔位有下限**」，而那是整個功能的重點：自動配對要取代
 * 亞歷山卓城的快速比賽，而 `COST57` 在那邊的意思是 56.01～57.00，不是
 * 「57 以下」。沒有下限的話一副 40C 的隊伍會被收進 57 檔，而 40C 打 57C
 * 不是一場比賽 —— 壓 C 這個玩法也就整個消失了。
 */
describe("COST 檔位", () => {
  it("57 檔收的是 56.01～57.00", () => {
    expect(costBand(57)).toEqual({ floor: 5601, cap: 5700 });
    expect(checkOwnDeck(rule(), hostDeck, 57).band).toBe("56.01～57.00");
  });

  it("⚠ 兩檔不重疊 —— 56.00 屬於 56 檔，不是 57 檔", () => {
    const at5600 = rule({ characters: { a: 56 } });
    expect(checkOwnDeck(at5600, slots("a"), 57).under).toBe(true);
    expect(checkOwnDeck(at5600, slots("a"), 56).under).toBe(false);
  });

  it("剛好卡滿上限就過，兩邊都不算出界", () => {
    expect(checkOwnDeck(rule(), hostDeck, 57)).toMatchObject({
      total: "57.00",
      over: false,
      under: false,
    });
  });

  it("超過就擋", () => {
    expect(checkOwnDeck(rule(), hostDeck, 50)).toMatchObject({ over: true, under: false });
  });

  it("⚠⚠ 太低也要擋 —— 57 檔不收 40C 的隊伍", () => {
    expect(checkOwnDeck(rule(), hostDeck, 66)).toMatchObject({ over: false, under: true });
  });

  it("⚠ 浮點尾巴不該讓卡滿的隊伍被判超標", () => {
    // 8.8 + 26.6 + 26.6 用 double 相加是 62.00000000000001
    const r = rule({ characters: { a: 8.8, b: 26.6, c: 26.6 } });
    const d = slots("a", "b", "c");
    expect(checkOwnDeck(r, d, 62)).toMatchObject({ total: "62.00", over: false, under: false });
  });

  it("⚠ 浮點尾巴也不該讓剛好卡在下限的隊伍被判太低", () => {
    // 下限是 61.01，而 62 - 1 在 double 上是 60.99999999999999
    const r = rule({ characters: { a: 20.7, b: 20.7, c: 19.61 } });
    expect(checkOwnDeck(r, slots("a", "b", "c"), 62)).toMatchObject({
      total: "61.01",
      under: false,
    });
  });

  it("不設限就什麼牌組都收", () => {
    expect(checkOwnDeck(rule(), hostDeck, null)).toMatchObject({
      over: false,
      under: false,
      band: null,
    });
    expect(costBand(null)).toBeNull();
  });

  /**
   * ⚠⚠ 2026-08-19 的實機回歸：`checkOwnDeck` 與 `teamCostCenti` **只加了三個
   * 槽位**，武器與事件卡完全沒算進去。
   *
   * 症狀一點都不像少算：玩家帶著遊戲畫面上寫 92C 的牌組按快速比賽，插件算出
   * 84C，於是判成「不在任何一檔裡」，跳出遊戲自己那句「這個牌組不符合遊戲
   * 規則」。差的 8C 就是他那三把武器。
   *
   * 遊戲自己的 `Deck.getCost()` 是三格 + 三把武器 + 18 張事件卡，玩家看的就是
   * 那個數字 —— 我們算的只要跟他看的不一樣，檔位判斷就是一句謊話。
   */
  describe("⚠ 武器與事件卡也要算進總和", () => {
    const geared = rule({
      characters: { a: 20, b: 20, c: 20 },
      equipment: { wp001: 3, wp002: 5 },
      eventCards: { ev001: 2 },
    });
    const deck = deckFromKeys({
      characters: ["a", "b", "c"],
      equipment: ["wp001", "wp002"],
      eventCards: ["ev001"],
    });

    it("checkOwnDeck 的總和含武器與事件卡", () => {
      // 60（三格）+ 3 + 5（武器）+ 2（事件卡）= 70.00
      expect(checkOwnDeck(geared, deck, null).total).toBe("70.00");
    });

    it("teamCostCenti 一樣 —— 兩支要是同一個數字", () => {
      expect(teamCostCenti(geared, deck)).toBe(7000);
    });

    it("⚠ 90+ 那一檔就是這樣被擋掉的：不算武器會少到掉出檔位", () => {
      const heavy = rule({
        characters: { a: 28, b: 28, c: 28 },
        equipment: { wp001: 4, wp002: 4 },
      });
      const withWeapons = deckFromKeys({
        characters: ["a", "b", "c"],
        equipment: ["wp001", "wp002"],
      });
      // 84（三格）+ 8（武器）= 92 → 進得了 90+
      expect(teamCostCenti(heavy, withWeapons)).toBe(9200);
      expect(tierForTotal(teamCostCenti(heavy, withWeapons), [54, 61, 77], 90)).toEqual({
        kind: "open",
        tier: 90,
      });
    });

    it("同一把武器帶三把就是三份 COST —— 重複不能去掉", () => {
      const three = deckFromKeys({
        characters: ["a", "b", "c"],
        equipment: ["wp001", "wp001", "wp001"],
      });
      expect(teamCostCenti(geared, three)).toBe(6900);
    });
  });

  it("⚠ 上限比一檔還窄時下限夾到 0，不能是負的", () => {
    expect(costBand(0.5)).toEqual({ floor: 0, cap: 50 });
  });

  it("⚠ 兩位小數的上限也吃得下（`toCentiCost` 對三位小數會拋例外）", () => {
    expect(() => checkOwnDeck(rule(), hostDeck, 57.005)).not.toThrow();
  });

  it("規則沒定價的卡會被指出來 —— 那些算 99", () => {
    const check = checkOwnDeck(rule(), slots("leon", "沒這隻"), null);
    expect(check.unknown).toEqual(["沒這隻"]);
    expect(check.total).toBe("121.00");
  });
});

/**
 * 檔位由牌組自己決定（WP-17）。
 *
 * ⚠ 這是**遊戲大廳那顆「快速比賽」**用的判斷：亞城按下去之後伺服器照你的牌組
 * 把你放進某一檔，迪城那顆要一樣。托盤的配對頁仍然是玩家自己填檔位。
 */
describe("檔位由牌組決定", () => {
  const TIERS = [54, 61, 77];

  it("落在哪一檔就是哪一檔", () => {
    // 53.01～54.00
    expect(tierForTotal(5400, TIERS)).toEqual({ kind: "band", tier: 54 });
    expect(tierForTotal(5301, TIERS)).toEqual({ kind: "band", tier: 54 });
    expect(tierForTotal(6050, TIERS)).toEqual({ kind: "band", tier: 61 });
  });

  it("⚠⚠ 不在任何一檔裡就是不合法，不會幫他挑最接近的", () => {
    // 48C：比最低檔的下限還低 —— 亞城那邊看到的就是「這個牌組不符合遊戲規則」。
    expect(tierForTotal(4800, TIERS)).toBeNull();
    // 61.50：兩檔之間的縫。
    expect(tierForTotal(6150, TIERS)).toBeNull();
    // 80C：最高檔以上、但還沒到開口檔。
    expect(tierForTotal(8000, TIERS, 90)).toBeNull();
  });

  it("開口檔（COST90+）收下限以上的全部", () => {
    expect(tierForTotal(9000, TIERS, 90)).toEqual({ kind: "open", tier: 90 });
    expect(tierForTotal(12345, TIERS, 90)).toEqual({ kind: "open", tier: 90 });
    // 沒有開口檔時同一副牌就是不合法。
    expect(tierForTotal(9000, TIERS)).toBeNull();
  });

  it("開口檔只有下限，沒有上限", () => {
    const r = rule({ characters: { a: 95 } });
    expect(checkOwnDeck(r, slots("a"), null, 90)).toMatchObject({
      total: "95.00",
      over: false,
      under: false,
      band: "90.00 以上",
    });
    const low = rule({ characters: { a: 89.99 } });
    expect(checkOwnDeck(low, slots("a"), null, 90)).toMatchObject({ under: true, over: false });
  });

  it("⚠ 有上限時 openFloor 一律不算數（兩者互斥）", () => {
    expect(checkOwnDeck(rule(), hostDeck, 57, 90)).toMatchObject({
      band: "56.01～57.00",
      under: false,
    });
  });

  it("開口檔的房名照抄畫面上的寫法", () => {
    expect(formatCostTag(null, 90)).toBe("[COST:90+]");
    expect(buildRoomName("夾擠式罰C", null, 90)).toBe("夾擠式罰C [COST:90+]");
  });
});

/**
 * 房名。
 *
 * ⚠ 這一組釘的是「**`[COST:n]` 那一段永遠完整**」。房名的功能是讓大廳一眼
 * 看出這是哪一檔（亞城的房間列就是這樣），截到那一段的話功能就沒了。
 */
describe("房名", () => {
  it("規則名 + 檔位，像亞城那樣", () => {
    expect(buildRoomName("亞城平衡", 57)).toBe("亞城平衡 [COST:57]");
  });

  it("⚠ 規則名太長時截前面，COST 那一段一個字都不能少", () => {
    const name = buildRoomName("這是一個非常非常長的規則名稱", 57);
    expect(name.endsWith("[COST:57]")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name).toContain("…");
  });

  it("沒有規則名就退回官方快速比賽那個字", () => {
    expect(buildRoomName("   ", 57)).toBe("Quickmatch [COST:57]");
    // ⚠ 官方那間房剛好 20 個字，所以這個組合一定塞得下。
    expect(buildRoomName("", 57)).toHaveLength(20);
  });

  it("換行與連續空白要壓掉 —— 規則名是規則檔裡的自由文字", () => {
    expect(buildRoomName("亞城\n 平衡", 57)).toBe("亞城 平衡 [COST:57]");
  });

  it("沒設檔位就標「自由」，不是空的", () => {
    expect(formatCostTag(null)).toBe("[COST:自由]");
    expect(buildRoomName("亞城平衡", null)).toBe("亞城平衡 [COST:自由]");
  });

  it("⚠ 小數的檔位不要補 .00 —— 房名只有 20 格", () => {
    expect(formatCostTag(57)).toBe("[COST:57]");
    expect(formatCostTag(57.5)).toBe("[COST:57.5]");
  });

  it("⚠ 永遠不超過遊戲那 20 格", () => {
    for (const limit of [null, 0, 57, 57.25, 199.99]) {
      expect(buildRoomName("非常長的規則名稱一二三四五六七八", limit).length).toBeLessThanOrEqual(
        20,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 狀態機
//
// ⚠ 真的跑一次要兩個帳號、兩份不同版本的規則、消耗 AP，而且會把人丟進對戰。
// 所以中間人的連線與遊戲都是假的，測的是「收到什麼就做什麼」。
// ---------------------------------------------------------------------------

/**
 * 讓所有已經排好的 microtask 跑完。
 *
 * ⚠ 中間人的 callback 是 fire-and-forget（`(info) => void this.#onMatched(info)`）——
 * 那在真的執行時是對的（WebSocket 的事件處理器不能回 Promise），但測試沒有東西
 * 可以 await。假驅動全部是立刻 resolve 的 async，所以跨一次 macrotask 就會把
 * 整條鏈跑完。
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 假的中間人連線。把 callback 留下來，測試自己扮演對手。 */
function fakeLink() {
  const sent = {
    deck: [] as string[],
    eval: [] as string[],
    pref: [] as string[],
    room: [] as string[],
  };
  let rejected = 0;
  let stopped = 0;
  let handlers: MatchQueueClientOptions | null = null;

  const factory = (o: MatchQueueClientOptions): QueueLink => {
    handlers = o;
    return {
      start: () => {},
      stop: () => void stopped++,
      reject: () => void rejected++,
      sendDeck: (b) => void sent.deck.push(b),
      sendEval: (b) => void sent.eval.push(b),
      sendPref: (b) => void sent.pref.push(b),
      sendRoom: (r) => void sent.room.push(r),
    };
  };

  return {
    factory,
    sent,
    get rejected() {
      return rejected;
    },
    get stopped() {
      return stopped;
    },
    get key() {
      return handlers?.key ?? "";
    },
    get tag() {
      return handlers?.tag ?? "";
    },
    matched: (role: "host" | "guest", peerTag = "別的版本") => {
      handlers?.onMatched?.({ role, token: "PASS1234", peerTag });
      return flush();
    },
    peerDeck: (body: string) => {
      handlers?.onPeerDeck?.(body);
      return flush();
    },
    peerEval: (body: string) => {
      handlers?.onPeerEval?.(body);
      return flush();
    },
    /** 對手回報他想打的地點。 */
    peerPref: (body: string) => {
      handlers?.onPeerPref?.(body);
      return flush();
    },
    room: (roomId: string) => {
      handlers?.onRoom?.(roomId);
      return flush();
    },
    dropped: (reason: "cancel" | "gone" | "rejected") => {
      handlers?.onDropped?.(reason);
      return flush();
    },
    /** 連線層回報狀態（連上了、連不上放棄了…）。 */
    queueStatus: (status: QueueStatus, waiting = 0) => {
      handlers?.onStatus?.(status, waiting);
      return flush();
    },
  };
}

function ctx(over: Partial<MatchContext> = {}): MatchContext {
  return {
    hasId: true,
    channel: 2,
    channels: null,
    crossplay: false,
    deckNow: 1,
    deckCost: 57,
    deckKeys: { characters: ["leon", "abel", "evarist"], equipment: [], eventCards: [] },
    playerName: "燈皇",
    isMatching: false,
    inMatch: true,
    ap: 30,
    apMax: 30,
    duelFree: 0,
    ...over,
  };
}

function fakeDriver(over: Partial<MatchDriver> = {}): MatchDriver {
  const mine: RoomEntry = {
    roomId: "我的房",
    name: ROOM_NAME,
    playerAName: "燈皇",
    playerBName: null,
    pass: true,
    deckA: null,
    deckB: null,
  };
  let opened = false;
  return {
    matchContext: over.matchContext ?? (async () => ctx()),
    roomSnapshot:
      over.roomSnapshot ?? (async () => ({ seq: 1, live: true, rooms: opened ? [mine] : [] })),
    createRoom:
      over.createRoom ??
      (async () => {
        opened = true;
        return { ok: true, roomId: null };
      }),
    joinRoom: over.joinRoom ?? (async () => ({ ok: true })),
    cancelRoom: over.cancelRoom ?? (async () => "ok"),
  };
}

const nosleep = async () => {};

/** 一組「中間人是假的、遊戲也是假的」的配對。 */
function pairing(opts: Partial<PairingOptions> = {}, driverOver: Partial<MatchDriver> = {}) {
  const link = fakeLink();
  const driver = fakeDriver(driverOver);
  const p = new MatchPairing({
    endpoint: "wss://example",
    rule: rule(),
    channel: 2,
    costLimit: TIER,
    room: { stage: "arcadia", friend: false },
    driver,
    link: link.factory,
    sleep: nosleep,
    // ⚠ 預設不等對手回報抽法。要測協商的 case 自己把它調大 —— 不然每一個
    // host 的 case 都要多等一拍事件迴圈，而它們測的不是地點。
    stageWaitMs: 0,
    // ⚠ 預設**不盯大廳**。開著的話每個 case 結束時都會留一個 5 秒的 timer，
    // 而那會讓 vitest 的 worker 空等到它燒完。要測的 case 自己塞小的值。
    lobbyWatchMs: 0,
    ...opts,
  });
  return { p, link, driver };
}

describe("狀態機：排隊前的檢查", () => {
  it("不在大廳就停在 blocked，而且不會連上中間人", async () => {
    const { p, link } = pairing({}, { matchContext: async () => ctx({ inMatch: false }) });
    await p.start();
    expect(p.status.phase).toBe("blocked");
    expect(link.key).toBe("");
  });

  it("⚠ 自己的牌組超過這一檔就不排 —— 排下去只是浪費對手的時間", async () => {
    const { p, link } = pairing({ costLimit: 50 });
    await p.start();
    expect(p.status).toMatchObject({
      phase: "blocked",
      overLimit: true,
      underLimit: false,
      myTotal: "57.00",
      band: "49.01～50.00",
    });
    expect(p.status.message).toContain("超過");
    expect(link.key).toBe("");
  });

  /**
   * ⚠⚠ 這一條釘的是「檔位有下限」。
   *
   * 沒有它的話 57C 的隊伍會被收進 66 檔，然後在大廳上掛一間寫著 `[COST:66]`
   * 的房 —— 而配到的那個人是照 66 檔壓過牌組來的。那不是一場比賽。
   */
  it("⚠⚠ 自己的牌組低於這一檔也不排，而且訊息要說得出方向是「太低」", async () => {
    const { p, link } = pairing({ costLimit: 66 });
    await p.start();
    expect(p.status).toMatchObject({
      phase: "blocked",
      overLimit: false,
      underLimit: true,
      myTotal: "57.00",
      band: "65.01～66.00",
    });
    // 「不符合這一檔」那種寫法會讓玩家往錯的方向改
    expect(p.status.message).toContain("低於");
    expect(p.status.message).toContain("65.01～66.00");
    expect(link.key).toBe("");
  });

  it("不設檔位就什麼牌組都排得進去", async () => {
    const { p } = pairing({ costLimit: null });
    await p.start();
    expect(p.status).toMatchObject({ phase: "queued", overLimit: false, underLimit: false });
  });

  it("讀不到牌組也不排（絕不猜一副牌）", async () => {
    const { p } = pairing({}, { matchContext: async () => ctx({ deckKeys: null }) });
    await p.start();
    expect(p.status.phase).toBe("blocked");
  });

  it("條件都對就排隊", async () => {
    const { p, link } = pairing();
    await p.start();
    expect(p.status.phase).toBe("queued");
    expect(link.key).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * ⚠⚠ 這一條釘的是「按了停止要停得下來」。
   *
   * 托盤靠「狀態變成 idle／blocked」來放掉手上的 `MatchPairing`（main.ts 的
   * `onStatus`）。`start()` 中途只要推出一次 phase 還是 `idle` 的狀態，托盤
   * 就把那個物件丟了 —— 可是排隊照樣開始下去：畫面寫「排隊中」，而「停止」
   * 打在 null 上是空操作，怎麼按都停不掉，也不能重按開始（「已經在配對中了」）。
   * 2026-08-16 實測就是這樣卡死的，兇手是 `#patch({ myTotal … })` 那一行。
   */
  it("⚠ start() 期間一次都不准推出 idle —— 托盤靠它決定要不要放掉這個任務", async () => {
    const seen: string[] = [];
    const { p } = pairing({ onStatus: (s) => void seen.push(s.phase) });
    await p.start();
    expect(p.status.phase).toBe("queued");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain("idle");
  });

  /**
   * ⚠ 這一組釘的是「排隊中」不准說謊。
   *
   * `phase` 在按下按鈕的當下就是 `queued`，而那時 WebSocket 才剛開始連 ——
   * 連不上跟「連上了但沒人」在畫面上原本長得一模一樣（都是「排隊中·只有你」），
   * 而它們要玩家做的事完全相反：一個是等，一個是去檢查中間人。
   */
  it("剛按下去時還沒連上中間人 —— linked 是 false", async () => {
    const { p } = pairing();
    await p.start();
    expect(p.status).toMatchObject({ phase: "queued", linked: false });
    expect(p.status.message).toContain("連");
  });

  it("收到 q-welcome 才算連上", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.queueStatus("waiting", 1);
    expect(p.status).toMatchObject({ phase: "queued", linked: true, waiting: 1 });
  });

  it("連不上到放棄 → 停在 blocked，而且訊息要說得出這不是沒人排隊", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.queueStatus("unreachable");
    expect(p.status).toMatchObject({ phase: "blocked", linked: false });
    expect(p.status.message).toContain("連不上");
    // blocked 的意思是「玩家處理完可以再按一次開始」，所以連線要收掉
    expect(link.stopped).toBeGreaterThan(0);
  });
});

describe("狀態機：同一份規則（快路）", () => {
  it("⚠ 標籤一樣就直接開房 —— 牌組一個字都不交換", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host", link.tag);

    expect(link.sent.deck).toEqual([]);
    expect(link.sent.eval).toEqual([]);
    expect(p.status.compatibility).toBe("exact");
    expect(p.status.phase).toBe("ready");
    expect(link.sent.room).toEqual(["我的房"]);
  });

  it("guest 要等房號來才進去", async () => {
    const join = vi.fn(async () => ({ ok: true as const }));
    const theirs: RoomEntry = {
      roomId: "對方的房",
      name: "x",
      playerAName: "對手",
      playerBName: null,
      pass: true,
      deckA: null,
      deckB: null,
    };
    const { p, link } = pairing(
      {},
      { joinRoom: join, roomSnapshot: async () => ({ seq: 1, live: true, rooms: [theirs] }) },
    );
    await p.start();
    await link.matched("guest", link.tag);
    expect(join).not.toHaveBeenCalled();

    await link.room("對方的房");
    // ⚠ 密碼就是配對 token
    expect(join).toHaveBeenCalledWith("對方的房", "PASS1234");
    // 進房成功 = 任務結束。留在 ready 的話托盤不會放掉 pairing 物件，
    // 玩家打完這一場想再排一次只會收到「已經在配對中了」。
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("已進房");
    expect(link.stopped).toBeGreaterThan(0);
  });
});

/**
 * 配對任務的終點。
 *
 * ⚠ 這一組釘的是「打完了要自己停」。2026-08-16 實測：host 開完房就永遠停在
 * `ready` —— 佇列連線還掛著（會被配給第三個人）、`pairing` 物件還活著，而那時
 * 那一場其實已經打完了，玩家得手動按停止才回得去。
 */
describe("狀態機：對戰開始就結束任務", () => {
  /** 開好房、對手還沒進來的那一間。房名與房主要跟 `ctx()` 對得上才找得到。 */
  const empty: RoomEntry = {
    roomId: "我的房",
    name: ROOM_NAME,
    playerAName: "燈皇",
    playerBName: null,
    pass: true,
    deckA: null,
    deckB: null,
  };

  /**
   * 一個會照真實順序變化的假遊戲：開房前清單是空的（否則 preflight 會判定
   * 「你已經有一間自己開的房」），開房後才有那間房。
   */
  function hostDriver(over: { occupied?: () => boolean; vanished?: () => boolean } = {}) {
    let opened = false;
    const cancel = vi.fn(async () => {
      opened = false;
      return "ok";
    });
    return {
      cancel,
      driver: {
        cancelRoom: cancel,
        createRoom: async () => {
          opened = true;
          return { ok: true as const, roomId: null };
        },
        roomSnapshot: async () => {
          if (!opened) return { seq: 1, live: true, rooms: [] };
          if (over.vanished?.() === true) return { seq: 2, live: true, rooms: [] };
          const room = over.occupied?.() === true ? { ...empty, playerBName: "對手" } : empty;
          return { seq: 1, live: true, rooms: [room] };
        },
      } satisfies Partial<MatchDriver>,
    };
  }

  it("host：對手進房了就結束，而且**不收房**（房裡有人）", async () => {
    let occupied = false;
    const { cancel, driver } = hostDriver({ occupied: () => occupied });
    const { p, link } = pairing({ handoffPollMs: 5 }, driver);
    await p.start();
    await link.matched("host", link.tag);
    expect(p.status.phase).toBe("ready");

    occupied = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("對戰");
    // ⚠ 收房就是把剛進來的對手踢出去
    expect(cancel).not.toHaveBeenCalled();
    expect(link.stopped).toBeGreaterThan(0);
  });

  it("host：房從清單上消失（已經開打）也算結束", async () => {
    let vanished = false;
    const { driver } = hostDriver({ vanished: () => vanished });
    const { p, link } = pairing({ handoffPollMs: 5 }, driver);
    await p.start();
    await link.matched("host", link.tag);

    vanished = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(p.status.phase).toBe("idle");
  });

  it("⚠ 對手離開佇列（q-cancel）不代表他跑了 —— 房號交出去之後要看房間，不看佇列", async () => {
    const { cancel, driver } = hostDriver();
    const { p, link } = pairing({ handoffPollMs: 5 }, driver);
    await p.start();
    await link.matched("host", link.tag);

    // 對手一進房就會離開佇列，而那在佇列眼裡就是 q-cancel
    await link.dropped("cancel");
    expect(cancel).not.toHaveBeenCalled();
    expect(p.status.phase).toBe("ready");
    await p.stop();
  });

  it("斷線（gone）仍然是真的跑掉 —— 收房、退回排隊", async () => {
    const { cancel, driver } = hostDriver();
    const { p, link } = pairing({ handoffPollMs: 5 }, driver);
    await p.start();
    await link.matched("host", link.tag);

    await link.dropped("gone");
    expect(cancel).toHaveBeenCalled();
    expect(p.status.phase).toBe("queued");
  });

  it("host：等不到人就收房並停止 —— 不能留一間永遠沒人進的空房", async () => {
    const { cancel, driver } = hostDriver();
    const { p, link } = pairing({ handoffPollMs: 5, handoffTimeoutMs: 10 }, driver);
    await p.start();
    await link.matched("host", link.tag);

    await new Promise((r) => setTimeout(r, 80));
    expect(cancel).toHaveBeenCalled();
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("等不到");
  });

  it("⚠ 清單還不知道有沒有房（seq 0、沒有 live）時不能當成已經開打", async () => {
    let opened = false;
    // 房開好、交出去了，然後清單變成「還不知道」（重連、剛切頻道…）。
    let unknown = false;
    const { p, link } = pairing(
      { handoffPollMs: 5 },
      {
        createRoom: async () => {
          opened = true;
          return { ok: true as const, roomId: null };
        },
        roomSnapshot: async () => {
          if (!opened) return { seq: 1, live: true, rooms: [] };
          if (unknown) return { seq: 0, live: false, rooms: [] };
          return { seq: 1, live: true, rooms: [empty] };
        },
      },
    );
    await p.start();
    await link.matched("host", link.tag);
    expect(p.status.phase).toBe("ready");

    unknown = true;
    await new Promise((r) => setTimeout(r, 40));
    // 空的清單 + 不知道 = 不能推論。仍然在等對手。
    expect(p.status.phase).toBe("ready");
    await p.stop();
  });
});

/**
 * 對戰地點。
 *
 * ⚠ **玩家選不到「哪一張地圖」了** —— 只選「誰來抽」。開房的只有 host，所以
 * 指定地圖對另一邊永遠是被決定的；舊的協商（從雙方選的兩張裡抽一張）只是把
 * 那個不對稱換成擲骰子。取代亞城的東西不該讓人先填一張表。
 */
describe("對戰地點：negotiateStage", () => {
  const always = (n: number) => () => n;

  it("兩邊都要亞城池 → 從那 11 張裡抽", () => {
    expect(ARCADIA_STAGES).toContain(negotiateStage("arcadia", "arcadia", always(0.5)));
  });

  it("對手沒說（舊版插件／中間人不轉發）就用我的", () => {
    expect(ARCADIA_STAGES).toContain(negotiateStage("arcadia", null, always(0.5)));
    expect(negotiateStage("official", null, always(0.5))).toBe(RANDOM_STAGE);
  });

  it("⚠ 有一邊選官方隨機就走官方隨機 —— 亞城池裡有一張官方選單沒有的地圖", () => {
    expect(negotiateStage("arcadia", "official", always(0))).toBe(RANDOM_STAGE);
    expect(negotiateStage("official", "arcadia", always(0))).toBe(RANDOM_STAGE);
    expect(negotiateStage("official", "official", always(0))).toBe(RANDOM_STAGE);
  });

  it("⚠ 抽到的一定在亞城池裡，而且抽不到「隨機」那個代號", () => {
    for (const r of [0, 0.1, 0.5, 0.909, 0.999, 1]) {
      const stage = pickArcadiaStage(always(r));
      expect(ARCADIA_STAGES).toContain(stage);
      expect(stage).not.toBe(RANDOM_STAGE);
    }
  });

  it("亞城池就是官方那 10 張加上 010，共 11 張", () => {
    expect(ARCADIA_STAGES).toHaveLength(11);
    expect(ARCADIA_STAGES[0]).toBe("000");
    expect(ARCADIA_STAGES[10]).toBe("010");
  });

  it("body 壞掉一律當成「他沒說」", () => {
    expect(parsePrefBody("不是 JSON")).toBeNull();
    expect(parsePrefBody(JSON.stringify({ s: "abc" }))).toBeNull();
    expect(parsePrefBody(JSON.stringify({ s: 7 }))).toBeNull();
  });

  it("送出去再收回來是同一種抽法", () => {
    expect(parsePrefBody(encodePrefBody({ stage: "arcadia" }))).toEqual({ stage: "arcadia" });
    expect(parsePrefBody(encodePrefBody({ stage: "official" }))).toEqual({ stage: "official" });
  });

  /**
   * ⚠ 舊版插件的 `parsePrefBody` 只收三位數字。`official` 送 `"014"` 而不是
   * `"official"`，舊版才讀得懂 —— 它當 host 時也會開隨機房。
   */
  it("⚠ 官方隨機送的是舊版讀得懂的 014", () => {
    expect(JSON.parse(encodePrefBody({ stage: "official" }))).toEqual({ s: RANDOM_STAGE });
  });

  it("⚠ 舊版送來的三位數字一律當官方隨機 —— 新版沒有「指定某一張」了", () => {
    expect(parsePrefBody(JSON.stringify({ s: "007" }))).toEqual({ stage: "official" });
    expect(parsePrefBody(JSON.stringify({ s: "014" }))).toEqual({ stage: "official" });
  });
});

describe("狀態機：地點協商走到開房", () => {
  it("配到人就先把自己的抽法送出去（EXACT 快路也要送）", async () => {
    const { p, link } = pairing({ room: ROOM("arcadia") });
    await p.start();
    await link.matched("host", link.tag);
    expect(link.sent.pref.map(parsePrefBody)).toEqual([{ stage: "arcadia" }]);
  });

  /** 開得起來的假遊戲：開房之後清單上就有那間房（否則 host 會找不到 room_id）。 */
  function openable() {
    let opened = false;
    const create = vi.fn(async () => {
      opened = true;
      return { ok: true as const, roomId: null };
    });
    const room: RoomEntry = {
      roomId: "我的房",
      name: ROOM_NAME,
      playerAName: "燈皇",
      playerBName: null,
      pass: true,
      deckA: null,
      deckB: null,
    };
    return {
      create,
      driver: {
        createRoom: create,
        roomSnapshot: async () => ({ seq: 1, live: true, rooms: opened ? [room] : [] }),
      } satisfies Partial<MatchDriver>,
    };
  }

  it("對手的抽法到了 → 用協商的結果開房", async () => {
    const { create, driver } = openable();
    // 我亞城池、對手官方隨機 → 走官方隨機
    const { p, link } = pairing(
      { room: ROOM("arcadia"), stageWaitMs: 200, roll: () => 0, handoffPollMs: 10_000 },
      driver,
    );
    await p.start();
    await link.matched("host", link.tag); // 卡在等對手的抽法
    expect(create).not.toHaveBeenCalled();

    await link.peerPref(encodePrefBody({ stage: "official" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: RANDOM_STAGE }));
    expect(p.status.stage).toBe(RANDOM_STAGE);
    await p.stop();
  });

  it("⚠ 等不到對手的抽法就用自己的開下去 —— 協商是加分，不是開打的前提", async () => {
    const { create, driver } = openable();
    const { p, link } = pairing(
      { room: ROOM("official"), stageWaitMs: 10, handoffPollMs: 10_000 },
      driver,
    );
    await p.start();
    await link.matched("host", link.tag);

    await new Promise((r) => setTimeout(r, 40));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: RANDOM_STAGE }));
    expect(p.status.stage).toBe(RANDOM_STAGE);
    await p.stop();
  });

  it("兩邊都要亞城池 → 開在那 11 張的其中一張", async () => {
    const { create, driver } = openable();
    const { p, link } = pairing(
      { room: ROOM("arcadia"), stageWaitMs: 200, roll: () => 0.5, handoffPollMs: 10_000 },
      driver,
    );
    await p.start();
    await link.matched("host", link.tag);
    await link.peerPref(encodePrefBody({ stage: "arcadia" }));

    expect(ARCADIA_STAGES).toContain(p.status.stage);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stage: ARCADIA_STAGES[5] as string }),
    );
    await p.stop();
  });

  it("⚠ 換下一位時要忘記上一位的抽法", async () => {
    const create = vi.fn(async () => ({ ok: true as const, roomId: null }));
    const { p, link } = pairing(
      { room: ROOM("arcadia"), stageWaitMs: 10, roll: () => 0 },
      { createRoom: create },
    );
    await p.start();
    // 第一位：要官方隨機，但規則對不起來，換人
    await link.matched("host");
    await link.peerPref(encodePrefBody({ stage: "official" }));
    await link.peerDeck("這不是 JSON");
    expect(p.status.phase).toBe("queued");

    // 第二位什麼都沒說 → 要用我自己的亞城池，不是上一位的官方隨機
    await link.matched("host", link.tag);
    await new Promise((r) => setTimeout(r, 40));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: ARCADIA_STAGES[0] }));
  });
});

describe("狀態機：開始配對時先收掉自己開著的房", () => {
  const own: RoomEntry = {
    roomId: "上一輪留下的",
    name: "請多關照",
    playerAName: "燈皇",
    playerBName: null,
    pass: true,
    deckA: null,
    deckB: null,
  };

  it("有自己的房就先收掉再排，不是擋下來叫玩家自己去收", async () => {
    let cleared = false;
    const cancel = vi.fn(async () => {
      cleared = true;
      return "ok";
    });
    const { p, link } = pairing(
      {},
      {
        cancelRoom: cancel,
        roomSnapshot: async () => ({ seq: 1, live: true, rooms: cleared ? [] : [own] }),
      },
    );
    await p.start();

    expect(cancel).toHaveBeenCalled();
    expect(p.status.phase).toBe("queued");
    expect(link.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("收了還在（收不掉）就照樣擋下來，不能硬排下去", async () => {
    const { p } = pairing(
      {},
      {
        cancelRoom: async () => "ok",
        roomSnapshot: async () => ({ seq: 1, live: true, rooms: [own] }),
      },
    );
    await p.start();
    expect(p.status.phase).toBe("blocked");
    expect(p.status.message).toContain("自己開的房");
  });

  /**
   * ⚠⚠ 這一條釘的是「玩家在排隊途中自己開房」這條路。
   *
   * guest 那半段**沒有 preflight**（host 那半段有，順手就收了）。少了
   * `#clearOwnRoom`，玩家人進了對手的房，而他自己那間會一直留在清單上等一個
   * 永遠不會來的人 —— 下一次配對被「你已經有一間自己開的房」擋住時，沒有人
   * 會把那件事跟這一場連在一起。
   */
  it("guest：配到人時要幫玩家收掉他在排隊途中開的那間房", async () => {
    let ownRoom = false;
    const cancel = vi.fn(async () => {
      ownRoom = false;
      return "ok";
    });
    const join = vi.fn(async () => ({ ok: true as const }));
    const theirs: RoomEntry = {
      roomId: "對方的房",
      name: "x",
      playerAName: "對手",
      playerBName: null,
      pass: true,
      deckA: null,
      deckB: null,
    };
    const { p, link } = pairing(
      {},
      {
        matchContext: async () => ctx({ isMatching: ownRoom }),
        roomSnapshot: async () => ({
          seq: 1,
          live: true,
          rooms: ownRoom ? [own, theirs] : [theirs],
        }),
        joinRoom: join,
        cancelRoom: cancel,
      },
    );
    await p.start();
    // 開始排隊的當下他沒有房 —— 所以這一句不是 start() 收的。
    expect(cancel).not.toHaveBeenCalled();

    ownRoom = true; // 等的時候自己去開了一間
    await link.matched("guest", link.tag);
    await link.room("對方的房");

    expect(cancel).toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith("對方的房", "PASS1234");
    expect(p.status.phase).toBe("idle");
  });
});

/**
 * 排隊時盯著大廳。
 *
 * ⚠ 這一組釘的是**配對的第三條收尾路徑**（另外兩條是「對戰開始」與「玩家按
 * 停止」）。排隊是會等的，而玩家在等的時候會去做別的事 —— 點進別人的房、被拉
 * 進一場對戰、切頻道、回標題畫面。少了這一段，那條佇列連線會一直掛著，等他
 * 打完回到大廳，中間人早就把他配給某個人了，而那個人正開著房等一個沒在看
 * 畫面的對手。
 */
describe("狀態機：排隊時盯著大廳", () => {
  const own: RoomEntry = {
    roomId: "玩家自己開的",
    name: "來打啊",
    playerAName: "燈皇",
    playerBName: null,
    pass: false,
    deckA: null,
    deckB: null,
  };

  it("⚠ 玩家跑去打別場（不在大廳了）→ 自動停止排隊", async () => {
    let inMatch = true;
    const { p, link } = pairing(
      { lobbyWatchMs: 5 },
      { matchContext: async () => ctx({ inMatch }) },
    );
    await p.start();
    expect(p.status.phase).toBe("queued");

    inMatch = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("大廳");
    // 佇列連線一定要收掉 —— 留著的話中間人還是會把人配給我們
    expect(link.stopped).toBeGreaterThan(0);
  });

  it("⚠ 換頻道 → 自動停止（不必等配到人才發現）", async () => {
    let channel: number | null = 2;
    const { p } = pairing({ lobbyWatchMs: 5 }, { matchContext: async () => ctx({ channel }) });
    await p.start();

    channel = 4;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("頻道 4");
  });

  it("退出頻道（回大廳清單）也算離開", async () => {
    let channel: number | null = 2;
    const { p } = pairing({ lobbyWatchMs: 5 }, { matchContext: async () => ctx({ channel }) });
    await p.start();

    channel = null;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("頻道");
  });

  /**
   * ⚠ 玩家開房**不是**離開。他可能想兩邊碰運氣，而插件在他還沒配到人的時候
   * 把那間房拆了，等於擅自取消了他的另一條路。真的配到人時才收（見上一組）。
   */
  it("⚠ 玩家自己開了一間房 → 照排不誤", async () => {
    let ownRoom = false;
    const cancel = vi.fn(async () => "ok");
    const { p } = pairing(
      { lobbyWatchMs: 5 },
      {
        matchContext: async () => ctx({ isMatching: ownRoom }),
        roomSnapshot: async () => ({ seq: 1, live: true, rooms: ownRoom ? [own] : [] }),
        cancelRoom: cancel,
      },
    );
    await p.start();

    ownRoom = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("queued");
    expect(cancel).not.toHaveBeenCalled();
    await p.stop();
  });

  it("⚠ 讀不到遊戲不算離開 —— 重載中、CDP 抖一下每次都會這樣", async () => {
    let broken = false;
    const { p } = pairing(
      { lobbyWatchMs: 5 },
      {
        matchContext: async () => {
          if (broken) throw new Error("CDP 斷了");
          return ctx();
        },
      },
    );
    await p.start();

    broken = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("queued");
    await p.stop();
  });

  /**
   * ⚠⚠ 配到人之後就不看了。進房成功的下一刻遊戲就切到對戰畫面，那時
   * `inMatch` 本來就是 false —— 在那裡判「他離開了」等於把剛打起來的一場
   * 自己收掉，而畫面上會寫「你不在大廳了」。
   */
  it("⚠⚠ 開好房在等對手時不看大廳 —— 那時不在大廳是正常的", async () => {
    let inMatch = true;
    const { p, link } = pairing(
      { lobbyWatchMs: 5, handoffPollMs: 10_000 },
      { matchContext: async () => ctx({ inMatch }) },
    );
    await p.start();
    await link.matched("host", link.tag);
    expect(p.status.phase).toBe("ready");

    inMatch = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(p.status.phase).toBe("ready");
    await p.stop();
  });
});

/**
 * 房名。
 *
 * ⚠ 開房用的房名與 `findOwnRoom` 比對用的房名**必須是同一個字串**。漂掉一個
 * 字的症狀是「房開出來了，但插件說等不到自己那間房出現在清單裡」，然後把房
 * 收掉、停止配對 —— 而那看起來完全像是遊戲那邊的問題。
 */
describe("狀態機：房名是系統取的", () => {
  it("開房時用「規則名 + 檔位」，玩家插不了手", async () => {
    const create = vi.fn(async () => ({ ok: true as const, roomId: null }));
    const { p, link } = pairing({}, { createRoom: create });
    await p.start();
    await link.matched("host", link.tag);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "亞城平衡 [COST:57]" }));
    await p.stop();
  });

  it("⚠ 房名一定不含配對 token —— 房間清單是公開的", async () => {
    const create = vi.fn(async (_options: CreateRoomOptions) => ({
      ok: true as const,
      roomId: null,
    }));
    const { p, link } = pairing({}, { createRoom: create });
    await p.start();
    await link.matched("host", link.tag);

    const opts = create.mock.calls[0]?.[0];
    // 密碼就是 token，而房名是公開的 —— 它們絕對不能是同一個字串的兩半
    expect(opts?.pass).toBe("PASS1234");
    expect(opts?.name).not.toContain("PASS1234");
    await p.stop();
  });
});

describe("狀態機：跨版本驗算", () => {
  it("送出自己的描述子，收到對手的就回指紋", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");

    expect(p.status.phase).toBe("checking");
    expect(parseDeckBody(link.sent.deck[0] ?? "")).toEqual(hostDeck);

    await link.peerDeck(encodeDeckBody(guestDeck));
    const mine = parseEvalBody(link.sent.eval[0] ?? "");
    expect(mine).toEqual(crossEvaluate(rule(), { host: hostDeck, guest: guestDeck }));
  });

  it("四個指紋兩兩相等 → 開房", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");
    await link.peerDeck(encodeDeckBody(guestDeck));
    // 對手用另一個版本算，但這一場算出來的東西一樣
    const other = rule({ version: "1.5.1", characters: { ...rule().characters, newbie: 99 } });
    await link.peerEval(encodeEvalBody(crossEvaluate(other, { host: hostDeck, guest: guestDeck })));

    expect(p.status.compatibility).toBe("compatible");
    expect(link.sent.room).toEqual(["我的房"]);
  });

  it("⚠⚠ 對手的描述子比自己讀牌組還早到 —— 不能就這樣卡住", async () => {
    // 讀牌組是一次 CDP 往返，對手的 q-deck 完全可能在那幾十毫秒裡就到了。
    // 沒有處理的話兩邊會一起等到逾時，而畫面上寫著「正在對規則」。
    /** 卡住 `matchContext`，讓「讀牌組」慢下來。 */
    let gate: Promise<void> = Promise.resolve();
    const { p, link } = pairing(
      {},
      {
        matchContext: async () => {
          await gate;
          return ctx();
        },
      },
    );
    await p.start();

    let open: () => void = () => {};
    gate = new Promise<void>((r) => (open = r));
    await link.matched("host"); // 卡在讀牌組
    expect(link.sent.deck).toEqual([]); // 還沒送出自己的描述子

    await link.peerDeck(encodeDeckBody(guestDeck)); // 對手先到了
    expect(link.sent.eval).toEqual([]); // 這時候還算不了

    open();
    await flush();

    // 讀到牌組之後要**自己**把驗算再推一次 —— 沒有別的東西會觸發它了
    expect(link.sent.deck).toHaveLength(1);
    expect(link.sent.eval).toHaveLength(1);
    expect(parseEvalBody(link.sent.eval[0] ?? "")).toEqual(
      crossEvaluate(rule(), { host: hostDeck, guest: guestDeck }),
    );
  });

  it("算出來不一樣 → 換下一位，而且留在佇列裡", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");
    await link.peerDeck(encodeDeckBody(guestDeck));
    // 對手的規則把 leon 定成別的價格 —— 兩副牌都會算出不同的東西
    const other = rule({ characters: { ...rule().characters, leon: 30 } });
    await link.peerEval(encodeEvalBody(crossEvaluate(other, { host: hostDeck, guest: guestDeck })));

    expect(link.rejected).toBe(1);
    expect(link.sent.room).toEqual([]);
    expect(p.status).toMatchObject({ phase: "queued", skipped: 1 });
  });

  it("⚠ 對手送來看不懂的東西也只是換下一位，不會炸掉", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");
    await link.peerDeck("這不是 JSON");
    expect(link.rejected).toBe(1);
    expect(p.status.phase).toBe("queued");
  });
});

describe("狀態機：對手跑掉", () => {
  it("⚠ 房已經開了就要收掉 —— 否則下一次配對會被 preflight 擋住", async () => {
    const cancel = vi.fn(async () => "ok");
    const { p, link } = pairing({}, { cancelRoom: cancel });
    await p.start();
    await link.matched("host", link.tag);
    expect(p.status.phase).toBe("ready");

    await link.dropped("gone");
    expect(cancel).toHaveBeenCalled();
    expect(p.status.phase).toBe("queued");
  });

  it("⚠ 排隊途中換了頻道 → 配到人時要停下來，不能在新頻道開房", async () => {
    // 房間清單是分頻道推播的：host 在新頻道開的房，對手在舊頻道根本看不到。
    let channel = 2;
    const { p, link } = pairing({}, { matchContext: async () => ctx({ channel }) });
    await p.start();
    channel = 4; // 玩家在等的時候切去布萊德克洛伊茲
    await link.matched("host", link.tag);

    expect(p.status.phase).toBe("idle");
    expect(p.status.message).toContain("頻道 4");
    expect(link.sent.room).toEqual([]);
  });

  it("被拒的訊息要講「規則版本」，不是「對方取消」", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");
    await link.dropped("rejected");
    expect(p.status.message).toContain("規則版本");
  });

  it("停止時會退出佇列並收房", async () => {
    const cancel = vi.fn(async () => "ok");
    const { p, link } = pairing({}, { cancelRoom: cancel });
    await p.start();
    await link.matched("host", link.tag);
    await p.stop();

    expect(link.stopped).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalled();
    expect(p.status.phase).toBe("idle");
  });
});

describe("狀態機：⚠ 對手的牌組不會外洩", () => {
  it("跨版本驗算完之後，狀態物件裡沒有對手的任何角色", async () => {
    const { p, link } = pairing();
    await p.start();
    await link.matched("host");
    await link.peerDeck(encodeDeckBody(guestDeck));
    await link.peerEval(
      encodeEvalBody(crossEvaluate(rule(), { host: hostDeck, guest: guestDeck })),
    );

    const dump = JSON.stringify(p.status);
    for (const key of guestDeck.characters) expect(dump).not.toContain(key);
    // 自己的總和該有，對手的不該有
    expect(p.status.myTotal).toBe("57.00");
    expect(dump).not.toContain(fingerprint(rule(), guestDeck));
  });
});
