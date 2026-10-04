/**
 * SUPPORT 公開清單與自己公開：看連線類別的回應，不管是誰問的。
 *
 * - 只交「插件包上之後、1 分鐘內收到」的 db_raid_support 回應（2026-10-03 事故：桌面版很早以前
 *   開過 SUPPORT，那份陣列一直留著，換上新版插件後被當新渦傳上去）
 * - SUPPORT 鈕、Moon/打渦.py 在渦房裡直接 fetch、腳本自己開的新連線，都抓得到
 * - 渦碼不出頁面
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_BINDING_NAME } from "../src/adapter.js";
import {
  parseRaidPublishedSnapshot,
  parseRaidSupportSnapshot,
  RAID_PUBLISHED_KEEP_MS,
  RAID_PUBLISHED_SNAPSHOT_EXPRESSION,
  RAID_SUPPORT_MAX_AGE_MS,
  RAID_SUPPORT_REPORT_BINDING,
  RAID_SUPPORT_SNAPSHOT_EXPRESSION,
} from "../src/raid-support.js";

const ROW = (over: Record<string, unknown> = {}) => ({
  profound_code: "ABCDEFGHIJKL",
  raid_name: "屠殺者",
  monster_id: 30114,
  founder_name: "燈皇",
  hp: 284,
  hp_max: 1200,
  limit: 1_791_051_388_126,
  profound_date: 1_791_029_788_126,
  member_length: 33,
  member_limit: 100,
  ...over,
});

/** 2026-10-03 實機讀的 CharaCards（節錄）。 */
const CHARA_CARDS = [
  { id: 30114, chara: "mc1006_02" },
  { id: 30113, chara: "mc1006_03" },
  { id: 30130, chara: "mc1012_02" },
];

/**
 * 照實機的形狀（2026-10-03 讀的原始碼）：
 *   fetch(t, ...e) { return new Promise(s => { this.once(t, (...t) => s(t.length < 2 ? t[0] : t)); this.emit(t, ...e); }); }
 * 伺服器的回應用同名事件回來。
 */
function setup(supportRows: unknown[]) {
  const sent: unknown[][] = [];
  class Sock {
    #listeners = new Map<string, (...a: unknown[]) => void>();
    emit(ev: string, ...args: unknown[]): void {
      sent.push([ev, ...args]);
      if (ev === "db_raid_support") {
        queueMicrotask(() => {
          const cb = this.#listeners.get(ev);
          this.#listeners.delete(ev);
          cb?.(supportRows);
        });
      }
    }
    once(ev: string, cb: (...a: unknown[]) => void): void {
      this.#listeners.set(ev, cb);
    }
    fetch(ev: string, ...args: unknown[]): Promise<unknown> {
      return new Promise((resolve) => {
        this.once(ev, (...t: unknown[]) => resolve(t.length < 2 ? t[0] : t));
        this.emit(ev, ...args);
      });
    }
  }
  class RaidScene {
    raid_support: unknown = undefined;
    raid_list: Record<string, unknown>[] = [];
    socket = new Sock();
    async create_raid_support(): Promise<void> {
      this.raid_support = await this.socket.fetch("db_raid_support");
    }
  }
  const raid = new RaidScene();
  const reports: unknown[] = [];
  const window = {
    game: {
      scene: { keys: { Raid: raid } },
      cache: { json: { get: (k: string) => (k === "CharaCards" ? CHARA_CARDS : null) } },
    },
    [RAID_SUPPORT_REPORT_BINDING]: (json: string) => reports.push(JSON.parse(json)),
  } as Record<string, unknown>;
  const evaluate = (expr: string) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", `return ${expr};`) as (w: unknown) => string;
    return fn(window);
  };
  return {
    raid,
    Sock,
    sent,
    reports,
    read: () => evaluate(RAID_SUPPORT_SNAPSHOT_EXPRESSION),
    readPublished: () => evaluate(RAID_PUBLISHED_SNAPSHOT_EXPRESSION),
  };
}

const EXPECTED = {
  founder: "燈皇",
  foundAt: 1_791_029_788_126,
  limit: 1_791_051_388_126,
  name: "屠殺者",
  monsterId: 30114,
  mons: "mc1006_02",
  hp: 284,
  hpMax: 1200,
  memberLength: 33,
  memberLimit: 100,
};

