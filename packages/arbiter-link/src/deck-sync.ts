/**
 * 雲端牌組庫：插件與中間人之間的約定
 * ==================================
 * 玩家 2026-09-13：「使用的牌組要存到雲端，不同電腦登入同個角色時，要同步。用角色 ID。」
 *
 * 合併規則在 `@ulr/deck-library` 的 `merge.ts`、傳輸在托盤的 `deck-sync.ts`、
 * 存放在 `apps/link-worker` 的 `deck-vault.ts`。這一份只放**兩邊都要認的東西**：
 * 路徑、鍵的形狀、大小上限、回應的形狀。
 *
 * ```
 *   GET /decks/<key>                 → 200 {version, doc} ／ 404（還沒有）
 *       If-None-Match: "<version>"   → 304（沒變，省流量）
 *   PUT /decks/<key>  {doc}
 *       If-Match: "<version>"        → 200 {version}      ／ 409 {version, doc}（別台先寫了）
 *       If-Match: "0"                → 只在雲端還沒有時才寫（第一台電腦）
 * ```
 *
 * ## 鍵是「名稱 ＋ 註冊時間」的雜湊（2026-09-25 起）
 *
 * 鍵是 `SHA-256("ulr-deck-sync\n" + 玩家名稱 + "\n" + player.regist_at)` 的 64 個
 * 十六進位字元（`packages/cdp-adapter` 的 `deck-write.ts` 在頁面裡算）：
 *
 *   · 同一個角色在任何電腦上算出來都一樣 —— 兩樣都跟著角色走、改不了
 *   · 雲端反推不回名稱與註冊時間；拿到整批鍵也只是一堆雜湊
 *   · 知道鍵就能讀寫那份庫 —— 所以材料裡一定要有**別人拿不到**的東西。名稱是
 *     公開的；`regist_at` 是精確到毫秒的時間，好友清單、好友個人資料、排行榜都
 *     不帶它（對過實機），外人只能對雲端一個一個猜
 *
 * ⚠ 2026-09-25 以前是 `SHA-256(前綴 + player_id)`。改版後 `player_id` 變成每次
 * 登入都換的憑證，舊的鍵每次開遊戲都是一份新的空庫 —— 那些鍵已經沒有人會再算到。
 *
 * 跟本機存檔用的 8 hex 指紋**不是同一把**：那把只有 32 位元，拿來分檔名夠、拿來
 * 當雲端的門票不夠（列舉得完）。
 *
 * ## 為什麼有版本號
 *
 * 兩台電腦同時開著（家裡的電腦沒關、又在公司開）是會發生的。沒有版本號的 PUT 是
 * 「後寫的贏」，先寫那台的改動安靜消失。帶 `If-Match` 的話，晚到的那一台會拿到
 * 409 跟對方那份，重新合併再寫一次 —— 兩邊的改動都留下來。
 */

/** 路徑前綴。鍵接在後面：`/decks/<64 hex>`。 */
export const DECK_SYNC_PATH = "/decks";

/** 鍵的長度：SHA-256 的全部 64 個十六進位字元。 */
export const DECK_SYNC_KEY_LENGTH = 64;

/**
 * 一份庫最多多大。幾十副 × 四房 × 每副約 300 位元組（含縮排）≈ 50 KB；
 * 256 KB 是「玩家再瘋也裝不滿」的上限，超過就是有人在灌。
 */
export const MAX_DECK_SYNC_BODY_BYTES = 262_144;

/** 雜湊前綴。⚠ 改了等於換鍵，所有人的雲端庫都會「不見」。 */
export const DECK_SYNC_KEY_SALT = "ulr-deck-sync\n";

const KEY_RE = /^[0-9a-f]{64}$/;

export function isDeckSyncKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

/** `/decks/<key>` → key；形狀不對回 `null`。 */
export function parseDeckSyncPath(pathname: string): string | null {
  if (!pathname.startsWith(`${DECK_SYNC_PATH}/`)) return null;
  const key = pathname.slice(DECK_SYNC_PATH.length + 1);
  return isDeckSyncKey(key) ? key : null;
}

/** 讀到的那份。`version` 從 1 起跳，雲端每寫一次 +1。 */
export interface DeckSyncRecord {
  version: number;
  /** 文件本體。形狀由 `@ulr/deck-library` 的 `parseSyncDocument()` 驗，這裡不認。 */
  doc: unknown;
}

/** 從 `If-Match` / `If-None-Match` 讀版本號。沒帶或壞掉回 `null`。 */
export function parseVersionHeader(value: string | null): number | null {
  if (value === null) return null;
  const m = /^\s*(?:W\/)?"?(\d{1,12})"?\s*$/.exec(value);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** 版本號 → ETag 值。 */
export function versionEtag(version: number): string {
  return `"${version}"`;
}

/** 看板那邊要做的事：回什麼、要不要寫。**不碰 storage**，測得到。 */
export interface DeckSyncDecision {
  status: number;
  /** JSON 回應本體；`null` = 沒有本體（304）。 */
  body: unknown;
  /** 要寫進 storage 的新紀錄；`null` = 不寫。 */
  write: DeckSyncRecord | null;
}

/**
 * 一個請求進來，照雲端現有的那份決定怎麼回。
 *
 * - `GET`：沒有 → 404；`If-None-Match` 跟現在的版本一樣 → 304；否則 200 整份
 * - `PUT`：**一定要帶 `If-Match`**。沒帶 → 428（不接受「後寫的贏」，理由見檔頭）。
 *   版本對得上 → 寫、版本 +1；對不上 → 409 帶現在那份，讓插件重新合併
 *   （`If-Match: "0"` = 「我以為雲端還沒有」）
 *
 * `bodyText` 的大小入口已經擋過；這裡只管 JSON 與形狀（`doc` 要是物件）。
 */
export function decideDeckSync(
  method: string,
  headers: { get(name: string): string | null },
  bodyText: string,
  current: DeckSyncRecord | null,
): DeckSyncDecision {
  if (method === "GET") {
    if (current === null) return { status: 404, body: { error: "empty" }, write: null };
    const seen = parseVersionHeader(headers.get("if-none-match"));
    if (seen !== null && seen === current.version) return { status: 304, body: null, write: null };
    return { status: 200, body: current, write: null };
  }

  if (method === "PUT") {
    const expected = parseVersionHeader(headers.get("if-match"));
    if (expected === null)
      return { status: 428, body: { error: "if-match required" }, write: null };
    const have = current?.version ?? 0;
    if (expected !== have) {
      return {
        status: 409,
        body: current ?? { version: 0, doc: null },
        write: null,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { status: 400, body: { error: "bad json" }, write: null };
    }
    const doc = (parsed as { doc?: unknown } | null)?.doc;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      return { status: 400, body: { error: "bad doc" }, write: null };
    }
    const next: DeckSyncRecord = { version: have + 1, doc };
    return { status: 200, body: { version: next.version }, write: next };
  }

  return { status: 405, body: { error: "method not allowed" }, write: null };
}
