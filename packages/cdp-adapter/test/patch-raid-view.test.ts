/**
 * 渦房的獎勵標記（2026-09-23 改版後）
 *
 * 搭一個夠像的假渦房，把 `buildRaidViewPatchScript()` 產出來的**那一串字**
 * 原封不動 `new Function` 起來跑。假環境照 2026-09-25 從跑著的客戶端讀的形狀：
 *
 * ```js
 *   Raid.raid_list[i]           = { name, level, rarity, monster_id, map_index, category,
 *                                   founder, profound_id, player_point, player_rank, reward, … }
 *   Raid.raid_list_displayed[t] = { raid_name: Text, limit_text: Text, found_at, limit, … }
 *   Raid.raid_vortex[i]         = { base: Sprite(vortex_*_base), icon, id }
 *   Raid.prototype.create_raid_detail(row) → raid_detail_name …；destroy_raid_detail 收掉
 *   Raid.raid_owned             = Profound 計數（右下對齊的大數字）
 *   socket.fetch(ev, …args)     = once(ev) + emit(ev)
 * ```
 *
 * 要抓的坑：
 *
 * 1. 頁面算的渦鍵要跟 TS 的 raidRewardKey 一樣（不然學到了也畫不出來）
 * 2. 旗標記在 GameObject 上：清單／地圖重建（新的物件）要重掛，舊的收掉
 * 3. 還沒學到的渦什麼都不畫；學到的表推下來下一輪就畫
 * 4. 結算（raid-reward 記的 raw）要對回清單列才回報；同一個渦只學一次；不含玩家名字
 * 5. 更新鈕：照重進渦房送（db_player_ap、db_raid、官方 show_raid_reward），不送 ap_recover
 * 6. 重裝先拆再裝；拆掉時詳細面板的包裝要拆
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRaidViewPatchScript,
  buildRaidViewSetAutoDeleteExpression,
  buildRaidViewSetLearnedExpression,
  buildRaidViewSetPublicExpression,
  isRaidLearnReport,
  mergeLearned,
  parseRaidViewSnapshot,
  parseRaidViewStatus,
  RAID_CODE_NO_REPLY_KEY,
  RAID_LEARN_GIVE_UP_MS,
  RAID_VIEW_LABELS,
  RAID_VIEW_SNAPSHOT_EXPRESSION,
  parseRaidViewSnapshotListed,
  parseRaidSupportSnapshot,
  RAID_SUPPORT_SNAPSHOT_EXPRESSION,
  RAID_UNKNOWN_TINT,
  RAID_VIEW_SCRIPT_VERSION,
  RAID_VIEW_STATUS_EXPRESSION,
  RAID_VIEW_UNINSTALL_EXPRESSION,
  type RaidFragment,
  type RaidLearnedTable,
  type RaidLearnSample,
} from "@ulr/cdp-adapter";

type Handler = (...args: unknown[]) => void;

class Obj {
  scene: Raid | null;
  visible = true;
  depth = 0;
  alpha = 1;
  scaleX = 1;
  width = 40;
  height = 12;
  displayHeight = 40;
  text = "";
  texture: { key: string };
  frame: { name: string | number };
  tintFill: number | null = null;
  tint: number | null = null;
  played: string | null = null;
  anims: { stop: () => void } | undefined;
  crop: unknown[] | null = null;
  handlers = new Map<string, Handler[]>();
  input: { enabled: boolean } | null = null;
  constructor(
    scene: Raid,
    public kind: string,
    public x: number,
    public y: number,
    key = "",
    frame: string | number = 0,
  ) {
    this.scene = scene;
    this.texture = { key };
    this.frame = { name: frame };
  }
  destroy(): void {
    this.scene = null;
  }
  on(name: string, fn: Handler): this {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return this;
  }
  emit(name: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(name) ?? [])]) h(...args);
  }
  listeners(name: string): Handler[] {
    return [...(this.handlers.get(name) ?? [])];
  }
  off(name: string, fn: Handler): this {
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((h) => h !== fn),
    );
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setScale(s: number): this {
    this.scaleX = s;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setStroke(): this {
    return this;
  }
  setStrokeStyle(): this {
    return this;
  }
  setColor(): this {
    return this;
  }
  setText(t: string | number): this {
    this.text = String(t);
    if (this.kind === "text") this.width = this.text.length * 6;
    return this;
  }
  setDisplaySize(): this {
    return this;
  }
  setFlipX(): this {
    return this;
  }
  disableInteractive(): this {
    this.input = null;
    return this;
  }
  setInteractive(): this {
    this.input = { enabled: true };
    return this;
  }
  setTexture(key: string, frame?: string | number): this {
    this.texture = { key };
    this.frame = { name: frame ?? 0 };
    return this;
  }
  setTintFill(c: number): this {
    this.tintFill = c;
    return this;
  }
  setTint(c: number): this {
    this.tint = c;
    return this;
  }
  clearTint(): this {
    this.tintFill = null;
    this.tint = null;
    return this;
  }
  play(key: string): this {
    this.played = key;
    return this;
  }
  setCrop(...a: unknown[]): this {
    this.crop = a;
    return this;
  }
}

interface Row {
  name: string;
  level: number;
  rarity: number;
  monster_id: number;
  map_index: number;
  category: string;
  founder: string;
  profound_id: string;
  /** 渦碼。改版後只有發現者看得到，別人開的是 null */
  code: string | null;
  hp: number;
  hp_max: number;
  limit: number;
  found_at: number;
  player_point: number;
  player_rank: number;
  /** 榜（照分數排好），名字是「Lv.92 名字」 */
  rank?: { player_name: string; point: number; level: number }[];
  /** 一回合幾 AP */
  ap: number;
  reward: { type: number; id: number; slot: number; value: number }[];
}

const ROW = (over: Partial<Row> = {}): Row => ({
  name: "龍鯰",
  level: 1,
  rarity: 1,
  monster_id: 30130,
  map_index: 5,
  category: "another",
  founder: "Owlic",
  profound_id: "p-1",
  code: null,
  hp: 692,
  hp_max: 1200,
  limit: 1790328501134,
  found_at: 1790306901134,
  player_point: 289,
  player_rank: 15,
  ap: 1,
  reward: [{ type: 3, id: 2, slot: 0, value: 2 }],
  ...over,
});

class Raid {
  status = 5;
  scene = { isActive: () => this.status === 5, isSleeping: () => false };
  player = { player_name: "燈皇" };
  raid_list: Row[] = [];
  list_page_now = 1;
  raid_list_displayed: {
    raid_name: Obj;
    limit_text: Obj;
    code: string | null;
    found_at: number;
    limit: number;
    select: Obj | null;
  }[] = [];
  raid_vortex: { base: Obj; icon: Obj; id: string }[] = [];
  /** SUPPORT 的原始列與畫面列（2026-10-04 實機的形狀） */
  raid_support: {
    profound_code: string;
    founder_name: string;
    limit: number;
    raid_name: string;
  }[] = [];
  raid_support_list: Record<string, unknown>[] = [];
  raid_list_bg: Obj | null;
  raid_owned: Obj;
  raid_detail_name: Obj | null = null;
  raid_detail_give_up: Obj | null = null;
  raid_detail_point_label: Obj | null = null;
  raid_detail_point_text: Obj | null = null;
  /** 官方把 player_rank 原樣畫上去 */
  raid_detail_ranking_text: Obj | null = null;
  /** 官方 refresh_raid_ranking 畫的排行榜（名字是「Lv.92 名字」） */
  raid_detail_ranking: { rank: Obj; player_name: Obj; point: Obj }[] = [];
  reward_zone: Obj | null = null;
  __ulrRaidDetailRow?: Row;
  __ulrRaidStartId?: string;
  __ulrRaidRewardBatch?: unknown;
  made: Obj[] = [];
  /** 下一次 db_raid／db_player_ap 回什麼 */
  next: Row[] = [];
  nextAp: unknown = { ap: 20, ap_max: 31, recover_at: "2026-09-25T04:14:36.000Z" };
  sent: unknown[][] = [];
  calls: string[] = [];
  reg = new Map<string, unknown>();
  registry = {
    set: (k: string, v: unknown) => void this.reg.set(k, v),
    get: (k: string) => this.reg.get(k),
  };
  player_ap: unknown = null;
  ap_value_text: Obj;
  ap_max_text: Obj;
  ap_fill_image: Obj;
  ap_recover_timer: { remove: () => void } | null = null;
  time = { delayedCall: () => ({ remove() {} }) };
  socket = {
    fetch: (ev: string, ...a: unknown[]): Promise<unknown> => {
      this.sent.push([ev, ...a]);
      if (ev === "db_raid") return Promise.resolve(this.next);
      if (ev === "db_player_ap") return Promise.resolve(this.nextAp);
      return Promise.resolve(true);
    },
    emit: (ev: string, ...a: unknown[]) => void this.sent.push(["emit:" + ev, ...a]),
  };
  add = {
    image: (x: number, y: number, key: string, frame?: string | number) =>
      this.make("image", x, y, key, frame),
    text: (x: number, y: number, text: string) => {
      const o = this.make("text", x, y);
      o.text = text;
      o.width = text.length * 6;
      return o;
    },
    zone: (x: number, y: number) => this.make("zone", x, y),
  };
  rexUI = { add: { roundRectangle: (x: number, y: number) => this.make("rect", x, y) } };

