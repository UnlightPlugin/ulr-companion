<#
.SYNOPSIS
  開著它去玩 —— 移動階段仲裁。

.DESCRIPTION
  ⚠ 這會改變遊戲行為：按下 OK 之後不會立刻送出，會壓到硬底線，
  期間再按一次可以取消，對手一動也會解除。

  遊戲**不必先開** —— 連不上會一直等，開了還在大廳也沒關係，
  對戰中途接手也行，打完重新開房會自己重掛。

  Ctrl+C 結束，會自動把攔截拆掉、把遊戲還原成原本行為。

  ⚠ 這個檔案必須存成 **UTF-8 with BOM**。PowerShell 5.1 讀沒有 BOM 的檔案
  會當成系統 ANSI 碼頁（這台機器是 CP950），中文註解會被解碼成亂碼，其中
  剛好湊出引號就會炸成 ParserError —— 症狀是「字串遺漏結尾字元」，指到的
  行數還跟真正的問題無關。跟 open-game.ps1 是同一個限制。

.EXAMPLE
  .\tools\arbiter.ps1
  接網頁版（:9334）。

.EXAMPLE
  .\tools\arbiter.ps1 -Port 9333
  改接桌面版。

.EXAMPLE
  .\tools\arbiter.ps1 -Policy opponent -Deadline 5
  只有對手的操作會取消準備；剩 5 秒就強制送出。
#>
[CmdletBinding()]
param(
  # 網頁版 9334（預設）、桌面版 9333。
  [int]$Port = 9334,
  # either=雙方操作都取消 / opponent=只有對手 / never=都不取消（等同原本的鎖定）
  [ValidateSet("either", "opponent", "never")]
  [string]$Policy = "either",
  # 剩幾秒就不等了，強制送出真的 OK。
  [int]$Deadline = 3,
  # 跑幾秒之後自動結束。不給就一直跑到 Ctrl+C。
  [int]$Seconds,
  # 出錯時不要停住等按鍵（從終端機跑、或掛在別的腳本裡時用）。
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$entry = "apps/companion/src/index.ts"

function Write-Fail {
  param([string]$Message, [string[]]$Hints)
  Write-Host ""
  Write-Host "✗ $Message" -ForegroundColor Red
  foreach ($h in $Hints) { Write-Host "  $h" -ForegroundColor Yellow }
  Write-Host ""
}

# 出錯時停住 —— 雙擊執行的話視窗會直接消失，錯誤訊息一個字都看不到。
function Stop-Here {
  param([int]$Code)
  if (-not $NoPause) {
    Write-Host "按 Enter 關閉…" -ForegroundColor DarkGray
    [void](Read-Host)
  }
  exit $Code
}

# ---------------------------------------------------------------------------
# 接哪一個客戶端
# ---------------------------------------------------------------------------

function Test-DebugPort {
  param([int]$P)
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 2 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

$which = if ($Port -eq 9333) { "桌面版" } elseif ($Port -eq 9334) { "網頁版" } else { "自訂" }

# 遊戲還沒開**不是錯誤** —— companion 本來就會等。
# 但如果要接的那個沒回應、另一個卻在跑，那多半是接錯了：講一句，不擋。
# （關掉的埠是 connection refused，不會真的等滿 timeout。）
if (-not (Test-DebugPort $Port)) {
  $other = if ($Port -eq 9334) { 9333 } else { 9334 }
  if (Test-DebugPort $other) {
    $otherName = if ($other -eq 9333) { "桌面版" } else { "網頁版" }
    Write-Host ":$Port（$which）沒有回應，但 :$other（$otherName）有在跑。" -ForegroundColor Yellow
    Write-Host "要接那個的話中斷之後改用 -Port $other。" -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------------------
# 跑
# ---------------------------------------------------------------------------

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Fail "找不到 npx" @("要先裝 Node.js：https://nodejs.org/")
  Stop-Here 1
}

$cmdArgs = @($entry, "arbiter", "--port", "$Port", "--policy", $Policy, "--deadline", "$Deadline")
if ($Seconds) { $cmdArgs += @("--seconds", "$Seconds") }

Write-Host ""
Write-Host "移動階段仲裁  $which :$Port  策略=$Policy  底線=${Deadline}s" -ForegroundColor Cyan
Write-Host "⚠ 這會改變遊戲行為。Ctrl+C 結束並還原。" -ForegroundColor DarkGray
Write-Host ""

try {
  # ⚠ 不要把輸出導去別的地方 —— 仲裁的每一步、每一個錯誤都是即時印出來的，
  # 吞掉的話「按了 OK 沒反應」就完全查不出原因。
  npx tsx @cmdArgs
  $code = $LASTEXITCODE
} catch {
  Write-Fail "啟動失敗：$($_.Exception.Message)" @(
    "完整錯誤：",
    ($_ | Out-String).Trim()
  )
  Stop-Here 1
}

if ($code -ne 0) {
  Write-Fail "仲裁結束，離開碼 $code" @(
    "常見原因：",
    "  · 連不上 debug port → 客戶端啟動時要帶 --remote-debugging-port=$Port",
    "    桌面版：Steam 啟動選項；網頁版：用 .\tools\open-game.ps1",
    "  · 那個埠落在 Windows 保留範圍 → netsh interface ipv4 show excludedportrange protocol=tcp",
    "    症狀很像「參數被忽略」：瀏覽器照常開，但完全不產生 DevToolsActivePort",
    "",
    "⚠ 就算這裡是不正常結束，遊戲也不會被卡住：頁面上的攔截 3 秒收不到心跳",
    "  就會自己停手，退回原本的行為。"
  )
  Stop-Here $code
}

Write-Host "結束。遊戲已還原成原本行為。" -ForegroundColor Green
exit 0
