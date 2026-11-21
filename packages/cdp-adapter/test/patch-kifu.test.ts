/**
 * 牌譜錄製（頁面這一半）
 *
 * 把 `buildKifuPatchScript()` 產出來的字串原封不動跑起來，假環境照 2026-10-23 實機：
 * - MainA.init 同步設好 socket（new WSClient 或 match_transfer.socket），之後才 await register
 * - 官方 game_result 第一行 socket.off() —— onAny 一起被拆，result 那則 onAny 收不到
 * - WSClient：onAny/offAny/emit/off/readyState，onAny 掛在實例上
 *
 * 要抓的坑：
 * 1. 包原型 init：開場第一則就錄到（partial=false）；中途接上走輪詢、標 partial
 * 2. 對手只留角色卡 id（room_config 帶著對手整副牌組）
 * 3. 房號與長 id 換成 ~id（送出的 card_submit(room_id, …)）
 * 4. result 靠包 game_result 記下來，而且只記一次
 * 5. 連線關了就收尾，貼圖清單不含 Text 的 UUID 畫布
 * 6. 拆掉時 init／game_result 還原、監聽拆乾淨
 */

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKifuPatchScript,
  buildKifuTextureInfoExpression,
  isIdLike,
  isKifuReport,
  KIFU_STATUS_EXPRESSION,
  KIFU_UNINSTALL_EXPRESSION,
  parseKifuStatus,
  type KifuReport,
} from "@ulr/cdp-adapter";

const BINDING = "__ulrCompanionReport";
const ROOM = "PutwqSNKv9vVYKki7e2chgUVLNZgbgWQ46HH";

class FakeSocket {
  readyState = 1;
  any: ((...a: unknown[]) => void)[] = [];
  sent: unknown[][] = [];
  onAny(fn: (...a: unknown[]) => void) {
    this.any.push(fn);
    return this;
  }
  offAny(fn?: (...a: unknown[]) => void) {
    this.any = fn === undefined ? [] : this.any.filter((f) => f !== fn);
    return this;
  }
  off() {
    this.any = [];
    return this;
  }
  emit(...a: unknown[]) {
    this.sent.push(a);
    return this;
  }
  /** 伺服器推一則 */
  push(name: string, ...args: unknown[]) {
    for (const f of [...this.any]) f(name, ...args);
  }
}

function roomConfig() {
  return {
    room_id: ROOM,
    rule: "duel",
    player_side: "A",
    turn_limit: 18,
    stage: "003",
    bgm: "bgm003",
    multi: true,
    crossplay: false,
    dialogue: { id: 1, content: "hi" },
    domain: "wss://x",
    port: 14002,
    playerA_info: {
      player_name: "我",
      level: 70,
      bp: 1500,
      win: 1,
      lose: 2,
      draw: 0,
      avatar: [{ parts_id: 1, parts_type: 0, create_at: "x" }],
    },
    playerB_info: {
      player_name: "對手",
      level: 60,
      bp: 1400,
      win: 3,
      lose: 4,
      draw: 0,
      avatar: [],
    },
    playerA_deck: {
      chara_card_id: [37, 98, 197],
      weapon_card_id: [1, null, null],
      event_card_id: [6, 6],
      cost: 71,
    },
    playerB_deck: {
      chara_card_id: [45, 259, 165],
      weapon_card_id: [9, 9, 9],
      event_card_id: [22, 22, 27],
      cost: 58,
    },
    player_chara1_hp: 11,
    opponent_chara1_hp: 9,
  };
}

