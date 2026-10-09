/**
 * 公開渦通知（raid-feed）：用玩家取代 ulgg 觀測站
 * ===============================================
 * 設計與取捨見 `docs/raid-feed.md`。這一份是規則（驗證、合併、碎片、Discord 文字），
 * Worker 的 `RaidFeedRoom` 只做膠水（storage、alarm、打 Discord）。
 *
 * ```
 *   插件（玩家打開 SUPPORT）── POST /raid-feed {source:"support"} ─▶ 帳本：新渦 → 30 秒一批發 Discord
 *   插件（渦房裡每 30 秒）──── POST /raid-feed {source:"own"} ─────▶ 帳本：補 ★／stage → 改那則訊息
 *   插件 ─────────────────────── GET  /raid-feed ─────────────────▶ 還沒到期的渦（沒有渦碼）
 * ```
 *
 * ## ⚠ 這裡有發現者名稱，但永遠沒有渦碼
 *
 * 跟 `raid-share.ts` 不一樣：Discord 訊息本來就公開發現者（舊 bot 一直這樣發），所以這裡收明文、
 * 也給讀。**渦碼＝門票**，插件在頁面裡就把它丟掉，這裡的形狀驗證也不認任何 code 欄位。
 *
 * ## 渦的鍵：發現者＋發現時刻
 *
 * SUPPORT 的 `founder_name`／`profound_date` 跟清單的 `founder`／`found_at` 是同一個值
 * （2026-10-03 實機對過）。不用到期時刻：渦死後伺服器把 limit 改成「死亡＋10 分」，鍵會變
 * （同 {@link raidTeamRef} 的理由）。
 *
 * ## 只有公開的能新增
 *
 * 能新增的只有 `support`（SUPPORT 公開清單）與 `publish`（發現者自己按「送出」、參加資格「無限制」）。
 * 自己的清單裡有好友限定／輸入渦碼加入的渦，拿它新增等於把它公告出去。`own` 只補帳本上已經有的渦。
 *
 * **`support` 也只有「不是發現者好友」的人看到的才能新增**（2026-10-09）：僅限好友的渦會列在
 * 發現者好友的 SUPPORT 裡，列上沒有參加資格欄位。上傳的人是好友（`founderFriend` 不是 `false`，
 * 舊版插件不帶也算）的那一列只更新帳本上已經有的渦。先僅限好友、後來改公開的渦，等非好友看到再發。
 *
 * 好友看到之後加入了：清單上的 `only_friend` 是真的值（2026-10-09 驗過：燈皇是 Kotoma 的好友、
 * 不是發現者，讀到 Kotoma 沒公開的玄帝是 `true`）。所以 `own` 帶 `onlyFriend: false` 而且
 * `seenInSupport`（在 SUPPORT 出現過＝送出了；沒送出的渦也是 false）也能新增。
 *
 * 反過來，公開之後才改成僅限好友的：有人清單上讀到 `onlyFriend: true`（`own`）就把它撤下
 * （`friendOnly`）——還沒發的不發、發了的從訊息拿掉那一行（整則都是就刪訊息）、GET 也不列。
 * 之後又證明公開（上面三種），再放回來。
 *
 * ## 信任
 *
 * 暫時完全信任（2026-10-03 決定）：只做形狀驗證，限流在 Worker。
 *
 * ⚠ 這一份**不 import 任何 Node 模組**：Worker 與插件共用。
 */

import { activeRaidPassives, nextRaidPassiveChange, raidPassiveIdsOf } from "./raid-passive.js";
import { raidTeamRef } from "./raid-share.js";

export const RAID_FEED_PATH = "/raid-feed";

/** POST 的 body 上限。一筆約 250 bytes，SUPPORT 整份（＋自己清單的鍵）一次放得下。 */
export const MAX_RAID_FEED_BODY_BYTES = 65_536;

/** 一次最多幾筆。SUPPORT 要整份一次傳（判斷「不見了」要整份），所以給大一點。 */
export const MAX_RAID_FEED_PER_POST = 200;

/**
 * 發現多久以上的渦，才拿「新鮮的整份 SUPPORT 裡沒有」判斷它不見了。
 * SUPPORT 清單是 1 分鐘內拿的（cdp-adapter `RAID_SUPPORT_MAX_AGE_MS`），再留一點時鐘誤差。
 */
export const RAID_FEED_GONE_GRACE_MS = 2 * 60 * 1000;

/** 只有 HP 變了：同一則訊息最多多久改一次（玩家 30 秒傳一次，每次都改會洗編輯、撞 Discord 限速）。 */
export const RAID_FEED_HP_REDRAW_MS = 60 * 1000;

/** 到期時刻往前跳超過這麼多 = 死了（伺服器把 limit 改成「死亡＋10 分」）。 */
const LIMIT_DROP_MS = 60 * 1000;

/** NEW 的批次窗：第一個新渦進來後固定 30 秒發，後到的不延長（跟舊 bot 一樣）。 */
export const RAID_FEED_BATCH_MS = 30_000;

/** 渦最長活 6 小時；發現時刻比現在早一天以上、或在未來的，一律當壞資料。 */
export const RAID_FEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 客戶端時鐘可以快多少。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 渦到期後帳本再留多久（死掉的渦 limit 是死亡＋10 分，留一點讓最後的修改還對得上）。 */
export const RAID_FEED_KEEP_AFTER_LIMIT_MS = 60 * 60 * 1000;

/** 帳本上最多放幾個渦。超過先丟最舊發現的。 */
export const RAID_FEED_CAPACITY = 2_000;

/** 發 Discord 失敗幾次就放棄那一批（webhook 被刪掉時不要永遠重試）。 */
export const RAID_FEED_MAX_ATTEMPTS = 3;

export type RaidFeedSource = "support" | "own" | "publish";

