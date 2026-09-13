/**
 * 渦房的獎勵標記
 *
 * 搭一個夠像的假渦房，把 `buildRaidViewPatchScript()` 產出來的**那一串字**
 * 原封不動 `new Function` 起來跑。假環境照 2026-09-13 從跑著的客戶端讀的形狀：
 *
 * ```js
 *   Raid.raid_data[i] = { profound_id, profound_mons, rarity, stage, treasure_level,
 *                         profound_founder, state: [{type, turn}], … }
 *   Raid.raid_list[e] = { name: Text, id }
 *   Raid.vortex[i]    = { base: Sprite(vortex_*_base), icon: Sprite(vortex_*), id }
 *   Raid.raid_info.visible / raid_idx / raid_info_name / raid_info_mons
 *   Raid.prototype.raid_support_list(list, y, page) → { texts }
 *   game.textures：item_cmem / item_ccoin / item_weapon / item_quest / item_other /
 *                  state_tmp / vortex_another 都在；createCanvas 回一張假 canvas
 * ```
 *
 * 要抓的坑：
 *
 * 1. `embedJson` 是字串字面值 —— 表要 `JSON.parse` 才是物件（查 2096 是書籤）
 * 2. 旗標記在 GameObject 上：清單重建（新的 name 物件）要重掛，舊的收掉
 * 3. 地圖渦：非過期的換灰階貼圖＋tint；自己的紅框（setTintFill）；拆掉時換回去
 * 4. 狀態列：state_tmp 有的用圖、沒有的退回字；詛咒印層數
 * 5. SUPPORT：公開表對得到渦碼才畫，畫的東西塞回 texts 讓官方一起收
 * 6. 每 N 秒送一次 db_raid，離開渦房就不送；回來後照點進渦那條路重畫排行榜、翻回原頁
 * 7. 誰上了狀態：只有「唯一候選」才記；多人同時動不記
 * 8. 排行榜名字與分數之間掛狀態圖；傷害統計面板列出每個人
 * 9. 過期狀態不畫；重裝會卸掉舊的 canvas 貼圖（不然新版畫法不生效）
 */

import { describe, expect, it } from "vitest";
import {
  buildRaidViewPatchScript,
  buildRaidViewSetAutoDeleteExpression,
  buildRaidViewSetPublicExpression,
  buildRaidViewSetTeamsExpression,
  parseRaidViewStatus,
  RAID_VIEW_SNAPSHOT_EXPRESSION,
  RAID_VIEW_SCRIPT_VERSION,
  RAID_VIEW_STATUS_EXPRESSION,
  RAID_VIEW_UNINSTALL_EXPRESSION,
} from "@ulr/cdp-adapter";

type Handler = (...args: unknown[]) => void;

class Obj {
  scene: Scene | null;
  visible = true;
  depth = 0;
  alpha = 1;
  scaleX = 1;
  width = 40;
  height = 12;
  displayWidth = 40;
  text = "";
  texture: { key: string };
  frame: { name: string | number };
  tint: unknown[] | null = null;
  tintFill: number | null = null;
  played: string | null = null;
  handlers = new Map<string, Handler[]>();
  anims = { stop: () => void (this.played = null) };
  input: { enabled: boolean } | null = null;
  constructor(
    scene: Scene,
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
  off(name: string, fn: Handler): this {
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((h) => h !== fn),
    );
    return this;
  }
  disableInteractive(): this {
    this.input = null;
    return this;
  }
  setDisplaySize(w: number): this {
    this.displayWidth = w;
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
    this.displayWidth = 32 * s;
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
  setColor(): this {
    return this;
  }
  setText(t: string): this {
    this.text = t;
    return this;
  }
  setInteractive(): this {
    this.input = { enabled: true };
    return this;
  }
  setBlendMode(): this {
    return this;
  }
  setFlipX(): this {
    return this;
  }
  setStrokeStyle(): this {
    return this;
  }
  setTexture(key: string, frame?: string | number): this {
    this.texture = { key };
    this.frame = { name: frame ?? 0 };
    return this;
  }
  setTint(...c: unknown[]): this {
    this.tint = c;
    return this;
  }
  setTintFill(c: number): this {
    this.tintFill = c;
    return this;
  }
  clearTint(): this {
    this.tint = null;
    this.tintFill = null;
    return this;
  }
  play(key: string): this {
    this.played = key;
    return this;
  }
}

interface RaidRow {
  profound_id: string;
  profound_mons: string;
  rarity: number;
  stage: number;
  treasure_level: number;
  profound_founder: string;
  level: number;
  name_tcn: string;
  pass?: string;
  defeat_name?: string;
  state: { type: string; turn: number }[];
  points?: { name: string; point: number; damage: number }[];
  hp?: number;
  hp_max?: number;
}

class Scene {
  status = 5; // RUNNING
  raid_data: RaidRow[] = [];
  raid_list: { name: Obj; id: string }[] = [];
  vortex: { base: Obj; icon: Obj; id: string }[] = [];
  raid_info: Obj;
  raid_info_name: Obj;
  raid_info_mons: Obj;
  raid_idx: number | null = null;
  raid_info_points: { name: Obj; point: Obj }[] = [];
  raid_info_page = 1;
  raid_list_page = 1;
  player = { name: "燈皇" };
  id = "player-id";
  socket = { sent: [] as unknown[][], emit: (...a: unknown[]) => void this.socket.sent.push(a) };
  itemInfo = {
    cmem: { 0: { name_tcn: "記憶的碎片" }, 4: { name_tcn: "死亡的碎片" } },
    ccoin: { 0: { name_tcn: "鐵幣" } },
    weapon: { 217: { name_tcn: "魔之刀身" } },
    quest: { 23: { name_tcn: "記憶的書籤(R1)" } },
  };
  made: Obj[] = [];
  scene = { isActive: () => this.status === 5, isSleeping: () => this.status === 7 };
  add = {
    image: (x: number, y: number, key: string, frame?: string | number) =>
      this.make("image", x, y, key, frame),
    sprite: (x: number, y: number, key: string, frame?: string | number) =>
      this.make("sprite", x, y, key, frame),
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
    this.raid_info = this.make("image", 380, 31, "raid_info");
    this.raid_info.visible = false;
    this.raid_info_name = this.make("text", 72, 48);
    this.raid_info_mons = this.make("text", 275, 60);
    this.raid_info_mons.width = 40;
  }
  make(kind: string, x: number, y: number, key = "", frame: string | number = 0): Obj {
    const o = new Obj(this, kind, x, y, key, frame);
    this.made.push(o);
    return o;
  }
  /** 官方 db_raid 之後：清單列與地圖渦整批重建。 */
  rebuild(): void {
    for (const r of this.raid_list) r.name.destroy();
    for (const v of this.vortex) {
      v.base.destroy();
      v.icon.destroy();
    }
    this.raid_list = this.raid_data.map((r, e) => {
      const name = this.add.text(11, 48 + e * 16, `Lv.${r.level} ${r.name_tcn}`);
      return { name, id: r.profound_id };
    });
    this.vortex = this.raid_data.map((r, s) => {
      const l = r.profound_founder === this.player.name ? "normal" : "another";
      return {
        base: this.add.sprite(100 + s * 50, 300, `vortex_${l}_base`, 0).setDepth(s - 20),
        icon: this.add
          .sprite(100 + s * 50, 300, `vortex_${l}`, `vortex_${l}[1].png`)
          .setDepth(s - 20),
        id: r.profound_id,
      };
    });
  }
  alive(): Obj[] {
    return this.made.filter((o) => o.scene !== null);
  }
  /** 官方 raid_support_list 的形狀：每列 6 個 text，第 0 個是 RAID 名、第 1 個是 BOSS。 */
  raid_support_list(list: { prf_code: string; prf_mons: string }[], y: number, page: number) {
    const texts: Obj[] = [];
    for (let n = 0; n < 12; n++) {
      const a = n + 12 * (page - 1);
      if (list[a] === undefined) continue;
      for (let k = 0; k < 6; k++) texts.push(this.add.text(121 + k * 100, y + 16 * n, "靈龜"));
    }
    return { texts, timer_event: null };
  }
}

class Textures {
  list: Record<string, { frames: Set<string> }> = {};
  canvases: string[] = [];
  constructor() {
    const add = (k: string, frames: string[]) => (this.list[k] = { frames: new Set(frames) });
    add("item_cmem", ["0", "1", "2", "3", "4"]);
    add("item_ccoin", ["0", "1", "2", "3", "4"]);
    add("item_weapon", ["217", "218", "219", "220"]);
    add("item_quest", ["23"]);
    add("item_other", ["0"]);
    add("state_tmp", ["mahi", "curse", "chaos", "movD9", "scare"]);
    add(
      "vortex_another",
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `vortex_another[${i}].png`),
    );
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
    if (t === undefined)
      return { key: "__MISSING", has: () => false, get: () => null, getFrameNames: () => [] };
    return {
      key: k,
      has: (f: string | number) => t.frames.has(String(f)),
      get: () => ({ width: 42, height: 32, cutX: 0, cutY: 0, source: { image: {} } }),
      getFrameNames: () => [...t.frames],
      add: () => undefined,
    };
  }
  createCanvas(k: string) {
    this.canvases.push(k);
    this.list[k] = { frames: new Set() };
    const t = this.list[k];
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      drawImage() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      arc() {},
      clip() {},
      rect() {},
      fillText() {},
      setLineDash() {},
    };
    return {
      getContext: () => ctx,
      refresh() {},
      add: (name: string) => t.frames.add(name),
    };
  }
}

