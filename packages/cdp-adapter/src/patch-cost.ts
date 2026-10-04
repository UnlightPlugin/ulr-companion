/**
 * 改寫遊戲內顯示的 COST
 * =======================
 * 移植自 5i 的 `unlight_crawler/src/script/cdp/patch_cost.js`，機制相同：
 *
 *     hook Phaser.Loader.FileTypes.JSONFile.prototype.onProcess
 *       → 攔到我們認得的 key
 *         → 就地改寫那份資料裡每一張卡的 cost
 *
 * 為什麼是攔載入而不是改畫面：這幾份 JSON 是牌組畫面、角色資訊、隊伍總和、
 * 對戰畫面全部共用的那一份。改在它進 Phaser 快取之前，所有用到 COST 的地方
 * 一次到位，不用去追每個 UI 元件。
 *
 * ## 四張表，一個 hook
 *
 * 一副牌組是四張表組合出來的，而四張都是 `Initialize.preload()` 用
 * `this.load.json()` 載入的 —— 同一個 `JSONFile` 類別、同一個階段
 * （見 `constants.ts` 的 `COST_ASSET_LOAD_NOTE`）。所以 hook 只要一個，
 * 差別只在資料在哪個陣列、以及**這一筆的鍵怎麼算**：
 *
 * | 表   | 快取鍵        | 陣列       | 鍵                       |
 * | ---- | ------------- | ---------- | ------------------------ |
 * | 角色 | `CharaCards`  | 本身       | `filename`（`cc078_04`） |
 * | 怪物 | `CharaCards`  | 本身       | `filename`（`mc001_01`） |
 * | 裝備 | `WeaponCards` | 本身       | **`id`**                 |
 * | 事件 | `EventCards`  | 本身       | **`id`**                 |
 *
 * ⚠ 2026-09-23 改版前是 `cc_asset`／`mc_asset`／`avatar_item.weapon`／
 * `event_info.frames`，裝備與事件卡用陣列索引。改版後那四份資料不存在了，
 * 角色與怪物併成同一份 `CharaCards`（所以一個快取鍵可能對到兩張表），
 * 裝備與事件卡改用卡片 id —— 而且**順序重排過**，規則鍵 `wp001` 要經過
 * `@ulr/rule-schema` 的 `toCardIdTable()` 才對得到 id。
 *
 * ⚠ **必須用 `Page.addScriptToEvaluateOnNewDocument` 注入。**
 * `Runtime.evaluate` 太晚 —— 那時四份資料早就載完，hook 掛上去也不會再被呼叫。
 *
 * 四條在這裡特別要守的規則：
 *
 * 1. **失敗要降級**（CONTRIBUTING §9.1）。注入的程式碼裡每一段都包 try/catch，
 *    而且 hook 是「先讓遊戲跑完原本的 onProcess，再做我們的事」——
 *    我們炸掉時遊戲的狀態仍然是完整的。
 * 2. **不得把遠端資料變成可執行邏輯**（§12）。腳本本體是這個檔案裡的常數，
 *    規則內容只以 `JSON.parse` 的**資料**進去，永遠不會被當程式碼執行。
 * 3. **不搬大物件回 Node**。回報只帶統計與 filename 索引，不帶整份資料。
 * 4. **不改伺服器判定**（§12 硬規則 4）。這只改本機顯示。
 */

import { CHARA_CARDS_KEY, EVENT_CARDS_KEY, WEAPON_CARDS_KEY } from "./constants.js";
import { embedJson } from "./embed.js";

/**
 * 一張表的 COST 對照表。
 *
 * 鍵是什麼**因表而異**，見上面那張表：角色與怪物用資產自己的 `filename`，
 * 裝備與事件卡用**卡片 id 的十進位字串**（`"6"`、`"40"`）。
 *
 * ⚠ 這裡刻意**不認得** `wp001` / `ev091` 那套規則鍵 —— 規則鍵到客戶端鍵的
 * 轉換一律由呼叫端做完（`@ulr/rule-schema` 的 `toIndexTable()`）。同一條界線
 * 在角色表上已經守了：`patch-cost` 不做「規則鍵 → filename」的轉換。
 * 這樣命名規則改變時，要動的只有一個 package。
 */
export type CostOverrides = Readonly<Record<string, number>>;

/**
 * 四張表各一份。**全部選填** —— 只想改角色價格的規則是最常見的形態。
 *
 * ⚠ 沒給的表**不是改成 0，是完全不碰**。遊戲會照原版的數字跑。
 */
