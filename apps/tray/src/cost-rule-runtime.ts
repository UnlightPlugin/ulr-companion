/**
 * 托盤的自訂 COST：載入規則（玩家選的檔、雲端預設表、安裝包那份）、推給引擎、編輯器
 * （2026-10-18 從 main.ts 整段搬出來，程式照原樣）。
 *
 * 跟 main.ts 的介面：
 *
 * - 進來的：{@link initCostRuleRuntime} 交進來的 `ctx`（profile／engine／log／pushState，每次讀都是當下的）、
 *   遊戲狀態、資料夾、改指定配置的 `editProfile`。
 * - 出去的：`costRule`／`costRuleFull`／`costRuleHash`… 這幾個 `let` 是 ES module 的即時綁定，
 *   main.ts 讀到的永遠是當下的值；要改它們只能走這裡的函式。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ArbiterEngine, EngineStatus } from "@ulr/arbiter-engine";
import type { CardCatalog, CompressionRule, CostRule, GapBand } from "@ulr/rule-schema";
import {
  assertCostRule,
  contentHash,
  createRulePackage,
  loadRulePackage,
  parseEquipmentKey,
  parseEventCardKey,
  shortHash,
  toCardIdTable,
  legacyWeaponId,
  legacyEventId,
} from "@ulr/rule-schema";
import { readCatalog } from "./catalog-store.js";
import { bundledRulePath, resolveDefaultRule } from "./default-rule.js";
import type { Profile } from "./profiles.js";
import { EDIT_STEPS, EDIT_UNITS } from "./profiles.js";
import type { TrayContext } from "./tray-context.js";
/** main.ts 交給自訂 COST 這段的東西（見 initCostRuleRuntime）。 */
export interface CostRuleDeps {
  ctx: TrayContext;
  /** 插件自己的資料夾（APPDATA 底下的 ulr-companion）：雲端預設表的快取放這底下。 */
  appDir: string;
  /** 引擎最後一次回報的狀態；沒接著遊戲是 null。 */
  latest(): EngineStatus | null;
  /** 改指定 id 的配置並寫回設定檔（main.ts 的 editProfile）。 */
  editProfile(id: string, patch: Partial<Omit<Profile, "id">>): void;
}

let deps: CostRuleDeps;
let ctx: TrayContext;

/** main.ts 一開始叫一次，之後這裡的函式才能用。 */
export function initCostRuleRuntime(d: CostRuleDeps): void {
  deps = d;
  ctx = d.ctx;
}

// ---------------------------------------------------------------------------
// 自訂 COST
// ---------------------------------------------------------------------------

/**
 * 目前載進來的規則摘要。**只放給畫面看的欄位**，不放整張 700 筆的 COST 表 ——
 * 那會讓每次 pushState 都在 IPC 上搬幾十 KB，而畫面一個都用不到。
 */
export interface CostRuleInfo {
  path: string;
  name: string;
  version: string;
  publisher: string;
  /**
   * 規則包才有。裸規則是 null —— 那也是「不能拿去跟對手核對」的意思。
   *
   * ⚠ 這是**從內容重算**的碼，不是檔案裡寫的那個。配對鍵也用同一個值，
   * 所以「畫面上的碼一樣」與「配得到對方」永遠是同一件事。
   */
  shortHash: string | null;
  /**
   * 這個檔案宣稱的碼跟內容不符，已經重算。`null` = 檔案本來就自洽。
   *
   * 玩家直接改包就會走到這裡（那是支援的做法）。要講出來的原因只有一個：
   * **對手手上那份的碼已經不一樣了**，得把新檔案傳過去。
   */
  rehashedFrom: string | null;
  /** 角色表的筆數。⚠ 只有角色 —— 四張表的細分在 `tableEntries`。 */
  entries: number;
  /** 四張表各幾筆。0 代表這份規則不管那一種卡（遊戲用原版價格）。 */
  tableEntries: {
    characters: number;
    monsters: number;
    equipment: number;
    eventCards: number;
  };
  gameVersion: string;
  /** 規則族。**配對是照這個分的**（見 `@ulr/arbiter-link` 的 `MatchCriteria`）。 */
  ruleSetId: string;
  /** 壓 C 區間，給畫面列表用。`null` = 這份規則不壓 C。 */
  bands: { minGap: number; maxGap: number | null; extraCost: number }[] | null;
  /**
   * 作者寫的說明與更新說明。沒寫是空字串。
   *
   * ⚠ **一定要在「Cost 表」那一頁看得到，不能只有「編輯描述」看得到。**
   * 這兩欄是規則裡唯一「作者對拿到規則的人說話」的地方 —— 定價的理由、
   * 最小單位、哪些卡刻意不動、這一版改了什麼，全部只能寫在這裡（引擎永遠
   * 不解析它們，見 `Restriction.condition` 那條同樣的立場）。
   *
   * 只放在編輯頁的話，收到規則的人要**進到一個編輯畫面**才讀得到自己收到的
   * 東西，而那一頁的每一格都是可以打字的 —— 等於要他為了讀說明去冒改壞的
   * 風險。所以摘要要帶著它們，即使它們比其他欄位長得多。
   *
   * ⚠ 長度有上限（編輯器那邊 `maxlength=2000`），所以放進每次 pushState 的
   * 快照是可接受的 —— 跟 700 筆的 COST 表不是同一個量級。
   */
  description: string;
  changelog: string;
}

