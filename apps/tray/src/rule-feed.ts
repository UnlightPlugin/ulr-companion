/**
 * 預設 COST 規則的自動更新
 * ==========================
 * `updater.ts` 的同胞：同一把公鑰、同一套正規化、同一條「只往新版走」的規則，
 * 但更新的是**規則**而不是程式。分成兩條的理由見 `DEFAULT_RULE_FEED` 的註解 ——
 * 改一張卡的定價不該讓每個玩家下載 82 MB。
 *
 * ```
 *   驗簽章 → 只往新版走 → 同一族才收 → 內容過 schema → 才寫進快取
 * ```
 *
 * 每一道擋的是不同的東西：
 *
 * | 關卡         | 擋什麼                                                     |
 * | ------------ | ---------------------------------------------------------- |
 * | 簽章         | **發布伺服器被入侵**（內容自己說自己沒問題是沒有用的）      |
 * | 只往新版走   | **重播舊清單**（舊簽章永遠有效）                            |
 * | 同一族才收   | 手滑把別人的規則發成預設 —— 那會**換掉玩家排在哪條佇列**    |
 * | schema       | 簽對了但內容壞掉 → 落地之後每次開機都失敗一次，而且看不出來 |
 *
 * ⚠ **沒有公鑰就整支不啟動**，跟 `updater.ts` 同一條理由：沒有信任根時正確的
 * 行為是不更新，不是「先相信伺服器再說」。
 */

import { renameSync, writeFileSync } from "node:fs";
import { loadRulePackage } from "@ulr/rule-schema";
import { DEFAULT_RULE_FEED } from "@ulr/arbiter-link";
import { cachedRulePath, cachedRuleVersion, ensureRuleDir } from "./default-rule.js";
import { UPDATE_PUBLIC_KEY } from "./update-key.js";
import type { RuleManifest } from "./update-verify.js";
import { isNewerVersion, verifySignedRuleFeed } from "./update-verify.js";

/** 多久檢查一次。跟程式的自動更新同一個節奏 —— 這不是需要即時的東西。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 開起來先等一下。⚠ 比 `updater.ts` 晚 30 秒，兩支不要同時發請求。 */
const FIRST_CHECK_DELAY_MS = 90 * 1000;

/** 環境變數可以覆蓋（開發時指到本機的假 feed），但**一定有預設值**。 */
const FEED_ENV = "ULR_RULE_FEED";

/**
 * 規則清單的大小上限。目前約 30 KB，1 MB 給了三十倍餘裕。
 *
 * ⚠ 這一道跟安裝檔那道是同一個理由：`json()` 會把整個回應讀進記憶體，而
 * 沒有上限的話一個壞掉（或惡意）的來源可以送一個無限長的串流把記憶體吃光。
 */
const MAX_FEED_BYTES = 1024 * 1024;

export interface RuleFeedOptions {
  /** `%APPDATA%\ulr-companion`。快取寫在它底下的 `rules\`。 */
  appDir: string;
  /**
   * 只收這一族的規則。**這是「別人不能替我換規則」的那一道。**
   *
   * ⚠ 傳 `null` 代表「還不知道」（預設規則載入失敗時），那時整支不做事 ——
   * 沒有基準的話「同一族」這個檢查等於不存在。
   */
  ruleSetId: string | null;
  /**
   * 現在載著的那份預設規則是哪一版。**沒有快取時的比較基準就是它**
   * （安裝包裡那份）—— 少了它，第一次檢查會把一份比安裝包還舊的規則收下來。
   */
  currentVersion: string | null;
  /** 新規則寫好之後叫這支。回傳 `true` = 已經套用（呼叫端會記錄）。 */
  onRule: (manifest: { version: string; path: string; notes?: string }) => void;
  onLog?: (line: string) => void;
}

/**
 * 啟動規則自動更新。回傳一個停掉它的函式。
 *
 * **永遠不會 throw。** 檢查失敗只是「這次沒更新」—— 玩家手上那份仍然能用，
 * 而讓插件因為一次網路錯誤就出事是完全不成比例的。
 */
