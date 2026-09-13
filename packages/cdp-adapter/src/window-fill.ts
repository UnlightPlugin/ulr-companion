/**
 * 把桌面版遊戲視窗推成整個螢幕（Windows 專用）
 * ============================================
 *
 * 桌面版的 `BrowserWindow` 是 `resizable: false`。Electron 對這種視窗把
 * 「最大尺寸」釘在目前大小（`WM_GETMINMAXINFO`），所以：
 *
 * - 頁面 `requestFullscreen()` 只拿掉標題列、移到 (0,0)，**尺寸不變**
 * - 頁面 `resizeTo()` 進得去，但 Chromium 夾在工作區裡（扣掉工作列）
 *
 * 2026-09-13 實測：3440×1440 的螢幕上全螢幕只有 2294×934 DIP，底下露出工作列。
 *
 * 唯一繞得過的路是從外面 `SetWindowPos` 帶 **`SWP_NOSENDCHANGING`** ——
 * 不送 `WM_WINDOWPOSCHANGING`，DefWindowProc 就不會拿 min/max 去夾。實測
 * 視窗變成 0,0,3440,1440，工作列被蓋住。
 *
 * ⚠ **還要把樣式加上 `WS_POPUP`。** Chromium 的全螢幕視窗只拿掉
 * `WS_CAPTION|WS_THICKFRAME`，型態仍是 overlapped —— 之後任何一次帶尺寸的
 * `WM_WINDOWPOSCHANGING`（玩家**點一下畫面**就會有）DefWindowProc 又會拿
 * `WM_GETMINMAXINFO` 驗證一次，視窗立刻縮回原大小（2026-09-13 實測：點一下
 * 就從 3440×1440 縮回 1455×1349）。`WS_POPUP` 的視窗不做那個驗證；點了還是
 * 滿版。`exitFullscreen()` 時 Electron 用它**進去前記的**樣式與位置還原，
 * 我們加的 `WS_POPUP` 跟著消失，這邊不必做任何事。
 *
 * 順序一定是 **頁面先進 HTML 全螢幕、再推**：那時框已經拿掉、Chromium 也
 * 知道自己在全螢幕（Esc 會退出）。反過來先推再進，Electron 進全螢幕時會
 * 記下「推過的」尺寸當成還原目標。
 *
 * 走 PowerShell 的 `Add-Type` 呼叫 user32，不引入原生模組。啟動要幾百毫秒，
 * 全螢幕一次一下，可以接受。`SetProcessDPIAware()` 是必要的：不宣告的話
 * PowerShell 拿到的座標是虛擬化過的，推出去會差一個縮放倍率。
 */

import { spawn } from "node:child_process";

import { ENV_KEYS_TO_STRIP } from "./constants.js";

export interface WindowFillResult {
  ok: boolean;
  /** 推完之後的視窗矩形（螢幕像素）。 */
  rect: [number, number, number, number] | null;
  reason: string | null;
}

/** `__PID__` 在送出前換成真的 pid（`-EncodedCommand` 不好帶參數）。 */
const SCRIPT = String.raw`
$ProcessId = __PID__
Add-Type -Namespace U -Name W -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cb; public RECT rcMonitor; public RECT rcWork; public uint flags; }
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
public static IntPtr Find(uint pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows((h, l) => {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
    found = h; return false;
  }, IntPtr.Zero);
  return found;
}
"@
[U.W]::SetProcessDPIAware() | Out-Null
$h = [U.W]::Find([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"no-window"}'; exit 0 }
$mi = New-Object U.W+MONITORINFO
$mi.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
[U.W]::GetMonitorInfo([U.W]::MonitorFromWindow($h, 2), [ref]$mi) | Out-Null
$m = $mi.rcMonitor
# GWL_STYLE -16, WS_POPUP 0x80000000：之後帶尺寸的 WM_WINDOWPOSCHANGING 才不會再被 min/max 夾回去
$style = [U.W]::GetWindowLong($h, -16)
[U.W]::SetWindowLong($h, -16, [int]($style -bor 0x80000000)) | Out-Null
# SWP_NOZORDER 0x4 | SWP_NOACTIVATE 0x10 | SWP_FRAMECHANGED 0x20 | SWP_NOSENDCHANGING 0x400
$ok = [U.W]::SetWindowPos($h, [IntPtr]::Zero, $m.L, $m.T, $m.R - $m.L, $m.B - $m.T, 0x434)
$r = New-Object U.W+RECT
[U.W]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("{{""ok"":{0},""rect"":[{1},{2},{3},{4}]}}" -f $ok.ToString().ToLower(), $r.L, $r.T, $r.R, $r.B)
`;

/** 讀 PowerShell 印出來的那一行。壞掉的輸出當失敗，原文帶在 `reason`。 */
export function parseWindowFillOutput(stdout: string): WindowFillResult {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (line === undefined)
    return { ok: false, rect: null, reason: `沒有輸出：${stdout.slice(0, 120)}` };
  try {
    const o = JSON.parse(line) as { ok?: unknown; rect?: unknown; reason?: unknown };
    const rect =
      Array.isArray(o.rect) && o.rect.length === 4 && o.rect.every((n) => typeof n === "number")
        ? (o.rect as [number, number, number, number])
        : null;
    return {
      ok: o.ok === true,
      rect,
      reason: typeof o.reason === "string" ? o.reason : null,
    };
  } catch {
    return { ok: false, rect: null, reason: `讀不懂的輸出：${line.slice(0, 120)}` };
  }
}

/**
 * 把 `pid` 那個程序的主視窗推成它所在螢幕的大小。**頁面要先進 HTML 全螢幕。**
 * 只在 Windows 上做事；其他平台直接回 `ok: false`。
 */
export async function fillGameWindow(pid: number, timeoutMs = 8000): Promise<WindowFillResult> {
  if (process.platform !== "win32") return { ok: false, rect: null, reason: "只支援 Windows" };
  if (!Number.isInteger(pid) || pid <= 0)
    return { ok: false, rect: null, reason: `pid 不合法：${pid}` };

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ENV_KEYS_TO_STRIP) delete env[key];

  // -EncodedCommand：整支腳本 base64 帶過去，不必跟引號打架、也不落地成檔案。
  const encoded = Buffer.from(`${SCRIPT.replace("__PID__", String(pid))}\n`, "utf16le").toString(
    "base64",
  );
  return await new Promise<WindowFillResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, rect: null, reason: `PowerShell ${timeoutMs}ms 沒回應` });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, rect: null, reason: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const result = parseWindowFillOutput(stdout);
      if (!result.ok && result.reason === null)
        result.reason = stderr.trim().slice(0, 200) || "SetWindowPos 失敗";
      resolve(result);
    });
  });
}
