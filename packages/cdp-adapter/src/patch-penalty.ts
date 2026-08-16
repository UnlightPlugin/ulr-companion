/**
 * 改寫遊戲內顯示的壓 C 罰則
 * ===========================
 * `patch-cost.ts` 改的是**卡片的價格**（`cc_asset[].cost`）；這支改的是
 * **罰則的公式**。兩件事完全獨立，而且缺了這支的話，自訂規則的
 * `compressionRule` 對遊戲畫面**一點作用都沒有** —— 因為罰則是客戶端
 * `src/deck/cost-check.ts` 的 `costcheck()` 算的，門檻（7 → +5、14 → +10）
 * 寫死在程式碼裡，不在任何資料表。
 *
 * ## 注入點：`Deck.prototype.getCost`
 *
 * 牌組畫面的每一次刷新都走這裡：
 *
 * ```
 *   Edit.edit_reflesh() ─┐
 *   place_card()        ─┼─▶ refresh_penalties(scene)
 *   auto_remove()       ─┘        │
 *                                 ▼
 *                   new Deck(data).getCost()  ← 我們攔這裡
 *                                 │
 *                   { total, cards, penalties, event, weapon }
 *                                 │
 *                   cost_text[] / cost_penalty_text[] / cost_total_text
 * ```
 *
 * 攔 `getCost` 而不是 `costcheck`：`costcheck` 是 unlight-common **內層**
 * eval 模組系統裡的函式，外面拿不到；`Deck` 則是模組 12919 的具名匯出，
 * 而且 2026-08-15 實測 `getCost` 是 `writable + configurable`、prototype
 * 沒有凍結。攔 `getCost` 也自動涵蓋了全部三個呼叫點。
 *
 * ## 整個遊戲環境都要生效 —— 為什麼光攔 getCost 不夠
 *
 * 攔 `getCost` 只讓**牌組編輯畫面**生效。`Match`／MatchingLobby／`Quest`
 * 顯示的 `cost:53` 讀的是 `db_deck{n}` **回應裡的 `e.cost`**，也就是伺服器
 * 存的值 —— 那些場景自己不重算。所以還要攔 WSClient：
 *
 * ```
 *   伺服器 ──db_deck{n}──▶ fetch   改寫 cost 成我們算的  ──▶ 每一個畫面
 *   伺服器 ◀──db_editdeck── emit   還原 cost 成原版      ◀── 牌組存檔
 * ```
 *
 * ## ⚠⚠ 出站那半邊是安全要求，不是可選的
 *
 * 牌組存檔送的是 **整個 deck 物件，含 `cost`**：
 *
 *     socket.emit("db_editdeck", id, deck1, deck2, deck3, checked)
 *
 * 而 `refresh_penalties` 會把算好的 total 寫回 `deck.cost`。**不攔的話，
 * 我們算出來的數字會被送上伺服器** —— §12 硬規則 4 明訂不得改變伺服器判定，
 * 而「伺服器大概會自己重算」不是可以依賴的理由（要驗證它等於嘗試作弊）。
 *
 * 所以出站一律還原成用**原始** `getCost` 算的值，封包與沒裝插件時逐位元相同。
 * ⚠ 還原時要**淺拷貝**，不能就地改 —— 就地改會讓畫面上的數字在存檔那一瞬間
 * 跳回原版，而且那個物件是場景還在用的同一份。
 *
 * `Deck.prototype.updateCost()` 也刻意不碰（它走 `costcheck`，本來就是原版值）。
 *
 * ## ⚠ 這支不能用 addScriptToEvaluateOnNewDocument 以外的方式裝嗎？
 *
 * 可以。跟 `patch-cost` 不同，`Deck` 類別在遊戲跑起來之後一直都在，所以
 * `Runtime.evaluate` 也裝得上、**不需要重載遊戲**。兩種都支援：
 * 開著遊戲改規則就用 evaluate，開機自動套用就用 addScript。
 */

import { embedJson } from "./embed.js";