/**
 * 載入失敗的規則，留給畫面顯示。
 *
 * 只留「哪個檔、為什麼、怎麼救」三件事 —— 玩家看到這張卡片的時候，他要的
 * 不是錯誤碼，是下一步該做什麼。
 */
export interface CostRuleFailure {
  fileName: string;
  message: string;
  /** 針對這個錯誤的自救步驟。沒有特別建議時是 `null`。 */
  hint: string | null;
}

export let costRule: CostRuleInfo | null = null;
export let costRuleError: CostRuleFailure | null = null;

/**
 * 這份規則是從哪裡來的。**畫面一定要分得出來** —— 「插件附的預設規則」與
 * 「我自己選的檔」在玩家心裡是兩件完全不同的事，而它們在 `costRule` 裡長得
 * 一模一樣（都只是一個路徑）。
 */
export type CostRuleOrigin = "bundled" | "feed" | "file";
export let costRuleOrigin: CostRuleOrigin | null = null;

/**
 * 目前規則的**完整內容**。配對要用它算牌組（`checkOwnDeck` / 交叉驗算）。
 *
 * ⚠ 跟 `costRule`（摘要）分開放，而且**絕不進 `Snapshot`** —— 那是 700 筆的
 * COST 表，每次狀態變動都在 IPC 上搬一次的話，畫面會一格一格地卡。
 */
export let costRuleFull: CostRule | null = null;
/**
 * `costRuleFull` 的 contentHash。**跟著它一起設，不要用到的時候現算。**
 *
 * 現算不是慢的問題，是**會漂移**：規則標籤（`ruleTag`）跟大廳人數的判準都靠
 * 這個值，散在三個地方各算一次的話，總有一天其中一個會拿到不同步的那一份。
 */
export let costRuleHash: string | null = null;
/**
 * 交給引擎的那一份（卡片 id 已經換好）。**規則載著不等於交給引擎** ——
 * `profile.customCostInGame` 關著時這裡有值，但引擎拿到的是 `null`。
 */
let costRuleTables: Parameters<ArbiterEngine["setCostRule"]>[0] = null;

/**
 * 照 `customCostInGame` 把規則交給引擎或收回來。
 *
 * ⚠ 關著時規則**沒有被丟掉**（`costRuleFull` 還在，自動配對照樣用）。收回的
 * 只是遊戲畫面上的部分：迪城的自訂價與罰則、牌組編輯的自訂總和與開關 ——
 * 引擎沒拿到表，這些全部退回官方（見 `room-cost.ts`、`patch-cost-toggle.ts`）。
 */
export function pushCostRuleToEngine(): void {
  ctx.engine?.setCostRule(ctx.profile.customCostInGame ? costRuleTables : null);
}

// ---------------------------------------------------------------------------
// 編輯 COST
//
// 「規則檔裡是 cc001_01，玩家看到的要是艾伯李斯特」—— 那份對照就是名冊
// （`@ulr/rule-schema` 的 catalog.ts），來源是玩家自己跑著的客戶端。
// ---------------------------------------------------------------------------

/**
 * 卡片名冊。開機時從家目錄的快取讀回來，沒有就是 `null`。
 *
 * ⚠ **不進 `Snapshot`**，理由同 `costRuleFull`：它有一千多筆，而快照每次狀態
 * 變動都整份重送。編輯頁自己用 `ulr:editor-load` 拉一次。
 */
