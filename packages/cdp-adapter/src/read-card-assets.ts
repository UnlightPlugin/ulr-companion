/**
 * 從跑著的客戶端讀回原版 COST 表
 * ================================
 * `patch-cost.ts` 是**寫**，這份是**讀**。兩邊看的是同樣那四份資料。
 *
 * 為什麼要從客戶端讀，而不是拿 crawler 的 CSV：
 *
 * 1. **鍵對得上。** cc_asset 的 `filename`（`cc078_04` / `cc078_r04`）是規則的
 *    正規鍵。CSV 是「角色名 + 等級」，而 L4 與 R4 的 level 都是 4，分不開。
 * 2. **版本一定是對的。** CSV 是某次爬取的快照，改版後不會自己更新；玩家自己
 *    跑著的客戶端永遠是他實際在玩的那一版。
 * 3. **charaIndex 一起拿到。** 封包給的 `charaIndex` 就是 `frames` 的陣列索引
 *    （客戶端 `Chara.getCharaAsset(charaIndex)` 直接拿它當索引），所以讀一次
 *    就同時得到「規則鍵」與「封包 → 規則鍵」的對照。
 *
 * ## 兩種形狀
 *
 * | 表           | 快取鍵        | 陣列      | 唯一鍵           | 用哪一組 |
 * | ------------ | ------------- | --------- | ---------------- | -------- |
 * | 角色         | `cc_asset`    | `.frames` | `filename`       | 具名     |
 * | 怪物         | `mc_asset`    | `.frames` | `filename`       | 具名     |
 * | 裝備（武器） | `avatar_item` | `.weapon` | **只有陣列索引** | 索引     |
 * | 事件卡       | `event_info`  | `.frames` | **只有陣列索引** | 索引     |
 *
 * 索引那一組**刻意只回傳索引，不回傳 `wp001` / `ev091`** —— 規則鍵的命名是
 * `@ulr/rule-schema` 的事（card-key.ts），這個 package 不該知道它。同一條界線
 * 在 `patch-cost` 上也守著。
 *
 * ⚠ **要在沒有套自訂 COST 的客戶端上讀。** 這裡讀的是 Phaser 快取裡的值，
 * 而 `patch-cost` 正是就地改寫那份資料 —— 對著已經套過的客戶端讀，讀回來的
 * 會是被改過的數字。這裡檢查不出這件事，呼叫端要自己確保。
 */

import {
  AVATAR_ITEM_KEY,
  AVATAR_ITEM_WEAPON_FIELD,
  CC_ASSET_KEY,
  EVENT_INFO_JSON_KEY,
  MC_ASSET_KEY,
} from "./constants.js";

// ---------------------------------------------------------------------------
// 具名的那兩張（角色、怪物）
// ---------------------------------------------------------------------------

/** `cc_asset` / `mc_asset` 的一筆卡。欄位名沿用遊戲自己的。 */
export interface CharacterAsset {
  /** `frames` 的陣列索引，等於封包裡的 `charaIndex` */
  charaIndex: number;
  /** 規則的正規鍵，例如 `cc078_04`（L4）、`cc078_r04`（R4）、`mc001_01`（怪物） */
  filename: string;
  /**
   * 角色代號，例如 `cc078`。同一角色的各等級共用。
   *
   * ⚠ 怪物的這欄**跟 `filename` 一樣**（實測 139 筆全部相等），不是像角色那樣
   * 的「去掉等級」形式。要分辨卡種請看前綴（`cc` / `mc`），不要看這兩欄相不相等。
   */
  chara: string;
  level: number;
  rarity: number;
  cost: number;
  hp: number;
  atk: number;
  def: number;
}

/** 一次讀取的結果。 */
export interface CharacterAssetTable {
  /** 真正有卡的那些，`charaIndex` 保持 `frames` 的原始索引。 */
  assets: CharacterAsset[];
  /** `frames` 的總長度，含保留空位。 */
  totalFrames: number;
  /**
   * 保留空位的數量。
   *
   * 2026-08-15 實測：`cc_asset` 781 格裡有 81 格是空的（690–769 連續 80 格，
   * 加上索引 780 一個全欄位歸零的哨兵），看起來是留給之後新增角色的位置。
   * 2026-08-16 實測：`mc_asset` 139 格裡有 1 格（索引 138）。
   * 這些不是壞資料，但也不能當成卡 —— 略過它們，並且把數字報出來讓人看得見。
   */
  placeholders: number;
}

