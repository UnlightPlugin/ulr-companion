/**
 * 共享渦狀態：插件之間互通 BOSS 身上的狀態與 TL
 * ============================================
 * 玩家 2026-09-13：「玩家有開插件，親自打渦的話，可以把 BOSS 渦上傳到
 * cloudflare，讓所有人共用 BOSS 狀態。」
 *
 * 渦房 SUPPORT 清單上的公開渦，伺服器只給 7 欄（沒有 TL、沒有狀態）。
 * 要知道就得先加入 —— 而**已經加入的人插件裡就有完整的 `db_raid`**。
 * 所以：加入了的人把自己清單上的渦傳上去，還沒加入的人拿渦碼去查。
 *
 * ```
 *   插件 A（渦清單有 X）── POST /raids {key: H(X), tl, states…} ──▶ RaidBoard
 *   插件 B（SUPPORT 上看到 X）── GET /raids?keys=H(X) ─────────────▶ RaidBoard
 * ```
 *
 * ## ⚠ 雲端上沒有渦碼，只有渦碼的雜湊
 *
 * 渦碼等於門票：拿到就能加入。很多渦碼只在某個 Discord 頻道裡流通，
 * **不能因為有人開了插件就變成全世界都讀得到**。所以 key 是
 * `SHA-256(渦碼)` 的前 16 個十六進位字元：
 *
 *   · 上傳的人本來就知道渦碼；查的人也必須先知道渦碼（從自己的 SUPPORT
 *     清單上看到的）才算得出 key
 *   · 雲端被整批讀走也拿不回渦碼：渦碼是 12 位英數，62^12 ≈ 3×10²¹，
 *     暴力反推不實際
 *   · GET 只回問到的那幾把 key，**沒有「列出全部」這條路**
 *
 * ## 上傳什麼
 *
 * 只有畫圖示要用的：TL、rarity、stage、mons、HP、到期時刻、狀態。
 * **不傳分數榜**（玩家名字）、不傳發現者、不傳任何帳號識別。
 *
 * ## 信任
 *
 * 誰都能 POST，雲端驗不了真假。能做的是**形狀驗證**（這一份）與**限流**
 * （Worker 那邊的令牌桶）。假資料的後果是某個人的 SUPPORT 清單上圖示畫錯
 * 一陣子 —— 不影響任何遊戲行為，而且自己清單上的渦永遠用伺服器的真資料。
 *
 * ⚠ 這一份**不 import 任何 Node 模組**：Worker 與插件共用，雜湊用 Web Crypto
 * （`crypto.subtle`，Node 20 與 Workers 都有）。
 */

export const RAID_SHARE_PATH = "/raids";

/** key 長度：SHA-256 的前 16 個十六進位字元（跟房號同一個長度）。 */
export const RAID_SHARE_KEY_LENGTH = 16;

/** POST 的 body 上限。20 個渦 × 16 個狀態，實測遠小於 8 KB。 */
export const MAX_RAID_SHARE_BODY_BYTES = 16_384;

export const MAX_RAIDS_PER_POST = 20;

/** 一次 GET 最多問幾把 key。SUPPORT 一頁 12 列，給兩頁的量。 */
export const MAX_RAID_SHARE_KEYS = 24;

export const MAX_RAID_STATES = 16;

/** 渦的有效時間是幾個小時；到期時刻離現在超過一天的一律當假資料。 */
export const RAID_SHARE_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** 看板上最多放幾筆。超過就先丟最久沒更新的。 */
export const RAID_BOARD_CAPACITY = 5_000;

export interface SharedRaidState {
  type: string;
  /** 到期時刻（遊戲伺服器的 ms）；沒有到期時刻的狀態是 null */
  until: number | null;
  /** 詛咒那種層數 */
  count: number | null;
}

/** 上傳的一筆（還沒蓋時間戳）。 */
export interface SharedRaidUpload {
  key: string;
  tl: number | null;
  rarity: number | null;
  stage: number | null;
  mons: string | null;
  hp: number | null;
  hpMax: number | null;
  /** 渦的到期時刻 */
  limit: number;
  states: SharedRaidState[];
}

