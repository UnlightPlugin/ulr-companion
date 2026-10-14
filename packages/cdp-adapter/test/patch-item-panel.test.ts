/**
 * 物品欄：點得到外面、渦房排序、渦房的物品捷徑
 *
 * 把 `buildItemPanelPatchScript()` 產出來的那一串字原封不動 `new Function` 起來跑，
 * 假環境照 2026-09-26 實機讀到的形狀：物品鈕先 add.zone(760x680, depth 900) 再 new 面板、
 * panel_open()；面板的 get_item_data() 回 { item_id, quantity }；右下角三顆官方鈕是同一個
 * 類別（button_base ＋ button_icon）。
 *
 * 要抓的坑：
 * 1. 開窗只關「緊接在面板前面、同 depth 的 760x680 zone」的點擊；別的開法不碰
 * 2. 已經有一張開著時再開＝關（新的當場拆、舊的走 panel_close）
 * 3. 渦房才重排：水 → 渦二 → 渦一 → 其他照官方；增益類與日記本不列。大廳不動
 * 4. 捷徑：官方兩顆藏起來、點擊關掉；古代、精靈佔原位（SUPPORT 上面不放）；探知機有才畫、在渦碼鈕上方
 * 5. 數量 0 半透明點不下去；點下去走場景自己的 use_avatar_item
 * 6. 關捷徑／拆除：官方鈕放回來、原型還原
 * 7. 任務房的物品欄只藏增益類、不重排；任務房捷徑貼著 FRIENDLIST 往上疊、通行證標名字、官方鈕不動
 * 8. 兩房的捷徑各自開關，關一邊不拆另一邊
 * 9. 物品欄開著時開搜索框：search_* 抬到面板上面（遮罩不動），物品欄關了放回去
 * 10. 迪城（Match、迪特赫姆頻道）：FRIENDLIST 上方疊三種水；亞城／還沒選頻道不畫
 * 11. 迪城的 GEM UP：大廳那張圖＋倒數＋百分比；沒有（或過期的）GEM 加成不畫；圖是自己抓的、拆除時移掉
 * 12. 獎勵遊戲：猜錯才畫一顆；差距小先用剛好夠的石楠，其餘照優先順序；按下去走 use_bonus_item（沒開物品欄墊替身）
 * 13. 獎勵遊戲的圓鈕：官方 bonus_item 抹掉字；左上（縮小轉向、只認圓）或蓋在使用物品上（跟著淡入淡出）；
 *     做不出底圖時退回物品欄格子
 * 14. 自動爬星：只叫場景自己的方法；稀有的先、前 X 層從開局層算、野生卡不算；沒目標／沒道具交還給玩家
 *     （不收卡、不結束遊戲）；下一層是目標且好猜才先用四葉草
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BONUS_CLIMB_STEP_COST,
  BONUS_CLIMB_WIN_RATE,
  bonusGuessWinRate,
  buildItemPanelPatchScript,
  buildItemPanelSetBonusClimbExpression,
  buildItemPanelSetBonusOrderExpression,
  buildItemPanelSetBonusPlaceExpression,
  buildItemPanelSetPartExpression,
  buildItemPanelSetShortcutExpression,
  DEFAULT_BONUS_CLIMB_GOALS,
  ITEM_PANEL_SCRIPT_VERSION,
  ITEM_PANEL_STATUS_EXPRESSION,
  ITEM_PANEL_UNINSTALL_EXPRESSION,
  normalizeBonusClimb,
  parseItemPanelStatus,
  RAID_DETECTOR_1,
  RAID_DETECTOR_2,
} from "@ulr/cdp-adapter";
import type { BonusClimbConfig, BonusClimbGoals } from "@ulr/cdp-adapter";

type Fn = (...a: unknown[]) => unknown;

class Scene {
  children = { list: [] as Obj[] };
  input = { enabled: true };
  tweens = { killTweensOf: vi.fn(), timeScale: 1 };
  time = { timeScale: 1 };
  textures = {
    get: (_key: string) => ({ has: (frame: string) => frame !== "item_999" }),
    exists: () => false,
  };
  sys: { settings: { key: string } };
  scene = { isActive: () => this.active, isSleeping: () => false };
  active = true;
  add = {
    text: (x: number, y: number, text: string) => {
      const o = new Obj(this, x, y);
      o.text = text;
      return o;
    },
    zone: (x: number, y: number, w: number, h: number) => {
      const o = new Obj(this, x, y);
      o.type = "Zone";
      o.width = w;
      o.height = h;
      return o;
    },
    image: (x: number, y: number, key: string, frame: string) => {
      const o = new Obj(this, x, y);
      o.type = "Image";
      o.frame = { name: `${key}/${frame}` };
      return o;
    },
    sprite: (x: number, y: number, key: string, frame: number) => {
      const o = new Obj(this, x, y);
      o.type = "Sprite";
      o.frame = { name: `${key}/${frame}` };
      return o;
    },
    container: (x: number, y: number) => {
      const o = new Obj(this, x, y);
      o.type = "Container";
      return o;
    },
  };
  [k: string]: unknown;
  constructor(key: string) {
    this.sys = { settings: { key } };
  }
}

class Obj {
  type = "Obj";
  scene: Scene | undefined;
  visible = true;
  alpha = 1;
  depth = 0;
  width = 10;
  height = 10;
  scale = 1;
  text: string | undefined;
  frame = { name: "" };
  input: { enabled: boolean } | null = null;
  list: Obj[] = [];
  #on = new Map<string, Fn[]>();
  constructor(
    scene: Scene,
    public x = 0,
    public y = 0,
  ) {
    this.scene = scene;
    scene.children.list.push(this);
  }
  setVisible(v: boolean) {
    this.visible = v;
    return this;
  }
  setAlpha(a: number) {
    this.alpha = a;
    return this;
  }
  setDepth(d: number) {
    this.depth = d;
    return this;
  }
  setPosition(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(s: number) {
    this.scale = s;
    return this;
  }
  setOrigin() {
    return this;
  }
  setStroke() {
    return this;
  }
  setText(t: string) {
    this.text = t;
    return this;
  }
  setFrame(frame: number) {
    this.frame = { name: this.frame.name.replace(/\/[^/]*$/, `/${frame}`) };
    return this;
  }
  setTexture(_key: string, frame: string) {
    this.frame = { name: frame };
    this.width = 50;
    this.height = 100;
    return this;
  }
  angle = 0;
  setAngle(a: number) {
    this.angle = a;
    return this;
  }
  hitArea: unknown = null;
  hitAreaCallback: Fn | null = null;
  setInteractive(shape?: unknown, cb?: Fn) {
    this.input = { enabled: true };
    this.hitArea = shape ?? null;
    this.hitAreaCallback = cb ?? null;
    return this;
  }
  disableInteractive() {
    if (this.input) this.input.enabled = false;
    return this;
  }
  add(o: Obj) {
    const at = this.scene!.children.list.indexOf(o);
    if (at >= 0) this.scene!.children.list.splice(at, 1);
    this.list.push(o);
    return this;
  }
  on(ev: string, fn: Fn) {
    this.#on.set(ev, [...(this.#on.get(ev) ?? []), fn]);
    return this;
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of this.#on.get(ev) ?? []) fn(...a);
  }
  destroy() {
    const sc = this.scene;
    if (!sc) return;
    const at = sc.children.list.indexOf(this);
    if (at >= 0) sc.children.list.splice(at, 1);
    this.scene = undefined;
  }
}

/** 官方右下角那顆鈕（icon_item／icon_friend／raid_support_btn 同一個類別）。 */
class MenuButton extends Obj {
  button_base: Obj;
  button_icon: Obj;
  constructor(scene: Scene, x: number, y: number, icon: string) {
    super(scene, x, y);
    this.type = "Container";
    this.button_base = new Obj(scene).setInteractive();
    this.button_icon = new Obj(scene);
    this.button_icon.frame = { name: `${icon}_out` };
    this.add(this.button_base);
    this.add(this.button_icon);
    // 官方：pointerdown → pointerup 才 emit click；測試直接 emit
  }
}

let ITEMS: { item_id: number; quantity: number }[] = [];

/** 物品欄面板。官方的 get_item_data 已經照 id → priority 排好。 */
class ItemPanel extends Obj {
  panel_base: Obj;
  shown: number[] = [];
  closed = false;
  constructor(scene: Scene) {
    super(scene, 630, 428);
    this.type = "Container";
    this.panel_base = new Obj(scene).setInteractive();
    this.add(this.panel_base);
    this.show_item();
  }
  get_item_data() {
    return ITEMS.map((x) => ({ ...x }));
  }
  show_item() {
    this.shown = (this.get_item_data() as { item_id: number }[]).map((x) => x.item_id);
  }
  panel_open() {}
  panel_close() {
    this.closed = true;
    this.panel_base.disableInteractive();
  }
}

const ROWS = [
  { id: 1, kind: 0, priority: 100 },
  { id: 2, kind: 0, priority: 100 },
  { id: 3, kind: 0, priority: 100 },
  { id: 27, kind: 0, priority: 300 },
  { id: 38, kind: 0, priority: 100 },
  { id: 139, kind: 0, priority: 1100 },
  { id: 366, kind: 4, priority: 2100 },
  { id: 367, kind: 4, priority: 2100 },
  { id: 368, kind: 4, priority: 2100 },
  { id: 79, kind: 4, priority: 2000 },
  { id: 609, kind: 0, priority: 700, boost_type: 2 },
  { id: 621, kind: 0, priority: 1110, boost_type: 4 },
  { id: 11, kind: 1, priority: 1200 },
  { id: 12, kind: 1, priority: 1200 },
  { id: 31, kind: 1, priority: 1500 },
  { id: 35, kind: 1, priority: 1500 },
  { id: 47, kind: 1, priority: 1500 },
  // 獎勵遊戲（2026-09-27 實機讀的 value）
  { id: 4, kind: 2, priority: 1803, value: -1 },
  { id: 5, kind: 2, priority: 1800, value: 1 },
  { id: 6, kind: 2, priority: 1801, value: 3 },
  { id: 7, kind: 2, priority: 1802, value: 5 },
  { id: 8, kind: 2, priority: 1804, value: 12 },
];

/** 物品鈕按下去官方做的事。 */
function openFromItemButton(sc: Scene) {
  const zone = sc.add.zone(0, 0, 760, 680).setDepth(900).setInteractive();
  const panel = new ItemPanel(sc);
  panel.setDepth(900);
  panel.panel_open();
  return { zone, panel };
}

function raidScene() {
  const R = new Scene("Raid");
  R["raid_support_btn"] = new MenuButton(R, 734, 524, "support").setDepth(19);
  R["icon_friend"] = new MenuButton(R, 734, 558, "friend").setDepth(19);
  R["icon_item"] = new MenuButton(R, 734, 592, "item").setDepth(19);
  const code = new Obj(R, 430, 644);
  Object.assign(code, { width: 130, height: 24, originX: 0.5, originY: 0.5 });
  R["btn_raid_code"] = code;
  R["use_avatar_item"] = vi.fn(() => Promise.resolve());
  return R;
}

/** 任務房：右下 FRIENDLIST／ITEM；搜索框 depth 50（滑桿 100），show_search 開、close_search 拆。 */
function questScene() {
  const Q = new Scene("Quest");
  Q["icon_friend"] = new MenuButton(Q, 734, 558, "friend").setDepth(19);
  Q["icon_item"] = new MenuButton(Q, 734, 592, "item").setDepth(19);
  Q["use_avatar_item"] = vi.fn(() => Promise.resolve());
  Q["show_search"] = function (this: Scene) {
    this["search_zone"] = new Obj(this, 380, 340).setDepth(50).setInteractive();
    this["search_bg"] = new Obj(this, 380, 340).setDepth(50);
    this["search_close"] = new Obj(this, 552, 276).setDepth(50);
    this["search_slider"] = new Obj(this, 222, 323).setDepth(100);
  };
  return Q;
}
const QUEST_ITEMS = [
  { item_id: 11, quantity: 430 },
  { item_id: 12, quantity: 0 },
  { item_id: 35, quantity: 6 },
  { item_id: 31, quantity: 1 },
  { item_id: 47, quantity: 2 },
];

/** 迪城：Match 場景，channel 是 2026-09-26 實機讀到的迪特赫姆頻道物件。 */
function matchScene(
  channel: Record<string, unknown> | null = { channel: 2, quick: false, event: false },
) {
  const M = new Scene("Match");
  M["channel"] = channel;
  M["icon_friend"] = new MenuButton(M, 734, 558, "friend").setDepth(19);
  M["icon_item"] = new MenuButton(M, 734, 592, "item").setDepth(19);
  M["use_avatar_item"] = vi.fn(() => Promise.resolve());
  return M;
}

/**
 * 獎勵遊戲猜錯後的樣子（2026-09-27 實機讀的）：bonus_data 有兩顆骰子、使用物品／結束遊戲
 * 兩顆鈕在。use_bonus_item 照官方：先等請求，成功才鎖輸入、拆 zone、叫面板。
 */
