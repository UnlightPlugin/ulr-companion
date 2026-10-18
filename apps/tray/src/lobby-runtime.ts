/**
 * 托盤的迪特赫姆快速比賽：大廳那顆按鈕按下去之後的自動配對，與「COST54:N 位玩家等待中」
 * 那幾行人數（2026-10-18 從 main.ts 整段搬出來，程式照原樣）。
 *
 * 跟 main.ts 的介面：進來的是 {@link initLobbyRuntime} 交進來的 `ctx`（profile／engine／log，
 * 每次讀都是當下的）與資料夾；出去的只有 {@link startLobbyRuntime}／{@link stopLobbyRuntime}。
 * 用到的自訂 COST 直接從 cost-rule-runtime.ts 讀（即時綁定）。
 */
/**
 * 托盤程式（WP-15）
 * ===================
 * 一個托盤圖示管**一個**遊戲客戶端。要管兩個就開兩份 —— 設定頁的「配置」
 * 那一欄按「開新實例」，或沿用舊的命令列：
 *
 *     npm run tray                      開發時預設接 **Chrome**（見 `scripts/run-tray.mjs`）
 *     npm run tray -- --kind edge       第一份 Edge 的配置
 *     npm run tray -- --kind desktop    第一份桌面版的配置
 *     npm run tray -- --profile <id>    指定配置
 *     npm run tray -- --port 9334        客戶端用固定埠啟動時（不寫 DevToolsActivePort）開臨時配置
 *
 * ⚠ **兩份要能同時活著，而 Electron 預設會擋。** 兩個關卡：
 *
 * 1. `userData` 預設是同一個目錄，兩個實例會搶同一份 cache 與 LevelDB，
 *    症狀是第二個開起來畫面空白或直接退出。→ 依配置分開（`Profile.dataDir`）。
 * 2. `requestSingleInstanceLock()` 依 userData 分開，所以擋掉的只有「同一份
 *    配置開兩份」（見下面關卡 2 的說明）。
 *
 * ⚠ **配置清單不能放在 userData 底下**（它已經依配置分開了）。見 `profiles.ts`。
 *
 * UI 只做三件事：畫 `EngineStatus`、呼叫 `setPrefs()`、維護配置清單。
 * 所有仲裁規則都在 `@ulr/arbiter-engine` 裡，跟命令列跑的是同一份。
 */

import { readFileSync, statSync } from "node:fs";
import type { ArbiterEngine } from "@ulr/arbiter-engine";
import { matchKey, queueCountUrl, QueueWatcher, ruleTag } from "@ulr/arbiter-link";
import { canAffordDuel, costTiersFor, duelApCost, ROOM_ERROR_AP_SHORT } from "@ulr/cdp-adapter";
import type {
  DuelAffordability,
  LobbyQuickPressed,
  LobbyTierCount,
  MatchContext,
} from "@ulr/cdp-adapter";
import {
  bandForTotal,
  MatchPairing,
  ROOM_MULTI,
  teamCostCenti,
  tierForTotal,
} from "@ulr/arbiter-engine";
import type { PairingStatus } from "@ulr/arbiter-engine";
import { deckFromKeys } from "@ulr/cost-engine";
import { contentHash, formatCentiCost, loadRulePackage } from "@ulr/rule-schema";
import { resolveDefaultRule } from "./default-rule.js";
import type { TierRef } from "./lobby-counts.js";
import { displayCounts, tierOf } from "./lobby-counts.js";
import { costRule, costRuleFull, costRuleHash } from "./cost-rule-runtime.js";
import type { TrayContext } from "./tray-context.js";
/** main.ts 交給快速比賽這段的東西（見 initLobbyRuntime）。 */
export interface LobbyDeps {
  ctx: TrayContext;
  /** 插件自己的資料夾（APPDATA 底下的 ulr-companion）。 */
  appDir: string;
}

let deps: LobbyDeps;
let ctx: TrayContext;

/** main.ts 一開始叫一次，之後這裡的函式才能用。 */
export function initLobbyRuntime(d: LobbyDeps): void {
  deps = d;
  ctx = d.ctx;
}

/**
 * 自動配對。**同時只會有一個** —— 一個托盤視窗管一個遊戲客戶端，
 * 而一個客戶端同時只能排一條隊。
 *
 * ⚠ **沒有一份 `pairingStatus` 快取了**（WP-18）。它以前存在只是為了餵托盤那
 * 一頁，而那一頁沒有配對狀態了 —— 玩家看的是遊戲裡的等待視窗。狀態的去處現在
 * 只有兩個：記錄檔（`onLog`）與遊戲畫面（`pushLobbyState`）。留一份沒有人讀的
 * 快取，下一個人會以為它是真相來源。
 */
let pairing: MatchPairing | null = null;

/** 我這副牌排進哪一檔。`custom` = 官方檔位裡沒有它，插件自己算的。 */
interface DeckTier {
  /** 這副牌在自訂規則下的總和，**整數百分之一**。 */
  totalCenti: number;
  /** 有上限的那一檔（官方檔位或自訂檔）。開口檔時是 `null`。 */
  costLimit: number | null;
  /** 開口檔（`COST90+`）的下限。其餘一律 `null`。 */
  costFloor: number | null;
  /** 這一檔是照牌組算出來的，官方那三檔／開口檔裡沒有它。 */
  custom: boolean;
}