/** 看板上的一筆。`seenAt` 是**雲端**收到的時刻，不信任客戶端的時鐘。 */
export interface SharedRaid extends SharedRaidUpload {
  seenAt: number;
}

/** 渦碼 → key。渦碼前後空白不算。 */
export async function raidShareKey(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, RAID_SHARE_KEY_LENGTH);
}

export function isRaidShareKey(v: unknown): v is string {
  return typeof v === "string" && v.length === RAID_SHARE_KEY_LENGTH && /^[0-9a-f]+$/.test(v);
}

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function state(v: unknown, now: number): SharedRaidState | null {
  const o = v as { type?: unknown; until?: unknown; count?: unknown } | null;
  if (o === null || typeof o !== "object") return null;
  if (typeof o.type !== "string" || !/^[A-Za-z]{2,12}\d{0,2}$/.test(o.type)) return null;
  const until =
    o.until === null || o.until === undefined
      ? null
      : int(o.until, now - 60_000, now + RAID_SHARE_MAX_AHEAD_MS);
  if (o.until !== null && o.until !== undefined && until === null) return null;
  const count = o.count === null || o.count === undefined ? null : int(o.count, 0, 999);
  return { type: o.type, until, count };
}

/**
 * POST body → 一份乾淨的清單。**整份不合格回 `null`**（400）；個別一筆
 * 不合格就丟那一筆。已經到期的渦直接丟。
 */
export function normalizeRaidUpload(body: unknown, now: number): SharedRaidUpload[] | null {
  const b = body as { raids?: unknown } | null;
  if (b === null || typeof b !== "object" || !Array.isArray(b.raids)) return null;
  if (b.raids.length > MAX_RAIDS_PER_POST) return null;
  const out: SharedRaidUpload[] = [];
  for (const raw of b.raids) {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || !isRaidShareKey(r.key)) continue;
    const limit = int(r.limit, now, now + RAID_SHARE_MAX_AHEAD_MS);
    if (limit === null) continue;
    const mons = typeof r.mons === "string" && /^mc\d{4}(_\d{2})?$/.test(r.mons) ? r.mons : null;
    const states: SharedRaidState[] = [];
    if (Array.isArray(r.states)) {
      for (const s of r.states.slice(0, MAX_RAID_STATES)) {
        const ok = state(s, now);
        if (ok !== null) states.push(ok);
      }
    }
    out.push({
      key: r.key,
      tl: int(r.tl, 0, 100_000),
      rarity: int(r.rarity, 0, 10),
      stage: int(r.stage, 0, 100),
      mons,
      hp: int(r.hp, 0, 10_000_000),
      hpMax: int(r.hpMax, 1, 10_000_000),
      limit,
      states,
    });
  }
  return out;
}

/** `?keys=a,b,c` → key 清單。格式不對或太多回 `null`（400）。 */
export function parseRaidShareKeys(url: URL): string[] | null {
  const raw = url.searchParams.get("keys");
  if (raw === null || raw === "") return null;
  const keys = raw.split(",");
  if (keys.length > MAX_RAID_SHARE_KEYS) return null;
  if (!keys.every(isRaidShareKey)) return null;
  return [...new Set(keys)];
}

/**
 * 看板本體（純記憶體）。Worker 的 Durable Object 只是把它包起來。
 *
 * ⚠ **刻意不寫進 storage。** 狀態幾分鐘就過期，DO 被移出記憶體時整份丟掉
 * 也只是空幾十秒，下一個插件傳上來就補回來了；每次 POST 都寫 storage 的話，
 * 幾十個玩家每 30 秒一次就會吃光免費額度的寫入量。
 */
export class RaidBoard {
  #entries = new Map<string, SharedRaid>();

  get size(): number {
    return this.#entries.size;
  }

  /** 收下一批。同一把 key 以後到的為準（`seenAt` 是雲端時間，不會倒退）。 */
  upsert(list: readonly SharedRaidUpload[], now: number): number {
    for (const r of list) {
      // Map 的迭代順序是插入順序：先刪再放，最新的就排在最後，丟舊的時從頭丟。
      this.#entries.delete(r.key);
      this.#entries.set(r.key, { ...r, seenAt: now });
    }
    this.prune(now);
    return list.length;
  }