export interface CostOverrideTables {
  /** 鍵是 `CharaCards` 的 `filename`，例如 `cc078_04` */
  characters?: CostOverrides | undefined;
  /** 鍵是 `CharaCards` 的 `filename`，例如 `mc001_01` */
  monsters?: CostOverrides | undefined;
  /** 鍵是 `WeaponCards` 的 **id 字串**，例如 `"6"`（舊規則鍵 `wp001`） */
  equipment?: CostOverrides | undefined;
  /** 鍵是 `EventCards` 的 **id 字串**，例如 `"40"`（舊規則鍵 `ev091`） */
  eventCards?: CostOverrides | undefined;
}

/** 四張表的識別代號。回報與統計都用它。 */
export type CostTableId = "characters" | "monsters" | "equipment" | "eventCards";

export const COST_TABLE_IDS: readonly CostTableId[] = [
  "characters",
  "monsters",
  "equipment",
  "eventCards",
];

/**
 * 每張表對應到客戶端的哪份資料、鍵怎麼算。
 *
 * `field`：陣列在資料的哪個欄位；`null` = 資料本身就是陣列（改版後四張都是）。
 *
 * `keyMode`：
 *   - `filename` —— 用那一筆自己的 `filename` 欄位當鍵
 *   - `id`       —— 用那一筆自己的 `id` 當鍵
 *   - `index`    —— 用陣列索引的十進位字串當鍵（改版前的裝備／事件卡，留著給覆寫用）
 */
/**
 * 補丁裝在頁面上的旗標名。
 *
 * ⚠ 注入腳本與「補丁蓋到了沒」那支查詢**共用這一個常數**。分成兩份字面值的
 * 話，改名時只會改到其中一邊，而症狀是查詢永遠回「沒蓋到」→ 每次接上都重載。
 */
export const COST_PATCH_FLAG = "__ulrCostPatch";

export type CostKeyMode = "filename" | "id" | "index";

export const COST_TABLE_TARGETS: Readonly<
  Record<CostTableId, { assetKey: string; field: string | null; keyMode: CostKeyMode }>
> = {
  characters: { assetKey: CHARA_CARDS_KEY, field: null, keyMode: "filename" },
  monsters: { assetKey: CHARA_CARDS_KEY, field: null, keyMode: "filename" },
  equipment: { assetKey: WEAPON_CARDS_KEY, field: null, keyMode: "id" },
  eventCards: { assetKey: EVENT_CARDS_KEY, field: null, keyMode: "id" },
};

/**
 * 牌組編輯畫面**自己另外留一份**的資料（快取鍵 → 場景屬性名）。不重載切換
 * 價格時那一份也要換。
 *
 * 2026-09-23 改版前 Edit 在 `create()` 時 `structuredClone` 了四份
 * （`ccInfo`／`mcInfo`／`itemInfo`／`eventInfo`）；改版後每次都直接讀
 * `cache.json.get(…)`，沒有副本了 —— 所以是空的。留著這個接點，遊戲哪天
 * 又開始複製時只要在這裡加一行。
 */
export const EDIT_SCENE_CLONES: Readonly<Record<string, string>> = {};

export interface CostPatchOptions {
  /**
   * 要套的表。
   *
   * 也接受**只有角色的舊寫法**（一個扁平的 `Record<string, number>`），
   * 那等同 `{ characters: … }` —— 這是為了讓「只改角色」的既有呼叫端與規則檔
   * 不必跟著改。
   */
  costs: CostOverrides | CostOverrideTables;
  /** 頁面呼叫這個名字把結果送回 Node。由 `Runtime.addBinding` 建立。 */
  bindingName: string;
  /**
   * 覆寫某一張表的快取鍵。留參數是為了遊戲改版換鍵時不用改程式。
   *
   * ⚠ 舊簽章是「`assetKey` = 角色表的鍵」，那個寫法仍然可以用。
   */
  assetKey?: string;
  assetKeys?: Partial<Record<CostTableId, string>>;
  /** 等 Phaser 出現的輪詢間隔。 */
  pollIntervalMs?: number;
  /** 等不到就放棄並回報。無上限的輪詢會在頂層 frame 永遠空轉。 */
  maxWaitMs?: number;
  /**
   * 一開始要不要**套上**自訂價格。預設 `true`。
   *
   * `false` 時掛鉤照樣攔、照樣記下原價與對照，只是不把數字換掉 ——
   * 之後 {@link buildCostPatchEnabledExpression} 隨時切得回來。這是「牌組
   * 畫面上那個開關」的基礎：切換不重載。
   */
  enabled?: boolean;
}

export const DEFAULT_POLL_INTERVAL_MS = 50;
export const DEFAULT_MAX_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

/** hook 掛上去了，但還沒攔到任何一張表。 */
export interface CostPatchInstalled {
  type: "cost-patch-installed";
}

