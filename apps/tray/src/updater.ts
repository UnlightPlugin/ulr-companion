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
 * ## 信任鏈（2026-08-09 上線）
 *
 *     驗簽章 → 只往新版走 → 網址白名單 → 大小上限 → 驗雜湊 → 安全時機套用
 *
 * 每一道擋的是不同的東西，少一道就有一條路徑沒被蓋到：
 *
 * | 關卡         | 擋什麼                                             |
 * | ------------ | -------------------------------------------------- |
 * | 簽章         | **發布伺服器被入侵**（雜湊擋不住，那也是它寫的）   |
 * | 只往新版走   | **重播舊清單**（舊簽章永遠有效，簽章擋不住）       |
 * | 網址白名單   | 發版手滑；私鑰外流時縮小爆炸半徑                   |
 * | 大小上限     | 無限長的串流把記憶體吃光                           |
 * | 雜湊         | 檔案在路上被換掉、只有檔案儲存空間被入侵           |
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { DEFAULT_UPDATE_FEED } from "@ulr/arbiter-link";
import { UPDATE_PUBLIC_KEY } from "./update-key.js";
import type { UpdateManifest } from "./update-verify.js";
import { isNewerVersion, verifySignedFeed } from "./update-verify.js";

/** 多久檢查一次。一小時 —— 這不是需要即時的東西。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 開起來之後先等一下再檢查，不要跟遊戲啟動搶頻寬。 */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

/**
 * 發布清單的網址。環境變數可以覆蓋，**但一定有預設值**。
 *
 * ⚠ 舊版沒有預設值，於是自動更新對**所有玩家**都是關掉的 —— 打包版沒有人會
 * 去設環境變數。那是最安靜的一種壞掉：你發出去的每一份都停在當初那一版，
 * 而且你不會收到任何「更新失敗」的回報，因為它根本沒開始過。
 *
 * 環境變數留著是為了開發：指到本機的假 feed 就能測整條流程，不必真的發版。
 */
const FEED_ENV = "ULR_UPDATE_FEED";

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
  const override = process.env[FEED_ENV];
  const feed = override !== undefined && override.length > 0 ? override : DEFAULT_UPDATE_FEED;

  // ⚠⚠ **沒有公鑰就整支不啟動。**
  //
  // 沒有信任根的時候，正確的行為是**不更新**，不是「先相信伺服器再說」——
  // 後者正是「Cloudflare 帳號被盜 = 每一台電腦被接管」那條路徑。
  if (UPDATE_PUBLIC_KEY.length === 0) {
    options.onLog?.("（沒有發布公鑰，自動更新未啟動）");
    return () => {};
  }

  // ⚠ **開發模式不要自動更新。** `process.execPath` 是 node_modules 裡的
  // electron.exe，真的裝下去會把開發環境換成打包版 —— 而且下一次 `npm run tray`
  // 又跑回舊的，症狀是「我明明改了程式碼，跑起來卻是別的行為」。
  if (!app.isPackaged) {
    options.onLog?.("（開發模式，自動更新未啟動）");
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
      // ⚠ `null` 有兩種可能：還沒發過版（404），或**簽章驗不過**。後者要看得見 ——
      // 它要嘛是發版流程出錯，要嘛是有人在冒充發布來源，兩種都不該安靜略過。
      if (manifest === null) return;
      // ⚠ **只往新的走。** 舊清單的簽章永遠有效，所以「版本不一樣就更新」
      // 等於對重播舊清單毫無抵抗力 —— 見 `isNewerVersion()`。
      if (!isNewerVersion(manifest.version, options.currentVersion)) return;

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

/**
 * 拿發布清單並**驗簽章**。驗不過回 `null`。
 *
 * ⚠ **驗章在讀任何欄位之前。** 先比版本再驗章的話，一份沒簽的清單仍然能
 * 控制流程要不要往下走。這裡的順序是：HTTP → 驗章 → 才開始相信 `version`。
 *
 * ⚠ 「來源是 HTTPS」不足以當作可信 —— HTTPS 保證的是「這確實是那台伺服器
 * 說的」，而我們要防的正是**那台伺服器被人接管**。
 */
async function fetchManifest(feed: string): Promise<UpdateManifest | null> {
  const res = await fetch(feed, { headers: { accept: "application/json" } });
  // 404 = 還沒發過任何一版。這是正常狀態，不是錯誤。
  if (!res.ok) return null;
  const raw: unknown = await res.json();
  return verifySignedFeed(raw, UPDATE_PUBLIC_KEY);
}

/**
 * 安裝檔可以從哪裡下載。**白名單，不是黑名單。**
 *
 * 清單已經簽過了，所以正常情況下這個網址本來就是我們寫的 —— 這一層擋的是
 * 另外兩件事：**發版時自己手滑貼錯網址**（當場就會失敗，而不是等玩家更新爆掉），
 * 以及**萬一私鑰外流**時把爆炸半徑縮小到「攻擊者還得同時控制 GitHub」。
 *
 * ⚠ 只比對**第一個**網址。GitHub 的 release 檔案會轉址到
 * `objects.githubusercontent.com`，那是 GitHub 自己的事 —— 能決定轉去哪的
 * 只有 github.com，所以跟著轉是安全的。
 */
const ALLOWED_DOWNLOAD_HOSTS = ["github.com", "ulr-link.lldavuull.workers.dev"];

/**
 * 安裝檔的大小上限。目前約 82 MB，300 MB 給了三倍餘裕。
 *
 * ⚠ `arrayBuffer()` 會把整個回應讀進記憶體。沒有上限的話，一個壞掉（或惡意）的
 * 來源可以送一個無限長的串流把記憶體吃光 —— 而那發生在**背景**，玩家只會看到
 * 插件突然消失。
 */
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;

function isAllowedDownload(url: string): boolean {
  try {
    const parsed = new URL(url);
    // ⚠ 一定要 https。http 的話「雜湊對得上」只證明檔案跟清單一致，
    // 不證明清單沒被路上的人連著檔案一起換掉。
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function download(manifest: UpdateManifest): Promise<string | null> {
  if (!isAllowedDownload(manifest.url)) {
    throw new Error(`安裝檔的網址不在白名單裡：${manifest.url}`);
  }
  const res = await fetch(manifest.url);
  if (!res.ok) return null;

  // 先看 Content-Length —— 能在開始讀之前就擋掉的話就不要讀。
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INSTALLER_BYTES) {
    throw new Error(`安裝檔太大（宣稱 ${Math.round(declared / 1024 / 1024)} MB）`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // 沒有 Content-Length、或它是假的時候，這一道才是真的那一道。
  if (bytes.length > MAX_INSTALLER_BYTES) {
    throw new Error(`安裝檔太大（實際 ${Math.round(bytes.length / 1024 / 1024)} MB）`);
  }

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
