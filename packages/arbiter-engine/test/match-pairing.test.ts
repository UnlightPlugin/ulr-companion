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
import type { MatchContext, RoomEntry } from "@ulr/cdp-adapter";
import type { MatchQueueClientOptions, QueueStatus } from "@ulr/arbiter-link";
import {
  checkOwnDeck,
  crossEvaluate,
  encodeDeckBody,
  encodeEvalBody,
  encodePrefBody,
  MatchPairing,
  negotiateStage,
  parseDeckBody,
  parseEvalBody,
  parsePrefBody,
  RANDOM_STAGE,
  type PairingOptions,
  type QueueLink,
} from "../src/match-pairing.js";

/** 開房設定，只有地點會變。 */
const ROOM = (stage: string): PairingOptions["room"] => ({
  name: "請多關照",
  stage,
  friend: false,
  deckCostBand: null,
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

const hostDeck = slots("leon", "abel", "evarist");
const guestDeck = slots("leon", "leon", "abel");

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

describe("自己那副牌合不合法", () => {
  it("在上限之內就過", () => {
    // 22 + 17 + 18 = 57
    expect(checkOwnDeck(rule(), hostDeck, 62)).toMatchObject({ total: "57.00", over: false });
  });

  it("超過就擋", () => {
    expect(checkOwnDeck(rule(), hostDeck, 50).over).toBe(true);
  });

  it("⚠ 剛好卡滿上限**不算**超標", () => {
    expect(checkOwnDeck(rule(), hostDeck, 57).over).toBe(false);
  });

  it("⚠ 浮點尾巴不該讓卡滿的隊伍被判超標", () => {
    // 8.8 + 26.6 + 26.6 用 double 相加是 62.00000000000001
    const r = rule({ characters: { a: 8.8, b: 26.6, c: 26.6 } });
    const d = slots("a", "b", "c");
    expect(checkOwnDeck(r, d, 62)).toMatchObject({ total: "62.00", over: false });
  });

  it("不設限就永遠不超標", () => {
    expect(checkOwnDeck(rule(), hostDeck, null).over).toBe(false);
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
    ...over,
  };
}

function fakeDriver(over: Partial<MatchDriver> = {}): MatchDriver {
  const mine: RoomEntry = {
    roomId: "我的房",
    name: "請多關照",
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
    multi: true,
    costLimit: 62,
    room: { name: "請多關照", stage: "000", friend: false, deckCostBand: null },
    driver,
    link: link.factory,
    sleep: nosleep,
    // ⚠ 預設不等對手回報地點。要測協商的 case 自己把它調大 —— 不然每一個
    // host 的 case 都要多等一拍事件迴圈，而它們測的不是地點。
    stageWaitMs: 0,
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

  it("⚠ 自己的牌組超過約定上限就不排 —— 排下去只是浪費對手的時間", async () => {
    const { p } = pairing({ costLimit: 50 });
    await p.start();
    expect(p.status).toMatchObject({ phase: "blocked", overLimit: true, myTotal: "57.00" });
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
    name: "請多關照",
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
 * 對戰地點的協商。
 *
 * 開房的只有 host，所以「地點」原本就是他一個人說了算 —— 而那對另一邊是
 * 沒得商量的。這一組把規則釘住：一樣就用那個、有人選隨機就隨機、不一樣就從
 * **這兩個**裡面抽（不是從 15 張地圖裡抽）。
 */
describe("對戰地點：negotiateStage", () => {
  const always = (n: number) => () => n;

  it("兩邊一樣就用那個", () => {
    expect(negotiateStage("007", "007", always(0.9))).toBe("007");
  });

  it("對手沒說（舊版插件／中間人不轉發）就用我的", () => {
    expect(negotiateStage("007", null, always(0.9))).toBe("007");
    expect(negotiateStage("007", "", always(0.9))).toBe("007");
  });

  it("⚠ 有一邊選隨機就強制隨機 —— 選隨機的人已經說了「哪裡都行」", () => {
    expect(negotiateStage(RANDOM_STAGE, "007", always(0))).toBe(RANDOM_STAGE);
    expect(negotiateStage("007", RANDOM_STAGE, always(0))).toBe(RANDOM_STAGE);
    expect(negotiateStage(RANDOM_STAGE, RANDOM_STAGE, always(0))).toBe(RANDOM_STAGE);
  });

  it("不一樣就從這兩個裡面抽一個，各一半", () => {
    expect(negotiateStage("003", "011", always(0.2))).toBe("003");
    expect(negotiateStage("003", "011", always(0.8))).toBe("011");
  });

  it("⚠ 抽的只會是雙方選過的其中一個 —— 不會抽到誰都沒選的地圖", () => {
    for (const r of [0, 0.25, 0.499, 0.5, 0.75, 0.999]) {
      expect(["003", "011"]).toContain(negotiateStage("003", "011", always(r)));
    }
  });

  it("body 壞掉一律當成「他沒說」", () => {
    expect(parsePrefBody("不是 JSON")).toBeNull();
    expect(parsePrefBody(JSON.stringify({ s: "abc" }))).toBeNull();
    expect(parsePrefBody(JSON.stringify({ s: 7 }))).toBeNull();
    expect(parsePrefBody(encodePrefBody({ stage: "013" }))).toEqual({ stage: "013" });
  });
});

describe("狀態機：地點協商走到開房", () => {
  it("配到人就先把自己的地點送出去（EXACT 快路也要送）", async () => {
    const { p, link } = pairing({ room: ROOM("009") });
    await p.start();
    await link.matched("host", link.tag);
    expect(link.sent.pref.map(parsePrefBody)).toEqual([{ stage: "009" }]);
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
      name: "請多關照",
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

  it("對手的地點到了 → 用協商的結果開房", async () => {
    const { create, driver } = openable();
    // 我 003、對手 011，抽到後者
    const { p, link } = pairing(
      { room: ROOM("003"), stageWaitMs: 200, roll: () => 0.9, handoffPollMs: 10_000 },
      driver,
    );
    await p.start();
    await link.matched("host", link.tag); // 卡在等對手的地點
    expect(create).not.toHaveBeenCalled();

    await link.peerPref(encodePrefBody({ stage: "011" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: "011" }));
    expect(p.status.stage).toBe("011");
    await p.stop();
  });

  it("⚠ 等不到對手的地點就用自己的開下去 —— 協商是加分，不是開打的前提", async () => {
    const { create, driver } = openable();
    const { p, link } = pairing(
      { room: ROOM("005"), stageWaitMs: 10, handoffPollMs: 10_000 },
      driver,
    );
    await p.start();
    await link.matched("host", link.tag);

    await new Promise((r) => setTimeout(r, 40));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: "005" }));
    expect(p.status.stage).toBe("005");
    await p.stop();
  });

  it("對手選隨機 → 開隨機房，忽略我指定的那張", async () => {
    const create = vi.fn(async () => ({ ok: true as const, roomId: null }));
    const { p, link } = pairing(
      { room: ROOM("003"), stageWaitMs: 200, roll: () => 0 },
      { createRoom: create },
    );
    await p.start();
    await link.matched("host", link.tag);
    await link.peerPref(encodePrefBody({ stage: RANDOM_STAGE }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: RANDOM_STAGE }));
  });

  it("⚠ 換下一位時要忘記上一位的地點", async () => {
    const create = vi.fn(async () => ({ ok: true as const, roomId: null }));
    const { p, link } = pairing(
      { room: ROOM("003"), stageWaitMs: 10, roll: () => 0.9 },
      { createRoom: create },
    );
    await p.start();
    // 第一位：規則對不起來，換人
    await link.matched("host");
    await link.peerPref(encodePrefBody({ stage: "011" }));
    await link.peerDeck("這不是 JSON");
    expect(p.status.phase).toBe("queued");

    // 第二位什麼都沒說 → 要用我自己的 003，不是上一位的 011
    await link.matched("host", link.tag);
    await new Promise((r) => setTimeout(r, 40));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stage: "003" }));
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