class Game {
  scene: { keys: Record<string, Scene> };
  textures = new Textures();
  animsMade: string[] = [];
  anims = {
    exists: (k: string) => this.animsMade.includes(k),
    create: (cfg: { key: string }) => void this.animsMade.push(cfg.key),
  };
  constructor(public raid: Scene) {
    this.scene = { keys: { Raid: raid } };
  }
}

const ROW = (over: Partial<RaidRow>): RaidRow => ({
  profound_id: "2091-x",
  profound_mons: "mc1008_02",
  rarity: 1,
  stage: 1,
  treasure_level: 2091,
  profound_founder: "Owlic",
  level: 1,
  name_tcn: "靈龜",
  state: [],
  ...over,
});

let poll: (() => void) | null = null;

function run(window: Record<string, unknown>, expression: string): string {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "window",
    "document",
    "setInterval",
    "clearInterval",
    `return ${expression};`,
  ) as (...args: unknown[]) => string;
  return fn(
    window,
    { hidden: false },
    (cb: () => void) => {
      poll = cb;
      return 1;
    },
    () => {
      poll = null;
    },
  );
}

function setup(rows: RaidRow[]) {
  const raid = new Scene();
  raid.raid_data = rows;
  raid.rebuild();
  const game = new Game(raid);
  const window: Record<string, unknown> = { game };
  return { raid, game, window };
}