function bonusScene(current: number, previous: number, serverOk = true) {
  const B = new Scene("Bonus");
  B.textures = {
    get: (_key: string) => ({ has: () => true }),
    // 抹字的圓鈕要 bubbleKit 才做得出來
    exists: (k?: string) => k !== BUBBLE_TEX,
  };
  B["bonus_data"] = { step: 55, dice_current: current, dice_previous: previous };
  B["btn_item"] = new Obj(B, 265, 143).setInteractive();
  B["btn_quit"] = new Obj(B, 385, 143).setInteractive();
  B["use_bonus_item"] = vi.fn(async function (this: Scene) {
    await Promise.resolve();
    if (!serverOk) return;
    this.input.enabled = false;
    (this["item_zone"] as { destroy: Fn }).destroy();
    const panel = this["item_panel"] as { show_item: Fn; panel_close: Fn };
    panel.show_item();
    panel.panel_close();
  });
  return B;
}
const BUBBLE_TEX = "__ulrItemPanel_bonusBtn";

/**
 * 讓獎勵場景做得出抹字的圓鈕：bonus_item 原圖（兩格 111x94）＋ canvas ＋ addCanvas。
 * 圓裡上暗（40）下亮（70），字在 x20..72、y39..51：第 0 格白（230），第 1 格暗紅（不夠亮，
 * 要靠第 0 格量出來的範圍）。抹字後的像素讀 `px`。
 */
function bubbleKit(B: Scene) {
  const W = 111;
  const H = 94;
  const FW = W * 2;
  const px = new Uint8ClampedArray(FW * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < FW; x++) {
      const i = (y * FW + x) * 4;
      const fx = x % W;
      const text = fx >= 20 && fx <= 72 && y >= 39 && y <= 51;
      const v = text ? (x < W ? 230 : 120) : y < 47 ? 40 : 70;
      px[i] = v;
      px[i + 1] = x < W ? v : 20;
      px[i + 2] = x < W ? v : 20;
      px[i + 3] = 255;
    }
  }
  const frames: number[][] = [];
  const ctx = {
    drawImage: () => undefined,
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++)
        data.set(px.subarray(((y + r) * FW + x) * 4, ((y + r) * FW + x + w) * 4), r * w * 4);
      return { data, width: w, height: h };
    },
    putImageData: (
      img: { data: Uint8ClampedArray; width: number; height: number },
      x: number,
      y: number,
    ) => {
      for (let r = 0; r < img.height; r++)
        px.set(
          img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4),
          ((y + r) * FW + x) * 4,
        );
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  B.textures = {
    get: (_key: string) => ({ has: () => true, getSourceImage: () => ({ width: FW, height: H }) }),
    exists: (k: string) => (k === BUBBLE_TEX ? TEX.has(k) : true),
    addCanvas: (k: string) => {
      TEX.add(k);
      return { add: (...a: number[]) => frames.push(a) };
    },
  } as unknown as Scene["textures"];
  const handlers = new Set<Fn>();
  B["events"] = {
    on: (_ev: string, fn: Fn) => handlers.add(fn),
    off: (_ev: string, fn: Fn) => handlers.delete(fn),
  };
  const at = (x: number, y: number) => px[(y * FW + x) * 4]!;
  return {
    at,
    frames,
    handlers,
    update: () => handlers.forEach((fn) => fn()),
    document: { createElement: () => canvas },
  };
}

const BONUS_ITEMS = [
  { item_id: 4, quantity: 3 },
  { item_id: 5, quantity: 33 },
  { item_id: 6, quantity: 268 },
  { item_id: 7, quantity: 28 },
  { item_id: 8, quantity: 7 },
];

/** cache 的 CharaCards：牌組三位（L5、R3、L1）、同角色的 L1 與 L3、一張別人的。 */
const CHARA_CARDS = [
  { id: 466, chara: "cc061", level: 5 },
  { id: 316, chara: "cc066", level: 3 },
  { id: 206, chara: "cc078", level: 1 },
  { id: 461, chara: "cc061", level: 1 },
  { id: 463, chara: "cc061", level: 3 },
  { id: 311, chara: "cc066", level: 1 },
  { id: 900, chara: "cc001", level: 1 },
];
/** registry 的 deck（2026-10-11 實機讀到的形狀）；deck_now 是 1。 */
const DECKS = [
  { deck_id: 1, main: 1, chara_card_id: [466, 316, 206] },
  { deck_id: 2, main: 0, chara_card_id: [900, null, null] },
];

type Reward = { reward_type: number; reward_id: number; reward_amount: number };
const EVENT_CARD: Reward = { reward_type: 2, reward_id: 33, reward_amount: 1 };
const GEM_CARD: Reward = { reward_type: 9, reward_id: 2, reward_amount: 1900 };
const EXP_CARD: Reward = { reward_type: 9, reward_id: 1, reward_amount: 1500 };
const RAID1: Reward = { reward_type: 3, reward_id: 366, reward_amount: 1 };
const RAID2: Reward = { reward_type: 3, reward_id: 367, reward_amount: 1 };

/**
 * 一整場獎勵遊戲（2026-10-11 從跑著的客戶端讀的流程）：
 *
 * - bonus_rewards 七張，[3] 是腳下，每張帶 reward_step；沒指定的層是事件卡
 * - 下一個卡片：鎖輸入 → 拆 next／get → 建 high／low、大數字換成底數 → 解鎖
 * - 猜：照 `rolls` 依序出骰。猜對：step+1、獎品列換新、next／get 回來；猜錯：使用物品／結束遊戲
 * - 用道具：四葉草（4）留在原地重投（底數＝骰壞的那一顆），其他算猜對；`refuse` 時伺服器回 false
 * - 得到卡片：記下在哪一層收的
 */
function climbGame(o: {
  start: number;
  base: number;
  cells?: Record<number, Reward>;
  rolls?: number[];
  result?: string;
  refuse?: boolean;
}) {
  const B = new Scene("Bonus");
  const R = new Scene("Result");
  // 2026-10-11 實機：gem_base 37、gem_boost 150（100 ＋ 權杖的 50）
  R["result_params"] = { result: o.result ?? "win", gem_base: 37, gem_boost: 150, exp_base: 55 };
  B.textures = { get: () => ({ has: () => true }), exists: () => true };
  const rolls = [...(o.rolls ?? [])];
  const log = { next: 0, picks: [] as string[], items: [] as number[], got: null as number | null };
  const data = () => B["bonus_data"] as { step: number; dice_current: number };
  const rewards = (step: number) =>
    [-3, -2, -1, 0, 1, 2, 3].map((k) => ({
      ...(o.cells?.[step + k] ?? EVENT_CARD),
      reward_slot: 1,
      reward_step: step + k,
    }));
  const decide = () => {
    B["btn_high"] = null;
    B["btn_low"] = null;
    B["btn_next"] = new Obj(B, 265, 143).setInteractive();
    B["btn_get"] = new Obj(B, 385, 143).setInteractive();
  };
  const guess = (base: number) => {
    B["btn_high"] = new Obj(B, 334, 74).setInteractive();
    B["btn_low"] = new Obj(B, 334, 194).setInteractive();
    (B["dice_value"] as Obj).setTexture("bonus_dice_num", `num_${base}`);
  };
  const kill = (...names: string[]) =>
    names.forEach((n) => (B[n] as Obj | null | undefined)?.destroy());
  const advance = () => {
    const step = data().step + 1;
    B["bonus_data"] = { ...data(), step };
    B["bonus_rewards"] = rewards(step);
    kill("btn_high", "btn_low");
    decide();
  };
  B["bonus_data"] = { step: o.start, dice_current: o.base, dice_previous: o.base };
  B["bonus_rewards"] = rewards(o.start);
  B["bonus_star"] = new Obj(B, 258, 8);
  const dv = new Obj(B, 594, 146);
  dv.frame = { name: `num_${o.base}` };
  B["dice_value"] = dv;
  B["ulse17"] = { play: vi.fn() };
  decide();
  B["check_bonus_next"] = vi.fn(async function (this: Scene) {
    this.input.enabled = false;
    log.next++;
    await Promise.resolve();
    kill("btn_next", "btn_get");
    guess(data().dice_current);
    this.input.enabled = true;
  });
  B["bonus_prediction"] = vi.fn(async function (this: Scene, pick: string) {
    this.input.enabled = false;
    log.picks.push(pick);
    await Promise.resolve();
    const base = data().dice_current;
    const roll = rolls.shift() ?? (pick === "high" ? 12 : 2);
    const ok = pick === "high" ? roll > base : roll < base;
    B["bonus_data"] = { step: data().step, dice_current: roll, dice_previous: base };
    kill(pick === "high" ? "btn_low" : "btn_high");
    if (ok) advance();
    else {
      B["btn_item"] = new Obj(B, 265, 143).setInteractive();
      B["btn_quit"] = new Obj(B, 385, 143).setInteractive();
    }
    this.input.enabled = true;
  });
  B["use_bonus_item"] = vi.fn(async function (this: Scene, id: number) {
    await Promise.resolve();
    if (o.refuse === true) return;
    this.input.enabled = false;
    log.items.push(id);
    const item = ITEMS.find((x) => x.item_id === id);
    if (item) item.quantity--;
    kill("btn_item", "btn_quit", "btn_high", "btn_low");
    if (id === 4) guess(data().dice_current);
    else advance();
    this.input.enabled = true;
  });
  B["check_bonus_get"] = vi.fn(async function (this: Scene) {
    this.input.enabled = false;
    log.got = data().step;
  });
  B["check_bonus_quit"] = vi.fn(async () => undefined);
  return { B, R, log };
}

/** registry 的 player_boost。 */
let BOOSTS: { boost_type: number; boost_value: number; item_id: number; expire_at: string }[] = [];
/** game.textures 裡有的 key。 */
let TEX = new Set<string>();
const BOOST_TEX = "__ulrItemPanel_boost";

function setup(scenes: Record<string, Scene>, extra: Record<string, unknown> = {}) {
  const chunks: unknown[] = [];
  const req = Object.assign((id: string) => (id === "7" ? { c: ItemPanel } : {}), {
    m: {
      "3": function other() {
        return "nothing";
      },
      "7": function panelModule() {
        return "get_item_data( panel_open(";
      },
    },
  });
  chunks.push = (entry: unknown) => {
    (entry as [unknown, unknown, (r: unknown) => void])[2](req);
    return 0;
  };
  const window: Record<string, unknown> = {
    webpackChunkunlight: chunks,
    game: {
      scene: { keys: scenes },
      cache: {
        json: {
          get: (k: string) =>
            k === "AvatarItems" ? ROWS : k === "CharaCards" ? CHARA_CARDS : undefined,
        },
      },
      registry: {
        get: (k: string) =>
          k === "avatar_item"
            ? ITEMS
            : k === "player_boost"
              ? BOOSTS
              : k === "deck"
                ? DECKS
                : k === "deck_now"
                  ? 1
                  : undefined,
      },
      textures: {
        exists: (k: string) => TEX.has(k),
        remove: (k: string) => TEX.delete(k),
        addAtlas: (k: string) => TEX.add(k),
      },
    },
    ...extra,
  };
  type Runner = (...a: unknown[]) => string;
  const net = {
    fetch: (window["fetch"] ?? (() => Promise.reject(new Error("no fetch")))) as unknown,
    Image: window["Image"],
    URL: window["URL"],
  };
  const run = (expression: string): string => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "window",
      "setInterval",
      "clearInterval",
      "fetch",
      "Image",
      "URL",
      `return ${expression};`,
    );
    return (fn as Runner)(window, setInterval, clearInterval, net.fetch, net.Image, net.URL);
  };
  const st = () => window["__ulrItemPanel"] as Record<string, unknown> & { mine: MenuButton[] };
  return { window, run, st };
}

const label = (b: MenuButton) => b.button_icon.frame.name;

beforeEach(() => {
  vi.useFakeTimers();
  BOOSTS = [];
  TEX = new Set();
  ITEMS = [
    { item_id: 1, quantity: 412 },
    { item_id: 2, quantity: 1340 },
    { item_id: 3, quantity: 0 },
    { item_id: 27, quantity: 16 },
    { item_id: 38, quantity: 1 },
    { item_id: 609, quantity: 6 },
    { item_id: 621, quantity: 1 },
    { item_id: 366, quantity: 1 },
    { item_id: 367, quantity: 25 },
  ];
});
afterEach(() => {
  vi.useRealTimers();
  const p = ItemPanel.prototype as unknown as Record<string, unknown>;
  expect(p["__ulrItemPanelOrig"]).toBeUndefined();
});