export interface CostPatchApplied {
  type: "cost-patch";
  /** 這一則是哪張表的。四張表各發一則 —— 它們的載入完成時間不同。 */
  table: CostTableId;
  assetKey: string;
  /** 這份資料裡的卡片總數 */
  totalFrames: number;
  /** 實際被改到的張數 */
  applied: number;
  /**
   * 規則裡有、但這個客戶端版本沒有的鍵。
   *
   * 不能當成 0 忽略 —— 那會讓超標的隊伍看起來合法。這是「遊戲改版了，
   * 規則要跟上」的訊號，UI 要顯示出來。
   *
   * ⚠ 裝備與事件卡的鍵在這裡是**索引字串**（`"238"`），不是 `wp238`。
   * 要顯示給玩家看的話由呼叫端轉回規則鍵。
   */
  unknownKeys: string[];
  /**
   * `charaIndex`（陣列索引）→ `filename`。**只有 filename 型的表會有**，
   * 裝備與事件卡是 `null`（它們的鍵本來就是索引，不需要對照）。
   *
   * 封包裡的 `charaIndex` 就是這個索引。有了它就能把封包直接對到規則的鍵，
   * 而且這份索引是從**玩家自己的客戶端**讀出來的，永遠跟他跑的版本一致 ——
   * 不需要在插件裡塞一份會過期的對照表。
   */
  index: string[] | null;
}

export interface CostPatchError {
  type: "cost-patch-error";
  /** 哪張表出的事。還沒走到分表就出事的話是 `null`。 */
  table: CostTableId | null;
  reason: string;
}

export type CostPatchReport = CostPatchInstalled | CostPatchApplied | CostPatchError;

const REPORT_TYPES = new Set(["cost-patch-installed", "cost-patch", "cost-patch-error"]);

/** 判斷一則 binding 回報是不是這個模組發的。頁面上可能有別人的 binding。 */
export function isCostPatchReport(value: unknown): value is CostPatchReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

// ---------------------------------------------------------------------------
// 產生注入腳本
// ---------------------------------------------------------------------------

export class InvalidCostOverrideError extends Error {
  override readonly name = "InvalidCostOverrideError";
  constructor(key: string, reason: string) {
    super(`COST 對照表的「${key}」不合法：${reason}`);
  }
}

function assertValidCosts(table: CostTableId, costs: CostOverrides): void {
  for (const [key, value] of Object.entries(costs)) {
    if (key.length === 0) {
      throw new InvalidCostOverrideError(`${table}/(空字串)`, "鍵不能是空字串");
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // NaN / Infinity 經過 JSON 會變成 null，寫進 cost 之後畫面會顯示空白或
      // NaN，而且看起來像是遊戲壞了。擋在這裡比較好查。
      throw new InvalidCostOverrideError(
        `${table}/${key}`,
        `值必須是有限數字，收到 ${String(value)}`,
      );
    }
  }
}

/**
 * 把兩種寫法都正規化成四張表。
 *
 * 扁平的 `Record<string, number>` 一律視為角色表 —— 那是這支唯一支援過的
 * 形狀，換句話說既有的呼叫端與既有的規則檔語意完全不變。
 */
export function normalizeCostTables(
  costs: CostOverrides | CostOverrideTables,
): Required<Record<CostTableId, CostOverrides>> {
  const looksTabled =
    typeof costs === "object" &&
    costs !== null &&
    COST_TABLE_IDS.some((id) => {
      const v = (costs as Record<string, unknown>)[id];
      return typeof v === "object" && v !== null;
    });

  const tables = looksTabled
    ? (costs as CostOverrideTables)
    : { characters: costs as CostOverrides };
  return {
    characters: tables.characters ?? {},
    monsters: tables.monsters ?? {},
    equipment: tables.equipment ?? {},
    eventCards: tables.eventCards ?? {},
  };
}

/**
 * 產生要注入的 JS。純函式，沒有副作用 —— 所以可以完整測試，不需要活著的遊戲。
 */