/**
 * 我這副牌排進哪一檔（WP-18）。**大廳那顆按鈕與左下那幾行共用這一支。**
 *
 * ```
 *   落在官方三檔／開口檔裡 → 那一檔（跟亞城一樣，左下本來就有那一行）
 *   落在外面               → 這副牌自己那一檔（bandForTotal），左下多一行標 ★
 * ```
 *
 * ⚠ **兩個呼叫端一定要用同一支。** 一個決定「我排進哪條佇列」，另一個決定
 * 「畫面上那一行寫的是哪一檔」—— 各算各的話，症狀是人已經在排隊，而畫面上
 * 那一行永遠寫著 0。
 *
 * ⚠ 這跟 `context.deckCost`（伺服器算的原版 COST）是**兩個不同的數字**。
 * 遊戲自己的「牌組Cost限制 ±N」判的是那一個，這裡算的是自訂規則那一個。
 *
 * ⚠ 讀不到牌組回 `null`，**不是回一個 0C 的檔** —— 一個算錯的檔位會把玩家
 * 排進一條沒有人的佇列，而畫面上看起來完全正常。
 */
function myDeckTier(context: MatchContext | null, openTier: number | null): DeckTier | null {
  if (costRuleFull === null || context === null) return null;
  const keys = context.deckKeys;
  if (keys === null) return null;
  const deck = deckFromKeys(keys);
  if (deck.characters.length === 0) return null;

  const totalCenti = teamCostCenti(costRuleFull, deck);
  // ⚠ 現讀，不快取 —— 每週二遊戲更新會變（見 `costTiersFor`）。
  const tiers =
    context.channel === null ? [] : (costTiersFor(context.channels, context.channel) ?? []);
  const pick = tierForTotal(totalCenti, tiers, openTier);
  if (pick === null) {
    // 官方檔位對不上 —— 用這副牌自己那一檔。以前這裡是把玩家擋下來，理由與
    // 取捨見 `@ulr/arbiter-engine` 的 `bandForTotal`。
    return { totalCenti, costLimit: bandForTotal(totalCenti), costFloor: null, custom: true };
  }
  return {
    totalCenti,
    costLimit: pick.kind === "band" ? pick.tier : null,
    costFloor: pick.kind === "open" ? pick.tier : null,
    custom: false,
  };
}

/** 一檔在記錄檔與畫面上叫什麼 —— `COST57`、`COST90+`。 */
function tierLabel(t: { costLimit: number | null; costFloor: number | null }): string {
  if (t.costLimit !== null) return `COST${t.costLimit}`;
  if (t.costFloor !== null) return `COST${t.costFloor}+`;
  return "COST自由";
}

/**
 * 這一場排不排得下去（AP／免費對戰星星）。
 *
 * 兩個入口（大廳按鈕、托盤的配對頁）共用這一支，差別只有怎麼把答案講出來 ——
 * 大廳那條走遊戲自己的對話框（`ROOM_ERROR_AP_SHORT`），托盤那條回一句話。
 * 判準寫在 `@ulr/cdp-adapter`，兩邊都不自己算。
 */
function affordDuel(context: MatchContext): DuelAffordability {
  return canAffordDuel({
    ap: context.ap,
    duelFree: context.duelFree,
    // ⚠ 費用跟著頻道與 3vs3 走，不是常數。頻道物件自己帶（`required_ap`），
    // 讀不到才退回 `duelApCost` 那張表。
    cost:
      (ROOM_MULTI ? context.requiredAp?.multi : context.requiredAp?.single) ??
      duelApCost({ multi: ROOM_MULTI, crossplay: context.crossplay }),
  });
}

/**
 * 開始一次自動配對。**托盤的按鈕與遊戲大廳裡那顆走的是這同一支。**
 *
 * ⚠⚠ 這支會一路走到**開房**（消耗 AP 5）或**進房**（直接開打），所以它只能
 * 由玩家親手按下的動作觸發 —— 任何輪詢、重試、狀態同步都不准叫它。
 *
 * ⚠ **入口只剩一個了**（WP-18）：遊戲大廳裡那顆「快速比賽」。托盤那一頁不再
 * 有開始／停止 —— 玩家人在遊戲畫面上，而亞城那顆按鈕就在那裡。
 *
 * 檔位一律**照牌組算**（`myDeckTier`），玩家填不到。理由見
 * `profiles-core.ts` 的 `MatchPrefs`：填得跟對手不一樣會物理上配不到人。
 */