let catalog: CardCatalog | null = readCatalog();

/** 猜一個遊戲版本字串（`2026.08`）。名冊只拿它來提醒「這份是哪一版讀的」。 */
export function gameVersionNow(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 四張表的原始鍵值，直接餵給編輯頁。 */
interface EditorTables {
  characters: Record<string, number>;
  monsters: Record<string, number>;
  equipment: Record<string, number>;
  eventCards: Record<string, number>;
}

/**
 * 規則裡**不是 COST 也不是壓 C** 的那些欄位。「編輯描述」那一頁在改的東西。
 *
 * ⚠ `restrictions`（限制條款）不在這裡：schemaVersion 1 的它是
 * `enforcement: "agreement-only"` 的自由文字，**引擎永遠不解析**（§12），
 * 而做一個編輯器給一個沒有任何行為的欄位，只會讓人以為插件會強制它。
 * 要它有意義得先有結構化的條件型別（schemaVersion 2）。
 */
export interface RuleMeta {
  ruleSetId: string;
  version: string;
  name: string;
  description: string;
  publisherId: string;
  publisherName: string;
  publisherContact: string;
  gameVersion: string;
  appliesTo: "duel" | "quest" | "any";
  teamCostLimit: number;
  changelog: string;
}

export interface EditorPayload {
  /** 正在編哪份規則。沒選規則時是 `null`，編輯頁會請玩家先去選。 */
  rule: {
    name: string;
    version: string;
    ruleSetId: string;
    fileName: string;
    shortHash: string | null;
    gameVersion: string;
  } | null;
  tables: EditorTables | null;
  /**
   * 壓 C 規則（「編輯規則」那一頁在改的東西）。
   *
   * ⚠ **沒寫 `compressionRule` 的規則在這裡是 `{ type: "none", bands: [] }`
   * 而不是 `null`。** 兩者在畫面上都畫成「這份規則不壓 C」，但 `null` 會逼
   * 每一段渲染碼各自處理一次「還沒載入 vs 沒有規則」，而那兩件事的差別在這
   * 一頁根本不存在 —— 規則載進來了就一定有一個確定的壓 C 狀態。
   */
  compression: { type: CompressionRule["type"]; bands: GapBand[] } | null;
  /**
   * 規則的「描述」那一半 —— 名稱、作者、版本、適用範圍、更新說明。
   *
   * ⚠ 這些欄位**每一個都會進 contentHash**（整個 rule 物件就是雜湊的對象），
   * 所以改個作者名字核對碼就會變。介面要講出來，否則玩家會以為只有數字算數。
   */
  meta: RuleMeta | null;
  catalog: CardCatalog | null;
  /** 讀名冊失敗的原因。成功或還沒讀過是 `null`。 */
  catalogError: string | null;
  /** 遊戲接上了沒 —— 決定「從遊戲讀取名冊」那顆按不按得下去。 */
  connected: boolean;
  /** 按一下上下鍵動多少。⚠ 真實來源是設定檔，畫面上那個只是它的樣子。 */
  editStep: number;
  /** 幅度的快速鍵。⚠ 從這裡送而不是讓畫面自己寫死 —— 兩份清單會走散。 */
  editSteps: readonly number[];
  /**
   * 最小單位檢查用的值。**0 = 不檢查。**
   *
   * ⚠ 這**不在規則檔裡**，是編輯器的工具設定（見 `profiles-core.ts` 的
   * `normalizeEditUnit`）。所以它跟 `rule` 是兩個獨立的東西 —— 換一份規則來編，
   * 這個值不會跟著換。
   */
  editUnit: number;
  editUnits: readonly number[];
}

export interface EditorSaveResult {
  ok: boolean;
  shortHash?: string;
  version?: string;
  error?: string;
}

export function editorPayload(): EditorPayload {
  const rule = costRuleFull;
  return {
    rule:
      costRule === null || rule === null
        ? null
        : {
            name: rule.name,
            version: rule.version,
            ruleSetId: rule.ruleSetId,
            fileName: basename(costRule.path),
            shortHash: costRule.shortHash,
            gameVersion: rule.gameVersion,
          },
    tables:
      rule === null
        ? null
        : {
            characters: { ...rule.characters },
            monsters: { ...(rule.monsters ?? {}) },
            equipment: { ...(rule.equipment ?? {}) },
            eventCards: { ...(rule.eventCards ?? {}) },
          },
    compression:
      rule === null
        ? null
        : rule.compressionRule?.type === "gap-band-v1"
          ? { type: "gap-band-v1", bands: rule.compressionRule.bands.map((b) => ({ ...b })) }
          : { type: "none", bands: [] },
    meta:
      rule === null
        ? null
        : {
            ruleSetId: rule.ruleSetId,
            version: rule.version,
            name: rule.name,
            description: rule.description ?? "",
            publisherId: rule.publisher.id,
            publisherName: rule.publisher.name,
            publisherContact: rule.publisher.contact ?? "",
            gameVersion: rule.gameVersion,
            appliesTo: rule.appliesTo ?? "duel",
            teamCostLimit: rule.teamCostLimit,
            changelog: rule.changelog ?? "",
          },
    catalog,
    catalogError: null,
    connected: deps.latest()?.connected ?? false,
    editStep: ctx.profile.editStep,
    editSteps: EDIT_STEPS,
    editUnit: ctx.profile.editUnit,
    editUnits: EDIT_UNITS,
  };
}

/** 只收有限數字，其餘丟掉。渲染層送來的東西一律當成不可信的輸入。 */
function sanitizeTable(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, cost] of Object.entries(value as Record<string, unknown>)) {
    if (typeof cost === "number" && Number.isFinite(cost)) out[key] = cost;
  }
  return out;
}

