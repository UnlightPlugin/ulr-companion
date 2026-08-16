/**
 * 卡片名冊 —— 規則鍵 → 玩家看得懂的東西
 * =======================================
 * 規則檔裡是 `cc001_01`、`wp015`、`ev091`。**玩家不該看到那些。**
 * 這支定義的是「編號 → 中文名 + 版面位置」的那份對照，編輯 COST 的介面
 * 完全靠它活著。
 *
 * ## 為什麼名冊是一份會過期的快取，不是寫死的常數
 *
 * 名字與卡片數量會隨遊戲改版變動（2026-08-16 是 70 位角色、46 種怪物、
 * 238 件裝備、110 張事件卡）。寫死一份在插件裡，改版當天就會少掉新角色，
 * 而症狀是「新角色在編輯器裡看不到、也就永遠改不了價」。
 *
 * 所以名冊是**從玩家自己的客戶端讀出來**的（`buildCatalog`），存成快取重複
 * 使用 —— 跟 COST 表本身同一個道理：客戶端永遠是他實際在玩的那一版。
 *
 * ## 版面規則來自玩家的要求，不是我挑的
 *
 * - **角色**：一位一排，`L1~L5 R1~R5` 共 10 格（實測 70 位剛好每位 10 張）
 * - **怪物**：`M1~M3`，一排放三種怪物 → 9 格（實測 46 種剛好每種 3 張）
 * - **事件卡**：9 格一排，照客戶端自己的順序分族群斷行
 * - **裝備**：照角色限制分組（專武），通用的排在最前面
 */

import { equipmentKey, eventCardKey } from "./card-key.js";

/** 名冊格式版本。形狀變了就加一，舊快取會被丟掉重讀。 */
export const CATALOG_VERSION = 2;

/** 一張具名卡（角色或怪物）在名冊裡的樣子。 */
export interface CatalogCard {
  /** 規則鍵 —— `cc001_01` / `mc001_01` */
  key: string;
  /** 版面上的短標籤 —— `L1`、`R4`、`M2` */
  slot: string;
  /** 原版 COST。編輯器拿它當「改回原價」的基準。 */
  baseCost: number;
}

/** 一位角色 / 一種怪物 = 版面上的一組。 */
export interface CatalogGroup {
  /** 代號，`cc001` / `mc001`。**不顯示給玩家**，只拿來當 DOM id 與排序鍵。 */
  id: string;
  /** 中文名 —— 這才是玩家看到的東西。 */
  name: string;
  cards: CatalogCard[];
}

/** 一張索引型卡（裝備或事件卡）。 */
export interface CatalogItem {
  /** 規則鍵 —— `wp015` / `ev091` */
  key: string;
  name: string;
  baseCost: number;
}

/** 裝備照「這是誰的專武」分組。 */
export interface CatalogEquipmentGroup {
  /** 角色代號；通用裝備是 `null`。 */
  charaId: string | null;
  /** 顯示用：角色名，或「通用」。 */
  name: string;
  items: CatalogItem[];
}

/** 事件卡照客戶端自己的順序切成族群。 */
export interface CatalogEventGroup {
  /** 族群名 —— 從第一張卡的名字取的（`劍`、`槍`、`機會卡`…）。 */
  name: string;
  items: CatalogItem[];
}

export interface CardCatalog {
  version: typeof CATALOG_VERSION;
  /** 讀的時候客戶端是哪一版。跟規則的 `gameVersion` 對不上時要提醒。 */
  gameVersion: string;
  /** ISO 時間。UI 顯示「什麼時候讀的」。 */
  readAt: string;
  characters: CatalogGroup[];
  monsters: CatalogGroup[];
  equipment: CatalogEquipmentGroup[];
  eventCards: CatalogEventGroup[];
}

// ---------------------------------------------------------------------------
// 建名冊
// ---------------------------------------------------------------------------

/** `buildCatalog` 的輸入。全部直接來自 `@ulr/cdp-adapter` 的四個讀取器。 */
export interface CatalogSource {
  gameVersion: string;
  /** `cc_asset` 的卡（已濾掉保留空位）。 */
  characters: readonly { filename: string; chara: string; cost: number }[];
  /** `mc_asset` 的卡。 */
  monsters: readonly { filename: string; cost: number }[];
  /** `avatar_item.weapon`，索引就是 `wp` 鍵的來源。 */
  equipment: readonly { index: number; name: string; cost: number; chara: string | null }[];
  /** `event_info.frames`。 */
  eventCards: readonly { index: number; name: string; cost: number }[];
  /** `charaProfile` / `monsProfile` 的名字。 */
  profiles: { characters: Record<string, string>; monsters: Record<string, string> };
}