async function startPairing(args: {
  channel: number;
  costLimit: number | null;
  costFloor: number | null;
}): Promise<{ ok: true; status: PairingStatus } | { ok: false; reason: string }> {
  if (pairing !== null) return { ok: false as const, reason: "已經在配對中了。" };
  if (costRuleFull === null) {
    // 沒有規則就沒有「約定」可言 —— 那正是這個功能存在的理由。
    return { ok: false as const, reason: "自動配對要先選一份 COST 規則（自訂COST › Cost 表）。" };
  }
  const driver = await ctx.engine?.matchDriver().catch(() => null);
  if (!driver) return { ok: false as const, reason: "還沒連上遊戲" };

  // ⚠⚠ **AP 要在排隊之前擋。** 排下去之後才發現不夠的話，對手已經被配給我們、
  // 已經在等一間永遠不會開的房 —— 而玩家看到的是配對走到一半跳出「AP不足」。
  // 大廳那顆按鈕自己也擋一次（那條路要用遊戲的對話框），這裡擋的是托盤那一頁。
  const context = await driver.matchContext().catch(() => null);
  if (context !== null) {
    const afford = affordDuel(context);
    if (!afford.ok) {
      return {
        ok: false as const,
        reason: `AP 不足：現在 ${afford.ap}，開一場要 ${afford.cost}（也沒有免費對戰星星）。`,
      };
    }
  }

  // ⚠ 記下排的是哪一檔 —— 大廳那幾行要**立刻**把自己算進去（`displayCounts`），
  // 不能等下一輪去問中間人。這裡是唯一知道答案的地方。
  pairingTier = tierOf(args);

  const m = ctx.profile.match;
  const p = new MatchPairing({
    endpoint: ctx.engine?.linkEndpoint ?? "",
    rule: costRuleFull,
    channel: args.channel,
    costLimit: args.costLimit,
    costFloor: args.costFloor,
    room: {
      // ⚠ 房名不在這裡 —— 引擎照「規則名 + 檔位」自己組（`buildRoomName`）。
      // 3vs3 與遊戲自己的 ±N 也不在：兩個都是固定的（`ROOM_MULTI`、
      // `ROOM_DECK_COST_BAND`）。
      stage: m.stage,
      friend: false,
    },
    driver,
    onStatus: (s) => {
      // ⚠ 停下來就把物件放掉。留著的話玩家再按一次大廳那顆按鈕只會被當成
      // 「取消」，而他其實是想重新排一次 —— 那是最讓人以為插件壞掉的狀態。
      //
      // `idle` 跟 `blocked` 都要放：配對成功走到底（對手進房、對戰開始）
      // 之後狀態機會自己回到 idle，而那正是玩家最可能馬上想再排一次的時候。
      if (s.phase === "blocked" || s.phase === "idle") pairing = null;
      // ⚠ **遊戲畫面要立刻跟上。** 玩家人在遊戲裡，托盤視窗多半是收著的 ——
      // 而托盤那一頁本來就沒有配對狀態可以更新了（WP-18）。
      void pushLobbyState();
    },
    onLog: (line) => ctx.log(line),
  });
  pairing = p;
  await p.start();
  // ⚠ **`start()` 期間推出去的狀態不算數，回來時的 `phase` 才是真的。**
  // 這行原本只在被擋下來時清掉（`if (…) pairing = null`），於是 `start()`
  // 中途只要推出一次 idle，上面 `onStatus` 就把 `pairing` 設成 null 而**沒有
  // 人補回來** —— 排隊照跑，但玩家按「停止」是空操作（`pairing?.stop()`
  // 打在 null 上），畫面永遠停在「排隊中」。改成整個重指派，那條路就不存在。
  //
  // 開場就被擋下來（沒在大廳、牌組超標…）的話不要留著一個死掉的物件，
  // 否則玩家改好之後再按會收到「已經在配對中了」。
  pairing = p.status.phase === "idle" || p.status.phase === "blocked" ? null : p;
  return { ok: true as const, status: p.status };
}

// ---------------------------------------------------------------------------
// 迪特赫姆的快速比賽（WP-17）
// ---------------------------------------------------------------------------

/**
 * 看一眼玩家在不在大廳的節奏。**這一拍不發任何網路請求** —— 它只問頁面
 * （兩次 CDP evaluate），成本跟中間人無關。
 *
 * ⚠ 這個數字決定的是「剛進頻道多久看得到人數」與「按下去多久看得到自己」。
 * 15 秒那個是**問中間人**的節奏，兩者刻意分開：玩家抱怨的「不像亞城那樣
 * 立即反應」全部落在這一拍上，而把中間人那一拍一起調快是要付錢的。
 */
const LOBBY_TICK_MS = 3_000;

/**
 * **問中間人**「各檔幾個人在等」的最短間隔。
 *
 * ⚠ **這是輪詢，所以它的成本是「玩家坐在大廳的時間 ÷ 這個數字」**，跟對戰
 * 次數無關 —— docs/match-making.md 那張 43,200 vs 1,440 的表就是這件事。
 * 15 秒 = 一小時 240 次，而一個請求就問完所有檔位（`queueCountUrl`）。
 *
 * ⚠ 只有在**玩家真的在 duel 頻道的大廳裡**才會發（`buttonReady`），
 * 打牌中、選單裡、沒開遊戲都不會。
 */
const LOBBY_COUNT_MS = 15_000;

/**
 * **推播接得上的時候**，多久還是去問一次 `/qn`。
 *
 * ⚠ 推播已經是即時的了，這一拍純粹是保險：一條**開著但對面已經不在**的
 * WebSocket 在 Windows 上是真的會發生的（DO 被搬走、NAT 把連線收掉），而它
 * 的症狀是人數停在某個數字不動 —— 跟「真的沒人」長得一模一樣。
 *
 * 兩分鐘一次 = 一小時 30 次，是輪詢版本（240 次）的八分之一。
 */
const LOBBY_COUNT_PUSH_MS = 120_000;

/**
 * 推播來了之後多久換一次畫面。**合併用的，不是延遲。**
 *
 * 四檔會各自推自己的，而一個人從 COST54 換到 COST61 會讓兩檔同時變 ——
 * 每一則都換一次畫面等於兩趟 CDP 白跑。
 */
const LOBBY_PUSH_DEBOUNCE_MS = 120;

let lobbyTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 每一條佇列最新的人數（**兩條來源共用這一格**：推播與輪詢）。
 *
 * ⚠ 只拿來在「這次問不到」時**不要**把畫面洗成空的 —— 舊數字比沒有數字好。
 */