/**
 * 從 webpack 的 chunk 陣列取得 `__webpack_require__`。
 *
 * ⚠⚠ **每次都必須用不一樣的 chunk id。** webpack 5 的 jsonp callback 是
 *
 * ```js
 * if (chunkIds.some((id) => installedChunks[id] !== 0)) {
 *   for (moduleId in moreModules) { … }
 *   if (runtime) var result = runtime(__webpack_require__);   // ← 只在這裡
 * }
 * ```
 *
 * 推第二次同一個 id 時，`installedChunks[id]` 已經是 `0`，`some()` 為 false，
 * **`runtime` 回呼整個被跳過** —— 拿不到 `__webpack_require__`，而且不會拋錯。
 *
 * 2026-08-15 實測踩到：第一次套規則正常，第二次換規則就靜靜地什麼都沒發生，
 * 輪詢到 60 秒逾時為止。這種「第二次才壞」的行為在手動測試裡幾乎抓不到。
 *
 * 用頁面上的計數器而不是 `Math.random()`，這樣同一頁的行為是可預期的。
 */
const WEBPACK_REQUIRE_SNIPPET = `function ulrWebpackRequire() {
    var chunkKey = null;
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      if (/webpack/i.test(keys[i]) && Array.isArray(window[keys[i]])) { chunkKey = keys[i]; break; }
    }
    if (chunkKey === null) return null;

    window.__ulrChunkSeq = (window.__ulrChunkSeq || 0) + 1;
    var req = null;
    window[chunkKey].push([
      ["__ulr_" + window.__ulrChunkSeq],
      {},
      function (r) { req = r; }
    ]);
    return typeof req === "function" && req.m ? req : null;
  }`;

/**
 * 一段壓 C 區間。與 `@ulr/rule-schema` 的 `GapBand` 同形狀，但這裡刻意
 * **不 import 那個型別** —— cdp-adapter 不依賴 rule-schema，保持
 * 「這一層只認得 CDP 與遊戲」的分界。
 */
export interface PenaltyBand {
  minGap: number;
  /** 省略 = 沒有上界 */
  maxGap?: number;
  extraCost: number;
}