/** 一筆上傳（兩種來源共用；`support` 不會有 rarity／level／stage，`own` 不會有人數）。 */
export interface RaidFeedIn {
  founder: string;
  foundAt: number;
  limit: number;
  name: string | null;
  monsterId: number | null;
  /** BOSS 代碼（`mc1006_02`；`CharaCards` 的 `chara`）。判斷渦幾用，見 {@link raidFeedTierOf} */
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  memberLength: number | null;
  memberLimit: number | null;
  rarity: number | null;
  level: number | null;
  stage: number | null;
  /** 地圖區塊（自己清單的 `map_index`）。查 ulrmap 獎勵表用 */
  mapIndex: number | null;
  /**
   * BOSS 狀態：改版後只有「開打那一刻」看得到（`statesAt` 是那一刻）。`null` = 這次沒帶
   * （SUPPORT、沒打過的人），跟「帶了、但沒有狀態」的 `[]` 不一樣。
   */
  states: RaidFeedState[] | null;
  statesAt: number | null;
  /**
   * `support` 才有：上傳的人是不是發現者的好友。只有 `false` 能新增渦；`null`／沒帶（讀不到好友
   * 名單、舊版插件）當作是好友。
   */
  founderFriend?: boolean | null;
  /**
   * `own` 才有：清單上的參加資格（加入者讀到的是真的值，2026-10-09 驗過）。`true` 撤下；
   * `false` 要配 {@link seenInSupport} 才算公開（沒按送出的渦也是 false）
   */
  onlyFriend?: boolean | null;
  /** `own` 才有：上傳的人之前在 SUPPORT 看過它（好友看到、當時不能新增的那種）＝發現者按過送出 */
  seenInSupport?: boolean | null;
}

/** 一個 BOSS 狀態。`type` 是帶等級的整字（`movD9`）；`until` 是到期時刻 ms，`count` 是詛咒那種層數。 */
export interface RaidFeedState {
  type: string;
  until: number | null;
  count: number | null;
}

/** 一筆最多幾個狀態。 */
export const MAX_RAID_FEED_STATES = 16;

export interface RaidFeedUpload {
  source: RaidFeedSource;
  raids: RaidFeedIn[];
  /**
   * `support` 才有：這是**整份**、而且新鮮（1 分鐘內拿的）的 SUPPORT 清單。整份裡沒有的渦 =
   * 不見了（打倒了），見 {@link RaidFeedBook.ingest}。舊版插件不帶，就不做這個判斷。
   */
  complete: boolean;
  /**
   * `support` 才有：上傳的人**自己清單上還活著**、而且帳本上已經有的渦（只有鍵）。
   * 不確定 SUPPORT 會不會藏掉自己已經加入的渦，有這份就不會把它們誤判成不見了。
   */
  present: { founder: string; foundAt: number }[];
}

/** 帳本上的一個渦。 */
export interface RaidFeedEntry extends RaidFeedIn {
  /** 雲端第一次收到的時刻 */
  firstSeenAt: number;
  /** 雲端最後一次收到的時刻 */
  seenAt: number;
  /** pending：等這一批發；posted：發了（`messageId`）；skipped：不發（已經死了、發失敗） */
  status: "pending" | "posted" | "skipped";
  messageId: string | null;
  /** 發 Discord 失敗而放棄的（不再補發，免得 webhook 壞掉時一直重試） */
  failed?: boolean;
  /** 查 ulrmap 獎勵表查到的碎片（見 {@link RAID_REWARD_LOOKUP_URL}）；沒查過或沒查到是 null */
  lookupFragment?: RaidFragmentKey | null;
  /** 上一次查的是哪一組（{@link rewardLookupKey}）、什麼時候 */
  lookupKey?: string | null;
  lookupAt?: number | null;
  /** 有人清單上讀到它是僅限好友：不發、訊息不畫、GET 不列 */
  friendOnly?: boolean;
}

/** 一則 Discord 訊息裡有哪些渦（改訊息時整則重畫）。 */
export interface RaidFeedMessage {
  id: string;
  raids: string[];
  /** 發的時候有沒有 mention 渦 IV（重畫時保留那一行，但改訊息不會再 ping） */
  mention: boolean;
  /** 裡面最晚到期的渦；過了這個時刻就不會再改，可以丟 */
  until: number;
  /** 要不要重畫（碎片知道了、打倒了、有新的狀態、狀態到期） */
  dirty: boolean;
  /**
   * 下一次要自己重畫的時刻：顯示著的狀態到期、渦到期（⌛）、HP 變了但離上次改還不到
   * {@link RAID_FEED_HP_REDRAW_MS}。到了 alarm 就重畫。沒有是 null
   */
  stateExpiry?: number | null;
  /** 上一次發／改這則訊息的時刻（HP 限流用） */
  renderedAt?: number | null;
}

/** GET 回的一筆。 */
export interface RaidFeedView extends RaidFeedIn {
  seenAt: number;
  fragment: RaidFragmentKey | null;
}

// ---------------------------------------------------------------------------
// 形狀驗證
// ---------------------------------------------------------------------------

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" || s.length > max ? null : s;
}

/**
 * POST body → 乾淨的一份。**整份不合格回 `null`**（400）；個別一筆不合格就丟那一筆。
 */