const lobbyByKey = new Map<string, number>();
/** 現在畫面上是哪幾檔（順序就是畫面的順序）。 */
let lobbySpecs: TierSpec[] = [];
/** 推播的線。`null` = 還沒開過（進大廳才會開）。 */
let lobbyWatcher: QueueWatcher | null = null;
/** `lobbyWatcher` 是連著哪一台中間人開的。玩家改了位址就要整組重來。 */
let lobbyWatchEndpoint = "";
/** 合併推播用的計時器，見 `lobbyPushSoon()`。 */
let lobbyPushTimer: ReturnType<typeof setTimeout> | null = null;
/** 上一次真的問中間人是什麼時候。0 = 還沒問過。 */
let lobbyCountsAt = 0;
/**
 * **問那一次的當下，我自己排在哪一檔。** `null` = 那時沒在排。
 *
 * 拿來跟現在比對 —— 差別就是「這個數字還沒把我算進去／已經不該算我了」，
 * 見 `countsForDisplay()`。
 */
let lobbyCountsSelf: TierRef | null = null;
/** 上一拍玩家在不在 duel 大廳。false → true 就是「他剛進頻道」。 */
let lobbyReady = false;

/**
 * 最近一次排的是哪一檔。**只有 `pairing !== null` 的時候才算數**，
 * 所以永遠透過 `selfTier()` 讀，不要直接讀這一格。
 */
let pairingTier: TierRef | null = null;

/**
 * 我**現在**排在哪一檔。`null` = 沒在排。
 *
 * ⚠ 寫成函式而不是一格變數，是因為 `pairing` 有四個地方會被設成 null
 * （按取消、狀態機回到 idle、被擋下來、關掉插件）。多一格要自己同步的狀態
 * 就是多一個會忘記清的地方，而忘了清的症狀是「明明沒排隊，那一檔卻永遠
 * 多一個人」—— 那正是這整段要修掉的那種假數字。
 */
function selfTier(): TierRef | null {
  return pairing === null ? null : pairingTier;
}

/**
 * 把等待人數與配對狀態推到遊戲畫面上。
 *
 * ⚠ **問不到人數時要保留上一次的數字，不要推 `null`。** 中間人抖一下就把
 * 那三行清掉的話，玩家看到的是「人數忽有忽無」—— 而那比慢個 15 秒難懂得多。
 *
 * ⚠⚠ **不是每一拍都去問中間人。** 這支同時掛在配對狀態的 `onStatus` 上，而
 * 一次配對從按下去到開打會推十幾次狀態 —— 每一次都問的話，那十幾個 HTTP
 * 請求全部發生在最不需要更新人數的那幾秒。真的發請求只有三種時候：
 *
 * ```
 *   force        玩家剛按下快速比賽／取消 —— 那一檔的數字馬上就不一樣了
 *   剛進大廳     ⚠ 少了這條，玩家進頻道會先看到**空白**，最久等 15 秒
 *   距上次 15 秒 穩定狀態的節奏
 * ```
 */
async function pushLobbyState(options: { refreshCounts?: boolean } = {}): Promise<void> {
  if (ctx.engine === null) return;
  const status = await ctx.engine.lobbyStatus();
  if (status === null || !status.buttonReady) {
    lobbyReady = false;
    // ⚠ 人不在大廳就把推播的線收掉。連著不看是**白付的連線** —— 而且玩家
    // 打一場牌可以是二十分鐘，那二十分鐘裡沒有任何人會看那幾行字。
    stopLobbyWatch();
    return;
  }
  // ⚠ 「剛進頻道」要當場問一次。這是玩家回報的第二句：進頻道時那幾行是空的，
  // 要等一陣子才出現 —— 因為第一次問是排在下一個 15 秒的節拍上。
  const entered = !lobbyReady;
  lobbyReady = true;

  // ⚠ 用的不是預設那份 COST 表就不顯示，理由見這一段的段首註解。
  if (costRuleHash === null || costRuleHash !== defaultRuleHash()) {
    stopLobbyWatch();
    lobbySpecs = [];
    lobbyByKey.clear();
    // ⚠ 人數藏起來，**標記還是要送** —— 排隊中的那個框在哪一檔，跟「這台機器
    // 該不該看到人數」是兩件事。
    await ctx.engine.setLobbyState({
      counts: null,
      matching: pairing !== null,
      badge: matchingBadge(),
    });
    return;
  }

  // ⚠ 算不出來（CDP 逾時、還沒讀到頻道）時**留著上一組** —— 那幾行不該因為
  // 一次讀取失敗就消失。真的換頻道時下一拍就會算出新的一組。
  const specs = await tierSpecs(status.openTier);
  if (specs !== null) setLobbySpecs(specs);

  // ⚠⚠ **推播接得上就不必一直問。** 這一格就是這次改動省下來的錢：接得上時
  // 兩分鐘問一次（純保險），接不上時退回原本的 15 秒。
  const interval = lobbyWatcher?.allLive === true ? LOBBY_COUNT_PUSH_MS : LOBBY_COUNT_MS;
  const due = Date.now() - lobbyCountsAt >= interval;
  if (lobbySpecs.length > 0 && (options.refreshCounts === true || entered || due)) {
    const self = selfTier();
    const byKey = await fetchTierCounts(lobbySpecs);
    if (byKey !== null) {
      for (const spec of lobbySpecs) {
        const waiting = byKey.get(spec.key);
        if (waiting !== undefined) lobbyByKey.set(spec.key, waiting);
      }
      lobbyCountsAt = Date.now();
      // ⚠ 記的是**發出請求那一刻**的狀態，不是回來時的 —— 玩家可能在這幾百
      // 毫秒之間按了取消，那樣這份數字裡的「我」就該被扣掉。
      lobbyCountsSelf = self;
    }
  }

  await ctx.engine.setLobbyState({
    // ⚠ 推出去的不是中間人那份原始數字，是**把「我自己」放到對的位置之後**
    // 的那一份。理由整段寫在 `lobby-counts.ts` 的檔頭。
    counts: withoutEmptyCustom(
      displayCounts({
        counts: currentCounts(),
        fetchedWhileIn: lobbyCountsSelf,
        nowIn: selfTier(),
      }),
    ),
    // ⚠ 配對中就跳**遊戲自己的等待視窗**（有計時、有 cancel），不是在 INFO
    // 那一區多寫一行字 —— 亞城按下快速比賽之後跳的就是那個框。
    matching: pairing !== null,
    badge: matchingBadge(),
  });
}