export function startRuleFeed(options: RuleFeedOptions): () => void {
  const log = (line: string): void => options.onLog?.(line);

  if (UPDATE_PUBLIC_KEY.length === 0) {
    log("（沒有發布公鑰，預設 COST 表的自動更新未啟動）");
    return () => {};
  }

  const override = process.env[FEED_ENV];
  const feed = override !== undefined && override.length > 0 ? override : DEFAULT_RULE_FEED;

  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const applied = await checkOnce(feed, options);
      if (applied !== null) options.onRule(applied);
    } catch (err) {
      // 「靜默」不包括錯誤。查不到原因的失敗比失敗本身麻煩。
      log(`✗ 檢查預設 COST 表失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const first = setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * 檢查一次。**有更新才回傳東西**，其餘（沒發過、不是新版、驗不過）都回 `null`。
 *
 * 匯出是為了測試與「立刻檢查一次」那顆按鈕 —— 它沒有任何計時器狀態。
 */
export async function checkOnce(
  feed: string,
  options: RuleFeedOptions,
): Promise<{ version: string; path: string; notes?: string } | null> {
  const log = (line: string): void => options.onLog?.(line);
  // ⚠ 沒有基準規則族就不做事，見 `ruleSetId` 的說明。
  if (options.ruleSetId === null) return null;

  const res = await fetch(feed, { headers: { accept: "application/json" } });
  // 404 = 還沒發過任何一份預設規則。正常狀態，不是錯誤。
  if (!res.ok) return null;

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    throw new Error(`規則清單太大（宣稱 ${Math.round(declared / 1024)} KB）`);
  }
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) {
    throw new Error(`規則清單太大（實際 ${Math.round(text.length / 1024)} KB）`);
  }

  // ⚠ **驗章在讀任何欄位之前。** 先比版本再驗章的話，一份沒簽的清單仍然能
  // 控制流程要不要往下走。
  const manifest = verifySignedRuleFeed(JSON.parse(text), UPDATE_PUBLIC_KEY);
  if (manifest === null) {
    // ⚠ 這一行要看得見：它要嘛是發布流程出錯，要嘛是有人在冒充發布來源。
    log("✗ 預設 COST 表的簽章驗不過，已忽略這一份");
    return null;
  }

  // ⚠⚠ **同一族才收。** 少了這一關，發布端一個手滑（或一次入侵）就能把每個
  // 玩家的預設規則換成另一族 —— 而規則族**進配對鍵**，症狀是所有人一起換到
  // 另一條佇列上，畫面上完全看不出來。
  if (manifest.ruleSetId !== options.ruleSetId) {
    log(`✗ 預設 COST 表的規則族不對（收到 ${manifest.ruleSetId}），已忽略`);
    return null;
  }

  // ⚠ **只往新的走。** 舊清單的簽章永遠有效，「版本不一樣就換」對重播毫無
  // 抵抗力。比的是快取那份 —— 沒有快取時比的是安裝包那份（呼叫端傳進來）。
  const current = cachedRuleVersion(options.appDir) ?? options.currentVersion;
  if (current !== null && !isNewerVersion(manifest.version, current)) return null;

  const path = writeRuleCache(options.appDir, manifest);
  log(
    `✓ 預設 COST 表更新到 ${manifest.version}${manifest.notes === undefined ? "" : `：${manifest.notes}`}`,
  );
  return {
    version: manifest.version,
    path,
    ...(manifest.notes === undefined ? {} : { notes: manifest.notes }),
  };
}

/**
 * 把驗過的規則寫進快取。**先寫暫存檔再改名**（原子替換）。
 *
 * ⚠ 直接寫目標檔的話，寫到一半斷電／被防毒中斷會留下一個半截的 JSON，而下次
 * 開機的症狀是「預設規則突然失效」而且原因寫在 log 的很後面。
 *
 * ⚠ **寫之前一定要過 `loadRulePackage`。** 簽章保證「這是我們發的」，不保證
 * 「這是對的」—— 一份簽對了但欄位壞掉的規則落地之後，每次開機都會失敗一次。
 */
function writeRuleCache(appDir: string, manifest: RuleManifest): string {
  const parsed = loadRulePackage(manifest.package);
  if (!parsed.ok) throw new Error(`規則內容不合規格：[${parsed.code}] ${parsed.message}`);

  ensureRuleDir(appDir);
  const target = cachedRulePath(appDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest.package, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
  return target;
}