export function normalizeRaidFeedUpload(body: unknown, now: number): RaidFeedUpload | null {
  const b = body as {
    source?: unknown;
    raids?: unknown;
    complete?: unknown;
    present?: unknown;
  } | null;
  if (b === null || typeof b !== "object" || !Array.isArray(b.raids)) return null;
  if (b.source !== "support" && b.source !== "own" && b.source !== "publish") return null;
  if (b.raids.length > MAX_RAID_FEED_PER_POST) return null;
  const raids: RaidFeedIn[] = [];
  for (const raw of b.raids) {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") continue;
    const founder = text(r.founder, 64);
    const foundAt = int(r.foundAt, now - RAID_FEED_MAX_AGE_MS, now + CLOCK_SKEW_MS);
    const limit = int(r.limit, now - RAID_FEED_MAX_AGE_MS, now + RAID_FEED_MAX_AGE_MS);
    if (founder === null || foundAt === null || limit === null) continue;
    raids.push({
      founder,
      foundAt,
      limit,
      name: text(r.name, 64),
      monsterId: int(r.monsterId, 0, 9_999_999),
      mons: typeof r.mons === "string" && /^mc\d{4}(_\d{2})?$/.test(r.mons) ? r.mons : null,
      hp: int(r.hp, 0, 100_000_000),
      hpMax: int(r.hpMax, 1, 100_000_000),
      memberLength: int(r.memberLength, 0, 999),
      memberLimit: int(r.memberLimit, 1, 999),
      rarity: int(r.rarity, 0, 10),
      level: int(r.level, 0, 999),
      stage: int(r.stage, 1, 100),
      mapIndex: int(r.mapIndex, 1, 99),
      ...statesOf(r.states, r.statesAt, now),
      founderFriend: typeof r.founderFriend === "boolean" ? r.founderFriend : null,
      onlyFriend: typeof r.onlyFriend === "boolean" ? r.onlyFriend : null,
      seenInSupport: r.seenInSupport === true ? true : null,
    });
  }
  const support = b.source === "support";
  const present: { founder: string; foundAt: number }[] = [];
  if (support && Array.isArray(b.present)) {
    for (const raw of b.present.slice(0, MAX_RAID_FEED_PER_POST)) {
      const p = raw as { founder?: unknown; foundAt?: unknown } | null;
      if (p === null || typeof p !== "object") continue;
      const founder = text(p.founder, 64);
      const foundAt = int(p.foundAt, now - RAID_FEED_MAX_AGE_MS, now + CLOCK_SKEW_MS);
      if (founder !== null && foundAt !== null) present.push({ founder, foundAt });
    }
  }
  return { source: b.source, raids, complete: support && b.complete === true, present };
}

/** 狀態要整組合格（有 `statesAt`）才收；壞的一個狀態就丟那一個。 */
function statesOf(
  raw: unknown,
  rawAt: unknown,
  now: number,
): Pick<RaidFeedIn, "states" | "statesAt"> {
  const statesAt = int(rawAt, now - RAID_FEED_MAX_AGE_MS, now + CLOCK_SKEW_MS);
  if (!Array.isArray(raw) || statesAt === null) return { states: null, statesAt: null };
  const states: RaidFeedState[] = [];
  for (const v of raw.slice(0, MAX_RAID_FEED_STATES)) {
    const o = v as { type?: unknown; until?: unknown; count?: unknown } | null;
    if (o === null || typeof o !== "object") continue;
    if (typeof o.type !== "string" || !/^[A-Za-z]{2,12}\d{0,2}$/.test(o.type)) continue;
    const until =
      o.until === null || o.until === undefined
        ? null
        : int(o.until, now - RAID_FEED_MAX_AGE_MS, now + RAID_FEED_MAX_AGE_MS);
    if (o.until !== null && o.until !== undefined && until === null) continue;
    const count = o.count === null || o.count === undefined ? null : int(o.count, 0, 999);
    states.push({ type: o.type, until, count });
  }
  return { states, statesAt };
}

export function raidFeedId(r: Pick<RaidFeedIn, "founder" | "foundAt">): string {
  return raidTeamRef(r.founder, r.foundAt);
}

// ---------------------------------------------------------------------------
// 碎片、渦的等級、BOSS 簡稱
// ---------------------------------------------------------------------------

export type RaidFragmentKey = "memory" | "time" | "soul" | "life" | "death";

/** stage % 5 → 碎片。跟 cdp-adapter `raid-treasure.ts` 的 `RAID_FRAGMENTS` 同一張。 */
const FRAGMENT_BY_CODE: readonly RaidFragmentKey[] = ["death", "memory", "time", "soul", "life"];

const FRAGMENT_DISPLAY: Record<RaidFragmentKey, { short: string; icon: string }> = {
  memory: { short: "黃", icon: "🟡" },
  time: { short: "綠", icon: "🟢" },
  soul: { short: "藍", icon: "🔵" },
  life: { short: "紅", icon: "🔴" },
  death: { short: "紫", icon: "🟣" },
};

/** 碎片是隨機的 BOSS（stage 推不出來）。 */
const RANDOM_FRAGMENT_BOSSES = ["龍鯉", "龙鲤"];

/**
 * 這個渦掉哪種碎片。**不用 map_index 公式**（見 docs/raid-feed.md），依序：
 *
 * 1. 玩家實際看到的 stage（算法跟頁面的 `fragByFormula` 一樣：★6 往後錯一格）
 * 2. ulrmap 獎勵表查到的（怪＋★＋區塊，實際結算整理出來的表）
 */
export function raidFeedFragment(
  r: Pick<RaidFeedIn, "stage" | "rarity" | "name"> & { lookupFragment?: RaidFragmentKey | null },
): RaidFragmentKey | null {
  if (r.name !== null && RANDOM_FRAGMENT_BOSSES.some((n) => r.name?.includes(n))) return null;
  if (r.stage !== null && r.rarity !== null) {
    const code = (((r.rarity === 6 ? r.stage + 1 : r.stage) % 5) + 5) % 5;
    const f = FRAGMENT_BY_CODE[code];
    if (f !== undefined) return f;
  }
  return r.lookupFragment ?? null;
}

// ---------------------------------------------------------------------------
// ulrmap 獎勵表（2026-10-03 起；文件見 unlight_crawler raid_bot/docs/api-raid-rewards-v2-lookup.md）
//
// POST 一個陣列 [{monsterId, rarity, mapIndex}]，回命中的那幾組與它們的獎勵（不用登入）。
// 排名獎勵裡 itemBucket 是 "cmem" 的那一項就是碎片。實測 locale=zh-TW 回的名稱仍是簡體，
// 所以繁簡都認。對不上（表裡沒有、或有多行）的組不會出現在回應裡。
//
// 渦 I 的排名獎勵是渦幣（"ccoin"），不是碎片（2026-10-04 實測：赤死獸 30110 ★1 區塊 3 回「银币」）。
// 渦幣跟碎片是同一格、同一個餘數（cmem_0..4 記憶～死亡 ↔ ccoin_0..4 鐵銅銀金白金），所以銀幣就是藍。
// 以前只認 cmem，渦 I 有人加入了也查不到、要等有人開打才知道。碎片優先，沒有碎片才看渦幣
// （渦 II 以上的後段名次也會發鐵幣，不能拿來當那個渦的顏色）。
// ---------------------------------------------------------------------------