class MainAScene {
  socket: FakeSocket | null = null;
  room_id: string | null = null;
  room_config: ReturnType<typeof roomConfig> | null = null;
  player_side: string | null = null;
  is_complete = false;
  results: unknown[] = [];
  sys = { settings: { status: 8 } };
  load = { baseURL: "https://cdn.example/" };
  turn_text = { text: "1" };
  children = { list: [] as unknown[] };
}
interface MainAProto {
  init(
    this: MainAScene,
    e: { side: string; room_config: ReturnType<typeof roomConfig> },
  ): Promise<void>;
  game_result(this: MainAScene, e: unknown): Promise<void>;
}
const proto: MainAProto = {
  async init(e) {
    this.is_complete = false;
    this.player_side = e.side;
    this.room_config = e.room_config;
    this.room_id = e.room_config.room_id;
    this.socket = new FakeSocket();
    await Promise.resolve(); // register / join_room
  },
  async game_result(e) {
    this.is_complete = true;
    this.socket!.off();
    this.socket!.emit("leaveRoom", this.room_id);
    this.socket!.readyState = 3;
    this.results.push(e);
  },
};
Object.setPrototypeOf(MainAScene.prototype, proto);

function setup() {
  const m = new MainAScene();
  const back = { sys: { settings: { status: 5 } }, children: { list: [] as unknown[] } };
  const tables: Record<string, unknown> = { CharaCards: [{ id: 37 }], State: { mahi: {} } };
  const reports: KifuReport[] = [];
  const window: Record<string, unknown> = {
    game: {
      scene: {
        keys: {
          MainA: m,
          BackA: back,
          MainAAssets: {
            loader: () => ({
              image: [{ key: "life_base", url: "images/assets/Game/life_base.webp" }],
              spritesheet: [
                {
                  key: "atk_suc",
                  url: "images/assets/Game/atk_suc.webp",
                  frameConfig: { frameWidth: 60, frameHeight: 60 },
                },
              ],
              atlas: [
                {
                  key: "cc004_s",
                  textureURL: "images/assets/CharaCards/standchara/cc004.avif",
                  atlasURL: "images/assets/CharaCards/standchara/cc004.json",
                },
              ],
              animation: [{ key: "x" }],
              audio: [{ key: "bgm", url: "x.mp3" }],
            }),
          },
        },
      },
      cache: { json: { get: (k: string) => tables[k] } },
    },
    crypto: countedCrypto,
    lang: "tcn",
    [BINDING]: (payload: string) => reports.push(JSON.parse(payload) as KifuReport),
  };
  const run = <T = string>(expression: string): T =>
    // eslint-disable-next-line no-new-func
    (new Function("window", `return ${expression};`) as (w: unknown) => T)(window);
  /** 開一場（官方 Phaser 的順序：init → 狀態變 RUNNING） */
  const startMatch = async () => {
    m.sys.settings.status = 1;
    // 照 Phaser：從實例讀 init（實例沒有自己的 → 原型上那支，也就是被包過的）
    await (Object.getPrototypeOf(m) as MainAProto).init.call(m, {
      side: "A",
      room_config: roomConfig(),
    });
    m.sys.settings.status = 5;
  };
  return { m, back, window, reports, run, startMatch };
}

/**
 * 還沒算完的雜湊有幾個。webcrypto 在執行緒池算，**要等多久看機器多忙** —— 以前 settle
 * 只讓 50 次 setImmediate，完整測試平行跑時偶爾來不及，每次紅的是不同條。
 */
let digesting = 0;
const countedCrypto = {
  subtle: {
    digest: (algorithm: string, data: Parameters<typeof webcrypto.subtle.digest>[1]) => {
      digesting++;
      return webcrypto.subtle.digest(algorithm, data).finally(() => {
        digesting--;
      });
    },
  },
};

/** 讓真的時間過去，直到雜湊都算完（最多 5 秒），再多轉幾圈讓後續的 then 跑完。 */
async function drain() {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  do {
    await new Promise((r) => setImmediate(r));
  } while (digesting > 0 && process.hrtime.bigint() < deadline);
  for (let j = 0; j < 10; j++) await new Promise((r) => setImmediate(r));
}