/**
 * `cc001_01` → `L1`、`cc001_r04` → `R4`、`mc001_02` → `M2`。
 *
 * ⚠ **不要用資產裡的 `level` 欄位。** L4 與 R4 的 `level` 都是 4，只有
 * filename 分得開（open-questions 第 1 題）—— 版面標籤跟規則鍵必須看同一個
 * 東西，否則覺醒卡會全部標成一般卡。
 */
export function slotLabel(filename: string): string {
  const m = /_(r?)(\d+)$/.exec(filename);
  if (m === null) return filename;
  const level = String(Number(m[2]));
  if (filename.startsWith("mc")) return `M${level}`;
  return `${m[1] === "r" ? "R" : "L"}${level}`;
}

/** 排序用：L1…L5 → 0…4，R1…R5 → 5…9，M1…M3 → 0…2。 */
function slotOrder(filename: string): number {
  const m = /_(r?)(\d+)$/.exec(filename);
  if (m === null) return 0;
  return (m[1] === "r" ? 5 : 0) + Number(m[2]) - 1;
}

/** 名字的族群 = 開頭那一段非數字。`劍1卡`→`劍`、`機會卡1`→`機會卡`。 */
function familyOf(name: string): string {
  const m = /^[^\d]+/.exec(name);
  const head = (m?.[0] ?? name).trim();
  // `劍3·槍1卡` 的開頭是 `劍`（第一個數字前就斷了），正是我們要的。
  return head === "" ? name : head;
}

/**
 * 一族至少要這麼多張才配有自己的標題。
 *
 * 實測（2026-08-16）事件卡的**前段**是七個漂亮的大族（劍 21、槍 21、防禦 12、
 * 移動 12、特殊 12、機會卡 5、詛咒術 5），**尾段**則是歷次改版陸續加上去的
 * 零星卡：`聖水`、`聖杯卡`、`毒杯卡`、`病毒`、`聚焦卡` 各一張，中間還夾著
 * 三張同名的 `Hp恢復`。照族群硬切會產生一堆只有一張卡的區塊 —— 版面全是標題
 * 沒有內容。
 */
const MIN_GROUP = 4;

/** 尾段那一塊的名字。 */
const MISC_GROUP = "其他";

/**
 * 照客戶端自己的順序切成族群。
 *
 * 規則只有兩條：
 *
 * 1. 連續同族且**夠多張**（≥ {@link MIN_GROUP}）→ 自成一塊，用族名當標題
 * 2. 一旦碰到不夠多的那一族 → 從此全部進「其他」
 *
 * 第 2 條看起來粗暴，但它對應的是真實的資料形狀：不夠多的族**全部集中在尾段**。
 * 「碰到就往後全收」比「一族一族判斷」少一個失敗模式 —— 後者會在尾段生出
 * 第二個「劍」區塊（`劍1·槍1卡` 那幾張），而畫面上兩個同名區塊隔得老遠，
 * 看起來就像 bug。
 *
 * ⚠ **順序絕對不能動。** 客戶端的索引順序本身就是資訊（劍1…劍9 是連號的），
 * 而且規則鍵就是索引 —— 重排只會讓人對不上遊戲裡看到的排列。
 */
function chunkByFamily(items: readonly CatalogItem[]): CatalogEventGroup[] {
  // 先算出每一段「連續同族」有多長，才知道它配不配有自己的標題。
  const runs: { name: string; items: CatalogItem[] }[] = [];
  for (const item of items) {
    const family = familyOf(item.name);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.name === family) last.items.push(item);
    else runs.push({ name: family, items: [item] });
  }

  const groups: CatalogEventGroup[] = [];
  let inMisc = false;
  for (const run of runs) {
    if (!inMisc && run.items.length >= MIN_GROUP) {
      groups.push({ name: run.name, items: [...run.items] });
      continue;
    }
    inMisc = true;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === MISC_GROUP) last.items.push(...run.items);
    else groups.push({ name: MISC_GROUP, items: [...run.items] });
  }
  return groups;
}

/**
 * 把四份原始資料組成名冊。
 *
 * **純函式** —— 名冊會被存成快取檔並在沒有遊戲時使用，所以它不能依賴
 * 任何執行期狀態。
 */