describe("渦房的獎勵標記", () => {
  it("表是 JSON.parse 出來的物件，不是字串", () => {
    const src = buildRaidViewPatchScript();
    expect(src).toMatch(/var CFG = JSON\.parse\(/);
  });

  it("清單列：名字右邊掛圖示；2096 是書籤妖", () => {
    const { raid, window } = setup([
      ROW({}),
      ROW({
        profound_id: "2096-y",
        profound_mons: "mc1004_02",
        rarity: 6,
        stage: 3,
        treasure_level: 2096,
        name_tcn: "妖精",
      }),
    ]);
    const status = parseRaidViewStatus(run(window, buildRaidViewPatchScript()));
    expect(status.installed).toBe(true);
    expect(status.version).toBe(RAID_VIEW_SCRIPT_VERSION);
    expect(status.inRaid).toBe(true);
    expect(status.rows).toBe(2);
    const deco0 = (raid.raid_list[0]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView;
    expect(deco0.objs.map((o) => o.frame.name)).toEqual(["frag_memory"]);
    const deco1 = (raid.raid_list[1]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView;
    expect(deco1.objs.map((o) => o.frame.name)).toEqual(["bookmark", "frag_memory", "fairy"]);
    // 圖示是從遊戲的卡面裁的：canvas 貼圖建了一張、frame 名都在
    expect((window.game as Game).textures.canvases).toContain("__ulrRaidIcons");
  });

  it("清單重建後舊的圖示收掉、新的 name 重掛", () => {
    const { raid, window } = setup([ROW({})]);
    run(window, buildRaidViewPatchScript());
    const before = (raid.raid_list[0]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView.objs;
    raid.rebuild();
    poll?.();
    expect(before.every((o) => o.scene === null)).toBe(true);
    const after = (raid.raid_list[0]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView.objs;
    expect(after.length).toBe(1);
    expect(after[0]!.scene).not.toBeNull();
  });

  it("BOSS 狀態：state_tmp 有圖用圖、詛咒印層數、到期時刻算剩餘", () => {
    const now = Date.now();
    const { raid, window } = setup([
      ROW({
        state: [
          { type: "curse", turn: 3 },
          { type: "chaos", turn: now + 125_000 },
          { type: "zzz", turn: now + 5_000 },
        ],
      }),
    ]);
    run(window, buildRaidViewPatchScript());
    const objs = (raid.raid_list[0]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView.objs;
    const kinds = objs.map(
      (o) =>
        `${o.kind}:${o.texture.key}:${o.kind === "text" ? "" : String(o.frame.name)}:${o.text}`,
    );
    expect(kinds[0]).toBe("image:__ulrRaidIcons:frag_memory:");
    expect(kinds[1]).toBe("image:state_tmp:curse:");
    expect(kinds[2]).toBe("text:::3");
    expect(kinds[3]).toBe("image:state_tmp:chaos:");
    expect(kinds[4]).toBe("text:::2m");
    // 認不得的代碼退回字
    expect(kinds[5]).toBe("text:::zzz");
  });

  it("地圖渦：換灰階貼圖上碎片色；自己開的紅框；拆掉換回去", () => {
    const { raid, window } = setup([
      ROW({}),
      ROW({
        profound_id: "2085-m",
        profound_mons: "mc1006_02",
        stage: 5,
        treasure_level: 2085,
        profound_founder: "燈皇",
      }),
    ]);
    run(window, buildRaidViewPatchScript());
    const [turtle, mine] = raid.vortex as [Scene["vortex"][0], Scene["vortex"][0]];
    expect(turtle.icon.texture.key).toBe("__ulrVortexGray");
    expect(turtle.icon.played).toBe("__ulrVortexGray");
    expect(turtle.icon.tint).toEqual([0xf5d33a]);
    expect(turtle.base.tintFill).toBeNull();
    expect(mine.icon.tint).toEqual([0xa855f7]);
    expect(mine.base.tintFill).toBe(0xe62020);

    expect(run(window, RAID_VIEW_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(turtle.icon.texture.key).toBe("vortex_another");
    expect(turtle.icon.played).toBe("vortex_another");
    expect(turtle.icon.tint).toBeNull();
    expect(mine.base.tintFill).toBeNull();
    expect(window["__ulrRaidView"]).toBeUndefined();
  });

  it("地圖渦被官方換回自己的貼圖（變藍）→ 下一輪重新上色，外光／標記不會疊兩份", () => {
    const { raid, window } = setup([
      ROW({
        profound_id: "2101-b",
        profound_mons: "mc1003_02",
        rarity: 6,
        stage: 1,
        treasure_level: 2101,
      }),
    ]);
    run(window, buildRaidViewPatchScript());
    const v = raid.vortex[0]!;
    expect(v.icon.texture.key).toBe("__ulrVortexGray");
    const marks = () =>
      raid.alive().filter((o) => o.texture.key === "__ulrRaidIcons" && o.y === v.base.y - 46);
    expect(marks().length).toBe(1);
    // 官方在同一顆 sprite 上換回藍色
    v.icon.setTexture("vortex_another", "vortex_another[1].png").clearTint();
    poll?.();
    expect(v.icon.texture.key).toBe("__ulrVortexGray");
    expect(v.icon.tint).toEqual([0x1a1a1a, 0x1a1a1a, 0x3ec95a, 0x3ec95a]);
    expect(marks().length).toBe(1);
    // 拆掉照樣換回官方的
    run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
    expect(v.icon.texture.key).toBe("vortex_another");
  });

  it("逐幀：官方關掉詳細面板的那一幀 postupdate 就收掉我們的鈕，不等輪詢", () => {
    const { raid, window } = setup([ROW({})]);
    const listeners = new Map<string, (() => void)[]>();
    (raid as unknown as { events: unknown }).events = {
      on: (n: string, fn: () => void) => listeners.set(n, [...(listeners.get(n) ?? []), fn]),
      off: (n: string, fn: () => void) =>
        listeners.set(
          n,
          (listeners.get(n) ?? []).filter((f) => f !== fn),
        ),
    };
    const frame = () => (listeners.get("postupdate") ?? []).forEach((f) => f());
    run(window, buildRaidViewPatchScript());
    expect(listeners.get("postupdate")?.length).toBe(1);
    raid.raid_info.visible = true;
    raid.raid_idx = 0;
    frame();
    const has = () => raid.alive().some((o) => o.text === "獎勵一覽");
    expect(has()).toBe(true);
    // 官方回到清單：同一幀的 postupdate 就收掉，沒有輪詢
    raid.raid_info.visible = false;
    raid.raid_idx = null;
    frame();
    expect(has()).toBe(false);
    // 重裝／拆掉不會留下多一個 listener
    run(window, buildRaidViewPatchScript());
    expect(listeners.get("postupdate")?.length).toBe(1);
    run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
    expect(listeners.get("postupdate")?.length).toBe(0);
  });

  it("素材渦：上半黑下半碎片色，上方掛那一樣素材的圖", () => {
    const { raid, window } = setup([
      ROW({
        profound_id: "2101-b",
        profound_mons: "mc1003_02",
        rarity: 6,
        stage: 1,
        treasure_level: 2101,
      }),
    ]);
    run(window, buildRaidViewPatchScript());
    const v = raid.vortex[0]!;
    expect(v.icon.tint).toEqual([0x1a1a1a, 0x1a1a1a, 0x3ec95a, 0x3ec95a]);
    const marks = raid
      .alive()
      .filter((o) => o.texture.key === "__ulrRaidIcons" && o.y === v.base.y - 46);
    expect(marks.map((m) => m.frame.name)).toEqual(["material_魔之刀身"]);
  });

  it("詳細面板：開著才畫，掛 TL、狀態與獎勵一覽鈕；關掉就收", () => {
    const { raid, window } = setup([ROW({ state: [{ type: "mahi", turn: Date.now() + 60_000 }] })]);
    run(window, buildRaidViewPatchScript());
    const texts = () =>
      raid
        .alive()
        .filter((o) => o.kind === "text")
        .map((o) => o.text);
    expect(texts()).not.toContain("獎勵一覽");
    raid.raid_info.visible = true;
    raid.raid_idx = 0;
    raid.raid_info_name.text = "Lv.1 靈龜";
    poll?.();
    expect(texts()).toContain("獎勵一覽");
    expect(texts()).toContain("TL 2091");
    const mahi = raid
      .alive()
      .filter((o) => o.texture.key === "state_tmp" && o.frame.name === "mahi");
    expect(mahi.map((o) => o.y)).toContain(68);
    // 點獎勵一覽 → 面板列四類獎勵
    const btn = raid.alive().find((o) => o.text === "獎勵一覽")!;
    btn.emit("pointerup");
    expect(texts()).toContain("排名獎勵");
    expect(texts()).toContain("1–10名  記憶的碎片 ×2");
    // 點面板外面關掉
    const zone = raid.alive().find((o) => o.kind === "zone")!;
    zone.emit("pointerup");
    expect(texts()).not.toContain("排名獎勵");
    raid.raid_info.visible = false;
    poll?.();
    expect(texts()).not.toContain("獎勵一覽");
  });

  it("詳細面板 Rank 下面：照自己名次列排名獎勵、參加獎勵；發現者才有發現那列", () => {
    const { raid, window, game } = setup([
      ROW({
        points: [
          { name: "A", point: 9, damage: 1 },
          { name: "燈皇", point: 5, damage: 1 },
        ],
      }),
    ]);
    // 碎片以外的道具用 item_<類別> 的圖：假一張 avatar 道具（2091 的參加獎勵是古代妙藥×2）
    (raid.itemInfo as Record<string, unknown>).avatar = { 1: { name_tcn: "古代妙藥", frame: 1 } };
    game.textures.list["item_avatar"] = { frames: new Set(["1"]) };
    run(window, buildRaidViewPatchScript());
    raid.raid_info.visible = true;
    raid.raid_idx = 0;
    poll?.();
    const at = (y: number) =>
      raid
        .alive()
        .filter((o) => o.kind === "text" && o.y === y)
        .map((o) => o.text);
    expect(at(83)).toEqual(expect.arrayContaining(["排名", "記憶的碎片 ×2"]));
    expect(at(101)).toEqual(expect.arrayContaining(["參加", "古代妙藥 ×2"]));
    expect(at(119)).not.toContain("發現");
    // 古代妙藥不在裁好的格子裡 → 直接用 item_avatar 那一格
    expect(
      raid
        .alive()
        .filter((o) => o.kind === "image" && o.y === 101)
        .map((o) => `${o.texture.key}:${String(o.frame.name)}`),
    ).toEqual(["item_avatar:1"]);
    // 名次掉出 1–10 以外的檔 / 變成發現者 → 重畫
    raid.raid_data = [
      ROW({
        profound_founder: "燈皇",
        points: [{ name: "燈皇", point: 5, damage: 1 }],
      }),
    ];
    poll?.();
    expect(at(119)).toEqual(expect.arrayContaining(["發現", "抽獎券(免費) ×3"]));
    expect(at(83)).toContain("記憶的碎片 ×2");
    // 0 分拿不到排名與參加：那兩列不畫；發現者的發現獎勵照列（往上遞補）
    raid.raid_data = [
      ROW({
        profound_founder: "燈皇",
        points: [
          { name: "A", point: 9, damage: 1 },
          { name: "燈皇", point: 0, damage: 0 },
        ],
      }),
    ];
    poll?.();
    const all = raid
      .alive()
      .filter((o) => o.kind === "text")
      .map((o) => o.text);
    expect(all).not.toContain("排名");
    expect(all).not.toContain("參加");
    expect(at(83)).toContain("發現");
    // 不是發現者又 0 分：什麼都不畫
    raid.raid_data = [ROW({ points: [{ name: "燈皇", point: 0, damage: 0 }] })];
    poll?.();
    expect(at(83)).toEqual([]);
  });

  it("SUPPORT：公開表對得到渦碼才畫，畫的東西塞回 texts", () => {
    const { raid, window } = setup([ROW({})]);
    run(window, buildRaidViewPatchScript());
    expect(
      run(
        window,
        buildRaidViewSetPublicExpression({
          abc: {
            tl: 2093,
            rarity: 1,
            stage: 3,
            mons: "mc1008_02",
            states: [{ type: "movD9", until: Date.now() + 90_000, count: null }],
          },
        }),
      ),
    ).toBe("ok");
    const proto = Object.getPrototypeOf(raid) as Scene;
    const out = proto.raid_support_list.call(
      raid,
      [
        { prf_code: "abc", prf_mons: "mc1008_02" },
        { prf_code: "unknown", prf_mons: "mc1003_02" },
      ],
      100,
      1,
    );
    // 兩列 × 6 個官方 text ＋ 我們的：藍碎圖示、movD9 圖、剩餘時間
    expect(parseRaidViewStatus(run(window, RAID_VIEW_STATUS_EXPRESSION)).reason).toBeNull();
    expect(out.texts.length).toBe(12 + 3);
    const ours = out.texts.slice(12);
    expect(
      ours.map(
        (o) => `${o.texture.key}:${o.kind === "text" ? "" : String(o.frame.name)}:${o.text}`,
      ),
    ).toEqual(["__ulrRaidIcons:frag_soul:", "state_tmp:movD9:", "::1m"]);
    // 圖示接在 RAID 名字（第 0 個）後面，狀態接在 BOSS（第 1 個）後面
    expect(ours[0]!.x).toBe(121 + out.texts[0]!.width + 4);
    expect(ours[1]!.x).toBe(221 + out.texts[1]!.width + 4);
    expect(ours.every((o) => o.alpha === 0)).toBe(true);
    // 拆掉後原型還原
    run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
    expect(
      (proto.raid_support_list as unknown as { __ulrRaidView?: unknown }).__ulrRaidView,
    ).toBeUndefined();
  });

  it("定時送 db_raid；離開渦房就不送、標記全收", () => {
    const { raid, window } = setup([ROW({})]);
    run(window, buildRaidViewPatchScript({ refreshMs: 0 }));
    // 裝上那一刻的 tick 就算一次
    expect(raid.socket.sent).toEqual([["db_raid", "player-id"]]);
    raid.status = 7; // 打渦去了：渦房 sleeping
    poll?.();
    poll?.();
    expect(raid.socket.sent.length).toBe(1);
    const st = parseRaidViewStatus(run(window, RAID_VIEW_STATUS_EXPRESSION));
    expect(st.inRaid).toBe(false);
    expect(st.rows).toBe(0);
    expect(raid.vortex[0]!.icon.texture.key).toBe("vortex_another");
  });

  it("過期的狀態不畫", () => {
    const { raid, window } = setup([ROW({ state: [{ type: "mahi", turn: Date.now() - 1000 }] })]);
    run(window, buildRaidViewPatchScript());
    const objs = (raid.raid_list[0]!.name as unknown as { __ulrRaidView: { objs: Obj[] } })
      .__ulrRaidView.objs;
    expect(objs.map((o) => o.texture.key)).toEqual(["__ulrRaidIcons"]);
  });

  it("重裝先卸掉舊的 canvas 貼圖，新版的畫法才會生效", () => {
    const { window, game } = setup([ROW({})]);
    run(window, buildRaidViewPatchScript());
    expect(game.textures.removed).toEqual([]);
    run(window, buildRaidViewPatchScript());
    expect(game.textures.removed).toContain("__ulrRaidIcons");
    expect(game.textures.exists("__ulrRaidIcons")).toBe(true);
  });

  describe("誰上了狀態（唯一候選）", () => {
    const P = (a: number, b: number) => [
      { name: "A", point: a, damage: 0 },
      { name: "B", point: b, damage: 0 },
    ];
    const credit = (window: Record<string, unknown>) =>
      (
        window["__ulrRaidStatusLog"] as {
          raids: Record<string, { credit: unknown; events: number; unique: number }>;
        }
      ).raids["2091-x"]!;

    it("狀態新出現、只有一個人分數動 → 記他；兩個人同時動 → 不記", () => {
      const now = Date.now();
      const { raid, window } = setup([ROW({ points: P(0, 0) })]);
      run(window, buildRaidViewPatchScript());
      raid.raid_data = [ROW({ points: P(100, 0), state: [{ type: "scare", turn: now + 60_000 }] })];
      poll?.();
      expect(credit(window)).toMatchObject({ credit: { A: { scare: 1 } }, events: 1, unique: 1 });
      // 延長（到期時刻往後推），但 A、B 都動了 → 事件算、不記人
      raid.raid_data = [
        ROW({ points: P(200, 50), state: [{ type: "scare", turn: now + 120_000 }] }),
      ];
      poll?.();
      expect(credit(window)).toMatchObject({ credit: { A: { scare: 1 } }, events: 2, unique: 1 });
      // 詛咒層數變多、只有 B 動 → 記 B
      raid.raid_data = [
        ROW({
          points: P(200, 80),
          state: [
            { type: "scare", turn: now + 120_000 },
            { type: "curse", turn: 2 },
          ],
        }),
      ];
      poll?.();
      raid.raid_data = [
        ROW({
          points: P(200, 90),
          state: [
            { type: "scare", turn: now + 120_000 },
            { type: "curse", turn: 3 },
          ],
        }),
      ];
      poll?.();
      expect(credit(window)).toMatchObject({
        credit: { A: { scare: 1 }, B: { curse: 2 } },
        unique: 3,
      });
    });

    it("同一份 raid_data 不重算；推測紀錄重裝不清", () => {
      const now = Date.now();
      const { raid, window } = setup([ROW({ points: P(0, 0) })]);
      run(window, buildRaidViewPatchScript());
      raid.raid_data = [ROW({ points: P(10, 0), state: [{ type: "scare", turn: now + 60_000 }] })];
      poll?.();
      poll?.();
      expect(credit(window).unique).toBe(1);
      run(window, buildRaidViewPatchScript());
      expect(credit(window).unique).toBe(1);
    });

    it("排行榜：名字與分數之間掛狀態圖，名字太長就截短", () => {
      const now = Date.now();
      const { raid, window } = setup([ROW({ points: P(0, 0) })]);
      run(window, buildRaidViewPatchScript());
      raid.raid_data = [
        ROW({
          points: [
            { name: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", point: 5, damage: 1 },
            { name: "B", point: 0, damage: 0 },
          ],
          state: [{ type: "scare", turn: now + 60_000 }],
        }),
      ];
      poll?.();
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      const pts = raid.raid_data[0]!.points!;
      raid.raid_info_points = pts.map((q, e) => {
        const name = raid.add.text(552, 48 + e * 16, q.name);
        const point = raid.add.text(728, 48 + e * 16, "[5pts.]");
        point.width = 40;
        return { name, point };
      });
      poll?.();
      const first = raid.raid_info_points[0]!;
      const icons = raid
        .alive()
        .filter((o) => o.texture.key === "state_tmp" && o.y === first.name.y && o.scaleX === 0.4);
      expect(icons.map((o) => o.x)).toEqual([728 - 40 - 3 - 13]);
      expect(first.name.text.endsWith("...")).toBe(true);
      // 沒被記的人不掛
      expect(
        raid
          .alive()
          .filter(
            (o) =>
              o.texture.key === "state_tmp" &&
              o.y === raid.raid_info_points[1]!.name.y &&
              o.scaleX === 0.4,
          ),
      ).toEqual([]);
    });

    it("傷害統計：每人一列，分數／傷害／佔比；自己那頁先翻到", () => {
      const { raid, window } = setup([
        ROW({
          points: [
            { name: "A", point: 300, damage: 30 },
            { name: "燈皇", point: 100, damage: 10 },
          ],
          hp: 900,
          hp_max: 1000,
        }),
      ]);
      run(window, buildRaidViewPatchScript());
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      raid.raid_info_name.text = "Lv.1 靈龜";
      poll?.();
      raid
        .alive()
        .find((o) => o.text === "傷害統計")!
        .emit("pointerup");
      const texts = raid
        .alive()
        .filter((o) => o.kind === "text")
        .map((o) => o.text);
      expect(texts).toContain("參加 2 人・總傷害 40・BOSS 已損 100");
      expect(texts).toContain("75.0%");
      expect(texts).toContain("25.0%");
      expect(texts).toContain("1 / 1");
    });

    it("傷害統計翻頁：一頁 10 人，到第一頁／到最後一頁；OK 關掉", () => {
      const points = Array.from({ length: 25 }, (_, i) => ({
        name: i === 22 ? "燈皇" : `P${i}`,
        point: 100 - i,
        damage: 1,
      }));
      const { raid, window } = setup([ROW({ points, hp: 0, hp_max: 25 })]);
      run(window, buildRaidViewPatchScript());
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      raid.raid_info_name.text = "Lv.1 靈龜";
      poll?.();
      raid
        .alive()
        .find((o) => o.text === "傷害統計")!
        .emit("pointerup");
      const texts = () =>
        raid
          .alive()
          .filter((o) => o.kind === "text")
          .map((o) => o.text);
      // 自己在第 23 名 → 先翻到第 3 頁；那一頁只有 5 列
      expect(texts()).toContain("3 / 3");
      expect(texts()).toContain("燈皇");
      expect(texts()).not.toContain("P0");
      // 翻頁鈕沒有 btn_arrow 貼圖時退回字；到第一頁是左邊最外面那一組（兩個疊著）
      const nav = (label: string, x: number) =>
        raid.alive().find((o) => o.text === label && Math.abs(o.x - x) <= 4 && o.visible)!;
      nav("‹", 380 - 78).emit("pointerup");
      expect(texts()).toContain("1 / 3");
      expect(texts()).toContain("P0");
      // 第一頁：往前的鈕藏起來
      expect(raid.alive().some((o) => o.text === "‹" && o.visible)).toBe(false);
      nav("›", 380 + 50).emit("pointerup");
      expect(texts()).toContain("2 / 3");
      nav("›", 380 + 78).emit("pointerup");
      expect(texts()).toContain("3 / 3");
      expect(raid.alive().some((o) => o.text === "›" && o.visible)).toBe(false);
      // OK 關掉整張
      raid
        .alive()
        .find((o) => o.text === "OK")!
        .emit("pointerup");
      expect(texts()).not.toContain("傷害統計  Lv.1 靈龜");
      expect(texts()).not.toContain("3 / 3");
    });

    it("自己重讀回來、詳細面板開著 → 照官方那條路重畫排行榜並翻回原頁", () => {
      const { raid, window } = setup([ROW({ points: P(0, 0) })]);
      const calls: string[] = [];
      const r = raid as unknown as { raid_list_pointerup: () => void; raid_info_func: () => void };
      r.raid_list_pointerup = () => {
        calls.push("pointerup");
        raid.raid_info_page = 1;
      };
      r.raid_info_func = () => void calls.push("func:" + raid.raid_info_page);
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      raid.raid_info_page = 3;
      raid.raid_info_points = Array.from({ length: 7 }, () => ({
        name: raid.add.text(552, 48, "x"),
        point: raid.add.text(728, 48, "y"),
      }));
      run(window, buildRaidViewPatchScript({ refreshMs: 0 }));
      expect(calls).toEqual([]);
      raid.raid_data = [ROW({ points: P(1, 0) })];
      poll?.();
      expect(calls).toEqual(["pointerup", "func:2"]);
    });
  });

  describe("更新鈕（⑩）", () => {
    it("Profound 計數下面一顆 Refresh：照官方重進渦房送三則讀取、回報托盤；冷卻中再按不算；離開渦房就收", () => {
      const { raid, window } = setup([ROW({})]);
      const profound = raid.add.text(477, 530, "1");
      (raid as unknown as { profound_text: Obj }).profound_text = profound;
      const reports: { type: string }[] = [];
      window["__ulrCompanionReport"] = (s: string) => reports.push(JSON.parse(s));
      run(window, buildRaidViewPatchScript({ bindingName: "__ulrCompanionReport" }));
      const btn = () => raid.alive().find((o) => o.text === "Refresh");
      expect(btn()).toMatchObject({ x: 485, y: 539 });
      expect(btn()!.input).not.toBeNull();

      raid.socket.sent.length = 0;
      btn()!.emit("pointerup");
      expect(raid.socket.sent).toEqual([
        ["db_player", "player-id"],
        ["db_raid", "player-id"],
        ["db_raid_reward", "player-id"],
      ]);
      expect(reports.filter((r) => r.type === "raid-refresh")).toHaveLength(1);
      expect(btn()!.alpha).toBe(0.5);

      btn()!.emit("pointerup");
      expect(raid.socket.sent).toHaveLength(3);

      raid.status = 7;
      poll?.();
      expect(btn()).toBeUndefined();
    });
  });

  describe("打渦隊伍（⑨）", () => {
    const BINDING = "__ulrCompanionReport";
    const DECK = {
      chara: ["cc043", "cc011", "cc033"],
      charaIndex: [426, 109, 329],
      eventIndex: [80, 80, 67, 67, 67, 67, 20, 41, 70, 70, 67, 67, 67, 80, 80, 80, 67, 67],
      weapon: [170, 136, 135],
      cost: 110,
    };
    const TEAM = (damage: number, over: Record<string, unknown> = {}) => ({
      chara: DECK.chara,
      charaIndex: DECK.charaIndex,
      weapon: DECK.weapon,
      eventIndex: DECK.eventIndex,
      battles: 2,
      turns: 6,
      ap: 6,
      damage,
      best: damage,
      points: 4321,
      ...over,
    });
    const withSocket = (raid: Scene) => {
      const listeners = new Map<string, Handler[]>();
      const socket = Object.assign(raid.socket, {
        on: (name: string, fn: Handler) =>
          void listeners.set(name, [...(listeners.get(name) ?? []), fn]),
        off: (name: string, fn: Handler) =>
          void listeners.set(
            name,
            (listeners.get(name) ?? []).filter((h) => h !== fn),
          ),
      });
      const fire = (name: string, config: unknown = {}) => {
        for (const h of listeners.get(name) ?? []) h(config, 1, 1);
      };
      return { socket, listeners, fire };
    };
    const battleRow = (damage: number, over: Partial<RaidRow> = {}, point = 100) =>
      Object.assign(
        ROW({
          pass: "tfqLuvEDegF3",
          points: [
            { name: "A", point: 900, damage: 500 },
            { name: "燈皇", point, damage },
          ],
          ...over,
        }),
        { ap_spend: 2, limit: Date.now() + 3_600_000 },
      );
    const withReports = (window: Record<string, unknown>) => {
      const reports: { type: string; [k: string]: unknown }[] = [];
      window[BINDING] = (payload: string) => reports.push(JSON.parse(payload));
      return reports;
    };
    const arm = (raid: Scene) => {
      const r = raid as unknown as Record<string, unknown>;
      r.raid_id = "2091-x";
      r.raid_turn = 3;
      r.deck_now = 1;
      r.deck1 = DECK;
    };

    it("raid_ready 開打 → 離開渦房 → 回來後清單換過一份才量傷害；AP = ap_spend × 回合", () => {
      const { raid, window } = setup([battleRow(10)]);
      const { fire, listeners } = withSocket(raid);
      const reports = withReports(window);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      expect(listeners.get("raid_ready")?.length).toBe(1);
      arm(raid);
      fire("raid_ready");
      // 還沒離開渦房：清單換了也不量（開打前那一問晚到的回應）
      raid.raid_data = [battleRow(10)];
      poll?.();
      raid.status = 7;
      poll?.();
      raid.status = 5;
      raid.raid_data = [battleRow(10)];
      poll?.(); // 回來第一眼：先記著
      expect(reports.filter((r) => r.type === "raid-battle")).toEqual([]);
      raid.raid_data = [battleRow(250, {}, 5590)];
      poll?.();
      const battles = reports.filter((r) => r.type === "raid-battle");
      expect(battles).toHaveLength(1);
      expect(battles[0]).toMatchObject({
        code: "tfqLuvEDegF3",
        player: "燈皇",
        turns: 3,
        ap: 6,
        damage: 240,
        points: 5490,
        deck: {
          chara: DECK.chara,
          charaIndex: DECK.charaIndex,
          weapon: DECK.weapon,
          eventIndex: DECK.eventIndex,
        },
      });
      expect((battles[0]!.deck as Record<string, unknown>).cost).toBeUndefined();
      // 清單再換、分數沒動 → 不重複回報
      raid.raid_data = [battleRow(250, {}, 5590)];
      poll?.();
      expect(reports.filter((r) => r.type === "raid-battle")).toHaveLength(1);
      // 分數晚到（提早離場那種）→ 同一個 at 補報
      raid.raid_data = [battleRow(280, {}, 6000)];
      poll?.();
      const again = reports.filter((r) => r.type === "raid-battle");
      expect(again).toHaveLength(2);
      expect(again[1]).toMatchObject({ at: battles[0]!.at, damage: 270, points: 5900, turns: 3 });
    });

    it("回合數以伺服器的 turn_limit 為準；牌組角色跟伺服器那份對不上就用伺服器的、事件卡留空", () => {
      const { raid, window } = setup([battleRow(0)]);
      const { fire } = withSocket(raid);
      const reports = withReports(window);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      poll?.();
      arm(raid);
      delete (raid as unknown as Record<string, unknown>).raid_turn; // 不是按鈕送的：場景上沒有
      fire("raid_ready", {
        turn_limit: 2,
        room_playerAdeck: {
          chara: ["cc001", null, null],
          charaIndex: [1, null, null],
          weapon: [5, null, null],
          cost: 3,
        },
      });
      raid.status = 7;
      poll?.();
      raid.status = 5;
      poll?.();
      raid.raid_data = [battleRow(29, {}, 6482)];
      poll?.();
      const [b] = reports.filter((r) => r.type === "raid-battle");
      expect(b).toMatchObject({
        turns: 2,
        ap: 4,
        damage: 29,
        deck: {
          chara: ["cc001", null, null],
          charaIndex: [1, null, null],
          weapon: [5, null, null],
        },
      });
      expect((b!.deck as { eventIndex: unknown[] }).eventIndex).toEqual(Array(18).fill(null));
    });

    it("渦不見了（打死被刪）就不回報；重裝換 socket 監聽不重複", () => {
      const { raid, window } = setup([battleRow(10)]);
      const { fire, listeners } = withSocket(raid);
      const reports = withReports(window);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      poll?.();
      expect(listeners.get("raid_ready")?.length).toBe(1);
      arm(raid);
      fire("raid_ready");
      raid.status = 7;
      poll?.();
      raid.status = 5;
      poll?.();
      raid.raid_data = [ROW({ profound_id: "other", pass: "zzz" })];
      poll?.();
      expect(reports.filter((r) => r.type === "raid-battle")).toEqual([]);
      run(window, RAID_VIEW_UNINSTALL_EXPRESSION);
      expect(listeners.get("raid_ready")?.length).toBe(0);
    });

    function rankingSetup(teams: Record<string, unknown>) {
      const { raid, game, window } = setup([battleRow(10)]);
      game.textures.list["edit_icon"] = { frames: new Set(["0"]) };
      game.textures.list["btn_arrow"] = { frames: new Set(["0", "1"]) };
      run(
        window,
        buildRaidViewPatchScript({
          teams: { tfqLuvEDegF3: teams } as never,
        }),
      );
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      raid.raid_info_name.text = "Lv.1 靈龜";
      const pts = raid.raid_data[0]!.points!;
      raid.raid_info_points = pts.map((q, e) => {
        const name = raid.add.text(552, 48 + e * 16, q.name);
        const point = raid.add.text(728, 48 + e * 16, "[5pts.]");
        point.width = 40;
        return { name, point };
      });
      poll?.();
      const texts = () =>
        raid
          .alive()
          .filter((o) => o.kind === "text")
          .map((o) => o.text);
      return { raid, window, texts };
    }

    it("排行榜：有隊伍的名字掛牌盒、點得下去；多支先列清單，點一列看整副，箭頭回清單", () => {
      const { raid, texts } = rankingSetup({
        A: [TEAM(300), TEAM(1200, { chara: ["cc001", null, null] })],
      });
      const [a, me] = raid.raid_info_points;
      const boxes = raid.alive().filter((o) => o.texture.key === "edit_icon");
      expect(boxes.map((o) => o.y)).toEqual([a!.name.y]);
      expect(a!.name.input).not.toBeNull();
      expect(me!.name.input).toBeNull();

      a!.name.emit("pointerup");
      expect(texts()).toContain("A 的隊伍");
      expect(texts()).toContain("傷害/AP");
      expect(texts()).toContain("1 / 1");
      // 傷害高的在前：1,200 那支是第一列
      const values = texts();
      expect(values.indexOf("1,200")).toBeLessThan(values.indexOf("300"));
      expect(values).toContain("200"); // 1200 / 6 AP

      const rows = raid.alive().filter((o) => o.kind === "zone" && o.x === 108 && o.input);
      expect(rows).toHaveLength(2);
      rows[0]!.emit("pointerup");
      expect(texts()).toContain("單場最高");
      expect(texts()).toContain("平均");
      expect(texts()).toContain("600"); // 每場平均傷害
      expect(texts()).not.toContain("1 / 1");
      const back = raid
        .alive()
        .find((o) => o.texture.key === "btn_arrow" && o.x === 380 - 288 + 24 && o.visible)!;
      back.emit("pointerup");
      expect(texts()).toContain("1 / 1");
      expect(texts()).not.toContain("單場最高");
    });

    it("只有一支就直接開整副（沒有回清單的箭頭）；隊伍表換掉後名字不能點了", () => {
      const { raid, window, texts } = rankingSetup({ 燈皇: [TEAM(50)] });
      const me = raid.raid_info_points[1]!;
      me.name.emit("pointerup");
      expect(texts()).toContain("燈皇 的隊伍");
      expect(texts()).toContain("單場最高");
      expect(
        raid.alive().some((o) => o.texture.key === "btn_arrow" && o.x === 380 - 288 + 24),
      ).toBe(false);
      raid
        .alive()
        .find((o) => o.text === "OK")!
        .emit("pointerup");

      expect(run(window, buildRaidViewSetTeamsExpression({}))).toBe("ok");
      poll?.();
      expect(raid.alive().some((o) => o.texture.key === "edit_icon")).toBe(false);
      expect(me.name.input).toBeNull();
      expect(me.name.handlers.get("pointerup") ?? []).toEqual([]);
    });

    it("傷害統計裡有隊伍的名字也點得下去", () => {
      const { raid, texts } = rankingSetup({ A: [TEAM(300)] });
      raid
        .alive()
        .find((o) => o.text === "傷害統計")!
        .emit("pointerup");
      const cell = raid.alive().find((o) => o.text === "A" && o.x === 380 - 288 + 20 + 30)!;
      expect(cell.input).not.toBeNull();
      cell.emit("pointerup");
      expect(texts()).toContain("A 的隊伍");
    });

    it("快照帶排行榜名字（給托盤算玩家 key）", () => {
      const { window } = setup([battleRow(10)]);
      run(window, buildRaidViewPatchScript());
      const snap = JSON.parse(run(window, RAID_VIEW_SNAPSHOT_EXPRESSION)) as {
        raids: { players: string[] }[];
      };
      expect(snap.raids[0]!.players).toEqual(["A", "燈皇"]);
    });
  });

  describe("自動刪除死渦", () => {
    const BINDING = "__ulrCompanionReport";
    const dead = (over: Partial<RaidRow> = {}) =>
      ROW({
        profound_id: "2079-dead",
        hp: 0,
        hp_max: 3500,
        name_tcn: "黑死獸",
        profound_founder: "白無垢",
        pass: "xJN1cWD6rxMq",
        ...over,
      });
    const deletes = (raid: Scene) => raid.socket.sent.filter((m) => m[0] === "db_raid_delete");
    const withReports = (window: Record<string, unknown>) => {
      const reports: { type: string; [k: string]: unknown }[] = [];
      window[BINDING] = (payload: string) => reports.push(JSON.parse(payload));
      return reports;
    };

    it("關著不刪；打開後沒有自己的份（榜上沒分、不是發現者）馬上刪，一次一個", () => {
      const { raid, window } = setup([
        ROW({ hp: 100 }),
        dead(),
        dead({ profound_id: "2080-dead" }),
      ]);
      const reports = withReports(window);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      expect(deletes(raid)).toEqual([]);
      run(window, buildRaidViewSetAutoDeleteExpression({ enabled: true, prompt: true }));
      raid.raid_list_page = 2;
      poll?.();
      poll?.();
      expect(deletes(raid)).toEqual([["db_raid_delete", "player-id", "2079-dead"]]);
      expect(raid.raid_list_page).toBe(1);
      expect(reports.find((r) => r.type === "raid-auto-delete")).toMatchObject({
        name: "黑死獸",
        reason: "no-reward",
      });
      // db_raid 回來（換了一份 raid_data）才刪下一個
      raid.raid_data = [ROW({ hp: 100 }), dead({ profound_id: "2080-dead" })];
      poll?.();
      expect(deletes(raid).map((m) => m[2])).toEqual(["2079-dead", "2080-dead"]);
    });

    it("有自己一份（榜上有分或自己是發現者）→ HP 歸零照樣馬上刪，不等結算、不問伺服器", () => {
      const { raid, window } = setup([
        dead({ points: [{ name: "燈皇", point: 500, damage: 3 }] }),
        dead({
          profound_id: "mine",
          profound_founder: "燈皇",
          name_tcn: "靈龜",
          pass: "AAAAAAAAAAAA",
        }),
      ]);
      const reports = withReports(window);
      run(
        window,
        buildRaidViewPatchScript({
          bindingName: BINDING,
          autoDelete: { enabled: true, prompt: true },
        }),
      );
      poll?.();
      expect(deletes(raid).map((m) => m[2])).toEqual(["2079-dead"]);
      expect(reports.find((r) => r.type === "raid-auto-delete")).toMatchObject({
        reason: "had-reward",
      });
      raid.raid_data = [raid.raid_data[1]!];
      poll?.();
      expect(deletes(raid).map((m) => m[2])).toEqual(["2079-dead", "mine"]);
      // 玩家訂的：盡量不對官方伺服器多送請求 —— 刪渦以外什麼都不送
      expect(raid.socket.sent.some((m) => m[0] === "db_raid_reward")).toBe(false);
    });

    it("死渦面板：關著時有「自動刪除死渦」鈕；遊戲裡再關掉 → 鈕收起、回報 prompt:false", () => {
      const { raid, window } = setup([dead({ points: [{ name: "燈皇", point: 1, damage: 0 }] })]);
      const reports = withReports(window);
      run(window, buildRaidViewPatchScript({ bindingName: BINDING }));
      raid.raid_info.visible = true;
      raid.raid_idx = 0;
      poll?.();
      const on = raid.alive().find((o) => o.text === "自動刪除死渦")!;
      expect(on).toBeTruthy();
      on.emit("pointerup");
      expect(reports.at(-1)).toEqual({
        type: "raid-auto-delete-setting",
        enabled: true,
        prompt: true,
      });
      poll?.();
      const off = raid.alive().find((o) => o.text === "停用自動刪除")!;
      expect(off).toBeTruthy();
      off.emit("pointerup");
      expect(reports.at(-1)).toEqual({
        type: "raid-auto-delete-setting",
        enabled: false,
        prompt: false,
      });
      poll?.();
      expect(raid.alive().some((o) => o.text === "自動刪除死渦" || o.text === "停用自動刪除")).toBe(
        false,
      );
      // 活著的渦不出現這顆鈕
      run(window, buildRaidViewSetAutoDeleteExpression({ enabled: false, prompt: true }));
      raid.raid_data = [ROW({ hp: 10 })];
      poll?.();
      expect(raid.alive().some((o) => o.text === "自動刪除死渦")).toBe(false);
    });
  });

  it("重裝先拆再裝：同一個 name 不會掛兩份", () => {
    const { raid, window } = setup([ROW({})]);
    run(window, buildRaidViewPatchScript());
    run(window, buildRaidViewPatchScript());
    const icons = raid.alive().filter((o) => o.texture.key === "__ulrRaidIcons");
    expect(icons.length).toBe(1);
  });
});