/**
 * 自訂檔那一行**沒有人在等就拿掉**（玩家 2026-08-21 的決定）。
 *
 * 官方那幾行寫 0 是有意義的（「這一檔現在沒人」是一句關於頻道的話），自訂檔
 * 不是 —— 它是「**我**這副牌這一檔」，而那一檔本來就只有壓到同一格的人排得
 * 進來。一行永遠寫著 0 的字只是把玩家的注意力留在一個他改不了的數字上。
 *
 * ⚠ 我自己排著的時候一定 ≥ 1（`displayCounts` 保證），所以這條規則不會把
 * 「我正在排隊」那一行藏掉。
 */
function withoutEmptyCustom(counts: LobbyTierCount[] | null): LobbyTierCount[] | null {
  if (counts === null) return null;
  return counts.filter((c) => c.custom !== true || c.waiting > 0);
}

/**
 * 等待視窗上那一行標記 —— `★ COST48 · 夾擠式罰C`。沒在排隊是 `null`。
 *
 * ⚠ **這是自訂檔唯一看得見的地方。** 左下那幾行寫的是官方階層，而自訂檔在
 * 那份模板裡沒有位置（見 `patch-lobby.ts` 的 `LobbyState.badge`）。少了這一行，
 * 玩家排在一個他從頭到尾沒看過的數字上。
 *
 * 規則名跟著一起寫：同一台機器可以換規則，而換了規則就是換一條佇列。
 */
function matchingBadge(): string | null {
  if (pairing === null || pairingTier === null) return null;
  const tier = pairingTier.open ? `COST${pairingTier.tier}+` : `COST${pairingTier.tier}`;
  const name = costRule?.name ?? null;
  return name === null ? `★ ${tier}` : `★ ${tier} · ${name}`;
}

// ---------------------------------------------------------------------------
// 「COST54:N 位玩家等待中」那幾行
//
// ⚠⚠ **只有用預設 COST 表的人才有這幾行數字**（玩家 2026-08-20 的決定）。
// 用別份規則的人看不到 —— 那不是壞掉，是那個數字對他沒有意義：他排的是
// 一條只有他自己那份規則算得出來的隊，而中間人數的是「跟預設表同一份」的人。
//
// ⚠⚠ **判準是「內容一不一樣」，不是「他從哪裡選的」。** 2026-08-20 實測到
// 差別：玩家的 `costRuleMode` 是 `file`，指著 `rules/…-1C.ulrcost.json`，
// 而那個檔的 contentHash 跟安裝包裡那份**一模一樣** —— 他排的是同一條佇列、
// 數的是同一群人，用「來源」去擋只會把一個完全正常的玩家的人數藏起來。
//
// ⚠ 數的範圍也跟著窄了一層：中間人只數**規則內容跟我一模一樣**的人
// （`ruleTag`）。同一條佇列上站著別份規則的人是常態（配對鍵裡沒有版本），
// 而他們配不配得到要看驗算 —— 寫「1 位玩家等待中」卻永遠配不到，比寫 0 還糟。
//
// 數字有兩條來源，**推播是主要的、輪詢是退路**：
//
//   QueueWatcher   `q-watch` → 中間人一有人進出就推 `q-count`（即時）
//   /qn            接不上推播時的退路，外加一個很慢的保險節奏
// ---------------------------------------------------------------------------

/**
 * 「插件附的預設 COST 表」的 contentHash。**兩份都不在就回 `null`。**
 *
 * ⚠ 用 mtime 當快取鍵：這支每三秒會被叫一次，而每次重讀 28KB 再 hash 一遍
 * 是白做的。中間人發下新的一份時（`rule-feed.ts` 寫檔）mtime 會變，快取自己
 * 就過期了 —— 少了這一格的話，玩家會停在「舊的預設表」的判斷上，而症狀是
 * 更新之後人數突然消失。
 */
let defaultRuleHashCache: { path: string; mtimeMs: number; hash: string } | null = null;
function defaultRuleHash(): string | null {
  const choice = resolveDefaultRule(deps.appDir);
  if (choice === null) return null;
  try {
    const mtimeMs = statSync(choice.path).mtimeMs;
    const cached = defaultRuleHashCache;
    if (cached !== null && cached.path === choice.path && cached.mtimeMs === mtimeMs) {
      return cached.hash;
    }
    const result = loadRulePackage(JSON.parse(readFileSync(choice.path, "utf8")));
    if (!result.ok) return null;
    defaultRuleHashCache = { path: choice.path, mtimeMs, hash: result.value.contentHash };
    return result.value.contentHash;
  } catch {
    // 讀不到就當成「沒有預設表可比」= 不顯示人數。⚠ 不能反過來當成「都算」——
    // 那會讓一台讀不到規則的機器把所有人的數字都畫出來。
    return null;
  }
}