export const RAID_REWARD_LOOKUP_URL =
  "https://www.ulrmap.wiki/api/raid-rewards-v2/lookup?locale=zh-TW";

/** 一次最多查幾組。 */
export const MAX_REWARD_LOOKUP_KEYS = 50;

/** 查不到的組隔多久再查（ulrmap 的表會慢慢補）。 */
export const REWARD_LOOKUP_RETRY_MS = 30 * 60 * 1000;

export interface RewardLookupKey {
  monsterId: number;
  rarity: number;
  mapIndex: number;
}

export function rewardLookupKey(k: RewardLookupKey): string {
  return `${k.monsterId}:${k.rarity}:${k.mapIndex}`;
}

const FRAGMENT_BY_NAME: readonly (readonly [RegExp, RaidFragmentKey])[] = [
  [/記憶|记忆/, "memory"],
  [/時間|时间/, "time"],
  [/靈魂|灵魂/, "soul"],
  [/生命/, "life"],
  [/死亡/, "death"],
];

/** 渦幣 → 同一格的碎片。⚠ 白金要排在金前面（「白金」也含「金」）。 */
const FRAGMENT_BY_COIN: readonly (readonly [RegExp, RaidFragmentKey])[] = [
  [/白金/, "death"],
  [/鐵|铁/, "memory"],
  [/銅|铜/, "time"],
  [/銀|银/, "soul"],
  [/金/, "life"],
];

/**
 * ulrmap 的回應 → 組 → 碎片（排名獎勵裡第一個 `cmem`；沒有碎片的話第一個 `ccoin`，渦 I 那種）。
 * 壞的回應回空表。
 */
export function parseRewardLookup(body: unknown): Map<string, RaidFragmentKey> {
  const out = new Map<string, RaidFragmentKey>();
  if (!Array.isArray(body)) return out;
  for (const raw of body) {
    const e = raw as {
      monsterId?: unknown;
      rarity?: unknown;
      mapIndex?: unknown;
      rewards?: unknown;
    };
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.monsterId !== "number" ||
      typeof e.rarity !== "number" ||
      typeof e.mapIndex !== "number" ||
      !Array.isArray(e.rewards)
    ) {
      continue;
    }
    const ranking = (e.rewards as Record<string, unknown>[])
      .filter((x) => x !== null && typeof x === "object" && x.rewardType === "ranking")
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
    const hit =
      firstOf(ranking, "cmem", FRAGMENT_BY_NAME) ?? firstOf(ranking, "ccoin", FRAGMENT_BY_COIN);
    if (hit !== null) {
      out.set(
        rewardLookupKey({ monsterId: e.monsterId, rarity: e.rarity, mapIndex: e.mapIndex }),
        hit,
      );
    }
  }
  return out;
}

/** 排好的排名獎勵裡，第一個這一類、名字認得的。 */
function firstOf(
  ranking: readonly Record<string, unknown>[],
  bucket: string,
  names: readonly (readonly [RegExp, RaidFragmentKey])[],
): RaidFragmentKey | null {
  for (const x of ranking) {
    if (x.itemBucket !== bucket) continue;
    const name = typeof x.itemName === "string" ? x.itemName : "";
    const hit = names.find(([re]) => re.test(name));
    if (hit !== undefined) return hit[1];
  }
  return null;
}

/**
 * 渦幾。先看 BOSS 代碼（照 Moon/打渦.py 的 渦階()）：尾碼 `_01/_02/_03` 是渦I／渦II·III／渦IV；
 * 妖精（mc1004）兩邊都有，★5 是渦IV、其他是渦II·III；吸血女王（mc1005）只有渦I。
 * 代碼看不出來（沒有代碼、妖精還不知道 ★）才退回人數上限。
 */
export function raidFeedTierOf(
  r: Pick<RaidFeedIn, "mons" | "rarity" | "memberLimit">,
): "I" | "II/III" | "IV" | null {
  const mons = r.mons ?? null;
  if (mons !== null) {
    const [kind, stage] = mons.split("_");
    if (kind === "mc1004") {
      if (r.rarity === 5) return "IV";
      if (r.rarity !== null) return "II/III";
    } else if (kind === "mc1005") {
      return "I";
    } else if (stage === "01") {
      return "I";
    } else if (stage === "02") {
      return "II/III";
    } else if (stage === "03") {
      return "IV";
    }
  }
  return raidFeedTier(r.memberLimit);
}

/** 人數上限 → 渦的等級（舊 bot 的 fallback 對照）。對不上回 null。 */
export function raidFeedTier(memberLimit: number | null): "I" | "II/III" | "IV" | null {
  if (memberLimit === 80) return "I";
  if (memberLimit === 100) return "II/III";
  if (memberLimit === 120) return "IV";
  return null;
}

/** BOSS 名 → [簡稱, emoji]。從舊 bot 的 `monster_rules.py` 搬來。 */
const BOSS_DISPLAY: Record<string, readonly [string, string]> = {
  赤死獸: ["狗", "🐶"],
  黑死獸: ["狗", "🐶"],
  瘟疫: ["狗", "🐶"],
  啃食者: ["蟲", "🐛"],
  屠殺者: ["蟲", "🐛"],
  爬行者: ["蟲", "🐛"],
  深沉之者: ["海", "🐙"],
  誘引之者: ["海", "🐙"],
  深奧之者: ["海", "🐙"],
  深奥之者: ["海", "🐙"],
  赑屃: ["龜", "🐢"],
  贔屭: ["龜", "🐢"],
  贔屓: ["龜", "🐢"],
  靈龜: ["龜", "🐢"],
  玄帝: ["龜", "🐢"],
  龍魚: ["魚", "🐟"],
  龙鱼: ["魚", "🐟"],
  龍鯰: ["魚", "🐟"],
  龙鲶: ["魚", "🐟"],
  龍鯇: ["魚", "🐟"],
  龍鯉: ["魚", "🐟"],
  龙鲤: ["魚", "🐟"],
};

