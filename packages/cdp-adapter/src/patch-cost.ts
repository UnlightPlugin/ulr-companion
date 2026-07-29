/**
 * 改寫遊戲內顯示的 COST
 * =======================
 * 移植自 5i 的 `unlight_crawler/src/script/cdp/patch_cost.js`，機制相同：
 *
 *     hook Phaser.Loader.FileTypes.JSONFile.prototype.onProcess
 *       → 攔到 key === "cc_asset" 的載入
 *         → 就地改寫 data.frames[].cost
 *
 * 為什麼是攔載入而不是改畫面：`cc_asset` 是牌組畫面、角色資訊、隊伍總和
 * 全部共用的那份資料。改在它進 Phaser 快取之前，所有用到 COST 的地方
 * 一次到位，不用去追每個 UI 元件。
 *
 * ⚠ **必須用 `Page.addScriptToEvaluateOnNewDocument` 注入。**
 * `Runtime.evaluate` 太晚 —— 那時 `cc_asset` 早就載完，hook 掛上去也不會再被呼叫。
 *
 * 四條在這裡特別要守的規則：
 *
 * 1. **失敗要降級**（CONTRIBUTING §9.1）。注入的程式碼裡每一段都包 try/catch，
 *    而且 hook 是「先讓遊戲跑完原本的 onProcess，再做我們的事」——
 *    我們炸掉時遊戲的狀態仍然是完整的。
 * 2. **不得把遠端資料變成可執行邏輯**（§12）。腳本本體是這個檔案裡的常數，
 *    規則內容只以 `JSON.parse` 的**資料**進去，永遠不會被當程式碼執行。
 * 3. **不搬大物件回 Node**。回報只帶統計與 filename 索引，不帶整份 cc_asset。
 * 4. **不改伺服器判定**（§12 硬規則 4）。這只改本機顯示。
 */

import { CC_ASSET_KEY } from "./constants.js";

/**
 * COST 對照表：**鍵是 cc_asset 的 `filename`**，例如 `cc078_04`（L4）、
 * `cc078_r04`（R4）。
 *
 * ⚠ 不要用「角色 + 等級」組出來的鍵（`cc078_L4` 那種）。L4 與 R4 在
 * cc_asset 裡的 `level` 都是 4，只有 `filename` 分得開，而兩者 COST 不同
 * （實測 cc078_04 = 19、cc078_r04 = 21）。用 level 當鍵會讓所有覺醒卡撞號。
 * 詳見 docs/open-questions.md 第 1 題。
 *
 * 這裡刻意**不做**規則鍵到 filename 的轉換 —— 那題還沒定案，把未定的東西
 * 寫進來只會等著改。呼叫端負責給已經是 filename 的表。
 */
export type CostOverrides = Readonly<Record<string, number>>;