/**
 * 一段壓 C 區間。渲染層送來的一律當成不可信的輸入。
 *
 * ⚠ **`maxGap` 空白代表「沒有上界」，不是 0。** 空字串在畫面上就是玩家沒填，
 * 而 `Number("")` 是 0 —— 那會把「差距 30 以上」變成「差距 30 到 0」，一段
 * 不可能命中的區間，然後最大的那些差距靜靜地不罰了。
 *
 * 整段丟掉（回 `null`）而不是硬補一個值：規則是玩家自己在編的東西，猜他的
 * 意思比少存一段更糟。少存的那一段在畫面上看得見。
 */
function sanitizeBand(value: unknown): GapBand | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const minGap = num(b["minGap"]);
  const extraCost = num(b["extraCost"]);
  if (minGap === null || extraCost === null) return null;

  const maxGap = b["maxGap"] === null || b["maxGap"] === undefined ? null : num(b["maxGap"]);
  return maxGap === null ? { minGap, extraCost } : { minGap, maxGap, extraCost };
}

/** 壓 C 規則。認不得的形狀一律回 `null`（＝呼叫端要沿用原本那份）。 */
function sanitizeCompression(value: unknown): CompressionRule | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c["type"] === "none") return { type: "none" };
  if (c["type"] !== "gap-band-v1") return null;
  const raw = Array.isArray(c["bands"]) ? c["bands"] : [];
  const bands = raw.map(sanitizeBand).filter((b): b is GapBand => b !== null);
  // 空表的 gap-band-v1 跟 none 是同一件事，存成 none 比較誠實（也比較好讀）。
  return bands.length === 0 ? { type: "none" } : { type: "gap-band-v1", bands };
}

/**
 * 「編輯描述」送來的那一包。**認不得的形狀一律回 `null`**（＝沿用原本的）。
 *
 * ⚠ 這裡只做「整理成規則該有的形狀」，**不做驗證** —— 格式（ruleSetId 的
 * pattern、SemVer、gameVersion 的 `2026.08`、publisher.id 要等於 ruleSetId 的
 * 前半段）全部交給 `assertCostRule`，那才是唯一的判準。在這裡再寫一份會漂移，
 * 而漂移的症狀是「介面說可以，存檔卻失敗」。
 *
 * ⚠ 空字串的選填欄位要**整個拿掉**而不是留空字串：`description: ""` 與沒有
 * `description` 是兩份不同的 JSON，也就是兩個不同的 contentHash。
 */