// ---------------------------------------------------------------------------
// BOSS 狀態的短字（照舊 bot 的 `status_text.py`；順序也照它）
// ---------------------------------------------------------------------------

const STATUS_SHORT: Record<string, string> = {
  huin: "封",
  bers: "狂",
  mahi: "麻",
  stun: "暈",
  defD: "防-",
  atkD: "攻-",
  movD: "移-",
  scare: "恐",
  poison: "毒",
  poison2: "猛",
  dbuff: "低",
  atkB: "攻+",
  defB: "防+",
  movB: "移+",
  chaos: "混",
  bind: "咒",
  stigma: "聖",
  sticka: "棍攻",
  stickd: "棍防",
  curse: "詛",
  jikai: "壞",
  critical: "臨",
  control: "操",
  dark: "斷",
  immo: "不",
  rege: "再",
  target: "標",
};
const STATUS_ORDER = Object.keys(STATUS_SHORT);

/**
 * `麻 移-9 詛9`。`now` 有給就不列已經過期的（沒有到期時刻的照列）。認不得的狀態丟掉。
 */
export function formatRaidFeedStates(states: readonly RaidFeedState[], now?: number): string {
  const out: { order: number; text: string }[] = [];
  for (const st of states) {
    if (now !== undefined && st.until !== null && st.until <= now) continue;
    const m = /^([A-Za-z]+?)(\d*)$/.exec(st.type);
    const base = st.type in STATUS_SHORT ? st.type : (m?.[1] ?? st.type);
    const short = STATUS_SHORT[base];
    if (short === undefined) continue;
    const level = base === st.type ? "" : (m?.[2] ?? "");
    const num = base === "poison2" ? "" : st.count !== null ? String(st.count) : level;
    out.push({ order: STATUS_ORDER.indexOf(base), text: `${short}${num}` });
  }
  return out
    .sort((a, b) => a.order - b.order)
    .map((x) => x.text)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Discord 文字（照舊 bot 的 `raid_notification_text.py`）
// ---------------------------------------------------------------------------

/**
 * BOSS 現在開著的被動（硬化、夜霧…，見 `raid-passive.ts`），`硬化`；沒有是空字串。
 * 時間制的要 `now`。
 */
export function formatRaidFeedPassive(
  r: Pick<RaidFeedIn, "mons" | "name" | "hp" | "hpMax">,
  now?: number,
): string {
  return activeRaidPassives(raidPassiveIdsOf(r), r.hp, r.hpMax, now)
    .map((p) => p.short)
    .join(" ");
}

/**
 * 一行：`發現者 紅海🔴🐙 12000/20000｜✨6★｜夜霧｜麻 移-9`。`now` 給了就不列過期的狀態、
 * 也才標時間制的被動（硬化／吸收）。
 */
export function formatRaidFeedLine(
  r: RaidFeedIn & { lookupFragment?: RaidFragmentKey | null },
  now?: number,
): string {
  const name = r.name ?? "未知";
  const boss = BOSS_DISPLAY[name];
  const dead = r.hp !== null && r.hp <= 0 ? "☠️" : "";
  // 到期了還沒被打倒：⌛（`now` 有給才判斷）
  const expired = dead === "" && now !== undefined && r.limit <= now ? "⌛" : "";
  const fragment = raidFeedFragment(r);
  let raid: string;
  if (fragment !== null) {
    const f = FRAGMENT_DISPLAY[fragment];
    raid = `${f.short}${boss?.[0] ?? name}${f.icon}${boss?.[1] ?? "❓"}${dead}${expired}`;
  } else if (boss !== undefined) {
    raid = `❓${boss[0]}${boss[1]}${dead}${expired}`;
  } else {
    raid = `❓${dead}${expired} ${name}`;
  }
  const hp = r.hp !== null && r.hpMax !== null ? ` ${r.hp}/${r.hpMax}` : "";
  const rarity = r.rarity !== null && r.rarity > 1 ? `｜✨${r.rarity}★` : "";
  // 死了、到期了，狀態與被動就沒意義了
  const alive = dead === "" && expired === "";
  const passive = alive ? formatRaidFeedPassive(r, now) : "";
  const states = alive && r.states ? formatRaidFeedStates(r.states, now) : "";
  return `${r.founder} ${raid}${hp}${rarity}${passive === "" ? "" : `｜${passive}`}${states === "" ? "" : `｜${states}`}`;
}

/** 一批：一個就一行，多個加標題。`roleId` 有給就在最後一行 mention。 */
export function formatRaidFeedBatch(
  raids: readonly (RaidFeedIn & { lookupFragment?: RaidFragmentKey | null })[],
  roleId: string | null,
  now?: number,
): string {
  const lines = raids.map((r) => formatRaidFeedLine(r, now));
  const body =
    lines.length === 1
      ? `🆕 ${lines[0]}`
      : [`🆕 新增 ${lines.length} 個公開渦`, ...lines].join("\n");
  return roleId === null ? body : `${body}\n<@&${roleId}>`;
}

// ---------------------------------------------------------------------------
// 帳本（純記憶體；Worker 負責存檔與打 Discord）
// ---------------------------------------------------------------------------

/** 收一份上傳之後，要存檔的東西。 */
export interface RaidFeedChanges {
  raids: string[];
  messages: string[];
}

export class RaidFeedBook {
  #raids = new Map<string, RaidFeedEntry>();
  #messages = new Map<string, RaidFeedMessage>();

  constructor(raids: readonly RaidFeedEntry[] = [], messages: readonly RaidFeedMessage[] = []) {
    for (const r of raids) this.#raids.set(raidFeedId(r), r);
    for (const m of messages) this.#messages.set(m.id, m);
  }

  get size(): number {
    return this.#raids.size;
  }

  raid(id: string): RaidFeedEntry | undefined {
    return this.#raids.get(id);
  }

  message(id: string): RaidFeedMessage | undefined {
    return this.#messages.get(id);
  }

  /**
   * 收一份上傳。回傳**要寫 storage 的**渦與訊息 —— 只有 HP／人數變了的不算
   * （那些每 30 秒都在變，全部寫的話會吃光寫入額度；DO 被回收時丟了也只是 HP 舊一點）。
   */
  ingest(upload: RaidFeedUpload, now: number): RaidFeedChanges {
    const changes: RaidFeedChanges = { raids: [], messages: [] };
    for (const { founderFriend, onlyFriend, seenInSupport, ...r } of upload.raids) {
      const id = raidFeedId(r);
      const old = this.#raids.get(id);
      // 這一筆證明它是公開的：非好友在 SUPPORT 看到、發現者按送出（頁面只記「無限制」的）、
      // 或好友在 SUPPORT 看過（＝送出了）、加入後清單上不是僅限好友
      const proven =
        upload.source === "publish" ||
        (upload.source === "support" && founderFriend === false) ||
        (upload.source === "own" && onlyFriend === false && seenInSupport === true);
      if (old === undefined) {
        // 只有證明公開的能新增（自己的清單、好友的 SUPPORT 都可能有僅限好友的渦）
        if (!proven) continue;
        // 已經死掉的不公告。渦幾都發（舊 bot 不發渦 I；2026-10-04 改成公開的一律發）
        const skip = r.hp !== null && r.hp <= 0;
        this.#raids.set(id, {
          ...r,
          firstSeenAt: now,
          seenAt: now,
          status: skip ? "skipped" : "pending",
          messageId: null,
        });
        changes.raids.push(id);
        continue;
      }
      if (upload.source === "own" && onlyFriend === true && old.friendOnly !== true) {
        this.#hide(id, old, changes);
      } else if (proven && old.friendOnly === true) {
        this.#unhide(id, old, changes);
      }
      const before = raidFeedFragment(old);
      const next: RaidFeedEntry = { ...old, seenAt: now, limit: r.limit };
      // 有值才蓋：SUPPORT 沒有 ★／stage、自己的清單沒有人數
      for (const k of [
        "name",
        "monsterId",
        "mons",
        "hp",
        "hpMax",
        "memberLength",
        "memberLimit",
        "rarity",
        "level",
        "stage",
        "mapIndex",
      ] as const) {
        if (r[k] !== null) (next as unknown as Record<string, unknown>)[k] = r[k];
      }
      // 狀態：比手上那份新（開打得比較晚）才換
      const newerStates =
        r.states !== null && r.statesAt !== null && r.statesAt > (old.statesAt ?? -1);
      if (newerStates) {
        next.states = r.states;
        next.statesAt = r.statesAt;
      }
      // 到期時刻往前跳 = 死了（伺服器改成「死亡＋10 分」）；HP 沒帶的話也當 0
      if (next.limit < old.limit - LIMIT_DROP_MS && !(r.hp !== null && r.hp > 0)) next.hp = 0;
      const wasDead = old.hp !== null && old.hp <= 0;
      const isDead = next.hp !== null && next.hp <= 0;
      const died = isDead && !wasDead;
      // 判成不見了之後又在 SUPPORT／清單上看到活的：判錯了，改回來
      const revived = wasDead && !isDead;
      // 沒發過、也不是發失敗的（以前的渦 I、第一次看到就死了但其實活著）：還活著就補發
      const repost =
        old.status === "skipped" &&
        old.messageId === null &&
        old.failed !== true &&
        old.friendOnly !== true &&
        !isDead &&
        next.limit > now;
      if (repost) next.status = "pending";
      this.#raids.set(id, next);
      const persisted =
        repost ||
        next.rarity !== old.rarity ||
        next.level !== old.level ||
        next.stage !== old.stage ||
        next.mapIndex !== old.mapIndex ||
        next.limit !== old.limit ||
        newerStates ||
        died ||
        revived;
      if (persisted) changes.raids.push(id);
      // 有事才改訊息：碎片知道了、打倒了、看到新的狀態。只有 HP 變了不改（不然編輯紀錄一直洗）
      const statesChanged =
        newerStates && JSON.stringify(next.states) !== JSON.stringify(old.states ?? null);
      // HP 跨過門檻、被動換了（夜霧開了、潛伏換成濁濫）也算有事
      const passiveChanged = formatRaidFeedPassive(next) !== formatRaidFeedPassive(old);
      if (raidFeedFragment(next) !== before || died || revived || statesChanged || passiveChanged) {
        this.#markDirty(next, changes);
      } else if (next.hp !== old.hp || next.hpMax !== old.hpMax) {
        // 只有 HP 變了：也改，但同一則最多一分鐘一次（排在上次改之後一分鐘）
        this.#redrawSoon(next, now, changes);
      }
    }
    if (upload.complete) this.#markGone(upload, now, changes);
    return changes;
  }

  /**
   * 新鮮的整份 SUPPORT 裡沒有、上傳的人自己清單上也沒有 = 不見了，當作打倒（HP 記成 0）。
   * 不判斷的：剛發現的（{@link RAID_FEED_GONE_GRACE_MS} 內，可能還沒進清單）、已經到期的
   * （那是 ⌛ 不是 ☠️）、最後一次看到時滿人的（不確定滿人的渦會不會從 SUPPORT 消失）。
   * 判錯了沒關係：之後又看到活的會改回來（`revived`）。
   */
  #markGone(upload: RaidFeedUpload, now: number, changes: RaidFeedChanges): void {
    const seen = new Set([...upload.raids, ...upload.present].map(raidFeedId));
    for (const [id, r] of this.#raids) {
      // 僅限好友的：非好友的 SUPPORT 本來就看不到
      if (seen.has(id) || r.friendOnly === true) continue;
      if (r.hp !== null && r.hp <= 0) continue;
      if (r.limit <= now || r.foundAt > now - RAID_FEED_GONE_GRACE_MS) continue;
      if (r.memberLength !== null && r.memberLimit !== null && r.memberLength >= r.memberLimit) {
        continue;
      }
      r.hp = 0;
      changes.raids.push(id);
      this.#markDirty(r, changes);
    }
  }

  /** 讀到它僅限好友：還沒發的不發；發了的那則訊息重畫（拿掉這一行，整則都是就刪，見 {@link isHidden}）。 */
  #hide(id: string, r: RaidFeedEntry, changes: RaidFeedChanges): void {
    r.friendOnly = true;
    if (r.status === "pending") r.status = "skipped";
    changes.raids.push(id);
    this.#markDirty(r, changes);
  }

  /**
   * 又證明是公開的了：放回來。訊息還在就重畫把那一行加回去；訊息被刪了（`messageId` 是 null）
   * 交給 `ingest` 的補發。
   */
  #unhide(id: string, r: RaidFeedEntry, changes: RaidFeedChanges): void {
    delete r.friendOnly;
    changes.raids.push(id);
    this.#markDirty(r, changes);
  }

  /** HP 變了：離上次改超過一分鐘就馬上改，不然排在上次改之後一分鐘。 */
  #redrawSoon(r: RaidFeedEntry, now: number, changes: RaidFeedChanges): void {
    if (r.messageId === null) return;
    const m = this.#messages.get(r.messageId);
    if (m === undefined || m.dirty) return;
    const due = (m.renderedAt ?? 0) + RAID_FEED_HP_REDRAW_MS;
    if (due <= now) {
      this.#markDirty(r, changes);
    } else if (m.stateExpiry === null || m.stateExpiry === undefined || due < m.stateExpiry) {
      m.stateExpiry = due;
      changes.messages.push(m.id);
    }
  }

  /** 這個渦已經發出去的話，那則訊息標成要重畫。 */
  #markDirty(r: RaidFeedEntry, changes: RaidFeedChanges): void {
    if (r.messageId === null) return;
    const m = this.#messages.get(r.messageId);
    if (m !== undefined && !m.dirty) {
      m.dirty = true;
      changes.messages.push(m.id);
    }
  }

  /** 該發的這一批（最早的 pending 已經等滿批次窗）；還沒到回 `[]`。 */
  dueBatch(now: number): RaidFeedEntry[] {
    const pending = [...this.#raids.values()].filter((r) => r.status === "pending");
    if (pending.length === 0) return [];
    const first = Math.min(...pending.map((r) => r.firstSeenAt));
    if (first + RAID_FEED_BATCH_MS > now) return [];
    return pending.sort((a, b) => a.foundAt - b.foundAt);
  }

  /** 這一批發出去了。回傳新的訊息（要存檔）。 */
  markPosted(
    ids: readonly string[],
    messageId: string,
    mention: boolean,
    now?: number,
  ): RaidFeedMessage {
    let until = 0;
    for (const id of ids) {
      const r = this.#raids.get(id);
      if (r === undefined) continue;
      r.status = "posted";
      r.messageId = messageId;
      until = Math.max(until, r.limit);
    }
    const m: RaidFeedMessage = { id: messageId, raids: [...ids], mention, until, dirty: false };
    m.stateExpiry = now === undefined ? null : this.#stateExpiryOf(m, now);
    m.renderedAt = now ?? null;
    this.#messages.set(messageId, m);
    return m;
  }

  /**
   * 這則訊息下一次要自己重畫的時刻：顯示著的狀態最早到期的那一刻、還活著的渦到期
   * （要標 ⌛）的那一刻、或時間制的被動換班（狗每 10 分鐘一次）。死了的渦都不顯示。
   */
  #stateExpiryOf(m: RaidFeedMessage, now: number): number | null {
    let next: number | null = null;
    const at = (t: number) => {
      if (t > now) next = next === null ? t : Math.min(next, t);
    };
    for (const id of m.raids) {
      const r = this.#raids.get(id);
      if (r === undefined || (r.hp !== null && r.hp <= 0)) continue;
      at(r.limit);
      if (r.limit <= now) continue;
      for (const st of r.states ?? []) if (st.until !== null) at(st.until);
      const shift = nextRaidPassiveChange(raidPassiveIdsOf(r), now);
      if (shift !== null) at(shift);
    }
    return next;
  }

  /** 狀態到期的訊息標成要重畫（沒人帶新的狀態來，就把過期的拿掉）。回傳要存檔的。 */
  expireStates(now: number): RaidFeedChanges {
    const changes: RaidFeedChanges = { raids: [], messages: [] };
    for (const m of this.#messages.values()) {
      if (m.dirty || m.stateExpiry === null || m.stateExpiry === undefined) continue;
      if (m.stateExpiry <= now) {
        m.dirty = true;
        changes.messages.push(m.id);
      }
    }
    return changes;
  }

  /** 重畫完了：清掉 dirty、算下一個狀態到期的時刻。 */
  rendered(m: RaidFeedMessage, now: number): void {
    m.dirty = false;
    m.renderedAt = now;
    m.stateExpiry = this.#stateExpiryOf(m, now);
  }

  /** 發不出去（webhook 壞了）：這一批不發了。 */
  markSkipped(ids: readonly string[]): void {
    for (const id of ids) {
      const r = this.#raids.get(id);
      if (r !== undefined) {
        r.status = "skipped";
        r.failed = true;
      }
    }
  }

  /** 要重畫的訊息。 */
  dirtyMessages(): RaidFeedMessage[] {
    return [...this.#messages.values()].filter((m) => m.dirty);
  }

  /** 整則重畫（帳本上已經丟掉的渦、僅限好友的渦就少一行）。 */
  renderMessage(m: RaidFeedMessage, roleId: string | null, now?: number): string | null {
    const raids = m.raids
      .map((id) => this.#raids.get(id))
      .filter((r): r is RaidFeedEntry => r !== undefined && r.friendOnly !== true);
    if (raids.length === 0) return null;
    return formatRaidFeedBatch(raids, m.mention ? roleId : null, now);
  }

  /**
   * 這則訊息剩下的渦全是僅限好友的：要整則刪掉（不能留一則空的或只剩標題）。
   * 帳本上已經丟掉的（到期了）不算，那種是自然結束，訊息留著。
   */
  isHidden(m: RaidFeedMessage): boolean {
    const raids = m.raids.map((id) => this.#raids.get(id)).filter((r) => r !== undefined);
    return raids.length > 0 && raids.every((r) => r.friendOnly === true);
  }

  /**
   * Discord 上那則刪掉了：裡面的渦當作沒發過（之後證明公開會補發新的一則）。
   * 回傳要存檔的渦；訊息本身要從 storage 刪（`messages`）。
   */
  dropMessage(id: string): RaidFeedChanges {
    const changes: RaidFeedChanges = { raids: [], messages: [] };
    const m = this.#messages.get(id);
    if (m === undefined) return changes;
    for (const rid of m.raids) {
      const r = this.#raids.get(rid);
      if (r === undefined || r.messageId !== id) continue;
      r.messageId = null;
      r.status = "skipped";
      changes.raids.push(rid);
    }
    this.#messages.delete(id);
    changes.messages.push(id);
    return changes;
  }

  /** 丟掉到期的渦與不會再改的訊息。回傳被丟的 id（要從 storage 刪）。 */
  prune(now: number): RaidFeedChanges {
    const out: RaidFeedChanges = { raids: [], messages: [] };
    for (const [id, r] of this.#raids) {
      if (r.limit + RAID_FEED_KEEP_AFTER_LIMIT_MS <= now && r.status !== "pending") {
        this.#raids.delete(id);
        out.raids.push(id);
      }
    }
    for (const [id, m] of this.#messages) {
      if (m.until + RAID_FEED_KEEP_AFTER_LIMIT_MS <= now) {
        this.#messages.delete(id);
        out.messages.push(id);
      }
    }
    if (this.#raids.size > RAID_FEED_CAPACITY) {
      const oldest = [...this.#raids.values()]
        .sort((a, b) => a.foundAt - b.foundAt)
        .slice(0, this.#raids.size - RAID_FEED_CAPACITY);
      for (const r of oldest) {
        const id = raidFeedId(r);
        this.#raids.delete(id);
        out.raids.push(id);
      }
    }
    return out;
  }

  /** 下一次該醒來的時刻：有 pending 就是它的批次窗結束、有要改的訊息就是馬上，否則下次清理。 */
  nextWake(now: number): number | null {
    let next: number | null = null;
    const at = (t: number) => {
      next = next === null ? t : Math.min(next, t);
    };
    for (const r of this.#raids.values()) {
      if (r.status === "pending") at(r.firstSeenAt + RAID_FEED_BATCH_MS);
    }
    if (this.dirtyMessages().length > 0 || this.needsLookup(now).length > 0) at(now);
    for (const m of this.#messages.values()) {
      if (m.stateExpiry !== null && m.stateExpiry !== undefined) at(m.stateExpiry);
    }
    if (next === null && (this.#raids.size > 0 || this.#messages.size > 0)) {
      at(now + RAID_FEED_KEEP_AFTER_LIMIT_MS);
    }
    return next;
  }

  /**
   * 該查 ulrmap 的組：怪／★／區塊都知道、碎片還不知道，而且這一組沒查過
   * （或上次沒查到、已經過了 {@link REWARD_LOOKUP_RETRY_MS}）。同一組只列一次。
   */
  needsLookup(now: number): RewardLookupKey[] {
    const out = new Map<string, RewardLookupKey>();
    for (const r of this.#raids.values()) {
      if (r.limit <= now || raidFeedFragment(r) !== null) continue;
      const mapIndex = r.mapIndex ?? null;
      if (r.monsterId === null || r.rarity === null || mapIndex === null) continue;
      const k = { monsterId: r.monsterId, rarity: r.rarity, mapIndex };
      const key = rewardLookupKey(k);
      if (r.lookupKey === key && (r.lookupAt ?? 0) + REWARD_LOOKUP_RETRY_MS > now) continue;
      out.set(key, k);
    }
    return [...out.values()].slice(0, MAX_REWARD_LOOKUP_KEYS);
  }

  /**
   * 收查表結果。`asked` 是這次查的組（查了沒回的就是表裡沒有，記下來過一陣子再查）。
   * 碎片因此變了、而且已經發出去的訊息標成要重畫。回傳要存檔的。
   */
  applyLookup(
    asked: readonly RewardLookupKey[],
    found: ReadonlyMap<string, RaidFragmentKey>,
    now: number,
  ): RaidFeedChanges {
    const keys = new Set(asked.map(rewardLookupKey));
    const changes: RaidFeedChanges = { raids: [], messages: [] };
    for (const [id, r] of this.#raids) {
      const mapIndex = r.mapIndex ?? null;
      if (r.monsterId === null || r.rarity === null || mapIndex === null) continue;
      const key = rewardLookupKey({ monsterId: r.monsterId, rarity: r.rarity, mapIndex });
      if (!keys.has(key)) continue;
      const before = raidFeedFragment(r);
      r.lookupKey = key;
      r.lookupAt = now;
      r.lookupFragment = found.get(key) ?? null;
      changes.raids.push(id);
      if (raidFeedFragment(r) !== before) this.#markDirty(r, changes);
    }
    return changes;
  }

  /** GET：還沒到期的渦，發現時刻新的在前。 */
  list(now: number): RaidFeedView[] {
    const out: RaidFeedView[] = [];
    for (const r of this.#raids.values()) {
      // 僅限好友的不給讀（GET 是公開的）
      if (r.limit <= now || r.friendOnly === true) continue;
      out.push({
        founder: r.founder,
        foundAt: r.foundAt,
        limit: r.limit,
        name: r.name,
        monsterId: r.monsterId,
        mons: r.mons ?? null,
        hp: r.hp,
        hpMax: r.hpMax,
        memberLength: r.memberLength,
        memberLimit: r.memberLimit,
        rarity: r.rarity,
        level: r.level,
        stage: r.stage,
        mapIndex: r.mapIndex ?? null,
        states: r.states ?? null,
        statesAt: r.statesAt ?? null,
        seenAt: r.seenAt,
        fragment: raidFeedFragment(r),
      });
    }
    return out.sort((a, b) => b.foundAt - a.foundAt);
  }
}