export function buildCatalog(src: CatalogSource): CardCatalog {
  // ── 角色：一位一排，L1~L5 R1~R5 ──────────────────────────────────────
  const byChara = new Map<string, CatalogCard[]>();
  for (const c of src.characters) {
    const list = byChara.get(c.chara) ?? [];
    list.push({ key: c.filename, slot: slotLabel(c.filename), baseCost: c.cost });
    byChara.set(c.chara, list);
  }
  const characters: CatalogGroup[] = [...byChara.entries()]
    .map(([id, cards]) => ({
      id,
      // 查不到名字時退回代號 —— 空字串會讓那一排看起來像壞掉的。
      name: src.profiles.characters[id] ?? id,
      cards: cards.sort((a, b) => slotOrder(a.key) - slotOrder(b.key)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // ── 怪物：M1~M3 ───────────────────────────────────────────────────────
  const byMons = new Map<string, CatalogCard[]>();
  for (const m of src.monsters) {
    const id = m.filename.split("_")[0] ?? m.filename;
    const list = byMons.get(id) ?? [];
    list.push({ key: m.filename, slot: slotLabel(m.filename), baseCost: m.cost });
    byMons.set(id, list);
  }
  const monsters: CatalogGroup[] = [...byMons.entries()]
    .map(([id, cards]) => {
      const sorted = cards.sort((a, b) => slotOrder(a.key) - slotOrder(b.key));
      // ⚠ monsProfile 的鍵是**整個 filename**，不是 `mc001`。拿 M1 那張去查。
      const first = sorted[0]?.key ?? id;
      return { id, name: src.profiles.monsters[first] ?? id, cards: sorted };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // ── 裝備：照專武的主人分組，通用排最前 ────────────────────────────────
  const byOwner = new Map<string, CatalogItem[]>();
  for (const w of src.equipment) {
    const owner = w.chara ?? "";
    const list = byOwner.get(owner) ?? [];
    list.push({ key: equipmentKey(w.index), name: w.name, baseCost: w.cost });
    byOwner.set(owner, list);
  }
  const equipment: CatalogEquipmentGroup[] = [...byOwner.entries()]
    .map(([owner, items]) => {
      if (owner === "") return { charaId: null, name: "通用", items };
      const name = src.profiles.characters[owner];
      // ⚠ **查不到名字時不能退回代號**，那正是這個功能要消滅的東西。
      // 實測 2026-08-16：`cc000` 綁著五件素材（異化礦材、魔之刀身…），而
      // `charaProfile` 裡根本沒有 cc000 —— 它是遊戲自己的佔位角色，不是人。
      // 這種組併進「通用」是誠實的：它們確實不屬於任何一位角色。
      return name === undefined
        ? { charaId: null, name: "通用", items }
        : { charaId: owner, name, items };
    })
    // 同名的組要合併 —— 上面把查不到名字的都改成「通用」了。
    .reduce<CatalogEquipmentGroup[]>((acc, g) => {
      const same = acc.find((x) => x.charaId === g.charaId);
      if (same === undefined) acc.push(g);
      else same.items.push(...g.items);
      return acc;
    }, [])
    // 通用（charaId null）排最前面，其餘照角色代號。
    .sort((a, b) => {
      if (a.charaId === null) return -1;
      if (b.charaId === null) return 1;
      return a.charaId < b.charaId ? -1 : 1;
    });

  // ── 事件卡：照客戶端順序，族群變了就換一塊 ────────────────────────────
  const eventItems: CatalogItem[] = src.eventCards.map((e) => ({
    key: eventCardKey(e.index),
    name: e.name,
    baseCost: e.cost,
  }));

  return {
    version: CATALOG_VERSION,
    gameVersion: src.gameVersion,
    readAt: new Date().toISOString(),
    characters,
    monsters,
    equipment,
    eventCards: chunkByFamily(eventItems),
  };
}

/**
 * 檢查一份讀回來的名冊能不能用。**壞掉一律 `null`，不拋例外** ——
 * 快取檔可能是舊版、可能被手改壞，那時該做的是重讀，不是讓插件開不起來。
 */
export function parseCatalog(value: unknown): CardCatalog | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c["version"] !== CATALOG_VERSION) return null;
  if (typeof c["gameVersion"] !== "string" || typeof c["readAt"] !== "string") return null;
  if (!Array.isArray(c["characters"]) || c["characters"].length === 0) return null;
  if (!Array.isArray(c["monsters"])) return null;
  if (!Array.isArray(c["equipment"])) return null;
  if (!Array.isArray(c["eventCards"])) return null;
  return value as unknown as CardCatalog;
}

/** 名冊裡總共幾張卡。UI 要顯示「這份名冊涵蓋多少東西」。 */
export function catalogSize(catalog: CardCatalog): {
  characters: number;
  monsters: number;
  equipment: number;
  eventCards: number;
} {
  const sum = (n: number, len: number) => n + len;
  return {
    characters: catalog.characters.map((g) => g.cards.length).reduce(sum, 0),
    monsters: catalog.monsters.map((g) => g.cards.length).reduce(sum, 0),
    equipment: catalog.equipment.map((g) => g.items.length).reduce(sum, 0),
    eventCards: catalog.eventCards.map((g) => g.items.length).reduce(sum, 0),
  };
}