  lookup(keys: readonly string[], now: number): SharedRaid[] {
    const out: SharedRaid[] = [];
    for (const k of keys) {
      const r = this.#entries.get(k);
      if (r === undefined) continue;
      if (r.limit <= now) {
        this.#entries.delete(k);
        continue;
      }
      out.push({ ...r, states: r.states.filter((s) => s.until === null || s.until > now) });
    }
    return out;
  }

  prune(now: number): void {
    for (const [k, r] of this.#entries) if (r.limit <= now) this.#entries.delete(k);
    while (this.#entries.size > RAID_BOARD_CAPACITY) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// 打渦隊伍
//
// 玩家 2026-09-13：「插件玩家有開共享渦的話，可以再分享隊伍，點玩家可以看得到
// 打渦用的隊伍……新手玩家不知該用哪個隊伍，該花費多少AP來打。」預設開，
// 跟對戰房看得到別人牌組同一個道理；不想分享去插件面板關。
//
// ```
//   插件 A 打完一場 ─ POST /raid-teams {key: H(渦碼), player: H(渦碼, 名字), teams} ─▶ 看板
//   插件 B 點榜上的名字 ─ GET /raid-teams?keys=H(渦碼) ──────────────────────────▶ 看板
//   B 自己把榜上每個名字算一次 H(渦碼, 名字)，對得上的就是那個人的隊伍
// ```
//
// ## ⚠ 雲端上一樣沒有名字
//
// 玩家那一把 key 是「渦碼＋名字」一起雜湊：查的人本來就在排行榜上看得到名字，
// 自己算得出來；雲端被整批讀走也只有一堆雜湊，對不回名字，更對不回渦碼。
// 同一個人在不同渦的 key 也不一樣，串不起來「某某人打過哪些渦」。
//
// ## 一支隊伍 = 一副牌的內容 ＋ 用它打的累計
//
// 牌組內容就是 `db_deck*` 那 27 格（跟 `@ulr/deck-library` 的 DeckContent 同形狀），
// 累計是那個人插件自己量的：傷害與分數都是榜上自己那一列打完減開打前（伺服器歸屬給
// 他的數字，跟傷害統計同一套）。回合是伺服器收下的 turn_limit、AP 是 `ap_spend × 回合`
// （官方回合面板同一條算式）。⚠ 戰鬥中 dmgTo對手 的加總不能拿來當傷害：裡面有別人
// 掛的狀態跳血與 BOSS 自傷（2026-09-13 實測一場掉 56 血、榜上記 20）。
// ---------------------------------------------------------------------------

export const RAID_TEAMS_PATH = "/raid-teams";

/** 一個人在一個渦最多傳幾支隊伍（照傷害高的留）。 */
export const MAX_RAID_TEAMS_PER_PLAYER = 12;

/** 一次 POST 最多幾筆（一筆 = 一個渦裡的一個人）。 */
export const MAX_RAID_TEAM_ENTRIES_PER_POST = 10;

/** POST 的 body 上限。一支隊伍約 200 bytes，10 筆 × 12 支還在這裡面。 */
export const MAX_RAID_TEAMS_BODY_BYTES = 32_768;

/** 看板上最多放幾個人（所有渦加起來）。超過先丟最久沒更新的。 */
export const RAID_TEAM_BOARD_CAPACITY = 20_000;

const CARD_KEY = /^(cc|mc)\d{3,4}(_\d{2})?$/;

export interface SharedTeam {
  chara: (string | null)[];
  charaIndex: (number | null)[];
  weapon: (number | null)[];
  eventIndex: (number | null)[];
  /** 用這副打了幾場 */
  battles: number;
  /** 選的回合數加總 */
  turns: number;
  /** 花掉的 AP 加總 */
  ap: number;
  /** 打掉的傷害加總（排行榜上自己那一列的 damage，打完減開打前） */
  damage: number;
  /** 單場最高傷害（ulgg 的統計頁也列這個） */
  best: number;
  /** 榜上分數加總（排名獎勵看這個） */
  points: number;
}

/** 上傳的一筆：某個渦裡某個人的全部隊伍。 */
export interface SharedTeamsUpload {
  /** 渦的 key（跟 `/raids` 同一把） */
  key: string;
  /** `raidPlayerKey(渦碼, 名字)` */
  player: string;
  /** 渦的到期時刻；過了看板就丟 */
  limit: number;
  teams: SharedTeam[];
}

export interface SharedTeamsPlayer {
  player: string;
  teams: SharedTeam[];
  seenAt: number;
}

/** GET 回來的一個渦。 */
export interface SharedRaidTeams {
  key: string;
  players: SharedTeamsPlayer[];
}

/** 渦碼＋名字 → 玩家那一把 key。前綴 "team" 讓它跟渦的 key 不可能撞在一起。 */
export async function raidPlayerKey(code: string, name: string): Promise<string> {
  const bytes = new TextEncoder().encode(`team\n${code.trim()}\n${name}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, RAID_SHARE_KEY_LENGTH);
}

function slots<T>(v: unknown, length: number, ok: (x: unknown) => x is T): (T | null)[] | null {
  if (!Array.isArray(v) || v.length !== length) return null;
  const out: (T | null)[] = [];
  for (const x of v) {
    if (x === null) out.push(null);
    else if (ok(x)) out.push(x);
    else return null;
  }
  return out;
}

const isCardKey = (x: unknown): x is string => typeof x === "string" && CARD_KEY.test(x);
const isIndex = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 99_999;

function team(v: unknown): SharedTeam | null {
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== "object") return null;
  const chara = slots(o.chara, 3, isCardKey);
  const charaIndex = slots(o.charaIndex, 3, isIndex);
  const weapon = slots(o.weapon, 3, isIndex);
  const eventIndex = slots(o.eventIndex, 18, isIndex);
  if (chara === null || charaIndex === null || weapon === null || eventIndex === null) return null;
  if (chara.every((c) => c === null)) return null;
  const battles = int(o.battles, 1, 9_999);
  const turns = int(o.turns, 0, 999_999);
  const ap = int(o.ap, 0, 999_999);
  const damage = int(o.damage, 0, 100_000_000);
  const best = int(o.best, 0, 100_000_000);
  const points = int(o.points, 0, 1_000_000_000);
  if (
    battles === null ||
    turns === null ||
    ap === null ||
    damage === null ||
    best === null ||
    points === null
  ) {
    return null;
  }
  if (best > damage) return null;
  return { chara, charaIndex, weapon, eventIndex, battles, turns, ap, damage, best, points };
}

/** POST body → 乾淨的清單。整份不合格回 `null`；一筆不合格丟那一筆，一支不合格丟那一支。 */
export function normalizeTeamsUpload(body: unknown, now: number): SharedTeamsUpload[] | null {
  const b = body as { entries?: unknown } | null;
  if (b === null || typeof b !== "object" || !Array.isArray(b.entries)) return null;
  if (b.entries.length > MAX_RAID_TEAM_ENTRIES_PER_POST) return null;
  const out: SharedTeamsUpload[] = [];
  for (const raw of b.entries) {
    const e = raw as Record<string, unknown> | null;
    if (e === null || typeof e !== "object") continue;
    if (!isRaidShareKey(e.key) || !isRaidShareKey(e.player)) continue;
    const limit = int(e.limit, now, now + RAID_SHARE_MAX_AHEAD_MS);
    if (limit === null || !Array.isArray(e.teams)) continue;
    const teams: SharedTeam[] = [];
    for (const t of e.teams.slice(0, MAX_RAID_TEAMS_PER_PLAYER)) {
      const ok = team(t);
      if (ok !== null) teams.push(ok);
    }
    out.push({ key: e.key, player: e.player, limit, teams });
  }
  return out;
}

/**
 * 隊伍看板（記憶體那一層）。跟 `RaidBoard` 不同，Worker 會把**內容變了的**寫進
 * storage（`upsertChanges`）、重開後讀回來（`hydrate`）—— 隊伍的價值在分享的人
 * 下線之後，不能看板一被回收就沒了。細節在 link-worker 的 raid-board.ts。
 *
 * 同一個人同一個渦**整份取代**：傳上來的就是那個人現在的全部隊伍。
 * 傳空的 = 那個人關掉了分享 → 從看板上拿掉。
 */
export class RaidTeamBoard {
  /** 渦 key → 玩家 key → 那個人的隊伍 */
  #raids = new Map<string, { limit: number; players: Map<string, SharedTeamsPlayer> }>();
  /** 所有人一條 LRU，丟舊的時從頭丟 */
  #order = new Map<string, true>();

  get size(): number {
    return this.#order.size;
  }

  upsert(list: readonly SharedTeamsUpload[], now: number): number {
    this.upsertChanges(list, now);
    return list.length;
  }

  /**
   * 收下一批，回傳**內容真的變了**的那幾筆（隊伍不同、被撤掉、到期時刻延後）。
   * Worker 只把這些寫進 storage：同一個人每 30 秒重傳一份一模一樣的，不該每次都寫。
   */
  upsertChanges(list: readonly SharedTeamsUpload[], now: number): SharedTeamsUpload[] {
    const changed: SharedTeamsUpload[] = [];
    for (const e of list) {
      const id = `${e.key}:${e.player}`;
      let raid = this.#raids.get(e.key);
      const old = raid?.players.get(e.player);
      if (e.teams.length === 0) {
        if (old !== undefined) changed.push(e);
        raid?.players.delete(e.player);
        this.#order.delete(id);
        if (raid !== undefined && raid.players.size === 0) this.#raids.delete(e.key);
        continue;
      }
      if (raid === undefined) {
        raid = { limit: e.limit, players: new Map() };
        this.#raids.set(e.key, raid);
      }
      if (
        old === undefined ||
        e.limit > raid.limit ||
        JSON.stringify(old.teams) !== JSON.stringify(e.teams)
      ) {
        changed.push({ ...e, limit: Math.max(raid.limit, e.limit) });
      }
      raid.limit = Math.max(raid.limit, e.limit);
      raid.players.set(e.player, { player: e.player, teams: e.teams, seenAt: now });
      this.#order.delete(id);
      this.#order.set(id, true);
    }
    this.prune(now);
    return changed;
  }

  /**
   * 從 storage 讀回來的舊資料塞回記憶體。**記憶體裡已經有的人不蓋**（那份比較新）；
   * 已經到期的不收。
   */
  hydrate(rows: readonly (SharedTeamsUpload & { seenAt: number })[], now: number): void {
    for (const r of rows) {
      if (r.limit <= now || r.teams.length === 0) continue;
      let raid = this.#raids.get(r.key);
      if (raid?.players.has(r.player)) continue;
      if (raid === undefined) {
        raid = { limit: r.limit, players: new Map() };
        this.#raids.set(r.key, raid);
      }
      raid.limit = Math.max(raid.limit, r.limit);
      raid.players.set(r.player, { player: r.player, teams: r.teams, seenAt: r.seenAt });
      this.#order.set(`${r.key}:${r.player}`, true);
    }
    this.prune(now);
  }

  lookup(keys: readonly string[], now: number): SharedRaidTeams[] {
    const out: SharedRaidTeams[] = [];
    for (const k of keys) {
      const raid = this.#raids.get(k);
      if (raid === undefined) continue;
      if (raid.limit <= now) {
        this.#dropRaid(k);
        continue;
      }
      out.push({ key: k, players: [...raid.players.values()] });
    }
    return out;
  }

  prune(now: number): void {
    for (const [k, raid] of this.#raids) if (raid.limit <= now) this.#dropRaid(k);
    while (this.#order.size > RAID_TEAM_BOARD_CAPACITY) {
      const oldest = this.#order.keys().next().value;
      if (oldest === undefined) break;
      this.#order.delete(oldest);
      const [key, player] = oldest.split(":");
      const raid = this.#raids.get(key ?? "");
      if (raid === undefined) continue;
      raid.players.delete(player ?? "");
      if (raid.players.size === 0) this.#raids.delete(key ?? "");
    }
  }

  #dropRaid(key: string): void {
    const raid = this.#raids.get(key);
    if (raid === undefined) return;
    for (const p of raid.players.keys()) this.#order.delete(`${key}:${p}`);
    this.#raids.delete(key);
  }
}