describe("RAID_SUPPORT_SNAPSHOT_EXPRESSION", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_791_030_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("插件包上之前收到的（可能放了很久）不交", async () => {
    const { raid, read } = setup([ROW()]);
    await raid.create_raid_support();
    expect(parseRaidSupportSnapshot(read())).toEqual([]);
  });

  it("SUPPORT 鈕拿到的：交出來、渦碼不出頁面、當下叫托盤", async () => {
    const { raid, read, reports } = setup([ROW()]);
    read(); // 包上
    await raid.create_raid_support();
    expect(reports).toEqual([{ type: "raid-stage" }]);
    const out = read();
    expect(out).not.toContain("ABCDEFGHIJKL");
    expect(parseRaidSupportSnapshot(out)).toEqual([EXPECTED]);
  });

  it("打渦腳本在渦房裡直接 R.socket.fetch 的也抓得到", async () => {
    const { raid, read } = setup([ROW()]);
    read();
    await raid.socket.fetch("db_raid_support");
    expect(parseRaidSupportSnapshot(read())).toEqual([EXPECTED]);
  });

  it("打渦腳本自己開的新連線（同一個類別）也抓得到", async () => {
    const { Sock, read } = setup([ROW()]);
    read();
    const so = new Sock();
    await so.fetch("db_raid_support");
    expect(parseRaidSupportSnapshot(read())).toEqual([EXPECTED]);
  });

  it("問的人照樣拿到回應（只是順手記一份）", async () => {
    const { raid, read } = setup([ROW()]);
    read();
    const rows = (await raid.socket.fetch("db_raid_support")) as unknown[];
    expect(rows).toEqual([ROW()]);
  });

  it("收到超過 1 分鐘就不交", async () => {
    const { raid, read } = setup([ROW()]);
    read();
    await raid.create_raid_support();
    vi.advanceTimersByTime(RAID_SUPPORT_MAX_AGE_MS);
    expect(parseRaidSupportSnapshot(read())).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(parseRaidSupportSnapshot(read())).toEqual([]);
  });

  it("只包一次", () => {
    const { raid, read } = setup([]);
    read();
    const proto = Object.getPrototypeOf(raid.socket) as { once: unknown; emit: unknown };
    const once = proto.once;
    const emit = (raid.socket as unknown as { emit: unknown }).emit;
    read();
    expect(proto.once).toBe(once);
    expect((raid.socket as unknown as { emit: unknown }).emit).toBe(emit);
  });

  it("原型的 emit 不包（patch-ok 會把包在上面的那層存走、繞成環）", () => {
    const { raid, Sock, read } = setup([]);
    const before = Sock.prototype.emit;
    read();
    expect(Sock.prototype.emit).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(raid.socket, "emit")).toBe(true);
  });

  it("2026-10-04 事故：跟 patch-ok 的 arm() 輪流跑，emit 照樣送得出去", async () => {
    const { raid, Sock, read, sent } = setup([ROW()]);
    // patch-ok 的 arm()：原型上不是自己那支，就把當下那支存成 original 再換回自己
    const P = Sock.prototype as unknown as { emit: (...a: unknown[]) => unknown };
    let original: ((...a: unknown[]) => unknown) | null = null;
    const patchedEmit = function (this: unknown, ...a: unknown[]) {
      return original!.apply(this, a);
    };
    const arm = () => {
      if (P.emit !== patchedEmit) {
        original = P.emit;
        P.emit = patchedEmit;
      }
    };
    for (let i = 0; i < 5; i++) {
      arm();
      read();
    }
    await expect(raid.socket.fetch("db_raid_support")).resolves.toEqual([ROW()]);
    expect(sent).toEqual([["db_raid_support"]]);
  });

  it("舊版包在原型上的 emit 拆掉", () => {
    const { Sock, read } = setup([]);
    const P = Sock.prototype as unknown as { emit: unknown };
    const orig = P.emit;
    const old = function () {};
    (old as unknown as { __ulrFeedEmit: unknown }).__ulrFeedEmit = orig;
    P.emit = old;
    read();
    expect(P.emit).toBe(orig);
  });

  it("沒有渦房場景、或從沒問過 SUPPORT：空的", () => {
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", `return ${RAID_SUPPORT_SNAPSHOT_EXPRESSION};`) as (
      w: unknown,
    ) => string;
    expect(parseRaidSupportSnapshot(fn({ game: { scene: { keys: {} } } }))).toEqual([]);
    const { read } = setup([]);
    expect(parseRaidSupportSnapshot(read())).toEqual([]);
  });

  it("binding 名稱跟 adapter 掛的同一個", () => {
    expect(RAID_SUPPORT_REPORT_BINDING).toBe(REPORT_BINDING_NAME);
  });
});