/** 一檔在中間人那邊的身分：配對鍵，加上「我這份規則」在那條佇列上的標籤。 */
interface TierSpec {
  tier: number;
  open: boolean;
  /**
   * 這是**自訂檔**嗎 —— 我這副牌算出來落在官方階層之外，插件自己開的那一檔。
   *
   * ⚠ 它跟官方那幾檔**不是同一種東西**：官方那三檔是「這個頻道有這幾條佇列」，
   * 自訂檔是「**我**這副牌現在排在這一條」。換一副牌就換一條，所以它會跟著
   * 牌組變（`setLobbySpecs` 認鍵，換了就重訂閱）。
   *
   * ⚠ 成本：它是**第五把鍵**，也就是大廳裡多一條推播連線（`QueueWatcher` 一把
   * 鍵一條），而玩家在遊戲裡換牌組時那條會重連一次。`/qn` 那邊沒問題 ——
   * 一個請求問完所有鍵，而中間人的上限是 8（`MAX_COUNT_KEYS`）。
   */
  custom: boolean;
  key: string;
  /** `ruleTag(key, contentHash(規則))`。⚠ **拌過配對鍵，所以一檔一個。** */
  tag: string;
}

/**
 * 這個頻道現在有哪幾檔，各自的配對鍵與規則標籤是什麼。
 *
 * ⚠ 鍵是**這裡自己算的**（`matchKey`），跟真的去排隊時算的是同一支函式 ——
 * 兩邊各算一次的話，某一天其中一邊改了欄位就會變成「人數永遠 0，但排得到人」。
 *
 * ⚠ 回 `null` 是**這一次算不出來**（還沒接上遊戲、讀不到頻道），不是「這個
 * 玩家不該看到人數」—— 後者由呼叫端先擋掉（規則內容跟預設那份不一樣）。
 * 兩者混在一起的話，遊戲畫面會在一次 CDP 逾時之後把那幾行清空。
 *
 * ⚠ **最後可能多一檔**：我這副牌落在官方階層之外時（WP-18），那一檔在畫面上
 * 沒有自己的一行 —— 而那正是玩家要看的那一行。見 `myDeckTier`。
 */
async function tierSpecs(openTier: number | null): Promise<TierSpec[] | null> {
  if (costRuleFull === null || ctx.engine === null) return null;
  const driver = await ctx.engine.matchDriver().catch(() => null);
  if (!driver) return null;

  let context: MatchContext;
  try {
    context = await driver.matchContext();
  } catch {
    return null;
  }
  const channel = context.channel;
  if (channel === null) return null;
  // ⚠ 現讀，不快取 —— 每週二遊戲更新會變（見 `costTiersFor`）。
  const tiers = costTiersFor(context.channels, channel) ?? [];

  // 我這副牌排在哪一檔。官方階層裡有的話下面那幾行本來就會畫到它，只有落在
  // 外面時才要多開一條。
  const mine = myDeckTier(context, openTier);
  const custom = mine !== null && mine.custom && mine.costLimit !== null ? mine.costLimit : null;
  if (tiers.length === 0 && openTier === null && custom === null) return null;

  const ruleSetId = costRuleFull.ruleSetId;
  const ruleHash = costRuleHash ?? contentHash(costRuleFull);
  const keyed = [
    ...tiers.map((tier) => ({
      tier,
      open: false,
      custom: false,
      key: matchKey({ ruleSetId, channel, multi: ROOM_MULTI, costLimit: tier }),
    })),
    ...(openTier === null
      ? []
      : [
          {
            tier: openTier,
            open: true,
            custom: false,
            key: matchKey({
              ruleSetId,
              channel,
              multi: ROOM_MULTI,
              costLimit: null,
              costFloor: openTier,
            }),
          },
        ]),
    ...(custom === null
      ? []
      : [
          {
            tier: custom,
            open: false,
            custom: true,
            key: matchKey({ ruleSetId, channel, multi: ROOM_MULTI, costLimit: custom }),
          },
        ]),
  ];
  return keyed.map((s) => ({ ...s, tag: ruleTag(s.key, ruleHash) }));
}

/**
 * 問中間人「這幾檔各有幾個人在等」。**這是退路，不是主要的路** ——
 * 主要的路是推播（`QueueWatcher`），這支只在推播接不上時撐著。
 *
 * ⚠ 回傳是「鍵 → 人數」而不是畫面用的那個陣列：推播來的也是一次一個鍵，
 * 兩條路要餵進同一格狀態，否則畫面會在兩份數字之間跳。
 */
async function fetchTierCounts(specs: readonly TierSpec[]): Promise<Map<string, number> | null> {
  if (ctx.engine === null || specs.length === 0) return null;
  try {
    // ⚠ 標籤是**一把鍵一個**（`ruleTag` 拌過配對鍵），不是共用一個 —— 傳一個
    // 配四把的話三檔會永遠數到 0，而且沒有任何錯誤訊息。
    const url = queueCountUrl(ctx.engine.linkEndpoint, {
      keys: specs.map((s) => s.key),
      tags: specs.map((s) => s.tag),
    });
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { counts?: { key?: string; waiting?: number }[] };
    return new Map((body.counts ?? []).map((c) => [c.key ?? "", c.waiting ?? 0]));
  } catch {
    // 中間人連不上／舊版沒有這條路由 → 這次沒有人數。**不是錯誤**，
    // 按鈕照樣能按（配對本身走的是另一條路）。
    return null;
  }
}

/**
 * 現在畫面上那幾行的數字（**還沒把「我」算進去**，那是 `displayCounts` 的事）。
 *
 * ⚠ 一個鍵都還沒有答案時回 `null`（= 那幾行整個不畫）。有部分答案就照畫、
 * 缺的當 0 —— 一檔問不到就把四檔全部藏起來，比顯示一個 0 難懂得多。
 */