/**
 * 讀一份「具名」卡表的表達式。
 *
 * 只挑需要的欄位帶回來 —— cc_asset 每張卡還有四個技能物件，整份搬回 Node
 * 會是好幾 MB，而且我們一個欄位都用不到（CONTRIBUTING §9.1「不搬大物件」）。
 */
export function cardAssetReadExpression(cacheKey: string): string {
  const key = JSON.stringify(cacheKey);
  return `(function () {
  try {
    var game = window.game;
    if (!game || !game.cache || !game.cache.json) {
      return JSON.stringify({ error: "window.game.cache.json 還沒建立，遊戲可能還在載入" });
    }
    var data = game.cache.json.get(${key});
    if (!data || !data.frames || typeof data.frames.length !== "number") {
      return JSON.stringify({ error: "Phaser 快取裡沒有 " + ${key} + "，或它沒有 frames 陣列" });
    }
    var rows = [];
    for (var i = 0; i < data.frames.length; i++) {
      var f = data.frames[i];
      if (!f) continue;
      rows.push({
        charaIndex: i,
        filename: f.filename,
        chara: f.chara,
        level: f.level,
        rarity: f.rarity,
        cost: f.cost,
        hp: f.hp,
        atk: f.atk,
        def: f.def
      });
    }
    return JSON.stringify({ rows: rows });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;
}

export const CC_ASSET_READ_EXPRESSION = cardAssetReadExpression(CC_ASSET_KEY);
export const MC_ASSET_READ_EXPRESSION = cardAssetReadExpression(MC_ASSET_KEY);

export class CcAssetReadError extends Error {
  override readonly name = "CcAssetReadError";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 解析頁面回傳的 JSON。
 *
 * 逐筆驗證而不是直接 cast：這份資料會變成規則檔的內容、進 contentHash，
 * 一個 `undefined` 混進去就會產生一份對不上任何客戶端的規則。
 */
export function parseCharacterAssets(raw: string): CharacterAssetTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcAssetReadError(`頁面回傳的不是 JSON：${raw.slice(0, 120)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new CcAssetReadError("頁面回傳的不是物件");
  }
  const { error, rows } = parsed as { error?: unknown; rows?: unknown };
  if (typeof error === "string") throw new CcAssetReadError(error);
  if (!Array.isArray(rows)) throw new CcAssetReadError("回傳的內容沒有 rows 陣列");

  const assets: CharacterAsset[] = [];
  const seen = new Set<string>();
  let placeholders = 0;

  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null) {
      placeholders++;
      continue;
    }
    const r = row as Record<string, unknown>;

    // 保留空位：沒有 filename 就當它不是卡。⚠ 只有這一種情況可以略過 ——
    // 有 filename 卻讀不到 cost 是真的壞了，那必須報錯，因為默默跳過會產生
    // 一份缺卡的規則，而缺的那張會被算成 UNKNOWN_COST 99。
    if (typeof r["filename"] !== "string" || r["filename"] === "") {
      placeholders++;
      continue;
    }
    const filename = r["filename"];

    // filename 是規則的鍵，撞號會讓後寫的那筆默默蓋掉前一筆。
    if (seen.has(filename)) {
      throw new CcAssetReadError(`filename「${filename}」重複，它不能當唯一鍵`);
    }
    seen.add(filename);

    if (!isFiniteNumber(r["cost"])) {
      throw new CcAssetReadError(`「${filename}」的 cost 不是有限數字：${String(r["cost"])}`);
    }

    assets.push({
      charaIndex: isFiniteNumber(r["charaIndex"]) ? r["charaIndex"] : -1,
      filename,
      chara: typeof r["chara"] === "string" ? r["chara"] : "",
      level: isFiniteNumber(r["level"]) ? r["level"] : 0,
      rarity: isFiniteNumber(r["rarity"]) ? r["rarity"] : 0,
      cost: r["cost"],
      hp: isFiniteNumber(r["hp"]) ? r["hp"] : 0,
      atk: isFiniteNumber(r["atk"]) ? r["atk"] : 0,
      def: isFiniteNumber(r["def"]) ? r["def"] : 0,
    });
  }

  if (assets.length === 0) throw new CcAssetReadError("一張卡都沒有");
  return { assets, totalFrames: rows.length, placeholders };
}