describe("物品欄：點得到外面", () => {
  it("從物品鈕開的：那層全畫面 zone 的點擊關掉，zone 本身留著給官方關窗時拆", () => {
    const lobby = new Scene("Lobby");
    const { run } = setup({ Lobby: lobby });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const { zone, panel } = openFromItemButton(lobby);
    expect(zone.input!.enabled).toBe(false);
    expect(zone.scene).toBeDefined();
    expect(panel.scene).toBeDefined();
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("不是從物品鈕開的（前面沒有那層 zone、或 depth 不同）不碰", () => {
    const lobby = new Scene("Lobby");
    const { run } = setup({ Lobby: lobby });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const zone = lobby.add.zone(0, 0, 760, 680).setDepth(150).setInteractive();
    const panel = new ItemPanel(lobby).setDepth(900);
    panel.panel_open();
    expect(zone.input!.enabled).toBe(true);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("已經開著一張時再按物品鈕＝關：新的當場拆掉（連同它的 zone），舊的走 panel_close", () => {
    const lobby = new Scene("Lobby");
    const { run } = setup({ Lobby: lobby });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const first = openFromItemButton(lobby);
    const second = openFromItemButton(lobby);
    expect(second.panel.scene).toBeUndefined();
    expect(second.zone.scene).toBeUndefined();
    expect(first.panel.closed).toBe(true);
    // 正在關的那張不算「開著」：再按一次是正常開一張新的
    const third = openFromItemButton(lobby);
    expect(third.panel.scene).toBeDefined();
    expect(third.zone.input!.enabled).toBe(false);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

describe("物品欄：渦房的順序", () => {
  it("水排最前、接渦二渦一，其他照官方；增益類與日記本不列", () => {
    const R = raidScene();
    const { run } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const { panel } = openFromItemButton(R);
    expect(panel.shown).toEqual([1, 2, 3, 38, RAID_DETECTOR_2, RAID_DETECTOR_1]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("大廳的物品欄不動（增益類要用還是從那裡用）", () => {
    const lobby = new Scene("Lobby");
    const { run } = setup({ Lobby: lobby });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const { panel } = openFromItemButton(lobby);
    expect(panel.shown).toEqual(ITEMS.map((x) => x.item_id));
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("拆掉之後原型還原成官方那兩支", () => {
    const orig = ItemPanel.prototype.get_item_data;
    const { run } = setup({ Raid: raidScene() });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    expect(ItemPanel.prototype.get_item_data).not.toBe(orig);
    expect(run(ITEM_PANEL_UNINSTALL_EXPRESSION)).toBe("ok");
    expect(ItemPanel.prototype.get_item_data).toBe(orig);
  });
});

describe("渦房的物品捷徑", () => {
  it("官方好友與物品鈕藏起來：古代佔 FRIENDLIST、精靈佔 ITEM；SUPPORT 上面不放；探知機在渦碼鈕上方", () => {
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    const status = parseItemPanelStatus(
      run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false })),
    );
    expect(status).toMatchObject({ installed: true, found: true, shortcut: true, inRaid: true });

    const friend = R["icon_friend"] as MenuButton;
    const item = R["icon_item"] as MenuButton;
    expect(friend.visible).toBe(false);
    expect(item.visible).toBe(false);
    expect(friend.button_base.input!.enabled).toBe(false);
    expect((R["raid_support_btn"] as MenuButton).visible).toBe(true);

    const pos = st().mine.map((b) => `${label(b)}@${b.x},${b.y}`);
    // 魔女不放；渦一、渦二跟其他探知機一樣排在「輸入Raid代碼」（左緣 365、上緣 632）上方
    expect(pos).toEqual([
      "item_2@734,558",
      "item_1@734,592",
      "item_366@389,612",
      "item_367@441,612",
    ]);
    // 鈕是官方那個類別，跟官方鈕同一層
    expect(st().mine.every((b) => b instanceof MenuButton && b.depth === 19)).toBe(true);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("點下去走場景自己的 use_avatar_item；水的數量 0 半透明、點不下去", () => {
    ITEMS.find((x) => x.item_id === 1)!.quantity = 0;
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    const [ancient, fairy, , det2] = st().mine;
    ancient!.emit("click");
    det2!.emit("click");
    const use = R["use_avatar_item"] as ReturnType<typeof vi.fn>;
    expect(use.mock.calls.map((c) => c[1])).toEqual([2, RAID_DETECTOR_2]);
    expect(fairy!.alpha).toBe(0.5);
    expect(fairy!.button_base.input!.enabled).toBe(false);
    // 場景點擊關著（官方正在等伺服器）時不送
    R.input.enabled = false;
    ancient!.emit("click");
    expect(use).toHaveBeenCalledTimes(2);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("渦探知機：有才畫；渦一、渦二在前，其他照 priority，一列 3 顆由下往上；數量變了就重畫", () => {
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    expect(st().mine).toHaveLength(4);

    ITEMS.push({ item_id: 368, quantity: 2 }, { item_id: 79, quantity: 3 });
    ITEMS.find((x) => x.item_id === RAID_DETECTOR_1)!.quantity = 0;
    vi.advanceTimersByTime(600);
    const extra = st()
      .mine.slice(2)
      .map((b) => `${label(b)}@${b.x},${b.y}`);
    // 渦一用完了就不畫；α（2000）排在 β Ⅲ（2100）前面
    expect(extra).toEqual(["item_367@389,612", "item_79@441,612", "item_368@493,612"]);

    ITEMS.find((x) => x.item_id === RAID_DETECTOR_1)!.quantity = 1;
    vi.advanceTimersByTime(600);
    expect(
      st()
        .mine.slice(2)
        .map((b) => `${label(b)}@${b.x},${b.y}`),
    ).toEqual(["item_366@389,612", "item_367@441,612", "item_79@493,612", "item_368@389,576"]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關掉捷徑：自己的鈕拆掉、官方兩顆放回來、點擊打開", () => {
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    const mine = [...st().mine];
    expect(run(buildItemPanelSetShortcutExpression(false))).toBe("ok");
    expect(mine.every((b) => b.scene === undefined)).toBe(true);
    const friend = R["icon_friend"] as MenuButton;
    expect(friend.visible).toBe(true);
    expect(friend.button_base.input!.enabled).toBe(true);
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(0);

    run(buildItemPanelSetShortcutExpression(true));
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(4);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("人離開渦房就拆；拆除把官方鈕放回來", () => {
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    R.active = false;
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(0);
    expect((R["icon_item"] as MenuButton).visible).toBe(true);

    R.active = true;
    vi.advanceTimersByTime(600);
    expect(st().mine).toHaveLength(4);
    expect(run(ITEM_PANEL_UNINSTALL_EXPRESSION)).toBe("ok");
    expect((R["icon_item"] as MenuButton).visible).toBe(true);
    expect(run(ITEM_PANEL_UNINSTALL_EXPRESSION)).toBe("not-installed");
  });
});

describe("任務房", () => {
  const texts = (b: MenuButton) => b.list.map((o) => o.text).filter((t) => t !== undefined);

  it("物品欄：增益類與日記本不列，其餘照官方順序", () => {
    ITEMS.push(...QUEST_ITEMS);
    const Q = questScene();
    const { run } = setup({ Quest: Q });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const { panel } = openFromItemButton(Q);
    expect(panel.shown).toEqual([1, 2, 3, 38, 366, 367, 11, 12, 35, 31, 47]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("捷徑：FRIENDLIST 正上方貼著疊水與沙漏；通行證在下方中間、標名字；官方鈕不動", () => {
    ITEMS.push(...QUEST_ITEMS);
    const Q = questScene();
    const { run, st } = setup({ Quest: Q });
    const status = parseItemPanelStatus(
      run(buildItemPanelPatchScript({ shortcut: false, questStack: true, questPasses: true })),
    );
    expect(status).toMatchObject({
      installed: true,
      questStack: true,
      questPasses: true,
      inQuest: true,
      questButtons: 8,
    });
    const mine = (st()["q"] as { mine: MenuButton[] }).mine;
    expect(mine.map((b) => `${label(b)}@${b.x},${b.y}`)).toEqual([
      "item_1@734,388",
      "item_2@734,422",
      "item_3@734,456",
      "item_11@734,490",
      "item_12@734,524",
      "item_31@370,502",
      "item_35@422,502",
      "item_47@474,502",
    ]);
    // 最下面那格緊貼 FRIENDLIST（中心差 34，跟 FRIENDLIST／ITEM 一樣）
    expect(558 - mine[4]!.y).toBe(34);
    expect(texts(mine[5]!)).toEqual(["x1", "影1"]);
    expect(texts(mine[6]!)).toEqual(["x6", "月2"]);
    expect(texts(mine[7]!)).toEqual(["x2", "風1"]);
    // 數量 0：半透明、點不下去（魔女、超時空沙漏）
    expect(mine[2]!.alpha).toBe(0.5);
    expect(mine[4]!.alpha).toBe(0.5);
    expect((Q["icon_friend"] as MenuButton).visible).toBe(true);
    expect((Q["icon_item"] as MenuButton).visible).toBe(true);

    mine[3]!.emit("click");
    mine[6]!.emit("click");
    const use = Q["use_avatar_item"] as ReturnType<typeof vi.fn>;
    expect(use.mock.calls.map((c) => c[1])).toEqual([11, 35]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(mine.every((b) => b.scene === undefined)).toBe(true);
  });

  it("通行證一列 4 顆（5 顆會蓋到人物腳邊的小人），第 5 顆換下一列", () => {
    ITEMS.push(...QUEST_ITEMS, { item_id: 32, quantity: 7 }, { item_id: 33, quantity: 4 });
    const Q = questScene();
    const { run, st } = setup({ Quest: Q });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: true, questPasses: true }));
    const passes = (st()["q"] as { mine: MenuButton[] }).mine.slice(5);
    expect(passes.map((b) => `${label(b)}@${b.x},${b.y}`)).toEqual([
      "item_31@370,502",
      "item_32@422,502",
      "item_33@474,502",
      "item_35@526,502",
      "item_47@370,538",
    ]);
    // 右緣（中心＋24）停在 550
    expect(Math.max(...passes.map((b) => b.x)) + 24).toBe(550);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("水沙、通行證各自開關：只開一塊就只畫那一塊、位置不變", () => {
    ITEMS.push(...QUEST_ITEMS);
    const Q = questScene();
    const { run, st } = setup({ Quest: Q });
    const q = () =>
      (st()["q"] as { mine: MenuButton[] }).mine.map((b) => `${label(b)}@${b.x},${b.y}`);
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: true }));
    expect(q()).toEqual(["item_31@370,502", "item_35@422,502", "item_47@474,502"]);

    // 開水沙：當場畫上，不等輪詢
    expect(run(buildItemPanelSetPartExpression("stack", true))).toBe("ok");
    expect(q()).toHaveLength(8);
    // 關通行證：水沙留著、位置不變
    run(buildItemPanelSetPartExpression("passes", false));
    expect(q()).toEqual([
      "item_1@734,388",
      "item_2@734,422",
      "item_3@734,456",
      "item_11@734,490",
      "item_12@734,524",
    ]);
    vi.advanceTimersByTime(600);
    expect(q()).toHaveLength(5);
    const status = parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION));
    expect(status).toMatchObject({ questStack: true, questPasses: false, questButtons: 5 });
    // 兩塊都關：全拆
    run(buildItemPanelSetPartExpression("stack", false));
    vi.advanceTimersByTime(600);
    expect(q()).toHaveLength(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關任務房捷徑只拆任務房的，渦房的留著", () => {
    ITEMS.push(...QUEST_ITEMS);
    const Q = questScene();
    const R = raidScene();
    const { run, st } = setup({ Quest: Q, Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: true, questPasses: true }));
    run(buildItemPanelSetPartExpression("stack", false));
    expect(run(buildItemPanelSetPartExpression("passes", false))).toBe("ok");
    expect((st()["q"] as { mine: MenuButton[] }).mine).toHaveLength(0);
    expect(st().mine.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(600);
    expect((st()["q"] as { mine: MenuButton[] }).mine).toHaveLength(0);
    expect(st().mine.length).toBeGreaterThan(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("物品欄開著時開搜索：搜索框整組疊到物品欄上面（遮罩不動），物品欄關了放回去", () => {
    const Q = questScene();
    const { run } = setup({ Quest: Q });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    const { panel } = openFromItemButton(Q);
    (Q["show_search"] as Fn).call(Q);
    const depth = (k: string) => (Q[k] as Obj).depth;
    // 一開就抬，不等輪詢
    expect(depth("search_bg")).toBe(901);
    expect(depth("search_close")).toBe(901);
    expect(depth("search_slider")).toBe(951);
    expect(depth("search_zone")).toBe(50);

    panel.panel_close();
    vi.advanceTimersByTime(600);
    expect(depth("search_bg")).toBe(50);
    expect(depth("search_slider")).toBe(100);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("沒開物品欄時搜索框不動；拆除把 show_search 還原", () => {
    const Q = questScene();
    const orig = Q["show_search"];
    const { run } = setup({ Quest: Q });
    run(buildItemPanelPatchScript({ shortcut: false, questStack: false, questPasses: false }));
    expect(Q["show_search"]).not.toBe(orig);
    (Q["show_search"] as Fn).call(Q);
    vi.advanceTimersByTime(600);
    expect((Q["search_bg"] as Obj).depth).toBe(50);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(Q["show_search"]).toBe(orig);
  });
});

describe("迪城的水捷徑", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const d = (st: () => Record<string, unknown>) =>
    (st()["d"] as { mine: MenuButton[] }).mine.map((b) => `${label(b)}@${b.x},${b.y}`);

  it("FRIENDLIST 正上方貼著疊精靈、古代、魔女；官方鈕不動；點下去走場景的 use_avatar_item", () => {
    const M = matchScene();
    const { run, st } = setup({ Match: M });
    const status = parseItemPanelStatus(
      run(buildItemPanelPatchScript({ ...OFF, dietStack: true })),
    );
    expect(status).toMatchObject({ dietStack: true, inDiet: true, dietButtons: 3 });
    expect(d(st)).toEqual(["item_1@734,456", "item_2@734,490", "item_3@734,524"]);
    expect((M["icon_friend"] as MenuButton).visible).toBe(true);
    expect((M["icon_item"] as MenuButton).visible).toBe(true);

    const mine = (st()["d"] as { mine: MenuButton[] }).mine;
    // 魔女是 0：半透明、點不下去
    expect(mine[2]!.alpha).toBe(0.5);
    mine[1]!.emit("click");
    const use = M["use_avatar_item"] as ReturnType<typeof vi.fn>;
    expect(use.mock.calls.map((c) => c[1])).toEqual([2]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(mine.every((b) => b.scene === undefined)).toBe(true);
  });

  it("亞城（快速比賽頻道）、活動頻道、還沒選頻道都不畫；進了迪城才畫", () => {
    const M = matchScene({ channel: 1, quick: true, event: false });
    const { run, st } = setup({ Match: M });
    run(buildItemPanelPatchScript({ ...OFF, dietStack: true }));
    expect(d(st)).toEqual([]);
    M["channel"] = { channel: 5, quick: false, event: true };
    vi.advanceTimersByTime(600);
    expect(d(st)).toEqual([]);
    M["channel"] = null;
    vi.advanceTimersByTime(600);
    expect(d(st)).toEqual([]);
    M["channel"] = { channel: 2, quick: false, event: false };
    vi.advanceTimersByTime(600);
    expect(d(st)).toHaveLength(3);
    // 離開迪城（切回亞城）就拆
    M["channel"] = { channel: 1, quick: true, event: false };
    vi.advanceTimersByTime(600);
    expect(d(st)).toEqual([]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("有 type 的頻道物件照 type 判斷（duel＝迪城）", () => {
    const M = matchScene({ type: "duel", quick: true });
    const { run, st } = setup({ Match: M });
    run(buildItemPanelPatchScript({ ...OFF, dietStack: true }));
    expect(d(st)).toHaveLength(3);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("開關當場生效，不動任務房的", () => {
    ITEMS.push(...QUEST_ITEMS);
    const M = matchScene();
    const Q = questScene();
    const { run, st } = setup({ Match: M, Quest: Q });
    run(buildItemPanelPatchScript({ ...OFF, questStack: true }));
    expect(d(st)).toEqual([]);
    expect(run(buildItemPanelSetPartExpression("dietStack", true))).toBe("ok");
    expect(d(st)).toHaveLength(3);
    run(buildItemPanelSetPartExpression("dietStack", false));
    expect(d(st)).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(d(st)).toEqual([]);
    expect((st()["q"] as { mine: MenuButton[] }).mine).toHaveLength(5);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

describe("迪城的 GEM UP", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const NOW = Date.parse("2026-09-26T02:28:15.000Z");
  const g = (st: () => Record<string, unknown>) => (st()["g"] as { mine: Obj[] }).mine;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    TEX.add(BOOST_TEX);
    BOOSTS = [
      { boost_type: 0, boost_value: 10, item_id: 612, expire_at: "2026-10-02T22:12:25.000Z" },
      { boost_type: 1, boost_value: 50, item_id: 615, expire_at: "2026-09-28T03:36:26.000Z" },
    ];
  });

  it("大廳同一個位置畫 boost_1、倒數（日:時:分:秒），上方標 +50%", () => {
    const M = matchScene();
    const { run, st } = setup({ Match: M });
    const status = parseItemPanelStatus(run(buildItemPanelPatchScript({ ...OFF, gemUp: true })));
    expect(status).toMatchObject({ gemUp: true, gemShown: true, gemPct: 50, inDiet: true });
    const [icon, timer, pct] = g(st);
    expect(icon!.frame.name).toBe(`${BOOST_TEX}/boost_1`);
    expect([icon!.x, icon!.y]).toEqual([760, 370]);
    expect([timer!.x, timer!.y]).toEqual([693, 353]);
    // 09-28 03:36:26 − 09-26 02:28:15 = 2 天 1 時 8 分 11 秒
    expect(timer!.text).toBe("02:01:08:11");
    expect(pct!.text).toBe("+50%");

    vi.advanceTimersByTime(1000);
    expect(g(st)[1]!.text).toBe("02:01:08:10");
    // 同一組物件，不是每秒重建
    expect(g(st)[0]).toBe(icon);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(icon!.scene).toBeUndefined();
    // 自己抓的圖拆除時移掉
    expect(TEX.has(BOOST_TEX)).toBe(false);
  });

  it("沒有 GEM 加成、或已經過期就不畫；加成換了數值就重畫", () => {
    const gem = BOOSTS[1]!;
    BOOSTS = [BOOSTS[0]!];
    const M = matchScene();
    const { run, st } = setup({ Match: M });
    const status = parseItemPanelStatus(run(buildItemPanelPatchScript({ ...OFF, gemUp: true })));
    expect(status).toMatchObject({ gemShown: false, gemPct: null });
    expect(g(st)).toHaveLength(0);

    BOOSTS = [{ ...gem, expire_at: "2026-09-26T02:00:00.000Z" }];
    vi.advanceTimersByTime(600);
    expect(g(st)).toHaveLength(0);

    BOOSTS = [{ ...gem, boost_value: 100 }];
    vi.advanceTimersByTime(600);
    expect(g(st)[2]!.text).toBe("+100%");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("不在迪城不畫；關掉當場拆，gemPct 照樣回報（托盤頁要顯示目前加成）", () => {
    const M = matchScene({ channel: 1, quick: true, event: false });
    const { run, st } = setup({ Match: M });
    run(buildItemPanelPatchScript({ ...OFF, gemUp: true }));
    expect(g(st)).toHaveLength(0);
    M["channel"] = { channel: 2, quick: false, event: false };
    vi.advanceTimersByTime(600);
    const drawn = [...g(st)];
    expect(drawn).toHaveLength(3);

    expect(run(buildItemPanelSetPartExpression("gemUp", false))).toBe("ok");
    expect(drawn.every((o) => o.scene === undefined)).toBe(true);
    vi.advanceTimersByTime(600);
    expect(g(st)).toHaveLength(0);
    const status = parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION));
    expect(status).toMatchObject({ gemUp: false, gemShown: false, gemPct: 50 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("圖不在就從資產主機抓大廳那張（UL_ASSETS.lobby 的 PlayerBoostIcons），抓到才畫", async () => {
    TEX.delete(BOOST_TEX);
    const fetched: string[] = [];
    const fakeFetch = (url: string) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ textures: [] }),
        blob: () => Promise.resolve("blob"),
      });
    };
    class FakeImage {
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const M = matchScene();
    const { run, st } = setup(
      { Match: M },
      {
        fetch: fakeFetch,
        Image: FakeImage,
        URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
        UL_CONFIG: { domains: { assets: { urls: ["https://assets.example/"] } } },
        UL_ASSETS: {
          lobby: {
            atlas: [
              {
                key: "PlayerBoostIcons",
                textureURL: "images/assets/General/PlayerBoostIcons.webp",
                atlasURL: "images/assets/General/PlayerBoostIcons.json",
              },
            ],
          },
        },
      },
    );
    run(buildItemPanelPatchScript({ ...OFF, gemUp: true }));
    expect(g(st)).toHaveLength(0);
    await vi.waitFor(() => expect(TEX.has(BOOST_TEX)).toBe(true));
    expect(fetched.sort()).toEqual([
      "https://assets.example/images/assets/General/PlayerBoostIcons.json",
      "https://assets.example/images/assets/General/PlayerBoostIcons.webp",
    ]);
    // 抓到當下就補畫，不等下一輪
    expect(g(st)).toHaveLength(3);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

describe("獎勵遊戲的物品捷徑", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const ON = { ...OFF, bonusItem: true };
  const b = (st: () => Record<string, unknown>) => (st()["b"] as { mine: Obj[] }).mine;
  /** 畫著的那一顆是哪個道具（圖的 frame）；沒畫是 null。 */
  const pick = (st: () => Record<string, unknown>) => {
    const c = b(st)[0];
    return c === undefined ? null : c.list[1]!.frame.name.replace("AvatarItemImages/", "");
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    ITEMS = BONUS_ITEMS.map((x) => ({ ...x }));
  });

  it("做不出抹字的底圖（沒有 addCanvas）：退回物品欄格子畫在左上", () => {
    const B = bonusScene(2, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript({ ...ON, bonusPlace: "cover" }));
    const [c] = b(st);
    expect([c!.x, c!.y, c!.scale]).toEqual([298, 108, 0.67]);
    expect(c!.list[0]!.frame.name).toBe("item_base/0");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("5 猜大出 2（差 3）：左上畫一顆石楠3（這裡沒有底圖，照物品欄格子）；官方兩顆鈕不動", () => {
    const B = bonusScene(2, 5);
    const { run, st } = setup({ Bonus: B });
    const status = parseItemPanelStatus(run(buildItemPanelPatchScript(ON)));
    expect(status).toMatchObject({
      bonusItem: true,
      bonusOrder: "heather5",
      inBonus: true,
      bonusPick: 6,
    });
    const [c] = b(st);
    expect([c!.x, c!.y, c!.scale, c!.depth]).toEqual([298, 108, 0.67, 1]);
    const [base, icon, qty] = c!.list;
    expect(base!.frame.name).toBe("item_base/0");
    expect(icon!.frame.name).toBe("AvatarItemImages/item_6");
    expect(qty!.text).toBe("x268");
    base!.emit("pointerover");
    expect(base!.frame.name).toBe("item_base/1");
    base!.emit("pointerout");
    expect(base!.frame.name).toBe("item_base/0");
    expect((B["btn_item"] as Obj).visible).toBe(true);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(c!.scene).toBeUndefined();
  });

  it("7 猜小出 8（差 1）→ 石楠1；石楠1 沒了 → 石楠3", () => {
    const B = bonusScene(8, 7);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    expect(pick(st)).toBe("item_5");
    ITEMS.find((x) => x.item_id === 5)!.quantity = 0;
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBe("item_6");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("8 猜小出 12（差 4）→ 石楠5，沒有就四葉草，再沒有就跳越星，都沒有不畫", () => {
    const B = bonusScene(12, 8);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    expect(pick(st)).toBe("item_7");
    const gone = (id: number) => (ITEMS.find((x) => x.item_id === id)!.quantity = 0);
    gone(7);
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBe("item_4");
    gone(4);
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBe("item_8");
    gone(8);
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBeNull();
    expect(parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION))).toMatchObject({
      inBonus: false,
      bonusPick: null,
    });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("差距超過 5：石楠5 用不了，直接往下", () => {
    const B = bonusScene(2, 9);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    expect(pick(st)).toBe("item_4");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("優先順序可以換、當場重畫；差距小時照樣先用剛好夠的石楠", () => {
    const B = bonusScene(12, 8);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript({ ...ON, bonusOrder: "star" }));
    expect(pick(st)).toBe("item_8");
    expect(run(buildItemPanelSetBonusOrderExpression("clover"))).toBe("ok");
    expect(pick(st)).toBe("item_4");
    expect(parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION)).bonusOrder).toBe("clover");
    B["bonus_data"] = { step: 55, dice_current: 6, dice_previous: 8 };
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBe("item_6");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("還沒猜錯（沒有使用物品鈕）不畫；開關當場生效", () => {
    const B = bonusScene(2, 5);
    const item = B["btn_item"] as Obj;
    item.destroy();
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(OFF));
    expect(b(st)).toHaveLength(0);
    expect(run(buildItemPanelSetPartExpression("bonusItem", true))).toBe("ok");
    expect(b(st)).toHaveLength(0);
    B["btn_item"] = new Obj(B, 265, 143).setInteractive();
    vi.advanceTimersByTime(600);
    expect(b(st)).toHaveLength(1);
    run(buildItemPanelSetPartExpression("bonusItem", false));
    expect(b(st)).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(b(st)).toHaveLength(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("按下去走場景的 use_bonus_item；沒開物品欄時墊替身，用過就不再畫", async () => {
    const B = bonusScene(2, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    const [c] = b(st);
    c!.list[0]!.emit("pointerup");
    const use = B["use_bonus_item"] as ReturnType<typeof vi.fn>;
    expect(use.mock.calls.map((x) => x[0])).toEqual([6]);
    expect(c!.scene).toBeUndefined();
    await flush();
    // 替身讓官方那支跑完（沒丟例外、輸入照官方鎖住）
    expect(B.input.enabled).toBe(false);
    // 官方的鈕還在淡出（還活著）：同一顆 btn_item 不再畫
    vi.advanceTimersByTime(600);
    expect(b(st)).toHaveLength(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("開著官方物品欄時照官方的 item_zone／item_panel，不換成替身", async () => {
    const B = bonusScene(2, 5);
    const zone = B.add.zone(380, 340, 760, 680).setDepth(10).setInteractive();
    const panel = new ItemPanel(B).setDepth(10);
    B["item_zone"] = zone;
    B["item_panel"] = panel;
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    b(st)[0]!.list[0]!.emit("pointerup");
    await flush();
    expect(zone.scene).toBeUndefined();
    expect(panel.closed).toBe(true);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("伺服器說不能用（輸入沒鎖、鈕還在）：放回來", async () => {
    const B = bonusScene(2, 5, false);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    b(st)[0]!.list[0]!.emit("pointerup");
    expect(b(st)).toHaveLength(0);
    await flush();
    vi.advanceTimersByTime(600);
    expect(pick(st)).toBe("item_6");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("場景輸入鎖著時按了不算", () => {
    const B = bonusScene(2, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    B.input.enabled = false;
    b(st)[0]!.list[0]!.emit("pointerup");
    expect(B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(b(st)).toHaveLength(1);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

describe("獎勵遊戲的圓鈕", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const ABOVE = { ...OFF, bonusItem: true };
  const COVER = { ...ABOVE, bonusPlace: "cover" as const };
  const b = (st: () => Record<string, unknown>) => (st()["b"] as { mine: Obj[] }).mine;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const make = (current: number, previous: number, serverOk = true) => {
    const B = bonusScene(current, previous, serverOk);
    const kit = bubbleKit(B);
    const env = setup({ Bonus: B }, { document: kit.document });
    return { B, kit, ...env };
  };

  beforeEach(() => {
    ITEMS = BONUS_ITEMS.map((x) => ({ ...x }));
  });

  it("底圖：第 0 格量出字的範圍、兩格都直向內插抹掉；圓外與字外不動", () => {
    const { kit, run } = make(2, 5);
    run(buildItemPanelPatchScript(ABOVE));
    // 兩格各登記一個 111x94 的 frame
    expect(kit.frames).toEqual([
      [0, 0, 0, 0, 111, 94],
      [1, 0, 111, 0, 111, 94],
    ]);
    // 範圍外擴 4 → y35..55：上緣 40、下緣 70，中間平滑過去，不剩白字
    expect(kit.at(40, 35)).toBe(40);
    expect(kit.at(40, 55)).toBe(70);
    expect(kit.at(40, 45)).toBe(55);
    for (let y = 36; y < 55; y++) expect(kit.at(46, y)).toBeLessThan(80);
    // 第 1 格的字（暗紅）一樣抹掉
    expect(kit.at(111 + 46, 45)).toBe(55);
    // 範圍外（x 10、x 90）原樣
    expect(kit.at(10, 45)).toBe(40);
    expect(kit.at(90, 50)).toBe(70);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(TEX.has(BUBBLE_TEX)).toBe(false);
  });

  it("左上：縮 0.75、轉 45 度尾巴朝中心；只認圓；滑上換紅", () => {
    const { run, st } = make(2, 5);
    const status = parseItemPanelStatus(run(buildItemPanelPatchScript(ABOVE)));
    expect(status).toMatchObject({ bonusPlace: "above", inBonus: true, bonusPick: 6 });
    const [c] = b(st);
    expect([c!.x, c!.y, c!.scale, c!.depth]).toEqual([304, 111, 0.75, 1]);
    const [base, icon, qty] = c!.list;
    expect(base!.frame.name).toBe(`${BUBBLE_TEX}/0`);
    expect(base!.angle).toBe(45);
    expect(icon!.frame.name).toBe("AvatarItemImages/item_6");
    expect(icon!.angle).toBe(0);
    expect(qty!.text).toBe("x268");
    const hit = (x: number, y: number) => base!.hitAreaCallback!(base!.hitArea, x, y);
    expect(hit(45, 45)).toBe(true);
    expect(hit(45, 85)).toBe(true);
    // 方框的角、尾巴尖不算
    expect(hit(2, 2)).toBe(false);
    expect(hit(105, 46)).toBe(false);
    base!.emit("pointerover");
    expect(base!.frame.name).toBe(`${BUBBLE_TEX}/1`);
    base!.emit("pointerout");
    expect(base!.frame.name).toBe(`${BUBBLE_TEX}/0`);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(c!.scene).toBeUndefined();
  });

  it("蓋住：圓心對齊使用物品、整塊都能按；透明度跟著官方鈕", () => {
    const { B, kit, run, st } = make(2, 5);
    const btn = B["btn_item"] as Obj;
    btn.setAlpha(0);
    run(buildItemPanelPatchScript(COVER));
    const [c] = b(st);
    expect([c!.x, c!.y, c!.scale]).toEqual([265 + 45.5, 143 + 45.5, 1]);
    const base = c!.list[0]!;
    expect(base.angle).toBe(0);
    expect(base.hitAreaCallback).toBeNull();
    expect(base.input?.enabled).toBe(true);
    expect(c!.alpha).toBe(0);
    btn.setAlpha(0.6);
    kit.update();
    expect(c!.alpha).toBe(0.6);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    // 拆了就不再掛著 update
    expect(kit.handlers.size).toBe(0);
  });

  it("蓋住：按了走 use_bonus_item，留著跟官方鈕一起淡出、不能再按；鈕拆了才跟著拆", async () => {
    const { B, kit, run, st } = make(2, 5);
    run(buildItemPanelPatchScript(COVER));
    const [c] = b(st);
    const base = c!.list[0]!;
    base.emit("pointerup");
    base.emit("pointerup");
    const use = B["use_bonus_item"] as ReturnType<typeof vi.fn>;
    expect(use.mock.calls.map((x) => x[0])).toEqual([6]);
    await flush();
    expect(base.input?.enabled).toBe(false);
    vi.advanceTimersByTime(600);
    expect(b(st)).toEqual([c]);
    const btn = B["btn_item"] as Obj;
    btn.setAlpha(0.3);
    kit.update();
    expect(c!.alpha).toBe(0.3);
    btn.destroy();
    vi.advanceTimersByTime(600);
    expect(b(st)).toHaveLength(0);
    expect(c!.scene).toBeUndefined();
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("蓋住：伺服器說不能用時重畫、又能按", async () => {
    const { run, st } = make(2, 5, false);
    run(buildItemPanelPatchScript(COVER));
    b(st)[0]!.list[0]!.emit("pointerup");
    await flush();
    vi.advanceTimersByTime(600);
    const [c] = b(st);
    expect(c!.list[0]!.input?.enabled).toBe(true);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("換位置當場重畫；狀態帶位置；舊版頁面回 not-installed", () => {
    const { run, st } = make(2, 5);
    run(buildItemPanelPatchScript(ABOVE));
    expect(b(st)[0]!.x).toBe(304);
    expect(run(buildItemPanelSetBonusPlaceExpression("cover"))).toBe("ok");
    expect(b(st)[0]!.x).toBe(265 + 45.5);
    expect(parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION)).bonusPlace).toBe("cover");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(run(buildItemPanelSetBonusPlaceExpression("above"))).toBe("not-installed");
  });

  it("沒有能用的道具：不蓋，使用物品照官方", () => {
    ITEMS = BONUS_ITEMS.map((x) => ({ ...x, quantity: 0 }));
    const { run, st } = make(2, 5);
    run(buildItemPanelPatchScript(COVER));
    expect(b(st)).toHaveLength(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

/**
 * 獎勵遊戲「下一個卡片／得到卡片」的樣子（2026-10-06 實機讀的）：大數字 dice_value 還停在
 * 上一回的底數；check_bonus_next 送 bonus_next、拆 next／get、建 High／Low、數字換成回來的底數。
 */
function decideScene(
  current: number,
  shown: number,
  nextReturns: number | null = current,
  Ctor: typeof Scene = Scene,
) {
  const B = new Ctor("Bonus");
  B.textures = {
    get: (_key: string) => ({ has: () => true }),
    exists: () => true,
  };
  B["bonus_data"] = { step: 56, dice_current: current, dice_previous: shown };
  const dv = new Obj(B, 594, 146);
  dv.frame = { name: `num_${shown}` };
  B["dice_value"] = dv;
  B["btn_next"] = new Obj(B, 265, 143).setInteractive();
  B["btn_get"] = new Obj(B, 385, 143).setInteractive();
  B["ulse17"] = { play: vi.fn() };
  const handlers = new Set<Fn>();
  B["events"] = {
    on: (_ev: string, fn: Fn) => handlers.add(fn),
    off: (_ev: string, fn: Fn) => handlers.delete(fn),
  };
  B["check_bonus_next"] = vi.fn(async function (this: Scene) {
    this.input.enabled = false;
    await Promise.resolve();
    if (nextReturns === null) return;
    (this["btn_next"] as Obj).destroy();
    (this["btn_get"] as Obj).destroy();
    this["btn_high"] = new Obj(this, 334, 74).setInteractive();
    this["btn_low"] = new Obj(this, 334, 194).setInteractive();
    (this["dice_value"] as Obj).setTexture("bonus_dice_num", `num_${nextReturns}`);
    this.input.enabled = true;
  });
  if (Ctor === Scene) B["bonus_prediction"] = vi.fn(() => Promise.resolve());
  return { B, update: () => handlers.forEach((fn) => fn()), handlers };
}

/** 官方的 bonus_prediction 在原型上（插件包在實例上）：鎖輸入、記下猜了什麼。 */
class BonusProtoScene extends Scene {
  predicted: string[] = [];
  bonus_prediction(pick: string) {
    this.input.enabled = false;
    this.predicted.push(pick);
    return Promise.resolve();
  }
}

/**
 * 官方 BonusDice：randomDiceThrow 擺好骰子＋prepareValues（不推物理），之後每個畫面格
 * updatePhysics 推一步、每顆 isFinished2 都 true 就停。這裡推 5 步會停。
 */
class DiceProtoScene extends Scene {
  steps = 0;
  thrown = 0;
  dice: { isFinished2: () => boolean }[] = [];
  randomDiceThrow(_values: number[]) {
    this.thrown++;
    this.steps = 0;
    this.dice = [0, 1].map(() => ({ isFinished2: () => this.steps >= 5 }));
    return Promise.resolve();
  }
  updatePhysics() {
    this.steps++;
  }
}

describe("獎勵遊戲的 High／Low 一起顯示", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const ON = { ...OFF, bonusHighLow: true };
  const mine = (st: () => Record<string, unknown>) => (st()["h"] as { mine: Obj[] }).mine;
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("下一個卡片／得到卡片出現時：上下兩格畫官方的 High／Low，大數字換成這一回的底數", () => {
    const { B } = decideScene(7, 5);
    const { run, st } = setup({ Bonus: B });
    const status = parseItemPanelStatus(run(buildItemPanelPatchScript(ON)));
    expect(status).toMatchObject({ bonusHighLow: true, highLowShown: true });
    const [hi, lo] = mine(st);
    expect([hi!.x, hi!.y, hi!.frame.name]).toEqual([334, 74, "bonus_high/0"]);
    expect([lo!.x, lo!.y, lo!.frame.name]).toEqual([334, 194, "bonus_low/0"]);
    expect((B["dice_value"] as Obj).frame.name).toBe("num_7");
    // 官方兩顆不動
    expect((B["btn_next"] as Obj).scene).toBe(B);
    expect((B["btn_get"] as Obj).scene).toBe(B);
    hi!.emit("pointerover");
    expect(hi!.frame.name).toBe(1);
    hi!.emit("pointerout");
    expect(hi!.frame.name).toBe(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("按 High：先走官方的下一個卡片，底數一樣才接著猜 high；只送這兩個", async () => {
    const { B } = decideScene(7, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    const [hi] = mine(st);
    hi!.emit("pointerup");
    hi!.emit("pointerup");
    await flush();
    expect(B["check_bonus_next"]).toHaveBeenCalledTimes(1);
    expect(B["bonus_prediction"]).toHaveBeenCalledTimes(1);
    expect(B["bonus_prediction"]).toHaveBeenCalledWith("high");
    expect((B["ulse17"] as { play: Fn }).play).toHaveBeenCalledTimes(1);
    expect(hi!.scene).toBeUndefined();
    expect(mine(st)).toHaveLength(0);
    // 官方 High／Low 在了：不再畫
    vi.advanceTimersByTime(600);
    expect(mine(st)).toHaveLength(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("⚠ 伺服器回的底數跟畫面上不一樣：不猜，停在官方的 High／Low 讓玩家重選", async () => {
    const { B } = decideScene(7, 5, 9);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    mine(st)[1]!.emit("pointerup");
    await flush();
    expect(B["check_bonus_next"]).toHaveBeenCalledTimes(1);
    expect(B["bonus_prediction"]).not.toHaveBeenCalled();
    expect((st()["h"] as { mismatch: number }).mismatch).toBe(1);
    expect((B["btn_low"] as Obj).scene).toBe(B);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("伺服器沒給底數（官方什麼都不做）：不猜", async () => {
    const { B } = decideScene(7, 5, null);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    mine(st)[0]!.emit("pointerup");
    await flush();
    expect(B["bonus_prediction"]).not.toHaveBeenCalled();
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("輸入鎖著（官方動畫中）按了不算", async () => {
    const { B } = decideScene(7, 7);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    B.input.enabled = false;
    mine(st)[0]!.emit("pointerup");
    await flush();
    expect(B["check_bonus_next"]).not.toHaveBeenCalled();
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("透明度跟著下一個卡片（淡入淡出）", () => {
    const { B, update } = decideScene(7, 7);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    (B["btn_next"] as Obj).setAlpha(0.3);
    update();
    expect(mine(st).map((o) => o.alpha)).toEqual([0.3, 0.3]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("玩家自己按官方的下一個卡片：下一輪就拆掉，不替他猜", async () => {
    const { B, handlers } = decideScene(7, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(ON));
    const [hi] = mine(st);
    await (B["check_bonus_next"] as () => Promise<void>).call(B);
    vi.advanceTimersByTime(600);
    expect(hi!.scene).toBeUndefined();
    expect(handlers.size).toBe(0);
    expect(B["bonus_prediction"]).not.toHaveBeenCalled();
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關著不畫；猜錯的狀態（使用物品／結束遊戲）不畫", () => {
    const off = decideScene(7, 5);
    const a = setup({ Bonus: off.B });
    a.run(buildItemPanelPatchScript(OFF));
    expect((a.st()["h"] as { mine: Obj[] }).mine).toHaveLength(0);
    expect((off.B["dice_value"] as Obj).frame.name).toBe("num_5");
    a.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const fail = bonusScene(2, 5);
    fail.textures = { get: () => ({ has: () => true }), exists: () => true };
    const b = setup({ Bonus: fail });
    b.run(buildItemPanelPatchScript(ON));
    expect((b.st()["h"] as { mine: Obj[] }).mine).toHaveLength(0);
    b.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("開關當場生效；關掉／拆掉時大數字放回官方原本那格", () => {
    const { B, handlers } = decideScene(7, 5);
    const { run, st } = setup({ Bonus: B });
    run(buildItemPanelPatchScript(OFF));
    expect(run(buildItemPanelSetPartExpression("bonusHighLow", true))).toBe("ok");
    expect(mine(st)).toHaveLength(2);
    expect((B["dice_value"] as Obj).frame.name).toBe("num_7");
    expect(run(buildItemPanelSetPartExpression("bonusHighLow", false))).toBe("ok");
    expect(mine(st)).toHaveLength(0);
    expect(handlers.size).toBe(0);
    expect((B["dice_value"] as Obj).frame.name).toBe("num_5");

    run(buildItemPanelSetPartExpression("bonusHighLow", true));
    const [hi] = mine(st);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(hi!.scene).toBeUndefined();
    expect((B["dice_value"] as Obj).frame.name).toBe("num_5");
  });
});

describe("獎勵遊戲跳過擲骰動畫", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  function scenes(nextReturns = 7) {
    const { B } = decideScene(7, 5, nextReturns, BonusProtoScene);
    const D = new DiceProtoScene("BonusDice");
    const R = new Scene("BonusResult");
    return { B: B as BonusProtoScene, D, R, all: { Bonus: B, BonusDice: D, BonusResult: R } };
  }

  it("按我們的 High：一回合 Bonus／BonusResult ×10、骰子擲出去當下推到停；輸入解鎖就還原", async () => {
    const { B, D, R, all } = scenes();
    const { run, st } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusHighLow: true, bonusFast: true }));
    (st()["h"] as { mine: Obj[] }).mine[0]!.emit("pointerup");
    expect([B.time.timeScale, B.tweens.timeScale, R.time.timeScale, R.tweens.timeScale]).toEqual([
      10, 10, 10, 10,
    ]);
    await flush();
    expect(B.predicted).toEqual(["high"]);
    // 官方 diceroll 叫的那支：當場推到停（跟每格推一步同一條路）
    await D.randomDiceThrow([3, 4]);
    expect([D.thrown, D.steps]).toEqual([1, 5]);
    // 還在演（輸入鎖著）：不還原
    vi.advanceTimersByTime(600);
    expect(B.time.timeScale).toBe(10);
    // bonus_success／bonus_fail 畫完、解鎖
    B.input.enabled = true;
    vi.advanceTimersByTime(600);
    expect([B.time.timeScale, B.tweens.timeScale, R.tweens.timeScale]).toEqual([1, 1, 1]);
    expect(Object.prototype.hasOwnProperty.call(D, "randomDiceThrow")).toBe(false);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(Object.prototype.hasOwnProperty.call(B, "bonus_prediction")).toBe(false);
  });

  it("按官方的 High／Low 也算（High／Low 一起顯示沒開）", async () => {
    const { B, D, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusFast: true }));
    void (B["bonus_prediction"] as (p: string) => Promise<void>)("low");
    expect(B.predicted).toEqual(["low"]);
    expect(B.time.timeScale).toBe(10);
    await D.randomDiceThrow([1, 1]);
    expect(D.steps).toBe(5);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect([B.time.timeScale, B.tweens.timeScale]).toEqual([1, 1]);
  });

  it("關著：不快轉、骰子照官方一格一步", async () => {
    const { B, D, all } = scenes();
    const { run, st } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusHighLow: true }));
    (st()["h"] as { mine: Obj[] }).mine[0]!.emit("pointerup");
    await flush();
    expect(B.predicted).toEqual(["high"]);
    expect(B.time.timeScale).toBe(1);
    await D.randomDiceThrow([3, 4]);
    expect(D.steps).toBe(0);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("底數不一樣沒猜：解鎖後還原", async () => {
    const { B, all } = scenes(9);
    const { run, st } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusHighLow: true, bonusFast: true }));
    (st()["h"] as { mine: Obj[] }).mine[0]!.emit("pointerup");
    await flush();
    expect(B.predicted).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(B.time.timeScale).toBe(1);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("開關當場生效；關掉時演到一半也還原", () => {
    const { B, D, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript(OFF));
    expect(Object.prototype.hasOwnProperty.call(B, "bonus_prediction")).toBe(false);
    expect(run(buildItemPanelSetPartExpression("bonusFast", true))).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(B, "bonus_prediction")).toBe(true);
    void (B["bonus_prediction"] as (p: string) => Promise<void>)("high");
    expect(B.time.timeScale).toBe(10);
    expect(run(buildItemPanelSetPartExpression("bonusFast", false))).toBe("ok");
    expect(B.time.timeScale).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(B, "bonus_prediction")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(D, "randomDiceThrow")).toBe(false);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

/**
 * 官方的 use_bonus_item 在原型上：先等 use_avatar_item（這裡用 gate 控制什麼時候回來），
 * 回 false 就什麼都不做（輸入沒鎖），不然鎖輸入。之後的 bonus_skip／bonus_restart 是伺服器推的。
 */
class RescueProtoScene extends Scene {
  used: number[] = [];
  allowed = true;
  release: () => void = () => undefined;
  async use_bonus_item(id: number) {
    this.used.push(id);
    await new Promise<void>((r) => (this.release = r));
    if (!this.allowed) return false;
    this.input.enabled = false;
    return undefined;
  }
}

describe("獎勵遊戲用道具救起來之後快轉", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  function scenes() {
    const { B } = decideScene(7, 5, 7, RescueProtoScene);
    const R = new Scene("BonusResult");
    return { B: B as RescueProtoScene, R, all: { Bonus: B, BonusResult: R } };
  }
  const use = (B: RescueProtoScene, id: number) =>
    void (B["use_bonus_item"] as (id: number) => Promise<unknown>)(id);

  it("用道具當下 Bonus／BonusResult ×10；道具還沒回來（輸入還開著）不收，演完解鎖才還原", async () => {
    const { B, R, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusRescueFast: true }));
    use(B, 6);
    expect(B.used).toEqual([6]);
    expect([B.time.timeScale, B.tweens.timeScale, R.time.timeScale, R.tweens.timeScale]).toEqual([
      10, 10, 10, 10,
    ]);
    // use_avatar_item 還沒回來：官方輸入還開著，但不算演完
    vi.advanceTimersByTime(600);
    expect(B.time.timeScale).toBe(10);
    B.release();
    await flush();
    // bonus_skip → 成功字樣、停 1500、卡片滑：輸入鎖著，繼續快
    vi.advanceTimersByTime(600);
    expect(B.time.timeScale).toBe(10);
    // bonus_success 畫完、解鎖
    B.input.enabled = true;
    vi.advanceTimersByTime(600);
    expect([B.time.timeScale, B.tweens.timeScale, R.time.timeScale, R.tweens.timeScale]).toEqual([
      1, 1, 1, 1,
    ]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(Object.prototype.hasOwnProperty.call(B, "use_bonus_item")).toBe(false);
  });

  it("伺服器說不能用（回 false、輸入沒鎖）：馬上還原", async () => {
    const { B, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusRescueFast: true }));
    B.allowed = false;
    use(B, 5);
    expect(B.time.timeScale).toBe(10);
    B.release();
    await flush();
    vi.advanceTimersByTime(600);
    expect([B.time.timeScale, B.tweens.timeScale]).toEqual([1, 1]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關著：照官方，不包 use_bonus_item；只開跳過擲骰動畫也不算", () => {
    const { B, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript({ ...OFF, bonusFast: true }));
    expect(Object.prototype.hasOwnProperty.call(B, "use_bonus_item")).toBe(false);
    use(B, 6);
    expect(B.time.timeScale).toBe(1);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("開關當場生效；關掉時演到一半也還原，跳過擲骰動畫那段不受影響", () => {
    const { B, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript(OFF));
    expect(run(buildItemPanelSetPartExpression("bonusRescueFast", true))).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(B, "use_bonus_item")).toBe(true);
    use(B, 7);
    expect(B.time.timeScale).toBe(10);
    expect(run(buildItemPanelSetPartExpression("bonusRescueFast", false))).toBe("ok");
    expect(B.time.timeScale).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(B, "use_bonus_item")).toBe(false);
    expect(parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION)).bonusRescueFast).toBe(false);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });
});

/** Phaser 場景的 events（on／once／off／emit）。 */
function sceneEvents() {
  const map = new Map<string, Fn[]>();
  const ev = {
    on: (name: string, fn: Fn) => void map.set(name, [...(map.get(name) ?? []), fn]),
    off: (name: string, fn: Fn) =>
      void map.set(
        name,
        (map.get(name) ?? []).filter((h) => h !== fn && (h as { inner?: Fn }).inner !== fn),
      ),
    once: (name: string, fn: Fn) => {
      const w: Fn = (...a) => {
        ev.off(name, w);
        return fn(...a);
      };
      (w as { inner?: Fn }).inner = fn;
      ev.on(name, w);
    },
    emit: (name: string, ...a: unknown[]) => [...(map.get(name) ?? [])].forEach((fn) => fn(...a)),
  };
  return ev;
}

/** 官方 Bonus 的得到卡片／結束遊戲（原型方法）。 */
class BonusEndScene extends Scene {
  gets = 0;
  quits = 0;
  events = sceneEvents();
  check_bonus_get() {
    this.gets++;
    return Promise.resolve();
  }
  check_bonus_quit() {
    this.quits++;
    return Promise.resolve();
  }
}

/** 官方 Result.result_end_bonus_quit：同步建 OK，OK 的 pointerup 收 Bonus → 回房間。 */
class ResultEndScene extends Scene {
  events = sceneEvents();
  cameras = {
    main: {
      alpha: 1,
      setAlpha(a: number) {
        this.alpha = a;
      },
    },
  };
  okPressed = 0;
  lvup: unknown = undefined;
  result_end_bonus_quit(_exp: number, _gem: number, _cExp: number, _cGem: number, lvup: unknown) {
    this.lvup = lvup;
    const ok = new Obj(this, 667, 621).setInteractive();
    ok.on("pointerup", () => void this.okPressed++);
    this["result_ok"] = ok;
    return Promise.resolve();
  }
}

describe("獎勵遊戲結束後不看第二次結算", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const ON = { ...OFF, bonusSkipEnd: true };
  function scenes() {
    const B = new BonusEndScene("Bonus");
    const R = new ResultEndScene("Result");
    return { B, R, all: { Bonus: B, Result: R } };
  }
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  it("得到卡片：動畫快轉，Bonus 收掉時還原", () => {
    const { B, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript(ON));
    void (B["check_bonus_get"] as () => Promise<void>)();
    expect(B.gets).toBe(1);
    expect([B.time.timeScale, B.tweens.timeScale]).toEqual([10, 10]);
    B.events.emit("shutdown");
    expect([B.time.timeScale, B.tweens.timeScale]).toEqual([1, 1]);
    void (B["check_bonus_quit"] as () => Promise<void>)();
    expect(B.quits).toBe(1);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("第二次結算：OK 當場替玩家按、藏起來快轉；Result 收掉時還原", () => {
    const { R, all } = scenes();
    const { run, st } = setup(all);
    run(buildItemPanelPatchScript(ON));
    void (R["result_end_bonus_quit"] as (...a: unknown[]) => Promise<void>)(10, 20, 0, 0, null);
    expect(R.okPressed).toBe(1);
    expect([R.cameras.main.alpha, R.time.timeScale, R.tweens.timeScale]).toEqual([0, 10, 10]);
    expect((st()["h"] as { endSkips: number }).endSkips).toBe(1);
    R.events.emit("shutdown");
    expect([R.cameras.main.alpha, R.time.timeScale, R.tweens.timeScale]).toEqual([1, 1, 1]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("有升級：一樣不用按 OK，但不藏不快轉（升級動畫照常看得到）", () => {
    const { R, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript(ON));
    void (R["result_end_bonus_quit"] as (...a: unknown[]) => Promise<void>)(10, 20, 0, 0, 31);
    expect(R.lvup).toBe(31);
    expect(R.okPressed).toBe(1);
    expect([R.cameras.main.alpha, R.time.timeScale]).toEqual([1, 1]);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關著照官方；開關當場生效；拆掉不留包裝", () => {
    const { B, R, all } = scenes();
    const { run } = setup(all);
    run(buildItemPanelPatchScript(OFF));
    expect([own(B, "check_bonus_get"), own(R, "result_end_bonus_quit")]).toEqual([false, false]);
    R.result_end_bonus_quit(1, 2, 0, 0, null);
    expect(R.okPressed).toBe(0);

    expect(run(buildItemPanelSetPartExpression("bonusSkipEnd", true))).toBe("ok");
    expect([
      own(B, "check_bonus_get"),
      own(B, "check_bonus_quit"),
      own(R, "result_end_bonus_quit"),
    ]).toEqual([true, true, true]);
    expect(run(buildItemPanelSetPartExpression("bonusSkipEnd", false))).toBe("ok");
    expect([own(B, "check_bonus_get"), own(R, "result_end_bonus_quit")]).toEqual([false, false]);

    run(buildItemPanelSetPartExpression("bonusSkipEnd", true));
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect([own(B, "check_bonus_quit"), own(R, "result_end_bonus_quit")]).toEqual([false, false]);
  });
});

describe("獎勵遊戲自動爬星", () => {
  const OFF = { shortcut: false, questStack: false, questPasses: false };
  const goals = (g: Partial<BonusClimbGoals> = {}): BonusClimbGoals => ({
    ...DEFAULT_BONUS_CLIMB_GOALS,
    ...g,
  });
  const climb = (
    win: Partial<BonusClimbGoals>,
    lose: Partial<BonusClimbGoals> = {},
  ): BonusClimbConfig => ({
    on: true,
    quit: false,
    charaValue: 150,
    win: goals(win),
    lose: goals(lose),
  });
  /** 讓輪詢跑 n 輪，每輪之間把官方那些 await 走完。 */
  const play = async (n = 30) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 8; j++) await Promise.resolve();
      vi.advanceTimersByTime(500);
    }
    for (let j = 0; j < 8; j++) await Promise.resolve();
  };
  const start = (game: ReturnType<typeof climbGame>, config: BonusClimbConfig, more = {}) => {
    const { run, st } = setup({ Bonus: game.B, Result: game.R });
    run(buildItemPanelPatchScript({ ...OFF, ...more, bonusClimb: config }));
    const status = () => parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION)).climb;
    return { run, st, status };
  };
  const card = (id: number, amount: number): Reward => ({
    reward_type: 1,
    reward_id: id,
    reward_amount: amount,
  });

  beforeEach(() => {
    ITEMS = BONUS_ITEMS.map((x) => ({ ...x }));
  });

  it("腳下那張就是勾選的目標：直接得到卡片，不往上爬", async () => {
    const game = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD } });
    const { run, status } = start(game, climb({ gem: true }));
    expect(status()).toMatchObject({ on: true, inBonus: true, group: "win", start: 75, step: 75 });
    await play(3);
    expect(game.log).toMatchObject({ next: 0, got: 75 });
    expect(game.B["check_bonus_get"]).toHaveBeenCalledTimes(1);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("經驗的加成卡（同一種 type、id 不同）不是 GEM", async () => {
    const game = climbGame({ start: 75, base: 5, cells: { 75: EXP_CARD, 76: GEM_CARD } });
    const { run } = start(game, climb({ gem: true }));
    await play();
    expect(game.log.got).toBe(76);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("目標在後面：下一個卡片 → 底數小猜大、大猜小 → 走到那一層才收", async () => {
    const game = climbGame({ start: 75, base: 5, cells: { 77: GEM_CARD }, rolls: [9, 3] });
    const { run, status } = start(game, climb({ gem: true }));
    expect(status()).toMatchObject({ stopped: null, what: "gem", cell: 77 });
    await play();
    expect(game.log).toEqual({ next: 2, picks: ["high", "low"], items: [], got: 77 });
    // 每按一下都有官方的按鈕聲
    expect((game.B["ulse17"] as { play: Fn }).play).toHaveBeenCalledTimes(5);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("同時看到好幾種：渦二 → 渦一 → 其他，會走過腳下的 GEM 與角色卡", async () => {
    const all = { gem: true, chara1: true, raid1: true, raid2: true };
    const a = climbGame({
      start: 75,
      base: 5,
      cells: { 75: GEM_CARD, 76: card(461, 7), 77: RAID1 },
    });
    const ra = start(a, climb(all));
    await play();
    expect(a.log.got).toBe(77);
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const b = climbGame({
      start: 75,
      base: 5,
      cells: { 75: GEM_CARD, 76: RAID1, 78: RAID2 },
    });
    const rb = start(b, climb(all));
    await play();
    expect(b.log.got).toBe(78);
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("角色卡、GEM、石楠3 之間誰近拿誰；EXP 墊底", async () => {
    const flower: Reward = { reward_type: 3, reward_id: 6, reward_amount: 1 };
    const all = { gem: true, chara1: true, heather3: true, exp: true };
    const cases: [Record<number, Reward>, number][] = [
      // 腳下的 GEM 贏過下一層的角色卡
      [{ 75: GEM_CARD, 76: card(461, 7) }, 75],
      [{ 76: card(461, 7), 77: GEM_CARD }, 76],
      [{ 76: GEM_CARD, 77: card(461, 7) }, 76],
      [{ 76: flower, 77: GEM_CARD, 78: card(461, 7) }, 76],
      // EXP 再近也排在後面；只有它的時候才拿
      [{ 75: EXP_CARD, 76: EXP_CARD, 78: flower }, 78],
      [{ 76: EXP_CARD }, 76],
    ];
    for (const [cells, want] of cases) {
      const game = climbGame({ start: 75, base: 5, cells });
      const r = start(game, climb(all));
      await play();
      expect(game.log.got).toBe(want);
      r.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    }
  });

  it("EXP 值很低（55 x 15 x 0.1 = 82）：猜錯不為它花道具", async () => {
    const game = climbGame({ start: 75, base: 6, cells: { 76: EXP_CARD }, rolls: [5] });
    const { run, status } = start(game, climb({ exp: true }));
    expect(status()).toMatchObject({ what: "exp", cell: 76 });
    await play();
    expect(game.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(status().stopped).toBe("notWorth");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("角色卡看牌組的位置：第二位的卡只有勾第二位才拿", async () => {
    const mk = () => climbGame({ start: 75, base: 5, cells: { 76: card(311, 7) } });
    const a = mk();
    const ra = start(a, climb({ chara2: true, chara2Within: 4 }));
    await play();
    expect(a.log.got).toBe(76);
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const b = mk();
    const rb = start(b, climb({ chara1: true, chara1Within: 4, chara3: true, chara3Within: 4 }));
    await play();
    expect(b.log).toMatchObject({ next: 0, got: null });
    expect(rb.status().stopped).toBe("noTarget");
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("⚠ x1 而且 Lv1 的角色卡是野生的，不拿；Lv3 的 x1、Lv1 的 x7 照拿", async () => {
    const wild = climbGame({ start: 75, base: 5, cells: { 76: card(461, 1) } });
    const rw = start(wild, climb({ chara1: true, chara1Within: 4 }));
    await play();
    expect(wild.log).toMatchObject({ next: 0, got: null });
    expect(rw.status().stopped).toBe("noTarget");
    rw.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    for (const reward of [card(463, 1), card(461, 7)]) {
      const game = climbGame({ start: 75, base: 5, cells: { 76: reward } });
      const r = start(game, climb({ chara1: true, chara1Within: 4 }));
      await play();
      expect(game.log.got).toBe(76);
      r.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    }
  });

  it("前 X 層從開局那一層算：超出去的不拿；還有沒露出來的就往上一層看", async () => {
    // 前 3 層＝75～77，GEM 在 78：看得到也不拿，交還給玩家
    const out = climbGame({ start: 75, base: 5, cells: { 78: GEM_CARD } });
    const ro = start(out, climb({ gem: true, gemWithin: 3 }));
    await play();
    expect(out.log).toMatchObject({ next: 0, got: null });
    expect(ro.status().stopped).toBe("noTarget");
    ro.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 前 6 層＝75～80，GEM 在 79：開局看不到（只到 78），往上一層就看到了
    const peek = climbGame({ start: 75, base: 5, cells: { 79: GEM_CARD } });
    const rp = start(peek, climb({ gem: true, gemWithin: 6 }));
    expect(rp.status()).toMatchObject({ what: "peek", cell: 80 });
    await play();
    expect(peek.log.got).toBe(79);
    rp.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // GEM 在 81：爬到 77 就把 80 以前都看過了，停在那裡
    const none = climbGame({ start: 75, base: 5, cells: { 81: GEM_CARD } });
    const rn = start(none, climb({ gem: true, gemWithin: 6 }));
    await play();
    expect(none.log).toMatchObject({ next: 2, got: null });
    expect(rn.status()).toMatchObject({ step: 77, stopped: "noTarget" });
    rn.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("渦二：看得到就拿（比 GEM 先）；一路找到上限還沒有 → 改拿 GEM 或渦一", async () => {
    const seen = climbGame({ start: 75, base: 5, cells: { 76: GEM_CARD, 77: RAID2 } });
    const rs = start(seen, climb({ gem: true, raid2: true, raid2Max: 105 }));
    await play();
    expect(seen.log.got).toBe(77);
    rs.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 沒勾 GEM：路上的 GEM（76）走過去；過了 78 層才拿（82）
    const cap = climbGame({ start: 75, base: 5, cells: { 76: GEM_CARD, 82: GEM_CARD } });
    const rc = start(cap, climb({ raid2: true, raid2Max: 78 }));
    expect(rc.status()).toMatchObject({ what: "seekRaid2", cell: 78 });
    await play(60);
    expect(cap.log.got).toBe(82);
    rc.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 過了上限渦一也拿（沒勾也算），而且比 GEM 先；上限以前的渦一（76）照樣走過去
    const r1 = climbGame({
      start: 75,
      base: 5,
      cells: { 76: RAID1, 80: GEM_CARD, 81: RAID1 },
    });
    const rr = start(r1, climb({ raid2: true, raid2Max: 78 }));
    await play(60);
    expect(r1.log.got).toBe(81);
    rr.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("100 層：一路爬到 100 層就交還給玩家，路上的 GEM 不拿、到了也不替他收", async () => {
    const game = climbGame({ start: 97, base: 5, cells: { 98: GEM_CARD } });
    const { run, status } = start(game, climb({ floor100: true }));
    expect(status()).toMatchObject({ what: "floor100", cell: 100 });
    await play();
    expect(game.log).toMatchObject({ next: 3, got: null });
    expect(status()).toMatchObject({ step: 100, stopped: "floor100" });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("猜錯、目標還有兩層：石楠5（過了這一層，下一層白拿好猜的底數）", async () => {
    const game = climbGame({ start: 75, base: 6, cells: { 77: RAID1 }, rolls: [2] });
    const { run } = start(game, climb({ raid1: true }));
    await play();
    expect(game.log).toMatchObject({ items: [7], picks: ["high", "high"], got: 77 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("⚠ 猜錯、下一層就是目標、骰壞的是 2：四葉草先，重投後拿 2 當底數重猜", async () => {
    const game = climbGame({ start: 75, base: 6, cells: { 76: RAID1 }, rolls: [2, 9] });
    const { run } = start(game, climb({ raid1: true }));
    await play();
    expect(game.log).toEqual({ next: 1, picks: ["high", "high"], items: [4], got: 76 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("下一層是目標但四葉草沒了：石楠5，再沒有就跳越星", async () => {
    const mk = () => climbGame({ start: 75, base: 6, cells: { 76: RAID1 }, rolls: [2] });
    const gone = (id: number) => (ITEMS.find((x) => x.item_id === id)!.quantity = 0);
    gone(4);
    const a = mk();
    const ra = start(a, climb({ raid1: true }));
    await play();
    expect(a.log).toMatchObject({ items: [7], got: 76 });
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    gone(7);
    const b = mk();
    const rb = start(b, climb({ raid1: true }));
    await play();
    expect(b.log).toMatchObject({ items: [8], got: 76 });
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("差距小：夠用的小石楠先，就算下一層是目標、骰壞的是 2", async () => {
    // 5 猜大出 2（差 3）→ 石楠3
    const a = climbGame({ start: 75, base: 5, cells: { 76: RAID1 }, rolls: [2] });
    const ra = start(a, climb({ raid1: true }));
    await play();
    expect(a.log).toMatchObject({ items: [6], got: 76 });
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 6 猜大出 5（差 1）→ 石楠1
    const b = climbGame({ start: 75, base: 6, cells: { 76: RAID1 }, rolls: [5] });
    const rb = start(b, climb({ raid1: true }));
    await play();
    expect(b.log).toMatchObject({ items: [5], got: 76 });
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("下一層是目標但骰壞的不好猜（5）、小石楠又沒了：照平常的順序用石楠5，不用四葉草", async () => {
    ITEMS.find((x) => x.item_id === 5)!.quantity = 0;
    ITEMS.find((x) => x.item_id === 6)!.quantity = 0;
    const game = climbGame({ start: 75, base: 6, cells: { 76: RAID1 }, rolls: [5] });
    const { run } = start(game, climb({ raid1: true }));
    await play();
    expect(game.log).toMatchObject({ items: [7], got: 76 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("GEM、石楠3 是買得到的：只准石楠1，而且救起來的期望要比它貴", async () => {
    // GEM 卡 37 x 19 x 1.5 = 1054；下一層 → 期望 724，差 1 用石楠1
    const a = climbGame({ start: 75, base: 6, cells: { 76: GEM_CARD }, rolls: [5] });
    const ra = start(a, climb({ gem: true }));
    await play();
    expect(a.log).toMatchObject({ items: [5], got: 76 });
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 差 4：石楠1 救不了，石楠5 不准用 → 不救
    const b = climbGame({ start: 75, base: 6, cells: { 76: GEM_CARD }, rolls: [2] });
    const rb = start(b, climb({ gem: true }));
    await play();
    expect(b.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(b.B["check_bonus_quit"]).not.toHaveBeenCalled();
    expect(rb.status().stopped).toBe("notWorth");
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 倍率只有 3 的 GEM 卡（166）：期望 114 比石楠1 的 200 還少 → 差 1 也不救
    const cheap: Reward = { reward_type: 9, reward_id: 2, reward_amount: 300 };
    const c = climbGame({ start: 75, base: 6, cells: { 76: cheap }, rolls: [5] });
    const rc = start(c, climb({ gem: true }));
    await play();
    expect(c.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(rc.status().stopped).toBe("notWorth");
    rc.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 石楠3（540）還有三層：540 x 0.687^3 = 175 → 不救；剩兩層（255）就救
    const flower: Reward = { reward_type: 3, reward_id: 6, reward_amount: 1 };
    const d = climbGame({ start: 55, base: 6, cells: { 58: flower }, rolls: [5], result: "lose" });
    const rd = start(d, climb({}, { heather3: true }));
    await play();
    expect(d.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(rd.status().stopped).toBe("notWorth");
    rd.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    const e = climbGame({ start: 55, base: 6, cells: { 57: flower }, rolls: [5], result: "lose" });
    const re = start(e, climb({}, { heather3: true }));
    await play();
    expect(e.log).toMatchObject({ items: [5], got: 57 });
    re.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("角色卡的價值照玩家填的算（x 張數）：填得低就不值得花石楠5", async () => {
    const mk = () => climbGame({ start: 75, base: 6, cells: { 76: card(461, 7) }, rolls: [2] });
    // 預設一張 150：150 x 7 − 246 = 804，比四葉草／石楠5（900）便宜 → 差 4 不救
    const a = mk();
    const ra = start(a, climb({ chara1: true }));
    await play();
    expect(a.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(ra.status().stopped).toBe("notWorth");
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 同一張卡差 3：石楠3（540）比 804 便宜 → 救
    const near = climbGame({ start: 75, base: 5, cells: { 76: card(461, 7) }, rolls: [2] });
    const rn = start(near, climb({ chara1: true }));
    await play();
    expect(near.log).toMatchObject({ items: [6], got: 76 });
    rn.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 填 2200：下一層就是目標、骰壞的是 2 → 四葉草
    const b = mk();
    const rb = start(b, { ...climb({ chara1: true }), charaValue: 2200 });
    await play();
    expect(b.log).toMatchObject({ items: [4], got: 76 });
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("一定要到的（往上找渦二、100 層）不算划不划算；往上看前幾層的不救", async () => {
    const seek = climbGame({ start: 75, base: 6, rolls: [2] });
    const rs = start(seek, climb({ raid2: true, raid2Max: 77 }));
    await play(12);
    expect(seek.log.items).toEqual([7]);
    rs.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const floor = climbGame({ start: 98, base: 6, rolls: [2] });
    const rf = start(floor, climb({ floor100: true }));
    await play();
    expect(floor.log.items).toEqual([7]);
    expect(rf.status()).toMatchObject({ step: 100, stopped: "floor100" });
    rf.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const peek = climbGame({ start: 75, base: 6, rolls: [5] });
    const rp = start(peek, climb({ gem: true, gemWithin: 6 }));
    await play();
    expect(peek.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(rp.status()).toMatchObject({ step: 75, stopped: "notWorth" });
    rp.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("允許直接結束：不划算、沒有能用的道具都按結束遊戲，只按一次", async () => {
    const a = climbGame({ start: 75, base: 6, cells: { 76: GEM_CARD }, rolls: [2] });
    const ra = start(a, { ...climb({ gem: true }), quit: true });
    await play();
    expect(a.B["check_bonus_quit"]).toHaveBeenCalledTimes(1);
    expect(a.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(ra.status().stopped).toBe("quitNotWorth");
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    ITEMS.forEach((x) => (x.quantity = 0));
    const b = climbGame({ start: 75, base: 6, cells: { 77: RAID1 }, rolls: [2] });
    const rb = start(b, { ...climb({ raid1: true }), quit: true });
    await play();
    expect(b.B["check_bonus_quit"]).toHaveBeenCalledTimes(1);
    expect(rb.status().stopped).toBe("quitNoItem");
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("估價的常數跟 Moon 對得上：一層的勝率 0.687、每層花費 246", () => {
    expect(BONUS_CLIMB_WIN_RATE).toBeCloseTo(0.687, 3);
    expect(Math.round(BONUS_CLIMB_STEP_COST)).toBe(246);
    expect(bonusGuessWinRate(2)).toBeCloseTo(35 / 36, 6);
    expect(bonusGuessWinRate(7)).toBeCloseTo(15 / 36, 6);
  });

  it("猜錯沒有能用的道具：交還給玩家，不替他按結束遊戲；之後也不再動", async () => {
    ITEMS.forEach((x) => (x.quantity = 0));
    const game = climbGame({ start: 75, base: 6, cells: { 77: RAID1 }, rolls: [2] });
    const { run, status } = start(game, climb({ raid1: true }));
    await play();
    expect(status()).toMatchObject({ step: 75, stopped: "noItem" });
    expect(game.B["use_bonus_item"]).not.toHaveBeenCalled();
    expect(game.B["check_bonus_quit"]).not.toHaveBeenCalled();
    expect(game.log).toMatchObject({ next: 1, got: null });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("伺服器說道具不能用：交還給玩家，不一直重送", async () => {
    const game = climbGame({
      start: 75,
      base: 6,
      cells: { 77: RAID1 },
      rolls: [2],
      refuse: true,
    });
    const { run, status } = start(game, climb({ raid1: true }));
    await play();
    expect(game.B["use_bonus_item"]).toHaveBeenCalledTimes(1);
    expect(status().stopped).toBe("itemRefused");
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("勝場、敗場各看各的那一組；平手、時間到算敗場", async () => {
    for (const result of ["lose", "draw", "timeup"]) {
      const game = climbGame({ start: 55, base: 5, cells: { 55: GEM_CARD, 56: RAID1 }, result });
      const { run, status } = start(game, climb({ gem: true }, { raid1: true }));
      expect(status().group).toBe("lose");
      await play();
      expect(game.log.got).toBe(56);
      run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    }
    const win = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD, 76: RAID1 } });
    const rw = start(win, climb({ gem: true }, { raid1: true }));
    await play();
    expect(win.log.got).toBe(75);
    rw.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("白色石楠3 也能當目標（敗場那組的選項）；跟 GEM 同時看到時拿近的", async () => {
    const flower: Reward = { reward_type: 3, reward_id: 6, reward_amount: 1 };
    const a = climbGame({ start: 55, base: 5, cells: { 57: flower }, result: "lose" });
    const ra = start(a, climb({}, { heather3: true }));
    expect(ra.status()).toMatchObject({ group: "lose", what: "heather3", cell: 57 });
    await play();
    expect(a.log.got).toBe(57);
    ra.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const b = climbGame({
      start: 55,
      base: 5,
      cells: { 56: flower, 57: GEM_CARD },
      result: "lose",
    });
    const rb = start(b, climb({}, { heather3: true, gem: true }));
    await play();
    expect(b.log.got).toBe(56);
    rb.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    // 沒勾就只是一張普通的獎品
    const c = climbGame({ start: 55, base: 5, cells: { 56: flower }, result: "lose" });
    const rc = start(c, climb({}, { gem: true, gemWithin: 4 }));
    await play();
    expect(c.log).toMatchObject({ next: 0, got: null });
    rc.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("關著、什麼都沒勾、輸入鎖著：都不替玩家按", async () => {
    const off = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD } });
    const ro = start(off, { ...climb({ gem: true }), on: false });
    await play(4);
    expect(off.log).toMatchObject({ next: 0, got: null });
    expect(ro.status()).toMatchObject({ on: false, inBonus: true, stopped: null });
    ro.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const none = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD } });
    const rn = start(none, climb({}));
    await play(4);
    expect(none.log).toMatchObject({ next: 0, got: null });
    expect(rn.status().stopped).toBe("noTarget");
    rn.run(ITEM_PANEL_UNINSTALL_EXPRESSION);

    const locked = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD } });
    locked.B.input.enabled = false;
    const rl = start(locked, climb({ gem: true }));
    await play(4);
    expect(locked.log.got).toBeNull();
    locked.B.input.enabled = true;
    await play(2);
    expect(locked.log.got).toBe(75);
    rl.run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("獎品列還沒換成這一層的（reward_step 對不上）：等，不照舊的那一列走", async () => {
    const game = climbGame({ start: 75, base: 5, cells: { 75: GEM_CARD } });
    const fresh = game.B["bonus_rewards"];
    game.B["bonus_rewards"] = (fresh as { reward_step: number }[]).map((r) => ({
      ...r,
      reward_step: r.reward_step - 1,
    }));
    const { run } = start(game, climb({ gem: true }));
    await play(3);
    expect(game.log.got).toBeNull();
    game.B["bonus_rewards"] = fresh;
    await play(2);
    expect(game.log.got).toBe(75);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("換設定當場生效：交還之後換了目標就重新來；關掉就停", async () => {
    const game = climbGame({ start: 75, base: 5, cells: { 77: GEM_CARD } });
    const { run, status } = start(game, climb({}));
    await play(2);
    expect(status().stopped).toBe("noTarget");
    expect(run(buildItemPanelSetBonusClimbExpression(climb({ gem: true })))).toBe("ok");
    expect(status()).toMatchObject({ stopped: null, what: "gem", cell: 77 });
    await play(2);
    run(buildItemPanelSetBonusClimbExpression({ ...climb({ gem: true }), on: false }));
    const at = game.log.next;
    await play(10);
    expect(game.log).toMatchObject({ next: at, got: null });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
    expect(run(buildItemPanelSetBonusClimbExpression(climb({})))).toBe("not-installed");
  });

  it("在跑的時候不畫捷徑與 High／Low；交還之後才畫", async () => {
    const game = climbGame({ start: 98, base: 5 });
    const { run, st } = start(game, climb({ floor100: true }), {
      bonusHighLow: true,
      bonusItem: true,
    });
    const hl = () => (st()["h"] as { mine: Obj[] }).mine;
    expect(hl()).toHaveLength(0);
    await play();
    expect(game.log.next).toBe(2);
    expect(hl()).toHaveLength(2);
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("下一場從頭算：開局層、分組、交還都重來", async () => {
    const game = climbGame({ start: 75, base: 5 });
    const { run, status } = start(game, climb({}));
    await play(2);
    expect(status()).toMatchObject({ start: 75, stopped: "noTarget" });
    (game.B["bonus_star"] as Obj).destroy();
    await play(1);
    expect(status()).toMatchObject({ inBonus: false, start: null, stopped: null });
    game.B["bonus_star"] = new Obj(game.B, 258, 8);
    game.B["bonus_data"] = { step: 55, dice_current: 5, dice_previous: 5 };
    (game.R["result_params"] as { result: string }).result = "lose";
    await play(1);
    expect(status()).toMatchObject({ inBonus: true, group: "lose", start: 55 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("設定整理：缺的補預設、數字夾回範圍、不是布林的當沒勾", () => {
    expect(normalizeBonusClimb(undefined)).toEqual({
      on: false,
      quit: false,
      charaValue: 150,
      win: DEFAULT_BONUS_CLIMB_GOALS,
      lose: DEFAULT_BONUS_CLIMB_GOALS,
    });
    const c = normalizeBonusClimb({
      on: true,
      quit: 1,
      charaValue: -5,
      win: { gem: "yes", gemWithin: 0, raid2: true, raid2Max: 9999, raid1Within: 2.6 },
      lose: { chara1: true, chara1Within: Number.NaN },
    });
    expect(c.on).toBe(true);
    expect(c).toMatchObject({ quit: false, charaValue: 0 });
    expect(c.win).toMatchObject({ gem: false, gemWithin: 1, raid2: true, raid2Max: 500 });
    expect(c.win.raid1Within).toBe(3);
    expect(c.lose).toMatchObject({ chara1: true, chara1Within: 6, raid2: false, raid2Max: 105 });
  });
});

describe("狀態", () => {
  it("重裝只留一份；狀態帶版本", () => {
    const R = raidScene();
    const { run, st } = setup({ Raid: R });
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    run(buildItemPanelPatchScript({ shortcut: true, questStack: false, questPasses: false }));
    expect(st().mine).toHaveLength(4);
    expect(R.children.list.filter((o) => o instanceof MenuButton)).toHaveLength(3 + 4);
    const s = parseItemPanelStatus(run(ITEM_PANEL_STATUS_EXPRESSION));
    expect(s).toMatchObject({ installed: true, version: ITEM_PANEL_SCRIPT_VERSION, buttons: 4 });
    run(ITEM_PANEL_UNINSTALL_EXPRESSION);
  });

  it("讀不懂的回應不丟例外", () => {
    expect(parseItemPanelStatus("<html>").installed).toBe(false);
    expect(parseItemPanelStatus(JSON.stringify({ installed: false })).installed).toBe(false);
  });
});