function currentCounts(): LobbyTierCount[] | null {
  if (lobbySpecs.length === 0) return null;
  if (!lobbySpecs.some((s) => lobbyByKey.has(s.key))) return null;
  return lobbySpecs.map((s) => ({
    tier: s.tier,
    waiting: lobbyByKey.get(s.key) ?? 0,
    ...(s.open ? { open: true } : {}),
    ...(s.custom ? { custom: true } : {}),
  }));
}

/** 現在要看哪幾檔。**一樣就什麼都不做** —— 這支每三秒會被叫一次。 */
function setLobbySpecs(specs: readonly TierSpec[]): void {
  const same =
    lobbySpecs.length === specs.length &&
    lobbySpecs.every((s, i) => {
      const t = specs[i];
      return t !== undefined && s.key === t.key && s.tag === t.tag && s.tier === t.tier;
    });
  if (same) {
    startLobbyWatch();
    return;
  }
  lobbySpecs = [...specs];
  // ⚠ 換頻道／換規則之後，舊鍵的數字對現在這個畫面沒有意義。留著的話玩家會
  // 在切頻道的瞬間看到上一個頻道的人數，而那個數字看起來完全合理。
  const keys = new Set(lobbySpecs.map((s) => s.key));
  for (const key of [...lobbyByKey.keys()]) if (!keys.has(key)) lobbyByKey.delete(key);
  // 逼下一拍去問一次（推播接得上的話它會先到，這只是保險）。
  lobbyCountsAt = 0;
  startLobbyWatch();
}

/**
 * 把推播的線接上（或換成新的一組鍵）。
 *
 * ⚠ 中間人的位址換了就要整個重來 —— `QueueWatcher` 的 endpoint 是建構時
 * 決定的，而玩家在設定裡改位址之後，舊的那幾條線還連在舊的中間人上。
 */
function startLobbyWatch(): void {
  if (ctx.engine === null || lobbySpecs.length === 0) return;
  const endpoint = ctx.engine.linkEndpoint;
  if (lobbyWatcher !== null && lobbyWatchEndpoint !== endpoint) {
    lobbyWatcher.stop();
    lobbyWatcher = null;
  }
  if (lobbyWatcher === null) {
    lobbyWatchEndpoint = endpoint;
    lobbyWatcher = new QueueWatcher({
      endpoint,
      onCount: (key, waiting) => {
        lobbyByKey.set(key, waiting);
        // ⚠ 記下「收到這個數字的當下我排在哪一檔」，理由同輪詢那條路：
        // 這一份可能還沒把我算進去（我的 `q-hello` 還在飛）。
        lobbyCountsSelf = selfTier();
        lobbyPushSoon();
      },
      onLog: (line) => ctx.log(line),
    });
  }
  lobbyWatcher.setTargets(lobbySpecs.map((s) => ({ key: s.key, tag: s.tag })));
}

/** 離開大廳、或不該顯示人數了。**連著不看是白付的連線。** */
function stopLobbyWatch(): void {
  lobbyWatcher?.stop();
  if (lobbyPushTimer !== null) clearTimeout(lobbyPushTimer);
  lobbyPushTimer = null;
}

/**
 * 推播來了 → 盡快把畫面更新一次。
 *
 * ⚠ 要合併：四檔同時變（一個人從 COST54 換到 COST61）會連著來兩三則，而
 * `pushLobbyState()` 每一次都是兩趟 CDP。合併之後那一串只換一次畫面，
 * 而玩家眼裡仍然是「立刻」。
 */
function lobbyPushSoon(): void {
  if (lobbyPushTimer !== null) return;
  lobbyPushTimer = setTimeout(() => {
    lobbyPushTimer = null;
    void pushLobbyState();
  }, LOBBY_PUSH_DEBOUNCE_MS);
}

/**
 * 玩家按了遊戲大廳裡那顆「快速比賽」。
 *
 * ```
 *   在配對中 → 停止（那顆按鈕同時是取消鍵，亞城的等待視窗也是這樣）
 *   否則     → 讀牌組 → 算它落在哪一檔 → 排進那一檔
 *              算不出來 → 跳遊戲自己的「這個牌組不符合遊戲規則」
 * ```
 *
 * ⚠ **檔位是算出來的，不是玩家選的。** 亞歷山卓城的快速比賽就是這樣：按下去
 * 之後伺服器照你的牌組把你放進某一檔。托盤那一頁**也沒有那一格了**（WP-18）
 * —— 兩個入口填出不一樣的數字時，兩邊都只寫著「排隊中」而永遠配不到。
 */