/** 等雜湊（webcrypto 是真的非同步）與計時器 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(250);
    await drain();
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("牌譜錄製", () => {
  it("包原型 init：開場就掛上，meta 對、對手只留角色卡、房號雜湊", async () => {
    const { m, run, reports, startMatch } = setup();
    const st = parseKifuStatus(run(buildKifuPatchScript({ bindingName: BINDING })));
    expect(st.installed).toBe(true);
    expect(st.initHooked).toBe(true);

    await startMatch();
    m.socket!.push("chara_A", [{ chara: "cc004", hp: 11 }]);
    await settle();

    const start = reports.find((r) => r.type === "kifu-start");
    expect(start).toBeDefined();
    if (start?.type !== "kifu-start") throw new Error("no start");
    const meta = start.meta;
    expect(meta.partial).toBe(false);
    expect(meta.side).toBe("A");
    expect(meta.stage).toBe("003");
    expect(meta.ownDeck).toEqual(roomConfig().playerA_deck);
    expect(meta.opponentCharaIds).toEqual([45, 259, 165]);
    expect(JSON.stringify(meta)).not.toContain("22,22,27"); // 對手事件卡
    expect(JSON.stringify(meta)).not.toContain(ROOM);
    expect(meta.roomHash).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.players.A!.name).toBe("我");
    expect(meta.players.A!.avatar).toEqual([{ parts_id: 1, parts_type: 0 }]);
    expect(meta.tables.CharaCards).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.tables.Feats).toBeNull();
    expect(meta.loader.map((a) => a.key)).toEqual(["life_base", "atk_suc", "cc004_s"]);
    expect(meta.baseURL).toBe("https://cdn.example/");
    expect(meta.hp).toEqual({ player_chara1_hp: 11, opponent_chara1_hp: 9 });

    const ev = reports
      .filter((r) => r.type === "kifu-events")
      .flatMap((r) => (r.type === "kifu-events" ? r.events : []));
    expect(ev.map((e) => e[2])).toEqual(["chara_A"]);
    expect(reports.every(isKifuReport)).toBe(true);
  });

  it("送出：房號換成 ~id，心跳不記，原本的 emit 照樣送出", async () => {
    const { m, run, reports, startMatch } = setup();
    run(buildKifuPatchScript({ bindingName: BINDING }));
    await startMatch();
    const sock = m.socket!;
    sock.emit("card_submit", ROOM, 3);
    sock.emit("__ping_c", 123);
    sock.push("card_submit_player", 3, true, true, false);
    await settle();
    await settle();
    expect(sock.sent).toEqual([
      ["card_submit", ROOM, 3],
      ["__ping_c", 123],
    ]);
    const ev = reports.flatMap((r) => (r.type === "kifu-events" ? r.events : []));
    expect(ev.map((e) => [e[1], e[2], e[3]])).toEqual([
      ["out", "card_submit", ["~id", 3]],
      ["in", "card_submit_player", [3, true, true, false]],
    ]);
  });

  it("result：onAny 被官方 off() 拆掉也記得到，而且只記一次；連線關了就收尾", async () => {
    const { m, back, run, reports, startMatch } = setup();
    run(buildKifuPatchScript({ bindingName: BINDING }));
    await startMatch();
    back.children.list = [
      { type: "Image", texture: { key: "life_base" }, frame: { name: "__BASE" } },
      {
        type: "Text",
        texture: { key: "6b9c6dc4-3cd9-44b5-8d56-4fa390f19cd2" },
        style: { fontFamily: "font_heavy" },
      },
      {
        type: "Container",
        list: [{ type: "Image", texture: { key: "ActionCardImages" }, frame: { name: "__BASE" } }],
      },
      { type: "Image", texture: { key: "__DEFAULT" } },
    ];
    await settle();
    await vi.advanceTimersByTimeAsync(2100);
    await (Object.getPrototypeOf(m) as MainAProto).game_result.call(m, {
      code: 0,
      result: { win: "A" },
    });
    await settle();

    const ev = reports.flatMap((r) => (r.type === "kifu-events" ? r.events : []));
    expect(ev.filter((e) => e[2] === "result")).toEqual([
      [expect.any(Number), "in", "result", [{ code: 0, result: { win: "A" } }]],
    ]);
    expect(ev.filter((e) => e[2] === "leaveRoom").map((e) => e[3])).toEqual([["~id"]]);
    expect(m.results).toHaveLength(1);

    const end = reports.find((r) => r.type === "kifu-end");
    if (end?.type !== "kifu-end") throw new Error("no end");
    expect(end.reason).toBe("socket-closed");
    expect(end.textures).toEqual(["ActionCardImages", "life_base"]);
    expect(end.frames).toEqual({ ActionCardImages: ["__BASE"], life_base: ["__BASE"] });
    expect(end.fonts).toEqual(["font_heavy"]);
    const seqs = reports
      .filter((r) => r.type === "kifu-events")
      .map((r) => (r.type === "kifu-events" ? r.seq : -1));
    expect(end.lastSeq).toBe(Math.max(...seqs));
    expect(parseKifuStatus(run(KIFU_STATUS_EXPRESSION)).recording).toBeNull();
  });

  it("中途才接上：走輪詢、標 partial", async () => {
    const { m, run, reports } = setup();
    // 先開打，再裝
    m.sys.settings.status = 1;
    await proto.init.call(m, { side: "A", room_config: roomConfig() });
    m.sys.settings.status = 5;
    m.turn_text.text = "7";
    run(buildKifuPatchScript({ bindingName: BINDING }));
    await settle();
    const start = reports.find((r) => r.type === "kifu-start");
    if (start?.type !== "kifu-start") throw new Error("no start");
    expect(start.meta.partial).toBe(true);
    expect(start.meta.attachTurn).toBe(7);
  });

  it("換一場：舊的收尾、新的另開一份", async () => {
    const { run, reports, startMatch } = setup();
    run(buildKifuPatchScript({ bindingName: BINDING }));
    await startMatch();
    await settle();
    const first = parseKifuStatus(run(KIFU_STATUS_EXPRESSION)).recording;
    await startMatch();
    await settle();
    const second = parseKifuStatus(run(KIFU_STATUS_EXPRESSION)).recording;
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(reports.filter((r) => r.type === "kifu-start")).toHaveLength(2);
    expect(reports.find((r) => r.type === "kifu-end" && r.key === first)).toBeDefined();
  });

  it("重裝不疊兩層；拆掉還原原型、拆監聽", async () => {
    const { m, run, startMatch } = setup();
    run(buildKifuPatchScript({ bindingName: BINDING }));
    run(buildKifuPatchScript({ bindingName: BINDING }));
    await startMatch();
    await settle();
    expect(m.socket!.any).toHaveLength(1);
    expect(run(KIFU_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(m.socket!.any).toHaveLength(0);
    expect(Object.prototype.hasOwnProperty.call(m.socket, "emit")).toBe(false);
    expect(Object.getPrototypeOf(m).init).toBe(proto.init);
    expect(Object.getPrototypeOf(m).game_result).toBe(proto.game_result);
    expect(run(KIFU_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });

  it("isIdLike：房號、長英數字串是 id；中文、短標籤不是", () => {
    expect(isIdLike(ROOM, null)).toBe(true);
    expect(isIdLike("abc", "abc")).toBe(true);
    expect(isIdLike("front", null)).toBe(false);
    expect(isIdLike("cc052_sk04_opponent", null)).toBe(false);
    expect(isIdLike("利恩，來切磋一下吧。來切磋一下吧。來切磋", null)).toBe(false);
  });
});

describe("id 判斷", () => {
  it("技能／特效名再長也不是 id（帶底線）", () => {
    expect(isIdLike("cc012_sk03_ex_a_1_long_name", null)).toBe(false);
    expect(isIdLike("6b9c6dc4-3cd9-44b5-8d56-4fa390f19cd2", null)).toBe(true);
    expect(isIdLike("abcdefghijklmnopqrstuvwxyz", null)).toBe(false);
  });
});

describe("貼圖匯出", () => {
  /** 假 Phaser 貼圖：一個 source、幾格 */
  function texture(w: number, h: number, frames: Record<string, [number, number, number, number]>) {
    const f: Record<string, unknown> = {};
    for (const [name, [x, y, fw, fh]] of Object.entries(frames)) {
      f[name] = {
        sourceIndex: 0,
        cutX: x,
        cutY: y,
        cutWidth: fw,
        cutHeight: fh,
        x: 0,
        y: 0,
        realWidth: fw,
        realHeight: fh,
        rotated: false,
      };
    }
    return {
      source: [{ width: w, height: h, image: { tag: "img" } }],
      frames: f,
      getFrameNames: () => Object.keys(f),
    };
  }
  function run(expr: string, textures: Record<string, unknown>) {
    const drawn: number[][] = [];
    const document = {
      createElement: () => {
        const c = { width: 0, height: 0 } as {
          width: number;
          height: number;
          getContext: () => unknown;
          toDataURL: (t: string, q: number) => string;
        };
        c.getContext = () => ({ drawImage: (_i: unknown, ...a: number[]) => drawn.push(a) });
        c.toDataURL = (t, q) => `data:${t};q=${q};${c.width}x${c.height}`;
        return c;
      },
    };
    const window = {
      game: {
        textures: { exists: (k: string) => k in textures, get: (k: string) => textures[k] },
        cache: {
          bitmapFont: {
            get: (k: string) => (k === "statenum_1" ? { data: { lineHeight: 9 } } : undefined),
          },
        },
      },
    };
    const out = // eslint-disable-next-line no-new-func
      (new Function("window", "document", `return ${expr};`) as (w: unknown, d: unknown) => string)(
        window,
        document,
      );
    return { out: JSON.parse(out) as KifuTextureInfoT[], drawn };
  }
  type KifuTextureInfoT = {
    key: string;
    sources: string[];
    frames: Record<string, number[]>;
    partial?: boolean;
    bitmapFont?: unknown;
  };

  it("小圖整張匯出成無損 WebP，連 __BASE 一起列；點陣字帶字形", () => {
    const { out } = run(buildKifuTextureInfoExpression(["statenum_1"]), {
      statenum_1: texture(102, 9, { __BASE: [0, 0, 102, 9], a: [0, 0, 10, 9] }),
    });
    expect(out[0]!.sources).toEqual(["data:image/webp;q=1;102x9"]);
    expect(Object.keys(out[0]!.frames)).toEqual(["__BASE", "a"]);
    expect(out[0]!.bitmapFont).toEqual({ lineHeight: 9 });
    expect(out[0]!.partial).toBeUndefined();
  });

  it("巨型圖集只切出用到的格，每格一張、切法指向那張的整張", () => {
    const big = texture(2048, 2048, {
      __BASE: [0, 0, 2048, 2048],
      hair: [100, 200, 30, 40],
      eye: [0, 0, 5, 5],
      unused: [9, 9, 9, 9],
    });
    const { out, drawn } = run(
      buildKifuTextureInfoExpression(["AvatarPartsImages", "gone"], {
        AvatarPartsImages: ["hair", "eye"],
      }),
      {
        AvatarPartsImages: big,
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.partial).toBe(true);
    expect(out[0]!.sources).toEqual(["data:image/webp;q=1;30x40", "data:image/webp;q=1;5x5"]);
    expect(out[0]!.frames).toEqual({
      hair: [0, 0, 0, 30, 40, 0, 0, 30, 40, 0],
      eye: [1, 0, 0, 5, 5, 0, 0, 5, 5, 0],
    });
    expect(drawn[0]).toEqual([100, 200, 30, 40, 0, 0, 30, 40]);
  });
});