/**
 * 攤成規則檔的表：`{ "cc001_01": 8, … }`。角色與怪物都走這支。
 *
 * 鍵照字典序排 —— 這樣同一個客戶端讀兩次得到位元相同的檔案，diff 才有意義。
 * （contentHash 走的是 JCS，本來就會重排鍵，這裡排是為了給人看的那份好讀。）
 */
export function toCostTable(assets: readonly CharacterAsset[]): Record<string, number> {
  const table: Record<string, number> = {};
  for (const a of [...assets].sort((x, y) => (x.filename < y.filename ? -1 : 1))) {
    table[a.filename] = a.cost;
  }
  return table;
}

// ---------------------------------------------------------------------------
// 索引的那兩張（裝備、事件卡）
// ---------------------------------------------------------------------------

/**
 * 一張只有索引可以認的卡（裝備或事件卡）。
 *
 * ⚠ **`index` 就是規則鍵的來源，但這裡不幫忙轉。** 轉成 `wp001` / `ev091`
 * 是 `@ulr/rule-schema` 的 `equipmentKey()` / `eventCardKey()` 的事。
 */
export interface IndexedCardAsset {
  /** 陣列索引。客戶端自己也是拿它查的。 */
  index: number;
  cost: number;
  /** 顯示名稱（`name_tcn`，沒有就退回 `name_ja`）。**只拿來給人看**，不當鍵。 */
  name: string;
  /**
   * 角色限制 —— 這件裝備是誰的專武（`cc001`）。沒有限制是 `null`。
   *
   * 2026-08-16 實測：238 件裡有 212 件綁角色。要顯示成人看得懂的名字得再查
   * `charaProfile`（見 {@link parseProfiles}）。
   *
   * ⚠ 只有武器有這一欄，事件卡沒有。
   */
  chara: string | null;
}

export interface IndexedCardTable {
  cards: IndexedCardAsset[];
  /** 陣列總長度。跟 `cards.length` 不同就代表有讀不出來的洞。 */
  total: number;
}

/**
 * 讀一份「只有索引」的卡表。
 *
 * `field` 是資料裡的陣列欄位：`avatar_item` 是 `weapon`、`event_info` 是
 * `frames`。⚠ `avatar_item` 是一份大雜燴（avatar / quest / battle / …），
 * 只讀 `weapon` 那一段。
 */
export function indexedCardReadExpression(cacheKey: string, field: string): string {
  const key = JSON.stringify(cacheKey);
  const arr = JSON.stringify(field);
  return `(function () {
  try {
    var game = window.game;
    if (!game || !game.cache || !game.cache.json) {
      return JSON.stringify({ error: "window.game.cache.json 還沒建立，遊戲可能還在載入" });
    }
    var data = game.cache.json.get(${key});
    var rows = data ? data[${arr}] : null;
    if (!rows || typeof rows.length !== "number") {
      return JSON.stringify({ error: "Phaser 快取裡沒有 " + ${key} + "，或它沒有 " + ${arr} + " 陣列" });
    }
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      out.push({
        index: i,
        cost: r.cost,
        name: typeof r.name_tcn === "string" && r.name_tcn !== "" ? r.name_tcn : r.name_ja,
        chara: typeof r.chara === "string" && r.chara !== "" ? r.chara : null
      });
    }
    return JSON.stringify({ rows: out, total: rows.length });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;
}

export const WEAPON_READ_EXPRESSION = indexedCardReadExpression(
  AVATAR_ITEM_KEY,
  AVATAR_ITEM_WEAPON_FIELD,
);
export const EVENT_CARD_READ_EXPRESSION = indexedCardReadExpression(EVENT_INFO_JSON_KEY, "frames");

/**
 * 解析索引型卡表。
 *
 * ⚠ **沒有「保留空位」這個概念。** 具名的表可以用「沒有 filename」判斷一格
 * 是不是空的，索引型的表沒有那個訊號 —— 少一筆就是索引整個往前偏，而偏掉的
 * 規則會安靜地把每張卡的價格都貼到隔壁那張上。所以這裡**讀不到 cost 一律報錯**。
 */
export function parseIndexedCards(raw: string): IndexedCardTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcAssetReadError(`頁面回傳的不是 JSON：${raw.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CcAssetReadError("頁面回傳的不是物件");
  }
  const { error, rows, total } = parsed as { error?: unknown; rows?: unknown; total?: unknown };
  if (typeof error === "string") throw new CcAssetReadError(error);
  if (!Array.isArray(rows)) throw new CcAssetReadError("回傳的內容沒有 rows 陣列");

  const cards: IndexedCardAsset[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new CcAssetReadError("有一筆不是物件 —— 索引型的表不能有洞");
    }
    const r = row as Record<string, unknown>;
    if (!isFiniteNumber(r["index"])) {
      throw new CcAssetReadError(`index 不是有限數字：${String(r["index"])}`);
    }
    if (!isFiniteNumber(r["cost"])) {
      throw new CcAssetReadError(`索引 ${r["index"]} 的 cost 不是有限數字：${String(r["cost"])}`);
    }
    cards.push({
      index: r["index"],
      cost: r["cost"],
      name: typeof r["name"] === "string" ? r["name"] : "",
      chara: typeof r["chara"] === "string" && r["chara"] !== "" ? r["chara"] : null,
    });
  }

  if (cards.length === 0) throw new CcAssetReadError("一張卡都沒有");
  return { cards, total: isFiniteNumber(total) ? total : cards.length };
}