export interface CostPatchOptions {
  costs: CostOverrides;
  /** 頁面呼叫這個名字把結果送回 Node。由 `Runtime.addBinding` 建立。 */
  bindingName: string;
  /** 預設 `cc_asset`。留參數是為了遊戲改版換鍵時不用改程式。 */
  assetKey?: string;
  /** 等 Phaser 出現的輪詢間隔。 */
  pollIntervalMs?: number;
  /** 等不到就放棄並回報。無上限的輪詢會在頂層 frame 永遠空轉。 */
  maxWaitMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 50;
export const DEFAULT_MAX_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

/** hook 掛上去了，但還沒攔到 cc_asset。 */
export interface CostPatchInstalled {
  type: "cost-patch-installed";
}

export interface CostPatchApplied {
  type: "cost-patch";
  assetKey: string;
  /** cc_asset 裡的卡片總數 */
  totalFrames: number;
  /** 實際被改到的張數 */
  applied: number;
  /**
   * 規則裡有、但這個客戶端版本的 cc_asset 沒有的鍵。
   *
   * 不能當成 0 忽略 —— 那會讓超標的隊伍看起來合法。這是「遊戲改版了，
   * 規則要跟上」的訊號，UI 要顯示出來。
   */
  unknownKeys: string[];
  /**
   * `charaIndex`（cc_asset frames 的陣列索引）→ `filename`。
   *
   * 封包裡的 `charaIndex` 就是這個索引。有了它就能把封包直接對到規則的鍵，
   * 而且這份索引是從**玩家自己的客戶端**讀出來的，永遠跟他跑的版本一致 ——
   * 不需要在插件裡塞一份會過期的對照表。
   */
  index: string[];
}

export interface CostPatchError {
  type: "cost-patch-error";
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

function assertValidCosts(costs: CostOverrides): void {
  for (const [key, value] of Object.entries(costs)) {
    if (key.length === 0) {
      throw new InvalidCostOverrideError("(空字串)", "鍵不能是空字串");
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // NaN / Infinity 經過 JSON 會變成 null，寫進 cc.cost 之後畫面會顯示
      // 空白或 NaN，而且看起來像是遊戲壞了。擋在這裡比較好查。
      throw new InvalidCostOverrideError(key, `值必須是有限數字，收到 ${String(value)}`);
    }
  }
}

/**
 * 把資料嵌進腳本 —— 先 `JSON.stringify` 成字串，再包成 JS 字串字面值，
 * 頁面端用 `JSON.parse` 讀回來。
 *
 * 為什麼不直接寫成物件字面值（原版 patch_cost.js 的 `__JSON_DATA__` 做法）：
 * 在 JS **物件字面值**裡 `"__proto__": x` 會去設原型而不是新增屬性，
 * `JSON.parse` 則會當成一般屬性。規則檔是外部資料，不該有辦法碰到原型。
 */
/**
 * 要在嵌入時改寫成跳脫序列的字元。
 *
 * - U+2028 / U+2029：在 ES2019 之前的 JS 字串字面值裡不合法
 * - `<`：萬一有人把產生出來的腳本塞進 `<script>` 標籤
 *
 * 用 `fromCharCode` 產生那兩個 code point，原始碼裡不出現字面字元 ——
 * 它們在編輯器裡完全看不見，被剪貼簿或 Unicode 正規化弄掉的話這道保險
 * 會靜默失效。`packages/rule-schema/test/canonical.test.ts` 為了同樣的
 * 理由也是這樣寫。
 */
const NEEDS_ESCAPE = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}<]`, "g");

function embedJson(value: unknown): string {
  const literal = JSON.stringify(JSON.stringify(value));
  return literal.replace(
    NEEDS_ESCAPE,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * 產生要注入的 JS。純函式，沒有副作用 —— 所以可以完整測試，不需要活著的遊戲。
 */
export function buildCostPatchScript(options: CostPatchOptions): string {
  assertValidCosts(options.costs);

  const config = {
    assetKey: options.assetKey ?? CC_ASSET_KEY,
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    costs: options.costs,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = "__ulrCostPatch";
  var has = Object.prototype.hasOwnProperty;

  // addScriptToEvaluateOnNewDocument 每個 frame 都會跑，重連時也會再注入一次。
  // 沒有這道閘就會把 onProcess 疊好幾層，每次載入重複改寫同一份資料。
  if (window[FLAG]) return;
  window[FLAG] = { installed: false, applied: 0 };

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲。
    }
  }

  function patchCostData(data) {
    var frames = data && data.frames;
    if (!frames || typeof frames.length !== "number") {
      report({ type: "cost-patch-error", reason: "cc_asset 沒有 frames 陣列" });
      return;
    }

    var costs = CFG.costs;
    var index = [];
    var seen = Object.create(null);
    var applied = 0;

    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var name = frame && typeof frame.filename === "string" ? frame.filename : "";
      index.push(name);
      if (name === "") continue;
      seen[name] = true;
      if (!has.call(costs, name)) continue;
      frame.cost = costs[name];
      applied++;
    }

    var unknown = [];
    for (var key in costs) {
      if (has.call(costs, key) && !seen[key]) unknown.push(key);
    }

    window[FLAG].applied = applied;
    report({
      type: "cost-patch",
      assetKey: CFG.assetKey,
      totalFrames: frames.length,
      applied: applied,
      unknownKeys: unknown,
      index: index
    });
  }

  function install(proto) {
    if (proto.__ulrPatched) return;
    var original = proto.onProcess;
    proto.onProcess = function () {
      // 先跑遊戲原本的，再做我們的。順序不能顛倒 —— 我們拋例外時，
      // 遊戲該做的事已經做完了。
      original.apply(this, arguments);
      try {
        if (this.key === CFG.assetKey) patchCostData(this.data);
      } catch (e) {
        report({ type: "cost-patch-error", reason: String((e && e.message) || e) });
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
        report({ type: "cost-patch-error", reason: String((e && e.message) || e) });
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
        reason: "等了 " + CFG.maxWaitMs + "ms 還是找不到 Phaser.Loader.FileTypes.JSONFile"
      });
    }
  }, CFG.pollIntervalMs);
})();`;
}
