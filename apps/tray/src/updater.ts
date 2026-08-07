/**
 * 自動靜默更新
 * ==============
 * 玩家要的是「不用管它，自己會更新」。這裡照做，但有一個**不能妥協的邊界**：
 *
 *     下載可以完全靜默；**套用不能發生在對戰進行中。**
 *
 * 理由不是保守，是這個插件的性質：它會**改變勝負**。
 * `docs/battle-features.md` 已經寫過同一件事 ——
 *
 * > 靜默把規則版本換掉，等於在玩家不知情時改變他對戰的行為，而且真出問題時
 * > 「昨天好好的今天壞了」而他完全不知道更新過，排查會非常痛苦。
 *
 * 折衷點在這裡：**版本換掉的那一刻要落在對戰之外**，而且要留一行 log。
 * 玩家不需要按任何按鈕（那是他要的「靜默」），但事後查得到。
 *
 * ⚠ 換版還有一個獨立的理由不能在對戰中做：協定版本一變，中間人會回
 * `incompatible`，雙方**當場退回單邊模式**（`@ulr/arbiter-link` 的版本註解）。
 * 在移動階段中間發生的話，玩家會看到約定秒數突然消失而不知道為什麼。
 *
 * ## 現在的狀態
 *
 * 更新流程本身是完整的（檢查 → 下載 → 驗雜湊 → 暫存 → 安全時機套用），
 * 但**沒有預設的發布來源** —— `ULR_UPDATE_FEED` 沒設就整支不啟動。
 * 這是刻意的：指向一個還不存在的網址只會每小時失敗一次並洗掉 log，
 * 而且一旦寫死了預設值，之後改網址就得再發一版才能改。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** 多久檢查一次。一小時 —— 這不是需要即時的東西。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 開起來之後先等一下再檢查，不要跟遊戲啟動搶頻寬。 */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

/** 發布清單的網址。沒設就不啟動自動更新。 */
const FEED_ENV = "ULR_UPDATE_FEED";

/** 發布清單的形狀。刻意做得很小 —— 欄位越多，壞掉的方式越多。 */
interface UpdateManifest {
  version: string;
  /** 安裝檔的網址。 */
  url: string;
  /** 安裝檔的 SHA-256（十六進位）。**沒有它就不裝。** */
  sha256: string;
  /** 給玩家看的一行說明，會寫進 log。 */
  notes?: string;
}

export interface UpdaterOptions {
  /**
   * 現在跑的是哪一版。
   *
   * ⚠ **不要在這裡叫 `app.getVersion()`。** 開發時它回的是 Electron 的版本，
   * 於是「有沒有新版」會拿 38.8.6 去跟 0.1.0 比 —— 永遠判定成有新版，
   * 然後每小時下載一次同一個檔案。版本號的唯一來源是建置時烤進去的那個。
   */
  currentVersion: string;
  /**
   * 現在動不得嗎。
   *
   * ⚠ 判準是**攔截真的掛在 socket 上**（`status.armed`），不是「有沒有連上
   * 遊戲」。連上但還在大廳是安全的套用時機，而那正是玩家最常停留的地方 ——
   * 用「有沒有連線」當判準的話，開著插件的人永遠等不到更新。
   */
  isBusy: () => boolean;
  onLog?: (line: string) => void;
}

/**
 * 啟動自動更新。回傳一個停掉它的函式。
 *
 * **永遠不會 throw。** 更新失敗只是「這次沒更新」，不該影響仲裁 ——
 * 那是玩家真正在用的東西。
 */
