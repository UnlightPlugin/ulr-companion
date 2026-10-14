/**
 * zip 版的自我更新（換檔）
 * ==========================
 * 玩家回報「exe 被 SmartScreen 擋掉、乾脆不裝了」之後，發布主力換成 zip。
 * zip 沒有安裝器，所以更新得自己做 —— 作法照 MAA
 * （`MaaAssistantArknights/src/MaaUpdater/main.cpp`）：
 *
 * ```
 *   主程式：驗簽章 → 驗雜湊 → 解壓到暫存 → 寫一支換檔腳本 → 帶著自己的 PID
 *           把它叫起來 → **等它回報「我起來了」** → 自己退出
 *   腳本：  回報 → 等那個 PID 死掉 → 把新檔案搬進安裝目錄 → 把程式叫回來 → 自刪
 * ```
 *
 * ## ⚠ 腳本沒回報就不准退出（2026-10-14）
 *
 * `spawn()` 沒有 throw 不代表腳本真的在跑：找不到 `powershell.exe` 是**事後**才
 * 從 `error` 事件出來，被防毒／端點防護擋掉的話更是什麼都不會說。那時候退出，
 * 玩家看到的是「插件自己消失了，而且再也沒回來」。所以腳本第一件事是寫一個
 * 記號檔，我們看到它才退出；看不到就留一行 log、照常跑。
 *
 * ## ⚠ Windows 擋的是「覆寫執行中的 exe」，不是「動那個目錄」
 *
 * 這是整件事成立的關鍵，也是「zip 沒辦法自我更新」這個誤解的來源：
 * 執行中的 exe **改名（`Move-Item`）是允許的**，只有「覆寫」會被拒絕。
 * 所以流程是「先把舊的改名 → 放新的進去 → 下次啟動再把改名的那些刪掉」，
 * MAA 的 `RenameLockedFile` / `CleanupPendingDeleteFiles` 就是這兩步。
 *
 * ## ⚠ 為什麼要等 PID，而不是「睡三秒」
 *
 * Electron 退出要跑完 `quit()` 那條路（拆補丁、關 CDP、寫設定檔），時間不固定。
 * 睡固定秒數的失敗方式很難查：檔案偶爾換不掉，而且只有在玩家機器慢的時候發生。
 *
 * ## ⚠ 這支只在**安裝目錄寫得進去**時才會動
 *
 * zip 版沒有安裝器，玩家自己決定解壓到哪 —— 有人會放 `C:\Program Files\`。
 * 那裡沒有 UAC 就寫不進去，而**靜默失敗是最糟的結果**（每小時重試一次、
 * 每次都失敗、玩家永遠停在舊版）。寫不進去就明白地說一句，叫他自己下載。
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";

/** 換檔腳本裡等主程式退出的上限（秒）。等不到就照樣換 —— 檔案鎖有自己的重試。 */
const WAIT_SECONDS = 60;

/**
 * 等換檔腳本回報「我起來了」的上限。PowerShell 冷啟動在慢的機器上要好幾秒，
 * 而等太久的代價只是晚一點退出。
 */
const READY_TIMEOUT_MS = 30_000;

/** 被鎖住的舊檔改成這個副檔名，下次啟動再刪。 */
export const STALE_SUFFIX = ".ulrold";

export interface ZipUpdateOptions {
  /** 已經驗過雜湊的 zip。 */
  zipPath: string;
  /** 這一版的版本號。只拿來取暫存資料夾的名字與寫 log。 */
  version: string;
  /** 現在跑的那支 exe（`process.execPath`）。 */
  exePath: string;
  /** 暫存區（`%APPDATA%\ulr-companion\port-*\updates`）。 */
  workDir: string;
  onLog?: (line: string) => void;
}

/**
 * 把 zip 換上去。**回 `true` 代表換檔腳本已經起來了（它自己回報的），呼叫端要
 * 立刻退出。**
 *
 * 回 `false` 代表這一版沒換成（原因已經寫進 log），程式繼續正常跑 ——
 * 更新失敗不該影響仲裁，那是玩家真正在用的東西。
 */