  constructor() {
    this.raid_list_bg = this.make("image", 0, 32, "raid_list_panel");
    this.raid_owned = this.make("text", 477, 530);
    this.ap_value_text = this.make("text", 701, 643);
    this.ap_max_text = this.make("text", 709, 643);
    this.ap_fill_image = this.make("image", 705, 646);
  }
  make(kind: string, x: number, y: number, key = "", frame: string | number = 0): Obj {
    const o = new Obj(this, kind, x, y, key, frame);
    this.made.push(o);
    return o;
  }
  alive(): Obj[] {
    return this.made.filter((o) => o.scene !== null);
  }
  sort_raid_list(): void {
    this.calls.push("sort");
  }
  /** 官方：第 t 列是 raid_list[5*(page-1)+t]，整批重建。 */
  refresh_raid_list(): void {
    this.calls.push("list");
    for (const d of this.raid_list_displayed) {
      d.raid_name.destroy();
      d.limit_text.destroy();
    }
    this.raid_list_displayed = [];
    for (let t = 0; t < 5; t++) {
      const s = this.raid_list[5 * (this.list_page_now - 1) + t];
      if (s === undefined) continue;
      const name = this.add.text(12, 49 + 16 * t, `Lv.${s.level} ${s.name}`).setDepth(1.1);
      const limit = this.add.text(246, 49 + 16 * t, "5:35:12");
      this.raid_list_displayed[t] = {
        raid_name: name,
        limit_text: limit,
        code: s.code,
        found_at: s.found_at,
        limit: s.limit,
        select: null,
      };
    }
  }
  show_vortex(): void {
    this.calls.push("vortex");
    for (const v of this.raid_vortex) {
      v.base.destroy();
      v.icon.destroy();
    }
    this.raid_vortex = this.raid_list.map((s, e) => {
      const base = this.make("sprite", 300 + e * 40, 200, `vortex_${s.category}_base`, 0);
      // 官方：拿 code 找清單列 —— 別人的渦 code 是 null，會對到第一個 null 的列
      base.on("pointerover", () => {
        const t = this.raid_list_displayed.findIndex(({ code }) => code === s.code);
        if (t !== -1 && this.raid_list_displayed[t]!.select === null)
          this.raid_list_displayed[t]!.select = this.make("rect", 7.5, 39.5 + 16 * t);
      });
      base.on("pointerout", () => {
        const t = this.raid_list_displayed.findIndex(({ code }) => code === s.code);
        if (t !== -1 && this.raid_list_displayed[t]!.select !== null) {
          this.raid_list_displayed[t]!.select!.destroy();
          this.raid_list_displayed[t]!.select = null;
        }
      });
      return {
        base: base.setDepth(0.2),
        icon: this.vortexIcon(300 + e * 40, s),
        id: s.profound_id,
      };
    });
  }
  /** 活著的渦是會動的 sprite；死渦是 _expired 的 image（沒有 anims）。 */
  vortexIcon(x: number, s: Row): Obj {
    if (s.hp < 1) return this.make("image", x, 200, `vortex_${s.category}_expired`).setDepth(0.2);
    const o = this.make("sprite", x, 200, `vortex_${s.category}`, "1").setDepth(0.2);
    o.anims = { stop: () => void (o.played = null) };
    return o.play(`vortex_${s.category}`);
  }
  /** 官方點清單列：收掉清單、開詳細面板。 */
  openDetail(row: Row): void {
    this.raid_list_bg?.destroy();
    for (const d of this.raid_list_displayed) d.raid_name.destroy();
    this.create_raid_detail(row);
  }
  create_raid_detail(row: Row): void {
    this.calls.push("detail:" + row.profound_id);
    this.raid_detail_name = this.add.text(68, 49, `Lv.${row.level} ${row.name}`).setDepth(1);
    this.raid_detail_give_up = this.make("image", 10, 68);
    this.raid_detail_point_label = this.add.text(496, 67, "Points");
    this.raid_detail_point_text = this.add.text(456, 67, row.player_point.toLocaleString());
    this.raid_detail_ranking_text = this.add.text(387, 64, String(row.player_rank));
  }
  destroy_raid_detail(): void {
    this.calls.push("destroy_detail");
    this.raid_detail_name?.destroy();
    this.raid_detail_give_up?.destroy();
    this.raid_detail_point_label?.destroy();
    this.raid_detail_point_text?.destroy();
    this.raid_detail_ranking_text?.destroy();
  }
  destroy_raid_ranking(): void {}
  reset_avatar(): void {}
  create_raid_list(): void {
    this.calls.push("create_list");
  }
  /** 官方：點「START」開回合面板，按 OK 才 fetch("raid_start", row.profound_id…) */
  create_raid_start_panel(row: Row): void {
    this.calls.push("start_panel:" + row.profound_id);
  }
  show_raid_reward(): Promise<void> {
    this.calls.push("show_raid_reward");
    return Promise.resolve();
  }
  /** 官方 refresh_raid_support_list：名字欄 fixedWidth 96，列是普通物件。 */
  refresh_raid_support_list(): void {
    this.raid_support_list = this.raid_support.map((n, i) => {
      const name = this.add.text(123, 257 + 16 * i, n.raid_name).setDepth(101);
      name.width = 96;
      // 實際字寬：一個字 12px
      (name as unknown as Record<string, unknown>).style = { _font: "12px font_light" };
      (name as unknown as Record<string, unknown>).context = {
        save() {},
        restore() {},
        font: "",
        measureText: (t: string) => ({ width: t.length * 12 }),
      };
      return {
        raid_name: name,
        founder: this.add.text(323, 257 + 16 * i, n.founder_name),
        rect: null,
        profound_code: n.profound_code,
      };
    });
  }
  /** 官方 close_raid_support：列上有 destroy 的全部收掉 */
  close_raid_support(): void {
    for (const d of this.raid_support_list)
      for (const v of Object.values(d))
        if (v !== null && typeof (v as Obj).destroy === "function") (v as Obj).destroy();
    this.raid_support_list = [];
  }
}

const AVATAR_ITEMS = [
  { id: 2, name_tcn: "古代妙藥" },
  { id: 3, name_tcn: "魔女秘藥" },
];
const WEAPON_CARDS = [{ id: 5005, name_tcn: "魔之刀身" }];
/** 改版後碎片／渦幣是角色卡：chara 是 cmem_0..4／ccoin_0..4 */
const CHARA_CARDS = [
  { id: 900, chara: "cmem_0", kind: 2 },
  { id: 902, chara: "cmem_2", kind: 2 },
  { id: 910, chara: "ccoin_0", kind: 2 },
  // 打渦隊伍（2026-09-25 實機那副）
  { id: 350, chara: "cc035", filename: "cc035_r05", kind: 0, rarity: 10, level: 5 },
  { id: 330, chara: "cc033", filename: "cc033_r05", kind: 0, rarity: 10, level: 5 },
  { id: 110, chara: "cc011", filename: "cc011_r05", kind: 0, rarity: 10, level: 5 },
];
const CHARACTERS: Record<string, { name_tcn: string }> = {
  cmem_0: { name_tcn: "記憶的碎片" },
  cmem_2: { name_tcn: "靈魂的碎片" },
  ccoin_0: { name_tcn: "鐵幣" },
  cc035: { name_tcn: "伊芙莉" },
};
const EVENT_CARDS = [{ id: 31, name_tcn: "特殊5卡" }];