export interface PenaltyPatchOptions {
  /**
   * 壓 C 區間表。**空陣列 = 完全不罰**（不是「用原版」）。
   * 要回原版請直接不裝這支，或呼叫 `uninstallPenaltyPatch`。
   */
  bands: readonly PenaltyBand[];
  /** 頁面呼叫這個名字把結果送回 Node。 */
  bindingName: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export const DEFAULT_PENALTY_POLL_MS = 100;
export const DEFAULT_PENALTY_MAX_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// 頁面回報
// ---------------------------------------------------------------------------

export interface PenaltyPatchApplied {
  type: "penalty-patch";
  /** 攔到的類別是從哪個 webpack 模組來的。改版換 id 時用得上。 */
  moduleId: string;
  /**
   * 徽章（每張卡底下的 `+5`）也一起改到了沒。
   *
   * ⚠ `false` 代表**總和是對的、但徽章會是空白** —— 遊戲畫徽章的 switch
   * 只認得 5 與 10，自訂值會掉進 default。UI 要把這件事講出來。
   */
  badgesPatched: boolean;
  /**
   * WSClient 的進出站攔截裝上了沒。
   *
   * `false` 代表**只有牌組編輯畫面會顯示新數字**，對戰大廳那類讀伺服器
   * `cost` 的畫面仍是原版；同時也代表出站的還原沒裝上，所以這種狀態下
   * **不應該讓玩家存牌組**。遊戲還在載入時會是 false，之後重試就會裝上。
   */
  socketPatched: boolean;
  bands: number;
  /** 裝上去之後立刻重算的那一次結果，方便確認真的生效。 */
  sample: { cards: (number | null)[]; penalties: (number | null)[]; total: number } | null;
}

export interface PenaltyPatchError {
  type: "penalty-patch-error";
  reason: string;
}

export type PenaltyPatchReport = PenaltyPatchApplied | PenaltyPatchError;

const REPORT_TYPES = new Set(["penalty-patch", "penalty-patch-error"]);

export function isPenaltyPatchReport(value: unknown): value is PenaltyPatchReport {
  return (
    typeof value === "object" &&
    value !== null &&
    REPORT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

// ---------------------------------------------------------------------------

export class InvalidPenaltyBandError extends Error {
  override readonly name = "InvalidPenaltyBandError";
}

function assertValidBands(bands: readonly PenaltyBand[]): void {
  bands.forEach((b, i) => {
    for (const [name, v] of [
      ["minGap", b.minGap],
      ["extraCost", b.extraCost],
    ] as const) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new InvalidPenaltyBandError(`第 ${i} 段的 ${name} 必須是有限數字，收到 ${String(v)}`);
      }
    }
    if (b.maxGap !== undefined && (!Number.isFinite(b.maxGap) || b.maxGap < b.minGap)) {
      throw new InvalidPenaltyBandError(
        `第 ${i} 段的 maxGap（${String(b.maxGap)}）不合法或小於 minGap（${b.minGap}）`,
      );
    }
  });
}

/**
 * 產生要注入的 JS。純函式，可完整測試，不需要活著的遊戲。
 *
 * 頁面端的算法必須跟 `@ulr/cost-engine` 的 `calculateTeamCost` 一致：
 * **隊內每一對角色各判一次**，落在哪一段就加多少。
 * `packages/cdp-adapter/test/patch-penalty.test.ts` 用同一組向量交叉檢查。
 */
export function buildPenaltyPatchScript(options: PenaltyPatchOptions): string {
  assertValidBands(options.bands);

  const config = {
    bindingName: options.bindingName,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_PENALTY_POLL_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_PENALTY_MAX_WAIT_MS,
    // ⚠ 區間表是**資料**。它只會被 JSON.parse，永遠不會被當程式碼執行（§12）。
    bands: options.bands,
  };

  return `(function () {
  "use strict";
  var CFG = JSON.parse(${embedJson(config)});
  var FLAG = "__ulrPenaltyPatch";

  ${WEBPACK_REQUIRE_SNIPPET}

  function report(payload) {
    try {
      var fn = window[CFG.bindingName];
      if (typeof fn === "function") fn(JSON.stringify(payload));
    } catch (e) {
      // 回報不了就算了，絕不能因此影響遊戲。
    }
  }

  // ── 罰則計算：跟 @ulr/cost-engine 同一套語義 ────────────────────────────
  function extraFor(gap) {
    for (var i = 0; i < CFG.bands.length; i++) {
      var b = CFG.bands[i];
      if (gap < b.minGap) continue;
      if (b.maxGap !== undefined && b.maxGap !== null && gap > b.maxGap) continue;
      return b.extraCost;
    }
    return 0;
  }

  /**
   * 逐對算出罰則，並把每一對的罰則**貼在造成它的那張卡底下**。
   *
   * ⚠⚠ 這裡的索引是**槽位**（result.cards[i] 的 i），不是名次。遊戲畫的是
   *
   *     cost_text[i]         ← cards[i]
   *     cost_penalty_text[i] ← penalties[i]
   *
   * 同一個 i，所以第 i 格的 +N 就長在第 i 張卡的數字旁邊。原版把排序後的
   * 結果寫進 penalties[]，於是罰則會出現在一張根本沒參與那一對的卡底下
   * （見 docs/official-cost-rule.md 的「罰 C 標記貼錯卡」）——
   * **這支原本照抄了那個行為**：把命中的罰則由大到小填進 0、1、2 格。
   * 實測 19 / 13 / 22 配夾擠式規則：罰則來自 13↔22（差 9 → +3），
   * 畫面卻把 +3 貼在第一格的 19 底下。第一格是誰純粹看玩家怎麼排牌組。
   *
   * 現在改成貼在**這一對裡比較便宜的那張**：壓 C 罰的是「為了湊上限而被夾帶
   * 進來的低 C 卡」，那張才是玩家要拿掉或換掉的。一樣貴時貼前面那格（要有
   * 確定性）；一張卡同時踩到兩對就把兩份加起來，所以**三格的和永遠等於總罰則**。
   */
  function penaltiesFor(cards) {
    // 長度跟著輸入走。遊戲固定給三格，但寫死 3 會讓多出來的罰則被安靜地
    // 丟掉 —— 那是總和悄悄變小，比顯示錯位嚴重得多。
    var out = [];
    for (var i = 0; i < Math.max(3, cards.length); i++) out.push(null);

    for (var a = 0; a < cards.length; a++) {
      if (typeof cards[a] !== "number") continue;
      for (var b = a + 1; b < cards.length; b++) {
        if (typeof cards[b] !== "number") continue;
        var extra = extraFor(Math.abs(cards[a] - cards[b]));
        if (extra === 0) continue;
        var slot = cards[a] <= cards[b] ? a : b;
        out[slot] = (out[slot] === null ? 0 : out[slot]) + extra;
      }
    }
    return out;
  }

  /**
   * 遊戲畫罰則徽章的那個 switch 只認得 5 與 10：
   *
   *     switch (s.penalties[i]) { case 10: "+10"; case 5: "+5"; default: "" }
   *
   * 所以自訂的 +1／+3／+22 全部會掉進 default 變成空字串 —— 總和是對的，
   * 徽章卻是空的。這支把徽章補回去。
   *
   * 顏色沿用遊戲自己的兩個色票：10 以上紅、其餘黃。
   */
  function fixBadges(scene, Deck) {
    var data = scene["deck" + scene.deck_now];
    var r = new Deck(data).getCost();
    for (var i = 0; i < 3; i++) {
      var t = scene.cost_penalty_text[i];
      if (!t) continue;
      var p = r.penalties[i];
      if (typeof p !== "number" || p === 0) { t.setText(""); continue; }
      // 整數不顯示小數點；0.01 精度的值最多兩位。
      var label = p === Math.round(p) ? String(p) : String(Math.round(p * 100) / 100);
      t.setText("+" + label).setFill(p >= 10 ? "#D91111" : "#EDC718");
    }
  }

  /**
   * 找出定義 refresh_penalties 的那個模組。
   *
   * ⚠ 要分辨「定義」與「呼叫」：呼叫長成 \`X.refresh_penalties(e)\`，前面有點；
   * 定義是 \`refresh_penalties(e){\`。只看名字會撈到五個模組，require 錯的那個
   * 等於把不相干的模組實例化。
   */
  var DEF_RE = /[^.\\w]refresh_penalties\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*\\)\\s*\\{/;

  function patchBadges(req, Deck) {
    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (!DEF_RE.test(src)) continue;

      var mod;
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var obj = mod[k];
        if (!obj || typeof obj.refresh_penalties !== "function") continue;

        var original = obj.__ulrOriginalRefresh || obj.refresh_penalties;
        obj.refresh_penalties = function (scene) {
          original.apply(this, arguments);
          try {
            fixBadges(scene, Deck);
          } catch (e) {
            // 補徽章失敗不能影響牌組畫面 —— 大不了徽章是空的，總和仍然對。
          }
        };
        obj.__ulrOriginalRefresh = original;
        return String(id);
      }
    }
    return null;
  }

  // WSClient 的原型。所有連線共用同一份（2026-08-15 實測 6 條連線、
  // getPrototypeOf 只拿到一個），所以 patch 一次全包。
  function findWsProto() {
    var keys = window.game && window.game.scene && window.game.scene.keys;
    if (!keys) return null;
    for (var k in keys) {
      var sc = keys[k];
      if (sc && sc.socket && typeof sc.socket.fetch === "function") {
        return Object.getPrototypeOf(sc.socket);
      }
    }
    return null;
  }

  /** 這個物件看起來像一副牌組嗎（要動它的 cost 之前先確認）。 */
  function looksLikeDeck(d) {
    return !!d && typeof d === "object" &&
      Object.prototype.toString.call(d.chara) === "[object Array]" &&
      Object.prototype.toString.call(d.charaIndex) === "[object Array]" &&
      typeof d.cost === "number";
  }

  // 兩邊對稱的攔截：進站 db_deck{n} 的 cost 換成我們算的（讓每個畫面都生效），
  // 出站 db_editdeck 的 cost 還原成原版（伺服器收到的與沒裝插件時一模一樣）。
  // 完整理由見這支的檔頭「整個遊戲環境都要生效」那一節。
  function patchSocket(Deck) {
    var proto = findWsProto();
    if (proto === null) return false;

    var origFetch = proto.__ulrOrigFetch || proto.fetch;
    var origEmit = proto.__ulrOrigEmit || proto.emit;
    if (typeof origFetch !== "function" || typeof origEmit !== "function") return false;

    // ── 進站：把伺服器給的 cost 換成用我們的規則算出來的 ──
    proto.fetch = function (event) {
      var p = origFetch.apply(this, arguments);
      if (typeof event !== "string" || event.indexOf("db_deck") !== 0) return p;
      return p.then(function (res) {
        try {
          if (res && typeof res === "object" && typeof Deck.toDeckData === "function") {
            var data = Deck.toDeckData(res);
            res.cost = new Deck(data).getCost().total;
          }
        } catch (e) {
          // 算不出來就維持伺服器給的值 —— 那是原版數字，是安全的方向。
        }
        return res;
      });
    };

    // ── 出站：把要存回去的 cost 還原成原版 ──
    proto.emit = function (event) {
      if (event !== "db_editdeck") return origEmit.apply(this, arguments);

      var args = Array.prototype.slice.call(arguments);
      try {
        var original = Deck.prototype.__ulrOriginalGetCost;
        for (var i = 1; i < args.length; i++) {
          if (!looksLikeDeck(args[i])) continue;
          // ⚠ 淺拷貝，**不能就地改**。就地改會讓畫面上的數字在存檔那一瞬間
          // 跳回原版，而且那個物件是場景還在用的那一份。
          var clone = {};
          for (var k in args[i]) clone[k] = args[i][k];
          clone.cost = original.call(new Deck(args[i])).total;
          args[i] = clone;
        }
      } catch (e) {
        // 還原失敗就送原本的參數。走到這裡代表我們根本沒裝成功，
        // 而那時 deck.cost 本來就是原版值。
        return origEmit.apply(this, arguments);
      }
      return origEmit.apply(this, args);
    };

    proto.__ulrOrigFetch = origFetch;
    proto.__ulrOrigEmit = origEmit;
    return true;
  }

  function install(Deck, moduleId, req) {
    var original = Deck.prototype.getCost;
    if (Deck.prototype.__ulrOriginalGetCost) {
      // 換規則時重裝：從**原始**的那支重新包，不要疊在上一層補丁上面。
      original = Deck.prototype.__ulrOriginalGetCost;
    }

    Deck.prototype.getCost = function () {
      var r = original.apply(this, arguments);
      try {
        var pen = penaltiesFor(r.cards);
        var oldSum = 0, newSum = 0;
        // ⚠ 走完整個陣列，不要寫死 3。少加到一格的症狀是總和差一點點，
        // 而畫面上每個數字看起來都對。
        for (var i = 0; i < Math.max(r.penalties.length, pen.length); i++) {
          if (typeof r.penalties[i] === "number") oldSum += r.penalties[i];
          if (typeof pen[i] === "number") newSum += pen[i];
        }
        r.penalties = pen;
        r.total = r.total - oldSum + newSum;
      } catch (e) {
        // 算壞了就回原版的結果 —— 寧可顯示原版數字，也不要讓牌組畫面爆掉。
      }
      return r;
    };
    Deck.prototype.__ulrOriginalGetCost = original;

    // ⚠ 只補了總和還不夠 —— 徽章的 switch 只認得 5 與 10。
    var badgeModuleId = patchBadges(req, Deck);
    // ⚠ 也還不夠 —— Match／MatchingLobby／Quest 讀的是伺服器給的 cost。
    var socketPatched = patchSocket(Deck);

    // 裝好之後叫牌組畫面重畫一次，否則玩家要自己點一下才看得到。
    var sample = null;
    try {
      var sc = window.game && window.game.scene && window.game.scene.keys.Edit;
      if (sc && sc.scene.isActive()) {
        var data = sc["deck" + sc.deck_now];
        var r2 = new Deck(data).getCost();
        sample = { cards: r2.cards, penalties: r2.penalties, total: r2.total };
        sc.edit_reflesh();
      }
    } catch (e) {
      // 不在牌組畫面就沒有東西要重畫，這不是錯誤。
    }

    window[FLAG] = {
      installed: true,
      moduleId: moduleId,
      badgeModuleId: badgeModuleId,
      socketPatched: socketPatched
    };
    report({
      type: "penalty-patch",
      moduleId: moduleId,
      badgesPatched: badgeModuleId !== null,
      socketPatched: socketPatched,
      bands: CFG.bands.length,
      sample: sample
    });
  }

  // 從 webpack 的 chunk 陣列拿到 __webpack_require__，再從模組登錄表
  // (req.m) 掃出 prototype 上有 getCost 的類別。模組 id 每次重建都會變，
  // 所以是掃特徵字串而不是查表 —— 理由見這支的檔頭。
  function findDeck() {
    var req = ulrWebpackRequire();
    if (req === null) return null;

    for (var id in req.m) {
      var src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      if (src.indexOf("prototype.getCost") === -1) continue;

      var mod;
      // ⚠ 只 require 命中的那一個。整份掃過去會把每個模組都實例化。
      try { mod = req(id); } catch (e) { continue; }
      for (var k in mod) {
        var v = mod[k];
        if (typeof v === "function" && v.prototype && typeof v.prototype.getCost === "function") {
          return { Deck: v, moduleId: String(id), req: req };
        }
      }
    }
    return null;
  }

  var waited = 0;
  var timer = setInterval(function () {
    var found = null;
    try {
      found = findDeck();
    } catch (e) {
      clearInterval(timer);
      report({ type: "penalty-patch-error", reason: String((e && e.message) || e) });
      return;
    }
    if (found !== null) {
      clearInterval(timer);
      try {
        install(found.Deck, found.moduleId, found.req);
      } catch (e) {
        report({ type: "penalty-patch-error", reason: String((e && e.message) || e) });
      }
      return;
    }
    waited += CFG.pollIntervalMs;
    if (waited >= CFG.maxWaitMs) {
      clearInterval(timer);
      report({
        type: "penalty-patch-error",
        reason: "等了 " + CFG.maxWaitMs + "ms 還是找不到 Deck 類別（prototype.getCost）"
      });
    }
  }, CFG.pollIntervalMs);
})();`;
}

/** 把 `getCost` 還原成遊戲原本那支。 */
export const PENALTY_UNINSTALL_EXPRESSION = `(function () {
  ${WEBPACK_REQUIRE_SNIPPET}
  try {
    var f = window.__ulrPenaltyPatch;
    if (!f || !f.installed) return "not-installed";
    var req = ulrWebpackRequire();
    if (req === null) return "not-installed";
    var mod = req(f.moduleId);
    for (var k in mod) {
      var v = mod[k];
      if (typeof v === "function" && v.prototype && v.prototype.__ulrOriginalGetCost) {
        v.prototype.getCost = v.prototype.__ulrOriginalGetCost;
        delete v.prototype.__ulrOriginalGetCost;
        try {
          var keys2 = window.game.scene.keys;
          for (var sk in keys2) {
            var so = keys2[sk] && keys2[sk].socket;
            if (!so) continue;
            var wp = Object.getPrototypeOf(so);
            if (wp.__ulrOrigFetch) { wp.fetch = wp.__ulrOrigFetch; delete wp.__ulrOrigFetch; }
            if (wp.__ulrOrigEmit) { wp.emit = wp.__ulrOrigEmit; delete wp.__ulrOrigEmit; }
            break;
          }
        } catch (e) {}
        if (f.badgeModuleId) {
          try {
            var bm = req(f.badgeModuleId);
            for (var bk in bm) {
              if (bm[bk] && bm[bk].__ulrOriginalRefresh) {
                bm[bk].refresh_penalties = bm[bk].__ulrOriginalRefresh;
                delete bm[bk].__ulrOriginalRefresh;
              }
            }
          } catch (e) {}
        }
        window.__ulrPenaltyPatch = { installed: false, moduleId: f.moduleId };
        try {
          var sc = window.game.scene.keys.Edit;
          if (sc && sc.scene.isActive()) sc.edit_reflesh();
        } catch (e) {}
        return "uninstalled";
      }
    }
    return "not-installed";
  } catch (e) { return "error: " + String((e && e.message) || e); }
})()`;