describe("自己按送出公開（raid_code_send）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_791_030_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const OWN = (over: Record<string, unknown> = {}) => ({
    profound_id: "p1",
    code: "ABCDEFGHIJKL",
    founder: "燈皇",
    found_at: 1_791_029_788_126,
    limit: 1_791_051_388_126,
    name: "爬行者",
    monster_id: 30113,
    hp: 3000,
    hp_max: 3000,
    rarity: 1,
    level: 1,
    map_index: 4,
    only_friend: false,
    ...over,
  });

  it("參加資格「無限制」：記下來、叫托盤，官方的 emit 照送；渦碼不出頁面", () => {
    const { raid, read, readPublished, reports, sent } = setup([]);
    raid.raid_list = [OWN()];
    read(); // 包上
    raid.socket.emit("raid_code_send", "p1");
    expect(sent).toEqual([["raid_code_send", "p1"]]);
    expect(reports).toEqual([{ type: "raid-stage" }]);
    const out = readPublished();
    expect(out).not.toContain("ABCDEFGHIJKL");
    expect(parseRaidPublishedSnapshot(out)).toEqual([
      {
        founder: "燈皇",
        foundAt: 1_791_029_788_126,
        limit: 1_791_051_388_126,
        name: "爬行者",
        monsterId: 30113,
        mons: "mc1006_03",
        hp: 3000,
        hpMax: 3000,
        rarity: 1,
        level: 1,
        mapIndex: 4,
        at: 1_791_030_000_000,
      },
    ]);
  });

  it("連線身上另有一份 emit（被別的 patch 包過）：兩層都看到同一次送出也只記一次", () => {
    const { raid, read, readPublished, sent } = setup([]);
    raid.raid_list = [OWN()];
    const protoEmit = Object.getPrototypeOf(raid.socket).emit as (...a: unknown[]) => void;
    // 別的 patch 在包之前就把原型的 emit 抓下來包在連線身上
    (raid.socket as unknown as { emit: unknown }).emit = function (this: unknown, ...a: unknown[]) {
      return protoEmit.apply(this, a);
    };
    read();
    raid.socket.emit("raid_code_send", "p1");
    expect(sent).toHaveLength(1);
    expect(parseRaidPublishedSnapshot(readPublished())).toHaveLength(1);
  });

  it("之後進渦房開的新連線：下一拍包上就看得到", () => {
    const { raid, Sock, read, readPublished } = setup([]);
    raid.raid_list = [OWN()];
    read();
    raid.socket = new Sock();
    read(); // raid-view 的下一拍
    raid.socket.emit("raid_code_send", "p1");
    expect(parseRaidPublishedSnapshot(readPublished())).toHaveLength(1);
  });

  it("僅限好友：不記、不叫托盤", () => {
    const { raid, read, readPublished, reports, sent } = setup([]);
    raid.raid_list = [OWN({ only_friend: true })];
    read();
    raid.socket.emit("raid_code_send", "p1");
    expect(sent).toHaveLength(1);
    expect(reports).toEqual([]);
    expect(parseRaidPublishedSnapshot(readPublished())).toEqual([]);
  });

  it("其他事件照送、不記", () => {
    const { raid, read, readPublished, sent } = setup([]);
    raid.raid_list = [OWN()];
    read();
    raid.socket.emit("db_raid");
    expect(sent).toEqual([["db_raid"]]);
    expect(parseRaidPublishedSnapshot(readPublished())).toEqual([]);
  });

  it("十分鐘後丟掉", () => {
    const { raid, read, readPublished } = setup([]);
    raid.raid_list = [OWN()];
    read();
    raid.socket.emit("raid_code_send", "p1");
    vi.advanceTimersByTime(RAID_PUBLISHED_KEEP_MS);
    expect(parseRaidPublishedSnapshot(readPublished())).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(parseRaidPublishedSnapshot(readPublished())).toEqual([]);
  });
});
