/**
 * 去識別化
 * ==========
 * §12 與 CONTRIBUTING 的硬規則：Steam Token、Cookie、完整 CDP URL、原始封包
 * 一律不准進 log、不准進遙測、不准進 repo。
 *
 * 這件事之所以要獨立成一個模組而不是「小心一點」，是因為遊戲的 URL 長這樣：
 *
 *     https://www.playunlight.online:14018/?steamid=765611998…&token=<36 碼>
 *
 * 也就是**只要印出遊戲分頁的 URL 就會洩漏 token**。診斷訊息、錯誤訊息、
 * 事件記錄全都碰得到它，所以預設就得是安全的：任何要離開這個 package 的
 * URL 都先過 `redactUrl`。
 */

/**
 * 查詢字串裡看到就要遮掉的鍵（小寫比對）。
 * 寧可多遮 —— 遮錯只是不好排查，漏遮是把帳號送出去。
 */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "ticket",
  "auth",
  "session",
  "sessionid",
  "key",
  "secret",
  "password",
  "steamid",
  "cdp_id",
]);

export const REDACTED = "***";

/**
 * 把 URL 縮成「還能認出是哪個服務，但不含任何憑證」的形式。
 *
 * - 敏感查詢參數換成 `***`，其餘保留（`lang=tcn` 這種對排查有用）
 * - 使用者名稱／密碼（`https://user:pw@host`）整段拿掉
 * - fragment 直接丟掉，OAuth 類流程常把 token 放在那裡
 * - 解析不了的字串一律回 `(已遮蔽)`，絕不原樣吐回去
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "(已遮蔽)";
  }

  url.username = "";
  url.password = "";
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED);
    }
  }

  // WebSocket debugger URL 的路徑本身就是憑證（誰拿到誰能接管瀏覽器）。
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return `${url.protocol}//${url.host}/${REDACTED}`;
  }

  return url.toString();
}

/**
 * 遊戲事件的參數幾乎一定含 session token（`args[0]` 常常就是那串 36 碼），
 * 所以預設**完全不留內容**，只留「有幾個、各是什麼型別」。
 *
 * 這樣還是足以回答「這個事件帶了幾個參數、第一個是不是物件」這類問題，
 * 而那正是排查協定時真正需要的資訊。要看真值請在活著的遊戲上用 devtools，
 * 不要讓它流進檔案。
 */
export function summarizeArgs(args: readonly unknown[]): string[] {
  return args.map((arg) => {
    if (arg === null) return "null";
    if (Array.isArray(arg)) return `array(${arg.length})`;
    const t = typeof arg;
    if (t === "object") return `object(${Object.keys(arg as object).length} keys)`;
    if (t === "string") return `string(${(arg as string).length})`;
    return t;
  });
}
