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
 * | 角色 | `cc_asset`    | `.frames`  | `filename`（`cc078_04`） |
 * | 怪物 | `mc_asset`    | `.frames`  | `filename`（`mc001_01`） |
 * | 裝備 | `avatar_item` | `.weapon`  | **陣列索引**             |
 * | 事件 | `event_info`  | `.frames`  | **陣列索引**             |
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

import {
  AVATAR_ITEM_KEY,
  AVATAR_ITEM_WEAPON_FIELD,
  CC_ASSET_KEY,
  EVENT_INFO_JSON_KEY,
  MC_ASSET_KEY,
} from "./constants.js";
import { embedJson } from "./embed.js";

/**
 * 一張表的 COST 對照表。
 *
 * 鍵是什麼**因表而異**，見上面那張表：角色與怪物用資產自己的 `filename`，
 * 裝備與事件卡用**陣列索引的十進位字串**（`"0"`、`"91"`）。
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
  /** 鍵是 `cc_asset` 的 `filename`，例如 `cc078_04` */
  characters?: CostOverrides | undefined;
  /** 鍵是 `mc_asset` 的 `filename`，例如 `mc001_01` */
  monsters?: CostOverrides | undefined;
  /** 鍵是 `avatar_item.weapon` 的**陣列索引字串**，例如 `"1"` */
  equipment?: CostOverrides | undefined;
  /** 鍵是 `event_info.frames` 的**陣列索引字串**，例如 `"91"` */
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
 * `keyMode`：
 *   - `filename` —— 用那一筆自己的 `filename` 欄位當鍵
 *   - `index`    —— 用陣列索引的十進位字串當鍵
 */
/**
 * 補丁裝在頁面上的旗標名。
 *
 * ⚠ 注入腳本與「補丁蓋到了沒」那支查詢**共用這一個常數**。分成兩份字面值的
 * 話，改名時只會改到其中一邊，而症狀是查詢永遠回「沒蓋到」→ 每次接上都重載。
 */
export const COST_PATCH_FLAG = "__ulrCostPatch";

export const COST_TABLE_TARGETS: Readonly<
  Record<CostTableId, { assetKey: string; field: string; keyMode: "filename" | "index" }>
> = {
  characters: { assetKey: CC_ASSET_KEY, field: "frames", keyMode: "filename" },
  monsters: { assetKey: MC_ASSET_KEY, field: "frames", keyMode: "filename" },
  equipment: {
    assetKey: AVATAR_ITEM_KEY,
    field: AVATAR_ITEM_WEAPON_FIELD,
    keyMode: "index",
  },
  eventCards: { assetKey: EVENT_INFO_JSON_KEY, field: "frames", keyMode: "index" },
};

/**
 * 牌組編輯畫面在 `create()` 時把四份資料 **`structuredClone` 了一份**掛在
 * 自己身上（2026-09-12 從跑著的客戶端讀到：`this.ccInfo=structuredClone(t)`…）。
 * 格線上每張卡的數字讀的是這份副本，總和（`costcheck()`）讀的才是快取。
 * 不重載切換價格時兩份都要換 —— 對照表放這裡，快取鍵 → 場景屬性名。
 */