export function buildCostPatchScript(options: CostPatchOptions): string {
  const tables = normalizeCostTables(options.costs);
  for (const id of COST_TABLE_IDS) assertValidCosts(id, tables[id]);

  /**
   * 注入腳本要的形狀：快取鍵 → **這份資料要套哪幾張表**。
   *
   * ⚠ 用快取鍵當索引而不是表名，是因為 hook 裡拿得到的只有 `this.key`。
   * 沒有要改的表就不放進來 —— 那樣 hook 對它連查都不會查。
   *
   * ⚠ 值是**陣列**：改版後角色與怪物是同一份 `CharaCards`，一個鍵對兩張表。
   * 寫成一對一的話後放進來的那張會蓋掉前一張，症狀是「怪物價格有、角色沒有」。
   */
  const targets: Record<
    string,
    { table: CostTableId; field: string | null; keyMode: CostKeyMode; costs: CostOverrides }[]
  > = {};
  for (const id of COST_TABLE_IDS) {
    const costs = tables[id];
    if (Object.keys(costs).length === 0) continue;
    const target = COST_TABLE_TARGETS[id];
    const assetKey =
      options.assetKeys?.[id] ??
      (id === "characters" ? options.assetKey : undefined) ??
      target.assetKey;
    (targets[assetKey] ??= []).push({
      table: id,
      field: target.field,
      keyMode: target.keyMode,
      costs,
    });
  }

  const config = {
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    targets,
    // 這一份規則的指紋。⚠ 它留在頁面上是為了讓「來得及嗎」那支問得出
    // **是哪一份**規則蓋上去的，見 `costsStamp()`。
    stamp: costsStamp(options.costs),
    enabled: options.enabled ?? true,
    editClones: EDIT_SCENE_CLONES,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = "${COST_PATCH_FLAG}";
  var has = Object.prototype.hasOwnProperty;

  /*
   * 2026-09-24 改寫：**當場套到快取，換規則不必重載。**
   *
   * 改版後的客戶端每次都是「當下」去 cache.json.get(CharaCards / WeaponCards /
   * EventCards) 讀價格（Edit 的 get_*_cost、card_sort、戰鬥），不再複製一份。
   * 所以已經在快取裡的資料直接改就生效。以前只能靠「載入那一刻」的掛鉤，
   * 插件晚接上就得重載遊戲 —— 而改版後遊戲在 out-of-process iframe 裡，
   * 重載會換一個 target，「新文件開始前先埋腳本」根本埋不進去。
   *
   * 所以：
   *   · 掛鉤全頁只裝一次，攔到資料時讀的是 window[FLAG].cfg（**當前**的規則）
   *   · 每次跑這支（新文件、或插件接上時 evaluate）都把 cfg 換成這一份，
   *     並把已經在快取裡的表當場套一次
   *   · originals 記的是**官方原價**，第一次碰到那張卡時記下、之後不再覆寫；
   *     換規則時舊規則動過、新規則沒動的卡要還原成它
   */
  var st = window[FLAG];
  if (!st || typeof st.apply !== "function") {
    st = window[FLAG] = {
      installed: false,
      applied: 0,
      stamp: null,
      enabled: true,
      // 每張表「鍵 → 官方原價」。切回原價、換規則還原都靠它。
      originals: {},
      // 每張表「鍵 → 自訂價」，就是規則本身。牌組選單（patch-deck-edit）要
      // **同時**畫官方與自訂兩個總和，而快取裡任一時刻只躺著其中一種價。
      customs: {},
      cfg: null,
      apply: null,
      setEnabled: null
    };
  }
  st.cfg = CFG;
  st.stamp = CFG.stamp;
  st.enabled = !!CFG.enabled;
  st.customs = {};
  st.applied = 0;
  for (var tk in CFG.targets) {
    if (!has.call(CFG.targets, tk)) continue;
    for (var ti = 0; ti < CFG.targets[tk].length; ti++) {
      st.customs[CFG.targets[tk][ti].table] = CFG.targets[tk][ti].costs;
    }
  }

  function report(payload) {
    try {
      var fn = window[st.cfg.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲。
    }
  }

  /** 這一筆的鍵：filename 型用它的 filename、id 型用它的 id、索引型用位置。 */
  function rowKey(spec, row, i) {
    if (spec.keyMode === "index") return String(i);
    if (spec.keyMode === "id") return row && typeof row.id === "number" ? String(row.id) : "";
    return row && typeof row.filename === "string" ? row.filename : "";
  }

  /** 陣列在哪：field 是 null 就是資料本身（改版後四張都是）。 */
  function rowsOf(spec, data) {
    if (!data) return null;
    return spec.field === null ? data : data[spec.field];
  }

  /**
   * 把一份資料照「現在的規則」擺好價格。
   *
   * 每一筆：官方價 = originals 裡記的（沒記過就是它現在的價，順手記下）。
   * 規則有它 → 開著套自訂、關著放官方；規則沒它但以前動過 → 放回官方。
   * 所以同一份資料跑幾次都一樣，換規則也不會留下上一份的數字。
   */
  function patchCostData(assetKey, spec, data, quiet) {
    var rows = rowsOf(spec, data);
    if (!rows || typeof rows.length !== "number") {
      report({
        type: "cost-patch-error",
        table: spec.table,
        reason: assetKey + " 不是預期的陣列（" + (spec.field === null ? "本身" : spec.field) + "）"
      });
      return;
    }

    var costs = spec.costs;
    var byFilename = spec.keyMode === "filename";
    var index = byFilename ? [] : null;
    var seen = Object.create(null);
    var originals = st.originals[spec.table] || (st.originals[spec.table] = Object.create(null));
    var enabled = st.enabled;
    var applied = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = rowKey(spec, row, i);
      if (byFilename) index.push(name);
      if (name === "" || !row) continue;
      seen[name] = true;
      var inRule = has.call(costs, name);
      if (!inRule && !has.call(originals, name)) continue;
      // ⚠ 原價一定要先記，不管現在套不套 —— 這是之後切回官方價唯一的依據。
      if (!has.call(originals, name)) originals[name] = row.cost;
      if (inRule) {
        row.cost = enabled ? costs[name] : originals[name];
        applied++;
      } else {
        row.cost = originals[name];
      }
    }

    var unknown = [];
    for (var key in costs) {
      if (has.call(costs, key) && !seen[key]) unknown.push(key);
    }

    st.applied += applied;
    st[spec.table] = applied;
    if (quiet) return;
    report({
      type: "cost-patch",
      table: spec.table,
      assetKey: assetKey,
      totalFrames: rows.length,
      applied: applied,
      unknownKeys: unknown,
      index: index
    });
  }

  /** 快取裡已經有的表，照現在的規則擺一次。回套了幾張表。 */
  function applyToCache() {
    var g = window.game;
    var cache = g && g.cache && g.cache.json;
    if (!cache || typeof cache.has !== "function") return 0;
    var n = 0;
    var T = st.cfg.targets;
    for (var key in T) {
      if (!has.call(T, key) || !cache.has(key)) continue;
      for (var i = 0; i < T[key].length; i++) {
        try { patchCostData(key, T[key][i], cache.get(key), false); n++; } catch (e) {}
      }
    }
    return n;
  }

  /**
   * 換規則時，上一份規則動過、這一份**整張表都沒有**的，要還原成官方價
   * （patchCostData 只會跑到這一份有的表）。
   */
  function restoreDroppedTables(prevTargets) {
    var g = window.game;
    var cache = g && g.cache && g.cache.json;
    if (!cache || !prevTargets) return;
    for (var key in prevTargets) {
      if (!has.call(prevTargets, key) || !cache.has(key)) continue;
      for (var i = 0; i < prevTargets[key].length; i++) {
        var spec = prevTargets[key][i];
        var still = st.cfg.targets[key] && st.cfg.targets[key].some(function (s) { return s.table === spec.table; });
        if (still) continue;
        var originals = st.originals[spec.table];
        if (!originals) continue;
        var rows = rowsOf(spec, cache.get(key));
        if (!rows) continue;
        for (var r = 0; r < rows.length; r++) {
          var nm = rowKey(spec, rows[r], r);
          if (nm !== "" && rows[r] && has.call(originals, nm)) rows[r].cost = originals[nm];
        }
        delete st[spec.table];
      }
    }
  }

  /** 把一組 rows 裡規則有動到的那幾筆換成自訂價或原價。回換了幾筆。 */
  function swapRows(spec, rows, originals, enabled) {
    if (!rows || typeof rows.length !== "number") return 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var name = rowKey(spec, row, i);
      if (name === "" || !has.call(spec.costs, name) || !has.call(originals, name)) continue;
      row.cost = enabled ? spec.costs[name] : originals[name];
      n++;
    }
    return n;
  }

  /**
   * 不重載，把畫面上的價格在「自訂」與「原價」之間切換。
   *
   * 換的是 Phaser 快取那份（改版後大家都當下讀它），外加 editClones 列的
   * 場景副本（改版後是空的，見 EDIT_SCENE_CLONES）。Edit 開著就重畫。
   */
  function setEnabled(enabled) {
    st.enabled = !!enabled;
    var swapped = 0;
    var g = window.game;
    var cache = g && g.cache && g.cache.json;
    var edit = g && g.scene && g.scene.keys && g.scene.keys.Edit;
    var T = st.cfg.targets;
    for (var key in T) {
      if (!has.call(T, key)) continue;
      for (var si = 0; si < T[key].length; si++) {
        var spec = T[key][si];
        var originals = st.originals[spec.table];
        if (!originals) continue;
        try {
          var data = cache && cache.has(key) ? cache.get(key) : null;
          swapped += swapRows(spec, rowsOf(spec, data), originals, st.enabled);
        } catch (e) {}
        try {
          var prop = st.cfg.editClones[key];
          var clone = edit && prop ? edit[prop] : null;
          // ⚠ 只在它真的是另一份時才動；同一個物件就是上面已經換過的那份。
          if (clone && (!cache || !cache.has(key) || clone !== cache.get(key))) {
            swapRows(spec, rowsOf(spec, clone), originals, st.enabled);
          }
        } catch (e) {}
      }
    }
    var redrawn = false;
    try {
      if (edit && edit.scene.isActive()) redrawn = redrawEdit(edit);
    } catch (e) {}
    return { enabled: st.enabled, swapped: swapped, redrawn: redrawn };
  }

  /**
   * 重畫牌組編輯畫面。回有沒有重畫。
   *
   * 2026-09-23 改版後（2026-09-24 讀的）：refresh() 會先 card_sort()（照快取裡
   * 的 cost 重排，「排列：成本」自動跟上）再重建格線；show_cost() 重算下面那排
   * 每張卡的 COST、總和與懲罰（都直接讀 cache.json）。兩個都叫就對了。
   */
  function redrawEdit(sc) {
    if (typeof sc.refresh !== "function") return false;
    sc.refresh();
    if (typeof sc.show_cost === "function") sc.show_cost();
    try { refreshPreviewCost(sc); } catch (e) {}
    return true;
  }

  /**
   * 右邊那張大卡的 COST 格。refresh()／show_cost() 都不碰它（2026-09-25 讀的）——
   * 那塊是點卡時模組私有的 show_info() 畫進 sc.profile_texts 的，叫不到，
   * 不補的話切完開關左邊已經是新價、右邊還停在舊價。
   *
   *   角色  底圖 chara_info  profile_texts[9] 在 (729,462)  id = card_preview.front.card_id
   *   武器  底圖 event_info  profile_texts[2] 在 (697,386)  id 在圖的 frame 名 weapon_<id>
   *   事件  底圖 event_info  profile_texts[2] 在 (697,386)  id 在圖的 frame 名 event_<id>
   *
   * ⚠ 座標也要對得上才改 —— 認錯格子會把 COST 寫進別的欄位，比沒更新更糟。
   */
  function refreshPreviewCost(sc) {
    var front = sc.card_preview && sc.card_preview.front;
    var texts = sc.profile_texts;
    var cache = sc.cache && sc.cache.json;
    if (!front || !texts || !cache) return;
    var key = null, id = null, slot = -1, x = 0, y = 0;
    var frame = front.image && front.image.frame ? String(front.image.frame.name) : "";
    var m = /^(weapon|event)_(\\d+)$/.exec(frame);
    if (m) {
      key = m[1] === "weapon" ? "WeaponCards" : "EventCards";
      id = Number(m[2]); slot = 2; x = 697; y = 386;
    } else if (typeof front.card_id === "number") {
      key = "CharaCards"; id = front.card_id; slot = 9; x = 729; y = 462;
    }
    var t = slot >= 0 ? texts[slot] : null;
    if (!t || typeof t.setText !== "function" || Math.round(t.x) !== x || Math.round(t.y) !== y) return;
    var rows = cache.has(key) ? cache.get(key) : null;
    if (!rows || typeof rows.find !== "function") return;
    var row = rows.find(function (r) { return r && r.id === id; });
    if (row && typeof row.cost === "number") t.setText(String(row.cost));
  }

  function install(proto) {
    if (proto.__ulrCostHook) return;
    var original = proto.onProcess;
    proto.onProcess = function () {
      // 先跑遊戲原本的，再做我們的。順序不能顛倒 —— 我們拋例外時，
      // 遊戲該做的事已經做完了。
      original.apply(this, arguments);
      try {
        var cur = window[FLAG];
        var T = cur && cur.cfg ? cur.cfg.targets : null;
        var specs = T && has.call(T, this.key) ? T[this.key] : null;
        if (specs !== null) {
          for (var i = 0; i < specs.length; i++) cur.patch(this.key, specs[i], this.data, false);
        }
      } catch (e) {
        report({ type: "cost-patch-error", table: null, reason: String((e && e.message) || e) });
      }
    };
    proto.__ulrCostHook = true;
  }

  var prevTargets = st.prevTargets || null;
  st.prevTargets = CFG.targets;
  st.patch = patchCostData;
  st.apply = applyToCache;
  st.setEnabled = setEnabled;

  function ready(proto) {
    try {
      install(proto);
      st.installed = true;
      report({ type: "cost-patch-installed" });
      restoreDroppedTables(prevTargets);
      applyToCache();
      // 規則換了、Edit 正開著 → 畫面上的數字與排列要跟著變。
      var g = window.game;
      var edit = g && g.scene && g.scene.keys && g.scene.keys.Edit;
      if (edit && edit.scene && edit.scene.isActive()) redrawEdit(edit);
    } catch (e) {
      report({ type: "cost-patch-error", table: null, reason: String((e && e.message) || e) });
    }
  }

  function jsonFileProto() {
    var P = window.Phaser;
    return P && P.Loader && P.Loader.FileTypes && P.Loader.FileTypes.JSONFile
      ? P.Loader.FileTypes.JSONFile.prototype
      : null;
  }

  var now = jsonFileProto();
  if (now && typeof now.onProcess === "function") { ready(now); return; }

  var waited = 0;
  var timer = setInterval(function () {
    var proto = jsonFileProto();
    if (proto && typeof proto.onProcess === "function") {
      clearInterval(timer);
      ready(proto);
      return;
    }
    // 頂層 frame 永遠不會有 Phaser（遊戲在 iframe 裡），所以一定要有上限，
    // 否則每個 document 都留一個永遠不停的計時器。
    waited += CFG.pollIntervalMs;
    if (waited >= CFG.maxWaitMs) {
      clearInterval(timer);
      report({
        type: "cost-patch-error",
        table: null,
        reason: "等了 " + CFG.maxWaitMs + "ms 還是找不到 Phaser.Loader.FileTypes.JSONFile"
      });
    }
  }, CFG.pollIntervalMs);
})();`;
}

// ---------------------------------------------------------------------------
// 「這個頁面來得及嗎」
// ---------------------------------------------------------------------------

/**
 * 這一份 COST 表的指紋。**內容一樣就一樣，換了一個數字就不一樣。**
 *
 * 存在理由：`buildCostPatchCoverageExpression` 原本只問「這張表被改過嗎」，
 * 而那個問題答不出**換規則**的情況 —— 頁面上蓋著上一份規則的數字，旗標上
 * 也確實記著「改過 700 張」，於是判成「本來就好了」，永遠不會重載。症狀跟
 * 「插件沒生效」一模一樣：畫面上是舊價格，而記錄檔說規則載入成功。
 *
 * ⚠ **鍵要排序。** 同一份規則從不同來源讀進來（快取／安裝包／玩家的檔）
 * 物件的鍵序不保證一樣，不排序的話會多重載一次 —— 那是會打斷玩家的事。
 *
 * 用 FNV-1a 是因為這裡要的是「一樣不一樣」，不是防篡改：頁面上那個值本來就
 * 改得動，而能改它的人也能直接改補丁本身。真正的信任邊界在規則檔的簽章。
 */
export function costsStamp(costs: CostOverrides | CostOverrideTables): string {
  const tables = normalizeCostTables(costs);
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      // FNV prime 16777619，用位移做乘法才不會掉進浮點數。
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
  };
  for (const id of COST_TABLE_IDS) {
    feed(`|${id}|`);
    for (const key of Object.keys(tables[id]).sort()) feed(`${key}=${String(tables[id][key])};`);
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 這份規則會動到哪幾個快取鍵，以及那個鍵屬於哪張表。
 *
 * 跟 `buildCostPatchScript` 用的是同一套推導 —— 兩邊各算一次的話，某一天
 * 改了鍵就會變成「掛鉤掛在 A，卻去查 B 載了沒」。
 */
export function costTargetAssetKeys(
  costs: CostOverrides | CostOverrideTables,
  options: { assetKey?: string; assetKeys?: Partial<Record<CostTableId, string>> } = {},
): Record<string, CostTableId> {
  const tables = normalizeCostTables(costs);
  const out: Record<string, CostTableId> = {};
  for (const id of COST_TABLE_IDS) {
    if (Object.keys(tables[id]).length === 0) continue;
    const target = COST_TABLE_TARGETS[id];
    const assetKey =
      options.assetKeys?.[id] ??
      (id === "characters" ? options.assetKey : undefined) ??
      target.assetKey;
    out[assetKey] = id;
  }
  return out;
}

/** 補丁對「已經載進來的資料」蓋到了多少。 */
export interface CostPatchCoverage {
  /**
   * 已經在快取裡、而且補丁**沒有**改到的目標鍵。
   *
   * ⚠ **不是空的就代表畫面上是原版價格，只有重載才救得回來。**
   */
  missed: string[];
  /** 已經在快取裡、補丁也改到了的。 */
  covered: string[];
}

/**
 * 補丁到底有沒有蓋到這個頁面上已經載入的卡片資料。
 *
 * ⚠ **判準是「在快取裡卻沒被改到」，不是「在快取裡」。** 這兩者只差一個字，
 * 但用後者會變成無窮重載：重載完成之後資料當然還是在快取裡（而且已經被改過
 * 了），照樣會被判成「來不及」，於是再重載一次，永遠停不下來。
 *
 * 四種狀況：
 *
 * ```
 *   還沒載（剛開遊戲、還在登入畫面）  missed=[]        掛鉤趕得上 → 不必重載
 *   載了但沒改到（插件事後才接上）    missed=[cc…]     只有重載救得回來
 *   載了、改到了，但**是別份規則**    missed=[cc…]     同上（見 stamp）
 *   載了而且改的就是這一份            missed=[]        本來就好了
 * ```
 *
 * ⚠⚠ **第三列是後來補的，而少了它的症狀跟「插件沒生效」分不出來。**
 * 判準本來只有「這張表被改過嗎」，於是玩家換一份規則（或插件重開時載到
 * 另一份）之後，頁面上留著上一份的數字、旗標上也確實記著「改過 700 張」，
 * 一律判成「本來就好了」—— 而記錄檔還會說規則載入成功。
 * 現在多比一個指紋（`costsStamp`），不是同一份就當成沒蓋到。
 *
 * ⚠ 舊版腳本沒有 `stamp` 這一格，會被判成「不是這一份」→ 重載一次。那是對的：
 * 那個頁面上蓋的確實是我們現在不知道內容的某一份規則。
 */
export function buildCostPatchCoverageExpression(
  targets: Record<string, CostTableId>,
  stamp?: string,
): string {
  return `(function () {
  try {
    var stamp = JSON.parse(${embedJson(stamp ?? null)});
    var want = JSON.parse(${embedJson(targets)});
    var g = window.game;
    var c = g && g.cache && g.cache.json;
    // 遊戲物件都還沒建起來 = 一張都還沒載，掛鉤穩穩趕得上。
    if (!c) return JSON.stringify({ missed: [], covered: [] });
    var flag = window["${COST_PATCH_FLAG}"];
    // 頁面上蓋的是**別份**規則 → 每一張已經載進來的表都要重載才救得回來。
    // ⚠ stamp 沒傳進來（舊呼叫端）時不比對，行為完全跟以前一樣。
    var sameRule = stamp === null || (!!flag && flag.stamp === stamp);
    var missed = [];
    var covered = [];
    for (var key in want) {
      if (!Object.prototype.hasOwnProperty.call(want, key)) continue;
      if (!c.has(key)) continue;
      // 補丁跑過那張表的話會把改到幾張記在旗標上（見 patchCostData）。
      if (sameRule && flag && typeof flag[want[key]] === "number") covered.push(key);
      else missed.push(key);
    }
    return JSON.stringify({ missed: missed, covered: covered });
  } catch (e) {
    return JSON.stringify({ missed: [], covered: [] });
  }
})()`;
}

/** 解析上面那支的回傳。認不得的形狀一律當成「沒有漏」—— 寧可不重載也不要亂重載。 */
export function parseCostPatchCoverage(raw: unknown): CostPatchCoverage {
  const empty: CostPatchCoverage = { missed: [], covered: [] };
  if (typeof raw !== "string") return empty;
  try {
    const o = JSON.parse(raw) as { missed?: unknown; covered?: unknown };
    const str = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
    return { missed: str(o.missed), covered: str(o.covered) };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 不重載，切換「自訂價 ↔ 原價」
// ---------------------------------------------------------------------------

/** `buildCostPatchEnabledExpression` 的結果。 */
export interface CostPatchEnabledResult {
  /** 頁面上有沒有這支補丁。沒有的話什麼都沒切（畫面本來就是原價）。 */
  installed: boolean;
  /** 切完之後畫面上是自訂價（true）還是原價（false）。 */
  enabled: boolean;
  /** 換了幾筆快取資料。0 而 `installed` 是 true = 掛鉤還沒攔到任何一張表。 */
  swapped: number;
  /** 牌組編輯畫面開著，而且已經重畫過了。 */
  redrawn: boolean;
}

/**
 * 產生「把畫面切成自訂價／原價」的運算式。**立刻生效，不重載。**
 *
 * 靠的是補丁在改寫時記下的原價（`window.__ulrCostPatch.originals`），所以
 * 只對「掛鉤真的攔到過」的表有效 —— 插件比遊戲晚接上、資料已經在快取裡的
 * 那幾張，這支救不回來，仍然要靠「來得及嗎」那條路重載一次。
 *
 * ⚠ 這支**不動壓 C 罰則**。罰則另有自己的裝／拆（`patch-penalty.ts`），
 * 呼叫端要一起切，否則會出現「官方價格配自訂罰則」這種不存在的規則。
 */
export function buildCostPatchEnabledExpression(enabled: boolean): string {
  return `(function () {
  try {
    var st = window["${COST_PATCH_FLAG}"];
    if (!st || typeof st.setEnabled !== "function") {
      return JSON.stringify({ installed: false, enabled: false, swapped: 0, redrawn: false });
    }
    var r = st.setEnabled(${enabled ? "true" : "false"});
    return JSON.stringify({ installed: true, enabled: r.enabled, swapped: r.swapped, redrawn: r.redrawn });
  } catch (e) {
    return JSON.stringify({ installed: false, enabled: false, swapped: 0, redrawn: false });
  }
})()`;
}

export function parseCostPatchEnabledResult(raw: unknown): CostPatchEnabledResult {
  const off: CostPatchEnabledResult = {
    installed: false,
    enabled: false,
    swapped: 0,
    redrawn: false,
  };
  if (typeof raw !== "string") return off;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      installed: o.installed === true,
      enabled: o.enabled === true,
      swapped: typeof o.swapped === "number" ? o.swapped : 0,
      redrawn: o.redrawn === true,
    };
  } catch {
    return off;
  }
}