/** 假 canvas：ensureIcons／ensureGray 畫東西用，什麼都不必真的畫。 */
function fakeCanvas() {
  const ctx = {
    save() {},
    restore() {},
    translate() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    drawImage() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData() {},
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

class Textures {
  list: Record<string, Set<string>> = {
    AvatarItemImages: new Set(["item_2", "item_3"]),
    WeaponCardImages: new Set(["weapon_5005"]),
    raid_panel_ok: new Set(["0", "1"]),
    vortex_another: new Set(["0", "1", "2", "3", "4", "5", "6", "7"]),
  };
  canvases: string[] = [];
  createCanvas(k: string) {
    this.canvases.push(k);
    const frames = new Set<string>();
    this.list[k] = frames;
    return {
      getContext: () => fakeCanvas().getContext(),
      refresh() {},
      add: (name: string) => frames.add(name),
    };
  }
  addCanvas(k: string) {
    this.canvases.push(k);
    const frames = new Set<string>();
    this.list[k] = frames;
    return { add: (name: string) => frames.add(name) };
  }
  removed: string[] = [];
  exists(k: string): boolean {
    return this.list[k] !== undefined;
  }
  remove(k: string): void {
    this.removed.push(k);
    delete this.list[k];
  }
  get(k: string) {
    const t = this.list[k];
    return {
      key: t === undefined ? "__MISSING" : k,
      has: (f: string | number) => t !== undefined && t.has(String(f)),
      getSourceImage: () => ({ width: 32, height: 32 }),
      getFrameNames: () => (t === undefined ? [] : [...t]),
      get: () => ({ width: 48, height: 48, cutX: 0, cutY: 0, source: { image: {} } }),
    };
  }
}

class Game {
  scene: { keys: Record<string, unknown> };
  textures = new Textures();
  animsMade: string[] = [];
  anims = {
    exists: (k: string) => this.animsMade.includes(k),
    create: (cfg: { key: string }) => void this.animsMade.push(cfg.key),
    remove: (k: string) => void (this.animsMade = this.animsMade.filter((a) => a !== k)),
  };
  cache = {
    json: {
      get: (k: string): unknown =>
        ({
          AvatarItems: AVATAR_ITEMS,
          WeaponCards: WEAPON_CARDS,
          CharaCards: CHARA_CARDS,
          Characters: CHARACTERS,
          EventCards: EVENT_CARDS,
        })[k],
    },
  };
  constructor(public raid: Raid) {
    this.scene = { keys: { Raid: raid } };
  }
}

const BINDING = "__ulrCompanionReport";
let poll: (() => void) | null = null;

function run(window: Record<string, unknown>, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window",
    "document",
    "setInterval",
    "clearInterval",
    "lang",
    `return ${expression};`,
  ) as (...args: unknown[]) => string;
  return fn(
    window,
    { hidden: false, createElement: () => fakeCanvas() },
    (cb: () => void) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
    "tcn",
  );
}

function setup(rows: Row[]) {
  const raid = new Raid();
  raid.raid_list = rows;
  raid.refresh_raid_list();
  raid.show_vortex();
  raid.calls = [];
  const game = new Game(raid);
  const window: Record<string, unknown> = { game };
  const reports: { type: string; [k: string]: unknown }[] = [];
  window[BINDING] = (payload: string) => reports.push(JSON.parse(payload));
  return { raid, game, window, reports };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 學過的表：龍鯰 Lv1 ★1 區塊 5 → 1–10 名魔之刀身×2、11 名起×1。 */
function learned(over: Partial<RaidLearnSample> = {}): RaidLearnedTable {
  return mergeLearned(
    {},
    {
      profoundId: "old",
      name: "龍鯰",
      monsterId: 30130,
      level: 1,
      rarity: 1,
      mapIndex: 5,
      category: "another",
      founder: null,
      participate: [{ type: 3, id: 2, slot: 0, value: 2 }],
      defeat: null,
      ranks: [
        ...Array.from({ length: 10 }, () => [{ type: 2, id: 5005, slot: 0, value: 2 }]),
        ...Array.from({ length: 10 }, () => [{ type: 2, id: 5005, slot: 0, value: 1 }]),
      ],
      stage: null,
      at: 1000,
      ...over,
    },
  ).table;
}

const iconsOf = (raid: Raid) =>
  raid
    .alive()
    .filter((o) => o.texture.key === "WeaponCardImages" || o.texture.key === "AvatarItemImages");

afterEach(() => {
  poll = null;
  vi.restoreAllMocks();
});

describe("渦房的獎勵標記", () => {
  it("還沒學到的渦什麼都不畫；學到的表推下來，清單列名字右邊掛排名第一檔的圖", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
    expect(iconsOf(raid)).toEqual([]);
    expect(run(window, buildRaidViewSetLearnedExpression(learned()))).toBe("ok");
    poll?.();
    const icons = iconsOf(raid);
    // 清單一顆、地圖一顆
    expect(icons).toHaveLength(2);
    const name = raid.raid_list_displayed[0]!.raid_name;
    const onRow = icons.find((o) => o.y === name.y)!;
    expect(onRow.frame.name).toBe("weapon_5005");
    expect(onRow.x).toBeGreaterThan(name.x + name.width);
  });

  it("頁面算的渦鍵跟 TS 的一樣：區塊不同就是另一種渦", () => {
    const { raid, window } = setup([ROW({ map_index: 6 })]);
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    expect(iconsOf(raid)).toEqual([]);
  });

  it("清單重建（翻頁、重排）後舊的圖示收掉、新的列重掛", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    const before = iconsOf(raid).length;
    raid.refresh_raid_list();
    poll?.();
    expect(iconsOf(raid)).toHaveLength(before);
  });

  it("地圖：自己開的渦 base 紅框、上方掛圖；重建後重掛；拆掉清掉紅框", () => {
    const { raid, window } = setup([
      ROW({ founder: "燈皇" }),
      ROW({ profound_id: "p-2", map_index: 9 }),
    ]);
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    const [own, other] = raid.raid_vortex;
    expect(own!.base.tintFill).not.toBeNull();
    expect(other!.base.tintFill).toBeNull();
    const above = iconsOf(raid).filter((o) => o.y > 100 && o.y < own!.base.y);
    expect(above).toHaveLength(1);
    raid.show_vortex();
    poll?.();
    expect(raid.raid_vortex[0]!.base.tintFill).not.toBeNull();
    expect(iconsOf(raid).filter((o) => o.y > 100 && o.y < 200)).toHaveLength(1);
    expect(run(window, RAID_VIEW_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(raid.raid_vortex[0]!.base.tintFill).toBeNull();
    expect(iconsOf(raid)).toEqual([]);
  });

  it("詳細面板：開著才有「獎勵一覽」；點下去列出每一檔，自己那一檔亮；關掉就收", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    raid.openDetail(raid.raid_list[0]!);
    poll?.();
    const btn = raid.alive().find((o) => o.text === "獎勵一覽")!;
    expect(btn).toBeTruthy();
    btn.emit("pointerup");
    const texts = raid.alive().map((o) => o.text);
    expect(texts).toContain("1–10名");
    expect(texts).toContain("11名～");
    expect(texts).toContain("魔之刀身 x2");
    expect(texts).toContain("古代妙藥 x2");
    expect(texts).toContain("學自 1 次結算");
    // 發現／擊破這次看不到
    expect(texts.filter((t) => t === "?")).toHaveLength(2);
    raid.destroy_raid_detail();
    poll?.();
    expect(raid.alive().some((o) => o.text === "獎勵一覽")).toBe(false);
  });

  it("詳細面板：「Points」滑上去是分數公式，滑開就收；關面板也收", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({}));
    raid.openDetail(raid.raid_list[0]!);
    poll?.();
    const zone = raid.alive().find((o) => o.kind === "zone" && o.y === 67)!;
    expect(zone).toBeTruthy();
    const tipOf = () => raid.alive().find((o) => o.text.startsWith("角色完整活一回合 +500"));
    expect(tipOf()).toBeUndefined();
    zone.emit("pointerover");
    expect(tipOf()!.text).toContain("Exp 固定 50");
    // 滑上去之後下一輪不會把整組重建（tooltip 不算在要活著的那組裡）
    poll?.();
    expect(zone.scene).not.toBeNull();
    zone.emit("pointerout");
    expect(tipOf()).toBeUndefined();
    zone.emit("pointerover");
    raid.destroy_raid_detail();
    poll?.();
    expect(tipOf()).toBeUndefined();
    expect(zone.scene).toBeNull();
  });

  it("詳細面板：Rank 換成榜上算的（伺服器送 17、榜上排第 9）；榜上沒有自己就照官方", () => {
    const pts = [
      10693, 8094, 7986, 4991, 4892, 4699, 4217, 3907, 3103, 3085, 2499, 2001, 1507, 1502, 1008,
      1004, 900, 593,
    ];
    const rank = pts.map((point, i) => ({
      player_name: `Lv.${60 + i} ${i === 8 ? "燈皇" : "p" + i}`,
      point,
      level: 60 + i,
    }));
    const { raid, window } = setup([
      ROW({ player_rank: 17, player_point: 3103, rank }),
      ROW({ profound_id: "p-2", player_rank: 15, rank: rank.slice(0, 8) }),
    ]);
    run(window, buildRaidViewPatchScript({}));
    raid.openDetail(raid.raid_list[0]!);
    poll?.();
    expect(raid.raid_detail_ranking_text!.text).toBe("9");
    raid.destroy_raid_detail();
    raid.openDetail(raid.raid_list[1]!);
    poll?.();
    expect(raid.raid_detail_ranking_text!.text).toBe("15");
  });

  it("地圖：滑上別人的渦亮它自己那一列，不是第一列（官方拿 null 的 code 對）；拆掉換回官方的", () => {
    const { raid, window } = setup([
      ROW(),
      ROW({ profound_id: "p-2", found_at: 1790306902000, limit: 1790328502000 }),
      ROW({ profound_id: "p-3", code: "ABC", founder: "燈皇", found_at: 1, limit: 2 }),
    ]);
    const lit = () =>
      raid.raid_list_displayed.map((d) => d.select !== null && d.select.scene !== null);
    // 沒裝：滑第二個渦亮的是第一列
    raid.raid_vortex[1]!.base.emit("pointerover");
    expect(lit()).toEqual([true, false, false]);
    raid.raid_vortex[1]!.base.emit("pointerout");
    expect(lit()).toEqual([false, false, false]);

    run(window, buildRaidViewPatchScript({}));
    raid.raid_vortex[1]!.base.emit("pointerover");
    expect(lit()).toEqual([false, true, false]);
    raid.raid_vortex[1]!.base.emit("pointerout");
    expect(lit()).toEqual([false, false, false]);
    raid.raid_vortex[2]!.base.emit("pointerover");
    expect(lit()).toEqual([false, false, true]);
    raid.raid_vortex[2]!.base.emit("pointerout");
    // 清單物件沒被換掉
    expect(raid.raid_list_displayed).toHaveLength(3);
    // 重建的渦也修；只包一層
    raid.show_vortex();
    poll?.();
    poll?.();
    expect(raid.raid_vortex[1]!.base.listeners("pointerover")).toHaveLength(1);
    raid.raid_vortex[1]!.base.emit("pointerover");
    expect(lit()).toEqual([false, true, false]);
    raid.raid_vortex[1]!.base.emit("pointerout");

    expect(run(window, RAID_VIEW_UNINSTALL_EXPRESSION)).toBe("ok");
    raid.raid_vortex[1]!.base.emit("pointerover");
    expect(lit()).toEqual([true, false, false]);
  });

  it("還沒學到：面板寫一句話，參加獎勵照清單上官方給的列", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({}));
    raid.openDetail(raid.raid_list[0]!);
    poll?.();
    raid
      .alive()
      .find((o) => o.text === "獎勵一覽")!
      .emit("pointerup");
    const texts = raid.alive().map((o) => o.text);
    expect(texts.some((t) => t.startsWith("還沒學到"))).toBe(true);
    expect(texts).toContain("古代妙藥 x2");
  });

  describe("碎片色", () => {
    const fragsOf = (raid: Raid) =>
      raid
        .alive()
        .filter((o) => o.texture.key === "__ulrRaidIcons")
        .map((o) => String(o.frame.name));
    /** ulgg 表：別人的渦沒有渦碼，靠到期時刻＋發現者對 */
    const PUB = (over: Record<string, unknown> = {}) => ({
      X1: {
        tl: null,
        rarity: 1,
        stage: 1,
        mons: null,
        states: [],
        limit: 1790328501134,
        founder: "Owlic",
        ...over,
      },
    });

    it("ulgg 的 stage 用到期時刻＋發現者對上 → 清單接碎片色、漩渦換灰階上色；拆掉換回官方", () => {
      const { raid, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ publicMap: PUB() }));
      // 清單一顆、名字旁沒有（詳細面板沒開）：stage 1 ★1 → 記憶（黃）
      expect(fragsOf(raid)).toEqual(["frag_memory"]);
      const icon = raid.raid_vortex[0]!.icon;
      expect(icon.texture.key).toBe("__ulrVortexGray");
      expect(icon.played).toBe("__ulrVortexGray");
      expect(icon.tint).toBe(0xf5d33a);
      expect(icon.alpha).toBe(1);
      run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
      expect(icon.texture.key).toBe("vortex_another");
      expect(icon.played).toBe("vortex_another");
      expect(icon.tint).toBeNull();
    });

    it("★6 是 stage+1；發現者對不上就不算", () => {
      const a = setup([ROW({ rarity: 6 })]);
      run(a.window, buildRaidViewPatchScript({ publicMap: PUB({ rarity: 6, stage: 2 }) }));
      expect(fragsOf(a.raid)).toEqual(["frag_soul"]);
      // M1 不在龍鯰的區塊（M5–M9）裡，區塊也推不出來
      const b = setup([ROW({ founder: "別人", map_index: 1 })]);
      run(b.window, buildRaidViewPatchScript({ publicMap: PUB() }));
      expect(fragsOf(b.raid)).toEqual([]);
      // 不知道碎片的渦：換灰階、上灰色，不留官方的藍
      expect(b.raid.raid_vortex[0]!.icon.texture.key).toBe("__ulrVortexGray");
      expect(b.raid.raid_vortex[0]!.icon.tint).toBe(RAID_UNKNOWN_TINT);
    });

    it("公開渦通報只給碎片（還沒人看到 stage，ulrmap 查的）：清單照樣接、實心", () => {
      const { raid, window } = setup([ROW({ map_index: 1 })]);
      run(
        window,
        buildRaidViewPatchScript({
          publicMap: PUB({ stage: null, rarity: null, fragment: "soul" }),
        }),
      );
      expect(fragsOf(raid)).toEqual(["frag_soul"]);
    });

    describe("⑫ SUPPORT 公開清單", () => {
      const LIMIT = 1791101559621;
      const FEED = (fragment: RaidFragment | null) => ({
        "@Sasorix@1791101559621": {
          tl: null,
          rarity: 1,
          stage: null,
          mons: null,
          states: [],
          limit: LIMIT,
          founder: "Sasorix",
          fragment,
        },
      });
      function openSupport() {
        const s = setup([]);
        s.raid.raid_support = [
          { profound_code: "CODE-1", founder_name: "Sasorix", limit: LIMIT, raid_name: "靈龜" },
          { profound_code: "CODE-2", founder_name: "別人", limit: LIMIT + 1, raid_name: "龍鯰" },
        ];
        s.raid.refresh_raid_support_list();
        return s;
      }

      it("對得上公開渦表的列：名字的實際字寬後面接碎片色，掛在列上讓官方一起收", () => {
        const { raid, window } = openSupport();
        run(window, buildRaidViewPatchScript({ publicMap: FEED("soul") }));
        expect(fragsOf(raid)).toEqual(["frag_soul"]);
        const row = raid.raid_support_list[0]!;
        const icon = row.ulr_frag as Obj;
        // 「靈龜」24px，不是欄寬 96
        expect(icon.x).toBe(123 + 24 + 4);
        expect(icon.y).toBe(257);
        // 第二列不在表上：不畫
        expect(raid.raid_support_list[1]!.ulr_frag ?? null).toBeNull();
        // 官方關面板：列上的東西全部 destroy，碎片也跟著收
        raid.close_raid_support();
        expect(fragsOf(raid)).toEqual([]);
      });

      it("碎片晚到也補上；淡入時跟著名字的透明度與位置；拆掉收乾淨", () => {
        const { raid, window } = openSupport();
        run(window, buildRaidViewPatchScript({ publicMap: FEED(null) }));
        expect(fragsOf(raid)).toEqual([]);
        expect(run(window, buildRaidViewSetPublicExpression(FEED("life")))).toBe("ok");
        poll?.();
        expect(fragsOf(raid)).toEqual(["frag_life"]);
        const row = raid.raid_support_list[0]!;
        const name = row.raid_name as Obj;
        name.alpha = 0.3;
        name.y = 250;
        poll?.();
        expect((row.ulr_frag as Obj).alpha).toBe(0.3);
        expect((row.ulr_frag as Obj).y).toBe(250);
        run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
        expect(fragsOf(raid)).toEqual([]);
        expect("ulr_frag" in row).toBe(false);
      });
    });

    it("沒有 ulgg：學到的第一檔是碎片角色卡（cmem_2）→ 靈魂，畫空心、漩渦半透明；碎片對不上過才不畫", () => {
      // M1 不在龍鯰的區塊裡：排除照區塊推的那條
      const soul = learned({ mapIndex: 1, ranks: [[{ type: 1, id: 902, slot: 0, value: 2 }]] });
      const a = setup([ROW({ map_index: 1 })]);
      run(a.window, buildRaidViewPatchScript({ learned: soul }));
      expect(fragsOf(a.raid)).toEqual(["frag_soul_learned"]);
      const icon = a.raid.raid_vortex[0]!.icon;
      expect(icon.tint).toBe(0x3a8cff);
      expect(icon.alpha).toBe(0.5);
      run(a.window, RAID_VIEW_UNINSTALL_EXPRESSION);
      expect(icon.alpha).toBe(1);
      const key = Object.keys(soul)[0]!;
      const draw = (entry: Record<string, unknown>) => {
        const b = setup([ROW({ map_index: 1 })]);
        run(
          b.window,
          buildRaidViewPatchScript({
            learned: { [key]: { ...soul[key]!, ...entry } } as RaidLearnedTable,
          }),
        );
        return fragsOf(b.raid);
      };
      // 其他獎勵對不上不擋碎片
      expect(draw({ conflict: true, fragConflict: false })).toEqual(["frag_soul_learned"]);
      expect(draw({ conflict: true, fragConflict: true })).toEqual([]);
      // 舊托盤推下來的沒有 fragConflict：照 conflict
      expect(draw({ conflict: true, fragConflict: undefined })).toEqual([]);
    });

    it("什麼都沒有：照怪＋區塊推 stage（龍鯰 M6 → stage 2 → 時間），空心、面板註明是區塊推的", () => {
      const { raid, window } = setup([ROW({ map_index: 6 })]);
      run(window, buildRaidViewPatchScript({}));
      expect(fragsOf(raid)).toEqual(["frag_time_learned"]);
      expect(raid.raid_vortex[0]!.icon.tint).toBe(0x3ec95a);
      expect(raid.raid_vortex[0]!.icon.alpha).toBe(0.5);
      raid.openDetail(raid.raid_list[0]!);
      poll?.();
      raid
        .alive()
        .find((o) => o.text === "獎勵一覽")!
        .emit("pointerup");
      expect(raid.alive().some((o) => o.text === "時間的碎片  (由區塊推算（stage 2）)")).toBe(true);
      // ★6 多一格：stage 2 → 靈魂
      const b = setup([ROW({ map_index: 6, rarity: 6 })]);
      run(b.window, buildRaidViewPatchScript({}));
      expect(fragsOf(b.raid)).toEqual(["frag_soul_learned"]);
      // Lv2 沒證據：不推
      const c = setup([ROW({ map_index: 6, level: 2 })]);
      run(c.window, buildRaidViewPatchScript({}));
      expect(fragsOf(c.raid)).toEqual([]);
    });

    it("開打時戰鬥設定的 stage 記在那個渦上（BOSS 要對得上）；比 ulgg 優先", () => {
      const { raid, game, window } = setup([
        ROW(),
        ROW({ profound_id: "p-2", monster_id: 30114, limit: 1 }),
      ]);
      run(window, buildRaidViewPatchScript({ publicMap: PUB({ stage: 1 }) }));
      expect(fragsOf(raid)).toEqual(["frag_memory"]);
      // 點 START（官方開回合面板）→ 伺服器開打，戰鬥設定帶 stage
      raid.create_raid_start_panel(raid.raid_list[0]!);
      const room = (id: string, stage: string, boss: number) => ({
        room_config: {
          rule: "raid",
          room_id: id,
          stage,
          playerB_deck: { chara_card_id: [boss, null, null] },
        },
      });
      game.scene.keys.MainA = room("r1", "003", 30130);
      poll?.();
      expect(fragsOf(raid)).toEqual(["frag_soul"]);
      expect(
        (window.__ulrRaidStages as Record<string, { stage: number; src: string }>)["p-1"],
      ).toMatchObject({
        stage: 3,
        src: "battle",
      });
      // BOSS 對不上（開了 p-2 的面板卻打到別的）不記
      raid.create_raid_start_panel(raid.raid_list[1]!);
      game.scene.keys.MainA = room("r2", "005", 30130);
      poll?.();
      expect((window.__ulrRaidStages as Record<string, unknown>)["p-2"]).toBeUndefined();
    });

    it("自己發現渦：raid_title 的 raid_stage 記在自己開的、同一隻怪、剛發現的那個渦", () => {
      const now = Date.now();
      const { raid, game, window } = setup([
        // M1：不在龍鯰的區塊裡，區塊推不出來
        ROW({ founder: "燈皇", found_at: now - 3_600_000, profound_id: "old", map_index: 1 }),
        ROW({ founder: "燈皇", found_at: now - 5_000, profound_id: "new" }),
      ]);
      game.scene.keys.Raid_Title = {
        raid_data: { raid_name: "龍鯰", raid_chara_id: 30130, raid_ttl: 6, raid_stage: 2 },
      };
      run(window, buildRaidViewPatchScript({}));
      const S = window.__ulrRaidStages as Record<string, { stage: number; src: string }>;
      expect(S["new"]).toMatchObject({ stage: 2, src: "title" });
      expect(S["old"]).toBeUndefined();
      // stage 2 ★1 → 時間；另一個還不知道 → 灰色
      expect(fragsOf(raid)).toEqual(["frag_time"]);
      expect(raid.raid_vortex[0]!.icon.tint).toBe(RAID_UNKNOWN_TINT);
    });

    it("新渦還沒進清單時，不把 stage 套到同一隻怪的舊渦上（2026-09-25 靈龜記成 3、實際掉時間）", () => {
      const now = Date.now();
      const { raid, game, window } = setup([
        ROW({ founder: "燈皇", found_at: now - 31 * 60_000, profound_id: "old" }),
      ]);
      run(window, buildRaidViewPatchScript({}));
      game.scene.keys.Raid_Title = {
        raid_data: { raid_name: "龍鯰", raid_chara_id: 30130, raid_ttl: 6, raid_stage: 3 },
      };
      poll?.();
      const S = window.__ulrRaidStages as Record<string, unknown> | undefined;
      expect(S?.["old"]).toBeUndefined();
      // 清單拉到新渦之後才記在它身上
      raid.raid_list = [
        ...raid.raid_list,
        ROW({ founder: "燈皇", found_at: now, profound_id: "new" }),
      ];
      poll?.();
      expect((window.__ulrRaidStages as Record<string, unknown>)["new"]).toMatchObject({
        stage: 3,
        src: "title",
      });
      expect((window.__ulrRaidStages as Record<string, unknown>)["old"]).toBeUndefined();
    });

    it("任務裡連著發現兩個才進渦房：前一個的 raid_title 被蓋掉之前就收著，進房後兩個都記", () => {
      const now = Date.now();
      const { raid, game, window } = setup([]);
      raid.status = 0; // 人在任務裡
      run(window, buildRaidViewPatchScript({}));
      const titles = game.scene.keys as Record<string, unknown>;
      titles.Raid_Title = {
        raid_data: { raid_name: "龍鯰", raid_chara_id: 30130, raid_ttl: 6, raid_stage: 2 },
      };
      poll?.();
      titles.Raid_Title = {
        raid_data: { raid_name: "屠殺者", raid_chara_id: 30114, raid_ttl: 6, raid_stage: 4 },
      };
      poll?.();
      // 進渦房：清單上有這兩個（還有一個更早、已經記過的同怪渦）
      window.__ulrRaidStages = { done: { stage: 1, src: "battle", at: now } };
      raid.raid_list = [
        ROW({ founder: "燈皇", found_at: now - 3_600_000, profound_id: "done" }),
        ROW({ founder: "燈皇", found_at: now, profound_id: "p-1" }),
        ROW({ founder: "燈皇", found_at: now, profound_id: "p-2", monster_id: 30114 }),
      ];
      raid.status = 5;
      poll?.();
      const S = window.__ulrRaidStages as Record<string, { stage: number; src: string }>;
      expect(S["p-1"]).toMatchObject({ stage: 2, src: "title" });
      expect(S["p-2"]).toMatchObject({ stage: 4, src: "title" });
      expect(S["done"]).toMatchObject({ stage: 1, src: "battle" });
    });

    it("死渦（_expired 圖）不換貼圖", () => {
      const { raid, window } = setup([ROW({ hp: 0 })]);
      run(window, buildRaidViewPatchScript({ publicMap: PUB() }));
      expect(raid.raid_vortex[0]!.icon.texture.key).toBe("vortex_another_expired");
    });

    it("還沒學到、有 ulgg：面板的排名那一格寫碎片種類與來源", () => {
      const { raid, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ publicMap: PUB({ stage: 3 }) }));
      raid.openDetail(raid.raid_list[0]!);
      poll?.();
      raid
        .alive()
        .find((o) => o.text === "獎勵一覽")!
        .emit("pointerup");
      expect(raid.alive().map((o) => o.text)).toContain("靈魂的碎片  (由 stage 3 推算)");
    });

    it("學到的原料帶著渦還活著時 ulgg 給的 stage（渦死了、ulgg 表換了也還在）", () => {
      const { raid, window, reports } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING, publicMap: PUB({ stage: 4 }) }));
      raid.raid_list = [];
      window.__ulrRaidRewardSeen = [
        {
          profound_id: "p-1",
          at: 1,
          raw: { founder: [], participate: [], defeat: [], ranks: [], founderName: "Owlic" },
        },
      ];
      poll?.();
      const s = reports.find((r) => r.type === "raid-learn")!.sample as RaidLearnSample;
      expect(s.stage).toBe(4);
    });
  });

  describe("BOSS 狀態", () => {
    /** 開打：點 START（記渦）→ 戰鬥設定換新 → 晚一點 get_chara_opponent 的 BOSS 資料到。 */
    function fight(raid: Raid, game: Game, room: string, state: unknown[]) {
      raid.create_raid_start_panel(raid.raid_list[0]!);
      const M = {
        room_config: {
          rule: "raid",
          room_id: room,
          stage: "003",
          playerB_deck: { chara_card_id: [30130, null, null] },
        },
        _chara1: null as unknown,
      };
      game.scene.keys.MainA = M;
      poll?.();
      M._chara1 = { card_id: 30130, state };
      poll?.();
    }
    const statesOf = (window: Record<string, unknown>) =>
      (
        window.__ulrRaidBossStates as Record<string, { states: unknown[]; at: number }> | undefined
      )?.["p-1"];

    it("開打那一刻 BOSS 身上的狀態記在那個渦上；turn 大的是到期時刻、小的是層數；詳細面板畫出來", () => {
      const now = Date.now();
      const { raid, game, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({}));
      fight(raid, game, "r1", [
        { type: "scare", turn: now + 600_000 },
        { type: "curse", turn: 3 },
      ]);
      expect(statesOf(window)!.states).toEqual([
        { type: "scare", until: now + 600_000, count: null },
        { type: "curse", until: null, count: 3 },
      ]);
      raid.openDetail(raid.raid_list[0]!);
      poll?.();
      const texts = raid.alive().map((o) => o.text);
      // 渦房裡沒有 StateIcons（戰鬥才載）→ 寫兩字標籤
      expect(texts).toContain("恐懼");
      expect(texts).toContain("詛咒");
      expect(texts).toContain("9m"); // 剩 9 分 59 秒多
      expect(texts).toContain("3");
    });

    it("剛裝上時戰鬥設定與 BOSS 資料早就在（很久以前那場）：不記", () => {
      const { raid, game, window } = setup([ROW()]);
      raid.__ulrRaidStartId = "p-1";
      game.scene.keys.MainA = {
        room_config: {
          rule: "raid",
          room_id: "old",
          stage: "003",
          playerB_deck: { chara_card_id: [30130, null, null] },
        },
        _chara1: { card_id: 30130, state: [{ type: "scare", turn: Date.now() + 600_000 }] },
      };
      run(window, buildRaidViewPatchScript({}));
      poll?.();
      expect(statesOf(window)).toBeUndefined();
      // stage 不會變，照記
      expect((window.__ulrRaidStages as Record<string, unknown>)["p-1"]).toBeTruthy();
    });

    it("互傳來的比自己看到的新就用互傳的；過期的不畫", () => {
      const now = Date.now();
      const { raid, game, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({}));
      fight(raid, game, "r1", [{ type: "scare", turn: now + 600_000 }]);
      raid.openDetail(raid.raid_list[0]!);
      poll?.();
      expect(raid.alive().some((o) => o.text === "恐懼")).toBe(true);
      const pub = {
        "@Owlic@1790328501134": {
          tl: null,
          rarity: 1,
          stage: null,
          mons: null,
          states: [
            { type: "huin", until: now + 600_000, count: null },
            { type: "mahi", until: now - 1, count: null },
          ],
          statesAt: now + 1_000,
          limit: 1790328501134,
          founder: "Owlic",
        },
      };
      (window.__ulrRaidView as { publicMap: unknown }).publicMap = pub;
      poll?.();
      const texts = raid.alive().map((o) => o.text);
      expect(texts).toContain("封印");
      expect(texts).not.toContain("恐懼");
      expect(texts).not.toContain("麻痺");
    });

    it("上傳快照：清單上每個渦（別人開的也算），帶發現者、自己看到的 stage 與開打時的狀態", () => {
      const now = Date.now();
      const { raid, game, window } = setup([ROW({ limit: now + 3_600_000 })]);
      run(window, buildRaidViewPatchScript({}));
      fight(raid, game, "r1", [{ type: "scare", turn: now + 600_000 }]);
      const rows = parseRaidViewSnapshot(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: null,
        founder: "Owlic",
        rarity: 1,
        stage: 3,
        states: [{ type: "scare", until: now + 600_000, count: null }],
      });
      expect(rows[0]!.statesAt).toBeGreaterThanOrEqual(now);
    });

    it("每場開打讀到 stage 就通知托盤（raid-stage）；戰鬥中（Raid 睡著）快照照讀", () => {
      const now = Date.now();
      const { raid, game, window, reports } = setup([ROW({ limit: now + 3_600_000 })]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      // 一場兩次：讀到 stage 一次、讀到 BOSS 狀態一次（狀態有持續時間，公開渦通知要馬上傳）
      fight(raid, game, "r1", []);
      expect(reports.filter((r) => r.type === "raid-stage")).toHaveLength(2);
      // 同一個渦再打一場、stage 一樣：也通知（上次沒報成的補上；報過的托盤會跳過）
      fight(raid, game, "r2", []);
      expect(reports.filter((r) => r.type === "raid-stage")).toHaveLength(4);
      // 戰鬥中 Raid 場景睡著
      raid.scene.isSleeping = () => true;
      const rows = parseRaidViewSnapshot(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION));
      expect(rows.map((r) => r.stage)).toEqual([3]);
    });

    it("渦結束紀錄：死了（limit 改成死亡＋10 分）→ 清單重拿過還在 → 再重拿不見了 → 回報一次；結算晚到補報", () => {
      const now = Date.now();
      const { raid, window, reports } = setup([ROW({ limit: now + 3_600_000 })]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      const tracks = () => reports.filter((r) => r.type === "raid-track");
      // 死了：伺服器把 limit 改成死亡＋10 分，清單重拿一份
      raid.raid_list = [ROW({ hp: 0, limit: now + 600_000 })];
      poll?.();
      raid.raid_list = [ROW({ hp: 0, limit: now + 600_000 })];
      poll?.();
      expect(tracks()).toHaveLength(0);
      // 死前要過一次結算（不算）、死後兩次（一次整包空的）—— patch-raid-reward 記的
      window.__ulrRaidRewardAsks = [
        { at: now - 3_600_000, n: 1 },
        { at: now + 1, n: 0 },
        { at: now + 2, n: 2 },
      ];
      // 到期了：清單重拿、它不在了
      raid.raid_list = [];
      poll?.();
      expect(tracks()).toHaveLength(1);
      expect(tracks()[0]).toMatchObject({
        name: "龍鯰",
        mine: false,
        point: 289,
        refreshAfterDeath: 1,
        settled: null,
        // 找規律用的：照最後一次在清單上看到的
        stage: 1,
        monsterId: 30130,
        founder: "Owlic",
        hpMax: 1200,
        rankCount: 0,
        myRank: 15,
        asksAfterDeath: 2,
        emptyAsksAfterDeath: 1,
        // 渦房上標的預期獎勵：龍鯰 M5 → stage 1 → ★1 的公式是記憶的碎片（照區塊推的）
        expectFrag: "記憶的碎片",
        expectCoin: false,
        expectSrc: "map",
      });
      expect(Math.abs((tracks()[0]!.deathByLimit as number) - now)).toBeLessThan(1000);
      // 消失後結算才到
      // 跟 patch-raid-reward 記的一樣是陣列（以前測試用物件，真的腳本永遠對不到）
      window.__ulrRaidRewardSeen = [{ profound_id: "p-1", at: now + 1 }];
      poll?.();
      expect(tracks()).toHaveLength(2);
      expect(tracks()[1]).toMatchObject({ settled: now + 1 });
    });

    it("上傳快照不收舊版用發現畫面記的 stage（那時的對法會套錯渦）；戰鬥記的照收", () => {
      const now = Date.now();
      const { window } = setup([
        ROW({ profound_id: "old-title", limit: now + 3_600_000 }),
        ROW({ profound_id: "old-battle", limit: now + 3_600_001 }),
      ]);
      window.__ulrRaidStages = {
        "old-title": { stage: 3, src: "title", at: now },
        "old-battle": { stage: 2, src: "battle", at: now },
      };
      run(window, buildRaidViewPatchScript({}));
      const rows = parseRaidViewSnapshot(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION));
      expect(rows.map((r) => r.stage)).toEqual([null, 2]);
    });
  });

  describe("邊打邊學", () => {
    const RAW = {
      founder: [{ type: 2, id: 5000, slot: 0, value: 1 }],
      participate: [{ type: 3, id: 2, slot: 0, value: 2 }],
      defeat: [],
      ranks: [
        [{ type: 2, id: 5005, slot: 0, value: 2 }],
        [],
        [{ type: 2, id: 5005, slot: 0, value: 1 }],
      ],
      founderName: "Owlic",
    };

    it("結算對回清單列才回報；不是發現者看不到發現獎勵；同一個渦只學一次", () => {
      const { window, reports } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      window.__ulrRaidRewardSeen = [{ profound_id: "p-1", at: 5000, raw: RAW }];
      poll?.();
      const got = reports.filter((r) => r.type === "raid-learn");
      expect(got).toHaveLength(1);
      expect(isRaidLearnReport(got[0])).toBe(true);
      expect(got[0]!.sample).toEqual({
        profoundId: "p-1",
        name: "龍鯰",
        monsterId: 30130,
        level: 1,
        rarity: 1,
        mapIndex: 5,
        category: "another",
        founder: null,
        participate: RAW.participate,
        defeat: null,
        ranks: RAW.ranks,
        stage: null,
        at: 5000,
      });
      // 回報裡沒有玩家名字
      expect(JSON.stringify(got[0])).not.toContain("Owlic");
      poll?.();
      // 重裝也不再學一次
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      poll?.();
      expect(reports.filter((r) => r.type === "raid-learn")).toHaveLength(1);
    });

    it("自己是發現者：發現獎勵看得到", () => {
      const { window, reports } = setup([ROW({ founder: "燈皇" })]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      window.__ulrRaidRewardSeen = [
        { profound_id: "p-1", at: 1, raw: { ...RAW, founderName: "燈皇" } },
      ];
      poll?.();
      const s = reports.find((r) => r.type === "raid-learn")!.sample as RaidLearnSample;
      expect(s.founder).toEqual(RAW.founder);
    });

    it("渦先從清單消失也學得到（清單列重裝不清）；一直對不到的放棄", () => {
      const { raid, window, reports } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.raid_list = [];
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      window.__ulrRaidRewardSeen = [
        { profound_id: "p-1", at: Date.now(), raw: RAW },
        { profound_id: "never", at: Date.now(), raw: RAW },
      ];
      poll?.();
      expect(reports.filter((r) => r.type === "raid-learn")).toHaveLength(1);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + RAID_LEARN_GIVE_UP_MS + 1);
      poll?.();
      expect((window.__ulrRaidLearnedIds as Record<string, string>).never).toBe("no-meta");
    });

    it("舊版 raid-reward 記的（沒有 raw）不學", () => {
      const { window, reports } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      window.__ulrRaidRewardSeen = [{ profound_id: "p-1", at: 1 }];
      poll?.();
      expect(reports.some((r) => r.type === "raid-learn")).toBe(false);
    });
  });

  describe("更新鈕（⑩）", () => {
    const button = (raid: Raid) => raid.alive().find((o) => o.text === "Refresh");

    it("在 Profound 計數下面；按下去照重進渦房送：db_player_ap → db_raid → 官方 show_raid_reward", async () => {
      const { raid, window, reports } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      const btn = button(raid)!;
      expect(btn.x).toBe(raid.raid_owned.x + 8);
      expect(btn.y).toBe(raid.raid_owned.y + 9);
      raid.next = [ROW({ hp: 10 })];
      btn.emit("pointerup");
      await flush();
      await flush();
      expect(raid.sent.map((m) => m[0])).toEqual(["db_player_ap", "db_raid"]);
      expect(raid.sent.some((m) => m[0] === "emit:ap_recover")).toBe(false);
      expect(raid.raid_list).toBe(raid.next);
      expect(raid.calls).toEqual(["sort", "list", "vortex", "show_raid_reward"]);
      expect(raid.ap_value_text.text).toBe("20");
      expect(raid.ap_fill_image.crop).not.toBeNull();
      expect(reports.some((r) => r.type === "raid-refresh")).toBe(true);
      // 冷卻中再按不算
      btn.emit("pointerup");
      await flush();
      expect(raid.sent.filter((m) => m[0] === "db_raid")).toHaveLength(1);
    });

    it("詳細面板開著：照點地圖渦那條路用新的那一列重開；渦不見了就回清單", async () => {
      const { raid, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.openDetail(raid.raid_list[0]!);
      raid.calls = [];
      raid.next = [ROW({ hp: 5 })];
      button(raid)!.emit("pointerup");
      await flush();
      await flush();
      expect(raid.calls).toEqual([
        "sort",
        "vortex",
        "destroy_detail",
        "detail:p-1",
        "show_raid_reward",
      ]);
      expect(raid.__ulrRaidDetailRow?.hp).toBe(5);
    });

    it("AP 讀失敗不擋渦清單", async () => {
      const { raid, window } = setup([ROW()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      const orig = raid.socket.fetch;
      raid.socket.fetch = (ev: string, ...a: unknown[]) =>
        ev === "db_player_ap" ? Promise.reject(new Error("timed out")) : orig(ev, ...a);
      raid.next = [ROW()];
      button(raid)!.emit("pointerup");
      await flush();
      await flush();
      expect(raid.calls).toContain("show_raid_reward");
    });
  });

  describe("SUPPORT 回應的攔截（raid-support.ts）", () => {
    /** 實機的連線是類別：fetch = once + emit，回應用同名事件回來。 */
    class Sock {
      #cb = new Map<string, (...a: unknown[]) => void>();
      constructor(private readonly rows: unknown[]) {}
      once(ev: string, cb: (...a: unknown[]) => void): void {
        this.#cb.set(ev, cb);
      }
      emit(ev: string): void {
        if (ev !== "db_raid_support") return;
        queueMicrotask(() => {
          const cb = this.#cb.get(ev);
          this.#cb.delete(ev);
          cb?.(this.rows);
        });
      }
      fetch(ev: string): Promise<unknown> {
        return new Promise((resolve) => {
          this.once(ev, (r: unknown) => resolve(r));
          this.emit(ev);
        });
      }
    }

    it("進渦房的下一拍就裝好：重整完一進來就按 SUPPORT 也攔得到（2026-10-03 漏掉妖精）", async () => {
      const { raid, window } = setup([ROW()]);
      raid.status = 0; // 還沒進渦房
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      const sock = new Sock([
        {
          profound_code: "ABCDEFGHIJKL",
          raid_name: "魔性的鱗粉",
          monster_id: 30199,
          founder_name: "krinlight",
          hp: 100,
          hp_max: 100,
          limit: 1_791_039_785_000,
          profound_date: 1_791_037_985_000,
          member_length: 1,
          member_limit: 100,
        },
      ]);
      (raid as unknown as { socket: unknown }).socket = sock;
      poll?.();
      expect((Sock.prototype.once as { __ulrFeed?: unknown }).__ulrFeed).toBeUndefined();
      raid.status = 5;
      poll?.(); // 托盤那一輪還沒跑
      await sock.fetch("db_raid_support");
      const out = run(window, RAID_SUPPORT_SNAPSHOT_EXPRESSION);
      expect(out).not.toContain("ABCDEFGHIJKL");
      expect(parseRaidSupportSnapshot(out)).toMatchObject([
        { founder: "krinlight", name: "魔性的鱗粉", hp: 100, hpMax: 100 },
      ]);
    });
  });

  describe("自動刪除死渦", () => {
    const DEAD = (over: Partial<Row> = {}) =>
      ROW({
        name: "黑死獸",
        hp: 0,
        profound_id: "dead-1",
        player_point: 0,
        founder: "咕嚕",
        ...over,
      });
    const removed = (raid: Raid) =>
      raid.sent.filter((m) => m[0] === "raid_delete").map((m) => m[1]);

    it("關著不刪；打開後沒有自己的份照官方放棄刪，一次一個、刪完照官方重拿清單重畫", async () => {
      const { raid, window, reports } = setup([ROW(), DEAD(), DEAD({ profound_id: "dead-2" })]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      expect(removed(raid)).toEqual([]);
      run(window, buildRaidViewSetAutoDeleteExpression({ enabled: true, prompt: true }));
      raid.next = [ROW(), DEAD({ profound_id: "dead-2" })];
      poll?.();
      poll?.();
      expect(removed(raid)).toEqual(["dead-1"]);
      await flush();
      expect(raid.sent.map((m) => m[0])).toEqual(["raid_delete", "db_raid"]);
      expect(raid.raid_list).toBe(raid.next);
      expect(raid.calls).toEqual(["sort", "list", "vortex"]);
      expect(reports.find((r) => r.type === "raid-auto-delete")).toMatchObject({
        name: "黑死獸",
        founder: "咕嚕",
        reason: "no-reward",
      });
      raid.next = [ROW()];
      poll?.();
      await flush();
      expect(removed(raid)).toEqual(["dead-1", "dead-2"]);
    });

    it("有自己一份（榜上有分或自己是發現者）→ 等結算收到了才刪", async () => {
      const { raid, window, reports } = setup([
        DEAD({ player_point: 500 }),
        DEAD({ profound_id: "mine", founder: "燈皇" }),
      ]);
      run(
        window,
        buildRaidViewPatchScript({
          bindingName: BINDING,
          autoDelete: { enabled: true, prompt: true },
        }),
      );
      poll?.();
      expect(removed(raid)).toEqual([]);
      window.__ulrRaidRewardSeen = [{ profound_id: "mine" }];
      raid.next = [DEAD({ player_point: 500 })];
      poll?.();
      await flush();
      expect(removed(raid)).toEqual(["mine"]);
      expect(reports.find((r) => r.type === "raid-auto-delete")).toMatchObject({
        reason: "had-reward",
      });
      // 刪渦與官方放棄後那次 db_raid 以外什麼都不送
      expect(raid.sent.map((m) => m[0])).toEqual(["raid_delete", "db_raid"]);
    });

    it("詳細面板開著、結算正在演的時候不動；伺服器不收的渦不重送", async () => {
      const { raid, window, reports } = setup([DEAD()]);
      raid.__ulrRaidRewardBatch = { list: [] };
      run(
        window,
        buildRaidViewPatchScript({
          bindingName: BINDING,
          autoDelete: { enabled: true, prompt: true },
        }),
      );
      poll?.();
      raid.__ulrRaidRewardBatch = undefined;
      raid.raid_detail_give_up = raid.make("image", 10, 68);
      poll?.();
      expect(removed(raid)).toEqual([]);
      raid.raid_detail_give_up.destroy();
      raid.socket.fetch = (ev: string, ...a: unknown[]) => {
        raid.sent.push([ev, ...a]);
        return Promise.resolve(false);
      };
      poll?.();
      await flush();
      poll?.();
      await flush();
      expect(removed(raid)).toEqual(["dead-1"]);
      expect(raid.sent.some((m) => m[0] === "db_raid")).toBe(false);
      expect(reports.some((r) => r.type === "raid-auto-delete")).toBe(false);
    });
  });

  describe("打渦隊伍（⑨）", () => {
    const FOUND = 1790321644930;
    const LIMIT = FOUND + 21_600_000;
    // ⚠ 時鐘釘在渦還活著的時候。腳本會略過 limit 已過的渦，用真的時鐘的話
    // 過了 LIMIT（2026-09-25 21:34）快照就是空的 —— 當天晚上發版就這樣擋下來。
    // 只假 Date，poll 與 setTimeout 照舊。
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FOUND + 3_600_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    /** 別人（路德）開的靈龜：code 是 null */
    const TURTLE = (over: Partial<Row> = {}) =>
      ROW({
        name: "靈龜",
        monster_id: 30120,
        founder: "路德",
        profound_id: "p-turtle",
        found_at: FOUND,
        limit: LIMIT,
        player_point: 0,
        ...over,
      });
    const DECK = {
      deck_id: 1,
      chara_card_id: [350, 330, 110],
      weapon_card_id: [21, 123, 56],
      event_card_id: [31, 31, 31, 34, 34, 28, 28, 34, 34, 34, 28, 28, 71, 80, 31, 31, 28, 28],
    };
    /** 戰鬥的 socket：每場一顆新的，game_result 時 off() 全部 */
    class BattleSocket {
      handlers = new Map<string, Handler[]>();
      on(ev: string, fn: Handler) {
        this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
        return this;
      }
      off(ev?: string, fn?: Handler) {
        if (ev === undefined) this.handlers.clear();
        else
          this.handlers.set(
            ev,
            (this.handlers.get(ev) ?? []).filter((h) => h !== fn),
          );
        return this;
      }
      emit(ev: string, ...a: unknown[]) {
        for (const h of this.handlers.get(ev) ?? []) h(...a);
      }
    }
    /** 2026-09-25 實機的戰鬥設定形狀（MainA.room_config） */
    const battle = (room: string, over: Record<string, unknown> = {}) => {
      const socket = new BattleSocket();
      return {
        socket,
        player_side: "A",
        room_config: {
          room_id: room,
          rule: "raid",
          stage: "002",
          playerA_deck: DECK,
          playerB_deck: { chara_card_id: [30120, null, null] },
          turn_limit: 2,
          expire_limit: LIMIT,
          ...over,
        },
      };
    };
    const battles = (reports: { type: string }[]) =>
      reports.filter((r) => r.type === "raid-battle") as unknown as {
        raid: string;
        player: string;
        limit: number;
        turns: number;
        ap: number;
        damage: number;
        points: number;
        deck: Record<string, unknown>;
        at: number;
      }[];

    it("打一場：expire_limit 對到渦（沒經過回合面板也對得到），damage_opponent 加總，回渦房後分數相減", () => {
      const { raid, game, window, reports } = setup([ROW(), TURTLE()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      // 打渦.py：直接 emit raid_start，Raid 睡著、戰鬥開始
      raid.status = 0;
      const M = battle("r1");
      game.scene.keys.MainA = M;
      poll?.();
      // 別人上的毒／自壞在回合開頭跳血、BOSS 技能自傷：第 4 個參數 false，不算自己的
      M.socket.emit("damage_opponent", 1, 5999, 6000, false, true);
      M.socket.emit("damage_opponent", 1, 5998, 6000, true, false);
      M.socket.emit("damage_player", 11, 0, 11, false, true); // 自己挨打不算
      M.socket.emit("damage_opponent", 51, 5947, 6000, false, true);
      M.socket.emit("damage_opponent", 15, 5932, 6000, true, false);
      poll?.();
      expect(battles(reports)).toEqual([]);
      // 打完：game_result 把 socket 全 off，回渦房、Raid.init 重拿清單
      M.socket.off();
      raid.status = 5;
      poll?.();
      expect(battles(reports)).toEqual([]); // 還是開打前那份清單：不量
      raid.raid_list = [ROW(), TURTLE({ player_point: 2093 })];
      poll?.();
      const [b] = battles(reports);
      expect(b).toMatchObject({
        raid: "路德@" + FOUND,
        player: "燈皇",
        limit: LIMIT,
        turns: 2,
        ap: 2,
        damage: 16,
        points: 2093,
        deck: {
          chara: ["cc035", "cc033", "cc011"],
          charaIndex: [350, 330, 110],
          weapon: [21, 123, 56],
          eventIndex: DECK.event_card_id,
        },
      });
      expect(JSON.stringify(b)).not.toContain("p-turtle");
      // 提早離場：分數晚到，同一個 at 補報；沒再漲就不報
      raid.raid_list = [ROW(), TURTLE({ player_point: 2600 })];
      poll?.();
      raid.raid_list = [ROW(), TURTLE({ player_point: 2600 })];
      poll?.();
      expect(battles(reports).map((r) => [r.points, r.damage, r.at === b!.at])).toEqual([
        [2093, 16, true],
        [2600, 16, true],
      ]);
    });

    it("剛裝上時看到的戰鬥設定可能是很久以前那場：不記", () => {
      const { raid, game, window, reports } = setup([TURTLE()]);
      game.scene.keys.MainA = battle("old");
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.raid_list = [TURTLE({ player_point: 900 })];
      poll?.();
      expect(battles(reports)).toEqual([]);
    });

    it("連打：還沒量到又開打，用開打那一刻的清單先結算上一場；之後的分數算新的那場", () => {
      const { raid, game, window, reports } = setup([TURTLE()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.status = 0;
      const first = battle("r1");
      game.scene.keys.MainA = first;
      poll?.();
      first.socket.emit("damage_opponent", 10, 5990, 6000, true, false);
      // 回渦房一瞬間（清單還沒換）就又開打；那一刻清單上已經是新分數
      raid.raid_list = [TURTLE({ player_point: 1500 })];
      const second = battle("r2", { turn_limit: 1 });
      game.scene.keys.MainA = second;
      poll?.();
      second.socket.emit("damage_opponent", 3, 5987, 6000, true, false);
      expect(battles(reports).map((r) => [r.turns, r.damage, r.points])).toEqual([[2, 10, 1500]]);
      raid.status = 5;
      raid.raid_list = [TURTLE({ player_point: 1800 })];
      poll?.();
      expect(battles(reports).map((r) => [r.turns, r.damage, r.points])).toEqual([
        [2, 10, 1500],
        [1, 3, 300],
      ]);
    });

    it("BOSS 對不上、牌組認不出來就不記", () => {
      const { raid, game, window, reports } = setup([TURTLE()]);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.status = 0;
      game.scene.keys.MainA = battle("r1", {
        playerB_deck: { chara_card_id: [30130, null, null] },
      });
      poll?.();
      game.scene.keys.MainA = battle("r2", {
        playerA_deck: { chara_card_id: [99999, null, null] },
      });
      poll?.();
      raid.status = 5;
      raid.raid_list = [TURTLE({ player_point: 900 })];
      poll?.();
      expect(battles(reports)).toEqual([]);
    });

    it("排行榜：有隊伍的名字後面掛 deck_icon、點下去開那支隊伍（新卡圖）；沒有的不動", () => {
      const { raid, game, window } = setup([TURTLE({ player_point: 2093 })]);
      for (const k of ["deck_icon", "btn_arrow", "card_common_base"]) {
        game.textures.list[k] = new Set(["0", "1"]);
      }
      game.textures.list.CharaCardImages = new Set(["cc035_r05", "cc033_r05"]);
      game.textures.list.WeaponCardImages!.add("weapon_21");
      game.textures.list.EventCardImages = new Set(["event_31"]);
      const team = {
        chara: ["cc035", "cc033", "cc011"],
        charaIndex: [350, 330, 110],
        weapon: [21, 123, 56],
        eventIndex: DECK.event_card_id,
        battles: 1,
        turns: 2,
        ap: 2,
        damage: 16,
        best: 16,
        points: 2093,
      };
      run(window, buildRaidViewPatchScript({ teams: { ["路德@" + FOUND]: { 燈皇: [team] } } }));
      raid.openDetail(raid.raid_list[0]!);
      const rankRow = (e: number, name: string, pt: number) => ({
        rank: raid.add.text(516, 46 + 16 * e, String(e + 1)),
        player_name: raid.add.text(528, 48 + 16 * e, name),
        point: raid.add.text(709, 48 + 16 * e, `[${pt}pts.]`),
      });
      raid.raid_detail_ranking = [rankRow(0, "Lv.92 路德", 18000), rankRow(1, "Lv.134 燈皇", 2093)];
      poll?.();
      const icons = () => raid.alive().filter((o) => o.texture.key === "deck_icon");
      expect(icons()).toHaveLength(1);
      expect(icons()[0]!.y).toBe(raid.raid_detail_ranking[1]!.player_name.y);
      expect(raid.raid_detail_ranking[0]!.player_name.handlers.get("pointerup")).toBeUndefined();
      raid.raid_detail_ranking[1]!.player_name.emit("pointerup");
      const texts = raid.alive().map((o) => o.text);
      expect(texts).toContain("燈皇 的隊伍");
      expect(texts).toContain("傷害");
      expect(texts).toContain("16");
      const faces = raid
        .alive()
        .filter((o) => o.texture.key === "CharaCardImages")
        .map((o) => o.frame.name);
      expect(faces).toEqual(["cc035_r05", "cc033_r05"]);
      // 第三張沒有卡圖：畫空卡底
      expect(raid.alive().some((o) => o.texture.key === "card_common_base")).toBe(true);
      expect(raid.alive().some((o) => o.texture.key === "EventCardImages")).toBe(true);
      // 翻頁（官方整批重建排行榜）：舊的圖示收掉、新的重掛
      for (const it of raid.raid_detail_ranking) it.player_name.destroy();
      raid.raid_detail_ranking = [rankRow(0, "Lv.134 燈皇", 2093)];
      poll?.();
      expect(icons()).toHaveLength(1);
      expect(icons()[0]!.y).toBe(raid.raid_detail_ranking[0]!.player_name.y);
    });

    it("快照：排行榜名字去掉「Lv.N 」、帶發現時刻（托盤查隊伍用）", () => {
      const { raid, window } = setup([TURTLE()]);
      (raid.raid_list[0] as unknown as { rank: unknown[] }).rank = [
        { player_name: "Lv.92 路德", point: 18000, level: 92 },
        { player_name: "Lv.134 燈皇", point: 2093, level: 134 },
      ];
      run(window, buildRaidViewPatchScript({}));
      const [row] = parseRaidViewSnapshot(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION));
      expect(row).toMatchObject({ founder: "路德", foundAt: FOUND, players: ["路德", "燈皇"] });
    });

    it("快照帶托盤記結算用的 meta（名字、區塊、自己的分數）；清單還沒拿到時 listed 是 false", () => {
      const { raid, window } = setup([TURTLE()]);
      run(window, buildRaidViewPatchScript({}));
      const snap = parseRaidViewSnapshotListed(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION));
      expect(snap.listed).toBe(true);
      expect(snap.rows[0]!.meta).toMatchObject({
        name: TURTLE().name,
        mapIndex: TURTLE().map_index,
        point: TURTLE().player_point,
      });
      (raid as unknown as { raid_list: unknown }).raid_list = undefined;
      expect(parseRaidViewSnapshotListed(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION))).toEqual({
        rows: [],
        listed: false,
      });
    });
  });

  it("重裝先拆再裝：同一列不會掛兩份；create_raid_detail 不會包兩層", () => {
    const { raid, window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    run(window, buildRaidViewPatchScript({ learned: learned() }));
    expect(iconsOf(raid)).toHaveLength(2);
    const proto = Object.getPrototypeOf(raid) as {
      create_raid_detail: { __ulrRaidView?: unknown };
    };
    expect(proto.create_raid_detail.__ulrRaidView).toBeTypeOf("function");
    expect(
      (proto.create_raid_detail.__ulrRaidView as { __ulrRaidView?: unknown }).__ulrRaidView,
    ).toBeUndefined();
    run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
    expect(proto.create_raid_detail.__ulrRaidView).toBeUndefined();
  });

  it("狀態：裝上、在渦房、版本對", () => {
    const { window } = setup([ROW()]);
    run(window, buildRaidViewPatchScript({}));
    const st = parseRaidViewStatus(run(window, RAID_VIEW_STATUS_EXPRESSION));
    expect(st).toMatchObject({
      installed: true,
      version: RAID_VIEW_SCRIPT_VERSION,
      inRaid: true,
      rows: 1,
      vortices: 1,
    });
  });
});

/**
 * ⑪ 2026-09-26 實機：輸入自己已經參加的渦的碼，伺服器不回 → fetch 逾時 reject →
 * 官方的送出鈕沒接，input.enabled 永遠是 false。例外會變成 unhandledrejection。
 */
describe("⑪ 渦碼沒回應：解開渦房", () => {
  const TIMEOUT = "raid_code_input: timed out (https://www.playunlight.online:15005)";

  function setupCode() {
    const env = setup([ROW()]);
    const { raid, game, window } = env;
    const listeners = new Set<Handler>();
    window.addEventListener = (name: string, fn: Handler) => {
      if (name === "unhandledrejection") listeners.add(fn);
    };
    window.removeEventListener = (name: string, fn: Handler) => {
      if (name === "unhandledrejection") listeners.delete(fn);
    };
    const texts = {
      error: { label: "確認", DEFAULT: "發生意外的錯誤。" } as Record<string, string>,
    };
    const base = game.cache.json.get;
    game.cache.json.get = (k: string) => (k === "RaidUITexts" ? texts : base(k));
    // 官方 raid_error：用鍵查字畫錯誤框，最後一行把點擊打開
    const shown: string[] = [];
    const R = raid as unknown as {
      input: { enabled: boolean };
      error_bg: unknown;
      raid_error: (key: string) => Promise<void>;
    };
    R.input = { enabled: false };
    R.error_bg = undefined;
    R.raid_error = async (key: string) => {
      shown.push(texts.error[key] ?? texts.error.DEFAULT!);
      R.error_bg = {};
      R.input.enabled = true;
    };
    const reject = (message: string) => {
      for (const fn of [...listeners]) fn({ reason: new Error(message) });
    };
    return { ...env, R, listeners, texts, shown, reject };
  }

  it("逾時的時候點擊關著：跳官方錯誤框（字是自己塞的鍵），點擊打開", () => {
    const { window, R, shown, reject, texts } = setupCode();
    run(window, buildRaidViewPatchScript({}));
    reject(TIMEOUT);
    expect(shown).toEqual([RAID_VIEW_LABELS.tcn!.codeNoReply]);
    expect(texts.error[RAID_CODE_NO_REPLY_KEY]).toBe(RAID_VIEW_LABELS.tcn!.codeNoReply);
    expect(R.input.enabled).toBe(true);
  });

  it("別的例外、點擊本來就開著、不在渦房：都不碰", () => {
    const { window, raid, R, shown, reject } = setupCode();
    run(window, buildRaidViewPatchScript({}));
    reject("raid_start: timed out (x)");
    expect(R.input.enabled).toBe(false);
    R.input.enabled = true;
    reject(TIMEOUT);
    expect(shown).toEqual([]);
    R.input.enabled = false;
    raid.status = 0;
    reject(TIMEOUT);
    expect(shown).toEqual([]);
    expect(R.input.enabled).toBe(false);
  });

  it("官方的錯誤框已經開著：不疊第二個，但照樣把點擊打開", () => {
    const { window, R, shown, reject } = setupCode();
    run(window, buildRaidViewPatchScript({}));
    R.error_bg = {};
    reject(TIMEOUT);
    expect(shown).toEqual([]);
    expect(R.input.enabled).toBe(true);
  });

  it("raid_error 半路出事也不卡：點擊照樣打開", () => {
    const { window, R, reject } = setupCode();
    R.raid_error = () => Promise.reject(new Error("boom"));
    run(window, buildRaidViewPatchScript({}));
    reject(TIMEOUT);
    expect(R.input.enabled).toBe(true);
  });

  it("重裝只留一個監聽；拆掉收監聽、塞的鍵也拿掉", () => {
    const { window, listeners, texts, reject } = setupCode();
    run(window, buildRaidViewPatchScript({}));
    run(window, buildRaidViewPatchScript({}));
    expect(listeners.size).toBe(1);
    reject(TIMEOUT);
    expect(texts.error[RAID_CODE_NO_REPLY_KEY]).toBeDefined();
    expect(run(window, RAID_VIEW_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(listeners.size).toBe(0);
    expect(texts.error[RAID_CODE_NO_REPLY_KEY]).toBeUndefined();
  });

  it("每一種語言都有這句", () => {
    for (const labels of Object.values(RAID_VIEW_LABELS)) {
      expect(labels.codeNoReply.length).toBeGreaterThan(0);
    }
  });
});