export const EDIT_SCENE_CLONES: Readonly<Record<string, string>> = {
  [CC_ASSET_KEY]: "ccInfo",
  [MC_ASSET_KEY]: "mcInfo",
  [AVATAR_ITEM_KEY]: "itemInfo",
  [EVENT_INFO_JSON_KEY]: "eventInfo",
};

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
   * 注入腳本要的形狀：快取鍵 → 這份資料怎麼處理。
   *
   * ⚠ 用快取鍵當索引而不是表名，是因為 hook 裡拿得到的只有 `this.key`。
   * 沒有要改的表就不放進來 —— 那樣 hook 對它連查都不會查。
   */
  const targets: Record<
    string,
    { table: CostTableId; field: string; keyMode: "filename" | "index"; costs: CostOverrides }
  > = {};
  for (const id of COST_TABLE_IDS) {
    const costs = tables[id];
    if (Object.keys(costs).length === 0) continue;
    const target = COST_TABLE_TARGETS[id];
    const assetKey =
      options.assetKeys?.[id] ??
      (id === "characters" ? options.assetKey : undefined) ??
      target.assetKey;
    targets[assetKey] = { table: id, field: target.field, keyMode: target.keyMode, costs };
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

  // addScriptToEvaluateOnNewDocument 每個 frame 都會跑，重連時也會再注入一次。
  // 沒有這道閘就會把 onProcess 疊好幾層，每次載入重複改寫同一份資料。
  //
  // ⚠ **換了規則也照樣早退。** 掛鉤只在資料「載入的那一刻」有機會動手，重跑
  // 一次它救不回已經在快取裡的東西 —— 真正會換掉數字的是重載，而重載由
  // 「來得及嗎」那支（看 stamp）去觸發。早退時舊的 stamp 因此要留著，
  // 那正是它判斷得出「頁面上是別份規則」的依據。
  if (window[FLAG]) return;
  window[FLAG] = {
    installed: false,
    applied: 0,
    stamp: CFG.stamp,
    // 現在畫面上是自訂價（true）還是原價（false）。setEnabled() 切。
    enabled: !!CFG.enabled,
    // 每張表「鍵 → 原價」。**只有規則有動到的那幾筆**，所以切回原價時
    // 不必知道整份資料長什麼樣。
    originals: {},
    // 每張表「鍵 → 自訂價」，就是規則本身。跟 originals 成對：牌組選單
    // （patch-deck-edit）要**同時**畫官方與自訂兩個總和，而快取裡任一時刻
    // 只躺著其中一種價 —— 另一種只能從這兩份查。
    customs: {},
    setEnabled: setEnabled
  };
  for (var tk in CFG.targets) {
    if (has.call(CFG.targets, tk)) window[FLAG].customs[CFG.targets[tk].table] = CFG.targets[tk].costs;
  }

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲。
    }
  }

  /** 這一筆的鍵：filename 型的表用它自己的 filename，索引型的用位置。 */
  function rowKey(spec, row, i) {
    if (spec.keyMode !== "filename") return String(i);
    return row && typeof row.filename === "string" ? row.filename : "";
  }

  /**
   * 改寫一份資料裡的價格。
   *
   * 四張表的差別只有兩個：陣列在哪個欄位（frames / weapon），以及鍵是
   * 那一筆的 filename 還是它的陣列索引。
   */
  function patchCostData(assetKey, spec, data) {
    var rows = data ? data[spec.field] : null;
    if (!rows || typeof rows.length !== "number") {
      report({
        type: "cost-patch-error",
        table: spec.table,
        reason: assetKey + " 沒有 " + spec.field + " 陣列"
      });
      return;
    }

    var costs = spec.costs;
    var byFilename = spec.keyMode === "filename";
    var index = byFilename ? [] : null;
    var seen = Object.create(null);
    var originals = Object.create(null);
    var enabled = window[FLAG].enabled;
    var applied = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = rowKey(spec, row, i);
      if (byFilename) {
        // 保留空位（沒有 filename）照樣要佔一格 —— index 的位置就是封包裡的
        // charaIndex，跳過一筆會讓後面全部偏移。
        index.push(name);
        if (name === "") continue;
      }
      seen[name] = true;
      if (!row || !has.call(costs, name)) continue;
      // ⚠ 原價一定要先記，不管現在套不套 —— 這是之後切回官方價唯一的依據。
      originals[name] = row.cost;
      if (enabled) row.cost = costs[name];
      applied++;
    }

    var unknown = [];
    for (var key in costs) {
      if (has.call(costs, key) && !seen[key]) unknown.push(key);
    }

    window[FLAG].applied += applied;
    window[FLAG][spec.table] = applied;
    window[FLAG].originals[spec.table] = originals;
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

  /** 把一組 rows 裡規則有動到的那幾筆換成自訂價或原價。回換了幾筆。 */
  function swapRows(spec, rows, originals, enabled) {
    if (!rows || typeof rows.length !== "number") return 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var name = rowKey(spec, row, i);
      if (name === "" || !has.call(originals, name)) continue;
      row.cost = enabled ? spec.costs[name] : originals[name];
      n++;
    }
    return n;
  }

  /**
   * 不重載，把畫面上的價格在「自訂」與「原價」之間切換。
   *
   * 兩份資料都要換：Phaser 快取那份（costcheck() 算總和讀的是它 ——
   * Chara.charaAsset 就是同一個物件），以及牌組編輯畫面在 create() 時
   * structuredClone 出來的那份（格線上每張卡的數字讀的是它）。只換一份的
   * 症狀是「總和變了、卡上的數字沒變」或反過來。
   *
   * 只有掛鉤真的攔到過的表才切得動（originals 有那一張）。攔不到的那幾張
   * 本來就是原價、而且只有重載救得回來 —— 那是「來得及嗎」那支的事。
   */
  function setEnabled(enabled) {
    var st = window[FLAG];
    st.enabled = !!enabled;
    var swapped = 0;
    var g = window.game;
    var cache = g && g.cache && g.cache.json;
    var edit = g && g.scene && g.scene.keys && g.scene.keys.Edit;
    for (var key in CFG.targets) {
      if (!has.call(CFG.targets, key)) continue;
      var spec = CFG.targets[key];
      var originals = st.originals[spec.table];
      if (!originals) continue;
      try {
        var data = cache && cache.has(key) ? cache.get(key) : null;
        swapped += swapRows(spec, data ? data[spec.field] : null, originals, st.enabled);
      } catch (e) {}
      try {
        var prop = CFG.editClones[key];
        var clone = edit && prop ? edit[prop] : null;
        // ⚠ 只在它真的是另一份時才動；同一個物件就是上面已經換過的那份。
        if (clone && (!cache || !cache.has(key) || clone !== cache.get(key))) {
          swapRows(spec, clone[spec.field], originals, st.enabled);
        }
      } catch (e) {}
    }
    var redrawn = false;
    try {
      if (edit && edit.scene.isActive() && typeof edit.edit_reflesh === "function") {
        redrawEdit(edit);
        redrawn = true;
        refreshViewInfo(edit);
      }
    } catch (e) {}
    return { enabled: st.enabled, swapped: swapped, redrawn: redrawn };
  }

  /**
   * 重畫牌組編輯畫面 —— 格線「排列」用的是成本時要**重排**，不只重畫。
   *
   * edit_reflesh() 只照 card_index 現在的順序畫（2026-09-12 實機讀到：它不排
   * 序，排序住在模組私有的 v() 裡，場景碰不到）。價格換了、順序沒換的話，
   * 「排列(降序) 成本」的格線會變成 30、19、29、28… 這種亂的。
   *
   * 遊戲自己重排的入口是排列選單的 child.down：拿選項名字找索引 s，然後把
   * sort_option_(category) 在 sA / sB 之間**翻一面**、重排、edit_reflesh()。
   * 所以先把選項自己翻到另一面、再送一次同名的 child.down，落回原本那一面，
   * 只重排重畫一次。頁碼在 edit_reflesh() 裡不會動（只有超出最後一頁才夾回去
   * —— 重排不改張數，所以第 4 頁還是第 4 頁）。
   *
   * 「2」= 成本是 v() 寫死的（0 ID、1 等級、2 成本、3 HP…）。只有 card 與
   * mons 兩類有排列；其他類別、或排的不是成本，照常只重畫。
   */
  function redrawEdit(sc) {
    var cat = sc.category;
    var key = "sort_option_" + cat;
    var opt = (cat === "card" || cat === "mons") ? sc[key] : null;
    var byCost = typeof opt === "string" && opt.length === 2 && opt.charAt(0) === "2";
    if (byCost && sc.sort_panel && typeof sc.sort_panel.emit === "function" &&
        sc.sort_name && typeof sc.sort_name.text === "string") {
      sc[key] = "2" + (opt.charAt(1) === "A" ? "B" : "A");
      sc.sort_panel.emit("child.down", { name: sc.sort_name.text });
      // 落回原本那一面 = 遊戲的 handler 跑過了（重排 + 重畫都在裡面）。
      if (sc[key] === opt) return;
      // 沒有 handler 接（遊戲改版？）：把選項放回去，退回只重畫。
      sc[key] = opt;
    }
    sc.edit_reflesh();
  }

  /**
   * 右邊資訊欄的 COST 那一格。
   *
   * edit_reflesh() 不重畫它 —— 那一格是玩家點卡片時 set_view_info() 寫進去
   * 的，之後就停在那裡（2026-09-12 實機：切換後右欄還是舊數字，重點一次卡片
   * 才變）。所以照遊戲自己的對照補寫：compotype 說現在選的是哪一類、
   * compo_index 是它在那張表裡的索引，格子的名字跟 reset_view_info() 裡的
   * 一樣。只在那格看得見時才動，其他一律不碰。
   */
  function refreshViewInfo(sc) {
    try {
      var i = sc.compo_index;
      if (typeof i !== "number") return;
      var box = null, rows = null;
      switch (sc.compotype) {
        case "card":   box = sc.chara_cost;  rows = sc.ccInfo && sc.ccInfo.frames; break;
        case "mons":   box = sc.chara_cost;  rows = sc.mcInfo && sc.mcInfo.frames; break;
        case "weapon": box = sc.weapon_cost; rows = sc.itemInfo && sc.itemInfo.weapon; break;
        case "event":  box = sc.event_cost;  rows = sc.eventInfo && sc.eventInfo.frames; break;
        default: return;
      }
      if (!box || !box.visible || typeof box.setText !== "function") return;
      var row = rows && rows[i];
      if (row && typeof row.cost === "number") box.setText(String(row.cost));
    } catch (e) {}
  }

  function install(proto) {
    if (proto.__ulrPatched) return;
    var original = proto.onProcess;
    proto.onProcess = function () {
      // 先跑遊戲原本的，再做我們的。順序不能顛倒 —— 我們拋例外時，
      // 遊戲該做的事已經做完了。
      original.apply(this, arguments);
      try {
        var spec = has.call(CFG.targets, this.key) ? CFG.targets[this.key] : null;
        if (spec !== null) patchCostData(this.key, spec, this.data);
      } catch (e) {
        report({
          type: "cost-patch-error",
          table: null,
          reason: String((e && e.message) || e)
        });
      }
    };
    proto.__ulrPatched = true;
    window[FLAG].installed = true;
    report({ type: "cost-patch-installed" });
  }

  var waited = 0;
  var timer = setInterval(function () {
    var P = window.Phaser;
    var proto =
      P && P.Loader && P.Loader.FileTypes && P.Loader.FileTypes.JSONFile
        ? P.Loader.FileTypes.JSONFile.prototype
        : null;

    if (proto && typeof proto.onProcess === "function") {
      clearInterval(timer);
      try {
        install(proto);
      } catch (e) {
        report({ type: "cost-patch-error", table: null, reason: String((e && e.message) || e) });
      }
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