async function onLobbyQuick(press: LobbyQuickPressed): Promise<void> {
  if (ctx.engine === null) return;

  // 再按一次 = 取消。⚠ 一定要有這條路：玩家人在遊戲裡，托盤視窗多半收著，
  // 而「排了隊之後只能去托盤按停止」等於這顆按鈕只做了一半。
  if (pairing !== null) {
    await pairing.stop();
    pairing = null;
    ctx.log("· 已停止自動配對（大廳按鈕）");
    // ⚠ **這裡刻意不重問中間人。** 我剛剛才把線關掉，而那條線在對面消失是
    // 非同步的 —— 馬上問回來的答案有很高機率**還把我算在裡面**，於是畫面會
    // 從「1」跳成「1」，看起來就是按了取消卻沒反應。
    //
    // 推播接得上時這件事更乾淨：`q-cancel` 一到中間人就會推一則新的 `q-count`
    // 回來，而那一則是**真的**已經把我扣掉的數字。
    //
    // 不問反而是對的：`countsForDisplay()` 知道「上一次問的時候我在那一檔、
    // 現在不在了」，直接扣掉 —— 那個數字立刻正確，而且下一輪（最多 15 秒）
    // 拿到的新答案會接手。
    await pushLobbyState();
    return;
  }

  if (costRuleFull === null) {
    await ctx.engine.showLobbyError(null, "插件還沒載入 COST 表，先到托盤的「Cost 表」看一下。");
    return;
  }

  const driver = await ctx.engine.matchDriver().catch(() => null);
  if (!driver) return;
  const context = await driver.matchContext().catch(() => null);
  if (context === null) return;

  const channel = press.channel ?? context.channel;
  if (channel === null) {
    await ctx.engine.showLobbyError(null, "請先進入一個頻道。");
    return;
  }

  // ⚠ 迪城借亞城的 COST 檔位（布萊德借峰亥盧），而那份頻道清單只在玩家經過頻道
  // 選單時看得到（插件搭遊戲自己那一次請求記下來，不另外問）。插件比遊戲晚接上時
  // 就會缺 —— 缺著排下去會排進自訂檔，跟同一副牌、知道檔位的人配不到，而兩邊都
  // 只寫著「排隊中」。所以擋下來、講清楚怎麼補。
  if (costTiersFor(context.channels, channel) === null) {
    await ctx.engine.showLobbyError(null, "讀不到這個頻道的 COST 檔位 —— 退回頻道選單再進來一次。");
    return;
  }

  // ⚠⚠ **AP 要在排隊之前擋，不是等開房才知道。** 排下去之後才發現不夠的話，
  // 對手已經被配給我們、已經在等一間永遠不會開的房 —— 而玩家看到的是配對
  // 走到一半跳出「AP不足」。這一關擋掉的正是玩家 2026-08-19 回報的那個畫面。
  //
  // 有星星就不吃 AP（右下角那三顆 ★），所以兩個條件是「或」不是「且」。
  const afford = affordDuel(context);
  if (!afford.ok) {
    // 遊戲自己那句「AP不足」—— 跟他手動開房不夠時看到的一模一樣。
    await ctx.engine.showLobbyError(ROOM_ERROR_AP_SHORT);
    ctx.log(`· 大廳快速比賽被擋下：AP ${afford.ap}／需要 ${afford.cost}，而且沒有免費對戰星星`);
    return;
  }

  const status = await ctx.engine.lobbyStatus();
  const mine = myDeckTier(context, status?.openTier ?? null);
  if (mine === null) {
    // ⚠ 這裡**只剩「讀不到牌組」**這一種擋法了。以前還有「牌組不在任何一檔裡」
    // （`room_error[7]`），而那條路現在走 `bandForTotal` —— 自訂規則算出來的
    // 數字本來就沒有義務落在伺服器的官方階層上。
    await ctx.engine.showLobbyError(null, "讀不到你的牌組，切一次牌組再試。");
    return;
  }

  const result = await startPairing({
    channel,
    costLimit: mine.costLimit,
    costFloor: mine.costFloor,
  });
  if (!result.ok) {
    await ctx.engine.showLobbyError(null, result.reason);
    return;
  }
  ctx.log(
    `▶ 大廳快速比賽：牌組 ${formatCentiCost(mine.totalCenti)}C → ${tierLabel(mine)}` +
      `${mine.custom ? "（自訂檔）" : ""}` +
      `（${afford.byStar ? "用免費對戰星星" : `AP ${context.ap ?? "?"}／需要 ${afford.cost}`}）`,
  );
  // 剛排進去，這一檔的人數就多了自己一個。
  // ⚠ 推播接得上時**不必重問** —— 我的 `q-hello` 會讓中間人立刻推一則新的
  // `q-count` 回來（我自己也是那條佇列的「看的人」）。多問這一次不只是白花
  // 一個請求，還很可能問在 `q-hello` 還在飛的那一刻，答案裡沒有我。
  await pushLobbyState({ refreshCounts: lobbyWatcher?.allLive !== true });
}

// ---------------------------------------------------------------------------
// main.ts 叫的（以前它直接改這裡的計時器與 pairing）
// ---------------------------------------------------------------------------

/**
 * 新的引擎建好了：掛上大廳按鈕與人數那一拍。
 *
 * ⚠ 大廳那顆「快速比賽」是**玩家親手按的**，跟托盤上那顆一樣會開房消耗 AP —— 所以它掛在
 * 點擊事件上，不掛在任何輪詢裡。
 * ⚠ 人數那一拍只是「看一眼」，不等於一個 HTTP 請求 —— 真的去問中間人的節奏由
 * `pushLobbyState()` 自己把關（`LOBBY_COUNT_MS`，外加「剛進頻道」那一次）。只有玩家真的
 * 坐在 duel 頻道的大廳時才會送請求。
 */
export function startLobbyRuntime(engine: ArbiterEngine): void {
  engine.onLobbyQuick((press) => void onLobbyQuick(press));
  lobbyTimer = setInterval(() => void pushLobbyState(), LOBBY_TICK_MS);
}

/**
 * 關程式：停掉人數那一拍、收掉推播線，排隊中的話把自己從佇列上拿掉。
 *
 * ⚠ 推播線不收的話 Electron 退不乾淨（那幾條 socket 還活著）。
 * ⚠ 排隊中就關掉插件的話，要先把自己從佇列上拿掉、順手收掉開了一半的房 —— 否則對手會一直等
 * 一間永遠不會出現的房，而玩家的頻道上留一間空房。
 */
export async function stopLobbyRuntime(): Promise<void> {
  if (lobbyTimer !== null) clearInterval(lobbyTimer);
  lobbyTimer = null;
  stopLobbyWatch();
  await pairing?.stop().catch(() => {});
  pairing = null;
}