export function startAutoUpdate(options: UpdaterOptions): () => void {
  const feed = process.env[FEED_ENV];
  if (feed === undefined || feed.length === 0) {
    options.onLog?.(`（沒設 ${FEED_ENV}，自動更新未啟動）`);
    return () => {};
  }

  let stopped = false;
  /** 已經下載好、等一個安全時機的那一版。 */
  let staged: { version: string; path: string } | null = null;

  const log = (line: string): void => options.onLog?.(line);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // 已經備好一版了 → 這一輪只做「能不能套用」的判斷，不重複下載。
      if (staged !== null) {
        applyIfIdle(staged);
        return;
      }
      const manifest = await fetchManifest(feed);
      if (manifest === null || manifest.version === options.currentVersion) return;

      log(
        `↓ 有新版 ${manifest.version}${manifest.notes === undefined ? "" : `：${manifest.notes}`}`,
      );
      const path = await download(manifest);
      if (path === null) return;
      staged = { version: manifest.version, path };
      log(`✓ ${manifest.version} 已下載，等對戰結束再套用`);
      applyIfIdle(staged);
    } catch (err) {
      // 靜默更新的「靜默」不包括錯誤。查不到原因的失敗比失敗本身麻煩。
      log(`✗ 檢查更新失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 套用：**把安裝檔叫起來，然後自己退出。**
   *
   * ⚠ **一定要真的執行那個安裝檔。** 早期版本只做了 `app.relaunch()` 而沒有
   * spawn 它 —— 於是版本永遠不變，下一輪 tick 又下載一次、又重開一次，
   * 變成**每小時無限重啟**。而且因為版本沒變，log 上看起來像更新一直失敗，
   * 但錯誤訊息一行都沒有。
   *
   * ⚠ **一定要 `app.quit()`。** NSIS 換不掉正在執行的檔案。
   *
   * ⚠ **一定要清掉 `ELECTRON_RUN_AS_NODE`。** 安裝檔本身不是 Electron，
   * 但它裝完會把**新版的 app** 叫起來，而那個是。帶著這個變數的話新版會
   * 被當成純 Node 跑，第一行就炸在 `app.setPath` —— 玩家看到的是「更新完
   * 就再也打不開了」。（同一個坑第五次出現，見 docs/launching.md 陷阱 1。）
   */
  const applyIfIdle = (ready: { version: string; path: string }): void => {
    if (options.isBusy()) return;
    log(`⟳ 套用 ${ready.version}（靜默安裝，裝完會自己重新啟動）`);

    // 留一張紙條給新版：「你是更新後起來的，不要跳視窗」。
    markUpdating();

    const env = { ...process.env };
    delete env["ELECTRON_RUN_AS_NODE"];
    try {
      // `/S` = NSIS 的靜默安裝。oneClick 的安裝器裝完會自己啟動新版。
      const child = spawn(ready.path, ["/S"], { detached: true, stdio: "ignore", env });
      child.unref();
    } catch (err) {
      log(`✗ 啟動安裝檔失敗：${err instanceof Error ? err.message : String(err)}`);
      clearUpdating();
      return;
    }
    app.quit();
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
 * 「這一次啟動是更新後自動起來的」的紙條。
 *
 * ⚠ 為什麼是檔案而不是命令列旗標：**新版是 NSIS 叫起來的，不是我們**，
 * 我們沒辦法決定它帶什麼參數。檔案是唯一能跨越那個交接的訊號。
 */
const UPDATING_MARK = "updating.mark";

/** 紙條放在 userData 底下 —— 那是依埠分開的，多開時彼此不會互相誤判。 */
function markPath(): string {
  return join(app.getPath("userData"), UPDATING_MARK);
}

function markUpdating(): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(markPath(), String(Date.now()), "utf8");
  } catch {
    // 寫不進去頂多是更新後跳一次視窗，不值得讓更新本身失敗。
  }
}

function clearUpdating(): void {
  try {
    rmSync(markPath(), { force: true });
  } catch {
    /* 同上 */
  }
}

/**
 * 這次啟動是不是更新後自動起來的。**問過就把紙條撕掉**，只算一次。
 *
 * ⚠ 有時效（10 分鐘）。安裝到一半被取消的話紙條會留著，而沒有時效的話
 * 玩家之後每次手動開都不跳視窗 —— 症狀是「點了圖示沒反應」。
 */
export function consumeUpdatedFlag(): boolean {
  try {
    const path = markPath();
    if (!existsSync(path)) return false;
    const fresh = Date.now() - statSync(path).mtimeMs < 10 * 60 * 1000;
    rmSync(path, { force: true });
    return fresh;
  } catch {
    return false;
  }
}

async function fetchManifest(feed: string): Promise<UpdateManifest | null> {
  const res = await fetch(feed, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const raw: unknown = await res.json();
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m["version"] !== "string" || typeof m["url"] !== "string") return null;
  // ⚠ **沒有雜湊就整份丟掉。** 下載回來的是會被執行的東西，
  // 「來源是 HTTPS」不足以當作它沒被換過的理由。
  if (typeof m["sha256"] !== "string" || m["sha256"].length !== 64) return null;
  return {
    version: m["version"],
    url: m["url"],
    sha256: m["sha256"].toLowerCase(),
    ...(typeof m["notes"] === "string" ? { notes: m["notes"] } : {}),
  };
}

async function download(manifest: UpdateManifest): Promise<string | null> {
  const res = await fetch(manifest.url);
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== manifest.sha256) {
    throw new Error(
      `雜湊對不上（期望 ${manifest.sha256.slice(0, 12)}…，拿到 ${actual.slice(0, 12)}…）`,
    );
  }

  const dir = join(app.getPath("userData"), "updates");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `ulr-companion-${manifest.version}.exe`);
  writeFileSync(path, bytes);
  return path;
}