export async function applyZipUpdate(options: ZipUpdateOptions): Promise<boolean> {
  const log = (line: string): void => options.onLog?.(line);
  const installDir = dirname(options.exePath);

  if (!isWritable(installDir)) {
    log(`✗ 裝不上新版：${installDir} 寫不進去（裝在 Program Files 之類的地方？）`);
    log("  請自己到 GitHub 下載新的 zip 解壓覆蓋，或把插件搬到使用者目錄底下。");
    return false;
  }

  const stage = join(options.workDir, `stage-${options.version}`);
  try {
    removeTree(stage);
    mkdirSync(stage, { recursive: true });
    if (!extract(options.zipPath, stage)) {
      log("✗ 解壓縮失敗，這一版沒有裝上");
      return false;
    }
  } catch (err) {
    log(`✗ 解壓縮失敗：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // zip 裡可能是「檔案直接放根目錄」，也可能是「包了一層資料夾」。
  // ⚠ 認錯的話會把一個資料夾複製進安裝目錄，而程式本體一個檔案都沒換到 ——
  // 更新看起來成功了，版本卻永遠不變。
  const source = payloadRoot(stage);
  if (source === null) {
    log("✗ 解壓出來的東西裡找不到 exe，這一版沒有裝上");
    return false;
  }

  const script = join(options.workDir, `apply-${options.version}.ps1`);
  // 腳本的記錄放在暫存資料夾**外面** —— 放裡面的話下一次重試會連它一起刪掉，
  // 而那正是唯一能說明「上一次到底跑到哪」的東西。
  const scriptLog = join(options.workDir, `apply-${options.version}.log`);
  const ready = join(options.workDir, `apply-${options.version}.ready`);
  try {
    writeFileSync(script, swapScript(), "ascii");
    // 上一次留下來的記號不算數。
    rmSync(ready, { force: true });
  } catch (err) {
    log(`✗ 寫換檔腳本失敗：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  let child: ChildProcess;
  try {
    // ⚠ **一定要 detached + unref**：這支腳本要活得比我們久（它第一件事就是
    // 等我們死掉）。掛在我們底下的話，我們一退出它就跟著被收掉，而症狀是
    // 「更新之後版本沒變，也沒有任何錯誤」。
    //
    // ⚠ **要清掉 `ELECTRON_RUN_AS_NODE`**：腳本最後會把新版叫起來，帶著這個
    // 變數的話新版會被當成純 Node 跑，第一行就炸在 `app.setPath`
    // （同一個坑在 `updater.ts` 與 docs/launching.md 都記過）。
    const env = { ...process.env };
    delete env["ELECTRON_RUN_AS_NODE"];
    child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script,
        "-ParentPid",
        String(process.pid),
        "-Source",
        source,
        "-Target",
        installDir,
        "-Exe",
        options.exePath,
        "-Stage",
        stage,
        "-Log",
        scriptLog,
        "-Ready",
        ready,
      ],
      { detached: true, stdio: "ignore", env, windowsHide: true },
    );
    child.unref();
  } catch (err) {
    log(`✗ 啟動換檔腳本失敗：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const problem = await waitForReady(child, ready);
  if (problem !== null) {
    // 放棄了就把它收掉 —— 晚到的腳本會在我們還活著的時候搬檔案、再叫一份新的起來。
    try {
      child.kill();
    } catch {
      /* 本來就沒起來 */
    }
    log(`✗ 換檔腳本沒有起來（${problem}），這一版沒有裝上`);
    log("  有些防毒／端點防護會擋掉背景的 PowerShell。請自己到 GitHub 下載新的 zip 解壓覆蓋。");
    return false;
  }
  return true;
}

/**
 * 等換檔腳本寫出記號檔。回 `null` 是起來了，否則回一句說明。
 *
 * ⚠ `error` 的監聽**不能拿掉**：`spawn()` 失敗（找不到 `powershell.exe`、被拒絕）
 * 是從這個事件出來的，而沒有人聽的 `error` 會變成主程序的未捕捉例外。
 */
function waitForReady(child: ChildProcess, ready: string): Promise<string | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (problem: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(problem);
    };
    const poll = setInterval(() => {
      if (existsSync(ready)) finish(null);
      else if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        finish(`等了 ${READY_TIMEOUT_MS / 1000} 秒沒有回應`);
      }
    }, 250);
    child.on("error", (err) => finish(err.message));
    child.once("exit", (code) => {
      finish(existsSync(ready) ? null : `一起來就結束了，結束碼 ${String(code)}`);
    });
  });
}

/**
 * 整個資料夾刪掉。**刪暫存區一律走這支，不要直接 `rmSync`。**
 *
 * ⚠⚠ Electron 把 `node:fs` 換過：`*.asar` 在它眼裡是**資料夾**，而且讀過一次
 * 就把檔案開著不放。遞迴刪除於是鑽進 `app.asar` 裡、最後對它 `rmdir` ——
 * `EBUSY`。2026-10-12 的 2.3.0 就卡在這：第一次套用沒換成，留下的 `stage-*`
 * 之後每小時都刪不掉，而每次失敗都把 125 MB 重抓一遍。
 *
 * `process.noAsar` 是 Electron 給的開關，開著的時候 `.asar` 就只是一個檔案。
 * 純 Node（測試）底下這個屬性沒有作用，設了也無害。
 */
function removeTree(path: string): void {
  const before = process.noAsar;
  process.noAsar = true;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } finally {
    process.noAsar = before;
  }
}

/**
 * 清掉暫存區裡上一次留下來的東西（下載的 zip、解開的檔案、換檔腳本）。
 * **每次啟動叫一次。** 腳本的記錄（`*.log`）留著。
 *
 * 啟動時那裡沒有任何還用得到的東西 —— 「已經下載好的那一版」只記在記憶體裡，
 * 重開就會重抓。不清的話每更新一版就多佔三百多 MB，而且沒有人會去看那個資料夾。
 */
export function cleanupUpdateLeftovers(workDir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(workDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name.endsWith(".log")) continue;
    try {
      removeTree(join(workDir, entry.name));
      removed++;
    } catch {
      // 還鎖著（換檔腳本正在收尾？）—— 下次啟動再說。
    }
  }
  return removed;
}

/**
 * 清掉上一次換檔留下來的 `*.ulrold`。**每次啟動叫一次。**
 *
 * ⚠ 換檔當下那些檔案還被自己鎖著（我們就是從它們執行的），所以只能改名，
 * 刪要等下一次啟動 —— 那時鎖已經沒了。不清的話安裝目錄會一版一版地累積。
 */
export function cleanupStaleFiles(dir: string, depth = 0): number {
  if (depth > 4) return 0;
  let removed = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += cleanupStaleFiles(path, depth + 1);
      continue;
    }
    if (!entry.name.endsWith(STALE_SUFFIX)) continue;
    try {
      rmSync(path, { force: true });
      removed++;
    } catch {
      // 還鎖著（更新剛跑完？）—— 下次啟動再說。
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解壓縮。用 Windows 內建的 `tar.exe`（bsdtar，1803 以後都有，會處理 zip）。
 *
 * ⚠ 不用 PowerShell 的 `Expand-Archive`：它對 250 MB、上千個檔案的包**非常慢**
 * （實測是分鐘等級），而這件事發生在玩家背景，慢到讓人以為當掉了。
 * `tar.exe` 沒有的話才退回去用它。
 */
function extract(zipPath: string, into: string): boolean {
  const tar = spawnSync("tar.exe", ["-xf", zipPath, "-C", into], { stdio: "ignore" });
  if (tar.status === 0) return true;

  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "ignore" },
  );
  return ps.status === 0;
}

/** 解出來的東西真正的根目錄（zip 可能包了一層資料夾）。找不到 exe 就回 `null`。 */
function payloadRoot(stage: string): string | null {
  if (hasExe(stage)) return stage;
  let entries: Dirent[];
  try {
    entries = readdirSync(stage, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const inner = join(stage, entry.name);
    if (hasExe(inner)) return inner;
  }
  return null;
}

function hasExe(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith(".exe"));
  } catch {
    return false;
  }
}

/** 暫存區有多大（診斷用）。 */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 換檔腳本。**全部 ASCII** —— PowerShell 5.1 讀沒有 BOM 的 UTF-8 會當成
 * 系統 ANSI 碼頁，中文註解會變成亂碼，而亂碼的引號會讓整支腳本語法錯誤。
 */
function swapScript(): string {
  return `param(
  [int]$ParentPid,
  [string]$Source,
  [string]$Target,
  [string]$Exe,
  [string]$Stage,
  [string]$Log,
  [string]$Ready
)
$ErrorActionPreference = 'Stop'
function Say($m) { try { Add-Content -LiteralPath $Log -Value ("[" + (Get-Date -Format o) + "] " + $m) } catch {} }

# The app only quits once it sees this file. If we cannot write it, stop here.
Set-Content -LiteralPath $Ready -Value $PID

Say "waiting for pid $ParentPid"
for ($i = 0; $i -lt ${WAIT_SECONDS}; $i++) {
  $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($null -eq $p) { break }
  Start-Sleep -Seconds 1
}

Say "copying $Source -> $Target"
$failed = 0
Get-ChildItem -LiteralPath $Source -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($Source.Length).TrimStart('\\')
  $dest = Join-Path $Target $rel
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
  try {
    if (Test-Path -LiteralPath $dest) {
      # A running exe cannot be overwritten, but it CAN be renamed.
      try { Remove-Item -LiteralPath $dest -Force -ErrorAction Stop }
      catch { Move-Item -LiteralPath $dest -Destination ($dest + '${STALE_SUFFIX}') -Force }
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
  } catch {
    $failed++
    Say ("FAILED " + $rel + " : " + $_.Exception.Message)
  }
}
Say "done, failures=$failed"

Say "relaunching $Exe"
try { Start-Process -FilePath $Exe -WorkingDirectory $Target } catch { Say ("relaunch failed: " + $_.Exception.Message) }

# The log lives outside the stage folder, so the whole payload can go.
try { Remove-Item -LiteralPath $Stage -Recurse -Force } catch {}
try { Remove-Item -LiteralPath $Ready -Force } catch {}
`;
}