function applyMeta(current: CostRule, value: unknown): CostRule {
  if (typeof value !== "object" || value === null) return current;
  const m = value as Record<string, unknown>;
  /** 有送這個欄位、而且是字串才算數。沒送的一律沿用原本的。 */
  const str = (key: string): string | null => {
    const v = m[key];
    return typeof v === "string" ? v.trim() : null;
  };

  const next: CostRule = { ...current, publisher: { ...current.publisher } };

  const scalars = [
    ["ruleSetId", "ruleSetId"],
    ["version", "version"],
    ["name", "name"],
    ["gameVersion", "gameVersion"],
  ] as const;
  for (const [field, key] of scalars) {
    const v = str(key);
    // 空字串不當成「清空」—— 那幾個欄位是必填的，清空只會讓存檔失敗。
    if (v !== null && v !== "") next[field] = v;
  }

  const appliesTo = str("appliesTo");
  if (appliesTo === "duel" || appliesTo === "quest" || appliesTo === "any") {
    next.appliesTo = appliesTo;
  }

  const limit = m["teamCostLimit"];
  if (typeof limit === "number" && Number.isFinite(limit)) next.teamCostLimit = limit;

  // ⚠ 選填的長文字：空的要**整個刪掉欄位**，不是留一個空字串。
  // `description: ""` 與沒有 `description` 是兩份不同的 JSON，也就是兩個
  // 不同的 contentHash —— 而玩家清空一個欄位的意思是「這份規則沒有這一項」。
  for (const field of ["description", "changelog"] as const) {
    const v = str(field);
    if (v === null) continue;
    if (v === "") delete next[field];
    else next[field] = v;
  }

  const pubId = str("publisherId");
  const pubName = str("publisherName");
  if (pubId !== null && pubId !== "") next.publisher.id = pubId;
  if (pubName !== null && pubName !== "") next.publisher.name = pubName;
  const contact = str("publisherContact");
  if (contact !== null) {
    if (contact === "") delete next.publisher.contact;
    else next.publisher.contact = contact;
  }
  return next;
}

/**
 * 把編輯結果寫回規則檔。
 *
 * ⚠ **一定要過 `assertCostRule`。** 渲染層送來的是外部輸入，直接寫進檔案等於
 * 讓一份不合規格的規則落地，而下次載入才會炸 —— 那時玩家已經不知道是哪一步
 * 弄壞的。精度（0.01）與壓 C 區間重疊也都是在這一關擋的。
 *
 * ⚠⚠ **沒送到的東西一律沿用原本那份，不能當成「清空」。** 有兩頁在寫同一個
 * 檔（編輯 COST 送 `tables`、編輯規則送 `compression`），而這支原本無條件把
 * 四張表換成 `payload.tables` —— 那樣「改個壓 C 存檔」會把 1186 筆價格全部
 * 洗成空的，而且完全不報錯（空表是合法的規則，只是每張卡都變成 99C）。
 */
export function saveEditedRule(
  current: CostRule,
  path: string,
  payload: unknown,
): { short: string; version: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const version =
    typeof p["version"] === "string" && p["version"] !== "" ? p["version"] : current.version;

  const tables = typeof p["tables"] === "object" && p["tables"] !== null ? p["tables"] : null;
  const t = (tables ?? {}) as Record<string, unknown>;
  const table = (id: keyof EditorTables, fallback: Record<string, number> | undefined) =>
    tables === null ? (fallback ?? {}) : sanitizeTable(t[id]);

  const compression = sanitizeCompression(p["compression"]);
  // 「編輯描述」那一頁送的東西。沒送就是原封不動。
  const base = applyMeta(current, p["meta"]);

  const next = assertCostRule({
    ...base,
    version,
    characters: table("characters", current.characters),
    monsters: table("monsters", current.monsters),
    equipment: table("equipment", current.equipment),
    eventCards: table("eventCards", current.eventCards),
    ...(compression === null
      ? {}
      : // ⚠ `{ type: "none" }` 要真的寫進去，不能改成刪掉這個欄位 —— 兩者
        // 對引擎是同一件事，但檔案裡看得到 `"type": "none"` 才知道作者是
        // **決定不壓 C**，而不是拿到一份還沒寫完的規則。
        { compressionRule: compression }),
  });

  const pkg = createRulePackage(next, {
    exportedBy:
      p["meta"] !== undefined
        ? "ulr-companion 編輯描述"
        : compression !== null
          ? "ulr-companion 編輯規則"
          : "ulr-companion 編輯 COST",
  });
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  const short = shortHash(pkg.contentHash);
  ctx.log(`✓ 已存回 ${basename(path)}（${next.version}，核對碼 ${short}）`);
  return { short, version: next.version };
}

/**
 * 錯誤訊息 → 給玩家的下一步。
 *
 * ⚠ 這裡**沒有** hash.mismatch 那一條了 —— 直接改包是支援的做法，Hash 會
 * 重算（見 `@ulr/rule-schema` 的 `loadRulePackage`）。剩下的都是真的動不了
 * 的錯：內容不合規格、檔案不在。
 */
