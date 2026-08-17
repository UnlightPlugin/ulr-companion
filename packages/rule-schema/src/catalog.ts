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

/**
 * 名冊格式版本。形狀變了就加一，舊快取會被丟掉重讀。
 *
 * 3（2026-08-16）：事件卡多了 `info` 與 `slotType`。**一定要加**，否則舊快取
 * 會通過 `parseCatalog` 而那兩個欄位是空的 —— 症狀是「事件卡沒有顏色也沒有
 * 效果，而且重讀名冊也修不好」。
 *
 * 4（2026-08-17）：具名卡多了 `locked`（官方還沒開放）。同樣**一定要加** ——
 * 舊快取沒有這一欄，而 `locked` 缺席會被讀成 falsy，也就是「全部都出了」。
 * 那個方向剛好是安全的（頂多是功能沒生效），但玩家會以為插件壞了，而且
 * 「重讀名冊」看起來沒有用。版本加一之後 `parseCatalog` 直接退掉舊快取，
 * 編輯器會明確地要求重讀。
 */
export const CATALOG_VERSION = 4;

/** 一張具名卡（角色或怪物）在名冊裡的樣子。 */
export interface CatalogCard {
  /** 規則鍵 —— `cc001_01` / `mc001_01` */
  key: string;
  /** 版面上的短標籤 —— `L1`、`R4`、`M2` */
  slot: string;
  /** 原版 COST。編輯器拿它當「改回原價」的基準。 */
  baseCost: number;
  /**
   * 官方還沒開放這張卡 —— 資產裡有完整資料，但**沒有任何配方做得出它**。
   *
   * `cc_asset` 一次就把每位角色的十張全部寫好（數值、技能、插槽都完整），
   * 跟官方開放了沒完全無關。2026-08-17 實測 700 張裡有 69 張沒有配方，
   * 全部是 R1~R5；`L2~L5` 一張都沒有。判準見 `@ulr/cdp-adapter` 的
   * `cardAssetReadExpression`。
   *
   * ⚠ **這是給畫面用的，不是給規則用的。** 編輯器可以不畫它們，但
   * **絕對不能把它們從草稿或存檔裡拿掉** —— 規則沒定價的卡在引擎裡算
   * `UNKNOWN_COST`（99），而官方哪天開放了，那份規則會安靜地把它當 99C。
   * 2026-08-17 就實測到一次：凱倫貝克 R5 在爬蟲快照裡還沒出，玩家的客戶端
   * 已經有配方了。
   *
   * ⚠ 判斷不了的時候是 `false`，不是 true —— 怪物那份沒有升級圖
   * （`hasUpgradeGraph` false），整份都會是 false。少了這個方向，
   * 138 張怪物卡會全部被藏起來。
   */
  locked: boolean;
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
  /**
   * 效果說明。**只有事件卡有**（裝備的說明是風味文，佔位子又不幫忙定價）。
   *
   * 為什麼事件卡非要它不可：110 張裡有五張都叫「Hp恢復」，名字完全一樣但
   * 一張回 1 點、一張回 3 點。編輯器要能讓人分辨自己在改哪一張。
   */
  info?: string;
  /**
   * 事件卡的插槽顏色，0~7。**只有事件卡有。**
   *
   * 一張事件卡只放得進角色卡上**同色**的事件插槽，`7` 例外 —— 那是萬用色，
   * 哪一格都放得進去。客戶端的判定原文（`unlight-common` 的 `Deck.canPut`）：
   *
   * ```js
   * if (eventData.type === EventCardType.ANY) return true;   // ANY 就是 7
   * return eventData.type === slotType;                      // 其餘要同色
   * ```
   *
   * 顏色是取遊戲自己的 `event_slot` 貼圖量出來的（2026-08-16）：
   *
   * | 值 | 顏色 | 那一族                    |
   * | -- | ---- | ------------------------- |
   * | 0  | 紅   | 劍                        |
   * | 1  | 綠   | 槍                        |
   * | 2  | 藍   | 防禦                      |
   * | 3  | 紫   | 移動                      |
   * | 4  | 黃   | 特殊                      |
   * | 5  | 白   | 機會                      |
   * | 6  | 黑   | 詛咒                      |
   * | 7  | 灰   | 萬用（哪一格都放得進去）  |
   *
   * ⚠ **不要照名字推顏色。**「劍3·盾3卡」是紅的，「劍5·槍5卡」卻是萬用 ——
   * 等級高低跟顏色沒有對應關係。
   */
  slotType?: number;
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
  characters: readonly {
    filename: string;
    chara: string;
    cost: number;
    /** 有配方做得出它。⚠ 只有 `hasUpgradeGraph.characters` 為 true 時才有意義。 */
    upgradeTarget?: boolean;
  }[];
  /** `mc_asset` 的卡。 */
  monsters: readonly { filename: string; cost: number; upgradeTarget?: boolean }[];
  /**
   * 那兩份資產裡有沒有升級圖。**沒有的話一張都不准判成「沒出」。**
   *
   * ⚠ `mc_asset` 的 `next` 全是 `ccoin`（換代幣），一個 `card` 目標都沒有 ——
   * 少了這個旗標，138 張怪物卡會全部被判成官方還沒出。省略等於 false。
   */
  hasUpgradeGraph?: { characters?: boolean; monsters?: boolean };
  /** `avatar_item.weapon`，索引就是 `wp` 鍵的來源。 */
  equipment: readonly { index: number; name: string; cost: number; chara: string | null }[];
  /** `event_info.frames`。`info` 是效果說明，`slotType` 是插槽顏色（見 {@link CatalogItem}）。 */
  eventCards: readonly {
    index: number;
    name: string;
    cost: number;
    info?: string;
    slotType?: number | null;
  }[];
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

/**
 * 這張卡是**掉落取得的基礎卡**嗎 —— 也就是 L1。
 *
 * ⚠ **「沒有配方指向它」的唯一合法例外。** L1 不是升級來的，所以它永遠不會
 * 是任何 `next` 的目標；少了這一條，每一位角色的 L1 都會被判成「官方還沒出」，
 * 而那是 70 張最基本的卡。
 *
 * 怪物（`mc`）不走這條 —— 它們沒有升級圖，整份都判斷不了（見 `locked`）。
 */
function isBaseCard(filename: string): boolean {
  return /^cc\d+_0*1$/.test(filename);
}

/**
 * 這張卡官方開放了沒。
 *
 * 判斷不了（那份資產沒有升級圖）時一律回 `false`＝「當作出了」。**方向不能
 * 反** —— 反了會把整份怪物卡藏光，而那看起來像插件壞了，不像設定問題。
 */
function lockedOf(
  filename: string,
  upgradeTarget: boolean | undefined,
  hasGraph: boolean,
): boolean {
  if (!hasGraph) return false;
  if (upgradeTarget === true) return false;
  return !isBaseCard(filename);
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
  const ccGraph = src.hasUpgradeGraph?.characters === true;
  const mcGraph = src.hasUpgradeGraph?.monsters === true;

  // ── 角色：一位一排，L1~L5 R1~R5 ──────────────────────────────────────
  const byChara = new Map<string, CatalogCard[]>();
  for (const c of src.characters) {
    const list = byChara.get(c.chara) ?? [];
    list.push({
      key: c.filename,
      slot: slotLabel(c.filename),
      baseCost: c.cost,
      locked: lockedOf(c.filename, c.upgradeTarget, ccGraph),
    });
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
    list.push({
      key: m.filename,
      slot: slotLabel(m.filename),
      baseCost: m.cost,
      // 實測 `mc_asset` 沒有升級圖，所以這裡實際上永遠是 false —— 但走同一支
      // 函式而不是寫死，官方哪天替怪物加上升級就會自己跟上。
      locked: lockedOf(m.filename, m.upgradeTarget, mcGraph),
    });
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
  // 讀不到的顯示欄位就不寫進去 —— 名冊會被寫成 JSON 存起來，`undefined` 的鍵
  // 會消失，而 `""` / `null` 會留下來假裝自己是答案。
  const eventItems: CatalogItem[] = src.eventCards.map((e) => ({
    key: eventCardKey(e.index),
    name: e.name,
    baseCost: e.cost,
    ...(e.info !== undefined && e.info !== "" ? { info: e.info } : {}),
    ...(typeof e.slotType === "number" ? { slotType: e.slotType } : {}),
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