// ---------------------------------------------------------------------------
// 名字
// ---------------------------------------------------------------------------

/**
 * 角色與怪物的顯示名稱。
 *
 * **這是「不要讓玩家看到編號」的關鍵。** `cc001_01` 對玩家毫無意義，
 * 但 `charaProfile["cc001"].name_tcn` 是「艾伯李斯特」。
 *
 * ⚠ 兩張表的鍵**不同層級**（2026-08-16 實測）：
 *
 * | 表             | 鍵                    | 例          |
 * | -------------- | --------------------- | ----------- |
 * | `charaProfile` | 角色代號（不含等級）  | `cc001`     |
 * | `monsProfile`  | **整個 filename**     | `mc001_01`  |
 *
 * 這跟兩份資產的 `chara` 欄位是一致的（怪物的 `chara` 就等於 `filename`）。
 * 混用會查不到而讓整排卡變成沒有名字。
 */
export interface CardProfiles {
  /** `cc001` → `艾伯李斯特`。70 位（2026-08-16）。 */
  characters: Record<string, string>;
  /** `mc001_01` → `森林侏儒`。193 筆，含玩家用不到的首領。 */
  monsters: Record<string, string>;
}

/**
 * 讀名字。**只帶名字回來** —— profile 裡還有各語言的長篇介紹與技能說明，
 * 整份搬回 Node 是好幾百 KB，而我們只要一個欄位。
 */
export const PROFILE_READ_EXPRESSION = `(function () {
  try {
    var game = window.game;
    if (!game || !game.cache || !game.cache.json) {
      return JSON.stringify({ error: "window.game.cache.json 還沒建立，遊戲可能還在載入" });
    }
    function names(key) {
      var src = game.cache.json.get(key);
      var out = {};
      if (!src || typeof src !== "object") return out;
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        var p = src[k];
        if (!p) continue;
        var n = typeof p.name_tcn === "string" && p.name_tcn !== "" ? p.name_tcn : p.name_ja;
        if (typeof n === "string" && n !== "") out[k] = n;
      }
      return out;
    }
    return JSON.stringify({ characters: names("charaProfile"), monsters: names("monsProfile") });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;

export function parseProfiles(raw: string): CardProfiles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcAssetReadError(`頁面回傳的不是 JSON：${raw.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CcAssetReadError("頁面回傳的不是物件");
  }
  const { error, characters, monsters } = parsed as {
    error?: unknown;
    characters?: unknown;
    monsters?: unknown;
  };
  if (typeof error === "string") throw new CcAssetReadError(error);

  const table = (value: unknown, what: string): Record<string, string> => {
    if (typeof value !== "object" || value === null) {
      throw new CcAssetReadError(`${what}的名字表不是物件`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    // ⚠ 空表要吵。名字讀不到時 UI 會整排顯示編號，那正是這個功能要消滅的東西。
    if (Object.keys(out).length === 0) throw new CcAssetReadError(`${what}一個名字都讀不到`);
    return out;
  };

  return { characters: table(characters, "角色"), monsters: table(monsters, "怪物") };
}