function costRuleHint(message: string): string | null {
  if (message.includes("rule.invalid")) {
    return "規則內容不合規格，上面那行寫了是哪個欄位。把它改好之後再選一次。";
  }
  if (message.includes("ENOENT")) {
    return "檔案不在了（搬走或刪掉了？）。重新選一次。";
  }
  if (message.includes("JSON")) {
    return "這個檔案不是合法的 JSON —— 編輯時少了逗號或括號？";
  }
  return null;
}

/** 規則包與裸規則都要選得到。`.ulrcost.json` 在 Windows 上被視為副檔名 `json`。 */
export const COST_FILE_FILTERS = [
  { name: "COST 規則", extensions: ["json"] },
  { name: "全部檔案", extensions: ["*"] },
];

/**
 * 從檔案讀規則並推給引擎。
 *
 * ⚠ **失敗要講出來並清掉路徑**，不能安靜地當作沒選。玩家把規則檔刪了或搬走
 * 之後，如果 UI 還顯示「已選規則」而數字是原版的，他會以為插件壞了。
 */
export function loadCostRule(path: string | null, origin: CostRuleOrigin = "file"): void {
  if (path === null) {
    costRule = null;
    costRuleFull = null;
    costRuleHash = null;
    costRuleError = null;
    costRuleOrigin = null;
    costRuleTables = null;
    ctx.engine?.setCostRule(null);
    return;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    let rule: CostRule;
    let short: string | null = null;
    let rehashedFrom: string | null = null;

    if (typeof raw === "object" && raw !== null && "packageVersion" in raw) {
      const result = loadRulePackage(raw);
      if (!result.ok) throw new Error(`[${result.code}] ${result.message}`);
      rule = result.value.pkg.rule;
      // ⚠ 這個 short 是**重算**的。直接改過的包在這裡是正常輸入，
      // 只是核對碼會跟檔案裡寫的那個不一樣 —— 要講給玩家聽。
      short = result.value.short;
      rehashedFrom = result.value.staleHash?.claimedShort ?? null;
    } else {
      rule = assertCostRule(raw);
    }

    const bands = rule.compressionRule?.type === "gap-band-v1" ? rule.compressionRule.bands : null;

    costRule = {
      path,
      name: rule.name,
      version: rule.version,
      publisher: rule.publisher.name,
      shortHash: short,
      rehashedFrom,
      entries: Object.keys(rule.characters).length,
      // 四張表分開報。一個總數看不出「這份規則有沒有管裝備」，而那正是玩家
      // 拿到別人的規則檔時第一個要知道的事。
      tableEntries: {
        characters: Object.keys(rule.characters).length,
        monsters: Object.keys(rule.monsters ?? {}).length,
        equipment: Object.keys(rule.equipment ?? {}).length,
        eventCards: Object.keys(rule.eventCards ?? {}).length,
      },
      gameVersion: rule.gameVersion,
      ruleSetId: rule.ruleSetId,
      bands:
        bands === null
          ? null
          : bands.map((b) => ({
              minGap: b.minGap,
              maxGap: b.maxGap ?? null,
              extraCost: b.extraCost,
            })),
      // 作者對「拿到這份規則的人」說的話。⚠ 摘要要帶著 —— 理由見型別那邊。
      description: rule.description ?? "",
      changelog: rule.changelog ?? "",
    };
    // ⚠ 罰則跟價格要一起送。只送價格的話，自訂規則的 compressionRule 對
    // 遊戲畫面完全沒有作用 —— 罰則的公式是寫死在客戶端裡的。
    //
    // ⚠ 裝備與事件卡要**先把規則鍵換成卡片 id**（`wp001` → `"6"`）。注入的
    // 腳本刻意不認得 `wp` / `ev` 這套命名，見 patch-cost.ts 的說明。
    // 2026-09-23 改版後客戶端只認 id，而且順序重排過 —— 不是索引 +1。
    const equipment = toCardIdTable(rule.equipment, parseEquipmentKey, legacyWeaponId);
    const eventCards = toCardIdTable(rule.eventCards, parseEventCardKey, legacyEventId);
    costRuleTables = {
      characters: rule.characters,
      monsters: rule.monsters,
      equipment: equipment.byId,
      eventCards: eventCards.byId,
      bands,
    };
    pushCostRuleToEngine();
    costRuleFull = rule;
    costRuleHash = contentHash(rule);
    costRuleError = null;
    costRuleOrigin = origin;
    const t = costRule.tableEntries;
    const summary = [
      `角色 ${t.characters}`,
      t.monsters > 0 ? `怪物 ${t.monsters}` : null,
      t.equipment > 0 ? `裝備 ${t.equipment}` : null,
      t.eventCards > 0 ? `事件卡 ${t.eventCards}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join("、");
    ctx.log(`✓ 載入 COST 規則「${rule.name} ${rule.version}」（${summary}）`);
    // ⚠ 認不得的鍵要講出來，不能默默丟掉。`wp1`（沒補零）這種寫法很容易手滑，
    // 而症狀是「那張卡的價格就是沒變」—— 沒有這一行的話玩家查不到原因。
    for (const [label, bad] of [
      ["裝備", equipment.unmapped],
      ["事件卡", eventCards.unmapped],
    ] as const) {
      if (bad.length === 0) continue;
      ctx.log(`⚠ ${label}有 ${bad.length} 個鍵格式不對，已略過：${bad.slice(0, 5).join(", ")}`);
    }
    if (rehashedFrom !== null) {
      ctx.log(`· 這個檔案被直接改過，核對碼已重算：${rehashedFrom} → ${short ?? "?"}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    costRule = null;
    costRuleFull = null;
    costRuleHash = null;
    costRuleOrigin = null;
    costRuleTables = null;
    ctx.engine?.setCostRule(null);
    // ⚠ 記錄**不夠**。記錄在「戰鬥」頁，玩家人在「自訂COST › Cost 表」頁，
    // 那一頁只會說「還沒選規則」—— 看起來就是按了沒反應。所以同時留一份
    // 給畫面，由 Cost 頁自己顯示。
    costRuleError = { fileName: basename(path), message, hint: costRuleHint(message) };
    ctx.log(`✗ COST 規則載入失敗，已停用：${message}`);
    // 玩家自己選的檔壞掉／不在了 → 清掉路徑讓他重選，否則每次開機再失敗一次。
    //
    // ⚠ **預設規則不走這條。** 它的路徑不是玩家填的，清掉沒有任何意義，而且
    // `applyCostRule()` 已經幫它處理過退路了（快取壞掉退回安裝包那份）。
    // ⚠ editProfile 會 pushState，而那要在 costRuleError 設好之後 ——
    // 反過來的話畫面會先收到一份「沒選規則、也沒有錯誤」的狀態。
    if (origin === "file" && ctx.profile.costRulePath !== null) {
      deps.editProfile(ctx.profile.id, { costRulePath: null });
    }
  }
}

/**
 * 這一條連線已經為了「頁面比插件早載入」自動重載過了嗎。
 *
 * ⚠ 防的是無窮重載：判斷 `stale` 要問頁面，而問回來的答案不保證永遠正確。
 * 斷線重連會重置（`onStatus`）—— 玩家關掉遊戲再開仍然救得回來。
 */
let autoReloadedThisAttach = false;

/**
 * 等一個安全的時機把新規則套到遊戲上。
 *
 * ⚠ **這是 `updater.ts` 那條線的同一條原則**：下載可以完全靜默，
 * **換版的那一刻不能落在對戰進行中**。判準也是同一個（`status.armed` ——
 * 攔截真的掛在 socket 上），因為「連上但還在大廳」正是最安全、也最常見的
 * 停留點。
 *
 * ⚠ 套用**一定要留一行 log**。玩家事後要查得到「今天的數字為什麼跟昨天不同」，
 * 而那是靜默更新唯一不能省的義務。
 */
export async function applyPendingReload(): Promise<void> {
  if (ctx.engine === null) return;

  // 唯一的理由：頁面上那份卡片資料**不是這一份規則**改出來的（`cost.stale`）。
  //
  // ⚠ 換規則**不走這裡**（玩家 2026-10-11：「那一頁也要改成不重載」）。
  // 09-24 起 patch-cost 直接改 Phaser 快取，引擎 `#syncCosts` 會當場套上新規則，
  // 套完問一次覆蓋率 —— 蓋得到就不會 stale，這條路只剩真的套不上時的退路。
  //
  // ⚠ stale 有兩種情形：
  //
  //   1. 玩家從 Steam 開遊戲 —— 遊戲先跑起來、插件兩秒後才接上，而
  //      `addScriptToEvaluateOnNewDocument` 只管之後載入的 document
  //   2. 插件重開之後載到**另一份**規則 —— 頁面上留著上一份的數字
  //
  // 兩種的症狀是同一句「插件開著，cost 沒生效」，而第 2 種一度判不出來
  // （見 `costsStamp`：判準原本只問「改過嗎」，不問「改的是哪一份」）。
  const stale = deps.latest()?.cost.stale === true;
  if (!stale) return;
  // 對戰中：下一次狀態推播時再試（`onStatus` 會叫這支）。
  if (deps.latest()?.armed === true) return;
  // 還沒連上遊戲就不必重載 —— 遊戲一啟動就會帶著新規則載入，那才是常態。
  if (deps.latest()?.connected !== true) return;
  // ⚠ **一條連線只自動重載一次。** `stale` 是從頁面問回來的，而「問回來的
  // 東西一定有一天會回錯」—— 沒有這道閘的話，一個永遠回 true 的答案會讓
  // 遊戲無限重載，而玩家完全無法把它跟插件連在一起。旗標在斷線時重置
  // （見 `onStatus`），所以下一次接上仍然救得回來。
  if (autoReloadedThisAttach) return;
  autoReloadedThisAttach = true;

  try {
    await ctx.engine.reloadGame();
    ctx.log("⟳ 遊戲畫面上的價格不是現在這份規則，當場套不上 —— 已請遊戲重新載入");
  } catch (err) {
    ctx.log(`✗ 套用新 COST 表時重載失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.pushState();
}

/**
 * 照配置把規則載進來。**開機、換模式、規則更新下來時都走這一支。**
 *
 * ```
 *   off     → 不載（原版數字）
 *   file    → 玩家選的那個檔
 *   default → 中間人發下來的那份；壞掉或沒有 → 安裝包裡那份
 * ```
 *
 * ⚠ **`default` 的退路一定要有。** 快取那份是下載來的，而下載來的東西總有
 * 一天會壞（磁碟滿、防毒攔一半、手動改壞）。沒有退路的話症狀是「插件昨天
 * 好好的，今天所有卡都變回原版價格」，而玩家完全不知道發生什麼事。
 */
export function applyCostRule(): void {
  if (ctx.profile.costRuleMode === "off") {
    loadCostRule(null);
    return;
  }
  if (ctx.profile.costRuleMode === "file") {
    loadCostRule(ctx.profile.costRulePath);
    return;
  }

  const choice = resolveDefaultRule(deps.appDir);
  if (choice === null) {
    // 兩份都不在 —— 打包時漏掉了規則檔才會走到這裡。
    loadCostRule(null);
    costRuleError = {
      fileName: "default.ulrcost.json",
      message: "找不到插件附的預設 COST 表",
      hint: "重新安裝一次插件；或到「Cost 表」自己選一份規則檔。",
    };
    ctx.log("✗ 找不到預設 COST 表（安裝包裡那份也不在）");
    return;
  }

  loadCostRule(choice.path, choice.source === "feed" ? "feed" : "bundled");
  // 下載來的那份載不起來 → 退回安裝包裡那份，而且要講出來。
  if (costRuleFull === null && choice.source === "feed") {
    ctx.log("⚠ 下載來的預設 COST 表載不起來，改用插件附的那一份");
    loadCostRule(bundledRulePath(), "bundled");
  }
}

/**
 * 玩家在「Cost 表」那一頁換了規則（選檔、換模式、停用）。
 *
 * ⚠ **不重載遊戲**（玩家 2026-10-11）。引擎拿到新規則（或 `null`）就當場改快取：
 * 換規則走 `installCostOverridesLive`（舊規則動過、新規則沒動的卡會還原成原價），
 * 停用走 `revertCostOverrides`。以前這裡會挑不在對戰中的時機重載一次 —— 那是
 * 09-24 之前「只有載入那一刻的掛鉤」時代留下的。
 */
export function changeCostRule(): void {
  applyCostRule();
}

// ---------------------------------------------------------------------------
// main.ts 叫的（以前它直接改這裡的變數）
// ---------------------------------------------------------------------------

/** 斷線了：把「這條連線自動重載過了」忘掉（新的頁面要能再救一次）。 */
export function forgetAutoReload(): void {
  autoReloadedThisAttach = false;
}

/** 編輯器剛從客戶端讀到一份新的卡片名冊。 */
export function setCatalog(next: CardCatalog): void {
  catalog = next;
}
